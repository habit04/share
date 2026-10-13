/** Explicit edit intent keeps opaque metadata outside geometry helpers. */
import type { Entity } from '../core/entities';
import type { Point } from '../core/geometry';
import { CadGraphError, type CadAffineTransform, type CadAnchor, type CadCloneBatch, type CadGraphEditIntent } from '../core/cad-graph';
import { isViewportFrame } from '../core/layouts';

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
  if (source.length !== copies.length) throw new CadGraphError('copy', 'A CAD copy batch needs one destination per source entity.');
  const entityIds: Record<string, string> = {}, anchorRemaps: { from: CadAnchor; to: CadAnchor }[] = [];
  const add = (from: string, to: string) => {
    if (entityIds[from] && entityIds[from] !== to) throw new CadGraphError('copy', 'A shared clip needs a separate CAD copy batch for each destination.');
    entityIds[from] = to;
  };
  source.forEach((entity, index) => {
    const copy = copies[index]!;
    if (!isViewportFrame(entity)) { add(entity.id, copy.id); return; }
    if (!isViewportFrame(copy)) throw new CadGraphError('copy', 'A retained viewport must be copied with its viewport frame.');
    anchorRemaps.push({ from: { kind: 'viewport', id: entity.id }, to: { kind: 'viewport', id: copy.id } });
    const boundary = entity.vport.clipBoundary;
    if (boundary) {
      if (!copy.vport.clipBoundary) throw new CadGraphError('copy', 'A retained viewport clip cannot be discarded by a copy.');
      // viewportFromFrame derives the same distinct identity when folding a copy.
      add(boundary.id, copy.id === copy.vport.id ? copy.vport.clipBoundary.id : `${copy.id}:clip`);
    }
  });
  return { entityIds, ...(anchorRemaps.length ? { anchorRemaps } : {}), ...(transform ? { transform } : {}) };
}
export const cadTransformIntent = (entities: readonly Entity[], transform: CadAffineTransform): CadGraphEditIntent => ({ transforms: [{
  entityIds: [...new Set(entities.flatMap(entity => isViewportFrame(entity) && entity.vport.clipBoundary ? [entity.id, entity.vport.clipBoundary.id] : [entity.id]))], transform,
}] });
