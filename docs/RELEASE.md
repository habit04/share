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
     empty tag. It runs the source, build, aggregate artifact and packaged smoke gates without
     publishing. Tag checks, release notes and signed attestation run when publication is enabled.
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
   | `checks` | ubuntu-latest, Node 22 / 24 | On the tagged commit: workflow validation, lint, `typecheck:all`, mandatory-fixture unit tests, dense Node performance, renderer and website builds, UI checks, screenshot scripts and approved baseline comparison, asserted browser performance, Electron end-to-end and legacy preference migration. Outputs the tested commit SHA. | everything below |
   | `build` | Windows, macOS, Linux | Checks out **that SHA**, checks tag/version when publishing, builds all five installers, signs when configured and verifies the final signatures or macOS ad-hoc seal. Requires the updater feeds and external blockmaps and records platform, version, built SHA, signing result and every public artifact's SHA-256 hash. Builder diagnostic YAML is excluded. | verify-artifacts, packaged-smoke, release |
   | `verify-artifacts` | ubuntu-latest | Downloads the actual uploaded platform artifacts and requires all five installers, three updater feeds and Windows/macOS external blockmaps, with matching source/version, sizes and hashes. Writes aggregate provenance/checksums. Also runs for an empty-tag build-only dispatch. | release |
   | `packaged-smoke` | Windows, macOS, Linux | Installs the NSIS installer silently, mounts each disk image (the x64 one under Rosetta) and extracts the AppImage and the `.deb`, then runs the headless DWG probe, end-to-end checks and two-launch secure-origin preference migration against each **packaged** application. Writes results per installer (`scripts/packaged-smoke.mjs`). | release |
   | `release` | ubuntu-latest | Verifies tag/tested SHA, downloads and verifies the complete public asset set again, writes aggregate provenance/checksums and adds actual signing results to the CHANGELOG notes. GitHub signs the complete verified artifact set with `actions/attest@v4`; publication follows all gates. | - |

   `npm run check:workflows` (run in CI and in `checks`) fails if any of these gates is removed.
4. **After publishing**: download one installer per platform from the release page and start
   it once; check that **Help > About** shows the new version and that an older installed
   version offers a signed-Windows update or the manual download appropriate to its installation.
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
The secure-origin migration gate applies from 0.4.1, including prereleases. It uses stock Electron
only to seed an isolated legacy profile, then launches the installed application twice. The
output includes `origin-migration.log`, per-installer `packaged-smoke-result.json` and an aggregate
`packaged-smoke-results.json`. Install/extract helpers and all application checks have process deadlines.

## What is signed, and how to verify it

| Platform | Artifact | Signature | Verify |
| --- | --- | --- | --- |
| Windows | `jcad-electrical-<v>-win-x64.exe` and the installed `JCad Electrical.exe` | Authenticode through Azure Artifact Signing when the seven `AZURE_*` secrets are set (publisher common name = `AZURE_PUBLISHER_NAME`); the workflow fails if any `.exe` lacks a valid signature from that exact publisher | PowerShell: `Get-AuthenticodeSignature .\jcad-electrical-<v>-win-x64.exe` shows `Valid` and the publisher; or `signtool verify /pa /v <file>`; or file Properties > Digital Signatures |
| macOS | `jcad-electrical-<v>-mac-arm64.dmg`, `...-mac-x64.dmg` | Developer ID + hardened runtime + notarization (stapled) when the five Apple secrets are set; otherwise an **ad-hoc** signature (`scripts/afterPack.cjs`), which keeps the bundle intact but is not an identity | `codesign --verify --deep --strict --verbose=2 "/Applications/JCad Electrical.app"`; `spctl --assess --type execute --verbose=4 "/Applications/JCad Electrical.app"` (Developer ID builds: "accepted, source=Notarized Developer ID"); `xcrun stapler validate "/Applications/JCad Electrical.app"` |
| Linux | `.AppImage`, `.deb` | not signed | compare the checksum below |
| All | `latest.yml`, `latest-mac.yml`, `latest-linux.yml` | written by electron-builder; electron-updater checks downloads against them (and, on Windows, the publisher name) | each installer's `sha512` (base64) is listed there: `openssl dgst -sha512 -binary <file> \| base64` must print the same value |
| All | `release-provenance.json`, platform records, `SHA256SUMS.txt`, installers and metadata | GitHub/Sigstore attestation of the complete verified release artifact set; separate from OS code signing | `gh attestation verify <download> --repo habit04/share --bundle release-provenance.sigstore.json` |

Signing never changes the build itself: without secrets the workflow produces the same
unsigned (Windows, Linux) or ad-hoc signed (macOS) installers as before.

`scripts/release-provenance.mjs` rejects missing installers, updater feeds or required external
blockmaps, extra installers, duplicate platform records, changed bytes, and any record with a
different source SHA or version. The AppImage's blockmap is embedded. Linux artifact architectures
are `x86_64` for AppImage and `amd64` for deb, as electron-builder names them. Each build validates
its checked-out `HEAD` against the checks job's SHA before recording hashes. Build-only and
publication jobs validate again after downloading the artifacts. Signing labels describe checks that passed in CI:
`unsigned`, `authenticode-verified`, `ad-hoc`, or `developer-id-notarized`.

The [GitHub attestation action](https://github.com/actions/attest) signs with an OIDC-issued
certificate and publishes a verifiable bundle. It proves workflow origin and artifact bytes; an
attestation does not make an unsigned Windows installer Authenticode signed or an ad-hoc macOS
app notarized. Signed OS release paths still require the maintainer's Azure or Apple credentials.
Older releases can lack provenance assets. Verify the specific release's published evidence.

## How updates reach users

- The application asks GitHub Releases for the latest non-prerelease version a few seconds
  after start-up and on **Help > Check for Updates…** (`CHECKUPDATES`).
- **Windows (NSIS) with a trusted publisher configured** updates in place through electron-updater:
  it reads `latest.yml`, downloads after consent, checks SHA-512 and the signature publisher,
  and installs when the application
  restarts (the unsaved-work prompt runs first).
- **Unsigned Windows, macOS and all Linux builds** are told that a newer release exists and offered the matching
  download; they are replaced by installing the new version over the old one.
- Users only see a release once it is published (the `release` job is the last step), so a
  failed gate never reaches anyone.
- Download counts are watched by the hourly **Download alerts** workflow (README).

## Routine dependency review

Once a month, and before every release:

- [ ] `npm ci` on supported Node 22 and 24 releases, then **`npm audit`** (all dependencies). Do not rely on
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

**Recorded dependency review, 2026-10-11:** the updated lockfile uses Electron 44.7.0, Vitest
5.0.3, Vite 6.4.3, esbuild 0.25.12 and electron-builder 26.17.0. The scoped
`@electron/get` → `global-agent ^4.1.3` override removes the obsolete `roarr` / `sprintf-js`
tooling chain while retaining builder's Azure signing API. Its CommonJS bootstrap/proxy API was
checked with a local HTTP proxy smoke test. Both full and production-only audit must be rerun for
each release; the full audit after these updates reported **0 vulnerabilities**. That result is
a dated dependency check, not proof that every future advisory is covered.
