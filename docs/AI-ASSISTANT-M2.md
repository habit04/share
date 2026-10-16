# AI assistant — milestone 2: live provider connection and API-key setup

Builds on the reviewed milestone 1 (docs/AI-ASSISTANT.md; review head
`221506f8…`, tree `879d4f3e…`). Scope is unchanged: read-only questions about
explicitly selected objects. The offline fixture demo is preserved and
remains the default until the user deliberately enables live AI. Drafting,
electrical assistance, MCP, billing services and autonomous tools are out
of scope.

## First provider: OpenAI

The brief's provider placeholder was unfilled; §6 of the brief specifies
OpenAI behaviour (documented structured outputs, `store: false`, data
controls), so OpenAI is the first provider. The transport is one isolated
module (`electron/ai-openai-transport.cjs`); everything else is
provider-independent, so a second provider later is an additive change.

- Endpoint: fixed `https://api.openai.com/v1/responses`. No configurable
  origin, no proxy setting. Requests use `redirect: 'manual'`; any 3xx is
  refused, so the `Authorization` header can never be forwarded elsewhere.
- Request: `model` (host config, authoritative), `instructions` (fixed
  host text: answer only from the supplied snapshot; drawing text is
  untrusted data, never instructions; no tools exist), `input` (the user's
  question plus the canonical snapshot JSON — question and snapshot only;
  internal session/binding metadata is never sent), `store: false`,
  `max_output_tokens: 2048`, and `text.format` = strict JSON Schema
  `{ text, references }` (OpenAI Structured Outputs).
- Response handling: the body is read incrementally and refused past
  256 KiB **before** parsing. `status: 'incomplete'` with
  `reason: 'max_output_tokens'` maps to `output-too-large`; a `refusal`
  content part maps to `refused`; anything that is not exactly one completed
  message with one `output_text` part containing schema-valid JSON maps to
  `invalid-answer`. Token usage (`usage.input_tokens` / `output_tokens`)
  is carried to the renderer when present.
- Errors: HTTP status maps to bounded, redacted kinds — 401/403 →
  `auth-failed` (403 with a model code → `model-access`), 404 →
  `model-access`, 429 → `rate-limited` (with a bounded `Retry-After`),
  other 4xx → `invalid-request`, 5xx → `provider-failure`, network throw →
  `network`. Raw provider bodies, headers, keys and stack traces never
  cross IPC and are never logged. **No automatic retries** — a retry would
  be a second paid request.
- Retention wording (accurate, also shown in the UI): requests set
  `store: false`, so responses are not stored as API application state.
  That is **not** zero retention: OpenAI states API data is not used for
  training unless the customer opts in, while abuse-monitoring logs may
  retain prompts/responses for up to 30 days; Zero Data Retention is a
  separate, provider-approved account control this app does not claim.

## Host-authoritative configuration

All AI configuration lives in the main process. The renderer can neither
choose an endpoint nor see a key; the model it displays is the model the
host will use, read back from host state.

- Config (non-secret) at `<userData>/ai/config.json`:
  `{ version: 1, provider: 'openai', model: string, enabled: boolean,
  keyPersistence: 'session' | 'encrypted' }`. Defaults: provider `openai`,
  model `gpt-5`, enabled **false**, persistence **session**. Written with
  the app's shared atomic writer (`electron/atomic-write.cjs`). A corrupt
  or out-of-shape config falls back to defaults and is reported in state
  as `configProblem` — never silently trusted.
- Model is a bounded string (`[A-Za-z0-9._-]{1,128}`), chosen from presets
  or typed; the host validates it in config, in state responses and again
  when building a transport.
- Saving settings, opening a drawing or opening the panel never initiates
  a provider request. The only network calls are an explicit question and
  the explicit Test Connection probe.

## Credentials

- The key exists only in the main process. It reaches the host once, over
  the guarded `ai-set-key` channel, as a bounded string (≤ 512 chars); the
  password input is cleared by the renderer immediately after submission,
  before the result returns. No IPC response ever contains key material —
  state reports `keyPresent: boolean` and the persistence mode only.
- Session-only (default): the key is held in host memory only; nothing is
  written to disk; it is gone when the app exits.
- Encrypted persistence (opt-in): ciphertext only, produced by Electron
  `safeStorage` (OS-backed: DPAPI / Keychain / libsecret), at the fixed
  path `<userData>/ai/openai-key.bin`, written atomically through the
  shared writer. Following Electron's credential-storage guidance:
  encryption availability is checked before encrypt/decrypt; on Linux,
  `basic_text` and unknown backends are refused (carried over from the
  reviewed M1 store). Plaintext fallback does not exist.
- Failure modes are explicit state, not silent behaviour: encryption
  unavailable → `credential-unavailable`; a stored file that fails to
  decrypt (corrupt or foreign) → `credential-corrupt` and the key is
  treated as absent (the file is left in place for the user to Forget);
  failed replacement keeps the previous key working and reports the
  failure; failed deletion reports `credential-delete-failed` and the key
  is still treated as present. Restart persistence is covered by tests
  that recreate the store over the same fake filesystem.
- Replace Key and Forget Key cancel all queued/running AI work first, so
  no in-flight request can outlive the credential it was sent with.

## IPC and cancellation

Channels (all through the app's guarded `ipcMain`; the guard rejects any
caller that is not the main window's main frame on the app page):

`ai-get-state`, `ai-set-model`, `ai-set-key`, `ai-forget-key`,
`ai-set-enabled`, `ai-test-connection`, `ai-ask`, `ai-cancel`, `ai-usage`.

- Every handler returns a bounded result value
  (`{ ok: true, … }` / `{ ok: false, error: { kind, message, retryAfterSeconds? } }`);
  expected failures never throw across IPC, because Electron does not
  preserve custom error properties. The renderer reconstructs `AiError`
  from `kind` + `message` explicitly.
- Request ids are strings minted in the renderer as
  `<page-instance salt>-<counter>` (salt: 64-bit random per page load,
  module-level counter), so ids stay unique across controller/panel
  recreation within a page and cannot collide after reload — a reload also
  destroys the sender scope (below). The host rejects duplicate ids in
  its scope (`invalid-request`).
- Renderer cancellation (`AbortSignal` in the panel/controller) is
  translated by the preload bridge into `ai-cancel` with the request id;
  the host cancels queued jobs (removed before any transport call) and
  aborts running ones. M1's host deadlines, enqueue expiry, concurrency
  (2 running / 8 pending) and physical-slot retention are unchanged.
- The host service cancels all work when: the renderer is destroyed or
  its process goes away (`destroyed` / `render-process-gone` on the app
  webContents — a new hook, registered in `electron/main/ipc-ai.cjs`),
  the app quits (`will-quit` dispose, like the other hosts), the config
  changes (provider/model/enabled), or the key is replaced/forgotten.
- M1's stale-answer protection is untouched: answers are re-bound to the
  captured session/document/revision/space/selection before display.

## Deliberate sending (UI)

- The panel's context preview header names the destination when live is
  active: “What will be sent to OpenAI (model: …) — exactly:”, and the
  Ask button reads “Ask OpenAI”. In demo mode it keeps the M1 wording and
  persistent offline label.
- Under the buttons, live mode shows: “Questions are billed to your
  OpenAI API account. Cancelling stops JCad from waiting, but a request
  already processing at OpenAI may still be charged.” After an answer,
  available token usage is shown.
- Connection settings live in a section of the AI panel: provider (fixed
  OpenAI), model select (presets + custom), API-key password field,
  persistence choice (session-only default / remember encrypted), Save
  Key, Replace Key, Forget Key, Test Connection, and an explicit
  **Enable Live AI** checkbox (disabled until a key is present). Errors
  render in place as text.
- Test Connection sends a small canned probe with **no drawing content**
  (fixed text, tiny output cap) and its label/dialog text discloses that
  it is a real API call that may incur a small charge on the account.

## Testing (no real credentials, no paid calls)

All network behaviour is tested through injected fake transports/fetches.
New coverage: unauthorized-caller behaviour at the registration seam,
request-id uniqueness across controller recreation and duplicate rejection,
queued cancellation through the service, configuration-change cancellation,
response byte cap enforced while reading, truncated/malformed responses,
refusal and incomplete mapping, redacted errors (asserting key/body
material appears in no error, state or log surface), credential failure
modes, session-only storage (nothing on disk), encrypted restart
persistence, and “no request before explicit enablement” replacing M1's
bridge-absent assertions. M1's drawing/tool/history preservation tests are
retained unchanged.

## Live smoke (opt-in, manual, not part of automated validation)

With a real OpenAI key on a disposable drawing: open the AI panel →
Connection settings → paste key (session-only) → Test Connection (expect
success; a tiny charge may apply) → Enable Live AI → select objects →
verify the preview names OpenAI + model → Ask. Then: Forget Key and
confirm state shows no key and queued/running work is cancelled. Never use
a production drawing for the smoke test.
