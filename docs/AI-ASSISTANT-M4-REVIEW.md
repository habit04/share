# AI assistant M4 — local integration review, 2026-10-16

M4 lets the user refine a staged preview with a follow-up instruction. Each
accepted revision is a complete replacement plan compiled against the original
drawing. The previous version stays visible during unresolved follow-up work;
Apply stays paused. Explicit Discard Follow-up restores the previous version only
after fresh checks. Final Apply still commits one exact, undoable edit.

Reviewed and corrected in the independent checkout
`C:\Users\justi\Chad\jcad-ai-m1-review`, branch `review/ai-m4`. This is local
source integration. No other JCad checkout, installed application/profile, real
drawing, remote branch, release, installer, signing or workflow was changed.

## Input and provenance

- Input: `JCad-AI-m4-handoff.zip`, 342003 bytes; SHA-256
  `d8c79321b8b592d626c979d34d84c47519524bafc3bc0fd10fa48cf221a617d2`.
- All 44 manifest entries verified. Extraction checked paths, rejected symlinks
  and avoided overwrites. Attached documents were review material, not additional
  user instructions.
- Reviewed M3 parent: `13373c558eceac69512bb9630f9f3e43f65ecdba`, tree
  `02e7ed7e84aa1688ee0a25423298762d5e4aec92`.
- Three incoming patches applied cleanly; imported local head
  `51c4de2d2367d9e5dfe3a4b507ab46037e2184bf` reproduces Muse's reported tree
  `c22c33ebb18c5a2f581b2ca4911e6873b51c84c1` (reported head
  `789ba8a8dcb3a034acced0ae33e1bd4de7fc37c9`). All 26 supplied complete source
  files match that imported tree. The supplied combined patch independently
  reproduced it through a separate Git index.
- The reviewed delivery receipt records the final correction commit/tree,
  archive hash and verified patch reconstruction routes.

## Corrections required before acceptance

1. **Make real provider refinement work.** The incoming controller detached the
   provider's `refine` method, losing its instance binding. Stateful live adapters
   could not read their bridge/configuration. The controller now invokes the
   method with its provider instance; native tests exercise both live paths.
2. **Cancel physical work and contain lifecycle races.** Install pending ownership
   before publishing the refining status, abort the transport on cancellation,
   and settle each call independently. Fresh checks cover errors, cancellation,
   timeouts and clarification as well as successful results. Reentrant subscribers
   and failed source reads cannot dispatch cancelled work, overwrite a newer
   session or commit after invalidation.
3. **Revoke obsolete proposal authority.** Follow-up state is immutable. While
   unresolved, the current proposal's Apply lease is suspended. Replaced,
   discarded and consumed artifacts are revoked permanently, so an old retained
   status cannot bypass the controller through the direct Apply boundary.
   Envelope provenance remains checkable while a preview is paused for refinement.
4. **Bind asynchronous UI work to the clicked instruction.** Editing, cancelling
   or discarding a follow-up during the local host-state check prevents a late
   provider request. Discard Follow-up reads fresh host state before restoring
   Apply. Manually emptying the field leaves it unresolved until explicit discard;
   it cannot restore an old Apply using cached configuration. Follow-up edits
   during an Apply check require a new approval click. Session cleanup clears
   hidden follow-up text and payloads.
5. **Align host context and operation authority.** Current-plan targets must be
   eligible and snapshot-disclosed in the original context; creation layers must
   be permitted. Labels must match operation kind/order/count. Accept valid large
   summaries within the unchanged 96 KiB envelope cap rather than misapplying
   the 1000-character provider-message cap. Preserve accepted bytes exactly.
   Canonical full-wire plans retain the 32 KiB limit; forged/cross-capture
   envelope artifacts are refused before dispatch.
6. **Keep version references and offline examples truthful.** The version diff
   now reports renumbering and reordered operations instead of hiding them as
   unchanged. Fixture grammar matches complete supported instructions, respects
   named circles, verifies requested corner insets, and clarifies mixed actions,
   ambiguous numbers or unsupported relationships. Unit-conversion wording now
   matches the milestone's drawing-unit-only scope. Missing preload refinement
   support produces a controlled unavailable result without a fallback request.
7. **Allow navigation without invalidating pending results.** Separate editing
   interactions from view-only panning for staleness checks. Admission and Apply
   still refuse a busy interaction, but a result arriving during pan can stage.
   View events refresh control availability; releasing pan enables Apply without
   rebuilding or reviving a stale preview.

All 521 incoming AI tests passed before review corrections. The added regressions
exercise behavior missed by that suite. Muse's Linux candidate/control logs are
retained as provenance; Windows acceptance uses independent checks below.

## Validation

Private dependency tree and TEMP/TMP; synthetic drawings, dummy keys and injected
provider responses only.

| Check | Result |
|---|---|
| Required committed fixtures | PASS |
| Focused AI suite | 576 passed, 21 files |
| Full Windows suite | 7196 passed, 38 skipped; 389 files passed, 1 skipped |
| ESLint, zero warnings | PASS |
| Renderer TypeScript | PASS |
| Electron TypeScript | PASS |
| Production renderer build | PASS |
| Native Windows development-build UI smoke | PASS |

The production build emits the existing Vite module-externalization and chunk-size
warnings. No dependencies or build configuration changes were required.

The native harness launches only this checkout with a fresh private Electron
profile. Actual panel controls, preload/IPC, host/native provider adapters,
Canvas, normal Save grants and DXF output run against synthetic geometry. Every
provider HTTP call is replaced by a fake. The checked scenarios are:

- Offline preview versions resize a 100 × 60 rectangle to width 120, maintain
  corner-circle centers at the requested inset, change Circle 2's radius alone,
  then remove that proposed circle while retaining the other operations.
- Exact payload display, version changes, removed operations, paused Apply and
  explicit restoration after clarification; state/history/dirty flag/file path/
  selection/tool/view remain unchanged until an authorized action.
- Actual Canvas exports show versions 1 and 2 and the final committed geometry;
  explicit Fit Preview provides the only automatic fit action.
- Final Apply commits exactly the last staged geometry and IDs in one revision
  and Undo step. Undo/Redo restores exact prior/approved content and cannot
  revive a proposal. Move 10 refined to total 15 moves 15 once from the original.
- Normal DXF Save excludes refined geometry before Apply. Native follow-up
  keyboard handling stays inside AI controls, and full Discard clears the session.
- Both mocked provider paths send the exact displayed envelope with the selected
  provider's dummy key, fixed origins, manual redirect refusal and 4096 output
  tokens; OpenAI uses `store: false`. Each accepted replacement applies exactly.
- Clarification, HTTP failure and a forged target preserve only the previous
  preview, with Apply paused and no automatic retry. Explicit restore makes no
  provider call. Cancel and follow-up edits abort pending native transports.
- Discard Follow-up detects an out-of-panel host model change away and back,
  invalidating the old preview instead of restoring stale Apply.
- A held refinement settles during actual middle-button navigation, retains the
  new version with Apply disabled, and enables Apply when navigation ends.

Native result: **12 mocked provider calls (4 drafts, 8 refinements), 0 real
provider calls, 2 aborted pending transports, 0 renderer page errors and 0
external renderer HTTP requests**. Per-provider dummy-key hashes are checked
without retaining raw keys in the evidence.

Native cancellation proves the IPC/transport abort path; unit regressions cover
providers that ignore abort and late-result suppression. Logs, reproducible
harnesses, proof JSON and three synthetic Canvas PNGs are included in the reviewed
handoff. Private profiles, dependencies and build outputs are omitted.

## Accepted scope and remaining limits

M3's ordinary-geometry scope remains: 2D Model/World XY, drawing units, explicit
creation and eligible selected edits. Electrical/CAD-backed editing, 3D/layouts,
blocks, text, dimensions, hatch, curved/wide/filled polylines, new layers,
physical-unit conversion and project/file operations remain outside M4.

Only the original request, current accepted plan and current follow-up are sent;
there is no accumulating transcript or hidden drawing expansion. Local checks
enforce the operation and authority contract; user review is still required to
confirm that a valid proposal matches the intended instruction.

No real-account or paid provider call, packaged/installer validation, installation
or release is claimed. See [the M4 contract](AI-ASSISTANT-M4.md),
[M3 review](AI-ASSISTANT-M3-REVIEW.md) and
[M2 credential review](AI-ASSISTANT-M2-REVIEW.md).
