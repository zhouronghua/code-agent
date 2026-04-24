/*---------------------------------------------------------------------------------------------
 *  Minimal Codicon shim
 *--------------------------------------------------------------------------------------------*/

export class Codicon {
	constructor(public readonly id: string, public readonly description: string = '') { }
	static readonly hubot = new Codicon('hubot');
}
