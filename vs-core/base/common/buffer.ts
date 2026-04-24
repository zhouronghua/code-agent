/*---------------------------------------------------------------------------------------------
 *  Minimal VSBuffer shim - Wraps Node.js Buffer
 *--------------------------------------------------------------------------------------------*/

export class VSBuffer {
	readonly buffer: Uint8Array;
	readonly byteLength: number;

	private constructor(buffer: Uint8Array) {
		this.buffer = buffer;
		this.byteLength = buffer.byteLength;
	}

	toString(): string {
		return Buffer.from(this.buffer).toString('utf-8');
	}

	static fromString(source: string): VSBuffer {
		return new VSBuffer(Buffer.from(source, 'utf-8'));
	}

	static fromByteArray(source: number[]): VSBuffer {
		return new VSBuffer(new Uint8Array(source));
	}

	static wrap(buffer: Uint8Array): VSBuffer {
		return new VSBuffer(buffer);
	}

	static concat(buffers: VSBuffer[], totalLength?: number): VSBuffer {
		const result = Buffer.concat(buffers.map(b => Buffer.from(b.buffer)), totalLength);
		return new VSBuffer(result);
	}

	static alloc(byteLength: number): VSBuffer {
		return new VSBuffer(new Uint8Array(byteLength));
	}
}
