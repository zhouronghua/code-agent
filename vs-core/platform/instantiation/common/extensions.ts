/*---------------------------------------------------------------------------------------------
 *  Minimal registerSingleton shim
 *--------------------------------------------------------------------------------------------*/

import { ServiceIdentifier } from './instantiation';

export const enum InstantiationType {
	Eager = 0,
	Delayed = 1,
}

const _registry: Array<{ id: ServiceIdentifier<any>; ctor: any; type: InstantiationType }> = [];

export function registerSingleton<T>(
	id: ServiceIdentifier<T>,
	ctor: any,
	type: InstantiationType = InstantiationType.Delayed,
): void {
	_registry.push({ id, ctor, type });
}

export function getSingletonServiceDescriptors(): Array<{ id: ServiceIdentifier<any>; ctor: any; type: InstantiationType }> {
	return _registry;
}
