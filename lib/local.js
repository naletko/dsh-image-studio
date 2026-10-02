/**
 * The local half: a ComfyUI the person already runs, and the plugin only
 * connects to it.
 *
 * This module never downloads anything. It does not install nodes, does not pull
 * model weights, and does not know a single model file name of its own: every
 * request goes to the configured address, which the host accepts only when it is
 * `http(s)` on `127.0.0.1`, `localhost` or `::1` (see {@link localUrlProblem}).
 * The same guard runs on the way in *and* on the way out, so a mistyped profile
 * patch cannot turn a generation into a request to somebody else's machine.
 *
 * The flow is ComfyUI's own HTTP API, in the order the server expects it:
 *
 *   GET  /system_stats      what version, device and VRAM the server reports
 *   POST /prompt            hand over an API-format prompt graph → `prompt_id`
 *   GET  /history/<id>      poll until the prompt's outputs appear
 *   GET  /view              read the produced bytes back
 *
 * Fields this module reads from ComfyUI, by route:
 *
 *   /system_stats   `system.comfyui_version`, `devices[].name`, `devices[].vram_total`
 *   /prompt         `prompt_id`, `number`; on failure `error` / `node_errors`
 *   /history/<id>   `outputs[<node>].images[].filename|subfolder|type`,
 *                   `status.status_str`, `status.messages[].exception_message`
 *   /view           the response body and its `content-type`
 *
 * Everything else ComfyUI returns is ignored on purpose: a field that is absent
 * stays absent in the answer instead of being invented.
 *
 * ## The shipped template
 *
 * `workflow/qwen-image.json` is an API-format prompt graph
 * (`{ "<node id>": { class_type, inputs } }`) — the same shape ComfyUI's
 * "Save (API format)" button writes, which is why `localWorkflow` may point at
 * an exported graph instead. Three of its inputs are the model files, and they
 * are deliberately left as `{{model}}`, `{{clip}}` and `{{vae}}`: this repository
 * does not ship, name or verify any particular weight file. Fill them from the
 * row configuration (`localModel`, `localClip`, `localVae`), or edit the template
 * yourself. The remaining placeholders — `{{prompt}}`, `{{width}}`, `{{height}}`,
 * `{{seed}}`, `{{steps}}` — are filled from the request and the settings.
 *
 * Substitution is a plain literal `replace`, per string, on a parsed JSON object:
 * no `eval`, no template engine, and no string surgery on the file itself, so a
 * prompt containing quotes, backslashes or newlines cannot break the graph.
 *
 * Caveat kept honest: the node classes in the shipped template are ComfyUI's
 * standard Qwen-Image graph (`UNETLoader` / `CLIPLoader` with `type:
 * qwen_image` / `VAELoader` / `EmptySD3LatentImage` / `KSampler`). A GGUF build
 * loads the unet through a custom node (`UnetLoaderGGUF`) instead, so a person on
 * GGUF has to swap node `1` — the template is a starting point, not a claim about
 * their installation.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { clampCount, isKnownAspect } from './catalog.js';
import { addEntries, extensionForMime, newId, writeEntryFile } from './gallery.js';

/** The address a stock ComfyUI listens on. */
export const DEFAULT_LOCAL_URL = 'http://127.0.0.1:8188';

/** Hosts the local provider is allowed to talk to, and nothing else. */
export const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/** Budgets, per call, so no route can hang the page. */
export const DEFAULT_STATUS_TIMEOUT_MS = 8000;
export const DEFAULT_QUEUE_TIMEOUT_MS = 30000;
export const DEFAULT_LOCAL_TIMEOUT_MS = 300000;
export const DEFAULT_MEDIA_TIMEOUT_MS = 60000;

/** How long to wait between two history polls. */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Sampling steps used when the configuration does not say. */
export const DEFAULT_LOCAL_STEPS = 20;

/**
 * Frame size for every aspect the page offers, in pixels.
 *
 * ComfyUI's latent nodes want a multiple of 8, and these are; the values are
 * this plugin's own choice rather than a claim about Qwen-Image's training
 * resolution, which is why they are a table a person can read.
 */
export const LOCAL_ASPECT_SIZES = {
	'1:1': [1024, 1024],
	'4:3': [1024, 768],
	'3:4': [768, 1024],
	'16:9': [1280, 720],
	'9:16': [720, 1280],
};

/** The frame for one aspect, falling back to a square. */
export function localSize(aspect) {
	return LOCAL_ASPECT_SIZES[aspect] ?? LOCAL_ASPECT_SIZES['1:1'];
}

/** A local-ComfyUI failure carrying a stable code the host can branch on. */
export class LocalError extends Error {
	/**
	 * @param message - human-readable reason, safe to show in the page.
	 * @param code - stable machine code, e.g. `local-unreachable`.
	 */
	constructor(message, code) {
		super(message);
		this.name = 'LocalError';
		this.code = code;
	}
}

/**
 * Why a URL cannot be used as the local ComfyUI address.
 *
 * @param value - candidate address.
 * @returns a human message when the address is unusable, otherwise undefined.
 */
export function localUrlProblem(value) {
	const text = typeof value === 'string' ? value.trim() : '';
	if (text === '') return 'No ComfyUI address is configured.';
	let parsed;
	try {
		parsed = new URL(text);
	} catch {
		return 'The ComfyUI address must be a full URL, for example http://127.0.0.1:8188.';
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return 'The ComfyUI address must start with http:// or https://.';
	}
	const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
	if (!LOCAL_HOSTS.includes(host)) {
		return `The local provider connects only to ${LOCAL_HOSTS.join(', ')} — not to "${host}".`;
	}
	return undefined;
}

/**
 * Whether a string is an address this plugin is willing to call.
 *
 * @param value - candidate address.
 * @returns true for http(s) on a loopback host.
 */
export function isLocalComfyUrl(value) {
	return localUrlProblem(value) === undefined;
}

/** The canonical form of a validated address: trimmed, without a trailing slash. */
export function normalizeLocalUrl(value) {
	return String(value ?? '').trim().replace(/\/+$/, '');
}

/**
 * Whether a path is a usable workflow template.
 *
 * The file is read on every generation rather than cached, so editing it takes
 * effect without a restart.
 *
 * @param value - candidate path.
 * @returns true for an existing `.json` file.
 */
export function isWorkflowFile(value) {
	const wanted = typeof value === 'string' ? value.trim() : '';
	if (wanted === '') return false;
	try {
		return fs.statSync(wanted).isFile() && path.extname(wanted).toLowerCase() === '.json';
	} catch {
		return false;
	}
}

/**
 * Read and parse an API-format prompt graph.
 *
 * @param file - path to the JSON template, from `localWorkflow`.
 * @returns the parsed graph.
 * @throws {LocalError} when the path is empty, unreadable, or not a JSON object.
 */
export function readWorkflowTemplate(file) {
	const wanted = typeof file === 'string' ? file.trim() : '';
	if (wanted === '') {
		throw new LocalError('No ComfyUI workflow template is configured.', 'local-workflow-missing');
	}
	let text;
	try {
		text = fs.readFileSync(wanted, 'utf8');
	} catch {
		throw new LocalError(`The ComfyUI workflow template could not be read: ${wanted}`, 'local-workflow-unreadable');
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new LocalError(`The ComfyUI workflow template is not valid JSON: ${wanted}`, 'local-workflow-invalid');
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new LocalError('A ComfyUI API-format workflow is an object keyed by node id.', 'local-workflow-invalid');
	}
	return parsed;
}

/**
 * Fill `{{placeholder}}` tokens in a parsed graph.
 *
 * A value that is exactly one placeholder and whose replacement is a number
 * becomes that number (ComfyUI types `width`, `seed` and friends as integers);
 * every other token is replaced inside the string it appears in. Unknown
 * placeholders are left alone rather than blanked, so a typo is visible in the
 * template instead of silently sending an empty value.
 *
 * @param graph - a parsed API-format graph.
 * @param values - placeholder name → replacement.
 * @returns a new graph; the input is not modified.
 */
export function fillWorkflow(graph, values) {
	const fill = (value) => {
		if (typeof value === 'string') {
			const whole = /^\{\{(\w+)\}\}$/.exec(value);
			if (whole !== null) {
				const replacement = values[whole[1]];
				if (replacement === undefined) return value;
				return typeof replacement === 'number' ? replacement : String(replacement);
			}
			let out = value;
			for (const [key, replacement] of Object.entries(values)) {
				if (replacement === undefined) continue;
				out = out.replaceAll(`{{${key}}}`, String(replacement));
			}
			return out;
		}
		if (Array.isArray(value)) return value.map(fill);
		if (value !== null && typeof value === 'object') {
			const out = {};
			for (const [key, child] of Object.entries(value)) out[key] = fill(child);
			return out;
		}
		return value;
	};
	return fill(graph);
}

/**
 * Ask the server what it is, without ever throwing.
 *
 * A machine with ComfyUI switched off is a normal state for this plugin, not an
 * error: the page asks, gets `reachable: false` with a reason, and keeps its
 * fal path working.
 *
 * @param url - the configured address.
 * @param options.timeoutMs - budget for the probe.
 * @param options.fetchImpl - fetch to use; the tests inject a fake.
 * @returns `{ reachable, url, version?, device?, vram?, reason? }`.
 */
export async function checkServer(url, { timeoutMs = DEFAULT_STATUS_TIMEOUT_MS, fetchImpl } = {}) {
	const problem = localUrlProblem(url);
	if (problem !== undefined) return { reachable: false, url: String(url ?? ''), reason: problem };
	const base = normalizeLocalUrl(url);
	try {
		const response = await fetchAt(base, '/system_stats', { timeoutMs, fetchImpl });
		if (response.status >= 400) {
			return { reachable: false, url: base, reason: `ComfyUI answered HTTP ${response.status} for /system_stats.` };
		}
		const stats = await readJson(response);
		const system = isRecord(stats) && isRecord(stats.system) ? stats.system : {};
		const device = isRecord(stats) && Array.isArray(stats.devices) && isRecord(stats.devices[0]) ? stats.devices[0] : undefined;
		const block = { reachable: true, url: base };
		if (typeof system.comfyui_version === 'string' && system.comfyui_version !== '') block.version = system.comfyui_version;
		if (device !== undefined && typeof device.name === 'string' && device.name !== '') block.device = device.name;
		if (device !== undefined && Number.isFinite(device.vram_total)) block.vram = device.vram_total;
		return block;
	} catch (error) {
		return { reachable: false, url: base, reason: describeLocal(error) };
	}
}

/**
 * Queue one API-format graph.
 *
 * @param url - the configured address.
 * @param workflow - the graph to run.
 * @param options.timeoutMs - budget for the submission.
 * @param options.fetchImpl - fetch to use; the tests inject a fake.
 * @param options.clientId - ComfyUI client id; a fresh one is generated otherwise.
 * @returns `{ promptId, number? }`.
 * @throws {LocalError} on a refused connection, a timeout, or a rejected graph.
 */
export async function queuePrompt(url, workflow, { timeoutMs = DEFAULT_QUEUE_TIMEOUT_MS, fetchImpl, clientId } = {}) {
	const base = requireLocalBase(url);
	if (!isRecord(workflow)) {
		throw new LocalError('A ComfyUI API-format workflow is an object keyed by node id.', 'local-workflow-invalid');
	}
	const response = await fetchAt(base, '/prompt', {
		method: 'POST',
		body: { prompt: workflow, client_id: clientId ?? crypto.randomUUID() },
		timeoutMs,
		fetchImpl,
	});
	if (response.status >= 400) {
		const raw = await safeText(response);
		throw new LocalError(
			`ComfyUI rejected the workflow (HTTP ${response.status}): ${rejectionText(raw)}`,
			'local-bad-request',
		);
	}
	const body = await readJson(response);
	const promptId = isRecord(body) && typeof body.prompt_id === 'string' ? body.prompt_id : '';
	if (promptId === '') {
		throw new LocalError('ComfyUI accepted the workflow but did not return a prompt id.', 'local-bad-response');
	}
	const number = isRecord(body) && Number.isFinite(body.number) ? body.number : undefined;
	return number === undefined ? { promptId } : { promptId, number };
}

/**
 * Wait for one prompt's outputs.
 *
 * The poll is bounded twice: each request carries the remaining budget, and the
 * loop itself gives up when the budget is spent, so a server that answers `{}`
 * forever ends the job with a readable timeout instead of hanging the page.
 *
 * @param url - the configured address.
 * @param promptId - the id `/prompt` returned.
 * @param options.timeoutMs - total budget for the wait.
 * @param options.intervalMs - delay between polls.
 * @param options.fetchImpl - fetch to use; the tests inject a fake.
 * @param options.sleep - sleep implementation; the tests inject a fake.
 * @param options.onProgress - observer called with `{ status }` after each poll.
 * @returns `{ promptId, images, status }`, images as `{ filename, subfolder, type }`.
 * @throws {LocalError} on a timeout or a job ComfyUI reports as failed.
 */
export async function pollHistory(url, promptId, {
	timeoutMs = DEFAULT_LOCAL_TIMEOUT_MS,
	intervalMs = DEFAULT_POLL_INTERVAL_MS,
	fetchImpl,
	sleep = defaultSleep,
	onProgress,
} = {}) {
	const base = requireLocalBase(url);
	const id = typeof promptId === 'string' ? promptId.trim() : '';
	if (id === '') throw new LocalError('There is no ComfyUI prompt to wait for.', 'local-prompt-missing');
	const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LOCAL_TIMEOUT_MS;
	const deadline = Date.now() + budget;

	for (;;) {
		if (Date.now() >= deadline) {
			throw new LocalError(`ComfyUI did not finish the job within ${budget} ms.`, 'local-timeout');
		}
		const response = await fetchAt(base, `/history/${encodeURIComponent(id)}`, {
			timeoutMs: Math.max(1, deadline - Date.now()),
			fetchImpl,
		});
		if (response.status >= 400) {
			throw new LocalError(`ComfyUI answered HTTP ${response.status} for the job history.`, 'local-history-failed');
		}
		const body = await readJson(response);
		const record = isRecord(body) && isRecord(body[id]) ? body[id] : undefined;
		if (record !== undefined) {
			const images = imagesFromHistory(record);
			if (images.length > 0) return { promptId: id, images, status: record.status };
			if (isRecord(record.status) && record.status.status_str === 'error') {
				const reason = failureText(record) || 'no reason given';
				throw new LocalError(`ComfyUI failed the job: ${reason}`, 'local-job-failed');
			}
			// A record marked successful without images is finished, not pending:
			// the caller decides that an empty result is a failure.
			if (isRecord(record.status) && record.status.status_str === 'success') {
				return { promptId: id, images: [], status: record.status };
			}
		}
		onProgress?.({ status: 'running' });
		await sleep(Math.max(1, Math.min(intervalMs, deadline - Date.now())));
	}
}

/**
 * Read the images a finished history record carries.
 *
 * Every output node is inspected: a graph may save from more than one node, and
 * anything without a file name is skipped rather than guessed at.
 *
 * @param record - one `/history/<id>` entry.
 * @returns `{ filename, subfolder, type }` per produced image.
 */
export function imagesFromHistory(record) {
	const outputs = isRecord(record) && isRecord(record.outputs) ? record.outputs : undefined;
	if (outputs === undefined) return [];
	const images = [];
	for (const output of Object.values(outputs)) {
		if (!isRecord(output) || !Array.isArray(output.images)) continue;
		for (const image of output.images) {
			if (!isRecord(image) || typeof image.filename !== 'string' || image.filename === '') continue;
			images.push({
				filename: image.filename,
				subfolder: typeof image.subfolder === 'string' ? image.subfolder : '',
				type: typeof image.type === 'string' && image.type !== '' ? image.type : 'output',
			});
		}
	}
	return images;
}

/**
 * Read one produced image back through `/view`.
 *
 * @param url - the configured address.
 * @param filename - `filename` from the history record.
 * @param subfolder - `subfolder` from the history record.
 * @param type - `type` from the history record (`output`, `temp`, …).
 * @param options.timeoutMs - budget for the download.
 * @param options.fetchImpl - fetch to use; the tests inject a fake.
 * @returns `{ bytes, contentType }`.
 * @throws {LocalError} when the file is missing or empty.
 */
export async function fetchImage(url, filename, subfolder = '', type = 'output', { timeoutMs = DEFAULT_MEDIA_TIMEOUT_MS, fetchImpl } = {}) {
	const base = requireLocalBase(url);
	const name = typeof filename === 'string' ? filename.trim() : '';
	if (name === '') throw new LocalError('ComfyUI reported an image without a file name.', 'local-media-missing');
	const params = new URLSearchParams({ filename: name, subfolder: String(subfolder ?? ''), type: String(type ?? 'output') });
	const response = await fetchAt(base, `/view?${params.toString()}`, { timeoutMs, fetchImpl });
	if (response.status >= 400) {
		throw new LocalError(`ComfyUI could not serve the image (HTTP ${response.status}).`, 'local-media-failed');
	}
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.length === 0) throw new LocalError('ComfyUI served an empty image.', 'local-media-empty');
	return { bytes, contentType: response.headers.get('content-type') ?? undefined };
}

/**
 * Run one local generation and store what it produced.
 *
 * This is the page's and the tool's single local path, matching
 * `generateImages` in `lib/tool.js`: it fills the template, queues it, waits,
 * reads every image back, and appends the same gallery records through
 * `lib/gallery.js` — the only difference is that the bytes come from the
 * person's own server and no key is involved.
 *
 * @param deps.live - the resolved configuration.
 * @param deps.resolveRoot - () => the absolute library root to write into.
 * @param deps.fetchImpl - fetch to use; the tests inject a fake.
 * @param request - `{ prompt, aspect?, count?, seed? }`.
 * @param options.onStart - called once the request and template are validated.
 * @param options.onProgress - observer called with `{ status, requestId }`.
 * @param options.fetchImpl - fetch to use; the tests inject a fake.
 * @returns `{ model: { id, label }, aspect, count, root, entries }`.
 * @throws {LocalError} for a bad address, an unreadable template, an
 *   unreachable server, a timeout, or a finished job without images.
 */
export async function generateLocalImages(deps, request, options = {}) {
	const live = isRecord(deps?.live) ? deps.live : {};
	const resolveRoot = deps?.resolveRoot;
	const fetchImpl = options.fetchImpl ?? deps?.fetchImpl;

	const base = requireLocalBase(live.localUrl);
	const template = readWorkflowTemplate(live.localWorkflow);

	const prompt = String(request?.prompt ?? '').trim();
	if (prompt === '') throw new LocalError('Write a prompt first.', 'local-prompt-missing');

	const aspect = isKnownAspect(request?.aspect) ? request.aspect : '1:1';
	const [width, height] = localSize(aspect);
	const count = clampCount(request?.count, 1);
	const steps = Number.isFinite(live.localSteps) && live.localSteps > 0 ? Math.round(live.localSteps) : DEFAULT_LOCAL_STEPS;
	const modelFile = stringOrEmpty(live.localModel);
	const clipFile = stringOrEmpty(live.localClip);
	const vaeFile = stringOrEmpty(live.localVae);
	const timeoutMs = Number.isFinite(live.localTimeoutMs) && live.localTimeoutMs > 0 ? live.localTimeoutMs : DEFAULT_LOCAL_TIMEOUT_MS;
	const baseSeed = Number.isInteger(request?.seed) ? request.seed : Math.floor(Math.random() * 2 ** 32);

	options.onStart?.();

	// Resolved once, after the address and the template proved usable: a
	// generation that never reaches the server must not create a media folder.
	let root;
	const entries = [];
	for (let run = 0; run < count; run += 1) {
		const seed = (baseSeed + run) % 2 ** 32;
		const workflow = fillWorkflow(template, {
			prompt, width, height, seed, steps,
			model: modelFile,
			clip: clipFile,
			vae: vaeFile,
		});
		const queued = await queuePrompt(base, workflow, { timeoutMs: DEFAULT_QUEUE_TIMEOUT_MS, fetchImpl });
		options.onProgress?.({ status: 'running', requestId: queued.promptId });
		const history = await pollHistory(base, queued.promptId, { timeoutMs, fetchImpl, onProgress: options.onProgress });
		if (history.images.length === 0) {
			throw new LocalError('ComfyUI finished the job without producing an image.', 'local-empty-result');
		}
		if (root === undefined) root = resolveRoot();
		for (const image of history.images) {
			const fetched = await fetchImage(base, image.filename, image.subfolder, image.type, { timeoutMs: DEFAULT_MEDIA_TIMEOUT_MS, fetchImpl });
			entries.push(writeEntryFile(root, {
				id: newId(),
				bytes: fetched.bytes,
				ext: extensionForMime(fetched.contentType, 'png'),
				meta: {
					createdAt: Date.now(),
					index: entries.length,
					kind: 'image',
					prompt,
					model: localModelId(modelFile),
					modelLabel: localModelLabel(modelFile),
					aspect,
					width,
					height,
				},
			}));
		}
	}
	addEntries(root, entries);
	return { model: { id: localModelId(modelFile), label: localModelLabel(modelFile) }, aspect, count, root, entries };
}

/**
 * The gallery `model` id of a local generation.
 *
 * It is namespaced so a local result is never mistaken for a fal endpoint, and
 * it carries no secret: the model file name is the person's own configuration.
 *
 * @param modelFile - the configured unet path, possibly empty.
 * @returns e.g. `local:qwen-image-Q4_K_M`.
 */
export function localModelId(modelFile) {
	const name = stringOrEmpty(modelFile);
	return `local:${name === '' ? 'comfyui' : path.basename(name, path.extname(name))}`;
}

/**
 * The gallery label a person reads on the card.
 *
 * @param modelFile - the configured unet path, possibly empty.
 * @returns e.g. `ComfyUI · qwen-image-Q4_K_M`.
 */
export function localModelLabel(modelFile) {
	const name = stringOrEmpty(modelFile);
	return name === '' ? 'ComfyUI' : `ComfyUI · ${path.basename(name, path.extname(name))}`;
}

/** The validated, canonical address, or a thrown refusal. */
function requireLocalBase(url) {
	const problem = localUrlProblem(url);
	if (problem !== undefined) throw new LocalError(problem, 'local-url');
	return normalizeLocalUrl(url);
}

/** One request against a validated base, with a timeout and readable failures. */
async function fetchAt(base, pathname, { method = 'GET', body, timeoutMs, fetchImpl } = {}) {
	const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LOCAL_TIMEOUT_MS;
	const target = `${base}${pathname}`;
	try {
		return await (fetchImpl ?? fetch)(target, {
			method,
			...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(Math.max(1, budget)),
		});
	} catch (error) {
		if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
			throw new LocalError(`ComfyUI did not answer within ${budget} ms (${pathname}).`, 'local-timeout');
		}
		throw new LocalError(`ComfyUI не отвечает на ${base}`, 'local-unreachable');
	}
}

/** Parse a JSON body, tolerating an empty or unreadable one. */
async function readJson(response) {
	try {
		const text = await response.text();
		return text === '' ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Read a body for an error message without letting a read failure mask it. */
async function safeText(response) {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

/**
 * The readable part of a ComfyUI rejection.
 *
 * `/prompt` answers with `{ error: { message, details }, node_errors: { … } }`
 * when a graph is invalid, and the message is what tells a person which node is
 * wrong — so it travels to the page instead of a bare status code.
 */
function rejectionText(raw) {
	let body;
	try {
		body = raw === '' ? undefined : JSON.parse(raw);
	} catch {
		body = undefined;
	}
	if (isRecord(body)) {
		if (isRecord(body.error) && typeof body.error.message === 'string' && body.error.message !== '') {
			const details = typeof body.error.details === 'string' && body.error.details !== '' ? ` — ${body.error.details}` : '';
			return `${body.error.message}${details}`;
		}
		if (typeof body.error === 'string' && body.error !== '') return body.error;
		if (isRecord(body.node_errors)) {
			const first = Object.values(body.node_errors).find((entry) => isRecord(entry));
			if (first !== undefined && typeof first.message === 'string' && first.message !== '') return first.message;
		}
	}
	const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
	return text.length <= 300 ? text || 'no reason given' : `${text.slice(0, 300)}…`;
}

/** The reason inside a failed history record, when ComfyUI gives one. */
function failureText(record) {
	const messages = isRecord(record) && isRecord(record.status) && Array.isArray(record.status.messages) ? record.status.messages : [];
	for (const entry of messages) {
		if (!Array.isArray(entry) || !isRecord(entry[1])) continue;
		const payload = entry[1];
		const node = typeof payload.node_type === 'string' && payload.node_type !== '' ? `${payload.node_type}: ` : '';
		if (typeof payload.exception_message === 'string' && payload.exception_message !== '') return `${node}${payload.exception_message}`;
		if (typeof payload.message === 'string' && payload.message !== '') return `${node}${payload.message}`;
	}
	return '';
}

/** The message of a thrown local failure. */
function describeLocal(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Sleep that never wakes past the caller's deadline by accident. */
function defaultSleep(ms) {
	return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function stringOrEmpty(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function isRecord(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}
