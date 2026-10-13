# Experimental 3D modelling commands (milestone 3, UI)

Status: **experimental, off by default.** Everything here exists only when
**Options > Files > Experimental: 3D modelling** (setting `experimental3d`) was on when the app
started; with the flag off none of these commands is registered and the ribbon has no 3D tab
(`tests/experimental-3d-flag.test.ts`). The modelling core (profiles, sweeps, the Manifold kernel)
is described in [3D-KERNEL.md](3D-KERNEL.md), the viewport in [3D-VIEWPORT.md](3D-VIEWPORT.md),
the plan in [3D-PLAN.md](3D-PLAN.md).

## Commands

| Command (alias) | Prompts (AutoCAD style; `<value>` = last value, Enter accepts it) |
| --- | --- |
| `BOX` | first corner or [Center] · other corner or [Cube/Length] · height or [2Point] |
| `WEDGE` (`WE`) | as BOX; the tall face is at the first corner, the slope falls toward the other corner |
| `CYLINDER` (`CYL`) | center point of base · base radius or [Diameter] · height or [2Point/Axis endpoint] |
| `CONE` | as CYLINDER, height also offers [Top radius] (default 0 = pointed; > 0 = frustum) |
| `SPHERE` | center point · radius or [Diameter] |
| `TORUS` (`TOR`) | center point · radius or [Diameter] · tube radius or [2Point/Diameter] |
| `EXTRUDE` (`EXT`) | Select objects to extrude · height of extrusion (typed, or two points) or [Delete/Keep] |
| `REVOLVE` (`REV`) | Select objects to revolve · axis start point or [X/Y/Z] · axis endpoint · angle of revolution or [Reverse/Delete] <360> |
| `UNION` (`UNI`) | Select objects (two or more solids) |
| `SUBTRACT` (`SU`) | Select solids to subtract from (Enter) · Select solids to subtract (Enter) |
| `INTERSECT` (`IN`) | Select objects (two or more solids) |
| `3DPLANE` | construction plane [World/Top/Front/Right/Solid face/Origin] <World> (XY / XZ / YZ / Face also typed); `3DPLANE XZ` answers directly |

Ribbon tab **3D**: Modelling (Box, Wedge, Cylinder, Cone, Sphere, Torus, Extrude, Revolve),
Boolean (Union, Subtract, Intersect), Plane (3DPLANE), View and Test as before. `HELP` lists the
commands. Every command adds or replaces solids as **one undo step**; new solids take the current
layer and the current colour (Home > Properties). 3D commands refuse paper-space layouts.

### Points, sizes and the construction plane

- Typed points are construction-plane coordinates: `x,y` (on the plane), `x,y,z`, `@dx,dy`,
  `@dx,dy,dz` (relative to the last point of the command; `@dx,dy` keeps that point's height
  above the plane), `d<a`. With the default plane (World) they are world coordinates. 3D commands
  get typed points as text (the optional `Tool.acceptsRawPoints`: the command line does not turn
  `x,y` / `@dx,dy` / `d<a` into a 2D point first) and parse points, numbers and option keywords
  themselves, so relative input is measured from the true 3D point. Space still submits like
  Enter, as at every other prompt.
- In 3D mode a click gives the 3D point under the cursor: a point on a solid face when the cursor
  is over a solid, else where the cursor ray meets the construction plane. The ghost of the solid
  being built follows the cursor (translucent faces, yellow edges). The click goes to the command
  directly (`Editor.acceptPoint`, echoed on the command line as plane coordinates); the 3D hit is
  available to the command only while it handles that click or cursor move, so a typed point is
  always exactly the typed coordinates. After a click the editor's last point is the picked point's
  world x, y.
- Sizes can be typed or picked. Radii: distance in the plane through the base point. Heights:
  typed (negative = below the plane); picked in the 3D view = where the cursor ray passes the
  normal line through the base; a typed `x,y,z` = its offset along the normal; a point on the
  plane (plan view) = its distance from the base point; `2Point` = the distance between two points.
  A BOX corner typed as `x,y,z` gives the height directly; picked corners are projected onto the
  base plane.
- Zero, negative (where not allowed) or non-finite sizes are reported (`Value must be positive and
  finite`, `Height must be a non-zero finite number`, ...) and the prompt repeats.
- `3DPLANE`: World = WCS; Top / Front / Right (typed also XY / XZ / YZ) = the world-parallel
  planes XY / XZ / YZ through the current origin (Front: X right, Y up the world Z, normal -Y;
  Right: normal +X); Solid face (typed also Face) = the plane of a picked solid face (in the plan
  view: the face seen looking down); Origin = same axes, new origin (typed in the current plane's
  coordinates; the prompt `<0,0,0 (world x,y,z)>` shows the current origin both ways and Enter
  keeps it). Clicking an option in the command line sends its first letter (as at 2D prompts), so
  every 3D prompt shows options with distinct first letters.
  The plane shows in the status bar and in the view label. **While 3D mode is off, every 3D
  command uses WCS XY** (z = 0), whatever 3DPLANE set; the plane applies again in 3D mode.

### EXTRUDE and REVOLVE

- Accepted: closed polylines, circles, ellipses, closed splines, and lines / arcs / open curves
  forming closed loops (one outer boundary, holes allowed). Profile errors are printed exactly as
  `src/model3d/sketch.ts` words them, and the drawing stays unchanged.
- 2D objects lie on z = 0. The profile is built on the construction plane when that plane is the
  drawing plane; otherwise on WCS XY (the command says so).
- Source objects are **kept** by default (AutoCAD DELOBJ = 0; the command says so at its start).
  The `Delete` option removes them in the same undo step as the new solid (`Keep` switches back).
- REVOLVE axis: two points, or X / Y / Z of the construction plane through its origin. The axis
  must lie in the profile plane with the profile on one side (`Cannot revolve: ...` otherwise, and
  the axis is asked again). Angles in degrees, non-zero, at most 360; `Reverse` turns the other way.
- Triangle budget (`MAX_SOLID_TRIANGLES`): a REVOLVE over it prints the budget message and asks
  for the angle again with the same axis (a partial turn has fewer steps); an EXTRUDE over it
  prints the message and ends (its size depends on the profile only). The drawing is unchanged.

### Booleans

- The kernel (Manifold; a module worker in the app, in-process in Node) is created on the first
  Boolean and disposed when 3D mode ends, when the command ends while 3D mode is off (nothing else
  would release it there; the next Boolean starts a new kernel, paying the WebAssembly start-up
  again), or when the window unloads (`pagehide`). While it runs the
  prompt reads `Computing the union… (Esc abandons it)` and other input is refused with a message;
  Esc or another command abandons the result.
- Errors are printed verbatim with the command name (`UNION: The second solid cannot be used in
  the union: it is not a closed solid ...`, `INTERSECT: The solids do not overlap, so their
  intersection is empty.`, `... unavailable in this environment: ...`, timeouts), followed by
  `<NAME>: the drawing is unchanged.`
- The result keeps the first operand's id, layer, colour and name; its feature is
  `{ kind: 'boolean', op, operands: [a.feature, b.feature] }`, folded left to right for more
  operands. SUBTRACT unites the first set, then subtracts each solid of the second. Undo restores
  every operand. If an operand changed while the kernel ran, nothing is applied.

### Selecting solids

- In 3D mode a click at `Select objects:` picks the solid under the cursor, else the 2D object
  where the cursor ray meets z = 0; Shift removes. Outside a command a click selects solids (M2).
- Typed at `Select objects:`: `ALL` takes the visible 2D objects **and solids**; a solid's id
  (`jcad3d.solidIds()`) takes that solid; `L` / `P` work for 2D objects as before.
- `ERASE` and the Delete key remove selected solids together with selected 2D objects in one undo
  step; a selection without solids behaves exactly as before.
- Properties palette, for a selection of solids only: header `3D Solid`, Type (feature kind),
  Layer, Color, Name (editable), Triangles, Volume, Size X / Y / Z (read-only). A mixed selection
  shows the 2D rows as before.

## Replaying in a browser (supervisor checks)

`window.jcad3d` exists only with the flag on. `jcad3d.editor` is the Editor. Each line below is
one `editor.submitInput(text)` after `editor.runCommand(NAME)`; `''` is Enter. Booleans finish
asynchronously: `await jcad3d.idle()` before checking. The model is
`editor.doc.snapshot.model3d.solids` (ids: `jcad3d.solidIds()`). Start from a new drawing; the
results below assume these steps run in this order (sticky defaults). Turn 3D mode on first
(`editor.runCommand('3DMODE')`) to see the solids; typed input works the same in both modes as
long as the construction plane is World.

```js
const ed = jcad3d.editor, run = (c, ...xs) => { ed.runCommand(c); for (const x of xs) ed.submitInput(x); };

// BOX 10 x 10 x 5 standing on (0,0): volume 500
run('BOX', '0,0', '10,10', '5');
// Cube 4 (volume 64); box around a centre 4 x 6 x 4 at z 8..12
run('BOX', '20,0', 'C', '4');
run('BOX', 'C', '30,0,10', '32,3', '4');
// CYLINDER r 3, h 8 at (40,0); Diameter 4 (r 2) with the last height; along +X by axis endpoint
run('CYLINDER', '40,0', '3', '8');
run('CYLINDER', '50,0', 'D', '4', '');
run('CYLINDER', '60,0', '1', 'A', '63,0,0');
// WEDGE 4 x 4 x 3 (volume 24), CONE frustum r 2 -> 1, h 4, SPHERE r 2, TORUS 5 / 1
run('WEDGE', '0,20', '4,24', '3');
run('CONE', '20,20', '2', 'T', '1', '4');
run('SPHERE', '40,20', '2');
run('TORUS', '60,20', '5', '1');

// EXTRUDE a rectangle 4 x 3 by 2 (volume 24), source kept; a circle r 1 by 3 with Delete
run('RECTANG', '0,-20', '4,-17');
run('EXTRUDE', 'L', '', '2');
run('CIRCLE', '10,-20', '1');
run('EXTRUDE', 'L', '', 'D', '3');
// REVOLVE a rectangle x 21..22, y -20..-17 a full turn about the vertical line x = 20
run('RECTANG', '21,-20', '22,-17');
run('REVOLVE', 'L', '', '20,-20', '20,-10', '');

// UNION / SUBTRACT / INTERSECT on fresh boxes (ids typed at "Select objects:")
run('BOX', '0,40', '2,42', '2');
run('BOX', '1,40', '3,42', '2');
run('BOX', '0,40', '1,41', '5');
let ids = jcad3d.solidIds().slice(-3);            // [a, b, c]
run('UNION', ids[0], ids[1], '');                 // a + b: volume 12, keeps a's id
await jcad3d.idle();
run('SUBTRACT', ids[0], '', ids[2], '');          // (a + b) - c: volume 10
await jcad3d.idle();
run('BOX', '10,40', '12,42', '2');
run('BOX', '11,40', '13,42', '2');
ids = jcad3d.solidIds().slice(-2);
run('INTERSECT', ids[0], ids[1], '');             // volume 4
await jcad3d.idle();

// Undo restores the intersection's operands; ERASE a solid by id
ed.runCommand('UNDO');
run('ERASE', ids[1], '');

// Construction plane: a box on the Front (XZ) plane in 3D mode, then back to World
ed.runCommand('3DMODE');
run('3DPLANE', 'XZ');
run('BOX', '0,0', '4,2', '3');                    // x 0..4, z 0..2, y 0..-3
run('3DPLANE', 'W');
```

Error paths worth replaying (each leaves the model unchanged):

```js
run('BOX', '0,0', '0,5');                         // corner refused, the prompt repeats
ed.cancel();                                      // Esc
run('PLINE', '0,-40', '4,-40', '4,-37', '');      // an open polyline
run('EXTRUDE', 'L', '');                          // the sketch message (open profile), verbatim
run('BOX', '100,0', '101,1', '1');
run('BOX', '200,0', '201,1', '1');
ids = jcad3d.solidIds().slice(-2);
run('INTERSECT', ids[0], ids[1], '');             // INTERSECT: The solids do not overlap, ...
await jcad3d.idle();
run('UNION', ids[0], ids[1], '');                 // Esc while it reads "Computing the union…"
ed.cancel();
```

`tests/tools3d-editor.test.ts` replays the sequences above against a real Editor in Node (3D mode
off, the in-process kernel), so they are known to produce the stated results.

## Code map

| File | Role |
| --- | --- |
| `src/tools3d/context.ts` | The optional 3D `ToolContext` members (`point3`, `ray3`, `face3`, construction plane, `solids`, `kernel`, `setPreview3d`), `extendContext3d`, plane coordinates, typed 3D points, height helpers. |
| `src/tools3d/script3d.ts` | `Script3DTool`: generator scripts with ghosts (`preview3d`), asynchronous steps (`compute`) and 3D prompt helpers. |
| `src/tools3d/primitives.ts` | BOX, WEDGE, CYLINDER, CONE, SPHERE, TORUS. |
| `src/tools3d/sweeps.ts` | EXTRUDE, REVOLVE. |
| `src/tools3d/booleans.ts` | UNION, SUBTRACT, INTERSECT. |
| `src/tools3d/plane.ts` | 3DPLANE. |
| `src/tools3d/properties.ts` | Properties rows for solids. |
| `src/app/experimental-3d.ts` | Commands, ribbon panels, the context extension, click / cursor routing in 3D mode, kernel lifetime, status text, `window.jcad3d`. |
| `src/core/document.ts` | `Drawing.updateModel3D(fn, removeEntityIds?)`: one undoable step for solids (and 2D removals). |
| `src/render3d/viewport3d.ts` | `Viewport3DOverlay.previewSolids`: ghost solids. |

Changes to 2D files are additive: optional `ToolContext` members, `Editor.toolContextExtension` /
`toolContext()` / `acceptPoint()` / `selectionPending` / `pickIds()`, the optional
`Tool.acceptsRawPoints` honoured by the prompter (null / unused with the flag off), the solid
branch of ERASE (only when the selection holds solid ids) and of the Properties palette (only for
a solids-only selection).

## Prototype limits

- No 3D object snaps (vertex, edge midpoint, face centre) yet (milestone 4); clicks snap only to
  solid faces and the construction plane. 2D commands in 3D mode still get z = 0 typed points.
- The ghost and picked heights exist in the 3D view only; the 2D view shows no ghost of a solid.
- EXTRUDE / REVOLVE take one profile (one outer loop with holes) per command; several separate
  closed objects are refused by the sketch step ("more than one outer region").
- No Taper / Path / Direction (EXTRUDE), no Start angle / Object axis (REVOLVE), no 3P / 2P / Ttr
  circles or elliptical bases (CYLINDER / CONE), no rotation for Cube.
- Booleans with a `mesh`-feature operand work, but their history cannot be re-evaluated later.
- The construction plane is session state (not saved), and solids are not saved to files yet
  (milestone 5).
