import type { Point, Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity } from '../core/entities';
import { gripPoints, entityBounds } from '../core/entities';
import type { Drawing } from '../core/document';
import type { SnapResult, TrackPath } from '../core/snap';
import { drawEntity, renderSettings, annotationDisplay, colorDisplay, type Transform } from './draw';
import { cannoscaleValue } from '../core/layouts';
import { setTextStyles } from './hershey';
import { textStylesOf } from '../io/encoding';

/**
 * High-DPI helpers. The canvas backing store has devicePixelRatio device pixels
 * per CSS pixel and every drawing call works in CSS pixels (render() sets the
 * dpr transform), so line widths, text, the pickbox, the aperture and grips are
 * the same CSS size on every monitor. A 1-CSS-px line is crisp when its centre
 * sits on a device-pixel centre (odd device width) or boundary (even width).
 */
export function crisp(v: number, dpr: number, cssWidth = 1): number {
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const d = v * dpr;
  return (w % 2 === 1 ? Math.floor(d) + 0.5 : Math.round(d)) / dpr;
}

/** Width in CSS px of the thinnest crisp line: one CSS px, rounded to whole device pixels (1 at dpr 1 and 2). */
export function hairline(dpr: number): number {
  return Math.max(1, Math.round(dpr)) / dpr;
}

/** Backing-store size for a CSS size (whole device pixels, at least 1). */
export function backingSize(cssWidth: number, cssHeight: number, dpr: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(cssWidth * dpr)), height: Math.max(1, Math.round(cssHeight * dpr)) };
}

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
  /** Object snap tracking: acquired points and the alignment paths the cursor currently follows. */
  acquired?: readonly Point[];
  trackPaths?: readonly TrackPath[];
  /** Fence / polygon selection in progress (SELECT F / WP / CP). */
  selectionPolygon?: { points: readonly Point[]; mode: 'fence' | 'window' | 'crossing' } | null;
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
  /** Colour of a grip under the cursor (Options > Selection > Hover grip color). */
  gripHoverColor?: string;
  snapMarkerSize?: number; // px
  snapMarkerColor?: string;
  selectionEffect?: 'dashed' | 'solid';
  /** GRIDDISPLAY bit 0: show the grid beyond the drawing limits (LIMITS). */
  gridBeyondLimits: boolean;
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
  settings: ViewSettings = { gridVisible: true, gridSize: 0.5, background: '#212830', crosshairSize: 5, pickBox: 3, gridBeyondLimits: true };
  /** Previous view states for ZOOM Previous (most recent last). */
  readonly viewHistory: Array<{ center: Point; scale: number }> = [];
  /**
   * Extra background painter drawn after the grid and before the entities
   * (Symbol Builder guides). Not part of the document; null for normal drawings.
   */
  underlay: ((ctx: CanvasRenderingContext2D, vp: Viewport) => void) | null = null;
  /**
   * Paper-space layouts (Track E, render/layouts.ts): when set, it paints the sheet, the
   * floating viewports and the paper-space entities instead of the grid and model space.
   */
  layoutPainter: ((ctx: CanvasRenderingContext2D, vp: Viewport, ov: ViewportOverlay) => void) | null = null;
  /** Screen rectangle ZOOM Extents / Window fit into (the active floating viewport); null = the whole canvas. */
  fitRect: { x: number; y: number; w: number; h: number } | null = null;
  /** Show the paper-space (triangle) UCS icon. */
  paperUcsIcon = false;
  private raf = 0;
  private lastOverlay: ViewportOverlay | null = null;
  private dprQuery: { mq: MediaQueryList; handler: () => void } | null = null;
  /** Called after a devicePixelRatio change (window moved to another monitor, browser zoom) resized the canvas. */
  onDprChange: ((dpr: number) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, private doc: Drawing) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unsupported');
    this.ctx = ctx;
    this.watchDevicePixelRatio();
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    const size = backingSize(this.width, this.height, this.dpr);
    if (this.canvas.width !== size.width) this.canvas.width = size.width;
    if (this.canvas.height !== size.height) this.canvas.height = size.height;
  }

  /**
   * A window dragged to a monitor with another scale factor keeps its CSS size, so
   * neither 'resize' nor the ResizeObserver fires: listen for the resolution media
   * query of the current ratio instead, and re-arm it for the new ratio each time.
   */
  private watchDevicePixelRatio(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const dpr = window.devicePixelRatio || 1;
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const handler = () => {
      mq.removeEventListener('change', handler);
      this.dprQuery = null;
      this.resize();
      if (this.lastOverlay) this.requestRender(this.lastOverlay);
      this.onDprChange?.(this.dpr);
      this.watchDevicePixelRatio();
    };
    mq.addEventListener('change', handler);
    this.dprQuery = { mq, handler };
  }

  /** Stop listening for devicePixelRatio changes (a viewport that is thrown away). */
  dispose(): void {
    if (this.dprQuery) this.dprQuery.mq.removeEventListener('change', this.dprQuery.handler);
    this.dprQuery = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Crisp CSS-pixel coordinate for a line of `cssWidth` (see `crisp`). */
  px(v: number, cssWidth = 1): number {
    return crisp(v, this.dpr, cssWidth);
  }

  get transform(): Transform {
    return { scale: this.scale, toScreen: (p) => this.toScreen(p), viewBounds: this.visibleBounds() };
  }

  /** Remember the current view (call before changing it) so ZOOM Previous can return. */
  pushView(): void {
    const last = this.viewHistory[this.viewHistory.length - 1];
    if (last && Math.abs(last.scale - this.scale) < 1e-12 && g.eq(last.center, this.center, 1e-9)) return;
    this.viewHistory.push({ center: this.center, scale: this.scale });
    if (this.viewHistory.length > 20) this.viewHistory.shift();
  }

  /** Restore the previous view. Returns false when there is none. */
  popView(): boolean {
    const v = this.viewHistory.pop();
    if (!v) return false;
    this.center = v.center;
    this.scale = v.scale;
    return true;
  }

  /** Visible height in world units (VIEW records store this). */
  get viewHeight(): number {
    return this.height / this.scale;
  }
  set viewHeight(h: number) {
    if (h > 0) this.scale = Math.min(1e6, Math.max(1e-4, this.height / h));
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
    const r = this.fitRect ?? { x: 0, y: 0, w: this.width, h: this.height };
    const s = Math.min(r.w / (bw * (1 + margin * 2)), r.h / (bh * (1 + margin * 2)));
    this.scale = Math.min(1e6, Math.max(1e-4, s));
    this.center = { x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2 };
    // Fitting into a sub-rectangle: shift so the bounds' centre lands on the rectangle's centre.
    if (this.fitRect) this.center = { x: this.center.x - (r.x + r.w / 2 - this.width / 2) / this.scale, y: this.center.y + (r.y + r.h / 2 - this.height / 2) / this.scale };
  }

  requestRender(overlay: ViewportOverlay): void {
    this.lastOverlay = overlay;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render(overlay);
    });
  }

  render(ov: ViewportOverlay): void {
    const { ctx } = this;
    this.lastOverlay = ov;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = this.settings.background;
    ctx.fillRect(0, 0, this.width, this.height);

    if (this.settings.gridVisible && !this.layoutPainter) this.drawGrid();
    if (this.underlay) {
      ctx.save();
      this.underlay(ctx, this);
      ctx.restore();
    }

    const header = this.doc.header;
    renderSettings.ltscale = header.ltscale;
    renderSettings.pdmode = header.pdmode;
    renderSettings.pdsize = header.pdsize;
    renderSettings.linetypes = header.linetypes;
    setTextStyles(textStylesOf(this.doc.snapshot));
    // Model tab: annotative objects at 1 / CANNOSCALE; a layout painter sets its own (Track E).
    colorDisplay.paper = !!this.layoutPainter;
    annotationDisplay.factor = 1 / cannoscaleValue(header.cannoscale);
    annotationDisplay.hide = false;

    const tf = this.transform;
    const layers = this.doc.layers;
    const hidden = new Set(layers.filter((l) => !l.visible).map((l) => l.name));
    const lookup = this.doc.lookupBlock;
    const viewBounds = this.visibleBounds();

    if (this.layoutPainter) {
      ctx.save();
      this.layoutPainter(ctx, this, ov);
      ctx.restore();
    }
    for (const e of this.layoutPainter ? [] : this.doc.entities) {
      if (hidden.has(e.layer)) continue;
      const selected = ov.selection.has(e.id);
      const hovered = ov.hover === e.id && !selected;
      // Cull anything whose bounds miss the view (bounds are cached for compound entities).
      if (e.type === 'line') {
        if (!segmentMayIntersect(e.a, e.b, viewBounds)) continue;
      } else if (e.type !== 'xline' && e.type !== 'ray') {
        const b = entityBounds(e, lookup);
        if (b && !g.boundsIntersect(b, viewBounds)) continue;
      }
      if (selected) {
        drawEntity(ctx, e, tf, layers, lookup, { dashed: this.settings.selectionEffect !== 'solid', lineWidthOverride: this.settings.selectionEffect === 'solid' ? 2.5 : undefined, alpha: 0.95, hidden });
      } else if (hovered) {
        drawEntity(ctx, e, tf, layers, lookup, { lineWidthOverride: 2, alpha: 0.95, hidden });
      } else {
        drawEntity(ctx, e, tf, layers, lookup, { hidden });
      }
    }

    // Grips for selected
    const cursorScreen = ov.cursor ? this.toScreen(ov.cursor) : null;
    if (ov.selection.size > 0 && ov.selection.size <= 400) {
      for (const e of this.doc.entities) {
        if (!ov.selection.has(e.id)) continue;
        for (const gp of gripPoints(e)) this.drawGrip(this.toScreen(gp), cursorScreen);
      }
    }

    for (const e of ov.ghost) drawEntity(ctx, e, tf, layers, lookup, { dashed: true, alpha: 0.7 });
    for (const e of ov.preview) drawEntity(ctx, e, tf, layers, lookup);

    if (ov.selectionBox) this.drawSelectionBox(ov.selectionBox);
    if (ov.selectionPolygon && ov.selectionPolygon.points.length > 0) this.drawSelectionPolygon(ov.selectionPolygon, ov.cursor);
    if (ov.trackFrom && ov.cursor) this.drawTrack(ov.trackFrom, ov.cursor);
    if (ov.acquired) for (const p of ov.acquired) this.drawAcquired(p);
    if (ov.trackPaths && ov.cursor) for (const tp of ov.trackPaths) this.drawTrackPath(tp, ov.cursor);
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
    let vb = this.visibleBounds();
    if (!this.settings.gridBeyondLimits) {
      // GRIDDISPLAY = 0: the grid covers only the LIMITS rectangle.
      const lim = this.doc.header.limits;
      vb = {
        min: { x: Math.max(vb.min.x, lim.min.x), y: Math.max(vb.min.y, lim.min.y) },
        max: { x: Math.min(vb.max.x, lim.max.x), y: Math.min(vb.max.y, lim.max.y) },
      };
      if (vb.min.x >= vb.max.x || vb.min.y >= vb.max.y) return;
    }
    const top = this.toScreen({ x: 0, y: vb.max.y }).y;
    const bottom = this.toScreen({ x: 0, y: vb.min.y }).y;
    const left = this.toScreen({ x: vb.min.x, y: 0 }).x;
    const right = this.toScreen({ x: vb.max.x, y: 0 }).x;
    let step = this.settings.gridSize;
    // Keep minor spacing at >= 10 px, like AutoCAD's adaptive grid.
    while (step * this.scale < 10) step *= 5;
    const major = step * 5;
    const startX = Math.floor(vb.min.x / step) * step;
    const startY = Math.floor(vb.min.y / step) * step;

    ctx.lineWidth = hairline(this.dpr);
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
      if (isMajor(x) || x < vb.min.x || this.settings.gridStyle === 'dots') continue;
      const sx = this.px(this.toScreen({ x, y: 0 }).x);
      ctx.moveTo(sx, top);
      ctx.lineTo(sx, bottom);
    }
    for (let y = startY; y <= vb.max.y; y += step) {
      if (isMajor(y) || y < vb.min.y || this.settings.gridStyle === 'dots') continue;
      const sy = this.px(this.toScreen({ x: 0, y }).y);
      ctx.moveTo(left, sy);
      ctx.lineTo(right, sy);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.beginPath();
    for (let x = Math.floor(vb.min.x / major) * major; x <= vb.max.x; x += major) {
      if (x < vb.min.x) continue;
      const sx = this.px(this.toScreen({ x, y: 0 }).x);
      ctx.moveTo(sx, top);
      ctx.lineTo(sx, bottom);
    }
    for (let y = Math.floor(vb.min.y / major) * major; y <= vb.max.y; y += major) {
      if (y < vb.min.y) continue;
      const sy = this.px(this.toScreen({ x: 0, y }).y);
      ctx.moveTo(left, sy);
      ctx.lineTo(right, sy);
    }
    ctx.stroke();
    if (!this.settings.gridBeyondLimits) {
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.strokeRect(this.px(left), this.px(top), Math.round(right - left), Math.round(bottom - top));
    }

    // Axes
    const o = this.toScreen({ x: 0, y: 0 });
    ctx.strokeStyle = 'rgba(200,60,60,0.3)';
    ctx.beginPath();
    ctx.moveTo(0, this.px(o.y));
    ctx.lineTo(this.width, this.px(o.y));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(80,200,80,0.3)';
    ctx.beginPath();
    ctx.moveTo(this.px(o.x), 0);
    ctx.lineTo(this.px(o.x), this.height);
    ctx.stroke();
  }

  private drawCrosshair(world: Point, dynText: string[], mode: ViewportOverlay['cursorMode']): void {
    const { ctx } = this;
    const s = this.toScreen(world);
    const x = this.px(s.x);
    const y = this.px(s.y);
    const half = (Math.max(this.width, this.height) * this.settings.crosshairSize) / 100;
    const box = this.settings.pickBox;
    ctx.save();
    ctx.lineWidth = hairline(this.dpr);
    const cross = this.settings.crosshairColor ?? '#ffffff';
    // On the white layout sheet a white crosshair would vanish: draw it dark (Track E).
    ctx.strokeStyle = this.layoutPainter && /^#f{3}(f{3})?$/i.test(cross) ? '#1e1e1e' : cross;
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
        ctx.strokeRect(this.px(x + 14), this.px(ty - 12), w, 17);
        ctx.fillStyle = '#e8e8e8';
        ctx.fillText(line, x + 19, ty);
        ty += 20;
      }
    }
    ctx.restore();
  }

  private drawGrip(s: Point, cursor: Point | null = null): void {
    const { ctx } = this;
    const h = this.settings.gripSize ?? 4;
    const hot = cursor !== null && Math.abs(cursor.x - s.x) <= h + 2 && Math.abs(cursor.y - s.y) <= h + 2;
    ctx.save();
    ctx.fillStyle = hot ? (this.settings.gripHoverColor ?? '#ff3d3d') : (this.settings.gripColor ?? '#1a3dff');
    ctx.strokeStyle = '#0b0b0b';
    ctx.lineWidth = hairline(this.dpr);
    ctx.fillRect(Math.round(s.x) - h, Math.round(s.y) - h, h * 2, h * 2);
    ctx.strokeRect(this.px(Math.round(s.x) - h), this.px(Math.round(s.y) - h), h * 2, h * 2);
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
    ctx.lineWidth = hairline(this.dpr);
    ctx.strokeRect(this.px(x), this.px(y), Math.round(w), Math.round(h));
    ctx.restore();
  }

  private drawSelectionPolygon(poly: { points: readonly Point[]; mode: 'fence' | 'window' | 'crossing' }, cursor: Point | null): void {
    const { ctx } = this;
    const pts = [...poly.points, ...(cursor ? [cursor] : [])].map((p) => this.toScreen(p));
    if (pts.length < 2) return;
    ctx.save();
    ctx.lineWidth = 1;
    if (poly.mode === 'window') {
      ctx.fillStyle = 'rgba(70, 110, 220, 0.25)';
      ctx.strokeStyle = '#6a8fe8';
    } else {
      ctx.fillStyle = 'rgba(80, 200, 90, 0.22)';
      ctx.strokeStyle = '#6fd07a';
      ctx.setLineDash([5, 4]);
    }
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i]!.x, pts[i]!.y);
    if (poly.mode !== 'fence') {
      ctx.closePath();
      ctx.fill();
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Small "+" marker on an acquired tracking point. */
  private drawAcquired(p: Point): void {
    const { ctx } = this;
    const s = this.toScreen(p);
    ctx.save();
    ctx.strokeStyle = '#3ff23f';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(s.x - 4, s.y);
    ctx.lineTo(s.x + 4, s.y);
    ctx.moveTo(s.x, s.y - 4);
    ctx.lineTo(s.x, s.y + 4);
    ctx.stroke();
    ctx.restore();
  }

  /** Dotted alignment path through an acquired point, drawn across the whole view. */
  private drawTrackPath(tp: TrackPath, cursor: Point): void {
    const { ctx } = this;
    const d = { x: Math.cos(tp.angle), y: Math.sin(tp.angle) };
    const span = Math.max(this.width, this.height) / this.scale;
    const a = this.toScreen(g.add(tp.from, g.scale(d, -span)));
    const b = this.toScreen(g.add(tp.from, g.scale(d, span)));
    ctx.save();
    ctx.strokeStyle = 'rgba(120, 220, 120, 0.7)';
    ctx.setLineDash([2, 4]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const c = this.toScreen(cursor);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(c.x - 5, c.y - 5);
    ctx.lineTo(c.x + 5, c.y + 5);
    ctx.moveTo(c.x - 5, c.y + 5);
    ctx.lineTo(c.x + 5, c.y - 5);
    ctx.stroke();
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
      case 'tangent':
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.moveTo(s.x - r, s.y - r);
        ctx.lineTo(s.x + r, s.y - r);
        break;
      case 'node':
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.moveTo(s.x - r, s.y - r);
        ctx.lineTo(s.x + r, s.y + r);
        ctx.moveTo(s.x - r, s.y + r);
        ctx.lineTo(s.x + r, s.y - r);
        break;
      case 'tracking':
        ctx.moveTo(s.x - r, s.y - r);
        ctx.lineTo(s.x + r, s.y + r);
        ctx.moveTo(s.x - r, s.y + r);
        ctx.lineTo(s.x + r, s.y - r);
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
    if (this.paperUcsIcon) {
      // Paper space: AutoCAD's triangular UCS icon.
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = '#c8c8c8';
      ctx.fillStyle = '#c8c8c8';
      ctx.font = '11px "Segoe UI", system-ui, sans-serif';
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + l, oy);
      ctx.lineTo(ox, oy - l);
      ctx.closePath();
      ctx.stroke();
      ctx.fillText('X', ox + l + 3, oy + 4);
      ctx.fillText('Y', ox - 4, oy - l - 5);
      ctx.restore();
      return;
    }
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
