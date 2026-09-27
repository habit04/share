import type { Point } from './geometry';
import * as g from './geometry';
import type { Entity, BlockLookup, SnapCandidate } from './entities';
import { snapCandidates, entitySegments, entityBounds } from './entities';

export type SnapKind = SnapCandidate['kind'] | 'intersection' | 'perpendicular' | 'grid' | 'nearest';

export interface SnapResult {
  point: Point;
  kind: SnapKind;
  entityId?: string;
}

export interface SnapSettings {
  osnap: boolean;
  endpoint: boolean;
  midpoint: boolean;
  center: boolean;
  quadrant: boolean;
  intersection: boolean;
  perpendicular: boolean;
  nearest: boolean;
  gridSnap: boolean;
  gridSize: number;
  ortho: boolean;
  polar: boolean;
  polarIncrement: number; // degrees
}

export const defaultSnapSettings = (): SnapSettings => ({
  osnap: true,
  endpoint: true,
  midpoint: true,
  center: true,
  quadrant: false,
  intersection: true,
  perpendicular: true,
  nearest: false,
  gridSnap: false,
  gridSize: 0.5,
  ortho: false,
  polar: false,
  polarIncrement: 90,
});

/**
 * Find the best object snap near `cursor` (world coords). `aperture` is the
 * pick radius in world units.
 */
export function findObjectSnap(
  cursor: Point,
  entities: readonly Entity[],
  lookup: BlockLookup,
  settings: SnapSettings,
  aperture: number,
  basePoint: Point | null,
  hiddenLayers: ReadonlySet<string>,
): SnapResult | null {
  if (!settings.osnap) return null;
  let best: SnapResult | null = null;
  let bestD = Infinity;
  const priority: Record<string, number> = {
    endpoint: 0,
    intersection: 0,
    midpoint: 1,
    center: 1,
    insertion: 1,
    quadrant: 2,
    node: 2,
    perpendicular: 3,
    nearest: 4,
    grid: 5,
  };
  const consider = (r: SnapResult) => {
    const d = g.dist(cursor, r.point);
    if (d > aperture) return;
    // Weight by priority so endpoints win over "nearest" at similar distance.
    const score = d + (priority[r.kind] ?? 5) * aperture * 0.15;
    if (score < bestD) {
      bestD = score;
      best = r;
    }
  };

  const near: Entity[] = [];
  const box = {
    min: { x: cursor.x - aperture, y: cursor.y - aperture },
    max: { x: cursor.x + aperture, y: cursor.y + aperture },
  };
  for (const e of entities) {
    if (hiddenLayers.has(e.layer)) continue;
    const b = entityBounds(e, lookup);
    if (!b) continue;
    // generous bounds check (circle centers can be far from outline)
    const pad = e.type === 'circle' || e.type === 'arc' ? e.radius : 0;
    if (
      b.max.x + pad < box.min.x ||
      b.min.x - pad > box.max.x ||
      b.max.y + pad < box.min.y ||
      b.min.y - pad > box.max.y
    )
      continue;
    near.push(e);
  }

  for (const e of near) {
    for (const c of snapCandidates(e, lookup)) {
      if (c.kind === 'endpoint' && !settings.endpoint) continue;
      if (c.kind === 'midpoint' && !settings.midpoint) continue;
      if (c.kind === 'center' && !settings.center) continue;
      if (c.kind === 'quadrant' && !settings.quadrant) continue;
      consider({ point: c.point, kind: c.kind, entityId: e.id });
    }
  }

  if (settings.intersection && near.length > 1) {
    for (let i = 0; i < near.length; i += 1) {
      const si = entitySegments(near[i]!, lookup);
      for (let j = i + 1; j < near.length; j += 1) {
        const sj = entitySegments(near[j]!, lookup);
        for (const [a1, a2] of si) {
          for (const [b1, b2] of sj) {
            const x = g.segmentIntersection(a1, a2, b1, b2);
            if (x) consider({ point: x, kind: 'intersection', entityId: near[i]!.id });
          }
        }
      }
    }
  }

  if (settings.perpendicular && basePoint) {
    for (const e of near) {
      if (e.type === 'line') {
        const foot = g.closestOnSegment(basePoint, e.a, e.b);
        consider({ point: foot, kind: 'perpendicular', entityId: e.id });
      }
    }
  }

  if (settings.nearest) {
    for (const e of near) {
      for (const [a, b] of entitySegments(e, lookup)) {
        consider({ point: g.closestOnSegment(cursor, a, b), kind: 'nearest', entityId: e.id });
      }
    }
  }
  return best;
}

/** Apply ortho / polar constraint relative to a base point. */
export function constrainDirection(base: Point, target: Point, settings: SnapSettings): Point {
  if (settings.ortho) {
    const dx = target.x - base.x;
    const dy = target.y - base.y;
    return Math.abs(dx) >= Math.abs(dy) ? { x: target.x, y: base.y } : { x: base.x, y: target.y };
  }
  if (settings.polar) {
    const inc = g.rad(settings.polarIncrement);
    const a = g.angleOf(base, target);
    const snapped = Math.round(a / inc) * inc;
    if (Math.abs(g.normAngle(a - snapped)) < g.rad(6) || Math.abs(g.normAngle(snapped - a)) < g.rad(6)) {
      return g.polar(base, snapped, g.dist(base, target));
    }
  }
  return target;
}

export function snapToGrid(p: Point, settings: SnapSettings): Point {
  if (!settings.gridSnap) return p;
  return { x: g.roundTo(p.x, settings.gridSize), y: g.roundTo(p.y, settings.gridSize) };
}
