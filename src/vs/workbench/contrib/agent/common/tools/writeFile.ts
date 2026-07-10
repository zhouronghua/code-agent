/*---------------------------------------------------------------------------------------------
 *  write_file tool - Create or overwrite a file with given content
 *  Injects: IFileService
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { VSBuffer } from 'vs/base/common/buffer';
import { IFileService } from 'vs/platform/files/common/files';
import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from '../agentTools';

export class WriteFileTool extends AgentTool {
	readonly name = 'write_file';
	readonly description = 'Create a new file or overwrite an existing file with the provided content.';
	readonly parameters = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute path to the file to write',
			},
			content: {
				type: 'string',
				description: 'The full content to write to the file',
			},
		},
		required: ['path', 'content'],
	};

	constructor(private readonly _fileService: IFileService) {
		super();
	}

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = args._toolCallId as string || '';
		const path = args.path as string;
		const content = args.content as string;

		if (signal?.aborted) {
			return this.failure(toolCallId, 'Tool execution cancelled by user');
		}

		try {
			const uri = URI.file(path);
			await this._fileService.writeFile(uri, VSBuffer.fromString(content));
			const lineCount = content.split('\n').length;
			return this.success(toolCallId, `Successfully wrote ${lineCount} lines to ${path}`);
		} catch (err) {
			return this.failure(toolCallId, `Failed to write file ${path}: ${(err as Error).message}`);
		}
	}
}
