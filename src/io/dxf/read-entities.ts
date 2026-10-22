/**
 * Entity codecs, reader side: one JCad entity per DXF entity record. Geometry types are read here
 * (LINE, CIRCLE, ARC, LWPOLYLINE, SOLID / TRACE, TEXT and MTEXT with their fields, ELLIPSE, POINT,
 * XLINE, RAY, SPLINE, HATCH, INSERT); DIMENSION, LEADER, MULTILEADER, IMAGE and tables come from
 * read-annotations.ts.
 */
import type { Obj } from './groups';
import { commonProps, reportObj } from './read-core';
import type { SplineEntity, HatchLoop, HatchEntity, HatchGradient, HatchGradientColor, WorldPatternLine, FieldLink, Entity, InsertEntity } from '../../core/entities';
import { afterSubclass, num, pointList, flt, Cursor, int, HatchReadError, pt, has, str, isIntegerText, shortText, xdata } from './groups';
import { isRealText, DYNAMIC_APP } from './codes';
import { decodeDynamicInstance, dynamicPayloadText } from './dynamic-data';
import * as g from '../../core/geometry';
import { splineWorkProblem, SplineWorkLimitError, isValidNurbs, nurbsPoints, interpolateFitPoints } from '../../core/spline';
import { LoopBuilder, edgeArc, fitPatternToLines, findPattern } from '../../core/hatch';
import type { ReadContext } from './read-core';
import { hasFields, evaluateFields } from '../../core/fields';
import { readMTextColumns, readDimension, readDimStyleFromEntity, readLeader, readMLeader, readImage, readTable, readJcadTable } from './read-annotations';
import { parseUnderlayEntity } from './underlay-codec';
import type { MTextAttachment, MTextBackground } from '../../core/mtext';
import { mtextFromDxf, hasFormatting } from '../../core/mtext';
import { readTextPlacement } from './read-text';
import { insertArrayFields } from '../../core/insert-array';
import { readBackgroundMetadata } from './mtext-background-data';
import { MAX_HATCH_GRADIENT_COLORS } from '../../core/hatch-gradient';

function readSpline(o: Obj, base: ReturnType<typeof commonProps>): SplineEntity | null {
  const gs = afterSubclass(o, 'AcDbSpline');
  const flags = Math.trunc(num(o, 70));
  const degree = Math.max(1, Math.trunc(num(o, 71, 3)));
  const knots = gs.filter((x) => x.code === 40).map((x) => Number(x.value));
  const weights = gs.filter((x) => x.code === 41).map((x) => Number(x.value));
  const controlPoints = pointList(gs, 10);
  const fitPoints = pointList(gs, 11);
  if (controlPoints.length < 2 && fitPoints.length < 2) return null;
  const tangent = (code: number): g.Point | undefined => (gs.some((x) => x.code === code) ? { x: flt(gs.find((x) => x.code === code)?.value), y: flt(gs.find((x) => x.code === code + 10)?.value) } : undefined);
  const st = tangent(12);
  const et = tangent(13);
  const workProblem = splineWorkProblem({ degree, knots, controlPoints }, fitPoints.length, { closed: (flags & 1) === 1, startTangent: st, endTangent: et });
  if (workProblem) throw new SplineWorkLimitError(workProblem);
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
  const flags = int(c.required(c.seek(92, 4), 92));
  const b = new LoopBuilder();
  if (flags & 2) {
    const hasBulge = int(c.take(72)) !== 0;
    c.take(73);
    const n = c.count(c.required(c.seek(93, 3), 93), 93, 2);
    const pts: g.Point[] = [];
    const bulges: number[] = [];
    for (let k = 0; k < n; k += 1) {
      pts.push(c.point(10));
      bulges.push(hasBulge && c.code === 42 ? flt(c.take(42)) : 0);
    }
    c.sourceHandles(c.take(97));
    if (pts.length < 2) return null;
    return { points: pts, ...(bulges.some((v) => Math.abs(v) > 1e-12) ? { bulges } : {}) };
  }
  const nEdges = c.count(c.required(c.seek(93, 3), 93), 93);
  for (let k = 0; k < nEdges; k += 1) {
    const type = int(c.required(c.seek(72, 3), 72));
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
      const nk = c.count(c.required(c.take(95), 95), 95);
      const nc = c.count(c.required(c.take(96), 96), 96, 2);
      const knots: number[] = [];
      for (let i = 0; i < nk; i += 1) knots.push(flt(c.required(c.seek(40, 2), 40)));
      const cps: g.Point[] = [];
      const weights: number[] = [];
      for (let i = 0; i < nc; i += 1) {
        cps.push(c.point(10));
        if (rational && c.code === 42) weights.push(flt(c.take(42), 1));
      }
      const nf = c.code === 97 ? c.count(c.take(97), 97, 2) : 0;
      const fit: g.Point[] = [];
      for (let i = 0; i < nf; i += 1) fit.push(c.point(11));
      if (c.code === 12) c.point(12);
      if (c.code === 13) c.point(13);
      const curve = { degree, knots, controlPoints: cps, ...(weights.length === cps.length ? { weights } : {}) };
      const workProblem = splineWorkProblem(curve, fit.length, {}, 8);
      if (workProblem) throw new HatchReadError(workProblem);
      const pts = isValidNurbs(curve) ? nurbsPoints(curve, 8) : fit.length >= 2 ? nurbsPoints(interpolateFitPoints(fit) ?? curve, 8) : cps;
      b.polyline(pts);
    } else throw new HatchReadError(`unsupported hatch edge type ${type}`);
  }
  c.sourceHandles(c.seek(97, 2));
  return b.loop();
}

/** Native AcDbHatch gradient data is independent of the ordinary pattern angle/scale. */
function readHatchGradient(o: Obj): HatchGradient | undefined {
  // Only the HATCH subclass owns these codes: 421 may also appear in unrelated XDATA.
  const gs = afterSubclass(o, 'AcDbHatch');
  const end = gs.findIndex((p) => p.code >= 1000);
  const data = end < 0 ? gs : gs.slice(0, end);
  const fields = [450, 451, 452, 453, 460, 461, 462, 470];
  if (!data.some((p) => fields.includes(p.code) || p.code === 463 || p.code === 421 || p.code === 63)) return undefined;
  const scalar = (code: number): string => {
    const matches = data.filter((p) => p.code === code);
    if (matches.length !== 1) throw new HatchReadError(`gradient group ${code} must occur exactly once`);
    return matches[0]!.value;
  };
  const number = (code: number, integer = false, min = -Infinity, max = Infinity): number => {
    const value = scalar(code);
    const n = Number(value);
    if (!(integer ? isIntegerText(value.trim()) : isRealText(value)) || !Number.isFinite(n) || n < min || n > max) {
      throw new HatchReadError(`invalid gradient group ${code}: "${shortText(value)}"`);
    }
    return n;
  };
  const kind = number(450, true, -0x80000000, 0x7fffffff);
  const reserved = number(451, true, -0x80000000, 0x7fffffff);
  const colorMode = number(452, true, -0x80000000, 0x7fffffff);
  const count = number(453, true, 0, MAX_HATCH_GRADIENT_COLORS);
  const angle = number(460);
  const shift = number(461, false, 0, 1);
  const tint = number(462, false, 0, 1);
  const name = scalar(470);
  // AutoCAD writes this empty descriptor on ordinary hatches (including patterned
  // ones). A blank name is valid only for this inactive, colorless default tail;
  // meaningful disabled settings and active gradients still require full validation.
  if (kind === 0 && reserved === 0 && [0, 1].includes(colorMode) && count === 0
    && angle === 0 && shift === 0 && tint === 0 && name === ''
    && !data.some((p) => p.code === 463 || p.code === 63 || p.code === 421)) return undefined;
  if (!name.trim() || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) throw new HatchReadError('gradient name must contain 1 to 256 printable characters');
  const colors: HatchGradientColor[] = [];
  for (const p of data) {
    if (p.code === 463) {
      if (colors.length >= MAX_HATCH_GRADIENT_COLORS) throw new HatchReadError(`gradient exceeds the ${MAX_HATCH_GRADIENT_COLORS} color limit`);
      const position = Number(p.value);
      if (!isRealText(p.value) || !Number.isFinite(position) || position < 0 || position > 1) throw new HatchReadError(`invalid gradient group 463: "${shortText(p.value)}"`);
      colors.push({ position });
    } else if (p.code === 63 || p.code === 421) {
      const last = colors[colors.length - 1];
      const key = p.code === 63 ? 'color' : 'trueColor';
      const value = Number(p.value);
      if (!last || last[key] !== undefined || !isIntegerText(p.value.trim()) || value < 0 || value > (p.code === 63 ? 256 : 0xffffff)) throw new HatchReadError(`invalid gradient group ${p.code}: "${shortText(p.value)}"`);
      colors[colors.length - 1] = { ...last, [key]: value };
    }
  }
  if (colors.length !== count || colors.some((c) => c.color === undefined && c.trueColor === undefined)) throw new HatchReadError(`gradient group 453 declares ${count} colors but complete color records do not match`);
  return {
    name, angle, shift, singleColor: colorMode === 1, tint, colors,
    ...(kind !== 1 ? { kind } : {}),
    ...(reserved !== 0 ? { reserved } : {}),
    ...(![0, 1].includes(colorMode) ? { colorMode } : {}),
    ...(count !== 2 ? { colorCount: count } : {}),
  };
}

function readHatch(o: Obj, base: ReturnType<typeof commonProps>): HatchEntity | null {
  const gradient = readHatchGradient(o);
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
      const n = c.count(value, 91);
      for (let k = 0; k < n; k += 1) {
        const l = readHatchLoop(c);
        if (l) loops.push(l);
      }
      continue;
    }
    if (code === 78) {
      c.i += 1;
      const n = c.count(value, 78);
      for (let k = 0; k < n; k += 1) {
        const a = flt(c.required(c.seek(53, 3), 53));
        const bx = flt(c.take(43));
        const by = flt(c.take(44));
        const ox = flt(c.take(45));
        const oy = flt(c.take(46));
        const nd = c.count(c.required(c.take(79), 79), 79);
        const dashes: number[] = [];
        for (let d = 0; d < nd; d += 1) dashes.push(flt(c.required(c.take(49), 49)));
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
    ...(gradient ? { gradient } : {}),
  };
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
      const widths: Array<{ start: number; end: number }> = [];
      const ids: Array<number | undefined> = [];
      let variableWidth = false;
      for (const p of o.groups) {
        if (p.code === 10) {
          pts.push({ x: Number(p.value), y: NaN });
          bulges.push(0);
          widths.push({ start: 0, end: 0 });
          ids.push(undefined);
        } else if (p.code === 20 && pts.length) pts[pts.length - 1] = { x: pts[pts.length - 1]!.x, y: Number(p.value) };
        else if (p.code === 42 && bulges.length) bulges[bulges.length - 1] = Number(p.value);
        // Persistent vertex identifier (group 91): ASSOC geom dependencies
        // address this vertex by it (Q11 F4) — carry it into the model.
        else if (p.code === 91 && ids.length) ids[ids.length - 1] = Math.trunc(Number(p.value));
        else if ((p.code === 40 || p.code === 41) && widths.length) {
          variableWidth = true;
          widths[widths.length - 1]![p.code === 40 ? 'start' : 'end'] = flt(p.value);
        }
      }
      const closed = (num(o, 70) & 1) === 1;
      const width = num(o, 43, 0);
      const hasIds = ids.some((v) => v !== undefined);
      // Zero-hole donut (two bulge-1 vertices, constant width = radius): read back as a filled dot.
      // A vertex-ID-carrying polyline belongs to a constraint web that addresses
      // its vertices by ID; converting it to a circle would drop those IDs (the
      // Q11 F4 loss), so the conversion does not apply when IDs are present.
      if (!hasIds && !variableWidth && closed && pts.length === 2 && width > 0 && Math.abs((bulges[0] ?? 0) - 1) < 1e-6 && Math.abs((bulges[1] ?? 0) - 1) < 1e-6) {
        const c = g.mid(pts[0]!, pts[1]!);
        const r = g.dist(pts[0]!, pts[1]!) / 2 + width / 2;
        return { ...base, type: 'circle', center: c, radius: r, filled: true };
      }
      const hasBulge = bulges.some((b) => Math.abs(b) > 1e-12);
      return { ...base, type: 'polyline', points: pts, closed, bulges: hasBulge ? bulges : undefined, ...(variableWidth ? { widths } : { width: width !== 0 ? width : undefined }), ...(hasIds ? { vertexIds: ids } : {}) };
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
      return {
        ...base,
        type: 'text',
        ...readTextPlacement(o),
        ...withTextField(str(o, 1), ctx),
      };
    }
    case 'MTEXT': {
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
      const bgGroups: Obj = { ...main, groups: afterSubclass(main, 'AcDbMText') };
      const backgroundRgb = has(bgGroups, 421) ? 421 : has(main, 100) && has(bgGroups, 420) ? 420 : undefined;
      const backgroundName = has(bgGroups, 431) ? 431 : has(main, 100) && has(bgGroups, 430) ? 430 : undefined;
      let background: MTextBackground | undefined = has(bgGroups, 90) ? {
        flags: num(bgGroups, 90),
        scale: num(bgGroups, 45, 1.5),
        color: num(bgGroups, 63, 256) === 256 ? 'ByLayer' : num(bgGroups, 63, 256),
        ...(backgroundRgb !== undefined ? { trueColor: num(bgGroups, backgroundRgb) } : {}),
        ...(backgroundName !== undefined ? { colorName: str(bgGroups, backgroundName) } : {}),
        ...(has(bgGroups, 441) ? { transparency: num(bgGroups, 441) } : {}),
      } : undefined;
      const inactive = readBackgroundMetadata(o, height);
      if (inactive.problem) reportObj(ctx, o, 'simplified', `inactive MTEXT background settings are not restored: ${inactive.problem}`);
      else if (inactive.background) {
        if (background && background.flags !== 0) reportObj(ctx, o, 'simplified', 'inactive MTEXT background metadata is ignored because native fill/frame flags are active');
        else background = inactive.background;
      }
      if (has(main, 41) || columns || background) {
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
          ...(background ? { background } : {}),
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
      return readDimension(o, base, readDimStyleFromEntity(o, ctx.dimStyles, ctx.dimStyle, ctx.textStyleHandles), ctx.textStyleHandles);
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
    case 'PDFUNDERLAY':
    case 'DWFUNDERLAY':
    case 'DGNUNDERLAY': {
      // RULING-P28 C1/C3: the placement is modelled through the underlay
      // codec. A codec refusal drops THIS record with the codec's reason —
      // never half-modelled, never aborting its siblings. The entity id is
      // the reader's (base.id); the codec's isolated id is not used here.
      // No referenced-file I/O happens at import (C3).
      const kind = o.kind === 'PDFUNDERLAY' ? 'pdf' : o.kind === 'DWFUNDERLAY' ? 'dwf' : 'dgn';
      const parsed = parseUnderlayEntity(kind, o.groups.map((p) => [p.code, p.value] as const), base.id);
      if (!parsed.ok) {
        reportObj(ctx, o, 'dropped', parsed.refusal);
        return null;
      }
      const p = parsed.value;
      return {
        ...base,
        type: 'underlay',
        kind,
        definitionHandle: p.definitionHandle,
        position: p.position,
        scaleX: p.scaleX,
        scaleY: p.scaleY,
        rotation: p.rotation,
        flags: p.flags,
        ...(p.contrast !== undefined ? { contrast: p.contrast } : {}),
        ...(p.fade !== undefined ? { fade: p.fade } : {}),
        ...(p.clipBoundary ? { clipBoundary: p.clipBoundary } : {}),
        retainedGroups: p.retainedGroups,
      };
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
      const blockName = str(o, 2);
      // Priority 30 instance carrier: JCAD_DYNAMIC XDATA on the INSERT. Values are
      // modeled only when the owning block has a modeled dynamic definition and the
      // values validate against it; anything else (malformed, newer version, invalid
      // values, or a block with no modeled definition) is retained raw on
      // dynamicRetained and the instance displays at the authored state.
      let dynamic: Partial<Pick<InsertEntity, 'dynamic' | 'dynamicRetained'>> = {};
      const dynamicPairs = xdata(o, DYNAMIC_APP);
      if (dynamicPairs) {
        const raw = dynamicPayloadText(dynamicPairs);
        const definition = ctx.blocks?.[blockName]?.dynamic;
        const decoded = definition ? decodeDynamicInstance(raw, definition, blockName) : { ok: false as const, retained: raw };
        dynamic = decoded.ok ? { dynamic: decoded.state } : { dynamicRetained: decoded.retained };
      }
      return {
        ...base,
        type: 'insert',
        block: blockName,
        position: { x: num(o, 10), y: num(o, 20) },
        rotation: g.rad(num(o, 50)) + insertScales(sx, sy).rotationOffset,
        attributes: {},
        ...insertScaleFields(sx, sy),
        ...insertArrayFields(has(o, 70) ? num(o, 70) : undefined, has(o, 71) ? num(o, 71) : undefined, has(o, 44) ? num(o, 44) : undefined, has(o, 45) ? num(o, 45) : undefined, insertScales(sx, sy).rotationOffset),
        ...dynamic,
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
