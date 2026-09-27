# VoltCAD 2D

A desktop 2D electrical schematic drafting application whose workspace is modelled on
AutoCAD Electrical: ribbon, Project Manager palette, command window, status bar toggles,
dark model space, ladder / wire / component tools, and DXF interchange.

All artwork, icons and symbol geometry are original. No Autodesk assets, code, or
trademarks are used.

## Stack

- **Electron** shell (`electron/main.cjs`, `electron/preload.cjs`) with a context-isolated
  IPC bridge for Open / Save dialogs.
- **TypeScript + Vite** renderer, no UI framework. The drawing area is a Canvas 2D renderer.
- **Vitest** unit tests for geometry, entities, document/undo, snapping/selection, DXF and
  electrical helpers. **Playwright** screenshot script for visual checks.

## Run

```bash
npm install
npm run electron:dev     # Vite dev server + Electron with live reload
npm start                # production build then Electron
npm run dev              # renderer only, in a browser (http://localhost:5173/?demo)
npm test                 # unit tests
npm run typecheck
npm run build && npm run screenshot   # screenshots/*.png from headless Chromium
```

Append `?demo` to the URL (or run the screenshot script) to load a sample motor-control ladder.

## Commands

Type at the command line, or use the ribbon. Enter / Space repeats the last command,
Esc cancels, right-click opens the context menu. Point input accepts `x,y`, `@dx,dy`,
`@dist<angle` and direct distance entry (type a number while dragging).

| Command | Alias | Purpose |
| --- | --- | --- |
| LINE, PLINE, CIRCLE, ARC, RECTANG, TEXT | L, PL, C, A, REC, T | Draw |
| ERASE, MOVE, COPY, ROTATE, DIST, LIST | E, M, CO, RO, DI, LI | Modify / inquiry |
| UNDO, REDO, ZOOM [E/I/O], GRID, SNAP, ORTHO, POLAR, OSNAP, LAYER | U, Z, F7, F9, F8, F10, F3, LA | View / settings |
| AEWIRE | WIRE, W | Orthogonal wire on the WIRES layer |
| AELADDER | LADDER | Insert a ladder (width, spacing, rungs, reference numbers) |
| AECOMPONENT [block] | CMP | Icon-menu component insert; trims the wire and prompts for tag / description |
| AEWIRENO [start] | WIRENO | Number every horizontal wire net |
| NEW, OPEN, SAVE, SAVEAS | Ctrl+N / O / S / Shift+S | Files (DXF) |

Mouse: wheel zooms at the cursor, middle-drag pans, double middle-click zooms extents.
Click picks; drag left-to-right is a window selection (blue), right-to-left is crossing (green);
Shift-click removes from the selection. Object snaps: endpoint, midpoint, center, intersection,
perpendicular.

## File format

Drawings are saved as **DXF (AC1015 / AutoCAD 2000)** with layers, blocks, attributes,
LINE / CIRCLE / ARC / LWPOLYLINE / TEXT / INSERT. DXF opens directly in AutoCAD and every
other CAD package. Native **DWG** is a closed binary format; the plan is to add it at the
file boundary through a third-party library (LibreDWG or ACadSharp) once the DXF layer is
stable, since both share the same data model.

## Layout of the source

```
src/core        geometry, entity model, document + undo, snapping, selection
src/io          DXF reader / writer
src/render      ACI palette, entity drawing, viewport (grid, crosshair, grips, markers)
src/tools       drawing, modify and electrical tools (state machines fed by the editor)
src/app         Editor controller (input parsing, mouse/keyboard, command registry), demo seed
src/ui          ribbon, command window, status bar, project manager, dialogs, chrome
src/electrical  JIC-style symbol library (block definitions with TAG1 / DESC1 attributes)
```
