# JCad Electrical: security review of the Electron shell and file parsers

Date: 2026-10-11. The original read-only findings are preserved below; the current remediation
status and practical limits are listed in [Status](#status-after-the-2026-10-11-remediation).
The experimental 3D modelling track (WebAssembly kernel worker, 3D file payload) is reviewed
separately at the end: [Experimental 3D track](#experimental-3d-track), findings E-19 to E-24.

## Scope

| Tree | Commit | What was read |
| --- | --- | --- |
| Merged tree (R1 + R3 + R2) | `f35faa8` | `electron/main.cjs`, `preload.cjs`, `atomic-write.cjs`, `autosave-store.cjs`, `updater.cjs`, `index.html` (CSP), `src/app/plugins.ts`, `src/app/api.ts`, `src/io/dxf.ts`, `src/render/images.ts`, `src/electrical/packs.ts`, `scripts/dwg-reader.mjs`, and every `innerHTML` / `insertAdjacentHTML` sink under `src/` |
| R4 hardening track (engineering quality and release gates) | `ecbdad3` | `electron/ipc-guard.cjs`, `electron/dwg-host.cjs`, and `electron/main.cjs` / `preload.cjs` / `src/app/plugins.ts` diffed against the merged tree |

File:line references are tagged **M** (merged tree `f35faa8`) or **R4** (`ecbdad3`); the line
numbers refer to those commits, not to the tree this document now ships in. The review was written
before R4 was merged; what has been fixed since is listed under [Status](#status).

### Threat model

1. A malicious drawing (DXF, DWG), project file (`*.jcadproj.json`) or catalog pack opened by the user.
2. A malicious plugin (code the user agreed to load) or catalog pack.
3. A compromised renderer: script running in the application page through injected file-derived
   text, or a Chromium bug reached through file content (images).
4. A local unprivileged user who can write to a folder the victim opens drawings from (a shared
   project folder on a multi-user workstation or a network share), but not to the victim's home.

## Original review summary

| Severity | Count | Findings |
| --- | --- | --- |
| Critical | 0 | |
| High | 2 | E-1 renderer / file content can extend the write allow list to arbitrary paths; E-2 Electron 33 is out of support |
| Medium | 6 | E-3 `$CANNOSCALE` HTML injection; E-4 IMAGE path handling; E-5 writes follow symbolic links; E-6 ReDoS in the DXF tokenizer; E-7 DWG parser placement / limits; E-8 update authenticity |
| Low | 7 | E-9 `open-external` allow-list escape; E-10 plugin trust model; E-11 no IPC sender check in M; E-12 no permission handlers; E-13 no expansion budget for nested blocks; E-14 `modal()` title is raw HTML; E-15 hardening gaps |
| Info | 3 | E-16 problem report pre-fills local paths; E-17 pack key lookup on a plain object; E-18 unbounded plot page size |

Fix order: E-1, E-2, then E-3 / E-14, then E-4.

## Status after the 2026-10-11 remediation

The findings below preserve the original review and its historical commit/line references.
This table describes the current implementation. A local audit of the updated complete dependency
lockfile reported zero vulnerabilities. Signed installer verification passed on the earlier
PR head `d0ff078`; the integrated version must pass the same exact-commit CI gates before merge.

| Finding | Severity | Current status |
| --- | --- | --- |
| E-1 renderer can extend file write grants | High | Fixed: the main process records native dialog, OS hand-over and native Recent project selection. Renderer `userChosen` claims are ignored. Project content can grant drawings outside its folder only through that native selection; catalog JSON remains read-only. Write channels restrict extensions. |
| E-2 unsupported Electron | High | Updated to Electron 44.7.0; full dependency audit after compatible tooling updates and the scoped proxy override reports zero vulnerabilities. |
| E-3 annotation scale HTML injection | Medium | Fixed: plain scale names and escaped display. |
| E-4 IMAGE path handling | Medium | Hardened: folder access comes from opened drawings rather than arbitrary known files; actual link targets are checked against canonical drawing folders, including Windows short/long aliases; network references cannot change servers. Explicit image references in opened drawings remain allowed. |
| E-5 writes follow links | Medium | Hardened: atomic writes reject symlink/junction destinations and use exclusive temporary files with rename-only replacement. Preexisting linked parent folders are allowed after canonical resolution, while aliases, canonical parent identities and project write-root containment are rechecked before replacement. Node lacks portable descriptor-relative rename, so a hostile process can still race the final check. |
| E-6 DXF tokenizer ReDoS | Medium | Fixed: bounded source text and linear line parsing; malformed group codes fail with bounded diagnostics. |
| E-7 DWG parser limits | Medium | Desktop parses each read in a fresh Electron utility process containing a V8-limited worker (512/64/8 MiB old/young/stack), with no main-process fallback. Before LibreDWG starts, the parent confirms OS memory monitoring. Its 100 ms watchdog stops the utility at a sampled 3 GiB resident/peak or Windows private-memory threshold; this is not an instantaneous OS allocation cap. The shipped WASM memory declaration is restricted before instantiation to an engine-enforced 2 GiB maximum, including initial allocation and direct WASM growth. Inputs and combined active/queued reservations are capped at 128 MiB, at most four requests are accepted, and results are limited to 64 MiB through acknowledged 1 MiB frames. Cancellation, failure and completion release the process before the next starts. Startup remains 15 s and parsing 60 s + input MiB, at most 188 s for accepted input. Browser parsing retains its 128 MiB/60 s worker policy without an explicit heap/WASM cap. See [DWG memory containment](DWG-MEMORY-CONTAINMENT.md). |
| E-8 update authenticity | Medium | In-place updates require trusted packaged Windows publisher configuration. The application rechecks SHA-512 against release metadata and the Windows publisher immediately after download and before explicit Restart Now, after the unsaved-work check. Ordinary quitting never installs an update, and failed checks refuse installation. Unsigned Windows and all Linux/macOS builds offer manual downloads. macOS release metadata filters incompatible system versions. CI verifies configured signatures and records actual status. |
| E-9 external URL allowlist escape | Low | Fixed: parsed scheme, host and path checks reject user information, ports, encoded separators and traversal. |
| E-10 plugin trust model | Low | Persisted trust requires a 64-hex SHA-256 digest; weak fallback approval lasts only the current run. Plugins remain explicitly trusted code with full renderer access, not capability-isolated extensions. |
| E-11 IPC caller identity | Low | Fixed: every registered channel checks main window, top frame and application URL. |
| E-12 permissions | Low | Fixed: default deny, except sanitized clipboard writes from the main application contents. Every web contents, including hidden print/plot windows, refuses navigation, popups and webviews; the one-use legacy-preference migration helper has its own constant-content policy. |
| E-13 nested block expansion | Low | Fixed: at most 100,000 work units per insert, 1,000,000 total expanded model/layout units and a separate 1,000,000-unit limit for block definitions. Imports, edits, undo/history restoration, library changes and background project tabs validate candidates before accepting them. Accepted plain-data snapshots are sealed at runtime; mutable input identities are never sufficient for cache reuse. |
| E-14 modal title HTML | Low | Fixed: title text is assigned as text. |
| E-15 renderer hardening | Low | Secure `jcad://app/index.html` origin, tighter CSP and packaging fuses. Run-as-Node, NODE_OPTIONS, command-line inspection and extra file protocol privileges are disabled; ASAR-only loading and integrity validation are enabled. Production also rejects inspect/remote-debugging arguments. Full Playwright tests use a separate unpublished test ASAR; exact shipping binaries use bounded startup/save/restart probes and binary fuse verification. |
| E-16 report privacy | Info | Fixed: paths/drawing names are redacted by default; history, captured errors and private details are unchecked until the user opts in. |
| E-17 inherited pack key lookup | Info | Fixed: own-property key lookup before Ed25519 verification. |
| E-18 oversized paper | Info | Fixed: print dimensions must be positive, finite and at most 200 inches. |

The production renderer has sandbox, context isolation and web security enabled. A controlled,
hidden window reads legacy file-origin preferences once, using constant CSP-restricted HTML,
without application scripts, plugins or preload; the helper temporarily disables web security to
read the old storage after the file-privilege fuse is disabled. It refuses navigation and popups
and is destroyed before the application starts. Failure does not execute the old application.

Desktop settings have an atomic, bounded 8 MiB checkpoint in the private user-data directory.
The main process captures only its healthy built application page through an isolated-world
script, accepts string dictionaries and provides no renderer-selected file path. Captures and
commits are queued before acknowledging migration or an approved close; the migration marker
cannot outrun the checkpoint. Empty lost DOM storage can recover the latest complete dictionary,
including deletions. Existing DOM values remain authoritative; an unreadable checkpoint never
revives legacy values. Update installation retains signature verification after Save All and
then requires a final checkpoint; its failure cancels the restart.

Drawing reads are capped at 128 MiB, project JSON at 8 MiB and image files at 50 MiB. Desktop DWG
also has an engine-enforced limit on its sole WASM linear memory and a sampled parent-side process
memory watchdog. The watchdog cannot prevent a transient allocation between samples or guarantee
that a low-memory computer never encounters system-wide pressure. The Node utility is process
isolation for crash/resource recovery, not an OS capability sandbox. Trusted plugins retain renderer
and exposed bridge authority; capability isolation would be a separate product/API change.

Windows DWG export uses a separate native Rust helper with a verified 1 GiB Windows Job Object
process-memory limit applied before parsing. Its absolute executable path and dependency files
must match hashes inside the protected ASAR; publisher signing occurs before sealing those
hashes. The renderer cannot choose the executable or its arguments. A fresh private workspace,
128 MiB input/output ceilings, record/collection limits, bounded diagnostics and a deadline
contain each conversion. A stop must be acknowledged before cleanup or another export; an
unconfirmed stop disables further export until restart. Only native-selected DWG destinations
can be written. Parent/file identity is rechecked before atomic commit, and unsupported content
or verification errors never authorize output. This process isolation is not an OS permissions
sandbox; the helper's memory limit does not cap total application or system memory.

---

## Findings

### E-1 (High). Renderer and file content can extend the write allow list to arbitrary paths

**Where**
- M `electron/main.cjs:420-458` (`open-project`): a known path is opened as a project whatever its
  extension (`:431`); `entryPath` (`:444-448`) accepts absolute paths and `..`; each
  `drawings[].file` ending in `.dxf` / `.dwg` (`:449-454`) and `settings.catalogFile` ending in
  `.json` (`:455-456`) is added to the *known* (writable) set.
- M `electron/main.cjs:602-620` (`save-dxf`): `isKnownPath(existingPath)` (`:604`) is the only
  gate; no extension check, any text is written.
- M `electron/main.cjs:493-500` (`save-project`): any known path ending in `.json`.
- M `electron/main.cjs:58-64`: known paths persist to `recent.json` and stay writable in later sessions.
- R4 `electron/main.cjs:421`: every `drawings[].file`, any extension, is registered; `:550-563`
  `save-dxf` writes with `fs.writeFile` to any known path with no extension check.

**Impact**: a script in the page (a plugin the user accepted, or an injection per E-3 / E-14) can
mark a file it does not own as writable and then overwrite it. The chain: write a crafted
"project" to a file already known (step 1), open it so its `drawings[].file` /
`settings.catalogFile` entries — which may be absolute or use `..` — join the writable set
(step 2), then write to one of those paths (step 3). Reachable targets include any `.json` the
user can write (tool/editor settings that define commands, `package.json` scripts) and any
`.dxf` / `.dwg`. With R4's extension-free `save-dxf`, step 3 can target a file an OS mechanism
executes later. Even with no renderer compromise, a malicious project file alone makes absolute
paths outside the project folder writable by the project-wide "rewrite every drawing" commands.

**Fix**: split "readable by name" from "writable", tie each write channel to its own extension,
and never let file *content* grant write access outside the project's own folder.

```diff
--- a/electron/main.cjs
+++ b/electron/main.cjs
@@
+/** Paths that may be read by name but not written (a project's catalog, drawings outside its folder). */
+const readOnlyKeys = new Set();
+function rememberReadOnly(p) { const k = pathKey(p); if (k !== null) readOnlyKeys.add(k); }
+function isWritablePath(p) { const k = pathKey(p); return k !== null && knownKeys.has(k) && !readOnlyKeys.has(k); }
@@ ipcMain.handle('open-project', ...)
-  } else if (!isKnownPath(file)) throw new Error('Unknown file path');
+  } else if (!/\.json$/i.test(file) || !isKnownPath(file)) throw new Error('Unknown file path');
@@
-      if (p && /\.(dxf|dwg)$/i.test(p)) rememberPath(p);
+      if (!p || !/\.(dxf|dwg)$/i.test(p)) continue;
+      const rel = path.relative(dir, p);
+      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) rememberPath(p);
+      else { rememberPath(p); rememberReadOnly(p); }   // outside the project folder: read-only
@@
-  if (catalog && /\.json$/i.test(catalog)) rememberPath(catalog);
+  if (catalog && /\.json$/i.test(catalog)) { rememberPath(catalog); rememberReadOnly(catalog); }
@@ ipcMain.handle('save-project', ...)
-  if (typeof file !== 'string' || !/\.json$/i.test(file) || !isKnownPath(file)) throw new Error('Unknown project path');
+  if (typeof file !== 'string' || !/\.jcadproj\.json$/i.test(file) || !isWritablePath(file)) throw new Error('Unknown project path');
@@ ipcMain.handle('save-dxf', ...)
-  let target = isKnownPath(existingPath) ? existingPath : null;
+  let target = typeof existingPath === 'string' && /\.dxf$/i.test(existingPath) && isWritablePath(existingPath) ? existingPath : null;
```

A save/open dialog that returns a path should clear its `readOnlyKeys` entry. Apply the same
`isWritablePath` + extension rule to `backup-file`. Consider not persisting write permission
across sessions at all (persist the recent list for reading; re-grant writing when the file is
opened again this session).

---

### E-2 (High). Electron 33.4.11 is past end of support (both JCad products)

**Where**: `package.json` `devDependencies.electron: ^33.2.0`, installed `33.4.11`.

Electron maintains only the three newest stable majors, so 33 no longer receives Chromium, V8,
Skia or image-codec fixes. File content reaches those components directly: `read-image`
(M `main.cjs:724-738`) hands the bytes of any `.png/.jpg/.gif/.bmp/.webp` named by a drawing's
IMAGEDEF to `createImageBitmap` (`src/render/images.ts:84-99`). A decoder bug fixed in a newer
Chromium turns opening a drawing into renderer code execution, which E-1 escalates to the user.

**Fix**: move to a currently supported Electron major and add a Dependabot / Renovate rule. The
APIs used here (`printToPDF` page sizes, `webUtils`) are stable across recent majors; re-run the
e2e suite after the bump.

---

### E-3 (Medium). `$CANNOSCALE` from a DXF reaches the status bar as HTML

**Where**: M `src/io/dxf.ts:2765` stores the raw header value; `src/ui/layouts.ts:256-258`
returns it; `src/ui/statusbar.ts:396` interpolates it into `this.annoEl.innerHTML` without
`esc()`. The DXF writer re-emits it (`src/io/dxf-layouts.ts:98`), so it survives a round trip.

**Impact**: a drawing whose `$CANNOSCALE` header contains HTML markup injects that markup into the
status bar when the file is opened. The page CSP (`index.html:6`: `default-src 'self'`, no
`'unsafe-inline'`) blocks inline event handlers and inline scripts, so the direct effect is
HTML/CSS injection — overlaying fake UI, hiding warnings. The reason this is Medium rather than
Low is the `file://` origin (E-15): Chromium treats `'self'` on a `file:` page as matching every
local file, so a same-origin `srcdoc` iframe can load a local file as a classic script. A DXF can
be authored as a JavaScript polyglot. If the attacker can predict where the drawing lands (a
shared or public folder), that iframe reaches `window.jcad` and hence E-1. The injection is the
entry point; E-15 is what makes it dangerous.

**Fix**: escape the value and constrain it at parse time.

```diff
--- a/src/ui/statusbar.ts
+++ b/src/ui/statusbar.ts
-    this.annoEl.innerHTML = `${vpScale ? `<span title="${t('status.vpscale.title')}">VP ${vpScale}</span> · ` : ''}<span>${icon('text')} ${annotationScaleCaption(this.editor)}</span>${icon('chevron')}`;
+    this.annoEl.innerHTML = `${vpScale ? `<span title="${esc(t('status.vpscale.title'))}">VP ${esc(vpScale)}</span> · ` : ''}<span>${icon('text')} ${esc(annotationScaleCaption(this.editor))}</span>${icon('chevron')}`;
--- a/src/io/dxf.ts
+++ b/src/io/dxf.ts
-    ...(headerVars.get('$CANNOSCALE')?.[0]?.value ? { cannoscale: headerVars.get('$CANNOSCALE')![0]!.value } : {}),
+    // A scale name ("1:4", "1/8\" = 1'-0\""): printable, short, no markup characters.
+    ...(/^[^\x00-\x1f<>&]{1,64}$/.test(headerVars.get('$CANNOSCALE')?.[0]?.value ?? '') ? { cannoscale: headerVars.get('$CANNOSCALE')![0]!.value } : {}),
```

Longer term: add `require-trusted-types-for 'script'` to the CSP, serve the page from a custom
scheme (E-15), and add a lint rule rejecting `innerHTML` template literals whose interpolations
are not wrapped in `esc()` / `icon()`. This review checked all 159 sinks (see "Verified safe").

---

### E-4 (Medium). IMAGE paths: automatic network fetch on Windows, broad local-file read

**Where**
- M `electron/main.cjs:724-738` (`read-image`): any absolute path with an image extension is read
  and returned as a data URL; no containment check at all.
- M `src/render/images.ts:46-58` (`imageCandidates`): absolute IMAGEDEF paths are used verbatim,
  relative ones joined to the drawing folder (`..` allowed).
- R4 `electron/ipc-guard.cjs:246-271` (`imageProblem`): tightens this, but still allows any path a
  drawing references, UNC `\\server\share` names included (`:267`), and any image under the folder
  of *any* known path — so a project listing a drawing at a drive root makes that whole drive's
  images readable.

**Impact**:
- On Windows, a drawing whose IMAGEDEF names a UNC path causes the main process to open a
  connection to that host as soon as the drawing is opened — a classic automatic-authentication
  vector, with no user interaction, in both M (no check) and R4 (UNC explicitly allowed).
- In M, because `read-image` applies no containment, a compromised renderer can read any image
  file anywhere on disk and exfiltrate it (the bytes come back as a data URL).

**Fix**: in M, port R4's `imageProblem` policy; in both, drop UNC / network paths unless the
drawing itself is on that host, and base the "near a drawing" rule on the drawing folders opened
this session, not on every known path.

```diff
--- a/electron/ipc-guard.cjs
+++ b/electron/ipc-guard.cjs
@@ rememberImages
-        const abs = path.isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name) || name.startsWith('\\\\') ? name : path.join(dir, name);
+        if (name.startsWith('\\\\') || /^\/\//.test(name)) continue;   // never auto-open a network share
+        const abs = path.isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name) ? name : path.join(dir, name);
```

---

### E-5 (Medium). Atomic writes follow symbolic links to their target

**Where**: M `electron/atomic-write.cjs:162-168` (`resolveTarget` calls `fs.realpath`, so a write
to a symlink updates the link's target) and `:199-231` (`atomicWriteFile` writes to the resolved
path). R4 uses a plain temp-file + rename and would instead *replace* a symlink with a regular
file, which is its own surprise but does not write through it.

**Impact** (local attacker, threat model 4): on a shared workstation, if the victim will save a
drawing to `~/shared/out.dxf` and an attacker who can write that directory plants `out.dxf` as a
symlink to a file the victim can write but the attacker cannot (e.g. the victim's crontab or
shell profile), the victim's save follows the link and writes attacker-chosen content there.
`save-dxf` keeps the extension, limiting targets, but the primitive is real.

**Fix**: open destinations with `O_NOFOLLOW` on the final component, or `lstat` the destination and
refuse when it is a symlink unless the user confirms; do not silently write through it.

---

### E-6 (Medium). Catastrophic-ish trailing-whitespace regex in DXF tokenizing (ReDoS)

**Where**: M `src/io/dxf.ts:1259` applies `raw.replace(/\s+$/, '')` to most group-code values; the
Track-D 3D DXF reader has the identical `src/core/dxf/dxf-common.ts:98`. `/\s+$/` backtracks
quadratically on a long run of whitespace with no line terminator.

**Measured**: a single value of N trailing spaces took ~36 ms at N=5000, ~102 ms at 10000, ~357 ms
at 20000 — O(N²). A DXF with many such values, or one very long one, freezes the renderer (the
DXF text parser runs on the main renderer thread).

**Impact**: denial of service — opening a crafted but structurally valid DXF hangs the UI.

**Fix**: strip trailing whitespace without backtracking.

```diff
-    const value = code === 1 || code === 3 || code === 304 ? raw : raw.replace(/\s+$/, '');
+    const value = code === 1 || code === 3 || code === 304 ? raw : raw.replace(/[ \t\f\v]+$/, '');
```

A linear trim (`raw.replace(/[\s﻿\xA0]+$/u, '')` is still backtracking; prefer a manual
`while` loop or `.trimEnd()` where trailing `\r` has already been removed by the line split).

---

### E-7 (Medium). DWG parser placement and resource limits

**Where**: M `electron/main.cjs:369-379` runs LibreDWG (WebAssembly) in the **main process**;
`scripts/dwg-reader.mjs:30-48` reads the file. R4 moves it to a worker thread
(`electron/dwg-host.cjs:49-94`) — a real improvement — but creates the worker with no
`resourceLimits` (`:58`), and neither tree caps the input size before handing bytes to LibreDWG.

**Impact**: LibreDWG is a large C library parsing a complex binary format from an untrusted file; a
memory-safety bug is parsing native code with the privileges of the process it runs in. In M that
is the main (Node-enabled) process — the most valuable target. A malformed DWG can also drive
unbounded memory / CPU use; the R4 worker contains a crash but not resource exhaustion.

**Fix**: keep R4's worker (and backport it to M). Give the worker `resourceLimits`
(`maxOldGenerationSizeMb`, `maxYoungGenerationSizeMb`) and enforce a maximum DWG byte length before
parsing, matching the 512 MB ceiling other channels use. Treat a worker that exceeds the limit as
a failed open.

---

### E-8 (Medium). Update authenticity depends on who can publish a GitHub release

**Where**: M `electron/updater.cjs`. `canSelfUpdate()` (`:31-36`) allows in-place updates on
Windows NSIS and Linux AppImage; electron-updater verifies the package hash against
`latest*.yml` from the same GitHub release (`:122-161`). On Windows the signature is verified only
when `azureSignOptions.publisherName` is configured (`scripts/azure-signing.mjs`), which the
release workflow skips when the Azure secrets are absent — then the build ships unsigned and
`verifyUpdateCodeSignature` has nothing to check. The API fallback (`:79-105`, `assetFor`) just
opens a download URL.

**Impact**: for an unsigned Windows / AppImage build, update integrity reduces to "the bytes match
a hash published in the same release." Anyone who can publish a release to `habit04/share` (a
compromised maintainer token, a mis-scoped CI credential) ships code that every client installs
and runs. There is no publisher-key pinning independent of GitHub.

**Fix**: require a signed build on the self-update platforms (fail the release if signing was
skipped), or pin a release-signing public key in the app and verify a detached signature over
`latest*.yml` before applying. At minimum, document that unsigned builds must not self-update.

---

### E-9 (Low). `open-external` allow-list is matched before URL normalisation

**Where**: M `electron/main.cjs:816-822`; R4 `:828-836`; `updater.cjs:63-65` (`safeUrl`). The test
is `^https:\/\/github\.com\/habit04\/share(\/|$)` against the raw string.

**Impact**: `https://github.com/habit04/share/../../login/oauth/authorize?...` passes the regex,
and `shell.openExternal` hands the normalised URL (`https://github.com/login/oauth/authorize?...`)
to the browser (confirmed with a Node one-liner). Still on github.com and still requires a page
compromise to call, so impact is limited to opening an attacker-chosen github.com path (e.g. an
OAuth authorize link) in the user's browser.

**Fix**: parse first, then compare structurally.

```diff
-  const allowed = /^https:\/\/github\.com\/habit04\/share(\/|$)/.test(u) || /^https:\/\/cash\.app\/\$[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(u);
-  if (!allowed || u.length > 16000) return false;
+  let parsed; try { parsed = new URL(u); } catch { return false; }
+  const okGithub = parsed.protocol === 'https:' && parsed.host === 'github.com'
+    && (parsed.pathname === '/habit04/share' || parsed.pathname.startsWith('/habit04/share/'));
+  const okCash = parsed.protocol === 'https:' && parsed.host === 'cash.app'
+    && /^\/\$[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(parsed.pathname);
+  if ((!okGithub && !okCash) || u.length > 16000) return false;
```

---

### E-10 (Low). Plugin trust model

**Where**: M `src/app/plugins.ts`. Plugins run in the page with full API access. Trust is a
localStorage record keyed by origin:path and the SHA-256 of the code (`:125,:161,:322-330`);
`codeHash` falls back to non-cryptographic FNV-1a when WebCrypto is absent (`:120-134`). Code runs
via `new Function` or, under CSP, `webFrame.executeJavaScript` (`preload.cjs:39`,
`plugins.ts:179-205`). R4 adds load timeouts and uncaught-error attribution (`:91-125`, `:312-336`).

**Impact**: this is a deliberate design (the dialog warns plugins have full access). Residual
risks: the FNV fallback means a changed plugin might not re-prompt if WebCrypto is ever
unavailable; trust is keyed by path, so a plugin folder reused for different code at the same path
re-prompts only via the hash; and `pluginsEval` exposes an arbitrary in-page eval to any page
script through `window.jcad`. Accept with eyes open; at minimum drop the non-crypto hash fallback
(treat "no WebCrypto" as "always ask") and document that `pluginsEval` is as powerful as the
plugin system itself.

---

### E-11 (Low). No IPC sender validation in the merged tree

**Where**: M registers handlers directly on `ipcMain` and derives the window from
`BrowserWindow.fromWebContents(ev.sender)` with no check that the sender is the application page.
R4 fixes this comprehensively (`electron/ipc-guard.cjs`: frame identity, no sub-frames, URL match,
rejection log). **Merge R4's `guardIpc` / `appUrlTest` into the shipping tree.** With
`contextIsolation`, `sandbox`, no `nodeIntegration`, navigation blocked (M `:320`) and child
windows denied (M `:319`), there is no second frame today, so this is latent — but it is exactly
the defence that stops a future added `<iframe>` or `webview` from reaching the bridge.

---

### E-12 (Low). No permission or web-contents handlers

**Where**: neither tree calls `session.setPermissionRequestHandler` /
`setPermissionCheckHandler`, nor guards `app.on('web-contents-created')` /
`will-attach-webview`.

**Impact**: defence in depth. The app needs no camera, mic, geolocation or clipboard-read
permission; a compromised renderer could request them and the default handler may grant some.

**Fix**: install a deny-by-default permission handler and a `web-contents-created` guard that
re-applies `setWindowOpenHandler('deny')` and blocks navigation / webview attachment on every new
contents (the hidden print/plot windows included).

---

### E-13 (Low). No global budget for nested-block expansion

**Where**: M `src/core/entities.ts:1011-1016` caps INSERT recursion at depth 8, but there is no
cap on total expanded entities. A drawing with blocks that each INSERT the previous one many times
stays within depth 8 while expanding to an enormous entity count (fan-out, not depth).

**Impact**: denial of service — opening or rendering such a DXF exhausts memory / CPU. The depth
cap and the per-insert cache (`:995-1002`) limit but do not bound the product.

**Fix**: thread a global expansion budget (e.g. a few million entities) through
`explodeInsertUncached` and stop with a reported warning when it is exceeded, as the parser
already does for other truncations.

---

### E-14 (Low). `modal()` renders its title as raw HTML

**Where**: M `src/ui/dialogkit.ts:34` and `src/ui/dialogs.ts:27` build the title bar with
`head.innerHTML = \`<span ...>${title}</span>...\``, `title` unescaped. Most call sites pass
literals or already wrap with `esc()` (`dimstyle.ts`, `layouts.ts`, `api.ts:405`,
`import-report.ts`), but the API is unsafe by default: `symbol-builder.ts:763`
(`modal(\`Save ${name}\`)`) and `electrical-dialogs.ts:1100` (`modal(r.title, ...)`) pass
file-derived names. Today symbol names are normalised to a safe charset
(`userlib.ts:123-129`, `symbol-builder-core.ts:1259`) and report titles are built-in, so no live
injection was found — but the sink is one careless call away from E-3.

**Fix**: escape inside `modal()` so every caller is safe.

```diff
--- a/src/ui/dialogkit.ts
+++ b/src/ui/dialogkit.ts
-  head.innerHTML = `<span id="${titleId}">${title}</span><button class="modal-close" title="Close" aria-label="Close">${icon('close')}</button>`;
+  head.innerHTML = `<span id="${titleId}">${esc(title)}</span><button class="modal-close" title="Close" aria-label="Close">${icon('close')}</button>`;
```

Then drop the now-redundant `esc(...)` at the `esc`-wrapping call sites, or leave them (double-escape
is visible but harmless — audit once). Apply the same to `src/ui/dialogs.ts:27`.

---

### E-15 (Low). Renderer hardening gaps

- **`file://` origin.** M serves the page with `loadFile` (`main.cjs:342`); on `file:` the CSP
  `'self'` matches every local file, which is what makes E-3 escalatable. JCad 3D already serves
  from a custom `app://` scheme; porting that here would contain same-origin local-file loads.
- **No Electron fuses.** Neither tree runs `@electron/fuses` in `afterPack`. Enable
  `RunAsNode=off`, `EnableNodeOptionsEnvironmentVariable=off`,
  `EnableNodeCliInspectArguments=off`, and `OnlyLoadAppFromAsar=on` so a local attacker cannot
  relaunch the signed binary as a Node interpreter via `ELECTRON_RUN_AS_NODE`.
- **DevTools / reload in production.** The menu exposes `toggleDevTools` (M `main.cjs:167`). Harmless
  to the user, but gate it behind `!app.isPackaged` to shrink the renderer's attack surface.
- **CSP could add** `base-uri 'none'`, `object-src 'none'`, `frame-src 'none'`,
  `form-action 'none'` to the page policy (`index.html:6`).

---

### E-16 (Info). Problem report pre-fills local paths and command history into a GitHub URL

**Where**: M `src/app/diagnostics.ts:60-140`, `src/ui/report.ts`. The bug-report form pre-fills
the command history, captured error messages and the drawing name into a github.com issue URL.
Paths and drawing names are not redacted. The user sees and submits the form, so this is a privacy
note, not a vulnerability; consider stripping the home-directory prefix from paths before
pre-filling.

### E-17 (Info). Pack-key lookup on a plain object

**Where**: M `src/electrical/packs.ts:207` (`keys[sig.keyId]`). `PACK_KEYS` is a plain object;
`verifyPack` reads `keys[sig.keyId]` with `keyId` attacker-controlled. A `keyId` of
`__proto__` / `constructor` returns a function or inherited value rather than a key, but
`base64ToBytes` then throws and `verifyPack` returns `{ ok: false }`, so it fails closed. Harden by
using a `Map` or `Object.hasOwn(keys, sig.keyId)` to make the intent explicit.

### E-18 (Info). Plot/print page size is taken from renderer-supplied numbers

**Where**: M `electron/main.cjs:558-573`, `512-539`, `576-594`. `sheetPortrait` accepts any finite
positive width/height from the renderer for `printToPDF` / `print`. A huge value could make the
hidden window allocate a very large PDF. Low impact (self-inflicted; the image is already a PNG
data URL validated at `:514`), but clamp the sheet dimensions to a sane maximum.

---

## Verified safe (checked, no issue)

- **Window security flags** (M `main.cjs:307-312`, hidden windows `:521`, `:579`):
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` everywhere. Preload exposes a
  narrow, typed bridge (`preload.cjs`); no `remote` module.
- **Navigation / popups**: `will-navigate` prevented and `setWindowOpenHandler` denies all
  (M `main.cjs:319-320`).
- **Plot / print image input**: strictly validated as a base64 PNG data URL before use
  (M `main.cjs:514`, `:578`); the print window title is stripped of `<>&` (`:581`). `save-pdf`
  checks the `%PDF-` magic and size bounds (`:542-545`).
- **Autosave / pack / plugin names**: tight allow-list regexes with explicit `.`/`..` rejection
  (`autosave-store.cjs:21-38`, `main.cjs:663-666` `safePluginFolder`, `:747-750` `safePackName`,
  `:659-662` plugin folder/main regexes); plugin and pack reads are size-capped
  (`:667-672`, `:760-770`).
- **R4 IPC guard** (`ipc-guard.cjs`): frame identity + URL match, sub-frames refused, rejections
  logged and size-capped; `insideRoot` resolves symlinks before allowing plugin/pack reads
  (`:279-295`). Path shape checks reject non-absolute, over-long and NUL-containing paths
  (`:205-211`).
- **Catalog pack verification** (`packs.ts`): Ed25519 over canonical JSON with the `signature`
  member removed; unsigned packs rejected at parse (`:149`); unknown key id, wrong algorithm and
  bad signature all fail closed (`:200-218`); 32-byte key length enforced (`:211`). The main
  process stores packs verbatim and never executes them.
- **Pack canonical JSON** (`:91-105`): deterministic, matches the signer; no obvious
  canonicalisation ambiguity that would let a modified pack keep a valid signature.
- **DWG decode** (`scripts/dwg-reader.mjs`): header sniff is bounded (4 KB, then 64 KB) and
  `latin1` is chunked to avoid a spread-argument blow-up (`:151-156`); codepage labels validated
  against an allow-list (`:193-197`).
- **`plot-pdf` / `print-drawing` hidden windows**: `sandbox: true`, `contextIsolation: true`, no
  preload; navigate to a tiny `data:` document and inject the image via `JSON.stringify` (no string
  concatenation of the data URL into script) (M `main.cjs:521-533`, `:579-585`).
- **`safeAutosaveName` / size caps** on `user-library-write` (64 MB), `packs-write` (20 MB),
  `autosave` payloads.
- **Single-instance lock** and crash logging are correct and not security-relevant.

## Notes for the merge

- R4's `ipc-guard.cjs` (E-11) and worker-thread DWG host (E-7) are the two security wins to carry
  forward. But R4 **regressed** two things relative to M: it dropped M's `open-project` extension
  and `..` filtering (worsening E-1) and its `save-dxf` lost the atomic-write + extension discipline
  (plain `fs.writeFile`). Carry M's `entryPath` filtering and crash-safe writes **and** apply E-1's
  read/write split on top.
- E-4: port R4's `imageProblem` into M, but narrow both per the diff above (no UNC auto-open).

## Experimental 3D track

Date: 2026-10-12. Scope: branch `feature/3d-hardening` (from `feature/3d-development`, base
`34221a7`), the experimental 3D modelling code that is compiled in but inert unless **Options >
Experimental > 3D modelling** is on: `src/model3d/**` (including the Manifold kernel in
`src/model3d/kernel/`), `src/io/dxf/mesh3d-read.ts` / `mesh3d-write.ts`, the 3D save guard
(`src/model3d/save-guard.ts`, `src/app/editor/save.ts`), `src/app/experimental-3d.ts` (the debug
handle) and, for the CSP question, `index.html` and `electron/renderer-origin.cjs`. Same threat
model as above; the new inputs are DXF files carrying polyface meshes and `JCAD_3D` XDATA, and
geometry handed to the WebAssembly kernel. File:line references are to that tree. Items marked
**not verified** were not checked on this branch.

| Finding | Severity | Status |
| --- | --- | --- |
| E-19 WebAssembly kernel in a module Worker: renderer CSP unchanged, worker reach | Low | Accepted with a recommended hardening (CSP header for worker scripts); packaged-app behaviour not verified |
| E-20 Kernel memory growth and runaway Booleans | Low | Open: timeout and crash containment exist; no engine-enforced memory cap below 4 GiB |
| E-21 `JCAD_3D` payload parsing | Info | Verified: bounded, strict, fuzzed (no finding) |
| E-22 Triangle and vertex budgets | Info | Verified; main-thread cost of large meshes noted |
| E-23 Saving files JCad could not reopen | Info | Verified: Save refuses, autosave omits solids and records it |
| E-24 `window.jcad3d` debug handle | Info | Verified: flag on only, no exposure beyond `window.editor` |

---

### E-19 (Low). WebAssembly kernel in a module Worker: CSP and what the worker can reach

**Where**: `src/model3d/kernel/manifold-kernel.ts:57-60` creates
`new Worker(new URL('./manifold.worker.ts', import.meta.url), { type: 'module' })`;
`manifold.worker.ts` loads `manifold-3d` (Apache-2.0) and its `manifold.wasm` (541 KB, emitted by
Vite into `dist/assets`); `index.html:6` keeps the renderer CSP `default-src 'self'; ...` with no
`'wasm-unsafe-eval'`.

**Why the renderer CSP is unchanged**: a dedicated worker created from a same-origin script URL
(not a `blob:` or `data:` URL) is governed by the policy delivered with its own response, not by
the creating document's `<meta>` policy. The `jcad://` protocol handler
(`electron/renderer-origin.cjs:19-29`) serves bundled files through `net.fetch(file://...)` and adds
no headers, so the worker script carries no policy and WebAssembly compiles in the worker while
main-thread `WebAssembly.compile` stays blocked. Verified on 2026-10-12 in headless Chromium with
the renderer's exact meta CSP served over HTTP (docs/3D-KERNEL.md: `ready()` reports Manifold
3.5.4, a union of two cubes gives 1.5, main-thread compile refused). **Not verified** inside the
packaged Electron app under `jcad://app/` (no shipped command starts the kernel yet; nothing in
`src/` outside `src/model3d` imports `createDefaultKernel`, so `npm run build` contains no kernel
code or wasm today).

**What the worker can reach**: its own global scope only. No DOM, no `window`, no preload bridge
(`contextBridge` exposes `window.jcad` to the main world of the page, not to workers), no Node
(`electron/main/window.cjs:240-246`: `sandbox: true`, `nodeIntegration: false`;
`nodeIntegrationInWorker` is not set, so it is off), no IPC. Its only channel to
the application is `postMessage`: requests carry typed arrays, and every reply is re-validated on
the main thread (`kernel.ts` `finishResult`: well-formed, closed, non-empty, positive volume,
within `MAX_SOLID_TRIANGLES`) before it can enter drawing state; a reply that cannot be read
counts as a crash (`messageerror`). It can, however, use `fetch` and `import()`: because its
response has no CSP, nothing restricts their destinations. The worker runs only bundled code
(manifold.js and the worker chunk); exploiting this needs code execution in the worker first (a
memory-safety bug in the WebAssembly module cannot call JavaScript beyond its Emscripten imports).
Whether Electron's session settings block remote requests from workers is **not verified**.

**Recommendation**: have the `jcad://` handler send
`Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'` with worker
scripts (or with every `.js` response), which keeps WebAssembly in the worker and removes remote
`fetch` / `import()` from it, then re-run the probe in the packaged app. If the kernel ever has to
run on the main thread (`ManifoldDirectKernel`), that needs `'wasm-unsafe-eval'` in the renderer
policy and a new review; the default stays the worker (docs/3D-PLAN.md, open decision 1).

---

### E-20 (Low). Kernel memory growth and runaway Booleans

**Where**: `node_modules/manifold-3d/manifold.wasm` (memory section) and `manifold.js`
(`getHeapMax`); `src/model3d/kernel/manifold-kernel.ts` (timeouts, crash handling).

**Facts** (checked by parsing the shipped wasm): one linear memory, exported, initial 256 pages
(16 MiB), maximum 65,536 pages (4 GiB); `ALLOW_MEMORY_GROWTH` is on and `getHeapMax()` returns
4,294,901,760 bytes. The Emscripten heap only grows; it is released when the worker is terminated.
A dedicated worker is a thread of the renderer process, not a separate process: its WebAssembly
memory counts against the renderer, and V8's JavaScript heap limit does not cover it. Measured in
Node (in-process kernel): a union of two 499,712-triangle operands (the per-solid limit allows
500,000) took 3.5 s and the process reached about 820 MB resident; its 776,948-triangle result is
then refused by the budget, after the work was done.

**Containment that exists**: operands are checked before they are sent (`prepareOperands`:
well-formed, closed, positive volume, at most 500,000 triangles each); every call has a timeout
(default 20 s): the call rejects with `timeout`, the busy worker is **terminated** (a running
Boolean cannot be cancelled, so recycling the worker is the only way to stop it, and it frees
its memory), the other pending calls reject, and the next call starts a fresh worker. An
out-of-memory abort inside the module fires the worker's `error` event: pending calls reject with
`worker-crash`, one restart is allowed, a second crash disables Booleans for the session
(tested with an injected fake worker, `tests/model3d-kernel.test.ts`). **Not verified**: what a
real allocation failure near 4 GiB does in Chromium (worker abort versus renderer termination),
and peak memory for the largest accepted operands in the worker.

**Impact**: a drawing (or a sequence of user Booleans) at the triangle limits can make the
renderer allocate gigabytes for up to 20 s; on a machine with little free memory that can end in
an out-of-memory renderer crash, which recovery copies limit to unsaved work since the last
autosave. Self-inflicted rather than an attacker gain: a file never triggers a Boolean on open
(the stored mesh is authoritative, histories are not re-evaluated on load).

**Recommendation**: as for LibreDWG (E-7), rewrite the memory section's maximum before
instantiation to an engine-enforced cap (for example 1 GiB), and refuse operand pairs whose
combined size predicts a result over `MAX_SOLID_TRIANGLES` before calling the kernel.

---

### E-21 (Info). `JCAD_3D` payload parsing (verified, no finding)

**Where**: `src/io/dxf/mesh3d-read.ts` (`payloadText`, `readFaces`), `src/model3d/file-format.ts`
(`decodeSolidPayload`, `validateFeature`).

- Bounded before parsing: each XDATA 1000 string at most 255 characters, the joined payload at
  most 15,000 characters (`MAX_PAYLOAD_BYTES`, checked while joining and again before
  `JSON.parse`), a duplicate `1001 JCAD_3D` or any other group inside the data makes the payload
  unreadable; nothing else is parsed from XDATA.
- Strict shapes: a hand-written validator with no `any`; every object's keys are checked against
  required and optional lists (`keysOnly`), unknown kinds and fields are refused, numbers must be
  finite (and positive where sizes are), frames orthonormal and right-handed within 1e-6, ids
  match `^[A-Za-z0-9_.:-]{1,64}$`, names are cut to 255 characters and stripped of control
  characters, `part` / `parts` are integers up to 1,000.
- Recursion bounded: Boolean nesting at most 64 levels on read (`MAX_FEATURE_DEPTH`); re-evaluation
  checks the tree iteratively first (at most 32 levels and 1,024 features).
- Prototype keys: `JSON.parse` turns `"__proto__"` into an ordinary own property, which the key
  check refuses as unknown; validated features are rebuilt from fresh object literals, never
  copied, so no parsed object or prototype reaches drawing state.
- A rejected payload never loses geometry: the mesh is kept, the history replaced by
  `{kind: 'mesh'}` and an import-report item says why; a payload of a newer version is refused
  explicitly.
- Fuzzed (`tests/fuzz-model3d-file.test.ts`, docs/3D-TESTING.md): 2,000 mutated files (truncation,
  swapped codes, `NaN` / `Infinity` / `-0` / huge numbers, deep nesting, Unicode and control
  characters, duplicated 1001 groups, face-index corruption, count mismatches) only ever produced
  a drawing or a `DxfReadError`; every drawing passed `prepareDrawingState`; every dropped record
  was an import-report item. 2,000 mutated payload texts: `decodeSolidPayload` never threw.
  Fuzzing found no reader defect. The new fixtures found one functional defect in the validator
  (revolve histories with a segment count were refused, so reopened revolves lost their history;
  fixed).

---

### E-22 (Info). Triangle and vertex budgets

**Where**: `src/model3d/budget.ts`, called by `prepareDrawingState` for every state (open, edit,
undo, recovery); `src/model3d/sweep.ts` (`checkBudget`); `src/model3d/kernel/kernel.ts`.

Verified: at most 500,000 triangles and 1,500,000 vertices per solid, 2,000,000 triangles and
6,000,000 vertices in a drawing (GeometryBudgetError, the same refusal as an oversized 2D file);
sweeps check the count before allocating; Boolean operands and results are checked against the
per-solid limit. In practice the DXF reader's limits (2,000,000 group pairs, 250,000 records,
128 MB) cap a file at about 100,000 triangles first. Residual cost, not a vulnerability: a drawing
at the limits makes the UI thread spend seconds in sealing (0.95-1.8 s for 2,000,000 triangles),
the first pick (BVH build, 4-7 s for 2,000,000 triangles) and Boolean checks (docs/PERFORMANCE.md
"3D").

---

### E-23 (Info). Saving a file JCad could not reopen (verified)

**Where**: `src/model3d/save-guard.ts` (`model3dDxfLimitRefusal`, `recoveryDxf`),
`src/app/editor/save.ts` (Save / Save As), `src/app/autosave.ts`.

Verified in code and by `tests/model3d-save-guard.test.ts`: when the solids push the DXF text past
the reader's default limits (`DXF_READ_LIMITS`), Save and Save As write nothing, set
`lastFileError` with the triangle count and the limit, and leave the drawing modified; autosave
writes the recovery copy without the solids and records `omitted3d` for the recovery dialog. DWG
Save, Save As and EXPORTDWG refuse drawings with solids (the portable writer would drop them).
A writer-side error (an invalid mesh in a hand-made state) fails the save visibly instead of
writing a partial file.

---

### E-24 (Info). `window.jcad3d` debug handle (verified)

**Where**: `src/app/experimental-3d.ts:453-460`, `src/main.ts` (`window.jcad3d` type).

`installExperimental3d` returns before doing anything when `settings.experimental3d` is off, so
the handle is set only with the flag on (`tests/experimental-3d-flag.test.ts` checks that nothing
is registered with the flag off). It is the `Experimental3d` controller, which holds the editor;
`src/main.ts:777` already exposes the editor itself as `window.editor` in every build, so the
handle gives page script nothing it could not already reach. It is reachable only from script
running in the renderer (threat 3 above), never from file content.

### Verified safe in the 3D track (checked, no issue)

- Solids read from a file are never re-evaluated on load: no file content reaches the kernel
  without a user command.
- Meshes in drawing state are plain arrays: typed arrays from the kernel are unpacked before they
  enter state, so `sealImmutableData` seals them like 2D data; the reader builds plain arrays.
- The writer emits only validated numbers (shortest round-trip decimals, no exponents) and a 7-bit,
  whitespace-free, chunked payload. Import-report rows, including 3D reasons and solid names, are
  assigned as text (`src/ui/import-report.ts:36-53` uses `textContent`).
