# Electrical review remediation — October 11, 2026

Baseline: `5dfd8c22a86d7ce681c9e5870a1f1128059dcae1` of `habit04/share`.
Work is isolated on `codex/electrical-review-fixes`; the original checkout is preserved.
The default branch's module refactor through `648e063f6dd8ee424162418faa47c96cce041583`
is retained, with fixes carried into the split editor, DXF and Electron modules.
The table tracks the 53 follow-up recommendations. “Implemented” describes the code and
behavioral checks. Installer execution and signing results are reported separately in the
pull request, with workflow links tied to its exact source commit.

| # | Recommendation and reason | Result and evidence |
| --- | --- | --- |
| 1 | Keep failed replacement writes atomic; copying over the destination can truncate the only good file. | Implemented: rename retries fail without destructive copy fallback. `electron/atomic-write.cjs`, `tests/file-safety.test.ts`. |
| 2 | Order project saves and check revisions; a late save must not clear newer edits or replace another project. | Implemented: save chain, project generation/revision guards, and snapshot capture. `src/app/editor/project.ts`, `src/app/editor/save.ts`, `tests/project-file-safety.test.ts`. |
| 3 | Give each project recovery copy a unique owner; same-name/untitled projects can otherwise overwrite unrelated backups. | Implemented: UUID ownership per project generation; only explicit recovery adopts an existing backup. `src/app/project-autosave.ts`, `tests/cross-track-integrity.test.ts`. |
| 4 | Warn when Save As resolves to the original lossy import; choosing that same path can still destroy unsupported data. | Implemented: compare the actual chosen path and recheck session/revision/report after dialogs. `src/app/import-open.ts`, `src/app/editor/save.ts`, `tests/import-open-editor.test.ts`. |
| 5 | Warn before batch rewriting closed imported drawings; their loss reports must not disappear because no tab is open. | Implemented: retain source path and ask before rewriting lossy DXF sources. `src/app/commands-electrical.ts`, `tests/project-batch-safety.test.ts`. |
| 6 | Invalidate nested block caches; changing a descendant definition must update bounds, selection and rendering. | Implemented: dependency identities include reachable nested definitions and missing definitions. `src/core/entities.ts`, `src/core/spatial-index.ts`, `tests/block-dependencies.test.ts`. |
| 7 | Resolve IMAGE definitions in layouts; paper-space images otherwise retain empty paths. | Implemented for model and paper entities. `src/io/dxf.ts`, `tests/interchange-fixtures.test.ts`. |
| 8 | Report actual import losses; a successful parser does not mean every source feature survives. | Implemented: font approximations, metadata, per-vertex widths, hatch association, columns and reader limits produce structured warnings. `src/io/dxf.ts`, `src/io/dwg.ts`, `docs/SUPPORT-MATRIX.md`. |
| 9 | Capture all batch snapshots before awaiting dialogs/I/O; mid-operation edits or undo must not be silently overwritten. | Implemented: immutable snapshots plus monotonic session revisions, including edit-then-undo. Save completions also check content generations before changing a replacement drawing's path or recovery copy. `src/app/commands-electrical.ts`, `src/app/sessions.ts`, `tests/project-batch-safety.test.ts`. |
| 10 | Recover gracefully when project backups cannot be listed/read; drawing recovery should still open. | Implemented: Retry/Later, preserved backups and independent drawing recovery startup. `src/app/project-autosave.ts`, `src/main.ts`, `src/ui/filedialogs.ts`. |
| 11 | Bound cleanup during close; an unavailable recovery store must not leave the application waiting forever. | Implemented: bounded project discard and recovery drain. Close decisions capture pre-dialog state/revision/generation; changed work prompts again or aborts tab close before removing backups. `src/main.ts`, `src/app/closeflow.ts`, `tests/feedback-fixes.test.ts`, `tests/project-file-safety.test.ts`. |
| 12 | Preserve DIMDSEP; decimal-comma dimensions must not switch separators. | Implemented and active fixture regression. `src/core/dimension.ts`, `src/io/dxf.ts`, `tests/interchange-fixtures.test.ts`. |
| 13 | Resolve DIMTXSTY handles; a text style handle is not a style name. | Implemented: STYLE lookup for named and per-entity dimension styles. Installed TrueType/OpenType styles render through canvas; SHX/unknown styles use stroke substitution. Bounds and wrapping retain approximate stroke metrics. `src/io/dxf.ts`, `src/core/dimension.ts`. |
| 14 | Preserve DIMLWD/DIMLWE; dimension and extension lineweights affect plots. | Implemented import/export and dimension geometry styling. `src/core/dimension.ts`, `src/io/dxf.ts`, active fixture assertions. |
| 15 | Apply DIMTZIN separately; tolerance zero suppression differs from the main measurement. | Implemented independent suppression and regression assertions. `src/core/dimension.ts`, `tests/interchange-fixtures.test.ts`. |
| 16 | Preserve supported ACAD DSTYLE overrides; individual dimensions may differ from their named style. | Implemented: supported override variables applied and exported; numeric-only tolerance overrides recompute symmetrical/deviation display from inherited flags. Unknown groups are reported. `src/io/dxf.ts`, `src/core/dimension.ts`, `tests/dimstyle-dxf.test.ts`, `tests/interchange-fixtures.test.ts`. |
| 17 | Substitute DIMAPOST `[]`; otherwise alternate units can render as literal placeholders. | Implemented with alternate-unit placement regression checks. `src/core/dimension.ts`, `tests/dimstyle.test.ts`. |
| 18 | Retain MTEXT columns; column width/gutter/heights and explicit breaks otherwise disappear. | Partly implemented: column data, scaling and explicit breaks survive JCad round trips. Automatic flow is approximated; AC1015 external readers see one MTEXT column while JCad restores `JCAD_MTEXT_COLUMNS` data. These limits are reported. `src/core/mtext.ts`, `tests/mtext-transform.test.ts`, `docs/SUPPORT-MATRIX.md`. |
| 19 | Write a truthful hatch association flag; retained geometry must not claim missing boundary links. | Implemented: non-associative flag 71 = 0 with a warning that source links are lost. `src/io/dxf.ts`, active fixture regression. |
| 20 | Keep xref-dependent layer flags; removing dependency flags changes interoperability metadata. | Implemented: bits 16/32 retained through DXF export. `src/core/entities.ts`, `src/io/dxf.ts`, active fixture regression. |
| 21 | Resolve TABLESTYLE data; style handles alone cannot restore table text/margins. | Implemented exposed text heights, margins and colors with round-trip assertions. Unsupported style features remain documented. `src/io/dxf.ts`, `tests/interchange-fixtures.test.ts`. |
| 22 | Parse complete numeric tokens; `12junk`, NaN and infinity must not become plausible coordinates. | Implemented finite whole-token parsing and safe-integer count parsing before HATCH readers enter loops or tessellate geometry. `src/io/dxf.ts`, `tests/dxf-validation.test.ts`, `tests/interchange-hatch-limits.test.ts`. |
| 23 | Preserve DWG viewport/layout data exposed by the reader; defaults can change clipping, rotation and plotted pages. | Partly implemented: exposed scale, frozen layers and page settings survive. Viewport twist is displayed untwisted and clipping is omitted, with explicit loss warnings. Unavailable native data cannot be reconstructed. `src/io/dwg.ts`, `scripts/dwg-reader.mjs`, `tests/dwg-fidelity.test.ts`. |
| 24 | Retain or report omitted metadata; silent XDATA/object loss can damage electrical drawings. | Reporting implemented: explicit DXF omissions and conservative DWG reader-limit warnings, including estimated table positions. Arbitrary external application metadata is not preserved. `src/io/dxf.ts`, `src/io/dwg.ts`, `docs/SUPPORT-MATRIX.md`. |
| 25 | Use a supported Electron/toolchain and remove known dependency vulnerabilities. | Implemented: Electron 44.7.0, Vitest 5, supported Node engines and scoped `@electron/get` proxy dependency override. Complete local npm audit reports zero vulnerabilities. `package.json`, `package-lock.json`. |
| 26 | Gate self-updates on authenticity; unsigned downloads must not be silently installed. | Implemented: packaged Windows needs trusted publisher configuration; unsigned Windows and Linux/macOS offer manual downloads. Signed verification depends on release credentials. `electron/update-policy.cjs`, `electron/updater.cjs`. |
| 27 | Reject linked write destinations and parent swaps; symlinks/junctions can redirect writes or backups. | Implemented path/identity rechecks and exclusive temp creation. Real Windows junction tests pass. macOS's fixed root-owned `/var`, `/tmp` and `/etc` aliases are accepted with pinned alias/target checks; arbitrary links remain refused. Portable Node APIs leave a final-check/rename race, documented in `docs/SECURITY-REVIEW.md`. |
| 28 | Restrict image permissions to actual drawing authority; unrelated JSON or redirected links must not grant file access. | Implemented real-target revalidation against canonical drawing folders, including equivalent Windows short/long names, with network-host restrictions and link-escape checks. `electron/ipc-guard.cjs`, `tests/ipc-guard.test.ts`. |
| 29 | Bound DXF parsing and source allocations; malformed or huge inputs must fail predictably. | Implemented linear tokenization, source/record/string bounds, browser file-size checks and bounded desktop reads. All HATCH collection counts are limited by remaining records, and missing structural groups stop parsing. HATCH and standalone SPLINE reject more than 2,000,000 calculated basis-work units or 128 fit-interpolation matrix rows before expensive evaluation/allocation. Recovery/plugin/catalog/library reads share byte caps; writes check UTF-8 bytes against matching read limits. `src/io/dxf.ts`, `src/core/spline.ts`, `tests/interchange-hatch-limits.test.ts`, `electron/resource-limits.cjs`, `electron/autosave-store.cjs`. |
| 30 | Bound desktop DWG worker work; corrupt inputs must not hang the main process. | Implemented size/start/parse deadlines, cancellation, worker cleanup and JavaScript heap limits; no main-thread fallback. WASM/native memory is not strictly capped. `electron/dwg-host.cjs`, `tests/dwg-host-limits.test.ts`. |
| 31 | Bound expanded geometry; small nested blocks can multiply into millions of points. | Implemented weighted work, 100,000 units per insert, 1,000,000 expanded model/layout units and a separate 1,000,000-unit block-definition limit. DWG hatch sweeps and derived coordinates are bounded. Imports, edits, history restoration, library changes and background project batches validate before acceptance. Accepted snapshots are sealed; mutable inputs are rechecked rather than memoized by identity. `src/core/geometry-budget.ts`, `src/core/immutable-data.ts`, `tests/geometry-budget-edits.test.ts`, `tests/project-batch-safety.test.ts`. |
| 32 | Persist plugin trust only with a cryptographic digest; weak hashes must not approve replacement code. | Implemented: SHA-256 only for persistent trust; weak fallback approval lasts the current run. `src/app/plugins.ts`, `tests/plugins.test.ts`. |
| 33 | Isolate plugins if untrusted third-party code is to be supported; renderer execution is full application authority. | Conditional recommendation remains outstanding: plugins are explicitly trusted code, with confirmation and documented full renderer/bridge access. No claim of capability isolation or safe untrusted plugins. `docs/PLUGIN-API.md`, `docs/SECURITY-REVIEW.md`. |
| 34 | Deny unsolicited Electron permissions/popups; file content should not grant browser capabilities. | Implemented default deny, main-window sanitized clipboard exception, navigation/window-open denial. `electron/main.cjs`, packaged end-to-end checks. |
| 35 | Harden renderer origin/CSP/package fuses; broad file-origin and injected runtime behavior are unnecessary. | Implemented secure `jcad://app` assets, CSP and ASAR/Node/file-privilege fuses. Legacy preferences migrate in a controlled window with explicit storage flushes. Shipping disables command-line inspection and rejects debugging arguments. Full Playwright tests use a separate unpublished test ASAR; exact shipping binaries verify fuses and run bounded save/restart/migration probes. Platform validation is gated in CI. |
| 36 | Ignore renderer `userChosen` claims; only native choices should authorize external project drawings. | Implemented one-shot native dialog/OS/Recent authorization. Forged claims are refused in packaged end-to-end tests. `electron/main/ipc-drawings.cjs`, `electron/main/handover.cjs`, `scripts/e2e-electron.mjs`. |
| 37 | Redact problem reports by default; local paths, drawing names and command history can reveal private work. | Implemented redaction plus explicit opt-in for history/errors/private details. `src/app/diagnostics.ts`, `src/ui/report.ts`, `tests/diagnostics.test.ts`. |
| 38 | Check pack keys as own properties; inherited object properties are not trusted signing keys. | Implemented own-property lookup before signature verification. `src/electrical/packs.ts`. |
| 39 | Bound print page dimensions; huge/nonfinite sheets can allocate excessive memory. | Implemented positive finite dimensions up to 200 inches. `electron/resource-limits.cjs`, `tests/resource-limits.test.ts`. |
| 40 | Move browser DWG parsing off the UI thread; slow/corrupt files should remain cancellable. | Implemented a fresh worker per read, transferable bytes, 128 MiB/60 s limits, abort and teardown. `src/io/dwg-worker-client.ts`, `tests/dwg-worker-client.test.ts`. |
| 41 | Reuse unchanged drawing renders during cursor motion; redrawing dense geometry each frame wastes work. | Implemented bounded scene cache with state/view/style/selection/hover invalidation; async images and custom painters bypass caching. `src/render/viewport.ts`, `tests/viewport-cache.test.ts`. |
| 42 | Warm spatial indexes after load/edit; the first hover should not pay every indexing cost. | Implemented scheduled warmup and disposal, keyed by entity/block state. `src/render/viewport.ts`, `src/core/spatial-index.ts`. |
| 43 | Avoid repeated report scans; repeated reference/device lookups can become quadratic. | Implemented sorted ladder reference finder and shared connectivity maps. `src/electrical/ladder.ts`, `src/electrical/reports.ts`, `tests/reference-finder.test.ts`. |
| 44 | Enforce browser and release performance budgets; measurements alone do not prevent regressions. | Implemented asserted browser/dense Node budgets in CI and release gates. Local Node/browser checks pass. `scripts/bench-budgets.mjs`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`. |
| 45 | State supported Node versions; incompatible runtimes should fail clearly before release tooling runs. | Implemented supported Node 22/24 ranges, `.nvmrc` and CI matrices. `package.json`, `docs/DEVELOPMENT.md`. |
| 46 | Turn deferred fidelity work into regressions; TODOs cannot detect a broken implementation. | All 11 interchange TODOs replaced with active behavioral assertions; new safety/parser/worker/geometry regressions added. `tests/interchange-fixtures.test.ts` and related suites. |
| 47 | Require committed fixtures; missing test data must fail rather than quietly skip coverage. | Implemented manifest and pretest gate. Optional private fixtures and platform-specific checks remain conditional. Dense performance tests require `JCAD_BENCH=1` and are mandatory in CI/release. `scripts/check-fixtures.mjs`, `tests/fixtures/manifest.json`. |
| 48 | Bound screenshot output and parse complete streams; chunk boundaries must not hide browser errors. | Implemented UTF-8 stream decoder, separate bounded tails and exact shared allowances. `e2e/output-scanner.mjs`, `tests/screenshot-output.test.ts`. |
| 49 | Validate exports in an independent CAD implementation; self-round-trip tests can share the same bugs. | Implemented optional licensed AutoCAD Core Console harness. Seven committed fixture exports and a generated nested-dimension/override case passed AutoCAD 2027 AUDIT with zero errors and normalized entity type/count checks. No vendor drawings are committed. |
| 50 | Release exactly the checked source and complete installer set; artifacts must match the tested commit. | Implemented source-SHA checks and byte hashes for all five installers, updater feeds and external blockmaps. Aggregate verification checks the actual uploaded files even in build-only runs; publication additionally requires packaged execution and GitHub-signed build attestation. Builder diagnostics are excluded from public manifests. `scripts/release-provenance.mjs`, `.github/workflows/release.yml`. |
| 51 | Report actual signing status; ad-hoc/unsigned builds must not be presented as publisher-signed releases. | Implemented configured signature/notarization verification and explicit provenance/release-note status. Azure publisher configuration passes the installed builder's schema and reaches its generated updater configuration. CI successfully signed and verified the Windows application and installer against the configured publisher. Both Mac architectures passed Developer ID, hardened runtime, notarization, stapling, Gatekeeper and signed-installer probes on prior head `d0ff078`; the integrated head requires fresh exact-commit validation. `scripts/azure-signing.mjs`, `tests/azure-signing.test.ts`, `docs/CODE-SIGNING.md`. |
| 52 | Update documentation to match the implementation; outdated compatibility, security and update claims mislead users. | Implemented support/security/QA/performance/development/release/signing/manual/notices updates, including the remaining limits. |
| 53 | Extract focused infrastructure; isolated responsibilities are easier to test without risky wholesale rewrites. | Implemented separate origin, resource-limit, update-policy, DWG worker, geometry-budget, fixture, scanner, benchmark and provenance modules. The updated default branch's `src/app/editor/`, `src/io/dxf/` and `electron/main/` splits are retained with the safety fixes and module-boundary regressions. Existing editor behavior remains covered by end-to-end tests. |

## Follow-up items 1–7

This batch began at 12:56:51 p.m. America/Chicago on October 11, 2026. These item numbers
refer to the subsequent quickest-to-longest list, rather than the 53-row baseline above.

| # | Change | Evidence and limit |
| --- | --- | --- |
| 1 | Accurate font warnings and geometry-protection documentation | DXF/DWG share `src/io/font-warning.ts`; renderer-aware warnings distinguish installed fonts, SHX substitution and approximate bounds/wrapping. `tests/font-import-warning.test.ts`. |
| 2 | Shared spline sample plan | Work guard and sampler consume `splineSamplePlan`, including rounded fractional requests, nonempty knot spans and integer caps. `src/core/spline.ts`, `tests/spline-sampling.test.ts`. |
| 3 | Developer ID signing and notarization | Configured credentials and fail-closed publication requirements are implemented. [Signed build #27, attempt 2](https://github.com/habit04/share/actions/runs/38170557628) passed on prior head `d0ff078`, including both Mac architectures' identity, hardened runtime, notarization, stapling, Gatekeeper, DMG signatures and shipping probes. The integrated head must pass a new signed build. `scripts/mac-signing-config.mjs`, `docs/CODE-SIGNING.md`. |
| 4 | Preserve source $AUNITS, $CELTSCALE and $TEXTSTYLE | Valid DXF and exposed DWG values survive export; absent values retain legacy defaults. New-entity inheritance and alternative angle display formats remain outside this preservation change. `tests/interchange-header-settings.test.ts`. |
| 5 | Edit-time geometry budgets and safe caching | Candidate edits, loads, undo/history, libraries and active/background/closed-sheet batches validate before mutation/write. Accepted plain-data snapshots are sealed; API errors propagate and UI budget refusals are reported. `tests/geometry-budget-edits.test.ts`, `tests/project-batch-safety.test.ts`, `tests/sessions.test.ts`. |
| 6 | Disable production command-line debugging | Shipping fuse disables inspection, with argument refusal and separate unpublished test-ASAR coverage. Binary fuse/provenance checks and fixed shipping startup/save/restart probes are release gates. Current-head installer execution is reported separately in the pull request. |
| 7 | First-use geometry and project I/O measurements | Browser profiling measures state acceptance, first geometry and first render before warmup. Filesystem profiling reads 20 sheets and runs all reports with asserted workloads/timing limits. OS disk cache may be warm. `scripts/bench.mjs`, `scripts/bench-project.mjs`, `docs/PERFORMANCE.md`. |

The local follow-up on prior head `d0ff078` passed 1,483 unit tests (11 conditional skips), all three
TypeScript configurations, full ESLint, fixture/workflow checks, eight dense benchmarks,
207 desktop source checks and browser interaction checks (607 command runs, 796 clicks).
Final browser and filesystem profiling passed their factor-1 budgets. Fixed startup probes
also passed using the installed development Electron runtime; this is not shipping-binary
fuse or signing evidence. Current installer evidence is recorded separately in the pull request.

Budget regressions cover mutable direct insert/block inputs and custom prototypes, which
cannot reuse certified immutable geometry caches. Production also ignores a development-server
URL override. Release regressions verify dependency-free aggregate provenance checks and
temporary-profile cleanup after early smoke-test failures.

## Independent CAD validation

The integration with default-branch commit `9a3e8dc` retains version 0.4.2, linked-folder
compatibility, updater verification, global window guards and CAD improvements alongside the
earlier remediation. Saves through aliases of the same physical destination share a queue,
reserve in invocation order and reject an alias retargeted while queued. Derived project DWG
exports retain their source write root. Updates install only through explicit Restart Now,
after the unsaved-work check and a fresh checksum/publisher verification.

Final local integration validation passed 1,622 unit tests (26 conditional skips), all three
TypeScript configurations, 214 Windows desktop checks, preference migration over two immediate
restarts, and browser interaction checks (607 command runs, 796 clicks). Eight dense Node checks
and eight AutoCAD export/AUDIT/reimport checks passed. Exact-commit CI and installer evidence is
recorded in [PR #2](https://github.com/habit04/share/pull/2); local execution does not substitute
for the cross-platform signed installer gates.

`npm run check:autocad` uses a locally installed licensed AutoCAD Core Console, exports copies of
committed fixtures to a fresh temporary folder, runs `AUDIT` without repair, normalizes the DXF,
then compares reimported model/paper entity types and counts. Each process has a deadline and a
bounded log. It never overwrites source drawings. The validated fixtures cover dimensions,
hatches/curves, a LibreDWG sample DXF, layouts/title blocks, MTEXT and tables.

AutoCAD 2027 (`X.60.0.0`) found zero audit errors in all eight final exports, including a generated
nested block containing a dimension with tolerance overrides. This check exposed
and helped fix invalid 3D LIMITS header groups, an unsupported AC1015 DIMENSION group and missing
plot-style dictionary references. Entity counts and AUDIT acceptance do not prove visual or
semantic identity for every CAD feature. In particular, automatic MTEXT column flow, external
fonts and arbitrary electrical application metadata retain the limits in the support matrix.

A copied installed AutoCAD Electrical IEC tutorial drawing was also read locally to compare
reader behavior; no Autodesk source files, drawings or licensed program content are distributed.

## Validation and remaining limits

The earlier remediation passed 1,403 unit tests (10 conditional skips), TypeScript checks
for app/Electron/scripts and ESLint. The dangerous hatch cases run in isolated child processes
with a three-second deadline and 96 MiB JavaScript heap cap; they cover invalid tokens, every
declared HATCH collection, missing records, huge finite angles, derived coordinate overflow and
high-degree/dense-fit spline work.
Supported dimensions also have numeric-only override round-trip regressions. The signing tests
use the installed builder's schema and updater configuration without calling Azure.

Seven dense performance tests, fixture/workflow validators, a complete dependency audit with
zero vulnerabilities, browser interaction/performance checks and Windows packaging also passed.
That earlier desktop source suite had 207 end-to-end checks. Preference migration is tested over two
immediate launches, including Unicode values and preservation of a value changed after migration.
The shipping app flushes renderer storage before acknowledging migration and before an approved
close. Test cleanup has a deadline and only terminates its own Electron process.

The workstation's Windows Application Control blocks the rebuilt unsigned executable. The
existing installed Electron runtime remains usable for desktop source testing. Final packaged
execution is a separate CI gate on each platform. No Windows security policy was changed.

The committed screenshot baselines target Linux and its fonts. A local Windows comparison
against those baselines failed as expected; a separate build of the baseline commit using the
same Windows browser matched all 38 schematic/drafting captures at the existing visual comparator's
threshold. An exact RGBA comparison found four pixels differing by at most 3/255 per channel,
with no layout or content differences.
The browser interaction gate passed 607 command runs and 796 clicks. CI compares all 48
committed Linux screenshots on its configured Chromium runner. One DWG baseline changed after
visual review confirmed unchanged drawing geometry and updated import-warning text; new
content assertions cover those warnings, and no visual tolerances were widened. Symbol Builder's
end-to-end check waits for its required controls to finish rendering.

Windows short/long image paths and macOS's protected system aliases have targeted regressions.
Normal CI runs Node 22/24 checks, screenshot/performance checks and the complete desktop suite plus
preference restarts on Windows, macOS and Linux. A build-only dispatch additionally builds all
five installers and runs installed/extracted applications on their respective platforms. It also
verifies the complete uploaded installer, updater-feed and blockmap set against source-bound
hashes, even when the tag is empty and publication is disabled. The pull request records the
latest exact-commit workflow results.

Before a release is considered verified, its exact final commit must pass the configured CI
gates and every platform installer must be installed/extracted and exercised on its own OS.
This Windows workstation cannot locally verify macOS notarization or Linux/macOS execution.
CI verifies the final macOS ad-hoc seal or configured Developer ID/notarization status and the
configured Windows publisher signature. No publisher certificates or credentials were invented.
Plugin isolation, full automatic MTEXT column flow, arbitrary metadata preservation and strict
native/WASM memory caps are not claimed.
