# Changelog

Notable changes to `dsh-image-studio`, newest first. The version in
[package.json](package.json) is the one running; [compatibility.json](compatibility.json) lists the DSH cores each
release was qualified against.

## 0.4.0

- **The gallery can live in a project.** `librarySource: workspace` puts the media in `<project>/dsh-media[/<subfolder>]`,
  created on first use, while `config.json` always stays in the shared studio. The root is resolved per request, so
  switching needs no restart, and a project that no longer exists falls back to the shared studio instead of failing
  every route.
- **A library control and a card in the right panel.** The page header switches the source, sets an optional subfolder
  and shows the folder in use; next to Files, Terminal and Browser, **Project media** opens the same page through the
  sidebar's right-tab registry (`sidebarRightTabs`). A project that is a git repository and does not ignore the media
  folder yet gets an **Add dsh-media to .gitignore** button.
- **`image_generate` for the conversation.** The model can generate into the same library the page reads — `prompt`,
  `aspect`, `count` and an optional fal `model` — using the same generation code and the same library root. A failure
  throws a readable error instead of returning a value, and that text never carries the key or this machine's paths.
- **A local ComfyUI provider.** Generation can run on a server the person already started; the plugin downloads nothing
  — no models, no workflows, no custom nodes — and accepts only a loopback address, checked on save and again before
  every request. `GET /local/status` probes the server, `provider: "local"` on `POST /generate` runs the configured API
  graph, `count > 1` runs sequentially with different seeds, and results are stored as `local:<model file>`.
- **Packaging and coverage.** `CHANGELOG.md` and `workflow/*.json` ship in `files`, `test/local-check.mjs` covers the
  ComfyUI client, and `@deepseek-ai/dsh-tools` plus `@deepseek-ai/dsh-client-ui-sidebar-right` are declared as optional
  peers.
- New host routes: `GET /workspaces` (the project list from the workspace registry), `POST /gitignore`, `GET /local/status`,
  a `library` block in `/state` (`source`, `workspaces`, `workspace`, `subdir`, `root`, `git`, `ignored`), and `provider`
  on `POST /generate`.

## 0.2.0

- **Any fal model, not just the three built in.** The model picker has an **＋ Own model** /
  **＋ Своя модель** button: paste any fal endpoint slug (`owner/name`) and it is stored in the plugin's own
  settings, offered in the picker like a built-in, and selectable as the default. Up to 40 slugs, validated and
  deduplicated on the host, removable from the same panel.

## 0.1.4

- **Import by link.** The Gallery tab can download a direct `http(s)` link into the studio. The host fetches it
  server-side and refuses anything that is not a public-internet link, so the route cannot be used to probe the local
  network.

## 0.1.3

- **Self-update.** A new **Updates** section in the settings card asks GitHub for the branch revision, lists the recent
  commits, and hands the pinned commit to the harness plugin manager; a newer branch also surfaces an update button in
  the page header. With no plugin manager, the section prints the manual install spec instead.
- **New card icons** drawn from the same visual language as the plugin icon.

## 0.1.2

- **The running version is visible.** The page header and the settings card show the version the host actually loaded,
  which is what makes "did my update land?" answerable.

## 0.1.1

- **Card metadata and locales.** `locale/en.json` and `locale/ru.json` give the Plugins card its short title
  (**Image Studio**) and a description that credits the author; both files carry the same keys.
- **The `credentials` service is declared** in the plugin's `inject`, so the model list, saving the fal key and
  generation all work on a live harness.
- Host coverage grew to exercise the HTTP surface with fake credentials and a fake queue, and the icon SVG was redrawn.
- **Montage** (timeline tab, ffmpeg planning, normalize-then-concat assembly) landed in this line.

## 0.1.0

- First release: an **Images** page for DeepSeek Harness backed by fal.ai — a prompt bar over three text-to-image
  families, the on-disk gallery with favourites, search and filters, the lightbox, **Animate in Kling**
  image-to-video, starter templates, and the loopback HTTP surface that keeps the key and the files on the host side.
