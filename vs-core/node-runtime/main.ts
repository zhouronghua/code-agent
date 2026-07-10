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
 *
 *  Config resolution (highest priority first):
 *    1. CLI flags
 *    2. Environment variables (OPENAI_API_KEY, LLM_MODEL, etc.)
 *    3. ./config.yaml
 *    4. ~/.codeagent/config.yaml
 *--------------------------------------------------------------------------------------------*/

import * as readline from 'node:readline';
import { URI } from '../base/common/uri';
import { AgentMode, MessageRole } from '../../src/vs/workbench/services/agent/common/agentModels';
import { LLMProviderFactory } from '../../src/vs/workbench/services/agent/browser/llmProvider';
import '../../src/vs/workbench/services/agent/browser/llmOpenai';
import { ToolRegistry } from '../../src/vs/workbench/contrib/agent/common/agentTools';
import { AgentModeManager } from '../../src/vs/workbench/contrib/agent/common/agentModes';
import { AgentCheckpointManager } from '../../src/vs/workbench/contrib/agent/common/agentCheckpoint';
import { AgentLoop } from '../../src/vs/workbench/contrib/agent/common/agent';
import { ParallelAgentManager } from '../../src/vs/workbench/contrib/agent/common/agentParallel';
import { ReadFileTool } from '../../src/vs/workbench/contrib/agent/common/tools/readFile';
import { WriteFileTool } from '../../src/vs/workbench/contrib/agent/common/tools/writeFile';
import { EditFileTool } from '../../src/vs/workbench/contrib/agent/common/tools/editFile';
import { ListDirectoryTool } from '../../src/vs/workbench/contrib/agent/common/tools/listDir';
import { SearchTextTool } from '../../src/vs/workbench/contrib/agent/common/tools/searchText';
import { SearchFilesTool } from '../../src/vs/workbench/contrib/agent/common/tools/searchFiles';
import { RunTerminalTool } from '../../src/vs/workbench/contrib/agent/common/tools/runTerminal';
import { loadConfig, loadConfigForProfile, listProfiles, ResolvedConfig } from '../../src/vs/workbench/contrib/agent/common/agentConfig';
import { SkillsLoader } from '../../src/vs/workbench/contrib/agent/common/agentSkills';
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
  --help                      Show this help

Session Management:
  Sessions persist your agent conversation context across restarts.
  - Auto-save: after each run, the session is saved automatically.
  - REPL commands: /save, /sessions, /resume, /new, /auto-save
  - Tab-completion: press Tab to auto-complete /resume, /mode, /profile, /skill, etc.
  - Storage: ~/.codeagent/sessions/

Task Logs (for troubleshooting):
  - Auto-save: after each task, a detailed execution log is saved automatically.
  - Includes: LLM requests/responses, tool calls with arguments and results, timings.
  - REPL commands: /tasks, /task <id>, /delete-task <id>
  - Storage: ~/.codeagent/tasks/

Intervention:
  /btw <hint>    Inject a hint into the agent's reasoning for subsequent
                 turns. Accumulates across multiple /btw calls.
                 Useful for course-correcting or adding context mid-session.
  /btw cancel    Cancel the currently running tool (e.g., a long build or
                 poll). The agent will continue with the next step.

Modes:
  agent   Full autonomy: read, write, edit files, run commands
  plan    Generate implementation plan without executing
  ask     Read-only: explore codebase and answer questions

Config (searched in order):
  1. CLI flags / env vars (OPENAI_API_KEY, LLM_MODEL, etc.)
  2. ./config.yaml
  3. ~/.codeagent/config.yaml
`);
}

function createServices(resolved: ResolvedConfig) {
	const config = resolved.agentConfig;

	if (!config.apiKey) {
		console.error(`${C.red}No API key found. Set OPENAI_API_KEY, or configure apiKey in ~/.codeagent/models.json or config.yaml.${C.reset}`);
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
	toolRegistry.register(new RunTerminalTool(terminalService, process.cwd()));

	const checkpointManager = new AgentCheckpointManager(fileService);

	return { config, llmProvider, toolRegistry, checkpointManager };
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
				log(C.dim, 'THINKING', msg.reasoningContent);
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

	agentLoop.onDidError(err => log(C.red, 'ERROR', err.message));
	agentLoop.onDidComplete(() => console.log(`\n${C.dim}--- Task completed ---${C.reset}\n`));
}

async function runParallelMode(tasks: string[], resolved: ResolvedConfig) {
	const { config, llmProvider, toolRegistry, checkpointManager } = createServices(resolved);

	console.log(`\n${C.bold}${C.magenta}=== Parallel Agent Mode ===${C.reset}`);
	console.log(`${C.dim}Running ${tasks.length} tasks concurrently (max 4)${C.reset}\n`);

	const taskLogManager = new TaskLogManager();
	const manager = new ParallelAgentManager(config, llmProvider, toolRegistry, process.cwd(), checkpointManager, 4);

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

async function main() {
	const opts = parseArgs();
	const sessionManager = new AgentSessionManager(process.cwd());
	const taskLogManager = new TaskLogManager();

	// Handle info-only commands
	if (opts.showProfiles) {
		const profiles = listProfiles();
		if (profiles.length === 0) {
			console.log(`${C.dim}No models.json or config.yaml found. Create ~/.codeagent/models.json or ~/.codeagent/config.yaml${C.reset}`);
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

	// Load config (merges config.yaml + env vars + CLI flags)
	let resolved = loadConfig(opts.profile);

	// Load skills and rules
	const skillsLoader = new SkillsLoader();
	skillsLoader.loadSkillsFromDirs(resolved.skillsDirs);
	skillsLoader.loadRulesFromDirs(resolved.rulesDirs);

	if (opts.showSkills) {
		if (skillsLoader.skills.length === 0) {
			console.log(`${C.dim}No skills found. Configure skills directories in config.yaml.${C.reset}`);
		} else {
			console.log(`\n${C.bold}Loaded skills (${skillsLoader.skills.length}):${C.reset}`);
			for (const s of skillsLoader.skills) {
				console.log(`  ${C.cyan}${s.name}${C.reset}  ${C.dim}${s.description.substring(0, 80)}${C.reset}`);
			}
		}
		if (skillsLoader.rules.length > 0) {
			console.log(`\n${C.bold}Loaded rules (${skillsLoader.rules.length}):${C.reset}`);
			for (const r of skillsLoader.rules) {
				const tag = r.alwaysApply ? `${C.green}always` : `${C.yellow}manual`;
				console.log(`  ${tag}${C.reset}  ${C.dim}${r.description}${C.reset}`);
			}
		}
		return;
	}

	const modeLabel = opts.mode === AgentMode.Plan ? 'Plan' : opts.mode === AgentMode.Ask ? 'Ask' : 'Agent';

	console.log(`\n${C.bold}${C.green}===========================================${C.reset}`);
	console.log(`${C.bold}  CodeAgent v${AGENT_VERSION} - ${modeLabel} Mode${C.reset}`);
	console.log(`${C.bold}${C.green}===========================================${C.reset}`);

	const cfg = resolved.agentConfig;
	console.log(`${C.dim}Profile: ${resolved.profileName} | Provider: ${cfg.provider} | Model: ${cfg.model}${C.reset}`);
	console.log(`${C.dim}API Base: ${cfg.apiBase || 'default'} | Mode: ${modeLabel}${opts.streaming ? ' | Streaming' : ''}${C.reset}`);
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

	if (opts.parallel && opts.tasks.length > 1) {
		await runParallelMode(opts.tasks, resolved);
		return;
	}

	const { config, llmProvider, toolRegistry, checkpointManager } = createServices(resolved);
	const modeManager = new AgentModeManager();
	modeManager.switchMode(opts.mode);

	const agentLoop = new AgentLoop(config, llmProvider, toolRegistry, modeManager, checkpointManager, process.cwd());
	if (opts.streaming) {
		agentLoop.setStreaming(true);
	}

	// Inject skills + rules into agent's system prompt
	const extraPrompt = buildSkillsContext(skillsLoader, opts.useSkill);
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
		agentLoop.restoreFromSession(
			sessionToResume.messages,
			sessionToResume.systemPrompt || '',
			sessionToResume.extraSystemPrompt || '',
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

	// ---- Single task (non-interactive) ----
	if (opts.tasks.length > 0) {
		const task = opts.tasks.join(' ');
		await agentLoop.run(task);

		// Auto-save session
		autoSaveSession(task.substring(0, 80));
		console.log(`${C.dim}[Session saved: ${currentSessionId}]${C.reset}`);

		// Auto-save task log
		const status = agentLoop.lastTaskError ? 'failed' : 'completed';
		const taskLog = agentLoop.exportTaskLog(status, agentLoop.lastTaskError);
		taskLogManager.saveTaskLog(taskLog);
		console.log(`${C.dim}[Task log saved: ${taskLog.id}]${C.reset}`);

		agentLoop.dispose();
		return;
	}

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

	// Shared graceful exit — saves session, disposes agent, and exits cleanly.
	// Used by both the "exit" command and Ctrl+C (SIGINT).
	const gracefulExit = () => {
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
			gracefulExit();
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
				agentLoop.restoreFromSession(
					session.messages,
					session.systemPrompt || '',
					session.extraSystemPrompt || '',
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
				try {
					const newResolved = loadConfigForProfile(newProfileName);
					if (!newResolved.agentConfig.apiKey) {
						log(C.red, 'ERROR', `Profile "${newProfileName}" has no API key configured`);
						processingLock = false; displayPrompt(); return;
					}
					const newProvider = LLMProviderFactory.create(newResolved.agentConfig);
					agentLoop.swapProvider(newResolved.agentConfig, newProvider);
					resolved = newResolved;
					const nc = newResolved.agentConfig;
					log(C.magenta, 'PROFILE', `Switched to ${newProfileName} (${nc.provider}/${nc.model})`);
				} catch (err: any) {
					log(C.red, 'ERROR', `Failed to switch profile: ${err.message}`);
				}
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed === '/skills') {
				for (const s of skillsLoader.skills) {
					console.log(`  ${C.cyan}${s.name}${C.reset}  ${C.dim}${s.description.substring(0, 80)}${C.reset}`);
				}
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed.startsWith('/skill ')) {
				const skillName = trimmed.slice(7).trim();
				const newExtra = buildSkillsContext(skillsLoader, skillName);
				agentLoop.setExtraSystemPrompt(newExtra);
				log(C.magenta, 'SKILL', skillName ? `Activated skill: ${skillName}` : 'Cleared active skill');
				processingLock = false; displayPrompt(); return;
			}

			if (trimmed.startsWith('/parallel ')) {
				const tasks = trimmed.slice(10).match(/"[^"]+"/g)?.map(t => t.replace(/"/g, '')) || [];
				if (tasks.length >= 2) {
					await runParallelMode(tasks, resolved);
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

			// ---- /btw when agent is idle: accumulate for next run ----
			if (trimmed.startsWith('/btw ')) {
				const hint = trimmed.slice(5).trim();
				if (hint) {
					if (hint === 'cancel' || hint === 'abort') {
						log(C.yellow, 'BTW', 'No agent currently running. Use /btw cancel while agent is running to abort a tool.');
					} else {
						agentLoop.appendExtraSystemPrompt(hint);
						log(C.magenta, 'BTW', `Hint injected: "${hint.substring(0, 100)}${hint.length > 100 ? '...' : ''}"`);
						console.log(`${C.dim}(Will affect subsequent agent reasoning in this session)${C.reset}`);
					}
				} else {
					log(C.yellow, 'BTW', 'Usage: /btw <your hint>  or  /btw cancel  (to abort current tool)');
				}
				processingLock = false; displayPrompt(); return;
			}

			// ---- Task execution ----
			await processTask(trimmed);

			// Process any buffered input (typed during agent execution)
			while (bufferedLines.length > 0) {
				const next = bufferedLines.shift()!;
				if (next.startsWith('/btw ')) {
					// Handle /btw that was buffered during execution
					const hint = next.slice(5).trim();
					if (hint) {
						agentLoop.appendExtraSystemPrompt(hint);
						log(C.magenta, 'BTW', `Buffered hint applied: "${hint.substring(0, 80)}${hint.length > 80 ? '...' : ''}"`);
					}
					continue;
				}
				console.log(`\n${C.dim}--- Processing queued: "${next.substring(0, 80)}${next.length > 80 ? '...' : ''}" ---${C.reset}`);
				await processTask(next);
			}
		} finally {
			processingLock = false;
			displayPrompt();
		}
	});

	// Handle Ctrl+C gracefully — same as "exit": save session and quit
	rl.on('SIGINT', () => {
		gracefulExit();
	});

	displayPrompt();
}

const CLI_EXCLUDED_RULE_PATTERNS = ['askquestion', 'durable-request', 'durable request'];

function buildSkillsContext(loader: SkillsLoader, activeSkill?: string): string {
	let prompt = '';

	// Preload ALL rules content (not just alwaysApply) for auto-matching
	prompt += loader.buildPreloadRulesPromptSection(CLI_EXCLUDED_RULE_PATTERNS);
	// Preload skills titles for auto-matching
	prompt += loader.buildSkillsPromptSection();

	if (activeSkill) {
		const content = loader.getSkillContent(activeSkill);
		if (content) {
			prompt += `\n## Active Skill: ${activeSkill}\n\n${content}\n`;
		}
	}

	return prompt;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
