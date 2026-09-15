/*---------------------------------------------------------------------------------------------
 *  Unit tests: model switching (保底模型), switch reporting, recovery probing,
 *  and the context hygiene that keeps a switched conversation coherent.
 *
 *  Run:
 *    npx esbuild tests/model-switch.test.ts --bundle --platform=node --target=node18 \
 *      --format=esm --outfile=/tmp/model-switch.test.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/model-switch.test.mjs
 *--------------------------------------------------------------------------------------------*/

import {
	AgentLoop,
	isDegenerateReasoning,
	countRepeatedReasoningLines,
	formatModelSwitch,
	formatReasoningForLog,
} from 'vs/workbench/contrib/agent/common/agent';
import { AgentContext } from 'vs/workbench/contrib/agent/common/agentContext';
import { AgentModeManager } from 'vs/workbench/contrib/agent/common/agentModes';
import { AgentCheckpointManager } from 'vs/workbench/contrib/agent/common/agentCheckpoint';
import { ToolRegistry } from 'vs/workbench/contrib/agent/common/agentTools';
import { ModelRouter } from 'vs/workbench/contrib/agent/common/agentModelRouter';
import {
	createMessage,
	MessageRole,
	IAgentConfig,
	IAgentMessage,
	IModelSwitchEvent,
	IToolSchema,
} from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider } from 'vs/workbench/services/agent/browser/llmProvider';
import { OpenAIProvider } from 'vs/workbench/services/agent/browser/llmOpenai';

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function makeConfig(model: string, over: Partial<IAgentConfig> = {}): IAgentConfig {
	return {
		provider: 'openai',
		model,
		apiKey: 'test-key',
		apiBase: 'http://127.0.0.1:9/v1',
		maxSteps: 20,
		maxContextTokens: 1_000_000,
		maxOutputTokens: 100_000,
		temperature: 0,
		stepTimeout: 5_000,
		taskTimeout: 60_000,
		...over,
	};
}

type Behavior = { kind: 'ok'; text?: string; reasoning?: string } | { kind: 'timeout' } | { kind: 'loop' };

/** The observed hy3 failure: a 98k-char reasoning block stuck on one line. */
function degenerateReasoning(): string {
	return Array.from({ length: 1500 }, (_, i) =>
		i % 2 === 0 ? 'Hmm — let me find lit.' : 'Let me do it.').join('\n');
}

class FakeProvider implements ILLMProvider {
	readonly name = 'fake';
	healthChecks = 0;
	calls = 0;
	private readonly _queue: Behavior[];
	constructor(behaviors: Behavior[], public healthy = true, public thinks = false) {
		// The last behavior repeats once the queue is exhausted.
		this._queue = behaviors.length > 0 ? [...behaviors] : [{ kind: 'ok' }];
	}

	private _next(): Behavior {
		this.calls++;
		if (this._queue.length > 1) return this._queue.shift()!;
		return this._queue[0];
	}

	async complete(): Promise<IAgentMessage> {
		const behavior = this._next();
		if (behavior.kind === 'timeout') {
			const err = new Error('request timed out') as Error & { code?: string };
			err.code = 'ETIMEDOUT';
			throw err;
		}
		if (behavior.kind === 'loop') {
			// Empty answer + no tool calls + runaway thinking.
			return createMessage(MessageRole.Assistant, '', { reasoningContent: degenerateReasoning() });
		}
		return createMessage(MessageRole.Assistant, behavior.text ?? 'done', {
			reasoningContent: behavior.reasoning,
		});
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
		return this.thinks;
	}

	async healthCheck(): Promise<boolean> {
		this.healthChecks++;
		return this.healthy;
	}
}

function makeAgent(config: IAgentConfig, provider: ILLMProvider): AgentLoop {
	const registry = new ToolRegistry();
	const modeManager = new AgentModeManager();
	const checkpoint = new AgentCheckpointManager({} as never);
	const agent = new AgentLoop(config, provider, registry, modeManager, checkpoint, '/tmp');
	// Silence the default console renderer; tests assert on the event stream.
	agent.setModelSwitchLogger(() => { /* handled via onDidSwitchModel */ });
	return agent;
}

async function testDegenerateReasoningDetection(): Promise<void> {
	console.log('\n[1] degenerate reasoning loop detection');

	// Reproduces the observed hy3 failure: 98k chars, one plan line on repeat.
	const loopLine = 'Let me do it.';
	const looping = Array.from({ length: 1600 }, (_, i) =>
		i % 2 === 0 ? 'Hmm — let me find lit.' : loopLine).join('\n');
	ok(looping.length > 20_000, `synthetic loop block is large (${looping.length} chars)`);
	ok(countRepeatedReasoningLines(looping) >= 800, 'repeated-line counter finds the loop line');
	ok(isDegenerateReasoning(looping), 'a 1600x repeated reasoning line is flagged as a loop');

	const normal = `I will inspect the IR first.\n${Array.from({ length: 60 }, (_, i) => `Step ${i}: read file ${i} and compare the layout.`).join('\n')}`;
	ok(!isDegenerateReasoning(normal), 'a normal multi-step plan is NOT flagged');

	ok(!isDegenerateReasoning('Let me do it.\nLet me do it.\nLet me do it.'),
		'a short block with repeats is NOT flagged');
	ok(!isDegenerateReasoning(''), 'empty reasoning is NOT flagged');
}

function testReportFormatting(): void {
	console.log('\n[2] model switch reporting');

	const toFallback: IModelSwitchEvent = {
		from: 'deepseek-flash', to: 'gpt-5.6-luna', reason: 'fallback-timeout',
		toFallback: true, detail: 'timeout: request timed out',
	};
	const line = formatModelSwitch(toFallback);
	ok(line.includes('deepseek-flash') && line.includes('gpt-5.6-luna'), 'timeout line names both models');
	ok(line.includes('保底模型'), 'timeout line says which model is the 保底 model');

	const back: IModelSwitchEvent = {
		from: 'gpt-5.6-luna', to: 'deepseek-flash', reason: 'primary-recovered', toFallback: false,
	};
	const backLine = formatModelSwitch(back);
	ok(backLine.includes('switched back'), 'recovery line says it switched back');
	ok(backLine.startsWith('[MODEL]'), 'every switch line is prefixed with [MODEL]');

	const routed = formatModelSwitch({
		from: 'a', to: 'b', reason: 'routing', toFallback: false,
	});
	ok(routed.includes('routed'), 'routing switches are announced too');

	// Reasoning dump bounding — the "pile of filler" must not reach the console raw.
	const huge = Array.from({ length: 5000 }, () => 'Let me do it.').join('\n');
	const shown = formatReasoningForLog(huge);
	ok(shown.length < 4200, `logged reasoning is bounded (${shown.length} chars of ${huge.length})`);
	ok(shown.includes('reasoning elided'), 'the elided amount is disclosed');
	eq(formatReasoningForLog('short thinking'), 'short thinking', 'short reasoning is logged verbatim');
}

async function testContextHygieneOnSwitch(): Promise<void> {
	console.log('\n[3] context hygiene across a model switch');

	const big = makeConfig('wide-model', { maxContextTokens: 1_000_000, maxOutputTokens: 100_000 });
	const narrow = makeConfig('narrow-model', { maxContextTokens: 10_000, maxOutputTokens: 2_000 });
	const wide = new FakeProvider([{ kind: 'ok' }]);
	const agent = makeAgent(big, wide);

	// History that carries the previous model's chain-of-thought, plus enough real
	// content that it cannot fit the narrower model's window.
	agent.context.setSystemPrompt('system');
	agent.context.addMessage(createMessage(MessageRole.User, 'do the thing'));
	agent.context.addMessage(createMessage(MessageRole.User, 'x'.repeat(60_000)));
	agent.context.addMessage(createMessage(MessageRole.Assistant, 'working on it', {
		reasoningContent: 'the previous model plan. '.repeat(80),
	}));

	eq(agent.context.inputBudget, 900_000, 'primary model input budget');
	ok(!agent.context.isOverBudget, 'history fits the primary model window');

	const events: IModelSwitchEvent[] = [];
	agent.onDidSwitchModel(e => events.push(e));
	agent.swapProvider(narrow, new FakeProvider([{ kind: 'ok' }]), 'profile');

	eq(agent.context.inputBudget, 8_000, 'input budget follows the new (smaller) model');
	ok(agent.context.isOverBudget, 'history is detected as over the new model window');

	const assistant = agent.context.messages.find(m => m.role === MessageRole.Assistant)!;
	eq(assistant.reasoningContent, undefined, 'reasoning_content is dropped when switching to a non-thinking model');
	eq(assistant.content, 'working on it', 'assistant content is preserved on switch');
	agent.context.addMessage(createMessage(MessageRole.Tool, 'result', { toolCallId: 'c1' }));
	eq(
		agent.context.messages.filter(m => m.role === MessageRole.Tool).length,
		1,
		'tool result messages survive the switch (no orphans introduced)',
	);

	eq(events.length, 1, 'a model switch is reported once');
	eq(events[0].reason, 'profile', 'the switch reason is carried');
	eq(events[0].from, 'wide-model', 'switch reports the previous model');
	eq(events[0].to, 'narrow-model', 'switch reports the new model');

	// Thinking → thinking switch: the provider already normalizes missing
	// reasoning_content, so the history is left intact (no new failure mode).
	const agent2 = makeAgent(big, new FakeProvider([{ kind: 'ok' }], true, true));
	agent2.context.addMessage(createMessage(MessageRole.Assistant, 'thought', { reasoningContent: 'keep me' }));
	agent2.swapProvider(narrow, new FakeProvider([{ kind: 'ok' }], true, true), 'routing');
	eq(
		agent2.context.messages.find(m => m.role === MessageRole.Assistant)!.reasoningContent,
		'keep me',
		'reasoning_content survives a switch between two thinking models',
	);
	agent2.dispose();

	// Same model → no spurious "switch" notification.
	agent.swapProvider(narrow, new FakeProvider([{ kind: 'ok' }]), 'routing');
	eq(events.length, 1, 'swapping to the same model reports nothing');
	agent.dispose();
}

async function testFallbackAndRecoveryProbe(): Promise<void> {
	console.log('\n[4] 保底 fallback + background recovery probe');

	// --- 4a: primary stays down → the agent keeps running on the 保底 model ---
	const primaryCfg = makeConfig('primary-model');
	const fallbackCfg = makeConfig('gpt-5.6-luna', { maxContextTokens: 256_000, maxOutputTokens: 32_768 });
	const downPrimary = new FakeProvider([{ kind: 'timeout' }], false);

	const agent = makeAgent(primaryCfg, downPrimary);
	agent.setFallback(fallbackCfg, new FakeProvider([{ kind: 'ok', text: 'answered by 保底' }]));
	agent.setProbeSchedule(60, 120);

	const events: IModelSwitchEvent[] = [];
	agent.onDidSwitchModel(e => events.push(e));

	await agent.run('please answer');
	eq(agent.activeModel, 'gpt-5.6-luna', 'request is retried on the 保底 model');
	ok(agent.usingFallback, 'agent reports it is running on the 保底 model');
	eq(events.length, 1, 'one fallback switch reported');
	eq(events[0].reason, 'fallback-timeout', 'switch reason is the timeout');
	ok(events[0].detail!.includes('timed out'), 'the timeout reason is surfaced');
	eq(agent.lastTaskError, undefined, 'the task itself still succeeds');

	await sleep(300);
	ok(downPrimary.healthChecks >= 1, `background probe ran while on the 保底 model (${downPrimary.healthChecks} checks)`);
	eq(agent.activeModel, 'gpt-5.6-luna', 'unreachable primary → stay on the 保底 model');
	eq(events.length, 1, 'no recovery switch while the primary is down');
	agent.dispose();

	// --- 4b: primary recovers → switch back automatically, without a new task ---
	const recovered = new FakeProvider([{ kind: 'ok', text: 'primary is back' }]);
	const agent2 = makeAgent(primaryCfg, new FakeProvider([{ kind: 'timeout' }], false));
	agent2.setFallback(fallbackCfg, new FakeProvider([{ kind: 'ok' }]));
	agent2.setProbeSchedule(60, 120);
	const events2: IModelSwitchEvent[] = [];
	agent2.onDidSwitchModel(e => events2.push(e));

	await agent2.run('please answer');
	eq(agent2.activeModel, 'gpt-5.6-luna', 'started on the 保底 model');

	// Primary becomes reachable — swap the provider the probe will call.
	(agent2 as unknown as { _primaryProvider: ILLMProvider })._primaryProvider = recovered;
	await sleep(400);

	eq(agent2.activeModel, 'primary-model', 'primary model is re-adopted as soon as it recovers');
	ok(!agent2.usingFallback, 'fallback flag cleared after recovery');
	ok(recovered.healthChecks >= 1, 'recovery was confirmed by a health probe');
	const recovery = events2.find(e => e.reason === 'primary-recovered');
	ok(!!recovery, 'recovery is reported as a model switch');
	eq(recovery?.to, 'primary-model', 'recovery reports the model it returned to');
	agent2.dispose();
}

async function testFallbackConfigResolution(): Promise<void> {
	console.log('\n[5] 保底 model resolution from routing config');

	const profiles: Record<string, IAgentConfig> = {
		'deepseek-flash': makeConfig('deepseek-flash'),
		'deepseek-v4-pro': makeConfig('deepseek-v4-pro'),
		'gpt-5.6-luna': makeConfig('gpt-5.6-luna'),
	};
	const router = new ModelRouter(
		{ enabled: true, defaultModel: 'deepseek-flash', fallbackModel: 'gpt-5.6-luna', scenarios: { fast: 'deepseek-flash' } },
		profiles,
		profiles['deepseek-flash'],
	);

	eq(router.fallbackModelId, 'gpt-5.6-luna', 'routing exposes the configured 保底 model id');
	eq(router.fallbackConfig()?.model, 'gpt-5.6-luna', 'the 保底 model resolves to a usable config');
	eq(router.describe('继续').model, 'deepseek-flash', 'a simple prompt still routes to the fast model');

	const disabled = new ModelRouter(
		{ enabled: false, fallbackModel: 'gpt-5.6-luna', scenarios: {} }, profiles, profiles['deepseek-flash'],
	);
	eq(disabled.fallbackConfig(), undefined, 'routing disabled → no 保底 model');
}

async function testOpenAiHealthCheck(): Promise<void> {
	console.log('\n[6] provider health check is cheap and fail-safe');

	const provider = new OpenAIProvider(makeConfig('gpt-5.6-luna'));
	const start = Date.now();
	const reachable = await provider.healthCheck(1000);
	const elapsed = Date.now() - start;
	eq(reachable, false, 'an unreachable endpoint reports unhealthy instead of throwing');
	ok(elapsed < 5_000, `health check fails fast (${elapsed}ms)`);

	const noKey = new OpenAIProvider(makeConfig('gpt-5.6-luna', { apiKey: '' }));
	eq(await noKey.healthCheck(500), false, 'a provider without an API key reports unhealthy');

	// Status policy, verified against a local endpoint. Measured on the real
	// gateway: unknown model → 503, max_tokens too small → 400, healthy → 200.
	const http = await import('node:http');
	let status = 200;
	let body = '{}';
	let hang = false;
	const server = http.createServer((_req, res) => {
		if (hang) return; // never answer → exercises the probe timeout
		res.writeHead(status, { 'Content-Type': 'application/json' });
		res.end(body);
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	const base = `http://127.0.0.1:${port}/v1`;
	const cases: Array<[number, boolean, string]> = [
		[200, true, 'a healthy model is reachable'],
		[400, true, 'a 400 (probe rejected, e.g. max_tokens floor) still counts as reachable'],
		[429, true, 'a throttled but answering model counts as reachable'],
		[500, false, 'a 500 keeps the agent on the 保底 model'],
		[503, false, 'a 503 model_not_found keeps the agent on the 保底 model'],
		[404, false, 'a 404 keeps the agent on the 保底 model'],
		[401, false, 'an auth failure keeps the agent on the 保底 model'],
	];
	for (const [code, expected, msg] of cases) {
		status = code;
		body = code === 503 ? '{"error":{"code":"model_not_found"}}' : '{}';
		const p = new OpenAIProvider(makeConfig('primary-model', { apiBase: base }));
		eq(await p.healthCheck(3000), expected, msg);
	}

	hang = true;
	const hangStart = Date.now();
	const hung = await new OpenAIProvider(makeConfig('primary-model', { apiBase: base })).healthCheck(400);
	eq(hung, false, 'a model that stops answering is reported unhealthy');
	ok(Date.now() - hangStart < 3_000, 'the probe gives up on its own timeout, it does not hang the agent');

	await new Promise<void>(resolve => server.close(() => resolve()));
}

async function testReasoningLoopRecovery(): Promise<void> {
	console.log('\n[7] degenerate reasoning loop must not end the task with an empty answer');

	// First turn: the model burns its budget repeating itself and answers nothing.
	// Afterwards it behaves and produces a real summary.
	const provider = new FakeProvider([{ kind: 'loop' }, { kind: 'ok', text: 'final summary' }]);
	const agent = makeAgent(makeConfig('looping-model'), provider);

	const userMessages: string[] = [];
	agent.onDidReceiveMessage(m => {
		if (m.role === MessageRole.User) userMessages.push(m.content);
	});

	await agent.run('please answer');

	ok(provider.calls >= 2, `the degenerate turn was retried instead of accepted (${provider.calls} calls)`);
	ok(
		userMessages.some(m => m.includes('Stop repeating yourself')),
		'a corrective instruction was injected',
	);
	const assistant = agent.context.messages.filter(m => m.role === MessageRole.Assistant);
	ok(
		!assistant.some(m => m.reasoningContent && m.reasoningContent.includes('Let me do it.')),
		'the runaway reasoning block was dropped from the context',
	);
	const last = assistant[assistant.length - 1];
	eq(last?.content, 'final summary', 'the task ends with a real answer, not an empty reply');
	eq(agent.lastTaskError, undefined, 'the loop recovery does not fail the task');
	agent.dispose();
}

async function main(): Promise<void> {
	await testDegenerateReasoningDetection();
	testReportFormatting();
	await testContextHygieneOnSwitch();
	await testFallbackAndRecoveryProbe();
	await testFallbackConfigResolution();
	await testOpenAiHealthCheck();
	await testReasoningLoopRecovery();

	console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

void main();
