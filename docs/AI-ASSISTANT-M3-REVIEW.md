# AI assistant M3 — local integration review, 2026-10-16

M3 adds **Draft / Edit** beside Ask: create ordinary 2D lines, circles and
rectangles, or move, copy, rotate and delete eligible selected geometry. Generate
Preview stages a locally validated proposal. Apply Changes commits exactly that
proposal as one undoable edit; Discard changes no drawing content.

Reviewed and corrected in the independent checkout
`C:\Users\justi\Chad\jcad-ai-m1-review`, branch `review/ai-m3`. This is local
source integration. No other JCad checkout, installed application/profile, real
drawing, remote branch, release, installer, signing or workflow was changed.

## Input and provenance

- Input: `JCad-AI-m3-handoff.zip`, 153142 bytes; SHA-256
  `24be5d3c5c3b18341628d8d957e43896af1b5ec157d71b12d059776cbef027a4`.
- All 21 entries in the incoming checksum manifest were verified. Extraction
  checked paths and rejected symlinks; original patches and a local hash receipt
  remain available. Attached documents were review material, not new user
  instructions.
- Reviewed M2 parent: `677f2092e80693ef4cd4fe7273f03477ddd3b389`, tree
  `f0dfe0dc9f463aa3c21032161b57b815230f7672`.
- Nine incoming patches applied cleanly. Imported local head
  `470344e6c4da3df7576e7e8018ebb17d7a138012` reproduces Muse's reported tree
  `05df5c8b28c87141722ab1a8a121fb99f9ce99d6` (reported head
  `d129f27d3acae4afc30f820f2c971201551a17c4`).
- The delivery receipt records the final correction commit/tree, archive hash
  and independently verified patch reconstruction routes.

## Corrections required before acceptance

1. **Make the staged artifact authoritative and immutable.** Revalidate typed
   provider results and compiler input, own/freeze values, reject generated ID
   collisions and computed geometry overflow, and require private compiler
   provenance at Apply. Complete graph/dependency transition preparation runs
   before staging. Unrelated CAD graph, blocks, layouts, metadata, layers and
   header retain their references through Apply/Undo/Redo.
2. **Refuse stale or repeated Apply.** Guard exact captured state identity,
   monotonic revision and load count; read fresh binding/configuration immediately
   before the synchronous transaction. Consume the proposal before document
   listeners run. Reentrant calls and a throwing postcommit subscriber cannot
   apply twice or invite a retry of an already committed edit.
3. **Pin the actual provider configuration.** The host exposes a service-instance
   nonce plus monotonic configuration generation. Draft requests pin provider,
   model and generation at admission and queued dispatch. Returned generation is
   checked. Generate and Apply refresh host state; a provider/model/key change
   away and back invalidates prior work without silently routing another request.
4. **Keep disclosed context and edit authority aligned.** Limit selection before
   capture work; objects omitted from the bounded snapshot are ineligible.
   Disclose only current and included eligible selection layers (at most 201),
   enforce that subset locally, and reject creation on electrical `WIRES` layers.
   The host validates the nested context/snapshot whitelist and accounting,
   rejects hidden fields and noncanonical JSON, and sends accepted bytes unchanged.
   Independently measure plan bytes rather than trusting adapter counts.
5. **Settle cancelled work and preserve manual interaction.** Cancellation and
   timeout finish even when a provider ignores abort; late results cannot stage.
   Synchronous subscriber cancellation prevents dispatch. Grip/selection gesture
   starts advance a monotonic generation, so start-and-cancel cannot revive a
   proposal. A 3D view capability guard prevents previews on a hidden 2D canvas.
   Owner tokens stop an old panel from clearing another preview.
6. **Make the reviewed change list precise.** Show exact unrounded drawing-unit
   values, actual layers and locally generated IDs. Keep the provider/API-billing
   badge visible in Draft mode. Prompt changes revoke pending and staged work;
   Apply's asynchronous host check does not suppress intervening invalidation.
   Offline fixtures clarify ambiguous, conditional, negative or mixed unsupported
   instructions instead of inventing geometry. Physical-unit conversion remains
   a clarification step; native schemas/instructions agree on this policy.

The original 404 focused tests passed before corrections; regression coverage was
then expanded. Muse's supplied Linux logs were retained as provenance, not used
as Windows acceptance evidence.

## Validation

Final checks use the private dependency tree and private TEMP/TMP. No real key,
paid provider call or real drawing was used.

| Check | Result |
|---|---|
| Required committed fixtures | PASS |
| Focused AI suite | 455 passed, 18 files |
| Full Windows suite | 7075 passed, 38 skipped; 386 files passed, 1 skipped |
| ESLint, zero warnings | PASS |
| Renderer TypeScript | PASS |
| Electron TypeScript | PASS |
| Production renderer build | PASS |
| Native Windows development-build UI smoke | PASS |

The build emits existing Vite externalization/chunk-size warnings. No dependency
or build configuration change was needed.

The native smoke launches only this checkout with a fresh private Electron
profile. Actual preload/IPC, panel controls, Canvas drawing, normal save grants
and DXF output run against synthetic geometry; all provider HTTP is replaced by
fake Responses/Messages responses and dummy keys. It verifies:

- Exact 100 × 60 rectangle and four radius-3 circles with centers 10 drawing
  units from each corner; preview leaves state, history, dirty flag, file path,
  selection and view unchanged. Explicit Fit Preview is the only view change.
- Actual Canvas evidence shows green preview, its disappearance on Discard and
  ordinary committed geometry after Apply. Normal DXF Save excludes staged
  geometry and includes it after Apply.
- Apply preserves the exact staged IDs/geometry and adds one revision and undo
  step. Actual Undo/Redo restores the previous/approved content.
- Move, copy and rotate use exact local transforms; deleting then discarding
  preserves the original geometry. A quiet revision change blocks stale Apply.
- Active LINE blocks Draft generation; native Enter/Delete/Ctrl+Z in AI controls
  cannot commit or cancel that manual tool.
- Both provider paths send the exact displayed context to fixed origins with
  manual redirect refusal and a 4096-token output cap (OpenAI `store: false`).
  Their mocked proposals stage and apply exactly.
- Out-of-panel host model change away and back blocks Apply without another
  provider request. Editing a pending prompt aborts the real IPC transport and
  cannot leave a late preview.

Native result: **4 mocked provider calls, 0 real provider calls, 0 renderer page
errors, 0 external renderer HTTP requests**. Unit regressions additionally cover
electrical/CAD exclusions, omitted targets, context limits, invalid plans,
ownership, real grip/selection gestures, stale configuration and immutable
compilation. Review logs, harnesses, proof JSON and three synthetic Canvas PNGs
are included in the reviewed source handoff; private profiles are omitted.

## Accepted scope and remaining limits

Accepted for local integration of ordinary geometry in the **2D Model view,
World XY**. Ask retains its separate read-only path and M2 connection safeguards.
This milestone excludes electrical editing, CAD-backed targets, blocks, text,
dimensions, hatch, curved/wide/filled polylines, layouts/MSPACE, 3D, new layers,
file/project operations and physical-unit conversion. An invalid or mixed plan
is rejected whole.

Real-account provider compatibility, billing and model interpretation were not
validated with paid calls. Packaged/installer behavior was not tested; no
installer or release was produced. The user's explicit visual approval remains
required for each drawing edit. See [the implementation contract](AI-ASSISTANT-M3.md)
for the bounded operation schema and [M2 review](AI-ASSISTANT-M2-REVIEW.md) for the
previous credential/persistence review.
