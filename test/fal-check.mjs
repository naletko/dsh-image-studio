/**
 * The fal client is exercised against a scripted queue: submit, poll, result,
 * and the failure shapes fal actually returns. No network is involved.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { FalError, falKeyProblem, falSubmit, falWait, fetchBytes } from '../lib/fal.js';

const KEY = 'key-id:key-secret';

/** A fetch that answers from a routing table and records what it was asked. */
function fakeFetch(routes) {
	const calls = [];
	const impl = async (url, init = {}) => {
		calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body, headers: init.headers ?? {} });
		const route = routes.find((entry) => String(url).includes(entry.match));
		if (!route) return new Response('not found', { status: 404 });
		return route.respond(init);
	};
	impl.calls = calls;
	return impl;
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
	status,
	headers: { 'content-type': 'application/json' },
});

test('a key must look like key_id:key_secret', () => {
	assert.match(falKeyProblem(''), /No fal.ai key/);
	assert.match(falKeyProblem('just-one-part'), /key_id:key_secret/);
	assert.equal(falKeyProblem(KEY), undefined);
});

test('submit sends the documented authorization header and reads the ticket', async () => {
	const fetchImpl = fakeFetch([{
		match: 'queue.fal.run/fal-ai/flux-2/klein/9b',
		respond: () => json({
			status: 'IN_QUEUE',
			request_id: 'req-1',
			status_url: 'https://queue.fal.run/status/req-1',
			response_url: 'https://queue.fal.run/result/req-1',
			queue_position: 3,
		}),
	}]);

	const ticket = await falSubmit({
		slug: 'fal-ai/flux-2/klein/9b',
		input: { prompt: 'a chair' },
		apiKey: KEY,
		fetchImpl,
	});

	assert.equal(ticket.requestId, 'req-1');
	assert.equal(ticket.statusUrl, 'https://queue.fal.run/status/req-1');
	assert.equal(ticket.queuePosition, 3);
	assert.equal(fetchImpl.calls[0].headers.authorization, `Key ${KEY}`);
	assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), { prompt: 'a chair' });
});

test('a rejected key is reported as an authorization failure', async () => {
	const fetchImpl = fakeFetch([{ match: 'queue.fal.run', respond: () => new Response('nope', { status: 401 }) }]);
	await assert.rejects(
		() => falSubmit({ slug: 'fal-ai/flux-2/klein/9b', input: {}, apiKey: KEY, fetchImpl }),
		(error) => error instanceof FalError && error.code === 'fal-unauthorized',
	);
});

test('bad parameters are reported with fal\'s own message', async () => {
	const fetchImpl = fakeFetch([{ match: 'queue.fal.run', respond: () => new Response('{"detail":"prompt too long"}', { status: 422 }) }]);
	await assert.rejects(
		() => falSubmit({ slug: 'fal-ai/flux-2/klein/9b', input: {}, apiKey: KEY, fetchImpl }),
		(error) => error.code === 'fal-bad-request' && /prompt too long/.test(error.message),
	);
});

test('a queued job is polled until it completes, then its result is read', async () => {
	let polls = 0;
	const fetchImpl = fakeFetch([
		{
			match: '/fal-ai/flux-2/klein/9b',
			respond: () => json({ status: 'IN_QUEUE', request_id: 'req-2', status_url: 'https://q/status', response_url: 'https://q/result' }),
		},
		{
			match: 'https://q/status',
			respond: () => json({ status: ++polls < 2 ? 'IN_PROGRESS' : 'COMPLETED', queue_position: 1 }),
		},
		{
			match: 'https://q/result',
			respond: () => json({ images: [{ url: 'https://cdn/1.png', width: 512, height: 512 }] }),
		},
	]);

	const seen = [];
	const result = await falWait({
		slug: 'fal-ai/flux-2/klein/9b',
		input: { prompt: 'a chair' },
		apiKey: KEY,
		fetchImpl,
		sleep: async () => {},
		onProgress: (progress) => seen.push(progress.status),
	});

	assert.equal(result.images[0].url, 'https://cdn/1.png');
	assert.deepEqual(seen, ['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED']);
});

test('a model-side failure inside an HTTP 200 body is raised, not returned', async () => {
	const fetchImpl = fakeFetch([
		{ match: '/fal-ai/flux-2/klein/9b', respond: () => json({ status: 'IN_QUEUE', request_id: 'r', status_url: 'https://q/s', response_url: 'https://q/r' }) },
		{ match: 'https://q/s', respond: () => json({ status: 'COMPLETED' }) },
		{ match: 'https://q/r', respond: () => json({ detail: 'content policy violation' }) },
	]);

	await assert.rejects(
		() => falWait({ slug: 'fal-ai/flux-2/klein/9b', input: {}, apiKey: KEY, fetchImpl, sleep: async () => {} }),
		(error) => error.code === 'fal-generation-failed' && /content policy/.test(error.message),
	);
});

test('a job that never completes runs out of time instead of hanging', async () => {
	const fetchImpl = fakeFetch([
		{ match: '/fal-ai/flux-2/klein/9b', respond: () => json({ status: 'IN_QUEUE', request_id: 'r', status_url: 'https://q/s', response_url: 'https://q/r' }) },
		{ match: 'https://q/s', respond: () => json({ status: 'IN_QUEUE' }) },
	]);

	await assert.rejects(
		() => falWait({
			slug: 'fal-ai/flux-2/klein/9b',
			input: {},
			apiKey: KEY,
			fetchImpl,
			timeoutMs: 1,
			sleep: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); },
		}),
		(error) => error.code === 'fal-timeout' || error.code === 'fal-aborted',
	);
});

test('inline data URIs are decoded without a network call', async () => {
	const fetchImpl = fakeFetch([]);
	const { bytes, contentType } = await fetchBytes('data:image/png;base64,aGVsbG8=', { fetchImpl });
	assert.equal(bytes.toString('utf8'), 'hello');
	assert.equal(contentType, 'image/png');
	assert.equal(fetchImpl.calls.length, 0);
});

test('remote media is downloaded as bytes with its content type', async () => {
	const fetchImpl = fakeFetch([{
		match: 'https://cdn/1.png',
		respond: () => new Response(Buffer.from('bytes'), { headers: { 'content-type': 'image/png' } }),
	}]);
	const { bytes, contentType } = await fetchBytes('https://cdn/1.png', { fetchImpl });
	assert.equal(bytes.toString('utf8'), 'bytes');
	assert.equal(contentType, 'image/png');
});
