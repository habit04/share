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
| AECOMPONENT [block] | CMP | Icon menu (JIC or IEC); breaks the wire; Insert/Edit Component dialog with INST, LOC, DESC1-3, MFG, CAT, ASSYCODE, RATING, pins, "Used" tag list and Catalog Lookup |
| AEEDITCOMPONENT | AEEDIT | Edit an existing component (retagging a parent carries its contacts along) |
| AECHILD | CHILD | Insert a child contact: pick the parent coil from a list, NO or NC, data copied from the parent |
| AECOMPONENT3 [block] | AEC3 | Insert a 3-pole device on a 3-wire bus (poles share the tag, POLE=1..3, dashed link) |
| AERETAG [S] | RETAG | Renumber all (or selected) tags in ladder order with the drawing's tag format |
| AETOGGLENC, AESWAP, AEUPDATEBLOCK | TOGGLENC, SWAPBLOCK, UPDATEBLOCK | NO/NC variant in place; swap a symbol keeping its data; refresh block definitions from the library |
| AECATALOG [family], AECATALOGLOAD | CATALOG, LOADCATALOG | Catalog Browser (built-in generic parts + user JSON catalog from the project settings) |
| AEWIRENO | WIRENO | Number every wire net by rung reference (100, 100A, ...); fixed numbers (layer WIREFIXED) are kept |
| AEEDITWIRENO, AECOPYWIRENO, AEWIRENOLEADER | EDITWIRENO, ... | Edit a wire number (fixed flag, above / below / in-line, find & replace); copy a number; move it with a leader |
| AETRIMWIRE, AEWIREGAP, AEWIRELOOP | TRIMWIRE, WIREGAP, WIRELOOP | Remove a wire segment between breaks; gap or jump-over loop at crossings |
| AESCOOT, AEALIGN [V/H], AEMULTIBUS | SCOOT, ALIGN, BUS | Slide a component / wire number along its wire; align with a reference; N-wire bus |
| AEXREF | XREF | Coil / contact cross-references ("NO 101, 102 / NC 103" or a small table, sheet-aware format) |
| AECIRCUIT | CIRCUITBUILDER | Circuit Builder: start/stop with seal-in, reversing starter, jog relay circuits placed on the ladder |
| AEPLC | PLC | Parametric PLC I/O module |
| AESOURCE, AEDEST | SOURCE, DEST | Source / destination signal arrows, linked by signal code; XREF shows sheet/rung |
| AESCHEMATICLIST, AEFOOTPRINT, AEBALLOON, AENAMEPLATE | SCHEMATICLIST, ... | Panel layout: footprints from the schematic list (blocks WD_FP_* with P_TAG1 / P_ITEM), balloons, nameplates |
| AETERMSTRIP, AETERMEDIT | TERMSTRIP, TERMEDIT | Panel terminal strip; Terminal Strip Editor (wire numbers / devices left and right) |
| AEDRAWINGPROPS, AEPROJECTPROPS, AETITLEBLOCK | DWGPROPS, PROJPROPS, UPDATETITLEBLOCK | Drawing settings (WD_M block: sheet, tag / wire formats, IEC codes); project description lines and catalog; fill the title block |
| AEREPORT [bom/components/wires/labels/plc/missing/terminals/strip/panel/audit] | REPORT, BOM | Reports: drawing or project-wide, CSV export, "Put on Drawing" table |
| AEAUDIT | AUDIT | Electrical Audit dialog with jump-to-error |
| NEWSHEET | TEMPLATE | New drawing from an ANSI / ISO sheet template with title block |
| OPENPROJECT, PROJECTADD, PROJECTSAVE | PROJECT | Project files (`*.jacproj.json`) listing drawings, description lines and settings |
| NEW, OPEN, SAVE, SAVEAS, PLOT, RECENT | Ctrl+N / O / S / Shift+S | Files: DXF and DWG open, DXF save, PDF plot |

Mouse: wheel zooms at the cursor, middle-drag pans, double middle-click zooms extents.
Click picks; drag left-to-right is a window selection (blue), right-to-left is crossing (green);
Shift-click removes from the selection. Drag a blue grip to stretch; double-click text or a
component to edit it. Object snaps: endpoint, midpoint, center, intersection, perpendicular.

## AutoCAD Electrical-style data model

Every symbol carries the ACADE attribute set: `TAG1`, `DESC1`-`DESC3`, and the invisible `INST`, `LOC`,
`MFG`, `CAT`, `ASSYCODE`, `RATING1`-`2`, `WDTYPE` plus the wire-connection attributes `X1TERMnn` (left),
`X2TERMnn` (top), `X4TERMnn` (right) and `X8TERMnn` (bottom) whose values are the pin numbers. Terminals
add `TERM01` and `TAGSTRIP`. Per-drawing settings live in a `WD_M` insert on layer `WD_M` (tag format
`%F%N` with `%S` sheet / `%D` drawing / `%I` installation / `%L` location codes, reference or
sequential numbering, wire number format and position, cross-reference format, IEC codes), so a saved
DXF carries everything. Contacts are children of their coil (same tag; `AECHILD` copies INST / LOC /
DESC), multi-pole devices carry `POLE`, fixed wire numbers live on layer `WIREFIXED`, panel footprints
are `WD_FP_<family>` blocks with `P_TAG1`, `P_ITEM`, `P_DESC1`-`2`, `P_MFG`, `P_CAT`, `P_INST`, `P_LOC`.

The parts catalog (`src/electrical/catalog.json`) is a generic, invented set of parts per family; a
project can name a user catalog JSON file (array of `{family, mfg, cat, desc, rating, type, assycode}`)
that is searched first.

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
src/app         Editor controller, electrical command registry, coordinate input parsing, settings, project model, demo seed
src/ui          ribbon, command window, status bar, palettes (project manager, properties), dialogs, electrical dialogs, chrome
src/electrical  JIC and IEC symbol libraries, ACADE attributes, WD_M settings, tags, catalog, xref,
                wire tools, panel layout, circuits, audit, reports, sheet templates, dialog contract (ui.ts)
scripts         DWG reader (Node / Electron main), dwg2dxf CLI, screenshot capture
```
