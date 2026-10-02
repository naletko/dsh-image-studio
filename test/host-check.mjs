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
import { registerHooks } from 'node:module';

import { apply, inject as declaredInject, isLocalRequest, pickConfig, publicEntry } from '../index.js';
import { addEntries, newId, writeEntryFile } from '../lib/gallery.js';

/**
 * The harness package a tool definition is built with.
 *
 * `@deepseek-ai/dsh-tools` is a peer dependency, and this repository has no
 * node_modules — the plugin loads it with a dynamic `import()` for exactly that
 * reason, so the host half stays importable in a checkout. The suite answers
 * that import with a stand-in enforcing the same registration contract the real
 * `defineTool` does (`name`, `description`, `parameters`, and an object-rooted
 * `output { schema, render }`), and hands the definition back unchanged so a
 * test can drive the tool's own `execute`. The hook is process-local: nothing
 * is written to disk and no package is installed.
 */
const TOOLS_STAND_IN = `
export function defineTool(options) {
	const output = options?.output;
	if (typeof options?.name !== 'string' || options.name === '') throw new TypeError('a tool must declare a name');
	if (typeof options.description !== 'string' || options.description === '') throw new TypeError('a tool must declare a description');
	if (options.parameters === null || typeof options.parameters !== 'object') throw new TypeError('a tool must declare parameters');
	if (output === null || typeof output !== 'object' || typeof output.render !== 'function' || typeof output.schema !== 'object') {
		throw new TypeError('a tool must declare output { schema, render }');
	}
	if (output.schema.type !== 'object' || output.schema.additionalProperties !== false) {
		throw new TypeError('a tool output must be an object-rooted, closed schema');
	}
	return options;
}
`;

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '@deepseek-ai/dsh-tools') {
			return { url: `data:text/javascript,${encodeURIComponent(TOOLS_STAND_IN)}`, shortCircuit: true };
		}
		return nextResolve(specifier, context);
	},
});

/** A 1×1 PNG, so downloaded media is really an image. */
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
	'base64',
);

/** The manifest this process is running, for version assertions. */
const manifest = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'));

/**
 * A scratch directory standing in for a person's project.
 *
 * @param label - prefix that makes a failing test's leftovers identifiable.
 * @returns the absolute project directory, already created.
 */
function makeWorkspaceDir(label = 'ws') {
	const dir = path.join(import.meta.dirname, '.tmp', `${label}-${newId()}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/** Answer one import request with a real PNG, without touching the network. */
async function importPng(handler, url = 'https://cdn.example.com/pic.png') {
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
	try {
		return await call(handler, makeRequest({ url: '/api/image-studio/import', method: 'POST', body: { url } }));
	} finally {
		globalThis.fetch = realFetch;
	}
}

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

/** A stand-in for the harness tool registry: it records what the plugin registers. */
function fakeToolRegistry() {
	return {
		registered: [],
		register(definition) {
			this.registered.push(definition);
			return () => {};
		},
	};
}

/**
 * The tool attaches itself after an asynchronous `import()` of the registry
 * package, so a test waits for the registration rather than assuming it.
 *
 * @param registry - the stand-in tool registry.
 * @returns the registered `image_generate` definition.
 */
async function waitForTool(registry, timeoutMs = 3000) {
	const deadline = Date.now() + timeoutMs;
	while (registry.registered.length === 0) {
		if (Date.now() > deadline) throw new Error('the image_generate tool was never registered');
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return registry.registered[0];
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
 * @param options.workspaceRegistry - a stand-in for the project registry.
 * @param options.tools - a stand-in for the tool registry; omitted means a
 *   composition that mounts no tool service at all.
 * @returns `{ handler, root, credentials, tools }`.
 */
function mount({ credentials = fakeCredentials(), config = {}, pluginManager, workspaceRegistry, tools } = {}) {
	const root = path.join(import.meta.dirname, '.tmp', `host-${newId()}`);
	fs.mkdirSync(root, { recursive: true });
	process.env.DSH_IMAGE_STUDIO_HOME = root;

	let registered;
	const services = {
		webServer: { register: (options) => { registered = options; return () => {}; } },
		credentials,
	};
	if (pluginManager !== undefined) services.pluginManager = pluginManager;
	if (workspaceRegistry !== undefined) services.workspaceRegistry = workspaceRegistry;
	if (tools !== undefined) services.tools = tools;

	const ctx = {
		effect: (fn) => fn(),
		// Cordis' `inject(deps, callback)` runs the callback only once every named
		// service exists, which is how the plugin finds the plugin manager without
		// requiring it. The scope it hands over is a context too: it keeps
		// `effect` (the tool registration wraps itself in one) and `inject`.
		inject: (deps, callback) => {
			const scope = {
				effect: (fn) => fn(),
				inject: () => () => {},
			};
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
	return { handler: registered.handler, root, credentials, tools };
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

test('the import route refuses links into the local network', async () => {
	const { handler } = mount();
	const hostile = [
		'file:///etc/passwd',
		'http://localhost:8188/pic.png',
		'http://127.0.0.1/pic.png',
		'http://192.168.1.5/pic.png',
		'http://10.0.0.7/pic.png',
		'http://172.16.4.4/pic.png',
		'http://169.254.169.254/latest/meta-data',
		'http://router.local/pic.png',
		'just some text',
	];
	for (const url of hostile) {
		const response = await call(handler, makeRequest({
			url: '/api/image-studio/import',
			method: 'POST',
			body: { url },
		}));
		assert.equal(response.statusCode, 400, `${url} must be refused`);
	}
});

test('an import downloads a public link into the gallery', async () => {
	const { handler } = mount();
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
	try {
		const body = parse(await call(handler, makeRequest({
			url: '/api/image-studio/import',
			method: 'POST',
			body: { url: 'https://cdn.example.com/pic.png' },
		})));
		assert.equal(body.ok, true);
		assert.equal(body.item.kind, 'image');
		assert.equal(body.item.modelLabel, 'Import');

		const gallery = parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery' })));
		assert.equal(gallery.items.length, 1);

		const media = await call(handler, makeRequest({ url: `/api/image-studio/file?id=${body.item.id}` }));
		assert.deepEqual(media.raw, PNG);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('a model of the user\'s own is remembered and offered', async () => {
	const { handler } = mount();
	const saved = parse(await call(handler, makeRequest({
		url: '/api/image-studio/config',
		method: 'POST',
		body: {
			// One usable slug, one bare word, and one that is already a built-in.
			customModels: ['fal-ai/qwen-image', 'not a slug', 'fal-ai/flux-2/klein/9b'],
			defaultModel: 'fal-ai/qwen-image',
		},
	})));
	assert.deepEqual(saved.config.customModels, ['fal-ai/qwen-image']);
	assert.equal(saved.config.defaultModel, 'fal-ai/qwen-image');

	const state = parse(await call(handler, makeRequest({ url: '/api/image-studio/state' })));
	const entry = state.catalog.imageModels.find((model) => model.id === 'fal-ai/qwen-image');
	assert.ok(entry, 'the custom endpoint is offered by the picker');
	assert.equal(entry.custom, true);
	assert.equal(state.catalog.imageModels.filter((model) => model.id === 'fal-ai/qwen-image').length, 1);
	assert.equal(state.catalog.imageModels.length, state.catalog.builtinImageModels.length + 1);
});

test('a public entry never carries the provider URL', () => {
	const entry = publicEntry({ id: 'a'.repeat(24), ext: 'png', kind: 'image', mime: 'image/png', sourceUrl: 'https://cdn/secret' });
	assert.equal('sourceUrl' in entry, false);
	assert.equal(entry.url, `/api/image-studio/file?id=${'a'.repeat(24)}`);
});

test('a project library is created, written, and read back', async () => {
	const workspace = makeWorkspaceDir('project');
	const { handler, root } = mount({ config: { librarySource: 'workspace', libraryWorkspace: workspace } });
	const mediaRoot = path.join(path.resolve(workspace), 'dsh-media');

	const state = parse(await call(handler, makeRequest({ url: '/api/image-studio/state' })));
	assert.equal(state.library.source, 'workspace');
	assert.equal(state.library.workspace, path.resolve(workspace));
	assert.equal(state.library.subdir, '');
	assert.equal(state.library.root, mediaRoot);
	assert.equal(state.storage.root, mediaRoot, 'the studio reports the root it actually used');
	assert.equal(fs.existsSync(mediaRoot), true, 'picking a project creates its media folder');

	const imported = parse(await importPng(handler));
	assert.equal(imported.ok, true);
	const media = await call(handler, makeRequest({ url: `/api/image-studio/file?id=${imported.item.id}` }));
	assert.deepEqual(media.raw, PNG);
	assert.equal(fs.existsSync(path.join(mediaRoot, 'gallery.json')), true, 'the index lives with the project media');
	assert.equal(fs.existsSync(path.join(root, 'gallery.json')), false, 'the shared studio is not touched');
});

test('the library root follows the configuration without a restart', async () => {
	const workspace = makeWorkspaceDir('switch');
	const { handler, root } = mount({ config: { librarySource: 'workspace', libraryWorkspace: workspace } });

	assert.equal(parse(await importPng(handler)).ok, true);
	assert.equal(parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery' }))).items.length, 1);

	const toStudio = parse(await call(handler, makeRequest({
		url: '/api/image-studio/config', method: 'POST', body: { librarySource: 'studio' },
	})));
	assert.equal(toStudio.config.librarySource, 'studio');
	assert.equal(parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery' }))).items.length, 0,
		'the shared studio is a different, empty gallery');

	const back = parse(await call(handler, makeRequest({
		url: '/api/image-studio/config', method: 'POST', body: { librarySource: 'workspace' },
	})));
	assert.equal(back.config.librarySource, 'workspace');
	assert.equal(back.config.libraryWorkspace, path.resolve(workspace), 'the project survives the round trip');
	assert.equal(parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery' }))).items.length, 1,
		'the project gallery is still there after switching away and back');

	// The switch itself is stored in the shared studio, not in the project: a
	// settings file inside the project could never point the library back out.
	const stored = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
	assert.equal(stored.librarySource, 'workspace');
	assert.equal(fs.existsSync(path.join(path.resolve(workspace), 'dsh-media', 'config.json')), false);
});

test('invalid library configuration is refused, never coerced', async () => {
	// Unit level: every dangerous spelling is dropped, so the key keeps its
	// previous value instead of pointing the library somewhere else.
	assert.deepEqual(pickConfig({ librarySource: 'somewhere' }), {});
	assert.deepEqual(pickConfig({ librarySubdir: '..' }), {});
	assert.deepEqual(pickConfig({ librarySubdir: '../outside' }), {});
	assert.deepEqual(pickConfig({ librarySubdir: 'a/../../b' }), {});
	assert.deepEqual(pickConfig({ librarySubdir: '/etc' }), {});
	assert.deepEqual(pickConfig({ librarySubdir: 'C:\\Users' }), {});
	assert.deepEqual(pickConfig({ librarySubdir: '..\\sibling' }), {});
	assert.deepEqual(pickConfig({ librarySubdir: 'a//b' }), {});
	assert.deepEqual(pickConfig({ librarySubdir: 'a/b/c/d' }), {});
	assert.deepEqual(pickConfig({ libraryWorkspace: 'relative/project' }), {});
	assert.deepEqual(pickConfig({ libraryWorkspace: path.join(import.meta.dirname, 'no-such-project') }), {},
		'a project directory must already exist');
	assert.deepEqual(pickConfig({ librarySubdir: 'shots.2026/renders' }), { librarySubdir: 'shots.2026/renders' });

	const project = makeWorkspaceDir('valid');
	assert.deepEqual(
		pickConfig({ librarySource: 'workspace', libraryWorkspace: project, librarySubdir: '' }),
		{ librarySource: 'workspace', libraryWorkspace: path.resolve(project), librarySubdir: '' },
	);

	// Route level: a hostile request leaves the effective configuration alone.
	const { handler, root } = mount();
	const rejected = parse(await call(handler, makeRequest({
		url: '/api/image-studio/config',
		method: 'POST',
		body: { librarySource: 'elsewhere', libraryWorkspace: 'relative/project', librarySubdir: '../../..' },
	})));
	assert.equal(rejected.config.librarySource, 'studio');
	assert.equal(rejected.config.libraryWorkspace, '');
	assert.equal(rejected.config.librarySubdir, '');
	const state = parse(await call(handler, makeRequest({ url: '/api/image-studio/state' })));
	assert.equal(state.library.source, 'studio');
	assert.equal(state.library.root, root, 'the shared studio stays the root');

	// A valid request is accepted, and the page sees the new root at once.
	const acceptedProject = makeWorkspaceDir('accepted');
	const accepted = parse(await call(handler, makeRequest({
		url: '/api/image-studio/config',
		method: 'POST',
		body: { librarySource: 'workspace', libraryWorkspace: acceptedProject, librarySubdir: 'renders' },
	})));
	assert.equal(accepted.config.librarySource, 'workspace');
	assert.equal(accepted.config.libraryWorkspace, path.resolve(acceptedProject));
	assert.equal(accepted.config.librarySubdir, 'renders');
	const moved = parse(await call(handler, makeRequest({ url: '/api/image-studio/state' })));
	assert.equal(moved.library.root, path.join(path.resolve(acceptedProject), 'dsh-media', 'renders'));
	assert.equal(fs.existsSync(moved.library.root), true);
});

test('a subdirectory nests the media folder and cannot escape the project', async () => {
	const workspace = makeWorkspaceDir('nested');
	const { handler } = mount({
		config: { librarySource: 'workspace', libraryWorkspace: workspace, librarySubdir: 'shots/2026' },
	});
	const nested = path.join(path.resolve(workspace), 'dsh-media', 'shots', '2026');
	assert.equal(parse(await call(handler, makeRequest({ url: '/api/image-studio/state' }))).library.root, nested);
	assert.equal(fs.existsSync(nested), true);

	const hostile = parse(await call(handler, makeRequest({
		url: '/api/image-studio/config', method: 'POST', body: { librarySubdir: '../../..' },
	})));
	assert.equal(hostile.config.librarySubdir, 'shots/2026', 'a traversal never replaces a valid subdirectory');
	const after = parse(await call(handler, makeRequest({ url: '/api/image-studio/state' })));
	assert.equal(after.library.root, nested);
	assert.equal(after.library.subdir, 'shots/2026');
});

test('/gitignore adds the media folder once, and only inside a repository', async () => {
	const repo = makeWorkspaceDir('repo');
	fs.mkdirSync(path.join(repo, '.git'));
	fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\n', 'utf8');

	const { handler } = mount({ config: { librarySource: 'workspace', libraryWorkspace: repo } });
	const first = parse(await call(handler, makeRequest({ url: '/api/image-studio/gitignore', method: 'POST' })));
	assert.equal(first.ok, true);
	assert.equal(first.changed, true);
	const content = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8');
	assert.match(content, /^dsh-media\/$/m);
	assert.match(content, /^node_modules$/m, 'existing lines are kept');

	const second = parse(await call(handler, makeRequest({ url: '/api/image-studio/gitignore', method: 'POST' })));
	assert.equal(second.changed, false, 'a second request changes nothing');
	assert.equal(content.split(/\r?\n/).filter((line) => line.trim() === 'dsh-media/').length, 1);

	const state = parse(await call(handler, makeRequest({ url: '/api/image-studio/state' })));
	assert.equal(state.library.git, true);
	assert.equal(state.library.ignored, true);

	// A folder that is not a repository is never written to.
	const plain = makeWorkspaceDir('plain');
	const plainMount = mount({ config: { librarySource: 'workspace', libraryWorkspace: plain } });
	const nothing = parse(await call(plainMount.handler, makeRequest({ url: '/api/image-studio/gitignore', method: 'POST' })));
	assert.equal(nothing.ok, true);
	assert.equal(nothing.changed, false);
	assert.equal(fs.existsSync(path.join(plain, '.gitignore')), false);

	// With the shared studio there is no project to ignore anything in.
	const studioMount = mount();
	const none = parse(await call(studioMount.handler, makeRequest({ url: '/api/image-studio/gitignore', method: 'POST' })));
	assert.equal(none.ok, true);
	assert.equal(none.changed, false);
});

test('/workspaces maps the project registry, and stays valid without one', async () => {
	const without = mount();
	const unsupported = parse(await call(without.handler, makeRequest({ url: '/api/image-studio/workspaces' })));
	assert.equal(unsupported.ok, true);
	assert.equal(unsupported.supported, false, 'a composition without projects still answers');
	assert.deepEqual(unsupported.workspaces, []);
	assert.equal(unsupported.source, 'studio');
	assert.equal(unsupported.root, without.root);

	const projectA = path.resolve('demo-project-a');
	const projectB = path.resolve('demo-project-b');
	const registry = {
		list: () => [
			{ id: 'a', title: 'Demo A', path: projectA },
			{ id: 'b', title: '', path: projectB },
			{ id: 'c', title: 'no directory' },
		],
	};
	const { handler } = mount({ workspaceRegistry: registry });
	const listed = parse(await call(handler, makeRequest({ url: '/api/image-studio/workspaces' })));
	assert.equal(listed.supported, true);
	assert.deepEqual(listed.workspaces, [
		{ name: 'Demo A', dir: projectA },
		{ name: projectB, dir: projectB },
	], 'the entity title is the name and its canonical path is the directory');

	const state = parse(await call(handler, makeRequest({ url: '/api/image-studio/state' })));
	assert.equal(state.library.workspaces.length, 2);

	const broken = mount({ workspaceRegistry: { list: () => { throw new Error('storage offline'); } } });
	const degraded = parse(await call(broken.handler, makeRequest({ url: '/api/image-studio/workspaces' })));
	assert.equal(degraded.ok, true);
	assert.equal(degraded.supported, false, 'a broken registry degrades instead of failing the page');
});

test('state says whether the library can be pointed at a project', async () => {
	// The page reads `library.supported` while it mounts instead of asking
	// /workspaces a second time, so the two routes must agree.
	const without = mount();
	const unsupported = parse(await call(without.handler, makeRequest({ url: '/api/image-studio/state' })));
	assert.equal(unsupported.library.supported, false, 'no project registry, no project library');

	const registry = { list: () => [{ id: 'a', title: 'Demo A', path: path.resolve('demo-project') }] };
	const { handler } = mount({ workspaceRegistry: registry });
	const supported = parse(await call(handler, makeRequest({ url: '/api/image-studio/state' })));
	assert.equal(supported.library.supported, true);
	assert.equal(supported.library.workspaces.length, 1, 'the same list /workspaces returns');
});

test('the chat tool is registered exactly once, and a composition without a tool registry still mounts', async () => {
	const tools = fakeToolRegistry();
	const { handler } = mount({ tools });
	const definition = await waitForTool(tools);

	assert.equal(tools.registered.length, 1, 'one registration per mount');
	assert.equal(definition.name, 'image_generate');
	assert.equal(typeof definition.description, 'string');
	assert.equal(typeof definition.execute, 'function');
	assert.equal(definition.parameters.prompt.required, true, 'the prompt is the one required argument');
	assert.deepEqual(Object.keys(definition.parameters).sort(), ['aspect', 'count', 'model', 'prompt']);
	assert.equal(typeof definition.output.render, 'function');
	assert.deepEqual(Object.keys(definition.output.schema.properties).sort(), [
		'aspect', 'count', 'images', 'markdown', 'model', 'modelLabel', 'prompt', 'root', 'summary',
	], 'the declared output is the successful value: a failure throws instead');
	assert.deepEqual(definition.output.render({}, { summary: 'Generated 1 image.' }), [
		{ type: 'text', text: 'Generated 1 image.' },
	]);

	const state = parse(await call(handler, makeRequest({ url: '/api/image-studio/state' })));
	assert.equal(state.ok, true, 'the page is unaffected by the tool registration');

	// A composition that mounts no tool service registers nothing and still
	// serves the Images page; that is the `ctx.inject(['tools'], …)` guarantee.
	const plain = mount();
	assert.equal(parse(await call(plain.handler, makeRequest({ url: '/api/image-studio/state' }))).ok, true);
	assert.equal(tools.registered.length, 1, 'the second mount had no registry to register into');
});

test('the chat tool reports a missing fal key as a readable error instead of touching the network', async () => {
	const tools = fakeToolRegistry();
	mount({ tools });
	const definition = await waitForTool(tools);

	const savedKey = process.env.FAL_API_KEY;
	delete process.env.FAL_API_KEY;
	const realFetch = globalThis.fetch;
	let touched = 0;
	globalThis.fetch = async () => {
		touched += 1;
		throw new Error('a generation without a key must not reach the network');
	};
	try {
		// The call is marked failed, so the model reads the reason as an error
		// rather than as a result it might mistake for success.
		const error = await definition.execute({ prompt: 'a chair' }, {})
			.then(() => { throw new Error('a missing key must reject the call'); }, (thrown) => thrown);
		assert.ok(error instanceof Error);
		assert.match(error.message, /key/i, 'the reason names the missing key');
		assert.equal(touched, 0, 'nothing is spent before the key exists');
		assert.equal(error.message.includes('key_id:key_secret'), false, 'no credential is echoed back');
	} finally {
		globalThis.fetch = realFetch;
		if (savedKey !== undefined) process.env.FAL_API_KEY = savedKey;
	}
});

test('a fal rejection is thrown with a readable reason and no key', async () => {
	const credentials = fakeCredentials({ FAL_API_KEY: 'fal-id:fal-secret' });
	const tools = fakeToolRegistry();
	mount({ credentials, tools });
	const definition = await waitForTool(tools);

	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'no credit left' }), { status: 401 });
	try {
		await assert.rejects(definition.execute({ prompt: 'a chair' }, {}), /key is invalid or has no access/i);
	} finally {
		globalThis.fetch = realFetch;
	}

	// A slug fal does not know is reported just as plainly (HTTP 404).
	const missing = globalThis.fetch;
	globalThis.fetch = async () => new Response(JSON.stringify({ detail: 'not found' }), { status: 404 });
	try {
		const error = await definition.execute({ prompt: 'a chair', model: 'acme/no-such-endpoint' }, {})
			.then(() => { throw new Error('an unknown endpoint must reject the call'); }, (thrown) => thrown);
		assert.match(error.message, /no endpoint named/i);
		assert.equal(error.message.includes('fal-secret'), false, 'the key stays out of the message');
	} finally {
		globalThis.fetch = missing;
	}
});

test('the chat tool generates through the page path into the project media', async () => {
	const workspace = makeWorkspaceDir('tool');
	const mediaRoot = path.join(path.resolve(workspace), 'dsh-media', 'shots');
	const credentials = fakeCredentials({ FAL_API_KEY: 'fal-id:fal-secret' });
	const tools = fakeToolRegistry();
	const { handler } = mount({
		credentials,
		tools,
		config: { librarySource: 'workspace', libraryWorkspace: workspace, librarySubdir: 'shots' },
	});
	const definition = await waitForTool(tools);

	const realFetch = globalThis.fetch;
	const calls = [];
	let submittedAuth;
	globalThis.fetch = async (url, init = {}) => {
		const target = String(url);
		calls.push(target);
		if (target === 'https://queue.fal.run/acme/custom-image' && (init.method ?? 'GET') === 'POST') {
			submittedAuth = init.headers?.authorization;
			return new Response(JSON.stringify({
				status: 'IN_QUEUE',
				request_id: 'req-tool',
				status_url: 'https://queue.test/tool-status',
				response_url: 'https://queue.test/tool-result',
			}), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		if (target === 'https://queue.test/tool-status') {
			return new Response(JSON.stringify({ status: 'COMPLETED' }), { status: 200, headers: { 'content-type': 'application/json' } });
		}
		if (target === 'https://queue.test/tool-result') {
			return new Response(JSON.stringify({ images: [{ url: 'https://cdn.test/tool.png', width: 8, height: 4, content_type: 'image/png' }] }),
				{ status: 200, headers: { 'content-type': 'application/json' } });
		}
		if (target === 'https://cdn.test/tool.png') {
			return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
		}
		throw new Error(`unexpected fetch ${target}`);
	};

	try {
		// A model that is not a fal slug is refused before anything is spent.
		const rejected = await definition.execute({ prompt: 'a chair', model: 'not-a-slug' }, {})
			.then(() => { throw new Error('a model that is not a slug must reject the call'); }, (thrown) => thrown);
		assert.match(rejected.message, /fal endpoint/i);
		assert.equal(calls.length, 0, 'an unusable model never reaches fal');

		const value = await definition.execute(
			{ prompt: 'a blue teapot', model: 'acme/custom-image', aspect: '16:9', count: 1 },
			{},
		);
		assert.equal(value.model, 'acme/custom-image', 'any fal endpoint slug is accepted');
		assert.equal(value.aspect, '16:9');
		assert.equal(value.count, 1);
		assert.equal(value.root, mediaRoot, 'the tool writes where the page points the library');
		assert.equal(calls[0], 'https://queue.fal.run/acme/custom-image');
		assert.equal(submittedAuth, 'Key fal-id:fal-secret', 'the key travels to fal through the same seam the page uses');

		const image = value.images[0];
		assert.equal(image.mime, 'image/png');
		assert.equal(image.bytes, PNG.length);
		assert.equal(fs.existsSync(image.file), true, 'the bytes are on disk');
		assert.deepEqual(fs.readFileSync(image.file), PNG);
		assert.ok(image.file.startsWith(path.join(mediaRoot, 'files')), 'media sits in the library root the page reads');
		assert.equal(image.markdown, `![a blue teapot](<${image.file.replace(/\\/g, '/')}>)`,
			'the result carries a markdown link to the file it just stored');
		assert.equal(value.markdown, image.markdown);
		assert.equal(JSON.stringify(value).includes('fal-secret'), false, 'the key never travels back into the result');

		// The page finds exactly the record the tool wrote: one gallery, one path.
		const gallery = parse(await call(handler, makeRequest({ url: '/api/image-studio/gallery' })));
		assert.equal(gallery.items.length, 1);
		assert.equal(gallery.items[0].id, image.id);
		assert.equal(gallery.items[0].url, image.url);
		const served = await call(handler, makeRequest({ url: image.url }));
		assert.deepEqual(served.raw, PNG);

		assert.deepEqual([...new Set(calls)], [
			'https://queue.fal.run/acme/custom-image',
			'https://queue.test/tool-status',
			'https://queue.test/tool-result',
			'https://cdn.test/tool.png',
		], 'nothing is fetched except the fal call and the media fal returned');
	} finally {
		globalThis.fetch = realFetch;
	}
});
