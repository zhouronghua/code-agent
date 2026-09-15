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
	IModelSwitchEvent,
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

// ---- 保底 (fallback) model supervision ----
// After switching to the fallback model because the primary/scenario model timed
// out, a background probe keeps checking whether the primary model is reachable
// again so the agent can return to it without waiting for the next failure.
const FALLBACK_PROBE_INITIAL_DELAY_MS = 30_000;
const FALLBACK_PROBE_MAX_DELAY_MS = 120_000;
/** Per-probe timeout — a model that needs longer than this is still unhealthy. */
const FALLBACK_PROBE_TIMEOUT_MS = 10_000;

/**
 * Maximum characters of model reasoning_content shown in the console.
 *
 * Reasoning models can emit tens of thousands of characters of chain-of-thought,
 * and a degenerate repetition loop can emit 100k+ (observed: 98k chars repeating
 * "Hmm — let me find lit. / Let me do it."). Dumping that in full buries the
 * actual answer, so we print a head/tail excerpt and say what was elided.
 */
const MAX_REASONING_CHARS_LOGGED = 4000;
/** How much of the elided reasoning to show at each end of the excerpt. */
const REASONING_EXCERPT_CHARS = 2000;

// Maximum corrective rounds when a thinking model burns its whole output budget
// repeating the same reasoning and answers nothing.
const MAX_REASONING_CORRECTION_ROUNDS = 2;

/**
 * Number of duplicate lines beyond which a reasoning block counts as a loop.
 * A stuck model repeats one line hundreds of times ("Let me do it." × 1617).
 */
const REASONING_LOOP_MIN_REPEATS = 20;
/** A loop also has to dominate the block, not just appear often. */
const REASONING_LOOP_MIN_SHARE = 0.2;
/** Below this size, repeated lines are normal planning phrasing, not a loop. */
const REASONING_LOOP_MIN_CHARS = 4000;

/** How many times the most frequent non-empty line repeats in a reasoning block. */
export function countRepeatedReasoningLines(reasoning: string): number {
	const counts = new Map<string, number>();
	for (const line of reasoning.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
	}
	let max = 0;
	for (const c of counts.values()) if (c > max) max = c;
	return max;
}

/**
 * Detect a degenerate reasoning loop: the same line repeated so often that the
 * model is clearly not progressing (it will just burn the output budget).
 */
export function isDegenerateReasoning(reasoning: string): boolean {
	if (reasoning.length < REASONING_LOOP_MIN_CHARS) return false;
	const lines = reasoning.split('\n').map(l => l.trim()).filter(l => l.length > 0);
	if (lines.length < REASONING_LOOP_MIN_REPEATS * 2) return false;
	const repeats = countRepeatedReasoningLines(reasoning);
	return repeats >= REASONING_LOOP_MIN_REPEATS && repeats / lines.length >= REASONING_LOOP_MIN_SHARE;
}

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

/**
 * Detect an API "access timeout" error, used to trigger the 保底 (fallback)
 * model. Covers:
 *   - the provider's own AbortError / "request timed out" message,
 *   - Node/undici socket timeouts (ETIMEDOUT, UND_ERR_*_TIMEOUT, ESOCKETTIMEDOUT),
 *   - axios-style ECONNABORTED timeouts.
 * Generic network errors (ECONNRESET / ECONNREFUSED) are intentionally NOT
 * treated as timeouts so a transient reset does not needlessly burn the
 * fallback model.
 */
export function isApiTimeoutError(err: unknown): boolean {
	if (!err) return false;
	const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
	if (e.name === 'AbortError') return true;

	const parts: string[] = [];
	if (e.message) parts.push(e.message);
	if (e.code) parts.push(String(e.code));
	const cause = e.cause as { message?: string; code?: string } | undefined;
	if (cause) {
		if (cause.message) parts.push(cause.message);
		if (cause.code) parts.push(String(cause.code));
	}
	const hay = parts.join(' ').toLowerCase();
	return /timed?\s*out|timeout|etimedout|esockettimedout|econnaborted|und_err_connect_timeout|und_err_headers_timeout|und_err_body_timeout/.test(hay);
}

/**
 * Render a runtime model switch as one line, e.g.
 *   [MODEL] ⚠ deepseek-flash unreachable → switched to 保底模型 gpt-5.6-luna, retrying the same request
 *   [MODEL] ✓ deepseek-flash reachable again → switched back from 保底模型 gpt-5.6-luna
 */
export function formatModelSwitch(e: IModelSwitchEvent): string {
	const detail = e.detail ? ` (${e.detail})` : '';
	switch (e.reason) {
		case 'fallback-timeout':
			return `[MODEL] ⚠ ${e.from} unreachable → switched to 保底模型 ${e.to}, retrying the same request${detail}`;
		case 'primary-recovered':
			return `[MODEL] ✓ ${e.to} reachable again → switched back from 保底模型 ${e.from}${detail}`;
		case 'profile':
			return `[MODEL] ↪ profile switch ${e.from} → ${e.to}${detail}`;
		default:
			return `[MODEL] ↪ routed ${e.from} → ${e.to}${detail}`;
	}
}

/**
 * Bound the reasoning_content printed to the console. Chain-of-thought can be
 * enormous (a repetition loop reached 98k chars), and printing it verbatim
 * drowns out the actual answer — which is exactly how a stuck reasoning model
 * looks like "a pile of filler" to the user.
 */
export function formatReasoningForLog(reasoning: string): string {
	if (reasoning.length <= MAX_REASONING_CHARS_LOGGED) return reasoning;
	const half = Math.floor(REASONING_EXCERPT_CHARS / 2);
	const head = reasoning.slice(0, REASONING_EXCERPT_CHARS - half);
	const tail = reasoning.slice(-half);
	const elided = reasoning.length - head.length - tail.length;
	return `${head}\n... [${elided} chars of reasoning elided] ...\n${tail}`;
}

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

	// ---- Model fallback (保底模型) ----
	// When the active scenario/default model times out, the agent swaps to this
	// model and retries the same request. Configured via config.yaml
	// `model_routing.fallback`.
	private _fallbackConfig: IAgentConfig | undefined;
	private _fallbackProvider: ILLMProvider | undefined;
	private _usingFallback = false;

	// ---- Model switch reporting + fallback supervision ----
	// The model that was active before the fallback swap; the probe returns to it.
	private _primaryConfig: IAgentConfig | undefined;
	private _primaryProvider: ILLMProvider | undefined;
	private _probeTimer: ReturnType<typeof setTimeout> | undefined;
	private _probeDelayMs = FALLBACK_PROBE_INITIAL_DELAY_MS;
	private _probeInitialDelayMs = FALLBACK_PROBE_INITIAL_DELAY_MS;
	private _probeMaxDelayMs = FALLBACK_PROBE_MAX_DELAY_MS;
	/** Set true while an LLM request is in flight on the current provider. */
	private _llmRequestInFlight = false;
	/** A background probe found the primary model healthy while a request was in flight. */
	private _primaryRecovered = false;
	/** Set by a model switch whose history no longer fits the new model's window. */
	private _pendingForceCompact = false;

	private readonly _onDidSwitchModel = new Emitter<IModelSwitchEvent>();
	/** Fired on every runtime model switch (routing / fallback / recovery). */
	readonly onDidSwitchModel: Event<IModelSwitchEvent> = this._onDidSwitchModel.event;

	/**
	 * Renders a model-switch message. Overridable so the CLI can colorize it;
	 * defaults to a plain single line so a switch is never invisible in any host.
	 */
	private _modelSwitchLogger: (event: IModelSwitchEvent) => void = e => console.log(formatModelSwitch(e));

	// ---- Per-task execution tracing ----
	private _stepRecords: IStepRecord[] = [];
	private _modelSwitches: IModelSwitchEvent[] = [];
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

	/**
	 * Switch the agent onto another model (scenario routing, /profile, or an
	 * explicit host action) and report it as a user-visible model switch.
	 */
	swapProvider(config: IAgentConfig, provider: ILLMProvider, reason: IModelSwitchEvent['reason'] = 'routing'): void {
		const fromModel = this._config.model;
		this._applyModelSwitch(config, provider);
		// Any explicit provider swap (e.g. per-task scenario routing) resets the
		// fallback state so the new model gets a fresh chance before falling back,
		// and cancels any pending recovery probe for the old primary model.
		this._usingFallback = false;
		this._primaryRecovered = false;
		this._stopRecoveryProbe();
		if (config.model !== fromModel) {
			this._reportModelSwitch({
				from: fromModel,
				to: config.model,
				reason,
				toFallback: false,
			});
		}
	}

	/**
	 * Install the switch renderer used by hosts that want a colorized line.
	 * The agent always fires `onDidSwitchModel`; this only controls the direct
	 * console output, which keeps a switch visible even without a listener.
	 */
	setModelSwitchLogger(logger: (event: IModelSwitchEvent) => void): void {
		this._modelSwitchLogger = logger;
	}

	/**
	 * Move the agent onto another model, keeping the conversation usable.
	 *
	 * Everything the agent needs to answer correctly lives in the context, so a
	 * switch must carry the model's budgets over AND drop chain-of-thought that
	 * belongs to the previous model — otherwise the sliding window keeps more
	 * history than the new model accepts (silent force-compaction) and the new
	 * model is fed another model's thinking (incoherent continuation, repetition
	 * loops). This is the fix for "模型一切换，上下文就不对了".
	 */
	private _applyModelSwitch(config: IAgentConfig, provider: ILLMProvider): void {
		const modelChanged = config.model !== this._config.model;
		this._config = config;
		this._llmProvider = provider;
		this._context.swapTokenCounter(provider);
		if (modelChanged) {
			this._context.setModelBudget(config.maxContextTokens, config.maxOutputTokens);
			// Chain-of-thought is model-private, so carrying it across a switch is
			// wrong two ways: the new model is fed another model's reasoning (which
			// it may just continue verbatim), and the provider's thinking-mode rule
			// ("all assistant messages carry reasoning_content, or none") would stamp
			// an empty reasoning_content onto every assistant message.
			// Only drop when the new model does NOT think: switching between two
			// thinking models keeps the history as-is, which is exactly what the
			// provider already normalizes today (no new failure mode).
			const newModelThinks = provider.supportsReasoning?.() ?? false;
			const dropped = newModelThinks ? 0 : this._context.dropReasoningContent();
			// A smaller window may no longer hold the history the previous model
			// allowed. Flag it for compaction at the top of the next loop iteration
			// (never compact here: this can be called from a background probe while
			// the loop is mid-step, and compacting concurrently would lose messages).
			if (this._context.isOverBudget) {
				this._pendingForceCompact = true;
				console.warn(
					`[MODEL] history (~${this._context.estimatedTokens} tokens) exceeds ${config.model}'s ` +
					`input budget (${this._context.inputBudget} tokens) — compacting conversation`
				);
			}
			if (dropped > 0) {
				console.warn(`[MODEL] dropped reasoning_content from ${dropped} message(s) belonging to the previous model`);
			}
		}
		this._planner.swapProvider(provider);
	}

	/** Fire the switch event and render it (host logger or plain console). */
	private _reportModelSwitch(event: IModelSwitchEvent): void {
		this._modelSwitches.push({ ...event, at: Date.now() });
		this._onDidSwitchModel.fire(event);
		try {
			this._modelSwitchLogger(event);
		} catch { /* reporting must never break the agent */ }
	}

	/**
	 * Register the 保底 (guaranteed fallback) model. When the active model's API
	 * call times out, the agent automatically switches to this model and retries
	 * the same request instead of failing the task.
	 */
	setFallback(config: IAgentConfig, provider: ILLMProvider): void {
		this._fallbackConfig = config;
		this._fallbackProvider = provider;
	}

	/** Whether a 保底 (fallback) model is registered. */
	get hasFallback(): boolean {
		return !!this._fallbackConfig && !!this._fallbackProvider;
	}

	/**
	 * Switch to the 保底 model after the primary/scenario model became
	 * unreachable, retry the same request, and start supervising the primary
	 * model so the agent returns to it as soon as it answers again.
	 */
	private _enterFallback(err: unknown, fromConfig: IAgentConfig, fromProvider: ILLMProvider): void {
		const to = this._fallbackConfig!;
		this._primaryConfig = fromConfig;
		this._primaryProvider = fromProvider;
		this._applyModelSwitch(to, this._fallbackProvider!);
		this._usingFallback = true;
		this._reportModelSwitch({
			from: fromConfig.model,
			to: to.model,
			reason: 'fallback-timeout',
			toFallback: true,
			detail: `timeout: ${(err as Error).message}`,
		});
		this._startRecoveryProbe();
	}

	/**
	 * Background supervision of the primary model while running on the 保底
	 * model: probe it with a cheap health check (backing off 30s → 120s) and
	 * switch back the moment it responds. The timer is unref'd so a pending probe
	 * never keeps the CLI process alive.
	 */
	private _startRecoveryProbe(): void {
		if (this._probeTimer) return;
		if (!this._primaryProvider || !this._primaryProvider.healthCheck) return;
		this._probeDelayMs = this._probeInitialDelayMs;
		this._scheduleProbe();
	}

	/**
	 * Override the recovery-probe schedule (default 30s, backing off to 120s).
	 * Exposed so a host can probe more or less aggressively, and so the
	 * switch-back path is testable without waiting a minute.
	 */
	setProbeSchedule(initialDelayMs: number, maxDelayMs = initialDelayMs): void {
		this._probeInitialDelayMs = Math.max(50, initialDelayMs);
		this._probeMaxDelayMs = Math.max(this._probeInitialDelayMs, maxDelayMs);
	}

	private _scheduleProbe(): void {
		if (!this._primaryProvider || !this._usingFallback) return;
		this._probeTimer = setTimeout(() => {
			this._probeTimer = undefined;
			void this._runProbe();
		}, this._probeDelayMs);
		// Never hold the event loop open just to probe.
		(this._probeTimer as unknown as { unref?: () => void }).unref?.();
	}

	private async _runProbe(): Promise<void> {
		const provider = this._primaryProvider;
		const config = this._primaryConfig;
		if (!this._usingFallback || !provider || !config) return;

		let reachable = false;
		try {
			reachable = (await provider.healthCheck!(FALLBACK_PROBE_TIMEOUT_MS)) === true;
		} catch {
			reachable = false;
		}

		if (!this._usingFallback || this._primaryProvider !== provider) return;

		if (reachable) {
			// Prefer an immediate switch-back; if a request is in flight, defer to
			// the next loop iteration so the recorded response keeps its provenance.
			this._clearProbeTimer();
			if (this._llmRequestInFlight) {
				this._primaryRecovered = true;
				console.warn('[MODEL] primary model reachable again — switching back at the next step');
			} else {
				this._switchBackToPrimary('primary model answered a health probe');
			}
			return;
		}

		this._probeDelayMs = Math.min(this._probeDelayMs * 2, this._probeMaxDelayMs);
		this._scheduleProbe();
	}

	/** Return to the primary/scenario model after it recovered. */
	private _switchBackToPrimary(detail: string): void {
		const config = this._primaryConfig;
		const provider = this._primaryProvider;
		if (!config || !provider) return;

		const fromModel = this._config.model;
		this._applyModelSwitch(config, provider);
		this._usingFallback = false;
		this._stopRecoveryProbe();
		this._reportModelSwitch({
			from: fromModel,
			to: config.model,
			reason: 'primary-recovered',
			toFallback: false,
			detail,
		});
	}

	private _stopRecoveryProbe(): void {
		this._clearProbeTimer();
		this._primaryConfig = undefined;
		this._primaryProvider = undefined;
	}

	private _clearProbeTimer(): void {
		if (this._probeTimer) {
			clearTimeout(this._probeTimer);
			this._probeTimer = undefined;
		}
	}

	/** The model id currently used by the agent (changes after a fallback swap). */
	get activeModel(): string {
		return this._config.model;
	}

	/** Whether the agent is currently running on the fallback (保底) model. */
	get usingFallback(): boolean {
		return this._usingFallback;
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
			modelSwitches: this._modelSwitches.length > 0 ? [...this._modelSwitches] : undefined,
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
		this._modelSwitches = [];
		this._taskStartTime = Date.now();
		this._taskDescription = userMessage;
		this._taskError = undefined;
		// A previous run may have aborted mid-request; never leave the probe blocked.
		this._llmRequestInFlight = false;

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
		this._modelSwitches = [];
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
		this._modelSwitches = [];
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
		// Corrective rounds used after a degenerate reasoning loop produced no answer.
		let reasoningCorrectionRounds = 0;
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

			// ---- Return to the primary model as soon as it recovers ----
			// A background probe (started when the agent fell back) may have found
			// the primary/scenario model healthy while a request was in flight.
			if (this._usingFallback && this._primaryRecovered) {
				this._primaryRecovered = false;
				this._switchBackToPrimary('primary model answered a health probe');
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

			// A model switch whose history no longer fits the new model's window
			// (e.g. 保底模型 with a smaller context) must compact before the call.
			await this._context.compactIfNeeded(this._pendingForceCompact);
			this._pendingForceCompact = false;

			let messages = this._context.getContextWindow();

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
			this._llmRequestInFlight = true;
			for (;;) {
				messages = this._context.getContextWindow();

				// Check if the current context uses reasoning_content (thinking mode).
				// Reasoning models require special handling:
				//   - Streaming is incompatible because it doesn't capture reasoning_content
				//   - Message filtering is needed to maintain API compatibility
				// Recomputed inside the loop so a fallback provider swap is reflected.
				const hasThinking = messages.some(m => m.role === MessageRole.Assistant && m.reasoningContent);
				const providerSupportsStreaming = this._llmProvider.supportsStreaming?.() ?? true;
				const isReasoningModel = this._llmProvider.supportsReasoning?.() ?? false;

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
							this._config.topK,
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
							this._config.topK,
						);
					}
					break;
				} catch (err) {
					// ---- Model fallback (保底模型) on API access timeout ----
					// When the active scenario/default model times out, transparently
					// switch to the configured fallback model and retry the SAME
					// request instead of failing the whole task. Only one fallback
					// attempt is made per request (no ping-pong between models); a
					// background probe then watches the primary model and returns to
					// it as soon as it answers again.
					if (isApiTimeoutError(err) && this._fallbackProvider && this._fallbackConfig && !this._usingFallback) {
						this._enterFallback(err, this._config, this._llmProvider);
						// The 保底 model may have a much smaller window than the model
						// that just timed out — compact now instead of burning another
						// (possibly slow) request against an overflowing context.
						if (this._pendingForceCompact) {
							this._pendingForceCompact = false;
							await this._context.compactIfNeeded(true);
						}
						continue;
					}
					if (err instanceof ContextOverflowError && overflowRetries < MAX_OVERFLOW_RETRIES) {
						overflowRetries++;
						console.warn(`[Context Overflow] Conversation history too large — compacting and retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES}): ${(err as Error).message}`);
						await this._context.compactIfNeeded(true);
						continue;
					}
					throw err;
				}
			}
			// The request finished — a recovery probe may swap providers again.
			this._llmRequestInFlight = false;

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
				//
				// Degenerate reasoning loop: a thinking model can repeat the same
				// plan line until it exhausts its whole output budget, producing no
				// answer and no action (observed: hy3 emitting "Hmm — let me find
				// lit. / Let me do it." 1617 times in 98k chars, then answering
				// nothing). Left alone, that gets accepted as the final answer and
				// the user sees a wall of filler plus an empty reply.
				const reasoning = response.reasoningContent || '';
				if (isDegenerateReasoning(reasoning) && reasoningCorrectionRounds < MAX_REASONING_CORRECTION_ROUNDS) {
					reasoningCorrectionRounds++;
					console.warn(
						`[Reasoning Loop] ${this._config.model} repeated the same reasoning ` +
						`(${reasoning.length} chars, ${countRepeatedReasoningLines(reasoning)} repeats) and produced no ` +
						`answer — discarding that thinking and asking it to act (${reasoningCorrectionRounds}/${MAX_REASONING_CORRECTION_ROUNDS}).`
					);
					// Drop the runaway thinking so it neither bloats the context nor
					// invites the next request to continue the loop.
					this._context.dropReasoningContent(m => m.id === response.id);
					const loopMsg = createMessage(MessageRole.User,
						`[System note] Your previous turn produced NO answer and repeated the same reasoning over and over. ` +
						`Stop repeating yourself. Either take the next concrete action (call a tool) or, if the work is ` +
						`actually finished, reply with your final summary now.`
					);
					this._context.addMessage(loopMsg);
					this._onDidReceiveMessage.fire(loopMsg);
					this._stepRecords.push(stepRecord);
					stepCount++;
					continue;
				}

				// Inject a verification round to make sure it has actually verified.
				// Simple tasks skip this once they have already performed work: the
				// extra LLM round-trips add latency but rarely change the outcome
				// for trivial file operations (mirrors deepseek-harness's
				// latency-sensitive reasoning-effort approach).
				// An empty answer is never accepted — it always gets a retry.
				const hasAnswer = !!response.content.trim();
				const shouldVerify = !hasAnswer || !(skipSelfVerification && hasExecutedTool);
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
		this._stopRecoveryProbe();
		this._onDidReceiveMessage.dispose();
		this._onDidStreamToken.dispose();
		this._onDidComplete.dispose();
		this._onDidError.dispose();
		this._onDidSwitchModel.dispose();
		this._planner.dispose();
		this._modeManager.dispose();
	}
}