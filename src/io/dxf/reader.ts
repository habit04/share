/**
 * readDxf: a DXF file into a drawing. The sections are read in file order (HEADER, TABLES,
 * BLOCKS, ENTITIES, OBJECTS); IMAGE paths, tables read from anonymous blocks, the layers every
 * entity refers to, the header and paper space (io/dxf-layouts.ts) are settled at the end.
 */
import type { Entity, BlockDef, Layer, DimStyle } from '../../core/entities';
import { STANDARD_DIMSTYLE, DIMSTYLES_META_KEY, diffDimStyles } from '../../core/dimension';
import { julianToDate, type FieldContext } from '../../core/fields';
import { DEFAULT_LAYERS, DEFAULT_HEADER, type DrawingState, type DrawingHeader, type NamedView } from '../../core/document';
import { findLinetype, type Linetype } from '../../core/linetypes';
import type { LinearUnits } from '../../core/units';
import * as g from '../../core/geometry';
import { attdefFlagProps, type AttributeDefExt } from '../../electrical/symbol-builder-core';
import { isScaleName } from '../../core/layouts';
// Track E: paper space (layouts, VIEWPORT entities, LAYOUT objects) lives in dxf-layouts.ts.
import { LayoutReader } from '../dxf-layouts';
import { decodeUnicodeEscapes, textStyleFromGroups, textStylesMeta, type TextStyle } from '../encoding';
import { ImportReportBuilder, withImportData, type RawDxfEntity } from '../import-report';
import { tokenize, objects, num, has, str, pt, type Pair } from './groups';
import { dimStyleFromHeader, readDimStyleRecord } from './dimstyles';
import type { ReadContext } from './read-core';
import { readEntities } from './read-pass';

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
