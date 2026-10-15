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

Used faces become full FontFile2 programs, Type0 Identity-H fonts and CIDFontType2 descendants.
CIDToGIDMap and ToUnicode keep glyph identity, including distinct Unicode aliases and supported
supplementary characters. Native unkerned advances, capital-A height, bearings, FIT/ALIGNED,
width factor, oblique and rotation drive PDF text. Resources are shared across pages. The format
follows the [Adobe PDF reference](https://opensource.adobe.com/dc-acrobat-sdk-docs/pdfstandards/pdfreference1.5_v6.pdf).

Unsupported/missing faces or unsupported runs use the existing Helvetica/stroke fallback and
the plot log reports substitutions. Browser plots keep their existing path. CFF,
variable/color fonts, uncertain glyph origins, contextual shaping, font subsetting and
preview/print-only embedding remain open. Within collection-face selection, what
remains open is acceptance, not selection. Two refusal causes are confirmed on
Windows by the lead and are classified separately from collection defects:

- Cambria face 0 (`cambria.ttc`) is refused with "the native capital A glyph must
  have a known origin and positive yMax", reproduced on the pristine base and on
  the candidate. It is a per-face data gate in the shared metrics reader, not a
  collection defect; the gate now applies to the selected face exactly as it did
  to face 0, and the refusal still ends in the reported fallback.
- SimSun (`simsun.ttc`, family SimSun, regular) is refused with "glyph point work
  exceeds the safe limit" through both the metrics and PDF readers on Windows,
  while Canvas renders the same font. This is a separate cause: the reader
  eagerly computes bounds for every glyph and this face's total point work passes
  the safe-work limit. It is remaining 12.1-adjacent work under separate
  investigation. The point-work limit is a resource safeguard; it is not raised
  here, and no lazy glyph-work change is made in this milestone.

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
  Linux/headless checks over authored fixtures; native Windows Plot/IPC acceptance
  of selected collection faces remains pending with the lead.
- 36 resource tests and 17 integration tests use authored font fixtures. They check Unicode/CID
  mapping, program identity, permissions, capture isolation, font budgeting, placement, fallback,
  shared pages and legacy output. No third-party font programs or reference PDFs are tracked.
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
  and rendered output. Electron IPC, the Plot dialog, native CAD comparison and an installed
  release remain unverified for TTC.
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
