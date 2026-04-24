/*---------------------------------------------------------------------------------------------
 *  Node.js implementation of IFileService
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { URI } from '../base/common/uri';
import { VSBuffer } from '../base/common/buffer';
import { IFileService, IFileContent, IFileStat, IResolveFileOptions } from '../platform/files/common/files';

export class NodeFileService implements IFileService {
	readonly _serviceBrand: undefined;

	async readFile(resource: URI): Promise<IFileContent> {
		const content = fs.readFileSync(resource.fsPath, 'utf-8');
		return { resource, value: VSBuffer.fromString(content) };
	}

	async writeFile(resource: URI, content: VSBuffer): Promise<IFileStat> {
		const dir = nodePath.dirname(resource.fsPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(resource.fsPath, content.toString(), 'utf-8');
		return this._stat(resource);
	}

	async resolve(resource: URI, options?: IResolveFileOptions): Promise<IFileStat> {
		const stat = this._stat(resource);
		if (stat.isDirectory) {
			const entries = fs.readdirSync(resource.fsPath, { withFileTypes: true });
			stat.children = entries.map(e => {
				const childUri = URI.file(nodePath.join(resource.fsPath, e.name));
				return {
					resource: childUri,
					name: e.name,
					isFile: e.isFile(),
					isDirectory: e.isDirectory(),
					isSymbolicLink: e.isSymbolicLink(),
				} as IFileStat;
			});
		}
		return stat;
	}

	async exists(resource: URI): Promise<boolean> {
		return fs.existsSync(resource.fsPath);
	}

	async del(resource: URI): Promise<void> {
		fs.rmSync(resource.fsPath, { recursive: true, force: true });
	}

	async createFolder(resource: URI): Promise<IFileStat> {
		fs.mkdirSync(resource.fsPath, { recursive: true });
		return this._stat(resource);
	}

	private _stat(resource: URI): IFileStat {
		try {
			const s = fs.statSync(resource.fsPath);
			return {
				resource,
				name: nodePath.basename(resource.fsPath),
				isFile: s.isFile(),
				isDirectory: s.isDirectory(),
				isSymbolicLink: s.isSymbolicLink(),
				size: s.size,
				mtime: s.mtimeMs,
			} as IFileStat;
		} catch {
			return {
				resource,
				name: nodePath.basename(resource.fsPath),
				isFile: false,
				isDirectory: false,
				isSymbolicLink: false,
			} as IFileStat;
		}
	}
}
