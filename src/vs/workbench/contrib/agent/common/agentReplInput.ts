/*---------------------------------------------------------------------------------------------
 *  Agent REPL Input Router - decide what a line typed during a RUNNING task does
 *
 *  THE BUG THIS FIXES
 *  While `agentLoop.run(task)` is awaiting, the REPL's `line` handler used to have
 *  exactly two behaviours for a line typed by the user:
 *
 *      if (trimmed.startsWith('/btw ')) { …inject into the agent… }
 *      else { bufferedLines.push(trimmed); }        // ← everything else
 *
 *  So EVERY other control command — `/mode ask`, `/stream`, `/tasks`, `/sessions`,
 *  `/save`, `exit` — was silently queued and only ran after the current task
 *  finished. For a 20-minute build that means the user cannot switch modes, list
 *  sessions, inspect a task log, or even quit without waiting. The commands are
 *  LOCAL (they touch the REPL's own state, not the agent's reasoning), so they do
 *  not need to wait at all.
 *
 *  THE MODEL
 *  A typed line is classified into exactly one of four routes:
 *
 *    'btw'        → /btw …: injected into the running agent (hint or supersede).
 *    'immediate'  → a control command that is safe to run NOW, concurrently with
 *                   the agent: local state, read-only output, or a signal to the
 *                   agent (cancel/continue). Running it cannot corrupt the run.
 *    'buffer'     → a real task prompt: queued FIFO and processed after the
 *                   current task (overlapping prompts would interleave two
 *                   conversations in one context window).
 *    'refuse'     → a command that WOULD mutate run state (`/profile`, `/resume`,
 *                   `/new`, `/parallel`, `/skill`) or start real work; refusing is
 *                   explicit so the user is never left guessing why nothing
 *                   happened. The message says what to do instead.
 *
 *  Classification is a pure function of the line, so it is unit-tested without a
 *  terminal (tests/repl-control-during-task.test.ts).
 *--------------------------------------------------------------------------------------------*/

/** What the REPL should do with a line typed while the agent is running. */
export type RunningLineRoute = 'btw' | 'immediate' | 'buffer' | 'refuse';

/** Classification result: the route plus a short reason for the log line. */
export interface IRunningLineDecision {
	readonly route: RunningLineRoute;
	/** Control command name (`/mode`, `exit`, …) when the line is a slash command. */
	readonly command?: string;
	/** Human-readable explanation, printed for 'refuse' (and 'immediate' when notable). */
	readonly reason?: string;
}

/**
 * Commands that are safe to execute WHILE a task runs.
 *
 * Criteria — all three must hold:
 *  1. It reads or writes only REPL-level state (stream flag, auto-save flag,
 *     sessions/task-log files, display), never the agent's message history.
 *  2. Or it is a SIGNAL to the agent rather than a state swap (`/btw cancel`,
 *     `/cancel`).
 *  3. It cannot start a task, swap the provider, or restart the conversation.
 *
 * Every entry here has a real handler in the REPL. An entry without one would be
 * worse than buffering: the user would see "running it now" and nothing happens.
 *
 * Deliberately absent (see REFUSED_COMMANDS): `/profile` (the 保底 wiring depends on
 * the profile object; swapping mid-run leaves the loop on a disposed provider),
 * `/resume` / `/new` (they replace the history the running loop is still writing),
 * `/parallel` (starts more agents), `/continue` (the agent itself throws
 * "Agent is already running").
 */
const IMMEDIATE_COMMANDS: ReadonlyMap<string, string> = new Map([
	['/mode', 'applies to subsequent tasks; the running task keeps the tool set it started with'],
	['/stream', 'takes effect on the next step'],
	['/auto-save', 'takes effect for the next auto-save'],
	['/tasks', 'lists saved task logs'],
	['/task', 'shows one saved task log'],
	['/delete-task', 'deletes one saved task log'],
	['/sessions', 'lists saved sessions'],
	['/delete-session', 'deletes one saved session'],
	['/skills', 'lists loaded skills'],
	['/profiles', 'lists configured profiles'],
	['/help', 'prints the command list'],
	['/save', 'snapshots the conversation so far'],
	['/btw', 'injects a hint or cancels the current tool'],
	['/cancel', 'cancels the current tool (alias for /btw cancel)'],
]);

/** Why `/continue` is allowed when no task is running. */
const CONTINUE_IDLE_REASON = 'resumes a run that stopped at the step limit';

/**
 * Commands that must NOT run while a task runs, and why.
 *
 * Refused LOUDLY rather than queued silently: the user pressed Enter and expects
 * either an effect or an explanation, not a line that fires twenty minutes later.
 */
const REFUSED_COMMANDS: ReadonlyMap<string, string> = new Map([
	['/profile', 'switching the provider mid-run would leave the running loop on a disposed provider — finish the task or /btw cancel first'],
	['/resume', 'restoring a session replaces the message history the running task is still writing to'],
	['/new', 'starting a new session replaces the message history the running task is still writing to'],
	['/parallel', 'parallel mode starts additional agents — run it when idle'],
	['/skill', 'activating a skill rewrites the system prompt of the running task'],
	['/use-skill', 'activating a skill rewrites the system prompt of the running task'],
	['/continue', 'the agent is already running; /continue resumes a run that stopped at the step limit'],
]);

/** Bare words that terminate the REPL (checked before the slash-command tables). */
const EXIT_COMMANDS = new Set(['exit', 'quit', 'q', '/exit', '/quit']);

/**
 * Split `"/mode ask"` into `{ command: '/mode', rest: 'ask' }`.
 * A line that does not start with `/` has no command.
 */
export function splitCommand(line: string): { command?: string; rest: string } {
	const trimmed = line.trim();
	if (!trimmed.startsWith('/')) return { rest: trimmed };
	const space = trimmed.indexOf(' ');
	if (space < 0) return { command: trimmed.toLowerCase(), rest: '' };
	return { command: trimmed.slice(0, space).toLowerCase(), rest: trimmed.slice(space + 1).trim() };
}

/**
 * Decide what a line typed during a running task should do.
 *
 * Pure: no I/O, no agent handle, no terminal. Every branch is reachable from a
 * unit test, which is the point — the previous behaviour was the `else` arm of a
 * single `if`, and nothing could assert that a control command was NOT buffered.
 *
 * @param line - the raw line from readline.
 * @param options.agentRunning - false when the line is being re-classified on the
 *   drain path (the agent already finished). Only `/continue` depends on this:
 *   it is refused while a task runs (the agent throws `Agent is already running`)
 *   and required when idle (it resumes a run that hit the step limit).
 */
export function decideRunningLine(
	line: string,
	options: { agentRunning?: boolean } = {},
): IRunningLineDecision {
	const trimmed = line.trim();
	if (!trimmed) return { route: 'buffer', reason: 'blank line ignored' };

	// ---- Process termination ----
	// Quitting is purely local (save + exit) and must never wait for a build.
	if (EXIT_COMMANDS.has(trimmed.toLowerCase())) {
		return { route: 'immediate', command: trimmed.toLowerCase(), reason: 'exits the REPL (cancels the running task)' };
	}

	const { command, rest } = splitCommand(trimmed);

	// ---- /btw … : the intervention channel ----
	if (command === '/btw') {
		return { route: 'btw', command, reason: rest ? `hint: ${rest}` : 'usage error' };
	}

	// ---- /continue flips route depending on whether a task is running ----
	if (command === '/continue') {
		return options.agentRunning === false
			? { route: 'immediate', command, reason: CONTINUE_IDLE_REASON }
			: { route: 'refuse', command, reason: REFUSED_COMMANDS.get(command) };
	}

	// ---- Refused while running (checked before 'immediate') ----
	if (command && REFUSED_COMMANDS.has(command)) {
		return { route: 'refuse', command, reason: REFUSED_COMMANDS.get(command) };
	}

	// ---- Control commands that are safe right now ----
	if (command && IMMEDIATE_COMMANDS.has(command)) {
		return { route: 'immediate', command, reason: IMMEDIATE_COMMANDS.get(command) };
	}

	// ---- An unknown slash command: do not silently queue it as a prompt ----
	// The old `else` arm pushed this into bufferedLines, so a typo'd command was
	// eventually sent to the LLM as a task. Refusing is the honest answer.
	if (command) {
		return { route: 'refuse', command, reason: `unknown command "${command}" — type /help for the list` };
	}

	// ---- A real prompt: queue it. Two prompts cannot share one context window. ----
	return { route: 'buffer', reason: 'queued as the next task' };
}

/**
 * The line shown to the user when a command was refused, so the refusal is never
 * a silent no-op.
 *
 * @param decision - the classification result.
 * @param whileRunning - true when a task really is executing. When the refusal
 *   comes from the idle drain path, claiming "while a task is running" would be a
 *   lie, so only the command-specific explanation is shown.
 */
export function refusalMessage(decision: IRunningLineDecision, whileRunning = true): string {
	const name = decision.command ?? 'that';
	const reason = decision.reason ?? 'not allowed';
	if (!whileRunning) return `${name}: ${reason}.`;
	return `${name} is unavailable while a task is running: ${reason}. `
		+ 'Use /btw cancel to stop the current tool, or /btw <hint> to steer it.';
}