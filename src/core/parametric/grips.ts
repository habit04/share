/**
 * Priority 30.4 slice B — dynamic-block grips: which grips a dynamic insert
 * exposes, where they sit, and what parameter edit a drag amounts to.
 *
 * Grip indices are POSITIONAL (entities.ts gripPoints): index 0 of an insert
 * is always its position grip. Dynamic parameter grips are APPENDED after it,
 * in definition parameter order, so existing indices never shift. Only
 * parameters with a positional value have a grip in this slice:
 *
 * - linear-distance: the 'value' grip at basePoint + direction * effective
 *   value (definition space), when the parameter declares a 'value' grip.
 * - angle: the 'value' grip on the parameter's arc at its base point — at
 *   ANGLE_GRIP_RADIUS along the effective angle — when declared.
 *
 * Flip, visibility and lookup parameters expose NO positional grip here:
 * their state is chosen from a list (the Properties palette's Parameters
 * section or DYNSET), not by dragging a point. A state grip is a menu, not
 * a drag, and inventing a drag target for one would misrepresent the model.
 *
 * A drag does not mutate anything itself: `dynamicGripEdit` inverts the
 * insert transform, projects the dragged point onto the parameter, and
 * routes the resulting value through `setDynamicParameter` (apply.ts) —
 * the SAME validation/refusal path as every other parameter edit. The
 * caller commits an accepted result through exactly one transact; a
 * refused result carries the unchanged state object, so a refused drag
 * leaves the entity identical (no partial drag commit).
 */
import type { BlockDef, InsertEntity } from '../entities';
import type { DrawingState } from '../document';
import * as g from '../geometry';
import type { Point } from '../geometry';
import type { AngleParameter, LinearDistanceParameter } from './definitions';
import { resolvedEffectiveValues } from './evaluate';
import { entityInActiveSpace, setDynamicParameter, type SetDynamicParameterProblem } from './apply';

/**
 * Result of a grip drag: exactly a `setDynamicParameter` result, plus
 * grip-local problem codes — 'degenerate-transform' when the insert's own
 * transform has no inverse (a zero scale axis), so no value can be measured
 * from the dragged point at all, and 'grip-not-resolvable' when an index
 * beyond the position grip on a DYNAMIC insert does not resolve to a
 * parameter grip (resolveDynamicGripDrag, review R08).
 */
export interface DynamicGripEditResult {
  readonly state: DrawingState;
  readonly problem?: SetDynamicParameterProblem | 'degenerate-transform' | 'grip-not-resolvable';
  readonly message?: string;
}

/**
 * Display radius of an angle parameter's value grip, in definition units.
 * The model carries no arc radius for a parameter, so the grip sits one
 * unit from the vertex along the effective angle; the radius is display
 * only — a drag measures the dragged point's angle about the base point,
 * independent of where the grip was drawn.
 */
export const ANGLE_GRIP_RADIUS = 1;

/** One draggable dynamic grip, in definition space. */
export interface DynamicGrip {
  readonly parameterId: string;
  readonly kind: 'linear-distance' | 'angle';
  /** Grip anchor in DEFINITION space (before the insert transform). */
  readonly localPoint: Point;
}

type GripParameter = LinearDistanceParameter | AngleParameter;

/**
 * The dynamic grips of an insert, in the order they are appended after the
 * position grip (definition parameter order). Empty when the block is not
 * dynamic, when either side's data is retained unmodeled, or when the
 * stored values do not validate (no honest current value to anchor to).
 */
export function dynamicGrips(ins: InsertEntity, block: BlockDef): readonly DynamicGrip[] {
  const definition = block.dynamic;
  if (!definition || block.dynamicRetained !== undefined || ins.dynamicRetained !== undefined) return [];
  // Grip positions anchor at the lookup-RESOLVED values (review R11) —
  // the same values geometry is evaluated from — not the raw stored map:
  // under an active lookup row a covered parameter's grip sits at the
  // row's value, where the evaluated geometry actually is.
  const resolution = resolvedEffectiveValues(definition, ins.dynamic, ins.block);
  if (!resolution.ok) return [];
  const grips: DynamicGrip[] = [];
  for (const param of definition.parameters) {
    // flip / visibility / lookup parameters carry no `grips` list and get no
    // positional grip in this slice (see header); opaque parameters neither.
    if (param.kind !== 'linear-distance' && param.kind !== 'angle') continue;
    if (!param.grips.some((grip) => grip.role === 'value')) continue;
    if (param.kind === 'linear-distance') {
      const eff = resolution.resolved[param.id];
      const value = eff?.kind === 'distance' ? eff.value : param.defaultValue;
      const unit = unitDirection(param);
      grips.push({ parameterId: param.id, kind: param.kind, localPoint: g.add(param.basePoint, g.scale(unit, value)) });
    } else if (param.kind === 'angle') {
      const eff = resolution.resolved[param.id];
      const value = eff?.kind === 'angle' ? eff.value : param.defaultValue;
      grips.push({ parameterId: param.id, kind: param.kind, localPoint: g.polar(param.basePoint, value, ANGLE_GRIP_RADIUS) });
    }
    // flip / visibility / lookup: no positional grip in this slice (see header).
  }
  return grips;
}

function unitDirection(param: LinearDistanceParameter): Point {
  const len = Math.hypot(param.direction.x, param.direction.y);
  // Validation guarantees a finite non-zero direction; the fallback only
  // guards against a definition that bypassed validation.
  return len > 0 && Number.isFinite(len) ? { x: param.direction.x / len, y: param.direction.y / len } : { x: 1, y: 0 };
}

/**
 * Resolve an ENTITY grip index (position grip = 0, appended grips from 1)
 * to its dynamic grip descriptor for the insert as resolved in `state`'s
 * active space (entityInActiveSpace: the stored list, else the active
 * layout's paper entities), or undefined when the index is not a dynamic
 * grip.
 */
export function dynamicGripDescriptor(state: DrawingState, insertId: string, gripIndex: number): DynamicGrip | undefined {
  if (gripIndex < 1) return undefined;
  const entity = entityInActiveSpace(state, insertId);
  if (!entity || entity.type !== 'insert') return undefined;
  const block = state.blocks[entity.block];
  if (!block) return undefined;
  return dynamicGrips(entity, block)[gripIndex - 1];
}

/** The parameter value a definition-space point represents for `param`. */
export function dynamicGripValue(param: GripParameter, localPoint: Point): number {
  if (param.kind === 'linear-distance') {
    return g.dot(g.sub(localPoint, param.basePoint), unitDirection(param));
  }
  // Angle: measured about the base point. atan2 reports the point's own
  // angle in (-pi, pi]; the value is checked against the constraint as-is
  // by apply.ts — angles are never wrapped into range (design rule).
  return Math.atan2(localPoint.y - param.basePoint.y, localPoint.x - param.basePoint.x);
}

/**
 * Inverse of entities.insertTransform for one point (world -> definition
 * space). insertTransform itself cannot be imported here without a module
 * cycle (entities.ts imports this package), so the four steps are mirrored
 * from its definition: undo the translation, rotation, then the
 * mirror/scale, and re-anchor on the block base point. Returns undefined
 * for a degenerate insert transform (a zero scale axis has no inverse).
 */
export function worldToDefinitionPoint(ins: InsertEntity, block: BlockDef, world: Point): Point | undefined {
  const sx = ins.scale * (ins.mirror ? -1 : 1);
  const sy = ins.scaleY ?? ins.scale;
  if (!(Math.abs(sx) > 1e-12) || !(Math.abs(sy) > 1e-12)) return undefined;
  const unrotated = g.rotate(g.sub(world, ins.position), -ins.rotation);
  return { x: block.basePoint.x + unrotated.x / sx, y: block.basePoint.y + unrotated.y / sy };
}

/**
 * The parameter edit that dragging grip `gripIndex` of insert `insertId`
 * to `worldPoint` amounts to, or undefined when that index is not a
 * dynamic grip (the caller then uses the ordinary moveGrip path). When it
 * IS a dynamic grip, the result is exactly a `setDynamicParameter` result:
 * accepted (commit `state` through one transact) or refused with the
 * unchanged state object and a problem code.
 *
 * The insert resolves against the state's ACTIVE SPACE
 * (entityInActiveSpace): a raw snapshot whose active space is a layout
 * resolves the layout's inserts, and the delegated setDynamicParameter
 * returns a raw state whose layout carries the edit — the earlier R08
 * fix only made this work for callers that passed a projected state
 * themselves (review R08 residual).
 */
export function dynamicGripEdit(state: DrawingState, insertId: string, gripIndex: number, worldPoint: Point): DynamicGripEditResult | undefined {
  const entity = entityInActiveSpace(state, insertId);
  if (!entity || entity.type !== 'insert' || gripIndex < 1) return undefined;
  const block = state.blocks[entity.block];
  if (!block?.dynamic || block.dynamicRetained !== undefined || entity.dynamicRetained !== undefined) return undefined;
  const grips = dynamicGrips(entity, block);
  const grip = grips[gripIndex - 1];
  if (!grip) return undefined;
  const param = block.dynamic.parameters.find((p): p is GripParameter => p.id === grip.parameterId && (p.kind === 'linear-distance' || p.kind === 'angle'));
  if (!param) return undefined;
  const local = worldToDefinitionPoint(entity, block, worldPoint);
  if (!local) {
    return { state, problem: 'degenerate-transform', message: `Block reference "${entity.id}" has a degenerate transform (zero scale); its ${param.name} grip cannot be dragged.` };
  }
  return setDynamicParameter(state, insertId, param.id, dynamicGripValue(param, local));
}

/**
 * The pointer's drag resolution (review R08): like `dynamicGripEdit`,
 * but TOTAL over dynamic inserts. `dynamicGripEdit` returns undefined
 * whenever an index does not resolve — a stale index past the insert's
 * last parameter grip, or stored values that no longer validate — and
 * the pointer's fall-through then handed the index to moveGrip, which
 * moved the WHOLE INSERT. That must never happen: an index beyond the
 * position grip on an insert whose block is dynamic can only have come
 * from a parameter grip, so when it does not resolve this function
 * returns a REFUSAL (the input state, problem 'grip-not-resolvable')
 * instead of undefined. Undefined is reserved for inserts whose block
 * is not dynamic at all (and for the position grip), where ordinary
 * grip handling is the correct path. The insert lookup here is the
 * same active-space resolution dynamicGripEdit uses, so totality
 * holds for raw snapshots as well as projected states.
 */
export function resolveDynamicGripDrag(
  state: DrawingState,
  insertId: string,
  gripIndex: number,
  worldPoint: Point,
): DynamicGripEditResult | undefined {
  const result = dynamicGripEdit(state, insertId, gripIndex, worldPoint);
  if (result) return result;
  if (gripIndex < 1) return undefined;
  const entity = entityInActiveSpace(state, insertId);
  if (!entity || entity.type !== 'insert') return undefined;
  const block = state.blocks[entity.block];
  if (!block?.dynamic) return undefined;
  return {
    state,
    problem: 'grip-not-resolvable',
    message: `Grip ${gripIndex} on block reference "${insertId}" is not a resolvable parameter grip; the drag was refused rather than moving the whole reference.`,
  };
}
