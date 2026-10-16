# Priority 12 review status

Windows development review, 2026-10-15. Nothing in this batch is pushed, merged
or released. Earlier released TTC support remains the v0.5.2 baseline.

| Piece | Current evidence and status | Next gate / owner |
|---|---|---|
| 12.1 collection selection | Reviewed and corrected locally; real Windows workers/IPC/Plot and private AutoCAD reference pass for the tested Nirmala faces and Arial. | Lead: combined acceptance, packaged checks and CI. |
| Used-glyph validation (SimSun scope) | Algorithm and DWG/F4 source composition reviewed; 132 independent authored-PDF checks pass. Real SimSun still refuses at bitmap/origin validation, YaHei at conflicting PostScript names. | Lead: packaged/CI gates; native Han vector acceptance remains absent. Actual missing-SHX raster output and explicit vector refusal pass. |
| 12.3 glyf subsetting | Reviewed and corrected; real Windows subset/whole-control Unicode and pixels match. Added actual-byte whole-program guard for variation tables: eight failing-before/passing-after regressions. | Lead: combined suite and native gates. Variation-aware subsetting remains deferred. |
| 12.6a variable defaults | ZIP integrity verified; production admission held. Executed probes reproduce malformed-record admission and missing coordinate policy; delivered gvar fixture is invalid. | Muse: record validation, genuine variation fixtures, default-coordinate identity policy. Lead: Windows Canvas/Plot and viewer matrix. Keep current refusal until proved. |
| 12.2 standalone CFF1 | All ZIP hashes verified. Integration held: nine independent Type2 goldens fail; same-glyph Unicode aliases extract incorrectly; supplied OpenType PDF declares 1.4. Basic supplied artifacts pass 60/61 independent checks, failing the version gate. | Muse: parser/alias/validation corrections and feature-scoped PDF1.6. Lead: reader/writer composition and Windows proof. No CFF acceptance yet. |
| 12.4 preview/print permissions | qpdf 12.4.2 self-build selected for implementation; delivered binary remains a prototype. Windows Node smoke passes 89 strict independent assertions and exact encrypted/plain pixels on one small authored fixture. Actual WASM max is 2 GiB; MEMFS/IPC copies need separate bounds. | Muse: capped rebuild, aggregate resource/lifecycle/IPC guards, strict evidence and full notices. Lead: eventual Windows app/viewer acceptance and shipping pin. Refusal remains active. |
| 12.5 shaping | v4 design approved for additive interface/helpers and synthetic contract tests. Capped prototype passes 106 bounded Windows Node checks across 33 cases; no app/runtime/consumer adoption. | Muse: scoped interface commit with epoch, selected-face, wire/copy and exit-join tests; correct three probe labels. Lead: later runtime/Windows/render/extraction gates. |
| DWG/F4 combined source | 63 Windows workflow assertions and 721 independent native checks pass on `167c50b`; effective STYLE, metrics, title/signature, source protection and DXF reopen verified. | Lead: maintain font/projection refusals; remote CI and packaged gates remain separate. No merge clearance. |

The combined two-worker Windows suite passes **6,822 tests, zero failures and
38 skips** in 190 seconds, including both hash-pinned private-DWG cases and all
11 font-composition regressions. Three typecheck projects, full lint, fixture and
nine workflow checks, and the renderer build pass. The earlier lifecycle repair
and its failed-run history remain documented; no deadline or work cap is raised.

Actual Windows Open/edit/undo/redo/DXF save/reopen and Plot pass. Raster Han output
passes nine independent checks and visual inspection; font subset/whole-control
Unicode and pixels match. The wider PDF inspector passes 2,376/2,377 checks: the
same missing-Symbol warning on a Helvetica control remains a strict failure and
is independently reproduced without JCad. Six consumed-ticket cancellation
diagnostics are disclosed, not a clean-main-log claim. Packaged acceptance,
remote CI and Muse's outstanding corrections still prevent merge clearance.

The updated five-patch 12.3 delivery is verified but not replayed: its sole added
source/test patch duplicates the existing lead variation guard. Replacing the
integrated tree would omit later empty-glyph, overflow and subset-name repairs.

V4 supplies the missing raw shaping-spike evidence and addresses the earlier
design blockers. Its three mislabeled ignorable cases still need correction;
the lead's own Windows probe shapes the exact strings it reports. Passing full
input to an item-range API does not give unlimited engine context: the observed
eight-mark split needs a safe-unit or explicit-refusal rule before consumption.
This is a producer/runtime gate, not a reason to delay additive interface tests.

The long 2D roadmap stays paused. DWG and GPU ownership remains separate. CFF2,
CID-keyed CFF, CFF collections/subsetting, true variable instancing and faithful
color output remain deferred; priority 12 is incomplete.

Detailed local validation and limits: [PDF font embedding](PDF-FONT-EMBEDDING.md).
