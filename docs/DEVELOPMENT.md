# Development guide

How to set up, run, test, package and release JCad Electrical from source, and how to check a
change from end to end before it is merged. Release mechanics are in [RELEASE.md](RELEASE.md),
signing in [CODE-SIGNING.md](CODE-SIGNING.md), performance numbers in
[PERFORMANCE.md](PERFORMANCE.md).

Contents: [Prerequisites](#prerequisites) · [Install](#install) · [Run](#run) ·
[Checks](#checks) · [Tests](#unit-and-regression-tests) · [Screenshots](#screenshots) ·
[End-to-end](#end-to-end-tests) · [Performance](#performance) · [Packaging](#packaging) ·
[Signing and release](#signing-and-release) · [Verifying a change](#verifying-a-change-end-to-end) ·
[Layout of the tooling](#layout-of-the-tooling)

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
