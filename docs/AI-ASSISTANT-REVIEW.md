# AI milestone 1 — local integration review

Reviewed on 2026-10-16 (America/Chicago). Accepted locally on `review/ai-m1`
in an independent clone. No existing JCad checkout, installed application,
original drawing or active user process was changed. No remote push, merge,
installer, signing, workflow or release action was performed.

The result is an **offline demonstration of selection questions**, backed by
a deterministic fixture provider. No live model, endpoint or credential is
configured; the Electron host is neither registered nor exposed by preload.
This is not acceptance of a live provider or of packaged-app behavior.

## Input and provenance

- Input: `JCad-AI-m1-handoff.zip`.
- Archive SHA-256: `563442146200c94a0e6aa6106bc39c4bfdd2610e5f51a55a872ca05739e11418`.
- All 12 entries listed in the supplied checksum manifest matched before extraction.
- Base: `a68dba5b16ed4099d8decae32f936ebc023129fa` (JCad v0.5.2).
- Muse's reported head: `667413702e429dd5191f1815a581d71f48820d73`.
- The five format patches applied cleanly; imported local head before review
  corrections: `c919e918cf188e4a25315b49f0631bc6649e5df4`.
- Incoming tree: `9758f2a3681f4834f11c641dfdf06a1c7593e346`.
- Dependencies were privately copied from an installed tree with an identical
  package lock; no dependency or configuration changes were made.

## Corrections made during review

- Replaced a Unix `grep` shell test with portable Node filesystem traversal.
- Corrected bulged-polyline lengths and paper-space coordinate units.
- Bounded geometry enrichment, table/attribute scans and unsupported-ID lookup
  work; large measurements are explicitly omitted instead of approximated.
- Measured the exact UTF-8 snapshot, including its byte-count field, and kept
  omission metadata inside the context budget without shortening object IDs.
- Converted malformed answers and context failures into controlled statuses;
  cleaned up timers and returned each request's own terminal result.
- Whitelisted response fields, bounded references and counted removed entries.
- Contained keyboard events in the panel and AI toggle so focused controls
  cannot dispatch drawing commands or cancel the current drafting tool.
- Cleared previously displayed answers when their document/selection context
  changes, and labelled the offline demo persistently.
- Rebuilt dormant host requests from a field whitelist, aligned its schema
  with real renderer snapshots, and added queued/running cancellation with
  enqueue deadlines and bounded physical transport concurrency.
- Refused Linux plaintext/unknown credential backends. Future transports
  still need provider-specific token/body limits and sender-scoped IPC wiring.

All changes stay within the AI milestone and its UI entry point. Font/PDF,
DWG, GPU/3D and xref implementations were not modified.

## Verification

Windows, Node v24.19.0, pinned dependency lock unchanged.

| Check | Result |
| --- | --- |
| Required fixture inventory | Passed |
| Six focused AI suites | 97 passed |
| Full-project ESLint, zero warnings | Passed |
| Renderer/tests TypeScript | Passed |
| Electron `checkJs` TypeScript | Passed |
| Production renderer build | Passed; ordinary large-chunk advisory retained |
| Full Vitest suite, `--maxWorkers=2` | 374 files passed, 1 skipped; 6,717 tests passed, 38 skipped; 174.82 seconds |
| Real unpackaged Windows Electron, private profile | Passed |
| Headless browser visual inspection, private profile | Passed |
| Diff whitespace check | Passed |

The incoming focused run had 50 passes and one failure caused by the Unix-only
test. The first full run inside the execution sandbox had 64 failures, including
filesystem-link permission errors. The unchanged two-worker full command then
passed outside that sandbox using a private temporary directory. These logs are
retained separately; assertions, deadlines and configuration were not weakened.

The native UI harness uses synthetic objects and a separate verified user-data
and session-data directory. It checks the absent live bridge, exact context
bytes, curved geometry, inert text, and preservation of document identity,
revision, selection, history, dirty state, file path, active LINE tool, space
and camera. Real key events in the question field and Ask button cannot edit
the drawing. A selection change clears a displayed answer. No renderer errors
or external renderer requests were observed. The separate browser capture
verifies the rendered offline answer; native hidden-window captures are also
included as supplemental evidence.

The reviewed handoff contains raw logs, the private test harnesses, synthetic
screenshots and a machine-readable receipt. Private browser/Electron profiles,
dependencies, generated builds and original user drawings are excluded.

## Remaining scope

Select the first provider/local endpoint and agree its data policy before live
activation. This acceptance does not validate provider requests, monetary caps,
actual credential persistence, packaged installers or a combined integration
with the other active JCad workstreams. Previewed drafting, electrical
assistance and MCP remain separate milestones.
