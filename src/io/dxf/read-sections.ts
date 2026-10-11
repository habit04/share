/**
 * The section readers, one per DXF section: HEADER ($ variables, the current dimension style,
 * the drawing dates and the DrawingHeader built from them), TABLES (LAYER, LTYPE, DIMSTYLE, STYLE,
 * VIEW), BLOCKS (block definitions with their ATTDEFs), ENTITIES (model space) and OBJECTS
 * (IMAGEDEF paths, layouts, object groups). reader.ts walks the sections in file order and calls
 * these; paper-space content goes to the layout reader (io/dxf-layouts.ts) on the way.
 */
import type { Entity, BlockDef, Layer, DimStyle } from '../../core/entities';
import { STANDARD_DIMSTYLE } from '../../core/dimension';
import { julianToDate } from '../../core/fields';
import { DEFAULT_HEADER, type DrawingHeader, type NamedView } from '../../core/document';
import { findLinetype, type Linetype } from '../../core/linetypes';
import type { LinearUnits } from '../../core/units';
import * as g from '../../core/geometry';
import { attdefFlagProps, type AttributeDefExt } from '../../electrical/symbol-builder-core';
import { isScaleName } from '../../core/layouts';
import type { LayoutReader } from '../dxf-layouts';
import { textStyleFromGroups, type TextStyle } from '../encoding';
import type { ImportReportBuilder } from '../import-report';
import { num, has, str, pt, type Pair, type Obj } from './groups';
import { dimStyleFromHeader, readDimStyleRecord } from './dimstyles';
import type { ReadContext } from './read-core';
import { readEntities } from './read-pass';

/**
 * HEADER (the pairs from..to): its $ variables into `headerVars`, the current dimension style and
 * the drawing dates (date fields) into the context. Returns the current layer ($CLAYER).
 */
export function readHeaderSection(pairs: Pair[], from: number, to: number, headerVars: Map<string, Pair[]>, ctx: ReadContext): string {
  let cur: Pair[] | null = null;
  for (let k = from; k < to; k += 1) {
    const q = pairs[k]!;
    if (q.code === 9) {
      cur = [];
      headerVars.set(q.value, cur);
    } else cur?.push(q);
  }
  const currentLayer = headerVars.get('$CLAYER')?.[0]?.value ?? '0';
  const hnum = (v: string, dflt: number) => {
    const raw = headerVars.get(v)?.[0]?.value;
    const n = raw === undefined ? NaN : parseFloat(raw);
    return Number.isFinite(n) ? n : dflt;
  };
  ctx.dimStyle = dimStyleFromHeader(headerVars, STANDARD_DIMSTYLE);
  const created = julianToDate(hnum('$TDCREATE', NaN));
  const saved = julianToDate(hnum('$TDUPDATE', NaN));
  ctx.fields = { ...(created ? { createDate: created } : {}), ...(saved ? { saveDate: saved } : {}), ...ctx.fields };
  return currentLayer;
}

/**
 * The drawing header from the HEADER variables (units, limits, LTSCALE, PDMODE / PDSIZE, CELTYPE /
 * CELWEIGHT, annotation scale) with the current dimension style and the LTYPE / VIEW records.
 */
export function drawingHeader(headerVars: ReadonlyMap<string, Pair[]>, dimStyle: DimStyle, linetypes: Linetype[], views: NamedView[]): DrawingHeader {
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
    dimStyle,
    linetypes,
    views,
    celtype: /^BYLAYER$/i.test(celtype) ? 'ByLayer' : celtype,
    celweight: celweightRaw >= 0 ? celweightRaw / 100 : undefined,
    // A scale name ("1:4", "1/8\" = 1'-0\""): printable, short and without markup characters, or it is ignored.
    ...(isScaleName(headerVars.get('$CANNOSCALE')?.[0]?.value) ? { cannoscale: headerVars.get('$CANNOSCALE')![0]!.value } : {}),
    ...(hnum('$ANNOALLVISIBLE', 1) === 0 ? { annoAllVisible: false } : {}),
  };
  return header;
}

/** What the TABLES section adds to the drawing besides the dimension styles. */
export interface TableRecords {
  layers: Layer[];
  linetypes: Linetype[];
  views: NamedView[];
  textStyles: Record<string, TextStyle>;
}

/**
 * TABLES: LAYER, LTYPE (patterns other than the standard ones), DIMSTYLE (into `dimStyles`),
 * STYLE and VIEW records; the current dimension style is the header variables over the named
 * record of the same name. BLOCK_RECORD and LAYER handles go to the layout reader.
 */
export function readTablesSection(objs: Obj[], tables: TableRecords, dimStyles: Map<string, DimStyle>, headerVars: ReadonlyMap<string, Pair[]>, ctx: ReadContext, layoutReader: LayoutReader): void {
  const { layers, linetypes, views, textStyles } = tables;
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
}

/**
 * BLOCKS: block definitions (entities, ATTDEFs, external references) into `blocks`; the
 * *Model_Space / *Paper_Space blocks go to the layout reader and *D dimension pictures are left out.
 */
export function readBlocksSection(objs: Obj[], blocks: Record<string, BlockDef>, ctx: ReadContext, layoutReader: LayoutReader): void {
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
}

/** ENTITIES: the model-space entities (paper-space ones go to the layout reader). */
export function readEntitiesSection(objs: Obj[], ctx: ReadContext, layoutReader: LayoutReader): Entity[] {
  ctx.where = 'model space';
  const entities = readEntities(layoutReader.splitEntities(objs), ctx, true);
  ctx.where = undefined;
  return entities;
}

/** OBJECTS: IMAGEDEF file names (by handle) into `imageDefs` and the LAYOUT objects to the layout reader; object groups are reported. */
export function readObjectsSection(objs: Obj[], imageDefs: Map<string, string>, layoutReader: LayoutReader, report: ImportReportBuilder): void {
  for (const o of objs) if (o.kind === 'IMAGEDEF' && has(o, 5)) imageDefs.set(str(o, 5).toUpperCase(), str(o, 1));
  layoutReader.scanObjects(objs);
  // Named object groups (GROUP command) are not modelled: the objects stay, the grouping goes.
  for (const o of objs) {
    if (o.kind !== 'GROUP') continue;
    const desc = str(o, 300);
    report.add({ type: 'GROUP', action: 'dropped', reason: `object group${desc ? ` "${desc}"` : ''} is not kept (its objects are)`, ...(has(o, 5) ? { handle: str(o, 5) } : {}), ...(o.line ? { line: o.line } : {}) });
  }
}
