import { createDecorator } from '../../instantiation/common/instantiation';

export const IConfigurationService = createDecorator<IConfigurationService>('configurationService');

export interface IConfigurationService {
	readonly _serviceBrand: undefined;
	getValue<T>(key: string): T | undefined;
}
