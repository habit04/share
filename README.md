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
tagged builds are attached to a GitHub Release. The Windows installer and app are signed through Azure
Artifact Signing (publisher: Justin Rodriguez); older unsigned versions, or a new certificate before it has
built SmartScreen reputation, may still need "More info" then "Run anyway". macOS builds are not signed with an
Apple certificate, so macOS asks once under System Settings > Privacy & Security > "Open Anyway" (they are
ad-hoc signed so they are not reported as damaged). When the repository has the five Apple secrets, the release
workflow signs the macOS build with a Developer ID and notarizes it instead; without them the build
stays ad-hoc signed. [docs/CODE-SIGNING.md](docs/CODE-SIGNING.md) walks through both platforms (accounts,
secrets, costs, verification).

Windows signing switches on only when the repository has all seven secrets `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGNING_ENDPOINT`,
`AZURE_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE` and `AZURE_PUBLISHER_NAME` (`scripts/azure-signing.mjs`
adds `win.azureSignOptions` on the Windows runner, and the workflow then checks every `.exe` is validly
signed). `AZURE_PUBLISHER_NAME` must equal the certificate's subject name exactly, because the updater
rejects an update whose signer differs from it.

The **[user manual](docs/USER-MANUAL.md)** covers installation, a first drawing, the interface and every command; see [CHANGELOG.md](CHANGELOG.md) for what changed in each release.
Further documents: [docs/METRIC.md](docs/METRIC.md) (inch and millimetre drawings),
[docs/PLUGIN-API.md](docs/PLUGIN-API.md) (plugins and scripts), [docs/CATALOG-PACKS.md](docs/CATALOG-PACKS.md)
(signed catalog packs), [docs/CODE-SIGNING.md](docs/CODE-SIGNING.md) (installer signing),
[LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

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
npm run build && npm run ui-check     # every command and clickable control of the built renderer (headless Chromium)
npm run build && npm run e2e          # the Electron app itself (Linux without a display: xvfb-run -a npm run e2e)
```

**CI** (`.github/workflows/ci.yml`) runs three jobs on every push and pull request: `test` (typecheck,
unit tests, renderer build), `ui` (the UI click check - every registered command, ribbon button,
application-menu entry, status-bar control, palette button and context-menu item, failing on page or
console errors and unknown commands - its `--self-test`, and the screenshot scripts as gates through
`e2e/run-screenshots.mjs`) and `e2e-electron` on Ubuntu and Windows (`scripts/e2e-electron.mjs`
drives the real main process, preload bridge and IPC: opening DXF / DWG, recent files, plotting a PDF,
IMAGE bitmaps, offline update checks, the Symbol Builder, About and the close prompt, with the native
dialogs stubbed).

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
| SPLINE [Method/Knots/Degree; start/end Tangency, Close], HATCH [Properties/Select objects/draW boundary/Origin], HATCHEDIT [Disassociate/Style/Properties/Origin] | SPL, H, BH, HE | Splines through fit points or control vertices; hatches by internal point (boundary detection), selected closed objects or a drawn boundary, with the built-in patterns (ANSI31-38, NET, NET3, DOTS, LINE, BRICK; `?` lists them) or SOLID, scale, angle and origin |
| LEADER [Annotation/Format/Undo], QLEADER, MLEADER [leader Landing first/Content first/Options] | LEAD, LE, MLD | Leaders and multileaders: arrowhead, straight or spline leader, landing and multi-line text |
| TABLE [columns, data rows, Style/Width/Height], TABLEEDIT | TB | Tables (title, header and data rows); TABLEEDIT picks a cell and edits its text |
| FIELD [Date/CreateDate/SaveDate/PlotDate/Filename/Title/Subject/Author/Keywords/Comments/LastSavedBy/Login], UPDATEFIELD | | Text with a field (`%<\AcVar Date \f "M/d/yyyy">%` ...), evaluated when shown and written back to DXF as the field code |
| DIMLINEAR [Horizontal/Vertical/Rotated/Text], DIMALIGNED, DIMRADIUS, DIMDIAMETER, DIMANGULAR, DIMTXT, DIMASZ, DIMEXO, DIMEXE, DIMGAP, DIMCEN, DIMSCALE, DIMDEC, DIMADEC, DIMLUNIT | DLI, DAL, DRA, DDI, DAN | Dimensions (Standard and ISO-25 styles; Enter at the first prompt dimensions a picked object) |
| DIMSTYLE (Dimension Style Manager) / -DIMSTYLE [Save/Restore/STatus/Variables/Apply/?], DIMBASELINE [Undo/Select], DIMCONTINUE [Undo/Select], DIMTEDIT [Left/Right/Center/Home/Angle], DIMEDIT [Home/New/Rotate/Oblique] | D, DST, DDIM, DBA, DCO, DIMTED, DED | Named dimension styles (arrowheads, text placement, fit, primary / alternate units, tolerances) with a live preview; baseline and continued dimensions; text and oblique edits. Every DIM* variable (DIMBLK, DIMBLK1/2, DIMSAH, DIMTAD, DIMJUST, DIMTIH/DIMTOH, DIMTOL/DIMLIM/DIMTP/DIMTM, DIMALT..., DIMPOST, DIMCLRD/E/T, DIMZIN ...) is also a command |
| ERASE, MOVE, COPY, ROTATE, MIRROR, SCALE, TRIM, EXTEND, OFFSET, EXPLODE | E, M, CO, RO, MI, SC, TR, EX, O, X | Modify |
| FILLET [Radius/Trim/Polyline/Multiple], CHAMFER [Distance/Angle/Trim/Multiple], ARRAY / ARRAYRECT / ARRAYPOLAR, STRETCH, BREAK [First point], JOIN, LENGTHEN [DElta/Percent/Total], ALIGN, MATCHPROP, CHPROP | F, CHA, AR, S, BR, J, LEN, AL, MA | More modify commands |
| BLOCK, INSERT [Scale/Rotate, attribute prompts], PURGE [Blocks/LAyers/LTypes/All] | B, I, PU | Blocks |
| DIST [Multiple points], AREA [Object/Add/Subtract], ID, LIST, PROPERTIES | DI, AA, LI, PR | Inquiry, Properties palette |
| UNDO, REDO, ZOOM [All/Center/Extents/Previous/Scale/Window/OBject/In/Out], VIEW [Save/Restore/Delete/Window/?], REGEN, UNITS, LIMITS [ON/OFF], GRIDDISPLAY, GRID, SNAP, ORTHO, POLAR, POLARANG, OSNAP, OSNAPSET (END MID CEN NOD QUA INT INS PER TAN NEA NONE), OTRACK, DYNMODE, LWDISPLAY, CURSORSIZE | U, Z, V, RE, UN, F7, F9, F8, F10, F3, F11, F12, LW | View / settings (persisted) |
| LAYER (dialog) / LAYER or -LAYER [?/Make/Set/New/ON/OFF/Color/Ltype/LWeight/Freeze/Thaw/LOck/Unlock] names, LINETYPE [?/Load/Set], LTSCALE, CELTYPE, LWEIGHT, CELWEIGHT | LA, LT | Layers, linetypes (Continuous, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, DIVIDE, BORDER and 2x variants), lineweights |
| SELECT [Window/Crossing/Fence/WPolygon/CPolygon/Previous/Last/ALL/Add/Remove/Undo], QSELECT [type layer color], SELECTALL | | Selection sets; ALL / Last / Previous also work at any "Select objects:" prompt |
| AEWIRE | WIRE, W | Orthogonal wire on the current wire type; junction dots at tees |
| AEWIRETYPE | WIRETYPE | Choose the wire layer (gauge / colour) for new wires |
| AELADDER | LADDER | Insert a ladder (width, spacing, rungs, references, 1/3 phase) |
| AECOMPONENT [block] | CMP | Icon menu (JIC or IEC, 450+ symbols in 52 categories with a search box, Horizontal / Vertical orientation); breaks the wire (horizontal or vertical); Insert/Edit Component dialog with INST, LOC, DESC1-3, MFG, CAT, ASSYCODE, RATING, pins, "Used" tag list and Catalog Lookup |
| AEEDITCOMPONENT | AEEDIT | Edit an existing component (retagging a parent carries its contacts along) |
| AECHILD | CHILD | Insert a child contact: pick the parent coil from a list, then the contact (the parent's own `_NO` / `_NC` twin and same-family user contacts first, then the built-in contact), data copied from the parent |
| AECOMPONENT3 [block] | AEC3 | Insert a 3-pole device on a 3-wire bus (poles share the tag, POLE=1..3, TAG1 shown on pole 1 only, pins 1/2 - 3/4 - 5/6 or L1/T1 - L2/T2 - L3/T3 per pole, dashed link) |
| AERETAG [Selection/Project/project Duplicates] | RETAG | Renumber all (or selected) tags in ladder order with the drawing's tag format; fixed tags are kept |
| AEFIXTAG | FIXTAG | Toggle the fixed-tag flag (`TAGFIXED`) of the selected components (also a checkbox in Edit Component); RETAG leaves fixed tags alone |
| AETOGGLENC, AESWAP, AEUPDATEBLOCK | TOGGLENC, SWAPBLOCK, UPDATEBLOCK | NO/NC variant in place; swap a symbol keeping its data; refresh block definitions from the library |
| AECATALOG [family], AECATALOGLOAD | CATALOG, LOADCATALOG | Catalog Browser (built-in generic parts + user JSON catalog from the project settings + installed catalog packs, with a Source column) |
| AEPACKS, AEPACKINSTALL, AEPACKLIST | PACKS, INSTALLPACK, PACKLIST | Catalog packs: install / remove signed manufacturer catalogs (`*.jcadpack.json`), show who they are licensed to and until when |
| AESYMBUILDER [name] | SYMBUILDER, SYMBOLBUILDER, SYMEDIT | Symbol Builder: draw or harvest a schematic symbol in its own tab, place TAG1 / DESC1 / pins from the palette and save it to the user library (also New Symbol... / Edit... in the icon menu); AESYMSAVE, AESYMCHECK, AESYMVERTICAL, AESYMTWIN, AESYMTEXT2ATTR, AESYMRENAME, AESYMDELETE, AESYMLIBEXPORT / AESYMLIBIMPORT maintain the library |
| AEWIRENO [start / P / PD] | WIRENO | Number every wire net by rung reference (100, 100A, ...); fixed numbers (layer WIREFIXED) are kept; `P` / `PD` number the whole project |
| AEEDITWIRENO, AECOPYWIRENO, AEWIRENOLEADER | EDITWIRENO, ... | Edit a wire number (fixed flag, above / below / in-line, find & replace); copy a number; move it with a leader |
| AETRIMWIRE, AEWIREGAP, AEWIRELOOP | TRIMWIRE, WIREGAP, WIRELOOP | Remove a wire segment between breaks; gap or jump-over loop at crossings |
| AESCOOT, AEALIGN [V/H], AEMULTIBUS | SCOOT, ALIGN, BUS | Slide a component / wire number along its wire; align with a reference; N-wire bus |
| AEXREF [Drawing/Project] | XREF | Coil / contact cross-references ("NO 101, 102 / NC 103" or a small table, sheet-aware format) |
| AEXREFPROJECT, AERETAGPROJECT [All/Duplicates], AEWIRENOPROJECT [Sheet-based/Drawing start] | XREFPROJECT, RETAGPROJECT, WIRENOPROJECT | Project-wide cross-references, retag and wire numbers: open tabs change in memory (one undo step each), closed DXF drawings are listed for confirmation and saved (optionally with a `.bak` copy); problems (contacts without a parent, duplicate parents) open in a list |
| AELOCVIEW | LOCVIEW, LOCATIONVIEW | Location View: components grouped by installation / location over the project, with jumpers, zoom-to, CSV and Put on Drawing |
| AEPLCIO, AEPLCIOEXPORT | PLCIO, PLCIOEXPORT | PLC I/O from a CSV / TSV spreadsheet (Address, Description 1-3, Wire, Device, Module, Type; preview, optional device rungs), and the drawing's I/O points back to CSV |
| AECABLE, AECABLESCHEDULE | CABLE, CABLESCHEDULE | Put picked wires into a cable (cable tag, type, conductor numbers or colours; `WD_CABLE` markers with FROM / TO); Cable Schedule report |
| AEJUMPER, AEJUMPERDEL | JUMPER, JUMPERDEL | Jumper two terminals of a strip (stored in their `JUMPER` attributes) / remove a terminal's jumpers |
| AEREPORTTEMPLATES, AEREPORTRUN [name] | REPORTTEMPLATES, REPORTRUN | Saved report formats in the project file: report, columns and order, sort, filters, title, drawing / project scope, output (dialog, table on the drawing, CSV) |
| AETITLEBLOCKALL, AEWDTIMPORT, AEWDTEXPORT | TITLEBLOCKALL, WDTIMPORT, WDTEXPORT | Title blocks of every project drawing from the project's `.wdt`-style mapping (ATTRIBUTE = SOURCE); import / export the mapping |
| AECIRCUIT | CIRCUITBUILDER | Circuit Builder: start/stop with seal-in, reversing starter, jog relay circuits placed on the ladder |
| AEPLC | PLC | Parametric PLC I/O module |
| AESOURCE, AEDEST | SOURCE, DEST | Source / destination signal arrows, linked by signal code; XREF shows sheet/rung |
| AESCHEMATICLIST, AEFOOTPRINT, AEBALLOON, AENAMEPLATE | SCHEMATICLIST, ... | Panel layout: footprints from the schematic list (blocks WD_FP_* with P_TAG1 / P_ITEM), balloons, nameplates |
| AETERMSTRIP, AETERMEDIT | TERMSTRIP, TERMEDIT | Panel terminal strip; Terminal Strip Editor (wire numbers / devices left and right) |
| AEDINRAIL [Type/Part/Length], AEWIREDUCT [Size/Part/Length], AEPANEL, AEPANELGRID [Spacing/Enclosure] | DINRAIL, WIREDUCT / DUCT, AEENCLOSURE / ENCLOSURE, PLATEGRID | Panel hardware: TS35 / TS32 / TS15 DIN rails, 1x1 ... 4x4 in wire duct, standard or custom enclosures with mounting plate and door swing, plate layout grid |
| AEFOOTPRINTALIGN [Even], AETERMFOOTPRINT, AEPANELHW | FOOTPRINTALIGN, TERMFOOTPRINT, PANELHARDWARE | Footprints onto a DIN rail with a gap or spread evenly; terminal strip footprint numbered from the terminal table (jumper bars included); hardware list with total lengths |
| AEDRAWINGPROPS, AEPROJECTPROPS, AETITLEBLOCK [All drawings] | DWGPROPS, PROJPROPS, UPDATETITLEBLOCK | Drawing settings (WD_M block: sheet, tag / wire formats, IEC codes); project properties (General, Description Lines, Title Block Mapping tabs); fill the title block |
| WDUNITS [IN/MM] [RESCALE/KEEP] | AEUNITS, DRAWINGUNITS | Inch or millimetre electrical drawing (symbols, dots, ladders and wire numbers scale by 25.4); see [docs/METRIC.md](docs/METRIC.md) |
| AEREPORT [bom/components/wires/labels/plc/missing/terminals/strip/cables/panel/panelhw/audit] | REPORT, BOM | Reports: drawing or project-wide, CSV export, "Put on Drawing" table (panelhw = Panel Hardware) |
| AEAUDIT | AUDIT | Electrical Audit dialog with jump-to-error |
| NEWSHEET | TEMPLATE | New drawing from an ANSI / ISO sheet template with title block |
| OPENPROJECT, PROJECTADD, PROJECTSAVE | PROJECT | Project files (`*.jcadproj.json`) listing drawings, description lines and settings |
| NEW, OPEN, SAVE, SAVEAS, PLOT, PRINT, RECENT | Ctrl+N / O / S / Shift+S / P / Shift+P | Files: DXF and DWG open, DXF save, PDF plot, print through the system dialog (the browser edition builds the PDF in the page and prints through the browser's dialog). NEW / OPEN work in file tabs |
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
| PLUGINS [Unload/Forget], PLUGINLOAD [folder], PLUGINRELOAD [name], SCRIPTRUN | PLUGINLIST, LOADPLUGIN, JSRUN / RUNSCRIPT | JavaScript plugins from the app data `plugins` folder and one-off scripts against the plugin API; see [docs/PLUGIN-API.md](docs/PLUGIN-API.md) |

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

**Text, display and language:** TEXT and MTEXT whose text style names a TrueType / OpenType font
(`.ttf`, `.ttc`, `.otf`) are drawn with that font through the system font stack; SHX styles keep the
stroke font. MTEXT format codes are drawn: colour (`\C`, `\c`), height (`\H`), width factor (`\W`),
oblique (`\Q`), bold / italic (`\f...|b1|i1`), underline / overline / strike-through (`\L \O \K`),
stacked fractions and tolerances (`\S1/2;`, `\S+0.1^-0.2;`), paragraph alignment (`\pqc;`),
`\P` breaks and `\U+XXXX` characters. The canvas follows the screen's device pixel ratio (and
redraws when a window moves to another monitor), so lines and text stay sharp on high-DPI displays.
**Options > Display > Language** switches the interface language ("System default" follows the operating system;
English and a partial Spanish translation ship today); `src/app/i18n.ts` explains how to add a
language.

**Plugins and scripts:** JavaScript plugins (a folder with `plugin.json` and one main file in the
`plugins` folder of the application data folder; `PLUGINS` prints the path) add commands and react to
events through the `jcad` API, the same object the developer console has as `window.jcadApi`.
`SCRIPTRUN` runs a one-off `.js` file against it. A plugin asks once before it first runs, its errors
are caught and printed on the command line, and every change it makes is an undo step. The reference
is [docs/PLUGIN-API.md](docs/PLUGIN-API.md); `examples/plugins/` holds `hello`, `numbered-labels` and
`bom-summary`.

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

Further data this release uses: a component whose tag must survive a retag has `TAGFIXED` = 1
(`AEFIXTAG`, or Fixed tag in Edit Component). A conductor of a cable carries a `WD_CABLE` marker on
layer `CABLES` with `CABLENO`, `CONDUCTOR`, `CABLETYPE`, `WIRENO` and `FROM` / `TO`
(device tag:terminal); cable markers are not components. Terminal jumpers are ids in the `JUMPER`
attribute of both terminals. Panel hardware is inserted as `WD_PNL_*` blocks with the invisible
attributes `P_HW` (DINRAIL, DUCT, ENCLOSURE, PLATE), `P_TYPE` (rail type, duct or enclosure size),
`P_LENGTH`, `P_MFG` / `P_CAT` and `P_DESC1`, which the Panel Hardware report (`AEREPORT panelhw`) and
`AEPANELHW` total; the terminal strip footprint is a `WD_FP_TSTRIP_*` footprint with an item number.
The WD_M block's `UNITS` value (`INCHES` / `MM`, falling back to `$INSUNITS`) makes a drawing metric:
everything the electrical tools create from the inch library is scaled by 25.4
([docs/METRIC.md](docs/METRIC.md)). Attribute definitions keep AutoCAD's invisible / constant / verify
/ preset flags (ATTDEF group 70; constant attributes get no ATTRIB on inserts).

**Project-wide tools.** The project file (`*.jcadproj.json`) also keeps the report templates and the
title block mapping (the `.wdt` text format: `ATTRIBUTE = SOURCE` lines with the sources `LINE1`..,
`PROJ`, `PROJDESC`, `DWGDESC`, `DWGNO`, `SHEET`, `SHEETMAX`, `DATE`, `REV`, `SEC`, `FILENAME`,
`IEC_PROJ` / `IEC_INST` / `IEC_LOC`, `A|B` for the first non-empty value, `%SHEET% OF %SHEETMAX%`
templates and `"literal"` text). Project-wide commands work on every drawing of the project: the
active drawing and other open tabs change in memory (Undo works, SAVE writes them); closed drawings
are read from disk, listed in a confirmation dialog and written back as DXF (with an optional `.bak`
copy) only when confirmed. DWG drawings are read-only and skipped; the browser edition only updates
drawings that are open in tabs. The Project Manager shows each drawing's installation / location codes
and cross-reference status, and its context menu offers the project-wide commands.

**Vertical symbols.** Besides the generated vertical twins, the library has 41 hand-drawn JIC
vertical symbols (`VPB11_NO`, `VCR1`, `VTD1_NO`, `VXF1` ...) and 12 IEC `NAME_V` symbols that connect
at y = +-0.375, with TAG1 / DESC1-3 to the right; the icon menu's Vertical choice uses them when they
exist.

The parts catalog (`src/electrical/catalog.json`) is a generic, invented set of parts per family; a
project can name a user catalog JSON file (array of `{family, mfg, cat, desc, rating, type, assycode}`)
that is searched first.

### Catalog packs

The application is free (GPL); real manufacturer catalogs are sold separately as **catalog packs**:
one signed `*.jcadpack.json` file per buyer holding `{format: "jcad-pack/1", id, name, publisher,
version, kind: "catalog", license: {licensee, issued, expires, seats}, catalog: [...], signature}`.
The publisher signs the canonical JSON of the document (Ed25519) and the app carries the matching
public key(s) in `src/electrical/pack-keys.json`; **Catalog Browser > Packs...** (`AEPACKS`) installs a
file after verifying it, shows "Licensed to <buyer>" and the expiry, and refuses unsigned, edited or
unknown-key packs. An expired pack keeps working (the buyer keeps the data they paid for) but is
flagged. Installed packs live in `userData/packs/` (browser: localStorage `jcad.packs.v1`) and are
verified again on every start; their parts are searched after the user catalog and before the
built-in one, and the browser's Source column names the pack. `scripts/pack-sign.mjs` (`keygen`,
`csv2catalog`, `sign`, `verify`) is the publisher's tool; `docs/CATALOG-PACKS.md` walks through the
whole flow and is frank about what a signature check can and cannot do in a GPL program. The key in
`pack-keys.json` is a sample: replace it with your own before selling anything.

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

Each placed attribute also has an insertion **prompt**, **invisible / constant / verify / preset**
flags, a text height and a justification, and the rows can be moved up and down: the block keeps
that order and the insert dialog asks in it (Insert Component shows the prompts of user symbols that
the standard fields do not cover as **Other attributes**; a verify attribute is confirmed on the first
OK). **Templates** buttons add the missing TAG1 + DESC1-3, INST / LOC, MFG / CAT / ASSYCODE (invisible),
TERM01 / TERM02, XREF or RATING1-12 (invisible) in one step. A **checklist** (valid unused name,
connection points, no overlapping pins, known family, DESC1, consistent attribute flags ...) sits above
the buttons; saving with unticked warnings asks for confirmation first.

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
  Also read and written: SPLINE (fit points or control vertices), HATCH (boundary loops, pattern
  definition lines - the lines stored in the file win, so ISO and double hatches draw as saved -
  solid fill), LEADER and MULTILEADER, tables (an ACAD_TABLE with cell data reads as a native table; a table
  is written as an insert of an anonymous block that carries the cells in `JCAD_TABLE` XDATA, so other
  programs show it and JCad reads it back as a table), IMAGE with IMAGEDEF (the desktop app loads `.png` / `.jpg` / `.gif` / `.bmp` /
  `.webp` bitmaps up to 50 MB through a read-only bridge, resolving relative paths against the drawing
  folder; the browser edition draws the frame and file name), external references (xref blocks are
  kept as references and drawn as a named frame), MTEXT format codes (kept verbatim while the text is
  unchanged) and fields in TEXT / MTEXT (evaluated on open, written back as field codes).
  **Dimension styles:** every named style is a DIMSTYLE record (all DIM* group codes; arrowheads,
  basic tolerances and alternate-unit placement in `JCAD_DIMSTYLE` XDATA on the record; records from
  other programs name their arrow blocks by handle, which is resolved), the current style's `$DIM*`
  header variables include `$DIMBLK` / `$DIMBLK1` / `$DIMBLK2`, `$DIMSAH`, `$DIMTOL`, `$DIMLIM`,
  `$DIMTIH`, `$DIMTOH` and `$DIMZIN`, and DIMENSION groups 52 / 53 carry DIMEDIT oblique angles and
  DIMTEDIT text rotation. DIMCLRD / DIMCLRE / DIMCLRT colour the dimension parts on screen.
  **Encodings:** files before AutoCAD 2007 are decoded in their `$DWGCODEPAGE` code page (UTF-8 for
  AC1021 and later, byte order marks honoured), `\U+XXXX` / `\M+nXXXX` escapes are decoded, and the
  writer produces pure-ASCII AC1015 with `\U+XXXX` escapes so non-English text survives any code page;
  the detected encoding is logged on open. STYLE table records (font file, TrueType family) round-trip
  and TEXT / MTEXT keep their style name.
- **DWG** (R14 - 2018) opens through LibreDWG, including dimensions, ellipses, points, MTEXT,
  construction lines, solids, polyline bulges, entity/layer linetypes and lineweights and the
  header units / limits / dimension variables (arrows, tolerances, alternate units, text placement,
  fit, colours, DIMPOST / DIMAPOST, DIMRND, DIMLFAC, DIMZIN ...), splines, hatches, leaders,
  multileaders, tables and images. The import is read-only; SAVE writes a DXF next
  to the original. Sample files from the LibreDWG test suite live in `fixtures/` and are used
  by the tests. Mirrored and stretched block references keep their X/Y scales (circles and
  arcs inside a stretched block become polylines).
- **PDF** plotting and **printing** render the extents onto a chosen paper (Letter, Legal,
  Tabloid 11 x 17, ANSI C/D/E, Arch C/D, ISO A4-A0, or a custom sheet fitted to the drawing)
  with automatic or forced orientation, fit-to-paper or a fixed scale (1:1, 1:2, 1:4, 2:1)
  and margins; the choices are remembered. Output is a raster image of the drawing (black
  lines, hidden layers left out), which any printer or plotter accepts.
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
scripts         DWG reader (Node / Electron main), dwg2dxf CLI, screenshot capture, UI click check, Electron e2e
examples        example plugins (hello, numbered-labels, bom-summary)
docs            user manual, metric drawings, plugin API, catalog packs, code signing
```

Newer modules worth knowing: `src/core/dimension.ts` (dimension styles and DIM* variables),
`hatch.ts`, `spline.ts`, `table.ts`, `fields.ts`, `mtext.ts`; `src/io/encoding.ts` (code pages, text
styles); `src/app/api.ts` and `plugins.ts` (plugin API and loader), `i18n.ts` with `locales/`;
`src/electrical/project-tools.ts`, `cables.ts`, `plc-import.ts`, `report-templates.ts`,
`titleblock-map.ts` and `panel-hardware.ts`; `src/tools/dimension.ts`, `panel.ts`,
`drafting-annot.ts`; `src/ui/dimstyle.ts`.

## License

JCad Electrical is free software: you can redistribute it and/or modify it under the terms of
the **GNU General Public License, version 3** (`GPL-3.0-only`) as published by the Free
Software Foundation. It is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR
PURPOSE. See [LICENSE](LICENSE) for the full text.

The installers include Electron (MIT, with Chromium and its components) and the LibreDWG
WebAssembly build (GPL-3.0); text is drawn with the public-domain Hershey fonts. The licences,
copyright holders and required notices of every dependency are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Help > About links to both files.

JCad Electrical is an independent project and is not affiliated with or endorsed by Autodesk;
"AutoCAD" is mentioned only as a compatibility reference.
