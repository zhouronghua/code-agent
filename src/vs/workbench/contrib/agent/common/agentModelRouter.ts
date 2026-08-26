/*---------------------------------------------------------------------------------------------
 *  Model Router - Scenario-based automatic model selection & switching
 *
 *  Detects the "scenario" of a user prompt and maps it to a configured model so
 *  a single session can transparently switch between multiple models:
 *
 *    - vision    → image/screenshot/visual understanding tasks
 *    - reasoning → complex refactor/debug/architecture tasks
 *    - fast      → everything else (simple, quick tasks)
 *
 *  Scenario → model mapping comes from config.yaml `model_routing.scenarios`,
 *  with an optional `default` fallback and the active profile as the final fallback.
 *--------------------------------------------------------------------------------------------*/

import { IAgentConfig } from 'vs/workbench/services/agent/common/agentModels';
import { ModelRoutingConfig } from './agentConfig';

// Visual/vision indicators — route to a vision-capable model when present.
const VISION_KEYWORDS = [
	'图片', '图像', '截图', '看图', '识图', '照片', '画面', '视觉',
	'screenshot', 'image', 'picture', 'photo', 'vision', 'ocr', 'ui图', 'ui截图',
];

// Complex-task indicators — route to a reasoning-capable model when present.
// Mirrors AgentLoop's COMPLEX_TASK_KEYWORDS so routing and deep-thinking stay aligned.
const REASONING_KEYWORDS = [
	'refactor', '重构', 'migrate', '迁移', 'implement', '实现',
	'redesign', '重新设计', 'complex', '复杂', 'multiple files',
	'architecture', '架构', 'performance', '性能', 'debug', '调试',
	'optimize', '优化', 'overhaul', 'rewrite', '重写', 'refactoring',
];

export class ModelRouter {
	constructor(
		private readonly _routing: ModelRoutingConfig,
		private readonly _profiles: Record<string, IAgentConfig>,
		private readonly _fallback: IAgentConfig,
	) { }

	get enabled(): boolean {
		return this._routing.enabled;
	}

	get scenarios(): Record<string, string> {
		return this._routing.scenarios || {};
	}

	/**
	 * Detect the scenario of a prompt. Returns one of the built-in scenario keys:
	 * 'vision' | 'reasoning' | 'fast'.
	 */
	detectScenario(prompt: string): string {
		const lower = prompt.toLowerCase();
		if (VISION_KEYWORDS.some(k => lower.includes(k.toLowerCase()))) {
			return 'vision';
		}
		if (REASONING_KEYWORDS.some(k => lower.includes(k.toLowerCase()))) {
			return 'reasoning';
		}
		return 'fast';
	}

	/**
	 * Resolve a model id / profile name to a full config. Matches by profile key
	 * first, then by the profile's `model` value as a convenience.
	 */
	resolveModel(modelId: string | undefined): IAgentConfig | undefined {
		if (!modelId) return undefined;
		if (this._profiles[modelId]) return this._profiles[modelId];
		for (const p of Object.values(this._profiles)) {
			if (p.model === modelId) return p;
		}
		return undefined;
	}

	/**
	 * Select the model config for a prompt. Falls back through:
	 * scenario model → default model → active profile config.
	 */
	selectConfig(prompt: string): IAgentConfig {
		if (!this.enabled) return this._fallback;

		const scenario = this.detectScenario(prompt);
		const modelId = this._routing.scenarios?.[scenario] ?? this._routing.defaultModel;
		return this.resolveModel(modelId) ?? this._fallback;
	}

	/** Returns the scenario and selected model name for a prompt (used for logging). */
	describe(prompt: string): { scenario: string; model: string } {
		const scenario = this.detectScenario(prompt);
		const config = this.selectConfig(prompt);
		return { scenario, model: config.model };
	}
}
