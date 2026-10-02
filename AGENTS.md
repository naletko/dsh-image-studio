# Agent installation guide

Use this guide when someone asks you to install, update, verify, or remove `dsh-image-studio` in a DeepSeek Harness
profile. Current release: **dsh-image-studio@0.4.0**, qualified against DSH cores **0.2.0-rc.2** and **0.2.0-rc.1**.

## Safety

- Confirm the target installation and the profile before touching anything.
- Install the exact requested version; never a moving branch.
- **Never print, echo, log, or commit the fal key.** If a key is needed, tell the person to paste it into the plugin's
  settings card; do not ask for it in a message, do not write it into `cordis.patch.yml`, and do not `cat`
  `~/.dsh/.credentials.yaml` into a transcript.
- Preserve conversations, attachments, other plugins, settings, and credentials.
- Do not start, stop, or restart the harness without permission.

## Install

**Plugins page (works while the application is running, and the only path for the `desktop` profile):**

1. Open **Plugins → Add plugin**.
2. Paste one of these and install:
   ```text
   dsh-image-studio
   github:naletko/dsh-image-studio
   /absolute/path/to/dsh-image-studio
   ```
3. Restart the harness only if the page asks for it. The sidebar should then show an **Images** entry.

**Terminal (profile not owned by the desktop app, or after the app is fully quit):**

```sh
dsh plugin --profile web add dsh-image-studio
dsh plugin --profile desktop add dsh-image-studio   # only with DSH Desktop fully closed
dsh --profile web --dump-config                      # compose the tree without booting
```

The `desktop` profile is managed exclusively by the Electron application: while the app runs, `dsh plugin --profile
desktop …` is refused. Use the Plugins page there.

## Configure the fal key

The key is a credential reference (default `FAL_API_KEY`), never a configuration value. Two supported routes:

1. **Settings → Plugins → Images (fal.ai)** — paste `key_id:key_secret` and press Save. The plugin writes it through
   `ctx.credentials`; the value is never returned to the page and never written into a config file.
2. Edit `~/.dsh/.credentials.yaml` directly (the store reloads on change, no restart needed):
   ```yaml
   version: 1
   refs:
     FAL_API_KEY: <key_id>:<key_secret>
   ```
   `FAL_API_KEY` in the launching environment wins over the file, and is read-only for the app.

The reference name can be changed with `falKeyRef` in the row configuration when a machine stores its keys under a
different name.

## Choose where the library lives

The gallery is not pinned to the shared studio any more: it can live inside a project, beside the code it belongs to.
`GET /api/image-studio/state` reports a `library` block (`source`, `workspaces`, `workspace`, `subdir`, `root`, `git`,
`ignored`), and the page's library control writes the same keys through `POST /api/image-studio/config`.

| Key | Accepts | Default |
|---|---|---|
| `librarySource` | `studio` (the shared `<DSH_HOME>/image-studio`) or `workspace` (inside a project) | `studio` |
| `libraryWorkspace` | absolute path of an **existing** project directory | empty |
| `librarySubdir` | relative path of at most 3 plain segments, e.g. `shots/2026`; no `..`, absolute path, or empty segment | empty |

With `source: workspace` the media lives in `<libraryWorkspace>/dsh-media[/<librarySubdir>]`, created on first use.
The settings file (`config.json`) always stays in `<DSH_HOME>/image-studio`, so the switch that points the library at
a project is never stored inside that project. A configured project that no longer exists falls back to the shared
studio instead of failing every route; the `root` field says which one answered.

Routes an operator may use directly:

- `GET /api/image-studio/workspaces` — the project list from `ctx.workspaceRegistry`, mapped to `{ name, dir }`
  (`supported: false` when the composition mounts no registry).
- `POST /api/image-studio/gitignore` — idempotently appends `dsh-media/` to `<libraryWorkspace>/.gitignore`, and only
  when `<libraryWorkspace>/.git` exists. Answers `{ ok, changed }`; a folder that is not a git repository is never
  written to.

Every route resolves the root on the request, so switching source needs no restart. A project library is the person's
own files: never move, rewrite, or delete one unless they asked for it.

## Verify

```sh
node --check index.js && node --check client.js && node --check lib/library.js
node test/catalog-check.mjs
node test/fal-check.mjs
node test/gallery-check.mjs
node test/montage-check.mjs
node test/host-check.mjs
node test/metadata-check.mjs
node test/render-check.mjs
node test/manifest-check.mjs
```

(`node --test test/` spawns a child per file, which some sandboxes refuse; running the files directly always works.)

In a live session, with permission:

1. Ask for **Plugins → Add plugin** with the folder path and confirm the **Images** entry appears.
2. Ask the person to open **Images**, generate one image with their key, and confirm it appears in the gallery.
3. Confirm `/api/image-studio/state` answers on loopback and that no response body contains the key.
4. Only if they want it: select a still and press **Animate in Kling**, then **Montage** to assemble a cut.

Do not spend the person's fal credits without asking first.

## Update

The plugin can update itself: **Settings → Plugins → Image Studio** has an **Updates** section that asks GitHub for the
branch revision, shows what changed, and hands the pinned commit to the harness plugin manager (`ctx.pluginManager`).
A newer branch also surfaces a button in the page header. Prefer that over reinstalling by hand, and ask the person to
reload the page afterwards — a host-half change needs an application restart, which the section says too.

Terminal equivalent, when the profile is not owned by the desktop app:

```sh
dsh plugin --profile web remove dsh-image-studio
dsh plugin --profile web add github:naletko/dsh-image-studio
```

## Uninstall

```sh
dsh plugin --profile web remove dsh-image-studio
```

Removing the plugin must preserve the gallery (`<DSH_HOME>/image-studio`), any project library (`<project>/dsh-media`),
credentials, sessions, settings, and other plugins. Media is deliberately left in place; delete a folder only when the
person asks for it.

## Failure handling

Keep the causes separate, and report which one you proved:

- **The bundle did not load** — the patch row or the package name is wrong; check `cordis.patch.yml` against
  `package.json` (`dsh.bundle.patch`, and the row `name` equal to the package name).
- **The page is missing but the plugin loaded** — the browser half did not apply: check the client console for the
  module id `dsh-image-studio`, and that `dsh.client.platform` is `web`.
- **No images appear** — the key is unset (the page says so), the account has no fal credit, or fal rejected the
  parameters; read the job's own error text from `/api/image-studio/job?id=…` rather than guessing.
- **Montage says ffmpeg is missing** — install ffmpeg, or set `ffmpegPath` in the row configuration.
- **A project library looks empty** — read the `library` block of `/api/image-studio/state`: `source`, `workspace`,
  `root`, `git`. A project that was moved or renamed no longer validates, so the studio falls back to the shared one;
  `/api/image-studio/workspaces` shows what the registry still knows.
- **Garbled media, mixed sizes** — a segment normalized from an unusual source; check `gallery.json` for the entry and
  re-run with that segment removed.

Do not patch files inside an installed DSH, disable browser security, or upload anyone's media to reproduce a problem.
