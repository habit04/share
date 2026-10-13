# JCad 3D: architecture and implementation plan

Status: **experimental; milestones 0-7 delivered** (7 = true 3D dimensions and the E-19 / E-20 controls) on branch `feature/3d-development` (see [3D-STATUS.md](3D-STATUS.md) for what works, what is prototype-only and what remains). Nothing in this
document describes a shipping feature. The 3D code is compiled into the application but is inert
unless the user enables **Options > Experimental > 3D modelling** (setting `experimental3d`,
default off). This file is the working plan; [3D-STATUS.md](3D-STATUS.md) records what each
milestone actually delivered, how it was tested and what remains.

Starting point: tag `v0.4.8`, commit `83aedbcc7b145ff87293a35d9001cb56f127a2b0` (the latest
released, CI-tested build; typecheck, lint and 2,212 unit tests green on Windows x64, Node 22.23.3).

Contents: [Goals and non-goals](#goals-and-non-goals) · [Where the 2D code stands](#where-the-2d-code-stands) ·
[Architecture](#architecture) · [Geometry kernel evaluation](#geometry-kernel-evaluation) ·
[Rendering and GPU coordination](#rendering-and-gpu-coordination) · [Persistence](#persistence-dxf-and-dwg) ·
[Feature flag](#feature-flag-and-isolation) · [Milestones](#milestones) · [Testing](#testing-strategy) ·
[Open decisions](#decisions-that-need-the-owners-input)

## Goals and non-goals

Goals, in the order the milestones deliver them:

1. A 3D document model with consistent coordinates, units, precision and stable object identities.
2. A 3D viewport: orbit, pan, zoom, orthographic and perspective projection, reliable selection.
3. Modelling: primitives, planar sketches, extrusion, revolution, solid Boolean operations.
4. Editing: move, rotate, scale, snapping, measurement, dimensions.
5. Undo/redo and versioned saving/loading that keep 3D objects without harming 2D documents.
6. Performance, error handling and regression tests on realistic drawings and models.

Non-goals for this branch: installers, release-branch merges, publication, signing or release
workflow changes; parity with a mechanical CAD package (fillets, chamfers, shelling, NURBS
surfaces, assemblies, drafting views generated from solids); reading ACIS `3DSOLID` bodies.
Those are listed as *unsupported* wherever a user could expect them.

## Where the 2D code stands

Facts that shape the design (all verified in the source at the starting commit):

- **State is immutable plain data.** `DrawingState` (`src/core/document.ts`) holds `entities`,
  `layers`, `blocks`, header, layouts. Every edit builds a new state; undo/redo keep whole states
  (200 deep). `prepareDrawingState` (`src/core/geometry-budget.ts`) validates a geometry budget and
  `sealImmutableData` deep-freezes the state. The sealer throws on typed arrays, Maps or class
  instances, so anything stored in the state must be plain objects and arrays.
- **Geometry is 2D.** `Point {x, y}` (`src/core/geometry.ts`, `EPS = 1e-9`, Y-up). The `Entity`
  union (17 kinds, `src/core/entities.ts`) is switched over exhaustively in rendering, snapping,
  selection, DXF, DWG, plotting and the plugin API. Adding a 3D kind to that union would touch all
  of them; keeping 3D objects in a separate collection touches none.
- **Ids** come from `newId()` (`e<time36><counter36>`), unique within a session; DXF handles are
  allocated at write time. 3D objects use the same generator.
- **Rendering is Canvas 2D.** `Viewport` (`src/render/viewport.ts`) owns `scale`, `center`,
  `twist`, a cached base scene, overlays and the paper-space painter. There is no WebGL and no
  GPU renderer anywhere in the repository or on any branch (checked `git log --all` and every
  remote branch's file list). "GPU diagnostics" and a "shared 2D/3D renderer" are planned work,
  not code, so this plan defines the interfaces they should meet (below).
- **Native file format is DXF** (AC1015 upward, chosen per content) and, on Windows, DWG through
  the portable Rust writer, which refuses unsupported records rather than dropping them. Autosave
  and recovery are DXF snapshots. `3DFACE`, `3DSOLID`, `REGION`, `BODY` read from other programs'
  files are retained as raw records in model space and written back; polyface and polygon meshes
  are **dropped and reported**, 3D polylines flattened and reported (`src/io/dxf/read-pass.ts`).
  JCad already carries its own data in registered XDATA (`JCAD_DIMSTYLE`, `JCAD_TABLE`,
  `JCAD_MTEXT_COLUMNS`, `JCAD_MTEXT_BACKGROUND`, `JCAD_SPLINE_FIT`).
- **Security posture.** Electron renderer CSP is `default-src 'self'` with no `wasm-unsafe-eval`
  (only the browser edition relaxes it, for LibreDWG). DWG parsing runs in an isolated utility
  process with memory limits. Any WebAssembly kernel therefore cannot run on the renderer's main
  thread without a CSP change (see kernel evaluation).
- **Tests** are vitest in a Node environment (no DOM, no canvas); UI behaviour is covered by
  Playwright scripts (`scripts/screenshot.mjs`, `scripts/ui-click-check.mjs`, `scripts/e2e-electron.mjs`)
  and performance by `tests/perf*.test.ts` and `scripts/bench.mjs` with enforced budgets.

## Architecture

### Coordinates, units, precision, identity

- World coordinate system = AutoCAD WCS: right-handed, X right, Y up, Z toward the viewer. The
  existing 2D drawing is the plane z = 0; a 2D point (x, y) is the 3D point (x, y, 0). Nothing in
  the 2D model changes.
- Units are the drawing's header units (`header.units`); no separate 3D unit. Lengths, volumes
  and dimension text use the existing formatting (`formatLength`, precision setting).
- `EPS3 = 1e-9` for exact comparisons (same as 2D). Mesh welding and Boolean input cleanup use a
  tolerance relative to the model's extent (documented per function). All numbers are IEEE doubles
  in the state; `Float32Array` copies exist only in renderer caches keyed by the sealed mesh object.
- Every solid has a stable `id` from `newId()`, kept across edits (an edit replaces the solid under
  the same id), undo/redo (states share objects) and save/load (the id is written to the file).

### Module layout

```
src/model3d/      document model, pure TypeScript, fully unit-tested in Node
  math.ts         Vec3, Mat4 (column-major), Plane, Ray, Aabb, Frame3
  mesh.ts         Mesh3D (plain arrays), validation, volume, closedness, welding, normals cache
  types.ts        Solid3D, Feature3D (parametric history), Profile3D, Model3D
  model.ts        add/remove/replace solids, lookup, bounds, DrawingState.model3d helpers
  primitives.ts   box, cylinder, sphere, cone, torus, wedge tessellation (closed, outward)
  sketch.ts       2D entities (polyline, circle, arc, ellipse, spline) -> planar Profile3D loops
  sweep.ts        extrude / revolve tessellation from a Profile3D
  budget.ts       triangle budgets, enforced by prepareDrawingState
  kernel/         GeometryKernel interface, Manifold implementation, worker transport
src/render3d/     viewport, GPU
  camera.ts       Camera3D (orbit/pan/zoom, ortho/perspective, view presets), pure math, tested
  gl/             GpuDevice: context, programs, buffers, id-buffer picking (the GPU seam, see below)
  viewport3d.ts   Viewport3D: draws Model3D + 2D plane underlay + grid + selection + gizmos
  picking.ts      CPU ray casting with a per-solid BVH; GPU id-buffer as the fast path
src/tools3d/      Tool implementations (same Tool/ToolContext contract as 2D, extended with 3D points)
src/io/dxf/       mesh3d-write.ts / mesh3d-read.ts: persistence (milestone 5)
src/app/experimental-3d.ts  flag wiring: commands, ribbon tab, viewport switch
```

`DrawingState` gains one optional field: `model3d?: Model3D` (`{ version: 1, solids: Solid3D[] }`).
A 2D drawing never has it; every existing code path ignores it; the undo history carries it for
free because states are whole snapshots.

### Solids, features and meshes

A `Solid3D` holds both a **feature** (the parametric recipe: primitive parameters, extrude of a
profile by a distance, revolve of a profile about an axis, Boolean of two child features) and the
**mesh** that recipe produced (closed, outward-facing triangle mesh in world coordinates). The mesh
is what the viewport draws, selection hits, snapping and measuring use, and what goes to DXF. The
feature is what editing re-evaluates (change a box height, the mesh is regenerated) and what the
JCad extension record in the file preserves. Solids read from a file whose history is unknown get
a `mesh` feature and can only be transformed, not re-parameterised; the UI says so.

Booleans are mesh Booleans (see kernel evaluation). Their result is a `boolean` feature whose
operands are the two input features; the operand solids are removed from the model (AutoCAD
behaviour). Re-evaluation of a Boolean re-runs the kernel.

### Tools, selection and snapping

3D tools implement the existing `Tool` interface. `ToolContext` is extended (optional members, so
2D tools and `tests/fake-context.ts` are untouched) with `point3(p: Point): Vec3` (the picked
3D point for a cursor position: a hit on a solid face, else the cursor projected onto the
construction plane), the active `Frame3` construction plane (UCS; default WCS XY), and the 3D
selection set. 2D commands keep working in the 3D viewport on the z = 0 plane. Object snaps in 3D:
vertex, edge midpoint, face centre, plus the 2D snaps projected onto the construction plane.

## Geometry kernel evaluation

Requirement: primitives, planar sketches, extrude, revolve, Boolean union/subtract/intersect of
solids, robust enough for a drafting user, licence-compatible with GPL-3.0-only, deliverable
inside an Electron renderer with a strict CSP and no native build step beyond what the repository
already has (Rust for the DWG writer). Candidates checked on 2026-10-12 (`npm view`):

| Candidate | Licence | Size (unpacked) | Kind | Verdict |
| --- | --- | --- | --- | --- |
| **manifold-3d 3.5.4** | Apache-2.0 | 2.8 MB (WASM about 1 MB) | Exact mesh Booleans on manifold (closed) meshes, guaranteed manifold output; actively maintained (release 2026-09) | **Adopt** for Booleans and mesh validation. Apache-2.0 is GPL-3 compatible. |
| opencascade.js 1.1.1 | LGPL-2.1-only (OCCT exception) | 67 MB; WASM tens of MB | Full B-rep (OCCT): fillets, STEP/IGES, exact surfaces | Rejected for now: last release 2023, very large download and start-up, custom build needed to trim; the stated scope does not need B-rep. Revisit if fillets/STEP become goals; the `GeometryKernel` interface is written so it could be slotted in. |
| three 0.186 + three-bvh-csg 0.0.18 | MIT | 20 MB (three) | Mesh CSG on BVH, approximate, known robustness gaps on coplanar faces; pulls in a whole render framework | Rejected: competing renderer implementation and weaker Boolean robustness than Manifold. |
| @jscad/modeling 2.13 | MIT | 1.6 MB | Pure JS BSP CSG | Rejected: BSP CSG is slow above a few thousand triangles and produces slivers; no manifold guarantee. |
| Own code (pure TS) | GPL-3 (ours) | - | Primitives, sketch flattening, extrude, revolve tessellation | **Adopt** for everything except Booleans: simple, deterministic, testable in Node, no dependency. |

Decisions:

- **Manifold runs in a dedicated Web Worker** (`src/model3d/kernel/manifold.worker.ts`) through an
  async `GeometryKernel` interface. A worker script loaded from its own URL is governed by its own
  response's CSP, not the document's, so the renderer CSP (`default-src 'self'`) stays unchanged;
  the UI thread never blocks on a Boolean; a kernel crash or memory failure is contained and
  reported as an error, like the DWG utility-process pattern. If the worker cannot start (WASM
  blocked or unavailable), Booleans are reported as "unavailable in this environment" and
  everything else still works. The security review document must gain a section for this before
  any release; see open decisions.
- Mesh input to the kernel is validated first (`validateMesh`, `meshIsClosed`); non-manifold input
  is refused with a message naming the solid, never "repaired" silently.
- Determinism: the same inputs give the same mesh; results are welded and re-validated before
  entering the state, and the triangle budget (`budget.ts`) applies to the result.

## Rendering and GPU coordination

Nothing GPU-related exists yet, so this branch defines the seam the planned GPU diagnostics and
a future shared 2D/3D renderer should plug into, without implementing the 2D side:

- `src/render3d/gl/device.ts` exports `GpuDevice`: owns the `WebGL2RenderingContext`, program
  compilation with error reporting, buffer management, a frame-timing query and a `capabilities()`
  report (vendor/renderer strings via `WEBGL_debug_renderer_info` when available, max texture size,
  float texture support, context-loss count). **This is the object GPU diagnostics should read.**
  `webglcontextlost` / `restored` are handled: the viewport rebuilds its buffers and reports the
  loss count.
- `Viewport3D` is a sibling of `Viewport`, not a replacement. The 2D Canvas renderer stays the
  renderer for 2D drawings and for paper space, untouched. In 3D mode the 2D entities are drawn as
  a planar underlay on z = 0 by projecting them with the 3D camera through a `SceneSink`
  interface (`line(a, b, style)`, `polygon(points, style)`) that the existing `drawEntity`
  geometry builders can feed. A future GPU 2D renderer would implement the same `SceneSink` over
  `GpuDevice`; that is the single place where the two tracks meet, and it is deliberately small.
- Picking: GPU id-buffer (one colour per solid, read back under the cursor) as the fast path, CPU
  ray casting against per-solid bounding-volume hierarchies as the exact path and the fallback
  when read-back is unavailable (headless tests, software GL). Both must agree; a test renders a
  known scene and compares.
- No three.js. The raw WebGL2 layer is a few files; it keeps the bundle small, keeps a single
  implementation and lets the GPU track reuse it.

## Persistence (DXF and DWG)

Implemented in milestone 5 (details and limits in [3D-FILE-FORMAT.md](3D-FILE-FORMAT.md)):

- Each solid is written as a DXF **polyface mesh** (`POLYLINE` flag 64 with `VERTEX` records):
  valid in every DXF version JCad writes (AC1015+) and the layout the DXF reference describes.
  The `MESH` (`AcDbSubDMesh`) entity would need AC1024; polyface is the compatible choice. Opening
  these files in AutoCAD or other programs has not been verified on this branch.
- Each polyface carries registered XDATA `JCAD_3D` (an `APPID` record, like `JCAD_TABLE`) with a
  bounded, versioned JSON payload: schema version, the solid's id, name and its `Feature3D`
  history, so a newer JCad can refuse or upgrade older payloads explicitly.
- Reading: the stored faces are authoritative (the feature history is never re-evaluated on
  load). A polyface with valid `JCAD_3D` data becomes a `Solid3D` with its history; malformed or
  newer payloads keep the mesh and record an import-report item. Solids JCad wrote are read back
  even when the experimental setting is off (they are hidden, never lost, and written back on
  save; the import report says so). A polyface **without** JCad data is imported as a
  `mesh`-feature solid only when 3D reading is enabled and reported as "not editable
  parametrically"; otherwise behaviour is unchanged (dropped and reported) so 2D users see exactly
  what they see today. DWG opens go through a separate converter that drops polyface meshes
  (`POLYLINE_PFACE`) and reports them; reading solids from DWG is unsupported on this branch.
- A file JCad could not reopen is never written: when the solids would exceed the DXF reader's
  default limits, Save and Save As refuse with the triangle count and the limit, and autosave
  writes the recovery copy without the solids and records the omission for the recovery dialog.
- DWG saving: the Rust writer refuses unknown records. DWG Save, Save As and EXPORTDWG of a
  drawing with solids are refused with a message to save DXF instead. **Solids are never dropped
  silently.** Teaching the writer is out of scope for this branch unless the owner asks (it is a
  Rust change with its own review).
- Round-trip tests cover ids, features, meshes (exact), layers and colours; 2D-only drawings
  produce byte-identical DXF to the starting commit (golden outputs guard this).

## Feature flag and isolation

- `UserSettings.experimental3d` (default false). Options dialog: a new **Experimental** section
  with the checkbox and a plain warning. Command `3DMODE` toggles the 3D viewport only when the
  flag is on; otherwise it says the feature is disabled and where to enable it.
- With the flag off: no 3D ribbon tab, no 3D commands registered, the 3D viewport is never
  created, no WebGL context is requested, no worker is started. Screenshot baselines and the UI
  click check are unaffected; `tests/` guards that `RIBBON` and the command list are unchanged
  when the flag is off.
- With the flag on: ribbon tab **3D** (Modelling, Edit, Boolean, View, Measure panels), the
  viewport switches to `Viewport3D` for model space (paper-space layouts always use the 2D
  renderer), and the status bar shows the construction plane and projection mode.

## Milestones

Each milestone ends with: typecheck, lint, the whole unit suite, the development build
(`npm run build`), the relevant Playwright/Electron check, a review by a separate reviewer, and an
entry in [3D-STATUS.md](3D-STATUS.md) stating what works, what was tested, what remains and what
is prototype-only. Work is committed on `feature/3d-development` only.

| # | Milestone | Scope | Depends on |
| --- | --- | --- | --- |
| 0 | Plan and scaffold | This document, status file, flag default, module skeleton | - |
| 1 | Document model | `model3d/` math, mesh, types, model helpers, primitives tessellation, budget, flag, save guard, tests | 0 |
| 2 | Viewport | Camera3D, `GpuDevice`, `Viewport3D` with grid, 2D underlay, solids, selection (GPU + CPU picking), orbit/pan/zoom, ortho/perspective, view presets, `3DMODE`, ribbon tab | 1 (math) |
| 3 | Modelling | Primitive tools (BOX, CYLINDER, SPHERE, CONE, TORUS, WEDGE), sketch to profile, EXTRUDE, REVOLVE, UNION/SUBTRACT/INTERSECT via Manifold worker, errors surfaced | 1, 2 |
| 4 | Editing | 3DMOVE, 3DROTATE, 3DSCALE with gizmo and typed input, 3D object snaps, DIST/measure in 3D, aligned dimensions on faces (prototype), Properties palette rows for solids | 2, 3 |
| 5 | Persistence | DXF polyface + `JCAD_3D` XDATA write/read, versioning, round trips, DWG refusal path, import report entries, SUPPORT-MATRIX and USER-MANUAL updates | 1, 3 |
| 6 | Hardening | Perf budgets for 3D (frame time at 2 M triangles, pick time), realistic model fixtures, fuzzed file inputs, context-loss recovery, 2D regression sweep, docs | all |

Parallel tracks: 2 and the non-UI half of 3 (sketch/sweep/kernel) start as soon as 1's math and
mesh modules exist; 5's writer can start with 1's types. Milestone 4 waits for 2 and 3.

## Testing strategy

- Pure modules (`model3d/*`, `render3d/camera.ts`, `render3d/picking.ts` CPU path, DXF read/write)
  get vitest unit tests with analytic expectations (volumes, areas, inverse round trips, hit tests
  from both windings, closedness) and property-style tests (random transforms preserve volume).
- WebGL cannot run in vitest. `Viewport3D` is tested by a Playwright script against the built
  renderer in headless Chromium with SwiftShader (`scripts/e2e-3d.mjs`): enables the flag, draws
  primitives, orbits, picks by click at known screen positions, compares GPU and CPU picking,
  checks no page errors, and takes screenshots stored outside the 2D baselines.
- 2D regression: the full existing suite plus `screenshot:compare` with the flag off must stay
  identical; a DXF byte-identity test covers 2D-only files.
- Performance: `tests/perf-3d.test.ts` (tessellation and Boolean times on fixtures, CPU pick on a
  2 M-triangle scene) with `JCAD_PERF_FACTOR`; a `bench:3d` phase in `scripts/bench.mjs` for frame
  time once the viewport exists.

## Owner decisions (2026-10-13)

1. **Kernel:** Manifold stays in the worker; the renderer CSP is unchanged; the worker gets its
   own restrictive CSP (bundled scripts and WASM only, no external loads). WASM never runs in
   the renderer thread. A worker shares the renderer process and is not described as complete
   memory or crash isolation.
2. **DWG:** DWG saves of drawings with solids stay refused; the Rust writer is not extended in
   this milestone; solids are never removed or downgraded to make a save succeed; the refusal
   explains that JCad DXF (Save / Save As DXF, autosave and recovery) preserves the model. DWG
   solid support, matching import and round-trip validation are a separate decision.
3. **Dimensions:** true 3D dimension entities with their measurement plane, correct
   measurements, saving/loading and undo/redo (`DIM3D`); the `3DDIM` prototype remains as an
   interim feature that clearly identifies projected measurements.
4. **E-19 / E-20 before any 3D release:** worker CSP implemented and verified; a hard WASM
   linear-memory maximum of 1 GiB with the operation limits, timeouts and graceful failures
   retained; operations the limit prevents are reported and the limit is only raised on request;
   both verified in a packaged (unpacked directory) Windows test build. No installer or
   publication yet; further work only on request.

## Decisions that need the owner's input

These do not block the milestones; defaults are stated and used until told otherwise.

1. **Kernel: Manifold (Apache-2.0) in a worker**, no CSP change. Alternative: add
   `'wasm-unsafe-eval'` to the renderer CSP and run it inline (simpler, needs a security-review
   update). Default: worker.
2. **DWG + 3D**: refuse DWG saves of drawings with solids (save DXF instead) versus extending the
   Rust writer. Default: refuse with a clear message; writer work only on request.
3. **Persistence record**: polyface mesh + `JCAD_3D` XDATA (compatible everywhere, large files for
   big meshes) versus `MESH` entity (AC1024+, compact). Default: polyface.
4. **Dimensions in 3D**: real 3D dimension entities are a large feature; the plan delivers
   measurement (DIST, AREA, VOLUME) as working features and face-aligned linear dimensions as a
   prototype that writes ordinary 2D dimension entities on the construction plane. Confirm this is
   acceptable or ask for more.
