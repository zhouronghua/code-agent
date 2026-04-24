/*---------------------------------------------------------------------------------------------
 *  Node.js implementation of ISearchService (uses ripgrep or grep)
 *--------------------------------------------------------------------------------------------*/

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { URI } from '../base/common/uri';
import { ISearchService, ITextQuery, IFileQuery, ISearchComplete, IFileMatch } from '../workbench/services/search/common/search';

export class NodeSearchService implements ISearchService {
	readonly _serviceBrand: undefined;

	async textSearch(query: ITextQuery): Promise<ISearchComplete> {
		const folder = query.folderQueries[0]?.folder.fsPath || '.';
		const pattern = query.contentPattern.pattern;
		const maxResults = query.maxResults || 50;

		try {
			let cmd = `rg --no-heading -n "${pattern.replace(/"/g, '\\"')}" "${folder}" --max-count ${maxResults}`;
			if (query.includePattern) {
				for (const glob of Object.keys(query.includePattern)) {
					cmd += ` --glob "${glob}"`;
				}
			}
			const output = execSync(cmd, { encoding: 'utf-8', timeout: 15000 }).trim();
			const results: IFileMatch[] = [];
			const fileMap = new Map<string, IFileMatch>();

			for (const line of output.split('\n')) {
				if (!line) continue;
				const match = line.match(/^(.+?):(\d+):(.*)$/);
				if (!match) continue;

				const [, filePath, lineNum, text] = match;
				if (!fileMap.has(filePath)) {
					fileMap.set(filePath, { resource: URI.file(filePath), results: [] });
				}
				fileMap.get(filePath)!.results!.push({
					range: { startLineNumber: parseInt(lineNum, 10) },
					preview: { text: text.trim() },
				});
			}

			return { results: [...fileMap.values()] };
		} catch {
			return { results: [] };
		}
	}

	async fileSearch(query: IFileQuery): Promise<ISearchComplete> {
		const folder = query.folderQueries[0]?.folder.fsPath || '.';
		const pattern = query.filePattern || '*';
		const maxResults = query.maxResults || 100;

		try {
			const cmd = `find "${folder}" -name "${pattern}" -type f 2>/dev/null | head -${maxResults}`;
			const output = execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim();
			const results: IFileMatch[] = output.split('\n')
				.filter(Boolean)
				.map(p => ({ resource: URI.file(p) }));
			return { results };
		} catch {
			return { results: [] };
		}
	}
}
