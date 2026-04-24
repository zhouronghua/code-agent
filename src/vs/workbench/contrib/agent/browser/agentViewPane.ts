/*---------------------------------------------------------------------------------------------
 *  Agent View Pane - Container for the chat panel in the sidebar
 *--------------------------------------------------------------------------------------------*/

import { IViewPaneOptions, ViewPane } from 'vs/workbench/browser/parts/views/viewPane';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import { IContextMenuService } from 'vs/platform/contextview/browser/contextView';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IOpenerService } from 'vs/platform/opener/common/opener';
import { IThemeService } from 'vs/platform/theme/common/themeService';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IHoverService } from 'vs/platform/hover/browser/hover';
import { AgentChatPanel } from './agentPanel';
import { IAgentService } from 'vs/workbench/services/agent/common/agentService';

export class AgentViewPane extends ViewPane {
	static readonly ID = 'workbench.view.agent';
	static readonly TITLE = 'Agent';

	private _chatPanel: AgentChatPanel | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@ITelemetryService telemetryService: ITelemetryService,
		@IHoverService hoverService: IHoverService,
		@IAgentService private readonly _agentService: IAgentService,
	) {
		super(options, keybindingService, contextMenuService, configurationService,
			contextKeyService, openerService, themeService, telemetryService, hoverService);
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('agent-view-pane');

		this._chatPanel = new AgentChatPanel(container, this._agentService);
		this._register(this._chatPanel);
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this._chatPanel?.layout(height, width);
	}
}
