import type { Point } from '../core/geometry';
import * as g from '../core/geometry';

/**
 * Parse AutoCAD-style coordinate input.
 *   "x,y"      absolute
 *   "@dx,dy"   relative to `base`
 *   "d<a"      polar from origin, "@d<a" polar from `base` (angle in degrees)
 * Returns null when the text is not a coordinate.
 */
export function parsePointInput(text: string, base: Point): Point | null {
  const t = text.replace(/\s+/g, '');
  const rel = t.startsWith('@');
  const body = rel ? t.slice(1) : t;
  const numRe = '(-?(?:\\d+\\.?\\d*|\\.\\d+))';
  let m = new RegExp(`^${numRe}<${numRe}$`).exec(body);
  if (m) {
    const d = parseFloat(m[1]!);
    const a = g.rad(parseFloat(m[2]!));
    if (!Number.isFinite(d) || !Number.isFinite(a)) return null;
    return g.polar(rel ? base : { x: 0, y: 0 }, a, d);
  }
  m = new RegExp(`^${numRe},${numRe}$`).exec(body);
  if (m) {
    const x = parseFloat(m[1]!);
    const y = parseFloat(m[2]!);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return rel ? { x: base.x + x, y: base.y + y } : { x, y };
  }
  return null;
}

/** Plain number (direct distance entry)? */
export function isPlainNumber(text: string): boolean {
  return /^-?(\d+\.?\d*|\.\d+)$/.test(text.trim());
}
