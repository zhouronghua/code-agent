/*---------------------------------------------------------------------------------------------
 *  Agent Skill Factory - "Skills of Skills" (meta-skill) packaging logic
 *
 *  Ports the skill packaging logic from dsh-run2skill (turn session experience into
 *  reviewable native Skills) so the agent itself can create, catalog, recall and
 *  publish well-formed Cursor-compatible SKILL.md skills:
 *
 *    1. renderCanonicalSkill()   - canonical SKILL.md renderer (frontmatter + body)
 *    2. parseSkillMetadata()     - parse full metadata from a SKILL.md file
 *    3. scanSkillCatalog()       - snapshot every skill across the configured dirs
 *    4. recallExistingSkills()   - tokenize + score candidates (dedup / reuse)
 *    5. publishSkill()           - write a canonical skill to the skills directory
 *
 *  The name/description/whenToUse/invocation contract mirrors dsh-run2skill's
 *  `skill-renderer.ts` and `skill-catalog.ts`; the recall scoring mirrors its
 *  `skill-recall.ts` (Latin word tokens + Chinese bigrams).
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** Canonical skill input - same contract as dsh-run2skill CanonicalSkillInput. */
export interface SkillProposal {
	/** lowercase-kebab-case identifier, e.g. "cpp-forge" */
	readonly name: string;
	/** One or two sentences describing what the skill does and when to invoke it. */
	readonly description: string;
	/** Optional guidance describing the situations the skill applies to. */
	readonly whenToUse?: string;
	/** Complete Markdown body. MUST start with a heading (like dsh-run2skill). */
	readonly content: string;
	/** Trigger keywords used by code-agent auto-matching (e.g. ["commit", "jira"]). */
	readonly triggers?: string[];
	/** Whether the model may auto-invoke this skill. Default: true. */
	readonly modelInvocable?: boolean;
	/** Whether the user may invoke this skill explicitly. Default: false. */
	readonly userInvocable?: boolean;
}

/** Catalog summary projection - mirrors dsh-run2skill SkillSummaryProjection. */
export interface SkillCatalogEntry {
	readonly name: string;
	readonly description: string;
	readonly whenToUse?: string;
	readonly triggers: string[];
	readonly source: string;
	readonly provider: string;
	readonly path?: string;
	readonly modelInvocable: boolean;
	readonly userInvocable: boolean;
}

export interface SkillCatalogSnapshot {
	readonly skills: SkillCatalogEntry[];
	readonly complete: boolean;
}

/** Ranked recall candidate - mirrors dsh-run2skill ScoredCandidate. */
export interface SkillRecallCandidate {
	readonly entry: SkillCatalogEntry;
	/** name overlap tokens */
	readonly nameOverlap: number;
	/** whenToUse overlap tokens */
	readonly whenToUseOverlap: number;
	/** description overlap tokens */
	readonly descriptionOverlap: number;
	readonly totalScore: number;
}

export type SkillRecallClassification = 'COVERED' | 'PARTIAL' | 'UNRELATED';

export interface SkillRecallResult {
	readonly queryTokens: string[];
	readonly candidates: SkillRecallCandidate[];
	/** Heuristic dedup hint for the top candidate (mirrors run2skill COVERAGE stage). */
	readonly classification: SkillRecallClassification;
	readonly closest: SkillRecallCandidate | undefined;
}

export type SkillPublishResult =
	| { readonly status: 'CREATED'; readonly targetPath: string }
	| { readonly status: 'UPDATED'; readonly targetPath: string }
	| { readonly status: 'EXISTS'; readonly targetPath: string }
	| { readonly status: 'UNSUPPORTED'; readonly failureCode: 'NO_SKILLS_DIR' };

export class SkillFactoryError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = 'SkillFactoryError';
	}
}

// ---- Formatting contract (dsh-run2skill generationOutputSchema) ----
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MARKDOWN_HEADING = /^#{1,6}\s+\S/m;
const MAX_DESCRIPTION_BYTES = 2 * 1024;
const MAX_WHEN_TO_USE_BYTES = 4 * 1024;
const MAX_CONTENT_BYTES = 60 * 1024;
const MAX_TRIGGERS = 24;

function utf8Bytes(value: string): number {
	return Buffer.byteLength(value, 'utf8');
}

function normalizeNewlines(value: string): string {
	return value.replace(/\r\n?/g, '\n');
}

/** Validates a proposal against the canonical contract; throws SkillFactoryError. */
export function validateSkillProposal(proposal: SkillProposal): void {
	if (!proposal.name || !NAME_PATTERN.test(proposal.name)) {
		throw new SkillFactoryError(
			'INVALID_NAME',
			`Skill name must match lowercase-kebab-case (e.g. "cpp-forge"), got: "${proposal.name}"`,
		);
	}
	const description = normalizeNewlines(proposal.description || '').trim();
	if (description.length === 0) {
		throw new SkillFactoryError('INVALID_DESCRIPTION', 'Skill description is required');
	}
	if (utf8Bytes(description) > MAX_DESCRIPTION_BYTES) {
		throw new SkillFactoryError('INVALID_DESCRIPTION', `Skill description exceeds ${MAX_DESCRIPTION_BYTES} UTF-8 bytes`);
	}
	if (proposal.whenToUse !== undefined && utf8Bytes(proposal.whenToUse) > MAX_WHEN_TO_USE_BYTES) {
		throw new SkillFactoryError('INVALID_WHEN_TO_USE', `Skill whenToUse exceeds ${MAX_WHEN_TO_USE_BYTES} UTF-8 bytes`);
	}
	const content = normalizeNewlines(proposal.content || '');
	if (!MARKDOWN_HEADING.test(content)) {
		throw new SkillFactoryError('INVALID_CONTENT', 'Skill content must be complete Markdown that starts with a heading');
	}
	if (utf8Bytes(content) > MAX_CONTENT_BYTES) {
		throw new SkillFactoryError('INVALID_CONTENT', `Skill content exceeds ${MAX_CONTENT_BYTES} UTF-8 bytes`);
	}
	if (proposal.triggers && proposal.triggers.length > MAX_TRIGGERS) {
		throw new SkillFactoryError('INVALID_TRIGGERS', `Skill triggers exceed ${MAX_TRIGGERS} entries`);
	}
}

/**
 * Renders a canonical Cursor-compatible SKILL.md.
 * Frontmatter contract mirrors dsh-run2skill's renderCanonicalSkill:
 * name / description / whenToUse / disable-model-invocation / user-invocable,
 * plus code-agent's trigger keyword list.
 */
export function renderCanonicalSkill(input: SkillProposal): string {
	validateSkillProposal(input);
	const body = normalizeNewlines(input.content).replace(/\n+$/g, '');
	const metadata: string[] = [
		'---',
		`name: ${input.name}`,
		`description: ${JSON.stringify(normalizeNewlines(input.description).trim())}`,
	];
	if (input.whenToUse !== undefined && input.whenToUse.trim().length > 0) {
		metadata.push(`whenToUse: ${JSON.stringify(normalizeNewlines(input.whenToUse).trim())}`);
	}
	const triggers = (input.triggers || []).map(t => t.trim()).filter(t => t.length > 0);
	if (triggers.length > 0) {
		metadata.push('trigger:');
		for (const trigger of triggers.slice(0, MAX_TRIGGERS)) {
			metadata.push(`  - ${trigger}`);
		}
	}
	metadata.push(`disable-model-invocation: ${String(input.modelInvocable === false)}`);
	metadata.push(`user-invocable: ${String(input.userInvocable === true)}`);
	metadata.push('---');
	return `${metadata.join('\n')}\n\n${body}\n`;
}

/** Parses the metadata block of a SKILL.md file (frontmatter only). */
export function parseSkillMetadata(raw: string): {
	name: string;
	description: string;
	whenToUse?: string;
	triggers: string[];
	modelInvocable: boolean;
	userInvocable: boolean;
} {
	const meta: Record<string, string> = {};
	let body = raw;

	if (raw.startsWith('---')) {
		const endIdx = raw.indexOf('---', 3);
		if (endIdx > 0) {
			const frontmatter = raw.substring(3, endIdx).trim();
			body = raw.substring(endIdx + 3).trim();

			let currentKey = '';
			for (const line of frontmatter.split('\n')) {
				const trimmed = line.trim();
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
					// YAML block/folded scalar markers are handled by continuation lines
					if (val === '>' || val === '|') val = '';
					meta[currentKey] = val;
				} else if (currentKey && trimmed && !trimmed.startsWith('-')) {
					meta[currentKey] = ((meta[currentKey] || '') + ' ' + trimmed).trim();
				}
			}
		}
	}

	const unquote = (value: string): string => {
		const v = value.trim();
		if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
			try {
				return v.startsWith('"') ? JSON.parse(v) : v.slice(1, -1);
			} catch {
				return v.slice(1, -1);
			}
		}
		return v;
	};

	const triggers = (meta.trigger || '').split('\n').map(t => t.trim()).filter(t => t.length > 0);

	return {
		name: (meta.name || '').trim(),
		description: unquote(meta.description || ''),
		...(meta.whenToUse ? { whenToUse: unquote(meta.whenToUse) } : {}),
		triggers,
		modelInvocable: meta['disable-model-invocation'] !== 'true',
		userInvocable: meta['user-invocable'] === 'true',
	};
}

/** Provider tag used in catalog entries for filesystem-backed skills. */
const FILESYSTEM_PROVIDER = 'filesystem';

/**
 * Scans one directory for `{name}/SKILL.md` (and bare `SKILL.md`) files and
 * returns catalog entries. Mirrors dsh-run2skill's skill-catalog projection.
 */
export function scanSkillCatalog(dirs: string[]): SkillCatalogSnapshot {
	const skills: SkillCatalogEntry[] = [];
	const seen = new Set<string>();
	const complete = true;

	for (const dir of dirs) {
		if (!fs.existsSync(dir)) continue;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			let skillFile: string | undefined;
			let skillName = entry.name;
			if (entry.isDirectory()) {
				const candidate = path.join(fullPath, 'SKILL.md');
				if (fs.existsSync(candidate)) skillFile = candidate;
			} else if (entry.name === 'SKILL.md') {
				skillFile = fullPath;
				skillName = path.basename(dir);
			}
			if (!skillFile) continue;

			const key = `${skillName}@${skillFile}`;
			if (seen.has(key)) continue;
			seen.add(key);

			let raw: string;
			try {
				raw = fs.readFileSync(skillFile, 'utf-8');
			} catch {
				continue;
			}
			const meta = parseSkillMetadata(raw);
			const entrySummary: SkillCatalogEntry = {
				name: meta.name || skillName,
				description: meta.description,
				...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
				triggers: meta.triggers,
				source: 'filesystem',
				provider: FILESYSTEM_PROVIDER,
				path: skillFile,
				modelInvocable: meta.modelInvocable,
				userInvocable: meta.userInvocable,
			};
			skills.push(entrySummary);
		}
	}

	skills.sort((a, b) => a.name.localeCompare(b.name));
	return { skills, complete };
}

// ---- Recall / dedup (ported from dsh-run2skill skill-recall.ts) ----

const MAX_QUERY_TOKENS = 64;
const STOP_WORDS = new Set([
	'a', 'an', 'and', 'for', 'in', 'of', 'on', 'please', 'the', 'this', 'to', 'use',
]);
const CHINESE_STOP_WORDS = [
	'这个', '这些', '那个', '那些', '一个', '一种', '我们', '你们',
	'使用', '进行', '用于', '需要', '可以', '请',
] as const;

/** Tokenizes text into Latin words + Chinese bigrams for fuzzy skill matching. */
export function tokenizeForSkillRecall(value: string): string[] {
	const normalized = value.normalize('NFKC').toLowerCase();
	const result: string[] = [];
	const seen = new Set<string>();
	const add = (token: string): void => {
		if (token.length <= 1 || STOP_WORDS.has(token) || seen.has(token) || result.length >= MAX_QUERY_TOKENS) return;
		seen.add(token);
		result.push(token);
	};
	for (const match of normalized.matchAll(/[\p{Script=Latin}\p{Number}]+|[\p{Script=Han}]+/gu)) {
		const term = match[0];
		if (/^[\p{Script=Han}]+$/u.test(term)) {
			let meaningful = term;
			for (const stopWord of CHINESE_STOP_WORDS) meaningful = meaningful.replaceAll(stopWord, '');
			const characters = [...meaningful];
			for (let index = 0; index + 1 < characters.length; index += 1) {
				add(`${characters[index]}${characters[index + 1]}`);
			}
		} else {
			add(term);
		}
		if (result.length >= MAX_QUERY_TOKENS) break;
	}
	return result;
}

function overlapCount(value: string | undefined, query: ReadonlySet<string>): number {
	if (value === undefined) return 0;
	let count = 0;
	for (const token of tokenizeForSkillRecall(value)) {
		if (query.has(token)) count += 1;
	}
	return count;
}

/**
 * Recalls existing skills that overlap with the requested capability so the
 * agent can decide CREATE vs MERGE/UPDATE (dedup). Mirrors dsh-run2skill
 * recallExistingSkills + the COVERAGE classification heuristic.
 */
export function recallExistingSkills(
	snapshot: SkillCatalogSnapshot,
	directEvidence: string,
	maxResults: number = 5,
): SkillRecallResult {
	const queryTokens = tokenizeForSkillRecall(directEvidence);
	const query = new Set(queryTokens);
	const scored: SkillRecallCandidate[] = snapshot.skills
		.map(entry => {
			const nameOverlap = overlapCount(entry.name, query);
			const whenToUseOverlap = overlapCount(entry.whenToUse, query);
			const descriptionOverlap = overlapCount(entry.description, query);
			return {
				entry,
				nameOverlap,
				whenToUseOverlap,
				descriptionOverlap,
				totalScore: nameOverlap * 3 + whenToUseOverlap * 2 + descriptionOverlap,
			};
		})
		.filter(c => c.totalScore > 0)
		.sort((a, b) => b.totalScore - a.totalScore)
		.slice(0, maxResults);

	const closest = scored[0];
	let classification: SkillRecallClassification = 'UNRELATED';
	if (closest) {
		if (closest.nameOverlap > 0 && closest.totalScore >= 6) {
			classification = 'COVERED';
		} else if (closest.totalScore >= 2) {
			classification = 'PARTIAL';
		}
	}

	return { queryTokens, candidates: scored, classification, closest };
}

/** Default skills directory used when none is configured. */
export function defaultSkillsDir(): string {
	return path.join(os.homedir(), '.codeagent', 'skills');
}

/**
 * Publishes a canonical skill to `{skillsDir}/{name}/SKILL.md`.
 * Mirrors dsh-run2skill publication: the file is written atomically and an
 * existing skill is never silently overwritten unless `force: true`.
 */
export function publishSkill(
	skillsDir: string | undefined,
	proposal: SkillProposal,
	options: { force?: boolean } = {},
): SkillPublishResult {
	validateSkillProposal(proposal);

	const root = (skillsDir && skillsDir.trim().length > 0 ? skillsDir : defaultSkillsDir()).replace(/^~(?=$|\/|\\)/, os.homedir());
	const targetDir = path.join(root, proposal.name);
	const targetPath = path.join(targetDir, 'SKILL.md');

	const existed = fs.existsSync(targetPath);
	if (existed && !options.force) {
		return { status: 'EXISTS', targetPath };
	}

	const rendered = renderCanonicalSkill(proposal);
	const tmpPath = path.join(targetDir, `.SKILL.md.${process.pid}.${Date.now()}.tmp`);
	try {
		fs.mkdirSync(targetDir, { recursive: true });
		fs.writeFileSync(tmpPath, rendered, 'utf-8');
		fs.renameSync(tmpPath, targetPath);
	} catch (err) {
		try { fs.rmSync(tmpPath, { force: true }); } catch { /* best effort */ }
		throw new SkillFactoryError('PUBLISH_FAILED', `Failed to publish skill "${proposal.name}": ${(err as Error).message}`);
	}

	return { status: existed ? 'UPDATED' : 'CREATED', targetPath };
}

/** Loads the full SKILL.md content of a catalog entry. */
export function readSkillDefinition(entry: SkillCatalogEntry): { proposal: SkillProposal; raw: string } | undefined {
	if (!entry.path) return undefined;
	try {
		const raw = fs.readFileSync(entry.path, 'utf-8');
		const meta = parseSkillMetadata(raw);
		let body = raw;
		if (raw.startsWith('---')) {
			const endIdx = raw.indexOf('\n---', 3);
			if (endIdx > 0) {
				body = raw.substring(endIdx + 5).trimStart(); // skip "\n---\n" then optional blank line
			}
		}
		return {
			raw,
			proposal: {
				name: meta.name || entry.name,
				description: meta.description,
				...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
				content: body,
				triggers: meta.triggers,
				modelInvocable: meta.modelInvocable,
				userInvocable: meta.userInvocable,
			},
		};
	} catch {
		return undefined;
	}
}
