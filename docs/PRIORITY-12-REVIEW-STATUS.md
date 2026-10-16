# Priority 12 review status

Windows development review, 2026-10-15. Nothing in this batch is pushed, merged
or released. Earlier released TTC support remains the v0.5.2 baseline.

| Piece | Current evidence and status | Next gate / owner |
|---|---|---|
| 12.1 collection selection | Reviewed and corrected locally; real Windows workers/IPC/Plot and private AutoCAD reference pass for the tested Nirmala faces and Arial. | Lead: combined acceptance, packaged checks and CI. |
| Used-glyph validation (SimSun scope) | Algorithm reviewed; real SimSun still refuses at bitmap/origin validation, YaHei at conflicting PostScript names. Synthetic admission is not native Han acceptance. | Lead and separate DWG owner: F1-F4 composition, actual missing-SHX/Han fallback, doc reconciliation. |
| 12.3 glyf subsetting | Reviewed and corrected; real Windows subset/whole-control Unicode and pixels match. Added actual-byte whole-program guard for variation tables: eight failing-before/passing-after regressions. | Lead: combined suite and native gates. Variation-aware subsetting remains deferred. |
| 12.6a variable defaults | ZIP integrity verified; production admission held. Executed probes reproduce malformed-record admission and missing coordinate policy; delivered gvar fixture is invalid. | Muse: record validation, genuine variation fixtures, default-coordinate identity policy. Lead: Windows Canvas/Plot and viewer matrix. Keep current refusal until proved. |
| 12.2 standalone CFF1 | All ZIP hashes verified. Integration held: nine independent Type2 goldens fail; same-glyph Unicode aliases extract incorrectly; supplied OpenType PDF declares 1.4. Basic supplied artifacts pass 60/61 independent checks, failing the version gate. | Muse: parser/alias/validation corrections and feature-scoped PDF1.6. Lead: reader/writer composition and Windows proof. No CFF acceptance yet. |
| 12.4 preview/print permissions | qpdf 12.4.2 self-build selected for implementation; delivered binary remains a prototype. Windows Node smoke passes 89 strict independent assertions and exact encrypted/plain pixels on one small authored fixture. Actual WASM max is 2 GiB; MEMFS/IPC copies need separate bounds. | Muse: capped rebuild, aggregate resource/lifecycle/IPC guards, strict evidence and full notices. Lead: eventual Windows app/viewer acceptance and shipping pin. Refusal remains active. |
| 12.5 shaping | Contract v2 reviewed; current contract and stock HarfBuzz binary not admitted unchanged. | Muse: contract v3, interface tests, hard-capped build/provenance spike. Lead: review before runtime adoption. |

The fresh two-worker Windows gate passes **6,709 tests with 38 skips** in 191
seconds after the variation guard and test-lifecycle cancellation/join repair.
The targeted export/content-identity control passes all 47 tests. No deadline,
evidence assertion, real fixture size or hash bound changed. The two earlier
timeout failures remain recorded; this pass does not prove the initial stall's
cause. The known Poppler fallback warning remains a preserved external-control
failure. F4, packaged acceptance and remote CI remain open; no merge/release
gate is declared clear.

The long 2D roadmap stays paused. DWG and GPU ownership remains separate. CFF2,
CID-keyed CFF, CFF collections/subsetting, true variable instancing and faithful
color output remain deferred; priority 12 is incomplete.

Detailed local validation and limits: [PDF font embedding](PDF-FONT-EMBEDDING.md).
