# JCad 3D: hardening tests, fixtures, fuzzing and error handling

Status: **experimental**, milestone 6 (hardening, first half) of [3D-PLAN.md](3D-PLAN.md). This
file describes the tests added for performance, realistic models, hostile file input and error
handling of the 3D core, what they found, and the error-handling audit of `src/model3d` and
`src/io/dxf/mesh3d-*`. Performance numbers are in [PERFORMANCE.md](PERFORMANCE.md#3d); the security
review of the kernel worker and the file payload is in [SECURITY-REVIEW.md](SECURITY-REVIEW.md#experimental-3d-track).

## Test files and how to run them

| File | Runs in | What it checks |
| --- | --- | --- |
| `tests/perf-3d.test.ts` | `npm test` (light cases) and `npm run bench:3d` (`JCAD_BENCH=1`, heavy cases) | Budgets scaled by `JCAD_PERF_FACTOR`, like `tests/perf.test.ts`: tessellation at maximum detail, extrusion and revolution; with `JCAD_BENCH=1` also `meshIsClosed` / `weldVertices` / `meshVolume` on 500,000 triangles, CPU picking on a 2,000,000-triangle scene, a DXF round trip of 100 solids / 100,000 triangles, `prepareDrawingState` sealing of 2,000,000 triangles and a Manifold union of two 50,000-triangle spheres. |
| `tests/model3d-fixtures.test.ts` | `npm test` | The committed fixtures under `tests/fixtures/3d/` are exactly what the builders make, read back with the expected solids and volumes, and rewrite byte-identically. |
| `tests/fuzz-model3d-file.test.ts` | `npm test` | 2,000 mutations of polyface records and `JCAD_3D` payloads, 2,000 mutated payload texts, 2,000 mutated `Feature3D` trees through `evaluateFeature` (see [Fuzzing](#fuzzing)). |
| `tests/model3d-mesh-hash.test.ts` | `npm test` | The faster `weldVertices` and `meshIsClosed` give exactly the results of the previous implementations (kept in the test as references) on 400 random meshes. |
| `tests/model3d-errors.test.ts` | `npm test` | `describeModel3DError` (src/model3d/errors.ts) and regressions for the defects listed below. |
| `tests/model3d-wasm-memory.test.ts` | `npm test` | The shipped `manifold.wasm` memory declaration (16 MiB initial, 4 GiB maximum) that SECURITY-REVIEW E-20 relies on. |

- `npm run bench:3d` runs the heavy performance cases alone (about 30 s and 1-2 GB of memory);
  CI should run it as a separate step, like `npm run bench:node`. Budgets are for the development
  machine: on shared CI runners set `JCAD_PERF_FACTOR` (CI uses 2 for the browser benchmark; at
  most 10), which scales every budget in `tests/perf-3d.test.ts`, the light cases in `npm test`
  included.
- CPU cost of the fuzzers in `npm test`: about 8-9 s for the 2,000 file mutations and 6-9 s for the
  2,000 feature trees (single-threaded, in one worker while the other files run in parallel; the
  whole suite's wall time did not grow measurably on 24 threads, 30-38 s with or without them).
  `FUZZ_RUNS=10` (20,000 iterations each) takes about 3 minutes.
- `npm run make:3d-fixtures` (`scripts/make-3d-fixtures.mjs`) rewrites the fixtures from
  `tests/helpers/model3d-fixtures.ts` (it runs the fixture test with `JCAD_WRITE_3D_FIXTURES=1`).
  Review the diff before committing regenerated fixtures.
- Fuzz seeds are derived from the property name; a failure prints its seed. Replay one with
  `FUZZ_SEED=<seed> npx vitest run tests/fuzz-model3d-file.test.ts`, soak with `FUZZ_RUNS=<k>`
  (tests/helpers/fuzz.ts).

## Fixtures

Built deterministically with the in-process Manifold kernel through the same code a command uses
(primitive features, `profileFromEntities`, extrude, revolve and Boolean features evaluated by
`evaluateFeature`), with fixed solid ids, in millimetres. Registered in
`tests/fixtures/manifest.json`, so `npm run check:fixtures` requires them.
`tests/fixtures/3d/.gitattributes` marks them `-text`: the writer's CRLF bytes are kept, so the
byte-identical rewrite check holds on every checkout.

| File | Size | Content |
| --- | --- | --- |
| `enclosure.dxf` | 478 KB | 45 solids, 1,964 triangles: a 600 x 800 x 250 enclosure shell (outer box minus inner box, open front) with four mounting holes cut through the back wall by cylinder subtraction (a five-level Boolean history), a door panel, three 35 x 7.5 mm top-hat DIN rails extruded 500 mm from a sketched closed polyline, and 40 component blocks on an 8 x 5 grid, every fifth with a pilot light united on top. |
| `cable-tray.dxf` | 151 KB | A 300 x 100 U-channel tray run: a 1,000 mm straight extrusion, a 90 degree horizontal bend revolved about a vertical axis (64 segments per turn) and a 500 mm straight, united into one solid; plus the three pieces as separate solids. |
| `schematic-with-solids.dxf` | 589 KB | The demo motor-control ladder (`seedDemoDrawing`, src/app/demo.ts) as Save writes it, with the enclosure solids beside it. |

The tests check solid counts, ids, layers and history kinds; every mesh closed, outward and
already welded; volumes against analytic values (shell with holes and DIN rails to 1e-9 or better,
components with pilot lights to 1e-6, the bend against Pappus to 0.2 %, the union equal to the sum
of its touching pieces); no import-report items; `prepareDrawingState` accepts the drawing; and
`writeDxf(readDxf(file))` equals the file byte for byte. For the mixed fixture, the 2D entities,
blocks and header read back exactly as from the same drawing saved without solids, and writing it
without its solids gives exactly that drawing's DXF.

## Fuzzing

`tests/fuzz-model3d-file.test.ts`, fixed seeds, 2,000 iterations per property.

**DXF records.** The corpus is a drawing with six small solids of every feature kind (box on a
tilted frame with a Unicode name, cylinder, extrusion with a hole, revolve with a segment count,
nested Boolean, mesh). Each iteration applies one to three of: truncation (sometimes inside a value
line), swapped group codes, hostile numbers (`NaN`, `Infinity`, `-0`, `1e309`, `0x10`, empty,
Arabic digits ...), payload JSON mutation (below), XDATA damage (the `JCAD_3D` group twice, foreign
1001 / 1002 / 1040 groups inside it, 1000 strings of 255+ characters), face-index corruption (0,
negative, beyond the vertex count, 32768, fractional, an extra 74 group), polyface count changes,
deleted / duplicated / moved VERTEX records, random flags, Unicode and control characters in
layer names, handles and payload strings, and stripping the JCad data (a foreign polyface). The
file is read with `recover` and the 3D setting chosen at random. Properties:

- `readDxf` returns a drawing or throws `DxfReadError`; nothing else escapes.
- The drawing passes `prepareDrawingState` (sealed, within the geometry budget); every solid has a
  valid non-empty mesh, a unique valid id, a clean name of at most 255 characters, an ACI or
  ByLayer colour, a layer in the layer table and a history that passes `validateFeature`.
- Every `POLYLINE` record is accounted for exactly once: a solid, a 2D polyline or a `dropped`
  import-report item. Only a file opened with `recover` may lose its last, incomplete record, and
  then the report says the file was recovered.

**Payload text.** `decodeSolidPayload` on 2,000 mutated payloads never throws; an accepted
feature revalidates, an accepted id is valid. JSON-level mutations: hostile values (`null`, huge
and denormal numbers, 300-character Unicode strings, arrays for objects), deleted fields, unknown
fields (`constructor`, `prototype`, `parts`, `segments` ...), Boolean nesting up to 120 levels;
text-level injections: `NaN` / `Infinity` / `01` / `.5` numbers, `__proto__` and duplicate keys,
truncation, up to 5,000 leading brackets.

**Feature trees.** Random trees (up to two Boolean levels, every primitive, extrusions and
revolutions with holes, tilted frames) with one hostile change: `NaN`, `Infinity`, `-0`, `1e-320`,
`1e300` in any number, wrong types, deleted fields, extra or removed array elements, nesting of
20 to 80 levels, unknown kinds and operations, and profiles the sketch step would refuse
(self-intersecting, collinear, repeated points, 1e-300 and 1e300 sizes, 300-600 points). Each goes
through `evaluateFeature` with the in-process Manifold kernel. Property: the result is a valid,
closed, outward mesh within `MAX_SOLID_TRIANGLES`, or the rejection is a documented error
(`isModel3DUserError`: Model3DInputError, which FeatureEvalError extends, GeometryBudgetError,
KernelError). A plain RangeError, TypeError or Error escaping counts as a failure. A typical run:
829 meshes, 938 Model3DInputErrors, 176 FeatureEvalErrors, 57 KernelErrors. The reader property
accepts only DxfReadError.

## Defects found and fixed

| # | Found by | Defect | Fix |
| --- | --- | --- | --- |
| 1 | cable-tray fixture | A revolve history with a `segments` count (which REVOLVE stores, types.ts `RevolveFeature`) was rejected on reading as "unknown field", so every saved revolve lost its history and reopened as a plain mesh. The M5 round-trip test used a revolve without `segments`. | `file-format.ts` accepts an optional finite `segments` on revolve (clamped on evaluation, like the primitives). Regression: `tests/model3d-errors.test.ts`. |
| 2 | feature fuzzing | A primitive or extrusion whose size is below the precision of its position (a 0.5 radius sphere at z = -1e300) or whose volume overflows (a 1e200 box) produced a closed mesh of zero or infinite volume without an error, which then reached the caller (a command could store it). | `requireSolidMesh` (primitives.ts) after placement: non-finite coordinates, a volume that is zero up to rounding (|V| <= 1e-12 d^3, d the bounding-box diagonal) or an infinite volume throw Model3DInputError; a clearly negative volume is an internal Error. Used by `primitiveMesh`, `extrudeMesh`, `revolveMesh`. Partial precision loss that leaves a larger positive volume is not detected. |
| 3 | feature fuzzing | A valid profile revolved about an axis far away (1e300) collapsed to zero area in the revolution plane; the triangulator's plain `Error("Triangulation failed ...")` escaped `revolveMesh` / `evaluateFeature` as an undocumented error type. | `capTriangles` (sweep.ts) turns the triangulator's own "Triangulation failed / needs" Errors into Model3DInputError ("Cannot revolve: the profile cannot be triangulated (...)") and rethrows anything else. |
| 5 | review | Builders threw plain RangeError, so an engine RangeError (stack overflow, allocation) was classified as user input. | `Model3DInputError extends RangeError` (src/model3d/input-error.ts) thrown by primitives.ts and sweep.ts; `FeatureEvalError` extends it; only it counts as input in `describeModel3DError`. `meshIsClosed` also refuses indices beyond the vertex count again, as before the rewrite. |
| 6 | feature fuzzing, 10x soak | A stored profile with `frame: null` escaped `validateFrame` as a TypeError. | `validateFrame` reports "the profile frame is missing". |
| 7 | feature fuzzing, 10x soak | A profile vertex 1e-12 from the revolution axis next to a vertex on it became a second pole vertex at the same place: `revolveMesh` returned an open mesh. | Consecutive points that coincide after snapping to the axis are merged (a loop that collapses is refused), and `revolveMesh` refuses a result that is not closed (Model3DInputError). |
| 4 | perf-3d | `weldVertices` took 6-9 s on an unwelded 500,000-triangle soup (string keys in a Map); `meshIsClosed` 0.75 s on 500,000 triangles. Both run on every Boolean (operands and result) and on every foreign polyface read. | Typed-array hash tables: 0.3-0.5 s (0.09-0.13 s exact) and 0.11-0.12 s; identical results (`tests/model3d-mesh-hash.test.ts`). Union of two 50,000-triangle spheres: 0.55 s -> 0.28-0.37 s. |

No reader defect was found: in 2,000 mutated files nothing but DxfReadError escaped, no drawing
failed `prepareDrawingState`, and no record disappeared without a report item.

## Error handling audit

Every `throw` and `catch` under `src/model3d` and `src/io/dxf/mesh3d-*` (line numbers at the time
of this audit). "User" means the message is written for the command line or the import report.

### Errors that reach the user

| Where | Error | How it reaches the user |
| --- | --- | --- |
| `budget.ts:28-40` `validateModel3DBudget` | GeometryBudgetError (malformed model, solid or model over the triangle / vertex limits) | Through `prepareDrawingState` on every state: `Editor.geometryAction` logs "Edit canceled: ..." for commands; opening a file reports it like an oversized 2D file. |
| `sweep.ts:36` `checkBudget` | GeometryBudgetError | Same; raised before any sweep allocates. |
| `primitives.ts:45, 160, 195, 219, 225, 241` | Model3DInputError (input-error.ts, a RangeError): sizes, cone radii, torus radii, non-finite or collapsed placement, non-orthonormal frame | To the 3D command that called the builder (see the open point below). `primitives.ts:220, 226` (invalid or inside-out builder result) are plain Errors: internal. |
| `sweep.ts:54, 60, 70, 121-148, 164, 240` | Model3DInputError: profile invalid, not triangulable or collapsing onto the axis, distance, angle, axis, open revolution | Same. `sweep.ts:53` rethrows anything that is not the triangulator's own refusal: internal. |
| `sketch.ts` (all `SketchError` throws, caught at `:432` and `:469`) | Never thrown out: `profileFromEntities` returns `{ error }`, `validateProfile` returns the reason | The command shows the returned message. Other errors are rethrown: programming errors only. `validateFrame` returns a reason for a missing frame instead of throwing. |
| `feature-eval.ts` `checkTree` and `evaluate` | FeatureEvalError (a Model3DInputError): too many features, too deep, unknown kind, mesh feature, malformed Boolean | To the command that re-evaluates a history. |
| `kernel/kernel.ts:98-137`, `manifold-direct.ts:43-56`, `manifold-kernel.ts` (every rejection) | KernelError with `code` (`invalid-input`, `budget`, `empty-result`, `kernel-failure`, `timeout`, `worker-crash`, `unavailable`, `disposed`) | To the Boolean command. Manifold's own failures (`manifold-core.ts:116, 121, 130, 133`) are converted: ManifoldInputError -> `invalid-input` naming the operand, other errors -> `kernel-failure`; in the worker (`manifold.worker.ts:34`) they travel as `{ ok: false, error }` and become the same KernelErrors (`manifold-kernel.ts` `onMessage`). Worker start, crash and timeout paths reject with KernelErrors too. |
| `mesh3d-read.ts` (no throws) | Import-report items: `dropped` (unreadable numbers, bad face indices, non-polyface vertices, no faces, blocks / layouts), `simplified` (history ignored, foreign polyface, quads split, degenerate faces, colours, names, XDATA), `unsupported` (newer version) | Import report dialog. `file-format.ts:276` and `:317` catch only the validator's own FeatureError and JSON.parse's SyntaxError; `decodeSolidPayload` never throws (fuzzed). |
| `mesh3d-write.ts:30, 152, 154`, `file-format.ts:109` | Error / RangeError: invalid mesh, more than 1,000 polyface records, id too long | Not reachable from valid state (every producer validates); if it happens, Save catches it (`src/app/editor/save.ts` `describeFileError`), nothing is written, the drawing stays modified; autosave catches it as well. |

### Internal errors (programming errors, never expected)

| Where | Error | Why it cannot reach the user from valid input |
| --- | --- | --- |
| `model.ts:20, 61` | Error: empty solid, duplicate id | Producers never create empty meshes (builders and Booleans refuse them, the reader drops faceless records); the reader gives duplicate ids fresh ones. |
| `triangulate.ts:131-257` | Error: triangulation failed / needs | Only called by sweep.ts after `validateProfile`, through `capTriangles`, which turns these refusals into Model3DInputError (defect 3). |
| `file-format.ts:138` | FeatureError (private) | Caught by `validateFeature` (`:276`); anything else is rethrown (`:278`). |
| `manifold-kernel.ts:105, 118, 140, 186, 241`, `manifold-direct.ts:32` | (catch sites) | Turn synchronous failures (operand checks, `postMessage`, worker creation, `terminate`, module loading) into KernelErrors or an unavailable status. |

### Paths into `prepareDrawingState` and tools

- Nothing in the 3D core can make `prepareDrawingState` throw anything but GeometryBudgetError:
  meshes in the state are plain arrays (the kernel's typed arrays are unpacked by `unpackMesh`, the
  reader builds arrays), so `sealImmutableData` accepts them; the budget check guards malformed
  models with GeometryBudgetError. Fuzzed: 2,000 mutated files, every resulting drawing prepared.
- **Open point for the 3D commands (src/tools3d, src/app/experimental-3d.ts, not part of this
  change):** `Editor.geometryAction` reports only GeometryBudgetError and rethrows everything else,
  so a Model3DInputError, FeatureEvalError or KernelError thrown by a 3D command would reach the window's
  error handler instead of the command line. Commands should catch around builders, `evaluateFeature`
  and kernel calls with `describeModel3DError` (src/model3d/errors.ts), log `message`, and send
  `internal` errors to diagnostics. Today the only 3D command that builds geometry is 3DDEMO
  (`addDemo`), which can hit the new placement Model3DInputError (defect 2) only for a drawing far from
  the origin with a tiny extent (coordinates beyond about 1e16) or wider than about 1e103; it is a
  development aid.
