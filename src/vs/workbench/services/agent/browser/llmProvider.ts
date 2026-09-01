/*---------------------------------------------------------------------------------------------
 *  LLM Provider - Abstract interface + factory for LLM backends
 *--------------------------------------------------------------------------------------------*/

import { IAgentMessage, IToolSchema, IAgentConfig } from '../common/agentModels';

export interface ILLMProvider {
	readonly name: string;

	complete(
		messages: IAgentMessage[],
		tools?: IToolSchema[],
		temperature?: number,
	): Promise<IAgentMessage>;

	stream(
		messages: IAgentMessage[],
		tools?: IToolSchema[],
		temperature?: number,
	): AsyncIterableIterator<string>;

	countTokens(text: string): number;

	supportsStreaming?(): boolean;

	/** Does this model use reasoning_content (thinking/chain-of-thought)? */
	supportsReasoning?(): boolean;
}

/**
 * Thrown when a request cannot fit in the model's context window
 * (input tokens + max_tokens exceed the limit). The agent loop catches this,
 * compacts the conversation history, and retries with a smaller window.
 */
export class ContextOverflowError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ContextOverflowError';
	}
}

// Characters that tokenize far denser than the plain chars/4 rule:
// CJK unified ideographs, Hangul, full-width forms, CJK punctuation, kana, etc.
const CJK_REGEX = /[\u3000-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF\u2000-\u206F\u2E80-\u2FFF\u3040-\u30FF\u31C0-\u31EF\uF900-\uFAFF\uFE30-\uFE4F]/g;

/**
 * Conservative token-count heuristic shared by all providers.
 *
 * The old chars/4 rule undercounts badly for:
 *  - CJK text (Chinese/Japanese/Korean chars are ~1.5-2 tokens each)
 *  - code / markdown-heavy content (tokenizes denser than 4 chars/token)
 *  - reasoning_content (long chain-of-thought with markdown formatting)
 *
 * Measured case: 2.4M chars of mixed code + reasoning_content tokenized to
 * 986,532 tokens while chars/4 estimated only 601,772 (~1.64x low). Undercounting
 * defeats every context-budget guardrail (sliding window, compaction trigger,
 * max_tokens clamp), so we must err on the high side.
 */
export function estimateTokenCount(text: string): number {
	if (!text) return 0;
	const cjkMatches = text.match(CJK_REGEX);
	const cjkCount = cjkMatches ? cjkMatches.length : 0;
	const otherLen = text.length - cjkCount;
	// CJK ≈ 1.5 tokens/char; everything else ≈ 3 chars/token (conservative for
	// code + markdown); +1 for a partial token at the tail.
	return Math.ceil(cjkCount * 1.5) + Math.ceil(otherLen / 3) + 1;
}

/** Extra tokens per message for JSON framing (role, id, timestamp, tool_call_id, keys). */
export const TOKENS_PER_MESSAGE_OVERHEAD = 12;

export class LLMProviderFactory {
	private static readonly _providers = new Map<string, new (config: IAgentConfig) => ILLMProvider>();

	static register(name: string, ctor: new (config: IAgentConfig) => ILLMProvider): void {
		LLMProviderFactory._providers.set(name, ctor);
	}

	static create(config: IAgentConfig): ILLMProvider {
		const ctor = LLMProviderFactory._providers.get(config.provider);
		if (!ctor) {
			throw new Error(`Unknown LLM provider: ${config.provider}. Available: ${[...LLMProviderFactory._providers.keys()].join(', ')}`);
		}
		return new ctor(config);
	}
}
