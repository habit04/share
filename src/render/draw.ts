import type { Entity, BlockLookup, Layer } from '../core/entities';
import { explodeInsert, entityBounds } from '../core/entities';
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import { aciToCss } from './palette';

export interface Transform {
  toScreen(p: Point): Point;
  scale: number; // px per world unit
}

export interface DrawStyle {
  strokeOverride?: string;
  lineWidthOverride?: number;
  dashed?: boolean;
  alpha?: number;
}

export function resolveColor(e: Entity, layers: readonly Layer[]): string {
  if (e.color !== 'ByLayer') return aciToCss(e.color);
  const layer = layers.find((l) => l.name === e.layer);
  return aciToCss(layer?.color ?? 7);
}

export function resolveLineWidth(e: Entity, layers: readonly Layer[], tf: Transform): number {
  const layer = layers.find((l) => l.name === e.layer);
  const mm = layer?.lineWeight ?? 0.25;
  // lineweight display: 0.25mm ≈ 1px at normal zoom; scale gently with zoom
  const px = Math.max(1, (mm / 0.25) * Math.min(2, Math.max(1, tf.scale / 60)));
  return px;
}

/** Draw a single entity. Inserts are exploded recursively. */
export function drawEntity(
  ctx: CanvasRenderingContext2D,
  e: Entity,
  tf: Transform,
  layers: readonly Layer[],
  lookup: BlockLookup,
  style: DrawStyle = {},
): void {
  const color = style.strokeOverride ?? resolveColor(e, layers);
  const width = style.lineWidthOverride ?? resolveLineWidth(e, layers, tf);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (style.alpha !== undefined) ctx.globalAlpha = style.alpha;
  if (style.dashed) ctx.setLineDash([6, 4]);
  drawGeometry(ctx, e, tf, layers, lookup, style);
  ctx.restore();
}

function drawGeometry(
  ctx: CanvasRenderingContext2D,
  e: Entity,
  tf: Transform,
  layers: readonly Layer[],
  lookup: BlockLookup,
  style: DrawStyle,
): void {
  switch (e.type) {
    case 'line': {
      const a = tf.toScreen(e.a);
      const b = tf.toScreen(e.b);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      break;
    }
    case 'circle': {
      const c = tf.toScreen(e.center);
      ctx.beginPath();
      ctx.arc(c.x, c.y, e.radius * tf.scale, 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case 'arc': {
      const c = tf.toScreen(e.center);
      // screen Y is flipped, so a CCW world arc is drawn CW-in-canvas terms with negated angles
      ctx.beginPath();
      ctx.arc(c.x, c.y, e.radius * tf.scale, -e.startAngle, -e.endAngle, true);
      ctx.stroke();
      break;
    }
    case 'polyline': {
      if (e.points.length === 0) break;
      ctx.beginPath();
      const p0 = tf.toScreen(e.points[0]!);
      ctx.moveTo(p0.x, p0.y);
      for (let i = 1; i < e.points.length; i += 1) {
        const p = tf.toScreen(e.points[i]!);
        ctx.lineTo(p.x, p.y);
      }
      if (e.closed) ctx.closePath();
      ctx.stroke();
      break;
    }
    case 'text': {
      const p = tf.toScreen(e.position);
      const px = e.height * tf.scale;
      if (px < 2) {
        // too small: draw a placeholder line like AutoCAD's QTEXT
        const w = e.text.length * px * 0.7;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x + w, p.y);
        ctx.stroke();
        break;
      }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(-e.rotation);
      ctx.font = `${px}px "Cascadia Mono", "Consolas", "DejaVu Sans Mono", monospace`;
      ctx.textBaseline = 'alphabetic';
      ctx.textAlign = e.align;
      ctx.fillText(e.text, 0, 0);
      ctx.restore();
      break;
    }
    case 'insert': {
      for (const sub of explodeInsert(e, lookup)) {
        const subColor = style.strokeOverride ?? resolveColor(sub, layers);
        ctx.strokeStyle = subColor;
        ctx.fillStyle = subColor;
        drawGeometry(ctx, sub, tf, layers, lookup, style);
      }
      break;
    }
  }
}

/** Draw a set of entities into an arbitrary canvas fitted to their bounds (for previews). */
export function drawPreview(
  ctx: CanvasRenderingContext2D,
  entities: readonly Entity[],
  layers: readonly Layer[],
  lookup: BlockLookup,
  width: number,
  height: number,
  color = '#e6e6e6',
  padding = 8,
): void {
  let b: g.Bounds | null = null;
  for (const e of entities) b = g.unionBounds(b, entityBounds(e, lookup));
  if (!b) return;
  const bw = Math.max(b.max.x - b.min.x, 1e-6);
  const bh = Math.max(b.max.y - b.min.y, 1e-6);
  const s = Math.min((width - padding * 2) / bw, (height - padding * 2) / bh);
  const cx = (b.min.x + b.max.x) / 2;
  const cy = (b.min.y + b.max.y) / 2;
  const tf: Transform = {
    scale: s,
    toScreen: (p) => ({ x: width / 2 + (p.x - cx) * s, y: height / 2 - (p.y - cy) * s }),
  };
  for (const e of entities) drawEntity(ctx, e, tf, layers, lookup, { strokeOverride: color, lineWidthOverride: 1.4 });
}
