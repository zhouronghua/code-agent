/*---------------------------------------------------------------------------------------------
 *  Agent Result Retention - head+tail retention for oversized tool output
 *
 *  WHY THIS EXISTS
 *  Tool results used to be cut with a single `substring(0, 8000)`. For the outputs
 *  that matter most this keeps exactly the useless half:
 *
 *    - a failing `pytest` run: the assertion and the summary are the LAST lines
 *    - a compiler error: the diagnostic is the LAST lines
 *    - `npm test`: the pass/fail counts are the LAST lines
 *    - a long `git diff`: the interesting part is usually the tail
 *
 *  In every one of those the agent saw 8000 characters of setup output and a
 *  "truncated" marker, then had to re-run the command piped to `tail`. The
 *  reference harness (deepseek-harness `spill-policy/retention.ts`) keeps the
 *  ordered HEAD and TAIL instead, with an exact omission notice in the middle.
 *  This module is the dependency-free equivalent for code-agent's plain-string
 *  tool results:
 *
 *    retainResult(text, { maxChars, headChars, tailChars }) → {
 *      text,                     // retained head + notice + retained tail
 *      omittedChars, truncated,
 *    }
 *
 *  Deliberate constraints:
 *    - Character based, not token based: code-agent's tools produce plain text and
 *      its token counter is a heuristic, so counting characters keeps the budget
 *      honest (the same reason `MAX_TOOL_RESULT_CHARS` is in characters).
 *    - Cuts never split a surrogate pair, so an emoji or a CJK extension-B glyph at
 *      the boundary cannot produce a replacement character.
 *    - The omission notice states the EXACT dropped length and where the full text
 *      is, so the agent can decide whether to re-run the tool with a narrower
 *      scope instead of guessing how much went missing.
 *--------------------------------------------------------------------------------------------*/

/** Budget for tool-result retention. */
export interface IResultRetentionOptions {
	/** Results longer than this are retained (default 8000, matching the old cap). */
	maxChars?: number;
	/** Characters kept from the start of the result. */
	headChars?: number;
	/** Characters kept from the end of the result — this is what the old code lost. */
	tailChars?: number;
	/** Marker substituted for the dropped middle. */
	marker?: string;
}

/** Outcome of retention. `truncated: false` means `text` is unchanged. */
export interface IRetentionResult {
	readonly text: string;
	readonly truncated: boolean;
	/** Exact number of characters dropped from the middle (0 when not truncated). */
	readonly omittedChars: number;
	/** Characters kept from the start (0 when not truncated). */
	readonly headChars: number;
	/** Characters kept from the end (0 when not truncated). */
	readonly tailChars: number;
}

/** Defaults chosen for coding-agent output: 8k total, 4k head, 2k tail. */
export const RETENTION_DEFAULTS = {
	maxChars: 8000,
	headChars: 4000,
	tailChars: 2000,
} as const;

/** The middle marker. Includes the exact dropped count at format time. */
const MARKER = '\n\n[... tool result middle omitted, {OMITTED} characters ...]\n\n';

/**
 * Slice `text` without splitting a surrogate pair.
 *
 * Cutting between a high and a low surrogate yields two lone surrogates, which
 * serialize to U+FFFD and silently corrupt the text the model reads.
 *
 * @param text - source text.
 * @param start - inclusive start index (UTF-16 units).
 * @param end - exclusive end index (UTF-16 units).
 */
export function safeSlice(text: string, start: number, end: number): string {
	let from = Math.max(0, start);
	let to = Math.min(text.length, end);
	// Do not start on a low surrogate.
	if (from > 0 && from < text.length) {
		const code = text.charCodeAt(from);
		if (code >= 0xdc00 && code <= 0xdfff) from++;
	}
	// Do not end on a high surrogate.
	if (to > 0 && to < text.length) {
		const code = text.charCodeAt(to - 1);
		if (code >= 0xd800 && code <= 0xdbff) to--;
	}
	if (to <= from) return '';
	return text.slice(from, to);
}

function assertBudgets(maxChars: number, headChars: number, tailChars: number): void {
	if (!Number.isInteger(maxChars) || maxChars <= 0) {
		throw new Error(`result retention: maxChars (${maxChars}) must be a positive integer`);
	}
	if (!Number.isInteger(headChars) || headChars < 0) {
		throw new Error(`result retention: headChars (${headChars}) must be a non-negative integer`);
	}
	if (!Number.isInteger(tailChars) || tailChars < 0) {
		throw new Error(`result retention: tailChars (${tailChars}) must be a non-negative integer`);
	}
	if (headChars + tailChars >= maxChars) {
		// Otherwise the retained text would be LONGER than the input it replaced,
		// which is worse than not retaining at all.
		throw new Error(
			`result retention: headChars (${headChars}) + tailChars (${tailChars}) `
			+ `must be less than maxChars (${maxChars})`,
		);
	}
}

/**
 * Retain the head and the tail of an oversized tool result.
 *
 * The returned `text` is at most `maxChars` (+ the marker, which carries the exact
 * omitted count). A result within budget is returned untouched, so the common case
 * costs one length comparison.
 *
 * @param text - the raw tool output.
 * @param options - budgets; defaults keep 8k with a 4k head and a 2k tail.
 */
export function retainResult(text: string, options: IResultRetentionOptions = {}): IRetentionResult {
	const maxChars = options.maxChars ?? RETENTION_DEFAULTS.maxChars;
	const headChars = options.headChars ?? RETENTION_DEFAULTS.headChars;
	const tailChars = options.tailChars ?? RETENTION_DEFAULTS.tailChars;
	const markerTemplate = options.marker ?? MARKER;
	assertBudgets(maxChars, headChars, tailChars);

	if (text.length <= maxChars) {
		return { text, truncated: false, omittedChars: 0, headChars: text.length, tailChars: 0 };
	}

	const head = safeSlice(text, 0, headChars);
	const tail = safeSlice(text, text.length - tailChars, text.length);
	const omitted = text.length - head.length - tail.length;
	const marker = markerTemplate.split('{OMITTED}').join(String(omitted));

	return {
		text: head + marker + tail,
		truncated: true,
		omittedChars: omitted,
		headChars: head.length,
		tailChars: tail.length,
	};
}

/**
 * Render a sector of the result for a plain-text notice, used when the caller
 * wants to point at the full output (task logs, batch result files).
 */
export function retentionNotice(result: IRetentionResult): string | undefined {
	if (!result.truncated) return undefined;
	return `${result.omittedChars} characters omitted from the middle `
		+ `(kept ${result.headChars} at the start and ${result.tailChars} at the end).`;
}