/*---------------------------------------------------------------------------------------------
 *  Agent Self-Evolution (RSI) — find your own defects from run history, then release the fix
 *
 *  Adapted from the RSI-Harness "harness-rsi" method (a harness whose product is
 *  another harness): ground the loop in RECORDED HISTORY, separate FACTS from
 *  INTERPRETATION, keep every read BOUNDED, and publish only through a
 *  machine-checked gate. Here the subject is code-agent's own source code.
 *
 *  Two halves, both deterministic — the judgement stays with the agent:
 *
 *   1. collectRunEvidence(): reads ~/.agent/tasks/*.json (the per-task execution
 *      logs the agent already writes) and returns FACTS — tool histograms,
 *      failure signatures grouped after normalization, repeated-failure counts,
 *      run signals (user /btw corrections, model fallback, context overflow,
 *      reasoning loops, step-limit hits, FALLBACK switches), slow/costly tasks.
 *      It never returns transcripts, and every list is capped. Like
 *      `scan_workspaces` in RSIH, it answers "is this true", never "is this what
 *      you want" — that judgement is the agent's, against the user's task.
 *
 *   2. runReleasePipeline(): the mechanical release the agent must not improvise —
 *      version bump → typecheck/tests → pack → smoke the built CLI → commit →
 *      (optionally) push. It ABORTS AT THE FIRST FAILURE and then leaves nothing
 *      half-published: no commit on red tests, no `--force`, no `--amend`,
 *      no `--no-verify`, no push unless explicitly allowed, and package.json is
 *      restored if we abort before committing.
 *
 *  Everything here is injectable (runner, paths) so the behaviour above is unit
 *  tested rather than asserted.
 *
 *  Config (config.yaml, project first then ~/.agent):
 *    self_update:
 *      enabled: true            # register agent_self_scan (read-only evidence)
 *      allow_release: false     # register agent_release (bump/test/pack/commit)
 *      allow_push: false        # ...and let it push (requires allow_release)
 *      evidence_days: 14        # look-back window for run evidence
 *      evidence_tasks: 200      # hard cap on task logs scanned
 *      remote: origin
 *      release_scripts: ["typecheck", "test", "pack"]
 *      install_command: ""      # optional extra command, run after the scripts
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { agentHomeDir, agentHomeFileCandidates } from './agentHome';
import { parseScalarValue } from './agentConfig';
import { IAgentTaskLog, IIssueSignal } from 'vs/workbench/services/agent/common/agentModels';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface SelfUpdateConfig {
	/** Register the read-only evidence tools (`agent_self_scan`). */
	enabled: boolean;
	/** Register `agent_release` (version bump → tests → pack → commit). */
	allowRelease: boolean;
	/** Let `agent_release` push. Requires `allowRelease`. */
	allowPush: boolean;
	/** Evidence look-back window in days. */
	evidenceDays: number;
	/** Hard cap on how many task logs are scanned (newest first). */
	evidenceTasks: number;
	remote: string;
	/** `npm run <script>` steps run, in order, before commit. */
	releaseScripts: string[];
	/** Optional extra command run after the scripts ('' = skip). */
	installCommand: string;
}

export const DEFAULT_SELF_UPDATE_CONFIG: SelfUpdateConfig = {
	enabled: true,
	allowRelease: false,
	allowPush: false,
	evidenceDays: 14,
	evidenceTasks: 200,
	remote: 'origin',
	releaseScripts: ['typecheck', 'test', 'pack'],
	installCommand: '',
};

/** Parse the `self_update:` section (flat key: value, plus a scripts list). */
export function parseSelfUpdateYaml(text: string): Partial<SelfUpdateConfig> | undefined {
	const out: Partial<SelfUpdateConfig> = {};
	let inSection = false;
	let inScripts = false;
	let seen = false;

	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const indent = line.length - line.trimStart().length;

		if (indent === 0 && trimmed.endsWith(':')) {
			inSection = trimmed === 'self_update:';
			inScripts = false;
			continue;
		}
		if (!inSection) continue;

		if (trimmed.startsWith('- ')) {
			if (inScripts) {
				const value = parseScalarValue(trimmed.slice(2));
				if (value) {
					out.releaseScripts = out.releaseScripts || [];
					out.releaseScripts.push(value);
					seen = true;
				}
			}
			continue;
		}
		if (indent !== 2) continue;

		const idx = trimmed.indexOf(':');
		if (idx <= 0) continue;
		const key = trimmed.slice(0, idx).trim();
		const value = parseScalarValue(trimmed.slice(idx + 1));
		inScripts = key === 'release_scripts';
		seen = true;

		const bool = (v: string): boolean | undefined =>
			['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) ? true
				: ['0', 'false', 'no', 'off'].includes(v.toLowerCase()) ? false : undefined;
		const num = (v: string): number | undefined => {
			const n = Number(v);
			return Number.isFinite(n) && n > 0 ? n : undefined;
		};

		if (key === 'enabled') out.enabled = bool(value);
		else if (key === 'allow_release') out.allowRelease = bool(value);
		else if (key === 'allow_push') out.allowPush = bool(value);
		else if (key === 'evidence_days') out.evidenceDays = num(value);
		else if (key === 'evidence_tasks') out.evidenceTasks = num(value);
		else if (key === 'remote') out.remote = value;
		else if (key === 'install_command') out.installCommand = value;
	}
	return seen ? out : undefined;
}

/** Resolve the self-update configuration (project config.yaml then ~/.agent). */
export function loadSelfUpdateConfig(): SelfUpdateConfig {
	const candidates = [
		path.resolve('config.yaml'),
		path.resolve('config.json'),
		...agentHomeFileCandidates('config.yaml'),
		...agentHomeFileCandidates('config.json'),
	];
	for (const file of candidates) {
		try {
			if (!fs.existsSync(file)) continue;
			const text = fs.readFileSync(file, 'utf-8');
			let parsed: Partial<SelfUpdateConfig> | undefined;
			if (file.endsWith('.json')) {
				const json = JSON.parse(text) as { self_update?: Partial<SelfUpdateConfig> };
				parsed = json?.self_update;
			} else {
				parsed = parseSelfUpdateYaml(text);
			}
			if (parsed) {
				const merged: SelfUpdateConfig = { ...DEFAULT_SELF_UPDATE_CONFIG, ...parsed };
				// push implies release: a push-only pipeline could never produce
				// a commit, so it is not a state worth supporting.
				if (!merged.allowRelease) merged.allowPush = false;
				return merged;
			}
		} catch {
			// unreadable config — keep looking, defaults apply
		}
	}
	return { ...DEFAULT_SELF_UPDATE_CONFIG };
}

// ---------------------------------------------------------------------------
// Evidence collection (facts, bounded)
// ---------------------------------------------------------------------------

export interface IToolStat {
	tool: string;
	calls: number;
	failures: number;
	/** 0..1 — a tool that fails a lot is a candidate for a fix. */
	failureRate: number;
	maxMs: number;
}

export interface IFailureGroup {
	scope: 'tool' | 'task';
	tool?: string;
	/** Error text with ids/numbers/paths/quotes stripped, so repeats group. */
	signature: string;
	count: number;
	example: string;
	taskIds: string[];
}

export interface IIssueGroup {
	kind: string;
	count: number;
	taskIds: string[];
	example?: string;
}

export interface ITaskSummary {
	taskId: string;
	task: string;
	status: string;
	steps: number;
	toolCalls: number;
	durationMs: number;
	tokens: number;
}

export interface IRunEvidence {
	generatedAt: number;
	windowDays: number;
	tasksDir: string;
	/** Task-log files found on disk and how many fell inside the window. */
	filesOnDisk: number;
	scannedTasks: number;
	tasksInWindow: number;
	firstAt?: number;
	lastAt?: number;
	statusCounts: Record<string, number>;
	totalSteps: number;
	totalToolCalls: number;
	totalTokens: number;
	toolStats: IToolStat[];
	failureGroups: IFailureGroup[];
	issueGroups: IIssueGroup[];
	costlyTasks: ITaskSummary[];
	failingTasks: ITaskSummary[];
	sessionsInWindow: number;
	notes: string[];
}

export interface IEvidenceOptions {
	/** Defaults to `<agent home>/tasks`. */
	tasksDir?: string;
	/** Defaults to `<agent home>/sessions` (counted only, never read). */
	sessionsDir?: string;
	days?: number;
	maxTasks?: number;
	/** Cap on returned failure/issue groups (default 25). */
	maxGroups?: number;
	now?: number;
}

const MAX_SIGNATURE_CHARS = 160;
const MAX_EXAMPLE_CHARS = 240;

/** Does a string literal look like a filesystem path rather than a loose value? */
function looksLikePath(value: string): boolean {
	return value.startsWith('/') || value.includes('/') || /^[A-Za-z]:[\\/]/.test(value);
}

/**
 * Normalize error text into a stable signature so the same defect groups.
 *
 * Without this, "Unknown tool: read_file" and "Unknown tool: list_dir" look like
 * two findings and a defect that happened 40 times looks like 40 findings.
 *
 * Identifiers are deliberately preserved: `gcu500` and `gcu400` must stay
 * DISTINCT (an ISA-specific failure is not the same defect), while a number
 * delimited by non-word characters — or one carrying a unit, like `30000ms` —
 * is boilerplate and gets collapsed.
 */
export function normalizeFailureSignature(text: string): string {
	return text
		.replace(/\b[0-9a-f]{8,}\b/gi, '<id>')                       // hashes / ids / commit shas
		// Durations and sizes keep their unit so the signature stays readable.
		.replace(/(\d+(?:\.\d+)?)\s*(ms|msec|s|sec|secs|m|min|mins|h|hr|hrs|kb|mb|gb|tb|%)\b/gi, '<n>$2')
		.replace(/'(?:[^'\\]|\\.){0,300}'/g, m => (looksLikePath(m.slice(1, -1)) ? '<path>' : '<str>'))
		.replace(/"(?:[^"\\]|\\.){0,300}"/g, m => (looksLikePath(m.slice(1, -1)) ? '<path>' : '<str>'))
		.replace(/\/(?:[\w.@-]+\/)+[\w.@-]+/g, '<path>')             // bare absolute paths
		.replace(/\b\d+(?:\.\d+)?\b/g, '<n>')                        // standalone numbers
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, MAX_SIGNATURE_CHARS);
}

/** Read the newest task logs (filename order is `task_<epoch>_<rand>.json`). */
function readTaskLogs(dir: string, maxTasks: number): { logs: IAgentTaskLog[]; filesOnDisk: number; truncated: boolean } {
	let files: string[] = [];
	try {
		files = fs.readdirSync(dir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
	} catch {
		return { logs: [], filesOnDisk: 0, truncated: false };
	}
	// `task_<epoch>_<rand>` sorts chronologically for the same epoch width.
	files.sort().reverse();
	const truncated = files.length > maxTasks;
	const logs: IAgentTaskLog[] = [];
	for (const file of files.slice(0, maxTasks)) {
		try {
			logs.push(JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8')) as IAgentTaskLog);
		} catch {
			// a corrupt log must not abort the scan
		}
	}
	return { logs, filesOnDisk: files.length, truncated };
}

function countFiles(dir: string, pred: (name: string) => boolean): number {
	try {
		return fs.readdirSync(dir).filter(pred).length;
	} catch {
		return 0;
	}
}

/**
 * Collect run evidence from the agent's own task logs.
 *
 * Facts only: no ranking, no prose, no transcripts. Every list is capped, because
 * the point is to make a long history reviewable inside one context window.
 */
export function collectRunEvidence(opts: IEvidenceOptions = {}): IRunEvidence {
	const now = opts.now ?? Date.now();
	const days = opts.days ?? DEFAULT_SELF_UPDATE_CONFIG.evidenceDays;
	const maxTasks = opts.maxTasks ?? DEFAULT_SELF_UPDATE_CONFIG.evidenceTasks;
	const maxGroups = opts.maxGroups ?? 25;
	const tasksDir = opts.tasksDir ?? path.join(agentHomeDir(), 'tasks');
	const sessionsDir = opts.sessionsDir ?? path.join(agentHomeDir(), 'sessions');

	const { logs, filesOnDisk, truncated } = readTaskLogs(tasksDir, maxTasks);
	const cutoff = now - days * 24 * 60 * 60 * 1000;
	const inWindow = logs.filter(l => (l.startedAt ?? 0) >= cutoff);

	const statusCounts: Record<string, number> = {};
	const toolCalls = new Map<string, { calls: number; failures: number; maxMs: number }>();
	const toolFailureGroups = new Map<string, IFailureGroup>();
	const taskFailureGroups = new Map<string, IFailureGroup>();
	const issueGroups = new Map<string, IIssueGroup>();
	const summaries: ITaskSummary[] = [];

	let totalSteps = 0;
	let totalToolCalls = 0;
	let totalTokens = 0;
	let firstAt: number | undefined;
	let lastAt: number | undefined;

	const noteIssue = (kind: string, taskId: string, detail?: string): void => {
		const existing = issueGroups.get(kind) ?? { kind, count: 0, taskIds: [], example: detail };
		existing.count++;
		if (!existing.taskIds.includes(taskId)) existing.taskIds.push(taskId);
		if (!existing.example && detail) existing.example = detail;
		issueGroups.set(kind, existing);
	};

	const noteFailure = (
		group: { scope: 'tool' | 'task'; tool?: string; signature: string; count: number; example: string; taskIds: string[] },
		taskId: string,
	) => {
		const key = `${group.scope}|${group.tool ?? ''}|${group.signature}`;
		const map = group.scope === 'tool' ? toolFailureGroups : taskFailureGroups;
		const existing = map.get(key) ?? group;
		existing.count++;
		if (!existing.taskIds.includes(taskId)) existing.taskIds.push(taskId);
		map.set(key, existing);
	};

	for (const log of inWindow) {
		const taskId = log.id;
		statusCounts[log.status] = (statusCounts[log.status] ?? 0) + 1;
		totalSteps += log.totalSteps ?? 0;
		totalToolCalls += log.totalToolCalls ?? 0;
		const tokens = log.tokenUsage?.totalTokens ?? 0;
		totalTokens += tokens;
		if (log.startedAt) {
			firstAt = firstAt === undefined ? log.startedAt : Math.min(firstAt, log.startedAt);
			lastAt = lastAt === undefined ? log.startedAt : Math.max(lastAt, log.startedAt);
		}

		summaries.push({
			taskId,
			task: (log.task ?? '').slice(0, 160),
			status: log.status,
			steps: log.totalSteps ?? 0,
			toolCalls: log.totalToolCalls ?? 0,
			durationMs: log.durationMs ?? 0,
			tokens,
		});

		if (log.status === 'failed' && log.error) {
			noteFailure({
				scope: 'task',
				signature: normalizeFailureSignature(String(log.error)),
				count: 0,
				example: String(log.error).slice(0, MAX_EXAMPLE_CHARS),
				taskIds: [],
			}, taskId);
		}

		for (const signal of log.issueSignals ?? []) {
			noteIssue(signal.kind, taskId, signal.detail);
		}
		for (const sw of log.modelSwitches ?? []) {
			noteIssue(`model-switch:${sw.reason}`, taskId, `${sw.from} → ${sw.to}`);
		}

		for (const step of log.steps ?? []) {
			for (const exec of step.toolExecutions ?? []) {
				const stat = toolCalls.get(exec.toolName) ?? { calls: 0, failures: 0, maxMs: 0 };
				stat.calls++;
				stat.maxMs = Math.max(stat.maxMs, exec.durationMs ?? 0);
				if (!exec.success) {
					stat.failures++;
					// `result` holds the (possibly truncated) output; `error` the failure text.
					const raw = exec.error || exec.result || 'tool failed';
					noteFailure({
						scope: 'tool',
						tool: exec.toolName,
						signature: normalizeFailureSignature(String(raw)),
						count: 0,
						example: String(raw).slice(0, MAX_EXAMPLE_CHARS),
						taskIds: [],
					}, taskId);
					const unknown = /unknown tool:\s*(\S+)/i.exec(String(raw));
					if (unknown) noteIssue('unknown-tool', taskId, unknown[1]);
				}
				toolCalls.set(exec.toolName, stat);
			}
		}
	}

	const toolStats: IToolStat[] = [...toolCalls.entries()]
		.map(([tool, s]) => ({
			tool,
			calls: s.calls,
			failures: s.failures,
			failureRate: s.calls > 0 ? Number((s.failures / s.calls).toFixed(3)) : 0,
			maxMs: s.maxMs,
		}))
		.sort((a, b) => b.failures - a.failures || b.calls - a.calls);

	const byCount = (a: { count: number }, b: { count: number }) => b.count - a.count;
	const failureGroups = [...toolFailureGroups.values(), ...taskFailureGroups.values()]
		.sort((a, b) => b.count - a.count)
		.slice(0, maxGroups);
	const issueList = [...issueGroups.values()].sort(byCount).slice(0, maxGroups);

	const notes: string[] = [];
	notes.push('Session transcripts are NOT read (bounded by design): only per-task execution logs.');
	if (truncated) notes.push(`Scanned the newest ${maxTasks} of ${filesOnDisk} task logs (cap reached).`);
	if (filesOnDisk === 0) notes.push(`No task logs under ${tasksDir} — evidence is empty, not "healthy".`);
	if (logs.length > 0 && inWindow.length < logs.length) {
		notes.push(`${logs.length - inWindow.length} scanned log(s) fall outside the ${days}-day window.`);
	}

	return {
		generatedAt: now,
		windowDays: days,
		tasksDir,
		filesOnDisk,
		scannedTasks: logs.length,
		tasksInWindow: inWindow.length,
		firstAt,
		lastAt,
		statusCounts,
		totalSteps,
		totalToolCalls,
		totalTokens,
		toolStats,
		failureGroups,
		issueGroups: issueList,
		costlyTasks: [...summaries].sort((a, b) => b.tokens - a.tokens || b.durationMs - a.durationMs).slice(0, 10),
		failingTasks: summaries.filter(s => s.status !== 'completed').sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
		sessionsInWindow: countFiles(sessionsDir, f => f.startsWith('session_') && f.endsWith('.json')),
		notes,
	};
}

/** Render the evidence as a compact report (facts + counts, grouped faults). */
export function formatEvidenceReport(e: IRunEvidence): string {
	const lines: string[] = [];
	const ts = (v?: number) => (v ? new Date(v).toISOString().slice(0, 16).replace('T', ' ') : '?');

	lines.push(`RUN EVIDENCE — last ${e.windowDays} days (${e.tasksInWindow}/${e.filesOnDisk} task logs)`);
	lines.push(`  window: ${ts(e.firstAt)} .. ${ts(e.lastAt)}`);
	lines.push(`  tasks: ${e.tasksInWindow} | steps: ${e.totalSteps} | tool calls: ${e.totalToolCalls} | tokens: ${e.totalTokens}`);
	lines.push(`  status: ${Object.entries(e.statusCounts).map(([k, v]) => `${k} ${v}`).join(' | ') || '(none)'}`);

	if (e.issueGroups.length > 0) {
		lines.push('');
		lines.push('RUN SIGNALS (from task logs)');
		for (const g of e.issueGroups) {
			lines.push(`  ${g.count}x ${g.kind}${g.example ? ` — ${g.example.slice(0, 120)}` : ''} (tasks: ${g.taskIds.slice(0, 5).join(', ')})`);
		}
	}

	if (e.failureGroups.length > 0) {
		lines.push('');
		lines.push('FAILURES (grouped by normalized error — the raw count is the repeat rate)');
		for (const g of e.failureGroups) {
			const where = g.scope === 'tool' ? `tool ${g.tool}` : 'task';
			lines.push(`  ${g.count}x [${where}] ${g.signature}`);
			lines.push(`        e.g. ${g.example.replace(/\s+/g, ' ').slice(0, 160)}`);
			lines.push(`        tasks: ${g.taskIds.slice(0, 6).join(', ')}`);
		}
	}

	if (e.toolStats.length > 0) {
		lines.push('');
		lines.push('TOOL USE (by failures, then calls)');
		for (const t of e.toolStats.slice(0, 20)) {
			lines.push(`  ${t.tool.padEnd(18)} ${String(t.calls).padStart(5)} calls  ${String(t.failures).padStart(3)} failed  (${(t.failureRate * 100).toFixed(1)}%)  max ${(t.maxMs / 1000).toFixed(1)}s`);
		}
	}

	if (e.costlyTasks.length > 0) {
		lines.push('');
		lines.push('COSTLIEST TASKS');
		for (const t of e.costlyTasks) {
			lines.push(`  ${t.taskId} ${String(t.tokens).padStart(7)} tok ${String(Math.round(t.durationMs / 1000)).padStart(5)}s steps=${t.steps} tools=${t.toolCalls} [${t.status}] ${t.task.slice(0, 70)}`);
		}
	}

	if (e.failingTasks.length > 0) {
		lines.push('');
		lines.push('NON-COMPLETED TASKS');
		for (const t of e.failingTasks) {
			lines.push(`  ${t.taskId} [${t.status}] steps=${t.steps} ${t.task.slice(0, 90)}`);
		}
	}

	lines.push('');
	lines.push('NOTES');
	for (const n of e.notes) lines.push(`  - ${n}`);
	lines.push('');
	lines.push('Facts only — deciding which finding is a real defect (and whether it is worth changing) is the reviewer\'s job.');
	return lines.join('\n');
}

/**
 * The methodology handed to the agent when the self-update tools are active.
 *
 * Kept short here on purpose: it is a checklist, not the full method. The long
 * form lives in docs/self-evolve.md.
 */
export function buildSelfEvolvePromptSection(config: SelfUpdateConfig): string {
	if (!config.enabled) return '';
	const lines: string[] = [];
	lines.push('');
	lines.push('## Self-evolution (find your own defects, then release the fix)');
	lines.push('');
	lines.push('You can inspect your own run history and release a fix for a defect you find there.');
	lines.push('Never skip a step — a change without the evidence below is not a fix, it is a guess.');
	lines.push('');
	lines.push('1. **Evidence first.** Call `agent_self_scan` before proposing anything. It returns facts');
	lines.push('   (tool histograms, failure signatures grouped by normalized error, run signals).');
	lines.push('   Repeated signatures and high failure rates are candidates; a single failure is not.');
	lines.push('');
	lines.push('2. **Judge against the user\'s task, not against elegance.** Evidence says a thing is true,');
	lines.push('   it does not say the thing is wrong. A tool that failed once because the user passed a bad');
	lines.push('   path is not a defect. If the evidence supports two readings, say both and ask.');
	lines.push('');
	lines.push('3. **Read only what the signature points at.** Find the code path behind the group');
	lines.push('   (grep the tool name / error text), and prefer the smallest change that removes the');
	lines.push('   failure mode. Do not "improve" neighbouring code.');
	lines.push('');
	lines.push('4. **Write the failing case down first.** Add or extend a test that fails before your change');
	lines.push('   and passes after it. No test, no release.');
	lines.push('');
	lines.push('5. **Say the plan out loud before editing**, including what you decided NOT to change and why.');
	lines.push('   If the plan turns out to be impossible, stop and explain the alternative — never silently swap it.');
	lines.push('');
	if (config.allowRelease) {
		lines.push('6. **Release through the gate.** Call `agent_release` with a conventional commit message');
		lines.push('   (it bumps the version, runs typecheck + tests, packs, smokes the built CLI, then commits'
			+ (config.allowPush ? ' and pushes).' : '; pushing needs allow_push in config.'));
		lines.push('   It aborts at the first failure and leaves nothing half-published. Report its step-by-step');
		lines.push('   output verbatim; never claim a release you did not see the pipeline confirm.');
	} else {
		lines.push('6. **Stop before releasing.** `self_update.allow_release` is off, so you may prepare and');
		lines.push('   verify the fix but must hand the release to the user (version bump, tests, pack, commit).');
	}
	lines.push('');
	lines.push('Full method: docs/self-evolve.md');
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Release pipeline (the mechanical part the agent must not improvise)
// ---------------------------------------------------------------------------

export interface ICommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface ICommandOptions {
	cwd: string;
	timeoutMs?: number;
	shell?: boolean;
	/** Written to the child's stdin, then closed (e.g. `git commit -F -`). */
	stdin?: string;
}

export type CommandRunner = (cmd: string, args: string[], opts: ICommandOptions) => Promise<ICommandResult>;

const DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
/** Keep the tail of a failing command's output: the head is usually just noise. */
const OUTPUT_TAIL_CHARS = 4000;

export const defaultCommandRunner: CommandRunner = (cmd, args, opts) => new Promise(resolve => {
	const child = spawn(cmd, args, { cwd: opts.cwd, shell: opts.shell ?? false });
	let stdout = '';
	let stderr = '';
	let done = false;
	const finish = (code: number) => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		resolve({ code, stdout, stderr });
	};
	const timer = setTimeout(() => {
		// A hung build/test would otherwise block the agent forever.
		try { child.kill('SIGKILL'); } catch { /* already gone */ }
		stderr += `\n[timeout after ${opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS}ms]`;
		finish(124);
	}, opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
	child.stdout?.on('data', d => { stdout += d.toString(); });
	child.stderr?.on('data', d => { stderr += d.toString(); });
	child.on('error', err => { stderr += String(err.message); finish(127); });
	child.on('close', code => finish(code ?? 1));

	// A command that reads stdin (`git commit -F -`) must always see EOF, or it
	// blocks until the timeout instead of committing.
	if (child.stdin) {
		if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
		child.stdin.end();
	}
});

export type VersionBump = 'patch' | 'minor' | 'major' | 'none';

export interface IReleaseOptions {
	/** The repository to release (defaults to the current directory). */
	repoDir?: string;
	bump?: VersionBump;
	commitMessage: string;
	push?: boolean;
	remote?: string;
	/** Validate only: runs preflight + scripts, writes nothing, commits nothing. */
	dryRun?: boolean;
	scripts?: string[];
	installCommand?: string;
	/** Append a machine-verified trailer to the commit message (default true). */
	trailer?: boolean;
	timeoutMs?: number;
	run?: CommandRunner;
}

export interface IReleaseStep {
	name: string;
	cmd?: string;
	code: number;
	ok: boolean;
	ms: number;
	/** Tail of the combined output, for a failing step. */
	outputTail?: string;
	skipped?: boolean;
}

export interface IReleaseReport {
	ok: boolean;
	dryRun: boolean;
	repoDir: string;
	versionFrom: string;
	versionTo: string;
	committed: boolean;
	commitHash?: string;
	pushed: boolean;
	steps: IReleaseStep[];
	abortedAt?: string;
	abortReason?: string;
	notes: string[];
}

/** Semver bump for a plain `x.y.z` version. */
export function bumpVersion(version: string, kind: VersionBump): string {
	if (kind === 'none') return version;
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (!m) throw new Error(`Cannot bump version: "${version}" is not semver`);
	const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
	if (kind === 'major') return `${major + 1}.0.0`;
	if (kind === 'minor') return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function tail(text: string): string {
	const combined = text.trim();
	return combined.length > OUTPUT_TAIL_CHARS ? `…\n${combined.slice(-OUTPUT_TAIL_CHARS)}` : combined;
}

/**
 * Run the release pipeline: preflight → bump → scripts → smoke → commit → push.
 *
 * Aborts at the first failure so a red build can never be committed, and restores
 * package.json when it aborts before committing (no half-published state).
 */
export async function runReleasePipeline(opts: IReleaseOptions): Promise<IReleaseReport> {
	const repoDir = opts.repoDir ?? process.cwd();
	const run = opts.run ?? defaultCommandRunner;
	const dryRun = opts.dryRun ?? false;
	const remote = opts.remote ?? 'origin';
	const scripts = opts.scripts ?? DEFAULT_SELF_UPDATE_CONFIG.releaseScripts;
	const wantPush = opts.push ?? false;
	const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
	const pkgPath = path.join(repoDir, 'package.json');

	const steps: IReleaseStep[] = [];
	const notes: string[] = [];
	let versionFrom = '';
	let versionTo = '';
	let committed = false;
	let commitHash: string | undefined;
	let pushed = false;
	let abortedAt: string | undefined;
	let abortReason: string | undefined;

	const record = (step: IReleaseStep): IReleaseStep => {
		steps.push(step);
		return step;
	};
	if (dryRun) {
		notes.push('dry-run validates preflight only (repo state, semver, branch): the version bump, the '
			+ 'release scripts and the commit are skipped because each of them writes to the tree/index.');
	}
	const abort = (name: string, reason: string): IReleaseReport => {
		abortedAt = name;
		abortReason = reason;
		return report(false);
	};
	const report = (ok: boolean): IReleaseReport => ({
		ok, dryRun, repoDir, versionFrom, versionTo, committed, commitHash, pushed,
		steps, abortedAt, abortReason, notes,
	});

	// ---- preflight ----------------------------------------------------------
	let currentVersion = '';
	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
		currentVersion = String(pkg.version ?? '');
	} catch (err) {
		record({ name: 'read-package.json', cmd: pkgPath, code: 1, ok: false, ms: 0, outputTail: (err as Error).message });
		return abort('read-package.json', `cannot read ${pkgPath}`);
	}
	versionFrom = currentVersion;
	if (!/^\d+\.\d+\.\d+/.test(currentVersion)) {
		return abort('read-package.json', `package.json version "${currentVersion}" is not semver`);
	}
	record({ name: 'read-package.json', code: 0, ok: true, ms: 0 });

	const git = async (args: string[]): Promise<ICommandResult> => run('git', args, { cwd: repoDir, timeoutMs: 60_000 });

	let t0 = Date.now();
	const gitDir = await git(['rev-parse', '--git-dir']);
	record({ name: 'git-repository', cmd: 'git rev-parse --git-dir', code: gitDir.code, ok: gitDir.code === 0, ms: Date.now() - t0, outputTail: gitDir.code === 0 ? undefined : tail(gitDir.stderr || gitDir.stdout) });
	if (gitDir.code !== 0) return abort('git-repository', `${repoDir} is not a git repository`);

	// A merge/rebase in progress must never receive an automated commit.
	const inProgress = ['.git/MERGE_HEAD', '.git/rebase-merge', '.git/rebase-apply', '.git/CHERRY_PICK_HEAD']
		.filter(p => fs.existsSync(path.join(repoDir, p)));
	t0 = Date.now();
	const unmerged = await git(['diff', '--name-only', '--diff-filter=U']);
	const conflicting = unmerged.stdout.trim().split('\n').filter(Boolean);
	const stateOk = inProgress.length === 0 && conflicting.length === 0;
	record({
		name: 'git-state', cmd: 'git diff --name-only --diff-filter=U', code: stateOk ? 0 : 1, ok: stateOk, ms: Date.now() - t0,
		outputTail: stateOk ? undefined : `in-progress: ${inProgress.join(', ')}; unmerged: ${conflicting.slice(0, 10).join(', ')}`,
	});
	if (!stateOk) return abort('git-state', 'a merge/rebase/cherry-pick is in progress or files are unmerged');

	t0 = Date.now();
	const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
	const branchName = branch.stdout.trim();
	const detached = branchName === 'HEAD' || branchName === '';
	const branchOk = !(wantPush && detached);
	record({
		name: 'git-branch', cmd: 'git rev-parse --abbrev-ref HEAD', code: branchOk ? 0 : 1, ok: branchOk, ms: Date.now() - t0,
		outputTail: branchOk ? undefined : 'HEAD is detached — nothing to push',
	});
	if (!branchOk) return abort('git-branch', 'cannot push from a detached HEAD');

	// ---- version bump -------------------------------------------------------
	try {
		versionTo = bumpVersion(currentVersion, opts.bump ?? 'patch');
	} catch (err) {
		return abort('bump-version', (err as Error).message);
	}
	t0 = Date.now();
	if (dryRun) {
		record({ name: 'bump-version', code: 0, ok: true, ms: 0, skipped: true, outputTail: `dry-run: would write ${currentVersion} → ${versionTo}` });
	} else {
		const raw = fs.readFileSync(pkgPath, 'utf-8');
		// Replace only the top-level version field, preserving formatting.
		const updated = raw.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${versionTo}$3`);
		fs.writeFileSync(pkgPath, updated, 'utf-8');
		const written = /"version"\s*:\s*"([^"]+)"/.exec(updated)?.[1];
		const ok = written === versionTo;
		record({ name: 'bump-version', code: ok ? 0 : 1, ok, ms: Date.now() - t0, outputTail: ok ? `${currentVersion} → ${versionTo}` : `wrote "${written}"` });
		if (!ok) return abort('bump-version', 'package.json version was not updated');
	}

	// ---- verification (the gate) -------------------------------------------
	if (!dryRun) {
		for (const script of scripts) {
			t0 = Date.now();
			const res = await run('npm', ['run', script], { cwd: repoDir, timeoutMs });
			const ok = res.code === 0;
			record({ name: `npm run ${script}`, cmd: `npm run ${script}`, code: res.code, ok, ms: Date.now() - t0, outputTail: ok ? undefined : tail(res.stdout + '\n' + res.stderr) });
			if (!ok) {
				// Nothing may be committed on a red build; put the version back.
				restoreVersion(pkgPath, versionFrom);
				notes.push(`package.json version restored to ${versionFrom} (no commit was made).`);
				return abort(`npm run ${script}`, `${script} failed (exit ${res.code}); aborting before commit`);
			}
		}

		if (opts.installCommand) {
			t0 = Date.now();
			const res = await run(opts.installCommand, [], { cwd: repoDir, timeoutMs, shell: true });
			const ok = res.code === 0;
			record({ name: 'install', cmd: opts.installCommand, code: res.code, ok, ms: Date.now() - t0, outputTail: ok ? undefined : tail(res.stdout + '\n' + res.stderr) });
			if (!ok) {
				restoreVersion(pkgPath, versionFrom);
				notes.push(`package.json version restored to ${versionFrom} (no commit was made).`);
				return abort('install', `install command failed (exit ${res.code})`);
			}
		}

		// Smoke the artifact the pack step just produced (if it exists): a stale
		// build would otherwise be published under the NEW version number.
		const cliPath = path.join(repoDir, 'build', 'agent-cli.js');
		if (fs.existsSync(cliPath)) {
			t0 = Date.now();
			const res = await run(process.execPath, [cliPath, '--version'], { cwd: repoDir, timeoutMs: 60_000 });
			const seen = (res.stdout + res.stderr).trim();
			const ok = res.code === 0 && seen.includes(versionTo);
			record({
				name: 'smoke built CLI', cmd: `node build/agent-cli.js --version`, code: ok ? 0 : 1, ok, ms: Date.now() - t0,
				outputTail: ok ? seen.split('\n')[0] : `expected version ${versionTo}, got "${seen.slice(0, 120)}"`,
			});
			if (!ok) {
				restoreVersion(pkgPath, versionFrom);
				notes.push(`package.json version restored to ${versionFrom} (no commit was made).`);
				return abort('smoke built CLI', `build/agent-cli.js does not report ${versionTo}`);
			}
		} else {
			record({ name: 'smoke built CLI', code: 0, ok: true, ms: 0, skipped: true, outputTail: 'no build/agent-cli.js (pack step not in release_scripts)' });
		}
	} else {
		record({ name: 'verification', code: 0, ok: true, ms: 0, skipped: true, outputTail: `dry-run: would run ${scripts.map(s => `npm run ${s}`).join(', ')}` });
	}

	// ---- commit -------------------------------------------------------------
	// A dry run validates only: staging writes to the index, so it is skipped
	// too (`git add -A` is NOT a read-only operation).
	if (dryRun) {
		record({ name: 'git add -A', code: 0, ok: true, ms: 0, skipped: true, outputTail: 'dry-run: would stage all changes' });
		record({ name: 'git commit', code: 0, ok: true, ms: 0, skipped: true, outputTail: 'dry-run: would commit' });
		record({
			name: 'git push', code: 0, ok: true, ms: 0, skipped: true,
			outputTail: wantPush ? `dry-run: would push to ${remote}` : 'push not requested (allow_push is off)',
		});
		return report(true);
	}

	const message = opts.trailer === false
		? opts.commitMessage
		: `${opts.commitMessage.trimEnd()}\n\nVerified-by: code-agent self-update ${versionFrom} -> ${versionTo}\n`
			+ steps.filter(s => !s.skipped && s.cmd)
				.map(s => `  ${s.name} (${(s.ms / 1000).toFixed(1)}s)`).join('\n');

	t0 = Date.now();
	const add = await git(['add', '-A']);
	record({ name: 'git add -A', cmd: 'git add -A', code: add.code, ok: add.code === 0, ms: Date.now() - t0, outputTail: add.code === 0 ? undefined : tail(add.stderr) });
	if (add.code !== 0) {
		restoreVersion(pkgPath, versionFrom);
		return abort('git add -A', 'staging failed');
	}

	const staged = await git(['diff', '--cached', '--name-only']);
	if (staged.stdout.trim() === '') {
		record({ name: 'git commit', code: 0, ok: true, ms: 0, skipped: true, outputTail: 'nothing staged — skipped' });
		notes.push('Nothing was staged, so no commit was created.');
		return report(true);
	}

	t0 = Date.now();
	// The message goes in on stdin (`-F -`): a multi-line body plus the trailer
	// would be awkward to pass through argv.
	const commit = await run('git', ['commit', '-F', '-'], { cwd: repoDir, timeoutMs: 120_000, stdin: message });
	record({ name: 'git commit', cmd: 'git commit -F -', code: commit.code, ok: commit.code === 0, ms: Date.now() - t0, outputTail: commit.code === 0 ? undefined : tail(commit.stderr || commit.stdout) });
	if (commit.code !== 0) {
		notes.push(`Commit failed; package.json still holds ${versionTo} — the change is staged, fix and re-run.`);
		return abort('git commit', 'commit failed');
	}
	committed = true;
	const rev = await git(['rev-parse', 'HEAD']);
	commitHash = rev.stdout.trim() || undefined;

	// ---- push (opt-in only) -------------------------------------------------
	if (!wantPush) {
		record({ name: 'git push', code: 0, ok: true, ms: 0, skipped: true, outputTail: 'push not requested (allow_push is off)' });
		return report(true);
	}
	t0 = Date.now();
	const push = await git(['push', remote, 'HEAD']);
	const pushOk = push.code === 0;
	record({ name: 'git push', cmd: `git push ${remote} HEAD`, code: push.code, ok: pushOk, ms: Date.now() - t0, outputTail: pushOk ? undefined : tail(push.stderr || push.stdout) });
	if (!pushOk) {
		notes.push('The commit exists locally; only the push failed. Re-run to push (no force push is ever attempted).');
		return abort('git push', `push to ${remote} failed`);
	}
	pushed = true;
	return report(true);
}

/** Put the previous version back after an aborted release. */
function restoreVersion(pkgPath: string, version: string): void {
	try {
		const raw = fs.readFileSync(pkgPath, 'utf-8');
		fs.writeFileSync(pkgPath, raw.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${version}$3`), 'utf-8');
	} catch {
		// best effort: the report already says which version is on disk
	}
}

/** Render a release report for the console / tool output. */
export function formatReleaseReport(r: IReleaseReport): string {
	const lines: string[] = [];
	lines.push(`${r.ok ? 'RELEASE OK' : 'RELEASE ABORTED'}${r.dryRun ? ' (dry run)' : ''} — ${r.repoDir}`);
	lines.push(`  version: ${r.versionFrom} → ${r.versionTo}`);
	for (const s of r.steps) {
		const mark = s.skipped ? '–' : s.ok ? '✓' : '✗';
		lines.push(`  ${mark} ${s.name} (${(s.ms / 1000).toFixed(1)}s)${s.outputTail ? ` — ${s.outputTail.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`);
	}
	lines.push(`  committed: ${r.committed}${r.commitHash ? ` (${r.commitHash.slice(0, 10)})` : ''} | pushed: ${r.pushed}`);
	if (r.abortedAt) lines.push(`  aborted at: ${r.abortedAt} — ${r.abortReason}`);
	for (const n of r.notes) lines.push(`  note: ${n}`);
	return lines.join('\n');
}

/** Tail of a task log's issue signals, exposed for tests / tooling. */
