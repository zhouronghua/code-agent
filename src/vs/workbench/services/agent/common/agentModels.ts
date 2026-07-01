/*---------------------------------------------------------------------------------------------
 *  Agent Models - Data types for the Agent system
 *  Follows VS Code convention: pure data types, no dependencies on browser/electron
 *--------------------------------------------------------------------------------------------*/

export const enum MessageRole {
	System = 'system',
	User = 'user',
	Assistant = 'assistant',
	Tool = 'tool',
}

export const enum AgentMode {
	Agent = 'agent',
	Ask = 'ask',
	Plan = 'plan',
}

export const enum StepStatus {
	Pending = 'pending',
	Running = 'running',
	Done = 'done',
	Failed = 'failed',
}

export interface IToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: Record<string, unknown>;
}

export interface IAgentMessage {
	readonly id: string;
	readonly role: MessageRole;
	readonly content: string;
	readonly toolCalls?: IToolCall[];
	readonly toolCallId?: string;
	readonly timestamp: number;
	readonly reasoningContent?: string;
}

export interface IToolResult {
	readonly toolCallId: string;
	readonly success: boolean;
	readonly output: string;
	readonly error?: string;
}

export interface IToolSchema {
	readonly type: 'function';
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: Record<string, unknown>;
	};
}

export interface IAgentStep {
	readonly id: number;
	readonly description: string;
	status: StepStatus;
	toolName?: string;
	toolArgs?: Record<string, unknown>;
	result?: string;
}

export interface IAgentPlan {
	readonly task: string;
	readonly steps: IAgentStep[];
	currentStep: number;
}

export interface IAgentSession {
	readonly id: string;
	readonly name: string;
	readonly mode: AgentMode;
	readonly messages: IAgentMessage[];
	readonly systemPrompt?: string;
	readonly extraSystemPrompt?: string;
	readonly workingDirectory?: string;
	plan?: IAgentPlan;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly messageCount: number;
	readonly summary?: string;
}

export interface IAgentConfig {
	provider: 'openai' | 'anthropic' | 'ollama';
	model: string;
	apiKey: string;
	apiBase?: string;
	maxSteps: number;
	maxContextTokens: number;
	maxOutputTokens: number;
	temperature: number;
	stepTimeout: number;
	taskTimeout: number;
}

export const DEFAULT_AGENT_CONFIG: IAgentConfig = {
	provider: 'openai',
	model: 'gpt-4o',
	apiKey: '',
	maxSteps: 999999,  // Effectively unlimited
	maxContextTokens: 200000,
	maxOutputTokens: 65536,
	temperature: 0,
	stepTimeout: 300000,  // 5 minutes - allow tools with custom timeouts to complete
	taskTimeout: 3600000,  // 1 hour
};

export function createMessage(
	role: MessageRole,
	content: string,
	extra?: Partial<IAgentMessage>
): IAgentMessage {
	return {
		id: generateId(),
		role,
		content,
		timestamp: Date.now(),
		...extra,
	};
}

export function createToolResultMessage(result: IToolResult): IAgentMessage {
	const content = result.output || result.error || '(no output)';
	return createMessage(MessageRole.Tool, content, {
		toolCallId: result.toolCallId,
	});
}

let _idCounter = 0;
export function generateId(): string {
	return `msg_${Date.now()}_${_idCounter++}`;
}
