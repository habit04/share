# Release process

How a JCad Electrical release is cut, what the pipeline checks before anything is published,
what is signed and how to verify a download, how updates reach users, and the routine
dependency review. Setup for development is in [DEVELOPMENT.md](DEVELOPMENT.md); signing
accounts and secrets in [CODE-SIGNING.md](CODE-SIGNING.md).

## Current desktop release policy

New desktop releases are **Windows x64 only**. macOS and Linux releases are paused at
[v0.4.5](https://github.com/habit04/share/releases/tag/v0.4.5); their existing installers remain
available, but do not include subsequent Windows features or fixes. Portable application code,
historical signing tools and package targets are retained for a future return. The browser
edition remains available on supported browsers. Generic source and browser checks still run
on Ubuntu; that runner does not produce a Linux desktop installer.

The workflow explicitly verifies `--policy windows-only`. This policy requires the Windows
installer, `latest.yml`, external NSIS blockmap and Windows provenance, rejects other platform
records or untracked release assets, and writes `releasePolicy: "windows-only"` in the aggregate.
Publication also verifies `--require-signing`; an unsigned rehearsal can never pass that gate.
Library callers verifying older releases may omit the policy or explicitly use `all-platforms`;
the historical contract still requires all three platforms and all five installers.

## Cutting a release

1. **Prepare on the release branch.**
   - Bump `"version"` in `package.json` (and `package-lock.json`: `npm version <x.y.z> --no-git-tag-version`).
   - Move the `[Unreleased]` entries of `CHANGELOG.md` under `## [x.y.z] - <date>` (they become
     the release notes: `npm run release-notes -- vX.Y.Z --policy windows-only`
     shows them as the release page will, without the **Verified build** list the release job adds).
   - Make sure CI is green on the branch (`ci.yml`: source/browser tests on Ubuntu and native desktop e2e on Windows).
   - Optional dress rehearsal: run **Build installers** from the Actions tab on the branch with an
     empty tag. It runs the source, test-ASAR, build, aggregate artifact and shipping smoke gates without
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
   | `test-build` | Windows x64 | Builds a separate unpublished inspection-enabled ASAR and runs the full packaged Playwright suite and preference restart checks. Checks its test fuse policy. Its metadata, output folder and artifact naming keep it separate from shipping uploads. | build, release |
   | `build` | Windows x64 | Checks out **that SHA**, checks tag/version when publishing, builds the NSIS installer with inspection disabled, verifies binary fuses, verifies final Windows publisher signatures. Publication requires Windows signing credentials. Requires updater feeds/blockmaps and records source, signing/fuse results and artifact hashes. Builder diagnostic YAML and test builds are excluded. | verify-artifacts, packaged-smoke, release |
   | `verify-artifacts` | ubuntu-latest | Downloads the actual uploaded platform artifacts and requires exactly the Windows installer, updater feed and external blockmap, with matching source/version, sizes and hashes. Writes aggregate provenance/checksums. Also runs for an empty-tag build-only dispatch. | release |
   | `packaged-smoke` | Windows x64 | Installs NSIS and requires the native architecture. Checks exact shipping fuses, DWG reading and bounded first-launch/save/reopen probes, including secure-origin preference migration and preservation. Confirms debugging arguments are refused. Writes results per installer (`scripts/packaged-smoke.mjs`). | release |
   | `release` | ubuntu-latest | Verifies tag/tested SHA, downloads and verifies the complete public asset set again, renders the CHANGELOG notes and Windows-only download footer from verified signing provenance (`scripts/release-notes.mjs --strict --provenance artifacts`), and writes aggregate provenance/checksums and the **Verified build** list. GitHub signs the complete verified artifact set with `actions/attest@v4`; publication follows all gates and targets the tested SHA. | - |

   `npm run check:workflows` (run in CI and in `checks`) fails if any of these gates is removed.

   For an unsigned-helper block on a Windows development machine, **Build installers** also
   accepts `native_helper_only=true` with an empty tag. This isolated job checks the exact
   dispatched commit, runs helper supply-chain/signing tests and locked native tests, requires
   the configured publisher, signs before hashing, and uploads the helper bundle, matching
   embedded integrity manifest and source provenance. It cannot create a release or installer.
   Download that private build artifact and verify its signature, hashes and source SHA before
   using it locally. This helper test does not replace the normal installer publication gates.
4. **After publishing**: download the Windows installer from the release page and start
   it once; check that **Help > About** shows the new version and that an older installed
   version offers a signed Windows update.
5. If something is wrong after publishing: mark the release as a pre-release or delete it (the
   updater only follows the latest non-prerelease release), fix, and release a new patch
   version. Never move or re-use a published tag; the updater compares versions, not tags.

Releases up to 0.4.0 were published with an empty description. `docs/releases/v0.4.0.md` is the
text for the 0.4.0 release page (`npm run release-notes -- v0.4.0 --mac-signing ad-hoc`). The manual
**Release notes** workflow writes it for you: Actions > Release notes > **Run workflow**, tag `v0.4.0`;
it renders the tag's `CHANGELOG.md` section with the same script and updates the release description
(the installers stay as they are). For a release that published `release-provenance.json` (0.4.2 on)
it renders the footer's macOS sentence and the **Verified build** list from that record, so a
rewritten page keeps them; older releases get a neutral macOS sentence. Pasting by hand (**Edit**,
paste, **Update release**) works too. `docs/releases/v0.4.2.md` keeps the 0.4.2 notes
(`node scripts/release-notes.mjs v0.4.2 --strict --mac-signing developer-id-notarized --out docs/releases/v0.4.2.md`),
the text the release workflow publishes before the **Verified build** list.
`docs/releases/v0.4.3.md` keeps the new release's notes, generated with the same command for v0.4.3;
`tests/release-notes.test.ts` checks all three snapshots against `CHANGELOG.md`.

The manual **Packaged smoke test (existing release)** workflow re-runs the packaged checks
against the Windows installer attached to any published release (for example after a runner image or
OS update); checks for features newer than that release are skipped.

From Windows v0.5.1, installer acceptance requires the reviewed disposable GitHub-hosted Windows
job. Before the first NSIS launch it refuses existing JCad registrations/processes, verifies the
installer's actual publisher/version and statically inventories its complete payload. The installed
application and native helper must have valid publisher signatures, and shipping fuses must pass
before either executable runs. A folder alone or an older local installation cannot satisfy this
installer gate. Unsigned build-only artifacts do not clear this installed acceptance; use
`require_signing=true` for the release rehearsal. Local ordinary-folder checks remain separate through
`shipping-runtime-smoke.mjs <exact-executable>` and do not establish installer or publisher trust.

The hosted gate also runs the fixed GPU and GPU/3D phases, an actual upgrade from the hash-pinned
published v0.5.0 installer, and rollback with restored pre-upgrade private profiles. Its GPU receipts
remain under the uploaded per-installer output. Physical Intel/NVIDIA and genuine private SHX checks
are separately attributed and bound to the same signed payload. See
[WINDOWS-UPGRADE-INTEGRATION.md](WINDOWS-UPGRADE-INTEGRATION.md) for the current execution status;
implemented tooling alone is not a completed native gate.

The secure-origin migration gate applies from 0.4.1, including prereleases. It uses stock Electron
only to seed an isolated legacy profile, then launches the installed application twice. The
output includes `origin-migration.log`, per-installer `packaged-smoke-result.json` and an aggregate
`packaged-smoke-results.json`. Install/extract helpers and all application checks have process deadlines.

## What is signed, and how to verify it

The macOS/Linux rows below document historical releases through v0.4.5. New releases contain
only the Windows installer/feed/blockmap and its source-bound provenance and attestation.

| Platform | Artifact | Signature | Verify |
| --- | --- | --- | --- |
| Windows | `jcad-electrical-<v>-win-x64.exe` and the installed `JCad Electrical.exe` | Authenticode through Azure Artifact Signing when the seven `AZURE_*` secrets are set (publisher common name = `AZURE_PUBLISHER_NAME`); the workflow fails if any `.exe` lacks a valid signature from that exact publisher | PowerShell: `Get-AuthenticodeSignature .\jcad-electrical-<v>-win-x64.exe` shows `Valid` and the publisher; or `signtool verify /pa /v <file>`; or file Properties > Digital Signatures |
| macOS | `jcad-electrical-<v>-mac-arm64.dmg`, `...-mac-x64.dmg` | Developer ID + hardened runtime + notarization (stapled) when the five Apple secrets are set; required for historical Mac publication; new Mac releases are paused. Empty-tag rehearsals without credentials and with `require_signing` disabled use an **ad-hoc** signature (`scripts/afterPack.cjs`), which keeps the bundle intact but is not an identity | `codesign --verify --deep --strict --verbose=2 "/Applications/JCad Electrical.app"`; `spctl --assess --type execute --verbose=4 "/Applications/JCad Electrical.app"` (Developer ID builds: "accepted, source=Notarized Developer ID"); `xcrun stapler validate "/Applications/JCad Electrical.app"` |
| Linux | `.AppImage`, `.deb` | not signed | compare the checksum below |
| All | `latest.yml`, `latest-mac.yml`, `latest-linux.yml` | written by electron-builder; electron-updater checks downloads against them (and, on Windows, the publisher name), and the application checks the downloaded installer again before installing it (`electron/update-verify.cjs`) | each installer's `sha512` (base64) is listed there: `openssl dgst -sha512 -binary <file> \| base64` must print the same value |
| All | `release-provenance.json`, the platform records, `SHA256SUMS.txt`, installers and metadata | GitHub / Sigstore attestation of the complete verified artifact set (from the release after 0.4.1); separate from OS code signing | `gh attestation verify <download> --repo habit04/share --bundle release-provenance.sigstore.json`; `sha256sum -c SHA256SUMS.txt` |

An empty-tag build-only rehearsal may produce an unsigned Windows installer when credentials
are absent. `require_signing` makes even a rehearsal require Windows signing credentials.
Publishing always requires the configured Windows publisher; missing secrets fail before the
installer is built. Its actual signature verification must pass; secret presence alone does not
prove signing. Apple credentials are retained for historical support but are no longer used by
the current release workflow.

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
  and installs only through **Restart Now**, after the unsaved-work prompt and a fresh
  checksum/publisher verification. Ordinary quitting does not install an update; **Later**
  leaves it available through Check for Updates.
- **Historical unsigned Windows, macOS and Linux builds** offer manual installation when a matching
  installer exists in the release; they are replaced by installing that version over the old one. New Mac/Linux installers are paused at v0.4.5. On macOS the
  release's `latest-mac.yml` declares `minimumSystemVersion`, written from `package.json` by
  `scripts/mac-update-info.mjs`. A Mac below that minimum is told the requirement and is not
  offered the incompatible installer. Keep the minimum-version warning at the start of release
  notes because versions through 0.4.1 cannot enforce this metadata check.
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

**Release dependency check, 2026-10-12:** both the full and production-only audit of the
locked 0.4.6 dependencies reported **0 vulnerabilities** before publication.
