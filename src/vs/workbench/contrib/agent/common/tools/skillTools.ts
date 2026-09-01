/*---------------------------------------------------------------------------------------------
 *  Skill management tools - "Skills of Skills" (meta-skill) tools
 *
 *  These tools let the agent itself create, update and inspect its skill library,
 *  using the canonical SKILL.md packaging logic ported from dsh-run2skill
 *  (see agentSkillFactory.ts):
 *
 *    - skill_catalog  : snapshot every skill (with optional fuzzy recall ranking)
 *    - create_skill   : render + publish a canonical SKILL.md (with dedup check)
 *    - update_skill   : merge changes into an existing skill and re-publish
 *--------------------------------------------------------------------------------------------*/

import { IToolResult } from 'vs/workbench/services/agent/common/agentModels';
import { AgentTool } from '../agentTools';
import {
	readSkillDefinition,
	recallExistingSkills,
	renderCanonicalSkill,
	scanSkillCatalog,
	publishSkill,
	SkillFactoryError,
	SkillProposal,
	SkillCatalogSnapshot,
} from '../agentSkillFactory';

/** Shared snapshot helper used by all skill tools. */
export function buildSkillCatalogSnapshot(skillsDirs: string[]): SkillCatalogSnapshot {
	return scanSkillCatalog(skillsDirs);
}

function formatCatalogEntry(entry: { name: string; description: string; whenToUse?: string; triggers: string[]; path?: string; modelInvocable: boolean; userInvocable: boolean }, index?: number): string {
	const lines: string[] = [];
	const header = index !== undefined ? `${index}. ` : '';
	lines.push(`${header}${entry.name} - ${entry.description}`);
	if (entry.whenToUse) lines.push(`   whenToUse: ${entry.whenToUse}`);
	if (entry.triggers.length > 0) lines.push(`   triggers: ${entry.triggers.join(', ')}`);
	if (entry.path) lines.push(`   path: ${entry.path}`);
	lines.push(`   invocation: ${entry.modelInvocable ? 'model-invocable' : 'manual'}${entry.userInvocable ? ' / user-invocable' : ''}`);
	return lines.join('\n');
}

export class SkillCatalogTool extends AgentTool {
	readonly name = 'skill_catalog';
	readonly description = 'List all available skills (name, description, whenToUse, triggers, path). Pass an optional query to fuzzy-match (recall) existing skills ranked by relevance — use this BEFORE create_skill to avoid duplicates.';
	readonly parameters = {
		type: 'object',
		properties: {
			query: {
				type: 'string',
				description: 'Optional capability/task description used to rank existing skills by relevance (dedup/reuse check)',
			},
		},
		required: [],
	};

	constructor(private readonly _skillsDirs: string[]) {
		super();
	}

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = args._toolCallId as string || '';
		if (signal?.aborted) {
			return this.failure(toolCallId, 'Tool execution cancelled by user');
		}

		const snapshot = buildSkillCatalogSnapshot(this._skillsDirs);
		const query = (args.query as string | undefined)?.trim();

		if (!query) {
			if (snapshot.skills.length === 0) {
				return this.success(toolCallId, 'No skills found. Configure skills directories in config.yaml.');
			}
			const body = [`Skills catalog (${snapshot.skills.length}):`, '']
				.concat(snapshot.skills.map((s, i) => formatCatalogEntry(s, i + 1)))
				.join('\n');
			return this.success(toolCallId, body);
		}

		const recall = recallExistingSkills(snapshot, query);
		if (recall.candidates.length === 0) {
			return this.success(toolCallId, `No existing skills match "${query}". Safe to CREATE a new skill.`);
		}
		const body = [
			`Recall for "${query}" → ${recall.classification} (closest: ${recall.closest?.entry.name ?? 'none'}):`,
			'',
			...recall.candidates.map((c, i) => formatCatalogEntry(c.entry, i + 1).concat(`\n   match: name=${c.nameOverlap} whenToUse=${c.whenToUseOverlap} desc=${c.descriptionOverlap}`)),
			'',
			recall.classification === 'COVERED'
				? 'Heuristic: an existing skill already covers this capability — prefer UPDATE/MERGE instead of CREATE.'
				: recall.classification === 'PARTIAL'
					? 'Heuristic: an existing skill partially covers this — consider UPDATE/MERGE with the new behavior.'
					: 'Heuristic: overlap is weak — a new skill may be justified.',
		].join('\n');
		return this.success(toolCallId, body);
	}
}

export class CreateSkillTool extends AgentTool {
	readonly name = 'create_skill';
	readonly description = 'Create a reusable skill: validates the canonical SKILL.md contract (lowercase-kebab-case name, description, whenToUse, content starting with a heading), runs a dedup recall against existing skills, and publishes {skillsDir}/{name}/SKILL.md. Use skill_catalog first to check for duplicates.';
	readonly parameters = {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Skill name in lowercase-kebab-case (e.g. "cpp-forge")',
			},
			description: {
				type: 'string',
				description: 'One or two sentences: what the skill does and when to use it',
			},
			content: {
				type: 'string',
				description: 'Complete Markdown body. MUST start with a heading (# ...) and contain executable instructions',
			},
			whenToUse: {
				type: 'string',
				description: 'Optional: situations the skill applies to (shown to the agent for self-matching)',
			},
			triggers: {
				type: 'array',
				items: { type: 'string' },
				description: 'Optional trigger keywords for auto-matching (e.g. ["commit", "jira"])',
			},
			force: {
				type: 'boolean',
				description: 'Overwrite an existing skill with the same name. Default: false (refuses on conflict).',
			},
		},
		required: ['name', 'description', 'content'],
	};

	constructor(
		private readonly _skillsDirs: string[],
	) {
		super();
	}

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = args._toolCallId as string || '';
		if (signal?.aborted) {
			return this.failure(toolCallId, 'Tool execution cancelled by user');
		}

		const proposal: SkillProposal = {
			name: (args.name as string || '').trim(),
			description: (args.description as string || '').trim(),
			...(args.whenToUse ? { whenToUse: (args.whenToUse as string).trim() } : {}),
			content: (args.content as string || ''),
			...(Array.isArray(args.triggers) ? { triggers: (args.triggers as string[]).map(t => String(t)) } : {}),
		};
		const force = args.force === true;

		// 1. Canonical contract validation (mirrors dsh-run2skill generation schema)
		try {
			renderCanonicalSkill(proposal);
		} catch (err) {
			return this.failure(toolCallId, `Invalid skill: ${(err as SkillFactoryError).message}`);
		}

		// 2. Dedup recall before publishing (mirrors dsh-run2skill recall + coverage)
		const snapshot = buildSkillCatalogSnapshot(this._skillsDirs);
		const recall = recallExistingSkills(snapshot, `${proposal.name} ${proposal.description} ${proposal.whenToUse ?? ''}`.trim());
		const existing = snapshot.skills.find(s => s.name.toLowerCase() === proposal.name.toLowerCase());
		if (existing && !force) {
			return this.failure(toolCallId,
				`Skill "${proposal.name}" already exists at ${existing.path}. Use update_skill to modify it, or pass force: true to overwrite.`);
		}

		// 3. Publish
		const result = publishSkill(this._skillsDirs[0], proposal, { force: force || undefined });
		if (result.status === 'UNSUPPORTED') {
			return this.failure(toolCallId, 'No skills directory configured — add "skills:" to config.yaml');
		}

		const dedupNote = (recall.closest && recall.classification !== 'UNRELATED')
			? `\nNote: recall found "${recall.closest.entry.name}" (${recall.classification}) — consider whether this new skill should instead extend it.`
			: '';

		return this.success(toolCallId,
			`Skill "${proposal.name}" ${result.status === 'UPDATED' ? 'updated' : 'created'} at ${result.targetPath} (${renderCanonicalSkill(proposal).length} bytes).${dedupNote}`);
	}
}

export class UpdateSkillTool extends AgentTool {
	readonly name = 'update_skill';
	readonly description = 'Update an existing skill: loads the current SKILL.md, merges the provided fields, re-renders it in the canonical format and publishes it back. Fields not provided are kept unchanged.';
	readonly parameters = {
		type: 'object',
		properties: {
			name: {
				type: 'string',
				description: 'Name of the existing skill to update (lowercase-kebab-case)',
			},
			description: {
				type: 'string',
				description: 'Optional new description',
			},
			content: {
				type: 'string',
				description: 'Optional complete new Markdown body (must start with a heading)',
			},
			whenToUse: {
				type: 'string',
				description: 'Optional new whenToUse',
			},
			triggers: {
				type: 'array',
				items: { type: 'string' },
				description: 'Optional new trigger keywords',
			},
		},
		required: ['name'],
	};

	constructor(
		private readonly _skillsDirs: string[],
	) {
		super();
	}

	async execute(args: Record<string, unknown>, signal?: AbortSignal): Promise<IToolResult> {
		const toolCallId = args._toolCallId as string || '';
		if (signal?.aborted) {
			return this.failure(toolCallId, 'Tool execution cancelled by user');
		}

		const name = (args.name as string || '').trim();
		if (!name) {
			return this.failure(toolCallId, 'Missing skill name');
		}

		// 1. Load the existing skill
		const snapshot = buildSkillCatalogSnapshot(this._skillsDirs);
		const existing = snapshot.skills.find(s => s.name.toLowerCase() === name.toLowerCase());
		if (!existing) {
			return this.failure(toolCallId,
				`Skill "${name}" not found. Use skill_catalog to list skills, or create_skill to create it.`);
		}
		const definition = readSkillDefinition(existing);
		if (!definition) {
			return this.failure(toolCallId, `Failed to read skill "${name}" at ${existing.path}`);
		}

		// 2. Merge changes
		const merged: SkillProposal = {
			name: existing.name,
			description: (args.description as string | undefined)?.trim() ?? definition.proposal.description,
			...(args.whenToUse !== undefined
				? { whenToUse: (args.whenToUse as string).trim() }
				: definition.proposal.whenToUse
					? { whenToUse: definition.proposal.whenToUse }
					: {}),
			content: (args.content as string | undefined) ?? definition.proposal.content,
			triggers: Array.isArray(args.triggers)
				? (args.triggers as string[]).map(t => String(t))
				: definition.proposal.triggers,
			modelInvocable: definition.proposal.modelInvocable,
			userInvocable: definition.proposal.userInvocable,
		};

		// 3. Validate + publish (force because the skill already exists)
		const result = publishSkill(this._skillsDirs[0], merged, { force: true });
		if (result.status === 'UNSUPPORTED') {
			return this.failure(toolCallId, 'No skills directory configured — add "skills:" to config.yaml');
		}

		return this.success(toolCallId,
			`Skill "${name}" updated at ${result.targetPath} (${renderCanonicalSkill(merged).length} bytes). Reload the session to pick up the new content.`);
	}
}
