import type { Point } from './geometry';
import * as g from './geometry';
import type { Entity, BlockLookup, SnapCandidate } from './entities';
import { snapCandidates, entitySegments, entityBounds } from './entities';

export type SnapKind = SnapCandidate['kind'] | 'intersection' | 'perpendicular' | 'tangent' | 'grid' | 'nearest' | 'extension' | 'tracking';

export interface SnapResult {
  point: Point;
  kind: SnapKind;
  entityId?: string;
}

/**
 * Object snap / tracking settings (DSETTINGS). `polarIncrement` is POLARANG in
 * degrees; `otrack` turns object snap tracking on (F11).
 */
export interface SnapSettings {
  osnap: boolean;
  endpoint: boolean;
  midpoint: boolean;
  center: boolean;
  quadrant: boolean;
  intersection: boolean;
  perpendicular: boolean;
  tangent: boolean;
  node: boolean;
  insertion: boolean;
  nearest: boolean;
  gridSnap: boolean;
  gridSize: number;
  ortho: boolean;
  polar: boolean;
  polarIncrement: number; // degrees
  /** Additional polar angles in degrees (DSETTINGS > Polar Tracking), absolute, tracked in both directions. */
  polarAdditional?: readonly number[];
  /** Object snap tracking (alignment paths from acquired points). */
  otrack: boolean;
  /** Track along polar increments as well as orthogonal directions (POLARMODE bit 1). */
  polarTracking: boolean;
}

export const defaultSnapSettings = (): SnapSettings => ({
  osnap: true,
  endpoint: true,
  midpoint: true,
  center: true,
  quadrant: false,
  intersection: true,
  perpendicular: true,
  tangent: false,
  node: false,
  insertion: false,
  nearest: false,
  gridSnap: false,
  gridSize: 0.5,
  ortho: false,
  polar: false,
  polarIncrement: 90,
  otrack: false,
  polarTracking: false,
});

/** Object snap modes addressable from the command line (OSNAPSET / -OSNAP keywords). */
export const OSNAP_MODES: ReadonlyArray<{ key: keyof SnapSettings; keyword: string; label: string; bit: number }> = [
  { key: 'endpoint', keyword: 'END', label: 'Endpoint', bit: 1 },
  { key: 'midpoint', keyword: 'MID', label: 'Midpoint', bit: 2 },
  { key: 'center', keyword: 'CEN', label: 'Center', bit: 4 },
  { key: 'node', keyword: 'NOD', label: 'Node', bit: 8 },
  { key: 'quadrant', keyword: 'QUA', label: 'Quadrant', bit: 16 },
  { key: 'intersection', keyword: 'INT', label: 'Intersection', bit: 32 },
  { key: 'insertion', keyword: 'INS', label: 'Insertion', bit: 64 },
  { key: 'perpendicular', keyword: 'PER', label: 'Perpendicular', bit: 128 },
  { key: 'tangent', keyword: 'TAN', label: 'Tangent', bit: 256 },
  { key: 'nearest', keyword: 'NEA', label: 'Nearest', bit: 512 },
];

/** OSMODE bit field for the current settings. */
export function osmode(s: SnapSettings): number {
  let v = 0;
  for (const m of OSNAP_MODES) if (s[m.key]) v |= m.bit;
  return v;
}

export function applyOsmode(s: SnapSettings, v: number): void {
  for (const m of OSNAP_MODES) (s as unknown as Record<string, boolean>)[m.key] = (v & m.bit) !== 0;
}

/** Tangent points from `from` to a circle. */
export function tangentPoints(from: Point, center: Point, radius: number): Point[] {
  const d = g.dist(from, center);
  if (d <= radius + g.EPS) return [];
  const alpha = Math.acos(radius / d);
  const b = g.angleOf(center, from);
  return [g.polar(center, b + alpha, radius), g.polar(center, b - alpha, radius)];
}

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
    node: 1,
    quadrant: 2,
    tangent: 2,
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
      if (c.kind === 'node' && !settings.node) continue;
      if (c.kind === 'insertion' && !settings.insertion && !(e.type === 'text' || e.type === 'mtext' || e.type === 'insert')) continue;
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
      } else if (e.type === 'circle' || e.type === 'arc') {
        const foot = g.polar(e.center, g.angleOf(e.center, basePoint), e.radius);
        if (e.type === 'circle' || g.angleInSweep(g.angleOf(e.center, foot), e.startAngle, e.endAngle))
          consider({ point: foot, kind: 'perpendicular', entityId: e.id });
      } else if (e.type === 'xline' || e.type === 'ray') {
        const d = g.normalize(e.direction);
        const t = g.dot(g.sub(basePoint, e.base), d);
        if (e.type === 'xline' || t >= 0) consider({ point: g.add(e.base, g.scale(d, t)), kind: 'perpendicular', entityId: e.id });
      }
    }
  }

  if (settings.tangent && basePoint) {
    for (const e of near) {
      if (e.type !== 'circle' && e.type !== 'arc') continue;
      for (const t of tangentPoints(basePoint, e.center, e.radius)) {
        if (e.type === 'arc' && !g.angleInSweep(g.angleOf(e.center, t), e.startAngle, e.endAngle)) continue;
        consider({ point: t, kind: 'tangent', entityId: e.id });
      }
    }
  }

  if (settings.nearest) {
    for (const e of near) {
      if (e.type === 'circle' || e.type === 'arc') {
        const p = g.polar(e.center, g.angleOf(e.center, cursor), e.radius);
        if (e.type === 'circle' || g.angleInSweep(g.angleOf(e.center, p), e.startAngle, e.endAngle)) consider({ point: p, kind: 'nearest', entityId: e.id });
        continue;
      }
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
    const off = (x: number) => Math.min(Math.abs(g.normAngle(a - x)), Math.abs(g.normAngle(x - a)));
    let snapped = Math.round(a / inc) * inc;
    for (const deg of settings.polarAdditional ?? []) {
      for (const x of [g.rad(deg), g.rad(deg) + Math.PI]) if (off(x) < off(snapped)) snapped = x;
    }
    if (off(snapped) < g.rad(6)) {
      return g.polar(base, snapped, g.dist(base, target));
    }
  }
  return target;
}

export function snapToGrid(p: Point, settings: SnapSettings): Point {
  if (!settings.gridSnap) return p;
  return { x: g.roundTo(p.x, settings.gridSize), y: g.roundTo(p.y, settings.gridSize) };
}

// ------------------------------------------------------------------ object snap tracking (OTRACK)

/** An alignment path through an acquired point at a given angle. */
export interface TrackPath {
  from: Point;
  angle: number;
}

export interface TrackResult {
  point: Point;
  /** Paths the point lies on (one, or two when it is their intersection). */
  paths: TrackPath[];
}

/** Angles (radians) of the alignment paths OTRACK offers from a point. */
export function trackingAngles(settings: SnapSettings): number[] {
  const inc = settings.polarTracking && settings.polarIncrement > 0 ? g.rad(settings.polarIncrement) : Math.PI / 2;
  const out: number[] = [];
  for (let a = 0; a < Math.PI - 1e-9; a += inc) out.push(a);
  if (!out.some((a) => Math.abs(a - Math.PI / 2) < 1e-9)) out.push(Math.PI / 2);
  if (!out.some((a) => Math.abs(a) < 1e-9)) out.push(0);
  return out;
}

function lineLineIntersection(p1: Point, a1: number, p2: Point, a2: number): Point | null {
  const d1 = { x: Math.cos(a1), y: Math.sin(a1) };
  const d2 = { x: Math.cos(a2), y: Math.sin(a2) };
  const denom = g.cross(d1, d2);
  if (Math.abs(denom) < 1e-9) return null;
  const t = g.cross(g.sub(p2, p1), d2) / denom;
  return g.add(p1, g.scale(d1, t));
}

/**
 * Object snap tracking: given the acquired points, find an alignment path
 * (or the intersection of two paths) the cursor is within `tolerance` of.
 */
export function trackFromPoints(cursor: Point, acquired: readonly Point[], settings: SnapSettings, tolerance: number): TrackResult | null {
  if (acquired.length === 0) return null;
  const angles = trackingAngles(settings);
  const paths: TrackPath[] = [];
  for (const p of acquired) {
    for (const a of angles) {
      const d = { x: Math.cos(a), y: Math.sin(a) };
      const t = g.dot(g.sub(cursor, p), d);
      const foot = g.add(p, g.scale(d, t));
      if (g.dist(foot, cursor) <= tolerance && Math.abs(t) > tolerance) paths.push({ from: p, angle: a });
    }
  }
  if (paths.length === 0) return null;
  // Two paths from different acquired points: snap to their intersection.
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      const pi = paths[i]!;
      const pj = paths[j]!;
      if (pi.from === pj.from) continue;
      const x = lineLineIntersection(pi.from, pi.angle, pj.from, pj.angle);
      if (x && g.dist(x, cursor) <= tolerance * 2) return { point: x, paths: [pi, pj] };
    }
  }
  let best = paths[0]!;
  let bestD = Infinity;
  let bestPoint = cursor;
  for (const p of paths) {
    const d = { x: Math.cos(p.angle), y: Math.sin(p.angle) };
    const foot = g.add(p.from, g.scale(d, g.dot(g.sub(cursor, p.from), d)));
    const dist = g.dist(foot, cursor);
    if (dist < bestD) {
      bestD = dist;
      best = p;
      bestPoint = foot;
    }
  }
  return { point: bestPoint, paths: [best] };
}
