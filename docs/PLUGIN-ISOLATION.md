# Plugin capability isolation (priority 25) — threat model, design, migration

Status: SLICE 2 — PROPOSAL-P25 was ADMITTED (LEDGER L-011) and the wiring has
landed: `PluginHost` in `src/app/plugins.ts` honours the manifest opt-in fields and
loads worker plugins through the isolated realm in `src/app/plugin-isolation/`.
API v1 (`src/app/api.ts`) is **frozen and untouched**; `plugins.ts` changed only as
the admitted proposal specifies (manifest fields, `parseManifest` validation, the
`PluginHost.load` branch, trust-prompt capability display). Two slice-1 acceptance
findings are fixed in this slice: F-1 (the realm now locks the CommonJS identifiers
`module`/`exports`/`__filename`/`__dirname`) and F-2 (non-stageable calls are
refused inside `document.transact`, so §3/T9 atomicity holds as written). The
packaged-Electron worker path remains an open, lead-owned gate (§6), and **no
safely-untrusted plugin rollout in packaged builds is claimed**.

## 1. Audit summary — API v1 attack surface (base 038cb7b4)

- `evaluatePlugin` (`src/app/plugins.ts`) runs plugin code with `new Function('jcad', code)`
  in the application page, or, when the page CSP forbids eval, through the preload bridge
  `pluginsEval` (`webFrame.executeJavaScript`, `electron/preload.cjs`). Either way the code
  executes in the editor's own JavaScript realm.
- A v1 plugin therefore reaches, without any API call: `window` / the DOM, `window.editor`
  (every open tab, undo history, settings, viewport), `window.jcadApi`, the full desktop
  bridge `window.jcad` (save dialogs, `backupFile`, `openDrawing`, autosave, user library,
  catalog packs, other plugins' code via `pluginsRead`, `openExternal`, `quit`), and
  `localStorage` — including the trust answers themselves (`jcad.plugins.trusted`,
  `TRUST_KEY`) and every plugin's settings namespace.
- The only gate is a one-time trust prompt keyed by origin+path with a SHA-256 of the code
  (security review E-10, documented in `docs/PLUGIN-API.md` "Security"/"Capabilities").
  The prompt is a *trust decision*, not a sandbox: after "Load", nothing enforces any
  boundary. A malicious or compromised plugin can read/modify every drawing, overwrite
  files the user previously opened (through bridge save paths), tamper with the trust
  store so other plugins load silently, and persist by rewriting other plugins' code.
- `createApi` (`src/app/api.ts`) is careful *inside* the API (frozen copies, validated
  entities, per-owner revocation on dispose, settings allow-lists), but none of that binds
  code that simply steps around the API object — which page code always can.
- Electron containment is real but one layer down: sandboxed renderer, context isolation,
  `electron/ipc-guard.cjs` (IPC only from the app page's main frame), checked file paths in
  the main process, CSP `default-src 'self'`. It stops a plugin from reaching Node.js,
  arbitrary files or the network *through the bridge*; it does not stop a plugin from
  using every bridge capability the page itself has. Containment is unchanged by P25.

## 2. Threat model

Assets: open drawings (content + file paths), the user's files reachable through bridge
save/open paths, application data (autosave, library, packs, settings, trust store),
editor integrity (commands, UI, undo history), availability of the editor.

Adversary: a plugin the user was persuaded to trust once (or whose code changed under a
weak-hash path), or a benign plugin with a vulnerability an attacker can steer. The
adversary's code is arbitrary JavaScript. Out of scope: an adversary with OS-level access,
a compromised main process/Electron, or a malicious *host* (the host is trusted by
definition). The user remains the trust authority for *which* plugins run at all.

Threats and required properties:

| # | Threat | Required property |
|---|--------|-------------------|
| T1 | Plugin reads `window`, DOM, `window.editor`, `window.jcadApi` | Plugin code runs in a realm where none of these globals exist. |
| T2 | Plugin calls the desktop bridge (`window.jcad.*`) directly | The bridge object does not exist in the realm; the only channel is the host-mediated RPC. |
| T3 | Plugin reads/writes `localStorage` / other plugins' settings / trust store | No storage globals in the realm; settings RPC is scoped to the plugin's own `plugin:` keys unless a broader capability is declared. |
| T4 | Plugin performs API operations it never declared (e.g. a report plugin editing the drawing) | Every RPC method names a required declared capability; the host denies undeclared methods, atomically, and logs the denial. |
| T5 | Plugin forges RPC messages (guesses the channel, replays another plugin's messages, calls raw `postMessage`) | Every realm→host message must carry the per-session realm nonce, which exists only inside the realm bootstrap closure — never on any global, never in plugin-visible data. Unauthenticated messages are dropped and recorded, never answered. |
| T6 | Plugin uses stale handles after unload/reload (old session messages, consumed file grants, another session's grant) | Sessions are single-generation: dispose invalidates the nonce, all pending calls and all grants. File grants are single-use, short-lived and bound to the issuing session. |
| T7 | Plugin hangs or floods the host (never-settling load, RPC flood, oversized payloads) | Load timeout, per-call host→realm timeout, in-flight call cap, message size/depth validation on the host. A runaway realm is terminated without touching the editor (worker thread). |
| T8 | Plugin escapes via realm globals (`process`/env in a Node-hosted realm, `fetch`/`importScripts` network loads) | The bootstrap shadows `process`, `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts` and the raw `postMessage` global with throwing stubs before plugin code runs. (Defence in depth; T1/T5 do not depend on it.) |
| T9 | A "denied" operation partially applies | Refusal is atomic: capability checks happen before any host state is touched; batch transactions apply inside one v1 `document.transact`, so a failing op rolls the whole batch back with no undo entry and no dirty change. |
| T10 | Legacy plugins silently gain or lose power in migration | v1 semantics are byte-identical for existing manifests. Isolation is opt-in per plugin via new manifest fields (PROPOSAL-P25); the migration story is explicit (§5). |

Non-goals for this slice: CPU/memory quotas inside the realm (a worker can be terminated
but not yet metered), signed plugins, a per-method rate limiter beyond the in-flight cap,
and the Electron packaged-worker CSP check (Windows/packaged gate, §6).

## 3. Design

- **Realm**: one platform `Worker` per plugin (browser/Electron), or a Node
  `worker_threads` worker in tests. Both run the *same* bootstrap function
  (`realm-bootstrap.ts`, serialised for the Node path, bundled as a worker entry for the
  browser path), so the tested realm code is the shipped realm code.
- **Bootstrap** (`realmBootstrapMain`): captures the transport in a closure, waits for the
  host handshake (session id + two nonces + plugin name), installs the T8 stubs, builds
  the async v2 `jcad` proxy, and runs the plugin code with `jcad` as its only parameter —
  the same calling convention as v1, so plugin structure carries over.
- **RPC** (`protocol.ts`, `host.ts`): plain-data envelopes only
  (`{kind, v:2, session, nonce, id, method/callback, args}`), validated for shape, depth
  and total size before dispatch. Host→realm messages authenticate with the host nonce;
  realm→host with the realm nonce. Method → capability table is exhaustive: a method not
  in the table does not exist.
- **Host** (`IsolatedPluginSession`): owns a normal v1 `ApiHandle` (`createApi`) and
  executes authenticated, capability-checked calls against it, so drawing semantics —
  undo/redo/dirty, entity validation, cad-graph reconciliation, settings allow-lists —
  are exactly v1's. Commands the realm registers become v1 commands whose `run` is a
  reverse call into the realm; events flow the same way. Disposing the session disposes
  the v1 handle (commands/listeners removed), rejects pending calls, clears grants and
  terminates the worker.
- **Envelope id grammar** (established from source for X2/X2-W): the host consumes
  single-use ids for exactly two realm→host kinds. `rpc` ids are minted only by the
  realm bootstrap's `rpc()` (`realm-bootstrap.ts`) as `r<counter>` from a closure-local
  monotonic counter — plugin code can reach neither the counter nor the send function,
  sends happen synchronously at mint time, and the worker channel delivers in send
  order, so host receipt order equals counter order. `call-res` ids echo the host's
  own call ids, minted by `invokeRealm` (`host.ts`) as `c<counter>` from a per-session
  monotonic counter and copied verbatim by the realm's call handler — monotone in mint
  order, but received in callback *completion* order. No other authenticated envelope
  carries a consumable id (`load-done` has none).
- **Single-use enforcement (X2 + X2-W)**: the host consumes each authenticated
  envelope's `kind:id` synchronously on receipt, strictly after authentication and
  before validation/dispatch; a replay is dropped with no effect and recorded as a
  `replay` denial. Consumption is remembered in a bounded FIFO set (4,096 ids per
  session). Eviction from that set raises a per-kind **eviction watermark** — the
  highest counter ever evicted for the kind — and an envelope whose counter is at
  or below its kind's watermark is refused as a replay even after its id has left
  the set, so the window can no longer be waited out. Out-of-order in-flight ids
  *above* the watermark are unaffected. One exact exception: a `call-res` whose
  host call is still pending has never been answered (answering removes the
  pending entry), so a genuinely late first response is consumed normally even
  below the watermark. Ids outside their kind's counter grammar are governed by
  the set alone. Dispose clears the set and the watermarks.
- **Transactions**: the realm proxy collects mutating calls made inside
  `jcad.document.transact(fn)` and sends them as one `document.transactBatch` RPC; the
  host applies them inside a single v1 `transact` (one undo step, atomic). Reads inside a
  transaction observe committed state (a stated v2 difference, §5).
- **File-picker grants**: `files.requestRead` runs the host's picker (the user's grant
  act) and returns a single-use, 60-second, session-bound grant handle — not the file
  content. `files.readGrant` redeems it exactly once. `files.saveText` goes through the
  v1 API's bridge save dialog as before.
- **Previews/prompts**: `ui.prompt`, `ui.pick.*`, `ui.alert/confirm/openDialog` are host
  RPCs executed by the v1 tools on the host side, so point picks keep snapping/ortho and
  on-canvas previews exactly as in v1 — the realm only ever sees the resulting data.
  Dialogs are data-only in v2 (no `onOpen` DOM callback; see §5).

## 4. Capability set (declared in the manifest, enforced by the host)

`document.read`, `document.write`, `document.transact`, `commands.register`,
`commands.run`, `commands.list`, `ui.log`, `ui.interact`, `events.subscribe`,
`settings.own`, `settings.read`, `settings.write`, `files.read`, `files.save`,
`electrical.read`, `electrical.write`. Geometry helpers are pure math and run locally in
the realm (except `geometry.bounds`, which reads the drawing → `document.read`).
No capability is implied by another; an empty declaration can do nothing but load and
return — which the acceptance tests exercise.

## 5. Legacy compatibility / migration story

- **Legacy trusted plugins (default, unchanged)**: a manifest without the new fields is
  API v1 trusted page code, exactly as today — same trust prompt, same synchronous API,
  same behaviour. Nothing is silently sandboxed and nothing silently gains power.
- **Opt-in isolated plugins**: add `"apiVersion": 2, "isolation": "worker",
  "capabilities": [...]` to `plugin.json` (semantics prototyped in
  `plugin-isolation/manifest.ts`; admitted into `PluginManifest` as PROPOSAL-P25 /
  LEDGER L-011 and enforced by `parseManifest` and `PluginHost.load`).
  An isolated plugin that cannot start a realm **fails closed** — it is never run in the
  page as a fallback.
- **API differences a migrating plugin must accept** (v2 = v1 shapes, async delivery):
  every `jcad.*` call returns a promise (command `run` handlers are typically `async`);
  `document.transact` takes an (async) function and resolves after the batch commits —
  mutating calls inside the callback are staged by the realm proxy and resolve
  *provisionally* (entity ids are pre-assigned by the proxy and become real only when
  the batch commits; if the host rolls the batch back, `transact()` rejects and the
  provisional results are void), and reads inside the callback see committed state, not
  the staged writes; `ui.openDialog` accepts
  data-only options (`title/html/text/width/buttons`) — `onOpen` DOM wiring does not
  cross the realm, use `ui.prompt`/`ui.pick` or a follow-up dialog instead;
  `plugin.onUnload` callbacks run on graceful unload (forced termination skips them);
  direct page access (`window`, DOM, `localStorage`, the bridge) is gone by design —
  per-plugin settings move through `jcad.settings` `plugin:` keys as in v1.
- **SCRIPTRUN**: one-off scripts stay on the v1 trusted path in this slice (they are the
  user's own code, confirmed per run); an isolated script mode is future work.
- **`window.jcadApi` console**: unchanged (it is the developer's own console).

## 6. Limitations / open gates

- Wired into `PluginHost` behind the manifest opt-in (slice 2, L-011 conditions
  C1–C7). In an environment with no realm transport — including a packaged
  renderer whose worker CSP refuses the plugin body (next bullet) — a worker
  plugin fails closed at load; it never runs in the page as a fallback.
- The Electron packaged worker path is now RULED and measured (the lead's CSP
  ruling, 2026-10-21; the CSP-ruling delivery). The ruling: no `'unsafe-eval'`
  anywhere in the packaged renderer and no widening of the page CSP; the realm
  lives in the dedicated worker under the path-scoped worker CSP
  (`electron/renderer-origin.cjs`: `WORKER_CSP = "default-src 'none';
  script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'"`
  on `assets/worker/*`). Measured in the real Electron runtime
  (`scripts/e2e-plugin-csp.mjs`, development build on the production `dist`,
  served through the production `jcad://` handler): the page refuses `eval` /
  `new Function` from real page code; the realm worker asset
  (`assets/worker/realm-worker-<hash>.js`) is served with `WORKER_CSP`; and
  the realm refuses the plugin body itself — the bootstrap compiles the body
  string through the Function constructor (`realm-bootstrap.ts`,
  CSP-CALL-SITE), which `script-src 'self' 'wasm-unsafe-eval'` refuses, so a
  worker plugin fails closed at load in this runtime (the realm's load-done
  error is Chromium's "Evaluating a string as JavaScript violates the
  following Content Security Policy directive because 'unsafe-eval' is not an
  allowed source of script"). The realm additionally locks its own
  `eval`/`Function` globals to throwing stubs at handshake time, so the
  plugin-context refusal is a property of the realm, not only of the serving
  context. What remains open is exactly leg (b) of the ruling — a working
  plugin in the packaged runtime — blocked on ONE design change, drafted as
  `reviews/DRAFT-AMENDMENT-P25-CSP-HOSTING.md`: main-process-vetted plugin
  package files served under `jcad://app/plugin-realm/<session>/` with the
  worker CSP and loaded by the realm as module scripts (no string
  evaluation). Until that amendment is admitted and lands, worker isolation
  is NOT claimed for the packaged renderer; the Windows gate re-runs the e2e
  script against the packaged executable.
- A realm plugin with `document.read` can still *exfiltrate what it read* through any
  output channel it also holds (e.g. `ui.log`, `files.save`); capabilities reduce the
  surface, they do not make a granted-read plugin trustworthy. Network stubs (T8) are
  best-effort defence in depth inside the realm, not a network policy.
- No CPU/memory metering of the realm yet; termination is the remedy (T7).
