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
- Works (commands, flag on): BOX, WEDGE, CYLINDER, CONE, SPHERE, TORUS, EXTRUDE, REVOLVE,
  UNION, SUBTRACT, INTERSECT and 3DPLANE (World / XY / XZ / YZ / Face / Origin) with
  AutoCAD-style prompts, typed `x,y,z` and `@dx,dy,dz` input on the construction plane,
  translucent previews in the 3D viewport, ERASE of solids, Properties rows for solids, and
  ribbon panels Modelling / Boolean / Plane. Booleans run asynchronously in the worker, refuse
  input while computing, discard the result if an operand changed meanwhile, and one Undo
  restores every operand. See [3D-MODELLING.md](3D-MODELLING.md) for the input sequences.
- Tested: 5 tool test files (50 tests, including a replay of the documented sequences against a
  real Editor and Booleans through the in-process kernel); full suite 200 files / 2,515 tests
  green. Verified by the supervisor in Chromium through the worker kernel: BOX volume 500,
  CYLINDER 224.7 (32 segments), EXTRUDE of a rectangle 24, UNION of two boxes 12, SUBTRACT 10
  with the nested feature tree kept under the first operand's id, Undo restoring operands.
- Prototype: no 3D object snaps yet (milestone 4); one profile per EXTRUDE; no Taper / Path
  options; new solids take the current layer and colour rather than the source object's; the
  construction plane is session-only; ribbon buttons reuse 2D icons.
- Known: a timed-out Boolean recycles the worker and fails the other pending calls; closedness
  and welding checks of large operands run on the main thread (milestone 6).

## Milestone 4: editing

- Works (flag on): 3DMOVE, 3DROTATE (axis X/Y/Z of the plane or two points, typed or reference
  angle), 3DSCALE (factor or reference) transforming mesh and feature history together in one
  undo step; the 2D MOVE, COPY, ROTATE, SCALE and MIRROR commands carry selected solids along
  with 2D objects (COPY and MIRROR give new ids; mirrored solids keep positive volume); 3D object
  snaps END / MID / CEN / NEA on the face under the cursor, following the OSNAP toggles and
  aperture, with the 2D-style marker; bounding-box grips with a centre-grip move; 3DDIST,
  3DMASSPROP (volume, surface area, bounding box, centroid), 3DAREA on a planar face, and DIST
  reporting 3D and planar distances in 3D mode; editable primitive parameters in the Properties
  palette re-evaluating in place under the same id (Boolean solids re-run in the worker). Ribbon
  panels Edit and Measure. See [3D-EDITING.md](3D-EDITING.md).
- Tested: 5 tool test files (130 tests: transforms re-evaluated from their histories match the
  transformed meshes within 1e-6 for every feature kind, mirror keeps volume positive, snaps
  from rays, analytic measurements, dimension entity shape, parameter edits, undo). Full suite
  207 files / 2,657 tests, typecheck, lint, build green. Verified by the supervisor in Chromium:
  the documented replay (box moved to x 20..30 / z 3..8 and back, rotated about Z then X,
  scaled to 4,000 and back to 500 by reference, 3DDIST 13.0000 with planar 5.0000, 3DDIM text
  4.0000 undone cleanly, MASSPROP 500 / 400 / centroid 15,-2.5,5), an endpoint snap on a box
  corner feeding 3DDIST, and 9 grip points on a selected box.
- Prototype: 3DDIM writes an ordinary 2D aligned dimension on the drawing plane and refuses
  planes not parallel to WCS XY; true 3D dimension entities are unsupported. Only the centre grip
  does anything; there is no transform gizmo; snaps on curved faces land on tessellation
  vertices; the 2D modify commands transform solids in the WCS XY plane, not the construction
  plane.
- Remains: hardening (milestone 6).

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

- Works: `tests/perf-3d.test.ts` with budgets scaled by `JCAD_PERF_FACTOR` (heavy cases behind
  `JCAD_BENCH`, `npm run bench:3d`); deterministic realistic fixtures under `tests/fixtures/3d/`
  (an electrical enclosure with shell, door, mounting holes, DIN rails and 40 components built
  with the kernel; a cable tray; the demo schematic with solids) checked for closedness, volumes
  and byte-identical rewrite; seeded mutation fuzzing of `JCAD_3D` payloads and polyface records
  (only `DxfReadError` escapes, every drop is reported, states stay sealed and within budget) and
  of feature trees fed to the evaluator; `Model3DInputError` separates user input errors from
  engine errors; `describeModel3DError` for the command line; the kernel worker queues requests
  until ready and times out per request; `weldVertices` and `meshIsClosed` use hash tables
  (12-20x and 6x faster, equivalence-tested); WASM memory facts covered by a test;
  SECURITY-REVIEW E-19 / E-20 and a PERFORMANCE 3D section; [3D-TESTING.md](3D-TESTING.md)
  lists which errors reach the user. Bugs found and fixed on the way: saved revolves with a
  segment count reopened as plain meshes; out-of-range primitives produced zero- or
  infinite-volume meshes silently; a null profile frame threw a TypeError; a point near the
  revolve axis produced an open mesh; a race in the worker transport test.
- Measured (i7-12850HX, Node 22): all primitives at maximum detail 6-13 ms; extrude with 10
  holes 1-5 ms; revolve 100 x 256 9-41 ms; closedness / weld / volume on 500k triangles
  111-137 / 306-508 / 30-67 ms; BVH build for 2M triangles 4.3-6.8 s (first pick only);
  pick 0.01-0.02 ms per ray; DXF write / read of 100k triangles 0.4-0.6 / 0.9-1.4 s; sealing a
  2M-triangle model 0.95-1.8 s; Manifold union of two 50k-triangle spheres 280-373 ms.
- 2D regression: the whole existing suite, the golden DXF outputs and the screenshot /
  UI-click / Electron end-to-end jobs in CI (run on every push of this branch) pass with the
  flag off; CI run 38336811063 and later are green.
- Tested: full suite 213 files / 2,698 tests, three typechecks, lint, fixtures, workflows and
  build green on the final commit.
- Remains / known: sealing and the first-pick BVH build run on the UI thread (a 2M-triangle
  model pauses for about a second); closedness and weld checks of large Boolean operands run on
  the main thread; an over-budget Boolean is refused only after it was computed; `bench:3d` is not wired into CI;
  `scripts/e2e-3d.mjs` could not be run from the development sandbox, so it is unverified as a
  script (its checks were performed by hand in Chromium instead).

## Milestone 7: true 3D dimensions and the owner's decisions (2026-10-13)

- Works: `DIM3D` creates aligned, linear (X or Y of the plane) and angular dimension entities
  in a measurement plane (the current construction plane, a solid face, or three points) with
  a text override option; they are drawn with the 2D dimension geometry mapped into the plane,
  selectable and hover-highlighted (depth-aware against solids), carried by ERASE, 3DMOVE /
  3DROTATE / 3DSCALE and the 2D modify commands, editable in Properties (kind, measurement,
  text, layer, colour, plane; mixed selections edited together), one undo step per command.
  Saved as real DXF `DIMENSION` records in their plane (extrusion normal, OCS text point, own
  `*D` block, `JCAD_3D` data for the id and projected flag); exact round trips in seven planes
  including negative normals; re-saves byte-identical; 2D files unchanged (golden tests).
  Foreign dimensions with a (0,0,-1) normal read correctly when 3D is on. The interim `3DDIM`
  prototype labels projected measurements (`<> (projected)`) and logs the true 3D distance.
- E-19 mitigated: the Electron build serves the kernel worker from `assets/worker/` with its
  own CSP (`default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';
  base-uri 'none'`) decided from the served real path; the renderer CSP is unchanged.
- E-20 mitigated: the worker refuses WebAssembly memory growth past `KERNEL_MEMORY_LIMIT_BYTES`
  (1 GiB); a refusal that Emscripten's smaller retry recovers from is not an error; a final
  refusal is a `memory-limit` KernelError, the worker is replaced and the model unchanged; the
  500k-triangle operand limit, the per-request timeout and the single restart are retained.
  Measured peak heap: unit cubes and the fixtures 16 MiB, two 50k-triangle spheres 33-58 MiB,
  two 499,712-triangle operands up to 503 MiB (union and subtract refused by the result budget,
  intersect fine), facets crossing everywhere at 250k operands 876 MiB (result over budget);
  only a pathological 499,712-triangle everything-crossing union hits the cap (uncapped it needs
  1.8 GiB, 28.6 s and 4.99M triangles, over the budget and the timeout anyway). No operation
  whose result fits the budget fails at 1 GiB.
- Verified: `npm run e2e:3d-security` against the development build (19/19, also on the final
  merged commit) and against an unpacked Windows test build made without the Rust DWG helper
  (`npm run dist:test:no-dwg`, electron-builder directory output, no installer) at the security
  branch state: 20/20, run by the implementer and again by the supervisor. A rebuild of that
  test build from the final merged commit could not be launched on the development machine:
  Windows Application Control blocked the newly built unsigned executable ("An Application
  Control policy has blocked this file"), a machine policy that was left untouched. The merge
  added only the dimension work and documentation, none of the kernel, worker, CSP or packaging
  code, so the packaged result stands for the same control code; rerun the packaged check on a
  machine that allows the test build before any release. An installed, signed release build,
  macOS and Linux are not verified.
- Wording: a worker shares the renderer process; it is not memory or crash isolation (a docs
  test guards this). DWG saves of drawings with solids or 3D dimensions stay refused and the
  message states that JCad DXF and recovery copies keep the model (within the file limits).
- Tested: 4 new test files for dimensions (analytic measurements in tilted planes, DXF subclass
  sequences, OCS round trips, foreign rotated records, fuzzing), memory-limit and security-docs
  tests, a test that every `[A/B]` prompt option click selects its own option. Full suite 217
  files / 2,757 tests on the dimension branch, 215 / 2,732 on the security branch; the merged
  result is recorded below under "Final verification".
- Prototype / known: no grips on dimensions; the 2D view and plots do not show 3D dimensions;
  stroke text reads mirrored from behind; no associativity with solids; opening the DXF records
  in AutoCAD is unverified; the residual E-19 note that in-page plugin code could request the
  test hooks (no privilege gained) remains documented.
- 2D change to note: command-line option clicks now send the option's capital letters, which
  fixes pre-existing prompts whose click picked the wrong option (ON/OFF, eXit, WPolygon,
  FILLET Multiple and others); `?` now sends itself instead of Enter.

## How to try it

1. `npm ci`, `npm run build`, `npm start` (or `npm run dev` for the browser edition).
2. Options > Files > Experimental: tick "3D modelling", restart.
3. Ribbon tab **3D** or type `3DMODE`, then `BOX`, `CYLINDER`, `EXTRUDE`, `UNION`, `3DMOVE` and
   so on; `3DDEMO` adds a test scene. Input sequences: [3D-MODELLING.md](3D-MODELLING.md) and
   [3D-EDITING.md](3D-EDITING.md). File format: [3D-FILE-FORMAT.md](3D-FILE-FORMAT.md).


## Known limitations (always current)

- Everything is behind the `experimental3d` setting (default off) and labelled experimental.
- DWG files are never written with 3D objects (Save, Save As and EXPORTDWG refuse; save DXF).
  Reading solids from DWG files is unsupported (polyface meshes are dropped and reported).
- Models whose DXF would exceed the reader's limits cannot be saved; reduce the model.
- Reading `3DSOLID`, `REGION`, `BODY` (ACIS) bodies is unsupported; they stay retained raw records.
- Opening JCad's polyface files in AutoCAD or other programs has not been verified.
- 3D dimensions (DIM3D) are not shown in the 2D view or plots and have no grips; 3DDIM remains
  an interim 2D-dimension prototype that labels projected measurements. No fillets, chamfers,
  shells, surfaces, assemblies or drafting views.
- Only the centre grip moves a solid; there is no transform gizmo; 2D modify commands transform
  solids in the WCS XY plane; snaps on curved faces land on tessellation vertices.
- Solids keep an ACI colour only; new solids take the current layer and colour.
