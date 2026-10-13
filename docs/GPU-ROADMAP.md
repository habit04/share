# JCad GPU and 3D roadmap

Evidence snapshot: October 13, 2026. This isolated development branch,
`feature/windows-gpu-edit-cache`, extends [draft PR #13](https://github.com/habit04/share/pull/13),
whose published zoom evidence head is `734de794`. PR #13 extends
[draft PR #12](https://github.com/habit04/share/pull/12),
which combines pinned [PR #10](https://github.com/habit04/share/pull/10)
head `a0eea698e4af721b7fd0fb4199534d2c9ec46290` with pinned
[PR #11](https://github.com/habit04/share/pull/11) head
`3ce7e10a8aade41407c0b38f07b52c113225bbcd`. The local merge is `8e78a036`;
`a481a48e` adds integrated Windows CI checks. Both source heads passed their
exact-head CI. Combined source `4bad60b2` passed local ordinary/experimental checks,
both adapter benchmarks and native cached-scene recovery; its exact-head
[PR CI passed](https://github.com/habit04/share/actions/runs/38350338690).
The zoom candidate is [draft PR #13](https://github.com/habit04/share/pull/13), stacked
on PR #12. Clean renderer source `fd7fac0723a1b7934f08356f21494da29318eac4`
passed the local and native checks recorded below and all five jobs in
[push CI](https://github.com/habit04/share/actions/runs/38356361254) and
[PR CI](https://github.com/habit04/share/actions/runs/38356882557).
Every subsequent candidate still requires its own exact-head CI.
Canvas remains the ordinary renderer. Feature branches are review candidates;
completion here does not authorize a release, default switch or merge.

## Five stages and completion gates

| Stage | Current evidence and ownership | Gate before completion |
| --- | --- | --- |
| 1. GPU diagnostics | Implemented initially at `16abc740`; PR #10 adds bounded collection and clipboard-completion repairs. Combined source `4bad60b2` passed collector/About/copy/report checks and exact-head CI. Adapter activity and unavailable/software states remain explicit. Intel and NVIDIA evidence are recorded below with their source commits. | Require exact CI for each new candidate. Missing adapter data must stay Unknown; capabilities must remain distinct from the renderer actually in use. Stable-branch integration still requires separate approval. |
| 2. Experimental 2D/simple 3D | The prototype at `2fbae728` and PR #10's pan-cache/recovery milestone have successful source CI. Combined source `4bad60b2` passed both builds, native failure/unavailability, benchmarks and the existing isolated demo checks. See [prototype evidence](GPU-RENDERER-PROTOTYPE.md). | Keep the development flag. Repeat these checks on each changed renderer candidate. Record source SHA, viewport, actual adapter/limits, CPU preparation/submission, completion observations and drawing differences before interpreting speed. |
| 3. Remaining 2D/reliability | Partly complete: PR #11's pinned `3ce7e10a` batch is integrated in draft PR #12, with seven real Windows batch checks and exact source CI passed. PR #11 later advanced to unmerged/conflicted `878655e2`; the [remaining checklist](REMAINING-2D-CHECKLIST.md) stays open with its owners. [PR #9](https://github.com/habit04/share/pull/9) passed exact source CI at `14cb3f9f` and was merged by another task as stable `8dfe1caa`; v0.4.9 has public Windows release assets. Neither later head is integrated into this GPU candidate. | Each remaining fix needs regression and relevant import-edit-save-reopen evidence. Review the new stable transaction/codec baseline and test its combination with the GPU candidate. Release metadata does not prove installation or native preservation in this candidate. Coordinate the active PR #11 owner before integration. |
| 4. Production GPU renderer | Incomplete. Clean `fd7fac07` passed bounded zoom reuse; `fe653933` passed eligible line subrange edits, all eight retained trajectories, edited/undo/redo image proof and native recovery/unavailability on both tested adapters. Dense edit/undo dropped to 24.5/25.1 ms medians with 37.4/44.3 ms peaks; sustained-zoom boundaries still peak at 84.4/86.8 ms. Item 4 continues with lower full preparation costs and incremental block/text, dimensions and common hatches. New stable-baseline compatibility is under isolated review; broader hardware remains open. | Pass every production gate below before considering a default change. Canvas stays default; no general performance or untested hardware claim. |
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

The historical pan-cache implementation rebuilt on every zoom. The later bounded
zoom milestone below separates world-space centerlines from fixed CSS-pixel
extrusion and constrains reuse by curve and floating-point error budgets.
Zero uploads, geometric coverage, fallback and recovery remain correctness gates;
representative workflow responsiveness is a separate production gate.

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
results. Both ordinary and experimental integration builds passed. The later
`4bad60b2` source's cached native probes, unavailable-context test, paired
benchmarks and exact-head CI passed, as recorded below.

PR #9 remains an owner-managed dependency. The historical head `b3ddf85a`
[PR CI failed](https://github.com/habit04/share/actions/runs/38347152610) and
[push CI failed](https://github.com/habit04/share/actions/runs/38347148163) in unit,
UI and Windows Electron checks. Its successful installer workflow ran only the
signed portable-helper job; application build, smoke, artifact verification and
release jobs were skipped. At the later head `3766b8af`,
[PR CI](https://github.com/habit04/share/actions/runs/38356454447),
[push CI](https://github.com/habit04/share/actions/runs/38356450414), and
[installer test build](https://github.com/habit04/share/actions/runs/38356468654)
failed at that historical source. The installer workflow passed its two source-check jobs but failed the
Windows test-build job; build, artifact verification, packaged smoke and release
were skipped. A later read-only snapshot at 10:49 UTC found final PR #9 head
`14cb3f9fac2be802004dd3e3b23c9e7aec1f81aa` with successful
[PR CI](https://github.com/habit04/share/actions/runs/38366814199) and
[push CI](https://github.com/habit04/share/actions/runs/38366809625).
Another task merged it at 08:18:29 UTC as stable `8dfe1caa9a3b72c87438e8ec5acb995bf62f388c`.
[v0.4.9](https://github.com/habit04/share/releases/tag/v0.4.9) was published at
08:46:09 UTC with Windows installer, blockmap and provenance/checksum assets.
This renderer task did not merge or release. Public release metadata alone is
not installation or combined GPU/native preservation evidence. PR #11's latest
`878655e2fdab2c7cb39c8adc3acf7330ea3e2ba2` remains unmerged with conflicts.
The GPU candidate deliberately retains the tested `3ce7e10a`/pre-merge baseline.
PR #9 and PR #11 share 14 files, including the same
`Drawing.transact` hunk. A later integration must preserve PR #9 graph validation,
reconciliation and edit-intent forwarding through both PR #11 transaction scopes
(`commitTransition`/`transactDrawing`). Require owner-completed native repairs,
deliberate codec/transaction review and fresh combined tests for clips, dimension
overrides through DWG, saving/backups/recovery and both build modes. Keep DWG clip
refusal until native pointer ownership is independently proven. The owner's
reported six generated save inputs and independent postflight do not replace
successful combined CI, packaged save/backup/reopen or a fresh Windows installer
check without AutoCAD installed; those remain separate gates.

### Combined cached-recovery and performance baseline

Clean source `4bad60b2f2fac8c2676d704f2f07f45d1076b431` passed 2,514 regression
tests with 27 conditional skips, all three typecheck targets, lint, fixtures,
workflow checks and both builds. Real ordinary-build default Canvas/LINE/no
prototype controls, diagnostics/clipboard/report and all seven native 2D batch
checks passed. Its exact-head [PR CI](https://github.com/habit04/share/actions/runs/38350338690)
passed all five jobs. CI now exercises the larger `--cached-scene` native fixture
on future candidates.

The detached Canvas scene cache now owns loss/restoration listeners. A lost
bitmap is retired immediately and cannot be copied into the main view. The 14
viewport regressions cover independently lost caches, stale callbacks, latest
document/view/overlay, replacement ownership, copy failures and disposal.

Both native probes warmed and proved real reuse of a 254-entity bitmap before
terminating only the GPU child identified twice by the private app's PID and
creation time. Actual WebGL strings before and after replacement established
Intel UHD `0x4688`/driver `32.0.101.7088` and NVIDIA RTX A3000
`0x24b9`/driver `32.0.15.9671`, respectively. Both main and cache contexts lost;
the retired cache was discarded, a healthy current replacement appeared, and
complete Canvas repaint preceded WebGL restoration. On Intel, automatic repaint
was observed at 1,642.5 ms vs WebGL restoration at 2,123.2 ms; on NVIDIA, 1,773.4
vs 2,239.5 ms. These times are relative to the probe's observation clock and
include process/driver recovery. They do not claim uninterrupted rendering or
native cache-only loss coverage. Both pixelmatch difference and bidirectional
two-pixel miss were zero; raw channel differences were 213 and 205. LINE and
private 255-entity DXF save/reopen passed. Evidence:
[Intel](benchmarks/windows-gpu-integration-intel-process.json) and
[NVIDIA](benchmarks/windows-gpu-integration-nvidia-process.json).

The unavailable-context probe observed actual null WebGL/WebGL2 contexts. Small
and 6,500-entity mixed drawings fell back to complete Canvas with every channel
equal; LINE and private 6,501-entity DXF save/reopen passed. See
[unavailable evidence](benchmarks/windows-gpu-integration-unavailable.json).

The baseline benchmarks ran sequentially with our own tests/builds paused on
Windows kernel `10.0.26200`, Electron `44.7.0` / Chromium `152.0.7977.130`,
1216 x 552 CSS pixels, DPR 1. Other user/system activity and OS caches remained
uncontrolled. The old harness's first render was already warmed by `setMode`;
it must not be interpreted as cold preparation or upload evidence.

| Dense 38,000-wire workload, 30 moving frames | Intel Canvas | Intel GPU | NVIDIA Canvas | NVIDIA GPU |
| --- | ---: | ---: | ---: | ---: |
| Pan: render plus completion median | 49.6 ms | 11.1 ms | 58.8 ms | 6.8 ms |
| Combined pan/zoom: render plus completion median | 51.9 ms | 78.7 ms | 63.4 ms | 81.0 ms |

GPU pan CPU submission was 0.6 ms on both adapters, with zero uploads in all 30
pan samples. Curves/precision pixelmatch differences were 0.006%, dense geometry
3.335%, and mixed fallback exactly zero; all centered/panned two-pixel coverage
misses were zero. Selection/grips, two real WebGL context cycles, existing demo
checks and resource disposal passed. See [Intel benchmark](benchmarks/windows-gpu-integration-intel-comparison.json)
and [NVIDIA benchmark](benchmarks/windows-gpu-integration-nvidia-comparison.json).
Fence observations and Canvas flushes are wall measurements, not pure GPU time
or desktop presentation. These establish a baseline to improve zoom, not a
general speed gain or production completion.

### Bounded zoom and separate frame-stage milestone

Clean producer `fd7fac0723a1b7934f08356f21494da29318eac4` keeps anchor-relative
centerlines and fixed CSS-pixel stroke extrusion separately. Geometry is retained
inside a conservatively clipped 128-physical-pixel pan border and an initial
0.8–1.25 zoom interval, narrowed where curve correctness requires it. Double
subtraction precedes float storage and shader transforms. Curve and floating-point
budgets together remain at most a quarter physical pixel. Source bounds include
offscreen geometry; immutable document/style/overlay changes invalidate reuse.

The stricter retained-frame comparison found a real wide-circle discrepancy:
overlapping GPU strips filled a hole retained by Canvas. The scene was preserved
as `wide-curve-fallback`, and unsafe circle/arc/bulge widths now refuse the entire
GPU view before drawing. Supported curves near this limit narrow their zoom
interval. Canvas and its accuracy gates were unchanged.

Local validation passed **2,548 tests with 27 conditional skips**, including 104
focused GPU tests; all three typechecks, lint, fixtures, eight workflow checks and
both builds passed. Real ordinary-build Canvas/LINE/no prototype UI, diagnostics
copy/report and all seven Windows 2D batch checks passed. The strict paired
benchmarks, cached native GPU-process probes and unavailable-context check passed.
The exact renderer source passed all five jobs in the push and PR CI linked above.

Both benchmarks ran sequentially on Delly, Windows kernel `10.0.26200`, Electron
`44.7.0` / Chromium `152.0.7977.130`, 1216 × 552 CSS pixels, DPR 1. Actual WebGL
strings and diagnostics established Intel UHD `0x4688`, driver `32.0.101.7088`,
and NVIDIA RTX A3000 12 GB `0x24b9`, driver `32.0.15.9671`; requested preference
alone was not adapter evidence. Both reported 16,384 maximum texture size and
32,767 × 32,767 maximum viewport dimensions. These are two adapter/driver samples
on one host; other activity and OS caches were not controlled.

| Dense 38,000-wire workload, 30 frames: completed workflow median / p95 / maximum | Intel Canvas | Intel GPU | NVIDIA Canvas | NVIDIA GPU |
| --- | ---: | ---: | ---: | ---: |
| Combined pan/zoom | 56.3 / 67.8 / 69.3 ms | 11.8 / 16.2 / 21.4 ms | 57.1 / 67.5 / 68.7 ms | 7.7 / 8.5 / 12.7 ms |
| Bounded zoom | 65.6 / 88.6 / 96.7 ms | 12.6 / 26.9 / 31.4 ms | 51.4 / 60.3 / 61.8 ms | 7.3 / 8.3 / 8.3 ms |
| Sustained zoom across cache boundaries | 50.8 / 61.8 / 69.2 ms | 12.1 / 94.7 / 95.0 ms | 53.7 / 65.7 / 68.1 ms | 9.0 / 94.1 / 105.2 ms |
| Maximum-band zoom plus edge pan | 54.1 / 74.7 / 75.6 ms | 11.6 / 15.3 / 24.4 ms | 57.8 / 68.8 / 71.9 ms | 7.8 / 12.3 / 16.4 ms |
| Visible edit/undo, including document mutation | 66.1 / 75.0 / 76.8 ms | 97.3 / 115.4 / 127.2 ms | 72.0 / 85.3 / 89.8 ms | 98.4 / 129.8 / 132.5 ms |

Warm bounded zoom performed **zero geometry preparation, upload calls and upload
bytes** on all 30 samples. GPU draw submission medians were 1.1 ms on Intel and
0.5 ms on NVIDIA. Edits rebuilt every sample: geometry preparation medians were
65.5 / 66.1 ms, upload issuance medians 1.3 / 1.3 ms, with 6,384,000 bytes each;
document mutation medians were 12.8 / 13.3 ms. The actual mode-triggered first
frame prepared geometry in 79.1 / 100.3 ms, issued uploads in 5.3 / 5.6 ms, and
completed its workflow in 95.2 / 132.0 ms. Resource initialization, cache lookup,
draw submission and queue delay are recorded separately in the raw evidence.
Upload issuance measures CPU calls, not completed transfer. Frame completion uses
mandatory successful fences for GPU frames and Canvas readback for Canvas frames;
these wall observations do not measure pure GPU time or desktop presentation.

All eight workloads checked renderer identity and frame timing. Five supported
zoom trajectories compared the actual retained GPU endpoint before camera reset,
including both band edges and off-center zoom. Supported small scenes
passed the stricter pixelmatch difference below 0.1% and bidirectional two-pixel
foreground miss below 0.5%, including fixed lineweights, twist and coordinates
near `10^12`. Dense raster differences were 3.336% / 3.335%, with geometric
coverage passing; this does not claim raster parity. Both unsupported scenes
used complete Canvas on every frame and matched exact RGBA at every endpoint.
Warm zoom followed by context loss/restoration, repeated restoration, selection,
the existing isolated demo and disposal also passed.

Current-source native probes proved reuse of the warmed 254-entity Canvas bitmap,
then safely terminated only the private app's verified GPU child. Main and saved
cache contexts lost; a healthy current cache and complete Canvas repaint appeared
before WebGL restoration. LINE and 255-entity DXF save/reopen passed on both
adapters. Actual unavailable WebGL/WebGL2 contexts retained exact complete Canvas
for small and 6,500-entity scenes, with 6,501-entity save/reopen passing. Native
cache-only loss, real driver resets and persistent failure remain untested.

Public producer evidence, with private host paths removed:
[Intel benchmark](benchmarks/windows-gpu-zoom-intel.json),
[NVIDIA benchmark](benchmarks/windows-gpu-zoom-nvidia.json),
[Intel native recovery](benchmarks/windows-gpu-zoom-intel-process.json),
[NVIDIA native recovery](benchmarks/windows-gpu-zoom-nvidia-process.json), and
[unavailable context](benchmarks/windows-gpu-zoom-unavailable.json).

This milestone demonstrates useful dense pan/zoom improvement in these samples.
Small Canvas scenes remain faster in some workloads. Boundary rebuild peaks of
95–105 ms and edit peaks of 127–133 ms remain unacceptable production concerns.
The next item-4 gates are reduced edit preparation/uploads and boundary stalls,
followed by incremental blocks with text/attributes, dimensions and common
hatches, with full-view fallback wherever correctness is not established.
Canvas remains the default and stage 4 remains incomplete.

### Immutable line edit and upload milestone

Clean producer `fe653933be2bb2a359145efe01648111fc88c21f` admits one changed
immutable LINE at the same ordered slot, with unchanged style, vertex count,
dependencies and camera envelope. It prepares at the original copied anchor,
rechecks every current source bound, and updates only that slot. Other edits
prepare the complete scene or refuse to complete-view Canvas. Offscreen zero-vertex
entries remain in the precision certificates. CPU and uploaded generations are
separate: a failed partial upload or draw cannot certify the buffer, and the next
attempt repairs the complete current CPU image. Owned undo geometry is bounded
to 1 MiB and 256 entries and clears on dependency/anchor changes, loss and disposal.

This source passed **2,583 regression tests with 27 conditional skips**, 208 focused
GPU tests, all three typechecks, lint, fixtures/workflows, both builds and real
ordinary Windows default/LINE/diagnostics/clipboard/report and seven 2D checks.
Both strict adapter benchmarks passed, followed by both cached native GPU-process
recovery probes and the unavailable-context probe. Fresh source-specific CI is
required for the published candidate; no merge or default switch is authorized.

The same host/runtime, viewport and actual Intel/NVIDIA adapter proof described
above were recorded anew. Our tests/builds were paused during sequential benchmark
measurements; external user activity and OS caches remained uncontrolled.

| Dense 38,000-wire workload, 30 alternating visible edit/undo frames: median / p95 / maximum | Intel | NVIDIA |
| --- | ---: | ---: |
| Canvas completed workflow | 65.1 / 72.7 / 80.6 ms | 66.6 / 74.7 / 85.8 ms |
| GPU completed workflow | 24.5 / 35.2 / 37.4 ms | 25.1 / 40.6 / 44.3 ms |
| GPU cache/dependency/bounds validation and CPU-image update | 3.1 / 4.3 / 5.3 ms | 3.2 / 6.0 / 6.7 ms |
| GPU upload issuance/checking | 0.3 / 0.6 / 1.1 ms | 0.3 / 0.5 / 1.3 ms |
| GPU draw submission | 0.3 / 0.5 / 0.6 ms | 0.4 / 0.7 / 0.9 ms |
| Document mutation | 12.1 / 14.0 / 14.4 ms | 12.7 / 16.3 / 18.4 ms |

Every successful edit/undo frame issued exactly one **168-byte** subrange upload,
instead of the 6,384,000-byte scene. There were no full preparation or full upload
frames in this workload. Geometry-generation medians were zero at the clock's
resolution; NVIDIA's maximum was 0.1 ms. This workload alternates two versions,
so most transitions reuse owned history; it does not prove zero preparation for
arbitrary new geometry or count/style-changing edits. Undo samples explicitly
reported memo reuse and zero prepared entities. These remain CPU issuance and
completed-workflow wall observations, not transfer time, pure GPU time or display
presentation. Small Canvas scenes remained faster in some workloads.

The harness now compares all **eight supported retained trajectory endpoints**,
as well as all eight exact-RGBA fallback endpoints. A separate untimed check proves
that the edited image differs from its baseline before undo, then compares that
actual warm-cache GPU frame with current Canvas at a twisted/panned/zoomed pose.
Undo and redo restore their images exactly; documents restore exactly. This
includes representable edits near `10^12` and fixed lineweights. Existing strict
raster/coverage thresholds, wide-curve complete fallback, repeated context
restoration, selection, disposal and the pre-existing isolated demo all passed.
The earlier `fd7fac07` result still covered only five supported zoom endpoints;
this later coverage does not retroactively change its evidence.

Native probes again proved real warmed 254-entity Canvas-cache reuse, automatic
complete Canvas recovery before WebGL restoration, unchanged drawing state and
255-entity DXF save/reopen on both adapters. Actual null contexts retained exact
Canvas and 6,501-entity save/reopen. These probe scenes are not a claim of native
process loss during an active partial upload; that interruption is covered by
buffer-shadow/context-loss regressions. Native cache-only loss, driver resets,
persistent failures and additional adapters remain untested.

Evidence: [Intel](benchmarks/windows-gpu-edit-intel.json),
[NVIDIA](benchmarks/windows-gpu-edit-nvidia.json),
[Intel native recovery](benchmarks/windows-gpu-edit-intel-process.json),
[NVIDIA native recovery](benchmarks/windows-gpu-edit-nvidia-process.json), and
[unavailable context](benchmarks/windows-gpu-edit-unavailable.json).
Benchmark JSON is losslessly compact to reduce repository size; private host
paths were removed and numeric measurements retained.

Dense sustained-zoom boundary peaks remain 84.4 ms on Intel and 86.8 ms on NVIDIA.
The next measured gate reduces full straight-line preparation allocations while
preserving the same zoom interval, geometry bytes and correctness constraints.
Block/text integration and standalone dimension/hatch lowering have focused test
evidence but no native acceptance yet. The new stable transaction/codec baseline
is under isolated review; safe DWG-clip refusal remains in place. Stage 4 remains
incomplete, and Canvas remains default.

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

1. **Correct 2D baseline:** the pinned PR #10/PR #11 combination passed locally
   and in exact source CI; complete the remaining owned checklist. Review the
   now-merged PR #9 transaction/codec baseline and its native preservation evidence
   before preparing a fresh combined candidate; coordinate PR #11's active owner.
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
   failures and more runtimes still require evidence. The 254-entity cached native
   scene passed on both adapters in combined source `4bad60b2`; native cache-only
   loss remains unobserved, while selective cache loss is covered by regressions.
   Forced WebGL loss and mocks alone do not prove these cases. A failed graphics
   path must return to usable Canvas without changing drawings.
6. **Integration evidence:** full regressions, both builds, Windows interaction,
   save/reopen and exact-commit CI must pass on the final integrated candidate.
   Ordinary/experimental integration checks and exact source CI passed at
   `4bad60b2`; repeat them for each new renderer candidate. Obtain separate approval before
   switching the default, merging or deploying.

## Publication boundaries

The existing CI workflow runs on all branch pushes and pull requests. Pages runs
on the stable default branch; installer publication runs on `v*` tags or explicit
manual release dispatch. This feature branch changes only development CI and does
not alter release or Pages triggers. Do not create release tags or dispatch a
publishing workflow as part of these milestones.
