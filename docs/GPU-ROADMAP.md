# JCad GPU and 3D roadmap

Evidence snapshot: October 13, 2026. This isolated development branch,
`feature/windows-gpu-compound-coverage`, extends the published
[draft PR #15](https://github.com/habit04/share/pull/15) candidate `47625347`.
Its direct-LINE preparation producer is `72d70630`; all five jobs passed in
[push CI](https://github.com/habit04/share/actions/runs/38394823874) and
[PR CI](https://github.com/habit04/share/actions/runs/38394973565).
PR #15 extends [draft PR #14](https://github.com/habit04/share/pull/14),
whose measured edit producer is `fe653933`. PR #14 extends
[draft PR #13](https://github.com/habit04/share/pull/13),
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
| 3. Remaining 2D/reliability | Partly complete: PR #11's pinned `3ce7e10a` batch is integrated in draft PR #12, with seven real Windows batch checks and exact source CI passed. At the October 13, 19:18 UTC read, active draft PR #11 was unmerged/conflicted at `eb692896`; the [remaining checklist](REMAINING-2D-CHECKLIST.md) stays with its owners. [PR #9](https://github.com/habit04/share/pull/9) passed exact source CI at `14cb3f9f` and was merged by another task as stable `8dfe1caa`; v0.4.9 has public Windows release assets. Stable `8dfe1caa` is integrated in this isolated candidate alongside the pinned batch. Clean `455b2662` passed the combined regression suite and all seven real Windows 2D batch checks; clean repair `344ec1a1` also passed all seven native batch checks. The later active PR #11 head is not integrated. | Each remaining fix needs regression and relevant import-edit-save-reopen evidence. Require exact-head CI and source-specific native checks for each new combination. Release metadata does not prove installation. Coordinate the active PR #11 owner before integrating unfinished font/project/dimension work. |
| 4. Production GPU renderer | Incomplete. Clean `fd7fac07` passed bounded zoom reuse; `fe653933` passed eligible line subrange edits. PR #15's clean `72d70630` reduced full LINE preparation with accepted source-specific native evidence. Draft [PR #16](https://github.com/habit04/share/pull/16) adds bounded fourfold reuse for certified straight block/TEXT/ATTRIB scenes, native Float32 construction refusals and corrected fractional backing mapping. Clean `344ec1a1` passed the local/native repair gates described below. Clean `604a7ccf` passed 3,422 tests (28 conditional skips) and five native preflight checks, but both exact-head CI runs and the complete Intel benchmark failed at dense Canvas-fallback undo. Native cross-state drift remains inconclusive. The next direct-LINE fourfold certificate and fallback-reference repair have focused source checks only; clean-producer validation, native performance and replacement CI are pending. Dimensions and common hatches remain isolated until this checkpoint passes. | Pass every production gate below before considering a default change. Canvas stays default; no general performance or untested hardware claim. Record geometry preparation, upload issuance and completed-frame observations separately, and supplement repeated-readback comparisons with ordinary frame-cadence measurements. |
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

### Direct straight-line preparation milestone

Clean producer `72d7063011070ced3c65712b5c43d93bce88986c` packs all-visible-LINE
scenes directly into bounded owned Float32 storage, growing only when geometry
is emitted and returning exactly the used bytes. It preserves the original double
projection order, clipping, normals, source bounds, fixed lineweights, painter
order and edit certificates. Mixed/curved preparation and the **same 0.8–1.25 zoom
envelope** remain unchanged. Boundaries still rebuild at frames 11 and 23; this
reduces their cost rather than hiding them behind a larger interval.

Passed: **2,596 regression tests, 27 conditional skips**, 221 focused GPU tests,
all three typechecks, lint, fixture/workflow checks and both builds. Ordinary
Windows default/LINE/diagnostics and seven 2D checks passed. Both strict actual
adapter benchmarks and all three native failure/unavailability checks passed.
The following samples retain the same host/runtime/viewport and limitations above.

| Dense sustained zoom across boundaries, 30 frames: median / p95 / maximum | Intel Canvas | Intel GPU | NVIDIA Canvas | NVIDIA GPU |
| --- | ---: | ---: | ---: | ---: |
| Completed workflow | 49.0 / 60.6 / 61.9 ms | 12.4 / 47.6 / 53.6 ms | 44.9 / 57.1 / 60.1 ms | 7.9 / 45.5 / 48.3 ms |

The two observed rebuilds had geometry-preparation maxima of 39.4 / 39.2 ms,
upload-issuance maxima of 1.2 / 1.2 ms and draw-submission maxima of 2.0 / 1.6 ms.
Mode-triggered first frames prepared in 44.7 / 39.7 ms and issued uploads in
5.1 / 5.5 ms, with completed workflows of 61.1 / 61.5 ms. Warm bounded zoom still
prepared and uploaded nothing. Dense edit/undo medians were 24.1 / 23.3 ms with
35.4 / 36.9 ms maxima; each used one 168-byte subrange. Small Canvas scenes still
won some workloads. NVIDIA off-center zoom had an isolated 51.7 ms maximum despite
no preparation/upload; driver/CPU scheduling remains visible in wall timing.

Independent generic-byte comparisons and strict native images preserved clipping,
lineweights, twist, representable `10^12` coordinates, all eight retained
trajectories and edited-before-undo/undo/redo correctness. Both fallback scenes
matched exact RGBA. Warm-zoom/repeated context restoration, native warmed-cache
loss/replacement before WebGL restoration and DXF save/reopen passed. This is not
native cache-only loss, driver-reset or persistent-failure coverage.

Source-specific evidence: [Intel](benchmarks/windows-gpu-preparation-intel.json),
[NVIDIA](benchmarks/windows-gpu-preparation-nvidia.json),
[Intel recovery](benchmarks/windows-gpu-preparation-intel-process.json),
[NVIDIA recovery](benchmarks/windows-gpu-preparation-nvidia-process.json), and
[unavailable device](benchmarks/windows-gpu-preparation-unavailable.json).
Published evidence head `47625347` passed all five jobs in its exact-head push
and PR CI, linked above. These completed-frame observations include repeated
Canvas readback; readback can change a Canvas context's acceleration behavior.
They retain their measured values and do not establish ordinary desktop frame
cadence. The next candidate adds a separate pan/zoom/edit pass without per-frame
Canvas readback. Remaining first-frame and boundary work stays explicit.
Block/text native acceptance, wired dimension/hatch coverage, final combined
stable-baseline validation and wider hardware/failure coverage remain open.
Canvas stays default and stage 4 is incomplete.

### Block, attribute and stroke-TEXT milestone in progress

Clean source `455b2662d64155e6205cd5f88f136269c809a241` combines the reviewed
stable `8dfe1caa` transaction/codec baseline, pinned `3ce7e10a` 2D batch and
published PR #15 preparation changes. It passed 3,081 regressions with 28
conditional skips, all three typechecks, full lint, fixture/workflow checks,
ordinary/experimental builds, ordinary default/diagnostics checks and all seven
real Windows 2D batch checks. The initial sandbox-only run's 11 junction-permission
failures were archived; the approved full run passed. These are historical checks
for that source, not acceptance of subsequent changes.

The new native benchmark is **not accepted**. Its first ARC full-circle preflight
passed actual native Canvas command/cardinal coverage and the unchanged strict
raster gate. An exact-RGBA fallback check then failed. A separate private repro
showed the same 2,142-pixel difference (maximum channel difference 53) during a
Canvas-to-Canvas redraw before any GPU attempt; subsequent Canvas redraws and
requested-GPU fallbacks were raw-identical. This demonstrates a Canvas-reference
stability issue; it does not prove a particular acceleration-backend transition.
The next harness must record bounded Canvas self-consistency checks before using
that reference, while keeping exact fallback and geometric coverage gates.

A source/math audit also found short block-POLYLINE and narrow TEXT/ATTRIB cases
where native world construction collapses a segment but rebased GPU construction
retains a visible miter. Position error alone does not bound stroke normals or
join branches. Native world stroke parity must fit the existing construction
reserve, with complete-view Canvas refusal where it cannot be proved. Dedicated
native counterexamples, selected/hovered opacity probes, visibly distinct native
attribute placement overrides and actual save/reopen checks remain required.

The historical mixed schematic keeps its original tiny circle and uses Canvas at
its fitted zoom. A distinct admitted compound stress input supplies readable text
and straight symbol geometry; it must not replace or relabel the original input.
Compound edits currently prepare/upload the full scene. Their latency, along with
preparation, upload issuance, fence/readback completion and the separate ordinary
frame-cadence supplement, must be reported before any performance acceptance.
Dimension and hatch modules have separate focused-test evidence and are undergoing
incremental integration; they are not admitted by this recorded source.

The subsequent clean `2006caf44838d231f3d477d0b8e347192b2f9500` candidate
passed 3,110 regressions with 28 conditional skips, all nine local validation jobs,
ordinary default/diagnostics checks and all seven native 2D batch checks. Its
benchmark failed during the fresh-profile phase before any drawing readback:
the preserved 6,500-entity long-label compound drawing exceeded the unchanged
1,000,000-vertex cap. Geometry preparation took 238.5 ms before complete Canvas
fallback; upload calls and bytes were zero. This is an explicit failed result,
not a performance acceptance or a completed-frame measurement.

The next candidate counts retained straight-stroke vertices with the same clipping
and join decisions before allocating the oversized vertex array. Its benefit and
admitted-scene overhead require fresh native measurements. The original
`compound-dense` keeps all 500 `LABEL i MOTOR STARTER` strings (11,390 characters).
A separately named `compound-tags` drawing keeps the same 5,000 wires, 1,000
four-line symbols, 1,000 attributes and 500 readable labels, but uses `T0` through
`T499` (1,890 characters). Results must name the input and actual renderer at each
pose; clipping can change vertex-budget admission. Refused GPU preparation remains
separate from successful uploads and GPU completion. Neither drawing substitutes
for the original mixed schematic.

Clean `10ddc8a9084aa031c447fb4d87b1fee56157e0d9` subsequently passed 3,120
regressions with 28 conditional skips, all nine local checks and the ordinary
native checks. Its fresh no-readback cadence phase passed for dense LINEs,
short-tag compounds and the preserved long-label budget fallback. The complete
benchmark still failed: the original curved-POLYLINE fixture contains a sharp
arc-to-LINE join that the new construction guard deliberately refuses. A bounded
math check found 0.271 physical pixels of selected-miter error at that view,
exceeding the quarter-pixel limit. Original fixture data must stay intact with
complete Canvas fallback; distinct isolated-bulge controls will exercise GPU
selection and recovery. This is a coverage restriction, not a completed GPU fix.

The partial Intel cadence data exposed another failed performance gate:
short-tag compound edit/undo prepared geometry in 181.2 ms median and 199.7 ms
maximum, with 4.6 ms median uploads; consecutive rAF intervals had a 200 ms
median. Sustained-zoom preparation peaked at 197.3 ms. Long-label fallback
camera retries still spent roughly 105--114 ms median in geometry before Canvas.
These results are from a failed overall benchmark and do not establish accepted
speed gains. The next candidate has typed packing, certified top-level LINE
subrange edits and explicit idle admission retry after a slow budget refusal.
Its geometry checks passed 105 focused tests; renderer, refusal, compound-delta
and idle-policy checks passed 273 tests. TypeScript, scoped lint, whitespace and
independent source review passed. These are local source checks before a fresh
clean producer; native performance is still unmeasured.

The policy follows a sealed, deliberate vertex-budget refusal whose geometry
preparation exceeds 50 ms. Healthy uploaded geometry, eligible LINE deltas and
exact-view refusal reuse take priority. Otherwise a new interaction pose draws
the complete current Canvas view with zero preparation/uploads and schedules one
fresh admission after 100 ms without another renderer call. Continued calls reset
that idle deadline. Mode changes, disposal, context transitions, mutable inputs
and unrelated failures cancel the policy. A deferred frame is labelled as such;
it does not certify that the present drawing/view is over budget. Idle retry can
admit a newly clipped pose, so the budget fixture's moving samples and endpoints
must report the actual renderer separately. Correctness endpoints force actual
admission and retain exact Canvas pixels or the existing admitted-GPU coverage
gate. Fresh full-suite, paired native and exact-commit CI gates remain open.

### Block and stroke-text checkpoint: native gates still open

Clean source `9df70df05cb7f2f473f1d989d3535659160e6a45` passed all nine local
checks: 3,190 regressions with 28 conditional skips, the three TypeScript
projects, full lint, fixture/workflow verification and both builds. Ordinary
Windows default-renderer, diagnostics and seven real 2D batch checks also passed.
The Intel native benchmark failed an untimed edit-visibility assertion in the
preserved long-label `compound-dense` input. Archived raw captures show the same
24 changed RGBA pixels in Canvas and complete-view GPU fallback; later text
overdraws the midpoint-visible line. The visual threshold was not relaxed.
Candidate selection must prove a visible edit before this benchmark can pass.

The exact selected sharp arc-to-LINE case was tested first on Intel UHD Graphics
(`0x4688`, driver `32.0.101.7088`), Electron `44.7.0` / Chromium
`152.0.7977.130`, DPR 1, width 2.5 and miter limit 10. At camera center
`(3.5, 2.5)`, scale `95.17241379310344`, unchanged source points
`(0,4), (1,5), (2,4)` and bulges `[0.5,0]`, the unproved native curved join
required complete-view Canvas. It uploaded zero bytes and produced exactly the
reference RGBA image. This safely closes that refusal case on this sample; it
does not claim a corrected GPU join or relax the 0.25 physical-pixel limit.

The failed run's fresh, readback-free Intel phase provides diagnostic observations,
not accepted milestone performance. Short-tag compounds recorded 1.1 ms median
GPU CPU work for pan and bounded zoom, with zero geometry preparation/uploads,
versus Canvas 18.6 / 17.2 ms. A top-level LINE edit used 168-byte subrange uploads,
at most 0.2 ms partial geometry, and 10.6 ms median workflow CPU versus Canvas
22.7 ms. Sustained zoom still reached 155 ms geometry preparation, 10.8 ms upload
issuance and 172.1 ms workflow CPU at an envelope boundary; the maximum consecutive
rAF interval was 166.7 ms. This redraw-delay gate remains open. Complete long-label
Canvas fallback avoided repeated preparation during those moving samples.

NVIDIA and new-source cached-process recovery/unavailability have not run for
this checkpoint. Published evidence head `a2eac656` subsequently failed exact CI:
the [push run](https://github.com/habit04/share/actions/runs/38436234354) passed
UI and Windows E2E but failed Node22, Node24 and GPU; the
[PR run](https://github.com/habit04/share/actions/runs/38436377594) passed UI,
Windows E2E and Node24 but failed Node22 and GPU. GPU failed the same dense
edit-visibility assertion. Node failures were 5-second reopened DWG retained-graph
clip save/export lifecycle timeouts; the active 2D owner has been notified.
No timeout or correctness threshold has been relaxed. Native timing and
correctness must be repeated for the next clean producer after these issues
are resolved.

Two additional Intel native audits used the unchanged compiled `9df70df0`
assets, with current working source explicitly labelled modified. Asset hashes
matched the successful clean-source build before and after each private process.
These are correctness observations, not performance measurements:

* At an exact 8192 x 800 backing viewport, scale 1 and DPR 1, an open bulge with
  points `(0.00015,0), (2000.00035,0)` and bulge 1 makes Canvas insert a float
  connector. At width 16, Canvas paints an 8 x 8 region above the ideal butt cap;
  the independent Canvas ARC without initial move and GPU each omit it.
  Repeated Canvas RGBA is exact. The larger 10000 x 4000 request safely refuses
  when the actual GPU drawing buffer cannot match it.
* At the ordinary 1216 x 552 viewport, scale 10 and DPR 1, an unbulged POLYLINE
  with points `(-0.000001,0), (0,0), (0,10)` has its first native float segment
  collapse. At width 16, GPU adds an 8 x 8 region below the cap; Canvas exactly
  matches the independent vertical LINE and repeated Canvas RGBA. A separate
  width-2.5 capture was not self-consistent and remains inconclusive.

See the [failed performance observations](benchmarks/windows-gpu-compound-9df-intel-failed.json),
[open-bulge audit](benchmarks/windows-gpu-9df-open-bulge-intel-audit.json) and
[straight-collapse audit](benchmarks/windows-gpu-9df-straight-collapse-intel-audit.json).
The audit-wide outcome remains inconclusive because some smaller-width or larger
allocation cases were unstable or blocked; the specific stable width-16 defects
above are confirmed independently. No aggregate audit pass is claimed.

Both width-16 defects exceed the unchanged quarter-pixel limit. Bulged POLYLINE
topology must use complete-view Canvas until it is proved. Straight-path
certification must include native Float32 point/direction/join effects in the
existing 0.0625 construction reserve, before admitting or reusing a mesh. Direct
ARC/CIRCLE controls remain distinct. These gates block compound milestone
acceptance and any production/default change, even if ordinary CI passes.

A third Intel audit on the same unchanged compiled `9df70df0` assets confirmed
a [fractional-DPR mapping defect](benchmarks/windows-gpu-9df-fractional-dpr-intel-audit.json). With logical CSS size 1218 x 551, synthetic
DPR 1.25 and actual backing 1523 x 689, stable width-2.5 and width-16 strokes
were displaced by 0.5 physical pixels relative to Canvas. Synthetic DPR 1.2
(native Float32 coefficient 1.2000000476837158, backing 1462 x 661) displaced
the same cases by about 0.40 pixels. Canvas matched an independent physical
reference exactly. Width-1 repeat instability remains inconclusive. The actual
window DPR was 1; these synthetic viewport tests do not claim Windows scale
or multi-monitor coverage.

The same audit found incomplete Canvas background coverage at the rounded
backing edge: at DPR 1.25, final-column alpha accumulated 128, 192, 224, 240,
248 across redraws, while GPU clear stayed opaque. This blocks full-view parity.
The follow-up must use the native DPR coefficient and actual backing dimensions
for GPU mapping, paint/clear the complete physical Canvas backing, and copy
cached backing bitmaps without resampling. Source tests alone do not complete
these native raster gates. Canvas remains the default throughout.

The isolated repair candidate now includes those physical-backing changes,
complete-view refusal for unproved bulged-polylines/native float topology,
and an optional fourfold zoom-in cache interval for fully straight immutable
compiled scenes. Every original point, native construction reserve, QTEXT
transition and shader envelope is checked before that interval is retained;
curves keep the ordinary interval. LINE edits certify the stored interval.
The benchmark preserves original drawings and poses, selecting one deterministic
visible LINE before timing and proving the same edit independently afterward.
Full checks, native raster/performance, recovery and replacement exact-head CI
remain pending for this candidate.

The old CI clip cases passed individually on Delly at about 2.24 and 2.35
seconds, versus about 6 seconds in the failed runner samples. This is evidence
of load sensitivity, not proof that the CI failure is resolved. Replacement
Node CI bounds the test pool to two workers while preserving all cases and
the existing 5-second budgets. The standalone edit-selector checks also run
before the GPU benchmark. Both changes still require replacement exact-head CI.

The straight construction bounds target the pinned experimental
Electron 44.7/Chromium 152/Skia path and assume its IEEE arithmetic. Actual binary
lowering, rounding modes and every native CPU/GPU stroker dispatch have not been
audited; runtime versions are not enforced by these helpers. These are limits
on general production claims, not evidence of broad driver/browser coverage.

The first clean repair source `5188097` failed its full suite: 21 failures,
3,325 passes and 28 conditional skips. Twenty old expectations assumed GPU
admission for newly refused native topology/rotation cases. Their original
inputs are retained as explicit refusal checks, with separately named admitted
controls preserving packing and precision coverage. One failure was a real
counter bug: joined-stroke budget counting passed width zero to the source
proof instead of the operation's actual paint width. The narrow correction
and additional width-varied counter checks remain subject to the next full run.

A further independent source review found direct ARC/CIRCLE admission lacked
the native Float32 center/radius/ellipse construction bound. At CSS 1216 x 552,
DPR 1, scale 1 and twist 0, arcs with radius 40,000,000, angles 0..0.000002,
and center x values -40,000,000 versus -40,000,000.75 both passed the old guards.
Their Canvas Float32 argument tuples are identical, while their GPU boundaries
differ by 0.75 pixels. Both cannot fit the same quarter-pixel native boundary.
This is a source-level counterexample, not yet a measured raster result.
See the [pinned native argument casts](https://github.com/chromium/chromium/blob/152.0.7977.130/third_party/blink/renderer/modules/canvas/canvas2d/canvas_path.cc#L401-L448).
The bounded repair must refuse unsafe native parameter construction and deduct
its accepted error from the existing tessellation allowance. It must preserve
the total quarter-pixel limit and existing complete-view Canvas fallback.
This parameter repair does not establish a new native libm/angle guarantee;
the existing angle admission and broader production limitations remain explicit.

The subsequent [Intel audit on unchanged 9df assets](benchmarks/windows-gpu-9df-direct-arc-alias-intel-audit.json)
retains an **inconclusive pair** because the first baseline Canvas output changed
after readback. The shifted width-16 case was individually stable across four
captures and a repeat: native Canvas painted zero foreground pixels, while
admitted GPU painted 408 in the ROI (360 pixelmatch differences). An independent
LINE painted 384 pixels, confirming the context was usable. The two final native
captures were identical; GPU centroids differed by about 0.7483 pixels, with all
three GPU repeats exact. Width 2.5 was skipped after baseline instability. The
Canvas backend-transition cause is unproved. This is correctness evidence for
the conservative refusal, not a corrected GPU curve or a paired benchmark pass.
The baseline Canvas large-arc omission is not repaired by this GPU guard.

The bounded parameter guard and its integration passed 13 helper and 16
integration tests, TypeScript and scoped lint. Independent arithmetic review
found no concrete counterexample within its stated center/radius/oval scope.
Nonzero context rotation remains an explicit complete-view refusal. These
checks do not replace native validation of the final clean source.

### Repair validation and CI diagnosis on `344ec1a1`

Clean `344ec1a11f6d8897e9b8ae1098081b4fd3793bf9` passed all ten
local checks: 3,418 tests passed, 28 conditional tests skipped, standalone
edit-selector tests, three TypeScript projects, full lint, fixtures/workflows
and both builds. Ordinary native Canvas/default, diagnostics and all seven
2D compatibility/save checks passed. This validates the counter and parameter
repairs above; it does not establish production GPU acceptance.

The [producer-bound Intel accuracy evidence](benchmarks/windows-gpu-344-native-accuracy-intel.json)
records all five compiled asset digests before and after both private audits.
At synthetic DPR 1.2 and 1.25, the complete backing background, clearing,
251-LINE cache copying and cold/restored backing gates passed with exact full
RGBA comparison. Both last rows and last columns matched. Stable width-2.5/16
probe displacement was 0/0 CSS pixels at DPR1.25 and approximately
-0.0977/+0.0280 at DPR1.2; the old approximately 0.4/0.5-pixel displacement
was absent on those samples. The pure backing audit suppresses only the
editing overlay callback; it does not claim a normal UCS overlay is absent.

All four original unsafe large-ARC parameter cases (both centers, widths
16 and 2.5) refused before any instrumented GL buffer upload, clear or draw.
The GPU overlay stayed hidden and two complete 671,232-pixel fallback captures
per case matched stabilized Canvas references exactly. An independent LINE
confirmed each Canvas context remained usable. These are correct fallback
results, not corrected native curve construction.

Both aggregate audits remain **inconclusive** because native references changed
between captures. In the thin DPR1.2 case, the first-to-second native capture
changed 48 red-channel bytes from 40 to 39 before GPU rendering; subsequent
native captures and the independent physical reference were exact. GPU differed
from that settled thin reference by 48 raw pixels (zero pixelmatch differences),
so no strict thin-line pass is asserted. The baseline width-16 ARC changed by
1,228 raw pixels between references 2 and 3 before references 3 and 4 stabilized.
The captures are preserved and the backend/readback cause is unproved. Actual
window DPR was 1; these were synthetic fractional-DPR tests on one Intel driver.

Exact-head [PR CI](https://github.com/habit04/share/actions/runs/38451183798)
passed Node22, Node24, UI and Windows Electron E2E but failed experimental GPU.
[Push CI](https://github.com/habit04/share/actions/runs/38451175567) passed
Node24, UI and Windows Electron E2E but failed Node22 and experimental GPU.
The Node22 failure was the retained-graph clip test bundling three independent
save/save-as/export workflows under one 5-second budget: 5,266 ms on the push
runner, versus 4,997 ms passing on the PR runner. Two workers did not reliably
resolve it. The replacement separates all six enabled/operation combinations,
with every assertion, fresh setup and the default 5-second per-case limit
preserved. Focused Node24 tests passed all 15 cases; the six changed cases took
598 to 1,161 ms. Exact replacement Node22 CI is still required.

The experimental GPU failure was the new direct-ARC selected-opacity oracle,
which sampled the arc's midpoint grip. Both saved Canvas and GPU 5x5 regions
were uniformly the actual grip fill `[26,61,255,255]`. ARC selection includes
that midpoint grip; excluding only endpoints was insufficient. The bounded
harness repair preserves the original occluded samples, chooses an analytic
curve point clear of every selection grip, and retains the unchanged opacity,
raster and geometric coverage tolerances. Its native and exact-head CI checks,
paired performance and failure recovery remain pending.

### `604a7ccf` failure history and the next bounded producer

Clean `604a7ccfc8b4c2c1216ce68c998a645b34d2227d` passed all local checks,
including 3,422 tests with 28 conditional skips, and all five native preflight
checks. Its fresh no-readback phase passed 12 workflows, including actual
untwisted GPU LINE edit/undo. The complete Intel benchmark nevertheless failed
at the original dense, twisted edit/undo pose. Baseline, edit and undo there
used the signed native-context-rotation refusal and complete Canvas fallback,
with zero GPU uploads and exact same-state Canvas/fallback RGBA equality.
The baseline-to-undo native Canvas reference changed by three pixels; the
requested-GPU fallback changed identically. This does not establish the native
cache-regeneration or backend cause, nor prove exact native undo restoration.

Both exact-head [PR CI](https://github.com/habit04/share/actions/runs/38455152011)
and [push CI](https://github.com/habit04/share/actions/runs/38455142969) passed
four of five jobs: Node22, Node24, UI and Windows Electron E2E. Experimental GPU
failed at that dense fallback undo gate. Preserve this failed history and the
private archives `.codex-local/validation-604a7ccf/benchmark-default/failure.json`
and `.codex-local/ci-604-native-undo-diagnosis.json`. The
[public failed-604 diagnostic](benchmarks/windows-gpu-604-failed-intel.json)
retains all 12 fresh workflow summaries, original-camera GPU edit proof, native
undo analysis and exact CI/local-check results; complete snapshots, raw samples
and PNGs remain privately preserved. It claims no aggregate benchmark pass or
new-producer result. The independent native probe retained
its first restored-image drift and incomplete queued-undo command capture,
so its backend diagnosis remains inconclusive even though later controls were exact.

Diagnostic timing from the failed run motivates the next bounded optimization:
38,000 direct LINEs still prepared twice in 30 sustained-zoom frames, with
preparation max 90.3 ms, upload issuance max 3.9 ms and workflow CPU max 95.6 ms.
The straight compiled-tag flow prepared/uploaded nothing across its 30 frames,
with CPU median 1.1 ms and max 1.7 ms. These describe the failed producer's
samples; they do not measure the next direct-LINE change or establish a paired pass.

The next source candidate extends the direct all-LINE fast path to a proved
maximum ratio of four only for an explicitly requested, fully immutable default
cache interval with at most 100,000 original owner slots, including hidden owners.
Every visible original endpoint, including zero/offscreen geometry, passes the
native Float32 source proof and complete ratio/pan extrema before clipping or
triangle allocation. Only a factory-certified source-precision failure may
retry the ordinary 1.25 interval; topology and unexpected exceptions never weaken
admission. Ordinary, mutable, strict/custom and over-limit requests keep their
previous path. The .8 lower bound, 128-physical-pixel pan border, fixed CSS
lineweights, .0625 source and .0625 shader reserves, retained rectangle, packed
vertex bytes and vertex cap are unchanged. LINE deltas prove the actual stored
maximum; a replacement safe only at 1.25 cannot patch a fourfold cache.
The six focused geometry/renderer files passed all 182 tests, TypeScript and
scoped lint. This candidate is unmeasured and adds no curve, dimension or hatch coverage.

The next fallback oracle keeps the original drawing, camera and edit. Each
baseline/edit/undo/redo state must retain exact complete-view Canvas/fallback
RGBA equality and zero GL upload/clear/draw. Restoration also verifies exact
immutable snapshot identity and complete document JSON, camera, settings,
selection/overlays, DPR, logical/physical surface dimensions and surface rectangle.
The original cross-state comparison and images remain recorded. For a changed
native reference, compare every signed RGBA-channel change against the native
Canvas control with zero differential tolerance; opposite changes cannot wrap
into equality. Matching changes establish only relative fallback restoration,
while native restoration stays explicitly **inconclusive**. A differing signed
change, broken state invariant, changed refusal reason, missing edit or GPU
submission still fails. Actually admitted GPU edit/undo retains exact cross-state
restoration requirements. No pixel tolerance or production Canvas behavior changes.

Primary research supports investigating the mechanisms, not declaring JCad accurate:
pinned [Chromium 152 readback handling](https://github.com/chromium/chromium/blob/152.0.7977.130/third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc#L398-L435)
can disable acceleration after readback under its stated context conditions;
[resource-provider replacement](https://github.com/chromium/chromium/blob/152.0.7977.130/third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d.cc#L1057-L1071)
does not prove it caused the observed drift. OpenLayers v10.11's
[buffer-generation conditions](https://github.com/openlayers/openlayers/blob/v10.11.0/src/ol/renderer/webgl/VectorLayer.js#L424-L498)
and [per-frame projection uniforms](https://github.com/openlayers/openlayers/blob/v10.11.0/src/ol/renderer/webgl/vectorUtil.js#L41-L59)
provide an example of separating view transforms from geometry buffers. They
prove neither JCad's quarter-pixel accuracy nor native stroke topology.

Next clean-producer full checks/builds, native correctness/performance/recovery,
and both exact-head CI runs are pending. Publish source-bound Intel/NVIDIA/process
and unavailable-device evidence only after its gates pass. Canvas remains default;
production approval and the broader hardware/curve gates remain open.

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
   and in exact source CI; complete the remaining owned checklist. The merged
   PR #9 transaction/codec baseline is integrated in this isolated candidate;
   combined source `455b2662` passed regressions and real native 2D preservation
   checks. Require fresh native/CI evidence for the final candidate and coordinate
   PR #11's active owner before integrating unfinished work.
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
