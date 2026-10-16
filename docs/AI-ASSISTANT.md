# AI assistant — milestone 1: “Ask about selected objects”

Status: **reviewed, corrected and integrated locally on `review/ai-m1`**
(base `a68dba5b16ed4099d8decae32f936ebc023129fa`). Windows source validation
passes; see [review evidence](AI-ASSISTANT-REVIEW.md). This milestone is strictly
read-only. The live provider has **not** been selected: the live adapter in this
tree is inactive, is not registered with the Electron main process, is not
exposed by the preload bridge, and performs no network requests. Development
and tests use a deterministic fixture provider only, and make **zero external
AI requests**.

Later milestones (not in this tree): previewed drafting through validated
operations, deterministic JCad geometry calculations, one undoable transaction,
electrical assistance, and MCP access — each a separate scope decision.

## What the user gets

A docked **AI Assistant** palette (right side, beside Properties), opened from
the **AI** button in the status bar. The button calls the panel directly — it
does not dispatch a command, so opening or using the panel never cancels the
current drawing tool. The panel shows:

- the current selection summary (how many objects, how many will be included,
  how many are omitted and why),
- a **“What will be sent”** view containing the exact snapshot JSON that a
  provider would receive — nothing is sent anywhere else, and nothing else is
  sent,
- a question box, **Ask** and **Cancel** buttons,
- the answer as plain text, with references to selected object IDs that have
  been validated against the snapshot,
- clear stale / cancelled / error states.

An always-visible **Offline demo — no AI model connected** notice identifies
the current rule-based demonstration. It must not be presented as a live AI
model. The palette and its status-bar button contain keyboard events so that
Enter, Delete, Escape and editing shortcuts cannot reach drawing commands.

## Architecture

All logic lives under `src/ai/`, isolated from the editor's mutation paths:

| File | Role |
|---|---|
| `src/ai/limits.ts` | Every bound, in one place (objects, text, bytes, question, answer, timeout). |
| `src/ai/types.ts` | Provider-independent types: binding, snapshot, request, answer, errors, provider interface. |
| `src/ai/snapshot.ts` | Pure bounded snapshot builder over a minimal read-only source interface. Per-type field whitelist; never serialises entities wholesale. |
| `src/ai/editor-source.ts` | Adapter from `Editor` to that source interface, using only safe reads. |
| `src/ai/fixture-provider.ts` | Deterministic provider for development and tests. Same input → same answer. Answers only from snapshot data. |
| `src/ai/ask-controller.ts` | Request lifecycle: sequencing, cancellation, timeout, staleness re-check, answer validation, disposal. |
| `src/ai/live-provider.ts` | Inactive live adapter skeleton (see below). Separately reviewable. |
| `src/ui/ai-panel.ts` | The palette. All dynamic content is assigned via `textContent`; nothing from a drawing or a model is ever parsed as HTML, code, or commands. |

The Electron side for the eventual live adapter is `electron/ai-host.cjs`:
a narrowly validated host request service in the `font-metrics-host.cjs`
pattern (pure validator that copies only whitelisted, bounded fields;
bounded concurrency; timeout; disposal) plus a key store built on Electron
`safeStorage`. It is deliberately **not registered** in `electron/main.cjs`
and **not exposed** in `electron/preload.cjs` in this milestone — a test
asserts both.

### Why host-side is mandatory, not a preference

The page CSP (`index.html`) is `default-src 'self'` with no `connect-src`, so
the renderer cannot call a provider directly. Any live traffic must go
through the guarded host IPC (`electron/ipc-guard.cjs`) to a host service.
CADCraft's hosted panel calls providers directly from the browser and keeps
keys in browser storage; JCad deliberately diverges on both points (see
“Reference patterns” below).

## The snapshot (what would be sent)

Built only from explicitly selected objects, in drawing order:

- document units (`insunits` code + name, `lunits`, `luprec`, angular precision),
- active space (model, or layout name + viewport id),
- per object: `id`, `type`, `layer` name, a bounded geometry summary per type
  (e.g. line endpoints + length, circle centre + radius, polyline vertex
  count + closed + truncated vertex sample, insert block name + position +
  rotation + scale, text position + height), cheap primitive bounds where available,
  and **permitted text only**: text/mtext content, insert attribute
  tag → value pairs, dimension text overrides, leader text, table cell text.
- Explicitly **never** included: image file paths, field expressions
  (`FieldLink.code`), drawing metadata (`meta`), the CAD graph, file paths of
  the drawing, block definition internals, undo history, anything unselected.

Bounds (see `src/ai/limits.ts`): inspect at most 200 candidate objects; each text/name string at most
500 characters (truncated with an explicit marker); at most 32 attributes per
insert; inspect at most 64 table cells/rows; at most 16 sample vertices per polyline-like
object. Exact polyline lengths include bulged arcs, with full measurement limited
to 4,096 vertices; larger or affine-frame measurements are explicitly omitted.
Compound, text, table and polyline bounds enrichment is skipped so opening the
panel cannot trigger full block expansion or unbounded text/geometry work.
The whole compact serialized snapshot, including its own byte-count field, is
at most 64 KiB. Over-budget objects are omitted and reported. The preview uses
this exact compact representation. Omissions are reported as
`{ id, reason }` (unsupported object, object limit, byte limit, …) with total
vs included counts, with at most 100 listed entries within a 16 KiB omission
budget; the exact omitted count survives list truncation. Oversized root space
metadata fails with a controlled context error. Reference IDs are never
silently shortened. Selection ids that are not
drawing entities in the active space — for example 3D solids legitimately
present in the selection — are reported as unsupported, not dropped.

Drawing text is **untrusted data**: it is carried as JSON string values, is
never executed, and a provider (or the fixture) cannot turn it into commands.

## Binding and staleness

Every request captures a binding by value:

```
sessionId · docId (UUID) · contentGeneration · docRevision · docLoadCount
· active space · ordered selection ids · snapshot reference
```

`Drawing.revision` is monotonic across edits, **undo**, redo, loads and even
quiet patches, so an edit-then-undo — which restores the exact previous state
object and would fool a content hash — still invalidates an in-flight request.
Before an answer is displayed, the controller re-reads the binding from the
live editor and compares every field; any difference (edit, undo, selection
change, space change, tab switch — a tab switch reuses the same `Drawing`
object for a different document, which is why `docId`/`contentGeneration` are
in the tuple — document replacement, close) suppresses the answer as stale.
A newer request supersedes an older one; each call resolves its own terminal
status and older answers can never overwrite newer ones. Answers already on
screen are also cleared when the drawing context changes. Cancellation and disposal abort the provider call and suppress
any late result. Disposal also unsubscribes the panel from the editor.

## Read-only guarantee

Asking, receiving, cancelling and error handling perform **no** calls into
any mutating editor or drawing API: no `runCommand` (which would cancel the
current tool), no `startTool`/`cancel`/`finishTool`, no `transact`, no
undo/redo, no selection writes, no `doc.dirty`/`filePath` assignment. The
snapshot source interface exposes only reads, and the state-preservation
tests drive a full ask/cancel/error cycle against a real `Editor` and assert
that document state (by reference), selection, undo/redo depth, dirty flag,
current tool and active space are all unchanged.

## Answers

Malformed provider results and context-read failures become controlled error
statuses, with timers cleaned up; they do not leave a rejected UI promise or
an indefinitely busy panel. Answers are copied through a field whitelist and
displayed as text. A provider answer carries `references` (object
IDs it claims to discuss); the controller validates them against the snapshot:
references to IDs that were not in the snapshot are dropped and the drop is
surfaced in the UI (“2 references to objects outside the selection were
removed”). Answer text longer than the output limit is rejected as an error,
not truncated into a misleading partial answer. Model output is never
executed as JavaScript, HTML, CAD commands or file operations.

## Providers

```ts
interface AiProvider {
  readonly id: string;
  ask(request: AiAskRequest, signal: AbortSignal): Promise<AiAnswer>;
}
```

- **Fixture provider** (`fixture`): deterministic, offline, rule-based
  summaries computed from the snapshot (counts by type/layer, text search,
  per-object description). Used by the panel in this milestone.
- **Live provider**: not selected. `src/ai/live-provider.ts` defines the
  adapter shape over an injected host bridge and refuses every request with
  `provider-not-configured` unless a complete, agreed configuration is
  supplied — and even then it requires the host bridge, which this milestone
  does not wire. No endpoint, no credentials, no data handling has been
  agreed, so there is nothing to enable.

### Eventual live adapter (contract for the future milestone)

- A guarded, sender-scoped request/cancellation bridge to `electron/ai-host.cjs`; the renderer supplies
  only the validated request envelope (question + snapshot + binding), never
  a URL, path or key.
- Host reconstructs the snapshot from a per-type whitelist and re-bounds it (the host validator mirrors
  `src/ai/limits.ts`), enforces timeout and request/output limits, and
  reports usage (request count, input/output sizes, provider id, duration —
  never content or keys in logs). Cancellation removes queued work before any
  transport call and aborts running work. Enqueue deadlines cover queued jobs;
  a timed-out transport retains its physical concurrency slot until it settles.
  Future transports must enforce token/body limits before buffering responses;
  usage counters are not a monetary spend limit. No cancellation IPC or live
  transport is wired in this milestone.
- API keys live only in the host key store: encrypted with Electron
  `safeStorage` (OS-backed: DPAPI / Keychain / libsecret), stored as opaque
  ciphertext in the app data directory, never returned to the renderer, and
  never placed in plugin settings, browser storage, drawings, exports or
  logs. If `safeStorage` encryption is unavailable, the store refuses to
  persist a key; Linux `basic_text` and unknown storage backends are refused.
- Existing trusted plugins retain their current authority (they run in the
  page with full editor access). This milestone introduces **no** plugin
  isolation and claims none.

## Reference patterns (CADCraft)

Borrowed: separation of read-only inspection from any command path;
summary-first bounded context instead of a raw file; a “What is sent” view;
total-vs-returned counts with explicit truncation; object IDs as the
reference currency; fail-closed session binding; distinguishing malformed
requests from provider failures. **Not** borrowed: browser-side provider
calls and browser key storage (see above).

## Acceptance criteria (all covered by tests)

1. Snapshot includes units, IDs, geometry, layers, permitted text/attributes;
   shows exactly what would be sent; unsupported objects and oversized
   selections are reported, never silently dropped.
2. Full ask / cancel / error cycles preserve drawing data, imported metadata,
   selection, current tool, view, active space, undo/redo, dirty state and
   save/recovery behaviour; no command dispatch anywhere in the flow.
3. Provider interface is provider-independent and asynchronous; fixture
   provider is deterministic; live adapter is separate and inactive; no real
   drawings sent, no paid requests, zero external requests in tests.
4. Requests bind session/document identity, content generation, monotonic
   revision, active space and selection; stale answers are suppressed after
   edits (including edit-then-undo), selection changes, tab switches,
   document replacement and closing; older requests never overwrite newer.
5. Answers render as text only; references are validated against the
   snapshot; drawing text and model responses are treated as untrusted;
   nothing generated is executed.
6. Host service validates narrowly, supports cancellation, timeouts,
   request/output limits and usage reporting; keys use OS-backed encryption
   and appear in no settings, storage, drawing, export or log.
7. Tests cover success, failure, cancellation, timeout, overlapping
   requests, stale responses, disposal, hostile text, oversized output,
   context limits and state preservation.

## Known limitations

- The panel is wired with a fixed initial width (palette width persistence
  lives in a closed settings record; extending it is an integration decision
  for the lead).
- The fixture provider is a development stand-in: it summarises and searches
  the snapshot deterministically; it does not do natural-language reasoning.
- Field expressions and image paths are excluded from the snapshot by design;
  a dimension's measured value is not included, only its text override.
- Block-definition internals and inactive-layout entities are not part of a
  selection snapshot (the editor's selection is active-space only).
- Windows, the packaged app, and AutoCAD were not used to validate this
  milestone; the lead owns that validation.
