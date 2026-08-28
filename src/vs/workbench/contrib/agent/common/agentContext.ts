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
import { ILLMProvider } from 'vs/workbench/services/agent/browser/llmProvider';

export class AgentContext {
	private readonly _messages: IAgentMessage[] = [];
	private _systemPrompt: IAgentMessage | undefined;

	constructor(
		private readonly _maxTokens: number,
		private readonly _maxOutputTokens: number,
		private _llmProvider: ILLMProvider,
	) { }

	swapTokenCounter(provider: ILLMProvider): void {
		this._llmProvider = provider;
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

	addMessage(message: IAgentMessage): void {
		this._messages.push(message);
	}

	getContextWindow(): IAgentMessage[] {
		const result: IAgentMessage[] = [];

		if (this._systemPrompt) {
			result.push(this._systemPrompt);
		}

		let tokenCount = this._systemPrompt
			? this._estimateTokens(this._systemPrompt)
			: 0;

		const contextMessages: IAgentMessage[] = [];

		for (let i = this._messages.length - 1; i >= 0; i--) {
			const msg = this._messages[i];
			const msgTokens = this._estimateTokens(msg);

			if (tokenCount + msgTokens > this._inputBudget * 0.8) {
				break;
			}

			contextMessages.unshift(msg);
			tokenCount += msgTokens;
		}

		result.push(...contextMessages);
		return result;
	}

	async compactIfNeeded(): Promise<boolean> {
		const totalTokens = this._estimateTotalTokens();

		if (totalTokens < this._inputBudget * 0.8) {
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

		const summaryPrompt = createMessage(MessageRole.User,
			`Summarize the following conversation context concisely, preserving key decisions, file changes made, and current task status:\n\n${summaryContent}`
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
	}

	private _estimateTokens(message: IAgentMessage): number {
		let total = this._llmProvider.countTokens(message.content);
		// Account for reasoning_content tokens if present
		if (message.reasoningContent) {
			total += this._llmProvider.countTokens(message.reasoningContent);
		}
		return total;
	}

	private _estimateTotalTokens(): number {
		let total = this._systemPrompt ? this._estimateTokens(this._systemPrompt) : 0;
		for (const msg of this._messages) {
			total += this._estimateTokens(msg);
		}
		return total;
	}
}