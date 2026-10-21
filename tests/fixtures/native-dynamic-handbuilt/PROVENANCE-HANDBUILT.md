# P30_LINEAR_STRETCH N1 fixture — HAND-BUILT dynamic definition, AutoCAD-evaluated

**Label: HANDBUILT. Not authored in the AutoCAD Block Editor.** Recipe r6 §1 asks for Block Editor
authoring; that was not possible on this PC (AutoCAD Electrical 2027 GUI trial expired; the headless
`accoreconsole` engine has no Block Editor). Justin approved this labeled substitute on 2026-10-17.

## How it was produced
1. **Plain block (AutoCAD-authored):** headless `accoreconsole` (AutoCAD 2027, ACADVER 26.0, acad.dwt,
   INSUNITS=1) `entmake` of BLOCK `P30_LINEAR_STRETCH` at (0,0): closed LWPOLYLINE (0,0)(100,0)(100,60)(0,60),
   CIRCLE (30,30) r10, LINE (70,20)-(90,40), ATTDEF TAG1 "Plate ID" default P-100 at (10,45) h5 Left
   Standard lock-position; `DXFOUT` R2018 → `base.dxf`.
2. **Dynamic objects (HAND-WRITTEN by Claude, `inject.py`):** extension dictionary → `ACAD_ENHANCEDBLOCK`
   → `ACAD_EVALUATION_GRAPH` with 5 nodes / 4 edges: BLOCKLINEARPARAMETER `Distance1` (0,30)→(100,30),
   list 80/100/120/140, default 100; BLOCKLINEARGRIP end grip (100,30); 2× BLOCKGRIPLOCATIONCOMPONENT;
   BLOCKSTRETCHACTION `Stretch1` on the end point, frame (60,-5)-(110,65), selection = plate (vertices 1,2)
   + inner line (both endpoints), multiplier 1, offset 0. Object layout copied from Autodesk's shipped
   sample block "Aluminum Window (Elevation) - Metric" (`Sample/en-us/Dynamic Blocks/Architectural - Metric.dwg`).
3. **AutoCAD acceptance + evaluation (native):** headless AutoCAD opened the hand-built DXF; `AUDIT` →
   **0 errors**; it preserved every dynamic object through its own save; `IsDynamicBlock = true`.
   A small .NET measurement plugin (`plugin/P30Measure.cs`, loaded from a folder trusted only inside the
   isolated throwaway profile, reset afterwards) inserted A (0,0) 0° untouched, B (200,0) 0° Distance1=120,
   C (400,0) 30° Distance1=120 through AutoCAD's `DynamicBlockReferenceProperty` API, recorded AutoCAD's
   evaluation to `oracle-measure.json`, and saved `p30-linear-stretch-HANDBUILT.dwg` (current format)
   and `.dxf` (R2018 ASCII, 16 dp).

## What AutoCAD reported (native evaluation of the hand-built definition)
| | A | B | C |
|---|---|---|---|
| Block | named P30_LINEAR_STRETCH | `*U2` (anonymous) | `*U2` (same record as B) |
| Distance1 / allowed | 100 / [80,100,120,140] | 120 | 120 |
| Plate | (0,0)(100,0)(100,60)(0,60) | (0,0)(120,0)(120,60)(0,60) | same as B |
| Inner LINE | (70,20)-(90,40) | (90,20)-(110,40) | same as B |
| Circle / TAG1 def | (30,30) r10 / (10,45) | unchanged | unchanged |
| World extents | (0,0)-(100,60) | (200,0)-(320,60) | (370,0)-(503.923048454,111.961524227) |
| TAG1 ATTRIB | (10,45) | (210,45) | (386.160254038,43.971143170) |

All of recipe §3.3 and E1–E4 are confirmed. Q7 observed: equal values share one anonymous record.
Extra native observation: AutoCAD also exposes an `Origin` dynamic property (0,30) for the linear parameter.

## Limits (do not over-read)
- The parameter/action **authoring** is hand-built; Block-Editor-authored byte layout, GUIDs and default
  object flags may differ. The **evaluation** numbers are AutoCAD's own.
- Instance values set via the API, not the Properties palette; no grip drags.
- Not run: GUI reopen/Properties M0, R2000 save-down (Q10), Q11 third-party re-evaluation, Q12/Q13.
