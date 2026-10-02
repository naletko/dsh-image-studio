# dsh-image-studio

An **Images** workspace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one page to generate
with [fal.ai](https://fal.ai) or a ComfyUI you run yourself, keep every result in the shared studio or inside a project,
compare candidates, import a picture by link, and hand the winner to Kling as an image-to-video shot. The model can also
generate into the same library straight from the conversation.

[Русская версия →](README.ru.md)

```text
Images
┌────────────────────────────────────────────────────────────────────────────┐
│ Describe an image…                                                         │
│  Model: FLUX.2 Klein 9B ▾  [＋ Own model]   Aspect: 1:1 ▾                   │
│  Variants: 4 ▾                                        [Generate]           │
├────────────────────────────────────────────────────────────────────────────┤
│  Gallery | Templates | Montage    All · Images · Videos · Favourites        │
│                                   [Import by link]  [Search prompts]        │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                                │
│  │  🖼     │ │  🖼     │ │  🎬 5s │ │  🖼     │  click → lightbox             │
│  └────────┘ └────────┘ └────────┘ └────────┘  → Animate in Kling            │
└────────────────────────────────────────────────────────────────────────────┘
```

## Quick start

1. **Install** the plugin (see [Install](#install)) and open **Images** in the sidebar.
2. **Paste your fal.ai key** into **Settings → Plugins → Images (fal.ai)** and press **Save**: see
   [Where the fal key comes from](#where-the-fal-key-comes-from).
3. **Describe an image**, pick a model, an aspect and a variant count, then press **Generate**.
4. Click a result: the lightbox downloads the original, copies the prompt, marks a favourite, and offers
   **Animate in Kling**.

## What you get

- **A real page, not a chat message.** The sidebar gains an **Images** entry; the page holds a prompt bar, the model and
  aspect pickers, a variant count from 1 to 8, and the gallery underneath.
- **fal.ai underneath.** Three text-to-image families are wired with the fields fal's own OpenAPI documents declare:
  `fal-ai/flux-2/klein/9b` (FLUX.2 Klein 9B — fast and inexpensive), `openai/gpt-image-2` (GPT Image 2 — quality tier,
  text rendering), `fal-ai/nano-banana-2` (Nano Banana 2 — Gemini, 0.5K–4K).
- **Any other fal model, without waiting for a release.** The **＋ Own model** button beside the model picker stores any
  fal endpoint slug (`owner/name`) in the plugin's own settings, and it appears in the picker like a built-in.
- **A local ComfyUI is the second provider.** The **Provider** toggle can send a generation to a ComfyUI server you
  already have running — the plugin downloads nothing, no models, workflows or custom nodes.
- **A chat tool.** On a harness with the tools service, the model can call **`image_generate`** from a conversation and
  the picture lands in the same library the page reads.
- **Everything you ever generated is still there.** Results land in a studio folder on disk with an index beside them, so
  browsing costs nothing, survives a restart, and works while the provider is down. Favourites, prompt search and
  per-kind filters narrow the grid.
- **The gallery can live inside a project.** The shared studio under `<DSH_HOME>/image-studio` is the default; the
  **Media source** control in the page header can point the same page at `<project>/dsh-media` instead, so screenshots
  and clips sit beside the code they belong to. The root is resolved per request, so the switch needs no restart.
- **A card in the right panel too.** On a harness whose right sidebar exposes a tab registry, the plugin adds a
  **Project media** entry that opens the same page, so the gallery can stay beside the terminal.
- **Import by link.** Paste a direct `http(s)` link to an image or a video and it is downloaded into the same gallery.
- **A lightbox that is actually useful.** Judge the picture at full size, download the original, copy the prompt, mark
  it a favourite, or press **Animate in Kling** to turn that exact still into a shot.
- **A montage tab.** Pick clips and stills into a timeline, choose 9:16 / 4:5 / 1:1 / 16:9, and the host assembles them
  into one h264 file with ffmpeg — every segment normalized to the same size, frame rate and pixel format first, then
  joined without re-encoding. Stills become clips by looping them for the hold time you choose.
- **Templates.** Eight starter prompts (product hero, lifestyle, UGC selfie, flat lay, before/after, seasonal,
  character sheet, food close-up) in Russian and English. A template only fills the prompt box; nothing is spent until
  you press Generate.
- **Bilingual UI.** Russian and English, chosen from the interface language.
- **The key never leaves the credential store.** The settings card writes the fal key through the harness credential
  seam; the host never returns a value to the page and never writes a secret into configuration.

## Requirements

| Requirement | Needed for |
|---|---|
| DSH core `0.2.0-rc.2` (also qualified on `0.2.0-rc.1`) | The host half and the page. See [compatibility.json](compatibility.json). |
| Node.js `^22.19.0 \|\| >=24.0.0` | Everything; `package.json` declares it and CI runs Node 22.x and 24.x. |
| `ffmpeg` on `PATH`, or `ffmpegPath` in the row configuration | The **Montage** tab only. Without it the tab says so and hides the action; generation, the gallery and Kling are unaffected. |
| A fal.ai account and API key | The fal.ai provider and Kling. Browsing, importing, the montage and the local ComfyUI path need no key. |
| A local ComfyUI server (optional) | The **Local ComfyUI** provider only. The plugin connects to a server that is already running (by default `http://127.0.0.1:8188`) and downloads no models, workflows or nodes. |
| `@deepseek-ai/dsh-tools` and the harness tools service (optional) | The `image_generate` chat tool. Without either, the page and the plugin keep working. |
| Windows or macOS | Both are supported. No native modules, no build step, no shell invocation; the only external process is ffmpeg, and only for the montage. |

React 18 and the DSH client packages the page builds on are supplied by the harness as optional peer dependencies, so
installing from Git needs no build-script approval.

## Install

### From the Plugins page (recommended)

1. Open **Plugins → Add plugin**.
2. Paste the repository spec and install:

   ```text
   github:naletko/dsh-image-studio
   ```

   A local clone works too — paste the absolute path to the folder. The bare name `dsh-image-studio` also works when the
   package is available from the npm registry the profile uses.
3. Install, then restart the harness only if the page asks for it. The sidebar then shows **Images**.

### From a terminal

```sh
dsh plugin --profile web add github:naletko/dsh-image-studio      # web profile
dsh plugin --profile desktop add github:naletko/dsh-image-studio  # only while DSH Desktop is fully quit
dsh --profile web --dump-config                                   # compose the tree without booting
```

The `desktop` profile belongs to the DSH Desktop application: it refuses terminal management while the app is running,
so use **Plugins → Add plugin** there.

To remove the plugin later, use **Plugins → Remove** or `dsh plugin --profile web remove dsh-image-studio`. The library
folder (the shared studio or a project's `dsh-media`), the credentials and the other plugins are left untouched.

## Where the fal key comes from

The key is a **credential reference**, never a configuration value. Configuration (`cordis.patch.yml`, the profile
patch, `config.json`) holds only the *name* of the reference — by default `FAL_API_KEY` — and never the key itself.

Get the key from [fal.ai](https://fal.ai) → **Keys**; it is the whole `key_id:key_secret` string.

The easiest way to store it:

1. Open **Settings → Plugins → Images (fal.ai)**.
2. Paste the whole `key_id:key_secret` string and press **Save**. The plugin writes it through the harness credential
   seam (`ctx.credentials`).
3. The field is write-only from the page: the host answers with *whether* a key is configured and *where it came from*,
   never with the value. The next **Generate** uses it, no restart needed.

The harness resolves the reference in its own order:

1. the environment the harness was launched with (`FAL_API_KEY=… dsh`) — read-only for the app;
2. the credential store, `~/.dsh/.credentials.yaml`:

   ```yaml
   version: 1
   refs:
     FAL_API_KEY: <key_id>:<key_secret>
   ```

3. `<workspace>/.env`, then `~/.dsh/.env`.

If the key comes from the environment, the card says so and saving from the page is disabled — the environment wins.
The reference name can be changed in the row's configuration with `falKeyRef`, which is useful when a machine keeps its
keys under a different name. The key is read from the store on every call, so rotating it needs no restart.

## Choosing a model — including your own

The picker ships three fal endpoints (see **What you get**). For anything else:

1. Press **＋ Own model** next to the model picker.
2. Paste the fal endpoint slug — the `owner/name` part of the endpoint URL, for example `fal-ai/qwen-image`.
3. Press **Add**. The slug is remembered in the plugin's own settings (`config.json` in the studio folder), appears in
   the picker marked `· custom`, and is selected straight away. Remove it with the **✕** chip; up to 40 slugs are kept.

Only a well-formed `owner/name` slug is accepted — a bare word, a URL or a duplicate of a built-in is ignored rather
than stored, and one bad entry never discards the rest of the list. The plugin does not carry a catalogue of fal
models: it sends the prompt plus the fields the selected family documents, so an endpoint that needs a field this
plugin does not send fails with fal's own error text, which the page shows verbatim.

## Generate on a local ComfyUI

Generation can also run on a **ComfyUI you started yourself**. The plugin downloads nothing — no model weights, no
workflows, no custom nodes. It only talks to a server that is already running, and the default address is
`http://127.0.0.1:8188`.

- **Only a local address is accepted.** It must be `http(s)` on `127.0.0.1`, `localhost` or `::1`, and it is checked when
  the setting is saved **and again before every request**, so a hand-edited profile patch cannot point a generation at
  someone else's machine.
- **From the page:** switch **Provider** to **Local ComfyUI**, edit the address and press **Check connection**. The answer
  reports the server version, its device and VRAM, or the reason it did not answer. The address is the only local setting
  the page writes; the provider toggle itself is per session.
- **Everything else is row configuration:** `localWorkflow` (which graph to run), `localModel`, `localClip`, `localVae`
  (the model file names the graph's placeholders stand for) and `localSteps`.
- **The bundled template** [`workflow/qwen-image.json`](workflow/qwen-image.json) is a standard ComfyUI API-format graph
  with the placeholders `{{prompt}}`, `{{width}}`, `{{height}}`, `{{seed}}`, `{{steps}}`, `{{model}}`, `{{clip}}` and
  `{{vae}}`. The model file names are deliberately left empty — this repository ships no weights and names none. Fill them
  from the settings above, or point `localWorkflow` at a graph you exported from ComfyUI yourself.
- **The bundled graph has not been verified against a live server.** Treat it as a starting point, not as a claim about
  your installation: check the node classes and fill the file names. On a **GGUF** build the loader node becomes
  `UnetLoaderGGUF` instead of `UNETLoader`. A graph the server rejects is reported with ComfyUI's own message.
- **`count > 1` runs sequentially** — one job per image with a different seed — so it takes proportionally longer.
- **The aspect** fills the graph's `width`/`height`: 1:1 → 1024×1024, 4:3 → 1024×768, 3:4 → 768×1024, 16:9 → 1280×720,
  9:16 → 720×1280.
- **No fal key is read on this path.** Results land in the same gallery as any other generation, marked
  `local:<model file>` (`local:comfyui` when no file is set) with the label `ComfyUI · <model file>`, and behave like any
  other entry: view, download, favourite, delete, Animate in Kling.

## Generate from the conversation

On a harness that mounts the tools service and can load `@deepseek-ai/dsh-tools`, the plugin registers one chat tool,
**`image_generate`**. Ask the model for a picture and the result is written into the same library the page shows — the
shared studio or the current project's media, whichever source is selected.

| Parameter | | |
|---|---|---|
| `prompt` | required | What to draw: subject, composition, style, lighting, and any exact text to render. |
| `aspect` | optional | One of `1:1`, `4:3`, `3:4`, `16:9`, `9:16`; defaults to the page's aspect. |
| `count` | optional | How many variations to request (1–8); defaults to the model's or the page's count. |
| `model` | optional | Any fal endpoint slug, e.g. `fal-ai/flux-2/klein/9b`; defaults to the configured model. |

The result carries a one-line summary, the prompt, the model id and label, the aspect, how many images were stored, the
library root, a markdown reference per image, and every saved file with its `id`, `file`, `markdown`, `mime`, `bytes`,
`url` and — when the provider reported them — `width` and `height`.

A failure is a **failed tool call**, not a value: a missing key, an invalid or unknown endpoint (401/404), a timeout, an
empty answer, an argument that is not an `owner/name` slug, or a write error all raise a short human sentence. Those
messages never contain the fal key and never contain this machine's file paths; a full path appears only in a successful
result's markdown link.

The tool runs the same generation code and writes into the same library root as the page — there is no second
implementation — and it is **fal-only**: a local ComfyUI generation is started from the page. It is registered only when
the composition mounts the tools service *and* the package can be loaded; without either, the plugin and the page work as
usual and the tool is simply not offered.

## Import by link

**Gallery → Import by link** → paste a direct link to an image or a video file → **Download**.

The host downloads the link server-side and stores the result in the same gallery as any other entry (the link stays as
its caption). Only links a plugin should fetch are accepted: `http` and `https` only, and loopback, private, link-local
and `.local`/`.internal` hosts are refused, so the route cannot be used as a probe into your own network. Imported media
still has to fit the studio's per-file cap (64 MB).

## Kling image-to-video

Open a still in the lightbox and press **Animate in Kling**:

- the **video model** — Kling v3 Pro image-to-video by default, with Kling v3 Standard text-to-video as the other
  choice (a video entry only offers the text-to-video model, because it has no still to animate);
- a **motion prompt** — what should happen in the shot;
- a **duration** — 3, 5, 8, 10 or 12 seconds (5 by default).

The chosen still is sent to fal as a data URI, so no upload step and no public URL is needed. The job is polled while
Kling renders (bounded by `videoTimeoutMs`, 15 minutes by default, because Kling takes minutes), then the clip lands in
the gallery next to its source image.

## Montage

**Montage** collects clips and stills into a timeline, in the order you arrange them (Up / Down / Remove), then:

- **Frame** — 9:16 (default), 4:5, 1:1 or 16:9;
- **seconds per still** — how long a still is held (3 seconds by default, 30 maximum);
- up to 40 segments per cut.

The host normalizes every segment to the same size, 30 fps, codec and pixel format in a scratch directory, then joins
them with ffmpeg's concat demuxer without re-encoding, and stores the result in the gallery like any other video.
This is a cut, not an editor: no crossfades, music or titles yet. ffmpeg is required and is looked for on `PATH` unless
`ffmpegPath` names a binary; when it is missing, the tab says so instead of offering the action.

## Updating

The plugin updates itself, so nothing has to be removed and reinstalled:

- **Plugins page → the Image Studio card (or the row's Configure) → Updates** asks GitHub for the branch revision,
  shows the version installed next to the version on `main`, lists the recent commits, and hands the pinned commit to
  the harness plugin manager in one click.
- A newer branch also puts an **Update → <version>** button in the page header, next to the counters. When the
  deployment has no plugin manager, the button is disabled and its tooltip prints the manual spec.
- Afterwards reload the page. A browser-half change is live immediately; a host-half change needs an application
  restart, and the section says so when the running version has not moved.
- If the deployment has no plugin manager, the same section prints the spec to paste into **Plugins → Add plugin**:

  ```text
  github:naletko/dsh-image-studio
  ```

The check reads two things and nothing else: `raw.githubusercontent.com/<repo>/main/package.json` and the GitHub commits
API for the plugin's own repository (`updateRepo`, by default `naletko/dsh-image-studio`). The result is cached for five
minutes, and `updateCheck: false` in the row configuration switches the whole feature off. The install spec is built by
the plugin from the configured repository plus a validated commit hash — never from a request — so a hand-crafted call
cannot ask the package manager for something else.

## Where the library lives

The media can live in one of two places. The **Media source** control in the page header chooses which, and the same
choice can be made from configuration with the `library*` keys:

```text
Media source:  Source: Shared studio ▾   Subfolder: ▾   [Apply]   Folder: <the root in use>

librarySource: studio                                  →  <DSH_HOME>/image-studio
librarySource: workspace, libraryWorkspace: /path/to/project, librarySubdir: shots/2026
                                                       →  /path/to/project/dsh-media/shots/2026
```

| Source | Media lives in | Notes |
|---|---|---|
| **Shared studio** (default) | `<DSH_HOME>/image-studio/` | One gallery per machine, independent of any project. |
| **A project** | `<project>/dsh-media[/<subfolder>]` | Created on first use. The subfolder takes up to 3 plain segments, e.g. `shots/2026`. |

Either folder holds the same three things:

```text
gallery.json      the index: one entry per image or video
config.json       non-secret settings (only in the shared studio — see below)
files/<id>.<ext>  the media itself, named from a generated id
```

`<DSH_HOME>` is `$DSH_HOME` or `~/.dsh`; `DSH_IMAGE_STUDIO_HOME` relocates it. The settings file **always** stays at
`<DSH_HOME>/image-studio/config.json`, even when the media points into a project: the switch that points the library
there must not travel with the project, or it could never be pointed back.

A configured project that no longer exists (moved, renamed, deleted) does not break the page — the studio falls back to
the shared folder, and `/state`'s `library.root` says which root actually answered. Switching source does **not** move
existing media: each gallery is a separate folder and the other one is simply not shown.

When the chosen project is a git repository that does not ignore the media folder yet, the page offers the
**Add dsh-media to .gitignore** button; it calls `POST /api/image-studio/gitignore`, which appends `dsh-media/` once and
never writes to a directory that is not a repository.

Nothing in either folder is ever served to another machine: `/api/image-studio/file` answers loopback callers only, and
every path is rebuilt from a validated id, never from a prompt or a remote URL. Both folders are safe to back up or
move: `gallery.json` is the index beside the files it points at.

## Configuration

Row configuration comes from the profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`) or from the bundle row in
[`cordis.patch.yml`](cordis.patch.yml). A patch replaces the whole `config` value of a row instead of merging keys, so
an override must restate every key it needs. The profile patch also wins over what the settings card saved.

| Key | Default | Meaning |
|---|---|---|
| `falKeyRef` | `FAL_API_KEY` | Credential reference holding the fal key. |
| `defaultModel` | `fal-ai/flux-2/klein/9b` | Model preselected on the page. |
| `customModels` | `[]` | Your own fal endpoint slugs, as added with **＋ Own model**. |
| `librarySource` | `studio` | `studio` = the shared `<DSH_HOME>/image-studio`; `workspace` = inside a project. |
| `libraryWorkspace` | empty | Absolute path of an **existing** project directory (used when the source is `workspace`). |
| `librarySubdir` | empty | Relative subfolder inside the project, up to 3 plain segments (e.g. `shots/2026`); `..`, absolute paths and empty segments are ignored. |
| `defaultAspect` | `1:1` | Aspect preselected on the page. |
| `defaultCount` | `1` | Variants preselected on the page (1–8). |
| `imageTimeoutMs` | `240000` | Budget for one text-to-image job. |
| `videoTimeoutMs` | `900000` | Budget for one video job; Kling renders take minutes. |
| `ffmpegPath` | empty | ffmpeg executable for the montage; empty means `ffmpeg` from `PATH`. |
| `updateRepo` | `naletko/dsh-image-studio` | Repository the update check asks (`owner/name`). |
| `updateCheck` | `true` | Whether the page may ask GitHub for a newer revision. |
| `provider` | `fal` | Provider the host reports in `/state` (`fal` or `local`). The page's own **Provider** toggle picks one per session and starts on fal.ai. |
| `localUrl` | `http://127.0.0.1:8188` | Address of your ComfyUI. Only `http(s)` on `127.0.0.1`, `localhost` or `::1` is accepted. |
| `localWorkflow` | the bundled `workflow/qwen-image.json` | API-format graph to run; it must be an existing `.json` file when the configuration is read. |
| `localModel` | empty | The value of `{{model}}` — the UNET (or GGUF) file name inside ComfyUI. |
| `localClip` | empty | The value of `{{clip}}`. |
| `localVae` | empty | The value of `{{vae}}`. |
| `localSteps` | `20` | Sampling steps (`{{steps}}`), rounded and capped at 150. |
| `localTimeoutMs` | `300000` | Budget for one local job. |

## HTTP surface

Everything the page does goes through the plugin's own loopback routes. They exist so the browser half never touches a
provider, a key, or a file path.

| Route | Purpose |
|---|---|
| `GET /state` | Catalogue, defaults, credential status, counters, the resolved library root and the `library` block, the local provider settings, ffmpeg status |
| `GET /workspaces` | The projects the library may point at (`supported: false` when the composition mounts no workspace registry) |
| `GET /local/status` | Probe the configured ComfyUI (`/system_stats`). A server that is off answers `reachable: false` with a reason — that is a normal answer, not an error |
| `GET /gallery?kind=&q=&favorite=` | The filtered index |
| `GET /file?id=` | Media bytes for one entry |
| `POST /credentials` | Store or clear the fal key (write-only) |
| `POST /config` | Non-secret defaults, the custom model list, the library source, and the local provider settings |
| `POST /gitignore` | Append `dsh-media/` to the chosen project's `.gitignore`, once, and only for a git repository → `{ ok, changed }` |
| `POST /generate` | Queue a text-to-image job for `provider: "fal"` (default) or `provider: "local"`, answer `202` with the job |
| `POST /video`, `POST /montage` | Queue a video or montage job, answer `202` with the job |
| `GET /job?id=` | Job status, queue position, produced entries |
| `POST /import` | Download a public `http(s)` link into the gallery |
| `GET /update`, `POST /update/apply` | Ask GitHub for a revision, hand it to the plugin manager |
| `POST /favorite`, `POST /delete` | Housekeeping |

Every route refuses anything that is not a loopback request from a loopback origin, bodies are capped at 256 KB, and
media is only read from paths rebuilt from a validated id.

## Compatibility

| Package | Version |
|---|---|
| `dsh-image-studio` | the version in [package.json](package.json) |
| DSH core | `0.2.0-rc.2`, `0.2.0-rc.1` — see [compatibility.json](compatibility.json) |
| Node | `^22.19.0 \|\| >=24.0.0` |
| React (supplied by the harness) | `^18.2.0` |
| `@deepseek-ai/cordis` | `4.0.1`–`4.0.4` |
| `@deepseek-ai/dsh-client-ui-layout`, `…-sidebar` | `0.2.0-rc.2`, `0.2.0-rc.1`, `0.1.7-rc.2` |
| `@deepseek-ai/dsh-client-ui-sidebar-right` | `0.2.0-rc.2`, `0.2.0-rc.1` |
| `@deepseek-ai/dsh-tools` (for the chat tool) | `0.2.0-rc.2`, `0.2.0-rc.1` |

Windows and macOS are both supported: no platform-specific code, no native modules and no build step — the browser half
is a plain script the harness loads itself, and the only external program is ffmpeg for the montage.

## Tests

```sh
npm run check                  # syntax, every file
node test/catalog-check.mjs    # request shaping for each model family
node test/fal-check.mjs        # the fal queue client against a scripted queue
node test/gallery-check.mjs    # index, path confinement, pruning
node test/montage-check.mjs    # ffmpeg command planning, plus a real assembly when ffmpeg can run
node test/host-check.mjs       # the HTTP surface end to end, fake credentials and a fake queue
node test/local-check.mjs      # the ComfyUI client: the address guard, graph filling, queue/history/view against a scripted server
node test/metadata-check.mjs   # the browser half's module and slot registrations
node test/render-check.mjs     # every component rendered with real data, effects inert
node test/portability-check.mjs # the cross-platform claim: no shell, no platform branch, no hardcoded separator
node test/update-check.mjs     # version comparison and the install-spec rules
node test/manifest-check.mjs   # the bundle contract the harness reads
```

`node --test test/` spawns a child process per file, which some sandboxes refuse; running the files directly always
works, and that is what CI does.

## Known limits

- **fal.ai and a local ComfyUI are the two providers.** Video, the montage and the chat tool are fal-side; a third
  gateway would mean another module beside `lib/fal.js`.
- **The bundled ComfyUI graph is unverified.** It has never been run against a live server here: check its node classes,
  fill the model file names, and swap node 1 for `UnetLoaderGGUF` on a GGUF build. The local path is text-to-image only —
  it runs the graph you configure.
- **The plugin ships no weights.** The local path downloads nothing and does not know any model file name of its own;
  whatever your server already has is what it runs.
- **`count > 1` locally is sequential.** One job per image with a different seed, so it takes proportionally longer.
- **`image_generate` needs fal and the tools service.** It is fal-only and requires a stored key; without the tools
  service or the `@deepseek-ai/dsh-tools` package it is simply not registered.
- **No reference-image input yet.** Image-to-image and character consistency are not exposed on the page, although fal's
  edit endpoints exist.
- **Custom endpoints get the documented field set.** A custom slug is driven with the same request shape as a built-in
  family, so an endpoint that needs extra fields has to reject the call; the page shows fal's error.
- **Import takes public direct links only.** Local-network and non-`http(s)` links are refused by design. Point it at
  the file itself: the host stores the bytes it downloads and labels them by the response's content type, so a link to
  an HTML page produces a useless entry rather than an error.
- **Jobs live in memory.** A generation survives page reloads but not a harness restart; the media already written is
  kept either way.
- **The gallery is per machine.** It is a folder, not a sync service.
- **Switching the library does not migrate media.** Each source is its own folder: existing files stay where they were
  written and the other gallery is simply not shown until you switch back.
- **The montage is a cut, not an edit.** Segments join in order at the same size and frame rate; there are no
  crossfades, no music track and no titles yet. It needs ffmpeg on the machine.
- **Video is not visible to the model.** The harness content vocabulary has no video block, so the model learns a file
  path; images are returned to the conversation as attachments by the plugins that generate them, not by this page.

## Privacy

**What leaves the machine.** On the **fal** path, only what fal needs to render: your prompt, the generation settings for
the chosen model, and — for image-to-video — the still you picked, sent as a data URI. Those go to `queue.fal.run` over
HTTPS with your key in the `Authorization` header. fal's own terms and privacy policy apply to that traffic. The
`image_generate` chat tool uses this same path, so its prompt goes to fal too.

**On the local path, nothing leaves the machine.** The ComfyUI provider talks only to the loopback address you
configured, reads no fal key, and writes the result into the same library. That traffic belongs to your own server.

**What stays local.** The chosen library folder — media, prompts, the index — and the non-secret settings, which always
stay in `<DSH_HOME>/image-studio`. The key sits in the harness credential store (or the launching environment) and is
read per call. The plugin sends no telemetry, has no account of its own, and does not talk to any other server. If the
library points into a project, those files are the project's own: they still never leave the machine, but they will be
committed to the repository unless `dsh-media/` is ignored — which is what the page's **Add dsh-media to .gitignore**
button (and the `POST /api/image-studio/gitignore` route behind it) is for.

The only other network calls it can make are:

- the **update check**, which reads the plugin's own repository from `raw.githubusercontent.com` and `api.github.com`
  (switch it off with `updateCheck: false`);
- the **import** you ask for, which fetches exactly the `http(s)` link you pasted, server-side.

The key is never logged, echoed, returned to the page, or written into a configuration file.

## License

MIT © 2026 Alex Naletko. See [LICENSE](LICENSE).

For the same guide written for an agent that installs and verifies plugins, see [AGENTS.md](AGENTS.md).
