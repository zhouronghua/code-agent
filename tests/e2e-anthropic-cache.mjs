#!/usr/bin/env node
/**
 * Install-level verification of the packaged bundle (not the TS sources):
 * run build/agent-cli.js against a mock Anthropic endpoint and assert the
 * request bodies really carry (a) prompt-cache breakpoints and (b) the pinned
 * original task. Scenario B replays a gateway that rejects cache_control.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { fileURLToPath } from 'node:url';
const CLI = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build', 'agent-cli.js');
const TASK = 'add a --dry-run flag to the deploy script and run its tests';

let failed = 0;
const ok = (cond, msg) => {
	console.log(`${cond ? '  PASS' : '  FAIL'}: ${msg}`);
	if (!cond) failed++;
};

const hasCacheControl = v => {
	if (!v || typeof v !== 'object') return false;
	if (Array.isArray(v)) return v.some(hasCacheControl);
	return Object.entries(v).some(([k, x]) => k === 'cache_control' || hasCacheControl(x));
};

/** Run the packaged CLI once against a mock endpoint. */
async function runCli({ rejectCaching }) {
	const requests = [];
	const server = http.createServer((req, res) => {
		let raw = '';
		req.on('data', c => { raw += c; });
		req.on('end', () => {
			let body = {};
			try { body = JSON.parse(raw); } catch { /* ignore */ }
			requests.push({ url: req.url, body });
			if (rejectCaching && hasCacheControl(body)) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({
					type: 'error',
					error: { type: 'invalid_request_error', message: 'unexpected field cache_control' },
				}));
				return;
			}
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({
				content: [{ type: 'text', text: 'Done: implemented the flag and ran the tests successfully.' }],
				usage: { input_tokens: 120, output_tokens: 12, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
			}));
		});
	});
	await new Promise(r => server.listen(0, '127.0.0.1', r));
	const port = server.address().port;

	const work = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-e2e-'));
	const home = path.join(work, 'home');
	fs.mkdirSync(home, { recursive: true });
	fs.writeFileSync(path.join(work, 'config.yaml'), [
		'active_profile: mock-anthropic',
		'agent:',
		'  max_steps: 6',
		'  max_context_tokens: 190000',
		'  temperature: 0',
		'  step_timeout: 60000',
		'  task_timeout: 180000',
		'skills: []',
		'rules: []',
		'profiles:',
		'  mock-anthropic:',
		'    provider: anthropic',
		'    model: claude-sonnet-4-20250514',
		'    api_key: test-key',
		'    api_base: http://127.0.0.1:' + port,
		'',
	].join('\n'));

	const env = { ...process.env, AGENT_HOME: home, NO_COLOR: '1', LANG: 'C.UTF-8' };
	delete env.ANTHROPIC_API_KEY;
	delete env.OPENAI_API_KEY;
	delete env.LLM_PROVIDER;
	delete env.LLM_MODEL;
	delete env.LLM_API_BASE;
	delete env.AGENT_PROFILE;

	const child = spawn(process.execPath, [CLI, '--profile', 'mock-anthropic', '--mode', 'agent', TASK], {
		cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'],
	});
	let out = '';
	child.stdout.on('data', d => { out += d; });
	child.stderr.on('data', d => { out += d; });
	const code = await new Promise(r => child.on('close', r));
	await new Promise(r => server.close(r));
	fs.rmSync(work, { recursive: true, force: true });
	return { code, requests, out };
}

// --- scenario A: a normal Anthropic-shaped endpoint -------------------------
console.log('\n[A] packaged CLI sends cache breakpoints + the pinned task');
{
	const { code, requests } = await runCli({ rejectCaching: false });
	console.log(`cli exit=${code} requests=${requests.length}`);
	ok(code === 0, 'the packaged CLI finished the task');
	ok(requests.length >= 1, 'the packaged CLI reached the mock Anthropic endpoint');
	ok(requests.every(r => r.url === '/v1/messages'), 'requests go to the Anthropic Messages API');

	const first = requests[0]?.body || {};
	ok(Array.isArray(first.system), 'the system prompt is sent as a content-block array (cacheable)');
	ok(!!first.system?.[0]?.cache_control, 'the system prompt carries cache_control');
	const marked = (first.messages || []).filter(m =>
		(Array.isArray(m.content) ? m.content : []).some(b => b && b.cache_control));
	ok(marked.length >= 1, `at least one conversation message carries a cache breakpoint (${marked.length})`);

	const allText = JSON.stringify(requests.map(r => r.body));
	ok(allText.includes('Pinned original task'), 'the pinned original task is present in the requests');
	ok(allText.includes(TASK), 'the pinned task keeps the user wording');
}

// --- scenario B: a gateway that rejects cache_control ----------------------
console.log('\n[B] a gateway that rejects cache_control does not break the CLI');
{
	const { code, requests, out } = await runCli({ rejectCaching: true });
	console.log(`cli exit=${code} requests=${requests.length}`);
	ok(code === 0, 'the task still succeeds after the cache retry');
	ok(requests.length >= 2, `a cache-free retry was made (${requests.length} requests)`);
	ok(hasCacheControl(requests[0].body), 'the first attempt did carry cache breakpoints');
	const afterFirst = requests.slice(1);
	ok(
		afterFirst.every(r => !hasCacheControl(r.body)),
		'every later request is cache-free (caching stays off)',
	);
	ok(/rejected prompt caching/.test(out), 'the degrade decision is reported to the user');
}

console.log(failed === 0 ? '\nE2E PASSED' : '\nE2E FAILED');
process.exit(failed === 0 ? 0 : 1);
