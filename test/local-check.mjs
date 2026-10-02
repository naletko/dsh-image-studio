/**
 * The local provider, driven offline: a scripted ComfyUI answers every request,
 * and the test walks the whole path the host takes — `/system_stats`, `/prompt`,
 * `/history/<id>`, `/view`, and the gallery record that comes out at the end.
 *
 * No server is started and no socket is opened. The refusal cases matter as much
 * as the happy one: a non-local address must be refused before any request, a
 * server that is switched off must be reported instead of thrown, and a history
 * that never completes must end the job rather than hang the page.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { Writable } from 'node:stream';

import { apply as applyHost, pickConfig } from '../index.js';
import { newId, readIndex } from '../lib/gallery.js';
import {
	LOCAL_ASPECT_SIZES,
	LocalError,
	checkServer,
	fillWorkflow,
	fetchImage,
	generateLocalImages,
	imagesFromHistory,
	isLocalComfyUrl,
	localModelId,
	localModelLabel,
	localSize,
	localUrlProblem,
	pollHistory,
	queuePrompt,
	readWorkflowTemplate,
} from '../lib/local.js';

/** A 1×1 PNG, so the bytes that reach the gallery really are an image. */
const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
	'base64',
);

const WORKFLOW = path.join(import.meta.dirname, '..', 'workflow', 'qwen-image.json');

/** A fetch that answers from a routing table and records what it was asked. */
function fakeFetch(routes) {
	const calls = [];
	const impl = async (url, init = {}) => {
		const target = String(url);
		calls.push({ url: target, method: init.method ?? 'GET', body: init.body });
		const route = routes.find((entry) => target.includes(entry.match));
		if (route === undefined) throw new Error(`unexpected fetch ${target}`);
		return route.respond(init, target);
	};
	impl.calls = calls;
	return impl;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json' },
});

/** The real `/system_stats` shape, as ComfyUI reports it. */
const SYSTEM_STATS = {
	system: {
		os: 'nt',
		python_version: '3.12.4',
		comfyui_version: '0.3.60',
		ram_total: 34359738368,
	},
	devices: [
		{ name: 'cuda:0 NVIDIA GeForce RTX 4070', type: 'cuda', index: 0, vram_total: 12884901888, vram_free: 9663676416 },
	],
};

/** The real `/history/<id>` shape for a finished prompt that saved one image. */
const HISTORY_DONE = {
	'prompt-1': {
		prompt: [0, 'prompt-1', {}, {}, []],
		outputs: {
			9: {
				images: [{ filename: 'dsh-image-studio_00001_.png', subfolder: '', type: 'output' }],
			},
		},
		status: { status_str: 'success', completed: true, messages: [] },
	},
};

/** The routing table a healthy ComfyUI answers with. */
function healthyRoutes() {
	let polls = 0;
	// `/history/<id>` is matched before `/prompt`, because the history URL ends in
	// the prompt id and would otherwise be answered by the submission route.
	return [
		{ match: '/system_stats', respond: () => json(SYSTEM_STATS) },
		{
			match: '/history/',
			respond: () => {
				// The prompt is queued at first and finished afterwards, which is what
				// an empty history answer means.
				const answer = polls === 0 ? json({}) : json(HISTORY_DONE);
				polls += 1;
				return answer;
			},
		},
		{ match: '/prompt', respond: () => json({ prompt_id: 'prompt-1', number: 1 }) },
		{ match: '/view?', respond: () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } }) },
	];
}

/** A scratch library root for one test. */
function scratch(label) {
	const dir = path.join(import.meta.dirname, '.tmp', `${label}-${newId()}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

const liveLocal = (root, extra = {}) => ({
	localUrl: 'http://127.0.0.1:8188',
	localWorkflow: WORKFLOW,
	localModel: 'qwen-image-Q4_K_M.gguf',
	localClip: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
	localVae: 'qwen_image_vae.safetensors',
	localSteps: 20,
	localTimeoutMs: 5000,
	...extra,
});

//#region the template

test('the shipped template is an API graph with every placeholder the settings fill', () => {
	const graph = readWorkflowTemplate(WORKFLOW);
	const nodeIds = Object.keys(graph);
	assert.ok(nodeIds.length >= 6, 'a graph needs loaders, encoders, a sampler and a save node');
	for (const node of Object.values(graph)) {
		assert.equal(typeof node.class_type, 'string');
		assert.equal(typeof node.inputs, 'object');
	}

	const text = JSON.stringify(graph);
	for (const placeholder of ['{{prompt}}', '{{width}}', '{{height}}', '{{seed}}', '{{steps}}', '{{model}}', '{{clip}}', '{{vae}}']) {
		assert.ok(text.includes(placeholder), `${placeholder} must appear in the shipped template`);
	}
	// No weight file is named as a fact: the three model inputs are placeholders.
	const modelInputs = ['unet_name', 'clip_name', 'vae_name'].map((key) => {
		const node = Object.values(graph).find((entry) => entry.inputs[key] !== undefined);
		assert.ok(node, `${key} must exist in the template`);
		return node.inputs[key];
	});
	assert.deepEqual(modelInputs, ['{{model}}', '{{clip}}', '{{vae}}']);
});

test('placeholders are replaced literally, without eval, and numbers stay numbers', () => {
	const filled = fillWorkflow({ a: { text: '{{prompt}}', seed: '{{seed}}', steps: '{{steps}}' }, b: { w: '{{width}}', h: '{{height}}', m: '{{model}}' } }, {
		prompt: 'a "quoted" chair\\with\\slashes\nand a newline',
		seed: 12345,
		steps: 20,
		width: 1024,
		height: 768,
		model: 'qwen.gguf',
	});

	// The string survives JSON round-trip untouched: substitution is a literal
	// replace on the parsed object, never string surgery on the file.
	const roundTrip = JSON.parse(JSON.stringify(filled));
	assert.equal(roundTrip.a.text, 'a "quoted" chair\\with\\slashes\nand a newline');
	assert.equal(roundTrip.a.seed, 12345, 'a whole-placeholder number becomes an integer');
	assert.equal(roundTrip.a.steps, 20);
	assert.equal(roundTrip.b.w, 1024);
	assert.equal(roundTrip.b.h, 768);
	assert.equal(roundTrip.b.m, 'qwen.gguf');

	// An unknown placeholder is left visible instead of blanked.
	assert.equal(fillWorkflow({ x: '{{nobody}}' }, { prompt: 'p' }).x, '{{nobody}}');
	// The graph handed in is not modified.
	const original = { x: '{{prompt}}' };
	fillWorkflow(original, { prompt: 'p' });
	assert.equal(original.x, '{{prompt}}');
});

test('every offered aspect maps to a frame, and an unknown one falls back', () => {
	assert.deepEqual(localSize('1:1'), LOCAL_ASPECT_SIZES['1:1']);
	assert.deepEqual(localSize('9:16'), LOCAL_ASPECT_SIZES['9:16']);
	assert.deepEqual(localSize('42:1'), LOCAL_ASPECT_SIZES['1:1']);
	for (const [width, height] of Object.values(LOCAL_ASPECT_SIZES)) {
		assert.equal(width % 8, 0, 'a latent width must divide by 8');
		assert.equal(height % 8, 0, 'a latent height must divide by 8');
	}
});

//#endregion

//#region addressing and configuration

test('only http(s) on a loopback host is accepted', () => {
	for (const good of ['http://127.0.0.1:8188', 'http://localhost:8188', 'http://[::1]:8188', 'https://localhost']) {
		assert.equal(isLocalComfyUrl(good), true, `${good} is a local address`);
	}
	for (const bad of ['http://example.com:8188', 'http://10.0.0.5:8188', 'http://192.168.1.7:8188', 'ftp://127.0.0.1:8188', 'not a url', '']) {
		assert.equal(isLocalComfyUrl(bad), false, `${bad} must be refused`);
		assert.ok(localUrlProblem(bad), `${bad} needs a reason`);
	}
});

test('configuration refuses a remote address and a template that is not a file', () => {
	// A remote address is dropped, so the default stands.
	assert.equal(pickConfig({ localUrl: 'http://example.com:8188' }).localUrl, undefined);
	assert.equal(pickConfig({ localUrl: 'http://localhost:8188/' }).localUrl, 'http://localhost:8188');
	assert.equal(pickConfig({ localUrl: 'http://[::1]:8188' }).localUrl, 'http://[::1]:8188');
	assert.equal(pickConfig({ localModel: '  qwen.gguf  ' }).localModel, 'qwen.gguf');
	assert.equal(pickConfig({ localSteps: 999 }).localSteps, 150, 'steps are bounded');
	assert.equal(pickConfig({ provider: 'local' }).provider, 'local');
	assert.equal(pickConfig({ provider: 'somewhere-else' }).provider, undefined);

	assert.equal(pickConfig({ localWorkflow: path.join(import.meta.dirname, 'no-such-workflow.json') }).localWorkflow, undefined);
	assert.equal(pickConfig({ localWorkflow: WORKFLOW }).localWorkflow, path.resolve(WORKFLOW));
	assert.equal(pickConfig({ localWorkflow: path.join(import.meta.dirname, 'local-check.mjs') }).localWorkflow, undefined, 'a workflow must be JSON');
	// An empty patch therefore falls back to the shipped template, which parses.
	assert.ok(readWorkflowTemplate(WORKFLOW));
});

//#endregion

//#region the ComfyUI client

test('the status probe reads the version, the device and the VRAM the server reports', async () => {
	const fetchImpl = fakeFetch(healthyRoutes());
	const status = await checkServer('http://127.0.0.1:8188', { fetchImpl });

	assert.equal(status.reachable, true);
	assert.equal(status.url, 'http://127.0.0.1:8188');
	assert.equal(status.version, '0.3.60');
	assert.equal(status.device, 'cuda:0 NVIDIA GeForce RTX 4070');
	assert.equal(status.vram, 12884901888);
	assert.equal(fetchImpl.calls.length, 1);
	assert.match(fetchImpl.calls[0].url, /\/system_stats$/);
});

test('a server that is switched off is reported, never thrown', async () => {
	const refusing = async () => { throw new TypeError('fetch failed'); };
	const status = await checkServer('http://127.0.0.1:8188', { fetchImpl: refusing });

	assert.equal(status.reachable, false);
	assert.equal(status.url, 'http://127.0.0.1:8188');
	assert.match(status.reason, /ComfyUI не отвечает на http:\/\/127\.0\.0\.1:8188/);
	assert.equal(status.version, undefined, 'nothing is invented about a server that did not answer');

	// A server that answers with an HTTP error is also a report, not a throw.
	const broken = await checkServer('http://127.0.0.1:8188', { fetchImpl: fakeFetch([{ match: '/system_stats', respond: () => new Response('nope', { status: 500 }) }]) });
	assert.equal(broken.reachable, false);
	assert.match(broken.reason, /HTTP 500/);
});

test('a non-local address is refused before a single request is made', async () => {
	const fetchImpl = fakeFetch(healthyRoutes());

	const status = await checkServer('http://example.com:8188', { fetchImpl });
	assert.equal(status.reachable, false);
	assert.match(status.reason, /127\.0\.0\.1, localhost, ::1/);

	await assert.rejects(
		() => queuePrompt('http://example.com:8188', { 1: { class_type: 'SaveImage', inputs: {} } }, { fetchImpl }),
		(error) => error instanceof LocalError && error.code === 'local-url',
	);
	assert.equal(fetchImpl.calls.length, 0, 'no request may leave loopback');
});

test('a queued prompt is polled through history and its images are read back', async () => {
	const fetchImpl = fakeFetch(healthyRoutes());
	const graph = { 9: { class_type: 'SaveImage', inputs: { images: ['8', 0] } } };

	const queued = await queuePrompt('http://127.0.0.1:8188', graph, { fetchImpl });
	assert.equal(queued.promptId, 'prompt-1');
	const sent = JSON.parse(fetchImpl.calls[0].body);
	assert.deepEqual(sent.prompt, graph);
	assert.equal(typeof sent.client_id, 'string', 'ComfyUI wants a client id');

	const history = await pollHistory('http://127.0.0.1:8188', queued.promptId, { fetchImpl, timeoutMs: 2000, intervalMs: 1 });
	assert.deepEqual(history.images, [{ filename: 'dsh-image-studio_00001_.png', subfolder: '', type: 'output' }]);
	assert.equal(history.status.status_str, 'success');

	const image = await fetchImage('http://127.0.0.1:8188', history.images[0].filename, history.images[0].subfolder, history.images[0].type, { fetchImpl });
	assert.deepEqual(image.bytes, PNG);
	assert.equal(image.contentType, 'image/png');
	assert.match(fetchImpl.calls.at(-1).url, /\/view\?filename=dsh-image-studio_00001_\.png&subfolder=&type=output$/);
});

test('history polling gives up on time instead of hanging', async () => {
	const fetchImpl = fakeFetch([{ match: '/history/', respond: () => json({}) }]);
	const started = Date.now();
	await assert.rejects(
		() => pollHistory('http://127.0.0.1:8188', 'prompt-1', { fetchImpl, timeoutMs: 80, intervalMs: 5 }),
		(error) => error instanceof LocalError && error.code === 'local-timeout' && /within 80 ms/.test(error.message),
	);
	const elapsed = Date.now() - started;
	assert.ok(elapsed < 5000, `a timeout must not hang the caller (took ${elapsed} ms)`);
	assert.ok(fetchImpl.calls.length > 1, 'the poll really asked more than once');
});

test('a job ComfyUI reports as failed is thrown with its own message', async () => {
	const failed = {
		'prompt-1': {
			outputs: {},
			status: {
				status_str: 'error',
				completed: false,
				messages: [['execution_error', { node_type: 'KSampler', exception_message: 'CUDA out of memory' }]],
			},
		},
	};
	const fetchImpl = fakeFetch([{ match: '/history/', respond: () => json(failed) }]);
	await assert.rejects(
		() => pollHistory('http://127.0.0.1:8188', 'prompt-1', { fetchImpl, timeoutMs: 500, intervalMs: 5 }),
		(error) => error.code === 'local-job-failed' && /KSampler: CUDA out of memory/.test(error.message),
	);

	// A record may carry several output nodes; anything without a file name is skipped.
	const many = imagesFromHistory({
		outputs: {
			9: { images: [{ filename: 'a.png' }, { filename: '' }, 'nonsense'] },
			10: { images: [{ filename: 'b.png', subfolder: 'sub', type: 'temp' }] },
			11: { text: ['not an image'] },
		},
	});
	assert.deepEqual(many, [
		{ filename: 'a.png', subfolder: '', type: 'output' },
		{ filename: 'b.png', subfolder: 'sub', type: 'temp' },
	]);
});

//#endregion

//#region generation

test('a local generation fills the template, runs the queue and lands in the gallery', async () => {
	const root = scratch('local-cycle');
	const fetchImpl = fakeFetch(healthyRoutes());

	const result = await generateLocalImages({ live: liveLocal(root), resolveRoot: () => root }, {
		prompt: 'a red chair on a seamless backdrop',
		aspect: '1:1',
		count: 1,
		seed: 777,
	}, { fetchImpl });

	assert.equal(result.count, 1);
	assert.equal(result.entries.length, 1);
	assert.equal(result.model.id, 'local:qwen-image-Q4_K_M');
	assert.equal(result.model.label, 'ComfyUI · qwen-image-Q4_K_M');

	const entry = result.entries[0];
	assert.equal(entry.kind, 'image');
	assert.equal(entry.mime, 'image/png');
	assert.equal(entry.ext, 'png');
	assert.equal(entry.model, 'local:qwen-image-Q4_K_M');
	assert.equal(entry.modelLabel, 'ComfyUI · qwen-image-Q4_K_M');
	assert.equal(entry.prompt, 'a red chair on a seamless backdrop');
	assert.equal(entry.width, 1024);
	assert.equal(entry.height, 1024);
	assert.deepEqual(fs.readFileSync(path.join(root, 'files', `${entry.id}.png`)), PNG);

	// The gallery index is the one the page reads.
	const index = readIndex(root);
	assert.equal(index.items.length, 1);
	assert.equal(index.items[0].id, entry.id);

	// The graph that travelled really was the template with the request in it.
	const posted = JSON.parse(fetchImpl.calls.find((call) => call.url.endsWith('/prompt')).body).prompt;
	assert.equal(posted['4'].inputs.text, 'a red chair on a seamless backdrop');
	assert.equal(posted['7'].inputs.seed, 777);
	assert.equal(posted['7'].inputs.steps, 20);
	assert.equal(posted['6'].inputs.width, 1024);
	assert.equal(posted['1'].inputs.unet_name, 'qwen-image-Q4_K_M.gguf');
	assert.equal(posted['2'].inputs.clip_name, 'qwen_2.5_vl_7b_fp8_scaled.safetensors');
	assert.equal(posted['3'].inputs.vae_name, 'qwen_image_vae.safetensors');

	// Three images asked for means three runs with three different seeds.
	const again = fakeFetch(healthyRoutes());
	const many = await generateLocalImages({ live: liveLocal(root, { localUrl: 'http://127.0.0.1:8188' }), resolveRoot: () => root }, {
		prompt: 'a red chair',
		aspect: '9:16',
		count: 3,
		seed: 5,
	}, { fetchImpl: again });
	assert.equal(many.entries.length, 3);
	assert.equal(many.entries[0].width, 720);
	const seeds = again.calls.filter((call) => call.url.endsWith('/prompt')).map((call) => JSON.parse(call.body).prompt['7'].inputs.seed);
	assert.deepEqual(seeds, [5, 6, 7]);
});

test('an unreachable server fails the generation honestly, and writes nothing', async () => {
	const root = scratch('local-down');
	const refusing = async () => { throw new TypeError('fetch failed'); };

	await assert.rejects(
		() => generateLocalImages({ live: liveLocal(root), resolveRoot: () => root }, { prompt: 'a chair' }, { fetchImpl: refusing }),
		(error) => error instanceof LocalError
			&& error.code === 'local-unreachable'
			&& error.message === 'ComfyUI не отвечает на http://127.0.0.1:8188',
	);
	assert.equal(fs.existsSync(path.join(root, 'gallery.json')), false, 'a failed run must not create the index');
	assert.equal(fs.existsSync(path.join(root, 'files')), false, 'a failed run must not create a media folder');
});

test('a graph ComfyUI rejects is reported with its own message', async () => {
	const root = scratch('local-reject');
	const fetchImpl = fakeFetch([{
		match: '/prompt',
		respond: () => json({ error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: 'UnetLoaderGGUF: unet_name not found' }, node_errors: {} }, 400),
	}]);

	await assert.rejects(
		() => generateLocalImages({ live: liveLocal(root), resolveRoot: () => root }, { prompt: 'a chair' }, { fetchImpl }),
		(error) => error.code === 'local-bad-request' && /UnetLoaderGGUF: unet_name not found/.test(error.message),
	);
});

test('a finished job without an image is a failure, not an empty result', async () => {
	const root = scratch('local-empty');
	const empty = { 'prompt-1': { outputs: { 9: { images: [] } }, status: { status_str: 'success', completed: true } } };
	const fetchImpl = fakeFetch([
		{ match: '/history/', respond: () => json(empty) },
		{ match: '/prompt', respond: () => json({ prompt_id: 'prompt-1' }) },
	]);

	await assert.rejects(
		() => generateLocalImages({ live: liveLocal(root), resolveRoot: () => root }, { prompt: 'a chair' }, { fetchImpl }),
		(error) => error.code === 'local-empty-result',
	);
});

test('the gallery id and label name the person\'s own model file', () => {
	assert.equal(localModelId(''), 'local:comfyui');
	assert.equal(localModelId('C:/models/qwen-image-Q4_K_M.gguf'), 'local:qwen-image-Q4_K_M');
	assert.equal(localModelLabel(''), 'ComfyUI');
	assert.equal(localModelLabel('models/qwen-image.safetensors'), 'ComfyUI · qwen-image');
});

//#endregion

//#region the HTTP route

/** A request object with the surface the handler uses. */
function makeRequest({ url, method = 'GET', body }) {
	const req = new EventEmitter();
	req.url = url;
	req.method = method;
	req.headers = {};
	req.socket = { remoteAddress: '127.0.0.1' };
	process.nextTick(() => {
		if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
		req.emit('end');
	});
	return req;
}

/** A response object that records what the handler wrote. */
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
	Object.defineProperty(res, 'body', { get: () => Buffer.concat(chunks).toString('utf8') });
	return res;
}

async function call(handler, request) {
	const response = makeResponse();
	const settled = new Promise((resolve) => {
		response.once('finish', resolve);
		setTimeout(resolve, 2000);
	});
	await handler(request, response);
	await settled;
	return response;
}

/**
 * Mount the host half with a minimal context: the HTTP surface, and nothing else.
 *
 * No credential store and no tool registry exist here, which is the point — the
 * local path must work without either.
 */
function mountHost(config = {}) {
	const root = scratch('local-host');
	process.env.DSH_IMAGE_STUDIO_HOME = root;
	let registered;
	const ctx = {
		effect: (fn) => fn(),
		inject: () => () => {},
		webServer: { register: (options) => { registered = options; return () => {}; } },
	};
	applyHost(ctx, config);
	assert.ok(registered, 'the plugin must register its HTTP surface');
	return { handler: registered.handler, root };
}

async function waitForJob(handler, id) {
	const deadline = Date.now() + 5000;
	for (;;) {
		const response = await call(handler, makeRequest({ url: `/api/image-studio/job?id=${id}` }));
		const body = JSON.parse(response.body);
		if (body.job.status === 'done' || body.job.status === 'error') return body.job;
		if (Date.now() > deadline) throw new Error(`job ${id} stayed ${body.job.status}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test('POST /generate with provider local runs ComfyUI and writes into the same gallery', async () => {
	const { handler, root } = mountHost({ localModel: 'qwen-image-Q4_K_M.gguf', localSteps: 24 });
	const realFetch = globalThis.fetch;
	const fetchImpl = fakeFetch(healthyRoutes());
	globalThis.fetch = fetchImpl;

	try {
		// The state the page reads carries the local settings, and asking for one
		// generation through the route needs no key at all.
		const state = JSON.parse((await call(handler, makeRequest({ url: '/api/image-studio/state' }))).body);
		assert.equal(state.config.provider, 'fal', 'fal stays the default provider');
		assert.equal(state.config.localUrl, 'http://127.0.0.1:8188');
		assert.equal(state.config.localWorkflow, path.resolve(WORKFLOW));
		assert.equal(state.config.localSteps, 24);
		assert.equal(state.credentials.fal.configured, false);

		const started = await call(handler, makeRequest({
			url: '/api/image-studio/generate',
			method: 'POST',
			body: { provider: 'local', prompt: 'a red chair', aspect: '4:3', count: 1 },
		}));
		assert.equal(started.statusCode, 202, started.body);
		const startedJob = JSON.parse(started.body).job;
		assert.equal(startedJob.request.provider, 'local');

		const job = await waitForJob(handler, startedJob.id);
		assert.equal(job.status, 'done', job.error);
		assert.equal(job.items.length, 1);
		assert.equal(job.items[0].model, 'local:qwen-image-Q4_K_M');
		assert.equal(job.items[0].modelLabel, 'ComfyUI · qwen-image-Q4_K_M');
		assert.equal(job.items[0].width, 1024);
		assert.equal(job.items[0].height, 768);

		const gallery = JSON.parse((await call(handler, makeRequest({ url: '/api/image-studio/gallery' }))).body);
		assert.equal(gallery.items.length, 1);
		assert.equal(gallery.items[0].id, job.items[0].id);

		const index = readIndex(root);
		assert.equal(index.items.length, 1);
		assert.deepEqual(fs.readFileSync(path.join(root, 'files', `${index.items[0].id}.png`)), PNG);
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('POST /generate with provider local and no server fails the job with the honest reason', async () => {
	const { handler } = mountHost();
	const realFetch = globalThis.fetch;
	globalThis.fetch = async () => { throw new TypeError('fetch failed'); };

	try {
		const started = await call(handler, makeRequest({
			url: '/api/image-studio/generate',
			method: 'POST',
			body: { provider: 'local', prompt: 'a red chair' },
		}));
		assert.equal(started.statusCode, 202);

		const job = await waitForJob(handler, JSON.parse(started.body).job.id);
		assert.equal(job.status, 'error');
		assert.equal(job.error, 'ComfyUI не отвечает на http://127.0.0.1:8188');
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('POST /config keeps a local address the person typed and refuses a remote one', async () => {
	const { handler } = mountHost();

	const kept = JSON.parse((await call(handler, makeRequest({
		url: '/api/image-studio/config',
		method: 'POST',
		body: { provider: 'local', localUrl: 'http://localhost:8188/', localSteps: 30 },
	}))).body);
	assert.equal(kept.config.provider, 'local');
	assert.equal(kept.config.localUrl, 'http://localhost:8188');
	assert.equal(kept.config.localSteps, 30);

	const refused = JSON.parse((await call(handler, makeRequest({
		url: '/api/image-studio/config',
		method: 'POST',
		body: { localUrl: 'http://example.com:8188' },
	}))).body);
	assert.equal(refused.config.localUrl, 'http://localhost:8188', 'a refused address leaves the stored one standing');
});

test('a job carries a provider, and the fal path is still the default', async () => {
	const { handler } = mountHost();
	const started = await call(handler, makeRequest({
		url: '/api/image-studio/generate',
		method: 'POST',
		body: { prompt: 'a chair' },
	}));
	assert.equal(started.statusCode, 202);
	// No key is configured, so the fal path fails — but it failed as fal.
	const job = await waitForJob(handler, JSON.parse(started.body).job.id);
	assert.equal(job.request.provider, 'fal');
	assert.equal(job.status, 'error');
	assert.match(job.error, /key/i);
});

//#endregion
