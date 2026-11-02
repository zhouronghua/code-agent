/*---------------------------------------------------------------------------------------------
 *  Unit tests: tool-result head+tail retention (`agentResultRetention.ts`)
 *
 *  The behaviour that matters is WHICH part survives. A head-only cut (what
 *  code-agent used to do) keeps the setup noise of a failing test run and throws
 *  away the assertion and the summary; this suite pins the opposite:
 *
 *    1. in-budget results are untouched (no cost in the common case)
 *    2. oversized results keep the head AND the tail
 *    3. the omission notice states the EXACT dropped length
 *    4. surrogate pairs are never split
 *    5. impossible budgets are rejected loudly
 *
 *  Run:
 *    npx esbuild tests/result-retention.test.ts --bundle --platform=node \
 *      --target=node18 --format=esm --outfile=/tmp/retention.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/retention.mjs
 *--------------------------------------------------------------------------------------------*/

import {
	retainResult,
	retentionNotice,
	safeSlice,
	RETENTION_DEFAULTS,
} from 'vs/workbench/contrib/agent/common/agentResultRetention';

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

/** Build a realistic failing-test log: noise head, assertion+summary tail. */
function testLog(): string {
	const header = Array.from({ length: 400 }, (_, i) => `collected test_case_${i} ... PASSED`).join('\n');
	const tail = [
		'=================================== FAILURES ===================================',
		'___________________________ test_widget_renders ____________________________',
		'E       AssertionError: expected <Widget size=3> to equal <Widget size=4>',
		'=========================== short test summary info ===========================',
		'FAILED test_widget.py::test_widget_renders - AssertionError',
		'1 failed, 399 passed in 12.41s',
	].join('\n');
	return `${header}\n${tail}`;
}

// ---------------------------------------------------------------------------
// 1. In-budget results are untouched
// ---------------------------------------------------------------------------
console.log('\n[retention] in-budget results pass through');

{
	const text = 'short output\n[Exit code: 0]';
	const result = retainResult(text);
	eq(result.text, text, 'short output is returned byte-for-byte');
	eq(result.truncated, false, 'short output is not marked truncated');
	eq(result.omittedChars, 0, 'short output omits nothing');
}

{
	const exact = 'x'.repeat(RETENTION_DEFAULTS.maxChars);
	const result = retainResult(exact);
	eq(result.truncated, false, 'a result exactly at the budget is kept whole');
	eq(result.text.length, RETENTION_DEFAULTS.maxChars, 'the whole result is returned');
}

{
	const over = 'x'.repeat(RETENTION_DEFAULTS.maxChars + 1);
	const result = retainResult(over);
	eq(result.truncated, true, 'one character over the budget is retained');
}

// ---------------------------------------------------------------------------
// 2. The tail survives — this is the whole point
// ---------------------------------------------------------------------------
console.log('\n[retention] the tail survives (the old bug)');

{
	const log = testLog();
	ok(log.length > RETENTION_DEFAULTS.maxChars, 'the fixture exceeds the budget');
	const result = retainResult(log);

	ok(result.text.includes('1 failed, 399 passed in 12.41s'),
		'the pytest summary line survives retention');
	ok(result.text.includes('AssertionError: expected <Widget size=3>'),
		'the assertion survives retention');
	ok(result.text.includes('collected test_case_0'),
		'the head of the output also survives');
	// A line from the genuine middle (neither head nor tail) must be the thing
	// that was dropped — not a line near either edge.
	ok(!result.text.includes('collected test_case_200'),
		'a middle-only line is what gets dropped');
	eq(result.truncated, true, 'the result is marked truncated');
}

{
	// A compiler diagnostic is the tail of a build log — same shape, same need.
	const build = 'compiling module_a.c\n'.repeat(600)
		+ 'module_z.c:412:9: error: implicit declaration of function \'foo\'';
	const result = retainResult(build);
	ok(result.text.includes("implicit declaration of function 'foo'"),
		'a compiler error at the end of a build log survives');
}

// ---------------------------------------------------------------------------
// 3. The omission notice is exact
// ---------------------------------------------------------------------------
console.log('\n[retention] the omission notice is exact');

{
	const text = 'H'.repeat(5000) + 'M'.repeat(20000) + 'T'.repeat(5000);
	const result = retainResult(text, { maxChars: 2000, headChars: 800, tailChars: 400 });
	eq(result.headChars, 800, 'the head keeps exactly headChars');
	eq(result.tailChars, 400, 'the tail keeps exactly tailChars');
	eq(result.omittedChars, 30000 - 800 - 400, 'the omitted count is exact');
	ok(result.text.includes('28800'), 'the notice states the exact omitted count');
	ok(result.text.startsWith('H'.repeat(800)), 'the retained text starts with the head');
	ok(result.text.endsWith('T'.repeat(400)), 'the retained text ends with the tail');
}

{
	// The notice must not claim a truncation that did not happen.
	eq(retentionNotice(retainResult('short')), undefined, 'no notice for an untouched result');
	ok((retentionNotice(retainResult('x'.repeat(10000))) ?? '').includes('omitted from the middle'),
		'the notice explains where the text went');
}

// ---------------------------------------------------------------------------
// 4. Surrogate pairs are never split
// ---------------------------------------------------------------------------
console.log('\n[retention] surrogate pairs are not split');

{
	// Each emoji is a surrogate pair (2 UTF-16 units).
	const text = '😀'.repeat(10000); // 20000 units
	const result = retainResult(text, { maxChars: 1000, headChars: 401, tailChars: 401 });
	eq(result.text.includes('\uFFFD'), false, 'no replacement character appears at a cut');
	// A lone surrogate is detectable by comparing the re-encoded length.
	const headPart = result.text.slice(0, result.headChars);
	eq(headPart.length % 2, 0, 'the head cut lands on a pair boundary');
}

{
	// safeSlice is the primitive; check both ends directly.
	const emoji = '😀'; // \uD83D\uDE00
	eq(safeSlice(emoji, 1, 2), '', 'cutting at the high surrogate yields no lone surrogate');
	eq(safeSlice(emoji, 0, 1), '', 'cutting before the low surrogate yields no lone surrogate');
	eq(safeSlice(emoji, 0, 2), emoji, 'a full pair is returned intact');
	eq(safeSlice('abc', 0, 2), 'ab', 'plain ASCII slices normally');
	eq(safeSlice('abc', 5, 9), '', 'an out-of-range slice is empty, not a crash');
}

// ---------------------------------------------------------------------------
// 5. Impossible budgets are rejected
// ---------------------------------------------------------------------------
console.log('\n[retention] invalid budgets fail loudly');

{
	const cases: Array<[string, () => unknown]> = [
		['maxChars = 0', () => retainResult('x', { maxChars: 0 })],
		['negative maxChars', () => retainResult('x', { maxChars: -1 })],
		['fractional maxChars', () => retainResult('x', { maxChars: 1.5 })],
		['negative headChars', () => retainResult('x', { headChars: -1 })],
		['negative tailChars', () => retainResult('x', { tailChars: -1 })],
		['head+tail >= maxChars', () => retainResult('x', { maxChars: 100, headChars: 60, tailChars: 40 })],
	];
	for (const [name, fn] of cases) {
		let threw = false;
		try { fn(); } catch { threw = true; }
		ok(threw, `${name} is rejected`);
	}
}

{
	// Contradictory budgets must not silently produce LONGER output than input.
	// (8100 + tail would exceed the 8000 total, so the guard must fire.)
	let threw = false;
	try { retainResult('x', { maxChars: 100, headChars: 100, tailChars: 100 }); } catch { threw = true; }
	ok(threw, 'a retained result can never be longer than its input');
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);