# JCad 3D: milestone status

Working record for the `feature/3d-development` branch. See [3D-PLAN.md](3D-PLAN.md) for the
design. Legend: **works** = implemented and tested; **prototype** = runs but incomplete or
unvalidated, labelled as such in the UI; **unsupported** = not implemented, refused with a message.

Starting commit: `83aedbcc7b145ff87293a35d9001cb56f127a2b0` (tag `v0.4.8`).
Baseline on Windows x64, Node 22.23.3: typecheck, lint and 177 test files / 2,212 tests green.

## Milestone 0: plan and scaffold

- Works: plan and status documents; Node 22 toolchain and test binaries set up on the development machine.
- Tested: the existing suite is unchanged at the starting commit.

## Milestone 1: document model

- Works: `src/model3d/` math (Vec3, column-major Mat4, Plane, Ray, Aabb, Frame3 with
  orthonormality check), plain-array `Mesh3D` with validation, signed volume, surface area,
  closedness by edge topology, welding and cached flat normals; `Solid3D` / `Feature3D` /
  `Model3D` types; `DrawingState.model3d` (optional, sealed and undone like 2D state); model
  helpers; closed outward primitives (box, wedge, cylinder, cone, sphere, torus); triangle and
  vertex budgets enforced by `prepareDrawingState`; the `experimental3d` setting (default off).
- Works: saving a drawing that has solids asks for confirmation (DXF Save / Save As and DWG
  export share one helper); No cancels; without a desktop UI the save is refused; after Yes the
  file is written without the solids and the drawing stays marked modified so the close flow and
  recovery copy keep protecting them. Autosave records `omitted3d` in its metadata.
- Tested: 7 new vitest files (analytic volumes, matrix round trips, both triangle windings,
  degenerate frames, budget shortcuts, undo/redo of solids, every save-guard path); full suite
  184 files / 2,293 tests, typecheck, lint and `npm run build` green. Independent review done;
  all findings fixed.
- Remains: nothing is drawn yet (milestone 2); no file persistence (milestone 5).
- Known: `meshIsClosed` does not detect vertex pinches; welding is not transitive; sphere and
  torus are centred on their frame origin while box, wedge, cylinder and cone sit on it.

## Milestone 2: viewport

- Works: `src/render3d/` Camera3D (orbit, pan, zoom at cursor, orthographic and perspective,
  AutoCAD named view presets; the top view matches the 2D view exactly including twist),
  `GpuDevice` (WebGL2 context, programs, capabilities report, context loss and restore with a
  counter; the seam GPU diagnostics should read), flat-shaded solids, adaptive XY grid, WCS triad,
  the 2D drawing as an underlay through the `SceneSink` seam, selection and hover highlight, GPU
  id-buffer picking with CPU BVH picking as the exact path and fallback. Commands (flag on only):
  3DMODE, 3DORBIT, 3DVIEW <preset>, PLAN, 3DPERSPECTIVE, 3DZOOMEXTENTS; mouse: wheel zoom,
  middle drag pan, Shift+middle drag orbit, click / Shift+click / empty click selection; a `3D`
  ribbon tab and an Options checkbox. A failing GPU, shader or frame logs a message and returns
  to the 2D view; nothing changes when the flag is off (guarded by a test).
- Tested: 4 new vitest files (camera round trips and presets, 2D parity with twist, BVH vs brute
  force on 300 rays, scene sink, flag isolation); full suite 188 files / 2,348 tests, typecheck,
  lint, build green. Verified by the supervisor in Chromium on an Intel GPU: rendering, click and
  hover selection, GPU and CPU picks agree 240/240 in both projections, undo/redo of the demo
  scene, WebGL context loss + restore (picking still agrees), a synthetic render failure stops 3D
  mode cleanly with a log line and 3D mode re-enables afterwards. `scripts/e2e-3d.mjs` (npm run
  e2e:3d) automates the same checks in headless Chromium but could not be run from the
  development sandbox on this machine, so it is unverified as a script.
- Prototype: a left click while a 2D command runs in 3D mode feeds the cursor's z = 0 point to it
  without snaps or rubber band; no window selection in 3D; the view cube is a text label; all
  lines 1 px; `3DDEMO` is a development test scene only.
- Remains: modelling and editing tools (milestones 3 and 4); 3D object snaps; window selection.

## Milestone 3: modelling

- Works (core, no UI yet): `sketch.ts` turns closed polylines (with bulges), circles, ellipses,
  closed splines and chained lines/arcs into planar profiles with hole ordering, refusing open or
  self-intersecting loops with a message; `triangulate.ts` (ear clipping with holes);
  `sweep.ts` extrude and revolve (closed, outward for either sign; analytic volume tests);
  `feature-eval.ts` re-evaluates feature trees with depth and node limits; the Manifold 3.5.4
  (Apache-2.0) Boolean kernel runs in a module Worker with timeouts and one restart, inputs and
  results validated (closed, budget, winding), float32 recentring with exact coordinate restore,
  and an in-process variant for Node tests. The worker runs under the renderer's strict CSP;
  main-thread WebAssembly is never used. manifold-3d is a devDependency bundled by Vite.
- Tested: 5 vitest files (exact volumes: cube extrude 1, washer, half turn, two-cube
  union/subtract/intersect 1.5/0.5/0.5 within 1e-9, edge-touching union, refused open meshes,
  worker transport with a structured-clone fake worker: matching, timeout, crash, restart,
  pre-ready failure). Independent review done; all findings fixed. Measured: two-cube union
  0.7 ms in Node, 8-16 ms through the worker; 50k-triangle union 156-255 ms.
- Remains: the modelling commands (BOX ... TORUS, EXTRUDE, REVOLVE, UNION, SUBTRACT, INTERSECT),
  construction plane and previews (in progress on feature/3d-tools3d).
- Known: a timed-out Boolean recycles the worker and fails the other pending calls; closedness
  and welding checks of large operands run on the main thread (milestone 6).

## Milestone 4: editing

Pending.

## Milestone 5: persistence

- Works: solids are saved in DXF as polyface meshes (POLYLINE flag 64, VERTEX, SEQEND) carrying
  `JCAD_3D` XDATA with a versioned, size-bounded, strictly validated JSON history (id, name,
  feature). Round trips preserve ids, layers, colours, names, feature trees and meshes exactly.
  JCad-written solids are read back even with the setting off (hidden, never lost, written back
  on save, reported). Polyfaces from other programs become mesh solids only when 3D reading is
  on; otherwise the old drop-and-report behaviour is unchanged. Over-limit models are refused
  at Save / Save As with the triangle count and limit; autosave writes the copy without them and
  the Drawing Recovery Manager shows the omission. DWG Save, Save As and EXPORTDWG refuse
  drawings with solids with a message to save DXF. Undo after load works.
- Tested: 46+ tests (round trips of every feature kind, malformed and newer payloads, quads,
  bad indices, prototype-pollution keys, oversized chunks and payloads, parts out of range,
  nesting past the limit, polyfaces in blocks, colours, DWG refusals, autosave and recovery);
  golden DXF outputs of four fixtures prove byte-identical 2D files; the reviewer additionally
  confirmed identical output and import reports for all 25 fixture drawings. Full suite
  195 files / 2,465 tests green.
- Unsupported: reading solids from DWG files (the DWG converter drops polyface meshes and
  reports them); opening the files in AutoCAD or other programs has not been verified.
- Known: split meshes (over 32,767 vertices or faces) weld exact-duplicate vertices on read;
  negative zero reads as 0; solids keep an ACI colour only.

## Milestone 6: hardening

Pending.

## Known limitations (always current)

- DWG files are never written with 3D objects (Save, Save As and EXPORTDWG refuse; save DXF).
- Models whose DXF would exceed the reader's limits cannot be saved; reduce the model.
- Reading `3DSOLID`, `REGION`, `BODY` (ACIS) bodies is unsupported; they stay retained raw records.
