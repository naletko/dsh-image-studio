/**
 * dsh-image-studio — browser half.
 *
 * Registers an Images entry in the sidebar and the full page it opens: a prompt
 * bar that spends fal credits on demand, tabs for starter templates, a grid of
 * everything the studio has ever produced, a lightbox for judging and reusing a
 * candidate, and a Kling image-to-video action that turns the winner into a shot.
 * The same page also stands as a card in the right sidebar, next to Files,
 * Terminal and Browser, and its header switches the library between the shared
 * studio and a folder inside one of the host's projects.
 *
 * The module is loaded as a plain script by the harness client module loader
 * (no bundler), so it declares itself through `window.__ModuleLoader__.load`.
 * Everything the host owns — fal, the key, the files — is reached over the
 * plugin's own loopback HTTP surface; this half never talks to a provider and
 * never sees a key.
 */
window.__ModuleLoader__.load({
	id: 'dsh-image-studio',
	factory(require) {
		const React = require('react');
		const { createElement: h, useState, useEffect, useRef, useCallback } = React;

		/** The sidebar entry id and the `main` slot key it selects. */
		const PANEL_ID = 'images';
		/**
		 * The right sidebar's tab type: its registry id (also the key its body
		 * and title register under, as the sidebar package requires them to
		 * match) and the kind the guide card opens.
		 */
		const MEDIA_TAB_ID = 'dsh-image-studio';
		const MEDIA_KIND = 'image-studio-media';
		/** The plugin's HTTP surface. */
		const API = '/api/image-studio';
		/** How often a queued job is asked for progress. */
		const JOB_POLL_MS = 1500;

		//#region i18n

		const STRINGS = {
			ru: {
				panel: 'Изображения',
				title: 'Изображения',
				subtitle: 'Генерация через fal.ai, галерея всех работ и оживление кадра в Kling',
				promptPlaceholder: 'Опишите изображение…',
				generate: 'Сгенерировать',
				generateMore: 'Ещё раз',
				stop: 'Скрыть прогресс',
				model: 'Модель',
				aspect: 'Формат',
				count: 'Вариантов',
				quality: 'Качество',
				resolution: 'Разрешение',
				tabGallery: 'Галерея',
				tabTemplates: 'Шаблоны',
				tabMontage: 'Монтаж',
				montageHint: 'Соберите ролик: добавьте клипы и кадры по порядку — они станут одним вертикальным видео.',
				montageTimeline: 'Таймлайн',
				montageSources: 'Материалы',
				montageEmpty: 'Таймлайн пуст — добавьте кадр или клип из материалов ниже.',
				montageUp: 'Выше',
				montageDown: 'Ниже',
				montageRemove: 'Убрать',
				montageStill: 'сек на кадр',
				montageBuild: 'Собрать ролик',
				montageWorking: 'Собираю ролик',
				montageDone: 'Ролик собран',
				montageNoFfmpeg: 'ffmpeg не найден, поэтому монтаж недоступен',
				montageNoSources: 'Пока нечего собирать — сначала сгенерируйте кадры или клипы.',
				montageStep: 'шаг',
				filterAll: 'Все',
				filterImages: 'Картинки',
				filterVideos: 'Видео',
				filterFavorites: 'Избранное',
				searchPlaceholder: 'Поиск по промпту',
				emptyTitle: 'Пока пусто',
				emptyHint: 'Опишите первое изображение выше или начните с шаблона.',
				emptyFiltered: 'Ничего не найдено',
				queued: 'В очереди',
				running: 'Рендерится',
				done: 'Готово',
				failed: 'Ошибка',
				position: 'позиция',
				open: 'Открыть',
				favorite: 'В избранное',
				unfavorite: 'Убрать из избранного',
				copyPrompt: 'Копировать промпт',
				copied: 'Промпт скопирован',
				remove: 'Удалить',
				removeConfirm: 'Удалить? Ещё раз — подтвердить',
				download: 'Скачать',
				close: 'Закрыть',
				toVideo: 'Оживить в Kling',
				videoPrompt: 'Что должно происходить в кадре',
				videoDuration: 'Длительность, с',
				videoModel: 'Модель видео',
				videoGenerate: 'Сделать видео',
				videoQueued: 'Видео в очереди',
				videoRunning: 'Kling рендерит видео',
				noKey: 'Ключ fal.ai не задан',
				noKeyHint: 'Откройте настройки плагина и вставьте ключ key_id:key_secret — он ляжет в хранилище ключей DSH.',
				openSettings: 'Настройки',
				templatesHint: 'Шаблон подставит промпт в поле — правьте под себя, {{subject}} это ваш объект.',
				useTemplate: 'Взять шаблон',
				generatedAt: 'Создано',
				itemsCount: 'работ',
				useAsIs: 'Сгенерировать по этому промпту',
				errorGeneric: 'Что-то пошло не так',
				settingsTitle: 'Изображения (fal.ai)',
				settingsSummary: 'Ключ fal.ai, модель и формат по умолчанию',
				keyLabel: 'Ключ fal.ai',
				keyHint: 'Полная строка key_id:key_secret из fal.ai → Keys. Хранится в хранилище ключей DSH и никогда не попадает в файлы настроек.',
				keyConfigured: 'Ключ сохранён',
				keyMissing: 'Ключ не задан',
				keyFromEnv: 'Ключ берётся из переменной окружения',
				keyReadOnly: 'Ключ задан извне — сохранение отсюда недоступно',
				save: 'Сохранить',
				saved: 'Сохранено',
				clear: 'Удалить ключ',
				defaultsTitle: 'По умолчанию',
				outputDir: 'Файлы студии',
				versionTitle: 'Версия плагина',
				updatesTitle: 'Обновления',
				updatesCurrent: 'Установлено',
				updatesLatest: 'На GitHub',
				updatesCheck: 'Проверить',
				updatesApply: 'Обновить',
				updatesAvailable: 'Доступно обновление',
				updatesRunning: 'Устанавливаю…',
				updatesDone: 'Обновление скачано',
				updatesDoneHint: 'Обновите страницу; если версия вверху не изменилась — перезапустите приложение.',
				updatesFailed: 'Не удалось обновить',
				updatesUpToDate: 'Установлена последняя версия',
				updatesManual: 'В этой сборке нет менеджера плагинов — обновите через «Плагины → Добавить плагин»:',
				updatesDisabled: 'Проверка обновлений выключена в настройках строки',
				updatesNotes: 'Что нового',
				updatesReload: 'Обновить страницу',
				importLink: 'Импорт по ссылке',
				importHint: 'Скачать картинку или видео по прямой ссылке в эту же галерею',
				importPlaceholder: 'https://… прямая ссылка на файл',
				importButton: 'Скачать',
				importing: 'Скачиваю…',
				importDone: 'Файл добавлен в галерею',
				cancel: 'Отмена',
				saving: 'Сохраняю…',
				modelCustom: '· своя',
				modelAdd: '＋ Своя модель',
				modelAddHint: 'Любой endpoint с fal.ai по слагу — например fal-ai/qwen-image',
				modelAddPlaceholder: 'fal-ai/qwen-image',
				modelAddButton: 'Добавить',
				modelRemove: 'Убрать из списка',
				// The local provider: a ComfyUI the person runs themselves. The plugin
				// only connects to it — nothing is downloaded, and no key is involved.
				provider: 'Провайдер',
				providerFal: 'fal.ai',
				providerLocal: 'Локальный ComfyUI',
				localUrl: 'Адрес ComfyUI',
				localUrlHint: 'Только локальный адрес: 127.0.0.1, localhost или ::1',
				localCheck: 'Проверить связь',
				localChecking: 'Проверяю…',
				localReachable: 'ComfyUI отвечает',
				localUnreachable: 'ComfyUI не отвечает на {url}',
				localUrlInvalid: 'Принят только локальный адрес: 127.0.0.1, localhost или ::1',
				// The right sidebar card and the media-source switcher.
				mediaPanel: 'Медиа проекта',
				mediaPanelHint: 'Галерея, генерация и монтаж проекта в панели справа',
				libraryTitle: 'Источник медиа',
				librarySource: 'Источник',
				libraryStudio: 'Общая студия',
				librarySubdir: 'Подпапка',
				librarySubdirHint: 'Папка внутри dsh-media, например shots/2026',
				libraryApply: 'Применить',
				librarySaved: 'Источник медиа переключён',
				librarySubdirKept: 'Подпапка не принята — хост оставил прежнюю',
				libraryUnsupported: 'Хост не видит реестр воркспейсов — доступна только общая студия',
				libraryNoProjects: 'Проектов пока нет — доступна только общая студия',
				libraryCurrent: 'Библиотека',
				gitignoreAdd: 'Добавить dsh-media в .gitignore',
				gitignoreBusy: 'Добавляю…',
				gitignoreAdded: 'dsh-media добавлена в .gitignore',
				gitignorePresent: 'dsh-media уже в .gitignore',
			},
			en: {
				panel: 'Images',
				title: 'Images',
				subtitle: 'Generate with fal.ai, browse every result, and animate the winner with Kling',
				promptPlaceholder: 'Describe an image…',
				generate: 'Generate',
				generateMore: 'Generate again',
				stop: 'Hide progress',
				model: 'Model',
				aspect: 'Aspect',
				count: 'Variants',
				quality: 'Quality',
				resolution: 'Resolution',
				tabGallery: 'Gallery',
				tabTemplates: 'Templates',
				tabMontage: 'Montage',
				montageHint: 'Assemble a cut: add clips and stills in order and they become one vertical video.',
				montageTimeline: 'Timeline',
				montageSources: 'Sources',
				montageEmpty: 'The timeline is empty — add a still or a clip from the sources below.',
				montageUp: 'Up',
				montageDown: 'Down',
				montageRemove: 'Remove',
				montageStill: 'seconds per still',
				montageBuild: 'Assemble the cut',
				montageWorking: 'Assembling',
				montageDone: 'The cut is ready',
				montageNoFfmpeg: 'ffmpeg was not found, so the montage is unavailable',
				montageNoSources: 'Nothing to assemble yet — generate some stills or clips first.',
				montageStep: 'step',
				filterAll: 'All',
				filterImages: 'Images',
				filterVideos: 'Videos',
				filterFavorites: 'Favourites',
				searchPlaceholder: 'Search prompts',
				emptyTitle: 'Nothing here yet',
				emptyHint: 'Describe your first image above, or start from a template.',
				emptyFiltered: 'No matches',
				queued: 'Queued',
				running: 'Rendering',
				done: 'Done',
				failed: 'Failed',
				position: 'position',
				open: 'Open',
				favorite: 'Add to favourites',
				unfavorite: 'Remove from favourites',
				copyPrompt: 'Copy prompt',
				copied: 'Prompt copied',
				remove: 'Delete',
				removeConfirm: 'Delete? Click again to confirm',
				download: 'Download',
				close: 'Close',
				toVideo: 'Animate in Kling',
				videoPrompt: 'What should happen in the shot',
				videoDuration: 'Duration, s',
				videoModel: 'Video model',
				videoGenerate: 'Make a video',
				videoQueued: 'Video queued',
				videoRunning: 'Kling is rendering',
				noKey: 'No fal.ai key yet',
				noKeyHint: 'Open the plugin settings and paste key_id:key_secret — it goes into the DSH credential store.',
				openSettings: 'Settings',
				templatesHint: 'A template fills the prompt box — edit it freely; {{subject}} is your subject.',
				useTemplate: 'Use template',
				generatedAt: 'Created',
				itemsCount: 'items',
				useAsIs: 'Generate with this prompt',
				errorGeneric: 'Something went wrong',
				settingsTitle: 'Images (fal.ai)',
				settingsSummary: 'fal.ai key, default model and aspect',
				keyLabel: 'fal.ai key',
				keyHint: 'The whole key_id:key_secret string from fal.ai → Keys. It is stored in the DSH credential store and never written into a settings file.',
				keyConfigured: 'Key stored',
				keyMissing: 'No key yet',
				keyFromEnv: 'The key comes from an environment variable',
				keyReadOnly: 'The key is set from outside, so it cannot be saved from here',
				save: 'Save',
				saved: 'Saved',
				clear: 'Remove key',
				defaultsTitle: 'Defaults',
				outputDir: 'Studio files',
				versionTitle: 'Plugin version',
				updatesTitle: 'Updates',
				updatesCurrent: 'Installed',
				updatesLatest: 'On GitHub',
				updatesCheck: 'Check',
				updatesApply: 'Update',
				updatesAvailable: 'An update is available',
				updatesRunning: 'Installing…',
				updatesDone: 'The update has been downloaded',
				updatesDoneHint: 'Reload the page; if the version above has not changed, restart the application.',
				updatesFailed: 'The update failed',
				updatesUpToDate: 'The latest version is installed',
				updatesManual: 'This deployment has no plugin manager — update from Plugins → Add plugin:',
				updatesDisabled: 'Update checking is switched off in the row configuration',
				updatesNotes: "What's new",
				updatesReload: 'Reload the page',
				importLink: 'Import by link',
				importHint: 'Download an image or video from a direct link into this same gallery',
				importPlaceholder: 'https://… direct link to the file',
				importButton: 'Download',
				importing: 'Downloading…',
				importDone: 'The file is in the gallery',
				cancel: 'Cancel',
				saving: 'Saving…',
				modelCustom: '· custom',
				modelAdd: '＋ Own model',
				modelAddHint: 'Any fal.ai endpoint by its slug — for example fal-ai/qwen-image',
				modelAddPlaceholder: 'fal-ai/qwen-image',
				modelAddButton: 'Add',
				modelRemove: 'Remove from the list',
				// The local provider: a ComfyUI the person runs themselves. The plugin
				// only connects to it — nothing is downloaded, and no key is involved.
				provider: 'Provider',
				providerFal: 'fal.ai',
				providerLocal: 'Local ComfyUI',
				localUrl: 'ComfyUI address',
				localUrlHint: 'Loopback only: 127.0.0.1, localhost or ::1',
				localCheck: 'Check connection',
				localChecking: 'Checking…',
				localReachable: 'ComfyUI is answering',
				localUnreachable: 'ComfyUI is not answering at {url}',
				localUrlInvalid: 'Only a loopback address is accepted: 127.0.0.1, localhost or ::1',
				// The right sidebar card and the media-source switcher.
				mediaPanel: 'Project media',
				mediaPanelHint: 'The project gallery, generation and montage in the right panel',
				libraryTitle: 'Media source',
				librarySource: 'Source',
				libraryStudio: 'Shared studio',
				librarySubdir: 'Subfolder',
				librarySubdirHint: 'A folder inside dsh-media, for example shots/2026',
				libraryApply: 'Apply',
				librarySaved: 'The media source has been switched',
				librarySubdirKept: 'That subfolder was not accepted; the previous one stands',
				libraryUnsupported: 'The host has no workspace registry, so only the shared studio is available',
				libraryNoProjects: 'No projects yet, so only the shared studio is available',
				libraryCurrent: 'Library',
				gitignoreAdd: 'Add dsh-media to .gitignore',
				gitignoreBusy: 'Adding…',
				gitignoreAdded: 'dsh-media has been added to .gitignore',
				gitignorePresent: 'dsh-media is already in .gitignore',
			},
		};

		/** The dictionary for the interface language, resolved once per render. */
		function strings() {
			const lang = typeof document !== 'undefined' && document.documentElement
				? String(document.documentElement.lang || '').toLowerCase()
				: '';
			return lang.startsWith('ru') ? STRINGS.ru : STRINGS.en;
		}

		//#endregion

		//#region http

		/**
		 * Call the plugin's own surface and unwrap its `{ ok, … }` envelope.
		 *
		 * @param route - path below `/api/image-studio`.
		 * @param init - fetch options.
		 * @returns the parsed body.
		 * @throws when the host answers with a failure or an unreadable body.
		 */
		async function api(route, init) {
			const response = await fetch(`${API}${route}`, {
				cache: 'no-store',
				headers: init && init.body ? { 'Content-Type': 'application/json' } : undefined,
				...init,
			});
			let body;
			try {
				body = await response.json();
			} catch {
				body = undefined;
			}
			if (!response.ok || !body || body.ok !== true) {
				throw new Error((body && body.error) || `HTTP ${response.status}`);
			}
			return body;
		}

		//#endregion

		//#region updates

		/**
		 * The update state shared by the page header and the settings card.
		 *
		 * The check itself is cheap and cached by the host for five minutes, so
		 * both callers ask on mount and the second one costs nothing. While an
		 * install is running the hook polls, because the host hands the work to
		 * the plugin manager and reports progress on the same route.
		 *
		 * @param options.enabled - whether to ask at all.
		 * @returns `{ info, busy, error, check, apply }`.
		 */
		function useUpdate({ enabled = true } = {}) {
			const [info, setInfo] = useState(null);
			const [busy, setBusy] = useState(false);
			const [error, setError] = useState('');

			const load = useCallback(async (force) => {
				try {
					const body = await api(`/update${force ? '?force=1' : ''}`);
					setInfo(body);
					return body;
				} catch (failure) {
					setError(failure.message);
					return null;
				}
			}, []);

			useEffect(() => {
				if (enabled) void load(false);
			}, [enabled, load]);

			useEffect(() => {
				if (!info || !info.progress || info.progress.status !== 'running') return undefined;
				const timer = setInterval(() => { void load(true); }, 2500);
				return () => clearInterval(timer);
			}, [info, load]);

			const apply = useCallback(async () => {
				setBusy(true);
				setError('');
				try {
					const body = await api('/update/apply', { method: 'POST' });
					setInfo((current) => (current ? { ...current, progress: { status: 'running', spec: body.spec, at: Date.now() } } : current));
				} catch (failure) {
					setError(failure.message);
				} finally {
					setBusy(false);
				}
			}, []);

			return { info, busy, error, check: () => load(true), apply };
		}

		//#endregion

		//#region icons

		function IconImages({ size = 18 }) {
			return h('svg', {
				viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
				'aria-hidden': 'true',
			},
				h('rect', { x: 2.75, y: 4.75, width: 14.5, height: 12.5, rx: 2.25 }),
				h('circle', { cx: 7.4, cy: 9.4, r: 1.35 }),
				h('path', { d: 'M3.4 15.6 7.9 11.7l3.6 3.1 2.7-2.3 3.15 2.7' }),
				h('path', { d: 'M19.4 2.6l.85 2.05 2.05.85-2.05.85-.85 2.05-.85-2.05L16.5 5.5l2.05-.85z' }));
		}

		/**
		 * The plugin's own tile, the very shape `icon.svg` draws: one blue tile
		 * with a white sun and a white ridge. It is the guide card's glyph in the
		 * right sidebar and the chip's mark, which is where the plugin has to be
		 * recognizable at 14px, so it keeps two white shapes and no outline.
		 */
		function MediaMark({ size = 26, className }) {
			return h('svg', {
				viewBox: '0 0 64 64', width: size, height: size, className, 'aria-hidden': 'true',
			},
				h('defs', null,
					h('linearGradient', {
						id: 'dsh-is-media-tile', x1: '6', y1: '6', x2: '58', y2: '58', gradientUnits: 'userSpaceOnUse',
					},
						h('stop', { offset: '0', stopColor: '#6b9bf7' }),
						h('stop', { offset: '1', stopColor: '#4a5fd6' })),
					h('clipPath', { id: 'dsh-is-media-window' },
						h('rect', { x: 6, y: 6, width: 52, height: 52, rx: 14 }))),
				h('rect', { x: 6, y: 6, width: 52, height: 52, rx: 14, fill: 'url(#dsh-is-media-tile)' }),
				h('g', { clipPath: 'url(#dsh-is-media-window)' },
					h('circle', { cx: 23, cy: 23.5, r: 5.2, fill: '#ffffff' }),
					h('path', { d: 'M0 58 L25 28 L37 43 L44 34 L66 58 Z', fill: '#ffffff' })));
		}

		function IconStar({ size = 15, filled = false }) {
			return h('svg', {
				viewBox: '0 0 24 24', width: size, height: size,
				fill: filled ? 'currentColor' : 'none', stroke: 'currentColor', strokeWidth: 1.7,
				strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true',
			}, h('path', { d: 'M12 3.6l2.6 5.3 5.8.85-4.2 4.1 1 5.8L12 16.9 6.8 19.6l1-5.8-4.2-4.1 5.8-.85z' }));
		}

		function IconCopy({ size = 15 }) {
			return h('svg', {
				viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
				'aria-hidden': 'true',
			},
				h('rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }),
				h('path', { d: 'M5 15V5a2 2 0 0 1 2-2h10' }));
		}

		function IconTrash({ size = 15 }) {
			return h('svg', {
				viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
				'aria-hidden': 'true',
			},
				h('path', { d: 'M4 7h16' }),
				h('path', { d: 'M10 11v6M14 11v6' }),
				h('path', { d: 'M6 7l1 13h10l1-13' }),
				h('path', { d: 'M9 7V4h6v3' }));
		}

		function IconDownload({ size = 15 }) {
			return h('svg', {
				viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
				'aria-hidden': 'true',
			},
				h('path', { d: 'M12 4v11' }),
				h('path', { d: 'M7.5 11.5 12 16l4.5-4.5' }),
				h('path', { d: 'M5 19h14' }));
		}

		function IconFilm({ size = 15 }) {
			return h('svg', {
				viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
				'aria-hidden': 'true',
			},
				h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }),
				h('path', { d: 'M3 9.5h18M3 14.5h18M8 5v14M16 5v14' }));
		}

		function IconClose({ size = 16 }) {
			return h('svg', {
				viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
				stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': 'true',
			}, h('path', { d: 'M6 6l12 12M18 6L6 18' }));
		}

		//#endregion

		//#region styles

		/**
		 * The page stylesheet. Every colour comes from the harness theme tokens so
		 * the page follows the light and dark palettes without a second definition,
		 * and every fallback keeps it readable if a token is ever renamed.
		 */
		const STYLE_ID = 'dsh-image-studio-styles';
		const CSS = `
.dsh-is-root {
	display: flex; flex-direction: column; height: 100%; min-height: 0;
	background: var(--dsw-alias-bg-base, #14161a);
	color: var(--dsw-alias-label-primary, #e9ecf1);
	font-family: var(--dsw-font-family, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
	padding: calc(var(--dsw-frame-top-clearance, 48px) + 18px) 26px 22px;
	box-sizing: border-box; overflow: hidden;
}
.dsh-is-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; }
.dsh-is-title { font-size: 26px; font-weight: 600; margin: 0; letter-spacing: -0.01em; }
.dsh-is-subtitle { margin: 5px 0 0; font-size: 13px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.dsh-is-count { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b93a1); white-space: nowrap; }

.dsh-is-banner {
	display: flex; align-items: center; gap: 10px; margin-top: 14px; padding: 10px 12px;
	border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.12));
	border-radius: var(--dsw-radius-md, 10px);
	background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.03));
	font-size: 13px; color: var(--dsw-alias-label-secondary, #b8bfca);
}
.dsh-is-banner-error { border-color: var(--dsw-alias-state-error-primary, #e5646a); color: var(--dsw-alias-state-error-primary, #e5646a); }
.dsh-is-banner-ok { border-color: var(--dsw-alias-state-success-primary, #3fa96b); color: var(--dsw-alias-state-success-primary, #3fa96b); }
.dsh-is-banner button { margin-left: auto; }

.dsh-is-composer {
	margin-top: 16px; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.10));
	border-radius: var(--dsw-radius-lg, 14px);
	background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.02));
	padding: 12px 12px 10px;
	display: flex; flex-direction: column; gap: 10px;
	box-shadow: var(--dsw-elevation-prominent, 0 10px 30px rgba(0,0,0,0.18));
}
.dsh-is-prompt {
	width: 100%; min-height: 54px; max-height: 180px; resize: vertical; box-sizing: border-box;
	background: transparent; border: none; outline: none; color: inherit;
	font: inherit; font-size: 14px; line-height: 1.5;
}
.dsh-is-prompt::placeholder { color: var(--dsw-alias-label-tertiary, #7b8390); }
.dsh-is-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.dsh-is-field { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.dsh-is-field select {
	background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,0.05));
	color: var(--dsw-alias-label-primary, #e9ecf1);
	border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.12));
	border-radius: var(--dsw-radius-sm, 8px); padding: 5px 8px; font: inherit; font-size: 12px;
}
.dsh-is-spacer { flex: 1 1 auto; }

.dsh-is-button {
	display: inline-flex; align-items: center; justify-content: center; gap: 7px;
	border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.12));
	background: var(--dsw-alias-button-elevated-fill, rgba(255,255,255,0.05));
	color: var(--dsw-alias-label-primary, #e9ecf1);
	border-radius: var(--dsw-radius-sm, 8px);
	padding: 6px 11px; font: inherit; font-size: 12.5px; cursor: pointer;
}
.dsh-is-button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.09)); }
.dsh-is-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, #4c8dff); outline-offset: 1px; }
.dsh-is-button[disabled] { opacity: 0.5; cursor: default; }
.dsh-is-button-primary {
	background: var(--dsw-alias-button-primary-fill, #3b6ef5);
	border-color: transparent; color: var(--dsw-alias-label-primary-inverted, #fff);
	padding: 7px 16px; font-weight: 600;
}
.dsh-is-button-primary:hover { background: var(--dsw-alias-button-primary-hover, #325fd6); }
.dsh-is-button-danger:hover { background: var(--dsw-alias-interactive-bg-hover-danger, rgba(229,100,106,0.16)); color: var(--dsw-alias-state-error-primary, #e5646a); }

.dsh-is-tabs { display: flex; gap: 4px; margin-top: 18px; align-items: center; }
.dsh-is-tab {
	background: transparent; border: none; color: var(--dsw-alias-label-tertiary, #8b93a1);
	padding: 7px 12px; border-radius: var(--dsw-radius-sm, 8px); font: inherit; font-size: 13.5px; cursor: pointer;
}
.dsh-is-tab[aria-selected="true"] {
	background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,0.06));
	color: var(--dsw-alias-label-primary, #e9ecf1); font-weight: 600;
}
.dsh-is-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 12px; }
.dsh-is-chip {
	background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.03));
	border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));
	color: var(--dsw-alias-label-secondary, #b8bfca);
	border-radius: 999px; padding: 4px 11px; font: inherit; font-size: 12px; cursor: pointer;
}
.dsh-is-chip[aria-pressed="true"] {
	border-color: var(--dsw-alias-brand-primary, #3b6ef5);
	color: var(--dsw-alias-label-primary, #e9ecf1);
}
.dsh-is-search {
	background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.03));
	border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));
	border-radius: var(--dsw-radius-sm, 8px);
	color: inherit; font: inherit; font-size: 12.5px; padding: 5px 10px; min-width: 190px;
}

.dsh-is-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; margin-top: 14px; padding-right: 4px; }
.dsh-is-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 14px; }
.dsh-is-card {
	position: relative; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));
	border-radius: var(--dsw-radius-md, 10px); overflow: hidden; cursor: pointer;
	background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.03));
	display: flex; flex-direction: column;
}
.dsh-is-card:hover { border-color: var(--dsw-alias-border-l4, rgba(255,255,255,0.22)); }
.dsh-is-thumb { position: relative; aspect-ratio: 1 / 1; background: var(--dsw-alias-bg-skeleton, rgba(255,255,255,0.04)); }
.dsh-is-thumb img, .dsh-is-thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
.dsh-is-card-caption {
	padding: 8px 10px; font-size: 12px; color: var(--dsw-alias-label-secondary, #b8bfca);
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dsh-is-card-actions { position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; opacity: 0; transition: opacity 120ms ease; }
.dsh-is-card:hover .dsh-is-card-actions, .dsh-is-card:focus-within .dsh-is-card-actions { opacity: 1; }
.dsh-is-icon-button {
	display: inline-flex; align-items: center; justify-content: center;
	width: 27px; height: 27px; border-radius: 50%;
	border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.14));
	background: color-mix(in srgb, var(--dsw-alias-bg-base, #14161a) 72%, transparent);
	color: var(--dsw-alias-label-primary, #e9ecf1); cursor: pointer; padding: 0;
}
.dsh-is-icon-button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,0.12)); }
.dsh-is-icon-button[aria-pressed="true"] { color: var(--dsw-alias-state-warn-primary, #e0a63a); }
.dsh-is-badge {
	position: absolute; left: 8px; bottom: 8px; font-size: 11px; padding: 2px 7px; border-radius: 999px;
	background: color-mix(in srgb, var(--dsw-alias-bg-base, #14161a) 74%, transparent);
	color: var(--dsw-alias-label-secondary, #c6ccd6); border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.12));
}
.dsh-is-video-badge { display: inline-flex; align-items: center; gap: 4px; }

.dsh-is-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 60px 20px; text-align: center; }
.dsh-is-empty h3 { margin: 0; font-size: 15px; font-weight: 600; }
.dsh-is-empty p { margin: 0; font-size: 13px; color: var(--dsw-alias-label-tertiary, #8b93a1); max-width: 420px; }

.dsh-is-templates { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 14px; }
.dsh-is-template {
	border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));
	border-radius: var(--dsw-radius-md, 10px); padding: 13px 14px;
	background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,0.03));
	display: flex; flex-direction: column; gap: 8px;
}
.dsh-is-template h4 { margin: 0; font-size: 13.5px; font-weight: 600; }
.dsh-is-template p { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #8b93a1); }
.dsh-is-template-actions { display: flex; gap: 8px; margin-top: auto; }

.dsh-is-progress { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #b8bfca); }
.dsh-is-spinner {
	width: 13px; height: 13px; border-radius: 50%; flex: 0 0 auto;
	border: 2px solid var(--dsw-alias-border-l4, rgba(255,255,255,0.3));
	border-top-color: var(--dsw-alias-brand-primary, #3b6ef5);
	animation: dsh-is-spin 0.85s linear infinite;
}
@keyframes dsh-is-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .dsh-is-spinner { animation-duration: 2.4s; } }

.dsh-is-lightbox {
	position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center;
	background: color-mix(in srgb, #000 72%, transparent); padding: 34px; box-sizing: border-box;
}
.dsh-is-lightbox-body {
	display: flex; gap: 0; max-width: 1360px; width: 100%; max-height: 100%;
	background: var(--dsw-alias-bg-layer-1, #191c22);
	border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.12));
	border-radius: var(--dsw-radius-lg, 14px); overflow: hidden;
}
.dsh-is-stage { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; justify-content: center; background: #0d0f12; padding: 14px; }
.dsh-is-stage img, .dsh-is-stage video { max-width: 100%; max-height: calc(100vh - 130px); object-fit: contain; display: block; }
.dsh-is-side {
	width: 340px; flex: 0 0 auto; border-left: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));
	padding: 16px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto;
}
.dsh-is-side h3 { margin: 0; font-size: 14px; font-weight: 600; }
.dsh-is-meta { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b93a1); line-height: 1.7; }
.dsh-is-meta code { font-size: 11.5px; color: var(--dsw-alias-label-secondary, #c6ccd6); }
.dsh-is-prompt-box {
	font-size: 12.5px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #b8bfca);
	background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,0.05));
	border-radius: var(--dsw-radius-sm, 8px); padding: 9px 10px; max-height: 168px; overflow-y: auto;
	white-space: pre-wrap; word-break: break-word;
}
.dsh-is-section { display: flex; flex-direction: column; gap: 7px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08)); padding-top: 12px; }
.dsh-is-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsh-is-input, .dsh-is-textarea {
	width: 100%; box-sizing: border-box; font: inherit; font-size: 12.5px;
	background: var(--dsw-alias-bg-layer-3, rgba(255,255,255,0.05));
	color: var(--dsw-alias-label-primary, #e9ecf1);
	border: 1px solid var(--dsw-alias-border-l3, rgba(255,255,255,0.12));
	border-radius: var(--dsw-radius-sm, 8px); padding: 7px 9px;
}
.dsh-is-textarea { min-height: 62px; resize: vertical; line-height: 1.5; }
.dsh-is-label { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b93a1); }

.dsh-is-settings { display: flex; flex-direction: column; gap: 12px; font-size: 13px; }
.dsh-is-settings-row { display: flex; flex-direction: column; gap: 6px; }
.dsh-is-settings-status { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
.dsh-is-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.dsh-is-dot-on { background: var(--dsw-alias-state-success-primary, #3fa96b); }
.dsh-is-dot-off { background: var(--dsw-alias-state-error-primary, #e5646a); }
.dsh-is-hint { font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b93a1); line-height: 1.5; }

.dsh-is-library {
	display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; margin-top: 14px;
	padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.08));
	border-radius: var(--dsw-radius-lg, 12px);
}
.dsh-is-library-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #b8bfca); }
.dsh-is-library .dsh-is-input { width: auto; min-width: 180px; }
.dsh-is-library-root {
	font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b93a1);
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
}
.dsh-is-library-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary, #3fa96b); }
.dsh-is-tab-title { display: inline-flex; align-items: center; gap: 6px; }
`;

		/** Inject the stylesheet once per document. */
		function useStyles() {
			useEffect(() => {
				if (typeof document === 'undefined') return undefined;
				if (document.getElementById(STYLE_ID)) return undefined;
				const element = document.createElement('style');
				element.id = STYLE_ID;
				element.textContent = CSS;
				document.head.appendChild(element);
				return undefined;
			}, []);
		}

		//#endregion

		//#region helpers

		/** A byte count a person can read. */
		function formatBytes(bytes) {
			if (typeof bytes !== 'number' || bytes <= 0) return '';
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
			return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		}

		/** A short local date for a card's tooltip. */
		function formatDate(value) {
			if (typeof value !== 'number' || value <= 0) return '';
			try {
				return new Date(value).toLocaleString();
			} catch {
				return '';
			}
		}

		/** Copy text, reporting whether the clipboard accepted it. */
		async function copyText(text) {
			try {
				await navigator.clipboard.writeText(text);
				return true;
			} catch {
				return false;
			}
		}

		/** The localized label of a template. */
		function templateLabel(template, dict) {
			const lang = dict === STRINGS.ru ? 'ru' : 'en';
			return (template.label && (template.label[lang] || template.label.en)) || template.id;
		}

		/** The localized prompt body of a template. */
		function templatePrompt(template, dict) {
			const lang = dict === STRINGS.ru ? 'ru' : 'en';
			return (template.prompt && (template.prompt[lang] || template.prompt.en)) || '';
		}

		//#endregion

		//#region settings card

		/**
		 * The plugin's own settings. It is registered both on the bundle page and
		 * on the row's page, so one component serves both views.
		 */
		function StudioSettings({ view }) {
			const dict = strings();
			const [state, setState] = useState(null);
			const [keyDraft, setKeyDraft] = useState('');
			const [busy, setBusy] = useState(false);
			const [message, setMessage] = useState('');
			const [error, setError] = useState('');
			const [defaults, setDefaults] = useState(null);

			useStyles();

			const load = useCallback(async () => {
				try {
					const body = await api('/state');
					setState(body);
					setDefaults({
						defaultModel: body.config.defaultModel,
						defaultAspect: body.config.defaultAspect,
						defaultCount: body.config.defaultCount,
					});
				} catch (failure) {
					setError(failure.message);
				}
			}, []);

			useEffect(() => { void load(); }, [load]);

			// Declared last so the hook order above stays what the render tests seed.
			const upd = useUpdate({ enabled: view !== 'summary' });

			if (view === 'summary') return dict.settingsSummary;

			const saveKey = async () => {
				setBusy(true);
				setError('');
				setMessage('');
				try {
					const body = await api('/credentials', { method: 'POST', body: JSON.stringify({ value: keyDraft }) });
					setState((current) => (current ? { ...current, credentials: body.credentials } : current));
					setKeyDraft('');
					setMessage(dict.saved);
				} catch (failure) {
					setError(failure.message);
				} finally {
					setBusy(false);
				}
			};

			const clearKey = async () => {
				setBusy(true);
				setError('');
				setMessage('');
				try {
					const body = await api('/credentials', { method: 'POST', body: JSON.stringify({ value: '' }) });
					setState((current) => (current ? { ...current, credentials: body.credentials } : current));
					setMessage(dict.saved);
				} catch (failure) {
					setError(failure.message);
				} finally {
					setBusy(false);
				}
			};

			const saveDefaults = async () => {
				if (!defaults) return;
				setBusy(true);
				setError('');
				setMessage('');
				try {
					const body = await api('/config', { method: 'POST', body: JSON.stringify(defaults) });
					setState((current) => (current ? { ...current, config: body.config } : current));
					setMessage(dict.saved);
				} catch (failure) {
					setError(failure.message);
				} finally {
					setBusy(false);
				}
			};

			const fal = state && state.credentials ? state.credentials.fal : undefined;
			const writable = fal ? fal.writable !== false : true;

			return h('div', { className: 'dsh-is-settings' },
				h('div', { className: 'dsh-is-settings-status' },
					h('span', { className: `dsh-is-dot ${fal && fal.configured ? 'dsh-is-dot-on' : 'dsh-is-dot-off'}` }),
					h('span', null, fal && fal.configured
						? (fal.source === 'env' ? dict.keyFromEnv : dict.keyConfigured)
						: dict.keyMissing),
					state && state.version ? h('span', { className: 'dsh-is-hint', style: { marginLeft: 'auto' } }, `v${state.version}`) : null),

				h('div', { className: 'dsh-is-settings-row' },
					h('label', { className: 'dsh-is-label', htmlFor: 'dsh-is-key' }, dict.keyLabel),
					h('input', {
						id: 'dsh-is-key',
						className: 'dsh-is-input',
						type: 'password',
						autoComplete: 'off',
						spellCheck: false,
						value: keyDraft,
						disabled: !writable || busy,
						placeholder: writable ? 'key_id:key_secret' : dict.keyReadOnly,
						onChange: (event) => setKeyDraft(event.target.value),
						onKeyDown: (event) => { if (event.key === 'Enter' && keyDraft.trim() !== '') void saveKey(); },
					}),
					h('p', { className: 'dsh-is-hint' }, dict.keyHint)),

				h('div', { className: 'dsh-is-row' },
					h('button', { className: 'dsh-is-button dsh-is-button-primary', disabled: busy || keyDraft.trim() === '' || !writable, onClick: () => void saveKey() }, dict.save),
					h('button', { className: 'dsh-is-button dsh-is-button-danger', disabled: busy || !writable, onClick: () => void clearKey() }, dict.clear)),

				state && state.storage ? h('p', { className: 'dsh-is-hint' }, `${dict.outputDir}: ${state.storage.root}`) : null,

				h('div', { className: 'dsh-is-section' },
					h('h3', null, dict.defaultsTitle),
					state ? h('div', { className: 'dsh-is-row' },
						h('span', { className: 'dsh-is-field' }, dict.model,
							h('select', {
								value: defaults ? defaults.defaultModel : '',
								onChange: (event) => setDefaults({ ...defaults, defaultModel: event.target.value }),
							}, state.catalog.imageModels.map((model) => h('option', { key: model.id, value: model.id }, model.label)))),
						h('span', { className: 'dsh-is-field' }, dict.aspect,
							h('select', {
								value: defaults ? defaults.defaultAspect : '1:1',
								onChange: (event) => setDefaults({ ...defaults, defaultAspect: event.target.value }),
							}, state.catalog.aspects.map((aspect) => h('option', { key: aspect, value: aspect }, aspect)))),
						h('span', { className: 'dsh-is-field' }, dict.count,
							h('select', {
								value: defaults ? String(defaults.defaultCount) : '1',
								onChange: (event) => setDefaults({ ...defaults, defaultCount: Number(event.target.value) }),
							}, [1, 2, 3, 4].map((count) => h('option', { key: count, value: String(count) }, String(count))))),
						h('button', { className: 'dsh-is-button', disabled: busy, onClick: () => void saveDefaults() }, dict.save))
						: h('p', { className: 'dsh-is-hint' }, '…')),

				h(UpdateSection, { upd, dict }),

				message !== '' ? h('p', { className: 'dsh-is-hint', style: { color: 'var(--dsw-alias-state-success-primary, #3fa96b)' } }, message) : null,
				error !== '' ? h('p', { className: 'dsh-is-hint', style: { color: 'var(--dsw-alias-state-error-primary, #e5646a)' } }, error) : null);
		}

		/**
		 * The updates block: what is installed, what the branch holds, and one
		 * button that hands the revision to the harness plugin manager.
		 */
		function UpdateSection({ upd, dict }) {
			const info = upd.info;
			const progress = info ? info.progress : undefined;
			const running = progress !== undefined && progress.status === 'running';

			return h('div', { className: 'dsh-is-section' },
				h('h3', null, dict.updatesTitle),

				!info
					? h('div', { className: 'dsh-is-row' },
						h('span', { className: 'dsh-is-hint' }, upd.error || '…'),
						h('button', { className: 'dsh-is-button', onClick: () => void upd.check() }, dict.updatesCheck))
					: h('div', null,
						h('div', { className: 'dsh-is-meta' },
							h('div', null, `${dict.updatesCurrent}: ${info.current}`),
							h('div', null, `${dict.updatesLatest}: ${info.latest}${info.sha ? ` · ${info.sha}` : ''}`)),

						info.enabled === false
							? h('p', { className: 'dsh-is-hint' }, dict.updatesDisabled)
							: null,

						info.notes && info.notes.length > 0
							? h('div', { className: 'dsh-is-settings-row' },
								h('span', { className: 'dsh-is-label' }, dict.updatesNotes),
								h('div', { className: 'dsh-is-prompt-box' },
									info.notes.map((note) => h('div', { key: note.sha }, `${note.sha} · ${note.message}`))))
							: null,

						h('div', { className: 'dsh-is-row' },
							running
								? h('div', { className: 'dsh-is-progress' },
									h('span', { className: 'dsh-is-spinner' }),
									h('span', null, dict.updatesRunning))
								: null,
							h('button', { className: 'dsh-is-button', disabled: running, onClick: () => void upd.check() }, dict.updatesCheck),
							info.updateAvailable || running
								? h('button', {
									className: 'dsh-is-button dsh-is-button-primary',
									disabled: running || upd.busy || info.manager === false,
									onClick: () => void upd.apply(),
								}, `${dict.updatesApply} → ${info.latest}`)
								: null,
							!info.updateAvailable && !running
								? h('span', { className: 'dsh-is-hint' }, dict.updatesUpToDate)
								: null),

						info.manager === false
							? h('p', { className: 'dsh-is-hint' }, `${dict.updatesManual} ${info.spec}`)
							: null,

						progress && progress.status === 'done'
							? h('div', { className: 'dsh-is-row' },
								h('span', { className: 'dsh-is-hint', style: { color: 'var(--dsw-alias-state-success-primary, #3fa96b)' } }, `${dict.updatesDone}. ${dict.updatesDoneHint}`),
								h('button', {
									className: 'dsh-is-button',
									onClick: () => { if (typeof location !== 'undefined') location.reload(); },
								}, dict.updatesReload))
							: null,
						progress && progress.status === 'error'
							? h('p', { className: 'dsh-is-hint', style: { color: 'var(--dsw-alias-state-error-primary, #e5646a)' } },
								`${dict.updatesFailed}: ${progress.error || ''}`)
							: null),

				upd.error && info ? h('p', { className: 'dsh-is-hint', style: { color: 'var(--dsw-alias-state-error-primary, #e5646a)' } }, upd.error) : null);
		}

		//#endregion

		//#region lightbox

		/**
		 * One entry, large: judge it, download it, reuse its prompt, or hand it to
		 * Kling to become a shot.
		 */
		function Lightbox({ item, catalog, onClose, onGalleryChanged, onNotice, onError }) {
			const dict = strings();
			const [zoom, setZoom] = useState(1);
			const [favorite, setFavorite] = useState(item.favorite === true);
			const [confirmDelete, setConfirmDelete] = useState(false);
			const [videoOpen, setVideoOpen] = useState(false);
			const [videoModel, setVideoModel] = useState(catalog.defaultVideoModel);
			const [videoPrompt, setVideoPrompt] = useState('');
			const [videoDuration, setVideoDuration] = useState('5');
			const [videoJob, setVideoJob] = useState(null);
			const closeRef = useRef(null);

			const videoModels = catalog.videoModels.filter((model) => (item.kind === 'image' ? true : !model.needsImage));

			useEffect(() => {
				const onKey = (event) => { if (event.key === 'Escape') onClose(); };
				window.addEventListener('keydown', onKey);
				if (closeRef.current) closeRef.current.focus();
				return () => window.removeEventListener('keydown', onKey);
			}, [onClose]);

			useEffect(() => {
				if (!videoJob || videoJob.status === 'done' || videoJob.status === 'error') return undefined;
				const timer = setInterval(async () => {
					try {
						const body = await api(`/job?id=${encodeURIComponent(videoJob.id)}`);
						setVideoJob(body.job);
						if (body.job.status === 'done') {
							onNotice(dict.done);
							onGalleryChanged();
						}
						if (body.job.status === 'error') onError(body.job.error || dict.errorGeneric);
					} catch (failure) {
						onError(failure.message);
						setVideoJob(null);
					}
				}, JOB_POLL_MS);
				return () => clearInterval(timer);
			}, [videoJob, dict.done, dict.errorGeneric, onGalleryChanged, onError, onNotice]);

			const toggleFavorite = async () => {
				try {
					const body = await api('/favorite', { method: 'POST', body: JSON.stringify({ id: item.id, favorite: !favorite }) });
					setFavorite(body.item.favorite === true);
					onGalleryChanged();
				} catch (failure) {
					onError(failure.message);
				}
			};

			const remove = async () => {
				if (!confirmDelete) {
					setConfirmDelete(true);
					return;
				}
				try {
					await api('/delete', { method: 'POST', body: JSON.stringify({ id: item.id }) });
					onGalleryChanged();
					onClose();
				} catch (failure) {
					onError(failure.message);
				}
			};

			const startVideo = async () => {
				try {
					const body = await api('/video', {
						method: 'POST',
						body: JSON.stringify({
							id: item.id,
							model: videoModel,
							prompt: videoPrompt,
							duration: videoDuration,
							aspect: item.aspect,
						}),
					});
					setVideoJob(body.job);
					onNotice(dict.videoQueued);
				} catch (failure) {
					onError(failure.message);
				}
			};

			const videoBusy = videoJob !== null && videoJob.status !== 'done' && videoJob.status !== 'error';

			return h('div', {
				className: 'dsh-is-lightbox',
				role: 'dialog',
				'aria-modal': 'true',
				'aria-label': item.prompt || item.id,
				onMouseDown: (event) => { if (event.target === event.currentTarget) onClose(); },
			},
				h('div', { className: 'dsh-is-lightbox-body' },
					h('div', { className: 'dsh-is-stage' },
						item.kind === 'video'
							? h('video', { src: item.url, controls: true, autoPlay: true, loop: true, playsInline: true })
							: h('img', {
								src: item.url,
								alt: item.prompt || '',
								style: { transform: `scale(${zoom})`, transformOrigin: 'center center', transition: 'transform 120ms ease' },
								onDoubleClick: () => setZoom((current) => (current === 1 ? 2 : 1)),
							})),

					h('div', { className: 'dsh-is-side' },
						h('div', { className: 'dsh-is-row' },
							h('h3', { style: { margin: 0, flex: '1 1 auto' } }, item.kind === 'video' ? 'Kling' : item.modelLabel || 'fal.ai'),
							h('button', { ref: closeRef, className: 'dsh-is-icon-button', onClick: onClose, 'aria-label': dict.close }, h(IconClose))),

						item.prompt ? h('div', { className: 'dsh-is-prompt-box' }, item.prompt) : null,

						h('div', { className: 'dsh-is-meta' },
							item.width && item.height ? h('div', null, `${item.width} × ${item.height}`) : null,
							item.aspect ? h('div', null, `${dict.aspect}: ${item.aspect}`) : null,
							item.duration ? h('div', null, `${dict.videoDuration}: ${item.duration}`) : null,
							item.bytes ? h('div', null, formatBytes(item.bytes)) : null,
							item.createdAt ? h('div', null, formatDate(item.createdAt)) : null,
							h('div', null, h('code', null, item.id))),

						h('div', { className: 'dsh-is-row' },
							h('button', { className: 'dsh-is-button', onClick: () => void toggleFavorite(), 'aria-pressed': favorite },
								h(IconStar, { filled: favorite }), favorite ? dict.unfavorite : dict.favorite),
							h('a', { className: 'dsh-is-button', href: item.url, download: true }, h(IconDownload), dict.download),
							item.prompt
								? h('button', {
									className: 'dsh-is-button',
									onClick: async () => { if (await copyText(item.prompt)) onNotice(dict.copied); },
								}, h(IconCopy), dict.copyPrompt)
								: null,
							h('button', { className: 'dsh-is-button dsh-is-button-danger', onClick: () => void remove(), 'aria-pressed': confirmDelete },
								h(IconTrash), confirmDelete ? dict.removeConfirm : dict.remove)),

						item.kind === 'image' || !item.kind
							? h('div', { className: 'dsh-is-section' },
								h('div', { className: 'dsh-is-row' },
									h('h3', { style: { margin: 0, flex: '1 1 auto' } }, dict.toVideo),
									h('button', { className: 'dsh-is-button', onClick: () => setVideoOpen((open) => !open) }, videoOpen ? dict.close : dict.open)),
								videoOpen ? h('div', { className: 'dsh-is-settings' },
									h('label', { className: 'dsh-is-label' }, dict.videoModel),
									h('select', {
										className: 'dsh-is-input',
										value: videoModel,
										onChange: (event) => setVideoModel(event.target.value),
									}, videoModels.map((model) => h('option', { key: model.id, value: model.id }, model.label))),
									h('label', { className: 'dsh-is-label' }, dict.videoPrompt),
									h('textarea', {
										className: 'dsh-is-textarea',
										value: videoPrompt,
										placeholder: dict.videoPrompt,
										onChange: (event) => setVideoPrompt(event.target.value),
									}),
									h('div', { className: 'dsh-is-row' },
										h('span', { className: 'dsh-is-field' }, dict.videoDuration,
											h('select', {
												value: videoDuration,
												onChange: (event) => setVideoDuration(event.target.value),
											}, catalog.durations.map((duration) => h('option', { key: duration, value: duration }, duration)))),
										h('div', { className: 'dsh-is-spacer' }),
										h('button', {
											className: 'dsh-is-button dsh-is-button-primary',
											disabled: videoBusy,
											onClick: () => void startVideo(),
										}, dict.videoGenerate)),
									videoBusy
										? h('div', { className: 'dsh-is-progress' },
											h('span', { className: 'dsh-is-spinner' }),
											h('span', null, videoJob.status === 'queued' ? dict.videoQueued : dict.videoRunning,
												typeof videoJob.queuePosition === 'number' ? ` · ${dict.position} ${videoJob.queuePosition}` : ''))
										: null,
									videoJob && videoJob.status === 'error'
										? h('p', { className: 'dsh-is-hint', style: { color: 'var(--dsw-alias-state-error-primary, #e5646a)' } }, videoJob.error)
										: null)
									: null)
							: null)));
		}

		//#endregion

		//#region page

		/** One gallery card. */
		function GalleryCard({ item, onOpen, onToggleFavorite, onDelete, onCopyPrompt, dict }) {
			const videoRef = useRef(null);
			return h('div', {
				className: 'dsh-is-card',
				tabIndex: 0,
				role: 'button',
				'aria-label': item.prompt || item.id,
				onClick: () => onOpen(item),
				onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(item); } },
			},
				h('div', {
					className: 'dsh-is-thumb',
					onMouseEnter: () => { if (videoRef.current) void videoRef.current.play().catch(() => {}); },
					onMouseLeave: () => { if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; } },
				},
					item.kind === 'video'
						? h('video', { ref: videoRef, src: item.url, muted: true, loop: true, playsInline: true, preload: 'metadata' })
						: h('img', { src: item.url, alt: item.prompt || '', loading: 'lazy' }),
					h('div', { className: 'dsh-is-card-actions', onClick: (event) => event.stopPropagation() },
						h('button', {
							className: 'dsh-is-icon-button',
							'aria-pressed': item.favorite === true,
							'aria-label': item.favorite ? dict.unfavorite : dict.favorite,
							title: item.favorite ? dict.unfavorite : dict.favorite,
							onClick: () => onToggleFavorite(item),
						}, h(IconStar, { filled: item.favorite === true })),
						item.prompt
							? h('button', {
								className: 'dsh-is-icon-button',
								'aria-label': dict.copyPrompt,
								title: dict.copyPrompt,
								onClick: () => onCopyPrompt(item),
							}, h(IconCopy))
							: null,
						h('button', {
							className: 'dsh-is-icon-button',
							'aria-label': dict.remove,
							title: dict.remove,
							onClick: () => onDelete(item),
						}, h(IconTrash))),
					item.kind === 'video'
						? h('span', { className: 'dsh-is-badge dsh-is-video-badge' }, h(IconFilm, { size: 12 }), item.duration ? `${item.duration}s` : 'video')
						: null),
				h('div', { className: 'dsh-is-card-caption', title: item.prompt || item.modelLabel }, item.prompt || item.modelLabel || item.id));
		}

		/**
		 * The montage tab: a timeline of chosen entries, assembled into one file by
		 * ffmpeg on the host. The tab reads the whole gallery itself rather than
		 * the filtered grid, because the timeline is about material, not about
		 * what the gallery happens to be filtered to.
		 */
		function MontageTab({ catalog, dict, tools, onNotice, onError, onGalleryChanged, onOpen }) {
			const [sources, setSources] = useState([]);
			const [segments, setSegments] = useState([]);
			const [aspect, setAspect] = useState('9:16');
			const [stillSeconds, setStillSeconds] = useState(2);
			const [job, setJob] = useState(null);

			const ffmpegOk = !tools || !tools.ffmpeg || tools.ffmpeg.ok === true;
			const aspects = catalog && Array.isArray(catalog.montageAspects) && catalog.montageAspects.length > 0
				? catalog.montageAspects
				: ['9:16', '4:5', '1:1', '16:9'];

			const loadSources = useCallback(async () => {
				try {
					const body = await api('/gallery');
					setSources(body.items);
				} catch (failure) {
					onError(failure.message);
				}
			}, [onError]);

			useEffect(() => { void loadSources(); }, [loadSources]);

			useEffect(() => {
				if (!job || job.status === 'done' || job.status === 'error') return undefined;
				const timer = setInterval(async () => {
					try {
						const body = await api(`/job?id=${encodeURIComponent(job.id)}`);
						setJob(body.job);
						if (body.job.status === 'done') {
							onNotice(dict.montageDone);
							await loadSources();
							onGalleryChanged();
						}
						if (body.job.status === 'error') onError(body.job.error || dict.errorGeneric);
					} catch (failure) {
						onError(failure.message);
						setJob(null);
					}
				}, JOB_POLL_MS);
				return () => clearInterval(timer);
			}, [job, dict.montageDone, dict.errorGeneric, loadSources, onGalleryChanged, onError, onNotice]);

			const add = (item) => setSegments((current) => [...current, {
				id: item.id,
				kind: item.kind,
				url: item.url,
				label: item.prompt || item.modelLabel || item.id,
			}]);

			const move = (index, delta) => setSegments((current) => {
				const target = index + delta;
				if (target < 0 || target >= current.length) return current;
				const next = [...current];
				const [moved] = next.splice(index, 1);
				next.splice(target, 0, moved);
				return next;
			});

			const drop = (index) => setSegments((current) => current.filter((_, position) => position !== index));

			const busy = job !== null && job.status !== 'done' && job.status !== 'error';
			const images = segments.filter((segment) => segment.kind === 'image').length;

			const build = async () => {
				try {
					const body = await api('/montage', {
						method: 'POST',
						body: JSON.stringify({ ids: segments.map((segment) => segment.id), aspect, stillSeconds }),
					});
					setJob(body.job);
				} catch (failure) {
					onError(failure.message);
				}
			};

			if (!ffmpegOk) {
				return h('div', { className: 'dsh-is-empty' },
					h(IconFilm, { size: 30 }),
					h('h3', null, dict.tabMontage),
					h('p', null, dict.montageNoFfmpeg),
					tools && tools.ffmpeg && tools.ffmpeg.message ? h('p', null, h('code', null, tools.ffmpeg.message)) : null);
			}

			return h('div', { className: 'dsh-is-settings' },
				h('p', { className: 'dsh-is-subtitle', style: { margin: 0 } }, dict.montageHint),

				h('div', { className: 'dsh-is-row' },
					h('h3', { style: { margin: 0 } }, `${dict.montageTimeline} · ${segments.length}`),
					h('div', { className: 'dsh-is-spacer' }),
					h('span', { className: 'dsh-is-field' }, dict.aspect,
						h('select', { value: aspect, onChange: (event) => setAspect(event.target.value) },
							aspects.map((value) => h('option', { key: value, value }, value)))),
					images > 0
						? h('span', { className: 'dsh-is-field' }, dict.montageStill,
							h('select', { value: String(stillSeconds), onChange: (event) => setStillSeconds(Number(event.target.value)) },
								[1, 2, 3, 4, 5, 6, 8, 10].map((value) => h('option', { key: value, value: String(value) }, String(value)))))
						: null,
					h('button', {
						className: 'dsh-is-button dsh-is-button-primary',
						disabled: busy || segments.length === 0,
						onClick: () => void build(),
					}, busy ? `${dict.montageWorking}…` : dict.montageBuild)),

				busy
					? h('div', { className: 'dsh-is-progress' },
						h('span', { className: 'dsh-is-spinner' }),
						h('span', null, `${dict.montageWorking} · ${dict.montageStep} ${job.step ?? 1}/${job.totalSteps ?? '?'}`))
					: null,
				job && job.status === 'error'
					? h('p', { className: 'dsh-is-hint', style: { color: 'var(--dsw-alias-state-error-primary, #e5646a)' } }, job.error)
					: null,
				job && job.status === 'done' && job.items && job.items[0]
					? h('div', { className: 'dsh-is-row' },
						h('span', { className: 'dsh-is-hint' }, `${dict.montageDone} · ${formatBytes(job.items[0].bytes)}`),
						h('button', { className: 'dsh-is-button', onClick: () => onOpen(job.items[0]) }, dict.open))
					: null,

				segments.length === 0
					? h('p', { className: 'dsh-is-hint' }, dict.montageEmpty)
					: h('div', { className: 'dsh-is-templates' },
						segments.map((segment, index) => h('div', { key: `${segment.id}-${index}`, className: 'dsh-is-template' },
							h('div', { className: 'dsh-is-row' },
								h('span', { className: 'dsh-is-hint' }, `${index + 1}`),
								segment.kind === 'image'
									? h('img', { src: segment.url, alt: '', style: { width: '46px', height: '46px', objectFit: 'cover', borderRadius: '6px' } })
									: h('video', { src: segment.url, muted: true, style: { width: '46px', height: '46px', objectFit: 'cover', borderRadius: '6px' } }),
								h('span', { className: 'dsh-is-hint', style: { flex: '1 1 auto', minWidth: 0 } },
									`${segment.kind === 'video' ? '🎬 ' : ''}${segment.label.slice(0, 60)}`)),
							h('div', { className: 'dsh-is-template-actions' },
								h('button', { className: 'dsh-is-button', disabled: index === 0, onClick: () => move(index, -1) }, dict.montageUp),
								h('button', { className: 'dsh-is-button', disabled: index === segments.length - 1, onClick: () => move(index, 1) }, dict.montageDown),
								h('button', { className: 'dsh-is-button dsh-is-button-danger', onClick: () => drop(index) }, dict.montageRemove))))),

				h('div', { className: 'dsh-is-section' },
					h('h3', { style: { margin: 0 } }, dict.montageSources),
					sources.length === 0
						? h('p', { className: 'dsh-is-hint' }, dict.montageNoSources)
						: h('div', { className: 'dsh-is-grid' },
							sources.map((item) => h('div', {
								key: item.id,
								className: 'dsh-is-card',
								role: 'button',
								tabIndex: 0,
								onClick: () => add(item),
								onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); add(item); } },
							},
								h('div', { className: 'dsh-is-thumb' },
									item.kind === 'video'
										? h('video', { src: item.url, muted: true, preload: 'metadata' })
										: h('img', { src: item.url, alt: '', loading: 'lazy' })),
								h('div', { className: 'dsh-is-card-caption' }, item.kind === 'video' ? `🎬 ${item.modelLabel}` : item.modelLabel))))));
		}

		/**
		 * The media-source switcher: the shared studio or a folder inside one of
		 * the host's projects, the subfolder the studio writes into, and the one
		 * git hygiene action that follows from pointing it at a repository.
		 *
		 * The host owns every path. This component speaks only the fixed
		 * contract — `GET /workspaces` for the project list and the support flag,
		 * `POST /config` for the choice, `POST /gitignore` for the `dsh-media/`
		 * line — and reads the current values from `/state.library`, so a save
		 * re-reads the page state instead of guessing what the host kept.
		 *
		 * The gitignore action is offered only while the chosen project is a
		 * repository that does not ignore the library yet (`git === true &&
		 * ignored === false`); anywhere else the same request would be a lie.
		 */
		function LibraryBar({ library, dict, onChanged, onNotice, onError }) {
			const [subdir, setSubdir] = useState(library.subdir || '');
			const [busy, setBusy] = useState(false);
			const [gitBusy, setGitBusy] = useState(false);
			const [gitResult, setGitResult] = useState('');
			// `/workspaces` is the only route that says whether the host even has
			// a workspace registry, so it is asked once; an absent answer leaves
			// the block from `/state` in charge.
			const [registry, setRegistry] = useState(null);

			useEffect(() => {
				let cancelled = false;
				void (async () => {
					try {
						const body = await api('/workspaces');
						if (!cancelled) {
							setRegistry({
								supported: body.supported !== false,
								workspaces: Array.isArray(body.workspaces) ? body.workspaces : [],
							});
						}
					} catch {
						// The block from `/state` already carries the projects.
					}
				})();
				return () => { cancelled = true; };
			}, []);

			// A save rewrites the block, so the field follows the host afterwards.
			useEffect(() => { setSubdir(library.subdir || ''); }, [library.subdir]);

			const workspaces = Array.isArray(library.workspaces) && library.workspaces.length > 0
				? library.workspaces
				: registry && Array.isArray(registry.workspaces) ? registry.workspaces : [];
			const supported = library.supported !== false && (registry === null || registry.supported !== false);
			const source = library.source === 'workspace' ? 'workspace' : 'studio';
			const project = source === 'workspace' ? (library.workspace || (workspaces[0] ? workspaces[0].dir : '')) : '';
			const projectMissing = source === 'workspace' && project !== ''
				&& !workspaces.some((entry) => entry && entry.dir === project);

			const choose = async (nextSource, nextProject) => {
				setBusy(true);
				if (onError) onError('');
				try {
					const wanted = subdir.trim();
					const body = await api('/config', {
						method: 'POST',
						body: JSON.stringify({
							librarySource: nextSource,
							libraryWorkspace: nextSource === 'workspace' ? nextProject : undefined,
							librarySubdir: wanted,
						}),
					});
					// The host drops a subdirectory it cannot accept and answers with
					// the value that stands, so the field follows that and the person
					// is told rather than left with a value nothing kept.
					const kept = body.config && typeof body.config.librarySubdir === 'string'
						? body.config.librarySubdir
						: wanted;
					setSubdir(kept);
					await onChanged();
					if (onNotice) onNotice(kept === wanted ? dict.librarySaved : dict.librarySubdirKept);
				} catch (failure) {
					if (onError) onError(failure.message);
				} finally {
					setBusy(false);
				}
			};

			const addToGitignore = async () => {
				setGitBusy(true);
				setGitResult('');
				if (onError) onError('');
				try {
					const body = await api('/gitignore', { method: 'POST' });
					const message = body.changed === true ? dict.gitignoreAdded : dict.gitignorePresent;
					setGitResult(message);
					if (onNotice) onNotice(message);
					await onChanged();
				} catch (failure) {
					if (onError) onError(failure.message);
				} finally {
					setGitBusy(false);
				}
			};

			return h('div', { className: 'dsh-is-library', 'data-dsh-is-library': source },
				h('span', { className: 'dsh-is-library-label' }, dict.libraryTitle),
				h('span', { className: 'dsh-is-field' }, dict.librarySource,
					h('select', {
						value: source === 'workspace' ? `workspace:${project}` : 'studio',
						disabled: busy,
						onChange: (event) => {
							const value = event.target.value;
							if (value === 'studio') void choose('studio', '');
							else void choose('workspace', value.slice('workspace:'.length));
						},
					},
						h('option', { value: 'studio' }, dict.libraryStudio),
						projectMissing ? h('option', { value: `workspace:${project}` }, project) : null,
						workspaces.map((entry) => h('option', {
							key: entry.dir,
							value: `workspace:${entry.dir}`,
						}, entry.name || entry.dir)))),
				h('span', { className: 'dsh-is-field' }, dict.librarySubdir,
					h('input', {
						className: 'dsh-is-input',
						type: 'text',
						value: subdir,
						placeholder: dict.librarySubdirHint,
						disabled: busy,
						onChange: (event) => setSubdir(event.target.value),
						onKeyDown: (event) => { if (event.key === 'Enter') void choose(source, project); },
					})),
				h('button', {
					className: 'dsh-is-button',
					disabled: busy,
					onClick: () => void choose(source, project),
				}, busy ? dict.saving : dict.libraryApply),
				h('span', { className: 'dsh-is-library-root', title: library.root || '' },
					`${dict.libraryCurrent}: ${library.root || '—'}`),
				!supported
					? h('span', { className: 'dsh-is-hint' }, dict.libraryUnsupported)
					: source === 'studio' && workspaces.length === 0
						? h('span', { className: 'dsh-is-hint' }, dict.libraryNoProjects)
						: null,
				library.git === true && library.ignored === false
					? h('button', {
						className: 'dsh-is-button dsh-is-button-primary dsh-is-gitignore',
						disabled: gitBusy,
						onClick: () => void addToGitignore(),
					}, gitBusy ? dict.gitignoreBusy : dict.gitignoreAdd)
					: null,
				gitResult !== '' ? h('span', { className: 'dsh-is-library-ok' }, gitResult) : null);
		}

		/** The Images page: prompt bar, templates, gallery, and the lightbox. */
		function ImagesPanel() {
			const dict = strings();
			useStyles();

			const [state, setState] = useState(null);
			const [items, setItems] = useState([]);
			const [tab, setTab] = useState('gallery');
			const [filter, setFilter] = useState('all');
			const [query, setQuery] = useState('');
			const [prompt, setPrompt] = useState('');
			const [model, setModel] = useState('');
			const [aspect, setAspect] = useState('1:1');
			const [count, setCount] = useState(1);
			const [quality, setQuality] = useState('');
			const [resolution, setResolution] = useState('');
			const [job, setJob] = useState(null);
			const [error, setError] = useState('');
			const [notice, setNotice] = useState('');
			const [preview, setPreview] = useState(null);
			// Importing by link: paste a URL from anywhere and the host downloads it
			// into the same gallery, so a picture made elsewhere can be compared here.
			const [importUrl, setImportUrl] = useState('');
			const [importOpen, setImportOpen] = useState(false);
			const [importing, setImporting] = useState(false);
			// The model picker: three built-ins are a starting point, not a limit —
			// any fal endpoint can be added by its slug and stays in the list.
			const [modelOpen, setModelOpen] = useState(false);
			const [modelDraft, setModelDraft] = useState('');
			const [modelBusy, setModelBusy] = useState(false);
			const promptRef = useRef(null);

			const refreshGallery = useCallback(async () => {
				try {
					const params = new URLSearchParams();
					if (filter === 'image' || filter === 'video') params.set('kind', filter);
					if (filter === 'favorite') params.set('favorite', 'true');
					if (query.trim() !== '') params.set('q', query.trim());
					const body = await api(`/gallery?${params.toString()}`);
					setItems(body.items);
				} catch (failure) {
					setError(failure.message);
				}
			}, [filter, query]);

			const refreshState = useCallback(async () => {
				try {
					const body = await api('/state');
					setState(body);
					setModel((current) => current || body.config.defaultModel);
					setAspect((current) => (current === '1:1' ? body.config.defaultAspect : current));
					setCount((current) => (current === 1 ? body.config.defaultCount : current));
				} catch (failure) {
					setError(failure.message);
				}
			}, []);

			useEffect(() => { void refreshState(); }, [refreshState]);
			useEffect(() => { void refreshGallery(); }, [refreshGallery]);

			// Progress lives in the host, so a reload of this page finds the job again.
			useEffect(() => {
				if (!job || job.status === 'done' || job.status === 'error') return undefined;
				const timer = setInterval(async () => {
					try {
						const body = await api(`/job?id=${encodeURIComponent(job.id)}`);
						setJob(body.job);
						if (body.job.status === 'done') {
							await refreshGallery();
							await refreshState();
						}
						if (body.job.status === 'error') setError(body.job.error || dict.errorGeneric);
					} catch (failure) {
						setError(failure.message);
						setJob(null);
					}
				}, JOB_POLL_MS);
				return () => clearInterval(timer);
			}, [job, refreshGallery, refreshState, dict.errorGeneric]);

			useEffect(() => {
				if (notice === '') return undefined;
				const timer = setTimeout(() => setNotice(''), 2600);
				return () => clearTimeout(timer);
			}, [notice]);

			// Declared last so the hook order above stays what the render tests seed.
			const upd = useUpdate();

			// The local provider's own state. It comes after `useUpdate` on purpose:
			// the render suite seeds hook cells by index, and a state added above
			// `useUpdate` would shift the update hook's cell.
			const [provider, setProvider] = useState('fal');
			const [localUrl, setLocalUrl] = useState('');
			const [localStatus, setLocalStatus] = useState(null);
			const [localBusy, setLocalBusy] = useState(false);

			// The address is the host's setting; the field follows it until the person
			// types their own, and a value the host refused never becomes the field's.
			useEffect(() => {
				const configured = state && state.config && typeof state.config.localUrl === 'string' ? state.config.localUrl : '';
				if (configured !== '') setLocalUrl((current) => current || configured);
			}, [state]);

			/**
			 * Ask the host to store the address and probe it.
			 *
			 * The host validates the address itself, so the answer says which value
			 * actually stands: something the host refused is reported as such here
			 * rather than silently kept and used later.
			 */
			const checkLocal = async () => {
				const wanted = localUrl.trim().replace(/\/+$/, '');
				setLocalBusy(true);
				setError('');
				try {
					const saved = await api('/config', { method: 'POST', body: JSON.stringify({ localUrl: wanted }) });
					const kept = saved.config && typeof saved.config.localUrl === 'string' ? saved.config.localUrl : '';
					if (kept.replace(/\/+$/, '') !== wanted) {
						setLocalStatus(null);
						setError(dict.localUrlInvalid);
						return;
					}
					setLocalUrl(kept);
					// A server that is off is not a page error: the answer stays beside
					// the address field, where the reason is attached to the address.
					const status = await api('/local/status');
					setLocalStatus(status);
				} catch (failure) {
					setError(failure.message);
				} finally {
					setLocalBusy(false);
				}
			};

			/** Download a link into the gallery, through the host, and show it at once. */
			const runImport = async () => {
				const url = importUrl.trim();
				if (url === '') return;
				setImporting(true);
				setError('');
				try {
					await api('/import', { method: 'POST', body: JSON.stringify({ url }) });
					setImportUrl('');
					setImportOpen(false);
					setNotice(dict.importDone);
					await refreshGallery();
				} catch (failure) {
					setError(failure.message);
				} finally {
					setImporting(false);
				}
			};

			/** Remember a model of the user's own, so the picker can offer it later. */
			const addModel = async () => {
				const id = modelDraft.trim();
				if (id === '') return;
				const existing = state && state.config.customModels ? state.config.customModels : [];
				await saveModels([...existing, id], id);
			};

			/** Drop one remembered endpoint. */
			const removeModel = async (id) => {
				const existing = state && state.config.customModels ? state.config.customModels : [];
				const next = existing.filter((entry) => entry !== id);
				await saveModels(next, next.includes(model) ? next[0] ?? '' : model);
			};

			/**
			 * Write the remembered list, and select what was just added.
			 *
			 * The host answers with the list it actually kept, so a rejected slug
			 * (not an `owner/name` pair) simply does not appear.
			 */
			const saveModels = async (list, select) => {
				setModelBusy(true);
				setError('');
				try {
					const body = await api('/config', {
						method: 'POST',
						body: JSON.stringify({ customModels: list, defaultModel: select === '' ? undefined : select }),
					});
					setState((current) => (current ? { ...current, config: body.config } : current));
					await refreshState();
					if (select !== '') setModel(select);
					setModelDraft('');
				} catch (failure) {
					setError(failure.message);
				} finally {
					setModelBusy(false);
				}
			};

			const catalog = state ? state.catalog : null;			const selectedModel = catalog ? catalog.imageModels.find((entry) => entry.id === model) || catalog.imageModels[0] : null;
			const keyReady = state ? Boolean(state.credentials && state.credentials.fal && state.credentials.fal.configured) : true;
			// A local server has no key at all, so the key banner and the generate
			// button's guard apply to the fal path only.
			const keyNeeded = provider === 'fal';
			const localAddress = localUrl || (state && state.config && state.config.localUrl) || '';
			const busy = job !== null && job.status !== 'done' && job.status !== 'error';
			const readyItems = job && Array.isArray(job.items) ? job.items.length : 0;

			const generate = async () => {
				if (prompt.trim() === '') {
					setError(dict.promptPlaceholder);
					if (promptRef.current) promptRef.current.focus();
					return;
				}
				setError('');
				try {
					const body = await api('/generate', {
						method: 'POST',
						body: JSON.stringify({
							provider,
							prompt,
							// The fal catalogue means nothing to a local graph, and a local
							// server has no key: only the fields the chosen path uses travel.
							model: provider === 'fal' ? (model || undefined) : undefined,
							aspect,
							count,
							quality: provider === 'fal' ? (quality || undefined) : undefined,
							resolution: provider === 'fal' ? (resolution || undefined) : undefined,
						}),
					});
					setJob(body.job);
				} catch (failure) {
					setError(failure.message);
				}
			};

			const toggleFavorite = async (item) => {
				try {
					const body = await api('/favorite', { method: 'POST', body: JSON.stringify({ id: item.id, favorite: !(item.favorite === true) }) });
					setItems((current) => current.map((entry) => (entry.id === body.item.id ? body.item : entry)));
					setPreview((current) => (current && current.id === body.item.id ? body.item : current));
				} catch (failure) {
					setError(failure.message);
				}
			};

			const remove = async (item) => {
				try {
					await api('/delete', { method: 'POST', body: JSON.stringify({ id: item.id }) });
					setItems((current) => current.filter((entry) => entry.id !== item.id));
					setPreview((current) => (current && current.id === item.id ? null : current));
					setNotice(dict.done);
				} catch (failure) {
					setError(failure.message);
				}
			};

			const copyPrompt = async (item) => {
				if (await copyText(item.prompt)) setNotice(dict.copied);
			};

			const useTemplate = (template) => {
				setPrompt(templatePrompt(template, dict));
				if (template.aspect && catalog && catalog.aspects.includes(template.aspect)) setAspect(template.aspect);
				setTab('gallery');
				setTimeout(() => { if (promptRef.current) promptRef.current.focus(); }, 0);
			};

			return h('div', { className: 'dsh-is-root' },
				h('div', { className: 'dsh-is-head' },
					h('div', null,
						h('h1', { className: 'dsh-is-title' }, dict.title),
						h('p', { className: 'dsh-is-subtitle' }, dict.subtitle)),
					h('div', { className: 'dsh-is-row' },
						upd.info && (upd.info.updateAvailable || (upd.info.progress && upd.info.progress.status === 'running'))
							? h('button', {
								className: 'dsh-is-button dsh-is-button-primary',
								disabled: upd.busy || (upd.info.progress && upd.info.progress.status === 'running') || upd.info.manager === false,
								title: upd.info.manager === false ? `${dict.updatesManual} ${upd.info.spec}` : dict.updatesAvailable,
								onClick: () => void upd.apply(),
							}, upd.info.progress && upd.info.progress.status === 'running'
								? dict.updatesRunning
								: `${dict.updatesApply} → ${upd.info.latest}`)
							: null,
						state ? h('span', { className: 'dsh-is-count' },
							`${state.stats.total} ${dict.itemsCount} · ${state.stats.images} / ${state.stats.videos}`,
							state.version ? h('span', { title: dict.versionTitle }, ` · v${state.version}`) : null) : null)),

				state && state.library
					? h(LibraryBar, {
						library: state.library,
						dict,
						onChanged: () => { void refreshState(); void refreshGallery(); },
						onNotice: setNotice,
						onError: setError,
					})
					: null,

				!keyReady && keyNeeded && state
					? h('div', { className: 'dsh-is-banner dsh-is-banner-error' },
						h('span', null, `${dict.noKey}. ${dict.noKeyHint}`))
					: null,
				error !== ''
					? h('div', { className: 'dsh-is-banner dsh-is-banner-error' },
						h('span', null, error),
						h('button', { className: 'dsh-is-button', onClick: () => setError('') }, dict.close))
					: null,
				notice !== '' ? h('div', { className: 'dsh-is-banner dsh-is-banner-ok' }, h('span', null, notice)) : null,

				h('div', { className: 'dsh-is-composer' },
					h('textarea', {
						ref: promptRef,
						className: 'dsh-is-prompt',
						value: prompt,
						placeholder: dict.promptPlaceholder,
						onChange: (event) => setPrompt(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								void generate();
							}
						},
					}),
					h('div', { className: 'dsh-is-controls' },
						catalog
							? h('span', { className: 'dsh-is-field' }, dict.provider,
								h('span', { style: { display: 'flex', gap: '6px' } },
									h('button', {
										className: 'dsh-is-chip',
										'aria-pressed': provider === 'fal',
										onClick: () => setProvider('fal'),
									}, dict.providerFal),
									h('button', {
										className: 'dsh-is-chip',
										'aria-pressed': provider === 'local',
										onClick: () => setProvider('local'),
									}, dict.providerLocal)))
							: null,
						catalog && provider === 'fal' ? h('span', { className: 'dsh-is-field' }, dict.model,
							h('select', { value: model, onChange: (event) => setModel(event.target.value) },
								catalog.imageModels.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.custom ? `${entry.label} ${dict.modelCustom}` : entry.label))),
							h('button', {
								className: 'dsh-is-chip',
								'aria-pressed': modelOpen,
								title: dict.modelAddHint,
								onClick: () => setModelOpen(!modelOpen),
							}, dict.modelAdd)) : null,
						catalog ? h('span', { className: 'dsh-is-field' }, dict.aspect,
							h('select', { value: aspect, onChange: (event) => setAspect(event.target.value) },
								catalog.aspects.map((entry) => h('option', { key: entry, value: entry }, entry)))) : null,
						h('span', { className: 'dsh-is-field' }, dict.count,
							h('select', { value: String(count), onChange: (event) => setCount(Number(event.target.value)) },
								[1, 2, 3, 4, 6, 8].map((value) => h('option', { key: value, value: String(value) }, String(value))))),
						selectedModel && provider === 'fal' && selectedModel.qualities.length > 0
							? h('span', { className: 'dsh-is-field' }, dict.quality,
								h('select', { value: quality, onChange: (event) => setQuality(event.target.value) },
									['', ...selectedModel.qualities].map((value) => h('option', { key: value || 'auto', value }, value || 'auto'))))
							: null,
						selectedModel && provider === 'fal' && selectedModel.resolutions.length > 0
							? h('span', { className: 'dsh-is-field' }, dict.resolution,
								h('select', { value: resolution, onChange: (event) => setResolution(event.target.value) },
									['', ...selectedModel.resolutions].map((value) => h('option', { key: value || 'default', value }, value || 'default'))))
							: null,
						h('div', { className: 'dsh-is-spacer' }),
						busy
							? h('div', { className: 'dsh-is-progress' },
								h('span', { className: 'dsh-is-spinner' }),
								h('span', null,
									job.status === 'queued' ? dict.queued : dict.running,
									typeof job.queuePosition === 'number' ? ` · ${dict.position} ${job.queuePosition}` : '',
									readyItems > 0 ? ` · ${readyItems}/${(job.request && job.request.count) || readyItems}` : ''))
							: null,
						h('button', {
							className: 'dsh-is-button dsh-is-button-primary',
							disabled: busy || (keyNeeded && !keyReady),
							onClick: () => void generate(),
						}, busy ? dict.generateMore : dict.generate))),

				// The local provider's own row: the address, the one control that proves
				// whether anything is listening there, and that answer verbatim.
				catalog && provider === 'local'
					? h('div', { className: 'dsh-is-chips' },
						h('span', { className: 'dsh-is-field' }, dict.localUrl,
							h('input', {
								className: 'dsh-is-search',
								type: 'text',
								value: localUrl,
								placeholder: dict.localUrlHint,
								title: dict.localUrlHint,
								style: { flex: '1 1 260px' },
								onChange: (event) => setLocalUrl(event.target.value),
								onKeyDown: (event) => { if (event.key === 'Enter') void checkLocal(); },
							})),
						h('button', {
							className: 'dsh-is-button',
							disabled: localBusy || localUrl.trim() === '',
							onClick: () => void checkLocal(),
						}, localBusy ? dict.localChecking : dict.localCheck),
						localStatus
							? h('span', {
								className: localStatus.reachable === true ? 'dsh-is-library-ok' : 'dsh-is-banner-error',
							}, localStatus.reachable === true
								? `${dict.localReachable}${localStatus.version ? ` · v${localStatus.version}` : ''}${localStatus.device ? ` · ${localStatus.device}` : ''}${typeof localStatus.vram === 'number' ? ` · ${Math.round(localStatus.vram / 1024 / 1024 / 1024)} GB VRAM` : ''}`
								: dict.localUnreachable.replace('{url}', localStatus.url || localAddress))
							: null)
					: null,

				h('div', { className: 'dsh-is-tabs', role: 'tablist' },
					h('button', { className: 'dsh-is-tab', role: 'tab', 'aria-selected': tab === 'gallery', onClick: () => setTab('gallery') }, dict.tabGallery),
					h('button', { className: 'dsh-is-tab', role: 'tab', 'aria-selected': tab === 'templates', onClick: () => setTab('templates') }, dict.tabTemplates),
					h('button', { className: 'dsh-is-tab', role: 'tab', 'aria-selected': tab === 'montage', onClick: () => setTab('montage') }, dict.tabMontage)),

				tab === 'gallery'
					? h('div', { className: 'dsh-is-chips' },
						[['all', dict.filterAll], ['image', dict.filterImages], ['video', dict.filterVideos], ['favorite', dict.filterFavorites]]
							.map(([value, label]) => h('button', {
								key: value,
								className: 'dsh-is-chip',
								'aria-pressed': filter === value,
								onClick: () => setFilter(value),
							}, label)),
						h('div', { className: 'dsh-is-spacer' }),
						h('button', {
							className: 'dsh-is-chip',
							'aria-pressed': importOpen,
							title: dict.importHint,
							onClick: () => setImportOpen(!importOpen),
						}, dict.importLink),
						h('input', {
							className: 'dsh-is-search',
							type: 'search',
							value: query,
							placeholder: dict.searchPlaceholder,
							onChange: (event) => setQuery(event.target.value),
						}))
					: null,

				tab === 'gallery' && importOpen
					? h('div', { className: 'dsh-is-chips' },
						h('input', {
							className: 'dsh-is-search',
							type: 'url',
							value: importUrl,
							placeholder: dict.importPlaceholder,
							style: { flex: '1 1 320px' },
							onChange: (event) => setImportUrl(event.target.value),
							onKeyDown: (event) => { if (event.key === 'Enter') void runImport(); },
						}),
						h('button', {
							className: 'dsh-is-button dsh-is-button-primary',
							disabled: importing || importUrl.trim() === '',
							onClick: () => void runImport(),
						}, importing ? dict.importing : dict.importButton),
						h('button', {
							className: 'dsh-is-button',
							onClick: () => { setImportOpen(false); setImportUrl(''); },
						}, dict.cancel))
					: null,

				modelOpen
					? h('div', { className: 'dsh-is-chips' },
						h('input', {
							className: 'dsh-is-search',
							type: 'text',
							value: modelDraft,
							placeholder: dict.modelAddPlaceholder,
							style: { flex: '1 1 280px' },
							onChange: (event) => setModelDraft(event.target.value),
							onKeyDown: (event) => { if (event.key === 'Enter') void addModel(); },
						}),
						h('button', {
							className: 'dsh-is-button dsh-is-button-primary',
							disabled: modelBusy || modelDraft.trim() === '',
							onClick: () => void addModel(),
						}, modelBusy ? dict.saving : dict.modelAddButton),
						(state && state.config.customModels ? state.config.customModels : []).map((id) => h('button', {
							key: id,
							className: 'dsh-is-chip',
							title: dict.modelRemove,
							onClick: () => void removeModel(id),
						}, `${id} ✕`)))
					: null,

				h('div', { className: 'dsh-is-scroll' },
					tab === 'montage' && catalog
						? h(MontageTab, {
							catalog,
							dict,
							tools: state ? state.tools : undefined,
							onNotice: setNotice,
							onError: setError,
							onGalleryChanged: () => { void refreshGallery(); void refreshState(); },
							onOpen: setPreview,
						})
						: tab === 'templates' && catalog
						? h('div', null,
							h('p', { className: 'dsh-is-subtitle', style: { marginBottom: '14px' } }, dict.templatesHint),
							h('div', { className: 'dsh-is-templates' },
								catalog.templates.map((template) => h('div', { key: template.id, className: 'dsh-is-template' },
									h('h4', null, templateLabel(template, dict)),
									h('p', null, templatePrompt(template, dict)),
									h('div', { className: 'dsh-is-template-actions' },
										h('button', { className: 'dsh-is-button dsh-is-button-primary', onClick: () => useTemplate(template) }, dict.useTemplate))))))
						: items.length === 0
							? h('div', { className: 'dsh-is-empty' },
								h(IconImages, { size: 34 }),
								h('h3', null, filter === 'all' && query === '' ? dict.emptyTitle : dict.emptyFiltered),
								h('p', null, dict.emptyHint))
							: h('div', { className: 'dsh-is-grid' },
								items.map((item) => h(GalleryCard, {
									key: item.id,
									item,
									dict,
									onOpen: setPreview,
									onToggleFavorite: toggleFavorite,
									onDelete: remove,
									onCopyPrompt: copyPrompt,
								})))),

				preview && catalog
					? h(Lightbox, {
						item: preview,
						catalog,
						onClose: () => setPreview(null),
						onGalleryChanged: () => { void refreshGallery(); void refreshState(); },
						onNotice: setNotice,
						onError: setError,
					})
					: null);
		}

		//#endregion

		//#region registration

		/** The sidebar glyph; the shell supplies the size and the selected state. */
		function ImagesPanelIcon({ size }) {
			return h(IconImages, { size });
		}

		/**
		 * The right sidebar's tab type: one guide card next to Files, Terminal
		 * and Browser whose page is this plugin's own `ImagesPanel`.
		 *
		 * The card list is not a slot other plugins could push into — the
		 * sidebar builds it from the `guide` entries of every registered tab
		 * type — so the card is contributed through `ctx.sidebarRightTabs`. The
		 * body then registers under the same id in the keyed
		 * `sidebar.right.pane.tab` seat, which is the documented two-stage path
		 * (`ui-sidebar-documentpreview` and the third-party SEO card both take
		 * it). The `rightbar` seat itself is declared `kind: "single"` and
		 * belongs to the sidebar package: registering there would evict whatever
		 * occupied it first, so this plugin never touches it.
		 */
		function mediaTabDefinition() {
			return {
				id: MEDIA_TAB_ID,
				kind: MEDIA_KIND,
				multiple: false,
				priority: 'builtin',
				title: () => strings().mediaPanel,
				guide: [{
					id: 'media',
					order: 45,
					title: () => strings().mediaPanel,
					description: () => strings().mediaPanelHint,
					icon: MediaMark,
				}],
			};
		}

		/** The tab chip: the plugin's tile, small, then the name. */
		function MediaTabTitle() {
			return h('span', { className: 'dsh-is-tab-title' },
				h(MediaMark, { size: 14 }),
				strings().mediaPanel);
		}

		return {
			inject: ['slots'],

			// Surfaces for the test suite only: the harness ignores unknown keys on
			// a client module, and rendering these components outside a browser is
			// the only way to prove the page does not throw on real data.
			__test: {
				ImagesPanel, MontageTab, StudioSettings, Lightbox, GalleryCard, LibraryBar, MediaMark, MediaTabTitle,
				mediaTabDefinition, MEDIA_TAB_ID, MEDIA_KIND, STRINGS,
			},

			apply(ctx) {
				// The global page and the sidebar entry that selects it share one id.
				ctx.slots.inject('main', function* registerPanel() {
					yield ctx.slots.register({ name: 'main', key: PANEL_ID }, ImagesPanel);
				});

				ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
					name: 'sidebar.panellist',
					id: PANEL_ID,
					order: 20,
					label: () => strings().panel,
				}, ImagesPanelIcon));

				// The right sidebar card. `ctx.inject` waits for the sidebar's tab
				// registry instead of assuming the sidebar package loaded first, and
				// a harness without that service (the metadata test's stub) simply
				// skips the card rather than throwing.
				if (typeof ctx.inject === 'function') {
					ctx.inject(['sidebarRightTabs'], (scope) => {
						scope.effect(() => scope.sidebarRightTabs.register(mediaTabDefinition()), 'image-studio: right sidebar card');
					});
				}

				// The card's page, in the keyed body seat — never the single-occupancy
				// `rightbar` seat. The title seat keeps the chip identifiable.
				ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
					name: 'sidebar.right.pane.tab',
					key: MEDIA_TAB_ID,
				}, ImagesPanel));

				ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
					name: 'sidebar.right.pane.tab.title',
					key: MEDIA_TAB_ID,
				}, MediaTabTitle));

				// The plugin's own settings live on the bundle page and behind the
				// row's Configure control, exactly like a shipped plugin's.
				ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
					name: 'plugins.bundle.config',
					key: 'dsh-image-studio',
				}, StudioSettings));

				ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
					name: 'plugins.row.config',
					key: 'dsh-image-studio#image-studio',
				}, StudioSettings));
			},
		};

		//#endregion
	},
});
