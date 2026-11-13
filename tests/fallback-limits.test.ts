/*---------------------------------------------------------------------------------------------
 *  Unit tests: the 保底 (fallback) model must survive the gateway's own limits
 *
 *  Two real failures, both reproduced against api.enflame.cn and both found in the
 *  task logs (45 runs fell back; 25 of them then failed):
 *
 *  1. `max_tokens is too large: 393216. This model supports at most 128000
 *     completion tokens` — `models.json` advertises maxOutputTokens 393216 for
 *     gpt-5.6-luna, but the gateway caps completion at 128000. `_clampMaxTokens`
 *     returns `min(maxOutputTokens, remaining)`, so a SHORT history sends the full
 *     393216 and the very first fallback request 400s. A longer history happens to
 *     clamp below the cap, which is why the fallback sometimes worked — the
 *     "几次" in the report.
 *
 *  2. `Unknown parameter: 'thinking'` — the fallback gateway does not implement
 *     the param. The provider already self-heals this, but the self-heal is
 *     instance state (`_skipThinking`), so it is re-learned on every new provider
 *     and every new process.
 *
 *  Both are "the model is fine, the request was wrong" failures: they must be
 *  repaired and retried, never surfaced as a dead task.
 *
 *  Run:
 *    npx esbuild tests/fallback-limits.test.ts --bundle --platform=node \
 *      --target=node18 --format=esm --outfile=/tmp/fb.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/fb.mjs
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import { OpenAIProvider, isUnknownThinkingParamError } from 'vs/workbench/services/agent/browser/llmOpenai';
import { IAgentConfig, IAgentMessage, MessageRole, createMessage } from 'vs/workbench/services/agent/common/agentModels';

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

/** The exact 400 body the gateway returns for an over-large completion budget. */
function maxTokensTooLarge(provided: number, cap: number): string {
	return JSON.stringify({
		error: {
			message: `max_tokens is too large: ${provided}. This model supports at most ${cap} completion tokens, whereas you provided ${provided}.`,
			type: 'invalid_request_error',
			param: 'max_tokens',
			code: 'invalid_value',
		},
	});
}

/** The exact 400 body for a gateway that does not implement `thinking`. */
const UNKNOWN_THINKING = JSON.stringify({
	error: {
		message: "Unknown parameter: 'thinking'.",
		type: 'invalid_request_error',
		param: 'thinking',
		code: 'unknown_parameter',
	},
});

interface SentBody {
	model: string;
	max_tokens: number;
	thinking?: unknown;
	messages: Array<{ role: string; content: string | null }>;
}

/**
 * A mock gateway that enforces a completion cap and (optionally) rejects the
 * `thinking` param, recording every request body it received.
 */
async function mockGateway(opts: {
	completionCap: number;
	rejectThinking?: boolean;
}): Promise<{ base: string; sent: SentBody[]; close: () => Promise<void> }> {
	const sent: SentBody[] = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', chunk => { raw += chunk; });
		req.on('end', () => {
			const body = JSON.parse(raw) as SentBody;
			sent.push(body);

			if (opts.rejectThinking && body.thinking !== undefined) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(UNKNOWN_THINKING);
				return;
			}
			if (body.max_tokens > opts.completionCap) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(maxTokensTooLarge(body.max_tokens, opts.completionCap));
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				choices: [{ message: { role: 'assistant', content: 'OK' } }],
				usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
			}));
		});
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	return {
		base: `http://127.0.0.1:${port}/v1`,
		sent,
		close: () => new Promise<void>(resolve => server.close(() => resolve())),
	};
}

function fallbackConfig(apiBase: string, overrides: Partial<IAgentConfig> = {}): IAgentConfig {
	return {
		provider: 'openai',
		model: 'gpt-5.6-luna',
		apiKey: 'test-key',
		apiBase,
		// The real models.json values: a 1M window and a 393216 completion budget,
		// while the gateway caps completion at 128000.
		maxContextTokens: 1_024_000,
		maxOutputTokens: 393_216,
		supportsReasoning: true,
		thinking: { type: 'enabled' },
		maxSteps: 4,
		temperature: 0,
		...overrides,
	} as IAgentConfig;
}

/** A short history — the case that sends the full (over-cap) completion budget. */
function shortHistory(): IAgentMessage[] {
	return [createMessage(MessageRole.User, 'say OK')];
}

// ---------------------------------------------------------------------------
// 1. The reported failure: an over-cap max_tokens must be repaired, not fatal
// ---------------------------------------------------------------------------
console.log('\n[fallback] max_tokens above the gateway cap is repaired');

{
	const gw = await mockGateway({ completionCap: 128_000 });
	try {
		const provider = new OpenAIProvider(fallbackConfig(gw.base));
		let error: string | undefined;
		let reply: IAgentMessage | undefined;
		try {
			reply = await provider.complete(shortHistory(), undefined, 0);
		} catch (err) {
			error = (err as Error).message;
		}

		ok(error === undefined, `the request succeeds instead of failing (${error ?? 'no error'})`);
		eq(reply?.content, 'OK', 'the fallback model answers');

		// The first attempt really did send the over-cap value — that is the bug.
		ok(gw.sent.length >= 2, `the provider retried after the 400 (${gw.sent.length} request(s))`);
		ok(gw.sent[0].max_tokens > 128_000,
			`the first attempt sent the over-cap budget (${gw.sent[0].max_tokens}) — this is the reported bug`);
		const last = gw.sent[gw.sent.length - 1];
		ok(last.max_tokens <= 128_000,
			`the retry respects the gateway cap (${last.max_tokens} <= 128000)`);
	} finally {
		await gw.close();
	}
}

{
	// The cap must be learned from the error, not hard-coded: a different gateway
	// with a different cap must also be satisfied.
	const gw = await mockGateway({ completionCap: 8_192 });
	try {
		const provider = new OpenAIProvider(fallbackConfig(gw.base));
		let error: string | undefined;
		try {
			await provider.complete(shortHistory(), undefined, 0);
		} catch (err) {
			error = (err as Error).message;
		}
		ok(error === undefined, `a different cap (8192) is also learned (${error ?? 'no error'})`);
		const last = gw.sent[gw.sent.length - 1];
		ok(last.max_tokens <= 8_192, `the retry fits the 8192 cap (${last.max_tokens})`);
	} finally {
		await gw.close();
	}
}

{
	// Once learned, the cap must stick: the next call must not re-send the bad value.
	const gw = await mockGateway({ completionCap: 128_000 });
	try {
		const provider = new OpenAIProvider(fallbackConfig(gw.base));
		await provider.complete(shortHistory(), undefined, 0);
		const afterFirst = gw.sent.length;
		await provider.complete(shortHistory(), undefined, 0);
		const secondCall = gw.sent.slice(afterFirst);
		eq(secondCall.length, 1, 'the second call needs only one request (the cap was remembered)');
		ok(secondCall[0].max_tokens <= 128_000,
			`the second call already respects the cap (${secondCall[0].max_tokens})`);
	} finally {
		await gw.close();
	}
}

// ---------------------------------------------------------------------------
// 2. The `thinking` param self-heal (already implemented — pinned here)
// ---------------------------------------------------------------------------
console.log('\n[fallback] an unsupported thinking param is dropped');

{
	const gw = await mockGateway({ completionCap: 128_000, rejectThinking: true });
	try {
		const provider = new OpenAIProvider(fallbackConfig(gw.base));
		let error: string | undefined;
		try {
			await provider.complete(shortHistory(), undefined, 0);
		} catch (err) {
			error = (err as Error).message;
		}
		ok(error === undefined, `the request succeeds without the param (${error ?? 'no error'})`);
		ok(gw.sent[0].thinking !== undefined, 'the first attempt did send thinking (the bug)');
		const last = gw.sent[gw.sent.length - 1];
		eq(last.thinking, undefined, 'the retry omits thinking');
	} finally {
		await gw.close();
	}
}

{
	// Both problems at once — the real gpt-5.6-luna situation.
	const gw = await mockGateway({ completionCap: 128_000, rejectThinking: true });
	try {
		const provider = new OpenAIProvider(fallbackConfig(gw.base));
		let error: string | undefined;
		let reply: IAgentMessage | undefined;
		try {
			reply = await provider.complete(shortHistory(), undefined, 0);
		} catch (err) {
			error = (err as Error).message;
		}
		ok(error === undefined, `both limits are repaired together (${error ?? 'no error'})`);
		eq(reply?.content, 'OK', 'the answer arrives');
		const last = gw.sent[gw.sent.length - 1];
		eq(last.thinking, undefined, 'the final request omits thinking');
		ok(last.max_tokens <= 128_000, `the final request fits the cap (${last.max_tokens})`);
	} finally {
		await gw.close();
	}
}

// ---------------------------------------------------------------------------
// 3. The error matcher
// ---------------------------------------------------------------------------
console.log('\n[fallback] error recognition');

{
	ok(isUnknownThinkingParamError(UNKNOWN_THINKING), 'the real thinking 400 is recognised');
	ok(!isUnknownThinkingParamError(maxTokensTooLarge(393216, 128000)),
		'a max_tokens 400 is NOT mistaken for a thinking problem');
	ok(!isUnknownThinkingParamError('{"error":{"message":"The `reasoning_content` in the thinking mode must be passed back to the API."}}'),
		'the reasoning echo-back 400 is NOT mistaken for an unknown param');
}

// ---------------------------------------------------------------------------
// 4. A genuinely fatal error must still fail (no infinite repair loop)
// ---------------------------------------------------------------------------
console.log('\n[fallback] unrelated errors still fail');

{
	const server = http.createServer((_req, res) => {
		res.writeHead(401, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	const port = (server.address() as { port: number }).port;
	try {
		const provider = new OpenAIProvider(fallbackConfig(`http://127.0.0.1:${port}/v1`));
		let error: string | undefined;
		try {
			await provider.complete(shortHistory(), undefined, 0);
		} catch (err) {
			error = (err as Error).message;
		}
		ok(error !== undefined, 'a 401 still fails the call');
		ok((error ?? '').includes('401'), 'the failure names the status');
	} finally {
		await new Promise<void>(resolve => server.close(() => resolve()));
	}
}

// ---------------------------------------------------------------------------
console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);