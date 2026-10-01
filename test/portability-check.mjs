/**
 * "Works on Windows and macOS" is a claim, so it gets a test.
 *
 * The plugin ships no platform branch, no shell invocation, and no path written
 * with one separator in mind: everything goes through `node:path`, the home
 * directory through `node:os`, and the one external process it starts is ffmpeg
 * by name from PATH (with a configurable absolute path). This suite fails on the
 * first backslash, drive letter, or `process.platform` branch that would quietly
 * make one of the two machines second class.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const packageRoot = path.join(import.meta.dirname, '..');
const SOURCES = ['index.js', 'client.js', 'lib/catalog.js', 'lib/fal.js', 'lib/gallery.js', 'lib/montage.js'];

/** Read one shipped source file. */
function read(relative) {
	return fs.readFileSync(path.join(packageRoot, relative), 'utf8');
}

test('no source embeds a Windows-only path', () => {
	for (const file of SOURCES) {
		const source = read(file);
		// A drive-letter literal, or a path assembled with a backslash, is a path
		// that cannot exist on the other machine.
		for (const [label, pattern] of [
			['drive letter', /["'`][A-Za-z]:[\\/]/],
			['backslash path', /["'`][^"'`\n]*\\\\(?:Users|tmp|var|home|dsh)/],
		]) {
			assert.equal(pattern.test(source), false, `${file} contains a ${label}`);
		}
	}
});

test('no source shells out or branches on the platform', () => {
	for (const file of SOURCES) {
		const source = read(file);
		for (const [label, pattern] of [
			['shell invocation', /\b(execSync|spawnSync|shell:\s*true|cmd\.exe|powershell|cmd\.exe)/],
			['platform branch', /process\.platform/],
			['identity separator', /path\.sep/],
			['raw separator join', /\+ *["'`][\\/]["'`] *\+/],
		]) {
			assert.equal(pattern.test(source), false, `${file} contains a ${label}`);
		}
	}
});

test('every path is built with node:path and every home with node:os', () => {
	for (const file of ['index.js', 'lib/gallery.js', 'lib/montage.js']) {
		const source = read(file);
		assert.match(source, /from 'node:path'/, `${file} must build paths with node:path`);
		assert.equal(/join\(['"]\//.test(source), false, `${file} must not hardcode a separator`);
	}

	// The harness home is resolved once, from the environment or the OS, never
	// from a guessed literal.
	const gallery = read('lib/gallery.js');
	assert.match(gallery, /from 'node:os'/);
	assert.match(gallery, /os\.homedir\(\)/);
	assert.match(gallery, /DSH_HOME/);
});

test('the only external program is ffmpeg, and it is resolved by name', () => {
	const montage = read('lib/montage.js');
	const spawns = [...montage.matchAll(/spawn\(\s*([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
	assert.deepEqual([...new Set(spawns)], ['command'], 'montage spawns exactly the command it was given');

	const resolve = montage.slice(montage.indexOf('export function resolveFfmpeg'), montage.indexOf('export async function probeFfmpeg'));
	assert.match(resolve, /return 'ffmpeg'/, "the default is the bare name, so PATH decides");
	// `.exe` as a suffix, not the `.executable` that appears in the JSDoc.
	assert.equal(/\.exe\b/.test(resolve), false, 'no Windows-only executable suffix');
});

test('the browser half touches no platform-specific API', () => {
	const client = read('client.js');
	for (const pattern of [/navigator\.platform/, /navigator\.userAgent/, /process\.platform/]) {
		assert.equal(pattern.test(client), false, 'the browser half must not sniff the platform');
	}
});
