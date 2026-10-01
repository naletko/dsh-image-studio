/**
 * The update rules, tested without a network.
 *
 * Getting these wrong is quiet and expensive: a version comparison that ranks a
 * prerelease above its release makes the page nag forever, and a spec builder
 * that accepts anything from a caller turns "check for updates" into "install
 * whatever I say".
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { compareVersions, describeUpdate, isCommitish, parseVersion, summarizeCommits, updateSpec } from '../lib/update.js';

test('a version is split into numbers and a prerelease', () => {
	assert.deepEqual(parseVersion('1.2.3'), { numbers: [1, 2, 3], prerelease: '' });
	assert.deepEqual(parseVersion('0.2.0-rc.2'), { numbers: [0, 2, 0], prerelease: 'rc.2' });
	assert.deepEqual(parseVersion('2.1'), { numbers: [2, 1, 0], prerelease: '' });
	assert.deepEqual(parseVersion(undefined), { numbers: [0, 0, 0], prerelease: '' });
});

test('versions compare the way a package manager compares them', () => {
	assert.equal(compareVersions('0.1.2', '0.1.1'), 1);
	assert.equal(compareVersions('0.1.1', '0.1.2'), -1);
	assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
	assert.equal(compareVersions('0.2.0', '0.10.0'), -1);
	assert.equal(compareVersions('1.0.0', '0.9.9'), 1);

	// A release outranks its own prereleases, and prereleases rank among themselves.
	assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
	assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
	assert.equal(compareVersions('1.0.0-rc.2', '1.0.0-rc.1'), 1);
	assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.9'), 1);
	assert.equal(compareVersions('1.0.0-beta', '1.0.0-rc'), -1);
	assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.1'), 0);
});

test('only a real commit hash may travel in an install spec', () => {
	assert.equal(isCommitish('8f6a5d4'), true);
	assert.equal(isCommitish('8f6a5d4d7e39139fc862a3b6ed49842190a4e35e'), true);
	assert.equal(isCommitish('8f6a5'), false, 'too short to be a revision');
	assert.equal(isCommitish('main'), false);
	assert.equal(isCommitish('8f6a5d4; rm -rf /'), false);
	assert.equal(isCommitish(''), false);
	assert.equal(isCommitish(undefined), false);
});

test('the spec names the configured repository and the revision', () => {
	assert.equal(updateSpec('naletko/dsh-image-studio', '8f6a5d4'), 'github:naletko/dsh-image-studio#8f6a5d4');
	assert.equal(updateSpec('naletko/dsh-image-studio', ''), 'github:naletko/dsh-image-studio');
	assert.equal(updateSpec('naletko/dsh-image-studio', undefined), 'github:naletko/dsh-image-studio');
});

test('the spec builder refuses anything that is not owner/name', () => {
	for (const repository of ['naletko', 'naletko/', '', 'https://github.com/naletko/dsh-image-studio', 'naletko/dsh-image-studio --force', null]) {
		assert.throws(() => updateSpec(repository, '8f6a5d4'), /Refusing to build/, `must refuse ${JSON.stringify(repository)}`);
	}
});

test('the notes carry the newest commits, trimmed and bounded', () => {
	const commits = Array.from({ length: 9 }, (_, index) => ({
		sha: `${String(index).repeat(40)}`,
		commit: { message: `subject ${index}\n\nbody`, author: { date: `2026-10-0${index + 1}T00:00:00Z` } },
	}));
	const notes = summarizeCommits(commits);
	assert.equal(notes.length, 6);
	assert.equal(notes[0].message, 'subject 0');
	assert.equal(notes[0].sha.length, 7);
	assert.deepEqual(summarizeCommits(undefined), []);
	assert.deepEqual(summarizeCommits([{ nope: true }]), []);
});

test('a check says an update is available only when the branch is newer', () => {
	const newer = describeUpdate({ repository: 'naletko/dsh-image-studio', current: '0.1.2', latest: '0.1.3', commits: [{ sha: 'a'.repeat(40), commit: { message: 'bump' } }] });
	assert.equal(newer.updateAvailable, true);
	assert.equal(newer.latest, '0.1.3');
	assert.equal(newer.sha, 'aaaaaaa');
	assert.equal(newer.spec, 'github:naletko/dsh-image-studio#aaaaaaa');

	const same = describeUpdate({ repository: 'naletko/dsh-image-studio', current: '0.1.2', latest: '0.1.2', commits: [] });
	assert.equal(same.updateAvailable, false);
	assert.equal(same.spec, 'github:naletko/dsh-image-studio');

	const older = describeUpdate({ repository: 'naletko/dsh-image-studio', current: '0.2.0', latest: '0.1.9', commits: [] });
	assert.equal(older.updateAvailable, false, 'a local build ahead of the branch must not be downgraded');

	// A branch that moved without a version bump still reports its revision, so a
	// person can reinstall the same version deliberately.
	const moved = describeUpdate({ repository: 'naletko/dsh-image-studio', current: '0.1.2', latest: '0.1.2', commits: [{ sha: 'b'.repeat(40), commit: { message: 'docs' } }] });
	assert.equal(moved.updateAvailable, false);
	assert.equal(moved.spec, 'github:naletko/dsh-image-studio#bbbbbbb');
});

test('an unreadable branch manifest falls back to the running version', () => {
	const unknown = describeUpdate({ repository: 'naletko/dsh-image-studio', current: '0.1.2', latest: undefined, commits: undefined });
	assert.equal(unknown.latest, '0.1.2');
	assert.equal(unknown.updateAvailable, false);
	assert.equal(unknown.notes.length, 0);
});
