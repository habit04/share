/**
 * Priority 30.3 — 2D constraint model (design: design-constraints.md §2/§3).
 *
 * Pure data + anchor geometry. No I/O, no editor imports, no solver state.
 * A `Constraint` is plain JSON-serializable data; anchors are named, derivable
 * features of an entity — derived anchors (arc endpoints, midpoints) are
 * computed from the entity every time they are read and are never stored.
 *
 * Layout note: the design draft proposed `src/core/parametric/constraints.ts`;
 * the 30.3 dispatch places the engine in `src/core/constraints/` so the 30.1 /
 * 30.2 parametric modules stay untouched. The model itself follows the design
 * exactly.
 */
import { add, mid, scale, type Point } from '../geometry';
import type { Entity } from '../entities';

// ---------------------------------------------------------------------------
// Anchors (design §2.1)
// ---------------------------------------------------------------------------

export type AnchorKind =
  | 'start' // line.a · arc start point (derived) · polyline vertex 0
  | 'end' // line.b · arc end point (derived) · polyline last vertex (vertex 0 if closed)
  | 'center' // circle/arc center
  | 'vertex' // polyline vertex `index`
  | 'segment' // polyline segment `index` (whole-segment refs)
  | 'midpoint' // line midpoint · polyline segment `index` midpoint (derived)
  | 'position' // point entity position
  | 'whole'; // the entity as a curve (point-on-object, tangent, concentric-by-entity)

export interface AnchorRef {
  readonly entityId: string;
  readonly anchor: AnchorKind;
  /** Vertex / segment index (polyline only; required for vertex/segment,
   *  and for midpoint on a polyline). */
  readonly index?: number;
}

/** A point anchor is any of start/end/center/vertex/midpoint/position — it
 *  resolves to a single `Point`. `segment` and `whole` are not point anchors. */
export function isPointAnchorKind(anchor: AnchorKind): boolean {
  return anchor !== 'segment' && anchor !== 'whole';
}

// ---------------------------------------------------------------------------
// Constraint record (design §2.2 / §2.6 / §2.7)
// ---------------------------------------------------------------------------

export type ConstraintKind =
  // geometric
  | 'coincident'
  | 'horizontal'
  | 'vertical'
  | 'parallel'
  | 'perpendicular'
  | 'equal'
  | 'concentric'
  | 'tangent'
  | 'fixed'
  // dimensional
  | 'distance'
  | 'angle'
  | 'radius'
  | 'diameter';

export type ConstraintRole = 'driving' | 'reference';

export const GEOMETRIC_KINDS: ReadonlySet<ConstraintKind> = new Set([
  'coincident',
  'horizontal',
  'vertical',
  'parallel',
  'perpendicular',
  'equal',
  'concentric',
  'tangent',
  'fixed',
]);

export const DIMENSIONAL_KINDS: ReadonlySet<ConstraintKind> = new Set(['distance', 'angle', 'radius', 'diameter']);

export interface Constraint {
  readonly id: string;
  readonly kind: ConstraintKind;
  /** Geometric constraints are always 'driving' (design §2.3). */
  readonly role: ConstraintRole;
  /** 1 or 2 refs; arity and shape are fixed per kind (design §2.6). Order is
   *  significant and stored (for 'distance', refs[0] → refs[1]). */
  readonly refs: readonly AnchorRef[];
  /** Dimensional target. Required iff kind is dimensional and role is
   *  'driving'; must be absent otherwise (never silently ignored).
   *  distance: units, >= 0 · angle: radians · radius/diameter: units, > 0. */
  readonly value?: number;
  /** Distance only (design §2.7); default 'aligned'. */
  readonly distanceMode?: 'aligned' | 'horizontal' | 'vertical';
  /** Suppressed constraints are stored and reported, but excluded from
   *  solving and DOF accounting (design §2.2). */
  readonly suppressed?: boolean;
}

export interface ConstraintSet {
  /** Stored order = deterministic solve order. */
  readonly constraints: readonly Constraint[];
}

// ---------------------------------------------------------------------------
// Constrainable entities and parametrization (design §1 / §3.1)
// ---------------------------------------------------------------------------

export type ConstrainableEntity = Extract<
  Entity,
  { type: 'line' | 'circle' | 'arc' | 'polyline' | 'point' }
>;

export function isConstrainable(e: Entity): e is ConstrainableEntity {
  return e.type === 'line' || e.type === 'circle' || e.type === 'arc' || e.type === 'polyline' || e.type === 'point';
}

/** A polyline's points as an array. Entities are plain data and may
 *  arrive malformed (30.3.4 hardening): a missing or non-array `points`
 *  reads as empty here — never a throw — and the solver's input guards
 *  refuse such an entity before any anchor is resolved for solving. */
function polyPoints(e: Extract<Entity, { type: 'polyline' }>): readonly Point[] {
  return Array.isArray(e.points) ? e.points : [];
}

/** Degrees of freedom of one entity under the §3.1 parametrization.
 *  Non-constrainable entities are not in the system: 0. */
export function entityDof(e: Entity): number {
  switch (e.type) {
    case 'point':
      return 2;
    case 'line':
      return 4;
    case 'circle':
      return 3;
    case 'arc':
      return 5;
    case 'polyline':
      return 2 * polyPoints(e).length;
    default:
      return 0;
  }
}

/** Nominal DOF consumption of an active (driving, non-suppressed) constraint,
 *  design §3.2. `shape` disambiguates the two coincident forms. Reference and
 *  suppressed constraints consume 0 and are handled by the caller. */
export function nominalConsumption(kind: ConstraintKind, shape?: 'point-point' | 'point-object'): number {
  switch (kind) {
    case 'coincident':
      return shape === 'point-object' ? 1 : 2;
    case 'concentric':
    case 'fixed':
      return 2;
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Anchor validity (design §2.1 table + index rules)
// ---------------------------------------------------------------------------

function indexOk(index: number | undefined, required: boolean, count: number): boolean {
  if (!required) return index === undefined;
  return index !== undefined && Number.isInteger(index) && index >= 0 && index < count;
}

/** Is this anchor (kind + index) legal for the entity at all? This is the
 *  §2.1 table only — kind-specific ref *shapes* are checked by validation. */
export function anchorValidFor(e: Entity, ref: AnchorRef): boolean {
  const idx = ref.index;
  switch (e.type) {
    case 'line':
      switch (ref.anchor) {
        case 'start':
        case 'end':
        case 'midpoint':
        case 'whole':
          return idx === undefined;
        default:
          return false;
      }
    case 'circle':
      return (ref.anchor === 'center' || ref.anchor === 'whole') && idx === undefined;
    case 'arc':
      return (ref.anchor === 'start' || ref.anchor === 'end' || ref.anchor === 'center' || ref.anchor === 'whole') && idx === undefined;
    case 'point':
      return ref.anchor === 'position' && idx === undefined;
    case 'polyline': {
      const n = polyPoints(e).length;
      // Closed polylines: indices are modulo n (design §2.5), so index n is
      // accepted and resolves to vertex/segment 0.
      const segCount = e.closed ? n : n - 1;
      const vertexCount = e.closed ? n + 1 : n;
      switch (ref.anchor) {
        case 'start':
        case 'end':
        case 'whole':
          return idx === undefined;
        case 'vertex':
          return indexOk(idx, true, vertexCount);
        case 'segment':
        case 'midpoint':
          return indexOk(idx, true, segCount);
        default:
          return false;
      }
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Anchor resolution (assumes the ref passed `anchorValidFor`)
// ---------------------------------------------------------------------------

function vertexAt(e: Extract<Entity, { type: 'polyline' }>, index: number): Point {
  const pts = polyPoints(e);
  return pts[e.closed ? index % pts.length : index]!;
}

function arcPoint(e: Extract<Entity, { type: 'arc' }>, angle: number): Point {
  return add(e.center, scale({ x: Math.cos(angle), y: Math.sin(angle) }, e.radius));
}

/** Resolve a point anchor to its current coordinates. Derived anchors are
 *  computed, never stored (design §2.1). Throws on a non-point anchor —
 *  callers validate first. */
export function resolveAnchorPoint(e: Entity, ref: AnchorRef): Point {
  switch (e.type) {
    case 'line':
      if (ref.anchor === 'start') return e.a;
      if (ref.anchor === 'end') return e.b;
      if (ref.anchor === 'midpoint') return mid(e.a, e.b);
      break;
    case 'circle':
      if (ref.anchor === 'center') return e.center;
      break;
    case 'arc':
      if (ref.anchor === 'center') return e.center;
      if (ref.anchor === 'start') return arcPoint(e, e.startAngle);
      if (ref.anchor === 'end') return arcPoint(e, e.endAngle);
      break;
    case 'point':
      if (ref.anchor === 'position') return e.position;
      break;
    case 'polyline': {
      const pts = polyPoints(e);
      const n = pts.length;
      if (ref.anchor === 'start') return pts[0]!;
      if (ref.anchor === 'end') return e.closed ? pts[0]! : pts[n - 1]!;
      if (ref.anchor === 'vertex') return vertexAt(e, ref.index!);
      if (ref.anchor === 'midpoint') {
        const i = e.closed ? ref.index! % n : ref.index!;
        return mid(pts[i]!, pts[(i + 1) % n]!);
      }
      break;
    }
    default:
      break;
  }
  throw new Error(`Anchor '${ref.anchor}' on entity '${e.id}' (${e.type}) is not a point anchor`);
}

/** Endpoints of the segment a ref denotes: a line via 'whole', or a polyline
 *  'segment'. Returns null for any other ref shape. */
export function segmentEndpoints(e: Entity, ref: AnchorRef): readonly [Point, Point] | null {
  if (e.type === 'line' && ref.anchor === 'whole') return [e.a, e.b];
  if (e.type === 'polyline' && ref.anchor === 'segment') {
    const pts = polyPoints(e);
    const n = pts.length;
    const i = e.closed ? ref.index! % n : ref.index!;
    return [pts[i]!, pts[(i + 1) % n]!];
  }
  return null;
}

/** Stable identity of a resolved anchor, for duplicate / self-reference
 *  checks: entity + anchor kind + resolved index. */
export function anchorKey(e: Entity, ref: AnchorRef): string {
  let index = ref.index;
  if (e.type === 'polyline' && index !== undefined) index = e.closed ? index % polyPoints(e).length : index;
  if (e.type === 'polyline' && ref.anchor === 'end') return `${e.id}|vertex|${e.closed ? 0 : polyPoints(e).length - 1}`;
  if (e.type === 'polyline' && ref.anchor === 'start') return `${e.id}|vertex|0`;
  return `${e.id}|${ref.anchor}|${index === undefined ? '' : index}`;
}

/** Does this polyline carry any non-zero bulge? (Design §2.5: bulges are
 *  carried data, never variables.) */
export function hasBulge(e: Entity): boolean {
  return e.type === 'polyline' && Array.isArray(e.bulges) && e.bulges.some((b) => b !== 0);
}

/** The bulge of the segment starting at vertex `index` (0 when absent). */
export function segmentBulge(e: Entity, index: number): number {
  if (e.type !== 'polyline' || !Array.isArray(e.bulges)) return 0;
  return e.bulges[index] ?? 0;
}
