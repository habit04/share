# Priority 12 Windows validation checkpoint

2026-10-16 follow-up; branch `review/p12-dwg-f4`, test commit `6dab4cb` over
CI commit `800d761`. Application bytes are unchanged from the inspected
`435f57e` tree. Draft PR #23 remains unmerged; no publication, installer,
installation, release signing or security-setting change. The long roadmap
remains paused.

| Check | Result and limit |
|---|---|
| PR CI | All five prior jobs pass on `435f57e`. New `800d761` Windows source/origin checks pass in both runs; broad packaged acceptance has one passing push job and one failing PR job under review. Do not substitute the sibling pass for the failed PR check. |
| Native prerequisites | Four unchanged Windows files pass 145/145 outside the restricted sandbox, with private process-only temp paths. |
| Full suite without optional customer inputs | 6,954 passed, zero failed, 40 skipped; 395 files, 194.64 s. The two private DWG cases were skipped; this does not clear their combined gate. |
| Full suite with both hash-pinned private DWG inputs | **6,967 passed, zero failed, 38 skipped**; 396 files, 210.13 s. Both DWG cases and all 34 export-admission cases pass, without preload/observer. Tracked inputs and private drawings remain unchanged. |
| Historical two-file promise diagnostic | Export-admission and private-DWG files pass 36/36; original unlink promise fulfills in about 0.5 ms. Instrumented, nonreproducing evidence only; it did not clear the earlier full-suite failure. |
| Private full-DWG test ASAR | Build succeeds with existing Electron 44.7.2/helper. Source, dependency, runtime and resource inputs remain unchanged; 65 packed application/renderer files and copied DWG resources match. Test metadata, all test fuses and PE/ASAR header digest are independently verified. No installer or signing operation. |
| Packaged font/Plot/DWG workflow | 63/63 F4 assertions and nine independent Han raster checks pass. Actual packaged workers/IPC receive 19 metric and 26 PDF-font calls. TTC faces, Bahnschrift whole default, optical-size/Han refusals, edit/undo/redo/DXF reopen and source protection pass. No page errors; source/fonts unchanged; owned processes exit. |
| Packaged independent PDF inspection | **2,883/2,883** on unchanged artifacts with the private configured Poppler runtime; the original 2,882/2,883 report is retained. Six Canvas/PDF crops satisfy the original 3px bounds; contract/fallback images visually inspected. |
| Authored CFF PDF inspection | **1,903/1,903** with the narrow checked-CMap adapter after **221/221 controls**. Configured Poppler with stock pypdf remains **1,875/1,903**, with the same 28 extraction failures. All 52 PDFium page extractions and raw glyph/CID/width checks pass. Original 1,873/1,903 report retained; installed-CFF/wider-viewer acceptance stays open. |
| Broad packaged E2E | Both Windows CI runs pass desktop **257/257**, with all 15,692 input records unchanged and 65 packed sources, full DWG resources, metadata and test fuses verified. Push run `38918885254` passes all three origin launches; PR run `38918892151` fails the original 60s first-window check before any preference result. Driver/step budgets did not expire. Cause remains unresolved; merge remains held. Local unsigned launch remains blocked by Smart App Control. |

The size-boundary fixture now contains neutral bytes with a `.bin` suffix. This
test selects PDF eligibility by explicit export kind and hashes opaque bytes;
it never parsed a valid PDF. All size boundaries, 256KiB scratch/read checks,
ordinary-kind refusals, disposal/zero-reader checks, original native unlink,
actual file/directory absence assertions and 60s/10s deadlines remain intact.
The project-save fixture captures its directory, cancels batches before retiring
the owner, and joins operations/the 33-file producer before deleting files.
Failure-only stage timestamps retain the original 30s deadline.

The combined four-file stress gate passes 63/63; the neutral boundary case also
passes alone before the full gate. Callback and Win32-child deletion candidates
failed their full gates and were removed. No alternate deletion API, retry,
timeout increase or proven antivirus/native-kernel cause is claimed. This is a
test-fixture/teardown correction, not a product save-engine change or proof of
valid 512MiB PDF rendering.

The packaged desktop result is 257/257 in both actual CI artifacts; the failed
origin check is not cleared by the sibling pass. PR CI checks merge SHA
`0ede4e5ef8a0db31d54a650e35db792268aa8302`; push CI checks `800d761`.
Cross-run application, renderer, scripts, build and other dependency bytes match;
four generated DWG entries and the existing Vitest cache differ, each run's
inputs remaining internally unchanged. No product-startup cause is established.

Failure-only origin diagnostics now retain bounded process/window/exit/crash
events, a best-effort 2s main-window snapshot, selected private profile metadata
and error-log tail under the uploaded output. Original assertions/60s deadline
remain unchanged, and diagnostic/close errors cannot replace the original failure.
The CI runner also verifies EXE/ASAR/fuses after a failed driver. Seven mocked
diagnostic controls pass within a 112-test focused gate; renderer/scripts types
and lint pass. These controls do not clear the real origin failure: the new
ordinary CI run must complete and its actual receipt must be reviewed.

The exact Poppler DLL getter identifies `poppler/share/fonts`, distinct from the
earlier failed `Library/share/fonts` control. A private byte-identical runtime
copy adds only installed Microsoft Symbol bytes under the compiled lookup name
`share/fonts/StandardSymbolsPS.ttf`. The Helvetica-only control has empty stderr
and identical pixels; rerun PDFs contain no Symbol font resource. This alias is
not authentic URW StandardSymbolsPS and establishes no Symbol glyph fidelity.
Original runtime/fonts, PDFs and failed reports remain unchanged.

The CMap correction is a private validation decoder for checked fixed-two-byte
Type0 maps, not a JCad change or stock-pypdf acceptance. Independent handwritten
maps witness the stock failure and corrected/PDFium extraction; malformed maps
refuse and independent wrong-Unicode/CID controls detect semantic errors. No
PDF CMapType, warning assertion or rendering tolerance is changed.

Assertions, limits, deadlines, isolation and two workers stay unchanged. An
instrumented full attempt inside the restricted sandbox is retained separately:
333 imports fail on transient-cache ENOENT; 57 assertions fail on permissions,
cache access or PowerShell policy. It is not a completed 6,994-test product gate.
Private temp paths alone did not grant native junction capability; the 145-test
prerequisite run established the appropriate execution context.

An earlier failing full run's private DWG tests begin 36.183 seconds **after** the export
file finishes. They do not overlap the stall. Vitest sorts using cached failures
and durations, so the same CLI does not prove identical order. No DWG causal
claim is established. Historical failures stay recorded alongside the corrected
fixture's completed normal gate.

## Signing and acceptance limits

The private test config deliberately sets `signExecutable: false`; its EXE is
`NotSigned`. Smart App Control remains enabled (policy state 1). No security
setting, certificate, credential or release workflow is changed. No further
local unsigned-app launch experiments are proposed for this checkpoint.

Read-only comparison finds the installed **v0.5.0** app has a **Valid** Authenticode
signature from Justin Rodriguez. This is a prior-release reference, not validation
of the new test artifact or every published asset. The existing release workflow
requires publisher signing for publication and verifies the app, installer and
DWG helper against that publisher; it was inspected, not dispatched.

Broad packaged acceptance uses the separate CI test artifact and still needs a
clean PR result/receipt without changing machine security. Test-ASAR success is not installer, installed-release,
shipping-fuse or AutoCAD acceptance. Installed-CFF and wider-viewer gates remain
open; historical CFF strict inspector failures remain recorded separately.

## Muse 12.4 corrections

The eleven-patch archive is independently reconstructed on genuine `a68dba5`;
tree `ff8ceb290194ed65c66fd53ed2273ef1bedf414c` matches. Fourteen manifest checks
pass. Six original patch diff sections are unchanged; five corrections are new.
No candidate application files are adopted.

Bounded probes reproduce three remaining defects (eight passing/six failing
assertions, unchanged bytes): quarantine strands queued work; no-op MEMFS resize
credits retained storage; actual pinned first-write allocation bypasses the guard.
The related adoption bypass is static glue evidence, not a separately executed
probe. Host channels are mocks; memory cases evaluate isolated pinned JS, not
WASM/native GUI. Corrected verifier controls pass 10/10, including known-owner
and fresh Windows pairs, old corrupt-width rejection and PDF boolean resolution.
Those improvements do not fix the remaining defects or establish native-mode
acceptance. Justin has forwarded the round-two bundle to Muse.

Ordinary preview/print-font refusal stays active. Later narrow composition must
retain selected-face/fallback/SHX, CFF mapping, subsetting, whole-variable and
DWG/F4 safeguards. The failed packaged PR check and outstanding
12.4 utilityProcess/Plot/save checks still prevent merge clearance. The narrow
PDF checks above pass under their stated validator conditions; installed-CFF
and wider-viewer acceptance remain open.
Priority 12 is incomplete.

## Private evidence

Raw logs and receipts remain under the own worktree's ignored `.codex-local/`:

- `p12-native-settlement-review/run-normal-controls-eBzaz6/`
- `p12-native-settlement-review/run-normal-full-qUpd7S/`
- `p12-native-settlement-review/run-normal-full-AQ3BmH/`
- `p12-native-settlement-review/run-pair-KC4she/`
- `p12-temp-cache-review/TIMELINE.md` and `TIMELINE.json`
- `p12-packaged-preflight/runs/run-KmyYak/`, including the failed broad driver
- `p12-packaged-preflight/code-integrity-own-package-events-utc.json`
- `p12-packaged-preflight/signing-comparison.json`
- `p12-dwg-f4/windows-harness/windows-packaged-run-c3IJJG/`
- `p12-incoming-oct16-round2/12.4-review/probe-runs/run-BwFLVo/`
- `p12-incoming-oct16-round2/verifier-controls-row88mpm/`
- `p12-pdf-completion/PDF-CHECKS-RESULT.md`, `strict-comparison.json` and `SHA256SUMS`
- `p12-pdf-completion/strict-reruns/` and `cmap-proof/run-bsowpolb/`
- `p12-cleanup-fix-review/run-full-fD9qFW/` (rejected callback candidate)
- `p12-cleanup-fix-review/run-full-qt1jSV/` (rejected Win32-child candidate)
- `p12-cleanup-fix-review/run-stress-dwKGnj/`, `run-single-Sxk6V9/` and `run-full-QytAc2/`
- `p12-packaged-completion/local-gates-SdMAWz/` and `local-gates-HwJCll/`
- `p12-packaged-completion/ci-observation-800d761-1503.json`
- `p12-packaged-completion/artifacts-800d761/` and `PACKAGED-800-ARTIFACT-REVIEW.md`
- `p12-packaged-completion/local-gates-3btu46/`

Failed helper checks are retained: the archive API separator error was corrected
in a separate inspector without repackaging; the initial whole-font inspector
report was retained before using the exact previously accepted subset-aware
inspector. Neither is product-failure evidence. The failed private-font Poppler
experiment also remains recorded; unchanged warning/pixels grant no waiver.
