# dsh-image-studio

An **Images** workspace for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): one page to generate with
[fal.ai](https://fal.ai), browse every result you have ever produced, compare candidates, and hand the winner to Kling as
an image-to-video shot.

```text
Images
┌──────────────────────────────────────────────────────────────────────┐
│ Describe an image…                                                   │
│  Model: GPT Image 2 ▾   Aspect: 9:16 ▾   Variants: 4 ▾   [Generate]  │
├──────────────────────────────────────────────────────────────────────┤
│  Gallery | Templates          All · Images · Videos · Favourites     │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐                        │
│  │  🖼     │ │  🖼     │ │  🎬 5s │ │  🖼     │   click → lightbox     │
│  └────────┘ └────────┘ └────────┘ └────────┘   → Animate in Kling     │
└──────────────────────────────────────────────────────────────────────┘
```

## What you get

- **A real page, not a chat message.** The sidebar gains an **Images** entry; the page holds a prompt bar, the model and
  aspect pickers, a variant count up to 8, and the gallery underneath.
- **fal.ai underneath.** Three text-to-image families are wired with the field names fal's own OpenAPI documents
  declare: `fal-ai/flux-2/klein/9b` (fast exploration), `openai/gpt-image-2` (quality tier, text rendering),
  `fal-ai/nano-banana-2` (Gemini, reference editing, 0.5K–4K). Any other fal slug containing `/` is accepted as a
  custom endpoint.
- **Everything you ever generated is still there.** Results land in a studio folder on disk and an index beside them, so
  browsing costs nothing, survives a restart, and works while the provider is down. Favourites, search, and per-kind
  filters narrow the grid.
- **A lightbox that is actually useful.** Judge the picture at full size, download the original, copy the prompt, mark it
  a favourite, or press **Animate in Kling** to turn that exact still into a shot — Kling v3 Pro image-to-video, with a
  motion prompt and a duration you choose.
- **A montage tab.** Pick clips and stills into a timeline, choose 9:16 / 4:5 / 1:1 / 16:9, and the host assembles
  them into one h264 file with ffmpeg — every segment normalized to the same size, frame rate, and pixel format first,
  then joined without re-encoding. Stills become clips by looping them for the hold time you choose.
- **Templates.** Eight starter prompts (product hero, lifestyle, UGC selfie, flat lay, before/after, seasonal,
  character sheet, food close-up) in Russian and English. A template only fills the prompt box; nothing is spent until
  you press Generate.
- **Bilingual UI.** Russian and English, chosen from the interface language.
- **The key never leaves the credential store.** The settings card writes the fal key through the harness credential
  seam; the host never returns a value to the page and never writes a secret into configuration.

## Install

### From the Plugins page (recommended)

1. Open **Plugins → Add plugin**.
2. Paste either the package name once published, or the absolute path to this folder:

   ```text
   dsh-image-studio
   C:\Users\you\Documents\deepseek-harness\dsh-image-studio
   ```

3. Install, then restart the harness if the page asks for it.

### From a terminal

```sh
dsh plugin --profile web add dsh-image-studio      # web profile
dsh plugin --profile desktop add dsh-image-studio  # only while DSH Desktop is fully quit
```

The `desktop` profile belongs to the DSH Desktop application: it refuses terminal management while the app is running,
so use **Plugins → Add plugin** there. Afterwards the sidebar shows **Images**.

## Where the API key is stored

The key is a *credential reference*, never a configuration value. The default reference is `FAL_API_KEY`, and the
resolution order is the harness's own:

1. the environment the harness was launched with (`FAL_API_KEY=… dsh`) — read-only for the app;
2. the credential store, `~/.dsh/.credentials.yaml`:

   ```yaml
   version: 1
   refs:
     FAL_API_KEY: <key_id>:<key_secret>
   ```

3. `<workspace>/.env`, then `~/.dsh/.env`.

The easiest path is the card in **Settings → Plugins → Images (fal.ai)**: paste `key_id:key_secret` (the whole string
from fal.ai → Keys), press Save. The card shows whether a key is configured and where it comes from — never the value.
Once stored, the next Generate uses it; no restart is needed.

The reference name can be changed in the row's configuration (`falKeyRef`), which is useful when a machine keeps its
keys under a different name.

## Where files live

```text
<DSH_HOME>/image-studio/
  gallery.json     the index: one entry per image or video
  config.json      non-secret defaults (model, aspect, variants)
  files/<id>.png   the media itself, named from a generated id
```

`<DSH_HOME>` is `$DSH_HOME` or `~/.dsh`. Set `DSH_IMAGE_STUDIO_HOME` to put the studio somewhere else — useful when the
gallery should live on a bigger disk or be backed up separately. Nothing in that folder is ever served to another
machine: `/api/image-studio/file` answers loopback callers only, and every path is built from a validated id.

## Configuration

Row configuration from the profile patch (`~/.dsh/profiles/<profile>/cordis.patch.yml`):

| Key | Default | Meaning |
|---|---|---|
| `falKeyRef` | `FAL_API_KEY` | Credential reference holding the fal key. |
| `defaultModel` | `fal-ai/flux-2/klein/9b` | Model preselected on the page. |
| `defaultAspect` | `1:1` | Aspect preselected on the page. |
| `defaultCount` | `1` | Variants preselected on the page. |
| `imageTimeoutMs` | `240000` | Budget for one text-to-image job. |
| `videoTimeoutMs` | `900000` | Budget for one video job; Kling renders take minutes. |
| `ffmpegPath` | empty | ffmpeg executable for the montage; empty means `ffmpeg` from `PATH`. |

## HTTP surface

Everything the page does goes through the plugin's own loopback routes. They exist so the browser half never touches a
provider, a key, or a file path.

| Route | Purpose |
|---|---|
| `GET /state` | Catalogue, defaults, credential status, counters, studio path |
| `GET /gallery?kind=&q=&favorite=` | The filtered index |
| `GET /file?id=` | Media bytes for one entry |
| `POST /credentials` | Store or clear the fal key (write-only) |
| `POST /config` | Non-secret defaults |
| `POST /generate`, `POST /video`, `POST /montage` | Queue a job, answer `202` with the job |
| `GET /job?id=` | Job status, queue position, produced entries |
| `POST /favorite`, `POST /delete` | Housekeeping |

Every route refuses anything that is not a loopback request from a loopback origin, bodies are capped at 256 KB, and
media is only read from paths rebuilt from a validated id.

## Compatibility

| Package | Version |
|---|---|
| `dsh-image-studio` | 0.1.0 |
| DSH core | `0.2.0-rc.2`, `0.2.0-rc.1` (`compatibility.json`) |
| Node | `^22.19.0 \|\| >=24.0.0` |

Windows and macOS are both supported: no platform-specific code, no shelling out, no native modules, no build step — the
browser half is a plain script the harness loads itself.

## Tests

```sh
npm run check                  # syntax, every file
node test/catalog-check.mjs    # request shaping for each model family
node test/fal-check.mjs        # the fal queue client against a scripted queue
node test/gallery-check.mjs    # index, path confinement, pruning
node test/montage-check.mjs    # ffmpeg command planning, plus a real assembly when ffmpeg can run
node test/host-check.mjs       # the HTTP surface end to end, fake credentials and a fake queue
node test/metadata-check.mjs   # the browser half's module and slot registrations
node test/render-check.mjs     # every component rendered with real data, effects inert
node test/manifest-check.mjs   # the bundle contract the harness reads
```

`node --test test/` spawns a child process per file, which some sandboxes refuse; running the files directly always
works.

## Known limits

- **fal.ai only.** The provider seam is one client; adding another gateway means another module beside `lib/fal.js`.
- **No reference-image input yet.** Image-to-image and character consistency are not exposed on the page, although the
  edit endpoints exist on fal.
- **Jobs live in memory.** A generation survives page reloads but not a harness restart; the media already written is
  kept either way.
- **The gallery is per machine.** It is a folder, not a sync service.
- **The montage is a cut, not an edit.** Segments join in order at the same size and frame rate; there are no
  crossfades, no music track, no titles yet. It needs `ffmpeg` on the machine, and the tab says so when it is missing.
- **Video is not visible to the model.** The harness content vocabulary has no video block, so the model learns a file
  path; images are returned to the conversation as attachments by the plugins that generate them, not by this page.

## Privacy

The plugin talks to fal.ai and to nothing else. Prompts, media, and the key stay on the machine; the key is read from
the harness credential store per call and never logged, echoed, or written into a configuration file.

## License

MIT © 2026 Alex Naletko.
