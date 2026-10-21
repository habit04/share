# Interchange fixture provenance

Most fixtures in this directory are synthetic drawings that were opened,
audited and normalised by a real AutoCAD (their own `.md` notes say so, and
their headers carry AutoCAD's real stamps). Five R2018 files were the
exception: they were **written by hand from the public DXF reference** (see
the header comment of `tests/interchange-fixtures.test.ts`) and had never
been saved by AutoCAD.

On 2026-10-21 four of the five were replaced by **genuine AutoCAD 2027
R2018 saves** (the lead's headless build from the fixtures' recipes; AUDIT 0
at build and at reopen; all AC1032, `$ACADMAINTVER` group 90 value 427,
`$LASTSAVEDBY` Autodesk), one commit per fixture on
`muse/fixture-swap-genuine-five`:

- `r2018-dimensions.dxf` — SHA-256
  `3bd53ce4a138be820d78de6db39469ab9d825a81727b836aadbae3bde3b89547`
- `r2018-image-inches.dxf` — SHA-256
  `f8f7158ee368407fd986ed49f6322a3a6449b5cd34bf5b945e5a0b1002d9faa6`
- `r2018-mtext.dxf` — SHA-256
  `318b3215dececf196ef4623cfa8742a29d315c282e172b553f3b8d6a2df0cab8`
- `r2018-truecolor-linetypes.dxf` — SHA-256
  `57156d1465c190551d0dfe45b104291f5791a751e026e8cc6c02bc90f2fcf78d`

The differences between each genuine save and the recipe it was built from
are recorded in the lead's per-fixture checklists; the test re-pins that
discharge them are listed in the swap delivery's README, one commit per
fixture, each traced to a checklist item.

`r2018-table.dxf` is **still the hand-authored synthetic** (SHA-256
`8993e9afcff1b891e08d746ea47c9608c070c82df22cc614dc5c063b4da0fcd3`). Its
genuine counterpart was built and verified the same way, but the swap of
that one file is held: importing the genuine file produces the AutoCAD
template's retained-object report items (`kept` retentions), which the
import-report assertion in `tests/interchange-fixtures.test.ts` — written
against the synthetic's minimal content — does not admit, and no checklist
item or recipe flag authorises re-pinning that assertion. It lands, with its
four checklist-traced re-pins, when the lead rules on that assertion.

## The synthetic marker (r2018-table.dxf, still)

The hand-authored file declares `$ACADVER AC1032` but carries
`$ACADMAINTVER` as group **70**, value **105**. Genuine AutoCAD R2018
output writes that variable as group **90**, value **427** (the genuine
R2018 fixtures in this directory — `r2018-complex-linetypes.dxf`,
`r2018-font-metrics.dxf`, `r2018-gradient-hatches.dxf`,
`r2018-ordinate-dimensions.dxf`, `r2018-shx-text.dxf`,
`r2018-viewport-polygon.dxf`, `r2018-field-object-reference.dxf`,
`r2018-minsert.dxf`, `r2018-unicode-metadata.dxf`,
`r2018-views-fields.dxf` — all carry `90 / 427`, as do the four genuine
replacements above). The published DXF reference lists `$ACADMAINTVER` at
group 70, which is where the hand template took it from; AutoCAD itself
switched the group code at R2018. AutoCAD 2027 **refuses** a group-70
`$ACADMAINTVER` at AC1032 ("Error 50 in drawing header … drawing
discarded"), so the remaining synthetic file is not native-openable as a
complete drawing — a fact this directory already records for one of the
older fixtures (`r2018-complex-linetypes.md`: the older truecolor fixture
"is not native-openable as a complete drawing: AutoCAD rejects its header
at `$ACADMAINTVER = 105`").

JCad's writer never emits `$ACADMAINTVER`; the pair reaches a written file
only through the cad-graph header-retention path, which re-emits a read
drawing's header variables verbatim. Fresh JCad writes carry no
`$ACADMAINTVER` at any version. (The P22 lineage carries a version guard
on that retention path and its own copy of this file; the two copies are
reconciled at integration.)

## Consumers (as of the fixture swap, base c01de5d3)

- `r2018-table.dxf` (still synthetic): `tests/interchange-fixtures.test.ts`,
  `tests/helpers/autocad-export.ts`, `tests/fixtures/manifest.json` (the
  fixed-point sweep).
- `r2018-dimensions.dxf`: `tests/interchange-fixtures.test.ts`,
  `tests/cad-graph-annotations.test.ts`,
  `tests/dimension-override-provenance.test.ts`,
  `tests/dimension-remaining-compatibility.test.ts`,
  `tests/dimension-style-traversal.test.ts`,
  `tests/gpu-dimension-strokes.test.ts`,
  `tests/helpers/autocad-export.ts`, the manifest sweep.
- `r2018-image-inches.dxf`: `tests/interchange-fixtures.test.ts`,
  `tests/cad-symbol-tables.test.ts`, the manifest sweep.
- `r2018-mtext.dxf`: `tests/interchange-fixtures.test.ts`,
  `tests/mtext-background.test.ts`, `tests/mtext-column-flow.test.ts`,
  `tests/text-remaining-compatibility.test.ts`, and as a DWG-writer source:
  `tests/dwg-fidelity.test.ts`, `tests/dwg-native-read.test.ts`,
  `tests/dwg-protocol.test.ts`, `tests/dwg-xdata-merge.test.ts`,
  `tests/native-dwg-runtime.test.ts`, `tests/helpers/autocad-export.ts`,
  `scripts/e2e-2d-batch.mjs`, `scripts/e2e-cad-fidelity.mjs`,
  `scripts/native-dwg-build/` — plus the manifest sweep.
- `r2018-truecolor-linetypes.dxf`: `tests/interchange-fixtures.test.ts`,
  `tests/cad-graph-dxf.test.ts`, `tests/complex-linetype-dxf.test.ts`,
  `tests/dwg-linetype-compatibility.test.ts`, the manifest sweep.

## Assertion dependence on the bogus header pair

No test names `$ACADMAINTVER` or asserts the value 105. Whole-file and
fixed-point comparisons over the remaining synthetic fixture (the
interchange fixed-point sweep, the table round trips) implicitly carry the
retained `70 / 105` pair today: replacing that fixture will move those
comparisons and must land as its own disclosed change — as the four
replacements above did.
