# Native complex linetype retention fixture

This private synthetic drawing was independently opened, audited and normalized
by installed AutoCAD 2027 Core Console X.60.0.0 on 2026-10-13. Two native AUDIT
runs found and fixed zero errors. The committed file is its ASCII AutoCAD 2018
DXF output at precision 16. It contains two model-space LINE entities using
`GAS_LINE` and `FENCELINE1`, a named Standard STYLE referencing `arial.ttf`, and
an anonymous shape STYLE referencing `ltypeshp.shx`. No user drawing, installed
font/shape file or existing CAD process was changed. No font/shape program is
included, and the drawing contains no private filesystem paths or usernames.

The GAS/FENCE resource definitions began with the authored
`r2018-truecolor-linetypes.dxf` fixture. That older fixture is not native-openable
as a complete drawing: AutoCAD rejects its header at `$ACADMAINTVER = 105`.
Its exact resource records were transplanted into an already native-normalized
synthetic container, with handles remapped. Unrelated text entities/styles were
removed. The added absolute rotations and padded GAS text below exercise fields
that the older zero-angle fixture did not distinguish. Native opening and DXFOUT
verified those additions; AutoLISP `entmod` refused linetype-table modifications,
so it was not used as evidence of a successful edit.

| Resource | Dash/gap lengths | Complex flag 74 | Shape number 75 | Scale 46 | Rotation 50 | X/Y offsets 44/45 | Text 9 / STYLE target |
| --- | --- | ---: | ---: | ---: | ---: | --- | --- |
| GAS_LINE | 12.7, -5.08, -6.35 | 3 | 0 | 2.54 | pi/4 | -2.54, -1.27 | `" GAS  "` (one leading and two trailing spaces); Standard / arial.ttf |
| FENCELINE1 | 6.35, -2.54, -2.54, 25.4 | 5 | 133 | 2.54 | pi/6 | -2.54, 0 | Anonymous STYLE, empty name, flags 70 = 1 / ltypeshp.shx |

Each descriptor belongs to the second pattern element. Other elements retain
explicit group 74 = 0. Flags 3 and 5 combine the native absolute-rotation bit
with text and shape bits respectively. Native LTYPE group 50 uses radians;
ordinary STYLE group 50 uses degrees. The text's surrounding spaces are
intentional data: trimming DXF value lines would invalidate this regression.
Native decimal output can normalize 6.35 to 6.349999999999999; comparisons use
relative numeric tolerance 1e-11 while preserving strings, group presence/order
and STYLE target identity exactly. Physical handles may be reassigned by export.

JCad imported this native source, edited the GAS LINE endpoint, undid/redid that
edit, wrote DXF and reopened it. AutoCAD then opened that private JCad export,
reported zero AUDIT errors and exported DXF again. Independent raw-value record
comparison confirmed both descriptor streams, the exact padded text and both
resolved STYLE resources survived. The native container also contains default
AutoCAD object metadata; this test does not establish preservation of those
unrelated objects, and the current importer reports its unsupported metadata.

This fixture establishes complex-linetype DXF data retention. JCad still renders
only the dash patterns; embedded text/shape display and real SHX decoding remain
separate work. It does not establish native DWG fidelity, xrefs, arbitrary object
graphs or exact complex-linetype plotting. Drawings with retained complex
resources are refused by the current portable DWG save/export path so the
descriptors cannot be silently reduced to dashes.

A private production Electron check also passed actual native DXF Open, LINE
edit/undo/redo, DXF Save As, ordinary Save with an exact prior-byte `.bak`, and
fresh disk-copy reopen with newly parsed entity IDs and clean dirty state. Both
saved versions retained the native descriptor/STYLE signatures. The UI-written
DXF independently passed native AUDIT with zero errors and an unchanged
descriptor signature after DXFOUT. Actual DWG Save As displayed the compatibility
refusal before conversion; no DWG file was created, and the drawing snapshot,
file binding, dirty flag, undo/redo history and a real recovery checkpoint stayed
unchanged. Only native destination dialogs used private-path test doubles; the
codecs, file IPC, backup/recovery writes and refusal dialog were real. All test
processes used private profiles and were closed. No installer/release test is
implied.

Primary field semantics: Autodesk's
[LTYPE reference](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-DXF/files/GUID-F57A316C-94A2-416C-8280-191E34B182AC.htm)
and [STYLE reference](https://help.autodesk.com/cloudhelp/2018/ENU/AutoCAD-DXF/files/GUID-EF68AF7C-13EF-45A1-8175-ED6CE66C8FC9.htm).
