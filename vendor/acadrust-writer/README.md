# Private Windows DWG writer source pin

The Windows DXF-to-DWG helper links acadrust 0.6.4, pinned by its published crate
SHA-256 and matching upstream commit in `pins.json`. It is MPL-2.0 licensed; the
unmodified full license is included here. The helper itself is GPL-3.0-only.

Fifteen exact source replacements in six files correct standalone MTEXT frame
output, its matching private validator, owned ATTRIB parent relationships,
MINSERT's owned-attribute count before array fields, FIELD/FIELDLIST common DXF
groups, and the VIEW front-clipping mode bit. Whole-file hashes verify both the
original and patched files. `scripts/prepare-dwg-writer.mjs` verifies the original
crate, extracts it inside the ignored build directory and applies only these replacements.
No prebuilt executable is committed. The released bundle includes the helper and
modified crate source, Cargo.lock and third-party license notices.

The FIELD/FIELDLIST DXF repair consumes `{ACAD_REACTORS}` and
`{ACAD_XDICTIONARY}` groups separately from the object's owner and field list.
It stores their ordered references in the library's existing common-object
caches, which the DWG writer already emits. A read-only reactor accessor lets
the helper verify those references after reopening. No native pointers or raw
object bytes become part of this interchange contract.

The VIEW repair follows Open Design Specification 5.4.1, VIEW, printed page 174:
the fourth packed DWG mode bit represents front-clip-Z, opposite DXF group 71
bit 16 (front-clip-at-eye). Both the private writer and its matching reader
invert that bit. Perspective and front/back clipping keep their existing bit
order. This patch applies to VIEW only; it does not change VPORT encoding.

The helper separately compares full typed named VIEW parameters and the retained
DICTIONARY, DICTIONARYWDFLT, FIELD, FIELDLIST and XRECORD graph. It preserves
reference kind, order, ownership, common reactors/extension dictionaries and
typed XDATA. Symbol names/control roles and dictionary-key/field-child paths
identify objects when storage handles change; unrooted objects require unchanged
handles. Literal strings and binary payloads are never treated as handles.
Integer values, including XRECORD int64 values beyond 2^53, compare exactly.
Incomplete XRECORD payloads, incoherent group-code/value or reference schemas,
missing owned objects, duplicate dictionary keys and unknown object classes
refuse export before replacement. These checks cover the typed interchange
subset; they do not certify arbitrary opaque native object records.

`native-evidence.json` records the independent AutoCAD 2027 before/after validation.
Frame flags 16 remain frame-only; no background fill or replacement geometry is
introduced. Mask colors, window-color masks, frame flags and padding for filled
masks match after native reopening. Titleblock attributes and MINSERT row/column
counts, spacing and attributes also survive the private reader and native reopening.
The source-patch proof passes 13 supported fixture cases. The original mixed
`example_2000` fixture retains unsupported 3D/ACIS content and is expected to
refuse production export; production never silently strips those records.
Separate native control-curve evidence for `r2000-hatch-curves.dxf` verifies its
two splines' degree, curve flags, control points, knots and weights.
A separate, explicitly stripped 2D-only `example_2000` proof passes native AUDIT
and entity-count checks. That proof does not enable stripping in production and
does not establish detailed native spline-field fidelity for that fixture.

The patched reader validates **only freshly emitted helper output**. Canonical
AutoCAD-authored frame-only objects can include inert fill fields and differ from
this private encoding. The helper does not accept external DWG input. JCad's
imported-DWG parser remains the separately maintained LibreDWG reader.
