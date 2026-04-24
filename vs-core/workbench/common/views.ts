import { SyncDescriptor } from '../../platform/instantiation/common/descriptors';

export const enum ViewContainerLocation { Sidebar = 0, Panel = 1, AuxiliaryBar = 2 }

export namespace Extensions {
	export const ViewContainersRegistry = 'workbench.registry.view.containers';
	export const ViewsRegistry = 'workbench.registry.view';
}

export interface IViewContainersRegistry {
	registerViewContainer(descriptor: any, location: ViewContainerLocation, options?: any): any;
}

export interface IViewsRegistry {
	registerViews(views: any[], container: any): void;
}
