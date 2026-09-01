/*---------------------------------------------------------------------------------------------
 *  Agent Skills & Rules Loader
 *  Loads Cursor-compatible SKILL.md and .mdc rule files,
 *  then injects their content into the agent's system prompt.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ISkill {
	readonly name: string;
	readonly description: string;
	readonly filePath: string;
	readonly content: string;
	/** Trigger keywords from frontmatter for auto-matching (e.g. ["commit", "jira", "push"]) */
	readonly triggers: string[];
	/** whenToUse guidance from frontmatter (dsh-run2skill canonical contract) */
	readonly whenToUse?: string;
	/** Whether the model may auto-invoke this skill (disable-model-invocation) */
	readonly modelInvocable: boolean;
	/** Whether the user may explicitly invoke this skill (user-invocable) */
	readonly userInvocable: boolean;
}

export interface IRule {
	readonly description: string;
	readonly filePath: string;
	readonly content: string;
	readonly alwaysApply: boolean;
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
	const meta: Record<string, string> = {};
	let body = text;

	if (text.startsWith('---')) {
		const endIdx = text.indexOf('---', 3);
		if (endIdx > 0) {
			const frontmatter = text.substring(3, endIdx).trim();
			body = text.substring(endIdx + 3).trim();

			let currentKey = '';
			for (const line of frontmatter.split('\n')) {
				const trimmed = line.trim();
				// Handle list items: "- value" under a key like "trigger:"
				if (trimmed.startsWith('- ') && currentKey) {
					const itemVal = trimmed.slice(2).trim();
					if (itemVal) {
						const existing = meta[currentKey] || '';
						meta[currentKey] = existing ? existing + '\n' + itemVal : itemVal;
					}
				} else if (trimmed.includes(':') && !trimmed.startsWith('-')) {
					const colonIdx = trimmed.indexOf(':');
					currentKey = trimmed.substring(0, colonIdx).trim();
					let val = trimmed.substring(colonIdx + 1).trim();
					if (val === '>' || val === '|') val = '';
					meta[currentKey] = val;
				} else if (currentKey && trimmed && !trimmed.startsWith('-')) {
					meta[currentKey] = ((meta[currentKey] || '') + ' ' + trimmed).trim();
				}
			}
		}
	}

	return { meta, body };
}

export class SkillsLoader {
	private readonly _skills: ISkill[] = [];
	private readonly _rules: IRule[] = [];

	loadSkillsFromDirs(dirs: string[]): void {
		for (const dir of dirs) {
			if (!fs.existsSync(dir)) continue;
			this._scanForSkills(dir);
		}
	}

	loadRulesFromDirs(dirs: string[]): void {
		for (const dir of dirs) {
			if (!fs.existsSync(dir)) continue;
			this._scanForRules(dir);
		}
	}

	get skills(): readonly ISkill[] { return this._skills; }
	get rules(): readonly IRule[] { return this._rules; }

	getSkillByName(name: string): ISkill | undefined {
		return this._skills.find(s =>
			s.name.toLowerCase() === name.toLowerCase() ||
			s.filePath.toLowerCase().includes(name.toLowerCase())
		);
	}

	getAlwaysApplyRules(): IRule[] {
		return this._rules.filter(r => r.alwaysApply);
	}

	buildSkillsPromptSection(preActivatedSkillNames?: Set<string>): string {
		if (this._skills.length === 0) return '';

		const lines = ['\n## Available Skills\n'];
		lines.push('You can leverage the following specialized skills when relevant:\n');

		for (const skill of this._skills) {
			const isPreActivated = preActivatedSkillNames?.has(skill.name);
			lines.push(`### ${skill.name}`);
			if (skill.description) {
				lines.push(skill.description);
			}
			lines.push(`Path: ${skill.filePath}`);
			// Show trigger keywords so the agent can self-match at runtime
			if (skill.triggers.length > 0) {
				lines.push(`Triggers: ${skill.triggers.join(', ')}`);
			}
			// Show whenToUse guidance (dsh-run2skill canonical contract)
			if (skill.whenToUse) {
				lines.push(`When to use: ${skill.whenToUse}`);
			}
			if (!skill.modelInvocable) {
				lines.push('Invocation: manual only (not auto-activated)');
			}

			// If this skill was auto-matched, include its FULL content so the
			// agent can follow its instructions without needing explicit /skill activation.
			if (isPreActivated) {
				lines.push('');
				lines.push('> **This skill has been auto-activated based on your task.**');
				lines.push('> Follow the instructions below as mandatory guidance.');
				lines.push('');
				lines.push(skill.content);
			}

			lines.push('');
		}

		return lines.join('\n');
	}

	buildRulesPromptSection(excludePatterns?: string[]): string {
		let alwaysRules = this.getAlwaysApplyRules();

		if (excludePatterns && excludePatterns.length > 0) {
			alwaysRules = alwaysRules.filter(r => {
				const lowerDesc = r.description.toLowerCase();
				const lowerContent = r.content.toLowerCase();
				return !excludePatterns.some(p =>
					lowerDesc.includes(p.toLowerCase()) || lowerContent.includes(p.toLowerCase())
				);
			});
		}

		if (alwaysRules.length === 0) return '';

		const lines = ['\n## Active Rules\n'];
		for (const rule of alwaysRules) {
			lines.push(rule.content);
			lines.push('');
		}

		return lines.join('\n');
	}

	/**
	 * Preload ALL global rules content into the system prompt at task startup.
	 * Each rule includes its description so the agent can auto-match when a
	 * user's prompt aligns with a rule's purpose. Unlike buildRulesPromptSection()
	 * which only includes alwaysApply rules, this method loads EVERY rule so
	 * the agent can dynamically activate the right one.
	 */
	buildPreloadRulesPromptSection(excludePatterns?: string[]): string {
		let rules = [...this._rules];

		if (excludePatterns && excludePatterns.length > 0) {
			rules = rules.filter(r => {
				const lowerDesc = r.description.toLowerCase();
				const lowerContent = r.content.toLowerCase();
				return !excludePatterns.some(p =>
					lowerDesc.includes(p.toLowerCase()) || lowerContent.includes(p.toLowerCase())
				);
			});
		}

		if (rules.length === 0) return '';

		const lines = ['\n## Preloaded Rules\n'];
		lines.push('The following rules are preloaded for auto-matching. When the user\'s request matches a rule\'s description, automatically apply that rule\'s instructions:\n');

		for (const rule of rules) {
			lines.push(`### Rule: ${rule.description}`);
			if (rule.alwaysApply) {
				lines.push('(Always Active)');
			}
			lines.push(rule.content);
			lines.push('');
		}

		return lines.join('\n');
	}

	getSkillContent(skillName: string): string | undefined {
		const skill = this.getSkillByName(skillName);
		return skill?.content;
	}

	/**
	 * Auto-match skills against the user's task description using keyword matching.
	 *
	 * Matching strategy (in priority order):
	 * 1. Exact trigger keyword match in the task (strongest signal)
	 * 2. Description keyword overlap with the task
	 * 3. Skill name mentioned in the task
	 *
	 * Returns a Set of skill names that should be pre-activated.
	 *
	 * @param taskDescription - The user's task/query to match against
	 * @param maxSkills - Maximum number of skills to auto-activate (default: 5, to avoid context bloat)
	 */
	getAutoMatchedSkills(taskDescription: string, maxSkills: number = 5): Set<string> {
		if (!taskDescription || this._skills.length === 0) return new Set();

		const lowerTask = taskDescription.toLowerCase();
		const scored: { name: string; score: number }[] = [];

		for (const skill of this._skills) {
			let score = 0;

			// 1. Trigger keyword exact match (highest weight: 10 per match)
			for (const trigger of skill.triggers) {
				const lowerTrigger = trigger.toLowerCase();
				if (lowerTask.includes(lowerTrigger)) {
					score += 10;
				}
			}

			// 2. Skill name mentioned in task (weight: 15)
			if (lowerTask.includes(skill.name.toLowerCase())) {
				score += 15;
			}

			// 3. Description word overlap with task (weight: 2 per common significant word)
			if (skill.description) {
				const descWords = new Set(
					skill.description.toLowerCase()
						.split(/[\s,，、;；:：\n\t]+/)
						.filter(w => w.length >= 2)
				);
				const taskWords = new Set(
					lowerTask.split(/[\s,，、;；:：\n\t]+/).filter(w => w.length >= 2)
				);
				for (const w of descWords) {
					if (taskWords.has(w)) score += 2;
				}
				// Bonus for partial matches (e.g. "提交" in description, "提交代码" in task)
				for (const dw of descWords) {
					if (dw.length >= 2) {
						for (const tw of taskWords) {
							if (tw.length >= 2 && (tw.includes(dw) || dw.includes(tw))) {
								score += 1;
								break; // one bonus per desc word
							}
						}
					}
				}
			}

			if (score > 0) {
				scored.push({ name: skill.name, score });
			}
		}

		// Sort by score descending, take top N
		scored.sort((a, b) => b.score - a.score);
		const result = new Set<string>();
		for (const s of scored.slice(0, maxSkills)) {
			result.add(s.name);
		}
		return result;
	}

	/**
	 * Build the "Skills of Skills" (meta-skill) prompt section.
	 *
	 * This ports dsh-run2skill's skill packaging logic into a prompt contract so
	 * the agent itself can create, catalog, recall and publish well-formed skills:
	 *
	 *   - Canonical SKILL.md contract (renderCanonicalSkill / validateSkillProposal)
	 *   - Dedup/recall before CREATE (recallExistingSkills → COVERED/PARTIAL/UNRELATED)
	 *   - Publication location (first configured skills dir)
	 *
	 * The matching tool implementations live in agentSkillFactory.ts and
	 * tools/skillTools.ts (skill_catalog / create_skill / update_skill).
	 */
	buildMetaSkillPromptSection(skillsDirs: string[]): string {
		const primaryDir = skillsDirs[0] || '~/.codeagent/skills';
		return `\n## Skill Crafting (Meta-Skill: skills of skills)
You manage your own reusable skill library. Skills are Cursor-compatible \`SKILL.md\` files loaded from: ${skillsDirs.join(', ') || '~/.codeagent/skills'} (primary: ${primaryDir}).

### When to create or update a skill
- The user explicitly asks to save a workflow/constraint as a reusable skill ("保存为skill", "save this as a skill").
- You notice the same reusable workflow, constraint, or correction appearing across tasks.

### Canonical SKILL.md contract (MUST follow — use the create_skill / update_skill tools)
- Frontmatter fields: \`name\` (lowercase-kebab-case, e.g. \`cpp-forge\`), \`description\` (one or two sentences, what + when), optional \`whenToUse\` (situations it applies to), optional \`trigger:\` keyword list for auto-matching, \`disable-model-invocation\` and \`user-invocable\` flags.
- Body: complete, executable Markdown that MUST start with a heading (\`# ...\`). Keep it focused and under 60 KB.
- Write description/whenToUse/content in the user's working language (Simplified Chinese by default); keep code, commands and identifiers unchanged.

### Dedup before creating (CRITICAL)
1. Call \`skill_catalog\` with a query describing the new capability BEFORE \`create_skill\`.
2. If recall says \`COVERED\` — do NOT create a duplicate; prefer \`update_skill\` to extend the existing skill.
3. If recall says \`PARTIAL\` — extend the existing skill via \`update_skill\` (merge), or create only when the workflows are materially different.
4. If recall says \`UNRELATED\` and no same-name skill exists — safe to \`create_skill\`.

### Publication
- New skills are published to \`{primaryDir}/{name}/SKILL.md\`. Never overwrite an existing skill unless the user approves (or pass \`force: true\` after confirmation).
- After creating/updating a skill, tell the user the file path and that a new session (or \`/skills\`) will pick it up.`;
	}

	/**
	 * Build full context prompt with all rules and skills.
	 * Optionally accepts a task description for auto-matching skills.
	 */
	buildFullContextPrompt(taskDescription?: string, excludeRulePatterns?: string[], skillsDirs?: string[]): string {
		let prompt = '';

		// Preload ALL rules content (not just alwaysApply) for auto-matching
		const rulesSection = this.buildPreloadRulesPromptSection(excludeRulePatterns);
		if (rulesSection) prompt += rulesSection;

		// Auto-match skills based on task description
		let preActivatedSkills: Set<string> | undefined;
		if (taskDescription) {
			preActivatedSkills = this.getAutoMatchedSkills(taskDescription);
		}

		// Preload skills headers for auto-matching (with triggers shown)
		const skillsSection = this.buildSkillsPromptSection(preActivatedSkills);
		if (skillsSection) prompt += skillsSection;

		// "Skills of skills": teach the agent how to package its own skills
		if (skillsDirs && skillsDirs.length > 0) {
			prompt += this.buildMetaSkillPromptSection(skillsDirs);
		}

		return prompt;
	}

	private _scanForSkills(dir: string): void {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					const skillFile = path.join(fullPath, 'SKILL.md');
					if (fs.existsSync(skillFile)) {
						this._loadSkill(skillFile, entry.name);
					}
				} else if (entry.name === 'SKILL.md') {
					this._loadSkill(fullPath, path.basename(dir));
				}
			}
		} catch {
			// skip unreadable dirs
		}
	}

	private _loadSkill(filePath: string, fallbackName: string): void {
		try {
			const raw = fs.readFileSync(filePath, 'utf-8');
			const { meta, body } = parseFrontmatter(raw);

			// Parse trigger keywords (newline-separated list)
			const triggers = meta.trigger
				? meta.trigger.split('\n').map(t => t.trim()).filter(t => t.length > 0)
				: [];

			// Parse canonical metadata (dsh-run2skill contract: whenToUse, invocation flags)
			const whenToUse = meta.whenToUse?.trim() || undefined;
			const modelInvocable = meta['disable-model-invocation'] !== 'true';
			const userInvocable = meta['user-invocable'] === 'true';

			this._skills.push({
				name: meta.name || fallbackName,
				description: meta.description || '',
				filePath,
				content: body,
				triggers,
				...(whenToUse ? { whenToUse } : {}),
				modelInvocable,
				userInvocable,
			});
		} catch {
			// skip unreadable files
		}
	}

	private _scanForRules(dir: string): void {
		try {
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith('.mdc')) {
					this._loadRule(path.join(dir, entry.name));
				}
			}
		} catch {
			// skip
		}
	}

	private _loadRule(filePath: string): void {
		try {
			const raw = fs.readFileSync(filePath, 'utf-8');
			const { meta, body } = parseFrontmatter(raw);

			this._rules.push({
				description: meta.description || path.basename(filePath, '.mdc'),
				filePath,
				content: body,
				alwaysApply: meta.alwaysApply === 'true',
			});
		} catch {
			// skip
		}
	}
}
