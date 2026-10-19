/*---------------------------------------------------------------------------------------------
 *  Agent Storage - WHERE a run writes its state (sessions / task logs)
 *
 *  By default state lives inside the agent home (`~/.agent/sessions`,
 *  `~/.agent/tasks`). That is right for interactive use, but wrong for
 *  automated/benchmark runs: a benchmark that launches the CLI hundreds of
 *  times leaves hundreds of near-identical session files behind (on the author's
 *  machine: 2000+ sessions / 539 MB), which makes the real history unusable.
 *
 *  This module lets a run REDIRECT that state (or switch session writing off):
 *
 *    CLI (highest)   --state-dir <dir> | --sessions-dir <dir> | --tasks-dir <dir>
 *                    --no-session-save
 *    Environment     AGENT_STATE_DIR | AGENT_SESSIONS_DIR | AGENT_TASKS_DIR
 *                    AGENT_SAVE_SESSIONS=0|1
 *    config.yaml     storage:
 *                      state_dir: /tmp/bm-state      # base for sessions + tasks
 *                      sessions_dir: /tmp/bm-sessions
 *                      tasks_dir: /tmp/bm-tasks
 *                      save_sessions: false
 *    Default         sessions → <agent home>/sessions, tasks → <agent home>/tasks
 *
 *  Paths support `~` / `~/…` and are resolved against the CWD when relative.
 *
 *  Every consumer (AgentSessionManager, TaskLogManager) asks the getters below
 *  at CALL time rather than importing a constant: the CLI resolves the storage
 *  configuration after argument parsing (`--cwd` may still move the process).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { stripYamlComment } from './agentConfig';
import { agentHomeDir, agentHomeFileCandidates } from './agentHome';

/** `storage:` section of config.yaml. */
export interface StorageYamlSection {
	stateDir?: string;
	sessionsDir?: string;
	tasksDir?: string;
	saveSessions?: boolean;
}

/** Fully resolved storage settings (every value filled in). */
export interface StorageSettings {
	/** Base directory for state; the sessions/tasks dirs default to its children. */
	stateDir: string;
	sessionsDir: string;
	tasksDir: string;
	/** false → session files are never written (`--no-session-save`). */
	saveSessions: boolean;
	/** Where the non-default value came from, e.g. `cli --state-dir` (for logs/tests). */
	source: string;
}

/** CLI overrides (`--state-dir`, `--sessions-dir`, `--tasks-dir`, `--no-session-save`). */
export interface StorageOverrides {
	stateDir?: string;
	sessionsDir?: string;
	tasksDir?: string;
	saveSessions?: boolean;
}

const ENV_STATE_DIR = 'AGENT_STATE_DIR';
const ENV_SESSIONS_DIR = 'AGENT_SESSIONS_DIR';
const ENV_TASKS_DIR = 'AGENT_TASKS_DIR';
const ENV_SAVE_SESSIONS = 'AGENT_SAVE_SESSIONS';

/** Expand `~`, `~/…` and `${HOME}`; relative paths resolve against the CWD. */
export function expandStoragePath(input: string): string {
	const home = os.homedir();
	let out = input.trim();
	if (!out) return out;
	if (out === '~') out = home;
	else if (out.startsWith('~/')) out = path.join(home, out.slice(2));
	out = out.replace(/^\$\{HOME\}/, home);
	return path.resolve(out);
}

function truthy(raw: string | undefined): boolean | undefined {
	if (raw === undefined) return undefined;
	const value = raw.trim().toLowerCase();
	if (!value) return undefined;
	if (['1', 'true', 'yes', 'on'].includes(value)) return true;
	if (['0', 'false', 'no', 'off'].includes(value)) return false;
	return undefined;
}

/** Parse the `storage:` block of a config.yaml (other sections ignored). */
export function parseStorageYaml(text: string): StorageYamlSection {
	const out: StorageYamlSection = {};
	let inSection = false;

	for (const rawLine of text.split('\n')) {
		const line = rawLine.replace(/\s+$/, '');
		if (!line.trim() || line.trimStart().startsWith('#')) continue;

		const indent = line.length - line.trimStart().length;
		const trimmed = line.trim();

		if (indent === 0) {
			inSection = trimmed === 'storage:';
			continue;
		}
		if (!inSection) continue;

		const sep = trimmed.indexOf(':');
		if (sep < 0) continue;
		const key = trimmed.slice(0, sep).trim();
		const value = stripYamlComment(trimmed.slice(sep + 1)).trim().replace(/^["']|["']$/g, '');
		if (!value) continue;

		if (key === 'state_dir') out.stateDir = value;
		else if (key === 'sessions_dir') out.sessionsDir = value;
		else if (key === 'tasks_dir') out.tasksDir = value;
		else if (key === 'save_sessions') out.saveSessions = truthy(value);
	}
	return out;
}

/** `storage` object of a config.json (`{}` when absent/invalid). */
function storageFromJson(file: string, text: string): StorageYamlSection {
	try {
		const parsed = JSON.parse(text);
		const raw = parsed?.storage;
		if (!raw || typeof raw !== 'object') return {};
		const section: StorageYamlSection = { stateDir: raw.state_dir, sessionsDir: raw.sessions_dir, tasksDir: raw.tasks_dir, saveSessions: truthy(raw.save_sessions) };
		return section;
	} catch {
		return {};
	}
}

/**
 * First `storage:` section found, project config before the agent home (matches
 * how `tracing:` / `self_update:` are resolved elsewhere).
 */
export function loadStorageYamlSection(dirs?: { cwd?: string; home?: string }): StorageYamlSection {
	const cwd = dirs?.cwd ?? process.cwd();
	const files = [
		path.join(cwd, 'config.yaml'),
		path.join(cwd, 'config.json'),
		...(dirs?.home ? [path.join(dirs.home, 'config.yaml'), path.join(dirs.home, 'config.json')] : agentHomeFileCandidates('config.yaml').concat(agentHomeFileCandidates('config.json'))),
	];

	for (const file of files) {
		try {
			if (!fs.existsSync(file)) continue;
			const text = fs.readFileSync(file, 'utf-8');
			const section = file.endsWith('.json') ? storageFromJson(file, text) : parseStorageYaml(text);
			if (section.stateDir || section.sessionsDir || section.tasksDir || section.saveSessions !== undefined) {
				return section;
			}
		} catch {
			/* unreadable config: fall through to the next candidate */
		}
	}
	return {};
}

function firstDefined<T>(...values: Array<T | undefined>): { value: T | undefined; index: number } {
	for (let i = 0; i < values.length; i++) {
		if (values[i] !== undefined) return { value: values[i], index: i };
	}
	return { value: undefined, index: -1 };
}

const SOURCE_LABELS = ['cli flag', 'env var', 'config.yaml', 'default'];

/**
 * Resolve the effective storage settings.
 *
 * Precedence: CLI overrides → environment → config.yaml `storage:` → defaults
 * (`<agent home>/sessions`, `<agent home>/tasks`, session saving on).
 *
 * All inputs are injected so the resolution is testable without touching the
 * process environment or the user's real config.
 */
export function resolveStorageSettings(
	overrides: StorageOverrides = {},
	env: NodeJS.ProcessEnv = process.env,
	yaml: StorageYamlSection = loadStorageYamlSection(),
	home: string = agentHomeDir(),
): StorageSettings {
	const stateRaw = firstDefined(overrides.stateDir, env[ENV_STATE_DIR], yaml.stateDir);
	const baseDir = stateRaw.value ? expandStoragePath(stateRaw.value) : home;

	const sessionsRaw = firstDefined(overrides.sessionsDir, env[ENV_SESSIONS_DIR], yaml.sessionsDir);
	const tasksRaw = firstDefined(overrides.tasksDir, env[ENV_TASKS_DIR], yaml.tasksDir);

	const saveRaw = firstDefined(
		overrides.saveSessions,
		truthy(env[ENV_SAVE_SESSIONS]),
		yaml.saveSessions,
	);

	return {
		stateDir: baseDir,
		sessionsDir: sessionsRaw.value ? expandStoragePath(sessionsRaw.value) : path.join(baseDir, 'sessions'),
		tasksDir: tasksRaw.value ? expandStoragePath(tasksRaw.value) : path.join(baseDir, 'tasks'),
		saveSessions: saveRaw.value !== false,
		source: saveRaw.index === 0 || stateRaw.index === 0 || sessionsRaw.index === 0 || tasksRaw.index === 0
			? SOURCE_LABELS[0]
			: (stateRaw.index === 1 || sessionsRaw.index === 1 || tasksRaw.index === 1 || saveRaw.index === 1)
				? SOURCE_LABELS[1]
				: (stateRaw.index === 2 || sessionsRaw.index === 2 || tasksRaw.index === 2 || saveRaw.index === 2)
					? SOURCE_LABELS[2]
					: SOURCE_LABELS[3],
	};
}

let _active: StorageSettings | undefined;

/**
 * Resolve + activate the storage configuration. Called once by the CLI right
 * after argument parsing, so every later write (sessions, task logs) and the
 * `/sessions` listing use the same directories.
 */
export function configureStorage(overrides: StorageOverrides = {}): StorageSettings {
	_active = resolveStorageSettings(overrides);
	return _active;
}

/** The active settings, resolved on first use (mirrors `configureStorage`). */
export function storageSettings(): StorageSettings {
	return (_active ??= resolveStorageSettings());
}

/** Directory session files are written to / read from. */
export function sessionsDir(): string {
	return storageSettings().sessionsDir;
}

/** Directory task logs are written to / read from. */
export function tasksDir(): string {
	return storageSettings().tasksDir;
}

/** Whether session files should be written at all. */
export function saveSessionsEnabled(): boolean {
	return storageSettings().saveSessions;
}

/** Drop the cached settings (tests / a second configuration pass). */
export function resetStorageSettings(): void {
	_active = undefined;
}

/**
 * One-line description of a NON-default storage setup (undefined when the run
 * writes to the agent home exactly like an interactive session). Printed once so
 * a redirected run is never silent about where its logs went.
 */
export function storageNotice(settings: StorageSettings = storageSettings(), home: string = agentHomeDir()): string | undefined {
	const defaultSessions = path.join(home, 'sessions');
	const defaultTasks = path.join(home, 'tasks');
	const parts: string[] = [];
	if (settings.sessionsDir !== defaultSessions) parts.push(`sessions → ${settings.sessionsDir}`);
	if (settings.tasksDir !== defaultTasks) parts.push(`tasks → ${settings.tasksDir}`);
	if (!settings.saveSessions) parts.push('session saving OFF');
	if (parts.length === 0) return undefined;
	return `${parts.join(' | ')} (${settings.source})`;
}
