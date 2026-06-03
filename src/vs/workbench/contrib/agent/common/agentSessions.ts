/*---------------------------------------------------------------------------------------------
 *  Agent Session Manager - Persist and resume agent conversation sessions
 *
 *  Features:
 *  - Auto-save after each run
 *  - Manual save with custom name
 *  - List sessions with metadata (mode, message count, timestamps)
 *  - Resume a previous session with full context restoration
 *  - Delete sessions
 *  - Storage: ~/.codeagent/sessions/ as JSON files
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AgentMode, IAgentMessage, IAgentPlan, IAgentSession, MessageRole } from 'vs/workbench/services/agent/common/agentModels';

const SESSIONS_DIR = path.join(os.homedir(), '.codeagent', 'sessions');
const INDEX_FILE = '_index.json';

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

	constructor(private _workingDirectory: string = process.cwd()) { }

	/**
	 * Ensure sessions directory exists and load index.
	 */
	private _ensureDir(): void {
		if (!fs.existsSync(SESSIONS_DIR)) {
			fs.mkdirSync(SESSIONS_DIR, { recursive: true });
		}
	}

	private _loadIndex(): void {
		if (this._indexLoaded) return;
		this._ensureDir();
		const indexPath = path.join(SESSIONS_DIR, INDEX_FILE);
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
		const indexPath = path.join(SESSIONS_DIR, INDEX_FILE);
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
		const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
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

		return session;
	}

	/**
	 * Load a session by ID.
	 */
	loadSession(id: string): IAgentSession | undefined {
		this._loadIndex();
		const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
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
	 * Get the most recent session (by updatedAt).
	 */
	getLatestSession(): IAgentSession | undefined {
		this._loadIndex();
		const ids = Object.keys(this._index);
		if (ids.length === 0) return undefined;

		let latestId = ids[0];
		let latestTime = this._index[latestId]?.updatedAt || 0;
		for (const id of ids) {
			const t = this._index[id]?.updatedAt || 0;
			if (t > latestTime) {
				latestTime = t;
				latestId = id;
			}
		}
		return this.loadSession(latestId);
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
		const sessionPath = path.join(SESSIONS_DIR, `${id}.json`);
		let deleted = false;
		if (fs.existsSync(sessionPath)) {
			fs.unlinkSync(sessionPath);
			deleted = true;
		}
		delete this._index[id];
		this._saveIndex();
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
