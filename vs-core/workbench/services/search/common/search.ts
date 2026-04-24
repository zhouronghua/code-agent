/*---------------------------------------------------------------------------------------------
 *  Minimal ISearchService shim
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation';

export const ISearchService = createDecorator<ISearchService>('searchService');

export const enum QueryType {
	File = 1,
	Text = 2,
}

export interface IFolderQuery {
	folder: URI;
}

export interface IPatternInfo {
	pattern: string;
	isRegExp?: boolean;
	isCaseSensitive?: boolean;
	isWordMatch?: boolean;
}

export interface ITextQuery {
	type: QueryType.Text;
	contentPattern: IPatternInfo;
	folderQueries: IFolderQuery[];
	maxResults?: number;
	includePattern?: Record<string, boolean>;
}

export interface IFileQuery {
	type: QueryType.File;
	folderQueries: IFolderQuery[];
	filePattern?: string;
	maxResults?: number;
}

export interface IFileMatch {
	resource: URI;
	results?: Array<{ range?: { startLineNumber: number }; preview?: { text: string } }>;
}

export interface ISearchComplete {
	results: IFileMatch[];
	limitHit?: boolean;
}

export interface ISearchService {
	readonly _serviceBrand: undefined;
	textSearch(query: ITextQuery): Promise<ISearchComplete>;
	fileSearch(query: IFileQuery): Promise<ISearchComplete>;
}
