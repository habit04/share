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

## PDF wiring slice (this delivery — RULING-P28 C1–C9 + P28-DEP FINAL ruling 2026-10-21)

The integration and the PDF raster path, built against pdfjs **behind an
interface** so the engine stays swappable. Composition into the integrated
head remains P28's turn (FIFTH, C9) — this is a development slice.

### Engine seam (`src/io/underlay-engine.ts`, `src/io/underlay-pdfjs.ts`)

`UnderlayRasterEngine` is the whole contract: `open(bytes)` → a document
with `pageCount`, `pageSize(page)`, `renderPage(page, scale)` → a raster,
`close()`. Failure is a typed refusal in the slice-1 probe vocabulary —
never a throw across the seam. The ONLY file importing `pdfjs-dist`
(exact pin **6.4.299**, Apache-2.0, notice in `THIRD-PARTY-NOTICES.md`) is
`src/io/underlay-pdfjs.ts`; pdfjs loads lazily on first open. Every other
P28 consumer (the display service, the draw path) depends on the interface
alone and is tested against a fake engine with zero pdfjs import.

Dep-ruling conditions as implemented: `isEvalSupported: false` AND
`enableScripting: false` are set expressly on every `getDocument` call
(in pdfjs 6 the eval evaluator itself was removed — the former is
belt-and-braces, verified absent from the pinned build); pdfjs runs in a dedicated worker
(`src/io/pdfjs-worker-entry.ts`, emitted by Vite under `assets/worker/`,
served by `electron/renderer-origin.cjs` with the path-scoped WORKER_CSP
`script-src 'self' 'wasm-unsafe-eval'` + `connect-src 'self'` — the same
posture as the manifold kernel worker; **no electron change was needed**
and the page CSP is untouched); ALL C5 caps are enforced inside the
adapter (64 MiB input before parsing, 10,000 pages, 8 MiB per-page
rendered pixels charged BEFORE rendering, 5 s per-operation deadline,
AbortSignal cancellation). The malformed-PDF corpus
(`tests/underlay-pdfjs.test.ts`: truncated, bad xref, encrypted without a
password, non-PDF bytes, absurd page-count claim, zero-page) yields a
typed refusal or a bounded render for every case, deterministically,
with no network.

### Model integration (C1–C8)

- `UnderlayEntity` in the entity union: the C1 placement fields; group 5
  is `EntityBase.cadIdentity`, group 8 is `EntityBase.layer` — neither
  stored twice. The bridge to the isolated model is
  `underlayPlacementOf(e)` in `src/core/entities.ts`.
- Definitions live in the `DrawingState.underlays` sibling keyed by
  definition id (C2). Id minting: the codec's `underlaydef:<HANDLE>`; a
  repeat gets `~2`, `~3`, … in file order — collision-free across
  definitions and (by the `underlaydef:` prefix) against entity ids.
  Reader post-pass join: `placement.definitionHandle ===
  definition.handle`. Unreferenced definitions are retained and written
  back; a dangling placement is kept, reported `simplified`, and displays
  as frame+cross with no path label.
- Import-report semantics (C3): `kept` ⟺ placement modelled AND
  definition modelled; `simplified` ⟺ definition missing (the only
  simplified case); a codec-refused record is dropped with the codec's
  reason and never aborts siblings. No referenced-file I/O at import —
  bytes reach the engine only through the injected byte source of the
  display service.
- C5: `entityGeometryWork` charges the variant's actual stored size
  (clip-boundary points + retained-group count); definitions are not
  entities and carry no entity work.
- C6 disposition (for the coordinator to file in LEDGER.md before this
  slice composes): in graph-carrying states the model/codec is
  authoritative for *UNDERLAY/*DEFINITION content; the retained node
  supplies only unmodelled extras through the merge. The cad-graph diff
  is exactly three entries: the DEFINITION dedupe key
  `['underlay', kind, group-1]` beside IMAGEDEF's `['image', group-1]`,
  the underlay entity kinds in the rebuilt-pointer set with `{340}`, and
  the kinds in the metadata exclusion list. Round-trip evidence: exactly
  one *UNDERLAY and one *DEFINITION per model pair, retained groups
  neither doubled nor lost, second save byte-stable.
- C7: the sibling rides every state spread (transact, outsideHistory,
  project()/paper-space, load, undo/redo) — proven in
  `tests/underlay-integration.test.ts`; definition mutation only via
  `Drawing.transact` (no definition-editing UI in scope).
- C8: definitions emitted in OBJECTS through the codec on the
  IMAGEDEF-from-extras pattern (stored path verbatim, never normalised);
  definition handles allocated in an identifiable pre-pass in
  `writeDxf` before ENTITIES emission; CLASS registrations for the three
  entity + three definition kinds presence-gated; the no-underlay fixed
  point is proven by the existing byteproof/interchange suites (zero
  underlay output for drawings without underlays).

### Consumer census (C4) — switch audit

| Consumer | Behaviour |
| --- | --- |
| `affineCompound` / `similarityTransform` / `blockTransform` / `mirrorEntityAcross` | frame transform via the compound path; rotation from the transformed X axis, scales from directional magnitudes |
| `entityTypeName` | `PDFUNDERLAY` / `DWFUNDERLAY` / `DGNUNDERLAY` by kind |
| `compoundParts` (widened) / `underlayParts` | frame polyline + cross lines — the same generated parts for bounds, snap, selection, hit-testing, Canvas fallback and the vector plot; NO label (path lives on the definition) |
| `entityBounds` / `distanceToEntity` / `gripPoints` / `moveGrip` / `snapCandidates` / `entitySegments` | via the frame points / parts; a point inside the frame is distance 0 |
| `drawEntity` (Canvas + raster plot via `plotting.ts`) | consumes `underlayDisplayList`: image op draws the engine raster into the frame quad; frame/clip-frame/cross/label ops become primitives; no definition → `underlayParts` fallback |
| `pdf-vector.ts` (vector plot) | consumes `underlayParts` — a placed reference plots as its frame, never decoded content |
| `selection.ts` polygon segments / regions | via `compoundParts`, beside `image` |
| `properties.ts` (both `image` sites) | truthful kind / path / page / flags rows joined to the definition by handle; type name per kind |
| `api.ts` `normalizeEntity` | stated rule: placements are NOT plugin-authorable in this slice (refused with a named error, like every compound/reference type's absence from `ENTITY_TYPES`); placements arriving from DXF are gated by the codec + `validateUnderlayPlacement` (via `geometryProblem`) |
| `drafting-modify.ts` STRETCH | whole-entity translate by insertion point, beside `image`/`table` |
| `inquiry.ts` LIST | kind, insertion, definition handle, joined path/page |
| `explodeCompound` | returns **null** exactly: a reference does not explode into its referent (the IMAGE precedent); no decoded content is invented |
| `geometryProblem` (import-report) | explicit `underlay` case: first `validateUnderlayPlacement` problem, or null |

Not edited, per C4: `src/core/constraints/*`, `src/ai/*` (its snapshot
switch keeps its existing default for the new variant), `scene-sink.ts`
(its `default:` already routes through `entitySegments`),
`src/app/editor/selection.ts` (a LIST-log switch over six types; other
types simply have no log line there).

Transform semantics: transforms move position/rotation/scales and never
touch `definitionHandle`, `retainedGroups`, or the definition's
`sourcePath`. The clip boundary is **definition-space** data (page
coordinates, like an IMAGE's pixel clip): it is stored verbatim under
transforms — its world outline follows the frame. Mirroring follows the
corner-sequence: the mapped frame is the exact reflection, so quad-drawn
content mirrors correctly.

### Display service (`src/app/underlay-render.ts`)

Resolves placements → definitions, opens PDF bytes through the injected
byte source + the engine interface, caches one raster per definition
(long-edge target 1024 px, engine caps still rule), and serves the draw
path synchronously (frame + label while loading or after any failure —
the IMAGE bitmap-cache pattern). Page selection: the definition's page
field as a numeric 1-based index; named destinations (`Sheet1`) are NOT
resolved in this slice — they open page 1. DWF/DGN definitions are never
opened. The desktop bridge exposes no generic file-byte read today
(`read-image` returns data URLs), so no `main.ts` byte wiring exists in
this slice: the composition root installs the service when it has a byte
channel; until then placements render frame + label.

### Pre-composition acceptance obligation — the 8-class CAD corpus

The FINAL ruling makes the comparison's 8-class CAD corpus
(`reviews/P28-DEP-COMPARISON.md` §1.3: A linework precision, B line
weights & dashes, C hatches & patterns, D transparency, E text,
F large format incl. the 400% clipped-tile leg, G colour,
H adversarial/malformed) **P28's acceptance test before composition**.
It is NOT executed by this slice: classes A–G need ≥ 4 real CAD-plotted
files each plus reference rasters (Acrobat / Chrome print-to-image at
matched DPI) and human spot-point checks. What this slice lands is the
corpus-test SCAFFOLD, `tests/underlay-corpus-scaffold.test.ts`: the
class table with §1.3 floors and thresholds, per-class fixture
directories, the scoring rules restated, and classes A–G recorded as
explicit TODO cases (never silently skipped, never claimed as run).
Class H is the fuzz leg: its buildable cases are executed in
`tests/underlay-pdfjs.test.ts` and mapped expressly in the scaffold
(truncated, corrupt xref, encrypted-without-password, non-PDF bytes,
absurd page-count claim, zero-page, plus the C5 cap-containment tests);
the remaining class-H cases (recursive patterns, font bombs,
billion-laughs streams) need crafted fixtures and land with the corpus
population. The corpus binds to the engine interface's output, so it
survives an engine swap unchanged.

### What this slice does NOT prove

Native AutoCAD fidelity of the written underlay records (the lead's
fixtures recipes 1–3 + Windows gate at composition); DWG underlays (not
admitted); the full test suite (a composition precondition, stated
outstanding in the delivery VALIDATION).

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

## Corpus execution + F/H fixes (2026-10-22)

The 8-class corpus was executed at 7328a6c (pack
`p28-corpus-7328a6c.zip`, report inside): 27/36 files passed. The lead's
rulings on the failures produced this fix slice:

- **Class F (was 0/4) — clipped/tile rendering.** The engine interface
  gains `renderRegion(page, clip, scale)` and the pure planner
  `planUnderlayTiles(region, scale, maxBytes)`
  (`src/io/underlay-engine.ts`); the adapter renders a clip via pdfjs
  viewport offsets and charges the C5 per-page cap on the REGION's
  bytes. A 400%-zoom clip of an ARCH E / A0 title block now renders
  (single tile 5,939,200 B ≤ the 8,388,608 B cap) where the whole page
  at scale 4 needs 257–573 MB and still refuses `scan-limit`. The
  display service requests only the tiles covering a caller-supplied
  visible region and composites them into the page bitmap. Re-run at
  the fix head: F 4/4 (delivery addendum).
- **Class H — hard render deadline.** Every parse session owns a
  dedicated worker; a real-time watchdog cancels the render task,
  destroys the loading task and hard-terminates the worker at the
  deadline, surfacing the typed `deadline` refusal; the document then
  lazily re-opens a fresh session (fresh worker). Measured in real
  Chromium (Electron, dedicated worker): the billion-laughs render is
  refused at ≈5.01–5.07 s wall (deadline 5 s) and the engine renders a
  control document immediately afterwards. Under the Node test harness
  pdfjs renders in-process on a fake worker whose render loop never
  yields to the event loop (measured: zero timer ticks across a 121 s
  render), so there the refusal still arrives via the cooperative
  check when the render settles — the wall bound is a property of the
  real-worker deployment.

### Known limitations (engine, recorded 2026-10-22)

- **DEFECT — pdf.js axial shading inside a luminosity SMask form with
  a non-zero-origin /BBox is misplaced/suppressed (corpus D3).** A
  black rect masked by a white→black axial shading inside a form whose
  /BBox is [100 300 500 500] renders as if the mask were black
  everywhere: the rect is fully suppressed (registered samples
  (255,255,255) at the white end, middle and black end alike; expected
  ≈32 at the white end, ≈224 at the black end) — observed identically
  under @napi-rs/canvas and in Chromium. Bisection in the corpus run
  isolated the trigger to exactly this combination: solid white/black
  masks behave, an 8-strip gradient in the SAME offset BBox works
  (36 / 255), and the same axial shading in a full-page-BBox mask form
  works (32 / 224). This is an
  upstream pdf.js defect, NOT fixed by any available release:
  pdfjs-dist 6.4.299 (2026-10-03) is the newest version published on
  npm as of 2026-10-22 (registry-verified), and it is the pinned
  version. A minimal standalone repro PDF + note ship in the F+H
  delivery (`d-repro/`). No JCad-side workaround is attempted:
  luminosity-SMask shading masks render incorrectly until upstream
  fixes it.
- **Overprint is not simulated (corpus G4).** pdf.js does not
  implement overprint (/OP /OPM): an overprinting fill renders as a
  KNOCKOUT — the corpus overlap samples exactly the top fill's own
  colour-managed value (255,235,61), not the subtractive mix. Any
  underlay whose appearance depends on overprint preview will differ
  from Acrobat's overprint preview.
- **Minimum stroke width ≈ 1 device pixel (corpus A1 attribution).**
  pdf.js thickens sub-device-pixel strokes to ≈1 device px. At low
  zoom, hairline bands closer than ~2 device px merge into uniform
  halftone (ink mass stays smooth and monotonic; raw Chromium canvas
  strokes of the same geometry are area-true, so this is pdf.js's
  hairline preservation, not the platform rasterizer). At inspection
  scale the same bands resolve (measured: the 1 pt-pitch band at
  scale 4 resolves 81/81 lines at exactly its geometric darkness).
  Underlay linework at fit-to-screen zoom will look heavier than
  plotted output for sub-pixel strokes.
