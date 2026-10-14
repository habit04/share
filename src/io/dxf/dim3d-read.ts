/**
 * True 3D dimensions, reader side (docs/3D-DIMENSIONS.md): model-space DIMENSION records that
 * become `Dimension3D`s instead of 2D dimensions.
 *
 * Which records: a DIMENSION with `JCAD_3D` XDATA (written by JCad's DIM3D) always, whatever the
 * experimental 3D setting, because Save writes it back (as for JCad's solids); another program's
 * DIMENSION whose extrusion (210) is not (0, 0, +1) (a tilted plane, or the XY plane seen from
 * below, (0, 0, -1)) only when the reader is told 3D is enabled (`DxfReadOptions.model3d`). Every
 * other DIMENSION, and every DIMENSION in a block or on a layout, takes the unchanged 2D path (which
 * draws it flat in the XY plane, as before; with 3D off the import report notes how many such
 * dimensions were read flat).
 *
 * The record is read in its OCS (io/dxf/dim3d-write.ts lists the groups): world definition points
 * 10 / 13 / 14 / 15, the OCS point 16 of two-line angular dimensions, the 210 normal, the style
 * (3 plus DSTYLE / JCAD_DIMSTYLE overrides, as for 2D) and the text override (1; a trailing
 * " (projected)" is dropped when the dimension measures a projection, since DIM3D adds it). The
 * measurement plane is the JCad data's frame when it matches the record (same normal, definition
 * point on it), else the Arbitrary Axis frame of the normal through the definition point. Types
 * other than aligned, linear and angular, unreadable numbers or degenerate geometry drop JCad's
 * records with a report reason; other programs' records then fall back to the 2D path.
 */
import type { Obj } from './groups';
import { has, invalidPrecision, num, shortText, str, isIntegerText } from './groups';
import { MODEL3D_APP, PRECISION_CODES, isQuietXdataApp } from './codes';
import { reportObj, type ReadContext } from './read-core';
import { dstylePairs, hasUnconsumedAcadXdata, readDimStyleFromEntity } from './read-annotations';
import { colorOf, invalidNumber, payloadText, native3dObject } from './mesh3d-read';
import * as g from '../../core/geometry';
import { type Frame3, type Vec3, add3, cross3, dot3, frameFromPlane, len3, normalize3, scale3, sub3, v3 } from '../../model3d/math';
import { type Dimension3DSpec, PROJECTED_SUFFIX, makeDimension3D, planeLocal, planeTolerance, planeWorld } from '../../model3d/dimension3d';
import { decodeDimensionPayload, MODEL3D_FILE_VERSION } from '../../model3d/file-format';
import type { Dimension3D } from '../../model3d/types';

/** True when the record carries JCad 3D data (a DIM3D dimension). */
export function hasJcad3dData(o: Obj): boolean {
  return payloadText(o) !== null;
}

/** The record's extrusion direction (default +Z). */
function extrusionOf(o: Obj): Vec3 {
  o = native3dObject(o);
  return v3(num(o, 210, 0), num(o, 220, 0), num(o, 230, 1));
}

/** True when the record's extrusion is not +Z (another plane, or the XY plane with the normal -Z). */
export function offPlusZ(o: Obj): boolean {
  const n = extrusionOf(o);
  return !(Math.abs(n.x) < 1e-9 && Math.abs(n.y) < 1e-9 && n.z > 0);
}

/**
 * True when the 3D dimension reader takes this model-space DIMENSION (see the module comment):
 * JCad 3D data, or (3D enabled) an extrusion that is not +Z.
 */
export function acceptsDimension3D(o: Obj, enabled: boolean): boolean {
  if (o.kind !== 'DIMENSION') return false;
  if (hasJcad3dData(o)) return true;
  return enabled && offPlusZ(o);
}

const pt3 = (o: Obj, code: number): Vec3 => v3(num(o, code, 0), num(o, code + 10, 0), num(o, code + 20, 0));

/** Outcome of reading one record: a dimension, a reason to drop it, or "use the 2D path". */
export type Dimension3DRead = { readonly dim: Dimension3D } | { readonly drop: string } | { readonly twoD: true };

/**
 * Read one model-space DIMENSION as a 3D dimension (`acceptsDimension3D` was true). Reports what is
 * simplified; the caller reports a `drop` and falls back to the 2D reader for `twoD`.
 */
export function readDimension3DRecord(o: Obj, ctx: ReadContext): Dimension3DRead {
  const ours = hasJcad3dData(o);
  const source = native3dObject(o, true);
  o = native3dObject(o);
  const fail = (reason: string): Dimension3DRead => (ours ? { drop: reason } : { twoD: true });
  const invalid = invalidNumber([o]);
  if (invalid) return fail(`3D dimension: ${invalid}`);
  const badPrecision = dstylePairs(source).find(([code, value]) => PRECISION_CODES[code] && invalidPrecision(PRECISION_CODES[code]!, value));
  if (badPrecision) return fail(`invalid DSTYLE ${PRECISION_CODES[badPrecision[0]]} precision "${shortText(badPrecision[1])}"`);
  const flags = num(o, 70);
  if (has(o, 70) && !isIntegerText(str(o, 70).trim()) || !Number.isSafeInteger(flags) || flags < 0 || flags > 255) return fail('3D dimension: group 70 must be an integer from 0 to 255');
  const type = flags & 15;
  if (type !== 0 && type !== 1 && type !== 2 && type !== 5) return fail('3D dimension: only aligned, linear and angular dimensions are read in their plane (this one is of another type)');
  const nRaw = extrusionOf(o);
  if (!(len3(nRaw) > 1e-12)) return fail('3D dimension: the extrusion direction (210) is zero');
  const n = normalize3(nRaw);
  // JCad's data: the id, the plane frame and the projected flag.
  const notes: string[] = [];
  let id: string | undefined;
  let stored: Frame3 | undefined;
  let storedOffset: number | undefined;
  const raw = payloadText(source);
  if (raw && 'problem' in raw) notes.push(`JCad 3D dimension data unreadable (${raw.problem}): the id and plane axes are not kept`);
  else if (raw) {
    const decoded = decodeDimensionPayload(raw.text);
    if (decoded.status === 'ok') {
      id = decoded.id;
      stored = decoded.plane;
      storedOffset = decoded.offset;
    } else if (decoded.status === 'newer') {
      id = decoded.id;
      ctx.report?.add({ type: o.kind, action: 'unsupported', reason: `3D dimension written by a newer JCad (3D data version ${decoded.version}; this version reads ${MODEL3D_FILE_VERSION}): read from its DXF groups only`, ...(has(o, 5) ? { handle: str(o, 5) } : {}), layer: str(o, 8, '0'), ...(o.line ? { line: o.line } : {}), ...(ctx.where ? { where: ctx.where } : {}) });
    } else notes.push(`JCad 3D dimension data unreadable (${decoded.reason}): the id and plane axes are not kept`);
  }
  const p10 = pt3(o, 10), p13 = pt3(o, 13), p14 = pt3(o, 14), p15 = pt3(o, 15);
  // The measurement plane: the stored frame when it matches the record, else the OCS through 10.
  let plane: Frame3;
  const defaultPlane = (): Frame3 => frameFromPlane({ origin: scale3(n, dot3(p10, n)), normal: n });
  if (stored) {
    const onPlane = Math.abs(dot3(sub3(p10, stored.origin), stored.zAxis)) <= planeTolerance(stored, [p10, p13, p14, has(o, 15) ? p15 : undefined]);
    if (len3(sub3(stored.zAxis, n)) <= 1e-6 && onPlane) plane = stored;
    else {
      storedOffset = undefined;
      plane = defaultPlane();
      notes.push('the stored measurement plane does not match the DIMENSION (it was edited elsewhere): the plane axes were rebuilt from its extrusion');
    }
  } else plane = defaultPlane();
  const style = readDimStyleFromEntity(source, ctx.dimStyles, ctx.dimStyle, ctx.textStyleHandles);
  const rawText = str(o, 1);
  const text = rawText && rawText !== '<>' ? rawText : undefined;
  const color = colorOf(o);
  if (color.problem) notes.push(color.problem);
  const base = { ...(id !== undefined ? { id } : {}), layer: str(o, 8, '0'), color: color.color, plane, style };
  let spec: Dimension3DSpec;
  try {
    switch (type) {
      case 1:
        spec = { ...base, kind: 'aligned', p1: p13, p2: p14, location: p10 };
        break;
      case 0: {
        // 50: the measurement direction in the OCS. A plane axis gives X / Y; any other direction
        // turns the plane frame about its normal so that X runs along it.
        const ocs = frameFromPlane({ origin: v3(0, 0, 0), normal: n });
        const a = g.rad(num(o, 50, 0));
        const dir = normalize3(add3(scale3(ocs.xAxis, Math.cos(a)), scale3(ocs.yAxis, Math.sin(a))));
        let axis: 'x' | 'y' = 'x';
        if (Math.abs(Math.abs(dot3(dir, plane.yAxis)) - 1) < 1e-9) axis = 'y';
        else if (!(Math.abs(Math.abs(dot3(dir, plane.xAxis)) - 1) < 1e-9)) plane = { origin: plane.origin, xAxis: dir, yAxis: normalize3(cross3(plane.zAxis, dir)), zAxis: plane.zAxis };
        spec = { ...base, plane, kind: 'linear', axis, p1: p13, p2: p14, location: p10 };
        break;
      }
      case 5:
        spec = { ...base, kind: 'angular', p1: p13, p2: p14, vertex: p15, location: p10 };
        break;
      default: {
        // Two-line angular: legs 13 -> 14 and 15 -> 10 meet at the vertex; 16 (OCS) is on the arc.
        const L = (q: Vec3) => {
          const l = planeLocal(plane, q);
          return { x: l.x, y: l.y };
        };
        const a1 = L(p13), a2 = L(p14), b1 = L(p15), b2 = L(p10);
        const r = g.sub(a2, a1), s = g.sub(b2, b1);
        const denom = g.cross(r, s);
        if (Math.abs(denom) < 1e-12) return fail('3D dimension: the legs of the two-line angular dimension are parallel');
        const c = g.add(a1, g.scale(r, g.cross(g.sub(b1, a1), s) / denom));
        const far = (p: Vec3, q: Vec3) => (g.dist(L(p), c) >= g.dist(L(q), c) ? p : q);
        const ocs = frameFromPlane({ origin: v3(0, 0, 0), normal: n });
        const p16 = planeWorld(ocs, { x: num(o, 16, 0), y: num(o, 26, 0) }, has(o, 36) ? num(o, 36, 0) : dot3(p10, n));
        spec = { ...base, kind: 'angular', p1: far(p13, p14), p2: far(p15, p10), vertex: planeWorld(plane, c), location: p16 };
      }
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return fail(`3D dimension: ${err.message}`);
  }
  let dim: Dimension3D;
  try {
    dim = makeDimension3D({ ...spec, textOverride: text });
    // DIM3D writes " (projected)" into the text of a projected dimension: it is not an override.
    if (dim.projected && text?.endsWith(PROJECTED_SUFFIX)) dim = makeDimension3D({ ...spec, textOverride: text.slice(0, -PROJECTED_SUFFIX.length) || undefined });
    if (dim.textOverride === '<>') dim = makeDimension3D({ ...spec, textOverride: undefined });
    // JCad's exact offset, while it agrees with the definition point (which the file rounds).
    if (storedOffset !== undefined && storedOffset !== dim.offset && Math.abs(storedOffset - dim.offset) <= 1e-9 * Math.max(1, Math.abs(storedOffset))) dim = { ...dim, offset: storedOffset };
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return fail(`3D dimension: ${err.message}`);
  }
  if ((flags & 128) || (has(o, 52) && num(o, 52) !== 0) || (has(o, 53) && num(o, 53) !== 0)) notes.push('a moved text position, text rotation or oblique extension lines are not kept on 3D dimensions');
  if (has(o, 6) || has(o, 370) || has(o, 420) || has(o, 430) || has(o, 440)) notes.push('linetype, lineweight, true colour, colour book and transparency are not kept on 3D dimensions (the ACI colour is used)');
  const apps = [...new Set(source.groups.filter((p) => p.code === 1001 && p.value.trim() !== MODEL3D_APP && !isQuietXdataApp(p.value.trim(), o.kind) && !(p.value.trim() === 'ACAD' && !hasUnconsumedAcadXdata(source))).map((p) => p.value.trim()))];
  if (apps.length) notes.push(`extended data (XDATA) of ${apps.join(', ')} is not kept`);
  for (const reason of notes) reportObj(ctx, o, 'simplified', reason);
  return { dim };
}
