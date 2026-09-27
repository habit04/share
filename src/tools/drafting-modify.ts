/**
 * Modify commands: FILLET, CHAMFER, ARRAY (rectangular/polar), STRETCH, BREAK,
 * JOIN, LENGTHEN, ALIGN, MATCHPROP.
 */
import type { Point, Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import type { Entity, LineEntity, ArcEntity, PolylineEntity } from '../core/entities';
import { newId, translateEntity, rotateEntity, scaleEntityBy, arcEndpoints, bulgeFromSweep, polylineLength, entityBounds, polylineSegments } from '../core/entities';
import { selectByBox } from '../core/selection';
import type { Tool, ToolContext } from './types';
import { scriptTool, point, pointOrKeyword, number, keyword, select, dflt, type Step } from './script';
import { pickAt } from './dimension';

export const modifyDefaults = {
  filletRadius: 0.5,
  filletTrim: true,
  chamferD1: 0.5,
  chamferD2: 0.5,
  arrayRows: 3,
  arrayCols: 4,
  arrayRowOffset: 1,
  arrayColOffset: 1,
  polarItems: 6,
  polarAngle: 360,
  lengthenDelta: 0,
};

/** Intersection of the infinite lines through a1-a2 and b1-b2. */
export function lineLineIntersect(a1: Point, a2: Point, b1: Point, b2: Point): Point | null {
  const r = g.sub(a2, a1);
  const s = g.sub(b2, b1);
  const denom = g.cross(r, s);
  if (Math.abs(denom) < 1e-12) return null;
  const t = g.cross(g.sub(b1, a1), s) / denom;
  return g.add(a1, g.scale(r, t));
}

/** The end of a line on the side of `x` where the pick point lies (kept end when filleting). */
function keptEnd(l: LineEntity, x: Point, pick: Point): Point {
  const u = g.sub(pick, x);
  const da = g.dot(g.sub(l.a, x), u);
  const db = g.dot(g.sub(l.b, x), u);
  return da >= db ? l.a : l.b;
}

export interface FilletResult {
  line1: LineEntity;
  line2: LineEntity;
  arc: ArcEntity | null;
}

/** Fillet two lines with radius r (0 = sharp corner). Pick points decide which halves survive. */
export function filletLines(l1: LineEntity, pick1: Point, l2: LineEntity, pick2: Point, r: number, trim = true): FilletResult | null {
  const x = lineLineIntersect(l1.a, l1.b, l2.a, l2.b);
  if (!x) return null;
  const e1 = keptEnd(l1, x, pick1);
  const e2 = keptEnd(l2, x, pick2);
  const u1 = g.normalize(g.sub(e1, x));
  const u2 = g.normalize(g.sub(e2, x));
  if (r <= 1e-12) {
    return { line1: { ...l1, a: e1, b: x }, line2: { ...l2, a: e2, b: x }, arc: null };
  }
  const cosT = Math.max(-1, Math.min(1, g.dot(u1, u2)));
  const theta = Math.acos(cosT);
  if (theta < 1e-6 || Math.abs(theta - Math.PI) < 1e-6) return null;
  const t = r / Math.tan(theta / 2);
  if (t > g.dist(e1, x) + 1e-9 || t > g.dist(e2, x) + 1e-9) return null; // radius too large
  const t1 = g.add(x, g.scale(u1, t));
  const t2 = g.add(x, g.scale(u2, t));
  const bis = g.normalize(g.add(u1, u2));
  const center = g.add(x, g.scale(bis, r / Math.sin(theta / 2)));
  const a1 = g.angleOf(center, t1);
  const a2 = g.angleOf(center, t2);
  const towardX = g.angleOf(center, x);
  const ccw = g.angleInSweep(towardX, a1, a2);
  const arc: ArcEntity = { id: newId(), layer: l1.layer, color: l1.color, linetype: l1.linetype, lineWeight: l1.lineWeight, type: 'arc', center, radius: r, startAngle: ccw ? a1 : a2, endAngle: ccw ? a2 : a1 };
  if (!trim) return { line1: l1, line2: l2, arc };
  return { line1: { ...l1, a: e1, b: t1 }, line2: { ...l2, a: e2, b: t2 }, arc };
}

/** Chamfer two lines with distances d1 (first line) and d2 (second line). */
export function chamferLines(l1: LineEntity, pick1: Point, l2: LineEntity, pick2: Point, d1: number, d2: number, trim = true): FilletResult | null {
  const x = lineLineIntersect(l1.a, l1.b, l2.a, l2.b);
  if (!x) return null;
  const e1 = keptEnd(l1, x, pick1);
  const e2 = keptEnd(l2, x, pick2);
  const u1 = g.normalize(g.sub(e1, x));
  const u2 = g.normalize(g.sub(e2, x));
  if (d1 > g.dist(e1, x) + 1e-9 || d2 > g.dist(e2, x) + 1e-9) return null;
  const t1 = g.add(x, g.scale(u1, d1));
  const t2 = g.add(x, g.scale(u2, d2));
  const bevel: LineEntity = { id: newId(), layer: l1.layer, color: l1.color, linetype: l1.linetype, lineWeight: l1.lineWeight, type: 'line', a: t1, b: t2 };
  if (d1 <= 1e-12 && d2 <= 1e-12) return { line1: { ...l1, a: e1, b: x }, line2: { ...l2, a: e2, b: x }, arc: null };
  if (!trim) return { line1: l1, line2: l2, arc: null, ...{ bevel } } as FilletResult & { bevel: LineEntity };
  return { line1: { ...l1, a: e1, b: t1 }, line2: { ...l2, a: e2, b: t2 }, arc: null, ...{ bevel } } as FilletResult & { bevel: LineEntity };
}

/** Fillet every corner of a polyline with straight segments (PLINE option). */
export function filletPolyline(pl: PolylineEntity, r: number): PolylineEntity | null {
  const n = pl.points.length;
  if (n < 3 || pl.bulges?.some((b) => Math.abs(b) > 1e-12)) return null;
  const pts: Point[] = [];
  const bulges: number[] = [];
  const cornerCount = pl.closed ? n : n - 2;
  const corner = (i: number): { t1: Point; t2: Point; bulge: number } | null => {
    const prev = pl.points[(i - 1 + n) % n]!;
    const cur = pl.points[i]!;
    const next = pl.points[(i + 1) % n]!;
    const u1 = g.normalize(g.sub(prev, cur));
    const u2 = g.normalize(g.sub(next, cur));
    const theta = Math.acos(Math.max(-1, Math.min(1, g.dot(u1, u2))));
    if (theta < 1e-6 || Math.abs(theta - Math.PI) < 1e-6) return null;
    const t = r / Math.tan(theta / 2);
    if (t > g.dist(prev, cur) / 2 + 1e-9 || t > g.dist(next, cur) / 2 + 1e-9) return null;
    const t1 = g.add(cur, g.scale(u1, t));
    const t2 = g.add(cur, g.scale(u2, t));
    const sweep = Math.PI - theta;
    const sign = g.cross(u1, u2) > 0 ? -1 : 1; // turning direction
    return { t1, t2, bulge: bulgeFromSweep(sign * sweep) };
  };
  if (!pl.closed) {
    pts.push(pl.points[0]!);
    bulges.push(0);
  }
  for (let k = 0; k < cornerCount; k += 1) {
    const i = pl.closed ? k : k + 1;
    const c = corner(i);
    if (!c) {
      pts.push(pl.points[i]!);
      bulges.push(0);
      continue;
    }
    pts.push(c.t1);
    bulges.push(c.bulge);
    pts.push(c.t2);
    bulges.push(0);
  }
  if (!pl.closed) {
    pts.push(pl.points[n - 1]!);
    bulges.push(0);
  }
  return { ...pl, points: pts, bulges };
}

function pickLine(ctx: ToolContext, prompt: string): Step<{ line: LineEntity; pick: Point } | { polyline: PolylineEntity } | { keyword: string } | null> {
  return (function* () {
    for (;;) {
      const r = yield* pointOrKeyword(prompt, ['Undo', 'Polyline', 'Radius', 'Trim', 'Multiple', 'Distance', 'Angle', 'mEthod']);
      if (!r) return null;
      if ('keyword' in r) return { keyword: r.keyword };
      if ('text' in r) {
        ctx.log(`Invalid option keyword: ${r.text}`);
        continue;
      }
      const e = pickAt(ctx, r.point);
      if (!e) continue;
      if (e.type === 'line') return { line: e, pick: r.point };
      if (e.type === 'polyline') return { polyline: e };
      ctx.log('Only lines and polylines can be filleted or chamfered.');
    }
  })();
}

export function filletTool(): Tool {
  return scriptTool('FILLET', function* (ctx) {
    let multiple = false;
    for (;;) {
      ctx.log(`Current settings: Mode = ${modifyDefaults.filletTrim ? 'TRIM' : 'NOTRIM'}, Radius = ${modifyDefaults.filletRadius.toFixed(4)}`);
      const first = yield* pickLine(ctx, 'Select first object or [Undo/Polyline/Radius/Trim/Multiple]:');
      if (!first) return;
      if ('keyword' in first) {
        if (first.keyword === 'RADIUS') {
          const r = yield* number(ctx, `Specify fillet radius ${dflt(modifyDefaults.filletRadius)}:`, modifyDefaults.filletRadius, { allowZero: true, from: null });
          if (r && 'value' in r) modifyDefaults.filletRadius = r.value;
        } else if (first.keyword === 'TRIM') {
          const t = yield* keyword(ctx, `Enter Trim mode option [Trim/No trim] <${modifyDefaults.filletTrim ? 'Trim' : 'No trim'}>:`, ['Trim', 'No trim'], modifyDefaults.filletTrim ? 'Trim' : 'No trim');
          modifyDefaults.filletTrim = t !== 'NO TRIM';
        } else if (first.keyword === 'MULTIPLE') multiple = true;
        else if (first.keyword === 'POLYLINE') {
          const r = yield* pointOrKeyword('Select 2D polyline or [Radius]:', ['Radius']);
          if (!r || !('point' in r)) continue;
          const pl = pickAt(ctx, r.point);
          if (!pl || pl.type !== 'polyline') {
            ctx.log('Object selected is not a polyline.');
            continue;
          }
          const out = filletPolyline(pl, modifyDefaults.filletRadius);
          if (!out) ctx.log('Polyline could not be filleted (arc segments or radius too large).');
          else {
            ctx.doc.replaceEntities([out]);
            ctx.log(`${Math.floor((out.points.length - pl.points.length) / 1)} lines were filleted`);
          }
          if (!multiple) return;
        } else if (first.keyword === 'UNDO') ctx.doc.undo();
        continue;
      }
      if ('polyline' in first) {
        ctx.log('Use the Polyline option to fillet a polyline.');
        continue;
      }
      ctx.selection = new Set([first.line.id]);
      const second = yield* pickLine(ctx, 'Select second object or shift-select to apply corner or [Radius]:');
      ctx.selection = new Set();
      if (!second) return;
      if (!('line' in second)) continue;
      if (second.line.id === first.line.id) continue;
      const res = filletLines(first.line, first.pick, second.line, second.pick, modifyDefaults.filletRadius, modifyDefaults.filletTrim);
      if (!res) {
        ctx.log('Lines are parallel or the radius is too large.');
        if (!multiple) return;
        continue;
      }
      ctx.doc.transact((s) => ({
        ...s,
        entities: [...s.entities.map((e) => (e.id === res.line1.id ? res.line1 : e.id === res.line2.id ? res.line2 : e)), ...(res.arc ? [res.arc] : [])],
      }));
      if (!multiple) return;
    }
  });
}

export function chamferTool(): Tool {
  return scriptTool('CHAMFER', function* (ctx) {
    let multiple = false;
    for (;;) {
      ctx.log(`(TRIM mode) Current chamfer Dist1 = ${modifyDefaults.chamferD1.toFixed(4)}, Dist2 = ${modifyDefaults.chamferD2.toFixed(4)}`);
      const first = yield* pickLine(ctx, 'Select first line or [Undo/Polyline/Distance/Angle/Trim/mEthod/Multiple]:');
      if (!first) return;
      if ('keyword' in first) {
        if (first.keyword === 'DISTANCE') {
          const d1 = yield* number(ctx, `Specify first chamfer distance ${dflt(modifyDefaults.chamferD1)}:`, modifyDefaults.chamferD1, { allowZero: true, from: null });
          if (!d1 || !('value' in d1)) continue;
          const d2 = yield* number(ctx, `Specify second chamfer distance ${dflt(d1.value)}:`, d1.value, { allowZero: true, from: null });
          modifyDefaults.chamferD1 = d1.value;
          modifyDefaults.chamferD2 = d2 && 'value' in d2 ? d2.value : d1.value;
        } else if (first.keyword === 'ANGLE') {
          const d1 = yield* number(ctx, `Specify chamfer length on the first line ${dflt(modifyDefaults.chamferD1)}:`, modifyDefaults.chamferD1, { from: null });
          if (!d1 || !('value' in d1)) continue;
          const a = yield* number(ctx, 'Specify chamfer angle from the first line <45>:', 45, { from: null });
          const ang = a && 'value' in a ? a.value : 45;
          modifyDefaults.chamferD1 = d1.value;
          modifyDefaults.chamferD2 = d1.value * Math.tan(g.rad(ang));
        } else if (first.keyword === 'MULTIPLE') multiple = true;
        else if (first.keyword === 'UNDO') ctx.doc.undo();
        else if (first.keyword === 'TRIM') {
          const t = yield* keyword(ctx, `Enter Trim mode option [Trim/No trim] <${modifyDefaults.filletTrim ? 'Trim' : 'No trim'}>:`, ['Trim', 'No trim'], 'Trim');
          modifyDefaults.filletTrim = t !== 'NO TRIM';
        } else ctx.log('Option not supported.');
        continue;
      }
      if ('polyline' in first) {
        ctx.log('Polyline chamfer is not supported; select two lines.');
        continue;
      }
      ctx.selection = new Set([first.line.id]);
      const second = yield* pickLine(ctx, 'Select second line or shift-select to apply corner or [Distance/Angle/Method]:');
      ctx.selection = new Set();
      if (!second) return;
      if (!('line' in second) || second.line.id === first.line.id) continue;
      const res = chamferLines(first.line, first.pick, second.line, second.pick, modifyDefaults.chamferD1, modifyDefaults.chamferD2, modifyDefaults.filletTrim) as (FilletResult & { bevel?: LineEntity }) | null;
      if (!res) {
        ctx.log('Lines are parallel or the distances are too large.');
        if (!multiple) return;
        continue;
      }
      ctx.doc.transact((s) => ({
        ...s,
        entities: [...s.entities.map((e) => (e.id === res.line1.id ? res.line1 : e.id === res.line2.id ? res.line2 : e)), ...(res.bevel ? [res.bevel] : [])],
      }));
      if (!multiple) return;
    }
  });
}

// ------------------------------------------------------------------ ARRAY

export function rectangularArray(entities: readonly Entity[], rows: number, cols: number, rowOffset: number, colOffset: number, angle = 0): Entity[] {
  const out: Entity[] = [];
  const u = { x: Math.cos(angle), y: Math.sin(angle) };
  const v = { x: -Math.sin(angle), y: Math.cos(angle) };
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      if (r === 0 && c === 0) continue;
      const d = g.add(g.scale(u, c * colOffset), g.scale(v, r * rowOffset));
      for (const e of entities) out.push({ ...translateEntity(e, d), id: newId() });
    }
  }
  return out;
}

export function polarArray(entities: readonly Entity[], center: Point, items: number, fillAngle: number, rotateItems: boolean): Entity[] {
  const out: Entity[] = [];
  if (items < 2) return out;
  const full = Math.abs(Math.abs(fillAngle) - 2 * Math.PI) < 1e-9;
  const step = full ? fillAngle / items : fillAngle / (items - 1);
  for (let i = 1; i < items; i += 1) {
    const a = step * i;
    for (const e of entities) {
      if (rotateItems) out.push({ ...rotateEntity(e, center, a), id: newId() });
      else {
        // Move along the arc but keep orientation: rotate the entity's reference point only.
        const b = entityBounds(e, () => undefined);
        const ref = b ? g.mid(b.min, b.max) : center;
        const moved = g.rotate(ref, a, center);
        out.push({ ...translateEntity(e, g.sub(moved, ref)), id: newId() });
      }
    }
  }
  return out;
}

export function arrayRectTool(): Tool {
  return scriptTool('ARRAYRECT', function* (ctx) {
    const ids = yield* select(ctx);
    if (ids.length === 0) return;
    const set = new Set(ids);
    const ents = ctx.doc.entities.filter((e) => set.has(e.id));
    const rows = yield* number(ctx, `Enter the number of rows (---) ${dflt(String(modifyDefaults.arrayRows))}:`, modifyDefaults.arrayRows, { integer: true, min: 1, from: null });
    if (!rows || !('value' in rows)) return;
    const cols = yield* number(ctx, `Enter the number of columns (|||) ${dflt(String(modifyDefaults.arrayCols))}:`, modifyDefaults.arrayCols, { integer: true, min: 1, from: null });
    if (!cols || !('value' in cols)) return;
    if (rows.value * cols.value <= 1) {
      ctx.log('One-element array requested; nothing to do.');
      return;
    }
    let rowOff = modifyDefaults.arrayRowOffset;
    let colOff = modifyDefaults.arrayColOffset;
    if (rows.value > 1) {
      const r = yield* number(ctx, `Enter the distance between rows or specify unit cell (---) ${dflt(rowOff)}:`, rowOff, { allowNegative: true, from: null });
      if (!r || !('value' in r)) return;
      rowOff = r.value;
    }
    if (cols.value > 1) {
      const c = yield* number(ctx, `Specify the distance between columns (|||) ${dflt(colOff)}:`, colOff, { allowNegative: true, from: null });
      if (!c || !('value' in c)) return;
      colOff = c.value;
    }
    modifyDefaults.arrayRows = rows.value;
    modifyDefaults.arrayCols = cols.value;
    modifyDefaults.arrayRowOffset = rowOff;
    modifyDefaults.arrayColOffset = colOff;
    const copies = rectangularArray(ents, rows.value, cols.value, rowOff, colOff);
    ctx.doc.addEntities(copies, false);
    ctx.selection = new Set([...ids, ...copies.map((e) => e.id)]);
    ctx.log(`${copies.length} object(s) arrayed.`);
  });
}

export function arrayPolarTool(): Tool {
  return scriptTool('ARRAYPOLAR', function* (ctx) {
    const ids = yield* select(ctx);
    if (ids.length === 0) return;
    const set = new Set(ids);
    const ents = ctx.doc.entities.filter((e) => set.has(e.id));
    const c = yield* point(ctx, 'Specify center point of array:');
    if (!c) return;
    const n = yield* number(ctx, `Enter the number of items in the array ${dflt(String(modifyDefaults.polarItems))}:`, modifyDefaults.polarItems, { integer: true, min: 2, from: null });
    if (!n || !('value' in n)) return;
    const fill = yield* number(ctx, `Specify the angle to fill (+=ccw, -=cw) ${dflt(String(modifyDefaults.polarAngle))}:`, modifyDefaults.polarAngle, { allowNegative: true, from: null, preview: () => polarArray(ents, c, n.value, g.rad(modifyDefaults.polarAngle), true) });
    if (!fill || !('value' in fill)) return;
    const rot = yield* keyword(ctx, 'Rotate arrayed objects? [Yes/No] <Y>:', ['Yes', 'No'], 'Yes');
    modifyDefaults.polarItems = n.value;
    modifyDefaults.polarAngle = fill.value;
    const copies = polarArray(ents, c, n.value, g.rad(fill.value), rot !== 'NO');
    ctx.doc.addEntities(copies, false);
    ctx.selection = new Set([...ids, ...copies.map((e) => e.id)]);
    ctx.log(`${copies.length} object(s) arrayed.`);
  });
}

/** Classic ARRAY prompt: choose rectangular or polar. */
export function arrayTool(): Tool {
  return scriptTool('ARRAY', function* (ctx) {
    const ids = yield* select(ctx);
    if (ids.length === 0) return;
    ctx.selection = new Set(ids);
    const t = yield* keyword(ctx, 'Enter the type of array [Rectangular/Polar] <R>:', ['Rectangular', 'Polar'], 'R');
    ctx.runCommand(t === 'POLAR' ? 'ARRAYPOLAR' : 'ARRAYRECT');
  });
}

// ------------------------------------------------------------------ STRETCH

/** Move the vertices of an entity that lie inside `box` by `d`; entities entirely inside move whole. */
export function stretchEntity(e: Entity, box: Bounds, d: Point): Entity {
  const inside = (p: Point) => g.pointInBounds(p, box);
  const mv = (p: Point) => (inside(p) ? g.add(p, d) : p);
  switch (e.type) {
    case 'line':
      return { ...e, a: mv(e.a), b: mv(e.b) };
    case 'polyline':
      return { ...e, points: e.points.map(mv) };
    case 'circle':
    case 'arc':
      return inside(e.center) ? translateEntity(e, d) : e;
    case 'ellipse':
      return inside(e.center) ? translateEntity(e, d) : e;
    case 'xline':
    case 'ray':
      return inside(e.base) ? translateEntity(e, d) : e;
    case 'text':
    case 'mtext':
    case 'insert':
    case 'point':
      return inside(e.position) ? translateEntity(e, d) : e;
    case 'dimension':
      return {
        ...e,
        p1: mv(e.p1),
        p2: mv(e.p2),
        linePoint: mv(e.linePoint),
        center: e.center ? mv(e.center) : e.center,
        textPosition: e.textPosition ? mv(e.textPosition) : e.textPosition,
      };
  }
}

export function stretchTool(): Tool {
  return scriptTool('STRETCH', function* (ctx) {
    ctx.log('Select objects to stretch by crossing-window or crossing-polygon...');
    const a = yield* point(ctx, 'Specify first corner of crossing window:');
    if (!a) return;
    const b = yield* point(ctx, 'Specify opposite corner:', {
      trackFrom: a,
      preview: (c) => [{ id: 'stretch-box', layer: '0', color: 3, type: 'polyline', closed: true, points: [a, { x: c.x, y: a.y }, c, { x: a.x, y: c.y }] }],
    });
    if (!b) return;
    const box = g.boundsOfPoints([a, b])!;
    const hidden = new Set(ctx.doc.layers.filter((l) => !l.visible).map((l) => l.name));
    const locked = new Set(ctx.doc.layers.filter((l) => l.locked).map((l) => l.name));
    const found = selectByBox(box, 'crossing', ctx.doc.entities, ctx.doc.lookupBlock, hidden, locked);
    if (found.length === 0) {
      ctx.log('0 found');
      return;
    }
    ctx.log(`${found.length} found`);
    ctx.selection = new Set(found.map((e) => e.id));
    const bp = yield* pointOrKeyword('Specify base point or [Displacement] <Displacement>:', ['Displacement'], { trackFrom: null });
    if (!bp) return;
    let delta: Point | null = null;
    if ('point' in bp) {
      const base = bp.point;
      const second = yield* point(ctx, 'Specify second point or <use first point as displacement>:', {
        trackFrom: base,
        ghost: (c) => found.map((e) => stretchEntity(e, box, g.sub(c, base))),
        dyn: (c) => [g.dist(base, c).toFixed(4)],
      });
      delta = second ? g.sub(second, base) : base;
    } else if ('keyword' in bp) {
      const d = yield* point(ctx, 'Specify displacement <0.0000, 0.0000>:');
      delta = d ?? { x: 0, y: 0 };
    } else return;
    if (g.len(delta) < 1e-12) return;
    ctx.doc.replaceEntities(found.map((e) => stretchEntity(e, box, delta!)));
    ctx.selection = new Set();
  });
}

// ------------------------------------------------------------------ BREAK

/** Break a line/arc/circle/straight polyline between two points on it. Same point twice splits it. */
export function breakEntity(e: Entity, p1: Point, p2: Point): Entity[] | null {
  const split = g.eq(p1, p2, 1e-9);
  const baseProps = (x: Entity) => ({ ...x, id: newId() });
  switch (e.type) {
    case 'line': {
      const dir = g.sub(e.b, e.a);
      const L2 = g.dot(dir, dir);
      if (L2 < 1e-18) return null;
      let t1 = g.dot(g.sub(p1, e.a), dir) / L2;
      let t2 = g.dot(g.sub(p2, e.a), dir) / L2;
      if (t1 > t2) [t1, t2] = [t2, t1];
      t1 = Math.max(0, Math.min(1, t1));
      t2 = Math.max(0, Math.min(1, t2));
      const at = (t: number) => g.add(e.a, g.scale(dir, t));
      const out: Entity[] = [];
      if (t1 > 1e-9) out.push(baseProps({ ...e, b: at(t1) }));
      if (t2 < 1 - 1e-9) out.push(baseProps({ ...e, a: at(t2) }));
      return out;
    }
    case 'circle': {
      const a1 = g.angleOf(e.center, p1);
      const a2 = g.angleOf(e.center, p2);
      if (split) return null; // a circle cannot be broken at a single point
      // AutoCAD removes the CCW portion from the first to the second point.
      return [{ id: newId(), layer: e.layer, color: e.color, linetype: e.linetype, lineWeight: e.lineWeight, type: 'arc', center: e.center, radius: e.radius, startAngle: a2, endAngle: a1 }];
    }
    case 'arc': {
      const rel = (p: Point) => g.normAngle(g.angleOf(e.center, p) - e.startAngle);
      const sweep = g.normAngle(e.endAngle - e.startAngle) || 2 * Math.PI;
      let r1 = Math.min(rel(p1), sweep);
      let r2 = Math.min(rel(p2), sweep);
      if (r1 > r2) [r1, r2] = [r2, r1];
      const out: Entity[] = [];
      if (r1 > 1e-9) out.push(baseProps({ ...e, endAngle: e.startAngle + r1 }));
      if (r2 < sweep - 1e-9) out.push(baseProps({ ...e, startAngle: e.startAngle + r2 }));
      return out;
    }
    case 'polyline': {
      if (e.bulges?.some((b) => Math.abs(b) > 1e-12)) return null;
      // Parameterise by segment index + fraction.
      const segs = polylineSegments(e);
      const locate = (p: Point) => {
        let best = { i: 0, t: 0, d: Infinity };
        segs.forEach((s, i) => {
          const q = g.closestOnSegment(p, s.a, s.b);
          const d = g.dist(p, q);
          if (d < best.d) best = { i, t: g.dist(s.a, q) / Math.max(1e-12, g.dist(s.a, s.b)), d };
        });
        return best;
      };
      let l1 = locate(p1);
      let l2 = locate(p2);
      if (l1.i + l1.t > l2.i + l2.t) [l1, l2] = [l2, l1];
      const at = (l: { i: number; t: number }) => g.add(segs[l.i]!.a, g.scale(g.sub(segs[l.i]!.b, segs[l.i]!.a), l.t));
      if (e.closed) {
        // Opening a closed polyline: one open polyline from the second point around to the first.
        const pts: Point[] = [at(l2)];
        for (let k = l2.i + 1; k <= l1.i + segs.length; k += 1) {
          const idx = k % segs.length;
          if (idx === l1.i && k > l2.i) break;
          pts.push(segs[idx]!.a);
        }
        pts.push(at(l1));
        return [baseProps({ ...e, closed: false, points: pts, bulges: undefined })];
      }
      const first: Point[] = [];
      for (let k = 0; k <= l1.i; k += 1) first.push(segs[k]!.a);
      first.push(at(l1));
      const second: Point[] = [at(l2)];
      for (let k = l2.i + 1; k < segs.length; k += 1) second.push(segs[k]!.a);
      second.push(segs[segs.length - 1]!.b);
      const out: Entity[] = [];
      const clean = (pts: Point[]) => pts.filter((p, i) => i === 0 || !g.eq(p, pts[i - 1]!, 1e-9));
      const f = clean(first);
      const s = clean(second);
      if (f.length >= 2) out.push(baseProps({ ...e, points: f, bulges: undefined }));
      if (s.length >= 2) out.push(baseProps({ ...e, points: s, bulges: undefined }));
      return out;
    }
    default:
      return null;
  }
}

export function breakTool(): Tool {
  return scriptTool('BREAK', function* (ctx) {
    let target: Entity | null = null;
    let first: Point | null = null;
    while (!target) {
      const p = yield* point(ctx, 'Select object:');
      if (!p) return;
      target = pickAt(ctx, p);
      first = p;
    }
    ctx.selection = new Set([target.id]);
    const r = yield* pointOrKeyword('Specify second break point or [First point]:', ['First point'], { trackFrom: null });
    if (!r) return;
    let p1 = first!;
    let p2: Point;
    if ('keyword' in r) {
      const f = yield* point(ctx, 'Specify first break point:');
      if (!f) return;
      p1 = f;
      const s = yield* point(ctx, 'Specify second break point:', { trackFrom: null });
      if (!s) return;
      p2 = s;
    } else if ('point' in r) p2 = r.point;
    else if (r.text.trim() === '@') p2 = p1;
    else return;
    const pieces = breakEntity(target, p1, p2);
    if (!pieces) {
      ctx.log('Cannot break this object.');
      return;
    }
    ctx.doc.replaceWith([target.id], pieces);
    ctx.selection = new Set();
  });
}

// ------------------------------------------------------------------ JOIN

function collinear(a: LineEntity, b: LineEntity): boolean {
  const d = g.normalize(g.sub(a.b, a.a));
  return Math.abs(g.cross(d, g.sub(b.a, a.a))) < 1e-7 && Math.abs(g.cross(d, g.sub(b.b, a.a))) < 1e-7;
}

/** Join lines/arcs/polylines: collinear lines merge, concentric arcs merge, chains become one polyline. */
export function joinEntities(list: readonly Entity[]): Entity[] | null {
  if (list.length < 2) return null;
  const lines = list.filter((e): e is LineEntity => e.type === 'line');
  if (lines.length === list.length && lines.every((l) => collinear(lines[0]!, l))) {
    const d = g.normalize(g.sub(lines[0]!.b, lines[0]!.a));
    let lo = Infinity;
    let hi = -Infinity;
    for (const l of lines) for (const p of [l.a, l.b]) {
      const t = g.dot(g.sub(p, lines[0]!.a), d);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    return [{ ...lines[0]!, a: g.add(lines[0]!.a, g.scale(d, lo)), b: g.add(lines[0]!.a, g.scale(d, hi)) }];
  }
  const arcs = list.filter((e): e is ArcEntity => e.type === 'arc');
  if (arcs.length === list.length && arcs.every((a) => g.eq(a.center, arcs[0]!.center, 1e-7) && Math.abs(a.radius - arcs[0]!.radius) < 1e-7)) {
    // Merge sweeps: start at the first arc and extend while the next arc touches.
    let start = arcs[0]!.startAngle;
    let end = arcs[0]!.endAngle;
    const rest = arcs.slice(1);
    let progress = true;
    while (rest.length && progress) {
      progress = false;
      for (let i = 0; i < rest.length; i += 1) {
        const a = rest[i]!;
        if (Math.abs(g.normAngle(a.startAngle - end)) < 1e-6 || g.angleInSweep(a.startAngle, start, end)) {
          if (!g.angleInSweep(a.endAngle, start, end)) end = a.endAngle;
          rest.splice(i, 1);
          progress = true;
          break;
        }
        if (Math.abs(g.normAngle(start - a.endAngle)) < 1e-6 || g.angleInSweep(a.endAngle, start, end)) {
          if (!g.angleInSweep(a.startAngle, start, end)) start = a.startAngle;
          rest.splice(i, 1);
          progress = true;
          break;
        }
      }
    }
    if (rest.length) return null;
    return [{ ...arcs[0]!, startAngle: start, endAngle: end }];
  }
  // Chain of lines / arcs / straight polylines sharing endpoints -> one polyline with bulges.
  interface Piece {
    pts: Point[];
    bulges: number[];
  }
  const pieces: Piece[] = [];
  for (const e of list) {
    if (e.type === 'line') pieces.push({ pts: [e.a, e.b], bulges: [0, 0] });
    else if (e.type === 'arc') {
      const [s, en] = arcEndpoints(e);
      pieces.push({ pts: [s, en], bulges: [bulgeFromSweep(g.normAngle(e.endAngle - e.startAngle)), 0] });
    } else if (e.type === 'polyline' && !e.closed) pieces.push({ pts: [...e.points], bulges: e.points.map((_, i) => e.bulges?.[i] ?? 0) });
    else return null;
  }
  const reverse = (p: Piece): Piece => {
    const pts = [...p.pts].reverse();
    const bulges = p.bulges.slice(0, -1).map((b) => -b).reverse();
    bulges.push(0);
    return { pts, bulges };
  };
  const chain = pieces.shift()!;
  const tol = 1e-6;
  let progress = true;
  while (pieces.length && progress) {
    progress = false;
    for (let i = 0; i < pieces.length; i += 1) {
      let p = pieces[i]!;
      const head = chain.pts[0]!;
      const tail = chain.pts[chain.pts.length - 1]!;
      if (g.eq(p.pts[p.pts.length - 1]!, tail, tol)) p = reverse(p);
      if (g.eq(p.pts[0]!, tail, tol)) {
        chain.bulges[chain.bulges.length - 1] = p.bulges[0]!;
        chain.pts.push(...p.pts.slice(1));
        chain.bulges.push(...p.bulges.slice(1));
        pieces.splice(i, 1);
        progress = true;
        break;
      }
      if (g.eq(p.pts[0]!, head, tol)) p = reverse(p);
      if (g.eq(p.pts[p.pts.length - 1]!, head, tol)) {
        const b = p.bulges.slice(0, -1);
        chain.pts.unshift(...p.pts.slice(0, -1));
        chain.bulges.unshift(...b);
        pieces.splice(i, 1);
        progress = true;
        break;
      }
    }
  }
  if (pieces.length) return null;
  const first = list[0]!;
  const closed = g.eq(chain.pts[0]!, chain.pts[chain.pts.length - 1]!, tol) && chain.pts.length > 3;
  const pts = closed ? chain.pts.slice(0, -1) : chain.pts;
  const bulges = closed ? chain.bulges.slice(0, -1) : chain.bulges;
  const hasBulge = bulges.some((b) => Math.abs(b) > 1e-12);
  return [{ id: newId(), layer: first.layer, color: first.color, linetype: first.linetype, lineWeight: first.lineWeight, type: 'polyline', points: pts, closed, bulges: hasBulge ? bulges : undefined }];
}

export function joinTool(): Tool {
  return scriptTool('JOIN', function* (ctx) {
    const ids = yield* select(ctx, 'Select source object or multiple objects to join at once:');
    if (ids.length < 2) {
      ctx.log('Select at least two objects to join.');
      return;
    }
    const set = new Set(ids);
    const list = ctx.doc.entities.filter((e) => set.has(e.id));
    const out = joinEntities(list);
    if (!out) {
      ctx.log('0 objects converted; the objects do not form a chain.');
      return;
    }
    ctx.doc.replaceWith(ids, out);
    ctx.selection = new Set(out.map((e) => e.id));
    ctx.log(`${list.length} objects converted to 1 ${out[0]!.type === 'polyline' ? 'polyline' : out[0]!.type}`);
  });
}

// ------------------------------------------------------------------ LENGTHEN

export function entityLength(e: Entity): number | null {
  switch (e.type) {
    case 'line':
      return g.dist(e.a, e.b);
    case 'arc':
      return (g.normAngle(e.endAngle - e.startAngle) || 2 * Math.PI) * e.radius;
    case 'polyline':
      return polylineLength(e);
    case 'circle':
      return 2 * Math.PI * e.radius;
    default:
      return null;
  }
}

/** Lengthen the end of a line/arc nearest to `pick` by `delta` (negative shortens). */
export function lengthenEntity(e: Entity, pick: Point, delta: number): Entity | null {
  if (e.type === 'line') {
    const L = g.dist(e.a, e.b);
    if (L < 1e-12 || L + delta <= 1e-9) return null;
    const d = g.normalize(g.sub(e.b, e.a));
    return g.dist(pick, e.b) <= g.dist(pick, e.a) ? { ...e, b: g.add(e.b, g.scale(d, delta)) } : { ...e, a: g.sub(e.a, g.scale(d, delta)) };
  }
  if (e.type === 'arc') {
    const dA = delta / e.radius;
    const [s, en] = arcEndpoints(e);
    const sweep = g.normAngle(e.endAngle - e.startAngle);
    if (sweep + dA <= 1e-9 || sweep + dA >= 2 * Math.PI) return null;
    return g.dist(pick, en) <= g.dist(pick, s) ? { ...e, endAngle: e.endAngle + dA } : { ...e, startAngle: e.startAngle - dA };
  }
  return null;
}

export function lengthenTool(): Tool {
  return scriptTool('LENGTHEN', function* (ctx) {
    let mode: 'delta' | 'percent' | 'total' | null = null;
    let value = modifyDefaults.lengthenDelta;
    for (;;) {
      if (!mode) {
        const r = yield* pointOrKeyword('Select an object to measure or [DElta/Percent/Total/DYnamic]:', ['DElta', 'Percent', 'Total', 'DYnamic']);
        if (!r) return;
        if ('point' in r) {
          const e = pickAt(ctx, r.point);
          const L = e ? entityLength(e) : null;
          if (L === null) ctx.log('Cannot measure the length of this object.');
          else ctx.log(`Current length: ${L.toFixed(4)}${e?.type === 'arc' ? `, included angle: ${g.deg(g.normAngle(e.endAngle - e.startAngle)).toFixed(2)}` : ''}`);
          continue;
        }
        if ('text' in r) continue;
        if (r.keyword === 'DYNAMIC') {
          ctx.log('Dynamic lengthening is not supported; use DElta, Percent or Total.');
          continue;
        }
        if (r.keyword === 'DELTA') {
          const v = yield* number(ctx, `Enter delta length or [Angle] ${dflt(value)}:`, value, { allowNegative: true, allowZero: true, from: null });
          if (!v || !('value' in v)) continue;
          value = v.value;
          mode = 'delta';
        } else if (r.keyword === 'PERCENT') {
          const v = yield* number(ctx, 'Enter percentage length <100.0000>:', 100, { from: null });
          if (!v || !('value' in v)) continue;
          value = v.value;
          mode = 'percent';
        } else {
          const v = yield* number(ctx, 'Specify total length or [Angle] <1.0000>:', 1, { from: null });
          if (!v || !('value' in v)) continue;
          value = v.value;
          mode = 'total';
        }
        modifyDefaults.lengthenDelta = value;
      }
      const r = yield* pointOrKeyword('Select an object to change or [Undo]:', ['Undo']);
      if (!r) return;
      if ('keyword' in r) {
        ctx.doc.undo();
        continue;
      }
      if ('text' in r) continue;
      const e = pickAt(ctx, r.point);
      if (!e) continue;
      const L = entityLength(e);
      if (L === null || (e.type !== 'line' && e.type !== 'arc')) {
        ctx.log('Only lines and arcs can be lengthened.');
        continue;
      }
      const delta = mode === 'delta' ? value : mode === 'percent' ? L * (value / 100 - 1) : value - L;
      const out = lengthenEntity(e, r.point, delta);
      if (!out) ctx.log('Resulting length would be zero or negative.');
      else ctx.doc.replaceEntities([out]);
    }
  });
}

// ------------------------------------------------------------------ ALIGN

export function alignTransform(s1: Point, d1: Point, s2: Point | null, d2: Point | null, scaleToo: boolean): (e: Entity) => Entity {
  if (!s2 || !d2) return (e) => translateEntity(e, g.sub(d1, s1));
  const angle = g.angleOf(d1, d2) - g.angleOf(s1, s2);
  const k = scaleToo && g.dist(s1, s2) > 1e-12 ? g.dist(d1, d2) / g.dist(s1, s2) : 1;
  return (e) => {
    let out = translateEntity(e, g.sub(d1, s1));
    out = rotateEntity(out, d1, angle);
    if (k !== 1) out = scaleEntityBy(out, d1, k);
    return out;
  };
}

export function alignTool(): Tool {
  return scriptTool('ALIGN', function* (ctx) {
    const ids = yield* select(ctx);
    if (ids.length === 0) return;
    const set = new Set(ids);
    const ents = ctx.doc.entities.filter((e) => set.has(e.id));
    const s1 = yield* point(ctx, 'Specify first source point:');
    if (!s1) return;
    const d1 = yield* point(ctx, 'Specify first destination point:', { trackFrom: s1, preview: (c) => [{ id: 'al1', layer: '0', color: 8, type: 'line', a: s1, b: c }] });
    if (!d1) return;
    const s2 = yield* point(ctx, 'Specify second source point or <continue>:', { trackFrom: null, ghost: () => ents.map(alignTransform(s1, d1, null, null, false)) });
    if (!s2) {
      ctx.doc.replaceEntities(ents.map(alignTransform(s1, d1, null, null, false)));
      return;
    }
    const d2 = yield* point(ctx, 'Specify second destination point:', { trackFrom: s2, ghost: (c) => ents.map(alignTransform(s1, d1, s2, c, false)) });
    if (!d2) return;
    yield* point(ctx, 'Specify third source point or <continue>:', { trackFrom: null, ghost: () => ents.map(alignTransform(s1, d1, s2, d2, false)) });
    const sc = yield* keyword(ctx, 'Scale objects based on alignment points? [Yes/No] <N>:', ['Yes', 'No'], 'No');
    ctx.doc.replaceEntities(ents.map(alignTransform(s1, d1, s2, d2, sc === 'YES')));
  });
}

// ------------------------------------------------------------------ MATCHPROP

export function matchProperties(source: Entity, target: Entity): Entity {
  let out: Entity = { ...target, layer: source.layer, color: source.color, linetype: source.linetype, lineWeight: source.lineWeight, ltscale: source.ltscale };
  if (source.type === 'text' && out.type === 'text') out = { ...out, height: source.height };
  if (source.type === 'mtext' && out.type === 'mtext') out = { ...out, height: source.height, lineSpacing: source.lineSpacing };
  if (source.type === 'text' && out.type === 'mtext') out = { ...out, height: source.height };
  if (source.type === 'mtext' && out.type === 'text') out = { ...out, height: source.height };
  if (source.type === 'dimension' && out.type === 'dimension') out = { ...out, style: source.style };
  if (source.type === 'polyline' && out.type === 'polyline') out = { ...out, width: source.width };
  return out;
}

export function matchPropTool(): Tool {
  return scriptTool('MATCHPROP', function* (ctx) {
    let source: Entity | null = null;
    while (!source) {
      const p = yield* point(ctx, 'Select source object:');
      if (!p) return;
      source = pickAt(ctx, p);
    }
    ctx.selection = new Set();
    ctx.log(`Current active settings: Color Layer Ltype Ltscale Lineweight Text Dim Polyline`);
    const ids = yield* select(ctx, 'Select destination object(s) or [Settings]:', false);
    const src = source;
    const set = new Set(ids.filter((id) => id !== src.id));
    if (set.size === 0) return;
    ctx.doc.replaceEntities(ctx.doc.entities.filter((e) => set.has(e.id)).map((e) => matchProperties(src, e)));
    ctx.selection = new Set();
  });
}

