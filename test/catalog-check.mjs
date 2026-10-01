/**
 * Request shaping is the part of the studio that costs money when it is wrong,
 * so every family's body is asserted here against the field names fal's own
 * OpenAPI documents declare.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
	ASPECTS,
	buildImageInput,
	buildVideoInput,
	clampCount,
	extractImages,
	extractVideo,
	isKnownAspect,
	resolveModel,
} from '../lib/catalog.js';

test('every offered aspect is recognised and nothing else is', () => {
	for (const aspect of ASPECTS) assert.equal(isKnownAspect(aspect), true);
	assert.equal(isKnownAspect('7:5'), false);
	assert.equal(isKnownAspect(undefined), false);
});

test('known models resolve and an unknown slug is still runnable', () => {
	assert.equal(resolveModel('openai/gpt-image-2', 'image').label, 'GPT Image 2');
	assert.equal(resolveModel('fal-ai/kling-video/v3/pro/image-to-video', 'video').needsImage, true);

	const custom = resolveModel('acme/custom-image-model', 'image');
	assert.equal(custom.id, 'acme/custom-image-model');
	assert.equal(custom.custom, true);

	assert.equal(resolveModel('', 'image'), undefined);
	assert.equal(resolveModel('no-slash-here', 'image'), undefined);
});

test('a FLUX request carries the size preset and the variant count', () => {
	const body = buildImageInput({
		model: resolveModel('fal-ai/flux-2/klein/9b', 'image'),
		prompt: 'a red chair',
		aspect: '9:16',
		count: 4,
	});
	assert.deepEqual(body, { prompt: 'a red chair', num_images: 4, image_size: 'portrait_16_9' });
});

test('the Nano Banana family is asked with aspect_ratio and resolution, not image_size', () => {
	const body = buildImageInput({
		model: resolveModel('fal-ai/nano-banana-2', 'image'),
		prompt: 'a poster',
		aspect: '16:9',
		count: 2,
		quality: 'high',
		resolution: '4K',
	});
	assert.deepEqual(body, { prompt: 'a poster', num_images: 2, aspect_ratio: '16:9', resolution: '4K' });
});

test('a quality tier is only sent to a model that documents one', () => {
	const withQuality = buildImageInput({
		model: resolveModel('openai/gpt-image-2', 'image'),
		prompt: 'a logo',
		aspect: '1:1',
		count: 1,
		quality: 'high',
	});
	assert.equal(withQuality.quality, 'high');
	assert.equal(withQuality.image_size, 'square_hd');

	const withoutQuality = buildImageInput({
		model: resolveModel('fal-ai/flux-2/klein/9b', 'image'),
		prompt: 'a logo',
		aspect: '1:1',
		count: 1,
		quality: 'high',
	});
	assert.equal(withoutQuality.quality, undefined);
});

test('an integer seed is passed through and a missing one stays absent', () => {
	const seeded = buildImageInput({
		model: resolveModel('fal-ai/flux-2/klein/9b', 'image'),
		prompt: 'p',
		aspect: '1:1',
		count: 1,
		seed: 42,
	});
	assert.equal(seeded.seed, 42);

	const unseeded = buildImageInput({
		model: resolveModel('fal-ai/flux-2/klein/9b', 'image'),
		prompt: 'p',
		aspect: '1:1',
		count: 1,
	});
	assert.equal('seed' in unseeded, false);
});

test('counts are clamped into the range a single call tolerates', () => {
	assert.equal(clampCount(0, 1), 1);
	assert.equal(clampCount(3), 3);
	assert.equal(clampCount(99), 8);
	assert.equal(clampCount('4'), 4);
	assert.equal(clampCount(undefined, 5), 5);
	assert.equal(clampCount('nonsense', 2), 2);
});

test('image-to-video requires a still; text-to-video takes an aspect instead', () => {
	const kling = resolveModel('fal-ai/kling-video/v3/pro/image-to-video', 'video');
	assert.throws(() => buildVideoInput({ model: kling, prompt: 'move', duration: '5' }), /still image/);

	const withImage = buildVideoInput({
		model: kling,
		prompt: 'the camera pushes in',
		duration: '5',
		imageDataUri: 'data:image/png;base64,AAAA',
	});
	assert.deepEqual(withImage, {
		start_image_url: 'data:image/png;base64,AAAA',
		prompt: 'the camera pushes in',
		duration: '5',
	});

	const textOnly = buildVideoInput({
		model: resolveModel('fal-ai/kling-video/v3/standard/text-to-video', 'video'),
		prompt: 'a neon street',
		aspect: '9:16',
		duration: '8',
	});
	assert.deepEqual(textOnly, { aspect_ratio: '9:16', prompt: 'a neon street', duration: '8' });
});

test('an undocumented duration is dropped rather than sent', () => {
	const body = buildVideoInput({
		model: resolveModel('fal-ai/kling-video/v3/standard/text-to-video', 'video'),
		prompt: 'p',
		duration: '45',
	});
	assert.equal('duration' in body, false);
});

test('image results are read from every shape a provider may use', () => {
	const fromImages = extractImages({ images: [{ url: 'https://a/1.png', width: 1024, height: 1024, content_type: 'image/png' }] });
	assert.deepEqual(fromImages, [{ url: 'https://a/1.png', width: 1024, height: 1024, contentType: 'image/png' }]);

	assert.equal(extractImages({ image: { url: 'https://a/2.png' } }).length, 1);
	assert.equal(extractImages({ images: ['https://a/3.png'] })[0].url, 'https://a/3.png');
	assert.equal(extractImages({ data: [{ url: 'https://a/4.png' }] }).length, 1);
	assert.equal(extractImages({}).length, 0);
	assert.equal(extractImages(undefined).length, 0);
});

test('video results are read from a single video or a list', () => {
	assert.equal(extractVideo({ video: { url: 'https://a/v.mp4', content_type: 'video/mp4' } }).url, 'https://a/v.mp4');
	assert.equal(extractVideo({ videos: [{ url: 'https://a/w.mp4' }] }).url, 'https://a/w.mp4');
	assert.equal(extractVideo({ video: 'https://a/raw.mp4' }).url, 'https://a/raw.mp4');
	assert.equal(extractVideo({}), undefined);
});
