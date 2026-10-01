/**
 * The studio's on-disk gallery.
 *
 * Layout under the studio root (default `<DSH_HOME>/image-studio`, override with
 * `DSH_IMAGE_STUDIO_HOME`):
 *
 *   gallery.json      the index: one entry per generated image or video
 *   files/<id>.<ext>  the media itself, named from the entry id, never from a
 *                     prompt or a remote URL
 *
 * The index is the only thing the page reads, so browsing never touches the
 * network and never needs the provider. File names are generated here and
 * validated on the way back in, which is what keeps a request from addressing a
 * file outside the studio root.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/** Index format version, so a later release can migrate rather than guess. */
export const INDEX_VERSION = 1;

/** Media extensions the studio is willing to store and serve. */
export const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov']);

/** Entries kept in the index; the oldest non-favourite entries fall off first. */
export const MAX_ITEMS = 2000;

/** Largest single media file accepted from a provider. */
export const MAX_MEDIA_BYTES = 64 * 1024 * 1024;

/**
 * Resolve the studio root.
 *
 * @param options.dshHome - harness home; defaults to `$DSH_HOME` or `~/.dsh`.
 * @param options.override - explicit root, from configuration or a test.
 * @returns the absolute studio directory.
 */
export function studioRoot({ dshHome, override } = {}) {
	if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim());
	if (typeof process.env.DSH_IMAGE_STUDIO_HOME === 'string' && process.env.DSH_IMAGE_STUDIO_HOME.trim() !== '') {
		return path.resolve(process.env.DSH_IMAGE_STUDIO_HOME.trim());
	}
	const home = typeof dshHome === 'string' && dshHome.trim() !== ''
		? dshHome.trim()
		: (process.env.DSH_HOME || path.join(os.homedir(), '.dsh'));
	return path.join(path.resolve(home), 'image-studio');
}

/** Where media files live inside a studio root. */
export function filesDir(root) {
	return path.join(root, 'files');
}

/** Path of the index document inside a studio root. */
export function indexPath(root) {
	return path.join(root, 'gallery.json');
}

/**
 * Create a fresh entry id.
 *
 * @returns 24 lowercase hex characters.
 */
export function newId() {
	return crypto.randomBytes(12).toString('hex');
}

/**
 * Whether a string could be an id this module produced.
 *
 * @param id - candidate id.
 * @returns true for 16–32 lowercase hex characters.
 */
export function isSafeId(id) {
	return typeof id === 'string' && /^[a-f0-9]{16,32}$/.test(id);
}

/**
 * Whether an extension may be stored and served.
 *
 * @param ext - candidate extension without the dot.
 * @returns true when the studio accepts it.
 */
export function isSafeExtension(ext) {
	return typeof ext === 'string' && ALLOWED_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Map a media type to the extension the studio stores it under.
 *
 * @param mime - content type reported by the provider, if any.
 * @param fallback - extension used when the type is unknown.
 * @returns a safe extension without the dot.
 */
export function extensionForMime(mime, fallback = 'png') {
	const wanted = typeof mime === 'string' ? mime.split(';')[0].trim().toLowerCase() : '';
	switch (wanted) {
		case 'image/png': return 'png';
		case 'image/jpeg':
		case 'image/jpg': return 'jpg';
		case 'image/webp': return 'webp';
		case 'image/gif': return 'gif';
		case 'video/mp4': return 'mp4';
		case 'video/webm': return 'webm';
		case 'video/quicktime': return 'mov';
		default: return isSafeExtension(fallback) ? fallback.toLowerCase() : 'png';
	}
}

/** Content type served back for a stored extension. */
export function mimeForExtension(ext) {
	switch (String(ext).toLowerCase()) {
		case 'png': return 'image/png';
		case 'jpg':
		case 'jpeg': return 'image/jpeg';
		case 'webp': return 'image/webp';
		case 'gif': return 'image/gif';
		case 'mp4': return 'video/mp4';
		case 'webm': return 'video/webm';
		case 'mov': return 'video/quicktime';
		default: return 'application/octet-stream';
	}
}

/**
 * Read the index, tolerating a missing or unreadable document.
 *
 * @param root - studio root.
 * @returns `{ version, items }` with items newest first.
 */
export function readIndex(root) {
	try {
		const raw = fs.readFileSync(indexPath(root), 'utf8');
		const parsed = JSON.parse(raw);
		if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.items)) {
			return { version: INDEX_VERSION, items: parsed.items.filter(isUsableEntry) };
		}
	} catch {
		// A missing or damaged index is an empty gallery, not a failure: the
		// media on disk stays where it is and the next write restores the index.
	}
	return { version: INDEX_VERSION, items: [] };
}

/**
 * Write the index through a temporary file so a crash cannot truncate it.
 *
 * @param root - studio root.
 * @param index - `{ version, items }`.
 * @returns the capped index that was written.
 */
export function writeIndex(root, index) {
	const items = capItems(Array.isArray(index?.items) ? index.items : []);
	const document = { version: INDEX_VERSION, items };
	fs.mkdirSync(root, { recursive: true });
	const target = indexPath(root);
	const temporary = `${target}.${process.pid}.tmp`;
	fs.writeFileSync(temporary, JSON.stringify(document, null, 2), 'utf8');
	fs.renameSync(temporary, target);
	return document;
}

/**
 * Append entries, newest first, and return the stored index.
 *
 * @param root - studio root.
 * @param entries - entries to add.
 * @returns the stored index.
 */
export function addEntries(root, entries) {
	const current = readIndex(root);
	const known = new Set(current.items.map((item) => item.id));
	const fresh = (Array.isArray(entries) ? entries : []).filter((entry) => isUsableEntry(entry) && !known.has(entry.id));
	return writeIndex(root, { version: INDEX_VERSION, items: [...fresh, ...current.items] });
}

/**
 * Remove one entry and its file.
 *
 * @param root - studio root.
 * @param id - entry id.
 * @returns true when an entry was removed.
 */
export function removeEntry(root, id) {
	const current = readIndex(root);
	const wanted = current.items.find((item) => item.id === id);
	if (wanted === undefined) return false;
	writeIndex(root, { version: INDEX_VERSION, items: current.items.filter((item) => item.id !== id) });
	try {
		fs.rmSync(entryPath(root, wanted), { force: true });
	} catch {
		// The entry is already gone from the index, which is what the page shows.
	}
	return true;
}

/**
 * Mark or unmark one entry as a favourite.
 *
 * @param root - studio root.
 * @param id - entry id.
 * @param favorite - desired state.
 * @returns the updated entry, or undefined when it is unknown.
 */
export function setFavorite(root, id, favorite) {
	const current = readIndex(root);
	let updated;
	const items = current.items.map((item) => {
		if (item.id !== id) return item;
		updated = { ...item, favorite: favorite === true };
		return updated;
	});
	if (updated === undefined) return undefined;
	writeIndex(root, { version: INDEX_VERSION, items });
	return updated;
}

/**
 * Drop entries whose file disappeared (a person cleaned the folder, a partial
 * download failed) so the page never shows a broken tile.
 *
 * @param root - studio root.
 * @returns the stored index.
 */
export function pruneMissing(root) {
	const current = readIndex(root);
	const kept = current.items.filter((item) => fs.existsSync(entryPath(root, item)));
	if (kept.length !== current.items.length) return writeIndex(root, { version: INDEX_VERSION, items: kept });
	return { version: INDEX_VERSION, items: kept };
}

/**
 * Absolute path of an entry's media file, confined to the studio root.
 *
 * @param root - studio root.
 * @param entry - an entry from the index.
 * @returns the absolute file path.
 * @throws when the entry is malformed, which means a hostile index.
 */
export function entryPath(root, entry) {
	if (!isUsableEntry(entry)) throw new Error('Refusing to resolve a malformed gallery entry');
	return path.join(filesDir(root), `${entry.id}.${entry.ext}`);
}

/**
 * Write media bytes for an entry and return the stored entry.
 *
 * @param root - studio root.
 * @param options.id - entry id.
 * @param options.bytes - media bytes.
 * @param options.ext - safe extension.
 * @param options.meta - the remaining entry fields.
 * @returns the stored entry.
 */
export function writeEntryFile(root, { id, bytes, ext, meta }) {
	if (!isSafeId(id)) throw new Error('Refusing to write media under an invalid id');
	if (!isSafeExtension(ext)) throw new Error(`Refusing to write media with the extension "${ext}"`);
	if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('Refusing to write an empty media file');
	if (bytes.length > MAX_MEDIA_BYTES) throw new Error(`Media larger than ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)} MB is not stored`);

	const dir = filesDir(root);
	fs.mkdirSync(dir, { recursive: true });
	const entry = { ...meta, id, ext, mime: mimeForExtension(ext), bytes: bytes.length };
	fs.writeFileSync(entryPath(root, entry), bytes);
	return entry;
}

/** An entry this module is willing to read back. */
function isUsableEntry(entry) {
	return entry !== null
		&& typeof entry === 'object'
		&& isSafeId(entry.id)
		&& isSafeExtension(entry.ext)
		&& (entry.kind === 'image' || entry.kind === 'video');
}

/** Keep the newest entries, never dropping a favourite. */
function capItems(items) {
	if (items.length <= MAX_ITEMS) return items;
	const favourites = items.filter((item) => item.favorite === true);
	const rest = items.filter((item) => item.favorite !== true);
	const room = Math.max(0, MAX_ITEMS - favourites.length);
	return [...favourites.slice(0, MAX_ITEMS), ...rest.slice(0, room)]
		.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
