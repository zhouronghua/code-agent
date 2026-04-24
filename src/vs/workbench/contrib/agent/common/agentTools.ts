/*---------------------------------------------------------------------------------------------
 *  Agent Tool System - Abstract base class + registry
 *--------------------------------------------------------------------------------------------*/

import { IToolResult, IToolSchema } from 'vs/workbench/services/agent/common/agentModels';

export abstract class AgentTool {
	abstract readonly name: string;
	abstract readonly description: string;
	abstract readonly parameters: Record<string, unknown>;

	abstract execute(args: Record<string, unknown>): Promise<IToolResult>;

	toSchema(): IToolSchema {
		return {
			type: 'function',
			function: {
				name: this.name,
				description: this.description,
				parameters: this.parameters,
			},
		};
	}

	protected success(toolCallId: string, output: string): IToolResult {
		return { toolCallId, success: true, output };
	}

	protected failure(toolCallId: string, error: string): IToolResult {
		return { toolCallId, success: false, output: '', error };
	}
}

export class ToolRegistry {
	private readonly _tools = new Map<string, AgentTool>();

	register(tool: AgentTool): void {
		this._tools.set(tool.name, tool);
	}

	get(name: string): AgentTool | undefined {
		return this._tools.get(name);
	}

	has(name: string): boolean {
		return this._tools.has(name);
	}

	listNames(): string[] {
		return [...this._tools.keys()];
	}

	listSchemas(): IToolSchema[] {
		return [...this._tools.values()].map(t => t.toSchema());
	}

	getReadOnlySchemas(): IToolSchema[] {
		const readOnlyTools = ['read_file', 'list_directory', 'search_text', 'search_files'];
		return [...this._tools.values()]
			.filter(t => readOnlyTools.includes(t.name))
			.map(t => t.toSchema());
	}
}
