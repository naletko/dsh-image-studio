/**
 * dsh-image-studio — host half.
 *
 * The plugin turns fal.ai into a first-class studio inside DeepSeek Harness:
 * one HTTP surface the Images page talks to, one on-disk gallery, and one place
 * where the fal key lives — the harness credential store, never a config file
 * and never a response body.
 *
 * Surface (all under `/api/image-studio`, all loopback-only):
 *
 *   GET  /state                          catalogue, defaults, credential status, counts
 *   GET  /gallery?kind=&q=&favorite=     the index the page renders
 *   GET  /file?id=                       media bytes for one entry
 *   POST /credentials                    store or clear the fal key (write-only)
 *   POST /config                         non-secret defaults
 *   POST /generate                       queue a text-to-image job
 *   POST /video                          queue an image-to-video (Kling) job
 *   GET  /job?id=                        job progress and results
 *   POST /favorite, POST /delete         gallery housekeeping
 *
 * A generation is submitted to fal's queue and polled by a background task, so a
 * request never blocks on rendering and the page can be closed and reopened
 * while the images are still coming.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
	ASPECTS,
	DEFAULT_IMAGE_MODEL,
	DEFAULT_VIDEO_MODEL,
	IMAGE_MODELS,
	TEMPLATES,
	VIDEO_DURATIONS,
	VIDEO_MODELS,
	buildImageInput,
	buildVideoInput,
	clampCount,
	extractImages,
	extractVideo,
	isKnownAspect,
	resolveModel,
} from './lib/catalog.js';
import { FalError, falKeyProblem, falWait, fetchBytes } from './lib/fal.js';
import {
	UPDATE_CHECK_TTL_MS,
	describeUpdate,
	updateSpec,
} from './lib/update.js';
import {
	MONTAGE_ASPECTS,
	cleanup as cleanupMontage,
	newMontageId,
	planMontage,
	probeFfmpeg,
	resolveFfmpeg,
	runMontage,
	workDirectory as montageWorkDirectory,
} from './lib/montage.js';
import {
	addEntries,
	entryPath,
	extensionForMime,
	isSafeId,
	newId,
	pruneMissing,
	readIndex,
	removeEntry,
	setFavorite,
	studioRoot,
	writeEntryFile,
} from './lib/gallery.js';

// The plan is deliberately narrow: `webServer` for the HTTP surface, and
// `credentials` because the fal key is read and written through the harness
// credential seam. Declaring a service here is what makes reading it legal —
// Cordis throws `cannot get property "credentials" without inject` otherwise,
// which is exactly how the live desktop taught this plugin its lesson.
export const inject = ['webServer', 'credentials'];

/** Default credential reference holding the fal key. */
const DEFAULT_FAL_KEY_REF = 'FAL_API_KEY';

/** Credential references a caller may write through this plugin. */
const WRITABLE_REFS = new Set([DEFAULT_FAL_KEY_REF]);

/** Largest request body accepted on the JSON routes. */
const MAX_BODY_BYTES = 256 * 1024;

/** Job records kept in memory; the media itself is on disk. */
const MAX_JOBS = 100;

/** Defaults for everything the profile patch may override. */
const DEFAULTS = {
	falKeyRef: DEFAULT_FAL_KEY_REF,
	defaultModel: DEFAULT_IMAGE_MODEL,
	defaultAspect: '1:1',
	defaultCount: 1,
	imageTimeoutMs: 240000,
	videoTimeoutMs: 900000,
	ffmpegPath: '',
	updateRepo: 'naletko/dsh-image-studio',
	updateCheck: true,
};

/**
 * The plugin's own version, read once when the row mounts.
 *
 * A plugin installed from Git has no registry to ask, and "did my update land?"
 * is otherwise answered by reading files on disk — so the page shows the version
 * it is actually running.
 *
 * @returns the version string, or `0.0.0` when the manifest cannot be read.
 */
function readOwnVersion() {
	try {
		const manifest = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
		return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

/**
 * Mount the studio.
 *
 * @param ctx - the harness context.
 * @param config - the row's configuration from the profile patch.
 */
export function apply(ctx, config) {
	const root = studioRoot();
	const version = readOwnVersion();
	const live = { ...DEFAULTS, ...pickConfig(loadStoredConfig(root)), ...pickConfig(config) };

	/** In-memory job table: the page polls it, nothing else reads it. */
	const jobs = new Map();

	const sendJson = (res, status, body) => {
		const json = JSON.stringify(body);
		res.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': Buffer.byteLength(json),
			'Cache-Control': 'no-store',
		});
		res.end(json);
	};

	const readBody = (req) => new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error('Request body is too large'));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			if (chunks.length === 0) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (error) {
				reject(new Error(`Invalid JSON payload: ${error.message}`));
			}
		});
		req.on('error', reject);
	});

	/**
	 * The credential service, when this deployment mounts one.
	 *
	 * Reading an undeclared service throws in Cordis, and a deployment without a
	 * credential store should still get the gallery and the montage, so the read
	 * is guarded: an absent seam degrades to "no key configured here" instead of
	 * failing every route.
	 */
	const credentials = () => {
		try {
			return ctx.credentials;
		} catch {
			return undefined;
		}
	};

	/**
	 * Whether ffmpeg is usable, probed once per process: the montage action is
	 * hidden rather than offered when the machine cannot run it.
	 */
	let ffmpegProbe;
	const ffmpegInfo = async () => {
		if (ffmpegProbe === undefined) {
			ffmpegProbe = probeFfmpeg({ executable: resolveFfmpeg({ override: live.ffmpegPath }) })
				.catch((error) => ({ ok: false, version: undefined, message: error instanceof Error ? error.message : String(error) }));
		}
		return ffmpegProbe;
	};

	/**
	 * The harness plugin manager, when this deployment mounts one.
	 *
	 * The upgrade is handed to it rather than run here: the manager owns pnpm,
	 * the profile lock, and the rollback of a failed install, and a plugin that
	 * replaced its own files would be guessing at all three.
	 */
	let pluginManager;
	ctx.inject(['pluginManager'], (scope) => {
		pluginManager = scope.pluginManager;
		return () => {
			pluginManager = undefined;
		};
	});

	/** Last check result, kept so a page reopen does not re-ask GitHub. */
	let updateCache;
	/** The upgrade this process started, if any. */
	let lastUpdate;

	/**
	 * Ask GitHub what the branch holds.
	 *
	 * @param options.force - ignore the cache.
	 * @returns the payload the page renders.
	 */
	const checkForUpdate = async ({ force = false } = {}) => {
		if (!force && updateCache !== undefined && Date.now() - updateCache.at < UPDATE_CHECK_TTL_MS) return updateCache.payload;
		const repository = live.updateRepo;
		const manifestResponse = await fetch(`https://raw.githubusercontent.com/${repository}/main/package.json`, {
			headers: { 'user-agent': `dsh-image-studio/${version}` },
			signal: AbortSignal.timeout(10000),
		});
		if (!manifestResponse.ok) throw new Error(`Cannot reach ${repository} on GitHub (HTTP ${manifestResponse.status})`);
		const manifest = await manifestResponse.json();

		let commits;
		try {
			const commitsResponse = await fetch(`https://api.github.com/repos/${repository}/commits?per_page=6`, {
				headers: { accept: 'application/vnd.github+json', 'user-agent': `dsh-image-studio/${version}` },
				signal: AbortSignal.timeout(10000),
			});
			if (commitsResponse.ok) commits = await commitsResponse.json();
		} catch {
			// The note is a convenience: a rate-limited API still leaves a usable check.
		}

		const payload = describeUpdate({ repository, current: version, latest: manifest?.version, commits });
		updateCache = { at: Date.now(), payload };
		return payload;
	};

	/**
	 * Resolve the fal key: the credential store first, the launch environment
	 * last. The value is read per call, so rotating the key needs no restart.
	 *
	 * @returns `{ value, source }`; value is empty when nothing is configured.
	 */
	const resolveFalKey = async () => {
		const ref = live.falKeyRef;
		const service = credentials();
		if (service !== undefined && typeof service.resolve === 'function') {
			try {
				const hit = await service.resolve(ref);
				if (hit !== undefined && typeof hit.value === 'string' && hit.value !== '') {
					return { value: hit.value, source: hit.source ?? 'store' };
				}
			} catch {
				// A broken store falls through to the environment rather than
				// failing a call that only needed a key.
			}
		}
		const fromEnv = typeof process.env[ref] === 'string' ? process.env[ref].trim() : '';
		return { value: fromEnv, source: fromEnv === '' ? undefined : 'env' };
	};

	/**
	 * Report whether the key is set, where it came from, and whether this plugin
	 * may write it — never the value itself.
	 */
	const describeKey = async () => {
		const ref = live.falKeyRef;
		const service = credentials();
		if (service !== undefined && typeof service.describe === 'function') {
			try {
				const info = await service.describe(ref);
				if (info !== undefined && info.configured === true) {
					return { configured: true, source: info.source ?? 'store', writable: info.writable === true };
				}
			} catch {
				// Reported as unconfigured below, which is what the page acts on.
			}
		}
		const fromEnv = typeof process.env[ref] === 'string' && process.env[ref].trim() !== '';
		return { configured: fromEnv, source: fromEnv ? 'env' : undefined, writable: fromEnv ? false : service !== undefined };
	};

	/** Store or clear the fal key through the credential seam. */
	const writeKey = async (value) => {
		const service = credentials();
		if (service === undefined || typeof service.set !== 'function') {
			throw new Error('This deployment has no credential store, so the key cannot be saved from here');
		}
		const trimmed = String(value ?? '').trim();
		if (trimmed === '') await service.unset(live.falKeyRef);
		else await service.set(live.falKeyRef, trimmed);
		return describeKey();
	};

	/** Add one job and keep the table bounded. */
	const createJob = (job) => {
		jobs.set(job.id, job);
		while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
		return job;
	};

	/**
	 * Store one downloaded medium under a fresh id.
	 *
	 * @param meta - gallery fields except the id, extension, mime, and byte count.
	 * @param bytes - the media itself.
	 * @param contentType - type reported by the provider or the download.
	 * @param fallbackExt - extension used when the type is unknown.
	 * @returns the stored entry.
	 */
	const storeMedia = (meta, bytes, contentType, fallbackExt) => writeEntryFile(root, {
		id: newId(),
		bytes,
		ext: extensionForMime(contentType, fallbackExt),
		meta,
	});

	/**
	 * Run one text-to-image job: submit, poll, download every produced image,
	 * append them to the gallery, and report progress as the queue moves.
	 */
	const runImageJob = async (job) => {
		try {
			const key = await resolveFalKey();
			const problem = falKeyProblem(key.value);
			if (problem !== undefined) throw new FalError(problem, 'fal-key-missing');

			const model = resolveModel(job.request.model, 'image');
			const input = buildImageInput({
				model,
				prompt: job.request.prompt,
				aspect: job.request.aspect,
				count: job.request.count,
				quality: job.request.quality,
				resolution: job.request.resolution,
				seed: job.request.seed,
			});

			job.status = 'running';
			const result = await falWait({
				slug: model.id,
				input,
				apiKey: key.value,
				timeoutMs: live.imageTimeoutMs,
				onProgress: (progress) => {
					job.queuePosition = progress.queuePosition;
					job.providerStatus = progress.status;
					job.requestId = progress.requestId;
				},
			});

			const produced = extractImages(result);
			if (produced.length === 0) throw new FalError('fal finished without returning an image.', 'fal-empty-result');

			const entries = [];
			for (const [index, item] of produced.entries()) {
				const fetched = await fetchBytes(item.url);
				entries.push(storeMedia({
					createdAt: Date.now(),
					index,
					kind: 'image',
					prompt: job.request.prompt,
					model: model.id,
					modelLabel: model.label,
					aspect: job.request.aspect,
					width: item.width,
					height: item.height,
					sourceUrl: item.url,
				}, fetched.bytes, item.contentType ?? fetched.contentType, 'png'));
			}
			addEntries(root, entries);
			job.items = entries;
			job.status = 'done';
		} catch (error) {
			job.status = 'error';
			job.error = describeError(error);
		}
	};

	/**
	 * Run one video job. An image-to-video endpoint receives the chosen still as
	 * a data URI, which is how fal accepts a local file without an upload step.
	 */
	const runVideoJob = async (job) => {
		try {
			const key = await resolveFalKey();
			const problem = falKeyProblem(key.value);
			if (problem !== undefined) throw new FalError(problem, 'fal-key-missing');

			const model = resolveModel(job.request.model, 'video');
			let dataUri;
			if (model.needsImage) {
				const entry = readIndex(root).items.find((item) => item.id === job.request.id);
				if (entry === undefined) throw new Error('That image is no longer in the gallery');
				const bytes = fs.readFileSync(entryPath(root, entry));
				dataUri = `data:${entry.mime};base64,${bytes.toString('base64')}`;
			}

			const input = buildVideoInput({
				model,
				prompt: job.request.prompt,
				aspect: job.request.aspect,
				duration: job.request.duration,
				imageDataUri: dataUri,
			});

			job.status = 'running';
			const result = await falWait({
				slug: model.id,
				input,
				apiKey: key.value,
				timeoutMs: live.videoTimeoutMs,
				pollIntervalMs: 4000,
				onProgress: (progress) => {
					job.queuePosition = progress.queuePosition;
					job.providerStatus = progress.status;
					job.requestId = progress.requestId;
				},
			});

			const video = extractVideo(result);
			if (video === undefined) throw new FalError('fal finished without returning a video.', 'fal-empty-result');

			const fetched = await fetchBytes(video.url);
			const entry = storeMedia({
				createdAt: Date.now(),
				index: 0,
				kind: 'video',
				prompt: job.request.prompt ?? '',
				model: model.id,
				modelLabel: model.label,
				aspect: job.request.aspect,
				duration: job.request.duration,
				sourceImageId: job.request.id,
				sourceUrl: video.url,
			}, fetched.bytes, video.contentType ?? fetched.contentType, 'mp4');
			addEntries(root, [entry]);
			job.items = [entry];
			job.status = 'done';
		} catch (error) {
			job.status = 'error';
			job.error = describeError(error);
		}
	};

	/**
	 * Run one montage: normalize every chosen entry into a uniform clip, join
	 * them, and store the result in the gallery like any other video.
	 */
	const runMontageJob = async (job) => {
		const workDir = montageWorkDirectory(root, job.id);
		try {
			const executable = resolveFfmpeg({ override: live.ffmpegPath });
			const probe = await ffmpegInfo();
			if (probe.ok !== true) {
				throw new Error(`ffmpeg is not available on this machine${probe.message ? `: ${probe.message}` : ''}`);
			}

			const index = readIndex(root);
			const chosen = job.request.ids
				.map((id) => index.items.find((item) => item.id === id))
				.filter((entry) => entry !== undefined);
			if (chosen.length === 0) throw new Error('Pick at least one clip or still to assemble');

			fs.mkdirSync(workDir, { recursive: true });
			const plan = planMontage({
				segments: chosen.map((entry) => ({
					file: entryPath(root, entry),
					kind: entry.kind === 'image' ? 'image' : 'video',
					duration: entry.kind === 'image' ? job.request.stillSeconds : undefined,
				})),
				aspect: job.request.aspect,
				output: path.join(workDir, `montage-${job.id}.mp4`),
				workDir,
			});

			job.status = 'running';
			job.totalSteps = plan.steps.length;
			const result = await runMontage({
				plan,
				executable,
				onProgress: (progress) => {
					job.step = progress.step;
					job.totalSteps = progress.total;
					job.stepLabel = progress.label;
				},
			});

			const entry = storeMedia({
				createdAt: Date.now(),
				index: 0,
				kind: 'video',
				prompt: job.request.ids.length > 0 ? (chosen[0].prompt ?? '') : '',
				model: 'ffmpeg-montage',
				modelLabel: 'Montage',
				aspect: job.request.aspect,
				sourceImageId: chosen[0].id,
				segmentIds: chosen.map((item) => item.id),
			}, fs.readFileSync(result.output), 'video/mp4', 'mp4');
			addEntries(root, [entry]);
			job.items = [entry];
			job.status = 'done';
		} catch (error) {
			job.status = 'error';
			job.error = describeError(error);
		} finally {
			cleanupMontage(workDir);
		}
	};

	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: '/api/image-studio',
		handler: async (req, res) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			const route = url.pathname.slice('/api/image-studio'.length) || '/';
			const method = req.method ?? 'GET';

			// Every route here can read a person's media or spend their credits,
			// so the whole surface answers loopback callers only.
			if (!isLocalRequest(req)) {
				sendJson(res, 403, { ok: false, error: 'This endpoint only answers requests from this machine' });
				return;
			}

			try {
				if (route === '/state' && method === 'GET') {
					const index = pruneMissing(root);
					sendJson(res, 200, {
						ok: true,
						version,
						config: {
							falKeyRef: live.falKeyRef,
							defaultModel: live.defaultModel,
							defaultAspect: live.defaultAspect,
							defaultCount: live.defaultCount,
						},
						catalog: {
							imageModels: IMAGE_MODELS,
							videoModels: VIDEO_MODELS,
							aspects: ASPECTS,
							durations: VIDEO_DURATIONS,
							templates: TEMPLATES,
							montageAspects: Object.keys(MONTAGE_ASPECTS),
							defaultImageModel: DEFAULT_IMAGE_MODEL,
							defaultVideoModel: DEFAULT_VIDEO_MODEL,
						},
						credentials: { fal: await describeKey() },
						storage: { root },
						tools: { ffmpeg: await ffmpegInfo() },
						stats: summarize(index.items),
					});
					return;
				}

				if (route === '/gallery' && method === 'GET') {
					const index = pruneMissing(root);
					const kind = url.searchParams.get('kind') ?? '';
					const favorite = url.searchParams.get('favorite') === 'true';
					const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
					const items = index.items.filter((item) => {
						if ((kind === 'image' || kind === 'video') && item.kind !== kind) return false;
						if (favorite && item.favorite !== true) return false;
						if (query !== '') {
							const haystack = `${item.prompt ?? ''} ${item.modelLabel ?? ''} ${item.model ?? ''}`.toLowerCase();
							if (!haystack.includes(query)) return false;
						}
						return true;
					});
					sendJson(res, 200, { ok: true, items: items.map(publicEntry) });
					return;
				}

				if (route === '/file' && method === 'GET') {
					const id = url.searchParams.get('id') ?? '';
					const entry = readIndex(root).items.find((item) => item.id === id);
					if (entry === undefined) {
						sendJson(res, 404, { ok: false, error: 'No such media' });
						return;
					}
					const file = entryPath(root, entry);
					if (!fs.existsSync(file)) {
						sendJson(res, 404, { ok: false, error: 'That file is missing from disk' });
						return;
					}
					const stat = fs.statSync(file);
					res.writeHead(200, {
						'Content-Type': entry.mime,
						'Content-Length': stat.size,
						'Cache-Control': 'private, max-age=60',
					});
					fs.createReadStream(file).pipe(res);
					return;
				}

				if (route === '/credentials' && method === 'POST') {
					const body = await readBody(req);
					const ref = String(body.ref ?? DEFAULT_FAL_KEY_REF);
					if (!WRITABLE_REFS.has(ref)) {
						sendJson(res, 400, { ok: false, error: `This plugin only stores ${[...WRITABLE_REFS].join(', ')}` });
						return;
					}
					const info = await writeKey(body.value);
					sendJson(res, 200, { ok: true, credentials: { fal: info } });
					return;
				}

				if (route === '/config' && method === 'POST') {
					const body = await readBody(req);
					if (typeof body.defaultModel === 'string' && resolveModel(body.defaultModel, 'image') !== undefined) {
						live.defaultModel = body.defaultModel;
					}
					if (typeof body.defaultAspect === 'string' && isKnownAspect(body.defaultAspect)) live.defaultAspect = body.defaultAspect;
					if (body.defaultCount !== undefined) live.defaultCount = clampCount(body.defaultCount, live.defaultCount);
					writeStoredConfig(root, pickConfig(live));
					sendJson(res, 200, {
						ok: true,
						config: {
							falKeyRef: live.falKeyRef,
							defaultModel: live.defaultModel,
							defaultAspect: live.defaultAspect,
							defaultCount: live.defaultCount,
						},
					});
					return;
				}

				if (route === '/update' && method === 'GET') {
					if (live.updateCheck !== true) {
						sendJson(res, 200, { ok: true, enabled: false, current: version, repository: live.updateRepo });
						return;
					}
					const payload = await checkForUpdate({ force: url.searchParams.get('force') === '1' });
					sendJson(res, 200, {
						ok: true,
						enabled: true,
						...payload,
						manager: pluginManager !== undefined,
						progress: lastUpdate,
					});
					return;
				}

				if (route === '/update/apply' && method === 'POST') {
					const payload = await checkForUpdate({ force: true });
					if (typeof payload.sha !== 'string' || payload.sha === '') {
						sendJson(res, 409, { ok: false, error: 'GitHub did not report a revision to install' });
						return;
					}
					if (pluginManager === undefined || typeof pluginManager.installBundle !== 'function') {
						sendJson(res, 409, {
							ok: false,
							error: 'This deployment has no plugin manager, so update from Plugins → Add plugin',
							spec: payload.spec,
						});
						return;
					}

					// The spec is built from the configured repository and a validated
					// hash — never from the request — so a caller cannot ask pnpm for
					// something else.
					const spec = updateSpec(live.updateRepo, payload.sha);
					lastUpdate = { at: Date.now(), spec, status: 'running' };
					void Promise.resolve()
						.then(() => pluginManager.installBundle(spec, { requestId: `image-studio-update-${Date.now().toString(36)}` }))
						.then((outcome) => {
							lastUpdate = { at: Date.now(), spec, status: 'done', outcome: summarizeOutcome(outcome) };
						})
						.catch((error) => {
							lastUpdate = { at: Date.now(), spec, status: 'error', error: describeError(error) };
						});
					sendJson(res, 202, { ok: true, started: true, spec });
					return;
				}

				if (route === '/generate' && method === 'POST') {
					const body = await readBody(req);
					const prompt = String(body.prompt ?? '').trim();
					if (prompt === '') {
						sendJson(res, 400, { ok: false, error: 'Write a prompt first' });
						return;
					}
					const model = resolveModel(body.model ?? live.defaultModel, 'image');
					if (model === undefined) {
						sendJson(res, 400, { ok: false, error: 'Unknown image model' });
						return;
					}
					const job = createJob({
						id: newJobId(),
						kind: 'image',
						status: 'queued',
						createdAt: Date.now(),
						request: {
							prompt,
							model: model.id,
							aspect: isKnownAspect(body.aspect) ? body.aspect : live.defaultAspect,
							count: clampCount(body.count, model.defaultCount ?? live.defaultCount),
							quality: typeof body.quality === 'string' ? body.quality : undefined,
							resolution: typeof body.resolution === 'string' ? body.resolution : undefined,
							seed: Number.isInteger(body.seed) ? body.seed : undefined,
						},
						items: [],
					});
					void runImageJob(job);
					sendJson(res, 202, { ok: true, job: publicJob(job) });
					return;
				}

				if (route === '/video' && method === 'POST') {
					const body = await readBody(req);
					const model = resolveModel(body.model ?? DEFAULT_VIDEO_MODEL, 'video');
					if (model === undefined) {
						sendJson(res, 400, { ok: false, error: 'Unknown video model' });
						return;
					}
					const sourceId = String(body.id ?? '');
					if (model.needsImage && !isSafeId(sourceId)) {
						sendJson(res, 400, { ok: false, error: 'Pick an image from the gallery first' });
						return;
					}
					const job = createJob({
						id: newJobId(),
						kind: 'video',
						status: 'queued',
						createdAt: Date.now(),
						request: {
							id: model.needsImage ? sourceId : undefined,
							prompt: String(body.prompt ?? '').trim(),
							model: model.id,
							aspect: isKnownAspect(body.aspect) ? body.aspect : live.defaultAspect,
							duration: VIDEO_DURATIONS.includes(String(body.duration)) ? String(body.duration) : '5',
						},
						items: [],
					});
					void runVideoJob(job);
					sendJson(res, 202, { ok: true, job: publicJob(job) });
					return;
				}

				if (route === '/montage' && method === 'POST') {
					const body = await readBody(req);
					const ids = Array.isArray(body.ids)
						? body.ids.filter((id) => typeof id === 'string' && isSafeId(id))
						: [];
					if (ids.length === 0) {
						sendJson(res, 400, { ok: false, error: 'Pick at least one clip or still to assemble' });
						return;
					}
					if (ids.length > 40) {
						sendJson(res, 400, { ok: false, error: 'A montage takes at most 40 segments' });
						return;
					}
					const aspect = typeof body.aspect === 'string' && MONTAGE_ASPECTS[body.aspect] !== undefined
						? body.aspect
						: '9:16';
					const job = createJob({
						id: newJobId(),
						kind: 'montage',
						status: 'queued',
						createdAt: Date.now(),
						request: {
							ids,
							aspect,
							stillSeconds: Number.isFinite(body.stillSeconds) ? body.stillSeconds : undefined,
						},
						items: [],
					});
					void runMontageJob(job);
					sendJson(res, 202, { ok: true, job: publicJob(job) });
					return;
				}

				if (route === '/job' && method === 'GET') {
					const job = jobs.get(url.searchParams.get('id') ?? '');
					if (job === undefined) {
						sendJson(res, 404, { ok: false, error: 'No such job' });
						return;
					}
					sendJson(res, 200, { ok: true, job: publicJob(job) });
					return;
				}

				if (route === '/favorite' && method === 'POST') {
					const body = await readBody(req);
					const updated = setFavorite(root, String(body.id ?? ''), body.favorite === true);
					if (updated === undefined) {
						sendJson(res, 404, { ok: false, error: 'No such entry' });
						return;
					}
					sendJson(res, 200, { ok: true, item: publicEntry(updated) });
					return;
				}

				if (route === '/delete' && method === 'POST') {
					const body = await readBody(req);
					const removed = removeEntry(root, String(body.id ?? ''));
					sendJson(res, 200, { ok: true, removed });
					return;
				}

				sendJson(res, 404, { ok: false, error: `Unknown route ${route}` });
			} catch (error) {
				sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		},
	}), 'image-studio: http surface');
}

/**
 * Whether a request came from this machine.
 *
 * The page is served from the same loopback host, so the origin check only has
 * to reject a browser page that was loaded from somewhere else.
 *
 * @param req - the incoming request.
 * @returns true when the caller is local.
 */
export function isLocalRequest(req) {
	const address = req?.socket?.remoteAddress ?? '';
	const local = address === '' || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
	if (!local) return false;
	const origin = req?.headers?.origin;
	if (typeof origin === 'string' && origin !== '') {
		if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return false;
	}
	return true;
}

/**
 * The public shape of one gallery entry. The stored `sourceUrl` stays private:
 * the page reads media through `/file`, which is what keeps a browser from
 * calling a provider directly.
 *
 * @param entry - a stored entry.
 * @returns the entry as the page receives it.
 */
export function publicEntry(entry) {
	return {
		id: entry.id,
		kind: entry.kind,
		mime: entry.mime,
		url: `/api/image-studio/file?id=${entry.id}`,
		prompt: entry.prompt ?? '',
		model: entry.model ?? '',
		modelLabel: entry.modelLabel ?? entry.model ?? '',
		aspect: entry.aspect ?? '',
		width: entry.width,
		height: entry.height,
		duration: entry.duration,
		bytes: entry.bytes,
		createdAt: entry.createdAt ?? 0,
		favorite: entry.favorite === true,
		sourceImageId: entry.sourceImageId,
	};
}

/** The public shape of one job. */
function publicJob(job) {
	return {
		id: job.id,
		kind: job.kind,
		status: job.status,
		providerStatus: job.providerStatus,
		queuePosition: job.queuePosition,
		step: job.step,
		totalSteps: job.totalSteps,
		stepLabel: job.stepLabel,
		createdAt: job.createdAt,
		error: job.error,
		items: (job.items ?? []).map(publicEntry),
		request: { ...job.request },
	};
}

/** Counts for the page header. */
function summarize(items) {
	return {
		total: items.length,
		images: items.filter((item) => item.kind === 'image').length,
		videos: items.filter((item) => item.kind === 'video').length,
		favorites: items.filter((item) => item.favorite === true).length,
	};
}

/**
 * Keep only the configuration keys this plugin owns, and only when they are
 * well formed. A profile patch is edited by hand, so nothing here is trusted.
 *
 * @param source - a config object, or anything else.
 * @returns the accepted subset.
 */
export function pickConfig(source) {
	const out = {};
	if (source === null || typeof source !== 'object') return out;
	if (typeof source.falKeyRef === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(source.falKeyRef)) out.falKeyRef = source.falKeyRef;
	if (typeof source.defaultModel === 'string') out.defaultModel = source.defaultModel;
	if (typeof source.defaultAspect === 'string' && IS_ASPECT(source.defaultAspect)) out.defaultAspect = source.defaultAspect;
	if (source.defaultCount !== undefined) out.defaultCount = clampCount(source.defaultCount, DEFAULTS.defaultCount);
	if (Number.isFinite(source.imageTimeoutMs)) out.imageTimeoutMs = source.imageTimeoutMs;
	if (Number.isFinite(source.videoTimeoutMs)) out.videoTimeoutMs = source.videoTimeoutMs;
	if (typeof source.ffmpegPath === 'string') out.ffmpegPath = source.ffmpegPath;
	if (typeof source.updateRepo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(source.updateRepo)) out.updateRepo = source.updateRepo;
	if (typeof source.updateCheck === 'boolean') out.updateCheck = source.updateCheck;
	return out;
}

function IS_ASPECT(value) {
	return ASPECTS.includes(value);
}

/** Non-secret settings file, beside the gallery it governs. */
function configPath(root) {
	return path.join(root, 'config.json');
}

function loadStoredConfig(root) {
	try {
		return JSON.parse(fs.readFileSync(configPath(root), 'utf8'));
	} catch {
		return {};
	}
}

function writeStoredConfig(root, config) {
	try {
		fs.mkdirSync(root, { recursive: true });
		const target = configPath(root);
		const temporary = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(config, null, 2), 'utf8');
		fs.renameSync(temporary, target);
	} catch {
		// Settings that cannot be persisted still apply to this process.
	}
}

function newJobId() {
	return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function describeError(error) {
	if (error instanceof FalError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

/**
 * Keep the readable part of a plugin-manager result.
 *
 * The manager's own object is large and may hold references the HTTP layer
 * cannot serialize; the page only needs to know how the attempt ended.
 *
 * @param outcome - what `installBundle` resolved with.
 * @returns a small plain object, or undefined.
 */
export function summarizeOutcome(outcome) {
	if (outcome === null || typeof outcome !== 'object') return undefined;
	const summary = {};
	for (const key of ['stage', 'status', 'enabled', 'warnings', 'reason']) {
		if (outcome[key] !== undefined) summary[key] = outcome[key];
	}
	return summary;
}
