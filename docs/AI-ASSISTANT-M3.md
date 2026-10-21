# AI assistant milestone 3 — Draft / Edit: create and edit basic 2D geometry with preview and explicit approval

M3 adds a second mode beside the read-only Ask mode of M1/M2. In **Draft / Edit**
mode the user describes a drawing or edit, explicitly clicks **Generate Preview**,
and the selected provider returns a bounded, typed operation plan. JCad validates
and compiles the plan locally into exact geometry, shows a visual preview and an
exact change list **without changing the drawing**, and only an explicit
**Apply Changes** click commits the compiled result as one atomic undoable edit.
Discard (or any invalidation) drops the proposal with no drawing effect.

Codex leads review, Windows validation and local integration. This milestone
was developed and reviewed with injected fake transports and dummy keys; no
real provider call was made.

See [the M3 review report](AI-ASSISTANT-M3-REVIEW.md) for corrections,
Windows validation evidence and integration limits.

## Scope

The 2D Model view, World XY coordinates only. Paper spaces, layouts, MSPACE
and an active 3D view are refused for drafting. Ask mode retains its existing
paper-space unit handling.

Creation: `createLine` (explicit endpoints), `createCircle` (center + radius),
`createRectangle` (origin, width, height, optional rotation in degrees; JCad
computes the four vertices and creates one closed straight polyline).

Editing of **eligible selected objects only**: `move` and `copy` by an explicit
vector, `rotate` about an explicit pivot by an angle in degrees, `delete`.

An object is **eligible** when all of the following hold, evaluated on the
original local entity (never on the sampled AI snapshot):

- its type is `line`, `circle`, or a *straight* polyline (any nonzero bulge is rejected,
  no constant/per-segment widths, no `widthFrame`, not `filled`);
- a `circle` with `filled: true` is ineligible (electrical junction dots);
- it is not an electrical wire: JCad's canonical `isWire` rule (a line on a
  layer whose name starts with `WIRES`) — and, broader, **no** entity on a
  `WIRES`-prefixed layer is eligible, whatever its type;
- it carries no `cadIdentity` and no CAD graph anchor targets it (retained
  CAD-backed objects stay read-only; identity metadata is never stripped);
- it sits on a layer that exists, is visible (not off/frozen) and is unlocked.

Creation destinations are limited to the current layer and the layers of
included, eligible selected objects: at most 201 distinct layers. Each must
exist, be visible and unlocked, and have no `WIRES` prefix. This bounded list
is disclosed in the context; other layers cannot be targeted even if they
exist in the drawing. No layer is created automatically or substituted.

Out of scope: blocks (create/explode), text/fields, dimensions, hatches,
curved or variable-width polylines, layouts/viewports, 3D, electrical objects,
project-wide changes, running NEW, replacing the drawing, saving files. A plan
that mixes supported and unsupported operations is rejected **whole** — JCad
never applies a subset silently. Missing essential parameters (dimensions,
units, pivot, scope) must produce the clarification outcome below, not an
invented edit.

## The plan contract (version 1)

The provider returns exactly one object:

```jsonc
{
  "outcome": "proposal" | "clarification" | "unsupported",
  "message": string | null,        // required (bounded) for clarification/unsupported; optional note for proposal
  "operations": [ Operation ] | null  // required non-empty for proposal; must be null otherwise
}
```

Each operation is a flat object with an `op` discriminator and nullable
parameter fields (null = absent). Only the fields listed for an operation may
be non-null; local validation enforces this exactly, whatever the provider's
structured-output schema already constrained:

| op | required non-null | optional | meaning |
|---|---|---|---|
| `createLine` | `a`, `b` (points) | `layer` | line a→b |
| `createCircle` | `center`, `radius` | `layer` | circle |
| `createRectangle` | `origin`, `width`, `height` | `rotationDeg`, `layer` | closed 4-vertex polyline computed locally |
| `move` | `targetIds`, `dx`, `dy` | — | translate targets by (dx, dy) |
| `copy` | `targetIds`, `dx`, `dy` | — | duplicate targets offset by (dx, dy) |
| `rotate` | `targetIds`, `pivot`, `angleDeg` | — | rotate targets about pivot |
| `delete` | `targetIds` | — | delete targets |

Rules enforced locally by `parseAiDraftResponse` and the compiler (`src/ai/draft-plan.ts`,
`src/ai/draft-compiler.ts`):

- All values are **drawing units** and degrees. The draft context states the
  drawing's `$INSUNITS` name and the display format; a unitless drawing states
  that no physical scale exists. If physical units would require conversion,
  the provider must ask for drawing-unit values; M3 does not perform or ask
  the model to perform unit conversion. JCad never invents a scale.
- Points are `{x, y}` with finite coordinates, `|coordinate| ≤ 1e7`.
- `radius`, `width`, `height` must be finite and in `(0, 1e6]`.
- An entity id may be targeted by **at most one** edit operation in a plan
  (conflicting targets are rejected, never ordered by guessing). Edit targets
  must be ids included in the captured selection context **and** eligible at
  capture; unknown, unselected, omitted or ineligible targets reject the plan.
- Creations never carry ids; JCad mints new ids locally during compilation.
  The model cannot reference created objects.
- A no-op operation (zero move vector, rotation a multiple of 360°) rejects the
  plan; an empty or all-no-op proposal can never create an undo step.
- Limits (the `AI_DRAFT_*` constants in `src/ai/limits.ts`): plan JSON ≤ 32 KiB; ≤ 64 operations;
  ≤ 200 targets per operation; ≤ 400 affected and ≤ 200 created entities per
  plan; ≤ 512 vertices per compiled polyline (rectangles always produce 4).
  The prompt is limited to 2,000 characters, provider messages to 1,000
  characters, and context JSON to 96 KiB, including the bounded 64 KiB
  selection snapshot.
- Unknown operations, unknown or misplaced fields, wrong types, non-finite
  numbers and out-of-range values all reject the entire plan with a bounded,
  redacted reason. Nothing executable is ever accepted: no code, command
  strings, shell text, file paths, entity replacements or property patches
  exist in the schema.

Provider schemas are generated from this contract (`src/ai/draft-schema.ts`).
OpenAI uses a strict JSON schema (all fields required, nullables explicit).
Anthropic's structured-output schema omits `maxItems` (unsupported there);
array bounds are enforced locally, which is authoritative for both providers.
Draft output budget: OpenAI `max_output_tokens: 4096`, Anthropic
`max_tokens: 4096`, separately from the Ask budget (2048).
Incomplete/truncated plans are rejected
as `invalid-plan`, never retried (a retry would be a second paid call).

## Context, defaults and binding

The draft context (`src/ai/draft-context.ts`) is rebuilt locally for the panel's
preview as the prompt or drawing context changes. Generate Preview captures
the context used for that request after a read-only host-state check. The
panel shows the exact context JSON with its destination (provider + model).
The context contains: the user prompt; the M1
selection snapshot summary; an eligibility table for the selection (eligible
ids, and ineligible ids with reasons — the model is told to target only
eligible ids); the permitted layer list; the drawing units and coordinate
frame (World XY, Model tab); the creation origin default (World origin 0,0);
and the **frozen creation defaults**: current layer plus the appearance that
`Drawing.withEntityDefaults()` resolves for new entities (color, linetype,
lineweight), resolved at capture so preview and Apply show and produce exactly
the same appearance. Selection is limited to 200 unique bounded IDs before
capture. Objects omitted by the bounded selection snapshot are explicitly
ineligible edit targets even if the original local entity would otherwise be
editable.

The host requires canonical JSON and checks strict nested field whitelists,
types, counts and snapshot consistency. Accepted context bytes are preserved,
rather than sanitized into different data from the preview. Unknown nested
fields or inconsistent metadata reject the request before dispatch.

The staged proposal is bound (`AiDraftBinding`) to everything Ask binds
(session, document, content generation, monotonic revision, load count,
space, selection) **plus**: units fingerprint, frozen-defaults fingerprint,
eligibility fingerprint (target ids + verdicts and the editor's monotonic
interaction generation), and the provider/model/configuration generation
used at generation. Mode and prompt lifetime are guarded by the panel and
controller epochs. Invalidation occurs on document edits, undo/redo,
edit-then-undo (caught by the monotonic revision),
selection change, tab/space change, document replacement/close, prompt edit,
provider/model/key/enablement change, mode change, a newer request,
cancellation, tool start, grip-drag or selection-gesture start, reload,
disposal. Starting then cancelling a grip/selection interaction still changes
the interaction generation; returning to idle cannot revive a proposal.
A provider switch away and back does **not** revive a proposal (the
configuration generation differs and the
panel drops staged state on connection changes). Live drafting pins an opaque
host service-instance nonce plus configuration generation in its destination.
The host checks this at admission and again at dispatch, and the renderer
checks the generation returned with the result. Replacing a key or switching
away and back cannot pass as the earlier configuration.

Listeners are hints: Generate and Apply perform read-only host-state checks.
Apply then re-reads the authoritative document binding **immediately before**
the synchronous commit, and a stale proposal is discarded with
"Drawing or settings changed — generate again." It is never silently rebased.

## Compilation and preview

`compileAiPlan` is a pure function of (validated plan, captured drawing state,
authorized ids, frozen defaults, injected id factory). It transforms the
**original** entities with the existing pure helpers (`translateEntity`,
`rotateEntity`) so every unrelated property is preserved by construction, and
builds created entities from the frozen defaults. The compiler independently
revalidates the plan, rejects ID collisions across the document's identity
spaces, and checks finite bounded before/after geometry. It runs the full
graph/dependency and geometry preparation through
`prepareDrawingTransition(previous, candidate)` before staging. A candidate
that requires unsupported metadata reconciliation is refused.

Its frozen output — canonical operations, locally minted creation ids,
exact before/after geometry, the full
candidate entity array, a structured change list and preview geometry — is the
single artifact used by **both** preview and Apply, so the committed result is
bit-for-bit what was previewed, ids included. A private provenance record binds
the artifact to its capture and prepared candidate. A forged, altered or
unrecognized artifact cannot be applied.

Preview is a separately owned AI channel: `ViewportOverlay.aiPreview` (added,
modified-after, modified/deleted-original arrays) rendered by the viewport
after the tool ghost/preview channels with distinct styles (additions solid
green, new positions solid amber over dashed-grey originals, deletions dashed
red; a legend in the panel explains them). It is never written into the tool
`preview`/`ghost` channels (tools clear those on start/finish), never inserted
into the document, and — being renderer-only state fed from the compiled
artifact — it cannot affect history, dirty state, selection, snapping, hit
testing, grips, spatial indexes, extents, exports, saves or recovery. The view
is not moved automatically; **Fit Preview** calls `zoomToPoints` on the
four corners of the compiled bounds and redraws at the user's request. The
change list includes target/new IDs, layers, units, frozen creation defaults
and exact unrounded operation values. Preview ownership is scoped to its
panel, so an old panel's cleanup cannot clear a newer panel's preview.

## Atomic apply

`applyCompiledProposal` (`src/ai/draft-apply.ts`):

1. The controller re-checks busy state, the current configuration key and the
   freshly read binding, including units, defaults and target eligibility.
   The apply boundary also requires the exact captured state object,
   monotonic revision and load count, still in Model space.
2. Verify private artifact provenance and its exact candidate entity array.
   Re-run `prepareDrawingTransition(previous, candidate)` and require the same
   prepared candidate. Apply does not rebuild geometry or mint new IDs.
3. Commit through **one** synchronous `transactDrawing` call with no CAD edit
   intent: M3's eligible scope excludes CAD-backed entities, so no graph
   transform is declared and none can be applied twice. The transaction
   creates exactly one undo step, clears redo and marks the drawing modified
   through normal JCad behaviour.

Any refusal before the commit leaves document, metadata, history, dirty state
and selection untouched. Preparation runs before history is touched; mixed
valid/invalid plans were already rejected whole at compile. The proposal is
consumed before entering document subscribers, with a reentrancy guard. If a
subscriber throws after the atomic commit, the completed edit stays consumed
and cannot be retried as a second edit. A successful Apply clears the staged
proposal and the preview, keeps the
surviving selection (deleted ids are pruned by the editor's normal doc-change
handling) and selects nothing new. No save, export, backup or provider request
happens during Apply; its host-state check is a local read, not a provider API
call. One Undo restores the prior content and metadata; one Redo restores the
approved result.

Generation and Apply both refuse while the editor reports interaction:
`Editor.interactionBusy` (new narrow query) is true while a tool is active, a
"Select objects:" request is pending, a grip drag or selection gesture or pan
is in progress. The panel invalidates staged work on editor `tool` and
`interaction` events, including grip/selection starts that are later
cancelled. Ordinary pan/zoom can inspect a preview without starting a new
edit. Typing in the panel never reaches CAD
shortcuts (the existing panel keydown containment covers the Draft controls),
Enter in the draft prompt never applies — generation is button-only, and Apply
requires deliberate activation of **Apply Changes**.

## Providers and offline fixtures

Ask and Draft are separate typed paths end-to-end: `AiDraftRequest` /
`AiDraftProvider` in `src/ai/types.ts`, `LiveDraftProvider.draft()` with
provider/model/generation pinning, bridge method `draft`, host `service.draft()` with
the same serialized-mutation / configuration-generation / `requireStable`
guards as `service.ask()`, a new guarded IPC channel `ai-draft` (cancellation
reuses `ai-cancel` by request id), and per-adapter `draft()` implementations
sharing the reviewed transports' invariants (fixed HTTPS origins, redirect
refusal, streaming reads capped at 256 KiB, outbound cap, redacted bounded
errors, no automatic paid retries, `store: false` on OpenAI). All M2
protections — selected-provider-only routing, separate encrypted/session keys
per provider, default-off live access, sender/frame ownership, deadlines,
concurrency bounds — apply unchanged to Draft.

Deterministic offline fixtures (`src/ai/fixture-draft.ts`) demonstrate the
full flow without a provider: a bounded pattern set produces the documented
demonstrations (rectangle with inset circles, move/copy/rotate/delete of the
eligible selection), and anything else returns a clarification. Fixtures are
labelled "Offline demo — no AI model connected". The fixture asks for
clarification for unsupported mixed/conditional instructions, physical-unit
conversion, missing circle count/inset, and ambiguous numeric wording instead
of silently producing a partial plan.

Only explicit Generate Preview sends a draft request to a provider. Opening
Draft mode, editing the prompt, changing selection/settings, viewing, applying
or discarding a preview sends no drawing to a model. Local connection-state
checks may run when opening the panel, generating or applying. The separate
Test Connection button remains an explicitly charged, drawing-free provider
probe as documented in M2.

## Demonstrations (synthetic drawings only)

1. "Create a 100 × 60 rectangle with four circles of radius 3, centered 10
   units from each corner." (fixture or live)
2. Move the selected eligible geometry 10 drawing units right.
3. Copy the selected eligible geometry upward by an explicit distance.
4. Rotate the selected eligible geometry 90° about an explicit pivot.
5. Preview deletion of the selected eligible objects, then Discard.
6. Apply a proposal; one Undo restores the prior drawing; one Redo restores
   the approved result.

## Limitations

- 2D Model view / World XY only; no layouts, MSPACE or active 3D view.
- Live provider correctness with real keys is unverified (no real key or paid
  call was used). Packaged-app, installer and release behaviour were not
  validated by this milestone's local-checkout review.
- All plan values are drawing units. Required physical conversion must produce
  clarification, not model-side conversion. JCad validates the bounded plan
  and computes its geometry locally, but user review is still required to
  confirm that the proposed operations match the requested intent.
