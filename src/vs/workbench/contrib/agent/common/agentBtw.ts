/*---------------------------------------------------------------------------------------------
 *  /btw mid-task intervention — intent classification + supersede evaluation
 *
 *  A `/btw <text>` sent while the agent is working used to be treated as a pure
 *  additive hint: the running plan kept going and the text was injected as an
 *  extra user message at the next loop iteration. That is wrong whenever the
 *  instruction actually REPLACES the goal ("cancel that and rebuild against the
 *  latest version"): the agent keeps burning minutes on a long build/poll before
 *  it ever reads the redirect, and the results of the obsolete work are wasted.
 *
 *  This module classifies the intervention so the loop can tell the two apart:
 *    - 'cancel'    — an explicit stop command (`/btw cancel`)
 *    - 'supersede' — the running task/plan is obsolete and must be abandoned
 *                    (the in-flight tool call is aborted immediately)
 *    - 'hint'      — additive guidance; keep the current plan and apply it
 *    - 'unknown'   — no strong signal → let the LLM evaluator decide
 *
 *  High precision is deliberate: a false 'supersede' aborts real work, so the
 *  regex list only matches unambiguous redirects and every ambiguous wording is
 *  handed to the evaluator instead.
 *--------------------------------------------------------------------------------------------*/

import { IAgentMessage, MessageRole, createMessage } from 'vs/workbench/services/agent/common/agentModels';

/** What a mid-task `/btw` instruction means for the work already in flight. */
export type BtwIntent = 'cancel' | 'supersede' | 'hint' | 'unknown';

/**
 * Explicit stop commands. Matched against the *whole* trimmed instruction (so
 * "stop" alone cancels, while "stop the build and rerun against latest" is a
 * redirect handled by the supersede patterns below).
 */
const CANCEL_COMMANDS = new Set([
	'cancel', 'abort', 'stop', 'halt', 'kill',
	'取消', '停止', '停下', '中断', '终止',
]);

/** Additive-only instructions: the current plan stays valid. */
const ADDITIVE_PREFIXES: RegExp[] = [
	/^注意/,
	/^记得/,
	/^记住/,
	/^提醒/,
	/^补充(一下)?(：|:)?/,
	/^另外/,
	/^顺便/,
	/^还有/,
	/^(note|remember|also|fyi|tip|additionally|btw)[\s,:]/i,
];

/**
 * Unambiguous redirects: the standing request is replaced, redone against a
 * newer state, or re-sequenced so the in-flight step is no longer valid.
 */
export const BTW_SUPERSEDE_PATTERNS: RegExp[] = [
	// Replace the goal.
	/(改为|改成|换成|换个|换一个|改做)/,
	// Restart / redo work (specific verbs only — a bare "重新" is ambiguous and
	// goes to the evaluator).
	/(重来|重跑|重做|重试|重新(执行|跑|做|开始|生成|发布|安装|部署|升级|构建|编译|打包|提交|推送|测试|下载|上传|计算|实现|写|改))/,
	// Discard what is already running.
	/(算了|放弃|撤回|作废|不要做了|不用做了|别做了)/,
	// Anchored to the newest state/version — a rerun is required.
	/(基于最新|最新版本|按照最新|以最新|用最新|根据最新)/,
	// Re-sequencing that invalidates the in-flight step.
	/(先(把|去|做|升级|安装|部署|发布|编译|构建|打包|改|重新))/,
	// English equivalents.
	/\b(instead|start over|scrap (that|it)|discard (that|it)|forget (about )?(the |that |previous )|ignore (the )?(previous|above)|never ?mind|change of plans?|new plan|on second thought|redo|re-?run)\b/i,
];

/**
 * Classify a `/btw` instruction using cheap, deterministic signals.
 *
 * Returns 'unknown' — not 'hint' — when nothing strong matches, so the caller
 * can escalate an ambiguous instruction to the LLM evaluator rather than
 * silently assuming it is additive.
 */
export function classifyBtwIntent(hint: string): BtwIntent {
	const trimmed = (hint || '').trim();
	if (!trimmed) return 'unknown';
	if (CANCEL_COMMANDS.has(trimmed.toLowerCase())) return 'cancel';
	if (BTW_SUPERSEDE_PATTERNS.some(re => re.test(trimmed))) return 'supersede';
	if (ADDITIVE_PREFIXES.some(re => re.test(trimmed))) return 'hint';
	return 'unknown';
}

/** Verdict returned by the (optional) LLM-based conflict evaluator. */
export interface IBtwSupersedeVerdict {
	/** True when the running task/plan must be abandoned for this instruction. */
	readonly supersede: boolean;
	/** Short human-readable justification (shown to the user). */
	readonly reason: string;
}

/**
 * Evaluator that decides whether a mid-task instruction supersedes the work in
 * flight. Injected by the host so tests can stay deterministic; the agent
 * installs an LLM-backed default.
 */
export type BtwConflictEvaluator = (hint: string, runningTask: string) => Promise<IBtwSupersedeVerdict>;

/** A `/btw` instruction queued for delivery at the next loop iteration. */
export interface IPendingBtwHint {
	readonly text: string;
	/** True when this instruction abandons the running task/plan. */
	readonly supersede: boolean;
	/** Why it was treated as a supersede (shown to the user / task log). */
	readonly reason?: string;
}

/** Result of handling one in-flight `/btw` instruction. */
export interface IBtwOutcome {
	readonly kind: 'hint' | 'superseded' | 'cancelled' | 'ignored';
	/** True when an in-flight tool call was aborted as part of this outcome. */
	readonly toolCancelled?: boolean;
	/** Why the instruction superseded the task (present when kind === 'superseded'). */
	readonly reason?: string;
}

const CONFLICT_PROMPT = `You supervise a coding agent. It is currently working on the task below.

--- RUNNING TASK ---
{{TASK}}

The user has just sent this instruction mid-task (via the /btw command):
--- USER INSTRUCTION ---
{{HINT}}

Decide whether the instruction makes the running work OBSOLETE — the agent must
stop the current task/plan and change course (SUPERSEDE) — or whether it is an
additional hint that can be applied while the current task continues (CONTINUE).

Choose SUPERSEDE when the instruction:
- cancels, replaces, or contradicts the current goal
- asks to redo / rerun / rebuild something against the latest state or version
- changes the target files or parameters so work in progress would be wasted
- says the agent is on the wrong path

Choose CONTINUE when the instruction only adds detail, a constraint, a reminder,
or a small additive tweak that does not invalidate work already in progress.

Answer with strict JSON only, no markdown:
{"supersede": true|false, "reason": "<short reason>"}`;

/** Build the evaluator prompt (system prompt carries the agent's own rules). */
export function buildBtwConflictPrompt(hint: string, runningTask: string): IAgentMessage[] {
	return [
		createMessage(MessageRole.User, CONFLICT_PROMPT
			.replace('{{TASK}}', runningTask || '(unknown task)')
			.replace('{{HINT}}', hint)),
	];
}

/**
 * Parse the evaluator's answer. Fail-safe: anything unclear (unparsable JSON,
 * missing field, empty answer) is reported as "do not supersede", because a
 * false supersede destroys work in progress.
 */
export function parseBtwConflictVerdict(text: string): IBtwSupersedeVerdict {
	const raw = (text || '').trim();
	const jsonMatch = raw.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]) as { supersede?: unknown; reason?: unknown; verdict?: unknown };
			const value = typeof parsed.supersede === 'boolean'
				? parsed.supersede
				: typeof parsed.verdict === 'string'
					? /supersede/i.test(parsed.verdict)
					: undefined;
			if (value !== undefined) {
				return {
					supersede: value,
					reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : '',
				};
			}
		} catch {
			// fall through to the keyword scan below
		}
	}
	// Keyword fallback — only an explicit "supersede"/"SUPERSEDE" counts.
	if (/\bsupersede\b/i.test(raw) && !/\bcontinue\b/i.test(raw)) {
		return { supersede: true, reason: 'evaluator answered SUPERSEDE' };
	}
	return { supersede: false, reason: '' };
}

/**
 * Render the message injected into the conversation for one queued hint.
 *
 * A supersede must be unmistakable: the model has to drop the remainder of its
 * plan instead of trying to satisfy both the old and the new goal.
 */
export function renderBtwInjection(hint: IPendingBtwHint): string {
	if (!hint.supersede) {
		return `[User intervention via /btw]: ${hint.text}\n` +
			`(This is a hint from the user to adjust your reasoning. Follow it in subsequent steps.)`;
	}
	const why = hint.reason ? ` (reason: ${hint.reason})` : '';
	return `[User intervention via /btw — THIS INSTRUCTION SUPERSEDES THE CURRENT TASK]${why}\n` +
		`${hint.text}\n` +
		`The previous task and its plan are CANCELLED. Do NOT continue the old plan and do not finish ` +
		`work that this instruction makes irrelevant (abandon any long-running command or waiting step ` +
		`that belonged to it). Treat the instruction above as the new task and start from the latest state.`;
}
