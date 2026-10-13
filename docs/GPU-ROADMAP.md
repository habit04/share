# JCad GPU and 3D roadmap

Evidence snapshot: October 13, 2026. This isolated development branch,
`feature/windows-gpu-2d-integration`, combines pinned [PR #10](https://github.com/habit04/share/pull/10)
head `a0eea698e4af721b7fd0fb4199534d2c9ec46290` with pinned
[PR #11](https://github.com/habit04/share/pull/11) head
`3ce7e10a8aade41407c0b38f07b52c113225bbcd`. The local merge is `8e78a036`;
`a481a48e` adds integrated Windows CI checks. Both source heads passed their
exact-head CI; **integration CI and experimental integration validation are pending**.
Canvas remains the ordinary renderer. Feature branches are review candidates;
completion here does not authorize a release, default switch or merge.

## Five stages and completion gates

| Stage | Current evidence and ownership | Gate before completion |
| --- | --- | --- |
| 1. GPU diagnostics | Implemented initially at `16abc740`; PR #10 adds bounded collection and clipboard-completion repairs. The integrated ordinary Windows build passed collector/About/copy/report checks locally. Adapter activity and unavailable/software states remain explicit. Intel and NVIDIA evidence are recorded below with their source commits. | Exact integration CI must pass. Missing adapter data must stay Unknown; capabilities must remain distinct from the renderer actually in use. Stable-branch integration still requires separate approval. |
| 2. Experimental 2D/simple 3D | The prototype at `2fbae728` and PR #10's pan-cache/recovery milestone have successful source CI. Lines/curves, complete-view Canvas fallback, context recovery and the isolated mesh demo exist. See [prototype evidence](GPU-RENDERER-PROTOTYPE.md). | Keep the development flag. Experimental build, native failure/unavailable-device probes and benchmarks are pending on the combined branch. Record source SHA, viewport, actual adapter/limits, CPU preparation/submission, completion observations and drawing differences before interpreting speed. |
| 3. Remaining 2D/reliability | Partly complete: PR #11's validated batch is integrated locally, with seven real Windows batch checks passed. The [remaining checklist](REMAINING-2D-CHECKLIST.md) stays open with its active owners. DWG graph/reader/writer work remains owned by [PR #9](https://github.com/habit04/share/pull/9), whose published `a320ee2d` CI failed. | Each remaining fix needs regression and relevant import-edit-save-reopen evidence. Require metadata, undo/dirty state, backups/recovery and exact integration CI. Complete the PR #9 transaction/codec review and independent native preservation gates below; a signed-helper-only workflow does not prove an installed application. |
| 4. Production GPU renderer | Incomplete. Bounded pan caching, diagnostics liveness, Canvas restoration repaint and native recovery/unavailability passed on the PR #10 source. NVIDIA RTX A3000 benchmark and native recovery passed on that pinned source. Combined experimental validation, zoom, broad entity/style coverage, PR #9 integration and additional consumer hardware coverage remain open. | Pass every production gate below on the combined, corrected 2D baseline before considering a default change. |
| 5. Full 3D development | Already begun on `share/feature/3d-development`, `0f644a7`; [CI passed](https://github.com/habit04/share/actions/runs/38336811063). A separate Open CASCADE/three.js application also exists in [habit04/jcad-3d](https://github.com/habit04/jcad-3d), `c3802fc`, with [successful CI](https://github.com/habit04/jcad-3d/actions/runs/38202841903). | Resolve which architecture owns future 3D integration. Require direct modeling, selection/snapping, dimensions, undo and persistent save/reopen/recovery evidence for the chosen track. Keep stable public 2D independent. Embedded 3D status/validation: [3D-STATUS](https://github.com/habit04/share/blob/feature/3d-development/docs/3D-STATUS.md); separate-app limits: [NOT-TESTED](https://github.com/habit04/jcad-3d/blob/main/docs/NOT-TESTED.md). |

The [October 11 remediation record](REVIEW-FIXES.md) tracks the original **53
review recommendations** for JCad Electrical 0.4.1, including save/recovery as its first priorities. Later
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

Local validation passed: 2,354 regression tests, 27 conditional skips; all 70
focused GPU renderer tests; renderer/Electron/scripts typechecks; lint;
fixture/workflow checks; both builds; real ordinary-build LINE/diagnostics/UI/
clipboard/report checks; two context-loss/restoration cycles, grid fallback,
resource disposal and the separate demo's cameras/picking/recovery. Initial
sandbox runs could not perform private junction operations or launch Electron;
the complete suite and Electron checks passed with approved execution using
private profiles and temporary files. Exact-commit remote CI is required for every
published candidate. Additional consumer adapters/drivers and integration with
the active 2D/DWG fixes remain unvalidated.

### Diagnostics and native graphics recovery milestone

The first experimental CI run at `8a747354` exposed a collector liveness failure:
[four jobs passed, but the GPU job failed on pending diagnostics](https://github.com/habit04/share/actions/runs/38339309773).
GPU information requests can emit their own later update events. The collector
now coalesces updates, preserves settled data during refresh and resolves each
request independently of a follow-up query. Acquisition and the Windows harness
are bounded; missing GPU data settles as Unavailable with reasons rather than
inventing an adapter. Collector, diagnostics and viewport focused tests passed
(38 tests), as did the real About/clipboard/problem-report interaction.

On clean source `0f9ce3c8c3374790432ad24d7e733fbbd3635d71`, the private Windows
probe terminated only the GPU child process identified twice by that app's
`getAppMetrics()` PID and creation time, after verifying its private profile.
Chromium lost both WebGL and Canvas 2D. The viewport now discards its saved bitmap
and requests a redraw when Canvas restores. It automatically repainted the small
line/curve scene **while WebGL was still lost**, with no document change; WebGL
then restored and completed a frame. LINE and private DXF Save As/reopen passed.
See [native recovery evidence](benchmarks/windows-gpu-process-recovery.json).

The restored Canvas had 632 differing raw color-channel values. At the recorded
pixelmatch threshold of 0.15, visible difference fraction and bidirectional
two-pixel foreground miss were both zero; all pixels were opaque and the 4,214
foreground pixels were retained. Both acceptance fractions must remain below
0.5%. This is bounded raster/geometry evidence, not byte-for-byte parity. The
native scene has four entities; the lost saved-scene cache is separately covered
by the 250-entity viewport regression. Canvas itself was unavailable temporarily;
the test does not claim uninterrupted CPU rendering during a GPU-process failure.

With `--disable-gpu` and `--disable-software-rasterizer` limited to a second private
Windows instance, actual WebGL and WebGL2 context creation returned null. Both
the small scene and a 6,500-entity mixed schematic matched the complete Canvas
reference exactly. LINE and real private DXF save/reopen preserved 6,501 entities,
with no page errors. The instance, profile and temporary directory were removed.
See [unavailable-device evidence](benchmarks/windows-gpu-unavailable.json).
These flags prove context unavailability on this runtime, not all software or
remote-session backends. Both probes run sequentially in experimental Windows CI.
Their source SHA and modified-worktree state are recorded in each result.

This milestone is [draft PR #10](https://github.com/habit04/share/pull/10), stacked
on the prototype branch. Its pinned `a0eea698` source passed all five jobs in
[push CI](https://github.com/habit04/share/actions/runs/38344472899) and
[PR CI](https://github.com/habit04/share/actions/runs/38344477917), including
real diagnostics/clipboard/report, unavailable-device and native GPU-process
probes, benchmarks and context restoration. The native evidence producer above
was the clean committed `0f9ce3c8` source; these records are not integration results.
Real driver resets, persistent graphics failures, additional active adapters and
the combined corrected 2D baseline still require validation.

### Combined 2D integration candidate

Pinned [PR #11](https://github.com/habit04/share/pull/11) head `3ce7e10a` passed
[exact-head CI](https://github.com/habit04/share/actions/runs/38343333658).
This batch provides polygon DXF viewport clips, dimension/style overrides,
TEXT/ATTDEF/ATTRIB defaults and width corrections, manual-height MTEXT flow and
distinct Windows Unicode filename/save identity. It does not complete the
remaining 2D checklist: curved/DWG clips, additional dimension types, font fidelity
and embedding, CTB/STB, complex linetypes, automatic/native columns and other
compatibility work remain open.

On the combined local candidate at `a481a48e`, validation passed 2,508 regression
tests with 27 conditional skips, all renderer/Electron/scripts typechecks, lint,
fixture/workflow checks and the ordinary build. Real Windows ordinary-build
Canvas, diagnostics copying and problem-report checks passed. All seven
`e2e-2d-batch` checks passed: polygon paper-space editing/undo and native DXF
save/reopen with exact backup bytes; safe DWG clip refusal; TEXT/ATTDEF/ATTRIB
overrides; manual MTEXT flow; and distinct Unicode files/backups. These are local
results. Both ordinary and experimental integration builds passed. **Native
failure/unavailable-device probes, benchmark artifacts and exact integration CI
remain pending.**

PR #9 remains an owner-managed dependency. At published head `a320ee2d`,
[CI failed](https://github.com/habit04/share/actions/runs/38344080551) in unit,
UI and Windows Electron checks. Its successful installer workflow ran only the
signed portable-helper job; application build, smoke, artifact verification and
release jobs were skipped. PR #9 and PR #11 share 14 files, including the same
`Drawing.transact` hunk. A later integration must preserve PR #9 graph validation,
reconciliation and edit-intent forwarding through both PR #11 transaction scopes
(`commitTransition`/`transactDrawing`). Require owner-completed native repairs,
deliberate codec/transaction review and fresh combined tests for clips, dimension
overrides through DWG, saving/backups/recovery and both build modes. Keep DWG clip
refusal until native pointer ownership is independently proven.

### NVIDIA validation on the pinned GPU source

A separate private process using Electron's documented
[`force_high_performance_gpu` selector](https://github.com/electron/electron/blob/v44.7.0/docs/api/command-line-switches.md)
verified NVIDIA RTX A3000 explicitly active, driver `32.0.15.9671`, on clean source
`a0eea698e4af721b7fd0fb4199534d2c9ec46290`. Fresh projected diagnostics and unmasked
WebGL renderer strings agreed before and after native GPU-process replacement.
Automatic Canvas fallback, completed WebGL restoration, LINE and private DXF
Save As/reopen passed; Canvas pixels matched exactly on this sample. See
[paired native evidence](benchmarks/windows-gpu-nvidia-process.json).

The full benchmark passed curves/precision, dense and panned coverage, zero
uploads for bounded pan, exact mixed-schematic Canvas fallback, two context-loss
cycles, disposal and the demo's interaction/recovery checks. Actual per-fixture
renderer observations stayed on RTX A3000. Dense pan measured Canvas 51.7 ms vs
GPU 8.2 ms; combined pan/zoom remained slower on GPU (78.6 vs 54.3 ms). Dense pixels
differed by 3.335%; geometric coverage passed. Integration activity was running
concurrently, so timings describe these samples and do not establish a controlled
speed gain. See [paired benchmark evidence](benchmarks/windows-gpu-nvidia-comparison.json).
Absolute artifact paths were omitted from these public paired exports; measured
values and embedded results were retained.

This is one NVIDIA driver/runtime sample on the pinned GPU source. The combined
2D candidate's results must be assessed separately below. Some Chromium-reported
driver-vendor strings were inconsistent; adapter vendor IDs/name, explicit active
flags and observed context renderer strings establish the sample's adapter.
Missing or anomalous vendor metadata is not inferred from a preference request.

## Production gates still open

1. **Correct 2D baseline:** complete the remaining owned checklist and validate
   the pinned PR #10/PR #11 combination. Integrate PR #9 only after its owner
   finishes native preservation and the shared transaction/codec review above.
2. **Renderer coverage:** text/fonts, hatches, blocks, images, dimensions,
   linetypes/weights, layouts, grids, underlays and active editing need faithful
   GPU rendering or explicit complete-view Canvas fallback. No missing subsets.
3. **Measured responsiveness:** repeat equivalent pan, zoom, editing and static
   redraws on representative drawings; bound CPU geometry work and allocations.
   Separate submission, completion observation and presentation claims.
4. **Hardware compatibility:** record Windows build, Electron/Chromium, driver,
   actual active adapter and WebGL limits for Intel integrated, AMD, NVIDIA,
   software-only/remote sessions and unavailable contexts. Only tested rows can
   pass. Intel and RTX A3000 samples do not complete AMD, remote-session, persistent
   failure or broader driver coverage, nor prove every feature on the integrated baseline.
   A CI runner or requested adapter is not proof of all consumer hardware.
5. **Graphics failure:** directly test context loss, repeated restore, resource
   disposal and unsupported devices. One private native GPU-process termination
   and explicit context unavailability passed on Delly; driver resets, persistent
   failures, larger cached native scenes and more runtimes still require evidence.
   Forced WebGL loss and mocks alone do not prove these cases. A failed graphics
   path must return to usable Canvas without changing drawings.
6. **Integration evidence:** full regressions, both builds, Windows interaction,
   save/reopen and exact-commit CI must pass on the final integrated candidate.
   Local ordinary-build integration checks have passed; experimental integration
   checks and exact integration CI are pending. Obtain separate approval before
   switching the default, merging or deploying.

## Publication boundaries

The existing CI workflow runs on all branch pushes and pull requests. Pages runs
on the stable default branch; installer publication runs on `v*` tags or explicit
manual release dispatch. This feature branch changes only development CI and does
not alter release or Pages triggers. Do not create release tags or dispatch a
publishing workflow as part of these milestones.
