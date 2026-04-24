/*---------------------------------------------------------------------------------------------
 *  Agent Planner - Task decomposition and structured plan generation
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from 'vs/base/common/event';
import {
	IAgentPlan,
	IAgentStep,
	StepStatus,
	MessageRole,
	createMessage,
} from 'vs/workbench/services/agent/common/agentModels';
import { ILLMProvider } from 'vs/workbench/services/agent/browser/llmProvider';

const PLAN_GENERATION_PROMPT = `Given the user's task, create a structured implementation plan as JSON.

Output format (strict JSON, no markdown):
{
  "task": "brief task summary",
  "steps": [
    {
      "id": 1,
      "description": "what to do in this step",
      "toolName": "tool to use (read_file, write_file, edit_file, search_text, run_terminal, etc.) or null",
      "toolArgs": { "key": "value" }
    }
  ]
}

Rules:
- Break complex tasks into 3-15 concrete steps
- Each step should be a single, verifiable action
- Start with exploration (read/search), then implement, then verify
- Include a final verification step (run tests or check output)`;

export class AgentPlanner {
	private _currentPlan: IAgentPlan | undefined;

	private readonly _onDidUpdatePlan = new Emitter<IAgentPlan>();
	readonly onDidUpdatePlan: Event<IAgentPlan> = this._onDidUpdatePlan.event;

	constructor(private _llmProvider: ILLMProvider) { }

	swapProvider(provider: ILLMProvider): void {
		this._llmProvider = provider;
	}

	get currentPlan(): IAgentPlan | undefined {
		return this._currentPlan;
	}

	async createPlan(task: string, codebaseContext?: string): Promise<IAgentPlan> {
		const messages = [
			createMessage(MessageRole.System, PLAN_GENERATION_PROMPT),
		];

		if (codebaseContext) {
			messages.push(createMessage(MessageRole.User,
				`Codebase context:\n${codebaseContext}\n\nTask: ${task}`
			));
		} else {
			messages.push(createMessage(MessageRole.User, `Task: ${task}`));
		}

		const response = await this._llmProvider.complete(messages);

		try {
			const jsonMatch = response.content.match(/\{[\s\S]*\}/);
			if (!jsonMatch) {
				throw new Error('No JSON found in response');
			}

			const parsed = JSON.parse(jsonMatch[0]);
			const steps: IAgentStep[] = parsed.steps.map((s: any, i: number) => ({
				id: s.id || i + 1,
				description: s.description,
				status: StepStatus.Pending,
				toolName: s.toolName || undefined,
				toolArgs: s.toolArgs || undefined,
			}));

			this._currentPlan = {
				task: parsed.task || task,
				steps,
				currentStep: 0,
			};

			this._onDidUpdatePlan.fire(this._currentPlan);
			return this._currentPlan;
		} catch (err) {
			this._currentPlan = {
				task,
				steps: [{
					id: 1,
					description: `Execute task directly: ${task}`,
					status: StepStatus.Pending,
				}],
				currentStep: 0,
			};

			this._onDidUpdatePlan.fire(this._currentPlan);
			return this._currentPlan;
		}
	}

	advanceStep(): IAgentStep | undefined {
		if (!this._currentPlan) {
			return undefined;
		}

		const plan = this._currentPlan;

		if (plan.currentStep > 0) {
			const prevStep = plan.steps[plan.currentStep - 1];
			if (prevStep && prevStep.status === StepStatus.Running) {
				prevStep.status = StepStatus.Done;
			}
		}

		if (plan.currentStep >= plan.steps.length) {
			return undefined;
		}

		const step = plan.steps[plan.currentStep];
		step.status = StepStatus.Running;
		plan.currentStep++;

		this._onDidUpdatePlan.fire(plan);
		return step;
	}

	markStepFailed(stepId: number, error: string): void {
		if (!this._currentPlan) { return; }

		const step = this._currentPlan.steps.find(s => s.id === stepId);
		if (step) {
			step.status = StepStatus.Failed;
			step.result = error;
			this._onDidUpdatePlan.fire(this._currentPlan);
		}
	}

	markStepDone(stepId: number, result: string): void {
		if (!this._currentPlan) { return; }

		const step = this._currentPlan.steps.find(s => s.id === stepId);
		if (step) {
			step.status = StepStatus.Done;
			step.result = result;
			this._onDidUpdatePlan.fire(this._currentPlan);
		}
	}

	isComplete(): boolean {
		if (!this._currentPlan) { return true; }
		return this._currentPlan.currentStep >= this._currentPlan.steps.length;
	}

	reset(): void {
		this._currentPlan = undefined;
	}

	dispose(): void {
		this._onDidUpdatePlan.dispose();
	}
}
