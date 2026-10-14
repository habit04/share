import * as g from './geometry';
import type { Point, Bounds } from './geometry';
import { mtextLayoutFull, type Measure, type MTextEntity, type MTextLayout } from './mtext';
import type { Entity, TextEntity } from './entities';

/** Includes MTEXT carried by a LEADER after its native annotation association is resolved. */
export const entityMTextBackground = (e: Entity) => e.type === 'mtext' ? e.background : e.type === 'leader' ? e.textBackground : undefined;

export const hasMTextFill = (m: MTextEntity): boolean => Boolean((m.background?.flags ?? 0) & 3);
export const hasMTextFrame = (m: MTextEntity): boolean => Boolean((m.background?.flags ?? 0) & 16);

/** One mask per populated column. Bounds use the same approximate text metrics as the layout. */
export function mtextBackgroundPolygons(m: MTextEntity, measure: Measure, layout: MTextLayout = mtextLayoutFull(m, measure), corners?: (text: TextEntity) => readonly Point[]): Point[][] {
  if (!m.background || (!hasMTextFill(m) && !hasMTextFrame(m))) return [];
  const boxes = new Map<number, Bounds>();
  const cols = m.columns;
  const local = (p: Point) => g.rotate(g.sub(p, m.position), -m.rotation);
  for (const t of layout.texts) {
    let index = 0;
    if (cols && cols.count > 1) {
      const prefix = `${m.id}:col`;
      if (t.id.startsWith(prefix)) index = Number(t.id.slice(prefix.length).split(':')[0]);
      if (!Number.isSafeInteger(index) || index < 0 || index >= Math.min(256, cols.count)) continue;
    }
    if (corners) {
      const bounds = g.boundsOfPoints(corners(t).map(local));
      if (bounds) boxes.set(index, g.unionBounds(boxes.get(index) ?? null, bounds)!);
      continue;
    }
    const p = local(t.position);
    const width = measure(t.text, t.height) * (t.widthFactor ?? 1);
    const x = p.x - (t.align === 'center' ? width / 2 : t.align === 'right' ? width : 0);
    const slant = Math.tan(t.oblique ?? 0) * t.height;
    const bounds = { min: { x: x + Math.min(0, slant), y: p.y }, max: { x: x + width + Math.max(0, slant), y: p.y + t.height } };
    boxes.set(index, g.unionBounds(boxes.get(index) ?? null, bounds)!);
  }
  const padding = (m.background.scale - 1) * m.height;
  const out: Point[][] = [];
  for (const [index, b] of boxes) {
    let left = b.min.x - padding;
    let right = b.max.x + padding;
    if (cols && cols.count > 1) {
      const total = cols.count * cols.width + (cols.count - 1) * cols.gutter;
      const attachment = (m.attachment - 1) % 3;
      const start = attachment === 0 ? 0 : attachment === 1 ? -total / 2 : -total;
      const physical = cols.reversed ? cols.count - 1 - index : index;
      const columnLeft = start + physical * (cols.width + cols.gutter);
      // Only the outer edges extend into the surrounding drawing, never into column gutters.
      if (physical > 0) left = Math.max(left, columnLeft);
      if (physical < cols.count - 1) right = Math.min(right, columnLeft + cols.width);
    }
    const poly = [{ x: left, y: b.min.y - padding }, { x: right, y: b.min.y - padding }, { x: right, y: b.max.y + padding }, { x: left, y: b.max.y + padding }].map((p) => g.add(m.position, g.rotate(p, m.rotation)));
    if (right >= left && poly.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) out.push(poly);
  }
  return out;
}

export function mtextBackgroundProblem(m: Pick<MTextEntity, 'background' | 'height'>): string | null {
  const bg = m.background;
  if (!bg) return null;
  if (!Number.isInteger(bg.flags) || bg.flags < 0 || bg.flags > 65535) return 'invalid MTEXT background flags';
  if (!(bg.scale >= 1 && bg.scale <= 5)) return 'MTEXT background scale must be between 1 and 5';
  if (!Number.isFinite((bg.scale - 1) * m.height)) return 'MTEXT background padding produces nonfinite geometry';
  if (bg.color !== 'ByLayer' && (!Number.isInteger(bg.color) || bg.color < 0 || bg.color > 255)) return 'invalid MTEXT background color';
  if (bg.trueColor !== undefined && (!Number.isInteger(bg.trueColor) || bg.trueColor < 0 || bg.trueColor > 0xffffff)) return 'invalid MTEXT background RGB';
  if (bg.transparency !== undefined && (!Number.isSafeInteger(bg.transparency) || bg.transparency < 0 || bg.transparency > 0xffffffff)) return 'invalid MTEXT background transparency';
  if (bg.colorName !== undefined && (typeof bg.colorName !== 'string' || /[\r\n\0]/.test(bg.colorName))) return 'invalid MTEXT background color name';
  return null;
}
