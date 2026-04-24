/*---------------------------------------------------------------------------------------------
 *  Minimal CancellationToken shim
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from './event';
import { IDisposable } from './lifecycle';

export interface CancellationToken {
	readonly isCancellationRequested: boolean;
	readonly onCancellationRequested: Event<any>;
}

export namespace CancellationToken {
	export const None: CancellationToken = Object.freeze({
		isCancellationRequested: false,
		onCancellationRequested: Event.None,
	});

	export const Cancelled: CancellationToken = Object.freeze({
		isCancellationRequested: true,
		onCancellationRequested: Event.None,
	});
}

export class CancellationTokenSource implements IDisposable {
	private _token: CancellationToken | undefined;
	private _emitter: Emitter<void> | undefined;
	private _cancelled = false;

	get token(): CancellationToken {
		if (!this._token) {
			this._emitter = new Emitter<void>();
			this._token = {
				isCancellationRequested: this._cancelled,
				onCancellationRequested: this._emitter.event,
			};
		}
		return this._token;
	}

	cancel(): void {
		if (!this._cancelled) {
			this._cancelled = true;
			if (this._emitter) {
				this._emitter.fire(undefined);
			}
			if (this._token) {
				(this._token as any).isCancellationRequested = true;
			}
		}
	}

	dispose(): void {
		this._emitter?.dispose();
	}
}
