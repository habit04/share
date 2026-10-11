# Changelog

All notable changes to JCad Electrical are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The entries for 0.1.0 to 0.3.4 were reconstructed from the Git history (commit subjects and
messages). The date of each version is the date of the commit that set that version number in
`package.json`.

## [Unreleased]

### Added

- Download alerts: an hourly GitHub Actions workflow (`download-alerts.yml`, `scripts/download-alerts.mjs`)
  compares the release download counters with the last run and comments on the "Download tracker"
  issue when an installer was downloaded, so subscribers get a GitHub notification or e-mail.
- Release gates: `release.yml` runs a `checks` job (workflow validation, lint, all type checks, unit
  tests, build, UI click check, screenshot comparison, Electron end-to-end) on the exact release
  commit; the installers are built from that commit only after it passed, every installer is then
  installed or extracted on its own OS and smoke-tested as a packaged application (`packaged-smoke`
  job, `scripts/packaged-smoke.mjs`: NSIS silent install, `.dmg` via `hdiutil` on macOS for the
  first time, AppImage and `.deb` extraction), and the release is published only when the tag
  still points at the tested commit. The signing steps are unchanged.
- `scripts/e2e-electron.mjs --packaged <executable>` (`npm run e2e:packaged`) runs the end-to-end
  checks against an installed application; new checks for SAVEAS, AUTOSAVE / recovery copies, the
  large-DWG progress dialog and Cancel, and the IPC guard. CI runs the end-to-end test on macOS too.
- Manual workflows: **Packaged smoke test (existing release)** for the installers of a published
  release, and **Screenshot baselines** to regenerate the approved screenshots on the CI browser.
- Approved screenshots: `screenshots/baseline/` with `npm run screenshot:compare` (pixelmatch with a
  per-image tolerance, masks and diff images uploaded by CI) and `npm run screenshot:approve`;
  screenshot pages run with a fixed time zone, locale and calendar date.
- Development setup: Node 22 declared in `package.json` `engines`, `.nvmrc` / `.node-version`, and
  `engine-strict` in `.npmrc`; `docs/DEVELOPMENT.md`.
- Static checks: ESLint flat config with typescript-eslint for `src/`, `tests/`, `electron/`,
  `scripts/` (`npm run lint`), `tsconfig.electron.json` and `tsconfig.scripts.json` (checkJs) with
  `npm run typecheck:all`, and `npm run check:workflows` (js-yaml); all run in CI.
- Performance: `tests/perf-dense.test.ts` (`npm run bench:node`: 50,000-entity drawing with and
  without the spatial index, 20-drawing project reports) and `scripts/bench.mjs` (`npm run bench`:
  rendering, hover and window selection in Chromium); numbers in `docs/PERFORMANCE.md`.
- Documentation: `docs/SUPPORT-MATRIX.md` (what survives DXF / DWG import and export),
  `docs/RELEASE.md` (cutting, verifying and delivering a release; dependency review checklist) and
  `docs/SECURITY-REVIEW.md` (security review of the desktop shell and file readers, with the status
  of each finding).

### Changed

- Hit testing, window / crossing / fence / polygon selection and the object-snap search use a
  spatial index (`src/core/spatial-index.ts`) on drawings of 2,000 entities or more, with exactly
  the same results: picking on a 50,000-entity drawing went from 15-40 ms to under 0.02 ms.
- The Electrical Audit counts wire ends through the same index and computes symbol outlines
  once: the project-wide reports over 20 dense sheets went from about 147 s to 5-10 s, with
  identical output.
- DWG files are parsed in a worker thread in the main process instead of on its event loop; files of
  1 MB or more show a progress dialog with Cancel.
- The plugin loader reports a plugin whose load throws, never settles (30 s) or whose trust prompt
  fails, marks it failed and loads the next one; uncaught errors from a plugin's timers or promises
  are reported with its name. `docs/PLUGIN-API.md` now says plainly that plugins run in the
  application page with its globals, lists their capabilities and the isolation options considered.
- Drawing has a supported undo-history API (`history()`, `restoreHistory()`, `undoLimit`); the
  drawing tabs, the Symbol Builder and tests no longer reach into its private fields.

### Security

- Every IPC handler checks its caller: only the application page in the main window's top frame
  may use the bridge; other senders are refused and logged in `<app data>/ipc-rejections.log`.
- File paths from the renderer go through one policy: open / save / back up by name only for files
  the user chose; `read-image` only for images next to such a file or named by an opened drawing;
  plugin and catalog-pack files must stay inside their folders after symbolic links are resolved.

### Fixed

- Project-wide commands (AEXREFPROJECT, AERETAGPROJECT, AEWIRENOPROJECT, AETITLEBLOCKALL) no
  longer overwrite a drawing whose requested `.bak` copy failed: the drawing is skipped and listed,
  unless you choose **Continue Without Backup** in a dialog that names the file.
- Project-wide commands apply their changes only to the drawing revision they were calculated
  from: a tab edited while the command ran, a closed drawing that changed on disk or was opened in
  a tab meanwhile, or a file saved again in between is reported as a conflict and left alone.
  Switching tabs while closed drawings load no longer mixes up the current drawing.
- The project has its own modified flag (properties, drawing list, catalog file, report templates,
  title block mapping), an autosave with **Project Recovery** at the next start, and
  Save / Don't Save / Cancel before `OPENPROJECT`, the new `NEWPROJECT` and closing.
- Closing the window, quitting and restarting for an update show one **Save Changes** dialog for
  every modified drawing tab, Symbol Builder tab and the project (Save All / Discard All / Cancel,
  per-item choice); items are saved one after another and a failure keeps the window open. The
  main process waits for the answer instead of closing after three seconds, and Save no longer
  saved only the active drawing. A Symbol Builder tab counts as saved once the user library file is
  written, and drawings changed by the saves themselves (a symbol save updates the drawings that
  use it) are asked about again. The drawing and project autosaves being written, and the removal
  of the backups of drawings just saved, finish before the window closes (a few seconds at most).
- File paths are normalised in one place (`src/app/paths.ts`): separators, `.` / `..`, Unicode,
  case-insensitive comparison for Windows paths. Projects, tabs ("is this drawing already open"),
  recent files and the main process's allowed-path list use it, and drawings with the same file
  name in different folders are no longer confused (they show their folder, e.g. `a.dxf (line1)`).
- `PROJECTSAVEAS` (new) into another folder recalculates relative drawing and catalog paths so they
  still point at the same files; `PROJECTSAVE` writes to the project's own file without a dialog.
- A slow open finishes in the tab that started it even if you switch tabs meanwhile (or opens in
  a new tab if that tab was edited); `RECENT` no longer replaced the active drawing when the file
  took a moment to load. Saves to the same file are queued, and an older save never overwrites a
  newer one.
- Saves are crash-safe: drawings (`SAVE`, `SAVEAS`, project-wide updates), projects and other
  exports, plotted PDFs, autosaves, the user symbol library, catalog packs, the recent list and the
  window state are written to a temporary file in the same folder, flushed to disk and renamed over
  the destination (with retries and a copy fallback when Windows briefly locks the file). Saving over
  a drawing or project keeps the previous version as `<name>.bak`. An interrupted save can no longer
  leave a truncated file as the only copy.
- The project-wide `.bak` copy (`backup-file`) goes through the same temporary file + rename and
  reports `{ ok: false, error }` with a clear message when no complete copy could be made, instead
  of failing silently (what happens to that drawing is described above).
- Autosave backups are named after a permanent per-document id instead of the drawing title and
  a session number that restarted every launch, so a new session can no longer overwrite a backup
  that was not recovered yet. `autosave/index.json` keeps the title, path and time of each backup;
  backups from 0.4.0 are migrated on the first start (the project's autosave keeps its own name, so
  Project Recovery finds it after a crash).
- Autosave records exactly the revision it wrote: edits made while a backup is being written are no
  longer treated as backed up. Autosave runs never overlap (a request during a run queues one more),
  and Save, Close and quitting wait for a write in flight. A completed save removes the backup only
  when the drawing was not changed again after that save.
- Switching drawing tabs no longer clears the target drawing's "modified" flag and undo history (the
  file tabs read the session list while the tab was being loaded), which also made a drawing opened
  from the Recovery Manager look saved and could delete its backup.
- Drawing Recovery Manager: Discard All deletes only the backups still listed (never one opened in
  this session), a double click opens a backup only once, and the buttons are disabled while an
  action runs. An unreadable recovery folder shows an error with Retry instead of an empty list.
  `DRAWINGRECOVERY` (`DRM`) opens the manager at any time.
- Save errors explain the cause (disk full, permission or read-only, locked file, folder or network
  drive not available, path too long) for every save: drawings, the project, project-wide updates,
  CSV / report / `.wdt` / symbol library exports, plotted PDFs and the problem report are reported
  on the command line (and in the dialog that started them) instead of being lost as an unhandled
  error. A drawing that cannot be opened because its file or folder is gone is described the same
  way. `SAVE`, `SAVEAS`, `PROJECTSAVE` and `PROJECTSAVEAS` offer Retry, Save As... and Cancel; the
  drawing or project stays modified and its autosave backup is kept when a save fails.
- Opening a DXF or DWG file reports everything it could not bring in unchanged: an Import
  Report (counts per type, the first 50 objects with handle, layer, place and reason, Copy
  Report; `IMPORTREPORT` shows it again) instead of silent loss, also when the drawing finished
  opening in a background tab. Saving over a source file that
  held such content asks first and offers Save As.
- Unknown DXF entities that can be kept safely (3D faces, and 3D solids / regions / bodies with
  inline data) stay in the drawing and are written back verbatim on their layer at the end of
  the entities on save, through undo and through project-wide rewrites.
- Damaged DXF files are rejected with the line and the reason (non-numeric group codes,
  unbalanced SECTION / ENDSEC, content outside sections) instead of opening half-read; a file
  that ends early offers to open what was readable and is marked as recovered. The same applies to
  a backup opened from the Drawing Recovery Manager; project-wide reports read such a closed drawing
  as far as it goes and say so on the command line, and project-wide updates leave it unchanged.
  Objects with NaN / infinite coordinates, negative radii or fewer than two polyline vertices are
  left out and listed instead of becoming geometry at the origin.
- DXF layers with the Default lineweight (370 = -3) read as 0.25 mm instead of a negative width.
- DXF arcs, circles, polylines and block references with extrusion (0,0,-1) (mirrored objects)
  open in their true place instead of mirrored; other non-planar objects are reported.
- DWG import keeps paper-space layouts with their entities and floating viewports, text styles,
  named dimension styles (used by the dimensions that name them), custom linetype patterns,
  true colours of objects and layers, ByBlock colours, the plot flag of layers, and 3D
  polylines (flattened). DWG layers are no longer all imported as locked. What the DWG reader
  cannot see (page setups, per-viewport frozen layers, fixed text heights) is listed in the
  Import Report.
- Block colours: ByBlock (0) is no longer confused with ByLayer (256). ByBlock content takes the
  block reference's colour (or its layer's colour when the reference is ByLayer), nested blocks
  resolve outwards, layer-0 ByLayer content shows the reference layer's colour, explicit colours
  are untouched; the same on screen, in vector PDF plots and with EXPLODE.
- Library symbols stay recolourable from their block reference under that rule: the built-in
  JIC / IEC / vertical libraries and the Symbol Builder draw symbol geometry ByBlock on layer 0
  (it was ByLayer). Symbols saved earlier are converted when a drawing or the user library is
  loaded (the library file is rewritten only with the next change to it); blocks from other
  programs are not touched.
- Undo / Redo no longer revert settings that are documented as not undoable (drawing header
  variables, the current layer, the active layout / viewport and viewport zoom, library blocks);
  the rules per setting are in the user manual.
- `new Drawing({...})` keeps the header, the active space and every other field it is given.
- Clicking where overlapping objects are equally close selects (and highlights) the topmost one
  instead of the one underneath.
- A project file can no longer give the program permission to overwrite files outside its own
  folder: drawings it lists outside the project folder, and its catalog file, can be opened but are
  saved (by `SAVE` or a project-wide command) only after you confirm them in the Save As dialog.
  Saving a drawing writes only `.dxf` files and saving a project only `.json` project files.
- Text from drawing files and plugins is always shown as text: the annotation scale name in the
  status bar and the titles of dialogs (file, layout, symbol and plugin names). An annotation
  scale in a DXF header that is not a plain scale name is ignored.
- Opening a drawing no longer makes the program connect to another computer to load its images:
  images on a network share are loaded only for drawings opened from that same server.
- Links opened in your browser (About, Report a Problem, updates) are checked after the address is
  normalised, so they can only lead to this project's GitHub pages or the donation page.
- "Open with JCad Electrical" and drawings handed to a second launch (or, on macOS, opened from
  the Finder) open in their own tab; they were ignored.
- A file picked in the Open dialog that is already open, or `RECENT` clicked twice while the file
  loads, shows its tab instead of opening a second copy whose saves would overwrite each other. An
  open that lands in a new tab while you work in another tab stays in the background. Files that
  fail to open are no longer added to Recent Documents.
- Closing: after Cancel in the "not responding" question, the Save All dialog the page shows once it
  responds again is honoured; a restart for an update that does not happen no longer leaves the
  window closing without the unsaved-work question; Discard All removes the project autosave (the
  next start no longer offers the discarded changes).
- Project-wide commands: **Continue Without Backup** now writes the drawing when its `.bak` cannot
  be written (a folder or locked file in the way made the write fail again), and a truncated closed
  drawing is listed as damaged ("OPEN it to recover") instead of as a file error. Failed CSV, report
  and `.wdt` exports name the file and folder chosen in the Save dialog.

## [0.4.0] - 2026-09-29

### Added

- `LICENSE` with the full text of the GNU General Public License version 3, and
  `"license": "GPL-3.0-only"` in `package.json`.
- `THIRD-PARTY-NOTICES.md` listing every runtime and development dependency with its licence,
  copyright holder and link, the Hershey font notice, the LibreDWG and Electron / Chromium
  notices and the licence texts that must travel with the installers.
- This changelog and a user manual (`docs/USER-MANUAL.md`).
- Help > About shows "Licensed under the GNU GPL v3 · Third-party notices"; both links open
  the files on GitHub through the same allowlisted link handler as the other About links.
- Drafting entities: `SPLINE` (fit points with start / end tangents and Close, or control
  vertices with a degree), `HATCH` (internal point with boundary detection, selected closed
  objects or a drawn boundary; ANSI31-38, NET, NET3, DOTS, LINE, BRICK and SOLID, scale, angle,
  origin) and `HATCHEDIT`, `LEADER` / `QLEADER` and `MLEADER` (arrowhead, straight or spline
  leader, landing, multi-line text), `TABLE` and `TABLEEDIT`, `FIELD` and `UPDATEFIELD` (Date,
  CreateDate, SaveDate, PlotDate, Filename, Title, Subject, Author, Keywords, Comments,
  LastSavedBy, Login). EXPLODE, LIST, grips, snaps and the Properties palette know the new types.
- IMAGE entities and external references are read and written; the desktop app draws image
  bitmaps (`.png`, `.jpg`, `.gif`, `.bmp`, `.webp` up to 50 MB) through a read-only bridge that
  resolves relative paths against the drawing folder; xrefs draw as a named frame.
- MTEXT format codes are drawn: colours, heights, width factor, oblique, bold / italic,
  underline / overline / strike-through, stacked fractions and tolerances, paragraph alignment.
- Dimension styles: arrowhead types (closed filled, closed blank, closed, open, oblique,
  architectural tick, dot, small dot, blank dot, none; separate first / second arrows), text
  placement (DIMTAD, DIMJUST, DIMTIH / DIMTOH), extension and dimension line suppression,
  DIMDLE, fit options, DIMPOST prefix / suffix, rounding, measurement scale, zero suppression,
  alternate units (after or below the primary value) and symmetrical, deviation, limits and
  basic tolerances; named styles saved in the drawing.
- `DIMSTYLE` opens the Dimension Style Manager (Set Current, New, Modify, Compare, Delete; the
  style editor has Lines, Symbols and Arrows, Text, Fit, Primary Units, Alternate Units and
  Tolerances tabs with a live preview); `-DIMSTYLE` (and DIMSTYLE with an option)
  Save / Restore / STatus / Variables / Apply / ? on the command line. Every DIM* variable of the
  style is a command.
- `DIMBASELINE`, `DIMCONTINUE`, `DIMTEDIT` and `DIMEDIT`, and Annotate > Dimensions ribbon
  buttons for Baseline, Continue, Text Edit, Dim Edit and Dim Style.
- DXF: every named dimension style is written as a DIMSTYLE record and read back (arrowheads,
  basic tolerances and alternate-unit placement in `JCAD_DIMSTYLE` XDATA; arrow blocks of other
  programs' records are resolved from their handles); the current style's `$DIM*` header
  variables include `$DIMBLK`, `$DIMBLK1`, `$DIMBLK2`, `$DIMSAH`, `$DIMTOL`, `$DIMLIM`, `$DIMTIH`,
  `$DIMTOH` and `$DIMZIN`; DIMENSION groups 52 (oblique) and 53 (text rotation) round-trip.
- DWG: the remaining DIM* header variables (arrows, tolerances, alternate units, text placement,
  fit, colours, DIMPOST / DIMAPOST, DIMRND, DIMLFAC, DIMZIN ...) are applied to the current style.
- Project-wide electrical tools: `AEXREFPROJECT`, `AERETAGPROJECT` (all tags or duplicates only),
  `AEWIRENOPROJECT` (sheet-based or per-drawing start numbers). Open drawings change in their
  tabs; closed drawings are listed for confirmation and saved as DXF, optionally with a `.bak`
  copy. A problem list shows contacts without a parent and duplicate parents.
- `AEFIXTAG` and a Fixed tag checkbox in Edit Component (`TAGFIXED`); retagging keeps fixed tags.
- `AELOCVIEW` Location View: components by installation / location over the project with
  jumpers, zoom-to, CSV and Put on Drawing.
- `AEPLCIO` imports PLC I/O from a CSV / TSV spreadsheet (preview, modules, point descriptions,
  optional device rungs) and `AEPLCIOEXPORT` writes the drawing's I/O points back to CSV.
- Cables and jumpers: `AECABLE` (cable tag, type, conductor numbers or colours, `WD_CABLE`
  markers with FROM / TO), `AECABLESCHEDULE` (Cable Schedule report), `AEJUMPER`, `AEJUMPERDEL`.
- Report templates saved in the project file: `AEREPORTTEMPLATES` and `AEREPORTRUN <name>`
  (columns and order, sort, filters, title, drawing or project scope, dialog / table / CSV
  output).
- Title block mapping in the project (`.wdt` format, Project Properties > Title Block Mapping
  tab), `AETITLEBLOCKALL`, `AEWDTIMPORT` and `AEWDTEXPORT`.
- The Project Manager shows installation / location codes and the cross-reference status per
  drawing, and its context menu runs the project-wide commands. Project Properties is tabbed
  (General, Description Lines, Title Block Mapping).
- Panel hardware: `AEDINRAIL` (TS35 / TS32 / TS15), `AEWIREDUCT` (1x1 to 4x4 in with cover lines),
  `AEPANEL` (standard or custom enclosure with mounting plate, hinges and door swing),
  `AEPANELGRID`, `AEFOOTPRINTALIGN`, `AETERMFOOTPRINT` (terminal strip footprint from the terminal
  table) and `AEPANELHW`; a Panel Hardware report (`AEREPORT panelhw`); ribbon panels for the
  project-wide, cable / jumper / PLC I/O and panel layout commands.
- 41 hand-drawn JIC vertical symbols (`VPB11_NO`, `VCR1`, `VTD1_NO`, `VXF1` ...) and 12 IEC
  `NAME_V` symbols, used by the icon menu's Vertical choice.
- Symbol Builder: an insertion prompt, invisible / constant / verify / preset flags, text height
  and justification per attribute, reordering, attribute template buttons and a pre-save
  checklist. Insert Component asks for the other attributes of user symbols in block order.
- DXF: attribute definitions keep the constant, verify and preset flags.
- Metric drawings: the WD_M `UNITS` value (or `$INSUNITS`) makes symbols, junction dots, ladders,
  3-phase inserts, circuits, wire numbers and sheet templates scale by 25.4; `WDUNITS` and a
  Drawing Units page in Drafting Settings switch a drawing, optionally rescaling it
  (`docs/METRIC.md`).
- DXF code pages: files are decoded by byte order mark, `$ACADVER` and `$DWGCODEPAGE` (desktop
  and browser), `\U+` / `\M+` escapes are decoded, and the writer escapes non-ASCII text. STYLE
  records round-trip and TEXT / MTEXT with a TrueType style are drawn in that font.
- High-DPI drawing area: the canvas follows the device pixel ratio and redraws when it changes.
- Localization: interface strings go through a translation table; Options > Display > Language
  (System default, English, partial Spanish).
- Plugins: the `jcad` plugin API (also `window.jcadApi`), plugins loaded from the `plugins`
  folder in the app data folder after a one-time confirmation, `PLUGINS`, `PLUGINLOAD`,
  `PLUGINRELOAD`, `SCRIPTRUN`, `docs/PLUGIN-API.md` and three example plugins in
  `examples/plugins/`.
- LIST shows spline, hatch, leader, table and image properties and the text style of TEXT / MTEXT.
- Paper-space layouts: `Model | Layout1 | +` tabs under the drawing with a right-click menu (New
  Layout, From Template, Delete, Rename, Move or Copy, Page Setup Manager, Plot); `LAYOUT`
  (New / Copy / Delete / Rename / Set / ? / Template), `LAYOUTWIZARD`, `PAGESETUP`, `MODEL`,
  `TILEMODE`, `MSPACE`, `PSPACE`; a Layout panel on the View tab.
- Floating viewports: `MVIEW` (two corners, Fit, ON / OFF, Lock), `MVSETUP`, `VPSCALE`. Double-click
  inside a viewport to work in it and outside to return to the paper; zooming inside an unlocked
  viewport changes its view; viewport frames move, stretch, copy and erase like objects.
- Annotation scale: `CANNOSCALE` (also a status-bar list), `ANNOALLVISIBLE` and `OBJECTSCALE`;
  annotative text, dimensions, leaders and blocks keep their paper height. The status bar's MODEL
  button shows PAPER in a layout and switches between the paper and the current viewport.
- DXF paper space: `*Paper_Space` blocks, VIEWPORT entities, LAYOUT objects in `ACAD_LAYOUT`,
  `$CANNOSCALE` / `$ANNOALLVISIBLE` and `AcadAnnotative` XDATA are written and read; layouts made in
  AutoCAD are imported with their viewports. Non-rectangular viewport clipping is not supported.
- Vector PDF plotting: real paths, text, hatches, images and dashed linetypes, one page per sheet
  (the current tab or all layouts), plot style tables (monochrome, grayscale, colour, screening),
  plotted lineweights, and hidden / frozen / no-plot layers left out. Layers have a no-plot flag
  (DXF group 290).
- CI: a UI click check (every command and clickable control of the built renderer), the
  screenshot scripts as gates and an Electron end-to-end test on Ubuntu and Windows.
- Signing: the Windows build is signed through Azure Artifact Signing and the macOS build with a
  Developer ID and notarized when the corresponding repository secrets exist
  (`docs/CODE-SIGNING.md`).

### Changed

- PLOT and PRINT open the same Plot / Print dialog with two outputs: "Plot to PDF" writes the
  file and "Print…" opens the print dialog where the printer is chosen.
- When the active tab has no visible objects, the Plot / Print dialog explains what to do and
  both buttons are shown disabled; disabled dialog buttons now have a visible disabled style.
- Browser edition: Plot to PDF builds the PDF in the page (the rendered sheet as a single-page
  PDF sized to the chosen paper, lossless with a JPEG fallback) and downloads it, so the
  desktop application is no longer needed to plot.
- Browser edition: PRINT uses a hidden frame instead of a pop-up window, so no pop-up
  permission is needed and the page size matches the sheet.
- PLOT writes a vector PDF by default; the Plot dialog's "PDF output" still offers a raster image.
  In a layout the dialog uses the layout's page setup, and PRINT prints the layout's sheet.
- Radius and diameter dimension text is horizontal unless the style asks for aligned text.
- DIM* variable commands accept BYLAYER / BYBLOCK for the dimension colours.
- The current dimension style read from a DXF is the header variables applied over the named
  style of the same name (not the header variables alone).
- Dimension lines, extension lines and text are drawn in their DIMCLRD / DIMCLRE / DIMCLRT
  colours in the drawing area.
- A cable conductor runs from device to device: FROM / TO are the device pins at the two ends
  of the wire segment (rails show as L1 / L2), not the far ends of the whole net.
- A selected solid hatch is drawn with a lighter fill so its boundary shows.
- When a page's Content-Security-Policy blocks plugin code and no desktop bridge is available,
  the plugin error says so.

### Fixed

- Hatch pattern definition lines stored in a DXF are used as saved (ISO scales, double
  hatches) instead of being replaced by the built-in definition.
- DXF text chunks keep their trailing spaces (a 250-character MTEXT chunk may end in one).
- `$DIMTIH` / `$DIMTOH` in written DXF files match the style instead of always being 1.
- Cable markers are no longer counted as components in reports.
- DXF files opened in the browser edition are decoded by their code page.
- Non-ASCII PDF titles are written as UTF-16, and the landing page's assets are cache-busted.

## [0.3.4] - 2026-09-28

### Added

- `PRINT` command: sends the drawing to a printer through the system print dialog
  (Ctrl+Shift+P, File > Print, application menu Plot > Print, ribbon Project > Print). The
  browser edition opens the sheet and uses the browser's print dialog.
- Plot / Print dialog for PLOT and PRINT: paper size (Letter, Legal, Tabloid 11 x 17, ANSI
  C/D/E, Arch C/D, ISO A4-A0, or a custom sheet fitted to the drawing), orientation
  (automatic, landscape, portrait), scale (fit, 1:1, 1:2, 1:4, 2:1; a scale that does not fit
  is reduced and reported) and margins. The choices are remembered.

### Fixed

- The plotted sheet is rendered at the paper's proportions, named page sizes are passed to
  Electron, and the PDF page size is given in inches (the unit Electron expects) instead of
  microns.
- Browser printing sets the CSS page size to the sheet size.

## [0.3.3] - 2026-09-28

### Added

- DWG import of HATCH entities: each boundary path becomes a closed polyline (solid hatches
  are filled, pattern hatches keep the outline); edge-defined boundaries (lines, arcs,
  ellipses, splines) are sampled.
- DWG import of tables (ACAD_TABLE) through their anonymous block. Tables whose position
  LibreDWG cannot read (2013 and later files) are placed inside the sheet border when they
  fit, otherwise beside the drawing, with a note in the import log.
- The DXF reader maps ACAD_TABLE to an insert of its table block at the insertion point.
- The import log lists notes next to the skipped-entity summary.

### Changed

- Removed decorative controls that did nothing: panel-title arrows without a dialog, the
  Layout1 / Layout2 / + tabs, navigation wheel, orbit, annotation scale picker, dead check
  boxes in Options and Drafting Settings, the icon menu scale field, the layer dialog Plot
  column and Set Current button, the Project Manager gear and the Preview header.
- Wired the remaining controls: dialog launchers, the InfoCenter search icon, Quick Select,
  the Tool Palettes drag grip, the Symbol Builder auto-hide pin, layer dialog Freeze, aperture
  size, hover grip colour and additional polar angles.

### Fixed

- `ALIGN` ran `AEALIGN` because of an alias collision.
- `LINETYPE`, `LWEIGHT` and the linetype, lineweight and colour combos were shadowed by stubs
  that changed nothing; they now drive CELTYPE / CELWEIGHT and a real current colour for new
  objects.
- `PAN` is a tool (drag with the left button); the OTRACK status bar button and F11 / F12 work.
- `CLEARRECENT` (File > Open Recent > Clear Recent) is registered; `HELP shortcuts` opens the
  Keyboard Shortcuts tab.
- Anonymous block names are written with the anonymous flag so AutoCAD accepts the DXF.
- Browser edition: a page loaded before a website update reloads itself once when a code
  chunk is missing, instead of failing to open a DWG file.

## [0.3.2] - 2026-09-28

### Changed

- The decorative "Sign In" button in the title bar is replaced by **Support**, which opens
  Help > About with the author and donation details.

## [0.3.1] - 2026-09-28

### Added

- Help > About shows the author, a short bio, project links and a **Donate with Cash App**
  button; Help > Donate and the `DONATE` command open the same page. All of it is configured
  in `src/app/about.json`.
- Signed **catalog packs**: manufacturer catalogs as one signed `*.jcadpack.json` file per
  buyer (Ed25519 signature checked against the publisher keys built into the app). The
  application shows "Licensed to <buyer>" and the expiry, refuses unsigned, edited or
  unknown-key packs, and still loads expired packs with a warning. New commands `AEPACKS`,
  `AEPACKINSTALL`, `AEPACKLIST`, a Catalog Packs dialog, a Source column and **Packs...**
  button in the Catalog Browser, and a Project > Catalog Packs ribbon button.
- `scripts/pack-sign.mjs` (`keygen`, `csv2catalog`, `sign`, `verify`) and
  `docs/CATALOG-PACKS.md` for publishers.
- Public website (landing page with download buttons filled from the latest GitHub Release)
  and a **browser edition** of the application that opens DWG files in the page with the
  LibreDWG WebAssembly build.

## [0.3.0] - 2026-09-28

### Added

- **Symbol Builder** (`AESYMBUILDER`): draw a symbol in its own file tab, or start from a
  library symbol, a block of the current drawing or selected objects; place attributes and
  pins from a docked palette with a live preview and a Check list; save to a persistent
  **user library** (`user-library.json` in the application data folder, localStorage in the
  browser) whose symbols appear in the icon menu and tool palettes under "User:" categories.
  Library commands `AESYMSAVE`, `AESYMCHECK`, `AESYMVERTICAL`, `AESYMTWIN`, `AESYMTEXT2ATTR`,
  `AESYMRENAME`, `AESYMDELETE`, `AESYMLIBEXPORT`, `AESYMLIBIMPORT`; symbols can also be written
  out as a DXF block file.
- Symbol Builder: pin direction taken from where the marker sits (so COPY / MIRROR / ROTATE
  keep pins right), new checks (duplicate or wrong-side pins, markers off a line end, TAG1 over
  the geometry, tag-like plain text, off-layer geometry, standard / name mismatch, child
  families without a parent), attribute defaults, "Make vertical", NO / NC twins, Rename /
  Save as copy, and undo of the symbol's name, family, role and orientation.
- **Vertical symbols** end to end: top / bottom connections, attribute rotation (ATTDEF / ATTRIB
  group 50 in DXF and DWG), vertical wire breaking and snapping, and the icon menu's Vertical
  option inserts the library's vertical twin or builds one.
- `AECOMPONENT3` hides TAG1 on poles 2 and 3 and numbers the pins per pole.
- **Help > Report a Problem** (`REPORTBUG`): collects a description, version, platform, recent
  command history and captured errors, then opens a prefilled GitHub issue, copies the report
  or saves it as a text file (optionally with the drawing as DXF). `FEEDBACK` opens the feature
  request form. The main process logs crashes to `error.log` in the application data folder.
- Extended symbol libraries: one-line power, PLC module and fluid-power symbols (96), the IEC
  extended set (124) and refined JIC control symbols, for 454 symbols in 52 categories.
- A second launch of the desktop application focuses the running window instead of starting
  another instance.

### Changed

- `AECHILD` offers the parent's own NO / NC twin and the user's contacts of the same family
  first, then the built-in contact.
- Saved and autosaved DXF files keep only the library symbols the drawing uses (and every user
  block); the library is restored when the drawing is opened.
- The update restart goes through the same unsaved-changes prompt as closing the window.
- Browser edition: `AESYMLIBEXPORT` and REPORTBUG's Save Report download the file.

### Fixed

- SAVE only clears the unsaved flag of the revision that was written; edits made while the
  file dialog was open stay flagged.
- A drawing opened from the Drawing Recovery Manager keeps (and refreshes) its backup until it
  is saved, instead of losing it the moment it is opened.
- Mirrored (negative X scale) and non-uniformly scaled inserts are drawn and exported
  correctly; MIRROR on a component reflects its geometry while attribute text stays readable.
- The browser autosave reports failed writes and retries them instead of treating them as
  saved.
- The user symbol library cannot be overwritten after a failed read, keeps entries it cannot
  parse, validates names and geometry, and is written atomically with one backup copy.
- Tag-prefix rules of the extended libraries no longer depend on import order; a stale PURGE
  stub no longer shadows the real command.

## [0.2.0] - 2026-09-28

### Added

- Update check against GitHub Releases a few seconds after start-up, from **Help > Check for
  Updates** and with the `CHECKUPDATES` command. Windows installer and Linux AppImage builds
  download the update and install it on restart; macOS and `.deb` builds are offered the
  matching download. Help > About shows the version and an update button.
- The Insert Component icon menu has a search box across all categories.

### Changed

- All symbol sets are served through one library module used by the editor, tools, palettes,
  dialogs and templates.
- Installer file names contain no spaces, and releases carry the update metadata.

## [0.1.1] - 2026-09-27

### Changed

- macOS builds are ad-hoc signed (so macOS does not report them as damaged) and are built as
  separate Apple Silicon and Intel disk images.

## [0.1.0] - 2026-09-27

First release.

### Added

- Desktop 2D drafting application (Electron + TypeScript) with a ribbon, Project Manager and
  Properties palettes, command window with AutoComplete, status bar toggles, file tabs for
  several open drawings, and a canvas with grid, crosshair, object snaps, object snap
  tracking, polar tracking and grips.
- Drafting commands: LINE, PLINE with arcs and widths, CIRCLE, ARC, RECTANG, TEXT, MTEXT,
  ELLIPSE, POINT, XLINE, RAY, DONUT, POLYGON; linear, aligned, radius, diameter and angular
  dimensions with dimension styles; ERASE, MOVE, COPY, ROTATE, MIRROR, SCALE, TRIM, EXTEND,
  OFFSET, EXPLODE, FILLET, CHAMFER, ARRAY, STRETCH, BREAK, JOIN, LENGTHEN, ALIGN, MATCHPROP,
  CHPROP; BLOCK, INSERT, PURGE; DIST, AREA, ID, LIST; ZOOM, VIEW, UNITS, LIMITS; selection
  modes; layers, linetypes and lineweights.
- Electrical workflow in the style of AutoCAD Electrical: ladders, wires with junction dots,
  JIC and IEC 60617 style symbol libraries, component insertion with tag, location,
  description, manufacturer and catalog data, child contacts, 3-pole devices, retagging,
  wire numbers, coil / contact cross-references, parametric PLC I/O modules, source /
  destination arrows, terminal strips and the Terminal Strip Editor, wire types, panel
  footprints, balloons and nameplates, the Circuit Builder, and wire editing tools (trim,
  gaps, loops, scoot, align, multiple bus).
- Reports (bill of material, components, wire from / to, wire labels, PLC I/O, missing catalog
  data, terminals, terminal strip, panel, electrical audit) with CSV export and tables on the
  drawing; the Electrical Audit dialog.
- Generic parts catalog with a Catalog Browser and user catalog files.
- Sheet templates (ANSI A-D, ISO A3 / A4) with an attributed title block; project files
  (`*.jcadproj.json`) with project properties.
- DWG import (R14 to 2018) through LibreDWG WebAssembly; DXF (AutoCAD 2000) open and save;
  PDF plotting.
- Hershey Roman Simplex stroke font for text.
- Options and Drafting Settings dialogs, Quick Properties, rollover tooltips, Tool Palettes,
  the Help window with a keyboard shortcut list, the text window, the application menu,
  in-application object clipboard.
- Autosave with a Drawing Recovery Manager, remembered window size and position, and a native
  File > Open Recent menu.
- Installers for Windows, macOS and Linux built by GitHub Actions.

### Changed

- Renamed the application to JCad Electrical.

[Unreleased]: https://github.com/habit04/share/compare/v0.3.4...HEAD
[0.3.4]: https://github.com/habit04/share/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/habit04/share/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/habit04/share/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/habit04/share/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/habit04/share/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/habit04/share/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/habit04/share/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/habit04/share/releases/tag/v0.1.0
