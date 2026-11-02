/*---------------------------------------------------------------------------------------------
 *  Agent Diff - unified diff computation + ANSI rendering for file mutations
 *
 *  WHY THIS EXISTS
 *  Every other coding agent (Claude Code, Codex, Cursor, aider) shows the user a
 *  colored diff when it edits a file. `edit_file` used to answer only
 *  "Replaced 1 occurrence(s) in /path" and `write_file` only
 *  "Successfully wrote N lines" — so the person watching the session had to
 *  diff the file afterwards to learn what the agent actually did.
 *
 *  The reference harness (deepseek-harness) solves this with a `FileDiff[]`
 *  result payload plus a presentation layer that renders one three-line-context
 *  card per applied hunk. This module is the dependency-free equivalent:
 *
 *    computeFileDiff(path, before, after)  → structured hunks (+added/removed)
 *    renderFileDiffAnsi(diff, {color})     → the terminal card
 *
 *  Deliberate constraints:
 *    - No `diff` npm package: the CLI bundle must stay dependency-free, so the
 *      LCS is implemented here (prefix/suffix trim keeps every real edit tiny).
 *    - The card is DISPLAY-ONLY (`IToolResult.diff`). Model-facing output stays
 *      plain, so ANSI escapes can never leak into the context window and confuse
 *      the tokenizer or the model.
 *    - Tools return DATA; the host renders. Only the host knows whether stdout is
 *      a TTY and what the working directory is, so path relativization and color
 *      selection both live on the rendering side.
 *--------------------------------------------------------------------------------------------*/

import { IToolDiff, IToolDiffHunk, IToolDiffLine } from 'vs/workbench/services/agent/common/agentModels';

/** Context lines shown around each change, matching `diff -U3`. */
export const DIFF_CONTEXT = 3;

/**
 * Upper bound on the LCS table. A line-level LCS is O(n·m); past this budget we
 * degrade to "everything between the common prefix and suffix changed", which is
 * still a correct (if coarser) diff, instead of freezing the REPL on a
 * pathological 100k-line rewrite.
 */
const MAX_LCS_CELLS = 4_000_000;

type Op = { kind: ' ' | '-' | '+'; text: string };

function splitLines(text: string): string[] {
	if (text === '') return [];
	const lines = text.split('\n');
	// A trailing newline produces one empty tail element that is not a line.
	if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
	return lines;
}

/**
 * Longest-common-subsequence line diff of the trimmed middle region.
 *
 * The caller has already removed the common prefix/suffix, so the table only
 * covers the changed region. Ties are broken toward deletions-first, which keeps
 * a "replace N lines with M lines" edit as one block instead of a zig-zag.
 */
function lcsDiff(a: readonly string[], b: readonly string[]): Op[] {
	const n = a.length;
	const m = b.length;
	if (n === 0) return b.map(text => ({ kind: '+' as const, text }));
	if (m === 0) return a.map(text => ({ kind: '-' as const, text }));

	if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
		return [
			...a.map(text => ({ kind: '-' as const, text })),
			...b.map(text => ({ kind: '+' as const, text })),
		];
	}

	// table[i * width + j] = LCS length of a[i..] and b[j..]
	const width = m + 1;
	const table = new Int32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * width + j] = a[i] === b[j]
				? table[(i + 1) * width + (j + 1)] + 1
				: Math.max(table[(i + 1) * width + j], table[i * width + (j + 1)]);
		}
	}

	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			ops.push({ kind: ' ', text: a[i] });
			i++; j++;
		} else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
			ops.push({ kind: '-', text: a[i] });
			i++;
		} else {
			ops.push({ kind: '+', text: b[j] });
			j++;
		}
	}
	while (i < n) { ops.push({ kind: '-', text: a[i] }); i++; }
	while (j < m) { ops.push({ kind: '+', text: b[j] }); j++; }
	return ops;
}

/** Full ordered op list for two texts (common prefix/suffix trimmed first). */
function diffOps(before: readonly string[], after: readonly string[]): Op[] {
	let prefix = 0;
	const maxPrefix = Math.min(before.length, after.length);
	while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;

	let suffix = 0;
	const maxSuffix = Math.min(before.length, after.length) - prefix;
	while (suffix < maxSuffix
		&& before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;

	const ops: Op[] = [];
	for (let i = 0; i < prefix; i++) ops.push({ kind: ' ', text: before[i] });
	ops.push(...lcsDiff(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix)));
	for (let i = before.length - suffix; i < before.length; i++) ops.push({ kind: ' ', text: before[i] });
	return ops;
}

/**
 * Number every op on both sides, then group the changed ones into hunks with
 * `context` unchanged lines around each change.
 */
function buildHunks(ops: readonly Op[], context: number): IToolDiffHunk[] {
	const lineAt: Array<{ oldLine?: number; newLine?: number }> = [];
	const changed: number[] = [];
	let oldNo = 0;
	let newNo = 0;
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		if (op.kind === '-') {
			oldNo++;
			lineAt.push({ oldLine: oldNo });
			changed.push(i);
		} else if (op.kind === '+') {
			newNo++;
			lineAt.push({ newLine: newNo });
			changed.push(i);
		} else {
			oldNo++;
			newNo++;
			lineAt.push({ oldLine: oldNo, newLine: newNo });
		}
	}
	if (changed.length === 0) return [];

	// Ranges of interesting op indices, merged where their context overlaps.
	const ranges: Array<{ start: number; end: number }> = [];
	for (const index of changed) {
		const start = Math.max(0, index - context);
		const end = Math.min(ops.length - 1, index + context);
		const last = ranges[ranges.length - 1];
		if (last && start <= last.end + 1) {
			last.end = Math.max(last.end, end);
		} else {
			ranges.push({ start, end });
		}
	}

	const hunks: IToolDiffHunk[] = [];
	for (const range of ranges) {
		const lines: IToolDiffLine[] = [];
		let oldStart = 0;
		let newStart = 0;
		let oldCount = 0;
		let newCount = 0;
		for (let i = range.start; i <= range.end; i++) {
			const op = ops[i];
			const numbering = lineAt[i];
			lines.push({ kind: op.kind, text: op.text, oldLine: numbering.oldLine, newLine: numbering.newLine });
			if (op.kind !== '+') {
				if (oldStart === 0) oldStart = numbering.oldLine ?? 0;
				oldCount++;
			}
			if (op.kind !== '-') {
				if (newStart === 0) newStart = numbering.newLine ?? 0;
				newCount++;
			}
		}
		// A pure insertion/deletion has no anchor of its own on the emptied side;
		// anchor it to the end of the previous hunk so the header stays meaningful.
		if (oldStart === 0) {
			const previous = hunks[hunks.length - 1];
			oldStart = previous ? previous.oldStart + previous.oldCount : 0;
		}
		if (newStart === 0) {
			const previous = hunks[hunks.length - 1];
			newStart = previous ? previous.newStart + previous.newCount : 0;
		}
		hunks.push({ oldStart, oldCount, newStart, newCount, lines });
	}
	return hunks;
}

/**
 * Compute the unified diff for one file mutation.
 *
 * @param path - the tool's path argument (stamped on the result, not resolved).
 * @param before - file text before the change; `''` means "did not exist".
 * @param after - file text after the change.
 * @param context - unchanged lines kept around each change (default 3).
 */
export function computeFileDiff(path: string, before: string, after: string, context = DIFF_CONTEXT): IToolDiff {
	const ops = diffOps(splitLines(before), splitLines(after));

	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op.kind === '+') added++;
		else if (op.kind === '-') removed++;
	}

	return {
		path,
		hunks: buildHunks(ops, context),
		added,
		removed,
		created: before === '',
	};
}

/**
 * Build the presentation payload stamped on a tool result.
 *
 * Returns `undefined` (rather than an empty card) when the change produced no
 * hunk — an `edit_file` that swapped "a" for "a", or a `write_file` that rewrote
 * identical content. Hosts then skip rendering instead of printing an empty box.
 */
export function buildToolDiff(path: string, before: string, after: string): IToolDiff | undefined {
	const diff = computeFileDiff(path, before, after);
	return diff.hunks.length === 0 ? undefined : diff;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ANSI = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	cyan: '\x1b[36m',
	magenta: '\x1b[35m',
};

/**
 * Whether ANSI colors should be emitted at all.
 *
 * Honors the usual conventions: `NO_COLOR`, `TERM=dumb`, and `FORCE_COLOR` for
 * the opposite case (a piped CI log that is still meant to be read later).
 */
export function ansiColorEnabled(env: NodeJS.ProcessEnv = process.env, stream?: { isTTY?: boolean }): boolean {
	if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
	if (env.TERM === 'dumb') return false;
	const tty = stream?.isTTY ?? process.stdout.isTTY;
	return tty === true;
}

function paint(text: string, color: string, enabled: boolean): string {
	return enabled ? `${color}${text}${ANSI.reset}` : text;
}

function hunkHeader(hunk: IToolDiffHunk): string {
	const oldRange = hunk.oldCount === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldCount}`;
	const newRange = hunk.newCount === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newCount}`;
	return `@@ -${oldRange} +${newRange} @@`;
}

/**
 * Relativize a path for display so the terminal does not echo a 90-character
 * absolute path when the file sits inside the working directory.
 */
export function displayPathFor(path: string, cwd: string | undefined, sep = '/'): string {
	if (!cwd) return path;
	const root = cwd.endsWith(sep) ? cwd : cwd + sep;
	return path.startsWith(root) ? path.slice(root.length) : path;
}

/**
 * Render a file diff as a colored, indented card for the terminal.
 *
 *   ┌─ path/to/file.ts (+3 -1)
 *   │ @@ -10,7 +10,9 @@
 *   │ - old line
 *   │ + new line
 *   └─
 *
 * @param diff - computed diff.
 * @param options - `color` forces ANSI on/off, `displayPath` overrides the header
 *   path, `maxLines` caps the body so one huge rewrite cannot flood the REPL.
 */
export function renderFileDiffAnsi(
	diff: IToolDiff,
	options: { color?: boolean; displayPath?: string; maxLines?: number } = {},
): string {
	const color = options.color ?? ansiColorEnabled();
	const maxLines = options.maxLines ?? 400;
	const shownPath = options.displayPath ?? diff.path;

	const out: string[] = [];
	out.push(paint(`┌─ ${shownPath} `, ANSI.bold, color) + paint(`(+${diff.added} -${diff.removed})`, ANSI.magenta, color));

	let emitted = 0;
	let truncated = false;
	for (const hunk of diff.hunks) {
		if (emitted >= maxLines) { truncated = true; break; }
		out.push(paint('│ ', ANSI.dim, color) + paint(hunkHeader(hunk), ANSI.cyan, color));
		emitted++;
		for (const line of hunk.lines) {
			if (emitted >= maxLines) { truncated = true; break; }
			const prefix = line.kind === '+' ? '+' : line.kind === '-' ? '-' : ' ';
			const color2 = line.kind === '+' ? ANSI.green : line.kind === '-' ? ANSI.red : ANSI.dim;
			out.push(paint('│ ', ANSI.dim, color) + paint(prefix + line.text, color2, color));
			emitted++;
		}
	}
	if (truncated) out.push(paint(`│ ... (diff truncated at ${maxLines} lines)`, ANSI.dim, color));
	out.push(paint('└─', ANSI.dim, color));
	return out.join('\n');
}

/**
 * Escape-free diff for logs and batch result files, where an ANSI code would be
 * noise (or worse, corrupt a machine-read artifact).
 */
export function renderFileDiffPlain(diff: IToolDiff, displayPath: string = diff.path, maxLines = 200): string {
	const out: string[] = [`--- ${displayPath} (+${diff.added} -${diff.removed})`];
	for (const hunk of diff.hunks) {
		out.push(hunkHeader(hunk));
		for (const line of hunk.lines) out.push(line.kind + line.text);
		if (out.length >= maxLines) {
			out.push('... (diff truncated)');
			break;
		}
	}
	return out.join('\n');
}