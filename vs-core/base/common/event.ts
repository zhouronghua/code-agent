/*---------------------------------------------------------------------------------------------
 *  Minimal Event/Emitter shim - Compatible with VS Code base/common/event API
 *--------------------------------------------------------------------------------------------*/

import { IDisposable, Disposable } from './lifecycle';

export interface Event<T> {
	(listener: (e: T) => any, thisArgs?: any): IDisposable;
}

export namespace Event {
	export const None: Event<any> = () => Disposable.None;
}

type Listener<T> = (e: T) => void;

export class Emitter<T> {
	private _listeners: Array<{ fn: Listener<T>; thisArg?: any }> = [];
	private _disposed = false;

	get event(): Event<T> {
		return (listener: Listener<T>, thisArgs?: any): IDisposable => {
			if (this._disposed) { return Disposable.None; }
			const entry = { fn: listener, thisArg: thisArgs };
			this._listeners.push(entry);
			return {
				dispose: () => {
					const idx = this._listeners.indexOf(entry);
					if (idx >= 0) { this._listeners.splice(idx, 1); }
				},
			};
		};
	}

	fire(event: T): void {
		if (this._disposed) { return; }
		for (const { fn, thisArg } of [...this._listeners]) {
			try { fn.call(thisArg, event); }
			catch (e) { console.error('Event listener error:', e); }
		}
	}

	dispose(): void {
		this._disposed = true;
		this._listeners.length = 0;
	}
}
