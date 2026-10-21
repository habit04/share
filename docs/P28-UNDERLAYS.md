# P28 — Specialized 2D / PDF, DGN, DWF underlays

Status: slice 1 implemented on `muse/p28-underlays` as pure isolated
modules (unadmitted prototype — see PROPOSAL-P28 in the six-pipeline
ledger). Nothing is wired into the Entity union, the document, the
readers/writers, the renderers or the editor yet.

## Gap audit (base 038cb7b4, tree d1528615, read 2026-10-21)

Method: direct read of `src/core/entities.ts`, `src/io/dxf/read-pass.ts`,
`src/io/dxf/read-entities.ts`, `src/io/dxf/read-sections.ts`,
`docs/SUPPORT-MATRIX.md`, plus repo-wide `underlay|DGN|DWF` searches.
(Old checklist rows were not trusted; `docs/REMAINING-2D-CHECKLIST.md`
is a historical integration log, not a feature matrix.)

### Already done — explicitly out of P28 scope

- PDF **export/plot** with font embedding/subsetting/shaping
  (`src/io/pdf*.ts`, priority 12) — complete; not an underlay reader.
- Restricted-PDF host flow (Electron, qpdf) — complete; unrelated.
- Xref loading + read-only broker (`src/io/xref-loading.ts`,
  `electron/xref-read.cjs`, priority 20.2) — complete; underlays must
  not reuse or extend it (CONTRACTS §7.4).
- Raster IMAGE entity (IMAGE + IMAGEDEF + IMAGEDEF_REACTOR) with frame
  display — complete; it is the template for the underlay model.
- 3D, SHX, hatch pattern/clip and viewport work — complete; excluded.
- `src/render/viewport.ts` has a generic `underlay` paint callback —
  a drawing hook (used by the Symbol Builder), NOT an underlay entity.

### Truly missing (the P28 gap)

1. **Underlay entities are dropped on import.**
   `src/io/dxf/read-pass.ts` lists `PDFUNDERLAY`, `DWFUNDERLAY`,
   `DGNUNDERLAY` in `UNSUPPORTED_REASONS`; they are not in
   `RAW_KEEP_KINDS`, so read reports them `dropped` and an ordinary
   save loses the placement, the definition reference and the stored
   file path. `docs/SUPPORT-MATRIX.md` confirms: "UNDERLAY (PDF / DGN
   / DWF) … Dropped and reported." There is no underlay entity
   variant, no definition model, no codec, and **no underlay fixture**
   anywhere in `fixtures/` or `tests/`.
2. **No referenced-content decoding for underlays.** The repo has no
   PDF reader/rasterizer in the app (PDF code is write-side), no DWF
   reader and no DGN reader, and no decoder dependency that could
   serve (runtime deps: libredwg-web, electron-updater, hershey,
   js-yaml). DWG import of underlays rides the same gap (LibreDWG
   records are not modeled either).
3. **Other specialized-2D entities also dropped on read** (audit
   completeness; NOT all P28 scope): WIPEOUT, MLINE, TOLERANCE,
   SHAPE, OLE2FRAME/OLEFRAME, ACAD_PROXY_ENTITY, ARC_DIMENSION,
   ARCALIGNEDTEXT, RTEXT, HELIX, plus 3D-only MESH/SURFACE. Of these,
   only the underlay family is P28's brief; the rest are recorded
   here so the audit is honest, and stay with the roadmap owners.
   ATTDEF outside a block definition is likewise dropped.

## Slice 1 (this delivery)

- `src/core/underlay.ts` — retained sibling reference model on the
  ImageEntity/IMAGEDEF_REACTOR template: `UnderlayDefinition`
  (stored path verbatim — never normalized/resolved/rewritten,
  page/sheet/model name, optional probed extent, retained groups) and
  `UnderlayPlacement` (definition handle, layer, insertion, scales,
  rotation, group-70 flags, contrast/fade, clip boundary, retained
  groups). Total atomic validation; corner/bounds math; a pure
  display/plot op list: frame + cross + label without decoded content
  (the IMAGE-without-a-bitmap behaviour), an `image` op when a decoder
  supplies content, a transformed `clip-frame` op when clipping is on,
  and no ops at all when the underlay is off. Pairing is guarded
  (acceptance F-B): `validateUnderlayPair` names a placement/definition
  mismatch, the display list serves no ops for a mismatched pair, and
  corners/bounds raise `UnderlayCorrespondenceError` — a placement is
  only ever served the definition it references, never silently
  re-pointed at another file.
- `src/io/dxf/underlay-codec.ts` — group codec for the three
  `*UNDERLAY` entity records and the three `*DEFINITION` objects.
  Modeled groups are parsed; **every** other group is retained
  verbatim, in order (duplicate scalars: first value modeled, the rest
  retained); malformed modeled data refuses the whole record
  atomically with a reason. Subclass (100) markers are regenerated
  canonically on write. Round-trip preserves the group multiset —
  including for defaults (acceptance F-A): a modelled group whose value
  equals the canonical default the writer omits (layer "0", unit
  scales, rotation 0, flags = on) also rides `retainedGroups` verbatim,
  and an absent group 70 is never invented on write, so explicit
  defaults stay explicit and absence stays absent.
- `src/io/underlay-adapter.ts` — the bounded adapter seam. Today it is
  a probe using only in-repo code: PDF header/version/`%%EOF` checks
  and a page count. The count is the largest `/Count` found, but
  `pageCountExact` is earned, never assumed (acceptance F-C): exact
  only when the scan covered the whole file, the reported count is a
  page-tree node's own `/Count` (a dictionary carrying `/Kids`), and
  the page objects the scan itself found do not outnumber it — any
  other count is reported as the document's claim, marked inexact,
  exactly as the page-object fallback already was. DWF `(DWF V…)`
  signature identification, DGN refused as
  `unsupported` until a decoder is admitted. Hard caps on input bytes,
  scanned bytes, page count and deadline; cooperative cancellation;
  typed refusals; never throws; performs no I/O and never writes the
  referenced file.

### Invariants held

- References stay references: nothing flattens an underlay into
  drawing geometry, and the referenced source file is never touched.
- No silent loss: unmodeled DXF data rides `retainedGroups` end to end.
- Integration obligations (for the admitted wiring slice): assemble
  definitions through `validateUnderlayDefinitions` and REPORT
  duplicate handles/ids as collisions — two definition records can
  share a handle and derive the same id, and a handle/id-keyed assembly
  must never silently overwrite one with the other; resolve each
  placement's definition through `validateUnderlayPair` and surface
  mismatches instead of serving the pair.
- Refusal is atomic at every layer (validation, codec parse, probe).
- No xref coupling: the model never registers as an xref block and
  never touches `XrefStore`/`XrefSnapshot` or xref limits.
- Undo/redo/dirty, Canvas, selection, layouts, plots, autosave and
  recovery are untouched — slice 1 changes no shared file at all.

## Limitations — what slice 1 does NOT prove

- **Not integrated.** Until PROPOSAL-P28 is admitted and implemented,
  the shipping reader still drops underlay records exactly as on base;
  slice 1 proves the model/codec/probe contracts in isolation only.
- **No content rendering.** The probe identifies and counts; it does
  not rasterize. Real PDF page display needs an admitted decoder
  (PROPOSAL-P28-DEP, PENDING-CLAUDE). DWF/DGN content likewise.
- **Clip boundary convention** follows IMAGE's 14/24 point pairs; it
  must be verified against native AutoCAD fixtures at the Windows
  gate (no underlay fixture exists in the repo to check against).
- **DWG acceptance is separate** and untouched: nothing here speaks
  DWG, and DXF results must not be read as DWG results.
- Linux/headless test evidence only; Windows, Electron-packaged and
  native AutoCAD behaviour are separate HOLD gates (Claude schedules).

## Fixture recipes for the lead (native gate — lead builds via headless accoreconsole)

Per the lead's fixture policy, P28 sends recipes, not binaries. Requested
handbuilt fixtures (all paths inside files must be generic relative
names — no local paths or usernames; repo is public):

1. `underlay-pdf.dxf` (AutoCAD-saved, R2018): one PDFUNDERLAY in model
   space referencing `floor.pdf` (any 1-page PDF), PDFDEFINITION with
   the page name stored; placement at a non-origin point, rotation
   30°, non-unit scales, flags with clipping ON and a 4-point clip
   boundary (verifies the codec's 14/24 boundary convention), contrast
   80 / fade 15. Plus a second PDFUNDERLAY with clipping OFF.
2. `underlay-dwf.dxf`: one DWFUNDERLAY + DWFDEFINITION (any small DWF),
   default placement.
3. `underlay-dgn.dxf`: one DGNUNDERLAY + DGNDEFINITION (any small V8
   DGN), default placement.
4. DWG twins of 1–3 saved natively, for the separate DWG gate.
Each fixture: open in AutoCAD, attach, save, close, reopen, confirm the
underlay still displays — then commit the file plus a one-line
provenance note (AutoCAD version, accoreconsole script used).

## Next slices (in order)

1. Integration per admitted PROPOSAL-P28 (entity variant + optional
   DrawingState sibling for definitions, READ_KINDS/read-pass wiring,
   writer + cad-graph retention, Canvas + plot via the op list,
   import-report entries `kept`/`simplified` instead of `dropped`).
2. Clips/transforms/layers UX, geometry snapping to decoded content,
   refresh/relink — on top of the integrated model.
3. Decoder admission (PROPOSAL-P28-DEP) → PDF raster display; then
   separate DWF and DGN slices, each behind its own admitted decoder.
4. Native fixtures: AutoCAD-authored DXF (and DWG) files carrying all
   three underlay kinds, produced at the Windows gate, added to
   `fixtures/` with provenance before any native claim is made.

ETA (implementation only): slice 2 integration ≈ 2–3 working days once
PROPOSAL-P28 is admitted (mostly exhaustive-switch and codec wiring);
PDF raster display ≈ 3–5 days after a decoder is admitted. Review and
Windows/native gates are external and excluded from these estimates.
