import type { Point } from '../core/geometry';

interface ViewPoint { x: number; y: number; z?: number }

/** VIEWPORT 12/22 is DCS; the drawing model keeps the WCS point at the view's centre. */
export function importViewportView(displayCenter: Point, target: ViewPoint | undefined, direction: ViewPoint | undefined, twist: number, flags: number): { center: Point; twist: number; warnings: string[] } | null {
  const t = target ?? { x: 0, y: 0 };
  if (![displayCenter.x, displayCenter.y, t.x, t.y, t.z ?? 0].every(Number.isFinite)) return null;
  const warnings: string[] = [];
  const d = direction ?? { x: 0, y: 0, z: 1 };
  const z = d.z ?? 0;
  const top = [d.x, d.y, z].every(Number.isFinite) && z > 0 && Math.abs(d.x / z) <= 1e-9 && Math.abs(d.y / z) <= 1e-9;
  const perspective = !!(flags & 1);
  if (!top) warnings.push('its 3D or reversed view direction is shown as a planar top view');
  if (perspective) warnings.push('its perspective view is shown as a planar orthographic view');
  if (!Number.isFinite(twist)) warnings.push('its invalid view twist angle is shown untwisted');
  else if ((!top || perspective) && twist !== 0) warnings.push('its twisted 3D or perspective view is shown untwisted');
  const angle = top && !perspective && Number.isFinite(twist) ? twist % (2 * Math.PI) : 0;
  // Autodesk's DCS->WCS matrix rotates by -ViewTwist around +Z, then translates by target.
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const center = { x: t.x + displayCenter.x * cos + displayCenter.y * sin, y: t.y - displayCenter.x * sin + displayCenter.y * cos };
  if (![center.x, center.y].every(Number.isFinite)) return null;
  return { center, twist: angle, warnings };
}
