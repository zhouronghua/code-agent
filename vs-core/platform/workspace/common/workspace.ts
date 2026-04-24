import { URI } from '../../../base/common/uri';
import { createDecorator } from '../../instantiation/common/instantiation';

export const IWorkspaceContextService = createDecorator<IWorkspaceContextService>('workspaceContextService');

export interface IWorkspaceFolder {
	readonly uri: URI;
	readonly name: string;
}

export interface IWorkspace {
	readonly folders: readonly IWorkspaceFolder[];
}

export interface IWorkspaceContextService {
	readonly _serviceBrand: undefined;
	getWorkspace(): IWorkspace;
}
