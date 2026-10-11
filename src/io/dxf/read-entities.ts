/**
 * Entity codecs, reader side: one JCad entity per DXF entity record. Geometry types are read here
 * (LINE, CIRCLE, ARC, LWPOLYLINE, SOLID / TRACE, TEXT and MTEXT with their fields, ELLIPSE, POINT,
 * XLINE, RAY, SPLINE, HATCH, INSERT); DIMENSION, LEADER, MULTILEADER, IMAGE and tables come from
 * read-annotations.ts.
 */
import type { Entity, SplineEntity, HatchEntity, HatchLoop, WorldPatternLine, FieldLink } from '../../core/entities';
import { mtextFromDxf, hasFormatting, type MTextAttachment, type MTextColumns } from '../../core/mtext';
import { findPattern, LoopBuilder, edgeArc, fitPatternToLines } from '../../core/hatch';
import { isValidNurbs, nurbsPoints, interpolateFitPoints } from '../../core/spline';
import { evaluateFields, hasFields } from '../../core/fields';
import * as g from '../../core/geometry';
import { num, has, str, pt, int, flt, afterSubclass, pointList, Cursor, xdata, type Obj } from './groups';
import { MTEXT_COLUMNS_APP } from './codes';
import { commonProps, reportObj, type ReadContext } from './read-core';
import { readDimStyleFromEntity, readDimension, readLeader, readMLeader, readImage, readTable, readJcadTable } from './read-annotations';

function readSpline(o: Obj, base: ReturnType<typeof commonProps>): SplineEntity | null {
  const gs = afterSubclass(o, 'AcDbSpline');
  const flags = Math.trunc(num(o, 70));
  const degree = Math.max(1, Math.trunc(num(o, 71, 3)));
  const knots = gs.filter((x) => x.code === 40).map((x) => parseFloat(x.value));
  const weights = gs.filter((x) => x.code === 41).map((x) => parseFloat(x.value));
  const controlPoints = pointList(gs, 10);
  const fitPoints = pointList(gs, 11);
  if (controlPoints.length < 2 && fitPoints.length < 2) return null;
  const tangent = (code: number): g.Point | undefined => (gs.some((x) => x.code === code) ? { x: flt(gs.find((x) => x.code === code)?.value), y: flt(gs.find((x) => x.code === code + 10)?.value) } : undefined);
  const st = tangent(12);
  const et = tangent(13);
  return {
    ...base,
    type: 'spline',
    degree,
    knots,
    controlPoints,
    ...(weights.length === controlPoints.length && weights.some((w) => Math.abs(w - 1) > 1e-12) ? { weights } : {}),
    ...(fitPoints.length ? { fitPoints } : {}),
    closed: (flags & 1) === 1,
    ...((flags & 2) === 2 ? { periodic: true } : {}),
    ...(st ? { startTangent: st } : {}),
    ...(et ? { endTangent: et } : {}),
  };
}

function readHatchLoop(c: Cursor): HatchLoop | null {
  const flags = int(c.seek(92, 4));
  const b = new LoopBuilder();
  if (flags & 2) {
    const hasBulge = int(c.take(72)) !== 0;
    c.take(73);
    const n = int(c.seek(93, 3));
    const pts: g.Point[] = [];
    const bulges: number[] = [];
    for (let k = 0; k < n && c.code !== undefined; k += 1) {
      pts.push(c.point(10));
      bulges.push(hasBulge && c.code === 42 ? flt(c.take(42)) : 0);
    }
    const nsrc = int(c.take(97));
    for (let k = 0; k < nsrc; k += 1) c.take(330);
    if (pts.length < 2) return null;
    return { points: pts, ...(bulges.some((v) => Math.abs(v) > 1e-12) ? { bulges } : {}) };
  }
  const nEdges = int(c.seek(93, 3));
  for (let k = 0; k < nEdges && c.code !== undefined; k += 1) {
    const type = int(c.seek(72, 3));
    if (type === 1) {
      const a = c.point(10);
      const e = c.point(11);
      b.segment(a, e, 0);
    } else if (type === 2) {
      const center = c.point(10);
      const r = flt(c.take(40));
      const s = flt(c.take(50));
      const e = flt(c.take(51));
      const ccw = c.code === 73 ? int(c.take(73), 1) !== 0 : true;
      const { a0, sweep } = edgeArc(s, e, ccw);
      b.arc(center, r, a0, sweep);
    } else if (type === 3) {
      const center = c.point(10);
      const major = c.point(11);
      const ratio = flt(c.take(40), 1);
      const s = flt(c.take(50));
      const e = flt(c.take(51), 360);
      const ccw = c.code === 73 ? int(c.take(73), 1) !== 0 : true;
      const { a0, sweep } = edgeArc(s, e, ccw);
      const minor = { x: -major.y * ratio, y: major.x * ratio };
      const steps = Math.max(8, Math.ceil((Math.abs(sweep) / (2 * Math.PI)) * 64));
      const pts: g.Point[] = [];
      for (let i = 0; i <= steps; i += 1) {
        const t = a0 + (sweep * i) / steps;
        pts.push({ x: center.x + major.x * Math.cos(t) + minor.x * Math.sin(t), y: center.y + major.y * Math.cos(t) + minor.y * Math.sin(t) });
      }
      b.polyline(pts);
    } else if (type === 4) {
      const degree = int(c.take(94), 3);
      const rational = int(c.take(73)) !== 0;
      c.take(74);
      const nk = int(c.take(95));
      const nc = int(c.take(96));
      const knots: number[] = [];
      for (let i = 0; i < nk; i += 1) knots.push(flt(c.seek(40, 2)));
      const cps: g.Point[] = [];
      const weights: number[] = [];
      for (let i = 0; i < nc; i += 1) {
        cps.push(c.point(10));
        if (rational && c.code === 42) weights.push(flt(c.take(42), 1));
      }
      const nf = c.code === 97 ? int(c.take(97)) : 0;
      const fit: g.Point[] = [];
      for (let i = 0; i < nf; i += 1) fit.push(c.point(11));
      if (c.code === 12) c.point(12);
      if (c.code === 13) c.point(13);
      const curve = { degree, knots, controlPoints: cps, ...(weights.length === cps.length ? { weights } : {}) };
      const pts = isValidNurbs(curve) ? nurbsPoints(curve, 8) : fit.length >= 2 ? nurbsPoints(interpolateFitPoints(fit) ?? curve, 8) : cps;
      b.polyline(pts);
    } else break;
  }
  const nsrc = int(c.seek(97, 2));
  for (let k = 0; k < nsrc; k += 1) c.take(330);
  return b.loop();
}

function readHatch(o: Obj, base: ReturnType<typeof commonProps>): HatchEntity | null {
  const c = new Cursor(afterSubclass(o, 'AcDbHatch'));
  let pattern = 'SOLID';
  let solid = false;
  let associative = false;
  let style = 0;
  let patternType = 1;
  let angle = 0;
  let scale = 1;
  let dbl = false;
  const loops: HatchLoop[] = [];
  const lines: WorldPatternLine[] = [];
  while (c.code !== undefined) {
    const code = c.code;
    const value = c.gs[c.i]!.value;
    if (code === 91 && loops.length === 0) {
      c.i += 1;
      const n = int(value);
      for (let k = 0; k < n && c.code !== undefined; k += 1) {
        const l = readHatchLoop(c);
        if (l) loops.push(l);
      }
      continue;
    }
    if (code === 78) {
      c.i += 1;
      const n = int(value);
      for (let k = 0; k < n && c.code !== undefined; k += 1) {
        const a = flt(c.seek(53, 3));
        const bx = flt(c.take(43));
        const by = flt(c.take(44));
        const ox = flt(c.take(45));
        const oy = flt(c.take(46));
        const nd = int(c.take(79));
        const dashes: number[] = [];
        for (let d = 0; d < nd; d += 1) dashes.push(flt(c.take(49)));
        lines.push({ angle: g.rad(a), base: { x: bx, y: by }, offset: { x: ox, y: oy }, dashes });
      }
      continue;
    }
    c.i += 1;
    switch (code) {
      case 2:
        pattern = value.trim() || pattern;
        break;
      case 70:
        solid = int(value) === 1;
        break;
      case 71:
        associative = int(value) === 1;
        break;
      case 75:
        style = int(value);
        break;
      case 76:
        patternType = int(value);
        break;
      case 52:
        angle = g.rad(flt(value));
        break;
      case 41:
        scale = flt(value, 1) || 1;
        break;
      case 77:
        dbl = int(value) === 1;
        break;
      default:
        break;
    }
  }
  if (loops.length === 0) return null;
  const isSolid = solid || /^SOLID$/i.test(pattern);
  // The definition lines in the file are authoritative (ISO scale, double hatches, custom patterns).
  const fit = isSolid ? { angle, scale } : fitPatternToLines(findPattern(pattern), angle, scale, lines, dbl);
  return {
    ...base,
    type: 'hatch',
    pattern: isSolid ? 'SOLID' : pattern,
    solid: isSolid,
    angle: fit.angle,
    scale: fit.scale,
    ...(fit.origin ? { origin: fit.origin } : {}),
    loops,
    ...(fit.patternLines ? { patternLines: fit.patternLines } : {}),
    ...(associative ? { associative } : {}),
    ...(style ? { style } : {}),
    patternType,
    ...(dbl ? { double: true } : {}),
  };
}

/**
 * MTEXT columns: JCad's own JCAD_MTEXT_COLUMNS XDATA, else AutoCAD's (the R2018 "Embedded
 * Object" groups 71-74 / 44-46, or the native groups 75-79 / 48-50). Ported from PR #2
 * (codex/electrical-review-fixes 2f89b0e).
 */
function readMTextColumns(o: Obj): MTextColumns | undefined {
  const own = xdata(o, MTEXT_COLUMNS_APP);
  if (own) {
    try {
      const c = JSON.parse(own.filter((p) => p.code === 1000).map((p) => p.value).join('')) as MTextColumns;
      if ((c.type === 1 || c.type === 2) && Number.isInteger(c.count) && c.count > 0 && c.count <= 256 && Number.isFinite(c.width) && c.width > 0 && Number.isFinite(c.gutter) && c.gutter >= 0 && Array.isArray(c.heights) && c.heights.length <= 256 && c.heights.every((h) => Number.isFinite(h) && h >= 0)) return c;
    } catch {
      /* the native groups below */
    }
  }
  const embedded = o.groups.findIndex((p) => p.code === 101 && p.value === 'Embedded Object');
  const nativeStart = o.groups.findIndex((p) => p.code === 75);
  const groups = embedded < 0 ? o.groups.slice(Math.max(0, nativeStart)) : o.groups.slice(embedded + 1);
  const code = (native: number, modern: number) => groups.find((p) => p.code === (embedded < 0 ? native : modern))?.value;
  const type = int(code(75, 71));
  const count = int(code(76, 72));
  const width = flt(code(48, 44));
  if ((type !== 1 && type !== 2) || count < 1 || count > 256 || !(width > 0)) return undefined;
  const heights = embedded >= 0 ? groups.filter((p) => p.code === 46).map((p) => flt(p.value)) : groups.filter((p) => p.code === 50).slice(1).map((p) => flt(p.value));
  return { type, count, width, gutter: Math.max(0, flt(code(49, 45))), autoHeight: int(code(79, 74)) !== 0, reversed: int(code(78, 73)) !== 0, heights: heights.slice(0, count) };
}

/** Field expressions in TEXT: evaluate for display and keep the code. */
function withTextField(text: string, ctx: ReadContext): { text: string; field?: FieldLink } {
  if (!hasFields(text)) return { text };
  const value = evaluateFields(text, ctx.fields);
  return { text: value, field: { code: text, value } };
}

export function readEntityObj(o: Obj, ctx: ReadContext): Entity | null {
  const base = commonProps(o);
  switch (o.kind) {
    case 'LINE':
      return { ...base, type: 'line', a: { x: num(o, 10), y: num(o, 20) }, b: { x: num(o, 11), y: num(o, 21) } };
    case 'CIRCLE':
      return { ...base, type: 'circle', center: { x: num(o, 10), y: num(o, 20) }, radius: num(o, 40) };
    case 'ARC':
      return {
        ...base,
        type: 'arc',
        center: { x: num(o, 10), y: num(o, 20) },
        radius: num(o, 40),
        startAngle: g.rad(num(o, 50)),
        endAngle: g.rad(num(o, 51)),
      };
    case 'LWPOLYLINE': {
      const pts: g.Point[] = [];
      const bulges: number[] = [];
      let x: number | null = null;
      for (const p of o.groups) {
        if (p.code === 10) x = parseFloat(p.value);
        else if (p.code === 20 && x !== null) {
          pts.push({ x, y: parseFloat(p.value) });
          bulges.push(0);
          x = null;
        } else if (p.code === 42 && bulges.length) bulges[bulges.length - 1] = parseFloat(p.value);
      }
      const closed = (num(o, 70) & 1) === 1;
      const width = num(o, 43, 0);
      // Zero-hole donut (two bulge-1 vertices, constant width = radius): read back as a filled dot.
      if (closed && pts.length === 2 && width > 0 && Math.abs((bulges[0] ?? 0) - 1) < 1e-6 && Math.abs((bulges[1] ?? 0) - 1) < 1e-6) {
        const c = g.mid(pts[0]!, pts[1]!);
        const r = g.dist(pts[0]!, pts[1]!) / 2 + width / 2;
        return { ...base, type: 'circle', center: c, radius: r, filled: true };
      }
      const hasBulge = bulges.some((b) => Math.abs(b) > 1e-12);
      return { ...base, type: 'polyline', points: pts, closed, bulges: hasBulge ? bulges : undefined, width: width > 0 ? width : undefined };
    }
    case 'POLYLINE':
      // Old-style POLYLINE with VERTEX children is handled by caller.
      return null;
    case 'SOLID':
    case 'TRACE': {
      const p1 = pt(o, 10);
      const p2 = pt(o, 11);
      const p3 = pt(o, 12);
      const p4 = has(o, 13) ? pt(o, 13) : p3;
      // bow-tie order 1-2-4-3
      const points = g.eq(p3, p4) ? [p1, p2, p3] : [p1, p2, p4, p3];
      return { ...base, type: 'polyline', points, closed: true, filled: true };
    }
    case 'TEXT': {
      const h = num(o, 72, 0);
      const v = num(o, 73, 0);
      const align: 'left' | 'center' | 'right' = h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left';
      // Alignment point (11/21) applies for any non-default justification; fit/aligned (3/5) keep the first point.
      const useAlignPt = (h !== 0 || v !== 0) && h !== 3 && h !== 5 && has(o, 11);
      let position = useAlignPt ? { x: num(o, 11), y: num(o, 21) } : { x: num(o, 10), y: num(o, 20) };
      const height = num(o, 40, 0.125);
      const rotation = g.rad(num(o, 50));
      // Vertical justification: shift down to the baseline (1 bottom, 2 middle, 3 top).
      const drop = v === 2 ? height / 2 : v === 3 ? height : 0;
      if (drop) position = { x: position.x + Math.sin(rotation) * drop, y: position.y - Math.cos(rotation) * drop };
      const wf = num(o, 41, 1);
      const oblique = g.rad(num(o, 51, 0));
      return {
        ...base,
        type: 'text',
        position,
        ...withTextField(str(o, 1), ctx),
        height,
        rotation,
        align,
        ...(wf > 0 && Math.abs(wf - 1) > 1e-9 ? { widthFactor: wf } : {}),
        ...(Math.abs(oblique) > 1e-9 ? { oblique } : {}),
      };
    }
    case 'MTEXT': {
      // Column definitions follow the MTEXT's own groups (R2018 "Embedded Object", or the
      // native 75.. groups): the main properties are read from the groups before them.
      const columns = readMTextColumns(o);
      const embedded = o.groups.findIndex((p) => p.code === 101 && p.value === 'Embedded Object');
      const nativeStart = embedded < 0 ? o.groups.findIndex((p) => p.code === 75) : -1;
      const mainEnd = embedded >= 0 ? embedded : nativeStart >= 0 ? nativeStart : o.groups.length;
      const main: Obj = { ...o, groups: o.groups.slice(0, mainEnd) };
      // MTEXT: 10/20 attachment corner, 71 attachment point (1..9), 11/21 direction vector, 50 rotation (radians)
      const ap = Math.max(1, Math.min(9, Math.trunc(num(main, 71, 1)))) as MTextAttachment;
      const hasDir = has(main, 11);
      const rotation = hasDir ? Math.atan2(num(main, 21), num(main, 11)) : num(main, 50);
      const height = num(main, 40, 0.125);
      const source = o.groups
        .filter((x) => x.code === 1 || x.code === 3)
        .map((x) => x.value)
        .join('');
      // Fields are evaluated first; the expression is kept for saving.
      const raw = hasFields(source) ? evaluateFields(source, ctx.fields) : source;
      const plain = mtextFromDxf(raw);
      const field: FieldLink | undefined = raw !== source ? { code: source, value: plain } : undefined;
      if (has(main, 41) || columns) {
        return {
          ...base,
          type: 'mtext',
          position: { x: num(main, 10), y: num(main, 20) },
          text: plain,
          ...(hasFormatting(raw) ? { raw } : {}),
          ...(field ? { field } : {}),
          height,
          width: Math.max(0, num(main, 41)),
          rotation,
          attachment: ap,
          lineSpacing: num(main, 44, 1) || 1,
          ...(columns ? { columns } : {}),
        };
      }
      // Minimal MTEXT without a reference width: keep it as single-line TEXT.
      const col = (ap - 1) % 3;
      const row = Math.floor((ap - 1) / 3);
      const align: 'left' | 'center' | 'right' = col === 1 ? 'center' : col === 2 ? 'right' : 'left';
      const drop = row === 0 ? height : row === 1 ? height / 2 : 0;
      const corner = { x: num(main, 10), y: num(main, 20) };
      const position = { x: corner.x + Math.sin(rotation) * drop, y: corner.y - Math.cos(rotation) * drop };
      const one = plain.replace(/\n/g, ' ');
      return { ...base, type: 'text', position, text: one, ...(field ? { field: { code: source, value: one } } : {}), height, rotation, align };
    }
    case 'ELLIPSE': {
      const start = num(o, 41, 0);
      const end = num(o, 42, 2 * Math.PI);
      return {
        ...base,
        type: 'ellipse',
        center: pt(o, 10),
        majorAxis: pt(o, 11, { x: 1, y: 0 }),
        ratio: Math.min(1, Math.max(1e-6, num(o, 40, 1))),
        startParam: start,
        endParam: end,
      };
    }
    case 'POINT':
      return { ...base, type: 'point', position: pt(o, 10) };
    case 'XLINE':
      return { ...base, type: 'xline', base: pt(o, 10), direction: g.normalize(pt(o, 11, { x: 1, y: 0 })) };
    case 'RAY':
      return { ...base, type: 'ray', base: pt(o, 10), direction: g.normalize(pt(o, 11, { x: 1, y: 0 })) };
    case 'DIMENSION':
      return readDimension(o, base, readDimStyleFromEntity(o, ctx.dimStyles, ctx.dimStyle, ctx.textStyleHandles));
    case 'SPLINE':
      return readSpline(o, base);
    case 'HATCH':
      return readHatch(o, base);
    case 'LEADER':
      return readLeader(o, base, ctx);
    case 'MULTILEADER':
    case 'MLEADER': {
      const ml = readMLeader(o, base, ctx);
      if (ml && o.groups.some((x) => x.code === 296 && x.value.trim() === '1')) {
        ctx.notes?.push('MULTILEADER block content is not drawn; the leader and its text are kept.');
        reportObj(ctx, o, 'simplified', 'its block content is not kept; the leader and its text are');
      }
      return ml;
    }
    case 'IMAGE': {
      const im = readImage(o, base);
      ctx.pendingImages?.set(im.id, str(o, 340).toUpperCase());
      return im;
    }
    case 'ACAD_TABLE': {
      // Cell data present: a native table. Otherwise it draws through its anonymous *T block (group 2).
      const block = str(o, 2);
      const table = readTable(o, base, ctx.tableStyles?.get(str(o, 342).toUpperCase()));
      if (table) {
        if (block) ctx.consumedBlocks?.add(block);
        return table;
      }
      if (!block) return null;
      return { ...base, type: 'insert', block, position: { x: num(o, 10), y: num(o, 20) }, rotation: 0, scale: 1, attributes: {} };
    }
    case 'INSERT': {
      const jt = readJcadTable(o, base);
      if (jt) {
        ctx.consumedBlocks?.add(str(o, 2));
        return jt;
      }
      const sx = num(o, 41, 1);
      const sy = num(o, 42, sx);
      return {
        ...base,
        type: 'insert',
        block: str(o, 2),
        position: { x: num(o, 10), y: num(o, 20) },
        rotation: g.rad(num(o, 50)) + insertScales(sx, sy).rotationOffset,
        attributes: {},
        ...insertScaleFields(sx, sy),
      };
    }
    default:
      return null;
  }
}

/**
 * Signed DXF / DWG X and Y scales -> the insert's scale, scaleY, mirror and rotation offset.
 * A negative X scale is a mirror about the block Y axis; a negative Y scale is the same
 * mirror followed by a half turn.
 */
export function insertScales(sx: number, sy: number): { scale: number; scaleY?: number; mirror?: boolean; rotationOffset: number } {
  const ax = Math.abs(sx) || 1;
  const ay = Math.abs(sy) || ax;
  const mirror = sx < 0 !== sy < 0;
  const out: { scale: number; scaleY?: number; mirror?: boolean; rotationOffset: number } = { scale: ax, rotationOffset: sy < 0 ? Math.PI : 0 };
  if (Math.abs(ay - ax) > 1e-12) out.scaleY = ay;
  if (mirror) out.mirror = true;
  return out;
}

/** Insert fields (scale / scaleY / mirror) from signed X and Y scales, for spreading into an entity. */
export function insertScaleFields(sx: number, sy: number): { scale: number; scaleY?: number; mirror?: boolean } {
  const sc = insertScales(sx, sy);
  return { scale: sc.scale, ...(sc.scaleY !== undefined ? { scaleY: sc.scaleY } : {}), ...(sc.mirror ? { mirror: true } : {}) };
}
