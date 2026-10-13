# Complex linetype DXF retention

Priority 14 now retains native DXF data. Embedded glyph rendering remains open; the Canvas
renderer and vector/raster plots still use the reported dash-only fallback.

Every native group49 length keeps its own descriptor: flags74, shape number75, STYLE340,
scale46, radian rotation50, offsets44/45 and literal text9, including leading/trailing spaces.
Header flags/alignment/declared length are kept. Named text styles and anonymous flag1 shape
styles have separate resource identities. Export reserves new STYLE handles before writing
LTYPE references rather than reusing source handles. Shape resources remain separate from
ordinary text font resolution and survive unused-linetype purge.

Malformed definitions, missing/ambiguous references, duplicate fields/count mismatches and
complex data on reserved names refuse export. Unknown descriptor flags remain retained;
unmodeled extension metadata is reported. Arbitrary metadata and native DWG conversion require
the separate PR #9 workstream. Working DWG saves and export copies refuse retained complex
resources until that conversion is verified; explicit DXF fallback preserves them.

Canvas now converts signed runs into alternating dash/gap arrays, retaining phase across
repeats. GAS's consecutive negative lengths form one gap; odd patterns never invert their
signs on the next repetition. Standard patterns, minimum-pixel dots and the visibility threshold
retain their behavior. The native field meanings follow Autodesk's
[LTYPE](https://help.autodesk.com/cloudhelp/2020/ENU/AutoCAD-DXF/files/GUID-F57A316C-94A2-416C-8280-191E34B182AC.htm)
and [STYLE](https://help.autodesk.com/cloudhelp/2018/ENU/AutoCAD-DXF/files/GUID-EF68AF7C-13EF-45A1-8175-ED6CE66C8FC9.htm) references.

The committed native fixture and provenance exercise padded text, nonzero absolute rotations
and both STYLE kinds. Actual source Electron opened it, edited/undid/redid geometry, saved DXF,
created an exact backup, reopened a fresh disk copy and exercised recovery IPC. DWG refusal
left state/history/recovery/destination unchanged. Only native path-dialog answers were mocked.
AutoCAD opened both the source export and UI-written DXF with zero AUDIT errors; independent
raw-value comparisons matched descriptor order/presence, strings and resolved resource identity
at numeric tolerance 1e-11. No installed font/shape program is committed.

The older authored truecolor fixture is useful for parser regressions but AutoCAD rejects its
header; it is not a native whole-file reference. The normalized container's unrelated default
object metadata remains reported as unsupported. These checks do not certify glyph placement,
SHX decoding, native DWG fidelity or an installed release.
