# JCad Electrical: manual QA checklist

Checks that need real machines, real printers, other CAD programs and a person looking at the
screen. Run them on release candidates before a version is announced. Everything the automated
suites already cover (listed below) is left out.

Written against JCad Electrical 0.4.1 plus the `[Unreleased]` changes in [CHANGELOG.md](../CHANGELOG.md).
AutoCAD, BricsCAD, FreeCAD, SolidWorks and Fusion are named only as compatibility references; JCad
Electrical is not affiliated with their makers.

## How to use this checklist

- Copy this file into the release issue (or print it) and tick each box that behaves as described.
- Every line is one check: **what to do → what you must see**. A line that starts with
  *Windows:*, *macOS:* or *Linux:* applies to that system only; the others apply to every platform
  you test.
- **Must pass before release**: a failure blocks the release (or needs a written decision and a line
  in the release notes). **Nice to verify**: run when time allows, always on a minor or major
  version; failures become issues.
- Record each failure with **Help > Report a Problem…** (`REPORTBUG`). Version and platform are
  included; command history, captured errors and private details require explicit opt-in.
  Local paths and drawing names are redacted by default. Inspect reports before attaching them.
- Note at the top of your copy: version, installer file name, date, tester, machine (CPU, RAM, GPU),
  OS name and build number, display scaling.
- App data folder (settings, `autosave/`, `plugins/`, `user-library.json`, `error.log`):
  Windows `%APPDATA%\jcad-electrical`, macOS `~/Library/Application Support/jcad-electrical`,
  Linux `~/.config/jcad-electrical`.

## Test machines

| Platform | Minimum for a release | Also good to have |
| --- | --- | --- |
| Windows | Windows 11 23H2 or later and Windows 10 22H2, x64, one at 150 % display scaling | Windows 11 on ARM (runs the x64 build emulated), a standard (non-admin) account, Smart App Control on |
| macOS | One Apple Silicon Mac (arm64 DMG) and one Intel Mac (x64 DMG), current macOS and the one before | A Retina laptop with an external non-Retina monitor |
| Linux | Ubuntu 24.04 (AppImage and .deb) and Ubuntu 22.04 (AppImage) | Debian 12 or Linux Mint (.deb), Fedora (AppImage), KDE Plasma, X11 and Wayland sessions |

Reference machine for the timings in [Large files](#11-large-files): 4-core CPU from 2018 or later,
8 GB RAM, SSD, integrated graphics.

## What automation already covers

Do not repeat these by hand; they run on every push (`.github/workflows/ci.yml`):

- Unit tests (geometry, DXF / DWG reading and writing, interchange reference files, reports, file
  safety), the type check and the renderer build.
- `npm run ui-check`: every command, ribbon button, menu entry, status-bar control and context-menu
  item in headless Chromium, failing on page errors.
- `scripts/e2e-electron.mjs` on Ubuntu, Windows and macOS (native
  dialogs and the network are stubbed): opening DXF / DWG, the Import Report, IMAGE bitmaps,
  RECENT, a Tabloid vector PDF parsed for page size and paths, a raster plot, a layout page, the
  updater's logic offline, the Symbol Builder, About, the unsaved-changes prompt, the Drawing
  Recovery Manager with migrated backups, temp-file-and-rename saves with `.bak`, a simulated failed
  save, an unreadable recovery folder.

The release pipeline also installs/extracts the packaged installers and drives them on their OS.
It verifies configured signatures, notarization or ad-hoc seals, binds all artifact checksums to
the tested SHA, and publishes a GitHub-signed provenance bundle. The normal unit and release
checks run Node 22 and 24; dense Node and browser performance budgets are gates.

Manual coverage below still includes quarantine / SmartScreen on downloaded files, real update
downloads and installation, printers and PDF viewer appearance, other CAD programs, display
scaling, monitors, real network shares, process termination, production-sized drawings and accessibility.

## Test files

- In the repository: `tests/fixtures/all-entities.dxf`, `acad-layouts.dxf`, `hatch.dxf`,
  `block-colors.dxf`, `interchange-reference.dxf`, `unsupported-content.dxf`, the damaged files in
  `tests/fixtures/broken/`, and `fixtures/example_r14.dwg` … `example_2018.dwg`.
- **QA drawing** (make it once per release and keep it with the results): `NEWSHEET` (ANSI B with
  title block), a ladder (`AELADDER`), wires (`AEWIRE`) with wire numbers, about ten components
  (`AECOMPONENT`) whose descriptions include `Señal Ø 24 V ±10 % µF`, one dimension of each kind,
  layers with DASHED, HIDDEN, CENTER and PHANTOM at lineweights 0.25, 0.50 and 0.70 mm, a hatch, an
  MTEXT with bold, colour and a stacked fraction, a TABLE, a LEADER and an MLEADER, and a layout with
  two viewports at 1:2 and 1:4 (`LAYOUTWIZARD`, `MVIEW`). Save it as `qa-drawing.dxf`.
- From another CAD program: a DXF that has an IMAGE (with its PNG next to it) and a text style using
  a TrueType font such as Arial; real project DWGs in 2000, 2007, 2013 and 2018 format, including at
  least one AutoCAD Electrical project drawing (with the `WD_M` block).
- Large drawings: see [Large files](#11-large-files) and [Appendix B](#appendix-b-making-a-large-drawing).

For an independent export check, run `npm run check:autocad` on Windows with licensed AutoCAD
Core Console installed. Set `JCAD_AUTOCAD_CONSOLE` if it is outside the default AutoCAD 2027 path;
`JCAD_AUTOCAD_OUT` can name a fresh empty folder. The script opens freshly exported regression
DXFs, requires `AUDIT` to report zero errors, saves a normalized DXF and checks reimported
entity types/counts. Logs and vendor outputs stay outside the repository. This validates those
exports only; it does not prove arbitrary AutoCAD drawing or semantic compatibility.

---

## 1. Windows 10 and 11

Download the installer with a browser (Edge or Chrome) so it carries the "downloaded from the
internet" mark; a copy from a USB stick or network share skips SmartScreen.

### Must pass before release

- [ ] Download `jcad-electrical-X.Y.Z-win-x64.exe` in Edge → download completes; a "isn't commonly downloaded" notice may appear for a new release (choose **Keep**), but never a malware or virus block.
- [ ] Check this release's `release-provenance.json`: if Windows is `authenticode-verified`, Properties > Digital Signatures shows the configured publisher and a valid timestamped signature. If it is `unsigned`, record that status; there is no publisher identity to verify.
- [ ] Run the installer → the displayed publisher agrees with the verified release status. Unsigned builds can show "Unknown publisher" and SmartScreen; signed builds can still show reputation warnings. **Run anyway**, when offered, continues.
- [ ] Installer runs → no UAC (administrator) prompt (per-user install), a short progress window, then JCad Electrical starts by itself.
- [ ] Start menu → entry **JCad Electrical** exists and starts the app; its icon and desktop shortcut show the schematic relay icon configured in `package.json`.
- [ ] First launch → window titled "JCad Electrical", ribbon, palettes, command line and dark model space; no error dialog, no error panel; the command line accepts `LINE`.
- [ ] Wait 10 s after start with the newest version installed → no update dialog appears.
- [ ] Help > About → version X.Y.Z, author, licence links (GPL v3 text and third-party notices open).
- [ ] Start JCad Electrical again from the Start menu while it is running (also while minimized) → no second window or taskbar button; the running window is restored and comes to the front.
- [ ] Open With for `.dxf` and `.jcadproj.json` offers JCad Electrical; choosing it opens the file in the running app. Existing default-app choices should be respected. `.dwg` is importable but is not registered as a file association.
- [ ] Close the window with an unsaved change (title-bar X, Alt+F4, and the taskbar's "Close window") → Save / Don't Save / Cancel prompt each time; Cancel keeps the app open.
- [ ] Settings > Apps > Installed apps → "JCad Electrical X.Y.Z" listed; **Uninstall** removes the program, Start menu entry and desktop shortcut, and leaves `%APPDATA%\jcad-electrical` (settings, autosave, user library) in place.
- [ ] Install again after the uninstall → recent files, Options and the user symbol library are still there.
- [ ] Repeat the install and first launch on both Windows 10 22H2 and Windows 11.

### Nice to verify

- [ ] Windows 11 with **Smart App Control** on → the signed installer and app run; if they are blocked ("Smart App Control blocked an app that may be unsafe"), record it.
- [ ] Install under a standard (non-admin) user account → installs and runs without asking for an administrator password.
- [ ] Windows 11 on ARM → the x64 build installs and runs under emulation; drawing, zoom and plotting work.
- [ ] Explorer > a `.dxf` > Open with > Choose another app > JCad Electrical → the app starts or comes to the front and opens the selected drawing.
- [ ] Third-party antivirus (any one) → no detection of the installer or `JCad Electrical.exe`; Defender real-time protection does not slow the first start by more than a few seconds.
- [ ] Sign out or shut down Windows with an unsaved drawing → record whether Windows shows "This app is preventing shutdown" and whether the drawing appears in the Drawing Recovery Manager at the next start.
- [ ] Pin JCad Electrical to the taskbar, update it (section 4), start it from the pin → the pin still starts the new version.

---

## 2. macOS (Apple Silicon and Intel)

Download the DMG with Safari or Chrome so it carries the quarantine flag (`xattr -l` on the file
shows `com.apple.quarantine`). Without the five Apple secrets the build is ad-hoc signed and needs
the one-time **Open Anyway**; with them it is Developer ID signed and notarized and opens after a
single confirmation. Check which kind the release is ([section 13](#13-release-sign-off-github-release-page)).

### Must pass before release

- [ ] Apple Silicon Mac: `jcad-electrical-X.Y.Z-mac-arm64.dmg`; Intel Mac: `jcad-electrical-X.Y.Z-mac-x64.dmg` → each DMG opens and shows **JCad Electrical** and an Applications link.
- [ ] Drag the app to Applications, eject the DMG, start it from Applications (ad-hoc build) → macOS 15: "“JCad Electrical” Not Opened. Apple could not verify “JCad Electrical” is free of malware…" with **Done** / Move to Trash; macOS 13–14: "cannot be opened because Apple cannot check it for malicious software" (or "…the developer cannot be verified"). Click Done / OK.
- [ ] The first-open message never says **"is damaged and can't be opened"** (that means the ad-hoc signature is missing).
- [ ] System Settings > Privacy & Security > Security → a line about JCad Electrical being blocked with **Open Anyway**; click it, confirm **Open Anyway** again, enter the password or use Touch ID → the app starts.
- [ ] Quit and start again → it starts directly, no prompt.
- [ ] Developer ID build (when signed): the first start shows only "“JCad Electrical” is an app downloaded from the Internet. Are you sure you want to open it?" with **Open**; no Privacy & Security step.
- [ ] Apple Silicon: Activity Monitor > CPU, column **Kind** → "Apple" for the arm64 build (not "Intel").
- [ ] First launch → main window with ribbon, command line and model space; menu bar shows a **JCad Electrical** app menu with About and Quit.
- [ ] Cmd+N, Cmd+O, Cmd+S, Cmd+Shift+S, Cmd+P, Cmd+Z, Cmd+Y → same as the Ctrl shortcuts in the manual.
- [ ] Open the app again from Launchpad or Finder while it runs → no second Dock icon or window; the running window comes to the front.
- [ ] Close the window with the red button → the app stays in the Dock; clicking the Dock icon opens a new window; Cmd+Q with an unsaved drawing asks Save / Don't Save / Cancel.
- [ ] Double-click a `.dxf` in Finder → it opens in its previous default app (JCad Electrical registers no file types).
- [ ] Delete the app from Applications → `~/Library/Application Support/jcad-electrical` stays; reinstalling brings back recent files and settings.

### Nice to verify

- [ ] Intel DMG on an Apple Silicon Mac → macOS offers to install Rosetta; the app runs; Check for Updates offers the x64 DMG.
- [ ] Drag a `.dxf` or `.jcadproj.json` onto the Dock icon → the app opens the selected file and comes to the front.
- [ ] Full-screen mode (green button) and a second Space → ribbon, dialogs and the Plot dialog appear on the full-screen window, not on another Space.
- [ ] macOS dark and light appearance → the application keeps its own dark workspace; native dialogs follow the system.
- [ ] `spctl --assess --type execute --verbose=4 "/Applications/JCad Electrical.app"` on an ad-hoc build → "rejected" (expected); on a Developer ID build → "accepted, source=Notarized Developer ID".

---

## 3. Linux (AppImage and .deb)

### Must pass before release

- [ ] Ubuntu 22.04: `chmod +x jcad-electrical-X.Y.Z-linux-x86_64.AppImage` and run it → the app starts; without the `libfuse2` package the message names FUSE ("AppImages require FUSE to run"), and after `sudo apt install libfuse2` it starts.
- [ ] Ubuntu 24.04 (package `libfuse2t64`) → the AppImage starts without `--no-sandbox`; if it stops with "The SUID sandbox helper binary was found, but is not configured correctly", record it as a release blocker or a documented workaround.
- [ ] Files (Nautilus) > the AppImage > Properties > "Executable as Program", then double-click → the app starts.
- [ ] `sudo apt install ./jcad-electrical-X.Y.Z-linux-amd64.deb` on Ubuntu 24.04 and 22.04 → installs without dependency errors; **JCad Electrical** appears in the application grid and starts from there and as `jcad-electrical` in a terminal.
- [ ] `.deb` over the previous version (`sudo apt install ./…` of the new one) → upgrades in place; recent files and settings in `~/.config/jcad-electrical` are kept.
- [ ] `sudo apt remove jcad-electrical` → the menu entry and program are removed; `~/.config/jcad-electrical` stays.
- [ ] First launch (AppImage and .deb) → main window, ribbon, command line; no error dialog; the command line takes keyboard input in both an X11 and a Wayland session.
- [ ] Start the AppImage (or `jcad-electrical`) a second time while it runs → no second window; the running window is raised or GNOME shows a "JCad Electrical is ready" notification that focuses it.
- [ ] Double-click a `.dxf` in Files → it opens in the previous default application (JCad Electrical registers no file types).

### Nice to verify

- [ ] Debian 12 or Linux Mint 22 (.deb) and Fedora 40 or later (AppImage) → install and first launch as above.
- [ ] KDE Plasma → menus, dialogs and the native file dialog work; the window icon and title are right.
- [ ] AppImageLauncher (if installed) integrates the AppImage → menu entry starts it; an update (section 4) keeps the entry working.
- [ ] AppImage stored on a `noexec` mount → a clear "permission denied" from the shell; record the message.
- [ ] Native file dialogs → GTK dialog on GNOME, KDE dialog on Plasma (through the portal); both open and save drawings.

---

## 4. Auto-update from the previous release

Install the **previous** release (for example v0.4.0 from the releases page), make sure the new
release is published (not a draft, not a pre-release), then start the old version. The start-up
check runs about 8 s after launch; **Help > Check for Updates…** (`CHECKUPDATES`) checks at once.
Only a Windows installation with a trusted `publisherName` in its packaged update configuration
offers in-place updates. Unsigned Windows builds, macOS, AppImage and .deb offer manual downloads.
Run the Windows download/restart checks below only for signed builds; on other installations,
verify that Download opens the release asset without offering automatic installation.

Where to look when something goes wrong: the dialog text (copy it; the updater's own log is turned
off), the command-line history (**F2**), `error.log` in the app data folder, and the downloaded
installer in the updater cache (usually `%LOCALAPPDATA%\jcad-electrical-updater\pending\` on
Windows, `~/.cache/jcad-electrical-updater/pending/` on Linux).

### Must pass before release

- [ ] Windows: start the old version → "Update Available": "JCad Electrical X.Y.Z is available (you have A.B.C)." with **Download** / Later, and the release notes below it; the command line logs "A newer JCad Electrical (X.Y.Z) is available."
- [ ] Windows: **Download** → the command line logs "Downloading update: 0%" … "75%", then "Update Ready: JCad Electrical X.Y.Z has been downloaded." with **Restart Now** / Later.
- [ ] Windows: **Restart Now** with an unsaved drawing open → the Save / Don't Save / Cancel prompt comes first; Cancel keeps the app running and nothing is installed.
- [ ] Windows: **Restart Now** after saving → the app closes, the installer runs without SmartScreen or UAC, the app restarts by itself; Help > About shows X.Y.Z.
- [ ] Windows: **Later** in "Update Ready", then quit normally → the next start runs X.Y.Z (installed on quit).
- [ ] Windows: no error "New version X.Y.Z is not signed by the application owner" (signer of the new build must equal the old build's publisher).
- [ ] AppImage: Download opens the matching release asset; replace the executable manually and verify X.Y.Z after restart. No in-place update is offered.
- [ ] macOS: "Update Available" with **Download** / Release Notes / Later and the text "Download the new disk image, drag the app to Applications to replace this one, then open it once through System Settings > Privacy & Security > Open Anyway." → **Download** opens the DMG for this Mac's architecture (arm64 or x64) in the browser.
- [ ] macOS: replace the app in Applications with the new one → Open Anyway is asked once more (ad-hoc builds), then About shows X.Y.Z.
- [ ] .deb: "Update Available" with "Download and install the new package over this one; your settings and drawings are kept." → **Download** opens the `.deb` download; `sudo apt install ./…` upgrades.
- [ ] After every update: recent files, Options, window position, the user symbol library and catalog packs are unchanged; an autosave backup made before the update is still offered by the Drawing Recovery Manager.
- [ ] Help > Check for Updates on the new version → "JCad Electrical X.Y.Z is up to date."
- [ ] Network off, Help > Check for Updates → "Could not check for updates." with **Open Releases Page** / Close; the silent start-up check offline shows nothing.

### Nice to verify

- [ ] Windows: Task Manager > Performance > network during Download → the download is smaller than the full installer when only a few blocks changed (blockmap differential download); a full download is also acceptable.
- [ ] Update across two versions (A.B.C to the newest, skipping one) → offered and installed in one step.
- [ ] Behind a corporate proxy (system proxy settings) → the check works or fails with the "Could not check for updates." dialog, never a hang.
- [ ] Release Notes button (macOS / .deb dialog) → opens the release page on github.com/habit04/share.
- [ ] Downloading, then pulling the network cable → an error dialog names the failure; the old version keeps working; a later check downloads again.

---

## 5. Real printers and PDF viewers

Use the QA drawing. **Plot** is `PLOT` (Ctrl+P, "Plot to PDF"), **Print** is `PRINT` (Ctrl+Shift+P,
system print dialog). Open each PDF in Adobe Acrobat Reader, Chrome (or Edge), macOS Preview and,
on Linux, Document Viewer (Evince) or Okular. In Acrobat, turn on View > Display > Show Line
Weights (wording varies by version) before judging lineweights.

### Must pass before release

- [ ] Plot the Model tab: Tabloid 11 x 17 in, landscape, Fit to paper, Vector, monochrome → the PDF opens in Acrobat without "There was an error processing a page" or a repair prompt; File > Properties shows 17 x 11 in.
- [ ] Same PDF in Chrome, Preview and Evince → identical content, no missing objects, nothing outside the page.
- [ ] Dashed linetypes (DASHED, HIDDEN, CENTER, PHANTOM) → visible as dashes with the right pattern at 100 % and 400 % zoom, not solid lines and not dots; longer dashes for a larger LTSCALE.
- [ ] Plot object lineweights on → 0.25, 0.50 and 0.70 mm lines are visibly different and of even width along each line; with the option off → all lines thin.
- [ ] Stroke-font text (title block, tags, wire numbers) → sharp at 800 % zoom, inside its title-block cells, same position as on screen; `Ø`, `°`, `±` from `%%c`, `%%d`, `%%p` and `ñ`, `µ` render.
- [ ] TrueType-style text (from the other-CAD DXF) → selectable and found by Ctrl+F in Acrobat and Chrome.
- [ ] Hatches, filled junction dots, solids and wide polylines → filled, no hairline gaps at normal zoom; the embedded image appears at its place and size.
- [ ] Page sizes: plot to Letter, ANSI D, ISO A3 and A1 → viewer page sizes 8.5 x 11 in, 34 x 22 in (landscape), 420 x 297 mm, 841 x 594 mm (or portrait equivalents as chosen).
- [ ] Scale 1:1 (a 10 in line in the drawing) → measures 10 in with Acrobat's Measure tool (and on paper, see below).
- [ ] What to plot = All layouts → one page per layout, each with its own paper size and orientation from its page setup.
- [ ] Hidden (off / frozen) layers and layers marked not to plot → absent from the PDF.
- [ ] Plot styles: grayscale, acad.ctb (object colours) and screening 50 % → greys, colours and lighter ink as chosen.
- [ ] Raster image output → a sharp enough picture of the same sheet (text readable at 200 %), correct page size.
- [ ] Print to a real laser or inkjet printer (Letter or A4): choose the printer and the same paper in the system dialog → orientation right, nothing cut off except the printer's own margins, lines and text sharp, dashes visible.
- [ ] Printed 1:1 sheet → a 5 in line measures 5 in with a ruler (± 1 %).
- [ ] Cancel the system print dialog → no error, the app stays usable, nothing printed.

### Nice to verify

- [ ] Windows: Print to "Microsoft Print to PDF"; macOS: print dialog > PDF > Save as PDF; Linux: "Print to File (PDF)" → the result matches the plotted PDF in layout and scale.
- [ ] A Tabloid / A3 printer or a large-format plotter (ANSI D, A1) → full sheet, scale 1:1 within 0.5 %.
- [ ] Printer driver paper set to A4 while the drawing is Letter → record what is printed (scaled, clipped) so the manual can say it.
- [ ] Firefox's PDF viewer and Okular → same as Chrome.
- [ ] Acrobat: Edit > Preferences > Page Display > "Enhance thin lines" on and off → thin lines readable either way.
- [ ] Plot a sheet with 500+ components → PDF under 10 MB and opens in Acrobat in under 5 s.

---

## 6. Interchange with other CAD programs

What must survive is listed in [README.md, File formats](../README.md#file-formats) and the user
manual ([DXF](USER-MANUAL.md#dxf), [DWG](USER-MANUAL.md#dwg)): JCad Electrical writes AutoCAD 2000
(AC1015) DXF and reads DWG R14 to 2018. Save the QA drawing as DXF and open it elsewhere.

### Must pass before release

- [ ] AutoCAD (2018 or later, full or LT): open `qa-drawing.dxf` → opens with no recovery prompt and no errors on the command line; `AUDIT` (Fix: No) reports 0 errors.
- [ ] AutoCAD: layers → same names, colours, linetypes, lineweights and on / frozen / locked states as JCad's LAYER dialog.
- [ ] AutoCAD: components are blocks with attributes → double-click shows TAG1, DESC1–3, MFG, CAT, LOC, INST values; invisible attributes stay invisible until `ATTDISP ON`.
- [ ] AutoCAD: dimensions → arrows, extension lines and text where JCad drew them; the dimension style names exist in DIMSTYLE.
- [ ] AutoCAD: polylines with arcs and widths, filled wire junction dots, splines, hatches (pattern and scale), leaders and multileaders → look as in JCad.
- [ ] AutoCAD: text → same height and position; MTEXT bold, colour and stacked fraction kept; `Señal Ø 24 V ±10 % µF` reads correctly (no `?` or `\U+` codes).
- [ ] AutoCAD: dashed linetypes → same dash lengths as in JCad at the same LTSCALE.
- [ ] AutoCAD: layout tabs → each JCad layout is a tab with its paper size and the viewports at 1:2 and 1:4.
- [ ] AutoCAD: a JCad TABLE → shown as a block insert with the cell text (not an editable table: expected); reopened in JCad it is a table again.
- [ ] AutoCAD: save the DXF as DWG 2018, open that DWG in JCad → same objects, layers and layouts; the Import Report lists only what the DWG reader documents as unsupported.
- [ ] BricsCAD: open `qa-drawing.dxf` → no errors; `AUDIT` 0 errors; layers, blocks with attributes, dimensions and layouts as in AutoCAD.
- [ ] Real project DWGs (2000, 2007, 2013, 2018 formats) → open in JCad; compare with the source program side by side: no missing geometry beyond the Import Report; text, dimensions and hatches in place.
- [ ] An AutoCAD Electrical project drawing (with `WD_M`) → opens; components show their tags in reports (`AEREPORT components`) and the Project Manager.
- [ ] A DXF made in another program with an IMAGE and an Arial text style → the image shows (PNG next to the file), the text uses the TrueType font; Save then reopen in that program → image path and style kept.

### Nice to verify

- [ ] FreeCAD (Draft workbench, DXF import) → lines, arcs, polylines, circles and text come in at the right size; record what happens to dimensions and hatches.
- [ ] SolidWorks (open DXF as a 2D sketch or drawing) → geometry at the right units (inch or mm, `$INSUNITS`).
- [ ] Fusion (Insert > Insert DXF into a sketch) → lines, arcs and circles at the right size; text may be dropped (record).
- [ ] LibreCAD or QCAD → opens; layers and blocks visible.
- [ ] AutoCAD Electrical (if available) → JCad components are recognised (Edit Component shows tag, description, catalog data).
- [ ] DWG from the other program with xrefs → xrefs drawn as named frames; saving writes them back as references.
- [ ] Mirrored and non-uniformly scaled blocks → same in JCad and in AutoCAD after a round trip.
- [ ] DXF from a Windows-1252 or Shift-JIS program (pre-2007 DXF with `$DWGCODEPAGE`) → accented or Japanese text correct; the command line names the detected encoding.

---

## 7. HiDPI and multiple monitors

### Must pass before release

- [ ] Windows at 100 %, 125 %, 150 % and 200 % (Settings > Display > Scale) → ribbon icons and labels sharp, nothing clipped; drawing lines and text crisp, not blurred.
- [ ] At 150 % → the crosshair sits exactly under the mouse pointer; clicking a line endpoint with ENDpoint snap picks that endpoint; grips are picked where they are drawn.
- [ ] Two monitors at different scaling (100 % and 150 %): drag the window from one to the other → the drawing redraws sharp right away, the UI rescales, crosshair and snaps stay aligned.
- [ ] Maximize on the second monitor, quit, start again → the window opens maximized on that monitor.
- [ ] Unplug the second monitor (or set "Show only on 1"), start the app → the window opens fully on the remaining monitor, not off-screen.
- [ ] macOS: Retina display and a non-Retina external display → sharp on Retina; moving between them redraws at the right sharpness.
- [ ] Dialogs (Options, Plot, Layer, Drawing Recovery Manager) and native Open / Save dialogs → open over the main window on the monitor it is on.

### Nice to verify

- [ ] 4K monitor at 100 % → everything usable, if small; at 300 % (or a 5K Mac display) → sharp.
- [ ] Window spanning two monitors with different scaling → no crash; record any blur on one side.
- [ ] Linux GNOME Wayland with fractional scaling 125 % → usable; record whether the UI is blurry (Electron under XWayland).
- [ ] Linux X11 at 200 % (GNOME "Scale") → UI at double size, sharp.
- [ ] Change the scaling while the app runs → the next redraw adapts without a restart.
- [ ] Laptop lid closed with an external monitor, then reopened → the window stays visible.

---

## 8. Non-ASCII paths and user names

### Must pass before release

- [ ] Windows user account whose name has accents or CJK characters (for example `José Müller` or `张伟`, so the profile is `C:\Users\José Müller`) → install, first launch, autosave, recent files, the user symbol library and `PLUGINS` (prints the folder) all work.
- [ ] Open, save, Save As and plot in `Documents\Proyectos\Señalización – Línea 2\tablero ñ.dxf` → all succeed; the tab, title bar and Recent list show the name correctly; RECENT reopens it.
- [ ] Same in a folder named `図面` with a file `配電盤.dxf` → succeeds.
- [ ] Open a DWG from a non-ASCII folder → opens (the DWG reader gets the path right).
- [ ] Save over an existing file in such a folder → `tablero ñ.dxf.bak` is created next to it and opens.
- [ ] Plot to `Planos\Esquema eléctrico.pdf` → the PDF is written and opens.
- [ ] macOS: a folder and file named with accents created in Finder (`Señal.dxf`) → open, save, and reopen from Recent.

### Nice to verify

- [ ] Emoji in a folder name (`Projects 🔌`) → open and save work.
- [ ] Windows path longer than 260 characters → save works, or the message says "the path is too long. Choose a shorter folder or file name."
- [ ] Windows "Beta: Use Unicode UTF-8 for worldwide language support" on → same non-ASCII checks pass.
- [ ] Linux with `LANG=C` (no UTF-8 locale) → non-ASCII file names still open and save; record any garbling.
- [ ] Japanese or Chinese IME typing at the command line and in the component dialog → characters arrive; the text shows (Hershey font may draw `?` for characters it lacks: record).

---

## 9. Network drives and read-only folders

Save errors open a dialog with the reason and **Retry**, **Save As...** and **Cancel**; the drawing
stays modified and its autosave backup is kept. Messages start with `"<name>" could not be saved:`
followed by the reason quoted below.

### Must pass before release

- [ ] Windows: open and save a drawing on a mapped drive (`Z:\`) and on a UNC path (`\\server\share\…`) → both work; `.bak` appears next to the file; RECENT reopens both.
- [ ] Save over a read-only file (Windows Properties > Read-only; macOS Get Info > Locked; Linux `chmod 444`) → "…you do not have permission to write to "<folder>", or the file is read-only or open in another program. Choose another folder or check the file's permissions." Save As to another folder works.
- [ ] Save As into a folder you cannot write to (Linux / macOS `chmod 555`, Windows `C:\Program Files`) → the same permission message; nothing written there.
- [ ] Save to a read-only network share → the permission message or "…is on a read-only drive or share. Choose another folder."
- [ ] Windows: lock the file (PowerShell: `$f = [IO.File]::Open('Z:\test.dxf','Open','ReadWrite','None')`), then Save → "…the file is locked by another program (open elsewhere, or being synced or virus-scanned). Close it there and try again."; `$f.Close()` then **Retry** → saved.
- [ ] Disconnect the network (Wi-Fi off or cable out) and save to the share → "…"<folder>" is not available. It may have been moved or deleted, or the network or removable drive is disconnected." after the system gives up (record how long); reconnect, **Retry** → saved.
- [ ] Remove a USB stick holding the open drawing, then save → the same "is not available" message; **Save As...** to the local disk works.
- [ ] After any failed save → the tab still shows the drawing as modified; kill the app → the Drawing Recovery Manager offers the drawing at the next start.
- [ ] Open a DXF and a DWG from a read-only share → both open; saving the DXF there fails with a message and Save As works; saving the DWG asks for a new name (DWG is read-only).

### Nice to verify

- [ ] A small USB stick or disk image filled to the last few KB → "…there is not enough free space on the disk. Free some space or choose another drive."; the original file is unchanged.
- [ ] Windows Security > Ransomware protection > Controlled folder access on, save into Documents → record the message (expected: the permission message) and whether Windows offers to allow the app.
- [ ] OneDrive-backed Documents (Windows 11 default) → save works; a cloud-only file (Files On-Demand) opens after downloading.
- [ ] macOS SMB share (`/Volumes/…`) and Linux SMB through GNOME Files (`/run/user/<id>/gvfs/…`) → open and save work.
- [ ] A project (`*.jcadproj.json`) and its drawings on a network share → project-wide tools (titles, wire numbers) update the drawings there and write `.bak` copies.
- [ ] Network share that answers slowly (Wi-Fi far from the router) → saving shows no partial file; the app does not freeze for more than the OS timeout.

---

## 10. Crash recovery

To force a crash: Windows Task Manager > End task, or `taskkill /F /IM "JCad Electrical.exe"`;
macOS Activity Monitor > Force Quit, or `pkill -9 -f "JCad Electrical"`; Linux
`pkill -9 -f jcad-electrical`. Set **Options > Files** autosave to 1 minute for these tests (or run
`AUTOSAVE` before killing).

### Must pass before release

- [ ] Draw something in a never-saved drawing, wait for autosave, kill the app, start it → **Drawing Recovery Manager** opens: "The following drawings were autosaved and not saved afterwards…", a row with the title, "(never saved)" and "autosaved <date and time>", buttons **Open**, **Discard**, **Discard All**, **Close**.
- [ ] Same with a drawing opened from disk → the row shows its original path.
- [ ] **Open** → the drawing opens with the autosaved content as a modified, unsaved tab; the command line says "Recovered <title> from autosave (N entities). Use SAVE to keep it; the backup is kept until then."
- [ ] Kill again before saving the recovered drawing → it is offered again at the next start.
- [ ] Save the recovered drawing, quit normally, start → no recovery dialog.
- [ ] Two modified drawings in tabs, kill → both are listed, each opens with its own content.
- [ ] **Discard** one → only that row disappears; **Discard All** → the listed backups are deleted, a drawing opened from the list keeps its backup.
- [ ] Kill during a save over an existing large drawing (about 20 MB, see Appendix B) → after restart the drawing opens complete (old or new content, never cut off); `<name>.bak` opens; a leftover `<name>.~<random>.tmp` may exist and can be deleted.
- [ ] Kill during autosave → at the next start the backup opens (previous or new autosave), never an empty or broken drawing.

### Nice to verify

- [ ] Kill during PLOT → no PDF under the final name, or a complete one; the app restarts normally.
- [ ] Virtual machine hard reset (power off) right after a save → the saved file and its `.bak` are both complete.
- [ ] Windows Task Manager > Details: end one of the child `JCad Electrical.exe` processes (the renderer) → record what the window shows; `error.log` gets a `render-process-gone` line; the next start offers recovery.
- [ ] `DRAWINGRECOVERY` (`DRM`) during a session with no backups → "Drawing Recovery Manager: no autosaved drawings to recover."
- [ ] Help > Report a Problem after a crash → the report includes the version and platform; **Save Report…** works so it can be sent with `error.log` from the app data folder.

---

## 11. Large files

Targets are for the reference machine (see [Test machines](#test-machines)); measure with a
stopwatch from the click until the drawing is shown and the app responds. More than twice a target
is a failure; between the target and twice the target, record it and file an issue. Make the
drawings with [Appendix B](#appendix-b-making-a-large-drawing) or use real project files.

| Drawing | Size (about) | Open | Save | Vector PDF plot |
| --- | --- | --- | --- | --- |
| 10 000 entities DXF | 2 MB | 2 s | 1 s | 3 s |
| 100 000 entities DXF | 20 MB | 10 s | 5 s | 20 s |
| 500 000 entities DXF | 100 MB | 60 s | 25 s | — |
| Real DWG, 10 MB | 10 MB | 10 s | 5 s (as DXF) | 15 s |
| Real DWG, 50 MB | 50 MB | 60 s | 25 s (as DXF) | — |

### Must pass before release

- [ ] Open the 10 000 and 100 000 entity drawings → within the targets; Windows never shows "Not responding" in the title bar for the 10 000 one.
- [ ] Open a real 10 MB DWG → within the target; the Import Report (if any) opens.
- [ ] 100 000 entities: wheel zoom and middle-drag pan → each zoom step answers within about 0.2 s; panning follows the mouse without stopping for more than 0.5 s.
- [ ] 100 000 entities: window selection of about 10 000 objects → highlighted within 1 s; Delete then Ctrl+Z → back within 3 s.
- [ ] 100 000 entities: SAVE and a vector PDF plot (Tabloid) → within the targets; the PDF opens in Acrobat in under 10 s.
- [ ] Autosave of the 100 000 entity drawing (1 minute interval) → typing at the command line is not blocked for more than 1 s while it writes.
- [ ] 500 000 entities → opens within the target or fails with a message; the app never quits or turns into a white window.

### Nice to verify

- [ ] Memory (Task Manager / Activity Monitor) with the 100 000 entity drawing → under 2 GB.
- [ ] A 50 MB real DWG → within the target.
- [ ] Ten 10 000 entity drawings open in tabs → Ctrl+Tab switches within 1 s each.
- [ ] Reports (BOM, wire list) on a 30-drawing project → finish within 30 s.
- [ ] IMAGE referencing a 60 MB bitmap (over the 50 MB limit) → the frame and file name are drawn, no crash.

---

## 12. Accessibility basics

### Must pass before release

- [ ] Keyboard only (mouse unplugged): start, type `LINE`, coordinates, Enter; `CIRCLE`; Ctrl+S, type a name in the Save dialog, Enter → a drawing is made and saved without the mouse.
- [ ] Every dialog opened from the command line (`OPTIONS`, `LAYER`, `PLOT`, `HELP`, `DRM`, `AECOMPONENT`'s Insert / Edit Component) → Tab moves through the controls in reading order, Enter runs the default button, Esc closes it.
- [ ] Focus → a visible focus ring on the button or field that has the keyboard focus, in every dialog.
- [ ] F1 help, F2 text window, F3 / F7 / F8 / F9 / F12 toggles and the Ctrl shortcuts in the manual → each works and the status bar shows the change.
- [ ] Windows / Linux: Alt (or Alt+F) opens the native menu bar; arrow keys and Enter run menu entries.
- [ ] Contrast (Colour Contrast Analyser or similar) → command-line text, status-bar labels, ribbon labels and dialog text at least 4.5 : 1 against their background; disabled buttons look different from enabled ones.

### Nice to verify

- [ ] Windows contrast theme (Settings > Accessibility > Contrast themes) → text and borders stay visible; record anything that disappears.
- [ ] Narrator, VoiceOver or Orca → dialog titles and button names are read out; record unlabeled controls.
- [ ] macOS: System Settings > Keyboard > Keyboard navigation on → Tab reaches the buttons of dialogs.
- [ ] Windows: F10 → JCad uses F10 for polar tracking; record whether the menu bar also activates.
- [ ] Colour vision: wire, selection (blue / green window) and grip colours stay distinguishable in a colour-blindness simulator.
- [ ] Options > Display > Language > Español → the partial Spanish translation shows; untranslated text falls back to English; nothing is cut off; switching back to English works.

---

## 13. Release sign-off (GitHub release page)

On <https://github.com/habit04/share/releases> for tag `vX.Y.Z`. The previous release (v0.4.0) had
these sizes for comparison: `.exe` 82 MB, arm64 `.dmg` 101 MB, x64 `.dmg` 108 MB, `.AppImage` 111 MB,
`.deb` 87 MB.

### Must pass before release

- [ ] Tag `vX.Y.Z` equals `package.json` `version` and the `## [X.Y.Z] - date` heading in CHANGELOG.md; `[Unreleased]` is empty or only holds later work.
- [ ] Actions > **Build installers** run for the tag → all jobs green (Windows, macOS, Linux build and release).
- [ ] Release title "JCad Electrical vX.Y.Z"; not a draft, not a pre-release; marked **Latest**.
- [ ] All five installers are present: Windows x64 NSIS, macOS arm64 and x64 DMGs, Linux x86_64 AppImage and amd64 deb. Metadata/blockmaps produced by the builder are included, together with three platform provenance records, `release-provenance.json`, `SHA256SUMS.txt` and `release-provenance.sigstore.json`.
- [ ] Asset sizes within about 15 % of the previous release (a much smaller file usually means something was left out).
- [ ] `latest.yml` (open it in the browser) → `version: X.Y.Z`; `path` and `files[0].url` are `jcad-electrical-X.Y.Z-win-x64.exe`; `size` equals the asset size; `releaseDate` is today.
- [ ] `latest.yml` `sha512` equals the downloaded `.exe` ([Appendix A](#appendix-a-verification-commands)); the same for `latest-linux.yml` and the AppImage.
- [ ] `latest-mac.yml` → `version: X.Y.Z` and the DMG names of this release.
- [ ] Windows signature status agrees with provenance: a configured signed release has Status `Valid` for installer and installed executable and the expected publisher; an unsigned release is described as unsigned.
- [ ] macOS: `codesign --verify --deep --strict --verbose=2 "/Applications/JCad Electrical.app"` passes; `codesign -dv` shows `Signature=adhoc` (ad-hoc build) or `Authority=Developer ID Application: …` plus `xcrun stapler validate` "The validate action worked!" (signed build). Write down which kind it is.
- [ ] Linux: `dpkg-deb -I jcad-electrical-X.Y.Z-linux-amd64.deb` → Package `jcad-electrical`, Version `X.Y.Z`.
- [ ] Release notes contain the X.Y.Z CHANGELOG section, the exact tested source SHA and the signing status recorded from the verified platform builds.
- [ ] One fresh install per platform and a supported signed-Windows update (or manual replacement on the other builds) succeed using the published assets.
- [ ] Verify `release-provenance.json` and each downloaded installer with `gh attestation verify <file> --repo habit04/share --bundle release-provenance.sigstore.json`; their SHA-256 values also match `SHA256SUMS.txt`.
- [ ] Website <https://habit04.github.io/share/> → download buttons point at the X.Y.Z files (allow up to 30 minutes for caches).

### Nice to verify

- [ ] Browser edition (`https://habit04.github.io/share/app/`) → About shows the new version after the Pages deployment.
- [ ] The **Download tracker** issue gets a comment within about an hour of the first download.
- [ ] VirusTotal scan of the `.exe` → no or only generic low-reputation detections; record them.
- [ ] Windows SmartScreen on a second, clean machine a few days after release → record whether the warning is gone (reputation).

---

## Appendix A: verification commands

```powershell
# Windows (PowerShell): signature and the sha512 that latest.yml lists
Get-AuthenticodeSignature .\jcad-electrical-X.Y.Z-win-x64.exe | Format-List Status, SignerCertificate, TimeStamperCertificate
[Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes("$PWD\jcad-electrical-X.Y.Z-win-x64.exe")))
```

```bash
# macOS / Linux: the sha512 in latest*.yml is base64, not hex
shasum -a 512 -b jcad-electrical-X.Y.Z-linux-x86_64.AppImage | cut -d' ' -f1 | xxd -r -p | base64
# macOS signature
codesign --verify --deep --strict --verbose=2 "/Applications/JCad Electrical.app"
codesign -dv --verbose=4 "/Applications/JCad Electrical.app" 2>&1 | grep -E 'Signature|Authority|TeamIdentifier'
spctl --assess --type execute --verbose=4 "/Applications/JCad Electrical.app"
xattr -l ~/Downloads/jcad-electrical-X.Y.Z-mac-arm64.dmg      # com.apple.quarantine present after a browser download
```

More on signing: [CODE-SIGNING.md](CODE-SIGNING.md).

## Appendix B: making a large drawing

Save this as `big-drawing.js`, start a new drawing and run `SCRIPTRUN` on it (it asks once before
running, like a plugin). Change `ROWS` for the size: 2 000 rows give about 10 000 entities, 20 000
about 100 000, 100 000 about 500 000. Then `ZOOM E` and save as DXF.

```js
// big-drawing.js: ladder-like rows of lines, circles and text, in one undo step.
const ROWS = 20000;
const PER_COLUMN = 500;
jcad.document.transact(() => {
  const items = [];
  for (let i = 0; i < ROWS; i++) {
    const x = Math.floor(i / PER_COLUMN) * 14;
    const y = -(i % PER_COLUMN) * 0.5;
    items.push(
      { type: 'line', a: { x, y }, b: { x: x + 4, y } },
      { type: 'circle', center: { x: x + 4.25, y }, radius: 0.25 },
      { type: 'line', a: { x: x + 4.5, y }, b: { x: x + 9, y } },
      { type: 'line', a: { x: x + 9, y: y - 0.2 }, b: { x: x + 9, y: y + 0.2 } },
      { type: 'text', position: { x: x + 9.5, y: y - 0.06 }, text: `CR${i + 1} Señal`, height: 0.125 },
    );
  }
  jcad.document.add(items);
});
jcad.ui.log(`${ROWS * 5} entities added.`);
```
