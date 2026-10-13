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

Pending.

## Milestone 3: modelling

Pending.

## Milestone 4: editing

Pending.

## Milestone 5: persistence

Pending.

## Milestone 6: hardening

Pending.

## Known limitations (always current)

- 3D objects are not written to DXF or DWG files; saving a drawing that has them asks for
  confirmation and the saved file omits them. Recovery snapshots omit them too.
- DWG files are never written with 3D objects.
- Reading `3DSOLID`, `REGION`, `BODY` (ACIS) bodies is unsupported; they stay retained raw records.
