/*---------------------------------------------------------------------------------------------
 *  Agent Task Log Manager - Per-task execution traces for troubleshooting
 *
 *  Features:
 *  - Auto-save after each task execution (LLM calls, tool invocations, results)
 *  - List task logs with metadata (task summary, duration, status, timestamps)
 *  - View full task execution trace (step-by-step LLM interactions + tool results)
 *  - Storage: ~/.codeagent/tasks/ as JSON files
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { IAgentTaskLog } from 'vs/workbench/services/agent/common/agentModels';

const TASKS_DIR = path.join(os.homedir(), '.codeagent', 'tasks');
const TASK_INDEX_FILE = '_index.json';

interface TaskIndexEntry {
	id: string;
	task: string;
	mode: string;
	status: string;
	totalSteps: number;
	totalToolCalls: number;
	durationMs: number;
	startedAt: number;
	finishedAt: number;
	summary: string;
}

interface TaskIndex {
	[id: string]: TaskIndexEntry;
}

export class TaskLogManager {
	private _index: TaskIndex = {};
	private _indexLoaded = false;

	constructor() { }

	private _ensureDir(): void {
		if (!fs.existsSync(TASKS_DIR)) {
			fs.mkdirSync(TASKS_DIR, { recursive: true });
		}
	}

	private _loadIndex(): void {
		if (this._indexLoaded) return;
		this._ensureDir();
		const indexPath = path.join(TASKS_DIR, TASK_INDEX_FILE);
		if (fs.existsSync(indexPath)) {
			try {
				this._index = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
			} catch {
				this._index = {};
			}
		}
		this._indexLoaded = true;
	}

	private _saveIndex(): void {
		this._ensureDir();
		const indexPath = path.join(TASKS_DIR, TASK_INDEX_FILE);
		fs.writeFileSync(indexPath, JSON.stringify(this._index, null, 2), 'utf-8');
	}

	/**
	 * Save a task execution log to disk.
	 */
	saveTaskLog(log: IAgentTaskLog): void {
		this._loadIndex();
		this._ensureDir();

		const logPath = path.join(TASKS_DIR, `${log.id}.json`);
		fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8');

		// Update index
		this._index[log.id] = {
			id: log.id,
			task: log.task.substring(0, 200),
			mode: log.mode,
			status: log.status,
			totalSteps: log.totalSteps,
			totalToolCalls: log.totalToolCalls,
			durationMs: log.durationMs,
			startedAt: log.startedAt,
			finishedAt: log.finishedAt,
			summary: this._buildSummary(log),
		};
		this._saveIndex();
	}

	/**
	 * Load a task log by ID.
	 */
	loadTaskLog(id: string): IAgentTaskLog | undefined {
		this._loadIndex();
		const logPath = path.join(TASKS_DIR, `${id}.json`);
		if (!fs.existsSync(logPath)) {
			return undefined;
		}
		try {
			return JSON.parse(fs.readFileSync(logPath, 'utf-8')) as IAgentTaskLog;
		} catch {
			return undefined;
		}
	}

	/**
	 * List all task logs (sorted by startedAt descending — newest first).
	 */
	listTaskLogs(): TaskIndexEntry[] {
		this._loadIndex();
		const entries = Object.values(this._index);
		entries.sort((a, b) => b.startedAt - a.startedAt);
		return entries;
	}

	/**
	 * Delete a task log by ID.
	 */
	deleteTaskLog(id: string): boolean {
		this._loadIndex();
		const logPath = path.join(TASKS_DIR, `${id}.json`);
		let deleted = false;
		if (fs.existsSync(logPath)) {
			fs.unlinkSync(logPath);
			deleted = true;
		}
		delete this._index[id];
		this._saveIndex();
		return deleted;
	}

	/**
	 * Generate a unique task log ID.
	 */
	generateId(): string {
		const ts = Date.now();
		const rand = Math.random().toString(36).substring(2, 8);
		return `task_${ts}_${rand}`;
	}

	/**
	 * Get the most recent task log.
	 */
	getLatestTaskLog(): IAgentTaskLog | undefined {
		this._loadIndex();
		const entries = this.listTaskLogs();
		if (entries.length === 0) return undefined;
		return this.loadTaskLog(entries[0].id);
	}

	/**
	 * Get total task log count.
	 */
	get count(): number {
		this._loadIndex();
		return Object.keys(this._index).length;
	}

	/**
	 * Build a human-readable summary from the task log.
	 */
	private _buildSummary(log: IAgentTaskLog): string {
		const parts: string[] = [];

		// Task description
		parts.push(log.task.substring(0, 120));

		// First assistant message content (the agent's initial response)
		for (const step of log.steps) {
			const content = step.llmResponse.content;
			if (content && content.length > 0) {
				parts.push(content.substring(0, 150));
				break;
			}
		}

		return parts.join(' | ').substring(0, 300);
	}

	/**
	 * Format a task log for human-readable console output.
	 */
	formatTaskLog(log: IAgentTaskLog): string {
		const lines: string[] = [];
		const statusIcon = log.status === 'completed' ? '✓' : log.status === 'failed' ? '✗' : '⊘';

		lines.push(`Task: ${log.task}`);
		lines.push(`Status: ${statusIcon} ${log.status}`);
		lines.push(`Mode: ${log.mode} | Model: ${log.config.provider}/${log.config.model}`);
		lines.push(`Steps: ${log.totalSteps} | Tool calls: ${log.totalToolCalls}`);
		if (log.tokenUsage) {
			const u = log.tokenUsage;
			const cached = u.cachedTokens ? ` | cache read: ${u.cachedTokens}${u.cacheCreationTokens ? ` + write: ${u.cacheCreationTokens}` : ''}` : '';
			lines.push(`Tokens: ${u.promptTokens} in / ${u.completionTokens} out / ${u.totalTokens} total${cached}`);
		}
		lines.push(`Duration: ${(log.durationMs / 1000).toFixed(1)}s`);
		lines.push(`Started: ${new Date(log.startedAt).toLocaleString()}`);
		lines.push(`Finished: ${new Date(log.finishedAt).toLocaleString()}`);
		if (log.error) {
			lines.push(`Error: ${log.error}`);
		}
		lines.push('');

		// Step details
		for (const step of log.steps) {
			lines.push(`── Step ${step.stepIndex + 1} (${step.durationMs}ms) ──`);

			if (step.llmResponse.reasoningContent) {
				lines.push(`  [Reasoning] ${step.llmResponse.reasoningContent.substring(0, 200)}`);
			}

			if (step.llmResponse.content) {
				const content = step.llmResponse.content.substring(0, 300);
				lines.push(`  [Response] ${content}`);
			}

			if (step.llmResponse.toolCalls && step.llmResponse.toolCalls.length > 0) {
				for (const tc of step.llmResponse.toolCalls) {
					const argsStr = JSON.stringify(tc.arguments).substring(0, 100);
					lines.push(`  [Tool Call] ${tc.name}(${argsStr})`);
				}
			}

			for (const exec of step.toolExecutions) {
				const icon = exec.success ? '✓' : '✗';
				const output = exec.result.length > 200
					? exec.result.substring(0, 200) + `... (${exec.result.length} chars)`
					: exec.result;
				lines.push(`  ${icon} ${exec.toolName} (${exec.durationMs}ms): ${output}`);
				if (exec.error) {
					lines.push(`    Error: ${exec.error}`);
				}
			}

			lines.push('');
		}

		return lines.join('\n');
	}
}
