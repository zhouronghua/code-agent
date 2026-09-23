/*---------------------------------------------------------------------------------------------
 *  CodeAgent CLI - TypeScript entry point
 *
 *  Usage:
 *    agent-cli "your task"                                  # Agent mode
 *    agent-cli --mode plan "your task"                      # Plan mode
 *    agent-cli --mode ask "your question"                   # Ask mode
 *    agent-cli --parallel "task1" "task2"                   # Parallel agents
 *    agent-cli --stream "your task"                         # Streaming output
 *    agent-cli --profile deepseek "your task"               # Use specific config profile
 *    agent-cli --profiles                                   # List available profiles
 *    agent-cli --skills                                     # List loaded skills
 *    agent-cli --use-skill cpp-forge "compile my project"   # Activate a specific skill
 *    agent-cli --temperature 0 --top-k 1 --memory off "task"  # Pin sampling params (benchmarks)
 *    agent-cli --version                                    # Show version
 *
 *  Config resolution (highest priority first):
 *    1. CLI flags
 *    2. Environment variables (OPENAI_API_KEY, LLM_MODEL, etc.)
 *    3. ./config.yaml
 *    4. ~/.agent/config.yaml (legacy ~/.codeagent still read)
 *--------------------------------------------------------------------------------------------*/

import * as readline from 'node:readline';
import * as nodePath from 'node:path';
import * as nodeOs from 'node:os';
import * as fs from 'node:fs';
import { URI } from '../base/common/uri';
import { AgentMode, MessageRole } from '../../src/vs/workbench/services/agent/common/agentModels';
import { LLMProviderFactory } from '../../src/vs/workbench/services/agent/browser/llmProvider';
import '../../src/vs/workbench/services/agent/browser/llmOpenai';
import { ToolRegistry } from '../../src/vs/workbench/contrib/agent/common/agentTools';
import { AgentModeManager } from '../../src/vs/workbench/contrib/agent/common/agentModes';
import { AgentCheckpointManager } from '../../src/vs/workbench/contrib/agent/common/agentCheckpoint';
import { AgentLoop, formatModelSwitch, formatReasoningForLog } from '../../src/vs/workbench/contrib/agent/common/agent';
import { ParallelAgentManager } from '../../src/vs/workbench/contrib/agent/common/agentParallel';
import { IMemoryIntegration } from '../../src/vs/workbench/contrib/agent/common/agentMemory';
import { ReadFileTool } from '../../src/vs/workbench/contrib/agent/common/tools/readFile';
import { WriteFileTool } from '../../src/vs/workbench/contrib/agent/common/tools/writeFile';
import { EditFileTool } from '../../src/vs/workbench/contrib/agent/common/tools/editFile';
import { ListDirectoryTool } from '../../src/vs/workbench/contrib/agent/common/tools/listDir';
import { SearchTextTool } from '../../src/vs/workbench/contrib/agent/common/tools/searchText';
import { SearchFilesTool } from '../../src/vs/workbench/contrib/agent/common/tools/searchFiles';
import { RunTerminalTool } from '../../src/vs/workbench/contrib/agent/common/tools/runTerminal';
import { PollTool } from '../../src/vs/workbench/contrib/agent/common/tools/poll';
import { loadMcpServersFromJsonFile, registerMcpTools, McpServerSpec } from '../../src/vs/workbench/contrib/agent/common/agentMcp';
import { loadConfig, loadConfigForProfile, listProfiles, ResolvedConfig } from '../../src/vs/workbench/contrib/agent/common/agentConfig';
import { ModelRouter } from '../../src/vs/workbench/contrib/agent/common/agentModelRouter';
import { SkillsLoader } from '../../src/vs/workbench/contrib/agent/common/agentSkills';
import { defaultSkillsDir } from '../../src/vs/workbench/contrib/agent/common/agentSkillFactory';
import { agentInstructionFiles, agentHomeDir, migrateLegacyAgentHome } from '../../src/vs/workbench/contrib/agent/common/agentHome';
import { SkillCatalogTool, CreateSkillTool, UpdateSkillTool } from '../../src/vs/workbench/contrib/agent/common/tools/skillTools';
import { loadMemoryConfig, MemoryClient, MemorySearchTool, ConversationSearchTool, MemoryReadTool, MemoryWriteTool } from '../../src/vs/workbench/contrib/agent/common/agentMemory';
import { IAgentTracing, NOOP_TRACING, initTracingFromConfig } from '../../src/vs/workbench/contrib/agent/common/agentTracing';
import { SelfUpdateConfig, loadSelfUpdateConfig, buildSelfEvolvePromptSection, collectRunEvidence, formatEvidenceReport } from '../../src/vs/workbench/contrib/agent/common/agentSelfImprove';
import { SelfScanTool, AgentReleaseTool } from '../../src/vs/workbench/contrib/agent/common/tools/selfImproveTools';
import { getSystemPrompt } from '../../src/vs/workbench/contrib/agent/common/agentPrompts';
import { AgentSessionManager } from '../../src/vs/workbench/contrib/agent/common/agentSessions';
import { TaskLogManager } from '../../src/vs/workbench/contrib/agent/common/agentTaskLog';
import { NodeFileService } from './nodeFileService';
import { NodeSearchService } from './nodeSearchService';
import { NodeTerminalService } from './nodeTerminalService';

const C = {
	reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
	red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
	blue: '\x1b[34m', cyan: '\x1b[36m', gray: '\x1b[90m',
	magenta: '\x1b[35m',
};

function log(color: string, prefix: string, msg: string) {
	console.log(`${color}${C.bold}[${prefix}]${C.reset} ${msg}`);
}

function expandHomePath(p: string): string {
	if (p.startsWith('~/')) return nodePath.join(nodeOs.homedir(), p.slice(2));
	return nodePath.resolve(p);
}

/**
 * Batch mode: tee stdout/stderr into `file` (append) in addition to the
 * console, so cron runs leave a durable log even if the caller forgets to
 * redirect. Returns a teardown function.
 */
function installBatchLog(file?: string): () => void {
	if (!file) return () => { /* no-op */ };
	const outPath = expandHomePath(file);
	const stream = fs.createWriteStream(outPath, { flags: 'a' });
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	(process.stdout as any).write = (chunk: any, enc?: any, cb?: any) => {
		stream.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
		return origOut(chunk, enc, cb);
	};
	(process.stderr as any).write = (chunk: any, enc?: any, cb?: any) => {
		stream.write(typeof chunk === 'string' ? chunk : Buffer.from(chunk));
		return origErr(chunk, enc, cb);
	};
	return () => {
		(process.stdout as any).write = origOut;
		(process.stderr as any).write = origErr;
		try { stream.end(); } catch { /* ignore */ }
	};
}

/**
 * Simple advisory lock for cron-style jobs: create the lock file with O_EXCL
 * and record the pid. A stale lock (process gone) is reclaimed automatically.
 * Returns a release function, or undefined when the lock is held elsewhere.
 */
function acquireLock(file: string): (() => void) | undefined {
	const lockPath = expandHomePath(file);
	try { fs.mkdirSync(nodePath.dirname(lockPath), { recursive: true }); } catch { /* ignore */ }

	const tryCreate = (): number | undefined => {
		try {
			const fd = fs.openSync(lockPath, 'wx');
			fs.writeSync(fd, String(process.pid));
			fs.closeSync(fd);
			return process.pid;
		} catch (e: any) {
			if (e && e.code === 'EEXIST') return undefined;
			return process.pid; // unknown error: proceed rather than block the job
		}
	};

	if (tryCreate()) {
		return () => { try { fs.unlinkSync(lockPath); } catch { /* ignore */ } };
	}

	// Lock exists — is the owner still alive?
	let stale = false;
	try {
		const pid = parseInt(fs.readFileSync(lockPath, 'utf-8').trim(), 10);
		if (!pid || pid <= 0) {
			stale = true;
		} else {
			try { process.kill(pid, 0); } catch { stale = true; }
		}
	} catch { stale = true; }

	if (stale) {
		try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
		if (tryCreate()) {
			return () => { try { fs.unlinkSync(lockPath); } catch { /* ignore */ } };
		}
	}
	return undefined;
}

function writeJsonFile(file: string, data: unknown): void {
	try {
		const p = expandHomePath(file);
		fs.mkdirSync(nodePath.dirname(p), { recursive: true });
		fs.writeFileSync(p, JSON.stringify(data, null, 2));
	} catch (e) {
		console.error(`${C.yellow}[BATCH]${C.reset} failed to write result file ${file}: ${(e as Error).message}`);
	}
}

function mergeMcpSpecs(primary: McpServerSpec[], secondary: McpServerSpec[]): McpServerSpec[] {
	const out = [...primary];
	const seen = new Set(primary.map(s => s.name));
	for (const s of secondary) {
		if (!seen.has(s.name)) { out.push(s); seen.add(s.name); }
	}
	return out;
}

/**
 * Resolve which MCP servers to load:
 *   --mcp off            → none
 *   --mcp on             → config.yaml `mcp_servers` + ~/.agent/mcp.json
 *   --mcp a,b            → only the named servers from the merged set
 *   (no --mcp flag)      → config.yaml `mcp_servers` only (docs-compatible)
 */
function resolveMcpSpecs(resolved: ResolvedConfig, opts: CLIOptions): McpServerSpec[] {
	const mode = (opts.mcp || '').trim().toLowerCase();
	const fromConfig: McpServerSpec[] = (resolved.mcpServers || []).map(s => ({
		name: s.name, type: s.type, url: s.url, headers: s.headers,
		command: s.command, args: s.args, env: s.env, tools: s.tools,
	}));
	if (mode === 'off' || mode === 'false' || mode === 'none') return [];
	if (!mode) return fromConfig;
	const merged = mergeMcpSpecs(fromConfig, loadMcpServersFromJsonFile());
	if (mode === 'on' || mode === 'true' || mode === 'all') return merged;
	const want = new Set(mode.split(',').map(x => x.trim()).filter(Boolean));
	return merged.filter(s => want.has(s.name));
}

function mcpAllowTools(opts: CLIOptions): string[] | undefined {
	const raw = (opts.mcpTools || '').trim();
	if (!raw) return undefined;
	return raw.split(',').map(x => x.trim()).filter(Boolean);
}

/**
 * Creates a readline completer for tab-completion of REPL commands.
 *
 * Supported completions:
 *   /resume [partial]   → session IDs from current working directory
 *   /session [partial]  → session IDs
 *   /delete-session [partial] → session IDs
 *   /mode               → agent | plan | ask
 *   /profile [partial]  → available config profile names
 *   /skill [partial]    → available skill names
 *   /use-skill [partial] → available skill names
 *   /save [name]        → (no completion — free text name)
 */
function createCompleter(
	sessionManager: AgentSessionManager,
	_skillsLoader: SkillsLoader,
	taskLogManager?: TaskLogManager,
) {
	// All known slash commands (for prefix matching)
	const knownCommands = [
		'/resume', '/mode', '/profile', '/skill', '/use-skill',
		'/save', '/sessions', '/new', '/auto-save', '/btw',
		'/stream', '/profiles', '/skills', '/parallel',
		'/continue', '/session', '/delete-session', '/help',
		'/tasks', '/task', '/delete-task',
	];

	return (line: string): [string[], string] => {
		// Only complete lines starting with '/'
		if (!line.startsWith('/')) {
			return [[], line];
		}

		const trimmed = line.trim();

		// ---- /resume <partial session id> ----
		const resumeMatch = trimmed.match(/^\/resume(\s+(\S*))?$/);
		if (resumeMatch) {
			const partial = (resumeMatch[2] || '').toLowerCase();
			const sessions = sessionManager.listSessions();
			const matches = sessions.filter(s =>
				s.id.toLowerCase().startsWith(partial) ||
				s.name.toLowerCase().includes(partial)
			);
			if (matches.length > 0) {
				const completions = matches.map(s => `/resume ${s.id}`);
				return [completions, line];
			}
			// If no specific match, show latest session as hint
			const latest = sessionManager.getLatestSession();
			if (latest && !partial) {
				return [[`/resume ${latest.id}`], line];
			}
			return [[], line];
		}

		// ---- /session <partial session id> ----
		const sessionMatch = trimmed.match(/^\/session(\s+(\S*))?$/);
		if (sessionMatch) {
			const partial = (sessionMatch[2] || '').toLowerCase();
			const sessions = sessionManager.listSessions();
			const matches = sessions.filter(s =>
				s.id.toLowerCase().startsWith(partial) ||
				s.name.toLowerCase().includes(partial)
			);
			if (matches.length > 0) {
				return [matches.map(s => `/session ${s.id}`), line];
			}
			return [[], line];
		}

		// ---- /delete-session <partial session id> ----
		const deleteMatch = trimmed.match(/^\/delete-session(\s+(\S*))?$/);
		if (deleteMatch) {
			const partial = (deleteMatch[2] || '').toLowerCase();
			const sessions = sessionManager.listSessions();
			const matches = sessions.filter(s =>
				s.id.toLowerCase().startsWith(partial) ||
				s.name.toLowerCase().includes(partial)
			);
			if (matches.length > 0) {
				return [matches.map(s => `/delete-session ${s.id}`), line];
			}
			return [[], line];
		}

		// ---- /task <partial task log id> ----
		const taskMatch = trimmed.match(/^\/task(\s+(\S*))?$/);
		if (taskMatch && taskLogManager) {
			const partial = (taskMatch[2] || '').toLowerCase();
			const logs = taskLogManager.listTaskLogs();
			const matches = logs.filter(t => t.id.toLowerCase().startsWith(partial));
			if (matches.length > 0) {
				return [matches.map(t => `/task ${t.id}`), line];
			}
			return [[], line];
		}

		// ---- /delete-task <partial task log id> ----
		const deleteTaskMatch = trimmed.match(/^\/delete-task(\s+(\S*))?$/);
		if (deleteTaskMatch && taskLogManager) {
			const partial = (deleteTaskMatch[2] || '').toLowerCase();
			const logs = taskLogManager.listTaskLogs();
			const matches = logs.filter(t => t.id.toLowerCase().startsWith(partial));
			if (matches.length > 0) {
				return [matches.map(t => `/delete-task ${t.id}`), line];
			}
			return [[], line];
		}

		// ---- /mode <partial> → agent, plan, ask ----
		const modeMatch = trimmed.match(/^\/mode(\s+(\S*))?$/);
		if (modeMatch) {
			const partial = (modeMatch[2] || '').toLowerCase();
			const modes = ['agent', 'plan', 'ask'];
			const matches = modes.filter(m => m.startsWith(partial));
			if (matches.length > 0) {
				return [matches.map(m => `/mode ${m}`), line];
			}
			return [modes.map(m => `/mode ${m}`), line];
		}

		// ---- /profile <partial profile name> ----
		const profileMatch = trimmed.match(/^\/profile(\s+(\S*))?$/);
		if (profileMatch) {
			const partial = (profileMatch[2] || '').toLowerCase();
			try {
				const profiles = listProfiles();
				const matches = profiles.filter(p =>
					p.name.toLowerCase().startsWith(partial)
				);
				if (matches.length > 0) {
					return [matches.map(p => `/profile ${p.name}`), line];
				}
				if (profiles.length > 0 && !partial) {
					return [profiles.map(p => `/profile ${p.name}`), line];
				}
			} catch {
				// config not available
			}
			return [[], line];
		}

		// ---- /skill <partial skill name> ----
		const skillMatch = trimmed.match(/^\/skill(\s+(\S*))?$/);
		if (skillMatch) {
			const partial = (skillMatch[2] || '').toLowerCase();
			const skills = _skillsLoader.skills;
			const matches = skills.filter(s =>
				s.name.toLowerCase().startsWith(partial)
			);
			if (matches.length > 0) {
				return [matches.map(s => `/skill ${s.name}`), line];
			}
			if (skills.length > 0 && !partial) {
				return [skills.map(s => `/skill ${s.name}`), line];
			}
			return [[], line];
		}

		// ---- /use-skill <partial skill name> ----
		const useSkillMatch = trimmed.match(/^\/use-skill(\s+(\S*))?$/);
		if (useSkillMatch) {
			const partial = (useSkillMatch[2] || '').toLowerCase();
			const skills = _skillsLoader.skills;
			const matches = skills.filter(s =>
				s.name.toLowerCase().startsWith(partial)
			);
			if (matches.length > 0) {
				return [matches.map(s => `/use-skill ${s.name}`), line];
			}
			if (skills.length > 0 && !partial) {
				return [skills.map(s => `/use-skill ${s.name}`), line];
			}
			return [[], line];
		}

		// ---- Partial command name completion ----
		// If user typed a partial command like /res, suggest matching commands
		const partialCmd = trimmed.split(/\s+/, 1)[0];
		const cmdMatches = knownCommands.filter(cmd =>
			cmd.startsWith(partialCmd) && cmd !== partialCmd
		);
		if (cmdMatches.length > 0) {
			return [cmdMatches, line];
		}

		return [[], line];
	};
}

interface CLIOptions {
	mode: AgentMode;
	streaming: boolean;
	parallel: boolean;
	tasks: string[];
	profile?: string;
	/** Override sampling temperature for this run (--temperature <float>). */
	temperature?: number;
	/** Override top-k sampling for this run (--top-k <int>, 0 = provider default). */
	topK?: number;
	/** Force shared agent memory on/off for this run (--memory on|off). */
	memory?: 'on' | 'off';
	showProfiles: boolean;
	showSkills: boolean;
	useSkill?: string;
	resumeLatest: boolean;
	listSessions: boolean;
	sessionId?: string;
	deleteSessionId?: string;
	listTaskLogs: boolean;
	taskLogId?: string;
	deleteTaskLogId?: string;
	// ---- batch / headless mode ----
	/** --batch: run the task(s) without the interactive REPL and exit. */
	batch?: boolean;
	/** --batch-log <file>: append the full run output to a file as well. */
	batchLog?: string;
	/** --batch-result <file>: write a JSON result summary (status/duration/log id). */
	batchResult?: string;
	/** --batch-timeout <seconds>: overall wall-clock limit (0 = unlimited). */
	batchTimeout?: number;
	/** --lock <file>: skip the run if another process holds this lock. */
	lockFile?: string;
	/** --cwd <dir>: change working directory before running. */
	cwd?: string;
	/** --step-timeout <ms>: override the per-tool-call timeout. */
	stepTimeout?: number;
	/** --mcp <off|on|name1,name2>: enable MCP servers for this run. */
	mcp?: string;
	/** --mcp-tools <a,b,c>: global MCP tool allowlist (intersected per server). */
	mcpTools?: string;
	/** --tracing <on|off>: force Langfuse tracing on/off for this run. */
	tracing?: 'on' | 'off';
	/** --self-scan [days]: print the self-evolution run evidence and exit. */
	selfScan?: number;
}

function parseArgs(): CLIOptions {
	const args = process.argv.slice(2);
	const opts: CLIOptions = {
		mode: AgentMode.Agent,
		streaming: false,
		parallel: false,
		tasks: [],
		showProfiles: false,
		showSkills: false,
		resumeLatest: false,
		listSessions: false,
		listTaskLogs: false,
	};

	let i = 0;
	while (i < args.length) {
		switch (args[i]) {
			case '--mode':
				i++;
				if (args[i] === 'plan') opts.mode = AgentMode.Plan;
				else if (args[i] === 'ask') opts.mode = AgentMode.Ask;
				else opts.mode = AgentMode.Agent;
				break;
			case '--stream':
				opts.streaming = true;
				break;
			case '--parallel':
				opts.parallel = true;
				break;
			case '--profile':
				i++;
				opts.profile = args[i];
				break;
			case '--temperature':
				i++;
				opts.temperature = parseFloat(args[i]);
				break;
			case '--top-k':
				i++;
				opts.topK = parseInt(args[i], 10);
				break;
			case '--memory':
				i++;
				opts.memory = args[i] === 'on' ? 'on' : 'off';
				break;
			case '--tracing':
				i++;
				opts.tracing = args[i] === 'on' ? 'on' : 'off';
				break;
			case '--self-scan': {
				// Optional days argument; `--self-scan 30` or a bare `--self-scan`.
				const next = args[i + 1];
				if (next !== undefined && /^\d+$/.test(next)) { opts.selfScan = parseInt(next, 10); i++; }
				else opts.selfScan = 0;   // 0 = use the configured window
				break;
			}
			case '--profiles':
				opts.showProfiles = true;
				break;
			case '--skills':
				opts.showSkills = true;
				break;
			case '--use-skill':
				i++;
				opts.useSkill = args[i];
				break;
			case '--session':
				i++;
				opts.sessionId = args[i];
				break;
			case '--resume':
				opts.resumeLatest = true;
				break;
			case '--sessions':
				opts.listSessions = true;
				break;
			case '--delete-session':
				i++;
				opts.deleteSessionId = args[i];
				break;
			case '--tasks':
				opts.listTaskLogs = true;
				break;
			case '--task':
				i++;
				opts.taskLogId = args[i];
				break;
			case '--delete-task':
				i++;
				opts.deleteTaskLogId = args[i];
				break;
			case '--batch':
				opts.batch = true;
				break;
			case '--batch-log':
				i++;
				opts.batchLog = args[i];
				break;
			case '--batch-result':
				i++;
				opts.batchResult = args[i];
				break;
			case '--batch-timeout':
				i++;
				opts.batchTimeout = parseInt(args[i], 10) || 0;
				break;
			case '--lock':
				i++;
				opts.lockFile = args[i];
				break;
			case '--cwd':
				i++;
				opts.cwd = args[i];
				break;
			case '--step-timeout':
				i++;
				opts.stepTimeout = parseInt(args[i], 10) || 0;
				break;
			case '--mcp':
				i++;
				opts.mcp = args[i] || 'on';
				break;
			case '--mcp-tools':
				i++;
				opts.mcpTools = args[i];
				break;
			case '--help':
				printHelp();
				process.exit(0);
			case '--version':
			case '-v':
				printVersion();
				process.exit(0);
			default:
				opts.tasks.push(args[i]);
		}
		i++;
	}

	return opts;
}

declare const __AGENT_VERSION__: string;
const AGENT_VERSION = __AGENT_VERSION__;

function printVersion() {
	console.log(`code-agent v${AGENT_VERSION}`);
}

function printHelp() {
	console.log(`
${C.bold}CodeAgent - VS Code Agent Mode CLI${C.reset}

Usage:
  agent-cli [options] "task description"

Options:
  --mode <agent|plan|ask>     Set agent mode (default: agent)
  --stream                    Enable streaming output
  --parallel "t1" "t2"        Run multiple tasks in parallel
  --profile <name>            Use a specific config profile
  --profiles                  List available config profiles
  --skills                    List loaded skills
  --use-skill <name>          Activate a specific skill for this session
  --session <id>              Resume a specific session by ID
  --resume                    Resume the most recent session
  --sessions                  List saved sessions
  --delete-session <id>       Delete a session
  --tasks                     List saved task logs
  --task <id>                 View a specific task log
  --delete-task <id>          Delete a task log
  --temperature <float>       Override sampling temperature (default from config)
  --top-k <int>               Override top-k sampling; 0 = provider default
  --memory <on|off>           Force shared agent memory on/off for this run
  --tracing <on|off>          Force Langfuse tracing on/off (LANGFUSE_* keys)
  --self-scan [days]          Print self-evolution evidence from your own run
                              history (tool failures, run signals) and exit
  --batch                     Headless: run the task(s), then exit (no REPL)
  --batch-log <file>          Also append all run output to <file>
  --batch-result <file>       Write a JSON result summary to <file>
  --batch-timeout <seconds>   Overall wall-clock limit for the run (0 = unlimited)
  --lock <file>               Skip the run if another process holds the lock
  --cwd <dir>                 Change working directory before running
  --step-timeout <ms>         Override the per-tool-call timeout
  --mcp <off|on|a,b>          Load MCP servers (on = config.yaml + mcp.json)
  --mcp-tools <a,b,c>         Only expose these MCP tools (global allowlist)
  --help                      Show this help
  --version, -v               Show version

Batch / Cron:
  code-agent --batch --use-skill <skill> --cwd <dir> "do the whole workflow"
    Runs one-shot, no TTY required, and exits 0 on success / 1 on failure
    (124 on --batch-timeout). Combine with --batch-log/--batch-result to keep a
    durable record, and --lock to prevent overlapping scheduled runs.

MCP tools:
  Skills such as dolphin-mcp / caps-llvm-nda-daily call external MCP tools.
  Pass --mcp on to load servers from config.yaml mcp_servers and
  ~/.agent/mcp.json. Without --mcp only config.yaml mcp_servers load.
  Restrict the exposed tool set with --mcp-tools (recommended: some gateways
  advertise 180+ tools). A per-server "tools: [...]" entry is honoured too.

Session Management:
  Sessions persist your agent conversation context across restarts.
  - Auto-save: after each run, the session is saved automatically.
  - REPL commands: /save, /sessions, /resume, /new, /auto-save
  - Tab-completion: press Tab to auto-complete /resume, /mode, /profile, /skill, etc.
  - Storage: ~/.agent/sessions/

Task Logs (for troubleshooting):
  - Auto-save: after each task, a detailed execution log is saved automatically.
  - Includes: LLM requests/responses, tool calls with arguments and results, timings.
  - REPL commands: /tasks, /task <id>, /delete-task <id>
  - Storage: ~/.agent/tasks/

Intervention:
  /btw <hint>    While the agent is running, inject a hint into its reasoning
                 for subsequent turns. While idle, treat it as a direct prompt
                 and respond immediately. Useful for course-correcting or adding
                 context mid-session.
  /btw cancel    Cancel the currently running tool (e.g., a long build or
                 poll). The agent will continue with the next step.

Modes:
  agent   Full autonomy: read, write, edit files, run commands
  plan    Generate implementation plan without executing
  ask     Read-only: explore codebase and answer questions

Config (searched in order):
  1. CLI flags / env vars (OPENAI_API_KEY, LLM_MODEL, etc.)
  2. ./config.yaml
  3. ~/.agent/config.yaml
`);
}

/**
 * Langfuse observability, initialized once in `main()`.
 *
 * A module-level handle (rather than a parameter threaded through every mode)
 * because all four entry points — interactive, batch, parallel, single task —
 * share the same tracing configuration for the process.
 */
let tracing: IAgentTracing = NOOP_TRACING;
/** Flushes and shuts the Langfuse processor down (set once tracing is up). */
let tracingFlush: (() => Promise<void>) | undefined;

/**
 * Self-evolution config, resolved once per process (config.yaml is read by both
 * the tool registry and the system prompt, and must not be re-read per task).
 */
let _selfUpdateConfig: SelfUpdateConfig | undefined;
function selfUpdateConfig(): SelfUpdateConfig {
	return (_selfUpdateConfig ??= loadSelfUpdateConfig());
}

/** Flush pending spans before the process exits (batched export). */
async function flushTracing(): Promise<void> {
	const flush = tracingFlush;
	tracingFlush = undefined;
	if (flush) await flush();
}

/**
 * Resolve the tracing configuration, load the SDK and report the outcome.
 *
 * Always best-effort: a missing SDK, bad keys or an unreachable Langfuse leaves
 * the agent fully functional with tracing disabled.
 */
async function setupTracing(release: string, cliOverride?: 'on' | 'off'): Promise<void> {
	tracing = initTracingFromConfig(cliOverride, release);

	if (!tracing.enabled) {
		if (cliOverride !== 'off') {
			console.log(`${C.dim}[TRACING] off — ${tracing.reason}${C.reset}`);
		}
		return;
	}

	const ok = await tracing.init();
	if (!ok) {
		console.log(`${C.yellow}[TRACING]${C.reset} Langfuse SDK failed to load — tracing disabled for this run`);
		tracing = NOOP_TRACING;
		return;
	}

	console.log(`${C.green}[TRACING]${C.reset} Langfuse tracing enabled: ${tracing.describe?.() ?? ''}`);

	// Spans are batched; flush before the process exits or a short run loses
	// its trace entirely (a Langfuse best-practice requirement).
	tracingFlush = () => tracing.shutdown();
	// `beforeExit` covers every clean return; the explicit `process.exit()` paths
	// (batch mode, REPL quit) call flushTracing() themselves, and signals are
	// handled here so a Ctrl-C doesn't drop the trace.
	process.once('beforeExit', () => { void flushTracing(); });
	process.once('SIGINT', () => { void flushTracing().finally(() => process.exit(130)); });
	process.once('SIGTERM', () => { void flushTracing().finally(() => process.exit(143)); });
}

async function createServices(resolved: ResolvedConfig, memoryOverride?: 'on' | 'off', opts?: CLIOptions) {
	const config = resolved.agentConfig;
	if (!config.apiKey) {
		console.error(`${C.red}No API key found. Set OPENAI_API_KEY, or configure apiKey in ~/.agent/models.json or config.yaml.${C.reset}`);
		process.exit(1);
	}

	const llmProvider = LLMProviderFactory.create(config);
	const fileService = new NodeFileService();
	const searchService = new NodeSearchService();
	const terminalService = new NodeTerminalService(process.cwd());

	const toolRegistry = new ToolRegistry();
	const workspaceRoot = URI.file(process.cwd());
	toolRegistry.register(new ReadFileTool(fileService));
	toolRegistry.register(new WriteFileTool(fileService));
	toolRegistry.register(new EditFileTool(fileService));
	toolRegistry.register(new ListDirectoryTool(fileService));
	toolRegistry.register(new SearchTextTool(searchService, workspaceRoot));
	toolRegistry.register(new SearchFilesTool(searchService, workspaceRoot));
	toolRegistry.registerAlias('search_content', 'search_text');
	toolRegistry.register(new RunTerminalTool(terminalService, process.cwd()));
	toolRegistry.register(new PollTool(terminalService, process.cwd()));

	// ---- Skill management ("Skills of Skills"): catalog / create / update ----
	// Ports dsh-run2skill's skill packaging logic so the agent can manage its own
	// skill library using canonical SKILL.md files (see agentSkillFactory.ts).
	const skillDirs = resolved.skillsDirs && resolved.skillsDirs.length > 0
		? resolved.skillsDirs
		: [defaultSkillsDir()];
	toolRegistry.register(new SkillCatalogTool(skillDirs));
	toolRegistry.register(new CreateSkillTool(skillDirs));
	toolRegistry.register(new UpdateSkillTool(skillDirs));

	// ---- Self-evolution (RSI): inspect own run history, release own fixes ----
	// The read-only scan is on by default; the release gate stays opt-in because
	// it writes to the repository and can push.
	const selfUpdate = selfUpdateConfig();
	if (selfUpdate.enabled) {
		toolRegistry.register(new SelfScanTool(selfUpdate));
		const releaseNote = selfUpdate.allowRelease
			? `release ON${selfUpdate.allowPush ? ' + push' : ' (no push)'}`
			: 'release OFF (self_update.allow_release)';
		console.log(`${C.green}[SELF]${C.reset} self-evolution: evidence scan ON, ${releaseNote}`);
		if (selfUpdate.allowRelease) {
			toolRegistry.register(new AgentReleaseTool(selfUpdate));
		}
	}

	// ---- Shared memory (tdai_agent_mem) ----
	// Tools + auto recall/capture are enabled when config.yaml `memory:` or
	// ~/.agent/mcp.json `mcpServers.tdai_agent_mem` is present.
	// --memory off forces the feature off (deterministic benchmarks); --memory on
	// forces it on when the config exists.
	const memoryConfig = memoryOverride === 'off' ? undefined : loadMemoryConfig();
	let memoryClient: MemoryClient | undefined;
	if (memoryConfig) {
		memoryClient = new MemoryClient(memoryConfig);
		toolRegistry.register(new MemorySearchTool(memoryClient));
		toolRegistry.register(new ConversationSearchTool(memoryClient));
		toolRegistry.register(new MemoryReadTool(memoryClient));
		toolRegistry.register(new MemoryWriteTool(memoryClient));
		const who = memoryConfig.username || memoryConfig.userId;
		console.log(`${C.green}[MEMORY]${C.reset} Shared memory enabled (tdai_agent_mem): user=${who || '?'} endpoint=${memoryConfig.endpoint} service=${memoryConfig.serviceId}`);
		console.log(`${C.dim}  Tools: tdai_memory_search / tdai_conversation_search / tdai_read_file / tdai_memory_write${C.reset}`);
		if (memoryConfig.recall) console.log(`${C.dim}  Auto-recall: on | Auto-capture L0: ${memoryConfig.capture ? 'on' : 'off'}${C.reset}`);
	}

	const checkpointManager = new AgentCheckpointManager(fileService);

	// ---- MCP servers (opt-in via --mcp) ----
	// Exposes external MCP tools (dolphin pipeline/gerrit/gitlab, opendisplay …)
	// so skills that reference them work in the CLI exactly as in the IDE host.
	let mcpTransports: unknown[] = [];
	if (opts) {
		const specs = resolveMcpSpecs(resolved, opts);
		if (specs.length > 0) {
			try {
				const { count, transports } = await registerMcpTools(
					toolRegistry, specs,
					msg => console.log(`${C.cyan}${msg}${C.reset}`),
					{ allowTools: mcpAllowTools(opts), skipServers: ['tdai_agent_mem'] },
				);
				mcpTransports = transports;
				console.log(`${C.green}[MCP]${C.reset} ${count} tool(s) registered from ${specs.length} server(s)`);
			} catch (e) {
				console.log(`${C.yellow}[MCP]${C.reset} failed to load MCP servers: ${(e as Error).message}`);
			}
		}
	}

	return { config, llmProvider, toolRegistry, checkpointManager, memoryClient, mcpTransports };
}

function attachAgentListeners(agentLoop: AgentLoop, opts: CLIOptions) {
	if (opts.streaming) {
		agentLoop.onDidStreamToken(token => {
			process.stdout.write(token);
		});
	}

	agentLoop.onDidReceiveMessage(msg => {
		if (msg.role === MessageRole.Assistant) {
			if (msg.reasoningContent) {
				log(C.dim, 'THINKING', formatReasoningForLog(msg.reasoningContent));
			}
			if (msg.toolCalls && msg.toolCalls.length > 0) {
				for (const tc of msg.toolCalls) {
					const argsStr = JSON.stringify(tc.arguments).substring(0, 120);
					log(C.cyan, 'TOOL', `${tc.name}(${argsStr}...)`);
				}
			}
			if (msg.content && !opts.streaming) {
				log(C.green, 'AGENT', msg.content);
			}
		} else if (msg.role === MessageRole.Tool) {
			const truncated = msg.content.length > 500
				? msg.content.substring(0, 500) + `\n... (${msg.content.length} chars)`
				: msg.content;
			log(C.yellow, 'RESULT', truncated);
		} else if (msg.role === MessageRole.User) {
			log(C.blue, 'USER', msg.content);
		}
	});

	// Model switches must never be silent: an answer produced by the 保底 model
	// (or by a scenario-routed model) looks wrong for reasons the user cannot see.
	agentLoop.setModelSwitchLogger(e => {
		const color = e.reason === 'primary-recovered' ? C.green : e.toFallback ? C.yellow : C.magenta;
		console.log(`${color}${C.bold}${formatModelSwitch(e)}${C.reset}`);
	});

	agentLoop.onDidError(err => log(C.red, 'ERROR', err.message));
	agentLoop.onDidComplete(() => console.log(`\n${C.dim}--- Task completed ---${C.reset}\n`));
}
async function runParallelMode(tasks: string[], resolved: ResolvedConfig, memoryOverride?: 'on' | 'off', opts?: CLIOptions) {
	const { config, llmProvider, toolRegistry, checkpointManager, memoryClient } = await createServices(resolved, memoryOverride, opts);

	console.log(`\n${C.bold}${C.magenta}=== Parallel Agent Mode ===${C.reset}`);
	console.log(`${C.dim}Running ${tasks.length} tasks concurrently (max 4)${C.reset}\n`);

	const modelRouter = new ModelRouter(resolved.modelRouting, resolved.profiles, config);

	const taskLogManager = new TaskLogManager();
	const manager = new ParallelAgentManager(config, llmProvider, toolRegistry, process.cwd(), checkpointManager, 4, modelRouter, memoryClient, tracing);

	manager.onDidTaskStart(task => {
		log(C.cyan, `TASK ${task.id.slice(-6)}`, `Started: ${task.description.substring(0, 80)}`);
	});

	manager.onDidTaskComplete(result => {
		const status = result.success ? `${C.green}OK` : `${C.red}FAIL`;
		log(status, `TASK ${result.taskId.slice(-6)}`, `${result.success ? 'Completed' : 'Failed'} in ${result.durationMs}ms`);
		if (result.error) {
			log(C.red, 'ERROR', result.error);
		}
	});

	const results = await manager.runParallel(tasks);

	console.log(`\n${C.bold}=== Results ===${C.reset}`);
	for (const result of results) {
		const task = manager.getTask(result.taskId);
		const status = result.success ? `${C.green}OK${C.reset}` : `${C.red}FAIL${C.reset}`;
		console.log(`  ${status} [${result.durationMs}ms] ${task?.description.substring(0, 60) || result.taskId}`);
		const agentMessages = result.messages.filter(m => m.role === MessageRole.Assistant && m.content);
		if (agentMessages.length > 0) {
			const lastMsg = agentMessages[agentMessages.length - 1];
			console.log(`    ${C.dim}${lastMsg.content.substring(0, 100)}${C.reset}`);
		}
		// Save task log for each parallel task
		if (result.taskLog) {
			taskLogManager.saveTaskLog(result.taskLog);
			console.log(`    ${C.dim}[Task log: ${result.taskLog.id}]${C.reset}`);
		}
	}

	manager.dispose();
}

/**
 * Wire the 保底 (guaranteed fallback) model into an agent loop. When the
 * scenario/default model times out, the agent swaps to this model and retries
 * the same request. Configured via config.yaml `model_routing.fallback`.
 */
function wireModelFallback(agentLoop: AgentLoop, modelRouter: ModelRouter): void {
	// Optional probe cadence override (model_routing.fallback_probe_interval_s).
	if (modelRouter.probeIntervalMs) {
		agentLoop.setProbeSchedule(modelRouter.probeIntervalMs);
	}
	const fb = modelRouter.fallbackConfig();
	if (!fb) return;
	try {
		agentLoop.setFallback(fb, LLMProviderFactory.create(fb));
		console.log(`${C.dim}Model fallback: ON | 保底模型: ${fb.model} (auto-switch on API access timeout; background probe switches back on recovery)${C.reset}`);
	} catch (err: any) {
		console.log(`${C.yellow}Model fallback: failed to init provider for "${fb.model}": ${err.message}${C.reset}`);
	}
}

/**
 * Headless batch mode (--batch): run one task without the interactive REPL and
 * exit with a deterministic status code. Designed for cron / CI jobs:
 *   0   success
 *   1   task failed
 *   2   usage error (no task, bad --cwd)
 *   124 timed out (--batch-timeout)
 * A held --lock exits 0 (skip) so overlapping cron runs don't spam errors.
 *
 * All console output is tee'd to --batch-log, a JSON summary is written to
 * --batch-result, and the session + task log are saved exactly like a normal
 * run so the job can be inspected afterwards.
 */
async function runBatchMode(opts: CLIOptions, resolved: ResolvedConfig, skillsLoader: SkillsLoader) {
	const teardownLog = installBatchLog(opts.batchLog);

	const releaseLock = opts.lockFile ? acquireLock(opts.lockFile) : undefined;
	if (opts.lockFile && !releaseLock) {
		console.log(`${C.yellow}[BATCH]${C.reset} lock "${opts.lockFile}" is held by another run — skipping (exit 0)`);
		teardownLog();
		process.exit(0);
	}

	const task = opts.tasks.join(' ').trim();
	if (!task) {
		console.error(`${C.red}[BATCH]${C.reset} no task provided; usage: code-agent --batch "task"`);
		releaseLock?.();
		teardownLog();
		process.exit(2);
	}

	const modeLabel = opts.mode === AgentMode.Plan ? 'plan' : opts.mode === AgentMode.Ask ? 'ask' : 'agent';
	const startedAt = Date.now();
	console.log(`${C.green}[BATCH]${C.reset} start pid=${process.pid} mode=${modeLabel} cwd=${process.cwd()}`);
	console.log(`${C.dim}${task.length > 400 ? task.slice(0, 400) + '…' : task}${C.reset}`);

	const { config, llmProvider, toolRegistry, checkpointManager, memoryClient } =
		await createServices(resolved, opts.memory, opts);
	if (opts.stepTimeout && opts.stepTimeout > 0) config.stepTimeout = opts.stepTimeout;

	const modeManager = new AgentModeManager();
	modeManager.switchMode(opts.mode);
	const agentLoop = new AgentLoop(config, llmProvider, toolRegistry, modeManager, checkpointManager, process.cwd(), memoryClient, tracing);
	agentLoop.setExtraSystemPrompt(buildSkillsContext(skillsLoader, opts.useSkill, task));

	// Wire the 保底 (guaranteed fallback) model: batch/cron runs must survive an
	// access timeout on the primary model by switching to the fallback model.
	wireModelFallback(agentLoop, new ModelRouter(resolved.modelRouting, resolved.profiles, config));

	attachAgentListeners(agentLoop, opts);

	let timedOut = false;
	const timer = opts.batchTimeout && opts.batchTimeout > 0
		? setTimeout(() => {
			timedOut = true;
			console.log(`\n${C.red}[BATCH]${C.reset} batch-timeout of ${opts.batchTimeout}s reached — cancelling task`);
			agentLoop.cancel();
		}, opts.batchTimeout * 1000)
		: undefined;

	const onSignal = (sig: string) => {
		console.log(`\n${C.yellow}[BATCH]${C.reset} received ${sig} — cancelling task`);
		agentLoop.cancel();
	};
	process.on('SIGINT', () => onSignal('SIGINT'));
	process.on('SIGTERM', () => onSignal('SIGTERM'));

	let thrown: string | undefined;
	try {
		await agentLoop.run(task);
	} catch (e) {
		thrown = (e as Error).message || String(e);
	}
	if (timer) clearTimeout(timer);

	const status: 'completed' | 'failed' | 'cancelled' =
		timedOut ? 'cancelled' : (thrown || agentLoop.lastTaskError) ? 'failed' : 'completed';
	const success = status === 'completed';

	let taskLogId = '';
	try {
		const taskLog = agentLoop.exportTaskLog(status, thrown || agentLoop.lastTaskError);
		taskLogId = taskLog.id;
		new TaskLogManager().saveTaskLog(taskLog);
	} catch (e) {
		console.log(`${C.yellow}[BATCH]${C.reset} failed to save task log: ${(e as Error).message}`);
	}

	const lastAssistant = [...agentLoop.context.messages]
		.reverse()
		.find(m => m.role === MessageRole.Assistant && m.content && m.content.trim())?.content || '';

	const durationMs = Date.now() - startedAt;
	const result = {
		status,
		task,
		mode: modeLabel,
		pid: process.pid,
		cwd: process.cwd(),
		startedAt: new Date(startedAt).toISOString(),
		finishedAt: new Date().toISOString(),
		durationMs,
		durationSec: Math.round(durationMs / 1000),
		taskLogId,
		error: thrown || agentLoop.lastTaskError || undefined,
		lastAssistant: lastAssistant.slice(0, 8000),
	};
	if (opts.batchResult) writeJsonFile(opts.batchResult, result);

	const tag = success ? `${C.green}SUCCESS` : `${C.red}${status.toUpperCase()}`;
	console.log(`\n${C.bold}[BATCH]${C.reset} ${tag}${C.reset} in ${result.durationSec}s (task log: ${taskLogId || 'n/a'})`);

	agentLoop.dispose();
	releaseLock?.();
	teardownLog();
	await flushTracing();
	process.exit(success ? 0 : timedOut ? 124 : 1);
}

async function main() {
	const opts = parseArgs();

	// --cwd: change directory before any service resolves paths (cron-friendly).
	if (opts.cwd) {
		try { process.chdir(expandHomePath(opts.cwd)); }
		catch (e) { console.error(`${C.red}[BATCH]${C.reset} cannot chdir to ${opts.cwd}: ${(e as Error).message}`); process.exit(2); }
	}

	const sessionManager = new AgentSessionManager(process.cwd());
	const taskLogManager = new TaskLogManager();

	// Handle info-only commands
	if (opts.showProfiles) {
		const profiles = listProfiles();
		if (profiles.length === 0) {
			console.log(`${C.dim}No models.json or config.yaml found. Create ~/.agent/models.json or ~/.agent/config.yaml${C.reset}`);
		} else {
			console.log(`\n${C.bold}Available profiles:${C.reset}`);
			for (const p of profiles) {
				console.log(`  ${C.cyan}${p.name}${C.reset}  ${C.dim}${p.provider}/${p.model}${C.reset}`);
			}
		}
		return;
	}

	if (opts.listSessions) {
		const sessions = sessionManager.listSessions();
		if (sessions.length === 0) {
			console.log(`${C.dim}No saved sessions.${C.reset}`);
		} else {
			console.log(`\n${C.bold}Saved sessions (${sessions.length}):${C.reset}\n`);
			for (const s of sessions) {
				const date = new Date(s.updatedAt).toLocaleString();
				const modeLabel = s.mode === AgentMode.Plan ? 'Plan' : s.mode === AgentMode.Ask ? 'Ask' : 'Agent';
				console.log(`  ${C.cyan}${s.id}${C.reset}`);
				console.log(`    ${C.bold}Name:${C.reset} ${s.name || '(unnamed)'}  ${C.bold}Mode:${C.reset} ${modeLabel}  ${C.bold}Msgs:${C.reset} ${s.messageCount}`);
				console.log(`    ${C.bold}Updated:${C.reset} ${date}`);
				if (s.summary) {
					console.log(`    ${C.dim}${s.summary.substring(0, 120)}${C.reset}`);
				}
				console.log('');
			}
		}
		return;
	}

	if (opts.deleteSessionId) {
		const deleted = sessionManager.deleteSession(opts.deleteSessionId);
		if (deleted) {
			console.log(`${C.green}Session "${opts.deleteSessionId}" deleted.${C.reset}`);
		} else {
			console.log(`${C.yellow}Session "${opts.deleteSessionId}" not found.${C.reset}`);
		}
		return;
	}

	if (opts.listTaskLogs) {
		const taskLogs = taskLogManager.listTaskLogs();
		if (taskLogs.length === 0) {
			console.log(`${C.dim}No saved task logs.${C.reset}`);
		} else {
			console.log(`\n${C.bold}Task logs (${taskLogs.length}):${C.reset}\n`);
			for (const t of taskLogs) {
				const date = new Date(t.startedAt).toLocaleString();
				const dur = (t.durationMs / 1000).toFixed(1);
				const statusIcon = t.status === 'completed' ? `${C.green}✓` : t.status === 'failed' ? `${C.red}✗` : `${C.yellow}⊘`;
				console.log(`  ${C.cyan}${t.id}${C.reset} ${statusIcon}${C.reset}`);
				console.log(`    ${C.bold}Task:${C.reset} ${t.task.substring(0, 120)}`);
				console.log(`    ${C.bold}Mode:${C.reset} ${t.mode}  ${C.bold}Steps:${C.reset} ${t.totalSteps}  ${C.bold}Tools:${C.reset} ${t.totalToolCalls}  ${C.bold}Duration:${C.reset} ${dur}s`);
				console.log(`    ${C.bold}Started:${C.reset} ${date}`);
				console.log(`    ${C.dim}${t.summary.substring(0, 150)}${C.reset}`);
				console.log('');
			}
		}
		return;
	}

	if (opts.taskLogId) {
		const log = taskLogManager.loadTaskLog(opts.taskLogId);
		if (!log) {
			console.log(`${C.yellow}Task log "${opts.taskLogId}" not found.${C.reset}`);
		} else {
			console.log(`\n${C.bold}=== Task Log: ${log.id} ===${C.reset}\n`);
			console.log(taskLogManager.formatTaskLog(log));
		}
		return;
	}

	if (opts.deleteTaskLogId) {
		const deleted = taskLogManager.deleteTaskLog(opts.deleteTaskLogId);
		if (deleted) {
			console.log(`${C.green}Task log "${opts.deleteTaskLogId}" deleted.${C.reset}`);
		} else {
			console.log(`${C.yellow}Task log "${opts.deleteTaskLogId}" not found.${C.reset}`);
		}
		return;
	}

	// Move an existing ~/.codeagent installation to ~/.agent (copy, never delete).
	migrateLegacyAgentHome(message => console.log(`${C.dim}${message}${C.reset}`));
	// Where global config/skills/sessions live — printed once so a path mistake is obvious.
	console.log(`${C.dim}Config home: ${agentHomeDir()}${C.reset}`);

	// Load config (merges config.yaml + env vars + CLI flags)
	let resolved = loadConfig(opts.profile);

	// CLI sampling overrides — pin temperature / top-k for reproducible
	// benchmark runs (takes precedence over config.yaml and models.json).
	if (opts.temperature !== undefined) resolved.agentConfig.temperature = opts.temperature;
	if (opts.topK !== undefined) resolved.agentConfig.topK = opts.topK;

	// Load skills and rules
	const skillsLoader = new SkillsLoader();
	skillsLoader.loadSkillsFromDirs(resolved.skillsDirs);
	skillsLoader.loadRulesFromDirs(resolved.rulesDirs);
	// Claude-style instruction files: ~/.agent/agent.md then <project>/.agent/agent.md.
	skillsLoader.loadAgentMdFiles(agentInstructionFiles(process.cwd()));
	setResolvedSkillDirs(resolved.skillsDirs);

	if (opts.showSkills) {
		if (skillsLoader.skills.length === 0) {
			console.log(`${C.dim}No skills found. Configure skills directories in config.yaml.${C.reset}`);
		} else {
			console.log(`\n${C.bold}Loaded skills (${skillsLoader.skills.length}):${C.reset}`);
			for (const s of skillsLoader.skills) {
				console.log(`  ${C.cyan}${s.name}${C.reset}  ${C.dim}${s.description.substring(0, 80)}${C.reset}`);
				if (s.whenToUse) {
					console.log(`      whenToUse: ${C.dim}${s.whenToUse.substring(0, 100)}${C.reset}`);
				}
			}
		}
		if (skillsLoader.rules.length > 0) {
			console.log(`\n${C.bold}Loaded rules (${skillsLoader.rules.length}):${C.reset}`);
			for (const r of skillsLoader.rules) {
				const tag = r.alwaysApply ? `${C.green}always` : `${C.yellow}manual`;
				console.log(`  ${tag}${C.reset}  ${C.dim}${r.description}${C.reset}`);
			}
		}
		console.log(`\n${C.dim}Skill management tools (meta-skill): skill_catalog / create_skill / update_skill${C.reset}`);
		return;
	}

	const modeLabel = opts.mode === AgentMode.Plan ? 'Plan' : opts.mode === AgentMode.Ask ? 'Ask' : 'Agent';

	console.log(`\n${C.bold}${C.green}===========================================${C.reset}`);
	console.log(`${C.bold}  CodeAgent v${AGENT_VERSION} - ${modeLabel} Mode${C.reset}`);
	console.log(`${C.bold}${C.green}===========================================${C.reset}`);

	const cfg = resolved.agentConfig;
	console.log(`${C.dim}Profile: ${resolved.profileName} | Provider: ${cfg.provider} | Model: ${cfg.model}${C.reset}`);
	if (resolved.modelRouting.enabled) {
		const routingDefault = resolved.modelRouting.defaultModel || cfg.model;
		const scenarioEntries = Object.entries(resolved.modelRouting.scenarios || {})
			.map(([s, m]) => `${s}→${m}`)
			.join(', ');
		console.log(`${C.dim}Model routing: ON | startup: ${cfg.model} | default: ${routingDefault}${scenarioEntries ? ` | ${scenarioEntries}` : ''}${C.reset}`);
		if (resolved.modelRouting.fallbackModel) {
			console.log(`${C.dim}Model fallback: ${resolved.modelRouting.fallbackModel} (保底模型, auto-switch on API access timeout)${C.reset}`);
		}
	} else if (resolved.profileExplicit) {
		// A profile was pinned via --profile: the model is fixed and must never
		// be swapped at runtime.
		console.log(`${C.dim}Model routing: OFF (profile "${resolved.profileName}" pinned via --profile — no runtime model switching)${C.reset}`);
	}
	console.log(`${C.dim}API Base: ${cfg.apiBase || 'default'} | Mode: ${modeLabel}${opts.streaming ? ' | Streaming' : ''}${C.reset}`);
	console.log(`${C.dim}Sampling: temperature=${cfg.temperature} top_k=${cfg.topK || '(provider default)'} | Memory: ${opts.memory ?? 'auto'}${C.reset}`);
	console.log(`${C.dim}Config: ${resolved.configFilePath || 'none (using defaults)'} | CWD: ${process.cwd()}${C.reset}`);

	const skillCount = skillsLoader.skills.length;
	const ruleCount = skillsLoader.rules.length;
	const mcpCount = resolved.mcpServers.length;
	const parts: string[] = [];
	if (skillCount > 0) parts.push(`Skills: ${skillCount}`);
	if (ruleCount > 0) parts.push(`Rules: ${ruleCount}`);
	if (mcpCount > 0) parts.push(`MCP Servers: ${mcpCount}`);
	if (parts.length > 0) {
		console.log(`${C.dim}${parts.join(' | ')}${C.reset}`);
	}
	console.log('');

	// ---- Self-evolution evidence scan (headless, no LLM call) ----
	// Prints the FACTS the agent would otherwise ask for via agent_self_scan, so
	// an orchestrator/cron can feed them to a reviewer. Read-only.
	if (opts.selfScan !== undefined) {
		const cfg = selfUpdateConfig();
		const evidence = collectRunEvidence({ days: opts.selfScan > 0 ? opts.selfScan : cfg.evidenceDays });
		console.log(formatEvidenceReport(evidence));
		return;
	}

	// ---- Langfuse observability (opt-in; fail-open) ----
	// Resolved from LANGFUSE_* env vars / config.yaml `tracing:` / --tracing.
	// Runs for every execution mode, but not for the info-only commands above.
	await setupTracing(AGENT_VERSION, opts.tracing);

	if (opts.parallel && opts.tasks.length > 1) {
		await runParallelMode(opts.tasks, resolved, opts.memory, opts);
		return;
	}

	// ---- Headless batch mode (--batch): no REPL, deterministic exit code ----
	if (opts.batch) {
		await runBatchMode(opts, resolved, skillsLoader);
		return;
	}

	const { config, llmProvider, toolRegistry, checkpointManager, memoryClient } = await createServices(resolved, opts.memory, opts);
	const modeManager = new AgentModeManager();
	modeManager.switchMode(opts.mode);

	const agentLoop = new AgentLoop(config, llmProvider, toolRegistry, modeManager, checkpointManager, process.cwd(), memoryClient, tracing);
	if (opts.streaming) {
		agentLoop.setStreaming(true);
	}

	// ---- Model routing: auto-select & switch models per prompt within a session ----
	let modelRouter = new ModelRouter(resolved.modelRouting, resolved.profiles, config);
	let currentModel = config.model;

	// Register the 保底 (guaranteed fallback) model: on an API access timeout
	// the agent transparently switches to it and retries the same request.
	wireModelFallback(agentLoop, modelRouter);

	const applyModelRouting = (task: string): void => {
		if (!modelRouter.enabled) return;
		const selected = modelRouter.selectConfig(task);
		// Compare against the model the agent is actually using — after a
		// fallback swap the agent may differ from the last routed model.
		if (selected.model === agentLoop.activeModel) return;

		const previousModel = agentLoop.activeModel;
		try {
			const newProvider = LLMProviderFactory.create(selected);
			// swapProvider reports the switch (scenario included) as a MODEL line.
			agentLoop.swapProvider(selected, newProvider, 'routing');
			currentModel = selected.model;
			log(C.dim, 'ROUTE', `scenario ${modelRouter.detectScenario(task)} → ${selected.model}`);
		} catch (err: any) {
			log(C.red, 'ROUTE', `Failed to switch model from ${previousModel} to ${selected.model}: ${err.message}`);
		}
	};

	// Inject skills + rules into agent's system prompt
	// Pass task description for auto-matching skills
	const taskDescription = opts.tasks.length > 0 ? opts.tasks.join(' ') : undefined;
	const extraPrompt = buildSkillsContext(skillsLoader, opts.useSkill, taskDescription);
	if (extraPrompt) {
		agentLoop.setExtraSystemPrompt(extraPrompt);
	}

	attachAgentListeners(agentLoop, opts);

	// ---- Session management ----
	let currentSessionId: string | undefined;
	let currentSessionName = '';
	let autoSaveEnabled = true;

	// Determine if we should restore a session
	const sessionToResume = opts.sessionId
		? sessionManager.loadSession(opts.sessionId)
		: opts.resumeLatest
			? sessionManager.getLatestSession()
			: undefined;

	if (sessionToResume) {
		// Restore session context
		const restoreMode = sessionToResume.mode;
		modeManager.switchMode(restoreMode);
		// Rebuild extraSystemPrompt with current version's skills/rules logic
		// (ignore the stored old version's extraSystemPrompt to pick up fixes)
		const rebuiltExtra = buildSkillsContext(skillsLoader, opts.useSkill, undefined);
		agentLoop.restoreFromSession(
			sessionToResume.messages,
			sessionToResume.systemPrompt || '',
			rebuiltExtra || '',
		);
		currentSessionId = sessionToResume.id;
		currentSessionName = sessionToResume.name;

		const date = new Date(sessionToResume.updatedAt).toLocaleString();
		console.log(`${C.magenta}[SESSION]${C.reset} Resumed session "${currentSessionName || currentSessionId}" (${sessionToResume.messageCount} msgs, last updated ${date})`);
		console.log(`${C.dim}  Summary: ${sessionToResume.summary || '(no summary)'}${C.reset}\n`);
	} else if (!opts.sessionId && !opts.resumeLatest && sessionManager.count > 0) {
		// Show a hint about the latest session
		const latest = sessionManager.getLatestSession();
		if (latest) {
			const date = new Date(latest.updatedAt).toLocaleString();
			console.log(`${C.dim}Tip: Resume your last session with --resume (${latest.name || latest.id}, ${latest.messageCount} msgs, ${date})${C.reset}\n`);
		}
	}

	// Helper to auto-save the current session
	const autoSaveSession = (name?: string) => {
		if (!autoSaveEnabled) return;
		const state = agentLoop.exportSessionState();
		if (state.messages.length === 0) return;

		const id = currentSessionId || sessionManager.generateId();
		const sessionName = name || currentSessionName || `Session ${new Date().toLocaleString()}`;

		const saved = sessionManager.saveSession(
			id,
			sessionName,
			modeManager.currentMode,
			state.messages,
			state.systemPrompt,
			state.extraSystemPrompt,
			agentLoop.planner.currentPlan,
		);
		currentSessionId = saved.id;
		currentSessionName = saved.name;
	};

	// ---- Interactive REPL (event-driven, allows /btw during agent execution) ----
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		completer: createCompleter(sessionManager, skillsLoader, taskLogManager),
	});
	console.log(`${C.dim}Commands: /mode, /profile, /profiles, /stream, /skill, /skills, /parallel, /btw, exit${C.reset}`);
	console.log(`${C.dim}Session:  /save, /sessions, /resume, /new, /auto-save${C.reset}`);
	console.log(`${C.dim}Tasks:   /tasks, /task <id>, /delete-task <id>${C.reset}`);
	console.log(`${C.dim}Tip: use /btw <hint> any time — even while agent is running; /btw cancel to abort current tool${C.reset}`);
	console.log(`${C.dim}Tip: press Tab to auto-complete commands like /resume, /mode, /profile, /skill${C.reset}\n`);

	let agentIsRunning = false;
	const bufferedLines: string[] = [];
	let processingLock = false;

	const displayPrompt = () => {
		if (agentIsRunning) {
			process.stdout.write(`${C.bold}${C.yellow}[running - /btw to intervene]${C.reset} `);
		} else {
			process.stdout.write(`${C.bold}${C.blue}${modeLabel}> ${C.reset}`);
		}
	};

	const processTask = async (task: string) => {
		agentIsRunning = true;
		try {
			// Rebuild skills context with the actual task for auto-matching
			const taskExtra = buildSkillsContext(skillsLoader, undefined, task);
			agentLoop.setExtraSystemPrompt(taskExtra);

			// Auto-select/switch model based on the prompt scenario
			applyModelRouting(task);

			await agentLoop.run(task);
			autoSaveSession(task.substring(0, 80));
			// Auto-save task log
			const status = agentLoop.lastTaskError ? 'failed' : 'completed';
			const taskLog = agentLoop.exportTaskLog(status, agentLoop.lastTaskError);
			taskLogManager.saveTaskLog(taskLog);
		} catch (err: any) {
			log(C.red, 'ERROR', err.message);
		}
		agentIsRunning = false;
	};

	// Process any input buffered while the agent was running.
	// With the idle /btw semantics (a hint is a direct prompt), a buffered
	// /btw is also executed immediately as a task rather than silently accumulated.
	const drainBufferedLines = async () => {
		while (bufferedLines.length > 0) {
			const next = bufferedLines.shift()!;
			if (next.startsWith('/btw ')) {
				const hint = next.slice(5).trim();
				if (hint && hint !== 'cancel' && hint !== 'abort') {
					log(C.magenta, 'BTW', `Buffered hint as prompt: "${hint.substring(0, 80)}${hint.length > 80 ? '...' : ''}"`);
					await processTask(hint);
				}
				continue;
			}
			console.log(`\n${C.dim}--- Processing queued: "${next.substring(0, 80)}${next.length > 80 ? '...' : ''}" ---${C.reset}`);
			await processTask(next);
		}
	};

	// Shared graceful exit — saves session, disposes agent, and exits cleanly.
	// Used by both the "exit" command and Ctrl+C (SIGINT).
	const gracefulExit = async () => {
		try {
			// Cancel agent if running
			if (agentIsRunning) {
				agentLoop.cancel();
				agentIsRunning = false;
			}
			// Save session for resuming later
			autoSaveSession();
			if (currentSessionId) {
				console.log(`\n${C.dim}Session saved: ${currentSessionId}${C.reset}`);
			}
			console.log(`${C.dim}Goodbye!${C.reset}`);
		} catch (e) {
			// Ensure we always try to clean up even if save fails
			console.error('Error during graceful exit:', e);
		}
		rl.close();
		agentLoop.dispose();
		// Flush any pending Langfuse spans before the hard exit below.
		await flushTracing();
		// Ensure process exits cleanly (readline close may not be enough with active promises)
		setTimeout(() => process.exit(0), 100);
	};

	rl.on('line', async (input) => {
		const trimmed = input.trim();

		// ---- Agent is running: intercept /btw, buffer everything else ----
		if (agentIsRunning) {
			if (trimmed.startsWith('/btw ')) {
				const hint = trimmed.slice(5).trim();
				if (hint) {
					// Check for cancel/abort command
					if (hint === 'cancel' || hint === 'abort') {
						const cancelled = agentLoop.cancelCurrentTool();
						if (cancelled) {
							log(C.magenta, 'BTW', 'Cancelling current tool execution...');
						} else {
							log(C.yellow, 'BTW', 'No tool currently running to cancel');
						}
					} else {
						agentLoop.injectBtwHint(hint);
						log(C.magenta, 'BTW', `Hint injected: "${hint.substring(0, 100)}${hint.length > 100 ? '...' : ''}"`);
					}
				} else {
					log(C.yellow, 'BTW', 'Usage: /btw <your hint>  or  /btw cancel  (to abort current tool)');
				}
			} else if (trimmed) {
				bufferedLines.push(trimmed);
				log(C.dim, 'QUEUED', `"${trimmed.substring(0, 60)}${trimmed.length > 60 ? '...' : ''}" — will process after current task`);
			}
			displayPrompt();
			return;
		}

		// ---- Prevent overlapping line processing ----
		if (processingLock) {
			bufferedLines.push(trimmed);
			return;
		}

		// ---- Normal REPL processing (agent is idle) ----
		if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
			void gracefulExit();
			return;
		}

		processingLock = true;

		try {
			// ---- Session commands ----
			if (trimmed.startsWith('/save')) {
				const name = trimmed.slice(5).trim() || currentSessionName || '';
				autoSaveSession(name);
				console.log(`${C.green}Session saved: ${currentSessionId}${C.reset}${name ? ` (${name})` : ''}`);
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed === '/sessions') {
				const sessions = sessionManager.listSessions();
				if (sessions.length === 0) {
					console.log(`${C.dim}No saved sessions.${C.reset}`);
				} else {
					console.log(`\n${C.bold}Saved sessions (${sessions.length}):${C.reset}\n`);
					for (const s of sessions) {
						const date = new Date(s.updatedAt).toLocaleString();
						const modeLabel2 = s.mode === AgentMode.Plan ? 'Plan' : s.mode === AgentMode.Ask ? 'Ask' : 'Agent';
						const isCurrent = s.id === currentSessionId ? ` ${C.green}(current)` : '';
						console.log(`  ${C.cyan}${s.id}${C.reset}${isCurrent}`);
						console.log(`    ${C.bold}Name:${C.reset} ${s.name || '(unnamed)'}  ${C.bold}Mode:${C.reset} ${modeLabel2}  ${C.bold}Msgs:${C.reset} ${s.messageCount}`);
						console.log(`    ${C.bold}Updated:${C.reset} ${date}`);
						if (s.summary) {
							console.log(`    ${C.dim}${s.summary.substring(0, 120)}${C.reset}`);
						}
						console.log('');
					}
				}
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed.startsWith('/resume')) {
				const targetId = trimmed.slice(7).trim();
				const session = targetId
					? sessionManager.loadSession(targetId)
					: sessionManager.getLatestSession();

				if (!session) {
					log(C.yellow, 'SESSION', targetId ? `Session "${targetId}" not found` : 'No sessions to resume');
					processingLock = false; displayPrompt(); return;
				}

				autoSaveSession();
				modeManager.switchMode(session.mode);
				// Rebuild extraSystemPrompt with current version — ignore stored old version
				const rebuiltExtra = buildSkillsContext(skillsLoader, undefined, undefined);
				agentLoop.restoreFromSession(
					session.messages,
					session.systemPrompt || '',
					rebuiltExtra || '',
				);
				currentSessionId = session.id;
				currentSessionName = session.name;

				const date = new Date(session.updatedAt).toLocaleString();
				console.log(`${C.magenta}[SESSION]${C.reset} Resumed "${session.name || session.id}" (${session.messageCount} msgs, ${date})`);
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed === '/new') {
				autoSaveSession();
				agentLoop.restoreFromSession([], '', extraPrompt || '');
				currentSessionId = undefined;
				currentSessionName = '';
				console.log(`${C.magenta}[SESSION]${C.reset} Started new session`);
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed === '/auto-save') {
				autoSaveEnabled = !autoSaveEnabled;
				console.log(`${C.magenta}[SESSION]${C.reset} Auto-save ${autoSaveEnabled ? 'enabled' : 'disabled'}`);
				processingLock = false; displayPrompt(); return;
			}

			// ---- Task log commands ----
			if (trimmed === '/tasks') {
				const taskLogs = taskLogManager.listTaskLogs();
				if (taskLogs.length === 0) {
					console.log(`${C.dim}No saved task logs.${C.reset}`);
				} else {
					console.log(`\n${C.bold}Task logs (${taskLogs.length}):${C.reset}\n`);
					for (const t of taskLogs) {
						const date = new Date(t.startedAt).toLocaleString();
						const dur = (t.durationMs / 1000).toFixed(1);
						const statusIcon = t.status === 'completed' ? `${C.green}✓` : t.status === 'failed' ? `${C.red}✗` : `${C.yellow}⊘`;
						console.log(`  ${C.cyan}${t.id}${C.reset} ${statusIcon}${C.reset}  ${C.dim}${dur}s${C.reset}`);
						console.log(`    ${t.task.substring(0, 100)}`);
						console.log(`    ${C.dim}${new Date(t.startedAt).toLocaleString()} | ${t.mode} | ${t.totalSteps} steps | ${t.totalToolCalls} tools${C.reset}`);
						console.log('');
					}
				}
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed.startsWith('/task ')) {
				const targetId = trimmed.slice(6).trim();
				const log = taskLogManager.loadTaskLog(targetId);
				if (!log) {
					console.log(`${C.yellow}Task log "${targetId}" not found${C.reset}`);
				} else {
					console.log(`\n${C.bold}=== Task Log: ${log.id} ===${C.reset}\n`);
					console.log(taskLogManager.formatTaskLog(log));
				}
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed.startsWith('/delete-task ')) {
				const targetId = trimmed.slice(13).trim();
				if (taskLogManager.deleteTaskLog(targetId)) {
					console.log(`${C.green}Task log "${targetId}" deleted${C.reset}`);
				} else {
					console.log(`${C.yellow}Task log "${targetId}" not found${C.reset}`);
				}
				processingLock = false; displayPrompt(); return;
			}

			// ---- Mode/profile commands ----
			if (trimmed.startsWith('/mode ')) {
				const newMode = trimmed.slice(6).trim();
				if (newMode === 'plan') modeManager.switchMode(AgentMode.Plan);
				else if (newMode === 'ask') modeManager.switchMode(AgentMode.Ask);
				else modeManager.switchMode(AgentMode.Agent);
				log(C.magenta, 'MODE', `Switched to ${newMode}`);
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed === '/stream') {
				agentLoop.setStreaming(!opts.streaming);
				opts.streaming = !opts.streaming;
				log(C.magenta, 'STREAM', `Streaming ${opts.streaming ? 'enabled' : 'disabled'}`);
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed === '/profiles') {
				const profiles = listProfiles();
				for (const p of profiles) {
					const active = p.name === resolved.profileName ? ` ${C.green}(active)` : '';
					console.log(`  ${C.cyan}${p.name}${C.reset}  ${C.dim}${p.provider}/${p.model}${active}${C.reset}`);
				}
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed.startsWith('/profile ')) {
				const newProfileName = trimmed.slice(9).trim();
				const previousProfile = resolved.profileName;
				const previousModel = currentModel;
				try {
					const newResolved = loadConfigForProfile(newProfileName);
					if (!newResolved.agentConfig.apiKey) {
						log(C.red, 'ERROR', `Profile "${newProfileName}" has no API key configured`);
						processingLock = false; displayPrompt(); return;
					}
					const newProvider = LLMProviderFactory.create(newResolved.agentConfig);
					agentLoop.swapProvider(newResolved.agentConfig, newProvider, 'profile');
					resolved = newResolved;
					setResolvedSkillDirs(newResolved.skillsDirs);
					modelRouter = new ModelRouter(newResolved.modelRouting, newResolved.profiles, newResolved.agentConfig);
					currentModel = newResolved.agentConfig.model;
					// Re-register the 保底 model for the new profile's routing config.
					wireModelFallback(agentLoop, modelRouter);
					const nc = newResolved.agentConfig;
					log(C.magenta, 'PROFILE', `Switched ${previousProfile} (${previousModel}) → ${newProfileName} (${nc.provider}/${nc.model})`);
				} catch (err: any) {
					log(C.red, 'ERROR', `Failed to switch profile: ${err.message}`);
				}
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed === '/skills') {
				if (skillsLoader.skills.length === 0) {
					console.log(`${C.dim}No skills loaded. Configure skills directories in config.yaml.${C.reset}`);
				} else {
					console.log(`\n${C.bold}Loaded skills (${skillsLoader.skills.length}):${C.reset}`);
					for (const s of skillsLoader.skills) {
						console.log(`  ${C.cyan}${s.name}${C.reset}  ${C.dim}${s.description.substring(0, 80)}${C.reset}`);
						if (s.whenToUse) {
							console.log(`      whenToUse: ${C.dim}${s.whenToUse.substring(0, 100)}${C.reset}`);
						}
					}
				}
				console.log(`${C.dim}Skill tools: skill_catalog / create_skill / update_skill (ask the agent to manage skills)${C.reset}`);
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed.startsWith('/skill ')) {
				const skillName = trimmed.slice(7).trim();
				// In REPL mode, no task description yet — but pass empty so the
				// explicitly activated skill still gets its full content via buildSkillsContext.
				const newExtra = buildSkillsContext(skillsLoader, skillName, undefined);
				agentLoop.setExtraSystemPrompt(newExtra);
				log(C.magenta, 'SKILL', skillName ? `Activated skill: ${skillName}` : 'Cleared active skill');
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed.startsWith('/parallel ')) {
				const tasks = trimmed.slice(10).match(/"[^"]+"/g)?.map(t => t.replace(/"/g, '')) || [];
				if (tasks.length >= 2) {
					await runParallelMode(tasks, resolved, opts.memory);
				} else {
					log(C.red, 'ERROR', 'Provide at least 2 tasks in quotes: /parallel "task1" "task2"');
				}
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed === '/continue' || trimmed === 'continue') {
				try {
					await agentLoop.continueSession();
					autoSaveSession();
					const status = agentLoop.lastTaskError ? 'failed' : 'completed';
					const taskLog = agentLoop.exportTaskLog(status, agentLoop.lastTaskError);
					taskLogManager.saveTaskLog(taskLog);
				} catch (err: any) {
					log(C.red, 'ERROR', err.message);
				}
				processingLock = false; displayPrompt(); return;
			}

			// ---- /btw when agent is idle: treat as a direct prompt and respond immediately ----
			if (trimmed.startsWith('/btw ')) {
				const hint = trimmed.slice(5).trim();
				if (hint) {
					if (hint === 'cancel' || hint === 'abort') {
						log(C.yellow, 'BTW', 'No agent currently running. Use /btw cancel while agent is running to abort a tool.');
					} else {
						log(C.magenta, 'BTW', `Direct prompt: "${hint.substring(0, 100)}${hint.length > 100 ? '...' : ''}"`);
						await processTask(hint);
						await drainBufferedLines();
					}
				} else {
					log(C.yellow, 'BTW', 'Usage: /btw <your hint>  or  /btw cancel  (to abort current tool)');
				}
				processingLock = false; displayPrompt(); return;
			}

			// ---- Task execution ----
			await processTask(trimmed);

			// Process any buffered input (typed during agent execution)
			await drainBufferedLines();
		} finally {
			processingLock = false;
			displayPrompt();
		}
	});

	// Handle Ctrl+C gracefully — same as "exit": save session and quit
	rl.on('SIGINT', () => {
		void gracefulExit();
	});

	displayPrompt();

	// If a task was passed on CLI, inject it into the REPL so /btw works during execution
	if (opts.tasks.length > 0) {
		const task = opts.tasks.join(' ');
		rl.write(task + '\n');
	}
}

const CLI_EXCLUDED_RULE_PATTERNS = ['askquestion', 'durable-request', 'durable request'];

function buildSkillsContext(loader: SkillsLoader, activeSkill?: string, taskDescription?: string): string {
	let prompt = '';

	// Preload ALL rules content (not just alwaysApply) for auto-matching
	prompt += loader.buildPreloadRulesPromptSection(CLI_EXCLUDED_RULE_PATTERNS);

	// Auto-match skills based on the user's task description
	let preActivatedSkills: Set<string> | undefined;
	if (taskDescription) {
		preActivatedSkills = loader.getAutoMatchedSkills(taskDescription);
	}

	// If user explicitly activated a skill, always include it
	if (activeSkill) {
		if (!preActivatedSkills) preActivatedSkills = new Set();
		preActivatedSkills.add(activeSkill);
	}

	// Build skills section — pre-activated skills get their FULL content included
	prompt += loader.buildSkillsPromptSection(preActivatedSkills);

	// "Skills of skills" meta-skill: teach the agent to package its own skills
	// (canonical SKILL.md contract, dedup recall, publication location).
	const skillDirs = getResolvedSkillDirs();
	prompt += loader.buildMetaSkillPromptSection(skillDirs);

	// Self-evolution methodology: how to read run evidence, judge a finding, and
	// release the fix through the gate. Empty when the feature is disabled.
	prompt += buildSelfEvolvePromptSection(selfUpdateConfig());

	// If user explicitly activated a skill not in the auto-matched set,
	// append its full content separately (redundancy for safety)
	if (activeSkill) {
		const content = loader.getSkillContent(activeSkill);
		if (content && preActivatedSkills?.has(activeSkill)) {
			// Content already included via buildSkillsPromptSection — skip duplicate
		} else if (content) {
			prompt += `\n## Active Skill: ${activeSkill}\n\n${content}\n`;
		}
	}

	return prompt;
}

// Tracks the resolved skills dirs for the meta-skill prompt (set at startup).
let _resolvedSkillDirs: string[] = [];
function getResolvedSkillDirs(): string[] {
	return _resolvedSkillDirs;
}
function setResolvedSkillDirs(dirs: string[]): void {
	_resolvedSkillDirs = dirs && dirs.length > 0 ? dirs : [defaultSkillsDir()];
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
