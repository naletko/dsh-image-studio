/**
 * The browser half must declare itself exactly the way the harness client
 * module loader expects: an id, a factory, and a module that injects the slot
 * service and registers the same four slots other plugins register. The test
 * loads the real file in a sandbox with a stubbed loader and React, because a
 * mistake here is a page that never appears.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

/** React is only destructured by the factory, so a shape-stable stub is enough. */
const reactStub = {
	createElement: () => null,
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useEffect: () => {},
	useRef: () => ({ current: null }),
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
};

/** Load client.js the way the harness does and return what it declared. */
function loadClient() {
	let declaration;
	const sandbox = {
		console,
		setTimeout,
		clearTimeout,
		setInterval,
		clearInterval,
		fetch: async () => {
			throw new Error('the client half must not call fetch while loading');
		},
		navigator: { clipboard: { writeText: async () => {} } },
		document: { documentElement: { lang: 'ru' }, getElementById: () => null, head: { appendChild: () => {} } },
	};
	sandbox.window = { __ModuleLoader__: { load: (value) => { declaration = value; } } };
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox);
	return declaration;
}

test('client half declares itself to the module loader', () => {
	const declaration = loadClient();
	assert.equal(declaration.id, 'dsh-image-studio');
	assert.equal(typeof declaration.factory, 'function');
});

test('the module injects slots and registers the page, the sidebar entry and both settings cards', () => {
	const declaration = loadClient();
	const module = declaration.factory((name) => {
		if (name === 'react') return reactStub;
		throw new Error(`unexpected require("${name}")`);
	});

	// The module is created inside another realm, so its arrays are copied into
	// this one before comparing.
	assert.deepEqual([...module.inject], ['slots']);
	assert.equal(typeof module.apply, 'function');

	const recorded = [];
	const ctx = {
		slots: {
			register: (options, component) => {
				recorded.push({ options, component });
				return { dispose() {} };
			},
			inject: (name, callback) => {
				const value = callback(name);
				// Registration callbacks may be generators; the harness iterates them
				// so a yielded handle stays owned by the injecting fiber.
				if (value && typeof value.next === 'function') {
					let step = value.next();
					while (step.done !== true) step = value.next();
				}
			},
		},
	};

	module.apply(ctx);

	const byName = (name) => recorded.filter((entry) => entry.options.name === name);
	assert.equal(byName('main').length, 1);
	assert.equal(byName('main')[0].options.key, 'images');
	assert.equal(typeof byName('main')[0].component, 'function');

	assert.equal(byName('sidebar.panellist').length, 1);
	assert.equal(byName('sidebar.panellist')[0].options.id, 'images');
	assert.equal(typeof byName('sidebar.panellist')[0].options.label, 'function');
	assert.equal(byName('sidebar.panellist')[0].options.label(), 'Изображения');

	assert.equal(byName('plugins.bundle.config').length, 1);
	assert.equal(byName('plugins.bundle.config')[0].options.key, 'dsh-image-studio');

	assert.equal(byName('plugins.row.config').length, 1);
	assert.equal(byName('plugins.row.config')[0].options.key, 'dsh-image-studio#image-studio');
});

test('the page component tolerates being rendered without a host', () => {
	const declaration = loadClient();
	const module = declaration.factory(() => reactStub);
	// A render with no state yet must not throw: the host might be restarting.
	const element = reactStub.createElement(module.inject, {});
	assert.equal(element, null);
});
