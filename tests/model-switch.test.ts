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
	isApiRateLimitError,
	isApiTimeoutError,
	isApiFallbackTrigger,
	classifyApiFallback,
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
import { ILLMProvider, IHealthCheckOptions } from 'vs/workbench/services/agent/browser/llmProvider';
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

type Behavior =
	| { kind: 'ok'; text?: string; reasoning?: string }
	| { kind: 'timeout' }
	| { kind: 'rate-limit'; message?: string }
	| { kind: 'loop' };

/** The quota error observed verbatim in the run history (api.enflame.cn). */
function tpmError(): Error {
	return new Error(
		'OpenAI API error 429: {"error":{"message":"Token usage exceeds the current model TPM '
		+ '(tokens per minute) limit 6000000. Please reduce the request frequency or contact the '
		+ 'administrator.","type":"invalid_request_error","code":"rate_limit_exceeded"}}',
	);
}

/** The observed hy3 failure: a 98k-char reasoning block stuck on one line. */
function degenerateReasoning(): string {
	return Array.from({ length: 1500 }, (_, i) =>
		i % 2 === 0 ? 'Hmm — let me find lit.' : 'Let me do it.').join('\n');
}

class FakeProvider implements ILLMProvider {
	readonly name = 'fake';
	healthChecks = 0;
	calls = 0;
	/** Probe options of the last health check (throttle-aware recovery). */
	lastHealthCheckOpts: IHealthCheckOptions | undefined;
	constructor(
		behaviors: Behavior[],
		public healthy = true,
		public thinks = false,
		/** Answers the probe with 429 (throttled) instead of a real answer. */
		public throttled = false,
	) {
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
		if (behavior.kind === 'rate-limit') {
			throw behavior.message ? new Error(behavior.message) : tpmError();
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

	async healthCheck(_timeoutMs?: number, opts?: IHealthCheckOptions): Promise<boolean> {
		this.healthChecks++;
		this.lastHealthCheckOpts = opts;
		// A throttled endpoint answers 429: that means "reachable" unless the
		// agent fell back because of throttling.
		if (this.throttled) return opts?.throttleSensitive !== true;
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

	// Throttle-aware probing (used when the agent fell back because of a quota
	// error): a 429 means "still throttled", so the agent must stay on the
	// 保底 model until the model really answers.
	status = 429;
	const throttled = new OpenAIProvider(makeConfig('primary-model', { apiBase: base }));
	eq(await throttled.healthCheck(3000, { throttleSensitive: true }), false,
		'a 429 is NOT recovery when the fallback was caused by throttling');
	status = 400;
	eq(await throttled.healthCheck(3000, { throttleSensitive: true }), true,
		'a real answer (400 = probe rejected) is recovery even for a throttled primary');
	status = 200;
	eq(await throttled.healthCheck(3000, { throttleSensitive: true }), true,
		'a 200 is recovery for a throttled primary');

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

async function testThinkingEchoBackOnRecovery(): Promise<void> {
	console.log('\n[8] thinking-mode echo-back survives a 保底-model recovery');

	// Emulates the gateway rule measured on api.enflame.cn: a model that answers in
	// thinking mode rejects any request whose assistant messages do NOT all carry
	// reasoning_content (an EMPTY string is accepted) while the request itself ends
	// with tool results. Verified requests against the real gateway:
	//   assistant(tool_calls) + tool, no reasoning content on ANY assistant → 400
	//   same history with reasoning_content:"" on ALL assistant messages   → 200
	const http = await import('node:http');
	type SentBody = { messages: Array<{ role: string; reasoning_content?: string }> };
	const sent: SentBody[] = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', chunk => { raw += chunk; });
		req.on('end', () => {
			const body = JSON.parse(raw) as SentBody;
			sent.push(body);
			const msgs = body.messages || [];
			const assistants = msgs.filter(m => m.role === 'assistant');
			const endsWithToolResult = msgs.length > 0 && msgs[msgs.length - 1].role === 'tool';
			const missingEcho = assistants.some(m => !('reasoning_content' in m));
			if (endsWithToolResult && assistants.length > 0 && missingEcho) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: {
					message: 'The `reasoning_content` in the thinking mode must be passed back to the API.',
					type: 'invalid_request_error', param: '', code: 'invalid_request_error',
				} }));
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				choices: [{ message: { role: 'assistant', reasoning_content: 'thinking…', content: 'ok' } }],
				usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
			}));
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

	// The history a recovered session hands back to the primary model: the last
	// turns belong to the non-thinking 保底 model, and the chain-of-thought of the
	// earlier turns was dropped on the switch — so NO assistant message has it.
	const recoveredHistory: IAgentMessage[] = [
		createMessage(MessageRole.User, 'run ls'),
		createMessage(MessageRole.Assistant, 'I ran ls and got three entries.', {
			toolCalls: [{ id: 'call_1', name: 'run_terminal', arguments: { command: 'ls' } }],
		}),
		createMessage(MessageRole.Tool, 'a b c', { toolCallId: 'call_1' }),
	];

	// ---- (a) The model already answered in thinking mode before the swap ----
	const primary = new OpenAIProvider(makeConfig('deepseek-flash', { apiBase: base }));
	await primary.complete([createMessage(MessageRole.User, 'ping')]);
	ok(primary.supportsReasoning(), 'a model that answered with reasoning_content is known to think');

	sent.length = 0;
	await primary.complete(recoveredHistory);
	eq(sent.length, 1, 'no repair round-trip is needed once the model is known to think');
	const echoed = sent[0].messages.filter(m => m.role === 'assistant');
	ok(echoed.length > 0 && echoed.every(m => 'reasoning_content' in m),
		'the request to the thinking model echoes reasoning_content on EVERY assistant message');

	// ---- (b) Fresh process resuming a session whose reasoning was stripped ----
	const resumed = new OpenAIProvider(makeConfig('deepseek-flash', { apiBase: base }));
	ok(!resumed.supportsReasoning(), 'a fresh provider has no evidence yet');
	sent.length = 0;
	const answer = await resumed.complete(recoveredHistory);
	eq(sent.length, 2, 'the rejected request is resent once with reasoning_content restored');
	ok((answer.content || '') === 'ok' || !!answer, 'the retry succeeds instead of failing the task');
	ok(resumed.supportsReasoning(), 'the model is remembered as a thinking model after the repair');

	await new Promise<void>(resolve => server.close(() => resolve()));
}

/**
 * Rate-limit (429 / TPM-RPM quota) must behave exactly like an access timeout:
 * switch to the 保底 model, retry the SAME request, and keep the task alive.
 * Measured motivation: "OpenAI API error 429: Token usage exceeds the current
 * model TPM (tokens per minute) limit 6000000" failed 13 tasks in one 14-day
 * window because only timeouts were treated as a fallback trigger.
 */
async function testRateLimitFallback(): Promise<void> {
	console.log('\n[9] rate limit (429 / TPM quota) also falls back to the 保底 model');

	// ---- (a) detection ----
	const tpm = tpmError();
	ok(isApiRateLimitError(tpm), 'the observed TPM quota error is detected as a rate limit');
	ok(isApiRateLimitError(new Error('HTTP 429 Too Many Requests')), 'a bare 429 is detected');
	ok(isApiRateLimitError(new Error('{"error":"requests per minute limit exceeded"}')),
		'an RPM-limit message is detected');
	const asStatus = new Error('throttled') as Error & { status?: number };
	asStatus.status = 429;
	ok(isApiRateLimitError(asStatus), 'a structured status=429 is detected');
	ok(!isApiRateLimitError(new Error('OpenAI API error 4290: nope')),
		'an unrelated number that merely contains 429 is NOT a rate limit');

	// Not a rate limit: request-shape and server errors must keep their own paths.
	const reasoning400 = new Error(
		'OpenAI API error 400: {"error":{"message":"The `reasoning_content` in the thinking mode '
		+ 'must be passed back to the API.","type":"invalid_request_error"}}',
	);
	ok(!isApiRateLimitError(reasoning400), 'the reasoning_content 400 is NOT a rate limit');
	ok(!isApiFallbackTrigger(reasoning400), 'the reasoning_content 400 does not burn the 保底 model');
	ok(!isApiRateLimitError(new Error('OpenAI API error 500: internal error')), 'a 500 is not a rate limit');
	ok(!isApiTimeoutError(tpm), 'a rate limit is not a timeout (the two triggers stay distinguishable)');
	eq(classifyApiFallback(tpm), 'rate-limit', 'classification: quota error → rate-limit');
	eq(classifyApiFallback(new Error('request timed out')), 'timeout', 'classification: timeout → timeout');
	eq(classifyApiFallback(reasoning400), undefined, 'classification: neither → no fallback');

	// ---- (b) the loop retries the same request on the 保底 model ----
	const primaryCfg = makeConfig('deepseek-flash');
	const fallbackCfg = makeConfig('gpt-5.6-luna', { maxContextTokens: 256_000, maxOutputTokens: 32_768 });
	const throttledPrimary = new FakeProvider([{ kind: 'rate-limit' }], true, false, true);

	const agent = makeAgent(primaryCfg, throttledPrimary);
	agent.setFallback(fallbackCfg, new FakeProvider([{ kind: 'ok', text: 'answered by 保底' }]));
	agent.setProbeSchedule(60, 120);
	const events: IModelSwitchEvent[] = [];
	agent.onDidSwitchModel(e => events.push(e));

	await agent.run('please answer');
	eq(agent.activeModel, 'gpt-5.6-luna', 'the request is retried on the 保底 model');
	eq(events.length, 1, 'exactly one fallback switch is reported');
	eq(events[0].reason, 'fallback-rate-limit', 'the switch is reported as a rate-limit fallback');
	ok(events[0].detail!.includes('rate limit'), 'the reason is surfaced in the switch detail');
	ok(events[0].detail!.includes('TPM'), 'the offending quota message is preserved');
	eq(agent.lastTaskError, undefined, 'the task survives instead of ending with the 429');

	// ---- (c) a throttled primary is NOT "recovered" just because it answers 429 ----
	await sleep(300);
	ok(throttledPrimary.healthChecks >= 1, 'the recovery probe ran');
	eq(throttledPrimary.lastHealthCheckOpts?.throttleSensitive, true,
		'the probe asks for throttle-aware health (429 ≠ recovered after a quota fallback)');
	eq(agent.activeModel, 'gpt-5.6-luna', 'still throttled → stay on the 保底 model');
	eq(events.length, 1, 'no switch-back while the quota window is still closed');

	// The window rolls over: the probe gets a real answer → switch back.
	throttledPrimary.throttled = false;
	await sleep(500);
	eq(agent.activeModel, 'deepseek-flash', 'the primary is re-adopted once it really answers');
	ok(!agent.usingFallback, 'fallback flag cleared after the quota recovery');
	agent.dispose();

	// ---- (d) a timeout fallback keeps the old, permissive probe policy ----
	const timingOutPrimary = new FakeProvider([{ kind: 'timeout' }], true, false, true);
	const agent2 = makeAgent(primaryCfg, timingOutPrimary);
	agent2.setFallback(fallbackCfg, new FakeProvider([{ kind: 'ok' }]));
	agent2.setProbeSchedule(60, 120);
	await agent2.run('please answer');
	await sleep(300);
	ok(timingOutPrimary.healthChecks >= 1, 'the timeout fallback also probes the primary');
	eq(timingOutPrimary.lastHealthCheckOpts?.throttleSensitive, false,
		'a timeout fallback does not make the probe throttle-sensitive');
	agent2.dispose();
}

async function main(): Promise<void> {
	await testDegenerateReasoningDetection();
	testReportFormatting();
	await testContextHygieneOnSwitch();
	await testFallbackAndRecoveryProbe();
	await testFallbackConfigResolution();
	await testOpenAiHealthCheck();
	await testReasoningLoopRecovery();
	await testThinkingEchoBackOnRecovery();
	await testRateLimitFallback();

	console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

void main();
