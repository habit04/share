# Native block arrays

JCad retains rectangular INSERT arrays using native row and column counts and spacing. Grid
spacing is measured in drawing units and rotated by the reference angle; the block's scale
changes its contents without changing grid spacing. Rendering, hit testing, bounds, snaps,
exploding, component reports and the bill of materials account for every cell.

The Properties palette can edit counts and signed spacing. Counts must be integers from 1 to
65,535. Accepted drawings must also fit the shared geometry-work budget. Counts and nested
block costs are multiplied before expansion, so a small array referencing a large block can
reach the budget before a larger array referencing a simple block. Invalid or excessive edits
leave the original drawing unchanged.

Native MINSERT shares one attribute set across the grid. JCad's electrical audit warns about
this, because independent component tags and electrical connectivity require separate block
references. Component and BOM reports count physical instances; wire/terminal/PLC analysis
does not treat the grid as independently tagged components. Explode the array before assigning
independent electrical identities.

DXF export uses the native `AcDbMInsertBlock` class with INSERT groups 70, 71, 44 and 45. The
pinned LibreDWG converter omits the MINSERT dispatch case, so the desktop and browser readers
share a local conversion adapter that routes that case through the ordinary INSERT converter.
It keeps native objects and pointers unchanged and does not patch the installed dependency.

`tests/fixtures/interchange/r2018-minsert.dxf` and `.dwg` were generated from JCad's own six-cell
test drawing and normalized by installed AutoCAD 2027 using AUDIT, DXFOUT and SAVEAS 2018.
They contain a single line in a block with a nonzero base point, unequal scales and a rotated
3 by 2 grid. AUDIT reported zero errors. The tests compare every cell's geometry after native
DWG import and DXF re-export. These fixtures contain no Autodesk vendor samples.

Native group definitions and rotation behavior are documented in Autodesk's
[INSERT DXF reference](https://help.autodesk.com/cloudhelp/2021/ENU/AutoCAD-DXF/files/GUID-28FA4CFB-9D5E-4880-9F11-36C97578252F.htm)
and [MINSERT command reference](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-Core/files/GUID-A780A2FA-4A2E-4574-950F-E788AB71F527.htm).
