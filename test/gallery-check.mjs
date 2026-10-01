/**
 * The gallery owns two things that must never go wrong: a file must never be
 * written or read outside the studio root, and the index must survive a damaged
 * or missing document instead of taking the page down with it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
	addEntries,
	entryPath,
	extensionForMime,
	isSafeExtension,
	isSafeId,
	mimeForExtension,
	newId,
	pruneMissing,
	readIndex,
	removeEntry,
	setFavorite,
	studioRoot,
	writeEntryFile,
	writeIndex,
} from '../lib/gallery.js';

/** A fresh studio root inside the workspace, removed by the caller. */
function makeRoot() {
	const root = path.join(import.meta.dirname, '.tmp', `gallery-${newId()}`);
	fs.mkdirSync(root, { recursive: true });
	return root;
}

/** One stored image, ready to index. */
function storeImage(root, overrides = {}) {
	return writeEntryFile(root, {
		id: newId(),
		bytes: Buffer.from('not really a png'),
		ext: 'png',
		meta: { kind: 'image', prompt: 'a chair', model: 'fal-ai/flux-2/klein/9b', createdAt: Date.now(), ...overrides },
	});
}

test('ids and extensions are the only naming grammar the studio accepts', () => {
	const id = newId();
	assert.equal(isSafeId(id), true);
	assert.equal(isSafeId('../../etc/passwd'), false);
	assert.equal(isSafeId('ABCDEF0123456789'), false);
	assert.equal(isSafeId('short'), false);

	assert.equal(isSafeExtension('png'), true);
	assert.equal(isSafeExtension('MP4'), true);
	assert.equal(isSafeExtension('exe'), false);
	assert.equal(isSafeExtension('../png'), false);
});

test('a content type maps to the stored extension and back', () => {
	assert.equal(extensionForMime('image/jpeg'), 'jpg');
	assert.equal(extensionForMime('image/png; charset=binary'), 'png');
	assert.equal(extensionForMime('video/quicktime'), 'mov');
	assert.equal(extensionForMime('application/octet-stream', 'webp'), 'webp');
	assert.equal(extensionForMime(undefined, 'exe'), 'png');
	assert.equal(mimeForExtension('jpg'), 'image/jpeg');
	assert.equal(mimeForExtension('mp4'), 'video/mp4');
});

test('entries round-trip through the index newest first', () => {
	const root = makeRoot();
	try {
		const first = storeImage(root, { createdAt: 1 });
		const second = storeImage(root, { createdAt: 2 });
		addEntries(root, [first]);
		addEntries(root, [second]);

		const index = readIndex(root);
		assert.equal(index.items.length, 2);
		assert.equal(index.items[0].id, second.id);
		assert.equal(fs.existsSync(entryPath(root, second)), true);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('adding the same entry twice does not duplicate it', () => {
	const root = makeRoot();
	try {
		const entry = storeImage(root);
		addEntries(root, [entry]);
		addEntries(root, [entry]);
		assert.equal(readIndex(root).items.length, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a malformed entry is refused before it can name a path', () => {
	assert.throws(() => entryPath('/tmp', { id: '../../secret', ext: 'png', kind: 'image' }), /malformed/);
	assert.throws(() => entryPath('/tmp', { id: newId(), ext: 'exe', kind: 'image' }), /malformed/);
});

test('a hostile id cannot escape the files directory', () => {
	const root = makeRoot();
	try {
		assert.throws(() => writeEntryFile(root, {
			id: '../escape',
			bytes: Buffer.from('x'),
			ext: 'png',
			meta: { kind: 'image' },
		}), /invalid id/);
		assert.equal(fs.existsSync(path.join(root, '..', 'escape.png')), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('a damaged index reads as empty and is replaced on the next write', () => {
	const root = makeRoot();
	try {
		fs.writeFileSync(path.join(root, 'gallery.json'), '{ this is not json', 'utf8');
		assert.deepEqual(readIndex(root).items, []);

		const entry = storeImage(root);
		addEntries(root, [entry]);
		assert.equal(readIndex(root).items.length, 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('an entry whose file vanished is pruned from the index', () => {
	const root = makeRoot();
	try {
		const entry = storeImage(root);
		addEntries(root, [entry]);
		fs.rmSync(entryPath(root, entry), { force: true });
		assert.equal(pruneMissing(root).items.length, 0);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('favourites and deletions update both the index and the disk', () => {
	const root = makeRoot();
	try {
		const entry = storeImage(root);
		addEntries(root, [entry]);

		const updated = setFavorite(root, entry.id, true);
		assert.equal(updated.favorite, true);
		assert.equal(readIndex(root).items[0].favorite, true);

		assert.equal(setFavorite(root, 'deadbeefdeadbeef', true), undefined);

		assert.equal(removeEntry(root, entry.id), true);
		assert.equal(readIndex(root).items.length, 0);
		assert.equal(fs.existsSync(entryPath(root, entry)), false);
		assert.equal(removeEntry(root, entry.id), false);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('empty media and oversized media are refused', () => {
	const root = makeRoot();
	try {
		assert.throws(() => writeEntryFile(root, { id: newId(), bytes: Buffer.alloc(0), ext: 'png', meta: { kind: 'image' } }), /empty/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test('the studio root prefers the explicit override, then the environment', () => {
	const previous = process.env.DSH_IMAGE_STUDIO_HOME;
	try {
		delete process.env.DSH_IMAGE_STUDIO_HOME;
		assert.equal(studioRoot({ dshHome: 'C:/harness' }), path.join(path.resolve('C:/harness'), 'image-studio'));

		process.env.DSH_IMAGE_STUDIO_HOME = 'C:/studio';
		assert.equal(studioRoot({ dshHome: 'C:/harness' }), path.resolve('C:/studio'));
		assert.equal(studioRoot({ dshHome: 'C:/harness', override: 'C:/explicit' }), path.resolve('C:/explicit'));
	} finally {
		if (previous === undefined) delete process.env.DSH_IMAGE_STUDIO_HOME;
		else process.env.DSH_IMAGE_STUDIO_HOME = previous;
	}
});

test('a written index never carries an entry the reader would reject', () => {
	const root = makeRoot();
	try {
		writeIndex(root, {
			version: 1,
			items: [
				{ id: newId(), ext: 'png', kind: 'image' },
				{ id: '../../evil', ext: 'png', kind: 'image' },
			],
		});
		const items = readIndex(root).items;
		assert.equal(items.length, 1);
		assert.equal(items[0].kind, 'image');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
