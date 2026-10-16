# Bounds evidence — capped qpdf artifact (milestone 12.4, phase 1)

Artifact under test: `electron/restricted-pdf/assets/qpdf.wasm`, SHA-256
`d481345b3906b748a33b8ef05c0ab7e89004b3f2ca8e81066db00a69ae516db6`,
2,178,902 bytes; JS glue SHA-256
`ff3dcd969243b9a2fd9d6ef5aa850009e40659b32b34c0f2325877952bb07924`.
Declared WASM memory (scripts/inspect-wasm-memory.mjs, static parse, no
instantiation): initial 16 MiB (256 pages), **maximum 805,306,368 bytes
(12,288 pages = 768 MiB)**. The spike's uncapped prototype declared
2,147,483,648 bytes (32,768 pages) — do not ship it.

Method: one fresh Node process per job (spike harness
`spike-12.4/measurements/run-one.mjs`), the production argv (R6, /P = −1324
semantics, `--stream-data=preserve`), host Node v24.20.0 on the Linux
sandbox (2 CPU / ~8 GiB). Raw JSON receipts: `runs/*.capped.json`.

## Stream-dominated inputs (spike fixtures)

| input | output | wall | WASM linear | peak RSS |
| --- | --- | --- | --- | --- |
| 257,955 B | 258,897 B | 0.47 s | 16,777,216 B (floor) | 88,879,104 B |
| 4,112,649 B | 4,113,588 B | 1.04 s | 20,185,088 B | 119,308,288 B |
| 16,447,671 B | 16,448,615 B | 1.59 s | 71,237,632 B | 208,527,360 B |
| 65,787,731 B | 65,788,679 B | 3.38 s | 283,181,056 B | 594,358,272 B |
| 125,829,120 B (120 MiB) | +948 B | 12.9 s | 549,322,752 B | 1,073,311,744 B |

Linear memory tracks ≈ max(16 MiB floor, ~4.5× input), as in the
uncapped spike; the 120 MiB job fits under the 768 MiB cap with ~219 MiB
headroom. Output growth on stream inputs is a flat ≈ +0.95 KB.

## Object-rich adversarial inputs (gen_adversarial.py, proper xref tables)

| input | objects | output | wall | WASM linear | peak RSS |
| --- | --- | --- | --- | --- | --- |
| 6,828,052 B | 50,000 | ~same order | 1.4 s | 30,932,992 B | — |
| 27,578,062 B | 200,000 | ~same order | 6.0 s | 81,450,752 B | — |
| 69,278,062 B | 500,000 | 106,278,806 B | 38.1 s | 640,548,864 B | 999,936,000 B |

Two budget consequences, both implemented in the job host:

1. **Output growth is not flat for object-rich inputs** — 500k objects grew
   the file 1.53× (rewritten page-tree arrays). The pre-readback MEMFS
   output limit is therefore `2 × input + 1 MiB`, checked with `FS.stat`
   BEFORE `FS.readFile` allocates the output copy; exceeding it fails the
   job closed. JCad's own writer output is stream-dominated with modest
   object counts, but the budget does not rely on that.
2. **Per-object linear cost is steep and superlinear at allocator growth
   steps** (~1.9 KB/object between 200k and 500k objects). An input near
   the 128 MiB ceiling packed with minimal objects could exceed the
   768 MiB cap; the engine then aborts and the job fails closed (no
   output). That is the cap working as designed, not a defect: the
   alternative (uncapped) measured a 1.04 GB peak RSS on a 120 MiB job.

## Hostile structure cases

- **Forged xref stream** (`fixtures-adversarial/xref-bomb.pdf`, 214 B):
  an xref stream claiming `/Size 20000000` with three real entries. The
  engine refuses it itself — qpdf exit code 2, no output, no memory event.
- **Deeply nested dictionary** (`nested-10000.pdf`, 10,000 levels):
  processed normally (output 178,511 B, 0.3 s, linear at the floor).
- **Xref-less input** (no `startxref`): qpdf throws an uncaught C++
  exception that crosses the JS glue as a **raw number**, not an
  ExitStatus object and not an Error. pypdf also rejects such files
  ("startxref not found") and the JCad writer always emits `startxref`,
  but the worker contract is: ANY throw from module load or `callMain` —
  Error, number, or otherwise — fails the job closed.

## Corrected memory model (supersedes the spike's framing; accounting corrected in the review round)

The 768 MiB cap bounds ONLY the WASM linear memory inside the child. It
does not bound JS-side copies, so the host reserves memory in STAGES
against one aggregate budget before work exists, and refunds every
reservation when its job settles (success, refusal, cancellation and
disposal alike — the host tests prove the refunds):

- queued stage: the input bytes, held while the job waits;
- activation converts that into the job's full envelope: the IPC transfer
  copy (input), the MEMFS input capacity (input plus one allocator
  doubling of headroom), the engine workspace (the declared 768 MiB
  maximum), the MEMFS output capacity (the output size cap of
  2× input + 1 MiB, plus one allocator doubling) and the readback copy
  (the output size cap).

The default host runs ONE active transform, and its default aggregate
budget is exactly one maximum-size job's envelope: a second job may queue
(its input staged under the queue's own byte cap) but cannot ACTIVATE
until the first job's refunds land. A job whose envelope does not fit the
remaining budget WAITS; it is not started on a hope. (Running several
engines at once would need a separately admitted aggregate budget; none
is invented here.)

Inside the child, output growth is stopped BEFORE the allocation that
would exceed the MEMFS budget: `memfs-guard.cjs` wraps the glue's MEMFS
storage paths with a shared retained-capacity budget. An audit of the
exact pinned glue found THREE storage paths, not two:
`MEMFS.expandFileStorage`, `MEMFS.resizeFileStorage`, and
`MEMFS.stream_ops.write` — whose canOwn subarray adoption and
empty-file-at-position-zero `buffer.slice` fast paths allocate/adopt
storage without ever expanding (the initial `/in.pdf` write and the
first output write take those paths). Accounting follows actual
outcomes: each file's charge is re-derived from the storage it retains
after every operation (an adopted view retains its whole backing
buffer), so a no-op resize — the pinned method returns early when
`usedBytes` already equals the target, leaving larger capacity in
place — makes no accounting change and cannot mint credit, and a
delegated operation that throws reconciles to the storage that actually
remains. The delivered design instead stat-checked the output size only
after `callMain` had already populated MEMFS; that check remains, but
only as a pre-readback backstop.

Round-3 corrections close the two seams that remained in that bound.
First, dispatch: the pinned `createNode` snapshots
`MEMFS.stream_ops.write` into `MEMFS.ops_table.file.stream.write` when
the first node is created — the factory's static init, before the guard
installs — and file nodes dispatch through the cached entry, so the
guard also repoints every live `ops_table` alias of the original write
to the guarded wrapper (and fails closed if one cannot be repointed).
Second, forecast: the empty-file slice's retained storage is calculated
without constructing a slice. The pinned glue uses intrinsic signed and
unsigned 8-bit views, whose slices copy exactly the requested length;
a native Node `Buffer` slice retains its whole backing buffer. The guard
checks the captured prototypes, methods and species before forecasting
those cases and refuses unknown or customized inputs without calling
their methods. A write exceeding the budget is refused BEFORE either a
buffer copy or node mutation. This correction also avoids making a second,
discarded copy on a successful write. The forecast and accounting bound
retained byte storage; they do not claim to bound every small JavaScript
allocation or total process memory.

Total accounting, without shorthand: the accounted host reservations
can reach ONE maximum-size stage envelope (1,923 MiB at the 128 MiB
input ceiling: transfer copy + MEMFS input capacity + the 768 MiB
engine workspace + MEMFS output capacity + readback copy) PLUS up to
128 MiB of separately capped queued input staging. The 768 MiB figure
is only the WASM linear-memory declaration inside that envelope — not a
process cap, and not a bound on runtime/transport copies the accounting
does not claim to cover.

The job host also enforces: input ≤ 128 MiB (the pipeline ceiling, never
raised), at most 4 queued jobs with ≤ 128 MiB of queued input bytes in
total, a 120 s per-job deadline with kill + exit-join before the slot is
reused, success decided by the child's actual exit outcome (validated
output + natural exit 0; output followed by a non-zero exit fails), and —
if a terminated child does not exit within the termination grace — an
explicit unavailable/quarantined state instead of a hang or a reused
unconfirmed slot. Entering quarantine also settles the queue in the
same moment (round-2 correction): every queued transform rejects with
the unavailable error and refunds its input staging without waiting for
a caller abort or disposal — a queued job has no timer of its own, so
before this correction it hung, reservation held, until an unrelated
dispose happened by. The unconfirmed active child's reservation stays
held until its late exit refunds it exactly once, and the quarantined
host never silently reopens.
