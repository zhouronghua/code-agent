/*---------------------------------------------------------------------------------------------
 *  Agent Session Manager - Persist and resume agent conversation sessions
 *
 *  Features:
 *  - Auto-save after each run
 *  - Manual save with custom name
 *  - List sessions with metadata (mode, message count, timestamps)
 *  - Resume a previous session with full context restoration
 *  - Delete sessions
 *  - Storage: <sessions dir>/ as JSON files — `<agent home>/sessions` (~/.agents)
 *    unless the run redirected it (`--sessions-dir` / `--state-dir`, see
 *    agentStorage.ts). The directory is resolved per call so automated runs can
 *    point their session dumps somewhere else than the real history.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { AgentMode, IAgentMessage, IAgentPlan, IAgentSession, MessageRole } from 'vs/workbench/services/agent/common/agentModels';
import { sessionsDir as resolveSessionsDir } from './agentStorage';

const INDEX_FILE = '_index.json';

/**
 * Sidecar index: `id → { dir, updatedAt }` for EVERY session file on disk.
 *
 * WHY IT EXISTS
 * Deciding "the latest session in this directory" from `_index.json` is impossible:
 * the index never stored `workingDirectory`, and it is not even complete (on the
 * author's machine 952 of 2163 files were indexed). Reading session files directly
 * answers it correctly but costs ~570 ms for one lookup and ~2.9 s to list a
 * directory — session files average ~110 KB, so a 2000-session store is 233 MB of
 * JSON to parse.
 *
 * This sidecar is the cheap answer: one pass records the ONLY two fields a
 * directory query needs, and every later query is a pure in-memory filter.
 *
 * Freshness: it is rebuilt lazily when `version` is unknown or when a session file
 * exists without an entry (i.e. after an interrupted run or an older build wrote
 * files). `saveSession` / `deleteSession` keep it current so the steady state
 * never rebuilds.
 */
const CWD_INDEX_FILE = '_cwd_index.json';
const CWD_INDEX_VERSION = 1;

/**
 * Extract one JSON field's raw value from a session file WITHOUT parsing it.
 *
 * WHY NOT `JSON.parse`
 * A rebuild has to visit every session file, and the only fields it needs are
 * `workingDirectory` (one string) and `updatedAt` (one number). Parsing the whole
 * document costs 2820 ms on a 592 MB store and dominates everything else; an
 * in-place byte scan of the same store takes 532 ms and yields identical values
 * (verified against a full parse). Session files are written by JSON.stringify, so
 * both keys appear exactly once, un-escaped, as plain `"key": value`.
 *
 * @param buffer - the raw file bytes (never decoded to a string).
 * @param key - the JSON key INCLUDING its quotes, e.g. `"workingDirectory"`.
 * @param wantString - read a JSON string value (true) or a number (false).
 * @returns the value, or `null` when the key/value is absent or malformed.
 */
function scanJsonField(buffer: Buffer, key: Buffer, wantString: boolean): string | number | null {
	const at = buffer.indexOf(key);
	if (at < 0) return null;

	let p = at + key.length;
	// Skip the `:` separating key and value, plus any insignificant whitespace.
	while (p < buffer.length) {
		const c = buffer[p];
		if (c === 0x3a || c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) p++;
		else break;
	}

	if (wantString) {
		if (buffer[p] !== 0x22) return null; // not a string
		const start = ++p;
		// Walk to the closing quote, stepping over backslash escapes.
		while (p < buffer.length && buffer[p] !== 0x22) {
			p += buffer[p] === 0x5c ? 2 : 1;
		}
		if (p >= buffer.length) return null; // unterminated
		const raw = buffer.slice(start, p).toString('utf8');
		// A pre-stringify path cannot contain escapes; if it does, the document is
		// not what this scan assumes, so fall back rather than return a mangled path.
		return raw.includes('\\') ? null : raw;
	}

	const start = p;
	while (p < buffer.length && buffer[p] >= 0x30 && buffer[p] <= 0x39) p++;
	if (p === start) return null;
	return Number(buffer.slice(start, p).toString());
}

const WORKING_DIR_KEY = Buffer.from('"workingDirectory"');
const UPDATED_AT_KEY = Buffer.from('"updatedAt"');

function scanSessionFile(file: string): { dir: string; updatedAt: number } | undefined {
	let buffer: Buffer;
	try {
		buffer = fs.readFileSync(file);
	} catch {
		return undefined;
	}
	const dir = scanJsonField(buffer, WORKING_DIR_KEY, true);
	const updatedAt = scanJsonField(buffer, UPDATED_AT_KEY, false);
	if (typeof updatedAt !== 'number') return undefined;
	return {
		dir: typeof dir === 'string' && dir.length > 0 ? AgentSessionManager._normDir(dir) : '',
		updatedAt,
	};
}

/** One sidecar row: where a session belongs and when it was last written. */
interface CwdIndexEntry {
	/** Recorded working directory; empty when the session has none. */
	dir: string;
	/** Session `updatedAt` (falls back to the file mtime). */
	updatedAt: number;
}

interface CwdIndexFile {
	version: number;
	entries: Record<string, CwdIndexEntry>;
}

interface SessionIndex {
	[id: string]: {
		name: string;
		mode: AgentMode;
		createdAt: number;
		updatedAt: number;
		messageCount: number;
		summary?: string;
	};
}

export class AgentSessionManager {
	private _index: SessionIndex = {};
	private _indexLoaded = false;
	/**
	 * In-memory copy of the cwd sidecar. Without it every tab completion and every
	 * `/sessions` read the sidecar from disk; with it, repeated queries during one
	 * session are free.
	 */
	private _cwdEntries: Record<string, CwdIndexEntry> | undefined;

	constructor(private _workingDirectory: string = process.cwd(), private readonly _dirOverride?: string) { }

	/**
	 * Directory this manager reads/writes.
	 *
	 * Resolved per call (not at import time) so `--sessions-dir` / `--state-dir`
	 * / `AGENT_SESSIONS_DIR` redirect the store without the CLI having to thread a
	 * path through every caller.
	 */
	private get _dir(): string {
		return this._dirOverride ?? resolveSessionsDir();
	}

	/**
	 * Ensure sessions directory exists and load index.
	 */
	private _ensureDir(): void {
		if (!fs.existsSync(this._dir)) {
			fs.mkdirSync(this._dir, { recursive: true });
		}
	}

	private _loadIndex(): void {
		if (this._indexLoaded) return;
		this._ensureDir();
		const indexPath = path.join(this._dir, INDEX_FILE);
		if (fs.existsSync(indexPath)) {
			try {
				this._index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
			} catch {
				this._index = {};
			}
		}
		this._indexLoaded = true;
	}

	private _saveIndex(): void {
		this._ensureDir();
		const indexPath = path.join(this._dir, INDEX_FILE);
		fs.writeFileSync(indexPath, JSON.stringify(this._index, null, 2), 'utf-8');
	}

	/**
	 * Save the current agent state as a session.
	 */
	saveSession(
		id: string,
		name: string,
		mode: AgentMode,
		messages: IAgentMessage[],
		systemPrompt?: string,
		extraSystemPrompt?: string,
		plan?: IAgentPlan,
	): IAgentSession {
		this._loadIndex();

		const now = Date.now();
		const session: IAgentSession = {
			id,
			name,
			mode,
			messages,
			systemPrompt,
			extraSystemPrompt,
			workingDirectory: this._workingDirectory,
			plan,
			createdAt: this._index[id]?.createdAt || now,
			updatedAt: now,
			messageCount: messages.length,
			summary: this._extractSummary(messages),
		};

		// Save session data file
		this._ensureDir();
		const sessionPath = path.join(this._dir, `${id}.json`);
		fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf-8');

		// Update index
		this._index[id] = {
			name: session.name,
			mode: session.mode,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			messageCount: session.messageCount,
			summary: session.summary,
		};
		this._saveIndex();

		// Keep the cwd sidecar current, so the next `--resume` sees THIS session
		// without a rebuild (an interrupted run leaves a file with no row, which the
		// staleness check would otherwise turn into a full rescan).
		this._touchCwdIndex(id, session.workingDirectory, session.updatedAt);

		return session;
	}

	/**
	 * Load a session by ID.
	 */
	loadSession(id: string): IAgentSession | undefined {
		this._loadIndex();
		const sessionPath = path.join(this._dir, `${id}.json`);
		if (!fs.existsSync(sessionPath)) {
			return undefined;
		}
		try {
			const data = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
			return data as IAgentSession;
		} catch {
			return undefined;
		}
	}

	/**
	 * Get the most recent session (by updatedAt) across the WHOLE store.
	 *
	 * This is directory-blind: it is right for `/sessions` (which lists everything)
	 * and for an explicit `--session <id>` lookup, but it is the WRONG default for a
	 * bare `--resume`. On the author's machine the store held 2163 sessions across
	 * 1550 distinct working directories, so "the most recent session" was usually a
	 * different project. Use {@link getLatestSessionForCwd} for `--resume`.
	 */
	getLatestSession(): IAgentSession | undefined {
		this._loadIndex();
		// The sidecar covers EVERY session file, while `_index.json` is partial (952
		// of 2163 on the author's machine), so it is the better recency source here
		// too. Fall back to the index only if the sidecar is unavailable.
		let latestId: string | undefined;
		let latestTime = -1;
		for (const [id, entry] of Object.entries(this._cwdIndex())) {
			if (entry.updatedAt > latestTime) {
				latestTime = entry.updatedAt;
				latestId = id;
			}
		}
		if (latestId === undefined) {
			const ids = Object.keys(this._index);
			if (ids.length === 0) return undefined;
			let fallbackId = ids[0];
			let fallbackTime = this._index[fallbackId]?.updatedAt || 0;
			for (const id of ids) {
				const t = this._index[id]?.updatedAt || 0;
				if (t > fallbackTime) {
					fallbackTime = t;
					fallbackId = id;
				}
			}
			latestId = fallbackId;
		}
		return this.loadSession(latestId);
	}

	/**
	 * Every session on disk as `{ id, dir, updatedAt }`, served from the sidecar.
	 *
	 * The sidecar is the difference between "usable" and "unusable" here: a raw file
	 * scan parses every session JSON (~110 KB each) to learn one string per session,
	 * which cost 570 ms per lookup and 2.9 s per directory listing on a 2163-session
	 * store. After the one-time build, every query below is an in-memory filter.
	 */
	private _cwdIndex(): Record<string, CwdIndexEntry> {
		if (this._cwdEntries) return this._cwdEntries;

		this._loadIndex();
		const indexPath = path.join(this._dir, CWD_INDEX_FILE);
		let entries: Record<string, CwdIndexEntry> | undefined;

		if (fs.existsSync(indexPath)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf-8')) as CwdIndexFile;
				if (parsed.version === CWD_INDEX_VERSION && parsed.entries && typeof parsed.entries === 'object') {
					entries = parsed.entries;
				}
			} catch {
				// Corrupt sidecar: rebuild below.
			}
		}

		if (entries === undefined || this._cwdIndexIsStale(entries)) {
			entries = this._rebuildCwdIndex();
		}
		this._cwdEntries = entries;
		return entries;
	}

	/**
	 * Cheap staleness check: does any session file exist without a sidecar row?
	 *
	 * Uses `readdirSync` only (no file reads). An interrupted run leaves a session
	 * file behind with no row, which is exactly what this catches — so the very next
	 * `--resume` sees the session it wrote.
	 */
	private _cwdIndexIsStale(entries: Record<string, CwdIndexEntry>): boolean {
		let names: string[];
		try {
			names = fs.readdirSync(this._dir);
		} catch {
			return false;
		}
		for (const name of names) {
			if (!name.endsWith('.json') || name === INDEX_FILE || name === CWD_INDEX_FILE) continue;
			if (!(name.slice(0, -'.json'.length) in entries)) return true;
		}
		return false;
	}

	/**
	 * Build the sidecar from every session file. Runs at most once on a store that
	 * predates the sidecar (or after an interrupted run), then stays current via
	 * `saveSession` / `deleteSession`.
	 *
	 * Uses the targeted byte scan rather than `JSON.parse` — see `scanJsonField` for
	 * the measurement that motivated it (532 ms vs 2820 ms on a 592 MB store).
	 */
	private _rebuildCwdIndex(): Record<string, CwdIndexEntry> {
		const entries: Record<string, CwdIndexEntry> = {};
		let names: string[];
		try {
			names = fs.readdirSync(this._dir);
		} catch {
			return entries;
		}
		for (const name of names) {
			if (!name.endsWith('.json') || name === INDEX_FILE || name === CWD_INDEX_FILE) continue;
			const id = name.slice(0, -'.json'.length);
			const scanned = scanSessionFile(path.join(this._dir, name));
			if (!scanned) continue;
			entries[id] = { dir: scanned.dir, updatedAt: scanned.updatedAt };
		}
		this._writeCwdIndex(entries);
		return entries;
	}

	/** Persist the sidecar (best effort: a failure only costs a later rebuild). */
	private _writeCwdIndex(entries: Record<string, CwdIndexEntry>): void {
		try {
			this._ensureDir();
			const payload: CwdIndexFile = { version: CWD_INDEX_VERSION, entries };
			fs.writeFileSync(path.join(this._dir, CWD_INDEX_FILE), JSON.stringify(payload), 'utf-8');
		} catch {
			// Read-only store or a concurrent writer: the in-memory map still works.
		}
	}

	/** Record / refresh one session's sidecar row (called on save). */
	private _touchCwdIndex(id: string, workingDirectory: string | undefined, updatedAt: number): void {
		const entries = this._cwdIndex();
		entries[id] = { dir: this._normDirOf(workingDirectory), updatedAt };
		this._writeCwdIndex(entries);
	}

	/** Drop one session's sidecar row (called on delete). */
	private _dropFromCwdIndex(id: string): void {
		const entries = this._cwdIndex();
		if (!(id in entries)) return;
		delete entries[id];
		this._writeCwdIndex(entries);
	}

	/** Resolve + normalize one working directory, or `''` when it is unusable. */
	private _normDirOf(workingDirectory: string | undefined): string {
		if (typeof workingDirectory !== 'string' || workingDirectory.length === 0) return '';
		return AgentSessionManager._normDir(workingDirectory);
	}

	/**
	 * Normalized form used to compare working directories.
	 *
	 * `path.resolve` collapses `..`, relative spellings and duplicate separators;
	 * the trailing-separator trim makes `/repo/` and `/repo` the same place.
	 */
	static _normDir(dir: string): string {
		let out = path.resolve(dir);
		while (out.length > 1 && (out.endsWith(path.sep) || out.endsWith('/'))) {
			out = out.slice(0, -1);
		}
		return out;
	}

	/**
	 * The most recent session whose recorded working directory is `workingDirectory`.
	 *
	 * The correct default for a bare `--resume`: a session belongs to the project it
	 * was created in, so resuming stays inside the current directory instead of
	 * jumping into whichever project the user touched last.
	 *
	 * O(n) over a small in-memory map, so it is cheap enough for the tab completer.
	 *
	 * @param workingDirectory - directory to match (defaults to the manager's).
	 * @returns the session, or undefined when this directory has none — NEVER a
	 *   session from another directory.
	 */
	getLatestSessionForCwd(workingDirectory: string = this._workingDirectory): IAgentSession | undefined {
		const want = AgentSessionManager._normDir(workingDirectory);
		const entries = this._cwdIndex();

		let latestId: string | undefined;
		let latestUpdated = -1;
		for (const [id, entry] of Object.entries(entries)) {
			// An empty `dir` means "not recorded" — never silently treated as "here".
			if (entry.dir !== want) continue;
			if (entry.updatedAt > latestUpdated) {
				latestUpdated = entry.updatedAt;
				latestId = id;
			}
		}
		return latestId === undefined ? undefined : this.loadSession(latestId);
	}

	/** Parse one session file defensively (a corrupt file is skipped, never fatal). */
	private _readSessionFile(file: string): IAgentSession | undefined {
		try {
			return JSON.parse(fs.readFileSync(file, 'utf-8')) as IAgentSession;
		} catch {
			return undefined;
		}
	}

	/**
	 * Like {@link listSessions} but scoped to one working directory.
	 *
	 * Used by `/sessions` and the tab completer so the default listing answers "what
	 * did I do in THIS project" instead of mixing every project together.
	 */
	listSessionsForCwd(workingDirectory: string = this._workingDirectory): SessionEntry[] {
		const want = AgentSessionManager._normDir(workingDirectory);
		const entries = this._cwdIndex();
		this._loadIndex();

		const forCwd = Object.entries(entries)
			.filter(([, entry]) => entry.dir === want)
			.map(([id, entry]) => ({ id, entry }));

		const sessions: SessionEntry[] = forCwd.map(({ id, entry }) => {
			// The index has name/mode/summary; the sidecar has recency. Only open the
			// few files whose metadata the index is missing.
			const meta = this._index[id];
			if (meta) {
				return {
					id,
					name: meta.name || id,
					mode: meta.mode,
					createdAt: meta.createdAt,
					updatedAt: meta.updatedAt || entry.updatedAt,
					messageCount: meta.messageCount,
					summary: meta.summary,
				};
			}
			const session = this._readSessionFile(path.join(this._dir, `${id}.json`));
			return {
				id,
				name: session?.name || id,
				mode: session?.mode ?? ('agent' as AgentMode),
				createdAt: session?.createdAt || entry.updatedAt,
				updatedAt: session?.updatedAt || entry.updatedAt,
				messageCount: session?.messageCount ?? 0,
				summary: session?.summary,
			};
		});
		sessions.sort((a, b) => b.updatedAt - a.updatedAt);
		return sessions;
	}

	/**
	 * List all sessions with metadata (sorted by updatedAt descending).
	 */
	listSessions(): SessionEntry[] {
		this._loadIndex();
		const entries: SessionEntry[] = Object.entries(this._index).map(([id, info]) => ({
			id,
			name: info.name,
			mode: info.mode,
			createdAt: info.createdAt,
			updatedAt: info.updatedAt,
			messageCount: info.messageCount,
			summary: info.summary,
		}));
		entries.sort((a, b) => b.updatedAt - a.updatedAt);
		return entries;
	}

	/**
	 * Delete a session by ID.
	 */
	deleteSession(id: string): boolean {
		this._loadIndex();
		const sessionPath = path.join(this._dir, `${id}.json`);
		let deleted = false;
		if (fs.existsSync(sessionPath)) {
			fs.unlinkSync(sessionPath);
			deleted = true;
		}
		delete this._index[id];
		this._saveIndex();
		this._dropFromCwdIndex(id);
		return deleted;
	}

	/**
	 * Generate a new unique session ID.
	 */
	generateId(): string {
		const ts = Date.now();
		const rand = Math.random().toString(36).substring(2, 8);
		return `session_${ts}_${rand}`;
	}

	/**
	 * Get the total count of stored sessions.
	 */
	get count(): number {
		this._loadIndex();
		return Object.keys(this._index).length;
	}

	/**
	 * Extract a short summary from conversation messages.
	 */
	private _extractSummary(messages: IAgentMessage[]): string {
		// Find the first user message as summary anchor
		const firstUser = messages.find(m => m.role === MessageRole.User);
		if (firstUser && firstUser.content) {
			return firstUser.content.substring(0, 200);
		}
		// Fallback: use the last assistant message with content
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === MessageRole.Assistant && m.content && !m.toolCalls?.length) {
				return m.content.substring(0, 200);
			}
		}
		return '(empty session)';
	}
}

/** Lightweight session metadata for listing. */
export interface SessionEntry {
	id: string;
	name: string;
	mode: AgentMode;
	createdAt: number;
	updatedAt: number;
	messageCount: number;
	summary?: string;
}
