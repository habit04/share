# JCad 3D: milestone status

Working record for the `feature/3d-development` branch. See [3D-PLAN.md](3D-PLAN.md) for the
design. Legend: **works** = implemented and tested; **prototype** = runs but incomplete or
unvalidated, labelled as such in the UI; **unsupported** = not implemented, refused with a message.

Starting commit: `83aedbcc7b145ff87293a35d9001cb56f127a2b0` (tag `v0.4.8`).
Baseline on Windows x64, Node 22.23.3: typecheck, lint and 177 test files / 2,212 tests green.

## Milestone 0: plan and scaffold

- Works: plan and status documents.
- Tested: the existing suite is unchanged.
- Remains: everything else.

## Milestone 1: document model

Pending.

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
