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
	repointCompanionLinks,
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
	console.log('\n[2] legacy installation migration (the new home OWNS the data)');

	const legacy = tmpDir('legacy');
	const fresh = path.join(tmpDir('fresh-parent'), '.agent');
	fs.mkdirSync(path.join(legacy, 'sessions'), { recursive: true });
	fs.writeFileSync(path.join(legacy, 'sessions', 'session_1.json'), '{}');
	fs.writeFileSync(path.join(legacy, 'config.yaml'), 'active_profile: deepseek-flash\n');
	fs.writeFileSync(path.join(legacy, 'models.json'), '{"models":[]}');
	fs.mkdirSync(path.join(legacy, 'rules'));
	fs.writeFileSync(path.join(legacy, 'rules', 'a.mdc'), '# r');
	fs.mkdirSync(path.join(legacy, 'skills', 'demo'), { recursive: true });
	fs.writeFileSync(path.join(legacy, 'skills', 'demo', 'SKILL.md'), '# demo');

	const logs: string[] = [];
	const handled = migrateAgentHome(legacy, fresh, m => logs.push(m));
	ok(handled === 5, `config, models and the 3 data dirs are handled (${handled})`);

	// The new home owns REAL directories, the legacy path is only a pointer.
	for (const entry of ['rules', 'skills', 'sessions']) {
		ok(fs.existsSync(path.join(fresh, entry)), `${entry} lives in the new home`);
		ok(fs.lstatSync(path.join(fresh, entry)).isSymbolicLink() === false, `${entry} is a real directory there`);
		ok(fs.lstatSync(path.join(legacy, entry)).isSymbolicLink(), `${entry} in the legacy home is a symlink`);
	}
	eq(fs.readlinkSync(path.join(legacy, 'skills')), path.join(fresh, 'skills'), 'the legacy link points at the new home');
	ok(fs.existsSync(path.join(legacy, 'sessions', 'session_1.json')), 'old paths still resolve');
	ok(!fs.lstatSync(path.join(fresh, 'config.yaml')).isSymbolicLink(), 'config files are copied, not linked');
	ok(logs.some(l => l.includes('owns the configuration')), 'the migration is reported to the user');

	eq(migrateAgentHome(legacy, fresh, () => { /* noop */ }), 0, 'the migration is idempotent');

	// A home migrated by the PREVIOUS release (new home was the symlink) is flipped.
	const legacy2 = tmpDir('legacy2');
	const fresh2 = path.join(tmpDir('fresh2-parent'), '.agent');
	fs.mkdirSync(path.join(legacy2, 'sessions'), { recursive: true });
	fs.writeFileSync(path.join(legacy2, 'sessions', 's2.json'), '{}');
	fs.mkdirSync(fresh2, { recursive: true });
	fs.symlinkSync(path.join(legacy2, 'sessions'), path.join(fresh2, 'sessions'), 'dir');
	eq(migrateAgentHome(legacy2, fresh2, () => { /* noop */ }), 2, 'the old forward link is flipped (flip + move)');
	ok(!fs.lstatSync(path.join(fresh2, 'sessions')).isSymbolicLink(), 'the new home now owns the real directory');
	ok(fs.lstatSync(path.join(legacy2, 'sessions')).isSymbolicLink(), 'the legacy path became the pointer');
	ok(fs.existsSync(path.join(legacy2, 'sessions', 's2.json')), 'the flipped directory kept its data');

	// Companion links (Cursor / CodeBuddy layouts) follow the new home.
	const cwd = tmpDir('companions');
	const cursorDir = path.join(cwd, '.cursor');
	fs.mkdirSync(cursorDir, { recursive: true });
	fs.symlinkSync(path.join(legacy, 'skills'), path.join(cursorDir, 'skills'), 'dir');
	fs.writeFileSync(path.join(cursorDir, 'keep.txt'), 'untouched');
	const repointed = repointCompanionLinks(legacy, fresh, [cursorDir], () => { /* noop */ });
	eq(repointed, 1, 'a companion link into the legacy home is re-pointed');
	eq(fs.readlinkSync(path.join(cursorDir, 'skills')), path.join(fresh, 'skills'), 'it now points at the new home');
	ok(fs.existsSync(path.join(cursorDir, 'skills', 'demo', 'SKILL.md')), 'the skill is reachable through the link');
	eq(repointCompanionLinks(legacy, fresh, [cursorDir], () => { /* noop */ }), 0, 're-pointing is idempotent');

	fs.rmSync(cwd, { recursive: true, force: true });
	fs.rmSync(legacy, { recursive: true, force: true });
	fs.rmSync(legacy2, { recursive: true, force: true });
	fs.rmSync(path.dirname(fresh), { recursive: true, force: true });
	fs.rmSync(path.dirname(fresh2), { recursive: true, force: true });
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

function testSkillDiscovery(): void {
	console.log('\n[4] skill discovery (symlinks + YAML block scalars)');

	const dir = tmpDir('skills');
	const skillsDir = path.join(dir, 'skills');
	fs.mkdirSync(skillsDir, { recursive: true });

	// Plain skill with a quoted one-line description (existing style).
	const plain = path.join(skillsDir, 'plain');
	fs.mkdirSync(plain);
	fs.writeFileSync(path.join(plain, 'SKILL.md'),
		'---\nname: plain\ndescription: does a plain thing\ntrigger:\n  - plain\n  - simple\n---\n\n# Plain\n\nbody\n');

	// Skill written the way the official skill repos write it: a folded block
	// scalar whose value contains a colon and list-looking lines.
	const blocky = path.join(skillsDir, 'blocky');
	fs.mkdirSync(blocky);
	fs.writeFileSync(path.join(blocky, 'SKILL.md'), [
		'---',
		'name: blocky',
		'description: >-',
		'  Interact with blocky: tracing, monitoring, creating datasets,',
		'  and evaluating applications. Invoke it even when blocky',
		'  is not explicitly mentioned.',
		'allowed-tools:',
		'  - Bash(curl *blocky.com/*)',
		'-not-a-list-item',
		'---',
		'',
		'# Blocky',
		'',
		'body',
	].join('\n'));

	// A skill installed the documented way: a SYMLINK to a directory elsewhere.
	const external = path.join(dir, 'external', 'linked');
	fs.mkdirSync(external, { recursive: true });
	fs.writeFileSync(path.join(external, 'SKILL.md'),
		'---\nname: linked\ndescription: installed via symlink\n---\n\n# Linked\n\nbody\n');
	fs.symlinkSync(external, path.join(skillsDir, 'linked'), 'dir');

	// A dangling link must not break the scan.
	fs.symlinkSync(path.join(dir, 'does-not-exist'), path.join(skillsDir, 'dangling'), 'dir');

	const loader = new SkillsLoader();
	loader.loadSkillsFromDirs([skillsDir]);
	const names = loader.skills.map(s => s.name).sort();
	eq(names.join(','), 'blocky,linked,plain', 'every skill loads; a dangling symlink is skipped');

	const blockySkill = loader.skills.find(s => s.name === 'blocky')!;
	ok(blockySkill.description.startsWith('Interact with blocky: tracing'),
		`a ">-" block scalar becomes the description (got ${JSON.stringify(blockySkill.description.slice(0, 40))})`);
	ok(blockySkill.description.includes('not explicitly mentioned'),
		'the whole folded block is captured, not just the first line');
	ok(!blockySkill.description.includes('allowed-tools'),
		'the block stops at the next key at the same indent');
	eq(loader.skills.find(s => s.name === 'plain')?.description, 'does a plain thing',
		'a one-line description still parses unchanged');
	eq(loader.skills.find(s => s.name === 'linked')?.description, 'installed via symlink',
		'a symlinked skill directory is followed');

	const triggers = loader.skills.find(s => s.name === 'plain')?.triggers ?? [];
	eq(triggers.join(','), 'plain,simple', 'trigger list items still parse');

	fs.rmSync(dir, { recursive: true, force: true });
}

function main(): void {
	testHomeResolution();
	testLegacyMigration();
	testAgentMdRules();
	testSkillDiscovery();
	console.log(`\n${failed === 0 ? 'ALL TESTS PASSED' : 'TESTS FAILED'}: ${passed} passed, ${failed} failed`);
	process.exit(failed === 0 ? 0 : 1);
}

main();
