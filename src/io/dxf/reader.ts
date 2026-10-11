/**
 * readDxf: a DXF file into a drawing. The sections are read in file order (HEADER, TABLES,
 * BLOCKS, ENTITIES, OBJECTS); IMAGE paths, tables read from anonymous blocks, the layers every
 * entity refers to, the header and paper space (io/dxf-layouts.ts) are settled at the end.
 */
import type { Entity, BlockDef, Layer, DimStyle } from '../../core/entities';
import { STANDARD_DIMSTYLE, DIMSTYLES_META_KEY, diffDimStyles } from '../../core/dimension';
import type { FieldContext } from '../../core/fields';
import { DEFAULT_LAYERS, type DrawingState, type NamedView } from '../../core/document';
import type { Linetype } from '../../core/linetypes';
// Track E: paper space (layouts, VIEWPORT entities, LAYOUT objects) lives in dxf-layouts.ts.
import { LayoutReader } from '../dxf-layouts';
import { decodeUnicodeEscapes, textStylesMeta, type TextStyle } from '../encoding';
import { ImportReportBuilder, reportBlockExpansion, withImportData, type RawDxfEntity } from '../import-report';
import { tokenize, objects, has, str, type Pair } from './groups';
import type { ReadContext } from './read-core';
import { readEntities } from './read-pass';
import { readTableStyle, type TableStyleData } from './read-annotations';
import { readHeaderSection, drawingHeader, readTablesSection, readBlocksSection, readEntitiesSection, readObjectsSection } from './read-sections';

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

/**
 * The TABLESTYLE objects of the OBJECTS section, by upper-case handle: they come after the tables
 * that use them, so they are read first.
 */
function tableStylesOf(pairs: readonly Pair[]): Map<string, TableStyleData> {
  const out = new Map<string, TableStyleData>();
  for (let i = 0; i + 1 < pairs.length; i += 1) {
    if (pairs[i]!.code !== 0 || pairs[i]!.value !== 'SECTION' || pairs[i + 1]!.value !== 'OBJECTS') continue;
    let j = i + 2;
    while (j < pairs.length && !(pairs[j]!.code === 0 && pairs[j]!.value === 'ENDSEC')) j += 1;
    for (const o of objects(pairs as Pair[], i + 2, j)) if (o.kind === 'TABLESTYLE' && has(o, 5)) out.set(str(o, 5).toUpperCase(), readTableStyle(o));
    i = j;
  }
  return out;
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
    textStyleHandles: new Map(),
    tableStyles: tableStylesOf(pairs),
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
        currentLayer = readHeaderSection(pairs, i + 2, j, headerVars, ctx);
      } else if (name === 'OBJECTS') {
        readObjectsSection(objs, imageDefs, layoutReader, report);
      } else if (name === 'TABLES') {
        readTablesSection(objs, { layers, linetypes, views, textStyles }, dimStyles, headerVars, ctx, layoutReader);
      } else if (name === 'BLOCKS') {
        readBlocksSection(objs, blocks, ctx, layoutReader);
      } else if (name === 'ENTITIES') {
        entities = readEntitiesSection(objs, ctx, layoutReader);
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

  const header = drawingHeader(headerVars, ctx.dimStyle, linetypes, views);

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
  // Blocks that insert themselves or multiply into millions of objects (E-13).
  reportBlockExpansion(report, blocks, [...entities, ...(layouts ?? []).flatMap((l) => l.entities)]);
  const styleMeta = textStylesMeta(textStyles);
  return { entities, layers, blocks, currentLayer, header, ...(styleMeta ? { meta: styleMeta } : {}), ...(layouts ? { layouts } : {}) };
}
