import { createDecorator } from '../../instantiation/common/instantiation';
export const IKeybindingService = createDecorator<IKeybindingService>('keybindingService');
export interface IKeybindingService { readonly _serviceBrand: undefined; }
