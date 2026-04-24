import { createDecorator } from '../../../../platform/instantiation/common/instantiation';

export const IViewsService = createDecorator<IViewsService>('viewsService');
export interface IViewsService {
	readonly _serviceBrand: undefined;
	openView(id: string, focus?: boolean): Promise<any>;
}
