/**
 * Update checking for a plugin that was installed from Git.
 *
 * A Git install has no registry to ask and no version picker in the interface,
 * so the plugin asks GitHub itself: the branch's `package.json` says what the
 * newest version is, the commits endpoint says which revision it is and what
 * changed since. The actual upgrade is then handed to the harness plug-in
 * manager, which owns pnpm, the profile lock, and the rollback — this module
 * only decides *whether* there is something to install and *what* to ask for.
 *
 * Everything here is pure so the rules can be tested without a network.
 */

/** How long a check stays fresh before the page may ask GitHub again. */
export const UPDATE_CHECK_TTL_MS = 5 * 60 * 1000;

/** Longest commit list kept for the "what's new" note. */
const MAX_NOTES = 6;

/**
 * Split a version into comparable parts.
 *
 * @param value - a version such as `1.2.3` or `0.2.0-rc.2`.
 * @returns `{ numbers, prerelease }`.
 */
export function parseVersion(value) {
	const text = typeof value === 'string' ? value.trim() : '';
	const [core, ...rest] = text.split('-');
	const numbers = core.split('.').map((part) => {
		const parsed = Number.parseInt(part, 10);
		return Number.isFinite(parsed) ? parsed : 0;
	});
	while (numbers.length < 3) numbers.push(0);
	return { numbers: numbers.slice(0, 3), prerelease: rest.join('-') };
}

/**
 * Compare two versions the way a package manager would.
 *
 * A release outranks its own prereleases (`1.0.0` > `1.0.0-rc.1`), and two
 * prereleases compare segment by segment, numerically when both segments are
 * numbers.
 *
 * @param a - left version.
 * @param b - right version.
 * @returns -1 when a < b, 0 when equal, 1 when a > b.
 */
export function compareVersions(a, b) {
	const left = parseVersion(a);
	const right = parseVersion(b);
	for (let index = 0; index < 3; index += 1) {
		if (left.numbers[index] !== right.numbers[index]) return left.numbers[index] < right.numbers[index] ? -1 : 1;
	}
	if (left.prerelease === right.prerelease) return 0;
	if (left.prerelease === '') return 1;
	if (right.prerelease === '') return -1;

	const leftParts = left.prerelease.split('.');
	const rightParts = right.prerelease.split('.');
	const length = Math.max(leftParts.length, rightParts.length);
	for (let index = 0; index < length; index += 1) {
		const one = leftParts[index];
		const two = rightParts[index];
		if (one === two) continue;
		if (one === undefined) return -1;
		if (two === undefined) return 1;
		const oneNumber = Number.parseInt(one, 10);
		const twoNumber = Number.parseInt(two, 10);
		const bothNumeric = String(oneNumber) === one && String(twoNumber) === two;
		if (bothNumeric) return oneNumber < twoNumber ? -1 : 1;
		return one < two ? -1 : 1;
	}
	return 0;
}

/**
 * Whether a revision looks like the commit hash the install spec may carry.
 *
 * The spec is built here and never accepted from a caller, so this check is the
 * one thing that keeps a hand-crafted request from asking pnpm for something
 * else entirely.
 *
 * @param value - candidate hash.
 * @returns true for 7–40 hexadecimal characters.
 */
export function isCommitish(value) {
	return typeof value === 'string' && /^[0-9a-f]{7,40}$/.test(value);
}

/**
 * Build the install spec for one revision of one repository.
 *
 * @param repository - `owner/name`.
 * @param sha - commit hash, or an empty string to follow the branch.
 * @returns the spec handed to the plugin manager.
 */
export function updateSpec(repository, sha) {
	if (typeof repository !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
		throw new Error(`Refusing to build an update spec for "${repository}"`);
	}
	return isCommitish(sha) ? `github:${repository}#${sha}` : `github:${repository}`;
}

/**
 * Turn GitHub's commit list into the short "what's new" note.
 *
 * @param commits - the commits endpoint payload.
 * @returns `[{ sha, message, date }]`, newest first, bounded.
 */
export function summarizeCommits(commits) {
	if (!Array.isArray(commits)) return [];
	return commits.slice(0, MAX_NOTES).map((entry) => ({
		sha: typeof entry?.sha === 'string' ? entry.sha.slice(0, 7) : '',
		message: typeof entry?.commit?.message === 'string' ? entry.commit.message.split('\n')[0] : '',
		date: typeof entry?.commit?.author?.date === 'string' ? entry.commit.author.date : undefined,
	})).filter((note) => note.sha !== '');
}

/**
 * Decide what the response of a check should say.
 *
 * @param options.repository - `owner/name` the plugin came from.
 * @param options.current - version this process is running.
 * @param options.latest - version on the branch, or undefined when unknown.
 * @param options.commits - the commits endpoint payload.
 * @param options.now - clock, for tests.
 * @returns the payload the page reads.
 */
export function describeUpdate({ repository, current, latest, commits, now = Date.now() }) {
	const known = typeof latest === 'string' && latest.trim() !== '';
	const notes = summarizeCommits(commits);
	const sha = notes[0]?.sha;
	const comparison = known ? compareVersions(latest, current) : 0;
	return {
		repository,
		current,
		latest: known ? latest : current,
		sha,
		checkedAt: now,
		updateAvailable: known && comparison > 0,
		// A branch that moved without a version bump still has something to say,
		// so the note is carried even when the numbers match.
		notes,
		spec: updateSpec(repository, sha),
	};
}
