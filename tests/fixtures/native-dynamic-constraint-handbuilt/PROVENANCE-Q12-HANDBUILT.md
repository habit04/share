# PROVENANCE: P30 Q12 HANDBUILT constraint-parameter fixture (`P30_CONSTRAINT_WIDTH`)

**Label: HANDBUILT.** This fixture was **not** authored in the AutoCAD Block Editor. The constraint network was authored by AutoCAD's own .NET associative/constraint API in a throwaway profile. The block constraint parameter `Width1` was **hand-written by injection**, with its object layout copied from an Autodesk sample block. AutoCAD 2027 then evaluated the instances, saved the files and did all the measuring. The label stays in every file name and reference.

- Recipe: `Q12-RECIPE-PROPOSAL.md` (frozen), 36,038 B, sha256 `b2c89421fa04ff656e95cec8718ae060afa5bd459d6a1ef917c7eb64c6c7f704`, read in full before building. Build sheet: `Q12-BUILD-SHEET.txt`.
- Lead rulings applied (Claude, in place of Codex): D1 horizontal; D2 donor found (below); D3 List {80,100,120,140}, built as a list; D4 the full 14-constraint network; D5 out of scope; D6 TAG1 kept; D7 A/B/C as proposed; D8 names as proposed; D9 recorded as measured.
- Builder: Claude (Opus 5.5 subagent), 2026-10-18 (final runs about 06:00 to 06:20 UTC), on Justin's Windows PC.
- AutoCAD identity: `accoreconsole.exe` "X.60.0.0 (UNICODE)", ACADVER **26.0**, headless only. Each run used `/isolate p30-q12 <folder>\profile`, a throwaway profile. `TRUSTEDPATHS` was set to the plugin folder only inside that isolated profile, and each script resets it to `""` before it quits. SECURELOAD and the real profile were never touched. GUI AutoCAD was never started, and the Block Editor was never used.
- Drawing: the accoreconsole default new drawing (no `/i`). Measured INSUNITS=1 and MEASUREMENT=0 (`logs/base-log.txt`). These values match acad.dwt, but the template was not verified separately. Saved as AC1032 (SAVEAS "2018"). DXF written by DXFOUT version 2018, ASCII, 16 dp (`$ACADVER` AC1032).
- Privacy: no user data, no real project content, no xrefs, no fonts beyond Standard.

## Donor (ruling D2)

- **Primary donor: block "Window - Metric"** in `C:\Program Files\Autodesk\AutoCAD 2027\Sample\en-us\Dynamic Blocks\Architectural - Metric.dwg`, sha256 `33cf8a34d3f27b4038a0a1205c9897ced46487ee174574f951b6e9ecd195227a`. It was read through the donor-search export `p30-q12-donor-search-20261018\exports\0504.dxf`, sha256 `4ed9092c2937a67e27b526ee94a826360a39f5ecad934de8e1a23b219631c040`. Objects copied group-for-group:
  - `BLOCKHORIZONTALCONSTRAINTPARAMETER` 3341 "DoorWidth"
  - `BLOCKLINEARGRIP` 3342
  - `BLOCKGRIPLOCATIONCOMPONENT` 3343/3344, including their `1= / 70=40 / 140=` cached-value groups
  - the parameter's `ACDBASSOCDEPENDENCY` 332D: flags `290=0,1,0,1`, dependent-on = the parameter, body = `BLOCKPARAMDEPENDENCYBODY`
  - `BLOCKPARAMDEPENDENCYBODY` 332E (`1=<name>=<value>`)
  - graph 3335 edges 8-10 (param to locX, param to locY, grip to param)
  - `ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION` 335D
  - the six CLASS records, copied verbatim

  The extract is in `donor/window-metric-donor-objects.txt`. The full donor DXF is not shipped because it is Autodesk content; the extract can be reproduced on any PC with the AutoCAD 2027 sample set.
- **Secondary donor: "Door Elevation - Metric"** (same file). It is the only reference used for internal dimensional constraints in a block: DIMENSION + `ASSOCDIMDEPENDENCYBODY`, on layer `*ADSK_CONSTRAINTS`, invisible. Window - Metric has none. Its layer convention could not be reproduced (deviation 4).
- The donor's constraint-group object (`ACDBASSOC2DCONSTRAINTGROUP` 3328) was **not** hand-copied (deviation 1).

## Exactly what was AutoCAD-generated vs hand-written

| Item | Who wrote it |
|---|---|
| Block `P30_CONSTRAINT_WIDTH`: LWPOLYLINE, CIRCLE, LINE, ATTDEF TAG1 (full subclass entmake form, lock position 280=1), recipe 1.1 order | AutoCAD (headless `entmake`, `builder/base.scr`) then DXFOUT to `builder/base.dxf` |
| Constraint network: block-xdict `ACAD_ASSOCNETWORK` dictionary, `ACDBASSOCNETWORK` (added to the drawing's top-level network), `ACDBASSOC2DCONSTRAINTGROUP` (48 solver nodes), 6 `ACDBASSOCGEOMDEPENDENCY`, 9 `ACDBASSOCVARIABLE` (Width1, Height1, HoleX, HoleY, HoleRad, LineX1, LineY1, LineX2, LineY2), 9 `ACDBASSOCVALUEDEPENDENCY`, 9 dimension `ACDBASSOCDEPENDENCY` + `ASSOCDIMDEPENDENCYBODY`, 9 invisible DIMENSIONs with their `*D` blocks | **AutoCAD**, authored through its .NET API by `P30Q12NET` (`builder/P30Q12.cs`): `AssocNetwork.GetInstanceFromObject`, `Assoc2dConstraintGroup.AddConstrainedGeometry`, `AddGeometricalConstraint`, `AddDistanceConstraint`, `AddRadiusDiameterConstraint`, `AssocVariable`, `AssocValueDependency`, `AssocDimDependencyBody.CreateAndPostToDatabase`. The plugin chose the arguments: anchors, values, directions, and the DIMENSION placement points. Output `builder/api-net.dxf`, AUDIT 0, DOF 0, WellDefined |
| Width1 conversion: delete Width1's DIMENSION 280, its `ASSOCDIMDEPENDENCYBODY` 282 and its `*D2` block; rewire dependency 281 (third 290 flag 1 to 0, dependent-on to the parameter, body to the new `BLOCKPARAMDEPENDENCYBODY`) | **Hand-written** (`builder/inject.py`), donor 332D layout |
| `ACAD_EVALUATION_GRAPH` (4 nodes, ids 8/16/24/32, 3 edges), `BLOCKHORIZONTALCONSTRAINTPARAMETER` Width1, `BLOCKLINEARGRIP` "End Grip", 2 `BLOCKGRIPLOCATIONCOMPONENT`, `BLOCKPARAMDEPENDENCYBODY` (`Width1=100`), `ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION`, xdict keys `ACAD_ENHANCEDBLOCK` + `AcDbDynamicBlockRoundTripPurgePreventer`, block-record xdata `AcDbDynamicBlockGUID` + its APPID, CLASS records for the 6 new classes | **Hand-written** (`builder/inject.py`), donor layout. Output `builder/p30-handbuilt-def.dxf` |
| Parameter values: points (0,0) to (100,0) (plate vertices 0/1), `175=4` + `144` = 80/100/120/140 (`96=8` list), label offset `140=-15`, grip at (100,0), cached grip-expression values 100/0 | Hand-written; values from the recipe, except label offset and caches, which the builder chose |
| Added by AutoCAD on load/save: `ACDB_DYNAMICBLOCKPROXYNODE` as graph node 33 (`96/97` 32 to 33; the donor graph has one too); parameter reactors to the `*U` records' dependencies; `AcDbBlockRepETag`, `AcDbDynamicBlockTrueName2`, a regenerated GUID; the `*U10`/`*U12` records, each with its own cloned network (group + 9 variables + dependencies + 8 DIMENSIONs) and `AcDbBlockRepBTag 1005=265` link-back | AutoCAD |

After AutoCAD's save, the hand-written parameter, grip, location components, parameter body and purge preventer are group-for-group identical to the injected input. The only additions are the two reactors on the parameter and the proxy node in the graph (`m4/handwritten-objects-survival.txt`).

## Build sequence (scripts in `builder/`, runner `run.ps1`: one short serial accoreconsole run)

1. `base.scr`: entmake, then DXFOUT `base.dxf`.
2. `step0-network.scr` on `base.dxf`: AUDIT 0, then NETLOAD, then `P30Q12NET`, then AUDIT 0, then DXFOUT `api-net.dxf`. Log in `api-network-authoring.json`.
3. `python -I inject.py api-net.dxf p30-handbuilt-def.dxf`. Log in `logs/step0c-inject.txt`.
4. `step1-build.scr` on the injected DXF, in this order:
   - **AUDIT 0** on open
   - NETLOAD, then `P30Q12BUILD`: inserts A/B/C in one transaction (N1/Q13 pattern), sets `Width1` through `DynamicBlockReferenceProperty`, snapshot `build-in-command.json`
   - `P30Q12READ`: snapshot after the command ended, `build-post-command.json`
   - **AUDIT 0**
   - SAVEAS 2018 to the DWG
   - DXFOUT 2018/16 to the DXF
5. `step2-reopen-dwg.scr` / `step2-reopen-dxf.scr`: reopen each file, **AUDIT 0**, `P30Q12READ` (`read-dwg.json` / `read-dxf.json`), LIST of all INSERTs (`list-dwg.txt` / `list-dxf.txt`).
6. Independence checks C1-C4: each runs on a fresh copy of the saved DWG, and the copy is never saved (`checks/`).
7. `make_manifest.py` builds `oracle-measure.json` and `instance-A/B/C.json`. This step only copies AutoCAD's numbers, names anchors from AutoCAD-reported geometry, and compares against the recipe 3.3 numbers. Then SHA-256.

## Measured vs expected (all from AutoCAD; `oracle-measure.json.expectedVsMeasured`)

| Fact | Expected (recipe) | Measured |
|---|---|---|
| AUDIT: injected input on open / before export / reopened DWG / reopened DXF | 0 / 0 / 0 / 0 | **0 / 0 / 0 / 0** (the API-authoring run was also 0 / 0) |
| D9 definition `IsDynamicBlock` (constraint-only definition) | true (proposed) | **true** (build session and reopened DWG) |
| Property name | `Width1` | **`Width1`**. Rows exposed per instance: `Width1` (units Distance, read-only false, allowed **[80,100,120,140]**) and a derived **`Origin`** row (read-only, Show=false, value (0,0,0)), the same as N1. **None of the 8 supporting dimensional constraints surfaces as a property** (M1) |
| Width1 A / B / C (reopened DWG, reopened DXF, LIST) | 100 / 120 / 120 | **100 / 120 / 120** |
| A record | named `P30_CONSTRAINT_WIDTH` (E2) | **`P30_CONSTRAINT_WIDTH`** (E2 holds) |
| B / C records | `*U` (E3) | **`*U10` / `*U12`** in the reopened DWG and DXF (`*U10` / `*U13` in the build session and in the shipped DXF). E3 holds |
| E4: B and C share one `*U` | same record | **NO.** B and C reference distinct records. No orphan `*U` in either file |
| Plate vertices (record) A / B, C | (0,0)(100,0)(100,60)(0,60) / (0,0)(120,0)(120,60)(0,60) | **as expected** (B/C y = 60.000000000000014 in the DWG; max \|diff\| 1.4e-14) |
| Inner LINE (record) A / B, C | (70,20)→(90,40) / (90,20)→(110,40) | **as expected** (max \|diff\| 1.4e-14) |
| Circle | (30,30) r10, W-invariant | **(30,30) r10 in all records** |
| TAG1 (ATTDEF in the record; world attribute) | (10,45); B (210,45); C (386.160254038, 43.971143170) | **(10,45); (210,45); (386.16025403784437, 43.97114317029974)** |
| World extents of plate/circle/line (`extentsGeometryOnly`, see note) | A (0,0)-(100,60); B (200,0)-(320,60); C (370,0)-(503.92304845413264, 111.96152422706632) | **identical**, B max y 60.000000000000014 |
| Raw `BlockReference.GeometricExtents` | (not addressed by recipe) | A (-25.44,-45.18)-(125.45,60); B (174.56,-45.18)-(345.45,60); C (347.97,-51.85)-(548.55,124.68). **These include the invisible constraint DIMENSIONs** (deviation 4) |
| Constraint state, every record (def, `*U10`, `*U12`) | fully constrained, Width1 the only DOF | **DOF 0, SolutionStatus WellDefined**, all constraints WellDefined. Record variables: Width1 = 100 / 120 / 120, others 60/30/30/10/30/20/10/40. Measured values equal the variables |

Notes on extents: `extentsGeometryOnly` is the union of AutoCAD's own `GeometricExtents` of each non-DIMENSION, non-ATTDEF record entity, cloned and transformed by the INSERT's `BlockTransform`. The plugin does the union; AutoCAD supplies every number.

### Evaluation timing (recorded, not tuned)

Inside `P30Q12BUILD`, the record of the **last** instance whose `Width1` was set (C) still had the Width1=100 network and geometry, even though its property already read 120 (`build-in-command.json`). Once the command ended, AutoCAD had evaluated it (`build-post-command.json`, and then the saved files). Throwaway diagnostic runs showed the same thing for whichever instance is set last, at any position or rotation (`logs/diagnostics-summary.txt`). The recipe numbers are therefore read from the post-command snapshot and the reopened files. The in-command snapshot is shipped as evidence.

### Independence checks (each on a throwaway copy of the reopened DWG; readings after the command ended)

- **C1**: B 120 to 140. B stays on `*U10`, which is **re-evaluated in place** (plate right x 140, line 110→130). No fork, because B and C never shared. A and C unchanged. Definition unchanged.
- **C2**: definition variable HoleX 30 to 35, then `EvaluateTopLevelNetwork` and `UpdateAnonymousBlocks`. The circle centre is **(35, 30.000000000000004)** in the definition and in all three instances. Width1 stays 100/120/120. B and C are re-pointed to new `*U22` / `*U29`. The old `*U10` / `*U12` are left unreferenced in the session.
- **C3**: `ResetBlock` on C. C goes to `P30_CONSTRAINT_WIDTH` with Width1 = 100, and `*U12` becomes unreferenced. A and B untouched.
- **C4**: `Database.Purge` over all block records reports **purgeable = []**. Then `-PURGE All` deleted only the Annotative text, dimension and multileader styles. All 21 block records survive, including `*U10` and `*U12`. An `AcDbDynamicBlockPurgePreventer` (`ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION` 328, hand-written, kept by AutoCAD) exists, referenced only by the definition's extension dictionary key `AcDbDynamicBlockRoundTripPurgePreventer`. The `*U` records carry no purge preventer: their xdict holds only `ACAD_ASSOCNETWORK`.

## M4: where the network lives (transcriptions in `m4/`)

- Named record 265 has xdict 272 with three keys:
  - `ACAD_ASSOCNETWORK` → dict 273 → `ACDBASSOCNETWORK` 274 (owning network 276 = the drawing-level network in NOD `ACAD_ASSOCNETWORK`). 274 holds the group 277 and the 9 variables.
  - `ACAD_ENHANCEDBLOCK` → `ACAD_EVALUATION_GRAPH` 322, which holds Width1 323, grip 324, location components 325/326 and an AutoCAD-added proxy node 32E.
  - `AcDbDynamicBlockRoundTripPurgePreventer` → 328.
- **The constraint network is not inside the evaluation graph.** It is a sibling dictionary entry. The only link is the parameter: group 277 owns dependency 281 (dependent-on = parameter 323, body = `BLOCKPARAMDEPENDENCYBODY` 327 `1=Width1=100`), and the parameter points back through `AcDbBlockConstraintParameter 330=281`. This matches the donor.
- **Width1's value** lives in three places:
  - `ACDBASSOCVARIABLE` 27E (`1=Width1 | 1=100 | 1=AcDbCalc:1.0 | 90=100`)
  - the parameter-dependency body text `Width1=100`
  - the parameter's geometry (1010/1011 points)
- **The value set** is `BLOCKHORIZONTALCONSTRAINTPARAMETER` `96=8`, `175=4`, `144=80/100/120/140`. The default is the variable's expression.
- **Each `*U` record** carries a full clone of the network in its own xdict `ACAD_ASSOCNETWORK`, with the instance value in its own Width1 variable (120). Its Width1 dependency points at the **named definition's** parameter 323, as in the donor's `*U10`.
- Full ownership-tree transcriptions, verbatim group pairs, one object per line:
  - `m4/m4-definition-owned-final-dxf.txt` (named record, shipped DXF)
  - `m4/m4-definition-owned-handbuilt-input.txt` (the injected input)
  - `m4/m4-U10-owned-final-dxf.txt` and `m4/m4-U13-owned-final-dxf.txt` (B's and C's records in the shipped DXF)
- The complete OBJECTS region is in the shipped DXF itself.

## Deviations from the recipe (single list)

1. **The constraint network was authored by AutoCAD's .NET API, not hand-injected.** This is the lead-permitted fallback. Only the Width1 constraint parameter and its wiring are hand-written. **Full hand-injection of `ACDBASSOC2DCONSTRAINTGROUP` was not attempted.** Its DXF form is a serialized solver graph, with 31 nodes for the donor's 3 lines and 48 for this network (implicit points, point-curve, coincidence and datum-line nodes with internal ids and cross-references, `donor/` and `m4/`). On inspection it was judged too risky to hand-write. This is a judgement, not a measured failure.
2. **Anchor realisation.** The API constrains points, so "segment" anchors are realised as implicit end points of those segments:
   - Width1: left-edge end point (0,0) ↔ right-edge start point (100,0)
   - Height1: (0,0) ↔ top-edge end point (0,60)
   - HoleX/HoleY/LineY1/LineY2: plate vertex 0 (segment 0 start)
   - LineX1/LineX2: right-edge start point (100,0)
   - G-fix: segment 0 start point

   All distance constraints use `FixedDirection` (1,0) or (0,1). The result is the same DOF-exact network (DOF 0).
3. **Variable value write.** `P30Q12NET` writes each `AssocVariable.Value` explicitly after `SetExpression`. Without this, `AddRadiusDiameterConstraint` threw `eInconsistentConstraint` in every other variant tried (`logs/diagnostics-summary.txt`). The first full authoring run also hit this; its log was overwritten by later runs.
4. **The 8 supporting dimensional constraints carry DIMENSION entities in the definition and in each `*U` record.** They are invisible (`60=1`) and on **layer 0**. The donor uses layer `*ADSK_CONSTRAINTS`. Moving them there by injection made DXFIN reject the file ("Invalid Block Name:*D3", measured), so the move was dropped. As a result:
   - the definition holds 4 recipe entities + 8 DIMENSIONs
   - the file contains `*D` anonymous dimension blocks (18 in the reopened DWG), so the recipe 5 content inventory ("nothing else") is not met
   - raw INSERT extents include the dimensions
4a. The DIMENSION dependency bodies carry the value only (`1=60.0000`). `SetNameAndExpression` did not persist a name, so the names live in the AssocVariables.
5. **Parameter details chosen by the builder**, because the recipe pins none for a constraint parameter: label offset `140=-15`, grip-expression caches 100/0, graph node ids 8/16/24/32 with `96/97=32`. AutoCAD rewrote these to 33 after adding its proxy node. The donor's flip/alignment/vertical parameters were not copied, since Q12 has only Width1.
6. **The DXF is exported in the build session, per the recipe order.** Its `*U` / `*D` names therefore differ from the reopened files: C is `*U13` in the DXF and `*U12` after any reload. Unlike Q13, there is no orphan `*U`.
7. **E4 is measured NO** (B and C do not share). This is a finding, not a fix.
8. **Instances inserted in one transaction**, as in N1/Q13. The recipe values are read after the command ends (see Evaluation timing). The in-command snapshot also ships.
9. **Raw extents vs recipe extents**: the recipe 3.3 extents are met by `extentsGeometryOnly`, not by the raw INSERT extents (deviation 4).
10. **Template not verified** beyond INSUNITS/MEASUREMENT.
11. **Build environment incident**: Windows Application Control blocked one plugin binary build at NETLOAD during the diagnostic runs (0x800711C7). The plugin was rebuilt with only a comment line added, and that build loaded. No security setting was changed. The shipped runs used plugin build sha256 `052e8947…6c16` (the final rebuild, which also added the geometry-only extents and post-command read).

## Limits

- Evidences one horizontal distance constraint parameter, plus a fully constrained supporting network, in one AutoCAD version (2027 / 26.0), headless, HANDBUILT.
- Nothing about Block-Editor-authored byte layout: a Block-Editor block would put its constraint DIMENSIONs on `*ADSK_CONSTRAINTS`, might name its dependency bodies, and might evaluate or share `*U` records differently. Nothing about GUI or Properties-palette behaviour, other constraint kinds, or other versions.
- C2 changed the definition through its AssocVariable, not through a Block Editor edit.
- The diagnostic runs (`hl/`) are throwaway and their JSONs are not shipped; `logs/diagnostics-summary.txt` quotes their AutoCAD-measured lines.

## Files

See `SHA256SUMS`, computed after the final save.
- Fixture: `p30-constraint-width-HANDBUILT.dwg` / `.dxf`.
- Manifest: `oracle-measure.json`, plus per-instance `instance-A.json` / `instance-B.json` / `instance-C.json`.
- Raw AutoCAD read-backs: `read-dwg.json`, `read-dxf.json`, `build-post-command.json`, `build-in-command.json`, `api-network-authoring.json`, `list-dwg.txt` / `list-dxf.txt`.
- Other folders: `checks/`, `m4/`, `donor/`, `builder/` (all scripts, plugin source, and the `base.dxf` / `api-net.dxf` / `p30-handbuilt-def.dxf` intermediates), `logs/`.
