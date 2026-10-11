/**
 * DXF (AC1015 / AutoCAD 2000) reader and writer.
 * Entities: LINE, CIRCLE, ARC, LWPOLYLINE (bulges, constant width), POLYLINE,
 * TEXT, MTEXT, INSERT (+ ATTRIB), ELLIPSE, POINT, XLINE, RAY, SOLID/TRACE,
 * DIMENSION (with its anonymous *D block), SPLINE, HATCH (pattern definition lines),
 * LEADER (+ its MTEXT) and MULTILEADER, IMAGE (+ IMAGEDEF), ACAD_TABLE (cell data) and
 * external-reference blocks; fields in TEXT / MTEXT. Tables: LAYER (linetype, lineweight,
 * frozen/off/locked), LTYPE (dash patterns), VIEW, DIMSTYLE, BLOCK_RECORD.
 * Header: units, limits, LTSCALE, PDMODE/PDSIZE, DIM* variables, CELTYPE/CELWEIGHT.
 */
import type { Entity, BlockDef, Layer, DimStyle, TextEntity } from '../core/entities';
import { STANDARD_DIMSTYLE, DIMSTYLES_META_KEY, diffDimStyles } from '../core/dimension';
import { julianToDate, type FieldContext } from '../core/fields';
import { DEFAULT_LAYERS, DEFAULT_HEADER, type DrawingState, type DrawingHeader, type NamedView } from '../core/document';
import { findLinetype, type Linetype } from '../core/linetypes';
import type { LinearUnits } from '../core/units';
import * as g from '../core/geometry';
import { attdefFlagProps, type AttributeDefExt } from '../electrical/symbol-builder-core';
import { isScaleName } from '../core/layouts';
// Track E: paper space (layouts, VIEWPORT entities, LAYOUT objects) lives in dxf-layouts.ts.
import { LayoutReader } from './dxf-layouts';
import { decodeUnicodeEscapes, textStyleFromGroups, textStylesMeta, withTextStyle, type TextStyle } from './encoding';
import { ImportReportBuilder, geometryProblem, withImportData, type RawDxfEntity } from './import-report';
import { ANNO_APP, DIMSTYLE_APP, TABLE_APP, isPointerCode } from './dxf/codes';
import { tokenize, objects, num, has, str, pt, xdata, type Pair, type Obj } from './dxf/groups';
import { dimStyleFromHeader, readDimStyleRecord } from './dxf/dimstyles';
import { commonProps, reportObj, type ReadContext } from './dxf/read-core';
import { readEntityObj } from './dxf/read-entities';
export { DIMSTYLE_APP, TABLE_APP } from './dxf/codes';
export { DxfReadError } from './dxf/groups';
export { writeDxf } from './dxf/writer';
export { insertScales, insertScaleFields } from './dxf/read-entities';

export interface DxfReadOptions {
  /** Path of the file being read (Filename fields). */
  filePath?: string | null;
  /** Extra values for field evaluation (drawing properties, current date ...). */
  fieldContext?: FieldContext;
  /** Receives remarks about content that was simplified. */
  notes?: string[];
  /**
   * Open what is readable of a file that ends early (see DxfReadError.truncated): the drawing
   * is marked as recovered in its import report.
   */
  recover?: boolean;
}

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
/**
 * Applications whose extended data is not reported when it is left out: the reader's own, and
 * AutoCAD's internal ones (ACAD, ACAD_MATERIAL_MAPPER, AcadAnnotative ...) that carry no drawing content.
 */
const isQuietXdataApp = (app: string): boolean => app === DIMSTYLE_APP || app === TABLE_APP || /^acad/i.test(app);

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
function readEntities(objs: Obj[], ctx: ReadContext, keepRaw = false): Entity[] {
  const out: Entity[] = [];
  /** A converted entity: validated (invalid geometry is rejected), extrusion applied, XDATA loss reported. */
  const accept = (o: Obj, e: Entity | null): Entity | null => {
    if (!e) return null;
    let extrusion = false;
    let xdataApps = false;
    for (const p of o.groups) {
      if (p.code === 210 || p.code === 220 || p.code === 230) extrusion = true;
      else if (p.code === 1001) xdataApps = true;
    }
    const placed = extrusion ? applyExtrusion(o, e, ctx) : e;
    const bad = geometryProblem(placed);
    if (bad) {
      reportObj(ctx, o, 'dropped', `invalid geometry: ${bad}`);
      return null;
    }
    if (ctx.report && xdataApps) {
      const apps = [...new Set(o.groups.filter((x) => x.code === 1001 && !isQuietXdataApp(x.value.trim())).map((x) => x.value.trim()))];
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
      const poly = accept(o, {
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
    const read = readEntityObj(o, ctx);
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

/**
 * Read a DXF file. Damaged files throw a DxfReadError (a file that ends early is `truncated`;
 * pass `recover: true` to open what was readable). Objects that are dropped, simplified or
 * kept without being shown are listed in the drawing's import report (`meta.importReport`,
 * see io/import-report.ts); unknown model-space entities that can be kept safely are retained
 * as raw records (`meta.dxfRawEntities`) and written back by writeDxf.
 */
export function readDxf(text: string, opts: DxfReadOptions = {}): DrawingState {
  const dimStyles = new Map<string, DimStyle>();
  const report = new ImportReportBuilder();
  const raw: RawDxfEntity[] = [];
  const state = withDimStylesMeta(readDxfState(text, opts, dimStyles, report, raw), dimStyles);
  return withImportData(state, report.empty ? null : report.build('DXF', opts.filePath), raw);
}

/**
 * Named dimension styles (the DIMSTYLE records read) into `meta.dimStyles`, keyed by name as
 * core/dimension keeps them; a plain Standard record is implied and not stored.
 */
function withDimStylesMeta(state: DrawingState, dimStyles: ReadonlyMap<string, DimStyle>): DrawingState {
  const named = [...dimStyles.values()].filter((d) => !(d.name.toUpperCase() === 'STANDARD' && diffDimStyles(d, STANDARD_DIMSTYLE).length === 0));
  if (!named.length) return state;
  return { ...state, meta: { ...(state.meta ?? {}), [DIMSTYLES_META_KEY]: Object.fromEntries(named.map((d) => [d.name, d])) } };
}

/** The reader proper; DIMSTYLE records are collected into `dimStyles`. */
function readDxfState(text: string, opts: DxfReadOptions, dimStyles: Map<string, DimStyle>, report: ImportReportBuilder, raw: RawDxfEntity[]): DrawingState {
  const pairs = tokenize(decodeUnicodeEscapes(text), opts.recover, report);
  const textStyles: Record<string, TextStyle> = {};
  const layers: Layer[] = [];
  const blocks: Record<string, BlockDef> = {};
  let entities: Entity[] = [];
  let currentLayer = '0';
  const headerVars = new Map<string, Pair[]>();
  const linetypes: Linetype[] = [];
  const views: NamedView[] = [];
  // Header DIM* variables define the current style; the DIMSTYLE table gives named styles.
  const ctx: ReadContext = {
    dimStyles,
    dimStyle: STANDARD_DIMSTYLE,
    blocks,
    fields: { ...opts.fieldContext, ...(opts.filePath !== undefined ? { filePath: opts.filePath } : {}) },
    pendingImages: new Map(),
    consumedBlocks: new Set(),
    notes: opts.notes ?? [],
    report,
    raw,
  };
  const imageDefs = new Map<string, string>();
  const layoutReader = new LayoutReader(report);

  // find sections
  let i = 0;
  while (i < pairs.length) {
    const p = pairs[i]!;
    if (p.code === 0 && p.value === 'SECTION') {
      const name = pairs[i + 1]?.value ?? '';
      let j = i + 2;
      while (j < pairs.length && !(pairs[j]!.code === 0 && pairs[j]!.value === 'ENDSEC')) j += 1;
      const objs = objects(pairs, i + 2, j);
      if (name === 'HEADER') {
        let cur: Pair[] | null = null;
        for (let k = i + 2; k < j; k += 1) {
          const q = pairs[k]!;
          if (q.code === 9) {
            cur = [];
            headerVars.set(q.value, cur);
          } else cur?.push(q);
        }
        currentLayer = headerVars.get('$CLAYER')?.[0]?.value ?? '0';
        const hnum = (v: string, dflt: number) => {
          const raw = headerVars.get(v)?.[0]?.value;
          const n = raw === undefined ? NaN : parseFloat(raw);
          return Number.isFinite(n) ? n : dflt;
        };
        ctx.dimStyle = dimStyleFromHeader(headerVars, STANDARD_DIMSTYLE);
        const created = julianToDate(hnum('$TDCREATE', NaN));
        const saved = julianToDate(hnum('$TDUPDATE', NaN));
        ctx.fields = { ...(created ? { createDate: created } : {}), ...(saved ? { saveDate: saved } : {}), ...ctx.fields };
      } else if (name === 'OBJECTS') {
        for (const o of objs) if (o.kind === 'IMAGEDEF' && has(o, 5)) imageDefs.set(str(o, 5).toUpperCase(), str(o, 1));
        layoutReader.scanObjects(objs);
        // Named object groups (GROUP command) are not modelled: the objects stay, the grouping goes.
        for (const o of objs) {
          if (o.kind !== 'GROUP') continue;
          const desc = str(o, 300);
          report.add({ type: 'GROUP', action: 'dropped', reason: `object group${desc ? ` "${desc}"` : ''} is not kept (its objects are)`, ...(has(o, 5) ? { handle: str(o, 5) } : {}), ...(o.line ? { line: o.line } : {}) });
        }
      } else if (name === 'TABLES') {
        layoutReader.scanTables(objs);
        for (const o of objs) {
          if (o.kind === 'LAYER') {
            const name2 = str(o, 2);
            if (!name2) continue;
            const c = Math.trunc(num(o, 62, 7));
            const flags = Math.trunc(num(o, 70));
            const lt = str(o, 6);
            const tc = has(o, 420) ? Math.trunc(num(o, 420)) : NaN;
            layers.push({
              ...(Number.isFinite(tc) ? { trueColor: tc & 0xffffff } : {}),
              name: name2,
              color: Math.abs(c) || 7,
              visible: c >= 0 && (flags & 1) === 0, // negative colour = off, flag 1 = frozen
              frozen: (flags & 1) === 1 || undefined,
              locked: (flags & 4) === 4,
              // 370: hundredths of a millimetre; -3 (Default) and the entity-only -1 / -2 mean the default 0.25 mm.
              lineWeight: num(o, 370, 25) >= 0 ? num(o, 370, 25) / 100 : 0.25,
              ...(has(o, 290) && num(o, 290) === 0 ? { plot: false } : {}),
              linetype: lt && lt.toUpperCase() !== 'CONTINUOUS' ? lt : undefined,
            });
          } else if (o.kind === 'LTYPE') {
            const ltName = str(o, 2);
            if (!ltName || /^(BYLAYER|BYBLOCK|CONTINUOUS)$/i.test(ltName)) continue;
            const pattern = o.groups.filter((x) => x.code === 49).map((x) => parseFloat(x.value)).filter((v) => Number.isFinite(v));
            const std = findLinetype(ltName);
            if (std && std.pattern.length === pattern.length && std.pattern.every((v, k) => Math.abs(v - pattern[k]!) < 1e-9)) continue;
            linetypes.push({ name: ltName, description: str(o, 3), pattern });
          } else if (o.kind === 'DIMSTYLE') {
            const ds = readDimStyleRecord(o, objs);
            dimStyles.set(ds.name.toUpperCase(), ds);
          } else if (o.kind === 'STYLE') {
            const ts = textStyleFromGroups(o.groups);
            if (ts) textStyles[ts.name] = ts;
          } else if (o.kind === 'VIEW') {
            const vname = str(o, 2);
            if (vname) views.push({ name: vname, center: pt(o, 10), height: num(o, 40, 10) || 10 });
          }
        }
        // The current style: header variables over the named record of the same name.
        const current = dimStyles.get(String(headerVars.get('$DIMSTYLE')?.[0]?.value ?? 'Standard').toUpperCase());
        if (current) ctx.dimStyle = dimStyleFromHeader(headerVars, current);
      } else if (name === 'BLOCKS') {
        let k = 0;
        while (k < objs.length) {
          const o = objs[k]!;
          if (o.kind !== 'BLOCK') {
            k += 1;
            continue;
          }
          let m = k + 1;
          while (m < objs.length && objs[m]!.kind !== 'ENDBLK') m += 1;
          const inner = objs.slice(k + 1, m);
          const attributes: AttributeDefExt[] = inner
            .filter((x) => x.kind === 'ATTDEF')
            .map((x) => {
              const h = num(x, 72, 0);
              const align: 'left' | 'center' | 'right' = h === 1 || h === 4 ? 'center' : h === 2 ? 'right' : 'left';
              const useAlignPt = h !== 0 && has(x, 11);
              const rotation = g.rad(num(x, 50, 0));
              return {
                tag: str(x, 2),
                prompt: str(x, 3),
                default: str(x, 1),
                position: useAlignPt ? { x: num(x, 11), y: num(x, 21) } : { x: num(x, 10), y: num(x, 20) },
                height: num(x, 40, 0.125),
                align,
                invisible: (Math.trunc(num(x, 70)) & 1) === 1,
                // constant / verify / preset (bits 2, 4, 8)
                ...attdefFlagProps(Math.trunc(num(x, 70))),
                ...(Math.abs(rotation) > 1e-9 ? { rotation } : {}),
              };
            });
          const bname = str(o, 2);
          const anonymousLayout = /^\*(MODEL_SPACE|PAPER_SPACE)/i.test(bname);
          const dimensionPicture = /^\*D\d*$/i.test(bname);
          if (bname && !anonymousLayout && !dimensionPicture) {
            ctx.where = `block "${bname}"`;
            blocks[bname] = {
              name: bname,
              basePoint: { x: num(o, 10), y: num(o, 20) },
              entities: readEntities(
                inner.filter((x) => x.kind !== 'ATTDEF'),
                ctx,
              ),
              attributes,
              description: str(o, 4) || undefined,
              ...((Math.trunc(num(o, 70)) & 4) === 4 ? { xref: { path: str(o, 1), ...((Math.trunc(num(o, 70)) & 8) === 8 ? { overlay: true } : {}) } } : {}),
            };
          }
          else if (anonymousLayout) layoutReader.layoutBlock(bname, inner);
          ctx.where = undefined;
          k = m + 1;
        }
      } else if (name === 'ENTITIES') {
        ctx.where = 'model space';
        entities = readEntities(layoutReader.splitEntities(objs), ctx, true);
        ctx.where = undefined;
      }
      i = j + 1;
    } else i += 1;
  }

  // IMAGE paths come from the IMAGEDEF objects, read last.
  if (ctx.pendingImages?.size) {
    const resolve = (list: readonly Entity[]): Entity[] =>
      list.map((e) => {
        if (e.type !== 'image') return e;
        const h = ctx.pendingImages!.get(e);
        return h !== undefined ? { ...e, path: imageDefs.get(h) ?? e.path } : e;
      });
    entities = resolve(entities);
    for (const [k, b] of Object.entries(blocks)) if (b.entities.some((e) => e.type === 'image')) blocks[k] = { ...b, entities: resolve(b.entities) };
  }
  // Anonymous blocks that drew a table now read as a native table are no longer needed.
  if (ctx.consumedBlocks?.size) {
    const used = new Set<string>();
    const scanInserts = (list: readonly Entity[]) => {
      for (const e of list) if (e.type === 'insert') used.add(e.block);
    };
    scanInserts(entities);
    for (const b of Object.values(blocks)) scanInserts(b.entities);
    for (const n of ctx.consumedBlocks) if (!used.has(n)) delete blocks[n];
  }

  const layerNames = new Set(layers.map((l) => l.name));
  // Ensure every referenced layer exists.
  const ensure = (name: string) => {
    if (!layerNames.has(name)) {
      layerNames.add(name);
      const dflt = DEFAULT_LAYERS.find((l) => l.name === name);
      layers.push(dflt ?? { name, color: 7, visible: true, locked: false, lineWeight: 0.25 });
    }
  };
  ensure('0');
  for (const e of entities) ensure(e.layer);
  for (const b of Object.values(blocks)) for (const e of b.entities) ensure(e.layer);
  for (const r of raw) ensure(r.layer);
  ensure(currentLayer);

  const hnum = (v: string, dflt: number) => {
    const raw = headerVars.get(v)?.[0]?.value;
    const n = raw === undefined ? NaN : parseFloat(raw);
    return Number.isFinite(n) ? n : dflt;
  };
  const hpt = (v: string, dflt: g.Point): g.Point => {
    const grp = headerVars.get(v);
    if (!grp) return dflt;
    const x = grp.find((q) => q.code === 10);
    const y = grp.find((q) => q.code === 20);
    return x && y ? { x: parseFloat(x.value), y: parseFloat(y.value) } : dflt;
  };
  const lunits = Math.trunc(hnum('$LUNITS', DEFAULT_HEADER.units.lunits));
  const celweightRaw = Math.trunc(hnum('$CELWEIGHT', -1));
  const celtype = headerVars.get('$CELTYPE')?.[0]?.value || 'ByLayer';
  const header: DrawingHeader = {
    units: {
      lunits: (lunits >= 1 && lunits <= 5 ? lunits : 2) as LinearUnits,
      luprec: Math.max(0, Math.trunc(hnum('$LUPREC', DEFAULT_HEADER.units.luprec))),
      insunits: Math.trunc(hnum('$INSUNITS', DEFAULT_HEADER.units.insunits)),
      auprec: Math.max(0, Math.trunc(hnum('$AUPREC', 0))),
    },
    ltscale: hnum('$LTSCALE', 1) || 1,
    limits: { min: hpt('$LIMMIN', DEFAULT_HEADER.limits.min), max: hpt('$LIMMAX', DEFAULT_HEADER.limits.max) },
    pdmode: Math.trunc(hnum('$PDMODE', 0)),
    pdsize: hnum('$PDSIZE', 0),
    // Header DIM* variables over the named record of the current style.
    dimStyle: ctx.dimStyle,
    linetypes,
    views,
    celtype: /^BYLAYER$/i.test(celtype) ? 'ByLayer' : celtype,
    celweight: celweightRaw >= 0 ? celweightRaw / 100 : undefined,
    // A scale name ("1:4", "1/8\" = 1'-0\""): printable, short and without markup characters, or it is ignored.
    ...(isScaleName(headerVars.get('$CANNOSCALE')?.[0]?.value) ? { cannoscale: headerVars.get('$CANNOSCALE')![0]!.value } : {}),
    ...(hnum('$ANNOALLVISIBLE', 1) === 0 ? { annoAllVisible: false } : {}),
  };

  // Paper space: layouts with their entities and viewports (and the layers they use).
  const layouts = layoutReader.build((objs, where) => {
    ctx.where = where;
    const list = readEntities(objs, ctx);
    ctx.where = undefined;
    return list;
  }, { entities, header });
  for (const l of layouts ?? []) {
    for (const e of l.entities) ensure(e.layer);
    for (const v of l.viewports) ensure(v.layer);
  }
  const styleMeta = textStylesMeta(textStyles);
  return { entities, layers, blocks, currentLayer, header, ...(styleMeta ? { meta: styleMeta } : {}), ...(layouts ? { layouts } : {}) };
}
