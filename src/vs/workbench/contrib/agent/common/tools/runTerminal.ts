/*---------------------------------------------------------------------------------------------
 *  run_terminal tool - Execute shell commands in the integrated terminal
 *  Injects: ITerminalService
 *--------------------------------------------------------------------------------------------*/

import { ITerminalService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from '../agentTools';

export class RunTerminalTool extends AgentTool {
	readonly name = 'run_terminal';
	readonly description = 'Execute a shell command in the integrated terminal and return its output. Use for running builds, tests, git commands, etc.';
	readonly parameters = {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: 'The shell command to execute',
			},
			cwd: {
				type: 'string',
				description: 'Working directory for the command. Defaults to workspace root.',
			},
			timeout: {
				type: 'number',
				description: 'Timeout in milliseconds. Default: 30000 (30s).',
			},
		},
		required: ['command'],
	};

	constructor(
		private readonly _terminalService: ITerminalService,
		private readonly _defaultCwd: string,
	) {
		super();
	}

	async execute(args: Record<string, unknown>): Promise<IToolResult> {
		const toolCallId = args._toolCallId as string || '';
		const command = args.command as string;
		const cwd = (args.cwd as string) || this._defaultCwd;
		const timeout = (args.timeout as number) || 30000;

		// Defence-in-depth: detect obviously dangerous commands before execution.
		// The system prompt instructs the LLM to avoid these, but this acts as a
		// safety net in case the LLM hallucinates or is jailbroken.
		const dangerousPatterns = [
			/\brm\s+-rf\s+\//,           // rm -rf /
			/\brm\s+-rf\s+\*\b/,          // rm -rf *
			/\brm\s+-rf\s+~/,             // rm -rf ~
			/\bdd\s+if=/,                 // dd destructive
			/\bmkfs\./,                   // format filesystem
			/\b>\/dev\/sd[a-z]\b/,       // overwrite block device
			/\bchmod\s+(-R\s+)?777\s+\//, // chmod 777 /
			/\b:\(\)\s*\{/,               // fork bomb
			/\bDROP\s+(TABLE|DATABASE)\b/i, // SQL destructive
		];
		for (const pattern of dangerousPatterns) {
			if (pattern.test(command)) {
				return this.failure(toolCallId,
					`Command blocked by safety filter: potentially destructive operation detected. ` +
					`If this is intentional, please run it manually in your terminal.`
				);
			}
		}

		try {
			const output = await this._executeCommand(command, cwd, timeout);
			return this.success(toolCallId, output);
		} catch (err) {
			return this.failure(toolCallId, `Command failed: ${(err as Error).message}`);
		}
	}

	private async _executeCommand(command: string, cwd: string, timeout: number): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const chunks: string[] = [];
			let settled = false;

			const instance = this._terminalService.createTerminal({
				config: {
					name: 'Agent Command',
					cwd,
					isFeatureTerminal: true,
				},
			});

			const cleanup = () => {
				clearTimeout(timer);
				dataDisposable.dispose();
				exitDisposable.dispose();
				// Kill the underlying process to prevent zombie processes
				instance.dispose();
			};

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					cleanup();
					const output = chunks.join('').trim();
					resolve(output + '\n[Command timed out after ' + timeout + 'ms]');
				}
			}, timeout);

			const dataDisposable = instance.onData(data => {
				chunks.push(data);
			});

			const exitDisposable = instance.onExit(exitCode => {
				if (!settled) {
					settled = true;
					cleanup();
					const output = chunks.join('').trim();
					const exitInfo = `\n[Exit code: ${exitCode?.code ?? 'unknown'}]`;
					resolve(output + exitInfo);
				}
			});

			instance.sendText(command, true);
		});
	}
}
