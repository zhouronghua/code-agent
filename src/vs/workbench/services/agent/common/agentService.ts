/*---------------------------------------------------------------------------------------------
 *  IAgentService - Agent service interface with DI support
 *  Integration point: register in workbench.common.main.ts
 *--------------------------------------------------------------------------------------------*/

import { Event } from 'vs/base/common/event';
import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import {
	AgentMode,
	IAgentConfig,
	IAgentMessage,
	IAgentPlan,
	IAgentSession,
} from './agentModels';

export const IAgentService = createDecorator<IAgentService>('agentService');

export interface IAgentService {
	readonly _serviceBrand: undefined;

	// --- Events ---
	readonly onDidReceiveMessage: Event<IAgentMessage>;
	readonly onDidChangeMode: Event<AgentMode>;
	readonly onDidUpdatePlan: Event<IAgentPlan>;
	readonly onDidStartTask: Event<string>;
	readonly onDidComplete: Event<void>;
	readonly onDidError: Event<Error>;
	readonly onDidStreamToken: Event<string>;

	// --- Session ---
	createSession(mode?: AgentMode): IAgentSession;
	getSession(): IAgentSession | undefined;
	getMessages(): readonly IAgentMessage[];

	// --- Core ---
	sendMessage(content: string): Promise<void>;
	cancelCurrentTask(): void;

	// --- Mode ---
	getMode(): AgentMode;
	switchMode(mode: AgentMode): void;

	// --- Checkpoint ---
	createCheckpoint(): string;
	restoreCheckpoint(checkpointId: string): Promise<void>;
	listCheckpoints(): string[];

	// --- Config ---
	getConfig(): IAgentConfig;
	updateConfig(config: Partial<IAgentConfig>): void;
}
