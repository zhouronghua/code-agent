/*---------------------------------------------------------------------------------------------
 *  Agent Home - user-level configuration & state directory
 *
 *  CodeAgent keeps its files in `~/.agent` (Claude-style). The previous location
 *  `~/.codeagent` is still READ, and an existing installation is migrated on
 *  first start (copy, never delete) so config, skills, sessions and task logs
 *  carry over.
 *
 *  Layout:
 *    ~/.agent/config.yaml | config.json   global configuration
 *    ~/.agent/models.json                 model definitions (CodeBuddy format)
 *    ~/.agent/mcp.json                    MCP servers
 *    ~/.agent/agent.md                    global instructions/rules (`CLAUDE.md` style)
 *    ~/.agent/rules/*.mdc                 reusable rules
 *    ~/.agent/skills/<name>/SKILL.md      reusable skills
 *    ~/.agent/sessions/, ~/.agent/tasks/  state
 *    <project>/.agent/agent.md            project instructions (loaded after the global one)
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Current user-level config directory name (`~/.agent`). */
export const AGENT_HOME_NAME = '.agent';
/** Previous user-level config directory name (`~/.codeagent`) — read + migrated. */
export const LEGACY_AGENT_HOME_NAME = '.codeagent';

/** Small configuration/knowledge entries: copied into the new home. */
const COPIED_ENTRIES = [
	'config.yaml', 'config.json', 'models.json', 'mcp.json', '.mcp.json', 'agent.md', 'rules',
];
/**
 * Potentially huge entries (skills / sessions / task logs). Linked instead of
 * copied so a 1 GB history is not duplicated; copied when linking is not
 * possible (e.g. a filesystem without symlink support).
 */
const LINKED_ENTRIES = ['skills', 'sessions', 'tasks'];

/** Explicit override (`AGENT_HOME` / `CODE_AGENT_HOME`) — portable builds + tests. */
function agentHomeOverride(): string | undefined {
	const dir = process.env.AGENT_HOME || process.env.CODE_AGENT_HOME;
	return dir ? path.resolve(dir) : undefined;
}

export function newAgentHomeDir(): string {
	return agentHomeOverride() || path.join(os.homedir(), AGENT_HOME_NAME);
}

export function legacyAgentHomeDir(): string {
	return path.join(os.homedir(), LEGACY_AGENT_HOME_NAME);
}

/**
 * Directories that may hold configuration, most specific/newest first:
 * the override, `~/.agent`, then the legacy `~/.codeagent`.
 */
export function agentHomeDirs(): string[] {
	const dirs = [newAgentHomeDir(), legacyAgentHomeDir()];
	return dirs.filter((dir, i) => dirs.indexOf(dir) === i);
}

/**
 * Directory this run writes NEW state to (sessions, tasks, memory).
 *
 * `~/.agent` wins as soon as it exists; until it does, an existing
 * `~/.codeagent` keeps being used so a not-yet-migrated installation does not
 * suddenly lose sight of its sessions. `migrateLegacyAgentHome()` creates
 * `~/.agent` on first start, which moves the installation over for good.
 */
export function agentHomeDir(): string {
	const override = agentHomeOverride();
	if (override) return override;
	const fresh = newAgentHomeDir();
	if (fs.existsSync(fresh)) return fresh;
	const legacy = legacyAgentHomeDir();
	if (fs.existsSync(legacy)) return legacy;
	return fresh;
}

/** Candidate paths for a home-relative file, newest location first. */
export function agentHomeFileCandidates(relative: string): string[] {
	return agentHomeDirs().map(dir => path.join(dir, relative));
}

/** First existing home-relative file (`~/.agent/x` then `~/.codeagent/x`). */
export function findAgentHomeFile(relative: string): string | undefined {
	return agentHomeFileCandidates(relative).find(p => fs.existsSync(p));
}

/**
 * Claude-style instruction files, in load order: the global `~/.agent/agent.md`,
 * its legacy equivalent, then `<project>/.agent/agent.md`. Missing files are
 * skipped by the caller.
 */
export function agentInstructionFiles(cwd: string = process.cwd()): string[] {
	return [
		path.join(newAgentHomeDir(), 'agent.md'),
		path.join(legacyAgentHomeDir(), 'agent.md'),
		path.join(cwd, '.agent', 'agent.md'),
	];
}

/**
 * One-time, idempotent move to `~/.agent`.
 *
 * Configuration + rules are copied, the big state directories (skills,
 * sessions, tasks) are LINKED so a multi-hundred-MB history is not duplicated.
 * The legacy directory is never deleted — it stays as the fallback the code
 * still reads, and the links keep working as long as it exists. No-op when
 * `~/.agent` already exists or there is nothing to move.
 */
export function migrateLegacyAgentHome(log: (message: string) => void): void {
	if (agentHomeOverride()) return;
	migrateAgentHome(legacyAgentHomeDir(), newAgentHomeDir(), log);
}

/** Copy/link `legacy` → `fresh` (never deleting anything). Returns entries handled. */
export function migrateAgentHome(legacy: string, fresh: string, log: (message: string) => void): number {
	try {
		if (fs.existsSync(fresh) || !fs.existsSync(legacy)) return 0;

		fs.mkdirSync(fresh, { recursive: true });
		let copied = 0;
		let linked = 0;
		for (const entry of COPIED_ENTRIES) {
			const from = path.join(legacy, entry);
			if (!fs.existsSync(from)) continue;
			const to = path.join(fresh, entry);
			if (fs.existsSync(to)) continue;
			fs.cpSync(from, to, { recursive: true });
			copied++;
		}
		for (const entry of LINKED_ENTRIES) {
			const from = path.join(legacy, entry);
			if (!fs.existsSync(from)) continue;
			const to = path.join(fresh, entry);
			if (fs.existsSync(to)) continue;
			try {
				fs.symlinkSync(from, to, 'dir');
				linked++;
			} catch {
				fs.cpSync(from, to, { recursive: true });   // symlinks unavailable → real copy
				copied++;
			}
		}
		log(
			`Config home: migrated ${legacy} → ${fresh} ` +
			`(${copied} copied, ${linked} linked — legacy kept as the fallback it links to)`
		);
		return copied + linked;
	} catch (err) {
		// Migration must never block startup.
		log(`Config home: could not migrate ${legacy} → ${fresh}: ${(err as Error).message}`);
		return 0;
	}
}
