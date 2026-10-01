/**
 * Turning a set of gallery entries into one file with ffmpeg.
 *
 * The plan and the execution are separate on purpose: {@link planMontage}
 * returns plain argument lists, so the exact commands can be asserted in tests
 * and printed for a person to run by hand, while {@link runMontage} only feeds
 * them to ffmpeg and reports what it said.
 *
 * Strategy — normalize first, concatenate second:
 *
 *   1. every segment becomes a uniform clip (same size, frame rate, codec,
 *      pixel format) in a scratch directory; a still becomes a clip by looping
 *      it for its own duration;
 *   2. those clips are joined by the concat demuxer without re-encoding, which
 *      is both fast and lossless at that point.
 *
 * A single giant filtergraph would save one pass and is much easier to get
 * subtly wrong with mixed sources, which is exactly what a gallery holds.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Frame sizes the assemble action offers. */
export const MONTAGE_ASPECTS = {
	'9:16': { width: 1080, height: 1920 },
	'4:5': { width: 1080, height: 1350 },
	'1:1': { width: 1080, height: 1080 },
	'16:9': { width: 1920, height: 1080 },
};

/** Frame rate every normalized clip is rendered at. */
export const MONTAGE_FPS = 30;

/** How long a still is held when the caller does not say. */
export const DEFAULT_STILL_SECONDS = 3;

/** Longest single run accepted, so a typo cannot queue an hour of encoding. */
export const MAX_STILL_SECONDS = 30;

/** The concat demuxer's list file name inside the scratch directory. */
const CONCAT_FILE = 'segments.txt';

/**
 * Resolve the ffmpeg executable.
 *
 * @param options.override - configured path, used when it names a file.
 * @returns the executable to run.
 */
export function resolveFfmpeg({ override } = {}) {
	if (typeof override === 'string' && override.trim() !== '') return override.trim();
	return 'ffmpeg';
}

/**
 * Check that an ffmpeg binary is usable at all.
 *
 * @param options.executable - the binary to run.
 * @param options.runner - process runner; the tests inject one.
 * @returns `{ ok, version }` — version is the first line of `-version`.
 */
export async function probeFfmpeg({ executable = 'ffmpeg', runner = runProcess } = {}) {
	const result = await runner(executable, ['-version'], { timeoutMs: 15000 });
	const first = String(result.stderr || result.stdout || '').split(/\r?\n/)[0].trim();
	if (result.code !== 0 || first === '') {
		return { ok: false, version: undefined, message: first || `ffmpeg exited with ${result.code}` };
	}
	return { ok: true, version: first };
}

/**
 * Read a media file's duration in seconds.
 *
 * Uses ffprobe when it is available and falls back to ffmpeg's own report, so a
 * machine with only ffmpeg still measures its clips.
 *
 * @param options.file - the media file.
 * @param options.executable - ffmpeg binary.
 * @param options.runner - process runner.
 * @returns duration in seconds, or undefined when it cannot be read.
 */
export async function probeDuration({ file, executable = 'ffmpeg', runner = runProcess } = {}) {
	const ffprobe = executable.endsWith('ffmpeg')
		? `${executable.slice(0, -'ffmpeg'.length)}ffprobe`
		: `${executable}-probe`;
	const probed = await runner(ffprobe, [
		'-v', 'error',
		'-show_entries', 'format=duration',
		'-of', 'default=noprint_wrappers=1:nokey=1',
		file,
	], { timeoutMs: 20000 });
	const value = Number.parseFloat(String(probed.stdout || '').trim());
	if (probed.code === 0 && Number.isFinite(value) && value > 0) return value;

	const reported = await runner(executable, ['-hide_banner', '-i', file], { timeoutMs: 20000 });
	const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(reported.stderr || ''));
	if (match === null) return undefined;
	return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Build the command that turns one segment into a uniform clip.
 *
 * @param options.input - source file.
 * @param options.output - clip to write.
 * @param options.kind - 'video' or 'image'.
 * @param options.duration - still duration in seconds; ignored for video.
 * @param options.size - `{ width, height }` of the montage.
 * @param options.fps - frame rate of the montage.
 * @returns the argument list (without the executable).
 */
export function normalizeArgs({ input, output, kind, duration, size, fps = MONTAGE_FPS }) {
	const scale = `scale=${size.width}:${size.height}:force_original_aspect_ratio=decrease,`
		+ `pad=${size.width}:${size.height}:(ow-iw)/2:(oh-ih)/2:color=black,`
		+ `fps=${fps},format=yuv420p,setsar=1`;
	const args = ['-hide_banner', '-loglevel', 'error', '-y'];
	if (kind === 'image') {
		args.push('-loop', '1', '-t', String(clampStill(duration)), '-i', input);
	} else {
		args.push('-i', input);
	}
	args.push(
		'-vf', scale,
		'-an',
		'-c:v', 'libx264',
		'-preset', 'veryfast',
		'-crf', '20',
		// A keyframe every second keeps the later concat honest and makes the
		// result seekable in a browser.
		'-g', String(fps),
		'-movflags', '+faststart',
		output,
	);
	return args;
}

/**
 * Build the concat demuxer's list document.
 *
 * @param files - normalized clip paths, in order.
 * @returns the list file contents.
 */
export function concatList(files) {
	return files
		.map((file) => `file '${String(file).replace(/'/g, "'\\''")}'`)
		.join('\n')
		.concat('\n');
}

/**
 * Build the command that joins normalized clips.
 *
 * @param options.listPath - the concat list file.
 * @param options.output - the montage to write.
 * @returns the argument list.
 */
export function concatArgs({ listPath, output }) {
	return [
		'-hide_banner', '-loglevel', 'error', '-y',
		'-f', 'concat', '-safe', '0', '-i', listPath,
		'-c', 'copy',
		'-movflags', '+faststart',
		output,
	];
}

/**
 * Plan a whole montage.
 *
 * @param options.segments - `[{ file, kind, duration? }]` in playback order.
 * @param options.aspect - one of {@link MONTAGE_ASPECTS}.
 * @param options.output - final file path.
 * @param options.workDir - scratch directory for normalized clips.
 * @param options.fps - frame rate.
 * @param options.keepAudio - reserved; clips are silent by default.
 * @returns `{ size, clips, listPath, steps }` where each step is `{ label, args }`.
 * @throws when there is nothing to assemble or the aspect is unknown.
 */
export function planMontage({ segments, aspect = '9:16', output, workDir, fps = MONTAGE_FPS }) {
	const size = MONTAGE_ASPECTS[aspect];
	if (size === undefined) throw new Error(`Unknown aspect "${aspect}"; use one of ${Object.keys(MONTAGE_ASPECTS).join(', ')}`);
	if (!Array.isArray(segments) || segments.length === 0) throw new Error('Pick at least one clip or still to assemble');

	const clips = segments.map((segment, index) => ({
		...segment,
		index,
		clip: path.join(workDir, `clip-${String(index).padStart(3, '0')}.mp4`),
	}));

	const steps = clips.map((clip) => ({
		label: `normalize ${clip.index}`,
		args: normalizeArgs({
			input: clip.file,
			output: clip.clip,
			kind: clip.kind,
			duration: clip.duration,
			size,
			fps,
		}),
	}));

	const listPath = path.join(workDir, CONCAT_FILE);
	steps.push({ label: 'concat', args: concatArgs({ listPath, output }) });

	return { size, fps, clips, listPath, steps, output };
}

/**
 * Execute a plan.
 *
 * @param options.plan - the result of {@link planMontage}.
 * @param options.executable - ffmpeg binary.
 * @param options.runner - process runner.
 * @param options.onProgress - observer called with `{ step, total, label }`.
 * @param options.timeoutMs - budget for the whole montage.
 * @returns `{ ok, output, bytes, steps }`.
 */
export async function runMontage({ plan, executable = 'ffmpeg', runner = runProcess, onProgress, timeoutMs = 900000 }) {
	fs.mkdirSync(path.dirname(plan.output), { recursive: true });
	fs.mkdirSync(path.dirname(plan.listPath), { recursive: true });
	fs.writeFileSync(plan.listPath, concatList(plan.clips.map((clip) => clip.clip)), 'utf8');

	const deadline = Date.now() + timeoutMs;
	const done = [];
	for (const [index, step] of plan.steps.entries()) {
		onProgress?.({ step: index + 1, total: plan.steps.length, label: step.label });
		const remaining = deadline - Date.now();
		if (remaining <= 0) throw new Error('The montage ran out of time');
		const result = await runner(executable, step.args, { timeoutMs: remaining });
		if (result.code !== 0) {
			const detail = String(result.stderr || '').split(/\r?\n/).filter((line) => line.trim() !== '').slice(-3).join(' ');
			throw new Error(`ffmpeg failed at "${step.label}": ${detail || `exit ${result.code}`}`);
		}
		done.push(step.label);
	}

	const stat = fs.statSync(plan.output);
	return { ok: true, output: plan.output, bytes: stat.size, steps: done };
}

/**
 * Remove a scratch directory, ignoring the case where it is already gone.
 *
 * @param workDir - directory to delete.
 */
export function cleanup(workDir) {
	try {
		fs.rmSync(workDir, { recursive: true, force: true });
	} catch {
		// A leftover scratch directory is noise, not a failure of the montage.
	}
}

/**
 * A scratch directory for one montage, beside the gallery it belongs to.
 *
 * @param root - studio root.
 * @param id - montage id.
 * @returns the directory path.
 */
export function workDirectory(root, id) {
	return path.join(root, 'work', id);
}

/** A fresh montage id. */
export function newMontageId() {
	return crypto.randomBytes(6).toString('hex');
}

/** Clamp a still's hold time into a sane range. */
function clampStill(duration) {
	const value = Number(duration);
	if (!Number.isFinite(value) || value <= 0) return DEFAULT_STILL_SECONDS;
	return Math.min(MAX_STILL_SECONDS, Math.max(1, Math.round(value * 10) / 10));
}

/**
 * Run one process and collect its output.
 *
 * @param command - executable.
 * @param args - argument list.
 * @param options.timeoutMs - how long the process may take.
 * @returns `{ code, stdout, stderr }`.
 */
export function runProcess(command, args, { timeoutMs = 120000 } = {}) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		} catch (error) {
			resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) });
			return;
		}

		let stdout = '';
		let stderr = '';
		let settled = false;
		const finish = (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		};

		const timer = setTimeout(() => {
			try {
				child.kill('SIGKILL');
			} catch {
				// The process is already gone; the timeout still reports below.
			}
			finish(-2);
		}, timeoutMs);

		child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
		child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
		child.on('error', (error) => {
			stderr += error instanceof Error ? error.message : String(error);
			finish(-1);
		});
		child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
	});
}
