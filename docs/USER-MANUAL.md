# JCad Electrical user manual

JCad Electrical is a free 2D drafting program for electrical control schematics and panel
layouts. It runs on Windows, macOS and Linux, and as a browser edition on the project
website. Its workspace and commands follow the conventions AutoCAD Electrical users know
(command line, ribbon, ladders, tags, wire numbers, cross-references, reports), and it opens
the DWG and DXF drawings you already have.

JCad Electrical is an independent, open-source project (GNU GPL v3). It is not affiliated
with Autodesk; "AutoCAD" is mentioned only to describe compatibility.

Contents

1. [Installation](#1-installation)
2. [Your first drawing](#2-your-first-drawing)
3. [The interface](#3-the-interface)
4. [Entering commands and points](#4-entering-commands-and-points)
5. [Drafting commands](#5-drafting-commands)
6. [Electrical workflow](#6-electrical-workflow)
7. [Symbol Builder and the user library](#7-symbol-builder-and-the-user-library)
8. [Catalogs and catalog packs](#8-catalogs-and-catalog-packs)
9. [Plotting and printing](#9-plotting-and-printing)
10. [Settings](#10-settings)
11. [Files: DXF, DWG, projects, autosave](#11-files-dxf-dwg-projects-autosave)
12. [Updates](#12-updates)
13. [Reporting problems and getting help](#13-reporting-problems-and-getting-help)
14. [Keyboard shortcuts](#14-keyboard-shortcuts)
15. [Plugins and scripts](#15-plugins-and-scripts)

---

## 1. Installation

Download the installer for your system from the project's
[GitHub Releases page](https://github.com/habit04/share/releases) or from the download
buttons on the website (<https://habit04.github.io/share/>). The file names look like
`jcad-electrical-<version>-<os>-<arch>.<ext>`.

The installers are not signed with a paid vendor certificate, so each operating system asks
you once to confirm that you trust the download.

### Windows

1. Download the `.exe` installer.
2. Run it. If Windows SmartScreen shows "Windows protected your PC", click
   **More info**, then **Run anyway**.
3. Follow the installer. JCad Electrical appears in the Start menu.

The Windows installer version updates itself (see [Updates](#12-updates)).

### macOS

There are two disk images: `arm64` for Apple Silicon (M1 and later) and `x64` for Intel Macs.
Choose the one that matches your Mac (Apple menu > About This Mac).

1. Open the `.dmg` and drag **JCad Electrical** into Applications.
2. Start it from Applications. The first time, macOS says it cannot verify the developer.
   Click **Done** (or **Cancel**).
3. Open **System Settings > Privacy & Security**, scroll down to the message about
   JCad Electrical and click **Open Anyway**, then confirm with your password.
4. From now on the app starts normally.

The macOS builds are ad-hoc signed so macOS does not report them as "damaged"; they are not
notarized, which is why step 3 is needed once.

### Linux

Two packages are offered:

- **AppImage** (runs on most distributions, updates itself):

  ```bash
  chmod +x jcad-electrical-*.AppImage
  ./jcad-electrical-*.AppImage
  ```

  You can also mark the file as executable in your file manager (Properties > Permissions >
  "Allow executing file as program") and double-click it. Some distributions need the FUSE 2
  library for AppImages (for example the `libfuse2` package on Ubuntu).

- **.deb** (Debian, Ubuntu and derivatives):

  ```bash
  sudo apt install ./jcad-electrical-*.deb
  ```

### Browser edition

The website also hosts the application itself (`https://habit04.github.io/share/app/`). It
is the same program running in the browser, with these differences:

- no projects, no autosave, no recent-file paths and no updates;
- saving always downloads a DXF file to your Downloads folder;
- the user symbol library and installed catalog packs are stored in the browser;
- DWG files are read in the page by a WebAssembly build of LibreDWG (about 9.5 MB, loaded the
  first time you open a DWG file). It reserves about 1 GB of memory, so phones and 32-bit
  browsers may refuse to load it;
- **Plot to PDF** builds the PDF in the page and downloads it; **Print** uses the
  browser's print dialog.

---

## 2. Your first drawing

This walkthrough draws a small motor start/stop circuit. Type the commands shown in
`CAPITALS` in the command line at the bottom of the window and press Enter, or click the
matching ribbon button.

1. **Start a sheet.** Run `NEWSHEET` (ribbon **Project > New Drawing**, or File > New from
   Sheet Template). Pick a sheet size (ANSI A, B, C, D or ISO A4, A3), fill in the title block
   fields and click OK. A new file tab opens with the border and title block.
2. **Insert a ladder.** Run `AELADDER` (ribbon **Schematic > Ladder**). In the Insert Ladder
   dialog keep the defaults (width 9, spacing 1, 10 rungs, first reference 100) or change
   them, click OK and pick the top-left corner of the ladder inside the border.
3. **Insert components.** Run `AECOMPONENT` (ribbon **Schematic > Icon Menu**). The icon menu
   shows the symbol categories on the left and previews on the right; use the search box to
   find a symbol quickly. Pick a normally closed push button, then click on the first rung.
   The component breaks the rung wire around itself and the **Insert / Edit Component** dialog
   opens: the tag (for example `PB101`) is proposed from the rung reference; type a
   description, optionally a manufacturer and catalog number (or use **Catalog Lookup...**),
   and click OK.
4. Repeat for a normally open push button, a coil (`CR` relay coil or a motor starter coil)
   and a pilot light on the same or following rungs.
5. **Add a child contact.** Run `AECHILD` (ribbon **Schematic > Child Contact**). Choose the
   coil you placed from the list, choose the contact (the coil's own NO / NC contact is
   offered first) and click on a rung. The contact gets the coil's tag and data.
6. **Draw wires.** Run `AEWIRE` (ribbon **Schematic > Wire**, alias `W`) and click from point to
   point; wires are always orthogonal and junction dots appear at tees. Press Enter or Esc to
   finish. Ctrl+Z inside the command undoes only the last segment.
7. **Number the wires.** Run `AEWIRENO` (ribbon **Schematic > Wire Numbers**). Every wire net
   gets a number based on its rung reference (`100`, `100A`, ...).
8. **Cross-reference.** Run `AEXREF`. Each coil shows where its contacts are, and each
   contact shows the rung of its coil.
9. **Check it.** Run `AEAUDIT` for the Electrical Audit; double-check any warnings with
   **Go To**.
10. **Save.** Press Ctrl+S. Drawings are saved as DXF (AutoCAD 2000 format).
11. **Plot.** Press Ctrl+P, choose a paper size and click **Plot to PDF**.

Tip: add `?demo` to the address of the browser edition to load a sample motor-control ladder.

---

## 3. The interface

```
+---------------------------------------------------------------------------+
| [J] quick access toolbar      file tabs                 search  Support  ? |
| Home | Annotate | Project | Schematic | Panel | Reports | ... | View       |  <- ribbon tabs
| [ribbon panels with buttons]                                              |
+-----------+-------------------------------------------------+-------------+
| Project   |                                                 | Properties  |
| Manager   |          drawing area (model space)             |  palette    |
|           |                                                 |             |
+-----------+-------------------------------------------------+-------------+
| command history / command line                                            |
| status bar: coordinates  MODEL  GRID SNAP ORTHO POLAR OSNAP OTRACK ...    |
+---------------------------------------------------------------------------+
```

### Application menu and title bar

- The red **J** button opens the application menu: New (Drawing, Drawing from Sheet
  Template), Open (Drawing, Project), Save, Save As, Export (DXF, PDF, Bill of Material CSV,
  Wire From/To CSV), Plot (Plot to PDF, Print), Drawing Utilities (Drawing Properties, Units,
  Audit report, Purge), Close (Current Drawing, All Drawings), Recent Documents, Options and
  Exit.
- The **file tabs** hold every open drawing. Click a tab to switch, middle-click to close,
  hover to see a thumbnail, right-click for the tab menu. Ctrl+Tab / Ctrl+Shift+Tab cycle
  through them.
- The search box ("Type a keyword or phrase") searches the command reference in Help.
- **Support** opens Help > About (author, donation link, version, licence); the **?** button
  opens Help.

The desktop application also has a native menu bar: File, Edit, View, Schematic, Window and
Help.

### Ribbon

| Tab | What is on it |
| --- | --- |
| Home | Draw (including Spline and Hatch), Modify, Layers (layer drop-down with on / freeze / lock / colour, layer tools), Properties (colour, linetype, lineweight), View, Utilities, Draw More, Modify More, Block |
| Annotate | Text (MTEXT, TEXT, Multileader, Leader, Table, Edit Cell, Field, Update Fields), Dimensions (linear, aligned, angular, radius, diameter, Baseline, Continue, Text Edit, Dim Edit, Dim Style), Markup (distance, area, list, hatch, edit hatch) |
| Project | Project Manager, New Drawing, Open Project, Open, Save, Save As, Drawing Properties, Plot to PDF, Print, Add to Project, Save Project, Wire Numbers, Title Block, Project Properties, Load Catalog, Catalog Packs, Retag; Project-Wide (Location View, Xref Project, Retag Project, Wire Nos Project, Report Templates, Title Blocks All) |
| Schematic | Insert Wires / Wire Numbers, Insert Components (icon menu and one-click common symbols), Child Contact, 3 Phase, Catalog Browser, Circuit Builder, Symbol Builder, Edit Components, Edit Wires / Wire Numbers, Cables / Jumpers / PLC I/O (Cable Marker, Cable Schedule, Jumper, Delete Jumper, PLC I/O Import / Export), Other Tools (cross-reference, PLC module, source / destination arrows, audit) |
| Panel | Schematic List, Footprint, Balloon, Nameplate, Terminal Strip, Terminal Strip Editor, Panel Layout (Enclosure, DIN Rail, Wire Duct, Plate Grid, Align Footprints, Terminal Strip FP, Panel Hardware), panel reports |
| Reports | Bill of Material, Component Report, Wire From/To, Wire Labels, PLC I/O Address, Missing Catalog, Terminal Report, Terminal Strip, Panel Components, Panel Hardware, Electrical Audit, Audit Report |
| Import/Export Data | Open DXF / DWG, save as DXF |
| Conversion Tools | Explode, Line to Wire |
| Add-ins | Command List (Help), Report Problem |
| View | Pan, zoom buttons, palettes (Project Manager, Properties, Layers), named views, units, limits, regen |

Hover a button to see its tooltip; every button runs a command you can also type.

### Command line

The command window at the bottom shows the command history and the current prompt. Typing
anywhere on the drawing sends the keys to the command line. See
[Entering commands and points](#4-entering-commands-and-points). Ctrl+9 hides or shows it;
F2 opens the text window with the full history.

### Palettes

- **Project Manager** (left, `TOGGLEPM`): the open project and its drawings, with buttons
  for a new drawing from a template, open project, add the current drawing, save project,
  reports and project properties.
- **Properties** (right, `PROPERTIES`, Ctrl+1): the properties of the selected objects
  (layer, colour, linetype, lineweight and geometry) — edit a value to change all selected
  objects.
- **Quick Properties** (`QPMODE`, the QP status bar button): a small floating panel next to the
  selection with the layer, colour and key geometry.
- **Tool Palettes** (`TOOLPALETTES`, Ctrl+3): the symbol library as tiles by category with a
  search box; click a tile to insert it.
- **Layer Properties Manager** (`LAYER`): the layer list with on / off, freeze, lock,
  colour, linetype and lineweight.

The Project Manager and Properties palettes can be resized by dragging their inner edge and
auto-hidden with the pin button; the widths are remembered.

### Status bar

From left to right: the cursor coordinates (click to cycle absolute / relative / off),
**MODEL**, and toggle buttons for **Grid** (F7), **Snap** (F9), **Ortho** (F8), **Polar**
(F10), **Object snap** (F3), **Object snap tracking** (F11), **Dynamic input** (F12),
**Lineweight** display and **Quick Properties**. Right-click a button (or click its small
arrow) for its settings: Snap Settings, Grid Settings (grid style dots / lines), Tracking
Settings, Object Snap Settings, Dynamic Input Settings. Further items: the workspace switcher
(Drafting & Annotation / Electrical & 2D Drafting), Units, Isolate / Hide Objects and End Object
Isolation, clean screen (Ctrl+0), and the customization menu to show or hide status bar items.

### Mouse

| Action | Result |
| --- | --- |
| Wheel | Zoom at the cursor |
| Middle-button drag | Pan |
| Double middle-click | Zoom extents |
| Click | Pick an object |
| Drag left to right | Window selection (objects fully inside) |
| Drag right to left | Crossing selection (objects inside or touching) |
| Shift+click | Remove from the selection |
| Drag a blue grip | Stretch the object at that point |
| Double-click text or a component | Edit it |
| Right-click | Context menu: Repeat, Recent Input, Clipboard, Isolate and more |

---

## 4. Entering commands and points

- Type a command name or alias (for example `L` for LINE) and press **Enter** or **Space**.
  An AutoComplete list appears as you type, with matching commands (recently used first),
  their descriptions and aliases; **Tab** or the arrow keys move through it, Enter or Space
  accepts.
- With the list closed, **Up / Down** recall previously typed input.
- **Enter** or **Space** on an empty command line repeats the last command, with its
  arguments.
- **Esc** cancels the current command and clears the selection.
- Options appear in `[brackets]` in the prompt, for example
  `Specify next point or [Arc/Close/Halfwidth/Length/Undo/Width]:`. Type the capital letters
  of an option or click it in the prompt.
- Many commands accept an argument on the same line: `ZOOM E`, `AEREPORT wires`,
  `AECOMPONENT HPB11_NO`, `LAYER Set WIRES`.

Point input:

| Input | Meaning |
| --- | --- |
| `x,y` | Absolute coordinates |
| `@dx,dy` | Relative to the last point |
| `d<a` | Polar from the origin (distance, angle in degrees) |
| `@d<a` | Polar from the last point |
| a number while dragging | Direct distance in the direction of the cursor |

Object snaps (OSNAP, F3) lock the cursor to endpoints, midpoints, centres, quadrants, nodes,
intersections, perpendicular and tangent points, nearest points and insertion points. Choose
the running modes in Drafting Settings or with `OSNAPSET` (keywords `END MID CEN NOD QUA INT
INS PER TAN NEA NONE`). Object snap tracking (OTRACK, F11) draws alignment paths from
acquired points; polar tracking (F10) snaps to the `POLARANG` increment.

---

## 5. Drafting commands

Aliases are listed after the command. Only the names in this manual are registered; the
Help window (F1) lists every command with its description and is searchable.

### Draw

| Command | Aliases | Notes |
| --- | --- | --- |
| LINE | L | Line segments; Ctrl+Z undoes the last segment |
| PLINE | PL | Polyline `[Arc/Close/Halfwidth/Length/Undo/Width]` |
| CIRCLE | C | |
| ARC | A | 3-point arc |
| RECTANG | REC, RECTANGLE | |
| POLYGON | POL | `[Edge / Inscribed / Circumscribed]` |
| ELLIPSE | EL | Ellipse or elliptical arc |
| DONUT | DO, DOUGHNUT | Filled ring |
| POINT | PO | Marker set by `PDMODE` / `PDSIZE` |
| XLINE | XL | Construction line `[Hor/Ver/Ang/Bisect/Offset]` |
| RAY | | Semi-infinite construction line |
| TEXT | T, DT, DTEXT | Single-line text |
| MTEXT | MT, -MTEXT | Multi-line text with word wrap `[Height/Justify/Line spacing/Rotation/Width]` |

Text is drawn with a single-stroke Hershey font, which looks like classic CAD `txt` text.
The control codes `%%c`, `%%d` and `%%p` give the diameter, degree and plus/minus symbols.
Text whose text style names a TrueType or OpenType font (for example `arial.ttf` in a drawing
from another program) is drawn in that font when the system has it. MTEXT read from a file
keeps its formatting: colours, heights, width factor, oblique, bold / italic, underline /
overline / strike-through, stacked fractions and tolerances and paragraph alignment.

### Splines and hatches

| Command | Aliases | Notes |
| --- | --- | --- |
| SPLINE | SPL | Spline through fit points, or by control vertices |
| HATCH | H, BH, BHATCH, -HATCH | Hatch or fill closed areas |
| HATCHEDIT | HE, -HATCHEDIT | Change a hatch's pattern, scale, angle, origin or style |

**Draw a spline** (Home > Draw > Spline):

1. Run `SPLINE`. The command line shows the current method (`Method=Fit`).
2. At `Specify first point or [Method/Knots/Object]:` pick the first point. `Method` switches
   between **Fit** (the curve passes through the points) and **CV** (control vertices; the
   prompt then offers `Degree`, 3 by default).
3. Keep picking at `Enter next point or [start Tangency/toLerance/Undo/Close]:`.
   `start Tangency` (after the first point) and `end Tangency` (later) take a direction point;
   giving the end tangent finishes the spline. `Undo` removes the last point, `Close` closes the
   curve with a smooth joint.
4. Press Enter to finish an open spline.

Only chord-length knots and a fit tolerance of 0 are used; converting polylines (`Object`) is
not supported.

**Hatch an area** (Home > Draw > Hatch or Annotate > Markup > Hatch):

1. Run `HATCH`. Optionally type `P` (Properties) first: `Enter a pattern name or
   [?/Solid/User defined] <ANSI31>:` (`?` lists the patterns ANSI31-ANSI38, NET, NET3, DOTS,
   LINE, BRICK), then the pattern scale and angle. The choice is remembered.
2. At `Specify internal point or [Properties/Select objects/draW boundary/Origin]:` click inside
   a closed area formed by lines, arcs, circles and polylines; the boundary is found for you and
   previewed. Click more areas to add them.
   - `Select objects` uses closed objects you select (open ones are ignored and counted).
   - `draW boundary` lets you pick the corners of a boundary (Enter closes it).
   - `Origin` sets the point the pattern starts from.
3. Press Enter to create the hatch. A pattern that would be too dense to see is shown as a light
   fill and the command line says so.

`HATCHEDIT`: select the hatch, then `Enter hatch option [Disassociate/Style/Properties/Origin]
<Properties>:`; Properties asks for the pattern, scale and angle again, Style for
Ignore / Outer / Normal. Hatches from DXF and DWG files keep the pattern lines stored in the file
(ISO scales, double hatches).

### Leaders, tables and fields

| Command | Aliases | Notes |
| --- | --- | --- |
| LEADER | LEAD | Leader line with arrowhead and annotation text |
| QLEADER | LE | The same, started as a quick leader |
| MLEADER | MLD | Multileader: arrowhead, landing and text |
| TABLE | TB, -TABLE | Insert a table |
| TABLEEDIT | | Edit the text of a table cell |
| FIELD | | Text with a field (date, file name, drawing properties) |
| UPDATEFIELD | | Re-evaluate the fields of selected objects |

**Leader** (Annotate > Text > Leader):

1. `LEADER`, pick the arrowhead point (`Specify leader start point:`), then one or more points.
2. After the second point the prompt is `Specify next point or [Annotation/Format/Undo]
   <Annotation>:`. `Format` offers `Spline / STraight / Arrow / None` (curved leader, straight
   leader, arrowhead on or off).
3. Press Enter for the annotation: type one line at `Enter first line of annotation text or
   <options>:`, further lines at the next prompt, and an empty line to finish. A short
   horizontal landing is added when the last segment is steep.

**Multileader** (Annotate > Text > Multileader):

1. `MLEADER`. At `Specify leader arrowhead location or [leader Landing first/Content first/Options]
   <Options>:` pick the arrowhead (the other options change the order, or set the arrowhead size
   and landing distance).
2. Pick the landing location, then type the text lines (empty line to finish).

**Table** (Annotate > Text > Table):

1. `TABLE`. Enter the number of columns and of data rows.
2. At `Specify insertion point or [Style/Width/Height]:` pick the top-left corner (`Width` sets
   the column width, `Height` the data row height in lines). The table has a title row, a header
   row and the data rows.
3. `TABLEEDIT` (Annotate > Text > Edit Cell): pick a cell and type its text (Enter keeps it).

**Field** (Annotate > Text > Field):

1. `FIELD`. Choose the field: `Date`, `CreateDate`, `SaveDate`, `PlotDate`, `Filename`, `Title`,
   `Subject`, `Author`, `Keywords`, `Comments`, `LastSavedBy` or `Login`.
2. Date fields list numbered formats (`M/d/yyyy`, `yyyy-MM-dd`, ...); type a number or your own
   format. `Filename` asks for `Name / NAME.Ext / Path / Folder`.
3. Pick the start point of the text. The text shows the value and keeps the field code, so a
   saved DXF carries the field. Values that cannot be evaluated show `####`, empty drawing
   properties `----`.
4. `UPDATEFIELD` (Update Fields) re-evaluates the fields in the selected objects.

### Images and external references

Drawings from other programs may contain raster images (IMAGE) and external references
(xrefs). JCad Electrical keeps both and writes them back when you save:

- **Images**: the desktop application loads the image file (`.png`, `.jpg`, `.jpeg`, `.gif`,
  `.bmp`, `.webp`, up to 50 MB) from the stored path, relative to the drawing's folder, or from the
  drawing's folder when the stored folder does not exist. The browser edition, or a missing file,
  shows the image frame with its file name. `LIST` shows the path and the size in pixels and
  drawing units.
- **External references** are drawn as a dashed frame with the reference name; the referenced
  file is not loaded.

### Modify

| Command | Aliases | Notes |
| --- | --- | --- |
| ERASE | E, DEL | Also the Delete key |
| MOVE | M | |
| COPY | CO, CP | |
| ROTATE | RO | |
| MIRROR | MI | |
| SCALE | SC | |
| STRETCH | S | Vertices inside a crossing window |
| TRIM | TR | |
| EXTEND | EX | |
| OFFSET | O | |
| FILLET | F | `[Radius/Trim/Polyline/Multiple]` |
| CHAMFER | CHA | `[Distance/Angle/Trim/Multiple]` |
| ARRAY | AR, -ARRAY | `[Rectangular/Polar]`; also ARRAYRECT and ARRAYPOLAR |
| BREAK | BR | Break between two points |
| JOIN | J | Lines, arcs and polylines |
| LENGTHEN | LEN | `[DElta/Percent/Total]` |
| ALIGN | AL | Source / destination point pairs |
| EXPLODE | X | Blocks and polylines |
| MATCHPROP | MA, PAINTER | Copy properties from one object to others |
| CHPROP | -CHPROP | Colour, layer, linetype, linetype scale, lineweight |
| UNDO | U | Ctrl+Z |
| REDO | MREDO | Ctrl+Y or Ctrl+Shift+Z |

### Blocks

| Command | Aliases | Notes |
| --- | --- | --- |
| BLOCK | B, -BLOCK, BMAKE | Define a block from selected objects |
| INSERT | I, -INSERT, DDINSERT, CLASSICINSERT | Name, scale, rotation, attribute prompts |
| PURGE | PU, -PURGE | Unused `[Blocks/LAyers/LTypes/All]` |

### Dimensions

| Command | Aliases |
| --- | --- |
| DIMLINEAR | DLI, DIMLIN (`Horizontal/Vertical/Rotated/Text`) |
| DIMALIGNED | DAL, DIMALI |
| DIMRADIUS | DRA, DIMRAD |
| DIMDIAMETER | DDI, DIMDIA |
| DIMANGULAR | DAN, DIMANG |
| DIMBASELINE | DBA, DIMBASE (`Undo/Select`) |
| DIMCONTINUE | DCO, DIMCONT (`Undo/Select`) |
| DIMTEDIT | DIMTED (`Left/Right/Center/Home/Angle`) |
| DIMEDIT | DED, DIMED (`Home/New/Rotate/Oblique`) |
| DIMSTYLE | D, DST, DDIM, DIMSTY (Dimension Style Manager) |
| -DIMSTYLE | `Save/Restore/STatus/Variables/Apply/?` on the command line |

Press Enter at the first prompt of DIMLINEAR / DIMALIGNED to dimension a picked object. Every
dimension variable of the style can be typed as a command to see or set its value: `DIMTXT`,
`DIMASZ`, `DIMEXO`, `DIMEXE`, `DIMGAP`, `DIMCEN`, `DIMSCALE`, `DIMDEC`, `DIMADEC`, `DIMLUNIT`, and
`DIMBLK`, `DIMBLK1`, `DIMBLK2`, `DIMSAH`, `DIMTAD`, `DIMJUST`, `DIMTIH`, `DIMTOH`, `DIMSE1`, `DIMSE2`,
`DIMSD1`, `DIMSD2`, `DIMDLE`, `DIMDLI`, `DIMCLRD`, `DIMCLRE`, `DIMCLRT` (a colour number, or BYLAYER /
BYBLOCK for the dimension's own colour), `DIMATFIT`, `DIMTIX`, `DIMTOFL`, `DIMPOST`, `DIMRND`,
`DIMLFAC`, `DIMZIN`, `DIMALT`, `DIMALTF`, `DIMALTD`, `DIMALTU`, `DIMAPOST`, `DIMTOL`, `DIMLIM`,
`DIMTP`, `DIMTM`, `DIMTDEC` and `DIMTFAC`. For example `DIMBLK _ArchTick` gives architectural ticks,
`DIMTAD 1` puts the text above the line.

**Baseline and continued dimensions** (Annotate > Dimensions > Baseline / Continue):

1. Draw a linear, aligned or angular dimension first (or be ready to select one).
2. Run `DIMBASELINE` (or `DIMCONTINUE`). It starts from the last dimension you drew; if there is
   none it asks `Select base dimension:` / `Select continued dimension:` (the extension line
   nearest your pick is used).
3. At `Specify a second extension line origin or [Undo/Select] <Select>:` pick the next point.
   Baseline dimensions all start at the first extension line and step outwards by the baseline
   spacing (`DIMDLI` x `DIMSCALE`); continued dimensions chain end to end on one line.
   `Undo` removes the last one, `Select` (or Enter) picks another base.
4. Press Esc, or Enter at the select prompt, to finish.

**Edit dimension text** (Annotate > Dimensions > Text Edit / Dim Edit):

- `DIMTEDIT`: select a dimension, then drag the text to a new place or choose `Left`, `Right` or
  `Center` (linear and aligned dimensions), `Home` (back to the default position and angle) or
  `Angle` (a fixed text angle).
- `DIMEDIT`: `Enter type of dimension editing [Home/New/Rotate/Oblique] <Home>:`. `New` replaces the
  text (`<>` stands for the measured value), `Rotate` sets the text angle, `Oblique` slants the
  extension lines of linear and aligned dimensions (Enter for none); then select the dimensions.

**Dimension styles** (Annotate > Dimensions > Dim Style, or `DIMSTYLE`):

The **Dimension Style Manager** lists the drawing's named styles with a preview. **Set Current**
makes the selected style the one new dimensions use; **New...** asks for a name and the style to
start with; **Modify...** edits a style (dimensions that use it update); **Compare...** lists the
variables in which two styles differ; **Delete** removes a style that no dimension uses (not
Standard or the current style). The style editor has the tabs:

- **Lines**: dimension line colour, extension past ticks, baseline spacing, suppression of either
  half of the dimension line; extension line colour, offset from origin, extension beyond the
  dimension line, suppression of either extension line.
- **Symbols and Arrows**: first and second arrowhead (closed filled, closed blank, closed, open,
  oblique, architectural tick, dot, small dot, blank dot, none), arrow size, centre mark size.
- **Text**: height, colour, gap, vertical position (centred, above, outside, below), horizontal
  position (centred, at extension line 1 or 2), alignment (horizontal, aligned with the dimension
  line, ISO standard).
- **Fit**: what moves outside the extension lines when space is short, text always inside,
  dimension line drawn between the extension lines, overall scale.
- **Primary Units**: unit format and precision, prefix / suffix, measurement scale factor,
  round-off, leading / trailing zero suppression, angular precision.
- **Alternate Units**: on / off, multiplier (25.4 for inches to millimetres), format, precision,
  prefix / suffix, placement after or below the primary value.
- **Tolerances**: none, symmetrical, deviation, limits or basic (boxed); upper and lower values,
  precision and text height scale.

`-DIMSTYLE` (or `DIMSTYLE` followed by an option) works on the command line: `Save` stores the
current settings under a name, `Restore` makes a named style current (or pick a dimension to use
its style), `STatus` lists the current values, `Variables` lists a style's values, `Apply`
gives selected dimensions the current style, `?` lists the styles. Named styles are saved in the
drawing (DIMSTYLE records in DXF) and come back from DXF and DWG files.

### Inquiry

| Command | Aliases | Notes |
| --- | --- | --- |
| DIST | DI, MEASUREGEOM | `[Multiple points]` |
| AREA | AA | `[Object/Add/Subtract]` |
| ID | | Coordinates of a point |
| LIST | LI, LS | Object information |
| PROPERTIES | PR, CH, MO | Properties palette |

### View

| Command | Aliases | Notes |
| --- | --- | --- |
| ZOOM | Z | `[All/Center/Extents/Previous/Scale/Window/OBject/In/Out]` |
| PAN | P | Drag with the left button; Esc ends |
| VIEW | V, -VIEW, DDVIEW | Named views `[?/Delete/Restore/Save/Window]` |
| REGEN | RE, REGENALL, REA | |
| UNITS | UN, -UNITS, DDUNITS | Drawing units, precision, insertion scale |
| LIMITS | | `[ON/OFF]` |
| GRID | F7 | Toggle the grid; `GRIDDISPLAY` sets whether it extends past the limits |
| SNAP | F9 | Grid snap |
| ORTHO | F8 | |
| POLAR | F10 | Polar tracking; `POLARANG` sets the increment, `POLARMODE` the tracking bits |
| OSNAP | F3, OS | Object snap on / off; `OSNAPSET` (-OSNAP, OSMODE) chooses modes |
| OTRACK | F11 | Object snap tracking |
| DYNMODE | DYN, F12 | Dynamic input |
| LWDISPLAY | LW | Show lineweights |
| CURSORSIZE | | Crosshair size in percent of the screen |

### Selection

| Command | Aliases | Notes |
| --- | --- | --- |
| SELECT | | `[Window/Crossing/Fence/WPolygon/CPolygon/Previous/Last/ALL/Add/Remove/Undo]` |
| QSELECT | | Quick select by type, layer or colour |
| SELECTALL | ALL | Ctrl+A |

`ALL`, `L` (Last) and `P` (Previous) also work at any "Select objects:" prompt.

### Layers, linetypes, lineweights, colour

| Command | Aliases | Notes |
| --- | --- | --- |
| LAYER | LA, DDLMODES | Layer Properties Manager; with options it works like -LAYER |
| -LAYER | | `[?/Make/Set/New/ON/OFF/Color/Ltype/LWeight/Freeze/Thaw/LOck/Unlock]` |
| CLAYER | | Set the current layer |
| LAYMCUR, LAYCUR, LAYMCH | LAYMAKECURRENT, LAYMATCH | Make the object's layer current; move objects to the current layer; match another object's layer |
| LAYISO / LAYUNISO | | Isolate the layers of the selection / restore |
| LAYOFF / LAYON | | Turn off the selection's layers / turn all on |
| LAYFRZ / LAYTHW | | Freeze the selection's layers / thaw all |
| LAYLCK / LAYULK | | Lock the selection's layers / unlock all |
| LINETYPE | LT, LTYPE, -LINETYPE, DDLTYPE | `[?/Load/Set]` |
| CELTYPE | | Current linetype for new objects |
| LTSCALE | | Global linetype scale |
| LWEIGHT | -LWEIGHT, LINEWEIGHT | Default lineweight for new objects |
| CELWEIGHT | | Current lineweight for new objects |
| COLOR | COLOUR, CECOLOR | Current colour (ByLayer or 1-255); applies to a selection |

Available linetypes: Continuous, DASHED, HIDDEN, CENTER, PHANTOM, DOT, DASHDOT, DIVIDE,
BORDER and their 2x variants. Dashed lines scale with LTSCALE and the zoom and turn solid when
the pattern would be finer than a few pixels.

### Clipboard and screen

| Command | Shortcut | Notes |
| --- | --- | --- |
| COPYCLIP / CUTCLIP / PASTECLIP | Ctrl+C / Ctrl+X / Ctrl+V | Objects, within JCad Electrical |
| CLEANSCREEN | Ctrl+0 | Hide ribbon and palettes |
| COMMANDLINE / COMMANDLINEHIDE | Ctrl+9 | Show / hide the command window |
| TOOLPALETTES | Ctrl+3 (TP) | |
| QPMODE | QP | Quick Properties on selection |
| WORKSPACE | WSCURRENT | `drafting` or `electrical` |
| TEXTSCR | F2, TEXTWINDOW | Text window |

---

## 6. Electrical workflow

JCad Electrical stores electrical data the way AutoCAD Electrical does: every symbol is a block
with attributes (`TAG1`, `DESC1`-`DESC3`, and invisible `INST`, `LOC`, `MFG`, `CAT`,
`ASSYCODE`, `RATING1`-`2`, `WDTYPE` and the wire-connection pins `X1TERMnn` / `X2TERMnn` /
`X4TERMnn` / `X8TERMnn`). Drawing settings live in a `WD_M` block on layer `WD_M`. Because it
is all ordinary DXF data, a saved drawing carries everything.

### Symbol standard

Two libraries are built in: **JIC** (NFPA style) and **IEC 60617** style, 450+ symbols in
52 categories, including one-line power, PLC modules and fluid power. Choose the default in
Options > Files > Symbol Library, or per drawing in Drawing Properties. The icon menu can
switch between them.

### Drawing properties

`AEDRAWINGPROPS` (aliases DRAWINGPROPERTIES, DWGPROPS, AESETTINGS) edits the drawing's
settings: sheet number, drawing number and description, symbol standard, the tag format
(`%F` family, `%N` number, `%S` sheet; default `%F%N`), reference or sequential tag numbering,
the cross-reference format and style (text or table), the wire number mode, format, start and
position, IEC codes, and the ladder defaults.

### Ladders

`AELADDER` (LADDER) opens **Insert Ladder**: width, rung spacing, number of rungs, first
reference, index step, phase (1 or 3) and whether rung lines are drawn. Pick the top-left
corner. The rung references drive tag and wire numbers.

### Wires

| Command | Aliases | What it does |
| --- | --- | --- |
| AEWIRE | WIRE, W | Orthogonal wire on the current wire layer; junction dots at tees; `[Close/Undo]` |
| AEWIRETYPE | WIRETYPE | Choose the wire type (layer, gauge, colour) for new wires |
| AEMULTIBUS | MULTIBUS, BUS | Several parallel wires at once |
| AETRIMWIRE | TRIMWIRE | Remove a wire segment between components / junctions |
| AEWIREGAP / AEWIRELOOP | WIREGAP / WIRELOOP | Gap or jump-over loop where wires cross |
| AESCOOT | SCOOT | Slide a component or wire number along its wire |
| AEALIGN | | Align components with a reference `[Vertical/Horizontal]` |
| LINE2WIRE | | Convert selected lines into wires |

### Components

| Command | Aliases | What it does |
| --- | --- | --- |
| AECOMPONENT | COMPONENT, CMP, AEC | Icon menu, then insert; the wire is broken around the symbol |
| AEEDITCOMPONENT | EDITCOMPONENT, AEEDIT | Edit tag, location, descriptions, catalog, pins (also double-click) |
| AECHILD | CHILD, INSERTCHILD | Child contact of a coil: pick the parent, then NO or NC |
| AECOMPONENT3 | COMPONENT3, AEC3 | 3-pole device on a 3-wire bus (one tag, pins per pole) |
| AERETAG | RETAG | Renumber all tags in ladder order with the drawing's tag format |
| AETOGGLENC | TOGGLENC | Switch a contact between NO and NC in place |
| AESWAP | SWAPBLOCK, AESWAPBLOCK | Swap the symbol, keep its data |
| AEUPDATEBLOCK | UPDATEBLOCK | Refresh block definitions from the library |
| AESYMBOLINFO | | List the pin and data attributes of a symbol |

The **icon menu** has a search box across all categories, a JIC / IEC switch and a
**Horizontal / Vertical** choice. Vertical inserts the library's vertical twin of the symbol
(or builds one) for use on vertical wires. The library has hand-drawn vertical versions of the
most used symbols (41 JIC symbols such as `VPB11_NO`, `VCR1`, `VTD1_NO`, and 12 IEC `NAME_V`
symbols); other symbols get a rotated twin.

The **Insert / Edit Component** dialog holds the component tag (with the list of tags already
used in that family and a "next free tag" button), installation (INST), location (LOC),
description lines 1-3, manufacturer (MFG), catalog (CAT), assembly code, rating and the pin
numbers. **Catalog Lookup...** opens the Catalog Browser filtered to the component's family.
Retagging a parent (coil) carries its child contacts along. In Edit Component, **Fixed tag**
keeps the tag when components are retagged (the same flag `AEFIXTAG` sets).

### Wire numbers

| Command | Aliases | What it does |
| --- | --- | --- |
| AEWIRENO | WIRENO | Number every wire net; fixed numbers are kept |
| AEEDITWIRENO | EDITWIRENO | Edit a number: value, fixed flag, position (above, below, in-line), find and replace |
| AECOPYWIRENO | COPYWIRENO | Copy a number to another wire |
| AEWIRENOLEADER | WIRENOLEADER | Move a number away with a leader |

With reference numbering, numbers follow the rung reference with letter suffixes (`100`,
`100A`, `100B`, ...). Fixed numbers live on layer `WIREFIXED` and are never renumbered.

### Cross-references

`AEXREF` (XREF) updates the coil / contact cross-references: each coil lists its contacts by
rung (for example `NO 101, 102 / NC 103`, or a small table when the drawing's cross-reference
style is "table"), and each contact shows the rung of its coil. Run it again after moving or
adding contacts. When the drawing belongs to a project, AEXREF works project-wide (see
[Project-wide tools](#project-wide-tools)).

### Source and destination arrows

`AESOURCE` (SOURCE) and `AEDEST` (DEST) place signal arrows on wire ends. You are asked for a
signal code (for example `24VDC-1`); a source and a destination with the same code are linked
and show each other's sheet and rung.

### PLC modules

`AEPLC` (PLC) opens **Insert PLC Module**: module tag, type, number of I/O points, address
prefix, first address, point spacing and description. Pick the top-left corner. The module is
parametric: points are numbered and addressed for you. The ribbon's **PLC Point** button
inserts a single PLC input symbol.

### Terminals and terminal strips

- Insert single terminals from the icon menu (ribbon **Schematic > Terminal** or
  **Panel > Terminal**). Terminals are numbered with the next free number of their strip.
- `AETERMSTRIP` (TERMSTRIP) inserts a panel terminal strip: strip tag, number of terminals,
  first number and pitch.
- `AETERMEDIT` (TERMEDIT, TERMINALEDITOR) opens the **Terminal Strip Editor**: wire numbers
  and devices on the left and right of every terminal, read from the schematic; edit strip
  tags and terminal numbers (or **Renumber 1..n**) and click OK to update the symbols.

### Circuit Builder

`AECIRCUIT` (CIRCUITBUILDER, CIRCUIT) inserts a ready-made motor control circuit on an existing
ladder: start / stop with seal-in and run light, reversing starter (forward / reverse with
interlocks), or start / stop with jog relay. Choose the symbol standard and the load
description, click OK and pick the first rung at the left rail; rails, spacing and references
are detected.

### Panel layout

| Command | Aliases | What it does |
| --- | --- | --- |
| AESCHEMATICLIST | SCHEMATICLIST, AEPANELLIST | List of schematic components; pick one and place its footprint |
| AEFOOTPRINT | FOOTPRINT | Footprint for a selected schematic component |
| AEBALLOON | BALLOON | Item-number balloon on a footprint |
| AENAMEPLATE | NAMEPLATE | Nameplate for a footprint or component (or type the text) |

Footprints are blocks named `WD_FP_<family>` with attributes `P_TAG1`, `P_ITEM`,
`P_DESC1`-`2`, `P_MFG`, `P_CAT`, `P_INST`, `P_LOC`, so panel reports can read them.

### Panel hardware

The **Panel > Panel Layout** panel draws the enclosure and the hardware inside it. The pieces are
blocks whose invisible attributes carry the type, length and part number, so the Panel Hardware
report can list them. Sizes are in inches.

| Command | Aliases | What it does |
| --- | --- | --- |
| AEPANEL | AEENCLOSURE, ENCLOSURE | Enclosure outline with mounting plate, hinges and door swing |
| AEPANELGRID | PLATEGRID, AEMOUNTGRID | Mounting plate with a layout grid |
| AEDINRAIL | DINRAIL | DIN rail (TS35, TS32 or TS15) |
| AEWIREDUCT | WIREDUCT, DUCT | Wire duct run with its cover lines |
| AEFOOTPRINTALIGN | FOOTPRINTALIGN | Line footprints up on a DIN rail |
| AETERMFOOTPRINT | TERMFOOTPRINT, AETERMSTRIPFP | Terminal strip footprint from the terminal table |
| AEPANELHW | PANELHARDWARE | List the hardware with total lengths on the command line |

1. **Enclosure.** `AEPANEL`: enter a size `H x W x D` from the list (16x12x6 up to 72x36x16) or
   `Custom` and type your own, choose the door hinge side (`Left / Right / None`), and pick the
   lower-left corner.
2. **Plate grid.** `AEPANELGRID`: pick two corners of the mounting plate, or type `E`
   (Enclosure) and pick an enclosure to use its plate; `Spacing` sets the grid spacing.
3. **DIN rail.** `AEDINRAIL`: pick the start point (`Type` chooses TS35 / TS32 / TS15, `Part` a
   part number), then the end point, or `Length` followed by a direction (`Horizontal /
   Vertical` or a point).
4. **Wire duct.** `AEWIREDUCT`: the same way; `Size` chooses 1x1, 1.5x2, 2x2, 2x3, 3x3 or 4x4.
5. **Footprints on the rail.** Place footprints (AESCHEMATICLIST / AEFOOTPRINT), then
   `AEFOOTPRINTALIGN`: select the footprints, select the rail and give the gap between them or
   `Even` to spread them over the rail. The command line warns when they run past the rail.
6. **Terminal strips.** `AETERMFOOTPRINT`: choose a strip, pick its location. The footprint has one
   terminal per entry of the terminal table (jumpered terminals get jumper bars); placing a strip
   again replaces its old footprint and keeps the item number.
7. **Hardware list.** `AEPANELHW`, or the **Panel Hardware** report (`AEREPORT panelhw`, Reports >
   Panel > Panel Hardware), lists rails, duct, enclosures and plates with quantities and total
   lengths.

### Reports and audit

`AEREPORT` (REPORT, BOM) opens the **Reports** dialog. Choose a report, the scope (this drawing
or the whole project in the desktop app), then **Save as CSV...** or **Put on Drawing** to
place the report as a table. You can also type the report name: `AEREPORT bom`,
`AEREPORT wires`, and so on. `AEREPORTCSV <key>` writes a report straight to CSV.

| Key | Report |
| --- | --- |
| `bom` | Bill of Material |
| `components` | Component Report |
| `wires` | Wire From/To |
| `labels` | Wire Labels |
| `plc` | PLC I/O Address |
| `missing` | Missing Catalog Data |
| `terminals` | Terminal Report |
| `strip` | Terminal Strip |
| `cables` | Cable Schedule |
| `panel` | Panel Components |
| `panelhw` | Panel Hardware |
| `audit` | Electrical Audit |

`AEAUDIT` (AUDIT, ELECTRICALAUDIT) opens the **Electrical Audit** dialog with every issue
(severity, check, item, detail); select one and click **Go To** to zoom to it, **Re-run** after
fixing things.

### Sheets, title blocks and projects

- `NEWSHEET` (TEMPLATE) creates a drawing from a sheet template: ANSI A, B, C, D, ISO A4 or
  A3, with an attributed title block.
- `AETITLEBLOCK` (UPDATETITLEBLOCK, TITLEBLOCK) fills the title block from the project and
  drawing properties.
- A **project** (`*.jcadproj.json`) lists the drawings that belong together, the project
  description lines (PROJECT, CUSTOMER, JOB, DRAWN, CHECKED, APPROVED, ...), the user catalog
  file and default formats. Use `OPENPROJECT` (PROJECT), `PROJECTADD` (add the current
  drawing), `PROJECTSAVE` and `AEPROJECTPROPS` (PROJECTPROPERTIES, PROJPROPS; tabs General,
  Description Lines and Title Block Mapping). Reports can then run across every drawing of the
  project.

### Project-wide tools

These commands work on every drawing of the open project (Project > Project-Wide, or right-click
the project in the Project Manager):

| Command | Aliases | What it does |
| --- | --- | --- |
| AEXREFPROJECT | XREFPROJECT, AEXREFP | Coil / contact cross-references across all drawings |
| AERETAGPROJECT | RETAGPROJECT | Retag all components, or only duplicate and blank tags (`All / Duplicates`) |
| AEWIRENOPROJECT | WIRENOPROJECT | Wire numbers unique across the project (`Sheet-based` start at sheet x 100, or each drawing's own start number) |
| AETITLEBLOCKALL | TITLEBLOCKALL | Fill the title block of every drawing through the project's mapping |
| AELOCVIEW | LOCVIEW, LOCATIONVIEW | Location View |
| AEFIXTAG | FIXTAG | Fix or release the tags of selected components |

How the changes are applied:

1. The drawing in the current tab and drawings open in other tabs are changed in memory: each
   gets one undo step and is marked changed (save it as usual).
2. Closed drawings of the project are read from disk. When one of them would change, a dialog
   lists every affected drawing with what changes; confirm to write the closed ones back as DXF,
   optionally keeping a `.bak` copy of each. Cancel changes nothing.
3. DWG drawings are read-only and are skipped; the command line lists skipped drawings. The
   browser edition cannot read closed drawings, so open them in tabs first.

After `AEXREFPROJECT` a **Cross-Reference Problems** list shows contacts without a parent and
duplicate parents; double-click a row on the current drawing to zoom to it. The Project Manager
shows each drawing's installation / location codes and cross-reference status.

**Fixed tags.** `AEFIXTAG` (or the **Fixed tag** checkbox in Edit Component) sets `TAGFIXED` on the
selected components; AERETAG and AERETAGPROJECT leave fixed tags alone. Run AEFIXTAG again to
release them.

**Location View** (`AELOCVIEW`): the components of the project grouped by installation and
location, with type, description, catalog, jumpers, drawing, sheet and rung. Double-click a row
of the current drawing to zoom to it; save the list as CSV or put it on the drawing as a table.

### Cables and jumpers

1. **Cable.** `AECABLE` (Schematic > Cables/Jumpers/PLC I/O > Cable Marker): pick the wires of the
   cable in conductor order and press Enter. In the dialog enter the cable tag (`CABLENO`), cable
   type, conductor identification (numbers or colours) and the first conductor number. Each wire
   gets a `WD_CABLE` marker with its conductor, wire number and FROM / TO (the device pins at the
   ends of that wire).
2. **Cable Schedule.** `AECABLESCHEDULE` opens the Cable Schedule report (cables, conductors,
   from / to, wire numbers).
3. **Jumper.** `AEJUMPER`: pick the first terminal, then a second terminal of the same strip. Both
   terminals record the jumper in their `JUMPER` attribute; keep picking pairs, Enter to finish.
   `AEJUMPERDEL` removes the jumpers of a picked terminal.

### PLC I/O from a spreadsheet

1. Prepare a CSV or tab-separated file with one row per I/O point. Recognised column headers:
   `Address` (required), `Description 1` / `Desc1` (and 2, 3), `Wire`, `Device` / `Tag`, `Module`
   and `Type` (input / output). Without a header row the columns are read as Address,
   Description 1-3, Wire number, Device tag. Inputs and outputs are told apart by the Type column
   or the address (`I:`, `%I`, `X` ... / `O:`, `%Q`, `Y` ...).
2. Run `AEPLCIO` (Schematic > PLC I/O Import) and pick the file. The import dialog previews the
   points and the modules they form, and can add a rung with the device for each point.
3. Click OK and pick the top-left corner. The modules are placed side by side with the point
   descriptions filled in.
4. `AEPLCIOEXPORT` writes the drawing's PLC I/O points to a CSV in the same format.

### Report templates

`AEREPORTTEMPLATES` (Project > Report Templates) saves report formats in the project file. For each
template choose a name, the report, a title, the output (show in a dialog, place on the drawing as
a table, or write a CSV file), project-wide or current drawing, the columns and their order, the
sort columns and row filters (contains, equals, starts with, does not contain, is empty, is not
empty). Run a template from the dialog, with `AEREPORTRUN <name>`, or with `AEREPORTRUN` alone to
pick it from a list.

### Title block mapping

**Project Properties > Title Block Mapping** holds lines in the AutoCAD Electrical `.wdt` format,
`ATTRIBUTE = SOURCE`:

```
BLOCK = WD_TITLEBLOCK
CUSTOMER = LINE2
TITLE = DWGDESC|PROJDESC
SHEET = %SHEET% OF %SHEETMAX%
REVBY = "JD"
```

Sources are the project description lines `LINE1`-`LINE12`, `PROJ`, `PROJDESC`, `DWGDESC`, `DWGNO`,
`SHEET`, `SHEETMAX`, `DATE`, `REV`, `SEC`, `FILENAME` and `IEC_PROJ` / `IEC_INST` / `IEC_LOC`; `A|B`
takes the first non-empty value, `%CODE%` fills a template and quotes give literal text. Leave it
empty for the built-in mapping. `AETITLEBLOCK` applies it to the current drawing,
`AETITLEBLOCKALL` to every drawing of the project; `AEWDTIMPORT` and `AEWDTEXPORT` read and write
`.wdt` files.

### Metric drawings

A drawing can use inches (the default) or millimetres. In a metric drawing the symbols, junction
dots, ladders, 3-phase inserts, circuits, wire numbers and sheet templates are scaled by 25.4 so
they keep their real size.

- **Drafting Settings > Drawing Units** (`DSETTINGS`, or the status bar's units menu): choose Inches
  or Millimeters, tick **Rescale existing objects** to scale what is already drawn, and click
  Apply to drawing.
- Command line: `WDUNITS` shows the units; `WDUNITS MM` or `WDUNITS IN` switch, `WDUNITS MM RESCALE`
  also scales the existing objects (aliases AEUNITS, DRAWINGUNITS).
- A DXF saved in millimetres by another program opens as a metric drawing.

[METRIC.md](METRIC.md) has the details.

---

## 7. Symbol Builder and the user library

Use the Symbol Builder when the library does not have the symbol you need, or to bring in
symbols from a manufacturer's DWG.

### Starting a symbol

Run `AESYMBUILDER` (SYMBUILDER, SYMBOLBUILDER, SYMEDIT), click **Schematic > Symbol
Builder**, or choose **New Symbol...** in the icon menu. The start dialog asks for:

- the block name (spaces become `_`), description, standard (JIC / IEC) and category;
- the family (the tag prefix, for example `PB` or `CR`) and role: parent coil, child contact
  (NO / NC), device, terminal or PLC point;
- orientation: horizontal (inline on a rung) or vertical (on a vertical wire);
- where to start: a blank symbol with the attribute template already placed, a copy of a
  library symbol, a **block of the current drawing** (to harvest manufacturer symbols), or the
  selected objects.

Press Enter or click OK. The symbol opens in its own file tab named `Symbol: NAME`.

### Editing

Draw the geometry with the normal drafting commands (in inches, around the origin; the tab
shows the 0.75 x 0.75 in box and the wire-stub guides). The docked **Symbol Builder** palette
has collapsible sections:

- **Symbol**: name, family, role, contact type, orientation;
- **Attributes**: place, move or remove TAG1, DESC1-3, TERM01, INST, LOC, MFG, CAT,
  RATING1 and others, with default values; convert selected plain text into an attribute;
- **Defaults**: the invisible data defaults (MFG, CAT, RATING1, INST, LOC, ASSYCODE and vendor
  attributes);
- **Pins**: detected and explicit wire connections with their pin numbers. A pin's side comes
  from where its marker sits, so COPY, MIRROR and ROTATE keep pins right;
- **Preview**: exactly what will be inserted;
- a **Check** area listing problems (name, connections, duplicate or wrong-side pins, markers
  off a line end, TAG1 over the geometry, and more). Save is disabled while errors exist.

**Attribute details.** Open an attribute row to set its **prompt** (the question asked when the
symbol is inserted; blank = the standard prompt), its flags - **Invisible**, **Constant** (every
insert carries the default and it is never asked), **Verify** (confirmed at insertion), **Preset**
(takes the default without asking) - the text height and the justification, or **Move** it. The
arrows move rows up and down: the saved block keeps this order and the insert dialog asks in it.
The **Templates** buttons add missing attributes in one step: TAG1 + DESC1-3, INST / LOC, MFG / CAT /
ASSYCODE (invisible), TERM01 / TERM02, XREF and RATING1-12 (invisible).

**Checklist.** Above the buttons a checklist shows what is ticked (valid unused name, connection
points, no overlapping pins, known family, DESC1, consistent attribute flags ...). Errors block
saving; when warnings are unticked, Save asks you to confirm first.

When you insert a user symbol, the Insert / Edit Component dialog shows the prompts it has beyond
the standard fields under **Other attributes**.

Buttons: **Make vertical** (opens the vertical variant), the **NO / NC twin**, **Save to
Library** (Ctrl+S in a symbol tab), **Save and Insert** (saves, returns to the drawing and
starts AECOMPONENT with the new symbol), **Export DXF...** (also Save As in a symbol tab) and
**Close**. Ctrl+Z undoes changes to the name, family, role and orientation like geometry.

### The user library

Saved symbols go to the user library and appear in the icon menu and tool palettes under
`User: <category>`. They insert with AECOMPONENT, AECHILD, AECOMPONENT3, AETOGGLENC and AESWAP
like built-in symbols. A drawing only contains the user symbols it uses.

- Desktop: `user-library.json` in the application data folder (see
  [Files](#11-files-dxf-dwg-projects-autosave)); one backup copy of the previous version is
  kept.
- Browser edition: stored in the browser.

In the icon menu, **Edit...** opens a chooser with a filter box and Edit, Rename...,
Delete from Library, Export JSON... and Import... buttons; right-click a user symbol to edit
or delete it. Command-line equivalents: `AESYMSAVE`, `AESYMCHECK`, `AESYMVERTICAL`,
`AESYMTWIN`, `AESYMTEXT2ATTR`, `AESYMRENAME old new`, `AESYMDELETE`, `AESYMLIBEXPORT`,
`AESYMLIBIMPORT` (each also without the `AE` prefix, for example `SYMSAVE`).

---

## 8. Catalogs and catalog packs

### Catalog Browser

`AECATALOG` (CATALOG, CATALOGBROWSER) opens the Catalog Browser for the selected component:
search by family and text and pick a part: its manufacturer, catalog number, assembly code and
rating are written into the selected component (and its description, when the component has
none yet). Parts come from three sources, searched in this order:

1. the **user catalog** named in the project properties (load one with `AECATALOGLOAD`,
   alias LOADCATALOG): a JSON array of `{family, mfg, cat, desc, rating, type, assycode}`;
2. installed **catalog packs**;
3. the built-in generic catalog (invented example parts).

The Source column shows where each part comes from.

### Catalog packs

Real manufacturer catalogs can be distributed as signed catalog packs (`*.jcadpack.json`).
A pack is issued to one buyer and names them.

- `AEPACKS` (PACKS, CATALOGPACKS), **Packs...** in the Catalog Browser, or **Project >
  Catalog Packs** opens the Catalog Packs dialog: installed packs with version, publisher,
  licensee, expiry, part count and status; **Install...** and **Remove**.
- `AEPACKINSTALL` (PACKINSTALL, INSTALLPACK) installs a pack file directly; `AEPACKLIST`
  (PACKLIST) lists installed packs in the command window.

JCad Electrical checks the pack's signature against the publisher keys built into the program.
Unsigned, edited or unknown packs are refused with a message. An expired pack keeps working
(you keep the data you paid for) but is marked as expired. Installed packs are checked again at
every start. Publishers: see [CATALOG-PACKS.md](CATALOG-PACKS.md) for how to build and sign
packs.

---

## 9. Plotting and printing

`PLOT` (PDF, Ctrl+P) and `PRINT` (PRINTDRAWING, Ctrl+Shift+P) open the same **Plot / Print**
dialog:

- **Paper size**: Fit to drawing (custom sheet), Letter 8.5 x 11 in, Legal 8.5 x 14 in,
  Tabloid / Ledger 11 x 17 in (ANSI B), ANSI C 17 x 22 in, ANSI D 22 x 34 in, ANSI E
  34 x 44 in, Arch C 18 x 24 in, Arch D 24 x 36 in, ISO A4, A3, A2, A1 and A0.
- **Orientation**: automatic, landscape or portrait.
- **Scale**: Fit to paper, 1:1 (drawing units = inches), 1:2, 1:4 or 2:1. A fixed scale that
  does not fit is reduced to fit, and the dialog says so.
- **Margins**.

The dialog shows the resulting sheet and scale. **Plot to PDF** writes a PDF file at the
chosen sheet size; **Print…** opens the system print dialog, where you choose the printer and
its paper (select the same paper size there). Your choices are remembered.

Output is a raster image of the drawing: lines print black, hidden (off or frozen) layers are
left out. If the current tab has nothing visible to plot, the dialog explains why and both
buttons are disabled.

---

## 10. Settings

### Options

`OPTIONS` (OP, CONFIG), File > Options, or the application menu. Changes apply immediately;
Cancel restores the previous values.

- **Display**: ribbon colour scheme, model space background, crosshair colour and size,
  whether the command window is shown, grid style and spacing, and the interface **Language**
  (System default, English or Español; the Spanish translation is partial and untranslated
  text stays English).
- **Drafting**: AutoSnap marker colour and size, aperture size (object snap target box).
- **Selection**: pickbox size, grip size, unselected and hover grip colours, selection effect,
  Quick Properties on selection, rollover tooltips.
- **Files**: automatic save on / off and the minutes between saves (default 10), the default
  symbol standard (JIC or IEC 60617), and a button to clear the recent file list.
- **Units**: length type (Decimal, Engineering, Architectural, Fractional), precision, the unit
  label shown in the status bar, and the status bar coordinate display. These only change how
  lengths are shown; the drawing's own units are set with `UNITS`.

### Drafting Settings

`DSETTINGS` (DS, SE, DDRMODES), or right-click a status bar toggle:

- **Snap and Grid**: snap on / off, snap spacing, grid on / off, grid spacing, grid style.
- **Polar Tracking**: on / off, increment angle and additional angles.
- **Object Snap**: on / off and the running modes, marker colour.
- **Dynamic Input**: on / off.
- **Drawing Units**: inches or millimetres for the drawing, with an optional rescale of the
  existing objects (see [Metric drawings](#metric-drawings)).

The drawing area follows the screen's pixel density, so lines and text stay sharp on high-DPI
displays and when the window moves to another monitor.

Settings are stored per user on this computer (in the browser edition, per browser).

---

## 11. Files: DXF, DWG, projects, autosave

### DXF

DXF (AutoCAD 2000 / AC1015) is JCad Electrical's native format. `SAVE` (QSAVE, Ctrl+S) and
`SAVEAS` (Ctrl+Shift+S) write DXF. Layers, linetypes, lineweights, blocks, attributes
(including invisible ones), dimensions, text, polylines with arcs and widths, and the
electrical data all round-trip, and the files open in other CAD programs. `OPEN` (Ctrl+O)
reads DXF and DWG files into a new tab; `NEW` (QNEW, Ctrl+N) starts an empty drawing.

Also kept in DXF: splines, hatches, leaders and multileaders, tables, images and external
references, fields, MTEXT formatting, text styles (including TrueType fonts) and the named
dimension styles with all their settings. Files written by programs before AutoCAD 2007 are
read in the code page they name (`$DWGCODEPAGE`), newer ones as UTF-8; the command line reports
the detected encoding. JCad Electrical writes AutoCAD 2000 DXF with any non-English characters
escaped, so the text reads correctly whatever the code page of the program that opens it.

### DWG

DWG files from release R14 up to 2018 open through **LibreDWG**. Supported: lines, arcs,
circles, polylines (with bulges), text and MTEXT, blocks and attributes, dimensions (with the
drawing's dimension variables), ellipses, points, construction lines, solids, splines, hatches,
leaders and multileaders, tables, images, linetypes, lineweights and header units / limits. The
command window lists anything that was skipped.

DWG is **read-only**: JCad Electrical cannot write DWG files. When you save a drawing that
was opened from a DWG, you are asked for a new file name and a DXF is written; the original
DWG is not changed. Most CAD programs, including AutoCAD, open DXF files and can save them
back as DWG if you need one.

### Recent files

`RECENT` opens a recent file by number; the application menu and File > Open Recent list
them. `CLEARRECENT` (File > Open Recent > Clear Recent) empties the list.

### Tabs

`CLOSE` (Ctrl+W, Ctrl+F4), `CLOSEALL`, `CLOSEALLOTHER`, `NEXTTAB` (Ctrl+Tab), `PREVTAB`
(Ctrl+Shift+Tab). Closing a changed drawing asks Save / Don't Save / Cancel.

### Autosave and recovery

Every changed drawing is written to the autosave folder every 10 minutes (change it in Options
> Files; `AUTOSAVE` writes now). If JCad Electrical closes without saving, the **Drawing
Recovery Manager** offers the backups at the next start: **Open** a drawing (it opens as an
unsaved copy and the backup is kept until you save it) or **Discard** it.

### Where files are kept

The desktop application keeps its data in the application data folder:

| System | Folder |
| --- | --- |
| Windows | `%APPDATA%\jcad-electrical` |
| macOS | `~/Library/Application Support/jcad-electrical` |
| Linux | `~/.config/jcad-electrical` |

It contains `autosave/`, `packs/` (catalog packs), `plugins/` (see
[Plugins and scripts](#15-plugins-and-scripts)), `user-library.json` (your symbols) and
`error.log` (crash log). The `PLUGINS` command prints the exact folder on your computer.

---

## 12. Updates

A few seconds after start-up JCad Electrical checks GitHub Releases for a newer version. You
can also check any time with **Help > Check for Updates…** or the `CHECKUPDATES` command
(UPDATE, CHECKFORUPDATES). Help > About shows the installed version.

- **Windows installer** and **Linux AppImage**: the update is downloaded when you agree and
  installed when the program restarts. Unsaved drawings are handled by the usual
  save prompt before the restart.
- **macOS** and **Linux .deb**: you are told that a new version exists and offered the right
  download; install it like the first time.

**Help > Release Notes (GitHub)** opens the releases page; the [changelog](../CHANGELOG.md)
lists the changes in every version.

---

## 13. Reporting problems and getting help

- **Help** (`HELP`, `?`, F1): a searchable list of every command with its aliases and
  description, the Keyboard Shortcuts tab and the About tab. `HELP shortcuts` opens the
  shortcuts directly.
- **Report a Problem** (`REPORTBUG`, BUGREPORT, REPORTPROBLEM; Help menu, ribbon Add-ins):
  describe the summary, what happened and the steps to reproduce. The report adds the
  version, platform, recent commands and any errors the program caught. Then choose **Open
  GitHub Issue** (a prefilled issue in your browser), **Copy Report**, or **Save Report…** (a
  text file, optionally with the current drawing as DXF, for e-mail). Nothing is sent
  automatically.
- **Send Feedback** (`FEEDBACK`, SENDFEEDBACK, FEATUREREQUEST): the feature request form on
  GitHub.
- **About** (`ABOUT`, the Support button): the version, the author, a donation link
  (`DONATE`, TIP, SUPPORT) and the licence with links to the GNU GPL v3 text and the
  third-party notices.

Links from the program only open pages of the project's GitHub repository (and the
donation page).

---

## 14. Keyboard shortcuts

| Keys | Action |
| --- | --- |
| F1 | Help |
| F2 | Text window (command history) |
| F3 | Object snap on / off |
| F7 | Grid on / off |
| F8 | Ortho on / off |
| F9 | Grid snap on / off |
| F10 | Polar tracking on / off |
| F11 | Object snap tracking on / off |
| F12 | Dynamic input on / off |
| Esc | Cancel the command / clear the selection |
| Enter / Space | Accept; on an empty command line repeat the last command |
| Up / Down (command line) | Previous / next typed input |
| Tab (command line) | Cycle AutoComplete suggestions |
| Ctrl+N | New drawing (new tab) |
| Ctrl+O | Open drawing |
| Ctrl+S | Save (in a symbol tab: save to the user library) |
| Ctrl+Shift+S | Save As |
| Ctrl+P | Plot / Print dialog (Plot to PDF) |
| Ctrl+Shift+P | Plot / Print dialog (Print) |
| Ctrl+Z | Undo (inside LINE, PLINE and AEWIRE: undo the last segment) |
| Ctrl+Y, Ctrl+Shift+Z | Redo |
| Ctrl+A | Select all |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy / cut / paste objects |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous drawing tab |
| Ctrl+W, Ctrl+F4 | Close the drawing tab |
| Ctrl+1 | Properties palette |
| Ctrl+3 | Tool Palettes |
| Ctrl+9 | Command window on / off |
| Ctrl+0 | Clean screen |
| Delete | Erase the selection |

On macOS, Cmd works wherever Ctrl is listed.

---

## 15. Plugins and scripts

Plugins add commands to JCad Electrical and can read and change the open drawing. They are
written in JavaScript against the `jcad` API; the full reference is
[PLUGIN-API.md](PLUGIN-API.md).

### Installing a plugin

1. Type `PLUGINS`. It lists the loaded plugins and prints the plugins folder (inside the
   application data folder; it is created the first time).
2. Copy the plugin's folder (a `plugin.json` and one main `.js` file) into that folder.
3. Type `PLUGINRELOAD` (or restart). The first time a plugin runs you are asked
   **Load plugin ... ? Plugins run with full access to your drawings.** Your answer is remembered
   until the plugin's code changes.
4. The plugin's commands now appear in Help and command completion and run like built-in ones.

In the browser edition, `PLUGINLOAD` opens a file picker: choose one `.js` file, or `plugin.json`
together with its main file. Such plugins last until the page is closed.

| Command | Aliases | What it does |
| --- | --- | --- |
| PLUGINS | PLUGINLIST | List plugins (version, status, commands, errors) and the folder; `PLUGINS Unload <name>`, `PLUGINS Forget [<name>]` (forget remembered answers) |
| PLUGINLOAD | LOADPLUGIN | Load a plugin folder by name (desktop), or pick plugin files |
| PLUGINRELOAD | | Reload one plugin by name, or all of them plus new folders |
| SCRIPTRUN | JSRUN, RUNSCRIPT | Pick a `.js` file and run it once against the API |

### What plugins can do

- register commands with prompts for text, points and selections;
- read and change entities, layers, blocks and the electrical data (components, wires,
  attributes, cross-references), with every change an undo step (Ctrl+Z works);
- show messages and dialogs, read a file you pick and save text files through the save dialog;
- react to events (drawing changed, selection changed, command started / ended, drawing opened);
- keep their own settings.

Plugins cannot use Node.js, read files you did not pick or connect to other web sites. Errors in a
plugin are printed on the command line as `[plugin-name] ...` and do not stop the program. Only
install plugins from people you trust.

### Examples

The `examples/plugins/` folder of the source repository has three plugins to copy:

- **hello**: `HELLO` (alias `HI`) prints how many objects are selected.
- **numbered-labels**: `NUMLABEL` (alias `NLABEL`) asks for a prefix and a first number, then
  places labels `M7`, `M8`, ... at the points you pick.
- **bom-summary**: `BOMSUMMARY` (alias `BOMSUM`) counts the components by manufacturer and
  catalog number, shows them in a table and offers **Save CSV...**.

A script for `SCRIPTRUN` is a single `.js` file using the same API, for example to move every
TEXT to a layer in one undo step. In the developer console the API is `window.jcadApi`.
