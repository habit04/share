# DXF / DWG support matrix

Integration status: #24 is complete; the remaining feature roadmap is paused while
the combined Windows branch is validated. A source timezone repair preserves exact
creation-date checks in the isolated postflight reader. Production date guards and
matching native assets are unchanged. Delivered 3D and the separately owned GPU stack have
not yet been integrated here; see [integration status](WINDOWS-UPGRADE-INTEGRATION.md).

The corrected reference diagnostic now passes eight original reads. A development
repair preserves exact date comparisons by capturing a verified fixed-hour source
creation context for the postflight child, checking its actual timezone before
input. Ordinary opens and native assets are unchanged. Twelve private Node cases
and eight real shipped-WASM reads under UTC and Chicago parents pass, including 48
creation mutation/deletion refusals, unchanged complete payloads and closed children.
The probe covers creation and one retained scalar; whole-metadata/native-writer/OS
containment certification is separate. A prior normal-disconnect harness failure is
retained. Fresh exact-head CI and full local/native fixed-point validation remain
pending after typing and explicit-DXF version-test corrections. Missing
date pairs keep the strict path, and unsupported contexts refuse DWG output.

What JCad Electrical reads from DXF and DWG files, what it writes back, and what is lost on the
way. JCad is a 2D program: it works in the drawing plane and keeps 2D geometry. DXF is the native
format (AutoCAD 2000, `AC1015`, unless native properties require a newer version: MTEXT masks use
AutoCAD 2007, `AC1021`, transparency uses AutoCAD 2010, `AC1024`, RGB/named colors use AutoCAD 2004,
`AC1018`, and native MTEXT frames use AutoCAD 2018, `AC1032`). The highest required version wins.
DWG opens through LibreDWG (versions R14 to 2018, files up to 128 MiB). On Windows, **SAVE** keeps
an opened DWG's destination when the portable writer is available; **SAVEAS** offers DXF or DWG.
The bundled offline writer emits AC1032 (AutoCAD 2018) from the current supported 2D state without
installed AutoCAD. It requires both the writer's reopen checks and a separate LibreDWG metadata
postflight before saving atomically with a backup. **EXPORTDWG** / **Export >
DWG copy** writes a copy without changing the working destination or saved state. Other editions
save DXF copies. Closed project DWGs are skipped by batch updates; open them in tabs to update them.
External DWG import retains all the limits below. Saving cannot recover content lost on import;
overwriting the original warns about lost or unreadable data. Retained 3D/ACIS records and detected
conversion differences refuse DWG saving. The tables below describe DXF writing; portable DWG
conversion has the additional checks and limits described in
[DWG saving](DWG-SAVING.md), including working-file behavior.

Windows drawing tabs retain completed-open byte/version evidence. Normal Save refuses outside
changes made since Open before replacing the original or its backup; failed/unverified saves
retain dirty state and recovery. Verified own saves advance that source, and separate Save As
starts a new one. Evidence is bounded and runtime-only; filesystem provider and final OS race
limits remain in [Windows save admissions](WINDOWS-SAVE-ADMISSIONS.md).

Windows text/PDF exports share that native owner/order and opened-source protection.
PDFs bind before slow resource/conversion work, and CSV reports reserve before project
reads. Exports cannot overwrite active drawing sources through aliases, mark drawings
clean or change recovery state. Unverified replacements explicitly require destination
review. Ordinary payload limits remain 128 MiB; PDF exports retain a separate 512 MiB
ceiling with bounded content hashing and queued snapshots. Large native IPC transfers,
provider/UNC fixtures and the final check-to-rename race are separate limitations.

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
| POLYLINE (with VERTEX) | partly | partly | as LWPOLYLINE | 2D polylines retain their outline, bulges and exposed vertex widths. Missing vertex start/end widths inherit the corresponding header default independently; explicit zero overrides it. 3D polylines are flattened to XY and reported; polygon meshes are dropped and reported. Polyface meshes: see the experimental 3D row. |
| SOLID, TRACE | yes | yes (SOLID) | SOLID | Read as a filled closed polyline; written back as SOLID (three or four corners) or, with more corners, as a solid HATCH. |
| TEXT | yes | yes | yes | Style name, height, width factor, oblique angle, rotation and fields are kept. All fifteen legal native horizontal/vertical justification combinations and both alignment points survive DXF and exposed DWG data, including origin anchors. FIT retains height and fits width between its anchors; ALIGNED scales height and width together. Rendering, bounds, transforms and vector PDF honor the modes; font metrics and vertical offsets remain approximate as described below. *Verified:* `interchange/r2000-text-justification.dxf`. |
| MTEXT | partly | partly | partly | Formatting source, chunks and UTF-8 survive. Static/dynamic column definitions are read from native groups or R2018 embedded objects; explicit `\N` breaks render in separate columns. Static and dynamic-manual columns with valid declared heights flow automatically without dropping overflow; auto-height balancing remains approximated. Column dimensions survive JCad edits and reimport through `JCAD_MTEXT_COLUMNS` XDATA; external CAD displays one column, and unsupported automatic-height flow remains approximated and reported. Native background flags, padding scale, ACI/RGB/book-name fields and text frames survive DXF, including associated LEADER annotations. The vendored native DWG reader repairs fractional mask scales and preserves full background color-book strings; an independent seven-mask AutoCAD DWG verifies flags, padding, ACI/RGB and names through the actual Node loader and DXF reimport. It does not certify native columns, embedded MTEXT or reader-omitted XDATA; unusable exposed mask values are reported with a fallback. Window-color masks follow the viewport and become white in vector PDF; column gutters stay unmasked. Bounds and masks use JCad's approximate text metrics. Background transparency is retained as native metadata with its unsupported effect reported; it is not applied. Non-uniform block transformations retain existing MTEXT layout approximations. *Verified:* `interchange/r2018-mtext.dxf`, `interchange/r2018-mtext-background.dxf`/`.dwg`, `tests/mtext-background.test.ts` and `tests/native-dwg-runtime.test.ts`. |
| INSERT (block reference) | yes | yes | yes | Mirrored and non-uniform X / Y scales round-trip. Native MINSERT row/column counts, rotated grid spacing and shared attributes survive DXF/DWG import and native DXF export. Expansion shares the existing geometry budget; arrays above it are rejected before allocation. All cells share one attribute set; independent electrical tags/connectivity require exploding the array, and the electrical audit warns about this. Native dynamic-block parameters are not modeled. JCad-authored dynamic blocks (priority 30.1–30.4: linear/angle/flip/visibility/lookup parameters; stretch, move, rotate, uniform-scale, flip and rectangular-array actions; JCad's own normalized model) round-trip through the labeled `JCAD_DYNAMIC` XDATA carrier on DXF export/reimport and evaluate per instance. Per-instance parameter edits are a single undo step through DYNSET, the Properties palette's Parameters section, or the dynamic grips appended after the insert position grip; EXPLODE of a dynamic insert whose evaluation refuses is itself refused rather than exploding fallback geometry, and INSERT offers alignment rotation for definitions carrying an alignment spec (the result is stored as the insert's ordinary rotation). Other CAD programs show the authored (default) geometry, and native evaluation graphs remain retained-but-unmodeled data. LIST on a dynamic reference shows a Dynamic section (lookup-resolved parameter values, visibility state, and evaluation status); when a reference's evaluation refuses, expansion still presents the authored geometry, but not silently: the refusing references are logged with their codes when the drawing is opened (and by IMPORTREPORT), and LIST names the refusal on the reference itself. A bounded 2D constraint engine (30.3.1–30.3.4: all 13 kinds incl. tangent, distance, angle) is wired into documents: document-scope constraint sets persist through the labeled `JCAD_CONSTRAINTS` payload, a solve installs as one undo step, and a failed or cancelled solve leaves the document unchanged. Editor workflows (review §3): CONADD creates a constraint from selected objects (kind, anchor, driving value or reference toggle), CONEDIT edits a driving value, CONDELETE deletes by id, CONSOLVE solves now, and CONSTATUS reports per-constraint state (satisfied / not satisfied with measured-vs-target / reference measurements / redundant / suppressed) plus the set's DOF status — every refusal logs a code and changes nothing, every accepted operation is one undo step. Supported boundaries: constraints live on model-space entities only (the commands refuse in a layout), and the constrainable entities are line, circle, arc, polyline and point. Ordinary geometry edits are guarded at the document commit: deleting an entity an active constraint references is refused atomically, an edit that moves an entity pinned by a `fixed` constraint is refused, and any other edit touching a constrained entity re-solves inside the same undo step — edited entities are held at their edited positions and only unedited geometry is pulled — or refuses the whole edit when the set cannot be satisfied. Finding F-3034 (resolved in-house in the review correction round; no new dependency): at 30.3.4 the engine stalled on tangent systems that must move an arc centre (18% of scored cases on the frozen 52-case corpus returned `unsolved`) and under-reported constrained DOF by one per tangent at exact tangency. The corrected engine — Householder-QR Levenberg step, satisfied-iterate success at the iteration limit, a gated Anderson/Aitken crawl extrapolation, and rank probed at a deterministically perturbed point when tangent rows are present — passes the same frozen corpus at 0.00% unsolved/wrong-verdict with its cases, thresholds, tolerances and work limits unmodified, and reports tangent DOF honestly. See `docs/DYNAMIC-BLOCKS-CONSTRAINTS.md` and the corpus in `tests/constraints-corpus.test.ts`. *Verified by fixtures:* `interchange/r2000-nested-blocks-xref.dxf` (three nesting levels), `interchange/r2018-minsert.dxf` and `.dwg` (AutoCAD-normalized 3 by 2 array). |
| ATTDEF, ATTRIB | yes | yes | yes | Tag, prompt, default and value, invisible flag, constant attributes, text style, position, height, width/oblique and native justification. Per-insert placement overrides survive independently of the ATTDEF and move with the insert. Native appearance passes through the shared entity codecs. Font metrics retain the TEXT limits. *Verified:* `interchange/r2000-layouts-titleblock.dxf` and `interchange/r2000-text-justification.dxf`. |
| ELLIPSE | yes | yes | yes | Full and elliptical arcs. *Verified by fixtures:* `interchange/r2000-hatch-curves.dxf`. |
| POINT | yes | yes | yes | PDMODE / PDSIZE come from the header. |
| XLINE, RAY | yes | yes | yes | |
| DIMENSION | partly | partly | yes | Linear, aligned, radius, diameter and angular dimensions retain styles and anonymous `*D` pictures, including dimensions inside blocks. Supported per-entity ACAD DSTYLE variables retain explicit presence and scalar values independently of the named style, including equal values across style redefinitions and DXF reopen. Scaling, Match Properties, current-style assignment and ordinary style edits preserve override behavior. Named-style edits and usage checks cover model space, all blocks and all layouts, including commands run from paper space; angular suppression and defining-leg arrow ownership are honored. Unknown override groups are reported. Two-line angular dimensions export as three-point angular dimensions. Native XY/+Z ordinate DXF definitions retain datum axes/frames, points, supported style overrides and text placement; unsupported modes refuse import. Scaled/nonuniform/sheared/mirrored ordinate INSERTs display/explode as transformed local primitives, preserving the native block/INSERT on normal DXF export. This is not native editable EXPLODE parity. Direct ordinate SCALE preserves native style sizes. An ordinate creation tool, arc-length dimensions and ordinate DWG conversion remain open; retained ordinate DWG saving is guarded. DWG support depends on exposed variables/XDATA. *Verified:* existing dimension fixtures and `interchange/r2018-ordinate-dimensions.dxf` with native numeric, zero-error AUDIT and Canvas/raster/vector checks. |
| SPLINE | partly | partly | yes | Fit points or control vertices, weights, closed / periodic flags. Imports exceeding 2,000,000 calculated basis-work units or a 128-row fit-interpolation matrix are dropped with a source warning before expensive evaluation/allocation. *Verified by fixtures:* `interchange/r2000-hatch-curves.dxf` (fit points with end tangents, rational). |
| HATCH | partly | partly | yes | Loops, bulges, stored pattern lines and solid fill survive. In DXF, an associative hatch keeps its boundary links when the boundary objects are in the same part of the drawing (the same space, or the same block definition): editing the boundary updates the hatch, and the links are saved back (flag 71 = 1), with each boundary object carrying the matching back-reference ({ACAD_REACTORS} naming the hatch) that AutoCAD requires — without it, AutoCAD's AUDIT reports the boundary as missing a reactor and removes the associativity. Copying a hatch on its own does not give the copy a new boundary: the copy shares the original boundary by design, so both hatches follow it, and erasing that boundary detaches both. A link is re-pointed to a copied boundary only when hatch and boundary are copied together as one declared set; references that are not re-pointed are kept unchanged. A hatch inside a block definition keeps its links and they are saved back, but it is not updated when the block definition is edited, so its fill can go out of date. A boundary that is a retained REGION or BODY record keeps its link the same way (it is written with the handle the record is saved under). Associativity is classified per hatch over ALL its emitted boundaries: a hatch is saved associative (flag 71 = 1) only when every emitted boundary is in the same part of the drawing; if any boundary is in a different part (O5 — another space, or another block definition), the WHOLE hatch is saved non-associative (flag 71 = 0) and no back-references are written for it: the boundary handle list is still written, so on reopening it is kept as stored handles instead of live links, and the import report notes it; no data is lost in either direction. DWG boundaries that cannot be reconstructed become reported outline approximations. Counts are bounded by available records; spline work limits also apply to hatch edges. Arc/ellipse sampling is capped at 64 samples per edge; derived coordinate overflow is dropped and reported. DXF native gradient names, angle/shift, dialog flags/tint, ACI/RGB records and inactive descriptors survive. Canvas and vector/raster plots render verified unshifted LINEAR fills; nonlinear/shifted definitions retain data with a reported solid fallback. Gradient DWG exposure/conversion remains unverified and retained gradient DWG saving is blocked. Patterned hatches with gradient tails retain both definitions but refuse native export because AutoCAD rejects the combination. Transformed standalone gradient frames also refuse native export; DXF block definitions plus INSERT remain supported. *Verified:* `interchange/r2000-hatch-curves.dxf`, `interchange/r2018-gradient-hatches.dxf`; see `HATCH-GRADIENTS.md`. |
| LEADER | yes | yes | yes | With its associated MTEXT. |
| MULTILEADER / MLEADER | yes | yes | as LEADER + MTEXT | Leader lines, landing and text are kept; block content is not drawn (a note says so on open). Written back as a LEADER with MTEXT, not as a MULTILEADER. |
| IMAGE (+ IMAGEDEF) | yes | partly | yes | Paths resolve after model space, blocks and layouts have all been read, including late IMAGEDEF objects. Clip boundary, pixel vectors and display adjustments survive. Missing definitions/paths are reported. Desktop-supported bitmaps render when available; unsupported formats/browser edition use a named frame. DWG reader path omissions are reported. *Verified:* `interchange/r2018-image-inches.dxf`. |
| ACAD_TABLE | partly | partly | as INSERT + XDATA | DXF TABLESTYLE supplies title/header/data heights, alignment and margins; cell overrides win. JCad exports a picture block with cell data in `JCAD_TABLE` XDATA. External CAD sees a block. DWG unreadable cells fall back to the anonymous picture; estimated positions and editing/metadata losses are listed in the import report. Formulas, advanced borders and fills are not modeled. *Verified:* `interchange/r2018-table.dxf`. |
| VIEWPORT (paper space) | partly | partly | yes | Rectangular scale, model view center, planar orthographic +Z view rotation, lock/off and frozen layer names survive DXF and Windows portable DWG saving. Rotation applies to display, selection, coordinate conversion, pan/zoom and vector/raster plotting without changing model geometry. VPTWIST and the selected frame's Properties > View rotation set angles in degrees on unlocked views. DWG frozen layer handles are resolved when exposed; missing/unresolved handles are reported. Native DXF closed straight-polyline clips, including concave outlines, retain geometry, boundary appearance, the enable flag and group 340 links. Canvas, vector/raster plots, viewport activation and masked snap candidates honor them. Graphical selection includes visible hatch strokes/dots and excludes fully masked objects; partly visible objects retain existing whole-entity selection geometry. Retained boundaries keep their layer and linetype resources through purge/export, including disabled clips. Curved clips, DWG clipping, perspective views and tilted/reversed directions remain approximated and reported when exposed. *Verified:* layout/image fixtures, viewport IO and rotated display/PDF regressions, DWG payload tests, and the AutoCAD 2027 normalized `interchange/r2018-viewport-polygon.dxf` (zero AUDIT errors). |
| External references (xref blocks) | yes | partly | yes | Attach/overlay references and xref-dependent layer flags 16/32 survive. References display a named frame; external files are not loaded. DWG missing file paths are explicitly reported when the block name substitutes for the path. *Verified:* `interchange/r2000-nested-blocks-xref.dxf`. |
| POLYLINE polyface mesh (flag 64), experimental 3D | model-space supported subset | DXF model persistence; DWG saves refused | polyface mesh + `JCAD_3D` XDATA | Own solids and versioned histories are read even with the experimental setting off. With 3D enabled, supported foreign model-space polyfaces become mesh objects; quad triangulation is reported. Native ACIS modelling and DWG solid export remain unavailable. Histories over the bounded payload limit can degrade to plain meshes with a report. Save refuses DXFs exceeding reopen limits, including dimensions-only models. Safe recovery must preserve retained dependencies and reopenability; otherwise the previous good copy remains. Producer AutoCAD 2027 mesh/dimension reference evidence is documented in [3D-AUTOCAD-VALIDATION.md](3D-AUTOCAD-VALIDATION.md); combined integration validation is pending. Unsupported source topology/payload retention and edit-refusal policy are part of that gate. |
| 3DFACE, 3DSOLID, REGION, BODY | partly | checked native projection only | retained raw groups | Model-space records with self-contained data are retained without rendering/editing. The checked object graph retains available identities, application data and typed links; model owners and references are remapped on save. Newer solids whose data is external to the record cannot be retained. Portable DWG saving refuses unsupported ACIS records; DXF can retain them. |
| WIPEOUT, MESH, MLINE, TOLERANCE, OLE2FRAME, SURFACE, LIGHT, UNDERLAY (PDF / DGN / DWF) | no | no | no | Dropped and reported. Unsupported block/paper-space records are reported rather than silently claimed to survive. |

Nonuniform transforms preserve wide-polyline geometry directionally. An exploded affine wide
polyline exports as two native nested INSERTs around its original centerline/bulges/widths;
reopening therefore yields a block reference rather than a standalone polyline. Export refuses
an invalid or degenerate frame, a generated expansion exceeding the geometry budget, or wrappers
that would push currently visible geometry beyond the depth-eight block limit. These restrictions
do not change native widths saved inside an existing nonuniform block reference.
The affine frame is the single authoritative representation of such a polyline: its stored
`points` are exactly the frame's image of the native source vertices, and rendering, bounds,
snapping and export all derive from the frame. Whole-entity transforms compose the frame, and
vertex-preserving edits (grip moves, STRETCH) are applied to the frame's source vertices
through the frame inverse, so the two can never desync. Topology-changing vertex edits
(BREAK, polyline FILLET) refuse a framed polyline — and any polyline carrying per-vertex
widths, which they cannot reslice — explicitly, without changing state; a constant width is
unaffected. (Review R05; `tests/wide-polyline-review-r05.test.ts`.)

## Drawing-level data

| Item | DXF read | DWG read | DXF write | Known losses |
| --- | --- | --- | --- | --- |
| Layers | yes | partly | yes | ACI/RGB and named-color identity, linetype, lineweight, on/off, frozen, locked and no-plot (DXF) survive. DXF layer opacity uses registered `AcCmTransparency` XDATA; layer group 440 is also accepted on read. DWG keeps unambiguous exposed alpha, but the converter can omit the layer method/XDATA, so a default zero byte cannot safely distinguish an opaque layer from an explicitly transparent one; this is reported. *Verified:* `interchange/r2018-truecolor-linetypes.dxf`, `interchange/r2010-appearance.dxf` and appearance regressions. The Default lineweight -3 is written back as 0.25 mm. |
| Linetypes (LTYPE) | yes | partly | yes | Native DXF ordered text/shape descriptors, literal text, scales/radian rotations/offsets, flags and resolved STYLE links are retained. Anonymous/unused shape STYLE resources survive export. Only dash patterns are drawn; embedded glyphs remain a reported fallback. Canvas preserves signed spans and circular phase. Missing/malformed resources refuse export. Native DWG complex resources are unverified and guarded. Retained opaque extensions travel with the graph; ambiguous positional regeneration refuses safely. *Verified:* `interchange/r2018-complex-linetypes.dxf`, zero native AUDIT errors after actual app edits/saves/reopen, plus authored GAS/FENCE and safety regressions. |
| Text styles (STYLE) | yes | yes | yes | Name, font file / TrueType family, big font, height, width factor, oblique, flags. |
| Dimension styles (DIMSTYLE) | partly | partly | partly | Supported DIM variables include DIMDSEP decimal commas, DIMTXSTY resolved STYLE handles, DIMTZIN independent tolerance suppression, DIMLWD/E lineweights and DIMAPOST `[]` substitution. DIMADEC -1 inherits DIMDEC. Arrow names/basic tolerances/alternate placement use `JCAD_DIMSTYLE` XDATA, so external readers may use their defaults; dimension picture geometry preserves the appearance. Unsupported non-default native style/header variables and unmodeled `ACAD_DSTYLE_*` metadata are reported. *Verified:* both dimension fixtures and active regression tests. |
| Blocks and attributes | yes | yes | yes | Nested blocks, base point, description. Imported definitions referenced by retained metadata stay in the drawing even without visible INSERTs; newly added unused library blocks can be left out. *Verified by fixtures:* `interchange/r2000-nested-blocks-xref.dxf`, `interchange/r2000-layouts-titleblock.dxf`; graph-backed library regressions. |
| Named views (VIEW) | yes | Windows native subset | yes | Supported records retain full target/direction including Z, DCS center, width/height, twist, lens, clips and mode flags. Restore supports planar orthographic +Z model cameras in the Model tab. Paper-space, tilted, reversed and perspective cameras remain retained without faithful 2D restoration; future 3D editing is separate work. Independent `interchange/r2018-views-fields`, `r2018-field-object-reference` and `r2018-unicode-metadata` DWG/DXF fixtures cover full cameras and Unicode names. |
| Header variables | partly | partly | retained or refused | Modeled settings include $INSUNITS, $LUNITS / $LUPREC, $AUNITS / $AUPREC, $LIMMIN / $LIMMAX, $LTSCALE, $CELTYPE / $CELTSCALE, $CELWEIGHT, $TEXTSTYLE, $CLAYER, $PDMODE / $PDSIZE, $DIMSTYLE and supported $DIM* variables. Unmodeled source groups remain in the checked DXF graph when available. Portable DWG preflight refuses unknown/unconsumed header schemas and unsupported nondefault values; independent postflight checks nonvolatile source variables, including symbol references. This does not promise arbitrary header encoding. Absent modeled values use defaults. JCad displays decimal degrees; new entities do not yet inherit $CELTSCALE / $TEXTSTYLE. $CANNOSCALE / $ANNOALLVISIBLE support JCad annotation display, $TDCREATE / $TDUPDATE supply timestamps and $DWGCODEPAGE decodes older files. *Verified:* `tests/interchange-header-settings.test.ts`, graph/header refusal tests and interchange fixtures. |
| Layouts (paper space) | yes | yes | yes | `*Paper_Space` blocks, LAYOUT objects in `ACAD_LAYOUT` (paper size, margins, plot scale); from DWG the LAYOUT objects and their paper-space blocks (a lone, untouched Layout1 is not kept). DXF retains declared pristine layouts and their identities. A drawing always opens in the Model tab. The Plot dialog loads an ephemeral CTB/STB table with verified color/screening/grayscale/weight resolution in vector/raster output. STB provides an explicit whole-plot named selection; imported native assignments and exact sheet bindings remain open. Unsupported effects are reported. See `PLOT-STYLE-TABLES.md`. *Verified by fixtures:* `interchange/r2000-layouts-titleblock.dxf` (two layouts, `*Paper_Space0`, plot scale 1:2, saved with $TILEMODE 0), `interchange/r2018-image-inches.dxf` (inch paper, plot rotation). |
| Annotative objects | yes | no | yes | `AcadAnnotative` XDATA; one annotation scale per object. |
| Fields | partly | Windows native subset | yes | Native FIELD/FIELDLIST objects retain expressions, children, ordered reference vectors, evaluator settings and caches. JCad reevaluates supported filename/date/drawing-property expressions and available supported sheet values. Unsupported native evaluators, including AcObjProp object properties, keep the imported display/cache even after geometry changes; UPDATEFIELD reports this. Native expressions stay in their FIELD graph, while inline-only fields retain their text-code format. Manual text overrides remove only the affected owned FIELD tree; Undo restores it. Independent metadata fixtures and field-reference tests cover retained associations. |
| Groups, object data, other XDATA / XRECORDs | retained | Windows native subset | retained or refused | Exposed dictionaries, groups, ordered typed values, exact 64-bit integers/binary, application records and reactor/extension links are retained in the checked graph. Owned metadata follows copies and undo; typed references remap within connected copy sets, including clipboard transfers. Deleting a hard referenced object refuses atomically; missing hard dependencies also refuse saving. Absent cross-document soft references are removed and reported. Opaque string literals are not Unicode-decoded or searched for handles. Unknown classes/unconsumed fields or any independent postflight difference can refuse DWG output; DXF retention does not certify native encoding. Native inventory and the three independent metadata fixtures define tested coverage; fallback imports still report unreadable data. |
| Handles | retained identities | typed graph | remapped consistently | Document identities are separate from file handles. DXF prefers original handles where available and assigns fresh handles to copies; all typed reference edges remap together. Arbitrary 320–329 handles, strings and binary are opaque. References from another file to particular handles are not guaranteed. |

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
Windows `SHXFONT`/`SHXLOAD` explicitly loads read-only font/shape resources for one drawing tab.
Supported horizontal SHX glyphs use native paths and metrics; missing/unsupported runs and unknown
styles retain Hershey Roman Simplex (`src/render/fonts/rowmans.jhf`). Runtime resources stay outside
saved drawings, and fresh reopen requires explicit loading; see `SHX-FONTS.md`.
Windows desktop TrueType styles use verified installed font metrics
for drawing height, advances and bearings; unsupported faces/glyphs use Canvas measurement.
Bounds, selection, wrapping, masks and raster plots share a per-drawing font context. Native MTEXT
attachment uses ink bearings; tall-glyph leading and unsupported glyph cases remain approximate;
see `WINDOWS-FONT-METRICS.md`.
The style's font file / TrueType family is kept and written back. In vector PDF output,
Windows embeds permitted installed standalone TrueType programs, native advances and Unicode maps.
Missing/restricted faces, unsupported font formats/glyph origins and contextual shaping use a
reported Helvetica or stroke substitute. Browser PDF retains its legacy substitution. The current
development branch selects matching TrueType collection faces, subsets eligible static glyf
programs, embeds standalone name-keyed CFF1 whole and admits eligible variable glyf defaults
under a conservative identity policy. Native acceptance and shipping remain separate gates;
CFF collections/CFF2, true variable instancing, color embedding and contextual shaping remain
open; see `PDF-FONT-EMBEDDING.md`. Eligible type-0 Unicode
SHX fonts plot as vector outlines; other headers retain a reported substitute. BigFont, vertical
and mirrored generation, missing glyphs and complex-linetype glyph placement remain open.
Text in pre-2007 DXF
files is decoded from `$DWGCODEPAGE`; older exports use pure ASCII with `\U+XXXX` escapes,
while AutoCAD 2007 and later exports use UTF-8. Supplementary Unicode stays intact across
MTEXT chunk boundaries.
Paragraph-final MTEXT lines remain unexpanded and oversized words do not acquire negative
justification spacing. Explicit text width overrides take precedence over STYLE widths in
Canvas and vector PDF, including embedded TrueType runs.
Explicit native width 1 and oblique 0 survive TEXT, ATTDEF and ATTRIB DXF save/reopen.
Non-default font metrics and absent STYLE definitions are disclosed in import reports; font
files remain references in drawing data; only eligible Windows PDF plots embed programs.

## Import validation and external checks

DWG saving/export currently refuses drawings with retained polygon viewport boundaries,
including disabled boundaries, until the native writer and independent reader verify their
object references. Save As can keep these drawings as DXF. Working destination, unsaved edits,
undo history and recovery data stay intact when this specific DWG compatibility check refuses.

DXF numbers must consume the complete value; garbage suffixes never become valid numeric
prefixes. Rejected geometry carries its source handle, layer, space and line/group context;
invalid numeric headers are rejected with the variable and value line.
Display precision is limited to 0–8, with -1 also accepted for DIMADEC; damaged direct-call
settings are bounded before numeric formatting. Modeled numeric integers must be safe finite
integers; retained XRECORD 64-bit integers use exact decimal storage. Group codes must be in
0–1071. Default budgets are
128 million source characters, 2 million pairs, 250,000 records and 1 MiB per string. Line/string
budgets are checked before splitting the source into arrays. DWG conversion also limits
records, string lengths, total string data, metadata nodes and nesting depth.

Windows DWG output also requires an independent LibreDWG postflight of the emitted bytes.
It compares retained OBJECTS payloads, full named VIEW cameras, common reactor/extension/XDATA
groups and nonvolatile source header values against the source DXF, with logical reference
targets checked across handle changes. Incomplete projection, native warnings/errors, missing
identities or changed values refuse output before the destination is replaced. The native
projection is bounded to 32 MiB and 100,000 inventory objects. These guards establish the
tested subset and safe refusal; they do not make arbitrary DWG metadata lossless.

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
- Native ACIS modelling, native DWG solid export and arbitrary native 3D camera restoration.
  Experimental modelling and fixed 3D orientations are a bounded opt-in feature; retained named-view cameras keep the existing restore limits.
- Native parametric constraints and native dynamic-block actions (JCad-authored dynamic blocks and the JCad constraint engine are supported as labeled JCad data — see the INSERT row), sheet sets, data links, digital signatures.

Development integration note: the completed metadata source and matching reader/writer pins
are combined with the current 2D/save protections. The previous session-basis/common-link head
passes 3,954 tests with 28 conditional skips, all static/build checks and 32 actual Windows
app workflows against an unchanged new production bundle. Native
decoder/projection fixture validation is separate from matching-helper and combined exact-head
CI. Both metadata modules are included by the existing builder filters;
an actual packaged artifact and installed release still require later validation. This
development source does not certify a new installer.

Legacy TABLESTYLE encoding uses a checked modern representation: retained row overrides,
STYLE links, margins, colors, borders and common links are compared independently. Values
without a verified native slot refuse before writing. Native preparation retains imported
compatibility dictionaries and their children; cleanup is limited to generated styles without
DXF/native DWG provenance. The first compiled native regression exposed that dictionary loss;
the next exposed DataObject accessor omissions for already parsed reactors/extension dictionaries.
The authenticated accessors now expose those typed fields without native-reader side caches;
strict common-link snapshots reject mutations. Corrected matching-helper CI and actual
independent C postflight remain required.
Original implicit-margin DWG data is not an oracle for explicit-margin DXFOUT conversion.
Local authored projection checks pass;
the changed Rust helper's binary roundtrip and independent C postflight require fresh CI.

VPORT ambient color (groups63/421/431) uses the declared RGB bytes. Original AutoCAD
DWG decoding also exposes an explicit C2 method byte, unlike matching DXF's 24-bit RGB.
A checked field-specific comparison is under validation; unsupported methods, changed
RGB/ACI/name, malformed storage and ambiguous groups must still refuse. Other records
and opaque/XDATA color-sized values remain exact. See Autodesk's
[VPORT reference](https://help.autodesk.com/cloudhelp/2023/ENU/AutoCAD-DXF/files/GUID-8CE7CC87-27BD-4490-89DA-C21F516415A9.htm).
All 54 Rust and three CLI tests pass at `e18012cd`; native Electron export is still
blocked by this representation difference, so combined CI/native postflight remain gates.

The current color/path repair passes 318 focused backend and 173 path/project tests,
static/build checks and all 32 Windows app workflows on the unchanged production bundle.
Two normal full runs each retain 4,097 passes, 28 skips and the unchanged extended-PDF
case's body/cleanup timeout. Its full 34-case suite passes separately; a privately traced
full run passes 4,098 with 28 skips. Tracing is diagnostic only. Normal-suite clearance,
fresh exact-head CI and matching-helper/C postflight remain required before integration;
the draft repair commits do not certify those gates.

A later normal uninstrumented full run on `a44cc60` passes 4,098 tests with 28 skips;
its original PDF/512-drawing cases take 295 ms/5,836 ms. Earlier timeouts remain recorded.
Exact-head CI passes both Node jobs/UI and all 54 Rust + three CLI/containment cases, then
refuses built-in MATERIAL110-to-151 expansion. Its new checker-only correction passes
519 focused tests, all typechecks and scoped lint: 41 exact contextual defaults preserve
96 mapper values, source flags and owner/reference/opaque metadata. MLEADERSTYLE handles
only verified optional block-null/attachment semantics; MLINESTYLE spelling must resolve
to the same matched actual LTYPE and table control. Ambiguous typed bodies refuse, while
legacy raw behavior remains unchanged. The new source still requires full/app/exact-head
validation and actual matching-helper/C first/second-save equivalence. Material transient
advanced fields are not certified by the native snapshot whitelist; no reader/pin change
or broader material/3D feature completion is claimed.

The following `6d2c77d` CI exposes a new test-only CRLF/LF hash mismatch and a
TABLESTYLE common-block ordering refusal after all 54 Rust + three CLI tests pass.
The canonical LF fixture assertion preserves original raw bytes and all semantic checks.
TABLESTYLE-only symmetric comparison recognizes complete adjacent common reference
blocks while retaining owner, ordered mapped links, native carrier, body and XDATA;
malformed, duplicate, nested or interleaved framing refuses. Its 38 new regressions
bring focused coverage to 557 passes. Fresh combined local/app/CI and matching-helper
first/second C validation remain required; no wider common-object relaxation is claimed.

Current `db7203a` passes 4,351 normal local tests / 28 skips and all 32 source-desktop
workflows, plus broad static/build checks. Correct native execution permissions clear
52 earlier filesystem failures; both earlier timed cases also pass unchanged, with cause
unproven. Both Node jobs/UI pass; Windows safely refuses a local creation-time difference
after 54 Rust + three CLI/containment passes. The UTC instant agrees, but original stored
Aux local data remains unmeasured because the existing decoder exposes no raw Aux API.
A development diagnostic must qualify that evidence before any producer/reader date fix.
Current source-desktop passes do not certify the matching compiled writer/C fixed point.

The `1a3a511` development diagnostic now compiles/links, but refuses its first invalid Aux
date result. Seventeen tooling and 77 workflow regressions pass; exact production CI remains
three green / Windows creation-date refusal. Source review does not support an ABI mismatch;
the C/Rust AC1032 maintenance-width/tail disagreement needs bounded field-span/raw-byte
evidence. No original Aux interpretation or production date correction is certified.

Modern VISUALSTYLE RGB comparisons are confined to its eight typed color slots in a complete
58-property bag. Valid raw/C2 RGB storage compares all color bytes; a derived palette companion
belongs to that same color property. Standalone ACI, lighting177, operations, order/count,
common links, XDATA and opaque properties remain exact. Legacy records retain raw comparison.
Unsupported methods or claimed ambiguous modern schemas refuse. Local targeted tests/review
pass; matching-helper/C postflight and fresh combined exact-head CI remain required.

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
