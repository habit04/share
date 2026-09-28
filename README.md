# JCad Electrical

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

## Download and run

Ready-made installers are built by the **Build installers** GitHub Actions workflow
(Actions tab, run it or push a `v*` tag): a Windows installer (`.exe`), macOS disk
images (`.dmg`, Apple Silicon and Intel) and Linux `.AppImage` / `.deb` packages appear as workflow artifacts, and
tagged builds are attached to a GitHub Release. The builds are not signed with a vendor certificate, so Windows SmartScreen asks for
confirmation ("More info" then "Run anyway") and macOS asks once under System Settings >
Privacy & Security > "Open Anyway" (macOS builds are ad-hoc signed so they are not reported as damaged).

### Website and browser edition

The public website, <https://habit04.github.io/share/>, is a landing page (download buttons filled
from the latest GitHub Release through the GitHub API, screenshots, first-launch notes, the author
and donation details from `src/app/about.json`) plus a **browser edition** of the application at
`https://habit04.github.io/share/app/`. It is built by `.github/workflows/pages.yml` on pushes to the
branch `claude/autocad-program-feasibility-53w7j7` (paths `site/**`, `src/**`, `scripts/build-site.mjs`,
...) or by running the workflow manually, and deployed with GitHub Pages. The first deployment needs
**Settings > Pages > Build and deployment > Source: GitHub Actions** (the workflow's
`configure-pages` step tries to enable it as well).

```bash
npm run build:site                      # site/ + about.json -> site-dist/, vite build --mode site -> site-dist/app/
node scripts/screenshot-site.mjs        # Playwright: landing page at desktop/phone widths -> screenshots/site-*.png,
                                        # then opens fixtures/example_2000.dwg in the browser edition (site-app-dwg.png)
node scripts/screenshot-site.mjs --images   # also re-captures the landing-page pictures into site/img/
npx serve site-dist                     # or any static server, to look at it locally
```

The browser edition is the same renderer; without Electron the file bridge uses the browser's
file picker and Downloads folder, and **DWG files are parsed in the page** by the LibreDWG
WebAssembly build (`src/io/dwg-browser.ts`, loaded on the first `.dwg`; about 9.5 MB, 2 MB
compressed). Limitations compared with the desktop app: no projects, autosave, recent-file paths
or updates; saves always download a DXF; the user symbol library lives in the browser's
localStorage; the page's Content-Security-Policy allows `'unsafe-eval'` for Emscripten (the
Electron build keeps the strict policy and never loads the wasm, `__JCAD_WEB__` is false there);
the wasm reserves about 1 GB of memory, so phones and 32-bit browsers may refuse to load it.

### Updates

The application checks GitHub Releases for a newer version a few seconds after it starts
and on **Help > Check for Updates…** (command `CHECKUPDATES`, alias `UPDATE`). Help > About
shows the installed version.

- **Windows installer and Linux AppImage** update in place: the new build is downloaded
  (electron-updater reads the `latest*.yml` metadata that electron-builder attaches to each
  release) and installed when the application restarts.
- **macOS and Linux .deb** are told when a newer release exists and offered the matching
  download (in-place replacement on macOS needs a Developer ID signed app, which the ad-hoc
  signed builds are not).

Update metadata is only written when the `publish` block in `package.json` is present;
`release.yml` uploads the `.yml` and `.blockmap` files next to the installers.

### About the author and donations

Help > About shows who made JCad Electrical and a **Donate with Cash App** button; Help >
Donate and the `DONATE` command open the same page. Everything comes from
`src/app/about.json`: fill in `author.name`, `title`, `bio`, `location`, `links` (label + https
URL on github.com or cash.app) and `donate.cashtag` (without the `$`). Leave the cashtag empty
to hide the donate button. Put the same Cash App URL into `.github/FUNDING.yml` to get the
Sponsor button on the repository page.

### Reporting problems

**Help > Report a Problem…** (command `REPORTBUG`) collects a description, the version and
platform, the recent command-line history and any errors the renderer captured, and then
either opens a prefilled GitHub issue (`.github/ISSUE_TEMPLATE/bug_report.yml`), copies the
report to the clipboard, or saves it as a text file (optionally with the current drawing as
DXF) for e-mail. Nothing is sent automatically. The main process appends crashes to
`error.log` in the app data folder. **Help > Send Feedback…** (`FEEDBACK`) opens the feature
request form.

## Run from source

```bash
npm install
npm run electron:dev     # Vite dev server + Electron with live reload
npm start                # production build then Electron
npm run dev              # renderer only, in a browser (http://localhost:5173/?demo)
npm test                 # unit tests (includes DWG fixtures in ./fixtures)
npm run typecheck
npm run build && npm run screenshot   # screenshots/*.png from headless Chromium
node scripts/screenshot-drafting.mjs  # dimensions, linetypes, polyline arcs, arrays
node scripts/screenshot-library.mjs   # every Insert Component category (screenshots/library/)
node scripts/screenshot-symbol-builder.mjs   # Symbol Builder dialog, session + palette, user category
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
| LINE, PLINE [Arc/Close/Halfwidth/Length/Undo/Width], CIRCLE, ARC, RECTANG, TEXT | L, PL, C, A, REC, T | Draw |
| ELLIPSE [Arc/Center], POINT, XLINE [Hor/Ver/Ang/Bisect/Offset], RAY, DONUT, POLYGON [Edge/Inscribed/Circumscribed], MTEXT [Height/Justify/Line spacing/Rotation/Width] | EL, PO, XL, DO, POL, MT | More entities (PDMODE / PDSIZE set the point marker) |
| DIMLINEAR [Horizontal/Vertical/Rotated/Text], DIMALIGNED, DIMRADIUS, DIMDIAMETER, DIMANGULAR, DIMSTYLE [Save/Restore/STatus/Variables/Apply], DIMTXT, DIMASZ, DIMEXO, DIMEXE, DIMGAP, DIMCEN, DIMSCALE, DIMDEC, DIMADEC, DIMLUNIT | DLI, DAL, DRA, DDI, DAN, D | Dimensions (Standard and ISO-25 styles; Enter at the first prompt dimensions a picked object) |
| ERASE, MOVE, COPY, ROTATE, MIRROR, SCALE, TRIM, EXTEND, OFFSET, EXPLODE | E, M, CO, RO, MI, SC, TR, EX, O, X | Modify |
| FILLET [Radius/Trim/Polyline/Multiple], CHAMFER [Distance/Angle/Trim/Multiple], ARRAY / ARRAYRECT / ARRAYPOLAR, STRETCH, BREAK [First point], JOIN, LENGTHEN [DElta/Percent/Total], ALIGN, MATCHPROP, CHPROP | F, CHA, AR, S, BR, J, LEN, AL, MA | More modify commands |
| BLOCK, INSERT [Scale/Rotate, attribute prompts], PURGE [Blocks/LAyers/LTypes/All] | B, I, PU | Blocks |
| DIST [Multiple points], AREA [Object/Add/Subtract], ID, LIST, PROPERTIES | DI, AA, LI, PR | Inquiry, Properties palette |
| UNDO, REDO, ZOOM [All/Center/Extents/Previous/Scale/Window/OBject/In/Out], VIEW [Save/Restore/Delete/Window/?], REGEN, UNITS, LIMITS [ON/OFF], GRIDDISPLAY, GRID, SNAP, ORTHO, POLAR, POLARANG, OSNAP, OSNAPSET (END MID CEN NOD QUA INT INS PER TAN NEA NONE), OTRACK, DYNMODE, LWDISPLAY, CURSORSIZE | U, Z, V, RE, UN, F7, F9, F8, F10, F3, F11, F12, LW | View / settings (persisted) |
| LAYER (dialog) / LAYER or -LAYER [?/Make/Set/New/ON/OFF/Color/Ltype/LWeight/Freeze/Thaw/LOck/Unlock] names, LINETYPE [?/Load/Set], LTSCALE, CELTYPE, LWEIGHT, CELWEIGHT | LA, LT, LTS | Layers, linetypes (Continuous, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, DIVIDE, BORDER and 2x variants), lineweights |
| SELECT [Window/Crossing/Fence/WPolygon/CPolygon/Previous/Last/ALL/Add/Remove/Undo], QSELECT [type layer color], SELECTALL | | Selection sets; ALL / Last / Previous also work at any "Select objects:" prompt |
| AEWIRE | WIRE, W | Orthogonal wire on the current wire type; junction dots at tees |
| AEWIRETYPE | WIRETYPE | Choose the wire layer (gauge / colour) for new wires |
| AELADDER | LADDER | Insert a ladder (width, spacing, rungs, references, 1/3 phase) |
| AECOMPONENT [block] | CMP | Icon menu (JIC or IEC, 450+ symbols in 52 categories with a search box, Horizontal / Vertical orientation); breaks the wire (horizontal or vertical); Insert/Edit Component dialog with INST, LOC, DESC1-3, MFG, CAT, ASSYCODE, RATING, pins, "Used" tag list and Catalog Lookup |
| AEEDITCOMPONENT | AEEDIT | Edit an existing component (retagging a parent carries its contacts along) |
| AECHILD | CHILD | Insert a child contact: pick the parent coil from a list, then the contact (the parent's own `_NO` / `_NC` twin and same-family user contacts first, then the built-in contact), data copied from the parent |
| AECOMPONENT3 [block] | AEC3 | Insert a 3-pole device on a 3-wire bus (poles share the tag, POLE=1..3, TAG1 shown on pole 1 only, pins 1/2 - 3/4 - 5/6 or L1/T1 - L2/T2 - L3/T3 per pole, dashed link) |
| AERETAG [S] | RETAG | Renumber all (or selected) tags in ladder order with the drawing's tag format |
| AETOGGLENC, AESWAP, AEUPDATEBLOCK | TOGGLENC, SWAPBLOCK, UPDATEBLOCK | NO/NC variant in place; swap a symbol keeping its data; refresh block definitions from the library |
| AECATALOG [family], AECATALOGLOAD | CATALOG, LOADCATALOG | Catalog Browser (built-in generic parts + user JSON catalog from the project settings) |
| AESYMBUILDER [name] | SYMBUILDER, SYMBOLBUILDER, SYMEDIT | Symbol Builder: draw or harvest a schematic symbol in its own tab, place TAG1 / DESC1 / pins from the palette and save it to the user library (also New Symbol... / Edit... in the icon menu); AESYMSAVE, AESYMCHECK, AESYMVERTICAL, AESYMTWIN, AESYMTEXT2ATTR, AESYMRENAME, AESYMDELETE, AESYMLIBEXPORT / AESYMLIBIMPORT maintain the library |
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
| OPENPROJECT, PROJECTADD, PROJECTSAVE | PROJECT | Project files (`*.jcadproj.json`) listing drawings, description lines and settings |
| NEW, OPEN, SAVE, SAVEAS, PLOT, RECENT | Ctrl+N / O / S / Shift+S / P | Files: DXF and DWG open, DXF save, PDF plot. NEW / OPEN work in file tabs |
| CLOSE, CLOSEALL, CLOSEALLOTHER, NEXTTAB, PREVTAB | Ctrl+W, Ctrl+Tab | Drawing tabs (several open documents) |
| OPTIONS | OP | Options dialog: Display, Drafting, Selection, Files (autosave), Units — applied live |
| DSETTINGS | DS, SE | Drafting Settings: Snap and Grid, Polar Tracking, Object Snap modes, Dynamic Input |
| LAYISO, LAYUNISO, LAYOFF, LAYON, LAYFRZ, LAYTHW, LAYLCK, LAYULK, LAYMCUR, LAYMCH, LAYCUR, CLAYER | | Layer tools behind the Home > Layers ribbon panel |
| COLOR, LINETYPE, LWEIGHT | CECOLOR, LT, LW | Current colour / linetype / lineweight (Home > Properties panel; colour applies to a selection) |
| QPMODE, TOOLPALETTES, WORKSPACE, ANNOSCALE, CLEANSCREEN, COMMANDLINE | QP, Ctrl+3, Ctrl+0, Ctrl+9 | Quick Properties, Tool Palettes window, workspace switch, annotation scale, clean screen, command window |
| HELP, TEXTSCR | F1, F2 | Searchable command reference + keyboard shortcuts; text window with the history |
| REPORTBUG, FEEDBACK | BUGREPORT, FEATUREREQUEST | Report a problem / send feedback: prefilled GitHub issue, or copy / save a report (version, platform, command history, captured errors, optional DXF) |
| CHECKUPDATES | UPDATE | Check GitHub Releases for a newer version (Help > Check for Updates) |
| COPYCLIP, CUTCLIP, PASTECLIP | Ctrl+C / X / V | In-application object clipboard |
| AUTOSAVE | | Write autosave files now (a timer does this every N minutes; see Options > Files) |

**Command line:** an AutoComplete list opens as you type (prefix and mid-string matches, recently used
first, with the description and aliases); Tab / arrows cycle, Enter or Space accepts. Right-click on the
canvas offers Repeat, Recent Input, Clipboard and Isolate flyouts. The red **J** button opens the
application menu (New / Open / Save / Export / Plot / Recent Documents / Options / Exit).

**Workspace:** file tabs hold several drawings (Ctrl+Tab cycles, middle-click closes, hover shows a
thumbnail); the Project Manager and Properties palettes can be resized by dragging their inner edge
and auto-hidden with the pin in their strip (widths are remembered). The status bar buttons have
settings menus (small arrow / right-click), the coordinate readout cycles absolute / relative / off,
and the customization button shows or hides items. Autosave writes modified drawings to the app data
folder every 10 minutes (Options > Files); the Drawing Recovery Manager offers them at the next start.
A recovered drawing keeps its backup (and keeps refreshing it) until it is saved for real. A save
only clears the "unsaved changes" flag for the exact revision that was written, so edits made
while the save dialog was open stay flagged.

Mouse: wheel zooms at the cursor, middle-drag pans, double middle-click zooms extents.
Click picks; drag left-to-right is a window selection (blue), right-to-left is crossing (green);
Shift-click removes from the selection. Drag a blue grip to stretch; double-click text or a
component to edit it. Object snaps: endpoint, midpoint, center, quadrant, node, intersection,
perpendicular, tangent, nearest, insertion (OSNAPSET); object snap tracking (OTRACK) draws
alignment paths from the last two acquired points, with POLARANG increments when POLARMODE has
bit 2 set. Dashed linetypes scale with LTSCALE and the zoom, like AutoCAD, and turn solid when
the pattern would be finer than a few pixels. Dimension text uses the DIMLUNIT/DIMDEC format and
the `%%c`, `%%d`, `%%p` control codes render as diameter, degree and plus/minus symbols.

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

### Symbol Builder

`AESYMBUILDER` (Schematic > Symbol Builder, or **New Symbol...** in the Insert Component icon menu)
creates symbols that behave exactly like the built-in ones. The start dialog asks for the block
name (spaces become `_`), description, standard (JIC / IEC), category, family (tag prefix), role
(parent coil, child contact NO / NC, device, terminal, PLC point), NO / NC contact and orientation
(horizontal = inline on a rung, vertical = on a vertical wire), and where to start from: a blank
sheet with the role's attribute template already placed (TAG1 + DESC1, or TERM01), a copy of any
library symbol, a **block of the current drawing** (the way to harvest symbols from manufacturer
DWGs: nested blocks are exploded to primitives, ACADE attribute definitions become placeholders,
every attribute default - MFG, CAT, DESC1, TAG1 and unknown vendor attributes - is kept, the base
point can be the wire-stub midpoint or the centre of the geometry ignoring text, the geometry can
be scaled to the 0.75 in inline width with the stub ends snapped onto y = 0 and x = +-0.375; blocks
named like a built-in symbol are offered as `USER_<name>`) or the selected objects (you pick the
base point). Enter submits the dialog. The symbol then opens in its own file tab (`Symbol: NAME`):
geometry on layer `0` in inches around the origin, attribute placeholders as text on layer
`SYMATTR` (the text is the attribute tag), explicit wire-connection pins as text on layer `SYMPIN`
(`X1TERM01`, or `X4TERM02=14` with a default pin number). The **direction of a pin comes from
where its marker sits** (the line end at x = -0.375 is a left pin whatever the text says; the digit
is only used when no geometry is near), so COPY / MIRROR / ROTATE keep the pins right and the marker
labels are renumbered to match the palette and the saved block. Connections are also detected from
the geometry alone (line ends at x = +-0.375, or y = +-0.375 for vertical symbols). Every drafting
command works in that tab; the viewport draws the origin, the 0.75 x 0.75 in box and the stub
guides, and the ribbon switches to Schematic. The symbol's name / family / role / orientation /
defaults live in the document state, so Ctrl+Z undoes them like geometry.

The docked **Symbol Builder** palette (collapsible sections, remembered) edits the name, family,
role, contact and orientation, places, moves or removes attributes (TAG1, DESC1-3, TERM01, INST,
LOC, MFG, CAT, RATING1 ...) with their **default values**, edits the invisible data defaults
(MFG, CAT, RATING1, INST, LOC, ASSYCODE and vendor attributes), converts selected plain text
into an attribute placeholder, lists detected and explicit pins with their default pin numbers,
shows a live preview of exactly what is placed and keeps a **Check** area above the buttons
(name, connections, duplicate or wrong-side pins, markers off a line end, TAG1 over the geometry,
tag-like plain text, layers, standard vs name, child families without a parent, extents; the Check
button carries the error count and Save is disabled while errors exist). **Make vertical** opens
the vertical variant (`HPB11_NO` -> `VPB11_NO`, `USER_PB1` -> `USER_PB1_V`) in a new tab with the
geometry rotated, pins top / bottom and TAG1 / DESC1 to the right of the stub; **NC / NO twin**
opens the sibling with the `_NO` / `_NC` name, pins 13/14 <-> 11/12 and the description reworded
(the blade line of a standard contact is added or removed). **Save to Library** (Ctrl+S) writes
the symbol; saving an existing symbol under a new name asks Rename / Save as copy / Cancel.
**Save and Insert** returns to the drawing and starts `AECOMPONENT NAME`, **Export DXF...**
(also Save As in a symbol tab) writes a DXF whose BLOCKS section holds the symbol plus one insert
at the origin, and **Close** asks to save when changed (a failed save shows the errors). Saving
compiles the tab into a block with the full ACADE attribute set (`withAcadeAttributes`; DESC2 /
DESC3 stay invisible unless placed), registers the family as the block's tag prefix and its
coil / contact role, and redefines the block in open drawings that already use it. Editing a
symbol that is already open switches to its tab instead of opening a second one.

**Vertical symbols.** A symbol whose stubs end on the axis at y = +-0.375 (instead of x = +-0.375)
is a vertical symbol: its connections are detected as top (`X2TERMnn`) / bottom (`X8TERMnn`) pins,
AECOMPONENT snaps it to a vertical wire and breaks that wire around it (junction dots and trim keep
working), and its attribute text may carry a rotation (`AttributeDef.rotation`, ATTDEF group 50 in
DXF / DWG). The icon menu's **Vertical** radio inserts the vertical twin of a horizontal symbol when
the library has one - ACADE naming, `V` + the rest of the name (`HPB11_NO` -> `VPB11_NO`) or
`NAME_V` - and otherwise builds it on the fly (`verticalVariant`: geometry rotated -90 degrees, left
/ right pins become top / bottom, TAG1 and DESC1-3 stay horizontal to the right of the symbol) as a
block of the drawing under the twin's name; the command log says which happened.

The **user library** is one JSON document, `user-library.json` in the application data folder
(`app.getPath('userData')`; localStorage key `jcad.userlib.v1` in the browser), holding
`{ block, standard, category, family, wdtype, created, modified }` per symbol. Its symbols appear
in the icon menu and tool palettes under `User: <category>` after the built-in categories, are
found by the search box and `findLibrarySymbol`, insert with AECOMPONENT / AECHILD / AECOMPONENT3 /
AETOGGLENC / AESWAP like any built-in symbol, and are written into a drawing only when it uses them
(`AEUPDATEBLOCK` refreshes them). `AESYMLIBEXPORT` / `AESYMLIBIMPORT` exchange the library (or one
symbol) as JSON between installations (the browser build downloads the file); the icon menu's
**Edit...** chooser has a filter box and Rename / Delete / Export / Import buttons, and
`AESYMRENAME old new`, `AESYMDELETE`, `AESYMVERTICAL`, `AESYMTWIN`, `AESYMTEXT2ATTR`, `AESYMCHECK`
and `AESYMSAVE` do the same from the command line; right-click a user symbol in the icon menu to
edit or delete it.

## File formats

- **DXF (AC1015 / AutoCAD 2000)** is the native save format: layers (linetype, lineweight,
  frozen/off/locked), blocks, attributes (including invisible ones), LINE / CIRCLE / ARC /
  LWPOLYLINE (bulges and constant width round-trip) / TEXT / MTEXT / INSERT / ELLIPSE / POINT /
  XLINE / RAY / SOLID and DIMENSION (linear, aligned, radius, diameter, angular) written with an
  anonymous `*D` picture block so other CAD programs show them. Mirrored (negative X scale) and
  non-uniform inserts (groups 41/42) round-trip; a mirrored block draws its geometry reflected
  while attribute text stays readable, and MIRROR on a component produces exactly that. Per-entity linetype (code 6),
  lineweight (370) and linetype scale (48), LTYPE dash patterns, the VIEW table, DIMSTYLE and the
  header variables for units, limits, LTSCALE, PDMODE/PDSIZE, CELTYPE/CELWEIGHT and DIM* all round
  trip. Wire junction dots are written as zero-hole donuts so they stay filled in other CAD
  programs. The writer emits the full table set (BLOCK_RECORD, LTYPE, STYLE, APPID, DIMSTYLE,
  VPORT, $HANDSEED, CLASSES, OBJECTS) that AutoCAD expects.
- **DWG** (R14 - 2018) opens through LibreDWG, including dimensions, ellipses, points, MTEXT,
  construction lines, solids, polyline bulges, entity/layer linetypes and lineweights and the
  header units / limits / dimension variables. The import is read-only; SAVE writes a DXF next
  to the original. Sample files from the LibreDWG test suite live in `fixtures/` and are used
  by the tests. Mirrored and stretched block references keep their X/Y scales (circles and
  arcs inside a stretched block become polylines).
- **PDF** plotting renders the extents onto a white sheet.
- **CSV** export for every report.

## Layout of the source

```
src/core        geometry, entity model (with memoised block explosion), document + undo, snapping, selection
src/io          DXF reader / writer, DWG converter (LibreDWG database -> drawing)
src/render      ACI palette, entity drawing, Hershey stroke font, viewport (grid, crosshair, grips, markers)
src/tools       drawing, modify, edit (trim/extend/offset/...), electrical and PLC/arrow/terminal tools
src/app         Editor controller, electrical command registry, coordinate input parsing, settings, sessions,
                autosave, project model, demo seed
src/ui          ribbon, command window (+ autocomplete), status bar, palettes (project manager, properties,
                tool palettes), dialogs (options, drafting settings, help, recovery), electrical dialogs, menus, chrome
src/electrical  symbol libraries (symbols.ts / symbols-jic-control.ts / symbols-power-fluid.ts JIC, one-line,
                PLC and fluid power; iec.ts / iec-extended.ts IEC 60617; library.ts aggregates them with the
                user library userlib.ts; symbol-kit.ts shared primitives; symbol-builder-core.ts symbol <-> block
                conversions), ACADE attributes, WD_M settings, tags, catalog, xref,
                wire tools, panel layout, circuits, audit, reports, sheet templates, dialog contract (ui.ts)
scripts         DWG reader (Node / Electron main), dwg2dxf CLI, screenshot capture
```
