import type { Point, Bounds } from './geometry';
import * as g from './geometry';
import type { Entity, BlockLookup } from './entities';
import { distanceToEntity, entityBounds, entitySegments } from './entities';

/** Pick a single entity within `aperture` of the point; closest wins. */
export function pickEntity(
  p: Point,
  entities: readonly Entity[],
  lookup: BlockLookup,
  aperture: number,
  hiddenLayers: ReadonlySet<string>,
  lockedLayers: ReadonlySet<string> = new Set(),
): Entity | null {
  let best: Entity | null = null;
  let bestD = aperture;
  // iterate from top-most (last drawn) to bottom
  for (let i = entities.length - 1; i >= 0; i -= 1) {
    const e = entities[i]!;
    if (hiddenLayers.has(e.layer) || lockedLayers.has(e.layer)) continue;
    const b = entityBounds(e, lookup);
    if (b && !g.pointInBounds(p, { min: g.sub(b.min, { x: aperture, y: aperture }), max: g.add(b.max, { x: aperture, y: aperture }) }))
      continue;
    const d = distanceToEntity(p, e, lookup);
    if (d <= bestD) {
      bestD = d;
      best = e;
    }
  }
  return best;
}

/**
 * Window selection (mode = 'window') selects entities fully inside the box.
 * Crossing selection selects anything that touches the box.
 */
export function selectByBox(
  box: Bounds,
  mode: 'window' | 'crossing',
  entities: readonly Entity[],
  lookup: BlockLookup,
  hiddenLayers: ReadonlySet<string>,
  lockedLayers: ReadonlySet<string> = new Set(),
): Entity[] {
  const out: Entity[] = [];
  for (const e of entities) {
    if (hiddenLayers.has(e.layer) || lockedLayers.has(e.layer)) continue;
    const b = entityBounds(e, lookup);
    if (!b) continue;
    if (mode === 'window') {
      if (g.boundsContains(box, b)) out.push(e);
    } else if (g.boundsIntersect(box, b)) {
      if (g.boundsContains(box, b) || touchesBox(e, box, lookup)) out.push(e);
    }
  }
  return out;
}

function touchesBox(e: Entity, box: Bounds, lookup: BlockLookup): boolean {
  const corners = [box.min, { x: box.max.x, y: box.min.y }, box.max, { x: box.min.x, y: box.max.y }];
  const edges: Array<[Point, Point]> = [
    [corners[0]!, corners[1]!],
    [corners[1]!, corners[2]!],
    [corners[2]!, corners[3]!],
    [corners[3]!, corners[0]!],
  ];
  if (e.type === 'text') return true; // bounds intersect already checked
  const segs = entitySegments(e, lookup);
  for (const [a, b] of segs) {
    if (g.pointInBounds(a, box) || g.pointInBounds(b, box)) return true;
    for (const [c, d] of edges) if (g.segmentIntersection(a, b, c, d)) return true;
  }
  if (e.type === 'circle') {
    // box entirely inside the circle: no touch
    return false;
  }
  return false;
}
