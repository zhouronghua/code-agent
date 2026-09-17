/*---------------------------------------------------------------------------------------------
 *  Unit tests: agent home (config dir `~/.agent` + legacy `~/.codeagent`),
 *  migration of an existing installation, and Claude-style `agent.md` rules.
 *
 *  Run:
 *    npx esbuild tests/agent-home.test.ts --bundle --platform=node --target=node18 \
 *      --format=esm --outfile=/tmp/agent-home.test.mjs --tsconfig=tsconfig.json \
 *    && node /tmp/agent-home.test.mjs
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	AGENT_HOME_NAME,
	LEGACY_AGENT_HOME_NAME,
	agentHomeDir,
	agentHomeFileCandidates,
	agentInstructionFiles,
	migrateAgentHome,
	findAgentHomeFile,
	newAgentHomeDir,
} from 'vs/workbench/contrib/agent/common/agentHome';
import { SkillsLoader } from 'vs/workbench/contrib/agent/common/agentSkills';

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string): void {
	if (cond) { console.log(`  PASS: ${msg}`); passed++; }
	else { console.error(`  FAIL: ${msg}`); failed++; }
}

function eq(actual: unknown, expected: unknown, msg: string): void {
	ok(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function tmpDir(name: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), `agent-home-${name}-`));
}

function testHomeResolution(): void {
	console.log('\n[1] config home resolution');

	const home = os.homedir();
	eq(AGENT_HOME_NAME, '.agent', 'the new config directory is .agent');
	eq(LEGACY_AGENT_HOME_NAME, '.codeagent', 'the legacy config directory is still recognised');
	eq(newAgentHomeDir(), path.join(home, '.agent'), '`~/.agent` is the new home');

	// The legacy location is still probed, after the new one.
	const candidates = agentHomeFileCandidates('config.yaml');
	eq(candidates[0], path.join(home, '.agent', 'config.yaml'), 'the new home is searched first');
	ok(candidates.some(p => p.includes(LEGACY_AGENT_HOME_NAME)), 'the legacy home is still searched');

	const override = tmpDir('override');
	const previous = process.env.AGENT_HOME;
	process.env.AGENT_HOME = override;
	try {
		fs.writeFileSync(path.join(override, 'config.yaml'), 'active_profile: x\n');
		eq(agentHomeDir(), override, 'AGENT_HOME overrides the home directory');
		eq(findAgentHomeFile('config.yaml'), path.join(override, 'config.yaml'),
			'a home-relative file resolves inside the override');
		const files = agentInstructionFiles('/work/project');
		ok(files.includes(path.join(override, 'agent.md')), 'the global agent.md comes from the home directory');
		ok(files.includes(path.join('/work/project', '.agent', 'agent.md')), 'a project agent.md is picked up too');
	} finally {
		if (previous === undefined) delete process.env.AGENT_HOME;
		else process.env.AGENT_HOME = previous;
		fs.rmSync(override, { recursive: true, force: true });
	}
}

function testLegacyMigration(): void {
	console.log('\n[2] legacy installation migration');

	const legacy = tmpDir('legacy');
	const fresh = path.join(tmpDir('fresh-parent'), '.agent');
	fs.mkdirSync(path.join(legacy, 'sessions'), { recursive: true });
	fs.writeFileSync(path.join(legacy, 'sessions', 'session_1.json'), '{}');
	fs.writeFileSync(path.join(legacy, 'config.yaml'), 'active_profile: deepseek-flash\n');
	fs.writeFileSync(path.join(legacy, 'models.json'), '{"models":[]}');
	fs.mkdirSync(path.join(legacy, 'rules'));
	fs.writeFileSync(path.join(legacy, 'rules', 'a.mdc'), '# r');

	const logs: string[] = [];
	const handled = migrateAgentHome(legacy, fresh, m => logs.push(m));
	eq(handled, 4, 'config, models, rules and sessions are handled');
	ok(fs.existsSync(path.join(fresh, 'config.yaml')), 'config.yaml moved to the new home');
	ok(fs.existsSync(path.join(fresh, 'sessions', 'session_1.json')), 'sessions are reachable from the new home');
	ok(fs.existsSync(path.join(legacy, 'config.yaml')), 'the legacy directory is left untouched');
	ok(logs.some(l => l.includes('migrated')), 'the migration is reported to the user');

	eq(migrateAgentHome(legacy, fresh, () => { /* noop */ }), 0, 'the migration is idempotent');
	fs.rmSync(legacy, { recursive: true, force: true });
	fs.rmSync(path.dirname(fresh), { recursive: true, force: true });
}

function testAgentMdRules(): void {
	console.log('\n[3] Claude-style agent.md instructions');

	const dir = tmpDir('agentmd');
	const globalMd = path.join(dir, 'agent.md');
	fs.writeFileSync(globalMd, '# 全局规则\n\n总是先跑测试。\n');
	const projectDir = path.join(dir, 'project', '.agent');
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, 'agent.md'), '---\ndescription: project rules\n---\n\n提交前先 build。\n');

	const loader = new SkillsLoader();
	loader.loadAgentMdFiles([globalMd, path.join(projectDir, 'agent.md'), path.join(dir, 'missing.md')]);
	eq(loader.rules.length, 2, 'both instruction files load, a missing one is skipped');
	ok(loader.rules.every(r => r.alwaysApply), 'agent.md instructions are always active');
	ok(loader.rules[0].content.includes('总是先跑测试'), 'the global instructions content is kept');
	ok(loader.rules[0].description.startsWith('agent.md instructions'), 'the description falls back to the heading');
	eq(loader.rules[1].description, 'project rules', 'frontmatter description wins when present');

	// A full preload renders like every other rule.
	const section = loader.buildPreloadRulesPromptSection();
	ok(section.includes('项目') === false && section.includes('project rules'), 'instructions render in the rules section');

	// `.mdc` rule directories keep working alongside agent.md.
	const rulesDir = path.join(dir, 'rules');
	fs.mkdirSync(rulesDir);
	fs.writeFileSync(path.join(rulesDir, 'legacy.mdc'), '---\nalwaysApply: true\ndescription: legacy rule\n---\n\nlegacy body\n');
	loader.loadRulesFromDirs([rulesDir]);
	ok(loader.rules.some(r => r.description === 'legacy rule'), 'a .mdc rule still loads next to agent.md');

	// Host-specific exclusions match the rule IDENTITY (file/description), never the
	// body: agent.md mentions the IDE-only rule by name, and that must not knock the
	// whole instruction file out of the CLI prompt.
	const hostLoader = new SkillsLoader();
	fs.mkdirSync(path.join(dir, 'ide'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'ide', 'durable-request.mdc'),
		'---\nalwaysApply: true\ndescription: AskQuestion at the end of every turn\n---\n\nAsk it.\n');
	fs.writeFileSync(path.join(dir, 'mentions.md'),
		'# 全局规则\n\n仅 IDE 使用的规则（如 durable-request.mdc）仍以 .mdc 保留。\n');
	hostLoader.loadRulesFromDirs([path.join(dir, 'ide')]);
	hostLoader.loadAgentMdFiles([path.join(dir, 'mentions.md')]);
	const filtered = hostLoader.buildPreloadRulesPromptSection(['askquestion', 'durable-request']);
	ok(!filtered.includes('Ask it.'), 'the host-specific rule is excluded');
	ok(filtered.includes('仍以 .mdc 保留'), 'an instruction file merely mentioning it survives');

	fs.rmSync(dir, { recursive: true, force: true });
}

function main(): void {
	testHomeResolution();
	testLegacyMigration();
	testAgentMdRules();
	console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

main();
