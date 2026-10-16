# Windows 2D and reliability implementation checklist

Current priority-12 source review (2026-10-15): `review/p12-used-glyphs-subsetting`
retains the tested 12.1 correction and reviews delivered used-glyph validation and
12.3 glyf subsetting. Static checks and real Windows subset Plot/save/reopen pass;
subset/whole-control Unicode and pixels match. Installed SimSun remains refused,
and the actual DWG/missing-SHX/Han composition remains unvalidated. The initial
two concurrent runs retained a large-file timeout; a test-lifecycle repair now
joins owned work and propagates cancellation before fixture cleanup. The fresh
two-worker gate passes 6,709 tests with 38 skips and unchanged deadlines. Earlier
failures remain recorded; the initial stall's cause is not established.
Packaged checks, remote CI and release integration remain
separate. See [PDF source-review evidence](PDF-FONT-EMBEDDING.md). The rest of the
long roadmap stays paused and GPU/DWG ownership is unchanged.

Delivery review continues: [priority-12 status](PRIORITY-12-REVIEW-STATUS.md)
distinguishes reviewed code from acceptance. 12.6a admission is held for confirmed
record/instance-selection defects and invalid fixtures; the 12.3 subsetter now
keeps variation-table programs whole. 12.2 is delivered and under review. 12.4
shipping dependency admission and 12.5 runtime shaping remain gated.

Current source-only continuation: [PR #18/#19 integration checkpoint](WINDOWS-SOURCE-INTEGRATION.md)
records the accepted heads, demonstrated seams, validation and remaining gates. It uses the same
owned worktree on `integration/windows-pr18-pr19-source`; both accepted branches are preserved.
The long roadmap remains paused. Older checkpoints below retain their historical attribution.

Baseline: `83aedbcc7b145ff87293a35d9001cb56f127a2b0` (Windows v0.4.8).
Worktree: `C:\Users\justi\Chad\jcad-2d-reliability`, branch `feature/remaining-2d-reliability`.
This work began as Windows development integration. The completed combined upgrade shipped as
[Windows v0.5.0](https://github.com/habit04/share/releases/tag/v0.5.0); the checkpoints below
retain the earlier integration evidence and outstanding scope.

Current follow-up: label the 3D orientation indicator and make tools available for new profiles
while retaining initial Canvas rendering, explicit opt-outs and imported-data compatibility.
Separate foreign 3D import from tool availability and protect hidden retained 3D objects from
generic 2D Select All edits. Validation includes settings migration, real import/edit/save/reopen,
selection undo/redo, actual viewport rendering/context restoration and Windows source-runtime
default/opt-out/restart/save/backup checks. This follow-up remains unreleased development work;
the long roadmap is still paused and GPU work retains its separate ownership.

Current work is deliberate integration: #24 is frozen and the long list stays
paused. A single lead integrates the delivered 3D source and the completed GPU
handoff `dc89bb0cbec839d489dce578034736c7cdb77dac` after clean gates. Both GPU
first-attempt CI runs and actual Intel/NVIDIA native checks pass. The remaining
partial features below are deferred; Canvas remains the default renderer.

Current cleared checkpoint `7b2fdea4c9e117a306dfcf1ae485f0eba5a83066` combines
the completed #19/#29 metadata work with 2D reliability and delivered 3D. It passes
5,083 local tests with zero failures/38 explicit skips, all static/build checks,
32 actual Windows source workflows, ten native first/second-save fixed points,
six mixed 2D/3D file workflows, 19 kernel-security checks, 3D visual checks and
AutoCAD 2027 private reference audits. [All four CI jobs pass](https://github.com/habit04/share/actions/runs/38520168590),
including 54 Rust, three CLI and 252 actual Windows Electron checks.

The frozen GPU leaf is now being integrated with three source owners. Newer
viewport/metadata safeguards stay intact; GPU text/dimensions use captured drawing
font context, unqualified fonts/SHX/active gradients use complete Canvas fallback,
and 3D mode hides the GPU 2D backing. Focused tests precede fresh complete combined
checks, CI and both actual adapter gates. Five reviewed Claude patches are adopted;
two unsafe tolerance proposals are replaced with repairs retaining real thin volumes
and small/scientific deltas. The corrected measurement source passes 62 focused
tests and independent review. Full native fixed-point checks stay intact.

The following checkpoints are historical evidence, not the current candidate's clearance.

Earlier `0447081` cleared the prerequisite: 4,394 local tests/28 existing skips,
static/build, 32 actual Windows source workflows, ten genuine native cases with
complete first/second metadata fixed points, and all four fresh CI jobs. Stable
`8dfe1caa` was integrated at `29abcec`; the corrected probe checkpoint `fccba52`
clears its combined validation. No release branch, signing or installer changes.

Latest gate: published `0982bda` clears all four CI jobs, 4,352 local tests (28
existing skips), static/build checks and 32 actual Windows source workflows.
The genuine native save gate exposed layout media/limits and overall-viewport
reference loss in the import/rewrite path. This branch owns the narrow integration
repair; the completed #19/#29 reader/writer work remains unchanged. The stored real
native snapshot passes the unchanged full metadata comparison after the repair.
Thirty-five new regressions pass, including copied/edited sheets, opaque metadata,
viewport clipping controls and undo/redo. Full source checks, fresh exact-head CI
and native first-save/reopen/second-save fixed point remain due before integration.
Copied sheets receive a generated overall viewport; imported originals retain
their native overall camera and properties. Existing unsafe metadata-dependent
layout deletions continue to refuse atomically.

Final follow-up repairs: the second native save exposed an invented annotation
dictionary entry; absent imported defaults now stay absent (seven new regressions).
The Windows CI loss-modal test is bound to the real import report and retains a
real unsupported DXF consent/backup/reopen control. Product safety policy and the
full metadata verifier are unchanged. Fresh complete gates remain due; no stable,
3D or GPU merge has been performed.

The corrected original-reference diagnostic at `3c3592` now passes all eight native
reads with unchanged originals/copies and complete typed/raw Aux agreement. The
development repair sets a captured fixed-hour source creation context only
in the isolated postflight child and verifies its actual offset before input.
Existing creation/fixed-point guards, reader/writer assets and ordinary opens stay
unchanged. Twelve Node cases plus the permanent CI adapter pass; the current tracked
runtime passes eight actual shipped-WASM reads under UTC and Chicago parents and 48
creation mutation/deletion refusals. Complete payloads, original/private-copy hashes
and 20 native assets remain unchanged; all owned children close. The probe covers
creation and one retained scalar, not whole-metadata/native-writer/OS containment.
The earlier normal-disconnect harness failure remains recorded. Corrections address
17 checkJS diagnostics and the stale explicit-DXF version assertion while retaining
all deadlines and other checks. All three TypeScript projects, scoped lint and 115
focused tests pass locally. Full local/build/app, fresh exact-head CI and genuine
helper/C first/second-save gates remain due before stable/3D/GPU merges.

The full PR/branch history, delivered GPU milestones and proposed combined Windows
upgrade are recorded in [WINDOWS-UPGRADE-INTEGRATION.md](WINDOWS-UPGRADE-INTEGRATION.md).
GPU milestones remain owned by their separate workstreams; this checklist is not
the complete inventory of all JCad work.

Status distinguishes a tested correction from completion of the entire priority. Source evidence
is the current branch and `SUPPORT-MATRIX.md`, rather than an earlier planning list.

The user has paused further work through the long roadmap. The current batch finishes
priority **24**, including confirmed direct text/PDF export ordering and source-protection
defects. Its frozen commit `739950c` passed local validation and all four exact-head CI jobs.
The completed #9 source is now combined with this batch; prior combined heads passed
their local gates. The color/path head now passes its normal full suite; the current
material/style repair has focused/static passes and awaits combined local/native CI gates.
Each combined published head must clear fresh CI before adopting the next milestone.
The next work is deliberate integration of completed 3D and eligible GPU development milestones;
partial rows below remain recorded scope rather than new implementation assignments.

The #24 freeze at `739950c` passed all four exact-head CI jobs. Completed #9 source
integration is now the first combined milestone; its tests and CI are separate gates.

Completed corrections so far include: polygon viewport DXF/display/input compatibility, dimension
style correctness, text/default override correctness, declared-height MTEXT flow and Windows
path/save protection. Independent review findings are fixed and covered by regressions. The
remaining feature/dependency rows below form later batches; no release or installer is implied.
Later milestones retain native gradient HATCH definitions, render verified unshifted LINEAR
fills, add Windows font geometry/eligible TrueType PDF embedding, and preserve native complex
linetype descriptors and apply a verified CTB/STB plotting subset. The feature/dependency rows
remain open where full compatibility is unverified.

| Priority | Current evidence and status | Ownership / dependency | Completion validation |
| --- | --- | --- | --- |
| 9 | Polygon DXF milestone implemented and tested: native closed straight-polyline boundaries, appearance, enable flag, copy/edit/undo/reopen, Canvas and vector/raster clips. Review corrections include enclosing hatch-pattern visibility and retained boundary layer/linetype resources during purge/export. Curved boundaries and DWG clip exposure remain missing. Graphical selection excludes fully hidden entities but keeps whole-entity tests for partially visible objects. | Lead; DWG boundary exposure depends on #19. | Import/edit/undo/save/reopen clip; Canvas, vector/raster plots and viewport activation agree. Unsupported curves stay reported. |
| 10 | Angular style/override corrections and native XY ordinate import/export are implemented and tested. Ordinate datum/text frames, leaders, direct scale behavior and font cache invalidation match native cases; malformed flags refuse import. Scaled/nonuniform block display/explosion uses local primitives and retains editable source blocks on ordinary DXF save. Creation UI, arc-length types and ordinate DWG conversion remain open; the unchanged DWG fixture's three omitted ordinates are explicitly tested. | Dimension agent; native DWG exposure remains #19. | Retain styles/overrides, every space, native edit/undo/save/reopen, geometry and plots. Extend creation/arc-length/DWG only with native evidence. |
| 11 | Windows font metrics, native TEXT placement and ink-based MTEXT attachment/wrapping implemented and tested. Per-drawing geometry drives Canvas, bounds/selection, masks, annotation fitting and captured raster/eligible vector plots. Missing/unsupported faces, bitmap glyphs and unverified origins use Canvas measurement; contextual scripts retain shaping. Tall-glyph MTEXT leading, inline font/tracking and Unicode edge cases remain open. See `WINDOWS-FONT-METRICS.md`. | Text agent and lead; reader-omitted annotation font fields depend on #19. | Retain native/actual Windows IPC/Canvas/raster/STYLE edit/undo/DXF reopen checks; extend tall leading and formatted Unicode fixtures. |
| 12 | Partial: standalone TrueType embedding plus bounded whole extraction of the collection face selected for family/style (12.1). Review correction prefers unstyled unspecified flags regardless of face order; no-family/no-style requests retain face 0. Metrics, permissions, glyph mappings and embedded programs share one face. Windows source Electron 44.7.2 workers/IPC/Plot, regular/bold inline MTEXT, edit/undo/redo/DXF save/reopen and cancellation pass for installed Nirmala faces 0/1/3 plus Arial. Local full suite: 6,647 passed/38 skipped; targeted fonts: 256 passed. Independent PDF check: 1,016/1,017, with one preserved Poppler warning reproduced by a separate non-JCad Helvetica control; five Canvas/PDF crops pass unchanged 3px tolerance. A private AutoCAD reference adds 263 independent checks of twelve TEXT cases, actual font/glyph identity and native textbox geometry; its native-writer strict-parser diagnostic is preserved. Cambria origin refusal remains distinct. Used-glyph PDF validation is implemented, but installed SimSun still refuses at the bitmap/origin gate, YaHei at conflicting PostScript names, and SimHei/FangSong are absent. Actual missing-SHX/Han/DWG composition remains unvalidated. Screen metrics keep the whole-face budget and Canvas fallback. GID-preserving glyf subsetting (12.3) is reviewed with subset tags, empty-glyph and maxp corrections; real Windows subset Plot/save/reopen and exact whole-control pixels pass. Independent subset PDF check is 2,377/2,378 with the same preserved external Poppler warning. The fresh two-worker local gate passes 6,709 tests/38 skips after cancellation/cleanup repair; earlier timeouts remain recorded and remote CI is not yet run. CFF/variable/color, shaping and preview/print-only PDFs remain open. See `PDF-FONT-EMBEDDING.md`. | Lead; Muse 12.1 handoff reviewed and corrected on `review/p12-collection-faces`; unmerged development. Fonts/programs private. Later CFF/variable reader changes and DWG shared text/fallback changes need reconciliation. | Retain permission/path/capture regressions and bounded workers; verify delivered milestones independently and combined. Packaged-app acceptance and broader native collection/script coverage remain open; source results do not certify an installer. |
| 13 | Verified plotting subset implemented: bounded reader, ephemeral Plot dialog file selection, native color/screening/grayscale/weight semantics and shared vector/raster appearance. TrueColor CTB bypass, explicit whole-plot STB selection, captured state and nested ByBlock widths tested. Native/actual UI proof passes 1,823 checks. Device and unsupported policy effects are reported. Exact layout filenames and imported native named assignments remain open. See `PLOT-STYLE-TABLES.md`. | Independent parser/plotting; exact layout filename/PSTYLEMODE/style-reference integration depends on completed external #19/#29. | Retain native colors/weights/screens and dialog/vector/raster tests; add imported named assignments and save/reopen metadata after verified integration. |
| 14 | DXF retention milestone implemented: ordered text/shape descriptors, literal padded text, radians/absolute flags, offsets/scales and resolved STYLE resources survive geometry edits, undo/redo and repeated DXF reopen. Unused anonymous shape STYLEs survive purge/export. Canvas sign/phase bug corrected for consecutive gaps/dashes and odd patterns. Missing/malformed resources refuse saving; unverified DWG conversion is guarded. Embedded glyph display remains missing. See `COMPLEX-LINETYPES.md`. | Independent DXF model; #21 for SHX shape display; DWG/extension metadata still #19/#29. | Retain native AUDIT/actual app save-backup-recovery proof; add native text/shape placement and vector/raster fidelity before claiming full rendering. |
| 15 | Partial: `mtext.ts` honors explicit column breaks/count/width/gutter/reversal; declared-height static/dynamic-manual flow now implemented (26 new tests), with overflow retained. Auto-height balancing remains missing. Native export replaced by `JCAD_MTEXT_COLUMNS` XDATA. | Independent; DWG embedded-object exposure #19. | Auto-flow/static heights, masks, edits, native column fixtures and external CAD reopen. |
| 16 | Partial milestone implemented: native DXF gradient name/angle/shift/dialog mode/tint/color records and inactive descriptors retained; all nine names and both endpoint shifts externally reopened. Unshifted LINEAR Canvas and vector/raster plotting verified, including holes, opacity, ACI/RGB, direct transforms and affine block instances. HATCHEDIT angle/shift is undoable; explicit SOLID conversion retains an inactive descriptor. Named-pattern conversion is refused because native DXF cannot retain the combination. Nonlinear/nonzero-shift rendering uses a reported solid fallback. Destructive EXPLODE and unverified DWG saving are guarded. See `HATCH-GRADIENTS.md`. | Independent; native DWG fields/conversion still #19. | Complete nonlinear/shifted fields from native reference; native DWG metadata equivalence; retain current DXF/Canvas/PDF/edit/reopen checks. |
| 17 | Missing associations: HATCH export writes flag 71=0; links reported lost. | Object-reference integration #29. | Boundary edits/undo/erase update hatch; native ownership/reference roundtrip. |
| 18 | Partial: MULTILEADER becomes LEADER+MTEXT; block content not drawn. | Independent 2D model, native preservation with #19/#29. | Text/block content, leader context/style, editing, native export/reopen, no silent substitution. |
| 19 | **Completed externally and released in Windows v0.4.9. Integration only on this branch.** PR #9 merged at head 14cb3f9 (merge 8dfe1ca); the release was published on 2026-10-13. Its reader/writer metadata, named views, FIELD/object links and installed save/reopen verification without AutoCAD are completed work, not new implementation assignments here. The completed graph/codecs/native source are integrated at 29abcec and cleared at fccba52 with genuine native metadata fixed points, 32 app flows and exact-head CI. Subsequent 3D integration receives fresh combined validation. | Completed by "Check GitHub access to JCad", [PR #9](https://github.com/habit04/share/pull/9), `codex/windows-dwg-metadata-reference-graph`; verified [v0.4.9](https://github.com/habit04/share/releases/tag/v0.4.9). Lead owns compatibility integration only. | Reuse verified completed slices, resolve shared codecs deliberately and test the combined branch. Do not duplicate reader/writer repairs or release work. |
| 20 | Missing: xref block path/overlay flags retained, `xrefPlaceholder` shows frame; no external drawing loading/refresh. | Independent; Windows path grants and recursion/geometry limits required. | Relative paths, nesting/cycles, refresh/undo, missing files, no rewriting original references. |
| 21 | Horizontal SHX milestone implemented: bounded native shape/unifont decoder, explicit Windows SHXFONT/SHXLOAD picker, per-session resources, native TEXT ink/space/fitting/descent rules and shared Canvas/raster/eligible vector paths. Native/actual app proof passes 1,477 checks plus the final rebuilt save/default/backup/reopen gate. Unsupported glyphs/modes retain substitutes. BigFont, vertical/mirrored text, fractional arcs and complex-linetype glyph painting remain open. See `SHX-FONTS.md`. | Independent; no proprietary font bytes committed. DWG exposure/reference dependencies remain #19. | Retain native fixture, metrics/plot/real IPC/undo/save/reopen proof; extend each encoding/mode and linetype placement with native fixtures. |
| 22 | Partial: table cells edited in JCad, export is INSERT + `JCAD_TABLE` XDATA. | Native table model/export; #19 for omitted DWG cells. | Native editable ACAD_TABLE reopened externally and in JCad, styles/cell values retained. |
| 23 | Partial: electrical attributes, WD_M settings and project metadata exist; remaining proprietary extensions require fixture-based audit. | Electrical audit; application dictionaries #29. | Real AutoCAD Electrical cases preserve exposed tags/catalog/connectivity/settings; report unmodeled metadata. |
| 24 | Current milestone implemented: native admissions, Unicode grants, byte-digest and completed-open lineage protection, stored leaf preservation, guarded backups and bounded whole-project preparation. Text/PDF exports share order/source guards; PDF resources and direct CSV report inputs are captured before awaits, stale/retired output refuses, cancellation joins cleanup and exports preserve dirty/history/recovery. Detached report proofs release, and unverified replacements warn explicitly. A final-gate native plugin collision was repaired with bounded fresh-byte verification; source-read policy is unchanged. Native/app regression evidence is recorded below. The final suite and all four exact-final-head CI jobs passed at 739950c before source integration began. Provider/UNC/case-sensitive fixtures and Node's final OS race remain limitations. See `WINDOWS-SAVE-ADMISSIONS.md`. | Lead/reliability; host-owned orders, native identity and bytes. Completed helper hunk credited to PR #9; completed reader/metadata integration is separate. | Frozen milestone; retain every save/export/read regression and original limit/deadline through each combined integration gate. Externally unavailable provider fixtures remain explicit requirements rather than a universal race-free claim. |
| 25 | Plugin read races/Unicode escapes and lifecycle revocation implemented: bounded descriptors, stale-load/reload ownership, scoped prompt/dialog/picker cleanup and nested transaction rollback. API v1 remains full-trust page code; capability isolation is missing. See `PLUGIN-SOURCE-READS.md`. | Independent source/lifecycle fixes; separate realm/RPC compatibility architecture for full isolation. | Retain real file-read and unload/reload regressions, then enforce declared caps outside plugin globals with actual denied operations and explicit migration. |
| 28 | Missing specialized entities and PDF/DGN/DWF underlays; unsupported records reported (`SUPPORT-MATRIX.md`). | Independent per-entity milestones; parsers/licensing required for underlays. | Preserve source/reference metadata; fixture import/edit/save/reopen and visible unsupported feedback. |
| 29 | **Completed externally in PR #9/v0.4.9; integration only.** Bounded metadata/object-reference preservation is already implemented. The completed graph/codecs are integrated with current compatibility/save guards and clear fccba52 validation. 3D carrier extensions receive new combined native/reference checks. | Same completed external work as #19; lead owns compatibility integration, not duplicate implementation. | Reuse the completed graph and verify metadata equivalence, ownership and real-file edit/save/reopen on the combined branch. |
| 30 | Missing dynamic-block actions/parameters and constraints; static INSERT representation exists. | #29 reference graph prerequisite. | Native actions/parameters/constraints retained, safe supported edits, explicit unsupported cases. |
| 31 | Missing sheet sets, data links and drawing digital signatures. Drawing signatures differ from installer signing. | Formats/reference graph/licensed validation prerequisites. | Real sheet/data-link fixtures; signature validity and explicit invalidation on edits, no false signing claim. |
| 32 | **Delivered 3D milestones 0–7 integrated and validated at 7b2fdea.** The local suite passes 5,083 tests with zero failures/38 skips; all static/build checks and four CI jobs pass. Actual gates pass ten native cases, 32 app workflows, 19 kernel-security checks, private AutoCAD DXF/DWG audits, 3D visual checks and six mixed 2D/3D file workflows. Default off; native ACIS/DWG solid export and full font/view/plot parity remain limited. Claude follow-ups are reviewed separately; combined GPU adoption needs fresh gates. | Lead integration with separate core, codec and reliability owners; [delivered plan/status](https://github.com/habit04/share/blob/feature/3d-development/docs/3D-PLAN.md). | Retain complete source/native/app/AutoCAD/security/CI assertions on each combined source. Producer or mock-only passes never substitute for actual combined hardware checks. No installer stage here. |

Completed baseline priorities 1–6, 8 and portable Windows DWG saving #27 remain regression
coverage, not rebuild work. #7 was superseded by portable saving. #26 (Mac/Linux updates) and
#32 (full 3D) implementation remain outside this branch; its delivered external milestones are
recorded above. Unsupported requirements above are still open; a dependency is not
proof that their implementation or external verification has passed.

## Current validation and integration

- Previous session-basis/common-link combination (`e18012cd`): **3,954 tests / 28 conditional skips**, all three TypeScript
  projects, broad lint, fixtures and production build pass. **32 actual Windows source-Electron
  workflows** pass together: 14 opened-source/save/recovery, seven tracked 2D import/edit/save/
  reopen and 11 PDF/CSV export workflows. All private app processes close; production bundle,
  source/native/config/harness hashes remain unchanged through the app run. Independent native
  ATTRIB handle uniqueness and exact reopened identity checks supplement every previous text
  comparison. The complete suite/static/build and all 32 workflows were repeated for the
  fresh session-basis/common-link changes below. Original deadlines and guards remain.
  Three existing native metadata fixture families pass the adopted decoder/projection validators
  with zero native/write errors and complete bounded inventories. This reuses completed #9
  native assets; it does not certify a locally rebuilt writer, new installer or AutoCAD roundtrip.
  [Current PR checks](https://github.com/habit04/share/pull/11/checks) must pass on the exact
  published combination before the 3D stage. Parent CI and local decoder evidence do not
  replace that matching-helper/Windows gate.
- Current color/path repair: **318 focused backend tests** and **173 path/project tests**
  pass, along with all three TypeScript projects, broad lint, fixtures and production build.
  All **32 Windows app workflows** pass on the current unchanged bundle, with no remaining
  owned processes or fallback termination. Two normal full-suite runs each retain **4,097
  passes / 28 skips / one failure**: the unchanged extended-PDF safety case reaches its
  60-second timeout and then its 10-second cleanup timeout. Its unchanged 34-case suite
  passes separately. A full run with private syscall tracing passes **4,098 / 28 skips**;
  this is diagnostic evidence, not normal-suite clearance. No production deadlock is
  established. The original source, limits and assertions are preserved while sparse
  phase tracing investigates the stall. Publishing independently tested repair commits
  for fresh CI does not clear this gate or authorize ancestry/3D/GPU integration.
- Fresh uninstrumented `a44cc60` validation passes **4,098 tests / 28 skips**, with the
  original PDF case in 295 ms and 512-drawing case in 5,836 ms. Both earlier timeouts remain
  recorded with unproven cause. Exact-head CI passes both Node jobs and UI; Windows passes
  **54 Rust + three CLI tests** and containment, then safely refuses MATERIAL expansion
  `110 -> 151`. The later recovery-row failure follows the aborted export setup.
- The next checker-only repair passes **519 focused tests**, including **183 new material
  and 32 retained-style cases**, all three typechecks and scoped lint. Only recognized compact
  AC1032 materials get 41 exactly checked defaults; all 96 matrix values, source flags,
  ownership, opaque data and references remain checked. Modern MLEADERSTYLE null/attachment
  normalization and MLINESTYLE matched-LTYPE identities preserve legacy raw behavior and
  refuse ambiguous fields. Full/static/build/app and fresh exact-head CI remain gates for
  this new source. Actual matching-helper first/second-save and independent C comparison
  are mandatory: native typed snapshots do not certify every MATERIAL convenience field.
  Heavy local gates are sequenced after the linked GPU session's native adapter timing.
  No ancestry/3D/GPU adoption has begun.
- Exact `6d2c77d` CI passes UI; both Node jobs fail only a new fixture hash expecting
  CRLF instead of Git's LF text checkout. Canonical LF bytes equal the exact Git blob;
  the correction preserves raw input/readback and passes 215 material/style tests.
  Windows passes 54 Rust + three CLI/containment cases, then refuses TABLESTYLE159
  common-block order: the legacy comparison projection emits REACTORS/XDICTIONARY,
  while native C emits XDICTIONARY/REACTORS. The TABLESTYLE-only symmetric repair passes
  **557 focused tests**, including **38 new framing regressions**, retaining each block,
  owner, ordered mapped links and opaque data. Full/local/app/fresh CI and actual
  matching-helper first/second-save C gates remain pending for this source.
- Current `db7203a` normal full validation passes **4,351 / 28 skips** and all
  **32 source-desktop workflows**; typechecks, broad lint, fixtures and build pass.
  A restricted-context run retained 52 qualified filesystem permission failures and
  two timeouts; a confined capability probe and native-context run clear the tests
  with original assertions/deadlines. Timeout cause remains unproven. Exact CI passes
  both Node jobs and UI; Windows passes 54 Rust + three CLI/containment checks, then
  refuses a five-hour `$TDCREATE` difference. C derives this local field from UTC and
  host timezone, so creation-instant loss is not established. Four unchanged originals
  expose no raw Aux API in the current binary. The isolated source-built diagnostic passes
  14 tooling and 77 workflow regressions; native compilation/raw date measurement is pending.
  Production dates, strict comparison and pins remain unchanged.
- At `1a3a511`, the native diagnostic compiles/links with the factory class configuration;
  17 tooling and 77 workflow regressions pass. Exact CI passes both Node jobs/UI and still
  refuses the creation-date mismatch on Windows. The first diagnostic read reports invalid
  Aux dates and refuses certification; seven reads remain unrun. Source review finds no
  supported ABI mismatch, but C/Rust AC1032 maintenance widths and trailing fields disagree.
  Bounded field-span/raw-section observations and failure-path input rehashing are next;
  neither original stored dates nor a production parser repair is certified.
- First combined CI at `e477954` found a Node 22 512-drawing deadline failure, a safely refused
  legacy-to-modern TABLESTYLE difference and a stale browser report check. The recovery failure
  followed the aborted export setup. The correction keeps the original 15-second test and limits
  competing CI workers to two. Stronger native-kind/per-row report checks pass 28 actual site
  workflows; all 48 authoritative Ubuntu screenshots pass with the original image tolerances.
  The one reviewed image change is warning text, with drawing geometry unchanged.
- TABLESTYLE conversion now validates all three legacy rows against retained native CELLSTYLEMAP
  formats, exact STYLE links, margins, colors, grids and common links. Unsupported inactive values
  refuse before encoding; strict typed snapshots and independent C postflight remain intact.
  **239 targeted checks, including 36 new cases**, pass. A genuine Rust binary-roundtrip fixture
  and mutation/refusal cases compile in Windows CI. At `eb692896`, Node 22, Node 24 and UI pass,
  while native tests pass 50/51: the new binary case detects removed imported compatibility
  dictionary entries. The authenticated writer patch limits cleanup to generated styles without
  DXF or native DWG source provenance, preserving imported entries and child records. Strict
  assertions remain unchanged; corrected matching-helper CI and actual C postflight must pass.
  Seven authenticated-source regressions pass; added native controls check both saves and the
  complete map payload. The full local Windows suite runs serially with original deadlines:
  its 33-file native project case passed in 18.7 seconds when measured separately, with most
  time in fresh backup/write guards. Parallel local filesystem contention is recorded separately.
  An original DWG with implicit margins cannot certify its DXFOUT's explicit-margin conversion.
  Development helper/source/notices/
  integrity artifacts support private reproduction; no installer/signing workflow was changed.
- At `208bede7`, Node 24/UI pass, Node 22 exceeds the original 512-drawing deadline and
  native Rust passes 51/53. Two scoped repairs are under validation: capture sessions once
  per synchronous project-basis scan, with fresh scans around awaits; expose existing typed
  DataObject reactors/extension dictionaries through authenticated native accessors.
  **163 project tests** pass, including four added regressions and the unchanged 512 case
  in 7.7 seconds (8.4 seconds in the full suite). **246 native/metadata targeted checks** pass. Transport doubles and local
  source checks do not certify Node 22 CI or the 54 native Rust cases; fresh exact-head CI,
  matching-helper roundtrips and independent C postflight must clear before integration.
- Exact `e18012cd` CI clears both Node jobs/UI and all 54 Rust + three CLI cases.
  Windows end-to-end export refuses a VPORT ambient-color representation difference;
  the destination stays unchanged and the recovery setup failure follows that abort.
  The unchanged original AutoCAD DWG/C decode reproduces the same RGB with a C2 method
  byte. A field-specific checked semantic comparison is being validated, with exact
  RGB/count/ACI/name/unknown-field and unsupported-method guards. Node 22's 512 case
  passes in 14,886/15,000 ms; measured normalization cost motivates bounded reuse for
  each synchronous scan with fresh aliases/platform checks. Fresh full/app/exact-head
  CI and matching-helper C postflight remain required; no integration is declared clean.
- Related VISUALSTYLE RGB comparisons are restricted to the eight typed color slots in a
  complete modern 58-property bag. Checked0/C2 storage compares every RGB bit; its derived
  ACI companion is one color property's fallback, while standalone ACI, lighting177,
  selectors/count/order, references and opaque data remain exact. **318 backend checks**
  pass, including 88 new style cases. **173 path/project checks** pass; bounded normalization
  stays within one synchronous scan and native aliases/platform remain live. The unchanged
  512 case takes 6.7 seconds locally. Fresh combined/Windows app/CI/native gates remain due.
  One targeted memory failure is retained separately from the unchanged31-case isolated pass.
- Integration corrections retain modeled complex-LTYPE edits and opaque extensions, distinct
  anonymous STYLE identities, enabled/disabled/shared viewport boundary ownership, graph-aware
  copies/transforms/layout copies and fixed-point native 340 export. Full session/history and
  project preflight refuse invalid graph/ordinate proposals before tab, proof, backup or write
  mutation. Two required metadata runtime modules are included in existing builder filters;
  version, dependencies, signing and release workflows are unchanged.
- Final #24 batch: **3,663 tests / 28 conditional skips**, all three TypeScript projects,
  broad lint, fixtures and production build pass on frozen source. The export follow-up adds
  **110 regressions** (34 native foundation, 32 guarded IPC and 44 renderer/report cases).
  **11 actual Windows export workflows** use real vector/native raster PDFs, files, backups,
  source protection and recovery, with joined cancellation/reload. **14 existing opened-source
  + 7 tracked 2D workflows** pass on the same export build. A subsequent CJS-only plugin-byte
  repair adds seven regressions, **132 targeted checks**, **64/64 native changed-file refusals**
  (38 real metadata collisions) and **six actual source-Electron IPC checks**. The renderer
  bundle is unchanged; those app runs are separate source snapshots, not 38 checks on one SHA.
  All owned processes close. Original test deadlines/guards remain; only stale source-contract
  assertions and owned large-fixture teardown were corrected. [All four exact-final-head CI
  jobs at 739950c pass](https://github.com/habit04/share/actions/runs/38434090041), including
  actual Windows Electron/native helper and UI checks, before source integration began.
  Source/provider/large-IPC limits remain documented.
- Previous completed-open branch: **3,546 tests / 28 conditional skips**, all three TypeScript projects,
  broad lint, fixtures and production build pass. The rebuilt source Electron passes **14 new
  opened-source/recovery workflows + 7 existing tracked 2D workflows**, with unchanged production
  source/bundle hashes and closed owned processes. The prior byte-digest milestone passed
  **9 project + 17 save/recovery + 7 tracked 2D workflows**, including 33 closed project drawings
  with exact backups and a retained open paper tab. These are separately recorded source runs.
- Completed-open protection: **31 backend + 28 renderer regressions**, **16 actual Windows IPC
  cases**, and **six independent native protocol probes**. The DWG IPC contract uses mock native
  conversion; actual desktop checks use authored private DXFs. Two refused outside-edit saves
  preserve the exact original backup, file bytes and recovery; own/copy/overlap/project saves pass.
- CI follow-up keeps all existing DWG IPC assertions and explicitly separates native Windows
  identity checks from POSIX protocol doubles. Nine additional actual Windows checks verify the
  corrected standalone-backup/unused-proof/clean-tab-close harness paths. Full local general
  Electron E2E is unavailable without its matching native helper; [all four corrected-head CI
  jobs at 26c9dac pass](https://github.com/habit04/share/actions/runs/38417374158). That evidence
  does not cover the subsequent export follow-up; the separate 739950c run above does.
- Ordinate: **42 regressions**, **263 native save/reopen comparisons**, two zero-error AUDITs,
  **214 geometry + 19 scaling comparisons** at 1e-8, and **66 Canvas/raster/Poppler checks**.
  Cross-renderer bounds use two pixels; they are not native PDF pixel equality.
- Byte-digest foundation: **160 targeted tests**, including 25 actual-byte/controlled-stat cases.
  Repaired native 64 ordinary + 64 project trials refuse all outside edits; an independent
  64-trial probe also refuses a real five-field timestamp collision. Full 512-output throughput
  remains uncertified under the ten-minute lifetime; the final check-to-rename race remains.
- The frozen SHX/plotting milestone passed **3,092 tests / 28 conditional skips**, all three
  TypeScript projects, broad lint, fixtures, production build and eight dense benchmarks.
  SHX passed **1,477 native/actual Windows/Poppler checks**, final app save/backup/reopen and
  two native AUDIT0 runs. See `SHX-FONTS.md` for supported formats and explicit substitutes.
- CTB/STB passed **1,823 native/actual checks**; prior standalone TrueType PDF embedding
  passed **1,496**.
  Native MTEXT remains **198/216**, with 18 tall Times leading differences kept at the
  original tolerance. Font/plot/gradient/linetype documents record these individual limits.
- Plugin lifecycle passed **153 targeted checks** and **11 actual Chrome source/DOM checks**;
  source-read tests and native production-callback probes are separate from a capability sandbox.
- Save admission/preparation passed **88 native tests**; renderer transport tests passed **31**
  cases. Combined reliability branch passed **3,280 tests / 28 conditional skips**, all three
  TypeScript projects, broad lint and fixtures. Final source Electron passed **17 save/recovery
  workflows** plus **7 tracked 2D workflows**, with unchanged source/bundle hashes. Real IPC,
  codecs, NTFS files, backups and recovery UI ran; only native destination answers were queued.
  Both owned app profiles/processes were closed. This does not certify a new installer/DWG helper.
- PR #9 merged head `14cb3f9` / merge `8dfe1ca` was verified and published as Windows v0.4.9
  by its owner. Its completed graph/codecs/native source and assets are reused in the combined
  stage above. This is compatibility integration, not a second implementation of #19/#29.
- Historical source snapshots and provenance remain in [REMAINING-2D-EVIDENCE.md](REMAINING-2D-EVIDENCE.md).
  This checklist records tested corrections and partial features, not completion of the roadmap.
