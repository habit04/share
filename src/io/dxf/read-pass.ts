/**
 * The entity pass, reader side: a list of entity records (model space, a block definition or a
 * layout) into entities. VERTEX, ATTRIB and SEQEND are folded into their POLYLINE or INSERT, the
 * entity's plane (extrusion) is applied, invalid geometry and lost XDATA are reported, unknown
 * records are reported or kept raw when that is safe, and LEADERs take the MTEXT they point to.
 */
import type { Obj } from './groups';
import type { RawDxfEntity } from '../import-report';
import { isPointerCode, isRealCode, isRealText, isIntCode, PRECISION_CODES, isQuietXdataApp, ANNO_APP } from './codes';
import { str, num, isIntegerText, shortText, invalidPrecision, precisionRequirement, has, HatchReadError, xdata } from './groups';
import type { Entity, TextEntity } from '../../core/entities';
import type { ReadContext } from './read-core';
import * as g from '../../core/geometry';
import { reportObj, commonProps } from './read-core';
import { geometryProblem } from '../import-report';
import { dstylePairs, hasUnconsumedAcadXdata } from './read-annotations';
import { formattedSource } from '../../core/mtext';
import { DIM_VARIABLES } from '../../core/dimension';
import { readEntityObj } from './read-entities';
import { SplineWorkLimitError } from '../../core/spline';
import { withTextStyle } from '../encoding';

/** Entity types the reader converts (anything else is reported, or kept raw when safe). */
const READ_KINDS = new Set(['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE', 'SOLID', 'TRACE', 'TEXT', 'MTEXT', 'ELLIPSE', 'POINT', 'XLINE', 'RAY', 'DIMENSION', 'SPLINE', 'HATCH', 'LEADER', 'MULTILEADER', 'MLEADER', 'IMAGE', 'ACAD_TABLE', 'INSERT']);

/** Records folded into the preceding entity (or block / layout structure). */
const FOLLOWER_KINDS = new Set(['ATTRIB', 'VERTEX', 'SEQEND', 'ENDBLK', 'BLOCK', 'VIEWPORT']);

/**
 * Unknown entity types kept as raw records in model space: self-contained types that need no
 * CLASSES entry, no other object and no handle reference, so writing them back cannot make the
 * file unreadable. (Solids / regions only with their ACIS data inline, as in AC1015..AC1024.)
 */
const RAW_KEEP_KINDS = new Set(['3DFACE', '3DSOLID', 'REGION', 'BODY']);

const UNSUPPORTED_REASONS: Record<string, string> = {
  ATTDEF: 'attribute definitions outside a block definition are not supported',
  WIPEOUT: 'wipeouts (masking areas) are not supported',
  MLINE: 'multilines are not supported',
  OLE2FRAME: 'embedded OLE objects are not supported',
  OLEFRAME: 'embedded OLE objects are not supported',
  TOLERANCE: 'geometric tolerance frames are not supported',
  SHAPE: 'shapes (SHX shape references) are not supported',
  ACAD_PROXY_ENTITY: 'proxy objects of other applications are not supported',
  ARC_DIMENSION: 'arc-length dimensions are not supported',
  ARCALIGNEDTEXT: 'arc-aligned text is not supported',
  RTEXT: 'remote text is not supported',
  HELIX: 'helixes are not supported',
  MESH: 'meshes are not supported',
  SURFACE: 'surfaces are not supported',
  PDFUNDERLAY: 'PDF underlays are not supported',
  DWFUNDERLAY: 'DWF underlays are not supported',
  DGNUNDERLAY: 'DGN underlays are not supported',
};

/** A raw record of an unknown entity, or null when it cannot be kept safely. */
function rawRecord(o: Obj): RawDxfEntity | null {
  if (!RAW_KEEP_KINDS.has(o.kind)) return null;
  // Newer files keep solid / region data in the ACDSDATA section (the object only points to it).
  if (o.kind !== '3DFACE' && !o.groups.some((x) => x.code === 1 || x.code === 3)) return null;
  const groups: Array<readonly [number, string]> = [];
  let brace = 0;
  for (const p of o.groups) {
    if (p.code === 102) {
      brace += p.value.trim().startsWith('{') ? 1 : p.value.trim() === '}' ? -1 : 0;
      continue;
    }
    if (brace > 0) continue; // reactors / extension dictionary
    if (p.code >= 1000) break; // extended data: its application is not registered on save
    if (isPointerCode(p.code)) continue;
    groups.push([p.code, p.value]);
  }
  const handle = str(o, 5);
  return { type: o.kind, layer: str(o, 8, '0'), ...(handle ? { handle } : {}), groups };
}

/**
 * DXF objects drawn in their own plane: extrusion (0,0,-1) is a mirror about the Y axis, as
 * MIRROR leaves arcs, circles and polylines. Those are flipped into world coordinates; other
 * entity types (or other extrusions) are reported as simplified (drawn flat).
 */
function applyExtrusion(o: Obj, e: Entity, ctx: ReadContext): Entity {
  const nx = num(o, 210, 0);
  const ny = num(o, 220, 0);
  const nz = num(o, 230, 1);
  if (Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && nz > 0) return e;
  const mirrored = Math.abs(nx) < 1e-9 && Math.abs(ny) < 1e-9 && nz < 0;
  const flip = (q: g.Point): g.Point => ({ x: -q.x, y: q.y });
  if (mirrored) {
    switch (e.type) {
      case 'circle':
        return { ...e, center: flip(e.center) };
      case 'arc':
        return { ...e, center: flip(e.center), startAngle: Math.PI - e.endAngle, endAngle: Math.PI - e.startAngle };
      case 'polyline':
        // LWPOLYLINE / 2D POLYLINE vertices and SOLID / TRACE corners are in the object's plane.
        return { ...e, points: e.points.map(flip), ...(e.bulges ? { bulges: e.bulges.map((b) => -b || 0) } : {}) };
      case 'insert': {
        // The insertion point, rotation and scales are in the object's plane: mirroring the plane
        // flips the position, reverses the rotation and mirrors the block about its Y axis.
        const { mirror: _m, ...rest } = e;
        return { ...rest, position: flip(e.position), rotation: -e.rotation, ...(e.mirror ? {} : { mirror: true }) };
      }
      default:
        break;
    }
  }
  // Entities whose points DXF stores in world coordinates ignore the extrusion for 2D purposes.
  if (o.kind === 'LINE' || o.kind === 'POINT' || o.kind === 'XLINE' || o.kind === 'RAY' || o.kind === 'SPLINE' || o.kind === 'ELLIPSE' || o.kind === 'MTEXT' || o.kind === 'LEADER' || o.kind === 'MULTILEADER' || o.kind === 'DIMENSION') return e;
  reportObj(ctx, o, 'simplified', `drawn in a plane other than the XY plane (extrusion ${nx},${ny},${nz}): shown projected flat, possibly mirrored`);
  return e;
}

/** Parse a list of entity objects, folding ATTRIB/SEQEND into inserts and VERTEX into polylines. */
export function readEntities(objs: Obj[], ctx: ReadContext, keepRaw = false): Entity[] {
  const out: Entity[] = [];
  /** A converted entity: validated (invalid geometry is rejected), extrusion applied, XDATA loss reported. */
  const accept = (o: Obj, e: Entity | null): Entity | null => {
    if (!e) return null;
    const invalid = o.groups.find((p) => (isRealCode(p.code) && (!isRealText(p.value) || !Number.isFinite(Number(p.value)))) || (isIntCode(p.code) && !isIntegerText(p.value.trim())));
    let extrusion = false;
    let xdataApps = false;
    for (const p of o.groups) {
      if (p.code === 210 || p.code === 220 || p.code === 230) extrusion = true;
      else if (p.code === 1001) xdataApps = true;
    }
    const placed = extrusion ? applyExtrusion(o, e, ctx) : e;
    const bad = geometryProblem(placed);
    if (bad) {
      reportObj(ctx, o, 'dropped', `invalid geometry: ${bad}${invalid ? ` (group ${invalid.code}, value line ${(invalid.line ?? 1) + 1}: "${shortText(invalid.value)}")` : ''}`);
      return null;
    }
    if (invalid) {
      reportObj(ctx, o, 'dropped', `invalid numeric group ${invalid.code} at line ${(invalid.line ?? 1) + 1}: "${shortText(invalid.value)}" must be a complete ${isIntCode(invalid.code) ? 'integer' : 'number'}`);
      return null;
    }
    const badPrecision = o.kind === 'DIMENSION' ? dstylePairs(o).find(([code, value]) => PRECISION_CODES[code] && invalidPrecision(PRECISION_CODES[code]!, value)) : undefined;
    if (badPrecision) {
      const name = PRECISION_CODES[badPrecision[0]]!;
      reportObj(ctx, o, 'dropped', `invalid DSTYLE ${name} precision "${shortText(badPrecision[1])}": expected ${precisionRequirement(name)}`);
      return null;
    }
    if (e.type === 'hatch' && e.associative) reportObj(ctx, o, 'simplified', 'associative hatch boundary links are not kept; its boundary geometry is kept and saved non-associative');
    if (o.kind === 'ACAD_TABLE') reportObj(ctx, o, 'simplified', 'table cells, sizes and supported style defaults are kept; native table editing, formulas, style font names, advanced borders and fills are not modeled, and export uses an INSERT picture with JCAD_TABLE data');
    if (o.kind === 'HATCH' && num(o, 450) === 1) reportObj(ctx, o, 'simplified', 'gradient hatch settings are not kept; boundary geometry and the solid/pattern fill are retained');
    if (e.type === 'mtext' && e.columns) reportObj(ctx, o, 'simplified', `column definitions are kept in JCAD_MTEXT_COLUMNS on AutoCAD 2000 export; other CAD programs show one column${e.columns.type === 2 || !formattedSource(e)?.includes('\\N') ? '; automatic column flow is approximated in JCad' : ''}`);
    if (o.kind === 'LWPOLYLINE' && (has(o, 40) || has(o, 41))) reportObj(ctx, o, 'simplified', 'per-vertex polyline widths are not kept; its centerline and constant width are kept');
    if (has(o, 39) && num(o, 39) !== 0) reportObj(ctx, o, 'simplified', 'nonzero thickness is not kept in the 2D drawing');
    if (has(o, 440) || has(o, 430)) reportObj(ctx, o, 'simplified', 'transparency and color-book names are not kept; RGB/ACI color is kept');
    // IMAGE's IMAGEDEF reactor is reconstructed on export; other object links are unmodeled.
    const unmodeledLinks = o.kind === 'IMAGE' ? o.groups.some((p) => p.code === 102 && p.value !== '{ACAD_REACTORS' && p.value !== '}') : has(o, 102) || has(o, 360);
    if (unmodeledLinks) reportObj(ctx, o, 'simplified', 'reactor/extension-dictionary links are not kept; supported drawing geometry is kept');
    if (o.kind === 'MTEXT' && num(o, 90) !== 0) reportObj(ctx, o, 'simplified', 'MTEXT background fill is not kept');
    if (ctx.report && xdataApps) {
      const consumedDstyle = o.kind === 'DIMENSION' || o.kind === 'LEADER';
      const unsupportedOverrides = o.kind === 'DIMENSION' ? dstylePairs(o).filter(([code]) => ![71, 72, 73, 74, 78, 340].includes(code) && !DIM_VARIABLES.some((v) => v.code === code)) : o.kind === 'LEADER' ? dstylePairs(o).filter(([code]) => code !== 41) : [];
      if (unsupportedOverrides.length) reportObj(ctx, o, 'simplified', `DSTYLE override groups ${unsupportedOverrides.map(([code]) => code).join(', ')} are not modeled or written back`);
      const apps = [...new Set(o.groups.filter((x) => x.code === 1001 && !isQuietXdataApp(x.value.trim()) && !(x.value.trim() === 'ACAD' && consumedDstyle && !hasUnconsumedAcadXdata(o))).map((x) => x.value.trim()))];
      if (apps.length) reportObj(ctx, o, 'simplified', `extended data (XDATA) of ${apps.join(', ')} is not kept`);
    }
    return placed;
  };
  // LEADER -> MTEXT associations (340), resolved after the pass.
  const annotations = new Map<string, number>();
  const leaders: Array<{ index: number; handle: string }> = [];
  let i = 0;
  while (i < objs.length) {
    const o = objs[i]!;
    if (o.kind === 'POLYLINE') {
      const pts: g.Point[] = [];
      const bulges: number[] = [];
      const flags = Math.trunc(num(o, 70));
      const closed = (flags & 1) === 1;
      let j = i + 1;
      const vertexStart = j;
      while (j < objs.length && objs[j]!.kind === 'VERTEX') {
        pts.push({ x: num(objs[j]!, 10), y: num(objs[j]!, 20) });
        bulges.push(num(objs[j]!, 42, 0));
        j += 1;
      }
      if (j < objs.length && objs[j]!.kind === 'SEQEND') j += 1;
      i = j;
      if (flags & (16 | 64)) {
        // Polygon / polyface meshes: their vertex list holds face records, not an outline.
        reportObj(ctx, o, 'dropped', `${flags & 64 ? 'polyface' : 'polygon'} meshes are not supported`);
        continue;
      }
      if (flags & 8) reportObj(ctx, o, 'simplified', '3D polyline: flattened to its XY projection');
      const width = num(o, 40, 0);
      const vertexGroups = objs.slice(vertexStart, j).filter((child) => child.kind === 'VERTEX').flatMap((child) => child.groups);
      const poly = accept({ ...o, groups: [...o.groups, ...vertexGroups] }, {
        ...commonProps(o),
        type: 'polyline',
        points: pts,
        closed,
        bulges: bulges.some((b) => Math.abs(b) > 1e-12) ? bulges : undefined,
        width: width > 0 ? width : undefined,
      });
      if (poly) out.push(poly);
      continue;
    }
    // HATCH readers use declared counts and tessellate curves before accept() sees the
    // result. Reject bad numeric tokens before those loops or geometry calculations.
    if (o.kind === 'HATCH') {
      const invalid = o.groups.find((p) => (isRealCode(p.code) && (!isRealText(p.value) || !Number.isFinite(Number(p.value)))) || (isIntCode(p.code) && !isIntegerText(p.value.trim())));
      if (invalid) {
        reportObj(ctx, o, 'dropped', `invalid numeric group ${invalid.code}, value line ${(invalid.line ?? 1) + 1}: "${shortText(invalid.value)}" must be a complete finite ${isIntCode(invalid.code) ? 'safe integer' : 'number'}`);
        i += 1;
        continue;
      }
    }
    let read: Entity | null;
    try {
      read = readEntityObj(o, ctx);
    } catch (err) {
      if (!(err instanceof HatchReadError) && !(err instanceof SplineWorkLimitError)) throw err;
      reportObj(ctx, o, 'dropped', err instanceof SplineWorkLimitError ? err.message : `invalid hatch data: ${err.message}`);
      i += 1;
      continue;
    }
    if (!read) {
      if (FOLLOWER_KINDS.has(o.kind)) {
        // An ATTRIB / VERTEX / SEQEND without its owner: nothing to fold it into.
        if (o.kind !== 'SEQEND') reportObj(ctx, o, 'dropped', `stray ${o.kind} record without the object it belongs to`);
      } else if (READ_KINDS.has(o.kind)) {
        reportObj(ctx, o, 'dropped', o.kind === 'DIMENSION' ? 'this dimension type (or its definition points) is not supported' : 'its data is incomplete or of a variant that is not supported');
      } else {
        const raw = keepRaw && ctx.raw ? rawRecord(o) : null;
        if (raw) {
          ctx.raw!.push(raw);
          reportObj(ctx, o, 'kept', 'not shown or editable; kept as it was and written back on save (its extended data and links to other objects are not)');
        } else {
          const why = UNSUPPORTED_REASONS[o.kind] ?? `${o.kind} objects are not supported`;
          const solidData = RAW_KEEP_KINDS.has(o.kind) && keepRaw ? ' (its data is stored outside the object in this file version, so it cannot be kept)' : RAW_KEEP_KINDS.has(o.kind) ? ' (kept only in model space)' : '';
          reportObj(ctx, o, 'dropped', why + solidData);
        }
      }
      i += 1;
      continue;
    }
    if (read.type === 'insert' && o.kind === 'INSERT' && (num(o, 70, 1) > 1 || num(o, 71, 1) > 1)) {
      reportObj(ctx, o, 'simplified', `MINSERT array of ${Math.trunc(num(o, 70, 1))} x ${Math.trunc(num(o, 71, 1))} copies: only the first copy is kept`);
    }
    // TEXT / MTEXT keep their text style name (group 7) for the TrueType renderer and the writer.
    const styled = read && (read.type === 'text' || read.type === 'mtext') ? withTextStyle(read, str(o, 7)) : read;
    const e = accept(o, styled && xdata(o, ANNO_APP) ? ({ ...styled, annotative: true } as Entity) : styled);
    if (!e) {
      // Rejected (invalid geometry): skip its ATTRIB / SEQEND followers too.
      let j = i + 1;
      while (j < objs.length && (objs[j]!.kind === 'ATTRIB' || objs[j]!.kind === 'SEQEND')) j += 1;
      i = j;
      continue;
    }
    if (e && e.type === 'insert') {
      const attrs: Record<string, string> = {};
      const hidden: string[] = [];
      let j = i + 1;
      while (j < objs.length && objs[j]!.kind === 'ATTRIB') {
        const tag = str(objs[j]!, 2);
        attrs[tag] = str(objs[j]!, 1);
        if ((Math.trunc(num(objs[j]!, 70)) & 1) === 1) hidden.push(tag);
        j += 1;
      }
      if (j < objs.length && objs[j]!.kind === 'SEQEND') j += 1;
      // An ATTRIB flagged invisible whose ATTDEF is visible hides that attribute on this insert only.
      const def = ctx.blocks?.[e.block];
      const hiddenHere = def ? hidden.filter((t) => def.attributes.some((a) => a.tag === t && !a.invisible)) : [];
      out.push({ ...e, attributes: attrs, ...(hiddenHere.length ? { hiddenAttributes: hiddenHere } : {}) });
      i = j;
      continue;
    }
    if (e && (o.kind === 'MTEXT' || o.kind === 'TEXT') && has(o, 5)) annotations.set(str(o, 5).toUpperCase(), out.length);
    if (e && e.type === 'leader' && o.kind === 'LEADER' && has(o, 340)) leaders.push({ index: out.length, handle: str(o, 340).toUpperCase() });
    if (e) out.push(e);
    i += 1;
  }
  if (!leaders.length) return out;
  const drop = new Set<number>();
  for (const l of leaders) {
    const at = annotations.get(l.handle);
    const ann = at === undefined ? undefined : out[at];
    const ld = out[l.index];
    if (!ann || !ld || ld.type !== 'leader' || drop.has(at!)) continue;
    if (ann.type === 'mtext') {
      out[l.index] = {
        ...ld,
        text: ann.text,
        ...(ann.raw ? { raw: ann.raw } : {}),
        textPosition: ann.position,
        textHeight: ann.height,
        textAttachment: ann.attachment,
        ...(ann.width > 0 ? { textWidth: ann.width } : {}),
        ...(Math.abs(ann.rotation) > 1e-12 ? { textRotation: ann.rotation } : {}),
      };
      drop.add(at!);
    } else if (ann.type === 'text') {
      const t = ann as TextEntity;
      out[l.index] = { ...ld, text: t.text, textPosition: t.position, textHeight: t.height, textAttachment: t.align === 'center' ? 8 : t.align === 'right' ? 9 : 7, ...(Math.abs(t.rotation) > 1e-12 ? { textRotation: t.rotation } : {}) };
      drop.add(at!);
    }
  }
  return drop.size ? out.filter((_, k) => !drop.has(k)) : out;
}
