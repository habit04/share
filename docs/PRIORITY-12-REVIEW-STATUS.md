# Priority 12 review status

Windows development review, 2026-10-16. The combined branch is published as
draft PR #23; it is not merged or released. Earlier released TTC support remains
the v0.5.2 baseline.

Current packaging head `e72c9f8` passes **7,029/0/38** locally. Both actual CI
archives verify exact license/notices and desktop 257/257. Push CI passes all
five jobs; PR CI fails the first packaged-origin launch while its other four
jobs pass. Diagnostics localize startup to the hidden legacy-storage window;
the underlying native stall is unproven. No retry or sibling pass clears it.

The startup repair bounds migration load/readiness and execution, cleans up
owned resources and stops visibly before an incomplete read can acknowledge
an empty settings checkpoint. Focused tests pass 68/68; 28 of the 36 new cases
fail against the original source, with exact restoration afterward. Broader
source and fresh packaged CI remain required on the repaired head. Muse still
owns the two outstanding 12.4 memory-guard corrections. Merge remains held;
final head/results belong to the draft PR. Earlier evidence is historical.

Historical complete checkpoint: `74369d3` passes the full Windows/private-DWG suite
**7,022/0/38** and both five-job CI runs. Both actual Windows artifacts pass
desktop 257/257 and origin 3/3, with unchanged inputs/package identity. Chrome
native text passes 31/31; the separate authored-CFF/mixed check passes 12/12.
The push GPU's one approved acquisition-failure re-execution is disclosed in
the PR receipts. No original failed report is rewritten.

A further packaging fix includes the project license and third-party notices
in the app archive and verifies their exact source bytes. Its source/package
gates are recorded separately in the draft PR. The current 12.4 candidate is
still blocked by two independently reproduced MEMFS defects: its old controls
pass 14/14, new controls have 10 passes/four failures, and no candidate is
adopted. Muse owns corrections; native/composed acceptance remains with the
lead. Merge remains held. The earlier checkpoints below are historical.

Current source composes the corrected CFF1 and variable-default implementations
with existing collection selection, used-glyph validation, static subsetting and
DWG/F4 safeguards. The `a94f104` full Windows two-worker gate passes **6,974
tests, zero failures, 38 skips**, including both private DWG cases. Test commit
`6dab4cb` joins project-fixture work before teardown and uses neutral bytes for
the opaque size-boundary fixture. Original native unlink, actual absence checks,
limits and deadlines remain intact; rejected deletion API candidates are removed.
This is test-fixture/teardown work, not a claimed product/kernel/scanner repair.
CI commit `800d761` adds ordinary unpublished packaged checks; its earlier PR
origin failure remains preserved and undiagnosed. Both later `a94f104` runs pass
all five CI jobs, desktop 257/257 and three origin launches each. Actual ZIP,
input-manifest and final package-identity receipts pass independent review.
Merge remains held.

The current validation-only follow-up corrects Chrome's raw-concatenation
oracle: independent DXF TEXT entities may have viewer-added layout separators.
The tracked comparator keeps each complete source fragment literal and ordered,
including all internal spaces/NBSP/Unicode, with bounded ASCII space/CR/LF only
between records and no unmatched prefix/suffix. All 48 regression tests and a
fresh native Chrome run pass: 31/31 checks, three existing real Windows Plot PDFs,
19 independently pre-pinned source fragments. Original failed reports and all
PDF/font/source bytes remain unchanged. This is a validation fix, not a PDF or
renderer behavior change. Its full/CI gate must pass on the new head; the draft
PR retains the exact final evidence without rewriting historical reports.

Earlier evidence in the [Windows checkpoint](PRIORITY-12-WINDOWS-CHECKPOINT.md) records a normal
6,954/0/40 pass without optional DWG inputs, followed by the required private-DWG
combined run at **6,955/1/38** with the same unresolved unlink stall (344 ms).
Both private DWG cases pass and do not overlap the stall. The observed two-file
run passes 36/36 without reproducing it; that isolated evidence did not clear the
old failure. The subsequent normal full gate above uses the corrected fixture.
An unpublished full-DWG test ASAR now passes 63 packaged F4 assertions and nine
independent raster checks. A later configured-Poppler reinspection passes
2883/2883; the original 2882/2883 report is retained. Its broad E2E launch
was confirmed blocked by Code Integrity for the intentionally unsigned EXE;
current broad acceptance is being checked through CI. Smart App Control stays enabled; the installed
v0.5.0 reference signature is Valid. No installer or signing setting is changed.

A subsequent normal run of the entire Windows export-admission file passes
**34/34** in 1.63 seconds (large-file case 372 ms), using unchanged source,
assertions and deadlines, without a preload or external observer. This narrows
the cleanup diagnosis without clearing the earlier failed full-suite gate. The existing
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
lint and the fresh renderer build pass. Corrected head `f902d00` historically passed all
five PR CI jobs: Node 22, Node 24, Windows Electron, UI and experimental GPU.
The earlier local full-suite cleanup and viewer holds remain separate; the narrow PDF results below have been reinspected.

Commit `743fdbb` passes the fresh Windows source-runtime Plot/edit/save/reopen
workflow, including Bahnschrift through app IPC, exact whole-variable programs,
three optical-size refusals, all 63 real-DWG F4 assertions and nine independent
Han raster checks. Six Canvas/PDF crops remain within the original 3px bounds;
source/fonts stay unchanged and the owned Electron exits. Its original native
PDF inspection is **2,882/2,883**, retaining the Symbol warning on the Helvetica
fallback control. Six consumed-ticket cancellation diagnostics remain disclosed.

Fresh authored CFF/mixed proof on the same commit produces 34 PDFs with **168/168
producer checks**. Original strict inspection is **1,873/1,903**: 28 pypdf
custom-Encoding extraction failures and two fallback-control Symbol warnings
are retained. All 52 PDFium page extractions and raw glyph/CID/Unicode mappings
pass. A separate 67-check local-library/source-integrity classification confirms
the pypdf limitation without turning the strict failed gate green. Installed-CFF,
broad packaged-app and broader viewer acceptance remain open. All five prior
PR CI jobs passed on the earlier source head; the historical `800d761` packaged
PR origin failure remains separate from the later passing `a94f104` receipts.
The later packaged font slice is recorded in the checkpoint.

The subsequent private validator correction passes **2,883/2,883 native checks**
on unchanged packaged artifacts and **1,903/1,903 authored CFF checks** with a
narrow checked-CMap decoder, after **221/221 independent controls**. Configured
Poppler plus stock pypdf still fails the same 28 extraction checks
(**1,875/1,903**). The original reports and PDF/font/source-proof bytes remain
unchanged; raw glyph/CID/width, PDFium and existing pixel/tolerance checks stay.
The actual DLL fonts root is `poppler/share/fonts`; a private runtime supplies
byte-identical installed Microsoft Symbol under `StandardSymbolsPS.ttf` there.
This clears the initialization warning on PDFs with no Symbol resource; it is
not URW identity or Symbol glyph acceptance. The decoder changes only private
validation, not JCad PDFs or installed pypdf, and is not stock-pypdf acceptance.
See the [Windows checkpoint](PRIORITY-12-WINDOWS-CHECKPOINT.md) for receipts and
remaining installed-CFF/wider-viewer limits.

| Piece | Current evidence and status | Next gate / owner |
|---|---|---|
| 12.1 collection selection | Reviewed and corrected locally; real Windows workers/IPC/Plot and private AutoCAD reference pass for the tested Nirmala faces and Arial. | Lead: combined acceptance, packaged checks and CI. |
| Used-glyph validation (SimSun scope) | Algorithm and DWG/F4 source composition reviewed; 132 independent authored-PDF checks pass. Real SimSun still refuses at bitmap/origin validation, YaHei at conflicting PostScript names. | Lead: packaged/CI gates; native Han vector acceptance remains absent. Actual missing-SHX raster output and explicit vector refusal pass. |
| 12.3 glyf subsetting | Reviewed and corrected; real Windows subset/whole-control Unicode and pixels match. Added actual-byte whole-program guard for variation tables: eight failing-before/passing-after regressions. | Lead: combined suite and native gates. Variation-aware subsetting remains deferred. |
| 12.6a variable defaults | Corrected source retains legal-name-ID guards and current TTC/used-glyph/subset/F4 behavior. Final archive adds no code. Real Bahnschrift app IPC/Plot/edit/save/reopen and whole-program identity pass on `743fdbb`; varying optical-size fonts refuse explicitly. Native Chrome passes exact source-fragment text with the corrected boundary oracle. | Lead: retain `74369d3` full 7022/0/38 and both packaged/CI gates, then verify the packaging follow-up; retain narrow PDF conditions. These results cover the tested default, not named instances or all variable fonts. |
| 12.2 standalone CFF1 | Corrected parser/writer, implicit-matrix/late-width guards, aliases and resource-scoped PDF1.6 are integrated. Fresh actual-reader/capture proof produces 34 PDFs; producer 168/168, configured checked-CMap inspection 1903/1903 after 221/221 controls. Stock pypdf retains 28 failures; original 1873/1903 report and classification 67/67 remain recorded. | Lead: retain original failures and declared private decoder scope, then complete acceptance. No installed standalone CFF font is available; synthetic checks do not establish real-font IPC/viewer compatibility. |
| 12.4 preview/print permissions | Round-3 archive `4856b53e…`, declared head `2308000`, reconstructs to the prior first-14-patch tree plus two guard repairs. Lead review found and corrected a further slice-before-budget allocation; nine new controls pass (seven fail on the supplied guard), alongside all 28 earlier independent controls. The bounded engine is integrated without enabling Plot; its 51 targeted tests, including a real Node child transform, all three typecheck projects, full lint, fixture/workflow checks and renderer build pass on Windows. Exact glue bytes are preserved by a Git attribute. | Lead: compose current font/DWG and startup behavior, then native utilityProcess/Plot/IPC, combined suite, PDF and packaged CI gates. Ordinary preview/print refusal remains active until that wiring is integrated. No merge clearance. |
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
