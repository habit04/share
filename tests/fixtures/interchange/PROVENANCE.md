# Interchange fixture provenance

Most fixtures in this directory are synthetic drawings that were opened,
audited and normalised by a real AutoCAD (their own `.md` notes say so, and
their headers carry AutoCAD's real stamps). Five R2018 files were the
exception: they were **written by hand from the public DXF reference** (see
the header comment of `tests/interchange-fixtures.test.ts`) and had never
been saved by AutoCAD.

On 2026-10-21 all five were replaced by **genuine AutoCAD 2027
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
- `r2018-table.dxf` — SHA-256
  `83b59f3c5701a0bcb95e66a8371e78bd051d735e2e19549c06d1e790815dfde3`

The differences between each genuine save and the recipe it was built from
are recorded in the lead's per-fixture checklists; the test re-pins that
discharge them are listed in the swap delivery's README, one commit per
fixture, each traced to a checklist item.

The table landed last, as a follow-on commit. Its four re-pins are
checklist-traced (row heights #8; cell raws #11/#12; the title position
derived from #8), and its import-report predicate replacement is authorised
by **the lead's census-predicate ruling (2026-10-21)**: the
census-shape predicate in `tests/interchange-fixtures.test.ts` — every
import-report item is (STYLE, unsupported) or the ACAD_TABLE editing note —
is replaced by the strict no-loss form: (1) zero items with a dropped, lost
or simplified disposition (the one sanctioned ACAD_TABLE editing note
excepted), and (2) every item that is not a kept retention is (STYLE,
unsupported) or that note, with the note asserted present exactly once. The
genuine file is a full AutoCAD template drawing; its ~100 import-report
items are overwhelmingly `kept` retentions of template furniture, which the
original predicate — written against the synthetic's minimal content — did
not admit.

## The synthetic marker (retired with the table swap)

The hand-authored files declared `$ACADVER AC1032` but carried
`$ACADMAINTVER` as group **70**, value **105**. Genuine AutoCAD R2018
output writes that variable as group **90**, value **427** (the genuine
R2018 fixtures in this directory — `r2018-complex-linetypes.dxf`,
`r2018-font-metrics.dxf`, `r2018-gradient-hatches.dxf`,
`r2018-ordinate-dimensions.dxf`, `r2018-shx-text.dxf`,
`r2018-viewport-polygon.dxf`, `r2018-field-object-reference.dxf`,
`r2018-minsert.dxf`, `r2018-unicode-metadata.dxf`,
`r2018-views-fields.dxf` — all carry `90 / 427`, as do the five genuine
replacements above). The published DXF reference lists `$ACADMAINTVER` at
group 70, which is where the hand templates took it from; AutoCAD itself
switched the group code at R2018. AutoCAD 2027 **refuses** a group-70
`$ACADMAINTVER` at AC1032 ("Error 50 in drawing header … drawing
discarded"), so the synthetic files were not native-openable as complete
drawings — a fact this directory already records for one of the older
fixtures (`r2018-complex-linetypes.md`: the older truecolor fixture "is
not native-openable as a complete drawing: AutoCAD rejects its header at
`$ACADMAINTVER = 105`").

JCad's writer never emits `$ACADMAINTVER`; the pair reaches a written file
only through the cad-graph header-retention path, which re-emits a read
drawing's header variables verbatim. (P22 COMP-N Series 3 update: that path
now omits the variable when the written `$ACADVER` differs from the
source's or the (version, group code) pair is not the valid one — AC1015 →
group 70, AC1018+ → group 90; the value itself is never judged — so a
malformed pair no longer carries into a rewrite, while genuine pairs still
pass through verbatim.) Fresh JCad writes carry no `$ACADMAINTVER` at any
version. This file is the reconciliation of the two PROVENANCE copies the
swap and the P22 lineage each carried; there is one copy now.

## Consumers (as of the P22 rebase onto edceeeb4, 2026-10-21)

- `r2018-table.dxf`: `tests/interchange-fixtures.test.ts`,
  `tests/table-native-dxf.test.ts`, `tests/helpers/autocad-export.ts`,
  `tests/header-acadmaintver-guard.test.ts` (the Series 3 guard's named
  70/105 leg — inventory corrected at the COMP-N re-composition),
  `tests/fixtures/manifest.json` (the fixed-point sweep).
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

Exactly one test asserts on the pair: the Series 3 guard's named leg in
`tests/header-acadmaintver-guard.test.ts` (a source carrying `70 / 105`
at AC1032 must not re-emit it). No other test names `$ACADMAINTVER` or
asserts the value 105. Whole-file and fixed-point comparisons over the
synthetic fixtures (the interchange fixed-point sweep, the table round
trips) implicitly carried the retained `70 / 105` pair: each replacement
moved those comparisons and landed as its own disclosed change — the five
replacements above, the table last under the lead's census-predicate
ruling (2026-10-21). No synthetic fixture of the five remains.

## The genuine counterpart for tables

`r2018-table-autocad.dxf` (added by P22 COMP-N Series 1) is a genuine
AutoCAD 2027 R2018 table — the lead's Recipe B control, SHA-256
`d03b4283dc90911597c1f26bef91327eb20a9a265b7a648660e0a872ba8c3bfd` —
with a merged title, a text-height override at (2,2) and an alignment
override at (3,0), written in AutoCAD's AC1032 cell-value form. Table
claims that need a native oracle use it, not `r2018-table.dxf`.
