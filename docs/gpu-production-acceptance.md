# Windows production 2D GPU acceptance — bounded step 4

Candidate branch: `feature/windows-gpu-production-acceptance`.
Starting source: released `a580c9c6e27952c2b15e0a75b940facd3ec4f1fc` (v0.5.0).
Owned worktree: `C:/Users/justi/Documents/Codex/2026-10-12/task/jcad-gpu-compound-coverage`.
The completed `feature/windows-gpu-compound-coverage` branch remains at `dc89bb0c`.

This milestone adds explicit, ephemeral production-build candidate selection while
preserving the shipping Canvas default. It does not authorize a merge, release,
deployment, renderer default change, signing/security change or new 3D work.
The active 2D/3D follow-up owns its separate checkout and preferences/axis-label work.

| Acceptance | Current status | Required evidence |
| --- | --- | --- |
| Production entry | Implemented; ordinary/default diagnostics pass in Windows CI; full candidate phase under correction | Ordinary build registers explicit GPU/CANVAS selection; fresh process is Canvas with no allocated GPU |
| Developer isolation | Ordinary Windows CI default/diagnostics pass; no development globals or default backing | No prototype global, fixture loaders, reset/demo UI or debug transport in ordinary build |
| Certified drawing | Strict fixed 20-pair native gate implemented; hardware unrun | Actual owner-created WebGL2 ink; strict native Canvas raster and coverage comparison |
| Complete fallback | Native fixed controls implemented; hardware unrun; unit coverage retained | Unsupported geometry/fonts, grid, layouts/clipping, previews, unavailable/lost/failed context return complete exact Canvas without stale backing or data edits |
| Edit and history | Native LINE edit/undo/redo gate implemented; hardware unrun | Visible line/block/attribute changes, exact undo/redo and current selection; drawing/history/dirty state unchanged by mode selection |
| Font/display resources | Pending/first automatic font-frame proof reviewed and tested; hardware unrun; real SHX fixture absent | Same-snapshot resource epoch, fractional DPR/background/lineweights; current GPU content or complete Canvas fallback; distinguish mock checks from native evidence |
| Private persistence | Actual DXF codec roundtrips and owner-reassignment controls pass; native file gate unrun | Imported retained data, exact private DXF saves/reopens and previous-save backup; no original/user drawing rewritten |
| Hardware identity | Unrun | Serial actual Intel and NVIDIA owner-context reports; requested power preference alone is insufficient |
| Final checkpoint | Unrun | Independent review, full applicable checks, exact-head CI and one stable-source paired native run |

Original certified geometry, fixtures and guards remain unchanged. Small admitted
scenes retain pixelmatch threshold 0.15 and mismatch <0.001, bidirectional two-pixel
foreground misses <0.005; complete fallback uses exact RGBA. No accuracy, workload,
render deadline or security gate is waived. Source-build evidence does not certify
an installed or signed artifact. Missing licensed native fixtures remain explicit.

Ownership: runtime controller/production selector and focused unit tests — controller
agent; fixed main-authored probe/runner and confinement tests — probe agent; ordinary
smoke/CI/checklist and branch integration — root; resource/policy audit — read-only agent.
No concurrent edits or commits to shared files. Private dependencies, npm cache,
TEMP/TMP and test outputs stay in this worktree. Native app/GPU runs are coordinated
with the active lead before the paired checkpoint.

Validation receipts: first runtime checkpoint passed 19 focused mock app-boundary tests, renderer/test TypeScript and scoped lint. Independent static review found no blockers; the added selector-first-during-active-3D regression passed. Native production and installed gates are unrun. Initial checkout was
verified clean; locked dependencies refreshed privately, with preserved Electron
44.7.0 bytes SHA256 `2529b494f4123f152bce346051f7bd855ef95006424a561953cf17c49a3d1ba8`.

The second checkpoint adds a fixed main-authored `gpu2d` phase through the existing
bounded shipping-probe entry, with no renderer test global, supplied-code IPC,
inspector, deadline change or fuse/CSP change. It checks 20 mandatory comparisons,
real GL identity/counters, exact fallback bytes, automatic font/context frames,
and private five-primitive DXF saves, reopens and previous-save backup. Its
`fixtureSha256` identifies the authored drawing, not the application source.

Regression validation: 79 focused probe tests (63 2D GPU, 16 existing 3D transport)
pass. Font tests reject already-settled metrics, capture-time epoch changes and
async selector callbacks. Real codec tests preserve the full opaque XDATA span on
the original LINE across regenerated IDs and reject reassignment to other owners.
These checks double browser/GL transport and do not certify native execution.
Independent delta reviews cleared the two probe proof gaps. Full lint, all three
TypeScript scopes, fixture validation and nine workflow checks pass; full suite,
ordinary build, actual Intel/NVIDIA and exact-head CI remain pending.

The CI gate runs the ordinary production acceptance before the separate
experimental build. Software CI is reported honestly; a physical-adapter request
rejects known software renderers even when their identity contains a hardware
vendor name. Local native receipts additionally bind clean Git HEAD, tracked
source, ordinary `dist`, pinned Node/Electron and all private dependency bytes
before/after. Process evidence is limited to observed live lineage and exact
private executable/absolute Node-command ownership; polling does not certify
arbitrary unobserved external descendants. No other owner's process is stopped.

First broad checkpoint at `4fdb3d2`: 6,239 Windows tests passed, 38 skipped and
2 failed. The native pin-budget test's fixed 100-character cap rejected this
134-character logical fixture path before its intended native-pin assertion.
Its test-only correction derives that cap from the actual fixture path, verifies
native capture occurred and retains exact rejection/cleanup assertions; all
47 tests pass. The unchanged 33-file IPC case passed its original 30-second
limit in one short-private-TEMP targeted diagnostic. Path depth and reduced
contention remain confounded; no production saving code or deadline changed.

Both original push and PR CI runs had four passing jobs and one failed GPU job.
Their preserved child logs identify `Cannot set properties of undefined
(setting 'cursor')`: the probe used an invented Editor `state` property.
The correction observes the actual render overlay through the existing viewport
request seam, restores its descriptor and tests real Editor/Viewport forwarding.
Bounded fixed main failure reasons are now surfaced in CI after complete raw
stdout/stderr preservation. This was an early probe error; no successful GPU
accuracy, physical-adapter or installed-artifact proof is inferred. Full source,
fixture, security and deadline gates remain unchanged; corrected native acceptance
and exact-head CI are required before this draft can be considered complete.

The real-overlay corrective checkpoint passes 81 focused probe tests (65 GPU2D,
16 existing 3D transport), strict probe checkJs, normal renderer/test TypeScript,
scoped lint and diff checks. Its two added tests use actual Editor/Viewport code
with minimal Canvas/RAF doubles, a real LINE command, pointer preview and cancel,
and verify viewport-method descriptor restoration on publication failure.
Four failure-visibility tests separately pass. These remain app-boundary tests;
physical GPU, native fonts and full corrected CI are still acceptance gates.
