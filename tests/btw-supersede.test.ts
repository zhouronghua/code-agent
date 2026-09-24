/*---------------------------------------------------------------------------------------------
 *  Unit tests: /btw mid-task intervention
 *
 *  A `/btw` sent while the agent is working is either an additive hint (keep the
 *  plan) or a supersede (abandon the running task/plan and pivot). A supersede
 *  must abort the in-flight tool call immediately — otherwise the user's redirect
 *  is only read after a long build/poll finally returns.
 *
 *  Run:
 *    npx esbuild tests/btw-supersede.test.ts --bundle --platform=node --target=node18 \
 *      --format=esm --outfile=/tmp/btw-supersede.test.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/btw-supersede.test.mjs
 *--------------------------------------------------------------------------------------------*/

import {
	createMessage,
	MessageRole,
	IAgentConfig,
	IAgentMessage,
	IToolResult,
} from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider } from 'vs/workbench/services/agent/browser/llmProvider';
import { AgentLoop } from 'vs/workbench/contrib/agent/common/agent';
import { AgentModeManager } from 'vs/workbench/contrib/agent/common/agentModes';
import { AgentCheckpointManager } from 'vs/workbench/contrib/agent/common/agentCheckpoint';
import { AgentTool, ToolRegistry } from 'vs/workbench/contrib/agent/common/agentTools';
import {
	classifyBtwIntent,
	parseBtwConflictVerdict,
	BTW_SUPERSEDE_PATTERNS,
} from 'vs/workbench/contrib/agent/common/agentBtw';

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
// helpers
// ---------------------------------------------------------------------------

function makeConfig(over: Partial<IAgentConfig> = {}): IAgentConfig {
	return {
		provider: 'openai',
		model: 'test-model',
		apiKey: 'test-key',
		apiBase: 'http://127.0.0.1:9/v1',
		maxSteps: 10,
		maxContextTokens: 200_000,
		maxOutputTokens: 8_000,
		temperature: 0,
		stepTimeout: 5_000,
		taskTimeout: 60_000,
		...over,
	};
}

/**
 * First LLM call asks for the given tool calls; every later call answers "done".
 */
class ToolThenDoneProvider implements ILLMProvider {
	readonly name = 'fake-tool-then-done';
	calls = 0;
	requests: IAgentMessage[][] = [];

	constructor(private readonly _toolCalls: Array<{ id: string; name: string }>) { }

	async complete(messages: IAgentMessage[]): Promise<IAgentMessage> {
		this.requests.push(messages);
		this.calls++;
		if (this.calls === 1) {
			return createMessage(MessageRole.Assistant, 'working on it', {
				toolCalls: this._toolCalls.map(tc => ({ id: tc.id, name: tc.name, arguments: {} })),
			});
		}
		return createMessage(MessageRole.Assistant, 'done');
	}

	async *stream(): AsyncIterableIterator<string> {
		yield '';
	}

	countTokens(text: string): number {
		return Math.ceil((text || '').length / 4);
	}

	supportsStreaming(): boolean {
		return false;
	}
}

/** A tool that blocks until aborted (or 300ms, whichever comes first). */
class SlowTool extends AgentTool {
	readonly name = 'slow_tool';
	readonly description = 'blocks, like a long build or a poll';
	readonly parameters = { type: 'object', properties: {}, required: [] as string[] };

	started = 0;
	aborted = 0;
	completed = 0;
	private _resolveStart!: () => void;
	readonly startedPromise: Promise<void>;

	constructor() {
		super();
		this.startedPromise = new Promise<void>(resolve => { this._resolveStart = resolve; });
	}

	async execute(_args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		this.started++;
		this._resolveStart();
		return new Promise<IToolResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.completed++;
				resolve({ toolCallId: '', success: true, output: 'slow done' });
			}, 300);
			if (signal) {
				const onAbort = () => {
					clearTimeout(timer);
					this.aborted++;
					reject(new DOMException('Aborted', 'AbortError'));
				};
				if (signal.aborted) { onAbort(); return; }
				signal.addEventListener('abort', onAbort, { once: true });
			}
		});
	}
}

/** A tool that returns immediately and counts how often it ran. */
class InstantTool extends AgentTool {
	readonly name: string;
	readonly description = 'returns immediately';
	readonly parameters = { type: 'object', properties: {}, required: [] as string[] };
	executions = 0;

	constructor(name: string) {
		super();
		this.name = name;
	}

	async execute(): Promise<IToolResult> {
		this.executions++;
		return { toolCallId: '', success: true, output: 'ok' };
	}
}

function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const start = Date.now();
	return new Promise<void>((resolve, reject) => {
		const tick = () => {
			if (predicate()) return resolve();
			if (Date.now() - start > timeoutMs) return reject(new Error('waitUntil timed out'));
			setTimeout(tick, 5);
		};
		tick();
	});
}

interface Harness {
	agent: AgentLoop;
	provider: ToolThenDoneProvider;
	slow: SlowTool;
	second: InstantTool;
}

function makeHarness(): Harness {
	const provider = new ToolThenDoneProvider([
		{ id: 'c1', name: 'slow_tool' },
		{ id: 'c2', name: 'second_tool' },
	]);
	const registry = new ToolRegistry();
	const slow = new SlowTool();
	const second = new InstantTool('second_tool');
	registry.register(slow);
	registry.register(second);
	const agent = new AgentLoop(
		makeConfig(),
		provider,
		registry,
		new AgentModeManager(),
		new AgentCheckpointManager({} as never),
		'/tmp',
	);
	return { agent, provider, slow, second };
}

// ---------------------------------------------------------------------------
// 1. deterministic classification
// ---------------------------------------------------------------------------

function testClassification(): void {
	console.log('\n[1] /btw intent classification');

	// Explicit stop commands (whole-instruction match only).
	for (const cmd of ['cancel', 'abort', 'stop', '取消', '停止']) {
		eq(classifyBtwIntent(cmd), 'cancel', `"${cmd}" is a cancel command`);
		eq(classifyBtwIntent(cmd.toUpperCase()), 'cancel', `"${cmd.toUpperCase()}" is case-insensitive`);
	}

	// Unambiguous redirects → supersede.
	const supersedes = [
		'取消刚才的任务，改为先升级版本号并重新构建',
		'改成基于最新版本重新执行',
		'算了，不要做了',
		'重新跑一遍 daily',
		'先升级版本号再安装',
		'scrap that, start over',
		'instead use the other API',
		'never mind, forget the previous plan',
	];
	for (const s of supersedes) {
		eq(classifyBtwIntent(s), 'supersede', `"${s}" supersedes`);
	}

	// Additive hints → keep the plan.
	const hints = ['注意记得用中文回复', '记得补充单元测试', '另外把日志级别调成 debug', 'note: keep the diff small'];
	for (const h of hints) {
		eq(classifyBtwIntent(h), 'hint', `"${h}" is a hint`);
	}

	// No strong signal → the evaluator decides.
	const unknown = ['这个文件的路径是 /tmp/x.c', 'the tests are in tests/', '当前用的是什么模型'];
	for (const u of unknown) {
		eq(classifyBtwIntent(u), 'unknown', `"${u}" needs evaluation`);
	}

	eq(classifyBtwIntent('   '), 'unknown', 'blank input is not classified');
	ok(BTW_SUPERSEDE_PATTERNS.length > 0, 'the supersede patterns are exported for inspection');
}

// ---------------------------------------------------------------------------
// 2. evaluator verdict parsing (fail-safe)
// ---------------------------------------------------------------------------

function testVerdictParsing(): void {
	console.log('\n[2] evaluator verdict parsing fails safe');

	eq(parseBtwConflictVerdict('{"supersede": true, "reason": "goal replaced"}').supersede, true, 'explicit true');
	eq(parseBtwConflictVerdict('{"supersede": true, "reason": "goal replaced"}').reason, 'goal replaced', 'reason is preserved');
	eq(parseBtwConflictVerdict('{"supersede": false, "reason": "additive"}').supersede, false, 'explicit false');
	eq(parseBtwConflictVerdict('{"verdict": "SUPERSEDE"}').supersede, true, 'a verdict enum is accepted');
	eq(parseBtwConflictVerdict('{"verdict": "CONTINUE"}').supersede, false, 'CONTINUE is not a supersede');
	eq(parseBtwConflictVerdict('SUPERSEDE').supersede, true, 'a bare SUPERSEDE keyword is accepted');
	eq(parseBtwConflictVerdict('I think you should continue').supersede, false, 'unparsable prose does not supersede');
	eq(parseBtwConflictVerdict('').supersede, false, 'an empty answer does not supersede');
	eq(parseBtwConflictVerdict('{"supersede": true} ').supersede, true, 'trailing whitespace is tolerated');
}

// ---------------------------------------------------------------------------
// 3. supersede aborts the in-flight tool and pivots
// ---------------------------------------------------------------------------

async function testSupersedeAbortsTool(): Promise<void> {
	console.log('\n[3] a superseding /btw aborts the running tool and pivots');

	const { agent, provider, slow, second } = makeHarness();
	agent.setBtwConflictEvaluator(null); // deterministic: keyword classification only

	const runPromise = agent.run('run the long build');
	await slow.startedPromise;

	const instruction = '取消当前任务，改为先升级版本号并重新构建';
	const outcome = await agent.injectBtwHint(instruction);
	eq(outcome.kind, 'superseded', 'the instruction is treated as a supersede');
	eq(outcome.toolCancelled, true, 'the in-flight tool was cancelled');
	ok(slow.aborted === 1, 'the slow tool observed the abort');
	ok(slow.completed === 0, 'the slow tool never completed normally');

	await runPromise;

	eq(second.executions, 0, 'a tool call from the abandoned step is skipped');
	eq(agent.context.taskAnchorContent, instruction, 'the new instruction becomes the pinned task');
	ok(
		agent.context.messages.some(m => m.role === MessageRole.User && m.content.includes('SUPERSEDES THE CURRENT TASK')),
		'a supersede marker is injected into the conversation',
	);
	ok(
		provider.requests.some(req => req.some(m => m.content.includes('升级版本号'))),
		'the new instruction reaches the model',
	);
	ok(
		agent.context.messages.some(m => m.role === MessageRole.Tool && m.content.includes('[skipped]')),
		'the skipped tool call is still answered with a tool result',
	);

	const log = agent.exportTaskLog('completed');
	ok(
		(log.issueSignals ?? []).some(s => s.kind === 'task-superseded'),
		'the supersede is recorded as a task-log signal',
	);

	agent.dispose();
}

// ---------------------------------------------------------------------------
// 4. an additive hint must NOT abort anything
// ---------------------------------------------------------------------------

async function testHintDoesNotAbort(): Promise<void> {
	console.log('\n[4] an additive /btw keeps the running plan');

	const { agent, slow } = makeHarness();
	agent.setBtwConflictEvaluator(null);

	const runPromise = agent.run('run the long build');
	await slow.startedPromise;

	const outcome = await agent.injectBtwHint('注意记得用中文写注释');
	eq(outcome.kind, 'hint', 'the instruction stays an additive hint');
	eq(outcome.toolCancelled, undefined, 'no tool was cancelled');
	eq(slow.aborted, 0, 'the running tool was left alone');

	await runPromise;
	eq(slow.completed, 1, 'the tool finished normally');
	eq(agent.context.taskAnchorContent, 'run the long build', 'the pinned task is unchanged');

	agent.dispose();
}

// ---------------------------------------------------------------------------
// 5. ambiguous instruction → evaluator decides
// ---------------------------------------------------------------------------

async function testEvaluatorDecides(): Promise<void> {
	console.log('\n[5] an ambiguous /btw is resolved by the evaluator');

	// 5a. evaluator says supersede
	{
		const { agent, slow } = makeHarness();
		let seenHint = '';
		let seenTask = '';
		agent.setBtwConflictEvaluator(async (hint, runningTask) => {
			seenHint = hint;
			seenTask = runningTask;
			return { supersede: true, reason: 'goal replaced' };
		});

		const runPromise = agent.run('run the long build');
		await slow.startedPromise;

		const outcome = await agent.injectBtwHint('这个文件的路径是 /tmp/x.c');
		eq(outcome.kind, 'superseded', 'the evaluator can supersede an ambiguous instruction');
		eq(outcome.toolCancelled, true, 'the evaluator-driven supersede aborts the tool');
		eq(seenHint, '这个文件的路径是 /tmp/x.c', 'the evaluator receives the raw instruction');
		ok(seenTask.includes('run the long build'), 'the evaluator receives the running task context');

		await runPromise;
		agent.dispose();
	}

	// 5b. evaluator says continue
	{
		const { agent, slow } = makeHarness();
		agent.setBtwConflictEvaluator(async () => ({ supersede: false, reason: 'additive' }));

		const runPromise = agent.run('run the long build');
		await slow.startedPromise;

		const outcome = await agent.injectBtwHint('这个文件的路径是 /tmp/x.c');
		eq(outcome.kind, 'hint', 'a "continue" verdict keeps the plan');
		eq(slow.aborted, 0, 'the tool keeps running on a "continue" verdict');

		await runPromise;
		agent.dispose();
	}

	// 5c. evaluator throws → fail open, never a destructive supersede
	{
		const { agent, slow } = makeHarness();
		agent.setBtwConflictEvaluator(async () => { throw new Error('evaluator down'); });

		const runPromise = agent.run('run the long build');
		await slow.startedPromise;

		const outcome = await agent.injectBtwHint('这个文件的路径是 /tmp/x.c');
		eq(outcome.kind, 'hint', 'an evaluator outage fails open to a hint');
		eq(slow.aborted, 0, 'an evaluator outage never aborts running work');

		await runPromise;
		agent.dispose();
	}
}

// ---------------------------------------------------------------------------
// 6. an explicit cancel with no tool running still pivots
// ---------------------------------------------------------------------------

async function testCancelWithoutTool(): Promise<void> {
	console.log('\n[6] /btw cancel with no tool running still redirects the loop');

	const provider = new ToolThenDoneProvider([]);
	const agent = new AgentLoop(
		makeConfig(),
		provider,
		new ToolRegistry(),
		new AgentModeManager(),
		new AgentCheckpointManager({} as never),
		'/tmp',
	);
	agent.setBtwConflictEvaluator(null);

	// With no tool call at all, the first loop iteration finishes immediately;
	// the cancel therefore takes the "no tool running" branch.
	const runPromise = agent.run('answer a quick question');
	await waitUntil(() => provider.calls >= 1);
	const outcome = await agent.injectBtwHint('cancel');
	ok(
		outcome.kind === 'superseded' || outcome.kind === 'cancelled',
		'cancel is honoured even with no tool in flight',
	);

	await runPromise;
	agent.dispose();
}

// ---------------------------------------------------------------------------
// 7. /btw state must not leak into the next task
// ---------------------------------------------------------------------------

async function testStaleHintDoesNotLeak(): Promise<void> {
	console.log('\n[7] a /btw issued while idle does not supersede the next task');

	const provider = new ToolThenDoneProvider([]);
	const agent = new AgentLoop(
		makeConfig(),
		provider,
		new ToolRegistry(),
		new AgentModeManager(),
		new AgentCheckpointManager({} as never),
		'/tmp',
	);
	agent.setBtwConflictEvaluator(null);

	// Agent is idle: the hint is queued but there is no loop to deliver it to.
	const outcome = await agent.injectBtwHint('取消当前任务，改为重新构建');
	eq(outcome.kind, 'superseded', 'the idle instruction is classified as a supersede');

	await agent.run('write a unit test');
	eq(agent.context.taskAnchorContent, 'write a unit test', 'the new task keeps its own anchor');
	ok(
		!agent.context.messages.some(m => m.content.includes('SUPERSEDES THE CURRENT TASK')),
		'no stale supersede marker is injected into the new task',
	);

	agent.dispose();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log('btw-supersede (mid-task intervention) tests');

	testClassification();
	testVerdictParsing();
	await testSupersedeAbortsTool();
	await testHintDoesNotAbort();
	await testEvaluatorDecides();
	await testCancelWithoutTool();
	await testStaleHintDoesNotLeak();

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
