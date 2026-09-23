/*---------------------------------------------------------------------------------------------
 *  Unit tests: harness features borrowed from meta-harness
 *  (https://github.com/stanford-iris-lab/meta-harness).
 *
 *  1. Anthropic prompt caching — `reference_examples/terminal_bench_2/anthropic_caching.py`
 *     puts `cache_control: {type: ephemeral}` breakpoints on the system prompt and
 *     the newest messages, and degrades gracefully when the endpoint rejects them.
 *  2. Pinned original task — the reference TB2 harness rebuilds its post-overflow
 *     prompt as "original_instruction + current state"; here the task statement is
 *     pinned outside the sliding window so compaction cannot summarize the goal away.
 *
 *  Run:
 *    npx esbuild tests/agent-harness.test.ts --bundle --platform=node --target=node18 \
 *      --format=esm --outfile=/tmp/agent-harness.test.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/agent-harness.test.mjs
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import {
	createMessage,
	MessageRole,
	IAgentConfig,
	IAgentMessage,
} from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider } from 'vs/workbench/services/agent/browser/llmProvider';
import {
	AnthropicProvider,
	systemBlocksForCaching,
	markCacheBreakpoint,
} from 'vs/workbench/services/agent/browser/llmAnthropic';
import { AgentContext } from 'vs/workbench/contrib/agent/common/agentContext';
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

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function anthropicConfig(apiBase: string): IAgentConfig {
	return {
		provider: 'anthropic',
		model: 'claude-sonnet-4-20250514',
		apiKey: 'test-key',
		apiBase,
		maxSteps: 20,
		maxContextTokens: 200_000,
		maxOutputTokens: 8_192,
		temperature: 0,
		stepTimeout: 5_000,
		taskTimeout: 60_000,
	};
}

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

/** A provider that answers with a fixed summary (or throws) and records prompts. */
class SummaryProvider implements ILLMProvider {
	readonly name = 'fake-summary';
	calls = 0;
	lastPrompt = '';

	constructor(private readonly _fail = false) { }

	async complete(messages: IAgentMessage[]): Promise<IAgentMessage> {
		this.calls++;
		this.lastPrompt = messages[messages.length - 1]?.content ?? '';
		if (this._fail) {
			throw new Error('summarizer unavailable');
		}
		return createMessage(MessageRole.Assistant, 'HANDOFF summary: goal preserved, next step = add tests.');
	}

	async *stream(): AsyncIterableIterator<string> {
		yield '';
	}

	countTokens(text: string): number {
		return Math.ceil((text || '').length / 4);
	}
}

/** A provider whose reply is always "done" with no tool calls. */
class DoneProvider implements ILLMProvider {
	readonly name = 'fake-done';
	lastRequest: IAgentMessage[] = [];

	async complete(messages: IAgentMessage[]): Promise<IAgentMessage> {
		this.lastRequest = messages;
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

type CapturedRequest = Record<string, unknown>;

/** A throwaway Anthropic-shaped endpoint that records every request body. */
async function withAnthropicServer(
	handler: (body: CapturedRequest, attempt: number) => { status: number; body: string },
	run: (base: string, requests: CapturedRequest[]) => Promise<void>,
): Promise<void> {
	const requests: CapturedRequest[] = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', chunk => { raw += chunk; });
		req.on('end', () => {
			let body: CapturedRequest = {};
			try { body = JSON.parse(raw) as CapturedRequest; } catch { /* keep {} */ }
			requests.push(body);
			const reply = handler(body, requests.length);
			res.writeHead(reply.status, { 'Content-Type': 'application/json' });
			res.end(reply.body);
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	try {
		await run(`http://127.0.0.1:${port}`, requests);
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

const ANTHROPIC_OK = JSON.stringify({
	content: [{ type: 'text', text: 'ok' }],
	usage: { input_tokens: 100, output_tokens: 3 },
});

function hasCacheControl(value: unknown): boolean {
	if (!value || typeof value !== 'object') return false;
	if (Array.isArray(value)) return value.some(v => hasCacheControl(v));
	for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
		if (key === 'cache_control') return true;
		if (hasCacheControl(v)) return true;
	}
	return false;
}

/** Count cache_control breakpoints anywhere in a request body. */
function countCacheBreakpoints(body: CapturedRequest): number {
	const walk = (value: unknown): number => {
		if (!value || typeof value !== 'object') return 0;
		if (Array.isArray(value)) return value.reduce((sum, v) => sum + walk(v), 0);
		let n = 0;
		for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
			if (key === 'cache_control') n++;
			else n += walk(v);
		}
		return n;
	};
	return walk(body.messages) + walk(body.system);
}

function longConversation(): IAgentMessage[] {
	return [
		createMessage(MessageRole.System, 'You are a coding agent. '.repeat(80)),
		createMessage(MessageRole.User, 'first request'),
		createMessage(MessageRole.Assistant, 'first answer'),
		createMessage(MessageRole.User, 'second request'),
		createMessage(MessageRole.Tool, 'tool output', { toolCallId: 'c1' }),
	];
}

// ---------------------------------------------------------------------------
// 1. Anthropic prompt caching
// ---------------------------------------------------------------------------

function testCacheControlHelpers(): void {
	console.log('\n[1] prompt-caching helpers');

	const blocks = systemBlocksForCaching('system prompt');
	eq(blocks.length, 1, 'the system prompt becomes a single content block');
	eq((blocks[0] as Record<string, unknown>).type, 'text', 'the block is a text block');
	eq(
		((blocks[0] as Record<string, unknown>).cache_control as Record<string, unknown>).type,
		'ephemeral',
		'the system block carries an ephemeral cache breakpoint',
	);

	const stringMsg: Record<string, unknown> = { role: 'user', content: 'hello' };
	ok(markCacheBreakpoint(stringMsg), 'a string-content message can be marked');
	ok(Array.isArray(stringMsg.content), 'string content is rewritten into a block array');
	ok(hasCacheControl(stringMsg.content), 'the rewritten block carries cache_control');
	ok(!markCacheBreakpoint(stringMsg), 'marking the same message twice places nothing new');

	eq(markCacheBreakpoint({ role: 'user', content: '' }), false, 'empty content is never marked');
	eq(markCacheBreakpoint({ role: 'user', content: [] }), false, 'an empty block array is never marked');

	const multi: Record<string, unknown> = {
		role: 'assistant',
		content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't1', name: 'x', input: {} }],
	};
	ok(markCacheBreakpoint(multi), 'a multi-block message can be marked');
	ok(
		hasCacheControl((multi.content as Array<Record<string, unknown>>)[1]),
		'the breakpoint lands on the LAST block (the end of the cached prefix)',
	);
}

async function testAnthropicRequestsCarryCacheBreakpoints(): Promise<void> {
	console.log('\n[2] Anthropic requests carry cache breakpoints');

	await withAnthropicServer(
		() => ({ status: 200, body: ANTHROPIC_OK }),
		async (base, requests) => {
			const provider = new AnthropicProvider(anthropicConfig(base));
			const reply = await provider.complete(longConversation(), undefined, 0);
			eq(reply.content, 'ok', 'the response is parsed');

			eq(requests.length, 1, 'exactly one request was sent');
			const body = requests[0];

			ok(Array.isArray(body.system), 'the system prompt is sent as a content-block array');
			const systemBlock = (body.system as Array<Record<string, unknown>>)[0];
			eq(
				(systemBlock.cache_control as Record<string, unknown>).type,
				'ephemeral',
				'the system prompt carries an ephemeral cache breakpoint',
			);

			const messages = body.messages as Array<Record<string, unknown>>;
			eq(messages.length, 4, 'all non-system messages are forwarded (system is hoisted)');
			const marked = messages.filter(m => hasCacheControl(m.content));
			eq(marked.length, 2, 'the two newest messages carry a breakpoint');
			ok(hasCacheControl(messages[messages.length - 1].content), 'the newest message is marked');
			ok(hasCacheControl(messages[messages.length - 2].content), 'the second-newest message is marked');
			ok(!hasCacheControl(messages[0].content), 'older messages are left unmarked');
			ok(
				countCacheBreakpoints(body) <= 4,
				`breakpoints stay within Anthropic's limit of 4 (got ${countCacheBreakpoints(body)})`,
			);
			eq(provider.promptCachingDisabled, false, 'caching stays enabled when the endpoint accepts it');
		},
	);
}

async function testAnthropicStreamRequestsCarryCacheBreakpoints(): Promise<void> {
	console.log('\n[3] streaming requests use the same cached payload');

	const sse = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"he"}}\n\n'
		+ 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"llo"}}\n\n';
	await withAnthropicServer(
		() => ({ status: 200, body: sse }),
		async (base, requests) => {
			const provider = new AnthropicProvider(anthropicConfig(base));
			const chunks: string[] = [];
			for await (const token of provider.stream(longConversation())) {
				chunks.push(token);
			}
			eq(chunks.join(''), 'hello', 'streamed text is assembled');
			eq(requests[0].stream, true, 'the stream flag is set');
			ok(hasCacheControl(requests[0].system), 'streaming requests cache the system prompt too');
			ok(
				(requests[0].messages as Array<Record<string, unknown>>)
					.some(m => hasCacheControl(m.content)),
				'streaming requests cache the newest messages too',
			);
			// The API rejects a stream that also lacks the flag; make sure the
			// cache toggle did not drop it.
			eq(countCacheBreakpoints(requests[0]) <= 4, true, 'streaming stays within the breakpoint limit');
		},
	);
}

async function testCachingDegradesWhenEndpointRejectsIt(): Promise<void> {
	console.log('\n[4] prompt caching degrades gracefully on a rejecting gateway');

	await withAnthropicServer(
		(body, attempt) => {
			if (hasCacheControl(body.system) || hasCacheControl(body.messages)) {
				return {
					status: 400,
					body: JSON.stringify({
						type: 'error',
						error: { type: 'invalid_request_error', message: 'unexpected field cache_control' },
					}),
				};
			}
			return { status: 200, body: ANTHROPIC_OK };
		},
		async (base, requests) => {
			const provider = new AnthropicProvider(anthropicConfig(base));
			const reply = await provider.complete(longConversation(), undefined, 0);

			eq(reply.content, 'ok', 'the call still succeeds after the retry');
			eq(requests.length, 2, 'exactly one cache-free retry was made');
			ok(hasCacheControl(requests[0].system), 'the first attempt did carry cache breakpoints');
			ok(!hasCacheControl(requests[1].system), 'the retry sends a plain system prompt');
			ok(!hasCacheControl(requests[1].messages), 'the retry sends no message breakpoints');
			eq(provider.promptCachingDisabled, true, 'caching is switched off for this provider');
			ok(
				!!provider.promptCachingDisabledReason &&
				/cache_control/.test(provider.promptCachingDisabledReason!),
				'the rejection reason is kept for diagnostics',
			);

			// Later calls must not pay for another rejected attempt.
			await provider.complete(longConversation(), undefined, 0);
			eq(requests.length, 3, 'no further cache attempt is made once it was rejected');
			ok(!hasCacheControl(requests[2].messages), 'later calls are cache-free from the start');
		},
	);
}

async function testUnrelated400IsNotRetriedOrMasked(): Promise<void> {
	console.log('\n[5] an unrelated 400 is still a hard error');

	await withAnthropicServer(
		() => ({
			status: 400,
			body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be >= 1' } }),
		}),
		async (base, requests) => {
			const provider = new AnthropicProvider(anthropicConfig(base));
			let error: Error | undefined;
			try {
				await provider.complete(longConversation(), undefined, 0);
			} catch (err) {
				error = err as Error;
			}
			ok(!!error, 'the call fails');
			ok(/Anthropic API error 400/.test(error?.message ?? ''), 'the API error is surfaced verbatim');
			ok(/max_tokens/.test(error?.message ?? ''), 'the original error body is preserved');
			eq(requests.length, 1, 'a non-cache 400 is not retried');
			eq(provider.promptCachingDisabled, false, 'caching is not disabled by an unrelated error');
		},
	);
}

// ---------------------------------------------------------------------------
// 6. pinned original task
// ---------------------------------------------------------------------------

function makeContext(maxTokens = 1_000, maxOutputTokens = 100): { context: AgentContext; provider: SummaryProvider } {
	const provider = new SummaryProvider();
	const context = new AgentContext(maxTokens, maxOutputTokens, provider);
	return { context, provider };
}

function testTaskAnchorSurvivesTheSlidingWindow(): void {
	console.log('\n[6] the pinned task is never evicted by the sliding window');

	const { context } = makeContext();
	context.setSystemPrompt('system prompt');
	context.setTaskAnchor('implement the widget and run its tests');
	context.addMessage(createMessage(MessageRole.Assistant, 'x'.repeat(8_000)));

	eq(context.taskAnchorContent, 'implement the widget and run its tests', 'the anchor reports the raw task text');

	const window = context.getContextWindow();
	eq(window.length, 2, 'only the system prompt and the pinned task fit the budget');
	eq(window[0].role, MessageRole.System, 'the system prompt stays first');
	eq(window[1].role, MessageRole.User, 'the pinned task follows the system prompt');
	ok(window[1].content.includes('implement the widget'), 'the pinned task carries the user wording');
	ok(context.isOverBudget, 'the history is still reported as over budget');

	// The anchor counts toward the budget, so the guard cannot be fooled by a
	// task statement that is itself enormous.
	const tiny = makeContext(200, 100);
	tiny.context.setTaskAnchor('t'.repeat(10_000));
	ok(tiny.context.isOverBudget, 'an oversized pinned task still trips the over-budget guard');

	// Blank input never replaces a real anchor, and clearing removes it.
	const blank = makeContext();
	blank.context.setTaskAnchor('real task');
	blank.context.setTaskAnchor('   ');
	eq(blank.context.taskAnchorContent, 'real task', 'blank input never clobbers the pin');
	blank.context.clearTaskAnchor();
	eq(blank.context.taskAnchorContent, undefined, 'the pin can be cleared explicitly');
}

async function testCompactionIsAHandoffThatKeepsTheGoal(): Promise<void> {
	console.log('\n[7] compaction is a handoff that keeps the pinned goal');

	const { context, provider } = makeContext(2_000, 200);
	context.setSystemPrompt('system prompt');
	context.setTaskAnchor('implement the widget and run its tests');
	context.addMessage(createMessage(MessageRole.User, 'explore the repo ' + 'a'.repeat(2_000)));
	context.addMessage(createMessage(MessageRole.Assistant, 'found the entry point ' + 'b'.repeat(2_000)));
	context.addMessage(createMessage(MessageRole.User, 'write the implementation ' + 'c'.repeat(2_000)));
	context.addMessage(createMessage(MessageRole.Assistant, 'implementation written ' + 'd'.repeat(2_000)));

	const before = context.messages.length;
	ok(context.isOverBudget, 'the conversation is over budget before compaction');
	eq(await context.compactIfNeeded(), true, 'compaction runs');

	eq(provider.calls, 1, 'exactly one summarization call is made');
	ok(provider.lastPrompt.includes('HANDOFF'), 'the summary prompt asks for a handoff, not a generic recap');
	ok(provider.lastPrompt.includes('Pinned original task'), 'the pinned task is repeated inside the prompt');
	ok(provider.lastPrompt.includes('implement the widget'), 'the pinned task text reaches the summarizer');
	ok(provider.lastPrompt.includes('next concrete step'), 'the prompt asks for the next concrete step');

	ok(context.messages.length < before, 'the history shrank');
	eq(context.taskAnchorContent, 'implement the widget and run its tests', 'the goal is unchanged by compaction');

	const window = context.getContextWindow();
	ok(
		window.some(m => m.role === MessageRole.User && m.content.includes('implement the widget')),
		'the next request still states the original task',
	);
	ok(
		context.messages.some(m => m.content.includes('HANDOFF summary')),
		'the handoff summary replaced the summarized half',
	);
}

async function testTruncationFallbackKeepsTheGoal(): Promise<void> {
	console.log('\n[8] the truncation fallback keeps the pinned goal');

	const provider = new SummaryProvider(true);
	const context = new AgentContext(2_000, 200, provider);
	context.setTaskAnchor('migrate the parser to the new API');
	context.addMessage(createMessage(MessageRole.User, 'a'.repeat(2_000)));
	context.addMessage(createMessage(MessageRole.Assistant, 'b'.repeat(2_000)));
	context.addMessage(createMessage(MessageRole.User, 'c'.repeat(2_000)));
	context.addMessage(createMessage(MessageRole.Assistant, 'd'.repeat(2_000)));

	eq(await context.compactIfNeeded(), true, 'compaction still reports success');
	eq(provider.calls, 3, 'the summarizer was retried before falling back');
	eq(context.taskAnchorContent, 'migrate the parser to the new API', 'the goal survives a summarizer outage');
	ok(
		context.getContextWindow().some(m => m.content.includes('migrate the parser')),
		'the next request still states the original task after truncation',
	);
}

async function testAgentLoopPinsTheTask(): Promise<void> {
	console.log('\n[9] the agent loop pins the task it was started with');

	const config = makeConfig('pinned-model');
	const provider = new DoneProvider();
	const agent = new AgentLoop(
		config,
		provider,
		new ToolRegistry(),
		new AgentModeManager(),
		new AgentCheckpointManager({} as never),
		'/tmp',
	);

	await agent.run('rename every occurrence of Foo to Bar');

	eq(
		agent.context.taskAnchorContent,
		'rename every occurrence of Foo to Bar',
		'the loop pins the user message verbatim',
	);
	ok(
		provider.lastRequest.some(m => m.content.includes('rename every occurrence of Foo to Bar')),
		'the pinned task is sent to the model',
	);
	ok(agent.context.messages.length >= 1, 'the conversation itself is still recorded normally');

	agent.dispose();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log('agent-harness (meta-harness borrowings) tests');

	testCacheControlHelpers();
	await testAnthropicRequestsCarryCacheBreakpoints();
	await testAnthropicStreamRequestsCarryCacheBreakpoints();
	await testCachingDegradesWhenEndpointRejectsIt();
	await testUnrelated400IsNotRetriedOrMasked();

	testTaskAnchorSurvivesTheSlidingWindow();
	await testCompactionIsAHandoffThatKeepsTheGoal();
	await testTruncationFallbackKeepsTheGoal();
	await testAgentLoopPinsTheTask();

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) {
		process.exit(1);
	}
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
