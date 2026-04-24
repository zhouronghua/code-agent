import { createDecorator } from '../../instantiation/common/instantiation';
export const IThemeService = createDecorator<IThemeService>('themeService');
export interface IThemeService { readonly _serviceBrand: undefined; }
