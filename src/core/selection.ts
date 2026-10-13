import type { Point, Bounds } from './geometry';
import * as g from './geometry';
import type { Entity, BlockLookup } from './entities';
import { distanceToEntity, entityBounds, entitySegments, pointInPolygon, textCorners, mtextParts, mtextDecorations, mtextMasks, explodeInsert, dimensionParts, compoundParts } from './entities';
import { spatialIndexFor } from './spatial-index';
import { polylineWidthGeometry } from './polyline-widths';
import { activeViewport, modelToPaper, paperToModel, pointInViewport, viewportPaperBounds, type LayoutHost, type LayoutViewport } from './layouts';

/** Enabled floating-viewport clip, expressed in model coordinates for all input paths. */
export interface ViewportSelectionClip {
  readonly polygon: readonly Point[];
  readonly edges: ReadonlyArray<readonly [Point, Point]>;
  readonly bounds: Bounds;
  contains(p: Point): boolean;
}

const viewportClipCache = new WeakMap<LayoutViewport, ViewportSelectionClip>();

/** Unclipped/disabled viewports retain the existing whole-space input behavior. */
export function activeSelectionClip(state: LayoutHost): ViewportSelectionClip | null {
  const vp = activeViewport(state)?.viewport;
  if (!vp?.clipBoundary || vp.clipOn === false) return null;
  let clip = viewportClipCache.get(vp);
  if (!clip) {
    const polygon = vp.clipBoundary.points.map((p) => paperToModel(vp, p));
    const rectangle = boundsEdges(viewportPaperBounds(vp)).map(([a, b]): [Point, Point] => [paperToModel(vp, a), paperToModel(vp, b)]);
    clip = {
      polygon,
      edges: [...polygon.map((p, i): [Point, Point] => [p, polygon[(i + 1) % polygon.length]!]), ...rectangle],
      bounds: g.boundsOfPoints(polygon)!,
      contains: (p) => pointInViewport(vp, modelToPaper(vp, p)),
    };
    viewportClipCache.set(vp, clip);
  }
  return clip;
}

const viewportEntitiesCache = new WeakMap<LayoutHost, { source: readonly Entity[]; lookup: BlockLookup; visible: readonly Entity[] }>();

/**
 * Exclude fully masked geometry from graphical selection and snaps. Cache by immutable drawing
 * snapshot, so edits, block redefinitions, undo/redo and viewport view/clip changes invalidate it.
 * Curves and text use the same tessellated outlines/text areas as polygon selection.
 */
export function viewportSelectionEntities(state: LayoutHost, entities: readonly Entity[], lookup: BlockLookup): readonly Entity[] {
  const clip = activeSelectionClip(state);
  if (!clip) return entities;
  const cached = viewportEntitiesCache.get(state);
  if (cached?.source === entities && cached.lookup === lookup) return cached.visible;
  const visible: Entity[] = [];
  const { order, bounds } = candidates(entities, lookup, clip.bounds);
  const count = order ? order.length : entities.length;
  for (let k = 0; k < count; k += 1) {
    const i = order ? order[k]! : k;
    const e = entities[i]!;
    const box = bounds(i);
    if (!box || !g.boundsIntersect(box, clip.bounds)) continue;
    const segments = polygonSegments(e, lookup);
    const touches = segments.some(([a, b]) => {
      if (clip.contains(a) || clip.contains(b)) return true;
      return clip.edges.some(([c, d]) => {
        const intersection = g.segmentIntersection(a, b, c, d);
        return !!intersection && clip.contains(intersection);
      });
    });
    // A clip can lie wholly inside a filled hatch, image, wide polyline or text area without
    // crossing its outline. The ordinary distance test also respects hatch holes.
    if (touches || clip.polygon.some((p) => clip.contains(p) && distanceToEntity(p, e, lookup) <= 1e-9)) visible.push(e);
  }
  viewportEntitiesCache.set(state, { source: entities, lookup, visible });
  return visible;
}

/**
 * The entities to test against `box`, in drawing order, with their bounds: every entity
 * (linear scan), or the spatial index's candidates on a large drawing. Either way the caller
 * applies the same exact test, so the result is identical.
 */
function candidates(entities: readonly Entity[], lookup: BlockLookup, box: Bounds): { order: ArrayLike<number> | null; bounds: (i: number) => Bounds | null } {
  const idx = spatialIndexFor(entities, lookup);
  if (!idx) return { order: null, bounds: (i) => entityBounds(entities[i]!, lookup) };
  // A null order (the box covers the whole grid) scans everything, with the index's cached bounds.
  return { order: idx.query(box), bounds: (i) => idx.bounds[i] ?? null };
}

/**
 * Pick a single entity within `aperture` of the point; closest wins. Among equally close
 * objects (overlapping or coincident geometry) the topmost one wins: the last drawn, highest in
 * draw order, which is also the one the user sees. Hover highlight and every pick use this.
 */
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
  const { order, bounds } = candidates(entities, lookup, { min: { x: p.x - aperture, y: p.y - aperture }, max: { x: p.x + aperture, y: p.y + aperture } });
  const count = order ? order.length : entities.length;
  // iterate from top-most (last drawn) to bottom
  for (let k = count - 1; k >= 0; k -= 1) {
    const i = order ? order[k]! : k;
    const e = entities[i]!;
    if (hiddenLayers.has(e.layer) || lockedLayers.has(e.layer)) continue;
    const b = bounds(i);
    if (b && !g.pointInBounds(p, { min: g.sub(b.min, { x: aperture, y: aperture }), max: g.add(b.max, { x: aperture, y: aperture }) }))
      continue;
    const d = distanceToEntity(p, e, lookup);
    // Strictly closer only: a tie keeps the object found first, i.e. the higher one.
    if (best ? d < bestD : d <= bestD) {
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
  const { order, bounds } = candidates(entities, lookup, box);
  const count = order ? order.length : entities.length;
  for (let k = 0; k < count; k += 1) {
    const i = order ? order[k]! : k;
    const e = entities[i]!;
    if (hiddenLayers.has(e.layer) || lockedLayers.has(e.layer)) continue;
    const b = bounds(i);
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
  if (e.type === 'text' || e.type === 'mtext' || e.type === 'point') return true; // bounds intersect already checked
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

/** Fence selection: everything a polyline of fence points crosses. */
export function selectByFence(
  fence: readonly Point[],
  entities: readonly Entity[],
  lookup: BlockLookup,
  hiddenLayers: ReadonlySet<string>,
  lockedLayers: ReadonlySet<string> = new Set(),
): Entity[] {
  if (fence.length < 2) return [];
  const fb = g.boundsOfPoints(fence)!;
  const out: Entity[] = [];
  const { order, bounds } = candidates(entities, lookup, fb);
  const count = order ? order.length : entities.length;
  for (let k = 0; k < count; k += 1) {
    const i = order ? order[k]! : k;
    const e = entities[i]!;
    if (hiddenLayers.has(e.layer) || lockedLayers.has(e.layer)) continue;
    const b = bounds(i);
    if (!b || !g.boundsIntersect(fb, b)) continue;
    const segs = e.type === 'text' || e.type === 'mtext' ? boundsEdges(b) : entitySegments(e, lookup);
    let hit = false;
    outer: for (let i = 0; i < fence.length - 1; i += 1) {
      for (const [a, c] of segs) {
        if (g.segmentIntersection(fence[i]!, fence[i + 1]!, a, c)) {
          hit = true;
          break outer;
        }
      }
    }
    if (hit) out.push(e);
  }
  return out;
}

function boundsEdges(b: Bounds): Array<[Point, Point]> {
  const c = [b.min, { x: b.max.x, y: b.min.y }, b.max, { x: b.min.x, y: b.max.y }];
  return [
    [c[0]!, c[1]!],
    [c[1]!, c[2]!],
    [c[2]!, c[3]!],
    [c[3]!, c[0]!],
  ];
}

/** Oriented text and compound geometry, rather than their world-axis bounding rectangles. */
function polygonSegments(e: Entity, lookup: BlockLookup): Array<[Point, Point]> {
  const edges = (points: readonly Point[]): Array<[Point, Point]> => points.map((p, i) => [p, points[(i + 1) % points.length]!]);
  switch (e.type) {
    case 'text': return edges(textCorners(e));
    case 'mtext': return [...mtextParts(e).flatMap((t) => edges(textCorners(t))), ...mtextDecorations(e).map((l): [Point, Point] => [l.a, l.b]), ...mtextMasks(e).flatMap(edges)];
    case 'point': return [[e.position, e.position]];
    case 'polyline': {
      if (e.filled || !(e.width || e.widths || e.widthFrame)) return entitySegments(e, lookup);
      const geometry = polylineWidthGeometry(e);
      return [...geometry.polygons.flatMap(edges), ...geometry.thin.flatMap((spine) => spine.slice(1).map((p, i): [Point, Point] => [spine[i]!, p]))];
    }
    case 'insert': return explodeInsert(e, lookup).flatMap((part) => polygonSegments(part, lookup));
    case 'dimension': return dimensionParts(e).flatMap((part) => polygonSegments(part, lookup));
    case 'leader':
    case 'table':
    case 'image': return compoundParts(e).flatMap((part) => polygonSegments(part, lookup));
    default: return entitySegments(e, lookup);
  }
}

/** Filled text and wide-polyline areas also accept a crossing window wholly within them. */
function selectionRegions(e: Entity, lookup: BlockLookup): readonly (readonly Point[])[] {
  switch (e.type) {
    case 'text': return [textCorners(e)];
    case 'mtext': return [...mtextParts(e).map(textCorners), ...mtextMasks(e)];
    case 'polyline': return e.width || e.widths || e.widthFrame ? polylineWidthGeometry(e).polygons : [];
    case 'insert': return explodeInsert(e, lookup).flatMap((part) => selectionRegions(part, lookup));
    case 'dimension': return dimensionParts(e).flatMap((part) => selectionRegions(part, lookup));
    case 'leader':
    case 'table':
    case 'image': return compoundParts(e).flatMap((part) => selectionRegions(part, lookup));
    default: return [];
  }
}

/**
 * Polygon selection. 'window' (WPolygon) keeps entities entirely inside the
 * polygon; 'crossing' (CPolygon) keeps anything inside or touching it.
 */
export function selectByPolygon(
  polygon: readonly Point[],
  mode: 'window' | 'crossing',
  entities: readonly Entity[],
  lookup: BlockLookup,
  hiddenLayers: ReadonlySet<string>,
  lockedLayers: ReadonlySet<string> = new Set(),
): Entity[] {
  if (polygon.length < 3) return [];
  const pb = g.boundsOfPoints(polygon)!;
  const edges: Array<[Point, Point]> = polygon.map((p, i) => [p, polygon[(i + 1) % polygon.length]!]);
  const out: Entity[] = [];
  const { order, bounds } = candidates(entities, lookup, pb);
  const count = order ? order.length : entities.length;
  for (let k = 0; k < count; k += 1) {
    const i = order ? order[k]! : k;
    const e = entities[i]!;
    if (hiddenLayers.has(e.layer) || lockedLayers.has(e.layer)) continue;
    const b = bounds(i);
    if (!b || !g.boundsIntersect(pb, b)) continue;
    const segs = polygonSegments(e, lookup);
    if (segs.length === 0) continue;
    let crosses = false;
    let allInside = true;
    for (const [a, c] of segs) {
      const ia = pointInPolygon(a, polygon);
      const ic = pointInPolygon(c, polygon);
      if (!ia || !ic) allInside = false;
      if (ia || ic) crosses = true;
      if (!crosses || allInside) {
        for (const [p, q] of edges) {
          if (g.segmentIntersection(a, c, p, q)) {
            crosses = true;
            allInside = false;
            break;
          }
        }
      }
      if (mode === 'crossing' && crosses) break;
    }
    if (mode === 'crossing' && !crosses) crosses = selectionRegions(e, lookup).some((region) => polygon.some((p) => pointInPolygon(p, region)));
    if (mode === 'window' ? allInside : crosses) out.push(e);
  }
  return out;
}
