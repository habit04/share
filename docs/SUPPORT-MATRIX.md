# DXF / DWG support matrix

What JCad Electrical reads from DXF and DWG files, what it writes back, and what is lost on the
way. JCad is a 2D program: it works in the drawing plane and keeps 2D geometry. DXF is the native
format (written as AutoCAD 2000, `AC1015`); DWG is **read-only** (LibreDWG, versions R14 to 2018),
and SAVE after opening a DWG writes a DXF next to it.

Legend: **yes** = kept; **partly** = kept with the limits in the last column; **no** = not read or
not written (the object is dropped; on DWG import the dropped types are counted in the "Skipped
unsupported" line on the command line). Sources: `src/io/dxf.ts`, `src/io/dxf-layouts.ts`,
`src/io/dwg.ts`, `scripts/dwg-reader.mjs`; round trips are covered by `tests/dxf*.test.ts`,
`tests/dwg*.test.ts` and the fixtures in `fixtures/` and `tests/fixtures/`.

## Entities

| Entity | DXF read | DWG read | DXF write | Known losses |
| --- | --- | --- | --- | --- |
| LINE | yes | yes | yes | Z coordinates and thickness are dropped (2D). |
| CIRCLE, ARC | yes | yes | yes | Same. Circles and arcs inside a non-uniformly scaled block become polylines when exploded or drawn. |
| LWPOLYLINE | yes | yes | yes | Constant width (group 43) and bulges round-trip; per-vertex start / end widths (groups 40 / 41) are not read. A closed two-vertex polyline with bulges 1 and a width (a filled donut) is read as a filled circle. |
| POLYLINE (2D, with VERTEX) | yes | yes (POLYLINE2D) | as LWPOLYLINE | Read as a light-weight polyline. 3D polylines and polyface / polygon meshes are not read. |
| SOLID, TRACE | yes | yes (SOLID) | SOLID | Read as a filled closed polyline; written back as SOLID (three or four corners) or, with more corners, as a solid HATCH. |
| TEXT | yes | yes | yes | Style name, height, width factor, oblique angle, rotation, horizontal alignment (left / center / right) and fields are kept. Vertical justification (bottom / middle / top) is converted to the equivalent baseline position, so the justification mode itself is not written back; fit and aligned text keep their first point only. |
| MTEXT | yes | yes | yes | Format codes are kept verbatim while the text is unchanged and evaluated for display. |
| INSERT (block reference) | yes | yes | yes | Mirrored and non-uniform X / Y scales round-trip. Arrays (MINSERT rows / columns) and dynamic-block parameters are not kept (the block is inserted once). |
| ATTDEF, ATTRIB | yes | yes | yes | Tag, prompt, default and value, invisible flag, constant attributes, position, height and justification. |
| ELLIPSE | yes | yes | yes | Full and elliptical arcs. |
| POINT | yes | yes | yes | PDMODE / PDSIZE come from the header. |
| XLINE, RAY | yes | yes | yes | |
| DIMENSION | partly | partly | yes | Linear (rotated), aligned, radius, diameter and angular (2-line and 3-point, both read as angular) are kept with their style, DIMEDIT oblique angle and DIMTEDIT text rotation, and written with an anonymous `*D` picture block. Ordinate and arc-length dimensions are dropped (DWG import counts them as skipped DIMENSIONs). |
| SPLINE | yes | yes | yes | Fit points or control vertices, weights, closed / periodic flags. |
| HATCH | yes | yes | yes | Boundary loops (polyline and edge loops), pattern definition lines as stored in the file (the stored lines win, so ISO and double hatches draw as saved), solid fill. Gradient settings are not kept, and associativity to boundary objects is lost (the hatch keeps its own loops). |
| LEADER | yes | yes | yes | With its associated MTEXT. |
| MULTILEADER / MLEADER | yes | yes | as LEADER + MTEXT | Leader lines, landing and text are kept; block content is not drawn (a note says so on open). Written back as a LEADER with MTEXT, not as a MULTILEADER. |
| IMAGE (+ IMAGEDEF) | yes | yes | yes | The bitmap file is referenced by path (absolute or relative to the drawing); the clip boundary, brightness, contrast and fade are written. The desktop app draws `.png` / `.jpg` / `.gif` / `.bmp` / `.webp` up to 50 MB; other formats (and every bitmap in the browser edition) show as a frame with the file name. |
| ACAD_TABLE | yes (with cell data) | yes | as INSERT + XDATA | A table is written as an insert of an anonymous block (other programs show its picture) carrying the cells in `JCAD_TABLE` XDATA, which JCad reads back as a table. Other programs see a block, not an editable table. |
| VIEWPORT (paper space) | yes | yes | yes | Rectangular viewports with their frozen layers (DXF); non-rectangular clipping is not supported. DWG import reads the layouts' viewports, but layers frozen per viewport (VPLAYER) are not exposed by the DWG reader, so such viewports show every layer (the import report says so). |
| External references (xref blocks) | yes | yes | yes | Kept as references and drawn as a named frame; the referenced file is not loaded. |
| WIPEOUT, 3DFACE, 3DSOLID, REGION, BODY, MESH, MLINE, TOLERANCE, OLE2FRAME, SURFACE, LIGHT, UNDERLAY (PDF / DGN / DWF) | kept (DXF) | no | as read | Not drawn or edited. The import report (IMPORTREPORT) lists every such object: unknown ENTITIES records of a DXF are kept with the drawing and written back as they were on save; what cannot be kept is dropped, and saving over the original file asks first (Save As keeps the original). DWG import counts them as skipped. |

## Drawing-level data

| Item | DXF read | DWG read | DXF write | Known losses |
| --- | --- | --- | --- | --- |
| Layers | yes | yes | yes | Colour (ACI), linetype, lineweight, on / off, frozen, locked, no-plot (DXF), true colour (group 420 in DXF; a DWG layer with colour index 256 carries its RGB). Layer transparency is not read. |
| Linetypes (LTYPE) | yes | yes | yes | Dash patterns (group 49). Text or shapes embedded in complex linetypes are not drawn; only the dashes are. |
| Text styles (STYLE) | yes | yes | yes | Name, font file / TrueType family, big font, height, width factor, oblique, flags. |
| Dimension styles (DIMSTYLE) | yes | yes | yes | Every DIM* group code; arrowheads, tolerances and alternate-unit placement in `JCAD_DIMSTYLE` XDATA; arrow blocks of other programs resolved by handle. |
| Blocks and attributes | yes | yes | yes | Nested blocks, base point, description. Unused library blocks are left out on save. |
| Named views (VIEW) | yes | no | yes | |
| Header variables | partly | partly | partly | Kept: $INSUNITS, $LUNITS / $LUPREC, $AUNITS / $AUPREC, $LIMMIN / $LIMMAX, $LTSCALE, $CELTSCALE, $CELTYPE, $CELWEIGHT, $CLAYER, $TEXTSTYLE, $PDMODE / $PDSIZE, $DIMSTYLE and the current style's $DIM* variables, $CANNOSCALE, $ANNOALLVISIBLE, $TDCREATE / $TDUPDATE; $DWGCODEPAGE is used to decode older files. DWG import reads units, limits and the dimension variables. Every other header variable is dropped. |
| Layouts (paper space) | yes | yes | yes | `*Paper_Space` blocks, LAYOUT objects in `ACAD_LAYOUT` (paper size, margins, plot scale); from DWG the LAYOUT objects and their paper-space blocks (a lone, untouched Layout1 is not kept). A drawing always opens in the Model tab. Plot style tables (CTB / STB) are not read. |
| Annotative objects | yes | no | yes | `AcadAnnotative` XDATA; one annotation scale per object. |
| Fields | yes | partly | yes | Evaluated on open, written back as field codes; DWG keeps most fields in FIELD objects, which are read as their last displayed value. |
| Groups, object data, other XDATA / XRECORDs | no | no | no | Only the XDATA applications listed above are read; everything else is dropped. |
| Handles | no | no | new | Handles are reassigned on save; references from outside the file to object handles do not survive. |

## Colours

| | Read | Write | Notes |
| --- | --- | --- | --- |
| ACI index colours 1-255 | yes | yes | Displayed with the standard AutoCAD palette (`src/render/palette.ts`); 7 is white on the dark background and black on paper. |
| ByLayer | yes | yes | |
| ByBlock (0) | yes | yes | Kept as colour 0 and written back; when drawn, block content with ByBlock takes the reference's colour (or the reference's layer colour when the reference is ByLayer); ByBlock left on a top-level entity draws as the layer colour. Entities on layer 0 with colour ByLayer inside a block take the insert's layer and colour (AutoCAD behaviour). |
| True colour (group 420) | yes | yes | On entities and layers. |
| Colour books, transparency (group 440) | no | no | Shown in the nearest ACI colour / opaque. |

## Fonts and text

All text is drawn with a single-stroke vector font (Hershey Roman Simplex, `src/render/fonts/rowmans.jhf`)
whatever font the style names, so line breaks and widths can differ slightly from the original
program. The style's font file / TrueType family is kept and written back. In vector PDF output,
TrueType-style text becomes PDF text and stroke-font text becomes paths. Text in pre-2007 DXF
files is decoded from `$DWGCODEPAGE`; the writer produces pure ASCII with `\U+XXXX` escapes, so
non-English text survives any code page.

## Electrical data

JCad's schematic data travels as ordinary DXF / DWG content in the conventions of AutoCAD
Electrical, so it survives a round trip through other programs that keep blocks and attributes:

| Data | Stored as | Survives other CAD programs |
| --- | --- | --- |
| Component tags, descriptions, catalog data, locations, ratings, terminals | Attributes on block references (`TAG1`, `DESC1-3`, `MFG`, `CAT`, `INST`, `LOC`, `RATING1-12`, `TERM01`...) | yes, when the program keeps attributes |
| Wires and wire numbers | Lines on `WIRES*` layers; wire numbers as text on the wire-number layer | yes |
| Drawing settings (units, ladder, reference style) | Attributes of the `WD_M` block | yes |
| Project (drawing list, title-block data, report templates) | A separate `.jcadproj.json` file | not part of the DXF |

## Not supported at all

- Writing DWG.
- 3D geometry and 3D views (only the XY projection of 2D-capable entities is read).
- Parametric constraints, dynamic-block actions, sheet sets, data links, digital signatures.
