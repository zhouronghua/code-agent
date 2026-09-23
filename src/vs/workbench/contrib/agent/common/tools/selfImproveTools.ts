/*---------------------------------------------------------------------------------------------
 *  Self-evolution tools — the agent inspecting and releasing changes to itself
 *
 *    - agent_self_scan : FACTS from the agent's own run history (read-only)
 *    - agent_release   : the mechanical release gate (version bump + scripts +
 *                        pack + smoke + commit [+ push])
 *
 *  Registered by the CLI from the `self_update:` config section:
 *    `agent_self_scan` needs `enabled`, `agent_release` needs `allow_release`,
 *    and pushing additionally needs `allow_push`.
 *
 *  Both tools return evidence, never conclusions: deciding which finding is a
 *  real defect stays with the caller (see docs/self-evolve.md).
 *--------------------------------------------------------------------------------------------*/

import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from '../agentTools';
import {
	SelfUpdateConfig,
	collectRunEvidence,
	formatEvidenceReport,
	formatReleaseReport,
	runReleasePipeline,
	VersionBump,
} from '../agentSelfImprove';

export class SelfScanTool extends AgentTool {
	readonly name = 'agent_self_scan';
	readonly description =
		'Read your own run history and return FACTS about how recent tasks went: tool call/failure '
		+ 'histograms, failures grouped by normalized error (so a defect that happened 40 times is one '
		+ 'line, not 40), run signals (user /btw corrections, model fallbacks, context overflows, '
		+ 'reasoning loops, step-limit hits, unknown tools), and the slowest / most expensive tasks. '
		+ 'Use it before proposing any change to your own code: it says what is true, not what is '
		+ 'wrong. Session transcripts are never read.';
	readonly parameters = {
		type: 'object',
		properties: {
			days: {
				type: 'number',
				description: 'Look-back window in days (default from `self_update.evidence_days`).',
			},
			max_tasks: {
				type: 'number',
				description: 'Hard cap on task logs scanned, newest first (default from config).',
			},
		},
		required: [],
	};

	constructor(private readonly _config: SelfUpdateConfig) {
		super();
	}

	async execute(args: Record<string, unknown>): Promise<IToolResult> {
		const toolCallId = String(args._toolCallId ?? '');
		try {
			const evidence = collectRunEvidence({
				days: Number(args.days) > 0 ? Number(args.days) : undefined,
				maxTasks: Number(args.max_tasks) > 0 ? Number(args.max_tasks) : undefined,
			});
			return this.success(toolCallId, formatEvidenceReport(evidence));
		} catch (err) {
			return this.failure(toolCallId, `Could not collect run evidence: ${(err as Error).message}`);
		}
	}
}

export class AgentReleaseTool extends AgentTool {
	readonly name = 'agent_release';
	readonly description =
		'Release a change to your own code through a checked gate: version bump → `npm run` scripts '
		+ '(typecheck, tests, pack) → smoke the built CLI → git commit → optional push. It ABORTS at '
		+ 'the first failure and leaves nothing half-published: no commit on red tests, no --force, no '
		+ '--amend, no --no-verify, and package.json is restored if it aborts before committing. Use '
		+ '`dry_run` first when unsure. Pass a conventional commit message; the pipeline appends a '
		+ 'machine-verified trailer listing every step it actually ran.';
	readonly parameters = {
		type: 'object',
		properties: {
			message: {
				type: 'string',
				description: 'Commit message (conventional style, e.g. "fix: ..."; a body is welcome).',
			},
			bump: {
				type: 'string',
				enum: ['patch', 'minor', 'major', 'none'],
				description: 'Semver field to increment. Default: patch.',
			},
			push: {
				type: 'boolean',
				description: 'Push after committing. Only honoured when `self_update.allow_push` is true.',
			},
			dry_run: {
				type: 'boolean',
				description: 'Preflight only: validate the tree, run nothing that writes, commit nothing.',
			},
			repo_dir: {
				type: 'string',
				description: 'Repository to release. Default: the process working directory.',
			},
		},
		required: ['message'],
	};

	constructor(private readonly _config: SelfUpdateConfig) {
		super();
	}

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = String(args._toolCallId ?? '');
		if (signal?.aborted) {
			return this.failure(toolCallId, 'Release cancelled');
		}
		const message = String(args.message ?? '').trim();
		if (!message) {
			return this.failure(toolCallId, 'A commit message is required.');
		}

		const requestedPush = args.push === true;
		const allowPush = requestedPush && this._config.allowPush;
		const report = await runReleasePipeline({
			repoDir: typeof args.repo_dir === 'string' && args.repo_dir ? args.repo_dir : undefined,
			bump: (['patch', 'minor', 'major', 'none'] as const).includes(args.bump as VersionBump)
				? args.bump as VersionBump
				: 'patch',
			commitMessage: message,
			push: allowPush,
			remote: this._config.remote,
			dryRun: args.dry_run === true,
			scripts: this._config.releaseScripts,
			installCommand: this._config.installCommand || undefined,
		});

		const text = formatReleaseReport(report)
			+ (requestedPush && !allowPush
				? '\n  note: push was requested but `self_update.allow_push` is false — committed locally only.'
				: '');

		return report.ok
			? this.success(toolCallId, text)
			: this.failure(toolCallId, text);
	}
}
