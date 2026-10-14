# Experimental GPU renderer

This development prototype compares a WebGL2 drawing base scene with the current
Canvas 2D renderer. Ordinary builds and drawing files continue to use Canvas 2D.
No 3D modeling or new document/save format is included.

Baseline: `16abc740da729abf458996fc2bf0b65c498794f9` (diagnostics branch; GitHub
CI, including Windows Electron end-to-end, passed). Local branch:
`feature/windows-gpu-renderer`. Worktree: `C:\Users\justi\Chad\jcad-gpu-renderer`.
All dependencies, profiles and build artifacts are private to this worktree.

## Run and compare

Use Node 22.20+ or supported Node 24, then:

```sh
npm ci
node node_modules/electron/install.js
npm run build:gpu
npx electron .
```

The development build starts with Canvas. Turn the grid off with **F7**, then run `GPURENDERER GPU` or click the
experimental toggle to request GPU rendering. `GPURENDERER CANVAS` switches back.
Run `GPU3DDEMO` for the separate demonstration. A browser development server is
available through `npm run dev:gpu` on port **5189**. `npm run build` produces
the ordinary build with the prototype disabled.

`npm run bench:gpu` launches real Windows Electron with an isolated profile and
records comparisons and screenshots under `e2e-output/gpu-renderer/`. It reuses
the deterministic existing performance-fixture generator: 38,000 wires for the
supported benchmark, and the mixed 6,500-object schematic for fallback. Additional
small curve/bulge and billion-unit-coordinate scenes check precision and visual
output. Both renderers use the same drawing, hardware, window and camera.

## Backend and interfaces

WebGL2 is selected for a bounded first prototype: Electron supports WebGL and the
running Windows runtime reports it enabled. WebGPU is reported available on this
machine, but availability does not establish use or a universal hardware guarantee.
WebGL2 permits a small shared device implementation with explicit resource lifetime,
context-loss testing and asynchronous completion fences, without new dependencies.
See [Electron graphics feature status](https://www.electronjs.org/docs/latest/api/structures/gpu-feature-status/)
and the [WebGL2 reference](https://www.khronos.org/files/webgl20-reference-guide.pdf).

`src/render/gpu-prototype/device.ts` owns GPU resources and recovery for both paths.
The 2D renderer consumes the existing `DrawingState`, resolves existing appearance
and layer interfaces, and rebases world coordinates in double precision before
conversion to screen-space floats. The demonstration uses separate camera and mesh
data, never production documents. The viewport integration preserves existing input,
selection, snapping and Canvas editing overlays. Diagnostics use the completed
collector and label actual rendering separately from Chromium capabilities.

## Correctness and limitations

Supported base geometry: lines, zero-width unfilled polylines including bulges,
circles and arcs. Supported appearance includes visible layers, existing color
resolution and fixed screen lineweights. Curves use an adaptive pixel-error bound.
The full view falls back to Canvas if any visible content or style cannot be
represented correctly, or if initialization fails/context is lost. It never draws
only the supported subset of a mixed drawing.

Text, hatches, images, blocks, dimensions and other entity kinds remain Canvas.
Views with the grid visible, paper-space layouts, special underlays and active tool previews remain Canvas.
Unsupported line styles/widths and selection styles may also require fallback.
The UI reports fallback; no source drawing is changed. Canvas handles the cursor,
grips, snapping indicators and editing overlays even in GPU mode. Grid-enabled
views use Canvas for the whole view to preserve the original compositing order.
Projected endpoints beyond 2^36 physical pixels also require full-view fallback;
local geometry around large world-coordinate origins remains supported.

The 3D demonstration includes a grid, box, sphere and cylinder, depth-tested meshes,
orbit/pan/zoom, both projections and nearest-object picking. It has no solid
modeling, file import/export, production 3D object model or editing support.

## Measurement interpretation

CPU submission includes preparation, uploads and WebGL calls. Completion-fence
wall time includes polling/driver scheduling; it is not pure GPU elapsed time or
desktop presentation latency. Canvas uses a readback to flush its own canvas;
neither measurement establishes display scanout time. RAF waits are reported
separately. JS heap estimates include the application; buffer bytes estimate
uploads rather than total driver/GPU memory. No OS cache purge is performed.
Results from one Windows machine do not predict performance on other hardware.

## Measured Windows results

Recorded sample: Electron 44.7.0, Chromium 152.0.7977.130, Windows kernel build
10.0.26200. Chromium explicitly reported Intel UHD Graphics active and the NVIDIA
RTX A3000 inactive; acceleration, Canvas and compositing were enabled. The drawing
viewport was 1216 × 552 CSS pixels at DPR 1. Each moving comparison uses 30 samples.
Full timing, heap, upload and validation data are in
[windows-gpu-prototype.json](benchmarks/windows-gpu-prototype.json).

| Drawing | Canvas CPU submission | GPU CPU submission | Canvas observed render + flush | GPU observed render + fence wait |
| --- | ---: | ---: | ---: | ---: |
| Lines, circle, arc and bulged polyline | 0.2 ms | 1.1 ms | 1.2 ms | 7.5 ms |
| Same scene at a billion-unit origin | 0.2 ms | 1.1 ms | 1.1 ms | 7.7 ms |
| Existing generator: 38,000 wires | 70.1 ms | 78.9 ms | 70.7 ms | 91.3 ms |
| Existing 6,500-object schematic | 19.0 ms | 20.4 ms* | 19.5 ms | 20.9 ms* |

*Requested GPU mode falls back to the original Canvas renderer for the schematic.

For dense wires, geometry preparation alone took 76.1 ms median. Cached static
redraws were 0.5 ms CPU for Canvas and 1.0 ms CPU for GPU (9.3 vs 13.3 ms including
the respective completion observations). The first small-scene GPU submission,
including device/shader initialization, took 26.8 ms. Fresh-process launch samples
were 3.47 s for the default build and 1.42 s for the experimental build; these
single ordered samples retain OS caches and **do not establish a startup benefit**.

Dense-wire GPU uploads were 4.56 MB per changed view. Whole-application JS heap
samples were approximately 29.6 MB in the Canvas phase and 160.5 MB in the GPU phase;
these are order/GC-dependent samples, not isolated renderer memory measurements.
Pure GPU execution time, driver memory and desktop presentation time were not measured.

Small-scene image differences were 0.006%; dense-wire image differences were 3.335%,
including visible coverage/brightness differences from the rasterizers. Geometry
coverage matched within a two-pixel tolerance in both directions (zero missed
foreground pixels under that test). This tolerance does not establish exact visual
parity. The mixed schematic fallback matched Canvas pixel-for-pixel. Screenshots
and difference images are generated by the benchmark for inspection.

## Validation and recommendation

The full suite passes 2,328 tests, with 27 existing skips. Renderer, Electron and
scripts typechecks and lint pass. Both default and experimental builds pass.
Independent review found and helped resolve grid layering, frozen-layer visibility
and unsafe endpoint precision. The default Windows build has no experimental UI,
device initialization or commands, and its normal LINE command works.

Direct Windows validation covers supported scenes, solid selection, complete
schematic/grid fallback, two WebGL loss/restoration cycles, disposal, and the 3D
demo's orbit/pan/zoom, both projections, nearest-object picking and a rendered frame
after context restoration. Opening/closing the demo leaves the document unchanged.
Unit tests cover unavailable/throwing contexts, shader/link/upload failures, limits,
cleanup, timeout and resource lifetimes, curve precision, camera math and picking.
Failure/unsupported-hardware cases are mocks; the 3D agent also checked Chromium
with SwiftShader. Windows measurements above use the real runtime/hardware report.

**Keep Canvas as the default. Do not adopt this implementation as a production
replacement.** It is slower in these samples, allocates substantial CPU geometry
on camera changes, lacks entity/style coverage, and still differs visibly on dense
drawings. A bounded next investigation could cache locally rebased geometry on the
GPU and apply camera transforms there, then repeat the same correctness/benchmark
gates. The working device/recovery interface and isolated 3D demo are reusable.

Before combining with the other workstreams, review the small changes to the
viewport, main entry, build flag and diagnostics' current-renderer provider. The
prototype uses the diagnostics commit as its baseline and keeps its read-only API.
Coordinate the GPU device/camera seam with full 3D development before reuse; there
is no production 3D document dependency or save-format change to merge.
