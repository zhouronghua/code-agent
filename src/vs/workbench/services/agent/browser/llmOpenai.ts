/*---------------------------------------------------------------------------------------------
 *  OpenAI LLM Provider - Chat Completions API with function calling + streaming
 *--------------------------------------------------------------------------------------------*/

import { ILLMProvider, LLMProviderFactory } from './llmProvider';
import {
	IAgentConfig,
	IAgentMessage,
	IToolSchema,
	MessageRole,
	createMessage,
	generateId,
} from '../common/agentModels';

interface OpenAIChatMessage {
	role: string;
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
	reasoning_content?: string;
}

export class OpenAIProvider implements ILLMProvider {
	readonly name = 'openai';
	private readonly _apiKey: string;
	private readonly _apiBase: string;
	private readonly _model: string;

	constructor(config: IAgentConfig) {
		this._apiKey = config.apiKey;
		this._apiBase = config.apiBase || 'https://api.openai.com/v1';
		this._model = config.model;
	}

	async complete(
		messages: IAgentMessage[],
		tools?: IToolSchema[],
		temperature = 0,
	): Promise<IAgentMessage> {
		return this._doComplete(messages, tools, temperature, true);
	}

	private async _doComplete(
		messages: IAgentMessage[],
		tools?: IToolSchema[],
		temperature: number,
		allowRetry: boolean,
	): Promise<IAgentMessage> {
		const body: Record<string, unknown> = {
			model: this._model,
			messages: this._convertMessages(messages),
			...this._temperatureParam(temperature),
		};

		if (tools && tools.length > 0) {
			body.tools = tools;
		}

		const response = await fetch(`${this._apiBase}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this._apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text();
			if (allowRetry && response.status === 400 && this._isTemperatureError(errorText)) {
				this._skipTemperature = true;
				return this._doComplete(messages, tools, temperature, false);
			}
			throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
		}

		const data = await response.json();
		const choice = data.choices[0];
		const msg = choice.message;

		const toolCalls = msg.tool_calls?.map((tc: OpenAIChatMessage['tool_calls'] extends (infer T)[] | undefined ? T : never) => ({
			id: tc.id,
			name: tc.function.name,
			arguments: JSON.parse(tc.function.arguments),
		}));

		return createMessage(
			MessageRole.Assistant,
			msg.content || '',
			{ toolCalls, reasoningContent: msg.reasoning_content },
		);
	}

	async *stream(
		messages: IAgentMessage[],
		tools?: IToolSchema[],
		temperature = 0,
	): AsyncIterableIterator<string> {
		const body: Record<string, unknown> = {
			model: this._model,
			messages: this._convertMessages(messages),
			...this._temperatureParam(temperature),
			stream: true,
		};

		if (tools && tools.length > 0) {
			body.tools = tools;
		}

		let response = await fetch(`${this._apiBase}/chat/completions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${this._apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok && response.status === 400) {
			const errorText = await response.text();
			if (this._isTemperatureError(errorText) && !this._skipTemperature) {
				this._skipTemperature = true;
				const retryBody = { ...body, ...this._temperatureParam(temperature) };
				delete retryBody.temperature;
				response = await fetch(`${this._apiBase}/chat/completions`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${this._apiKey}`,
					},
					body: JSON.stringify(retryBody),
				});
			} else {
				throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
			}
		}

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
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
				if (!trimmed || !trimmed.startsWith('data: ')) { continue; }
				const payload = trimmed.slice(6);
				if (payload === '[DONE]') { return; }

				try {
					const parsed = JSON.parse(payload);
					const delta = parsed.choices?.[0]?.delta;
					if (delta?.content) {
						yield delta.content;
					}
				} catch {
					// skip malformed chunks
				}
			}
		}
	}

	countTokens(text: string): number {
		// cl100k_base approximation: ~4 chars per token
		return Math.ceil(text.length / 4);
	}

	private _skipTemperature = false;

	private _temperatureParam(temperature: number): Record<string, number> {
		if (this._skipTemperature) return {};
		return { temperature };
	}

	private _isTemperatureError(text: string): boolean {
		const lower = text.toLowerCase();
		return lower.includes('temperature') && (
			lower.includes('invalid') ||
			lower.includes('not allowed') ||
			lower.includes('only 1 is allowed') ||
			lower.includes('not supported')
		);
	}

	private _convertMessages(messages: IAgentMessage[]): OpenAIChatMessage[] {
		// Check if any message has reasoning_content (thinking mode)
		const hasThinking = messages.some(m =>
			m.role === MessageRole.Assistant && m.reasoningContent
		);

		return messages
			.filter(msg => {
				// In thinking mode, filter out assistant messages without reasoning_content
				// Keep messages with tool_calls (function calling responses are exempt)
				if (hasThinking && msg.role === MessageRole.Assistant) {
					if (!msg.reasoningContent) {
						// Allow if it has tool calls (function calling response)
						if (!msg.toolCalls || msg.toolCalls.length === 0) {
							return false;
						}
					}
				}
				return true;
			})
			.map(msg => {
				const converted: OpenAIChatMessage = {
					role: msg.role,
					content: msg.content || null,
				};

				if (msg.toolCalls && msg.toolCalls.length > 0) {
					converted.tool_calls = msg.toolCalls.map(tc => ({
						id: tc.id,
						type: 'function' as const,
						function: {
							name: tc.name,
							arguments: JSON.stringify(tc.arguments),
						},
					}));
				}

				if (msg.toolCallId) {
					converted.tool_call_id = msg.toolCallId;
				}

				if (msg.reasoningContent) {
					converted.reasoning_content = msg.reasoningContent;
				}

				return converted;
			});
	}
}

LLMProviderFactory.register('openai', OpenAIProvider);
