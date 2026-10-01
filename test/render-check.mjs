/**
 * The page has to survive being rendered: a missing guard around `state` or a
 * dictionary key that does not exist leaves an empty page and a console error in
 * the live application, where nothing else would report it.
 *
 * The test loads the real client half in a sandbox and hands it a miniature
 * React. Effects never run, so this asserts the render path only — which is
 * exactly the part a browser would fail on — and each component instance gets
 * its own hook cells, seeded by component identity so a loaded page can be
 * rendered without a host.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** One component instance's hook cells. */
function makeInstance(seed) {
	let cursor = 0;
	const cells = { ...seed };
	return {
		useState(initial) {
			const index = cursor++;
			if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial;
			return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next; }];
		},
		useEffect() {},
		useRef(initial) {
			const index = cursor++;
			if (!(index in cells)) cells[index] = { current: initial ?? null };
			return cells[index];
		},
		useCallback(fn) {
			cursor++;
			return fn;
		},
	};
}

/**
 * Load the client module with a React whose hooks follow the instance the
 * renderer is currently inside.
 *
 * @returns `{ components, render, findAll, textOf }`.
 */
function loadHarness() {
	let current = makeInstance({});
	const seeds = new Map();

	const react = {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
		useState: (...args) => current.useState(...args),
		useEffect: (...args) => current.useEffect(...args),
		useRef: (...args) => current.useRef(...args),
		useCallback: (...args) => current.useCallback(...args),
	};

	let declaration;
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		fetch: async () => {
			throw new Error('a render must not fetch');
		},
		navigator: { clipboard: { writeText: async () => {} } },
		document: { documentElement: { lang: 'ru' }, getElementById: () => null, head: { appendChild: () => {} } },
	};
	sandbox.window = { __ModuleLoader__: { load: (value) => { declaration = value; } } };
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox);

	const module = declaration.factory((name) => {
		if (name === 'react') return react;
		throw new Error(`unexpected require("${name}")`);
	});
	assert.ok(module.__test, 'the module must expose its components for the suite');

	/** Render a tree, resolving function components with their own hooks. */
	function render(node, depth = 0) {
		assert.ok(depth < 80, 'the tree is deeper than any real page, so something recurses');
		if (node === null || node === undefined || typeof node === 'boolean') return null;
		if (typeof node === 'string' || typeof node === 'number') return String(node);
		if (Array.isArray(node)) return node.map((child) => render(child, depth + 1));
		if (typeof node.type === 'function') {
			const previous = current;
			current = makeInstance(seeds.get(node.type) ?? {});
			try {
				return render(node.type(node.props), depth + 1);
			} finally {
				current = previous;
			}
		}
		return { type: node.type, props: node.props, children: node.children.map((child) => render(child, depth + 1)) };
	}

	function textOf(tree) {
		if (tree === null) return '';
		if (typeof tree === 'string') return tree;
		if (Array.isArray(tree)) return tree.map(textOf).join(' ');
		return textOf(tree.children);
	}

	function findAll(tree, type, out = []) {
		if (tree === null || typeof tree === 'string') return out;
		if (Array.isArray(tree)) {
			for (const child of tree) findAll(child, type, out);
			return out;
		}
		if (tree.type === type) out.push(tree);
		for (const child of tree.children) findAll(child, type, out);
		return out;
	}

	return { components: module.__test, render, textOf, findAll, seeds, react };
}

const catalog = {
	imageModels: [
		{ id: 'fal-ai/flux-2/klein/9b', label: 'FLUX.2 Klein 9B', qualities: [], resolutions: [], defaultCount: 4 },
		{ id: 'openai/gpt-image-2', label: 'GPT Image 2', qualities: ['auto', 'high'], resolutions: [], defaultCount: 2 },
	],
	videoModels: [
		{ id: 'fal-ai/kling-video/v3/pro/image-to-video', label: 'Kling v3 Pro', needsImage: true },
		{ id: 'fal-ai/kling-video/v3/standard/text-to-video', label: 'Kling v3 Standard', needsImage: false },
	],
	aspects: ['1:1', '4:3', '3:4', '16:9', '9:16'],
	durations: ['3', '5', '8', '10', '12'],
	templates: [
		{ id: 'product-hero', label: { ru: 'Продукт на подиуме', en: 'Product hero' }, prompt: { ru: 'Сними {{subject}}', en: 'Shoot {{subject}}' }, aspect: '1:1' },
	],
	defaultImageModel: 'fal-ai/flux-2/klein/9b',
	defaultVideoModel: 'fal-ai/kling-video/v3/pro/image-to-video',
};

const imageItem = {
	id: 'a'.repeat(24),
	kind: 'image',
	mime: 'image/png',
	url: `/api/image-studio/file?id=${'a'.repeat(24)}`,
	prompt: 'a red chair on a seamless backdrop',
	model: 'fal-ai/flux-2/klein/9b',
	modelLabel: 'FLUX.2 Klein 9B',
	aspect: '1:1',
	width: 1024,
	height: 1024,
	bytes: 204800,
	createdAt: 1_770_000_000_000,
	favorite: false,
};

const videoItem = { ...imageItem, id: 'b'.repeat(24), kind: 'video', mime: 'video/mp4', duration: '5', aspect: '9:16' };

/** The state payload the host answers with on a configured machine. */
const loadedState = {
	config: { falKeyRef: 'FAL_API_KEY', defaultModel: 'fal-ai/flux-2/klein/9b', defaultAspect: '1:1', defaultCount: 1 },
	catalog,
	credentials: { fal: { configured: true, source: 'file', writable: true } },
	storage: { root: 'C:/Users/me/.dsh/image-studio' },
	stats: { total: 2, images: 1, videos: 1, favorites: 0 },
};

test('the page renders before the host answers anything', () => {
	const { components, render, textOf, findAll, react } = loadHarness();
	const tree = render(react.createElement(components.ImagesPanel, {}));
	assert.match(textOf(tree), /Изображения/);
	// Only the variant picker is catalogue-independent; the model and aspect
	// pickers wait for the host instead of rendering empty.
	assert.equal(findAll(tree, 'select').length, 1);
	assert.ok(findAll(tree, 'textarea').length >= 1, 'the prompt box belongs to the page');
});

test('a loaded page shows the pickers, the counters and a card per entry', () => {
	const { components, render, textOf, findAll, seeds, react } = loadHarness();
	seeds.set(components.ImagesPanel, { 0: loadedState, 1: [imageItem, videoItem] });

	const tree = render(react.createElement(components.ImagesPanel, {}));
	const text = textOf(tree);

	assert.match(text, /2 работ/);
	assert.equal(findAll(tree, 'select').length, 3, 'model, aspect and variants');
	assert.match(text, /FLUX\.2 Klein 9B/, 'the model picker lists the catalogue');
	assert.match(text, /Галерея/);
	assert.match(text, /Шаблоны/);
	assert.match(text, /Картинки/);

	// Both entries render: an image and a video with its duration badge.
	assert.equal(findAll(tree, 'img').length, 1);
	assert.equal(findAll(tree, 'video').length, 1);
	assert.match(text, /red chair/);

	// A configured key means the alert about a missing one is absent.
	assert.equal(/Ключ fal\.ai не задан/.test(text), false);
});

test('a page without a key tells the person where to put it', () => {
	const { components, render, textOf, seeds, react } = loadHarness();
	seeds.set(components.ImagesPanel, {
		0: { ...loadedState, credentials: { fal: { configured: false, writable: true } } },
		1: [],
	});
	const text = textOf(render(react.createElement(components.ImagesPanel, {})));
	assert.match(text, /Ключ fal\.ai не задан/);
	assert.match(text, /Пока пусто/);
});

test('a card renders an image and a video, and keeps its controls separate', () => {
	const { components, render, textOf, findAll, react } = loadHarness();
	const dict = components.STRINGS.ru;
	const handlers = { onOpen: () => {}, onToggleFavorite: () => {}, onDelete: () => {}, onCopyPrompt: () => {} };

	const imageCard = render(react.createElement(components.GalleryCard, { item: imageItem, dict, ...handlers }));
	const images = findAll(imageCard, 'img');
	assert.equal(images.length, 1);
	assert.equal(images[0].props.src, imageItem.url);
	assert.equal(images[0].props.loading, 'lazy');
	assert.match(textOf(imageCard), /red chair/);

	const videoCard = render(react.createElement(components.GalleryCard, { item: videoItem, dict, ...handlers }));
	assert.equal(findAll(videoCard, 'video').length, 1);
	assert.equal(findAll(videoCard, 'video')[0].props.muted, true);
	assert.match(textOf(videoCard), /5s/);

	const actions = findAll(videoCard, 'div').find((node) => node.props.className === 'dsh-is-card-actions');
	assert.equal(typeof actions.props.onClick, 'function', 'card controls must not open the entry');
});

test('the lightbox renders a still with its Kling section and a way to download it', () => {
	const { components, render, textOf, findAll, react } = loadHarness();
	const tree = render(react.createElement(components.Lightbox, {
		item: imageItem,
		catalog,
		onClose: () => {},
		onGalleryChanged: () => {},
		onNotice: () => {},
		onError: () => {},
	}));
	const text = textOf(tree);

	assert.match(text, /red chair/);
	assert.match(text, /Оживить в Kling/);
	assert.match(text, /1024 × 1024/);
	assert.equal(findAll(tree, 'img').length, 1);

	const download = findAll(tree, 'a').find((node) => node.props.download === true);
	assert.equal(download.props.href, imageItem.url);

	// The dialog is dismissible from the keyboard and by its own control.
	const closeButton = findAll(tree, 'button').find((node) => node.props['aria-label'] === 'Закрыть');
	assert.equal(typeof closeButton.props.onClick, 'function');
});

test('the lightbox renders a video without offering to animate it again', () => {
	const { components, render, textOf, findAll, react } = loadHarness();
	const tree = render(react.createElement(components.Lightbox, {
		item: videoItem,
		catalog,
		onClose: () => {},
		onGalleryChanged: () => {},
		onNotice: () => {},
		onError: () => {},
	}));
	assert.equal(findAll(tree, 'video').length, 1);
	assert.equal(/Оживить в Kling/.test(textOf(tree)), false);
});

test('the settings card summarises itself and renders its fields', () => {
	const { components, render, textOf, findAll, seeds, react } = loadHarness();

	assert.equal(components.StudioSettings({ view: 'summary' }), 'Ключ fal.ai, модель и формат по умолчанию');

	seeds.set(components.StudioSettings, { 0: loadedState, 5: { defaultModel: 'openai/gpt-image-2', defaultAspect: '9:16', defaultCount: 2 } });
	const tree = render(react.createElement(components.StudioSettings, { view: 'page' }));
	const text = textOf(tree);

	assert.match(text, /Ключ сохранён/);
	assert.match(text, /\.dsh\/image-studio/, 'the card says where the files live');
	const keyField = findAll(tree, 'input').find((node) => node.props.type === 'password');
	assert.equal(keyField.props.value, '', 'the field starts empty and never carries a stored value');
	assert.match(keyField.props.placeholder, /key_id:key_secret/);
	assert.equal(findAll(tree, 'select').length, 3, 'model, aspect and variant defaults');
});

test('the montage tab starts empty, with its build action held back', () => {
	const { components, render, textOf, findAll, react } = loadHarness();
	const tree = render(react.createElement(components.MontageTab, {
		catalog,
		dict: components.STRINGS.ru,
		tools: { ffmpeg: { ok: true, version: 'ffmpeg version 8.1.1' } },
		onNotice: () => {},
		onError: () => {},
		onGalleryChanged: () => {},
		onOpen: () => {},
	}));
	const text = textOf(tree);

	assert.match(text, /Таймлайн · 0/);
	assert.match(text, /Таймлайн пуст/);
	assert.match(text, /Материалы/);

	const build = findAll(tree, 'button').find((node) => String(node.children.join('')).includes('Собрать ролик'));
	assert.equal(build.props.disabled, true, 'nothing to assemble yet');
	assert.equal(findAll(tree, 'select').length, 1, 'only the aspect picker before any still is added');
});

test('the montage tab says so when ffmpeg is missing instead of failing at build time', () => {
	const { components, render, textOf, findAll, react } = loadHarness();
	const tree = render(react.createElement(components.MontageTab, {
		catalog,
		dict: components.STRINGS.ru,
		tools: { ffmpeg: { ok: false, message: 'spawn ffmpeg ENOENT' } },
		onNotice: () => {},
		onError: () => {},
		onGalleryChanged: () => {},
		onOpen: () => {},
	}));
	assert.match(textOf(tree), /ffmpeg не найден/);
	assert.match(textOf(tree), /ENOENT/);
	assert.equal(findAll(tree, 'button').length, 0, 'no build action without ffmpeg');
});
