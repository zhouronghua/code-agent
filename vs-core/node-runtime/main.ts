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

interface CLIOptions {
	mode: AgentMode;
	streaming: boolean;
	parallel: boolean;
	tasks: string[];
	profile?: string;
	showProfiles: boolean;
	showSkills: boolean;
	useSkill?: string;
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

const AGENT_VERSION = '0.2.4';

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
  --help                      Show this help

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
		console.error(`${C.red}No API key found. Set OPENAI_API_KEY, or configure api_key in config.yaml.${C.reset}`);
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

	const manager = new ParallelAgentManager(config, llmProvider, toolRegistry, checkpointManager, 4);

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
	}

	manager.dispose();
}

async function main() {
	const opts = parseArgs();

	// Handle info-only commands
	if (opts.showProfiles) {
		const profiles = listProfiles();
		if (profiles.length === 0) {
			console.log(`${C.dim}No config.yaml found. Run from project root or create ~/.codeagent/config.yaml${C.reset}`);
		} else {
			console.log(`\n${C.bold}Available profiles:${C.reset}`);
			for (const p of profiles) {
				console.log(`  ${C.cyan}${p.name}${C.reset}  ${C.dim}${p.provider}/${p.model}${C.reset}`);
			}
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
	if (skillCount > 0 || ruleCount > 0) {
		console.log(`${C.dim}Skills: ${skillCount} loaded | Rules: ${ruleCount} loaded${C.reset}`);
	}
	console.log('');

	if (opts.parallel && opts.tasks.length > 1) {
		await runParallelMode(opts.tasks, resolved);
		return;
	}

	const { config, llmProvider, toolRegistry, checkpointManager } = createServices(resolved);
	const modeManager = new AgentModeManager();
	modeManager.switchMode(opts.mode);

	const agentLoop = new AgentLoop(config, llmProvider, toolRegistry, modeManager, checkpointManager);
	if (opts.streaming) {
		agentLoop.setStreaming(true);
	}

	// Inject skills + rules into agent's system prompt
	const extraPrompt = buildSkillsContext(skillsLoader, opts.useSkill);
	if (extraPrompt) {
		agentLoop.setExtraSystemPrompt(extraPrompt);
	}

	attachAgentListeners(agentLoop, opts);

	if (opts.tasks.length > 0) {
		const task = opts.tasks.join(' ');
		await agentLoop.run(task);

		if (opts.mode === AgentMode.Plan) {
			const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
			rl.question(`\n${C.bold}Execute this plan? (y/n): ${C.reset}`, async (answer) => {
				if (answer.trim().toLowerCase() === 'y') {
					await agentLoop.executePlan();
				}
				rl.close();
				agentLoop.dispose();
			});
		} else {
			agentLoop.dispose();
		}
		return;
	}

	// Interactive REPL
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	console.log(`${C.dim}Commands: /mode, /profile, /profiles, /stream, /skill, /skills, /parallel, exit${C.reset}\n`);

	const prompt = () => {
		rl.question(`${C.bold}${C.blue}${modeLabel}> ${C.reset}`, async (input) => {
			const trimmed = input.trim();
			if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
				console.log(`${C.dim}Goodbye!${C.reset}`);
				rl.close();
				agentLoop.dispose();
				return;
			}

			if (trimmed.startsWith('/mode ')) {
				const newMode = trimmed.slice(6).trim();
				if (newMode === 'plan') modeManager.switchMode(AgentMode.Plan);
				else if (newMode === 'ask') modeManager.switchMode(AgentMode.Ask);
				else modeManager.switchMode(AgentMode.Agent);
				log(C.magenta, 'MODE', `Switched to ${newMode}`);
				prompt();
				return;
			}

			if (trimmed === '/stream') {
				agentLoop.setStreaming(!opts.streaming);
				opts.streaming = !opts.streaming;
				log(C.magenta, 'STREAM', `Streaming ${opts.streaming ? 'enabled' : 'disabled'}`);
				prompt();
				return;
			}

			if (trimmed === '/profiles') {
				const profiles = listProfiles();
				for (const p of profiles) {
					const active = p.name === resolved.profileName ? ` ${C.green}(active)` : '';
					console.log(`  ${C.cyan}${p.name}${C.reset}  ${C.dim}${p.provider}/${p.model}${active}${C.reset}`);
				}
				prompt();
				return;
			}

			if (trimmed.startsWith('/profile ')) {
				const newProfileName = trimmed.slice(9).trim();
				try {
					const newResolved = loadConfigForProfile(newProfileName);
					if (!newResolved.agentConfig.apiKey) {
						log(C.red, 'ERROR', `Profile "${newProfileName}" has no API key configured`);
						prompt();
						return;
					}
					const newProvider = LLMProviderFactory.create(newResolved.agentConfig);
					agentLoop.swapProvider(newResolved.agentConfig, newProvider);
					resolved = newResolved;
					const nc = newResolved.agentConfig;
					log(C.magenta, 'PROFILE', `Switched to ${newProfileName} (${nc.provider}/${nc.model})`);
				} catch (err: any) {
					log(C.red, 'ERROR', `Failed to switch profile: ${err.message}`);
				}
				prompt();
				return;
			}

			if (trimmed === '/skills') {
				for (const s of skillsLoader.skills) {
					console.log(`  ${C.cyan}${s.name}${C.reset}  ${C.dim}${s.description.substring(0, 80)}${C.reset}`);
				}
				prompt();
				return;
			}

			if (trimmed.startsWith('/skill ')) {
				const skillName = trimmed.slice(7).trim();
				const newExtra = buildSkillsContext(skillsLoader, skillName);
				agentLoop.setExtraSystemPrompt(newExtra);
				log(C.magenta, 'SKILL', skillName ? `Activated skill: ${skillName}` : 'Cleared active skill');
				prompt();
				return;
			}

			if (trimmed.startsWith('/parallel ')) {
				const tasks = trimmed.slice(10).match(/"[^"]+"/g)?.map(t => t.replace(/"/g, '')) || [];
				if (tasks.length >= 2) {
					await runParallelMode(tasks, resolved);
				} else {
					log(C.red, 'ERROR', 'Provide at least 2 tasks in quotes: /parallel "task1" "task2"');
				}
				prompt();
				return;
			}

			try {
				await agentLoop.run(trimmed);
			} catch (err: any) {
				log(C.red, 'ERROR', err.message);
			}
			prompt();
		});
	};
	prompt();
}

const CLI_EXCLUDED_RULE_PATTERNS = ['askquestion', 'durable-request', 'durable request'];

function buildSkillsContext(loader: SkillsLoader, activeSkill?: string): string {
	let prompt = '';

	prompt += loader.buildRulesPromptSection(CLI_EXCLUDED_RULE_PATTERNS);
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
