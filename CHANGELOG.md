# Changelog

All notable changes to JCad Electrical are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The entries for 0.1.0 to 0.3.4 were reconstructed from the Git history (commit subjects and
messages). The date of each version is the date of the commit that set that version number in
`package.json`.

## [Unreleased]

### Added

- `LICENSE` with the full text of the GNU General Public License version 3, and
  `"license": "GPL-3.0-only"` in `package.json`.
- `THIRD-PARTY-NOTICES.md` listing every runtime and development dependency with its licence,
  copyright holder and link, the Hershey font notice, the LibreDWG and Electron / Chromium
  notices and the licence texts that must travel with the installers.
- This changelog and a user manual (`docs/USER-MANUAL.md`).
- Help > About shows "Licensed under the GNU GPL v3 · Third-party notices"; both links open
  the files on GitHub through the same allowlisted link handler as the other About links.

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
