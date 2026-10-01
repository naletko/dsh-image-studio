# Agent installation guide

Use this guide when someone asks you to install, update, verify, or remove `dsh-image-studio` in a DeepSeek Harness
profile. Current release: **dsh-image-studio@0.1.0**, qualified against DSH cores **0.2.0-rc.2** and **0.2.0-rc.1**.

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

## Verify

```sh
node --check index.js && node --check client.js
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

There is no automatic update. Uninstall and install again, or install a newer spec:

```sh
dsh plugin --profile web remove dsh-image-studio
dsh plugin --profile web add dsh-image-studio@0.2.0
```

## Uninstall

```sh
dsh plugin --profile web remove dsh-image-studio
```

Removing the plugin must preserve the gallery (`<DSH_HOME>/image-studio`), credentials, sessions, settings, and other
plugins. Media is deliberately left in place; delete that folder only when the person asks for it.

## Failure handling

Keep the causes separate, and report which one you proved:

- **The bundle did not load** — the patch row or the package name is wrong; check `cordis.patch.yml` against
  `package.json` (`dsh.bundle.patch`, and the row `name` equal to the package name).
- **The page is missing but the plugin loaded** — the browser half did not apply: check the client console for the
  module id `dsh-image-studio`, and that `dsh.client.platform` is `web`.
- **No images appear** — the key is unset (the page says so), the account has no fal credit, or fal rejected the
  parameters; read the job's own error text from `/api/image-studio/job?id=…` rather than guessing.
- **Montage says ffmpeg is missing** — install ffmpeg, or set `ffmpegPath` in the row configuration.
- **Garbled media, mixed sizes** — a segment normalized from an unusual source; check `gallery.json` for the entry and
  re-run with that segment removed.

Do not patch files inside an installed DSH, disable browser security, or upload anyone's media to reproduce a problem.
