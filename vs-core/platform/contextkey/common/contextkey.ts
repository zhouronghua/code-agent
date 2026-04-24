import { createDecorator } from '../../instantiation/common/instantiation';
export const IContextKeyService = createDecorator<IContextKeyService>('contextKeyService');
export interface IContextKeyService { readonly _serviceBrand: undefined; }
