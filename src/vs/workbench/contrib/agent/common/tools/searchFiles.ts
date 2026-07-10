/*---------------------------------------------------------------------------------------------
 *  search_files tool - Find files by glob pattern
 *  Injects: ISearchService
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { ISearchService, IFileQuery, QueryType } from 'vs/workbench/services/search/common/search';
import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from '../agentTools';

export class SearchFilesTool extends AgentTool {
	readonly name = 'search_files';
	readonly description = 'Find files matching a glob pattern. Returns a list of matching file paths.';
	readonly parameters = {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: 'Glob pattern to match files (e.g. "**/*.ts", "src/**/test_*.py")',
			},
			path: {
				type: 'string',
				description: 'Directory to search in. Defaults to workspace root.',
			},
			max_results: {
				type: 'number',
				description: 'Maximum number of results. Default: 100.',
			},
		},
		required: ['pattern'],
	};

	constructor(
		private readonly _searchService: ISearchService,
		private readonly _workspaceRoot: URI,
	) {
		super();
	}

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = args._toolCallId as string || '';
		const pattern = args.pattern as string;
		const searchPath = args.path as string | undefined;
		const maxResults = (args.max_results as number) || 100;

		if (signal?.aborted) {
			return this.failure(toolCallId, 'Tool execution cancelled by user');
		}

		try {
			const folderUri = searchPath ? URI.file(searchPath) : this._workspaceRoot;

			const query: IFileQuery = {
				type: QueryType.File,
				folderQueries: [{ folder: folderUri }],
				filePattern: pattern,
				maxResults,
			};

			const results = await this._searchService.fileSearch(query);
			const paths = results.results.map(r => r.resource.fsPath);

			if (paths.length === 0) {
				return this.success(toolCallId, `No files found matching pattern: ${pattern}`);
			}

			const header = `Found ${paths.length} file(s) matching "${pattern}"`;
			return this.success(toolCallId, `${header}\n${paths.join('\n')}`);
		} catch (err) {
			return this.failure(toolCallId, `File search failed: ${(err as Error).message}`);
		}
	}
}
