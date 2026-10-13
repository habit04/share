# Private Windows DWG writer source pin

The Windows DXF-to-DWG helper links acadrust 0.6.4, pinned by its published crate
SHA-256 and matching upstream commit in `pins.json`. It is MPL-2.0 licensed; the
unmodified full license is included here. The helper itself is GPL-3.0-only.

Sixty-eight exact source replacements in ten files correct standalone MTEXT frame
output, its matching private validator, owned ATTRIB parent relationships,
MINSERT's owned-attribute count before array fields, FIELD/FIELDLIST common DXF
groups, the VIEW front-clipping mode bit, opaque DXF metadata strings, MLEADERSTYLE
properties and colors, common object links, typed header values and source CLASS
definitions. Whole-file hashes verify both the
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

The same common-link decoding applies to GROUP, DBCOLOR, MLEADERSTYLE,
DICTIONARYVAR and SCALE. MLEADERSTYLE now consumes the source's alignment space,
block scale/rotation switches, attachment direction and top/bottom attachment,
draw order, break gap, block transform and color method rather than replacing
them with constructor defaults. GROUP membership remains ordered and must refer
to existing entities; DBCOLOR retains its RGB/method, book and color names.

Eighteen new typed header fields replace binary constants or discarded reads for
DIMFXL, DIMJOGANG, DIMTFILL/CLR, DIMARCSYM, DIMFXLON, DIMTXTDIRECTION,
3DDWFPREC, PSOLWIDTH/HEIGHT, LIGHTGLYPHDISPLAY, TILEMODELIGHTSYNCH,
REALWORLDSCALE, INTERFERECOLOR/OBJVS/VPVS, DRAGVS and CSHADOW. The existing
CMATERIAL handle also receives its declared DXF value. Both the private binary
encoder and decoder use these fields; source-before-baseline checks prevent a
successful comparison of values already lost during DXF parsing. Unknown header
variables refuse export. A few unparsed stock fields are accepted only at the
exact value already emitted by the pinned encoder, such as zero orthographic UCS
origins; nondefault values refuse export.

CANNOSCALE and ANNOALLVISIBLE use the native named-object variable dictionary,
DICTIONARYVAR values and a matching owned SCALE record. When explicit DXF header
values require missing registry objects, the helper creates bounded, owned
records before its baseline; retained conflicting values or ownership refuse
export. Existing identities, unrelated variables and scale definitions remain
intact. Explicit source CLASS declarations replace generated defaults. Their
application, C++ name, proxy and schema flags, including unused definitions, are
preserved; only instance count is derived from emitted records.

The VIEW repair follows Open Design Specification 5.4.1, VIEW, printed page 174:
the fourth packed DWG mode bit represents front-clip-Z, opposite DXF group 71
bit 16 (front-clip-at-eye). Both the private writer and its matching reader
invert that bit. Perspective and front/back clipping keep their existing bit
order. This patch applies to VIEW only; it does not change VPORT encoding.

The ASCII DXF reader repair delays display escape decoding until record context
is known. XRECORD values and XDATA group 1000 strings keep literal CIF/MIF,
caret and JSON escape sequences; display text, FIELD expressions and known
identifiers retain their existing decoding. The helper independently captures
ordered literal payloads from the bounded source DXF and compares them with the
typed import before creating output. Missing source identities, incomplete
XRECORD subclass/cloning headers and altered or missing literals refuse export.
The strict metadata snapshot then compares those verified typed strings after
DWG reopening. This repair covers the helper's UTF-8 ASCII DXF input; binary DXF
and arbitrary opaque native object records remain outside its input contract.

The helper separately compares full typed named VIEW parameters and the retained
DICTIONARY, DICTIONARYWDFLT, FIELD, FIELDLIST, XRECORD, GROUP, DBCOLOR,
MLEADERSTYLE, DICTIONARYVAR and SCALE graph, source CLASS definitions and the
repaired header fields. It preserves
reference kind, order, ownership, common reactors/extension dictionaries and
typed XDATA. Symbol names/control roles and dictionary-key/field-child paths
identify objects when storage handles change; unrooted objects require unchanged
handles. Literal strings and binary payloads are never treated as handles.
Integer values, including XRECORD int64 values beyond 2^53, compare exactly.
Incomplete XRECORD payloads, incoherent group-code/value or reference schemas,
missing owned objects, duplicate dictionary keys and unknown object classes
refuse export before replacement. These checks cover the typed interchange
subset; they do not certify arbitrary opaque native object records. A bounded
source schema guard rejects unconsumed properties of these supported records and
requires every source OBJECTS identity to survive native import. Other typed
object payloads and meaningful header values require the separate, mandatory
LibreDWG projection comparison in the host before the destination is replaced.
No generic stock-object or unknown-property exemption bypasses that comparison.

The native test fixtures `autocad-header.dxf` and `autocad-mleaderstyle.dxf` are
unchanged HEADER and MLEADERSTYLE record slices, with minimal section framing,
from the independently AutoCAD-authored `r2018-views-fields.dxf` (SHA-256
`3e4ec8f3f3fe9ddd91b21f627adfc3b8b2dc3657f6f11fdae4832c57bd70a857`). They
test actual stock values and common links; mutation tests exercise group/color/
style loss, unknown properties, conflicting annotation settings and class
declarations. Controlled Windows native CI compiles and runs these checks.

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
