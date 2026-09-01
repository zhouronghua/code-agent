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
	IToolCall,
	IStepRecord,
	IToolExecutionRecord,
	IAgentTaskLog,
	generateId,
} from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider, ContextOverflowError } from 'vs/workbench/services/agent/browser/llmProvider';
import { ToolRegistry } from './agentTools';
import { AgentContext } from './agentContext';
import { AgentModeManager } from './agentModes';
import { AgentPlanner } from './agentPlanner';
import { AgentCheckpointManager } from './agentCheckpoint';
import { getSystemPrompt } from './agentPrompts';
import { IMemoryIntegration } from './agentMemory';

// Maximum characters for a single tool result sent back to the LLM.
// Large outputs (e.g. read_file of a big file, run_terminal of a long build)
// can easily overflow the context window. We truncate and notify the LLM.
const MAX_TOOL_RESULT_CHARS = 8000;

// Maximum consecutive steps that produce only tool calls with no text content.
// If the agent calls tools repeatedly without any reasoning text for this many
// steps, it's likely stuck in a loop and we intervene.
const MAX_CONSECUTIVE_TOOL_ONLY_STEPS = 100;

// Maximum self-verification rounds before accepting the agent's conclusion.
// When the agent produces a response with no tool calls, we inject a verification
// prompt to ensure it has fully verified its work. After this many rounds, we
// accept the conclusion to prevent infinite verify-loops.
const MAX_VERIFICATION_ROUNDS = 2;

// Keywords that indicate a complex task — triggers deep thinking mode with
// extra system prompt instructions.
// NOTE: use 'debugging' (not 'debug') so config keys like `debug: false` are not
// mistaken for a debugging task.
const COMPLEX_TASK_KEYWORDS = [
	'refactor', '重构', 'migrate', '迁移', 'implement', '实现',
	'redesign', '重新设计', 'complex', '复杂', 'multiple files',
	'architecture', '架构', 'performance', '性能', 'debugging', '调试',
	'optimize', '优化', 'redesign', 'overhaul', 'rewrite', '重写',
];

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

	/** Shared-memory (tdai_agent_mem) recall block, rebuilt on every run(). */
	private _memoryContext = '';
	private readonly _memory: IMemoryIntegration | undefined;

	/** Pending /btw hints injected during agent execution — consumed each loop iteration. */
	private _pendingBtwHints: string[] = [];

	/** AbortController for the currently executing tool, if any. Allows /btw cancel. */
	private _currentToolController: AbortController | undefined;

	// ---- Per-task execution tracing ----
	private _stepRecords: IStepRecord[] = [];
	private _taskStartTime = 0;
	private _taskDescription = '';
	private _taskError: string | undefined;

	constructor(
		private _config: IAgentConfig,
		private _llmProvider: ILLMProvider,
		private readonly _toolRegistry: ToolRegistry,
		private readonly _modeManager: AgentModeManager,
		private readonly _checkpointManager: AgentCheckpointManager,
		private readonly _workingDirectory: string = process.cwd(),
		memory?: IMemoryIntegration,
	) {
		this._context = new AgentContext(_config.maxContextTokens, _config.maxOutputTokens, _llmProvider);
		this._planner = new AgentPlanner(_llmProvider);
		this._memory = memory?.enabled ? memory : undefined;
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

	/**
	 * Append an additional instruction/hint to the extra system prompt.
	 * Used by in-flight /btw hints so they persist into subsequent run() calls.
	 * Multiple hints accumulate; each hint is separated clearly.
	 */
	appendExtraSystemPrompt(hint: string): void {
		const separator = '\n\n---\n## User Intervention (via /btw)\n';
		if (this._extraSystemPrompt) {
			this._extraSystemPrompt += separator + hint.trim();
		} else {
			this._extraSystemPrompt = '\n## User Intervention (via /btw)\n' + hint.trim();
		}
	}

	/**
	 * Inject a /btw hint while the agent is actively running.
	 * The hint is queued and will be delivered as a User message at the
	 * start of the next ReAct loop iteration, allowing mid-reasoning intervention.
	 *
	 * Special commands:
	 *   "/btw cancel" or "/btw abort" — cancels the currently running tool immediately.
	 */
	injectBtwHint(hint: string): void {
		const trimmed = hint.trim();
		// Check for cancel/abort command
		if (trimmed === 'cancel' || trimmed === 'abort') {
			if (this._currentToolController) {
				this._currentToolController.abort();
				console.log('[BTW] Cancelling current tool execution...');
				return;
			}
			// No tool running — treat as a regular hint to cancel the overall task
			this._pendingBtwHints.push('[User requested cancellation of the current operation.]');
			return;
		}
		this._pendingBtwHints.push(trimmed);
		// Also append to extraSystemPrompt so the hint persists across runs
		this.appendExtraSystemPrompt(hint);
	}

	/**
	 * Cancel the currently executing tool (if any).
	 * Returns true if a tool was cancelled, false if no tool was running.
	 */
	cancelCurrentTool(): boolean {
		if (this._currentToolController) {
			this._currentToolController.abort();
			this._currentToolController = undefined;
			return true;
		}
		return false;
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

	/**
	 * Export a complete task execution log for troubleshooting.
	 * Includes per-step LLM interactions, tool calls, timing, and errors.
	 */
	exportTaskLog(status: 'completed' | 'failed' | 'cancelled', error?: string): IAgentTaskLog {
		const finishedAt = Date.now();
		const totalToolCalls = this._stepRecords.reduce(
			(sum, step) => sum + step.toolExecutions.length, 0
		);

		// Aggregate actual token usage across all steps (only steps whose LLM
		// call reported usage are counted).
		const usedSteps = this._stepRecords.filter(s => s.llmUsage);
		const tokenUsage = usedSteps.length > 0
			? {
				promptTokens: usedSteps.reduce((sum, s) => sum + (s.llmUsage!.promptTokens || 0), 0),
				completionTokens: usedSteps.reduce((sum, s) => sum + (s.llmUsage!.completionTokens || 0), 0),
				totalTokens: usedSteps.reduce((sum, s) => sum + (s.llmUsage!.totalTokens || 0), 0),
				cachedTokens: usedSteps.reduce((sum, s) => sum + (s.llmUsage!.cachedTokens || 0), 0),
				cacheCreationTokens: usedSteps.reduce((sum, s) => sum + (s.llmUsage!.cacheCreationTokens || 0), 0),
			}
			: undefined;

		return {
			id: `task_${this._taskStartTime}_${Math.random().toString(36).substring(2, 8)}`,
			task: this._taskDescription,
			mode: this._modeManager.currentMode,
			workingDirectory: this._workingDirectory,
			config: {
				provider: this._config.provider,
				model: this._config.model,
			},
			systemPrompt: this._context.systemPromptContent,
			extraSystemPrompt: this._extraSystemPrompt || undefined,
			steps: [...this._stepRecords],
			totalSteps: this._stepRecords.length,
			totalToolCalls,
			tokenUsage,
			status,
			error,
			startedAt: this._taskStartTime,
			finishedAt,
			durationMs: finishedAt - this._taskStartTime,
		};
	}

	/** The error from the last task execution, if any. */
	get lastTaskError(): string | undefined {
		return this._taskError;
	}

	async run(userMessage: string): Promise<void> {
		if (this._isRunning) {
			throw new Error('Agent is already running');
		}

		this._isRunning = true;
		this._cancellation = new CancellationTokenSource();

		// Initialize per-task execution tracing
		this._stepRecords = [];
		this._taskStartTime = Date.now();
		this._taskDescription = userMessage;
		this._taskError = undefined;

		try {
			// Recall shared memory (tdai_agent_mem) for this task, if enabled.
			// Fail-open: memory unavailability must never block the agent.
			this._memoryContext = '';
			if (this._memory && this._memory.recall) {
				try {
					const recalled = await this._memory.recall(userMessage);
					if (recalled) {
						this._memoryContext = `\n\n<shared-memory>\n${recalled}\n</shared-memory>`;
					}
				} catch (err) {
					console.warn(`[memory] recall failed (non-fatal): ${(err as Error).message}`);
				}
			}

			const mode = this._modeManager.currentMode;
			this._context.setSystemPrompt(
				getSystemPrompt(mode, this._workingDirectory) + this._extraSystemPrompt + this._memoryContext
			);

			const userMsg = createMessage(MessageRole.User, userMessage);
			this._context.addMessage(userMsg);
			this._onDidReceiveMessage.fire(userMsg);

			// Complexity detection: complex tasks get deep-thinking instructions
			// AND self-verification rounds; simple tasks skip both to avoid
			// burning extra LLM round-trips on trivial work (mirrors the
			// latency-sensitive reasoning-effort approach in deepseek-harness).
			const isComplex = mode === 'agent' && this._isComplexTask(userMessage);
			if (isComplex) {
				const deepThinkMsg = createMessage(MessageRole.User,
					`[System note: Complex task detected — Deep Thinking Mode activated]\n` +
					`This appears to be a non-trivial task. Before making any changes:\n` +
					`1. Explore the relevant code thoroughly (3+ read_file/search_text calls)\n` +
					`2. Build a detailed mental model of the affected components\n` +
					`3. Consider edge cases, side effects, and interactions between files\n` +
					`4. Plan your changes step-by-step, verifying each independently\n` +
					`5. Do NOT conclude until you have run all relevant tests successfully`
				);
				this._context.addMessage(deepThinkMsg);
				// Don't fire — internal instruction, not user-visible
			}

			if (this._modeManager.shouldPlanFirst) {
				await this._runPlanMode(userMessage);
				// Auto-execute the generated plan without requiring manual mode switch
				await this._executePlanCore(this._cancellation.token);
			} else {
				await this._runAgentLoop(this._cancellation.token, !isComplex);
			}

			// Capture the finished exchange into shared memory (L0), if enabled.
			// The memory hub distills L0 → L1 → L2 → L3 automatically.
			if (this._memory && this._memory.capture && !this._taskError) {
				const lastAssistant = [...this._context.messages]
					.reverse()
					.find(m => m.role === MessageRole.Assistant && m.content && m.content.trim());
				await this._memory.capture(userMessage, lastAssistant?.content || '');
			}

			this._onDidComplete.fire();
		} catch (err) {
			if (!(err instanceof Error && err.message === 'Cancelled')) {
				this._taskError = (err as Error).message;
				this._onDidError.fire(err instanceof Error ? err : new Error(String(err)));
			} else {
				this._taskError = 'Cancelled';
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

		// Initialize per-task execution tracing
		this._stepRecords = [];
		this._taskStartTime = Date.now();
		this._taskDescription = '(continue previous session)';
		this._taskError = undefined;

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

		// Initialize per-task execution tracing
		this._stepRecords = [];
		this._taskStartTime = Date.now();
		this._taskDescription = plan?.task || '(execute plan)';
		this._taskError = undefined;

		try {
			await this._executePlanCore(this._cancellation.token, plan);
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

	/**
	 * Core plan execution logic. Assumes _isRunning and _cancellation are already set up.
	 * Used both by the public executePlan() method and by run() in Plan mode (auto-execution).
	 */
	private async _executePlanCore(token: CancellationToken, plan?: IAgentPlan): Promise<void> {
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

		await this._runAgentLoop(token);
	}

	private async _runPlanMode(task: string): Promise<void> {
		const plan = await this._planner.createPlan(task);

		const planSummary = plan.steps
			.map((s, i) => `${i + 1}. ${s.description}`)
			.join('\n');

		const planMsg = createMessage(
			MessageRole.Assistant,
			`## Implementation Plan\n\n${planSummary}\n\nExecuting plan automatically...`,
		);

		this._context.addMessage(planMsg);
		this._onDidReceiveMessage.fire(planMsg);
	}

	private async _runAgentLoop(token: CancellationToken, skipSelfVerification = false): Promise<void> {
		let stepCount = 0;
		let consecutiveToolOnlySteps = 0;
		let verificationRounds = 0;
		// Whether any tool has actually been executed this run. Used to keep the
		// self-verification safety net for simple tasks that would otherwise
		// declare "done" without doing any work at all.
		let hasExecutedTool = false;

		while (stepCount < this._config.maxSteps) {
			if (token.isCancellationRequested) {
				throw new Error('Cancelled');
			}

			// ---- Inject any /btw hints received during agent execution ----
			while (this._pendingBtwHints.length > 0) {
				const hint = this._pendingBtwHints.shift()!;
				const btwMsg = createMessage(MessageRole.User,
					`[User intervention via /btw]: ${hint}\n` +
					`(This is a hint from the user to adjust your reasoning. Follow it in subsequent steps.)`
				);
				this._context.addMessage(btwMsg);
				this._onDidReceiveMessage.fire(btwMsg);
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

			let messages = this._context.getContextWindow();

			// Check if the current context uses reasoning_content (thinking mode).
			// Reasoning models require special handling:
			//   - Streaming is incompatible because it doesn't capture reasoning_content
			//   - Message filtering is needed to maintain API compatibility
			const hasThinking = messages.some(m => m.role === MessageRole.Assistant && m.reasoningContent);
			const providerSupportsStreaming = this._llmProvider.supportsStreaming?.() ?? true;
			const isReasoningModel = this._llmProvider.supportsReasoning?.() ?? false;

			let response: IAgentMessage;

			// ---- Step tracing: record LLM request metadata ----
			const stepStartTime = Date.now();

			// ---- LLM call with context-overflow recovery ----
			// If the request cannot fit in the model's window (either the provider
			// detects it proactively, or the API rejects it with "maximum context
			// length"), force-compact the conversation history and retry with a
			// smaller window. Each compaction roughly halves the history, so a
			// handful of retries is enough even for very large resumed sessions.
			let llmRequestMeta = { messageCount: 0, estimatedTokens: 0 };
			let overflowRetries = 0;
			const MAX_OVERFLOW_RETRIES = 3;
			for (;;) {
				messages = this._context.getContextWindow();
				const tools = this._modeManager.isReadOnly
					? this._toolRegistry.getReadOnlySchemas()
					: this._toolRegistry.listSchemas();

				llmRequestMeta = {
					messageCount: messages.length,
					estimatedTokens: messages.reduce((sum, m) =>
						sum + this._llmProvider.countTokens(m.content)
						+ (m.reasoningContent ? this._llmProvider.countTokens(m.reasoningContent) : 0), 0),
				};

				try {
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
					break;
				} catch (err) {
					if (err instanceof ContextOverflowError && overflowRetries < MAX_OVERFLOW_RETRIES) {
						overflowRetries++;
						console.warn(`[Context Overflow] Conversation history too large — compacting and retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES}): ${(err as Error).message}`);
						await this._context.compactIfNeeded(true);
						continue;
					}
					throw err;
				}
			}

			this._context.addMessage(response);
			this._onDidReceiveMessage.fire(response);

			// ---- Step tracing: initialize step record ----
			const stepRecord: IStepRecord = {
				stepIndex: stepCount,
				llmRequest: llmRequestMeta,
				llmResponse: {
					content: response.content,
					toolCalls: response.toolCalls ? response.toolCalls.map(tc => ({ ...tc })) : undefined,
					reasoningContent: response.reasoningContent,
				},
				llmUsage: response.usage,
				toolExecutions: [],
				durationMs: Date.now() - stepStartTime,
				timestamp: stepStartTime,
			};

			if (!response.toolCalls || response.toolCalls.length === 0) {
				// No tool calls — agent thinks it's done.
				// Inject a verification round to make sure it has actually verified.
				// Simple tasks skip this once they have already performed work: the
				// extra LLM round-trips add latency but rarely change the outcome
				// for trivial file operations (mirrors deepseek-harness's
				// latency-sensitive reasoning-effort approach).
				const shouldVerify = !(skipSelfVerification && hasExecutedTool);
				if (shouldVerify && verificationRounds < MAX_VERIFICATION_ROUNDS) {
					verificationRounds++;
					const verifyMsg = createMessage(MessageRole.User,
						`[System verification round ${verificationRounds}/${MAX_VERIFICATION_ROUNDS}]\n` +
						`Before concluding, please verify: (1) Have you run tests or build to confirm correctness? ` +
						`(2) Are there any errors or warnings? (3) Is every subtask fully completed? ` +
						`(4) If you triggered any async task (CI, pipeline, deploy, container), have you used the poll tool to verify it completed? ` +
						`If anything is incomplete, still running, or unverified, continue working (use poll if waiting). ` +
						`Otherwise, provide your final summary.`
					);
					this._context.addMessage(verifyMsg);
					this._onDidReceiveMessage.fire(verifyMsg);
					this._stepRecords.push(stepRecord);
					stepCount++;
					continue;
				}
				// Max verification rounds reached — accept conclusion.
				this._contextHistoryForContinue = [...this._context.messages];
				consecutiveToolOnlySteps = 0;
				verificationRounds = 0;
				this._stepRecords.push(stepRecord);
				break;
			}

			// Agent is taking action — reset verification counter
			verificationRounds = 0;

			// Track whether this step produced any analysis.
			// Reasoning models (thinking mode) put their analysis in reasoningContent
			// while content stays empty during tool-calling steps. Treat either as
			// evidence of progress so we don't false-positive on loop detection.
			const hasAnalysis =
				(response.content && response.content.trim().length > 0) ||
				(response.reasoningContent && response.reasoningContent.trim().length > 0);
			if (!hasAnalysis) {
				consecutiveToolOnlySteps++;
			} else {
				consecutiveToolOnlySteps = 0;
			}

			for (const toolCall of response.toolCalls) {
				if (token.isCancellationRequested) {
					throw new Error('Cancelled');
				}

				hasExecutedTool = true;
				const toolExecStart = Date.now();
				const result = await this._executeTool(toolCall.id, toolCall.name, toolCall.arguments);
				const toolExecDuration = Date.now() - toolExecStart;

				// ---- Step tracing: record tool execution ----
				const execRecord: IToolExecutionRecord = {
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					arguments: { ...toolCall.arguments },
					result: result.output || result.error || '',
					success: result.success,
					error: result.error,
					durationMs: toolExecDuration,
					timestamp: toolExecStart,
				};
				stepRecord.toolExecutions.push(execRecord);

				// Truncate large tool results to prevent context overflow
				const truncatedResult = this._truncateToolResult(result);

				const resultMsg = createToolResultMessage(truncatedResult);
				this._context.addMessage(resultMsg);
				this._onDidReceiveMessage.fire(resultMsg);
			}

			this._stepRecords.push(stepRecord);
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

		// Create an AbortController for this tool execution so /btw cancel can interrupt it.
		const controller = new AbortController();
		this._currentToolController = controller;

		try {
			// If the cancellation token is already set, check it before starting
			if (controller.signal.aborted) {
				return {
					toolCallId,
					success: false,
					output: '',
					error: 'Tool execution cancelled by user (/btw cancel)',
				};
			}

			// If tool specifies its own timeout, respect it; otherwise use stepTimeout
			const effectiveTimeout = (args.timeout as number) || this._config.stepTimeout;
			const result = await Promise.race([
				tool.execute({ ...args, _toolCallId: toolCallId }, controller.signal),
				this._timeout(effectiveTimeout, toolCallId),
			]);
			return result;
		} catch (err) {
			// Check if this was an abort (cancellation)
			if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
				return {
					toolCallId,
					success: false,
					output: '',
					error: 'Tool execution cancelled by user (/btw cancel)',
				};
			}
			return {
				toolCallId,
				success: false,
				output: '',
				error: `Tool execution error: ${(err as Error).message}`,
			};
		} finally {
			// Clear the controller reference
			if (this._currentToolController === controller) {
				this._currentToolController = undefined;
			}
		}
	}

	private _timeout(ms: number, toolCallId: string): Promise<IToolResult> {
		return new Promise((_, reject) => {
			setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms`)), ms);
		});
	}

	/**
	 * Detect complex tasks by keyword matching. When a complex task is detected,
	 * the agent injects extra deep thinking instructions before starting the loop.
	 */
	private _isComplexTask(message: string): boolean {
		const lower = message.toLowerCase();
		return COMPLEX_TASK_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
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