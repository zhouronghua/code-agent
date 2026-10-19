#!/usr/bin/env node
/**
 * End-to-end check for the state-dir redirect + tool mock (no real LLM).
 *
 * Starts a tiny OpenAI-compatible server on 127.0.0.1, then runs the built CLI
 * three times in separate temp workspaces:
 *
 *   run 1  --tool-mock record  → tool executes for real, fixtures + session +
 *                                task log land in the redirected state dir
 *   run 2  --tool-mock replay  → same tool output, no live read of the workspace
 *   run 3  --no-session-save   → no session file is written at all
 *
 * Verifies:
 *   1. nothing is written to ~/.agent/sessions or ~/.agent/tasks
 *   2. the session file + task log appear under --state-dir
 *   3. the fixture file appears and stores a {{WS}} token
 *   4. the FIRST read_file result of each run is identical modulo the workspace
 *      (a repeat call of the same path legitimately misses the single recorded
 *      entry and goes live — that is the documented self-healing behaviour)
 *
 * Run: npm run test:state-mock   (needs `npm run build` first)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { spawn } from 'node:child_process';

const CLI = path.resolve('build/agent-cli.js');
let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { console.log(`  PASS: ${msg}`); passed++; } else { console.error(`  FAIL: ${msg}`); failed++; } };

// ---- mock LLM: first turn asks for read_file, second turn finishes ----
function startServer(counter) {
	return new Promise(resolve => {
		const server = http.createServer((req, res) => {
			let body = '';
			req.on('data', c => { body += c; });
			req.on('end', () => {
				const payload = JSON.parse(body || '{}');
				counter.calls++;
				const hasToolResult = (payload.messages || []).some(m => m.role === 'tool');
				const message = hasToolResult
					? { role: 'assistant', content: 'DONE reading the file.' }
					: {
						role: 'assistant',
						content: '',
						tool_calls: [{
							id: `call_${counter.calls}`,
							type: 'function',
							function: { name: 'read_file', arguments: JSON.stringify({ path: counter.targetFile }) },
						}],
					};
				const out = {
					id: 'chatcmpl-mock',
					object: 'chat.completion',
					created: Math.floor(Date.now() / 1000),
					model: payload.model || 'mock',
					choices: [{ index: 0, message, finish_reason: hasToolResult ? 'stop' : 'tool_calls' }],
					usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				};
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify(out));
			});
		});
		server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
	});
}

function runCli(args, cwd, env) {
	return new Promise(resolve => {
		const child = spawn('node', [CLI, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
		let stdout = '';
		child.stdout.on('data', d => {
			stdout += d.toString();
			if (stdout.includes('--- Task completed ---')) setTimeout(() => { try { child.stdin.write('exit\n'); } catch { /* closed */ } }, 200);
		});
		child.stderr.on('data', d => { stdout += d.toString(); });
		const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 60_000);
		child.on('close', () => { clearTimeout(timer); resolve(stdout); });
	});
}

function newestFile(dir) {
	if (!fs.existsSync(dir)) return undefined;
	const files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
	if (files.length === 0) return undefined;
	files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
	return path.join(dir, files[0]);
}

const realSessions = path.join(os.homedir(), '.agent', 'sessions');
const realTasks = path.join(os.homedir(), '.agent', 'tasks');
const before = { s: new Set(fs.existsSync(realSessions) ? fs.readdirSync(realSessions) : []), t: new Set(fs.existsSync(realTasks) ? fs.readdirSync(realTasks) : []) };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-state-'));
const stateDir = path.join(root, 'state');
const fixture = path.join(root, 'fixture.json');
const counter = { calls: 0, targetFile: '' };

const { server, port } = await startServer(counter);
const env = {
	OPENAI_API_KEY: 'sk-mock',
	LLM_MODEL: 'mock-model',
	LLM_API_BASE: `http://127.0.0.1:${port}/v1`,
	AGENT_TOOL_MOCK_TOOLS: 'read',
};

function makeWorkspace(name, content) {
	const ws = path.join(root, name);
	fs.mkdirSync(ws, { recursive: true });
	fs.writeFileSync(path.join(ws, 'README.md'), content, 'utf-8');
	return ws;
}

try {
	// ---------- run 1: record ----------
	const wsA = makeWorkspace('ws-a', '# Workspace A\n');
	counter.targetFile = path.join(wsA, 'README.md');
	const out1 = await runCli(['--state-dir', stateDir, '--tool-mock', 'record', '--tool-mock-file', fixture, 'read the readme'], wsA, env);

	ok(out1.includes('[STORAGE]'), 'the run reports the storage redirect');
	ok(out1.includes('[MOCK]'), 'the run reports the tool mock mode');
	ok(fs.existsSync(fixture), 'the fixture file is created by the record run');
	ok(fs.readFileSync(fixture, 'utf-8').includes('{{WS}}'), 'the fixture stores the workspace token');

	const sessionFile = newestFile(path.join(stateDir, 'sessions'));
	ok(!!sessionFile, 'the session file lands in <state-dir>/sessions');
	const taskFile = newestFile(path.join(stateDir, 'tasks'));
	ok(!!taskFile, 'the task log lands in <state-dir>/tasks');

	const newSessions = fs.existsSync(realSessions) ? fs.readdirSync(realSessions).filter(f => !before.s.has(f)) : [];
	const newTasks = fs.existsSync(realTasks) ? fs.readdirSync(realTasks).filter(f => !before.t.has(f)) : [];
	ok(newSessions.length === 0, `no new session leaked into ~/.agent/sessions (${newSessions.length})`);
	ok(newTasks.length === 0, `no new task log leaked into ~/.agent/tasks (${newTasks.length})`);

	const log1 = JSON.parse(fs.readFileSync(taskFile, 'utf-8'));

	/**
	 * Mocked read_file results, keyed by tool + TOKENIZED arguments.
	 *
	 * Comparing the whole result stream would be wrong: the model is free to make
	 * a different NUMBER of read-only calls per run (and write/terminal calls keep
	 * running live on purpose). The invariant the mock guarantees is stronger and
	 * precise: same tool + same arguments ⇒ same result, regardless of workspace.
	 */
	const mockedResults = (log, ws) => {
		const map = new Map();
		for (const step of log.steps || []) {
			for (const exec of step.toolExecutions || []) {
				if (exec.toolName !== 'read_file') continue;
				const key = JSON.stringify(exec.arguments || {}).split(ws).join('{{WS}}');
				// FIRST occurrence per key only: the mock's contract is that the
				// N-th identical call consumes the N-th recorded entry, so a 2nd read
				// of the same path legitimately MISSES (and goes live + self-heals).
				if (!map.has(key)) map.set(key, String(exec.result || '').split(ws).join('{{WS}}'));
			}
		}
		return map;
	};

	const results1 = mockedResults(log1, wsA);
	const readmeKey = JSON.stringify({ path: '{{WS}}/README.md' });
	ok(results1.has(readmeKey), 'run 1 read README.md through the real tool');
	ok(String(results1.get(readmeKey)).includes('Workspace A'), 'the recorded tool output contains the real file content');

	// ---------- run 2: replay in a NEW workspace with DIFFERENT content ----------
	const wsB = makeWorkspace('ws-b', '# Workspace B (different content!)\n');
	counter.targetFile = path.join(wsB, 'README.md');
	const out2 = await runCli(['--state-dir', stateDir, '--tool-mock', 'replay', '--tool-mock-file', fixture, 'read the readme'], wsB, env);
	ok(out2.includes('replay'), 'the second run reports replay mode');

	const taskFiles = fs.readdirSync(path.join(stateDir, 'tasks')).filter(f => f.endsWith('.json') && !f.startsWith('_'));
	taskFiles.sort((a, b) => fs.statSync(path.join(stateDir, 'tasks', b)).mtimeMs - fs.statSync(path.join(stateDir, 'tasks', a)).mtimeMs);
	const log2 = JSON.parse(fs.readFileSync(path.join(stateDir, 'tasks', taskFiles[0]), 'utf-8'));
	const results2 = mockedResults(log2, wsB);
	if (process.env.DEBUG_E2E) {
		for (const st of log2.steps || []) for (const e of st.toolExecutions || []) {
			console.error(`      [run2] ${e.toolName} ${JSON.stringify(e.arguments)}`);
		}
		for (const st of log1.steps || []) for (const e of st.toolExecutions || []) {
			console.error(`      [run1] ${e.toolName} ${JSON.stringify(e.arguments)}`);
		}
	}
	ok(results2.has(readmeKey), 'run 2 read the SAME (tokenized) README.md path');

	const replayed = String(results2.get(readmeKey) || '');
	ok(replayed.includes('Workspace A'), 'replay returns the RECORDED content, not workspace B\'s real file');
	ok(!replayed.includes('Workspace B (different content!)'), 'the first (recorded) read did not touch the new workspace file');
	ok(replayed.includes('{{WS}}/README.md'), 'the replayed output is re-rooted at the new workspace');

	let mismatches = 0;
	for (const [key, value] of results2) {
		if (!results1.has(key)) continue;
		if (results1.get(key) !== value) {
			mismatches++;
			console.error(`      differing result for ${key}:\n        run1=${JSON.stringify(results1.get(key))}\n        run2=${JSON.stringify(value)}`);
		}
	}
	ok(mismatches === 0, 'every replayed tool result is byte-identical to the recording (modulo the workspace)');

	// ---------- run 3: --no-session-save ----------
	const wsC = makeWorkspace('ws-c', '# C\n');
	const sessionsBefore = fs.readdirSync(path.join(stateDir, 'sessions')).length;
	counter.targetFile = path.join(wsC, 'README.md');
	const out3 = await runCli(['--state-dir', stateDir, '--no-session-save', '--tool-mock', 'replay', '--tool-mock-file', fixture, 'read the readme'], wsC, env);
	ok(out3.includes('session saving OFF'), 'the run reports that session saving is off');
	const sessionsAfter = fs.readdirSync(path.join(stateDir, 'sessions')).length;
	ok(sessionsAfter === sessionsBefore, `no session file was written (${sessionsBefore} → ${sessionsAfter})`);
} finally {
	server.close();
	fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✓' : '✗'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
