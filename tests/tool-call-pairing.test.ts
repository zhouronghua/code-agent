/*---------------------------------------------------------------------------------------------
 *  Unit tests: the assistant `tool_calls` ↔ `tool` message pairing invariant.
 *
 *  Reported symptom: a session could not be resumed — every new task failed
 *  within a second with
 *
 *    OpenAI API error 400: An assistant message with 'tool_calls' must be
 *    followed by tool messages responding to each 'tool_call_id'.
 *    (insufficient tool messages following tool_calls message)
 *
 *  Cause: the ReAct loop appends the assistant message (with tool_calls) to the
 *  history and only then executes the tools. If the run stops in between — the
 *  user hits Ctrl+C / exits (gracefulExit saves the session right after
 *  `cancel()`), or the task is superseded/cancelled mid-step — the saved
 *  session ends with an assistant `tool_calls` that has no answers. The API is
 *  strict about the invariant and the model cannot repair it, so replaying that
 *  history 400s forever.
 *
 *  Covers:
 *    [1] sanitizeToolCallPairs() — the invariant enforcer
 *    [2] AgentContext.getContextWindow() / repairToolCallPairs()
 *    [3] END-TO-END: resuming a poisoned session now sends a valid request
 *    [4] exportSessionState() never persists a dangling tool_calls
 *
 *  Run:
 *    npx esbuild tests/tool-call-pairing.test.ts --bundle --platform=node --target=node18 \
 *      --format=esm --outfile=build/tool-call-pairing.test.mjs --tsconfig=tsconfig.json \
 *    && node build/tool-call-pairing.test.mjs
 *--------------------------------------------------------------------------------------------*/

import {
	createMessage,
	MessageRole,
	IAgentConfig,
	IAgentMessage,
	IToolCall,
} from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider } from 'vs/workbench/services/agent/browser/llmProvider';
import {
	AgentContext,
	sanitizeToolCallPairs,
	UNANSWERED_TOOL_CALL,
} from 'vs/workbench/contrib/agent/common/agentContext';
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

function makeConfig(over: Partial<IAgentConfig> = {}): IAgentConfig {
	return {
		provider: 'openai',
		model: 'pairing-test-model',
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

/** A provider that records every request it is given and always answers "done". */
class CapturingProvider implements ILLMProvider {
	readonly name = 'fake-capturing';
	requests: IAgentMessage[][] = [];
	async complete(messages: IAgentMessage[]): Promise<IAgentMessage> {
		this.requests.push(messages.map(m => m));
		return createMessage(MessageRole.Assistant, 'done');
	}
	async *stream(): AsyncIterableIterator<string> { yield ''; }
	countTokens(text: string): number { return Math.ceil((text || '').length / 4); }
	supportsStreaming(): boolean { return false; }
}

function toolCall(id: string, name = 'run_terminal'): IToolCall {
	return { id, name, arguments: { command: 'echo hi' } };
}

function assistantWithCalls(...ids: string[]): IAgentMessage {
	return createMessage(MessageRole.Assistant, '', { toolCalls: ids.map(id => toolCall(id)) });
}

function toolAnswer(id: string, content = 'ok'): IAgentMessage {
	return createMessage(MessageRole.Tool, content, { toolCallId: id });
}

/**
 * The API's own rule, applied locally: every assistant `tool_calls` id must be
 * answered by a `tool` message that appears in the immediately following run of
 * tool messages, and no `tool` message may be an orphan.
 */
function pairingViolations(messages: readonly IAgentMessage[]): string[] {
	const problems: string[] = [];
	let i = 0;
	while (i < messages.length) {
		const msg = messages[i];
		if (msg.role === MessageRole.Assistant && msg.toolCalls && msg.toolCalls.length > 0) {
			const answered = new Set<string>();
			let j = i + 1;
			while (j < messages.length && messages[j].role === MessageRole.Tool) {
				const id = messages[j].toolCallId;
				if (id) answered.add(id);
				j++;
			}
			for (const tc of msg.toolCalls) {
				if (!answered.has(tc.id)) problems.push(`assistant tool_calls ${tc.id} is unanswered`);
			}
			// The answered run belongs to this assistant turn — skip past it,
			// otherwise every real answer would look like an orphan.
			i = j;
			continue;
		}
		if (msg.role === MessageRole.Tool) {
			problems.push(`orphan tool message (tool_call_id=${msg.toolCallId ?? 'none'})`);
		}
		i++;
	}
	return problems;
}

// ---------------------------------------------------------------------------
// [1] sanitizeToolCallPairs
// ---------------------------------------------------------------------------

function testSanitizer(): void {
	console.log('\n[1] sanitizeToolCallPairs enforces the API invariant');

	// (a) valid history is returned unchanged (same objects, same order)
	const valid = [
		createMessage(MessageRole.User, 'build it'),
		assistantWithCalls('a'),
		toolAnswer('a'),
		createMessage(MessageRole.Assistant, 'done'),
	];
	{
		const out = sanitizeToolCallPairs(valid);
		eq(out.length, valid.length, 'a valid history keeps its length');
		ok(out.every((m, i) => m === valid[i]), 'a valid history is passed through untouched');
		eq(pairingViolations(out).length, 0, 'a valid history has no violations');
	}

	// (b) the reported corruption: assistant tool_calls, then a user message
	{
		const broken = [
			createMessage(MessageRole.User, 'build it'),
			assistantWithCalls('call_00_RJdPWD1xw3GZ8C44Z5b99363'),
			createMessage(MessageRole.User, '继续'),
			createMessage(MessageRole.User, '继续'),
		];
		ok(pairingViolations(broken).length === 1, 'the raw history is indeed invalid (1 violation)');
		const out = sanitizeToolCallPairs(broken);
		eq(pairingViolations(out).length, 0, 'the repaired history is valid');
		const synth = out[2];
		eq(synth.role, MessageRole.Tool, 'a tool message is inserted right after the assistant tool_calls');
		eq(synth.toolCallId, 'call_00_RJdPWD1xw3GZ8C44Z5b99363', 'it answers the missing tool_call_id');
		eq(synth.content, UNANSWERED_TOOL_CALL, 'its content says the tool never ran');
		eq(out.length, broken.length + 1, 'exactly one message is added');
		eq(out[3].content, '继续', 'the following user messages keep their order');
	}

	// (c) a PARTIAL answer only synthesizes the missing ids, in order
	{
		const partial = [
			assistantWithCalls('a', 'b', 'c'),
			toolAnswer('a', 'first'),
			createMessage(MessageRole.User, 'next'),
		];
		const out = sanitizeToolCallPairs(partial);
		eq(pairingViolations(out).length, 0, 'a partially answered tool_calls group is completed');
		eq(out[1].content, 'first', 'the real answer is kept');
		eq(out[2].toolCallId, 'b', 'the first missing id is answered');
		eq(out[3].toolCallId, 'c', 'the second missing id is answered');
		eq(out[4].role, MessageRole.User, 'the following user message still comes after the answers');
	}

	// (d) an orphan tool result (assistant half evicted by the window) is dropped
	{
		const orphan = [
			toolAnswer('gone', 'stale result'),
			createMessage(MessageRole.User, 'hello'),
		];
		const out = sanitizeToolCallPairs(orphan);
		eq(out.length, 1, 'the orphan tool message is dropped');
		eq(out[0].role, MessageRole.User, 'the rest survives');
	}

	// (e) a duplicated answer is dropped (it would answer twice)
	{
		const dup = [assistantWithCalls('a'), toolAnswer('a', '1'), toolAnswer('a', '2')];
		const out = sanitizeToolCallPairs(dup);
		eq(out.length, 2, 'the duplicate tool answer is dropped');
		eq(out[1].content, '1', 'the first answer wins');
	}

	// (f) an assistant turn with NO tool calls is never touched
	{
		const plain = [createMessage(MessageRole.User, 'hi'), createMessage(MessageRole.Assistant, 'hello')];
		const out = sanitizeToolCallPairs(plain);
		ok(out.every((m, i) => m === plain[i]), 'a tool-free conversation is untouched');
	}
}

// ---------------------------------------------------------------------------
// [2] AgentContext
// ---------------------------------------------------------------------------

function seedPoisonedContext(): AgentContext {
	const ctx = new AgentContext(1_000_000, 100_000, new CapturingProvider());
	ctx.setSystemPrompt('system');
	ctx.addMessage(createMessage(MessageRole.User, 'build it'));
	// The exact shape found in the stuck session: the assistant asked for a long
	// build, then the user sent two more messages while it never returned.
	ctx.addMessage(assistantWithCalls('call_00_RJdPWD1xw3GZ8C44Z5b99363'));
	ctx.addMessage(createMessage(MessageRole.User, '继续'));
	ctx.addMessage(createMessage(MessageRole.User, '继续'));
	return ctx;
}

function testContextBoundaries(): void {
	console.log('\n[2] AgentContext enforces the invariant at the send boundary');

	const ctx = seedPoisonedContext();

	const window = ctx.getContextWindow();
	eq(pairingViolations(window).length, 0, 'getContextWindow() never returns an invalid history');
	ok(window.some(m => m.role === MessageRole.Tool && m.toolCallId === 'call_00_RJdPWD1xw3GZ8C44Z5b99363'),
		'the dangling tool call is answered in what is sent');
	ok(ctx.messages.every(m => m.role !== MessageRole.Tool),
		'getContextWindow() does not mutate the live history');

	const inserted = ctx.repairToolCallPairs();
	eq(inserted.length, 1, 'repairToolCallPairs() reports the synthesized answer');
	eq(pairingViolations(ctx.messages).length, 0, 'the live history is repaired in place');
	eq(ctx.repairToolCallPairs().length, 0, 'repairToolCallPairs() is idempotent');
}

// ---------------------------------------------------------------------------
// [3] END-TO-END: resuming a poisoned session
// ---------------------------------------------------------------------------

async function testResumingAPoisonedSession(): Promise<void> {
	console.log('\n[3] a poisoned saved session can be resumed (end-to-end)');

	const config = makeConfig();
	const provider = new CapturingProvider();
	const agent = new AgentLoop(
		config,
		provider,
		new ToolRegistry(),
		new AgentModeManager(),
		new AgentCheckpointManager({} as never),
		'/tmp',
	);

	// Replay exactly what the stuck session persisted, then ask the agent to
	// continue. Before the fix this request was the permanent 400.
	agent.restoreFromSession([
		createMessage(MessageRole.User, 'build it'),
		assistantWithCalls('call_00_RJdPWD1xw3GZ8C44Z5b99363'),
		createMessage(MessageRole.User, '继续'),
		createMessage(MessageRole.User, '继续'),
	], 'system');

	await agent.run('继续');

	ok(provider.requests.length >= 1, 'the model is actually called (no 400 short-circuit)');
	const sent = provider.requests[0];
	eq(pairingViolations(sent).length, 0, 'the request the model receives satisfies the API invariant');
	ok(sent.some(m => m.role === MessageRole.Tool && m.toolCallId === 'call_00_RJdPWD1xw3GZ8C44Z5b99363'),
		'the dangling tool call is answered before the request goes out');
	ok(sent.some(m => m.content === '继续'), 'the user continuation still reaches the model');

	agent.dispose();
}

// ---------------------------------------------------------------------------
// [4] exportSessionState never persists a dangling tool_calls
// ---------------------------------------------------------------------------

async function testExportRepairsTheHistory(): Promise<void> {
	console.log('\n[4] exportSessionState() heals what it is about to persist');

	const config = makeConfig();
	const provider = new CapturingProvider();
	const agent = new AgentLoop(
		config,
		provider,
		new ToolRegistry(),
		new AgentModeManager(),
		new AgentCheckpointManager({} as never),
		'/tmp',
	);
	agent.restoreFromSession([
		assistantWithCalls('call_x'),
	], 'system');

	// This is the gracefulExit() ordering: cancel() then save immediately —
	// no tool result for `call_x` exists yet.
	const state = agent.exportSessionState();
	eq(pairingViolations(state.messages).length, 0, 'the persisted snapshot is API-valid');
	eq(pairingViolations(agent.context.messages).length, 0, 'and so is the live history after export');

	agent.dispose();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	console.log(`tool-call pairing tests — node ${process.version}`);
	testSanitizer();
	testContextBoundaries();
	await testResumingAPoisonedSession();
	await testExportRepairsTheHistory();

	console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

void main();
