/*---------------------------------------------------------------------------------------------
 *  Minimal Disposable shim - Compatible with VS Code base/common/lifecycle API
 *--------------------------------------------------------------------------------------------*/

export interface IDisposable {
	dispose(): void;
}

export function toDisposable(fn: () => void): IDisposable {
	return { dispose: fn };
}

export function combinedDisposable(...disposables: IDisposable[]): IDisposable {
	return { dispose: () => disposables.forEach(d => d.dispose()) };
}

export class DisposableStore implements IDisposable {
	private readonly _toDispose = new Set<IDisposable>();
	private _isDisposed = false;

	add<T extends IDisposable>(o: T): T {
		if (this._isDisposed) { o.dispose(); return o; }
		this._toDispose.add(o);
		return o;
	}

	dispose(): void {
		if (this._isDisposed) { return; }
		this._isDisposed = true;
		for (const d of this._toDispose) { d.dispose(); }
		this._toDispose.clear();
	}
}

export class Disposable implements IDisposable {
	static readonly None: IDisposable = Object.freeze({ dispose() { } });

	private readonly _store = new DisposableStore();

	protected _register<T extends IDisposable>(o: T): T {
		return this._store.add(o);
	}

	dispose(): void {
		this._store.dispose();
	}
}
