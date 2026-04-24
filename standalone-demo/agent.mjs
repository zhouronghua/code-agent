#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Standalone Agent Demo - Self-contained Node.js version of the VS Code Agent
 *  No external dependencies. Uses Node.js built-in APIs.
 *  
 *  Usage:
 *    node agent.mjs                              # Interactive mode (requires OPENAI_API_KEY)
 *    MOCK_LLM=1 node agent.mjs                   # Mock mode (no API key needed)
 *    OPENAI_API_KEY=sk-xxx node agent.mjs         # With OpenAI
 *    LLM_PROVIDER=anthropic ANTHROPIC_API_KEY=sk-xxx node agent.mjs
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { execSync } from 'node:child_process';

// ============================================================================
// Config
// ============================================================================

const CONFIG = {
	provider: process.env.LLM_PROVIDER || 'openai',
	model: process.env.LLM_MODEL || 'gpt-4o',
	apiKey: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '',
	apiBase: process.env.LLM_API_BASE || '',
	maxSteps: 20,
	maxContextTokens: 128000,
	temperature: 0,
	useMock: process.env.MOCK_LLM === '1',
};

// ============================================================================
// Color helpers (no dependencies)
// ============================================================================

const C = {
	reset: '\x1b[0m',
	bold: '\x1b[1m',
	dim: '\x1b[2m',
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	blue: '\x1b[34m',
	cyan: '\x1b[36m',
	magenta: '\x1b[35m',
	gray: '\x1b[90m',
};

function log(color, prefix, msg) {
	console.log(`${color}${C.bold}[${prefix}]${C.reset} ${msg}`);
}

// ============================================================================
// Tool Implementations (Node.js native)
// ============================================================================

const TOOLS = {
	read_file: {
		description: 'Read file contents with line numbers',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path to read' },
				offset: { type: 'number', description: 'Start line (1-based)' },
				limit: { type: 'number', description: 'Max lines to read' },
			},
			required: ['path'],
		},
		execute(args) {
			const filePath = args.path;
			if (!fs.existsSync(filePath)) {
				return { success: false, output: '', error: `File not found: ${filePath}` };
			}
			const content = fs.readFileSync(filePath, 'utf-8');
			const lines = content.split('\n');
			const start = Math.max(0, (args.offset || 1) - 1);
			const end = args.limit ? Math.min(lines.length, start + args.limit) : lines.length;
			const selected = lines.slice(start, end);
			const numbered = selected.map((l, i) => `${String(start + i + 1).padStart(6)}|${l}`).join('\n');
			return { success: true, output: `File: ${filePath} (${lines.length} lines, showing ${start + 1}-${end})\n${numbered}` };
		},
	},

	write_file: {
		description: 'Create or overwrite a file',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path' },
				content: { type: 'string', description: 'File content' },
			},
			required: ['path', 'content'],
		},
		execute(args) {
			try {
				const dir = path.dirname(args.path);
				if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
				fs.writeFileSync(args.path, args.content, 'utf-8');
				const lineCount = args.content.split('\n').length;
				return { success: true, output: `Wrote ${lineCount} lines to ${args.path}` };
			} catch (err) {
				return { success: false, output: '', error: err.message };
			}
		},
	},

	edit_file: {
		description: 'Replace exact string in a file',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'File path' },
				old_string: { type: 'string', description: 'String to find' },
				new_string: { type: 'string', description: 'Replacement' },
			},
			required: ['path', 'old_string', 'new_string'],
		},
		execute(args) {
			if (!fs.existsSync(args.path)) {
				return { success: false, output: '', error: `File not found: ${args.path}` };
			}
			const content = fs.readFileSync(args.path, 'utf-8');
			const count = content.split(args.old_string).length - 1;
			if (count === 0) {
				return { success: false, output: '', error: 'old_string not found in file' };
			}
			const idx = content.indexOf(args.old_string);
			const newContent = content.substring(0, idx) + args.new_string + content.substring(idx + args.old_string.length);
			fs.writeFileSync(args.path, newContent, 'utf-8');
			return { success: true, output: `Replaced 1 occurrence in ${args.path}` };
		},
	},

	list_directory: {
		description: 'List directory contents',
		parameters: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Directory path' },
				recursive: { type: 'boolean', description: 'List recursively' },
			},
			required: ['path'],
		},
		execute(args) {
			if (!fs.existsSync(args.path)) {
				return { success: false, output: '', error: `Directory not found: ${args.path}` };
			}
			const lines = [];
			function walk(dir, prefix, depth) {
				if (depth > 3) return;
				const entries = fs.readdirSync(dir, { withFileTypes: true })
					.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
				for (const e of entries) {
					if (e.name.startsWith('.')) continue;
					const icon = e.isDirectory() ? '[dir]' : '[file]';
					lines.push(`${prefix}${icon} ${e.name}`);
					if (e.isDirectory() && args.recursive) {
						walk(path.join(dir, e.name), prefix + '  ', depth + 1);
					}
				}
			}
			walk(args.path, '', 0);
			return { success: true, output: `Directory: ${args.path}\n${lines.join('\n')}` };
		},
	},

	search_text: {
		description: 'Search for text pattern in files (uses grep)',
		parameters: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Search pattern' },
				path: { type: 'string', description: 'Search directory' },
				glob: { type: 'string', description: 'File glob filter' },
			},
			required: ['pattern'],
		},
		execute(args) {
			const searchPath = args.path || '.';
			try {
				let cmd = `rg --no-heading -n "${args.pattern.replace(/"/g, '\\"')}" "${searchPath}"`;
				if (args.glob) { cmd += ` --glob "${args.glob}"`; }
				cmd += ' --max-count 50 2>/dev/null || grep -rn "${args.pattern}" "${searchPath}" --include="${args.glob || "*"}" 2>/dev/null | head -50';
				const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
				return { success: true, output: output || 'No matches found' };
			} catch {
				return { success: true, output: 'No matches found' };
			}
		},
	},

	run_terminal: {
		description: 'Execute a shell command',
		parameters: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'Shell command' },
				cwd: { type: 'string', description: 'Working directory' },
			},
			required: ['command'],
		},
		execute(args) {
			try {
				const output = execSync(args.command, {
					encoding: 'utf-8',
					cwd: args.cwd || process.cwd(),
					timeout: 30000,
					stdio: ['pipe', 'pipe', 'pipe'],
				});
				return { success: true, output: output.trim() || '(no output)' };
			} catch (err) {
				const stderr = err.stderr?.toString() || '';
				const stdout = err.stdout?.toString() || '';
				return { success: false, output: stdout, error: stderr || err.message };
			}
		},
	},
};

// ============================================================================
// LLM Providers
// ============================================================================

async function callOpenAI(messages, tools) {
	const body = {
		model: CONFIG.model,
		messages: messages.map(m => {
			const msg = { role: m.role, content: m.content };
			if (m.tool_calls) msg.tool_calls = m.tool_calls;
			if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
			if (m.reasoning_content) msg.reasoning_content = m.reasoning_content;
			return msg;
		}),
		temperature: CONFIG.temperature,
	};
	if (tools.length > 0) {
		body.tools = tools.map(t => ({ type: 'function', function: t }));
	}

	const base = CONFIG.apiBase || 'https://api.openai.com/v1';
	const resp = await fetch(`${base}/chat/completions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CONFIG.apiKey}` },
		body: JSON.stringify(body),
	});
	if (!resp.ok) throw new Error(`OpenAI API ${resp.status}: ${await resp.text()}`);
	const data = await resp.json();
	const msg = data.choices[0].message;
	if (msg.reasoning_content) msg.reasoning_content = msg.reasoning_content;
	return msg;
}

async function callAnthropic(messages, tools) {
	const systemMsg = messages.find(m => m.role === 'system');
	const nonSystem = messages.filter(m => m.role !== 'system');

	const body = {
		model: CONFIG.model || 'claude-sonnet-4-20250514',
		max_tokens: 4096,
		temperature: CONFIG.temperature,
		messages: nonSystem.map(m => {
			if (m.role === 'tool') {
				return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] };
			}
			if (m.role === 'assistant' && m.tool_calls) {
				const content = [];
				if (m.content) content.push({ type: 'text', text: m.content });
				for (const tc of m.tool_calls) {
					content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: JSON.parse(tc.function.arguments) });
				}
				return { role: 'assistant', content };
			}
			return { role: m.role, content: m.content };
		}),
	};
	if (systemMsg) body.system = systemMsg.content;
	if (tools.length > 0) {
		body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
	}

	const resp = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', 'x-api-key': CONFIG.apiKey, 'anthropic-version': '2023-06-01' },
		body: JSON.stringify(body),
	});
	if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
	const data = await resp.json();

	let content = '';
	const toolCalls = [];
	for (const block of data.content) {
		if (block.type === 'text') content += block.text;
		if (block.type === 'tool_use') {
			toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input) } });
		}
	}
	return { role: 'assistant', content, tool_calls: toolCalls.length > 0 ? toolCalls : undefined };
}

// Mock LLM for testing without API keys
let mockStep = 0;
function callMockLLM(messages) {
	const userMsg = messages.filter(m => m.role === 'user').pop()?.content || '';

	const scenarios = [
		{
			role: 'assistant', content: null,
			tool_calls: [{
				id: 'tc_1', type: 'function',
				function: { name: 'list_directory', arguments: JSON.stringify({ path: process.cwd(), recursive: false }) },
			}],
		},
		{
			role: 'assistant', content: null,
			tool_calls: [{
				id: 'tc_2', type: 'function',
				function: { name: 'write_file', arguments: JSON.stringify({ path: path.join(process.cwd(), 'standalone-demo', 'hello.txt'), content: 'Hello from CodeAgent!\nThis file was created by the agent.\n' }) },
			}],
		},
		{
			role: 'assistant', content: null,
			tool_calls: [{
				id: 'tc_3', type: 'function',
				function: { name: 'read_file', arguments: JSON.stringify({ path: path.join(process.cwd(), 'standalone-demo', 'hello.txt') }) },
			}],
		},
		{
			role: 'assistant',
			content: 'Task complete! I explored the directory, created a test file `hello.txt`, and verified its contents. The agent loop is working correctly with tool calls.',
		},
	];

	const resp = scenarios[mockStep % scenarios.length];
	mockStep++;
	return resp;
}

async function callLLM(messages, tools) {
	if (CONFIG.useMock) return callMockLLM(messages);
	if (CONFIG.provider === 'anthropic') return await callAnthropic(messages, tools);
	return await callOpenAI(messages, tools);
}

// ============================================================================
// System Prompt
// ============================================================================

const SYSTEM_PROMPT = `You are an autonomous coding agent. You can read files, write files, edit files, search code, list directories, and run terminal commands.

Rules:
1. Use tools to explore before making changes
2. Always read a file before editing it
3. Use list_directory to understand project structure
4. Be concise in explanations
5. After changes, verify with read_file or run_terminal

Current working directory: ${process.cwd()}`;

// ============================================================================
// Agent Loop
// ============================================================================

async function agentLoop(userMessage) {
	const messages = [
		{ role: 'system', content: SYSTEM_PROMPT },
		{ role: 'user', content: userMessage },
	];

	const toolSchemas = Object.entries(TOOLS).map(([name, t]) => ({
		name,
		description: t.description,
		parameters: t.parameters,
	}));

	log(C.blue, 'USER', userMessage);
	console.log('');

	let steps = 0;
	while (steps < CONFIG.maxSteps) {
		steps++;
		log(C.gray, `STEP ${steps}`, 'Calling LLM...');

		let response;
		try {
			response = await callLLM(messages, toolSchemas);
		} catch (err) {
			log(C.red, 'ERROR', `LLM call failed: ${err.message}`);
			break;
		}

		if (response.content) {
			log(C.green, 'AGENT', response.content);
		}

		if (!response.tool_calls || response.tool_calls.length === 0) {
			break;
		}

		messages.push(response);

		for (const tc of response.tool_calls) {
			const toolName = tc.function.name;
			const toolArgs = JSON.parse(tc.function.arguments);
			const tool = TOOLS[toolName];

			log(C.cyan, 'TOOL', `${toolName}(${JSON.stringify(toolArgs).substring(0, 120)}...)`);

			if (!tool) {
				const errResult = { role: 'tool', tool_call_id: tc.id, content: `Unknown tool: ${toolName}` };
				messages.push(errResult);
				log(C.red, 'RESULT', `Unknown tool: ${toolName}`);
				continue;
			}

			const result = tool.execute(toolArgs);

			if (result.success) {
				const truncated = result.output.length > 500
					? result.output.substring(0, 500) + `\n... (${result.output.length} chars total)`
					: result.output;
				log(C.yellow, 'RESULT', truncated);
			} else {
				log(C.red, 'RESULT', `Error: ${result.error}`);
			}

			messages.push({
				role: 'tool',
				tool_call_id: tc.id,
				content: result.success ? result.output : `Error: ${result.error}`,
			});
		}
		console.log('');
	}

	if (steps >= CONFIG.maxSteps) {
		log(C.red, 'LIMIT', `Reached max steps (${CONFIG.maxSteps})`);
	}

	console.log(`\n${C.dim}--- Completed in ${steps} step(s) ---${C.reset}\n`);
}

// ============================================================================
// Interactive REPL
// ============================================================================

async function main() {
	console.log(`\n${C.bold}${C.green}========================================${C.reset}`);
	console.log(`${C.bold}  CodeAgent - VS Code Agent Mode Demo${C.reset}`);
	console.log(`${C.bold}${C.green}========================================${C.reset}`);
	console.log(`${C.dim}Provider: ${CONFIG.useMock ? 'mock (demo)' : CONFIG.provider}${C.reset}`);
	console.log(`${C.dim}Model:    ${CONFIG.useMock ? 'mock' : CONFIG.model}${C.reset}`);
	console.log(`${C.dim}CWD:      ${process.cwd()}${C.reset}`);

	if (!CONFIG.useMock && !CONFIG.apiKey) {
		console.log(`\n${C.yellow}No API key found. Set OPENAI_API_KEY or run with MOCK_LLM=1 for demo mode.${C.reset}`);
		console.log(`${C.dim}  MOCK_LLM=1 node agent.mjs${C.reset}`);
		console.log(`${C.dim}  OPENAI_API_KEY=sk-xxx node agent.mjs${C.reset}\n`);
	}

	console.log(`${C.dim}Type a task and press Enter. Type "exit" to quit.${C.reset}\n`);

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	const prompt = () => {
		rl.question(`${C.bold}${C.blue}> ${C.reset}`, async (input) => {
			const trimmed = input.trim();
			if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
				console.log(`${C.dim}Goodbye!${C.reset}`);
				rl.close();
				return;
			}

			try {
				await agentLoop(trimmed);
			} catch (err) {
				log(C.red, 'ERROR', err.message);
			}

			prompt();
		});
	};

	// If a message was passed as CLI argument, run it once
	const cliMessage = process.argv.slice(2).join(' ').trim();
	if (cliMessage) {
		await agentLoop(cliMessage);
		rl.close();
		return;
	}

	prompt();
}

main().catch(err => {
	console.error(`Fatal: ${err.message}`);
	process.exit(1);
});
