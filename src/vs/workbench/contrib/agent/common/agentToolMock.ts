/*---------------------------------------------------------------------------------------------
 *  Agent Tool Mock - record / replay tool results so repeated runs agree
 *
 *  A regression benchmark re-runs the SAME task many times. The LLM is
 *  non-deterministic anyway, but the tool layer adds avoidable variance on top:
 *  `list_directory` returns entries in filesystem order, `run_terminal` prints
 *  timings/paths, `read_file` echoes the temp workspace path, and every tool call
 *  costs wall-clock time. Recording the results once and replaying them makes
 *  the tool layer identical across runs, so a diff in the benchmark numbers
 *  comes from the agent (prompt/loop/model), not from tool noise.
 *
 *  Scope is deliberately conservative: only READ-ONLY tools are mocked by
 *  default (`read_file`, `list_directory`, `search_text`, `search_files`,
 *  `search_content`). Side-effecting tools (`write_file`, `edit_file`,
 *  `run_terminal`, `poll`) keep executing for real, otherwise a mocked
 *  `write_file` would leave the workspace untouched and every task would fail
 *  its own verification.
 *
 *  Modes
 *    off     (default) — tools run normally, nothing is written
 *    record  — every call executes live, the result is stored in the fixture
 *    replay  — a stored result is returned when available; a MISS executes the
 *              real tool once and appends the result to the fixture, so a
 *              partial fixture self-heals (`--tool-mock-strict` turns a miss
 *              into a failed tool result instead)
 *
 *  CLI      --tool-mock <off|record|replay> | --tool-mock-file <json>
 *           --tool-mock-tools <read|all|csv> | --tool-mock-strict
 *  Env      AGENT_TOOL_MOCK | AGENT_TOOL_MOCK_FILE | AGENT_TOOL_MOCK_TOOLS
 *           AGENT_TOOL_MOCK_STRICT
 *
 *  Fixture format (JSON, keyed by tool name + normalized arguments):
 *    { "version": 1, "workspace": "{{WS}}", "entries": {
 *        "read_file\u0000{\"path\":\"{{WS}}/README.md\"}": [ { "success": true, "output": "…" } ] } }
 *
 *  The workspace root and the home directory are tokenized (`{{WS}}`, `{{HOME}}`)
 *  in both the keys and the stored outputs, so a fixture recorded in one temp
 *  workspace replays correctly in the next one — which is exactly how the
 *  benchmark runs (a fresh `mkdtemp` per task).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IAgentConfig, IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool, ToolRegistry } from './agentTools';

export type ToolMockMode = 'off' | 'record' | 'replay';

/** Tools mocked when no explicit list is given (read-only, no side effects). */
export const READ_ONLY_MOCK_TOOLS = [
	'read_file',
	'list_directory',
	'search_text',
	'search_files',
	'search_content',
];

export interface ToolMockOptions {
	mode: ToolMockMode;
	/** Fixture file (created on first record). Empty when mode is `off`. */
	file: string;
	/** Tool names to mock; `undefined` = every registered tool. */
	tools?: string[];
	/** replay: a missing fixture entry fails the tool instead of running it live. */
	strict?: boolean;
	/** Path tokenized as `{{WS}}` (default: process.cwd()). */
	workspace?: string;
}

/** One recorded tool result. */
interface MockEntry {
	success: boolean;
	output: string;
	error?: string;
	/** ISO timestamp — informational only, never compared. */
	recordedAt?: string;
}

interface MockFixture {
	version: number;
	createdAt: string;
	/** Workspace the fixture was recorded in (informational). */
	workspace: string;
	entries: Record<string, MockEntry[]>;
}

const WS_TOKEN = '{{WS}}';
const HOME_TOKEN = '{{HOME}}';

/** Replace `from` with `to` everywhere in `text` (plain substring semantics). */
function substitute(text: string, pairs: Array<[string, string]>): string {
	let out = text;
	for (const [from, to] of pairs) {
		if (!from) continue;
		out = out.split(from).join(to);
	}
	return out;
}

/**
 * Build the substitution table, most specific path first: replacing the
 * workspace before the home dir keeps a workspace that lives under `$HOME`
 * tokenized into `{{WS}}` instead of `{{HOME}}/…`.
 */
function tokenPairs(workspace: string): Array<[string, string]> {
	const home = os.homedir();
	const pairs: Array<[string, string]> = [];
	if (workspace) pairs.push([path.resolve(workspace), WS_TOKEN]);
	if (home) pairs.push([home, HOME_TOKEN]);
	return pairs.sort((a, b) => b[0].length - a[0].length);
}

/** Normalize a JSON-ish argument value: strip absolute paths, sort object keys. */
function normalizeValue(value: unknown, pairs: Array<[string, string]>): unknown {
	if (typeof value === 'string') return substitute(value, pairs);
	if (Array.isArray(value)) return value.map(v => normalizeValue(v, pairs));
	if (value && typeof value === 'object') {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) out[key] = normalizeValue(source[key], pairs);
		return out;
	}
	return value;
}

/** Parse `--tool-mock-tools` / `AGENT_TOOL_MOCK_TOOLS`. */
export function parseToolMockTools(spec?: string): string[] | undefined {
	if (!spec) return READ_ONLY_MOCK_TOOLS;
	const value = spec.trim();
	if (!value) return READ_ONLY_MOCK_TOOLS;
	if (value === 'all' || value === '*') return undefined;
	if (value === 'read' || value === 'read-only' || value === 'readonly') return READ_ONLY_MOCK_TOOLS;
	const names = value.split(',').map(s => s.trim()).filter(Boolean);
	return names.length > 0 ? names : READ_ONLY_MOCK_TOOLS;
}

function normalizeMode(raw?: string): ToolMockMode {
	const value = (raw || '').trim().toLowerCase();
	if (!value || value === 'off' || value === '0' || value === 'false' || value === 'no') return 'off';
	if (value === 'record' || value === 'rec' || value === 'on' || value === '1') return 'record';
	if (value === 'replay' || value === 'play') return 'replay';
	return 'off';
}

/** Per-run tool mock configuration (CLI > env > off). */
export function resolveToolMockOptions(
	cli: { mode?: string; file?: string; tools?: string; strict?: boolean } = {},
	env: NodeJS.ProcessEnv = process.env,
	defaultDir: string = process.cwd(),
): ToolMockOptions {
	const mode = normalizeMode(cli.mode ?? env.AGENT_TOOL_MOCK);
	if (mode === 'off') {
		return { mode: 'off', file: '', tools: READ_ONLY_MOCK_TOOLS, strict: false, workspace: process.cwd() };
	}

	const fileRaw = cli.file || env.AGENT_TOOL_MOCK_FILE || '';
	const file = fileRaw
		? path.resolve(fileRaw.replace(/^~(?=\/|$)/, os.homedir()))
		: path.join(defaultDir, 'tool-mocks', 'default.json');

	const strict = cli.strict !== undefined
		? cli.strict
		: ['1', 'true', 'yes', 'on'].includes((env.AGENT_TOOL_MOCK_STRICT || '').trim().toLowerCase());

	return {
		mode,
		file,
		tools: parseToolMockTools(cli.tools ?? env.AGENT_TOOL_MOCK_TOOLS),
		strict,
		workspace: process.cwd(),
	};
}

/**
 * Record/replay store backed by one JSON fixture file.
 *
 * Determinism details:
 *  - the lookup key is `toolName` + the arguments with `_`-prefixed transport
 *    fields (`_toolCallId`) removed, workspace/home paths tokenized and keys
 *    sorted, so it survives `mkdtemp` workspaces and key-order changes;
 *  - the N-th identical call consumes the N-th recorded entry (a loop may read
 *    the same file twice and get two distinct results);
 *  - a replay MISS runs the real tool and appends the result, so an incomplete
 *    fixture never turns into a broken benchmark run.
 */
export class ToolMockStore {
	private _fixture: MockFixture;
	private readonly _counters = new Map<string, number>();
	private readonly _tokens: Array<[string, string]>;

	constructor(readonly options: ToolMockOptions) {
		this._tokens = tokenPairs(options.workspace || process.cwd());
		this._fixture = this._load();
	}

	get file(): string { return this.options.file; }
	get mode(): ToolMockMode { return this.options.mode; }
	get entryCount(): number {
		return Object.values(this._fixture.entries).reduce((sum, list) => sum + list.length, 0);
	}

	private _load(): MockFixture {
		const empty: MockFixture = {
			version: 1,
			createdAt: new Date().toISOString(),
			workspace: WS_TOKEN,
			entries: {},
		};
		if (!this.options.file || !fs.existsSync(this.options.file)) return empty;
		try {
			const parsed = JSON.parse(fs.readFileSync(this.options.file, 'utf-8'));
			if (!parsed || typeof parsed !== 'object' || typeof parsed.entries !== 'object' || parsed.entries === null) {
				return empty;
			}
			return {
				version: parsed.version ?? 1,
				createdAt: parsed.createdAt ?? new Date().toISOString(),
				workspace: parsed.workspace ?? WS_TOKEN,
				entries: parsed.entries as Record<string, MockEntry[]>,
			};
		} catch {
			// A corrupt fixture must not break the run: start from empty and
			// overwrite it on the next recorded call.
			return empty;
		}
	}

	private _save(): void {
		if (!this.options.file) return;
		try {
			fs.mkdirSync(path.dirname(this.options.file), { recursive: true });
			fs.writeFileSync(this.options.file, JSON.stringify(this._fixture, null, 2), 'utf-8');
		} catch {
			/* a read-only fixture dir must not break the agent */
		}
	}

	/** Deterministic key for a call: tool name + tokenized, sorted arguments. */
	keyFor(toolName: string, args: Record<string, unknown>): string {
		const clean: Record<string, unknown> = {};
		for (const key of Object.keys(args).sort()) {
			if (key.startsWith('_')) continue;   // _toolCallId etc. differ on every call
			clean[key] = normalizeValue(args[key], this._tokens);
		}
		return `${toolName}\u0000${JSON.stringify(clean)}`;
	}

	/** Next occurrence index for a key (0-based, shared across the process). */
	private _nextIndex(key: string): number {
		const index = this._counters.get(key) ?? 0;
		this._counters.set(key, index + 1);
		return index;
	}

	/** Tokenize/de-tokenize helpers used for stored outputs. */
	detokenize(text: string): string {
		return substitute(text, this._tokens.map(([real, token]) => [token, real] as [string, string]));
	}

	private _tokenize(text: string): string {
		return substitute(text, this._tokens);
	}

	/**
	 * Execute (record) or look up (replay) one tool call.
	 *
	 * `toolCallId` always comes from the CURRENT call so the agent's tool-call
	 * pairing stays intact regardless of what was recorded.
	 */
	async invoke(
		tool: AgentTool,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<IToolResult> {
		const toolCallId = (args._toolCallId as string) || '';
		if (this.options.mode === 'off') return tool.execute(args, signal);

		const key = this.keyFor(tool.name, args);
		const index = this._nextIndex(key);

		if (this.options.mode === 'replay') {
			const entry = this._fixture.entries[key]?.[index];
			if (entry) {
				return {
					toolCallId,
					success: entry.success,
					output: this.detokenize(entry.output ?? ''),
					error: entry.error === undefined ? undefined : this.detokenize(entry.error),
				};
			}
			if (this.options.strict) {
				return {
					toolCallId,
					success: false,
					output: '',
					error: `tool mock: no recorded result for ${tool.name} (call #${index + 1}) in ${this.options.file}`,
				};
			}
			// Miss → run live and remember it, so the next replay is complete.
			const live = await tool.execute(args, signal);
			this._record(key, index, live);
			return live;
		}

		const live = await tool.execute(args, signal);
		this._record(key, index, live);
		return live;
	}

	private _record(key: string, index: number, result: IToolResult): void {
		const list = this._fixture.entries[key] ?? (this._fixture.entries[key] = []);
		list[index] = {
			success: result.success,
			output: this._tokenize(result.output ?? ''),
			error: result.error === undefined ? undefined : this._tokenize(result.error),
			recordedAt: new Date().toISOString(),
		};
		this._fixture.createdAt = this._fixture.createdAt || new Date().toISOString();
		this._save();
	}
}

/** A tool that answers from the mock store instead of touching the workspace. */
export class MockedAgentTool extends AgentTool {
	constructor(private readonly _inner: AgentTool, private readonly _store: ToolMockStore) {
		super();
	}

	get name(): string { return this._inner.name; }
	get description(): string { return this._inner.description; }
	get parameters(): Record<string, unknown> { return this._inner.parameters; }

	override timeoutFor(args: Record<string, unknown>, config: IAgentConfig): number | undefined {
		return this._inner.timeoutFor(args, config);
	}

	override execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		return this._store.invoke(this._inner, args, signal);
	}
}

/**
 * Wrap the selected tools of a registry with the mock layer. Returns the number
 * of wrapped tools (0 when the mode is `off` or nothing matched).
 */
export function installToolMock(
	registry: ToolRegistry,
	store: ToolMockStore,
	log?: (message: string) => void,
): number {
	if (store.mode === 'off') return 0;
	const wanted = store.options.tools;
	let wrapped = 0;

	registry.decorate(tool => {
		if (wanted && !wanted.includes(tool.name)) return tool;
		wrapped++;
		return new MockedAgentTool(tool, store);
	});

	log?.(`${store.mode} → ${store.file} | ${wrapped} tool(s)${wanted ? `: ${wanted.filter(n => registry.has(n)).join(', ')}` : ' (all)'}`);
	return wrapped;
}
