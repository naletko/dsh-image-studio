/**
 * The studio catalogue: the fal endpoints this plugin knows how to drive, the
 * aspect presets they accept, the request body each family needs, and the
 * starter prompt templates the page offers.
 *
 * Everything here is pure data plus pure functions so the host can validate a
 * request and the tests can exercise request shaping without a network or a
 * harness. The request field names below were read from fal's own OpenAPI
 * documents (`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<id>`),
 * not guessed:
 *
 *   fal-ai/flux-2/klein/9b                  prompt, image_size, output_format, num_images, seed
 *   openai/gpt-image-2                      prompt, image_size, quality, output_format, num_images
 *   fal-ai/nano-banana-2                    prompt, aspect_ratio, resolution, num_images, output_format
 *   fal-ai/kling-video/v3/pro/image-to-video      start_image_url, prompt, duration, cfg_scale, generate_audio
 *   fal-ai/kling-video/v3/standard/text-to-video  prompt, aspect_ratio, duration, negative_prompt
 */

/** Aspect choices offered by the page, in the order it lists them. */
export const ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16'];

/** fal's `image_size` presets for the square-ish families. */
const IMAGE_SIZE_PRESETS = {
	'1:1': 'square_hd',
	'4:3': 'landscape_4_3',
	'3:4': 'portrait_4_3',
	'16:9': 'landscape_16_9',
	'9:16': 'portrait_16_9',
};

/** Kling's text-to-video only accepts these three. */
const KLING_ASPECTS = { '1:1': '1:1', '16:9': '16:9', '9:16': '9:16' };

/**
 * Text-to-image endpoints.
 *
 * `sizing` names the field the family uses for the frame; `qualities` lists the
 * tiers the endpoint documents, and an empty list omits the field entirely.
 * `resolution` marks the one family that takes a pixel budget instead of a size.
 */
export const IMAGE_MODELS = [
	{
		id: 'fal-ai/flux-2/klein/9b',
		label: 'FLUX.2 Klein 9B',
		note: 'Fast and inexpensive. Good for exploring many takes of one scene.',
		sizing: 'image_size',
		qualities: [],
		resolutions: [],
		defaultCount: 4,
	},
	{
		id: 'openai/gpt-image-2',
		label: 'GPT Image 2',
		note: 'OpenAI quality tier. Best text rendering and prompt adherence.',
		sizing: 'image_size',
		qualities: ['auto', 'low', 'medium', 'high'],
		resolutions: [],
		defaultCount: 2,
	},
	{
		id: 'fal-ai/nano-banana-2',
		label: 'Nano Banana 2',
		note: 'Gemini image model with reference editing and 4K output.',
		sizing: 'aspect_ratio',
		qualities: [],
		resolutions: ['0.5K', '1K', '2K', '4K'],
		defaultCount: 2,
	},
];

/** Image-to-video and text-to-video endpoints. */
export const VIDEO_MODELS = [
	{
		id: 'fal-ai/kling-video/v3/pro/image-to-video',
		label: 'Kling v3 Pro (image to video)',
		note: 'Animates a still you picked in the gallery.',
		needsImage: true,
	},
	{
		id: 'fal-ai/kling-video/v3/standard/text-to-video',
		label: 'Kling v3 Standard (text to video)',
		note: 'Builds a shot from a prompt when there is no still to animate.',
		needsImage: false,
	},
];

/** Video lengths Kling documents, as strings. */
export const VIDEO_DURATIONS = ['3', '5', '8', '10', '12'];

/** The text-to-image model used when the caller names nothing. */
export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0].id;

/** The image-to-video model used when the caller names nothing. */
export const DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0].id;

/**
 * Starter prompts. A template fills the prompt box; it never spends credits by
 * itself, so a person can edit it before pressing Generate.
 */
export const TEMPLATES = [
	{
		id: 'product-hero',
		label: { en: 'Product hero', ru: 'Продукт на подиуме' },
		prompt: {
			en: 'Studio product photograph of {{subject}} on a seamless matte backdrop, soft key light from the left, gentle rim light, subtle contact shadow, 85mm lens look, ultra sharp, commercial advertising quality, no text',
			ru: 'Студийная предметная съёмка: {{subject}} на бесшовном матовом фоне, мягкий рисующий свет слева, аккуратный контровой, лёгкая контактная тень, оптика 85 мм, максимальная резкость, качество рекламного кадра, без текста',
		},
		aspect: '1:1',
	},
	{
		id: 'lifestyle-scene',
		label: { en: 'Lifestyle scene', ru: 'Лайфстайл-сцена' },
		prompt: {
			en: 'Candid lifestyle photograph of {{subject}} in a sunlit modern interior, natural window light, shallow depth of field, warm colour grade, shot on 35mm film, realistic skin texture, no text',
			ru: 'Живая лайфстайл-фотография: {{subject}} в светлом современном интерьере, естественный свет из окна, малая глубина резкости, тёплая цветокоррекция, плёночная 35 мм фактура, реалистичная кожа, без текста',
		},
		aspect: '9:16',
	},
	{
		id: 'ugc-selfie',
		label: { en: 'UGC selfie', ru: 'UGC-селфи' },
		prompt: {
			en: 'Vertical user-generated selfie video frame: a friendly person holding {{subject}}, phone camera look, slight wide-angle distortion, indoor daylight, authentic unpolished feel, no text',
			ru: 'Вертикальный кадр в стиле UGC-селфи: приветливый человек держит {{subject}}, вид с фронтальной камеры телефона, лёгкая широкоугольная дисторсия, дневной свет в помещении, без глянца, без текста',
		},
		aspect: '9:16',
	},
	{
		id: 'flat-lay',
		label: { en: 'Flat lay', ru: 'Флэтлей' },
		prompt: {
			en: 'Top-down flat lay of {{subject}} arranged with complementary props on a textured surface, soft even light, muted colour palette, generous negative space for a headline, no text',
			ru: 'Флэтлей сверху: {{subject}} с поддерживающими предметами на фактурной поверхности, мягкий ровный свет, приглушённая палитра, много свободного места под заголовок, без текста',
		},
		aspect: '4:3',
	},
	{
		id: 'before-after',
		label: { en: 'Before / after', ru: 'До / после' },
		prompt: {
			en: 'Split composition comparing {{subject}} before and after, identical camera angle and lighting in both halves, clean divider, neutral background, documentary honesty, no text',
			ru: 'Композиция из двух половин: {{subject}} до и после, одинаковый ракурс и свет в обеих половинах, аккуратный разделитель, нейтральный фон, документальная честность, без текста',
		},
		aspect: '1:1',
	},
	{
		id: 'seasonal',
		label: { en: 'Seasonal mood', ru: 'Сезонное настроение' },
		prompt: {
			en: 'Cinematic seasonal advertising still of {{subject}}, warm practical lights, softly falling particles in the air, rich shadows, anamorphic bokeh, film grain, no text',
			ru: 'Кинематографичный сезонный рекламный кадр: {{subject}}, тёплые практические источники света, мягко падающие частицы в воздухе, глубокие тени, анаморфный боке, зерно плёнки, без текста',
		},
		aspect: '16:9',
	},
	{
		id: 'character-sheet',
		label: { en: 'Character sheet', ru: 'Лист персонажа' },
		prompt: {
			en: 'Character reference sheet of {{subject}}: one bust and one full-body view on a plain light background, consistent face and wardrobe, even studio light, painted concept-art finish, no text',
			ru: 'Референсный лист персонажа: {{subject}}, погрудный и в полный рост на светлом однотонном фоне, консистентное лицо и одежда, ровный студийный свет, концепт-арт, без текста',
		},
		aspect: '3:4',
	},
	{
		id: 'food-closeup',
		label: { en: 'Food close-up', ru: 'Фуд-клоуз' },
		prompt: {
			en: 'Appetising close-up of {{subject}}, steam rising, glistening texture, dark rustic table, directional side light, macro detail, shallow depth of field, no text',
			ru: 'Аппетитный крупный план: {{subject}}, поднимающийся пар, блестящая фактура, тёмный деревенский стол, боковой направленный свет, макродетали, малая глубина резкости, без текста',
		},
		aspect: '4:3',
	},
];

/**
 * Resolve a model id to its description, falling back to a permissive custom
 * entry so an id typed by hand still runs.
 *
 * @param id - catalogue id or a raw fal slug.
 * @param kind - 'image' or 'video'.
 * @returns the catalogue entry, or a synthetic entry for an unknown slug.
 */
export function resolveModel(id, kind) {
	const table = kind === 'video' ? VIDEO_MODELS : IMAGE_MODELS;
	const wanted = typeof id === 'string' ? id.trim() : '';
	const found = table.find((entry) => entry.id === wanted);
	if (found) return found;
	if (wanted.includes('/')) {
		return kind === 'video'
			? { id: wanted, label: wanted, note: 'Custom endpoint', needsImage: true, custom: true }
			: { id: wanted, label: wanted, note: 'Custom endpoint', sizing: 'image_size', qualities: [], resolutions: [], custom: true };
	}
	return undefined;
}

/**
 * Whether a claimed aspect is one the page offers.
 *
 * @param aspect - candidate label, e.g. `9:16`.
 * @returns true when the catalogue knows the label.
 */
export function isKnownAspect(aspect) {
	return ASPECTS.includes(aspect);
}

/**
 * Build the request body for one text-to-image call.
 *
 * @param options.model - catalogue entry (see {@link resolveModel}).
 * @param options.prompt - the user's prompt; required and trimmed by the caller.
 * @param options.aspect - one of {@link ASPECTS}.
 * @param options.count - images to request, clamped to 1..8.
 * @param options.quality - optional tier, only sent when the model documents one.
 * @param options.resolution - optional pixel budget for the families that take it.
 * @param options.seed - optional deterministic seed. Omitted unless set, because a
 *   random seed is what fal produces when the field is absent.
 * @returns the endpoint input payload.
 */
export function buildImageInput({ model, prompt, aspect, count, quality, resolution, seed }) {
	const body = { prompt: String(prompt) };
	const images = clampCount(count, model?.defaultCount ?? 1);
	if (images > 1) body.num_images = images;

	if (model?.sizing === 'aspect_ratio') {
		if (typeof aspect === 'string' && aspect !== '') body.aspect_ratio = aspect;
	} else if (typeof aspect === 'string' && IMAGE_SIZE_PRESETS[aspect] !== undefined) {
		body.image_size = IMAGE_SIZE_PRESETS[aspect];
	}

	if (Array.isArray(model?.qualities) && model.qualities.includes(quality)) {
		body.quality = quality;
	}
	if (Array.isArray(model?.resolutions) && model.resolutions.includes(resolution)) {
		body.resolution = resolution;
	}
	if (Number.isInteger(seed)) body.seed = seed;
	return body;
}

/**
 * Build the request body for one video call.
 *
 * @param options.model - catalogue entry (see {@link resolveModel}).
 * @param options.prompt - motion description, or the whole shot for text-to-video.
 * @param options.aspect - one of {@link ASPECTS}; Kling keeps only 1:1, 16:9, 9:16.
 * @param options.duration - seconds as a string, one of {@link VIDEO_DURATIONS}.
 * @param options.imageDataUri - the still to animate, as a `data:` URI. Required by
 *   an image-to-video endpoint, ignored by a text-to-video one.
 * @returns the endpoint input payload.
 */
export function buildVideoInput({ model, prompt, aspect, duration, imageDataUri }) {
	const body = {};
	if (model?.needsImage) {
		body.start_image_url = String(imageDataUri ?? '');
		if (body.start_image_url === '') throw new Error('This model needs a still image to animate');
	} else if (typeof aspect === 'string' && KLING_ASPECTS[aspect] !== undefined) {
		body.aspect_ratio = KLING_ASPECTS[aspect];
	}
	if (typeof prompt === 'string' && prompt.trim() !== '') body.prompt = prompt.trim();
	if (VIDEO_DURATIONS.includes(String(duration))) body.duration = String(duration);
	return body;
}

/**
 * Normalise whatever an image endpoint returned into one list of remote images.
 *
 * fal answers with `{ images: [...] }` for the families here, but a custom
 * endpoint may answer with `{ image: {...} }` or a bare URL, so every shape is
 * accepted rather than failing the whole call on presentation.
 *
 * @param result - the parsed result body.
 * @returns image descriptors: `{ url, width, height, contentType }`.
 */
export function extractImages(result) {
	const out = [];
	const push = (candidate) => {
		if (candidate === null || candidate === undefined) return;
		if (typeof candidate === 'string') {
			out.push({ url: candidate });
			return;
		}
		if (typeof candidate !== 'object') return;
		const url = candidate.url ?? candidate.image_url ?? candidate.imageUrl;
		if (typeof url !== 'string' || url === '') return;
		out.push({
			url,
			width: numberOrUndefined(candidate.width),
			height: numberOrUndefined(candidate.height),
			contentType: typeof candidate.content_type === 'string' ? candidate.content_type : undefined,
		});
	};
	if (Array.isArray(result?.images)) for (const item of result.images) push(item);
	push(result?.image);
	if (out.length === 0 && Array.isArray(result?.data)) for (const item of result.data) push(item);
	return out;
}

/**
 * Normalise a video result.
 *
 * @param result - the parsed result body.
 * @returns `{ url, contentType, fileName, fileSize }`, or undefined when absent.
 */
export function extractVideo(result) {
	const candidate = result?.video ?? (Array.isArray(result?.videos) ? result.videos[0] : undefined);
	if (candidate === null || candidate === undefined) return undefined;
	if (typeof candidate === 'string') return { url: candidate };
	const url = candidate.url ?? candidate.video_url;
	if (typeof url !== 'string' || url === '') return undefined;
	return {
		url,
		contentType: typeof candidate.content_type === 'string' ? candidate.content_type : undefined,
		fileName: typeof candidate.file_name === 'string' ? candidate.file_name : undefined,
		fileSize: numberOrUndefined(candidate.file_size),
	};
}

/**
 * Clamp a requested image count into the range a single call tolerates.
 *
 * @param value - caller-supplied count.
 * @param fallback - value used when the caller sent nothing usable.
 * @returns an integer between 1 and 8.
 */
export function clampCount(value, fallback = 1) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return Math.min(8, Math.max(1, Number(fallback) || 1));
	return Math.min(8, Math.max(1, Math.trunc(parsed)));
}

function numberOrUndefined(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
