/**
 * Dimensioning commands: DIMLINEAR, DIMALIGNED, DIMRADIUS, DIMDIAMETER, DIMANGULAR.
 * Prompts follow AutoCAD; "<select object>" on Enter dimensions a picked line/arc/circle.
 */
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, DimensionEntity, DimKind } from '../core/entities';
import { newId, arcEndpoints } from '../core/entities';
import { dimensionText } from '../core/dimension';
import { pickEntity } from '../core/selection';
import type { Tool, ToolContext } from './types';
import { scriptTool, point, pointOrKeyword, text, number, type Step } from './script';

export function pickAt(ctx: ToolContext, p: Point): Entity | null {
  const hidden = new Set(ctx.doc.layers.filter((l) => !l.visible).map((l) => l.name));
  return pickEntity(p, ctx.doc.entities, ctx.doc.lookupBlock, ctx.aperture(), hidden);
}

function makeDim(ctx: ToolContext, kind: DimKind, p1: Point, p2: Point, linePoint: Point, rotation = 0, extra: Partial<DimensionEntity> = {}): DimensionEntity {
  return {
    id: newId(),
    layer: ctx.doc.currentLayer,
    color: 'ByLayer',
    type: 'dimension',
    kind,
    p1,
    p2,
    linePoint,
    rotation,
    style: ctx.doc.header.dimStyle,
    ...extra,
  };
}

/** Shared "[Mtext/Text/Angle]" handling: returns the text override, or undefined. */
function* textOverride(ctx: ToolContext, sample: DimensionEntity): Step<string | undefined> {
  const current = dimensionText(sample);
  const t = yield* text(`Enter dimension text <${current}>:`, null, true);
  if (t === null || t.trim() === '' || t.trim() === current) return undefined;
  ctx.log(`Dimension text = ${t}`);
  return t;
}

/** Linear dimension orientation from where the dimension line was placed. */
function autoRotation(p1: Point, p2: Point, loc: Point): number {
  const dx = Math.abs(p2.x - p1.x);
  const dy = Math.abs(p2.y - p1.y);
  if (dx < 1e-9) return Math.PI / 2;
  if (dy < 1e-9) return 0;
  const m = g.mid(p1, p2);
  // Placing the line above/below the points gives a horizontal dimension, beside them a vertical one.
  return Math.abs(loc.y - m.y) * dx >= Math.abs(loc.x - m.x) * dy ? 0 : Math.PI / 2;
}

/** "<select object>": pick a line/arc/circle and return its two definition points. */
function* selectObjectPoints(ctx: ToolContext): Step<[Point, Point] | null> {
  for (;;) {
    const p = yield* point(ctx, 'Select object to dimension:');
    if (!p) return null;
    const e = pickAt(ctx, p);
    if (!e) continue;
    if (e.type === 'line') return [e.a, e.b];
    if (e.type === 'arc') return arcEndpoints(e);
    if (e.type === 'circle') return [{ x: e.center.x - e.radius, y: e.center.y }, { x: e.center.x + e.radius, y: e.center.y }];
    if (e.type === 'polyline' && e.points.length >= 2) {
      // nearest segment
      let best: [Point, Point] = [e.points[0]!, e.points[1]!];
      let bestD = Infinity;
      const n = e.points.length;
      const count = e.closed ? n : n - 1;
      for (let i = 0; i < count; i += 1) {
        const a = e.points[i]!;
        const b = e.points[(i + 1) % n]!;
        const d = g.distToSegment(p, a, b);
        if (d < bestD) {
          bestD = d;
          best = [a, b];
        }
      }
      return best;
    }
    ctx.log('Object selected is not a line, arc, circle, or polyline.');
  }
}

export function dimLinearTool(): Tool {
  return scriptTool('DIMLINEAR', function* (ctx) {
    const first = yield* pointOrKeyword('Specify first extension line origin or <select object>:');
    let p1: Point;
    let p2: Point;
    if (!first) {
      const pts = yield* selectObjectPoints(ctx);
      if (!pts) return;
      [p1, p2] = pts;
    } else if ('point' in first) {
      p1 = first.point;
      const second = yield* point(ctx, 'Specify second extension line origin:', { trackFrom: p1 });
      if (!second) return;
      p2 = second;
    } else return;
    let forced: number | null = null;
    let override: string | undefined;
    const build = (loc: Point) => makeDim(ctx, 'linear', p1, p2, loc, forced ?? autoRotation(p1, p2, loc), { text: override });
    for (;;) {
      const r = yield* pointOrKeyword('Specify dimension line location or [Mtext/Text/Angle/Horizontal/Vertical/Rotated]:', ['Mtext', 'Text', 'Angle', 'Horizontal', 'Vertical', 'Rotated'], {
        preview: (c) => [build(c)],
        dyn: (c) => [dimensionText(build(c))],
        trackFrom: null,
      });
      if (!r) return;
      if ('point' in r) {
        const dim = build(r.point);
        ctx.doc.addEntities([dim]);
        ctx.log(`Dimension text = ${dimensionText(dim)}`);
        return;
      }
      if ('keyword' in r) {
        if (r.keyword === 'HORIZONTAL') forced = 0;
        else if (r.keyword === 'VERTICAL') forced = Math.PI / 2;
        else if (r.keyword === 'ROTATED') {
          const a = yield* number(ctx, 'Specify angle of dimension line <0>:', 0, { allowZero: true, allowNegative: true });
          if (a && 'value' in a) forced = g.rad(a.value);
        } else if (r.keyword === 'TEXT' || r.keyword === 'MTEXT') override = yield* textOverride(ctx, build(g.mid(p1, p2)));
        else ctx.log('Text angle is not supported; text follows the dimension line.');
      } else ctx.log(`Invalid option keyword: ${r.text}`);
    }
  });
}

export function dimAlignedTool(): Tool {
  return scriptTool('DIMALIGNED', function* (ctx) {
    const first = yield* pointOrKeyword('Specify first extension line origin or <select object>:');
    let p1: Point;
    let p2: Point;
    if (!first) {
      const pts = yield* selectObjectPoints(ctx);
      if (!pts) return;
      [p1, p2] = pts;
    } else if ('point' in first) {
      p1 = first.point;
      const second = yield* point(ctx, 'Specify second extension line origin:', { trackFrom: p1 });
      if (!second) return;
      p2 = second;
    } else return;
    let override: string | undefined;
    const build = (loc: Point) => makeDim(ctx, 'aligned', p1, p2, loc, 0, { text: override });
    for (;;) {
      const r = yield* pointOrKeyword('Specify dimension line location or [Mtext/Text/Angle]:', ['Mtext', 'Text', 'Angle'], {
        preview: (c) => [build(c)],
        dyn: (c) => [dimensionText(build(c))],
        trackFrom: null,
      });
      if (!r) return;
      if ('point' in r) {
        const dim = build(r.point);
        ctx.doc.addEntities([dim]);
        ctx.log(`Dimension text = ${dimensionText(dim)}`);
        return;
      }
      if ('keyword' in r && (r.keyword === 'TEXT' || r.keyword === 'MTEXT')) override = yield* textOverride(ctx, build(g.mid(p1, p2)));
      else if ('keyword' in r) ctx.log('Text angle is not supported.');
      else ctx.log(`Invalid option keyword: ${r.text}`);
    }
  });
}

function radialTool(kind: 'radius' | 'diameter'): Tool {
  return scriptTool(kind === 'radius' ? 'DIMRADIUS' : 'DIMDIAMETER', function* (ctx) {
    let center: Point | null = null;
    let onCircle: Point | null = null;
    while (!center) {
      const p = yield* point(ctx, 'Select arc or circle:');
      if (!p) return;
      const e = pickAt(ctx, p);
      if (!e || (e.type !== 'circle' && e.type !== 'arc')) {
        if (e) ctx.log('Object selected is not a circle or arc.');
        continue;
      }
      center = e.center;
      onCircle = g.polar(center, g.angleOf(center, p), e.radius);
    }
    let override: string | undefined;
    const c = center;
    const build = (loc: Point) => makeDim(ctx, kind, c, onCircle!, loc, 0, { text: override });
    ctx.log(`Dimension text = ${dimensionText(build(onCircle!))}`);
    for (;;) {
      const r = yield* pointOrKeyword('Specify dimension line location or [Mtext/Text/Angle]:', ['Mtext', 'Text', 'Angle'], {
        preview: (cur) => [build(cur)],
        dyn: (cur) => [dimensionText(build(cur))],
        trackFrom: null,
      });
      if (!r) return;
      if ('point' in r) {
        // A point exactly on the centre would leave no direction; nudge it onto the circle.
        const loc = g.dist(r.point, c) < 1e-9 ? onCircle! : r.point;
        ctx.doc.addEntities([build(loc)]);
        return;
      }
      if ('keyword' in r && (r.keyword === 'TEXT' || r.keyword === 'MTEXT')) override = yield* textOverride(ctx, build(onCircle!));
      else if ('keyword' in r) ctx.log('Text angle is not supported.');
      else ctx.log(`Invalid option keyword: ${r.text}`);
    }
  });
}

export const dimRadiusTool = (): Tool => radialTool('radius');
export const dimDiameterTool = (): Tool => radialTool('diameter');

/** Intersection of two infinite lines (null when parallel). */
function lineIntersection(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const r = g.sub(a2, a1);
  const s = g.sub(b2, b1);
  const denom = g.cross(r, s);
  if (Math.abs(denom) < 1e-12) return null;
  const t = g.cross(g.sub(b1, a1), s) / denom;
  return g.add(a1, g.scale(r, t));
}

export function dimAngularTool(): Tool {
  return scriptTool('DIMANGULAR', function* (ctx) {
    let center: Point | null = null;
    let p1: Point | null = null;
    let p2: Point | null = null;
    const first = yield* pointOrKeyword('Select arc, circle, line, or <specify vertex>:');
    if (!first) {
      center = yield* point(ctx, 'Specify angle vertex:');
      if (!center) return;
      p1 = yield* point(ctx, 'Specify first angle endpoint:', { trackFrom: center });
      if (!p1) return;
      p2 = yield* point(ctx, 'Specify second angle endpoint:', { trackFrom: center });
      if (!p2) return;
    } else if ('point' in first) {
      const e = pickAt(ctx, first.point);
      if (!e) {
        ctx.log('Nothing selected.');
        return;
      }
      if (e.type === 'arc') {
        center = e.center;
        [p1, p2] = arcEndpoints(e);
      } else if (e.type === 'circle') {
        center = e.center;
        p1 = g.polar(e.center, g.angleOf(e.center, first.point), e.radius);
        const second = yield* point(ctx, 'Specify second angle endpoint:', { trackFrom: center });
        if (!second) return;
        p2 = g.polar(e.center, g.angleOf(e.center, second), e.radius);
      } else if (e.type === 'line') {
        let other: Entity | null = null;
        while (!other) {
          const q = yield* point(ctx, 'Select second line:');
          if (!q) return;
          other = pickAt(ctx, q);
          if (other && other.type !== 'line') {
            ctx.log('Object selected is not a line.');
            other = null;
          }
        }
        if (other.type !== 'line') return;
        center = lineIntersection(e.a, e.b, other.a, other.b);
        if (!center) {
          ctx.log('Lines are parallel.');
          return;
        }
        const far = (l: { a: Point; b: Point }, near: Point) => (g.dist(l.a, near) >= g.dist(l.b, near) ? l.a : l.b);
        // Use the ends of the legs nearer to the pick points (AutoCAD measures the angle between the picked halves).
        const nearHalf = (l: { a: Point; b: Point }, pick: Point, c: Point) => (g.dot(g.sub(pick, c), g.sub(l.a, c)) >= 0 ? l.a : l.b);
        p1 = g.dist(e.a, center) < 1e-9 || g.dist(e.b, center) < 1e-9 ? far(e, center) : nearHalf(e, first.point, center);
        p2 = far(other, center);
      } else {
        ctx.log('Object selected is not an arc, circle, or line.');
        return;
      }
    } else return;
    const c = center;
    const a = p1;
    const b = p2;
    let override: string | undefined;
    const build = (loc: Point) => makeDim(ctx, 'angular', a, b, loc, 0, { center: c, text: override });
    for (;;) {
      const r = yield* pointOrKeyword('Specify dimension arc line location or [Mtext/Text/Angle]:', ['Mtext', 'Text', 'Angle'], {
        preview: (cur) => (g.dist(cur, c) > 1e-9 ? [build(cur)] : []),
        dyn: (cur) => [dimensionText(build(cur))],
        trackFrom: null,
      });
      if (!r) return;
      if ('point' in r) {
        if (g.dist(r.point, c) < 1e-9) continue;
        const dim = build(r.point);
        ctx.doc.addEntities([dim]);
        ctx.log(`Dimension text = ${dimensionText(dim)}`);
        return;
      }
      if ('keyword' in r && (r.keyword === 'TEXT' || r.keyword === 'MTEXT')) override = yield* textOverride(ctx, build(g.polar(c, g.angleOf(c, g.mid(a, b)), Math.max(g.dist(c, a), g.dist(c, b)))));
      else if ('keyword' in r) ctx.log('Text angle is not supported.');
      else ctx.log(`Invalid option keyword: ${r.text}`);
    }
  });
}
