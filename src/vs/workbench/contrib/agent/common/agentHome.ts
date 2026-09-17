/*---------------------------------------------------------------------------------------------
 *  Agent Home - user-level configuration & state directory
 *
 *  CodeAgent keeps its files in `~/.agent` (Claude-style) — that directory OWNS
 *  the configuration and the data (rules/skills/sessions/tasks). The previous
 *  location `~/.codeagent` is still READ and, on first start, an existing
 *  installation is migrated: config files are copied and the data directories
 *  are MOVED into `~/.agent`, leaving a symlink behind at the old path (plus
 *  companion links such as `~/.cursor/skills` re-pointed). Nothing is deleted,
 *  so the legacy directory can simply be removed in a later release.
 *
 *  Layout:
 *    ~/.agent/config.yaml | config.json   global configuration
 *    ~/.agent/models.json                 model definitions (CodeBuddy format)
 *    ~/.agent/mcp.json                    MCP servers
 *    ~/.agent/agent.md                    global instructions/rules (`CLAUDE.md` style)
 *    ~/.agent/rules/*.mdc                 reusable rules (may be a git repo)
 *    ~/.agent/skills/<name>/SKILL.md      reusable skills
 *    ~/.agent/sessions/, ~/.agent/tasks/  state
 *    <project>/.agent/agent.md            project instructions (loaded after the global one)
 *
 *  `~/.codeagent/<entry>` is kept only as a pointer to `~/.agent/<entry>`;
 *  `AGENT_HOME=<dir>` overrides the whole home.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Current user-level config directory name (`~/.agent`). */
export const AGENT_HOME_NAME = '.agent';
/** Previous user-level config directory name (`~/.codeagent`) — read + migrated. */
export const LEGACY_AGENT_HOME_NAME = '.codeagent';

/** Small configuration files: copied into the new home (`~/.agent`). */
const COPIED_ENTRIES = ['config.yaml', 'config.json', 'models.json', 'mcp.json', '.mcp.json', 'agent.md'];
/**
 * Directories that OWN real data. They are MOVED into the new home and the
 * legacy path is replaced by a symlink pointing back, so:
 *   - `~/.agent` is the single owner of the data (the only path that must
 *     survive), and
 *   - older code / other tools that still resolve `~/.codeagent/...` keep
 *     working, which makes the legacy directory safe to delete in a later
 *     version (`rm -rf ~/.codeagent`).
 */
const MOVED_ENTRIES = ['rules', 'skills', 'sessions', 'tasks'];
/**
 * Sibling tool directories that symlink into the agent home (Cursor /
 * CodeBuddy compatible layouts). A link pointing at the legacy home is
 * re-pointed at the new home so the legacy dir becomes deletable.
 */
const COMPANION_LINK_ROOTS = ['.cursor', '.codebuddy'];
const COMPANION_LINK_ENTRIES = ['skills', 'skills-cursor', 'rules'];

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
 * `~/.agent` becomes the OWNER of the data: the configuration files are copied
 * and the data directories (`rules`, `skills`, `sessions`, `tasks`) are MOVED
 * into it (a rename when possible — instant, no extra disk space). The legacy
 * path is then left as a symlink pointing back at the new home, and companion
 * links (`~/.cursor/skills`, `~/.codebuddy/rules`, …) are re-pointed, so
 * `~/.codeagent` can simply be deleted in a later version.
 *
 * Also repairs the previous layout, where the new home itself was the symlink
 * (flips it into a real directory). Nothing is ever deleted: on a filesystem
 * that cannot rename across the two homes the data is copied and the legacy
 * directory is kept as an extra copy.
 */
export function migrateLegacyAgentHome(log: (message: string) => void): void {
	if (agentHomeOverride()) return;
	migrateAgentHome(legacyAgentHomeDir(), newAgentHomeDir(), log);
	repointCompanionLinks(legacyAgentHomeDir(), newAgentHomeDir(), COMPANION_LINK_ROOTS.map(
		root => path.join(os.homedir(), root)
	), log);
}

/** Copy/move/link `legacy` → `fresh` (never deleting data). Returns entries handled. */
export function migrateAgentHome(legacy: string, fresh: string, log: (message: string) => void): number {
	try {
		if (!fs.existsSync(legacy)) return 0;
		const freshExisted = fs.existsSync(fresh);
		fs.mkdirSync(fresh, { recursive: true });

		let copied = 0;
		let moved = 0;
		let flipped = 0;
		let keptLegacy = 0;

		if (!freshExisted) {
			for (const entry of COPIED_ENTRIES) {
				const from = path.join(legacy, entry);
				if (!fs.existsSync(from) || isSymlink(from)) continue;
				const to = path.join(fresh, entry);
				if (fs.existsSync(to)) continue;
				fs.cpSync(from, to, { recursive: true });
				copied++;
			}
		}

		for (const entry of MOVED_ENTRIES) {
			const legacyPath = path.join(legacy, entry);
			const freshPath = path.join(fresh, entry);

			// Previous version left the NEW home as the link (fresh → legacy): flip it.
			if (isSymlink(freshPath)) {
				const target = fs.readlinkSync(freshPath);
				const resolved = path.resolve(path.dirname(freshPath), target);
				if (resolved.startsWith(legacy + path.sep)) {
					if (!fs.existsSync(legacyPath)) continue;      // broken link, nothing to flip
					fs.unlinkSync(freshPath);
					flipped++;
				} else {
					continue;                                       // linked elsewhere: leave it alone
				}
			}
			if (fs.existsSync(freshPath)) continue;                  // new home already owns it
			if (!fs.existsSync(legacyPath) || isSymlink(legacyPath)) continue;

			try {
				fs.renameSync(legacyPath, freshPath);                // same filesystem: instant
				moved++;
			} catch {
				fs.cpSync(legacyPath, freshPath, { recursive: true });
				copied++;
				keptLegacy++;                                        // keep the original as a copy
				continue;
			}
			try {
				fs.symlinkSync(freshPath, legacyPath, 'dir');        // old path keeps working
			} catch {
				// Symlinks unavailable — the legacy dir stays gone; nothing to do.
			}
		}

		const handled = copied + moved + flipped;
		if (handled > 0 || freshExisted === false) {
			log(
				`Config home: ${fresh} now owns the configuration ` +
				`(${moved} moved, ${copied} copied, ${flipped} links flipped` +
				`${keptLegacy > 0 ? `, ${keptLegacy} kept in ${legacy}` : ''}) — ` +
				`${legacy} is now a pointer and can be deleted`
			);
		}
		return handled;
	} catch (err) {
		// Migration must never block startup.
		log(`Config home: could not migrate ${legacy} → ${fresh}: ${(err as Error).message}`);
		return 0;
	}
}

function isSymlink(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Re-point companion symlinks (`~/.cursor/skills` → `~/.codeagent/skills`,
 * `~/.codebuddy/rules` → `~/.codeagent/rules`, …) at the new home, so nothing
 * depends on the legacy directory any more.
 */
export function repointCompanionLinks(
	legacy: string,
	fresh: string,
	roots: string[],
	log: (message: string) => void,
): number {
	let repointed = 0;
	for (const root of roots) {
		for (const entry of COMPANION_LINK_ENTRIES) {
			const linkPath = path.join(root, entry);
			if (!isSymlink(linkPath)) continue;
			try {
				const resolved = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
				if (!resolved.startsWith(legacy + path.sep)) continue;   // already points elsewhere
				const target = path.join(fresh, path.relative(legacy, resolved));
				if (!fs.existsSync(target)) continue;                    // new home has no such entry
				fs.unlinkSync(linkPath);
				fs.symlinkSync(target, linkPath, 'dir');
				repointed++;
				log(`Config home: re-pointed ${linkPath} → ${target}`);
			} catch {
				// A broken/unreadable link must never block startup.
			}
		}
	}
	return repointed;
}
