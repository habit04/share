# Development guide

How to set up, run, test, package and release JCad Electrical from source, and how to check a
change from end to end before it is merged. Release mechanics are in [RELEASE.md](RELEASE.md),
signing in [CODE-SIGNING.md](CODE-SIGNING.md), performance numbers in
[PERFORMANCE.md](PERFORMANCE.md).

Contents: [Prerequisites](#prerequisites) · [Install](#install) · [Run](#run) ·
[Checks](#checks) · [Tests](#unit-and-regression-tests) · [Screenshots](#screenshots) ·
[End-to-end](#end-to-end-tests) · [Performance](#performance) · [Packaging](#packaging) ·
[Signing and release](#signing-and-release) · [Verifying a change](#verifying-a-change-end-to-end) ·
[Layout of the tooling](#layout-of-the-tooling) · [Module map](#module-map)

## Prerequisites

| | All systems | Windows | macOS | Linux |
| --- | --- | --- | --- | --- |
| Node.js | **22.20+ or 24.12+**, within those major versions (`package.json`: `>=22.20.0 <23 || >=24.12.0 <25`) | nodejs.org installer, `nvm-windows` or `fnm` | `nvm`, `fnm` or Homebrew | `nvm`, `fnm` or NodeSource |
| npm | the version bundled with the supported Node release | | | |
| Git | any recent | Git for Windows (Git Bash runs the shell snippets below) | Xcode command-line tools | distribution package |
| Native build tools | not needed (no native modules) | | | |
| For `npm run e2e` | the Electron binary: the `electron` package fetches it the first time it is started (or run `node node_modules/electron/install.js` after `npm ci`) | | | a display: `xvfb-run` (package `xvfb`) on a server or in a container |
| For screenshots / UI check / bench | a Chromium for Playwright (below) | | | `npx playwright install --with-deps chromium` installs Chromium and its system libraries and fonts |
| For packaging | | NSIS is bundled by electron-builder | Xcode command-line tools (`codesign`, `hdiutil`) | `dpkg-deb` comes with Debian / Ubuntu; AppImage needs nothing extra |

`.npmrc` sets `engine-strict=true`: `npm ci` / `npm install` on any other Node major version stops
at once with `EBADENGINE` and the required range, instead of failing later in a confusing way.
With `nvm` or `fnm`, `nvm use` / `fnm use` in the repository picks the version from `.nvmrc`.

**Versions used in CI.** Unit checks and release checks run a Node **22 / 24** matrix.
The other jobs use `.nvmrc` (`22`); setup-node resolves the latest patch in that major.
Use the committed lockfile on either supported major. Browser pixel comparisons still require
the Playwright Chromium and fonts used by CI ([Screenshots](#screenshots)).

## Install

```bash
git clone https://github.com/habit04/share.git
cd share
npm ci                      # exact versions from package-lock.json
node node_modules/electron/install.js   # the Electron binary (otherwise fetched on the first start)
```

Optional environment variables for `npm ci`:

- `ELECTRON_SKIP_BINARY_DOWNLOAD=1` is no longer needed: since Electron 44 the package downloads its
  binary only when Electron is first started (`npm start`, `npm run e2e`), not during `npm ci`.
- `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` always (the Playwright package is used, its browsers are
  installed separately when needed).

Chromium for the browser-driven scripts:

```bash
npx playwright install --with-deps chromium     # Linux CI / Ubuntu: includes system libraries and fonts
export CHROMIUM_PATH="$(node -e "import('playwright').then((m) => console.log(m.chromium.executablePath()))")"
```

The scripts default to `/opt/pw-browsers/chromium` when `CHROMIUM_PATH` is not set (the
development container's pre-installed Playwright Chromium).

## Run

```bash
npm run electron:dev        # Vite dev server + Electron with live reload
npm start                   # production renderer build, then Electron on it
npm run dev                 # renderer only, in a browser: http://localhost:5173/?demo
npm run build:site          # landing page + browser edition into site-dist/
```

## Checks

| Command | What it checks |
| --- | --- |
| `npm run lint` | ESLint (flat config `eslint.config.js`, typescript-eslint): `src/`, `tests/`, `electron/`, `scripts/`, `e2e/`, `site/`, the example plugins. `--max-warnings=0`. |
| `npm run typecheck` | `tsc` on the renderer and the tests (`tsconfig.json`, strict). |
| `npm run typecheck:electron` | `tsc` with `checkJs` on `electron/*.cjs` and `scripts/*.cjs` (`tsconfig.electron.json`): the main process, preload, updater and packaging hook, typed through JSDoc and Electron's own type definitions. Nothing is emitted; the files ship as written. |
| `npm run typecheck:scripts` | `tsc` with `checkJs` on `scripts/*.mjs` and `e2e/*.mjs` (`tsconfig.scripts.json`; page globals the scripts reach are declared in `scripts/types/page-globals.d.ts`; `strictNullChecks` is off there because the test drivers deliberately let a missing element throw). |
| `npm run typecheck:all` | All three. |
| `npm run check:workflows` | Parses every `.github/workflows/*.yml` with js-yaml and checks its structure, plus the release gates (checks before builds, packaged smoke test before publishing, tag verified against the tested commit, signing steps present, release notes from `CHANGELOG.md`). |
| `node scripts/make-icons.mjs --check` | The committed application icons (`build/icon.*`, `build/icons/`, `public/favicon.svg`, `site/img/icon.svg`) match a fresh render of `scripts/make-icons.mjs` (also covered by `tests/packaging.test.ts`); `npm run icons` redraws them. |

## Unit and regression tests

`npm test` first runs `npm run check:fixtures`. The explicit inventory in
`tests/fixtures/manifest.json` requires every committed DXF, DWG and pack input to be present and
nonempty. Their tests fail if inputs disappear; they never silently skip. Private customer DWGs
remain optional through `JCAD_CUSTOMER_DWG_DIR`. External AutoCAD proof runs separately with
`npm run check:autocad` on a Windows machine with AutoCAD Core Console installed; see
[QA-CHECKLIST.md](QA-CHECKLIST.md). Keep vendor outputs and private drawings outside the repository.

```bash
npm test                    # vitest run: every tests/**/*.test.ts (includes the DWG fixtures in fixtures/)
npx vitest run tests/dxf.test.ts          # one file
npx vitest                  # watch mode
npm run check:dwg-containment # actual Electron utility/OS-memory/heap/cancel/recovery checks
```

Run the containment command under `xvfb-run -a` on a Linux worker without a display. It creates
temporary fixture copies and writes bounded proof to `e2e-output/dwg-containment.json`; its
unpackaged test main is not included in installers. Shipping probes still have to verify the
production app with its enabled fuses on each supported OS through a real DWG read, cancellation,
malformed-input refusal and reopening. Forced native-memory and heap exhaustion are tested by
the unpackaged containment gate, rather than an allocation test hook in the installed app. See
[DWG memory containment](DWG-MEMORY-CONTAINMENT.md) for that evidence boundary.

Timing budgets in `tests/perf.test.ts` are about three times the development machine; set
`JCAD_PERF_FACTOR=2` on slower machines (CI does). The heavy dense-drawing benchmarks only run
with `npm run bench:node` (see [Performance](#performance)).

## Screenshots

The screenshot scripts (`scripts/screenshot*.mjs`) drive the built renderer and website in
headless Chromium; `e2e/run-screenshots.mjs` runs them all as gates (page errors, console errors,
failed checks and unknown commands fail it). Every resulting `screenshots/*.png` is then compared
with its **approved baseline** in `screenshots/baseline/`:

The output scanner decodes split UTF-8 bytes, carries only each stream's unfinished line, and
caps that tail at 8,192 characters. It scans final lines on process exit. An oversized line fails
the gate; the offline website's single exact `net::ERR_FAILED` console message is allowed because
the test intentionally aborts that GitHub request. Other console failures fail the gate.

```bash
npm run build && npm run build:site
node e2e/run-screenshots.mjs            # writes screenshots/*.png
npm run screenshot:compare              # fails on a regression; diffs in screenshots/diff/
npm run screenshot:approve              # accept the current images as the new baselines
npm run screenshot:approve -- 05-layers.png        # accept only some
npm run screenshot:approve -- --prune   # also drop baselines whose screenshot no longer exists
```

- The comparison is pixelmatch with a per-pixel colour threshold of 0.1, anti-aliased pixels
  ignored, and by default at most 0.1 % of the pixels may differ. Per-image tolerances, masks
  for regions that legitimately change between runs, and images left out are in
  `screenshots/baseline/config.json`.
- A failing image leaves `<name>.diff.png` (changed pixels in red over a faded baseline) and
  `<name>.actual.png` in `screenshots/diff/`; CI uploads that folder as the `screenshot-diffs`
  artifact.
- The pages run with a fixed time zone (UTC), locale (en-US) and a pinned calendar date
  (2026-01-15, clocks still run) from `scripts/screenshot-env.mjs`, so title-block dates and time
  stamps do not change from day to day.
- **Baselines belong to one browser and one font set**: the Playwright Chromium pinned by
  `package-lock.json`, installed with `npx playwright install --with-deps chromium` on
  `ubuntu-latest` (which also installs the fonts). Other Chromium versions or other operating
  systems render text slightly differently. To regenerate the baselines in exactly that
  environment, run the **Screenshot baselines** workflow (Actions tab) on your branch; tick
  *commit* to have it commit them, or download the `screenshot-baselines` artifact. Approving
  locally is fine for a quick look; commit locally approved baselines only when your Chromium is
  the CI one.
- Approving is a review step: look at the diff images (or `git diff --stat screenshots/baseline`)
  before committing new baselines.

## End-to-end tests

```bash
npm run build
npm run e2e                                  # Windows / macOS
xvfb-run -a npm run e2e                      # Linux without a display
JCAD_E2E_OUT=e2e-output npm run e2e          # keep the plotted PDFs and a window screenshot
npm run e2e:origin                           # migration, immediate restart and lost-storage recovery
```

`scripts/e2e-electron.mjs` launches Electron on `dist/` with Playwright and drives the real main
process, preload bridge and IPC (native dialogs are replaced inside the main process; see the
file header for the full list of checks). Full packaged Playwright coverage uses a dedicated,
unpublished ASAR build with inspection enabled and `jcadTestBuild` metadata:

```bash
npx electron-builder --dir --config scripts/electron-test-build.cjs --publish never
node scripts/test-build-e2e.mjs
node scripts/packaged-smoke.mjs release/     # installs / mounts / extracts every installer in release/ for this OS
```

`scripts/packaged-smoke.mjs` runs the NSIS installer silently (`/S /D=<temp folder>`), mounts a
disk image with `hdiutil attach` and copies the `.app` out, or extracts an AppImage
(`--appimage-extract`) or a `.deb` (`dpkg-deb -x`); then it runs the headless DWG probe
(`--probe-dwg`). Current shipping binaries disable inspection, so the script verifies their actual
binary fuses and runs bounded fixed startup probes for packaged metadata, saving/reopening a
fixture and two-launch secure-origin preference migration. The probes accept only enumerated
operations in an owned temporary profile, with no arbitrary script argument. Older releases with
inspection enabled retain the legacy Playwright path; release CI requires the hardened shipping
path. Stock Electron seeds the isolated legacy profile; do not skip its download for these checks.
Each target writes its migration log and JSON result below `packaged-smoke-output/`.

The source/test-build origin check uses three immediate launches: migrate Unicode legacy
settings, preserve changed and deleted values after an approved quit, and recover the latest
checkpoint after removing only the generated profile's Chromium DOM storage. It waits for the
actual durable migration acknowledgement. Shipping startup probes retain their bounded two-phase
save/reopen sequence and also wait for that acknowledgement.

Desktop preferences use a bounded 8 MiB string dictionary in the private user-data directory's
`renderer-preferences.json`. Migration and approved close captures share a queue and use the
atomic writer; the migration marker is committed afterward. The preload restores a checkpoint
only when the new origin is empty and unmarked, preserving deletions and existing DOM values.
An unreadable checkpoint never falls back to stale legacy settings. DOM storage flushing remains
best effort; the checkpoint supplies the acknowledged disk commit.

## Performance

```bash
npm run bench:node                  # pick / select / snap on 50,000 entities, with and without the spatial index; 20-drawing project reports
npm run build && npm run bench      # rendering, hover and window selection in headless Chromium
JCAD_BENCH_ASSERT=1 npm run bench:project  # filesystem reads, preparation and twelve project reports
JCAD_BENCH_ASSERT=1 JCAD_PERF_FACTOR=2 npm run bench  # enforce browser budgets (CI / release)
```

Numbers and method: [PERFORMANCE.md](PERFORMANCE.md).

## Packaging

```bash
npm run dist:dir            # unpacked app in release/<platform>-unpacked (fast; no installer)
npm run dist                # installers for this OS (electron-builder; see package.json "build")
```

electron-builder only builds installers for the OS it runs on (macOS disk images need macOS).
The release workflow builds all three on GitHub's runners; locally, `npm run dist:dir` plus
`node scripts/shipping-runtime-smoke.mjs <packaged-executable>` checks the hardened shipping
build. The full Playwright suite uses `release-test/`; that build is excluded from shipping uploads.

## Signing and release

- Local and build-only rehearsal signing switches on from repository secrets; publication
  requires Windows publisher and Apple signing/notarization credentials. See
  [CODE-SIGNING.md](CODE-SIGNING.md). Local builds are unsigned (macOS: ad-hoc signed by
  `scripts/afterPack.cjs`).
- Packaging flips Electron fuses after `afterPack`, then signs. The fuse reset option reseals
  the macOS ad-hoc app after mutation; release CI verifies that final seal. Shipping disables the
  CLI inspect fuse. The separate test ASAR enables inspection for full Playwright checks, and
  fixed probes exercise the actual shipping binaries without enabling debugging.
- Releases are cut by pushing a `v<version>` tag (or running **Build installers** with a tag);
  the pipeline, its gates and how to verify a published build are in [RELEASE.md](RELEASE.md).

## Verifying a change end to end

Before opening a pull request, on a supported Node 22 or 24 release:

```bash
npm ci
npm run lint
npm run typecheck:all
npm test
npm run check:workflows             # when .github/workflows changed
npm run build
npm run ui-check                    # every command and clickable control
npm run build:site && node e2e/run-screenshots.mjs && npm run screenshot:compare
xvfb-run -a npm run e2e             # (Windows / macOS: npm run e2e)
xvfb-run -a npm run e2e:origin      # (Windows / macOS: npm run e2e:origin)
npm run bench:node                  # when selection, snapping, reports or geometry changed
JCAD_BENCH_ASSERT=1 npm run bench:project  # filesystem project preparation and reports
```

Then push the branch: CI runs the same steps (`ci.yml`: `test`, `ui` and `e2e-electron` on
Ubuntu, Windows and macOS). For changes to packaging, the main process or the preload, also run
**Build installers** without a tag on the branch: it runs the release checks, builds every
installer and smoke-tests each one on its own OS without publishing anything.

## Layout of the tooling

| Path | Purpose |
| --- | --- |
| `.nvmrc`, `.node-version`, `.npmrc` | Node 22, engine-strict installs |
| `eslint.config.js` | lint rules (no formatting rules) |
| `tsconfig.json`, `tsconfig.electron.json`, `tsconfig.scripts.json` | type checks |
| `scripts/screenshot*.mjs`, `scripts/screenshot-env.mjs`, `scripts/screenshot-compare.mjs`, `screenshots/baseline/` | visual review and approved baselines |
| `scripts/e2e-electron.mjs`, `scripts/test-build-e2e.mjs` | Full source and unpublished test-ASAR Playwright suites |
| `scripts/packaged-smoke.mjs`, `scripts/shipping-runtime-smoke.mjs`, `scripts/electron-fuse-policy.mjs` | Actual shipping installer extraction, fuse checks and bounded startup/save/restart probes |
| `scripts/bench.mjs`, `tests/perf*.test.ts`, `tests/spatial-index.test.ts` | performance |
| `scripts/electron-fuses.mjs` | read-only compatibility helpers for shipping fuse validation |
| `scripts/release-provenance.mjs` | release provenance records and their verification |
| `scripts/mac-update-info.mjs` | writes the minimum macOS version into `latest-mac.yml` |
| `scripts/check-workflows.mjs` | workflow validation |
| `scripts/check-fixtures.mjs`, `tests/fixtures/manifest.json` | mandatory committed regression inputs |
| `e2e/output-scanner.mjs` | bounded screenshot output scanning |
| `scripts/bench-budgets.mjs` | asserted browser timing budgets |
| `scripts/release-provenance.mjs` | source SHA, installer completeness, artifact hashes and verified signing notes |
| `.github/workflows/ci.yml` | every push and pull request |
| `.github/workflows/release.yml` | gated installer builds and releases |
| `.github/workflows/packaged-smoke.yml` | manual smoke test of an existing release's installers |
| `.github/workflows/screenshot-baselines.yml` | manual regeneration of the screenshot baselines |

## Module map

Source files over 600 lines (measured on 0.4.1, `wc -l`), with the responsibilities each one
holds. The three largest were split along those lines (reliability review item 26, below); the
others keep one responsibility each or are tables of data and stay as they are for now.

| File | Lines | Responsibilities |
| --- | ---: | --- |
| `src/io/dxf.ts` | 2783 | split into `src/io/dxf/` (below); 19 lines now |
| `src/core/entities.ts` | 1699 | entity types, ids, bounds, grips and transforms, block / insert expansion, parts of dimensions, leaders and tables |
| `src/app/editor.ts` | 1685 | split into `src/app/editor/` (below); 7 lines now |
| `src/ui/electrical-dialogs.ts` | 1636 | the AutoCAD Electrical-style dialogs (component, catalog, terminal strip, properties, wire numbers) |
| `scripts/e2e-flows.mjs` | 1430 | multi-launch end-to-end flows (close / quit matrix, recovery, save errors) |
| `scripts/e2e-electron.mjs` | 1421 | single-launch Electron end-to-end checks |
| `src/ui/symbol-builder.ts` | 1403 | Symbol Builder dialogs and palette |
| `src/io/dwg.ts` | 1305 | LibreDWG database to `DrawingState` conversion |
| `src/electrical/symbol-builder-core.ts` | 1280 | Symbol Builder conversions (pure) |
| `src/core/dimension.ts` | 1216 | dimension styles, DIM* variables and dimension geometry |
| `electron/main.cjs` | 1111 | split into `electron/main/` (below); 138 lines now |
| `src/app/commands-electrical.ts` | 1105 | electrical commands (component data, catalog, wires, panel, project, reports) |
| `src/tools/symbol-builder.ts` | 1042 | Symbol Builder controller and commands |
| `src/app/commands-drafting.ts` | 987 | drafting commands on top of the Editor's basic set |
| `tests/interchange-fixtures.test.ts` | 933 | interchange fixture tests (one file per fixture set) |
| `src/tools/drafting-modify.ts` | 929 | FILLET, CHAMFER, ARRAY, STRETCH, BREAK, JOIN, LENGTHEN, ALIGN, MATCHPROP |
| `src/tools/layouts.ts` | 894 | layout commands and the layout controller |
| `src/electrical/symbols-power-fluid.ts` | 878 | symbol library data (power, PLC, fluid power) |
| `src/io/pdf-vector.ts` | 848 | vector PDF plotting |
| `src/tools/drafting-draw.ts` | 847 | PLINE, ELLIPSE, POINT, XLINE, RAY, DONUT, POLYGON, MTEXT, SPLINE |
| `src/ui/dimstyle.ts` | 838 | Dimension Style Manager |
| `src/app/api.ts` | 828 | the plugin / scripting API (`jcad`) |
| `src/ui/dialogs.ts` | 827 | general dialogs (symbol picker, layers, reports, templates) |
| `tests/project-file-safety.test.ts` | 822 | project file safety tests |
| `src/electrical/symbols-jic-control.ts` | 777 | symbol library data (JIC control) |
| `src/tools/dimension.ts` | 751 | dimensioning commands |
| `src/main.ts` | 748 | renderer start-up: browser file bridge, UI construction, wiring of hooks and UI commands |
| `src/electrical/iec-extended.ts` | 732 | symbol library data (IEC) |
| `src/electrical/symbols.ts` | 730 | built-in JIC symbol library |
| `src/electrical/wires.ts` | 726 | pure wire editing operations |
| `src/render/viewport.ts` | 722 | canvas viewport: view transform, zoom / pan, rendering |
| `src/app/plugins.ts` | 692 | plugin loading |
| `src/tools/electrical-wires.ts` | 680 | interactive wire and component editing tools |
| `src/tools/edit.ts` | 669 | TRIM, EXTEND, OFFSET, MIRROR, SCALE, EXPLODE, ZOOM Window |
| `tests/cross-track-integrity.test.ts` | 620 | cross-feature integrity tests |

The splits moved code without changing what it does: every public import path keeps working
(`src/io/dxf.ts`, `src/app/editor.ts` and `electron/main.cjs` are the entry points), the
interchange fixtures round-trip byte for byte, and the screenshots match their baselines.

**`src/io/dxf/`** - `src/io/dxf.ts` re-exports `readDxf`, `writeDxf`, `DxfReadError`,
`DxfReadOptions`, `insertScales`, `insertScaleFields`, `DIMSTYLE_APP` and `TABLE_APP` from:

| File | Lines | Responsibility |
| --- | ---: | --- |
| `codes.ts` | 35 | shared tables: XDATA application names, DIMENSION type numbers, group-code classes |
| `groups.ts` | 238 | the tokenizer (structure checks, recovery of a truncated file), `DxfReadError`, objects and group accessors |
| `dimstyles.ts` | 94 | DIMSTYLE records and header `$DIM*` variables, both directions |
| `writer.ts` | 448 | `writeDxf`: HEADER, CLASSES, TABLES, BLOCKS, ENTITIES and OBJECTS in file order |
| `write-core.ts` | 99 | the group-code writer, number format, the groups every entity starts with |
| `write-entities.ts` | 300 | `writeEntity` and the geometry codecs |
| `write-annotations.ts` | 230 | MTEXT, DIMENSION, LEADER, IMAGE and table codecs |
| `reader.ts` | 161 | `readDxf`: the section walk, then IMAGE paths, tables read from anonymous blocks, layers in use, paper space |
| `read-sections.ts` | 230 | one reader per section: HEADER (and the drawing header), TABLES, BLOCKS, ENTITIES, OBJECTS |
| `read-pass.ts` | 253 | the entity pass: followers folded, extrusion, unknown records reported or kept raw, LEADER -> MTEXT |
| `read-core.ts` | 54 | the read context, the properties every entity starts with, the import-report entry |
| `read-entities.ts` | 431 | `readEntityObj` and the geometry codecs (with TEXT / MTEXT fields and INSERT scales) |
| `read-annotations.ts` | 362 | DIMENSION, LEADER, MULTILEADER, IMAGE, ACAD_TABLE and JCad table codecs |

**`src/app/editor/`** - `src/app/editor.ts` re-exports the `Editor`, its types, `backupOutcome`
and `applyGrip`. The class (`editor.ts`) holds the state and every public member; each method
delegates to the module for its responsibility, passing the editor and, where needed, its
private working state (`internals.ts`). Public methods are still called through the instance,
so the plugin API's wrapper of `runCommand` and replaced `log` functions see every call.

| File | Lines | Responsibility |
| --- | ---: | --- |
| `editor.ts` | 440 | the `Editor`: state, events (`on`, `notify`), log and prompt, rendering, and the public methods |
| `types.ts` | 121 | events, command definitions, `FileBridge`, open results, `EditorHooks` |
| `internals.ts` | 62 | the private working state the modules share (overlay, selection request, drag, grips, tracking, save and project counters), the fallback UI |
| `commands.ts` | 172 | the built-in commands and the registration of the other command sets |
| `prompter.ts` | 217 | tools and the tool context, the command line, typed points and distances, Enter |
| `selection.ts` | 69 | LIST, objects into the selection or a selection request, pickable layers |
| `pointer.ts` | 250 | mouse input: snapped / tracked cursor, rollover, picking and selection boxes, grips, pan, wheel zoom |
| `keyboard.ts` | 80 | keys |
| `view.ts` | 60 | settings, drafting toggles, zoom extents |
| `documents.ts` | 227 | new / open into the right tab, files already open, import reports, Save / Don't Save / Cancel |
| `save.ts` | 81 | drawing saves through the save queue |
| `project.ts` | 179 | the project data, its counters and its file |
| `plotting.ts` | 93 | PLOT / PRINT |

**`electron/main/`** - `electron/main.cjs` stays the entry: it creates the IPC guard
(`electron/ipc-guard.cjs`), the rejection log, the path registry (`electron/path-registry.cjs`)
and the path policy - still the only way handlers are registered and paths are granted - and
hands them to the modules in one context (`context.cjs`). No module requires Electron's own
`ipcMain`; `tests/main-process-boundaries.test.ts` checks that across the files.

| File | Lines | Responsibility |
| --- | ---: | --- |
| `context.cjs` | 17 | the `MainContext` the modules share (guarded `ipcMain`, registry, policy, main window) |
| `app-data.cjs` | 58 | state files in the app-data folder, crash-safe user-file writes, `error.log` and crash logging |
| `window.cjs` | 224 | the main window: bounds, the close / quit / update-restart workflow, `app-quit` |
| `menu.cjs` | 137 | the native menu and File > Open Recent |
| `dwg.cjs` | 76 | DXF decoding, isolated DWG reading with progress and cancel |
| `ipc-drawings.cjs` | 292 | open / save drawings and projects, Save As paths, backups, IMAGE files |
| `ipc-plot.cjs` | 99 | plot to PDF, vector PDF, print |
| `ipc-stores.cjs` | 178 | autosave, user library, plugins, catalog packs |
| `updates.cjs` | 45 | app info, external links, update checks and status |
| `handover.cjs` | 86 | files handed over by the OS and by a second launch |

Shared by those modules, in `electron/`: `atomic-write.cjs` (temp file + rename, symbolic links
refused, folder pinned), `path-registry.cjs` and `ipc-guard.cjs` (what may be read or written,
who may call), `resource-limits.cjs` (size-checked reads, write payload and sheet size limits),
`dwg-host.cjs` (isolated DWG process, bounded requests/transport and deadlines),
`dwg-process-limits.cjs` (parent-side OS memory watchdog), `web-security.cjs` (permission
handlers and web contents guards), `updater.cjs` and `update-verify.cjs` (update checks and the
verification of a downloaded installer), `file-errors.cjs` (plain-language file errors).

The desktop DWG process owns a V8-limited worker; Electron utility-process `execArgv` heap flags
are not relied on to enforce its heap policy. `scripts/dwg-wasm-memory.mjs` restricts the shipped
module's memory declaration before the native factory allocates WASM memory. Production always
uses Electron's utility process with a parent-side OS memory reader: Electron metrics on
Windows/macOS and bounded `/proc` measurements on Linux. The Linux target PID, creation time
and start ticks bind readings to the same process. Node-only test/CLI adapters do not establish
shipping utility-process behavior. See
[DWG memory containment](DWG-MEMORY-CONTAINMENT.md) for limits and required validation evidence.

**Boundaries the tests hold.** The undo history is private to `src/core/document.ts` (use
`Drawing.history()` / `restoreHistory()`; `tests/history-api.test.ts` scans `src/`, `tests/`,
`scripts/`, `e2e/` and `electron/`); the Editor's private members stay inside `src/app/editor/`
(use `notify`, `setHover` ...; `tests/editor-boundaries.test.ts`); Electron's own `ipcMain` is
touched only by the guard in `electron/main.cjs` (`tests/main-process-boundaries.test.ts`).
