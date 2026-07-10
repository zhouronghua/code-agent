/*---------------------------------------------------------------------------------------------
 *  edit_file tool - Exact string replacement within a file
 *  Injects: IFileService
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { VSBuffer } from 'vs/base/common/buffer';
import { IFileService } from 'vs/platform/files/common/files';
import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from '../agentTools';

export class EditFileTool extends AgentTool {
	readonly name = 'edit_file';
	readonly description = 'Replace an exact string occurrence in a file. The old_string must uniquely identify the target. Use replace_all to replace all occurrences.';
	readonly parameters = {
		type: 'object',
		properties: {
			path: {
				type: 'string',
				description: 'Absolute path to the file to edit',
			},
			old_string: {
				type: 'string',
				description: 'The exact string to find and replace. Must be unique in the file unless replace_all is true.',
			},
			new_string: {
				type: 'string',
				description: 'The replacement string',
			},
			replace_all: {
				type: 'boolean',
				description: 'If true, replace all occurrences. Default: false.',
			},
		},
		required: ['path', 'old_string', 'new_string'],
	};

	constructor(private readonly _fileService: IFileService) {
		super();
	}

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = args._toolCallId as string || '';
		const path = args.path as string;
		const oldString = args.old_string as string;
		const newString = args.new_string as string;
		const replaceAll = args.replace_all as boolean || false;

		if (signal?.aborted) {
			return this.failure(toolCallId, 'Tool execution cancelled by user');
		}

		try {
			const uri = URI.file(path);
			const content = await this._fileService.readFile(uri);
			const text = content.value.toString();

			const occurrences = text.split(oldString).length - 1;

			if (occurrences === 0) {
				return this.failure(toolCallId, `old_string not found in ${path}. Make sure it matches exactly including whitespace.`);
			}

			if (!replaceAll && occurrences > 1) {
				return this.failure(toolCallId, `old_string found ${occurrences} times in ${path}. Provide more context to make it unique, or set replace_all=true.`);
			}

			let newText: string;
			if (replaceAll) {
				newText = text.split(oldString).join(newString);
			} else {
				const idx = text.indexOf(oldString);
				newText = text.substring(0, idx) + newString + text.substring(idx + oldString.length);
			}

			await this._fileService.writeFile(uri, VSBuffer.fromString(newText));

			const replacedCount = replaceAll ? occurrences : 1;
			return this.success(toolCallId, `Replaced ${replacedCount} occurrence(s) in ${path}`);
		} catch (err) {
			return this.failure(toolCallId, `Failed to edit file ${path}: ${(err as Error).message}`);
		}
	}
}
