import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, ColorSpec } from '../core/entities';
import { newId } from '../core/entities';
import type { Tool, ToolContext } from './types';

const fmt = (p: Point) => `${p.x.toFixed(4)}, ${p.y.toFixed(4)}`;

function baseProps(ctx: ToolContext, layer?: string): { id: string; layer: string; color: ColorSpec } {
  return { id: newId(), layer: layer ?? ctx.doc.currentLayer, color: 'ByLayer' };
}

/** LINE: chain of segments until Enter/Esc. Supports [Undo] and [Close]. */
export class LineTool implements Tool {
  readonly name: string = 'LINE';
  readonly acceptsDistance = true;
  protected points: Point[] = [];
  protected cursor: Point | null = null;
  protected layer: string | undefined;

  start(ctx: ToolContext): void {
    this.points = [];
    ctx.prompt('Specify first point:');
    ctx.setTrackFrom(null);
  }

  protected makeSegment(ctx: ToolContext, a: Point, b: Point): Entity {
    return { ...baseProps(ctx, this.layer), type: 'line', a, b };
  }

  onPoint(p: Point, ctx: ToolContext): void {
    const last = this.points[this.points.length - 1];
    if (last) {
      if (g.eq(last, p, 1e-9)) return;
      ctx.doc.addEntities([this.makeSegment(ctx, last, p)]);
    }
    this.points.push(p);
    ctx.setTrackFrom(p);
    ctx.prompt(this.points.length >= 2 ? 'Specify next point or [Close/Undo]:' : 'Specify next point or [Undo]:');
    this.onMove(this.cursor ?? p, ctx);
  }

  onMove(p: Point, ctx: ToolContext): void {
    this.cursor = p;
    const last = this.points[this.points.length - 1];
    if (!last) {
      ctx.setDynText([fmt(p)]);
      return;
    }
    ctx.setPreview([this.makeSegment(ctx, last, p)]);
    const d = g.dist(last, p);
    const ang = g.deg(g.normAngle(g.angleOf(last, p)));
    ctx.setDynText([`${d.toFixed(4)}`, `${ang.toFixed(0)}°`]);
  }

  onText(text: string, ctx: ToolContext): void {
    const t = text.trim().toUpperCase();
    if (t === 'U' || t === 'UNDO') {
      if (this.points.length >= 2) {
        ctx.doc.undo();
        this.points.pop();
        ctx.setTrackFrom(this.points[this.points.length - 1] ?? null);
      } else if (this.points.length === 1) {
        this.points.pop();
        ctx.setTrackFrom(null);
        ctx.setPreview([]);
        ctx.prompt('Specify first point:');
      }
      return;
    }
    if ((t === 'C' || t === 'CLOSE') && this.points.length >= 3) {
      ctx.doc.addEntities([this.makeSegment(ctx, this.points[this.points.length - 1]!, this.points[0]!)]);
      ctx.finish();
      return;
    }
    ctx.log(`Invalid option keyword: ${text}`);
  }

  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }

  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

/** PLINE: a single polyline entity built incrementally. */
export class PolylineTool implements Tool {
  readonly name = 'PLINE';
  readonly acceptsDistance = true;
  private points: Point[] = [];

  start(ctx: ToolContext): void {
    this.points = [];
    ctx.prompt('Specify start point:');
  }

  private build(ctx: ToolContext, pts: Point[], closed = false): Entity {
    return { ...baseProps(ctx), type: 'polyline', points: pts, closed };
  }

  onPoint(p: Point, ctx: ToolContext): void {
    const last = this.points[this.points.length - 1];
    if (last && g.eq(last, p)) return;
    this.points.push(p);
    ctx.setTrackFrom(p);
    ctx.prompt(this.points.length >= 2 ? 'Specify next point or [Close/Undo]:' : 'Specify next point or [Undo]:');
  }

  onMove(p: Point, ctx: ToolContext): void {
    if (this.points.length === 0) {
      ctx.setDynText([fmt(p)]);
      return;
    }
    ctx.setPreview([this.build(ctx, [...this.points, p])]);
    const last = this.points[this.points.length - 1]!;
    ctx.setDynText([g.dist(last, p).toFixed(4), `${g.deg(g.normAngle(g.angleOf(last, p))).toFixed(0)}°`]);
  }

  onText(text: string, ctx: ToolContext): void {
    const t = text.trim().toUpperCase();
    if (t === 'U' || t === 'UNDO') {
      this.points.pop();
      ctx.setTrackFrom(this.points[this.points.length - 1] ?? null);
      if (this.points.length === 0) {
        ctx.setPreview([]);
        ctx.prompt('Specify start point:');
      }
      return;
    }
    if ((t === 'C' || t === 'CLOSE') && this.points.length >= 3) {
      ctx.doc.addEntities([this.build(ctx, this.points, true)]);
      ctx.finish();
      return;
    }
    ctx.log(`Invalid option keyword: ${text}`);
  }

  onEnter(ctx: ToolContext): void {
    if (this.points.length >= 2) ctx.doc.addEntities([this.build(ctx, this.points)]);
    ctx.finish();
  }

  onCancel(ctx: ToolContext): void {
    if (this.points.length >= 2) ctx.doc.addEntities([this.build(ctx, this.points)]);
    ctx.finish();
  }
}

/** CIRCLE: centre + radius (typed or picked). */
export class CircleTool implements Tool {
  readonly name = 'CIRCLE';
  readonly acceptsDistance = true;
  private center: Point | null = null;

  start(ctx: ToolContext): void {
    this.center = null;
    ctx.prompt('Specify center point for circle:');
  }

  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.center) {
      this.center = p;
      ctx.setTrackFrom(p);
      ctx.prompt('Specify radius of circle:');
      return;
    }
    const r = g.dist(this.center, p);
    if (r < 1e-9) return;
    ctx.doc.addEntities([{ ...baseProps(ctx), type: 'circle', center: this.center, radius: r }]);
    ctx.finish();
  }

  onMove(p: Point, ctx: ToolContext): void {
    if (!this.center) {
      ctx.setDynText([fmt(p)]);
      return;
    }
    const r = g.dist(this.center, p);
    ctx.setPreview([{ ...baseProps(ctx), type: 'circle', center: this.center, radius: r }]);
    ctx.setDynText([`R ${r.toFixed(4)}`]);
  }

  onText(text: string, ctx: ToolContext): void {
    const v = parseFloat(text);
    if (this.center && Number.isFinite(v) && v > 0) {
      ctx.doc.addEntities([{ ...baseProps(ctx), type: 'circle', center: this.center, radius: v }]);
      ctx.finish();
      return;
    }
    ctx.log('Requires numeric radius or second point.');
  }

  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

/** ARC: 3-point arc (start, second, end). */
export class ArcTool implements Tool {
  readonly name = 'ARC';
  private pts: Point[] = [];

  start(ctx: ToolContext): void {
    this.pts = [];
    ctx.prompt('Specify start point of arc:');
  }

  private arcThrough(ctx: ToolContext, a: Point, b: Point, c: Point): Entity | null {
    // circumscribed circle
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-12) return null;
    const a2 = a.x * a.x + a.y * a.y;
    const b2 = b.x * b.x + b.y * b.y;
    const c2 = c.x * c.x + c.y * c.y;
    const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    const center = { x: ux, y: uy };
    const r = g.dist(center, a);
    const aa = g.angleOf(center, a);
    const ab = g.angleOf(center, b);
    const ac = g.angleOf(center, c);
    // choose direction so that b lies on the sweep from a to c
    const ccw = g.angleInSweep(ab, aa, ac);
    return {
      ...baseProps(ctx),
      type: 'arc',
      center,
      radius: r,
      startAngle: ccw ? aa : ac,
      endAngle: ccw ? ac : aa,
    };
  }

  onPoint(p: Point, ctx: ToolContext): void {
    this.pts.push(p);
    ctx.setTrackFrom(p);
    if (this.pts.length === 1) ctx.prompt('Specify second point of arc:');
    else if (this.pts.length === 2) ctx.prompt('Specify end point of arc:');
    else {
      const arc = this.arcThrough(ctx, this.pts[0]!, this.pts[1]!, this.pts[2]!);
      if (arc) ctx.doc.addEntities([arc]);
      else ctx.log('Points are collinear; arc not created.');
      ctx.finish();
    }
  }

  onMove(p: Point, ctx: ToolContext): void {
    if (this.pts.length === 1) {
      ctx.setPreview([{ ...baseProps(ctx), type: 'line', a: this.pts[0]!, b: p }]);
    } else if (this.pts.length === 2) {
      const arc = this.arcThrough(ctx, this.pts[0]!, this.pts[1]!, p);
      ctx.setPreview(arc ? [arc] : []);
    } else ctx.setDynText([fmt(p)]);
  }

  onText(text: string, ctx: ToolContext): void {
    ctx.log(`Invalid option keyword: ${text}`);
  }
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

/** RECTANG: two opposite corners -> closed polyline. */
export class RectangleTool implements Tool {
  readonly name = 'RECTANG';
  private first: Point | null = null;

  start(ctx: ToolContext): void {
    this.first = null;
    ctx.prompt('Specify first corner point:');
  }

  private rect(ctx: ToolContext, a: Point, b: Point): Entity {
    return {
      ...baseProps(ctx),
      type: 'polyline',
      closed: true,
      points: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }],
    };
  }

  onPoint(p: Point, ctx: ToolContext): void {
    if (!this.first) {
      this.first = p;
      ctx.setTrackFrom(p);
      ctx.prompt('Specify other corner point:');
      return;
    }
    if (Math.abs(p.x - this.first.x) < 1e-9 || Math.abs(p.y - this.first.y) < 1e-9) return;
    ctx.doc.addEntities([this.rect(ctx, this.first, p)]);
    ctx.finish();
  }

  onMove(p: Point, ctx: ToolContext): void {
    if (!this.first) {
      ctx.setDynText([fmt(p)]);
      return;
    }
    ctx.setPreview([this.rect(ctx, this.first, p)]);
    ctx.setDynText([`${Math.abs(p.x - this.first.x).toFixed(4)} x ${Math.abs(p.y - this.first.y).toFixed(4)}`]);
  }

  onText(text: string, ctx: ToolContext): void {
    ctx.log(`Invalid option keyword: ${text}`);
  }
  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}

/** TEXT: pick insertion point, then type the string at the command line. */
export class TextTool implements Tool {
  readonly name = 'TEXT';
  private pos: Point | null = null;
  height = 0.125;

  start(ctx: ToolContext): void {
    this.pos = null;
    ctx.prompt('Specify start point of text:');
  }

  onPoint(p: Point, ctx: ToolContext): void {
    if (this.pos) return;
    this.pos = p;
    ctx.setTrackFrom(null);
    ctx.prompt(`Enter text (height ${this.height}):`);
    ctx.setPreview([{ ...baseProps(ctx), type: 'text', position: p, text: '|', height: this.height, rotation: 0, align: 'left' }]);
  }

  onMove(p: Point, ctx: ToolContext): void {
    if (!this.pos) ctx.setDynText([fmt(p)]);
  }

  onText(text: string, ctx: ToolContext): void {
    if (!this.pos) {
      ctx.log('Specify a start point first.');
      return;
    }
    if (text.trim().length === 0) {
      ctx.finish();
      return;
    }
    ctx.doc.addEntities([
      { ...baseProps(ctx), type: 'text', position: this.pos, text, height: this.height, rotation: 0, align: 'left' },
    ]);
    // Next line below, like DTEXT
    this.pos = { x: this.pos.x, y: this.pos.y - this.height * 1.6 };
    ctx.setPreview([{ ...baseProps(ctx), type: 'text', position: this.pos, text: '|', height: this.height, rotation: 0, align: 'left' }]);
    ctx.prompt('Enter text (Enter to finish):');
  }

  onEnter(ctx: ToolContext): void {
    ctx.finish();
  }
  onCancel(ctx: ToolContext): void {
    ctx.finish();
  }
}
