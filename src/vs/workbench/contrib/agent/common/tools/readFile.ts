/*---------------------------------------------------------------------------------------------
 *  read_file tool - Read file contents with optional offset/limit
 *  Injects: IFileService
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { IFileService } from 'vs/platform/files/common/files';
import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from '../agentTools';

export class ReadFileTool extends AgentTool {
	readonly name = 'read_file';
	readonly description = 'Read the contents of a file. Returns numbered lines. Use offset and limit for large files.';
	readonly parameters = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute path to the file to read',
			},
			offset: {
				type: 'number',
				description: 'Line number to start reading from (1-based). Omit to read from the beginning.',
			},
			limit: {
				type: 'number',
				description: 'Maximum number of lines to read. Omit to read the entire file.',
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
		const offset = (args.offset as number) || 1;
		const limit = args.limit as number | undefined;

		try {
			const uri = URI.file(path);
			const content = await this._fileService.readFile(uri);
			const text = content.value.toString();
			const allLines = text.split('\n');

			const startIdx = Math.max(0, offset - 1);
			const endIdx = limit ? Math.min(allLines.length, startIdx + limit) : allLines.length;
			const selectedLines = allLines.slice(startIdx, endIdx);

			const numbered = selectedLines
				.map((line, i) => `${String(startIdx + i + 1).padStart(6)}|${line}`)
				.join('\n');

			const header = `File: ${path} (${allLines.length} lines total, showing ${startIdx + 1}-${endIdx})`;
			return this.success(toolCallId, `${header}\n${numbered}`);
		} catch (err) {
			return this.failure(toolCallId, `Failed to read file ${path}: ${(err as Error).message}`);
		}
	}
}
