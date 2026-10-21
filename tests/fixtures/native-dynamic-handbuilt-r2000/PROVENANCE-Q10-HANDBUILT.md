# P30 Q10: R2000 save-down of the N1 HANDBUILT fixture (AutoCAD-measured)

**Label: HANDBUILT lineage.** The source is the N1 fixture `p30-linear-stretch-HANDBUILT.dwg` (SHA-256 670ae927…f86d; dynamic objects hand-written, see N1 PROVENANCE-HANDBUILT.md). Assigned 2026-10-17 under Justin's approval ("Yes start both"); Codex accepts.

## Method (headless AutoCAD 2027 accoreconsole, isolated profile; plugin P30Measure.dll command `P30READ`, read-only)
1. Open the source (AC1032), then `P30READ` → `read-source-current.json`.
2. `SAVEAS 2000` → `p30-linear-stretch-HANDBUILT-R2000.dwg` (AC1015).
3. Open the R2000 DWG, then `DXFOUT` version 2000, precision 16 → `p30-linear-stretch-HANDBUILT-R2000.dxf` (`$ACADVER AC1015`).
4. Reopen each R2000 file separately, then `P30READ` → `read-R2000-dwg.json` and `read-R2000-dxf.json`.

## Result (AutoCAD's own read-back)
All three reads are identical in substance:
- the named definition stays `IsDynamicBlock = true` with an extension dictionary; `*U2` (120-wide plate, inner line (90,20)–(110,40)) is retained;
- A → named record, Distance1 100, extents (0,0)–(100,60), TAG1 (10,45);
- B and C → shared `*U2`, Distance1 120, allowed [80,100,120,140], extents (200,0)–(320,60) and (370,0)–(503.923048,111.961524), TAG1 (210,45) and (386.160254,43.971143);
- the `Origin` property (0,30) is still exposed;
- the R2000 DXF still contains the dynamic object records (ACAD_EVALUATION_GRAPH / BLOCKLINEARPARAMETER / BLOCKSTRETCHACTION present).

Q10 observation: **AutoCAD 2027 round-trips the dynamic block through R2000 DWG and DXF without loss** of definition, parameter values, anonymous-record sharing or geometry.

## Limits
- This shows AutoCAD 2027 reading its own R2000 output only. It does not test a real AutoCAD 2000-era application or third-party readers (Q11 territory).
- The source dynamic objects are hand-built (N1 caveat applies).
- Headless console, not a GUI reopen.
