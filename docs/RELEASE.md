# Release process

How a JCad Electrical release is cut, what the pipeline checks before anything is published,
what is signed and how to verify a download, how updates reach users, and the routine
dependency review. Setup for development is in [DEVELOPMENT.md](DEVELOPMENT.md); signing
accounts and secrets in [CODE-SIGNING.md](CODE-SIGNING.md).

## Cutting a release

1. **Prepare on the release branch.**
   - Bump `"version"` in `package.json` (and `package-lock.json`: `npm version <x.y.z> --no-git-tag-version`).
   - Move the `[Unreleased]` entries of `CHANGELOG.md` under `## [x.y.z] - <date>` (they become
     the release notes: `npm run release-notes -- vX.Y.Z` shows them as the release page will).
   - Make sure CI is green on the branch (`ci.yml`: test, ui, e2e on Ubuntu / Windows / macOS).
   - Optional dress rehearsal: run **Build installers** from the Actions tab on the branch with an
     empty tag. It runs every gate below and builds and smoke-tests the installers without
     publishing.
2. **Tag the exact commit** and push the tag:

   ```bash
   git tag -a vX.Y.Z -m "JCad Electrical X.Y.Z"
   git push origin vX.Y.Z
   ```

   (Alternatively run **Build installers** with the tag name: the release is then created at the
   commit the workflow ran on.)
3. **The pipeline** (`.github/workflows/release.yml`) runs:

   | Job | Runs on | What it does | Blocks |
   | --- | --- | --- | --- |
   | `checks` | ubuntu-latest | On the tagged commit: workflow validation, lint, `typecheck:all`, unit tests, the dense Node performance run (`bench:node`), renderer build, website build, UI click check, screenshot scripts and **comparison with the approved baselines**, the browser performance budgets (`bench`, asserted), Electron end-to-end. Outputs the commit SHA it tested. | everything below |
   | `build` | Windows, macOS, Linux | Checks out **that SHA**, checks that the tag equals `v` + `package.json` version, builds the installers (NSIS `.exe`, `.dmg` arm64 + x64, `.AppImage` + `.deb`), signs them when the secrets exist and verifies the signatures (Windows: valid and from exactly the `AZURE_PUBLISHER_NAME` publisher; macOS ad-hoc builds: the seal after the fuse changes), then records platform, version, built SHA, signing result and the SHA-256 of every artifact in `JCad-Electrical-<platform>-provenance.json` (`scripts/release-provenance.mjs build`). | packaged-smoke, release |
   | `packaged-smoke` | Windows, macOS, Linux | Installs the NSIS installer silently, mounts each disk image (the x64 one under Rosetta) and extracts the AppImage and the `.deb`, then runs the headless DWG probe, checks the Electron fuses the build ships with (`scripts/electron-fuses.mjs`) and runs the end-to-end checks against each **packaged** application (its copy with `--inspect` switched back on for Playwright): start-up, open a DXF and a DWG fixture, large-DWG progress and Cancel, save, autosave / recovery copy, vector PDF, IPC guard, clean close, no error log (`scripts/packaged-smoke.mjs`). | release |
   | `release` | ubuntu-latest | Verifies that the tag points at the SHA the checks ran on (a tag moved after the push, or an existing tag elsewhere for a manual run, stops it; deleted remote tags are pruned first), writes the release notes from the tag's `CHANGELOG.md` section (`scripts/release-notes.mjs --strict`: no section, no release), verifies every platform's provenance against the tested SHA, the version, the five expected installers and the downloaded bytes, adds each build's signing result to the notes and writes `release-provenance.json` and `SHA256SUMS.txt` (`scripts/release-provenance.mjs verify`), has GitHub sign the verified artifact set (`actions/attest`, bundle `release-provenance.sigstore.json`), then publishes the GitHub Release with those notes and files, targeting that SHA (failing on any unmatched file). | - |

   `npm run check:workflows` (run in CI and in `checks`) fails if any of these gates is removed.
4. **After publishing**: download one installer per platform from the release page and start
   it once; check that **Help > About** shows the new version and that an older installed
   version offers the update (Windows / AppImage) or the download (macOS / `.deb`).
5. If something is wrong after publishing: mark the release as a pre-release or delete it (the
   updater only follows the latest non-prerelease release), fix, and release a new patch
   version. Never move or re-use a published tag; the updater compares versions, not tags.

Releases up to 0.4.0 were published with an empty description. `docs/releases/v0.4.0.md` is the
text for the 0.4.0 release page (`npm run release-notes -- v0.4.0`). The manual **Release notes**
workflow writes it for you: Actions > Release notes > **Run workflow**, tag `v0.4.0`; it renders the
tag's `CHANGELOG.md` section with the same script and updates the release description (the
installers stay as they are). Pasting it by hand (**Edit**, paste, **Update release**) works too.

The manual **Packaged smoke test (existing release)** workflow re-runs the packaged checks
against the installers attached to any published release (for example after a runner image or
OS update); checks for features newer than that release are skipped.

## What is signed, and how to verify it

| Platform | Artifact | Signature | Verify |
| --- | --- | --- | --- |
| Windows | `jcad-electrical-<v>-win-x64.exe` and the installed `JCad Electrical.exe` | Authenticode through Azure Artifact Signing when the seven `AZURE_*` secrets are set (publisher name = `AZURE_PUBLISHER_NAME`); the workflow fails if any `.exe` is not validly signed | PowerShell: `Get-AuthenticodeSignature .\jcad-electrical-<v>-win-x64.exe` shows `Valid` and the publisher; or `signtool verify /pa /v <file>`; or file Properties > Digital Signatures |
| macOS | `jcad-electrical-<v>-mac-arm64.dmg`, `...-mac-x64.dmg` | Developer ID + hardened runtime + notarization (stapled) when the five Apple secrets are set; otherwise an **ad-hoc** signature (`scripts/afterPack.cjs`), which keeps the bundle intact but is not an identity | `codesign --verify --deep --strict --verbose=2 "/Applications/JCad Electrical.app"`; `spctl --assess --type execute --verbose=4 "/Applications/JCad Electrical.app"` (Developer ID builds: "accepted, source=Notarized Developer ID"); `xcrun stapler validate "/Applications/JCad Electrical.app"` |
| Linux | `.AppImage`, `.deb` | not signed | compare the checksum below |
| All | `latest.yml`, `latest-mac.yml`, `latest-linux.yml` | written by electron-builder; electron-updater checks downloads against them (and, on Windows, the publisher name), and the application checks the downloaded installer again before installing it (`electron/update-verify.cjs`) | each installer's `sha512` (base64) is listed there: `openssl dgst -sha512 -binary <file> \| base64` must print the same value |
| All | `release-provenance.json`, the platform records, `SHA256SUMS.txt`, installers and metadata | GitHub / Sigstore attestation of the complete verified artifact set (from the release after 0.4.1); separate from OS code signing | `gh attestation verify <download> --repo habit04/share --bundle release-provenance.sigstore.json`; `sha256sum -c SHA256SUMS.txt` |

Signing never changes the build itself: without secrets the workflow produces the same
unsigned (Windows, Linux) or ad-hoc signed (macOS) installers as before.

`scripts/release-provenance.mjs` (ported from PR #2) rejects missing or extra installers,
duplicate platform records, changed bytes, and any record with a different source SHA or version;
each build checks its checked-out `HEAD` against the checks job's SHA before recording hashes. The
signing labels state what passed in CI: `unsigned`, `authenticode-verified`, `ad-hoc` or
`developer-id-notarized`. The attestation proves the workflow origin and the bytes; it does not
make an unsigned Windows installer Authenticode signed or an ad-hoc macOS app notarized.

## How updates reach users

- The application asks GitHub Releases for the latest non-prerelease version a few seconds
  after start-up and on **Help > Check for Updates…** (`CHECKUPDATES`).
- **Windows (NSIS) and Linux AppImage** update in place through electron-updater: it reads
  `latest.yml` / `latest-linux.yml`, downloads the new installer after the user agrees, checks
  its SHA-512 (and on Windows its signature publisher) and installs it when the application
  restarts (the unsaved-work prompt runs first).
- **macOS and Linux `.deb`** are told that a newer release exists and offered the matching
  download; they are replaced by installing the new version over the old one.
- Users only see a release once it is published (the `release` job is the last step), so a
  failed gate never reaches anyone.
- Download counts are watched by the hourly **Download alerts** workflow (README).

## Routine dependency review

Once a month, and before every release:

- [ ] `npm ci` on Node 22, then **`npm audit`** (all dependencies). Do not rely on
      `npm audit --omit=dev`: `electron` is a development dependency but its runtime ships inside
      every installer, so its advisories matter to users. Triage each advisory: shipped
      (runtime dependencies, Electron), build-only (electron-builder and its tools), or
      test-only (vitest, Playwright, ESLint).
- [ ] `npm outdated`; update patch and minor versions of runtime dependencies
      (`@mlightcad/libredwg-web`, `electron-updater`, `hershey`) and re-run the full
      [verification](DEVELOPMENT.md#verifying-a-change-end-to-end), including the DWG fixtures.
- [ ] **Electron**: Electron supports the latest three stable major versions and ships a new
      major about every eight weeks, so a major version is out of support roughly six months
      after its release. Stay on a supported major: plan an upgrade at least every second Electron
      major (about every four months), and take security point releases of the current major
      as soon as they appear. After an upgrade, run `npm run e2e`, the packaged smoke test (a
      **Build installers** run without a tag) and check the release notes for changes to
      `contextIsolation`, sandboxing, `webFrame.executeJavaScript` (plugins) and `printToPDF`.
- [ ] Playwright: after an update its Chromium changes, so the screenshot baselines may need
      the **Screenshot baselines** workflow (DEVELOPMENT.md, "Screenshots").
- [ ] GitHub Actions: bump the `actions/*` and `softprops/action-gh-release` major versions when
      GitHub deprecates the old ones; `npm run check:workflows` must stay green.
- [ ] Licences: every new or changed dependency gets its row in `THIRD-PARTY-NOTICES.md`
      (`tests/about.test.ts` fails when a direct dependency is missing).
- [ ] Record what was updated (or why not) in the `[Unreleased]` section of `CHANGELOG.md`.

**State at the time of writing (October 2026), after the move to Electron 44.7.0 and Vitest 5:**
`npm audit` reports 12 advisories (2 critical, 2 high, 8 moderate), none of them in what ships:
`shell-quote` under `concurrently` (the `electron:dev` script runner), `global-agent` / `roarr` /
`sprintf-js` and `http-cache-semantics` under the Electron download that electron-builder does
while packaging (`app-builder-lib` -> `@electron/get` 3), and `source-map-js` under Vite's PostCSS
(build only). The Electron runtime and the test runner advisories (Electron 33, Vitest 2 and its
pool, the old Vite / esbuild copies) are gone. `npm audit --omit=dev` reports none, which is
exactly why it must not be used alone. Electron 44 is a supported major; plan the next upgrade
by the rule above.
