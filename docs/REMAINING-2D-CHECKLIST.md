# Windows 2D and reliability implementation checklist

Baseline: `83aedbcc7b145ff87293a35d9001cb56f127a2b0` (Windows v0.4.8).
Worktree: `C:\Users\justi\Chad\jcad-2d-reliability`, branch `feature/remaining-2d-reliability`.
This is development work; no release, installer, signing or GPU renderer changes.

The full PR/branch history, delivered GPU milestones and proposed combined Windows
upgrade are recorded in [WINDOWS-UPGRADE-INTEGRATION.md](WINDOWS-UPGRADE-INTEGRATION.md).
GPU milestones remain owned by their separate workstreams; this checklist is not
the complete inventory of all JCad work.

Status distinguishes a tested correction from completion of the entire priority. Source evidence
is the current branch and `SUPPORT-MATRIX.md`, rather than an earlier planning list.

The user has paused further work through the long roadmap. The current batch finishes
priority **24**, including confirmed direct text/PDF export ordering and source-protection
defects. Its frozen commit `739950c` passed local validation and all four exact-head CI jobs.
The completed #9 source is now combined with this batch and has passed its local gates.
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
| 12 | Standalone TrueType slice implemented: confined same-read font programs/metrics, version-aware embedding permissions, full Type0/CIDFontType2 programs, native advances/placement and ToUnicode. Captured plot scope, clip/annotation font budgeting and explicit substitutes tested. TTC/CFF/variable/color fonts, contextual shaping, subsetting and preview/print-only read-only PDFs remain open. See `PDF-FONT-EMBEDDING.md`. | Lead; installed fonts read only, no font programs committed. | Retain resource/extraction/Poppler/native reference/UI plot checks; add fixtures before extending font formats or licensing modes. |
| 13 | Verified plotting subset implemented: bounded reader, ephemeral Plot dialog file selection, native color/screening/grayscale/weight semantics and shared vector/raster appearance. TrueColor CTB bypass, explicit whole-plot STB selection, captured state and nested ByBlock widths tested. Native/actual UI proof passes 1,823 checks. Device and unsupported policy effects are reported. Exact layout filenames and imported native named assignments remain open. See `PLOT-STYLE-TABLES.md`. | Independent parser/plotting; exact layout filename/PSTYLEMODE/style-reference integration depends on completed external #19/#29. | Retain native colors/weights/screens and dialog/vector/raster tests; add imported named assignments and save/reopen metadata after verified integration. |
| 14 | DXF retention milestone implemented: ordered text/shape descriptors, literal padded text, radians/absolute flags, offsets/scales and resolved STYLE resources survive geometry edits, undo/redo and repeated DXF reopen. Unused anonymous shape STYLEs survive purge/export. Canvas sign/phase bug corrected for consecutive gaps/dashes and odd patterns. Missing/malformed resources refuse saving; unverified DWG conversion is guarded. Embedded glyph display remains missing. See `COMPLEX-LINETYPES.md`. | Independent DXF model; #21 for SHX shape display; DWG/extension metadata still #19/#29. | Retain native AUDIT/actual app save-backup-recovery proof; add native text/shape placement and vector/raster fidelity before claiming full rendering. |
| 15 | Partial: `mtext.ts` honors explicit column breaks/count/width/gutter/reversal; declared-height static/dynamic-manual flow now implemented (26 new tests), with overflow retained. Auto-height balancing remains missing. Native export replaced by `JCAD_MTEXT_COLUMNS` XDATA. | Independent; DWG embedded-object exposure #19. | Auto-flow/static heights, masks, edits, native column fixtures and external CAD reopen. |
| 16 | Partial milestone implemented: native DXF gradient name/angle/shift/dialog mode/tint/color records and inactive descriptors retained; all nine names and both endpoint shifts externally reopened. Unshifted LINEAR Canvas and vector/raster plotting verified, including holes, opacity, ACI/RGB, direct transforms and affine block instances. HATCHEDIT angle/shift is undoable; explicit SOLID conversion retains an inactive descriptor. Named-pattern conversion is refused because native DXF cannot retain the combination. Nonlinear/nonzero-shift rendering uses a reported solid fallback. Destructive EXPLODE and unverified DWG saving are guarded. See `HATCH-GRADIENTS.md`. | Independent; native DWG fields/conversion still #19. | Complete nonlinear/shifted fields from native reference; native DWG metadata equivalence; retain current DXF/Canvas/PDF/edit/reopen checks. |
| 17 | Missing associations: HATCH export writes flag 71=0; links reported lost. | Object-reference integration #29. | Boundary edits/undo/erase update hatch; native ownership/reference roundtrip. |
| 18 | Partial: MULTILEADER becomes LEADER+MTEXT; block content not drawn. | Independent 2D model, native preservation with #19/#29. | Text/block content, leader context/style, editing, native export/reopen, no silent substitution. |
| 19 | **Completed externally and released in Windows v0.4.9. Integration only on this branch.** PR #9 merged at head 14cb3f9 (merge 8dfe1ca); the release was published on 2026-10-13. Its reader/writer metadata, named views, FIELD/object links and installed save/reopen verification without AutoCAD are completed work, not new implementation assignments here. This v0.4.8-based branch is now combining the completed graph, codecs and matching native source with the #24 freeze; combined validation remains a separate gate. | Completed by "Check GitHub access to JCad", [PR #9](https://github.com/habit04/share/pull/9), `codex/windows-dwg-metadata-reference-graph`; verified [v0.4.9](https://github.com/habit04/share/releases/tag/v0.4.9). Lead owns compatibility integration only. | Reuse verified completed slices, resolve shared codecs deliberately and test the combined branch. Do not duplicate reader/writer repairs or release work. |
| 20 | Missing: xref block path/overlay flags retained, `xrefPlaceholder` shows frame; no external drawing loading/refresh. | Independent; Windows path grants and recursion/geometry limits required. | Relative paths, nesting/cycles, refresh/undo, missing files, no rewriting original references. |
| 21 | Horizontal SHX milestone implemented: bounded native shape/unifont decoder, explicit Windows SHXFONT/SHXLOAD picker, per-session resources, native TEXT ink/space/fitting/descent rules and shared Canvas/raster/eligible vector paths. Native/actual app proof passes 1,477 checks plus the final rebuilt save/default/backup/reopen gate. Unsupported glyphs/modes retain substitutes. BigFont, vertical/mirrored text, fractional arcs and complex-linetype glyph painting remain open. See `SHX-FONTS.md`. | Independent; no proprietary font bytes committed. DWG exposure/reference dependencies remain #19. | Retain native fixture, metrics/plot/real IPC/undo/save/reopen proof; extend each encoding/mode and linetype placement with native fixtures. |
| 22 | Partial: table cells edited in JCad, export is INSERT + `JCAD_TABLE` XDATA. | Native table model/export; #19 for omitted DWG cells. | Native editable ACAD_TABLE reopened externally and in JCad, styles/cell values retained. |
| 23 | Partial: electrical attributes, WD_M settings and project metadata exist; remaining proprietary extensions require fixture-based audit. | Electrical audit; application dictionaries #29. | Real AutoCAD Electrical cases preserve exposed tags/catalog/connectivity/settings; report unmodeled metadata. |
| 24 | Current milestone implemented: native admissions, Unicode grants, byte-digest and completed-open lineage protection, stored leaf preservation, guarded backups and bounded whole-project preparation. Text/PDF exports share order/source guards; PDF resources and direct CSV report inputs are captured before awaits, stale/retired output refuses, cancellation joins cleanup and exports preserve dirty/history/recovery. Detached report proofs release, and unverified replacements warn explicitly. A final-gate native plugin collision was repaired with bounded fresh-byte verification; source-read policy is unchanged. Native/app regression evidence is recorded below. The final suite and all four exact-final-head CI jobs passed at 739950c before source integration began. Provider/UNC/case-sensitive fixtures and Node's final OS race remain limitations. See `WINDOWS-SAVE-ADMISSIONS.md`. | Lead/reliability; host-owned orders, native identity and bytes. Completed helper hunk credited to PR #9; completed reader/metadata integration is separate. | Frozen milestone; retain every save/export/read regression and original limit/deadline through each combined integration gate. Externally unavailable provider fixtures remain explicit requirements rather than a universal race-free claim. |
| 25 | Plugin read races/Unicode escapes and lifecycle revocation implemented: bounded descriptors, stale-load/reload ownership, scoped prompt/dialog/picker cleanup and nested transaction rollback. API v1 remains full-trust page code; capability isolation is missing. See `PLUGIN-SOURCE-READS.md`. | Independent source/lifecycle fixes; separate realm/RPC compatibility architecture for full isolation. | Retain real file-read and unload/reload regressions, then enforce declared caps outside plugin globals with actual denied operations and explicit migration. |
| 28 | Missing specialized entities and PDF/DGN/DWF underlays; unsupported records reported (`SUPPORT-MATRIX.md`). | Independent per-entity milestones; parsers/licensing required for underlays. | Preserve source/reference metadata; fixture import/edit/save/reopen and visible unsupported feedback. |
| 29 | **Completed externally in PR #9/v0.4.9; integration only.** Bounded metadata/object-reference preservation is already implemented. The completed graph/codecs are now being combined with current compatibility and save guards; combined native equivalence remains required. | Same completed external work as #19; lead owns compatibility integration, not duplicate implementation. | Reuse the completed graph and verify metadata equivalence, ownership and real-file edit/save/reopen on the combined branch. |
| 30 | Missing dynamic-block actions/parameters and constraints; static INSERT representation exists. | #29 reference graph prerequisite. | Native actions/parameters/constraints retained, safe supported edits, explicit unsupported cases. |
| 31 | Missing sheet sets, data links and drawing digital signatures. Drawing signatures differ from installer signing. | Formats/reference graph/licensed validation prerequisites. | Real sheet/data-link fixtures; signature validity and explicit invalidation on edits, no false signing claim. |
| 32 | **Planned 3D milestones 0–7 completed externally; experimental and unreleased.** Verified published branch `feature/3d-development` at a4d5526 and all four exact-commit CI jobs. AutoCAD 2027 Core Console records zero-error mesh/dimension round trips; development and packaged-archive kernel security checks passed. Final unsigned executable launch is blocked by Windows Application Control. Known 3D format/display/tool limits remain documented by that workstream. | Separate 3D workstream; [plan/status](https://github.com/habit04/share/blob/feature/3d-development/docs/3D-PLAN.md), [CI](https://github.com/habit04/share/actions/runs/38356844755). No 3D implementation or integration in this 2D branch. | Read-only verification completed 2026-10-13. Distinguish delivered development milestones from installed/released production support; do not duplicate or alter that work. |

Completed baseline priorities 1–6, 8 and portable Windows DWG saving #27 remain regression
coverage, not rebuild work. #7 was superseded by portable saving. #26 (Mac/Linux updates) and
#32 (full 3D) implementation remain outside this branch; its delivered external milestones are
recorded above. Unsupported requirements above are still open; a dependency is not
proof that their implementation or external verification has passed.

## Current validation and integration

- Combined #9 + #24 source: **3,943 tests / 28 conditional skips**, all three TypeScript
  projects, broad lint, fixtures and production build pass. **32 actual Windows source-Electron
  workflows** pass together: 14 opened-source/save/recovery, seven tracked 2D import/edit/save/
  reopen and 11 PDF/CSV export workflows. All private app processes close; production bundle,
  source/native/config/harness hashes remain unchanged through the app run. Independent native
  ATTRIB handle uniqueness and exact reopened identity checks supplement every previous text
  comparison. The latest full suite, fresh static/build and all 32 app workflows cover the
  checked legacy TABLESTYLE repair below. Original deadlines and guards remain.
  Three existing native metadata fixture families pass the adopted decoder/projection validators
  with zero native/write errors and complete bounded inventories. This reuses completed #9
  native assets; it does not certify a locally rebuilt writer, new installer or AutoCAD roundtrip.
  [Current PR checks](https://github.com/habit04/share/pull/11/checks) must pass on the exact
  published combination before the 3D stage. Parent CI and local decoder evidence do not
  replace that matching-helper/Windows gate.
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
  and mutation/refusal cases are added but were not compiled locally. Matching changed-helper
  compilation and C postflight remain required in fresh CI; an original DWG with implicit margins
  cannot certify its DXFOUT's explicit-margin conversion. Development helper/source/notices/
  integrity artifacts support private reproduction; no installer/signing workflow was changed.
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
- CTB/STB passed **1,823 native/actual checks**; TrueType PDF embedding passed **1,496**.
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
