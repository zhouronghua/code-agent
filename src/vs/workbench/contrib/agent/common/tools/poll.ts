/*---------------------------------------------------------------------------------------------
 *  poll tool - Poll a command with exponential backoff until a condition is met.
 *
 *  Essential for waiting on async external tasks:
 *    - CI pipeline completion
 *    - Container/VM readiness
 *    - Background job status
 *    - File system events (file appears, content matches)
 *
 *  Uses exponential backoff: delay doubles each attempt (1s → 2s → 4s → ... → max_delay)
 *  This prevents hammering the service while providing responsive detection.
 *--------------------------------------------------------------------------------------------*/

import { ITerminalService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from '../agentTools';

export class PollTool extends AgentTool {
	readonly name = 'poll';
	readonly description =
		`Poll a shell command at intervals with exponential backoff until a success condition is met. ` +
		`Use for waiting on async external tasks: CI pipelines, containers, background jobs, file readiness. ` +
		`The check command should exit 0 for success, or match success_pattern for text-based success. ` +
		`Delay grows exponentially (initial_delay → max_delay), never exceeding max_delay. ` +
		`Example: poll(command="curl -s http://svc/status", success_pattern="READY", max_attempts=10)`;
	readonly parameters = {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description:
					'Shell command to run for each poll attempt. ' +
					'Exit code 0 = success (unless success_pattern is set). ' +
					'Output is captured and checked against success_pattern if provided.',
			},
			success_pattern: {
				type: 'string',
				description:
					'Optional regex pattern. If set, the command is considered successful ' +
					'when its stdout matches this pattern (regardless of exit code). ' +
					'If not set, exit code 0 = success.',
			},
			max_attempts: {
				type: 'number',
				description: 'Maximum number of poll attempts before giving up. Default: 30.',
			},
			initial_delay: {
				type: 'number',
				description: 'Delay in seconds before the first retry. Default: 2.',
			},
			max_delay: {
				type: 'number',
				description: 'Maximum delay in seconds between attempts. Default: 60.',
			},
			cwd: {
				type: 'string',
				description: 'Working directory for the command. Defaults to workspace root.',
			},
			command_timeout: {
				type: 'number',
				description: 'Per-attempt command timeout in milliseconds. Default: 30000 (30s).',
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
		const successPattern = args.success_pattern as string | undefined;
		const maxAttempts = (args.max_attempts as number) || 30;
		const initialDelay = (args.initial_delay as number) || 2;
		const maxDelay = (args.max_delay as number) || 60;
		const cwd = (args.cwd as string) || this._defaultCwd;
		const commandTimeout = (args.command_timeout as number) || 30000;

		if (maxAttempts < 1) {
			return this.failure(toolCallId, 'max_attempts must be >= 1');
		}

		// Check if already aborted
		if (signal?.aborted) {
			return this.failure(toolCallId, 'Tool execution cancelled by user');
		}

		const allOutputs: string[] = [];

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			// Check for abort signal before each attempt
			if (signal?.aborted) {
				allOutputs.push('⏹️ Poll cancelled by user');
				return this.failure(toolCallId, allOutputs.join('\n\n'));
			}

			// Run the check command
			const output = await this._runCheck(command, cwd, commandTimeout);
			const exitCode = output.exitCode;

			allOutputs.push(
				`[Attempt ${attempt + 1}/${maxAttempts}] (exit=${exitCode})\n${output.stdout}`
			);

			// Check success condition
			if (successPattern) {
				try {
					const regex = new RegExp(successPattern);
					if (regex.test(output.stdout)) {
						allOutputs.push(`✅ Success: output matched pattern "${successPattern}"`);
						return this.success(toolCallId, allOutputs.join('\n\n'));
					}
				} catch (err) {
					return this.failure(toolCallId,
						`Invalid regex pattern "${successPattern}": ${(err as Error).message}`
					);
				}
			} else if (exitCode === 0) {
				allOutputs.push(`✅ Success: command exited with code 0`);
				return this.success(toolCallId, allOutputs.join('\n\n'));
			}

			// Not yet succeeded — calculate backoff delay
			if (attempt < maxAttempts - 1) {
				// Check abort before sleeping
				if (signal?.aborted) {
					allOutputs.push('⏹️ Poll cancelled by user');
					return this.failure(toolCallId, allOutputs.join('\n\n'));
				}

				// Exponential backoff: initialDelay * 2^attempt, capped at maxDelay
				const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
				const delayMs = delay * 1000;

				allOutputs.push(
					`⏳ Waiting ${delay}s before next poll (attempt ${attempt + 2}/${maxAttempts})...`
				);

				await this._sleep(delayMs, signal);
			}
		}

		// All attempts exhausted
		allOutputs.push(
			`❌ Failed: condition not met after ${maxAttempts} attempts ` +
			`(total wait ~${this._totalWaitTime(initialDelay, maxDelay, maxAttempts)}s)`
		);
		return this.failure(toolCallId, allOutputs.join('\n\n'));
	}

	private async _runCheck(
		command: string,
		cwd: string,
		timeout: number,
	): Promise<{ stdout: string; exitCode: number | null }> {
		return new Promise<{ stdout: string; exitCode: number | null }>((resolve) => {
			const chunks: string[] = [];
			let settled = false;
			let exitCode: number | null = null;

			const instance = this._terminalService.createTerminal({
				config: {
					name: 'Agent Poll Check',
					cwd,
					isFeatureTerminal: true,
				},
			});

			const cleanup = () => {
				clearTimeout(timer);
				dataDisposable.dispose();
				exitDisposable.dispose();
				instance.dispose();
			};

			const timer = setTimeout(() => {
				if (!settled) {
					settled = true;
					cleanup();
					resolve({
						stdout: chunks.join('').trim(),
						exitCode: exitCode ?? -1,
					});
				}
			}, timeout);

			const dataDisposable = instance.onData(data => {
				chunks.push(data);
			});

			const exitDisposable = instance.onExit(code => {
				if (!settled) {
					settled = true;
					exitCode = code?.code ?? null;
					cleanup();
					clearTimeout(timer);
					resolve({
						stdout: chunks.join('').trim(),
						exitCode: exitCode ?? null,
					});
				}
			});

			instance.sendText(command, true);
		});
	}

	private _sleep(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(resolve, ms);
			if (signal) {
				const onAbort = () => {
					clearTimeout(timer);
					reject(new DOMException('Aborted', 'AbortError'));
				};
				if (signal.aborted) {
					clearTimeout(timer);
					reject(new DOMException('Aborted', 'AbortError'));
					return;
				}
				signal.addEventListener('abort', onAbort, { once: true });
			}
		});
	}

	/**
	 * Calculate approximate total wait time for the failure message.
	 */
	private _totalWaitTime(initial: number, max: number, attempts: number): number {
		let total = 0;
		for (let i = 0; i < attempts - 1; i++) {
			total += Math.min(initial * Math.pow(2, i), max);
		}
		return total;
	}
}
