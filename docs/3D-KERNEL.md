# JCad 3D: modelling core and geometry kernel

Status: **experimental**, part of milestone 3 (modelling) on the 3D branch. This file describes
the non-UI core: sketch profiles, extrude / revolve tessellation, feature re-evaluation and the
Manifold Boolean kernel. No command, ribbon entry or viewport code uses it yet. The design
background is in [3D-PLAN.md](3D-PLAN.md) ("Geometry kernel evaluation", "Solids, features and
meshes").

## Modules

| File | Role |
| --- | --- |
| `src/model3d/sketch.ts` | `profileFromEntities(entities, frame, { tolerance, segments })`: closed polylines (bulges flattened), circles, ellipses, closed splines, and lines / arcs / open curves chained into loops, mapped into a frame. `validateProfile` checks stored profiles. |
| `src/model3d/triangulate.ts` | Ear clipping with hole bridging (Eberly): cap triangles that use exactly the loop vertices. |
| `src/model3d/sweep.ts` | `extrudeMesh(profile, distance)`, `revolveMesh(profile, axis, angle, segments?)`. |
| `src/model3d/kernel/kernel.ts` | `GeometryKernel` interface, `KernelStatus`, `KernelError`, `UnavailableKernel`, operand and result checks shared by every kernel. |
| `src/model3d/kernel/manifold-core.ts` | Synchronous Booleans on the Manifold WebAssembly module (worker and Node). |
| `src/model3d/kernel/manifold.worker.ts`, `protocol.ts` | The module Worker and its message types. |
| `src/model3d/kernel/worker-core.ts` | The worker's request handling (Booleans under the memory limit, test probes), free of worker globals so Node tests run it behind a fake Worker. |
| `src/model3d/kernel/memory-guard.ts` | The hard 1 GiB WebAssembly memory limit (`KERNEL_MEMORY_LIMIT_BYTES`) and the `WebAssembly.Memory.prototype.grow` guard that enforces it. |
| `src/model3d/kernel/manifold-kernel.ts` | `ManifoldWorkerKernel`: the main-thread side (ids, timeouts, crash handling). |
| `src/model3d/kernel/manifold-direct.ts` | `ManifoldDirectKernel`: the same contract in-process (Node tests; documented alternative). |
| `src/model3d/kernel/index.ts` | `createDefaultKernel()`: worker kernel when `Worker` exists, else in-process. |
| `src/model3d/feature-eval.ts` | `evaluateFeature(feature, kernel, { maxDepth, maxNodes })`. |

## Conventions

- World coordinates are AutoCAD's WCS (right-handed, X right, Y up, Z toward the viewer), drawing
  units, angles in radians (right-hand rule). Meshes are plain arrays, closed by index topology,
  triangles counter-clockwise seen from outside, so `meshVolume` is positive.
- Profiles: loops in the frame's XY plane; the outer loop first and counter-clockwise seen from
  the frame's +Z, holes clockwise; loops implicitly closed.
- Sketch flattening is deterministic: `segments` chords per full turn (default 32, clamped to
  8..256), proportionally fewer for partial arcs; splines use the core NURBS sampler with
  max(4, segments / 4) samples per knot span.
- Sketch tolerance (default 1e-6 drawing units, absolute): endpoint matching for chains, the
  on-plane test, merging coincident consecutive points and dropping vertices on straight runs.
  Open, branching, self-intersecting, crossing or touching loops, several outer regions and
  islands inside holes are refused with a message naming the entity or position. Nothing is
  repaired.
- Revolve: the axis must lie in the profile plane and the profile on one side of it. Points
  within 1e-9 (relative to the profile extent) of the axis become single pole vertices and edges
  on the axis sweep no faces, so a rectangle with one side on the axis gives a closed cylinder. A
  profile that touches the axis at one vertex only gives a pinch vertex (edge-manifold, accepted).
- Revolve features store their `segments` (steps per full turn, default 32, clamped 3..256), so
  re-evaluation rebuilds the mesh it was made with.
- Caps use exactly the profile vertices. A stored profile with exactly collinear vertices may get
  zero-area cap triangles from the triangulator's fallback; they keep the mesh closed.
- Limits: 20 000 profile points; every sweep checks `MAX_SOLID_TRIANGLES` before building;
  feature trees at most 32 deep and 1 024 features (checked iteratively before any work).
- Every builder result must have finite coordinates and a finite, positive volume once placed
  (`requireSolidMesh`, primitives.ts): a part whose size is below the precision of its position
  (a 1 mm sphere at 1e300) or whose volume overflows is refused with a RangeError, never returned
  as a degenerate mesh. A cap the triangulator cannot build (a valid profile collapsed in the
  revolution plane) is a RangeError too. Both were found by fuzzing (docs/3D-TESTING.md).
- Errors: builders throw RangeError (and GeometryBudgetError for the budget), `evaluateFeature`
  FeatureEvalError, the kernel KernelError; `describeModel3DError` (src/model3d/errors.ts) is how
  a command turns any of them into a command-line message (docs/3D-TESTING.md, error audit).

## Booleans and the kernel

Every call goes through the same checks, on the calling thread:

1. Operands: `validateMesh`, triangle budget, `meshIsClosed`, positive volume. A failure is a
   `KernelError` with code `invalid-input` (or `budget`) whose message names the operand ("The
   second solid cannot be used in the union: it is not a closed solid ..."). Nothing is welded or
   repaired on the way in.
2. Kernel: Manifold builds both solids, runs `add` / `subtract` / `intersect`, returns the mesh.
   If Manifold refuses an input (`Not manifold`, `Non-finite vertex`, ...) the error names it.
3. Result (`finishResult`): exact duplicate vertices welded, re-validated, must be non-empty
   (`empty-result`), closed, within `MAX_SOLID_TRIANGLES` (`budget`), and of positive volume: an
   inside-out result is a `kernel-failure` (the message gives the volume), never flipped silently. Where welding would join vertices Manifold kept apart on
   purpose (parts touching along an edge or at a point), the unwelded closed mesh is kept.

Precision: Manifold's mesh format is 32-bit float. Operands are shifted by the centre of their
joint bounding box before conversion and shifted back in double precision; output vertices whose
float coordinates match exactly one input vertex get that vertex's double coordinates back. Only
new intersection vertices carry float precision (about 6e-8 of the parts' extent).

Native memory: every `Manifold` object is freed with `delete()`, including an operand Manifold
refuses (tested by counting calls). The public `Manifold` constructor of manifold-3d throws on a
bad status without freeing the native object it created, so manifold-core.ts calls the embind
constructor behind it (the prototype's `constructor`), checks `status()` itself and deletes the
object on failure. Should a future manifold-3d change that layout, the code falls back to the
public constructor and a refused operand leaks a few hundred bytes; operands rarely get that far,
because `prepareOperands` already refuses open meshes.

### Worker transport

`ManifoldWorkerKernel` creates `new Worker(new URL('./manifold.worker.ts', import.meta.url),
{ type: 'module' })` lazily. Requests are posted only after the worker reports `ready` (earlier
calls wait in a queue, and a result message before `ready` is ignored), so a worker that fails
to start rejects every call with its start-up reason whatever order its events arrive in.
Requests carry increasing ids and replies are matched by id; meshes
travel as `Float64Array` / `Uint32Array` with their buffers transferred. Per-call timeout
(default 20 s): the call rejects (`timeout`), the busy worker is terminated (a running Boolean
cannot be cancelled, so recycling the worker is the only way to stop it), every other pending call
rejects with a `timeout` error saying the kernel was restarted after an earlier operation timed
out, and the next call starts a fresh worker. Timeouts do not count toward the crash-restart limit. A worker
`error` event (crash, out-of-memory abort) rejects all pending calls (`worker-crash`); the next
call starts a new worker once, and a second crash makes the kernel unavailable for the session.
An unreadable reply (`messageerror`) after start-up counts as a crash. When the worker reports
that the memory limit stopped an operation (below), the call rejects with a `memory-limit`
KernelError, the worker is terminated, every other pending call rejects, and the next call starts
a fresh worker, as after a timeout (not counted toward the crash limit). Start-up failures are
final for the session, each with its own message: the worker script failing to load or erroring
before `ready`, the WebAssembly module failing to start (`init-error`), or no `ready` within
`startTimeoutMs` (default 20 s; the worker is terminated). Pending calls then reject as
`unavailable` and `ready()` reports the reason.
The constructor takes `createWorker` so tests inject a fake worker
(`tests/model3d-kernel.test.ts`; `tests/model3d-memory-limit.test.ts` runs the real worker request
handler, worker-core.ts, behind one).

What the worker is and is not: a dedicated worker is a thread of the renderer process with its
own JavaScript global scope. It keeps long Booleans off the UI thread and gives the kernel its
own CSP (below), but it is **not** memory or crash isolation: its WebAssembly memory counts
against the renderer process, and anything that brings the renderer process down (for example the
operating system refusing memory to it) takes the editor with it. What bounds the kernel inside
that process is the hard 1 GiB WebAssembly memory limit, the per-call timeout and the restart
policy; an exception or abort inside the module becomes a KernelError and nothing is applied.

### Memory limit

`KERNEL_MEMORY_LIMIT_BYTES` (memory-guard.ts) is 1 GiB (16,384 WebAssembly pages), a single
exported constant. Which mechanism applies: manifold.wasm defines and **exports** its own linear
memory (256 pages initial, 65,536 maximum) and imports none, so it cannot be instantiated with a
smaller `new WebAssembly.Memory({ initial, maximum })`. Its heap grows only from JavaScript:
Emscripten's `emscripten_resize_heap` (a function the module imports) calls `growMemory`, which
calls `wasmMemory.grow(pages)` (`tests/model3d-wasm-memory.test.ts` checks both facts in the
shipped files). So the worker replaces `WebAssembly.Memory.prototype.grow` before the module is
instantiated and refuses any growth past the limit. The refused `grow` throws; Emscripten
catches that and retries with less headroom (1.2x, then 1.1x, then 1.05x the current size, never
below what was asked for). If a retry fits under the limit the allocation succeeds and the
operation completes normally, without a restart (`tests/model3d-memory-limit.test.ts` runs a real
Boolean under a limit one page below its last 1.2x step). If every attempt is refused, the
allocator returns null and the C++ code fails (in practice a `RuntimeError: memory access out of
bounds`; the module is then treated as unusable). The limit stops a request when the operation
threw after a refused growth, or when its last growth attempt was refused (`memoryLimitStopped`);
such a request is answered with `memoryLimit`, the worker refuses further requests, and the main
thread replaces it. The user sees: "The 3D kernel reached its 1 GiB memory limit; the
operation was abandoned and the model is unchanged." Not covered: a `memory.grow` instruction
executed by the module itself (Emscripten JS-runtime builds do not use one for the heap; the test
above fails if manifold.js stops growing through `wasmMemory.grow`). The in-process kernel applies
the same guard on request (`new ManifoldDirectKernel({ memoryLimitBytes })`, scoped to each
synchronous Boolean) and reports `lastPeakBytes`.

Peak WebAssembly memory (`memory.buffer.byteLength`), each operation on a fresh module under the
1 GiB guard, in-process in Node 22 on Windows x64 (`JCAD_BENCH=1` run of
`tests/model3d-memory-limit.test.ts`, 2026-10-12; 16 MiB is the initial size, i.e. no growth):

| Operation | Operands (triangles) | Peak | Outcome |
| --- | --- | --- | --- |
| Union of two half-overlapping unit cubes | 12 + 12 | 16 MiB | ok |
| Union / subtraction / intersection of two 50,000-triangle spheres (perf case) | 50,000 + 50,000 | 58 / 40 / 33 MiB | ok |
| Enclosure fixture build (13 Booleans, one module) | 1,964 triangles in the results | 16 MiB | ok |
| Cable-tray fixture build (2 Booleans) | 624 triangles in the results | 16 MiB | ok |
| Union, two 499,712-triangle rows of 8 spheres (the per-solid cap is 500,000) | 499,712 + 499,712 | 503 MiB | result refused by the triangle budget (706,112) |
| Subtraction, same operands | 499,712 + 499,712 | 419 MiB | result refused by the budget (517,152) |
| Intersection, same operands | 499,712 + 499,712 | 349 MiB | ok (328,192 out) |
| Subtract a 2,000-triangle sphere from a 499,712-triangle row | 499,712 + 2,000 | 291 MiB | ok |
| Union, two 249,856-triangle rows | 249,856 + 249,856 | 252 MiB | ok (353,056 out) |
| Union, two 50,000-triangle spheres, second turned 0.01 rad (facets cross nearly everywhere) | 50,000 + 50,000 | 207 MiB | ok (498,004 out) |
| Union, the same crossing case with 124,928- / 249,856-triangle rows | 124,928 x 2 / 249,856 x 2 | 452 / 876 MiB | result refused by the budget (1,246,854 / 2,493,516) |
| Union / subtraction / intersection, crossing case with 499,712-triangle rows | 499,712 + 499,712 | 1,001 / 1,001 / 995 MiB | **stopped by the 1 GiB limit** (memory-limit, after 13-15 s) |

So the limit stops only the crossing case at the operand cap. Without the limit (a one-off run
with a 4 GiB guard) that union needs 1,806 MiB and 28.6 s and returns 4,986,730 triangles, ten
times the per-solid budget, so it would be refused afterwards anyway (and its 28.6 s also exceeds
the 20 s timeout). No operation measured here whose result fits the budget fails at 1 GiB.
Worker timings differ (the worker reached the limit in about 3 s with the allocation probe of
scripts/e2e-3d-security.mjs).

## How the WebAssembly ships and loads

- The worker imports `manifold-3d/manifold.wasm?url` and passes it to the Emscripten module as
  `locateFile`. Vite emits `manifold.wasm` once into `assets/` (content-hashed) and the worker
  chunk refers to it as `new URL('manifold-<hash>.wasm', import.meta.url)`, i.e. relative to the
  chunk, which works with `base: './'` and the `jcad://app/` origin. Emscripten's own default
  (`new URL('manifold.wasm', import.meta.url)` inside manifold.js) resolves to the same asset in a
  build; the explicit `?url` is what makes the Vite dev server work too (pre-bundled
  dependencies lose their `import.meta.url`).
- Instantiation uses `WebAssembly.instantiateStreaming` and falls back to an `ArrayBuffer` if the
  response is not served as `application/wasm`.
- For the Electron renderer build, `vite.config.ts` emits every worker bundle (entry and chunks)
  as `assets/worker/<name>-<hash>.js` (`worker.rollupOptions.output`), so worker scripts are
  recognisable by path. `npm run build` now contains (the 3D commands import
  `createDefaultKernel`): `assets/worker/manifold.worker-<hash>.js` (48 KB, self-contained:
  manifold.js is bundled into it, it imports no other chunk), `assets/manifold-<hash>.wasm`
  (541 KB, referenced from the worker as `../manifold-<hash>.wasm`) and a lazily loaded
  `assets/manifold-core-<hash>.js` (47 KB, the in-process fallback, never loaded where `Worker`
  exists). The build prints a harmless warning that `node:module` was externalised: manifold.js
  imports it only on its Node code path.
- Worker CSP (docs/SECURITY-REVIEW.md E-19): `index.html`'s renderer CSP is unchanged. A
  dedicated worker loaded from its own URL is not governed by the document's meta CSP but by its
  own response's policy, so the `jcad://app/` protocol handler (`electron/renderer-origin.cjs`)
  sends `WORKER_CSP` = `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src
  'self'; base-uri 'none'` with every `assets/worker/*.js` response (`assetResponseHeaders`, and
  only those): bundled scripts, fetching the bundled wasm and compiling it are allowed, everything
  else (remote fetch or import, images, fonts, frames, nested workers) is refused. WebAssembly
  stays blocked on the renderer main thread.
- The browser edition (`vite build --mode site`, GitHub Pages) and the Vite dev server keep
  Vite's default layout (`assets/manifold.worker-<hash>.js`; the site build is otherwise
  unchanged) and serve the worker without that header: static hosting cannot set response headers.
  There the worker runs with no CSP of its own (the site page's relaxed policy already allows
  `'wasm-unsafe-eval'` for LibreDWG); the worker CSP is an Electron-only control.

Verification (2026-10-12, headless Chromium from Playwright, the renderer's exact meta CSP served
over HTTP): `ready()` reports Manifold 3.5.4; union of two unit cubes = 1.5; main-thread
`WebAssembly.compile` is refused by the CSP as expected. The same probe works under the Vite dev
server.

In Electron, `npm run e2e:3d-security` (scripts/e2e-3d-security.mjs, outside CI) checks the
worker Boolean, the worker CSP header and its effect inside the worker, the unchanged page policy
and the memory limit with a restart; docs/3D-PACKAGED-TEST.md has the commands. It passed
(19/19 checks; 20/20 with the fuse check of a packaged build) on 2026-10-12 against the development build (`electron .`) and against an
unpacked Windows test build (`npm run dist:test:no-dwg`: ASAR, test fuses, no DWG writer); not yet
against an installed release build.

Measured times (Windows x64):

| Operation | In-process, Node 22 | Worker, Chromium (incl. checks and transfer) |
| --- | --- | --- |
| Union of two half-overlapping unit cubes | 0.7 ms | 8-16 ms (first call) |
| Union of two 256 x 50 spheres (50 176 triangles in) | 187 ms | 156-255 ms |
| Union of two 250 x 101 spheres (100 000 triangles in, 77 938 out; milestone 6, after the faster weld and closedness checks) | 280-373 ms | not measured |

More numbers, budgets and the memory measured for the largest operands: docs/PERFORMANCE.md "3D".

## Prototype-only and open points

- No UI: the EXTRUDE / REVOLVE / UNION / SUBTRACT / INTERSECT commands, error display and kernel
  start-up on flag enable are milestone 3 UI work.
- Security review: docs/SECURITY-REVIEW.md "Experimental 3D track" (E-19 to E-24). E-19 (worker
  CSP header) and E-20 (1 GiB WebAssembly memory limit) are mitigated and verified in the
  development build and an unpacked Windows test build; not yet in an installed, signed release
  build.
- `manifold-3d` is a `devDependency`: Vite bundles manifold.js into the worker chunk and emits
  `manifold.wasm` into `dist/assets`, so the installer needs nothing from `node_modules`. This also
  keeps the package's CLI dependencies (glTF tools, `sharp` with native image libraries,
  `esbuild-wasm`) out of electron-builder's production `node_modules`.
