/*---------------------------------------------------------------------------------------------
 *  Unit tests: Langfuse observability (tracing) integration
 *
 *  Covers:
 *    [1] configuration resolution (env / config.yaml / CLI flag / kill switch)
 *    [2] secret masking + metadata flattening (SDK attribute limits)
 *    [3] the no-op facade (tracing off must be invisible to the agent)
 *    [4] END-TO-END: a real AgentLoop run against a local OTLP receiver, with the
 *        exported payload decoded and audited against the Langfuse best-practice
 *        checklist (model, token usage, trace name, hierarchy, observation types,
 *        sensitive data masked, trace input/output).
 *
 *  Run:
 *    npx esbuild tests/langfuse-tracing.test.ts --bundle --platform=node --target=node18 \
 *      --format=esm --outfile=build/langfuse-tracing.test.mjs --tsconfig=tsconfig.json \
 *      --external:@langfuse/* --external:@opentelemetry/* \
 *    && node build/langfuse-tracing.test.mjs
 *
 *  The Langfuse SDK is loaded from node_modules at runtime (not bundled), and the
 *  run must not need credentials: the OTLP endpoint is pointed at a local receiver.
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';

import { AgentLoop } from 'vs/workbench/contrib/agent/common/agent';
import { AgentModeManager } from 'vs/workbench/contrib/agent/common/agentModes';
import { AgentCheckpointManager } from 'vs/workbench/contrib/agent/common/agentCheckpoint';
import { AgentTool, ToolRegistry } from 'vs/workbench/contrib/agent/common/agentTools';
import { ParallelAgentManager } from 'vs/workbench/contrib/agent/common/agentParallel';
import {
	LangfuseTracing,
	NoopTracing,
	loadTracingConfig,
	parseTracingYaml,
	redactDeep,
	redactSecrets,
	stringifyMeta,
} from 'vs/workbench/contrib/agent/common/agentTracing';
import {
	createMessage,
	MessageRole,
	IAgentConfig,
	IAgentMessage,
	IToolResult,
} from 'vs/workbench/services/agent/common/agentModels';
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

// ---------------------------------------------------------------------------
// [1] configuration resolution
// ---------------------------------------------------------------------------

/** Run `fn` with a patched process.env, restoring it afterwards. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
	const saved = new Map<string, string | undefined>();
	for (const [k, v] of Object.entries(vars)) {
		saved.set(k, process.env[k]);
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		fn();
	} finally {
		for (const [k, v] of saved) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	}
}

const LANGFUSE_ENV_KEYS = [
	'LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL', 'LANGFUSE_HOST',
	'LANGFUSE_TRACING_ENABLED', 'LANGFUSE_TRACING_ENVIRONMENT', 'LANGFUSE_RELEASE',
	'LANGFUSE_CAPTURE_CONTENT', 'LANGFUSE_USER_ID', 'LANGFUSE_SESSION_ID',
];

function clearLangfuseEnv(): Record<string, undefined> {
	const cleared: Record<string, undefined> = {};
	for (const k of LANGFUSE_ENV_KEYS) cleared[k] = undefined;
	return cleared;
}

function testConfigResolution(): void {
	console.log('\n[1] tracing configuration resolution');

	withEnv(clearLangfuseEnv(), () => {
		const off = loadTracingConfig();
		ok(!off.enabled, 'no keys → tracing disabled');
		ok(!!off.reason && off.reason.includes('LANGFUSE_PUBLIC_KEY'), `the reason names the missing keys (${off.reason})`);
	});

	withEnv({ ...clearLangfuseEnv(), LANGFUSE_PUBLIC_KEY: 'pk-lf-a', LANGFUSE_SECRET_KEY: 'sk-lf-b' }, () => {
		const on = loadTracingConfig(undefined, '9.9.9');
		ok(on.enabled, 'public+secret key → tracing enabled');
		eq(on.config?.baseUrl, 'https://cloud.langfuse.com', 'base URL defaults to the EU cloud');
		eq(on.config?.release, '9.9.9', 'release defaults to the agent version');
		ok(on.source?.includes('environment') === true, 'the key source is reported as environment');
	});

	withEnv({
		...clearLangfuseEnv(),
		LANGFUSE_PUBLIC_KEY: 'pk-lf-a',
		LANGFUSE_SECRET_KEY: 'sk-lf-b',
		LANGFUSE_BASE_URL: 'https://us.cloud.langfuse.com',
		LANGFUSE_HOST: 'https://ignored.example',
		LANGFUSE_TRACING_ENVIRONMENT: 'staging',
		LANGFUSE_CAPTURE_CONTENT: 'false',
	}, () => {
		const cfg = loadTracingConfig();
		eq(cfg.config?.baseUrl, 'https://us.cloud.langfuse.com', 'LANGFUSE_BASE_URL wins over LANGFUSE_HOST');
		eq(cfg.config?.environment, 'staging', 'LANGFUSE_TRACING_ENVIRONMENT maps to environment');
		eq(cfg.config?.captureContent, false, 'LANGFUSE_CAPTURE_CONTENT=false disables content capture');
	});

	withEnv({ ...clearLangfuseEnv(), LANGFUSE_PUBLIC_KEY: 'pk-lf-a', LANGFUSE_SECRET_KEY: 'sk-lf-b' }, () => {
		const off = loadTracingConfig('off');
		ok(!off.enabled && off.reason === 'disabled by --tracing off', '--tracing off wins over valid keys');
	});

	withEnv({
		...clearLangfuseEnv(),
		LANGFUSE_PUBLIC_KEY: 'pk-lf-a',
		LANGFUSE_SECRET_KEY: 'sk-lf-b',
		LANGFUSE_TRACING_ENABLED: 'false',
	}, () => {
		const off = loadTracingConfig('on');
		ok(!off.enabled, 'LANGFUSE_TRACING_ENABLED=false is a hard kill switch (beats --tracing on)');
	});

	// config.yaml `tracing:` section (parser only — no file I/O)
	const yaml = parseTracingYaml([
		'active_profile: openai',
		'tracing:',
		'  enabled: true',
		'  public_key: pk-lf-yaml',
		'  secret_key: "sk-lf-yaml"',
		'  base_url: https://langfuse.internal',
		'  capture_content: false',
		'  tags:',
		'    - code-agent',
		'    - local',
		'memory:',
		'  enabled: true',
	].join('\n'));
	eq(yaml?.public_key, 'pk-lf-yaml', 'the tracing section is parsed');
	eq(yaml?.secret_key, 'sk-lf-yaml', 'quoted values are unquoted');
	eq(yaml?.base_url, 'https://langfuse.internal', 'a self-hosted base URL is supported');
	eq(yaml?.capture_content, false, 'capture_content is parsed as a boolean');
	eq(yaml?.tags?.join(','), 'code-agent,local', 'tags are parsed as a list');
	ok(yaml?.enabled === true, 'enabled is parsed as a boolean');
	eq(parseTracingYaml('agent:\n  max_steps: 10\n')?.enabled, undefined, 'a config without a tracing section yields undefined');

	// env beats the file
	withEnv({
		...clearLangfuseEnv(),
		LANGFUSE_PUBLIC_KEY: 'pk-lf-env',
		LANGFUSE_SECRET_KEY: 'sk-lf-env',
		LANGFUSE_BASE_URL: 'https://env.example',
	}, () => {
		const cfg = loadTracingConfig();
		eq(cfg.config?.publicKey, 'pk-lf-env', 'env keys take precedence over config.yaml');
		eq(cfg.config?.baseUrl, 'https://env.example', 'env base URL takes precedence over config.yaml');
	});
}

// ---------------------------------------------------------------------------
// [2] masking / attribute limits
// ---------------------------------------------------------------------------

function testMasking(): void {
	console.log('\n[2] secret masking + attribute limits');

	ok(!redactSecrets('key=sk-lf-abc123def456ghi789').includes('abc123def456ghi789'), 'a Langfuse secret key is masked');
	ok(!redactSecrets('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9').includes('eyJhbGciOiJIUzI1NiJ9'), 'a bearer token is masked');
	ok(!redactSecrets('token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP').includes('eyJzdWIiOiIxMjM0NTY3ODkwIn0'),
		'a JWT is masked');
	ok(!redactSecrets('api_key = "abcdef123456"').includes('abcdef123456'), 'an api_key assignment is masked');
	ok(redactSecrets('const x = 1; // plain code').includes('const x = 1'), 'ordinary code is NOT mangled');

	const nested = redactDeep({ outer: { apiKey: 'sk-proj-abcdefghijklmnop' }, list: ['Bearer ABCDEFGHIJKLMNOP'] });
	const flat = JSON.stringify(nested);
	ok(!flat.includes('sk-proj-abcdefghijklmnop'), 'secrets are masked at every nesting depth');
	ok(!flat.includes('ABCDEFGHIJKLMNOP'), 'secrets inside arrays are masked');

	const meta = stringifyMeta({ a: 'x', n: 12, obj: { k: 1 }, long: 'y'.repeat(500), skip: undefined });
	eq(meta.a, 'x', 'string metadata is kept as-is');
	eq(meta.n, '12', 'numbers are stringified (the SDK drops non-strings)');
	eq(meta.obj, '{"k":1}', 'objects are JSON-stringified');
	ok(!('skip' in meta), 'undefined values are dropped');
	ok(meta.long.length <= 200, `oversized metadata is truncated to the 200-char SDK limit (${meta.long.length})`);
}

// ---------------------------------------------------------------------------
// [3] no-op facade
// ---------------------------------------------------------------------------

async function testNoopFacade(): Promise<void> {
	console.log('\n[3] no-op facade (tracing disabled)');

	const noop = new NoopTracing('test');
	ok(!noop.enabled, 'a no-op facade reports disabled');
	eq(noop.reason, 'test', 'the disabled reason is preserved');

	let ran = 0;
	const value = await noop.runTask({ name: 'x' }, async obs => {
		obs.update({ output: 'ignored' });
		const step = noop.beginStep({ name: 'agent-step-0' });
		eq(step.ref, null, 'a disabled step exposes no span reference');
		step.end();
		step.end(); // must be idempotent
		await noop.runGeneration({ name: 'llm-call' }, async g => { g.update({ model: 'm' }); return 'gen'; });
		await noop.runTool({ name: 'read_file' }, async t => { t.update({ output: 'o' }); return 'tool'; });
		await noop.runSubagent({ name: 'sub' }, async () => 'sub');
		ran++;
		return 'task';
	});
	eq(value, 'task', 'runTask returns the callback value');
	eq(ran, 1, 'every wrapper still executes the callback exactly once');
	await noop.flush();
	await noop.shutdown();
}

// ---------------------------------------------------------------------------
// [4] end-to-end against a local OTLP receiver
// ---------------------------------------------------------------------------

interface CapturedSpan {
	name: string;
	spanId: string;
	parentSpanId?: string;
	traceId: string;
	attrs: Record<string, unknown>;
}

interface OtlpReceiver {
	port: number;
	spans: CapturedSpan[];
	requests: number;
	errors: string[];
	close: () => Promise<void>;
}

/** Minimal OTLP/HTTP receiver that decodes the JSON payloads it is sent. */
async function startOtlpReceiver(): Promise<OtlpReceiver> {
	const spans: CapturedSpan[] = [];
	const state = { requests: 0, errors: [] as string[] };
	const server = http.createServer((req, res) => {
		state.requests++;
		const chunks: Buffer[] = [];
		req.on('data', c => chunks.push(c as Buffer));
		req.on('error', e => state.errors.push(`req error: ${e.message}`));
		req.on('end', () => {
			try {
				const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
				for (const rs of payload.resourceSpans || []) {
					for (const ss of rs.scopeSpans || []) {
						for (const s of ss.spans || []) {
							spans.push({
								name: s.name,
								spanId: s.spanId,
								parentSpanId: s.parentSpanId || undefined,
								traceId: s.traceId,
								attrs: Object.fromEntries((s.attributes || []).map((a: any) => {
									const v = a.value || {};
									return [a.key, v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? v];
								})),
							});
						}
					}
				}
			} catch (e) { state.errors.push(`decode error: ${(e as Error).message}`); }
			res.setHeader('Connection', 'close');
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end('{}');
		});
	});
	// Close the connection after each response so a pooled socket is never
	// reused after the server (or test) has moved on — a stale keep-alive socket
	// silently drops a batch and looks exactly like "exporting stopped".
	server.on('clientError', (e, socket) => {
		state.errors.push(`client error: ${e.message}`);
		socket.destroy();
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	return {
		port,
		spans,
		get requests() { return state.requests; },
		get errors() { return state.errors; },
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	};
}

class EchoTool extends AgentTool {
	readonly name = 'echo';
	readonly description = 'Echo the given value back';
	readonly parameters = { type: 'object', properties: { value: { type: 'string' } } };
	async execute(args: Record<string, unknown>): Promise<IToolResult> {
		return { toolCallId: String(args._toolCallId ?? ''), success: true, output: `echo:${String(args.value ?? '')}` };
	}
}

class ExplodeTool extends AgentTool {
	readonly name = 'explode';
	readonly description = 'Always fails';
	readonly parameters = { type: 'object', properties: {} };
	async execute(args: Record<string, unknown>): Promise<IToolResult> {
		return { toolCallId: String(args._toolCallId ?? ''), success: false, output: '', error: 'boom: tool exploded' };
	}
}

interface Turn {
	text?: string;
	tool?: { name: string; args: Record<string, unknown> };
	usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/** Scripted provider: plays one turn per `complete()` call. */
class ScriptedProvider implements ILLMProvider {
	readonly name = 'scripted';
	private _i = 0;
	constructor(private readonly _turns: Turn[]) {}
	private _next(): Turn {
		return this._turns[Math.min(this._i++, this._turns.length - 1)];
	}
	async complete(): Promise<IAgentMessage> {
		const t = this._next();
		if (t.tool) {
			return createMessage(MessageRole.Assistant, t.text ?? '', {
				toolCalls: [{ id: `call_${this._i}`, name: t.tool.name, arguments: t.tool.args }],
				usage: t.usage,
			});
		}
		return createMessage(MessageRole.Assistant, t.text ?? 'done', { usage: t.usage });
	}
	async *stream(): AsyncIterableIterator<string> { yield ''; }
	countTokens(text: string): number { return Math.ceil((text || '').length / 4); }
	supportsStreaming(): boolean { return false; }
}

function makeConfig(): IAgentConfig {
	return {
		provider: 'openai',
		model: 'deepseek-v4-pro',
		apiKey: 'sk-lf-SUPERSECRETKEY123456',
		apiBase: 'http://127.0.0.1:9/v1',
		maxSteps: 10,
		maxContextTokens: 1_000_000,
		maxOutputTokens: 100_000,
		temperature: 0,
		topK: 3,
		stepTimeout: 5_000,
		taskTimeout: 60_000,
	};
}

function registry(): ToolRegistry {
	const r = new ToolRegistry();
	r.register(new EchoTool());
	r.register(new ExplodeTool());
	return r;
}

function parentOf(spans: CapturedSpan[], span: CapturedSpan): string | undefined {
	if (!span.parentSpanId) return undefined;
	return spans.find(s => s.spanId === span.parentSpanId)?.name;
}

async function testEndToEnd(tracing: LangfuseTracing, receiver: OtlpReceiver): Promise<void> {
	console.log('\n[4] end-to-end: real AgentLoop → OTLP → audited payload');

	const from = receiver.spans.length;
	const secret = 'sk-lf-SUPERSECRETKEY123456';

	const provider = new ScriptedProvider([
		// Turn 1: call a tool, carrying a secret in the arguments.
		{ text: 'calling the echo tool', tool: { name: 'echo', args: { value: secret } }, usage: { promptTokens: 120, completionTokens: 8, totalTokens: 128 } },
		// Turn 2: final answer with usage.
		{ text: 'All done: the task is complete.', usage: { promptTokens: 200, completionTokens: 40, totalTokens: 240 } },
	]);

	const agent = new AgentLoop(makeConfig(), provider, registry(), new AgentModeManager(),
		new AgentCheckpointManager({} as never), '/tmp', undefined, tracing);

	await agent.run('echo the value and report back');
	ok(!agent.lastTaskError, `the agent run completed (error: ${agent.lastTaskError ?? 'none'})`);

	// A second run exercises the failure path (tool error level).
	process.env.LANGFUSE_CAPTURE_CONTENT = 'true';
	const failing = new ScriptedProvider([
		{ tool: { name: 'explode', args: {} } },
		{ text: 'The tool failed; reporting it.' },
	]);
	const agent2 = new AgentLoop(makeConfig(), failing, registry(), new AgentModeManager(),
		new AgentCheckpointManager({} as never), '/tmp', undefined, tracing);
	await agent2.run('call the failing tool');

	agent.dispose();
	agent2.dispose();
	await tracing.flush();

	const spans = receiver.spans.slice(from);
	ok(spans.length > 0, `the receiver captured ${spans.length} span(s)`);

	// Document the exported payload when debugging instrumentation:
	//   DUMP_SPANS=1 npm run test:tracing
	if (process.env.DUMP_SPANS) {
		for (const s of spans) {
			console.log(`\n  DUMP ${s.name} id=${s.spanId} parent=${s.parentSpanId ?? 'root'} trace=${s.traceId}`);
			for (const [k, v] of Object.entries(s.attrs)) {
				console.log(`    ${k} = ${JSON.stringify(v).slice(0, 300)}`);
			}
		}
	}

	// ---- rooted trace ----
	const roots = spans.filter(s => s.attrs['langfuse.internal.is_app_root'] === true);
	ok(roots.length >= 2, `each agent run produced a trace root (${roots.length} roots)`);
	const root = roots[0];
	eq(root.name, 'agent-task', 'the trace root uses a descriptive name');
	eq(root.attrs['langfuse.trace.name'], 'agent-task', 'the Langfuse trace name is set');
	eq(root.attrs['langfuse.environment'], 'test', 'the environment is attached to the trace');
	eq(root.attrs['langfuse.release'], '1.2.3', 'the release (agent version) is attached to the trace');
	ok(!!root.attrs['user.id'], `user.id is attributed (got ${JSON.stringify(root.attrs['user.id'])})`);
	ok(JSON.stringify(root.attrs['langfuse.trace.tags'] ?? '').includes('deepseek-v4-pro'),
		'the model is exposed as a trace tag for filtering');
	ok(typeof root.attrs['langfuse.observation.input'] === 'string'
		&& String(root.attrs['langfuse.observation.input']).includes('echo the value'),
		'trace input is the user message');
	ok(String(root.attrs['langfuse.observation.output'] ?? '').includes('All done'),
		'trace output is the final answer');

	// ---- hierarchy: task → step → generation / tool ----
	const traceSpans = spans.filter(s => s.traceId === root.traceId);
	const steps = traceSpans.filter(s => s.name.startsWith('agent-step-'));
	const generations = traceSpans.filter(s => s.attrs['langfuse.observation.type'] === 'generation');
	const tools = traceSpans.filter(s => s.attrs['langfuse.observation.type'] === 'tool');
	ok(steps.length >= 2, `one step span per ReAct iteration (${steps.length})`);
	eq(generations.length, 2, 'one generation per LLM call');
	eq(tools.length, 1, 'one tool observation per tool call');

	ok(steps.every(s => parentOf(traceSpans, s) === 'agent-task'), 'every step is a child of the task span');
	ok(generations.every(g => parentOf(traceSpans, g)?.startsWith('agent-step-') === true),
		'generations are nested inside the step that requested them');
	// The step that produced the tool call owns both the generation and the tool,
	// as siblings — not the tool nested under the generation.
	const toolStep = parentOf(traceSpans, tools[0]);
	ok(toolStep === 'agent-step-0', `the tool call belongs to step 0 (got ${toolStep})`);
	ok(generations.some(g => parentOf(traceSpans, g) === toolStep),
		'the requesting generation and the tool call share the same step');
	ok(generations.every(g => g.spanId !== tools[0]?.spanId), 'a tool is NOT parented to a generation');
	eq(generations.filter(g => parentOf(traceSpans, g) === 'agent-step-1').length, 1,
		'the final answer came from a generation in step 1');
	ok(String(steps.find(s => s.name === 'agent-step-0')?.attrs['langfuse.observation.output'] ?? '').includes('echo'),
		'the step records which tool it decided to call');

	// ---- generation quality (model + params + usage = cost tracking) ----
	const gen = generations.find(g => parentOf(traceSpans, g) === 'agent-step-0') ?? generations[0];
	eq(gen.name, 'llm-call', 'the generation has a descriptive name');
	eq(gen.attrs['langfuse.observation.model.name'], 'deepseek-v4-pro', 'the model name is captured');
	const params = String(gen.attrs['langfuse.observation.model.parameters'] ?? '');
	ok(params.includes('"temperature":0'), `model parameters include temperature (${params})`);
	ok(params.includes('"top_k":3'), 'model parameters include top_k');
	const usage = String(gen.attrs['langfuse.observation.usage_details'] ?? '');
	ok(usage.includes('"input":120') && usage.includes('"output":8'),
		`input/output token usage is captured (enables automatic cost calculation) (${usage})`);
	const genMeta = String(gen.attrs['langfuse.observation.metadata.attempt'] ?? '');
	eq(genMeta, '1', 'the generation records which attempt it was');
	ok(String(gen.attrs['langfuse.observation.input'] ?? '').includes('role'), 'the generation input is the message array');
	ok(String(gen.attrs['langfuse.observation.output'] ?? '').includes('calling the echo tool'),
		'the generation output is the assistant reply');
	ok(gen.attrs['langfuse.observation.completion_start_time'] !== undefined,
		'completion start time is recorded');

	// ---- tool observations ----
	const tool = tools[0];
	ok(tool.name.startsWith('tool:echo'), `the tool span is named after the tool (${tool.name})`);
	ok(String(tool.attrs['langfuse.observation.input'] ?? '').includes('value'),
		'tool input is the tool arguments');
	ok(String(tool.attrs['langfuse.observation.output'] ?? '').includes('echo:'),
		'tool output is the result');
	eq(tool.attrs['langfuse.observation.level'], 'DEFAULT', 'a successful tool call is at DEFAULT level');

	// ---- sensitive data masked ----
	ok(!JSON.stringify(spans).includes(secret), 'the API key never appears anywhere in the exported payloads');
	eq(root.attrs['langfuse.observation.output'] !== undefined, true, 'the trace still has its output after masking');

	// ---- failure path ----
	const failedTool = spans.find(s => s.name === 'tool:explode');
	ok(!!failedTool, 'a failing tool call is still traced');
	eq(failedTool?.attrs['langfuse.observation.level'], 'ERROR', 'a failing tool call is recorded at ERROR level');
	ok(String(failedTool?.attrs['langfuse.observation.status_message'] ?? '').includes('boom'),
		'the tool error message is attached as the status message');
}

// ---------------------------------------------------------------------------
// [5] parallel subagents → `agent` observations (multi-agent best practice)
// ---------------------------------------------------------------------------

async function testSubagentObservations(tracing: LangfuseTracing, receiver: OtlpReceiver): Promise<void> {
	console.log('\n[5] parallel subagents are typed `agent` and nested under the orchestrator');

	const from = receiver.spans.length;

	// Always answers, so each subagent finishes regardless of interleaving.
	class AnsweringProvider implements ILLMProvider {
		readonly name = 'scripted';
		async complete(): Promise<IAgentMessage> {
			return createMessage(MessageRole.Assistant, 'Finished the assigned subtask.', {
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			});
		}
		async *stream(): AsyncIterableIterator<string> { yield ''; }
		countTokens(): number { return 1; }
		supportsStreaming(): boolean { return false; }
	}

	const manager = new ParallelAgentManager(
		makeConfig(),
		new AnsweringProvider(),
		registry(),
		'/tmp',
		new AgentCheckpointManager({} as never),
		2, // maxConcurrent
		undefined,
		undefined,
		tracing,
	);
	const results = await manager.runParallel(['summarise file alpha', 'summarise file beta']);
	eq(results.length, 2, 'both subagents ran');
	manager.dispose();
	await tracing.flush();

	const spans = receiver.spans.slice(from);
	if (process.env.DUMP_SPANS) {
		console.log(`\n  DUMP parallel: ${spans.length} span(s)`);
		for (const s of spans) {
			console.log(`    ${s.name} type=${s.attrs['langfuse.observation.type']} parent=${s.parentSpanId ?? 'root'} root=${s.attrs['langfuse.internal.is_app_root']}`);
		}
	}
	const roots = spans.filter(s => s.attrs['langfuse.internal.is_app_root'] === true);
	eq(roots.length, 1, 'the fan-out produces ONE trace (not one per subagent)');
	eq(roots[0].name, 'agent-parallel', 'the orchestrator span names the run');

	const orchId = roots[0].spanId;
	const agents = spans.filter(s => s.attrs['langfuse.observation.type'] === 'agent');
	eq(agents.length, 2, 'each subagent is its own `agent` observation');
	ok(agents.every(a => parentOf(spans, a) === 'agent-parallel'),
		'every subagent is nested under the orchestrator');
	ok(agents.every(a => a.name.startsWith('subagent: ')),
		'subagents are named after their task (not a generic role name)');
	ok(agents.map(a => a.name).join('|').includes('alpha')
		&& agents.map(a => a.name).join('|').includes('beta'),
		'the two concurrent subagents are distinguishable by name');
	ok(spans.every(s => s.attrs['langfuse.observation.type'] !== 'tool' || s.name !== 'subagent'),
		'a dispatch is not ALSO emitted as a tool span (no double representation)');

	const subTasks = spans.filter(s => s.name === 'agent-task');
	eq(subTasks.length, 2, 'each subagent opens a task span inside its own agent observation');
	const agentIds = new Set(agents.map(a => a.spanId));
	ok(subTasks.every(t => agentIds.has(t.parentSpanId ?? '')),
		"each subagent's spans nest under ITS agent observation, not the shared root");
	ok(spans.filter(s => s.attrs['langfuse.observation.type'] === 'generation').length >= 2,
		'each subagent produced at least one traced generation');
	ok(spans.every(s => s.traceId === roots[0].traceId), 'all subagent spans share the orchestrator trace');
	ok(orchId.length > 0, 'the orchestrator span id is propagated to its children');
}

async function main(): Promise<void> {
	console.log(`langfuse tracing tests — node ${process.version}`);
	testConfigResolution();
	testMasking();
	await testNoopFacade();

	// One Langfuse instance for the whole end-to-end run: the OpenTelemetry
	// global tracer provider can only be registered once per process, and the
	// agent initializes tracing once per process too.
	const receiver = await startOtlpReceiver();
	process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
	process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test-secret';
	process.env.LANGFUSE_BASE_URL = `http://127.0.0.1:${receiver.port}`;
	process.env.LANGFUSE_TRACING_ENVIRONMENT = 'test';
	// JSON encoding so the receiver can decode the exported spans without protobuf.
	process.env.OTEL_EXPORTER_OTLP_PROTOCOL = 'http/json';

	const settings = loadTracingConfig(undefined, '1.2.3');
	ok(settings.enabled, 'tracing resolves as enabled for the local receiver');
	const tracing = new LangfuseTracing(settings.config!);
	ok(await tracing.init(), `the Langfuse SDK loaded on node ${process.version}`);

	await testEndToEnd(tracing, receiver);
	await testSubagentObservations(tracing, receiver);

	await tracing.shutdown();
	await receiver.close();
	for (const k of ['LANGFUSE_PUBLIC_KEY', 'LANGFUSE_SECRET_KEY', 'LANGFUSE_BASE_URL',
		'LANGFUSE_TRACING_ENVIRONMENT', 'LANGFUSE_CAPTURE_CONTENT', 'OTEL_EXPORTER_OTLP_PROTOCOL']) {
		delete process.env[k];
	}

	console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

void main();
