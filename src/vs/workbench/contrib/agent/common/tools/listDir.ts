/*---------------------------------------------------------------------------------------------
 *  list_directory tool - List directory contents recursively
 *  Injects: IFileService
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { IFileService, FileType } from 'vs/platform/files/common/files';
import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from '../agentTools';

export class ListDirectoryTool extends AgentTool {
	readonly name = 'list_directory';
	readonly description = 'List the contents of a directory. Shows files and subdirectories with type indicators.';
	readonly parameters = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute path to the directory to list',
			},
			recursive: {
				type: 'boolean',
				description: 'If true, list recursively up to max_depth. Default: false.',
			},
			max_depth: {
				type: 'number',
				description: 'Maximum recursion depth. Default: 3.',
			},
		},
		required: ['path'],
	};

	constructor(private readonly _fileService: IFileService) {
		super();
	}

	async execute(args: Record<string, unknown>): Promise<IToolResult> {
		const toolCallId = args._toolCallId as string || '';
		const path = args.path as string;
		const recursive = args.recursive as boolean || false;
		const maxDepth = (args.max_depth as number) || 3;

		try {
			const uri = URI.file(path);
			const lines: string[] = [];
			await this._listRecursive(uri, '', lines, recursive ? maxDepth : 1, 0);

			if (lines.length === 0) {
				return this.success(toolCallId, `Directory ${path} is empty`);
			}

			return this.success(toolCallId, `Directory: ${path}\n${lines.join('\n')}`);
		} catch (err) {
			return this.failure(toolCallId, `Failed to list directory ${path}: ${(err as Error).message}`);
		}
	}

	private async _listRecursive(
		uri: URI,
		prefix: string,
		lines: string[],
		maxDepth: number,
		currentDepth: number,
	): Promise<void> {
		if (currentDepth >= maxDepth) {
			return;
		}

		const entries = await this._fileService.resolve(uri, { resolveMetadata: false });
		if (!entries.children) {
			return;
		}

		const sorted = [...entries.children].sort((a, b) => {
			if (a.isDirectory && !b.isDirectory) { return -1; }
			if (!a.isDirectory && b.isDirectory) { return 1; }
			return a.name.localeCompare(b.name);
		});

		for (const entry of sorted) {
			const icon = entry.isDirectory ? '[dir]' : '[file]';
			lines.push(`${prefix}${icon} ${entry.name}`);
			if (entry.isDirectory) {
				await this._listRecursive(entry.resource, prefix + '  ', lines, maxDepth, currentDepth + 1);
			}
		}
	}
}
