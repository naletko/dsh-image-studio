/**
 * Where the media library lives.
 *
 * The gallery started life as one shared studio under `<DSH_HOME>/image-studio`.
 * A project often wants its own media instead — screenshots, clips, and icons
 * that belong beside the code and travel with the repository — so the root is
 * now a decision taken per request:
 *
 *   source 'studio'      <DSH_HOME>/image-studio
 *   source 'workspace'   <libraryWorkspace>/dsh-media[/<librarySubdir>]
 *
 * The directory is created on first use, and this module owns every rule about
 * which values may name it: a path outside the chosen project, a traversal in
 * the subdirectory, or a relative workspace is dropped rather than sanitized,
 * so a bad profile patch or a hostile request can never move the library.
 *
 * Nothing here reads a credential, and nothing here remembers a path between
 * calls: the root is resolved fresh, which is what lets the page switch source
 * without restarting the harness.
 */

import fs from 'node:fs';
import path from 'node:path';

import { studioRoot } from './gallery.js';

/** Sources the configuration may name. */
export const LIBRARY_SOURCES = ['studio', 'workspace'];

/** Folder created inside the chosen project for its media. */
export const WORKSPACE_MEDIA_DIR = 'dsh-media';

/** The line offered for a project's `.gitignore`. */
export const GITIGNORE_LINE = `${WORKSPACE_MEDIA_DIR}/`;

/** Deepest subdirectory the configuration may name. */
export const MAX_SUBDIR_SEGMENTS = 3;

/**
 * Keep a subdirectory only when it is a short, plain, relative path.
 *
 * Segmentation is the whole defence: `..`, an absolute path, a Windows drive,
 * a backslash, a doubled or trailing separator, and anything with punctuation
 * or spaces are all rejected outright. Rejection means the key is left alone —
 * never silently rewritten — so a typo cannot point the library somewhere else.
 *
 * @param value - candidate subdirectory, from a profile patch or a request.
 * @returns the normalized subdirectory (`''` for none), or undefined when the
 *   value is not usable.
 */
export function sanitizeLibrarySubdir(value) {
	if (typeof value !== 'string') return undefined;
	const trimmed = value.trim();
	if (trimmed === '') return '';
	// No backslashes and no colons: that rules out Windows separators, drive
	// letters, and alternate data streams in one check.
	if (trimmed.includes('\\') || trimmed.includes(':')) return undefined;
	const segments = trimmed.split('/');
	if (segments.length > MAX_SUBDIR_SEGMENTS) return undefined;
	for (const segment of segments) {
		// A segment may not be empty, may not start with a dot (so `.` and `..`
		// are both out), and is limited to letters, digits, dot, dash, and
		// underscore.
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(segment)) return undefined;
	}
	return segments.join('/');
}

/**
 * Whether a value may name a project whose media the studio writes.
 *
 * The path must be fully qualified and must already be a directory: the studio
 * never creates a project, it only puts a `dsh-media` folder inside one.
 *
 * @param value - candidate workspace directory.
 * @returns true when the studio may use it.
 */
export function isUsableWorkspace(value) {
	if (typeof value !== 'string') return false;
	const trimmed = value.trim();
	if (trimmed === '' || !path.isAbsolute(trimmed)) return false;
	try {
		return fs.statSync(trimmed).isDirectory();
	} catch {
		return false;
	}
}

/**
 * The library directory for the current configuration.
 *
 * With `source: 'workspace'` the project folder is created on first use, so a
 * person who picks a project does not have to prepare anything. A configuration
 * that names a project but cannot use it (removed directory, hand-edited
 * profile) falls back to the shared studio rather than failing every route:
 * losing sight of a gallery is worse than landing in the shared one, and
 * `/state` reports which root actually answered.
 *
 * @param live - the resolved configuration.
 * @returns the absolute library root.
 */
export function resolveLibraryRoot(live) {
	if (live !== null && typeof live === 'object' && live.librarySource === 'workspace') {
		const base = typeof live.libraryWorkspace === 'string' ? live.libraryWorkspace.trim() : '';
		if (isUsableWorkspace(base)) {
			const subdir = sanitizeLibrarySubdir(live.librarySubdir) ?? '';
			const dir = subdir === ''
				? path.join(base, WORKSPACE_MEDIA_DIR)
				: path.join(base, WORKSPACE_MEDIA_DIR, ...subdir.split('/'));
			fs.mkdirSync(dir, { recursive: true });
			return dir;
		}
	}
	return studioRoot();
}

/**
 * The project list, mapped to the two fields the page renders.
 *
 * The registry publishes entities with a `title` and a canonical `path`; the
 * service is optional in a composition, so an absent or broken registry answers
 * "not supported" instead of failing the request.
 *
 * @param registry - `ctx.workspaceRegistry`, when the deployment mounts one.
 * @returns `{ supported, workspaces }`, each workspace `{ name, dir }`.
 */
export function listWorkspaces(registry) {
	if (registry === null || registry === undefined || typeof registry.list !== 'function') {
		return { supported: false, workspaces: [] };
	}
	try {
		const entries = registry.list();
		const workspaces = (Array.isArray(entries) ? entries : [])
			.map((entry) => {
				const dir = typeof entry?.path === 'string' ? entry.path : '';
				const title = typeof entry?.title === 'string' && entry.title !== '' ? entry.title : dir;
				return { name: title, dir };
			})
			.filter((entry) => entry.dir !== '');
		return { supported: true, workspaces };
	} catch {
		return { supported: false, workspaces: [] };
	}
}

/**
 * Whether a project is a git repository and already ignores the media folder.
 *
 * @param workspace - the configured workspace directory.
 * @returns `{ git, ignored }`; both false when no usable workspace is named.
 */
export function workspaceGitState(workspace) {
	if (!isUsableWorkspace(workspace)) return { git: false, ignored: false };
	const dir = String(workspace).trim();
	let git = false;
	try {
		git = fs.existsSync(path.join(dir, '.git'));
	} catch {
		git = false;
	}
	let ignored = false;
	try {
		ignored = splitGitignore(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).includes(GITIGNORE_LINE);
	} catch {
		// An unreadable ignore file is not an ignored media folder.
	}
	return { git, ignored };
}

/**
 * Add the media folder to a project's `.gitignore`, once.
 *
 * Only an explicit request reaches this function, and only a project that is
 * already a git repository is touched: a directory without `.git` is left
 * exactly as it is. The append is idempotent, so a page reload or a second
 * click costs nothing.
 *
 * @param workspace - the configured workspace directory.
 * @returns `{ ok, changed, reason }`.
 */
export function addGitignoreLine(workspace) {
	if (!isUsableWorkspace(workspace)) return { ok: false, changed: false, reason: 'no-usable-workspace' };
	const dir = String(workspace).trim();
	const ignoreFile = path.join(dir, '.gitignore');
	try {
		if (!fs.existsSync(path.join(dir, '.git'))) return { ok: true, changed: false, reason: 'not-a-git-repository' };
		let content = '';
		try {
			content = fs.readFileSync(ignoreFile, 'utf8');
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
		}
		if (splitGitignore(content).includes(GITIGNORE_LINE)) return { ok: true, changed: false, reason: 'already-ignored' };
		const separator = content === '' || content.endsWith('\n') ? '' : '\n';
		fs.appendFileSync(ignoreFile, `${separator}${GITIGNORE_LINE}\n`, 'utf8');
		return { ok: true, changed: true };
	} catch (error) {
		return { ok: false, changed: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * The meaningful lines of a `.gitignore`, so a line that only differs by
 * surrounding whitespace still counts as present.
 *
 * @param raw - the ignore file's contents.
 * @returns the trimmed non-comment lines.
 */
function splitGitignore(raw) {
	return String(raw)
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== '' && !line.startsWith('#'));
}
