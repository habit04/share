# Windows JCad upgrade: verified work and integration plan

Read-only GitHub/history audit: 2026-10-13, 14:43 UTC. This is a planning record;
no stable-branch merge, installer, signing change or release was performed.

Execution update: #24 is frozen at `739950c576ea48f9de7666dfa964732db896d6d4`.
All four [exact-head CI jobs](https://github.com/habit04/share/actions/runs/38434090041)
passed, including native Windows writer/containment, Electron, origin migration,
both Node suites, UI screenshots and performance gates. The long roadmap is paused.
The first source integration stage combines completed #9 with this freeze in the
same isolated worktree. The previous session-basis/common-link head's full local suite passes
**3,954 tests / 28 conditional skips**, all three TypeScript projects, broad lint,
fixtures and the production build. All **32 actual Windows app workflows** pass
on the new unchanged production bundle:
14 opened-source/save/recovery, seven tracked 2D and 11 PDF/CSV export checks. Full
source/native/config/harness hashes remain fixed during that run and all owned
processes close without fallback termination. The [exact-head PR checks](https://github.com/habit04/share/pull/11/checks)
must clear before adopting 3D or selecting a corrected, published GPU stack.
No release-branch merge is authorized.

The first combined CI at `e477954` failed on the unchanged 15-second 512-drawing
Node 22 test, a legacy-to-modern TABLESTYLE preservation refusal and a stale site
report assertion. Recovery failed because the preceding export abort skipped its
fixture setup. The candidate now bounds CI workers to two without changing the
deadline, preserves every native export/recovery assertion, and checks exact browser
dimension kinds/dropped handles plus per-type history rows. All 28 site checks and
48 authoritative Ubuntu screenshot comparisons pass with unchanged image tolerances.
Only corrected warning text changed in the reviewed screenshot.

At `208bede7`, Node 24 and UI passed; Node 22 exceeded the unchanged 15-second
512-drawing deadline, and native Rust passed 51/53 with two common-link differences.
The project repair captures sessions once per synchronous basis scan rather than
once per sheet, with fresh scans around every awaited read/write. Four added regressions
cover capture cost, Unicode paths, project replacement during synchronization and a
closed source opened through a native alias. All 163 targeted tests pass; the original
512 case took 7.7 seconds in targeted tests and 8.4 seconds in the complete local suite.
Transport in those tests is explicitly doubled;
fresh Node 22 CI and actual Windows workflows remain required.

The native repair checks all three source rows against retained CELLSTYLEMAP formats
and exact links, colors, borders and margins. Unsupported inactive values explicitly
refuse. All 239 targeted checks, including 36 new cases, pass; strict typed snapshots
and independent C postflight are unchanged. The added Rust binary/mutation cases are
compiled in Windows CI: `eb692896` clears both Node jobs and UI, while 50/51 native tests pass.
The genuine binary case detects deleted imported TABLESTYLE compatibility dictionary entries.
The authenticated writer patch retains those entries and children for explicit DXF or native
DWG input; original cleanup applies only to generated styles without either source provenance.
The later common-link failure exposed missing DataObject accessor arms: parsed reactors
and extension dictionaries were observable only after the native reader filled side caches.
The authenticated patch exposes the typed fields directly, preserving existing fallback
and null handling. All 246 targeted checks pass. Direct-field and mutation regressions
retain the strict comparison; all 54 native cases require fresh Windows compilation.
Corrected native tests, Windows application checks and independent C postflight must pass in
fresh exact-head validation before integration proceeds. The original AutoCAD body's implicit
margins cannot certify explicit DXFOUT margins or
converted common links. CI retains only the development helper, corresponding source,
notices and integrity manifest for private reproduction; release/signing workflows
remain unchanged. No next-stage source or actual ancestry merge proceeds before this gate.

Exact `e18012cd` CI passes both Node jobs and UI. Windows compiles/runs all 54 native
Rust and three CLI tests, including the imported TABLESTYLE fixes; Electron then
safely refuses a VPORT group421 representation difference, leaving the destination
unchanged. Its later recovery failure follows the aborted export setup. Read-only
decoding of the unchanged original AutoCAD DWG reproduces the same difference from
its matching DXF: identical RGB bytes, with a native C2 color-method byte.
The correction is confined to checked VPORT ambient-color semantics, retaining exact
RGB/count/ACI/name/unknown-field comparisons and rejecting unsupported methods.
Fresh exact-head/application/native postflight validation remains required.

Node 22's original 512 case passes in 14,886 ms against 15,000 ms. This narrow margin
remains a reliability concern. A measured CPU profile identifies repeated path
normalization; a bounded comparator for each synchronous scan is under review.
Native aliases and platform interpretation must stay fresh on every comparison,
and overflow must use unchanged uncached behavior. No deadline or guard is relaxed.

The related VISUALSTYLE audit proves only eight typed RGB slots in the complete modern
58-property grammar. Checked method0/C2 storage compares every RGB bit; its palette ACI
companion represents the same single native color property and is derived by the C reader.
Standalone ACI, operations, count/order, common links, XDATA and opaque data remain exact.
Lighting177 is **not** normalized: the writer preserves explicit source3, while original
DWG2 is an unrelated default. Legacy/raw records retain their previous comparisons.
All 318 focused backend checks, including 88 new style cases, pass. The 173 path/project
checks pass, with the unchanged 512 case at 6.7 seconds locally. Independent counterexamples
and source review pass; fresh full/app/exact-head CI and matching-helper gates remain required.
One broader targeted run retained a native-read worker memory failure; its unchanged
31-case suite passed separately without budget, factory, heap or deadline changes.

Current color/path candidate validation: all static/build checks and all 32 Windows app
workflows pass on unchanged `index-BllnhGHC.js`; every owned app closes without fallback
termination. Two normal full runs each retain 4,097 passes, 28 skips and one unchanged
extended-PDF body/cleanup timeout. Its unchanged 34-case suite passes separately. A full
private syscall-traced run passes 4,098 with 28 skips, including the original 512-drawing
case in 5.94 seconds. This is diagnostic evidence: asynchronous tracing can perturb the
scheduler. No production deadlock is established; sparse phase tracing will preserve
native FileHandle behavior while locating the stall. The independently tested repair
commits may be published to the draft branch for fresh CI, while normal-suite clearance,
all four exact-head CI jobs and actual matching-helper/C postflight remain integration
gates. No ancestry merge or next-stage source adoption is cleared by these partial results.

The following normal uninstrumented `a44cc60` full run passes 4,098 tests/28 skips,
with unchanged original limits and source hashes: extended PDF295 ms, 512 drawings5,836 ms.
The earlier two timeouts remain retained, with cause unproven. Exact CI passes both Nodes
and UI (Node22 original512 case5,831 ms); Windows passes54 Rust +3 CLI/containment cases,
then safely refuses MATERIAL12E expansion110-to-151. The recovery-row failure is the same
aborted-export setup cascade. No failed-run native artifact is downloaded.

Complete object-payload review scopes the next correction to three verified AC1032 built-in
MATERIAL grammars and two retained style representations. Its 519 focused tests, all three
typechecks and scoped lint pass, including183 new material and32 style regressions.
Every one of41 added material defaults is checked exactly; all96 matrix components,
source flags, dictionary ownership, common/opaque/XDATA and referenced objects remain
checked. MLEADERSTYLE only normalizes proved block-null slots/independent attachment order;
MLINESTYLE must resolve both operands to the same matched LTYPE record and table control.
Malformed modern claims/known fields interleaved with unknown fields refuse. Legacy raw
comparison remains unchanged. General/VPORT/VISUALSTYLE/TABLESTYLE guards and native assets
are unchanged. New full/static/build/app/fresh CI gates remain required before integration.
The actual first/second matching-helper/C fixed point is mandatory: MATERIAL is outside
the native snapshot whitelist, and expanded DXF can populate transient advanced fields.
This is a qualified dependency, not a confirmed persisted defect or permission to waive
equivalence. The linked GPU session owns its adapter measurements; heavy local gates
are sequenced after its timed run closes.

Exact `6d2c77d` CI passes UI, while both Node jobs fail only the new CRLF-specific
fixture SHA assertion. In-memory CRLF-to-LF content equals the exact Git blob;
canonical LF hashing keeps the original raw-byte readback and all semantic assertions.
Its 215 material/style tests and independent review pass. Windows passes 54 Rust +
three CLI/containment cases and advances to TABLESTYLE159 common102 order. The literal
AutoCAD source and C serializer use XD/REACTORS, but the legacy comparison projection
creates REACTORS/XD. The TABLESTYLE-only symmetric common-prefix repair preserves
each complete adjacent block, owner, ordered mapped links and unknown carrier/body/XDATA.
Malformed, duplicate, nested or interleaved framing refuses; other object types and
the legacy projection/general value checks remain unchanged. All 557 focused tests pass,
including 38 new framing cases. Fresh combined full/build/app/CI and actual matching
compiled-helper first/second C validation are still mandatory. Failed-run artifacts
remain metadata only; no retry or next-stage source adoption is used to clear a failure.

Normal `db7203a` validation now passes 4,351 tests / 28 skips and all 32 actual
source-desktop workflows. All 918 source hashes, the built renderer and 20 native assets
remain fixed; owned processes close without fallback termination. The earlier restricted
run's 52 filesystem failures are reproduced by a confined junction/hard-link probe and
cleared in the approved native test context. Two independent timeouts remain retained
with unproven cause; the same original 33-file/PDF cases then pass in 17,772 ms/294 ms.
Exact CI passes both Node jobs/UI; Windows passes 54 Rust + three CLI/containment checks,
then refuses `$TDCREATE` shifted by five hours. The source UTC creation value agrees with
the C result; C derives local creation dates using its host timezone. This alone cannot
prove either creation-instant loss or retention of an independently stored local Aux tuple.
Four SHA-unchanged original DWGs read successfully, but the binary has no raw Aux/JSON/trace
API. Production reader/writer/pins and strict date guards remain unchanged. An authenticated,
isolated development C diagnostic must measure actual main/Aux tuples before a date repair;
matching-helper first/second C gates and all-green CI still block integration.

The isolated diagnostic passes 14 source/protocol/tooling tests and 77 workflow regressions.
Source preparation verifies 583 decoder source hashes and four original/private-copy hashes
and byte counts. Two independent source reviews pass. The feature-branch diagnostic workflow
must still compile the native GCC decoder and read both zones; these preparation checks do
not certify native date semantics or the shipped Emscripten reader.

The corrected full local Windows suite passes serially with every original deadline and
freshness assertion. A private phase trace of the 33-file project case passed in 18.7 seconds;
backup/write guards account for most elapsed time. Parallel native-filesystem contention and
the initial restricted runner's denied link fixtures remain separate failed-run evidence.

This stage resolves shared clip-boundary identities and copies, duplicate modeled
VIEWPORT 340 export, anonymous STYLE identity and complex-LTYPE overlay conflicts.
Project proposals and restored session/history states now validate graph identities,
ordinate properties and budgets before tab, proof, backup or write mutation. Existing
save/export admissions remain intact. Graph-aware native-layout test setup retains
the original layouts and all prior metadata/undo/reopen assertions. The app text
comparison excludes only newly allocated attribute identities and independently
checks their native uniqueness and exact fresh-reopen value; every prior appearance
assertion remains. The final large-file test completes and verifies its owned cleanup
inside the original body deadline, leaving the hook no duplicate filesystem cleanup.

The completed native reader bundle, matching writer source/pins and three metadata
fixture families are reused as one dependency. Decoder/projection validators report
zero native/write errors and complete bounded inventories. No matching native helper
was rebuilt locally and no new AutoCAD roundtrip, packaged artifact or installer is
claimed; current-source matching-helper/Windows execution remains an exact-head CI gate.

The first combined full suite exposed missing runtime-module coverage in the existing
builder filters. The two completed #9 metadata `.mjs` modules are now listed explicitly,
and the real-filter regression retains every prior adapter/source assertion while checking
the two additional provenance assets. This is a narrow runtime dependency addition;
application version, dependencies, signing and release workflows are unchanged. No
installer or packaged artifact was created.

There is enough delivered work to plan a substantial combined Windows upgrade.
There is not yet a validated combined release candidate. Keep ordinary Canvas as
the default and preserve the existing experimental controls for GPU and 3D.

## Full PR history

All 14 PRs currently returned by `habit04/share` were inspected: complete paginated
bodies, commits, reviews, issue/review comments, timelines, changed-file lists and
current-head checks/action records. None of the heads changed during collection.
There were no submitted GitHub reviews or comments; independent-agent review
claims in descriptions are separate evidence. Historical prose saying a PR is
still open does not override its current merge status. Raw logs of every historical
workflow were not rerun or revalidated; relevant failing current jobs are inspected
separately. Private source records remain in the worktree's `.codex-local` audit.

| PR | Delivered scope | Current status / evidence |
| --- | --- | --- |
| [2](https://github.com/habit04/share/pull/2) | Electrical file/recovery safety, CAD compatibility, budgets, secure IPC/preferences, updater and release verification. | Merged; current-head CI/build-only checks pass. Already baseline work. |
| [3](https://github.com/habit04/share/pull/3) | Native text justification, MTEXT masks, polyline widths, appearance and MINSERT arrays; matching reader repairs. | Merged, v0.4.4 lineage; current-head CI/build-only checks pass. Do not rebuild these features. |
| [4](https://github.com/habit04/share/pull/4) | Disposable DWG utility/parser processes, memory/work limits, transfer budgets and restart/preference reliability. | Merged, v0.4.5 lineage; current-head CI/build-only checks pass. Sampling limits remain documented. |
| [5](https://github.com/habit04/share/pull/5) | Portable Windows DWG copy export, verified native writer, integrity and Windows release gates. | Merged, v0.4.6 lineage; includes #6. Final feature-head CI contains canceled jobs, not an all-green final run; subsequent merged/released validation is separate. |
| [6](https://github.com/habit04/share/pull/6) | Matching DWG appearance/array/attribute reader and packaged-adapter repairs. | Merged into #5; canceled final feature-head jobs have the same qualification. Verified native/build and release records remain in its history. |
| [7](https://github.com/habit04/share/pull/7) | Normal Windows DWG Save/Save As, working-file binding, backup and loss consent. | Merged/released v0.4.7; current-head CI passes. Priority #27 is completed. |
| [8](https://github.com/habit04/share/pull/8) | Rotated rectangular layout viewports in display, editing and plotting. | Merged/released v0.4.8; current-head CI passes. Polygon/curved clips are separate scope. |
| [9](https://github.com/habit04/share/pull/9) | Named views, FIELD links, bounded CAD metadata/reference graph and independently verified native save preservation. | Merged/released v0.4.9, stable 8dfe1caa; final-head and publication checks pass. Priorities #19/#29 are completed externally. Reuse this work. |
| [10](https://github.com/habit04/share/pull/10) | Immutable pan cache, graphics-loss recovery and complete Canvas fallback. | Delivered draft milestone at a0eea698; latest push/PR CI passes all five jobs. Unmerged/unreleased. |
| [11](https://github.com/habit04/share/pull/11) | Windows 2D compatibility, fonts/plots, plugin lifecycle and save/recovery corrections; completed #9 source integration. | Frozen #24 at 739950c: [all four exact-head CI jobs pass](https://github.com/habit04/share/actions/runs/38434090041). Combined #9 + #24 local validation: 3,954 tests/28 skips, static/build and 32 actual Windows workflows pass with the scoped CI repairs. [Combined exact-head checks](https://github.com/habit04/share/pull/11/checks), changed native helper and C postflight are required before the next stage. Roadmap rows remain paused and partial. |
| [12](https://github.com/habit04/share/pull/12) | Pinned first 2D batch plus GPU foundations, Intel/NVIDIA native cache recovery and adapter selection. | Delivered draft milestone at b145ea39; all five latest CI jobs pass. Pins only old 2D 3ce7e10a, not current #11 or released #9. |
| [13](https://github.com/habit04/share/pull/13) | Bounded zoom reuse with fixed pixel lineweights and separately measured frame stages. | Delivered draft at 734de794; measured renderer fd7fac07. Both producer/evidence CI records pass. Unmerged/unreleased. |
| [14](https://github.com/habit04/share/pull/14) | Eligible LINE edit/undo caching and 168-byte subrange uploads, with failure repair. | Delivered draft at 6e00136f; measured renderer fe653933. Latest five CI jobs pass. Arbitrary edits remain separate. |
| [15](https://github.com/habit04/share/pull/15) | Faster full preparation for visible LINE scenes at cache boundaries. | Delivered draft at 47625347; measured renderer 72d70630. Latest five CI jobs pass. First-frame/boundary costs and broader coverage remain. |
| [16](https://github.com/habit04/share/pull/16) | Experimental blocks and stroke TEXT/ATTRIB, precision checks and retry refinements. | New draft at a2eac656, explicitly blocked. Native Intel checks found a missing open-bulge connector, an extra tiny-polyline Float32 spur, failed dense edit visibility and a 172 ms zoom boundary. Corrective source is unpublished; ordinary green CI cannot close these native gates. Do not select this head for integration. |

Stacked PRs contain shared commits; do not add their test counts or feature scopes
as independent implementations. An open PR's computed merge SHA is not a merge.

GPU source selection remains blocked until a completed corrective head passes the
unchanged native accuracy, visible-edit and responsiveness gates. An older green
stack head is not a waiver for a known inherited defect. PR #16's full paginated
commit/file/review/comment/timeline record is saved privately alongside the earlier
14-PR audit; its explicit blocked status is preserved here.

The separate GPU owner is also investigating fractional-DPR Canvas cache behavior,
paint-width budget accounting and resource contention in unchanged clip-compatibility
CI tests. Those are unpublished corrections and pending validation, not adopted fixes.
Retain the original clip assertions/deadlines and require ordinary Canvas image parity
as well as the corrected GPU's native evidence before selecting its published head.

Follow-up to the #11 audit: the harness correction retains all original assertions,
uses explicitly scoped POSIX protocol doubles instead of treating POSIX paths as
native Windows paths, and adds protected-source backup/refusal checks. Local full
suite now passes 3,546/28 skips; nine additional actual Windows checks and all static
checks pass. No product guard or timeout changed. Corrected-head full CI at
26c9dac passes all four jobs, including full Windows Electron E2E. The general
local E2E driver needs a matching native helper, absent here. These results do
not cover subsequent export changes.

The final #24 batch has now passed its local gates, including shared text/PDF order,
captured CSV inputs, released detached read proofs and explicit unverified-replacement
messages. A native final-gate plugin race was fixed with bounded same-FD byte verification;
the old reader accepted 25/64 changed-file trials, while the fixed reader refuses 64/64,
including 38 genuine metadata collisions. No original deadline/guard was relaxed. The
whole suite passes 3,663/28 skips. Actual export/save/2D and plugin IPC evidence is recorded
as separate immutable source runs. Final publication 739950c subsequently cleared all
four exact-head CI jobs before the first #9 source adoption began.

A fresh read-only head check confirms the 14-PR inventory, published 3D a4d55263 and
GPU #15 47625347 remain unchanged. The sharper GPU join limitation below has no new
published corrective head at this check; unfinished isolated fixes are not adopted.

## Delivered work without its own PR

| Workstream | Verified published source | Status |
| --- | --- | --- |
| GPU diagnostics | [16abc740](https://github.com/habit04/share/blob/16abc740da729abf458996fc2bf0b65c498794f9/docs/GPU-DIAGNOSTICS.md) | Implemented/tested About/report/clipboard and bounded hardware/activity data. Included in the later GPU stack, absent from v0.4.9. |
| Experimental renderer/demo | [2fbae728](https://github.com/habit04/share/blob/2fbae7288bd110bfba7b9799280d66ccb2856774/docs/GPU-RENDERER-PROTOTYPE.md) | Implemented/tested development WebGL2 geometry, complete Canvas fallback and isolated mesh/camera/picking demo. Its demo is separate from document 3D modelling. Included in the GPU stack, absent from v0.4.9. |
| Planned 3D milestones 0–7 | [a4d55263](https://github.com/habit04/share/blob/a4d5526380c844a93821fd7d61317856c715e5cb/docs/3D-PLAN.md) | Delivered experimental document/model/viewport/editing/kernel/persistence/DIM3D work. [Four exact-commit CI jobs pass](https://github.com/habit04/share/actions/runs/38356844755). Native AutoCAD mesh/dimension roundtrip and packaged-archive security checks pass. Final unsigned executable launch is blocked by Windows Application Control; installed/signed release and documented format/tool limits remain unverified. Not merged/released. |

## Integration order after #24

The user has paused the long 2D roadmap. Finish only the current #24 milestone
before beginning the integration sequence; no further font, hatch, xref or other
roadmap implementation is part of this freeze.

1. Finish #24's confirmed text/PDF export gaps: capture host order before native
   pickers and slow font/image/PDF work; use the same ordering and opened-source
   protections as drawing saves; join cancellation/conversion/writer cleanup.
   Include the exposed plugin-read timestamp collision repair: fresh same-FD raw
   bytes with bounded scratch, preserving size/confinement/trust policy. This is
   read reliability; capability isolation stays paused with the long roadmap.
   Preserve existing text/project behavior and the 512 MiB PDF ceiling without
   increasing ordinary drawing limits or marking plotted drawings clean.
   Add native-file regressions and rebuilt application checks, then run the full
   suite, three TypeScript projects, lint, fixtures and production build. Commit
   and freeze this batch, and require all checks green on its exact final SHA.
   Preserve original file/backup/recovery assertions; do not weaken guards or
   raise tolerances/timeouts. Do not start integration while checks are pending
   or failing. Provider/UNC/case-sensitive fixtures and Node's final OS race remain
   explicit limitations, rather than claims that all filesystem races are solved.
2. Use released v0.4.9 / 8dfe1caa as the candidate's stable foundation. Integrate the
   completed #11 corrections deliberately with #9's graph-aware codecs, transactions
   and matching native assets. Current #11 is based on v0.4.8 and has shared-file
   conflicts; neither side's changes can be accepted wholesale.
   Reuse completed source/native dependencies as coherent units, including graph
   transaction reconciliation and matching reader/writer provenance. Resolve the
   demonstrated LTYPE/anonymous STYLE and prepared-project/viewport conflicts.
   Retain the final #24 CSV/PDF/read lifecycle and guards. No release-branch merge,
   installer, signing or new release-workflow changes are part of this development
   integration. Keep each combined milestone independently validated before the next.
3. Integrate delivered document 3D source a4d55263, retaining its default-off flag,
   kernel controls, bounded persistence and refusal of unsupported DWG output.
   Review shared document/state validation, undo, commands, DXF codecs, autosave,
   worker/CSP handling and dependency/license changes against the combined branch.
   Include model3d solids and DIM3D in graph carrier/identity/owner reconciliation;
   do not emit duplicate retained POLYLINE/DIMENSION records. Validate shared IDs,
   dimensions-only DXF reopen budgets, strict native dimension flags and mixed
   hard-reference refusal/copy/delete/undo. Keep the declared 3D stroke-font behavior
   explicit; 2D native font providers do not automatically certify 3D text parity.
4. Integrate the GPU stack as one reviewed dependency chain, preferably from the
   latest verified leaf (#15 plus any subsequently completed reviewed milestone).
   It already carries diagnostics/prototype and #10/#12–14. Do not independently
   reapply its obsolete pinned 2D batch over current #11. Preserve complete Canvas
   fallback and ordinary Canvas default; do not claim complete production coverage.
5. Freeze one combined source. Run the combined checks below and prepare an explicit
   feature/limitation report for review. Version naming and public rollout follow
   that result; a substantial upgrade does not itself establish production readiness.

No new worktree/branch or dependency was created for this plan. The read-only history
audit did not integrate source. Source adoption began only after the #24 freeze cleared
all four CI jobs; stable merges, installers, signing and publication remain excluded.

The file-history comparison already identifies shared implementation surfaces:
20 production files between #9 and current #11, 13 between delivered 3D and #11,
and 37 between the accumulated GPU PR file lists and #11. This identifies review
work, not proof that every file conflicts. The main seams are drawing validation/
history, sessions and saving, DXF annotations/entities/layouts, block transformations,
selection/viewports/plots and native IPC. GPU lists include the old pinned 2D batch;
those existing fixes must be retained once, not replayed over the newer versions.

## Combined validation gates

- Full tests, all three TypeScript projects, lint, fixtures/workflows, ordinary and
  experimental builds. Test the combined source, not only each parent's old SHA.
- Real Windows 2D import/edit/undo/redo/save/backup/recovery/fresh reopen, including
  polygons, ordinates, TEXT/MTEXT, TrueType/SHX, plots, aliases and before-bind outside
  edits. Preserve unsupported-data refusal and dirty state.
- #9 metadata/source-schema/reference equivalence through supported connected copies,
  deletes, model/blocks/layout edits, FIELDs, named views and native DWG/DXF reopen.
  Keep matching reader/writer pins, modified corresponding source and provenance.
- 3D with the flag both off and on: modelling/editing, dimensions, mesh/history DXF
  persistence, source-proof saves, recovery and unsupported DWG refusals. Repeat native
  compatibility and E-19/E-20 against the combined source. Do not weaken Windows policy
  to bypass the executable test blocker.
- GPU on both verified Intel/NVIDIA contexts: ordinary Canvas parity, supported view
  accuracy, clipping/twist/lineweights/text/font-context changes, edits/undo/recovery,
  context loss/unavailability and complete fallback. Remeasure representative pan,
  zoom, boundary, first-frame and editing workflows on the combined source.
  The GPU owner subsequently reported a positive-bulge-to-LINE join displacement
  of 0.271 physical pixels against a 0.25 target in an existing fixture. Historical
  raster/coverage CI did not detect it. Require the original fixture unchanged,
  independent mathematical accuracy checks and complete Canvas fallback for
  ineligible joins before accepting a new published GPU candidate. Block/text
  editing responsiveness is also under correction in that isolated workstream.
  Its unpublished fixes are not integration inputs; recheck published source and
  exact-head evidence before selecting the GPU leaf.
- Keep remaining limits visible: GPU blocks/text acceptance, dimensions/hatches and
  other coverage, AMD/remote/other drivers and persistent failures; 3D DWG/ACIS,
  plotting/grips/advanced modelling limits; outstanding 2D checklist rows. These
  are not silently closed by merging tested development milestones.

GPU measurements cover two adapters on one Windows host. Dense differences around
3.3% pixelmatch are documented, fallback checks are stricter, and timing describes
completed workflows rather than pure GPU execution/presentation. Claims of universal
speed or full AutoCAD parity would exceed the current evidence.
