# Experimental 3D editing (milestone 4)

Status: **experimental, off by default.** Like the modelling commands
([3D-MODELLING.md](3D-MODELLING.md)), everything here exists only when **Options > Files >
Experimental: 3D modelling** (setting `experimental3d`) was on when the app started. With the flag
off none of the new commands is registered, DIST and the 2D modify commands behave exactly as
before, and the ribbon has no 3D tab (`tests/experimental-3d-flag.test.ts`). The plan is
[3D-PLAN.md](3D-PLAN.md), milestone 4.

## Commands

| Command (alias) | Prompts (`<value>` = last value, Enter accepts it) |
| --- | --- |
| `3DMOVE` (`3M`) | Select objects · base point or [Displacement] <Displacement> · second point or <use first point as displacement> (Displacement: `Specify displacement <0,0,0>:` typed `x,y,z`) |
| `3DROTATE` (`3R`) | Select objects · base point · rotation axis [X/Y/Z/2Points] <Z> (2Points: first and second point on the axis) · rotation angle or [Reference] <last> (degrees, or a picked point; Reference: reference angle <0> (degrees, or two points) · new angle or [Points] <0>) |
| `3DSCALE` | Select objects · base point · scale factor or [Reference] <last> (a number > 0, or a picked point: its distance from the base point; Reference: reference length (number, or two points) · new length or [Points]) |
| `3DDIST` | first point · second point |
| `3DMASSPROP` | Select objects |
| `3DAREA` | Select a face of a solid |
| `3DDIM` | first extension line origin · second extension line origin · dimension line location <offset to the left> **(prototype)** |
| `DIST` (`DI`) | unchanged in the 2D view; **in 3D mode** it runs as 3DDIST (two 3D points) |

Ribbon tab **3D**: new **Edit** panel (3D Move, 3D Rotate, 3D Scale) after Modelling and
**Measure** panel (3D Distance, Mass Properties, Face Area, 3D Dimension) after View. `HELP` lists
the commands.

### Points

As in milestone 3: typed points are construction-plane coordinates `x,y`, `x,y,z`, `@dx,dy,dz`
(relative to the command's last 3D point), `@dx,dy`, `d<a`; with the default plane (World) they
are world coordinates. 3D commands parse typed points themselves (`acceptsRawPoints`), so
`@dx,dy` keeps the height of the last 3D point. In 3D mode a click gives the 3D point under the
cursor, **snapped** (below), handed to the command directly (`Editor.acceptPoint`) with its 3D pick.

### Transforms

- 3DMOVE / 3DROTATE / 3DSCALE take the solids of the selection (pick-first selections are used);
  2D objects in it are reported (`1 object is not a 3D solid and was ignored.`) and left alone.
  The selection is cleared when the command ends.
- 3DROTATE axes: X / Y / Z are the construction plane's axes through the base point; angles follow
  the right-hand rule about the axis (positive = counter-clockwise looking down the axis). A picked
  point's angle is measured from the plane's Y axis for X, Z axis for Y, X axis for Z (and from the
  arbitrary-axis X direction for a two-point axis).
- 3DSCALE is uniform only (factor > 0). Zero, negative or non-finite values are refused and the
  prompt repeats; factor 1, angle 0 / 360 and a zero displacement change nothing and say so.
- While the last point is asked, the transformed solids follow the cursor as ghosts.
- Each command is **one undo step**. It transforms the mesh (`transformMesh`) **and** the feature
  history (primitive frames, profile frames, revolution axes; sizes scale; Boolean operands
  recursively; a `mesh` feature keeps its mesh only), so re-evaluating a transformed solid gives the
  transformed mesh (`src/tools3d/solid-edit.ts`).

### 2D modify commands on solids

`MOVE`, `COPY`, `ROTATE`, `SCALE` and `MIRROR` keep their prompts. When the selection holds solids
(selected by id, `ALL`, or a click in 3D mode) they transform them in the **drawing plane**
together with the 2D objects, as one undo step:

- MOVE / COPY: translation by the 2D displacement (z unchanged); COPY adds copies with new ids
  (each second point is one undo step, as in 2D).
- ROTATE: about the world Z axis through the base point; SCALE: uniform about the base point on
  z = 0 (so a solid standing on z = 0 stays on it).
- MIRROR: a mirrored **copy** in the vertical plane through the mirror line; the copy is
  outward-facing with a positive volume (mirrored primitives keep right-handed frames).
- The 2D commands work in the drawing plane (WCS XY, where their points lie). This is the
  construction plane when that is World (or XY at z = 0); with another plane use 3DMOVE /
  3DROTATE / 3DSCALE.
- A selection without solids takes exactly the old 2D path. In a mixed selection, copied 2D objects
  get the same CECOLOR / CELTYPE / CELWEIGHT defaults as a 2D-only COPY / MIRROR
  (`Drawing.withEntityDefaults`).
- These commands keep their selection afterwards (2D behaviour): press Esc before the next command
  if it should ask again.

### 3D object snaps

When a 3D command (or DIST in 3D mode) asks for a point and the cursor is over a solid, the point
snaps on the **face under the cursor** (the planar region of connected coplanar triangles around the
hit) to:

| Mode (2D toggle) | Snaps to | Marker |
| --- | --- | --- |
| END (Endpoint) | a corner of the face outline (collinear outline points skipped) | square |
| MID (Midpoint) | the midpoint of an outline edge between corners | triangle |
| CEN (Center) | the face centre (area centroid; a cylinder cap gives the circle centre) | circle |
| NEA (Nearest) | the point under the cursor, when nothing else is in the aperture | hourglass |

- The candidates must lie within the 2D aperture (`APERTURE` box, Options > Drafting) measured at
  the hit's depth; the closest one wins (END before MID before CEN on a tie). F3 (OSNAP off)
  disables 3D snaps; each mode follows its 2D OSNAP setting (NEA is off by default).
- The 2D-style marker (green) is drawn at the snapped point in the 3D view; `jcad3d.snapMarker`
  holds `{ kind, point }`.
- A 2D command in 3D mode (MOVE etc.) gets the **x, y** of a snapped solid point when it clicks on
  a solid with a snap, else where the cursor ray meets z = 0, and now also gets cursor moves
  (its ghosts, and ghosts of selected solids). Limitation: these cursor moves do not go through the
  2D cursor pipeline (`resolveCursor`, which works on the 2D view's screen coordinates), so in 3D
  mode 2D commands get no grid snap, ortho / polar constraint, 2D object snaps or tracking, and
  typed direct-distance entry uses the last 2D-view cursor position.
- Faces of curved surfaces are their facet strips, so END / MID snap to tessellation points there.

### Grips (prototype)

With exactly one solid selected and no command running, the 3D view shows grips (small filled
squares like the 2D grips, GRIPSIZE) at the eight bounding-box corners and the centre. Dragging the
**centre** grip moves the solid by the cursor's motion on the plane through the grip parallel to
the construction plane (the plane facing the viewer when the construction plane is seen edge-on);
a ghost follows the cursor and releasing applies the move as one undo step
(`Grip: solid moved by dx, dy, dz.`). Esc (or a command starting, or the selection changing)
abandons the drag; the release then changes nothing. Corner grips are display-only: no stretching, no snaps or
typed input during the drag, no hover colour.

### Measurement

- 3DDIST (and DIST in 3D mode):
  `Distance = d, Angle in XY Plane = a, Angle from XY Plane = e` (e signed, negative below the
  plane), `Delta X = , Delta Y = , Delta Z =` in construction-plane coordinates, and
  `Planar distance (XY plane of the <name> construction plane) = p`. Lengths use the drawing's
  LUNITS / LUPREC (`formatLength`), angles AUPREC (at least 2 decimals, as the 2D DIST).
- 3DMASSPROP: `Solids`, `Volume`, `Surface area`, `Bounding box` (X / Y / Z ranges) and `Centroid`,
  in construction-plane coordinates (WCS with the default plane, otherwise it says which plane).
  Several solids are summed (overlapping volume counts once per solid; the command says so).
- 3DAREA: `Area = , Perimeter =` of the planar face under the pick (connected coplanar triangles;
  holes count in the perimeter), and the face's triangle count, outline loops and normal. Typed
  points pick the face seen looking down the plane normal.

### 3DDIM (prototype)

3DDIM writes an **ordinary 2D aligned dimension** (current layer and dimension style): both points
are projected onto the construction plane along its normal, and the dimension measures the
projected distance. If either point is off the plane by more than the tolerance (1e-6 relative)
the command logs `... the dimension measures the projected distance P. True 3D distance: T.` The
construction plane must be parallel to WCS XY (World, or XY at any origin): 2D entities have no
elevation, so the dimension is drawn on z = 0 (a raised XY plane says so); other planes are refused.
**True 3D dimension entities (dimensions in arbitrary planes in space) are not supported.**

### Properties palette

For a single selected solid a **Parameters** section lists editable rows: Box / Wedge Width, Depth,
Height; Cylinder Radius, Height, Segments; Cone Base radius, Top radius, Height, Segments; Sphere
Radius, Segments; Torus Radius, Tube radius, Segments; Extrusion Height; Revolution Angle
(degrees), Segments. A Boolean solid lists its operands' parameters (`Operand 1.2 (Cylinder)
radius`, at most 32 rows). Editing a value re-evaluates the feature and replaces the solid **under
the same id** in one undo step: primitives and sweeps in-process at once, without interrupting a
running command (like the Name and Layer rows); a Boolean re-runs its whole history through the
kernel asynchronously as the PROPERTIES command (refused with a message while another command
runs) behind the Boolean commands' guard (`Computing the
solid… (Esc abandons it)`, other input refused, nothing applied when the solid changed meanwhile).
Invalid values are refused on the command line (`PROPERTIES: Width must be positive and finite
(got -1). The solid is unchanged.`) and the row shows the stored value again. Name, Layer and
Color stay editable as in milestone 3.

## Replaying in a browser (supervisor checks)

`window.jcad3d` exists only with the flag on; `jcad3d.editor` is the Editor. Each value is one
`editor.submitInput(text)` after `editor.runCommand(NAME)`; `''` is Enter. Start from a new drawing
and run the blocks in this order (sticky defaults). Part 1 works with 3D mode on or off (typed
input; the construction plane must be World). `tests/tools3d-transform.test.ts` ("docs/3D-EDITING.md
replay") runs Part 1 exactly as written in Node.

### Part 1: typed input

```js
const ed = jcad3d.editor, run = (c, ...xs) => { ed.runCommand(c); for (const x of xs) ed.submitInput(x); };
const id = () => jcad3d.solidIds().at(-1);

// 3DMOVE: a 10 x 10 x 5 box, base point + relative second point, then the Displacement option
run('BOX', '0,0', '10,10', '5');                    // x 0..10, y 0..10, z 0..5
run('3DMOVE', id(), '', '0,0,0', '@20,0,3');        // x 20..30, y 0..10, z 3..8   "3DMOVE: 1 solid moved."
run('3DMOVE', id(), '', 'D', '0,0,-3');             // back to z 0..5

// 3DROTATE: Enter = the plane's Z axis; then 90 degrees about X
run('3DROTATE', id(), '', '20,0,0', '', '90');      // x 10..20, y 0..10, z 0..5
run('3DROTATE', id(), '', '10,0,0', 'X', '90');     // x 10..20, y -5..0, z 0..10

// 3DSCALE: factor 2, then Reference 4 -> 2 (factor 0.5); UNDO / REDO are one step each
run('3DSCALE', id(), '', '10,0,0', '2');            // volume 4000
run('3DSCALE', id(), '', '10,0,0', 'R', '4', '2');  // volume 500
ed.runCommand('UNDO');                              // volume 4000
ed.runCommand('REDO');                              // volume 500

// 2D commands on a mixed selection (L = the last 2D object)
run('BOX', '0,40', '2,42', '2');
const b = id();
run('LINE', '0,30', '10,30', '');
run('MOVE', 'L', b, '', '0,0', '0,5');              // line to y 35, box to y 45..47 (one undo step)
ed.cancel();                                        // Esc: MOVE keeps its selection
run('COPY', b, '', '0,0', '5,0', '');               // a new solid (new id), x 5..7
ed.cancel();
run('MIRROR', b, '', '-1,0', '-1,10');              // mirrored copy, x -4..-2, volume 8 (positive)
ed.cancel();

// Measurement
run('3DDIST', '0,0,0', '3,4,12');
//   Distance = 13.0000, Angle in XY Plane = 53.13, Angle from XY Plane = 67.38
//   Delta X = 3.0000, Delta Y = 4.0000, Delta Z = 12.0000
//   Planar distance (XY plane of the World construction plane) = 5.0000
run('BOX', '40,0', '44,3', '2');
const m = id();
run('3DMASSPROP', m, '');
//   Volume: 24.0000 · Surface area: 52.0000 · Bounding box X 40..44, Y 0..3, Z 0..2
//   Centroid: X: 42.0000  Y: 1.5000  Z: 1.0000
run('3DAREA', '42,1');                              // Area = 12.0000, Perimeter = 14.0000 (top face)

// 3DDIM (prototype)
run('3DDIM', '40,0', '44,0', '42,-2');              // Dimension text = 4.0000 (measured 4.0000)
run('3DDIM', '40,0,0', '44,3,2', '');               // "... projected distance 5.0000. True 3D distance: 5.3852."

// Properties palette edit (what the Width row does), then a refused value
jcad3d.setParameter(m, '/width', '6');              // same id, x 39..45, volume 36
await jcad3d.idle();
jcad3d.setParameter(m, '/width', '-1');             // PROPERTIES: Width must be positive and finite (got -1). The solid is unchanged.
```

Error paths (each leaves the drawing unchanged):

```js
run('3DSCALE', m, '', '0,0,0', '0');                // Value must be positive and finite (got 0). (prompt repeats)
ed.cancel();
run('3DROTATE', m, '', '0,0,0', '', '360');         // 3DROTATE: zero rotation; nothing changed.
run('3DMOVE', 'L', '');                             // 1 object is not a 3D solid ... / 3DMOVE: no 3D solids selected.
run('3DPLANE', 'XZ'); run('3DDIM');                 // 3DDIM: 2D dimensions lie on the drawing plane ... (3D mode on only)
run('3DPLANE', 'W');
run('3DAREA', '500,500', '');                       // No solid face there; pick a face of a solid.
```

### Part 2: 3D mode (snaps, ghosts, grips)

Screen positions come from `jcad3d.project(worldPoint)` (CSS px relative to the 3D canvas);
`jcad3d.click(x, y, shift)` is a left click there and `jcad3d.hoverAt(x, y)` a cursor move (real
mouse events through Playwright do the same). Continue after Part 1:

```js
ed.runCommand('3DMODE');
ed.runCommand('3DVIEW seiso');
const P = (x, y, z) => jcad3d.project({ x, y, z });
// A point `px` pixels from screen point a toward b (inside the face when b is the face centre).
const toward = (a, b, px) => { const d = Math.hypot(b.x - a.x, b.y - a.y); return { x: a.x + (b.x - a.x) * px / d, y: a.y + (b.y - a.y) * px / d }; };

// 3D snaps on the top face of the edited box m (x 39..45, y 0..3, z 0..2): two corners, clicked
// 3 px inside the face. Expect the green square marker and jcad3d.snapMarker.kind === 'endpoint'.
const top = P(42, 1.5, 2);
ed.runCommand('3DDIST');
let q = toward(P(45, 3, 2), top, 3);
jcad3d.hoverAt(q.x, q.y);                           // jcad3d.snapMarker -> { kind: 'endpoint', point: {x:45,y:3,z:2} }
jcad3d.click(q.x, q.y, false);
q = toward(P(39, 0, 2), top, 3);
jcad3d.click(q.x, q.y, false);                      // Distance = 6.7082, ..., Delta Z = 0.0000
// Midpoint and centre: hover 3 px from the edge midpoint / 2 px from the face centre.
ed.runCommand('3DDIST');
q = toward(P(42, 0, 2), top, 3); jcad3d.hoverAt(q.x, q.y);   // snapMarker.kind === 'midpoint' (triangle)
q = toward(top, P(45, 3, 2), 2); jcad3d.hoverAt(q.x, q.y);   // snapMarker.kind === 'center' (circle)
ed.cancel();

// Ghost while dragging the second point of 3DMOVE: jcad3d.previewSolids.length === 1 while hovering.
ed.runCommand('3DMOVE'); ed.submitInput(m); ed.submitInput(''); ed.submitInput('42,1.5,2');
q = P(52, 1.5, 2); jcad3d.hoverAt(q.x, q.y);        // translucent ghost with yellow edges
ed.cancel();                                        // Esc: nothing moved

// Grips: select m alone, then drag the centre grip 60 px to the right.
ed.runCommand('3DVIEW top');
ed.selection.clear(); ed.selection.add(m); ed.notify('selection');
const g = jcad3d.gripScreenPoints()[8];             // nine grips; [8] is the centre
jcad3d.beginGripDrag(g.x, g.y);                     // true
jcad3d.gripDragTo(g.x + 60, g.y);                   // ghost follows
jcad3d.endGripDrag(g.x + 60, g.y);                  // "Grip: solid moved by d, 0.0000, 0.0000."  (one undo step)
// With the real mouse: mouse down on the centre grip, move, mouse up (left button, no Shift).
```

`tests/tools3d-snap3d.test.ts` checks the same routing (snapped clicks for 3D commands, snapped
x, y for 2D MOVE, ghosts, the centre-grip drag, DIST in and out of 3D mode) against a stand-in
plan-view viewport in Node; the WebGL drawing of markers and grips is only visible in the browser.

## Code map

| File | Role |
| --- | --- |
| `src/tools3d/solid-edit.ts` | Similarity transforms of solids (mesh + feature), matrix helpers, one-step commits, ghosts; used by every editing path. |
| `src/tools3d/transform.ts` | 3DMOVE, 3DROTATE, 3DSCALE. |
| `src/tools3d/snap3d.ts` | Face regions, END / MID / CEN / NEA snaps (`snapOnSolid`, `snapPick3`). |
| `src/tools3d/grips.ts` | Grip points and the centre-grip drag plane. |
| `src/tools3d/measure.ts` | 3DDIST (and DIST in 3D mode), 3DMASSPROP, 3DAREA. |
| `src/tools3d/dim3d.ts` | 3DDIM prototype. |
| `src/tools3d/properties-edit.ts` | Parameter rows, validation, re-evaluation (`solidParameterTool`). |
| `src/render3d/markers.ts` | Snap-marker and grip shapes in screen pixels. |
| `src/render3d/viewport3d.ts` | `Viewport3DOverlay.grips3d` / `gripSize` / `snap3d`, drawn in a pixel projection on top. |
| `src/app/experimental-3d.ts` | Commands, Edit / Measure panels, DIST wrapper, snapped picks, 2D commands' cursor moves, grips, `jcad3d.setParameter` / `gripScreenPoints` / `beginGripDrag` / `gripDragTo` / `endGripDrag` / `snapMarker`. |
| `src/tools/modify.ts`, `src/tools/edit.ts` | MOVE / COPY / ROTATE and MIRROR / SCALE: the solid branch (only when the selection holds solids). |
| `src/tools3d/script3d.ts` | 2D rubber-band previews (`Request.preview`) for 3D scripts (3DDIM). |
| `src/ui/properties.ts` | The Parameters section. |

## Prototype-only and not supported

- **3DDIM** writes 2D dimensions on the drawing plane; true 3D dimension entities are unsupported,
  and planes not parallel to WCS XY are refused. Its rubber band (the dimension following the
  cursor) shows in the 2D view only; in 3D mode the dimension appears when it is placed.
- **Grips**: only the centre grip does anything (move); no stretch, no snap during the drag.
- No transform gizmo (the plan's "gizmo"): transforms are prompt-driven with ghosts.
- 3D snaps cover END / MID / CEN / NEA on the face under the cursor only (no intersection,
  perpendicular, tracking or snaps on hidden or neighbouring faces; curved faces snap to facets).
- 2D commands transform solids in the drawing plane only; 3DSCALE is uniform only (no
  non-uniform scaling of solids); there is no MIRROR3D / 3DMIRROR or 3DARRAY.
- A Boolean solid's parameter edit re-runs its whole history, so it is as slow as the original
  Booleans; solids whose history is a `mesh` feature have no parameters.
