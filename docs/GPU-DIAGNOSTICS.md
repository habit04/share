# GPU diagnostics on Windows

Open **Help > About** (or run `ABOUT`) and scroll to **GPU diagnostics**.
**Copy Diagnostics** copies the same concise summary included in **Report a Problem**
(`REPORTBUG`), saved reports and prefilled GitHub bug reports. Retry is available when
information is pending or unavailable. Nothing is sent automatically.

JCad currently draws with **Canvas 2D**. Chromium feature statuses describe the browser
runtime's graphics configuration; they are not evidence that every drawing operation is
GPU accelerated. Adapter activity is shown only when Chromium explicitly identifies it.
An installed dedicated adapter does not mean it is active. Missing values remain Unknown.
Windows is reported as its numeric kernel release/build (Windows 11 also uses version 10.0).

The main process observes `gpu-info-update` before querying Electron's
`getGPUInfo('complete')`, `getGPUFeatureStatus()` and `isHardwareAccelerationEnabled()`.
Collection has a deadline and runs independently of startup. The preload exposes one
read-only, guarded IPC method. Only bounded, allowlisted adapter, driver, feature and
runtime-version fields leave the main process. Raw GPU data, credentials, hostnames,
command-line arguments and personal paths are excluded. Acceleration settings and GPU
selection are unchanged.

API reference: [Electron app GPU APIs](https://www.electronjs.org/docs/latest/api/app).
The implementation is checked against the installed Electron 44.7.0 typings.

## Development isolation and validation

Baseline: v0.4.8, `83aedbcc7b145ff87293a35d9001cb56f127a2b0` (successful CI).
Branch: `feature/windows-gpu-diagnostics`.
Worktree: `C:\Users\justi\Chad\jcad-gpu-diagnostics`.
Dependencies and `dist/` belong to this worktree. For a development server use
`npm run dev -- --port 5187`; validation uses the built page without a server.

`tests/gpu-collector.test.ts` covers mocked hardware/software configurations, multiple
adapters, unavailable information, API failures, timeout and update ordering.
`tests/gpu-diagnostics.test.ts` covers formatting, privacy, unavailable IPC and report
integration. Run `npm run typecheck:all`, `npm run lint`, `npm test` and `npm run build`.
Then run `node scripts/e2e-gpu-diagnostics.mjs` on Windows: it launches the development
application with its own profile, exercises the real collector, About, Windows clipboard
and report preview, and keeps screenshots/summary under ignored `e2e-output/gpu-diagnostics/`.

Direct validation on this machine found Intel UHD Graphics explicitly active, NVIDIA RTX
A3000 and Microsoft Basic Render Driver inactive, with Canvas and compositing enabled.
This is a snapshot, not a claim about other systems. Fallback/error cases use mocks;
validation does not change this machine's acceleration settings.

Validation completed: full suite 2,238 passed / 27 skipped; after the final timeout fix,
all 27 focused GPU tests passed. Renderer, Electron and scripts typechecks, lint and
the development build passed. The real Windows test also verifies an ordinary 2D LINE
command after opening both diagnostics dialogs. Two implementation agents and an
independent reviewer worked within this worktree; review findings received regression
tests. The renderer deadline accommodates both bounded collector windows so stalled
complete-info requests still return available acceleration/feature values.

Before combining with other updates, review changes to `electron/main.cjs`,
`electron/preload.cjs`, the FileBridge type and Help/report dialogs. A future renderer must
update the current-renderer label from Canvas 2D to its actual method; GPU capabilities
must remain separate. No 3D implementation or release workflows are part of this change.
