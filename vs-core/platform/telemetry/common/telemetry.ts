import { createDecorator } from '../../instantiation/common/instantiation';
export const ITelemetryService = createDecorator<ITelemetryService>('telemetryService');
export interface ITelemetryService { readonly _serviceBrand: undefined; }
