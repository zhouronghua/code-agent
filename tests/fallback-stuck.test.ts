/*---------------------------------------------------------------------------------------------
 *  Unit tests: the 保底 (fallback) model must not leave the agent STUCK
 *
 *  The reported symptom: "有几次会话在模型切换成保底模型之后，就卡住了".
 *
 *  Root cause found in `AgentLoop`: `_llmRequestInFlight` is set to true before the
 *  request loop and cleared only on the SUCCESS path. When the request throws (the
 *  fallback model itself 400s, the network dies, the task is cancelled), the flag
 *  stays true forever. The recovery probe then takes the "a request is in flight,
 *  defer the switch-back to the next loop iteration" branch — but if the run has
 *  already ended there IS no next iteration, so the agent never returns to the
 *  primary model and the session looks frozen on the 保底 model.
 *
 *  These tests pin the invariant: after a run finishes — successfully or not — the
 *  in-flight flag is false, so a probe that finds the primary healthy switches back
 *  immediately instead of deferring to a step that will never come.
 *
 *  Run:
 *    npx esbuild tests/fallback-stuck.test.ts --bundle --platform=node \
 *      --target=node18 --format=esm --outfile=/tmp/stuck.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/stuck.mjs
 *--------------------------------------------------------------------------------------------*/

import {
	IAgentConfig,
	IAgentMessage,
	MessageRole,
	createMessage,
} from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider, IHealthCheckOptions } from 'vs/workbench/services/agent/browser/llmProvider';
import { AgentLoop } from 'vs/workbench/contrib/agent/common/agent';
import { AgentModeManager } from 'vs/workbench/contrib/agent/common/agentModes';
import { AgentCheckpointManager } from 'vs/workbench/contrib/agent/common/agentCheckpoint';
import { ToolRegistry } from 'vs/workbench/contrib/agent/common/agentTools';

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

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function makeConfig(model: string, overrides: Partial<IAgentConfig> = {}): IAgentConfig {
	return {
		provider: 'openai',
		model,
		apiKey: 'test',
		maxSteps: 4,
		maxContextTokens: 200_000,
		maxOutputTokens: 8_000,
		temperature: 0,
		...overrides,
	} as IAgentConfig;
}

type Behavior =
	| { kind: 'ok'; text?: string }
	| { kind: 'timeout' }
	| { kind: 'fatal'; message: string };

/** A provider whose `complete()` follows a script, and whose probe is scriptable. */
class ScriptedProvider implements ILLMProvider {
	readonly name = 'scripted';
	calls = 0;
	healthChecks = 0;
	lastHealthCheckOpts: IHealthCheckOptions | undefined;

	constructor(
		private readonly _behaviors: Behavior[],
		public healthy = true,
	) { }

	private _next(): Behavior {
		this.calls++;
		if (this._behaviors.length > 1) return this._behaviors.shift()!;
		return this._behaviors[0];
	}

	async complete(): Promise<IAgentMessage> {
		const behavior = this._next();
		if (behavior.kind === 'timeout') {
			const err = new Error('request timed out') as Error & { code?: string };
			err.code = 'ETIMEDOUT';
			throw err;
		}
		if (behavior.kind === 'fatal') {
			throw new Error(behavior.message);
		}
		return createMessage(MessageRole.Assistant, behavior.text ?? 'done');
	}

	async *stream(): AsyncIterableIterator<string> {
		yield 'x';
	}

	countTokens(text: string): number {
		return Math.ceil((text || '').length / 4);
	}

	supportsStreaming(): boolean {
		return false;
	}

	supportsReasoning(): boolean {
		return false;
	}

	async healthCheck(_timeoutMs?: number, opts?: IHealthCheckOptions): Promise<boolean> {
		this.healthChecks++;
		this.lastHealthCheckOpts = opts;
		return this.healthy;
	}
}

function makeAgent(config: IAgentConfig, provider: ILLMProvider): AgentLoop {
	const agent = new AgentLoop(
		config,
		provider,
		new ToolRegistry(),
		new AgentModeManager(),
		new AgentCheckpointManager({} as never),
		'/tmp',
	);
	// Silence the default console renderer; assertions use the event stream.
	agent.setModelSwitchLogger(() => { /* quiet */ });
	return agent;
}

// ---------------------------------------------------------------------------
// 1. The reported hang: a FAILED request must not leave the flag stuck
// ---------------------------------------------------------------------------
console.log('\n[stuck] a failed request does not freeze the fallback state');

{
	const primary = new ScriptedProvider([{ kind: 'timeout' }], true);
	// The 保底 model fails on its very first request (the real gpt-5.6-luna case:
	// an over-cap max_tokens 400 that the old code could not repair).
	const fallback = new ScriptedProvider([
		{ kind: 'fatal', message: 'OpenAI API error 400: max_tokens is too large' },
	]);

	const agent = makeAgent(makeConfig('deepseek-flash'), primary);
	agent.setFallback(makeConfig('gpt-5.6-luna'), fallback);
	agent.setProbeSchedule(60, 120);

	await agent.run('do the thing');

	eq(agent.activeModel, 'gpt-5.6-luna', 'the agent did fall back');
	ok(agent.lastTaskError !== undefined, 'the task failed (the 保底 model could not answer)');

	// The primary is healthy again. A probe must be able to switch back NOW.
	primary.healthy = true;
	await sleep(400);

	ok(primary.healthChecks >= 1, 'the recovery probe ran after the failed run');
	eq(agent.activeModel, 'deepseek-flash',
		'the agent returned to the primary instead of staying stuck on the 保底 model');
	ok(!agent.usingFallback, 'the fallback flag is cleared');
	agent.dispose();
}

// ---------------------------------------------------------------------------
// 2. A successful run must also leave the flag clear
// ---------------------------------------------------------------------------
console.log('\n[stuck] a successful run leaves the flag clear');

{
	const primary = new ScriptedProvider([{ kind: 'timeout' }], true);
	const fallback = new ScriptedProvider([{ kind: 'ok', text: 'answered by 保底' }]);

	const agent = makeAgent(makeConfig('deepseek-flash'), primary);
	agent.setFallback(makeConfig('gpt-5.6-luna'), fallback);
	agent.setProbeSchedule(60, 120);

	await agent.run('do the thing');
	eq(agent.activeModel, 'gpt-5.6-luna', 'the 保底 model answered');
	eq(agent.lastTaskError, undefined, 'the task succeeded');

	await sleep(400);
	ok(primary.healthChecks >= 1, 'the probe ran');
	eq(agent.activeModel, 'deepseek-flash', 'the primary is re-adopted after a successful run too');
	agent.dispose();
}

// ---------------------------------------------------------------------------
// 3. A cancelled run must not leave the flag stuck either
// ---------------------------------------------------------------------------
console.log('\n[stuck] a cancelled run leaves the flag clear');

{
	const primary = new ScriptedProvider([{ kind: 'timeout' }], true);
	// The 保底 model hangs, so the run is cancelled while a request is in flight.
	const fallback = new ScriptedProvider([{ kind: 'ok' }]);
	const originalComplete = fallback.complete.bind(fallback);
	fallback.complete = async () => {
		await sleep(5_000);
		return originalComplete();
	};

	const agent = makeAgent(makeConfig('deepseek-flash'), primary);
	agent.setFallback(makeConfig('gpt-5.6-luna'), fallback);
	agent.setProbeSchedule(60, 120);

	const run = agent.run('do the thing');
	await sleep(150);
	agent.cancel();
	await run;

	primary.healthy = true;
	await sleep(400);
	ok(primary.healthChecks >= 1, 'the probe ran after the cancelled run');
	eq(agent.activeModel, 'deepseek-flash',
		'a cancelled run does not leave the agent stuck on the 保底 model');
	agent.dispose();
}

// ---------------------------------------------------------------------------
// 4. The probe must not switch back while a request really IS in flight
// ---------------------------------------------------------------------------
console.log('\n[stuck] an in-flight request still defers the switch-back');

{
	// This is the behaviour the flag exists for: swapping the provider mid-request
	// would mislabel the response's provenance. It must keep working.
	const primary = new ScriptedProvider([{ kind: 'timeout' }], true);
	let release: (() => void) | undefined;
	const fallback = new ScriptedProvider([{ kind: 'ok', text: 'slow answer' }]);
	const originalComplete = fallback.complete.bind(fallback);
	// Gate only the FIRST fallback request; later calls must pass through, otherwise
	// the retry the loop makes after the run resumes would block forever.
	let gated = false;
	fallback.complete = async () => {
		if (!gated) {
			gated = true;
			await new Promise<void>(resolve => { release = resolve; });
		}
		return originalComplete();
	};

	const agent = makeAgent(makeConfig('deepseek-flash'), primary);
	agent.setFallback(makeConfig('gpt-5.6-luna'), fallback);
	agent.setProbeSchedule(60, 120);

	const run = agent.run('do the thing');
	// Wait until the fallback request is actually in flight.
	for (let i = 0; i < 100 && release === undefined; i++) await sleep(20);
	ok(release !== undefined, 'the 保底 request is in flight');

	// The primary recovers while that request is still pending.
	primary.healthy = true;
	await sleep(400);
	eq(agent.activeModel, 'gpt-5.6-luna',
		'the switch-back is deferred while a request is genuinely in flight');

	release!();
	await Promise.race([run, sleep(3_000)]);
	// Once the run ends the deferred switch must happen (not be lost).
	await sleep(400);
	eq(agent.activeModel, 'deepseek-flash',
		'the deferred switch-back is not lost when the run ends');
	agent.dispose();
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);