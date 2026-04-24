/*---------------------------------------------------------------------------------------------
 *  Minimal ITerminalService shim
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation';
import { IDisposable } from '../../../../base/common/lifecycle';
import { Event } from '../../../../base/common/event';

export const ITerminalService = createDecorator<ITerminalService>('terminalService');

export interface ITerminalInstance {
	onData: Event<string>;
	onExit: Event<{ code?: number } | undefined>;
	sendText(text: string, addNewLine?: boolean): void;
	dispose(): void;
}

export interface ICreateTerminalOptions {
	config?: {
		name?: string;
		cwd?: string;
		isFeatureTerminal?: boolean;
	};
}

export interface ITerminalService {
	readonly _serviceBrand: undefined;
	createTerminal(options?: ICreateTerminalOptions): ITerminalInstance;
}
