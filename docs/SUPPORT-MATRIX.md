# DXF / DWG support matrix

What JCad Electrical reads from DXF and DWG files, what it writes back, and what is lost on the
way. JCad is a 2D program: it works in the drawing plane and keeps 2D geometry. DXF is the native
format (AutoCAD 2000, `AC1015`, unless native properties require a newer version: MTEXT masks use
AutoCAD 2007, `AC1021`, transparency uses AutoCAD 2010, `AC1024`, RGB/named colors use AutoCAD 2004,
`AC1018`, and native MTEXT frames use AutoCAD 2018, `AC1032`). The highest required version wins.
DWG opens through LibreDWG (versions R14 to 2018, files up to 128 MiB). On Windows, **SAVE** keeps
an opened DWG's destination when the portable writer is available; **SAVEAS** offers DXF or DWG.
The bundled offline writer emits AC1032 (AutoCAD 2018) from the current supported 2D state without
installed AutoCAD, validates the result and saves atomically with a backup. **EXPORTDWG** / **Export >
DWG copy** writes a copy without changing the working destination or saved state. Other editions
save DXF copies. Closed project DWGs are skipped by batch updates; open them in tabs to update them.
External DWG import retains all the limits below. Saving cannot recover content lost on import;
overwriting the original warns about lost or unreadable data. Retained 3D/ACIS records and detected
conversion differences refuse DWG saving. The tables below describe DXF writing; portable DWG
conversion has the additional checks and limits described in
[DWG saving](DWG-SAVING.md), including working-file behavior.

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
| LWPOLYLINE | yes | yes | yes | Constant width (group 43), bulges and outgoing per-vertex start/end widths (groups 40/41) round-trip. Explicit vertex widths override constant width, including zero. Tapers draw on straight and bulged segments; arc sides use at most 64 samples per segment and joins are beveled. Bounds/hit testing use that displayed footprint; snaps remain on the centerline. A closed two-vertex constant-width donut retains its existing filled-circle conversion. *Verified:* `polyline-widths.dxf`, `interchange/r2000-hatch-curves.dxf` and width regressions. |
| POLYLINE (with VERTEX) | partly | partly | as LWPOLYLINE | 2D polylines retain their outline, bulges and exposed vertex widths. Missing vertex start/end widths inherit the corresponding header default independently; explicit zero overrides it. 3D polylines are flattened to XY and reported; polyface / polygon meshes are dropped and reported. |
| SOLID, TRACE | yes | yes (SOLID) | SOLID | Read as a filled closed polyline; written back as SOLID (three or four corners) or, with more corners, as a solid HATCH. |
| TEXT | yes | yes | yes | Style name, height, width factor, oblique angle, rotation and fields are kept. All fifteen legal native horizontal/vertical justification combinations and both alignment points survive DXF and exposed DWG data, including origin anchors. FIT retains height and fits width between its anchors; ALIGNED scales height and width together. Rendering, bounds, transforms and vector PDF honor the modes; font metrics and vertical offsets remain approximate as described below. *Verified:* `interchange/r2000-text-justification.dxf`. |
| MTEXT | partly | partly | partly | Formatting source, chunks and UTF-8 survive. Static/dynamic column definitions are read from native groups or R2018 embedded objects; explicit `\N` breaks render in separate columns. Static and dynamic-manual columns with valid declared heights flow automatically without dropping overflow; auto-height balancing remains approximated. Column dimensions survive JCad edits and reimport through `JCAD_MTEXT_COLUMNS` XDATA; external CAD displays one column, and unsupported automatic-height flow remains approximated and reported. Native background flags, padding scale, ACI/RGB/book-name fields and text frames survive DXF, including associated LEADER annotations. The vendored native DWG reader repairs fractional mask scales and preserves full background color-book strings; an independent seven-mask AutoCAD DWG verifies flags, padding, ACI/RGB and names through the actual Node loader and DXF reimport. It does not certify native columns, embedded MTEXT or reader-omitted XDATA; unusable exposed mask values are reported with a fallback. Window-color masks follow the viewport and become white in vector PDF; column gutters stay unmasked. Bounds and masks use JCad's approximate text metrics. Background transparency is retained as native metadata with its unsupported effect reported; it is not applied. Non-uniform block transformations retain existing MTEXT layout approximations. *Verified:* `interchange/r2018-mtext.dxf`, `interchange/r2018-mtext-background.dxf`/`.dwg`, `tests/mtext-background.test.ts` and `tests/native-dwg-runtime.test.ts`. |
| INSERT (block reference) | yes | yes | yes | Mirrored and non-uniform X / Y scales round-trip. Native MINSERT row/column counts, rotated grid spacing and shared attributes survive DXF/DWG import and native DXF export. Expansion shares the existing geometry budget; arrays above it are rejected before allocation. All cells share one attribute set; independent electrical tags/connectivity require exploding the array, and the electrical audit warns about this. Dynamic-block parameters are not modeled. *Verified by fixtures:* `interchange/r2000-nested-blocks-xref.dxf` (three nesting levels), `interchange/r2018-minsert.dxf` and `.dwg` (AutoCAD-normalized 3 by 2 array). |
| ATTDEF, ATTRIB | yes | yes | yes | Tag, prompt, default and value, invisible flag, constant attributes, text style, position, height, width/oblique and native justification. Per-insert placement overrides survive independently of the ATTDEF and move with the insert. Native appearance passes through the shared entity codecs. Font metrics retain the TEXT limits. *Verified:* `interchange/r2000-layouts-titleblock.dxf` and `interchange/r2000-text-justification.dxf`. |
| ELLIPSE | yes | yes | yes | Full and elliptical arcs. *Verified by fixtures:* `interchange/r2000-hatch-curves.dxf`. |
| POINT | yes | yes | yes | PDMODE / PDSIZE come from the header. |
| XLINE, RAY | yes | yes | yes | |
| DIMENSION | partly | partly | yes | Linear, aligned, radius, diameter and angular dimensions retain styles and anonymous `*D` pictures, including dimensions inside blocks. Supported per-entity ACAD DSTYLE variables are applied and written independently of the named style. Named-style edits and usage checks cover model space, all blocks and all layouts, including commands run from paper space; angular suppression and defining-leg arrow ownership are honored. Unknown override groups are reported. Two-line angular dimensions export as three-point angular dimensions. Ordinate/arc-length dimensions are dropped and reported. DWG support depends on exposed variables/XDATA. *Verified:* both dimension fixtures. |
| SPLINE | partly | partly | yes | Fit points or control vertices, weights, closed / periodic flags. Imports exceeding 2,000,000 calculated basis-work units or a 128-row fit-interpolation matrix are dropped with a source warning before expensive evaluation/allocation. *Verified by fixtures:* `interchange/r2000-hatch-curves.dxf` (fit points with end tangents, rational). |
| HATCH | partly | partly | yes | Loops, bulges, stored pattern lines and solid fill survive. Boundary association links are lost and reported; export writes non-associative flag 71 = 0 while retaining loop geometry. DWG boundaries that cannot be reconstructed become reported outline approximations. Counts are bounded by available records; spline work limits also apply to hatch edges. Arc/ellipse sampling is capped at 64 samples per edge; derived coordinate overflow is dropped and reported. Gradient settings are not retained. *Verified:* `interchange/r2000-hatch-curves.dxf`. |
| LEADER | yes | yes | yes | With its associated MTEXT. |
| MULTILEADER / MLEADER | yes | yes | as LEADER + MTEXT | Leader lines, landing and text are kept; block content is not drawn (a note says so on open). Written back as a LEADER with MTEXT, not as a MULTILEADER. |
| IMAGE (+ IMAGEDEF) | yes | partly | yes | Paths resolve after model space, blocks and layouts have all been read, including late IMAGEDEF objects. Clip boundary, pixel vectors and display adjustments survive. Missing definitions/paths are reported. Desktop-supported bitmaps render when available; unsupported formats/browser edition use a named frame. DWG reader path omissions are reported. *Verified:* `interchange/r2018-image-inches.dxf`. |
| ACAD_TABLE | partly | partly | as INSERT + XDATA | DXF TABLESTYLE supplies title/header/data heights, alignment and margins; cell overrides win. JCad exports a picture block with cell data in `JCAD_TABLE` XDATA. External CAD sees a block. DWG unreadable cells fall back to the anonymous picture; estimated positions and editing/metadata losses are listed in the import report. Formulas, advanced borders and fills are not modeled. *Verified:* `interchange/r2018-table.dxf`. |
| VIEWPORT (paper space) | partly | partly | yes | Rectangular scale, model view center, planar orthographic +Z view rotation, lock/off and frozen layer names survive DXF and Windows portable DWG saving. Rotation applies to display, selection, coordinate conversion, pan/zoom and vector/raster plotting without changing model geometry. VPTWIST and the selected frame's Properties > View rotation set angles in degrees on unlocked views. DWG frozen layer handles are resolved when exposed; missing/unresolved handles are reported. Native DXF closed straight-polyline clips, including concave outlines, retain geometry, boundary appearance, the enable flag and group 340 links. Canvas, vector/raster plots, viewport activation and masked snap candidates honor them. Graphical selection excludes fully masked objects; partly visible objects retain existing whole-entity selection geometry. Curved clips, DWG clipping, perspective views and tilted/reversed directions remain approximated and reported when exposed. *Verified:* layout/image fixtures, viewport IO and rotated display/PDF regressions, DWG payload tests, and the AutoCAD 2027 normalized `interchange/r2018-viewport-polygon.dxf` (zero AUDIT errors). |
| External references (xref blocks) | yes | partly | yes | Attach/overlay references and xref-dependent layer flags 16/32 survive. References display a named frame; external files are not loaded. DWG missing file paths are explicitly reported when the block name substitutes for the path. *Verified:* `interchange/r2000-nested-blocks-xref.dxf`. |
| 3DFACE, 3DSOLID, REGION, BODY | partly | no | retained raw groups | Unknown model-space records with self-contained data are retained without rendering/editing. Original handles, reactors, cross-object links and XDATA are removed; newer solids whose data is external to the record cannot be retained. The report distinguishes retained records from losses. |
| WIPEOUT, MESH, MLINE, TOLERANCE, OLE2FRAME, SURFACE, LIGHT, UNDERLAY (PDF / DGN / DWF) | no | no | no | Dropped and reported. Unsupported block/paper-space records are reported rather than silently claimed to survive. |

Nonuniform transforms preserve wide-polyline geometry directionally. An exploded affine wide
polyline exports as two native nested INSERTs around its original centerline/bulges/widths;
reopening therefore yields a block reference rather than a standalone polyline. Export refuses
an invalid or degenerate frame, a generated expansion exceeding the geometry budget, or wrappers
that would push currently visible geometry beyond the depth-eight block limit. These restrictions
do not change native widths saved inside an existing nonuniform block reference.

## Drawing-level data

| Item | DXF read | DWG read | DXF write | Known losses |
| --- | --- | --- | --- | --- |
| Layers | yes | partly | yes | ACI/RGB and named-color identity, linetype, lineweight, on/off, frozen, locked and no-plot (DXF) survive. DXF layer opacity uses registered `AcCmTransparency` XDATA; layer group 440 is also accepted on read. DWG keeps unambiguous exposed alpha, but the converter can omit the layer method/XDATA, so a default zero byte cannot safely distinguish an opaque layer from an explicitly transparent one; this is reported. *Verified:* `interchange/r2018-truecolor-linetypes.dxf`, `interchange/r2010-appearance.dxf` and appearance regressions. The Default lineweight -3 is written back as 0.25 mm. |
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

Disabled MTEXT mask settings use registered `JCAD_MTEXT_BACKGROUND` XDATA because AutoCAD
rejects inactive native padding/color groups. JCad restores the settings on reopen, even when
another CAD program removes the redundant native off flag. This metadata is limited to 4 KiB of
UTF-8 JSON and validated before use; malformed or conflicting records are reported. Active masks
and frames retain their native groups.

| | Read | Write | Notes |
| --- | --- | --- | --- |
| ACI index colours 1-255 | yes | yes | Displayed with the standard AutoCAD palette (`src/render/palette.ts`); 7 is white on the dark background and black on paper. |
| ByLayer | yes | yes | |
| ByBlock (0) | yes | yes | Kept as colour 0 and written back; when drawn, block content with ByBlock takes the reference's colour (or the reference's layer colour when the reference is ByLayer); ByBlock left on a top-level entity draws as the layer colour. Entities on layer 0 with colour ByLayer inside a block take the insert's layer and colour (AutoCAD behaviour). *Verified by fixtures:* `interchange/r2000-nested-blocks-xref.dxf` (three levels under a ByLayer and a red insert). |
| True colour (group 420) | yes | yes | On entities and layers. *Verified by fixtures:* `interchange/r2018-truecolor-linetypes.dxf`. |
| Named colors and color books (group 430) | yes | yes | Supplied identity survives independently of RGB/ACI, including UTF-8 names. Display uses the supplied RGB or ACI fallback; JCad does not load vendor color-book catalogs or infer RGB from a name. DWG preserves exposed identity, but the converter can omit the separate book portion and reports this limit. *Verified:* `interchange/r2010-appearance.dxf` and appearance regressions. |
| Entity/layer transparency | yes | yes | ByLayer, ByBlock and explicit alpha (0 transparent, 255 opaque) survive DXF and use shared canvas/PDF resolution. Entity group 440 and layer `AcCmTransparency` XDATA retain their native methods. Nested block inheritance resolves one source alpha rather than multiplying parent and child values. DWG preserves valid exposed values with the layer ambiguity noted above. Background group 441 remains metadata with its unsupported effect reported. *Verified:* appearance, affine width opacity and cross-feature regressions. |

## Fonts and text

TrueType/OpenType styles render on screen through installed CSS font families and fallback stacks.
SHX and unknown styles use a single-stroke vector font (Hershey Roman Simplex,
`src/render/fonts/rowmans.jhf`). Geometry bounds and MTEXT wrapping still use stroke-font
measurements, so spacing and line breaks can differ from the displayed font and the original CAD
program. The style's font file / TrueType family is kept and written back. In vector PDF output,
WinAnsi-compatible TrueType-style text uses Helvetica or Helvetica-Bold; other text falls back to
stroke paths. Exact font embedding and SHX rendering are not implemented. Text in pre-2007 DXF
files is decoded from `$DWGCODEPAGE`; older exports use pure ASCII with `\U+XXXX` escapes,
while AutoCAD 2007 and later exports use UTF-8. Supplementary Unicode stays intact across
MTEXT chunk boundaries.
Paragraph-final MTEXT lines remain unexpanded and oversized words do not acquire negative
justification spacing. Explicit text width overrides take precedence over STYLE widths in
Canvas and vector PDF; this does not provide exact installed-font metrics or embedding.
Explicit native width 1 and oblique 0 survive TEXT, ATTDEF and ATTRIB DXF save/reopen.
Non-default font metrics and absent STYLE definitions are disclosed in import reports; font
files are referenced rather than embedded.

## Import validation and external checks

DWG saving/export currently refuses drawings with retained polygon viewport boundaries,
including disabled boundaries, until the native writer and independent reader verify their
object references. Save As can keep these drawings as DXF. Working destination, unsaved edits,
undo history and recovery data stay intact when this specific DWG compatibility check refuses.

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

- DWG saving outside the Windows desktop edition, or lossless preservation of every original DWG object and metadata field.
- 3D geometry and 3D views (only the XY projection of 2D-capable entities is read).
- Parametric constraints, dynamic-block actions, sheet sets, data links, digital signatures.

## Platforms

The desktop application runs on the Electron 44 runtime (44.7.0), whose platform support it
follows:

| System | Installer | Minimum |
| --- | --- | --- |
| Windows | `.exe` (NSIS), x64 | Windows 10 |
| macOS | `.dmg`, Apple Silicon (`arm64`) and Intel (`x64`) | macOS 13 Ventura (releases up to 0.4.1, on Electron 33, ran on macOS 11 Big Sur and 12 Monterey) |
| Linux | `.AppImage`, `.deb`, x64 | a distribution release still supported by both its maker and Chromium |

The browser edition on the website does not use Electron and is not affected by these minimums
(its automated checks run in Chromium).
