/*---------------------------------------------------------------------------------------------
 *  Unit tests: workspace scoping of shared L1 (atomic) memories.
 *
 *  Covers the rule requested for tdai_agent_mem:
 *    - L1 is tagged with the workspace directory (hub `task_id` + `[workspace:<dir>]` marker),
 *    - L1 is recalled only when the tag equals the current workspace dir or is an
 *      ancestor/descendant of it (parent/child recall each other),
 *    - sibling workspaces never see each other's L1,
 *    - L2/L3 stay unscoped.
 *
 *  Run:
 *    npx esbuild tests/memory-workspace.test.ts --bundle --platform=node --target=node18 \
 *      --format=esm --outfile=/tmp/memory-workspace.test.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/memory-workspace.test.mjs
 *--------------------------------------------------------------------------------------------*/

import * as http from 'node:http';
import * as path from 'node:path';
import { AddressInfo } from 'node:net';

import {
	MemoryClient,
	MemoryConfig,
	MemorySearchTool,
	MemoryWriteTool,
} from 'vs/workbench/contrib/agent/common/agentMemory';
import {
	workspaceRelation,
	isSubDir,
	isL1Visible,
	filterL1ByWorkspace,
	normalizeWorkspaceDir,
	extractWorkspaceFromText,
	workspaceTagOfItem,
	workspaceMarker,
	workspaceCandidateTags,
	parseWorkspaceScope,
} from 'vs/workbench/contrib/agent/common/agentMemoryWorkspace';

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string): void {
	if (cond) { console.log(`  PASS: ${msg}`); passed++; }
	else { console.error(`  FAIL: ${msg}`); failed++; }
}

function eq(actual: unknown, expected: unknown, msg: string): void {
	ok(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

// ---------------------------------------------------------------------------
// Pure rule tests
// ---------------------------------------------------------------------------

function testNormalize(): void {
	console.log('\n[1] directory normalisation + markers');
	eq(normalizeWorkspaceDir('/work/a/'), '/work/a', 'trailing slash removed');
	eq(normalizeWorkspaceDir('/work/a///'), '/work/a', 'repeated separators removed');
	eq(normalizeWorkspaceDir('/work/a/../b'), '/work/b', 'dot segments resolved');
	eq(normalizeWorkspaceDir('/'), '/', 'filesystem root kept');
	eq(normalizeWorkspaceDir(''), '', 'empty stays empty');
	eq(normalizeWorkspaceDir('   '), '', 'blank stays empty');

	eq(workspaceMarker('/work/a'), '[workspace:/work/a]', 'marker rendering');
	eq(workspaceMarker(''), '', 'no marker without a directory');
	eq(extractWorkspaceFromText('noise [workspace:/work/a] more'), '/work/a', 'marker parsed from text');
	eq(extractWorkspaceFromText('nothing here'), undefined, 'no marker -> undefined');

	eq(parseWorkspaceScope(undefined), 'strict', 'default scope is strict');
	eq(parseWorkspaceScope('LOOSE'), 'loose', 'scope parsing is case-insensitive');
	eq(parseWorkspaceScope('nonsense'), 'strict', 'unknown scope falls back to strict');
}

function testRelations(): void {
	console.log('\n[2] workspace relation (same / ancestor / descendant / sibling)');
	eq(workspaceRelation('/w/p', '/w/p'), 'same', 'identical directories');
	eq(workspaceRelation('/w', '/w/p/sub'), 'ancestor', 'parent recalls child dir');
	eq(workspaceRelation('/w/p/sub', '/w'), 'descendant', 'child dir recalls parent');
	eq(workspaceRelation('/w/p', '/w/q'), 'unrelated', 'siblings are unrelated');
	eq(workspaceRelation('/w/p', '/w/pq'), 'unrelated', 'prefix without separator is unrelated');
	eq(workspaceRelation(undefined, '/w/p'), 'unrelated', 'missing tag is unrelated');
	eq(workspaceRelation('/w/p', ''), 'unrelated', 'missing current dir is unrelated');

	ok(isSubDir('/w', '/w/p'), 'isSubDir parent->child');
	ok(isSubDir('/w', '/w'), 'isSubDir self');
	ok(!isSubDir('/w/p', '/w/pq'), 'isSubDir rejects non-separator prefix');

	const tags = workspaceCandidateTags('/w/p/sub');
	eq(tags.join(','), '/w/p/sub,/w/p,/w', 'candidate tags = cwd + ancestors (root excluded)');
	eq(workspaceCandidateTags('/').length, 0, 'root has no ancestor tags');
}

function testVisibility(): void {
	console.log('\n[3] L1 gate by tag carrier and scope');
	const cur = '/w/p';
	const note = (extra: Record<string, unknown>) => ({ id: 'x', type: 'instruction', content: 'c', ...extra });

	ok(isL1Visible(note({ task_id: '/w/p' }), cur, 'strict'), 'strict: same dir visible');
	ok(isL1Visible(note({ task_id: '/w' }), cur, 'strict'), 'strict: ancestor visible');
	ok(isL1Visible(note({ task_id: '/w/p/sub' }), cur, 'strict'), 'strict: descendant visible');
	ok(!isL1Visible(note({ task_id: '/w/q' }), cur, 'strict'), 'strict: sibling hidden');
	ok(!isL1Visible(note({ task_id: '/w/q/sub' }), cur, 'strict'), 'strict: sibling subtree hidden');
	ok(!isL1Visible(note({}), cur, 'strict'), 'strict: untagged hidden');
	ok(isL1Visible(note({}), cur, 'loose'), 'loose: untagged visible');
	ok(!isL1Visible(note({ task_id: '/w/q' }), cur, 'loose'), 'loose: sibling still hidden');
	ok(isL1Visible(note({ task_id: '/w/q' }), cur, 'off'), 'off: no filtering');

	ok(isL1Visible(note({ content: 'fact [workspace:/w/p]' }), cur, 'strict'), 'strict: content marker accepted');
	ok(isL1Visible(note({ background: 'ctx [workspace:/w]' }), cur, 'strict'), 'strict: background marker accepted');
	ok(!isL1Visible(note({ task_id: 'TSK-123', content: 'no marker' }), cur, 'strict'),
		'strict: a non-path task_id is not a workspace tag');
	ok(isL1Visible(note({ task_id: 'TSK-123', background: '[workspace:/w/p]' }), cur, 'strict'),
		'non-path task_id falls through to the marker');

	eq(workspaceTagOfItem({ task_id: '/w/p/' }), '/w/p', 'tag read from task_id, normalised');
	eq(workspaceTagOfItem({ content: '[workspace:/w/p]' }), '/w/p', 'tag read from content');
	eq(workspaceTagOfItem({}), undefined, 'untagged item');

	const batch = [
		{ id: 'a', task_id: '/w/p' },
		{ id: 'b', task_id: '/w/q' },
		{ id: 'c', task_id: '/w' },
	];
	eq(filterL1ByWorkspace(batch, cur, 'strict').map(b => b.id).join(','), 'a,c', 'batch filter keeps same+ancestor');
}

// ---------------------------------------------------------------------------
// Fake hub (real HTTP, mirrors the verified v3 surface)
// ---------------------------------------------------------------------------

interface FakeNote {
	id: string;
	content: string;
	type?: string;
	background?: string;
	task_id?: string;
	score?: number;
}

interface FakeRequest { path: string; body: Record<string, unknown> }

class FakeHub {
	readonly notes: FakeNote[];
	readonly requests: FakeRequest[] = [];
	private _server?: http.Server;
	port = 0;

	constructor(notes: FakeNote[]) {
		this.notes = notes;
	}

	async start(): Promise<void> {
		this._server = http.createServer((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				let body: Record<string, unknown> = {};
				try { body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}'); } catch { /* ignore */ }
				const pathname = (req.url || '').split('?')[0];
				this.requests.push({ path: pathname, body });
				const send = (payload: unknown, status = 200) => {
					const json = JSON.stringify(payload);
					res.writeHead(status, { 'Content-Type': 'application/json' });
					res.end(json);
				};
				switch (pathname) {
					case '/v3/atomic/search': {
						const q = String(body.query ?? '').toLowerCase();
						let items = this.notes.filter(n =>
							q === '' || q.split(/\s+/).some(tok => n.content.toLowerCase().includes(tok)));
						if (typeof body.task_id === 'string') {
							const want = body.task_id;
							items = items.filter(n => (n.task_id ?? '') === want);
						}
						const limit = typeof body.limit === 'number' ? body.limit : 5;
						return send({ code: 0, message: 'ok', data: { items: items.slice(0, limit) } });
					}
					case '/v3/atomic/update':
						return send({ code: 0, message: 'ok', data: { ok: true } });
					case '/v3/conversation/add':
						return send({ code: 0, message: 'ok', data: { accepted_ids: ['m1'] } });
					case '/v3/scenario/ls':
						return send({ code: 0, message: 'ok', data: { entries: [{ path: 'scenario.md', summary: 's' }] } });
					case '/v3/core/read':
						return send({ code: 0, message: 'ok', data: { content: '# persona' } });
					default:
						return send({ error: `Not found: ${pathname}` }, 404);
				}
			});
		});
		await new Promise<void>(resolve => this._server!.listen(0, '127.0.0.1', resolve));
		this.port = (this._server!.address() as AddressInfo).port;
	}

	async stop(): Promise<void> {
		await new Promise<void>(resolve => this._server?.close(() => resolve()));
	}

	searches(): FakeRequest[] {
		return this.requests.filter(r => r.path === '/v3/atomic/search');
	}
}

function makeConfig(port: number, over: Partial<MemoryConfig> = {}): MemoryConfig {
	return {
		enabled: true,
		endpoint: `http://127.0.0.1:${port}`,
		apiKey: 'sk-mem-test',
		serviceId: 'default',
		userKey: 'sk-mem-test',
		username: 'tester',
		teamId: 'team-t',
		agentId: 'agt-t',
		userId: 'usr-t',
		sessionId: '',
		recall: true,
		capture: true,
		workspaceDir: '',
		workspaceScope: 'strict',
		...over,
	};
}

const WS = path.resolve('/work/proj');
const OTHER = path.resolve('/work/other');

function scopedNotes(): FakeNote[] {
	return [
		{ id: 'same', content: 'alpha same workspace', task_id: WS, score: 0.9 },
		{ id: 'parent', content: 'alpha parent workspace', task_id: path.resolve('/work'), score: 0.8 },
		{ id: 'child', content: 'alpha child workspace', task_id: path.join(WS, 'sub'), score: 0.7 },
		{ id: 'sibling', content: 'alpha sibling workspace', task_id: OTHER, score: 0.6 },
		{ id: 'legacy', content: 'alpha untagged legacy note', score: 0.5 },
		{ id: 'siblingchild', content: 'alpha sibling child note', task_id: path.join(OTHER, 'sub'), score: 0.4 },
	];
}

async function testRecallScoping(): Promise<void> {
	console.log('\n[4] MemoryClient.recall — strict / loose / off');

	// --- strict ---
	let hub = new FakeHub(scopedNotes());
	await hub.start();
	try {
		const client = new MemoryClient(
			makeConfig(hub.port, { workspaceScope: 'strict' }),
			{ workspaceDir: WS },
		);
		const block = await client.recall('alpha');
		ok(!!block, 'recall returned a block');
		const text = block || '';
		ok(text.includes('alpha same workspace'), 'strict: same-dir memory recalled');
		ok(text.includes('alpha parent workspace'), 'strict: parent-dir memory recalled');
		ok(text.includes('alpha child workspace'), 'strict: child-dir memory recalled');
		ok(!text.includes('sibling workspace'), 'strict: sibling memory NOT recalled');
		ok(!text.includes('sibling child note'), 'strict: sibling subtree NOT recalled');
		ok(!text.includes('untagged legacy'), 'strict: untagged legacy memory NOT recalled');
		ok(text.includes('Shared Scenario Index'), 'L2 scenario index still recalled unscoped');
		ok(text.includes('<user-persona>'), 'L3 persona still recalled unscoped');

		const { hidden } = await client.searchL1Scoped('alpha', 5);
		eq(hidden, 3, 'three memories withheld (sibling, sibling child, untagged)');

		// Server-side scoping uses both the exact tag and the ancestor tags.
		const tagsQueried = hub.searches().map(r => r.body.task_id).filter(t => typeof t === 'string');
		ok(tagsQueried.includes(WS), 'an exact-tag query was issued for the current dir');
		ok(tagsQueried.includes(path.resolve('/work')), 'an ancestor-tag query was issued');
		ok(hub.searches().some(r => r.body.task_id === undefined), 'an unfiltered (over-fetch) query was issued');

		// Ordering: hub score decides, highest first.
		const { items } = await client.searchL1Scoped('alpha', 5);
		eq(items.map(i => i.id).join(','), 'same,parent,child', 'results ranked by hub score');
	} finally {
		await hub.stop();
	}

	// --- loose ---
	hub = new FakeHub(scopedNotes());
	await hub.start();
	try {
		const client = new MemoryClient(
			makeConfig(hub.port, { workspaceScope: 'loose' }),
			{ workspaceDir: WS },
		);
		const { items, hidden } = await client.searchL1Scoped('alpha', 6);
		const ids = items.map(i => i.id);
		ok(ids.includes('legacy'), 'loose: untagged legacy memory visible');
		ok(!ids.includes('sibling'), 'loose: sibling memory still hidden');
		eq(hidden, 2, 'loose: only the two sibling notes withheld');
	} finally {
		await hub.stop();
	}

	// --- off ---
	hub = new FakeHub(scopedNotes());
	await hub.start();
	try {
		const client = new MemoryClient(
			makeConfig(hub.port, { workspaceScope: 'off' }),
			{ workspaceDir: WS },
		);
		const block = await client.recall('alpha');
		ok(!!block && (block || '').includes('sibling workspace'), 'off: no workspace filtering at all');
		eq(hub.searches().length, 1, 'off: exactly one search request (no per-tag queries)');
	} finally {
		await hub.stop();
	}

	// --- workspace isolation is per current dir, not the hub's ---
	hub = new FakeHub(scopedNotes());
	await hub.start();
	try {
		const client = new MemoryClient(
			makeConfig(hub.port, { workspaceScope: 'strict' }),
			{ workspaceDir: OTHER },
		);
		const { items } = await client.searchL1Scoped('alpha', 6);
		const ids = items.map(i => i.id);
		ok(ids.includes('sibling') && ids.includes('siblingchild'), 'other workspace sees its own + its child');
		ok(!ids.includes('same'), 'other workspace does NOT see the first workspace\'s memory');
		ok(ids.includes('parent'), 'other workspace DOES see an ancestor-level workspace memory (parent recalls children)');
		ok(!ids.includes('child'), 'other workspace does NOT see a note from a sibling subtree');
	} finally {
		await hub.stop();
	}
}

async function testCaptureTagging(): Promise<void> {
	console.log('\n[5] MemoryClient.capture — L0 tagged with the workspace');
	const hub = new FakeHub([]);
	await hub.start();
	try {
		const client = new MemoryClient(makeConfig(hub.port), { workspaceDir: WS });
		await client.capture('do the thing', 'done');
		const req = hub.requests.find(r => r.path === '/v3/conversation/add');
		ok(!!req, 'conversation/add called');
		eq(req!.body.task_id, WS, 'L0 turn carries the workspace tag in task_id');
		const messages = req!.body.messages as Array<{ role: string; content: string }>;
		eq(messages[0].role, 'user', 'first captured message is the user turn');
		ok(messages[0].content.startsWith(workspaceMarker(WS)), 'user turn starts with the [workspace:...] marker');
		ok(messages[0].content.includes('do the thing'), 'the original task text is preserved');
		eq(messages[1].role, 'assistant', 'assistant turn captured too');

		// Scope off -> no tag anywhere.
		const clean = new MemoryClient(makeConfig(hub.port, { workspaceScope: 'off' }), { workspaceDir: WS });
		hub.requests.length = 0;
		await clean.capture('x', 'y');
		const req2 = hub.requests.find(r => r.path === '/v3/conversation/add')!;
		eq(req2.body.task_id, undefined, 'scope off: no task_id stamped');
		eq((req2.body.messages as Array<{ content: string }>)[0].content, 'x', 'scope off: task text untouched');
	} finally {
		await hub.stop();
	}
}

async function testTools(): Promise<void> {
	console.log('\n[6] tools honour the workspace scope');
	const hub = new FakeHub(scopedNotes());
	await hub.start();
	try {
		const client = new MemoryClient(makeConfig(hub.port), { workspaceDir: WS });

		const search = new MemorySearchTool(client);
		const res = await search.execute({ query: 'alpha', limit: 5 });
		ok(res.success, 'tdai_memory_search succeeded');
		ok(res.output.includes('same workspace'), 'search tool returns same-workspace memory');
		ok(!res.output.includes('sibling workspace'), 'search tool hides sibling memory');
		ok(/withheld/.test(res.output), 'search tool reports how many memories were withheld');

		const write = new MemoryWriteTool(client);
		const w = await write.execute({ layer: 'l1', id: 'note-1', content: 'fact', background: 'ctx' });
		ok(w.success, 'tdai_memory_write l1 succeeded');
		const upd = hub.requests.find(r => r.path === '/v3/atomic/update')!;
		eq(upd.body.id, 'note-1', 'update targets the given note');
		eq(upd.body.content, 'fact', 'content is written verbatim (no marker injected into content)');
		eq(upd.body.task_id, WS, 'L1 note tagged via task_id');
		ok(String(upd.body.background).includes(workspaceMarker(WS)), 'L1 note also carries the readable marker');
		ok(String(upd.body.background).includes('ctx'), 'original background preserved');
	} finally {
		await hub.stop();
	}
}

async function main(): Promise<void> {
	testNormalize();
	testRelations();
	testVisibility();
	await testRecallScoping();
	await testCaptureTagging();
	await testTools();

	console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'} — ${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
}

void main();
