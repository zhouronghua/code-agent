/*---------------------------------------------------------------------------------------------
 *  Minimal nls shim - localize just returns the message string
 *--------------------------------------------------------------------------------------------*/

export function localize(_key: any, message: string, ...args: any[]): string {
	if (args.length === 0) { return message; }
	return message.replace(/\{(\d+)\}/g, (_, idx) => String(args[Number(idx)] ?? ''));
}
