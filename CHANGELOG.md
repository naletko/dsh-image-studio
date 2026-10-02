# Changelog

Notable changes to `dsh-image-studio`, newest first. The version in
[package.json](package.json) is the one running; [compatibility.json](compatibility.json) lists the DSH cores each
release was qualified against.

## 0.3.0

- **The gallery can live in a project.** The `librarySource` configuration selects the shared studio
  (`<DSH_HOME>/image-studio`, the default) or a folder inside a project (`<project>/dsh-media`, with an optional
  subfolder). The root is resolved per request, so switching needs no restart; a project that no longer exists falls
  back to the shared studio instead of failing every route. The settings file always stays in the shared studio, and
  `POST /gitignore` adds `dsh-media/` to a project's `.gitignore` idempotently, only when that folder is a git
  repository.
- New host routes: `GET /workspaces` (the project list from the workspace registry), `POST /gitignore`, and a `library`
  block in `/state` carrying `source`, `workspaces`, `workspace`, `subdir`, `root`, `git`, `ignored`.

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
