# Historical Windows 2D milestone evidence

These are timestamped source snapshots, including earlier known failures and superseded
integration notes. Current status and final gates are in `REMAINING-2D-CHECKLIST.md`.

## Validation record

- SHX milestone: **1,477 native/actual Windows source checks** pass, including 1,328 precise
  placement/path comparisons and 144 independent rendered comparisons. Final rebuilt app
  confirms canonical 41/51 on 27 TEXT, 12 ATTDEF and one generated ATTRIB on the first save,
  exact backups, fresh empty-resource reopen/reload and both Plot routes. The resulting DXF
  passes two native AUDIT0 runs. Four missing literal U+2300 cases remain explicit substitutes.
  The committed 20-case fixture and authored SHP sources include no proprietary programs.
  Combined gate: **3,092 passed, 28 conditional skips** across 220 files; all three TypeScript
  projects, broad lint, fixtures, production build and eight dense benchmarks pass.
- Plugin source-read milestone: **90 targeted tests** and native NTFS/actual production
  callback escape/retarget probes pass. Electron/app-data are substituted in callback tests;
  this does not establish a live Electron plugin installation or a capability sandbox.

- CTB/STB plotting: **1,823 native/actual Windows source checks** pass, including 266 native
  RGB samples, 22 Canvas/raster/vector pages, production Plot dialog and real Save PDF IPC.
  Requested widths match serialization precision; native widths match half the 0.12-point
  device quantum. Unsupported effects are reported; tables are private and ephemeral.
  Combined suite: **2,960 passed, 27 conditional skips**, with eight dense benchmarks passing.
  All three TypeScript projects, broad lint, fixtures and production build pass. This run's
  passing helper test does not resolve the independently confirmed #24 cache defect.

- Complex linetype milestone: **230 targeted tests in seven suites** pass, including the native
  fixture, undo/redo/repeated saves, missing-resource refusal, signed Canvas dash phase, DWG save
  state protection and bounded linear scanning. New native fixture has two LINEs, padded text,
  nonzero absolute rotations and an anonymous shape STYLE. Actual source Electron Open/edit/
  undo/redo/Save As/normal Save/exact backup/fresh reopen/recovery IPC/DWG refusal all pass;
  only native file-dialog paths were queued. The UI-written DXF then passes AutoCAD AUDIT0
  and ordered descriptor/STYLE signature comparison at native numeric tolerance 1e-11.
- Broad linetype/reader snapshot: **2,865 passed, 1 failed, 27 conditional skips** across 210 files.
  The new fixture exposed a stale scanner expectation that trimmed literal LTYPE text; corrected
  context-specific assertions pass with all 230 targeted tests. The preceding full run also caught
  the stale positive-only dash expectation, now corrected. The helper test passed on this timing
  run, but the confirmed #24 identity-cache defect remains unfixed and is not treated as resolved.
  Broad lint, all three TypeScript projects, fixtures and production build pass before the
  subsequent plotting integration; later combined validation is required.

- Standalone Windows PDF embedding: 75 program-reader, 97 metric-reader, 18 worker-host,
  36 resource and 17 integration regressions pass. Actual source Electron/Chrome/Poppler
  proof passes **1,496 checks** with four exact installed programs, Unicode extraction,
  native TEXT positions and 66 rendered crop comparisons. The production Plot dialog and
  real Windows Save PDF route pass on a private native fixture copy, preserving snapshot/clean state.
  Only destination dialogs use test doubles; font bytes and reference PDFs stay private.
  Native MTEXT remains **198/216**: 18 Times tall multiline leading differences are recorded,
  with the original 0.12 tolerance. PDF source was frozen and source hashes verified.
- PDF milestone combined suite: **2,773 passed, 1 failed, 27 conditional skips** across
  203 files. The unchanged portable-helper identity-cache test is the failure described in #24;
  it remains owned by PR #9. Broad lint, all three TypeScript projects, fixtures and production
  renderer build pass. Existing eight dense benchmarks passed in the preceding font milestone.

- Private Node 24.19.0, locked `npm ci --ignore-scripts`, worktree-local npm cache and TEMP/TMP.
- Dimension milestones: 137 tests, including 25 new regression cases; baseline angular probes fail and fixed
  probes pass. Committed dimension fixture import/edit/undo/redo/DXF save/reopen included.
- Text milestone: 79 tests in 7 suites, including 7 new regression cases; targeted lint and
  renderer/tests typecheck pass. Committed MTEXT fixture edit/undo/redo/DXF reopen included. Declared-height column flow passes 295 tests across 13 suites, including 26 new cases.
- Windows path milestone: 80 tests pass, including real NTFS Unicode files, separate backups and junction confinement; the DWG picker wrapper passes 25 tests. These junction checks ran outside the sandbox with all files confined to private worktree TEMP/TMP.
- Polygon native fixture: AutoCAD 2027 opened the generated private DXF, AUDIT found zero errors, DXFOUT preserved flag/pointer/owner and JCad reopened all vertices. Fixture and provenance are committed.
- Actual headless Chrome pixels and Poppler-rendered vector PDF pixels match the polygon interior and white cutout; Canvas layout and raster plotting both pass. Chrome ran on private port 5197.
- Clip input milestone: 120 tests across 9 suites, including 17 new input cases; curves/text use existing selection approximations, and partly visible entities retain whole-entity selection geometry.
- Broad lint, all three TypeScript projects, production renderer build and eight dense geometry/selection benchmarks pass. Final combined suite and command/control UI gate results are recorded below after completion.
- Native DWG clips/columns, a signed helper or installed-release validation were not run. The other workstream retains ownership of DWG/native/installer proof. No new installer was built or installed.
- Native explicit text defaults: 288 passed / 2 absent-private-DWG skips across 14 suites;
  9 new regressions cover TEXT/ATTDEF/ATTRIB presence, repeated native DXF reopen, undo/redo,
  and Canvas/PDF placement. Absent properties keep their legacy behavior.
- DWG clip safety: 53 tests cover working Save/Save As and Export Copy refusal for retained
  clip boundaries, including disabled/off/inactive views, DXF fallback and untouched dirty,
  history, destination and recovery state. DWG bridges are mocked to prove no writer call.
- UI gate: 611 command runs, 796 clicks, 52 Electron menu commands resolved; passed in isolated
  Chrome. Three actual Electron launches passed origin migration, acknowledged checkpoint,
  deletion persistence and lost-storage recovery using private worktree profiles.
- Initial batch snapshot `c1b2587` serial suite: **2,331 passed, 0 failed, 27 conditional skips** across
  187 files. The opt-in dense suite ran separately: all 8 benchmarks passed. Initial lint,
  renderer/Electron/scripts TypeScript checks and production renderer build passed.
- Final review added 35 regressions: 19 dimension-override cases, 12 viewport hatch-visibility
  cases and 4 retained boundary-resource cases. Native integer overrides normalize safely;
  native DIMTIH/DIMTOH values remain distinct despite the existing ISO display approximation.
  Ordinary immutable style edits still work without callers supplying override metadata;
  malformed prototype names cannot become supported native override codes.
- AutoCAD 2027 accepted the matching-style dimension export with **zero AUDIT errors**.
  DXFOUT retained native explicit DIMTXT=5 / DIMDEC=0 even when the named style matched.
  Exact-source JCad reimport and a later named-style change to 3 / 1 kept the entity at 5 / 0.
  The oracle used a private synthetic export and isolated AutoCAD profile in this worktree.
- `npm run e2e:2d-batch`: **7 checks passed in actual source Electron 44.7.0**, using only
  queued native Open/Save dialog answers. Real renderer, codecs, preload, IPC permissions,
  Windows disk writes and backups exercised polygon edit/undo/reopen, native pointer ownership,
  text default presence, MTEXT columns, safe clip-DWG refusal and distinct NFC/NFD files/tabs.
  The reopened paper-space screenshot shows the concave boundary and clipped model line.
  This gate passed again on the fresh `4e0b047` production build. It does not certify the
  native DWG helper or an installed release. Equal DSTYLE preservation through portable
  DWG conversion still requires native verification with PR #9.
- Combined source snapshot `3d3198a`: **2,365 passed, 0 failed, 27 conditional skips**
  across 190 files. Required fixtures, broad lint, renderer/Electron/scripts TypeScript and
  production renderer build passed; all **8 dense benchmarks** passed separately. The full
  native-helper Electron gate remains unavailable
  in this private worktree because its signed portable helper is absent; no helper was copied
  from the other workstream and no installer was built.
- Final source `4e0b047` full run: **2,365 passed, 1 failed, 27 conditional skips**. The failure
  was the previously observed unchanged `portable-dwg-host.test.ts` same-size-byte-rewrite
  integrity assertion, not a batch regression. Its focused two-suite rerun passed **28/28**;
  final dimension checks passed **93/93** and the fresh source Electron gate passed **7/7**.
  Later private NTFS probes confirmed an actual identity-cache defect (see integration notes).
  Rerun success is not a repair claim.
- Gradient initial frozen source: **2,425 passed, 0 failed, 27 conditional skips** across
  195 files. Fixture checks, broad lint, renderer/Electron/scripts TypeScript and production
  renderer build passed. The earlier gradient run reproduced the unchanged helper failure
  (2,421 passed / 1 failed); the final passing run does not resolve its confirmed cache defect.
- Gradient native fixture: AutoCAD 2027 opened and normalized all nine names at shift 0/1;
  JCad's re-export passed native AUDIT with zero errors and all eighteen native gradient tails
  matched exactly, including optional RGB presence. Private native plots established LINEAR
  world-axis bounding-box projection, stored RGB interpolation, ACI 0 black / 7 white,
  unchanged angle on direct ROTATE/MIRROR/SCALE and local-frame behavior in rotated INSERTs.
- Gradient pixels: **111/111** actual checks, 37 each for Chrome Canvas, raster plotting and
  Poppler-rendered vector PDF. Includes triangle extents, holes, opacity, colors, rotated and
  sheared nested INSERTs and explicit unsupported fallbacks. PDF has ten axial shadings and
  no raster image XObjects. Chrome used private port 5198; owned browser/server were closed.
- Gradient final fresh build: **6/6 actual source Electron checks** passed for secure origin,
  native eighteen-hatch IPC import, real HATCHEDIT angle edit/undo/redo, actual DXF save/backup/
  fresh reopen and actual DWG-refusal dialog with dirty/history/path/recovery state retained.
  Only native Open/Save dialog answers were queued; no renderer/codec/storage/IPC mocks.
  Owned app closed. Native DWG helper and installed-release behavior were not certified.
- Final review fixed protected mixed-EXPLODE selection and finite-corner/PDF matrix validation,
  including rounding collapse and invalid exponent syntax. **62 targeted gradient tests** and
  **8 dense benchmarks** pass. Private AutoCAD probes rejected patterned HATCH + gradient
  tails for active/inactive/empty-color variants, while ordinary patterned HATCH and solid
  inactive descriptors passed AUDIT with zero errors. Such unsupported combinations retain
  all imported pattern/gradient data, report the native export limit and refuse DXF emission;
  HATCHEDIT cannot introduce them. Final full-source results are recorded at handoff below.
- Final committed source `4c46059`: **2,429 passed, 1 failed, 27 conditional skips** across
  195 files. All **62 gradient regressions** passed. The sole failure is the unchanged,
  independently confirmed portable-helper integrity-cache assertion at
  `portable-dwg-host.test.ts:223`; it remains an explicit PR #9 integration dependency.
  Broad lint, all three TypeScript projects, required fixtures and production renderer build
  passed. Final source pixel gate passed **111/111**, actual Electron gate **6/6**, and dense
  benchmarks **8/8**. No test was suppressed or native helper repair claimed.

## Integration notes and next milestones

- Windows font foundation: `27de50b` (reader/worker) and `e98ecd9` (drawing geometry/painting).
  Final combined suite: **2,600 passed, 1 known failure, 27 conditional skips** across 199 files.
  The failure is the unchanged portable-helper cache assertion described below; an earlier run
  passed it because of timestamp timing, which does not repair the confirmed defect. All **97
  font reader tests** and **17 host tests** pass. Font/context regressions, all three TypeScript
  projects, broad lint, fixture checking and the renderer build pass; **8 dense benchmarks** pass.
  A final paper-space compatibility restore in the captured model-raster helper additionally
  passed **50 targeted tests**, renderer TypeScript and scoped lint.
- Final actual-source font proof: **62 Chrome checks** through real Windows Electron font IPC,
  plus production Electron native DXF import, STYLE edit/undo/redo, real Save As/reopen and clean
  dirty state. Source hashes matched the private proof; owned processes/port 5199 were closed.
  Native fonts were unmocked; only file-dialog paths were queued. Arial/Arial Bold/Courier/Times
  normalization, bearings, fitting and verified anchors match native references. The committed
  20-entity font fixture passed native AUDIT with zero errors. Unverified origins, monochrome
  bitmap glyphs, contextual scripts, native MTEXT details and vector PDF remain explicit limits.
- MTEXT milestone `c10e099`: **253 targeted tests** across 14 files, renderer TypeScript and
  scoped lint pass. New attachment/wrapping suite has **42 cases**, including authored all-nine
  attachment checks, native AP1/5/9 H/paragraphed-g anchors and Times default/qc/qr width55/60,
  plus committed four-face fixture STYLE edit/undo/redo/DXF reopen. Native PDF position comparisons
  allow 0.13 drawing units for quantization. Pen advances remain distinct from ink wrap spans;
  overhanging dimension text participates in gaps/fit. Tall-glyph leading, inline font families,
  tracking and automatic-height columns remain open. SHX/context-free layout remains unchanged.

- PR #9 remains active and draft at the font milestone's read-only snapshot, head `01ebe95b3d05ddbcc46fb279b0dbffe19474b83a`.
  Its native
  reader/writer and real-file saving verification remain that workstream's responsibility.
  No commits were copied from it. Resolve shared codec/layout conflicts deliberately and rerun
  native equivalence, combined 2D regressions and real-file saving before considering release.
- The baseline native helper removes object handles during its comparison. Newly retained
  viewport boundaries therefore remain explicitly blocked from DWG saving/export until clip
  pointer ownership is independently verified; lift the renderer guard only with that proof.
- Earlier full-suite runs encountered a WASM allocation failure in `dwg-host.test.ts` and the
  same-size-byte-rewrite assertion in unchanged `portable-dwg-host.test.ts`. Private actual
  NTFS probes now prove the latter is an integrity-cache defect: 31/64 modified binaries
  retained equal timestamp identity and were incorrectly accepted. PR #9 changes that exact
  `verifyPortableWriter.check` loop to hash every bounded admission. Leave its repair with
  that active workstream; no unfinished commit was copied. Combined native validation is still
  required after verified integration, regardless of the latest passing full test run.
- Retained gradient descriptors, including inactive data in unused blocks/layouts, are blocked
  from DWG saving/export until native conversion is proven. A transformed display frame cannot
  be faithfully emitted as a standalone native HATCH angle; export refuses it and the EXPLODE
  command protects such block instances. DXF block definitions plus INSERT remain supported.
- Native MTEXT ink attachment/wrapping, eligible TrueType PDF embedding, complex linetype
  retention and the CTB/STB plotting subset are implemented. Next independent work is bounded
  real SHX font/shape decoding, authorized resource loading and shared drawing/plot geometry.
  Native spatial references remain required for nonlinear/shifted gradients. Full plugin
  capability isolation, external-reference loading and other missing rows remain open.

## Priority 20 delivery review, 2026-10-15

The delivered five-patch DXF loading/refresh core is not adopted or wired into the
application. Archive integrity verifies all ten declared hashes and nineteen
patch operations against the published base. The exact candidate runs privately
against current DXF dependencies: all 27 delivered tests pass. Independent bounded
in-memory probes have nine passing controls and ten failing expected invariants.

More than 64 empty-path, nested-overlay, cycle or depth-limit nodes bypass the
advertised total cap; strict and partial stores can commit an over-cap snapshot.
Canonical forward-UNC paths also lose the loader's declared Windows case identity,
duplicating reads and delaying cycle detection. Both require owner corrections,
exact-boundary regressions and seeded-store identity/generation preservation.
The UNC checks use strings and fake readers, not a network share or native grant.

The package's reported full suite has 29 failures; its two-file baseline control
does not prove all are unrelated. No combined full pass, UI/Windows IPC, DWG,
AutoCAD, rendering or save/capture compatibility is claimed. Later wiring must
keep reference reads separate from normal Open write/source grants, preserve
host/runtime data separation and electrical XREF aliases, and handle native path
identity, stale refresh/session results and frozen plotting. Completed DWG/font/
GPU work remains separate; the long roadmap and merge hold remain in place.
