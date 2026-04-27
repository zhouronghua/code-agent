/*---------------------------------------------------------------------------------------------
 *  Agent Context Manager - Sliding window + summary compression
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
		private _llmProvider: ILLMProvider,
	) { }

	swapTokenCounter(provider: ILLMProvider): void {
		this._llmProvider = provider;
	}

	get messages(): readonly IAgentMessage[] {
		return this._messages;
	}

	get length(): number {
		return this._messages.length;
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

			if (tokenCount + msgTokens > this._maxTokens * 0.8) {
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

		if (totalTokens < this._maxTokens * 0.8) {
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

		const summaryContent = oldMessages
			.map(m => `[${m.role}]: ${m.content.substring(0, 200)}`)
			.join('\n');

		const summaryPrompt = createMessage(MessageRole.User,
			`Summarize the following conversation context concisely, preserving key decisions, file changes made, and current task status:\n\n${summaryContent}`
		);

		try {
			const summaryResponse = await this._llmProvider.complete([
				createMessage(MessageRole.System, 'You are a conversation summarizer. Provide a concise summary.'),
				summaryPrompt,
			]);

			this._messages.length = 0;
			this._messages.push(
				createMessage(MessageRole.Assistant, `[Previous context summary]\n${summaryResponse.content}`, {
					reasoningContent: summaryResponse.reasoningContent,
				}),
				...recentMessages,
			);

			return true;
		} catch {
			// if summarization fails, just truncate
			this._messages.splice(0, splitPoint);
			
			// Remove orphaned tool messages at the start after truncation
			while (this._messages.length > 0 && this._messages[0].role === MessageRole.Tool) {
				this._messages.shift();
			}
			
			return true;
		}
	}

	clear(): void {
		this._messages.length = 0;
		this._systemPrompt = undefined;
	}

	private _estimateTokens(message: IAgentMessage): number {
		return this._llmProvider.countTokens(message.content);
	}

	private _estimateTotalTokens(): number {
		let total = this._systemPrompt ? this._estimateTokens(this._systemPrompt) : 0;
		for (const msg of this._messages) {
			total += this._estimateTokens(msg);
		}
		return total;
	}
}
