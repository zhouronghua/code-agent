/*---------------------------------------------------------------------------------------------
 *  TDAI Agent Memory integration
 *
 *  Bridges code-agent with tdai_agent_mem (TencentDB Agent Memory) so conversations,
 *  atomic facts, scenarios and persona are shared across machines/agents through
 *  the Memory hub (L0 conversation → L1 atom → L2 scenario → L3 persona).
 *
 *  Config resolution (highest priority first):
 *    1. config.yaml `memory:` section  (~/.agent/config.yaml or ./config.yaml)
 *    2. <agent home>/mcp.json  `mcpServers.tdai_agent_mem` entry
 *
 *  mcp.json example:
 *    "tdai_agent_mem": {
 *      "type": "streamableHttp",
 *      "url": "http://10.9.114.25:8420",
 *      "headers": { "Authorization": "Bearer sk-mem-...", "X-Tdai-Service-Id": "default" },
 *      "username": "zrh",
 *      "teamId": "team-xxx",
 *      "agentId": "agt-xxx",
 *      "userId": "usr-xxx"
 *    }
 *
 *  All memory operations fail open: if the memory service is unavailable the
 *  agent flow must never break.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from './agentTools';
import { agentHomeFileCandidates } from './agentHome';
import {
	WorkspaceScope,
	DEFAULT_WORKSPACE_SCOPE,
	MAX_ANCESTOR_QUERIES,
	parseWorkspaceScope,
	normalizeWorkspaceDir,
	workspaceMarker,
	filterL1ByWorkspace,
	workspaceCandidateTags,
} from './agentMemoryWorkspace';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MemoryConfig {
	enabled: boolean;
	/** Memory gateway / kernel base URL, e.g. http://10.9.114.25:8420 */
	endpoint: string;
	/** User API key (sk-mem-...) — sent as Bearer token to the data plane. */
	apiKey: string;
	/** Memory instance id (x-tdai-service-id header). */
	serviceId: string;
	/** Optional user identity forwarded as x-tdai-user-key. */
	userKey?: string;
	/** Username on the memory platform (e.g. zrh). */
	username?: string;
	/** Strict-isolation triple. Required by the v3 data plane. */
	teamId: string;
	agentId: string;
	userId: string;
	/** Optional default session id. Omit to aggregate L0/L1 across sessions. */
	sessionId?: string;
	/** Auto-recall relevant memories at task start. Default true. */
	recall: boolean;
	/** Auto-capture the task conversation (L0) when a task finishes. Default true. */
	capture: boolean;
	/**
	 * Absolute workspace directory used to tag and scope L1 (atomic) memories.
	 * Defaults to the process working directory. L1 recalled from the hub only
	 * when its tag is this directory (or an ancestor/descendant of it).
	 */
	workspaceDir: string;
	/**
	 * L1 workspace scoping mode (see agentMemoryWorkspace.ts):
	 *   strict (default) — untagged L1 hidden, tagged L1 must match the workspace
	 *   loose            — tagged L1 must match, untagged L1 stays visible
	 *   off              — no workspace filtering (legacy behaviour)
	 * L2/L3 are never scoped.
	 */
	workspaceScope: WorkspaceScope;
}

export interface MemorySectionConfig {
	enabled?: boolean;
	endpoint?: string;
	api_key?: string;
	service_id?: string;
	user_key?: string;
	username?: string;
	team_id?: string;
	agent_id?: string;
	user_id?: string;
	session_id?: string;
	recall?: boolean;
	capture?: boolean;
	workspace_dir?: string;
	workspace_scope?: string;
}

interface McpJsonFile {
	mcpServers?: Record<string, {
		type?: string;
		url?: string;
		headers?: Record<string, string>;
		username?: string;
		teamId?: string;
		agentId?: string;
		userId?: string;
		sessionId?: string;
		[key: string]: unknown;
	}>;
}

function env(headerKey: string, headers?: Record<string, string>): string | undefined {
	if (!headers) return undefined;
	return headers[headerKey] ?? headers[headerKey.toLowerCase()];
}

/** Load the tdai_agent_mem MCP entry from <agent home>/mcp.json */
function loadMcpMemoryEntry(): MemorySectionConfig | undefined {
	const candidates = [
		...agentHomeFileCandidates('mcp.json'),
		...agentHomeFileCandidates('.mcp.json'),
	];
	for (const file of candidates) {
		try {
			if (!fs.existsSync(file)) continue;
			const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as McpJsonFile;
			const entry = raw.mcpServers?.tdai_agent_mem;
			if (!entry?.url) continue;
			return {
				enabled: true,
				endpoint: entry.url,
				api_key: env('Authorization', entry.headers)?.replace(/^Bearer\s+/i, '') ?? env('x-tdai-user-key', entry.headers) ?? entry.apiKey as string | undefined,
				service_id: env('x-tdai-service-id', entry.headers) ?? entry.serviceId as string | undefined,
				user_key: env('x-tdai-user-key', entry.headers),
				username: entry.username ?? entry.user as string | undefined,
				team_id: entry.teamId as string | undefined,
				agent_id: entry.agentId as string | undefined,
				user_id: entry.userId as string | undefined,
				session_id: entry.sessionId as string | undefined,
				workspace_dir: entry.workspaceDir as string | undefined,
				workspace_scope: entry.workspaceScope as string | undefined,
			};
		} catch {
			// ignore malformed mcp.json — fall through to config.yaml
		}
	}
	return undefined;
}

/** Load the `memory:` section from the first resolvable config.yaml */
function loadYamlMemorySection(): MemorySectionConfig | undefined {
	const candidates = [
		path.resolve('config.yaml'),
		path.resolve('config.json'),
		...agentHomeFileCandidates('config.yaml'),
		...agentHomeFileCandidates('config.json'),
	];
	for (const file of candidates) {
		try {
			if (!fs.existsSync(file)) continue;
			const text = fs.readFileSync(file, 'utf-8');
			const parsed = file.endsWith('.json')
				? JSON.parse(text)
				: parseMemoryYaml(text);
			const section = parsed?.memory;
			if (section && typeof section === 'object') return section as MemorySectionConfig;
		} catch {
			// ignore unreadable config
		}
	}
	return undefined;
}

/** Minimal YAML parser for the `memory:` section (flat key: value pairs). */
function parseMemoryYaml(text: string): { memory?: MemorySectionConfig } {
	const result: { memory?: MemorySectionConfig } = {};
	let inMemory = false;
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const indent = line.length - line.trimStart().length;

		// Top-level section markers: `memory:`, `agent:`, `skills:` ...
		if (indent === 0 && trimmed.endsWith(':')) {
			inMemory = trimmed === 'memory:';
			continue;
		}
		if (inMemory && indent === 2) {
			const idx = trimmed.indexOf(':');
			if (idx <= 0) continue;
			const key = trimmed.slice(0, idx).trim();
			let val = trimmed.slice(idx + 1).trim();
			val = val.replace(/^["']|["']$/g, '');
			if (!result.memory) result.memory = {};
			const mem = result.memory as Record<string, unknown>;
			if (val === 'true') mem[key] = true;
			else if (val === 'false') mem[key] = false;
			else if (val !== '') mem[key] = val;
		}
	}
	return result;
}

export function loadMemoryConfig(): MemoryConfig | undefined {
	const yamlSection = loadYamlMemorySection();
	const mcpEntry = loadMcpMemoryEntry();

	const enabled = yamlSection?.enabled ?? mcpEntry?.enabled ?? false;
	if (!enabled) return undefined;

	const endpoint = yamlSection?.endpoint || mcpEntry?.endpoint || '';
	const apiKey = yamlSection?.api_key || mcpEntry?.api_key || '';
	const serviceId = yamlSection?.service_id || mcpEntry?.service_id || '';
	const teamId = yamlSection?.team_id || mcpEntry?.team_id || '';
	const agentId = yamlSection?.agent_id || mcpEntry?.agent_id || '';
	const userId = yamlSection?.user_id || mcpEntry?.user_id || '';

	if (!endpoint || !apiKey || !serviceId || !teamId || !agentId || !userId) {
		return undefined;
	}

	return {
		enabled: true,
		endpoint,
		apiKey,
		serviceId,
		userKey: yamlSection?.user_key || mcpEntry?.user_key || apiKey,
		username: yamlSection?.username || mcpEntry?.username || '',
		teamId,
		agentId,
		userId,
		sessionId: yamlSection?.session_id || mcpEntry?.session_id || '',
		recall: yamlSection?.recall ?? true,
		capture: yamlSection?.capture ?? true,
		workspaceDir: normalizeWorkspaceDir(yamlSection?.workspace_dir || mcpEntry?.workspace_dir || ''),
		workspaceScope: parseWorkspaceScope(yamlSection?.workspace_scope ?? mcpEntry?.workspace_scope),
	};
}

// ---------------------------------------------------------------------------
// Memory client (v3 data plane)
// ---------------------------------------------------------------------------

interface ApiEnvelope<T> {
	code: number;
	message: string;
	request_id?: string;
	data: T | null;
}

export interface ConversationMessage {
	role: string;
	content: string;
	timestamp?: string;
}

/** Integration surface used by AgentLoop (recall before, capture after). */
export interface IMemoryIntegration {
	readonly enabled: boolean;
	/** Returns a formatted context block for the given task, or undefined. */
	recall(task: string): Promise<string | undefined>;
	/** Persist a finished task exchange (L0 conversation). */
	capture(task: string, assistantContent: string): Promise<void>;
}

export class MemoryClient implements IMemoryIntegration {
	readonly enabled = true;
	readonly config: MemoryConfig;
	/** Explicit workspace override (host-provided); falls back to config / cwd. */
	private readonly _workspaceOverride?: string;

	constructor(config: MemoryConfig, opts?: { workspaceDir?: string }) {
		this.config = config;
		this._workspaceOverride = opts?.workspaceDir;
	}

	/**
	 * Absolute directory that identifies "this workspace" for L1 tagging/scoping.
	 * Resolution order: constructor override → config `workspace_dir` → process.cwd().
	 */
	get workspaceDir(): string {
		const explicit = normalizeWorkspaceDir(this._workspaceOverride || this.config.workspaceDir);
		if (explicit) return explicit;
		try {
			return normalizeWorkspaceDir(process.cwd());
		} catch {
			return '';
		}
	}

	/** The tag written onto L1 notes; '' when scoping is disabled. */
	get workspaceTag(): string {
		return this.config.workspaceScope === 'off' ? '' : this.workspaceDir;
	}

	get workspaceScope(): WorkspaceScope {
		return this.config.workspaceScope;
	}

	private get _sessionId(): string | undefined {
		return this.config.sessionId || undefined;
	}

	/** Stable default session: config override, else derived from the CWD. */
	private _defaultSession(): string {
		if (this.config.sessionId) return this.config.sessionId;
		try {
			const base = path.basename(process.cwd());
			return base ? `code-agent:${base}` : 'code-agent';
		} catch {
			return 'code-agent';
		}
	}

	private _iso(sessionId?: string | null): Record<string, string> {
		const body: Record<string, string> = {
			team_id: this.config.teamId,
			agent_id: this.config.agentId,
			user_id: this.config.userId,
		};
		const sid = sessionId !== null && sessionId !== undefined ? sessionId : this._sessionId;
		if (sid) body.session_id = sid;
		return body;
	}

	private _headers(): Record<string, string> {
		const h: Record<string, string> = {
			'Content-Type': 'application/json',
			'Authorization': `Bearer ${this.config.apiKey}`,
			'x-tdai-service-id': this.config.serviceId,
		};
		if (this.config.userKey) h['x-tdai-user-key'] = this.config.userKey;
		return h;
	}

	/** Core POST with fail-open semantics: throws only on transport-level errors. */
	private async _post<T = unknown>(pathname: string, body: Record<string, unknown>): Promise<T | null> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10000);
		try {
			const res = await fetch(`${this.config.endpoint.replace(/\/+$/, '')}${pathname}`, {
				method: 'POST',
				headers: this._headers(),
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			const text = await res.text();
			let envelope: ApiEnvelope<T>;
			try {
				envelope = JSON.parse(text) as ApiEnvelope<T>;
			} catch {
				throw new Error(`Memory gateway returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
			}
			if (!res.ok || envelope.code !== 0) {
				throw new Error(`Memory API error ${envelope.code || res.status}: ${envelope.message}`);
			}
			return envelope.data ?? null;
		} finally {
			clearTimeout(timer);
		}
	}

	// ---- L0 conversation ----

	async addConversation(messages: ConversationMessage[], sessionId?: string, taskId?: string): Promise<boolean> {
		const sid = sessionId || this._sessionId || this._defaultSession();
		const data = await this._post('/v3/conversation/add', {
			...this._iso(sid),
			session_id: sid,
			messages,
			...(taskId ? { task_id: taskId } : {}),
		});
		return data !== null;
	}

	async searchConversation(query: string, limit = 5): Promise<Array<Record<string, unknown>>> {
		const data = await this._post<{ items?: Array<Record<string, unknown>> }>('/v3/conversation/search', {
			...this._iso(null),
			query,
			limit,
		});
		return data?.items ?? [];
	}

	async queryConversation(limit = 20): Promise<Array<Record<string, unknown>>> {
		const data = await this._post<{ items?: Array<Record<string, unknown>> }>('/v3/conversation/query', {
			...this._iso(null),
			limit,
			offset: 0,
		});
		return data?.items ?? [];
	}

	// ---- L1 atomic ----

	/**
	 * Raw L1 search against the hub.
	 *
	 * `taskId` is a first-class server-side filter (verified against the v3 data
	 * plane); this client stores the workspace directory there, so passing it
	 * restricts the search to notes tagged with exactly that directory.
	 */
	async searchAtomic(query: string, limit = 5, type?: string, taskId?: string): Promise<Array<Record<string, unknown>>> {
		const data = await this._post<{ items?: Array<Record<string, unknown>> }>('/v3/atomic/search', {
			...this._iso(null),
			query,
			limit,
			...(type ? { type } : {}),
			...(taskId ? { task_id: taskId } : {}),
		});
		return data?.items ?? [];
	}

	/**
	 * Workspace-scoped L1 search: the only L1 entry point used for recall.
	 *
	 * Candidates = an over-fetched unfiltered search (which is what surfaces
	 * descendants-of-cwd notes and untagged legacy notes) UNION one exact-tag query per
	 * candidate tag (cwd + ancestors), so a workspace with few notes is still found even
	 * when the global top-N is crowded by other projects. Everything is then gated by the
	 * workspace rule before the caller sees it.
	 */
	async searchL1Scoped(query: string, limit = 5, type?: string): Promise<{ items: Array<Record<string, unknown>>; hidden: number }> {
		const scope = this.config.workspaceScope;
		const ws = this.workspaceDir;
		if (scope === 'off' || !ws || limit <= 0) {
			return { items: await this.searchAtomic(query, limit, type), hidden: 0 };
		}

		const overfetch = Math.max(limit, limit * 5);
		const primary = await this.searchAtomic(query, overfetch, type);
		const ancestorTags = workspaceCandidateTags(ws);
		const extra = await Promise.all(
			ancestorTags.map(tag => this.searchAtomic(query, limit, type, tag).catch(() => [] as Array<Record<string, unknown>>)),
		);

		const seen = new Set<string>();
		const merged: Array<Record<string, unknown>> = [];
		for (const item of [primary, ...extra].flat()) {
			const id = typeof item.id === 'string' ? item.id : '';
			const key = id || `anon:${merged.length}:${String(item.content ?? '').slice(0, 48)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			merged.push(item);
		}

		const visible = filterL1ByWorkspace(merged, ws, scope);
		visible.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
		return { items: visible.slice(0, limit), hidden: merged.length - visible.length };
	}

	async updateAtomic(id: string, content: string, background?: string, taskId?: string): Promise<boolean> {
		const data = await this._post('/v3/atomic/update', {
			...this._iso(null),
			id,
			content,
			...(background ? { background } : {}),
			...(taskId ? { task_id: taskId } : {}),
		});
		return data !== null;
	}

	// ---- L2 scenario ----

	async listScenarios(pathPrefix?: string): Promise<Array<Record<string, unknown>>> {
		const data = await this._post<{ entries?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> }>('/v3/scenario/ls', {
			...this._iso(null),
			...(pathPrefix ? { path_prefix: pathPrefix } : {}),
		});
		return data?.entries ?? data?.items ?? [];
	}

	async readScenario(pathname: string): Promise<string | null> {
		const data = await this._post<{ content?: string | null }>('/v3/scenario/read', {
			...this._iso(null),
			path: pathname,
		});
		return data?.content ?? null;
	}

	async writeScenario(pathname: string, content: string, summary?: string): Promise<boolean> {
		const data = await this._post('/v3/scenario/write', {
			...this._iso(null),
			path: pathname,
			content,
			...(summary ? { summary } : {}),
		});
		return data !== null;
	}

	// ---- L3 core (persona) ----

	async readCore(): Promise<string | null> {
		const data = await this._post<{ content?: string | null }>('/v3/core/read', this._iso(null));
		return data?.content ?? null;
	}

	async writeCore(content: string): Promise<boolean> {
		const data = await this._post('/v3/core/write', {
			...this._iso(null),
			content,
		});
		return data !== null;
	}

	// ---- IMemoryIntegration (AgentLoop hooks) ----

	/**
	 * Recall relevant memories for the task: L1 atomic search (workspace-scoped)
	 * + L2 scenario index + L3 persona. All three run independently; a failure in
	 * one never blocks the others. Returns a formatted context block or undefined.
	 *
	 * L2/L3 are intentionally cross-project; only L1 is scoped to the workspace
	 * directory (same dir, or an ancestor/descendant of it).
	 */
	async recall(task: string): Promise<string | undefined> {
		const sections: string[] = [];

		// L1 — relevant facts (workspace-scoped)
		try {
			const { items: atoms, hidden } = await this.searchL1Scoped(task, 5);
			if (hidden > 0) {
				console.log(`[memory] L1 workspace scope (${this.config.workspaceScope}) [${this.workspaceDir}]: hid ${hidden} memory(ies) tagged to other workspaces`);
			}
			const lines = atoms
				.filter(a => typeof a.content === 'string' && a.content.trim())
				.map(a => {
					const type = a.type ? `[${a.type}] ` : '';
					return `- ${type}${String(a.content).trim()}`;
				});
			if (lines.length > 0) {
				sections.push(`<relevant-memories>\n${lines.join('\n')}\n</relevant-memories>`);
			}
		} catch (err) {
			console.warn(`[memory] L1 recall failed: ${(err as Error).message}`);
		}

		// L2 — scenario index
		try {
			const scenarios = await this.listScenarios();
			const paths = scenarios
				.map(s => s.path ?? s.filename ?? s.name)
				.filter((p): p is string => typeof p === 'string' && p.length > 0);
			if (paths.length > 0) {
				sections.push(
					`## Shared Scenario Index (L2)\n*以下场景文件可通过 tdai_read_file 读取详情*\n` +
					paths.map(p => `- \`${p}\``).join('\n')
				);
			}
		} catch (err) {
			console.warn(`[memory] L2 recall failed: ${(err as Error).message}`);
		}

		// L3 — persona
		try {
			const core = await this.readCore();
			if (core && core.trim()) {
				sections.push(`<user-persona>\n${core.trim()}\n</user-persona>`);
			}
		} catch (err) {
			console.warn(`[memory] L3 recall failed: ${(err as Error).message}`);
		}

		if (sections.length === 0) return undefined;
		return sections.join('\n\n');
	}

	/**
	 * Capture the finished task exchange into L0. The memory hub's offload
	 * pipeline later distills L0 → L1 → L2 → L3, so raw turns are the right
	 * input here. Fail-open: never throws into the main agent flow.
	 *
	 * The workspace directory is stamped on the turn twice: as the hub's
	 * `task_id` field (filterable server-side) and as a `[workspace:<dir>]`
	 * marker inside the user text, so the distilled L1 stays attributable to
	 * this workspace even if the pipeline only keeps the text.
	 */
	async capture(task: string, assistantContent: string): Promise<void> {
		try {
			const tag = this.workspaceTag;
			const marker = tag ? workspaceMarker(tag) : '';
			const messages: ConversationMessage[] = [];
			if (task && task.trim()) {
				const body = task.slice(0, 8000);
				messages.push({ role: 'user', content: marker ? `${marker}\n${body}` : body });
			}
			if (assistantContent && assistantContent.trim()) {
				messages.push({ role: 'assistant', content: assistantContent.slice(0, 8000) });
			}
			if (messages.length === 0) return;
			const ok = await this.addConversation(messages, undefined, tag || undefined);
			if (ok) {
				console.log(`[memory] L0 captured: ${messages.length} message(s) -> ${this.config.username || this.config.userId}${tag ? ` [workspace ${tag}]` : ''}`);
			}
		} catch (err) {
			console.warn(`[memory] capture failed (non-fatal): ${(err as Error).message}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Agent tools (registered when memory is enabled)
// ---------------------------------------------------------------------------

export abstract class MemoryTool extends AgentTool {
	constructor(protected readonly _client: MemoryClient) {
		super();
	}
}

/** tdai_memory_search — L1 atomic (structured facts/preferences) search, workspace-scoped. */
export class MemorySearchTool extends MemoryTool {
	readonly name = 'tdai_memory_search';
	readonly description = 'Search shared agent memory (L1 atomic facts: user preferences, rules, past decisions, project conventions) on the tdai_agent_mem hub. Use when you need knowledge stored by previous agent runs on any machine. L1 is scoped to the current workspace directory: only memories tagged with this directory (or one of its parents/children) are returned.';
	readonly parameters = {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Natural-language query describing the fact you are looking for' },
			limit: { type: 'number', description: 'Max results, default 5' },
		},
		required: ['query'],
	};

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = (args._toolCallId as string) || '';
		if (signal?.aborted) return this.failure(toolCallId, 'Tool execution cancelled by user');
		try {
			const { items, hidden } = await this._client.searchL1Scoped(String(args.query || ''), (args.limit as number) || 5);
			const scopeNote = hidden > 0
				? `\n\n(workspace scope \`${this._client.workspaceScope}\` on \`${this._client.workspaceDir}\`: ${hidden} memory(ies) tagged to other workspaces were withheld)`
				: '';
			if (items.length === 0) {
				return this.success(toolCallId, `(no matching memories found in this workspace)${scopeNote}`);
			}
			const out = items.map((it, i) => {
				const id = it.id ? `\nid: ${it.id}` : '';
				const type = it.type ? `\ntype: ${it.type}` : '';
				const background = it.background ?? it.scene_name ? `\nbackground: ${String(it.background ?? it.scene_name)}` : '';
				return `[${i + 1}]${type}${id}\n${String(it.content)}${background}`;
			}).join('\n\n');
			return this.success(toolCallId, out + scopeNote);
		} catch (err) {
			return this.failure(toolCallId, `memory_search failed: ${(err as Error).message}`);
		}
	}
}

/** tdai_conversation_search — L0 raw conversation search. */
export class ConversationSearchTool extends MemoryTool {
	readonly name = 'tdai_conversation_search';
	readonly description = 'Search raw past conversation history (L0) stored on the tdai_agent_mem hub — useful when the exact wording of a previous exchange matters.';
	readonly parameters = {
		type: 'object',
		properties: {
			query: { type: 'string', description: 'Search query' },
			limit: { type: 'number', description: 'Max results, default 5' },
		},
		required: ['query'],
	};

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = (args._toolCallId as string) || '';
		if (signal?.aborted) return this.failure(toolCallId, 'Tool execution cancelled by user');
		try {
			const items = await this._client.searchConversation(String(args.query || ''), (args.limit as number) || 5);
			if (items.length === 0) return this.success(toolCallId, '(no matching conversations found)');
			const out = items.map((it, i) => {
				const role = it.role ? `${it.role}: ` : '';
				const when = it.timestamp ?? it.created_at ? `\n(time: ${String(it.timestamp ?? it.created_at)})` : '';
				return `[${i + 1}]${when}\n${role}${String(it.content ?? '').slice(0, 1000)}`;
			}).join('\n\n');
			return this.success(toolCallId, out);
		} catch (err) {
			return this.failure(toolCallId, `conversation_search failed: ${(err as Error).message}`);
		}
	}
}

/** tdai_read_file — read L2 scenario / L3 persona content. */
export class MemoryReadTool extends MemoryTool {
	readonly name = 'tdai_read_file';
	readonly description = 'Read a shared memory file from the tdai_agent_mem hub: L3 persona ("core") or an L2 scenario file by path (e.g. "work.md"). Paths come from the Shared Scenario Index.';
	readonly parameters = {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path, or "core" for the L3 persona' },
		},
		required: ['path'],
	};

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = (args._toolCallId as string) || '';
		if (signal?.aborted) return this.failure(toolCallId, 'Tool execution cancelled by user');
		const p = String(args.path || '');
		try {
			if (p === 'core') {
				const content = await this._client.readCore();
				return this.success(toolCallId, content ?? '(core persona is empty)');
			}
			const content = await this._client.readScenario(p);
			if (content === null) return this.failure(toolCallId, `Scenario file not found: ${p}`);
			return this.success(toolCallId, content);
		} catch (err) {
			return this.failure(toolCallId, `read_file failed: ${(err as Error).message}`);
		}
	}
}

/** tdai_memory_write — write L1/L2/L3 according to the memory tier. */
export class MemoryWriteTool extends MemoryTool {
	readonly name = 'tdai_memory_write';
	readonly description = 'Write knowledge to the tdai_agent_mem hub at a specific memory tier: l1 = atomic fact (needs an existing note id), l2 = scenario file (updates an existing path), l3 = user persona (core). L0 conversations are captured automatically after each task. L1 notes written here are tagged with the current workspace directory so they are only recalled in that workspace (or its parent/child directories).';
	readonly parameters = {
		type: 'object',
		properties: {
			layer: { type: 'string', enum: ['l1', 'l2', 'l3'], description: 'Memory tier: l1 atomic, l2 scenario, l3 persona core' },
			content: { type: 'string', description: 'Content to store' },
			id: { type: 'string', description: 'L1 atomic note id (required for layer=l1)' },
			path: { type: 'string', description: 'L2 scenario file path (required for layer=l2)' },
			background: { type: 'string', description: 'L1 background/context (optional)' },
			summary: { type: 'string', description: 'L2 file summary (optional)' },
		},
		required: ['layer', 'content'],
	};

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = (args._toolCallId as string) || '';
		if (signal?.aborted) return this.failure(toolCallId, 'Tool execution cancelled by user');
		const layer = String(args.layer || '').toLowerCase();
		const content = String(args.content || '');
		try {
			if (layer === 'l3') {
				const ok = await this._client.writeCore(content);
				return ok ? this.success(toolCallId, 'L3 persona core updated.') : this.failure(toolCallId, 'write failed');
			}
			if (layer === 'l2') {
				const p = String(args.path || '');
				if (!p) return this.failure(toolCallId, 'layer=l2 requires "path" (an existing scenario file)');
				const ok = await this._client.writeScenario(p, content, args.summary ? String(args.summary) : undefined);
				return ok ? this.success(toolCallId, `L2 scenario updated: ${p}`) : this.failure(toolCallId, 'write failed (file must already exist)');
			}
			if (layer === 'l1') {
				const id = String(args.id || '');
				if (!id) return this.failure(toolCallId, 'layer=l1 requires "id" of an existing atomic note');
				// Tag the note with this workspace: `task_id` is the authoritative,
				// server-filterable carrier; the marker in `background` keeps the tag
				// readable even if the hub rewrites task_id.
				const tag = this._client.workspaceTag;
				const marker = tag ? workspaceMarker(tag) : '';
				const bg = args.background ? String(args.background) : '';
				const background = marker ? `${bg ? `${bg} ` : ''}${marker}` : (bg || undefined);
				const ok = await this._client.updateAtomic(id, content, background, tag || undefined);
				return ok
					? this.success(toolCallId, `L1 atomic note updated: ${id}${tag ? ` (workspace ${tag})` : ''}`)
					: this.failure(toolCallId, 'update failed (note must already exist)');
			}
			return this.failure(toolCallId, `Unknown layer: ${layer} (use l1 | l2 | l3)`);
		} catch (err) {
			return this.failure(toolCallId, `memory_write failed: ${(err as Error).message}`);
		}
	}
}
