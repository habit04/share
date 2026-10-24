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

## A purpose-built synthetic input (not one of the five)

`acadmaintver-malformed-pair.dxf` is **synthetic, hand-authored for one
purpose**: a minimal drawing whose header carries the malformed pair
(`$ACADVER AC1032` with `$ACADMAINTVER` as group 70, value 105) — the
Series 3 guard's named input, after the genuine swap retired the pair
from `r2018-table.dxf`. It is not AutoCAD output and must not be cited
as such. Consumer: `tests/header-acadmaintver-guard.test.ts` (its first
leg; the guard's genuine-pair controls stay on genuine files).
**Moved out of this directory** to `tests/fixtures/synthetic/` (lead
C-2 ruling on PR #39, 2026-10-22; content byte-identical) so this
directory holds only genuine AutoCAD saves.

## Assertion dependence on the bogus header pair

Exactly one test asserts on the pair: the Series 3 guard's named leg in
`tests/header-acadmaintver-guard.test.ts`, against the purpose-built
fixture above (a source carrying `70 / 105` at AC1032 must not re-emit
it). No other test names `$ACADMAINTVER` or
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
Consumers: `tests/table-p22-compn.test.ts`,
`tests/header-acadmaintver-guard.test.ts` (the genuine-pair and
version-move legs).

`r2000-table-autocad.dxf` (added by P22 F-2) is the same Recipe B table
saved by AutoCAD at **AC1015 (R2000)** — SHA-256
`17bb250ad21c68435ebcd4008645ee21d8e008ac6ce995aad679e7e6abddd256`,
from the lead's intake package `native-fixtures-p22-p18-claude`
(`fixtures/p22/p22-recipe-b-control-r2000.dxf`). It is the native oracle
for the pre-AC1032 per-cell form: group 177 override flags, the text in
a group 1 every cell carries (empty for merge-covered cells), the
140/170 overrides stated only where a cell departs from its row role,
after the text. Consumer: `tests/table-p22-f2.test.ts`.

## r2018-pdf-underlay-acad2027.dxf (added 2026-10-23, v0.6.4 review F-F)

A genuine **AutoCAD 2027 console DXFOUT** (AC1032) of a drawing holding one
PDFUNDERLAY on layer `U` (insertion 10,20, scales 2/2, flags 280 = 3, contrast
281 = 40, fade 282 = 10, two-point clip 11/21), produced at the v0.6.4
packaged-app gate (`v064-3e66ef6-packaged-gate-claude`, §B-1 step 3:
`native/run/UC-documented4/u-acad-out.dxf`, copied to
`probe/inputs-uacad/u-acad-2027.dxf`). AutoCAD opened the corrected input
with AUDIT 0 and wrote this file. SHA-256
`a3ddd0039f3f8a7688ef97a9ffe9625d247deaddcff85e52a8e3b2462fb4ec55`.

Two things to know when reading it: AutoCAD's console DXFOUT left the
PDFDEFINITION object out, so the placement's 340 (`41`) dangles (JCad
reports it `simplified` and keeps the reference verbatim); and the CLASSES
section carries BOTH the correct `PDFUNDERLAY / AcDbPdfReference /
ObjectDBX Classes` registration and the stale `AcDbPdfUnderlay / ISM` one
that the pre-fix JCad writer had put into AutoCAD's input (AutoCAD kept it).
`tests/underlay-autocad-layout.test.ts` reads it and pins the record layout
JCad writes against it.

