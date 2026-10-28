/*---------------------------------------------------------------------------------------------
 *  Unit tests: state-directory control + deterministic tool layer
 *
 *  [1] `storage:` config parsing (config.yaml syntax used in the docs)
 *  [2] storage precedence: CLI → env → config.yaml → ~/.agents default
 *  [3] the redirected directories are what the session / task-log stores write to
 *  [4] tool mock: record → replay yields identical results in a NEW workspace
 *  [5] tool mock: occurrence indexing, strict miss, live fallback on a miss
 *  [6] tool mock: only read-only tools are wrapped by default
 *
 *  Run:
 *    npm run test:storage-mock
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert';

import {
	configureStorage,
	expandStoragePath,
	parseStorageYaml,
	resetStorageSettings,
	resolveStorageSettings,
	sessionsDir,
	storageNotice,
	storageSettings,
	tasksDir,
} from 'vs/workbench/contrib/agent/common/agentStorage';
import { AgentSessionManager } from 'vs/workbench/contrib/agent/common/agentSessions';
import { TaskLogManager } from 'vs/workbench/contrib/agent/common/agentTaskLog';
import {
	MockedAgentTool,
	READ_ONLY_MOCK_TOOLS,
	ToolMockStore,
	installToolMock,
	parseToolMockTools,
	resolveToolMockOptions,
} from 'vs/workbench/contrib/agent/common/agentToolMock';
import { AgentTool, ToolRegistry } from 'vs/workbench/contrib/agent/common/agentTools';
import { IAgentTaskLog, IToolResult } from 'vs/workbench/services/agent/common/agentModels';

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string): void {
	if (cond) { console.log(`  PASS: ${msg}`); passed++; }
	else { console.error(`  FAIL: ${msg}`); failed++; }
}

function eq(actual: unknown, expected: unknown, msg: string): void {
	const same = JSON.stringify(actual) === JSON.stringify(expected);
	ok(same, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function tmpDir(name: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `agent-storage-${name}-`));
}

// ────────────────────────────────────────────────────────────────────────────
// [1] storage: section parsing
// ────────────────────────────────────────────────────────────────────────────
function testYamlParsing(): void {
	console.log('\n[1] storage: section parsing');

	const yaml = [
		'active_profile: glm',
		'storage:',
		'  state_dir: /tmp/bm-state     # base for both stores',
		'  sessions_dir: "~/bm/sessions"',
		'  tasks_dir: \'./bm-tasks\'',
		'  save_sessions: false',
		'agent:',
		'  state_dir: ignored',
	].join('\n');

	const parsed = parseStorageYaml(yaml);
	eq(parsed.stateDir, '/tmp/bm-state', 'state_dir is parsed and the comment stripped');
	eq(parsed.sessionsDir, '~/bm/sessions', 'quoted values lose their quotes');
	eq(parsed.tasksDir, './bm-tasks', 'single-quoted values are parsed');
	eq(parsed.saveSessions, false, 'save_sessions: false is parsed as a boolean');

	const noSection = parseStorageYaml('agent:\n  max_steps: 5\n');
	eq(noSection, {}, 'a config without a storage section yields {}');

	const truthy = parseStorageYaml('storage:\n  save_sessions: yes\n');
	eq(truthy.saveSessions, true, 'save_sessions: yes → true');
}

// ────────────────────────────────────────────────────────────────────────────
// [2] precedence
// ────────────────────────────────────────────────────────────────────────────
function testPrecedence(): void {
	console.log('\n[2] storage resolution precedence');

	const home = '/home/tester/.agents';
	const env: NodeJS.ProcessEnv = {};

	const defaults = resolveStorageSettings({}, env, {}, home);
	eq(defaults.sessionsDir, path.join(home, 'sessions'), 'default sessions dir is <home>/sessions');
	eq(defaults.tasksDir, path.join(home, 'tasks'), 'default tasks dir is <home>/tasks');
	eq(defaults.saveSessions, true, 'session saving is on by default');
	eq(storageNotice(defaults, home), undefined, 'the default layout prints no notice');

	const fromYaml = resolveStorageSettings({}, env, { stateDir: '/tmp/bm', saveSessions: false }, home);
	eq(fromYaml.sessionsDir, path.join('/tmp/bm', 'sessions'), 'state_dir from config.yaml moves sessions');
	eq(fromYaml.tasksDir, path.join('/tmp/bm', 'tasks'), 'state_dir from config.yaml moves tasks');
	eq(fromYaml.saveSessions, false, 'save_sessions from config.yaml is honoured');
	eq(fromYaml.source, 'config.yaml', 'the source is reported as config.yaml');

	const fromEnv = resolveStorageSettings({}, { AGENT_STATE_DIR: '/tmp/env-state' }, { stateDir: '/tmp/yaml-state' }, home);
	eq(fromEnv.sessionsDir, path.join('/tmp/env-state', 'sessions'), 'AGENT_STATE_DIR beats config.yaml');
	eq(fromEnv.source, 'env var', 'the source is reported as env var');

	const envOnly = resolveStorageSettings({}, { AGENT_SESSIONS_DIR: '/tmp/only-sessions' }, {}, home);
	eq(envOnly.sessionsDir, '/tmp/only-sessions', 'AGENT_SESSIONS_DIR overrides sessions only');
	eq(envOnly.tasksDir, path.join(home, 'tasks'), 'tasks keep the default when only sessions are redirected');

	const fromCli = resolveStorageSettings(
		{ stateDir: '/tmp/cli-state', tasksDir: '/tmp/cli-tasks' },
		{ AGENT_STATE_DIR: '/tmp/env-state' },
		{ stateDir: '/tmp/yaml-state' },
		home,
	);
	eq(fromCli.sessionsDir, path.join('/tmp/cli-state', 'sessions'), '--state-dir beats env and config.yaml');
	eq(fromCli.tasksDir, '/tmp/cli-tasks', '--tasks-dir overrides the state dir for tasks');
	eq(fromCli.source, 'cli flag', 'the source is reported as cli flag');

	const off = resolveStorageSettings({ saveSessions: false }, {}, {}, home);
	eq(off.saveSessions, false, '--no-session-save disables session writing');

	const envOff = resolveStorageSettings({}, { AGENT_SAVE_SESSIONS: '0' }, {}, home);
	eq(envOff.saveSessions, false, 'AGENT_SAVE_SESSIONS=0 disables session writing');

	const notice = storageNotice(off, home);
	ok(!!notice && notice.includes('session saving OFF'), 'the notice reports disabled session saving');

	const tilde = resolveStorageSettings({ stateDir: '~/bm' }, {}, {}, home);
	eq(tilde.stateDir, path.join(os.homedir(), 'bm'), '`~/…` expands to the home directory');
	eq(expandStoragePath('~'), os.homedir(), 'a bare `~` expands to the home directory');
	eq(expandStoragePath('relative/dir'), path.resolve('relative/dir'), 'relative paths resolve against the CWD');
}

// ────────────────────────────────────────────────────────────────────────────
// [3] stores honour the redirect
// ────────────────────────────────────────────────────────────────────────────
function testStoresFollowRedirect(): void {
	console.log('\n[3] session / task-log stores follow the redirect');

	const root = tmpDir('redirect');
	const previousEnv = { ...process.env };
	try {
		configureStorage({ stateDir: root });
		eq(storageSettings().stateDir, root, 'configureStorage activates the state dir');
		eq(sessionsDir(), path.join(root, 'sessions'), 'sessionsDir() follows the active settings');
		eq(tasksDir(), path.join(root, 'tasks'), 'tasksDir() follows the active settings');

		const sessionManager = new AgentSessionManager(root);
		const id = sessionManager.generateId();
		sessionManager.saveSession(id, 'bench run', 'agent' as any, []);
		ok(fs.existsSync(path.join(root, 'sessions', `${id}.json`)), 'the session file lands in the redirected dir');
		ok(!fs.existsSync(path.join(os.homedir(), '.agents', 'sessions', `${id}.json`)),
			'nothing is written to the real ~/.agents/sessions');
		eq(sessionManager.listSessions().length, 1, 'the redirected store indexes the new session');

		const taskLogManager = new TaskLogManager();
		const taskLog = {
			id: 'task_test_1',
			task: 'benchmark task',
			mode: 'agent',
			workingDirectory: root,
			config: { provider: 'openai', model: 'test-model' },
			systemPrompt: '',
			steps: [],
			totalSteps: 0,
			totalToolCalls: 0,
			status: 'completed',
			startedAt: Date.now(),
			finishedAt: Date.now(),
			durationMs: 1,
		} as unknown as IAgentTaskLog;
		taskLogManager.saveTaskLog(taskLog);
		ok(fs.existsSync(path.join(root, 'tasks', 'task_test_1.json')), 'the task log lands in the redirected dir');
		eq(taskLogManager.loadTaskLog('task_test_1')?.task, 'benchmark task', 'the redirected store reads it back');
	} finally {
		process.env = previousEnv;
		resetStorageSettings();
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ────────────────────────────────────────────────────────────────────────────
// A fake read-only tool whose output depends on the workspace path (the exact
// reason a raw fixture is not portable between benchmark runs).
// ────────────────────────────────────────────────────────────────────────────
class FakeReadTool extends AgentTool {
	readonly name = 'read_file';
	readonly description = 'fake read tool';
	readonly parameters = { type: 'object', properties: { path: { type: 'string' } } };
	calls = 0;

	constructor(private readonly _workspace: string) { super(); }

	override async execute(args: Record<string, unknown>, _signal?: AbortSignal): Promise<IToolResult> {
		this.calls++;
		const toolCallId = (args._toolCallId as string) || '';
		const file = String(args.path);
		const content = `content of ${file} (workspace ${this._workspace})`;
		return { toolCallId, success: true, output: `File: ${file}\n${content}` };
	}
}

class FakeWriteTool extends AgentTool {
	readonly name = 'write_file';
	readonly description = 'fake write tool';
	readonly parameters = { type: 'object', properties: { path: { type: 'string' } } };
	calls = 0;

	override async execute(args: Record<string, unknown>, _signal?: AbortSignal): Promise<IToolResult> {
		this.calls++;
		return { toolCallId: (args._toolCallId as string) || '', success: true, output: `wrote ${args.path}` };
	}
}

// ────────────────────────────────────────────────────────────────────────────
// [4] record → replay in a DIFFERENT workspace
// ────────────────────────────────────────────────────────────────────────────
async function testRecordReplay(): Promise<void> {
	console.log('\n[4] tool mock: record → replay is stable across workspaces');

	const root = tmpDir('mock');
	const fixture = path.join(root, 'mocks', 'task.json');
	const wsA = path.join(root, 'ws-a');
	const wsB = path.join(root, 'ws-b');
	fs.mkdirSync(wsA, { recursive: true });
	fs.mkdirSync(wsB, { recursive: true });

	try {
		// ---- record in workspace A ----
		const toolA = new FakeReadTool(wsA);
		const storeA = new ToolMockStore({ mode: 'record', file: fixture, workspace: wsA, tools: READ_ONLY_MOCK_TOOLS });
		const recorded = await storeA.invoke(toolA, { path: path.join(wsA, 'README.md'), _toolCallId: 'call-1' });

		eq(toolA.calls, 1, 'record mode executes the real tool');
		ok(recorded.success, 'record mode returns the live result');
		ok(recorded.output.includes(wsA), 'the live output contains the workspace path');

		const raw = fs.readFileSync(fixture, 'utf-8');
		ok(raw.includes('{{WS}}'), 'the fixture tokenizes the workspace path');
		ok(!raw.includes(wsA), 'no absolute workspace path is stored in the fixture');
		ok(/entries/.test(raw), 'the fixture stores an entries map');

		// ---- replay in workspace B (fresh temp dir, like the benchmark) ----
		const toolB = new FakeReadTool(wsB);
		const storeB = new ToolMockStore({ mode: 'replay', file: fixture, workspace: wsB, tools: READ_ONLY_MOCK_TOOLS });
		const replayed = await storeB.invoke(toolB, { path: path.join(wsB, 'README.md'), _toolCallId: 'call-2' });

		eq(toolB.calls, 0, 'replay does NOT execute the real tool');
		eq(replayed.success, recorded.success, 'replay reproduces the recorded success flag');
		eq(replayed.toolCallId, 'call-2', 'replay uses the CURRENT tool-call id (pairing stays intact)');
		ok(replayed.output.includes(wsB), 'the replayed output is re-rooted at the new workspace');
		ok(!replayed.output.includes(wsA), 'the old workspace path does not leak into the replay');
		eq(replayed.output.split(wsB).join('{{WS}}'), recorded.output.split(wsA).join('{{WS}}'),
			'the replayed output is byte-identical modulo the workspace token');

		// Replay twice: the fixture is only read, results stay identical.
		const toolC = new FakeReadTool(wsB);
		const storeC = new ToolMockStore({ mode: 'replay', file: fixture, workspace: wsB, tools: READ_ONLY_MOCK_TOOLS });
		const again = await storeC.invoke(toolC, { path: path.join(wsB, 'README.md') });
		eq(again.output, replayed.output, 'a second replay returns exactly the same output');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ────────────────────────────────────────────────────────────────────────────
// [5] occurrences, strict misses, live fallback
// ────────────────────────────────────────────────────────────────────────────
async function testOccurrencesAndMisses(): Promise<void> {
	console.log('\n[5] tool mock: occurrences, strict miss, live fallback');

	const root = tmpDir('mock-occ');
	const fixture = path.join(root, 'task.json');
	const ws = path.join(root, 'ws');
	fs.mkdirSync(ws, { recursive: true });

	try {
		class SequencedTool extends AgentTool {
			readonly name = 'read_file';
			readonly description = 'sequenced';
			readonly parameters = { type: 'object', properties: {} };
			calls = 0;
			override async execute(args: Record<string, unknown>): Promise<IToolResult> {
				this.calls++;
				return { toolCallId: (args._toolCallId as string) || '', success: true, output: `call-${this.calls}` };
			}
		}

		const recorder = new SequencedTool();
		const recordStore = new ToolMockStore({ mode: 'record', file: fixture, workspace: ws, tools: ['read_file'] });
		const first = await recordStore.invoke(recorder, { path: path.join(ws, 'a.txt'), _toolCallId: 'c1' });
		const second = await recordStore.invoke(recorder, { path: path.join(ws, 'a.txt'), _toolCallId: 'c2' });
		eq([first.output, second.output], ['call-1', 'call-2'], 'two identical calls record two entries');

		const replayer = new SequencedTool();
		const replayStore = new ToolMockStore({ mode: 'replay', file: fixture, workspace: ws, tools: ['read_file'] });
		const r1 = await replayStore.invoke(replayer, { path: path.join(ws, 'a.txt'), _toolCallId: 'c3' });
		const r2 = await replayStore.invoke(replayer, { path: path.join(ws, 'a.txt'), _toolCallId: 'c4' });
		eq([r1.output, r2.output], ['call-1', 'call-2'], 'the N-th identical call replays the N-th entry');
		eq(replayer.calls, 0, 'no live execution happened while replaying');

		// Miss without strict: run live, remember it.
		const live = await replayStore.invoke(replayer, { path: path.join(ws, 'b.txt'), _toolCallId: 'c5' });
		eq(replayer.calls, 1, 'a replay miss executes the real tool');
		ok(live.success, 'the live result is returned on a miss');

		const strictStore = new ToolMockStore({ mode: 'replay', strict: true, file: fixture, workspace: ws, tools: ['read_file'] });
		const replayer2 = new SequencedTool();
		const miss = await strictStore.invoke(replayer2, { path: path.join(ws, 'c.txt'), _toolCallId: 'c6' });
		eq(replayer2.calls, 0, 'strict replay never executes the real tool');
		eq(miss.success, false, 'strict replay turns a miss into a failed result');
		ok((miss.error || '').includes('no recorded result'), 'the strict miss explains itself');

		// Key normalization: argument ORDER must not change the key, and
		// transport fields (_toolCallId) must not either.
		const normalized = new ToolMockStore({ mode: 'record', file: path.join(root, 'keys.json'), workspace: ws });
		eq(normalized.keyFor('read_file', { a: '1', b: '2', _toolCallId: 'x' }),
			normalized.keyFor('read_file', { _toolCallId: 'y', b: '2', a: '1' }),
			'the key ignores key order and _-prefixed transport fields');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ────────────────────────────────────────────────────────────────────────────
// [6] which tools get wrapped
// ────────────────────────────────────────────────────────────────────────────
async function testWrappedTools(): Promise<void> {
	console.log('\n[6] tool mock wrapping scope');

	eq(parseToolMockTools('read'), READ_ONLY_MOCK_TOOLS, '"read" expands to the read-only tool set');
	eq(parseToolMockTools('all'), undefined, '"all" means every tool');
	eq(parseToolMockTools('read_file,list_directory'), ['read_file', 'list_directory'], 'a CSV list is honoured');
	eq(parseToolMockTools(undefined), READ_ONLY_MOCK_TOOLS, 'the default covers read-only tools only');
	ok(!READ_ONLY_MOCK_TOOLS.includes('write_file'), 'write_file is NOT mocked by default');
	ok(!READ_ONLY_MOCK_TOOLS.includes('run_terminal'), 'run_terminal is NOT mocked by default');

	const off = resolveToolMockOptions({ mode: 'off' });
	eq(off.mode, 'off', 'mode defaults to off');

	const fromEnv = resolveToolMockOptions({}, { AGENT_TOOL_MOCK: 'replay', AGENT_TOOL_MOCK_FILE: '/tmp/x.json' });
	eq(fromEnv.mode, 'replay', 'AGENT_TOOL_MOCK enables replay');
	eq(fromEnv.file, '/tmp/x.json', 'AGENT_TOOL_MOCK_FILE sets the fixture');
	eq(fromEnv.strict, false, 'replay is not strict unless asked');

	const derived = resolveToolMockOptions({ mode: 'record' }, {}, '/tmp/state');
	eq(derived.file, path.join('/tmp/state/tool-mocks', 'default.json'), 'the fixture defaults under the state dir');

	const strict = resolveToolMockOptions({ mode: 'replay', strict: true });
	eq(strict.strict, true, '--tool-mock-strict is honoured');

	// The registry wraps only the selected tools, and aliases keep resolving.
	const root = tmpDir('wrap');
	try {
		const registry = new ToolRegistry();
		const read = new FakeReadTool(root);
		const write = new FakeWriteTool();
		registry.register(read);
		registry.register(write);
		registry.registerAlias('search_content', 'read_file');

		const store = new ToolMockStore({ mode: 'record', file: path.join(root, 'f.json'), workspace: root, tools: READ_ONLY_MOCK_TOOLS });
		const wrapped = installToolMock(registry, store);
		eq(wrapped, 1, 'only the read-only tool is wrapped');

		ok(registry.get('read_file') instanceof MockedAgentTool, 'read_file is behind the mock layer');
		ok(!(registry.get('write_file') instanceof MockedAgentTool), 'write_file still executes for real');
		ok(registry.get('search_content') instanceof MockedAgentTool, 'an alias resolves to the wrapped tool');

		await registry.get('read_file')!.execute({ path: path.join(root, 'x.txt'), _toolCallId: 'c1' });
		ok(fs.existsSync(path.join(root, 'f.json')), 'a mocked call records a fixture entry');
		eq(read.calls, 1, 'record mode still executed the real tool once');

		const writeResult = await registry.get('write_file')!.execute({ path: 'x', _toolCallId: 'c2' });
		ok(writeResult.success, 'the unwrapped write tool runs normally');
		eq(write.calls, 1, 'the write tool was executed (not mocked)');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	testYamlParsing();
	testPrecedence();
	testStoresFollowRedirect();
	await testRecordReplay();
	await testOccurrencesAndMisses();
	await testWrappedTools();

	console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

void main().catch(err => {
	console.error(err);
	process.exit(1);
});
