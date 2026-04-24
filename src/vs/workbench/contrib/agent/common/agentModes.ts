/*---------------------------------------------------------------------------------------------
 *  Agent Mode Manager - Agent/Ask/Plan mode switching
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { AgentMode } from 'vs/workbench/services/agent/common/agentModels';

export class AgentModeManager {
	private _currentMode: AgentMode = AgentMode.Agent;

	private readonly _onDidChangeMode = new Emitter<AgentMode>();
	readonly onDidChangeMode: Event<AgentMode> = this._onDidChangeMode.event;

	get currentMode(): AgentMode {
		return this._currentMode;
	}

	switchMode(mode: AgentMode): void {
		if (this._currentMode === mode) {
			return;
		}
		this._currentMode = mode;
		this._onDidChangeMode.fire(mode);
	}

	get isReadOnly(): boolean {
		return this._currentMode === AgentMode.Ask;
	}

	get canExecuteTools(): boolean {
		return this._currentMode === AgentMode.Agent;
	}

	get shouldPlanFirst(): boolean {
		return this._currentMode === AgentMode.Plan;
	}

	dispose(): void {
		this._onDidChangeMode.dispose();
	}
}
