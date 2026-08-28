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

/**
 * Sleep with a live progress indicator showing elapsed and remaining time.
 * Used during API retry backoff so the user isn't left wondering what's happening.
 */
function sleepWithProgress(ms: number, label: string): Promise<void> {
	const totalSec = Math.ceil(ms / 1000);
	const start = Date.now();

	return new Promise(resolve => {
		let lastUpdate = 0;
		const timer = setInterval(() => {
			const elapsed = Math.floor((Date.now() - start) / 1000);
			if (elapsed !== lastUpdate) {
				lastUpdate = elapsed;
				const remaining = Math.max(0, totalSec - elapsed);
				process.stdout.write(`\r  ⏳ ${label} — waited ${elapsed}s, ${remaining}s remaining...`);
			}
		}, 250);

		setTimeout(() => {
			clearInterval(timer);
			process.stdout.write(`\r  ✅ ${label} — done after ${totalSec}s    \n`);
			resolve();
		}, ms);
	});
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
	private readonly _maxOutputTokens: number;
	private readonly _maxContextTokens: number;

	constructor(config: IAgentConfig) {
		this._apiKey = config.apiKey;
		this._apiBase = config.apiBase || 'https://api.openai.com/v1';
		this._model = config.model;
		this._isReasoning = isReasoningModel(config.model);
		this._maxOutputTokens = config.maxOutputTokens || 65536;
		// maxContextTokens is the model's TOTAL context window (input + output
		// are drawn from the same pool, e.g. deepseek-v4 = 1048576 tokens).
		this._maxContextTokens = config.maxContextTokens || this._maxOutputTokens * 4;
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

		// Always send an explicit, context-aware max_tokens so the request can
		// never exceed the model's context window (input + completion <= context).
		// Prevents "maximum context length" API errors when maxOutputTokens is
		// larger than the remaining budget.
		body.max_tokens = this._clampMaxTokens(messages, tools);

		// Reasoning models: enable deep thinking explicitly and allow long
		// chain-of-thought outputs (budget is clamped to remaining context above).
		if (this._isReasoning) {
			body.thinking = { type: 'enabled' };
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
						console.warn(`[LLM Retry] Transient API error ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES})`);
						lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
						await sleepWithProgress(delay, 'Retry backoff');
						continue;
					}

					// Retry on transient errors (429, 5xx)
					if (shouldRetry(response.status) && attempt < MAX_RETRIES) {
						const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
						console.warn(`[LLM Retry] API error ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES})`);
						lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
						await sleepWithProgress(delay, 'Retry backoff');
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

				// Normalize provider token usage (OpenAI-compatible format).
				// DeepSeek/OpenAI report: usage.prompt_tokens / completion_tokens /
				// total_tokens, plus prompt_tokens_details.cached_tokens for cache hits.
				const usage = data.usage && typeof data.usage === 'object'
					? {
						promptTokens: data.usage.prompt_tokens ?? 0,
						completionTokens: data.usage.completion_tokens ?? 0,
						totalTokens: data.usage.total_tokens ?? ((data.usage.prompt_tokens ?? 0) + (data.usage.completion_tokens ?? 0)),
						cachedTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0,
					}
					: undefined;

				return createMessage(
					MessageRole.Assistant,
					msg.content || '',
					{ toolCalls, reasoningContent: msg.reasoning_content, usage },
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
					console.warn(`[LLM Retry] JSON parse error (attempt ${attempt + 1}/${MAX_RETRIES})`);
					lastError = error as Error;
					await sleepWithProgress(delay, 'Retry backoff');
					continue;
				}

				// Network/fetch errors - retry
				if (attempt < MAX_RETRIES) {
					const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
					console.warn(`[LLM Retry] Network error (attempt ${attempt + 1}/${MAX_RETRIES})`);
					lastError = error as Error;
					await sleepWithProgress(delay, 'Retry backoff');
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

		// Same context-aware max_tokens clamp as complete(): input + max_tokens
		// must never exceed the model's context window.
		body.max_tokens = this._clampMaxTokens(messages, tools);

		if (this._isReasoning) {
			body.thinking = { type: 'enabled' };
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
						console.warn(`[LLM Retry] Transient API error ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES})`);
						lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
						await sleepWithProgress(delay, 'Retry backoff');
						continue;
					}

					// Retry on transient errors (429, 5xx)
					if (shouldRetry(response.status) && attempt < MAX_RETRIES) {
						const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
						console.warn(`[LLM Retry] API error ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES})`);
						lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
						await sleepWithProgress(delay, 'Retry backoff');
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
					console.warn(`[LLM Retry] Network error (attempt ${attempt + 1}/${MAX_RETRIES})`);
					lastError = error as Error;
					await sleepWithProgress(delay, 'Retry backoff');
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

	/**
	 * Estimate the number of input tokens that will be sent to the API.
	 * Uses the same char-based heuristic as countTokens() plus a safety margin
	 * for message framing, tool schemas, and CJK text (which char-count
	 * heuristics tend to underestimate).
	 */
	private _estimateInputTokens(messages: IAgentMessage[], tools?: IToolSchema[]): number {
		let total = 0;
		for (const msg of messages) {
			total += this.countTokens(msg.content);
			if (msg.reasoningContent) {
				total += this.countTokens(msg.reasoningContent);
			}
		}
		if (tools) {
			for (const tool of tools) {
				total += this.countTokens(JSON.stringify(tool.function));
			}
		}
		// ~20% estimation safety margin + fixed framing overhead
		return Math.ceil(total * 1.2) + 512;
	}

	/**
	 * Clamp the completion token budget so that input + max_tokens never exceeds
	 * the model's total context window. Without this, a large maxOutputTokens
	 * (e.g. deepseek-v4's 393216) combined with a near-full message window
	 * produces "This model's maximum context length is X tokens..." API errors.
	 */
	private _clampMaxTokens(messages: IAgentMessage[], tools?: IToolSchema[]): number {
		const inputTokens = this._estimateInputTokens(messages, tools);
		const remaining = this._maxContextTokens - inputTokens;
		return Math.max(1, Math.min(this._maxOutputTokens, remaining));
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

		// OpenAI API requires every assistant message to have EITHER non-null content
		// OR non-empty tool_calls. Messages with only reasoning_content (thinking-only)
		// violate this constraint and must be filtered out.
		// This IS an assistant message validity helper.
		const isValidAssistant = (m: IAgentMessage): boolean => {
			if (m.role !== MessageRole.Assistant) return true; // non-assistant: always valid
			// Must have content or tool_calls (reasoning_content alone is not enough!)
			return !!m.content || (!!m.toolCalls && m.toolCalls.length > 0);
		};

		let filtered = messages.filter(isValidAssistant);

		// In thinking mode: additional filtering — all remaining assistant messages
		// must have reasoning_content for API consistency.
		// BUT: messages with tool_calls MUST be preserved even without reasoning_content,
		// otherwise their tool result messages become orphaned and cause 400 errors.
		if (hasThinking) {
			filtered = filtered.filter(m => {
				if (m.role === MessageRole.Assistant) {
					return !!m.reasoningContent || (!!m.toolCalls && m.toolCalls.length > 0);
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