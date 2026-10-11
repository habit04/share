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
| Node.js | **22.x** (22.6 or later; `.nvmrc` / `.node-version` say `22`, `package.json` `engines` says `>=22.6.0 <23`) | nodejs.org installer, `nvm-windows` or `fnm` | `nvm`, `fnm` or Homebrew `node@22` | `nvm`, `fnm` or NodeSource |
| npm | the one bundled with Node 22 (10.x) | | | |
| Git | any recent | Git for Windows (Git Bash runs the shell snippets below) | Xcode command-line tools | distribution package |
| Native build tools | not needed (no native modules) | | | |
| For `npm run e2e` | the Electron binary that `npm ci` downloads | | | a display: `xvfb-run` (package `xvfb`) on a server or in a container |
| For screenshots / UI check / bench | a Chromium for Playwright (below) | | | `npx playwright install --with-deps chromium` installs Chromium and its system libraries and fonts |
| For packaging | | NSIS is bundled by electron-builder | Xcode command-line tools (`codesign`, `hdiutil`) | `dpkg-deb` comes with Debian / Ubuntu; AppImage needs nothing extra |

`.npmrc` sets `engine-strict=true`: `npm ci` / `npm install` on any other Node major version stops
at once with `EBADENGINE` and the required range, instead of failing later in a confusing way.
With `nvm` or `fnm`, `nvm use` / `fnm use` in the repository picks the version from `.nvmrc`.

**Version used in CI and in the development container.** CI installs Node from `.nvmrc`
(`actions/setup-node` with `node-version-file`), i.e. the newest 22.x release on the day the
job runs. The development container used for this work runs Node **22.22.2** with npm 10.9.7, so
there is no major-version gap; the only difference is the patch level, which can move ahead in CI
before it does locally. Its Playwright Chromium is older than the one CI installs (see
[Screenshots](#screenshots)), which matters only for pixel comparisons.

## Install

```bash
git clone https://github.com/habit04/share.git
cd share
npm ci                      # exact versions from package-lock.json; downloads the Electron binary
```

Optional environment variables for `npm ci`:

- `ELECTRON_SKIP_BINARY_DOWNLOAD=1` when you only work on the renderer (no `npm run e2e` / `npm start`).
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

```bash
npm test                    # vitest run: every tests/**/*.test.ts (includes the DWG fixtures in fixtures/)
npx vitest run tests/dxf.test.ts          # one file
npx vitest                  # watch mode
```

Timing budgets in `tests/perf.test.ts` are about three times the development machine; set
`JCAD_PERF_FACTOR=2` on slower machines (CI does). The heavy dense-drawing benchmarks only run
with `npm run bench:node` (see [Performance](#performance)).

## Screenshots

The screenshot scripts (`scripts/screenshot*.mjs`) drive the built renderer and website in
headless Chromium; `e2e/run-screenshots.mjs` runs them all as gates (page errors, console errors,
failed checks and unknown commands fail it). Every resulting `screenshots/*.png` is then compared
with its **approved baseline** in `screenshots/baseline/`:

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
```

`scripts/e2e-electron.mjs` launches Electron on `dist/` with Playwright and drives the real main
process, preload bridge and IPC (native dialogs are replaced inside the main process; see the
file header for the full list of checks). The same script tests a **packaged** application:

```bash
npm run e2e:packaged -- "release/win-unpacked/JCad Electrical.exe"
xvfb-run -a npm run e2e:packaged -- release/linux-unpacked/jcad-electrical
node scripts/packaged-smoke.mjs release/     # installs / mounts / extracts every installer in release/ for this OS
```

`scripts/packaged-smoke.mjs` runs the NSIS installer silently (`/S /D=<temp folder>`), mounts a
disk image with `hdiutil attach` and copies the `.app` out, or extracts an AppImage
(`--appimage-extract`) or a `.deb` (`dpkg-deb -x`); then it runs the headless DWG probe
(`--probe-dwg`) and the end-to-end checks against the packaged executable.

## Performance

```bash
npm run bench:node                  # pick / select / snap on 50,000 entities, with and without the spatial index; 20-drawing project reports
npm run build && npm run bench      # rendering, hover and window selection in headless Chromium
```

Numbers and method: [PERFORMANCE.md](PERFORMANCE.md).

## Packaging

```bash
npm run dist:dir            # unpacked app in release/<platform>-unpacked (fast; no installer)
npm run dist                # installers for this OS (electron-builder; see package.json "build")
```

electron-builder only builds installers for the OS it runs on (macOS disk images need macOS).
The release workflow builds all three on GitHub's runners; locally, `npm run dist:dir` plus
`npm run e2e:packaged` is the quickest way to test a packaged build.

## Signing and release

- Signing is optional per platform and switches on from repository secrets; see
  [CODE-SIGNING.md](CODE-SIGNING.md). Local builds are unsigned (macOS: ad-hoc signed by
  `scripts/afterPack.cjs`).
- Releases are cut by pushing a `v<version>` tag (or running **Build installers** with a tag);
  the pipeline, its gates and how to verify a published build are in [RELEASE.md](RELEASE.md).

## Verifying a change end to end

Before opening a pull request, on Node 22:

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
npm run bench:node                  # when selection, snapping, reports or geometry changed
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
| `scripts/e2e-electron.mjs`, `scripts/packaged-smoke.mjs` | Electron end-to-end, development and packaged |
| `scripts/bench.mjs`, `tests/perf*.test.ts`, `tests/spatial-index.test.ts` | performance |
| `scripts/check-workflows.mjs` | workflow validation |
| `.github/workflows/ci.yml` | every push and pull request |
| `.github/workflows/release.yml` | gated installer builds and releases |
| `.github/workflows/packaged-smoke.yml` | manual smoke test of an existing release's installers |
| `.github/workflows/screenshot-baselines.yml` | manual regeneration of the screenshot baselines |

## Module map

Source files over 600 lines (measured on 0.4.1, `wc -l`), with the responsibilities each one
holds. The first three are split along those lines (reliability review item 26); the others keep
one responsibility each or are tables of data and stay as they are for now.

| File | Lines | Responsibilities |
| --- | ---: | --- |
| `src/io/dxf.ts` | 2783 | DXF writing (group-code writer, entity codecs per type, HEADER / CLASSES / TABLES / BLOCKS / ENTITIES / OBJECTS sections); the DIMSTYLE record codec both sides share; DXF reading (tokenizer and structure checks, group accessors, entity codecs per type, section readers, import report, raw records) |
| `src/core/entities.ts` | 1699 | entity types, ids, bounds, grips and transforms, block / insert expansion, parts of dimensions, leaders and tables |
| `src/app/editor.ts` | 1685 | the `Editor`: drawing tabs and documents (new / open / deliver to a tab), command registry and the built-in commands, command line and prompter (tool context, typed input, Enter), selection, view / zoom and drafting toggles, pointer and keyboard input, save coordination (save queue, project save), plot / print, events and UI hooks |
| `src/ui/electrical-dialogs.ts` | 1636 | the AutoCAD Electrical-style dialogs (component, catalog, terminal strip, properties, wire numbers) |
| `scripts/e2e-flows.mjs` | 1430 | multi-launch end-to-end flows (close / quit matrix, recovery, save errors) |
| `scripts/e2e-electron.mjs` | 1421 | single-launch Electron end-to-end checks |
| `src/ui/symbol-builder.ts` | 1403 | Symbol Builder dialogs and palette |
| `src/io/dwg.ts` | 1305 | LibreDWG database to `DrawingState` conversion |
| `src/electrical/symbol-builder-core.ts` | 1280 | Symbol Builder conversions (pure) |
| `src/core/dimension.ts` | 1216 | dimension styles, DIM* variables and dimension geometry |
| `electron/main.cjs` | 1111 | the main process: IPC guard and path registry set-up, app-data state files, window (bounds, close / quit workflow), native menu, IPC handlers (drawings and projects, DWG reading, plot / print, autosave, user library, plugins, catalog packs, images, app info), updater wiring, files handed over by the OS and the second instance, crash logging |
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

**Planned splits.** Pure moves: no logic changes, every public import path keeps working.

- `src/io/dxf.ts` becomes a façade over `src/io/dxf/`: shared tables (application names), the
  DIMSTYLE codec, the writer side (group-code writer, entity codecs, section writers) and the
  reader side (tokenizer and group accessors, read context, entity codecs, section readers).
- `src/app/editor.ts` re-exports the `Editor` from `src/app/editor/`: the class keeps its public
  members and delegates to one module per responsibility (types and hooks, events, built-in
  commands, prompter and command line, selection and pointer input, view and toggles, keyboard,
  documents and tabs, save coordination, project, plot).
- `electron/main.cjs` stays the entry and wires `electron/main/`: app-data state files and
  diagnostics, window and close workflow, menu, IPC handlers by area (drawings and projects,
  plot and print, app-data stores, app and updates), and files handed over by the OS. The IPC
  guard (`electron/ipc-guard.cjs`) and the path registry (`electron/path-registry.cjs`) stay the
  only way handlers are registered and paths are granted.

