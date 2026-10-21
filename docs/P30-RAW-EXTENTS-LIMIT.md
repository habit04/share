# Priority 30 known limit — raw extents of constraint-dimension text

**Known limit (support-matrix wording):** raw extents of constraint-dimension
text are AutoCAD-render-computed; geometry/record parity is exact.

Status: measured and decomposed 2026-10-19; CLOSED as AutoCAD-computed and
unmatched by design (lead ruling, 2026-10-19, on the producer diagnosis).

## What the limit is

AutoCAD's reported `GeometricExtents` for a block record include the
*rendered* widths of dimension text. Those rendered widths are computed by
AutoCAD's own text renderer from the style's proportional font metrics and
exist **nowhere in the DXF file**: the MTEXTs in question store group 41 =
0.0 and no 42/43 box dimensions. JCad holds no SHX/proportional metrics for
the style's font, so it cannot reproduce the rendered widths from the file.

Consequence: JCad's raw (all-object) extents, computed from the file's group
values, can fall short of AutoCAD's *reported* extents by up to ~0.27 units
on constraint drawings whose invisible constraint dimensions place text at a
record's extremes. JCad's raw extents are, however, **identical to the
AutoCAD-authored control file's own group-value extents** — the difference is
AutoCAD vs its own file, not JCad vs AutoCAD.

## Measured against

Fixture: `P30_CONSTRAINT_WIDTH` (HANDBUILT priority-30 constraint fixture,
AutoCAD-authored control), oracle `oracle-measure.json` (AutoCAD-reported
GeometricExtents). Diagnosis at the F2-round-2/F4 head; exercised by the Q11
headless battery and the F2 and F4 Windows gates.

Per-instance (control oracle minus the control file's own group-value
union):

- Instances A and B: ΔminX = −0.263186, ΔmaxX = **+0.266869** (the “0.267”),
  ΔY = 0.
- Instance C is the same two boxes carried through its 30° rotation
  (corner-transform reproduces the oracle extents to ~1e-13 on all edges).

Producing objects: exactly two hidden (group-60 invisible)
constraint-dimension MTEXTs per record — the `30.0000` linear dimension
(rendered half-width 0.443186) and the `40.0000` linear dimension (rendered
half-width 0.446869). In each case the excess over the stored geometry is
exactly `rendered half-width − DIMEXE (0.18)`. The two strings differ purely
in their first digit, which is why their rendered widths differ by 0.007367
while any fixed-pitch estimate (including JCad's Hershey table) gives them
identical widths.

## What JCad does at and beyond the limit

- Geometry, record and model parity on the DXF surface is **exact**: a
  JCad write of the control reproduces the control's raw extents with delta
  0.0000 at every level (definition record, instance records, world
  instances, whole model, geometry-only).
- Constraint re-evaluation is unaffected: with the F4 fix (LWPOLYLINE
  group-91 vertex-ID preservation), JCad output re-solves in AutoCAD with
  geometry identical to the AutoCAD control (max delta 0 at the F4 gate).
- The shortfall appears only when JCad-computed raw extents are compared
  against AutoCAD-render-computed extents for this drawing class. It does
  not grow with drawing size; it is bounded by the rendered half-widths of
  whichever text objects sit at the extremes.

Related but separate picture-parity items (interior; never move a record
extent; **not** this limit): dimension pictures omit the three `Defpoints`
POINT entities AutoCAD stores (one picture edge short by exactly DIMEXO,
0.0625, on linear dimensions); radius-dimension text anchoring differs
(JCad's computed placement vs AutoCAD's MTEXT centered on the stored text
position). Any future picture-parity pass may address those without
affecting this closure.

## Deferred checks

AutoCAD GUI/Properties verification (including grips and the Properties
palette) remains DEFERRED: the AutoCAD GUI trial has expired and restoring
it is the product owner's decision. Nothing in this note depends on GUI
checks; every figure above comes from headless AutoCAD runs (AUDIT 0) and
file-level measurement at the Q11/F2/F4 gates.
