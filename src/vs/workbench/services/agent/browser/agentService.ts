/*---------------------------------------------------------------------------------------------
 *  AgentService Implementation - Assembles all agent components
 *  Registered as a singleton via registerSingleton()
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import { URI } from 'vs/base/common/uri';
import { InstantiationType, registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IFileService } from 'vs/platform/files/common/files';
import { ISearchService } from 'vs/workbench/services/search/common/search';
import { ITerminalService } from 'vs/workbench/contrib/terminal/browser/terminal';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import {
	AgentMode,
	IAgentConfig,
	IAgentMessage,
	IAgentPlan,
	IAgentSession,
	DEFAULT_AGENT_CONFIG,
	generateId,
} from '../common/agentModels';
import { IAgentService } from '../common/agentService';
import { LLMProviderFactory, ILLMProvider } from './llmProvider';
import { ToolRegistry } from 'vs/workbench/contrib/agent/common/agentTools';
import { AgentModeManager } from 'vs/workbench/contrib/agent/common/agentModes';
import { AgentCheckpointManager } from 'vs/workbench/contrib/agent/common/agentCheckpoint';
import { AgentLoop } from 'vs/workbench/contrib/agent/common/agent';

import { ReadFileTool } from 'vs/workbench/contrib/agent/common/tools/readFile';
import { WriteFileTool } from 'vs/workbench/contrib/agent/common/tools/writeFile';
import { EditFileTool } from 'vs/workbench/contrib/agent/common/tools/editFile';
import { ListDirectoryTool } from 'vs/workbench/contrib/agent/common/tools/listDir';
import { SearchTextTool } from 'vs/workbench/contrib/agent/common/tools/searchText';
import { SearchFilesTool } from 'vs/workbench/contrib/agent/common/tools/searchFiles';
import { RunTerminalTool } from 'vs/workbench/contrib/agent/common/tools/runTerminal';

// Ensure provider implementations are loaded
import './llmOpenai';
import './llmAnthropic';
import './llmOllama';

export class AgentService extends Disposable implements IAgentService {
	declare readonly _serviceBrand: undefined;

	private _config: IAgentConfig;
	private _session: IAgentSession | undefined;
	private _agentLoop: AgentLoop | undefined;
	private _llmProvider: ILLMProvider | undefined;

	private readonly _toolRegistry: ToolRegistry;
	private readonly _modeManager: AgentModeManager;
	private readonly _checkpointManager: AgentCheckpointManager;

	// --- Events ---
	private readonly _onDidReceiveMessage = this._register(new Emitter<IAgentMessage>());
	readonly onDidReceiveMessage: Event<IAgentMessage> = this._onDidReceiveMessage.event;

	private readonly _onDidChangeMode = this._register(new Emitter<AgentMode>());
	readonly onDidChangeMode: Event<AgentMode> = this._onDidChangeMode.event;

	private readonly _onDidUpdatePlan = this._register(new Emitter<IAgentPlan>());
	readonly onDidUpdatePlan: Event<IAgentPlan> = this._onDidUpdatePlan.event;

	private readonly _onDidStartTask = this._register(new Emitter<string>());
	readonly onDidStartTask: Event<string> = this._onDidStartTask.event;

	private readonly _onDidComplete = this._register(new Emitter<void>());
	readonly onDidComplete: Event<void> = this._onDidComplete.event;

	private readonly _onDidError = this._register(new Emitter<Error>());
	readonly onDidError: Event<Error> = this._onDidError.event;

	private readonly _onDidStreamToken = this._register(new Emitter<string>());
	readonly onDidStreamToken: Event<string> = this._onDidStreamToken.event;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@ISearchService private readonly _searchService: ISearchService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IWorkspaceContextService private readonly _workspaceService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();

		this._config = this._loadConfig();
		this._toolRegistry = new ToolRegistry();
		this._modeManager = new AgentModeManager();
		this._checkpointManager = new AgentCheckpointManager(this._fileService);

		this._registerTools();
		this._setupModeForwarding();
	}

	// --- Session ---

	createSession(mode: AgentMode = AgentMode.Agent): IAgentSession {
		this._modeManager.switchMode(mode);
		this._ensureLLMProvider();

		this._session = {
			id: generateId(),
			name: `Session ${new Date().toLocaleString()}`,
			mode,
			messages: [],
			createdAt: Date.now(),
			updatedAt: Date.now(),
			messageCount: 0,
		};

		this._agentLoop = new AgentLoop(
			this._config,
			this._llmProvider!,
			this._toolRegistry,
			this._modeManager,
			this._checkpointManager,
			this._getWorkspaceRoot().fsPath,
		);

		this._register(this._agentLoop.onDidReceiveMessage(msg => {
			(this._session!.messages as IAgentMessage[]).push(msg);
			this._onDidReceiveMessage.fire(msg);
		}));

		this._register(this._agentLoop.onDidComplete(() => {
			this._onDidComplete.fire();
		}));

		this._register(this._agentLoop.onDidError(err => {
			this._onDidError.fire(err);
		}));

		this._register(this._agentLoop.onDidStreamToken(token => {
			this._onDidStreamToken.fire(token);
		}));

		return this._session;
	}

	getSession(): IAgentSession | undefined {
		return this._session;
	}

	getMessages(): readonly IAgentMessage[] {
		return this._session?.messages || [];
	}

	// --- Core ---

	async sendMessage(content: string): Promise<void> {
		if (!this._session) {
			this.createSession();
		}

		this._onDidStartTask.fire(content);
		await this._agentLoop!.run(content);
	}

	cancelCurrentTask(): void {
		this._agentLoop?.cancel();
	}

	// --- Mode ---

	getMode(): AgentMode {
		return this._modeManager.currentMode;
	}

	switchMode(mode: AgentMode): void {
		this._modeManager.switchMode(mode);

		if (this._session) {
			(this._session as any).mode = mode;
		}
	}

	// --- Checkpoint ---

	createCheckpoint(): string {
		return this._checkpointManager.createCheckpoint('Manual checkpoint');
	}

	async restoreCheckpoint(checkpointId: string): Promise<void> {
		await this._checkpointManager.restore(checkpointId);
	}

	listCheckpoints(): string[] {
		return this._checkpointManager.listCheckpoints().map(cp => cp.id);
	}

	// --- Config ---

	getConfig(): IAgentConfig {
		return { ...this._config };
	}

	updateConfig(config: Partial<IAgentConfig>): void {
		this._config = { ...this._config, ...config };
		this._llmProvider = undefined;
	}

	// --- Private ---

	private _loadConfig(): IAgentConfig {
		const configSection = this._configurationService.getValue<Record<string, unknown>>('agent') || {};
		return {
			...DEFAULT_AGENT_CONFIG,
			provider: (configSection.provider as IAgentConfig['provider']) || DEFAULT_AGENT_CONFIG.provider,
			model: (configSection.model as string) || DEFAULT_AGENT_CONFIG.model,
			apiKey: (configSection.apiKey as string) || DEFAULT_AGENT_CONFIG.apiKey,
			apiBase: (configSection.apiBase as string) || DEFAULT_AGENT_CONFIG.apiBase,
			maxSteps: (configSection.maxSteps as number) || DEFAULT_AGENT_CONFIG.maxSteps,
			temperature: (configSection.temperature as number) ?? DEFAULT_AGENT_CONFIG.temperature,
		};
	}

	private _ensureLLMProvider(): void {
		if (!this._llmProvider) {
			this._llmProvider = LLMProviderFactory.create(this._config);
		}
	}

	private _getWorkspaceRoot(): URI {
		const folders = this._workspaceService.getWorkspace().folders;
		return folders.length > 0 ? folders[0].uri : URI.file('/');
	}

	private _registerTools(): void {
		const workspaceRoot = this._getWorkspaceRoot();

		this._toolRegistry.register(new ReadFileTool(this._fileService));
		this._toolRegistry.register(new WriteFileTool(this._fileService));
		this._toolRegistry.register(new EditFileTool(this._fileService));
		this._toolRegistry.register(new ListDirectoryTool(this._fileService));
		this._toolRegistry.register(new SearchTextTool(this._searchService, workspaceRoot));
		this._toolRegistry.register(new SearchFilesTool(this._searchService, workspaceRoot));
		this._toolRegistry.register(new RunTerminalTool(this._terminalService, workspaceRoot.fsPath));
	}

	private _setupModeForwarding(): void {
		this._register(this._modeManager.onDidChangeMode(mode => {
			this._onDidChangeMode.fire(mode);
		}));
	}
}

registerSingleton(IAgentService, AgentService, InstantiationType.Delayed);
