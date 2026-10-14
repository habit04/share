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
| Production entry | Confirmed missing at baseline; implemented and focused-tested, native unrun | Ordinary build registers explicit GPU/CANVAS selection; fresh process is Canvas with no allocated GPU |
| Developer isolation | Source reviewed; ordinary bundle/native proof unrun | No prototype global, fixture loaders, reset/demo UI or debug transport in ordinary build |
| Certified drawing | Unrun | Actual owner-created WebGL2 ink; strict native Canvas raster and coverage comparison |
| Complete fallback | Unrun native; existing unit coverage retained | Unsupported geometry/fonts, grid, layouts/clipping, previews, unavailable/lost/failed context return complete exact Canvas without stale backing or data edits |
| Edit and history | Unrun native | Visible line/block/attribute changes, exact undo/redo and current selection; drawing/history/dirty state unchanged by mode selection |
| Font/display resources | Native gaps under audit | Same-snapshot resource epoch, fractional DPR/background/lineweights; current GPU content or complete Canvas fallback; distinguish mock checks from native evidence |
| Private persistence | Unrun | Imported retained data, exact private DXF saves/reopens and previous-save backup; no original/user drawing rewritten |
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
