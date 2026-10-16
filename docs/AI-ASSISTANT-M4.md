# JCad AI Assistant — Milestone 4: refine the staged preview with follow-up instructions

Milestone 4 extends the reviewed milestone 3 Draft / Edit mode
(`docs/AI-ASSISTANT-M3.md`, including its review corrections) with follow-up
refinement of a staged preview. Everything milestone 3 guarantees still
holds; this document describes only what M4 adds.

See [the local review report](AI-ASSISTANT-M4-REVIEW.md) for review corrections,
Windows evidence and integration limits.

## User flow

1. Generate Preview exactly as in M3 (explicit click; the drawing is
   unchanged; the staged proposal is compiled once and frozen).
2. The staged preview is labelled **Preview version 1**. A separate
   **Follow-up instruction** field appears below the change list, with the
   exact **refinement context** it would send shown underneath it.
3. Typing a follow-up never sends anything. It records the follow-up with
   the controller and **pauses Apply Changes** until the follow-up is
   resolved.
4. **Refine Preview** (the only send action besides Generate Preview) sends
   exactly the previewed envelope in one provider request. While it runs,
   the previous preview stays on screen and on the canvas, labelled as the
   previous version; Cancel is available.
5. A successful refinement atomically replaces the staged preview: the new
   proposal becomes **version N+1**, the follow-up field clears, a
   **“Changes from the previous preview version”** list names what changed,
   what was added, and what was removed, and Apply is re-enabled.
6. **Apply Changes** commits exactly the currently staged version — once,
   through the M3 atomic boundary; earlier versions can never be applied.
   One Undo restores the original drawing and metadata; one Redo restores
   the approved result. After Apply the session is cleared, and Undo does
   not revive any proposal.
7. **Discard** clears the entire draft session at any time.

Clearing the follow-up field manually leaves the follow-up unresolved and Apply
paused. Use **Discard Follow-up** to restore the prior version after fresh local
host and document checks. Pending host-state checks are tied to the clicked
instruction; an edit, Cancel or Discard cannot launch a late refinement request.

## The refinement contract

- A refinement returns a **complete replacement plan**, evaluated against
  the **original captured drawing**. Preview geometry is never temporarily
  applied, edits are never appended to an earlier preview, and a plan is
  never silently rebased onto a newer drawing.
- Canonical example: an original line; the first preview moves it 10 units
  right; the follow-up “change that movement to 15 units right in total”
  produces a replacement plan that moves it 15 from its **original**
  position. Apply moves it 15 once; one Undo restores the original.
- New geometry follows the same rule: “increase that new circle's radius”
  replaces its creation operation; “remove that new circle” removes its
  creation operation from the replacement plan.
- **Preview-generated entity IDs never become authorized drawing targets.**
  Replacement plans are validated and compiled by the same M3 pipeline
  against the original capture, so a plan that targets a preview ID (or any
  non-eligible id) is rejected whole, as is any mixed valid/invalid plan.
  Ambiguity produces a clarification outcome, never an invented edit.

## Proposal references

Every proposed operation carries a display label — **Rectangle 1**,
**Circle 2**, **Move 1** — numbered per operation kind in plan order
(`planOperationLabels` in `src/ai/draft-plan.ts`, stamped onto each change
entry by the compiler). Labels appear in the change list (e.g.
`• [Circle 2] Create circle …`), in the refinement envelope, and in the
version diff. They are proposal references for the user's follow-up
wording only: they are not drawing object IDs and confer no authority.

## The refinement envelope

`buildRefineEnvelope` (`src/ai/draft-refine.ts`) builds the only payload a
refinement may send. It is a versioned, strictly whitelisted, canonical
JSON object with exactly these fields:

| Field | Content |
| --- | --- |
| `kind` | `jcad.ai.draft-refine-context` |
| `version` | `1` |
| `originalPrompt` | the original drafting instruction, verbatim |
| `followUp` | the current follow-up instruction (≤ 2,000 chars) |
| `originalContext` | the exact M3 bounded draft context object captured at Generate time |
| `currentPlan` | the latest accepted canonical plan: `{ message, operations }` with every operation in full wire form (`planToWire`) |
| `proposalLabels` | `[{ label, summary }]` for the current plan's operations |

The envelope contains the **latest accepted plan only** — no conversation
transcript accumulates. It never carries files, full drawing state,
unrelated objects, credentials, or hidden metadata. The panel displays the
exact envelope JSON and the provider/model destination **before** Refine
Preview is clicked; the renderer sends precisely those bytes; the host
re-validates them (below) before any provider call.

The whole envelope is capped by the existing **96 KiB** draft context
limit (`AI_DRAFT_MAX_CONTEXT_BYTES`). If the envelope would exceed it, the
refinement is refused whole with a clear message and the previous preview
is preserved — authorization context is never truncated and the context is
never silently broadened. All other M3 limits are unchanged (32 KiB plan,
64 operations, 200 targets per operation, 400 affected, 200 created, 512
polyline vertices, coordinate/dimension caps, 1,000-char provider
message). The follow-up field reuses the existing 2,000-character question
bound. **No limit changed in M4.**

The 32 KiB plan limit also applies to the current plan after expansion into full
wire form, before dispatch. Valid long operation summaries use the total envelope
budget, rather than the unrelated 1000-character provider-message limit. The host
requires one correctly ordered label per operation, original eligible and
snapshot-disclosed targets, and permitted creation layers. Accepted bytes remain
unchanged. Envelope construction requires the proposal's compiler provenance.

## Follow-up lifecycle (controller)

The staged status carries a `version` counter and a nullable `followUp`
record (`{ text, phase, message? }`):

- `entered` — text present, not yet refined. Apply is blocked.
- `refining` — one request in flight. The previous preview remains staged
  and displayed. Cancel (the panel's Cancel button) settles the request as
  cancelled; editing the follow-up text supersedes it; a newer Refine
  Preview supersedes it too.
- `clarification` / `unsupported` — the provider asked or refused. The
  previous preview is preserved; the follow-up stays unresolved (Apply
  stays blocked) until the user edits and refines again, or discards the
  follow-up.
- `failed` — provider error, timeout, invalid plan, or an envelope that
  could not be built. Same preservation rules; retry is explicit.

Settlement follows the M3 pending-finish discipline: a refined result is
accepted only if the document state identity, interaction state, provider
configuration key and full binding still match the **original capture** at
dispatch and again after compilation; otherwise the **entire session** is
invalidated as stale. Late results from cancelled, timed-out or superseded
requests are dropped even if a provider ignores abort. A discovered
configuration change at Refine click likewise invalidates rather than
quietly re-targeting.

**Discard Follow-up** abandons the follow-up and returns to the staged
preview — but applicability is restored **only after fresh checks**: the
controller re-reads the live binding (document, selection, units,
defaults, configuration key, interaction state) and restores only if it
still exactly matches the capture; otherwise the session is invalidated as
stale instead of resurrecting a preview whose context has moved on.

Discard Follow-up performs a read-only host-state check in addition to the
controller's local checks. This catches unseen provider/model/key configuration
changes, including away-and-back changes. No provider call is made to restore a
previous preview.

Session-wide invalidators are exactly M3's (document edits, selection,
defaults/units, tool or grip/selection interaction starts, space/3D
changes, provider configuration changes including away-and-back, disposal,
document replacement, hiding/closing the panel, switching modes, editing
the original prompt). Each drops **all** retained previews and pending
refinement work. Preview/refinement never touch document content, history,
dirty state, selection, file path or manual tool state; preview geometry
stays excluded from snapping, hit testing, extents, save/export and
recovery; view movement happens only via Fit Preview or normal navigation.
**Enter in either text field never applies changes.**

Ordinary view navigation is separate from editing activity. A result arriving
during a pan may replace the preview without making the capture stale, while
Apply remains blocked until the pan ends. Pan start/end view events refresh
control availability without rebuilding context or invalidating the session.

The current proposal's direct-Apply authority is suspended during an unresolved
follow-up and restored only by successful replacement or fresh-checked explicit
discard. Replaced, discarded or consumed proposal artifacts are permanently
revoked, even if external code retained an earlier status. Published follow-up
state, wire values and version-diff data are immutable. Cancellation aborts
physical work and settles independently; failures, cancellation and timeout
re-check staleness as well as successful results. Provider methods retain their
instance binding, and pending ownership is installed before notifying subscribers.

## Providers and host

Both live providers support refinement with the same plan schema:

- `LiveDraftProvider.refine()` mirrors `draft()`: it requires the bridge's
  `draftRefine`, pins `{ provider, model, configGeneration }` from the
  configuration displayed in the panel, re-checks the returned generation,
  and validates the response with the same plan parser. A provider without
  refinement support refuses cleanly and the preview is preserved. There is
  no automatic cross-provider fallback and no automatic paid retry: one
  Refine Preview click permits exactly one provider request.
- The adapters gain `refineDraft` (OpenAI Responses API and Anthropic
  Messages API): identical endpoints, fixed destinations, redirect refusal,
  bounded streaming reads, 4,096 output-token budget and redacted error
  mapping as `draft`, with `REFINE_INSTRUCTIONS` (mirrored in
  `src/ai/draft-schema.ts` and both adapters) and user content composed as
  the follow-up line plus the exact envelope JSON.
- The host validates a refinement before dispatch (`aiRefineRequest`):
  the outer envelope limit, canonical envelope JSON with the exact
  seven-key whitelist, follow-up equality with the request, the nested
  original context re-validated whole by the M3 context validator
  (including its canonical-form and selection-consistency checks against
  the shared binding), the current plan byte-capped and validated by the
  host plan mirror (a malformed *current* plan is an invalid **request**,
  never an invalid-plan *result*), bounded labels, and the same binding
  whitelist, destination pinning and configuration generation as drafts.
  The result crosses back through the same `aiDraftResult` validation as a
  draft result. Refinement jobs share the draft deadline, concurrency and
  pending caps, the guarded IPC channel set (new channel
  `ai-draft-refine`, same request ownership/cancellation discipline) and
  lifecycle revocation.
- The offline fixture provider implements the same contract
  deterministically: rectangle size changes (corner-inset circles keep
  their inset), circle radius changes, removing one labelled creation,
  movement totals (never compounding), and rotation angle changes;
  anything else is a clarification.

## Changed / added files

Renderer: `src/ai/draft-plan.ts` (`planToWire`, `planOperationLabels`),
`src/ai/draft-compiler.ts` (change entries carry `label`),
`src/ai/draft-refine.ts` (new: envelope, labels, version diff),
`src/ai/draft-controller.ts` (session: follow-up lifecycle, refine /
cancelRefine / discardFollowUp, Apply gating), `src/ai/types.ts`
(`AiDraftRefineRequest`, optional `AiDraftProvider.refine`),
`src/ai/fixture-draft.ts` (deterministic refinement),
`src/ai/draft-schema.ts` (`REFINE_INSTRUCTIONS`),
`src/ai/live-provider.ts` (`refine`), `src/ai/host-bridge.ts`
(`draftRefine`), `src/ui/ai-panel.ts` (follow-up UI), `src/styles/app.css`.

Host: `electron/ai-host.cjs` (`aiRefineRequest`, host/service `refine`),
`electron/ai-openai-transport.cjs` and
`electron/ai-anthropic-transport.cjs` (`refineDraft`),
`electron/main/ipc-ai.cjs` (`ai-draft-refine`),
`electron/preload.cjs` (`draftRefine`).

Tests: `tests/ai-draft-refine.test.ts`,
`tests/ai-draft-panel-refine.test.ts`, plus refinement coverage added to
the host, service, transport, IPC, bridge and live-provider suites.

## Limitations

- Refinement quality is bounded by the provider: the renderer/host enforce
  the contract (complete replacement, original targets only, local
  compilation), but a provider can still return a *valid* plan that
  misunderstands a follow-up. The complete change list, the version diff,
  exact values and explicit Apply remain the user's protection.
- The version diff matches operations by content, then by kind; a
  moved or renumbered exact match explicitly shows its prior/current label
  and operation position. This describes operation changes; it does not prove
  geometric equivalence.
- Only the latest accepted plan is carried forward. Multi-step conversational
  context beyond the original request, the current plan and one follow-up
  is deliberately out of scope.
- Packaged-app and real-account provider behaviour are not validated by
  this milestone's fake-provider evidence. Local Windows development-build
  validation is recorded separately in the review report; no installer,
  release or real-account validation is claimed.
