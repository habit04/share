# Windows PDF font embedding

This development milestone implements the standalone TrueType part of priority 12,
plus extraction of one collection face for embedding. It does not complete
priority 12, the font roadmap or certify an installed release.

The Windows plot bridge reads only installed Windows Fonts files, through the same confined,
bounded workers as metrics. Programs, permissions and geometry come from one race-checked file
read. Standalone glyf fonts with installable/editable embedding permissions are accepted.
A TrueType collection contributes the face selected for the requested family and
style: face identities (family name and OS/2 selection bold/italic flags) are probed
from the name and OS/2 tables only, the matching face is then parsed in full and
extracted whole by `electron/ttc-extract.cjs`, so metrics, glyph mappings, embedding
permissions and the embedded program all come from that one face. Selection is
deterministic: a requested family restricts candidates to that family's faces, a
requested bold/italic must match the face flags exactly, an unspecified style
prefers the family's regular face, and a request naming neither family nor style
keeps face 0. When no face of the family carries the requested style, or no face
carries the requested family, the previous explicit mismatch failure is reported
unchanged. Standalone files are unaffected. Extracted table bytes are copied
verbatim — glyphs, metrics, Unicode mappings and OS/2 permissions are preserved and
nothing is subset — while directory checksums and the head checkSumAdjustment are recomputed for the
standalone layout. The extractor is pure and bounded (64 faces, 128 tables, 64 MiB of
output) and validates collection headers, face offsets and table ranges before copying.
OS/2 permission versions are interpreted explicitly; full programs satisfy no-subsetting flags.
Restricted, bitmap-only and preview/print-only faces are refused. Preview/print requires a
read-only document mode that this exporter does not implement. See Microsoft's
[OS/2 specification](https://learn.microsoft.com/en-us/typography/opentype/spec/os2#fstype).

Each captured PDF owns copied programs and metric arrays outside drawing state, dirty state,
undo history, backups and autosave. Actual plotted groups determine font discovery, including
hidden layers, inactive layouts, viewport clip bounds and hidden annotative objects. Programs
are limited to eight faces, 64 MiB per face and 128 MiB total. Source font files and drawing
STYLE references are never rewritten. A later font read or tab change cannot alter prior faces,
the captured drawing or its output filename.

Glyph point validation on the captured-PDF path is scoped to the glyphs a plot actually
uses. The capture walk already visits every plotted string; its codepoints travel with the
PDF font request (bounded at 65,534 per face, validated at the host boundary), and the
metrics parse then decodes and validates outline points only for those glyphs, their
composite components and the capital-A glyph the native height gate requires. Every other
glyph keeps its advances, cmap entry and header box, but is marked as having unknown bounds,
so any run that reaches it falls back with a report instead of trusting it. The 2,000,000
point budget is unchanged and now applies to the validated set: a plot whose used glyphs
genuinely exceed it still refuses. This removes the whole-face point-work obstacle for
eligible large faces; bitmap/origin and permission checks must still pass. It does not
establish compatibility with every installed CJK font. The reader returns the complete
selected program; write-time subsetting is described below. Screen/interactive metrics are unchanged: they
keep the eager whole-face validation, so these faces continue to render on screen through
the existing Canvas fallback, and no budget was raised anywhere.

Used faces become FontFile2 programs, Type0 Identity-H fonts and CIDFontType2 descendants.
CIDToGIDMap and ToUnicode keep glyph identity, including distinct Unicode aliases and supported
supplementary characters. Native unkerned advances, capital-A height, bearings, FIT/ALIGNED,
width factor, oblique and rotation drive PDF text. Resources are shared across pages. The format
follows the [Adobe PDF reference](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.5_v6.pdf).

Embedded programs are subset at write time by `src/io/pdf-font-subset.ts` (priority 12.3):
a GID-preserving glyf subset keeps the used glyphs, GID 0 and composite components
byte-identical and empties the rest, so CIDToGIDMap, ToUnicode, widths and glyph metrics are
unchanged. Programs whose OS/2 fsType sets the no-subsetting bit are embedded whole, as are
programs subsetting cannot shrink or safely rebuild. The embedded `cmap` is kept verbatim
in this slice (trimming it is a named follow-up); CFF subsetting waits on CFF embedding (12.2).
Actual subsets receive distinct six-uppercase-letter tags in PDF BaseFont/FontName.
Whole-font fallbacks keep their original names and exact bytes. Rebuilt `maxp` counts
must fit their uint16 fields; unsafe counts retain the whole program. Valid ten-byte
zero-contour glyphs and bounded optional instruction spans are supported.

Unsupported/missing faces or unsupported runs use the existing Helvetica/stroke fallback and
the plot log reports substitutions. Browser plots keep their existing path. CFF,
variable/color fonts, uncertain glyph origins, contextual shaping and
preview/print-only embedding remain open. Within collection-face selection, what
remains open is acceptance, not selection. Two refusal causes are confirmed on
Windows by the lead and are classified separately from collection defects:

- Cambria face 0 (`cambria.ttc`) is refused with "the native capital A glyph must
  have a known origin and positive yMax", reproduced on the pristine base and on
  the candidate. It is a per-face data gate in the shared metrics reader, not a
  collection defect; the gate now applies to the selected face exactly as it did
  to face 0, and the refusal still ends in the reported fallback.
- Installed SimSun (`simsun.ttc`, family SimSun, regular) still refuses in this
  Windows review. Screen metrics retain the point-work refusal. Used-glyph PDF
  reads clear that obstacle but hit the capital-A/origin gate: embedded bitmap
  strikes cover the capital-A glyph and existing policy marks it unknown. The
  bitmap policy is preserved. Authored over-budget fixtures prove the scoped
  algorithm, not real SimSun admission. Microsoft YaHei (`msyh.ttc`) reaches a
  distinct conflicting PostScript-name refusal. SimHei and FangSong are absent
  from this Windows installation. These are explicit limits, not successful font
  compatibility checks; no fonts were installed or modified.

Real SHX decoding is priority 21. Native tall-glyph
MTEXT line leading remains approximate even when its font is embedded.

## Validation

- 80 installed-program reader tests and 97 shared metric-reader tests exercise path confinement,
  races, malformed programs, descriptors and permission versions. Eighteen worker-host tests
  include the actual Windows byte bridge and reject caller attempts to spoof its usage mode.
- TTC extraction adds 31 unit tests over authored collections (multiple faces, tables shared
  between faces, v1/v2 headers with signature fields, checksum recomputation, malformed
  offsets, truncation, and explicit face/table/output-size limits), six collection cases in
  the reader tests above (face-0 selection when a later face is restricted, and restricted,
  preview/print and bitmap-only refusals on the extracted face), and three synthetic integration
  tests. These use authored private-font fixtures to check extracted program embedding,
  ToUnicode mappings and CID text-content bytes (including a supplementary character).
  Restricted and malformed cases use a stubbed save bridge and verify logged fallback.
  They do not perform independent PDF text extraction or exercise the native worker IPC/Plot
  dialog route.
- Collection-face selection adds eleven regression tests over authored multi-face
  collections whose faces differ by family and style: bold and cross-family metrics
  selection (identity proven by subfamily, capital height and win descent),
  permission checks on the selected face in both directions (a restricted selected
  face refuses; a restricted face 0 does not block an editable selected face), and
  preserved face-0/explicit-failure behavior for unspecified and unmatched
  requests. Ten of the eleven failed on the pre-selection code. One synthetic
  end-to-end artifact (bold MTEXT run over a two-face collection) was additionally
  validated outside the writer with pypdf and Poppler: the embedded FontFile2
  program is byte-identical to the extracted bold face, its BaseFont is the bold
  face's PostScript name, and both tools extract the plotted text. These are
  Linux/headless checks over authored fixtures. Sixteen further regression cases
  cover reversed face order, partial/explicit style flags, TTC v2, malformed selected
  OS/2 data and selected-face permission variants. The two reversed-order cases
  failed before the review correction; unspecified flags now prefer the unstyled
  value while requests naming neither family nor style retain face 0.
- 36 resource tests and 17 integration tests use authored font fixtures. They check Unicode/CID
  mapping, program identity, permissions, capture isolation, font budgeting, placement, fallback,
  shared pages and legacy output. No third-party font programs or reference PDFs are tracked.
- Subsetting (12.3) adds 9 unit tests and 6 writer tests over authored fixtures: composite
  closure including nested composites, cycle rejection with whole-font fallback, Unicode
  aliases, supplementary glyphs, the no-subsetting bit, malformed programs and size
  reduction (a 45-glyph authored fixture embeds 1,008 bytes instead of 2,432 when one glyph
  is used). Independent Linux/headless pypdf and Poppler checks on a generated subset/whole
  pair extract identical text (`AB`), report the same CID TrueType/Identity-H font with
  ToUnicode, render byte-identical pages, and show FontFile2 at 784 bytes (subset) vs 812
  bytes (whole) for the five-glyph fixture. Native Windows Plot/IPC acceptance of subset
  output remains with the lead, as for the rest of this document.
- Separate private production-reader/PDF-writer contract artifacts passed independent pypdf and
  Poppler checks: authored `A` + U+20000 + `B`, and installed Nirmala UI collection face 0 `AB`.
  Checks followed FontFile2 descriptor links, program identity and CIDToGID mappings, extracted
  Unicode text and inspected rendered output. Source font files and drawing state stayed unchanged.
  This evidence does not exercise font-worker IPC, the Plot dialog, AutoCAD or an installed release.
- A subsequent direct Node worker/API proof read installed `Nirmala.ttc` through the production
  `createFontMetricsHost().readPdf()` with its default worker factory, resource limits and unchanged
  10,000 ms deadline. Face 0 extraction passed in 102 ms; the host was disposed and source/font
  hashes stayed unchanged. A worker-to-PDF case also passed its unchanged five-second private
  test deadline; independent pypdf and Poppler checks verified linked font bytes, extracted `AB`
  and rendered output. Those earlier artifacts did not exercise Electron IPC, the Plot
  dialog, native CAD comparison or an installed release; see the later source review below.
- Earlier auxiliary artifact producers did not pass: Cambria face 0 hit the same existing
  capital-A/origin metrics refusal on the base and candidate; the Nirmala producer wrote its
  artifacts but exceeded its original five-second private test deadline. The saved artifacts were
  checked independently as above. The production worker deadline remains unchanged.
- Prior standalone-TrueType Windows Electron/Chrome and Poppler proof passed 1,496 checks: four
  exact full installed programs, Unicode extraction, native AutoCAD TEXT positions, 183 emitted
  rows and 66 Canvas/Poppler crops. The production Plot dialog/font IPC/Save PDF route also
  passed on a private fixture copy; the drawing stayed unchanged and clean. Only native file
  dialog destinations were test doubles. Source hashes matched before and after the proof.
  These prior standalone-font checks do not establish native TTC acceptance.
- AutoCAD MTEXT references remain a limit: 198/216 comparisons pass; 18 tall Times multiline
  vertical comparisons differ by 0.13–0.32 drawing units at a 0.12 tolerance. Horizontal wrapping
  and attachment checks pass. The tolerance was not widened to hide the remaining leading gap.

### Collection selection: Windows source review, 2026-10-15

The reviewed implementation at `338165d9cb77cff8954ecc06d64570822d6543ad`
passes all three typecheck projects, full lint, fixture checks and a fresh production
renderer build. Its full Windows suite passes 6,647 tests with 38 explicit skips;
the seven targeted font suites pass all 256 tests. These local results replace the
handoff's inconclusive full-suite contention analysis; they do not claim remote CI.

A private Electron 44.7.2 source-runtime run uses the actual confined font workers,
preload/IPC and production Plot/Save PDF path. Installed `Nirmala.ttc` contributes
face 0 (`NirmalaUI`), face 1 (`NirmalaUI-Bold`) and face 3 (`NirmalaText`), with
standalone `ArialMT` as control. Metrics and complete programs match each selected
source face. Regular/bold inline MTEXT, centered/transformed TEXT, Unicode aliases,
edit/undo/redo, DXF Save As/reopen with retained STYLE flags, plot cancellation and
captured-font ownership pass. Only native file-dialog destinations are test doubles.
Drawing state, source/fonts and other installations remain unchanged; owned processes exit.

Independent strict pypdf inspection validates embedded programs, CID/glyph mappings,
widths and extracted text. Five Windows Canvas/Poppler crops pass the existing
three-pixel tolerance and visual review. The strict inspector records **1,016/1,017**
checks: its sole failure is Poppler's `No display font for 'Symbol'` stderr on the
Helvetica fallback case. An independent pypdf-authored Helvetica-only control, with
no JCad code or Symbol resource, reproduces that exact warning and renders/extracts
successfully. The failure is preserved and classified as an external-renderer limit;
the warning-free gate is not reported as green.

An isolated AutoCAD 2027 reference run over authored drawings adds 263 independent
checks: actual PDF resources and text operations identify the three Nirmala faces
and Arial across twelve TEXT cases. All 29 used glyph programs and advances match
the linked source fonts; all 48 native textbox edges match within 0.0001 drawing
units. Native AUDIT reports zero errors and source/fonts stay unchanged. AutoCAD's
own PDF has a duplicate `/PageMode` dictionary key, so strict pypdf parsing of that
reference fails; the diagnostic and original file are preserved, and permissive
inspection establishes only the reference facts above. JCad PDFs use strict parsing.

This is source-runtime evidence over authored Latin/unshaped text. Packaged-app
acceptance, broader installed collections and complex scripts remain separate gates.
Priority 12 remains partial; later SimSun, CFF, subsetting, permissions, shaping and
variable/color deliveries require their own review and combined validation.

### Used-glyph validation and subsetting: Windows source review, 2026-10-15

The combined review retains 12.1 and adds the delivered used-glyph and 12.3 glyf
subsetting work. Review fixes cover sparse request arrays before worker launch,
selected-face/used-set composition, valid empty glyphs, optional instruction
bounds, representable `maxp` values and consistent, distinct PDF subset names.
An auxiliary test producer that wrote outside the worktree was removed before
successful execution. Targeted tests pass: 155 across eleven font files; a
separate admission/host control passes 55. Three typecheck projects, full lint,
fixture checks and a fresh production renderer build pass.

On source `8cc7fc9b78a60419adfa5c3a7cc474cf5e9f4556`, private Electron 44.7.2
exercises real workers/IPC and production Plot/Save PDF, including Nirmala regular,
bold and cross-family faces, Arial, precomposed composite accents, inline MTEXT,
edit/undo/redo, DXF Save As/reopen, cancellation and captured-font ownership.
Independent inspection checks retained glyph/component bytes, emptied unused
glyphs, preserved maps/metrics/permissions/tables, rebuilt checksums/maxima and
subset names. It records **2,377/2,378** checks; the sole failure is the same
external Poppler warning on Helvetica fallback documented above. Five Canvas/PDF
crops pass the unchanged three-pixel tolerance and visual review.

The authored sparse-text comparison PDF is 1,323,959 bytes with subsets versus
5,572,795 bytes for the whole-font control. Extracted Unicode, CID mappings,
widths and literal 144-dpi rendered RGB pixels match. The control changes only
the no-subsetting permission field and matching metrics on private program
copies; native font files are unchanged. This measures one fixture, not a
general size or performance guarantee.

Real SimSun remains a negative control. Its used-glyph PDF request fails the
preserved bitmap/capital-A origin gate. Production Han plotting reports legacy
stroke substitution; that PDF has no embedded font resources or extracted text.
This is not faithful Chinese embedding/extraction acceptance. YaHei's conflicting
PostScript names and absent SimHei/FangSong remain explicit limits. The separate
DWG/missing-SHX/Han/raster-guidance composition (F1-F4) is not integrated or
certified here. No bitmap policy or permission gate is weakened.

Two complete two-worker Windows runs each pass 6,700 tests with 38 skips and time
out in the same unchanged 128-MiB file-hashing admission case, including its
cleanup hook. That suite passes alone with unchanged deadlines. Its concurrency
cause is unresolved; those failures are preserved and the two-worker gate is
not green. The serial control passes all 6,701 tests with 38 skips across 376
files (375 passed, one skipped) in 317 seconds, with every deadline and assertion
unchanged. This establishes serial acceptance, not the cause of the concurrent
failure or a green two-worker gate. No remote CI,
packaged installer, new AutoCAD run or release is certified by this review.

### Variable-font handoff review, 2026-10-15

The 12.6a delivery is not admitted to production. Both validators accept an
illegal intermediate `fvar` instance-record size, and the default-coordinate
selection policy does not prove agreement with Windows Canvas. Its authored
`gvar` header is malformed; declaring named coordinates without meaningful
variation deltas does not test instance selection. Private executed probes
reproduce these admissions and the fixture defect. Installed Bahnschrift,
Segoe UI Variable and Sitka files are inventory only, not compatible-font claims.

An independent 12.3 integration guard now prevents glyf subsetting whenever the
actual table directory contains `fvar`, `gvar`, `avar`, `cvar`, `HVAR`, `VVAR` or
`MVAR`. Emptying unused outlines while retaining point deltas can invalidate
their topology; the fallback preserves the exact original object and bytes.
Eight regressions fail before the guard and pass afterward, including a correctly
headed `gvar` record with a real point delta on an unused glyph. All 193 targeted
font tests pass with native Windows junction support; three typecheck projects,
full lint and fixture checks pass. Variable-font admission remains refused.
These are boundary tests, not variable-font rendering or viewer acceptance.

The subsequent test-lifecycle correction passes the original two-worker full
gate: **6,709 passed, 38 skipped**, 376 files passed and one skipped, 191 seconds.
It passes the test-context cancellation signal into standalone content checks,
tracks the entire fixture body including cleanup, and starts host shutdown
before joining producers and removing fixtures. The 128/512-MiB real fixtures,
256-KiB hash scratch, all evidence assertions, 60-second body and 10-second hook
deadlines are unchanged. Failure-only stage diagnostics remain for future runs.
The targeted export/content-identity control passes all 47 tests. This clears
this local concurrent gate; it does not establish the initial stall's cause,
remote CI, DWG/Han composition or native CFF/variable-font acceptance.

See [priority-12 review status](PRIORITY-12-REVIEW-STATUS.md) for delivery,
ownership and the remaining integration gates.
