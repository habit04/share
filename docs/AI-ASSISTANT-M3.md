# AI assistant milestone 3 — Draft / Edit: create and edit basic 2D geometry with preview and explicit approval

M3 adds a second mode beside the read-only Ask mode of M1/M2. In **Draft / Edit**
mode the user describes a drawing or edit, explicitly clicks **Generate Preview**,
and the selected provider returns a bounded, typed operation plan. JCad validates
and compiles the plan locally into exact geometry, shows a visual preview and an
exact change list **without changing the drawing**, and only an explicit
**Apply Changes** click commits the compiled result as one atomic undoable edit.
Discard (or any invalidation) drops the proposal with no drawing effect.

Codex remains lead for review, Windows testing, integration and merging. This
milestone was developed with injected fake transports and dummy keys only; no
real provider call was made.

## Scope

Model tab, World XY coordinates only. Paper spaces / layouts / MSPACE are
refused for drafting (the existing paper-space snapshot override of Ask mode is
unchanged).

Creation: `createLine` (explicit endpoints), `createCircle` (center + radius),
`createRectangle` (origin, width, height, optional rotation in degrees; JCad
computes the four vertices and creates one closed straight polyline).

Editing of **eligible selected objects only**: `move` and `copy` by an explicit
vector, `rotate` about an explicit pivot by an angle in degrees, `delete`.

An object is **eligible** when all of the following hold, evaluated on the
original local entity (never on the sampled AI snapshot):

- its type is `line`, `circle`, or a *straight* polyline (no `|bulge| > 1e-12`,
  no constant/per-segment widths, no `widthFrame`, not `filled`);
- a `circle` with `filled: true` is ineligible (electrical junction dots);
- it is not an electrical wire: JCad's canonical `isWire` rule (a line on a
  layer whose name starts with `WIRES`) — and, broader, **no** entity on a
  `WIRES`-prefixed layer is eligible, whatever its type;
- it carries no `cadIdentity` and no CAD graph anchor targets it (retained
  CAD-backed objects stay read-only; identity metadata is never stripped);
- it sits on a layer that exists, is visible (not off/frozen) and is unlocked.

Creations may target only layers that exist, are visible and unlocked at capture
time. No layer is ever created automatically and no layer is substituted.

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

Rules enforced locally by `parseAiPlan` / the compiler (`src/ai/draft-plan.ts`,
`src/ai/draft-compiler.ts`):

- All values are **drawing units** and degrees. The draft context states the
  drawing's `$INSUNITS` name and the display format; a unitless drawing states
  that no physical scale exists, and the provider instructions require a
  clarification outcome when the user specifies physical units the drawing
  cannot anchor. JCad never invents a scale.
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
- Limits (`src/ai/draft-limits.ts`): plan JSON ≤ 32 KiB; ≤ 64 operations;
  ≤ 200 targets per operation; ≤ 400 affected and ≤ 200 created entities per
  plan; ≤ 512 vertices per compiled polyline (rectangles always produce 4).
- Unknown operations, unknown or misplaced fields, wrong types, non-finite
  numbers and out-of-range values all reject the entire plan with a bounded,
  redacted reason. Nothing executable is ever accepted: no code, command
  strings, shell text, file paths, entity replacements or property patches
  exist in the schema.

Provider schemas are generated from this contract (`src/ai/draft-schema.ts`).
OpenAI uses a strict JSON schema (all fields required, nullables explicit).
Anthropic's structured-output schema omits `maxItems` (unsupported there);
array bounds are enforced locally, which is authoritative for both providers.
Draft output budget: `max_output_tokens` 4096 on both adapters, documented
separately from the Ask budget (2048); incomplete/truncated plans are rejected
as `invalid-plan`, never retried (a retry would be a second paid call).

## Context, defaults and binding

The draft context (`src/ai/draft-context.ts`) is built only when the user
clicks Generate Preview, is previewed verbatim in the panel with the
destination label (provider + model), and contains: the user prompt; the M1
selection snapshot summary; an eligibility table for the selection (eligible
ids, and ineligible ids with reasons — the model is told to target only
eligible ids); the permitted layer list; the drawing units and coordinate
frame (World XY, Model tab); the creation origin default (World origin 0,0);
and the **frozen creation defaults**: current layer plus the appearance that
`Drawing.withEntityDefaults()` resolves for new entities (color, linetype,
lineweight), resolved at capture so preview and Apply show and produce exactly
the same appearance.

The staged proposal is bound (`AiDraftBinding`) to everything Ask binds
(session, document, content generation, monotonic revision, load count,
space, selection) **plus**: units fingerprint, frozen-defaults fingerprint,
eligibility fingerprint (target ids + verdicts), the mode, and the
provider/model/configuration generation used at generation. Invalidation on:
document edits, undo/redo, edit-then-undo (caught by the monotonic revision),
selection change, tab/space change, document replacement/close, prompt edit,
provider/model/key/enablement change, mode change, a newer request,
cancellation, tool start, reload, disposal. A provider switch away and back
does **not** revive a proposal (the configuration generation differs and the
panel drops staged state on any connection-state change). Listeners are hints:
Apply re-reads the authoritative binding **immediately before** the synchronous
commit (after any IPC state check), and a stale proposal is discarded with
"Drawing or settings changed — generate again." It is never silently rebased.

## Compilation and preview

`compileAiPlan` is a pure function of (validated plan, captured drawing state,
authorized ids, frozen defaults, injected id factory). It transforms the
**original** entities with the existing pure helpers (`translateEntity`,
`rotateEntity`) so every unrelated property is preserved by construction, and
builds created entities from the frozen defaults. Its output — canonical
operations, locally minted creation ids, exact before/after geometry, the full
candidate entity array, a structured change list and preview geometry — is the
single artifact used by **both** preview and Apply, so the committed result is
bit-for-bit what was previewed, ids included.

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
compiled bounds at the user's request.

## Atomic apply

`applyCompiledProposal` (`src/ai/draft-apply.ts`):

1. Re-check the binding, busy state and eligibility against freshly read state.
2. Rebuild/verify the candidate from the staged compiled artifact and run the
   existing side-effect-free `validateDrawingState(candidate, previous)`
   preflight (CAD identity/anchor guard, geometry budget, dimension checks).
3. Commit through **one** synchronous `transactDrawing` call with no CAD edit
   intent: M3's eligible scope excludes CAD-backed entities, so no graph
   transform is declared and none can be applied twice. The transaction
   creates exactly one undo step, clears redo and marks the drawing modified
   through normal JCad behaviour.

Any failure before or during the commit leaves document, metadata, history,
dirty state and selection untouched (preparation runs before history is
touched; a mixed valid/invalid plan was already rejected whole at compile).
A reentrancy flag plus proposal consumption make double-apply impossible; a
successful Apply clears the staged proposal and the preview, keeps the
surviving selection (deleted ids are pruned by the editor's normal doc-change
handling) and selects nothing new. No save, export, backup or provider request
happens during Apply. One Undo restores the prior content and metadata; one
Redo restores the approved result.

Generation and Apply both refuse while the editor reports interaction:
`Editor.interactionBusy` (new narrow query) is true while a tool is active, a
"Select objects:" request is pending, a grip drag or selection gesture or pan
is in progress. Starting a tool invalidates a staged proposal (the controller
subscribes to the editor `tool` event). Typing in the panel never reaches CAD
shortcuts (the existing panel keydown containment covers the Draft controls),
Enter in the draft prompt never applies — generation is button-only, and Apply
requires deliberate activation of **Apply Changes**.

## Providers and offline fixtures

Ask and Draft are separate typed paths end-to-end: `AiDraftRequest` /
`AiDraftResult` in `src/ai/types.ts`, `LiveProvider.draft()` with the same
destination pinning as Ask, bridge method `draft`, host `service.draft()` with
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
labelled "Offline demonstration" in the panel, exactly like the Ask fixture.
Only explicit Generate Preview sends a request — opening Draft mode, editing
the prompt, changing selection or settings, viewing, applying or discarding a
preview sends nothing.

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

- Model tab / World XY only; no layouts, MSPACE, or 3D.
- Live provider correctness with real keys is unverified (no real key or paid
  call was used); Windows packaged-app behaviour remains Codex's review step.
- The model's unit phrasing is interpreted against the units stated in the
  context; JCad validates and computes all geometry locally, but a model that
  misreads a physical-unit request in a unitless drawing is directed to ask
  for clarification rather than guess.
