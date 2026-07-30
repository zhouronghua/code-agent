/*---------------------------------------------------------------------------------------------
 *  Agent Tool System - Abstract base class + registry
 *--------------------------------------------------------------------------------------------*/

import { IToolResult, IToolSchema } from 'vs/workbench/services/agent/common/agentModels';

export abstract class AgentTool {
	abstract readonly name: string;
	abstract readonly description: string;
	abstract readonly parameters: Record<string, unknown>;

	abstract execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult>;

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
	private readonly _aliases = new Map<string, string>();

	register(tool: AgentTool): void {
		this._tools.set(tool.name, tool);
	}

	/**
	 * Register an alias name that maps to an existing tool.
	 * Useful for compatibility with tool names from other agent frameworks
	 * (e.g. search_content → search_text).
	 */
	registerAlias(alias: string, targetName: string): void {
		if (!this._tools.has(targetName)) {
			throw new Error(`Cannot alias "${alias}" to non-existent tool "${targetName}"`);
		}
		this._aliases.set(alias, targetName);
	}

	get(name: string): AgentTool | undefined {
		// Check direct name first, then alias
		const tool = this._tools.get(name);
		if (tool) { return tool; }
		const targetName = this._aliases.get(name);
		if (targetName) { return this._tools.get(targetName); }
		return undefined;
	}

	has(name: string): boolean {
		return this._tools.has(name) || this._aliases.has(name);
	}

	listNames(): string[] {
		return [...this._tools.keys()];
	}

	listSchemas(): IToolSchema[] {
		// Emit schemas for registered tools AND aliases so LLMs learn both names
		const schemas: IToolSchema[] = [];
		for (const tool of this._tools.values()) {
			schemas.push(tool.toSchema());
		}
		for (const [alias, targetName] of this._aliases) {
			const target = this._tools.get(targetName);
			if (target) {
				const original = target.toSchema();
				schemas.push({
					type: 'function',
					function: {
						name: alias,
						description: original.function.description,
						parameters: original.function.parameters,
					},
				});
			}
		}
		return schemas;
	}

	getReadOnlySchemas(): IToolSchema[] {
		const readOnlyTools = ['read_file', 'list_directory', 'search_text', 'search_files', 'search_content'];
		const schemas: IToolSchema[] = [];
		for (const tool of this._tools.values()) {
			if (readOnlyTools.includes(tool.name)) {
				schemas.push(tool.toSchema());
			}
		}
		for (const [alias, targetName] of this._aliases) {
			if (readOnlyTools.includes(alias)) {
				const target = this._tools.get(targetName);
				if (target) {
					const original = target.toSchema();
					schemas.push({
						type: 'function',
						function: {
							name: alias,
							description: original.function.description,
							parameters: original.function.parameters,
						},
					});
				}
			}
		}
		return schemas;
	}
}
