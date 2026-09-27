/**
 * AutoCAD drawing commands beyond the basic set: PLINE (Arc/Width/Length/Close),
 * ELLIPSE, POINT, XLINE, RAY, DONUT, POLYGON, MTEXT.
 */
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, PolylineEntity, EllipseEntity, MTextEntity, MTextAttachment } from '../core/entities';
import { newId, bulgeArc, bulgeFromSweep } from '../core/entities';
import { mtextExtents } from '../core/mtext';
import { textWidth } from '../core/entities';
import { pickEntity } from '../core/selection';
import type { Tool, ToolContext } from './types';
import { scriptTool, point, pointOrKeyword, text, number, keyword, dflt, type Step } from './script';

const base = (ctx: ToolContext) => ({ id: newId(), layer: ctx.doc.currentLayer, color: 'ByLayer' as const });
const dist = (a: Point, b: Point) => g.dist(a, b).toFixed(4);
const ang = (a: Point, b: Point) => `${g.deg(g.normAngle(g.angleOf(a, b))).toFixed(0)}°`;

/** Sticky defaults shared between invocations, like AutoCAD system variables. */
export const drawDefaults = {
  plineWidth: 0,
  donutInside: 0.5,
  donutOutside: 1.0,
  polygonSides: 4,
  textHeight: 0.125,
  mtextJustify: 1 as MTextAttachment,
};

// ------------------------------------------------------------------ PLINE

interface PlVertex {
  p: Point;
  bulge: number;
}

/** Tangent direction at the end of the last segment (for tangent arcs / Length). */
function endDirection(v: PlVertex[]): Point | null {
  if (v.length < 2) return null;
  const a = v[v.length - 2]!;
  const b = v[v.length - 1]!;
  const arc = bulgeArc(a.p, b.p, a.bulge);
  if (!arc) return g.normalize(g.sub(b.p, a.p));
  const t = g.angleOf(arc.center, b.p) + (arc.sweep > 0 ? Math.PI / 2 : -Math.PI / 2);
  return { x: Math.cos(t), y: Math.sin(t) };
}

/** Bulge of an arc from a to b that is tangent to direction d at a. */
export function tangentBulge(a: Point, b: Point, d: Point): number {
  const chord = g.sub(b, a);
  if (g.len(chord) < 1e-12) return 0;
  const phi = Math.atan2(g.cross(d, chord), g.dot(d, chord)); // angle from tangent to chord
  const sweep = 2 * phi;
  if (Math.abs(sweep) < 1e-9 || Math.abs(Math.abs(sweep) - 2 * Math.PI) < 1e-9) return 0;
  return bulgeFromSweep(sweep);
}

/** Bulge of the arc a -> b passing through s. */
export function threePointBulge(a: Point, s: Point, b: Point): number {
  const d = 2 * (a.x * (s.y - b.y) + s.x * (b.y - a.y) + b.x * (a.y - s.y));
  if (Math.abs(d) < 1e-12) return 0;
  const a2 = a.x * a.x + a.y * a.y;
  const s2 = s.x * s.x + s.y * s.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c = { x: (a2 * (s.y - b.y) + s2 * (b.y - a.y) + b2 * (a.y - s.y)) / d, y: (a2 * (b.x - s.x) + s2 * (a.x - b.x) + b2 * (s.x - a.x)) / d };
  const aa = g.angleOf(c, a);
  const ab = g.angleOf(c, b);
  const as = g.angleOf(c, s);
  const ccw = g.angleInSweep(as, aa, ab);
  const sweep = ccw ? g.normAngle(ab - aa) : -g.normAngle(aa - ab);
  return bulgeFromSweep(sweep);
}

export function plineTool(): Tool {
  return scriptTool('PLINE', function* (ctx) {
    const verts: PlVertex[] = [];
    let width = drawDefaults.plineWidth;
    let mode: 'line' | 'arc' = 'line';
    const build = (extra: PlVertex | null, closed = false): PolylineEntity => {
      const list = extra ? [...verts, extra] : verts;
      const hasBulge = list.some((v) => Math.abs(v.bulge) > 1e-12);
      return {
        ...base(ctx),
        type: 'polyline',
        points: list.map((v) => v.p),
        closed,
        bulges: hasBulge ? list.map((v) => v.bulge) : undefined,
        width: width > 0 ? width : undefined,
      };
    };
    const last = () => verts[verts.length - 1]!;
    const commit = (closed: boolean) => {
      if (verts.length >= 2 || (closed && verts.length >= 2)) ctx.doc.addEntities([build(null, closed)]);
    };
    const start = yield* point(ctx, 'Specify start point:');
    if (!start) return;
    verts.push({ p: start, bulge: 0 });
    ctx.log(`Current line-width is ${width.toFixed(4)}`);

    const widthPrompt = function* (): Step<void> {
      const w1 = yield* number(ctx, `Specify starting width ${dflt(width)}:`, width, { allowZero: true, from: null });
      if (!w1 || !('value' in w1)) return;
      const w2 = yield* number(ctx, `Specify ending width ${dflt(w1.value)}:`, w1.value, { allowZero: true, from: null });
      if (w2 && 'value' in w2 && Math.abs(w2.value - w1.value) > 1e-9) ctx.log('Tapered segments are not supported; using the starting width.');
      width = w1.value;
      drawDefaults.plineWidth = width;
    };
    const halfwidthPrompt = function* (): Step<void> {
      const w1 = yield* number(ctx, `Specify starting half-width ${dflt(width / 2)}:`, width / 2, { allowZero: true, from: null });
      if (!w1 || !('value' in w1)) return;
      yield* number(ctx, `Specify ending half-width ${dflt(w1.value)}:`, w1.value, { allowZero: true, from: null });
      width = w1.value * 2;
      drawDefaults.plineWidth = width;
    };

    for (;;) {
      if (mode === 'line') {
        const kws = verts.length >= 2 ? ['Arc', 'Close', 'Halfwidth', 'Length', 'Undo', 'Width'] : ['Arc', 'Halfwidth', 'Length', 'Undo', 'Width'];
        const r = yield* pointOrKeyword(`Specify next point or [${kws.join('/')}]:`, kws, {
          preview: (c) => [build({ p: c, bulge: 0 })],
          dyn: (c) => [dist(last().p, c), ang(last().p, c)],
          trackFrom: last().p,
        });
        if (!r) {
          commit(false);
          return;
        }
        if ('point' in r) {
          if (g.eq(last().p, r.point)) continue;
          last().bulge = 0;
          verts.push({ p: r.point, bulge: 0 });
          continue;
        }
        if ('text' in r) {
          ctx.log(`Invalid option keyword: ${r.text}`);
          continue;
        }
        switch (r.keyword) {
          case 'ARC':
            mode = 'arc';
            break;
          case 'CLOSE':
            commit(true);
            return;
          case 'UNDO':
            if (verts.length > 1) verts.pop();
            break;
          case 'WIDTH':
            yield* widthPrompt();
            break;
          case 'HALFWIDTH':
            yield* halfwidthPrompt();
            break;
          case 'LENGTH': {
            const d = endDirection(verts) ?? { x: 1, y: 0 };
            const L = yield* number(ctx, 'Specify length of line:', null, { from: last().p });
            if (L && 'value' in L) {
              last().bulge = 0;
              verts.push({ p: g.add(last().p, g.scale(d, L.value)), bulge: 0 });
            }
            break;
          }
        }
        continue;
      }
      // ---- arc mode
      const kws = verts.length >= 2 ? ['Angle', 'CEnter', 'CLose', 'Direction', 'Halfwidth', 'Line', 'Radius', 'Second pt', 'Undo', 'Width'] : ['Angle', 'CEnter', 'Direction', 'Halfwidth', 'Line', 'Radius', 'Second pt', 'Undo', 'Width'];
      const tangent = endDirection(verts) ?? { x: 1, y: 0 };
      const arcPreview = (b: number, c: Point) => [build({ p: c, bulge: 0 }, false)].map((pl) => ({ ...pl, bulges: [...verts.map((v) => v.bulge).slice(0, -1), b, 0] }));
      const r = yield* pointOrKeyword(`Specify endpoint of arc or [${kws.join('/')}]:`, kws, {
        preview: (c) => arcPreview(tangentBulge(last().p, c, tangent), c),
        dyn: (c) => [dist(last().p, c)],
        trackFrom: last().p,
      });
      if (!r) {
        commit(false);
        return;
      }
      if ('point' in r) {
        if (g.eq(last().p, r.point)) continue;
        last().bulge = tangentBulge(last().p, r.point, tangent);
        verts.push({ p: r.point, bulge: 0 });
        continue;
      }
      if ('text' in r) {
        ctx.log(`Invalid option keyword: ${r.text}`);
        continue;
      }
      switch (r.keyword) {
        case 'LINE':
          mode = 'line';
          break;
        case 'CLOSE': {
          last().bulge = tangentBulge(last().p, verts[0]!.p, tangent);
          commit(true);
          return;
        }
        case 'UNDO':
          if (verts.length > 1) verts.pop();
          break;
        case 'WIDTH':
          yield* widthPrompt();
          break;
        case 'HALFWIDTH':
          yield* halfwidthPrompt();
          break;
        case 'ANGLE': {
          const a = yield* number(ctx, 'Specify included angle:', null, { allowNegative: true, from: null });
          if (!a || !('value' in a)) break;
          const sweep = g.rad(a.value);
          const end = yield* point(ctx, 'Specify endpoint of arc or [CEnter/Radius]:', {
            preview: (c) => arcPreview(bulgeFromSweep(sweep), c),
            trackFrom: last().p,
          });
          if (end && !g.eq(end, last().p)) {
            last().bulge = bulgeFromSweep(sweep);
            verts.push({ p: end, bulge: 0 });
          }
          break;
        }
        case 'CENTER': {
          const c = yield* point(ctx, 'Specify center point of arc:', { trackFrom: last().p });
          if (!c) break;
          const r0 = g.dist(c, last().p);
          if (r0 < 1e-9) break;
          const bulgeTo = (e: Point) => {
            const sweep = g.normAngle(g.angleOf(c, e) - g.angleOf(c, last().p));
            return bulgeFromSweep(sweep >= 2 * Math.PI - 1e-9 ? 0 : sweep);
          };
          const end = yield* point(ctx, 'Specify endpoint of arc or [Angle/Length]:', {
            preview: (cur) => arcPreview(bulgeTo(cur), g.polar(c, g.angleOf(c, cur), r0)),
            trackFrom: c,
          });
          if (end) {
            const e2 = g.polar(c, g.angleOf(c, end), r0);
            last().bulge = bulgeTo(e2);
            verts.push({ p: e2, bulge: 0 });
          }
          break;
        }
        case 'DIRECTION': {
          const d = yield* point(ctx, 'Specify the tangent direction for the start point of arc:', { trackFrom: last().p });
          if (!d || g.eq(d, last().p)) break;
          const dir = g.normalize(g.sub(d, last().p));
          const end = yield* point(ctx, 'Specify endpoint of arc:', { preview: (c) => arcPreview(tangentBulge(last().p, c, dir), c), trackFrom: last().p });
          if (end && !g.eq(end, last().p)) {
            last().bulge = tangentBulge(last().p, end, dir);
            verts.push({ p: end, bulge: 0 });
          }
          break;
        }
        case 'RADIUS': {
          const rr = yield* number(ctx, 'Specify radius of arc:', null, { from: last().p });
          if (!rr || !('value' in rr)) break;
          const radius = rr.value;
          const bulgeTo = (e: Point) => {
            const chord = g.dist(e, last().p);
            if (chord > 2 * radius || chord < 1e-12) return 0;
            const sweep = 2 * Math.asin(chord / (2 * radius));
            const side = g.cross(tangent, g.sub(e, last().p)) >= 0 ? 1 : -1;
            return bulgeFromSweep(side * sweep);
          };
          const end = yield* point(ctx, 'Specify endpoint of arc:', { preview: (c) => arcPreview(bulgeTo(c), c), trackFrom: last().p });
          if (end && !g.eq(end, last().p)) {
            if (g.dist(end, last().p) > 2 * radius) {
              ctx.log('Radius is too small; chord longer than the diameter.');
              break;
            }
            last().bulge = bulgeTo(end);
            verts.push({ p: end, bulge: 0 });
          }
          break;
        }
        case 'SECOND PT': {
          const s = yield* point(ctx, 'Specify second point on arc:', { trackFrom: last().p });
          if (!s) break;
          const end = yield* point(ctx, 'Specify end point of arc:', { preview: (c) => arcPreview(threePointBulge(last().p, s, c), c), trackFrom: s });
          if (end && !g.eq(end, last().p)) {
            last().bulge = threePointBulge(last().p, s, end);
            verts.push({ p: end, bulge: 0 });
          }
          break;
        }
      }
    }
  });
}

// ------------------------------------------------------------------ ELLIPSE

/** Parameter of the ellipse point at world angle `theta` (radians) measured from the major axis. */
export function ellipseParamFromAngle(e: Pick<EllipseEntity, 'majorAxis' | 'ratio'>, theta: number): number {
  const a = g.len(e.majorAxis);
  const b = a * e.ratio;
  return Math.atan2(a * Math.sin(theta), b * Math.cos(theta));
}

export function ellipseTool(): Tool {
  return scriptTool('ELLIPSE', function* (ctx) {
    let isArc = false;
    let center: Point;
    let axisEnd: Point;
    const first = yield* pointOrKeyword('Specify axis endpoint of ellipse or [Arc/Center]:', ['Arc', 'Center']);
    if (!first) return;
    let choice = first;
    if ('keyword' in choice && choice.keyword === 'ARC') {
      isArc = true;
      const again = yield* pointOrKeyword('Specify axis endpoint of elliptical arc or [Center]:', ['Center']);
      if (!again) return;
      choice = again;
    }
    if ('keyword' in choice && choice.keyword === 'CENTER') {
      const c = yield* point(ctx, 'Specify center of ellipse:');
      if (!c) return;
      center = c;
      const e = yield* point(ctx, 'Specify endpoint of axis:', { trackFrom: c, preview: (cur) => [{ ...base(ctx), type: 'line', a: c, b: cur }] });
      if (!e) return;
      axisEnd = e;
    } else if ('point' in choice) {
      const a1 = choice.point;
      const a2 = yield* point(ctx, 'Specify other endpoint of axis:', { trackFrom: a1, preview: (cur) => [{ ...base(ctx), type: 'line', a: a1, b: cur }] });
      if (!a2) return;
      center = g.mid(a1, a2);
      axisEnd = a2;
    } else return;
    const c = center;
    const major = g.sub(axisEnd, c);
    const a = g.len(major);
    if (a < 1e-9) return;
    const ellipseFor = (halfMinor: number): EllipseEntity => {
      // AutoCAD keeps the longer axis as the major axis.
      if (halfMinor > a) {
        const perp = g.scale({ x: -major.y, y: major.x }, halfMinor / a);
        return { ...base(ctx), type: 'ellipse', center: c, majorAxis: perp, ratio: a / halfMinor, startParam: 0, endParam: 2 * Math.PI };
      }
      return { ...base(ctx), type: 'ellipse', center: c, majorAxis: major, ratio: Math.max(1e-6, halfMinor / a), startParam: 0, endParam: 2 * Math.PI };
    };
    const perpDist = (cur: Point) => Math.abs(g.cross(g.normalize(major), g.sub(cur, c)));
    let ell: EllipseEntity | null = null;
    for (;;) {
      const r = yield* pointOrKeyword('Specify distance to other axis or [Rotation]:', ['Rotation'], {
        preview: (cur) => [ellipseFor(Math.max(1e-6, perpDist(cur)))],
        dyn: (cur) => [perpDist(cur).toFixed(4)],
        trackFrom: c,
      });
      if (!r) return;
      if ('point' in r) {
        const d = perpDist(r.point);
        if (d < 1e-9) continue;
        ell = ellipseFor(d);
        break;
      }
      if ('keyword' in r) {
        const rot = yield* number(ctx, 'Specify rotation around major axis:', null, { allowZero: true, allowNegative: true, from: null });
        if (rot && 'value' in rot) {
          const deg = Math.abs(rot.value) % 180;
          if (deg >= 89.4) {
            ctx.log('Rotation must be less than 89.4 degrees.');
            continue;
          }
          ell = ellipseFor(a * Math.cos(g.rad(deg)));
          break;
        }
        continue;
      }
      const v = parseFloat(r.text);
      if (Number.isFinite(v) && v > 0) {
        ell = ellipseFor(v);
        break;
      }
      ctx.log('Requires a distance or option keyword.');
    }
    if (!isArc) {
      ctx.doc.addEntities([ell]);
      return;
    }
    const e0 = ell;
    const majorAngle = Math.atan2(e0.majorAxis.y, e0.majorAxis.x);
    const paramAt = (cur: Point) => ellipseParamFromAngle(e0, g.angleOf(c, cur) - majorAngle);
    const s = yield* pointOrKeyword('Specify start angle or [Parameter]:', ['Parameter'], {
      preview: (cur) => [{ ...base(ctx), type: 'line', a: c, b: cur }],
      trackFrom: c,
    });
    if (!s) return;
    let startParam: number;
    if ('point' in s) startParam = paramAt(s.point);
    else if ('text' in s && Number.isFinite(parseFloat(s.text))) startParam = ellipseParamFromAngle(e0, g.rad(parseFloat(s.text)));
    else {
      const pv = yield* number(ctx, 'Specify start parameter:', 0, { allowZero: true, allowNegative: true, from: null });
      startParam = pv && 'value' in pv ? g.rad(pv.value) : 0;
    }
    const arcFor = (endParam: number): EllipseEntity => ({ ...e0, startParam, endParam });
    const en = yield* pointOrKeyword('Specify end angle or [Parameter/Included angle]:', ['Parameter', 'Included angle'], {
      preview: (cur) => [arcFor(paramAt(cur))],
      trackFrom: c,
    });
    if (!en) return;
    let endParam: number;
    if ('point' in en) endParam = paramAt(en.point);
    else if ('text' in en && Number.isFinite(parseFloat(en.text))) endParam = ellipseParamFromAngle(e0, g.rad(parseFloat(en.text)));
    else if ('keyword' in en && en.keyword === 'INCLUDED ANGLE') {
      const inc = yield* number(ctx, 'Specify included angle for arc <180>:', 180, { from: null });
      endParam = startParam + g.rad(inc && 'value' in inc ? inc.value : 180);
    } else {
      const pv = yield* number(ctx, 'Specify end parameter:', 0, { allowZero: true, allowNegative: true, from: null });
      endParam = pv && 'value' in pv ? g.rad(pv.value) : 0;
    }
    ctx.doc.addEntities([arcFor(endParam)]);
  });
}

// ------------------------------------------------------------------ POINT / XLINE / RAY

export function pointTool(): Tool {
  return scriptTool('POINT', function* (ctx) {
    ctx.log(`Current point modes: PDMODE=${ctx.doc.header.pdmode}  PDSIZE=${ctx.doc.header.pdsize.toFixed(4)}`);
    for (;;) {
      const p = yield* point(ctx, 'Specify a point:');
      if (!p) return;
      ctx.doc.addEntities([{ ...base(ctx), type: 'point', position: p }]);
    }
  });
}

export function rayTool(): Tool {
  return scriptTool('RAY', function* (ctx) {
    const start = yield* point(ctx, 'Specify start point:');
    if (!start) return;
    for (;;) {
      const through = yield* point(ctx, 'Specify through point:', {
        trackFrom: start,
        preview: (c) => (g.eq(c, start) ? [] : [{ ...base(ctx), type: 'ray', base: start, direction: g.normalize(g.sub(c, start)) }]),
      });
      if (!through) return;
      if (g.eq(through, start)) continue;
      ctx.doc.addEntities([{ ...base(ctx), type: 'ray', base: start, direction: g.normalize(g.sub(through, start)) }]);
    }
  });
}

export function xlineTool(): Tool {
  return scriptTool('XLINE', function* (ctx) {
    const xl = (b: Point, d: Point): Entity => ({ ...base(ctx), type: 'xline', base: b, direction: g.normalize(d) });
    const first = yield* pointOrKeyword('Specify a point or [Hor/Ver/Ang/Bisect/Offset]:', ['Hor', 'Ver', 'Ang', 'Bisect', 'Offset']);
    if (!first) return;
    if ('point' in first) {
      const b = first.point;
      for (;;) {
        const t = yield* point(ctx, 'Specify through point:', { trackFrom: b, preview: (c) => (g.eq(c, b) ? [] : [xl(b, g.sub(c, b))]) });
        if (!t) return;
        if (!g.eq(t, b)) ctx.doc.addEntities([xl(b, g.sub(t, b))]);
      }
    }
    if ('text' in first) return;
    const fixedDirection = function* (d: Point): Step<void> {
      for (;;) {
        const t = yield* point(ctx, 'Specify through point:', { preview: (c) => [xl(c, d)] });
        if (!t) return;
        ctx.doc.addEntities([xl(t, d)]);
      }
    };
    switch (first.keyword) {
      case 'HOR':
        yield* fixedDirection({ x: 1, y: 0 });
        return;
      case 'VER':
        yield* fixedDirection({ x: 0, y: 1 });
        return;
      case 'ANG': {
        const a = yield* number(ctx, 'Enter angle of xline (0) or [Reference]:', 0, { allowZero: true, allowNegative: true, from: null, keywords: ['Reference'] });
        if (!a) return;
        if ('keyword' in a) {
          ctx.log('Reference angles are not supported.');
          return;
        }
        yield* fixedDirection({ x: Math.cos(g.rad(a.value)), y: Math.sin(g.rad(a.value)) });
        return;
      }
      case 'BISECT': {
        const v = yield* point(ctx, 'Specify angle vertex point:');
        if (!v) return;
        const s = yield* point(ctx, 'Specify angle start point:', { trackFrom: v });
        if (!s) return;
        for (;;) {
          const e = yield* point(ctx, 'Specify angle end point:', {
            trackFrom: v,
            preview: (c) => {
              const half = g.angleOf(v, s) + g.normAngle(g.angleOf(v, c) - g.angleOf(v, s)) / 2;
              return [xl(v, { x: Math.cos(half), y: Math.sin(half) })];
            },
          });
          if (!e) return;
          const half = g.angleOf(v, s) + g.normAngle(g.angleOf(v, e) - g.angleOf(v, s)) / 2;
          ctx.doc.addEntities([xl(v, { x: Math.cos(half), y: Math.sin(half) })]);
        }
      }
      case 'OFFSET': {
        const d = yield* number(ctx, `Specify offset distance or [Through] ${dflt(drawDefaults.plineWidth || 1)}:`, 1, { keywords: ['Through'], from: null });
        if (!d) return;
        const through = 'keyword' in d;
        for (;;) {
          const pk = yield* point(ctx, 'Select a line object:');
          if (!pk) return;
          const hidden = new Set(ctx.doc.layers.filter((l) => !l.visible).map((l) => l.name));
          const hit = pickEntity(pk, ctx.doc.entities, ctx.doc.lookupBlock, ctx.aperture(), hidden);
          if (!hit || (hit.type !== 'line' && hit.type !== 'xline' && hit.type !== 'ray')) {
            ctx.log('Object selected is not a line.');
            continue;
          }
          const lineBase = hit.type === 'line' ? hit.a : hit.base;
          const dir = g.normalize(hit.type === 'line' ? g.sub(hit.b, hit.a) : hit.direction);
          const n = { x: -dir.y, y: dir.x };
          const side = yield* point(ctx, through ? 'Specify through point:' : 'Specify side to offset:', {
            preview: (c) => {
              const off = through ? g.dot(g.sub(c, lineBase), n) : Math.sign(g.dot(g.sub(c, lineBase), n)) * ('value' in d ? d.value : 1);
              return [xl(g.add(lineBase, g.scale(n, off)), dir)];
            },
          });
          if (!side) return;
          const off = through ? g.dot(g.sub(side, lineBase), n) : Math.sign(g.dot(g.sub(side, lineBase), n)) * ('value' in d ? d.value : 1);
          ctx.doc.addEntities([xl(g.add(lineBase, g.scale(n, off)), dir)]);
        }
      }
    }
  });
}

// ------------------------------------------------------------------ DONUT / POLYGON

export function donutEntity(ctx: ToolContext, center: Point, inside: number, outside: number): Entity {
  if (inside <= 1e-9) return { ...base(ctx), type: 'circle', center, radius: outside / 2, filled: true };
  const r = (inside + outside) / 4;
  return {
    ...base(ctx),
    type: 'polyline',
    closed: true,
    points: [
      { x: center.x - r, y: center.y },
      { x: center.x + r, y: center.y },
    ],
    bulges: [1, 1],
    width: (outside - inside) / 2,
  };
}

export function donutTool(): Tool {
  return scriptTool('DONUT', function* (ctx) {
    const i = yield* number(ctx, `Specify inside diameter of donut ${dflt(drawDefaults.donutInside)}:`, drawDefaults.donutInside, { allowZero: true, from: null });
    if (!i || !('value' in i)) return;
    const o = yield* number(ctx, `Specify outside diameter of donut ${dflt(drawDefaults.donutOutside)}:`, drawDefaults.donutOutside, { from: null });
    if (!o || !('value' in o)) return;
    if (o.value <= i.value) {
      ctx.log('Outside diameter must be larger than the inside diameter.');
      return;
    }
    drawDefaults.donutInside = i.value;
    drawDefaults.donutOutside = o.value;
    for (;;) {
      const c = yield* point(ctx, 'Specify center of donut or <exit>:', { preview: (cur) => [donutEntity(ctx, cur, i.value, o.value)] });
      if (!c) return;
      ctx.doc.addEntities([donutEntity(ctx, c, i.value, o.value)]);
    }
  });
}

export function polygonPoints(center: Point, sides: number, radius: number, inscribed: boolean, startAngle: number): Point[] {
  const r = inscribed ? radius : radius / Math.cos(Math.PI / sides);
  const out: Point[] = [];
  const offset = inscribed ? 0 : Math.PI / sides;
  for (let k = 0; k < sides; k += 1) out.push(g.polar(center, startAngle + offset + (2 * Math.PI * k) / sides, r));
  return out;
}

export function polygonTool(): Tool {
  return scriptTool('POLYGON', function* (ctx) {
    const n = yield* number(ctx, `Enter number of sides ${dflt(String(drawDefaults.polygonSides))}:`, drawDefaults.polygonSides, { integer: true, min: 3, from: null });
    if (!n || !('value' in n)) return;
    const sides = Math.round(n.value);
    if (sides > 1024) {
      ctx.log('Number of sides must be between 3 and 1024.');
      return;
    }
    drawDefaults.polygonSides = sides;
    const poly = (pts: Point[]): PolylineEntity => ({ ...base(ctx), type: 'polyline', points: pts, closed: true });
    const first = yield* pointOrKeyword('Specify center of polygon or [Edge]:', ['Edge']);
    if (!first || 'text' in first) return;
    if ('keyword' in first) {
      const a = yield* point(ctx, 'Specify first endpoint of edge:');
      if (!a) return;
      const edgePoly = (b: Point) => {
        const L = g.dist(a, b);
        if (L < 1e-9) return [];
        const r = L / (2 * Math.sin(Math.PI / sides));
        const m = g.mid(a, b);
        const nrm = g.normalize({ x: -(b.y - a.y), y: b.x - a.x });
        const c = g.add(m, g.scale(nrm, Math.sqrt(Math.max(0, r * r - (L * L) / 4))));
        return [poly(polygonPoints(c, sides, r, true, g.angleOf(c, a)))];
      };
      const b = yield* point(ctx, 'Specify second endpoint of edge:', { trackFrom: a, preview: edgePoly });
      if (!b || g.eq(a, b)) return;
      ctx.doc.addEntities(edgePoly(b));
      return;
    }
    const c = first.point;
    const mode = yield* keyword(ctx, 'Enter an option [Inscribed in circle/Circumscribed about circle] <I>:', ['Inscribed in circle', 'Circumscribed about circle'], 'I');
    const inscribed = mode !== 'CIRCUMSCRIBED ABOUT CIRCLE';
    const r = yield* pointOrKeyword('Specify radius of circle:', [], {
      trackFrom: c,
      preview: (cur) => (g.eq(cur, c) ? [] : [poly(polygonPoints(c, sides, g.dist(c, cur), inscribed, g.angleOf(c, cur) - (inscribed ? 0 : Math.PI / sides)))]),
      dyn: (cur) => [`R ${dist(c, cur)}`],
    });
    if (!r) return;
    if ('point' in r) {
      if (g.eq(r.point, c)) return;
      ctx.doc.addEntities([poly(polygonPoints(c, sides, g.dist(c, r.point), inscribed, g.angleOf(c, r.point) - (inscribed ? 0 : Math.PI / sides)))]);
      return;
    }
    const v = 'text' in r ? parseFloat(r.text) : NaN;
    if (!Number.isFinite(v) || v <= 0) {
      ctx.log('Requires a positive radius.');
      return;
    }
    // Typed radius: AutoCAD puts a flat edge on the bottom for a typed value.
    ctx.doc.addEntities([poly(polygonPoints(c, sides, v, inscribed, inscribed ? Math.PI / 2 - Math.PI / sides : -Math.PI / 2 - Math.PI / sides + Math.PI / sides))]);
  });
}

// ------------------------------------------------------------------ MTEXT

const JUSTIFY: Record<string, MTextAttachment> = { TL: 1, TC: 2, TR: 3, ML: 4, MC: 5, MR: 6, BL: 7, BC: 8, BR: 9 };
const JUSTIFY_NAMES: Record<MTextAttachment, string> = { 1: 'TL', 2: 'TC', 3: 'TR', 4: 'ML', 5: 'MC', 6: 'MR', 7: 'BL', 8: 'BC', 9: 'BR' };

/** Attachment point of an MTEXT for a rectangle given its two corners. */
export function mtextAnchor(a: Point, b: Point, attachment: MTextAttachment): Point {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const col = (attachment - 1) % 3;
  const row = Math.floor((attachment - 1) / 3);
  return { x: col === 0 ? minX : col === 1 ? (minX + maxX) / 2 : maxX, y: row === 0 ? maxY : row === 1 ? (minY + maxY) / 2 : minY };
}

export function mtextTool(): Tool {
  return scriptTool('MTEXT', function* (ctx) {
    let height = drawDefaults.textHeight;
    let attachment = drawDefaults.mtextJustify;
    let rotation = 0;
    let lineSpacing = 1;
    ctx.log(`Current text style: "Standard"  Text height: ${height.toFixed(4)}  Annotative: No`);
    const first = yield* point(ctx, 'Specify first corner:');
    if (!first) return;
    let width = 0;
    let anchor: Point | null = null;
    const boxPreview = (c: Point): Entity[] => [{ ...base(ctx), type: 'polyline', closed: true, points: [first, { x: c.x, y: first.y }, c, { x: first.x, y: c.y }] }];
    for (;;) {
      const r = yield* pointOrKeyword('Specify opposite corner or [Height/Justify/Line spacing/Rotation/Style/Width/Columns]:', ['Height', 'Justify', 'Line spacing', 'Rotation', 'Style', 'Width', 'Columns'], {
        preview: boxPreview,
        dyn: (c) => [`${Math.abs(c.x - first.x).toFixed(4)} x ${Math.abs(c.y - first.y).toFixed(4)}`],
        trackFrom: first,
      });
      if (!r) return;
      if ('point' in r) {
        width = Math.abs(r.point.x - first.x);
        anchor = mtextAnchor(first, r.point, attachment);
        break;
      }
      if ('text' in r) {
        ctx.log(`Invalid option keyword: ${r.text}`);
        continue;
      }
      switch (r.keyword) {
        case 'HEIGHT': {
          const h = yield* number(ctx, `Specify height ${dflt(height)}:`, height, { from: first });
          if (h && 'value' in h) height = h.value;
          break;
        }
        case 'JUSTIFY': {
          const j = yield* keyword(ctx, `Enter justification [TL/TC/TR/ML/MC/MR/BL/BC/BR] <${JUSTIFY_NAMES[attachment]}>:`, Object.keys(JUSTIFY), JUSTIFY_NAMES[attachment]);
          if (j && JUSTIFY[j]) attachment = JUSTIFY[j]!;
          break;
        }
        case 'LINE SPACING': {
          const ls = yield* number(ctx, `Enter line spacing factor ${dflt(lineSpacing)}:`, lineSpacing, { from: null, min: 0.25 });
          if (ls && 'value' in ls) lineSpacing = Math.min(4, ls.value);
          break;
        }
        case 'ROTATION': {
          const rot = yield* number(ctx, `Specify rotation angle <${g.deg(rotation).toFixed(0)}>:`, g.deg(rotation), { allowZero: true, allowNegative: true, from: null });
          if (rot && 'value' in rot) rotation = g.rad(rot.value);
          break;
        }
        case 'WIDTH': {
          const w = yield* number(ctx, `Specify width ${dflt(width)}:`, width, { allowZero: true, from: first });
          if (w && 'value' in w) {
            width = w.value;
            anchor = first;
          }
          break;
        }
        default:
          ctx.log('Only the Standard style and a single column are supported.');
      }
      if (anchor) break;
    }
    drawDefaults.textHeight = height;
    drawDefaults.mtextJustify = attachment;
    const pos = anchor ?? first;
    const lines: string[] = [];
    const build = (extraLine: string | null): MTextEntity => ({
      ...base(ctx),
      type: 'mtext',
      position: pos,
      text: [...lines, ...(extraLine !== null ? [extraLine] : [])].join('\n'),
      height,
      width,
      rotation,
      attachment,
      lineSpacing,
    });
    for (;;) {
      const t = yield* text(lines.length === 0 ? 'Enter text (Enter on an empty line to finish):' : 'Enter next line:', null, true);
      if (t === null) break;
      lines.push(t);
      ctx.setPreview([build('|')]);
    }
    if (lines.length === 0 || lines.every((l) => l.trim() === '')) return;
    const m = build(null);
    const ext = mtextExtents(m, textWidth);
    ctx.doc.addEntities([m]);
    ctx.log(`MTEXT: ${ext.lines.length} line(s), width ${ext.width.toFixed(4)}`);
  });
}

