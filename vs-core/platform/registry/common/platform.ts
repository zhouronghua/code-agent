/*---------------------------------------------------------------------------------------------
 *  Minimal Registry shim
 *--------------------------------------------------------------------------------------------*/

const _registry = new Map<string, any>();

export namespace Registry {
	export function as<T>(id: string): T {
		if (!_registry.has(id)) {
			_registry.set(id, {} as any);
		}
		return _registry.get(id) as T;
	}

	export function add(id: string, value: any): void {
		_registry.set(id, value);
	}
}
