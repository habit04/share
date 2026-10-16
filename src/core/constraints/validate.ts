/**
 * Priority 30.3 — constraint validation (design §4). Pure, total: returns
 * *all* problems, in constraint stored order, then ref order. Any problem
 * ⇒ no solve is attempted. Validation never repairs, clamps, or drops
 * anything — an orphaned constraint (missing-reference) blocks its whole
 * set until a user deletes or repairs it.
 */
import type { Entity } from '../entities';
import {
  DIMENSIONAL_KINDS,
  GEOMETRIC_KINDS,
  anchorKey,
  anchorValidFor,
  isConstrainable,
  isPointAnchorKind,
  segmentBulge,
  type AnchorRef,
  type ConstrainableEntity,
  type Constraint,
  type ConstraintSet,
} from './model';

export type ConstraintProblemCode =
  | 'missing-reference'
  | 'unsupported-entity'
  | 'invalid-anchor'
  /** Whole-entity constraint on a bulged polyline segment (design §2.5).
   *  Named there but missing from the §4 table — kept as its own code so
   *  the two are distinguishable in tests and UI. */
  | 'unsupported-anchor'
  | 'invalid-arity'
  | 'invalid-value'
  | 'invalid-role'
  | 'duplicate-constraint'
  | 'self-reference';

export interface ConstraintProblem {
  readonly code: ConstraintProblemCode;
  readonly constraintId?: string;
  readonly entityId?: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Resolved ref shapes (design §2.6). Validation produces these; the solver
// consumes them, so shape rules live exactly once, here.
// ---------------------------------------------------------------------------

/** A ref plus the entity it resolved to. */
export interface Side {
  readonly entity: ConstrainableEntity;
  readonly ref: AnchorRef;
}

export type ConstraintShape =
  | { readonly form: 'coincident-points'; readonly a: Side; readonly b: Side }
  | { readonly form: 'coincident-object'; readonly point: Side; readonly object: Side }
  | { readonly form: 'hv-segment'; readonly seg: Side }
  | { readonly form: 'hv-points'; readonly a: Side; readonly b: Side }
  | { readonly form: 'direction-pair'; readonly a: Side; readonly b: Side } // parallel / perpendicular / angle
  | { readonly form: 'equal-length'; readonly a: Side; readonly b: Side }
  | { readonly form: 'equal-radius'; readonly a: Side; readonly b: Side }
  | { readonly form: 'concentric'; readonly a: Side; readonly b: Side }
  | { readonly form: 'tangent'; readonly a: Side; readonly b: Side }
  | { readonly form: 'fixed'; readonly point: Side }
  | { readonly form: 'distance-points'; readonly a: Side; readonly b: Side }
  | { readonly form: 'distance-point-line'; readonly point: Side; readonly seg: Side }
  | { readonly form: 'distance-length'; readonly seg: Side }
  | { readonly form: 'radius'; readonly target: Side }; // radius / diameter

const isSegmentSide = (s: Side): boolean =>
  (s.entity.type === 'line' && s.ref.anchor === 'whole') || (s.entity.type === 'polyline' && s.ref.anchor === 'segment');
const isCurveSide = (s: Side): boolean =>
  (s.entity.type === 'circle' || s.entity.type === 'arc') && (s.ref.anchor === 'whole' || s.ref.anchor === 'center');
const isPointSide = (s: Side): boolean => isPointAnchorKind(s.ref.anchor);

/** Resolve a constraint's refs into its §2.6 shape. Returns null when the
 *  shape is wrong (the caller reports 'invalid-arity'). Assumes every ref
 *  already passed the entity/anchor checks. */
export function resolveShape(c: Constraint, sides: readonly Side[]): ConstraintShape | null {
  const [r0, r1] = sides as [Side | undefined, Side | undefined];
  switch (c.kind) {
    case 'coincident': {
      if (!r0 || !r1) return null;
      if (isPointSide(r0) && isPointSide(r1)) return { form: 'coincident-points', a: r0, b: r1 };
      if (isPointSide(r0) && r1.ref.anchor === 'whole') return { form: 'coincident-object', point: r0, object: r1 };
      if (isPointSide(r1) && r0.ref.anchor === 'whole') return { form: 'coincident-object', point: r1, object: r0 };
      return null;
    }
    case 'horizontal':
    case 'vertical': {
      if (r0 && !r1 && isSegmentSide(r0)) return { form: 'hv-segment', seg: r0 };
      if (r0 && r1 && isPointSide(r0) && isPointSide(r1)) return { form: 'hv-points', a: r0, b: r1 };
      return null;
    }
    case 'parallel':
    case 'perpendicular':
    case 'angle': {
      if (r0 && r1 && isSegmentSide(r0) && isSegmentSide(r1)) return { form: 'direction-pair', a: r0, b: r1 };
      return null;
    }
    case 'equal': {
      if (!r0 || !r1) return null;
      if (isSegmentSide(r0) && isSegmentSide(r1)) return { form: 'equal-length', a: r0, b: r1 };
      if (isCurveSide(r0) && isCurveSide(r1)) return { form: 'equal-radius', a: r0, b: r1 };
      return null; // mixed length ↔ radius is invalid (design §2.6)
    }
    case 'concentric': {
      if (r0 && r1 && isCurveSide(r0) && isCurveSide(r1)) return { form: 'concentric', a: r0, b: r1 };
      return null;
    }
    case 'tangent': {
      if (!r0 || !r1) return null;
      const ok = (x: Side, y: Side) => (isSegmentSide(x) && isCurveSide(y)) || (isCurveSide(x) && isCurveSide(y));
      return ok(r0, r1) ? { form: 'tangent', a: r0, b: r1 } : null;
    }
    case 'fixed': {
      if (r0 && !r1 && isPointSide(r0)) return { form: 'fixed', point: r0 };
      return null;
    }
    case 'distance': {
      if (r0 && !r1 && isSegmentSide(r0)) return { form: 'distance-length', seg: r0 };
      if (r0 && r1 && isPointSide(r0) && isPointSide(r1)) return { form: 'distance-points', a: r0, b: r1 };
      if (r0 && r1 && isPointSide(r0) && isSegmentSide(r1)) return { form: 'distance-point-line', point: r0, seg: r1 };
      if (r0 && r1 && isPointSide(r1) && isSegmentSide(r0)) return { form: 'distance-point-line', point: r1, seg: r0 };
      return null;
    }
    case 'radius':
    case 'diameter': {
      if (r0 && !r1 && isCurveSide(r0)) return { form: 'radius', target: r0 };
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function refProblems(c: Constraint, entitiesById: ReadonlyMap<string, Entity>): { problems: ConstraintProblem[]; sides: (Side | null)[] } {
  const problems: ConstraintProblem[] = [];
  const sides: (Side | null)[] = c.refs.map((ref) => {
    const e = entitiesById.get(ref.entityId);
    if (!e) {
      problems.push({
        code: 'missing-reference',
        constraintId: c.id,
        entityId: ref.entityId,
        message: `Constraint '${c.id}' references entity '${ref.entityId}', which is not in the entity list.`,
      });
      return null;
    }
    if (!isConstrainable(e)) {
      problems.push({
        code: 'unsupported-entity',
        constraintId: c.id,
        entityId: e.id,
        message: `Constraint '${c.id}' references a '${e.type}' entity, which is not constrainable.`,
      });
      return null;
    }
    if (!anchorValidFor(e, ref)) {
      problems.push({
        code: 'invalid-anchor',
        constraintId: c.id,
        entityId: e.id,
        message: `Anchor '${ref.anchor}'${ref.index === undefined ? '' : ` (index ${ref.index})`} is not valid on entity '${e.id}' (${e.type}).`,
      });
      return null;
    }
    return { entity: e, ref };
  });
  return { problems, sides };
}

/** Segment sides whose bulge makes a whole-entity reading meaningless
 *  (design §2.5). Applies to direction/tangent kinds and to the segment
 *  form of horizontal/vertical — point-anchor forms stay legal. */
function bulgeProblems(c: Constraint, shape: ConstraintShape): ConstraintProblem[] {
  const segSides: Side[] = [];
  switch (c.kind) {
    case 'parallel':
    case 'perpendicular':
    case 'angle':
    case 'tangent':
      if (shape.form === 'direction-pair' || shape.form === 'tangent') segSides.push(shape.a, shape.b);
      break;
    case 'horizontal':
    case 'vertical':
      if (shape.form === 'hv-segment') segSides.push(shape.seg);
      break;
    default:
      break;
  }
  const problems: ConstraintProblem[] = [];
  for (const s of segSides) {
    if (s.entity.type === 'polyline' && s.ref.anchor === 'segment' && segmentBulge(s.entity, s.ref.index!) !== 0) {
      problems.push({
        code: 'unsupported-anchor',
        constraintId: c.id,
        entityId: s.entity.id,
        message: `Constraint '${c.id}' uses segment ${s.ref.index} of bulged polyline '${s.entity.id}' as a straight direction; bulges are carried data, never variables.`,
      });
    }
  }
  return problems;
}

export function validateConstraints(entities: readonly Entity[], set: ConstraintSet): readonly ConstraintProblem[] {
  const byId = new Map<string, Entity>(entities.map((e) => [e.id, e]));
  const problems: ConstraintProblem[] = [];
  const seenIds = new Set<string>();
  const seenSignatures = new Map<string, string>();

  for (const c of set.constraints) {
    // Identity.
    if (seenIds.has(c.id)) {
      problems.push({ code: 'duplicate-constraint', constraintId: c.id, message: `Constraint id '${c.id}' appears more than once in the set.` });
    }
    seenIds.add(c.id);

    // Role / value contract (design §2.3, §2.2).
    if (GEOMETRIC_KINDS.has(c.kind) && c.role === 'reference') {
      problems.push({ code: 'invalid-role', constraintId: c.id, message: `Geometric constraint '${c.id}' (${c.kind}) cannot be a reference constraint.` });
    }
    if (c.role === 'reference' && c.value !== undefined) {
      problems.push({ code: 'invalid-role', constraintId: c.id, message: `Reference constraint '${c.id}' carries a value; a reference value must be absent, not ignored.` });
    }
    if (GEOMETRIC_KINDS.has(c.kind) && c.value !== undefined) {
      problems.push({ code: 'invalid-value', constraintId: c.id, message: `Geometric constraint '${c.id}' (${c.kind}) must not carry a value.` });
    }
    if (c.distanceMode !== undefined && c.kind !== 'distance') {
      problems.push({ code: 'invalid-value', constraintId: c.id, message: `Constraint '${c.id}' (${c.kind}) carries a distanceMode, which only 'distance' may.` });
    }
    if (DIMENSIONAL_KINDS.has(c.kind) && c.role === 'driving') {
      const v = c.value;
      if (v === undefined || !Number.isFinite(v)) {
        problems.push({ code: 'invalid-value', constraintId: c.id, message: `Driving ${c.kind} constraint '${c.id}' requires a finite value.` });
      } else if (c.kind === 'distance' && v < 0) {
        problems.push({ code: 'invalid-value', constraintId: c.id, message: `Driving distance constraint '${c.id}' has a negative value (${v}).` });
      } else if ((c.kind === 'radius' || c.kind === 'diameter') && v <= 0) {
        problems.push({ code: 'invalid-value', constraintId: c.id, message: `Driving ${c.kind} constraint '${c.id}' requires a value > 0 (got ${v}).` });
      }
    }

    // Arity (design §2.6), then per-ref checks, then shape.
    const minRefs = c.kind === 'fixed' || c.kind === 'radius' || c.kind === 'diameter' ? 1 : c.kind === 'distance' || c.kind === 'horizontal' || c.kind === 'vertical' ? 1 : 2;
    const maxRefs = c.kind === 'distance' || c.kind === 'horizontal' || c.kind === 'vertical' ? 2 : minRefs;
    if (c.refs.length < minRefs || c.refs.length > maxRefs) {
      problems.push({ code: 'invalid-arity', constraintId: c.id, message: `Constraint '${c.id}' (${c.kind}) has ${c.refs.length} refs; expected ${minRefs === maxRefs ? minRefs : `${minRefs} or ${maxRefs}`}.` });
      continue;
    }
    const { problems: rp, sides } = refProblems(c, byId);
    problems.push(...rp);
    if (rp.length > 0) continue;
    const shape = resolveShape(c, sides as Side[]);
    if (!shape) {
      problems.push({ code: 'invalid-arity', constraintId: c.id, message: `Constraint '${c.id}' (${c.kind}) has refs of the wrong shape for its kind.` });
      continue;
    }

    // Self-reference: two refs resolving to the same anchor (design §4),
    // including the closed-polyline vertex 0 ↔ vertex n−1 case (§2.5).
    if (c.refs.length === 2) {
      const [s0, s1] = sides as [Side, Side];
      if (anchorKey(s0.entity, s0.ref) === anchorKey(s1.entity, s1.ref)) {
        problems.push({ code: 'self-reference', constraintId: c.id, message: `Constraint '${c.id}' references the same anchor twice.` });
      } else if (
        c.kind === 'coincident' &&
        s0.entity === s1.entity &&
        s0.entity.type === 'polyline' &&
        s0.entity.closed &&
        [s0, s1].every((s) => s.ref.anchor === 'vertex') &&
        new Set([s0, s1].map((s) => s.ref.index! % s0.entity.points.length)).size === 2 &&
        [s0, s1].some((s) => s.ref.index! % s0.entity.points.length === 0) &&
        [s0, s1].some((s) => s.ref.index! % s0.entity.points.length === s0.entity.points.length - 1)
      ) {
        problems.push({
          code: 'invalid-anchor',
          constraintId: c.id,
          message: `Constraint '${c.id}' joins vertex 0 and vertex ${s0.entity.points.length - 1} of the same closed polyline; closure is the 'closed' flag, not a shared vertex.`,
        });
      }
    }

    problems.push(...bulgeProblems(c, shape));

    // Duplicates among non-suppressed constraints: same kind, same
    // unordered ref set, same value/mode (design §4).
    if (!c.suppressed) {
      const signature = [
        c.kind,
        c.refs.map((r) => anchorKey(byId.get(r.entityId)!, r)).sort().join(','),
        c.value === undefined ? '' : String(c.value),
        c.distanceMode ?? '',
      ].join('|');
      const prior = seenSignatures.get(signature);
      if (prior !== undefined) {
        problems.push({ code: 'duplicate-constraint', constraintId: c.id, message: `Constraint '${c.id}' duplicates '${prior}' (same kind, refs and value).` });
      } else {
        seenSignatures.set(signature, c.id);
      }
    }
  }
  return problems;
}

