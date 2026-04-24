/*---------------------------------------------------------------------------------------------
 *  Minimal SyncDescriptor shim
 *--------------------------------------------------------------------------------------------*/

export class SyncDescriptor<T> {
	constructor(
		readonly ctor: new (...args: any[]) => T,
		readonly staticArguments: any[] = [],
		readonly supportsDelayedInstantiation: boolean = false,
	) { }
}
