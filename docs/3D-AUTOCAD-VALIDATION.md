# 3D output: independent AutoCAD validation

`npm run check:autocad:3d` (`scripts/check-autocad-3d.mjs`) opens JCad Electrical's 3D DXF
output in the AutoCAD Core Console, lets AutoCAD audit, enumerate, measure and re-save it, and
compares what AutoCAD reports, and what JCad reads back from AutoCAD's files, with what JCad wrote.
It complements `npm run check:autocad` (2D exports, see [QA-CHECKLIST](QA-CHECKLIST.md)). It is
verification only: it changes no product code and no JCad output. AutoCAD is named as a
compatibility reference; JCad Electrical is not affiliated with Autodesk.

## Running it

Windows with a licensed AutoCAD (full AutoCAD, which ships `accoreconsole.exe`):

```
npm run check:autocad:3d
```

| Setting | Meaning |
| --- | --- |
| `JCAD_AUTOCAD_CONSOLE` (or the first argument) | Path of `accoreconsole.exe`; default `C:/Program Files/Autodesk/AutoCAD 2027/accoreconsole.exe`. Missing: the script exits 1 with "check:autocad:3d needs AutoCAD Core Console ... Nothing was validated." |
| `JCAD_AUTOCAD_3D_OUT` | File for the JSON report; default `jcad-autocad-3d-<time>.json` in the OS temp folder. |
| `JCAD_AUTOCAD_3D_KEEP=1` | Keep the work folder (inputs, AutoCAD scripts and logs, AutoCAD's DXF / DWG files, AutoLISP reports) after a pass. After a failure it is always kept and its path is printed. |

Each AutoCAD run is bounded (240 s, 16 MB of console output; killed beyond that) and runs with
`/isolate` in a profile folder inside the work folder, so the user's AutoCAD profile is not
touched (AutoCAD still records the two isolation names, `jcad-3d-validation-session` and
`jcad-3d-validation-dwg`, under its HKCU registry key, as `check:autocad` does). The exit status
is 1 on any mismatch, AUDIT error, AutoLISP error, missing AutoCAD output or AutoCAD failure; no
input is skipped. A full run takes about 1 to 2 minutes (ten Core Console sessions).

## What it checks

Inputs:

| Input | Content |
| --- | --- |
| `tests/fixtures/3d/enclosure.dxf` | 45 solids (shell with holes, door, 3 DIN rails, 40 components) |
| `tests/fixtures/3d/cable-tray.dxf` | 4 solids (tray run with a revolved bend, ...) |
| `tests/fixtures/3d/schematic-with-solids.dxf` | the demo schematic (2D) plus the 45 enclosure solids |
| `dimensions.dxf` (generated, `tests/helpers/autocad-3d-export.ts`) | 21 DIM3D dimensions with known values: aligned (5), linear X (3.5), linear Y (4, text override `H = <>`) and angular (60°) in the World plane, a tilted plane (normal (0.3, -0.2, 0.9)), a (0, 0, -1) plane at z = -2 and a plane whose X axis is not the OCS X axis (normal +X); a projected aligned dimension (5, `<> (projected)`); on the top face (z = 2) of a 10 x 8 x 2 box solid: the diagonal (12.806), the two edges (10, 8) and a corner angle (90°); one 2D aligned dimension (10) |
| `dimensions-42-zeroed.dxf` | the same file with every DIMENSION's stored measurement (group 42) set to 0, so AutoCAD's measurement cannot be an echo of JCad's |

For each input:

1. **Open and AUDIT.** Session 1 opens the DXF (`/i`), runs `AUDIT` with Fix = Yes and parses
   "Total errors found N fixed M" (must be 0 / 0). AutoCAD's other messages (unknown header
   variables ...) are listed as notes.
2. **Enumerate (AutoLISP, written into the script).** Every model-space entity: counts per type,
   `EXTMIN` / `EXTMAX` before and after `ZOOM Extents`; every polyface `POLYLINE` (70 bit 64):
   handle, layer, colour, 71 / 72, its `VERTEX` records counted by flag (192 mesh vertex, 128 face
   record), four-sided faces, negative (invisible-edge) indices, `SEQEND`, XDATA applications with
   group and character counts; every `DIMENSION`: handle, type (70 & 7), block, style, text
   override (group 1), stored measurement (42), 50, extrusion (210) and points 10, 11, 13, 14, 15,
   16. The report is JSON with numbers written by `rtos` mode 1 (16 digits).
3. **Save.** `DXFOUT` as 2018 (16 decimals) and `SAVEAS` 2018 DWG.
4. **AutoCAD's own measurement.** The Core Console has no ActiveX (`vla-get-Measurement` and
   `vla-get-TextOverride` raise an error there; `getpropertyvalue` does not exist), so the script
   makes AutoCAD recompute every dimension with `(entmod (entget e))` and reads 42 afterwards.
   That this is a recomputation and not an echo was established with a probe (stored 42 = 7.25
   came back as the geometric value after `entmod`) and is re-established on every run by
   `dimensions-42-zeroed.dxf` (the 2D dimension still reads 0 before the recompute and 10 after).
   The recompute must not move any definition point. The recomputed drawing is DXFOUT too.
5. **XDATA-loss simulation.** AutoCAD then removes `JCAD_3D` from every object
   (`entmod` with an empty `-3` application) and DXFOUTs again: what a program that drops
   unknown XDATA would hand back.
6. **DWG round trip.** Session 2 opens AutoCAD's DWG, AUDITs it (0 / 0), enumerates it again and
   DXFOUTs it.
7. **Compare in Node** with JCad's reader (`readDxf(text, { model3d: true })`) of the input and an
   independent parse of JCad's DXF (`nativeDxfRecords` from `check-autocad.mjs`):
   - polyfaces: AutoCAD's count = JCad's polyface records = the solids; per record (by handle)
     layer, colour, 71 / 72 = the solid's vertex / triangle counts, the VERTEX records of each
     kind match 71 / 72, no quads or invisible edges, SEQEND present;
   - dimensions: same count; per handle the type, the extrusion (1e-12 against JCad's 210, 1e-9
     against the plane normal), points 10 / 11 / 13 / 14 / 15 / 16 (1e-9; see the angular note
     below), group 1 = JCad's effective text override; AutoCAD's recomputed measurement = JCad's
     computed value and the analytic value within 1e-6 relative; the 2D dimension likewise;
   - model-space entity counts per type equal; AutoCAD's extents contain the solids' bounds;
   - each AutoCAD DXF read back (DXFOUT, recomputed DXFOUT, DWG then DXFOUT): R2018 (AC1032),
     same number of solids with identical triangles (indices exact, coordinates 1e-12), layers
     and colours; the same 3D dimensions (kind, axis, measurement, normal, plane elevation, text,
     projected flag, p1 / p2 / vertex) and 2D dimensions; the same 2D entity counts; whether ids,
     names, histories and plane frames came back (XDATA survival, reported, not failed); every
     import-report item listed; an item about a drawing entity (not "kept") is a failure;
   - the XDATA-stripped DXF against the documented foreign-file rules
     ([3D-FILE-FORMAT](3D-FILE-FORMAT.md#reading)): every polyface becomes a plain mesh solid with
     identical triangles (reported "simplified", fresh id); a DIMENSION whose normal is not +Z
     becomes a 3D dimension with the same kind, measurement, normal and elevation; a +Z one takes
     the 2D path with the same measurement.

## Results on this machine

AutoCAD 2027 Core Console (version X.60.0.0, en-US), Windows 11 Pro, 13 October 2026, branch
`feature/3d-development` at 99d2a7f plus this check. **Passed** (exit 0, 0 mismatches).

| Input | AUDIT DXF / DWG (found / fixed) | Polyfaces in AutoCAD | Dimension measurements (AutoCAD vs JCad) | Round trips (DXFOUT, recomputed, DWG) | JCAD_3D XDATA |
| --- | --- | --- | --- | --- | --- |
| enclosure.dxf | 0 / 0, 0 / 0 | 45 of 45 match (71 / 72, VERTEX kinds, layer, colour, handles kept) | none | 45 solids, identical triangles, every time | survives all three: 45 ids, names and histories |
| cable-tray.dxf | 0 / 0, 0 / 0 | 4 of 4 match | none | 4 solids, identical | survives: 4 ids, names, histories |
| schematic-with-solids.dxf | 0 / 0, 0 / 0 | 45 of 45 match; 2D entity counts equal | none | 45 solids identical, 2D counts equal | survives: 45 / 45 |
| dimensions.dxf | 0 / 0, 0 / 0 | 1 of 1 match | 22 of 22 within 1e-6 (largest relative difference 8.5e-16), equal to the analytic values | 1 solid, 21 3D dimensions (same kind, measurement, plane, points, text) and 1 2D dimension | survives: solid id and history, 21 dimension ids and plane frames |
| dimensions-42-zeroed.dxf | 0 / 0, 0 / 0 | 1 of 1 match | 22 of 22 (AutoCAD computes them; 42 was 0) | as above | as above |

AutoCAD keeps every handle on DXF load and writes `JCAD_3D` back unchanged in DXFOUT and in DWG,
so solid ids, names, construction histories, dimension ids, plane frames and projected flags all
come back. Without the XDATA (step 5), JCad reads every polyface as a plain mesh with identical
triangles (each reported "simplified POLYLINE: imported polyface mesh: not editable
parametrically"), the 13 dimensions in non-+Z planes as 3D dimensions with the same measurement,
normal and elevation, and the 8 +Z ones (World and the z = 2 face) as 2D dimensions.

### Discrepancies and observations

- **Angular dimensions: AutoCAD moves group 10.** For every three-point angular dimension AutoCAD
  rewrites the arc definition point (10) on load: JCad writes it at the middle of the measured
  sweep, AutoCAD puts it at one third of the sweep from the first leg (13), same radius, same plane,
  same side, so the measured angle and the arc are unchanged (for example the face corner:
  (16, -3, 2) becomes (16.2247, -3.2929, 2)). The moved point survives DXFOUT and DWG; JCad reads
  the angle and radius back unchanged. The check accepts it (radius, plane and side are compared)
  and lists it as a note. AutoCAD also recomputes angular measurements on load, while a nonzero
  stored 42 of linear / aligned dimensions is kept until the dimension is updated.
- **Header variables.** AutoCAD reports "Unknown header variable $CANNOSCALE ignored" and
  "... $ANNOALLVISIBLE ignored" for every input: JCad writes these AutoCAD 2008 header variables
  into an AC1015 (AutoCAD 2000) file. They are ignored, AUDIT is clean and nothing else is
  affected. This is the 2D writer's header, not specific to 3D.
- **Import report of AutoCAD's DXF.** Reading any AutoCAD-written file, JCad lists 85 items that
  are not about 3D: 7 dimension header variables JCad does not model (`$DIMASO`, `$DIMSHO`,
  `$DIMTOLJ`, `$DIMALTTD`, `$DIMFXL`, `$DIMJOGANG`, `$DIMASSOC`, "simplified") and 78 AutoCAD
  objects it does not keep (20 XRECORD, 24 VISUALSTYLE, 17 SCALE, 9 DICTIONARYVAR, 3 MATERIAL,
  MLEADERSTYLE, MLINESTYLE, CELLSTYLEMAP, ACDBDETAILVIEWSTYLE, ACDBSECTIONVIEWSTYLE, "dropped").
  No item concerns a polyface, a VERTEX or a DIMENSION.
- **Without XDATA, +Z dimensions become flat 2D dimensions.** Following the documented rule, the
  four face-plane dimensions at z = 2 lose their elevation when another program strips the
  `JCAD_3D` data (they read back as 2D dimensions with the right measurements). With AutoCAD
  itself this does not happen, because AutoCAD keeps the data.

## What remains unverified

- AutoCAD's display: the check runs the Core Console only; how the meshes and the dimension
  pictures (`*D` blocks) look on screen, shading, hidden-line views and every triangle edge being
  shown were not inspected.
- Interactive editing in AutoCAD (grips, `DIMEDIT`, `EXPLODE`, `PFACE` editing, Properties) and
  whether such edits keep `JCAD_3D` consistent with the edited geometry.
- Other AutoCAD versions (2018 to 2026), AutoCAD LT (no Core Console), and other programs
  (BricsCAD, DraftSight, LibreCAD, ODA viewers).
- AutoCAD's own dimension recompute was triggered with `entmod`; `DIMREGEN`, `DIMSTYLE` Apply and
  regeneration after a style change were not exercised. Dimension style overrides and the
  appearance of the regenerated blocks were not compared.
- Meshes split into several polyface records (more than 32,767 vertices or faces) and payloads
  near the 15,000-character limit: none of these inputs has one.
- Opening AutoCAD's DWG in JCad (JCad reads DWG through LibreDWG, which has no polyface
  conversion; see [3D-FILE-FORMAT](3D-FILE-FORMAT.md#dwg)).
