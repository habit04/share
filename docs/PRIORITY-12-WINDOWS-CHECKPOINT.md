# Priority 12 Windows validation checkpoint

2026-10-16; application source `435f57e4c535c6708552e8d6a2993bce6d477f3e`,
draft PR #23. Nothing is merged, published, installed or release-signed by this
checkpoint. The long roadmap remains paused.

| Check | Result and limit |
|---|---|
| PR CI at the source commit | All five jobs pass: Node 22, Node 24, Windows Electron, UI and experimental GPU. |
| Native prerequisites | Four unchanged Windows files pass 145/145 outside the restricted sandbox, with private process-only temp paths. |
| Full suite without optional customer inputs | 6,954 passed, zero failed, 40 skipped; 395 files, 194.64 s. The two private DWG cases were skipped; this does not clear their combined gate. |
| Full suite with both hash-pinned private DWG inputs | **6,955 passed, one failed, 38 skipped**; 395 files, 239.24 s. Both DWG cases pass. The large-PDF fixture again stops awaiting native unlink after product checks, disposal, zero readers, truncation and close. Merge clearance remains withheld. |
| Two-file promise diagnostic | Export-admission and private-DWG files pass 36/36; original unlink promise fulfills in about 0.5 ms. Instrumented, nonreproducing evidence only; it does not explain or clear the full-suite failure. |
| Private full-DWG test ASAR | Build succeeds with existing Electron 44.7.2/helper. Source, dependency, runtime and resource inputs remain unchanged; 65 packed application/renderer files and copied DWG resources match. Test metadata, all test fuses and PE/ASAR header digest are independently verified. No installer or signing operation. |
| Packaged font/Plot/DWG workflow | 63/63 F4 assertions and nine independent Han raster checks pass. Actual packaged workers/IPC receive 19 metric and 26 PDF-font calls. TTC faces, Bahnschrift whole default, optical-size/Han refusals, edit/undo/redo/DXF reopen and source protection pass. No page errors; source/fonts unchanged; owned processes exit. |
| Packaged independent PDF inspection | **2,882/2,883**, retaining the Poppler missing-Symbol warning on the Helvetica fallback control. Six Canvas/PDF crops satisfy the original 3px bounds; contract/Han raster images visually inspected. Strict gate remains failed. |
| Broad packaged E2E | First launch blocked before checks; origin migration not executed. Code Integrity events 3033/3077 at 13:57:05–06 UTC name the exact private unsigned EXE. Later successful diagnostic/font workflow does not clear that failed driver. |

Assertions, limits, deadlines, isolation and two workers stay unchanged. An
instrumented full attempt inside the restricted sandbox is retained separately:
333 imports fail on transient-cache ENOENT; 57 assertions fail on permissions,
cache access or PowerShell policy. It is not a completed 6,994-test product gate.
Private temp paths alone did not grant native junction capability; the 145-test
prerequisite run established the appropriate execution context.

The failing full run's private DWG tests begin 36.183 seconds **after** the export
file finishes. They do not overlap the stall. Vitest sorts using cached failures
and durations, so the same CLI does not prove identical order. No DWG causal
claim or unlink fix is established; further full retries do not grant clearance.

## Signing and acceptance limits

The private test config deliberately sets `signExecutable: false`; its EXE is
`NotSigned`. Smart App Control remains enabled (policy state 1). No security
setting, certificate, credential or release workflow is changed. No further
unsigned-app launch experiments are proposed for this checkpoint.

Read-only comparison finds the installed **v0.5.0** app has a **Valid** Authenticode
signature from Justin Rodriguez. This is a prior-release reference, not validation
of the new test artifact or every published asset. The existing release workflow
requires publisher signing for publication and verifies the app, installer and
DWG helper against that publisher; it was inspected, not dispatched.

Broad packaged acceptance still needs an allowed/trusted test artifact without
changing machine security. Test-ASAR success is not installer, installed-release,
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
DWG/F4 safeguards. Full-suite cleanup, strict PDF, trusted packaged testing and
corrected 12.4 utilityProcess/Plot/save checks still prevent merge clearance.
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

Failed helper checks are retained: the archive API separator error was corrected
in a separate inspector without repackaging; the initial whole-font inspector
report was retained before using the exact previously accepted subset-aware
inspector. Neither is product-failure evidence. The failed private-font Poppler
experiment also remains recorded; unchanged warning/pixels grant no waiver.
