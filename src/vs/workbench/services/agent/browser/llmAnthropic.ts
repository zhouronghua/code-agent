/*---------------------------------------------------------------------------------------------
 *  Anthropic LLM Provider - Messages API with tool_use blocks + streaming
 *--------------------------------------------------------------------------------------------*/

import { ILLMProvider, LLMProviderFactory, estimateTokenCount } from './llmProvider';
import {
	IAgentConfig,
	IAgentMessage,
	ILlmUsage,
	IToolSchema,
	MessageRole,
	createMessage,
} from '../common/agentModels';

interface AnthropicContentBlock {
	type: 'text' | 'tool_use';
	text?: string;
	id?: string;
	name?: string;
	input?: Record<string, unknown>;
}

export class AnthropicProvider implements ILLMProvider {
	readonly name = 'anthropic';
	private readonly _apiKey: string;
	private readonly _apiBase: string;
	private readonly _model: string;

	constructor(config: IAgentConfig) {
		this._apiKey = config.apiKey;
		this._apiBase = config.apiBase || 'https://api.anthropic.com';
		this._model = config.model || 'claude-sonnet-4-20250514';
	}

	async complete(
		messages: IAgentMessage[],
		tools?: IToolSchema[],
		temperature = 0,
		_topK?: number,  // Anthropic API has no top_k; ignored
	): Promise<IAgentMessage> {
		const systemMessage = messages.find(m => m.role === MessageRole.System);
		const nonSystemMessages = messages.filter(m => m.role !== MessageRole.System);

		const body: Record<string, unknown> = {
			model: this._model,
			max_tokens: 4096,
			temperature,
			messages: this._convertMessages(nonSystemMessages),
		};

		if (systemMessage) {
			body.system = systemMessage.content;
		}

		if (tools && tools.length > 0) {
			body.tools = tools.map(t => ({
				name: t.function.name,
				description: t.function.description,
				input_schema: t.function.parameters,
			}));
		}

		const response = await fetch(`${this._apiBase}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this._apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
		}

		const data = await response.json();

		// Normalize Anthropic token usage:
		//   input_tokens / output_tokens, plus cache_read_input_tokens (cache hit)
		//   and cache_creation_input_tokens (cache write).
		const usage = data.usage && typeof data.usage === 'object'
			? {
				promptTokens: data.usage.input_tokens ?? 0,
				completionTokens: data.usage.output_tokens ?? 0,
				totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
				cachedTokens: data.usage.cache_read_input_tokens ?? 0,
				cacheCreationTokens: data.usage.cache_creation_input_tokens ?? 0,
			}
			: undefined;

		return this._parseResponse(data.content, usage);
	}

	async *stream(
		messages: IAgentMessage[],
		tools?: IToolSchema[],
		temperature = 0,
		_topK?: number,  // Anthropic API has no top_k; ignored
	): AsyncIterableIterator<string> {
		const systemMessage = messages.find(m => m.role === MessageRole.System);
		const nonSystemMessages = messages.filter(m => m.role !== MessageRole.System);

		const body: Record<string, unknown> = {
			model: this._model,
			max_tokens: 4096,
			temperature,
			stream: true,
			messages: this._convertMessages(nonSystemMessages),
		};

		if (systemMessage) {
			body.system = systemMessage.content;
		}

		if (tools && tools.length > 0) {
			body.tools = tools.map(t => ({
				name: t.function.name,
				description: t.function.description,
				input_schema: t.function.parameters,
			}));
		}

		const response = await fetch(`${this._apiBase}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this._apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
		}

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith('data: ')) { continue; }
				const payload = trimmed.slice(6);

				try {
					const event = JSON.parse(payload);
					if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
						yield event.delta.text;
					}
				} catch {
					// skip
				}
			}
		}
	}

	countTokens(text: string): number {
		return estimateTokenCount(text);
	}

	private _parseResponse(content: AnthropicContentBlock[], usage?: ILlmUsage): IAgentMessage {
		let textContent = '';
		const toolCalls: IAgentMessage['toolCalls'] = [];

		for (const block of content) {
			if (block.type === 'text' && block.text) {
				textContent += block.text;
			} else if (block.type === 'tool_use' && block.id && block.name) {
				toolCalls!.push({
					id: block.id,
					name: block.name,
					arguments: block.input || {},
				});
			}
		}

		return createMessage(MessageRole.Assistant, textContent, {
			toolCalls: toolCalls!.length > 0 ? toolCalls : undefined,
			usage,
		});
	}

	private _convertMessages(messages: IAgentMessage[]): Array<Record<string, unknown>> {
		return messages.map(msg => {
			if (msg.role === MessageRole.Tool) {
				return {
					role: 'user',
					content: [{
						type: 'tool_result',
						tool_use_id: msg.toolCallId,
						content: msg.content,
					}],
				};
			}

			if (msg.role === MessageRole.Assistant && msg.toolCalls && msg.toolCalls.length > 0) {
				const content: AnthropicContentBlock[] = [];
				if (msg.content) {
					content.push({ type: 'text', text: msg.content });
				}
				for (const tc of msg.toolCalls) {
					content.push({
						type: 'tool_use',
						id: tc.id,
						name: tc.name,
						input: tc.arguments,
					});
				}
				return { role: 'assistant', content };
			}

			return {
				role: msg.role === MessageRole.User ? 'user' : 'assistant',
				content: msg.content,
			};
		});
	}
}

LLMProviderFactory.register('anthropic', AnthropicProvider);
