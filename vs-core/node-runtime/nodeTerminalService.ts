/*---------------------------------------------------------------------------------------------
 *  Node.js implementation of ITerminalService (uses child_process)
 *--------------------------------------------------------------------------------------------*/

import { spawn, ChildProcess } from 'node:child_process';
import { Emitter } from '../base/common/event';
import { ITerminalService, ITerminalInstance, ICreateTerminalOptions } from '../workbench/contrib/terminal/browser/terminal';

export class NodeTerminalService implements ITerminalService {
	readonly _serviceBrand: undefined;

	private readonly _defaultCwd: string;

	constructor(cwd: string) {
		this._defaultCwd = cwd;
	}

	createTerminal(options?: ICreateTerminalOptions): ITerminalInstance {
		const cwd = options?.config?.cwd || this._defaultCwd;

		const onDataEmitter = new Emitter<string>();
		const onExitEmitter = new Emitter<{ code?: number } | undefined>();

		let proc: ChildProcess | null = null;

		return {
			onData: onDataEmitter.event,
			onExit: onExitEmitter.event,
			sendText(text: string, addNewLine?: boolean) {
				const cmd = addNewLine !== false ? text : text;
				proc = spawn('sh', ['-c', cmd], {
					cwd,
					stdio: ['pipe', 'pipe', 'pipe'],
				});

				proc.stdout?.on('data', (data: Buffer) => {
					onDataEmitter.fire(data.toString());
				});

				proc.stderr?.on('data', (data: Buffer) => {
					onDataEmitter.fire(data.toString());
				});

				proc.on('exit', (code) => {
					onExitEmitter.fire({ code: code ?? undefined });
				});

				proc.on('error', (err) => {
					onDataEmitter.fire(`Error: ${err.message}\n`);
					onExitEmitter.fire({ code: 1 });
				});
			},
			dispose() {
				proc?.kill();
				onDataEmitter.dispose();
				onExitEmitter.dispose();
			},
		};
	}
}
