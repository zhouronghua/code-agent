/*---------------------------------------------------------------------------------------------
 *  Ollama LLM Provider - Local model REST API with tool support
 *--------------------------------------------------------------------------------------------*/

import { ILLMProvider, LLMProviderFactory, estimateTokenCount } from './llmProvider';
import {
	IAgentConfig,
	IAgentMessage,
	ILlmUsage,
	IToolSchema,
	MessageRole,
	createMessage,
} from '../common/agentModels';

export class OllamaProvider implements ILLMProvider {
	readonly name = 'ollama';
	private readonly _apiBase: string;
	private readonly _model: string;

	constructor(config: IAgentConfig) {
		this._apiBase = config.apiBase || 'http://localhost:11434';
		this._model = config.model || 'llama3';
	}

	async complete(
		messages: IAgentMessage[],
		tools?: IToolSchema[],
		temperature = 0,
		topK?: number,
	): Promise<IAgentMessage> {
		const body: Record<string, unknown> = {
			model: this._model,
			messages: messages.map(m => ({
				role: m.role,
				content: m.content,
			})),
			stream: false,
			options: {
				temperature,
				...(topK && topK > 0 ? { top_k: topK } : {}),
			},
		};

		if (tools && tools.length > 0) {
			body.tools = tools.map(t => ({
				type: 'function',
				function: {
					name: t.function.name,
					description: t.function.description,
					parameters: t.function.parameters,
				},
			}));
		}

		const response = await fetch(`${this._apiBase}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Ollama API error ${response.status}: ${errorText}`);
		}

		const data = await response.json();
		const msg = data.message;

		const toolCalls = msg.tool_calls?.map((tc: { function: { name: string; arguments: Record<string, unknown> } }, i: number) => ({
			id: `ollama_tc_${Date.now()}_${i}`,
			name: tc.function.name,
			arguments: tc.function.arguments,
		}));

		// Normalize Ollama token usage: prompt_eval_count / eval_count.
		const usage: ILlmUsage | undefined = (typeof data.prompt_eval_count === 'number' || typeof data.eval_count === 'number')
			? {
				promptTokens: data.prompt_eval_count ?? 0,
				completionTokens: data.eval_count ?? 0,
				totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
			}
			: undefined;

		return createMessage(
			MessageRole.Assistant,
			msg.content || '',
			{ toolCalls, usage },
		);
	}

	async *stream(
		messages: IAgentMessage[],
		_tools?: IToolSchema[],
		temperature = 0,
		topK?: number,
	): AsyncIterableIterator<string> {
		const body = {
			model: this._model,
			messages: messages.map(m => ({
				role: m.role,
				content: m.content,
			})),
			stream: true,
			options: {
				temperature,
				...(topK && topK > 0 ? { top_k: topK } : {}),
			},
		};

		const response = await fetch(`${this._apiBase}/api/chat`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Ollama API error ${response.status}: ${errorText}`);
		}

		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() || '';

			for (const line of lines) {
				if (!line.trim()) { continue; }
				try {
					const parsed = JSON.parse(line);
					if (parsed.message?.content) {
						yield parsed.message.content;
					}
				} catch {
					// skip
				}
			}
		}
	}

	countTokens(text: string): number {
		return estimateTokenCount(text);
	}
}

LLMProviderFactory.register('ollama', OllamaProvider);
