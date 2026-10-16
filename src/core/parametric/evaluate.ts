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
 */
import { EPS, add, dot, normalize, rotate, scale as scalePoint, sub, type Point } from '../geometry';
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
  type DefinitionIssue,
  type DynamicBlockDefinition,
  type FlipAction,
  type FlipParameter,
  type LinearDistanceParameter,
  type MoveAction,
  type RotateAction,
  type ScaleAction,
  type StretchAction,
} from './definitions';
import { validateInstanceValues, type DynamicParameterValue, type DynamicInstanceState, type InstanceIssue } from './instance';

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
  /** Max entities in the result (base + any produced). 30.1 actions produce none,
   *  so this binds at baseEntities.length; it exists now so 30.2 array actions
   *  inherit the bound instead of adding a second limits shape. */
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
       *  returned by identity (same object). */
      readonly entities: readonly Entity[];
      /** Attribute definitions whose placement point moved; untouched ones are
       *  returned by identity. Attribute VALUES live on the insert and are never
       *  an evaluation output. */
      readonly attributes: readonly AttributeDef[];
      /** Action ids in the order they were applied (topological). */
      readonly appliedActions: readonly string[];
      readonly diagnostics: readonly EvaluationDiagnostic[];
    }
  | { readonly ok: false; readonly refusal: EvaluationRefusal };

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
  | 'degenerate-transform' // a computed whole-entity transform is degenerate (scale factor <= 0 / non-finite)
  | 'unstretchable-entity'; // selection names an entity type with no movable points

export interface EvaluationDiagnostic {
  readonly severity: 'info' | 'warning';
  readonly code: 'value-defaulted' | 'frame-missed-selection' | 'zero-delta' | 'action-no-op';
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

const inFrame = (p: Point, frame: StretchAction['frame']): boolean =>
  p.x >= frame.min.x - EVALUATION_TOLERANCE &&
  p.x <= frame.max.x + EVALUATION_TOLERANCE &&
  p.y >= frame.min.y - EVALUATION_TOLERANCE &&
  p.y <= frame.max.y + EVALUATION_TOLERANCE;

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
type ModeledAction = StretchAction | MoveAction | RotateAction | ScaleAction | FlipAction;

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
        case 'opaque':
          return `${id}=o:${value.payload}`;
      }
    });
  return `dyn${definition.version}|${parts.join(';')}`;
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

  // 2. Instance validation.
  const validation = validateInstanceValues(definition, instance);
  if (!validation.ok) {
    return refuse({
      code: 'invalid-instance',
      message: `Invalid dynamic instance values: ${validation.issues.map((i) => i.message).join(' ')}`,
      instanceIssues: validation.issues,
    });
  }
  const effective = validation.effective;

  // 3. Opaque members: retained, never interpreted; evaluation refuses whole.
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

  const parametersById = new Map<string, ModeledParameter>();
  for (const param of definition.parameters) {
    if (param.kind !== 'opaque-parameter') parametersById.set(param.id, param);
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

  // 4. Dependency graph + topological order (design §3.2).
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
  //    topological tie-break. Deriving dependency edges from whole-action
  //    grip movement is later 30.2 chaining work (spec §3.2, final bullet).
  const gripPointOf = (param: LinearDistanceParameter): Point | undefined => {
    const grip = param.grips.find((gr) => gr.role === 'value' && gr.movesWithValue);
    if (!grip) return undefined;
    const value = effective[param.id];
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
      if (!depends) {
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

  // 5. Apply actions in topological order to working copies.
  const outEntities: Entity[] = [...baseEntities];
  const outAttributes: AttributeDef[] = [...baseAttributes];
  const diagnostics: EvaluationDiagnostic[] = [];
  const appliedActions: string[] = [];
  const defaultedReported = new Set<string>();

  /** Apply one stretch action to the working copies. Returns a refusal, or
   *  undefined on success (including a zero-delta no-op). */
  const applyStretchAction = (action: StretchAction, param: LinearDistanceParameter): EvaluationResult | undefined => {
    const valueEntry = effective[param.id]!;
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
      const target: Target =
        baseTarget.kind === 'entity'
          ? { kind: 'entity', index: baseTarget.index, entity: outEntities[baseTarget.index]! }
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
        outEntities[target.index] = withMovedPoints(target.entity, moves);
      } else {
        outAttributes[target.index] = { ...target.attribute, position: moves.get(0) ?? target.attribute.position };
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
    switch (action.kind) {
      case 'move': {
        const p = param as LinearDistanceParameter;
        const entry = effective[p.id]!;
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
        }
        break;
      }
      case 'rotate': {
        const p = param as AngleParameter;
        const entry = effective[p.id]!;
        const value = entry.kind === 'angle' ? entry.value : p.defaultValue;
        const deltaAngle = value - p.defaultValue;
        if (!Number.isFinite(deltaAngle)) {
          return degenerate(`Rotate action '${action.id}' computed a non-finite angle.`);
        }
        if (Math.abs(deltaAngle) > EVALUATION_TOLERANCE) {
          const { center } = action;
          transformEntity = (entity) => rotateEntity(entity, center, deltaAngle);
          transformPoint = (point) => rotate(point, deltaAngle, center);
        }
        break;
      }
      case 'scale': {
        const p = param as LinearDistanceParameter;
        const entry = effective[p.id]!;
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
        }
        break;
      }
      case 'flip': {
        const p = param as FlipParameter;
        const entry = effective[p.id]!;
        const value = entry.kind === 'flip' ? entry.value : p.defaultValue;
        if (value !== p.defaultValue) {
          const { axisA, axisB } = action;
          transformEntity = (entity) => mirrorEntityAcross(entity, axisA, axisB);
          transformPoint = (point) => reflectPoint(point, axisA, axisB);
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
      const target: Target =
        baseTarget.kind === 'entity'
          ? { kind: 'entity', index: baseTarget.index, entity: outEntities[baseTarget.index]! }
          : { kind: 'attribute', index: baseTarget.index, attribute: outAttributes[baseTarget.index]! };
      const points = movablePoints(target);
      if (!charge(1 + (points ? points.length : 1))) return workRefusal();
      if (target.kind === 'entity') {
        outEntities[target.index] = transformEntity(target.entity);
      } else {
        outAttributes[target.index] = { ...target.attribute, position: transformPoint(target.attribute.position) };
      }
    }
    return undefined;
  };

  for (const actionIndex of order) {
    const action = actions[actionIndex]!;
    const param = parametersById.get(action.parameterId)!;
    if (instance?.values[param.id] === undefined && !defaultedReported.has(param.id)) {
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
        : applyWholeAction(action);
    if (refusal) return refusal;
    appliedActions.push(action.id);
  }

  return { ok: true, entities: outEntities, attributes: outAttributes, appliedActions, diagnostics };
}
