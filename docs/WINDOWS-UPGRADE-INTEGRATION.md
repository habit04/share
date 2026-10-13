# Windows JCad upgrade: verified work and integration plan

Read-only GitHub/history audit: 2026-10-13, 14:43 UTC. This is a planning record;
no stable-branch merge, installer, signing change or release was performed.

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
| [11](https://github.com/habit04/share/pull/11) | Windows 2D compatibility, fonts/plots, plugin lifecycle and save/recovery corrections. | This branch, 00a850a: 3,544 local Windows tests/28 skips, build/static and 21 rebuilt app checks pass. Current CI exposed Ubuntu Windows-simulation and Windows E2E harness failures; correction and clean CI are required before integration. Remaining roadmap rows are still partial. |
| [12](https://github.com/habit04/share/pull/12) | Pinned first 2D batch plus GPU foundations, Intel/NVIDIA native cache recovery and adapter selection. | Delivered draft milestone at b145ea39; all five latest CI jobs pass. Pins only old 2D 3ce7e10a, not current #11 or released #9. |
| [13](https://github.com/habit04/share/pull/13) | Bounded zoom reuse with fixed pixel lineweights and separately measured frame stages. | Delivered draft at 734de794; measured renderer fd7fac07. Both producer/evidence CI records pass. Unmerged/unreleased. |
| [14](https://github.com/habit04/share/pull/14) | Eligible LINE edit/undo caching and 168-byte subrange uploads, with failure repair. | Delivered draft at 6e00136f; measured renderer fe653933. Latest five CI jobs pass. Arbitrary edits remain separate. |
| [15](https://github.com/habit04/share/pull/15) | Faster full preparation for visible LINE scenes at cache boundaries. | Delivered draft at 47625347; measured renderer 72d70630. Latest five CI jobs pass. First-frame/boundary costs and broader coverage remain. |

Stacked PRs contain shared commits; do not add their test counts or feature scopes
as independent implementations. An open PR's computed merge SHA is not a merge.

Follow-up to the #11 audit: the harness correction retains all original assertions,
uses explicitly scoped POSIX protocol doubles instead of treating POSIX paths as
native Windows paths, and adds protected-source backup/refusal checks. Local full
suite now passes 3,546/28 skips; nine additional actual Windows checks and all static
checks pass. No product guard or timeout changed. Corrected-head full CI is still
required; the general local E2E driver needs a matching native helper, absent here.

## Delivered work without its own PR

| Workstream | Verified published source | Status |
| --- | --- | --- |
| GPU diagnostics | [16abc740](https://github.com/habit04/share/blob/16abc740da729abf458996fc2bf0b65c498794f9/docs/GPU-DIAGNOSTICS.md) | Implemented/tested About/report/clipboard and bounded hardware/activity data. Included in the later GPU stack, absent from v0.4.9. |
| Experimental renderer/demo | [2fbae728](https://github.com/habit04/share/blob/2fbae7288bd110bfba7b9799280d66ccb2856774/docs/GPU-RENDERER-PROTOTYPE.md) | Implemented/tested development WebGL2 geometry, complete Canvas fallback and isolated mesh/camera/picking demo. Its demo is separate from document 3D modelling. Included in the GPU stack, absent from v0.4.9. |
| Planned 3D milestones 0–7 | [a4d55263](https://github.com/habit04/share/blob/a4d5526380c844a93821fd7d61317856c715e5cb/docs/3D-PLAN.md) | Delivered experimental document/model/viewport/editing/kernel/persistence/DIM3D work. [Four exact-commit CI jobs pass](https://github.com/habit04/share/actions/runs/38356844755). Native AutoCAD mesh/dimension roundtrip and packaged-archive security checks pass. Final unsigned executable launch is blocked by Windows Application Control; installed/signed release and documented format/tool limits remain unverified. Not merged/released. |

## Integration order after #24

1. Finish the #24 CI corrections, freeze this branch and confirm all required checks.
   Preserve the original file/backup/recovery assertions; do not weaken source-proof
   guards or raise tolerances/timeouts to make the harness pass.
2. Use released v0.4.9 / 8dfe1caa as the candidate's stable foundation. Integrate the
   completed #11 corrections deliberately with #9's graph-aware codecs, transactions
   and matching native assets. Current #11 is based on v0.4.8 and has shared-file
   conflicts; neither side's changes can be accepted wholesale.
3. Integrate delivered document 3D source a4d55263, retaining its default-off flag,
   kernel controls, bounded persistence and refusal of unsupported DWG output.
   Review shared document/state validation, undo, commands, DXF codecs, autosave,
   worker/CSP handling and dependency/license changes against the combined branch.
4. Integrate the GPU stack as one reviewed dependency chain, preferably from the
   latest verified leaf (#15 plus any subsequently completed reviewed milestone).
   It already carries diagnostics/prototype and #10/#12–14. Do not independently
   reapply its obsolete pinned 2D batch over current #11. Preserve complete Canvas
   fallback and ordinary Canvas default; do not claim complete production coverage.
5. Freeze one combined source. Run the combined checks below and prepare an explicit
   feature/limitation report for review. Version naming and public rollout follow
   that result; a substantial upgrade does not itself establish production readiness.

No new worktree/branch or dependency was created for this plan. Actual combined
integration, stable merges, packaging and release are later actions, not performed
by the read-only history audit.

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
- Keep remaining limits visible: GPU blocks/text acceptance, dimensions/hatches and
  other coverage, AMD/remote/other drivers and persistent failures; 3D DWG/ACIS,
  plotting/grips/advanced modelling limits; outstanding 2D checklist rows. These
  are not silently closed by merging tested development milestones.

GPU measurements cover two adapters on one Windows host. Dense differences around
3.3% pixelmatch are documented, fallback checks are stricter, and timing describes
completed workflows rather than pure GPU execution/presentation. Claims of universal
speed or full AutoCAD parity would exceed the current evidence.
