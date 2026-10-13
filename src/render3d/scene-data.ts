/**
 * Pure builders for the 3D viewport's GPU data (no WebGL here, so it is unit-tested in Node):
 * de-indexed flat-shaded solid vertices, feature edges, grid lines, line batches from a SceneSink,
 * and colour parsing.
 *
 * Precision convention: vertex positions are stored as float32 relative to a per-batch `origin`
 * (kept in float64). The renderer draws each batch with the uniform offset (origin - camera
 * target) and a view matrix relative to the target (`cameraViewRelative`), so geometry far from
 * the world origin (site coordinates) does not jitter.
 */
import type { Layer } from '../core/entities';
import { aciToCss } from '../render/palette';
import { trueColorCss } from '../render/draw';
import { type Aabb, type Vec3, aabbCenter, v3 } from '../model3d/math';
import { type Mesh3D, flatNormals, meshBounds, meshTriangleCount } from '../model3d/mesh';
import type { Solid3D } from '../model3d/types';
import type { SceneSink, SinkStyle } from './scene-sink';

/** Linear RGBA in [0, 1]. */
export type Rgba = readonly [number, number, number, number];

/** Parse "#rgb", "#rrggbb" or "rgb(r, g, b)" / "rgba(r, g, b, a)"; `fallback` for anything else. */
export function parseCssColor(css: string, fallback: Rgba = [1, 1, 1, 1]): Rgba {
  const s = css.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const h = m[1]!;
    return [parseInt(h[0]! + h[0]!, 16) / 255, parseInt(h[1]! + h[1]!, 16) / 255, parseInt(h[2]! + h[2]!, 16) / 255, 1];
  }
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) {
    const n = parseInt(m[1]!, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1];
  }
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(s);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] === undefined ? 1 : Number(m[4])];
  return fallback;
}

/**
 * Display colour of a solid, by the same rules as the 2D `resolveColor` (ACI colour, or ByLayer:
 * the layer's true colour or ACI; ByBlock / 0 shows as the foreground colour 7).
 */
export function solidDisplayColor(solid: Pick<Solid3D, 'layer' | 'color'>, layers: readonly Layer[]): string {
  if (solid.color !== 'ByLayer') return aciToCss(solid.color === 0 ? 7 : solid.color);
  const layer = layers.find((l) => l.name === solid.layer);
  if (layer?.trueColor !== undefined) return trueColorCss(layer.trueColor);
  return aciToCss(layer?.color ?? 7);
}

/** Flat-shaded solid vertices: per triangle corner x, y, z (relative to `origin`), nx, ny, nz. */
export interface SolidVertices {
  readonly data: Float32Array;
  readonly vertexCount: number;
  readonly origin: Vec3;
  readonly bounds: Aabb | null;
}

/**
 * De-index a mesh for flat shading: three vertices per triangle, each carrying the triangle's
 * normal from `flatNormals` (so shared vertices do not smooth the shading across edges).
 */
export function solidVertices(mesh: Mesh3D): SolidVertices {
  const bounds = meshBounds(mesh);
  const origin = bounds ? aabbCenter(bounds) : v3(0, 0, 0);
  const n = meshTriangleCount(mesh);
  const nrm = flatNormals(mesh);
  const data = new Float32Array(n * 3 * 6);
  const p = mesh.positions, idx = mesh.indices;
  let o = 0;
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const v = idx[t * 3 + k]! * 3;
      data[o++] = p[v]! - origin.x;
      data[o++] = p[v + 1]! - origin.y;
      data[o++] = p[v + 2]! - origin.z;
      data[o++] = nrm[t * 3]!;
      data[o++] = nrm[t * 3 + 1]!;
      data[o++] = nrm[t * 3 + 2]!;
    }
  }
  return { data, vertexCount: n * 3, origin, bounds };
}

/** Faces meeting at more than this angle show their shared edge (30 degrees). */
export const FEATURE_EDGE_COS = Math.cos((30 * Math.PI) / 180);

/**
 * Feature edges of a mesh as segment endpoints (x, y, z relative to `origin`, two vertices per
 * edge): boundary edges (one triangle), non-manifold edges (three or more) and edges between faces
 * whose normals differ by more than 30 degrees. Topology is by vertex index (weld first).
 */
export function featureEdges(mesh: Mesh3D, origin: Vec3): Float32Array {
  const idx = mesh.indices, p = mesh.positions;
  const nrm = flatNormals(mesh);
  const nv = Math.floor(p.length / 3);
  const faces = new Map<number, number[]>();
  const n = meshTriangleCount(mesh);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t * 3 + k]!, b = idx[t * 3 + ((k + 1) % 3)]!;
      if (a === b) continue;
      const key = Math.min(a, b) * nv + Math.max(a, b);
      const list = faces.get(key);
      if (list) list.push(t);
      else faces.set(key, [t]);
    }
  }
  const out: number[] = [];
  for (const [key, tris] of faces) {
    let show = tris.length !== 2;
    if (!show) {
      const [t0, t1] = tris as [number, number];
      const d = nrm[t0 * 3]! * nrm[t1 * 3]! + nrm[t0 * 3 + 1]! * nrm[t1 * 3 + 1]! + nrm[t0 * 3 + 2]! * nrm[t1 * 3 + 2]!;
      show = d < FEATURE_EDGE_COS;
    }
    if (!show) continue;
    const a = Math.floor(key / nv), b = key - a * nv;
    out.push(p[a * 3]! - origin.x, p[a * 3 + 1]! - origin.y, p[a * 3 + 2]! - origin.z, p[b * 3]! - origin.x, p[b * 3 + 1]! - origin.y, p[b * 3 + 2]! - origin.z);
  }
  return Float32Array.from(out);
}

/**
 * Accumulates coloured line segments (a SceneSink), then packs them as float32 vertices
 * x, y, z (relative to the bounds centre), r, g, b, a. Polygons become closed outlines.
 */
export class LineBatchBuilder implements SceneSink {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private readonly colors = new Map<string, Rgba>();
  private minX = Infinity; private minY = Infinity; private minZ = Infinity;
  private maxX = -Infinity; private maxY = -Infinity; private maxZ = -Infinity;

  /** Number of segments so far. */
  get segmentCount(): number {
    return this.pos.length / 6;
  }

  line(a: Vec3, b: Vec3, style: SinkStyle | { readonly color: string }): void {
    this.add(a, b, this.rgba(style.color));
  }

  polygon(points: readonly Vec3[], style: SinkStyle): void {
    if (points.length < 2) return;
    const c = this.rgba(style.color);
    for (let i = 0; i < points.length; i++) this.add(points[i]!, points[(i + 1) % points.length]!, c);
  }

  /** Add a segment with an explicit colour. Non-finite segments are skipped. */
  add(a: Vec3, b: Vec3, c: Rgba): void {
    if (!Number.isFinite(a.x + a.y + a.z + b.x + b.y + b.z)) return;
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z);
    this.col.push(c[0], c[1], c[2], c[3], c[0], c[1], c[2], c[3]);
    for (const q of [a, b]) {
      if (q.x < this.minX) this.minX = q.x; if (q.x > this.maxX) this.maxX = q.x;
      if (q.y < this.minY) this.minY = q.y; if (q.y > this.maxY) this.maxY = q.y;
      if (q.z < this.minZ) this.minZ = q.z; if (q.z > this.maxZ) this.maxZ = q.z;
    }
  }

  private rgba(css: string): Rgba {
    let c = this.colors.get(css);
    if (!c) {
      c = parseCssColor(css);
      this.colors.set(css, c);
    }
    return c;
  }

  /** Bounds of everything added, or null when empty. */
  bounds(): Aabb | null {
    if (!(this.minX <= this.maxX)) return null;
    return { min: v3(this.minX, this.minY, this.minZ), max: v3(this.maxX, this.maxY, this.maxZ) };
  }

  /** Pack the vertices (7 floats each, positions relative to the returned origin). */
  build(): { data: Float32Array; vertexCount: number; origin: Vec3; bounds: Aabb | null } {
    const bounds = this.bounds();
    const origin = bounds ? aabbCenter(bounds) : v3(0, 0, 0);
    const n = this.pos.length / 3;
    const data = new Float32Array(n * 7);
    for (let i = 0; i < n; i++) {
      data[i * 7] = this.pos[i * 3]! - origin.x;
      data[i * 7 + 1] = this.pos[i * 3 + 1]! - origin.y;
      data[i * 7 + 2] = this.pos[i * 3 + 2]! - origin.z;
      data[i * 7 + 3] = this.col[i * 4]!;
      data[i * 7 + 4] = this.col[i * 4 + 1]!;
      data[i * 7 + 5] = this.col[i * 4 + 2]!;
      data[i * 7 + 6] = this.col[i * 4 + 3]!;
    }
    return { data, vertexCount: n, origin, bounds };
  }
}

/** The XY grid at z = 0 around a centre: spacing, extent and the line batch. */
export interface GridSpec {
  readonly center: Vec3;
  readonly half: number;
  readonly minor: number;
  readonly major: number;
}

/** Grid line colours (as in the 2D viewport: faint minor lines, brighter major lines). */
export const GRID_MINOR: Rgba = [1, 1, 1, 0.055];
export const GRID_MAJOR: Rgba = [1, 1, 1, 0.13];
export const AXIS_X: Rgba = [0.85, 0.25, 0.25, 0.6];
export const AXIS_Y: Rgba = [0.3, 0.8, 0.3, 0.6];
export const AXIS_Z: Rgba = [0.3, 0.45, 0.95, 0.8];

/** At most this many grid lines per direction (the spacing grows by 5x until it fits). */
export const MAX_GRID_LINES = 400;

/**
 * Grid layout like the 2D viewport's adaptive grid: the minor spacing starts at `gridSize` and is
 * multiplied by 5 until it is at least 10 px on screen (`pxPerUnit` at the target depth) and the
 * line count fits; major lines every 5 minor ones. The grid square is centred on (cx, cy) snapped
 * to the major spacing with half-size `half` (drawing units).
 */
export function gridSpec(cx: number, cy: number, half: number, gridSize: number, pxPerUnit: number): GridSpec | null {
  if (!(gridSize > 0) || !(half > 0) || !Number.isFinite(half) || !(pxPerUnit > 0)) return null;
  let step = gridSize;
  for (let i = 0; i < 60 && (step * pxPerUnit < 10 || (2 * half) / step > MAX_GRID_LINES); i++) step *= 5;
  const major = step * 5;
  const center = v3(Math.round(cx / major) * major, Math.round(cy / major) * major, 0);
  return { center, half: Math.ceil(half / major) * major, minor: step, major };
}

/**
 * Grid lines, the X / Y axis lines through the world origin (when they cross the grid square) and
 * a short Z axis at the origin, as a line batch (its origin is the centre of its bounds).
 */
export function gridLines(spec: GridSpec): ReturnType<LineBatchBuilder['build']> {
  const b = new LineBatchBuilder();
  const { center: c, half, minor, major } = spec;
  const lo = (v: number) => v - half, hi = (v: number) => v + half;
  const isMajor = (v: number) => Math.abs(v / major - Math.round(v / major)) < 1e-6;
  const count = Math.round((2 * half) / minor);
  for (let i = 0; i <= count; i++) {
    const x = lo(c.x) + i * minor, y = lo(c.y) + i * minor;
    const colX = Math.abs(x) < minor * 1e-6 ? null : isMajor(x) ? GRID_MAJOR : GRID_MINOR;
    const colY = Math.abs(y) < minor * 1e-6 ? null : isMajor(y) ? GRID_MAJOR : GRID_MINOR;
    if (colX) b.add(v3(x, lo(c.y), 0), v3(x, hi(c.y), 0), colX);
    if (colY) b.add(v3(lo(c.x), y, 0), v3(hi(c.x), y, 0), colY);
  }
  if (Math.abs(c.y) <= half) b.add(v3(lo(c.x), 0, 0), v3(hi(c.x), 0, 0), AXIS_X);
  if (Math.abs(c.x) <= half) b.add(v3(0, lo(c.y), 0), v3(0, hi(c.y), 0), AXIS_Y);
  if (Math.abs(c.x) <= half && Math.abs(c.y) <= half) b.add(v3(0, 0, 0), v3(0, 0, half * 0.25), AXIS_Z);
  return b.build();
}
