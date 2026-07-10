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

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = args._toolCallId as string || '';
		const command = args.command as string;
		const cwd = (args.cwd as string) || this._defaultCwd;
		const timeout = (args.timeout as number) || 30000;

		// Check if already aborted
		if (signal?.aborted) {
			return this.failure(toolCallId, 'Tool execution cancelled by user');
		}

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
			const output = await this._executeCommand(command, cwd, timeout, signal);
			return this.success(toolCallId, output);
		} catch (err) {
			if (signal?.aborted) {
				return this.failure(toolCallId, 'Tool execution cancelled by user');
			}
			return this.failure(toolCallId, `Command failed: ${(err as Error).message}`);
		}
	}

	private async _executeCommand(command: string, cwd: string, timeout: number, signal?: AbortSignal): Promise<string> {
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
				abortDisposable?.();
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

			// Listen for abort signal to kill the process
			let abortDisposable: (() => void) | undefined;
			if (signal) {
				const onAbort = () => {
					if (!settled) {
						settled = true;
						cleanup();
						reject(new DOMException('Aborted', 'AbortError'));
					}
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener('abort', onAbort, { once: true });
				abortDisposable = () => signal.removeEventListener('abort', onAbort);
			}

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
