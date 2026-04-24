import { createDecorator } from '../../instantiation/common/instantiation';

export const IQuickInputService = createDecorator<IQuickInputService>('quickInputService');

export interface IQuickInputService {
	readonly _serviceBrand: undefined;
	input(options?: { placeHolder?: string; prompt?: string }): Promise<string | undefined>;
	pick<T extends { label: string }>(picks: T[], options?: { placeHolder?: string }): Promise<T | undefined>;
}
