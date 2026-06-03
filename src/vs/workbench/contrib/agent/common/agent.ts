/*---------------------------------------------------------------------------------------------
 *  Agent Core - The main ReAct loop that orchestrates LLM + Tools
 *
 *  Features:
 *  - Tool result truncation to prevent context overflow
 *  - API request timeout (separate from tool execution timeout)
 *  - Reasoning model compatibility (DeepSeek reasoner, OpenAI o-series)
 *  - Checkpoint before write/edit operations
 *  - Streaming mode with reasoning model awareness
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import {
	IAgentMessage,
	IAgentConfig,
	IAgentPlan,
	AgentMode,
	MessageRole,
	createMessage,
	createToolResultMessage,
	IToolResult,
	generateId,
} from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider } from 'vs/workbench/services/agent/browser/llmProvider';
import { ToolRegistry } from './agentTools';
import { AgentContext } from './agentContext';
import { AgentModeManager } from './agentModes';
import { AgentPlanner } from './agentPlanner';
import { AgentCheckpointManager } from './agentCheckpoint';
import { getSystemPrompt } from './agentPrompts';

// Maximum characters for a single tool result sent back to the LLM.
// Large outputs (e.g. read_file of a big file, run_terminal of a long build)
// can easily overflow the context window. We truncate and notify the LLM.
const MAX_TOOL_RESULT_CHARS = 8000;

// Maximum consecutive steps that produce only tool calls with no text content.
// If the agent calls tools repeatedly without any reasoning text for this many
// steps, it's likely stuck in a loop and we intervene.
const MAX_CONSECUTIVE_TOOL_ONLY_STEPS = 100;

export class AgentLoop {
	private _isRunning = false;
	private _cancellation: CancellationTokenSource | undefined;
	private _contextHistoryForContinue: IAgentMessage[] = [];

	private readonly _onDidReceiveMessage = new Emitter<IAgentMessage>();
	readonly onDidReceiveMessage: Event<IAgentMessage> = this._onDidReceiveMessage.event;

	private readonly _onDidStreamToken = new Emitter<string>();
	readonly onDidStreamToken: Event<string> = this._onDidStreamToken.event;

	private readonly _onDidComplete = new Emitter<void>();
	readonly onDidComplete: Event<void> = this._onDidComplete.event;

	private readonly _onDidError = new Emitter<Error>();
	readonly onDidError: Event<Error> = this._onDidError.event;

	private readonly _context: AgentContext;
	private readonly _planner: AgentPlanner;

	private _useStreaming = false;
	private _extraSystemPrompt = '';

	constructor(
		private _config: IAgentConfig,
		private _llmProvider: ILLMProvider,
		private readonly _toolRegistry: ToolRegistry,
		private readonly _modeManager: AgentModeManager,
		private readonly _checkpointManager: AgentCheckpointManager,
		private readonly _workingDirectory: string = process.cwd(),
	) {
		this._context = new AgentContext(_config.maxContextTokens, _llmProvider);
		this._planner = new AgentPlanner(_llmProvider);
	}

	swapProvider(config: IAgentConfig, provider: ILLMProvider): void {
		this._config = config;
		this._llmProvider = provider;
		this._context.swapTokenCounter(provider);
		this._planner.swapProvider(provider);
	}

	setStreaming(enabled: boolean): void {
		this._useStreaming = enabled;
	}

	setExtraSystemPrompt(prompt: string): void {
		this._extraSystemPrompt = prompt;
	}

	get isRunning(): boolean {
		return this._isRunning;
	}

	get context(): AgentContext {
		return this._context;
	}

	get planner(): AgentPlanner {
		return this._planner;
	}

	get workingDirectory(): string {
		return this._workingDirectory;
	}

	get systemPromptContent(): string {
		return this._context.systemPromptContent;
	}

	get extraSystemPrompt(): string {
		return this._extraSystemPrompt;
	}

	/**
	 * Export the current agent state for session persistence.
	 */
	exportSessionState(): {
		messages: IAgentMessage[];
		systemPrompt: string;
		extraSystemPrompt: string;
	} {
		return {
			messages: [...this._context.messages],
			systemPrompt: this._context.systemPromptContent,
			extraSystemPrompt: this._extraSystemPrompt,
		};
	}

	/**
	 * Restore agent state from a previously saved session.
	 * This fully resets the current context and replays the saved messages.
	 */
	restoreFromSession(messages: IAgentMessage[], systemPrompt: string, extraSystemPrompt?: string): void {
		this._context.clear();
		this._extraSystemPrompt = extraSystemPrompt || '';
		const fullSystemPrompt = systemPrompt || getSystemPrompt(this._modeManager.currentMode, this._workingDirectory);
		this._context.setSystemPrompt(fullSystemPrompt + this._extraSystemPrompt);

		for (const msg of messages) {
			this._context.addMessage(msg);
		}

		// Also populate the continue history
		this._contextHistoryForContinue = [...messages];
	}

	async run(userMessage: string): Promise<void> {
		if (this._isRunning) {
			throw new Error('Agent is already running');
		}

		this._isRunning = true;
		this._cancellation = new CancellationTokenSource();

		try {
			const mode = this._modeManager.currentMode;
			this._context.setSystemPrompt(getSystemPrompt(mode, this._workingDirectory) + this._extraSystemPrompt);

			const userMsg = createMessage(MessageRole.User, userMessage);
			this._context.addMessage(userMsg);
			this._onDidReceiveMessage.fire(userMsg);

			if (this._modeManager.shouldPlanFirst) {
				await this._runPlanMode(userMessage);
			} else {
				await this._runAgentLoop(this._cancellation.token);
			}

			this._onDidComplete.fire();
		} catch (err) {
			if (!(err instanceof Error && err.message === 'Cancelled')) {
				this._onDidError.fire(err instanceof Error ? err : new Error(String(err)));
			}
		} finally {
			this._isRunning = false;
			this._cancellation?.dispose();
			this._cancellation = undefined;
		}
	}

	cancel(): void {
		this._cancellation?.cancel();
	}

	/**
	 * Continue a previously paused agent session (e.g., after hitting step limit).
	 * Restores the saved conversation context and resumes the agent loop.
	 */
	async continueSession(): Promise<void> {
		if (this._isRunning) {
			throw new Error('Agent is already running');
		}

		if (this._contextHistoryForContinue.length === 0) {
			throw new Error('No previous session to continue');
		}

		this._isRunning = true;
		this._cancellation = new CancellationTokenSource();

		try {
			// Restore conversation context from the previous session
			this._context.clear();
			this._context.setSystemPrompt(
				getSystemPrompt(this._modeManager.currentMode, this._workingDirectory) + this._extraSystemPrompt
			);

			// Replay saved messages into the context
			for (const msg of this._contextHistoryForContinue) {
				this._context.addMessage(msg);
			}

			// Add a continuation hint for the LLM
			const continueMsg = createMessage(MessageRole.User,
				'Please continue from where you left off. The previous response was cut off due to limits. Continue your work.'
			);
			this._context.addMessage(continueMsg);
			this._onDidReceiveMessage.fire(continueMsg);

			// Resume the agent loop
			await this._runAgentLoop(this._cancellation.token);
			this._onDidComplete.fire();
		} catch (err) {
			if (!(err instanceof Error && err.message === 'Cancelled')) {
				this._onDidError.fire(err instanceof Error ? err : new Error(String(err)));
			}
		} finally {
			this._isRunning = false;
			this._cancellation?.dispose();
			this._cancellation = undefined;
		}
	}

	async executePlan(plan?: IAgentPlan): Promise<void> {
		if (this._isRunning) {
			throw new Error('Agent is already running');
		}
		this._isRunning = true;
		this._cancellation = new CancellationTokenSource();

		try {
			const existingPlan = plan || this._planner.currentPlan;
			if (!existingPlan) {
				throw new Error('No plan to execute. Run Plan mode first.');
			}

			this._modeManager.switchMode(AgentMode.Agent);
			this._context.setSystemPrompt(getSystemPrompt(AgentMode.Agent, this._workingDirectory) + this._extraSystemPrompt);

			const planSteps = existingPlan.steps
				.map((s, i) => `${i + 1}. ${s.description}`)
				.join('\n');

			const userMsg = createMessage(MessageRole.User,
				`Execute this plan step by step:\n${planSteps}`
			);
			this._context.addMessage(userMsg);
			this._onDidReceiveMessage.fire(userMsg);

			await this._runAgentLoop(this._cancellation.token);
			this._onDidComplete.fire();
		} catch (err) {
			if (!(err instanceof Error && err.message === 'Cancelled')) {
				this._onDidError.fire(err instanceof Error ? err : new Error(String(err)));
			}
		} finally {
			this._isRunning = false;
			this._cancellation?.dispose();
			this._cancellation = undefined;
		}
	}

	private async _runPlanMode(task: string): Promise<void> {
		const plan = await this._planner.createPlan(task);

		const planSummary = plan.steps
			.map((s, i) => `${i + 1}. ${s.description}`)
			.join('\n');

		const planMsg = createMessage(
			MessageRole.Assistant,
			`## Implementation Plan\n\n${planSummary}\n\nSwitch to Agent mode and say "execute plan" to run this plan.`,
		);

		this._context.addMessage(planMsg);
		this._onDidReceiveMessage.fire(planMsg);
	}

	private async _runAgentLoop(token: CancellationToken): Promise<void> {
		let stepCount = 0;
		let consecutiveToolOnlySteps = 0;

		while (stepCount < this._config.maxSteps) {
			if (token.isCancellationRequested) {
				throw new Error('Cancelled');
			}

			// Guard: if agent calls tools repeatedly without producing any text content
			// for too many consecutive steps, it's likely stuck in a loop.
			if (consecutiveToolOnlySteps >= MAX_CONSECUTIVE_TOOL_ONLY_STEPS) {
				const warnMsg = createMessage(
					MessageRole.Assistant,
					`I've been calling tools without producing any analysis for ${consecutiveToolOnlySteps} consecutive steps. I may be stuck in a loop. Let me stop and summarize what I know so far. Please refine your request or check if I'm repeating myself.`,
				);
				this._context.addMessage(warnMsg);
				this._onDidReceiveMessage.fire(warnMsg);
				break;
			}

			await this._context.compactIfNeeded();

			const messages = this._context.getContextWindow();
			const tools = this._modeManager.isReadOnly
				? this._toolRegistry.getReadOnlySchemas()
				: this._toolRegistry.listSchemas();

			// Check if the current context uses reasoning_content (thinking mode).
			// Reasoning models require special handling:
			//   - Streaming is incompatible because it doesn't capture reasoning_content
			//   - Message filtering is needed to maintain API compatibility
			const hasThinking = messages.some(m => m.role === MessageRole.Assistant && m.reasoningContent);
			const providerSupportsStreaming = this._llmProvider.supportsStreaming?.() ?? true;
			const isReasoningModel = this._llmProvider.supportsReasoning?.() ?? false;

			let response: IAgentMessage;

			// Streaming is only safe when:
			//   1. Streaming is explicitly enabled by user
			//   2. No tools are available (streaming with tools doesn't work well)
			//   3. No reasoning_content in context (would be lost in streaming)
			//   4. Provider claims to support streaming
			const canStream = this._useStreaming
				&& (!tools || tools.length === 0)
				&& !hasThinking
				&& providerSupportsStreaming
				&& !isReasoningModel;

			if (canStream) {
				const chunks: string[] = [];
				const stream = this._llmProvider.stream(
					messages,
					undefined,
					this._config.temperature,
				);
				for await (const token of stream) {
					chunks.push(token);
					this._onDidStreamToken.fire(token);
				}
				response = createMessage(MessageRole.Assistant, chunks.join(''));
			} else {
				// Use non-streaming complete() which preserves reasoning_content
				response = await this._llmProvider.complete(
					messages,
					tools.length > 0 ? tools : undefined,
					this._config.temperature,
				);
			}

			this._context.addMessage(response);
			this._onDidReceiveMessage.fire(response);

			if (!response.toolCalls || response.toolCalls.length === 0) {
				// No tool calls = final answer. Save history and reset counters.
				this._contextHistoryForContinue = [...this._context.messages];
				consecutiveToolOnlySteps = 0;
				break;
			}

			// Track whether this step produced any text content (analysis/reasoning)
			if (!response.content || response.content.trim().length === 0) {
				consecutiveToolOnlySteps++;
			} else {
				consecutiveToolOnlySteps = 0;
			}

			for (const toolCall of response.toolCalls) {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}

				const result = await this._executeTool(toolCall.id, toolCall.name, toolCall.arguments);

				// Truncate large tool results to prevent context overflow
				const truncatedResult = this._truncateToolResult(result);

				const resultMsg = createToolResultMessage(truncatedResult);
				this._context.addMessage(resultMsg);
				this._onDidReceiveMessage.fire(resultMsg);
			}

			stepCount++;
		}

		if (stepCount >= this._config.maxSteps) {
			// Save context so "continue" can resume without breaking reasoning_content requirements
			this._contextHistoryForContinue = [...this._context.messages];

			const limitMsg = createMessage(
				MessageRole.Assistant,
				`Reached the step limit (${this._config.maxSteps}). Type "continue" to proceed.`,
			);
			// Only fire event for display; do NOT add to context history
			// to avoid breaking reasoning_content requirements on re-entry
			this._onDidReceiveMessage.fire(limitMsg);
		}
	}

	/**
	 * Truncate tool results that exceed MAX_TOOL_RESULT_CHARS.
	 * Large outputs (build logs, file reads, search results) can overflow
	 * the LLM context window, especially for reasoning models.
	 */
	private _truncateToolResult(result: IToolResult): IToolResult {
		if (result.output && result.output.length > MAX_TOOL_RESULT_CHARS) {
			return {
				...result,
				output: result.output.substring(0, MAX_TOOL_RESULT_CHARS)
					+ `\n... (truncated, ${result.output.length} chars total)`,
			};
		}
		return result;
	}

	private async _executeTool(
		toolCallId: string,
		toolName: string,
		args: Record<string, unknown>,
	): Promise<IToolResult> {
		const tool = this._toolRegistry.get(toolName);

		if (!tool) {
			return {
				toolCallId,
				success: false,
				output: '',
				error: `Unknown tool: ${toolName}`,
			};
		}

		const writingTools = ['write_file', 'edit_file'];
		if (writingTools.includes(toolName) && args.path) {
			const checkpointId = this._checkpointManager.createCheckpoint(
				`Before ${toolName} on ${args.path}`,
			);
			await this._checkpointManager.snapshotFile(checkpointId, args.path as string);
		}

		try {
			// If tool specifies its own timeout, respect it; otherwise use stepTimeout
			const effectiveTimeout = (args.timeout as number) || this._config.stepTimeout;
			const result = await Promise.race([
				tool.execute({ ...args, _toolCallId: toolCallId }),
				this._timeout(effectiveTimeout, toolCallId),
			]);
			return result;
		} catch (err) {
			return {
				toolCallId,
				success: false,
				output: '',
				error: `Tool execution error: ${(err as Error).message}`,
			};
		}
	}

	private _timeout(ms: number, toolCallId: string): Promise<IToolResult> {
		return new Promise((_, reject) => {
			setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms`)), ms);
		});
	}

	dispose(): void {
		this.cancel();
		this._onDidReceiveMessage.dispose();
		this._onDidStreamToken.dispose();
		this._onDidComplete.dispose();
		this._onDidError.dispose();
		this._planner.dispose();
		this._modeManager.dispose();
	}
}