# Partial import of expensive block references

DXF and DWG imports can exclude an individual block reference whose expansion
exceeds the geometry budget, then open the remaining drawing with an import
report. The original file is read without being rewritten. Use Save As to keep
the partial result in another file.

## Chinese text fallback

Missing stroke-font glyphs use an installed Unicode Canvas font for the whole
text run, preferring SimSun and Microsoft YaHei. Available native SHX glyphs keep
priority. Painting, bounds, fitting and wrapping use the same selected run. Source
strings, STYLE references and placement fields remain unchanged; a substitute
typeface can still differ from the drawing's original SHX font.

Captured PDF font reads now validate the plotted glyphs, their composite components
and capital A under the unchanged 2,000,000-point budget. This removes the
whole-face point-work obstacle for eligible fonts. Screen metrics still use eager
whole-face validation and Canvas fallback. See [PDF font embedding](PDF-FONT-EMBEDDING.md).

Installed SimSun remains refused on the reviewed Windows machine: the used-glyph
read clears the point-work obstacle but reaches the capital-A/origin gate because
embedded bitmap strikes cover that glyph and existing policy marks it unknown.
The recorded error is "the native capital A glyph must have a known origin and
positive yMax". Microsoft YaHei instead refuses with conflicting PostScript
nameID6 records. Identity, permission, bitmap/origin and work limits are preserved.

The combined vector path refuses Han text when its matching font program or run
cannot be used, and directs the user to Raster image output. This explicit
refusal replaces unreadable stroke substitution; it does not establish Chinese
vector embedding or extraction compatibility.

## F3/F4 combined Windows source review

The DWG owner's `c2cb121` results are historical, separate from this combined
priority-12 review. Eleven authored font-composition regressions pass: missing-SHX
text is collected under its final fallback face, available native SHX keeps
priority, selected TTC-face identity and used-glyph limits are retained, and
unknown bounds/origins and embedding permissions still refuse. A positive authored
fixture uses a visible rectangle mapped to a Han codepoint; it is not a faithful
Chinese typeface or installed-font acceptance test.

Combined source `167c50b6b57d700f6d22da3ec6212e5a4a14afac` passes the Windows
Electron 44.7.2 workflow: Open, title edit, undo/redo, source-overwrite refusals,
DXF-copy save/reopen and Plot. All 63 F4 assertions and 721 independent native
receipt/raw-DXF checks pass. The unrelated same-string diagram label is retained.
Title placement and actual resolved appearance, five unit-height metrics and font
size match after reopening within the unchanged absolute `1e-7` criterion.

Effective STYLE records are checked explicitly. Existing DXF writing normalizes
a blank font without a family to `txt`, for both Standard and named styles; all
other tested STYLE properties remain equal. This is not exact source font-string
preservation. Undo retains the existing conservative dirty state. Plotting and
refused writes preserve document identity, contents, history, dirty state and path.

Both declared-TTF and missing-SHX Han vector cases refuse without producing a
PDF and give Raster image guidance. Raster output passes nine independent
structure/render checks and visual inspection of readable Chinese text. The
authored positive embedding case separately passes 132 independent checks.
Source, font and private-input hashes remain unchanged; only owned test processes
are closed. These source checks do not certify installed-package or AutoCAD use.

The broader PDF inspector retains one known external Poppler missing-Symbol
warning on its Helvetica fallback control; the strict warning assertion remains
failed. Six existing consumed-ticket cancellation diagnostics also remain in the
main log. No clean-stderr, remote-CI, merge or release clearance is claimed.

## Standalone attribute definitions

ATTDEF objects outside block definitions are not modeled as ordinary TEXT. A
checked native graph can retain their source records without displaying them.
Without such a record, the import report explicitly lists their exclusion with
source handle, layer and space. Missing default strings are never invented, and
invisible definitions are never made visible by text substitution.

## Copy format limits

Save As still applies each output format's preservation checks. A different DWG
destination can be refused if the independent metadata projection is incomplete;
partial opening does not bypass this check. The DWG owner's private drawing
reproduced an existing projection omission of 16 blocks on both the baseline
importer and the candidate, while AutoCAD saw the records in the intermediate DWG.
That owner's DXF copy saved, reopened and passed the independent native
text/signature comparison. The original AutoCAD AUDIT reported 748 errors and the
DXF copy one error, with zero repairs in either run. These historical results do
not certify a portable DWG round-trip or an audit-clean drawing.

For retained DXF data and checked Windows DWG metadata, exclusion uses the same
CAD graph erase rules as an editor operation. Owned attributes, sequence ends,
dictionaries and other owned records disappear with the reference. Detachable
references are repaired. Unrelated entities, fields, tables, layouts and source
metadata remain retained. Erased raw fallback records are removed too, so saving
a copy cannot restore content that the report says was excluded.

Native DWG projection reads preserve every source identity during the internal
inventory check. Recovery runs after the projection has been joined to the
trusted geometry by exact source handles.

## Cases that still refuse to open

The geometry and allocation budgets are unchanged. Recovery refuses an unsafe
hard dependency, a cyclic expansion failure, block definitions that exceed the
budget by themselves, and failures that cannot be isolated to a space-level
block reference. A plan requiring more than 64 reference exclusions also fails.
Failed plans publish no successful exclusion report and leave the caller's
source state untouched.

## Bounded report accounting

Reports retain at most 1,000 detail rows. Exclusions take priority over ordinary
remarks when a detail row can be exchanged safely; aggregate counts and the
number of omitted rows still describe every reported item.

A private index retains only the type, canonical source handle and four action
counts for omitted source identities. It stores no omitted reason text. This
lets recovery change an earlier `kept`, `simplified` or `unsupported` item to
`dropped` without counting the same earlier item again, even after its detail
has been omitted. The index is limited to 250,000 source identities, matching
the retained graph's node bound. If another identity would exceed this budget,
the import refuses before changing the report's counters. It does not guess
whether omitted source data was retained.

Counts represent report items, including property remarks and owned metadata
records. Several remarks about one source object can therefore contribute
several items. When they are reclassified, their total remains unchanged.

## Regression coverage

`tests/graph-import-recovery.test.ts` checks exclusion and copy/reopen behavior,
owned raw-record removal, unrelated AutoCAD-authored metadata preservation,
hard-dependency refusal, atomic plans, a complete synthetic native projection,
and exact report accounting beyond the detail cap. The synthetic projection
test exercises the shared identity-join contract; it does not replace a real
Windows decoder or installed-build check.
