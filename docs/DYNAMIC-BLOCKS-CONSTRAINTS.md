# Dynamic blocks and 2D constraints (priority 30)

Status: 30.0 audit and specification. This document records what exists at the
base, the supported subset planned for milestones 30.1–30.4, and what is
explicitly not claimed. Nothing in milestones 30.1–30.3 is a claim of native
AutoCAD dynamic-block or constraint compatibility; native acceptance is
Codex's Windows/AutoCAD gate (§5, §7).

## 1. Base and audit verdict

Base, verified live on 2026-10-15 with `git ls-remote` (not assumed):

- Repository `habit04/share`, package `jcad-electrical` 0.5.2, default branch
  `claude/autocad-program-feasibility-53w7j7`.
- Upstream base: `a68dba5b16ed4099d8decae32f936ebc023129fa`.
- Local working-tree base: synthetic commit
  `db9afb5c40b41dd19ddd650bb7039f59fdcb1010`, byte-identical content to the
  upstream base, on branch `muse/p30-dynamic-blocks-constraints`.
  Every delivery states both SHAs.

Verdict at base:

- Checklist item 30 (`docs/REMAINING-2D-CHECKLIST.md`): "Missing dynamic-block
  actions/parameters and constraints; static INSERT representation exists."
  Prerequisite listed: the #29 reference graph.
- `docs/SUPPORT-MATRIX.md`, INSERT row: mirrored and non-uniform scales,
  MINSERT and shared attributes round-trip, but "Dynamic-block parameters are
  not modeled." The unsupported list includes parametric constraints and
  dynamic-block actions.
- Priorities #19/#29 are completed externally (PR #9, released in v0.4.9) and
  integrated at this base: bounded metadata/object-reference preservation
  (the cad-graph). Priority 30 reuses that graph and its codecs; it does not
  redo reader/writer repairs.
- In code at base: `InsertEntity` (`src/core/entities.ts`) has no dynamic
  property values, visibility state or evaluated-variant link; `BlockDef` has
  no parameter/action graph; nothing in `src/` or `tests/` references a native
  block action/parameter object type, `ACAD_ENHANCEDBLOCK`, or an
  evaluation-graph DTO; no dynamic-block fixture exists in
  `tests/fixtures/interchange` (block fixtures are only
  `r2000-nested-blocks-xref.dxf` and `r2018-minsert.dxf`/`.dwg`).
- `Drawing` state is an immutable whole-state snapshot and one
  `Drawing.transact` is exactly one undo step, atomic on failure
  (`src/core/document.ts`). Parameter and constraint edits are built on that
  (§4, §6), so "one accepted edit = one undo operation" holds by construction.

## 2. Preservation boundaries

### 2.1 Proven at base — DXF path

The cad-graph already retains a native dynamic-block definition as opaque
data. This is retention of unmodeled records, not modeling.

- On DXF import, every section is split generically and OBJECTS records that
  carry a group-5 handle become graph nodes (`src/io/cad-graph-dxf.ts`).
  An extension dictionary is not a named root-dictionary entry, so it and the
  parameter/action objects under it are raw-anchored nodes; references inside
  an `{ACAD_XDICTIONARY …}` block get role `extension`, and ownership
  (`isOwner`/`owned()` in `src/core/cad-graph.ts`) treats the BLOCK_RECORD's
  extension dictionary and its whole owned subtree as one unit.
- On DXF save, unmatched raw/dictionary OBJECTS nodes are re-emitted with
  their source groups verbatim except handle/reference remapping, and a
  matched BLOCK_RECORD record has its full `{ACAD_XDICTIONARY …}` block
  selected into the output. XRECORD values, binary blobs and ordinary strings
  are opaque end-to-end.
- Retention survives edits: a same-ID edit elsewhere or inside the block
  leaves the graph untouched (test: `tests/cad-graph.test.ts`, "keeps
  identity and metadata for same-ID edits"); retention through edit + save +
  re-read is proven for dictionary/XRECORD data by
  `tests/cad-graph-dxf.test.ts` ("retains native dictionary defaults, hard
  ownership and unknown groups after editing and COPYCLIP"; "saves exact
  integers/binary and connected references after a geometry edit") and
  `tests/cad-graph-edits.test.ts` (extension-owned data cloned on copy).
- Retention is fail-closed. A retained hard reference whose target was not
  captured at import makes save throw `CadGraphError` instead of emitting a
  dangling pointer; deleting an entity that a surviving node hard-references
  refuses the edit atomically.
- Boundaries of retention: the definition subtree is dropped only together
  with its block (block deleted or renamed); an OBJECTS record without a
  group-5 handle is dropped at import, never captured; one unresolved *soft*
  reference is written as `0` (a pointer value, not the node itself).

### 2.2 Proven at base — DWG path is weaker

- The DWG reader's own import report states it "may omit application XDATA
  (…), extension dictionaries, fields and dynamic parameters; these cannot be
  guaranteed on DXF save" (`src/io/dwg.ts`). Whether a DWG-imported dynamic
  definition ever reaches the graph is unproven and must be assumed no until
  a native DWG fixture shows otherwise.
- Anonymous `*U…` blocks "hold dynamic-block and array geometry"
  (`src/io/dwg.ts`); they are renamed `ANON_U…` and displayed as static
  inserts. A DWG dynamic instance therefore arrives, at best, as a static
  INSERT of its evaluated anonymous geometry, with no parameter state.
- Whether the portable DWG writer preserves any JCad XDATA carrier in a
  `.dwg` is unverified. No DWG round-trip is claimed for JCad-specific data.

### 2.3 Not proven

- No end-to-end test with a real BLOCK_RECORD extension dictionary exists;
  §2.1 is proven by the code path plus analogous dictionary/extension tests.
- Real dynamic-definition graphs may use shapes the generic path has not met:
  reference cycles between parameter/action objects, objects referenced only
  by arbitrary codes 320–329, objects without a group-5 handle (§2.1).
- Retention is not validity: a byte-exact retained subtree has not been shown
  to still function as a dynamic block when AutoCAD opens a file whose block
  geometry JCad regenerated. That is the §5 fixture + Codex acceptance gate.
- Block-rename dropping the definition with the block follows from name-keyed
  anchor presence in the graph code; no test renames a block that carries an
  extension dictionary.

## 3. Supported subset by milestone

General rules for every milestone: definitions are immutable; an instance edit
never mutates a definition; failure or refusal is atomic (the document is
unchanged, not restored — same state object, revision and dirty flag); block
base points, action selections, attribute relationships and per-instance state
are preserved; supported work is labeled authored/normalized-model unless a
native path is separately proven (§5).

### 3.1 Milestone 30.1 — linear parameter + bounded stretch (vertical slice)

- One parameter kind: linear distance (`basePoint`, unit `direction`,
  `defaultValue`, grips), with exactly one constraint mode per parameter:
  `unbounded`, `range`, `increment`, or `list`. Values are checked, never
  clamped, snapped or repaired: an out-of-range, off-increment or
  not-in-list edit is refused with a specific code.
- One action kind: stretch, with an axis-aligned rectangle frame in
  definition space, an explicit entity selection (`frame` or listed movable
  points), a distance multiplier and an angle offset. Delta is
  `(effectiveValue − defaultValue) × multiplier` along the direction.
  Entities fully inside the frame move whole; crossed entities move only
  their inside points.
- Movable points per type (definition space): line endpoints; polyline
  vertices (bulge values carried unchanged, pinned by a test); circle/arc
  center; ellipse center; text/mtext anchor; point position; nested insert
  position; dimension defining points; leader vertices; spline control
  points. Attribute definitions may be selected so a stretch moves an
  attribute's placement; attribute values and tags are never touched by
  evaluation.
- End-to-end behavior: two independent instances of one definition; nested
  transforms (rotation, non-uniform scale, mirror) composed by the existing
  expansion path *after* evaluation; parameter edits through one `transact`;
  undo/redo; dirty/revision by ordinary `Drawing` semantics; save/reopen
  through the DXF adapter (§4).
- Non-goals in 30.1: polygon stretch frames; non-axis-aligned frames; arc
  endpoint stretching and ellipse axis-tip stretching (center whole-move
  only — a frame contact that can only touch an arc endpoint or ellipse tip
  is reported as an unsupported contact, never silently ignored); stretch
  sets containing a width-framed polyline (frame-desync risk) or a fit-point
  spline whose rebuild fails; circle radius change via stretch (that is a
  dimensional edit, not a stretch); per-cell parameters on a MINSERT (all
  cells share the insert's values, as they share attributes today).

### 3.2 Milestone 30.2 — further actions

In small deliveries, reusing the existing whole-entity transform stack
(`translateEntity`, `rotateEntity`, `scaleEntityBy`, `mirrorEntityAcross` in
`src/core/entities.ts` — exact for all entity types):

- Move, rotate, uniform scale, flip (a flip of a nested insert toggles its
  mirror flag; no expansion or geometry rewrite), visibility states, lookup
  tables.
- Scale with independent X/Y factors only for the exact subset (line,
  straight polyline, ellipse, spline, insert, point, xline, ray, image,
  table). It is refused for sets containing a circle, arc, ordinate dimension
  or text, where the only existing transform is lossy (sampled polylines,
  decomposed dimensions, approximated text) or throws.
- Then, where the audited format permits: alignment, arrays, and
  coupled/chained actions (an action whose frame moves another parameter's
  grip couples the two parameters). Dependency order is derived and
  deterministic (topological, authoring order as tie-break).

### 3.3 Milestone 30.3 — bounded 2D constraint engine

Pure modules (§4), delivered in slices: (1) model, validation, DOF accounting
and direct construction for `fixed`, `coincident` (point↔point),
`horizontal`, `vertical`, `concentric`, `equal` radius, `radius`/`diameter`;
(2) `parallel`, `perpendicular`, `distance` (aligned/horizontal/vertical,
including point-on-object coincidence) and `angle`, with the bounded numeric
relaxation stage; (3) `equal` length, full `concentric`, `tangent`
(line–circle and circle–circle), full `radius`/`diameter` interaction;
(4) hardening: reference constraints end-to-end, redundancy reporting,
determinism and work-limit stress tests.

- Constrainable entities in 30.3: line, circle, arc, polyline, point.
  Constraints on ellipse, spline, xline, ray, text/mtext, insert, hatch,
  leader, image, dimension or table entities are refused at validation.
  Polyline bulges are carried as data, never variables, and the
  `bulge-carried` diagnostic is reported when a solve moves a bulged vertex.
- Driving values move geometry; reference (measured) dimensional constraints
  never drive, consume no DOF, and can never fail a solve. Geometric
  constraints are always driving. Suppressed constraints are stored,
  reported, and excluded from solving and DOF accounting.
- Status is reported from evidence (residuals + Jacobian rank), never from
  constraint counts alone: `fully-constrained`, `underconstrained` (a
  successful, consistent solve), `conflicting` (stationary point with
  residuals above the conflict tolerance; the reported set is every
  constraint unsatisfied at the best point found — no minimal-conflict-set
  claim), or `unsolved` (work/iteration limit, singularity, cancellation —
  "we do not know", never relabeled `conflicting`). Redundant constraints
  are a per-constraint diagnostic, not a failure.
- Fixed constants, defined once in the solver and not user settings:
  normalized residual tolerance 1e-9, step tolerance 1e-10, conflict
  tolerance 1e-6, caps of 512 variables and 1024 active driving constraints
  per solve, 50 relaxation iterations, 200 000 work units per solve.
  Residuals are normalized by a per-component characteristic scale, so the
  same tolerances apply at coordinates of 1e-4 and 1e8. Limits are enforced
  by a work counter, not a timer, so results are reproducible. Cancellation
  is polled at defined points; a cancelled solve returns no partial result.
- Non-goals in 30.3: expressions/formulas and named parameters driving
  values; symmetry, collinear, smooth, point-on-midpoint and arc-length
  constraints; solving across scopes or components; automatic constraint
  inference; native AutoCAD constraint import/export (§4).

### 3.4 Milestone 30.4 — integration and native paths

- Document/command/grip integration: a parameter-edit command beside
  BLOCK/INSERT in `src/app/commands-drafting.ts`; a Parameters section in the
  Properties palette insert case (the 3D "Parameters" rows in the same file
  are the precedent); dynamic grips appended after grip index 0 (the insert
  position grip) so existing grip behavior is unchanged, with drag preview
  through the existing ghost mechanism; `LIST` prints parameter values.
- Persistence of document-scope constraint sets as a versioned
  `JCAD_CONSTRAINTS` payload, labeled JCad-specific like `JCAD_DYNAMIC`.
- Supported native import–edit–save–reopen paths, gated on the §5 fixture and
  Codex's AutoCAD acceptance: native definitions stay retained/protected
  (§2); a parameter edit on a natively imported dynamic block does not need
  graph surgery merely to protect its definition nodes. Writing back a
  *modified native evaluation graph* is not promised anywhere in priority 30
  until fixture Q11 (§5) proves AutoCAD re-evaluates third-party output.
- `docs/SUPPORT-MATRIX.md` and checklist item 30 are updated at milestone
  close, in the §4 wording. The checklist gate ("Native actions/parameters/
  constraints retained, safe supported edits, explicit unsupported cases")
  bars closing item 30 on a JCad-only slice.

### 3.5 Refusal policy (all milestones)

- A definition containing any parameter or action this build does not model
  — a future kind, or one decoded from a native graph not yet understood —
  is **retained as opaque data and refused evaluation as a whole**. Known
  actions are never evaluated around an ignored one: a partially evaluated
  block presented as evaluated is a false result. The block displays its
  authored base (default-state) geometry, the import report carries a
  `simplified` entry, and parameter edits on that block are refused while
  the opaque member is present.
- The same rule applies whole-definition: a `JCAD_DYNAMIC` payload with a
  version newer than the model, or malformed JSON, is retained raw verbatim,
  reported, displayed statically, and never half-parsed into the model.
- Explicitly rejected, with specific codes (never approximated): malformed
  definitions (duplicate ids, unknown parameter/entity references,
  invalid direction/constraint/frame/multiplier), malformed instance values
  (unknown parameter, wrong value kind, non-finite, out of range, not in
  list, off increment, block mismatch), action dependency cycles including
  self-dependence (refusal lists the cycle's action ids, sorted), and
  constraint validation failures (missing reference, unsupported entity,
  invalid anchor/arity/value/role, duplicate, self-reference).
- Unsupported native graphs are treated as retained/protected data with
  clear edit/save limits. Priority 30 never silently flattens a dynamic
  block, explodes it, drops its constraints, or invents a successful native
  export.

## 4. Data model

New pure modules under `src/core/parametric/` (no I/O, no editor imports;
existing geometry helpers reused — no second geometry system, no affine
matrix type):

- `definitions.ts` — `DynamicBlockDefinition { version, parameters, actions }`,
  immutable, plain data. 30.1 kinds: `LinearDistanceParameter`,
  `StretchAction`; unknown kinds are `OpaqueParameter`/`OpaqueAction`
  carrying their source kind and a verbatim payload (§3.5).
- `instance.ts` — validation (`validateDefinition`, `validateInstanceValues`)
  reporting all issues with stable codes; validation never clamps, snaps or
  repairs.
- `evaluate.ts` — `evaluateDynamicBlock(definition, baseEntities,
  baseAttributes, instance, limits)`: total and deterministic; returns a
  complete result (evaluated entities in **definition space**, moved
  attribute definitions, applied action ids in dependency order, diagnostics)
  or a refusal with a stable code. Inputs may be sealed immutable data; a
  refusal discards the working copy, so atomicity is by construction.
  Bounded before work is spent: at most 256 actions, chain depth 32,
  100 000 work units, 10 000 output entities; one shared tolerance
  (`1e-9`, aligned with `geometry.ts` EPS). A parameter at its default
  yields delta 0 and returns base entities by identity.
- `constraints.ts` / `solve.ts` (30.3) — the `ConstraintSet`/`Constraint`
  model (anchors, kinds, driving/reference role, DOF accounting) and the
  bounded solver of §3.3 behind the single signature
  `solveConstraints(entities, set, options)`.

Placement (the alternatives — a document-level side map keyed by insert id,
or definitions/values on `BlockDef` only — were rejected: a side map loses
values on copy and cannot address inserts inside block definitions or
layouts; a per-block slot couples all instances of a block):

- Definition on `BlockDef`: a new optional field `dynamic`. One per block,
  shared by every insert, travels in the `blocks` record of every state
  snapshot. A sibling optional field `dynamicRetained` holds an unreadable
  payload verbatim (§3.5).
- Instance values on `InsertEntity`: a new optional field `dynamic` holding
  `DynamicInstanceState { block, values }` — sparse (parameter id → tagged
  value; absent = default), next to the existing per-insert precedent fields
  (`attributes`, `attributePlacements`, MINSERT fields). Absent = ordinary
  static insert; every existing code path is unaffected. Copying an insert
  copies its values, as with attributes; deleting it deletes them.
- Evaluation at expansion level, in core: `src/core/entities.ts` expansion
  (`explodeInsert` cached / `expandInsert` uncached and budgeted) is the
  funnel for canvas, raster and vector-PDF plotting, bounds, picking,
  selection, EXPLODE, electrical pin logic and PDF font discovery, so
  evaluated geometry reaches all of them with no consumer changes.
  Evaluation is not done at render level (picking, EXPLODE and electrical
  logic would disagree with the drawing, and state would have nothing to
  save) and evaluated geometry is never materialized into stored state
  (definitions are shared by name; materialization would duplicate them and
  break instance independence). One cache rule is load-bearing: the
  expansion cache is keyed by insert object identity, so an edit must always
  produce a new `InsertEntity` — guaranteed by whole-state immutability —
  and evaluated output (which may be type-changed primitives) is never fed
  back as a definition. Evaluators must also respect the existing expansion
  limits (2 000 000 objects, 100 000 work per expansion, 1 000 000 drawing
  work, nesting depth 8, 100 000 MINSERT cells) and treat a truncated or
  cyclic expansion report as a failure for that instance, not as success.
- Document-scope constraint sets (30.3) live in a new optional
  `DrawingState.constraints?` field, following the `model3d` precedent
  (kept apart, travels with undo history, absent for ordinary drawings).
  Block-scope sets reuse the same `ConstraintSet` type in 30.4.
- `src/core/document.ts` and `src/io/dwg.ts` are not changed by 30.1–30.3.

Serialization (DXF adapter, in `src/io/`): a new XDATA application
`JCAD_DYNAMIC` in `src/io/dxf/codes.ts`, following the `JCAD_TABLE` /
`JCAD_MTEXT_COLUMNS` house pattern. Payload is one versioned JSON object
(`{"v":1,"kind":"definition",…}` on the BLOCK_RECORD;
`{"v":1,"kind":"instance",…}` on the INSERT) in 250-character group-1000
chunks with 7-bit escaping; the APPID is registered only when used; the app
is on the quiet-XDATA list; a payload failing validation is retained raw.
Placement on the INSERT is after the MINSERT groups and before the
ATTRIB/SEQEND sequence — the only position that attaches to the INSERT.
**`JCAD_DYNAMIC` is JCad-specific data, labeled as such in the import
report** (action `simplified`): "dynamic-block parameter values are kept in
JCAD_DYNAMIC on JCad export; native dynamic-block parameters and actions are
not modeled, and other CAD programs show the static block". It is not native
dynamic-block export, and no save guard is needed: other programs open the
file and show the authored default-state geometry. A drawing with no dynamic
data produces output byte-identical to the pre-30.1 writer (regression
assertion in §7).

## 5. Native fixture request (for Codex)

No native dynamic-block fixture exists (§1). The following fixture — the
same pattern as the existing interchange `.md`-documented fixtures — is
requested from Codex. All files AutoCAD-authored in installed AutoCAD on
Windows (no third-party writers), the drawing otherwise empty (no xrefs, no
fonts beyond Standard, no other dynamic blocks), so every OBJECTS record is
attributable to this one block:

- One block, e.g. `P30_LINEAR_STRETCH`: a closed rectangle (LWPOLYLINE), one
  LINE fully inside the stretch frame, one attribute definition (tag `TAG1`),
  and one nested static INSERT if cheap.
- One linear parameter (`Distance1`) across the rectangle's width, default
  value recorded, with a value set (list or increment + min/max), grip
  placement recorded.
- One stretch action on that parameter whose frame *crosses* the rectangle's
  right edge (crossed geometry stretches) and *fully encloses* the inner
  LINE (enclosed geometry moves), so both sub-behaviors show in one edit.
- Three instances in model space: A at definition defaults; B with
  `Distance1` set to a recorded non-default in-range value via the
  Properties palette; C with the *same* value as B, rotated (e.g. 30°) and
  mirrored or non-uniformly scaled if AutoCAD allows it on a dynamic
  reference (record what was actually applied).
- Exports of the same drawing as DWG and as ASCII DXF (DXFOUT, newest format
  the installed AutoCAD writes; also saved down to the oldest format JCad
  claims, if time permits).
- A manifest from AutoCAD itself: per instance, the values shown by
  `GetDynamicBlockProperties` / the Properties palette (name, value,
  read-only flag), its `EffectiveName`, its INSERT block name, and the AUDIT
  result (0 errors) before and after a save/reopen cycle.
- Committed with a same-stem `.md` provenance note (generator + environment,
  privacy statement, content inventory, scope limits, validation performed)
  and a `.expected.json` of independently measured evaluated geometry;
  every file registered in `tests/fixtures/manifest.json`.

Questions only this fixture can answer (fixture-only; nothing here is to be
guessed from documentation — the public DXF Reference documents none of the
dynamic-block objects, and all group-code knowledge is reverse-engineered):

1. The graph object's exact DXF name and subclass stack in this AutoCAD
   version's DXFOUT, and whether the `ACAD_ENHANCEDBLOCK` dictionary entry
   uses group 350 or 360.
2. The complete group-code layout of `BLOCKLINEARPARAMETER` and
   `BLOCKSTRETCHACTION` as this version writes them: the stretch action's
   selection-set encoding, frame polygon encoding, distance
   multiplier/offset fields, and the parameter's value-set encoding.
3. Evaluation-graph node/edge encoding: how nodes reference element objects,
   what the `AcDbEvalExpr` node/parent id fields mean, node ordering, and
   whether actions and grips are graph nodes on equal footing with
   parameters.
4. Whether the anonymous `*U` record carries `AcDbBlockRepBTag` XDATA (root
   handle), `AcDbDynamicBlockTrueName` XDATA (root name), both, or neither,
   and their exact group sequences.
5. Whether a non-default instance's INSERT or `*U` record carries any
   additional per-instance data (extension dictionary, XDATA, reactors)
   beyond the evaluated geometry. (External research found no per-instance
   value record on the INSERT in any source; the instance state appears to
   be embodied in the `*U` record's evaluated geometry.)
6. How the numeric value of `Distance1` for instance B is recoverable from
   the file at all: measured from the `*U` geometry, or from a copied
   parameter graph inside the `*U` record. This decides whether JCad reads
   native instance values or must infer them.
7. Whether instances B and C (equal values) share one `*U` record, and what
   happens to a shared record when only one of them is later edited.
8. Whether the default instance A points at the named record and stays there
   after save/reopen, and whether an `AcDbDynamicBlockPurgePreventer` object
   is present and what references it.
9. How attribute definitions/values appear in the `*U` record vs the
   definition (constant vs non-constant handling under evaluation).
10. Format-version sensitivity: whether oldest-format exports preserve the
    full graph, downgrade it, or drop to static `*U` geometry.
11. Round-trip acceptance: after a third-party writer re-emits the file,
    does AutoCAD open it with AUDIT 0 errors, still show the dynamic grips,
    and re-evaluate correctly when `Distance1` changes again? Only AutoCAD
    answers this; it is Codex's acceptance gate, not a Linux test.
12. For 30.3: the same pattern with one BCPARAMETER constraint parameter —
    which `BLOCK…CONSTRAINTPARAMETER` objects appear, and whether they
    share the evaluation graph or a separate structure. (Native constraint
    parameters are a different family from dynamic parameters and are not
    conflated with them anywhere in this plan.)

Until this fixture exists, all 30.1+ test evidence is authored
normalized-model evidence and is labeled as such in every delivery; native
import/edit/save assertions stay `it.todo`/unsupported in the interchange
test style, never silent passes.

## 6. Dependency decision

**No new dependency for milestones 30.1–30.3.** The dynamic-block evaluator
and the 2D constraint solver are hand-rolled, pure, in-repo TypeScript.
No solver library, geometry library, WASM component or native addon is
adopted, and none is added merely to bypass this decision.

A solver library is reconsidered only on measured failure of the
hand-rolled engine, specifically any one of:

- Corpus failure: a defined realistic corpus (at least 50 systems from
  actual schematic/block geometry with analytically known or
  AutoCAD-verified expected results) on which the engine reports `unsolved`
  or a wrong `conflicting` for more than 5% of in-subset systems.
- Scale failure: a real drawing (not a stress test) whose in-scope
  constraint system exceeds the §3.3 caps and cannot be decomposed, with
  the drawing preserved as evidence.
- Coupling failure: a 30.2/30.4 feature whose correct behavior provably
  requires simultaneous-solution structure this engine lacks, demonstrated
  by a failing acceptance case.
- Fidelity divergence: Codex's AutoCAD comparison showing this engine's
  result outside tolerance of AutoCAD's on in-subset input, reproducibly.

Adoption then requires a written decision record, reviewed and accepted by
Codex (through Justin) **before** any dependency is added, stating: exact
name and version and the artifact (npm package / vendored source / WASM
build) with hash and provenance (registry signature, source repository +
commit, reproducible-build story — "latest" is not a version); the license,
verified from the artifact itself, and its compatibility with this package's
GPL-3.0-only license and the `THIRD-PARTY-NOTICES.md` practice; shipped size
in bytes, measured on the actual build, against a budget agreed in the
record; Windows suitability demonstrated (native addon ABI/signing/rebuild
cost, or WASM memory caps — engine-internal limits are not assumed, and the
§3.3 input caps stay load-bearing regardless); how the library's limits are
set from the §3.3 constants and a total mapping of its outcomes onto the
§3.3 statuses and failure codes (its vocabulary never leaks into the app,
and its failure still leaves the document unchanged — the swap is behind
the one `solveConstraints` signature); determinism evidence under fixed
input ordering; and the exit plan for removing it again, with confirmation
that the stored data model is engine-independent (it is, by design).

## 7. Acceptance examples and evidence rules

Acceptance cases are written before implementation, as concrete
Given/When/Then examples. Summary (full case lists live with each
milestone's tests):

- 30.1 (16 cases): basic stretch with exact endpoints; default value
  reproduces the authored geometry by identity; two independent instances
  (shared definition object unchanged); out-of-range edit refused
  atomically; list and increment constraints refused, never snapped;
  malformed stored values (wrong type, unknown parameter id) displayed
  statically, reported, retained raw; action cycle refused with the sorted
  cycle; chained actions applied in dependency order regardless of
  authoring order; nested rotated/mirrored instance composed through
  `insertTransform`; attributes preserved through a stretch (value
  unchanged, placement moved only when its point is in the frame); one
  parameter edit = one undo step (undo restores the exact pre-edit state
  object); save/reopen round-trip with the `JCAD_DYNAMIC` payload present
  on both records and a byte-identical output regression for static
  drawings; opaque action retained byte-identical with evaluation and edits
  refused; work-limit refusal atomic; degenerate definitions refused with
  specific codes, never repaired; evaluation under sealed immutable inputs
  is deterministic and non-mutating. Tests land as new files
  (`tests/parametric-definitions.test.ts`,
  `tests/parametric-evaluate.test.ts`,
  `tests/parametric-dynamic-block.test.ts`) in the existing factory style;
  the document-level cases assert unchanged-document by snapshot identity
  (`expect(doc.snapshot).toBe(before)`), the established pattern.
- 30.3 (18 cases): fully constrained rectangle (one undo restores it);
  underconstrained DOF reporting from rank, not counts; coincident
  propagation; conflicting triangle and parallel∧perpendicular reported as
  `conflicting` with documents unchanged; a consistent coincident cycle and
  its open chain producing bit-identical results across runs; large (1e8)
  and small (1e-4) coordinate cases at the same normalized tolerances;
  per-kind degenerate handling; cancellation before and during a solve;
  work-limit refusal reported `unsolved`, never `conflicting`; a reference
  distance that measures but never drives; concentric + equal + driving
  radius reaching fully constrained; tangent line–circle and
  circle–circle; a cad-graph transaction refusal surfaced distinctly from
  every solver failure code; missing-reference validation blocking the
  whole set; driving angle; diameter ≡ 2 × radius bit-identically.

Evidence rules for every delivery:

- Record the exact candidate SHA and base SHAs (§1), the exact commands,
  exit codes, and pass/fail/skip counts, with raw logs retained (targeted
  tests, the block/document/DXF neighbour set, `typecheck:all`, `lint`,
  `check:fixtures`, full `npm test`, `build`).
- A failure may be called pre-existing only if the same suite, run on a
  pristine checkout of the pinned base under comparable load, reproduces
  it. Counts are measured on the delivery machine; checklist numbers from
  older combination heads are never quoted as the base count. A diagnostic
  or instrumented pass is evidence about cause, not suite clearance; the
  normal uninstrumented run is the gate.
- No limit, timeout, worker count or tolerance is raised or loosened to
  make a run pass — including the §3.3 solver constants, which may only
  change by a revision of this document.
- Implemented, tested, Windows-validated and merged are reported as
  separate states. Linux/headless tests prove the authored normalized
  model only; they do not prove Windows application behavior, native DWG
  behavior, or AutoCAD acceptance, and no delivery claims otherwise.
  Windows application/IPC tests, installed-AutoCAD reference checks,
  combined regression testing, integration and release decisions are
  Codex's.
