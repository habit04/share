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
{ type: 'module' })` lazily. Requests carry increasing ids and replies are matched by id; meshes
travel as `Float64Array` / `Uint32Array` with their buffers transferred. Per-call timeout
(default 20 s): the call rejects (`timeout`), the busy worker is terminated (a running Boolean
cannot be cancelled, so recycling the worker is the only way to stop it), every other pending call
rejects with a `timeout` error saying the kernel was restarted after an earlier operation timed
out, and the next call starts a fresh worker. Timeouts do not count toward the crash-restart limit. A worker
`error` event (crash, out-of-memory abort) rejects all pending calls (`worker-crash`); the next
call starts a new worker once, and a second crash makes the kernel unavailable for the session.
An unreadable reply (`messageerror`) after start-up counts as a crash. Start-up failures are
final for the session, each with its own message: the worker script failing to load or erroring
before `ready`, the WebAssembly module failing to start (`init-error`), or no `ready` within
`startTimeoutMs` (default 20 s; the worker is terminated). Pending calls then reject as
`unavailable` and `ready()` reports the reason.
The constructor takes `createWorker` so tests inject a fake worker
(`tests/model3d-kernel.test.ts`).

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
- No change to `vite.config.ts` was needed: `worker: { format: 'es' }` already produces module
  worker chunks, and no alias is involved. The build prints a harmless warning that `node:module`
  was externalised: manifold.js imports it only on its Node code path.
- `index.html` (CSP) and `electron/*.cjs` are unchanged. A dedicated worker loaded from its own
  URL is not governed by the document's meta CSP; it gets only what its own response carries
  (nothing), so WebAssembly compiles there while it stays blocked on the renderer main thread.
- Until a 3D command imports `createDefaultKernel`, `npm run build` contains no kernel code and
  no wasm (the main bundle is byte-identical to the build without this module). Verified with a
  probe entry built with the production config: output `manifold-<hash>.wasm` (541 KB),
  `manifold.worker-<hash>.js` (46 KB) and a lazily loaded `manifold-core-<hash>.js` (46 KB, the
  in-process fallback, never loaded where `Worker` exists).

Verification (2026-10-12, headless Chromium from Playwright, the renderer's exact meta CSP served
over HTTP): `ready()` reports Manifold 3.5.4; union of two unit cubes = 1.5; main-thread
`WebAssembly.compile` is refused by the CSP as expected. The same probe works under the Vite dev
server. Not yet run inside the packaged Electron app (no command uses the kernel).

Measured times (Windows x64):

| Operation | In-process, Node 22 | Worker, Chromium (incl. checks and transfer) |
| --- | --- | --- |
| Union of two half-overlapping unit cubes | 0.7 ms | 8-16 ms (first call) |
| Union of two 256 x 50 spheres (50 176 triangles in) | 187 ms | 156-255 ms |

## Prototype-only and open points

- No UI: the EXTRUDE / REVOLVE / UNION / SUBTRACT / INTERSECT commands, error display and kernel
  start-up on flag enable are milestone 3 UI work.
- The security review must gain a section for the WebAssembly worker before any release (plan,
  open decision 1).
- `manifold-3d` is a `devDependency`: Vite bundles manifold.js into the worker chunk and emits
  `manifold.wasm` into `dist/assets`, so the installer needs nothing from `node_modules`. This also
  keeps the package's CLI dependencies (glTF tools, `sharp` with native image libraries,
  `esbuild-wasm`) out of electron-builder's production `node_modules`.
