# Performance

What is measured, how to repeat it, the numbers before and after the spatial index and the audit
change, and what is still slow.

## How to measure

| Command | Where it runs | What it measures |
| --- | --- | --- |
| `npm test` (`tests/perf.test.ts`) | Node (vitest), every CI run | Extents, selection, pick, snap, DXF write / read on a 6,500-entity schematic, with budgets about 3x the development machine (`JCAD_PERF_FACTOR` scales them). |
| `npm run bench:node` (`tests/perf-dense.test.ts`, `JCAD_BENCH=1`) | Node, a separate CI step (alone, so it neither disturbs nor is disturbed by other tests) | A **dense drawing of 50,000 entities** (38,000 wires, 8,000 symbol inserts, 4,000 labels on a 200 x 150 sheet): spatial-index build and rebuild, pick, window / crossing / fence / polygon selection and object snap, each **with the index off (linear scan) and on**; and a **project of 20 drawings** (3,900 entities and 600 tagged components each, read from DXF text) running all twelve project-wide reports. Budgets: a frame (16 ms) for pick, snap and window / crossing selection. |
| `npm run build && npm run bench` (`scripts/bench.mjs`) | Headless Chromium on the built renderer; CI `ui` job (informational, `screenshots/bench/bench.json` in the artifact) | The same 50,000-entity drawing in the real editor: `loadState` + ZOOM E, a full redraw at extents and zoomed in (with a 1-pixel read-back so the canvas has finished drawing), hover (`Editor.onMouseMove`: rollover pick + overlay) and a window-selection drag (`onMouseDown / Move / Up`). |
| `tests/spatial-index.test.ts` | every `npm test` | Correctness: the index gives exactly the linear scan's results (same entities, order and tie-breaks) for pick, all selection modes and snapping, including stray far-away objects, construction lines, hidden and locked layers, and a redefined block. |
| `tests/spatial-index-random.test.ts` | every `npm test` | Property-style check on a randomized drawing of 2,000 mixed entities (lines, circles, arcs, text, polylines, inserts; hidden and locked layers): 200 random queries of every kind agree with the linear scan, and keep agreeing after replace, add, remove, undo, redo, a block redefinition and a layout switch. |

Timings below are from the development container (Linux x64, Node 22.22, shared CPU), best of
several runs unless noted; repeated runs varied by up to 2x because other work shared the
machine, so ranges are given. Shared CI runners are slower; compare runs on the same machine.

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

## DWG reading off the main thread

LibreDWG (WebAssembly) parses synchronously. It used to run in the Electron main process
itself, so while a large DWG was read the main process answered no IPC and handled no menu or
window event. It now runs in a worker thread (`scripts/dwg-worker.mjs`, managed by
`electron/dwg-host.cjs`):

- the main process stays responsive while a file is parsed;
- files of 1 MB or more (`JCAD_OPEN_PROGRESS_BYTES` overrides the threshold) show a progress
  dialog in the editor with the file name, size, elapsed time and a **Cancel** button
  (`src/ui/open-progress.ts`); Cancel terminates the worker and the open fails with
  "Open cancelled", leaving the current drawing untouched; the next DWG starts a fresh worker;
- if a worker cannot be started (an unusual packaging layout), the reader is imported in the
  main process as before (without Cancel);
- the end-to-end test covers the dialog, the progress events and Cancel; `--probe-dwg` checks the
  worker inside each packaged build.

LibreDWG reports no percentage, so the bar is indeterminate. Converting the parsed DWG into a
drawing (`convertDwg`) still runs in the renderer after the read; it was not measured separately.

## Known slow spots (follow-ups)

- **Full redraw of a dense drawing** (160-230 ms for 50,000 entities at extents) is the largest
  remaining cost: every entity is stroked as its own path. Batching consecutive entities of the
  same colour, linetype and width into one path, and caching a bitmap of the drawing while only
  the overlay changes (hover, crosshair), would cut both; both need the screenshot baselines
  re-approved because antialiasing at overlaps changes slightly.
- **Index build on a freshly opened 50,000-entity drawing** costs 340-590 ms the first time
  (mostly exploding the 8,000 inserts, which the first redraw needs anyway). Building it right
  after `loadState` (or in idle time) would move that out of the first mouse move.
- **Component and Missing Catalog reports** look up each component's rung reference and the
  drawing's unit scale by scanning every entity (`nearestReference`, `drawingUnitScale` in
  `src/electrical/`), O(components x entities) per sheet: about 1-3 s over the 20 dense
  benchmark sheets, negligible on ordinary schematics.
