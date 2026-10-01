/**
 * The bundle contract, asserted the way the harness reads it: the manifest must
 * name a patch that exists, that patch must insert a row whose `name` is the
 * package itself, and the row id in the patch must be the id the settings card
 * registers under — a rename in one place silently empties the other.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const packageRoot = path.join(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
const patchPath = path.join(packageRoot, 'cordis.patch.yml');
const patch = fs.readFileSync(patchPath, 'utf8');
const clientSource = fs.readFileSync(path.join(packageRoot, 'client.js'), 'utf8');

test('the exports map resolves the way the host resolves it', () => {
	// The host reads the icon and loads the browser half through the package's own
	// export map, so a typo there is a plugin that installs and then does nothing.
	const require = createRequire(path.join(packageRoot, 'package.json'));
	for (const specifier of ['dsh-image-studio', 'dsh-image-studio/client', 'dsh-image-studio/package.json', 'dsh-image-studio/icon.svg']) {
		const resolved = require.resolve(specifier);
		assert.equal(fs.existsSync(resolved), true, `${specifier} must resolve to a real file`);
		assert.ok(resolved.startsWith(packageRoot), `${specifier} must stay inside the package`);
	}
});

test('the manifest points at files that exist', () => {
	assert.equal(manifest.name, 'dsh-image-studio');
	assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
	assert.equal(manifest.type, 'module');
	assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
	assert.equal(fs.existsSync(patchPath), true);

	for (const file of [manifest.main, manifest.icon, manifest.exports['./client']]) {
		assert.equal(fs.existsSync(path.join(packageRoot, file)), true, `${file} is missing`);
	}
});

test('the patch inserts exactly one row naming this package', () => {
	assert.match(patch, /^- insert:/m, 'the patch must be an insert list');
	const names = [...patch.matchAll(/name:\s*'([^']+)'/g)].map((match) => match[1]);
	assert.deepEqual(names, ['dsh-image-studio']);

	const ids = [...patch.matchAll(/^\s*- id:\s*([A-Za-z0-9_-]+)\s*$/gm)].map((match) => match[1]);
	assert.deepEqual(ids, ['image-studio']);
});

test('the patch carries references only — never a key', () => {
	assert.match(patch, /falKeyRef:\s*FAL_API_KEY/);
	// Comments may say the word "secret"; a live line may not carry one.
	const live = patch.split(/\r?\n/).filter((line) => !line.trim().startsWith('#')).join('\n');
	assert.equal(/(api)?key\s*[:=]\s*\S/i.test(live), false, 'a key value must never be able to live in the patch');
	assert.equal(/sk-|key_[A-Za-z0-9]/.test(live), false, 'a key value must never be able to live in the patch');
});

test('the settings card registers under the bundle name and the patched row id', () => {
	assert.match(clientSource, /key:\s*'dsh-image-studio'/, 'the bundle settings card key must be the package name');
	assert.match(clientSource, /key:\s*'dsh-image-studio#image-studio'/, 'the row settings card key must be <package>#<row>');
});

test('the client half declares the platform and the modules it builds on', () => {
	assert.equal(manifest.dsh.client.platform, 'web');
	assert.equal(manifest.dsh.client.immediately, true);
	assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-layout'));
	assert.ok(manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'));
});

test('the browser half never asks for a secret and never names a provider URL', () => {
	assert.equal(/authorization/i.test(clientSource), false);
	assert.equal(/queue\.fal\.run/.test(clientSource), false);
	assert.equal(/key_id:key_secret/.test(clientSource), true, 'the key placeholder belongs to the input field only');
});

test('the card shows a proper name and description in both languages', () => {
	// The Plugins page takes a bundle's display title and description from the
	// exported locale `meta`, falling back to package.json — and package.json has
	// no title at all, so without these files the card shows the bare package
	// name. This is the regression that made the card look unfinished.
	const expected = [['en', /by Alex Naletko$/], ['ru', /от Алекса Налетко$/]];
	for (const [lang, title] of expected) {
		const file = path.join(packageRoot, 'locale', `${lang}.json`);
		assert.equal(fs.existsSync(file), true, `locale/${lang}.json must exist`);
		const meta = JSON.parse(fs.readFileSync(file, 'utf8')).meta;
		assert.match(meta.title, title);
		assert.ok(meta.description.length > 40, `locale/${lang}.json needs a real description`);
	}
	assert.equal(manifest.exports['./locale/*.json'], './locale/*.json', 'the host reads the locales through the export map');
});

test('the icon is a self-contained drawing', () => {
	const icon = fs.readFileSync(path.join(packageRoot, manifest.icon), 'utf8');
	assert.match(icon, /viewBox="0 0 64 64"/);
	assert.match(icon, /role="img"/);

	// Every paint server and clip path it references must be defined in the file:
	// an unresolved url(#…) renders as no fill at all, which is a plugin icon that
	// silently disappears.
	const ids = new Set([...icon.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
	const refs = [...icon.matchAll(/url\(#([^)]+)\)/g)].map((match) => match[1]);
	assert.ok(refs.length > 0, 'the icon is built from gradients and clips');
	for (const ref of refs) assert.ok(ids.has(ref), `icon.svg references the undefined id "${ref}"`);
});

test('compatibility.json claims only the cores the plugin was built for', () => {
	const compatibility = JSON.parse(fs.readFileSync(path.join(packageRoot, 'compatibility.json'), 'utf8'));
	assert.deepEqual(compatibility.releaseTargets, ['0.2.0-rc.2', '0.2.0-rc.1']);
	assert.equal(compatibility.latestTested, '0.2.0-rc.2');
});
