/*---------------------------------------------------------------------------------------------
 *  Agent Configuration - YAML + JSON config with models.json support
 *  
 *  Resolution order:
 *    1. CLI flags (--profile, --model, etc.)
 *    2. Environment variables (OPENAI_API_KEY, LLM_MODEL, etc.)
 *    3. Project config.yaml / config.json (in CWD)
 *    4. Global ~/.codeagent/config.yaml / config.json
 *    5. models.json (CodeBuddy-compatible, ~/.codeagent/models.json or ~/.codebuddy/models.json)
 *    6. Built-in defaults
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { IAgentConfig, DEFAULT_AGENT_CONFIG } from 'vs/workbench/services/agent/common/agentModels';

interface ConfigProfile {
	provider: string;
	model: string;
	api_key: string;
	api_base?: string;
	temperature?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
}

interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	type?: string;
	headers?: Record<string, string>;
}

interface ConfigFile {
	active_profile?: string;
	profiles?: Record<string, ConfigProfile>;
	agent?: {
		max_steps?: number;
		max_context_tokens?: number;
		temperature?: number;
		step_timeout?: number;
		task_timeout?: number;
	};
	skills?: string[];
	rules?: string[];
	mcp_servers?: Record<string, McpServerConfig>;
}

// CodeBuddy-compatible models.json entry
interface ModelEntry {
	id: string;
	name?: string;
	vendor?: string;
	apiKey: string;
	url: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	supportsToolCall?: boolean;
	supportsImages?: boolean;
	supportsReasoning?: boolean;
	thinking?: { type: string };
	maxTokens?: number;
}

interface ModelsFile {
	models: ModelEntry[];
	availableModels?: string[];
}

function parseYaml(text: string): ConfigFile {
	const result: ConfigFile = {};
	const lines = text.split('\n');
	let currentSection = '';
	let currentProfile = '';
	let inList = false;
	let listKey = '';

	for (const line of lines) {
		const trimmed = line.trimEnd();
		if (!trimmed || trimmed.trimStart().startsWith('#')) continue;

		const indent = line.length - line.trimStart().length;

		if (indent === 0 && trimmed.endsWith(':')) {
			currentSection = trimmed.slice(0, -1);
			currentProfile = '';
			inList = false;
			if (currentSection === 'profiles') result.profiles = result.profiles || {};
			if (currentSection === 'agent') result.agent = result.agent || {};
			continue;
		}

		if (indent === 0 && trimmed.includes(':')) {
			const [key, ...rest] = trimmed.split(':');
			const val = rest.join(':').trim();
			if (key.trim() === 'active_profile') result.active_profile = val;
			continue;
		}

		if (currentSection === 'profiles' && indent === 2 && trimmed.endsWith(':')) {
			currentProfile = trimmed.slice(0, -1).trim();
			result.profiles![currentProfile] = { provider: '', model: '', api_key: '' };
			continue;
		}

		if (currentSection === 'profiles' && indent === 4 && currentProfile) {
			const [key, ...rest] = trimmed.split(':');
			const val = rest.join(':').trim();
			const k = key.trim();
			const profile = result.profiles![currentProfile];
			if (k === 'provider') profile.provider = val;
			else if (k === 'model') profile.model = val;
			else if (k === 'api_key') profile.api_key = val.replace(/^["']|["']$/g, '');
			else if (k === 'api_base') profile.api_base = val;
			else if (k === 'temperature') profile.temperature = parseFloat(val);
			else if (k === 'max_input_tokens') profile.max_input_tokens = parseInt(val, 10);
			else if (k === 'max_output_tokens') profile.max_output_tokens = parseInt(val, 10);
			continue;
		}

		if (currentSection === 'agent' && indent === 2) {
			const [key, ...rest] = trimmed.split(':');
			const val = rest.join(':').trim();
			const k = key.trim();
			if (!result.agent) result.agent = {};
			if (k === 'max_steps') result.agent.max_steps = parseInt(val, 10);
			else if (k === 'max_context_tokens') result.agent.max_context_tokens = parseInt(val, 10);
			else if (k === 'temperature') result.agent.temperature = parseFloat(val);
			else if (k === 'step_timeout') result.agent.step_timeout = parseInt(val, 10);
			else if (k === 'task_timeout') result.agent.task_timeout = parseInt(val, 10);
			continue;
		}

		if (currentSection === 'mcp_servers' && indent === 2 && trimmed.endsWith(':')) {
			currentProfile = trimmed.slice(0, -1).trim();
			if (!result.mcp_servers) result.mcp_servers = {};
			result.mcp_servers[currentProfile] = {};
			continue;
		}

		if (currentSection === 'mcp_servers' && indent === 4 && currentProfile) {
			const [key, ...rest] = trimmed.split(':');
			const val = rest.join(':').trim();
			const k = key.trim();
			const srv = result.mcp_servers![currentProfile];
			if (k === 'command') srv.command = val;
			else if (k === 'url') srv.url = val;
			else if (k === 'type') srv.type = val;
			else if (k === 'headers') {
				if (!srv.headers) srv.headers = {};
				// headers section starts
			}
			else if (k === 'args') {
				// single-line shorthand: args: --port 8080
				if (val) srv.args = val.split(/\s+/);
			}
			continue;
		}

		if (currentSection === 'mcp_servers' && indent === 6 && currentProfile) {
			const srv = result.mcp_servers?.[currentProfile];
			if (srv && trimmed.trimStart().startsWith('- ')) {
				// args list item
				const val = trimmed.trimStart().slice(2).trim();
				if (!srv.args) srv.args = [];
				srv.args.push(val);
			} else if (srv && srv.headers !== undefined) {
				// headers key-value pair
				const [key, ...rest] = trimmed.split(':');
				const val = rest.join(':').trim();
				srv.headers[key.trim()] = val;
			}
			continue;
		}

		if (currentSection === 'mcp_servers' && indent === 6 && trimmed.trimStart().startsWith('- ')) {
			const val = trimmed.trimStart().slice(2).trim();
			const srv = result.mcp_servers?.[currentProfile];
			if (srv) {
				if (!srv.args) srv.args = [];
				srv.args.push(val);
			}
			continue;
		}

		if ((currentSection === 'skills' || currentSection === 'rules') && trimmed.trimStart().startsWith('- ')) {
			const val = trimmed.trimStart().slice(2).trim();
			if (!result[currentSection as 'skills' | 'rules']) {
				(result as any)[currentSection] = [];
			}
			(result as any)[currentSection].push(val);
			continue;
		}
	}

	return result;
}

function findConfigFile(): string | undefined {
	const candidates = [
		path.join(process.cwd(), 'config.yaml'),
		path.join(process.cwd(), 'config.json'),
		path.join(os.homedir(), '.codeagent', 'config.yaml'),
		path.join(os.homedir(), '.codeagent', 'config.json'),
	];
	return candidates.find(p => fs.existsSync(p));
}

function findModelsJson(): string | undefined {
	const candidates = [
		path.join(process.cwd(), 'models.json'),
		path.join(os.homedir(), '.codeagent', 'models.json'),
		path.join(os.homedir(), '.codebuddy', 'models.json'),  // shared compat
	];
	return candidates.find(p => fs.existsSync(p));
}

/** Convert a models.json ModelEntry to a ConfigProfile */
function modelEntryToProfile(entry: ModelEntry): ConfigProfile {
	// Strip /chat/completions suffix if present, to get base URL
	const apiBase = entry.url.replace(/\/chat\/completions\/?$/, '');
	return {
		provider: 'openai',
		model: entry.id,
		api_key: entry.apiKey,
		api_base: apiBase,
		max_input_tokens: entry.maxInputTokens,
		max_output_tokens: entry.maxOutputTokens || entry.maxTokens,
	};
}

/** Load models from a CodeBuddy-compatible models.json file */
function loadModelsJson(): Record<string, ConfigProfile> | undefined {
	const modelsPath = findModelsJson();
	if (!modelsPath) return undefined;

	try {
		const raw = fs.readFileSync(modelsPath, 'utf-8');
		const data: ModelsFile = JSON.parse(raw);
		const profiles: Record<string, ConfigProfile> = {};
		for (const entry of data.models) {
			profiles[entry.id] = modelEntryToProfile(entry);
		}
		return profiles;
	} catch {
		return undefined;
	}
}

function resolveHomePath(p: string): string {
	if (p.startsWith('~/') || p.startsWith('~\\')) {
		return path.join(os.homedir(), p.slice(2));
	}
	return path.resolve(p);
}

export interface McpServerEntry {
	name: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	type?: string;
	headers?: Record<string, string>;
}

export interface ResolvedConfig {
	agentConfig: IAgentConfig;
	skillsDirs: string[];
	rulesDirs: string[];
	profileName: string;
	configFilePath?: string;
	mcpServers: McpServerEntry[];
}

export function loadConfig(cliProfile?: string): ResolvedConfig {
	let fileConfig: ConfigFile = {};
	const configPath = findConfigFile();

	if (configPath) {
		try {
			const raw = fs.readFileSync(configPath, 'utf-8');
			fileConfig = configPath.endsWith('.json')
				? JSON.parse(raw) as ConfigFile
				: parseYaml(raw);
		} catch {
			// ignore parse errors, fall through to env/defaults
		}
	}

	// Load models from models.json (CodeBuddy-compatible format)
	const modelsProfiles = loadModelsJson();
	if (modelsProfiles) {
		// Merge: models.json provides model definitions, config.yaml profiles take precedence
		fileConfig.profiles = { ...modelsProfiles, ...fileConfig.profiles };
	}

	// Resolve profile name with smart default: if only models.json is available
	// and no active_profile is set, auto-select the first model
	let profileName = cliProfile
		|| process.env.AGENT_PROFILE
		|| fileConfig.active_profile
		|| undefined;

	if (!profileName && fileConfig.profiles && Object.keys(fileConfig.profiles).length > 0) {
		profileName = Object.keys(fileConfig.profiles)[0];
	} else if (!profileName) {
		profileName = 'default';
	}

	const profile = fileConfig.profiles?.[profileName];
	if (fileConfig.profiles && !profile && profileName !== 'default') {
		const available = Object.keys(fileConfig.profiles).join(', ');
		console.warn(`Warning: profile "${profileName}" not found in config. Available: ${available}`);
	}

	const agentConfig: IAgentConfig = {
		...DEFAULT_AGENT_CONFIG,
		provider: (process.env.LLM_PROVIDER || profile?.provider || DEFAULT_AGENT_CONFIG.provider) as any,
		model: process.env.LLM_MODEL || profile?.model || DEFAULT_AGENT_CONFIG.model,
		apiKey: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || profile?.api_key || '',
		apiBase: process.env.LLM_API_BASE || profile?.api_base || undefined,
		maxSteps: fileConfig.agent?.max_steps || DEFAULT_AGENT_CONFIG.maxSteps,
		maxContextTokens: profile?.max_input_tokens || fileConfig.agent?.max_context_tokens || DEFAULT_AGENT_CONFIG.maxContextTokens,
		maxOutputTokens: profile?.max_output_tokens || DEFAULT_AGENT_CONFIG.maxOutputTokens,
		temperature: profile?.temperature ?? fileConfig.agent?.temperature ?? DEFAULT_AGENT_CONFIG.temperature,
		stepTimeout: fileConfig.agent?.step_timeout || DEFAULT_AGENT_CONFIG.stepTimeout,
		taskTimeout: fileConfig.agent?.task_timeout || DEFAULT_AGENT_CONFIG.taskTimeout,
	};

	const skillsDirs = (fileConfig.skills || ['~/.cursor/skills']).map(resolveHomePath);
	const rulesDirs = (fileConfig.rules || ['~/.cursor/rules']).map(resolveHomePath);

	const mcpServers: McpServerEntry[] = Object.entries(fileConfig.mcp_servers || {}).map(
		([name, srv]) => ({ name, ...srv })
	);

	return { agentConfig, skillsDirs, rulesDirs, profileName, configFilePath: configPath, mcpServers };
}

export function loadConfigForProfile(profileName: string): ResolvedConfig {
	return loadConfig(profileName);
}

export function listProfiles(): Array<{ name: string; provider: string; model: string }> {
	// First check models.json
	const modelsProfiles = loadModelsJson();
	if (modelsProfiles) {
		return Object.entries(modelsProfiles).map(([name, p]) => ({
			name,
			provider: p.provider,
			model: p.model,
		}));
	}

	// Fall back to config.yaml
	const configPath = findConfigFile();
	if (!configPath) return [];

	try {
		const raw = fs.readFileSync(configPath, 'utf-8');
		const config = parseYaml(raw);
		return Object.entries(config.profiles || {}).map(([name, p]) => ({
			name,
			provider: p.provider,
			model: p.model,
		}));
	} catch {
		return [];
	}
}
