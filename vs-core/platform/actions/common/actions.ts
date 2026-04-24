import { ServicesAccessor } from '../../instantiation/common/instantiation';

export const enum MenuId {
	ViewTitle = 'ViewTitle',
}

export interface IAction2Options {
	id: string;
	title: string;
	f1?: boolean;
	keybinding?: any;
	menu?: any;
}

export abstract class Action2 {
	constructor(readonly desc: IAction2Options) { }
	abstract run(accessor: ServicesAccessor, ...args: any[]): any;
}

export function registerAction2(ctor: new () => Action2): void {
	// Action registration stub
}
