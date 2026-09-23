/*---------------------------------------------------------------------------------------------
 *  Unit tests: agent self-evolution (RSI)
 *
 *  [1] config resolution (self_update section, inline comments, push ⟹ release)
 *  [2] failure-signature normalization (repeat grouping)
 *  [3] run-evidence facts over synthetic task logs (counts, grouping, caps, notes)
 *  [4] release pipeline contract with an INJECTED runner (abort/ordering/no-write)
 *  [5] release pipeline end-to-end against a REAL temp git repo + local remote
 *  [6] issue signals recorded by the ReAct loop (unknown tool)
 *  [7] the methodology prompt section
 *  [8] the poll tool's own waiting budget vs the generic step timeout
 *
 *  Run:
 *    npx esbuild tests/self-improve.test.ts --bundle --platform=node --target=node18 \
 *      --format=esm --outfile=build/self-improve.test.mjs --tsconfig=tsconfig.json \
 *    && node build/self-improve.test.mjs
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
	DEFAULT_SELF_UPDATE_CONFIG,
	bumpVersion,
	buildSelfEvolvePromptSection,
	collectRunEvidence,
	formatEvidenceReport,
	formatReleaseReport,
	loadSelfUpdateConfig,
	normalizeFailureSignature,
	parseSelfUpdateYaml,
	runReleasePipeline,
	CommandRunner,
	ICommandResult,
	defaultCommandRunner,
} from 'vs/workbench/contrib/agent/common/agentSelfImprove';
import { AgentLoop } from 'vs/workbench/contrib/agent/common/agent';
import { AgentModeManager } from 'vs/workbench/contrib/agent/common/agentModes';
import { AgentCheckpointManager } from 'vs/workbench/contrib/agent/common/agentCheckpoint';
import { ToolRegistry } from 'vs/workbench/contrib/agent/common/agentTools';
import { PollTool, pollBudgetMs } from 'vs/workbench/contrib/agent/common/tools/poll';
import { ITerminalInstance, ITerminalService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { Emitter } from 'vs/base/common/event';
import { createMessage, MessageRole, IAgentConfig, IAgentMessage, IAgentTaskLog } from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider } from 'vs/workbench/services/agent/browser/llmProvider';

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

function tmpDir(tag: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `code-agent-self-${tag}-`));
	return dir;
}

// ---------------------------------------------------------------------------
// [1] config
// ---------------------------------------------------------------------------

function testConfig(): void {
	console.log('\n[1] self_update configuration');

	const defaults = parseSelfUpdateYaml('agent:\n  max_steps: 3\n');
	eq(defaults, undefined, 'a config without a self_update section yields undefined');
	eq(DEFAULT_SELF_UPDATE_CONFIG.enabled, true, 'the read-only scan is ON by default');
	eq(DEFAULT_SELF_UPDATE_CONFIG.allowRelease, false, 'the release gate is OFF by default');
	eq(DEFAULT_SELF_UPDATE_CONFIG.allowPush, false, 'push is OFF by default');
	ok(DEFAULT_SELF_UPDATE_CONFIG.releaseScripts.includes('test'), 'the default scripts run the tests');

	const parsed = parseSelfUpdateYaml([
		'self_update:',
		'  enabled: true',
		'  allow_release: true     # commit allowed',
		'  allow_push: true',
		'  evidence_days: 30',
		'  evidence_tasks: 50',
		'  remote: upstream',
		'  install_command: npm link',
		'  release_scripts:',
		'    - typecheck   # fast first',
		'    - test',
		'memory:',
		'  enabled: true',
	].join('\n'));
	eq(parsed?.enabled, true, 'enabled is parsed');
	eq(parsed?.allowRelease, true, 'an inline comment after a boolean is stripped');
	eq(parsed?.allowPush, true, 'allow_push is parsed');
	eq(parsed?.evidenceDays, 30, 'evidence_days is parsed as a number');
	eq(parsed?.evidenceTasks, 50, 'evidence_tasks is parsed as a number');
	eq(parsed?.remote, 'upstream', 'remote is parsed');
	eq(parsed?.installCommand, 'npm link', 'install_command is parsed');
	eq(parsed?.releaseScripts?.join(','), 'typecheck,test', 'a block list of scripts is parsed (comments stripped)');

	// push without release is not a state worth supporting.
	const pushOnly = parseSelfUpdateYaml('self_update:\n  allow_push: true\n');
	eq(pushOnly?.allowPush, true, 'the raw section keeps allow_push');
	eq(DEFAULT_SELF_UPDATE_CONFIG.allowRelease, false, 'sanity: release stays off by default');
}

// ---------------------------------------------------------------------------
// [2] signature normalization
// ---------------------------------------------------------------------------

function testSignatures(): void {
	console.log('\n[2] failure-signature normalization');

	// Same defect, different ids → one signature. The tool name is part of the
	// signature on purpose: it is the most useful thing in the message.
	eq(
		normalizeFailureSignature('Unknown tool: read_file (id=9f8e7d6c5b4a3210)'),
		normalizeFailureSignature('Unknown tool: read_file (id=1234567890abcdef)'),
		'the same defect with different ids collapses into one signature');
	ok(normalizeFailureSignature('Unknown tool: read_file').includes('read_file'),
		'identifiers stay in the signature (they are the useful part)');

	// Paths, quoted or bare, must not create one group per file.
	const a = normalizeFailureSignature("ENOENT: no such file or directory, open '/home/a/very/long/path/thing.ts'");
	const b = normalizeFailureSignature("ENOENT: no such file or directory, open '/tmp/other/file.py'");
	eq(a, b, 'a repeated ENOENT groups regardless of the path');
	ok(a.includes('<path>'), `a quoted path becomes <path>, not <str> (${a})`);
	ok(!a.includes('/home/a'), 'no real path survives in the signature');
	ok(normalizeFailureSignature('cannot open /var/log/app/out.log').includes('<path>'),
		'a bare absolute path is normalized');

	// Boilerplate numbers collapse; ISA/architecture identifiers must NOT.
	eq(normalizeFailureSignature('tool timed out after 30000ms'),
		normalizeFailureSignature('tool timed out after 120000ms'),
		'durations group (the unit is kept, the value is not)');
	ok(normalizeFailureSignature('yielded after 512MB').includes('<n>MB'), 'sizes group and keep their unit');
	ok(normalizeFailureSignature('gcu500 illegal instruction') !== normalizeFailureSignature('gcu400 illegal instruction'),
		'architecture identifiers stay DISTINCT (an ISA failure is not the same defect)');
	ok(normalizeFailureSignature('model gpt-5.6-luna is unavailable').includes('gpt'),
		'a model name in the text is not erased');

	ok(normalizeFailureSignature('x'.repeat(500)).length <= 160, 'a signature is bounded');
	eq(normalizeFailureSignature('  a  b   c '), 'a b c', 'whitespace is collapsed');
}

// ---------------------------------------------------------------------------
// [3] evidence
// ---------------------------------------------------------------------------

/** Minimal task log with just enough shape for the collector. */
function makeTaskLog(over: Partial<IAgentTaskLog> & { id: string; startedAt: number }): IAgentTaskLog {
	return {
		task: 'do the thing',
		mode: 'agent' as never,
		workingDirectory: '/tmp',
		config: { provider: 'openai', model: 'm' },
		systemPrompt: '',
		steps: [],
		totalSteps: 0,
		totalToolCalls: 0,
		status: 'completed',
		finishedAt: over.startedAt + 1000,
		durationMs: 1000,
		...over,
	} as IAgentTaskLog;
}

function stepWith(tool: string, success: boolean, error: string | undefined, durationMs: number) {
	return {
		stepIndex: 0,
		llmRequest: { messageCount: 1, estimatedTokens: 10 },
		llmResponse: { content: '' },
		toolExecutions: [{
			toolCallId: 'c1', toolName: tool, arguments: {}, result: success ? 'ok' : '',
			success, error, durationMs, timestamp: 1,
		}],
		durationMs,
		timestamp: 1,
	} as never;
}

function testEvidence(): void {
	console.log('\n[3] run-evidence facts');

	// Empty history must say so rather than look healthy.
	const emptyDir = tmpDir('empty');
	const empty = collectRunEvidence({ tasksDir: emptyDir, sessionsDir: path.join(emptyDir, 's') });
	eq(empty.tasksInWindow, 0, 'an empty history reports zero tasks');
	ok(empty.notes.some(n => n.includes('No task logs')), 'an empty history is called out in the notes');
	ok(formatEvidenceReport(empty).includes('Facts only'), 'the report states that it carries no verdict');
	fs.rmSync(emptyDir, { recursive: true, force: true });

	const dir = tmpDir('evidence');
	const now = Date.now();
	const day = 24 * 60 * 60 * 1000;

	const logs: IAgentTaskLog[] = [
		// Three occurrences of the SAME defect across two tools → one group of 3.
		makeTaskLog({
			id: 'task_1_a', startedAt: now - 1 * day, status: 'failed', error: 'maximum context length exceeded',
			totalSteps: 4, totalToolCalls: 3, tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } as never,
			issueSignals: [{ kind: 'user-intervention', detail: 'that is the wrong file' }, { kind: 'reasoning-loop', detail: '2 repeats' }],
			steps: [stepWith('read_file', false, "ENOENT: no such file or directory, open '/a/b/c.ts'", 120)],
		}),
		makeTaskLog({
			id: 'task_2_b', startedAt: now - 2 * day, status: 'completed',
			issueSignals: [{ kind: 'user-intervention', detail: 'use the other API' }],
			modelSwitches: [{ from: 'm1', to: 'm2', reason: 'fallback-timeout', toFallback: true } as never],
			steps: [stepWith('read_file', false, "ENOENT: no such file or directory, open '/x/y/z.py'", 340)],
		}),
		makeTaskLog({
			id: 'task_3_c', startedAt: now - 3 * day, status: 'completed',
			steps: [stepWith('read_file', false, "ENOENT: no such file or directory, open '/q/r/s.go'", 90)],
		}),
		// Outside the window.
		makeTaskLog({ id: 'task_0_old', startedAt: now - 90 * day, status: 'completed' }),
	];
	for (const log of logs) fs.writeFileSync(path.join(dir, `${log.id}.json`), JSON.stringify(log));
	fs.writeFileSync(path.join(dir, 'not-a-log.txt'), 'ignore me');

	const evidence = collectRunEvidence({ tasksDir: dir, sessionsDir: path.join(dir, 'sessions'), days: 14 });
	eq(evidence.filesOnDisk, 4, 'only task_*.json files are counted on disk');
	eq(evidence.tasksInWindow, 3, 'the 90-day-old log is outside the window');
	eq(evidence.statusCounts.failed, 1, 'the failing task is counted');
	eq(evidence.statusCounts.completed, 2, 'the completing tasks are counted');
	eq(evidence.totalSteps, 4, 'steps are summed across the window');
	eq(evidence.totalTokens, 15, 'tokens are summed when reported');

	const enoent = evidence.failureGroups.find(g => g.signature.includes('ENOENT'));
	ok(!!enoent, 'the ENOENT failure is reported');
	eq(enoent?.count, 3, 'three occurrences of the same defect become ONE group of 3');
	eq(enoent?.taskIds.length, 3, 'the group lists every task that hit it');
	eq(enoent?.scope, 'tool', 'a tool failure is scoped to the tool');

	ok(evidence.failureGroups.some(g => g.scope === 'task' && g.signature.includes('maximum context length')),
		'a task-level error is grouped separately from tool failures');

	const readFile = evidence.toolStats.find(t => t.tool === 'read_file');
	eq(readFile?.calls, 3, 'tool call counts are aggregated');
	eq(readFile?.failures, 3, 'tool failures are aggregated');
	eq(readFile?.failureRate, 1, 'the failure rate is computed');
	eq(readFile?.maxMs, 340, 'the worst latency per tool is kept');

	const intervention = evidence.issueGroups.find(g => g.kind === 'user-intervention');
	eq(intervention?.count, 2, 'run signals are aggregated across tasks');
	ok(evidence.issueGroups.some(g => g.kind === 'reasoning-loop'), 'a reasoning-loop signal survives');
	ok(evidence.issueGroups.some(g => g.kind === 'model-switch:fallback-timeout'),
		'保底-model switches are surfaced as signals even without an explicit issue signal');

	ok(evidence.costlyTasks.length > 0 && evidence.costlyTasks[0].taskId === 'task_1_a',
		'the costliest task is ranked by tokens');
	eq(evidence.failingTasks.length, 1, 'only non-completed tasks appear in the failing list');

	// Caps must hold so a year of history cannot flood the context window.
	const capped = collectRunEvidence({ tasksDir: dir, days: 14, maxGroups: 1 });
	ok(capped.failureGroups.length <= 1, 'the failure-group cap is honoured');
	ok(capped.issueGroups.length <= 1, 'the issue-group cap is honoured');
	const bigWindow = collectRunEvidence({ tasksDir: dir, days: 3650, maxTasks: 2 });
	eq(bigWindow.scannedTasks, 2, 'the task-log cap is honoured');
	ok(bigWindow.notes.some(n => n.includes('cap reached')), 'hitting the cap is disclosed in the notes');
	ok(formatEvidenceReport(evidence).includes('ENOENT'), 'the report renders the grouped failure');
	ok(formatEvidenceReport(evidence).includes('RUN SIGNALS'), 'the report renders the run signals');

	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// [4] release pipeline contract (injected runner)
// ---------------------------------------------------------------------------

interface FakeRun {
	cmd: string;
	args: string[];
}

/** A runner that answers from a scripted table and records every call. */
function fakeRunner(handlers: (cmd: string, args: string[]) => ICommandResult | undefined): { run: CommandRunner; calls: FakeRun[] } {
	const calls: FakeRun[] = [];
	const run: CommandRunner = async (cmd, args) => {
		calls.push({ cmd, args });
		const result = handlers(cmd, args);
		if (result) return result;
		return { code: 1, stdout: '', stderr: `unexpected command: ${cmd} ${args.join(' ')}` };
	};
	return { run, calls };
}

function writePkg(dir: string, version: string): void {
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
		name: 'fake-agent', version, scripts: { typecheck: 'true', test: 'true', pack: 'true' },
	}, null, 2));
}

async function testPipelineContract(): Promise<void> {
	console.log('\n[4] release pipeline contract (injected runner)');

	const dir = tmpDir('pipeline');
	try {
		// ---- happy path: bump, verify, commit, no push ----
		writePkg(dir, '1.2.3');
		let { run, calls } = fakeRunner((cmd, args) => {
			if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--git-dir') return { code: 0, stdout: '.git', stderr: '' };
			if (cmd === 'git' && args[0] === 'diff' && args[1] === '--name-only') return { code: 0, stdout: '', stderr: '' };
			if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'main', stderr: '' };
			if (cmd === 'npm') return { code: 0, stdout: 'ok', stderr: '' };
			if (cmd === 'git' && args[0] === 'add') return { code: 0, stdout: '', stderr: '' };
			if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached') return { code: 0, stdout: 'package.json\n', stderr: '' };
			if (cmd === 'git' && args[0] === 'commit') return { code: 0, stdout: '[main abc] x', stderr: '' };
			if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') return { code: 0, stdout: 'abcdef1234567890', stderr: '' };
			return undefined;
		});
		const happy = await runReleasePipeline({
			repoDir: dir, bump: 'patch', commitMessage: 'fix: something', run,
		});
		ok(happy.ok, `the happy path succeeds (aborted at ${happy.abortedAt}: ${happy.abortReason})`);
		eq(happy.versionFrom, '1.2.3', 'the previous version is reported');
		eq(happy.versionTo, '1.2.4', 'patch bumps the patch field');
		ok(happy.committed, 'the change was committed');
		eq(happy.pushed, false, 'no push was attempted');
		ok(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version === '1.2.4',
			'package.json holds the new version');
		ok(!calls.some(c => c.cmd === 'git' && c.args.includes('push')), 'git push was never called');
		ok(!calls.some(c => c.args.includes('--force') || c.args.includes('--amend') || c.args.includes('--no-verify')),
			'no --force / --amend / --no-verify is ever used');
		ok(happy.steps.some(s => s.name === 'npm run test'), 'the configured scripts ran');
		eq(happy.steps.filter(s => s.name.startsWith('npm run')).length, 3, 'every configured script ran, in order');
		ok(calls.findIndex(c => c.cmd === 'npm' && c.args[1] === 'typecheck')
			< calls.findIndex(c => c.cmd === 'git' && c.args[0] === 'commit'),
			'the verification steps run BEFORE the commit');

		// ---- a red test suite must never produce a commit ----
		writePkg(dir, '2.0.0');
		({ run, calls } = fakeRunner((cmd, args) => {
			if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: args[1] === '--abbrev-ref' ? 'main' : '.git', stderr: '' };
			if (cmd === 'git' && args[0] === 'diff') return { code: 0, stdout: '', stderr: '' };
			if (cmd === 'npm' && args[1] === 'typecheck') return { code: 0, stdout: 'ok', stderr: '' };
			if (cmd === 'npm' && args[1] === 'test') return { code: 1, stdout: 'FAIL: 3 tests failed', stderr: '' };
			return undefined;
		}));
		const red = await runReleasePipeline({ repoDir: dir, bump: 'minor', commitMessage: 'fix: nope', run });
		ok(!red.ok, 'a failing test suite aborts the release');
		eq(red.abortedAt, 'npm run test', 'the abort is attributed to the failing script');
		ok(!red.committed, 'nothing was committed');
		ok(!calls.some(c => c.cmd === 'git' && c.args[0] === 'commit'), 'git commit was never reached');
		ok(red.steps.find(s => s.name === 'npm run test')?.outputTail?.includes('FAIL'),
			'the failing output is kept for the report');
		eq(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version, '2.0.0',
			'package.json is restored after an abort (no half-release)');
		eq(red.versionTo, '2.1.0', 'the report still states the version it would have used');

		// ---- version bump is never lost on a later failure either ----
		ok(red.notes.some(n => n.includes('restored')), 'the restore is disclosed in the notes');

		// ---- not a git repository ----
		const noGit = tmpDir('nogit');
		writePkg(noGit, '1.0.0');
		const notRepo = await runReleasePipeline({
			repoDir: noGit, bump: 'patch', commitMessage: 'x',
			run: async () => ({ code: 128, stdout: '', stderr: 'fatal: not a git repository' }),
		});
		ok(!notRepo.ok && notRepo.abortedAt === 'git-repository', 'a non-repo directory is refused');
		eq(JSON.parse(fs.readFileSync(path.join(noGit, 'package.json'), 'utf-8')).version, '1.0.0',
			'package.json is untouched when the target is not a repo');
		fs.rmSync(noGit, { recursive: true, force: true });

		// ---- mid-merge must never receive an automated commit ----
		writePkg(dir, '3.0.0');
		({ run } = fakeRunner((cmd, args) => {
			if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: args[1] === '--abbrev-ref' ? 'main' : '.git', stderr: '' };
			if (cmd === 'git' && args[0] === 'diff' && args[1] === '--name-only') return { code: 0, stdout: 'a.ts\n', stderr: '' };
			return undefined;
		}));
		const merging = await runReleasePipeline({ repoDir: dir, bump: 'patch', commitMessage: 'x', run });
		ok(!merging.ok && merging.abortedAt === 'git-state', 'unmerged files abort the release');

		// ---- push requires an explicit request and a real branch ----
		writePkg(dir, '4.0.0');
		({ run, calls } = fakeRunner((cmd, args) => {
			if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'HEAD', stderr: '' };
			if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: '.git', stderr: '' };
			if (cmd === 'git' && args[0] === 'diff') return { code: 0, stdout: '', stderr: '' };
			return undefined;
		}));
		const detached = await runReleasePipeline({ repoDir: dir, bump: 'patch', commitMessage: 'x', push: true, run });
		ok(!detached.ok && detached.abortedAt === 'git-branch', 'a detached HEAD refuses to push');

		writePkg(dir, '5.0.0');
		({ run, calls } = fakeRunner((cmd, args) => {
			if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'main', stderr: '' };
			if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: '.git', stderr: '' };
			if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached') return { code: 0, stdout: 'package.json\n', stderr: '' };
			if (cmd === 'git' && args[0] === 'diff') return { code: 0, stdout: '', stderr: '' };
			if (cmd === 'git') return { code: 0, stdout: 'abcdef1234567890', stderr: '' };
			if (cmd === 'npm') return { code: 0, stdout: 'ok', stderr: '' };
			return undefined;
		}));
		const pushed = await runReleasePipeline({
			repoDir: dir, bump: 'patch', commitMessage: 'fix: pushed', push: true, remote: 'upstream', run,
		});
		ok(pushed.ok && pushed.pushed, 'push succeeds when requested');
		const pushCall = calls.find(c => c.cmd === 'git' && c.args[0] === 'push');
		eq(pushCall?.args.join(' '), 'push upstream HEAD', 'push targets the configured remote and HEAD');

		// ---- a stale build must fail the smoke check ----
		writePkg(dir, '6.0.0');
		fs.mkdirSync(path.join(dir, 'build'), { recursive: true });
		fs.writeFileSync(path.join(dir, 'build', 'agent-cli.js'), 'console.log("code-agent v0.0.1")');
		({ run } = fakeRunner((cmd, args, ) => {
			if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'main', stderr: '' };
			if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: '.git', stderr: '' };
			if (cmd === 'git' && args[0] === 'diff') return { code: 0, stdout: '', stderr: '' };
			if (cmd === 'npm') return { code: 0, stdout: 'ok', stderr: '' };
			return undefined;
		}));
		// The smoke step runs the real node binary against the fake CLI.
		const stale = await runReleasePipeline({
			repoDir: dir, bump: 'patch', commitMessage: 'x', scripts: [], run,
		});
		ok(!stale.ok && stale.abortedAt === 'smoke built CLI',
			'a build that does not report the new version aborts the release');
		eq(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version, '6.0.0',
			'package.json is restored after a smoke failure');
		fs.rmSync(path.join(dir, 'build'), { recursive: true, force: true });

		// ---- dry run writes nothing (not even the git index) ----
		writePkg(dir, '7.0.0');
		({ run, calls } = fakeRunner((cmd, args) => {
			if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'main', stderr: '' };
			if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: '.git', stderr: '' };
			if (cmd === 'git' && args[0] === 'diff') return { code: 0, stdout: '', stderr: '' };
			return undefined;
		}));
		const dry = await runReleasePipeline({ repoDir: dir, bump: 'minor', commitMessage: 'x', dryRun: true, run });
		ok(dry.ok && dry.dryRun, `a dry run reports success without touching anything (aborted at ${dry.abortedAt}: ${dry.abortReason})`);
		eq(dry.versionTo, '7.1.0', 'a dry run still reports the version it would produce');
		eq(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')).version, '7.0.0',
			'a dry run leaves package.json alone');
		ok(!calls.some(c => c.cmd === 'npm'), 'a dry run executes no scripts');
		ok(!calls.some(c => c.cmd === 'git' && c.args[0] === 'add'), 'a dry run does not even stage (git add is not read-only)');
		ok(!calls.some(c => c.cmd === 'git' && (c.args[0] === 'commit' || c.args[0] === 'push')),
			'a dry run never commits or pushes');
		ok(dry.steps.some(s => s.skipped), 'skipped steps are marked in the report');
		ok(dry.notes.some(n => n.includes('preflight only')), 'a dry run states exactly what it validated');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function testBumpVersion(): void {
	console.log('\n[4b] semver bump');
	eq(bumpVersion('0.3.40', 'patch'), '0.3.41', 'patch increments the patch field');
	eq(bumpVersion('0.3.40', 'minor'), '0.4.0', 'minor resets patch');
	eq(bumpVersion('0.3.40', 'major'), '1.0.0', 'major resets minor and patch');
	eq(bumpVersion('0.3.40', 'none'), '0.3.40', 'none keeps the version');
	eq(bumpVersion('1.2.3-rc.1', 'patch'), '1.2.4', 'prerelease suffixes are not carried over');
	let threw = false;
	try { bumpVersion('not-semver', 'patch'); } catch { threw = true; }
	ok(threw, 'a non-semver version is rejected');
}

// ---------------------------------------------------------------------------
// [5] release pipeline against a real git repo
// ---------------------------------------------------------------------------

/** Stub CLI that reports whatever version package.json currently holds. */
const STUB_CLI = `const fs=require('fs');const path=require('path');`
	+ `const p=JSON.parse(fs.readFileSync(path.join(__dirname,'..','package.json'),'utf8'));`
	+ `console.log('code-agent v'+p.version);`;

async function testPipelineRealGit(): Promise<void> {
	console.log('\n[5] release pipeline against a real git repo (real git, real push)');

	const root = tmpDir('realgit');
	const repo = path.join(root, 'repo');
	const bare = path.join(root, 'remote.git');
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(bare, { recursive: true });

	const git = (args: string[], cwd = repo) => execFileSync('git', args, { cwd, encoding: 'utf-8' });

	try {
		git(['init', '-q', '-b', 'main']);
		git(['config', 'user.email', 'test@example.com']);
		git(['config', 'user.name', 'Self Improve Test']);
		git(['config', 'commit.gpgsign', 'false']);
		git(['init', '-q', '--bare', bare]);
		git(['remote', 'add', 'origin', bare]);

		writePkg(repo, '0.0.1');
		fs.mkdirSync(path.join(repo, 'build'), { recursive: true });
		fs.writeFileSync(path.join(repo, 'build', 'agent-cli.js'), STUB_CLI);
		fs.writeFileSync(path.join(repo, 'README.md'), '# demo\n');
		git(['add', '-A']);
		git(['commit', '-q', '-m', 'chore: initial']);

		// `release_scripts` is empty so no npm is needed; the smoke step is real.
		const report = await runReleasePipeline({
			repoDir: repo,
			bump: 'patch',
			commitMessage: 'fix: a real fix from a real repo',
			push: true,
			remote: 'origin',
			scripts: [],
		});

		ok(report.ok, `the real pipeline succeeded (aborted at ${report.abortedAt}: ${report.abortReason})`);
		eq(report.versionFrom, '0.0.1', 'the real previous version is read');
		eq(report.versionTo, '0.0.2', 'the real version was bumped');
		ok(report.committed, 'a real commit was created');
		ok(!!report.commitHash && /^[0-9a-f]{40}$/.test(report.commitHash!), 'a real commit hash is reported');
		ok(report.pushed, 'the commit was really pushed');

		eq(JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf-8')).version, '0.0.2',
			'package.json on disk holds the bumped version');
		const subject = git(['log', '-1', '--format=%s']).trim();
		eq(subject, 'fix: a real fix from a real repo', 'the commit subject is the message');
		const body = git(['log', '-1', '--format=%b']);
		ok(body.includes('Verified-by: code-agent self-update 0.0.1 -> 0.0.2'),
			'the machine-verified trailer records the versions it produced');
		ok(body.includes('smoke built CLI'), 'the trailer lists the steps that actually ran');

		const remoteSubject = execFileSync('git', ['--git-dir', bare, 'log', '-1', 'main', '--format=%s'], { encoding: 'utf-8' }).trim();
		eq(remoteSubject, 'fix: a real fix from a real repo', 'the commit really landed on the remote');

		// Second run: nothing new to stage → no empty commit. Git is stubbed (we
		// control the "nothing staged" answer) but the smoke step stays REAL.
		const again = await runReleasePipeline({
			repoDir: repo, bump: 'patch', commitMessage: 'fix: nothing changed', scripts: [],
			run: async (cmd, args, opts) => {
				if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { code: 0, stdout: 'main', stderr: '' };
				if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: '.git', stderr: '' };
				if (cmd === 'git' && args[0] === 'diff' && args[1] === '--name-only') return { code: 0, stdout: '', stderr: '' };
				if (cmd === 'git' && args[0] === 'add') return { code: 0, stdout: '', stderr: '' };
				if (cmd === 'git' && args[0] === 'diff' && args[1] === '--cached') return { code: 0, stdout: '', stderr: '' };
				if (cmd === 'git') return { code: 0, stdout: '', stderr: '' };
				return defaultCommandRunner(cmd, args, opts);
			},
		});
		ok(again.ok && !again.committed, `an empty release does not create an empty commit (ok=${again.ok} abortedAt=${again.abortedAt} committed=${again.committed} reason=${again.abortReason})`);
		ok(again.notes.some(n => n.includes('Nothing was staged')), `it says why nothing was committed (${JSON.stringify(again.notes)})`);

		ok(formatReleaseReport(report).includes('RELEASE OK'), 'the report renders as a success');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// [6] issue signals from a real ReAct loop
// ---------------------------------------------------------------------------

class UnknownToolProvider implements ILLMProvider {
	readonly name = 'scripted';
	private _turn = 0;
	async complete(): Promise<IAgentMessage> {
		this._turn++;
		// First call invents a tool, second answers normally.
		if (this._turn === 1) {
			return createMessage(MessageRole.Assistant, 'calling a tool that does not exist', {
				toolCalls: [{ id: 'c1', name: 'no_such_tool', arguments: {} }],
			});
		}
		return createMessage(MessageRole.Assistant, 'done');
	}
	async *stream(): AsyncIterableIterator<string> { yield ''; }
	countTokens(): number { return 1; }
	supportsStreaming(): boolean { return false; }
}

async function testIssueSignals(): Promise<void> {
	console.log('\n[6] issue signals recorded by the ReAct loop');

	const config: IAgentConfig = {
		provider: 'openai', model: 'm', apiKey: 'k', apiBase: 'http://127.0.0.1:9/v1',
		maxSteps: 10, maxContextTokens: 100000, maxOutputTokens: 1000,
		temperature: 0, stepTimeout: 5000, taskTimeout: 60000,
	};
	const agent = new AgentLoop(config, new UnknownToolProvider(), new ToolRegistry(),
		new AgentModeManager(), new AgentCheckpointManager({} as never), '/tmp');
	await agent.run('call something that does not exist');
	const log = agent.exportTaskLog('completed');
	agent.dispose();

	const signals = log.issueSignals ?? [];
	ok(signals.some(s => s.kind === 'unknown-tool' && s.detail === 'no_such_tool'),
		'the loop records the invented tool name as an issue signal');
	ok(log.steps.some(s => s.toolExecutions.some(e => !e.success && /Unknown tool/.test(e.error ?? ''))),
		'the failing tool call is still in the step record');

	// The signal has to survive into the evidence scan.
	const dir = tmpDir('signals');
	fs.writeFileSync(path.join(dir, `${log.id}.json`), JSON.stringify({ ...log, startedAt: Date.now() }));
	const evidence = collectRunEvidence({ tasksDir: dir, sessionsDir: dir });
	ok(evidence.issueGroups.some(g => g.kind === 'unknown-tool'),
		'the evidence scan surfaces the recorded signal');
	ok(evidence.failureGroups.some(g => g.tool === 'no_such_tool'), 'the tool failure is grouped by tool');
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// [7] methodology prompt
// ---------------------------------------------------------------------------

function testPromptSection(): void {
	console.log('\n[7] methodology prompt section');

	const off = buildSelfEvolvePromptSection({ ...DEFAULT_SELF_UPDATE_CONFIG, enabled: false });
	eq(off, '', 'no prompt section when the feature is disabled');

	const on = buildSelfEvolvePromptSection({ ...DEFAULT_SELF_UPDATE_CONFIG, enabled: true });
	ok(on.includes('agent_self_scan'), 'the prompt names the evidence tool');
	ok(on.includes('docs/self-evolve.md'), 'the prompt points at the full method');
	ok(on.includes('allow_release'), 'the prompt explains that releasing is gated');
	ok(!on.includes('Call `agent_release`'), 'the prompt does not tell the agent to release when it cannot');

	const releasable = buildSelfEvolvePromptSection({ ...DEFAULT_SELF_UPDATE_CONFIG, enabled: true, allowRelease: true, allowPush: true });
	ok(releasable.includes('agent_release'), 'the prompt names the release tool when enabled');
	ok(releasable.includes('aborts at the first failure'), 'the prompt states the gate aborts on failure');
}

// ---------------------------------------------------------------------------
// [8] poll owns its waiting budget
// ---------------------------------------------------------------------------

/**
 * Terminal stub: the Nth attempt exits with `codes[N-1]` (last code repeats)
 * after `delayMs`. Mirrors a check command that is slow but not hung.
 */
class ScriptedTerminalService implements ITerminalService {
	readonly _serviceBrand: undefined;
	attempts = 0;
	constructor(private readonly _codes: number[], private readonly _delayMs: number) { }
	createTerminal(): ITerminalInstance {
		const data = new Emitter<string>();
		const exit = new Emitter<{ code?: number } | undefined>();
		return {
			onData: data.event,
			onExit: exit.event,
			sendText: () => {
				const code = this._codes[Math.min(this.attempts++, this._codes.length - 1)];
				setTimeout(() => {
					data.fire(`check #${this.attempts}\n`);
					exit.fire({ code });
				}, this._delayMs);
			},
			dispose: () => { data.dispose(); exit.dispose(); },
		};
	}
}

class PollToolProvider implements ILLMProvider {
	readonly name = 'scripted';
	private _turn = 0;
	constructor(private readonly _args: Record<string, unknown>) { }
	async complete(): Promise<IAgentMessage> {
		this._turn++;
		if (this._turn === 1) {
			return createMessage(MessageRole.Assistant, 'waiting for the check to pass', {
				toolCalls: [{ id: 'c1', name: 'poll', arguments: this._args }],
			});
		}
		return createMessage(MessageRole.Assistant, 'done');
	}
	async *stream(): AsyncIterableIterator<string> { yield ''; }
	countTokens(): number { return 1; }
	supportsStreaming(): boolean { return false; }
}

async function testPollBudget(): Promise<void> {
	console.log('\n[8] poll owns its waiting budget');

	// Arithmetic: every attempt may burn its command timeout and every attempt but
	// the last may sleep — the declared budget has to cover BOTH.
	const args = { max_attempts: 3, initial_delay: 2, max_delay: 10, command_timeout: 1000 };
	ok(pollBudgetMs(args) >= 3 * 1000 + (2 + 4) * 1000,
		`the budget covers 3 command timeouts plus the 2s+4s backoff (${pollBudgetMs(args)}ms)`);
	ok(pollBudgetMs({ ...args, max_attempts: 6 }) > pollBudgetMs(args),
		'more attempts means a strictly larger budget');
	ok(pollBudgetMs({ max_attempts: 1, initial_delay: 0, max_delay: 0, command_timeout: 1000 }) >= 1000,
		'a single attempt still covers its command timeout');

	// The declared budget must extend the generic step timeout, and must stay
	// inside the agent's configured task budget even for an absurd request.
	const tool = new PollTool(new ScriptedTerminalService([0], 1), '/tmp');
	const cfg = { stepTimeout: 60000, taskTimeout: 600000 } as IAgentConfig;
	ok(tool.timeoutFor({}, cfg)! > cfg.stepTimeout,
		`the default poll budget extends past the 60s step timeout (${tool.timeoutFor({}, cfg)}ms)`);
	eq(
		tool.timeoutFor({ max_attempts: 60, initial_delay: 240, max_delay: 300, command_timeout: 180000 }, cfg),
		cfg.taskTimeout,
		'an absurd poll budget is still bounded by the task budget');
	eq(tool.timeoutFor({ max_attempts: 1, command_timeout: 100 }, cfg), cfg.stepTimeout,
		'a poll that needs less than the step timeout still gets the step timeout');

	// Behavioural: with a step timeout of 500ms, a poll that legitimately needs
	// ~3s must still complete. Waiting is the tool's whole purpose; the generic
	// step timeout killing it is the failure the logs show 43 times in 14 days.
	const config: IAgentConfig = {
		provider: 'openai', model: 'm', apiKey: 'k', apiBase: 'http://127.0.0.1:9/v1',
		maxSteps: 10, maxContextTokens: 100000, maxOutputTokens: 1000,
		temperature: 0, stepTimeout: 500, taskTimeout: 60000,
	};
	const registry = new ToolRegistry();
	registry.register(new PollTool(new ScriptedTerminalService([1, 1, 0], 300), '/tmp'));
	const agent = new AgentLoop(config,
		new PollToolProvider({ command: 'check', max_attempts: 4, initial_delay: 1, max_delay: 1, command_timeout: 600 }),
		registry, new AgentModeManager(), new AgentCheckpointManager({} as never), '/tmp');
	await agent.run('poll until the check passes');
	const log = agent.exportTaskLog('completed');
	agent.dispose();

	const exec = log.steps.flatMap(s => s.toolExecutions).find(e => e.toolName === 'poll');
	ok(!!exec, 'the poll tool really ran in the ReAct loop');
	ok(!!exec && exec.success,
		`the slow poll finished instead of dying on the step timeout (error=${exec?.error ?? 'none'})`);
	ok(!!exec && /Success/.test(String(exec.result)),
		`the successful poll reports its attempts (${String(exec?.result).slice(-70)})`);
}

async function main(): Promise<void> {
	console.log(`self-evolution tests — node ${process.version}`);
	testConfig();
	testSignatures();
	testEvidence();
	await testPipelineContract();
	testBumpVersion();
	await testPipelineRealGit();
	await testIssueSignals();
	testPromptSection();
	await testPollBudget();

	console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

void main();
