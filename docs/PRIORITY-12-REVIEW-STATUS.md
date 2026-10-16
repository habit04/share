# Priority 12 review status

Windows development review, 2026-10-15. Nothing in this batch is pushed, merged
or released. Earlier released TTC support remains the v0.5.2 baseline.

| Piece | Current evidence and status | Next gate / owner |
|---|---|---|
| 12.1 collection selection | Reviewed and corrected locally; real Windows workers/IPC/Plot and private AutoCAD reference pass for the tested Nirmala faces and Arial. | Lead: combined acceptance, packaged checks and CI. |
| Used-glyph validation (SimSun scope) | Algorithm and DWG/F4 source composition reviewed; 132 independent authored-PDF checks pass. Real SimSun still refuses at bitmap/origin validation, YaHei at conflicting PostScript names. | Lead: packaged/CI gates; native Han vector acceptance remains absent. Actual missing-SHX raster output and explicit vector refusal pass. |
| 12.3 glyf subsetting | Reviewed and corrected; real Windows subset/whole-control Unicode and pixels match. Added actual-byte whole-program guard for variation tables: eight failing-before/passing-after regressions. | Lead: combined suite and native gates. Variation-aware subsetting remains deferred. |
| 12.6a variable defaults | Updated 14-patch delivery verifies; original negatives and 49 supplied tests pass, with genuine live gvar deltas and conservative default-identity policy. Lead privately fixes remaining name-ID ranges; 11 range, 11 current-code TTC/used-glyph, 41 independent PDF and 45 Windows Bahnschrift default-identity checks pass. | Lead: compose corrected readers/writer, rerun combined gates and real Windows Plot/save/reopen/viewer checks. Admission remains held; these are private candidates, not the F4 production source. |
| 12.2 standalone CFF1 | Updated eight-patch delivery resolves all 11 original Type2 goldens, Unicode aliases and emitted-resource PDF1.6. All 296 supplied targeted tests pass on Windows. Lead privately fixes implicit matrix/late-width edges and one test type error; 119 corrected targeted tests and both scoped typechecks pass. Fresh 24-PDF production-route fixtures pass 623 independent checks. | Lead: compose corrected candidate with current selected-face/used-glyph/subsetting/F4 code, then combined/native gates. No installed standalone CFF font is available here; native positive validation remains limited. Supplied full-suite log is red, not merge evidence. |
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
