/**
 * The chat-facing half: `image_generate`.
 *
 * A person should be able to ask for a picture in the conversation and have it
 * land in the same media library the Images page reads. There is deliberately
 * no second generation path here: {@link generateImages} is the one route from
 * a validated prompt to stored gallery entries, the page's `/generate` route
 * runs through it, and the tool calls exactly the same function with the same
 * `lib/fal.js` calls, the same gallery records, and the same library root
 * (`resolveLibraryRoot(live)`, handed in as `resolveRoot`).
 *
 * `@deepseek-ai/dsh-tools` is a peer dependency, loaded lazily when the tool is
 * actually attached. A source checkout, and this repository's test suite, have
 * no installed harness packages; a static import would make the plugin — and
 * therefore the whole Images page — unimportable there. Loading it on demand
 * keeps the registry optional: a composition without `ctx.tools` simply offers
 * no chat tool, and the page keeps working.
 *
 * A failed generation throws. The registry turns a thrown error into a failed
 * tool call carrying its message, which is what makes the model read "no fal
 * key" or "fal rejected the parameters" as a failure instead of a result it
 * might take for success; the declared `output` shape is therefore only the
 * successful value. No message ever contains the fal key.
 */

import { buildImageInput, clampCount, extractImages, isKnownAspect, resolveModel } from './catalog.js';
import { FalError, falKeyProblem, falWait, fetchBytes } from './fal.js';
import { addEntries, entryPath, extensionForMime, newId, writeEntryFile } from './gallery.js';

/** The model-facing name of the tool. */
export const IMAGE_GENERATE_TOOL_NAME = 'image_generate';

/** The registry package every tool registration is built with. */
export const TOOLS_PACKAGE = '@deepseek-ai/dsh-tools';

/** Fallback image budget when the configuration carries no usable value. */
const DEFAULT_IMAGE_TIMEOUT_MS = 240000;

/** How much of a prompt may appear in a markdown alternative text. */
const MAX_ALT_TEXT = 120;

/**
 * Load `defineTool` from the harness tool registry.
 *
 * Read on demand rather than imported at module load, so a checkout without the
 * installed package can still load the plugin. The failure is silent here and
 * reported by {@link attachImageGenerateTool}, which has a context to log on.
 *
 * @param specifier - package name; the tests point it at a stand-in.
 * @returns the `defineTool` factory, or undefined when the package is absent.
 */
export async function loadDefineTool(specifier = TOOLS_PACKAGE) {
	try {
		const module = await import(specifier);
		return typeof module?.defineTool === 'function' ? module.defineTool : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Run one text-to-image generation: submit to fal's queue, wait, download what
 * it produced, and append the gallery records.
 *
 * This is the single path shared by the page and the tool. It takes the key
 * resolver and the root resolver rather than reading configuration itself, so
 * the caller decides which credential seam and which library are in play, and
 * every stage below is the same `lib/fal.js` / `lib/gallery.js` code the HTTP
 * surface already used.
 *
 * @param deps.live - the resolved configuration (timeouts, defaults).
 * @param deps.resolveFalKey - async () => `{ value, source }`; `value` is empty
 *   when nothing is configured.
 * @param deps.resolveRoot - () => the absolute library root to write into.
 * @param request - `{ prompt, model?, aspect?, count?, quality?, resolution?, seed? }`.
 * @param options.onStart - called once the request is validated and about to be
 *   submitted; the page uses it for its `queued` → `running` transition.
 * @param options.onProgress - observer called with `{ status, queuePosition, requestId }`.
 * @param options.signal - cooperative cancellation.
 * @returns `{ model, aspect, count, entries }`, entries newest-first as stored.
 * @throws {FalError} for a missing key, a fal failure, or an empty result;
 *   `Error` for a model that is not a fal slug at all.
 */
export async function generateImages(deps, request, options = {}) {
	const { live, resolveFalKey, resolveRoot } = deps;

	const key = await resolveFalKey();
	const problem = falKeyProblem(key.value);
	if (problem !== undefined) throw new FalError(problem, 'fal-key-missing');

	const wanted = request?.model ?? live.defaultModel;
	const model = resolveModel(wanted, 'image');
	if (model === undefined) {
		throw new Error(`"${String(wanted)}" is not a fal model. Use an endpoint slug like "fal-ai/flux-2/klein/9b".`);
	}
	const aspect = isKnownAspect(request?.aspect) ? request.aspect : live.defaultAspect;
	const count = clampCount(request?.count, model.defaultCount ?? live.defaultCount);
	const input = buildImageInput({
		model,
		prompt: request.prompt,
		aspect,
		count,
		quality: request?.quality,
		resolution: request?.resolution,
		seed: request?.seed,
	});

	options.onStart?.();
	const result = await falWait({
		slug: model.id,
		input,
		apiKey: key.value,
		timeoutMs: live.imageTimeoutMs,
		signal: options.signal,
		onProgress: options.onProgress,
	});

	const produced = extractImages(result);
	if (produced.length === 0) throw new FalError('fal finished without returning an image.', 'fal-empty-result');

	// Resolved once, after the provider answered: a failed generation must not
	// create a media folder, and one call must not write half its images into a
	// library the configuration moved mid-flight.
	const root = resolveRoot();
	const entries = [];
	for (const [index, item] of produced.entries()) {
		const fetched = await fetchBytes(item.url);
		entries.push(writeEntryFile(root, {
			id: newId(),
			bytes: fetched.bytes,
			ext: extensionForMime(item.contentType ?? fetched.contentType, 'png'),
			meta: {
				createdAt: Date.now(),
				index,
				kind: 'image',
				prompt: request.prompt,
				model: model.id,
				modelLabel: model.label,
				aspect,
				width: item.width,
				height: item.height,
				sourceUrl: item.url,
			},
		}));
	}
	addEntries(root, entries);
	return { model, aspect, count, root, entries };
}

/**
 * Build the `image_generate` definition.
 *
 * `parameters` is the author-facing spec `defineTool` compiles into JSON Schema
 * for the model; `output.schema` is the canonical shape of the value `execute`
 * returns, and `output.render` is what the model reads. Both are declared here
 * rather than inferred, because the registry validates the returned value
 * against the schema and throws `INVALID_TOOL_OUTPUT` on a drift.
 *
 * The declared output shape is the *successful* result only: a generation that
 * fails throws, so the registry marks the call as failed and the model reads
 * the reason as an error rather than as a value it might mistake for success.
 *
 * @param defineTool - the factory from `@deepseek-ai/dsh-tools`.
 * @param deps - see {@link attachImageGenerateTool}; `defineTool` is separate.
 * @returns the registry-ready definition.
 */
export function createImageGenerateTool(defineTool, deps) {
	const { live, resolveFalKey, resolveRoot } = deps;

	return defineTool({
		name: IMAGE_GENERATE_TOOL_NAME,
		description: 'Generate an image from a text prompt through fal.ai and save it to the current project\'s media library, where the Images page shows it. Give a complete visual prompt: subject, composition, style, lighting, and any text that must appear. Use this when the person asks for a picture; do not call other tools to look for or verify the result. A generation that fails returns an error explaining why.',
		parameters: {
			prompt: {
				type: 'string',
				required: true,
				description: 'What to draw: subject, composition, style, lighting, and any exact text to render.',
			},
			aspect: {
				type: 'string',
				enum: ['1:1', '4:3', '3:4', '16:9', '9:16'],
				description: 'Frame to ask for. Defaults to the Images page setting.',
			},
			count: {
				type: 'integer',
				description: 'How many variations to request, 1 to 8. Defaults to the model\'s or the page\'s own count.',
			},
			model: {
				type: 'string',
				description: 'fal endpoint slug, e.g. "fal-ai/flux-2/klein/9b" or "openai/gpt-image-2". Defaults to the Images page setting; any fal text-to-image slug is accepted.',
			},
		},
		output: {
			// The successful result. A failure throws instead of returning a value,
			// so there is no ok/error pair here to be mistaken for one.
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					summary: { type: 'string', required: true, description: 'One-line result for the person, with the markdown links.' },
					prompt: { type: 'string', required: true, description: 'The prompt that produced the images.' },
					model: { type: 'string', required: true, description: 'The fal endpoint that ran.' },
					modelLabel: { type: 'string', required: true, description: 'The endpoint\'s display name.' },
					aspect: { type: 'string', required: true, description: 'The frame that was requested.' },
					count: { type: 'integer', required: true, description: 'How many images were stored.' },
					root: { type: 'string', required: true, description: 'The media library directory the images were written to.' },
					markdown: { type: 'string', required: true, description: 'Markdown image references, one per stored image.' },
					images: {
						type: 'array',
						required: true,
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								id: { type: 'string', required: true, description: 'Gallery entry id.' },
								file: { type: 'string', required: true, description: 'Absolute path of the stored image.' },
								markdown: { type: 'string', required: true, description: 'Markdown image reference to that file.' },
								mime: { type: 'string', required: true, description: 'Media type as stored.' },
								bytes: { type: 'integer', required: true, description: 'Stored file size.' },
								url: { type: 'string', required: true, description: 'The Images page URL for this entry.' },
								width: { type: 'integer' },
								height: { type: 'integer' },
							},
						},
					},
				},
			},
			render: (_args, value) => [{ type: 'text', text: value.summary }],
		},
		// A generation spends credits and appends to one index file, so two
		// overlapping calls must not run concurrently.
		isConcurrencySafe: () => false,
		timeoutMs: (Number.isFinite(live.imageTimeoutMs) ? live.imageTimeoutMs : DEFAULT_IMAGE_TIMEOUT_MS) + 30000,
		async execute(args, exec) {
			const prompt = String(args?.prompt ?? '').trim();
			const wanted = typeof args?.model === 'string' && args.model.trim() !== '' ? args.model.trim() : live.defaultModel;
			const model = resolveModel(wanted, 'image');

			if (prompt === '') throw new Error('Write a prompt describing the image first.');
			if (model === undefined) {
				throw new Error(`"${wanted}" is not a fal endpoint. Pass a slug such as "fal-ai/flux-2/klein/9b".`);
			}

			let result;
			try {
				result = await generateImages({ live, resolveFalKey, resolveRoot }, {
					prompt,
					model: wanted,
					aspect: args?.aspect,
					count: args?.count,
				}, { signal: exec?.signal });
			} catch (error) {
				throw readableFailure(error);
			}

			const root = result.root;
			const images = result.entries.map((entry) => {
				const file = entryPath(root, entry);
				const markdown = markdownFor(prompt, file);
				return {
					id: entry.id,
					file,
					markdown,
					mime: entry.mime,
					bytes: entry.bytes,
					url: `/api/image-studio/file?id=${entry.id}`,
					...(Number.isFinite(entry.width) ? { width: entry.width } : {}),
					...(Number.isFinite(entry.height) ? { height: entry.height } : {}),
				};
			});
			const headline = `Generated ${images.length} image${images.length === 1 ? '' : 's'} (${result.aspect}) with ${result.model.label} into ${root}:`;
			const markdown = images.map((image) => image.markdown).join('\n');
			return {
				summary: `${headline}\n${markdown}`,
				prompt,
				model: result.model.id,
				modelLabel: result.model.label,
				aspect: result.aspect,
				count: images.length,
				root,
				markdown,
				images,
			};
		},
	});
}

/**
 * Register the tool on a context that already carries `tools`.
 *
 * @param ctx - a context (or injected scope) exposing `tools` and `effect`.
 * @param deps.defineTool - the factory from `@deepseek-ai/dsh-tools`.
 * @param deps.live - the resolved configuration.
 * @param deps.resolveFalKey - async () => `{ value, source }`.
 * @param deps.resolveRoot - () => the absolute library root.
 * @returns the disposer that unregisters the tool.
 */
export function registerImageGenerateTool(ctx, deps) {
	return ctx.effect(
		() => ctx.tools.register(createImageGenerateTool(deps.defineTool, deps)),
		'image-studio: tool image_generate',
	);
}

/**
 * Attach `image_generate` to a plugin context, if this composition has a tool
 * registry and the registry package can be loaded.
 *
 * Registration is deliberately one `ctx.inject(['tools'], …)` call, so it
 * happens exactly once per mount and never runs in a composition without the
 * registry. The registry package is loaded lazily (see the module docstring);
 * when it is missing the tool is simply not offered, and the reason is logged
 * instead of failing the mount.
 *
 * @param ctx - the plugin context.
 * @param deps.live - the resolved configuration.
 * @param deps.resolveFalKey - async () => `{ value, source }`.
 * @param deps.resolveRoot - () => the absolute library root.
 * @returns a disposer that cancels a not-yet-finished attachment.
 */
export function attachImageGenerateTool(ctx, deps) {
	let dispose;
	let closed = false;
	ctx.inject(['tools'], (scope) => {
		void loadDefineTool()
			.then((defineTool) => {
				if (closed) return;
				if (defineTool === undefined) {
					warn(ctx, `the ${TOOLS_PACKAGE} package is not installed, so the ${IMAGE_GENERATE_TOOL_NAME} tool is not offered`);
					return;
				}
				dispose = registerImageGenerateTool(scope, { ...deps, defineTool });
			})
			.catch((error) => warn(ctx, `${IMAGE_GENERATE_TOOL_NAME} could not be registered: ${message(error)}`));
		return () => {
			closed = true;
			if (typeof dispose === 'function') dispose();
		};
	});
}

/**
 * Turn a generation failure into the short, human error the model reads.
 *
 * `lib/fal.js` already writes messages that carry no credential and no local
 * path, so those travel unchanged and the model can act on them (a bad key, an
 * unknown endpoint, a parameter fal rejected). Anything else is a storage-side
 * failure whose own message contains this machine's filesystem layout, so the
 * model gets the reason and the errno code instead of the path.
 *
 * @param error - whatever `generateImages` threw.
 * @returns the error to throw out of `execute`.
 */
function readableFailure(error) {
	if (error instanceof FalError) return error;
	const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code) ? ` (${error.code})` : '';
	return new Error(`The images could not be saved to the media library${code}.`);
}

/**
 * A markdown image reference to the stored file.
 *
 * The destination sits in angle brackets so a Windows path with spaces survives
 * as one link, and backslashes become forward slashes because markdown treats a
 * backslash as an escape.
 *
 * @param prompt - the prompt, used as the alternative text.
 * @param file - absolute path of the stored media.
 * @returns a markdown image reference.
 */
function markdownFor(prompt, file) {
	const alt = String(prompt).replace(/\s+/g, ' ').replace(/[[\]()<>]/g, ' ').trim().slice(0, MAX_ALT_TEXT);
	return `![${alt}](<${String(file).replace(/\\/g, '/')}>)`;
}

/** Human-readable text of a thrown value, for a model-facing message. */
function message(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Report a degraded capability without letting a missing logger break the mount. */
function warn(ctx, text) {
	try {
		ctx?.logger?.warn?.(`image-studio: ${text}`);
	} catch {
		// A logger is a convenience; the tool being absent is the real state.
	}
}
