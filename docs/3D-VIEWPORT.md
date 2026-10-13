# Experimental 3D viewport (milestone 2)

Status: **experimental, off by default.** Everything here is inert unless
**Options > Files > Experimental: 3D modelling (restart required)** (setting `experimental3d`)
was on when the app started. With the flag off no 3D command is registered, the ribbon has no 3D
tab, no canvas or WebGL context is created (`tests/experimental-3d-flag.test.ts`).

## Using it

| Command | What it does |
| --- | --- |
| `3DMODE` | Toggle model space between the 2D canvas and the 3D viewport. Paper-space layouts always stay 2D (switching to a layout leaves 3D mode). |
| `3DORBIT` (`3DO`) | Left drag orbits until Enter or Esc. |
| `3DVIEW <name>` | Named view: Top, Bottom, Front, Back, Left, Right, SWiso, SEiso, NEiso, NWiso (then zoom extents). |
| `PLAN` | Back to the top (plan) view. |
| `3DPERSPECTIVE` | Toggle perspective / parallel projection, keeping the framing. |
| `3DZOOMEXTENTS` | Frame the solids and the 2D drawing. |
| `3DDEMO` | **Development test scene**: adds a box, a cylinder and a sphere through a normal undoable edit. |

Mouse in 3D mode: wheel zooms at the cursor, middle drag pans, Shift + middle drag orbits,
middle double-click zooms extents, left click selects the solid under the cursor (Shift adds,
a click on empty space clears; ids go into `editor.selection`), rollover highlights the solid
under the cursor. The ribbon tab **3D** has View (Top, Front, Right, SW Iso, SE Iso, Perspective,
Orbit, Zoom Extents, 3D Mode) and Test (3D Demo). A label at the top right names the view and
projection; a WCS triad sits at the lower left (X red, Y green, Z blue).

## Code map

- `src/render3d/camera.ts`: `Camera3D` (target, distance, yaw, pitch, projection, fovY,
  orthoHeight) and pure functions (view / projection matrices, orbit, pan, zoom at cursor,
  zoom to bounds, rays from screen, projection to screen, AutoCAD view presets). Top view =
  yaw -90 degrees, pitch +90 degrees: +X right, +Y up, identical to the 2D view
  (`cameraFrom2D`, tested against `Viewport.toScreen`).
- `src/render3d/gl/device.ts`: `GpuDevice`, the only owner of a WebGL2 context: program
  compilation with logs, buffers, vertex arrays, `capabilities()` (vendor / renderer through
  `WEBGL_debug_renderer_info`, version, max texture size, context losses), context loss and
  restore. GPU diagnostics should read this object.
- `src/render3d/gl/programs.ts`: GLSL ES 3.00 programs (flat-shaded solids with headlight +
  ambient, coloured lines with optional radial fade, id buffer) and `MeshBufferCache` (GPU buffers
  per sealed `Mesh3D` in a WeakMap; idle buffers pruned; reset after context loss).
- `src/render3d/scene-data.ts`: pure builders (de-indexed flat vertices, feature edges at more
  than 30 degrees, adaptive grid, line batches, colour parsing, solid colours by the 2D rules).
- `src/render3d/scene-sink.ts`: the `SceneSink` seam (`line`, `polygon`) and the adapter that
  emits the 2D model-space entities on z = 0 (approximations listed in the file header: 1 px
  continuous lines, stroke-font text, hatch boundaries only, no fills).
- `src/render3d/picking.ts`: CPU picking with a per-mesh BVH (median split, leaves of 8).
- `src/render3d/viewport3d.ts`: `Viewport3D` (its own canvas; background, solids, edges,
  underlay, grid, triad; GPU pick with CPU fallback; resize and devicePixelRatio).
- `src/app/experimental-3d.ts`: the flag wiring, commands, mouse routing, ribbon tab and the
  `window.jcad3d` debug handle (only with the flag on).

## Precision and picking

Vertex data is float32 relative to a per-batch origin; the shaders add `origin - target` and use
a view matrix relative to the camera target, so drawings far from the world origin do not
jitter. In parallel projection the eye is moved behind the scene before each frame and pick
(`withOrthoClearance`, the image is unchanged). `Viewport3D.pick` reads the id buffer (one colour
per visible solid, re-rendered only when the camera, size, model or layers change) at the device
pixel under the cursor; `pickExact` casts a ray through the centre of the same device pixel, so
both agree. `pick` falls back to the CPU when read-back fails or the context is lost.

## Testing

Unit tests (Node): `tests/render3d-camera.test.ts`, `tests/render3d-picking.test.ts`,
`tests/render3d-scene-sink.test.ts`, `tests/experimental-3d-flag.test.ts`.
Browser: `npm run build && npm run e2e:3d` (`scripts/e2e-3d.mjs`, headless Chromium with
SwiftShader WebGL2; screenshots in `screenshots-3d/`, ignored by git).

## Not done yet (prototype limits)

- 2D drawing commands started in 3D mode get a left click as typed coordinates on z = 0 (no
  object snaps, no rubber band, no grips); window / crossing selection does not exist in 3D.
- Lines are always 1 device pixel (WebGL line width); no lineweights, linetypes or fills in the
  underlay; selected 2D objects are not highlighted in 3D.
- No view cube widget (text label only), no saved 3D views, no per-tab 3D camera.
- Solids are still not saved to files (milestone 5); the save guard warns as before.
