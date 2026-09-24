/*---------------------------------------------------------------------------------------------
 *  Agent Context Manager - Sliding window + summary compression
 *
 *  Features:
 *  - Sliding window with token budget management
 *  - Automatic compression via LLM summarization when approaching context limit
 *  - Reasoning_content preservation during compression
 *  - Orphaned tool message cleanup
 *--------------------------------------------------------------------------------------------*/

import {
	IAgentMessage,
	MessageRole,
	createMessage,
} from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider, TOKENS_PER_MESSAGE_OVERHEAD } from 'vs/workbench/services/agent/browser/llmProvider';

/**
 * Fraction of the input budget the sliding window may use. Deliberately
 * conservative: token estimates are heuristics, and the API counts the REAL
 * tokenizer output — a window filled to 100% of the estimate can still overflow
 * the model's actual limit once the completion budget is added.
 */
const WINDOW_UTILIZATION = 0.75;

/**
 * Marker prefix for the pinned task statement. Kept short and explicit so the
 * model can tell the pinned goal apart from the replayed conversation.
 */
const TASK_ANCHOR_PREFIX = '[Pinned original task — always in context]';

/**
 * Content of the synthetic tool result inserted when a tool call was never
 * answered (task cancelled/interrupted, or a session resumed mid-call).
 */
export const UNANSWERED_TOOL_CALL =
	'[not executed] the tool call was never answered (task interrupted or cancelled)';

/**
 * Enforce the API's tool-call pairing invariant on a message list.
 *
 * The OpenAI-compatible API rejects a request whose assistant `tool_calls`
 * message is not followed by one `tool` message per `tool_call_id`
 * ("insufficient tool messages following tool_calls message"), and it also
 * rejects a `tool` message that answers nothing. Neither is recoverable by the
 * model: every retry replays the same malformed history and gets the same 400,
 * so an affected session can never be resumed (observed: three consecutive
 * "继续" tasks failed in under a second with that exact API error).
 *
 * The history CAN legitimately end up malformed — a run can be interrupted
 * between the assistant turn (already appended) and its tool results (Ctrl+C /
 * exit saves the session right after `cancel()`), `/btw` can supersede a plan
 * mid-step, and the sliding window can start in the middle of an assistant
 * tool_calls group. Trusting every producer to have honoured the invariant is
 * what failed; enforcing it at the boundaries (send + persist) cannot.
 *
 * Returns a NEW array; input messages are reused by reference so callers can
 * tell which tool results were synthesized.
 */
export function sanitizeToolCallPairs(messages: readonly IAgentMessage[]): IAgentMessage[] {
	const out: IAgentMessage[] = [];
	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];

		if (msg.role === MessageRole.Assistant && msg.toolCalls && msg.toolCalls.length > 0) {
			out.push(msg);
			const answered = new Set<string>();
			let j = i + 1;
			// Every following `tool` message belongs to this assistant turn.
			while (j < messages.length && messages[j].role === MessageRole.Tool) {
				const id = messages[j].toolCallId;
				// A duplicate id (or a missing one) is itself invalid → drop it.
				if (id && !answered.has(id)) {
					out.push(messages[j]);
					answered.add(id);
				}
				j++;
			}
			for (const tc of msg.toolCalls) {
				if (!answered.has(tc.id)) {
					out.push(createMessage(MessageRole.Tool, UNANSWERED_TOOL_CALL, { toolCallId: tc.id }));
				}
			}
			i = j;
			continue;
		}

		if (msg.role === MessageRole.Tool) {
			// Orphan tool result: its assistant tool_calls is gone (evicted by the
			// window, or dropped by a previous repair). The API rejects it.
			i++;
			continue;
		}

		out.push(msg);
		i++;
	}
	return out;
}

export class AgentContext {
	private readonly _messages: IAgentMessage[] = [];
	private _systemPrompt: IAgentMessage | undefined;
	/**
	 * The original task statement, pinned OUTSIDE the sliding window.
	 *
	 * The sliding window drops the OLDEST messages first and compaction
	 * summarizes the older half away — both of them drop the statement the user
	 * actually asked for, so a long run can end up optimizing a half-remembered
	 * goal. The reference harness guards against exactly this by rebuilding its
	 * post-overflow prompt as "original_instruction + current state"; here the
	 * anchor is simply re-sent verbatim on every request instead of being
	 * summarized.
	 */
	private _taskAnchor: IAgentMessage | undefined;

	constructor(
		private _maxTokens: number,
		private _maxOutputTokens: number,
		private _llmProvider: ILLMProvider,
	) { }

	swapTokenCounter(provider: ILLMProvider): void {
		this._llmProvider = provider;
	}

	/** Estimated total tokens held in the message history (incl. system prompt). */
	get estimatedTokens(): number {
		return this._estimateTotalTokens();
	}

	/** Token budget available for input messages under the ACTIVE model. */
	get inputBudget(): number {
		return this._inputBudget;
	}

	/** True when the history no longer fits the active model's input budget. */
	get isOverBudget(): boolean {
		return this._estimateTotalTokens() > this._inputBudget * WINDOW_UTILIZATION;
	}

	/**
	 * Re-target the context to another model after a runtime model switch
	 * (scenario routing, /profile, or the 保底 fallback).
	 *
	 * The window budgets MUST follow the new model. Keeping the previous model's
	 * (usually larger) window after switching to a smaller one is a silent
	 * context-corruption bug: the sliding window happily keeps more history than
	 * the new model accepts, so its completion budget is clamped to ~0, the
	 * request fails with ContextOverflowError, and the loop force-compacts —
	 * collapsing the conversation the user was relying on.
	 */
	setModelBudget(maxTokens?: number, maxOutputTokens?: number): void {
		if (maxTokens && maxTokens > 0) this._maxTokens = maxTokens;
		if (maxOutputTokens && maxOutputTokens > 0) this._maxOutputTokens = maxOutputTokens;
	}

	/**
	 * Drop reasoning_content produced by a PREVIOUS model.
	 *
	 * Chain-of-thought is model-private. Replaying one model's thinking into a
	 * different one both breaks the thinking-mode API invariant (reasoning_content
	 * must be present on ALL assistant messages, or on none) and is a known way to
	 * derail the new model: it latches onto the foreign plan and re-emits it
	 * (observed: hy3 repeating "Hmm — let me find lit. / Let me do it." 1600+ times
	 * until it burned its whole output budget and answered nothing).
	 *
	 * `content` and `toolCalls` are preserved, so no tool-result message becomes
	 * orphaned and no assistant message turns invalid.
	 */
	dropReasoningContent(predicate?: (msg: IAgentMessage) => boolean): number {
		let dropped = 0;
		for (let i = 0; i < this._messages.length; i++) {
			const msg = this._messages[i];
			if (msg.reasoningContent === undefined) continue;
			if (predicate && !predicate(msg)) continue;
			this._messages[i] = { ...msg, reasoningContent: undefined };
			dropped++;
		}
		return dropped;
	}

	/**
	 * Token budget reserved for input messages. The model's context window is
	 * shared between input (messages) and output (max_tokens), so the sliding
	 * window must reserve the completion budget — otherwise a near-full message
	 * window plus a large max_tokens triggers "maximum context length" API errors.
	 */
	private get _inputBudget(): number {
		return Math.max(1, this._maxTokens - this._maxOutputTokens);
	}

	get messages(): readonly IAgentMessage[] {
		return this._messages;
	}

	get length(): number {
		return this._messages.length;
	}

	get systemPromptContent(): string {
		return this._systemPrompt?.content || '';
	}

	setSystemPrompt(content: string): void {
		this._systemPrompt = createMessage(MessageRole.System, content);
	}

	/**
	 * Pin the original task statement so neither the sliding window nor
	 * compaction can lose it. Called once per task, with the user's own words.
	 */
	setTaskAnchor(content: string): void {
		const trimmed = (content || '').trim();
		if (!trimmed) return;
		this._taskAnchor = createMessage(MessageRole.User, `${TASK_ANCHOR_PREFIX}\n${trimmed}`);
	}

	/** The pinned task text as the user wrote it, or undefined when nothing is pinned. */
	get taskAnchorContent(): string | undefined {
		if (!this._taskAnchor) return undefined;
		return this._taskAnchor.content.slice(TASK_ANCHOR_PREFIX.length + 1);
	}

	/** Forget the pinned task (used when a new conversation replaces this one). */
	clearTaskAnchor(): void {
		this._taskAnchor = undefined;
	}

	addMessage(message: IAgentMessage): void {
		this._messages.push(message);
	}

	/**
	 * Apply `sanitizeToolCallPairs` to the LIVE history and return the tool
	 * results that had to be synthesized (empty when the history was already
	 * valid).
	 *
	 * Called when a task ends (cancel/crash included), so what gets persisted is
	 * a resumable conversation instead of one that 400s forever.
	 */
	repairToolCallPairs(): IAgentMessage[] {
		const repaired = sanitizeToolCallPairs(this._messages);
		if (repaired.length === this._messages.length
			&& repaired.every((m, i) => m === this._messages[i])) {
			return [];
		}
		const original = new Set<IAgentMessage>(this._messages);
		const inserted = repaired.filter(m => !original.has(m));
		this._messages.length = 0;
		this._messages.push(...repaired);
		return inserted;
	}

	getContextWindow(): IAgentMessage[] {
		const result: IAgentMessage[] = [];

		let tokenCount = 0;

		if (this._systemPrompt) {
			result.push(this._systemPrompt);
			tokenCount += this._estimateTokens(this._systemPrompt);
		}

		// The pinned task is never evicted: it is the one message whose loss
		// silently changes what the agent is working on.
		if (this._taskAnchor) {
			result.push(this._taskAnchor);
			tokenCount += this._estimateTokens(this._taskAnchor);
		}

		const contextMessages: IAgentMessage[] = [];

		for (let i = this._messages.length - 1; i >= 0; i--) {
			const msg = this._messages[i];
			const msgTokens = this._estimateTokens(msg);

			if (tokenCount + msgTokens > this._inputBudget * WINDOW_UTILIZATION) {
				break;
			}

			contextMessages.unshift(msg);
			tokenCount += msgTokens;
		}

		result.push(...contextMessages);

		// Send-boundary invariant: whatever the producers did, what leaves the
		// process is always a valid tool-call pairing — an unanswered assistant
		// `tool_calls` is a permanent 400 for the whole session.
		return sanitizeToolCallPairs(result);
	}

	/**
	 * Compact the conversation history when it grows too large (or always, when
	 * `force` is set — used to recover from a context-overflow API error).
	 * Older messages are summarized via the LLM; if summarization fails, the
	 * oldest messages are truncated instead. Returns true if a compaction ran.
	 */
	async compactIfNeeded(force = false): Promise<boolean> {
		const totalTokens = this._estimateTotalTokens();

		if (!force && totalTokens < this._inputBudget * WINDOW_UTILIZATION) {
			return false;
		}

		const splitPoint = Math.floor(this._messages.length / 2);
		const oldMessages = this._messages.slice(0, splitPoint);
		let recentMessages = this._messages.slice(splitPoint);

		// Remove orphaned tool messages at the start of recentMessages
		// (tool messages without a preceding assistant message with tool_calls)
		while (recentMessages.length > 0 && recentMessages[0].role === MessageRole.Tool) {
			recentMessages = recentMessages.slice(1);
		}

		// Check if we're in reasoning_content mode (any old message has it)
		const hasThinking = oldMessages.some(m =>
			m.role === MessageRole.Assistant && m.reasoningContent
		);

		const summaryContent = oldMessages
			.map(m => {
				let prefix = `[${m.role}]`;
				if (m.role === MessageRole.Assistant && m.reasoningContent) {
					prefix += `(reasoning: ${m.reasoningContent.substring(0, 100)})`;
				}
				return `${prefix}: ${m.content.substring(0, 200)}`;
			})
			.join('\n');

		// A compaction is a HANDOFF: the model that continues has never seen the
		// transcript, so the prompt asks for the task, the decisions, the evidence
		// and the next step instead of a generic "summarize this". The pinned task
		// is repeated verbatim in case the older half no longer states it.
		const anchorContent = this.taskAnchorContent;
		const summaryPrompt = createMessage(MessageRole.User,
			`Write a HANDOFF summary of the conversation below so that work can continue ` +
			`without the original transcript. Preserve, in this order:\n` +
			`1. the original task and every explicit requirement (verbatim where wording matters),\n` +
			`2. decisions already made and files created or changed,\n` +
			`3. commands or tests already run and their results,\n` +
			`4. what is still unfinished or unverified, and the next concrete step.\n` +
			`Do not invent progress that did not happen.\n\n` +
			(anchorContent ? `Pinned original task:\n${anchorContent}\n\n` : '') +
			`Conversation to summarize:\n\n${summaryContent}`
		);

		// Retry summarization up to 2 times before falling back to truncation
		const MAX_SUMMARY_RETRIES = 2;
		for (let attempt = 0; attempt <= MAX_SUMMARY_RETRIES; attempt++) {
			try {
				const summaryResponse = await this._llmProvider.complete([
					createMessage(MessageRole.System,
						'You are a conversation summarizer. Provide a concise summary preserving all technical details.'),
					summaryPrompt,
				], undefined, 0); // no tools, temperature 0 for deterministic summary

				// Clear and rebuild messages
				this._messages.length = 0;

				// Create the summary message. If the old context had reasoning_content,
				// preserve that in the summary to maintain API compatibility.
				const summaryMsg = hasThinking
					? createMessage(MessageRole.Assistant, `[Previous context summary]\n${summaryResponse.content}`, {
						reasoningContent: summaryResponse.reasoningContent || '(compressed summary)',
					})
					: createMessage(MessageRole.Assistant, `[Previous context summary]\n${summaryResponse.content}`);

				this._messages.push(summaryMsg, ...recentMessages);
				return true;
			} catch (err) {
				if (attempt < MAX_SUMMARY_RETRIES) {
					console.warn(`[Context Summarization] Attempt ${attempt + 1} failed, retrying: ${(err as Error).message}`);
					// Brief delay before retry
					await new Promise(r => setTimeout(r, 1000));
					continue;
				}
				// All retries exhausted: fall back to truncation
				console.warn(`[Context Summarization] All retries exhausted, falling back to truncation`);
				this._messages.splice(0, splitPoint);

				// Remove orphaned tool messages at the start after truncation
				while (this._messages.length > 0 && this._messages[0].role === MessageRole.Tool) {
					this._messages.shift();
				}
				return true;
			}
		}

		return true;
	}

	clear(): void {
		this._messages.length = 0;
		this._systemPrompt = undefined;
		this._taskAnchor = undefined;
	}

	private _estimateTokens(message: IAgentMessage): number {
		let total = this._llmProvider.countTokens(message.content);
		// Account for reasoning_content tokens if present
		if (message.reasoningContent) {
			total += this._llmProvider.countTokens(message.reasoningContent);
		}
		// Account for JSON message framing (role, id, timestamp, tool_call_id, keys)
		return total + TOKENS_PER_MESSAGE_OVERHEAD;
	}

	private _estimateTotalTokens(): number {
		let total = this._systemPrompt ? this._estimateTokens(this._systemPrompt) : 0;
		if (this._taskAnchor) {
			total += this._estimateTokens(this._taskAnchor);
		}
		for (const msg of this._messages) {
			total += this._estimateTokens(msg);
		}
		return total;
	}
}