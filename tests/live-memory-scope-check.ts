/*
 * Live check: L1 workspace scoping against the real tdai_agent_mem hub.
 *
 * Prints, for the workspace passed on the command line (default: cwd):
 *   - the resolved scope + workspace tag,
 *   - the raw (unscoped) hub result count for a query,
 *   - what `strict` recalls (workspace-tagged only) vs `loose` (untagged kept visible).
 *
 * Read-only: it never writes to the hub. Run:
 *   npx esbuild tests/live-memory-scope-check.ts --bundle --platform=node --target=node18 \
 *     --format=esm --outfile=/tmp/live-memory-scope.mjs --tsconfig=tsconfig.json \
 *   && node /tmp/live-memory-scope.mjs [/abs/workspace] ["query"]
 */
import * as path from 'node:path';
import { MemoryClient, loadMemoryConfig } from 'vs/workbench/contrib/agent/common/agentMemory';

const workspace = path.resolve(process.argv[2] || process.cwd());
const query = process.argv[3] || 'triton 用户要求';

const config = loadMemoryConfig();
if (!config) {
	console.log('shared memory is not configured (no `memory:` section / mcp.json entry) — nothing to check');
	process.exit(0);
}

console.log(`endpoint  : ${config.endpoint}`);
console.log(`workspace : ${workspace}`);
console.log(`query     : ${JSON.stringify(query)}\n`);

for (const scope of ['strict', 'loose', 'off'] as const) {
	const client = new MemoryClient({ ...config, workspaceScope: scope }, { workspaceDir: workspace });
	const rawCount = (await client.searchAtomic(query, 10)).length;
	const { items, hidden } = await client.searchL1Scoped(query, 5);
	console.log(`--- scope=${scope} (tag ${client.workspaceTag || '(none)'}) ---`);
	console.log(`   raw hub hits: ${rawCount} | recalled: ${items.length} | withheld: ${hidden}`);
	for (const it of items) {
		console.log(`   * [${String(it.id)}] task_id=${JSON.stringify(it.task_id ?? '')} ${String(it.content).slice(0, 60).replace(/\n/g, ' ')}`);
	}
}
