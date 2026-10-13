# Windows 2D and reliability implementation checklist

Baseline: `83aedbcc7b145ff87293a35d9001cb56f127a2b0` (Windows v0.4.8).
Worktree: `C:\Users\justi\Chad\jcad-2d-reliability`, branch `feature/remaining-2d-reliability`.
This is development work; no release, installer, signing or GPU renderer changes.

Status distinguishes a tested correction from completion of the entire priority. Source evidence
is the current branch and `SUPPORT-MATRIX.md`, rather than an earlier planning list.

The current batch is complete: polygon viewport DXF/display/input compatibility, dimension
style correctness, text/default override correctness, declared-height MTEXT flow and Windows
path/save protection. Independent review findings are fixed and covered by regressions. The
remaining feature/dependency rows below form later batches; no release or installer is implied.

| Priority | Current evidence and status | Ownership / dependency | Completion validation |
| --- | --- | --- | --- |
| 9 | Polygon DXF milestone implemented and tested: native closed straight-polyline boundaries, appearance, enable flag, copy/edit/undo/reopen, Canvas and vector/raster clips. Review corrections include enclosing hatch-pattern visibility and retained boundary layer/linetype resources during purge/export. Curved boundaries and DWG clip exposure remain missing. Graphical selection excludes fully hidden entities but keeps whole-entity tests for partially visible objects. | Lead; DWG boundary exposure depends on #19. | Import/edit/undo/save/reopen clip; Canvas, vector/raster plots and viewport activation agree. Unsupported curves stay reported. |
| 10 | Confirmed angular suppression, arrow ownership and gap defects corrected; style traversal and paper-space undo/redo implemented. Supported native override presence/value survives matching named styles and later redefinitions; scaling, Match Properties and existing direct-style editing remain compatible. Ordinate/arc-length types still missing. | Dimension agent; native DWG exposure remains #19. | Styles/overrides, every space, native fixture edit/save/reopen, undo/redo, geometry/bounds and plots. |
| 11 | Confirmed paragraph-ending justification, negative word gaps, phantom trailing-space lines and explicit Canvas style overrides corrected; 79 targeted tests and 3 PDF override tests pass. Installed-font wrapping/bounds still use stroke metrics; inline font/tracking/alignment incomplete. | Text agent and lead; PDF overrides aligned. | Canvas/PDF/bounds agree, installed/missing fonts, wrapping, alignment, Unicode and import-edit-reopen. |
| 12 | Missing: `pdf-vector.ts` uses standard Helvetica or stroke paths, without embedding exact fonts. | Independent; font resolution/licensing required. | Inspect embedded font resources, Unicode mapping and real PDF rasterization; permitted font redistribution. |
| 13 | Missing CTB/STB interpretation; layout sheet names select built-in color modes in `dxf-layouts.ts`. | Independent; real style table fixtures required. | Named/color-dependent tables, lineweight/screening/colors, layouts, save/reopen and external plot comparison. |
| 14 | Partial: `core/linetypes.ts` retains dash sequences, complex text/shapes absent. | Independent; #21 for SHX shapes. | Native definitions retain text/shape/style/placement and render at correct scale across segments and plots. |
| 15 | Partial: `mtext.ts` honors explicit column breaks/count/width/gutter/reversal; declared-height static/dynamic-manual flow now implemented (26 new tests), with overflow retained. Auto-height balancing remains missing. Native export replaced by `JCAD_MTEXT_COLUMNS` XDATA. | Independent; DWG embedded-object exposure #19. | Auto-flow/static heights, masks, edits, native column fixtures and external CAD reopen. |
| 16 | Missing gradient fields/rendering in hatch entity/reader/writer. | Independent; coordinate with #19 for DWG fields. | One/two-color gradients, angle/tint/shift, Canvas/PDF and native export/reopen. |
| 17 | Missing associations: HATCH export writes flag 71=0; links reported lost. | Object-reference integration #29. | Boundary edits/undo/erase update hatch; native ownership/reference roundtrip. |
| 18 | Partial: MULTILEADER becomes LEADER+MTEXT; block content not drawn. | Independent 2D model, native preservation with #19/#29. | Text/block content, leader context/style, editing, native export/reopen, no silent substitution. |
| 19 | External active work: reader/writer repairs, named views, FIELD/object links, dictionaries, layout/style metadata and real-file saving verification. | "Check GitHub access to JCad", PR #9, `codex/windows-dwg-metadata-reference-graph`. Do not duplicate/cherry-pick unfinished work. | Integrate only verified completed commits later, then rerun combined real-file checks. |
| 20 | Missing: xref block path/overlay flags retained, `xrefPlaceholder` shows frame; no external drawing loading/refresh. | Independent; Windows path grants and recursion/geometry limits required. | Relative paths, nesting/cycles, refresh/undo, missing files, no rewriting original references. |
| 21 | Missing: SHX styles use bundled Hershey substitute; no SHX decoder. | Independent; font/shape access and redistribution constraints. | Real font/shape fixtures, metrics, encoding/big-font and plotting. |
| 22 | Partial: table cells edited in JCad, export is INSERT + `JCAD_TABLE` XDATA. | Native table model/export; #19 for omitted DWG cells. | Native editable ACAD_TABLE reopened externally and in JCad, styles/cell values retained. |
| 23 | Partial: electrical attributes, WD_M settings and project metadata exist; remaining proprietary extensions require fixture-based audit. | Electrical audit; application dictionaries #29. | Real AutoCAD Electrical cases preserve exposed tags/catalog/connectivity/settings; report unmodeled metadata. |
| 24 | Confirmed NTFS defect: NFC collapsed distinct filename/folder spellings, risking wrong destination and root containment. Implemented exact Windows spelling in renderer/registry/atomic writer; native saves/backups tested. IPC guards and DWG export-picker identities aligned. Earlier atomic queue/autosave features already exist. | Reliability agent and lead; no native writer changes. | Independent Unicode files and .bak, grants/root containment, junction/race/failure tests and recovery lifecycle. |
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
- Final review added 34 regressions: 18 dimension-override cases, 12 viewport hatch-visibility
  cases and 4 retained boundary-resource cases. Native integer overrides normalize safely;
  native DIMTIH/DIMTOH values remain distinct despite the existing ISO display approximation.
  Ordinary immutable style edits still work without callers supplying override metadata.
- AutoCAD 2027 accepted the matching-style dimension export with **zero AUDIT errors**.
  DXFOUT retained native explicit DIMTXT=5 / DIMDEC=0 even when the named style matched.
  Exact-source JCad reimport and a later named-style change to 3 / 1 kept the entity at 5 / 0.
  The oracle used a private synthetic export and isolated AutoCAD profile in this worktree.
- `npm run e2e:2d-batch`: **7 checks passed in actual source Electron 44.7.0**, using only
  queued native Open/Save dialog answers. Real renderer, codecs, preload, IPC permissions,
  Windows disk writes and backups exercised polygon edit/undo/reopen, native pointer ownership,
  text default presence, MTEXT columns, safe clip-DWG refusal and distinct NFC/NFD files/tabs.
  The reopened paper-space screenshot shows the concave boundary and clipped model line.
  This gate does not certify the native DWG helper or an installed release.
- Final combined source snapshot `3d3198a`: **2,365 passed, 0 failed, 27 conditional skips**
  across 190 files. Required fixtures, broad lint, renderer/Electron/scripts TypeScript and
  production renderer build passed; all **8 dense benchmarks** passed separately. The full
  native-helper Electron gate remains unavailable
  in this private worktree because its signed portable helper is absent; no helper was copied
  from the other workstream and no installer was built.

## Integration notes and next milestones

- PR #9 remains open at the final review's read-only snapshot, head `83da418537777b7d5b09a2b7fd9a2ebe92784ded`.
  Unit checks passed there; UI/Windows end-to-end checks still required attention. Its native
  reader/writer and real-file saving verification remain that workstream's responsibility.
  No commits were copied from it. Resolve shared codec/layout conflicts deliberately and rerun
  native equivalence, combined 2D regressions and real-file saving before considering release.
- The baseline native helper removes object handles during its comparison. Newly retained
  viewport boundaries therefore remain explicitly blocked from DWG saving/export until clip
  pointer ownership is independently verified; lift the renderer guard only with that proof.
- Earlier full-suite runs encountered a WASM allocation failure in `dwg-host.test.ts` and an
  intermittent same-size-byte-rewrite assertion in unchanged `portable-dwg-host.test.ts`.
  Both files passed a focused 28-test rerun; a serial full run passed 2,322 tests before the last
  text-codec follow-up. These observations are retained rather than treated as native fixes.
  Audit the helper's timestamp/identity cache with the native saving workstream before release.
- Next independent feature: gradient HATCH DXF preservation/native emission, version promotion,
  transforms and rendering, using a new independent fixture. Native DWG conversion must be
  proven separately. Complex linetype element preservation is another independent candidate;
  SHX shape rendering and full capability-isolated plugins need separate architectural work.
