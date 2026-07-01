/*---------------------------------------------------------------------------------------------
 *  OpenAI LLM Provider - Chat Completions API with function calling + streaming
 *
 *  DeepSeek-compatible: supports reasoning_content, parallel tool calls,
 *  model-specific max tokens, rate limit recovery, and graceful error handling.
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

// Retry configuration for transient API errors
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000;
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// Maximum timeout for the API request itself (not tool execution)
const API_REQUEST_TIMEOUT_MS = 300000; // 5 minutes

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function shouldRetry(statusCode: number): boolean {
	return RETRYABLE_STATUS_CODES.has(statusCode);
}

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

/**
 * Check if a model is a reasoning/thinking model that returns reasoning_content.
 * These models require special handling for message ordering and streaming.
 *
 * IMPORTANT: deepseek-v4-flash is intentionally NOT listed here — it may occasionally
 * return reasoning_content but does not have a stable deep thinking mode.
 * deepseek-v4-pro has deep thinking enabled by default and explicitly via thinking param.
 */
function isReasoningModel(model: string): boolean {
	const lower = model.toLowerCase();
	// DeepSeek reasoner variants (deepseek-reasoner, deepseek-r1, etc.)
	if (lower.includes('reasoner') || lower.includes('deepseek-r')) return true;
	// DeepSeek v4-pro has deep thinking capabilities (explicitly enabled via thinking param)
	if (lower.includes('deepseek-v4-pro')) return true;
	// OpenAI o-series reasoning models
	if (lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return true;
	return false;
}

export class OpenAIProvider implements ILLMProvider {
	readonly name = 'openai';
	private readonly _apiKey: string;
	private readonly _apiBase: string;
	private readonly _model: string;
	private readonly _isReasoning: boolean;

	constructor(config: IAgentConfig) {
		this._apiKey = config.apiKey;
		this._apiBase = config.apiBase || 'https://api.openai.com/v1';
		this._model = config.model;
		this._isReasoning = isReasoningModel(config.model);
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
		tools: IToolSchema[] | undefined,
		temperature = 0,
		allowRetry: boolean,
	): Promise<IAgentMessage> {
		const body: Record<string, unknown> = {
			model: this._model,
			messages: this._convertMessages(messages),
			...this._temperatureParam(temperature),
		};

		// Reasoning models: enable deep thinking explicitly and set high max_tokens
		// for long chain-of-thought outputs (65536 = 8x default, allows deep reasoning)
		if (this._isReasoning) {
			body.thinking = { type: 'enabled' };
			body.max_tokens = 65536;
		}

		if (tools && tools.length > 0) {
			body.tools = tools;
			// DeepSeek and modern OpenAI models support parallel_tool_calls
			body.parallel_tool_calls = true;
		}

		const abortController = new AbortController();
		const apiTimeout = setTimeout(() => abortController.abort(), API_REQUEST_TIMEOUT_MS);

		let lastError: Error | undefined;
		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				const response = await fetch(`${this._apiBase}/chat/completions`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${this._apiKey}`,
					},
					body: JSON.stringify(body),
					signal: abortController.signal,
				});

				if (!response.ok) {
					const errorText = await response.text();

					// Special handling for temperature validation error
					if (allowRetry && response.status === 400 && this._isTemperatureError(errorText)) {
						this._skipTemperature = true;
						clearTimeout(apiTimeout);
						return this._doComplete(messages, tools, temperature, false);
					}

					// Graceful recovery from DeepSeek-specific transient errors
					if (this._isDeepSeekRecoverableError(response.status, errorText, attempt)) {
						const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
						console.warn(`[LLM Retry] Transient API error ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES}): ${errorText.substring(0, 200)}`);
						lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
						await sleep(delay);
						continue;
					}

					// Retry on transient errors (429, 5xx)
					if (shouldRetry(response.status) && attempt < MAX_RETRIES) {
						const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
						console.warn(`[LLM Retry] API error ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
						lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
						await sleep(delay);
						continue;
					}

					// Non-retryable error - throw immediately without retry
					clearTimeout(apiTimeout);
					throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
				}

				clearTimeout(apiTimeout);
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
			} catch (error) {
				const err = error as Error;

				// Handle abort (API request timeout)
				if (err.name === 'AbortError') {
					clearTimeout(apiTimeout);
					throw new Error(`OpenAI API request timed out after ${API_REQUEST_TIMEOUT_MS}ms`);
				}

				// Only retry on network errors (fetch failures), not API errors
				if (err.message?.includes('OpenAI API error')) {
					clearTimeout(apiTimeout);
					throw error; // Re-throw API errors immediately
				}

				// Handle JSON parse errors in tool_arguments gracefully (retry)
				if (err.message?.includes('JSON.parse') && attempt < MAX_RETRIES) {
					const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
					console.warn(`[LLM Retry] JSON parse error in tool arguments, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
					lastError = error as Error;
					await sleep(delay);
					continue;
				}

				// Network/fetch errors - retry
				if (attempt < MAX_RETRIES) {
					const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
					console.warn(`[LLM Retry] Network error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES}): ${error}`);
					lastError = error as Error;
					await sleep(delay);
					continue;
				}
				clearTimeout(apiTimeout);
				throw error;
			}
		}

		clearTimeout(apiTimeout);
		throw lastError || new Error('Max retries exceeded');
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

		if (this._isReasoning) {
			body.thinking = { type: 'enabled' };
			body.max_tokens = 65536;
		}

		if (tools && tools.length > 0) {
			body.tools = tools;
		}

		let response: Response | undefined;
		let lastError: Error | undefined;

		const abortController = new AbortController();
		const apiTimeout = setTimeout(() => abortController.abort(), API_REQUEST_TIMEOUT_MS);

		for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
			try {
				response = await fetch(`${this._apiBase}/chat/completions`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						'Authorization': `Bearer ${this._apiKey}`,
					},
					body: JSON.stringify(body),
					signal: abortController.signal,
				});

				if (!response.ok) {
					const errorText = await response.text();

					// Special handling for temperature validation error
					if (response.status === 400 && this._isTemperatureError(errorText) && !this._skipTemperature) {
						this._skipTemperature = true;
						const retryBody = { ...body, ...this._temperatureParam(temperature) };
						delete retryBody.temperature;
						clearTimeout(apiTimeout);
						response = await fetch(`${this._apiBase}/chat/completions`, {
							method: 'POST',
							headers: {
								'Content-Type': 'application/json',
								'Authorization': `Bearer ${this._apiKey}`,
							},
							body: JSON.stringify(retryBody),
						});

						if (!response.ok) {
							const retryErrorText = await response.text();
							throw new Error(`OpenAI API error ${response.status}: ${retryErrorText}`);
						}
						break;
					}

					// Graceful recovery from DeepSeek-specific transient errors
					if (this._isDeepSeekRecoverableError(response.status, errorText, attempt)) {
						const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
						console.warn(`[LLM Retry] Transient API error ${response.status}, retrying in ${delay}ms`);
						lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
						await sleep(delay);
						continue;
					}

					// Retry on transient errors (429, 5xx)
					if (shouldRetry(response.status) && attempt < MAX_RETRIES) {
						const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
						console.warn(`[LLM Retry] API error ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
						lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
						await sleep(delay);
						continue;
					}

					clearTimeout(apiTimeout);
					throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
				}

				break; // Success, exit retry loop
			} catch (error) {
				const err = error as Error;
				if (err.name === 'AbortError') {
					clearTimeout(apiTimeout);
					throw new Error(`OpenAI API request timed out after ${API_REQUEST_TIMEOUT_MS}ms`);
				}
				// Only retry on network errors (fetch failures), not API errors
				if (err.message?.includes('OpenAI API error')) {
					clearTimeout(apiTimeout);
					throw error;
				}

				// Network/fetch errors - retry
				if (attempt < MAX_RETRIES) {
					const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
					console.warn(`[LLM Retry] Network error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES}): ${error}`);
					lastError = error as Error;
					await sleep(delay);
					continue;
				}
				clearTimeout(apiTimeout);
				throw error;
			}
		}

		clearTimeout(apiTimeout);

		if (!response || !response.ok) {
			throw lastError || new Error('Max retries exceeded');
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

	/**
	 * Check if a DeepSeek API error is recoverable (can retry).
	 * Some errors like "insufficient_quota" or "model overloaded" may be transient.
	 * DeepSeek V4 Pro specific: handles TPS (tokens per second) rate limiting
	 * and model overload errors gracefully.
	 */
	private _isDeepSeekRecoverableError(status: number, errorText: string, attempt: number): boolean {
		if (shouldRetry(status)) return true;
		if (status === 400) {
			const lower = errorText.toLowerCase();
			// DeepSeek-specific transient errors
			if (lower.includes('insufficient_quota') && attempt < 2) return true;
			if (lower.includes('rate_limit') && attempt < 3) return true;
			if (lower.includes('temporarily') && attempt < 1) return true;
			// TPS (tokens per second) rate limiting
			if (lower.includes('tps') && lower.includes('limit') && attempt < 3) return true;
			// Model overload / busy
			if (lower.includes('overload') && attempt < 2) return true;
			if (lower.includes('busy') && attempt < 2) return true;
			// Concurrent request limit
			if (lower.includes('concurrent') && attempt < 2) return true;
		}
		// 503 Service Unavailable (model loading / overloaded)
		if (status === 503 && attempt < MAX_RETRIES) return true;
		// 502 Bad Gateway (upstream issues)
		if (status === 502 && attempt < 2) return true;
		return false;
	}

	supportsStreaming(): boolean {
		// All models support streaming at the API level.
		// The agent loop handles reasoning_content compatibility separately.
		return true;
	}

	/**
	 * Does this model use reasoning_content (thinking/chain-of-thought)?
	 */
	supportsReasoning(): boolean {
		return this._isReasoning;
	}

	private _convertMessages(messages: IAgentMessage[]): OpenAIChatMessage[] {
		// Reasoning model message handling:
		// DeepSeek reasoner models require that if any assistant message contains
		// reasoning_content, ALL assistant messages in the context must also have it.
		// We filter out assistant messages without reasoning_content only in this case.
		const hasThinking = messages.some(m =>
			m.role === MessageRole.Assistant && m.reasoningContent
		);

		// In thinking mode, filter assistant messages that have neither reasoning_content
		// nor tool_calls, to maintain API consistency.
		let filtered = messages;
		if (hasThinking) {
			filtered = messages.filter(m => {
				if (m.role === MessageRole.Assistant) {
					return !!m.reasoningContent || (m.toolCalls && m.toolCalls.length > 0);
				}
				return true;
			});

			// After filtering, ensure no orphaned tool result messages remain
			// (tool messages without a preceding assistant message with tool_calls)
			while (filtered.length > 0 && filtered[0].role === MessageRole.Tool) {
				filtered.shift();
			}
		}

		return filtered.map(msg => {
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

			// In thinking mode, ALL assistant messages must have reasoning_content field
			// If the original message had it, use it; otherwise use empty string
			if (msg.role === MessageRole.Assistant && hasThinking) {
				converted.reasoning_content = msg.reasoningContent || '';
			}

			return converted;
		});
	}
}

LLMProviderFactory.register('openai', OpenAIProvider);