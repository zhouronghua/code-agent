/*---------------------------------------------------------------------------------------------
 *  Minimal DI shim - createDecorator + ServiceIdentifier
 *--------------------------------------------------------------------------------------------*/

export interface ServiceIdentifier<T> {
	(...args: any[]): void;
	type: T;
}

export function createDecorator<T>(serviceId: string): ServiceIdentifier<T> {
	const id = function (target: Function, key: string, index: number): any {
		// DI parameter decorator - used by VS Code's instantiation service
	} as any;
	id.toString = () => serviceId;
	return id;
}

export type BrandedService = { _serviceBrand: undefined };

export interface ServicesAccessor {
	get<T>(id: ServiceIdentifier<T>): T;
}

export interface IInstantiationService {
	readonly _serviceBrand: undefined;
	createInstance<T>(descriptor: any, ...args: any[]): T;
}

export const IInstantiationService = createDecorator<IInstantiationService>('instantiationService');
