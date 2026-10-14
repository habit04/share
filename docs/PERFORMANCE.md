# Performance

What is measured, how to repeat it, the numbers before and after the spatial index and the audit
change, and what is still slow.

## How to measure

| Command | Where it runs | What it measures |
| --- | --- | --- |
| `npm test` (`tests/perf.test.ts`) | Node (vitest), every CI run | Extents, selection, pick, snap, DXF write / read on a 6,500-entity schematic, with budgets about 3x the development machine (`JCAD_PERF_FACTOR` scales them). |
| `npm run bench:node` (`tests/perf-dense.test.ts`, `JCAD_BENCH=1`) | Node, a separate CI step (alone, so it neither disturbs nor is disturbed by other tests) | A **dense drawing of 50,000 entities** (38,000 wires, 8,000 symbol inserts, 4,000 labels on a 200 x 150 sheet): spatial-index build and rebuild, pick, window / crossing / fence / polygon selection and object snap, each **with the index off (linear scan) and on**; and a **project of 20 drawings** (3,900 entities and 600 tagged components each, read from DXF text) running all twelve project-wide reports. Budgets: a frame (16 ms) for pick, snap and window / crossing selection. |
| `npm run build && npm run bench` (`scripts/bench.mjs`) | Headless Chromium on the built renderer; CI `ui` and release checks assert budgets with `JCAD_BENCH_ASSERT=1`; JSON in the artifact | The same 50,000-entity drawing in the real editor: first state acceptance, first extents/geometry construction and first render before idle warmup, then warmed load/ZOOM E, redraw, hover and selection. Cold render includes a 1-pixel read-back. These phases exclude file I/O and parsing. |
| `npm run bench:project` (`scripts/bench-project.mjs`) | Node, CI and release checks | Writes 20 synthetic DXF sheets to temporary files, reads them through the normal project path, measures disk reads separately from parsing/state preparation, and runs all twelve reports. JSON records workload, bytes and per-report timings. Newly written files can be in the OS cache; this does not measure a physical cold disk. |
| `npm test` / `npm run bench:3d` (`tests/perf-3d.test.ts`, heavy cases with `JCAD_BENCH=1`) | Node; the heavy cases alone, like `bench:node` | Experimental 3D core: tessellation, extrusion and revolution on every run; with `bench:3d` also mesh checks on 500,000 triangles, CPU picking on 2,000,000 triangles, a 100,000-triangle DXF round trip, state sealing of 2,000,000 triangles and a Manifold union. See [3D](#3d). |
| `tests/spatial-index.test.ts` | every `npm test` | Correctness: the index gives exactly the linear scan's results (same entities, order and tie-breaks) for pick, all selection modes and snapping, including stray far-away objects, construction lines, hidden and locked layers, and a redefined block. |
| `tests/spatial-index-random.test.ts` | every `npm test` | Property-style check on a randomized drawing of 2,000 mixed entities (lines, circles, arcs, text, polylines, inserts; hidden and locked layers): 200 random queries of every kind agree with the linear scan, and keep agreeing after replace, add, remove, undo, redo, a block redefinition and a layout switch. |

Historical timings below are from the development container (Linux x64, Node 22.22, shared CPU), best of
several runs unless noted; repeated runs varied by up to 2x because other work shared the
machine, so ranges are given. Shared CI runners are slower; compare runs on the same machine.

## Current performance gates and changes

Both the normal CI and release checks run the dense Node benchmark and the browser benchmark.
Browser budgets in `scripts/bench-budgets.mjs`, in milliseconds before `JCAD_PERF_FACTOR`, are:
load 500, full redraw at extents 400, full redraw zoomed in 100, cached-scene redraw 8, median
hover 8, median window selection 50. The full-redraw measurements discard the cached bitmap
before each draw; cached-scene redraw measures its reuse separately. The gate also rejects a
full-redraw result less than five times the cached result (with a 0.2 ms floor), so an accidentally
cached benchmark cannot pass as a full redraw. CI uses factor 2. Invalid measurements, a workload
other than 50,000 entities, or a selection
that selected nothing also fail. First-use budgets are separately enforced: state acceptance
2,000 ms, geometry construction 2,000 ms, first render 1,000 ms, and their complete first-view
path 3,000 ms. The project filesystem benchmark requires 20 files, 21 loaded documents (including
the active drawing), 12,000 component rows and consistent phase totals, with a 15,000 ms total
budget. Both sets scale by `JCAD_PERF_FACTOR`; missing or invalid measurements fail.

On 2026-10-11, the earlier benchmark on Windows x64 / Chromium 154 measured: load 16.2 ms,
cached renders 5.6 ms at extents and 5.8 ms zoomed, median hover 0.1 ms, median selection 5.0 ms
(1,693 entities). These renders reused the bitmap and do not measure the full redraw now checked
separately. These local measurements do not replace the Linux CI browser/font baseline.

After the edit-budget follow-up on the same date, Windows x64 / Chromium 154 measured first
state acceptance 96.7 ms, first geometry 69.5 ms, first render 356.2 ms and complete first view
522.7 ms. Warm load was 31.6 ms, cached renders 7.1 / 8.0 ms, hover 0.1 ms and selection 11.7 ms.
The filesystem project benchmark read 15,861,240 bytes in 54.2 ms, spent 756.2 ms parsing and
preparing states, and 2,553.4 ms on all reports: 3,363.7 ms total. All factor-1 budgets passed.
These are local measurements with the workload and cache conditions described above.

The eight dense Node checks include editing: the slowest measured single edit on 50,000 entities
was 16.2 ms, and a settings-only change across 30 undo states took 0.3 ms. Immutable, already
validated geometry can reuse budget calculations; new entities or block definitions are checked
before acceptance. Rejected candidates leave the existing document/history intact.

The viewport now caches the static drawing and redraws the cursor and overlay separately. The
editor defers spatial-index warmup by 50 ms, then builds the index synchronously; that delay is
not a limit on how long the build can take. Component/report lookups
cache the ladder/reference index and net rail data per immutable drawing state. Cache invalidation
and block dependency tests cover edits, undo/redo, redefinition and layout switches.

## Hit testing and selection on 50,000 entities (Node)

| Operation | Linear scan (before) | Spatial index (after) |
| --- | --- | --- |
| Pick at a point (hover rollover, click) | 15 - 40 ms | 0.006 - 0.016 ms |
| Object snap search near the cursor | 11 - 18 ms | 0.01 - 0.02 ms |
| Window selection, small window (about 1/100 of the sheet) | 9 - 17 ms | 0.2 - 0.3 ms |
| Crossing selection, same window | 7.6 - 9.4 ms | 0.5 ms |
| Window around the whole drawing | 9 - 51 ms | 6.5 - 39 ms (index bypassed; cached bounds) |
| Fence selection (3 points across the sheet) | 88 - 194 ms | 22 - 102 ms |
| Window / crossing polygon | 26 - 151 ms | 4.5 - 113 ms |
| Index build, first time (cold geometry caches) | - | 340 - 590 ms |
| Index rebuild after an edit (warm caches, JIT-compiled) | - | 21 - 70 ms |

**Decision.** The linear pick took 15-40 ms on the dense drawing, above the 16 ms frame budget,
and it runs on every mouse move (rollover highlight) and every object snap while drawing. So the
editor now has a spatial index (`src/core/spatial-index.ts`):

- a uniform grid (about two entities per cell, at most 1024 x 1024 cells) over the middle 98 % of
  the entity centres, so a few stray objects far away do not squeeze the drawing into a handful
  of cells; anything outside lands in the clamped edge cells, which keeps the lookup exact;
- entities covering more than 64 cells (title-block frames, construction lines) and entities
  without finite bounds are checked on every query;
- built per entities array and cached by its identity: drawings are immutable, so an index is
  never updated, only rebuilt for the next array; an array queried once uses the linear scan
  (no build for a one-off query), the second query builds the index; arrays under 2,000
  entities always use the linear scan;
- inserts' bounds depend on block definitions: the index remembers the definition object each
  referenced block resolved to and rebuilds when one changes;
- `pickEntity`, `selectByBox`, `selectByFence`, `selectByPolygon` (`src/core/selection.ts`) and
  `findObjectSnap` (`src/core/snap.ts`) take candidates from it and apply exactly the same tests
  in the same order as before.

Fence and polygon selection spend most of their time in the exact segment tests, which the index
does not change; they are one-off commands, not per-frame work.

## In the editor (headless Chromium, 50,000 entities)

| Operation | Before | After |
| --- | --- | --- |
| Hover: `onMouseMove` (rollover pick + overlay), median of 60 moves | 4.4 - 7.0 ms | 0.1 ms |
| Window-selection drag selecting 1,693 objects, median of 11 | 24 - 31 ms | 14 - 17 ms (the rest is updating the selection, palettes and grips) |
| `loadState` + ZOOM E | 45 - 114 ms | unchanged |
| Full redraw at extents | 160 - 232 ms | unchanged |
| Redraw zoomed in 4x (off-screen entities culled) | 26 - 40 ms | unchanged |

Chromium 141, headless with software rasterisation; a desktop GPU draws faster.

## Large project: 20 drawings, all project-wide reports (Node)

| Step | Before | After |
| --- | --- | --- |
| Read 20 DXF sheets (`projectDocuments`) | 1.2 - 2.6 s | unchanged |
| Electrical Audit over 20 sheets | about 140 s (4.5 - 7 s per sheet) | 2.2 - 5.9 s |
| All 12 reports together | 147 s | 4.8 - 10.3 s |

The audit asked, for every wire end, how many wires meet there by scanning every entity, and
recomputed the outline of every symbol for every loose wire end. It now buckets the wires once in
the same spatial index (`wireDegreeCounter` in `src/electrical/wires.ts`, identical results to
`wireDegree`), computes symbol outlines once, keeps the horizontal wires in a list, and sorts the
issues with collators created once. The output is unchanged (compared issue by issue on the
benchmark sheets; `tests/spatial-index.test.ts` checks the wire counts).

## DWG reading in an isolated process

LibreDWG (WebAssembly) parses synchronously. It used to run in the Electron main process
itself, so while a large DWG was read the main process answered no IPC and handled no menu or
window event. Desktop reads now use a fresh Electron utility process containing a worker thread
(`scripts/dwg-worker.mjs`, managed by `electron/dwg-host.cjs`):

- the main process stays responsive while a file is parsed;
- files of 1 MB or more (`JCAD_OPEN_PROGRESS_BYTES` overrides the threshold) show a progress
  dialog in the editor with the file name, size, elapsed time and a **Cancel** button
  (`src/ui/open-progress.ts`); Cancel terminates the isolated reader and the open fails with
  "Open cancelled", leaving the current drawing untouched; the next DWG starts a fresh process;
- a reader startup failure fails the open; there is no main-process parser fallback. The previous
  process must exit before another starts, including after successful reads;
- at most four reads are accepted at once, with 128 MiB reserved across active and queued input.
  Queued reads cannot multiply the parser's WASM instances. Input and output travel in acknowledged
  1 MiB frames, with a 64 MiB serialized-result limit before the parent accepts a result;
- both desktop and browser readers refuse inputs over 128 MiB. The browser terminates parsing
  after 60 s. Desktop parsing allows 60 s plus one second per input MiB, up to 188 s for accepted
  files, with a separate 15 s startup deadline. The desktop process's inner worker limits V8
  old/young generations to 512/64 MiB and the stack to 8 MiB. A checked WASM declaration gives the
  shipped reader an engine-enforced 2 GiB linear-memory maximum, including initial allocation
  and direct WASM growth. The parent confirms valid OS measurements before parsing and polls
  every 100 ms, aborting at a sampled 3 GiB process memory threshold. Polling includes resident,
  peak resident and, on Windows, private committed memory, rather than V8 heap alone. It cannot
  prevent brief overshoot between samples and is not a strict OS allocation cap. Browser workers
  retain their existing policy without explicit heap or WASM limits;
- the end-to-end test covers the dialog, the progress events and Cancel. The unpackaged
  `check:dwg-containment` gate forces native-pressure and worker-heap failures on the actual OS.
  Separately, the installed build's fixed `--probe-dwg` sequence reads a real fixture, cancels
  a pending read, rejects malformed input and reopens matching drawing data through the shipping
  utility/import/fuse configuration. It does not force allocation exhaustion in that binary.
  [DWG memory containment](DWG-MEMORY-CONTAINMENT.md) records this evidence boundary.

LibreDWG reports no percentage, so the bar is indeterminate. Converting the parsed DWG into a
drawing (`convertDwg`) still runs in the renderer after the read; it was not measured separately.

## 3D

Experimental 3D core (docs/3D-PLAN.md milestone 6), measured on 2026-10-12 on the development
machine: Windows 11 x64, Intel Core i7-12850HX (16 cores / 24 threads), 32 GB, Node 22.23.3; the
GPU is an Intel UHD 770-class integrated GPU, which none of these Node measurements use (no frame
times yet: the viewport frame-time phase of `scripts/bench.mjs` is still to come). Best of 2-5
runs per measurement, four runs of the file; ranges are the spread between runs. Budgets
(`tests/perf-3d.test.ts`, milliseconds before `JCAD_PERF_FACTOR`) are about 3x the slowest run,
with a 50 ms floor. "Every run" cases run in `npm test`, the others with `npm run bench:3d`
(`JCAD_BENCH=1`, alone).

| Operation | Measured | Budget | Runs |
| --- | --- | --- | --- |
| Tessellate all six primitives at 256 segments x 128 rings (132,628 triangles) | 5.6 - 6.1 ms (12.7 ms with the suite running in parallel) | 50 | every run |
| Extrude a 200-vertex profile with 10 holes of 16 vertices (1,476 triangles) | 1.2 - 1.9 ms (5.2 ms in the suite) | 50 | every run |
| Revolve a 100-vertex profile at 256 segments (51,200 triangles; since the review including a `meshIsClosed` check) | 19 - 30 ms with the check (8.8 - 13.8 ms before it; 21 - 41 ms with the suite in parallel) | 250 | every run |
| `meshIsClosed`, 499,712 triangles | 111 - 124 ms (754 ms before the change below) | 400 | bench:3d |
| `weldVertices` (tolerance 1e-9) of an unwelded soup of 499,712 triangles / 1.5 M vertices | 306 - 508 ms (6.1 - 9.1 s before) | 1,500 | bench:3d |
| `weldVertices` exact (tolerance 0), same soup | 85 - 130 ms | 400 | bench:3d |
| `meshVolume`, 499,712 triangles | 30 - 67 ms | 250 | bench:3d |
| BVH build for CPU picking, 32 solids / 1,998,848 triangles (first pick) | 4.3 - 6.8 s | 21,000 | bench:3d |
| `pickSolids`, one ray against that scene (200 random rays, BVHs built) | 0.010 - 0.022 ms | 0.25 per ray | bench:3d |
| `writeDxf`, 100 solids / 100,000 triangles (21.3 MB of DXF) | 398 - 573 ms | 1,800 | bench:3d |
| `readDxf` of that file | 917 - 1,399 ms | 4,500 | bench:3d |
| `prepareDrawingState` sealing a 2,000,000-triangle model | 954 - 1,774 ms | 5,500 | bench:3d |
| Manifold union of two 50,000-triangle spheres, in-process, including operand and result checks (77,938 triangles out) | 280 - 373 ms (552 ms before) | 1,700 | bench:3d |

Also measured (not budgeted): a Manifold union of two 499,712-triangle operands in-process takes
3.5 s and the process grows to about 820 MB resident; the result (776,948 triangles) is then
refused by the per-solid budget. The worker kernel adds transfer and the main-thread checks.

What these numbers mean:

- **Weld and closedness.** `weldVertices` and `meshIsClosed` used string-keyed Maps and a Set of
  numeric edge keys. Both run on every Boolean (operands and result, on the calling thread) and
  for every foreign polyface read. They now use typed-array hash tables with the same results
  (`tests/model3d-mesh-hash.test.ts`): 12-20x and 6x faster.
- **Sealing cost (open concern).** `prepareDrawingState` deep-freezes every array of the state,
  visiting each number of the meshes: 0.95-1.8 s for 2,000,000 triangles (about 0.5-0.9 us per
  triangle). It runs once per new mesh object (sealed objects are skipped later, so edits that
  keep other solids are cheap), but an open, an undo of a large Boolean or a whole-model
  transform pays it in full on the UI thread. The sealer is in `src/core/immutable-data.ts`;
  freezing a numeric array without visiting its elements would remove almost all of it.
- **BVH build (open concern).** The CPU picking BVH is built lazily on the first pick of each
  mesh with a comparator sort per node (`src/render3d/picking.ts`): an estimated 1-2 s for one
  500,000-triangle solid, 4.3-6.8 s measured for a 2,000,000-triangle scene, on the UI thread at the first
  hover. Picking itself is negligible afterwards (0.01-0.02 ms per ray). A partition-based build
  (nth-element on typed arrays) or building in idle time would fix it.
- **DXF size.** Polyface records cost about 213 bytes per triangle, so the reader's limits
  (2,000,000 group pairs, 250,000 records) cap a file at roughly 100,000 triangles; the
  100,000-triangle file above is 21.3 MB and within them.

## Historical slow spots and remaining follow-ups

- **Cold redraw of a dense drawing** still strokes entity geometry. Static bitmap reuse now
  removes that cost from ordinary cursor movement; path batching remains a possible follow-up.
- **First geometry preparation** still costs work, especially for nested inserts. Idle spatial
  warmup moves index work away from the first mouse move; cold geometry remains worth measuring.
- **Project-wide reports** still read every project drawing. Ladder/reference and unit lookups
  now use cached indexes; project I/O and parsing remain separate from those lookup timings.
