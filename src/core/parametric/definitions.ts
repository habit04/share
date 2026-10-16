/**
 * Priority 30.1 — dynamic-block definitions (authored normalized model).
 *
 * Pure data + structural validation. No I/O, no editor imports, and nothing here
 * mutates a definition: a definition that fails validation is refused, never repaired.
 * This is JCad's own normalized model; it is NOT a claim of native AutoCAD
 * dynamic-block compatibility.
 */
import { EPS, type Point } from '../geometry';

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
}

export type DynamicParameter = LinearDistanceParameter | OpaqueParameter;

/**
 * A linear distance parameter: a scalar length measured along a fixed direction from a
 * base point in definition space. This is the only parameter kind 30.1 evaluates.
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

export type DynamicAction = StretchAction | OpaqueAction;

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
  | 'invalid-selection-index'; // selection point index negative or non-integer

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

  const parameterIds = new Set<string>();
  for (const param of definition.parameters) {
    if (parameterIds.has(param.id)) {
      issues.push({ code: 'duplicate-parameter-id', message: `Duplicate parameter id '${param.id}'.`, parameterId: param.id });
    } else {
      parameterIds.add(param.id);
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
    }
  }

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
    if (action.kind !== 'stretch') continue;
    const { frame } = action;
    if (!isFinitePoint(frame.min) || !isFinitePoint(frame.max)) {
      issues.push({ code: 'invalid-frame', message: `Action '${action.id}' frame has a non-finite corner.`, actionId: action.id });
    } else if (frame.min.x > frame.max.x || frame.min.y > frame.max.y) {
      issues.push({ code: 'invalid-frame', message: `Action '${action.id}' frame min exceeds max.`, actionId: action.id });
    }
    if (action.distanceMultiplier !== undefined && (!Number.isFinite(action.distanceMultiplier) || action.distanceMultiplier <= 0)) {
      issues.push({ code: 'invalid-multiplier', message: `Action '${action.id}' distance multiplier must be finite and positive.`, actionId: action.id });
    }
    if (action.angleOffset !== undefined && !Number.isFinite(action.angleOffset)) {
      issues.push({ code: 'invalid-angle-offset', message: `Action '${action.id}' angle offset is not finite.`, actionId: action.id });
    }
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
  }
  return issues;
}
