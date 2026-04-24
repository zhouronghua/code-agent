import { IDisposable } from '../../base/common/lifecycle';

export const enum WorkbenchPhase {
	BlockStartup = 1,
	BlockRestore = 2,
	AfterRestored = 3,
	Eventually = 4,
}

export interface IWorkbenchContribution extends IDisposable { }

export function registerWorkbenchContribution2(id: string, ctor: any, phase: WorkbenchPhase): void {
	// Contribution registration stub
}
