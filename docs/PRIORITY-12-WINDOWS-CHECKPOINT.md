# Priority 12 Windows validation checkpoint

## Current startup repair and packaging evidence

Packaging head `e72c9f8` passes the full Windows/private-DWG suite **7,029/0/38**.
Both ordinary CI artifacts contain byte-identical source license/notices and
pass packaged desktop 257/257 with unchanged inputs/package identity. All five
push jobs pass. The PR Windows job fails its first packaged-origin launch at
the original 60-second deadline; its other four jobs pass. No retry or sibling
pass clears that failure.

The diagnostic shows only the hidden legacy-storage window, with no main
window. The original migration has unbounded load/read awaits; its catch can
also open an empty origin whose preload permanently acknowledges an empty
checkpoint. The repair bounds load/readiness to 15 seconds and storage execution
to five seconds, handles renderer failure and cleans up the owned window and
protocol handler. An incomplete read now stops startup with a visible error
before creating a main window or acknowledging migration. Existing settings and
checkpoints remain intact. These are failure-handling repairs; the underlying
native promise stall is not established.

The four-file focused gate passes **68/68**. Running the 36 new cases against
the original two source files produces **28 failures and eight passes**; exact
candidate bytes and the Git index are restored afterward. Broader source and
fresh packaged CI on the repaired head remain required. The draft PR records
their exact final head and receipts. Merge remains held for these gates and
Muse's separate 12.4 corrections. Historical evidence follows.

## Historical complete checkpoint and packaging follow-up

The exact `74369d3` Windows/private-DWG suite passes **7,022 tests, zero failures,
38 skips** (398 files, 204.70 s). Both ordinary PR/push CI runs pass all five
latest job results. Actual artifacts pass desktop 257/257 and three origin
launches each, with 15,698 equal before/after inputs and unchanged EXE/ASAR/fuses.
The push GPU's original Electron acquisition failure is retained; one GPU-only
re-execution passes, with no deadline or assertion changes. Chrome passes 31/31
native-text checks plus the earlier separate 12/12 authored-CFF/mixed checks.

The next narrow packaging change explicitly includes `LICENSE` and
`THIRD-PARTY-NOTICES.md` in the app archive. The real builder filter and an
existing test ASAR prove that both were previously absent. CI now verifies the
two archived documents byte-for-byte against source and records their hashes.
Real ASAR controls reject missing, stale and BOM-modified notices; the real
builder-filter regression fails before the file-inclusion fix. This follow-up
requires its own source and packaged CI gate; the draft PR records the final
head and receipts. Signing, dependencies, installers and release workflows are
unchanged.

The fourteen-patch 12.4 candidate remains unadopted. Its earlier controls now
pass 14/14, but new bounded pinned-JS controls pass 10 and fail four assertions:
cached file-stream writes bypass the guard, and Buffer slicing can retain more
backing storage than the admitted budget. These are isolated actual JS methods
with modeled filesystem initialization, not native IPC/WASM exploit evidence.
Justin forwarded the verified round-three feedback to Muse. Corrected source,
native utilityProcess/Plot/IPC/save and combined gates remain required. Merge
stays held and priority 12 remains incomplete. Historical checkpoints follow.

2026-10-16 Chrome-comparison follow-up; branch `review/p12-dwg-f4`, over tested
head `a94f104`. Application bytes are unchanged from the inspected
`435f57e` tree. Draft PR #23 remains unmerged; no publication, installer,
installation, release signing or security-setting change. The long roadmap
remains paused.

| Check | Result and limit |
|---|---|
| PR CI | Both ordinary runs at `a94f104` pass all five jobs each, including Windows packaged and GPU. Actual PR merge parents and branch head are verified. The new validation-only comparison follow-up requires its own full/CI gate; see the draft PR for the final head/receipts. |
| Native prerequisites | Four unchanged Windows files pass 145/145 outside the restricted sandbox, with private process-only temp paths. |
| Full suite without optional customer inputs | 6,954 passed, zero failed, 40 skipped; 395 files, 194.64 s. The two private DWG cases were skipped; this does not clear their combined gate. |
| Full suite with both hash-pinned private DWG inputs | At `a94f104`: **6,974 passed, zero failed, 38 skipped**; 397 files, 188.35 s. Both DWG cases and all 34 export-admission cases pass, without preload/observer. Tracked inputs and private drawings remain unchanged. The new comparison adds 48 targeted tests; its combined gate is recorded separately. |
| Historical two-file promise diagnostic | Export-admission and private-DWG files pass 36/36; original unlink promise fulfills in about 0.5 ms. Instrumented, nonreproducing evidence only; it did not clear the earlier full-suite failure. |
| Private full-DWG test ASAR | Build succeeds with existing Electron 44.7.2/helper. Source, dependency, runtime and resource inputs remain unchanged; 65 packed application/renderer files and copied DWG resources match. Test metadata, all test fuses and PE/ASAR header digest are independently verified. No installer or signing operation. |
| Packaged font/Plot/DWG workflow | 63/63 F4 assertions and nine independent Han raster checks pass. Actual packaged workers/IPC receive 19 metric and 26 PDF-font calls. TTC faces, Bahnschrift whole default, optical-size/Han refusals, edit/undo/redo/DXF reopen and source protection pass. No page errors; source/fonts unchanged; owned processes exit. |
| Packaged independent PDF inspection | **2,883/2,883** on unchanged artifacts with the private configured Poppler runtime; the original 2,882/2,883 report is retained. Six Canvas/PDF crops satisfy the original 3px bounds; contract/fallback images visually inspected. |
| Authored CFF PDF inspection | **1,903/1,903** with the narrow checked-CMap adapter after **221/221 controls**. Configured Poppler with stock pypdf remains **1,875/1,903**, with the same 28 extraction failures. All 52 PDFium page extractions and raw glyph/CID/width checks pass. Original 1,873/1,903 report retained; installed-CFF/wider-viewer acceptance stays open. |
| Broad packaged E2E | At `a94f104`, PR `38923301969` and push `38923294678` both pass desktop **257/257** and all three origin launches. Each GitHub-digest-matched artifact has 15,695 equal before/after input records, 65 packed sources, full DWG resources/test fuses and final EXE/ASAR/fuses identical to initial proof. Earlier `800d761` PR origin failure remains preserved and undiagnosed. Local unsigned launch remains blocked by Smart App Control. |
| Native Chrome PDF text | Fresh run `native-record-runs/run-t9wwa4ek` passes **31/31** on three unchanged Windows Plot PDFs. All 19 independently pre-pinned DXF text fragments, internal spaces/NBSP/Unicode and edit markers match exactly in order; screenshots inspected. The comparison permits bounded layout separators only between entity records. All **48 regression tests** pass. |

## Chrome spacing comparison repair

The earlier 28/30 Chrome probe incorrectly concatenated distinct source TEXT
records after removing line breaks. Two records at `(20,40)` and `(100,40)` have
an ordinary viewer-added separator between them. The corrected, tracked
`scripts/pdf-viewer-text.mjs` compares each complete source fragment literally,
in order, with zero unmatched prefix/suffix. Only ASCII space/CR/LF may separate
records, up to 16 code units; input/source text is bounded to 10,000 UTF-16 code
units and 64 nonempty own-indexed fragments. Ambiguous leading/trailing source
layout is refused rather than trimmed. No global whitespace or Unicode
normalization is used. Regression controls reject changed internal spaces/NBSP,
inserted CR/LF, missing/reordered glyphs, extra non-layout characters, sparse or
inherited fragments, normalization changes and limit overruns.

One fresh Chrome 155 run uses that same helper, pinned before launch. All 31
checks pass, including exact source text, original/copied PDF/font/source hashes,
the comparator hash and owned-process cleanup. Original failed reports and
scripts remain unchanged; the new run is separate evidence. This repairs the
validation oracle, not JCad PDF generation. Exact inter-entity formatting in all
viewers, installed CFF fonts and release/installer acceptance are not claimed.

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

Historically, the `800d761` packaged desktop result is 257/257 in both artifacts;
its failed origin check is not cleared by the sibling pass. That PR checks merge SHA
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
and lint pass. These controls do not establish a startup root cause. The later
`a94f104` ordinary CI runs complete successfully and their actual receipts pass
independent review. The new comparator follow-up requires fresh CI.

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

Broad packaged acceptance uses the separate CI test artifact; the `a94f104`
PR/push receipts pass without changing machine security. The comparator follow-up
must retain those gates. Test-ASAR success is not installer, installed-release,
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
Those improvements do not fix that candidate's remaining defects or establish native-mode
acceptance. Justin forwarded the round-two bundle to Muse. A new fourteen-patch
delivery, ZIP SHA256 `c61cfaca24b96b867972f953c3b82553e813b489378443a012194f6fc85dcd2d`,
declares head `be3ca1f312f4160b16b362cd801019313589fa7b`. Its first eleven diff
payloads are identical; three added commits address quarantine settlement,
MEMFS write/accounting and memory-envelope documentation. Seventeen manifest
entries verify. This establishes a different intact delivery, not correctness;
none is adopted and the new fixes still require independent/native validation.

Ordinary preview/print-font refusal stays active. Later narrow composition must
retain selected-face/fallback/SHX, CFF mapping, subsetting, whole-variable and
DWG/F4 safeguards. The new comparator follow-up's full/CI gates and outstanding
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
- `p12-packaged-completion/artifacts-a94f104/FINAL-ALL-JOBS-REVIEW.md`
- `p12-browser-viewer/NATIVE-RESULT.md` (original 28/30 retained)
- `p12-browser-viewer/NATIVE-RECORD-BOUNDARIES-RESULT.md` (fresh 31/31)
- `p12-chrome-spacing/` (48-test regression/type/lint/build logs)
- `p12-incoming-oct16-round3/TRIAGE.md` (new 12.4 delivery, not adopted)

Failed helper checks are retained: the archive API separator error was corrected
in a separate inspector without repackaging; the initial whole-font inspector
report was retained before using the exact previously accepted subset-aware
inspector. Neither is product-failure evidence. The failed private-font Poppler
experiment also remains recorded; unchanged warning/pixels grant no waiver.
