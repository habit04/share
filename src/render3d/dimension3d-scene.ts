/**
 * True 3D dimensions in the 3D view (docs/3D-DIMENSIONS.md): world-space display segments and the
 * CPU pick against them.
 *
 * `dimension3dGeometry` takes the 2D geometry of the dimension in its plane (src/model3d/
 * dimension3d.ts: `dimensionGeometry` of the equivalent 2D dimension) and maps every primitive to
 * world coordinates with the plane frame, through the same SceneSink adapter the 2D underlay uses
 * (`emitEntity`): lines, arrowheads, arcs (as the polylines the 2D code samples) and the text as
 * stroke-font segments, in the colours the 2D view gives the same dimension (dimension line,
 * extension line and text colour overrides of the style, ByLayer resolved against the layer
 * table). So a 3D dimension looks exactly like the 2D dimension of the same style drawn in its
 * plane.
 *
 * Picking (`pickDimension3D`) projects those segments to the screen and takes the dimension whose
 * nearest segment is within the aperture (CSS px); the GPU id buffer does not hold dimensions. The
 * hit's world point is compared with the solid face under the cursor along the cursor ray
 * (`dimensionInFront`): the nearer one wins, so a dimension hidden behind a solid is not picked
 * through it.
 */
import type { DimStyle } from '../core/dimension';
import type { Layer } from '../core/entities';
import { type Aabb, type Ray, type Vec3, aabbFromPoints, dot3, len3, lerp3, scale3, sub3 } from '../model3d/math';
import { dimension3dTo2d, planeWorld } from '../model3d/dimension3d';
import type { Dimension3D } from '../model3d/types';
import { type SceneSink, type SinkStyle, emitEntity, hiddenLayerNames } from './scene-sink';

/** One display segment of a 3D dimension (world coordinates, CSS colour). */
export interface Dimension3DSegment {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly color: string;
}

/** Emit `dim` into `sink` in world coordinates (its colours resolved against `layers`). */
export function emitDimension3D(dim: Dimension3D, sink: SceneSink, layers: readonly Layer[]): void {
  const f = dim.plane;
  const map = (q: Vec3) => planeWorld(f, q);
  const mapped: SceneSink = {
    line: (a, b, style) => sink.line(map(a), map(b), style),
    polygon: (points, style) => sink.polygon(points.map(map), style),
  };
  // Parts of dimensions have no block references, so the lookup is never used.
  emitEntity(dimension3dTo2d(dim), mapped, layers, () => undefined);
}

const cache = new WeakMap<Dimension3D, { layers: readonly Layer[]; segments: Dimension3DSegment[] }>();
/** The layer table used when none is given (ByLayer then shows as colour 7). */
const NO_LAYERS: readonly Layer[] = Object.freeze([]);

/**
 * The world-space display segments of a 3D dimension: the 2D dimension geometry of `style`
 * (default: the dimension's own) in its plane, mapped to world coordinates (closed outlines such as
 * arrowheads become their edges). Cached per dimension object and layer table.
 */
export function dimension3dGeometry(dim: Dimension3D, style: DimStyle = dim.style, layers: readonly Layer[] = NO_LAYERS): Dimension3DSegment[] {
  const own = style === dim.style;
  const hit = own ? cache.get(dim) : undefined;
  if (hit && hit.layers === layers) return hit.segments;
  const segments: Dimension3DSegment[] = [];
  const sink: SceneSink = {
    line: (a, b, s: SinkStyle) => void segments.push({ a, b, color: s.color }),
    polygon: (points, s: SinkStyle) => {
      for (let i = 0; i < points.length && points.length > 1; i++) segments.push({ a: points[i]!, b: points[(i + 1) % points.length]!, color: s.color });
    },
  };
  emitDimension3D(own ? dim : { ...dim, style }, sink, layers);
  if (own) cache.set(dim, { layers, segments });
  return segments;
}

/** World bounds of the dimension's display geometry (null when it draws nothing). */
export function dimension3dBounds(dim: Dimension3D, layers: readonly Layer[] = NO_LAYERS): Aabb | null {
  return aabbFromPoints(dimension3dGeometry(dim, dim.style, layers).flatMap((s) => [s.a, s.b]));
}

/** The dimensions of the model on visible layers (off / frozen layers hide them, as for solids). */
export function visibleDimensions3D(dims: readonly Dimension3D[] | undefined, layers: readonly Layer[]): readonly Dimension3D[] {
  if (!dims?.length) return [];
  const hidden = hiddenLayerNames(layers);
  return hidden.size ? dims.filter((d) => !hidden.has(d.layer)) : dims;
}

/** Distance from (px, py) to the segment a-b (screen coordinates) and the segment parameter there. */
function segmentDistance(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): { d: number; t: number } {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return { d: Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)), t };
}

/** A dimension under the cursor: its id and the world point of the nearest display segment. */
export interface Dimension3DHit {
  readonly id: string;
  readonly point: Vec3;
}

/**
 * The dimension whose display segments pass closest to screen point (sx, sy), within `aperture`
 * CSS px, with the world point there (interpolated along the segment), or null. `project` maps a
 * world point to CSS px (null behind the eye, which skips that segment).
 */
export function pickDimension3DHit(dims: readonly Dimension3D[], project: (p: Vec3) => { x: number; y: number } | null, sx: number, sy: number, aperture: number, layers: readonly Layer[] = NO_LAYERS): Dimension3DHit | null {
  let best: Dimension3DHit | null = null;
  let bestD = aperture;
  for (const d of dims) {
    for (const s of dimension3dGeometry(d, d.style, layers)) {
      const a = project(s.a), b = project(s.b);
      if (!a || !b) continue;
      const hit = segmentDistance(sx, sy, a, b);
      if (hit.d <= bestD) {
        bestD = hit.d;
        best = { id: d.id, point: lerp3(s.a, s.b, hit.t) };
      }
    }
  }
  return best;
}

/**
 * True when a dimension hit at `dimPoint` is not behind the solid face hit at `solidPoint` along
 * the cursor `ray` (so the dimension is picked). A dimension lying on the face counts as in front:
 * the tolerance is twice the dimension point's distance from the ray (the aperture slack, which
 * covers faces up to about 60 degrees oblique to the view) plus 1e-6 of the depth.
 */
export function dimensionInFront(dimPoint: Vec3, solidPoint: Vec3, ray: Ray): boolean {
  const len = len3(ray.dir);
  if (!(len > 0)) return true;
  const dir = scale3(ray.dir, 1 / len);
  const depth = (p: Vec3) => dot3(sub3(p, ray.origin), dir);
  const dd = depth(dimPoint), ds = depth(solidPoint);
  const off = len3(sub3(sub3(dimPoint, ray.origin), scale3(dir, dd)));
  return dd <= ds + 2 * off + 1e-6 * Math.max(1, Math.abs(ds));
}

/**
 * The id of the dimension whose display segments pass closest to screen point (sx, sy), within
 * `aperture` CSS px, or null. `project` maps a world point to CSS px (null behind the eye, which
 * skips that segment).
 */
export function pickDimension3D(dims: readonly Dimension3D[], project: (p: Vec3) => { x: number; y: number } | null, sx: number, sy: number, aperture: number, layers: readonly Layer[] = NO_LAYERS): string | null {
  return pickDimension3DHit(dims, project, sx, sy, aperture, layers)?.id ?? null;
}
