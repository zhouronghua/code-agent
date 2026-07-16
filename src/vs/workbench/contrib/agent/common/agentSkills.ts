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
				if (trimmed.includes(':') && !trimmed.startsWith('-')) {
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

	buildSkillsPromptSection(): string {
		if (this._skills.length === 0) return '';

		const lines = ['\n## Available Skills\n'];
		lines.push('You can leverage the following specialized skills when relevant:\n');

		for (const skill of this._skills) {
			lines.push(`### ${skill.name}`);
			if (skill.description) {
				lines.push(skill.description);
			}
			// Expose the skill file path so the agent can read full content on demand
			lines.push(`Path: ${skill.filePath}`);
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

	buildFullContextPrompt(excludeRulePatterns?: string[]): string {
		let prompt = '';

		// Preload ALL rules content (not just alwaysApply) for auto-matching
		const rulesSection = this.buildPreloadRulesPromptSection(excludeRulePatterns);
		if (rulesSection) prompt += rulesSection;

		// Preload skills titles for auto-matching
		const skillsSection = this.buildSkillsPromptSection();
		if (skillsSection) prompt += skillsSection;

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

			this._skills.push({
				name: meta.name || fallbackName,
				description: meta.description || '',
				filePath,
				content: body,
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
