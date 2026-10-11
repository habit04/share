/**
 * Uniform-grid spatial index over a drawing's entity array, for hit testing (pick, rollover),
 * window / crossing / fence / polygon selection and the object-snap candidate search.
 *
 * Entities are immutable and every edit produces a new entities array, so an index is built for
 * one array and cached by its identity (WeakMap): it is never updated, only rebuilt lazily for the
 * next array that is queried twice. Small drawings, and an array queried only once, use the plain
 * linear scan, which the index reproduces exactly (same candidates, same order, same tie-breaks).
 *
 * Bounds of block inserts depend on the block definitions; the index remembers which definition
 * object each referenced block name resolved to and is rebuilt when any of them changes (the
 * same rule as the insert geometry cache in entities.ts).
 */
import type { Bounds } from './geometry';
import type { BlockDef, BlockLookup, Entity } from './entities';
import { entityBounds } from './entities';

/** Arrays shorter than this are scanned linearly. */
export const SPATIAL_INDEX_MIN_ENTITIES = 2000;
/** An entity covering more cells than this goes to the "large" list (checked on every query). */
const MAX_CELLS_PER_ENTITY = 64;

/** Turn the index off (benchmarks compare against the linear scan; tests check both agree). */
export const spatialIndexSettings = { enabled: true, minEntities: SPATIAL_INDEX_MIN_ENTITIES };

export interface SpatialIndex {
  readonly entities: readonly Entity[];
  readonly lookup: BlockLookup;
  /** entityBounds of every entity, by index (null when it has none). */
  readonly bounds: ReadonlyArray<Bounds | null>;
  /** Largest circle / arc radius (the object-snap search pads circles and arcs by their radius). */
  readonly maxArcRadius: number;
  /**
   * Indices (ascending) of the entities whose bounds may intersect `box`, plus every entity
   * without finite bounds. A superset: callers apply their exact test afterwards. null when the
   * box covers the whole grid: then every entity is a candidate (scan them in order).
   */
  query(box: Bounds): number[] | null;
}

interface GridIndex extends SpatialIndex {
  readonly blockDeps: ReadonlyMap<string, BlockDef | undefined>;
}

const cache = new WeakMap<readonly Entity[], GridIndex>();
/** Arrays queried once (the second query builds the index). */
const seen = new WeakSet<readonly Entity[]>();

/**
 * Bounds of entities whose geometry depends on nothing but the entity object itself (not on block
 * definitions), kept across rebuilds: after an edit most entity objects are shared with the
 * previous array, so a rebuild mostly reads this cache. Inserts, dimensions, leaders, tables and
 * images go through entityBounds every time (inserts use the insert geometry cache).
 */
const boundsCache = new WeakMap<Entity, Bounds | null>();
const SELF_CONTAINED = new Set<Entity['type']>(['line', 'circle', 'arc', 'polyline', 'text', 'ellipse', 'point', 'xline', 'ray', 'mtext', 'spline', 'hatch']);
function boundsOf(e: Entity, lookup: BlockLookup): Bounds | null {
  if (!SELF_CONTAINED.has(e.type)) return entityBounds(e, lookup);
  let b = boundsCache.get(e);
  if (b === undefined) {
    b = entityBounds(e, lookup);
    boundsCache.set(e, b);
  }
  return b;
}

const finite = (b: Bounds | null): b is Bounds => !!b && Number.isFinite(b.min.x) && Number.isFinite(b.min.y) && Number.isFinite(b.max.x) && Number.isFinite(b.max.y);

function build(entities: readonly Entity[], lookup: BlockLookup): GridIndex {
  const n = entities.length;
  const bounds: Array<Bounds | null> = new Array(n);
  const blockDeps = new Map<string, BlockDef | undefined>();
  let maxArcRadius = 0;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let m = 0;
  for (let i = 0; i < n; i += 1) {
    const e = entities[i]!;
    if (e.type === 'insert' && !blockDeps.has(e.block)) blockDeps.set(e.block, lookup(e.block));
    if ((e.type === 'circle' || e.type === 'arc') && e.radius > maxArcRadius) maxArcRadius = e.radius;
    const b = boundsOf(e, lookup);
    bounds[i] = b;
    if (!finite(b) || e.type === 'xline' || e.type === 'ray') continue;
    xs[m] = (b.min.x + b.max.x) / 2;
    ys[m] = (b.min.y + b.max.y) / 2;
    m += 1;
  }
  if (!Number.isFinite(maxArcRadius)) maxArcRadius = Infinity;
  // The grid covers the middle 98 % of the entity centres, so a few stray objects far away (or
  // construction lines) do not squeeze everything else into a handful of cells. Anything
  // outside lands in the edge cells: cell numbers are clamped, which keeps the lookup exact.
  const sx = xs.subarray(0, m).sort();
  const sy = ys.subarray(0, m).sort();
  const pick = (a: Float64Array, q: number) => (a.length ? a[Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1))))]! : 0);
  const minX = pick(sx, 0.01);
  const maxX = pick(sx, 0.99);
  const minY = pick(sy, 0.01);
  const maxY = pick(sy, 0.99);
  // About two entities per cell, at most 1024 x 1024 cells.
  const side = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(n / 2))));
  const spanX = maxX > minX ? maxX - minX : 1;
  const spanY = maxY > minY ? maxY - minY : 1;
  const nx = side;
  const ny = side;
  const cw = spanX / nx;
  const ch = spanY / ny;
  const cx = (x: number) => Math.min(nx - 1, Math.max(0, Math.floor((x - minX) / cw)));
  const cy = (y: number) => Math.min(ny - 1, Math.max(0, Math.floor((y - minY) / ch)));

  // Compressed rows: count per cell, prefix sums, then fill.
  const always: number[] = [];
  const counts = new Int32Array(nx * ny + 1);
  const span = new Int32Array(n * 4).fill(-1);
  for (let i = 0; i < n; i += 1) {
    const b = bounds[i]!;
    if (!finite(b)) {
      always.push(i);
      continue;
    }
    const x0 = cx(b.min.x);
    const x1 = cx(b.max.x);
    const y0 = cy(b.min.y);
    const y1 = cy(b.max.y);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS_PER_ENTITY) {
      always.push(i);
      continue;
    }
    span[i * 4] = x0;
    span[i * 4 + 1] = x1;
    span[i * 4 + 2] = y0;
    span[i * 4 + 3] = y1;
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) counts[y * nx + x + 1]! += 1;
  }
  for (let c = 1; c < counts.length; c += 1) counts[c]! += counts[c - 1]!;
  const items = new Int32Array(counts[counts.length - 1]!);
  const fill = counts.slice(0, nx * ny);
  for (let i = 0; i < n; i += 1) {
    const x0 = span[i * 4]!;
    if (x0 < 0) continue;
    const x1 = span[i * 4 + 1]!;
    const y0 = span[i * 4 + 2]!;
    const y1 = span[i * 4 + 3]!;
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) items[fill[y * nx + x]!++] = i;
  }

  const stamps = new Uint32Array(n);
  let stamp = 0;
  return {
    entities,
    lookup,
    bounds,
    blockDeps,
    maxArcRadius,
    query(box: Bounds): number[] | null {
      const nan = Number.isNaN(box.min.x + box.min.y + box.max.x + box.max.y);
      if (!nan && cx(box.min.x) === 0 && cy(box.min.y) === 0 && cx(box.max.x) === nx - 1 && cy(box.max.y) === ny - 1) return null;
      stamp += 1;
      if (stamp === 0xffffffff) {
        stamps.fill(0);
        stamp = 1;
      }
      const out: number[] = [];
      for (const i of always) {
        stamps[i] = stamp;
        out.push(i);
      }
      // NaN never matches anything (like the linear scan's comparisons).
      if (!nan) {
        const x0 = cx(box.min.x);
        const x1 = cx(box.max.x);
        const y0 = cy(box.min.y);
        const y1 = cy(box.max.y);
        for (let y = y0; y <= y1; y += 1) {
          for (let x = x0; x <= x1; x += 1) {
            const c = y * nx + x;
            for (let k = counts[c]!; k < counts[c + 1]!; k += 1) {
              const i = items[k]!;
              if (stamps[i] === stamp) continue;
              stamps[i] = stamp;
              out.push(i);
            }
          }
        }
      }
      if (out.length * 16 < n) return out.sort((a, b) => a - b);
      // Many candidates: one ordered pass over the marks is cheaper than sorting them.
      const ordered: number[] = [];
      for (let i = 0; i < n; i += 1) if (stamps[i] === stamp) ordered.push(i);
      return ordered;
    },
  };
}

function current(idx: GridIndex, lookup: BlockLookup): boolean {
  if (idx.lookup !== lookup) return false;
  for (const [name, def] of idx.blockDeps) if (lookup(name) !== def) return false;
  return true;
}

/**
 * The index for this entities array, or null when the linear scan should be used (index turned
 * off, a small drawing, or the first query of a new array).
 */
export function spatialIndexFor(entities: readonly Entity[], lookup: BlockLookup): SpatialIndex | null {
  if (!spatialIndexSettings.enabled || entities.length < spatialIndexSettings.minEntities) return null;
  const hit = cache.get(entities);
  if (hit && current(hit, lookup)) return hit;
  if (!hit && !seen.has(entities)) {
    seen.add(entities);
    return null;
  }
  const idx = build(entities, lookup);
  cache.set(entities, idx);
  return idx;
}

/** Build (or fetch) the index now, e.g. right after a drawing is loaded. */
export function warmSpatialIndex(entities: readonly Entity[], lookup: BlockLookup): SpatialIndex | null {
  if (!spatialIndexSettings.enabled || entities.length < spatialIndexSettings.minEntities) return null;
  seen.add(entities);
  return spatialIndexFor(entities, lookup);
}
