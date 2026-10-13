/** Explicit edit intent keeps opaque metadata outside geometry helpers. */
import type { Entity } from '../core/entities';
import type { Point } from '../core/geometry';
import type { CadAffineTransform, CadCloneBatch, CadGraphEditIntent } from '../core/cad-graph';

export const cadTranslation = (d: Point): CadAffineTransform => ({ xx: 1, xy: 0, yx: 0, yy: 1, tx: d.x, ty: d.y });
export function cadRotation(base: Point, angle: number, scale = 1): CadAffineTransform {
  const c = Math.cos(angle) * scale, s = Math.sin(angle) * scale;
  return { xx: c, xy: -s, yx: s, yy: c, tx: base.x - c * base.x + s * base.y, ty: base.y - s * base.x - c * base.y, zz: scale, distanceScale: Math.abs(scale) };
}
export const cadScale = (base: Point, scale: number): CadAffineTransform => cadRotation(base, 0, scale);
export function cadMirror(a: Point, b: Point): CadAffineTransform {
  const length = Math.hypot(b.x - a.x, b.y - a.y), u = (b.x - a.x) / length, v = (b.y - a.y) / length;
  const xx = 2 * u * u - 1, xy = 2 * u * v, yy = 2 * v * v - 1;
  return { xx, xy, yx: xy, yy, tx: a.x - xx * a.x - xy * a.y, ty: a.y - xy * a.x - yy * a.y, distanceScale: 1 };
}
export function cadCloneBatch(source: readonly Entity[], copies: readonly Entity[], transform?: CadAffineTransform): CadCloneBatch {
  return { entityIds: Object.fromEntries(source.map((entity, index) => [entity.id, copies[index]!.id])), ...(transform ? { transform } : {}) };
}
export const cadTransformIntent = (entities: readonly Entity[], transform: CadAffineTransform): CadGraphEditIntent => ({ transforms: [{ entityIds: entities.map(entity => entity.id), transform }] });
