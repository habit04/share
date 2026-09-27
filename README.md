# JAutoCad

A desktop 2D electrical schematic drafting application whose workspace is modelled on
AutoCAD Electrical: ribbon, Project Manager and Properties palettes, command window,
status bar toggles, dark model space, ladder / wire / component tools, cross-referencing,
reports, sheet templates, DWG import and DXF interchange.

All artwork, icons and symbol geometry are original. No Autodesk assets, code, or
trademarks are used.

## Stack

- **Electron** shell (`electron/main.cjs`, `electron/preload.cjs`) with a context-isolated
  IPC bridge for file dialogs, DWG parsing, CSV export and PDF plotting. The main process
  only writes to paths the user chose through its own dialogs.
- **TypeScript + Vite** renderer, no UI framework. The drawing area is a Canvas 2D renderer;
  text is drawn with the public-domain **Hershey Roman Simplex** stroke font (see
  `src/render/fonts/HERSHEY-LICENSE`), which gives the classic `txt.shx` look.
- **LibreDWG** (GPL-3.0) compiled to WebAssembly (`@mlightcad/libredwg-web`) reads DWG
  files R14 through 2018 in the main process. Because LibreDWG is GPL, a distributed build
  that includes it must be licensed compatibly.
- **Vitest** unit tests (geometry, entities, document/undo, snapping, DXF, DWG fixtures,
  electrical helpers, reports, templates, projects). **Playwright** screenshot script for
  visual checks.

## Run

```bash
npm install
npm run electron:dev     # Vite dev server + Electron with live reload
npm start                # production build then Electron
npm run dev              # renderer only, in a browser (http://localhost:5173/?demo)
npm test                 # unit tests (includes DWG fixtures in ./fixtures)
npm run typecheck
npm run build && npm run screenshot   # screenshots/*.png from headless Chromium
npm run dist             # installers via electron-builder (win/mac/linux)
node scripts/dwg2dxf.mjs in.dwg [out.dxf]   # command-line DWG -> DXF
```

Append `?demo` to the URL (or run the screenshot script) to load a sample motor-control ladder.

## Commands

Type at the command line, or use the ribbon. Enter / Space repeats the last command (with
its arguments), Esc cancels, right-click opens the context menu. Point input accepts `x,y`,
`@dx,dy`, `@dist<angle` and direct distance entry (type a number while dragging). Option
keywords shown in `[brackets]` are clickable.

| Command | Alias | Purpose |
| --- | --- | --- |
| LINE, PLINE, CIRCLE, ARC, RECTANG, TEXT | L, PL, C, A, REC, T | Draw |
| ERASE, MOVE, COPY, ROTATE, MIRROR, SCALE, TRIM, EXTEND, OFFSET, EXPLODE | E, M, CO, RO, MI, SC, TR, EX, O, X | Modify |
| DIST, LIST, PROPERTIES | DI, LI, PR | Inquiry, Properties palette |
| UNDO, REDO, ZOOM [E/W/I/O], GRID, SNAP, ORTHO, POLAR, OSNAP, DYNMODE, LWDISPLAY, CURSORSIZE, LAYER | U, Z, F7, F9, F8, F10, F3, F12, LW, LA | View / settings (persisted) |
| AEWIRE | WIRE, W | Orthogonal wire on the current wire type; junction dots at tees |
| AEWIRETYPE | WIRETYPE | Choose the wire layer (gauge / colour) for new wires |
| AELADDER | LADDER | Insert a ladder (width, spacing, rungs, references, 1/3 phase) |
| AECOMPONENT [block] | CMP | Icon menu (JIC or IEC); trims the wire; tag, description, manufacturer, catalog |
| AEWIRENO | WIRENO | Number every wire net by rung reference (100, 100A, ...) |
| AEXREF | XREF | Coil / contact cross-reference text |
| AEPLC | PLC | Parametric PLC I/O module |
| AESOURCE, AEDEST | SOURCE, DEST | Source / destination signal arrows, linked by signal code |
| AETERMSTRIP | TERMSTRIP | Panel terminal strip |
| AEREPORT [bom/components/wires/terminals/audit] | REPORT, BOM | Reports with CSV export |
| NEWSHEET | TEMPLATE | New drawing from an ANSI / ISO sheet template with title block |
| OPENPROJECT, PROJECTADD, PROJECTSAVE | PROJECT | Project files (`*.jacproj.json`) listing drawings |
| NEW, OPEN, SAVE, SAVEAS, PLOT, RECENT | Ctrl+N / O / S / Shift+S | Files: DXF and DWG open, DXF save, PDF plot |

Mouse: wheel zooms at the cursor, middle-drag pans, double middle-click zooms extents.
Click picks; drag left-to-right is a window selection (blue), right-to-left is crossing (green);
Shift-click removes from the selection. Drag a blue grip to stretch; double-click text or a
component to edit it. Object snaps: endpoint, midpoint, center, intersection, perpendicular.

## File formats

- **DXF (AC1015 / AutoCAD 2000)** is the native save format: layers, blocks, attributes
  (including invisible ones), LINE / CIRCLE / ARC / LWPOLYLINE (with bulges on read) / TEXT /
  MTEXT (read) / INSERT. Wire junction dots are written as zero-hole donuts so they stay filled
  in other CAD programs. The writer emits the full table set (BLOCK_RECORD, LTYPE, STYLE, APPID,
  DIMSTYLE, VPORT, $HANDSEED, CLASSES, OBJECTS) that AutoCAD expects.
- **DWG** (R14 - 2018) opens through LibreDWG. The import is read-only; SAVE writes a DXF next
  to the original. Sample files from the LibreDWG test suite live in `fixtures/` and are used
  by the tests.
- **PDF** plotting renders the extents onto a white sheet.
- **CSV** export for every report.

## Layout of the source

```
src/core        geometry, entity model (with memoised block explosion), document + undo, snapping, selection
src/io          DXF reader / writer, DWG converter (LibreDWG database -> drawing)
src/render      ACI palette, entity drawing, Hershey stroke font, viewport (grid, crosshair, grips, markers)
src/tools       drawing, modify, edit (trim/extend/offset/...), electrical and PLC/arrow/terminal tools
src/app         Editor controller, coordinate input parsing, settings, project model, demo seed
src/ui          ribbon, command window, status bar, palettes (project manager, properties), dialogs, chrome
src/electrical  JIC and IEC symbol libraries, cross-referencing, reports, sheet templates
scripts         DWG reader (Node / Electron main), dwg2dxf CLI, screenshot capture
```
