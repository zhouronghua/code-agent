/*---------------------------------------------------------------------------------------------
 *  Agent Checkpoint - File snapshot and rollback system
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { VSBuffer } from 'vs/base/common/buffer';
import { IFileService } from 'vs/platform/files/common/files';

export interface ICheckpoint {
	readonly id: string;
	readonly timestamp: number;
	readonly description: string;
	readonly snapshots: Map<string, string>;
}

export class AgentCheckpointManager {
	private readonly _checkpoints = new Map<string, ICheckpoint>();
	private _counter = 0;

	constructor(private readonly _fileService: IFileService) { }

	/**
	 * Create an independent checkpoint manager sharing the same file service.
	 * Used by parallel agents to avoid race conditions on shared checkpoint state.
	 */
	clone(): AgentCheckpointManager {
		return new AgentCheckpointManager(this._fileService);
	}

	async captureFile(filePath: string): Promise<string | undefined> {
		try {
			const uri = URI.file(filePath);
			const content = await this._fileService.readFile(uri);
			return content.value.toString();
		} catch {
			return undefined;
		}
	}

	createCheckpoint(description: string): string {
		const id = `ckpt_${Date.now()}_${this._counter++}`;
		this._checkpoints.set(id, {
			id,
			timestamp: Date.now(),
			description,
			snapshots: new Map(),
		});
		return id;
	}

	async snapshotFile(checkpointId: string, filePath: string): Promise<void> {
		const checkpoint = this._checkpoints.get(checkpointId);
		if (!checkpoint) {
			throw new Error(`Checkpoint not found: ${checkpointId}`);
		}

		const content = await this.captureFile(filePath);
		if (content !== undefined) {
			checkpoint.snapshots.set(filePath, content);
		}
	}

	async restore(checkpointId: string): Promise<string[]> {
		const checkpoint = this._checkpoints.get(checkpointId);
		if (!checkpoint) {
			throw new Error(`Checkpoint not found: ${checkpointId}`);
		}

		const restoredFiles: string[] = [];

		for (const [filePath, content] of checkpoint.snapshots) {
			try {
				const uri = URI.file(filePath);
				await this._fileService.writeFile(uri, VSBuffer.fromString(content));
				restoredFiles.push(filePath);
			} catch {
				// skip files that can't be restored
			}
		}

		return restoredFiles;
	}

	listCheckpoints(): Array<{ id: string; timestamp: number; description: string; fileCount: number }> {
		return [...this._checkpoints.values()].map(cp => ({
			id: cp.id,
			timestamp: cp.timestamp,
			description: cp.description,
			fileCount: cp.snapshots.size,
		}));
	}

	deleteCheckpoint(checkpointId: string): boolean {
		return this._checkpoints.delete(checkpointId);
	}

	clear(): void {
		this._checkpoints.clear();
	}
}
