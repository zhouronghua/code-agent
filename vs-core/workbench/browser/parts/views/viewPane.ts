import { Disposable } from '../../../../base/common/lifecycle';

export interface IViewPaneOptions {
	id: string;
	title: string;
}

export class ViewPane extends Disposable {
	constructor(protected options: IViewPaneOptions, ...services: any[]) {
		super();
	}
	protected renderBody(container: HTMLElement): void { }
	protected layoutBody(height: number, width: number): void { }
}

export class ViewPaneContainer extends Disposable {
	constructor(id: string, options?: any) { super(); }
}
