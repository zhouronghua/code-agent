/*---------------------------------------------------------------------------------------------
 *  OpenAI LLM Provider - Chat Completions API with function calling + streaming
 *
 *  DeepSeek-compatible: supports reasoning_content, parallel tool calls,
 *  model-specific max tokens, rate limit recovery, and graceful error handling.
 *--------------------------------------------------------------------------------------------*/

import { ILLMProvider, LLMProviderFactory, ContextOverflowError, estimateTokenCount, TOKENS_PER_MESSAGE_OVERHEAD } from './llmProvider';
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

/**
 * Minimum completion budget a request is allowed to use. When the clamp leaves
 * less than this, the window is effectively full — fail fast with a
 * ContextOverflowError so the agent loop compacts history instead of sending a
 * useless near-zero-token request that wastes a round trip.
 */
const MIN_COMPLETION_TOKENS = 2048;

/** Fraction of the context window reserved as a hard safety margin in max_tokens clamps. */
const CONTEXT_RESERVE_RATIO = 0.05;

/**
 * Completion budget used by the reachability probe. Must stay above the
 * gateway's accepted floor: the GPT-5.x family rejects max_tokens: 1 with a 400,
 * which would make a healthy model look unreachable and block the switch-back.
 */
const HEALTH_CHECK_MAX_TOKENS = 8;

/** Minimum safety reserve (never let a tiny model's whole window become reserve). */
const MIN_CONTEXT_RESERVE = 1024;

/**
 * The smallest completion budget this model is allowed to use. For models whose
 * maxOutputTokens is already below MIN_COMPLETION_TOKENS, the floor is the
 * model's own output budget (otherwise a small model would always trip the
 * "window nearly full" guard).
 */
function minCompletionFloor(maxOutputTokens: number): number {
	return Math.min(MIN_COMPLETION_TOKENS, maxOutputTokens);
}

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
	// Tencent Hunyuan 3 (hy3) is a hybrid-thinking model that always returns
	// reasoning_content and accepts {"thinking":{"type":"enabled"}}.
	if (lower === 'hy3' || lower.startsWith('hy3-') || lower.includes('hunyuan')) return true;
	// OpenAI o-series reasoning models
	if (lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return true;
	return false;
}

/**
 * Does this HTTP 400 come from the thinking-mode echo-back rule?
 *
 * Verified on api.enflame.cn (deepseek-flash / deepseek-v4-pro):
 *   {"error":{"message":"The `reasoning_content` in the thinking mode must be
 *    passed back to the API.","type":"invalid_request_error"}}
 * It is raised when ANY assistant message in the request lacks the
 * `reasoning_content` field while the model answers in thinking mode.
 */
function isReasoningEchoError(errorText: string): boolean {
	return errorText.includes('reasoning_content') && errorText.includes('must be passed back');
}

export class OpenAIProvider implements ILLMProvider {
	readonly name = 'openai';
	private readonly _apiKey: string;
	private readonly _apiBase: string;
	private readonly _model: string;
	private readonly _isReasoning: boolean;
	private readonly _maxOutputTokens: number;
	private readonly _maxContextTokens: number;

	/**
	 * Set as soon as this model has actually answered with `reasoning_content`.
	 *
	 * A gateway can run a model in thinking mode without announcing it: on
	 * api.enflame.cn, `deepseek-flash` is declared `supportsReasoning: false`, no
	 * `thinking` param is sent, yet every answer carries reasoning_content — and
	 * any request that omits it is rejected with HTTP 400 ("The
	 * `reasoning_content` in the thinking mode must be passed back to the API").
	 * Trusting the observed behaviour instead of the model id is what keeps a
	 * session alive after a 保底-model switch dropped the chain-of-thought.
	 */
	private _sawReasoning = false;

	/**
	 * Set when the API explicitly demanded the reasoning_content echo-back
	 * (see `_doComplete`). Covers a model that has not answered yet in this
	 * process — e.g. a fresh run resuming a session whose reasoning_content was
	 * stripped, or a model this provider has never talked to.
	 */
	private _requiresReasoningEcho = false;

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
		topK?: number,
	): Promise<IAgentMessage> {
		return this._doComplete(messages, tools, temperature, topK, true);
	}

	private async _doComplete(
		messages: IAgentMessage[],
		tools: IToolSchema[] | undefined,
		temperature = 0,
		topK: number | undefined,
		allowRetry: boolean,
	): Promise<IAgentMessage> {
		const body: Record<string, unknown> = {
			model: this._model,
			messages: this._convertMessages(messages),
			...this._samplingParams(temperature, topK),
		};

		// Always send an explicit, context-aware max_tokens so the request can
		// never exceed the model's context window (input + completion <= context).
		// Prevents "maximum context length" API errors when maxOutputTokens is
		// larger than the remaining budget.
		const clampedMaxTokens = this._clampMaxTokens(messages, tools);
		// If the completion budget is crushed to near zero the window is already
		// effectively full — fail fast with ContextOverflowError so the agent
		// loop compacts history instead of sending a useless near-empty request.
		if (clampedMaxTokens < minCompletionFloor(this._maxOutputTokens)) {
			throw new ContextOverflowError(
				`Context window nearly full: estimated input leaves only ${clampedMaxTokens} tokens for completion (minimum ${minCompletionFloor(this._maxOutputTokens)}). Conversation history must be compacted.`
			);
		}
		body.max_tokens = clampedMaxTokens;

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
						return this._doComplete(messages, tools, temperature, topK, false);
					}

					// "maximum context length" — input + max_tokens exceeds the model window.
					// Retry with a progressively smaller completion budget (covers the near-miss
					// case where input alone fits but input + maxOutputTokens doesn't). If the
					// budget is already minimal, escalate to ContextOverflowError so the agent
					// loop compacts the history and retries with a smaller window.
					if (response.status === 400 && this._isContextOverflowError(errorText)) {
						const currentMaxTokens = body.max_tokens as number;
						if (attempt < MAX_RETRIES && currentMaxTokens > MIN_COMPLETION_TOKENS) {
							const reduced = Math.max(MIN_COMPLETION_TOKENS, Math.floor(currentMaxTokens / 4));
							body.max_tokens = reduced;
							const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
							console.warn(`[LLM Retry] Context overflow — reducing max_tokens ${currentMaxTokens} -> ${reduced} (attempt ${attempt + 1}/${MAX_RETRIES})`);
							lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
							await sleepWithProgress(delay, 'Retry backoff');
							continue;
						}
						clearTimeout(apiTimeout);
						throw new ContextOverflowError(`Model context window exceeded: ${errorText}`);
					}

					// ---- Thinking-mode echo-back repair (保底 switch / resumed session) ----
					// A thinking-mode model rejects the request when ANY assistant message lacks
					// reasoning_content — including a history that legitimately has none (the 保底
					// model owned the last turns, or the chain-of-thought was dropped when the model
					// was switched). Restore the field once, then let this provider remember that the
					// model answers in thinking mode.
					if (allowRetry && response.status === 400 && !this._requiresReasoningEcho && isReasoningEchoError(errorText)) {
						this._requiresReasoningEcho = true;
						clearTimeout(apiTimeout);
						console.warn(
							`[LLM] ${this._model} answers in thinking mode — resending the request with ` +
							`reasoning_content echoed back on every assistant message`
						);
						return this._doComplete(messages, tools, temperature, topK, false);
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

				// Remember that this model answers in thinking mode so every later
				// request echoes reasoning_content back (see _convertMessages).
				if (msg.reasoning_content) this._sawReasoning = true;

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
		topK?: number,
	): AsyncIterableIterator<string> {
		const body: Record<string, unknown> = {
			model: this._model,
			messages: this._convertMessages(messages),
			...this._samplingParams(temperature, topK),
			stream: true,
		};

		// Same context-aware max_tokens clamp as complete(): input + max_tokens
		// must never exceed the model's context window. Fail fast when the window
		// is effectively full so the agent loop can compact and retry.
		const clampedMaxTokens = this._clampMaxTokens(messages, tools);
		if (clampedMaxTokens < minCompletionFloor(this._maxOutputTokens)) {
			throw new ContextOverflowError(
				`Context window nearly full: estimated input leaves only ${clampedMaxTokens} tokens for completion (minimum ${minCompletionFloor(this._maxOutputTokens)}). Conversation history must be compacted.`
			);
		}
		body.max_tokens = clampedMaxTokens;

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
						const retryBody = { ...body, ...this._samplingParams(temperature, topK) };
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

					// "maximum context length" — reduce the completion budget and retry,
					// then escalate to ContextOverflowError so the agent loop compacts.
					if (response.status === 400 && this._isContextOverflowError(errorText)) {
						const currentMaxTokens = body.max_tokens as number;
						if (attempt < MAX_RETRIES && currentMaxTokens > MIN_COMPLETION_TOKENS) {
							const reduced = Math.max(MIN_COMPLETION_TOKENS, Math.floor(currentMaxTokens / 4));
							body.max_tokens = reduced;
							const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
							console.warn(`[LLM Retry] Context overflow — reducing max_tokens ${currentMaxTokens} -> ${reduced} (attempt ${attempt + 1}/${MAX_RETRIES})`);
							lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
							await sleepWithProgress(delay, 'Retry backoff');
							continue;
						}
						clearTimeout(apiTimeout);
						throw new ContextOverflowError(`Model context window exceeded: ${errorText}`);
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
		// Conservative, CJK-aware estimate shared by all providers. The old
		// chars/4 rule undercounts mixed code + reasoning_content by ~1.6x,
		// which defeats the context-budget guardrails (see estimateTokenCount).
		return estimateTokenCount(text);
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
			// JSON message framing (role, id, timestamp, tool_call_id, keys)
			total += TOKENS_PER_MESSAGE_OVERHEAD;
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
	 * (e.g. deepseek-v4's 65536) combined with a near-full message window
	 * produces "This model's maximum context length is X tokens..." API errors.
	 *
	 * A hard safety reserve (5% of the window, min 4096) is kept on top of the
	 * estimate so a slightly-off estimate can never fill the window completely.
	 */
	private _clampMaxTokens(messages: IAgentMessage[], tools?: IToolSchema[]): number {
		const inputTokens = this._estimateInputTokens(messages, tools);
		// Hard safety reserve (5% of the window, min 1024) kept on top of the
		// estimate so a slightly-off estimate can never fill the window completely.
		const safetyReserve = Math.max(MIN_CONTEXT_RESERVE, Math.floor(this._maxContextTokens * CONTEXT_RESERVE_RATIO));
		const remaining = this._maxContextTokens - inputTokens - safetyReserve;
		return Math.max(1, Math.min(this._maxOutputTokens, remaining));
	}

	/**
	 * Detect "This model's maximum context length is X tokens..." API errors.
	 * These are NOT retryable as-is: the request must shrink (smaller max_tokens
	 * or a compacted message window) before it can succeed.
	 */
	private _isContextOverflowError(text: string): boolean {
		const lower = text.toLowerCase();
		return lower.includes('maximum context length')
			|| lower.includes('reduce the length of the messages')
			|| (lower.includes('context') && lower.includes('exceed'));
	}

	private _skipTemperature = false;

	/**
	 * Build the sampling params for the request body. `temperature` is always
	 * sent (unless a previous request was rejected for it — see _skipTemperature);
	 * `top_k` is only sent when explicitly configured (>0) so providers that do
	 * not support it keep working with their default sampling.
	 */
	private _samplingParams(temperature: number, topK?: number): Record<string, number> {
		const params: Record<string, number> = {};
		if (!this._skipTemperature) {
			params.temperature = temperature;
		}
		if (topK && topK > 0) {
			params.top_k = topK;
		}
		return params;
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
	 *
	 * True when the model id looks like a reasoning model OR the API has shown
	 * that it answers in thinking mode (it produced reasoning_content, or it
	 * demanded the echo-back). The agent uses this to keep one model's
	 * chain-of-thought out of another model, to avoid streaming (which loses
	 * reasoning_content), and to decide whether a model switch has to preserve
	 * the reasoning echo-back invariant.
	 */
	supportsReasoning(): boolean {
		return this._isReasoning || this._sawReasoning || this._requiresReasoningEcho;
	}

	/**
	 * Minimal reachability probe for the 保底-model supervisor: one tiny
	 * completion with its own short timeout (tens of times cheaper and faster
	 * than a real turn, and unlike a `GET /models` call it exercises the exact
	 * chat endpoint that timed out). Never throws.
	 *
	 * Evidence (api.enflame.cn gateway, measured):
	 *   - max_tokens: 1   → 400 "max_tokens ... limit was reached" for the GPT-5.x
	 *     family, i.e. a FALSE "unreachable". 4 is the smallest accepted value.
	 *   - unknown model   → 503 model_not_found (genuinely unreachable).
	 *   - reachable model → 200.
	 * So: any answer from the model server counts as reachable (2xx/400/429 —
	 * a rejected or throttled probe still proves the model is back), while 5xx,
	 * auth failures and timeouts count as unreachable.
	 */
	async healthCheck(timeoutMs = 8000): Promise<boolean> {
		if (!this._apiKey) return false;
		const abortController = new AbortController();
		const timer = setTimeout(() => abortController.abort(), timeoutMs);
		try {
			const response = await fetch(`${this._apiBase}/chat/completions`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${this._apiKey}`,
				},
				body: JSON.stringify({
					model: this._model,
					messages: [{ role: 'user', content: 'ping' }],
					max_tokens: HEALTH_CHECK_MAX_TOKENS,
					stream: false,
				}),
				signal: abortController.signal,
			});
			if (response.ok) return true;
			// 400 = the model answered but disliked the probe (e.g. a stricter
			// max_tokens floor); 429 = reachable but throttled. Both mean the model
			// is back. 401/403/404/5xx mean we must stay on the 保底 model.
			return response.status === 400 || response.status === 429;
		} catch {
			return false;
		} finally {
			clearTimeout(timer);
		}
	}

	private _convertMessages(messages: IAgentMessage[]): OpenAIChatMessage[] {
		// Thinking-mode API contract (verified on the api.enflame.cn gateway):
		// once a model answers in thinking mode, EVERY assistant message in the
		// request must carry a `reasoning_content` field — an EMPTY string is
		// accepted, a missing field is a hard 400 ("The `reasoning_content` in the
		// thinking mode must be passed back to the API"). It is all-or-nothing:
		// filling only the last assistant message still fails.
		//
		// The gate therefore cannot be "does THIS history contain reasoning?".
		// After a 保底-model swap the chain-of-thought may have been dropped (or
		// the last turns were produced by a non-thinking fallback model), yet the
		// next request goes back to a thinking model and must restore the field.
		// Verified failure: deepseek-flash → 保底 gpt-5.6-luna → recovered
		// deepseek-flash, whose request already carried a tool result, failed with
		// exactly that 400 and killed the task.
		const historyHasThinking = messages.some(m =>
			m.role === MessageRole.Assistant && m.reasoningContent
		);
		const thinkingMode = historyHasThinking || this.supportsReasoning();

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
		if (thinkingMode) {
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
			if (msg.role === MessageRole.Assistant && thinkingMode) {
				converted.reasoning_content = msg.reasoningContent || '';
			}

			return converted;
		});
	}
}

LLMProviderFactory.register('openai', OpenAIProvider);