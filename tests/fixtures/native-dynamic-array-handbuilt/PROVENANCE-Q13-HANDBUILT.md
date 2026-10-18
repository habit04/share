# P30_LINEAR_ARRAY Q13 fixture — HAND-BUILT dynamic definition, AutoCAD-evaluated

**Label: HANDBUILT. Not authored in the AutoCAD Block Editor.** The dynamic objects (evaluation graph,
linear parameter, grip, grip-location components, array action) were hand-written by injection
(`inject.py`), because this PC has no usable Block Editor (AutoCAD GUI trial expired; headless
`accoreconsole` has no Block Editor). Labelled substitute approved by Justin on 2026-10-17 (N1
precedent); recipe = `Q13-RECIPE-PROPOSAL.md` (sha256 6029f238…0f1e), with the lead's §6 rulings
(C1 distance-driven count, candidates R-A..R-D; C2 donor layout from "Stud - Metric"; C3 grips as
proposed unless the donor governs; C4 row fields from donor, rows 1; C5 `Distance1`; C6 A/B/C/D;
C7 list 55/60/135, default 60). Built 2026-10-17/18 by Claude.

## Donor layout (C2) — layout-COPIED, not layout-derived
- Donor: Autodesk shipped sample block **"Stud - Metric"** in
  `C:\Program Files\Autodesk\AutoCAD 2027\Sample\en-us\Dynamic Blocks\Architectural - Metric.dwg`
  (sha256 33cf8a34…5227a). Exported fresh by headless AutoCAD (DXFOUT 2018) to
  `donor/Architectural_-_Metric.dxf`; `extract_donor.py` dump in `donor-array-graphs.txt`.
  Its DXF export contains `BLOCKARRAYACTION` (only in "Stud - Metric"); the Structural - Metric and
  (N1's) Mechanical - Metric exports contain none; the other sample DWGs were not exported (a raw byte
  scan of compressed DWGs is inconclusive), so other donors may exist.
- Donor `BLOCKARRAYACTION` (object 927, driven by the linear parameter `studwidth`):
  `AcDbBlockAction 70=0 71=<n> 330=<sel…> 1010/1020/1030=<location>` then
  `AcDbBlockArrayAction 92=93=94=95=<param node id> 301=Base 302=End 303=UpdatedBase 304=UpdatedEnd
  140=50.8 141=38.0`. 141 = column offset (equals the stud width 38 along the horizontal parameter);
  140 = row offset. **There is no count field, no row-count field and no grip/point field**: the
  action connects to all four parameter outputs (Base, End, UpdatedBase, UpdatedEnd).
- Donor graph edge param→array carries `94=4` (stretch edges carry 94=2); copied.

**What was hand-written vs copied**
| Item | Source |
|---|---|
| Plate / hole / control line / TAG1 (plain block) | AutoCAD `entmake` (`base.scr`) → `base.dxf` |
| Graph header, BLOCKLINEARPARAMETER, BLOCKLINEARGRIP, 2× BLOCKGRIPLOCATIONCOMPONENT, purge preventer, xdict | N1 `inject.py` layout (itself from "Aluminum Window (Elevation) - Metric"), values changed to (0,30)→(60,30), list 55/60/135, label offset 38 (= 68−30), grip (60,30) |
| BLOCKARRAYACTION `Array1` + param→array edge | Stud - Metric layout verbatim; values: selection = hole CIRCLE only (71=1), 140=50.8 (donor row offset kept, C4), 141=20.0 |
| Action location 1010 (60,−20) | builder-chosen, cosmetic (recipe gives none) |
| DynamicBlockGUID | hand-written {6F1C3B52-…-7A30D1F0B013}; AutoCAD replaced it on load (GUID differs per session: build/DWG/DXF reads show different values) |

C3 outcome: **the donor layout governs** — an array action has no "parameter point"; it is wired to
Base/End/UpdatedBase/UpdatedEnd, so the recipe's "end grip (60,30)" choice does not exist for the
action. The parameter still carries one BLOCKLINEARGRIP (End Grip at (60,30)) + 2 grip-location
components, exactly as N1 and the donor. C4 outcome: the native object has a row-offset field (140)
and no row-count field; 140=50.8 written from the donor; rows were never produced (single row
measured in every state). Label position x=90 is not encodable (the linear parameter stores only the
label offset 38); recorded, cosmetic.

## Production record (AutoCAD 2027, ACADVER 26.0, accoreconsole X.60.0.0, Windows 11 Pro 26200)
Isolated throwaway profile `/isolate p30-q13 …\profile`; plugin folder put in TRUSTEDPATHS only inside
that profile and reset to "" at the end of each run (SECURELOAD and the real profile untouched). GUI
never launched. All runs serial.
1. `base.scr` (new drawing from acad.dwt, INSUNITS=1): `entmake` BLOCK `P30_LINEAR_ARRAY` base (0,0),
   layer 0, ByLayer: LWPOLYLINE closed (0,0)(180,0)(180,60)(0,60); CIRCLE (20,30) r5; LINE
   (150,10)-(170,25); ATTDEF TAG1 last (prompt "Plate ID", default P-100, modes off, lock position on,
   (10,45), Left, Standard, h5, rot 0) → `DXFOUT 2018` `base.dxf`. (An ATTDEF entmake with a single
   `(280 . 1)` leaves lock position OFF — it lands in the version field; the full subclass list with a
   second 280 was used; AutoCAD reports `LockPositionInBlock = true`.)
2. `inject.py` → `p30-handbuilt-def.dxf`.
3. `step1-build.scr` on the hand-built DXF: `AUDIT` (0 errors) → NETLOAD `P30Measure.dll` →
   `P30Q13BUILD` (inserts A (0,0) 0°, B (240,0) 0°, C (480,0) 30°, D (700,0) 0°; attributes from the
   ATTDEF; `Distance1` set via `DynamicBlockReferenceProperty` to 135/135/55, A untouched) →
   `AUDIT` (0 errors) → `SAVEAS 2018` DWG → `DXFOUT` ASCII version 2018 precision 16.
4. `step2-reopen-dwg.scr` / `step2-reopen-dxf.scr`: reopen each file, `AUDIT` (0 / 0 errors),
   `P30Q13READ` (read-only) → `read-dwg.json` / `read-dxf.json`, `LIST` of all INSERTs → `list-*.txt`.
   Values read back: A/B/C/D = **60 / 135 / 135 / 55** in both files.
5. Checks C1–C4 on throwaway copies (`checks/`), never saved.

`P30Measure.cs` is the N1 source byte-identical (P30MEASURE/P30READ unchanged and not run); new
commands live in `P30Q13.cs`. The whole step 3–5 sequence was run twice (first in `run/`, then
cleanly in `final/` after fixing a C4-only enumeration bug); both runs gave identical measurements.
Shipped files are from `final/`.

## Measured results (AutoCAD's own read-back of the reopened DWG; the DXF reads identically)
| | A | B | C | D |
|---|---|---|---|---|
| set | untouched | 135 ok | 135 ok | 55 ok |
| Distance1 / allowed | 60 / [55,60,135] | 135 | 135 | 55 |
| Origin (read-only) | (0,30,0) | same | same | same |
| block record | P30_LINEAR_ARRAY (named) | `*U2` | `*U2` (shared with B) | `*U4` |
| **hole count** | **1** | **6** | **6** | **2** |
| hole centres x (y=30, def space) | 20 | 20,40,60,80,100,120 | same as B | 20,40 |
| last offset | 0 | 100 | 100 | 20 |
| world extents | (0,0)-(180,60) | (240,0)-(420,60) | (450,0)-(635.884572681,141.961524227) | (700,0)-(880,60) |
| TAG1 (P-100) | (10,45) | (250,45) | (466.160254038,43.971143170) | (710,45) |
Plate (single LWPOLYLINE, unchanged), control line (150,10)-(170,25) and TAG1 ATTDEF are identical in
every record; nothing but the hole circle was arrayed. C's rotation reads 29.999999999999996°.
Extents and TAG1 positions equal recipe §3.3's rule-independent values.

**Q13 / J12 — candidate rules vs measured (A, B/C, D) = (1, 6, 2):**
R-A (4,7,3) no · R-B (1,4,0) no (matches A only) · R-C (4,8,4) no · R-D (3,7,3) no.
**None of R-A..R-D matches.** Extra evidence (C1, throwaway copy): B set to **60** → new `*U5` with
**3** holes (20,40,60; last offset 40). So every *evaluated* state measured — 55→2, 60→3, 135→6 — is
consistent with **count = floor(v/20)** (copy 0 included; no copy at offset v even at the exact
multiple 60). The untouched default instance A is *not* evaluated: it references the named
definition, which holds the single authored hole — so at v=60 the default instance (1 hole) and an
evaluated instance (3 holes) differ. The recipe's premise "authored geometry is the zero-delta state"
does not hold for this array fixture. (Corroboration only, not measurement: the donor's own lookup
labels map stud width 38/76/114/152 → "1/2/3/4" studs at column offset 38, i.e. floor(v/S).)
Three values cannot exclude other rules that agree on 55/60/135.

**A1: confirmed.** The property API exposes `Distance1` (Distance, not read-only, allowed
[55,60,135]) and a read-only `Origin` (0,30,0); 135 and 55 (and 60 in C1) were set exactly.
**A2: confirmed with one finding.** E1 named record keeps exactly 1 hole throughout; E2 A references
the named record before and after reopen; E3 B/C/D are `*U` records with evaluated CIRCLE copies;
E4 B and C share `*U2`; E5 D's `*U4` is distinct. Link-back on every `*U`: XDATA `AcDbBlockRepBTag`
1070=1, 1005=<named record handle>. Finding: the build session also created an **unreferenced `*U3`**
(6 holes) — absent from the reopened DWG, but **present in the shipped DXF** (DXFOUT was taken in the
build session). Content inventory: one dynamic definition, four INSERTs, `*U2`, `*U4`, plus that
orphan `*U3` in the DXF only.

**Independence checks (throwaway copies):** C1 B 135→60 → B re-pointed to a new `*U5` (3 holes), not
to the named record; A, C (`*U2`, 6), D (`*U4`, 2) and the definition (1 hole) unchanged.
C2 control line start →(155,10) + `UpdateAnonymousBlocks()` → all four show (155,10); values and hole
counts unchanged (B/C now share `*U5`, D `*U7`; old `*U2/*U4/*U6` left unreferenced in-session).
C3 `ResetBlock()` on C → C back to 60 on the named record (1 hole); A/B/D untouched.
C4 `Database.Purge` filter marks no block record purgeable; `-PURGE All` removed only the Annotative
text/dim/mleader styles; `*U2`/`*U4` survive while referenced. The definition's extension dictionary
holds `ACAD_ENHANCEDBLOCK` (AcDbEvalGraph) and `AcDbDynamicBlockRoundTripPurgePreventer`
(AcDbDynamicBlockPurgePreventer); the named-objects dictionary has no purge-preventer entry.
M0 via API (not the GUI Properties palette); M1 `list-dwg.txt`/`list-dxf.txt`; M2/M3 manifest +
`anon-records.txt`; M4 `m4-graph-final-dxf.txt` (graph byte-identical in group content to the
injected input: AutoCAD kept every node, edge and field through its own save); M5 above; M6 AUDIT
0/0/0/0.

## Limits (do not over-read)
- The authoring is hand-built from a donor layout; a Block-Editor-authored block could differ in
  bytes, GUIDs and default flags. The evaluation and every number above are AutoCAD's own.
- Values set via the API, not the Properties palette; no grip drags; no GUI reopen.
- One linear parameter + one array action, one row, AutoCAD 2027 only. Nothing about polar/2-D
  arrays, other actions, other versions, or re-evaluation of re-emitted graphs. The Standard style
  in acad.dwt uses the Arial typeface (LIST output); no other fonts, no xrefs, no user data.
- `oracle-measure.json` holds measured values only; no rule prediction is stored in it.
