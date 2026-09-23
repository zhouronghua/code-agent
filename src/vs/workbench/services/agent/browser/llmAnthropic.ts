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

/** A raw Anthropic request/message content block (cache_control lives here). */
type AnthropicRequestBlock = Record<string, unknown>;

/**
 * Prompt caching — borrowed from meta-harness's `anthropic_caching.py`.
 *
 * The harness re-sends the same prefix on every ReAct turn: the system prompt
 * and the growing conversation. Anthropic bills that repeated prefix at full
 * price unless it is marked with a `cache_control` breakpoint, which turns the
 * re-send into a cache READ (~10% of input price) and also cuts time-to-first
 * token. Two placement rules matter:
 *
 *  - the SYSTEM prompt is the most stable prefix of all → always cache it;
 *  - the conversation grows at the tail, so the newest messages are marked too,
 *    which extends the cached prefix turn by turn.
 *
 * Anthropic allows at most 4 breakpoints per request, so system + the last
 * CACHE_TAIL_MESSAGES stays well under the limit.
 */
const CACHE_TAIL_MESSAGES = 2;
/** Anthropic's hard limit on `cache_control` breakpoints per request. */
const MAX_CACHE_BREAKPOINTS = 4;

function cacheControl(): { type: 'ephemeral' } {
	return { type: 'ephemeral' };
}

/** The system prompt as one cacheable content block. */
export function systemBlocksForCaching(content: string): AnthropicRequestBlock[] {
	return [{ type: 'text', text: content, cache_control: cacheControl() }];
}

/**
 * Mark the END of a message as the end of a cacheable prefix (mutates it).
 * Returns true when a breakpoint was actually placed.
 */
export function markCacheBreakpoint(message: Record<string, unknown>): boolean {
	const content = message.content;
	if (typeof content === 'string') {
		if (!content) return false;
		message.content = [{ type: 'text', text: content, cache_control: cacheControl() }];
		return true;
	}
	if (Array.isArray(content) && content.length > 0) {
		const last = content[content.length - 1] as Record<string, unknown> | undefined;
		if (last && typeof last === 'object' && !last.cache_control) {
			last.cache_control = cacheControl();
			return true;
		}
	}
	return false;
}

export class AnthropicProvider implements ILLMProvider {
	readonly name = 'anthropic';
	private readonly _apiKey: string;
	private readonly _apiBase: string;
	private readonly _model: string;
	/**
	 * Set once the endpoint rejected a cache_control breakpoint (e.g. a gateway
	 * proxy that does not implement the prompt-caching extension). Caching is an
	 * optimization, never a requirement, so after the first rejection every
	 * later request is sent with no breakpoints.
	 */
	private _cachingDisabled = false;
	private _cachingDisabledReason: string | undefined;

	constructor(config: IAgentConfig) {
		this._apiKey = config.apiKey;
		this._apiBase = config.apiBase || 'https://api.anthropic.com';
		this._model = config.model || 'claude-sonnet-4-20250514';
	}

	/** True when prompt caching was rejected by this endpoint and switched off. */
	get promptCachingDisabled(): boolean {
		return this._cachingDisabled;
	}

	/** Why caching was switched off (kept for logs/diagnostics). */
	get promptCachingDisabledReason(): string | undefined {
		return this._cachingDisabledReason;
	}

	/** Build the request payload. `cache` toggles the prompt-caching breakpoints. */
	private _buildBody(
		options: {
			messages: IAgentMessage[];
			systemMessage?: IAgentMessage;
			tools?: IToolSchema[];
			temperature: number;
			stream?: boolean;
		},
		cache: boolean,
	): Record<string, unknown> {
		const { messages, systemMessage, tools, temperature, stream } = options;
		const body: Record<string, unknown> = {
			model: this._model,
			max_tokens: 4096,
			temperature,
			messages: this._convertMessages(messages, cache),
		};

		if (systemMessage) {
			body.system = cache
				? systemBlocksForCaching(systemMessage.content)
				: systemMessage.content;
		}

		if (tools && tools.length > 0) {
			body.tools = tools.map(t => ({
				name: t.function.name,
				description: t.function.description,
				input_schema: t.function.parameters,
			}));
		}

		if (stream) body.stream = true;
		return body;
	}

	/**
	 * Send one /v1/messages request, degrading transparently to a cache-free
	 * payload when the endpoint rejects the cache breakpoints.
	 */
	private async _request(
		build: (cache: boolean) => Record<string, unknown>,
		useCache: boolean,
	): Promise<Response> {
		const send = (cache: boolean) => fetch(`${this._apiBase}/v1/messages`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-api-key': this._apiKey,
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify(build(cache)),
		});

		const response = await send(useCache);
		if (response.ok) return response;

		const errorText = await response.text();
		if (useCache && response.status === 400 && /cache_control|cache-control/i.test(errorText)) {
			this._cachingDisabled = true;
			this._cachingDisabledReason = errorText.slice(0, 300);
			console.warn(
				`[Anthropic] endpoint rejected prompt caching (400) — retrying without ` +
				`cache breakpoints: ${errorText.slice(0, 200)}`
			);
			const retry = await send(false);
			if (retry.ok) return retry;
			throw new Error(`Anthropic API error ${retry.status}: ${await retry.text()}`);
		}
		throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
	}

	async complete(
		messages: IAgentMessage[],
		tools?: IToolSchema[],
		temperature = 0,
		_topK?: number,  // Anthropic API has no top_k; ignored
	): Promise<IAgentMessage> {
		const systemMessage = messages.find(m => m.role === MessageRole.System);
		const nonSystemMessages = messages.filter(m => m.role !== MessageRole.System);

		const response = await this._request(
			cache => this._buildBody(
				{ messages: nonSystemMessages, systemMessage, tools, temperature },
				cache,
			),
			!this._cachingDisabled,
		);

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

		const response = await this._request(
			cache => this._buildBody(
				{ messages: nonSystemMessages, systemMessage, tools, temperature, stream: true },
				cache,
			),
			!this._cachingDisabled,
		);

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

	private _convertMessages(
		messages: IAgentMessage[],
		cache = false,
	): Array<Record<string, unknown>> {
		const converted = messages.map(msg => {
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

		if (cache && converted.length > 0) {
			// A cache breakpoint marks the END of a reusable prefix. Marking the
			// newest message(s) makes "everything up to here" a cache read on the
			// next turn — exactly how a ReAct loop re-sends its history.
			const tail = Math.min(CACHE_TAIL_MESSAGES, MAX_CACHE_BREAKPOINTS - 1);
			let placed = 0;
			for (let i = converted.length - 1; i >= 0 && placed < tail; i--) {
				if (markCacheBreakpoint(converted[i])) placed++;
			}
		}

		return converted;
	}
}

LLMProviderFactory.register('anthropic', AnthropicProvider);
