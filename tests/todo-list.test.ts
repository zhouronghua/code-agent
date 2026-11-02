/*---------------------------------------------------------------------------------------------
 *  Unit tests: todo_write checklist (`tools/todoWrite.ts`)
 *
 *  Ported from deepseek-harness `packages/todo/tool-todo`. The properties worth
 *  pinning are the ones a UI depends on:
 *
 *    1. whole-list replacement (last write wins, no partial edits)
 *    2. the validation the JSON schema cannot express (non-empty, unique, one active)
 *    3. the rendered checklist a terminal shows
 *    4. the model-facing output stays plain (no glyphs/ANSI in the context)
 *
 *  Run:
 *    npx esbuild tests/todo-list.test.ts --bundle --platform=node --target=node18 \
 *      --format=esm --outfile=/tmp/todo.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/todo.mjs
 *--------------------------------------------------------------------------------------------*/

import {
	canonicalizeTodos,
	formatTodoList,
	summarizeTodos,
	TodoList,
	TodoWriteTool,
	ITodoItem,
} from 'vs/workbench/contrib/agent/common/tools/todoWrite';

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
// 1. Validation
// ---------------------------------------------------------------------------
console.log('\n[todo] validation');

{
	const todos = canonicalizeTodos([
		{ content: '  read the config  ', status: 'completed' },
		{ content: 'patch the loader', status: 'in_progress' },
		{ content: 'run tests', status: 'pending' },
	]);
	eq(todos.length, 3, 'all three items are kept');
	eq(todos[0].content, 'read the config', 'content is trimmed');
	eq(todos[1].status, 'in_progress', 'statuses are preserved');
}

{
	const bad: Array<[string, unknown]> = [
		['a non-array', 'not a list'],
		['a null item', [null]],
		['empty content', [{ content: '   ', status: 'pending' }]],
		['a missing status', [{ content: 'x' }]],
		['an unknown status', [{ content: 'x', status: 'done' }]],
	];
	for (const [name, raw] of bad) {
		let threw = false;
		try { canonicalizeTodos(raw); } catch { threw = true; }
		ok(threw, `${name} is rejected`);
	}
}

{
	// Duplicate content would make "mark item X done" ambiguous.
	let threw = false;
	try {
		canonicalizeTodos([
			{ content: 'same', status: 'pending' },
			{ content: 'same', status: 'completed' },
		]);
	} catch { threw = true; }
	ok(threw, 'duplicate content is rejected');
}

{
	// Two items in progress is a lie for a serial agent.
	let threw = false;
	try {
		canonicalizeTodos([
			{ content: 'a', status: 'in_progress' },
			{ content: 'b', status: 'in_progress' },
		]);
	} catch { threw = true; }
	ok(threw, 'two in_progress items are rejected');
}

{
	// ...unless the deployment explicitly allows parallel work (dsh parity).
	const parallel = canonicalizeTodos([
		{ content: 'a', status: 'in_progress' },
		{ content: 'b', status: 'in_progress' },
	], true);
	eq(parallel.length, 2, 'allowParallel=true accepts several active items');
}

{
	eq(canonicalizeTodos([]).length, 0, 'an empty list is valid (it clears the plan)');
}

// ---------------------------------------------------------------------------
// 2. Whole-list replacement
// ---------------------------------------------------------------------------
console.log('\n[todo] whole-list replacement');

{
	const list = new TodoList();
	list.replace([{ content: 'a', status: 'in_progress' }]);
	eq(list.items.length, 1, 'the first write sets the list');
	list.replace([
		{ content: 'a', status: 'completed' },
		{ content: 'b', status: 'pending' },
	]);
	eq(list.items.length, 2, 'a second write replaces, it does not append');
	eq(list.items[0].status, 'completed', 'the status update from the second write wins');
	list.replace([]);
	eq(list.isEmpty, true, 'an empty write clears the list');
}

{
	// The stored array must not alias the caller's (a caller mutating its own array
	// would silently rewrite the agent's plan).
	const list = new TodoList();
	const mine: ITodoItem[] = [{ content: 'a', status: 'pending' }];
	list.replace(mine);
	mine.push({ content: 'b', status: 'pending' });
	eq(list.items.length, 1, 'the stored list does not alias the caller array');
}

// ---------------------------------------------------------------------------
// 3. Rendering
// ---------------------------------------------------------------------------
console.log('\n[todo] rendering');

{
	const todos: ITodoItem[] = [
		{ content: 'explore', status: 'completed' },
		{ content: 'implement', status: 'in_progress' },
		{ content: 'verify', status: 'pending' },
	];
	eq(summarizeTodos(todos), '1/3 done, 1 in progress', 'the summary counts done and active');
}

{
	const todos: ITodoItem[] = [
		{ content: 'explore', status: 'completed' },
		{ content: 'implement', status: 'in_progress' },
		{ content: 'verify', status: 'pending' },
	];
	const plain = formatTodoList(todos);
	ok(plain.includes('[x]'), 'a completed item shows [x]');
	ok(plain.includes('[~]'), 'the active item shows [~]');
	ok(plain.includes('[ ]'), 'a pending item shows [ ]');
	ok(plain.includes('1/3 done'), 'the header shows progress');
	eq(plain.includes('\x1b'), false, 'plain rendering has no ANSI');

	const colored = formatTodoList(todos, { color: true });
	ok(colored.includes('\x1b[32m'), 'completed items are green when color is on');
	ok(colored.includes('\x1b[33m'), 'the active item is yellow when color is on');
}

{
	eq(formatTodoList([]), '', 'an empty list renders nothing');
}

// ---------------------------------------------------------------------------
// 4. The tool itself
// ---------------------------------------------------------------------------
console.log('\n[todo] tool behaviour');

{
	const list = new TodoList();
	const tool = new TodoWriteTool(list);
	eq(tool.name, 'todo_write', 'the tool is named todo_write');

	const ok1 = await tool.execute({
		_id: 1, _toolCallId: 'call-1',
		todos: [
			{ content: 'read', status: 'completed' },
			{ content: 'write', status: 'in_progress' },
		],
	});
	ok(ok1.success, 'a valid list succeeds');
	ok(ok1.output.includes('1/2 done'), 'the confirmation reports progress');
	ok(ok1.output.includes('write'), 'the confirmation names the active item');
	eq(ok1.output.includes('[~]'), false, 'the model-facing output has no glyphs');
	eq(ok1.output.includes('\x1b'), false, 'the model-facing output has no ANSI');
}

{
	const list = new TodoList();
	const tool = new TodoWriteTool(list);
	const bad = await tool.execute({
		todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }],
	});
	eq(bad.success, false, 'an invalid list fails instead of being silently fixed');
	ok((bad.error ?? '').includes('in_progress'), 'the error names the offending constraint');
	eq(list.isEmpty, true, 'a rejected write does not touch the existing list');
}

{
	const list = new TodoList();
	const tool = new TodoWriteTool(list);
	list.replace([{ content: 'stale', status: 'pending' }]);
	const cleared = await tool.execute({ todos: [] });
	ok(cleared.success, 'an empty list is accepted');
	eq(list.isEmpty, true, 'an empty list clears the plan');
}

{
	// Cancellation must not write.
	const list = new TodoList();
	const tool = new TodoWriteTool(list);
	const controller = new AbortController();
	controller.abort();
	const cancelled = await tool.execute({ todos: [{ content: 'x', status: 'pending' }] }, controller.signal);
	eq(cancelled.success, false, 'an aborted call fails');
	eq(list.isEmpty, true, 'an aborted call does not write');
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);