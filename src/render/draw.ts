import type { Entity, BlockLookup, Layer, PolylineEntity, TextEntity, XlineEntity, RayEntity } from '../core/entities';
import { explodeInsert, entityBounds, polylineSegments, dimensionParts, mtextParts, ellipseSweep, isFullEllipse } from '../core/entities';
import type { Point, Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import { aciToCss } from './palette';
import { strokeText, hasStrokeFont, expandControlCodes } from './hershey';
import { findLinetype, effectiveLinetype, dashArray, type Linetype } from '../core/linetypes';

export interface Transform {
  toScreen(p: Point): Point;
  scale: number; // px per world unit
  /** Visible world area; used to clip construction lines. */
  viewBounds?: Bounds;
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

/** LWDISPLAY: when off (AutoCAD default) everything draws 1 px; when on, widths are fixed pixels per mm. */
export const lineweightDisplay = { enabled: false };

/**
 * Drawing-wide render variables the viewport copies from the document header
 * before each frame: LTSCALE, PDMODE/PDSIZE and any drawing-defined linetypes.
 */
export const renderSettings: { ltscale: number; pdmode: number; pdsize: number; linetypes: readonly Linetype[] } = {
  ltscale: 1,
  pdmode: 0,
  pdsize: 0,
  linetypes: [],
};

export function resolveLineWidth(e: Entity, layers: readonly Layer[], _tf: Transform): number {
  if (!lineweightDisplay.enabled) return 1;
  const layer = layers.find((l) => l.name === e.layer);
  const mm = e.lineWeight !== undefined && e.lineWeight >= 0 ? e.lineWeight : (layer?.lineWeight ?? 0.25);
  return Math.max(1, Math.round((mm / 0.25) * 10) / 10);
}

/** Canvas dash array for an entity at the current zoom ([] = continuous). */
export function resolveDash(e: Entity, layers: readonly Layer[], tf: Transform): number[] {
  const layer = layers.find((l) => l.name === e.layer);
  const name = effectiveLinetype(e.linetype, layer?.linetype);
  const lt = findLinetype(name, renderSettings.linetypes);
  if (!lt || lt.pattern.length === 0) return [];
  return dashArray(lt.pattern, renderSettings.ltscale * (e.ltscale ?? 1), tf.scale);
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
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  if (style.alpha !== undefined) ctx.globalAlpha = style.alpha;
  if (style.dashed) ctx.setLineDash([6, 4]);
  else ctx.setLineDash(resolveDash(e, layers, tf));
  drawGeometry(ctx, e, tf, layers, lookup, style);
  ctx.restore();
}

/** Clip an infinite / semi-infinite line to the view (or a large span) and return its screen endpoints. */
function constructionLineEnds(e: XlineEntity | RayEntity, tf: Transform): [Point, Point] | null {
  const d = g.normalize(e.direction);
  const vb = tf.viewBounds;
  let tMin = e.type === 'ray' ? 0 : -1e6;
  let tMax = 1e6;
  if (vb) {
    // Liang–Barsky style parametric clip against the view rectangle (padded)
    const pad = Math.max(vb.max.x - vb.min.x, vb.max.y - vb.min.y);
    const box = { min: { x: vb.min.x - pad, y: vb.min.y - pad }, max: { x: vb.max.x + pad, y: vb.max.y + pad } };
    for (const [p0, dir, lo, hi] of [
      [e.base.x, d.x, box.min.x, box.max.x],
      [e.base.y, d.y, box.min.y, box.max.y],
    ] as Array<[number, number, number, number]>) {
      if (Math.abs(dir) < 1e-12) {
        if (p0 < lo || p0 > hi) return null;
        continue;
      }
      let t1 = (lo - p0) / dir;
      let t2 = (hi - p0) / dir;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tMin = Math.max(tMin, t1);
      tMax = Math.min(tMax, t2);
    }
    if (tMin > tMax) return null;
  }
  return [g.add(e.base, g.scale(d, tMin)), g.add(e.base, g.scale(d, tMax))];
}

function strokePolyline(ctx: CanvasRenderingContext2D, e: PolylineEntity, tf: Transform): void {
  if (e.points.length === 0) return;
  ctx.beginPath();
  const p0 = tf.toScreen(e.points[0]!);
  ctx.moveTo(p0.x, p0.y);
  for (const s of polylineSegments(e)) {
    if (s.arc) {
      const c = tf.toScreen(s.arc.center);
      ctx.arc(c.x, c.y, s.arc.radius * tf.scale, -s.arc.startAngle, -s.arc.endAngle, true);
    } else {
      const p = tf.toScreen(s.b);
      ctx.lineTo(p.x, p.y);
    }
  }
  if (e.closed) ctx.closePath();
}

function drawText(ctx: CanvasRenderingContext2D, e: TextEntity, tf: Transform): void {
  const p = tf.toScreen(e.position);
  const px = e.height * tf.scale;
  if (px < 2.5) {
    // too small to read: draw a placeholder bar like AutoCAD's QTEXT
    const w = e.text.length * px * 0.8;
    const c = Math.cos(e.rotation);
    const sn = Math.sin(e.rotation);
    const off = e.align === 'center' ? -w / 2 : e.align === 'right' ? -w : 0;
    ctx.beginPath();
    ctx.moveTo(p.x + off * c, p.y - off * sn);
    ctx.lineTo(p.x + (off + w) * c, p.y - (off + w) * sn);
    ctx.stroke();
    return;
  }
  if (hasStrokeFont) {
    ctx.beginPath();
    for (const stroke of strokeText(e.text, e.position, e.height, e.rotation, e.align)) {
      for (let i = 0; i < stroke.length; i += 1) {
        const sp = tf.toScreen(stroke[i]!);
        if (i === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      }
    }
    ctx.stroke();
    return;
  }
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(-e.rotation);
  ctx.font = `${px}px "Cascadia Mono", "Consolas", "DejaVu Sans Mono", monospace`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = e.align;
  ctx.fillText(expandControlCodes(e.text), 0, 0);
  ctx.restore();
}

/** PDMODE point marker. Size: PDSIZE > 0 absolute, 0 = 5% of view height, < 0 = percent of view height. */
function drawPointMarker(ctx: CanvasRenderingContext2D, pos: Point, tf: Transform): void {
  const s = tf.toScreen(pos);
  const mode = renderSettings.pdmode;
  const viewH = tf.viewBounds ? (tf.viewBounds.max.y - tf.viewBounds.min.y) * tf.scale : 600;
  const size = renderSettings.pdsize > 0 ? renderSettings.pdsize * tf.scale : (viewH * (renderSettings.pdsize < 0 ? -renderSettings.pdsize : 5)) / 100;
  const h = Math.max(3, size / 2);
  const x = Math.round(s.x) + 0.5;
  const y = Math.round(s.y) + 0.5;
  const shape = mode % 32;
  const addCircle = (mode & 32) !== 0;
  const addSquare = (mode & 64) !== 0;
  ctx.setLineDash([]);
  ctx.beginPath();
  if (shape === 1) {
    /* nothing */
  } else if (shape === 2) {
    ctx.moveTo(x - h, y);
    ctx.lineTo(x + h, y);
    ctx.moveTo(x, y - h);
    ctx.lineTo(x, y + h);
  } else if (shape === 3) {
    ctx.moveTo(x - h, y - h);
    ctx.lineTo(x + h, y + h);
    ctx.moveTo(x - h, y + h);
    ctx.lineTo(x + h, y - h);
  } else if (shape === 4) {
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - h);
  } else {
    // 0: a dot
    ctx.rect(x - 1, y - 1, 2, 2);
    ctx.fill();
  }
  if (addCircle) ctx.arc(x, y, h, 0, Math.PI * 2);
  if (addSquare) ctx.rect(x - h, y - h, 2 * h, 2 * h);
  ctx.stroke();
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
      if (e.filled) ctx.fill();
      else ctx.stroke();
      break;
    }
    case 'arc': {
      const c = tf.toScreen(e.center);
      // screen Y is flipped, so a CCW world arc is drawn CW-in-canvas terms with negated angles
      ctx.beginPath();
      if (g.normAngle(e.endAngle - e.startAngle) < g.EPS) ctx.arc(c.x, c.y, e.radius * tf.scale, 0, Math.PI * 2);
      else ctx.arc(c.x, c.y, e.radius * tf.scale, -e.startAngle, -e.endAngle, true);
      ctx.stroke();
      break;
    }
    case 'polyline': {
      if (e.points.length === 0) break;
      strokePolyline(ctx, e, tf);
      if (e.filled && e.closed) {
        ctx.fill();
        break;
      }
      if (e.width && e.width > 0) {
        const px = e.width * tf.scale;
        if (px > (style.lineWidthOverride ?? 1)) {
          ctx.save();
          ctx.lineWidth = px;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'butt';
          ctx.stroke();
          ctx.restore();
          break;
        }
      }
      ctx.stroke();
      break;
    }
    case 'text':
      drawText(ctx, e, tf);
      break;
    case 'insert': {
      for (const sub of explodeInsert(e, lookup)) {
        const subColor = style.strokeOverride ?? resolveColor(sub, layers);
        ctx.strokeStyle = subColor;
        ctx.fillStyle = subColor;
        if (!style.dashed) ctx.setLineDash(resolveDash(sub, layers, tf));
        drawGeometry(ctx, sub, tf, layers, lookup, style);
      }
      break;
    }
    case 'ellipse': {
      const c = tf.toScreen(e.center);
      const a = g.len(e.majorAxis) * tf.scale;
      const b = a * e.ratio;
      const rot = Math.atan2(e.majorAxis.y, e.majorAxis.x);
      ctx.beginPath();
      if (isFullEllipse(e)) ctx.ellipse(c.x, c.y, a, b, -rot, 0, Math.PI * 2);
      else ctx.ellipse(c.x, c.y, a, b, -rot, -e.startParam, -(e.startParam + ellipseSweep(e)), true);
      ctx.stroke();
      break;
    }
    case 'point':
      drawPointMarker(ctx, e.position, tf);
      break;
    case 'xline':
    case 'ray': {
      const ends = constructionLineEnds(e, tf);
      if (!ends) break;
      const a = tf.toScreen(ends[0]);
      const b = tf.toScreen(ends[1]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      break;
    }
    case 'mtext':
      for (const t of mtextParts(e)) drawText(ctx, t, tf);
      break;
    case 'dimension':
      for (const part of dimensionParts(e)) drawGeometry(ctx, part, tf, layers, lookup, style);
      break;
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
  for (const e of entities) drawEntity(ctx, e, tf, layers, lookup, { strokeOverride: color, lineWidthOverride: 1 });
}
