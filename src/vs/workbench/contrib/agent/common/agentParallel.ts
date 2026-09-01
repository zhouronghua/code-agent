/*---------------------------------------------------------------------------------------------
 *  Parallel Agent Manager - Run multiple agent instances concurrently
 *  Each agent operates in its own context, enabling parallel task execution.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { IAgentConfig, IAgentMessage, AgentMode, IAgentTaskLog, generateId } from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider, LLMProviderFactory } from 'vs/workbench/services/agent/browser/llmProvider';
import { ToolRegistry } from './agentTools';
import { AgentModeManager } from './agentModes';
import { AgentCheckpointManager } from './agentCheckpoint';
import { AgentLoop } from './agent';
import { ModelRouter } from './agentModelRouter';
import { IMemoryIntegration } from './agentMemory';

export interface IParallelTask {
	readonly id: string;
	readonly description: string;
	readonly status: 'pending' | 'running' | 'done' | 'failed';
	readonly startTime: number;
	endTime?: number;
	error?: string;
}

export interface IParallelResult {
	readonly taskId: string;
	readonly success: boolean;
	readonly messages: readonly IAgentMessage[];
	readonly error?: string;
	readonly durationMs: number;
	readonly taskLog?: IAgentTaskLog;
}

export class ParallelAgentManager extends Disposable {
	private readonly _tasks = new Map<string, IParallelTask>();
	private readonly _results = new Map<string, IParallelResult>();
	private _maxConcurrent: number;

	private readonly _onDidTaskStart = this._register(new Emitter<IParallelTask>());
	readonly onDidTaskStart: Event<IParallelTask> = this._onDidTaskStart.event;

	private readonly _onDidTaskComplete = this._register(new Emitter<IParallelResult>());
	readonly onDidTaskComplete: Event<IParallelResult> = this._onDidTaskComplete.event;

	private readonly _onDidAllComplete = this._register(new Emitter<IParallelResult[]>());
	readonly onDidAllComplete: Event<IParallelResult[]> = this._onDidAllComplete.event;

	constructor(
		private readonly _config: IAgentConfig,
		private readonly _llmProvider: ILLMProvider,
		private readonly _toolRegistry: ToolRegistry,
		private readonly _workingDirectory: string,
		private readonly _checkpointManager: AgentCheckpointManager,
		maxConcurrent = 4,
		private readonly _modelRouter?: ModelRouter,
		private readonly _memory?: IMemoryIntegration,
	) {
		super();
		this._maxConcurrent = maxConcurrent;
	}

	async runParallel(tasks: string[]): Promise<IParallelResult[]> {
		const taskEntries: IParallelTask[] = tasks.map(desc => ({
			id: generateId(),
			description: desc,
			status: 'pending' as const,
			startTime: Date.now(),
		}));

		for (const task of taskEntries) {
			this._tasks.set(task.id, task);
		}

		const results: IParallelResult[] = [];
		const batches = this._chunk(taskEntries, this._maxConcurrent);

		for (const batch of batches) {
			const batchPromises = batch.map(task => this._runSingleAgent(task));
			const batchResults = await Promise.allSettled(batchPromises);

			for (let i = 0; i < batchResults.length; i++) {
				const settled = batchResults[i];
				const task = batch[i];

				if (settled.status === 'fulfilled') {
					results.push(settled.value);
				} else {
					const failResult: IParallelResult = {
						taskId: task.id,
						success: false,
						messages: [],
						error: settled.reason?.message || 'Unknown error',
						durationMs: Date.now() - task.startTime,
						taskLog: undefined,
					};
					results.push(failResult);
					this._onDidTaskComplete.fire(failResult);
				}
			}
		}

		this._onDidAllComplete.fire(results);
		return results;
	}

	private async _runSingleAgent(task: IParallelTask): Promise<IParallelResult> {
		(task as any).status = 'running';
		this._onDidTaskStart.fire(task);

		const { config, llmProvider } = this._resolveModelForTask(task.description);

		const modeManager = new AgentModeManager();
		// Each parallel agent gets its own isolated checkpoint manager to avoid
		// race conditions when multiple agents snapshot files concurrently.
		const checkpointManager = this._checkpointManager.clone();
		const agentLoop = new AgentLoop(
			config,
			llmProvider,
			this._toolRegistry,
			modeManager,
			checkpointManager,
			this._workingDirectory,
			this._memory,
		);

		const messages: IAgentMessage[] = [];

		agentLoop.onDidReceiveMessage(msg => {
			messages.push(msg);
		});

		const startTime = Date.now();

		try {
			await agentLoop.run(task.description);

			(task as any).status = 'done';
			(task as any).endTime = Date.now();

			const status = agentLoop.lastTaskError ? 'failed' : 'completed';
			const taskLog = agentLoop.exportTaskLog(status, agentLoop.lastTaskError);

			const result: IParallelResult = {
				taskId: task.id,
				success: true,
				messages,
				durationMs: Date.now() - startTime,
				taskLog,
			};

			this._results.set(task.id, result);
			this._onDidTaskComplete.fire(result);
			return result;
		} catch (err) {
			(task as any).status = 'failed';
			(task as any).endTime = Date.now();
			(task as any).error = (err as Error).message;

			const taskLog = agentLoop.exportTaskLog('failed', (err as Error).message);

			const result: IParallelResult = {
				taskId: task.id,
				success: false,
				messages,
				error: (err as Error).message,
				durationMs: Date.now() - startTime,
				taskLog,
			};

			this._results.set(task.id, result);
			this._onDidTaskComplete.fire(result);
			return result;
		} finally {
			agentLoop.dispose();
			modeManager.dispose();
		}
	}

	/**
	 * Resolve the model config + provider for a single parallel task.
	 * When a model router is present and enabled, each task is routed to its
	 * scenario model (vision/reasoning/fast) and gets its own provider instance.
	 */
	private _resolveModelForTask(description: string): { config: IAgentConfig; llmProvider: ILLMProvider } {
		if (!this._modelRouter?.enabled) {
			return { config: this._config, llmProvider: this._llmProvider };
		}

		const config = this._modelRouter.selectConfig(description);
		if (config.model === this._config.model) {
			return { config: this._config, llmProvider: this._llmProvider };
		}

		try {
			const provider = LLMProviderFactory.create(config);
			console.log(`[ROUTE] ${this._modelRouter.detectScenario(description)} → ${config.provider}/${config.model} (${description.substring(0, 40)})`);
			return { config, llmProvider: provider };
		} catch {
			return { config: this._config, llmProvider: this._llmProvider };
		}
	}

	getTask(taskId: string): IParallelTask | undefined {
		return this._tasks.get(taskId);
	}

	getResult(taskId: string): IParallelResult | undefined {
		return this._results.get(taskId);
	}

	getAllResults(): IParallelResult[] {
		return [...this._results.values()];
	}

	private _chunk<T>(arr: T[], size: number): T[][] {
		const chunks: T[][] = [];
		for (let i = 0; i < arr.length; i += size) {
			chunks.push(arr.slice(i, i + size));
		}
		return chunks;
	}
}
