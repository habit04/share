# True 3D dimensions (DIM3D)

Status: **experimental, off by default.** Like every 3D command ([3D-MODELLING.md](3D-MODELLING.md),
[3D-EDITING.md](3D-EDITING.md)), DIM3D exists only when **Options > Files > Experimental: 3D
modelling** (setting `experimental3d`) was on when the app started. With the flag off nothing here
is registered; DXF files JCad wrote with 3D dimensions still open and keep them (see
[Reading](#reading)). The 2D dimension commands, the 2D `DimensionEntity` and the DXF output of 2D
dimensions are unchanged.

A 3D dimension is a dimension drawn **in its own measurement plane in space**: an aligned,
linear or angular dimension between points of solids (or typed 3D points), in a tilted plane, on a
face, or in any plane given by three points. It is stored with the 3D model
(`DrawingState.model3d.dimensions`), undoes and redoes like a solid, is saved in DXF as a real
`DIMENSION` entity in that plane, and is drawn by the 3D view exactly like the 2D dimension of the
same style would be drawn in that plane. The older **3DDIM** prototype (a 2D dimension of points
projected onto the drawing plane) stays as an interim command and now labels its projections (see
[3DDIM](#the-3ddim-prototype-interim)).

## Command

`DIM3D` (ribbon **3D > Measure > 3D Dimension**). Points are 3D points as in every 3D command: in
the 3D view the face under the cursor with the 3D object snaps (END / MID / CEN / NEA), typed
`x,y`, `x,y,z`, `@dx,dy,dz` in construction-plane coordinates.

| Prompt | Answers |
| --- | --- |
| `Specify first extension line origin or [Linear/Angular/Plane/Text]:` | a point; `L` Linear, `A` Angular (`AL` back to Aligned), `P` Plane, `T` Text; Enter ends |
| (Linear) `... or [Aligned/ANgular/Plane/Text]:` | `A` Aligned, `AN` Angular (a click on an option sends its capitals, so clicking ANgular sends AN) |
| (Angular) `Specify angle vertex or [Aligned/Linear/Plane/Text]:` | the vertex |
| `Specify second extension line origin:` | aligned / linear |
| `Specify first angle endpoint:` · `Specify second angle endpoint:` | angular: a point on each leg |
| `Specify dimension line location or [Text] <default offset>:` | aligned: a point the dimension line passes through; Enter = a fifth of the length to the left of first -> second |
| `Specify dimension line location or [X/Y/Text] <default offset>:` | linear: as above; `X` / `Y` fix the plane axis measured along |
| `Specify dimension arc location or [Text] <default radius>:` | angular: a point on the arc (its side picks which angle); Enter = halfway round the angle from leg 1 to leg 2 |
| `Specify measurement plane [Current/Face/3Points] <Current>:` | `C` / Enter, `F` then `Select a face of a solid:`, `3P` (or `P`) then origin, point on the positive X axis, point on the positive-Y side |
| `Enter dimension text <measurement>:` | free text (Space is a character); `<>` = the measurement; Enter or `<>` = no override |

- **Plane Current** (the default): the construction plane's orientation (3DPLANE; WCS XY outside 3D
  mode) **through the first point**, so two points at the same height are measured truly in World.
- **Face**: the plane of the picked face (origin at the pick, X axis by AutoCAD's arbitrary axis
  rule, normal outward). A typed point picks the face seen looking down the construction plane
  normal (as 3DPLANE Face).
- **3Points**: origin, X axis toward the second point, the third point on the positive Y side.
  Collinear or coincident points are refused (`The three points do not define a plane ...`) and the
  option asks again.
- **Linear** measures along the plane's X or Y axis: like AutoCAD's DIMLINEAR the location chooses
  (beside the points: Y, above / below them: X; inside their box: the longer extent) unless X or Y
  was typed.
- Coincident points in the plane (aligned), a leg point on the vertex, or both legs in one
  direction are refused with a message and the point is asked again.
- While the location is asked, the dimension follows the cursor in the 3D view (rubber band,
  drawn on top; `jcad3d.previewDimensions`). The 2D view does not show 3D dimensions; outside 3D
  mode the command says so first.
- The new dimension goes on the current layer, ByLayer, with the current dimension style, in **one
  undo step**. The command logs
  `DIM3D: <Kind> dimension in the <plane> plane (<description>). Dimension text = <text> (measured <value>)`
  and, for a projected dimension, `DIM3D: a point is off the measurement plane: the dimension
  measures the projected distance P. True 3D distance: T.`

## Model and measurement rules

`Dimension3D` (`src/model3d/types.ts`) is sealed plain data next to the solids:

| Field | Meaning |
| --- | --- |
| `id`, `layer`, `color` | as a solid (ids share one space with solids and 2D entities) |
| `kind` | `aligned`, `linear` or `angular` |
| `plane` | the measurement plane: `Frame3` (origin, in-plane X / Y, normal = Z), orthonormal and right-handed |
| `p1`, `p2` | world definition points: extension line origins (aligned / linear) or a point on each leg (angular) |
| `vertex` | angular only: the vertex |
| `axis` | linear only: `x` or `y` of the plane |
| `offset` | aligned / linear: signed distance of the dimension line from the midpoint of the in-plane points, across the measurement direction (positive = left of it seen from the normal side); angular: the arc radius |
| `textOverride` | as the 2D text override (`<>` = the measurement, `' '` hides it) |
| `style` | the `DimStyle`, embedded as in a 2D dimension (its name is the DXF style) |
| `projected` | `true` when a definition point is off the plane |

Every producer goes through `makeDimension3D` (`src/model3d/dimension3d.ts`), which derives the
offset, the leg order and the projected flag from a location point the same way for the tool, the
DXF reader, transforms and the Properties palette.

Measured values (computed in the plane's 2D coordinates, after projecting every point along the
plane normal):

- **aligned** = distance between the projections of `p1` and `p2`; equal to |p2 - p1| when both are
  in the plane;
- **linear** = their separation along the plane's X or Y axis;
- **angular** = the counter-clockwise angle (about the normal) from the leg through `p1` to the leg
  through `p2`; the arc location chooses which of the two angles (the legs are ordered so the arc
  runs counter-clockwise through it).
- A point is **in the plane** when it is within 1e-6 of the dimension's own size (the largest
  distance between its definition points; `DIM3D_PLANE_TOLERANCE`), but at least 100 x the rounding
  noise of its coordinates (1e-12 x their magnitude): a 5-unit dimension at x = 100,000 with a point
  0.05 off the plane is projected. Otherwise the dimension is `projected`: it measures the
  projection and its text gets ` (projected)` appended (after an override too: `Gap <>` shows
  `Gap 5.0000 (projected)`); a hidden text (override `' '`) stays hidden.

Text and units follow the dimension style exactly as for 2D dimensions (DIMDEC, DIMPOST, DIMLFAC,
tolerances, alternate units ...), because the text is made by the 2D code from the equivalent 2D
dimension (`dimension3dTo2d`).

## Display, selection and editing

- `dimension3dGeometry` (`src/render3d/dimension3d-scene.ts`) takes the 2D `dimensionGeometry` of
  the equivalent 2D dimension in plane coordinates and maps every part into the plane (the 2D
  underlay's SceneSink adapter: lines, arrowheads, sampled arcs, stroke-font text), in the colours
  the 2D view gives that dimension (style colour overrides, ByLayer from the layer table). The 3D
  view draws them through its line batch, depth-tested (a solid in front hides them).
- Off or frozen layers hide 3D dimensions, as they hide solids.
- **Selection**: a click in the 3D view picks a dimension whose drawn segments pass within the 2D
  pick box of the cursor (CPU; the GPU id buffer holds solids only) unless the solid face under the
  cursor is nearer along the cursor ray (a dimension on the face counts as in front; the depth
  slack is twice the hit's distance from the ray, so on faces seen very obliquely a dimension just
  behind the face may still win); the hover highlights it; selected dimensions are drawn in the
  selection colour. `ALL` and a typed id (as
  `jcad3d.dimensionIds()` lists them) select dimensions at `Select objects:`.
- **ERASE** removes them (with solids and 2D objects, one undo step).
- **3DMOVE / 3DROTATE / 3DSCALE** transform their plane, points and location with the selected
  solids (`3DMOVE: 1 solid and 2 dimensions moved.`); text sizes are the style's and do not scale.
  Dimensions show no ghost while the last point is asked (solids do).
- **MOVE / COPY / ROTATE / SCALE / MIRROR** carry them in the drawing plane like solids (COPY and
  MIRROR add copies with new ids; a mirror keeps the plane right-handed and the dimension line on
  the mirrored side).
- **Properties** palette: a mixed selection (2D objects, solids and 3D dimensions) names every group
  in its header (`All (3: 1 object, 1 solid, 1 3D dimension)`) and its Layer and Color rows edit all
  of them in one undo step. A selection of 3D dimensions only shows Layer and Color, and for one
  dimension Kind, Measurement (read-only, "(projected)" when it is),
  Text override (editable; empty = the measurement), Dimension text, Plane (`XY at z = 5.0000`,
  `XZ at y = 0.0000`, `YZ at x = 2.0000` or `Custom (normal ...)`). Each edit is one undo step.
- Undo / redo restore dimensions with everything else (whole-state history).
- DWG Save / EXPORTDWG are refused for drawings with 3D dimensions, as for solids
  (`DWG files cannot hold 3D objects in this version ...`). Autosave recovery copies keep them
  (even when they must leave out solids that are too large).

## DXF mapping

Written by `src/io/dxf/dim3d-write.ts` at the end of ENTITIES (after the solids); a drawing without
3D dimensions writes none of this (`tests/dxf-3d-identity.test.ts`). The `DIMENSION` follows the
DXF reference's OCS convention for an extrusion direction; the records were verified with AutoCAD 2027 Core Console on 2026-10-13 (`npm run check:autocad:3d`, see 3D-AUTOCAD-VALIDATION.md): AUDIT 0 / 0, every mesh and dimension read back, DXF and DWG round trips keep the JCAD_3D data; other programs and interactive display are not verified. AutoCAD rewrites the angular arc point (group 10) to one third of the sweep on load; radius, plane, side and angle are unchanged.

| Group | Value |
| --- | --- |
| `0` / `100` | `DIMENSION`, `AcDbEntity` (layer 8, ACI colour 62 unless ByLayer), `AcDbDimension` |
| `2` | `*D<n>`: an anonymous picture block, numbered after the 2D dimensions' (as the 2D writer, so programs that do not regenerate dimensions show it) |
| `10/20/30` | WCS: the dimension-line definition point (aligned / linear, where the 2D writer puts it), or the point on the arc (angular) |
| `11/21/31` | OCS: the text midpoint; 31 = the plane's elevation along the normal |
| `70` | type (aligned 1, linear 0, three-point angular 5, as the 2D writer) + 32 |
| `100` | after 3: `AcDbAlignedDimension` (aligned), `AcDbAlignedDimension` + `AcDbRotatedDimension` (linear), `AcDb3PointAngularDimension` only (angular) |
| `71`, `42` | attachment 5; the measurement (radians for angular, as 2D) |
| `1` | the shown override: the text override, with ` (projected)` for a projected dimension (`<> (projected)` without one) |
| `210/220/230` | the plane normal (extrusion direction) |
| `3` | style name; per-dimension overrides as ACAD `DSTYLE` / `JCAD_DIMSTYLE` XDATA exactly as for 2D dimensions |
| `13/23/33`, `14/24/34` | WCS: `p1`, `p2` (the stored points, also when off the plane) |
| `15/25/35` | angular: WCS vertex (`AcDb3PointAngularDimension`) |
| `50` | linear: angle of the measured plane axis in the OCS, degrees (`AcDbRotatedDimension`) |
| `1001 JCAD_3D` + `1000` | `{"v":1,"id":...,"kind":"dimension3d","plane":{origin,xAxis,yAxis,zAxis},"offset":n[,"projected":true]}` |

- The OCS is AutoCAD's Arbitrary Axis Algorithm of the normal (`frameFromPlane`; verified to
  follow it: Wy x N when |Nx|, |Ny| < 1/64, else Wz x N). Following the DXF reference, the
  definition points 10 / 13 / 14 / 15 are **WCS** (only 11 and 16 are OCS points), so the stored
  world points are written as they are.
- The picture block holds the 2D dimension geometry mapped into the plane: LINEs in WCS, ARC /
  CIRCLE / filled arrowheads (SOLID) / dots (LWPOLYLINE donut with elevation) and TEXT in the OCS,
  each with the extrusion; parts on ByLayer are ByBlock, as for 2D dimensions.
- `JCAD_3D` holds only what DXF cannot: the id, the plane frame's origin and in-plane axes (DXF
  keeps the normal only), the exact offset (the definition point it is computed into rounds) and
  the projected flag. Coordinates that round-trip (10, 13, 14, 15, 210) use the shortest exact
  decimal text, so ids, kinds, planes, points and measurements read back exactly and a re-save is
  byte-identical (`tests/model3d-dxf-dimension3d.test.ts`, seven planes including negative normals).

### Reading

`src/io/dxf/dim3d-read.ts`, model space only:

- A `DIMENSION` with `JCAD_3D` data is a 3D dimension **whatever the experimental setting**
  (JCad wrote it, and Save writes it back); with the setting off the import report notes that the
  drawing holds 3D dimensions that are kept but shown only with Experimental 3D on.
- Another program's `DIMENSION` whose extrusion is **not (0, 0, +1)** (a tilted plane, or the XY
  plane seen from below, (0, 0, -1)) becomes a 3D dimension only when 3D reading is enabled (the
  experimental setting): plane = the OCS of its normal through
  point 10; aligned, linear (50 turns the plane frame about its normal when it is no plane axis),
  three-point and two-line angular (legs 13 -> 14 and 15 -> 10, arc point 16 in OCS) are read.
  Other types fall back to the 2D path.
- **Everything else takes the unchanged 2D path**: 3D off, extrusion +Z, other types, and
  dimensions inside blocks or on layouts. The 2D reader still reads a tilted (or -Z) DIMENSION flat
  (the x, y of its WCS points) with the same report items as before; with 3D off the import report
  adds one note counting such dimensions (`2 dimensions of this drawing lie in a plane other than
  the XY plane (or face -Z) and were read flat ...`).
- The stored plane is used when its normal matches 210 (1e-6) and point 10 lies on it; otherwise
  the plane is rebuilt from the extrusion and the report says so. The stored offset is used only
  while it agrees with point 10 (1e-9). A trailing ` (projected)` in group 1 of a projected
  dimension is not an override. Moved text (flag 128), text rotation 53, oblique 52, linetype,
  lineweight, true colour and transparency are not kept on 3D dimensions (simplified, reported);
  other applications' XDATA is reported as not kept.
- Unreadable JCad data keeps the dimension from its DXF groups (new id, plane from the
  extrusion) with a simplified item; data of a newer `v` is reported as unsupported; an unreadable
  number, a zero extrusion, an unsupported type or degenerate geometry drops a JCad record with a
  reason (another program's record then takes the 2D path). A duplicate id (also one used by a
  solid) gets a fresh one. `tests/fuzz-model3d-file.test.ts` mutates these records (1,000 seeded
  runs): only DxfReadError escapes, every DIMENSION becomes a 3D or 2D dimension or a dropped item,
  and every 3D dimension read is consistent.

## The 3DDIM prototype (interim)

`3DDIM` stays as it was (an ordinary 2D aligned dimension on the drawing plane, planes parallel to
WCS XY only), but it now **identifies projected measurements**: when either point is off the
drawing plane (z = 0, where the 2D dimension lies) the dimension gets the text override
`<> (projected)`, so it shows e.g. `5.0000 (projected)`, and the log gives the true 3D distance
(`Dimension text = 5.0000 (projected) (measured 5.0000, projected; true 3D distance 5.3852)`). Its
first line says what it does and points to DIM3D; the ribbon button is **Projected Dim**. Use DIM3D
for real 3D dimensions.

## Limits (prototype-only or not supported)

- Kinds: aligned, linear (plane X / Y) and angular only; no radius, diameter, ordinate, arc length,
  baseline / continue, DIMEDIT / DIMTEDIT, moved text, oblique extension lines, or associativity
  (a dimension does not follow the solid it measured; transform it with the solid).
- No grips on 3D dimensions; no ghost while 3DMOVE / 3DROTATE / 3DSCALE ask their last point.
- The 2D view, plots and PDF output do not show 3D dimensions (model space in 3D mode only).
- Text is drawn with the built-in stroke font whatever the text style (as the 3D underlay), always
  readable from the normal side of the plane (seen from behind it is mirrored).
- Verified with AutoCAD 2027 Core Console (measurements equal within 1e-15 relative, round trips
  through DXF and DWG); other CAD programs, interactive editing and other AutoCAD versions are not
  verified. Without the JCAD_3D XDATA, dimensions in a +Z plane at an elevation read back flat.

## Replaying in a browser (supervisor checks)

As in [3D-EDITING.md](3D-EDITING.md): `window.jcad3d` exists only with the flag on; each value is
one `editor.submitInput(text)` after `editor.runCommand(NAME)`, `''` is Enter. Start from a new
drawing.

### Part 1: typed input (3D mode on or off)

`tests/tools3d-dim3d.test.ts` ("docs/3D-DIMENSIONS.md replay") runs this exactly in Node.

```js
const ed = jcad3d.editor, run = (c, ...xs) => { ed.runCommand(c); for (const x of xs) ed.submitInput(x); };

// Aligned in a tilted plane given by 3 points (the plane x = z).
run('DIM3D', 'P', '3P', '0,0,0', '1,0,1', '0,1,0', '0,0,0', '3,4,3', '0,6,0');
//   DIM3D: Aligned dimension in the 3 points plane (Custom (normal -0.7071, 0.0000, 0.7071)). Dimension text = 5.8310 (measured 5.8310)
// Linear: above the points -> plane X; then Y typed.
run('DIM3D', 'L', '10,0', '14,3', '12,6');          // Linear (plane X) ... Dimension text = 4.0000 (measured 4.0000)
run('DIM3D', 'L', '10,0', '14,3', 'Y', '17,1');     // Linear (plane Y) ... Dimension text = 3.0000 (measured 3.0000)
// Angular: vertex, two endpoints, a point on the arc.
run('DIM3D', 'A', '20,0', '22,0', '20,2', '21,1');  // Angular ... Dimension text = 90%%d (measured 90.00 degrees)
// Face plane: the top face of a box (typed point = looking down the plane normal).
run('BOX', '30,0', '34,3', '2');
run('DIM3D', 'P', 'F', '32,1', '30,0,2', '34,3,2', '30,4,2');
//   Measurement plane: the picked face (XY at z = 2.0000).
//   DIM3D: Aligned dimension in the Face plane (XY at z = 2.0000). Dimension text = 5.0000 (measured 5.0000)
// Text override; Enter places the line.
run('DIM3D', 'T', 'Gap <>', '50,0', '53,4', '');    // ... Dimension text = Gap 5.0000 (measured 5.0000)
// Projected: the second point is 2 above the plane through the first.
run('DIM3D', '40,0,0', '44,3,2', '');
//   ... Dimension text = 5.0000 (projected) (measured 5.0000)
//   DIM3D: a point is off the measurement plane: the dimension measures the projected distance 5.0000. True 3D distance: 5.3852.
jcad3d.dimensionIds().length;                       // 7
ed.runCommand('UNDO');                              // 6 (the projected one is gone)
run('ERASE', jcad3d.dimensionIds()[0], '');         // 5
run('3DMOVE', 'ALL', '', '0,0,0', '@0,0,10');       // 3DMOVE: 1 solid and 5 dimensions moved.
// The interim 3DDIM labels its projection:
run('3DDIM', '40,0,0', '44,3,2', '');
//   Dimension text = 5.0000 (projected) (measured 5.0000, projected; true 3D distance 5.3852)
// Save As DXF, reopen: the dimensions come back with the same ids, planes and texts.
```

### Part 2: 3D mode (view, snaps, rubber band, selection)

Continue after Part 1 (or start a new drawing). Screen positions come from `jcad3d.project`;
`jcad3d.click(x, y, shift)` and `jcad3d.hoverAt(x, y)` act like the mouse.

```js
ed.runCommand('3DMODE');
ed.runCommand('3DVIEW seiso');
const P = (x, y, z) => jcad3d.project({ x, y, z });
const toward = (a, b, px) => { const d = Math.hypot(b.x - a.x, b.y - a.y); return { x: a.x + (b.x - a.x) * px / d, y: a.y + (b.y - a.y) * px / d }; };
ed.runCommand('3DZOOMEXTENTS');
// Every dimension of Part 1 is drawn in its plane (the tilted one leans at 45 degrees, the Face
// one lies on the box top, moved up 10 by 3DMOVE), in the 2D dimension colours.

// A face dimension on the front face (y = 0) of a new box, corners by END snap.
run('BOX', '60,0', '64,3', '2');                    // x 60..64, y 0..3, z 0..2
ed.runCommand('3DZOOMEXTENTS');
ed.runCommand('DIM3D'); ed.submitInput('P'); ed.submitInput('F');
let q = P(62, 0, 1); jcad3d.click(q.x, q.y, false); // Measurement plane: the picked face (XZ at y = 0.0000).
q = toward(P(60, 0, 0), P(62, 0, 1), 3); jcad3d.click(q.x, q.y, false);   // snaps to 60,0,0 (square marker)
q = toward(P(64, 0, 2), P(62, 0, 1), 3); jcad3d.click(q.x, q.y, false);   // snaps to 64,0,2
q = P(63, 0, -1); jcad3d.hoverAt(q.x, q.y);        // rubber band: jcad3d.previewDimensions.length === 1
jcad3d.click(q.x, q.y, false);
//   DIM3D: Aligned dimension in the Face plane (XZ at y = 0.0000). Dimension text = 4.4721 (measured 4.4721)
//   jcad3d.previewDimensions.length === 0

// Select it with a click on its dimension line; Properties shows the 3D Dimension rows.
const id = jcad3d.dimensionIds().at(-1);
q = jcad3d.project(jcad3d.dimensionPoint(id));
jcad3d.click(q.x, q.y, false);                      // [...ed.selection] -> [id], drawn in the selection colour
// (A real mouse move over it sets jcad3d.hover === id: the hover highlight.)
// Properties palette: Kind Aligned, Measurement 4.4721, Text override (type "W <>" + Enter -> "W 4.4721"), Plane XZ at y = 0.0000.
ed.cancel();                                        // Esc clears the selection
run('3DROTATE', id, '', '60,0,0', 'Z', '90');       // 3DROTATE: 1 dimension rotated. (it now lies in the plane x = 60)
ed.runCommand('UNDO');
run('ERASE', id, '');                               // gone; UNDO brings it back
```

## Code map

| File | Role |
| --- | --- |
| `src/model3d/types.ts` | `Dimension3D`, `Model3D.dimensions` |
| `src/model3d/dimension3d.ts` | `makeDimension3D`, plane mapping, measurement, text, the equivalent 2D dimension and its parts |
| `src/model3d/model.ts` | `addDimensions3D`, `removeDimensions3D`, `removeObjects3D`, `replaceDimension3D`, `dimensionById`; `withModel3D` keeps a model with dimensions only |
| `src/render3d/dimension3d-scene.ts` | `dimension3dGeometry` (world segments), `pickDimension3D`, layer visibility |
| `src/render3d/viewport3d.ts` | the dimensions' line batch, selection / hover tint, rubber band, CPU pick before solids |
| `src/tools3d/dimension3d-tool.ts` | DIM3D |
| `src/tools3d/solid-edit.ts`, `transform.ts` | `transformDimension3D`; 3DMOVE / 3DROTATE / 3DSCALE and the 2D modify commands carry dimensions |
| `src/tools/modify.ts` | ERASE of 3D dimensions |
| `src/tools3d/properties.ts`, `src/ui/properties.ts` | Properties rows and the text override edit |
| `src/io/dxf/dim3d-write.ts`, `dim3d-read.ts` | DXF DIMENSION in the OCS, picture block, JCAD_3D payload; reading |
| `src/model3d/file-format.ts` | `encodeDimensionPayload` / `decodeDimensionPayload` |
| `src/app/experimental-3d.ts` | command, ribbon, rubber band, ALL / typed ids, `jcad3d.dimensionIds()` / `dimensionPoint(id)` / `previewDimensions` |
| `src/tools3d/dim3d.ts` | the interim 3DDIM prototype (projected labelling) |
