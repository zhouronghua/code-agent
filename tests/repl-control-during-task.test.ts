/*---------------------------------------------------------------------------------------------
 *  Unit tests: REPL control commands typed DURING a running task
 *
 *  The bug: while `agentLoop.run(task)` was awaiting, the `line` handler buffered
 *  every non-`/btw` line, so `/mode ask`, `/tasks`, `/sessions`, `exit` — all local
 *  and read-only-ish — did nothing until the task finished. With a 20-minute build
 *  that is 20 minutes of a dead REPL.
 *
 *  These tests pin the fixed contract:
 *    1. control commands route to 'immediate' (never 'buffer')
 *    2. real prompts still buffer FIFO
 *    3. destructive/mid-run-unsafe commands are refused with a message
 *    4. the `/session` list-vs-resume split is resolved correctly
 *
 *  Run:
 *    npx esbuild tests/repl-control-during-task.test.ts --bundle --platform=node \
 *      --target=node18 --format=esm --outfile=/tmp/repl.test.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/repl.test.mjs
 *--------------------------------------------------------------------------------------------*/

import {
	decideRunningLine,
	refusalMessage,
	splitCommand,
} from 'vs/workbench/contrib/agent/common/agentReplInput';

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

/** Assert both the route and, when given, the matched command. */
function route(line: string, expected: string, msg: string, command?: string): void {
	const decision = decideRunningLine(line);
	eq(decision.route, expected, msg);
	if (command !== undefined) eq(decision.command, command, `${msg} — command`);
}

// ---------------------------------------------------------------------------
// 1. THE BUG: control commands must not be buffered
// ---------------------------------------------------------------------------
console.log('\n[repl] control commands are immediate (the reported bug)');

// These are exactly the commands a user reaches for when a long task is running.
route('/mode ask', 'immediate', '/mode is not buffered while running', '/mode');
route('/mode agent', 'immediate', '/mode agent is not buffered while running', '/mode');
route('/stream', 'immediate', '/stream toggles immediately', '/stream');
route('/auto-save', 'immediate', '/auto-save toggles immediately', '/auto-save');
route('/tasks', 'immediate', '/tasks lists logs immediately', '/tasks');
route('/task t-123', 'immediate', '/task shows a log immediately', '/task');
route('/delete-task t-123', 'immediate', '/delete-task is immediate', '/delete-task');
route('/sessions', 'immediate', '/sessions lists immediately', '/sessions');
route('/delete-session s-1', 'immediate', '/delete-session is immediate', '/delete-session');
route('/skills', 'immediate', '/skills lists immediately', '/skills');
route('/profiles', 'immediate', '/profiles lists immediately', '/profiles');
route('/help', 'immediate', '/help prints immediately', '/help');
route('/save checkpoint', 'immediate', '/save writes immediately', '/save');
route('/cancel', 'immediate', '/cancel is a signal to the agent', '/cancel');

// Quitting must never wait for a build to finish.
route('exit', 'immediate', 'exit quits immediately');
route('quit', 'immediate', 'quit quits immediately');
route('/exit', 'immediate', '/exit quits immediately');
route('/quit', 'immediate', '/quit quits immediately');

// /btw keeps its own route so it can be injected into the agent, not the REPL.
route('/btw check the logs', 'btw', '/btw still routes to the agent', '/btw');
route('/btw cancel', 'btw', '/btw cancel still routes to the agent', '/btw');

// Every "immediate" route must carry a non-empty reason for the log line.
for (const line of ['/mode ask', '/tasks', '/stream', 'exit', '/help']) {
	const decision = decideRunningLine(line);
	ok(!!decision.reason, `${line}: the route carries an explanation`);
}

// ---------------------------------------------------------------------------
// 2. Real prompts still buffer (overlap would corrupt the context window)
// ---------------------------------------------------------------------------
console.log('\n[repl] real prompts still queue');

route('fix the failing test', 'buffer', 'a plain prompt is queued');
route('refactor the diff renderer', 'buffer', 'another prompt is queued');
route('  spaced prompt  ', 'buffer', 'surrounding whitespace is tolerated');
route('', 'buffer', 'an empty line is ignored, not executed');

// A prompt that merely CONTAINS a command word must not be mistaken for one.
route('why does /mode not work?', 'buffer', 'a prompt mentioning /mode stays a prompt');

// ---------------------------------------------------------------------------
// 3. Mid-run-unsafe commands are refused, loudly
// ---------------------------------------------------------------------------
console.log('\n[repl] unsafe commands are refused with a message');

route('/profile prod', 'refuse', '/profile is refused while running', '/profile');
route('/resume s-1', 'refuse', '/resume is refused while running', '/resume');
route('/resume', 'refuse', '/resume with no id is also refused', '/resume');
route('/new', 'refuse', '/new is refused while running', '/new');
route('/parallel "a" "b"', 'refuse', '/parallel is refused while running', '/parallel');
route('/skill cpp-forge', 'refuse', '/skill is refused while running', '/skill');
route('/use-skill cpp-forge', 'refuse', '/use-skill is refused while running', '/use-skill');
// The agent itself throws "Agent is already running" for /continue, so running it
// mid-task can only produce a confusing error — refuse it up front instead.
route('/continue', 'refuse', '/continue is refused while another task runs', '/continue');
route('continue', 'buffer', 'bare "continue" is a prompt, not the command');

// ...but when no task is running, /continue is exactly the right command.
{
	const idle = decideRunningLine('/continue', { agentRunning: false });
	eq(idle.route, 'immediate', '/continue is immediate when no task runs');
	eq(idle.command, '/continue', '/continue is recognised when idle');
	ok(!!idle.reason, '/continue carries a reason when idle');
}

{
	const decision = decideRunningLine('/profile prod');
	const message = refusalMessage(decision);
	ok(message.includes('/profile'), 'the refusal names the command');
	ok(message.includes('running'), 'the refusal explains that a task is running');
	ok(message.includes('/btw cancel'), 'the refusal tells the user how to stop the task');
}

// ---------------------------------------------------------------------------
// 4. /sessions exists; a bare /session does not (regression guard)
// ---------------------------------------------------------------------------
console.log('\n[repl] /sessions vs /session');

route('/sessions', 'immediate', 'the real command lists sessions immediately', '/sessions');
// '/session' is offered by Tab-completion but has no handler. Treating it as
// 'immediate' would print "running it now" and do nothing, so it must be refused
// as unknown instead of being forwarded to the LLM as a prompt.
route('/session', 'refuse', 'the handler-less /session is refused, not buffered', '/session');
ok(refusalMessage(decideRunningLine('/session')).includes('/help'),
	'the /session refusal points at /help');

// ---------------------------------------------------------------------------
// 5. Unknown commands are refused instead of silently queued
// ---------------------------------------------------------------------------
console.log('\n[repl] unknown commands');

route('/frobnicate', 'refuse', 'an unknown command is refused', '/frobnicate');
ok(refusalMessage(decideRunningLine('/frobnicate')).includes('/help'), 'the refusal points at /help');

// ---------------------------------------------------------------------------
// 6. Command splitting
// ---------------------------------------------------------------------------
console.log('\n[repl] splitCommand');

{
	const split = splitCommand('/mode   ask');
	eq(split.command, '/mode', '/mode with extra spaces parses');
	eq(split.rest, 'ask', 'the argument is trimmed');
}
{
	const split = splitCommand('/MODE ask');
	eq(split.command, '/mode', 'the command is case-folded');
	eq(split.rest, 'ask', 'the argument keeps its case');
}
{
	const split = splitCommand('/help');
	eq(split.command, '/help', 'a bare command has no argument');
	eq(split.rest, '', 'a bare command yields an empty rest');
}
{
	const split = splitCommand('plain task text');
	eq(split.command, undefined, 'a non-slash line has no command');
	eq(split.rest, 'plain task text', 'the whole line is the rest');
}

// ---------------------------------------------------------------------------
// 4. Every command the completer advertises must be handled
// ---------------------------------------------------------------------------
console.log('\n[repl] advertised commands are all handled');

// The completer (`createCompleter` in main.ts) offers these via Tab. Any of them
// that has no handler would be forwarded to the LLM as a prompt — `typing /help`
// literally asked the model to "do" /help. The router is the single place that
// can be asserted, so pin the list here.
const ADVERTISED = [
	'/resume', '/mode', '/profile', '/skill', '/use-skill',
	'/save', '/sessions', '/new', '/auto-save', '/btw',
	'/stream', '/profiles', '/skills', '/parallel',
	'/continue', '/delete-session', '/help',
	'/tasks', '/task', '/delete-task',
];

for (const command of ADVERTISED) {
	const decision = decideRunningLine(command);
	// The real assertion: a known command is never treated as a plain prompt (which
	// is how `/help` used to end up being sent to the model as a task).
	ok(decision.route !== 'buffer', `${command} is not silently queued as a prompt`);
	ok(!!decision.command, `${command} is recognised as a command`);
	ok(decision.route !== 'refuse' || !decision.reason?.startsWith('unknown'),
		`${command} is a known command (not "unknown")`);
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);