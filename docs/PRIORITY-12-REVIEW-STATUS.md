# Priority 12 review status

Windows development review, 2026-10-15. Nothing in this batch is pushed, merged
or released. Earlier released TTC support remains the v0.5.2 baseline.

| Piece | Current evidence and status | Next gate / owner |
|---|---|---|
| 12.1 collection selection | Reviewed and corrected locally; real Windows workers/IPC/Plot and private AutoCAD reference pass for the tested Nirmala faces and Arial. | Lead: combined acceptance, packaged checks and CI. |
| Used-glyph validation (SimSun scope) | Algorithm reviewed; real SimSun still refuses at bitmap/origin validation, YaHei at conflicting PostScript names. Synthetic admission is not native Han acceptance. | Lead and separate DWG owner: F1-F4 composition, actual missing-SHX/Han fallback, doc reconciliation. |
| 12.3 glyf subsetting | Reviewed and corrected; real Windows subset/whole-control Unicode and pixels match. Added actual-byte whole-program guard for variation tables: eight failing-before/passing-after regressions. | Lead: combined suite and native gates. Variation-aware subsetting remains deferred. |
| 12.6a variable defaults | ZIP integrity verified; production admission held. Executed probes reproduce malformed-record admission and missing coordinate policy; delivered gvar fixture is invalid. | Muse: record validation, genuine variation fixtures, default-coordinate identity policy. Lead: Windows Canvas/Plot and viewer matrix. Keep current refusal until proved. |
| 12.2 standalone CFF1 | Delivered ZIP integrity under review; parser/format review in progress. | Lead: correct Type2 geometry and feature-scoped PDF version, reconcile readers/writer, tests and native proof. No CFF acceptance yet. |
| 12.4 preview/print permissions | P2 product direction retained; shipping qpdf dependency not admitted from design reports. Reported completed spike artifacts have not been delivered here. | Muse: existing spike package, exact provenance/notices, hard memory/isolation evidence. Lead: dependency decision and eventual Windows acceptance. Refusal remains active. |
| 12.5 shaping | Contract v2 reviewed; current contract and stock HarfBuzz binary not admitted unchanged. | Muse: contract v3, interface tests, hard-capped build/provenance spike. Lead: review before runtime adoption. |

The combined pre-guard source passed 6,701 tests with 38 skips serially. Two
two-worker runs each retain one large-file test/hook timeout; passing isolated
runs do not prove its cause or make the concurrent gate green. A private timed
run takes 548 ms and exposes a test-lifecycle cancellation/join gap; investigation
continues without changing deadlines or hash bounds. The known Poppler fallback
warning remains a preserved external-control failure. F4, packaged acceptance
and remote CI remain open; no merge/release gate is declared clear.

The long 2D roadmap stays paused. DWG and GPU ownership remains separate. CFF2,
CID-keyed CFF, CFF collections/subsetting, true variable instancing and faithful
color output remain deferred; priority 12 is incomplete.

Detailed local validation and limits: [PDF font embedding](PDF-FONT-EMBEDDING.md).
