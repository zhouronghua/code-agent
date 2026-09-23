/*---------------------------------------------------------------------------------------------
 *  Langfuse Observability — LLM/agent tracing for the ReAct loop
 *
 *  Instruments three nested levels of the agent run:
 *
 *    agent-task (root trace, one per user task)
 *      └─ agent-step (one per ReAct iteration)
 *           ├─ llm-call   (generation: model, params, messages, usage)
 *           └─ tool:<name> (tool: arguments, result, error level)
 *      └─ subagent:<task> (agent observation, one per parallel dispatch)
 *
 *  Design rules (Langfuse best practices — see the `langfuse` skill,
 *  references/instrumentation.md):
 *    1. Every generation carries model + modelParameters + usageDetails, which is
 *       what lets Langfuse compute cost and compare models.
 *    2. Trace input is the user message only, never the whole function scope —
 *       otherwise API keys and full configs leak into the trace.
 *    3. A subagent's execution is typed `agent`, not `tool`/`span`, so it shows up
 *       as its own node in the Agent Graph; the dispatch and the execution are the
 *       SAME observation (no duplicated pair).
 *    4. Secrets are masked through the SDK's own `mask` hook (defense in depth)
 *       and `capture_content: false` drops prompts/outputs entirely for
 *       confidential codebases.
 *    5. Tracing is strictly best-effort: every Langfuse call is wrapped so a
 *       broken/unreachable Langfuse can never fail an agent run ("fail open",
 *       same contract as the shared-memory integration).
 *
 *  Configuration (highest priority first):
 *    1. environment: LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL
 *       (or LANGFUSE_HOST), LANGFUSE_TRACING_ENVIRONMENT, LANGFUSE_RELEASE,
 *       LANGFUSE_TRACING_ENABLED=0|false to force off, LANGFUSE_CAPTURE_CONTENT=0|false
 *    2. config.yaml `tracing:` section (project ./config.yaml or ~/.agent/config.yaml)
 *    3. CLI flag `--tracing on|off`
 *
 *  Verified against @langfuse/tracing + @langfuse/otel 5.11.1 (the current SDK
 *  generation; the unscoped `langfuse` package is the deprecated v3 client).
 *  The SDK declares engines >=20 but was measured working on Node 18.20.8 and
 *  20.19.4 (same span payloads); loading failures are caught and disable tracing.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { agentHomeFileCandidates } from './agentHome';

// ---------------------------------------------------------------------------
// Limits — mirrors the Langfuse attribute constraints, so we truncate at the
// source instead of letting the SDK drop the value with a warning.
// ---------------------------------------------------------------------------

/** `userId` / `sessionId` are capped at 200 chars by the SDK. */
const MAX_ID_LEN = 200;
/** Propagated metadata values must be strings ≤200 chars. */
const MAX_META_VALUE_LEN = 200;
/** Per-message content kept on a generation input (long file reads blow up a trace). */
const MAX_MESSAGE_CHARS = 20_000;
/** Reasoning blocks can reach 98k chars on a degenerate loop — keep an excerpt. */
const MAX_REASONING_CHARS = 8_000;
/** Tool results (build logs, file reads) are truncated for the same reason. */
const MAX_TOOL_RESULT_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Resolved Langfuse tracing configuration. */
export interface TracingConfig {
	publicKey: string;
	secretKey: string;
	/** Langfuse base URL (EU/US cloud or self-hosted). */
	baseUrl: string;
	environment?: string;
	release?: string;
	/**
	 * When false, prompts / outputs / tool payloads are NOT sent — only names,
	 * models, token usage, timings and error levels. Use for confidential code.
	 */
	captureContent: boolean;
	userId?: string;
	sessionId?: string;
	tags: string[];
}

/** Outcome of config resolution: either an enabled config, or why it's off. */
export interface TracingSettings {
	enabled: boolean;
	/** Human-readable explanation shown to the user when tracing is off. */
	reason?: string;
	config?: TracingConfig;
	/** Where the keys came from (for the startup status line). */
	source?: string;
}

/** `tracing:` section of config.yaml. */
interface TracingYamlSection {
	enabled?: boolean;
	public_key?: string;
	secret_key?: string;
	base_url?: string;
	host?: string;
	environment?: string;
	release?: string;
	capture_content?: boolean;
	user_id?: string;
	session_id?: string;
	tags?: string[];
}

function envStr(...names: string[]): string | undefined {
	for (const name of names) {
		const v = process.env[name];
		if (v && v.trim()) return v.trim();
	}
	return undefined;
}

function envBool(...names: string[]): boolean | undefined {
	for (const name of names) {
		const v = process.env[name];
		if (v === undefined) continue;
		const s = v.trim().toLowerCase();
		if (['1', 'true', 'yes', 'on'].includes(s)) return true;
		if (['0', 'false', 'no', 'off'].includes(s)) return false;
	}
	return undefined;
}

function toBool(v: unknown): boolean | undefined {
	if (typeof v === 'boolean') return v;
	if (typeof v !== 'string') return undefined;
	const s = v.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on'].includes(s)) return true;
	if (['0', 'false', 'no', 'off'].includes(s)) return false;
	return undefined;
}

function stripQuotes(v: string): string {
	return v.replace(/^["']|["']$/g, '');
}

/**
 * Remove a trailing YAML comment from a scalar value.
 *
 * A `#` starts a comment only at the start of the value or after whitespace, and
 * never inside quotes — so `base_url: http://host/#frag` and `secret_key: "sk-#1"`
 * survive, while `enabled: true  # on by default` does not keep the comment.
 *
 * Users document their config inline (as config.template.yaml does), and feeding
 * `"https://cloud.langfuse.com   # 自建部署改成对应地址"` straight into the SDK
 * fails with "Could not parse user-provided export URL".
 */
export function stripYamlComment(value: string): string {
	let quote = '';
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quote) {
			if (ch === quote) quote = '';
			continue;
		}
		if (ch === '"' || ch === "'") { quote = ch; continue; }
		if (ch === '#' && (i === 0 || /\s/.test(value[i - 1]))) {
			return value.slice(0, i);
		}
	}
	return value;
}

/** Parse a `key: value` scalar the way the config file is written by hand. */
function parseScalarValue(raw: string): string {
	return stripQuotes(stripYamlComment(raw).trim());
}

/**
 * Minimal parser for the top-level `tracing:` section (flat key: value pairs
 * plus a `tags:` block list) — same approach as the `memory:` section parser,
 * because the shared YAML reader in agentConfig only models its own sections.
 */
export function parseTracingYaml(text: string): TracingYamlSection | undefined {
	let inTracing = false;
	let inTags = false;
	const section: TracingYamlSection = {};

	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const indent = line.length - line.trimStart().length;

		if (indent === 0 && trimmed.endsWith(':')) {
			inTracing = trimmed === 'tracing:';
			inTags = false;
			continue;
		}
		if (!inTracing) continue;

		if (indent === 2 && trimmed.startsWith('- ')) {
			if (inTags) {
				section.tags = section.tags || [];
				section.tags.push(parseScalarValue(trimmed.slice(2)));
			}
			continue;
		}
		// Block list items live one level deeper than their `tags:` key.
		if (indent > 2 && trimmed.startsWith('- ')) {
			if (inTags) {
				section.tags = section.tags || [];
				section.tags.push(parseScalarValue(trimmed.slice(2)));
			}
			continue;
		}
		if (indent !== 2) continue;

		const idx = trimmed.indexOf(':');
		if (idx <= 0) continue;
		const key = trimmed.slice(0, idx).trim();
		// Strip an inline `# comment` — the config file is documented in place.
		const rawVal = parseScalarValue(trimmed.slice(idx + 1));
		inTags = key === 'tags';

		if (key === 'enabled') section.enabled = toBool(rawVal);
		else if (key === 'public_key') section.public_key = rawVal;
		else if (key === 'secret_key') section.secret_key = rawVal;
		else if (key === 'base_url') section.base_url = rawVal;
		else if (key === 'host') section.host = rawVal;
		else if (key === 'environment') section.environment = rawVal;
		else if (key === 'release') section.release = rawVal;
		else if (key === 'capture_content') section.capture_content = toBool(rawVal);
		else if (key === 'user_id') section.user_id = rawVal;
		else if (key === 'session_id') section.session_id = rawVal;
	}
	return Object.keys(section).length > 0 ? section : undefined;
}

/** Load the `tracing:` section from the first resolvable config file. */
export function loadTracingYamlSection(): TracingYamlSection | undefined {
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
			if (file.endsWith('.json')) {
				const parsed = JSON.parse(text) as { tracing?: TracingYamlSection };
				if (parsed?.tracing && typeof parsed.tracing === 'object') return parsed.tracing;
				continue;
			}
			const section = parseTracingYaml(text);
			if (section) return section;
		} catch {
			// unreadable/malformed config — keep looking, tracing must fail open
		}
	}
	return undefined;
}

/**
 * Resolve the tracing configuration.
 *
 * @param cliOverride `--tracing on|off` from the command line (highest priority
 *                    after the explicit `LANGFUSE_TRACING_ENABLED=false` kill switch).
 */
export function loadTracingConfig(cliOverride?: 'on' | 'off', release?: string): TracingSettings {
	if (cliOverride === 'off') {
		return { enabled: false, reason: 'disabled by --tracing off' };
	}

	const yaml = loadTracingYamlSection();

	// Env wins over config.yaml; `--tracing on` cannot invent missing keys, so it
	// only overrides an explicit `enabled: false` in the file.
	const envDisabled = envBool('LANGFUSE_TRACING_ENABLED') === false;
	if (envDisabled) {
		return { enabled: false, reason: 'disabled by LANGFUSE_TRACING_ENABLED=false' };
	}
	const yamlEnabled = yaml?.enabled;
	if (yamlEnabled === false && cliOverride !== 'on') {
		return { enabled: false, reason: 'disabled by config.yaml tracing.enabled=false' };
	}

	const publicKey = envStr('LANGFUSE_PUBLIC_KEY') || yaml?.public_key || '';
	const secretKey = envStr('LANGFUSE_SECRET_KEY') || yaml?.secret_key || '';
	const baseUrl = envStr('LANGFUSE_BASE_URL', 'LANGFUSE_HOST')
		|| yaml?.base_url || yaml?.host || 'https://cloud.langfuse.com';

	if (!publicKey || !secretKey) {
		return {
			enabled: false,
			reason: 'no Langfuse API keys (set LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY, '
				+ 'or config.yaml tracing.public_key/secret_key)',
		};
	}

	const source = envStr('LANGFUSE_PUBLIC_KEY')
		? 'environment (LANGFUSE_*)'
		: 'config.yaml tracing section';

	const captureContent = envBool('LANGFUSE_CAPTURE_CONTENT')
		?? yaml?.capture_content
		?? true;

	const tags = (yaml?.tags || []).filter(t => typeof t === 'string' && t.trim().length > 0);

	return {
		enabled: true,
		source,
		config: {
			publicKey,
			secretKey,
			baseUrl,
			environment: envStr('LANGFUSE_TRACING_ENVIRONMENT') || yaml?.environment,
			release: envStr('LANGFUSE_RELEASE') || yaml?.release || release,
			captureContent,
			userId: envStr('LANGFUSE_USER_ID') || yaml?.user_id,
			sessionId: envStr('LANGFUSE_SESSION_ID') || yaml?.session_id,
			tags,
		},
	};
}

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------

/**
 * Redaction patterns applied to every string that leaves the process.
 *
 * These are deliberately broad: a trace is a copy of the conversation, so any
 * credential the agent read or printed (a `.npmrc` token, a `git remote` URL, an
 * API key in `models.json`) would otherwise be duplicated into a third-party
 * system. Over-masking a code snippet is harmless; leaking a key is not.
 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
	// Langfuse / OpenAI-style keys: sk-lf-…, pk-lf-…, sk-proj-…, sk-ant-…
	[/\b(?:sk|pk|rk)-(?:lf|proj|ant|or|live|test)?-?[A-Za-z0-9_-]{12,}/g, '<redacted-key>'],
	// Authorization headers and bearer tokens
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer <redacted>'],
	// JWT (memory hub, Dolphin MCP)
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<redacted-jwt>'],
	// key = value / "key": "value" for anything that looks like a credential
	[
		/((?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}{)\]]{6,})/gi,
		'$1<redacted>',
	],
];

/** Mask secrets inside a string. */
export function redactSecrets(text: string): string {
	let out = text;
	for (const [pattern, replacement] of SECRET_PATTERNS) {
		out = out.replace(pattern, replacement);
	}
	return out;
}

/** Deep-mask secrets in any JSON-ish value (objects, arrays, strings). */
export function redactDeep<T>(value: T, depth = 0): T {
	if (depth > 12) return value;
	if (typeof value === 'string') return redactSecrets(value) as unknown as T;
	if (Array.isArray(value)) return value.map(v => redactDeep(v, depth + 1)) as unknown as T;
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = redactDeep(v, depth + 1);
		}
		return out as unknown as T;
	}
	return value;
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}\n... (${text.length} chars total, truncated)` : text;
}

// ---------------------------------------------------------------------------
// Tracing facade
// ---------------------------------------------------------------------------

export type ObservationLevel = 'DEBUG' | 'DEFAULT' | 'WARNING' | 'ERROR';

/** Attributes we may set on an observation (subset of the SDK's). */
export interface IObservationAttrs {
	input?: unknown;
	output?: unknown;
	metadata?: Record<string, unknown>;
	level?: ObservationLevel;
	statusMessage?: string;
	model?: string;
	modelParameters?: Record<string, string | number>;
	usageDetails?: Record<string, number>;
	completionStartTime?: Date;
}

/** Live observation passed to the wrapped callback so it can attach results. */
export interface IObservationHandle {
	update(attrs: IObservationAttrs): void;
}

/**
 * Opaque parent reference (trace + span id) used to attach a child observation
 * to a step that is NOT the currently active span.
 *
 * Why this exists: the ReAct loop transfers control with `continue`/`break`, so a
 * step cannot be wrapped in a callback (`startActiveObservation`); it is created
 * manually at the top of each iteration and ended in a `finally`. Children of
 * that step then have to name it explicitly. The reference is passed as a local
 * variable, which also keeps concurrent parallel subagents from sharing state.
 */
export interface ISpanRef {
	readonly traceId: string;
	readonly spanId: string;
}

/** A manually managed step observation. `end()` is idempotent. */
export interface IStepHandle extends IObservationHandle {
	/** Null when tracing is disabled. */
	readonly ref: ISpanRef | null;
	end(): void;
}

export interface ITaskMeta {
	name?: string;
	/** Trace-level input — set only the user-visible task text. */
	input?: unknown;
	metadata?: Record<string, unknown>;
	tags?: string[];
	sessionId?: string;
	userId?: string;
	output?: unknown;
}

export interface IGenerationMeta {
	name?: string;
	model?: string;
	modelParameters?: Record<string, string | number>;
	input?: unknown;
	metadata?: Record<string, unknown>;
	startTime?: Date;
}

export interface IToolMeta {
	name: string;
	input?: unknown;
	metadata?: Record<string, unknown>;
}

/**
 * Tracing surface used by AgentLoop / ParallelAgentManager.
 *
 * `run*` methods wrap a callback: the observation is always ended, even when the
 * callback throws, and thrown errors are recorded at ERROR level before being
 * re-thrown. `beginStep` is the manual variant, for the ReAct iteration that
 * cannot be wrapped in a callback.
 */
export interface IAgentTracing {
	readonly enabled: boolean;
	/** Why tracing is off (only set when `enabled` is false). */
	readonly reason?: string;
	/** One-line description of the active backend (for the startup status line). */
	describe?(): string;
	/** Load the SDK. Returns false when tracing had to be turned off. */
	init(): Promise<boolean>;
	runTask<T>(meta: ITaskMeta, fn: (obs: IObservationHandle) => Promise<T>): Promise<T>;
	/** Begin a step observation; caller MUST `end()` it (a `finally` is expected). */
	beginStep(meta: ITaskMeta): IStepHandle;
	runGeneration<T>(meta: IGenerationMeta, fn: (obs: IObservationHandle) => Promise<T>, parent?: ISpanRef | null): Promise<T>;
	runTool<T>(meta: IToolMeta, fn: (obs: IObservationHandle) => Promise<T>, parent?: ISpanRef | null): Promise<T>;
	/** A dispatched subagent: typed `agent` so it becomes its own Agent Graph node. */
	runSubagent<T>(meta: ITaskMeta, fn: (obs: IObservationHandle) => Promise<T>): Promise<T>;
	flush(): Promise<void>;
	shutdown(): Promise<void>;
}

const NOOP_HANDLE: IObservationHandle = { update: () => { /* nothing to do */ } };
const NOOP_STEP: IStepHandle = { ref: null, update: () => { /* nothing to do */ }, end: () => { /* nothing to do */ } };

/** Zero-cost implementation used whenever tracing is disabled or unavailable. */
export class NoopTracing implements IAgentTracing {
	readonly enabled = false;
	readonly reason?: string;
	constructor(reason?: string) {
		this.reason = reason;
	}
	async init(): Promise<boolean> {
		return false;
	}
	async runTask<T>(_meta: ITaskMeta, fn: (obs: IObservationHandle) => Promise<T>): Promise<T> {
		return fn(NOOP_HANDLE);
	}
	beginStep(_meta: ITaskMeta): IStepHandle {
		return NOOP_STEP;
	}
	async runGeneration<T>(_meta: IGenerationMeta, fn: (obs: IObservationHandle) => Promise<T>): Promise<T> {
		return fn(NOOP_HANDLE);
	}
	async runTool<T>(_meta: IToolMeta, fn: (obs: IObservationHandle) => Promise<T>): Promise<T> {
		return fn(NOOP_HANDLE);
	}
	async runSubagent<T>(_meta: ITaskMeta, fn: (obs: IObservationHandle) => Promise<T>): Promise<T> {
		return fn(NOOP_HANDLE);
	}
	async flush(): Promise<void> { /* no-op */ }
	async shutdown(): Promise<void> { /* no-op */ }
}

/** Shared no-op instance (AgentLoop default when no tracing is injected). */
export const NOOP_TRACING: IAgentTracing = new NoopTracing();

/** Structural view of the SDK pieces we use (avoids a hard type dependency). */
interface SdkModules {
	tracing: {
		startObservation: (name: string, attrs: Record<string, unknown>, options?: Record<string, unknown>) => SdkObservation;
		startActiveObservation: (name: string, fn: (obs: SdkObservation) => unknown, options?: Record<string, unknown>) => unknown;
		propagateAttributes: (params: Record<string, unknown>, fn: () => unknown) => unknown;
		getActiveTraceId: () => string | undefined;
	};
	processor: { forceFlush: () => Promise<void>; shutdown: () => Promise<void> };
}

interface SdkObservation {
	readonly id: string;
	readonly traceId: string;
	update: (attrs: Record<string, unknown>) => void;
	end: () => void;
}

/** Build the complete SpanContext required to parent a non-active observation. */
function spanContextOf(ref: ISpanRef): Record<string, unknown> {
	// `traceFlags` is mandatory: a bare {traceId, spanId} is an invalid span
	// context and the SDK silently drops the child (verified empirically).
	return { traceId: ref.traceId, spanId: ref.spanId, traceFlags: 1, isRemote: false };
}

/**
 * Langfuse-backed implementation.
 *
 * The SDK is loaded lazily on `init()` so that a run without tracing (or a
 * portable bundle without the optional packages) pays nothing — the imports are
 * marked external in build.mjs and resolved at runtime.
 */
export class LangfuseTracing implements IAgentTracing {
	readonly enabled = true;
	private _sdk?: SdkModules;
	private _initPromise?: Promise<boolean>;

	constructor(private readonly _config: TracingConfig) {}

	/** Public key + base URL are enough for a safe status line (never the secret). */
	describe(): string {
		const env = this._config.environment ? ` env=${this._config.environment}` : '';
		return `Langfuse ${this._config.baseUrl}${env} (content=${this._config.captureContent ? 'full' : 'metadata-only'})`;
	}

	async init(): Promise<boolean> {
		if (!this._initPromise) {
			this._initPromise = this._init().catch(err => {
				console.warn(`[TRACING] Langfuse SDK unavailable, tracing disabled: ${(err as Error).message}`);
				return false;
			});
		}
		return this._initPromise;
	}

	private async _init(): Promise<boolean> {
		// Loaded lazily and concurrently; the specifiers are marked external in
		// build.mjs so a missing install degrades to "tracing disabled".
		const [otel, tracing, sdkTrace] = await Promise.all([
			import('@langfuse/otel'),
			import('@langfuse/tracing'),
			import('@opentelemetry/sdk-trace-node'),
		]);

		const processor = new (otel as any).LangfuseSpanProcessor({
			publicKey: this._config.publicKey,
			secretKey: this._config.secretKey,
			baseUrl: this._config.baseUrl,
			environment: this._config.environment,
			release: this._config.release,
			// Long-running CLI: batch (default) and flush explicitly on exit.
			exportMode: 'batched',
			// Official masking hook — applied to every exported attribute value.
			mask: (params: { data: unknown }) => redactDeep(params.data),
		});

		const provider = new (sdkTrace as any).NodeTracerProvider({
			spanProcessors: [processor],
		});
		provider.register();

		this._sdk = {
			tracing: tracing as unknown as SdkModules['tracing'],
			processor,
		};
		return true;
	}

	private get _ready(): boolean {
		return !!this._sdk;
	}

	/**
	 * Wrap a callback in an active observation.
	 *
	 * When no observation is active yet this becomes the trace root (and the
	 * trace-level attributes are propagated); inside an existing trace it is a
	 * plain child span — which is exactly what a subagent needs, since it must
	 * inherit the orchestrator's trace instead of renaming it.
	 *
	 * `parent`, when given, attaches the observation to a step that is not the
	 * active span (see `beginStep`).
	 */
	private async _run<T>(
		type: string,
		name: string,
		attrs: Record<string, unknown>,
		fn: (obs: IObservationHandle) => Promise<T>,
		traceAttrs?: Record<string, unknown>,
		parent?: ISpanRef | null,
	): Promise<T> {
		if (!this._ready) return fn(NOOP_HANDLE);
		try {
			const options: Record<string, unknown> = { asType: type };
			if (parent) options.parentSpanContext = spanContextOf(parent);
			const run = () => this._sdk!.tracing.startActiveObservation(
				name,
				(obs: SdkObservation) => this._invoke(obs, attrs, fn, type),
				options,
			);
			const parentActive = this._sdk!.tracing.getActiveTraceId() !== undefined;
			return await (parentActive || !traceAttrs
				? run()
				: this._sdk!.tracing.propagateAttributes(traceAttrs, run)) as T;
		} catch (err) {
			// Instrumentation must never break the agent run.
			console.warn(`[TRACING] ${name} instrumentation failed (non-fatal): ${(err as Error).message}`);
			return fn(NOOP_HANDLE);
		}
	}

	/**
	 * Start the step observation for one ReAct iteration.
	 *
	 * Created as a child of whatever is active (the task span, or a subagent's
	 * agent span) and ended by the caller in a `finally` — which keeps the loop's
	 * `continue`/`break` control flow untouched.
	 */
	beginStep(meta: ITaskMeta): IStepHandle {
		if (!this._ready) return NOOP_STEP;
		try {
			const obs = this._sdk!.tracing.startObservation(
				meta.name || 'agent-step',
				this._shape({ metadata: meta.metadata }, 'span'),
				{ asType: 'span' },
			);
			return this._stepHandle(obs, meta);
		} catch (err) {
			console.warn(`[TRACING] step instrumentation failed (non-fatal): ${(err as Error).message}`);
			return NOOP_STEP;
		}
	}

	private _stepHandle(obs: SdkObservation, meta: ITaskMeta): IStepHandle {
		let ended = false;
		const ref: ISpanRef | null = obs.traceId && obs.id
			? { traceId: obs.traceId, spanId: obs.id }
			: null;
		return {
			ref,
			update: attrs => {
				if (ended) return;
				try {
					obs.update(this._shape(attrs, 'span'));
				} catch { /* never let an update break the run */ }
			},
			end: () => {
				if (ended) return;
				ended = true;
				try {
					obs.end();
				} catch { /* ignore */ }
			},
		};
	}

	private async _invoke<T>(
		obs: SdkObservation,
		attrs: Record<string, unknown>,
		fn: (obs: IObservationHandle) => Promise<T>,
		type: string,
	): Promise<T> {
		const handle: IObservationHandle = {
			update: next => {
				try {
					obs.update(this._shape(next, type));
				} catch { /* never let an update break the run */ }
			},
		};
		try {
			obs.update(this._shape(attrs, type));
			const result = await fn(handle);
			obs.end();
			return result;
		} catch (err) {
			try {
				obs.update({
					level: 'ERROR',
					statusMessage: (err as Error).message?.slice(0, MAX_META_VALUE_LEN),
				});
			} catch { /* ignore */ }
			obs.end();
			throw err;
		}
	}

	/**
	 * Turn our attribute bag into SDK attributes, honouring `captureContent`.
	 *
	 * `captureContent: false` keeps the trace useful for latency/cost/error
	 * analysis while sending no prompt, output or tool payload at all.
	 */
	private _shape(attrs: IObservationAttrs, type: string): Record<string, unknown> {
		const out: Record<string, unknown> = {};
		const capture = this._config.captureContent;

		if (capture && attrs.input !== undefined) out.input = this._input(attrs.input);
		if (capture && attrs.output !== undefined) out.output = redactDeep(attrs.output);
		if (attrs.metadata) out.metadata = redactDeep(attrs.metadata);
		if (attrs.level) out.level = attrs.level;
		if (attrs.statusMessage) out.statusMessage = redactSecrets(attrs.statusMessage).slice(0, MAX_META_VALUE_LEN);
		if (type === 'generation') {
			if (attrs.model) out.model = attrs.model;
			if (attrs.modelParameters) out.modelParameters = attrs.modelParameters;
			if (attrs.usageDetails) out.usageDetails = attrs.usageDetails;
			if (attrs.completionStartTime) out.completionStartTime = attrs.completionStartTime;
		}
		return out;
	}

	/** Redact + bound the input payload (message arrays are the common case). */
	private _input(input: unknown): unknown {
		if (Array.isArray(input)) {
			return input.map(item => {
				if (!item || typeof item !== 'object') return redactDeep(item);
				const msg = item as Record<string, unknown>;
				const copy: Record<string, unknown> = { ...msg };
				if (typeof copy.content === 'string') {
					copy.content = truncate(redactSecrets(copy.content), MAX_MESSAGE_CHARS);
				}
				if (typeof copy.reasoningContent === 'string') {
					copy.reasoningContent = truncate(redactSecrets(copy.reasoningContent), MAX_REASONING_CHARS);
				}
				return copy;
			});
		}
		if (typeof input === 'string') return truncate(redactSecrets(input), MAX_MESSAGE_CHARS);
		return redactDeep(input);
	}

	async runTask<T>(meta: ITaskMeta, fn: (obs: IObservationHandle) => Promise<T>): Promise<T> {
		if (!this._ready) return fn(NOOP_HANDLE);
		const traceAttrs: Record<string, unknown> = {
			traceName: clip(meta.name || 'agent-task'),
			tags: [...this._config.tags, ...(meta.tags || [])],
			metadata: stringifyMeta({
				...meta.metadata,
				app: 'code-agent',
				...(this._config.release ? { release: this._config.release } : {}),
			}),
		};
		const userId = meta.userId || this._config.userId;
		const sessionId = meta.sessionId || this._config.sessionId;
		if (userId) traceAttrs.userId = clip(userId);
		if (sessionId) traceAttrs.sessionId = clip(sessionId);

		return this._run('span', meta.name || 'agent-task', {
			input: meta.input,
			metadata: meta.metadata,
		}, fn, traceAttrs);
	}

	async runGeneration<T>(meta: IGenerationMeta, fn: (obs: IObservationHandle) => Promise<T>, parent?: ISpanRef | null): Promise<T> {
		return this._run('generation', meta.name || 'llm-call', {
			model: meta.model,
			modelParameters: meta.modelParameters,
			completionStartTime: meta.startTime,
			input: meta.input,
			metadata: meta.metadata,
		}, fn, undefined, parent);
	}

	async runTool<T>(meta: IToolMeta, fn: (obs: IObservationHandle) => Promise<T>, parent?: ISpanRef | null): Promise<T> {
		return this._run('tool', `tool:${meta.name}`, {
			input: meta.input,
			metadata: meta.metadata,
		}, fn, undefined, parent);
	}

	async runSubagent<T>(meta: ITaskMeta, fn: (obs: IObservationHandle) => Promise<T>): Promise<T> {
		return this._run('agent', meta.name || 'subagent', {
			input: meta.input,
			metadata: meta.metadata,
		}, fn);
	}

	async flush(): Promise<void> {
		if (!this._sdk) return;
		try {
			await this._sdk.processor.forceFlush();
		} catch { /* flush is best-effort */ }
	}

	async shutdown(): Promise<void> {
		if (!this._sdk) return;
		try {
			await this._sdk.processor.forceFlush();
		} catch { /* ignore */ }
		try {
			await this._sdk.processor.shutdown();
		} catch { /* ignore */ }
		this._sdk = undefined;
	}
}

function clip(v: string): string {
	return v.length > MAX_ID_LEN ? v.slice(0, MAX_ID_LEN) : v;
}

/**
 * Best-effort OS user name for trace attribution.
 *
 * `USER`/`LOGNAME` are unset in plenty of environments (cron, containers,
 * some CI shells), and `process.env` alone then silently drops user
 * attribution — which is what makes per-user cost/quality filtering possible.
 */
export function currentUserName(): string | undefined {
	const fromEnv = process.env.USER || process.env.LOGNAME || process.env.USERNAME;
	if (fromEnv) return fromEnv;
	try {
		return os.userInfo().username || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Propagated metadata must be a flat map of strings ≤200 chars; nested or
 * oversized values are dropped by the SDK with a warning, so we flatten first.
 */
export function stringifyMeta(meta: Record<string, unknown> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(meta || {})) {
		if (v === undefined || v === null) continue;
		const s = typeof v === 'string' ? v : JSON.stringify(v);
		if (s === undefined) continue;
		out[k] = s.length > MAX_META_VALUE_LEN ? `${s.slice(0, MAX_META_VALUE_LEN - 1)}…` : s;
	}
	return out;
}

/** Build the tracing facade for the given settings. */
export function createTracing(settings: TracingSettings): IAgentTracing {
	return settings.enabled && settings.config
		? new LangfuseTracing(settings.config)
		: new NoopTracing(settings.reason);
}

/** Convenience: resolve config and build the facade in one step. */
export function initTracingFromConfig(cliOverride?: 'on' | 'off', release?: string): IAgentTracing {
	return createTracing(loadTracingConfig(cliOverride, release));
}
