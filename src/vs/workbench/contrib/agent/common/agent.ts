/*---------------------------------------------------------------------------------------------
 *  Agent Core - The main ReAct loop that orchestrates LLM + Tools
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import {
	IAgentMessage,
	IAgentConfig,
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

export class AgentLoop {
	private _isRunning = false;
	private _cancellation: CancellationTokenSource | undefined;

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

	async run(userMessage: string): Promise<void> {
		if (this._isRunning) {
			throw new Error('Agent is already running');
		}

		this._isRunning = true;
		this._cancellation = new CancellationTokenSource();

		try {
			const mode = this._modeManager.currentMode;
			this._context.setSystemPrompt(getSystemPrompt(mode) + this._extraSystemPrompt);

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

	async executePlan(plan?: any): Promise<void> {
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
			this._context.setSystemPrompt(getSystemPrompt(AgentMode.Agent) + this._extraSystemPrompt);

			const userMsg = createMessage(MessageRole.User,
				`Execute this plan step by step:\n${existingPlan.steps.map((s: any, i: number) => `${i + 1}. ${s.description}`).join('\n')}`
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

		while (stepCount < this._config.maxSteps) {
			if (token.isCancellationRequested) {
				throw new Error('Cancelled');
			}

			await this._context.compactIfNeeded();

			const messages = this._context.getContextWindow();
			const tools = this._modeManager.isReadOnly
				? this._toolRegistry.getReadOnlySchemas()
				: this._toolRegistry.listSchemas();

			let response: IAgentMessage;

			if (this._useStreaming && (!tools || tools.length === 0)) {
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
				response = await this._llmProvider.complete(
					messages,
					tools.length > 0 ? tools : undefined,
					this._config.temperature,
				);
			}

			this._context.addMessage(response);
			this._onDidReceiveMessage.fire(response);

			if (!response.toolCalls || response.toolCalls.length === 0) {
				break;
			}

			for (const toolCall of response.toolCalls) {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}

				const result = await this._executeTool(toolCall.id, toolCall.name, toolCall.arguments);
				const resultMsg = createToolResultMessage(result);
				this._context.addMessage(resultMsg);
				this._onDidReceiveMessage.fire(resultMsg);
			}

			stepCount++;
		}

		if (stepCount >= this._config.maxSteps) {
			const limitMsg = createMessage(
				MessageRole.Assistant,
				`Reached the step limit (${this._config.maxSteps}). Type "continue" to proceed.`,
			);
			// Only fire event for display; do NOT add to context history
			// to avoid breaking reasoning_content requirements on re-entry
			this._onDidReceiveMessage.fire(limitMsg);
		}
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
