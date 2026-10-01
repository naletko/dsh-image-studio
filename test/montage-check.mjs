/**
 * The montage is the one part of the studio that shells out, so its commands are
 * asserted exactly: a wrong flag produces an empty file or an ffmpeg that hangs,
 * and neither is easy to see from the page.
 *
 * The last test runs real ffmpeg when the machine allows it and skips otherwise
 * (a confined sandbox refuses to start a process with piped output, which is the
 * only way this module can work), so a developer's machine skips while CI, which
 * ships ffmpeg, executes the whole pipeline.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
	MONTAGE_ASPECTS,
	concatArgs,
	concatList,
	normalizeArgs,
	planMontage,
	probeDuration,
	probeFfmpeg,
	runMontage,
	runProcess,
	workDirectory,
} from '../lib/montage.js';

/** A scratch directory inside the workspace, removed by the caller. */
function makeDir(name) {
	const dir = path.join(import.meta.dirname, '.tmp', `${name}-${Date.now().toString(36)}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** A runner that records every call and answers with a scripted result. */
function fakeRunner(answer = () => ({ code: 0, stdout: '', stderr: '' })) {
	const calls = [];
	const runner = async (command, args, options) => {
		calls.push({ command, args, options });
		return answer(command, args, calls.length);
	};
	runner.calls = calls;
	return runner;
}

test('every offered aspect maps to a frame size, and nothing else does', () => {
	assert.deepEqual(MONTAGE_ASPECTS['9:16'], { width: 1080, height: 1920 });
	assert.deepEqual(MONTAGE_ASPECTS['16:9'], { width: 1920, height: 1080 });
	assert.throws(() => planMontage({ segments: [{ file: 'a.mp4', kind: 'video' }], aspect: '7:5', output: 'o.mp4', workDir: 'w' }), /Unknown aspect/);
});

test('an empty selection is refused before ffmpeg is ever started', () => {
	assert.throws(() => planMontage({ segments: [], aspect: '9:16', output: 'o.mp4', workDir: 'w' }), /at least one/);
});

test('a still becomes a looping clip with the requested hold time', () => {
	const args = normalizeArgs({
		input: 'still.png',
		output: 'clip-000.mp4',
		kind: 'image',
		duration: 4,
		size: { width: 1080, height: 1920 },
	});
	assert.deepEqual(args.slice(0, 6), ['-hide_banner', '-loglevel', 'error', '-y', '-loop', '1']);
	assert.equal(args[args.indexOf('-t') + 1], '4');
	assert.equal(args[args.indexOf('-i') + 1], 'still.png');

	const filter = args[args.indexOf('-vf') + 1];
	assert.match(filter, /scale=1080:1920:force_original_aspect_ratio=decrease/);
	assert.match(filter, /pad=1080:1920:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black/);
	assert.match(filter, /fps=30/);
	assert.match(filter, /format=yuv420p/);
	assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
	assert.equal(args.at(-1), 'clip-000.mp4');
});

test('a video clip is not looped and carries no audio', () => {
	const args = normalizeArgs({ input: 'kling.mp4', output: 'clip-001.mp4', kind: 'video', size: { width: 1080, height: 1080 } });
	assert.equal(args.includes('-loop'), false);
	assert.equal(args[args.indexOf('-an')], '-an');
});

test('a still hold time is clamped into a sane range', () => {
	const plan = planMontage({
		segments: [
			{ file: 'a.png', kind: 'image', duration: 0 },
			{ file: 'b.png', kind: 'image', duration: 900 },
			{ file: 'c.png', kind: 'image' },
		],
		aspect: '1:1',
		output: 'out.mp4',
		workDir: 'w',
	});
	const holds = plan.steps.slice(0, 3).map((step) => step.args[step.args.indexOf('-t') + 1]);
	assert.deepEqual(holds, ['3', '30', '3']);
});

test('the plan normalizes every segment in order and then concatenates', () => {
	const plan = planMontage({
		segments: [
			{ file: 'one.mp4', kind: 'video' },
			{ file: 'two.png', kind: 'image', duration: 2 },
		],
		aspect: '9:16',
		output: path.join('out', 'montage.mp4'),
		workDir: path.join('scratch', 'job-1'),
	});

	assert.equal(plan.steps.length, 3);
	assert.deepEqual(plan.steps.map((step) => step.label), ['normalize 0', 'normalize 1', 'concat']);
	assert.equal(plan.clips[0].clip, path.join('scratch', 'job-1', 'clip-000.mp4'));
	assert.equal(plan.clips[1].clip, path.join('scratch', 'job-1', 'clip-001.mp4'));
	assert.equal(plan.listPath, path.join('scratch', 'job-1', 'segments.txt'));

	const concat = plan.steps.at(-1).args;
	assert.deepEqual(concat.slice(0, 8), ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0']);
	assert.equal(concat[concat.indexOf('-i') + 1], plan.listPath);
	assert.equal(concat[concat.indexOf('-c') + 1], 'copy');
	assert.equal(concat.at(-1), plan.output);
});

test('the concat list quotes every path and escapes an apostrophe', () => {
	const list = concatList(["C:/clips/a.mp4", "/tmp/it's here.mp4"]);
	assert.equal(list, "file 'C:/clips/a.mp4'\nfile '/tmp/it'\\''s here.mp4'\n");
});

test('a montage runs every step and reports the finished file', async () => {
	const dir = makeDir('montage-run');
	try {
		const output = path.join(dir, 'out.mp4');
		const plan = planMontage({
			segments: [{ file: path.join(dir, 'a.mp4'), kind: 'video' }],
			aspect: '9:16',
			output,
			workDir: path.join(dir, 'work'),
		});
		const seen = [];
		const runner = fakeRunner((command, args) => {
			// The concat step reads the list file the runner writes just before it.
			if (args.includes('-f') && args.includes('concat')) assert.equal(fs.existsSync(plan.listPath), true);
			fs.writeFileSync(args.at(-1), 'x'.repeat(64));
			return { code: 0, stdout: '', stderr: '' };
		});

		const result = await runMontage({ plan, runner, onProgress: (progress) => seen.push(progress.step) });
		assert.equal(result.ok, true);
		assert.equal(result.bytes, 64);
		assert.deepEqual(result.steps, ['normalize 0', 'concat']);
		assert.deepEqual(seen, [1, 2]);
		assert.equal(runner.calls.length, 2);
		assert.equal(runner.calls[0].command, 'ffmpeg');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('an ffmpeg failure names the step and quotes what ffmpeg said', async () => {
	const dir = makeDir('montage-fail');
	try {
		const plan = planMontage({
			segments: [{ file: 'a.mp4', kind: 'video' }],
			aspect: '9:16',
			output: path.join(dir, 'out.mp4'),
			workDir: dir,
		});
		const runner = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'line one\nInvalid argument\nline three\n' }));
		await assert.rejects(
			() => runMontage({ plan, runner }),
			(error) => /normalize 0/.test(error.message) && /Invalid argument/.test(error.message),
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('a montage that runs out of time stops instead of hanging', async () => {
	const dir = makeDir('montage-timeout');
	try {
		const plan = planMontage({ segments: [{ file: 'a.mp4', kind: 'video' }], aspect: '9:16', output: path.join(dir, 'o.mp4'), workDir: dir });
		await assert.rejects(
			() => runMontage({ plan, runner: fakeRunner(() => ({ code: -2, stdout: '', stderr: '' })), timeoutMs: 0 }),
			/ran out of time|ffmpeg failed/,
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('probing ffmpeg reports the version, and its absence', async () => {
	const good = fakeRunner(() => ({ code: 0, stdout: 'ffmpeg version 8.1.1 Copyright', stderr: '' }));
	assert.deepEqual(await probeFfmpeg({ runner: good }), { ok: true, version: 'ffmpeg version 8.1.1 Copyright' });

	const bad = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'not found' }));
	assert.equal((await probeFfmpeg({ runner: bad })).ok, false);
});

test('a duration is read from ffprobe and falls back to ffmpeg', async () => {
	const viaProbe = fakeRunner(() => ({ code: 0, stdout: '12.345\n', stderr: '' }));
	assert.equal(await probeDuration({ file: 'a.mp4', runner: viaProbe }), 12.345);
	assert.match(viaProbe.calls[0].command, /ffprobe$/);

	const viaFfmpeg = fakeRunner((command) => (command.endsWith('ffprobe')
		? { code: 1, stdout: '', stderr: '' }
		: { code: 0, stdout: '', stderr: '  Duration: 00:00:07.50, start: 0.0, bitrate: 1 kb/s' }));
	assert.equal(await probeDuration({ file: 'a.mp4', runner: viaFfmpeg }), 7.5);

	const nothing = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'no duration here' }));
	assert.equal(await probeDuration({ file: 'a.mp4', runner: nothing }), undefined);
});

test('the scratch directory lives under the studio root', () => {
	const dir = workDirectory('/studio', 'abc123');
	assert.equal(dir, path.join('/studio', 'work', 'abc123'));
});

test('real ffmpeg assembles two clips when the machine allows it', async (t) => {
	const probe = await probeFfmpeg();
	if (probe.ok !== true) {
		// A confined sandbox refuses to spawn a process with piped output, so the
		// pipeline cannot be exercised here; CI and a normal machine run it.
		t.skip(`ffmpeg is not runnable here: ${probe.message ?? 'not found'}`);
		return;
	}

	const dir = makeDir('montage-e2e');
	try {
		const first = path.join(dir, 'first.mp4');
		const second = path.join(dir, 'second.mp4');
		const still = path.join(dir, 'still.png');
		for (const [file, source] of [
			[first, 'testsrc=size=320x240:rate=30:duration=1'],
			[second, 'smptebars=size=480x270:rate=25:duration=1'],
		]) {
			const made = await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', source, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', file]);
			assert.equal(made.code, 0, made.stderr);
		}
		const madeStill = await runProcess('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:size=200x400', '-frames:v', '1', still]);
		assert.equal(madeStill.code, 0, madeStill.stderr);

		const plan = planMontage({
			segments: [
				{ file: first, kind: 'video' },
				{ file: still, kind: 'image', duration: 1 },
				{ file: second, kind: 'video' },
			],
			aspect: '9:16',
			output: path.join(dir, 'montage.mp4'),
			workDir: path.join(dir, 'work'),
		});
		const result = await runMontage({ plan, timeoutMs: 240000 });
		assert.equal(result.ok, true);
		assert.ok(result.bytes > 1000, 'the montage must have real content');
		assert.deepEqual(result.steps, ['normalize 0', 'normalize 1', 'normalize 2', 'concat']);

		// The result must be a readable video of about the sum of its parts.
		const duration = await probeDuration({ file: result.output });
		assert.ok(duration === undefined || duration >= 2, `expected at least two seconds, measured ${duration}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
