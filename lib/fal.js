/**
 * A small client for fal's queue API.
 *
 * fal is not OpenAI-shaped: a request goes to `https://queue.fal.run/<slug>`
 * with `Authorization: Key <key_id>:<key_secret>`, the POST answers with a queue
 * ticket, the ticket's `status_url` is polled until it reports COMPLETED, and
 * the finished payload is read from the ticket's `response_url`.
 *
 * Every function takes the key explicitly and accepts a deadline plus an
 * AbortSignal, so the host can bound a call without this module holding state.
 * Field names, the status vocabulary, and the error shapes follow fal's own
 * OpenAPI documents.
 */

/** Where a queue ticket is created. */
export const FAL_QUEUE_BASE = 'https://queue.fal.run';

/** How long to wait between two status polls. */
export const DEFAULT_POLL_INTERVAL_MS = 1500;

/** Largest error body kept for a diagnostic message. */
const MAX_ERROR_BODY = 400;

/** A fal failure carrying a stable code the host can branch on. */
export class FalError extends Error {
	/**
	 * @param message - human-readable reason.
	 * @param code - stable machine code, e.g. `fal-unauthorized`.
	 */
	constructor(message, code) {
		super(message);
		this.name = 'FalError';
		this.code = code;
	}
}

/**
 * Whether a string could be a fal key at all.
 *
 * @param key - candidate key.
 * @returns a human message when the key is unusable, otherwise undefined.
 */
export function falKeyProblem(key) {
	const wanted = typeof key === 'string' ? key.trim() : '';
	if (wanted === '') return 'No fal.ai key is stored yet. Open the Images page and paste your key.';
	if (!/^[^:\s]+:[^:\s]+$/.test(wanted)) {
		return 'The fal.ai key must be the whole "key_id:key_secret" string from fal.ai → Keys.';
	}
	return undefined;
}

/**
 * Submit one request and return its queue ticket without waiting for the result.
 *
 * @param options.slug - endpoint id, e.g. `fal-ai/flux-2/klein/9b`.
 * @param options.input - endpoint payload.
 * @param options.apiKey - FAL_KEY.
 * @param options.signal - optional cancellation.
 * @param options.deadline - absolute epoch-ms budget for the submission itself.
 * @param options.fetchImpl - fetch to use; the tests inject a fake.
 * @returns `{ requestId, status, queuePosition, statusUrl, responseUrl }`.
 */
export async function falSubmit({ slug, input, apiKey, signal, deadline, fetchImpl = fetch }) {
	const problem = falKeyProblem(apiKey);
	if (problem !== undefined) throw new FalError(problem, 'fal-key-missing');

	const response = await falFetch(`${FAL_QUEUE_BASE}/${slug}`, {
		method: 'POST',
		headers: { authorization: `Key ${String(apiKey).trim()}`, 'content-type': 'application/json' },
		body: JSON.stringify(input ?? {}),
	}, { signal, deadline, label: `submit ${slug}`, fetchImpl });

	if (response.status === 401 || response.status === 403) {
		throw new FalError('fal rejected the request: the key is invalid or has no access to this model.', 'fal-unauthorized');
	}
	if (response.status === 404) {
		throw new FalError(`fal has no endpoint named ${slug}.`, 'fal-endpoint-not-found');
	}
	if (response.status === 400 || response.status === 422) {
		throw new FalError(`fal rejected the parameters (HTTP ${response.status}): ${clip(response.text)}`, 'fal-bad-request');
	}
	if (response.status >= 500) {
		throw new FalError(`fal failed on its side (HTTP ${response.status}): ${clip(response.text)}`, 'fal-server-error');
	}
	if (response.json === undefined || typeof response.json !== 'object') {
		throw new FalError(`fal answered with something unreadable: ${clip(response.text)}`, 'fal-bad-response');
	}

	const ticket = response.json;
	const requestId = typeof ticket.request_id === 'string' ? ticket.request_id : '';
	return {
		requestId,
		status: typeof ticket.status === 'string' ? ticket.status : 'IN_QUEUE',
		queuePosition: numberOrUndefined(ticket.queue_position),
		statusUrl: typeof ticket.status_url === 'string' && ticket.status_url !== ''
			? ticket.status_url
			: `${FAL_QUEUE_BASE}/${slug}/requests/${requestId}/status`,
		responseUrl: typeof ticket.response_url === 'string' && ticket.response_url !== ''
			? ticket.response_url
			: `${FAL_QUEUE_BASE}/${slug}/requests/${requestId}`,
	};
}

/**
 * Poll one ticket once.
 *
 * @param options.statusUrl - the ticket's `status_url`.
 * @param options.apiKey - FAL_KEY.
 * @param options.signal - optional cancellation.
 * @param options.deadline - absolute epoch-ms budget for this poll.
 * @param options.fetchImpl - fetch to use; the tests inject a fake.
 * @returns `{ status, queuePosition }` using fal's own vocabulary.
 */
export async function falStatus({ statusUrl, apiKey, signal, deadline, fetchImpl = fetch }) {
	const response = await falFetch(statusUrl, {
		method: 'GET',
		headers: { authorization: `Key ${String(apiKey).trim()}` },
	}, { signal, deadline, label: 'poll fal status', fetchImpl });
	if (response.status >= 400) {
		throw new FalError(`Polling the fal queue failed (HTTP ${response.status}).`, 'fal-status-failed');
	}
	const body = response.json ?? {};
	return {
		status: typeof body.status === 'string' ? body.status : 'IN_PROGRESS',
		queuePosition: numberOrUndefined(body.queue_position),
	};
}

/**
 * Read a finished ticket's payload.
 *
 * @param options.responseUrl - the ticket's `response_url`.
 * @param options.apiKey - FAL_KEY.
 * @param options.signal - optional cancellation.
 * @param options.deadline - absolute epoch-ms budget for this read.
 * @param options.fetchImpl - fetch to use; the tests inject a fake.
 * @returns the parsed result body.
 */
export async function falResult({ responseUrl, apiKey, signal, deadline, fetchImpl = fetch }) {
	const response = await falFetch(responseUrl, {
		method: 'GET',
		headers: { authorization: `Key ${String(apiKey).trim()}` },
	}, { signal, deadline, label: 'read fal result', fetchImpl });
	if (response.status >= 400) {
		throw new FalError(`Reading the fal result failed (HTTP ${response.status}): ${clip(response.text)}`, 'fal-result-failed');
	}
	if (response.json === undefined) {
		throw new FalError('fal returned a result this plugin could not parse.', 'fal-bad-response');
	}
	const failure = describeFailure(response.json);
	if (failure !== undefined) throw new FalError(failure, 'fal-generation-failed');
	return response.json;
}

/**
 * Submit, wait, and return the finished payload in one call.
 *
 * @param options.slug - endpoint id.
 * @param options.input - endpoint payload.
 * @param options.apiKey - FAL_KEY.
 * @param options.signal - optional cancellation.
 * @param options.timeoutMs - total budget for submit, queue, and result.
 * @param options.pollIntervalMs - delay between polls.
 * @param options.onProgress - observer called with `{ status, queuePosition, requestId }`.
 * @param options.sleep - sleep implementation; the tests inject a fake.
 * @param options.fetchImpl - fetch to use; the tests inject a fake.
 * @returns the parsed result body.
 */
export async function falWait({
	slug,
	input,
	apiKey,
	signal,
	timeoutMs = 180000,
	pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
	onProgress,
	sleep = defaultSleep,
	fetchImpl = fetch,
}) {
	const deadline = Date.now() + timeoutMs;
	const ticket = await falSubmit({ slug, input, apiKey, signal, deadline, fetchImpl });
	onProgress?.({ status: ticket.status, queuePosition: ticket.queuePosition, requestId: ticket.requestId });

	let status = ticket.status;
	while (status !== 'COMPLETED') {
		if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
			throw new FalError(`The fal job ended as ${status}.`, 'fal-generation-failed');
		}
		if (Date.now() >= deadline) {
			throw new FalError('The fal job did not finish within the configured timeout.', 'fal-timeout');
		}
		await sleep(pollIntervalMs, signal);
		const ticked = await falStatus({ statusUrl: ticket.statusUrl, apiKey, signal, deadline, fetchImpl });
		status = ticked.status;
		onProgress?.({ status, queuePosition: ticked.queuePosition ?? ticket.queuePosition, requestId: ticket.requestId });
	}
	return falResult({ responseUrl: ticket.responseUrl, apiKey, signal, deadline, fetchImpl });
}

/**
 * Download produced bytes. A `data:` URL is decoded locally instead of fetched,
 * because fal may answer with an inline image for an endpoint that asked for it.
 *
 * @param url - remote URL or data URI.
 * @param options.signal - optional cancellation.
 * @param options.deadline - absolute epoch-ms budget.
 * @param options.fetchImpl - fetch to use; the tests inject a fake.
 * @returns `{ bytes, contentType }`.
 */
export async function fetchBytes(url, { signal, deadline, fetchImpl = fetch } = {}) {
	const wanted = typeof url === 'string' ? url.trim() : '';
	if (wanted === '') throw new FalError('fal returned an empty media URL.', 'fal-media-missing');
	if (wanted.startsWith('data:')) {
		const comma = wanted.indexOf(',');
		if (comma < 0) throw new FalError('fal returned a malformed data URI.', 'fal-media-invalid');
		const header = wanted.slice(5, comma);
		const payload = wanted.slice(comma + 1);
		const bytes = header.includes(';base64')
			? Buffer.from(payload, 'base64')
			: Buffer.from(decodeURIComponent(payload));
		return { bytes, contentType: header.split(';')[0] || undefined };
	}
	const response = await falFetch(wanted, { method: 'GET' }, { signal, deadline, label: 'download media', raw: true, fetchImpl });
	if (response.status >= 400) {
		throw new FalError(`Downloading the media failed (HTTP ${response.status}).`, 'fal-media-download-failed');
	}
	return { bytes: response.bytes, contentType: response.contentType };
}

/**
 * Turn a finished payload into a failure when it carries one. fal reports a
 * model-side failure inside an HTTP 200 body, so the shape has to be inspected.
 *
 * @param body - parsed result body.
 * @returns a message when the body is a failure, otherwise undefined.
 */
export function describeFailure(body) {
	if (body === null || typeof body !== 'object') return undefined;
	const detail = body.detail;
	if (typeof detail === 'string' && detail.trim() !== '') return `fal reported a failure: ${clip(detail)}`;
	if (Array.isArray(detail) && detail.length > 0) {
		const first = detail[0];
		const message = first !== null && typeof first === 'object' && typeof first.msg === 'string'
			? first.msg
			: JSON.stringify(first);
		return `fal reported a failure: ${clip(message)}`;
	}
	if (typeof body.error === 'string' && body.error.trim() !== '') return `fal reported a failure: ${clip(body.error)}`;
	return undefined;
}

/** Sleep that wakes up early when the caller cancels. */
function defaultSleep(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new FalError('The call was cancelled.', 'fal-aborted'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener?.('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new FalError('The call was cancelled.', 'fal-aborted'));
		};
		signal?.addEventListener?.('abort', onAbort, { once: true });
	});
}

/** One fetch with cancellation, a deadline, and a readable transport failure. */
async function falFetch(url, init, { signal, deadline, label, raw = false, fetchImpl = fetch }) {
	const remaining = deadline === undefined ? undefined : deadline - Date.now();
	if (remaining !== undefined && remaining <= 0) {
		throw new FalError(`${label} ran out of time.`, 'fal-timeout');
	}
	const signals = [];
	if (remaining !== undefined) signals.push(AbortSignal.timeout(Math.max(1, remaining)));
	if (signal) signals.push(signal);
	const combined = signals.length === 0
		? undefined
		: signals.length === 1
			? signals[0]
			: (typeof AbortSignal.any === 'function' ? AbortSignal.any(signals) : signals[0]);

	let response;
	try {
		response = await fetchImpl(url, { ...init, signal: combined });
	} catch (error) {
		if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
			throw new FalError(`${label} was aborted or timed out.`, 'fal-aborted');
		}
		throw new FalError(`${label} failed: ${error instanceof Error ? error.message : String(error)}`, 'fal-network');
	}

	if (raw) {
		const bytes = Buffer.from(await response.arrayBuffer());
		return { status: response.status, bytes, contentType: response.headers.get('content-type') ?? undefined };
	}
	const text = await response.text();
	let json;
	try {
		json = text === '' ? undefined : JSON.parse(text);
	} catch {
		json = undefined;
	}
	return { status: response.status, text, json, contentType: response.headers.get('content-type') ?? undefined };
}

function numberOrUndefined(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clip(value) {
	const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
	return text.length <= MAX_ERROR_BODY ? text : `${text.slice(0, MAX_ERROR_BODY)}…`;
}
