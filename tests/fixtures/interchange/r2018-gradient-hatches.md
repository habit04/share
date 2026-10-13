# Native gradient hatch fixture

This synthetic test drawing was authored in a private directory in this worktree and
normalized by installed AutoCAD 2027 Core Console on 2026-10-12. It contains eighteen
100-by-100 model-space gradient hatches: the nine native names LINEAR, CYLINDER,
INVCYLINDER, SPHERICAL, INVSPHERICAL, HEMISPHERICAL, INVHEMISPHERICAL, CURVED and
INVCURVED, each with shift 0 and 1, angle 0, two stored black/white colors and no
associative boundary links.

AutoCAD opened the private source, ran `AUDIT` with zero errors found or fixed,
saved an ASCII AutoCAD 2018 DXF through `DXFOUT` at precision 16, and plotted the
same source through its native `DWG To PDF.pc3` device. The initial synthetic
source had a low handle seed which AutoCAD corrected before auditing; this
committed file is the normalized output. Its black stop is native group 63 = 0:
AutoCAD omits the zero-valued RGB group 421, while the white stop retains
63 = 7 and 421 = 16777215. JCad preserves both the explicit ACI values and the
presence or absence of RGB fields. An additional native plot placed the stop
with group 63 = 0 and no 421 on a red layer; it still plotted black, confirming
that this gradient stop is not ordinary entity ByBlock inheritance.

JCad imported this normalized file and exported it again. AutoCAD opened that
private JCad export and again reported zero errors found or fixed. Independent
native-record comparison of the resulting normalized file found exactly the
same eighteen gradient tails, including names, shifts and both color records.

The fixture proves native field preservation for these eighteen two-color
cases. It does not prove native DWG import/export, associative boundaries, or
exact rendering of every nonlinear gradient. Independent authored inputs in
`hatch-gradient-dxf.test.ts` cover one-color dialog flags/tint, RGB colors,
unknown retained definitions, malformed data and model/block/layout edits.
No user drawing was opened or changed; the normalized file contains no private
filesystem paths or usernames.
