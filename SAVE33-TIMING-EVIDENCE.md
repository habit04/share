# Save33 — timing evidence for the D1 test-limit decision (v2)

> **Corrections note (v2):** This version supersedes v1's attribution and
> provenance passages. It applies Codex's corrections D1-E1 and D1-E2 (D1
> source review, `save33-d1-source-review-20261018`) and adds the lead's D1
> validation observations (`claude-save33-d1-01\VALIDATION.md`). The P2
> per-stage attribution and its projections are **withdrawn** as acceptance
> evidence (see "Withdrawn attribution" below), the digest-count figure is
> corrected, durations are listed with per-figure provenance and split into
> completed vs elapsed-at-deadline, and the option-B wording is corrected.
> **The decision and the limit are unchanged.**

**Case:** `tests/windows-project-save-ipc.test.ts` —
`'reads, edits, backs up and freshly reopens 33 files under one inherited project order'`
(the "Save33" case). It drives 33 real private NTFS DXF files through the
production project-save IPC: bind under one inherited project order, open and
edit each file (with undo/redo history in the surrounding suite), seal the
basis, back up all 33, then serially save each one — every save gated by a
per-output admission receipt, a byte-exact backup comparison, and a fresh
reopen check — then cancel the batch and assert no `.tmp-` residue remains.
Nothing in the case is mocked at the boundary it measures: the durations below
are the production batch-save path running end to end.

## Measured durations (Justin's PC, Windows/NTFS)

The figures come from two related trees and are listed with their sources:
the private combined tree `8a0f702a` on Justin's PC, and the PR #24 gate
lineage (`bf7b5cb` / `e6304496`). No claim is made here about code identity
between the two lineages' save paths.

### Completed durations

- **Solo, tree `8a0f702a`:** 19,989 ms to 26,172 ms across runs.
- **Solo, tree `8a0f702a` with the D1 patch applied** (lead's validation,
  owned Jobs, Node 24.20.0): **PASS at 30,085 ms** — above the old 30,000 ms
  limit; this run would have failed there.
- **In-suite completions, tree `8a0f702a`, under the old limit:** 28,596 ms
  and 29,710 ms (passes); a further full-suite run with the P1 derivative
  fitted also completed the case at 29,710 ms.
- **In-suite, tree `8a0f702a` with the D1 patch applied** (lead's
  validation): **PASS at 33,926 ms** — the slowest completed observation so
  far. That full suite finished **8,196 pass / 0 fail / 39 skip, exit 0**,
  the same totals as the earlier passing custody run.

### Timed-out runs (elapsed at deadline — NOT completed durations)

The following full-suite readings are **elapsed-at-deadline values** from
runs where the case was killed at the old 30,000 ms limit. The case's true
duration on those runs is unknown — only that it exceeded 30,000 ms. The
elapsed readings cluster only ~18–41 ms past the deadline, i.e. the case was
being cut off essentially at the limit:

- Tree `8a0f702a` full-suite runs: 30,019 / 30,022 / 30,031 / 30,041 ms.
- PR #24 gate observations (`bf7b5cb` / `e6304496` lineage): 30,017.8 ms and
  30,033.4 ms.

The cause of the run-to-run variance is **not established**. Heavy concurrent
load was present on some runs (for example ~70 stray node processes from
other sessions were observed on the PC during one qualification run); that
is an observation, not a proven cause.

## Where the time goes (P1 derivative attribution — qualified)

- Per-save whole-basis guard passes account for **≈75% of the case**
  (16,628 ms of guard time inside a 22,099 ms solo run, per the admitted P1
  per-pass derivative, which times each pass sequentially: prepare 99
  passes, commit-preflight 33, commit-writer 66 — i.e. per save, preflight
  ×1 plus commit-writer ×2; the commit-writer's second pass is by design,
  revalidating after the temp-write window immediately before the
  replacement).
- The architecture performs **6n²+3n whole-basis validations per case =
  6,633 at n=33**: every whole-basis pass re-opens and re-hashes every basis
  file (a fresh-open/fresh-hash pattern throughout).
- **fsync is not in this chain** (the identity module only reads; fsync lives
  in the writer path).

### Withdrawn attribution (historical only — do not cite as evidence)

The P2 per-stage derivative's figures are **withdrawn** for timing
attribution: its seam used a single module-level depth counter shared across
concurrent (≤8-wide) flows and recorded only ~21% of true top-level
validations, so its per-stage sums and shares are invalid. Withdrawn with
it: the stage ranking (including any "largest attributed stage" phrasing),
the ≈7,227 per-case digest figure (a derived estimate from that seam run;
the count model above gives 6,633), and the ≈3.6 s summed-time projection
formerly attached to option B.

## Attempts recorded before this decision

- **Bound-16** (raise both metadata concurrency bounds 8 → 16): **REJECTED**
  on a Windows A/B — solo means 22.4 s (custody) vs 22.0 s (bound-16), within
  noise, and the full-suite run regressed two existing contract tests that pin
  bound 8 by name. Width is not the bottleneck.
- **Pass removal: DISPROVEN.** The commit-writer's second guard pass is not
  redundant; between the two passes the writer performs its temp write (a real
  external-change window), and the second pass is the only whole-basis check
  protecting the rename.
- **Option B** (remove the post-read `pathCheck` at custody :98 of
  `windows-path-identity.cjs`): the removed check is redundant **for the
  digest value** by the final-boundary argument (the returned digest is the
  pinned file's bytes, identity-verified at the post-close check). Option B
  is a **separate item**: it is Windows-qualified by the lead (497 pass /
  0 fail / 0 skip on both custody and candidate across the
  identity/digest/save set, plus real-NTFS controls), but its source
  acceptance remains subject to open review items (F1 transient-refusal
  qualification, F2/F3/F4) — **no equivalence clearance or source adoption
  is claimed here**. Option B is **not** the basis for this limit raise —
  the raise stands on the measured durations alone.

## The decision (D1)

Justin, 2026-10-18, verbatim: *"Raise only that test's limit, document the
timing evidence, and rerun the full suite. Don't merge anything."*

The limit for this case only rises from 30,000 ms to **60,000 ms**. At
decision time (2026-10-18) the rationale was: about 2.00× the worst
full-suite reading then on record (30,041 ms — since reclassified above as
an elapsed-at-deadline value) and about 2.29× the worst solo run
(26,172 ms): enough headroom for the observed variance, while still
bounding a genuine hang at one minute. After the lead's D1 validation, the
same limit is ≈1.8× the slowest completed observation (33,926 ms). No
other test, no global or config timeout, no assertion, and no product code
changes.

**Stated plainly:** this duration is real product latency — the time a user
waits for a fully-checked 33-file batch save — accepted by the owner. It is
not test overhead, and raising the limit hides nothing: every check the case
performs still runs, unchanged.

## Caveat

All figures above are Windows/NTFS on Justin's PC. Linux/headless timings of
the same case differ and are not evidence for or against this value.
