/*---------------------------------------------------------------------------------------------
 *  todo_write tool - a model-owned task checklist for multi-step work
 *
 *  Ported from deepseek-harness `packages/todo/tool-todo`. The value is not the
 *  storage (a few strings) but the OBSERVABILITY: a long agent run otherwise shows
 *  only a stream of tool calls, and neither the user nor the agent can see how far
 *  into the plan it is or what is left.
 *
 *  Contract, matching dsh:
 *    - every call replaces the COMPLETE list (last write wins) — there is no
 *      per-item edit or delete, so the model always states the whole plan and can
 *      never leave a stale half-deleted list behind;
 *    - `content` must be non-empty and unique, otherwise the call is rejected;
 *    - at most one item may be `in_progress` (this CLI runs one task at a time, so
 *      "several in progress" could not be true anyway — dsh makes this a
 *      deployment choice, `allowParallelInProgress`).
 *
 *  The host renders the checklist after every write (see `formatTodoList`), which
 *  is what makes progress visible in the terminal.
 *--------------------------------------------------------------------------------------------*/

import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from '../agentTools';

/** Lifecycle of one checklist item. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** One item of the checklist. */
export interface ITodoItem {
	readonly content: string;
	readonly status: TodoStatus;
}

const STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

/** Glyph per status, used by `formatTodoList`. */
const GLYPH: Record<TodoStatus, string> = {
	pending: '[ ]',
	in_progress: '[~]',
	completed: '[x]',
};

/**
 * Validate the model's raw list and canonicalize it.
 *
 * Mirrors dsh's `toTodoList`: trimmed non-empty unique content, known status, and
 * exactly one `in_progress` at most. Rejection is a FAILURE result rather than a
 * silent fix-up — a model that thinks it wrote "3 items, 2 in progress" must not be
 * told the write succeeded.
 */
export function canonicalizeTodos(raw: unknown, allowParallel = false): ITodoItem[] {
	if (!Array.isArray(raw)) {
		throw new Error('`todos` must be an array');
	}
	const todos: ITodoItem[] = [];
	const seen = new Set<string>();
	let active = 0;
	for (const item of raw) {
		if (typeof item !== 'object' || item === null) {
			throw new Error('each todo must be an object with `content` and `status`');
		}
		const record = item as Record<string, unknown>;
		const content = typeof record.content === 'string' ? record.content.trim() : '';
		if (!content) {
			throw new Error('`content` must be a non-empty string');
		}
		if (seen.has(content)) {
			throw new Error(`duplicate todo content ${JSON.stringify(content)}`);
		}
		seen.add(content);
		const status = record.status as TodoStatus;
		if (!STATUSES.includes(status)) {
			throw new Error(`invalid status ${JSON.stringify(record.status)} (expected pending, in_progress, or completed)`);
		}
		if (status === 'in_progress') active++;
		todos.push({ content, status });
	}
	if (!allowParallel && active > 1) {
		throw new Error(`at most one task may be in_progress (got ${active})`);
	}
	return todos;
}

/** Progress summary: "2/5 done, 1 in progress". */
export function summarizeTodos(todos: readonly ITodoItem[]): string {
	const done = todos.filter(t => t.status === 'completed').length;
	const active = todos.filter(t => t.status === 'in_progress').length;
	const parts = [`${done}/${todos.length} done`];
	if (active > 0) parts.push(`${active} in progress`);
	return parts.join(', ');
}

/**
 * Render the checklist for the terminal: a glyph per item plus a progress line.
 *
 * @param todos - the canonical list.
 * @param options.color - paint completed items dim-green, the active one yellow.
 */
export function formatTodoList(todos: readonly ITodoItem[], options: { color?: boolean } = {}): string {
	if (todos.length === 0) return '';
	const color = options.color ?? false;
	const reset = color ? '\x1b[0m' : '';
	const dim = color ? '\x1b[2m' : '';
	const green = color ? '\x1b[32m' : '';
	const yellow = color ? '\x1b[33m' : '';
	const bold = color ? '\x1b[1m' : '';

	const lines = todos.map(todo => {
		const glyph = GLYPH[todo.status];
		if (todo.status === 'completed') return `  ${green}${glyph}${reset} ${dim}${todo.content}${reset}`;
		if (todo.status === 'in_progress') return `  ${yellow}${glyph} ${bold}${todo.content}${reset}`;
		return `  ${dim}${glyph}${reset} ${todo.content}`;
	});
	return `${bold}Plan${reset} ${dim}(${summarizeTodos(todos)})${reset}\n${lines.join('\n')}`;
}

/**
 * A checklist the agent keeps up to date across a run.
 *
 * Deliberately NOT part of `AgentContext`: the list is display/planning state, and
 * putting it in the message history would make the model re-read its own checklist
 * as conversation on every request.
 */
export class TodoList {
	private _items: ITodoItem[] = [];

	get items(): readonly ITodoItem[] {
		return this._items;
	}

	get isEmpty(): boolean {
		return this._items.length === 0;
	}

	/** Replace the whole list (last write wins, matching dsh's replay semantics). */
	replace(items: readonly ITodoItem[]): void {
		this._items = [...items];
	}

	clear(): void {
		this._items = [];
	}
}

export class TodoWriteTool extends AgentTool {
	readonly name = 'todo_write';
	// The active-status clause is the only part that varies with configuration;
	// this CLI is serial, so it asks for exactly one active item.
	readonly description =
		'Record and update a task list to plan multi-step work and show progress; skip it for '
		+ 'trivial single-step tasks. Add one todo per concrete step before you start. '
		+ 'While work remains, keep exactly one todo `in_progress`. '
		+ 'Mark each todo `completed` as soon as it is done.';

	readonly parameters = {
		type: 'object',
		properties: {
			todos: {
				type: 'array',
				description: 'The COMPLETE task list, replacing any previous list.',
				items: {
					type: 'object',
					additionalProperties: false,
					properties: {
						content: {
							type: 'string',
							description: 'What the task is — a short imperative line.',
						},
						status: {
							type: 'string',
							enum: [...STATUSES],
							description: 'pending (not started) | in_progress (now) | completed (done).',
						},
					},
					required: ['content', 'status'],
				},
			},
		},
		required: ['todos'],
	};

	constructor(private readonly _list: TodoList) {
		super();
	}

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = args._toolCallId as string || '';
		if (signal?.aborted) {
			return this.failure(toolCallId, 'Tool execution cancelled by user');
		}

		let todos: ITodoItem[];
		try {
			todos = canonicalizeTodos(args.todos);
		} catch (err) {
			return this.failure(toolCallId, `invalid todos: ${(err as Error).message}`);
		}

		this._list.replace(todos);

		// Model-facing output stays plain (no glyphs/ANSI): the user sees the
		// rendered checklist, the model only needs confirmation and the counts.
		if (todos.length === 0) {
			return this.success(toolCallId, 'Cleared the task list.');
		}
		const remaining = todos.filter(t => t.status !== 'completed').length;
		const active = todos.find(t => t.status === 'in_progress');
		return this.success(
			toolCallId,
			`Task list updated: ${summarizeTodos(todos)}.`
			+ (active ? ` Current: ${active.content}` : '')
			+ (remaining === 0 ? ' All steps are complete.' : ''),
		);
	}
}