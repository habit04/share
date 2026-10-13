# Windows 2D and reliability implementation checklist

Baseline: `83aedbcc7b145ff87293a35d9001cb56f127a2b0` (Windows v0.4.8).
Worktree: `C:\Users\justi\Chad\jcad-2d-reliability`, branch `feature/remaining-2d-reliability`.
This is development work; no release, installer, signing or GPU renderer changes.

Status distinguishes a tested correction from completion of the entire priority. Source evidence
is the current branch and `SUPPORT-MATRIX.md`, rather than an earlier planning list.

The first batch is complete: polygon viewport DXF/display/input compatibility, dimension
style correctness, text/default override correctness, declared-height MTEXT flow and Windows
path/save protection. Independent review findings are fixed and covered by regressions. The
remaining feature/dependency rows below form later batches; no release or installer is implied.
The next milestone retains native gradient HATCH definitions and renders verified unshifted
LINEAR fills in Canvas and vector/raster plots. Nonlinear and shifted rendering remain open;
this milestone does not complete the entire gradient priority or remaining roadmap.

| Priority | Current evidence and status | Ownership / dependency | Completion validation |
| --- | --- | --- | --- |
| 9 | Polygon DXF milestone implemented and tested: native closed straight-polyline boundaries, appearance, enable flag, copy/edit/undo/reopen, Canvas and vector/raster clips. Review corrections include enclosing hatch-pattern visibility and retained boundary layer/linetype resources during purge/export. Curved boundaries and DWG clip exposure remain missing. Graphical selection excludes fully hidden entities but keeps whole-entity tests for partially visible objects. | Lead; DWG boundary exposure depends on #19. | Import/edit/undo/save/reopen clip; Canvas, vector/raster plots and viewport activation agree. Unsupported curves stay reported. |
| 10 | Confirmed angular suppression, arrow ownership and gap defects corrected; style traversal and paper-space undo/redo implemented. Supported native override presence/value survives matching named styles and later redefinitions; scaling, Match Properties and existing direct-style editing remain compatible. Ordinate/arc-length types still missing. | Dimension agent; native DWG exposure remains #19. | Styles/overrides, every space, native fixture edit/save/reopen, undo/redo, geometry/bounds and plots. |
| 11 | Windows font metrics, native TEXT placement and ink-based MTEXT attachment/wrapping implemented and tested. Per-drawing geometry drives Canvas, bounds/selection, masks, annotation fitting and captured raster/eligible vector plots. Missing/unsupported faces, bitmap glyphs and unverified origins use Canvas measurement; contextual scripts retain shaping. Tall-glyph MTEXT leading, inline font/tracking and Unicode edge cases remain open. See `WINDOWS-FONT-METRICS.md`. | Text agent and lead; reader-omitted annotation font fields depend on #19. | Retain native/actual Windows IPC/Canvas/raster/STYLE edit/undo/DXF reopen checks; extend tall leading and formatted Unicode fixtures. |
| 12 | Standalone TrueType slice implemented: confined same-read font programs/metrics, version-aware embedding permissions, full Type0/CIDFontType2 programs, native advances/placement and ToUnicode. Captured plot scope, clip/annotation font budgeting and explicit substitutes tested. TTC/CFF/variable/color fonts, contextual shaping, subsetting and preview/print-only read-only PDFs remain open. See `PDF-FONT-EMBEDDING.md`. | Lead; installed fonts read only, no font programs committed. | Retain resource/extraction/Poppler/native reference/UI plot checks; add fixtures before extending font formats or licensing modes. |
| 13 | Missing CTB/STB interpretation; layout sheet names select built-in color modes in `dxf-layouts.ts`. | Independent; real style table fixtures required. | Named/color-dependent tables, lineweight/screening/colors, layouts, save/reopen and external plot comparison. |
| 14 | Partial: `core/linetypes.ts` retains dash sequences, complex text/shapes absent. | Independent; #21 for SHX shapes. | Native definitions retain text/shape/style/placement and render at correct scale across segments and plots. |
| 15 | Partial: `mtext.ts` honors explicit column breaks/count/width/gutter/reversal; declared-height static/dynamic-manual flow now implemented (26 new tests), with overflow retained. Auto-height balancing remains missing. Native export replaced by `JCAD_MTEXT_COLUMNS` XDATA. | Independent; DWG embedded-object exposure #19. | Auto-flow/static heights, masks, edits, native column fixtures and external CAD reopen. |
| 16 | Partial milestone implemented: native DXF gradient name/angle/shift/dialog mode/tint/color records and inactive descriptors retained; all nine names and both endpoint shifts externally reopened. Unshifted LINEAR Canvas and vector/raster plotting verified, including holes, opacity, ACI/RGB, direct transforms and affine block instances. HATCHEDIT angle/shift is undoable; explicit SOLID conversion retains an inactive descriptor. Named-pattern conversion is refused because native DXF cannot retain the combination. Nonlinear/nonzero-shift rendering uses a reported solid fallback. Destructive EXPLODE and unverified DWG saving are guarded. See `HATCH-GRADIENTS.md`. | Independent; native DWG fields/conversion still #19. | Complete nonlinear/shifted fields from native reference; native DWG metadata equivalence; retain current DXF/Canvas/PDF/edit/reopen checks. |
| 17 | Missing associations: HATCH export writes flag 71=0; links reported lost. | Object-reference integration #29. | Boundary edits/undo/erase update hatch; native ownership/reference roundtrip. |
| 18 | Partial: MULTILEADER becomes LEADER+MTEXT; block content not drawn. | Independent 2D model, native preservation with #19/#29. | Text/block content, leader context/style, editing, native export/reopen, no silent substitution. |
| 19 | External active work: reader/writer repairs, named views, FIELD/object links, dictionaries, layout/style metadata and real-file saving verification. | "Check GitHub access to JCad", PR #9, `codex/windows-dwg-metadata-reference-graph`. Do not duplicate/cherry-pick unfinished work. | Integrate only verified completed commits later, then rerun combined real-file checks. |
| 20 | Missing: xref block path/overlay flags retained, `xrefPlaceholder` shows frame; no external drawing loading/refresh. | Independent; Windows path grants and recursion/geometry limits required. | Relative paths, nesting/cycles, refresh/undo, missing files, no rewriting original references. |
| 21 | Missing: SHX styles use bundled Hershey substitute; no SHX decoder. | Independent; font/shape access and redistribution constraints. | Real font/shape fixtures, metrics, encoding/big-font and plotting. |
| 22 | Partial: table cells edited in JCad, export is INSERT + `JCAD_TABLE` XDATA. | Native table model/export; #19 for omitted DWG cells. | Native editable ACAD_TABLE reopened externally and in JCad, styles/cell values retained. |
| 23 | Partial: electrical attributes, WD_M settings and project metadata exist; remaining proprietary extensions require fixture-based audit. | Electrical audit; application dictionaries #29. | Real AutoCAD Electrical cases preserve exposed tags/catalog/connectivity/settings; report unmodeled metadata. |
| 24 | Confirmed NTFS Unicode-path defect corrected in renderer/registry/atomic writer; native saves/backups and DWG picker identities tested. Earlier atomic queue/autosave features already exist. A separate confirmed portable-helper identity-cache defect accepted same-size modified bytes in 31/64 private NTFS probes; PR #9 already contains the matching always-rehash repair, not integrated here. | Reliability agent and lead for path changes; helper cache repair belongs to active PR #9. | Unicode files/backups, grants/junction/race/recovery tests; integrate verified helper repair and prove changed bytes refused even with colliding/restored timestamps. |
| 25 | Missing capability boundary: plugins run `new Function`/bridge in renderer; error isolation exists, trust hash is not capability isolation (`app/plugins.ts`, `PLUGIN-API.md`). | Separate compatibility architecture milestone. | Declared capabilities enforced outside plugin global context; denied file/network/document access; existing plugins migrate explicitly. |
| 28 | Missing specialized entities and PDF/DGN/DWF underlays; unsupported records reported (`SUPPORT-MATRIX.md`). | Independent per-entity milestones; parsers/licensing required for underlays. | Preserve source/reference metadata; fixture import/edit/save/reopen and visible unsupported feedback. |
| 29 | External active work: arbitrary metadata/object-reference preservation. Current baseline strips unsupported cross-object links. | PR #9 as #19. | Independent metadata equivalence, ownership graph, real-file edit/save/reopen; no silent retained-property loss. |
| 30 | Missing dynamic-block actions/parameters and constraints; static INSERT representation exists. | #29 reference graph prerequisite. | Native actions/parameters/constraints retained, safe supported edits, explicit unsupported cases. |
| 31 | Missing sheet sets, data links and drawing digital signatures. Drawing signatures differ from installer signing. | Formats/reference graph/licensed validation prerequisites. | Real sheet/data-link fixtures; signature validity and explicit invalidation on edits, no false signing claim. |

Completed baseline priorities 1–6, 8 and portable Windows DWG saving #27 remain regression
coverage, not rebuild work. #7 was superseded by portable saving. #26 (Mac/Linux updates) and
#32 (full 3D) are excluded. Unsupported requirements above are still open; a dependency is not
proof that their implementation or external verification has passed.

## Validation record

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
- Next independent milestones: native MTEXT attachment/wrapping and permitted TrueType PDF
  embedding, followed by complex linetype element preservation. Nonlinear/shifted gradient rendering needs native spatial reference evidence;
  SHX shape rendering and full capability-isolated plugins need separate architectural work.
