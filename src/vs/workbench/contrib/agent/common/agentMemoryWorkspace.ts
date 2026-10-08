/*---------------------------------------------------------------------------------------------
 *  Workspace scoping for shared memories (L0 conversation turns + L1 atomic facts).
 *
 *  Why: the tdai_agent_mem hub is shared across machines *and* projects. A fact learnt
 *  in one repository must not leak into an unrelated one. L2 (scenario) and L3 (persona)
 *  are deliberately cross-project, so only L0/L1 are scoped here.
 *
 *  Rule (mirrors the user requirement):
 *    - Every L0 turn / L1 note is tagged with the absolute workspace directory it was
 *      captured in.
 *    - It is recalled only when its tag equals the current workspace directory, or when
 *      the two are in an ancestor/descendant relation (a directory and its sub-directories
 *      recall each other).
 *    - Sibling directories never see each other's memories.
 *    - An item with no tag at all (legacy data written before scoping existed) is hidden
 *      under `strict` and kept visible under `loose`.
 *
 *  Tag carriers, in priority order (see `workspaceTagOfItem`):
 *    1. the hub's `task_id` field — a first-class, server-side filterable field
 *       (verified against /v3/conversation/add, /v3/conversation/search,
 *       /v3/atomic/search and /v3/atomic/query),
 *    2. a `[workspace:<abs dir>]` marker at the start of a line inside `content`,
 *    3. the same marker at the start of a line inside `background`.
 *
 *  The marker is only a *fallback*: /v3/conversation/search does not echo `task_id`
 *  back, so turns returned by a tag-filtered query are stamped with the tag the
 *  server filtered on before they reach this gate (see MemoryClient._mergeScoped).
 *
 *  Pure functions only (no I/O) so the rule can be unit-tested in isolation.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/** Scoping mode for tagged memories (L0 conversation turns + L1 atomic facts). */
export type WorkspaceScope = 'strict' | 'loose' | 'off';

export const WORKSPACE_SCOPES: WorkspaceScope[] = ['strict', 'loose', 'off'];

/** Default mode: enforce isolation (untagged memories are hidden). */
export const DEFAULT_WORKSPACE_SCOPE: WorkspaceScope = 'strict';

/** Opening token of the in-text workspace marker: `[workspace:/abs/dir]`. */
export const WORKSPACE_MARKER_OPEN = '[workspace:';

/**
 * Marker: `[workspace:/abs/dir]`, recognised only at the START OF A LINE.
 *
 * Anchoring matters: markers are stamped as a leading line (L0 user turns) or a
 * trailing line (L1 background), so prose that merely *mentions* the syntax —
 * e.g. this feature's own documentation — must not be mistaken for a tag.
 * `m` flag, so `^` matches at every line start.
 */
const MARKER_RE = /^\[workspace:([^\]\n\r]+)\]/m;

/** Longest ancestor chain we ask the hub about (bounds the number of HTTP calls). */
export const MAX_ANCESTOR_QUERIES = 4;

export function parseWorkspaceScope(value: unknown): WorkspaceScope {
	const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
	return (WORKSPACE_SCOPES as string[]).includes(v) ? (v as WorkspaceScope) : DEFAULT_WORKSPACE_SCOPE;
}

/**
 * Normalise a directory to the canonical form used as the workspace tag:
 * absolute, no trailing separator (except for the filesystem root), no `..`/`.` noise.
 * Returns '' for empty/invalid input.
 */
export function normalizeWorkspaceDir(dir: string | undefined | null): string {
	const raw = typeof dir === 'string' ? dir.trim() : '';
	if (!raw) return '';
	let resolved: string;
	try {
		resolved = path.resolve(raw);
	} catch {
		return '';
	}
	while (resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
		resolved = resolved.slice(0, -1);
	}
	return resolved;
}

/** True when a raw string looks like an absolute directory (POSIX, drive, or UNC). */
export function isAbsoluteDirLike(value: string | undefined | null): boolean {
	const v = typeof value === 'string' ? value.trim() : '';
	if (!v) return false;
	return v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith('\\\\');
}

/** The in-text tag to embed in captured content/background. '' when dir is unusable. */
export function workspaceMarker(dir: string | undefined | null): string {
	const n = normalizeWorkspaceDir(dir);
	return n ? `${WORKSPACE_MARKER_OPEN}${n}]` : '';
}

/** First `[workspace:...]` marker found in a chunk of text, normalised. */
export function extractWorkspaceFromText(text: string | undefined | null): string | undefined {
	if (typeof text !== 'string' || !text) return undefined;
	const m = MARKER_RE.exec(text);
	if (!m) return undefined;
	const dir = normalizeWorkspaceDir(m[1]);
	return dir || undefined;
}

/**
 * Workspace tag of a memory/conversation item, or undefined when the item is untagged.
 * `task_id` wins, but only when it actually looks like an absolute path — the hub may
 * also store ordinary task identifiers there, which must not be mistaken for a workspace.
 */
export function workspaceTagOfItem(item: Record<string, unknown> | undefined | null): string | undefined {
	if (!item) return undefined;
	const taskId = typeof item.task_id === 'string' ? item.task_id : '';
	if (isAbsoluteDirLike(taskId)) {
		const dir = normalizeWorkspaceDir(taskId);
		if (dir) return dir;
	}
	return extractWorkspaceFromText(typeof item.content === 'string' ? item.content : undefined)
		?? extractWorkspaceFromText(typeof item.background === 'string' ? item.background : undefined);
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isSubDir(parent: string, child: string): boolean {
	const p = normalizeWorkspaceDir(parent);
	const c = normalizeWorkspaceDir(child);
	if (!p || !c) return false;
	if (p === c) return true;
	const withSep = p.endsWith(path.sep) ? p : p + path.sep;
	return c.startsWith(withSep);
}

/**
 * Relation of a note's tag to the current directory.
 *  - `same`       — identical directory
 *  - `ancestor`   — the note's workspace is a parent of the current directory
 *  - `descendant` — the note's workspace lives inside the current directory
 *  - `unrelated`  — siblings / different trees
 */
export function workspaceRelation(
	noteTag: string | undefined | null,
	currentDir: string | undefined | null,
): 'same' | 'ancestor' | 'descendant' | 'unrelated' {
	const a = normalizeWorkspaceDir(noteTag);
	const b = normalizeWorkspaceDir(currentDir);
	if (!a || !b) return 'unrelated';
	if (a === b) return 'same';
	if (isSubDir(a, b)) return 'ancestor';
	if (isSubDir(b, a)) return 'descendant';
	return 'unrelated';
}

/** Parent/child directories recall each other; siblings do not. */
export function isWorkspaceRelated(noteTag: string | undefined | null, currentDir: string | undefined | null): boolean {
	return workspaceRelation(noteTag, currentDir) !== 'unrelated';
}

/**
 * Gate a single tagged item (an L1 atom or an L0 conversation turn).
 *  - `off`    — everything is visible (legacy behaviour)
 *  - `loose`  — tagged items obey the workspace rule, untagged items stay visible
 *  - `strict` — tagged items obey the workspace rule, untagged items are hidden
 */
export function isWorkspaceVisible(
	item: Record<string, unknown> | undefined | null,
	currentDir: string | undefined | null,
	scope: WorkspaceScope = DEFAULT_WORKSPACE_SCOPE,
): boolean {
	if (scope === 'off') return true;
	const tag = workspaceTagOfItem(item);
	if (!tag) return scope === 'loose';
	return isWorkspaceRelated(tag, currentDir);
}

/** Filter a batch of tagged items (L1 atoms / L0 turns) through the workspace gate. */
export function filterByWorkspace<T extends Record<string, unknown>>(
	items: T[],
	currentDir: string | undefined | null,
	scope: WorkspaceScope = DEFAULT_WORKSPACE_SCOPE,
): T[] {
	if (scope === 'off') return items;
	return items.filter(it => isWorkspaceVisible(it, currentDir, scope));
}

/**
 * Tags worth asking the hub for: the current directory plus its ancestors
 * (root excluded, since nothing is ever tagged there). The ancestor entries are what
 * make "a sub-directory recalls its parent workspace's L1" work server-side.
 */
export function workspaceCandidateTags(currentDir: string | undefined | null, maxAncestors = MAX_ANCESTOR_QUERIES): string[] {
	const dir = normalizeWorkspaceDir(currentDir);
	if (!dir) return [];
	const tags: string[] = [];
	let cur = dir;
	while (tags.length < maxAncestors) {
		const parent = path.dirname(cur);
		if (!parent || parent === cur) break; // reached the root
		tags.push(cur);
		if (parent === path.sep) break; // the filesystem root is never a tag
		cur = parent;
	}
	return tags;
}
