/**
 * Priority 30.4 slice C — insert-time alignment placement (design
 * design-visibility-lookup-array.md §4.3, the insert-tool contract for the
 * §4.2 alignment spec).
 *
 * Alignment is placement-time behavior, categorically not evaluation
 * (§4.1): the evaluator never reads the spec, no instance value exists,
 * and the rotation it produces is stored as the insert's ordinary
 * `rotation`. The contract this module implements, verbatim from §4.3:
 *
 * - When INSERT places an insert of a block whose definition carries
 *   `alignment`, the tool offers alignment rotation during placement:
 *   given a picked target entity and a pick point on it, the placed
 *   rotation is the angle about the block base point that makes
 *   `alignment.direction` satisfy `alignment.mode` against the target's
 *   local direction at the pick point.
 * - With no target picked, placement proceeds exactly as today (rotation
 *   as specified by the user).
 *
 * Reading of the contract for this tool's prompt flow: the pick IS the
 * INSERT rotation step's point answer — the point the user clicks to set
 * the rotation. The target is the nearest entity with a local direction
 * whose nearest point to the pick lies within the pick aperture. The
 * insert's position is NOT moved: §4.3 defines the placed rotation and
 * stores it as ordinary `rotation`; nothing in the contract asks
 * placement to translate the insert so the spec's `basePoint` lands on
 * the target (the base point names the pivot the rotation is understood
 * about, and an angle does not depend on the pivot).
 *
 * The one point the design leaves open: an axis is a line direction
 * (mod π), so for either mode TWO rotations a half-turn apart make the
 * axis satisfy the mode. §4.1 marks the exact native placement semantics
 * [fixture-gated] beyond the contract sentence, and no branch rule is
 * stated. This module picks the candidate closest to the rotation the
 * same pick produces without alignment (the angle from the insertion
 * point to the pick point), which keeps the aligned result continuous
 * with the unaligned interaction; ties go to the unwrapped candidate.
 * Re-alignment on grip drag of an existing insert is NOT implemented
 * (§4.3: not promised for 30.4).
 */
import type { BlockDef, Entity } from '../entities';
import { polylineSegments } from '../entities';
import * as g from '../geometry';
import type { Point } from '../geometry';
import type { AlignmentSpec } from './definitions';

/** Wrap an angle to (−π, π] — the range `g.angleOf` produces and the
 *  INSERT point-pick path has always stored. */
function wrapPi(a: number): number {
  const w = g.normAngle(a);
  return w > Math.PI ? w - 2 * Math.PI : w;
}

/** Circular distance between two angles, in [0, π]. */
const angularDistance = (a: number, b: number): number => Math.abs(wrapPi(a - b));

/**
 * The local direction of an entity at the point on it nearest `p`,
 * together with that nearest point. The angle is an AXIS direction
 * (meaningful mod π), which is all the alignment modes consume.
 *
 * Covered: line (segment direction), polyline (nearest segment; a bulged
 * segment contributes its arc tangent at the nearest arc point), circle
 * and arc (tangent at the nearest point on the curve), xline / ray (the
 * stored direction). Anything else — point, text, insert, hatch, spline,
 * ellipse, dimension, … — has no local direction here and returns null,
 * so the caller falls back to ordinary placement rotation.
 */
export function entityDirectionAt(e: Entity, p: Point): { readonly point: Point; readonly angle: number } | null {
  switch (e.type) {
    case 'line': {
      if (g.dist(e.a, e.b) <= g.EPS) return null;
      return { point: g.closestOnSegment(p, e.a, e.b), angle: Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x) };
    }
    case 'polyline': {
      let best: { point: Point; angle: number; d: number } | null = null;
      for (const seg of polylineSegments(e)) {
        let q: Point;
        let angle: number;
        if (seg.arc) {
          const arc = seg.arc;
          const radial = g.angleOf(arc.center, p);
          // Membership against the SIGNED sweep (angleInSweep is CCW-only).
          const along = arc.sweep >= 0 ? g.normAngle(radial - arc.startAngle) : g.normAngle(arc.startAngle - radial);
          q = along <= Math.abs(arc.sweep) + g.EPS
            ? g.polar(arc.center, radial, arc.radius)
            : g.dist(p, seg.a) <= g.dist(p, seg.b) ? seg.a : seg.b;
          angle = g.angleOf(arc.center, q) + Math.PI / 2;
        } else {
          if (g.dist(seg.a, seg.b) <= g.EPS) continue;
          q = g.closestOnSegment(p, seg.a, seg.b);
          angle = Math.atan2(seg.b.y - seg.a.y, seg.b.x - seg.a.x);
        }
        const d = g.dist(p, q);
        if (!best || d < best.d) best = { point: q, angle, d };
      }
      return best ? { point: best.point, angle: best.angle } : null;
    }
    case 'circle':
    case 'arc': {
      if (!(e.radius > 0) || g.dist(e.center, p) <= g.EPS) return null;
      const radial = g.angleOf(e.center, p);
      const q = e.type === 'circle' || g.angleInSweep(radial, e.startAngle, e.endAngle)
        ? g.polar(e.center, radial, e.radius)
        : (() => {
            const s = g.polar(e.center, e.startAngle, e.radius);
            const t = g.polar(e.center, e.endAngle, e.radius);
            return g.dist(p, s) <= g.dist(p, t) ? s : t;
          })();
      return { point: q, angle: g.angleOf(e.center, q) + Math.PI / 2 };
    }
    case 'xline':
    case 'ray': {
      const len = g.len(e.direction);
      if (!(len > 0)) return null;
      const d = g.scale(e.direction, 1 / len);
      let t = g.dot(g.sub(p, e.base), d);
      if (e.type === 'ray') t = Math.max(0, t);
      return { point: g.add(e.base, g.scale(d, t)), angle: Math.atan2(e.direction.y, e.direction.x) };
    }
    default:
      return null;
  }
}

/** A picked alignment target: the entity, its local direction angle at
 *  the point nearest the pick, and that distance. */
export interface AlignmentTarget {
  readonly entityId: string;
  readonly angle: number;
  readonly distance: number;
}

/**
 * The target entity for a placement pick: the nearest entity with a
 * local direction whose nearest point lies within `aperture` of the
 * pick. Deterministic — entities are scanned in list order and a
 * strictly nearer candidate replaces the current best, so distance ties
 * keep the earliest entity. Null when nothing qualifies (the §4.3
 * "no target picked" case).
 */
export function alignmentTargetAt(entities: readonly Entity[], pick: Point, aperture: number): AlignmentTarget | null {
  let best: AlignmentTarget | null = null;
  for (const e of entities) {
    const dir = entityDirectionAt(e, pick);
    if (!dir) continue;
    const distance = g.dist(pick, dir.point);
    if (distance > aperture) continue;
    if (!best || distance < best.distance) best = { entityId: e.id, angle: dir.angle, distance };
  }
  return best;
}

/**
 * The placed rotation for an alignment spec against a target whose local
 * direction at the pick point is `targetAngle`: the rotation that makes
 * the spec's axis satisfy its mode — parallel to the target for
 * 'tangent', normal to it for 'perpendicular'. Of the two solutions a
 * half-turn apart (an axis is mod π), the one closest to `reference` —
 * the rotation the same pick would produce without alignment — wins.
 */
export function alignmentRotation(spec: AlignmentSpec, targetAngle: number, reference: number): number {
  const axis = Math.atan2(spec.direction.y, spec.direction.x);
  const desired = spec.mode === 'tangent' ? targetAngle : targetAngle + Math.PI / 2;
  const r0 = wrapPi(desired - axis);
  const r1 = wrapPi(desired - axis + Math.PI);
  return angularDistance(r1, reference) < angularDistance(r0, reference) ? r1 : r0;
}

/**
 * The INSERT tool's §4.3 offer, as one pure query: the aligned rotation
 * for placing `block` when the rotation pick is `pick`, or null when
 * placement must proceed exactly as today — the definition carries no
 * (usable) alignment spec, or no target is under the pick. `reference`
 * is the rotation the pick produces without alignment. A spec whose
 * direction is zero or non-finite (a definition validation refuses, so
 * evaluation already refuses the block as a whole) offers nothing here:
 * placement stays ordinary rather than inventing an angle.
 */
export function placementAlignmentRotation(
  block: BlockDef,
  entities: readonly Entity[],
  pick: Point,
  aperture: number,
  reference: number,
): number | null {
  const spec = block.dynamic?.alignment;
  if (!spec) return null;
  if (!Number.isFinite(spec.basePoint.x) || !Number.isFinite(spec.basePoint.y)) return null;
  const dirLen = g.len(spec.direction);
  if (!Number.isFinite(dirLen) || dirLen <= 0) return null;
  const target = alignmentTargetAt(entities, pick, aperture);
  if (!target) return null;
  return alignmentRotation(spec, target.angle, reference);
}
