/*---------------------------------------------------------------------------------------------
 *  LLM Provider - Abstract interface + factory for LLM backends
 *--------------------------------------------------------------------------------------------*/

import { IAgentMessage, IToolSchema, IAgentConfig } from '../common/agentModels';

export interface ILLMProvider {
	readonly name: string;

	complete(
		messages: IAgentMessage[],
		tools?: IToolSchema[],
		temperature?: number,
	): Promise<IAgentMessage>;

	stream(
		messages: IAgentMessage[],
		tools?: IToolSchema[],
		temperature?: number,
	): AsyncIterableIterator<string>;

	countTokens(text: string): number;

	supportsStreaming?(): boolean;

	/** Does this model use reasoning_content (thinking/chain-of-thought)? */
	supportsReasoning?(): boolean;
}

export class LLMProviderFactory {
	private static readonly _providers = new Map<string, new (config: IAgentConfig) => ILLMProvider>();

	static register(name: string, ctor: new (config: IAgentConfig) => ILLMProvider): void {
		LLMProviderFactory._providers.set(name, ctor);
	}

	static create(config: IAgentConfig): ILLMProvider {
		const ctor = LLMProviderFactory._providers.get(config.provider);
		if (!ctor) {
			throw new Error(`Unknown LLM provider: ${config.provider}. Available: ${[...LLMProviderFactory._providers.keys()].join(', ')}`);
		}
		return new ctor(config);
	}
}
