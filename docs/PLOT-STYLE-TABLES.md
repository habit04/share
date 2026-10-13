# CTB/STB plotting milestone

The Plot dialog can load a CTB or STB file for the current plot. CTB resolves the source
ACI slot, including ByLayer/ByBlock inheritance. TrueColor bypasses CTB color and weight
overrides. STB provides an explicit whole-plot named-style selection; Normal preserves
object properties. The dialog states that imported per-object named assignments are not
applied. A new dialog starts without a custom table, and an invalid file keeps the prior
valid selection. No table bytes or selection enter the drawing, undo history or backups.

The same resolver supplies Canvas raster plots and vector PDF colors and physical widths.
Nested insertion widths are resolved before plot overrides using an uncached expansion;
ordinary block expansion and display caches retain their existing behavior. Sub-entity
colors, leader text layers, MTEXT masks and viewport frames retain their source identity.
Plot settings, document state and destination name are captured before asynchronous reads.
Unsupported effects are reported for styles actually used by the plot.

## Validated subset

- Native initialized mode colors, object-color sentinels, grayscale, screening and indexed
  custom weights. Weight 0 means object weight; positive N addresses weight-table N-1.
- Screening with dithering disabled. Native byte grayscale floors each weighted RGB
  contribution separately; screening truncates removed ink, rather than rounding output.
- Both direct and inherited TrueColor CTB bypass, STB TrueColor overrides, localized named
  aliases and Normal. Ambiguous aliases use a reported object-properties fallback.
- Vector model/layout plots and single-tab raster plots. With a custom table, all-layout
  raster plotting asks for Vector PDF or one tab at a time.

The parser validates the native CTB/STB header, lengths, zlib stream and compressed-body
checksum. Bounds are 1 MiB input, 2 MiB expanded data, 4,096 named styles, 1,024 weights,
16 nesting levels and bounded lines/tokens. Unknown fields and unsupported settings remain
in an immutable raw tree and produce diagnostics. Remapped ACI tables are refused.

## Evidence and limits

The frozen Windows source proof passed **1,823 checks**: 576 actual source/production UI
checks plus 1,247 independent PDF/Poppler checks. It includes 266 native RGB samples,
22 Canvas/raster/vector pages, actual Windows Save PDF IPC, and production CTB/STB vector
plots and a 1,650 x 1,275 raster PDF. All 18 raster sample colors match exactly. Invalid
checksum input kept the valid table, reopening the dialog reset its selection, and plots
left the captured drawing and dirty state unchanged. Only destination-dialog answers were
queued. Native reference drawings passed AUDIT with zero errors. Installed tables and
native PDFs remain private; committed test tables are authored fixtures.

Requested PDF widths match within half the three-decimal serialization quantum. Native
PDF widths match within half the 0.12-point device quantization (0.06001 points). This is
an explicit native plotting precision limit. It is not an arbitrary geometric tolerance.

The combined suite passed **2,960 tests with 27 conditional skips**, and eight dense
benchmarks passed. All three TypeScript projects, broad lint, fixture checks and production
build passed. Native proof used bundle `index-Co59Aj5I.js`, with source hashes unchanged.

Physical pen/palette behavior, color books, linetype/fill/cap/join overrides and unusual
conflicting policies are retained and diagnosed rather than simulated. Gradient hatch
colors remain stored colors with a reported unverified-table interaction. Exact layout
filenames, PSTYLEMODE and native per-object/per-layer named bindings require the verified
DWG metadata/reference integration owned by PR #9. This milestone does not establish full
CTB/STB compatibility or alter source drawing plot metadata.
