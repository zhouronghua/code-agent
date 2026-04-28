/*---------------------------------------------------------------------------------------------
 *  Parallel Agent Manager - Run multiple agent instances concurrently
 *  Each agent operates in its own context, enabling parallel task execution.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { IAgentConfig, IAgentMessage, AgentMode, generateId } from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider } from 'vs/workbench/services/agent/browser/llmProvider';
import { ToolRegistry } from './agentTools';
import { AgentModeManager } from './agentModes';
import { AgentCheckpointManager } from './agentCheckpoint';
import { AgentLoop } from './agent';

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

		const modeManager = new AgentModeManager();
		const agentLoop = new AgentLoop(
			this._config,
			this._llmProvider,
			this._toolRegistry,
			modeManager,
			this._checkpointManager,
			this._workingDirectory,
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

			const result: IParallelResult = {
				taskId: task.id,
				success: true,
				messages,
				durationMs: Date.now() - startTime,
			};

			this._results.set(task.id, result);
			this._onDidTaskComplete.fire(result);
			return result;
		} catch (err) {
			(task as any).status = 'failed';
			(task as any).endTime = Date.now();
			(task as any).error = (err as Error).message;

			const result: IParallelResult = {
				taskId: task.id,
				success: false,
				messages,
				error: (err as Error).message,
				durationMs: Date.now() - startTime,
			};

			this._results.set(task.id, result);
			this._onDidTaskComplete.fire(result);
			return result;
		} finally {
			agentLoop.dispose();
			modeManager.dispose();
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
