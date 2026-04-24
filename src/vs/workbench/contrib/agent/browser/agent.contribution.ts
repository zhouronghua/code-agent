/*---------------------------------------------------------------------------------------------
 *  Agent Contribution Entry Point
 *  This file is imported from workbench.common.main.ts to register the agent module
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { Disposable } from 'vs/base/common/lifecycle';
import { Registry } from 'vs/platform/registry/common/platform';
import {
	Extensions as ViewExtensions,
	IViewsRegistry,
	IViewContainersRegistry,
	ViewContainerLocation,
} from 'vs/workbench/common/views';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { registerWorkbenchContribution2, WorkbenchPhase } from 'vs/workbench/common/contributions';
import { IWorkbenchContribution } from 'vs/workbench/common/contributions';
import { ViewPaneContainer } from 'vs/workbench/browser/parts/views/viewPane';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { AgentViewPane } from './agentViewPane';
import { Codicon } from 'vs/base/common/codicons';

// Import service registration (side-effect: calls registerSingleton)
import 'vs/workbench/services/agent/browser/agentService';

// Import actions (side-effect: registers commands and keybindings)
import './agentActions';

// --- Register View Container ---
const VIEW_CONTAINER_ID = 'workbench.view.agentContainer';

const viewContainerRegistry = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewContainer = viewContainerRegistry.registerViewContainer(
	{
		id: VIEW_CONTAINER_ID,
		title: localize('agent', 'Agent'),
		icon: Codicon.hubot,
		order: 10,
		ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [VIEW_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
		storageId: `${VIEW_CONTAINER_ID}.state`,
		hideIfEmpty: false,
	},
	ViewContainerLocation.AuxiliaryBar,
	{ isDefault: false },
);

// --- Register View ---
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);
viewsRegistry.registerViews([
	{
		id: AgentViewPane.ID,
		name: localize('agentView', 'Agent'),
		ctorDescriptor: new SyncDescriptor(AgentViewPane),
		containerIcon: Codicon.hubot,
		canToggleVisibility: true,
		canMoveView: true,
		order: 0,
	},
], viewContainer);

// --- Workbench Contribution ---
class AgentContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.agent';

	constructor(
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
	) {
		super();
	}
}

registerWorkbenchContribution2(
	AgentContribution.ID,
	AgentContribution,
	WorkbenchPhase.AfterRestored,
);
