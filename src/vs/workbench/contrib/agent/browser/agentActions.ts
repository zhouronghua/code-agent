/*---------------------------------------------------------------------------------------------
 *  Agent Actions - Command and keybinding registration
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { Action2, registerAction2, MenuId } from 'vs/platform/actions/common/actions';
import { ServicesAccessor } from 'vs/platform/instantiation/common/instantiation';
import { KeyCode, KeyMod } from 'vs/base/common/keyCodes';
import { KeybindingWeight } from 'vs/platform/keybinding/common/keybindingsRegistry';
import { IQuickInputService } from 'vs/platform/quickinput/common/quickInput';
import { IAgentService } from 'vs/workbench/services/agent/common/agentService';
import { AgentMode } from 'vs/workbench/services/agent/common/agentModels';
import { IViewsService } from 'vs/workbench/services/views/common/viewsService';
import { AgentViewPane } from './agentViewPane';

// --- Open Agent Panel ---
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agent.openPanel',
			title: localize('agent.openPanel', 'Open Agent Panel'),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.KeyI,
			},
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		await viewsService.openView(AgentViewPane.ID, true);
	}
});

// --- Send Message (from command palette) ---
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agent.sendMessage',
			title: localize('agent.sendMessage', 'Agent: Send Message'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const agentService = accessor.get(IAgentService);

		const input = await quickInput.input({
			placeHolder: localize('agent.sendMessage.placeholder', 'Type your message to the agent...'),
			prompt: localize('agent.sendMessage.prompt', 'Agent Message'),
		});

		if (input) {
			await agentService.sendMessage(input);
		}
	}
});

// --- Switch Mode ---
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agent.switchMode',
			title: localize('agent.switchMode', 'Agent: Switch Mode'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const agentService = accessor.get(IAgentService);

		const picks = [
			{ label: 'Agent', description: 'Full autonomy: read, write, edit, run commands', mode: AgentMode.Agent },
			{ label: 'Ask', description: 'Read-only: explore and answer questions', mode: AgentMode.Ask },
			{ label: 'Plan', description: 'Create implementation plans before coding', mode: AgentMode.Plan },
		];

		const selected = await quickInput.pick(picks, {
			placeHolder: localize('agent.switchMode.placeholder', 'Select agent mode'),
		});

		if (selected && 'mode' in selected) {
			agentService.switchMode((selected as typeof picks[0]).mode);
		}
	}
});

// --- Cancel Task ---
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agent.cancelTask',
			title: localize('agent.cancelTask', 'Agent: Cancel Current Task'),
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyI,
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		const agentService = accessor.get(IAgentService);
		agentService.cancelCurrentTask();
	}
});

// --- Create Checkpoint ---
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agent.createCheckpoint',
			title: localize('agent.createCheckpoint', 'Agent: Create Checkpoint'),
			f1: true,
		});
	}

	run(accessor: ServicesAccessor): void {
		const agentService = accessor.get(IAgentService);
		agentService.createCheckpoint();
	}
});

// --- Restore Checkpoint ---
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agent.restoreCheckpoint',
			title: localize('agent.restoreCheckpoint', 'Agent: Restore Checkpoint'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const agentService = accessor.get(IAgentService);

		const checkpoints = agentService.listCheckpoints();
		if (checkpoints.length === 0) {
			return;
		}

		const picks = checkpoints.map(id => ({ label: id }));
		const selected = await quickInput.pick(picks, {
			placeHolder: localize('agent.restoreCheckpoint.placeholder', 'Select checkpoint to restore'),
		});

		if (selected) {
			await agentService.restoreCheckpoint(selected.label);
		}
	}
});

// --- Configure Agent ---
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'agent.configure',
			title: localize('agent.configure', 'Agent: Configure'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const agentService = accessor.get(IAgentService);

		const config = agentService.getConfig();

		const providers = [
			{ label: 'OpenAI', description: config.provider === 'openai' ? '(current)' : '', value: 'openai' as const },
			{ label: 'Anthropic', description: config.provider === 'anthropic' ? '(current)' : '', value: 'anthropic' as const },
			{ label: 'Ollama', description: config.provider === 'ollama' ? '(current)' : '', value: 'ollama' as const },
		];

		const selected = await quickInput.pick(providers, {
			placeHolder: localize('agent.configure.provider', 'Select LLM provider'),
		});

		if (selected && 'value' in selected) {
			agentService.updateConfig({ provider: (selected as typeof providers[0]).value });
		}
	}
});
