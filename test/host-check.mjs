/**
 * The host half, driven end to end: a fake harness mounts the plugin, a fake
 * fal queue answers the network, and the test walks the same requests the Images
 * page makes — state, key storage, generation, gallery, favourites, deletion.
 *
 * This is the test that would have caught a route that never answers, a key that
 * leaks into a response, or a generation that never reaches the gallery.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';

import { apply, inject as declaredInject, isLocalRequest, pickConfig, publicEntry } from '../index.js';
import { addEntries, newId, writeEntryFile } from '../lib/gallery.js';

/** A 1×1 PNG, so downloaded media is really an image. */
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
	'base64',
);

/** The manifest this process is running, for version assertions. */
const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));

/**
 * Answer the two GitHub endpoints the updater reads.
 *
 * @param options.version - the version the branch claims.
 * @param options.commits - the commits endpoint payload.
 * @returns a restore function.
 */
function stubGithub({ version = '9.9.9', commits = [{ sha: 'c'.repeat(40), commit: { message: 'make it better' } }] } = {}) {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		const target = String(url);
		if (target.includes('raw.githubusercontent.com')) return new Response(JSON.stringify({ version }), { status: 200 });
		if (target.includes('api.github.com')) return new Response(JSON.stringify(commits), { status: 200 });
		throw new Error(`unexpected fetch ${target}`);
	};
	return () => {
		globalThis.fetch = realFetch;
	};
}

/** An in-memory credential store shaped like the harness seam. */
function fakeCredentials(initial = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		resolve: async (ref) => (store.has(ref) ? { value: store.get(ref), source: 'file' } : undefined),
		describe: async (ref) => ({ configured: store.has(ref), source: store.has(ref) ? 'file' : undefined, writable: true }),
		set: async (ref, value) => { store.set(ref, value); },
		unset: async (ref) => { store.delete(ref); },
	};
}

/** A request object with the surface the handler uses. */
function makeRequest({ url, method = 'GET', body, address = '127.0.0.1', origin }) {
	const req = new EventEmitter();
	req.url = url;
	req.method = method;
	req.headers = origin === undefined ? {} : { origin };
	req.socket = { remoteAddress: address };
	process.nextTick(() => {
		if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
		req.emit('end');
	});
	return req;
}

/**
 * A response object that records what the handler wrote. It is a real Writable
 * so the media route can pipe a file into it.
 */
function makeResponse() {
	const chunks = [];
	const res = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			callback();
		},
	});
	res.statusCode = 0;
	res.headers = {};
	res.writeHead = function writeHead(code, headers) {
		this.statusCode = code;
		Object.assign(this.headers, headers ?? {});
		return this;
	};
	res.end = function end(chunk) {
		if (chunk !== undefined && chunk !== null) chunks.push(Buffer.from(chunk));
		Writable.prototype.end.call(this);
		return this;
	};
	Object.defineProperty(res, 'raw', { get: () => Buffer.concat(chunks) });
	Object.defineProperty(res, 'body', { get: () => Buffer.concat(chunks).toString('utf8') });
	return res;
}

/** Call the handler and resolve once the response has fully settled. */
async function call(handler, request) {
	const response = makeResponse();
	const settled = new Promise((resolve) => {
		if (response.writableFinished) {
			resolve();
			return;
		}
		response.once('finish', resolve);
		// A guard so a handler that forgets to end its response fails the test
		// rather than hanging it.
		setTimeout(resolve, 1000);
	});
	await handler(request, response);
	await settled;
	return response;
}

/**
 * Mount the plugin against a fresh studio root and return its handler.
 *
 * The context reproduces Cordis' central rule: reading a service the plugin did
 * not declare in `inject` throws. Without that the suite would happily pass on a
 * plugin the live harness answers with HTTP 500 — which is exactly what happened
 * before `credentials` was declared.
 *
 * @param options.credentials - an in-memory credential store.
 * @param options.config - the row configuration.
 * @param options.pluginManager - a stand-in for the harness plugin manager.
 * @returns `{ handler, root, credentials }`.
 */
function mount({ credentials = fakeCredentials(), config = {}, pluginManager } = {}) {
	const root = path.join(import.meta.dirname, '.tmp', `host-${newId()}`);
	fs.mkdirSync(root, { recursive: true });
	process.env.DSH_IMAGE_STUDIO_HOME = root;

	let registered;
	const services = {
		webServer: { register: (options) => { registered = options; return () => {}; } },
		credentials,
	};
	if (pluginManager !== undefined) services.pluginManager = pluginManager;

	const ctx = {
		effect: (fn) => fn(),
		// Cordis' `inject(deps, callback)` runs the callback only once every named
		// service exists, which is how the plugin finds the plugin manager without
		// requiring it.
		inject: (deps, callback) => {
			const scope = {};
			let ready = true;
			for (const dep of deps) {
				if (!(dep in services)) {
					ready = false;
					continue;
				}
				Object.defineProperty(scope, dep, { get: () => services[dep] });
			}
			if (ready) callback(scope);
			return () => {};
		},
	};
	for (const name of Object.keys(services)) {
		Object.defineProperty(ctx, name, {
			get() {
				if (!declaredInject.includes(name)) throw new Error(`cannot get property "${name}" without inject`);
				return services[name];
			},
		});
	}

	apply(ctx, config);
	assert.ok(registered, 'the plugin must register its HTTP surface');
	return { handler: registered.handler, root, credentials };
}

/** Parse a JSON response, failing loudly when the body is not JSON. */
function parse(response) {
	return JSON.parse(response.body);
}

/** Answer one poll loop until a job stops changing. */
async function waitForJob(handler, id, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const response = await call(handler, makeRequest({ url: `/api/image-studio/job?id=${id}` }));
		const body = parse(response);
		if (body.job.status === 'done' || body.job.status === 'error') return body.job;
		if (Date.now() > deadline) throw new Error(`job ${id} stayed ${body.job.status}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test('the plugin declares every service it reads', () => {
	// Cordis refuses an undeclared service read, so the declaration list is part
	// of the contract rather than documentation.
	assert.ok(declaredInject.includes('webServer'));
	assert.ok(declaredInject.includes('credentials'));
});

test('a deployment without a credential store still serves the gallery', async () => {
	// The seam is guarded: `credentials` is declared, but a composition that never
	// mounts a provider leaves the property absent at read time.
	const root = path.join(import.meta.dirname, '.tmp', `host-nocreds-${newId()}`);
	fs.mkdirSync(root, { recursive: true });
	process.env.DSH_IMAGE_STUDIO_HOME = root;

	let registered;
	const ctx = { effect: (fn) => fn(), inject: () => () => {} };
	Object.defineProperty(ctx, 'webServer', { get: () => ({ register: (options) => { registered = options; return () => {}; } }) });
	Object.defineProperty(ctx, 'credentials', { get: () => { throw new Error('cannot get property "credentials" without inject'); } });
	apply(ctx, {});

	const response = await call(registered.handler, makeRequest({ url: '/api/image-studio/state' }));
	const body = parse(response);
	assert.equal(response.statusCode, 200, body.error);
	assert.equal(body.credentials.fal.configured, false);
	assert.equal(body.credentials.fal.writable, false);
});

test('a request from another machine is refused', async () => {
	const { handler } = mount();
	const response = await call(handler, makeRequest({ url: '/api/image-studio/state', address: '10.0.0.7' }));
	assert.equal(response.statusCode, 403);
	assert.equal(parse(response).ok, false);
});

test('a browser page loaded elsewhere is refused by its origin', async () => {
	const { handler } = mount();
	const response = await call(handler, makeRequest({ url: '/api/image-studio/state', origin: 'https://evil.example' }));
	assert.equal(response.statusCode, 403);
});

test('isLocalRequest accepts loopback addresses and rejects the rest', () => {
	assert.equal(isLocalRequest(makeRequest({ url: '/', address: '127.0.0.1' })), true);
	assert.equal(isLocalRequest(makeRequest({ url: '/', address: '::1' })), true);
	assert.equal(isLocalRequest(makeRequest({ url: '/', address: '::ffff:127.0.0.1' })), true);
	assert.equal(isLocalRequest(makeRequest({ url: '/', address: '192.168.1.5' })), false);
	assert.equal(isLocalRequest(makeRequest({ url: '/', address: '127.0.0.1', origin: 'http://127.0.0.1:19387' })), true);
	assert.equal(isLocalRequest(makeRequest({ url: '/', address: '127.0.0.1', origin: 'http://localhost:3000' })), true);
	assert.equal(isLocalRequest(makeRequest({ url: '/', address: '127.0.0.1', origin: 'http://127.0.0.1.evil.com' })), false);
});

test('state reports the catalogue, the defaults, and whether a key is configured', async () => {
	const { handler, root } = mount();
	const response = await call(handler, makeRequest({ url: '/api/image-studio/state' }));
	const body = parse(response);

	assert.equal(response.statusCode, 200);
	assert.equal(body.ok, true);
	assert.equal(body.version, JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version,
		'the page reports the version actually running');
	assert.equal(body.credentials.fal.configured, false);
	assert.equal(body.storage.root, root);
	assert.equal(body.config.falKeyRef, 'FAL_API_KEY');
	assert.ok(body.catalog.imageModels.length >= 3);
	assert.ok(body.catalog.videoModels.some((model) => model.id.includes('kling')));
	assert.ok(body.catalog.templates.length > 0);
	assert.deepEqual(body.stats, { total: 0, images: 0, videos: 0, favorites: 0 });
});

test('the key is stored through the credential seam and never echoed back', async () => {
	const credentials = fakeCredentials();
	const { handler } = mount({ credentials });

	const saved = await call(handler, makeRequest({
		url: '/api/image-studio/credentials',
		method: 'POST',
		body: { value: 'fal-id:fal-secret' },
	}));
	const savedBody = parse(saved);
	assert.equal(saved.statusCode, 200);
	assert.equal(savedBody.credentials.fal.configured, true);
	assert.equal(credentials.store.get('FAL_API_KEY'), 'fal-id:fal-secret');
	assert.equal(saved.body.includes('fal-secret'), false, 'the value must not travel back to the page');

	const cleared = await call(handler, makeRequest({
		url: '/api/image-studio/credentials',
		method: 'POST',
		body: { value: '' },
	}));
	assert.equal(parse(cleared).credentials.fal.configured, false);
	assert.equal(credentials.store.has('FAL_API_KEY'), false);
});

test('a reference this plugin does not own is refused', async () => {
	const { handler } = mount();
	const response = await call(handler, makeRequest({
		url: '/api/image-studio/credentials',
		method: 'POST',
		body: { ref: 'DEEPSEEK_API_KEY', value: 'nope' },
	}));
	assert.equal(response.statusCode, 400);
});

test('generation without a prompt is refused before anything is spent', async () => {
	const { handler } = mount();
	const response = await call(handler, makeRequest({
		url: '/api/image-studio/generate',
		method: 'POST',
		body: { prompt: '   ' },
	}));
	assert.equal(response.statusCode, 400);
	assert.match(parse(response).error, /prompt/i);
});

test('generation without a key fails the job with a readable reason', async () => {
	const { handler } = mount();
	const started = await call(handler, makeRequest({
		url: '/api/image-studio/generate',
		method: 'POST',
		body: { prompt: 'a chair' },
	}));
	assert.equal(started.statusCode, 202);

	const job = await waitForJob(handler, parse(started).job.id);
	assert.equal(job.status, 'error');
	assert.match(job.error, /key/i);
});

test('a full generation reaches the gallery and its bytes are served back', async () => {
	const credentials = fakeCredentials({ FAL_API_KEY: 'fal-id:fal-secret' });
	const { handler } = mount({ credentials });

	// A scripted fal queue: submit, one poll that completes, then the result.
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init = {}) => {
		const target = String(url);
		if (target.endsWith('/fal-ai/flux-2/klein/9b') && (init.method ?? 'GET') === 'POST') {
			return new Response(JSON.stringify({
				status: 'IN_QUEUE',
				request_id: 'req-test',
				status_url: 'https://queue.test/status',
				response_url: 'https://queue.test/result',
			}), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		if (target === 'https://queue.test/status') {
			return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		if (target === 'https://queue.test/result') {
			return new Response(JSON.stringify({ images: [{ url: 'https://cdn.test/1.png', width: 1, height: 1, content_type: 'image/png' }] }),
				{ status: 200, headers: { 'content-type': 'application/json' } });
		}
		if (target === 'https://cdn.test/1.png') {
			return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
		}
		throw new Error(`unexpected fetch ${target}`);
	};

	try {
		const started = await call(handler, makeRequest({
			url: '/api/image-studio/generate',
			method: 'POST',
			body: { prompt: 'a red chair', model: 'fal-ai/flux-2/klein/9b', aspect: '9:16', count: 1 },
		}));
		assert.equal(started.statusCode, 202);

		const job = await waitForJob(handler, parse(started).job.id);
		assert.equal(job.status, 'done', job.error);
		assert.equal(job.items.length, 1);
		assert.equal(job.items[0].kind, 'image');
		assert.equal(job.items[0].prompt, 'a red chair');

		const gallery = parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery' })));
		assert.equal(gallery.items.length, 1);
		assert.equal(gallery.items[0].id, job.items[0].id);

		// The media route streams the stored bytes back with the stored type.
		const media = await call(handler, makeRequest({ url: job.items[0].url }));
		assert.equal(media.statusCode, 200);
		assert.equal(media.headers['Content-Type'], 'image/png');
		assert.deepEqual(media.raw, PNG);

		const listing = parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery?kind=image' })));
		assert.equal(listing.items.length, 1);
		const videos = parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery?kind=video' })));
		assert.equal(videos.items.length, 0);
		const search = parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery?q=chair' })));
		assert.equal(search.items.length, 1);
		const miss = parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery?q=spaceship' })));
		assert.equal(miss.items.length, 0);

		const favorite = parse(await call(handler, makeRequest({
			url: '/api/image-studio/favorite',
			method: 'POST',
			body: { id: job.items[0].id, favorite: true },
		})));
		assert.equal(favorite.item.favorite, true);
		const favorites = parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery?favorite=true' })));
		assert.equal(favorites.items.length, 1);

		const deleted = parse(await call(handler, makeRequest({
			url: '/api/image-studio/delete',
			method: 'POST',
			body: { id: job.items[0].id },
		})));
		assert.equal(deleted.removed, true);
		assert.equal(parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery' }))).items.length, 0);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('video needs a gallery image, and a bad id is refused', async () => {
	const { handler } = mount();
	const response = await call(handler, makeRequest({
		url: '/api/image-studio/video',
		method: 'POST',
		body: { id: 'not-an-id', prompt: 'move', model: 'fal-ai/kling-video/v3/pro/image-to-video' },
	}));
	assert.equal(response.statusCode, 400);
	assert.match(parse(response).error, /image/i);
});

test('defaults can be changed and survive into the next state read', async () => {
	const { handler } = mount();
	const saved = parse(await call(handler, makeRequest({
		url: '/api/image-studio/config',
		method: 'POST',
		body: { defaultModel: 'openai/gpt-image-2', defaultAspect: '9:16', defaultCount: 3 },
	})));
	assert.equal(saved.config.defaultModel, 'openai/gpt-image-2');
	assert.equal(saved.config.defaultAspect, '9:16');
	assert.equal(saved.config.defaultCount, 3);

	const nonsense = parse(await call(handler, makeRequest({
		url: '/api/image-studio/config',
		method: 'POST',
		body: { defaultAspect: '42:1', defaultCount: 99 },
	})));
	assert.equal(nonsense.config.defaultAspect, '9:16');
	assert.equal(nonsense.config.defaultCount, 8);
});

test('a montage with nothing chosen is refused before anything runs', async () => {
	const { handler } = mount();
	const empty = await call(handler, makeRequest({ url: '/api/image-studio/montage', method: 'POST', body: { ids: [] } }));
	assert.equal(empty.statusCode, 400);

	const hostile = await call(handler, makeRequest({
		url: '/api/image-studio/montage',
		method: 'POST',
		body: { ids: ['../../etc/passwd'] },
	}));
	assert.equal(hostile.statusCode, 400, 'an id that is not an id must never reach ffmpeg');
});

test('a montage of one still either assembles a clip or reports why it could not', async () => {
	const { handler, root } = mount();
	const entry = writeEntryFile(root, {
		id: newId(),
		bytes: PNG,
		ext: 'png',
		meta: { kind: 'image', prompt: 'a still', createdAt: Date.now() },
	});
	addEntries(root, [entry]);

	const started = await call(handler, makeRequest({
		url: '/api/image-studio/montage',
		method: 'POST',
		body: { ids: [entry.id], aspect: '9:16', stillSeconds: 2 },
	}));
	assert.equal(started.statusCode, 202);

	// ffmpeg is present on a normal machine and refused in a confined sandbox, so
	// both endings are legitimate; what must never happen is a silent failure.
	const job = await waitForJob(handler, parse(started).job.id, 60000);
	const gallery = parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery' }))).items;

	if (job.status === 'done') {
		assert.equal(gallery.length, 2);
		const produced = gallery.find((item) => item.id !== entry.id);
		assert.equal(produced.kind, 'video');
		assert.equal(produced.model, 'ffmpeg-montage');
		assert.ok(produced.bytes > 1000, 'an assembled clip has real content');
	} else {
		assert.equal(job.status, 'error');
		assert.match(job.error, /ffmpeg/i);
		assert.equal(gallery.length, 1, 'a failed montage adds nothing');
	}
});

test('the update check compares the branch with the running version', async () => {
	const { handler } = mount();
	const restore = stubGithub();
	try {
		const body = parse(await call(handler, makeRequest({ url: '/api/image-studio/update' })));
		assert.equal(body.ok, true);
		assert.equal(body.current, manifest.version);
		assert.equal(body.latest, '9.9.9');
		assert.equal(body.updateAvailable, true);
		assert.equal(body.sha, 'ccccccc');
		assert.equal(body.notes[0].message, 'make it better');
		assert.equal(body.spec, 'github:naletko/dsh-image-studio#ccccccc');
		assert.equal(body.manager, false, 'no plugin manager in this composition');
	} finally {
		restore();
	}
});

test('a failed check is reported instead of pretending there is nothing new', async () => {
	const { handler } = mount();
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response('nope', { status: 503 });
	try {
		const response = await call(handler, makeRequest({ url: '/api/image-studio/update' }));
		assert.equal(response.statusCode, 500);
		assert.match(parse(response).error, /Cannot reach/);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('applying an update hands the pinned revision to the plugin manager', async () => {
	const calls = [];
	const pluginManager = {
		installBundle: (spec, options) => {
			calls.push({ spec, options });
			return Promise.resolve({ stage: 'install', status: 'ok' });
		},
	};
	const { handler } = mount({ pluginManager });
	const restore = stubGithub();
	try {
		const response = await call(handler, makeRequest({ url: '/api/image-studio/update/apply', method: 'POST' }));
		assert.equal(response.statusCode, 202);
		const body = parse(response);
		assert.equal(body.started, true);
		assert.equal(body.spec, 'github:naletko/dsh-image-studio#ccccccc');

		// The install runs detached so a reload cannot cut its response short.
		await new Promise((resolve) => setTimeout(resolve, 30));
		const after = parse(await call(handler, makeRequest({ url: '/api/image-studio/update' })));
		assert.equal(after.progress.status, 'done');
		assert.deepEqual(after.progress.outcome, { stage: 'install', status: 'ok' });

		assert.equal(calls.length, 1);
		assert.equal(calls[0].spec, 'github:naletko/dsh-image-studio#ccccccc');
		assert.match(calls[0].options.requestId, /^image-studio-update-/);
	} finally {
		restore();
	}
});

test('a failed install is remembered with its reason', async () => {
	const pluginManager = { installBundle: () => Promise.reject(new Error('pnpm said no')) };
	const { handler } = mount({ pluginManager });
	const restore = stubGithub();
	try {
		await call(handler, makeRequest({ url: '/api/image-studio/update/apply', method: 'POST' }));
		await new Promise((resolve) => setTimeout(resolve, 30));
		const after = parse(await call(handler, makeRequest({ url: '/api/image-studio/update' })));
		assert.equal(after.progress.status, 'error');
		assert.match(after.progress.error, /pnpm said no/);
	} finally {
		restore();
	}
});

test('applying an update without a plugin manager explains the manual route', async () => {
	const { handler } = mount();
	const restore = stubGithub();
	try {
		const response = await call(handler, makeRequest({ url: '/api/image-studio/update/apply', method: 'POST' }));
		assert.equal(response.statusCode, 409);
		const body = parse(response);
		assert.match(body.error, /plugin manager/i);
		assert.equal(body.spec, 'github:naletko/dsh-image-studio#ccccccc');
	} finally {
		restore();
	}
});

test('unknown routes and unknown jobs answer 404 rather than pretending', async () => {
	const { handler } = mount();
	assert.equal((await call(handler, makeRequest({ url: '/api/image-studio/nope' }))).statusCode, 404);
	assert.equal((await call(handler, makeRequest({ url: '/api/image-studio/job?id=missing' }))).statusCode, 404);
	assert.equal((await call(handler, makeRequest({ url: '/api/image-studio/file?id=deadbeefdeadbeef' }))).statusCode, 404);
});

test('profile configuration is validated, never trusted', () => {
	assert.deepEqual(pickConfig(null), {});
	assert.deepEqual(pickConfig({ falKeyRef: 'not a ref' }), {});
	assert.deepEqual(pickConfig({ falKeyRef: 'FAL_API_KEY', defaultAspect: '7:3' }), { falKeyRef: 'FAL_API_KEY' });
	assert.deepEqual(
		pickConfig({ defaultCount: 12, imageTimeoutMs: 1000, videoTimeoutMs: 2000 }),
		{ defaultCount: 8, imageTimeoutMs: 1000, videoTimeoutMs: 2000 },
	);
});

test('a public entry never carries the provider URL', () => {
	const entry = publicEntry({ id: 'a'.repeat(24), ext: 'png', kind: 'image', mime: 'image/png', sourceUrl: 'https://cdn/secret' });
	assert.equal('sourceUrl' in entry, false);
	assert.equal(entry.url, `/api/image-studio/file?id=${'a'.repeat(24)}`);
});
