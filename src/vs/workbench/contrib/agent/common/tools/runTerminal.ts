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

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					resolve(chunks.join('') + '\n[Command timed out after ' + timeout + 'ms]');
				}
			}, timeout);

			const instance = this._terminalService.createTerminal({
				config: {
					name: 'Agent Command',
					cwd,
					isFeatureTerminal: true,
				},
			});

			const dataDisposable = instance.onData(data => {
				chunks.push(data);
			});

			const exitDisposable = instance.onExit(exitCode => {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					dataDisposable.dispose();
					exitDisposable.dispose();

					const output = chunks.join('').trim();
					const exitInfo = `\n[Exit code: ${exitCode?.code ?? 'unknown'}]`;
					resolve(output + exitInfo);
				}
			});

			instance.sendText(command, true);
		});
	}
}
