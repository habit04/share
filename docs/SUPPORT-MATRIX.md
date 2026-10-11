# DXF / DWG support matrix

What JCad Electrical reads from DXF and DWG files, what it writes back, and what is lost on the
way. JCad is a 2D program: it works in the drawing plane and keeps 2D geometry. DXF is the native
format (written as AutoCAD 2000, `AC1015`); DWG is **read-only** (LibreDWG, versions R14 to 2018),
and SAVE after opening a DWG writes a DXF next to it.

Legend: **yes** = kept; **partly** = kept with the limits in the last column; **no** = not read or
not written (the object is dropped; on DWG import the dropped types are counted in the "Skipped
unsupported" line on the command line). Sources: `src/io/dxf/` (the reader is `reader.ts` and
`read-*.ts`, the writer `writer.ts` and `write-*.ts`), `src/io/dxf-layouts.ts`, `src/io/dwg.ts`,
`scripts/dwg-reader.mjs`; round trips are covered by `tests/dxf*.test.ts`, `tests/dwg*.test.ts` and
the fixtures in `fixtures/` and `tests/fixtures/`.

## Entities

| Entity | DXF read | DWG read | DXF write | Known losses |
| --- | --- | --- | --- | --- |
| LINE | yes | yes | yes | Z coordinates and thickness are dropped (2D). |
| CIRCLE, ARC | yes | yes | yes | Same. Circles and arcs inside a non-uniformly scaled block become polylines when exploded or drawn. |
| LWPOLYLINE | yes | yes | yes | Constant width (group 43) and bulges round-trip; per-vertex start / end widths (groups 40 / 41) are not read. A closed two-vertex polyline with bulges 1 and a width (a filled donut) is read as a filled circle. *Verified by fixtures:* `interchange/r2000-hatch-curves.dxf` (bulges, width 43; widths 40 / 41 dropped). |
| POLYLINE (with VERTEX) | partly | partly | as LWPOLYLINE | 2D polylines retain their outline and bulges. 3D polylines are flattened to XY and reported; polyface / polygon meshes are dropped and reported. |
| SOLID, TRACE | yes | yes (SOLID) | SOLID | Read as a filled closed polyline; written back as SOLID (three or four corners) or, with more corners, as a solid HATCH. |
| TEXT | yes | yes | yes | Style name, height, width factor, oblique angle, rotation, horizontal alignment (left / center / right) and fields are kept. Vertical justification (bottom / middle / top) is converted to the equivalent baseline position, so the justification mode itself is not written back; fit and aligned text keep their first point only. |
| MTEXT | partly | partly | partly | Formatting source, chunks and UTF-8 survive. Static/dynamic column definitions are read from native groups or R2018 embedded objects; explicit `\N` breaks render in separate columns. Column dimensions survive JCad edits and reimport through `JCAD_MTEXT_COLUMNS` XDATA. AutoCAD 2000 export displays one MTEXT column in external CAD; automatic column flow is approximated and reported. Background fill is dropped and reported. *Verified:* `interchange/r2018-mtext.dxf`. |
| INSERT (block reference) | yes | yes | yes | Mirrored and non-uniform X / Y scales round-trip. Arrays (MINSERT rows / columns) and dynamic-block parameters are not kept (the block is inserted once). *Verified by fixtures:* `interchange/r2000-nested-blocks-xref.dxf` (three nesting levels). |
| ATTDEF, ATTRIB | yes | yes | yes | Tag, prompt, default and value, invisible flag, constant attributes, position, height and justification. *Verified by fixtures:* `interchange/r2000-layouts-titleblock.dxf` (paper-space title block, an ATTRIB hidden on one insert). |
| ELLIPSE | yes | yes | yes | Full and elliptical arcs. *Verified by fixtures:* `interchange/r2000-hatch-curves.dxf`. |
| POINT | yes | yes | yes | PDMODE / PDSIZE come from the header. |
| XLINE, RAY | yes | yes | yes | |
| DIMENSION | partly | partly | yes | Linear, aligned, radius, diameter and angular dimensions retain styles and anonymous `*D` pictures, including dimensions inside blocks. Supported per-entity ACAD DSTYLE variables are applied and written independently of the named style. Unknown override groups are reported. Two-line angular dimensions export as three-point angular dimensions. Ordinate/arc-length dimensions are dropped and reported. DWG support depends on exposed variables/XDATA. *Verified:* both dimension fixtures. |
| SPLINE | partly | partly | yes | Fit points or control vertices, weights, closed / periodic flags. Imports exceeding 2,000,000 calculated basis-work units or a 128-row fit-interpolation matrix are dropped with a source warning before expensive evaluation/allocation. *Verified by fixtures:* `interchange/r2000-hatch-curves.dxf` (fit points with end tangents, rational). |
| HATCH | partly | partly | yes | Loops, bulges, stored pattern lines and solid fill survive. Boundary association links are lost and reported; export writes non-associative flag 71 = 0 while retaining loop geometry. DWG boundaries that cannot be reconstructed become reported outline approximations. Counts are bounded by available records; spline work limits also apply to hatch edges. Arc/ellipse sampling is capped at 64 samples per edge; derived coordinate overflow is dropped and reported. Gradient settings are not retained. *Verified:* `interchange/r2000-hatch-curves.dxf`. |
| LEADER | yes | yes | yes | With its associated MTEXT. |
| MULTILEADER / MLEADER | yes | yes | as LEADER + MTEXT | Leader lines, landing and text are kept; block content is not drawn (a note says so on open). Written back as a LEADER with MTEXT, not as a MULTILEADER. |
| IMAGE (+ IMAGEDEF) | yes | partly | yes | Paths resolve after model space, blocks and layouts have all been read, including late IMAGEDEF objects. Clip boundary, pixel vectors and display adjustments survive. Missing definitions/paths are reported. Desktop-supported bitmaps render when available; unsupported formats/browser edition use a named frame. DWG reader path omissions are reported. *Verified:* `interchange/r2018-image-inches.dxf`. |
| ACAD_TABLE | partly | partly | as INSERT + XDATA | DXF TABLESTYLE supplies title/header/data heights, alignment and margins; cell overrides win. JCad exports a picture block with cell data in `JCAD_TABLE` XDATA. External CAD sees a block. DWG unreadable cells fall back to the anonymous picture; estimated positions and editing/metadata losses are listed in the import report. Formulas, advanced borders and fills are not modeled. *Verified:* `interchange/r2018-table.dxf`. |
| VIEWPORT (paper space) | partly | partly | yes | Rectangular scale, center, lock/off and frozen layer names survive. DWG frozen layer handles are resolved when exposed; missing/unresolved handles are reported. Non-rectangular clipping and view twist are unsupported and reported when exposed. *Verified:* layout/image fixtures and DWG payload tests. |
| External references (xref blocks) | yes | partly | yes | Attach/overlay references and xref-dependent layer flags 16/32 survive. References display a named frame; external files are not loaded. DWG missing file paths are explicitly reported when the block name substitutes for the path. *Verified:* `interchange/r2000-nested-blocks-xref.dxf`. |
| 3DFACE, 3DSOLID, REGION, BODY | partly | no | retained raw groups | Unknown model-space records with self-contained data are retained without rendering/editing. Original handles, reactors, cross-object links and XDATA are removed; newer solids whose data is external to the record cannot be retained. The report distinguishes retained records from losses. |
| WIPEOUT, MESH, MLINE, TOLERANCE, OLE2FRAME, SURFACE, LIGHT, UNDERLAY (PDF / DGN / DWF) | no | no | no | Dropped and reported. Unsupported block/paper-space records are reported rather than silently claimed to survive. |

## Drawing-level data

| Item | DXF read | DWG read | DXF write | Known losses |
| --- | --- | --- | --- | --- |
| Layers | yes | yes | yes | Colour (ACI), linetype, lineweight, on / off, frozen, locked, no-plot (DXF), true colour (group 420 in DXF; a DWG layer with colour index 256 carries its RGB). Layer transparency is not read. *Verified by fixtures:* `interchange/r2018-truecolor-linetypes.dxf` (the Default lineweight -3 is written back as 0.25 mm). |
| Linetypes (LTYPE) | yes | yes | yes | Dash patterns (group 49). Text or shapes embedded in complex linetypes are not drawn; only the dashes are. *Verified by fixtures:* `interchange/r2018-truecolor-linetypes.dxf` (GAS_LINE, FENCELINE1: dashes kept, text and shape not written). |
| Text styles (STYLE) | yes | yes | yes | Name, font file / TrueType family, big font, height, width factor, oblique, flags. |
| Dimension styles (DIMSTYLE) | partly | partly | partly | Supported DIM variables include DIMDSEP decimal commas, DIMTXSTY resolved STYLE handles, DIMTZIN independent tolerance suppression, DIMLWD/E lineweights and DIMAPOST `[]` substitution. DIMADEC -1 inherits DIMDEC. Arrow names/basic tolerances/alternate placement use `JCAD_DIMSTYLE` XDATA, so external readers may use their defaults; dimension picture geometry preserves the appearance. Unsupported non-default native style/header variables and unmodeled `ACAD_DSTYLE_*` metadata are reported. *Verified:* both dimension fixtures and active regression tests. |
| Blocks and attributes | yes | yes | yes | Nested blocks, base point, description. Unused library blocks are left out on save. *Verified by fixtures:* `interchange/r2000-nested-blocks-xref.dxf`, `interchange/r2000-layouts-titleblock.dxf`. |
| Named views (VIEW) | yes | no | yes | |
| Header variables | partly | partly | partly | Kept: $INSUNITS, $LUNITS / $LUPREC, $AUNITS / $AUPREC, $LIMMIN / $LIMMAX, $LTSCALE, $CELTYPE / $CELTSCALE, $CELWEIGHT, $TEXTSTYLE, $CLAYER, $PDMODE / $PDSIZE, $DIMSTYLE and the current style's supported $DIM* variables. DXF retains valid source angular formats, current entity linetype scale and current text style; DWG retains the values exposed by its reader, including resolved style names. Absent values default to 0, 1 and Standard on export. JCad's angle display remains decimal degrees; new entities do not yet inherit $CELTSCALE / $TEXTSTYLE. $CANNOSCALE / $ANNOALLVISIBLE are read for JCad annotation display but are not valid AutoCAD 2000 header variables; $TDCREATE / $TDUPDATE are read as document timestamps. $DWGCODEPAGE decodes older files. Other header variables are dropped. *Verified:* `tests/interchange-header-settings.test.ts` and interchange fixtures. |
| Layouts (paper space) | yes | yes | yes | `*Paper_Space` blocks, LAYOUT objects in `ACAD_LAYOUT` (paper size, margins, plot scale); from DWG the LAYOUT objects and their paper-space blocks (a lone, untouched Layout1 is not kept). A drawing always opens in the Model tab. Plot style tables (CTB / STB) are not read. *Verified by fixtures:* `interchange/r2000-layouts-titleblock.dxf` (two layouts, `*Paper_Space0`, plot scale 1:2, saved with $TILEMODE 0), `interchange/r2018-image-inches.dxf` (inch paper, plot rotation). |
| Annotative objects | yes | no | yes | `AcadAnnotative` XDATA; one annotation scale per object. |
| Fields | yes | partly | yes | Evaluated on open, written back as field codes; DWG keeps most fields in FIELD objects, which are read as their last displayed value. |
| Groups, object data, other XDATA / XRECORDs | no | no | no | Unmodeled DXF application data and object metadata are reported as losses, including ACAD-prefixed data. DWG import reports exposed omitted object types and a conservative reader-limit warning because the reader may omit XDATA/dictionaries/fields entirely. Estimated positions/shape approximations are included in the structured report and notes. |
| Handles | no | no | new | Handles are reassigned on save; references from outside the file to object handles do not survive. |

## Colours

| | Read | Write | Notes |
| --- | --- | --- | --- |
| ACI index colours 1-255 | yes | yes | Displayed with the standard AutoCAD palette (`src/render/palette.ts`); 7 is white on the dark background and black on paper. |
| ByLayer | yes | yes | |
| ByBlock (0) | yes | yes | Kept as colour 0 and written back; when drawn, block content with ByBlock takes the reference's colour (or the reference's layer colour when the reference is ByLayer); ByBlock left on a top-level entity draws as the layer colour. Entities on layer 0 with colour ByLayer inside a block take the insert's layer and colour (AutoCAD behaviour). *Verified by fixtures:* `interchange/r2000-nested-blocks-xref.dxf` (three levels under a ByLayer and a red insert). |
| True colour (group 420) | yes | yes | On entities and layers. *Verified by fixtures:* `interchange/r2018-truecolor-linetypes.dxf`. |
| Colour books, transparency (group 440) | no | no | Shown in the nearest ACI colour / opaque. *Verified by fixtures:* `interchange/r2018-truecolor-linetypes.dxf`; a colour-book colour shows its RGB (420), the book name (430) is dropped. |

## Fonts and text

TrueType/OpenType styles render on screen through installed CSS font families and fallback stacks.
SHX and unknown styles use a single-stroke vector font (Hershey Roman Simplex,
`src/render/fonts/rowmans.jhf`). Geometry bounds and MTEXT wrapping still use stroke-font
measurements, so spacing and line breaks can differ from the displayed font and the original CAD
program. The style's font file / TrueType family is kept and written back. In vector PDF output,
WinAnsi-compatible TrueType-style text uses Helvetica or Helvetica-Bold; other text falls back to
stroke paths. Exact font embedding and SHX rendering are not implemented. Text in pre-2007 DXF
files is decoded from `$DWGCODEPAGE`; the writer produces pure ASCII with `\U+XXXX` escapes, so
non-English text survives any code page.
Non-default font metrics and absent STYLE definitions are disclosed in import reports; font
files are referenced rather than embedded.

## Import validation and external checks

DXF numbers must consume the complete value; garbage suffixes never become valid numeric
prefixes. Rejected geometry carries its source handle, layer, space and line/group context;
invalid numeric headers are rejected with the variable and value line.
Display precision is limited to 0–8, with -1 also accepted for DIMADEC; damaged direct-call
settings are bounded before numeric formatting. DXF integer values must be safe finite integers
and group codes must be in 0–1071. Default budgets are
128 million source characters, 2 million pairs, 250,000 records and 1 MiB per string. Line/string
budgets are checked before splitting the source into arrays. DWG conversion also limits
records, string lengths, total string data, metadata nodes and nesting depth.

Installed AutoCAD 2027 validation opens JCad exports, runs AUDIT and DXFOUT, then reimports
the normalized result. The dimension, hatch, layout, MTEXT, table and sample exports passed
with zero AUDIT errors. Writer regressions cover two-dimensional LIMMIN/LIMMAX header
points, version-compatible dimension groups and a valid Normal plot-style dictionary and
placeholder for layer references. Autodesk vendor samples remain local validation inputs;
they are not distributed with the repository.

Column and table-style group semantics follow Autodesk's
[MTEXT reference](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-5E5DB93B-F8D3-4433-ADF7-E92E250D2BAB.htm)
and [TABLESTYLE reference](https://help.autodesk.com/cloudhelp/2024/ENU/AutoCAD-DXF/files/GUID-0DBCA057-9F6C-4DEB-A66F-8A9B3C62FB1A.htm).

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
