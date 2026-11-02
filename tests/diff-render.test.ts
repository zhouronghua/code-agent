/*---------------------------------------------------------------------------------------------
 *  Unit tests: terminal diff rendering (`agentDiff.ts`)
 *
 *  Covers the behaviour a terminal user actually depends on:
 *    1. correctness  — added/removed counts and hunk line numbering
 *    2. the card     — ANSI when a TTY, plain when piped / NO_COLOR
 *    3. boundaries   — create, delete-all, no-op, CRLF-free equality
 *
 *  Run:
 *    npx esbuild tests/diff-render.test.ts --bundle --platform=node --target=node18 \
 *      --format=esm --outfile=/tmp/diff-render.test.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/diff-render.test.mjs
 *--------------------------------------------------------------------------------------------*/

import {
	computeFileDiff,
	buildToolDiff,
	renderFileDiffAnsi,
	renderFileDiffPlain,
	ansiColorEnabled,
	displayPathFor,
} from 'vs/workbench/contrib/agent/common/agentDiff';

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string): void {
	if (cond) {
		console.log(`  PASS: ${msg}`);
		passed++;
	} else {
		console.error(`  FAIL: ${msg}`);
		failed++;
	}
}

function eq(actual: unknown, expected: unknown, msg: string): void {
	ok(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ---------------------------------------------------------------------------
// 1. correctness
// ---------------------------------------------------------------------------
console.log('\n[diff] counts and hunks');

{
	const before = 'a\nb\nc\n';
	const after = 'a\nB\nc\n';
	const diff = computeFileDiff('f.txt', before, after);
	eq(diff.added, 1, 'single replacement: one added line');
	eq(diff.removed, 1, 'single replacement: one removed line');
	eq(diff.created, false, 'an existing file is not a create');
	eq(diff.hunks.length, 1, 'adjacent changes merge into one hunk');
	// Context is 3 lines each side, so the whole 3-line file is the hunk.
	eq(diff.hunks[0].oldCount, 3, 'hunk keeps all three old lines as context');
	eq(diff.hunks[0].newCount, 3, 'hunk keeps all three new lines as context');
	const changed = diff.hunks[0].lines.filter(l => l.kind !== ' ');
	eq(changed.length, 2, 'exactly one removal and one addition are marked');
	eq(changed[0].kind, '-', 'the removal comes first');
	eq(changed[0].text, 'b', 'the removal carries the old text');
	eq(changed[1].text, 'B', 'the addition carries the new text');
}

{
	// Line numbers must be real file line numbers, not op indices.
	const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n') + '\n';
	const after = ['1', '2', '3', '4', 'FIVE', '6', '7', '8', '9', '10'].join('\n') + '\n';
	const diff = computeFileDiff('f.txt', before, after);
	const removedLine = diff.hunks[0].lines.find(l => l.kind === '-');
	eq(removedLine?.oldLine, 5, 'the removed line is reported as old line 5');
	const addedLine = diff.hunks[0].lines.find(l => l.kind === '+');
	eq(addedLine?.newLine, 5, 'the added line is reported as new line 5');
	eq(diff.hunks[0].oldStart, 2, 'context starts 3 lines before the change');
}

{
	// Two changes far apart stay separate hunks.
	const before = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') + '\n';
	const after = before.replace('line1\n', 'LINE1\n').replace('line38\n', 'LINE38\n');
	const diff = computeFileDiff('f.txt', before, after);
	eq(diff.hunks.length, 2, 'distant changes produce two hunks');
	eq(diff.added, 2, 'two additions counted across hunks');
	eq(diff.removed, 2, 'two removals counted across hunks');
}

{
	// Pure insertion at EOF, the "append a line" case.
	const diff = computeFileDiff('f.txt', 'a\nb\n', 'a\nb\nc\n');
	eq(diff.added, 1, 'append: one added line');
	eq(diff.removed, 0, 'append: nothing removed');
	eq(renderFileDiffPlain(diff).includes('+c'), true, 'append renders as an added line');
}

// ---------------------------------------------------------------------------
// 2. boundaries
// ---------------------------------------------------------------------------
console.log('\n[diff] boundaries');

{
	const diff = computeFileDiff('new.ts', '', 'x\ny\n');
	eq(diff.created, true, 'an empty baseline marks the result as a create');
	eq(diff.added, 2, 'create counts the whole content as added');
	eq(diff.removed, 0, 'create removes nothing');
}

{
	eq(buildToolDiff('f.txt', 'same\n', 'same\n'), undefined, 'identical content yields no diff payload');
	// NB: 'a\n' → 'a\n\n' is NOT a no-op — it adds a blank line, so a payload is
	// correct here. The genuine no-op cases are identical text and empty-vs-empty.
	const blankLine = buildToolDiff('f.txt', 'a\n', 'a\n\n');
	eq(blankLine?.added, 1, 'adding a trailing blank line is a real change');
	eq(blankLine?.removed, 0, 'adding a trailing blank line removes nothing');
	eq(buildToolDiff('f.txt', '', '')?.added, undefined, 'empty to empty yields no payload at all');
	eq(buildToolDiff('f.txt', 'a\n', 'b\n')?.added, 1, 'a real change yields a payload');
}

{
	// A whole-file delete must not crash and must report every removed line.
	const diff = computeFileDiff('f.txt', 'a\nb\nc\n', '');
	eq(diff.removed, 3, 'clearing a file counts all removed lines');
	eq(diff.added, 0, 'clearing a file adds nothing');
}

{
	// Degenerate large rewrite must fall back rather than hang (MAX_LCS_CELLS).
	const before = Array.from({ length: 2200 }, (_, i) => `old${i}`).join('\n') + '\n';
	const after = Array.from({ length: 2200 }, (_, i) => `new${i}`).join('\n') + '\n';
	const diff = computeFileDiff('f.txt', before, after);
	eq(diff.removed, 2200, 'large rewrite reports every removed line');
	eq(diff.added, 2200, 'large rewrite reports every added line');
}

// ---------------------------------------------------------------------------
// 3. rendering
// ---------------------------------------------------------------------------
console.log('\n[diff] rendering');

{
	const diff = computeFileDiff('src/foo.ts', 'a\nb\nc\n', 'a\nb\nC\n');
	const colored = renderFileDiffAnsi(diff, { color: true });
	ok(colored.includes('\x1b[32m+C'), 'the added line is green in color mode');
	ok(colored.includes('\x1b[31m-c'), 'the removed line is red in color mode');
	ok(colored.includes('+1 -1'), 'the header carries the change counts');

	// In color mode the very first bytes are the bold escape for the top rule,
	// so check the rule itself rather than the string prefix.
	const plainCard = renderFileDiffAnsi(diff, { color: false });
	ok(plainCard.startsWith('\u250c\u2500'), 'the plain card opens with its top rule');
	ok(colored.includes('\u250c\u2500'), 'the colored card still contains the top rule');

	const plain = renderFileDiffAnsi(diff, { color: false });
	eq(plain.includes('\x1b'), false, 'color=false emits no escape sequences');
	ok(plain.includes('+C'), 'color=false still shows the added line');
}

{
	const diff = computeFileDiff('a.ts', 'x\n', 'y\n');
	const long = renderFileDiffAnsi(diff, { color: false, maxLines: 2 });
	ok(long.includes('diff truncated'), 'maxLines caps the card body');
}

{
	const diff = computeFileDiff('a.ts', 'x\ny\nz\n', 'x\nY\nz\n');
	const plain = renderFileDiffPlain(diff);
	eq(plain.includes('\x1b'), false, 'the plain renderer never emits ANSI');
	ok(plain.startsWith('--- a.ts'), 'the plain renderer starts with a file header');
	ok(plain.includes('\n-Y\n') || plain.includes('-y'), 'the plain renderer marks removals');
}

{
	// Color decision honours the standard env conventions.
	eq(ansiColorEnabled({}, { isTTY: true }), true, 'a TTY gets color');
	eq(ansiColorEnabled({}, { isTTY: false }), false, 'a pipe gets no color');
	eq(ansiColorEnabled({ NO_COLOR: '1' }, { isTTY: true }), false, 'NO_COLOR wins over the TTY');
	eq(ansiColorEnabled({ TERM: 'dumb' }, { isTTY: true }), false, 'TERM=dumb wins over the TTY');
	eq(ansiColorEnabled({ FORCE_COLOR: '1' }, { isTTY: false }), true, 'FORCE_COLOR turns color on for a pipe');
}

{
	eq(displayPathFor('/work/repo/src/a.ts', '/work/repo'), 'src/a.ts', 'a path inside the CWD is relativized');
	eq(displayPathFor('/other/a.ts', '/work/repo'), '/other/a.ts', 'a path outside the CWD stays absolute');
	eq(displayPathFor('/work/repo/src/a.ts', undefined), '/work/repo/src/a.ts', 'no CWD keeps the original path');
	eq(displayPathFor('/work/repo/src/a.ts', '/work/repo/'), 'src/a.ts', 'a trailing separator in the CWD is tolerated');
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);