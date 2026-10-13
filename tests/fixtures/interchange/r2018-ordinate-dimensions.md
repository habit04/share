# Native ordinate dimension reference

This synthetic R2018 ASCII DXF contains 20 native ordinate DIMENSION entities, with their native anonymous picture blocks. AutoCAD 2027 Core Console generated them using DIMORDINATE/DIMTEDIT, then REGEN, AUDIT and DXFOUT in an isolated private profile. AUDIT found and fixed zero errors. No user drawing, installed preference, font program or private path is included. The installed `txt.shx` font was read only. ARC_DIMENSION is absent; arc-length support is outside this fixture and milestone.

The entity order is:

1. X coordinate 25, explicitly rotated text 20 degrees.
2. A copy of case 1 translated by (-180, -100) and directly rotated 35 degrees about the world origin.
3. A direct mirror of case 1 about the world Y axis, with MIRRTEXT=0.
4. X coordinate 65, explicitly rotated text 45 degrees.
5. X coordinate 105, explicitly rotated text 90 degrees.
6. Y coordinate 70, explicitly rotated text 20 degrees.
7. X short dogleg, feature (30, 100), endpoint (45, 105).
8. X dogleg with zero along-axis distance, feature (30, 125), endpoint (45, 125).
9. X dogleg with DIMSE1=1.
10. X dogleg with DIMSD1=1.
11. X dogleg with DIMTAD=1 (above).
12. X coordinate 265 with DIMTAD=1 and explicit text angle 20 degrees.
13. X coordinate 25 with DIMTAD=2 (outside), upward leader.
14. X coordinate 65 with DIMTAD=2, downward leader.
15. X coordinate 105 with DIMTAD=4 (below), upward leader.
16. X coordinate 145 with DIMTAD=4, downward leader.
17. X coordinate 185 with DIMTIH=1 and DIMTOH=1, manually moved text at (200, 5) and the literal override `OFFSET <>`.
18. X dogleg with DIMCLRD=1 and DIMCLRE=3.
19. X coordinate 25 in a UCS with origin (180, 160) and rotation 150 degrees.
20. Y coordinate 35 in the same UCS.

The base effective sizes are DIMTXT=2.5, DIMASZ=2.5, DIMEXO=0.625, DIMGAP=0.625, DIMSCALE=1, DIMDEC=2, DIMZIN=0 and DIMLFAC=1. Per-entity native DSTYLE overrides preserve the diagnostic variants.

The world XY ordinate definition is datum origin in group 10, feature in group 13 and leader endpoint in group 14. Group 70 has low type 6, bit 64 for X (absent for Y), and bit 128 only for manually positioned text. The datum angle is the negative of group 51, in degrees. Direct ROTATE/MIRROR keep group 51 fixed; a rotated block reference composes the datum frame. A text angle in group 53 is relative to that frame. Additional private native controls verify a 30-degree frame plus group 53=20 produces a 50-degree world text baseline, while a rotated block containing a local X coordinate 10 still measures 10 after native EXPLODE.

Native measurements and geometry provide independent regression values:

- Directly rotated case 2 measures 20.47880110722485; mirrored case 3 measures 25. Both retain group 51=0 and group 53=20.
- Cases 19/20 retain group 51=210 and measure 25/35 respectively; their natural world text angles are 240/150 degrees.
- Ordinate leaders have no arrows. Their dogleg bends use DIMASZ, with the first leg at least 2*DIMASZ and the final leg 2*DIMASZ; the usual bend is 4*DIMASZ before the endpoint. DIMEXO offsets the start.
- Cases 9/10/17 retain their settings but native ordinate geometry ignores those suppression/horizontal flags. Case 18's lines use DIMCLRE=3.
- Default centered placement uses visible text width, rather than trailing glyph advance. At height 2.5, `25.00` has native ink width 9.166666666666666 and advance 10; its ordinary center is 5.208333333333333 beyond the leader endpoint.
- Explicitly rotated text uses the intersection of the leader ray with the padded text rectangle. Cases 1 and 4 have endpoint-to-center offsets 1.99533332339238 and 2.65165042944958. Explicit text rotation overrides DIMTAD, as case 12 demonstrates.

Additional private native scaling controls use a local X coordinate 10 in an INSERT with scale 2 and rotation 30 degrees. The reference displays its local label `10.00` with physically scaled height 5 and DIMEXO 1.25. Native EXPLODE instead regenerates an editable coordinate 20 with unchanged height 2.5 and DIMEXO 0.625. Native standalone SCALE 2 likewise regenerates the measurement while preserving style sizes, including automatic DIMSCALE=0. These controls passed three AUDIT checks with zero errors. Current source with the read-only installed font passed 19 corresponding geometry/label comparisons at the same fixed 1e-8 tolerance.

Current validation is bounded to horizontal XY ordinate definitions and the tested native style/text modes. Non-XY data and unsupported attachment/spacing modes must refuse import rather than become a different editable dimension. Scaled (absolute scale other than 1), nonuniform/sheared or mirrored block display/explosion uses transformed local primitives to preserve the local label and appearance. EXPLODE produces those primitives; editable native EXPLODE regeneration parity is claimed only for the tested scale-1 rotation case. Normal DXF saving preserves the original editable block definition and INSERT. DWG reader/writer support and an ordinate creation tool remain outside this slice. Font programs remain session resources and are not embedded in this fixture.

JCad import/edit/undo/redo/DXF save/fresh reopen was independently checked by reopening and regenerating its actual output in AutoCAD, then running two AUDIT passes: both found and fixed zero errors. Twenty ordinate definitions passed 263 comparisons, including edited coordinates, a literal `X=<>` override and a manually moved text point. A second native run confirmed explicitly horizontal text encoded as group 53=360 remains distinct from automatic text placement after normalization. Current source geometry with the read-only installed font passed 214 native comparisons at a fixed 1e-8 numeric tolerance. Six actual Canvas/raster/vector-PDF pages additionally passed 66 cross-renderer checks using Poppler, with a fixed two-pixel bounds tolerance. Those rendering checks establish current-source consistency; they do not claim native PDF pixel equality.
