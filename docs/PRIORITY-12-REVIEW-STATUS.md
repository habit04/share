# Priority 12 review status

Windows development review, 2026-10-16. The combined branch is published as
draft PR #23; it is not merged or released. Earlier released TTC support remains
the v0.5.2 baseline.

Current source composes the corrected CFF1 and variable-default implementations
with existing collection selection, used-glyph validation, static subsetting and
DWG/F4 safeguards. The full two-worker gate is **red: 6,955 passed, one failed,
38 skipped**. The failure is the existing large-PDF fixture's native file deletion;
split stage logging shows disposal complete with zero reader descriptors before
`unlink` stops returning at 296 ms. No cleanup cause or product fix is established.
The isolated unchanged case passes in 261 ms. Limits, deadlines and assertions
remain unchanged; no further full-suite retries are used to claim clearance.
Fresh combined native checks below have now executed; merge remains held.

The later [Windows checkpoint](PRIORITY-12-WINDOWS-CHECKPOINT.md) records a normal
6,954/0/40 pass without optional DWG inputs, followed by the required private-DWG
combined run at **6,955/1/38** with the same unresolved unlink stall (344 ms).
Both private DWG cases pass and do not overlap the stall. The observed two-file
run passes 36/36 without reproducing it; this does not clear the full gate.
An unpublished full-DWG test ASAR now passes 63 packaged F4 assertions and nine
independent raster checks, with strict PDF still 2882/2883. Its broad E2E launch
is confirmed blocked by Code Integrity for the intentionally unsigned EXE;
origin acceptance remains open. Smart App Control stays enabled; the installed
v0.5.0 reference signature is Valid. No installer or signing setting is changed.

A subsequent normal run of the entire Windows export-admission file passes
**34/34** in 1.63 seconds (large-file case 372 ms), using unchanged source,
assertions and deadlines, without a preload or external observer. This narrows
the cleanup diagnosis without clearing the failed full-suite gate. The existing
Windows CI job now runs that file and retains its JSON result; Linux unit jobs
skip its Windows-conditional cases. PR CI on `4b5e1a1` passes that native file
34/34 and both Node 22/24 jobs. The GPU job also passes. Windows Electron and
UI comparison fail on stale expectations: the source-loss controls still await
the former overwrite-consent modal, while production now hard-refuses the
partial source; one DWG screenshot predates the partial-import badge, 3D tab
label and dictionary-loss warning. The thrown modal timeout skips the later
damaged-drawing setup, explaining that run's secondary recovery-row failure.

The corrected E2E controls assert atomic refusal of Save and same-source Save
As, cancellation, an exact prior-destination backup for a separate copy, and
raw polyface/geometry preservation through fresh reopen. RECENT uses the real
full list rather than assuming the fixture is among its first three entries.
Older-release smoke tests keep their prior consent/No-to-Save-As branch.
The corrected Windows source-runtime flow passes **256 checks, zero failures**,
including the unchanged cut-short autosave/close/crash-recovery assertions.
Only `site-app-dwg.png` is reviewed and updated from the exact Ubuntu CI capture:
its canvas and sidebar are pixel-identical to the prior baseline; all differences
are accounted for in the three UI/report regions. The official comparison of
all 48 CI images passes with unchanged tolerances/masks. Script typechecking,
lint and the fresh renderer build pass. Corrected head `f902d00` now passes all
five PR CI jobs: Node 22, Node 24, Windows Electron, UI and experimental GPU.
The earlier local full-suite cleanup and strict PDF/viewer holds remain separate.

Commit `743fdbb` passes the fresh Windows source-runtime Plot/edit/save/reopen
workflow, including Bahnschrift through app IPC, exact whole-variable programs,
three optical-size refusals, all 63 real-DWG F4 assertions and nine independent
Han raster checks. Six Canvas/PDF crops remain within the original 3px bounds;
source/fonts stay unchanged and the owned Electron exits. Strict native PDF
inspection is **2,882/2,883**: the known Symbol warning on the Helvetica fallback
control remains red, and six consumed-ticket cancellation diagnostics remain.

Fresh authored CFF/mixed proof on the same commit produces 34 PDFs with **168/168
producer checks**. Strict independent inspection is **1,873/1,903**: 28 pypdf
custom-Encoding extraction failures and two fallback-control Symbol warnings
are retained. All 52 PDFium page extractions and raw glyph/CID/Unicode mappings
pass. A separate 67-check local-library/source-integrity classification confirms
the pypdf limitation without turning the strict failed gate green. Installed-CFF,
broad packaged-app and broader viewer acceptance remain open; all five current
PR CI jobs pass. The later packaged font slice is recorded in the checkpoint.

| Piece | Current evidence and status | Next gate / owner |
|---|---|---|
| 12.1 collection selection | Reviewed and corrected locally; real Windows workers/IPC/Plot and private AutoCAD reference pass for the tested Nirmala faces and Arial. | Lead: combined acceptance, packaged checks and CI. |
| Used-glyph validation (SimSun scope) | Algorithm and DWG/F4 source composition reviewed; 132 independent authored-PDF checks pass. Real SimSun still refuses at bitmap/origin validation, YaHei at conflicting PostScript names. | Lead: packaged/CI gates; native Han vector acceptance remains absent. Actual missing-SHX raster output and explicit vector refusal pass. |
| 12.3 glyf subsetting | Reviewed and corrected; real Windows subset/whole-control Unicode and pixels match. Added actual-byte whole-program guard for variation tables: eight failing-before/passing-after regressions. | Lead: combined suite and native gates. Variation-aware subsetting remains deferred. |
| 12.6a variable defaults | Corrected source retains legal-name-ID guards and current TTC/used-glyph/subset/F4 behavior. Final archive adds no code. Real Bahnschrift app IPC/Plot/edit/save/reopen and whole-program identity pass on `743fdbb`; varying optical-size fonts refuse explicitly. | Lead: resolve red full/strict PDF gates, then packaged/CI/viewer acceptance. These results cover the tested default, not named instances or all variable fonts. |
| 12.2 standalone CFF1 | Corrected parser/writer, implicit-matrix/late-width guards, aliases and resource-scoped PDF1.6 are integrated. Fresh actual-reader/capture proof produces 34 PDFs; producer 168/168, strict inspector 1873/1903, classification 67/67 as detailed above. | Lead: retain strict failures and complete acceptance. No installed standalone CFF font is available; synthetic checks do not establish real-font IPC/viewer compatibility. |
| 12.4 preview/print permissions | Eleven-patch correction tree independently reproduced; fourteen manifest checks pass. Corrected verifier controls pass 10/10. Independent probes still fail six assertions covering queued quarantine and two actual MEMFS accounting paths; source is not integrated. | Muse: three reproduced corrections in the forwarded round-two bundle. Lead: preserve current font/DWG seams and complete native utilityProcess/Plot/IPC, full-suite and viewer gates after correction. Refusal remains active; see PRIORITY-12-WINDOWS-CHECKPOINT.md. |
| 12.5 shaping | v4 design approved for additive interface/helpers and synthetic contract tests. Capped prototype passes 106 bounded Windows Node checks across 33 cases; no app/runtime/consumer adoption. | Muse: scoped interface commit with epoch, selected-face, wire/copy and exit-join tests; correct three probe labels. Lead: later runtime/Windows/render/extraction gates. |
| DWG/F4 combined source | 63 Windows workflow assertions and 721 independent native checks pass on `167c50b`; effective STYLE, metrics, title/signature, source protection and DXF reopen verified. | Lead: maintain font/projection refusals; remote CI and packaged gates remain separate. No merge clearance. |

Historical checkpoint `167c50b` passes **6,822 tests, zero failures and
38 skips** in 190 seconds, including both hash-pinned private-DWG cases and all
11 font-composition regressions. Three typecheck projects, full lint, fixture and
nine workflow checks, and the renderer build pass. The earlier lifecycle repair
and its failed-run history remain documented; no deadline or work cap is raised.

On that historical source, actual Windows Open/edit/undo/redo/DXF save/reopen and Plot pass. Raster Han output
passes nine independent checks and visual inspection; font subset/whole-control
Unicode and pixels match. The wider PDF inspector passes 2,376/2,377 checks: the
same missing-Symbol warning on a Helvetica control remains a strict failure and
is independently reproduced without JCad. Six consumed-ticket cancellation
diagnostics are disclosed, not a clean-main-log claim. Packaged acceptance,
remote CI and the current combined gate still prevent merge clearance.

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
