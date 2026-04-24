/*---------------------------------------------------------------------------------------------
 *  Minimal IFileService shim
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../base/common/uri';
import { VSBuffer } from '../../../base/common/buffer';
import { createDecorator } from '../../instantiation/common/instantiation';

export const IFileService = createDecorator<IFileService>('fileService');

export const enum FileType {
	Unknown = 0,
	File = 1,
	Directory = 2,
	SymbolicLink = 64,
}

export interface IFileStat {
	readonly resource: URI;
	readonly name: string;
	readonly isFile: boolean;
	readonly isDirectory: boolean;
	readonly isSymbolicLink: boolean;
	children?: IFileStat[];
	readonly size?: number;
	readonly mtime?: number;
}

export interface IFileContent {
	readonly resource: URI;
	readonly value: VSBuffer;
}

export interface IResolveFileOptions {
	readonly resolveMetadata?: boolean;
}

export interface IFileService {
	readonly _serviceBrand: undefined;
	readFile(resource: URI): Promise<IFileContent>;
	writeFile(resource: URI, content: VSBuffer): Promise<IFileStat>;
	resolve(resource: URI, options?: IResolveFileOptions): Promise<IFileStat>;
	exists(resource: URI): Promise<boolean>;
	del(resource: URI): Promise<void>;
	createFolder(resource: URI): Promise<IFileStat>;
}
