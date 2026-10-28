/*---------------------------------------------------------------------------------------------
 *  Agent Home - user-level configuration & state directory
 *
 *  CodeAgent keeps its files in `~/.agents` — the PLURAL directory is what the
 *  mainstream agent tooling has converged on (next to the `AGENTS.md` convention),
 *  so skills/rules written for other agents land in the same place. That
 *  directory OWNS the configuration and the data (rules/skills/sessions/tasks).
 *
 *  The previous locations are still READ and, on first start, an existing
 *  installation is migrated: config files are copied and the data directories are
 *  MOVED into `~/.agents`, leaving a symlink behind at the old path (plus
 *  companion links such as `~/.cursor/skills` re-pointed). Nothing is deleted, so
 *  a legacy directory can simply be removed in a later release.
 *
 *    ~/.agent       previous home (v0.3.37 … v0.3.52)  → migrated
 *    ~/.codeagent   original home (… v0.3.36)         → migrated
 *
 *  Layout:
 *    ~/.agents/config.yaml | config.json   global configuration
 *    ~/.agents/models.json                model definitions (CodeBuddy format)
 *    ~/.agents/mcp.json                   MCP servers
 *    ~/.agents/agent.md                   global instructions/rules (`CLAUDE.md` style)
 *    ~/.agents/rules/*.mdc                reusable rules (may be a git repo)
 *    ~/.agents/skills/<name>/SKILL.md     reusable skills
 *    ~/.agents/sessions/, ~/.agents/tasks/  state
 *    <project>/.agents/agent.md           project instructions (loaded after the global one)
 *    <project>/.agent/agent.md            previous project location, still read
 *
 *  `~/.agent/<entry>` and `~/.codeagent/<entry>` are kept only as pointers to
 *  `~/.agents/<entry>`; `AGENT_HOME=<dir>` overrides the whole home.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Current user-level config directory name (`~/.agents`, plural). */
export const AGENT_HOME_NAME = '.agents';
/** Project-level config directory name (`<project>/.agents`) — same name as the home. */
export const PROJECT_AGENT_HOME_NAME = AGENT_HOME_NAME;
/** Previous user-level config directory name (`~/.agent`) — read + migrated. */
export const PREVIOUS_AGENT_HOME_NAME = '.agent';
/** Original user-level config directory name (`~/.codeagent`) — read + migrated. */
export const LEGACY_AGENT_HOME_NAME = '.codeagent';

/** Small configuration files: copied into the new home (`~/.agents`). */
const COPIED_ENTRIES = ['config.yaml', 'config.json', 'models.json', 'mcp.json', '.mcp.json', 'agent.md'];
/**
 * Directories that OWN real data. They are MOVED into the new home and the
 * legacy path is replaced by a symlink pointing back, so:
 *   - `~/.agents` is the single owner of the data (the only path that must
 *     survive), and
 *   - older code / other tools that still resolve `~/.agent/...` (or the even
 *     older `~/.codeagent/...`) keep working, which makes the legacy directories
 *     safe to delete in a later version (`rm -rf ~/.agent ~/.codeagent`).
 */
const MOVED_ENTRIES = ['rules', 'skills', 'sessions', 'tasks'];
/**
 * Sibling tool directories that symlink into the agent home (Cursor /
 * CodeBuddy compatible layouts). A link pointing at a legacy home is
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

/**
 * Legacy homes, newest first: `~/.agent` (previous release) then `~/.codeagent`
 * (original location). Both are read, then migrated into `~/.agents`.
 */
export function legacyAgentHomeDirs(): string[] {
	const dirs = [
		path.join(os.homedir(), PREVIOUS_AGENT_HOME_NAME),
		path.join(os.homedir(), LEGACY_AGENT_HOME_NAME),
	];
	return dirs.filter((dir, i) => dirs.indexOf(dir) === i);
}

/** The most recent legacy home (`~/.agent`) — for callers that only need one. */
export function legacyAgentHomeDir(): string {
	return legacyAgentHomeDirs()[0];
}

/**
 * Directories that may hold configuration, most specific/newest first:
 * `~/.agents`, then the legacy `~/.agent` / `~/.codeagent`.
 *
 * An explicit `AGENT_HOME` is a FULL override — the legacy homes are then NOT
 * probed. Otherwise an isolated run (portable build, test, benchmark) would
 * silently pick up the real user configuration through `~/.agent/config.yaml`,
 * which is exactly what the override is meant to prevent.
 */
export function agentHomeDirs(): string[] {
	const override = agentHomeOverride();
	if (override) return [override];
	const dirs = [newAgentHomeDir(), ...legacyAgentHomeDirs()];
	return dirs.filter((dir, i) => dirs.indexOf(dir) === i);
}

/**
 * Directory this run writes NEW state to (sessions, tasks, memory).
 *
 * `~/.agents` wins as soon as it exists; until it does, an existing legacy home
 * keeps being used so a not-yet-migrated installation does not suddenly lose
 * sight of its sessions. `migrateLegacyAgentHome()` creates `~/.agents` on first
 * start, which moves the installation over for good.
 */
export function agentHomeDir(): string {
	const override = agentHomeOverride();
	if (override) return override;
	const fresh = newAgentHomeDir();
	if (fs.existsSync(fresh)) return fresh;
	const legacy = legacyAgentHomeDirs().find(dir => fs.existsSync(dir));
	return legacy ?? fresh;
}

/** Candidate paths for a home-relative file, newest location first. */
export function agentHomeFileCandidates(relative: string): string[] {
	return agentHomeDirs().map(dir => path.join(dir, relative));
}

/** First existing home-relative file (`~/.agents/x`, then the legacy homes). */
export function findAgentHomeFile(relative: string): string | undefined {
	return agentHomeFileCandidates(relative).find(p => fs.existsSync(p));
}

/**
 * Claude-style instruction files, in load order: the global `~/.agents/agent.md`,
 * its legacy equivalents, then `<project>/.agents/agent.md` followed by the
 * previous `<project>/.agent/agent.md`. Missing files are skipped by the caller.
 */
export function agentInstructionFiles(cwd: string = process.cwd()): string[] {
	const files = [
		...agentHomeDirs().map(dir => path.join(dir, 'agent.md')),
		path.join(cwd, PROJECT_AGENT_HOME_NAME, 'agent.md'),
		path.join(cwd, PREVIOUS_AGENT_HOME_NAME, 'agent.md'),
	];
	return files.filter((file, i) => files.indexOf(file) === i);
}

/**
 * One-time, idempotent move to `~/.agents`.
 *
 * `~/.agents` becomes the OWNER of the data: the configuration files are copied
 * and the data directories (`rules`, `skills`, `sessions`, `tasks`) are MOVED
 * into it (a rename when possible — instant, no extra disk space). Each legacy
 * path is then left as a symlink pointing back at the new home, and companion
 * links (`~/.cursor/skills`, `~/.codebuddy/rules`, …) are re-pointed, so the
 * legacy directories can simply be deleted in a later version.
 *
 * The legacy homes are visited newest first (`~/.agent` before `~/.codeagent`):
 * when both exist, the data under `~/.agent` is the more recent one and must win.
 *
 * Also repairs the previous layout, where the new home itself was the symlink
 * (flips it into a real directory). Nothing is ever deleted: on a filesystem
 * that cannot rename across the two homes the data is copied and the legacy
 * directory is kept as an extra copy.
 */
export function migrateLegacyAgentHome(log: (message: string) => void): void {
	if (agentHomeOverride()) return;
	const fresh = newAgentHomeDir();
	const companionRoots = COMPANION_LINK_ROOTS.map(root => path.join(os.homedir(), root));
	for (const legacy of legacyAgentHomeDirs()) {
		migrateAgentHome(legacy, fresh, log);
	}
	for (const legacy of legacyAgentHomeDirs()) {
		repointCompanionLinks(legacy, fresh, companionRoots, log);
	}
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
 * Re-point companion symlinks (`~/.cursor/skills` → `~/.agent/skills`,
 * `~/.codebuddy/rules` → `~/.codeagent/rules`, …) at the new home, so nothing
 * depends on a legacy directory any more.
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
