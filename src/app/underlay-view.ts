/**
 * The editor's visible-region supply for the underlay display service
 * (P28 finish, design section 4.2): the union, over every placement of one
 * definition in the active document, of the placement's visible part —
 * expressed in the engine's clip space (page units, top-left origin,
 * y-down). Pure geometry: page-size-first (the service's loaded size wins
 * over the stored extent), placements joined by upper-case definition
 * handle, mirrored placements normalized by construction (the inverse
 * transform divides by the signed scale and the interval is re-ordered).
 */
import { underlayCorners, type UnderlayDefinition } from '../core/underlay';
import { underlayPlacementOf, type UnderlayEntity } from '../core/entities';
import type { UnderlayClipRect } from '../io/underlay-engine';

export interface VisibleRegionView {
  /** The editor viewport's visible world bounds, when a view exists. */
  viewBounds(): { readonly min: { readonly x: number; readonly y: number }; readonly max: { readonly x: number; readonly y: number } } | undefined;
  /** The display service's loaded page size for a definition (page-size-first). */
  pageSizeOf(defId: string): { readonly width: number; readonly height: number } | undefined;
}

export function visibleRegionFor(
  view: VisibleRegionView,
  def: UnderlayDefinition,
  placements: readonly UnderlayEntity[],
): UnderlayClipRect | undefined {
  const bounds = view.viewBounds();
  if (!bounds) return undefined;
  const size = view.pageSizeOf(def.id) ?? def.extent;
  if (!size || !(size.width > 0) || !(size.height > 0)) return undefined;
  // Page-size-first: the frame itself is computed at the winning size (the
  // display path joins the true extent the same way, underlay-render.ts).
  const frameDef: UnderlayDefinition = { ...def, extent: size };
  let acc: UnderlayClipRect | undefined;
  for (const e of placements) {
    if ((e.definitionHandle ?? '').trim().toUpperCase() !== (def.handle ?? '').trim().toUpperCase()) continue;
    const p = underlayPlacementOf(e);
    // The world frame (AABB over the placed corners covers rotation).
    let corners;
    try {
      corners = underlayCorners(p, frameDef);
    } catch {
      continue; // a mismatched pair contributes nothing
    }
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const ix0 = Math.max(Math.min(...xs), bounds.min.x);
    const ix1 = Math.min(Math.max(...xs), bounds.max.x);
    const iy0 = Math.max(Math.min(...ys), bounds.min.y);
    const iy1 = Math.min(Math.max(...ys), bounds.max.y);
    if (!(ix1 > ix0) || !(iy1 > iy0)) continue; // no visible part
    // Inverse placement transform for the intersection's corners: un-translate,
    // un-rotate, un-scale (signed scale normalizes mirroring via min/max).
    const cos = Math.cos(-p.rotation);
    const sin = Math.sin(-p.rotation);
    const toLocal = (wx: number, wy: number): { x: number; y: number } => {
      const dx = wx - p.position.x;
      const dy = wy - p.position.y;
      return {
        x: (dx * cos - dy * sin) / p.scaleX,
        y: (dx * sin + dy * cos) / p.scaleY,
      };
    };
    const locals = [toLocal(ix0, iy0), toLocal(ix1, iy0), toLocal(ix1, iy1), toLocal(ix0, iy1)];
    const lx0 = Math.max(0, Math.min(...locals.map((l) => l.x)));
    const lx1 = Math.min(size.width, Math.max(...locals.map((l) => l.x)));
    const ly0 = Math.max(0, Math.min(...locals.map((l) => l.y)));
    const ly1 = Math.min(size.height, Math.max(...locals.map((l) => l.y)));
    if (!(lx1 > lx0) || !(ly1 > ly0)) continue;
    // Page space is y-down: local y (bottom-up) flips about the page height.
    const rect: UnderlayClipRect = { x: lx0, y: size.height - ly1, width: lx1 - lx0, height: ly1 - ly0 };
    acc = acc
      ? {
          x: Math.min(acc.x, rect.x),
          y: Math.min(acc.y, rect.y),
          width: Math.max(acc.x + acc.width, rect.x + rect.width) - Math.min(acc.x, rect.x),
          height: Math.max(acc.y + acc.height, rect.y + rect.height) - Math.min(acc.y, rect.y),
        }
      : rect;
  }
  return acc;
}
