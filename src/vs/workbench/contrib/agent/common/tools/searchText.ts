/*---------------------------------------------------------------------------------------------
 *  search_text tool - Text pattern search using ISearchService (ripgrep backend)
 *  Injects: ISearchService
 *--------------------------------------------------------------------------------------------*/

import { URI } from 'vs/base/common/uri';
import { ISearchService, ITextQuery, QueryType } from 'vs/workbench/services/search/common/search';
import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from '../agentTools';

export class SearchTextTool extends AgentTool {
	readonly name = 'search_text';
	readonly description = 'Search for a text pattern (regex supported) across files in a directory. Returns matching lines with file paths and line numbers.';
	readonly parameters = {
		type: 'object',
		properties: {
			pattern: {
				type: 'string',
				description: 'The search pattern (regex supported)',
			},
			path: {
				type: 'string',
				description: 'Directory to search in. Defaults to workspace root.',
			},
			glob: {
				type: 'string',
				description: 'Glob pattern to filter files (e.g. "*.ts", "**/*.py")',
			},
			max_results: {
				type: 'number',
				description: 'Maximum number of results to return. Default: 50.',
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
		const glob = args.glob as string | undefined;
		const maxResults = (args.max_results as number) || 50;

		if (signal?.aborted) {
			return this.failure(toolCallId, 'Tool execution cancelled by user');
		}

		// Validate regex safety before passing to ripgrep
		try {
			new RegExp(pattern);
		} catch (regexErr) {
			return this.failure(toolCallId,
				`Invalid regex pattern: "${pattern}". ` +
				`Error: ${(regexErr as Error).message}. ` +
				`Tip: escape special chars like \\ . * + ? [ ] ( ) { } ^ $ | with backslash.`
			);
		}

		try {
			const folderUri = searchPath ? URI.file(searchPath) : this._workspaceRoot;

			const query: ITextQuery = {
				type: QueryType.Text,
				contentPattern: {
					pattern,
					isRegExp: true,
					isCaseSensitive: false,
					isWordMatch: false,
				},
				folderQueries: [{ folder: folderUri }],
				maxResults,
			};

			if (glob) {
				query.includePattern = { [glob]: true };
			}

			const results = await this._searchService.textSearch(query);
			const lines: string[] = [];

			for (const result of results.results) {
				const filePath = result.resource.fsPath;
				for (const match of result.results || []) {
					const lineNum = (match as any).range?.startLineNumber || '?';
					const preview = (match as any).preview?.text?.trim() || '';
					lines.push(`${filePath}:${lineNum}: ${preview}`);
				}
			}

			if (lines.length === 0) {
				return this.success(toolCallId, `No matches found for pattern: ${pattern}`);
			}

			const header = `Found ${lines.length} match(es) for "${pattern}"`;
			return this.success(toolCallId, `${header}\n${lines.join('\n')}`);
		} catch (err) {
			return this.failure(toolCallId, `Search failed: ${(err as Error).message}`);
		}
	}
}
