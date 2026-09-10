/*---------------------------------------------------------------------------------------------
 *  MCP (Model Context Protocol) bridge
 *
 *  Generic client for MCP servers so skills can call external tools
 *  (dolphin pipeline / gerrit / gitlab / jira, opendisplay artifacts, …)
 *  as first-class agent tools — the same way the VS Code host exposes them.
 *
 *  Two transports:
 *    - streamableHttp  (type: streamableHttp | http | sse  →  url + headers)
 *    - stdio           (command + args + env)
 *
 *  Servers are resolved from:
 *    1. config.yaml `mcp_servers:`   (ResolvedConfig.mcpServers)
 *    2. ~/.codeagent/mcp.json        (Cursor / VS Code compatible)
 *
 *  Per-server `tools: [..]` is an optional allowlist. This matters because some
 *  gateways (e.g. dolphin) advertise 180+ tools; without an allowlist the prompt
 *  would balloon. A global allowlist (--mcp-tools) is intersected on top.
 *
 *  All failures are non-fatal: a broken MCP server must never block a run.
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool, ToolRegistry } from './agentTools';

export interface McpServerSpec {
	name: string;
	type?: string;
	url?: string;
	headers?: Record<string, string>;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	/** Optional allowlist of tool names to expose from this server. */
	tools?: string[];
}

export interface McpToolDef {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

export interface McpLoadOptions {
	/** Global allowlist (intersected with each server's own allowlist). */
	allowTools?: string[];
	/** Per-request timeout in ms for HTTP transports (default 300000 = 5 min). */
	timeoutMs?: number;
	/** Server names to skip entirely (e.g. the memory server). */
	skipServers?: string[];
}

interface McpTransport {
	initialize(): Promise<void>;
	listTools(): Promise<McpToolDef[]>;
	callTool(name: string, args: Record<string, unknown>): Promise<string>;
	dispose(): void;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const DEFAULT_MCP_TOOL_TIMEOUT_MS = 300000;

function expandHome(p: string): string {
	if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
	return p;
}

/** Parse a JSON or text/event-stream body and pick the JSON-RPC response. */
function parseRpcBody(text: string, wantId?: number): any | undefined {
	const trimmed = (text || '').trim();
	if (!trimmed) return undefined;

	// Plain JSON
	if (trimmed.startsWith('{')) {
		try { return JSON.parse(trimmed); } catch { /* fall through to SSE */ }
	}

	// SSE: collect all `data:` payloads, prefer the one matching wantId
	const payloads: any[] = [];
	for (const line of trimmed.split('\n')) {
		const l = line.trim();
		if (!l.startsWith('data:')) continue;
		const payload = l.slice(5).trim();
		if (!payload || payload === '[DONE]') continue;
		try { payloads.push(JSON.parse(payload)); } catch { /* ignore */ }
	}
	if (payloads.length === 0) return undefined;
	if (wantId !== undefined) {
		const match = payloads.find(p => p && p.id === wantId);
		if (match) return match;
	}
	// Prefer a response with an id; otherwise the last object.
	return payloads.reverse().find(p => p && p.id !== undefined) || payloads[0];
}

function isSessionError(msg: string): boolean {
	return /session/i.test(msg) && /not found|expired|missing|invalid/i.test(msg);
}

// ---------------------------------------------------------------------------
// streamableHttp transport
// ---------------------------------------------------------------------------

class HttpMcpTransport implements McpTransport {
	private _sessionId?: string;
	private _rid = 0;
	private _initialized = false;

	constructor(
		private readonly _url: string,
		private readonly _headers: Record<string, string>,
		private readonly _timeoutMs: number,
	) {}

	private async _send(payload: Record<string, unknown>, expectResponse: boolean): Promise<any> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			'Accept': 'application/json, text/event-stream',
			...this._headers,
		};
		if (this._sessionId) headers['mcp-session-id'] = this._sessionId;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this._timeoutMs);
		try {
			const res = await fetch(this._url, {
				method: 'POST',
				headers,
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			const sid = res.headers.get('mcp-session-id');
			if (sid) this._sessionId = sid;
			const text = await res.text();
			if (!expectResponse) return undefined;
			if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
			const json = parseRpcBody(text, payload.id as number | undefined);
			if (!json) throw new Error(`empty/invalid MCP response: ${text.slice(0, 400)}`);
			if (json.error) throw new Error(`MCP error ${json.error.code ?? ''}: ${json.error.message}`);
			return json.result;
		} finally {
			clearTimeout(timer);
		}
	}

	async initialize(): Promise<void> {
		this._sessionId = undefined;
		this._initialized = false;
		await this._send({
			jsonrpc: '2.0',
			id: ++this._rid,
			method: 'initialize',
			params: {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'code-agent', version: '1.0' },
			},
		}, true);
		try {
			await this._send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, false);
		} catch { /* notification is best-effort */ }
		this._initialized = true;
	}

	private async _call(method: string, params: Record<string, unknown>): Promise<any> {
		if (!this._initialized) await this.initialize();
		return this._send({ jsonrpc: '2.0', id: ++this._rid, method, params }, true);
	}

	async listTools(): Promise<McpToolDef[]> {
		const r = await this._call('tools/list', {});
		return (r && r.tools) || [];
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		try {
			return await this._callToolOnce(name, args);
		} catch (e) {
			const msg = (e as Error).message || String(e);
			if (isSessionError(msg)) {
				await this.initialize();
				return this._callToolOnce(name, args);
			}
			throw e;
		}
	}

	private async _callToolOnce(name: string, args: Record<string, unknown>): Promise<string> {
		const r = await this._call('tools/call', { name, arguments: args });
		const content = (r && r.content) || [];
		const text = content
			.map((c: any) => (c && c.type === 'text' ? c.text : JSON.stringify(c)))
			.join('\n');
		if (r && r.isError) throw new Error(text || `MCP tool ${name} reported an error`);
		return text || '(empty result)';
	}

	dispose(): void { /* nothing to release for HTTP */ }
}

// ---------------------------------------------------------------------------
// stdio transport
// ---------------------------------------------------------------------------

class StdioMcpTransport implements McpTransport {
	private _proc?: ChildProcessWithoutNullStreams;
	private _rid = 0;
	private _buf = '';
	private _pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private _initialized = false;

	constructor(
		private readonly _command: string,
		private readonly _args: string[],
		private readonly _env: Record<string, string>,
	) {}

	async initialize(): Promise<void> {
		this.dispose();
		const proc = spawn(this._command, this._args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env, ...this._env },
		});
		this._proc = proc;
		proc.stdout.setEncoding('utf8');
		proc.stdout.on('data', (d: string) => this._onData(d));
		proc.stderr.on('data', () => { /* surfaced only on failure */ });
		proc.on('exit', () => {
			for (const [, p] of this._pending) p.reject(new Error('MCP stdio process exited'));
			this._pending.clear();
		});
		await this._request('initialize', {
			protocolVersion: '2024-11-05',
			capabilities: {},
			clientInfo: { name: 'code-agent', version: '1.0' },
		});
		this._notify('notifications/initialized', {});
		this._initialized = true;
	}

	private _onData(chunk: string): void {
		this._buf += chunk;
		let nl: number;
		while ((nl = this._buf.indexOf('\n')) >= 0) {
			const line = this._buf.slice(0, nl).trim();
			this._buf = this._buf.slice(nl + 1);
			if (!line) continue;
			let msg: any;
			try { msg = JSON.parse(line); } catch { continue; }
			if (msg && msg.id !== undefined && this._pending.has(msg.id)) {
				const p = this._pending.get(msg.id)!;
				this._pending.delete(msg.id);
				if (msg.error) p.reject(new Error(`MCP error ${msg.error.code ?? ''}: ${msg.error.message}`));
				else p.resolve(msg.result);
			}
		}
	}

	private _notify(method: string, params: Record<string, unknown>): void {
		try { this._proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* ignore */ }
	}

	private _request(method: string, params: Record<string, unknown>): Promise<any> {
		return new Promise((resolve, reject) => {
			if (!this._proc) return reject(new Error('MCP stdio process not started'));
			const id = ++this._rid;
			this._pending.set(id, { resolve, reject });
			try {
				this._proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
			} catch (e) {
				this._pending.delete(id);
				reject(e as Error);
			}
		});
	}

	async listTools(): Promise<McpToolDef[]> {
		if (!this._initialized) await this.initialize();
		const r = await this._request('tools/list', {});
		return (r && r.tools) || [];
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		if (!this._initialized) await this.initialize();
		const r = await this._request('tools/call', { name, arguments: args });
		const content = (r && r.content) || [];
		const text = content
			.map((c: any) => (c && c.type === 'text' ? c.text : JSON.stringify(c)))
			.join('\n');
		if (r && r.isError) throw new Error(text || `MCP tool ${name} reported an error`);
		return text || '(empty result)';
	}

	dispose(): void {
		try { this._proc?.kill(); } catch { /* ignore */ }
		this._proc = undefined;
		this._pending.clear();
	}
}

// ---------------------------------------------------------------------------
// tool wrapper
// ---------------------------------------------------------------------------

export class McpTool extends AgentTool {
	readonly name: string;
	readonly description: string;
	readonly parameters: Record<string, unknown>;

	constructor(
		private readonly _server: string,
		private readonly _transport: McpTransport,
		def: McpToolDef,
	) {
		super();
		this.name = def.name;
		this.description = `[MCP:${_server}] ${def.description || def.name}`;
		const schema = def.inputSchema;
		this.parameters = (schema && typeof schema === 'object' && (schema as any).type)
			? schema
			: { type: 'object', properties: {} };
	}

	async execute(args: Record<string, unknown>): Promise<IToolResult> {
		const toolCallId = (args._toolCallId as string) || '';
		const clean: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(args)) {
			if (k.startsWith('_')) continue;
			clean[k] = v;
		}
		try {
			const out = await this._transport.callTool(this.name, clean);
			return this.success(toolCallId, out);
		} catch (e) {
			return this.failure(toolCallId, `MCP ${this._server}/${this.name} failed: ${(e as Error).message || String(e)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// loading / registration
// ---------------------------------------------------------------------------

/** Load MCP server entries from a Cursor/VS Code style mcp.json file. */
export function loadMcpServersFromJsonFile(file?: string): McpServerSpec[] {
	const candidates = file
		? [file]
		: ['~/.codeagent/mcp.json', '~/.codeagent/.mcp.json'];
	for (const c of candidates) {
		const p = expandHome(c);
		try {
			if (!fs.existsSync(p)) continue;
			const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
			const servers = raw.mcpServers || {};
			return Object.entries(servers).map(([name, s]: [string, any]) => ({
				name,
				type: s.type,
				url: s.url,
				headers: s.headers,
				command: s.command,
				args: s.args,
				env: s.env,
				tools: Array.isArray(s.tools) ? s.tools : undefined,
			}));
		} catch (e) {
			// try the next candidate
		}
	}
	return [];
}

function intersectAllow(
	perServer?: string[],
	global?: string[],
): Set<string> | undefined {
	const a = perServer && perServer.length > 0 ? new Set(perServer) : undefined;
	const b = global && global.length > 0 ? new Set(global) : undefined;
	if (!a && !b) return undefined;
	if (a && b) return new Set([...a].filter(x => b.has(x)));
	return a || b;
}

/**
 * Connect to each server, discover tools and build McpTool instances.
 * Never throws — failures are reported through `logger`.
 */
export async function createMcpTools(
	specs: McpServerSpec[],
	logger: (msg: string) => void,
	opts: McpLoadOptions = {},
): Promise<{ tools: McpTool[]; transports: McpTransport[] }> {
	const tools: McpTool[] = [];
	const transports: McpTransport[] = [];
	const seen = new Set<string>();
	const skip = new Set(opts.skipServers || []);
	const timeoutMs = opts.timeoutMs || DEFAULT_MCP_TOOL_TIMEOUT_MS;

	for (const spec of specs) {
		if (skip.has(spec.name)) continue;
		if (!spec.url && !spec.command) {
			logger(`[MCP] skip "${spec.name}": neither url nor command configured`);
			continue;
		}

		let transport: McpTransport | undefined;
		try {
			transport = spec.url
				? new HttpMcpTransport(spec.url, spec.headers || {}, timeoutMs)
				: new StdioMcpTransport(spec.command!, spec.args || [], spec.env || {});
			await transport.initialize();
			const defs = await transport.listTools();
			const allow = intersectAllow(spec.tools, opts.allowTools);
			let loaded = 0;
			for (const def of defs) {
				if (!def || !def.name) continue;
				if (allow && !allow.has(def.name)) continue;
				if (seen.has(def.name)) {
					logger(`[MCP] duplicate tool "${def.name}" from "${spec.name}" — keeping the first one`);
					continue;
				}
				seen.add(def.name);
				tools.push(new McpTool(spec.name, transport, def));
				loaded++;
			}
			transports.push(transport);
			const suffix = allow ? ` (allowlist of ${allow.size})` : '';
			logger(`[MCP] ${spec.name}: ${loaded}/${defs.length} tools loaded${suffix}`);
		} catch (e) {
			logger(`[MCP] ${spec.name} failed: ${(e as Error).message || String(e)}`);
			try { transport?.dispose(); } catch { /* ignore */ }
		}
	}

	return { tools, transports };
}

/** Register discovered MCP tools into the registry (skipping name collisions). */
export async function registerMcpTools(
	registry: ToolRegistry,
	specs: McpServerSpec[],
	logger: (msg: string) => void,
	opts: McpLoadOptions = {},
): Promise<{ count: number; transports: McpTransport[] }> {
	const { tools, transports } = await createMcpTools(specs, logger, opts);
	let count = 0;
	for (const tool of tools) {
		if (registry.has(tool.name)) {
			logger(`[MCP] tool "${tool.name}" already registered — skipped`);
			continue;
		}
		registry.register(tool);
		count++;
	}
	return { count, transports };
}
