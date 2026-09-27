/**
 * Inquiry commands: DIST (with Multiple points), AREA (points / Object / Add / Subtract),
 * ID and LIST for every entity type.
 */
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity } from '../core/entities';
import { entityTypeName, polylineArea, polylineLength, ellipsePoints, ellipseSweep, isFullEllipse, arcEndpoints, entityBounds } from '../core/entities';
import { dimensionMeasurement, dimensionText } from '../core/dimension';
import { mtextLines } from '../core/mtext';
import { textWidth } from '../core/entities';
import { formatLength, formatAngle, formatArea } from '../core/units';
import type { Drawing } from '../core/document';
import type { Tool, ToolContext } from './types';
import { scriptTool, point, pointOrKeyword } from './script';
import { pickAt } from './dimension';

const fl = (ctx: ToolContext, v: number) => formatLength(v, ctx.doc.header.units);

export function distTool(): Tool {
  return scriptTool('DIST', function* (ctx) {
    const a = yield* point(ctx, 'Specify first point:');
    if (!a) return;
    const r = yield* pointOrKeyword('Specify second point or [Multiple points]:', ['Multiple points'], {
      trackFrom: a,
      preview: (c) => [{ id: 'dist', layer: '0', color: 3, type: 'line', a, b: c }],
      dyn: (c) => [fl(ctx, g.dist(a, c))],
    });
    if (!r) return;
    if ('point' in r) {
      const b = r.point;
      const d = g.dist(a, b);
      ctx.log(
        `Distance = ${fl(ctx, d)}, Angle in XY Plane = ${formatAngle(g.angleOf(a, b), Math.max(2, ctx.doc.header.units.auprec))}, Angle from XY Plane = 0`,
      );
      ctx.log(`Delta X = ${fl(ctx, b.x - a.x)}, Delta Y = ${fl(ctx, b.y - a.y)}, Delta Z = ${fl(ctx, 0)}`);
      return;
    }
    if ('text' in r) return;
    const pts = [a];
    let total = 0;
    for (;;) {
      const last = pts[pts.length - 1]!;
      const n = yield* pointOrKeyword('Specify next point or [Arc/Length/Undo/Total] <Total>:', ['Arc', 'Length', 'Undo', 'Total'], {
        trackFrom: last,
        preview: (c) => [{ id: 'dist', layer: '0', color: 3, type: 'polyline', closed: false, points: [...pts, c] }],
        dyn: (c) => [`Distance = ${fl(ctx, total + g.dist(last, c))}`],
      });
      if (!n || ('keyword' in n && n.keyword === 'TOTAL')) break;
      if ('point' in n) {
        total += g.dist(last, n.point);
        pts.push(n.point);
        ctx.log(`Distance = ${fl(ctx, total)}`);
      } else if ('keyword' in n && n.keyword === 'UNDO' && pts.length > 1) {
        const p = pts.pop()!;
        total -= g.dist(pts[pts.length - 1]!, p);
      } else if ('keyword' in n) ctx.log('Option not supported in DIST.');
    }
    ctx.log(`Distance = ${fl(ctx, total)}`);
  });
}

export function idTool(): Tool {
  return scriptTool('ID', function* (ctx) {
    const p = yield* point(ctx, 'Specify point:');
    if (!p) return;
    ctx.log(`X = ${fl(ctx, p.x)}    Y = ${fl(ctx, p.y)}    Z = ${fl(ctx, 0)}`);
  });
}

/** Area and perimeter of a closed entity (null when the entity has no area). */
export function entityArea(e: Entity): { area: number; perimeter: number } | null {
  switch (e.type) {
    case 'circle':
      return { area: Math.PI * e.radius * e.radius, perimeter: 2 * Math.PI * e.radius };
    case 'polyline': {
      const area = Math.abs(polylineArea(e));
      const perimeter = e.closed ? polylineLength(e) : polylineLength(e) + g.dist(e.points[e.points.length - 1]!, e.points[0]!);
      return { area, perimeter };
    }
    case 'ellipse': {
      const a = g.len(e.majorAxis);
      const b = a * e.ratio;
      if (isFullEllipse(e)) {
        // Ramanujan's approximation for the perimeter
        const h = ((a - b) / (a + b)) ** 2;
        return { area: Math.PI * a * b, perimeter: Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h))) };
      }
      const pts = ellipsePoints(e, 128);
      return { area: Math.abs(polygonArea(pts)), perimeter: polylineLen(pts) + g.dist(pts[0]!, pts[pts.length - 1]!) };
    }
    case 'arc': {
      const [s, en] = arcEndpoints(e);
      const sweep = g.normAngle(e.endAngle - e.startAngle) || 2 * Math.PI;
      const segment = (e.radius * e.radius * (sweep - Math.sin(sweep))) / 2;
      return { area: Math.abs(segment), perimeter: sweep * e.radius + g.dist(s, en) };
    }
    default:
      return null;
  }
}

export function polygonArea(pts: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

function polylineLen(pts: readonly Point[]): number {
  let L = 0;
  for (let i = 0; i < pts.length - 1; i += 1) L += g.dist(pts[i]!, pts[i + 1]!);
  return L;
}

export function areaTool(): Tool {
  return scriptTool('AREA', function* (ctx) {
    let running = 0;
    let mode: 'add' | 'subtract' | null = null;
    const report = (area: number, perimeter: number, label = 'Perimeter') => {
      ctx.log(`Area = ${formatArea(area, ctx.doc.header.units)}, ${label} = ${fl(ctx, perimeter)}`);
      if (mode) {
        running += mode === 'add' ? area : -area;
        ctx.log(`Total area = ${formatArea(running, ctx.doc.header.units)}`);
      }
    };
    for (;;) {
      const kws = mode ? ['Object', 'Subtract area', 'Add area', 'eXit'] : ['Object', 'Add area', 'Subtract area', 'eXit'];
      const prompt = mode
        ? `(${mode === 'add' ? 'ADD' : 'SUBTRACT'} mode) Specify first corner point or [Object/${mode === 'add' ? 'Subtract area' : 'Add area'}/eXit]:`
        : 'Specify first corner point or [Object/Add area/Subtract area/eXit] <Object>:';
      const first = yield* pointOrKeyword(prompt, kws, { trackFrom: null });
      let objectMode = false;
      if (!first) {
        if (mode) return;
        objectMode = true;
      } else if ('keyword' in first) {
        if (first.keyword === 'OBJECT') objectMode = true;
        else if (first.keyword === 'ADD AREA') {
          mode = 'add';
          continue;
        } else if (first.keyword === 'SUBTRACT AREA') {
          mode = 'subtract';
          continue;
        } else return;
      } else if ('text' in first) {
        ctx.log(`Invalid option keyword: ${first.text}`);
        continue;
      }
      if (objectMode) {
        for (;;) {
          const p = yield* point(ctx, mode ? `(${mode.toUpperCase()} mode) Select objects:` : 'Select objects:');
          if (!p) break;
          const e = pickAt(ctx, p);
          if (!e) continue;
          const a = entityArea(e);
          if (!a) {
            ctx.log('Selected object does not have an area.');
            continue;
          }
          report(a.area, a.perimeter, e.type === 'circle' ? 'Circumference' : e.type === 'polyline' && !e.closed ? 'Length' : 'Perimeter');
          if (!mode) return;
        }
        if (!mode) return;
        continue;
      }
      // Points
      const pts: Point[] = [(first as { point: Point }).point];
      for (;;) {
        const last = pts[pts.length - 1]!;
        const n = yield* pointOrKeyword(pts.length < 2 ? 'Specify next corner point or [Arc/Length/Undo]:' : 'Specify next corner point or [Arc/Length/Undo/Total] <Total>:', ['Arc', 'Length', 'Undo', 'Total'], {
          trackFrom: last,
          preview: (c) => [{ id: 'area', layer: '0', color: 3, type: 'polyline', closed: true, points: [...pts, c] }],
          dyn: (c) => [`Area = ${formatArea(Math.abs(polygonArea([...pts, c])), ctx.doc.header.units)}`],
        });
        if (!n || ('keyword' in n && n.keyword === 'TOTAL')) break;
        if ('point' in n) pts.push(n.point);
        else if ('keyword' in n && n.keyword === 'UNDO' && pts.length > 1) pts.pop();
        else if ('keyword' in n) ctx.log('Arc and Length options are not supported in AREA.');
      }
      if (pts.length < 3) {
        ctx.log('Area = 0.0000, Perimeter = 0.0000');
        if (!mode) return;
        continue;
      }
      report(Math.abs(polygonArea(pts)), polylineLen(pts) + g.dist(pts[pts.length - 1]!, pts[0]!));
      if (!mode) return;
    }
  });
}

/** AutoCAD-style LIST output for one entity. */
export function listEntity(e: Entity, doc: Drawing): string[] {
  const u = doc.header.units;
  const f = (v: number) => formatLength(v, u);
  const P = (p: Point) => `X=${f(p.x)}  Y=${f(p.y)}  Z=${f(0)}`;
  const head = `                  ${entityTypeName(e)}    Layer: "${e.layer}"`;
  const lines = [head, `                            Space: Model space`, `                   Handle = ${e.id}`];
  if (e.color !== 'ByLayer') lines.push(`                    Color: ${e.color}`);
  if (e.linetype && e.linetype.toUpperCase() !== 'BYLAYER') lines.push(`                 Linetype: ${e.linetype}`);
  if (e.lineWeight !== undefined && e.lineWeight >= 0) lines.push(`               Lineweight: ${(e.lineWeight * 100).toFixed(0)}`);
  switch (e.type) {
    case 'line':
      lines.push(`               from point, ${P(e.a)}`, `                 to point, ${P(e.b)}`);
      lines.push(`                 Length = ${f(g.dist(e.a, e.b))},  Angle in XY Plane = ${formatAngle(g.angleOf(e.a, e.b), Math.max(u.auprec, 0))}`);
      lines.push(`                  Delta X = ${f(e.b.x - e.a.x)}, Delta Y = ${f(e.b.y - e.a.y)}, Delta Z = ${f(0)}`);
      break;
    case 'circle':
      lines.push(`             center point, ${P(e.center)}`, `                   radius  ${f(e.radius)}`, `            circumference  ${f(2 * Math.PI * e.radius)}`, `                     area  ${f(Math.PI * e.radius * e.radius)}`);
      break;
    case 'arc':
      lines.push(`             center point, ${P(e.center)}`, `                   radius  ${f(e.radius)}`, `              start angle  ${formatAngle(e.startAngle, 2)}`, `                end angle  ${formatAngle(e.endAngle, 2)}`, `                   length  ${f((g.normAngle(e.endAngle - e.startAngle) || 2 * Math.PI) * e.radius)}`);
      break;
    case 'polyline': {
      lines.push(`                   ${e.closed ? 'Closed' : 'Open'}`);
      if (e.width) lines.push(`            Constant width  ${f(e.width)}`);
      if (e.filled) lines.push(`                   Filled`);
      e.points.forEach((p, i) => {
        lines.push(`                 at point  ${P(p)}`);
        const b = e.bulges?.[i];
        if (b && Math.abs(b) > 1e-12) lines.push(`                    bulge  ${b.toFixed(4)}`);
      });
      if (e.closed) lines.push(`                     area  ${f(Math.abs(polylineArea(e)))}`);
      lines.push(`                   length  ${f(polylineLength(e))}`);
      break;
    }
    case 'text':
      lines.push(`              Style = "Standard"  Annotative: No`, `                 Typeface = txt`, `              start point, ${P(e.position)}`, `                   height  ${f(e.height)}`, `                     text  ${e.text}`, `           rotation angle  ${formatAngle(e.rotation, 0)}`, `                    width  ${f(textWidth(e.text, e.height))}`, `            justification  ${e.align}`);
      break;
    case 'mtext': {
      const ls = mtextLines(e, textWidth);
      lines.push(`              Style = "Standard"  Annotative: No`, `                 location, ${P(e.position)}`, `                    width  ${f(e.width)}`, `                   height  ${f(e.height)}`, `               attachment  ${['', 'TopLeft', 'TopCenter', 'TopRight', 'MiddleLeft', 'MiddleCenter', 'MiddleRight', 'BottomLeft', 'BottomCenter', 'BottomRight'][e.attachment]}`, `           rotation angle  ${formatAngle(e.rotation, 0)}`, `             line spacing  ${e.lineSpacing.toFixed(4)}`);
      for (const l of ls) lines.push(`                 contents  ${l}`);
      break;
    }
    case 'insert':
      lines.push(`               Block name: "${e.block}"`, `                 at point, ${P(e.position)}`, `                 X scale factor  ${e.scale.toFixed(4)}`, `                 Y scale factor  ${e.scale.toFixed(4)}`, `           rotation angle  ${formatAngle(e.rotation, 0)}`);
      for (const [k, v] of Object.entries(e.attributes)) lines.push(`                ATTRIB  ${k} = "${v}"`);
      break;
    case 'ellipse': {
      const a = g.len(e.majorAxis);
      lines.push(`                   Center: ${P(e.center)}`, `         Major Axis: ${P(e.majorAxis)}`, `         Minor Axis: ${P(g.scale(g.rotate(e.majorAxis, Math.PI / 2), e.ratio))}`, `             Radius Ratio: ${e.ratio.toFixed(4)}`, `              Start Angle: ${formatAngle(e.startParam, 2)}`, `                End Angle: ${formatAngle(e.endParam, 2)}`, `              Major radius  ${f(a)}`);
      if (!isFullEllipse(e)) lines.push(`                 sweep  ${formatAngle(ellipseSweep(e), 2)}`);
      break;
    }
    case 'point':
      lines.push(`                 at point, ${P(e.position)}`);
      break;
    case 'xline':
    case 'ray':
      lines.push(`               base point, ${P(e.base)}`, `             unit direction, ${P(e.direction)}`, `                    angle  ${formatAngle(Math.atan2(e.direction.y, e.direction.x), 2)}`);
      break;
    case 'dimension': {
      const kind = { linear: 'rotated', aligned: 'aligned', radius: 'radial', diameter: 'diametric', angular: '3-point angular' }[e.kind];
      lines.push(`                      type: ${kind}`, `           dimension style: "${e.style.name}"`, `        1st extension defining point: ${P(e.p1)}`, `        2nd extension defining point: ${P(e.p2)}`, `            dimension line defining point: ${P(e.linePoint)}`);
      if (e.kind === 'linear') lines.push(`            rotation angle: ${formatAngle(e.rotation, 2)}`);
      lines.push(`           default text: ${dimensionText({ ...e, text: undefined })}`);
      if (e.text) lines.push(`         dimension text: ${e.text}`);
      lines.push(`          measurement: ${e.kind === 'angular' ? formatAngle(dimensionMeasurement(e), 4) : f(dimensionMeasurement(e))}`);
      break;
    }
  }
  const b = entityBounds(e, doc.lookupBlock);
  if (b && e.type !== 'line' && e.type !== 'point') lines.push(`             Bounding box: ${f(b.min.x)}, ${f(b.min.y)}  to  ${f(b.max.x)}, ${f(b.max.y)}`);
  return lines;
}

export function listTool(): Tool {
  return scriptTool('LIST', function* (ctx) {
    let ids = [...ctx.selection];
    if (ids.length === 0) {
      const a = yield { prompt: 'Select objects:', select: true, distance: false };
      ids = a.type === 'select' ? a.ids : [];
    }
    if (ids.length === 0) {
      ctx.log('Nothing selected.');
      return;
    }
    const set = new Set(ids);
    for (const e of ctx.doc.entities) if (set.has(e.id)) for (const l of listEntity(e, ctx.doc)) ctx.log(l);
  });
}
