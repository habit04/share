/**
 * readDxf: a DXF file into a drawing. The sections are read in file order (HEADER, TABLES,
 * BLOCKS, ENTITIES, OBJECTS); tables read from anonymous blocks, the layers every entity refers
 * to, the header, paper space (io/dxf-layouts.ts), the IMAGE paths and the experimental 3D solids
 * (io/dxf/mesh3d-read.ts) are settled at the end.
 */
import type { FieldContext } from '../../core/fields';
import type { DrawingState, NamedView } from '../../core/document';
import type { DimStyle, Layer, BlockDef, Entity } from '../../core/entities';
import { entityTypeName } from '../../core/entities';
import { validateUnderlayDefinitions, type UnderlayDefinition } from '../../core/underlay';
import { ImportReportBuilder, reportBlockExpansion, rawEntitiesOf, withImportData } from '../import-report';
import { recoverOversizedReferences } from '../import-recovery';
import type { RawDxfEntity } from '../import-report';
import { diffDimStyles, STANDARD_DIMSTYLE, DIMSTYLES_META_KEY } from '../../core/dimension';
import { DxfReadError, tokenize, objects, has, str, num, isIntegerText } from './groups';
import { decodeUnicodeEscapes, textStyleOf, textStylesMeta, shapeStylesMeta } from '../encoding';
import type { TextStyle } from '../encoding';
import type { Obj, Pair } from './groups';
import type { Linetype, LinetypeShapeStyle } from '../../core/linetypes';
import type { ReadContext } from './read-core';
import { LayoutReader } from '../dxf-layouts';
import { readTableStyle, type TableStyleData } from './read-annotations';
import { readHeaderSection, readObjectsSection, readTablesSection, readBlocksSection, readEntitiesSection, drawingHeader } from './read-sections';
import { decodeConstraints, CONSTRAINTS_REPORT, CONSTRAINTS_RETAINED_REPORT } from './constraints-data';
import { decodeDynamicInstance } from './dynamic-data';
import type { ConstraintSet } from '../../core/constraints/model';
import { DEFAULT_LAYERS } from '../../core/document';
import { completeDeferredAttribFold, hasDeferredAttribFold, readEntities } from './read-pass';
import { reportObj } from './read-core';
import { attachDxfCadGraph } from '../cad-graph-dxf';
import { CadGraphError, canonicalCadHandle } from '../../core/cad-graph';
import { Model3DReader, native3dObject } from './mesh3d-read';
import { EMPTY_MODEL3D } from '../../model3d/model';
import { STANDARD_MLEADER_STYLE, type MLeaderStyleRetained } from '../../core/multileader';
import { DXF_READ_LIMITS } from '../../model3d/file-format';

export interface DxfReadOptions {
  /** Internal interchange check: every original source record; defer geometry recovery until the DWG identity join. */
  recordInventory?: (handle: string, type: string, tableName?: string) => void;
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
  /**
   * The experimental 3D setting is on: model-space polyface meshes from other programs become
   * mesh solids (`DrawingState.model3d`) instead of being dropped. Polyfaces JCad wrote (with
   * `JCAD_3D` data) are read either way; see io/dxf/mesh3d-read.ts.
   */
  model3d?: boolean;
}

/**
 * Read a DXF file. Damaged files throw a DxfReadError (a file that ends early is `truncated`;
 * pass `recover: true` to open what was readable). Objects that are dropped, simplified or
 * kept without being shown are listed in the drawing's import report (`meta.importReport`,
 * see io/import-report.ts); unknown model-space entities that can be kept safely are retained
 * as raw records (`meta.dxfRawEntities`) and written back by writeDxf.
 */
export function readDxf(text: string, opts: DxfReadOptions = {}): DrawingState {
  try {
    return readDxfImport(text, opts);
  } catch (error) {
    // Graph identities, dependencies and allocation limits are file input errors here.
    // They are not truncation: recovery must never skip unsafe retained metadata.
    if (error instanceof CadGraphError) throw new DxfReadError(error.message, 1);
    throw error;
  }
}

function readDxfImport(text: string, opts: DxfReadOptions): DrawingState {
  const dimStyles = new Map<string, DimStyle>();
  const report = new ImportReportBuilder();
  const raw: RawDxfEntity[] = [];
  const state = withImportData(withDimStylesMeta(readDxfState(text, opts, dimStyles, report, raw), dimStyles), null, raw);
  if (state.cadGraph) report.retainItems(
    item => ['HEADER', 'DIMSTYLE'].includes(item.type) && item.reason.includes('not modeled or written back')
      || item.type === 'LTYPE' && item.reason.startsWith('complex linetype'),
    item => item.type === 'LTYPE'
      ? 'Native complex linetype definitions and their style references are retained; the editor displays their dash pattern.'
      : item.reason.replace('not modeled or written back', 'retained as source metadata; these settings are not modeled by the editor'),
  );
  const retained3dHandles = new Set<string>();
  for (const node of state.cadGraph?.nodes ?? []) {
    if (!node.sourceHandle) continue;
    if (node.anchor?.kind === 'solid3d' || node.anchor?.kind === 'dimension3d') retained3dHandles.add(node.sourceHandle);
    else if (node.anchor?.kind === 'raw' && node.type === 'POLYLINE') {
      const object = native3dObject({ kind: node.type, groups: node.groups.map(([code, value]) => ({ code, value })) });
      const flags = num(object, 70);
      if (isIntegerText(str(object, 70).trim()) && flags >= 0 && flags <= 0xffff && (flags & 64)) retained3dHandles.add(node.sourceHandle);
    }
  }
  if (retained3dHandles.size) report.retainItems(item => !!item.handle && retained3dHandles.has(canonicalCadHandle(item.handle))
    && (item.action === 'dropped' || item.reason.includes('extended data (XDATA)') || item.reason.includes('true colour, colour book and transparency are not kept')),
  item => item.action === 'dropped' ? `Original 3D source records are retained without being displayed (${item.reason}). Unsafe placement, malformed structure or unsupported own payload regeneration refuses save explicitly.` : 'Unmodeled 3D source properties and application data are retained in the CAD graph; their effects may not be displayed.');
  // Partial opening (io/import-recovery.ts): exclude block references whose expansion alone
  // breaks the geometry budget, so the rest of the drawing opens and the report lists them.
  // A source-inventory read is an internal projection check: every original
  // identity must remain until the trusted DWG geometry and metadata are joined.
  // Ordinary DXF imports erase through the retained graph, including owned raw
  // records, so excluded objects cannot reappear on Save As.
  const opened = opts.recordInventory ? state : recoverOversizedReferences(state, (item) => {
    const changed = item.action === 'dropped' && item.handle ? report.dropItems(
      old => old.type === item.type && !!old.handle && /^[0-9A-Fa-f]{1,16}$/.test(old.handle.trim()) && /^[0-9A-Fa-f]{1,16}$/.test(item.handle!)
        && canonicalCadHandle(old.handle.trim()) === canonicalCadHandle(item.handle!),
      () => item.reason,
      item,
    ) : 0;
    if (!changed) report.add(item);
  }, (t) => report.note(t));
  return withImportData(opened, report.empty ? null : report.build('DXF', opts.filePath), rawEntitiesOf(opened));
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

/**
 * The MLEADERSTYLE names of the OBJECTS section, by upper-case style handle (P18):
 * a style's name is the dictionary key of the entry that points at the MLEADERSTYLE
 * object (the ACAD_MLEADERSTYLE dictionary chain), so it is resolved from the
 * dictionaries, not from the style object itself. OBJECTS comes last, read first.
 */
function mleaderStyleNamesOf(pairs: readonly Pair[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < pairs.length; i += 1) {
    if (pairs[i]!.code !== 0 || pairs[i]!.value !== 'SECTION' || pairs[i + 1]!.value !== 'OBJECTS') continue;
    let j = i + 2;
    while (j < pairs.length && !(pairs[j]!.code === 0 && pairs[j]!.value === 'ENDSEC')) j += 1;
    const objs = objects(pairs as Pair[], i + 2, j);
    const styleHandles = new Set(objs.filter((o) => o.kind === 'MLEADERSTYLE' && has(o, 5)).map((o) => str(o, 5).toUpperCase()));
    for (const o of objs) {
      if (o.kind !== 'DICTIONARY') continue;
      for (let k = 0; k + 1 < o.groups.length; k += 1) {
        if (o.groups[k]!.code === 3 && o.groups[k + 1]!.code === 350) {
          const target = o.groups[k + 1]!.value.toUpperCase();
          if (styleHandles.has(target)) out.set(target, o.groups[k]!.value);
        }
      }
    }
    i = j;
  }
  return out;
}

/**
 * The MLEADERSTYLE retained values of the OBJECTS section, by upper-case style handle
 * (P18, AMENDMENT-P18-S2-A — slice-1 acceptance must-fix V-1): the source values of the
 * style groups no entity-level field supplies (46, 47/49/140, 141, 271/272/273, 298).
 * Only groups whose values diverge from the specimen constants JCad synthesizes are
 * recorded, and a style that matches the constants in full records NO entry at all —
 * so authored data and slice-1 behaviour are untouched. Absent groups count as the
 * constant (that is the value AutoCAD applies for them).
 */
function mleaderStyleValuesOf(pairs: readonly Pair[]): Map<string, MLeaderStyleRetained> {
  const out = new Map<string, MLeaderStyleRetained>();
  const c = STANDARD_MLEADER_STYLE;
  for (let i = 0; i + 1 < pairs.length; i += 1) {
    if (pairs[i]!.code !== 0 || pairs[i]!.value !== 'SECTION' || pairs[i + 1]!.value !== 'OBJECTS') continue;
    let j = i + 2;
    while (j < pairs.length && !(pairs[j]!.code === 0 && pairs[j]!.value === 'ENDSEC')) j += 1;
    for (const o of objects(pairs as Pair[], i + 2, j)) {
      if (o.kind !== 'MLEADERSTYLE' || !has(o, 5)) continue;
      const val = (code: number): number | undefined => {
        const raw = o.groups.find((x) => x.code === code)?.value;
        if (raw === undefined) return undefined;
        const n = Number(raw);
        return Number.isFinite(n) ? n : undefined;
      };
      const retained: {
        alignSpace?: number;
        blockScale?: { x: number; y: number; z: number };
        blockRotation?: number;
        textAttachmentDirection?: number;
        bottomTextAttachmentDirection?: number;
        topTextAttachmentDirection?: number;
        flag298?: number;
      } = {};
      const alignSpace = val(46);
      if (alignSpace !== undefined && alignSpace !== c.alignSpace) retained.alignSpace = alignSpace;
      const sx = val(47), sy = val(49), sz = val(140);
      if ((sx !== undefined && sx !== c.blockScale.x) || (sy !== undefined && sy !== c.blockScale.y) || (sz !== undefined && sz !== c.blockScale.z)) {
        retained.blockScale = { x: sx ?? c.blockScale.x, y: sy ?? c.blockScale.y, z: sz ?? c.blockScale.z };
      }
      const blockRotation = val(141);
      if (blockRotation !== undefined && blockRotation !== c.blockRotation) retained.blockRotation = blockRotation;
      const tad = val(271);
      if (tad !== undefined && tad !== c.textAttachmentDirection) retained.textAttachmentDirection = tad;
      const btad = val(272);
      if (btad !== undefined && btad !== c.bottomTextAttachmentDirection) retained.bottomTextAttachmentDirection = btad;
      const ttad = val(273);
      if (ttad !== undefined && ttad !== c.topTextAttachmentDirection) retained.topTextAttachmentDirection = ttad;
      const flag298 = val(298);
      if (flag298 !== undefined && flag298 !== c.flag298) retained.flag298 = flag298;
      if (Object.keys(retained).length) out.set(str(o, 5).toUpperCase(), retained);
    }
    i = j;
  }
  return out;
}

/**
 * The BLOCK_RECORD names of the TABLES section, by upper-case record handle
 * (P18 slice 2, PROPOSAL-P18-S2 item (2)): a block-content MULTILEADER names its
 * block record by handle (CONTEXT_DATA 341 / trailing 344), and the name is the
 * record's group 2. TABLES precedes ENTITIES in the file but the map is built
 * from the raw pairs up front, like the other OBJECTS pre-scans.
 */
function blockRecordNamesOf(pairs: readonly Pair[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i + 1 < pairs.length; i += 1) {
    if (pairs[i]!.code !== 0 || pairs[i]!.value !== 'SECTION' || pairs[i + 1]!.value !== 'TABLES') continue;
    let j = i + 2;
    while (j < pairs.length && !(pairs[j]!.code === 0 && pairs[j]!.value === 'ENDSEC')) j += 1;
    for (const o of objects(pairs as Pair[], i + 2, j)) {
      if (o.kind === 'BLOCK_RECORD' && has(o, 5) && has(o, 2)) out.set(str(o, 5).toUpperCase(), str(o, 2));
    }
    i = j;
  }
  return out;
}

/**
 * The canonical handles of every HATCH record in the file (P17 round 6):
 * scanned from the BLOCKS and ENTITIES sections up front, like the other
 * pre-scans, so the set covers hatches in any space or block definition
 * and HATCH records no entity list models (retained raw records). A
 * boundary handle in this set names a hatch wherever the hatch lives;
 * keys are canonical (canonicalCadHandle), so a spelling like 00050
 * matches the hatch whose handle is 50.
 */
function hatchHandlesOf(pairs: readonly Pair[]): Set<string> {
  // v0.6.4 review F-D(2): one linear scan over the raw pairs — the former
  // version re-segmented every BLOCKS / ENTITIES record into objects on
  // each import. The scan tracks the current section and, inside a HATCH
  // record of a scanned section, takes its first group 5.
  const out = new Set<string>();
  let scanned = false;
  let inHatch = false;
  for (let i = 0; i < pairs.length; i += 1) {
    const p = pairs[i]!;
    if (p.code === 0) {
      if (p.value === 'SECTION') {
        const name = pairs[i + 1]?.value;
        scanned = name === 'BLOCKS' || name === 'ENTITIES';
        inHatch = false;
        continue;
      }
      if (p.value === 'ENDSEC') { scanned = false; inHatch = false; continue; }
      inHatch = scanned && p.value === 'HATCH';
      continue;
    }
    if (inHatch && p.code === 5) {
      inHatch = false; // first group 5 only, as has/str did
      try { out.add(canonicalCadHandle(p.value.trim())); } catch { /* not a handle spelling: never a key */ }
    }
  }
  return out;
}

/**
 * The OBJECTS DICTIONARY records and ACDB_MLEADEROBJECTCONTEXTDATA_CLASS records,
 * by upper-case handle (P18 S3-D, RULING-P18-S3-D (1)(i)): AutoCAD stores a
 * multileader's additional annotative contexts as objects behind the entity's
 * extension dictionary, so readMLeader joins through these maps. Of the exact
 * shape of the pre-scans above; OBJECTS comes last, read first.
 */
function mleaderContextDataOf(pairs: readonly Pair[]): { dictionaries: Map<string, Obj>; contextObjects: Map<string, Obj>; scales: Map<string, string> } {
  const dictionaries = new Map<string, Obj>();
  const contextObjects = new Map<string, Obj>();
  // P18 FIX group 1(b): SCALE objects by handle -> their group-300 name, so
  // readMLeader can name the scale each context object's group 340 names.
  const scales = new Map<string, string>();
  for (let i = 0; i + 1 < pairs.length; i += 1) {
    if (pairs[i]!.code !== 0 || pairs[i]!.value !== 'SECTION' || pairs[i + 1]!.value !== 'OBJECTS') continue;
    let j = i + 2;
    while (j < pairs.length && !(pairs[j]!.code === 0 && pairs[j]!.value === 'ENDSEC')) j += 1;
    for (const o of objects(pairs as Pair[], i + 2, j)) {
      if (!has(o, 5)) continue;
      if (o.kind === 'DICTIONARY') dictionaries.set(str(o, 5).toUpperCase(), o);
      else if (o.kind === 'ACDB_MLEADEROBJECTCONTEXTDATA_CLASS') contextObjects.set(str(o, 5).toUpperCase(), o);
      else if (o.kind === 'SCALE' && has(o, 300)) scales.set(str(o, 5).toUpperCase(), str(o, 300));
    }
    i = j;
  }
  return { dictionaries, contextObjects, scales };
}

/** The reader proper; DIMSTYLE records are collected into `dimStyles`. */
function readDxfState(text: string, opts: DxfReadOptions, dimStyles: Map<string, DimStyle>, report: ImportReportBuilder, raw: RawDxfEntity[]): DrawingState {
  if (text.length > (opts.maxSourceLength ?? DXF_READ_LIMITS.maxSourceLength)) throw new DxfReadError('DXF exceeds the source text size limit.', 1);
  const retainedPairs = tokenize(text, opts.recover, report, opts);
  // Application payloads can contain literal Unicode-looking escape sequences. Geometry/text
  // decoding must not rewrite their opaque values before the retained graph sees them.
  const pairs = text.includes('\\U+') ? retainedPairs.map(pair => ({ ...pair, value: decodeUnicodeEscapes(pair.value) })) : retainedPairs;
  const textStyles: Record<string, TextStyle> = {};
  const shapeStyles: Record<string, LinetypeShapeStyle> = {};
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
    mleaderStyles: mleaderStyleNamesOf(pairs),
    mleaderStyleValues: mleaderStyleValuesOf(pairs),
    blockRecordNames: blockRecordNamesOf(pairs),
    hatchHandles: hatchHandlesOf(pairs),
    mleaderContextData: mleaderContextDataOf(pairs),
    consumedBlocks: new Set(),
    notes: opts.notes ?? [],
    report,
    raw,
    solids: new Model3DReader(opts.model3d === true, report),
  };
  const imageDefs = new Map<string, string>();
  const underlayDefsRaw: UnderlayDefinition[] = [];
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
      if (name !== 'HEADER' && opts.recordInventory) for (const object of objs) {
        const handle = str(object, object.kind === 'DIMSTYLE' ? 105 : 5).trim();
        if (handle) opts.recordInventory(canonicalCadHandle(handle), object.kind, object.kind === 'TABLE' ? str(object, 2).trim() : undefined);
      }
      if (name === 'HEADER') {
        currentLayer = readHeaderSection(pairs, i + 2, j, headerVars, ctx);
      } else if (name === 'OBJECTS') {
        readObjectsSection(objs, imageDefs, layoutReader, report, underlayDefsRaw);
      } else if (name === 'TABLES') {
        readTablesSection(objs, { layers, linetypes, views, textStyles, shapeStyles }, dimStyles, headerVars, ctx, layoutReader);
      } else if (name === 'BLOCKS') {
        readBlocksSection(objs, blocks, ctx, layoutReader);
      } else if (name === 'ENTITIES') {
        entities = readEntitiesSection(objs, ctx, layoutReader);
      }
      i = j + 1;
    } else i += 1;
  }

  // Priority 30 review R09: an INSERT's JCAD_DYNAMIC payload is decoded while
  // the insert is read, against the definitions known at that point. An
  // insert nested in a block definition whose referenced block's record
  // appears LATER in the file (a forward reference — including JCad's own
  // output whenever the outer block precedes the inner one) therefore lands
  // in dynamicRetained even though the payload is valid. Now that every
  // section has been read and the definition map is complete, re-attempt
  // those decodes, independently of block-definition order: a payload that
  // validates against the now-known definition is modeled; anything else
  // (no modeled definition, genuinely invalid values) stays retained,
  // exactly as an in-order read would have left it. Layout entities are
  // built after this point with the complete map and need no pass.
  const resolveForwardInstance = (e: Entity): Entity => {
    if (e.type !== 'insert' || e.dynamic !== undefined || e.dynamicRetained === undefined) return e;
    const definition = blocks[e.block]?.dynamic;
    if (!definition) return e;
    const decoded = decodeDynamicInstance(e.dynamicRetained, definition, e.block);
    if (!decoded.ok) return e;
    const { dynamicRetained: _retained, ...rest } = e;
    return { ...rest, dynamic: decoded.state };
  };
  // Review round 2 (C04): the same forward-reference problem dropped
  // ATTRIB placements/appearance — the fold needs the owning definition,
  // which did not exist when a parent block's entities were read. The
  // read pass retained the raw follower records for exactly those
  // inserts; replay the complete fold (values, hidden flags, local
  // placements, R07 authored-frame rebase) now, against the decoded
  // instance state, so block order cannot change the result.
  const resolveForward = (e: Entity): Entity => {
    const resolved = resolveForwardInstance(e);
    if (resolved.type !== 'insert') return resolved;
    return completeDeferredAttribFold(resolved, e, blocks, (o, message) => reportObj(ctx, o, 'simplified', message));
  };
  entities = entities.map(resolveForward);
  for (const [name, block] of Object.entries(blocks)) {
    if (block.entities.some((e) => e.type === 'insert' && ((e.dynamic === undefined && e.dynamicRetained !== undefined) || hasDeferredAttribFold(e)))) {
      blocks[name] = { ...block, entities: block.entities.map(resolveForward) };
    }
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
  // RULING-P28 C1/C2: build the underlays sibling. Definition ids come from
  // the codec (underlaydef:<HANDLE>); a repeated id (the same handle on two
  // records, or a fallback collision) is made unique in file order with a
  // ~2, ~3, ... suffix, so ids cannot collide with each other — and the
  // underlaydef: prefix cannot collide with reader-minted entity ids
  // (e<base36>). The join is placement.definitionHandle === definition.handle
  // (this post-pass, the IMAGE precedent above): a placement whose
  // definition is absent is KEPT and reported `simplified` — never
  // fabricated, and its display is the frame+cross with no path label.
  let underlays: Record<string, UnderlayDefinition> | undefined;
  if (underlayDefsRaw.length) {
    const usedIds = new Set<string>();
    underlays = {};
    for (const def of underlayDefsRaw) {
      let id = def.id;
      for (let n = 2; usedIds.has(id); n += 1) id = `${def.id}~${n}`;
      usedIds.add(id);
      underlays[id] = id === def.id ? def : { ...def, id };
    }
    for (const problem of validateUnderlayDefinitions(Object.values(underlays))) {
      report.add({ type: 'PDFDEFINITION', action: 'simplified', reason: `underlay definitions: ${problem}` });
    }
  }
  {
    const defHandles = new Set(Object.values(underlays ?? {}).map((d) => (d.handle ?? '').toUpperCase()));
    const checkDangling = (list: readonly Entity[]): void => {
      for (const e of list) {
        if (e.type === 'underlay' && !defHandles.has(e.definitionHandle)) {
          report.add({ type: entityTypeName(e), action: 'simplified', layer: e.layer, reason: `underlay definition ${e.definitionHandle} is not in this drawing; the placement is kept as a frame without content` });
        }
      }
    };
    checkDangling(entities);
    for (const block of Object.values(blocks)) checkDangling(block.entities);
    for (const l of layouts ?? []) checkDangling(l.entities);
  }
  for (const l of layouts ?? []) {
    for (const e of l.entities) ensureEntityLayers(e);
    for (const v of l.viewports) ensure(v.layer);
  }
  // Priority 30.4: the JCAD_CONSTRAINTS payload captured from the *Model_Space
  // BLOCK record decodes now that the model-space entities (its `#<index>`
  // ordinal space) are final. A payload that fails to decode or validate is
  // retained raw on the state — never half-modeled, never thrown.
  let constraints: ConstraintSet | undefined;
  let constraintsRetained: string | undefined;
  if (ctx.constraintsRaw !== undefined) {
    const decoded = decodeConstraints(ctx.constraintsRaw, entities);
    if (decoded.ok) {
      constraints = decoded.set;
      report.add({ type: 'BLOCK', action: 'simplified', reason: CONSTRAINTS_REPORT, where: 'model space' });
    } else {
      constraintsRetained = decoded.retained;
      report.add({ type: 'BLOCK', action: 'simplified', reason: CONSTRAINTS_RETAINED_REPORT, where: 'model space' });
    }
  }
  const takenIds = new Set([...entities, ...Object.values(blocks).flatMap(block => block.entities), ...(layouts ?? []).flatMap(layout => [...layout.entities, ...layout.viewports.flatMap(viewport => viewport.clipBoundary ? [viewport.clipBoundary] : [])])].map(entity => entity.id));
  for (const layout of layouts ?? []) for (const viewport of layout.viewports) takenIds.add(viewport.id);
  const solids = ctx.solids!.build(takenIds);
  for (const solid of solids) { ensure(solid.layer); takenIds.add(solid.id); }
  const dims3d = ctx.solids!.buildDimensions(takenIds);
  for (const dimension of dims3d) ensure(dimension.layer);
  reportBlockExpansion(report, blocks, [...entities, ...(layouts ?? []).flatMap((l) => l.entities)]);
  const styleNames = new Set(['STANDARD', ...Object.keys(textStyles).map((name) => name.toUpperCase())]);
  const referencedStyles = [...entities, ...Object.values(blocks).flatMap((b) => b.entities), ...(layouts ?? []).flatMap((l) => l.entities)];
  for (const entity of referencedStyles) {
    const name = entity.type === 'dimension' ? entity.style.textStyle : textStyleOf(entity);
    if (name && !styleNames.has(name.toUpperCase())) { report.add({ type: 'STYLE', action: 'unsupported', reason: `referenced text style "${name}" has no STYLE definition; its name is kept with a default stroke-font substitute`, layer: entity.layer }); styleNames.add(name.toUpperCase()); }
  }
  const textMeta = textStylesMeta(textStyles), shapeMeta = shapeStylesMeta(shapeStyles);
  const styleMeta = textMeta || shapeMeta ? { ...textMeta, ...shapeMeta } : undefined;
  const base = withDimStylesMeta({ entities, layers, blocks, currentLayer, header, ...(styleMeta ? { meta: styleMeta } : {}), ...(layouts ? { layouts } : {}), ...(constraints ? { constraints } : {}), ...(constraintsRetained !== undefined ? { constraintsRetained } : {}), ...(underlays ? { underlays } : {}), ...(solids.length || dims3d.length ? { model3d: { ...EMPTY_MODEL3D, solids, ...(dims3d.length ? { dimensions: dims3d } : {}) } } : {}) }, dimStyles);
  return attachDxfCadGraph(base, retainedPairs, { fields: ctx.fields, viewportHandles: layoutReader.viewportHandles,
    model3dHandles: ctx.solids!.carrierAnchors,
    model3dLines: ctx.solids!.carrierLines,
    rawEntityHandles: new Set(raw.flatMap(record => record.handle ? [record.handle.trim().toUpperCase()] : [])),
    ...(!opts.recordInventory && !ctx.solids!.carrierAnchors.size ? { onGraphUnavailable(reason: string) { report.add({ type: 'CAD_METADATA', action: 'dropped', reason }); } } : {}),
    onFieldUnavailable(handle, reason) { report.add({ type: 'FIELD', action: 'kept', handle, reason }); } });
}
