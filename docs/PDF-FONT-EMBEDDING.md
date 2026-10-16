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

### Restricted-export engine spike review, 2026-10-15

The pinned qpdf 12.4.2 self-build route is selected for implementation. The
delivered binary is a prototype, not an approved runtime/shipping artifact.
Static inspection verifies its actual maximum is 2 GiB; the proposed 768 MiB
requires relinking. MEMFS input/output uses additional JavaScript arrays, so
that linear-memory cap alone cannot bound the complete process or IPC copies.
The implementation still needs aggregate bounds, child termination/join,
capture/mode isolation, strict evidence and complete distributable notices.

A separate bounded Windows Node smoke runs two fresh encryptions and one
decryption over an exact 3,465-byte authored/private PDF with embedded synthetic
font, text, Info and XMP metadata. All 89 independent strict-pypdf assertions
pass: R6/AESV3, P2 `/P=-1324`, encrypted metadata, empty-user and owner
authentication, wrong-password refusal, PDF 1.7 Extension Level 8, and linked
stored/decoded streams, Unicode and metadata preservation. Individual security
fields and ciphertext differ between jobs; permanent document IDs need not.
The 144-dpi Poppler renders have identical RGB pixels and empty stderr. Whole
serialized PDF byte identity is not claimed because qpdf rewrites structure.

The first smoke failed a raw marker-presence assertion because pypdf escaped
the fixture's Info marker. The marker was corrected; the failed receipt and
every assertion are retained. This source-runtime prototype evidence does not
exercise production Plot/IPC, utilityProcess isolation, installed fonts,
AutoCAD or viewer restriction enforcement. Preview/print-font refusal remains
active until the implementation and its acceptance gates pass.

### DWG/F4 combined Windows source review, 2026-10-15

Source `167c50b6b57d700f6d22da3ec6212e5a4a14afac` combines the verified final
DWG handoff with the corrected collection/used-glyph/subsetting tree. The fresh
two-worker suite passes **6,822 tests, zero failures and 38 skips** in 190 seconds,
including both private hash-pinned DWG cases and eleven F4 font regressions.
Three typecheck projects, full lint, fixture checks, nine workflows and a fresh
renderer build pass. No point, glyph, memory or timeout cap is increased.

Private Electron 44.7.2 exercises real Open, the exact restored title edit,
undo/redo, source-overwrite refusal before backup, DXF Save As/reopen and Plot.
All **63 F4 assertions** and **721 independent native receipt/raw-DXF checks**
pass. The signature, 1,072 model entities, four title fields and unrelated
same-string diagram text survive. Actual resolved appearance, all five
unit-height measurements and font size agree after reopening within absolute
`1e-7`. Effective STYLE records match apart from the pre-existing blank-font,
no-family normalization to `txt`; exact source font-string identity is not claimed.

Actual missing-SHX and declared-TTF Han vector plots refuse with Raster image
guidance and no output PDF. Raster Han output passes nine independent checks,
warning-free Poppler rendering and visual review. The separate eligible authored
embedding fixture passes 132 independent checks, including exact selected-face
subset reconstruction, extraction and visible ink. Its Han glyph is an authored
rectangle, not an installed Chinese typeface acceptance result. Real SimSun and
YaHei admission refusals remain intact. Source, fonts and private inputs retain
their hashes; only owned test processes are closed.

The broader independent PDF inspector records **2,376/2,377** checks. The only
failure is the same Poppler missing-Symbol warning on Helvetica fallback,
reproduced by a hash-pinned independently authored Helvetica-only control. Its
strict stderr assertion is retained. Six consumed-ticket cancellation diagnostics
remain in the native main log, also seen in the earlier font-only workflow;
neither log is described as clean. Five Canvas/PDF crops meet the unchanged
three-pixel criterion; subset/whole Unicode and literal 144-dpi RGB pixels match.
No new AutoCAD, packaged installer, remote CI, merge or release is certified.

### Updated 12.3 and shaping v3 delivery review, 2026-10-15

The updated 12.3 package verifies all eight declared hashes. Its first four
patches are unchanged apart from numbering; the fifth composes the already
integrated lead variation guard and eight tests. It is not reapplied. Its older
candidate still lacks later empty-glyph, maxp overflow/readback and subset-name
corrections, so replacing current source would regress the reviewed branch.

The shaping-v3 package verifies all four declared hashes and independently
hashes all 23 payloads. Static bounded WASM parsing confirms the delivered
445,284-byte artifact declares a **256 MiB** maximum. No supplied code is run or
WASM instantiated. This resolves the earlier declared-limit defect without
admitting the runtime. Remaining contract gaps include repeated GIDs within one
cluster duplicating extraction, actual context/line cache identity, ignorable and
direct-path boundary semantics, and producer/transport/outline/aggregate bounds.
The existing raw build/measurement records and reproducible inputs are requested,
rather than repeating the delivered experiments. The npm SHA1 statement needs
correction; the reported SHA512 matches official metadata.

An independently authored parser control observes pypdf 6.10.0 extracting shown
`A` rather than the `ActualText` replacement `LOGICAL`. A repeated-GID contract
model extracts `AA` for one logical `A`. These are synthetic extraction controls,
not HarfBuzz, bidi, native-font or Windows shaping acceptance. Contract/interface
approval and runtime adoption remain held; no shaping consumer is added.

### Shaping v4: interface-only approval, 2026-10-15

V4 addresses the earlier occurrence identity, context/line keys, direct-boundary,
host-selected face, x/y/outline and transport design findings. The next additive
interface/helper and synthetic contract-test commit is approved; engine,
dependency, IPC, Canvas/layout and PDF consumers remain unadmitted. The interface
tests must settle opaque epoch identity, original TTC versus extracted-program
indices, concrete wire/copy accounting and exit-joined release on every outcome.

All three supplied manifests verify. Raw measurements, wrapper, stock/control
artifacts, tarball and build/provenance inputs are now delivered; the completed
performance/stress series is not repeated. Three new probe cases report different
Unicode text from what they shape and require a small input/log correction.

The lead's own bounded Windows Node 24.19 probe uses the verified 256-MiB build,
exact-input-derived labels and private font copies. It passes **106 checks across
33 flag-case rows**, with empty stderr and unchanged installed-font hashes.
These cover actual Arabic ZWJ, decomposed acute, default hiding versus explicit
remove/preserve and a selected TTC face extracted to a standalone program.
They do not exercise app IPC, lifecycle survival, Canvas, PDF or broad script/font
compatibility. Original source selection index and standalone engine index are
distinct concepts; this engine happens to accept both tested indices on the
standalone control, so an invalid-index failure is not claimed.

An initial extra last-beh contrast assertion was an invalid Arial discriminator:
the full word also used its nominal final glyph. The failed receipt is retained.
Corrected first-beh controls show context working across four transparent marks,
while an eight-mark item split differs from whole-word shaping. Future producer
admission must keep a safe shaping unit or refuse an unsafe boundary; passing a
whole context string does not expand the engine's five-codepoint context storage.
No runtime consumer or compatibility claim follows from interface-only approval.

### Corrected 12.2 and 12.6a deliveries, 2026-10-15

Both updated archives are reconstructed privately from genuine `a68dba5` Git
blobs with every patch hunk and intermediate blob prefix checked. The CFF archive
has eight patches, claimed head `bfc094b`, and 11 declared hashes; the variable
archive has 14 patches, claimed head `b2d2d459`, and 17 declared hashes. All
declared hashes match. These claimed heads are not locally available commit
objects; reconstruction establishes their supplied file contents. No checkout,
branch, dependency or installed font is replaced. Tracked production code stays
at the existing F4 source checkpoint.

The CFF corrections resolve all eleven original independent Type2 goldens and
the same-glyph Unicode alias defect. Distinct PDF character codes now map through
a custom Encoding CMap to the shared CID/GID; widths remain CID-keyed and ToUnicode
remains character-code-keyed. Actual OpenType resources raise the PDF header to
1.6, while TrueType-only output remains 1.4. The Encoding CMap uses `begincidchar`
and CMapType 0 as specified by [Adobe TN5014](https://adobe-type-tools.github.io/font-tech-notes/pdfs/5014.CIDFont_Spec.pdf).

All **296 supplied targeted tests** pass on Windows. The first sandbox run has
294 passes and two permission errors while creating private test junctions; the
same tests pass when junction creation is permitted. This is recorded separately
from product failures. Further independent probes find two small remaining
parser defects: an omitted FontMatrix must use the effective .001 default for
the UPEM check, and an `endchar` operand cannot introduce a second width after a
width-taking operator. Private lead fixes improve extended probes from 31/36 to
**36/36**, retaining all eleven original goldens. The writer's corresponding
default-matrix guard also fails before and passes after its private fix. One new
test's optional-parameter indexed type is corrected without changing behavior.
The resulting **119 focused tests**, renderer/test typecheck and three-module
Electron typecheck pass. These are candidate-scoped checks, not full branch gates.

Fresh authored fixtures through the corrected candidate's actual
`capturedPdfLookup`, `vectorPdf` and `vectorPdfCompressed` produce 24 PDFs. They
pass **623 independent checks**, plus 30 exact source-program identity checks:
raw Encoding/ToUnicode/font-cmap relationships,
CID widths, exact PDFium extraction, whole CFF programs and names, resource-scoped
headers, warning-free Windows Poppler rendering, shared-glyph pixel identity and
compressed/uncompressed pixel equality. BMP and supplementary aliases, both
orders, multiple pages and mixed CFF/TrueType resources are exercised. Drawing
snapshots, dirty state and history stay unchanged. The authored glyphs are simple
geometric shapes, not evidence of real typeface fidelity. Pypdf's raw NUL-prefixed
extraction from a streamed Encoding CMap is recorded, not stripped and called an
exact pass; independent PDFium extracts the expected text exactly.

The initial artifact inspector incorrectly required CMapType 1. Its nine failed
assertions and inputs are preserved; correcting that harness assumption to the
TN5014 Type 0 definition produces 306/306 supplied-artifact checks. An incomplete
private source snapshot's typecheck errors are also retained; restoring genuine
base declarations and the test helper resolves those environment errors and
exposes the actual one-line test type error described above. No test requirement
or source resource limit is weakened.

The supplied CFF full-suite summary is **not accepted as green**. Its raw final
log reports 99 failed tests, five worker errors and exit 1, while the rerun log is
empty. This review does not prove those failures pre-existing. Fresh combined
lead-side checks and CI remain mandatory. A read-only inventory of 472 top-level
Windows font programs finds 457 standalone TrueType files, 15 collections and no
standalone OTTO/CFF font. Installed-CFF positive validation is therefore absent;
inventory header hashes and metadata are unchanged. No AutoCAD, Acrobat or app
Plot/IPC acceptance follows from these synthetic CFF checks.

The variable delivery fixes illegal instance record sizes, introduces an explicit
default-coordinate identity policy and replaces the earlier invalid gvar fixture.
The exact old negative guards pass, and all **49 supplied tests** pass. Independent
decoding confirms the authored 119-byte gvar has two axes, five glyphs, valid
bounded offsets and live weight/width deltas. No fresh fontTools execution is
claimed because that module is unavailable in the bundled Python runtime.

Both variable validators still accept out-of-range referenced name IDs. A private
lead correction enforces the [OpenType fvar name-ID ranges](https://learn.microsoft.com/en-us/typography/opentype/spec/fvar)
in both validators; six illegal-ID probes become refusals and **11 independent
range cases** pass. One supplied contradictory-name fixture used an illegal ID;
changing it to a legal custom ID retains the intended identity assertion and
restores 49/49 tests after the guard. The policy continues to refuse ambiguous
weight/width, varying optical-size and conflicting named defaults.

The supplied test labeled a nonzero TTC production-reader case actually extracts
the face before reading a standalone TTF. A separate private composition atop
the current lead source exercises the original TTC through the actual readers:
**11/11 checks** cover selected face 1, joint family/style/used-codepoint requests,
mapped-but-unvalidated glyph refusal, supplementary glyph admission when seeded,
whole screen metrics, selected permissions, exact whole variable bytes, unprefixed
names and preserved static TTF subsetting. It preserves all current collection,
used-glyph and subset safeguards; CFF is not unioned into this variable probe.

Three supplied variable/static/control PDFs independently pass **41 checks** with
exact whole-program identity, matching pypdf/PDFium text, warning-free Windows
Poppler rendering and visible ink. Variable-default and static-equivalent pixels
match; the different-text control changes pixels. These are synthetic artifact
checks, separate from the Windows Canvas/default-instance probe and eventual
real Plot/save/reopen/viewer acceptance.

A separate bounded Windows Chrome probe passes **45/45 checks** on installed
Bahnschrift Regular 400. Direct, confined metadata and PDF readers accept the
private copy and preserve its exact 361,564-byte whole program. Six strings at
100 and 256 pixels compare the actual installed-family Canvas result with a
loaded local-face control and source default advances/control bounds. Kerning is
disabled as in production; fixed acceptance bounds are 0.05 pixel for advances
and three pixels for control-hull versus platform-ink bounds. Arial/fallback
controls differ. This is a narrow observed default identity, not all weights,
named instances, optical sizes or viewer compatibility.

The ordinary sandbox browser launch fails; a narrow elevated retry succeeds.
Failed receipts and browser diagnostics remain preserved. Only owned, profile-
verified Chrome children are closed; original font hashes, metadata and candidate
modules remain unchanged. No JCad app IPC, Plot dialog or save/reopen is exercised
by this probe. Neither updated delivery is merged or enabled in the tracked F4
source, and priority 12 remains incomplete.
