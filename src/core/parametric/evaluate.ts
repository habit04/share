/**
 * Priority 30.1/30.2 — bounded, deterministic evaluator for dynamic-block definitions.
 *
 * Pure: no I/O, no editor/tool imports (core layering — the editor's STRETCH tool
 * lives in src/tools and must not be imported from here). Evaluation either
 * returns a complete result or a refusal with a stable code; it never returns
 * partially-transformed geometry, never clamps/snaps/drops a modeled action, and
 * never mutates its inputs (they may be sealed with sealImmutableData).
 * Results are in DEFINITION space; composing with insert transforms/expansion
 * is the caller's job.
 *
 * 30.2 whole-entity actions (move/rotate/scale/flip) reuse the core transform
 * stack from core/entities (translateEntity / rotateEntity / scaleEntityBy /
 * mirrorEntityAcross — exact for every entity type) instead of duplicating
 * per-type transform logic here. Import note: core/entities value-imports
 * evaluateDynamicBlock from this module, so the two modules are mutually
 * dependent; every binding crossed in either direction is a hoisted function
 * declaration and neither module invokes the other's bindings while its own
 * module body evaluates, which keeps the cycle safe.
 *
 * 30.2b: the pipeline follows design-visibility-lookup-array.md §1.4 — the
 * lookup override pass (step 3) derives `finalEffective` from the validated
 * `effective` values before any geometry, and everything downstream (grip
 * positions, action deltas, the visibility filter) reads `finalEffective`
 * only.
 *
 * 30.2c: the array action (design §3) is the first action kind that changes
 * the LENGTH of the working entity list. Working-list bookkeeping below
 * (baseSlot / sourceIds) keeps two invariants while it does: actions after
 * an array still resolve their selections against base ids and see copy 0
 * only, and the visibility filter drops array products by their SOURCE id
 * (provenance tracked internally, never parsed back out of derived ids).
 */
import { EPS, add, dot, normalize, rotate, scale as scalePoint, sub, type Point } from '../geometry';
import { transformedTextAnchors } from '../text-placement';
import {
  mirrorEntityAcross,
  rotateEntity,
  scaleEntityBy,
  translateEntity,
  type AttributeDef,
  type Entity,
} from '../entities';
import {
  validateDefinition,
  type AngleParameter,
  type ArrayAction,
  type DefinitionIssue,
  type DynamicBlockDefinition,
  type FlipAction,
  type FlipParameter,
  type LinearDistanceParameter,
  type LookupParameter,
  type MoveAction,
  type RotateAction,
  type ScaleAction,
  type StretchAction,
  type VisibilityParameter,
} from './definitions';
import {
  parameterValuesEqual,
  validateInstanceValues,
  type DynamicParameterValue,
  type DynamicInstanceState,
  type InstanceIssue,
} from './instance';

/** Absolute tolerance (drawing units) for frame inclusion, increment/list
 *  membership and zero-delta detection. Fixed for the model version; making it a
 *  per-drawing setting would let reader, editor and evaluator disagree. */
export const EVALUATION_TOLERANCE = EPS;

export interface EvaluationLimits {
  /** Max actions applied in one evaluation. */
  readonly maxActions: number;
  /** Max chained-action depth (longest dependency path). */
  readonly maxChainDepth: number;
  /** Work budget, charged 1 per entity examined + 1 per movable point tested. */
  readonly maxWork: number;
  /** Max entities in the result (base + any produced). Binds at
   *  baseEntities.length for the non-producing actions; an array action
   *  (30.2c) pre-checks its production against it BEFORE creating any copy
   *  (design §3.5). */
  readonly maxOutputEntities: number;
}

export const MAX_EVALUATION_ACTIONS = 256;
export const MAX_EVALUATION_CHAIN_DEPTH = 32;
export const MAX_EVALUATION_WORK = 100_000;
export const MAX_EVALUATION_OUTPUT_ENTITIES = 10_000;

export const DEFAULT_EVALUATION_LIMITS: EvaluationLimits = {
  maxActions: MAX_EVALUATION_ACTIONS,
  maxChainDepth: MAX_EVALUATION_CHAIN_DEPTH,
  maxWork: MAX_EVALUATION_WORK,
  maxOutputEntities: MAX_EVALUATION_OUTPUT_ENTITIES,
};

export type EvaluationResult =
  | {
      readonly ok: true;
      /** Evaluated entities in DEFINITION space. Entities no action touched are
       *  returned by identity (same object) — with one stated exception: when
       *  the definition has a visibility parameter, the post-pass filter
       *  (§1.4 step 8) DROPS the entities/attributes the effective state hides,
       *  so "all parameters at defaults ⇒ base lists returned whole" holds iff
       *  the default state's visible set covers every entity and attribute
       *  definition. What the filter keeps, it keeps by identity. */
      readonly entities: readonly Entity[];
      /** Attribute definitions whose placement point moved; untouched ones are
       *  returned by identity (subject to the same visibility filter as
       *  `entities`). Attribute VALUES live on the insert and are never
       *  an evaluation output. */
      readonly attributes: readonly AttributeDef[];
      /** Action ids in the order they were applied (topological). */
      readonly appliedActions: readonly string[];
      readonly diagnostics: readonly EvaluationDiagnostic[];
      /** The composed transform this evaluation ACTUALLY applied to each
       *  attribute definition it moved, keyed by tag (round 4, R3-01).
       *  Recorded from the action pipeline itself — never inferred from
       *  authored/effective snapshots, which cannot distinguish a flip
       *  whose axis fixes every anchor from the identity. An attribute
       *  no action transformed has no entry. Consumers that re-express
       *  per-instance placements against the evaluated definition (core
       *  expansion, the DXF writer and reader) compose with this record
       *  and its exact inverse. */
      readonly attributeTransforms: ReadonlyMap<string, AttributeActionTransform>;
      /** Declared (always undefined) so union access typechecks under
       *  tsconfig.scripts.json, which compiles with strictNullChecks off and
       *  therefore does not narrow this union by the `ok` discriminant
       *  (review finding R01). */
      readonly refusal?: undefined;
    }
  | {
      readonly ok: false;
      readonly refusal: EvaluationRefusal;
      /** Mirror of the ok variant's field, for the same union-access
       *  reason documented there (review finding R01). */
      readonly attributeTransforms?: undefined;
    };

export interface EvaluationRefusal {
  readonly code: EvaluationRefusalCode;
  readonly message: string;
  readonly parameterId?: string;
  readonly actionId?: string;
  /** For 'action-cycle': the unorderable action ids, sorted ascending so the
   *  refusal is byte-for-byte deterministic. */
  readonly cycle?: readonly string[];
  /** For 'invalid-definition': the structural issues that caused the refusal. */
  readonly definitionIssues?: readonly DefinitionIssue[];
  /** For 'invalid-instance': the instance issues that caused the refusal. */
  readonly instanceIssues?: readonly InstanceIssue[];
}

export type EvaluationRefusalCode =
  | 'invalid-definition'
  | 'invalid-instance'
  | 'unsupported-action' // an OpaqueAction is present
  | 'unsupported-parameter' // an OpaqueParameter is present
  | 'action-cycle' // chained actions depend on each other cyclically
  | 'chain-depth-exceeded' // dependency path longer than limits.maxChainDepth
  | 'work-limit-exceeded' // limits.maxWork / maxActions / maxOutputEntities hit
  | 'degenerate-transform' // a computed transform is degenerate (scale factor <= 0 / non-finite), or derived output geometry overflowed to non-finite values
  | 'unsupported-selection' // an array action selects an attribute definition, which cannot be arrayed (design §3.4)
  | 'unstretchable-entity'; // selection names an entity type with no movable points

export interface EvaluationDiagnostic {
  readonly severity: 'info' | 'warning';
  readonly code: 'value-defaulted' | 'frame-missed-selection' | 'zero-delta' | 'action-no-op' | 'lookup-applied';
  readonly message: string;
  readonly parameterId?: string;
  readonly actionId?: string;
}

// ---------------------------------------------------------------------------
// Movable points (design §3.3). Indices are the per-type point order below.
// ---------------------------------------------------------------------------

type Target =
  | { readonly kind: 'entity'; readonly index: number; readonly entity: Entity }
  | { readonly kind: 'attribute'; readonly index: number; readonly attribute: AttributeDef };

/** Movable points for a target, or null when its type has no movable points
 *  (selecting it is an 'unstretchable-entity' refusal). */
function movablePoints(target: Target): readonly Point[] | null {
  if (target.kind === 'attribute') return [target.attribute.position];
  const e = target.entity;
  switch (e.type) {
    case 'line':
      return [e.a, e.b];
    case 'polyline':
      // A widthFrame polyline renders from its affine display frame, which is not
      // in definition coordinates; stretching its points would desync the frame.
      return e.widthFrame ? null : e.points;
    case 'point':
    case 'text':
    case 'mtext':
    case 'insert':
      return [e.position];
    case 'circle':
    case 'arc':
    case 'ellipse':
      return [e.center];
    default:
      return null;
  }
}

/**
 * Points that are NOT movable but whose presence inside a frame is a stretch
 * contact the supported semantics cannot honor (geometry audit R6): an arc whose
 * endpoint is in the frame while its center is out, or an ellipse axis tip in the
 * frame while its center is out. Silently leaving such an entity unchanged would
 * fake a successful stretch, so these contacts refuse instead.
 */
function contactPoints(target: Target): readonly Point[] {
  if (target.kind !== 'entity') return [];
  const e = target.entity;
  if (e.type === 'arc') {
    return [
      add(e.center, { x: e.radius * Math.cos(e.startAngle), y: e.radius * Math.sin(e.startAngle) }),
      add(e.center, { x: e.radius * Math.cos(e.endAngle), y: e.radius * Math.sin(e.endAngle) }),
    ];
  }
  if (e.type === 'ellipse') {
    const major = e.majorAxis;
    const minorLen = Math.hypot(major.x, major.y) * e.ratio;
    const perp = Math.hypot(major.x, major.y) > EPS ? { x: -major.y, y: major.x } : { x: 0, y: 0 };
    const unitPerp = Math.hypot(perp.x, perp.y) > EPS ? scalePoint(perp, 1 / Math.hypot(perp.x, perp.y)) : perp;
    const minor = scalePoint(unitPerp, minorLen);
    return [add(e.center, major), add(e.center, scalePoint(major, -1)), add(e.center, minor), add(e.center, scalePoint(minor, -1))];
  }
  return [];
}

/** Return a copy of the target's entity with the given movable points replaced,
 *  or the same entity when no point actually changes object/value. Attribute
 *  targets are handled by the caller (different result list). */
function withMovedPoints(entity: Entity, moves: ReadonlyMap<number, Point>): Entity {
  if (moves.size === 0) return entity;
  switch (entity.type) {
    case 'line':
      return { ...entity, a: moves.get(0) ?? entity.a, b: moves.get(1) ?? entity.b };
    case 'polyline':
      // Keep-bulge rule: bulges/widths are carried over unchanged; a moved
      // vertex's segment bulge is not recomputed (same rule as existing
      // vertex edits — tan(θ/4) is scale-free, the arc re-derives from the
      // new chord with the same included angle).
      return { ...entity, points: entity.points.map((p, i) => moves.get(i) ?? p) };
    case 'point':
    case 'text':
    case 'mtext':
    case 'insert':
      return { ...entity, position: moves.get(0) ?? entity.position };
    case 'circle':
    case 'arc':
    case 'ellipse':
      return { ...entity, center: moves.get(0) ?? entity.center };
    default:
      return entity;
  }
}

/**
 * Transform an attribute definition's FULL text placement under a point
 * transform — the same treatment the core gives a text entity
 * (similarityTransform / mirrorEntityAcross move EVERY anchor — position,
 * alignmentPoint, firstAlignmentPoint — and scale also scales the height;
 * rotation also advances the text rotation). Evaluation historically
 * moved only AttributeDef.position, leaving the other anchors at their
 * authored values, so the evaluated definition was internally
 * incoherent: for right/center/fit justifications the text anchor IS
 * the alignment point, and expansion, the DXF writer, and the reader's
 * placement rebase then told different stories about where the text
 * sits (review round 2, C05). Transforming every anchor by the same
 * function of state makes the evaluated placement a coherent placement
 * that all consumers read identically.
 */
function transformAttributePlacement(
  attribute: AttributeDef,
  tf: (p: Point) => Point,
  rotationDelta = 0,
  heightScale = 1,
): AttributeDef {
  const moved = transformedTextAnchors(attribute, tf);
  return {
    ...moved,
    ...(heightScale !== 1 ? { height: attribute.height * heightScale } : {}),
    ...(rotationDelta !== 0 ? { rotation: (attribute.rotation ?? 0) + rotationDelta } : {}),
  };
}

const inFrame = (p: Point, frame: StretchAction['frame']): boolean =>
  p.x >= frame.min.x - EVALUATION_TOLERANCE &&
  p.x <= frame.max.x + EVALUATION_TOLERANCE &&
  p.y >= frame.min.y - EVALUATION_TOLERANCE &&
  p.y <= frame.max.y + EVALUATION_TOLERANCE;

/** Depth bound for the derived-output finiteness walk (step 7.5).
 *  Entities and attribute definitions in this data model nest at most
 *  about five container levels — entity → array → element → point →
 *  scalar, or insert → dynamic state → values record → value object →
 *  scalar — so 32 leaves generous headroom over every model-conformant
 *  structure while keeping the walk's shape model-bounded: a structure
 *  nested deeper than the model admits is treated as unbounded work
 *  (the walk reports 'over-budget'), never walked without limit. */
export const MAX_FINITE_WALK_DEPTH = 32;

/** Per-node work weight of the derived-output finiteness walk
 *  (step 7.5), charged through the evaluation's existing work budget.
 *  A node is charged exactly once, when it is SCHEDULED: the root by
 *  the walk itself, every other node by its parent's fan-out charge
 *  (below). The weight is calibrated against step 7, which pays 1 per
 *  entity examined plus 1 per movable point transformed; the walk's
 *  per-node operation (one stack slot plus a type/finiteness test) is
 *  the lightest examination in the evaluation, and 1/2 is the largest
 *  simple weight under which a maximal evaluation still fits the
 *  default budget: at the output cap of 10,000 derived lines (9,999
 *  walked — copy 0 is the base entity), each line is 11 nodes (entity,
 *  4 string fields, 2 points, 4 coordinates), so the walk charges
 *  9,999 × 11 × 1/2 = 54,994.5 alongside step 7's 29,997, a total of
 *  84,991.5 of the 100,000 default budget (pinned by the output-cap
 *  regression in parametric-review-c06-bounded-walk). A weight of 1
 *  would charge 109,989 for the walk alone and refuse the maximal
 *  evaluation the output cap explicitly admits. */
export const FINITE_WALK_NODE_WEIGHT = 0.5;

/** Outcome of one bounded finiteness walk: every reachable number is
 *  finite, a reachable number is not finite, or the walk could not
 *  complete within its bounds (work budget exhausted, or the depth
 *  bound above breached). */
type FiniteWalkOutcome = 'finite' | 'non-finite' | 'over-budget';

/** Bounded structural finiteness walk over one derived root (step 7.5).
 *  Entities and attribute definitions are plain data all the way down,
 *  so a structural walk reaches every coordinate, radius, angle and
 *  size the transforms compute — including the ones a per-type field
 *  list would eventually forget (review C06).
 *
 *  The traversal is deliberately bounded in three ways (round-3 static
 *  cost note on the original recursive walk, which rescanned shared
 *  sub-objects once per referencing root with no accounting):
 *  - ITERATIVE, with an explicit stack: no call-stack growth, so a
 *    deeply nested structure cannot overflow the interpreter stack.
 *  - SHARING-AWARE: `seen` is keyed by object identity and shared by
 *    every root of the step-7.5 pass, so a sub-object referenced from
 *    many derived entries — a nested insert's dynamic state, shared by
 *    reference by every array copy of that insert — is EXPANDED
 *    exactly once, not once per copy: its subtree is walked and
 *    charged at its single expansion. (Each referencing slot still
 *    pays the per-node weight as part of its own parent's fan-out —
 *    the slot is real enumeration work — but the shared subtree
 *    behind it is never rescanned.)
 *  - BUDGETED, WITH FAN-OUT ADMITTED BEFORE ENUMERATION (round-4
 *    static note: depth and unique-container counts do not bound
 *    WIDTH — a container's children were previously all materialized
 *    by Object.values and pushed before any charge beyond the
 *    container's own 1, so an 8-wide and a 16-wide record cost the
 *    walk the same). Every node is now charged FINITE_WALK_NODE_WEIGHT
 *    exactly once, when it is scheduled: the root up front, and every
 *    child as part of its parent's fan-out charge, levied as ONE
 *    charge BEFORE the children are enumerated — the child count
 *    comes from the array length, or from Object.keys for a record,
 *    never from materializing the values first. If the budget refuses
 *    the fan-out, the children are not enumerated at all. Doubling a
 *    container's width doubles its fan-out charge. Charges go through
 *    `chargeNode`, the evaluation's existing work-budget charge, so
 *    the walk refuses under the same discipline as the rest of the
 *    evaluation instead of scanning without limit.
 *  Visitation follows the old recursive walk's order (children in
 *  Object.values order, depth-first), so the first non-finite number
 *  found — and therefore the refusal step 7.5 reports — is unchanged. */
function walkNumbersFinite(
  root: unknown,
  seen: Set<object>,
  chargeNode: (n: number) => boolean,
): FiniteWalkOutcome {
  // The root is scheduled by the caller: charge its per-node weight up
  // front. A root already in `seen` is a no-op walk, exactly as the
  // pop-time skip behaved before (no charge, no checks).
  if (root !== null && typeof root === 'object') {
    if (seen.has(root)) return 'finite';
    if (!chargeNode(FINITE_WALK_NODE_WEIGHT)) return 'over-budget';
  }
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return 'non-finite';
      continue;
    }
    if (value === null || typeof value !== 'object') continue;
    if (seen.has(value)) continue;
    if (depth > MAX_FINITE_WALK_DEPTH) return 'over-budget';
    seen.add(value);
    // Fan-out admission: charge every child slot (FINITE_WALK_NODE_WEIGHT
    // each) BEFORE enumerating the children. The count is the array
    // length, or the record's key count — Object.keys allocates the
    // key list only, never the values. A refused charge means the
    // children are not enumerated at all.
    const childCount = Array.isArray(value) ? value.length : Object.keys(value).length;
    if (!chargeNode(childCount * FINITE_WALK_NODE_WEIGHT)) return 'over-budget';
    const children: readonly unknown[] = Array.isArray(value) ? value : Object.values(value);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push({ value: children[i], depth: depth + 1 });
    }
  }
  return 'finite';
}

/**
 * The composed transform one evaluation applied to one attribute
 * definition, as an absolute affine point map plus the scalar parts of
 * the placement transform: a point q of the authored placement maps to
 * (a·q.x + b·q.y + ox, c·q.x + d·q.y + oy), the height composes by
 * `heightRatio` and the rotation by `rotationDelta` — exactly the
 * operations transformAttributePlacement performed on the definition
 * while the pipeline ran (round 4, R3-01). Recorded per attribute in
 * pipeline order by evaluateDynamicBlock and returned in the result,
 * so placement composition consumes the ACTUAL action transforms:
 * a flip contributes its true reflection even when the axis fixes
 * every authored anchor and the evaluated definition is field-for-field
 * identical to the authored one.
 */
export interface AttributeActionTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly ox: number;
  readonly oy: number;
  readonly heightRatio: number;
  readonly rotationDelta: number;
}

/** Compose two attribute transforms: the result applies `prev` first,
 *  then `next` (pipeline order). */
function composeAttributeTransforms(next: AttributeActionTransform, prev: AttributeActionTransform): AttributeActionTransform {
  return {
    a: next.a * prev.a + next.b * prev.c,
    b: next.a * prev.b + next.b * prev.d,
    c: next.c * prev.a + next.d * prev.c,
    d: next.c * prev.b + next.d * prev.d,
    ox: next.a * prev.ox + next.b * prev.oy + next.ox,
    oy: next.c * prev.ox + next.d * prev.oy + next.oy,
    heightRatio: prev.heightRatio * next.heightRatio,
    rotationDelta: prev.rotationDelta + next.rotationDelta,
  };
}

const translationTransform = (delta: Point): AttributeActionTransform => ({
  a: 1, b: 0, c: 0, d: 1, ox: delta.x, oy: delta.y, heightRatio: 1, rotationDelta: 0,
});

/** Reflect a point across the line a-b. The point-level half of
 *  mirrorEntityAcross (core/entities), used for attribute placements, whose
 *  only movable datum is their position. */
function reflectPoint(p: Point, a: Point, b: Point): Point {
  const d = normalize(sub(b, a));
  const v = sub(p, a);
  const proj = scalePoint(d, dot(v, d));
  const perp = sub(v, proj);
  return add(a, sub(proj, perp));
}

/** The action kinds this build evaluates (opaque actions refused earlier). */
type ModeledAction = StretchAction | MoveAction | RotateAction | ScaleAction | FlipAction | ArrayAction;

/** A modeled (non-opaque) parameter: the kinds an action can be driven by. */
type ModeledParameter = LinearDistanceParameter | AngleParameter | FlipParameter;

/** Does action.cover's selection cover targetId's movable point `pointIndex`,
 *  positioned at point p, for dependency derivation? (Frame membership of p is
 *  tested by the caller.) */
function selectionCovers(
  action: StretchAction,
  targetId: string,
  pointIndex: number,
): boolean {
  for (const sel of action.selection) {
    if (sel.entityId !== targetId) continue;
    if (sel.points.kind === 'frame') return true;
    if (sel.points.indices.includes(pointIndex)) return true;
  }
  return false;
}

/**
 * Canonical string key for a (definition, effective values) pair, for callers
 * that memoize evaluations. Built from sorted parameter ids and round-trippable
 * number formatting, so equal inputs always produce equal keys across sessions.
 */
export function evaluationKey(
  definition: DynamicBlockDefinition,
  effective: Readonly<Record<string, DynamicParameterValue>>,
): string {
  const parts = definition.parameters
    .map((param) => param.id)
    .sort()
    .map((id) => {
      const value = effective[id];
      if (!value) return `${id}=missing`;
      switch (value.kind) {
        case 'distance':
          return `${id}=d:${String(value.value)}`;
        case 'angle':
          return `${id}=a:${String(value.value)}`;
        case 'flip':
          return `${id}=f:${String(value.value)}`;
        case 'visibility':
          return `${id}=v:${value.value}`;
        case 'lookup':
          // JSON encoding keeps null (no row) distinct from a row named "null".
          return `${id}=l:${JSON.stringify(value.value)}`;
        case 'opaque':
          return `${id}=o:${value.payload}`;
      }
    });
  return `dyn${definition.version}|${parts.join(';')}`;
}

/**
 * The row the given effective values exactly describe, or undefined
 * ("Custom"). A row matches iff every input's effective value equals the
 * row's key value AND every assignment target's effective value equals the
 * row's assignment (numeric values within EVALUATION_TOLERANCE;
 * flip/visibility values exact — see parameterValuesEqual). First match in
 * authoring order wins. Used by the properties UI only; evaluation never
 * calls this (design §2.7 — key-matching was rejected as an evaluation
 * rule in §2.2, model 1).
 */
export function matchingLookupRow(
  param: LookupParameter,
  effective: Readonly<Record<string, DynamicParameterValue>>,
): string | undefined {
  for (const row of param.rows) {
    let matches = true;
    for (const inputId of param.inputs) {
      const actual = effective[inputId];
      const expected = row.key[inputId];
      if (!actual || !expected || !parameterValuesEqual(actual, expected)) {
        matches = false;
        break;
      }
    }
    if (matches) {
      for (const [targetId, expected] of Object.entries(row.assignments)) {
        const actual = effective[targetId];
        if (!actual || !parameterValuesEqual(actual, expected)) {
          matches = false;
          break;
        }
      }
    }
    if (matches) return row.name;
  }
  return undefined;
}

/**
 * The one value resolution every consumer shares (review R11): instance
 * validation, then the lookup override pass (design §2.6). `effective` is
 * the raw validated map (stored values, defaults filled in); `resolved`
 * is `effective` with the active lookup row's key and assignments applied
 * — the values geometry is evaluated from. When the definition has a
 * lookup parameter whose effective choice names a row, the row wins;
 * direct values under an active row are shadowed, not deleted (remove
 * the choice and they rule again, unchanged). Key and assignments are
 * disjoint by definition validation, and every value they inject was
 * validated against its target parameter at definition time, so the
 * override is total and cannot produce an invalid effective value.
 *
 * Grip positions, Properties rows and command prompts MUST read
 * `resolved` (through this function), never the raw map: before R11 they
 * read the raw values, so a covered parameter displayed its shadowed
 * stored value while geometry used the row's — three surfaces, two
 * truths. `evaluateDynamicBlock` itself derives its `finalEffective`
 * here, so the surfaces cannot drift apart again.
 */
export type EffectiveValuesResolution =
  | {
      readonly ok: true;
      /** Raw effective values (stored, else definition defaults). */
      readonly effective: Readonly<Record<string, DynamicParameterValue>>;
      /** Lookup-resolved values — geometry's values. The SAME object as
       *  `effective` when no row applies. */
      readonly resolved: Readonly<Record<string, DynamicParameterValue>>;
      /** The applied row's name, when a row produced `resolved`. */
      readonly appliedRow?: string;
      /** Parameters whose resolved value came from the applied row. */
      readonly rowSetParameters: ReadonlySet<string>;
      /** Declared (always undefined) so union access typechecks under
       *  tsconfig.scripts.json (strictNullChecks off) — review R01. */
      readonly issues?: undefined;
    }
  | {
      readonly ok: false;
      readonly issues: readonly InstanceIssue[];
      /** Declared (always undefined) so union access typechecks under
       *  tsconfig.scripts.json (strictNullChecks off) — review R01. */
      readonly effective?: undefined;
      readonly resolved?: undefined;
      readonly appliedRow?: undefined;
      readonly rowSetParameters?: undefined;
    };

export function resolvedEffectiveValues(
  definition: DynamicBlockDefinition,
  instance: DynamicInstanceState | undefined,
  blockName?: string,
): EffectiveValuesResolution {
  const validation = validateInstanceValues(definition, instance, blockName);
  if (!validation.ok) return { ok: false, issues: validation.issues };
  const effective = validation.effective;
  const lookup = definition.parameters.find((p): p is LookupParameter => p.kind === 'lookup');
  if (!lookup) return { ok: true, effective, resolved: effective, rowSetParameters: new Set<string>() };
  const choice = effective[lookup.id];
  const rowName = choice && choice.kind === 'lookup' ? choice.value : null;
  if (rowName === null) return { ok: true, effective, resolved: effective, rowSetParameters: new Set<string>() };
  // Instance validation guarantees the named row exists.
  const row = lookup.rows.find((r) => r.name === rowName)!;
  const rowSetParameters = new Set<string>([...Object.keys(row.key), ...Object.keys(row.assignments)]);
  return {
    ok: true,
    effective,
    resolved: { ...effective, ...row.key, ...row.assignments },
    appliedRow: rowName,
    rowSetParameters,
  };
}

export function evaluateDynamicBlock(
  definition: DynamicBlockDefinition,
  baseEntities: readonly Entity[],
  baseAttributes: readonly AttributeDef[],
  instance: DynamicInstanceState | undefined,
  limits: EvaluationLimits = DEFAULT_EVALUATION_LIMITS,
): EvaluationResult {
  const refuse = (refusal: EvaluationRefusal): EvaluationResult => ({ ok: false, refusal });

  // 1. Structural validation (attribute definitions are identified by tag).
  const baseIds = new Set<string>([...baseEntities.map((e) => e.id), ...baseAttributes.map((a) => a.tag)]);
  const definitionIssues = validateDefinition(definition, baseIds);
  if (definitionIssues.length > 0) {
    return refuse({
      code: 'invalid-definition',
      message: `Invalid dynamic-block definition: ${definitionIssues.map((i) => i.message).join(' ')}`,
      definitionIssues,
    });
  }

  // 2. Instance validation + 3. the lookup override pass (design §2.6):
  //    a single resolution over values, before any geometry, via the
  //    shared accessor (review R11) — finalEffective is its `resolved`
  //    map. Everything downstream — grip positions in dependency
  //    derivation, action deltas, the visibility filter — reads
  //    finalEffective only; the raw effective map is used for exactly one
  //    thing: the 'value-defaulted' diagnostic is suppressed for
  //    parameters the active row sets (their value did not come from a
  //    default, and reporting "default used" would be false).
  const resolution = resolvedEffectiveValues(definition, instance);
  if (!resolution.ok) {
    return refuse({
      code: 'invalid-instance',
      message: `Invalid dynamic instance values: ${resolution.issues.map((i) => i.message).join(' ')}`,
      instanceIssues: resolution.issues,
    });
  }
  const finalEffective = resolution.resolved;
  const rowSetParameters = resolution.rowSetParameters;
  const diagnostics: EvaluationDiagnostic[] = [];
  if (resolution.appliedRow !== undefined) {
    const lookup = definition.parameters.find((p): p is LookupParameter => p.kind === 'lookup')!;
    diagnostics.push({
      severity: 'info',
      code: 'lookup-applied',
      message: `Lookup parameter '${lookup.id}' applied row '${resolution.appliedRow}', setting: ${[...rowSetParameters].sort().join(', ')}.`,
      parameterId: lookup.id,
    });
  }

  // 4. Opaque members: retained, never interpreted; evaluation refuses whole.
  for (const param of definition.parameters) {
    if (param.kind === 'opaque-parameter') {
      return refuse({
        code: 'unsupported-parameter',
        message: `Parameter '${param.id}' is an unmodeled '${param.sourceKind}' parameter; evaluation is refused and the payload is retained.`,
        parameterId: param.id,
      });
    }
  }
  for (const action of definition.actions) {
    if (action.kind === 'opaque-action') {
      return refuse({
        code: 'unsupported-action',
        message: `Action '${action.id}' is an unmodeled '${action.sourceKind}' action; evaluation is refused and the payload is retained.`,
        actionId: action.id,
      });
    }
  }

  if (definition.actions.length > limits.maxActions) {
    return refuse({
      code: 'work-limit-exceeded',
      message: `Definition has ${definition.actions.length} actions, exceeding the limit of ${limits.maxActions}.`,
    });
  }
  if (baseEntities.length > limits.maxOutputEntities) {
    return refuse({
      code: 'work-limit-exceeded',
      message: `Base entity count ${baseEntities.length} exceeds the output limit of ${limits.maxOutputEntities}.`,
    });
  }

  // Action-drivable parameters only: a visibility parameter drives no action
  // and neither does a lookup parameter (an action naming either is refused
  // by definition validation), and opaque parameters were refused above.
  const parametersById = new Map<string, ModeledParameter>();
  for (const param of definition.parameters) {
    if (param.kind !== 'opaque-parameter' && param.kind !== 'visibility' && param.kind !== 'lookup') {
      parametersById.set(param.id, param);
    }
  }
  // Opaque actions were refused above, so every remaining action is modeled.
  const actions = definition.actions as readonly ModeledAction[];

  const entityIndexById = new Map<string, number>(baseEntities.map((e, i) => [e.id, i]));
  const attributeIndexByTag = new Map<string, number>(baseAttributes.map((a, i) => [a.tag, i]));
  const targetFor = (id: string): Target | undefined => {
    const ei = entityIndexById.get(id);
    if (ei !== undefined) return { kind: 'entity', index: ei, entity: baseEntities[ei]! };
    const ai = attributeIndexByTag.get(id);
    if (ai !== undefined) return { kind: 'attribute', index: ai, attribute: baseAttributes[ai]! };
    return undefined;
  };

  let work = 0;
  const charge = (n: number): boolean => {
    work += n;
    return work <= limits.maxWork;
  };
  const workRefusal = (): EvaluationResult =>
    refuse({ code: 'work-limit-exceeded', message: `Evaluation work exceeded the limit of ${limits.maxWork}.` });

  // 6. Dependency graph + topological order (design §3.2).
  //    An action B depends on action A (A runs first) iff A moves a point B's
  //    behaviour is derived from:
  //    - B's parameter's 'value' grip (at its effective position), when the grip
  //      is flagged movesWithValue and lies inside A's frame — only across
  //      parameters: an action moving its OWN parameter's grip is the normal
  //      case (the grip rides along with the value), not a dependency. (This is
  //      what makes the design's own door fixture evaluable; a cross-parameter
  //      grip cycle is still an 'action-cycle'.)
  //    - a movable point of a B-selection target (at authored positions), when
  //      the point lies inside A's frame and A's selection covers it.
  //    Both rules are stretch-sourced: a stretch's frame membership is defined
  //    on the geometry it sees, so a stretch that moves points another action
  //    governs must run before that action. Grip coupling is derived for
  //    linear-distance parameters (the only kind whose value grip has a
  //    position on a measured segment); angle/flip parameters couple through
  //    shared selection targets instead. Whole-entity actions (30.2) have
  //    position-independent transforms and no frame, so no edge is derived
  //    for or from them: they compose in authoring order, which is the
  //    topological tie-break. This is the settled semantics (30.2d design
  //    §5): whole actions source no edges because their transforms are
  //    computed from values and definition constants — no positional datum
  //    exists to derive an order from, and any invented rule would make
  //    ordering value-dependent. Pinned by tests/parametric-chaining.test.ts.
  //    The array action (30.2c) is whole-entity-class for dependency
  //    purposes (design §3.2): it sources no edges, and the selection-point
  //    rule does not apply to it as a sink either — an array takes its
  //    copies from copy 0's position at the moment it applies, so
  //    stretch↔array order is authoring order (design §3.4 "pipeline order
  //    is the semantics", pinned by case A5). The grip rule above DOES
  //    still apply to it: its driving parameter is a linear distance, and
  //    grip coupling is parameter coupling, as for move/scale.
  const gripPointOf = (param: LinearDistanceParameter): Point | undefined => {
    const grip = param.grips.find((gr) => gr.role === 'value' && gr.movesWithValue);
    if (!grip) return undefined;
    const value = finalEffective[param.id];
    const distance = value && value.kind === 'distance' ? value.value : param.defaultValue;
    const len = Math.hypot(param.direction.x, param.direction.y);
    const unit = { x: param.direction.x / len, y: param.direction.y / len };
    return add(param.basePoint, scalePoint(unit, distance));
  };

  const count = actions.length;
  const edges: readonly Set<number>[] = actions.map(() => new Set<number>());
  for (let b = 0; b < count; b += 1) {
    const actionB = actions[b]!;
    const paramB = parametersById.get(actionB.parameterId)!;
    const gripB = paramB.kind === 'linear-distance' ? gripPointOf(paramB) : undefined;
    for (let a = 0; a < count; a += 1) {
      if (a === b) continue;
      const actionA = actions[a]!;
      if (actionA.kind !== 'stretch') continue; // whole actions source no edges (above)
      let depends = false;
      if (actionA.parameterId !== actionB.parameterId && gripB && inFrame(gripB, actionA.frame)) depends = true;
      if (!depends && actionB.kind !== 'array') {
        for (const sel of actionB.selection) {
          const target = targetFor(sel.entityId);
          if (!target) continue;
          const points = movablePoints(target);
          if (!points) continue;
          // Points are tested for dependency derivation even if the selection
          // entry for B restricts indices: a point moved by A changes the
          // geometry B sees regardless of which of B's points it is.
          for (let i = 0; i < points.length; i += 1) {
            if (!charge(1)) return workRefusal();
            if (inFrame(points[i]!, actionA.frame) && selectionCovers(actionA, sel.entityId, i)) {
              depends = true;
              break;
            }
          }
          if (depends) break;
        }
      }
      if (depends) edges[b]!.add(a);
    }
  }

  // Kahn's algorithm, ties broken by authoring order (deterministic).
  const indegree = edges.map((set) => set.size);
  const order: number[] = [];
  const done = new Array<boolean>(count).fill(false);
  for (let step = 0; step < count; step += 1) {
    let pick = -1;
    for (let i = 0; i < count; i += 1) {
      if (!done[i] && indegree[i] === 0) {
        pick = i;
        break;
      }
    }
    if (pick < 0) break;
    done[pick] = true;
    order.push(pick);
    for (let b = 0; b < count; b += 1) if (edges[b]!.has(pick)) indegree[b]! -= 1;
  }
  if (order.length < count) {
    const remaining = actions.filter((_, i) => !done[i]).map((a) => a.id).sort();
    return refuse({
      code: 'action-cycle',
      message: `Chained actions form a dependency cycle: ${remaining.join(', ')}.`,
      cycle: remaining,
    });
  }
  // Longest dependency path (chain depth), over the topological order.
  const depth = new Array<number>(count).fill(1);
  let maxDepth = 0;
  for (const i of order) {
    for (const pred of edges[i]!) depth[i] = Math.max(depth[i]!, depth[pred]! + 1);
    maxDepth = Math.max(maxDepth, depth[i]!);
  }
  if (maxDepth > limits.maxChainDepth) {
    return refuse({
      code: 'chain-depth-exceeded',
      message: `Chained-action depth ${maxDepth} exceeds the limit of ${limits.maxChainDepth}.`,
    });
  }

  // 7. Apply actions in topological order to working copies.
  const outEntities: Entity[] = [...baseEntities];
  const outAttributes: AttributeDef[] = [...baseAttributes];
  // Identity sets for the derived-output finiteness check (step 7.5):
  // working entries still identical to a base object were never touched
  // by an action and carry authored values, which are not this
  // evaluation's derivation to refuse; every other entry — a transformed
  // entity/attribute or an array copy — is output this evaluation derived.
  const baseEntityObjects = new Set<Entity>(baseEntities);
  const baseAttributeObjects = new Set<AttributeDef>(baseAttributes);
  const appliedActions: string[] = [];
  const defaultedReported = new Set<string>();

  // Working-list bookkeeping for array production (design §3.4). outEntities
  // starts as the base list in base order; an array action inserts copies
  // into it, after which base indices no longer address it directly:
  // - baseSlot maps a base entity index to its CURRENT working index (the
  //   slot of copy 0), so the appliers below — which resolve selections
  //   against base ids via targetFor — keep seeing copy 0 only, never a
  //   copy, exactly as the design requires. Attributes are never arrayed,
  //   so outAttributes needs no such mapping.
  // - sourceIds runs parallel to outEntities and records each working
  //   entity's provenance: its own id for a base entity, the base source's
  //   id for an array copy. The visibility filter (§1.4 step 8) drops array
  //   products by this source id; provenance is tracked, never parsed back
  //   out of the derived id format.
  const baseSlot: number[] = baseEntities.map((_, i) => i);
  const sourceIds: string[] = baseEntities.map((e) => e.id);

  // The composed transform actually applied to each attribute, parallel
  // to outAttributes (round 4, R3-01). Every applier that transforms an
  // attribute records the same transform here, in pipeline order, so
  // the result can report the ACTUAL per-attribute motion instead of
  // leaving consumers to infer it from snapshots. Recording is O(1) per
  // application — it rides the pipeline's existing work charges and
  // adds no pass of its own.
  const attributeTx: (AttributeActionTransform | undefined)[] = baseAttributes.map(() => undefined);
  const recordAttributeTransform = (index: number, next: AttributeActionTransform): void => {
    const prev = attributeTx[index];
    attributeTx[index] = prev ? composeAttributeTransforms(next, prev) : next;
  };
  const buildAttributeTransforms = (): ReadonlyMap<string, AttributeActionTransform> => {
    const map = new Map<string, AttributeActionTransform>();
    outAttributes.forEach((attribute, i) => {
      const tx = attributeTx[i];
      // First tag wins, matching the find-by-tag lookups consumers use.
      if (tx && !map.has(attribute.tag)) map.set(attribute.tag, tx);
    });
    return map;
  };

  /** Apply one stretch action to the working copies. Returns a refusal, or
   *  undefined on success (including a zero-delta no-op). */
  const applyStretchAction = (action: StretchAction, param: LinearDistanceParameter): EvaluationResult | undefined => {
    const valueEntry = finalEffective[param.id]!;
    const effectiveValue = valueEntry.kind === 'distance' ? valueEntry.value : param.defaultValue;
    const rawDelta = effectiveValue - param.defaultValue;
    const directionLen = Math.hypot(param.direction.x, param.direction.y);
    const unit = { x: param.direction.x / directionLen, y: param.direction.y / directionLen };
    const delta = rotate(scalePoint(unit, rawDelta * (action.distanceMultiplier ?? 1)), action.angleOffset ?? 0);
    const zeroDelta = Math.hypot(delta.x, delta.y) <= EVALUATION_TOLERANCE;
    if (zeroDelta) {
      diagnostics.push({
        severity: 'info',
        code: 'zero-delta',
        message: `Action '${action.id}' has a zero displacement (parameter '${param.id}' is at its default).`,
        parameterId: param.id,
        actionId: action.id,
      });
    }

    let anyMoved = false;
    for (const sel of action.selection) {
      const baseTarget = targetFor(sel.entityId);
      if (!baseTarget) continue; // validateDefinition already refused unknown ids.
      // Current (possibly already moved by an earlier action) target state.
      // Entity reads go through baseSlot: after an array action, the working
      // slot of a base entity is no longer its base index (design §3.4).
      const target: Target =
        baseTarget.kind === 'entity'
          ? { kind: 'entity', index: baseTarget.index, entity: outEntities[baseSlot[baseTarget.index]!]! }
          : { kind: 'attribute', index: baseTarget.index, attribute: outAttributes[baseTarget.index]! };
      const points = movablePoints(target);
      if (points === null) {
        const what =
          target.kind === 'entity' && target.entity.type === 'polyline' && target.entity.widthFrame
            ? `Polyline '${sel.entityId}' carries a widthFrame, whose display geometry is not in definition coordinates.`
            : `Entity '${sel.entityId}' has no movable points for a stretch action.`;
        return refuse({ code: 'unstretchable-entity', message: what, actionId: action.id });
      }
      if (!charge(1 + points.length)) return workRefusal();
      const candidates =
        sel.points.kind === 'frame' ? points.map((_, i) => i) : sel.points.indices;
      for (const i of candidates) {
        if (i >= points.length) {
          return refuse({
            code: 'unstretchable-entity',
            message: `Action '${action.id}' selection point index ${i} is out of range for '${sel.entityId}' (${points.length} movable points).`,
            actionId: action.id,
          });
        }
      }
      if (zeroDelta) continue; // Structural checks above still apply; nothing moves.

      const moves = new Map<number, Point>();
      for (const i of candidates) {
        const p = points[i]!;
        if (inFrame(p, action.frame)) moves.set(i, add(p, delta));
      }
      if (moves.size === 0) {
        // No movable point was in the frame. A non-movable contact point in the
        // frame (arc endpoint, ellipse axis tip) is a stretch this model cannot
        // honor — refuse rather than silently leave the entity unchanged.
        const contacts = contactPoints(target);
        if (contacts.some((p) => inFrame(p, action.frame))) {
          return refuse({
            code: 'unstretchable-entity',
            message: `Action '${action.id}' frame touches '${sel.entityId}' only at a point that cannot be stretched (arc endpoint / ellipse axis tip); only whole moves via the center are supported.`,
            actionId: action.id,
          });
        }
        continue;
      }
      anyMoved = true;
      if (target.kind === 'entity') {
        outEntities[baseSlot[target.index]!] = withMovedPoints(target.entity, moves);
      } else {
        // A stretch that moves the attribute's position point moves the
        // whole placement rigidly by the same delta (C05): every text
        // anchor rides, so a justified attribute's anchor moves exactly
        // as far as its position does.
        const movedTo = moves.get(0);
        if (movedTo) {
          const delta = sub(movedTo, target.attribute.position);
          outAttributes[target.index] = transformAttributePlacement(target.attribute, (p) => add(p, delta));
          recordAttributeTransform(target.index, translationTransform(delta));
        }
      }
    }
    if (!zeroDelta && !anyMoved) {
      diagnostics.push({
        severity: 'warning',
        code: 'frame-missed-selection',
        message: `Action '${action.id}' moved no selected point; its frame may be misplaced.`,
        parameterId: param.id,
        actionId: action.id,
      });
    }
    return undefined;
  };

  /**
   * Apply one whole-entity action (30.2: move / rotate / scale / flip) to the
   * working copies. The transform is the delta between the parameter's
   * effective value and its default — the authored state is the default state,
   * as for stretch — computed once, then applied to every selected target with
   * the exact core transform stack. A parameter at its default is a no-op:
   * targets keep their identity and an 'action-no-op' diagnostic is reported.
   * Whole transforms are exact for every entity type, so there is no
   * unstretchable case here; an attribute target is transformed by its
   * placement point only (values and tags are never evaluation outputs).
   */
  const applyWholeAction = (action: MoveAction | RotateAction | ScaleAction | FlipAction): EvaluationResult | undefined => {
    const param = parametersById.get(action.parameterId)!;
    const degenerate = (message: string): EvaluationResult =>
      refuse({ code: 'degenerate-transform', message, actionId: action.id, parameterId: param.id });
    let transformEntity: ((entity: Entity) => Entity) | undefined;
    let transformPoint: ((point: Point) => Point) | undefined;
    // Attributes take the FULL placement transform (C05), mirroring what
    // the entity transform does to a text entity — not just a moved
    // position point.
    let transformAttr: ((attribute: AttributeDef) => AttributeDef) | undefined;
    // The same transform in AttributeActionTransform form, recorded for
    // every attribute the action moves (round 4, R3-01). Built in exactly
    // the branches that set transformAttr, from the same constants, so
    // the record cannot diverge from the applied transform.
    let actionTx: AttributeActionTransform | undefined;
    switch (action.kind) {
      case 'move': {
        const p = param as LinearDistanceParameter;
        const entry = finalEffective[p.id]!;
        const value = entry.kind === 'distance' ? entry.value : p.defaultValue;
        const directionLen = Math.hypot(p.direction.x, p.direction.y);
        const unit = { x: p.direction.x / directionLen, y: p.direction.y / directionLen };
        const delta = rotate(scalePoint(unit, (value - p.defaultValue) * (action.distanceMultiplier ?? 1)), action.angleOffset ?? 0);
        if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) {
          return degenerate(`Move action '${action.id}' computed a non-finite displacement.`);
        }
        if (Math.hypot(delta.x, delta.y) > EVALUATION_TOLERANCE) {
          transformEntity = (entity) => translateEntity(entity, delta);
          transformPoint = (point) => add(point, delta);
          transformAttr = (attribute) => transformAttributePlacement(attribute, (p) => add(p, delta));
          actionTx = translationTransform(delta);
        }
        break;
      }
      case 'rotate': {
        const p = param as AngleParameter;
        const entry = finalEffective[p.id]!;
        const value = entry.kind === 'angle' ? entry.value : p.defaultValue;
        const deltaAngle = value - p.defaultValue;
        if (!Number.isFinite(deltaAngle)) {
          return degenerate(`Rotate action '${action.id}' computed a non-finite angle.`);
        }
        if (Math.abs(deltaAngle) > EVALUATION_TOLERANCE) {
          const { center } = action;
          transformEntity = (entity) => rotateEntity(entity, center, deltaAngle);
          transformPoint = (point) => rotate(point, deltaAngle, center);
          transformAttr = (attribute) => transformAttributePlacement(attribute, (p) => rotate(p, deltaAngle, center), deltaAngle);
          const cos = Math.cos(deltaAngle);
          const sin = Math.sin(deltaAngle);
          actionTx = {
            a: cos, b: -sin, c: sin, d: cos,
            ox: center.x - (cos * center.x - sin * center.y),
            oy: center.y - (sin * center.x + cos * center.y),
            heightRatio: 1, rotationDelta: deltaAngle,
          };
        }
        break;
      }
      case 'scale': {
        const p = param as LinearDistanceParameter;
        const entry = finalEffective[p.id]!;
        const value = entry.kind === 'distance' ? entry.value : p.defaultValue;
        // The default's positivity is a definition-validation rule; the
        // effective value is instance data, so a degenerate factor (zero or
        // negative value, overflow) is refused here, never applied.
        const factor = value / p.defaultValue;
        if (!Number.isFinite(factor) || factor <= 0) {
          return degenerate(`Scale action '${action.id}' computed factor ${factor} from value ${value} / default ${p.defaultValue}; the factor must be positive and finite.`);
        }
        if (Math.abs(factor - 1) > EVALUATION_TOLERANCE) {
          const { basePoint } = action;
          transformEntity = (entity) => scaleEntityBy(entity, basePoint, factor);
          transformPoint = (point) => add(basePoint, scalePoint(sub(point, basePoint), factor));
          transformAttr = (attribute) => transformAttributePlacement(attribute, (p) => add(basePoint, scalePoint(sub(p, basePoint), factor)), 0, factor);
          actionTx = {
            a: factor, b: 0, c: 0, d: factor,
            ox: basePoint.x * (1 - factor), oy: basePoint.y * (1 - factor),
            heightRatio: factor, rotationDelta: 0,
          };
        }
        break;
      }
      case 'flip': {
        const p = param as FlipParameter;
        const entry = finalEffective[p.id]!;
        const value = entry.kind === 'flip' ? entry.value : p.defaultValue;
        if (value !== p.defaultValue) {
          const { axisA, axisB } = action;
          transformEntity = (entity) => mirrorEntityAcross(entity, axisA, axisB);
          transformPoint = (point) => reflectPoint(point, axisA, axisB);
          transformAttr = (attribute) => transformAttributePlacement(attribute, (p) => reflectPoint(p, axisA, axisB));
          // The reflection's matrix form (2·ûûᵀ − I about the axis line,
          // û the unit axis direction — the same normalisation
          // reflectPoint applies), recorded even when the axis fixes
          // every authored anchor: the record, not the snapshot, is
          // what proves a flip happened (round 4, R3-01).
          const u = normalize(sub(axisB, axisA));
          const ra = 2 * u.x * u.x - 1;
          const rb = 2 * u.x * u.y;
          const rd = 2 * u.y * u.y - 1;
          actionTx = {
            a: ra, b: rb, c: rb, d: rd,
            ox: axisA.x - (ra * axisA.x + rb * axisA.y),
            oy: axisA.y - (rb * axisA.x + rd * axisA.y),
            heightRatio: 1, rotationDelta: 0,
          };
        }
        break;
      }
    }
    if (!transformEntity || !transformPoint) {
      diagnostics.push({
        severity: 'info',
        code: 'action-no-op',
        message: `Action '${action.id}' does not change geometry (parameter '${param.id}' is at its default).`,
        parameterId: param.id,
        actionId: action.id,
      });
      return undefined;
    }
    for (const sel of action.selection) {
      const baseTarget = targetFor(sel.entityId);
      if (!baseTarget) continue; // validateDefinition already refused unknown ids.
      // Current (possibly already transformed by an earlier action) state.
      // Entity reads go through baseSlot, as in applyStretchAction.
      const target: Target =
        baseTarget.kind === 'entity'
          ? { kind: 'entity', index: baseTarget.index, entity: outEntities[baseSlot[baseTarget.index]!]! }
          : { kind: 'attribute', index: baseTarget.index, attribute: outAttributes[baseTarget.index]! };
      const points = movablePoints(target);
      if (!charge(1 + (points ? points.length : 1))) return workRefusal();
      if (target.kind === 'entity') {
        outEntities[baseSlot[target.index]!] = transformEntity(target.entity);
      } else if (transformAttr) {
        outAttributes[target.index] = transformAttr(target.attribute);
        if (actionTx) recordAttributeTransform(target.index, actionTx);
      }
    }
    return undefined;
  };

  /**
   * Apply one array action (30.2c, design §3) to the working list. The
   * selection is repeated as a unit along the driving parameter's
   * direction; copies are inserted immediately after their source entity,
   * inherit the source's CURRENT geometry (actions before the array have
   * already transformed it — pipeline order is the semantics), and get
   * deterministic derived ids. Later actions resolve selections against
   * base ids and therefore see copy 0 only; a second array on the same
   * source arrays copy 0's current geometry, so two arrays on one source
   * are additive (n₁ + n₂ − 1 entities), never multiplicative (design
   * §3.4; whether native evaluation multiplies is fixture-gated, §9).
   */
  const applyArrayAction = (action: ArrayAction): EvaluationResult | undefined => {
    // Definition validation guarantees the driving parameter is a
    // linear-distance parameter.
    const param = parametersById.get(action.parameterId)! as LinearDistanceParameter;
    const valueEntry = finalEffective[param.id]!;
    const value = valueEntry.kind === 'distance' ? valueEntry.value : param.defaultValue;
    // Count rule (design §3.3) — JCad's own rule, stated here as ours and
    // NOT as a native claim (the native rule is undocumented at field
    // level; fixture question Q13): count(v) = floor(v / spacing) + 1,
    // endpoint inclusive at exact multiples — at v = m·spacing the count
    // is m + 1 and the last copy sits exactly at offset v. There is no
    // rounding mode and no tolerance fudge in the rule: floor on the
    // exact quotient. Copy 0 is the selection itself, present at any
    // value; v = 0 gives count 1. No valid value gives zero copies.
    const copies = Math.floor(value / action.spacing) + 1;
    if (copies < 1) {
      // Only reachable with a negative effective value, which design §3.1
      // treats as impossible (distance values are ≥ 0 by validation).
      // Refuse rather than produce zero copies or silently clamp.
      return refuse({
        code: 'degenerate-transform',
        message: `Array action '${action.id}' computed a copy count of ${copies} from value ${value} at spacing ${action.spacing}; the driving value must not be negative.`,
        actionId: action.id,
        parameterId: param.id,
      });
    }

    // Resolve the selection against base ids (validation refused unknown
    // ids). Attribute definitions may NOT be arrayed (design §3.4): an
    // evaluation refusal, not a validation issue, because ids and tags
    // share one identity space at validation time. A duplicated selection
    // entry names the same source twice; the source is arrayed once.
    const selectedBase: number[] = [];
    const seenBase = new Set<number>();
    for (const sel of action.selection) {
      const target = targetFor(sel.entityId);
      if (!target) continue; // validateDefinition already refused unknown ids.
      if (target.kind === 'attribute') {
        return refuse({
          code: 'unsupported-selection',
          message: `Array action '${action.id}' selects attribute definition '${sel.entityId}'; attribute definitions cannot be arrayed (attribute text is generated per insert from the definition list, not per entity copy).`,
          actionId: action.id,
        });
      }
      if (!seenBase.has(target.index)) {
        seenBase.add(target.index);
        selectedBase.push(target.index);
      }
    }

    // Limit pre-check BEFORE any copy is created (design §3.5): the
    // post-array working count is known exactly, so an over-limit array
    // refuses here and no copy is ever made.
    const added = (copies - 1) * selectedBase.length;
    if (outEntities.length + added > limits.maxOutputEntities) {
      return refuse({
        code: 'work-limit-exceeded',
        message: `Array action '${action.id}' would produce ${outEntities.length + added} entities, exceeding the output limit of ${limits.maxOutputEntities}.`,
        actionId: action.id,
      });
    }
    if (copies === 1 || selectedBase.length === 0) {
      // A no-op: either the count rule gives one copy (possible off-default,
      // when v < spacing — the message states the count and does not claim
      // the parameter is at its default, design §3.5), or the selection is
      // empty, which validation allows (design §3.6).
      diagnostics.push({
        severity: 'info',
        code: 'action-no-op',
        message:
          selectedBase.length === 0
            ? `Array action '${action.id}' selects no entities; nothing was arrayed.`
            : `Array action '${action.id}' produced a copy count of 1 at value ${value} and spacing ${action.spacing}; nothing was arrayed.`,
        parameterId: param.id,
        actionId: action.id,
      });
      return undefined;
    }

    const directionLen = Math.hypot(param.direction.x, param.direction.y);
    const unit = { x: param.direction.x / directionLen, y: param.direction.y / directionLen };
    const selectedSlots = new Set(selectedBase.map((bi) => baseSlot[bi]!));
    // Reverse of baseSlot: working slot -> base index (-1 for array copies,
    // which are never selection targets).
    const baseIndexOfSlot: number[] = outEntities.map(() => -1);
    baseSlot.forEach((slot, bi) => {
      baseIndexOfSlot[slot] = bi;
    });

    // Build the new working list in one pass: each entity in working order,
    // a selected source immediately followed by its copies. Work is charged
    // per copy at the whole-action convention (1 + movable point count)
    // before the copy is created; a mid-production work refusal discards
    // the new list untouched — the working list is only spliced once every
    // copy exists, so refusal stays atomic by purity.
    const newEntities: Entity[] = [];
    const newSourceIds: string[] = [];
    const newBaseSlot: number[] = baseSlot.map(() => -1);
    for (let slot = 0; slot < outEntities.length; slot += 1) {
      const entity = outEntities[slot]!;
      const bi = baseIndexOfSlot[slot]!;
      if (bi >= 0) newBaseSlot[bi] = newEntities.length;
      newEntities.push(entity);
      newSourceIds.push(sourceIds[slot]!);
      if (!selectedSlots.has(slot)) continue;
      // The entity in this slot IS copy 0 (a base entity, by the slot
      // bookkeeping), so its id is the base source id the derived ids are
      // built from. Copies are the exact core translation of the source's
      // current geometry, then the id replacement (design §3.4) — for a
      // nested insert member the copy shares the source's `dynamic` state
      // object by reference and is evaluated independently at expansion.
      const points = movablePoints({ kind: 'entity', index: bi, entity });
      for (let k = 1; k < copies; k += 1) {
        if (!charge(1 + (points ? points.length : 1))) return workRefusal();
        newEntities.push({ ...translateEntity(entity, scalePoint(unit, k * action.spacing)), id: `${entity.id}#${action.id}#${k}` });
        newSourceIds.push(sourceIds[slot]!);
      }
    }
    outEntities.splice(0, outEntities.length, ...newEntities);
    sourceIds.splice(0, sourceIds.length, ...newSourceIds);
    for (let bi = 0; bi < baseSlot.length; bi += 1) baseSlot[bi] = newBaseSlot[bi]!;
    return undefined;
  };

  for (const actionIndex of order) {
    const action = actions[actionIndex]!;
    const param = parametersById.get(action.parameterId)!;
    // 'value-defaulted' is suppressed for parameters the active lookup row
    // sets (design §2.6 step 3): their value came from the row, not from a
    // default, and 'lookup-applied' already reports them.
    if (instance?.values[param.id] === undefined && !rowSetParameters.has(param.id) && !defaultedReported.has(param.id)) {
      defaultedReported.add(param.id);
      diagnostics.push({
        severity: 'info',
        code: 'value-defaulted',
        message: `Parameter '${param.id}' has no instance value; its default ${param.defaultValue} is used.`,
        parameterId: param.id,
        actionId: action.id,
      });
    }
    // Definition validation guarantees the parameter kind pairs with the action
    // kind, so the stretch branch's parameter is a linear-distance parameter.
    const refusal =
      action.kind === 'stretch'
        ? applyStretchAction(action, param as LinearDistanceParameter)
        : action.kind === 'array'
          ? applyArrayAction(action)
          : applyWholeAction(action);
    if (refusal) return refusal;
    appliedActions.push(action.id);
  }

  // 7.5 Derived-output finiteness (review C06). Finite inputs can still
  //    overflow in derivation: a finite distance times a finite stretch
  //    multiplier, or a finite scale factor applied to a large authored
  //    coordinate, produces Infinity/NaN geometry — and the per-action
  //    factor/delta checks cannot see it, because the FACTOR is finite;
  //    only the produced coordinates are not. Returning such a result as
  //    ok:true also poisons the R06 edit dry run, which trusts ok and
  //    would commit the parameter state. So before success is returned,
  //    every DERIVED working entry (transformed, point-moved or
  //    array-copied — see the identity sets in step 7) is walked and
  //    every number in it must be finite. The traversal is the bounded
  //    walkNumbersFinite above: iterative, sharing-aware (one identity
  //    set across both loops, so sub-objects shared between derived
  //    entries are expanded once), depth-bounded by MAX_FINITE_WALK_DEPTH
  //    and charged into this evaluation's existing work budget per node
  //    at FINITE_WALK_NODE_WEIGHT, each container's fan-out admitted as
  //    one charge before its children are enumerated. If the walk cannot complete within those
  //    bounds it refuses 'work-limit-exceeded' like any other budget
  //    exhaustion, rather than scanning without limit. Otherwise the
  //    first offender in working order refuses the whole evaluation
  //    with 'degenerate-transform'; nothing is clamped or repaired, and
  //    the refusal is atomic by purity, exactly like every other
  //    refusal. Huge-but-finite results (1e308 exactly, products that
  //    stay finite) pass: the test is Number.isFinite, not a magnitude
  //    cap.
  const finiteSeen = new Set<object>();
  for (const entity of outEntities) {
    if (baseEntityObjects.has(entity)) continue;
    const outcome = walkNumbersFinite(entity, finiteSeen, charge);
    if (outcome === 'over-budget') return workRefusal();
    if (outcome === 'non-finite') {
      return refuse({
        code: 'degenerate-transform',
        message: `Evaluation derived non-finite geometry for entity '${entity.id}' (${entity.type}); finite parameter values overflowed the derived coordinates, so the result is refused rather than returned with Infinity/NaN values.`,
      });
    }
  }
  for (const attribute of outAttributes) {
    if (baseAttributeObjects.has(attribute)) continue;
    const outcome = walkNumbersFinite(attribute, finiteSeen, charge);
    if (outcome === 'over-budget') return workRefusal();
    if (outcome === 'non-finite') {
      return refuse({
        code: 'degenerate-transform',
        message: `Evaluation derived a non-finite placement for attribute definition '${attribute.tag}'; finite parameter values overflowed the derived coordinates, so the result is refused rather than returned with Infinity/NaN values.`,
      });
    }
  }

  // 8. Visibility post-pass filter (design §1.4 step 8). Actions have been
  //    applied to the FULL authored set above, hidden entities included — so
  //    a state switch reveals geometry already consistent with the parameter
  //    values. The filter is the last step: it drops every working entity
  //    whose SOURCE id (array products follow their source, design §3.4)
  //    and every working attribute whose tag is not in the effective
  //    state's visible set, and changes nothing else — appliedActions,
  //    diagnostics and work accounting are exactly as produced by step 7,
  //    and budgets stay pre-filter (the filter only shrinks what expansion
  //    receives). What it keeps, it keeps by identity. The state is read
  //    from finalEffective, so a lookup row that assigns the visibility
  //    parameter applies in the same evaluation (design §2.8).
  const visibility = definition.parameters.find(
    (p): p is VisibilityParameter => p.kind === 'visibility',
  );
  if (!visibility) {
    return { ok: true, entities: outEntities, attributes: outAttributes, appliedActions, diagnostics, attributeTransforms: buildAttributeTransforms() };
  }
  const stateEntry = finalEffective[visibility.id];
  const stateName = stateEntry && stateEntry.kind === 'visibility' ? stateEntry.value : visibility.defaultState;
  // Instance validation (step 2) guarantees the name is one of the states.
  const state = visibility.states.find((s) => s.name === stateName)!;
  const visible = new Set<string>(state.visible);
  return {
    ok: true,
    // Entities are filtered by SOURCE id (design §3.4): an array copy's
    // derived id is never in a state's visible set, but its source's
    // membership decides for the whole family — if the source is hidden,
    // all its copies are dropped; if visible, all are kept. For a base
    // entity the source id is its own id, so non-array results are
    // filtered exactly as before.
    entities: outEntities.filter((_, i) => visible.has(sourceIds[i]!)),
    attributes: outAttributes.filter((a) => visible.has(a.tag)),
    appliedActions,
    diagnostics,
    // Built from the UNfiltered working list: a state-hidden attribute's
    // record is inert (consumers look transforms up only for attributes
    // present in the returned definition), and the record stays truthful
    // about the motion the pipeline applied before the filter ran.
    attributeTransforms: buildAttributeTransforms(),
  };
}
