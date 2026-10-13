# JCad GPU and 3D roadmap

Evidence snapshot: October 13, 2026. This development branch extends the published
GPU prototype at `2fbae7288bd110bfba7b9799280d66ccb2856774`. Canvas remains the
ordinary renderer. Feature branches are review candidates; completion here does
not authorize a release, default switch or merge.

## Five stages and completion gates

| Stage | Current evidence and ownership | Gate before completion |
| --- | --- | --- |
| 1. GPU diagnostics | Implemented on `feature/windows-gpu-diagnostics`, `16abc740`. About/report diagnostics describe adapters, explicit activity, acceleration and unavailable/software states. [Exact-commit CI passed](https://github.com/habit04/share/actions/runs/38333067699). Real Windows collection used Intel UHD; NVIDIA was inactive. | Review integration with the stable branch and rerun collector/About/report checks on that integrated commit. Missing adapter data must stay Unknown; capabilities must remain distinct from the renderer actually in use. |
| 2. Experimental 2D/simple 3D | Implemented on `feature/windows-gpu-renderer`, `2fbae728`. [Exact-commit CI passed](https://github.com/habit04/share/actions/runs/38334992102). Lines/curves, whole-view Canvas fallback, context recovery and an isolated mesh demo exist. See [prototype evidence](GPU-RENDERER-PROTOTYPE.md). | Keep the development flag; record source SHA, viewport, actual adapter/limits, CPU preparation/submission, completion observations and drawing differences. Establish bounded correctness and recovery before interpreting speed. |
| 3. Remaining 2D/reliability | Active independent work on `feature/remaining-2d-reliability`; dimensions, MTEXT, Windows path/recovery and polygon viewport work have owners. DWG graph/reader/writer repairs are owned by `codex/windows-dwg-metadata-reference-graph`, [PR #9](https://github.com/habit04/share/pull/9). | Each confirmed fix needs regression and relevant import-edit-save-reopen evidence. Before integration, require preservation of metadata, undo/dirty state, backups and recovery plus exact-commit CI. Six native DWG test inputs still require complete independent preservation and installer proof in the DWG workstream. |
| 4. Production GPU renderer | Incomplete. This branch adds bounded pan caching and experimental Windows CI as foundations. Zoom, broad entity/style coverage and consumer hardware coverage remain open. | Pass the production gates below on the combined, corrected 2D baseline before considering a default change. |
| 5. Full 3D development | Already begun on `share/feature/3d-development`, `0f644a7`; [CI passed](https://github.com/habit04/share/actions/runs/38336811063). A separate Open CASCADE/three.js application also exists in [habit04/jcad-3d](https://github.com/habit04/jcad-3d), `c3802fc`, with [successful CI](https://github.com/habit04/jcad-3d/actions/runs/38202841903). | Resolve which architecture owns future 3D integration. Require direct modeling, selection/snapping, dimensions, undo and persistent save/reopen/recovery evidence for the chosen track. Keep stable public 2D independent. Embedded 3D status/validation: [3D-STATUS](https://github.com/habit04/share/blob/feature/3d-development/docs/3D-STATUS.md); separate-app limits: [NOT-TESTED](https://github.com/habit04/jcad-3d/blob/main/docs/NOT-TESTED.md). |

The [October 11 remediation record](REVIEW-FIXES.md) tracks the original **53
defect recommendations**, including save/recovery as its first priorities. Later
feature-priority lists have different numbering; they must not be interpreted as
the same issue IDs or evidence that every historical recommendation is still open.
Current code and the owning branch's tests decide each item's status.

## Bounded pan-cache milestone

- Keep one immutable geometry/upload cache per renderer, with a camera anchor.
- Clip with a bounded overscan border so geometry can enter through viewport edges.
- Apply a small double-derived screen translation in the shader. Rebuild when
  leaving the border or approaching the projected-coordinate precision bound.
- Invalidate on document/layer/linetype changes, selection/hover, scale, twist,
  dimensions, DPR and effective lineweights. Mutable inputs always prepare again.
- Preserve fixed pixel stroke widths, curve error, translucent selection order,
  full-view fallback and context-loss/restoration resource ownership.
- Require 30 supported bounded-pan samples with zero geometry uploads and a panned
  Canvas comparison below 0.5% missed foreground using the existing two-pixel
  geometric tolerance. This tolerance is **not** exact rasterizer parity.
- Run both ordinary and experimental builds in Windows CI. Ordinary-build checks
  must find no prototype commands/UI and still draw a normal LINE. Experimental
  checks exercise default/fallback behavior, two context-loss cycles and the demo.

The benchmark retains the combined pan/zoom workload and adds pan-only results.
Zoom deliberately rebuilds: scaling screen-space triangles would also scale line
widths and violate the curve error budget. Timing has no pass/fail speed target;
zero uploads, geometric coverage, fallback and recovery are correctness gates.

### Delly validation

The clean committed source `09282834b62a9bbbe87bf56811ad7feca23190b7` passed
the direct Windows benchmark. Its complete timing, capability, upload and coverage
data are in [windows-gpu-pan-cache.json](benchmarks/windows-gpu-pan-cache.json).
Electron 44.7.0 / Chromium 152 ran on Windows kernel build 10.0.26200 with Intel
UHD Graphics explicitly active (driver 32.0.101.7088); NVIDIA RTX A3000 was inactive.
The viewport was 1216 x 552 CSS pixels at DPR 1. This validates one adapter/driver
combination. Other active development work was not stopped; system load and OS
caches were not controlled, so these samples do not establish general speed gains.

| Workload, 30 moving samples | Canvas observed render + flush median | GPU observed render + fence median |
| --- | ---: | ---: |
| 38,000 wires, pan only | 70.2 ms | 15.1 ms |
| 38,000 wires, combined pan/zoom | 150.0 ms | 158.6 ms |
| Small line/curve scene, pan only | 1.4 ms | 8.8 ms |
| Mixed 6,500-object schematic, pan only | 26.8 ms | 25.3 ms (Canvas fallback) |

Supported pan samples uploaded zero geometry bytes. The dense pan GPU CPU
submission median was 0.8 ms. Dense images still differed by 3.335% under
pixelmatch; panned and centered geometry passed the two-pixel coverage gate.
The mixed schematic fallback matched Canvas pixel-for-pixel. Neither fence waits
nor Canvas readback represent pure GPU execution or final display presentation.
Pointer rollover was disabled during comparisons to hold appearance constant;
hover/selection invalidation remains covered by focused tests.

Local validation passed: 2,348 regression tests, 27 conditional skips; all 70
focused GPU renderer tests; renderer/Electron/scripts typechecks; lint;
fixture/workflow checks; both builds; real ordinary-build LINE/diagnostics/UI/
clipboard/report checks; two context-loss/restoration cycles, grid fallback,
resource disposal and the separate demo's cameras/picking/recovery. Initial
sandbox runs could not perform private junction operations or launch Electron;
the complete suite and Electron checks passed with approved execution using
private profiles and temporary files. Exact-commit remote CI is still required
for this branch. Actual GPU-process failure, additional consumer adapters/drivers
and integration with the active 2D/DWG fixes remain unvalidated.

## Production gates still open

1. **Correct 2D baseline:** integrate completed text, dimensions, layouts,
   import/export and reliability fixes only after their owners finish validation.
2. **Renderer coverage:** text/fonts, hatches, blocks, images, dimensions,
   linetypes/weights, layouts, grids, underlays and active editing need faithful
   GPU rendering or explicit complete-view Canvas fallback. No missing subsets.
3. **Measured responsiveness:** repeat equivalent pan, zoom, editing and static
   redraws on representative drawings; bound CPU geometry work and allocations.
   Separate submission, completion observation and presentation claims.
4. **Hardware compatibility:** record Windows build, Electron/Chromium, driver,
   actual active adapter and WebGL limits for Intel integrated, AMD, NVIDIA,
   software-only/remote sessions and unavailable contexts. Only tested rows can
   pass. A CI runner or requested adapter is not proof of all consumer hardware.
5. **Graphics failure:** directly test context loss, repeated restore, resource
   disposal and unsupported devices. Actual GPU-process/driver failures require
   additional recovery evidence; forced WebGL loss and mocks do not prove them.
   A failed graphics path must return to usable Canvas without changing drawings.
6. **Integration evidence:** full regressions, both builds, Windows interaction,
   save/reopen and exact-commit CI must pass on the final integrated candidate.
   Obtain separate approval before switching the default, merging or deploying.

## Publication boundaries

The existing CI workflow runs on all branch pushes and pull requests. Pages runs
on the stable default branch; installer publication runs on `v*` tags or explicit
manual release dispatch. This feature branch changes only development CI and does
not alter release or Pages triggers. Do not create release tags or dispatch a
publishing workflow as part of these milestones.
