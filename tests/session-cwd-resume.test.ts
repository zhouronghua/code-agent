/*---------------------------------------------------------------------------------------------
 *  Unit tests: `--resume` without an argument resumes the latest session IN THE
 *  CURRENT WORKING DIRECTORY.
 *
 *  The bug: `getLatestSession()` compared `updatedAt` across the WHOLE store, so
 *  `--resume` in repo A could resume a session from repo B. On the author's
 *  machine that store held 2163 sessions across 1550 distinct working
 *  directories, so "the most recent session" was almost never the one the user
 *  wanted and `--resume` became a jump into an unrelated project — strictly
 *  worse than `/sessions` + `/resume <id>`.
 *
 *  The index also never recorded `workingDirectory`, and on the same store only
 *  952 of 2163 session files were indexed at all, so neither "filter the index"
 *  nor "trust the index to be complete" is enough. The contract these tests pin:
 *
 *    1. cwd match wins over recency — a newer session elsewhere is NOT picked
 *    2. deleted / missing working directory does not count as the current dir
 *    3. the index is untrusted: files outside it are still found
 *    4. sessions with NO recorded workingDirectory are never silently matched
 *    5. `--session <id>` still works regardless of directory
 *    6. ties / corrupt files fail safe
 *
 *  Run:
 *    npx esbuild tests/session-cwd-resume.test.ts --bundle --platform=node \
 *      --target=node18 --format=esm --outfile=/tmp/sess.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/sess.mjs
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentSessionManager } from 'vs/workbench/contrib/agent/common/agentSessions';
import { MessageRole, createMessage } from 'vs/workbench/services/agent/common/agentModels';

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

const roots: string[] = [];
/** The manager's 2nd ctor arg is the directory that directly contains the .json files. */
function sessionsDirOf(store: string): string {
	return path.join(store, 'sessions');
}
function tmpStore(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-resume-'));
	roots.push(dir);
	fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true });
	return dir;
}

/**
 * Save a session with an explicit working directory and updatedAt, so ordering is
 * deterministic instead of depending on how fast the test runs.
 */
function save(
	store: string,
	id: string,
	workingDirectory: string | undefined,
	updatedAt: number,
): void {
	const session = {
		id,
		name: id,
		mode: 'agent',
		messages: [createMessage(MessageRole.User, `task in ${workingDirectory ?? '(none)'}`)],
		workingDirectory,
		createdAt: updatedAt,
		updatedAt,
		messageCount: 1,
		summary: `summary ${id}`,
	};
	fs.writeFileSync(path.join(store, 'sessions', `${id}.json`), JSON.stringify(session), 'utf-8');
}

/** Rewrite the index to exactly the given ids (index metadata only). */
function writeIndex(store: string, entries: Array<{ id: string; updatedAt: number }>): void {
	const index: Record<string, unknown> = {};
	for (const { id, updatedAt } of entries) {
		// NB: mirrors the real index, which historically did NOT store
		// workingDirectory — the reason recency alone was directory-blind.
		index[id] = { name: id, mode: 'agent', createdAt: updatedAt, updatedAt, messageCount: 1 };
	}
	fs.writeFileSync(path.join(store, 'sessions', '_index.json'), JSON.stringify(index), 'utf-8');
}

// ---------------------------------------------------------------------------
// 1. The reported bug: newer session in another directory must not win
// ---------------------------------------------------------------------------
console.log('\n[cwd-resume] the current working directory wins over recency');

{
	const store = tmpStore();
	const cwd = path.join(store, 'repo-a');
	const other = path.join(store, 'repo-b');
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(other, { recursive: true });

	const base = Date.now();
	// Mine is OLD; the unrelated one is NEW.
	save(store, 'session_mine', cwd, base - 60000);
	save(store, 'session_other', other, base);
	writeIndex(store, [
		{ id: 'session_mine', updatedAt: base - 60000 },
		{ id: 'session_other', updatedAt: base },
	]);

	const manager = new AgentSessionManager(cwd, sessionsDirOf(store));
	const picked = manager.getLatestSessionForCwd(cwd);
	eq(picked?.id, 'session_mine', 'the session from the current directory is picked, not the newer stranger');

	// The old behaviour is the bug: it is still there under its own name, and it
	// really would have returned the other directory's session.
	eq(manager.getLatestSession()?.id, 'session_other',
		'the global latest is still the newest overall (that was the bug)');
}

// ---------------------------------------------------------------------------
// 2. Filters that must not be mistaken for "here"
// ---------------------------------------------------------------------------
console.log('\n[cwd-resume] only a real match counts as here');

{
	const store = tmpStore();
	const cwd = path.join(store, 'repo-a');
	fs.mkdirSync(cwd, { recursive: true });
	const base = Date.now();

	save(store, 'session_here', cwd, base - 120000);
	save(store, 'session_gone', path.join(store, 'deleted-dir'), base - 60000);
	save(store, 'session_unknown', undefined, base);
	writeIndex(store, [
		{ id: 'session_here', updatedAt: base - 120000 },
		{ id: 'session_gone', updatedAt: base - 60000 },
		{ id: 'session_unknown', updatedAt: base },
	]);

	const manager = new AgentSessionManager(cwd, sessionsDirOf(store));
	eq(manager.getLatestSessionForCwd(cwd)?.id, 'session_here',
		'a deleted directory and a missing workingDirectory are both skipped');
}

{
	// Trailing slash / relative spelling of the same directory must still match.
	const store = tmpStore();
	const cwd = path.join(store, 'repo-a');
	fs.mkdirSync(cwd, { recursive: true });
	save(store, 'session_slash', cwd + path.sep, Date.now());
	writeIndex(store, [{ id: 'session_slash', updatedAt: Date.now() }]);

	const manager = new AgentSessionManager(cwd, sessionsDirOf(store));
	eq(manager.getLatestSessionForCwd(cwd)?.id, 'session_slash',
		'a trailing separator in the stored path still matches');
}

// ---------------------------------------------------------------------------
// 3. The index is not authoritative
// ---------------------------------------------------------------------------
console.log('\n[cwd-resume] files missing from the index are still found');

{
	const store = tmpStore();
	const cwd = path.join(store, 'repo-a');
	fs.mkdirSync(cwd, { recursive: true });
	const base = Date.now();

	// Only a session in another directory is indexed. The one we want exists on
	// disk but is absent from the index — the state of 1211 of 2163 files on the
	// author's machine.
	save(store, 'session_indexed', path.join(store, 'elsewhere'), base);
	save(store, 'session_orphan', cwd, base - 1000);
	writeIndex(store, [{ id: 'session_indexed', updatedAt: base }]);

	const manager = new AgentSessionManager(cwd, sessionsDirOf(store));
	eq(manager.getLatestSessionForCwd(cwd)?.id, 'session_orphan',
		'a session file outside the index is still eligible');
}

// ---------------------------------------------------------------------------
// 4. Within one directory, the most recent wins
// ---------------------------------------------------------------------------
console.log('\n[cwd-resume] most recent within the directory');

{
	const store = tmpStore();
	const cwd = path.join(store, 'repo-a');
	fs.mkdirSync(cwd, { recursive: true });
	const base = Date.now();
	save(store, 'session_old', cwd, base - 60000);
	save(store, 'session_mid', cwd, base - 30000);
	save(store, 'session_new', cwd, base);
	writeIndex(store, [
		{ id: 'session_old', updatedAt: base - 60000 },
		{ id: 'session_mid', updatedAt: base - 30000 },
		{ id: 'session_new', updatedAt: base },
	]);

	const manager = new AgentSessionManager(cwd, sessionsDirOf(store));
	eq(manager.getLatestSessionForCwd(cwd)?.id, 'session_new',
		'the newest session in this directory is picked');
	// Ordering in the index must not matter.
	writeIndex(store, [
		{ id: 'session_new', updatedAt: base },
		{ id: 'session_old', updatedAt: base - 60000 },
		{ id: 'session_mid', updatedAt: base - 30000 },
	]);
	const manager2 = new AgentSessionManager(cwd, sessionsDirOf(store));
	eq(manager2.getLatestSessionForCwd(cwd)?.id, 'session_new',
		'the result does not depend on index order');
}

// ---------------------------------------------------------------------------
// 5. Fallbacks
// ---------------------------------------------------------------------------
console.log('\n[cwd-resume] fallbacks');

{
	// No session for this directory at all -> undefined, so the caller can say so
	// instead of silently resuming an unrelated project.
	const store = tmpStore();
	const cwd = path.join(store, 'repo-a');
	fs.mkdirSync(cwd, { recursive: true });
	save(store, 'session_elsewhere', path.join(store, 'repo-b'), Date.now());
	writeIndex(store, [{ id: 'session_elsewhere', updatedAt: Date.now() }]);

	const manager = new AgentSessionManager(cwd, sessionsDirOf(store));
	eq(manager.getLatestSessionForCwd(cwd), undefined,
		'no session in this directory yields undefined, never a stranger');
}

{
	// A corrupt file must not crash the scan.
	const store = tmpStore();
	const cwd = path.join(store, 'repo-a');
	fs.mkdirSync(cwd, { recursive: true });
	save(store, 'session_good', cwd, Date.now() - 1000);
	fs.writeFileSync(path.join(store, 'sessions', 'session_broken.json'), '{not json', 'utf-8');
	writeIndex(store, []);

	const manager = new AgentSessionManager(cwd, sessionsDirOf(store));
	eq(manager.getLatestSessionForCwd(cwd)?.id, 'session_good',
		'a corrupt session file is skipped, not fatal');
}

{
	// An empty store must not throw.
	const store = tmpStore();
	const emptyCwd = path.join(store, 'repo-a');
	const manager = new AgentSessionManager(emptyCwd, sessionsDirOf(store));
	eq(manager.getLatestSessionForCwd(emptyCwd), undefined,
		'an empty store yields undefined');
}

{
	// `--session <id>` is directory-independent: an explicit id always loads.
	const store = tmpStore();
	const cwd = path.join(store, 'repo-a');
	fs.mkdirSync(cwd, { recursive: true });
	save(store, 'session_explicit', path.join(store, 'somewhere-else'), Date.now());
	writeIndex(store, [{ id: 'session_explicit', updatedAt: Date.now() }]);

	const manager = new AgentSessionManager(cwd, sessionsDirOf(store));
	eq(manager.loadSession('session_explicit')?.id, 'session_explicit',
		'an explicit --session id still loads regardless of directory');
}

// ---------------------------------------------------------------------------
// 6. Summarising what was skipped, for an honest startup message
// ---------------------------------------------------------------------------
console.log('\n[cwd-resume] the miss explains itself');

{
	const store = tmpStore();
	const cwd = path.join(store, 'repo-a');
	fs.mkdirSync(cwd, { recursive: true });
	const base = Date.now();
	save(store, 'session_here', cwd, base - 60000);
	save(store, 'session_other', path.join(store, 'repo-b'), base);
	writeIndex(store, [
		{ id: 'session_here', updatedAt: base - 60000 },
		{ id: 'session_other', updatedAt: base },
	]);

	const manager = new AgentSessionManager(cwd, sessionsDirOf(store));
	const all = manager.listSessions();
	eq(all.length, 2, 'the full listing still spans every directory');
	const forCwd = manager.listSessionsForCwd(cwd);
	eq(forCwd.length, 1, 'the cwd listing is scoped to this directory');
	eq(forCwd[0].id, 'session_here', 'the scoped listing names the right session');
}

// ---------------------------------------------------------------------------
for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);