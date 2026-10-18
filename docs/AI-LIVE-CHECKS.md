# JCad AI — Live Provider Checks (manual test harness)

A manual, in-app, one-shot acceptance aid for the live AI providers
(milestones 2–4). M1–M4 were validated entirely with fake transports; this
harness closes that one gap: it runs a small fixed sequence of real
provider calls — probe, Ask, Draft, Refine — against a fixed synthetic
drawing, using the key the user entered in JCad's AI Settings, and
reports pass/fail per check.

It is deliberately **not** a CI tool, a monitoring or scheduled tool, or
a feature: it adds no provider capability, changes no limit, and never
touches the user's drawing — the Draft/Refine results are discarded,
never compiled, staged, or applied.

## Trust boundary

The harness executes inside the app's own boundary and borrows the
existing service surface; it never crosses the key boundary because it
never reaches the layer where keys exist.

- Keys exist only inside `createAiService` (electron/ai-host.cjs): the
  encrypted key files, the per-provider session slots, and the closure
  of a transport the service builds. The renderer receives only
  `keyPresent`/`keySource` booleans.
- The runner (electron/ai-live-checks.cjs) calls **only** the service's
  existing public methods — `getState()`, `testConnection(signal)`,
  `ask(value, signal)`, `draft(value, signal)`,
  `refine(value, signal)` — invoked on the service instance, the same
  surface electron/main/ipc-ai.cjs already uses. Key resolution,
  destination pinning, configuration-generation stability, host-side
  request validation and the network call all happen inside the service
  and transports, unchanged.
- The harness modules (electron/ai-live-checks-core.cjs,
  electron/ai-live-checks.cjs) import neither the key stores, nor the
  config store, nor the transports, nor Electron's safe-storage API.
  They cannot read the key files, and the trigger channel takes no
  payload through which a key could arrive (see Activation). A test
  pins this by scanning the harness sources for forbidden references
  (tests/ai-live-checks-host.test.ts).
- What crosses the renderer boundary is exactly what already crosses it
  today: state booleans, provider/model names, validated results, and
  bounded counts.

So the harness adds **zero** new key-handling code paths and zero new
network code paths. Its only new authority is "ask the existing service
to perform, with fixed synthetic inputs, the four operations it already
performs for the panel."

## Activation

Activation is a physical, two-step action inside the running app, in the
AI panel's **Connection settings** under Test Connection:

1. The "Live provider checks" block shows a fixed note: the checks make
   up to four real provider API calls about a fixed test drawing, may
   incur a small charge, and send/change/save nothing of the user's.
2. **Run Live Checks** does not run anything: it reveals an inline
   confirmation naming the destination from the current host state —
   *"Run 4 checks against OpenAI · `<model>` now?"* Only the second,
   explicit click (**Run checks**) invokes the `ai-live-checks-run`
   channel. Any connection operation (settings change, provider switch,
   refresh) or panel hide resets the confirmation.
3. While a run is active, **Cancel checks** invokes
   `ai-live-checks-cancel` (owner-checked, like `ai-cancel`); results
   render in the block when the run settles.

Main-side guards (enforced in the runner/IPC layer, not just the UI):

- **No payload, no parameters.** `ai-live-checks-run` accepts no
  argument that could select a provider, model, prompt, or endpoint.
  There is no CLI flag, environment variable, file, or config key that
  arms or parameterises a run.
- **Guarded channel only.** Like all `ai-*` channels, both new channels
  are registered on the guarded MainContext, which rejects any caller
  that is not the application window's main frame.
- **CI refusal.** The runner refuses when the `CI` or `GITHUB_ACTIONS`
  environment marker is set — the same signals the repo's own build
  scripts treat as CI. Combined with "no payload, guarded window only,
  physical two-step click", there is no path by which automation
  reaches a run.
- **Single flight.** One run per app instance; a second invoke while a
  run is active resolves `{ ok: false, error: { kind: 'busy', … } }`.
- **Owner lifecycle.** The run record is installed before the run can
  await anything and joins the IPC layer's revocation set: renderer
  destroyed / render-process-gone / main-frame navigation aborts the
  run; app quit disposes the service, which cancels all host work.
- **State preconditions, checked in main before any provider call**:
  the run refuses with a named reason when no key is configured
  (`no-key-configured`), the provider is disabled
  (`provider-disabled`), a credential problem is set
  (`credential-problem`), a configuration problem is set
  (`config-problem`), or provider/model/configGeneration are missing
  (`no-destination`). A refused run makes **zero** provider calls —
  not even the probe.

## The fixed sequence

Four checks, strictly sequential, at most one provider call each. All
payloads are constants in electron/ai-live-checks-core.cjs; no user
drawing is opened, read, or referenced — the harness runs in the main
process, where no editor exists.

| # | Check | Service call | Pass criterion |
|---|-------|--------------|----------------|
| 1 | Connection probe | `testConnection(signal)` | resolves (the transports' existing canned probe) |
| 2 | Ask | `ask(request, signal)` | resolves with a host-validated answer |
| 3 | Draft generate | `draft(request, signal)` | resolves with outcome `proposal` and a host-validated plan; the result's `configGeneration` equals the pinned generation |
| 4 | Refine | `refine(request, signal)` | same as Draft, over the envelope built from check 3's actual plan |

The synthetic world is one line from (0, 0) to (100, 0), length 100, on
layer `0`, in a unitless Model space (snapshot 455 bytes as the host
recomputes it). The fixed texts are:

- Ask: *"How many objects are in the selection, and what is the length
  of the line? Answer briefly."*
- Draft prompt: *"Create one circle centred at (50, 50) with radius
  25."* — against the fixed draft context the app's own context builder
  would produce for this synthetic drawing (1,250 bytes canonical JSON).
- Refine follow-up: *"Change the circle's radius to 30."* — carried in
  the standard M4 seven-key refinement envelope built from check 3's
  host-validated plan, with per-kind proposal labels (`Circle 1`, …).
  The core also measures the envelope against the 96 KiB cap and
  refuses locally rather than sending an over-cap request.

A `clarification` or `unsupported` outcome on check 3 or 4 is a **check
failure** (the fixed prompts are unambiguous, so the plan path was not
exercised). If check 3 ends in such an outcome, check 4 is **blocked** —
prevented by the upstream outcome, never faked with an invented plan.
The returned plans are discarded: never compiled, staged, or applied.
Only the outcome, operation count, and token usage are reported.

## Budgets and cost shape

No new budgets — the run reuses the transports' existing caps: probe
64 (OpenAI) / 16 (Anthropic) output tokens, Ask 2,048, Draft/Refine
4,096; timeouts 15 s (probe) / 30 s (calls). The structural invariant:
**exactly 4 provider calls in the worst case, 1 in the best (probe
failure stops the run), zero on refusal; total output bounded by 10,304
tokens; no retries anywhere.** Harness calls enter the same host queue
as panel requests. Test Connection and a live-checks run are
independent, user-initiated facilities: neither blocks the other, and
starting one never refuses or queues the other. Each is individually
bounded — Test Connection probes are capped at 16 concurrent in the
IPC layer, and live-checks runs are single-flight (a second Run while
one is active is refused `busy`).

## Report

One bounded report object is returned over the run channel as
`{ ok: true, report }` and rendered by the panel as plain text —
visible in-app and copyable for a review record, and **written nowhere
else**: no file, no log sink, no telemetry.

Contents: provider + model, run tag, overall status (`pass` / `fail` /
`refused` / `cancelled`), refusal reason when refused, total provider
calls, total duration, summed provider-reported token counts; per
check: status, duration, and either a content-free detail (answer
length + reference count; operation count) or the host error **kind**
plus the host's already-redacted message (≤ 500 chars). A
`clarification`/`unsupported` message (≤ 1,000 chars, about the fixed
synthetic prompt) is included when a Draft/Refine check fails by
outcome. The Ask answer text is **not** included. The overall status is
`pass` only when every check passed; any `blocked` check forces a
non-pass overall.

Never in the report (or anywhere in the harness): the API key or any
fragment of it, authorization headers, request headers, raw provider
response bodies, the config generation, key file paths, or user
drawing data of any kind.

## Failure semantics

One rule governs everything: **a run aborts cleanly, reports what
happened, and never retries a paid call.**

| Failure | Behaviour |
|---|---|
| Preconditions unmet | Run refused before any call; report names the reason; zero provider calls. |
| Probe fails | Check 1 fails with the host error kind; checks 2–4 skipped; run ends. |
| Ask/Draft/Refine provider or validation error | That check fails with the mapped kind; later checks skipped. |
| Draft/Refine outcome `clarification` / `unsupported` | Check fails with that outcome as its kind, message shown. If Draft ended in an outcome, Refine is **blocked**; if Draft (or any earlier check) hard-fails or the run is cancelled, Refine is **skipped**. Run ends `fail`. |
| Configuration change mid-run | The service cancels all host work and advances the work generation: the in-flight call rejects `cancelled`, later calls fail the stability check, and the core fails a draft/refine result whose returned generation differs from the pinned one as `stale`. Nothing is re-pinned or re-sent. |
| User cancels | The runner aborts the run's controller; the in-flight call settles as `cancelled`; current check reports `cancelled`, later checks skipped. |
| Renderer destroyed/navigated, app quit | Owner-lifecycle revocation aborts the run; on quit the service dispose path cancels host work. No report is delivered to a gone renderer; nothing was written anywhere. |
| Timeout | Host-enforced per call (`timeout` kind); check fails, run aborts. Worst-case run ≈ 105 s plus overhead. |
| Second Run click while active | Refused `busy`; the active run is unaffected. |

A failed, refused, or cancelled run leaves **no state behind**: no
partial application (nothing is ever applied), no persisted report, no
changed settings.

## Tests

All harness tests are offline — every transport/fetch/facade is a fake,
exactly as the rest of the AI suite operates:

- `tests/ai-live-checks-core.test.ts` — the sequence executor against
  scripted fake facades: happy path for both providers' shapes,
  refusals with zero provider calls, abort-on-first-failure call
  counts, outcome/blocked semantics, stale-generation and cancellation,
  envelope canonicality and labels, request pinning and id validity.
- `tests/ai-live-checks-host.test.ts` — the keystone: core + runner
  against a real `createAiService` built with a fake transport factory,
  proving the fixed fixtures pass the real host validators; the
  no-secret sentinel assertions and the static source scan; the IPC
  guards (CI refusal, busy, owner-checked cancel, renderer-destroyed
  abort) through the real channel registration.
- `tests/ai-live-checks-panel.test.ts` — Run button gating from host
  state, the two-step confirm (first click sends nothing and names the
  provider/model), single invoke on confirm, results rendering, Cancel
  wiring, confirm reset on settings change and panel hide.
- `tests/ai-ipc.test.ts` — the guarded-channel inventory pin (14).

## Limitations

- The harness proves the provider paths work end-to-end for one fixed
  synthetic case per provider/model; it is not a quality evaluation of
  the model, and a misunderstanding of a fixed prompt is reported as a
  check failure by design.
- It runs only in a development or installed app a user is sitting in
  front of, with a key the user saved; it produces no saved artifact —
  retaining a report means copying the panel text into a record.
- Packaged-app behaviour and real-account compatibility are exactly
  what a first manual run establishes; nothing about them is claimed
  before that run happens.
