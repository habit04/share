/**
 * Priority 30.1/30.2 — dynamic-block definitions (authored normalized model).
 * 30.1: linear-distance parameter + stretch action. 30.2 (additive, same model
 * version): angle + flip parameters; move / rotate / uniform-scale / flip actions.
 * 30.2a (additive, same model version): the visibility parameter (named states
 * over the definition's own entities; no action — evaluation applies it as a
 * final filter, see evaluate.ts).
 * 30.2b (additive, same model version): the lookup parameter (a named row table
 * over the other parameters; the instance stores a row choice and evaluation
 * applies the row over the direct values — see evaluate.ts and
 * design-visibility-lookup-array.md §2).
 * 30.2c (additive, same model version): the array action (repeat a selection
 * along the driving linear parameter's direction, count derived from the
 * parameter's effective value — design-visibility-lookup-array.md §3).
 * 30.2e (additive, same model version): the optional `alignment` field on the
 * definition (insert-time placement data, never evaluated —
 * design-visibility-lookup-array.md §4).
 *
 * Pure data + structural validation. No I/O, no editor imports, and nothing here
 * mutates a definition: a definition that fails validation is refused, never repaired.
 * This is JCad's own normalized model; it is NOT a claim of native AutoCAD
 * dynamic-block compatibility.
 */
import { EPS, type Point } from '../geometry';
import { parameterValueIssue, parameterValuesEqual, type DynamicParameterValue } from './instance';

/** Version of the normalized model. A definition with a higher version is not guessed at:
 *  it is retained as opaque data and evaluation refuses (see OpaqueParameter / §1.4 of
 *  the design draft). */
export const DYNAMIC_MODEL_VERSION = 1;

/** A dynamic-block definition: parameters + the actions that consume them. Immutable. */
export interface DynamicBlockDefinition {
  readonly version: typeof DYNAMIC_MODEL_VERSION;
  /** Parameters in authoring order. Ids are unique within the definition and stable:
   *  instance values, actions and serialized data all refer to parameters by id, never
   *  by (renameable, localizable) display name. */
  readonly parameters: readonly DynamicParameter[];
  /** Actions in authoring order. Evaluation order is derived (topological), with
   *  authoring order as the deterministic tie-break. */
  readonly actions: readonly DynamicAction[];
  /**
   * Insert-time alignment behavior. Consumed by the insert tool (30.4),
   * NEVER by the evaluator, and it has no instance value: the rotation it
   * produces at placement is stored as the insert's ordinary `rotation`.
   * Modeled as a definition field rather than a parameter because it
   * passes the inert-member test (design §4.1): old builds may ignore it
   * without evaluating anything incorrectly (serialization consequences
   * in design §6.2). Singular by construction — a definition carries at
   * most one alignment spec, with no id and no duplicate check.
   */
  readonly alignment?: AlignmentSpec;
}

/**
 * Alignment spec (30.2e, design §4.2): how an insert of this block
 * auto-rotates at placement time so its alignment axis meets a picked
 * target entity. Placement-time data only — the evaluator does not read
 * it, and no instance value exists for it (a payload trying to give it
 * one names an 'unknown-parameter', as it is not in `parameters`).
 */
export interface AlignmentSpec {
  /** The alignment grip point, definition space: placement rotation is
   *  understood to pivot the block so this point sits on the target. */
  readonly basePoint: Point;
  /** Alignment axis at authored rotation, definition space — the
   *  direction that must end up perpendicular/tangent to the picked
   *  target entity. Finite and non-zero. */
  readonly direction: Point;
  /** How the axis meets the target, mirroring the native alignment
   *  types: 'perpendicular' = axis normal to the target at the picked
   *  point; 'tangent' = axis along the target at the picked point. */
  readonly mode: 'perpendicular' | 'tangent';
}

export type DynamicParameter = LinearDistanceParameter | AngleParameter | FlipParameter | VisibilityParameter | LookupParameter | OpaqueParameter;

/**
 * A linear distance parameter: a scalar length measured along a fixed direction from a
 * base point in definition space. The only parameter kind 30.1 evaluates; 30.2 adds
 * the angle and flip parameters below (additive union members — design §1.3).
 */
export interface LinearDistanceParameter {
  readonly kind: 'linear-distance';
  /** Stable id, unique in the definition, e.g. 'width'. */
  readonly id: string;
  /** Display name shown in a properties UI, e.g. 'Width'. Not an identity. */
  readonly name: string;
  /** First grip / start of the measured segment, definition space. */
  readonly basePoint: Point;
  /** Unit direction of increase. Must be finite and non-zero; a definition that fails
   *  validation is refused, not repaired (the direction is never normalized in place). */
  readonly direction: Point;
  /** Value of a fresh instance, and the value the base entities are authored at.
   *  Evaluation moves geometry by (effectiveValue - defaultValue), so the authored
   *  geometry is the zero-delta state by construction. */
  readonly defaultValue: number;
  /** How the scalar is constrained. Exactly one mode. */
  readonly constraint: DistanceConstraint;
  /** Grips this parameter exposes (1 = move the end grip only, 2 = both ends). */
  readonly grips: readonly ParameterGrip[];
}

export type DistanceConstraint =
  /** Any finite value >= 0. */
  | { readonly kind: 'unbounded' }
  /** Any finite value in [min, max]; either bound may be omitted, not both. */
  | { readonly kind: 'range'; readonly min?: number; readonly max?: number }
  /** min + k * increment for integer k >= 0, up to max. Checked, never snapped to. */
  | { readonly kind: 'increment'; readonly min: number; readonly max: number; readonly increment: number }
  /** One of an explicit list. Stored sorted ascending with no duplicates; validation
   *  refuses an unsorted/duplicated list rather than fixing it. */
  | { readonly kind: 'list'; readonly values: readonly number[] };

/**
 * An angle parameter (30.2): a rotation angle in **radians** — the codebase's angle
 * convention (entity rotation fields are radians). The base entities are authored at
 * `defaultValue`; evaluation rotates a rotate action's selection by
 * (effectiveValue − defaultValue) about the action's centre. Values are checked,
 * never wrapped or normalized: an angle outside its range constraint is refused,
 * not folded into range.
 */
export interface AngleParameter {
  readonly kind: 'angle';
  /** Stable id, unique in the definition, e.g. 'swing'. */
  readonly id: string;
  /** Display name shown in a properties UI. Not an identity. */
  readonly name: string;
  /** Vertex the angle is measured at, definition space (display/grip anchor). */
  readonly basePoint: Point;
  /** Angle of a fresh instance, radians, and the angle the base entities are
   *  authored at — the zero-delta state by construction, as for distances. */
  readonly defaultValue: number;
  /** How the angle is constrained. Exactly one mode. */
  readonly constraint: AngleConstraint;
  /** Grips this parameter exposes (same shape as the linear parameter's). */
  readonly grips: readonly ParameterGrip[];
}

export type AngleConstraint =
  /** Any finite angle. */
  | { readonly kind: 'unbounded' }
  /** Any finite angle in [min, max] (radians); either bound may be omitted, not both.
   *  Bounds are compared exactly — angles are never wrapped to satisfy them. */
  | { readonly kind: 'range'; readonly min?: number; readonly max?: number };

/**
 * A flip parameter (30.2): a boolean state. The base entities are authored at
 * `defaultValue`; evaluation mirrors a flip action's selection across the action's
 * axis iff the effective state differs from the default (mirroring is an
 * involution, so flipping away from an authored-mirrored default un-mirrors).
 */
export interface FlipParameter {
  readonly kind: 'flip';
  /** Stable id, unique in the definition, e.g. 'handed'. */
  readonly id: string;
  /** Display name shown in a properties UI. Not an identity. */
  readonly name: string;
  /** Anchor of the flip grip on the mirror axis, definition space. Display data;
   *  the mirror axis itself lives on the flip action. */
  readonly basePoint: Point;
  /** State of a fresh instance, and the state the base entities are authored at. */
  readonly defaultValue: boolean;
}

/**
 * A visibility parameter (30.2a): a named-state switch over the definition's own
 * entities. At most ONE visibility parameter per definition (the native rule).
 * The parameter has no actions and drives no action; evaluation applies it as a
 * final filter over the evaluated entities/attributes (design §1.4).
 */
export interface VisibilityParameter {
  readonly kind: 'visibility';
  /** Stable id, unique in the definition. */
  readonly id: string;
  /** Display name, e.g. 'Visibility'. Not an identity. */
  readonly name: string;
  /** Anchor of the visibility grip, definition space. Display data, as on the
   *  flip parameter; evaluation never reads it. */
  readonly basePoint: Point;
  /** Name of the state a fresh instance is in, and the state the authored
   *  geometry is presented in at default. Must be one of `states[].name`. */
  readonly defaultState: string;
  /** The states, in authoring order. At least one. */
  readonly states: readonly VisibilityState[];
}

export interface VisibilityState {
  /**
   * State name. Unlike a parameter's display name this IS an identity:
   * instance values refer to states by name, so renaming a state orphans
   * stored instance values exactly as renaming a parameter id would.
   * Unique within the parameter, non-empty, compared exactly
   * (case-sensitive) — the same identity rules as parameter ids.
   */
  readonly name: string;
  /**
   * Positive visible set: the ids of base entities and the tags of attribute
   * definitions visible in this state, in ONE identity space — the same
   * merged id+tag space selections and validateDefinition already use. An
   * entity/tag not listed is hidden in this state. There is no complement or
   * defaulting rule at evaluation: membership is the whole semantics.
   */
  readonly visible: readonly string[];
}

/**
 * A lookup parameter (30.2b): a named table of rows over OTHER parameters.
 * The instance stores a row choice (or nothing); evaluation applies the
 * chosen row over the direct effective values (design §2.6). At most ONE
 * lookup parameter per definition in this model (a flagged model bound,
 * design §2.5). The lookup parameter drives no action and may not be an
 * action's parameterId.
 */
export interface LookupParameter {
  readonly kind: 'lookup';
  /** Stable id, unique in the definition. */
  readonly id: string;
  /** Display name, e.g. 'Preset'. Not an identity. */
  readonly name: string;
  /** Anchor of the lookup grip, definition space. Display data. */
  readonly basePoint: Point;
  /**
   * Input parameter ids — the table's key columns (native input properties).
   * Keys play NO role in evaluation: the row is chosen by name, not matched
   * by key. Keys exist for the grip menu, for the derived current-row query
   * (`matchingLookupRow` in evaluate.ts), and so a future native table decode
   * has somewhere faithful to land. At least one input; inputs may be
   * distance, angle, flip or visibility parameters — never the lookup
   * itself, never an opaque parameter.
   */
  readonly inputs: readonly string[];
  /** Row applied when the instance stores no choice; null = the lookup is
   *  inactive unless a row is chosen. Must name a row when non-null. */
  readonly defaultRow: string | null;
  /** Rows in authoring order. At least one. */
  readonly rows: readonly LookupRow[];
}

export interface LookupRow {
  /**
   * Row identity. Instance row choices refer to rows by name; names are
   * unique within the parameter and compared exactly. NOTE the native
   * divergence: native rows are nameless and identified by their key values.
   * The name is a JCad modeling choice — stable under table edits that change
   * key values, which a key-referenced choice would not survive.
   */
  readonly name: string;
  /**
   * The row's key: a value for EVERY input parameter (complete by
   * validation). When the row is chosen, these values are applied to the
   * input parameters as part of the row — choosing the "Width 12" row sets
   * Width to 12, as natively.
   */
  readonly key: Readonly<Record<string, DynamicParameterValue>>;
  /**
   * Values this row sets on NON-input parameters. Partial by design:
   * parameters not listed keep their direct effective values. Targets may be
   * distance, angle, flip or visibility parameters — never a lookup
   * parameter, never an opaque parameter, never one of `inputs` (an input's
   * row value lives in `key`; the split is what makes row application
   * unambiguous).
   */
  readonly assignments: Readonly<Record<string, DynamicParameterValue>>;
}

export interface ParameterGrip {
  /** Grip role: 'base' stays with basePoint; 'value' sits at
   *  basePoint + direction * effectiveValue and is what a user drags. */
  readonly role: 'base' | 'value';
  /** The grip moves when the parameter changes (it is inside some action's frame).
   *  False = display-only grip. Recorded explicitly because chaining is derived
   *  from which grips/points an action moves. */
  readonly movesWithValue: boolean;
}

/**
 * A parameter this build does not model — a future kind, or one decoded from a native
 * file whose graph is not yet understood. The payload is retained verbatim so the
 * drawing round-trips; it is never interpreted, and evaluation refuses while one is
 * present.
 */
export interface OpaqueParameter {
  readonly kind: 'opaque-parameter';
  readonly id: string;
  readonly name: string;
  /** The unmodeled kind as read, e.g. 'angle', or a native type name. */
  readonly sourceKind: string;
  /** Canonical payload as read. Opaque to every consumer. */
  readonly payload: string;
}

export type DynamicAction = StretchAction | MoveAction | RotateAction | ScaleAction | FlipAction | ArrayAction | OpaqueAction;

/** Common action fields. */
export interface DynamicActionBase {
  /** Stable id, unique in the definition. */
  readonly id: string;
  /** Display name, e.g. 'Stretch'. Not an identity. */
  readonly name: string;
  /** The parameter that drives this action. */
  readonly parameterId: string;
}

/**
 * AutoCAD stretch semantics, made explicit: a crossing window in definition space;
 * geometry points inside the window move by the parameter delta, points outside do
 * not. An entity whose points are all inside moves whole; an entity crossed by the
 * window is genuinely stretched.
 */
export interface StretchAction extends DynamicActionBase {
  readonly kind: 'stretch';
  /**
   * Crossing window in definition space: an axis-aligned rectangle for 30.1
   * (a polygon frame is a later generalization; the type is a union now so adding
   * 'polygon' does not reshape existing data).
   * Boundary points count as inside, within the evaluator tolerance.
   */
  readonly frame: { readonly kind: 'rectangle'; readonly min: Point; readonly max: Point };
  /** What the action may move. Anything not listed is never moved by this action,
   *  even if it lies inside the frame — selection is explicit, as in AutoCAD. */
  readonly selection: readonly StretchSelection[];
  /** Multiplier on the parameter delta (AutoCAD "distance multiplier"). Default 1. */
  readonly distanceMultiplier?: number;
  /** Rotation applied to the delta vector, radians (AutoCAD "angle offset"). Default 0. */
  readonly angleOffset?: number;
}

export interface StretchSelection {
  /** Id of an entity in the BlockDef's entities (EntityBase.id), or the tag of an
   *  attribute definition (AttributeDef carries no id field in core/entities.ts;
   *  its tag is its identity everywhere else — insert attribute values and
   *  placements are keyed by tag). Referring to a missing id is a validation
   *  error, never a silent skip. */
  readonly entityId: string;
  /**
   * Which movable points of the entity this action governs:
   * - 'frame': every movable point that lies inside the frame moves; points outside stay.
   * - 'points': only the listed movable-point indices are candidates, and they move
   *   only if inside the frame (AutoCAD's explicit point selection on an action).
   */
  readonly points: { readonly kind: 'frame' } | { readonly kind: 'points'; readonly indices: readonly number[] };
}

/**
 * Selection for the whole-entity actions (30.2): the named entity (or attribute
 * definition, by tag) is transformed as a unit by the existing exact transform
 * stack. There is no point-index mode — whole-entity actions never move part of
 * an entity. Referring to a missing id is a validation error, never a silent skip.
 */
export interface WholeSelection {
  readonly entityId: string;
}

/**
 * Move (30.2): translate the selection whole by the driving linear parameter's
 * delta (effective − default) along the parameter direction, exactly as a stretch
 * with every point inside the frame. Driven by a linear-distance parameter.
 */
export interface MoveAction extends DynamicActionBase {
  readonly kind: 'move';
  readonly selection: readonly WholeSelection[];
  /** Multiplier on the parameter delta (AutoCAD "distance multiplier"). Default 1. */
  readonly distanceMultiplier?: number;
  /** Rotation applied to the delta vector, radians (AutoCAD "angle offset"). Default 0. */
  readonly angleOffset?: number;
}

/**
 * Rotate (30.2): rotate the selection whole about `center` by the driving angle
 * parameter's delta (effective − default, radians). Driven by an angle parameter.
 */
export interface RotateAction extends DynamicActionBase {
  readonly kind: 'rotate';
  /** Centre of rotation, definition space. */
  readonly center: Point;
  readonly selection: readonly WholeSelection[];
}

/**
 * Scale (30.2): scale the selection whole, uniformly about `basePoint`, by the
 * factor (effective / default) of the driving linear-distance parameter. Uniform
 * only — there is deliberately no non-uniform scale action: the only core
 * transform for independent X/Y factors is lossy for circles, arcs, ordinate
 * dimensions and text (geometry audit §2.3), so it is not modeled at all.
 * The driving parameter's default must be positive (validation refuses
 * otherwise), and a non-positive effective value refuses at evaluation.
 */
export interface ScaleAction extends DynamicActionBase {
  readonly kind: 'scale';
  /** Base point the scaling is centred on, definition space. */
  readonly basePoint: Point;
  readonly selection: readonly WholeSelection[];
}

/**
 * Flip (30.2): mirror the selection whole across the axis line through `axisA`
 * and `axisB` iff the driving flip parameter's effective state differs from its
 * default. Driven by a flip parameter. Mirroring uses the core reflection
 * (MIRRTEXT = 0: text stays readable; a nested insert toggles its mirror flag —
 * no expansion or geometry rewrite).
 */
export interface FlipAction extends DynamicActionBase {
  readonly kind: 'flip';
  /** First point of the mirror axis line, definition space. */
  readonly axisA: Point;
  /** Second point of the mirror axis line; must differ from `axisA`. */
  readonly axisB: Point;
  readonly selection: readonly WholeSelection[];
}

/**
 * Array (30.2c): repeat the selection as a unit along the driving linear
 * parameter's direction, at a fixed spacing, with the copy count derived
 * from the parameter's effective value (count rule in evaluate.ts — JCad's
 * own rule, design §3.3; the native count rule is undocumented at field
 * level). Driven by a linear-distance parameter. The array is a
 * whole-entity-class action for dependency purposes (design §5): it sources
 * no dependency edges. Deliberately no distanceMultiplier / angleOffset:
 * the parameter's direction and this spacing fully determine the copies.
 */
export interface ArrayAction extends DynamicActionBase {
  readonly kind: 'array';
  /** The entities arrayed together. Every copy contains every selected
   *  entity, offset as a unit. Attribute definitions may NOT be arrayed —
   *  an evaluation refusal ('unsupported-selection'), not a validation
   *  issue, because ids and tags share one identity space at validation
   *  time (design §3.4). */
  readonly selection: readonly WholeSelection[];
  /** Distance between successive copies along the parameter direction,
   *  drawing units. Finite and > 0 (validation). Copy k sits at offset
   *  k * spacing from the source's current working position. */
  readonly spacing: number;
}

/**
 * An action this build does not model. Retained verbatim, never interpreted;
 * evaluation of the whole definition refuses while one is present.
 */
export interface OpaqueAction extends DynamicActionBase {
  readonly kind: 'opaque-action';
  /** The unmodeled kind as read, e.g. 'rotate', 'visibility', or a native type name. */
  readonly sourceKind: string;
  /** Canonical payload as read. Opaque to every consumer. */
  readonly payload: string;
}

export type DefinitionIssueCode =
  | 'duplicate-parameter-id'
  | 'duplicate-action-id'
  | 'unknown-parameter-ref' // action.parameterId not in parameters
  | 'unknown-entity-ref' // selection entityId not in the block's entities/attributes
  | 'invalid-direction' // zero or non-finite direction
  | 'invalid-constraint' // min > max, increment <= 0, empty/unsorted list, non-finite bound/value
  | 'invalid-frame' // frame min > max on either axis, non-finite corner
  | 'invalid-multiplier' // non-finite or <= 0 distance multiplier
  | 'invalid-angle-offset' // non-finite angle offset
  | 'invalid-selection-index' // selection point index negative or non-integer
  | 'invalid-base-point' // non-finite base point on an angle/flip/visibility/lookup parameter, or on the alignment spec
  | 'invalid-action-geometry' // non-finite rotate centre / scale base point, degenerate flip axis
  | 'invalid-scale-base' // scale action whose driving parameter default is <= 0 (factor = value / default)
  | 'duplicate-visibility-parameter' // more than one visibility parameter in the definition
  | 'duplicate-visibility-state' // two states of one visibility parameter share a name
  | 'invalid-visibility-states' // no states, an empty state name, defaultState not a state, a duplicated visible entry
  | 'empty-visibility-state' // a state's visible list is empty (model rule, design §1.3 — not a native claim)
  | 'duplicate-lookup-parameter' // more than one lookup parameter in the definition (model bound, design §2.5)
  | 'invalid-lookup-table' // inputs or rows empty, or defaultRow names no row
  | 'invalid-lookup-input' // an input id is unknown, the lookup itself, an opaque parameter, or duplicated
  | 'duplicate-lookup-row' // two rows of one lookup parameter share a name
  | 'duplicate-lookup-key' // two rows have identical key tuples (indistinguishable to matchingLookupRow)
  | 'invalid-lookup-row' // key does not cover exactly the inputs; an assignment names an input / the lookup / an opaque or unknown parameter; or a key/assignment value is the wrong kind for, or violates, its target parameter
  | 'reserved-entity-id' // a base entity id or attribute tag contains '#' while the definition has an array action ('#' is reserved for array copy ids, design §3.6)
  | 'parameter-kind-mismatch'; // e.g. a rotate action driven by a linear-distance parameter

export interface DefinitionIssue {
  readonly code: DefinitionIssueCode;
  readonly message: string;
  readonly parameterId?: string;
  readonly actionId?: string;
}

const isFinitePoint = (p: Point): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

function constraintIssue(param: LinearDistanceParameter): DefinitionIssue | undefined {
  const bad = (message: string): DefinitionIssue => ({ code: 'invalid-constraint', message, parameterId: param.id });
  if (!Number.isFinite(param.defaultValue)) return bad(`Parameter '${param.id}' has a non-finite default value.`);
  const c = param.constraint;
  switch (c.kind) {
    case 'unbounded':
      return undefined;
    case 'range': {
      if (c.min === undefined && c.max === undefined) return bad(`Parameter '${param.id}' range constraint has neither bound.`);
      if (c.min !== undefined && !Number.isFinite(c.min)) return bad(`Parameter '${param.id}' range min is not finite.`);
      if (c.max !== undefined && !Number.isFinite(c.max)) return bad(`Parameter '${param.id}' range max is not finite.`);
      if (c.min !== undefined && c.max !== undefined && c.min > c.max) return bad(`Parameter '${param.id}' range min exceeds max.`);
      return undefined;
    }
    case 'increment': {
      if (!Number.isFinite(c.min) || !Number.isFinite(c.max) || !Number.isFinite(c.increment)) {
        return bad(`Parameter '${param.id}' increment constraint has a non-finite bound or increment.`);
      }
      if (c.increment <= 0) return bad(`Parameter '${param.id}' increment must be positive.`);
      if (c.min > c.max) return bad(`Parameter '${param.id}' increment min exceeds max.`);
      return undefined;
    }
    case 'list': {
      if (c.values.length === 0) return bad(`Parameter '${param.id}' list constraint is empty.`);
      for (let i = 0; i < c.values.length; i += 1) {
        const v = c.values[i]!;
        if (!Number.isFinite(v)) return bad(`Parameter '${param.id}' list constraint has a non-finite value.`);
        if (i > 0 && v <= c.values[i - 1]!) return bad(`Parameter '${param.id}' list constraint is not sorted ascending without duplicates.`);
      }
      return undefined;
    }
  }
}

function angleConstraintIssue(param: AngleParameter): DefinitionIssue | undefined {
  const bad = (message: string): DefinitionIssue => ({ code: 'invalid-constraint', message, parameterId: param.id });
  if (!Number.isFinite(param.defaultValue)) return bad(`Parameter '${param.id}' has a non-finite default angle.`);
  const c = param.constraint;
  if (c.kind === 'unbounded') return undefined;
  if (c.min === undefined && c.max === undefined) return bad(`Parameter '${param.id}' range constraint has neither bound.`);
  if (c.min !== undefined && !Number.isFinite(c.min)) return bad(`Parameter '${param.id}' range min is not finite.`);
  if (c.max !== undefined && !Number.isFinite(c.max)) return bad(`Parameter '${param.id}' range max is not finite.`);
  if (c.min !== undefined && c.max !== undefined && c.min > c.max) return bad(`Parameter '${param.id}' range min exceeds max.`);
  return undefined;
}

/** The parameter kind each modeled action kind must be driven by. An action
 *  driven by an opaque parameter is not checked here: evaluation refuses opaque
 *  parameters before kinds matter. */
const ACTION_PARAMETER_KIND: Readonly<Record<string, DynamicParameter['kind']>> = {
  stretch: 'linear-distance',
  move: 'linear-distance',
  rotate: 'angle',
  scale: 'linear-distance',
  flip: 'flip',
  array: 'linear-distance',
};

/**
 * Structural check of a definition against the ids of the block's base entities
 * (attribute definitions are identified by tag — see StretchSelection). Reports
 * every issue found, in deterministic order (parameters in authoring order, then
 * actions in authoring order). An empty result means the definition is structurally
 * sound; it does not mean every selected entity is stretchable (that depends on
 * entity types and is the evaluator's refusal, not a validation issue).
 */
export function validateDefinition(
  definition: DynamicBlockDefinition,
  baseEntityIds: ReadonlySet<string>,
): readonly DefinitionIssue[] {
  const issues: DefinitionIssue[] = [];

  // Complete parameter map (first occurrence wins), built up front: a lookup
  // parameter's inputs may name parameters authored AFTER it in the list,
  // which the incremental map below cannot see yet.
  const allParametersById = new Map<string, DynamicParameter>();
  for (const param of definition.parameters) {
    if (!allParametersById.has(param.id)) allParametersById.set(param.id, param);
  }

  const parameterIds = new Set<string>();
  const parameterById = new Map<string, DynamicParameter>();
  let visibilitySeen = false;
  let lookupSeen = false;
  for (const param of definition.parameters) {
    if (parameterIds.has(param.id)) {
      issues.push({ code: 'duplicate-parameter-id', message: `Duplicate parameter id '${param.id}'.`, parameterId: param.id });
    } else {
      parameterIds.add(param.id);
      parameterById.set(param.id, param);
    }
    if (param.kind === 'linear-distance') {
      if (!isFinitePoint(param.basePoint)) {
        issues.push({ code: 'invalid-direction', message: `Parameter '${param.id}' has a non-finite base point.`, parameterId: param.id });
      }
      const d = param.direction;
      if (!isFinitePoint(d) || Math.hypot(d.x, d.y) <= EPS) {
        issues.push({ code: 'invalid-direction', message: `Parameter '${param.id}' direction is zero or non-finite.`, parameterId: param.id });
      }
      const issue = constraintIssue(param);
      if (issue) issues.push(issue);
    } else if (param.kind === 'angle') {
      if (!isFinitePoint(param.basePoint)) {
        issues.push({ code: 'invalid-base-point', message: `Parameter '${param.id}' has a non-finite base point.`, parameterId: param.id });
      }
      const issue = angleConstraintIssue(param);
      if (issue) issues.push(issue);
    } else if (param.kind === 'flip') {
      if (!isFinitePoint(param.basePoint)) {
        issues.push({ code: 'invalid-base-point', message: `Parameter '${param.id}' has a non-finite base point.`, parameterId: param.id });
      }
      // Via a local so the typeof check guards untyped (file-sourced) data
      // without narrowing the typed field to never.
      const flipDefault: unknown = param.defaultValue;
      if (typeof flipDefault !== 'boolean') {
        issues.push({ code: 'invalid-constraint', message: `Parameter '${param.id}' flip default must be a boolean.`, parameterId: param.id });
      }
    } else if (param.kind === 'visibility') {
      // At most one visibility parameter per definition (design §1.2).
      if (visibilitySeen) {
        issues.push({
          code: 'duplicate-visibility-parameter',
          message: `Parameter '${param.id}' is a second visibility parameter; a definition has at most one.`,
          parameterId: param.id,
        });
      }
      visibilitySeen = true;
      if (!isFinitePoint(param.basePoint)) {
        issues.push({ code: 'invalid-base-point', message: `Parameter '${param.id}' has a non-finite base point.`, parameterId: param.id });
      }
      if (param.states.length === 0) {
        issues.push({ code: 'invalid-visibility-states', message: `Parameter '${param.id}' has no visibility states.`, parameterId: param.id });
      }
      const stateNames = new Set<string>();
      for (const state of param.states) {
        if (state.name.length === 0) {
          issues.push({ code: 'invalid-visibility-states', message: `Parameter '${param.id}' has a state with an empty name.`, parameterId: param.id });
        } else if (stateNames.has(state.name)) {
          issues.push({
            code: 'duplicate-visibility-state',
            message: `Parameter '${param.id}' has two states named '${state.name}'; state names are identities and must be unique.`,
            parameterId: param.id,
          });
        } else {
          stateNames.add(state.name);
        }
        if (state.visible.length === 0) {
          issues.push({
            code: 'empty-visibility-state',
            message: `State '${state.name}' of parameter '${param.id}' shows nothing; an empty visible set is refused as an authoring error (design §1.3).`,
            parameterId: param.id,
          });
        }
        const visibleSeen = new Set<string>();
        for (const ref of state.visible) {
          if (visibleSeen.has(ref)) {
            issues.push({
              code: 'invalid-visibility-states',
              message: `State '${state.name}' of parameter '${param.id}' lists '${ref}' twice.`,
              parameterId: param.id,
            });
          } else {
            visibleSeen.add(ref);
          }
          if (!baseEntityIds.has(ref)) {
            issues.push({
              code: 'unknown-entity-ref',
              message: `State '${state.name}' of parameter '${param.id}' lists unknown entity or attribute '${ref}'.`,
              parameterId: param.id,
            });
          }
        }
      }
      if (param.states.length > 0 && !stateNames.has(param.defaultState)) {
        issues.push({
          code: 'invalid-visibility-states',
          message: `Parameter '${param.id}' default state '${param.defaultState}' is not one of its states.`,
          parameterId: param.id,
        });
      }
    } else if (param.kind === 'lookup') {
      // At most one lookup parameter per definition (design §2.5, model bound).
      if (lookupSeen) {
        issues.push({
          code: 'duplicate-lookup-parameter',
          message: `Parameter '${param.id}' is a second lookup parameter; a definition has at most one.`,
          parameterId: param.id,
        });
      }
      lookupSeen = true;
      if (!isFinitePoint(param.basePoint)) {
        issues.push({ code: 'invalid-base-point', message: `Parameter '${param.id}' has a non-finite base point.`, parameterId: param.id });
      }
      if (param.inputs.length === 0) {
        issues.push({ code: 'invalid-lookup-table', message: `Lookup parameter '${param.id}' has no input parameters.`, parameterId: param.id });
      }
      if (param.rows.length === 0) {
        issues.push({ code: 'invalid-lookup-table', message: `Lookup parameter '${param.id}' has no rows.`, parameterId: param.id });
      }
      const inputIds = new Set<string>();
      for (const inputId of param.inputs) {
        if (inputIds.has(inputId)) {
          issues.push({
            code: 'invalid-lookup-input',
            message: `Lookup parameter '${param.id}' lists input '${inputId}' twice.`,
            parameterId: param.id,
          });
          continue;
        }
        inputIds.add(inputId);
        const target = allParametersById.get(inputId);
        if (!target || inputId === param.id || target.kind === 'lookup' || target.kind === 'opaque-parameter') {
          issues.push({
            code: 'invalid-lookup-input',
            message: `Lookup parameter '${param.id}' input '${inputId}' is unknown, the lookup itself, another lookup, or an opaque parameter; inputs must be distance, angle, flip or visibility parameters.`,
            parameterId: param.id,
          });
        }
      }
      const rowNames = new Set<string>();
      for (const row of param.rows) {
        if (rowNames.has(row.name)) {
          issues.push({
            code: 'duplicate-lookup-row',
            message: `Lookup parameter '${param.id}' has two rows named '${row.name}'; row names are identities and must be unique.`,
            parameterId: param.id,
          });
        } else {
          rowNames.add(row.name);
        }
        // The key covers exactly the inputs (design §2.5).
        for (const inputId of param.inputs) {
          if (!Object.hasOwn(row.key, inputId)) {
            issues.push({
              code: 'invalid-lookup-row',
              message: `Row '${row.name}' of lookup parameter '${param.id}' has no key value for input '${inputId}'.`,
              parameterId: param.id,
            });
          }
        }
        for (const keyId of Object.keys(row.key)) {
          if (!inputIds.has(keyId)) {
            issues.push({
              code: 'invalid-lookup-row',
              message: `Row '${row.name}' of lookup parameter '${param.id}' has a key value for '${keyId}', which is not one of its inputs.`,
              parameterId: param.id,
            });
          }
        }
        // Assignments target non-input modeled parameters only (design §2.5).
        for (const targetId of Object.keys(row.assignments)) {
          const target = allParametersById.get(targetId);
          if (inputIds.has(targetId)) {
            issues.push({
              code: 'invalid-lookup-row',
              message: `Row '${row.name}' of lookup parameter '${param.id}' assigns input '${targetId}'; an input's row value lives in the row's key, not its assignments.`,
              parameterId: param.id,
            });
          } else if (!target || targetId === param.id || target.kind === 'lookup' || target.kind === 'opaque-parameter') {
            issues.push({
              code: 'invalid-lookup-row',
              message: `Row '${row.name}' of lookup parameter '${param.id}' assigns '${targetId}', which is unknown, the lookup itself, another lookup, or an opaque parameter.`,
              parameterId: param.id,
            });
          }
        }
        // Every value a row can inject is validated against its target
        // parameter NOW (design §2.5, load-bearing): the evaluation-time
        // override can therefore never produce an invalid effective value,
        // and the evaluator does not re-run instance validation over the
        // overridden map. Only structurally sound entries are value-checked;
        // the broken ones were reported above.
        const checkRowValue = (targetId: string, value: DynamicParameterValue): void => {
          const target = allParametersById.get(targetId);
          if (!target || target.kind === 'lookup' || target.kind === 'opaque-parameter') return;
          const issue = parameterValueIssue(target, value);
          if (issue) {
            issues.push({
              code: 'invalid-lookup-row',
              message: `Row '${row.name}' of lookup parameter '${param.id}' sets '${targetId}' to an invalid value: ${issue.message}`,
              parameterId: param.id,
            });
          }
        };
        for (const inputId of param.inputs) {
          if (Object.hasOwn(row.key, inputId)) checkRowValue(inputId, row.key[inputId]!);
        }
        for (const [targetId, value] of Object.entries(row.assignments)) {
          const target = allParametersById.get(targetId);
          if (!inputIds.has(targetId) && target && target.kind !== 'lookup' && target.kind !== 'opaque-parameter') {
            checkRowValue(targetId, value);
          }
        }
      }
      // Two rows with identical key tuples are indistinguishable to the
      // derived current-row query (matchingLookupRow) — duplicates (§2.5).
      for (let i = 0; i < param.rows.length; i += 1) {
        for (let j = i + 1; j < param.rows.length; j += 1) {
          const a = param.rows[i]!;
          const b = param.rows[j]!;
          const sameKey = param.inputs.every((inputId) => {
            const av = a.key[inputId];
            const bv = b.key[inputId];
            return av !== undefined && bv !== undefined && parameterValuesEqual(av, bv);
          });
          if (sameKey) {
            issues.push({
              code: 'duplicate-lookup-key',
              message: `Rows '${a.name}' and '${b.name}' of lookup parameter '${param.id}' have identical key values for every input.`,
              parameterId: param.id,
            });
          }
        }
      }
      if (param.defaultRow !== null && !rowNames.has(param.defaultRow)) {
        issues.push({
          code: 'invalid-lookup-table',
          message: `Lookup parameter '${param.id}' default row '${param.defaultRow}' is not one of its rows.`,
          parameterId: param.id,
        });
      }
    }
  }

  // The alignment spec (design §4.2): inert placement data, validated for
  // geometry only. There is no instance value for it and the evaluator
  // never reads it; existing codes, existing meanings.
  if (definition.alignment !== undefined) {
    if (!isFinitePoint(definition.alignment.basePoint)) {
      issues.push({ code: 'invalid-base-point', message: 'Alignment base point is not finite.' });
    }
    const dir = definition.alignment.direction;
    if (!isFinitePoint(dir) || Math.hypot(dir.x, dir.y) <= EPS) {
      issues.push({ code: 'invalid-direction', message: 'Alignment direction is zero or non-finite.' });
    }
  }

  const checkWholeSelection = (action: DynamicActionBase, selection: readonly WholeSelection[]): void => {
    for (const sel of selection) {
      if (!baseEntityIds.has(sel.entityId)) {
        issues.push({
          code: 'unknown-entity-ref',
          message: `Action '${action.id}' selects unknown entity '${sel.entityId}'.`,
          actionId: action.id,
        });
      }
    }
  };
  const checkMultiplierOffset = (action: MoveAction | StretchAction): void => {
    if (action.distanceMultiplier !== undefined && (!Number.isFinite(action.distanceMultiplier) || action.distanceMultiplier <= 0)) {
      issues.push({ code: 'invalid-multiplier', message: `Action '${action.id}' distance multiplier must be finite and positive.`, actionId: action.id });
    }
    if (action.angleOffset !== undefined && !Number.isFinite(action.angleOffset)) {
      issues.push({ code: 'invalid-angle-offset', message: `Action '${action.id}' angle offset is not finite.`, actionId: action.id });
    }
  };

  const actionIds = new Set<string>();
  for (const action of definition.actions) {
    if (actionIds.has(action.id)) {
      issues.push({ code: 'duplicate-action-id', message: `Duplicate action id '${action.id}'.`, actionId: action.id });
    } else {
      actionIds.add(action.id);
    }
    if (!parameterIds.has(action.parameterId)) {
      issues.push({
        code: 'unknown-parameter-ref',
        message: `Action '${action.id}' refers to unknown parameter '${action.parameterId}'.`,
        actionId: action.id,
        parameterId: action.parameterId,
      });
    }
    if (action.kind === 'opaque-action') continue;
    const param = parameterById.get(action.parameterId);
    const expectedKind = ACTION_PARAMETER_KIND[action.kind];
    if (param && param.kind !== 'opaque-parameter' && expectedKind !== undefined && param.kind !== expectedKind) {
      issues.push({
        code: 'parameter-kind-mismatch',
        message: `Action '${action.id}' (${action.kind}) must be driven by a '${expectedKind}' parameter, not '${param.kind}' parameter '${param.id}'.`,
        actionId: action.id,
        parameterId: param.id,
      });
    }
    switch (action.kind) {
      case 'stretch': {
        const { frame } = action;
        if (!isFinitePoint(frame.min) || !isFinitePoint(frame.max)) {
          issues.push({ code: 'invalid-frame', message: `Action '${action.id}' frame has a non-finite corner.`, actionId: action.id });
        } else if (frame.min.x > frame.max.x || frame.min.y > frame.max.y) {
          issues.push({ code: 'invalid-frame', message: `Action '${action.id}' frame min exceeds max.`, actionId: action.id });
        }
        checkMultiplierOffset(action);
        for (const sel of action.selection) {
          if (!baseEntityIds.has(sel.entityId)) {
            issues.push({
              code: 'unknown-entity-ref',
              message: `Action '${action.id}' selects unknown entity '${sel.entityId}'.`,
              actionId: action.id,
            });
          }
          if (sel.points.kind === 'points') {
            for (const index of sel.points.indices) {
              if (!Number.isInteger(index) || index < 0) {
                issues.push({
                  code: 'invalid-selection-index',
                  message: `Action '${action.id}' selection for '${sel.entityId}' has invalid point index ${index}.`,
                  actionId: action.id,
                });
              }
            }
          }
        }
        break;
      }
      case 'move':
        checkMultiplierOffset(action);
        checkWholeSelection(action, action.selection);
        break;
      case 'rotate':
        if (!isFinitePoint(action.center)) {
          issues.push({ code: 'invalid-action-geometry', message: `Action '${action.id}' rotation centre is not finite.`, actionId: action.id });
        }
        checkWholeSelection(action, action.selection);
        break;
      case 'scale':
        if (!isFinitePoint(action.basePoint)) {
          issues.push({ code: 'invalid-action-geometry', message: `Action '${action.id}' scale base point is not finite.`, actionId: action.id });
        }
        if (param?.kind === 'linear-distance' && param.defaultValue <= 0) {
          issues.push({
            code: 'invalid-scale-base',
            message: `Scale action '${action.id}' divides by parameter '${param.id}' default ${param.defaultValue}; the default must be positive.`,
            actionId: action.id,
            parameterId: param.id,
          });
        }
        checkWholeSelection(action, action.selection);
        break;
      case 'flip':
        if (!isFinitePoint(action.axisA) || !isFinitePoint(action.axisB)) {
          issues.push({ code: 'invalid-action-geometry', message: `Action '${action.id}' flip axis has a non-finite point.`, actionId: action.id });
        } else if (Math.hypot(action.axisB.x - action.axisA.x, action.axisB.y - action.axisA.y) <= EPS) {
          issues.push({ code: 'invalid-action-geometry', message: `Action '${action.id}' flip axis is degenerate (its two points coincide).`, actionId: action.id });
        }
        checkWholeSelection(action, action.selection);
        break;
      case 'array':
        if (!Number.isFinite(action.spacing) || action.spacing <= 0) {
          issues.push({ code: 'invalid-action-geometry', message: `Array action '${action.id}' spacing must be finite and positive.`, actionId: action.id });
        }
        checkWholeSelection(action, action.selection);
        break;
    }
  }

  // '#' is reserved for array copy ids (`${source}#${action}#${k}`, design
  // §3.4): in a definition that has an array action, no base entity id or
  // attribute tag may contain one, so a derived copy id can never collide
  // with a base id. Without an array action the character is unrestricted.
  const arrayAction = definition.actions.find((a) => a.kind === 'array');
  if (arrayAction) {
    const offenders = [...baseEntityIds].filter((id) => id.includes('#')).sort();
    for (const id of offenders) {
      issues.push({
        code: 'reserved-entity-id',
        message: `Id '${id}' contains '#', which is reserved for array copy ids while the definition has an array action.`,
        actionId: arrayAction.id,
      });
    }
  }
  return issues;
}
