/*---------------------------------------------------------------------------------------------
 *  Minimal URI shim - Compatible with VS Code base/common/uri API
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

export class URI {
	readonly scheme: string;
	readonly authority: string;
	readonly path: string;
	readonly query: string;
	readonly fragment: string;

	private constructor(scheme: string, authority: string, uriPath: string, query: string, fragment: string) {
		this.scheme = scheme;
		this.authority = authority;
		this.path = uriPath;
		this.query = query;
		this.fragment = fragment;
	}

	get fsPath(): string {
		return this.path;
	}

	toString(): string {
		if (this.scheme === 'file') {
			return `file://${this.path}`;
		}
		return `${this.scheme}://${this.authority}${this.path}${this.query ? '?' + this.query : ''}${this.fragment ? '#' + this.fragment : ''}`;
	}

	with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): URI {
		return new URI(
			change.scheme ?? this.scheme,
			change.authority ?? this.authority,
			change.path ?? this.path,
			change.query ?? this.query,
			change.fragment ?? this.fragment,
		);
	}

	static file(filePath: string): URI {
		const resolved = path.resolve(filePath);
		return new URI('file', '', resolved, '', '');
	}

	static parse(value: string): URI {
		const match = value.match(/^([a-z][a-z0-9+\-.]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i);
		if (match) {
			return new URI(match[1], match[2] || '', match[3] || '/', (match[4] || '').slice(1), (match[5] || '').slice(1));
		}
		return URI.file(value);
	}

	static isUri(thing: any): thing is URI {
		return thing instanceof URI;
	}
}
