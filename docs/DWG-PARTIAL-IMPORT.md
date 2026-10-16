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

The Windows font-program reader keeps its existing identity, permission and work
limits. On the tested machine, SimSun exceeds that reader's glyph-work limit even
though Windows can render it. Vector PDF export therefore refuses unreadable
Unicode substitution and directs the user to Raster image output when a matching
font cannot be embedded. Font parser optimization belongs to the separate PDF
font workstream; no limit is raised here.

## Standalone attribute definitions

ATTDEF objects outside block definitions are not modeled as ordinary TEXT. A
checked native graph can retain their source records without displaying them.
Without such a record, the import report explicitly lists their exclusion with
source handle, layer and space. Missing default strings are never invented, and
invisible definitions are never made visible by text substitution.

## Copy format limits

Save As still applies each output format's preservation checks. A different DWG
destination can be refused if the independent metadata projection is incomplete;
partial opening does not bypass this check. The tested private drawing reproduces
an existing projection omission of 16 blocks on both the baseline importer and the
candidate, while AutoCAD sees the records in the intermediate DWG. Its DXF copy
saves, reopens and passes the independent native text/signature comparison. This
does not certify a portable DWG round-trip or eliminate the drawing's audit issues.

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
