import type { Point, Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity } from '../core/entities';
import { gripPoints } from '../core/entities';
import type { Drawing } from '../core/document';
import type { SnapResult } from '../core/snap';
import { drawEntity, type Transform } from './draw';

export interface ViewportOverlay {
  /** Entities being constructed (rubber band). */
  preview: readonly Entity[];
  /** Ghost entities (e.g. move/copy preview) drawn dashed. */
  ghost: readonly Entity[];
  /** Selected entity ids. */
  selection: ReadonlySet<string>;
  /** Entity currently under cursor (rollover highlight). */
  hover: string | null;
  /** Window/crossing selection rectangle in world coords. */
  selectionBox: { a: Point; b: Point; mode: 'window' | 'crossing' } | null;
  /** Active snap marker. */
  snap: SnapResult | null;
  /** Cursor in world coords (null when outside canvas). */
  cursor: Point | null;
  /** Tracking line from a base point (ortho/polar). */
  trackFrom: Point | null;
  /** Dynamic input text near cursor. */
  dynText: string[];
  /** idle: crosshair + pickbox, point: crosshair only, select: pickbox only (AutoCAD prompt states). */
  cursorMode: 'idle' | 'point' | 'select';
}

export interface ViewSettings {
  gridVisible: boolean;
  gridSize: number;
  background: string;
  crosshairSize: number; // percent of screen (AutoCAD 5..100)
  pickBox: number; // px
  // Optional appearance overrides driven by the Options dialog (defaults keep the classic look).
  crosshairColor?: string;
  gridStyle?: 'lines' | 'dots';
  gripSize?: number; // half-size in px
  gripColor?: string;
  snapMarkerSize?: number; // px
  snapMarkerColor?: string;
  selectionEffect?: 'dashed' | 'solid';
}

export class Viewport {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** px per world unit */
  scale = 80;
  /** world coordinate at canvas centre */
  center: Point = { x: 5, y: 4 };
  width = 1;
  height = 1;
  dpr = 1;
  settings: ViewSettings = { gridVisible: true, gridSize: 0.5, background: '#212830', crosshairSize: 5, pickBox: 3 };
  private raf = 0;

  constructor(canvas: HTMLCanvasElement, private doc: Drawing) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unsupported');
    this.ctx = ctx;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
  }

  get transform(): Transform {
    return { scale: this.scale, toScreen: (p) => this.toScreen(p) };
  }

  toScreen(p: Point): Point {
    return {
      x: this.width / 2 + (p.x - this.center.x) * this.scale,
      y: this.height / 2 - (p.y - this.center.y) * this.scale,
    };
  }

  toWorld(s: Point): Point {
    return {
      x: this.center.x + (s.x - this.width / 2) / this.scale,
      y: this.center.y - (s.y - this.height / 2) / this.scale,
    };
  }

  /** World-unit size of a pixel distance. */
  worldPerPixel(): number {
    return 1 / this.scale;
  }

  zoomAt(screenPt: Point, factor: number): void {
    const before = this.toWorld(screenPt);
    this.scale = Math.min(1e6, Math.max(1e-4, this.scale * factor));
    const after = this.toWorld(screenPt);
    this.center = g.add(this.center, g.sub(before, after));
  }

  panByPixels(dx: number, dy: number): void {
    this.center = { x: this.center.x - dx / this.scale, y: this.center.y + dy / this.scale };
  }

  zoomToBounds(b: Bounds | null, margin = 0.08): void {
    if (!b) {
      this.center = { x: 5, y: 4 };
      this.scale = 80;
      return;
    }
    const bw = Math.max(b.max.x - b.min.x, 1e-3);
    const bh = Math.max(b.max.y - b.min.y, 1e-3);
    const s = Math.min(this.width / (bw * (1 + margin * 2)), this.height / (bh * (1 + margin * 2)));
    this.scale = Math.min(1e6, Math.max(1e-4, s));
    this.center = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
  }

  requestRender(overlay: ViewportOverlay): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render(overlay);
    });
  }

  render(ov: ViewportOverlay): void {
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.settings.background;
    ctx.fillRect(0, 0, this.width, this.height);

    if (this.settings.gridVisible) this.drawGrid();

    const tf = this.transform;
    const layers = this.doc.layers;
    const hidden = new Set(layers.filter((l) => !l.visible).map((l) => l.name));
    const lookup = this.doc.lookupBlock;
    const viewBounds = this.visibleBounds();

    for (const e of this.doc.entities) {
      if (hidden.has(e.layer)) continue;
      const selected = ov.selection.has(e.id);
      const hovered = ov.hover === e.id && !selected;
      // (bounds culling is cheap for lines; skip complex culling for others)
      if (e.type === 'line' && !segmentMayIntersect(e.a, e.b, viewBounds)) continue;
      if (selected) {
        drawEntity(ctx, e, tf, layers, lookup, { dashed: this.settings.selectionEffect !== 'solid', lineWidthOverride: this.settings.selectionEffect === 'solid' ? 2.5 : undefined, alpha: 0.95 });
      } else if (hovered) {
        drawEntity(ctx, e, tf, layers, lookup, { lineWidthOverride: 2.5, dashed: true, alpha: 0.95 });
      } else {
        drawEntity(ctx, e, tf, layers, lookup);
      }
    }

    // Grips for selected
    if (ov.selection.size > 0 && ov.selection.size <= 400) {
      for (const e of this.doc.entities) {
        if (!ov.selection.has(e.id)) continue;
        for (const gp of gripPoints(e)) this.drawGrip(this.toScreen(gp));
      }
    }

    for (const e of ov.ghost) drawEntity(ctx, e, tf, layers, lookup, { dashed: true, alpha: 0.7 });
    for (const e of ov.preview) drawEntity(ctx, e, tf, layers, lookup);

    if (ov.selectionBox) this.drawSelectionBox(ov.selectionBox);
    if (ov.trackFrom && ov.cursor) this.drawTrack(ov.trackFrom, ov.cursor);
    if (ov.snap) this.drawSnapMarker(ov.snap);
    if (ov.cursor) this.drawCrosshair(ov.cursor, ov.dynText, ov.cursorMode);
    this.drawUcsIcon();
  }

  visibleBounds(): Bounds {
    const a = this.toWorld({ x: 0, y: this.height });
    const b = this.toWorld({ x: this.width, y: 0 });
    return { min: a, max: b };
  }

  private drawGrid(): void {
    const { ctx } = this;
    const vb = this.visibleBounds();
    let step = this.settings.gridSize;
    // Keep minor spacing at >= 10 px, like AutoCAD's adaptive grid.
    while (step * this.scale < 10) step *= 5;
    const major = step * 5;
    const startX = Math.floor(vb.min.x / step) * step;
    const startY = Math.floor(vb.min.y / step) * step;

    ctx.lineWidth = 1;
    const isMajor = (v: number) => Math.abs(v / major - Math.round(v / major)) < 1e-6;

    if (this.settings.gridStyle === 'dots') {
      // Dot grid (AutoCAD 2D model space style): one dot per minor intersection.
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      for (let x = startX; x <= vb.max.x; x += step) {
        const sx = Math.round(this.toScreen({ x, y: 0 }).x);
        for (let y = startY; y <= vb.max.y; y += step) ctx.fillRect(sx, Math.round(this.toScreen({ x: 0, y }).y), 1, 1);
      }
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.beginPath();
    for (let x = startX; x <= vb.max.x; x += step) {
      if (isMajor(x) || this.settings.gridStyle === 'dots') continue;
      const sx = Math.round(this.toScreen({ x, y: 0 }).x) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, this.height);
    }
    for (let y = startY; y <= vb.max.y; y += step) {
      if (isMajor(y) || this.settings.gridStyle === 'dots') continue;
      const sy = Math.round(this.toScreen({ x: 0, y }).y) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(this.width, sy);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.beginPath();
    for (let x = Math.floor(vb.min.x / major) * major; x <= vb.max.x; x += major) {
      const sx = Math.round(this.toScreen({ x, y: 0 }).x) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, this.height);
    }
    for (let y = Math.floor(vb.min.y / major) * major; y <= vb.max.y; y += major) {
      const sy = Math.round(this.toScreen({ x: 0, y }).y) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(this.width, sy);
    }
    ctx.stroke();

    // Axes
    const o = this.toScreen({ x: 0, y: 0 });
    ctx.strokeStyle = 'rgba(200,60,60,0.3)';
    ctx.beginPath();
    ctx.moveTo(0, Math.round(o.y) + 0.5);
    ctx.lineTo(this.width, Math.round(o.y) + 0.5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(80,200,80,0.3)';
    ctx.beginPath();
    ctx.moveTo(Math.round(o.x) + 0.5, 0);
    ctx.lineTo(Math.round(o.x) + 0.5, this.height);
    ctx.stroke();
  }

  private drawCrosshair(world: Point, dynText: string[], mode: ViewportOverlay['cursorMode']): void {
    const { ctx } = this;
    const s = this.toScreen(world);
    const x = Math.round(s.x) + 0.5;
    const y = Math.round(s.y) + 0.5;
    const half = (Math.max(this.width, this.height) * this.settings.crosshairSize) / 100;
    const box = this.settings.pickBox;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = this.settings.crosshairColor ?? '#ffffff';
    if (mode !== 'select') {
      // crosshair; in a point prompt the lines meet at the cursor (no pickbox gap)
      const gap = mode === 'idle' ? box : 0;
      ctx.beginPath();
      ctx.moveTo(x - half, y);
      ctx.lineTo(x - gap, y);
      ctx.moveTo(x + gap, y);
      ctx.lineTo(x + half, y);
      ctx.moveTo(x, y - half);
      ctx.lineTo(x, y - gap);
      ctx.moveTo(x, y + gap);
      ctx.lineTo(x, y + half);
      ctx.stroke();
    }
    if (mode !== 'point') ctx.strokeRect(x - box, y - box, box * 2, box * 2);

    if (dynText.length > 0) {
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      let ty = y + 18;
      for (const line of dynText) {
        const w = ctx.measureText(line).width + 10;
        ctx.fillStyle = 'rgba(28, 32, 38, 0.92)';
        ctx.strokeStyle = 'rgba(160,160,160,0.7)';
        ctx.fillRect(x + 14, ty - 12, w, 17);
        ctx.strokeRect(x + 14.5, ty - 11.5, w, 17);
        ctx.fillStyle = '#e8e8e8';
        ctx.fillText(line, x + 19, ty);
        ty += 20;
      }
    }
    ctx.restore();
  }

  private drawGrip(s: Point): void {
    const { ctx } = this;
    const h = this.settings.gripSize ?? 4;
    ctx.save();
    ctx.fillStyle = this.settings.gripColor ?? '#1a3dff';
    ctx.strokeStyle = '#0b0b0b';
    ctx.lineWidth = 1;
    ctx.fillRect(Math.round(s.x) - h, Math.round(s.y) - h, h * 2, h * 2);
    ctx.strokeRect(Math.round(s.x) - h + 0.5, Math.round(s.y) - h + 0.5, h * 2, h * 2);
    ctx.restore();
  }

  private drawSelectionBox(box: { a: Point; b: Point; mode: 'window' | 'crossing' }): void {
    const { ctx } = this;
    const a = this.toScreen(box.a);
    const b = this.toScreen(box.b);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x);
    const h = Math.abs(a.y - b.y);
    ctx.save();
    if (box.mode === 'window') {
      ctx.fillStyle = 'rgba(70, 110, 220, 0.25)';
      ctx.strokeStyle = '#6a8fe8';
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = 'rgba(80, 200, 90, 0.22)';
      ctx.strokeStyle = '#6fd07a';
      ctx.setLineDash([5, 4]);
    }
    ctx.fillRect(x, y, w, h);
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    ctx.restore();
  }

  private drawTrack(from: Point, to: Point): void {
    const { ctx } = this;
    const a = this.toScreen(from);
    const b = this.toScreen(to);
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 220, 120, 0.55)';
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawSnapMarker(snap: SnapResult): void {
    const { ctx } = this;
    const s = this.toScreen(snap.point);
    const r = this.settings.snapMarkerSize ?? 7;
    ctx.save();
    ctx.strokeStyle = this.settings.snapMarkerColor ?? '#3ff23f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    switch (snap.kind) {
      case 'endpoint':
        ctx.rect(s.x - r, s.y - r, r * 2, r * 2);
        break;
      case 'midpoint':
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r, s.y + r);
        ctx.lineTo(s.x - r, s.y + r);
        ctx.closePath();
        break;
      case 'center':
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        break;
      case 'quadrant':
        ctx.moveTo(s.x, s.y - r);
        ctx.lineTo(s.x + r, s.y);
        ctx.lineTo(s.x, s.y + r);
        ctx.lineTo(s.x - r, s.y);
        ctx.closePath();
        break;
      case 'intersection':
        ctx.moveTo(s.x - r, s.y - r);
        ctx.lineTo(s.x + r, s.y + r);
        ctx.moveTo(s.x - r, s.y + r);
        ctx.lineTo(s.x + r, s.y - r);
        break;
      case 'perpendicular':
        ctx.moveTo(s.x - r, s.y - r);
        ctx.lineTo(s.x - r, s.y + r);
        ctx.lineTo(s.x + r, s.y + r);
        ctx.moveTo(s.x - r, s.y);
        ctx.lineTo(s.x, s.y);
        ctx.lineTo(s.x, s.y + r);
        break;
      case 'insertion':
        ctx.rect(s.x - r, s.y - r, r * 1.2, r * 1.2);
        ctx.rect(s.x - r * 0.2, s.y - r * 0.2, r * 1.2, r * 1.2);
        break;
      case 'nearest':
        ctx.moveTo(s.x - r, s.y - r);
        ctx.lineTo(s.x + r, s.y + r);
        ctx.lineTo(s.x - r, s.y + r);
        ctx.lineTo(s.x + r, s.y - r);
        ctx.closePath();
        break;
      default:
        ctx.rect(s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  private drawUcsIcon(): void {
    const { ctx } = this;
    const ox = 34;
    const oy = this.height - 34;
    const l = 42;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#c8c8c8';
    ctx.fillStyle = '#c8c8c8';
    ctx.font = '11px "Segoe UI", system-ui, sans-serif';
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + l, oy);
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox, oy - l);
    ctx.stroke();
    // arrow heads
    ctx.beginPath();
    ctx.moveTo(ox + l, oy);
    ctx.lineTo(ox + l - 7, oy - 4);
    ctx.lineTo(ox + l - 7, oy + 4);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(ox, oy - l);
    ctx.lineTo(ox - 4, oy - l + 7);
    ctx.lineTo(ox + 4, oy - l + 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillText('X', ox + l - 4, oy + 14);
    ctx.fillText('Y', ox - 14, oy - l + 6);
    ctx.strokeRect(ox - 5, oy - 5, 10, 10);
    ctx.restore();
  }
}

function segmentMayIntersect(a: Point, b: Point, box: Bounds): boolean {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  return !(maxX < box.min.x || minX > box.max.x || maxY < box.min.y || minY > box.max.y);
}
