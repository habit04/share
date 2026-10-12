/**
 * readDxf: a DXF file into a drawing. The sections are read in file order (HEADER, TABLES,
 * BLOCKS, ENTITIES, OBJECTS); tables read from anonymous blocks, the layers every entity refers
 * to, the header, paper space (io/dxf-layouts.ts) and then the IMAGE paths are settled at the end.
 */
import type { FieldContext } from '../../core/fields';
import type { DrawingState, NamedView } from '../../core/document';
import type { DimStyle, Layer, BlockDef, Entity } from '../../core/entities';
import { ImportReportBuilder, reportBlockExpansion, withImportData } from '../import-report';
import type { RawDxfEntity } from '../import-report';
import { diffDimStyles, STANDARD_DIMSTYLE, DIMSTYLES_META_KEY } from '../../core/dimension';
import { DxfReadError, tokenize, objects, has, str } from './groups';
import { decodeUnicodeEscapes, textStyleOf, textStylesMeta } from '../encoding';
import type { TextStyle } from '../encoding';
import type { Pair } from './groups';
import type { Linetype } from '../../core/linetypes';
import type { ReadContext } from './read-core';
import { LayoutReader } from '../dxf-layouts';
import { readTableStyle, type TableStyleData } from './read-annotations';
import { readHeaderSection, readObjectsSection, readTablesSection, readBlocksSection, readEntitiesSection, drawingHeader } from './read-sections';
import { DEFAULT_LAYERS } from '../../core/document';
import { readEntities } from './read-pass';

export interface DxfReadOptions {
  /** Allocation budgets; callers may lower them for untrusted or constrained imports. */
  maxSourceLength?: number;
  maxStringLength?: number;
  maxPairs?: number;
  maxRecords?: number;
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
  if (text.length > (opts.maxSourceLength ?? 128 * 1024 * 1024)) throw new DxfReadError('DXF exceeds the source text size limit.', 1);
  const pairs = tokenize(decodeUnicodeEscapes(text), opts.recover, report, opts);
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
  const ensureEntityLayers = (e: Entity) => { ensure(e.layer); if (e.type === 'leader' && e.textLayer) ensure(e.textLayer); };
  ensure('0');
  for (const e of entities) ensureEntityLayers(e);
  for (const b of Object.values(blocks)) for (const e of b.entities) ensureEntityLayers(e);
  for (const r of raw) ensure(r.layer);
  ensure(currentLayer);

  const header = drawingHeader(headerVars, ctx.dimStyle, linetypes, views);

  // Paper space: layouts with their entities and viewports (and the layers they use).
  let layouts = layoutReader.build((objs, where) => {
    ctx.where = where;
    const list = readEntities(objs, ctx);
    ctx.where = undefined;
    return list;
  }, { entities, header });
  // Resolve after every space has been read, by stable id (extrusion transforms may copy an entity).
  if (ctx.pendingImages?.size) {
    const resolve = (list: readonly Entity[]): Entity[] => list.map((e) => {
      if (e.type !== 'image') return e;
      const handle = ctx.pendingImages!.get(e.id);
      const path = handle ? imageDefs.get(handle) : undefined;
      if (!path) report.add({ type: 'IMAGE', action: 'simplified', layer: e.layer, reason: `IMAGEDEF ${handle || '(missing)'} has no file path; only the image frame is kept` });
      return path !== undefined ? { ...e, path } : e;
    });
    entities = resolve(entities);
    for (const [key, block] of Object.entries(blocks)) blocks[key] = { ...block, entities: resolve(block.entities) };
    layouts = layouts?.map((l) => ({ ...l, entities: resolve(l.entities) }));
  }
  for (const l of layouts ?? []) {
    for (const e of l.entities) ensureEntityLayers(e);
    for (const v of l.viewports) ensure(v.layer);
  }
  reportBlockExpansion(report, blocks, [...entities, ...(layouts ?? []).flatMap((l) => l.entities)]);
  const styleNames = new Set(['STANDARD', ...Object.keys(textStyles).map((name) => name.toUpperCase())]);
  const referencedStyles = [...entities, ...Object.values(blocks).flatMap((b) => b.entities), ...(layouts ?? []).flatMap((l) => l.entities)];
  for (const entity of referencedStyles) {
    const name = entity.type === 'dimension' ? entity.style.textStyle : textStyleOf(entity);
    if (name && !styleNames.has(name.toUpperCase())) { report.add({ type: 'STYLE', action: 'unsupported', reason: `referenced text style "${name}" has no STYLE definition; its name is kept with a default stroke-font substitute`, layer: entity.layer }); styleNames.add(name.toUpperCase()); }
  }
  const styleMeta = textStylesMeta(textStyles);
  return { entities, layers, blocks, currentLayer, header, ...(styleMeta ? { meta: styleMeta } : {}), ...(layouts ? { layouts } : {}) };
}
