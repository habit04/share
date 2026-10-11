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
import { newId, dimensionParts, tableParts, type Entity, type BlockDef, type Layer, type ColorSpec, type DimensionEntity, type DimStyle, type SplineEntity, type HatchEntity, type LeaderEntity, type ImageEntity, type TableEntity, type TableCell, type HatchLoop, type WorldPatternLine, type FieldLink, type TextEntity } from '../core/entities';
import { STANDARD_DIMSTYLE, DIMSTYLES_META_KEY, dimStyleRecordPairs, diffDimStyles } from '../core/dimension';
import { mtextFromDxf, hasFormatting, type MTextAttachment } from '../core/mtext';
import { findPattern, LoopBuilder, edgeArc, fitPatternToLines } from '../core/hatch';
import { isValidNurbs, nurbsPoints, interpolateFitPoints } from '../core/spline';
import { evaluateFields, hasFields, julianToDate, type FieldContext } from '../core/fields';
import { DEFAULT_LAYERS, DEFAULT_HEADER, type DrawingState, type DrawingHeader, type NamedView } from '../core/document';
import { STANDARD_LINETYPES, findLinetype, patternLength, type Linetype } from '../core/linetypes';
import type { LinearUnits } from '../core/units';
import * as g from '../core/geometry';
import { attdefFlags, attdefFlagProps, type AttributeDefExt } from '../electrical/symbol-builder-core';
import { isScaleName } from '../core/layouts';
// Track E: paper space (layouts, VIEWPORT entities, LAYOUT objects) lives in dxf-layouts.ts.
import { planLayouts, writeLayoutHeader, extraBlockRecords, layoutHandleOf, writeLayoutContent, writeLayoutObjects, LayoutReader } from './dxf-layouts';
import { decodeUnicodeEscapes, encodeDxfText, textStyleFromGroups, textStyleGroups, textStylesForWrite, textStylesMeta, withTextStyle, type TextStyle } from './encoding';
import { ImportReportBuilder, geometryProblem, rawEntitiesOf, withImportData, type RawDxfEntity } from './import-report';
import { ANNO_APP, DIMSTYLE_APP, TABLE_APP, isPointerCode } from './dxf/codes';
import { tokenize, objects, num, has, str, pt, int, flt, afterSubclass, pointList, Cursor, xdata, type Pair, type Obj } from './dxf/groups';
import { dimStyleXdata, dimStylesToWrite, dimHeaderVars, dimStyleFromHeader, readDimStyleRecord } from './dxf/dimstyles';
import { Writer, setPaperOwners, writeTextLike, emptyExtras, type WriteExtras } from './dxf/write-core';
import { writeEntity, writeEntityAnno } from './dxf/write-entities';
export { DIMSTYLE_APP, TABLE_APP } from './dxf/codes';
export { DxfReadError } from './dxf/groups';

/** Linetype names referenced anywhere in the drawing (layers, entities, block entities). */
function usedLinetypes(state: DrawingState): Linetype[] {
  const names = new Set<string>();
  for (const l of state.layers) if (l.linetype) names.add(l.linetype.toUpperCase());
  const scan = (list: readonly Entity[]) => {
    for (const e of list) if (e.linetype) names.add(e.linetype.toUpperCase());
  };
  scan(state.entities);
  for (const b of Object.values(state.blocks)) scan(b.entities);
  // Retained raw records name their linetype in group 6: it must exist in the LTYPE table.
  for (const r of rawEntitiesOf(state)) for (const [code, value] of r.groups) if (code === 6 && value.trim()) names.add(value.trim().toUpperCase());
  const extra = state.header?.linetypes ?? [];
  const out: Linetype[] = [];
  for (const lt of extra) out.push(lt);
  for (const n of names) {
    if (n === 'BYLAYER' || n === 'BYBLOCK' || n === 'CONTINUOUS') continue;
    if (out.some((l) => l.name.toUpperCase() === n)) continue;
    const std = findLinetype(n);
    out.push(std ?? { name: n, description: '', pattern: [] });
  }
  return out;
}

export function writeDxf(state: DrawingState): string {
  const w = new Writer();
  const MODEL_SPACE = '1F';
  const PAPER_SPACE = '1B';
  const header = state.header ?? DEFAULT_HEADER;
  const ds = header.dimStyle;
  const blockList = Object.values(state.blocks);
  // Pre-assign a BLOCK_RECORD handle per block; block entities use it as their owner (330).
  const blockRecordHandles = new Map<string, string>();
  for (const b of blockList) blockRecordHandles.set(b.name, w.nextHandle());
  // Anonymous *D blocks that carry each dimension's picture.
  const dimBlocks = new Map<string, string>();
  const layoutPlan = planLayouts(state, w, PAPER_SPACE);
  setPaperOwners(layoutPlan.paperOwners);
  const dimEntities = [...state.entities, ...layoutPlan.entities].filter((e): e is DimensionEntity => e.type === 'dimension');
  dimEntities.forEach((d, i) => {
    const name = `*D${i + 1}`;
    dimBlocks.set(d.id, name);
    blockRecordHandles.set(name, w.nextHandle());
  });
  const linetypes = usedLinetypes(state);
  // Images (IMAGEDEF + reactor per image) and tables (an anonymous block each) anywhere in the drawing.
  const extras: WriteExtras = { ...emptyExtras(), arrowSize: ds.arrowSize * (ds.scale || 1) };
  const allEntities: Entity[] = [...state.entities, ...layoutPlan.entities];
  for (const b of blockList) allEntities.push(...b.entities);
  let imageDict: string | null = null;
  let anon = 0;
  for (const e of allEntities) {
    if (e.type === 'image') {
      if (!imageDict) imageDict = w.nextHandle();
      let def = extras.imageDefs.get(e.path);
      if (!def) {
        def = w.nextHandle();
        extras.imageDefs.set(e.path, def);
      }
      extras.imageReactors.set(e, { reactor: w.nextHandle(), def });
    } else if (e.type === 'table') {
      let name = '';
      do {
        anon += 1;
        name = `*U${anon}`;
      } while (state.blocks[name] || blockRecordHandles.has(name));
      extras.tableBlocks.set(e, name);
      blockRecordHandles.set(name, w.nextHandle());
    }
  }
  const tableList = [...extras.tableBlocks.entries()];

  // HEADER
  w.pair(0, 'SECTION');
  w.pair(2, 'HEADER');
  const hv = (name: string, code: number, value: string | number) => {
    w.pair(9, name);
    w.pair(code, value);
  };
  const hpt = (name: string, p: g.Point) => {
    w.pair(9, name);
    w.pair(10, p.x);
    w.pair(20, p.y);
    w.pair(30, 0);
  };
  hv('$ACADVER', 1, 'AC1015');
  hv('$DWGCODEPAGE', 3, 'ANSI_1252');
  hv('$HANDSEED', 5, 'HANDSEED_PLACEHOLDER');
  hv('$INSUNITS', 70, header.units.insunits);
  hv('$LUNITS', 70, header.units.lunits);
  hv('$LUPREC', 70, header.units.luprec);
  hv('$AUNITS', 70, 0);
  hv('$AUPREC', 70, header.units.auprec);
  hv('$CLAYER', 8, state.currentLayer);
  hv('$CELTYPE', 6, header.celtype || 'ByLayer');
  hv('$CELWEIGHT', 370, header.celweight === undefined ? -1 : Math.round(header.celweight * 100));
  hv('$LTSCALE', 40, header.ltscale);
  hv('$CELTSCALE', 40, 1);
  hpt('$LIMMIN', header.limits.min);
  hpt('$LIMMAX', header.limits.max);
  hv('$PDMODE', 70, header.pdmode);
  hv('$PDSIZE', 40, header.pdsize);
  hv('$TEXTSTYLE', 7, 'Standard');
  hv('$DIMSTYLE', 2, ds.name);
  for (const [name, code, value] of dimHeaderVars(ds)) if (name !== 'DIMLUNIT') hv(`$${name}`, code, value);
  hv('$DIMLUNIT', 70, ds.lunit);
  writeLayoutHeader(hv, state);
  w.pair(0, 'ENDSEC');

  // CLASSES: raster images need their class records.
  w.pair(0, 'SECTION');
  w.pair(2, 'CLASSES');
  if (imageDict) {
    const cls = (name: string, cpp: string, flags: number, isEntity: boolean) => {
      w.pair(0, 'CLASS');
      w.pair(1, name);
      w.pair(2, cpp);
      w.pair(3, 'ISM');
      w.pair(90, flags);
      w.pair(280, 0);
      w.pair(281, isEntity ? 1 : 0);
    };
    cls('IMAGE', 'AcDbRasterImage', 127, true);
    cls('IMAGEDEF', 'AcDbRasterImageDef', 0, false);
    cls('IMAGEDEF_REACTOR', 'AcDbRasterImageDefReactor', 1, false);
  }
  w.pair(0, 'ENDSEC');

  // TABLES
  w.pair(0, 'SECTION');
  w.pair(2, 'TABLES');

  const table = (name: string, handle: string, count: number, body: () => void) => {
    w.pair(0, 'TABLE');
    w.pair(2, name);
    w.pair(5, handle);
    w.pair(330, '0');
    w.pair(100, 'AcDbSymbolTable');
    w.pair(70, count);
    body();
    w.pair(0, 'ENDTAB');
  };
  const record = (kind: string, owner: string, subclass: string, name: string, flags = 0) => {
    w.pair(0, kind);
    w.pair(5, w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, subclass);
    w.pair(2, name);
    w.pair(70, flags);
  };

  table('VPORT', '8', 1, () => {
    record('VPORT', '8', 'AcDbViewportTableRecord', '*Active');
    w.pair(10, 0);
    w.pair(20, 0);
    w.pair(11, 1);
    w.pair(21, 1);
    w.pair(12, (header.limits.min.x + header.limits.max.x) / 2);
    w.pair(22, (header.limits.min.y + header.limits.max.y) / 2);
    w.pair(40, header.limits.max.y - header.limits.min.y);
    w.pair(41, 1.6);
    w.pair(72, 1000);
  });
  table('LTYPE', '5', 3 + linetypes.length, () => {
    const ltRecord = (lt: Linetype) => {
      record('LTYPE', '5', 'AcDbLinetypeTableRecord', lt.name);
      w.pair(3, lt.description);
      w.pair(72, 65);
      w.pair(73, lt.pattern.length);
      w.pair(40, patternLength(lt.pattern));
      for (const seg of lt.pattern) {
        w.pair(49, seg);
        w.pair(74, 0);
      }
    };
    ltRecord({ name: 'ByBlock', description: '', pattern: [] });
    ltRecord({ name: 'ByLayer', description: '', pattern: [] });
    ltRecord(STANDARD_LINETYPES[0]!);
    for (const lt of linetypes) ltRecord(lt);
  });
  const layerHandles = new Map<string, string>();
  // Layers of retained raw records that were deleted since: written so the records stay valid.
  const rawRecords = rawEntitiesOf(state);
  const layerList: Layer[] = [...state.layers];
  for (const r of rawRecords) if (!layerList.some((l) => l.name === r.layer)) layerList.push({ name: r.layer, color: 7, visible: true, locked: false, lineWeight: 0.25 });
  table('LAYER', '2', layerList.length, () => {
    for (const l of layerList) {
      record('LAYER', '2', 'AcDbLayerTableRecord', l.name, (l.locked ? 4 : 0) | (l.frozen ? 1 : 0));
      layerHandles.set(l.name, w.lastHandle().toString(16).toUpperCase());
      w.pair(62, l.visible || l.frozen ? l.color : -l.color);
      if (l.trueColor !== undefined) w.pair(420, l.trueColor & 0xffffff);
      w.pair(6, l.linetype && l.linetype.toUpperCase() !== 'BYLAYER' ? l.linetype : 'Continuous');
      w.pair(370, Math.round(l.lineWeight * 100));
      if (l.plot === false) w.pair(290, 0);
      w.pair(390, 'F');
    }
  });
  const textStyles = textStylesForWrite(state);
  table('STYLE', '3', textStyles.length, () => {
    for (const ts of textStyles) {
      record('STYLE', '3', 'AcDbTextStyleTableRecord', ts.name, ts.flags);
      for (const [code, value] of textStyleGroups(ts)) w.pair(code, value);
    }
  });
  table('VIEW', '6', header.views.length, () => {
    for (const v of header.views) {
      record('VIEW', '6', 'AcDbViewTableRecord', v.name);
      w.pair(40, v.height);
      w.pair(10, v.center.x);
      w.pair(20, v.center.y);
      w.pair(41, v.height * 1.5);
      w.pair(11, 0);
      w.pair(21, 0);
      w.pair(31, 1);
      w.pair(12, 0);
      w.pair(22, 0);
      w.pair(32, 0);
      w.pair(42, 50);
      w.pair(43, 0);
      w.pair(44, 0);
      w.pair(50, 0);
      w.pair(71, 0);
    }
  });
  table('UCS', '7', 0, () => {});
  const annotative = allEntities.some((e) => e.annotative);
  table('APPID', '9', (tableList.length ? 3 : 2) + (annotative ? 1 : 0), () => {
    record('APPID', '9', 'AcDbRegAppTableRecord', 'ACAD');
    record('APPID', '9', 'AcDbRegAppTableRecord', DIMSTYLE_APP);
    if (tableList.length) record('APPID', '9', 'AcDbRegAppTableRecord', TABLE_APP);
    if (annotative) record('APPID', '9', 'AcDbRegAppTableRecord', ANNO_APP);
  });
  // Dimensions on layouts count too, so their (unnamed) styles get a record.
  const dimStyleList = dimStylesToWrite(state, allEntities);
  table('DIMSTYLE', 'A', dimStyleList.length, () => {
    w.pair(100, 'AcDbDimStyleTable');
    for (const style of dimStyleList) {
      w.pair(0, 'DIMSTYLE');
      w.pair(105, w.nextHandle());
      w.pair(330, 'A');
      w.pair(100, 'AcDbSymbolTableRecord');
      w.pair(100, 'AcDbDimStyleTableRecord');
      w.pair(2, style.name);
      w.pair(70, 0);
      for (const [code, value] of dimStyleRecordPairs(style)) w.pair(code, value);
      w.pair(1001, DIMSTYLE_APP);
      for (const [k, v] of dimStyleXdata(style)) {
        w.pair(1000, k);
        w.pair(1000, v);
      }
    }
  });
  const layoutRecords = extraBlockRecords(layoutPlan);
  table('BLOCK_RECORD', '1', 2 + blockRecordHandles.size + layoutRecords.length, () => {
    const brec = (handle: string, name: string) => {
      w.pair(0, 'BLOCK_RECORD');
      w.pair(5, handle);
      w.pair(330, '1');
      w.pair(100, 'AcDbSymbolTableRecord');
      w.pair(100, 'AcDbBlockTableRecord');
      w.pair(2, name);
      const layoutHandle = layoutHandleOf(layoutPlan, handle, MODEL_SPACE);
      if (layoutHandle) w.pair(340, layoutHandle);
      w.pair(70, 0);
      w.pair(280, 1);
      w.pair(281, 0);
    };
    brec(MODEL_SPACE, '*Model_Space');
    brec(PAPER_SPACE, '*Paper_Space');
    for (const r of layoutRecords) brec(r.handle, r.name);
    for (const [name, handle] of blockRecordHandles) brec(handle, name);
  });
  w.pair(0, 'ENDSEC');

  // BLOCKS
  w.pair(0, 'SECTION');
  w.pair(2, 'BLOCKS');
  const blockShell = (owner: string, name: string, base: { x: number; y: number }, flags: number, description: string | undefined, body: () => void, path = '') => {
    w.pair(0, 'BLOCK');
    w.pair(5, w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockBegin');
    w.pair(2, name);
    w.pair(70, flags);
    w.pair(10, base.x);
    w.pair(20, base.y);
    w.pair(30, 0);
    w.pair(3, name);
    w.pair(1, path);
    if (description) w.pair(4, description);
    body();
    w.pair(0, 'ENDBLK');
    w.pair(5, w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockEnd');
  };
  blockShell(MODEL_SPACE, '*Model_Space', { x: 0, y: 0 }, 0, undefined, () => {});
  blockShell(PAPER_SPACE, '*Paper_Space', { x: 0, y: 0 }, 0, undefined, () => {});
  // Layouts after the first keep their paper space in *Paper_Space0, *Paper_Space1 ...
  const writePaperEntity = (e: Entity, owner: string) => writeEntityAnno(w, e, owner, state.blocks, dimBlocks, extras);
  for (const r of layoutPlan.records.slice(1)) blockShell(r.blockRecord, r.blockName, { x: 0, y: 0 }, 0, undefined, () => writeLayoutContent(w, r, writePaperEntity, layerHandles));
  for (const b of blockList) {
    const owner = blockRecordHandles.get(b.name)!;
    // Anonymous blocks (*T tables, *U dynamic blocks) must carry flag 1 or AutoCAD rejects the name.
    const xrefFlags = b.xref ? 4 | (b.xref.overlay ? 8 : 0) : 0;
    blockShell(owner, b.name, b.basePoint, (b.attributes.length > 0 ? 2 : 0) | (b.name.startsWith('*') ? 1 : 0) | xrefFlags, b.description, () => {
      for (const e of b.entities) writeEntity(w, e, owner, state.blocks, undefined, extras);
      for (const a of b.attributes) {
        w.pair(0, 'ATTDEF');
        w.pair(5, w.nextHandle());
        w.pair(330, owner);
        w.pair(100, 'AcDbEntity');
        w.pair(8, '0');
        w.pair(100, 'AcDbText');
        writeTextLike(w, a.position, a.height, a.default, a.rotation ?? 0, a.align);
        w.pair(100, 'AcDbAttributeDefinition');
        w.pair(3, a.prompt);
        w.pair(2, a.tag);
        w.pair(70, attdefFlags(a));
      }
    }, b.xref?.path ?? '');
  }
  for (const [t, name] of tableList) {
    const owner = blockRecordHandles.get(name)!;
    blockShell(owner, name, { x: 0, y: 0 }, 1, undefined, () => {
      for (const part of tableParts(t)) writeEntity(w, part, owner, state.blocks, undefined, extras);
    });
  }
  for (const d of dimEntities) {
    const name = dimBlocks.get(d.id)!;
    const owner = blockRecordHandles.get(name)!;
    blockShell(owner, name, { x: 0, y: 0 }, 1, undefined, () => {
      for (const part of dimensionParts(d)) writeEntity(w, { ...part, color: part.color === 'ByLayer' ? 0 : part.color } as Entity, owner, state.blocks);
    });
  }
  w.pair(0, 'ENDSEC');

  // ENTITIES
  w.pair(0, 'SECTION');
  w.pair(2, 'ENTITIES');
  for (const e of state.entities) writeEntityAnno(w, e, MODEL_SPACE, state.blocks, dimBlocks, extras);
  // The first layout's paper space (VIEWPORTs + entities, group 67 = 1).
  if (layoutPlan.records[0]) writeLayoutContent(w, layoutPlan.records[0], writePaperEntity, layerHandles);
  // Unknown model-space records kept from the source file, verbatim apart from a new handle and owner.
  for (const r of rawRecords) {
    w.pair(0, r.type);
    w.pair(5, w.nextHandle());
    w.pair(330, MODEL_SPACE);
    for (const [code, value] of r.groups) w.pair(code, value);
  }
  w.pair(0, 'ENDSEC');

  // OBJECTS: root dictionary with the mandatory ACAD_GROUP entry
  w.pair(0, 'SECTION');
  w.pair(2, 'OBJECTS');
  w.pair(0, 'DICTIONARY');
  w.pair(5, 'C');
  w.pair(330, '0');
  w.pair(100, 'AcDbDictionary');
  w.pair(281, 1);
  w.pair(3, 'ACAD_GROUP');
  w.pair(350, 'D');
  w.pair(3, 'ACAD_LAYOUT');
  w.pair(350, layoutPlan.dictionary);
  if (imageDict) {
    w.pair(3, 'ACAD_IMAGE_DICT');
    w.pair(350, imageDict);
  }
  w.pair(0, 'DICTIONARY');
  w.pair(5, 'D');
  w.pair(330, 'C');
  w.pair(100, 'AcDbDictionary');
  w.pair(281, 1);
  writeLayoutObjects(w, layoutPlan, MODEL_SPACE, 'C');
  if (imageDict) {
    w.pair(0, 'DICTIONARY');
    w.pair(5, imageDict);
    w.pair(330, 'C');
    w.pair(100, 'AcDbDictionary');
    w.pair(281, 1);
    const used = new Set<string>();
    for (const [path, def] of extras.imageDefs) {
      const stem = (path.split(/[\\/]/).pop() || 'IMAGE').replace(/\.[^.]*$/, '') || 'IMAGE';
      let key = stem;
      for (let n = 2; used.has(key.toUpperCase()); n += 1) key = `${stem}_${n}`;
      used.add(key.toUpperCase());
      w.pair(3, key);
      w.pair(350, def);
    }
    for (const [path, def] of extras.imageDefs) {
      const users = [...extras.imageReactors.entries()].filter(([img]) => img.path === path);
      const first = users[0]?.[0];
      w.pair(0, 'IMAGEDEF');
      w.pair(5, def);
      w.pair(102, '{ACAD_REACTORS');
      w.pair(330, imageDict);
      for (const [, r] of users) w.pair(330, r.reactor);
      w.pair(102, '}');
      w.pair(330, imageDict);
      w.pair(100, 'AcDbRasterImageDef');
      w.pair(90, 0);
      w.pair(1, path);
      w.pair(10, first?.size.x ?? 1);
      w.pair(20, first?.size.y ?? 1);
      w.pair(11, 1);
      w.pair(21, 1);
      w.pair(280, 1);
      w.pair(281, 0);
    }
    for (const [, r] of extras.imageReactors) {
      w.pair(0, 'IMAGEDEF_REACTOR');
      w.pair(5, r.reactor);
      w.pair(330, r.image ?? '0');
      w.pair(100, 'AcDbRasterImageDefReactor');
      w.pair(90, 2);
      w.pair(330, r.image ?? '0');
    }
  }
  w.pair(0, 'ENDSEC');
  w.pair(0, 'EOF');
  // The handle seed must exceed every handle used in the file.
  // AC1015 is read in the $DWGCODEPAGE page: non-ASCII goes out as \U+XXXX escapes (see io/encoding.ts).
  return encodeDxfText(w.toString().replace('HANDSEED_PLACEHOLDER', (w.lastHandle() + 1).toString(16).toUpperCase()), 'AC1015');
}

/** Entity properties common to every DXF entity (layer, colour, linetype, lineweight, ltscale). */
function commonProps(o: Obj): { id: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number; ltscale?: number; trueColor?: number } {
  const layer = str(o, 8, '0');
  const rawColor = o.groups.find((x) => x.code === 62);
  const color: ColorSpec = rawColor && parseInt(rawColor.value, 10) !== 256 ? parseInt(rawColor.value, 10) : 'ByLayer';
  const base: { id: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number; ltscale?: number } = { id: newId(), layer, color };
  const lt = str(o, 6);
  if (lt && lt.toUpperCase() !== 'BYLAYER') base.linetype = lt;
  if (has(o, 370)) {
    const lw = Math.trunc(num(o, 370));
    if (lw >= 0) base.lineWeight = lw / 100;
    else if (lw === -2) base.lineWeight = -2;
  }
  if (has(o, 48) && num(o, 48) !== 1) base.ltscale = num(o, 48);
  if (has(o, 420)) (base as { trueColor?: number }).trueColor = Math.trunc(num(o, 420)) & 0xffffff;
  return base;
}

function readDimStyleFromEntity(o: Obj, styles: Map<string, DimStyle>, fallback: DimStyle): DimStyle {
  const name = str(o, 3);
  return (name && styles.get(name.toUpperCase())) || fallback;
}

function readDimension(o: Obj, base: ReturnType<typeof commonProps>, style: DimStyle): Entity | null {
  const flags = Math.trunc(num(o, 70));
  const type = flags & 15;
  const userText = flags & 128 ? pt(o, 11) : undefined;
  const textRaw = str(o, 1);
  const text = textRaw && textRaw !== '<>' ? textRaw : undefined;
  // Groups 53 (text rotation) and 52 (oblique), degrees; 0 means "not set".
  const rot = num(o, 53);
  const obl = num(o, 52);
  const angles = { ...(Math.abs(rot) > 1e-9 ? { textRotation: g.rad(rot) } : {}), ...(Math.abs(obl) > 1e-9 && (type === 0 || type === 1) ? { oblique: g.rad(obl) } : {}) };
  const common = { ...base, type: 'dimension' as const, text, textPosition: userText, ...angles, style };
  const subclasses = o.groups.filter((x) => x.code === 100).map((x) => x.value);
  switch (type) {
    case 0: {
      const p1 = pt(o, 13);
      const p2 = pt(o, 14);
      const rotation = g.rad(num(o, 50));
      return { ...common, kind: 'linear', p1, p2, linePoint: pt(o, 10), rotation };
    }
    case 1:
      return { ...common, kind: 'aligned', p1: pt(o, 13), p2: pt(o, 14), linePoint: pt(o, 10), rotation: 0 };
    case 3: {
      const a = pt(o, 10);
      const b = pt(o, 15);
      const center = g.mid(a, b);
      const leader = num(o, 40);
      const dir = g.normalize(g.sub(a, center));
      return { ...common, kind: 'diameter', p1: center, p2: a, linePoint: userText ?? g.add(a, g.scale(dir, leader)), rotation: 0 };
    }
    case 4: {
      const center = pt(o, 10);
      const q = pt(o, 15);
      const leader = num(o, 40);
      const dir = g.normalize(g.sub(q, center));
      return { ...common, kind: 'radius', p1: center, p2: q, linePoint: userText ?? g.add(q, g.scale(dir, leader)), rotation: 0 };
    }
    case 5:
      return { ...common, kind: 'angular', p1: pt(o, 13), p2: pt(o, 14), center: pt(o, 15), linePoint: pt(o, 10), rotation: 0 };
    case 2: {
      // Two-line angular: legs 13->14 and 15->10, arc point 16.
      if (!subclasses.includes('AcDb2LineAngularDimension') && !has(o, 16)) return null;
      const a1 = pt(o, 13);
      const a2 = pt(o, 14);
      const b1 = pt(o, 15);
      const b2 = pt(o, 10);
      const r = g.sub(a2, a1);
      const s = g.sub(b2, b1);
      const denom = g.cross(r, s);
      if (Math.abs(denom) < 1e-12) return null;
      const t = g.cross(g.sub(b1, a1), s) / denom;
      const center = g.add(a1, g.scale(r, t));
      const far = (p: g.Point, q: g.Point) => (g.dist(p, center) >= g.dist(q, center) ? p : q);
      return { ...common, kind: 'angular', p1: far(a1, a2), p2: far(b1, b2), center, linePoint: pt(o, 16), rotation: 0 };
    }
    default:
      return null;
  }
}

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

/** A dimension-variable override (ACAD DSTYLE xdata: 1070 code, 1040/1070 value). */
function dstyleOverride(o: Obj, dimvarCode: number): number | undefined {
  const xd = xdata(o, 'ACAD');
  if (!xd) return undefined;
  for (let k = 0; k + 1 < xd.length; k += 1) if (xd[k]!.code === 1070 && int(xd[k]!.value) === dimvarCode) return flt(xd[k + 1]!.value);
  return undefined;
}

function readLeader(o: Obj, base: ReturnType<typeof commonProps>, ctx: ReadContext): LeaderEntity | null {
  const gs = afterSubclass(o, 'AcDbLeader');
  const vertices = pointList(gs, 10);
  if (vertices.length < 2) return null;
  const hook = int(gs.find((x) => x.code === 75)?.value) === 1;
  let verts = vertices;
  let dogleg: g.Point | undefined;
  if (hook && verts.length >= 3) {
    dogleg = g.sub(verts[verts.length - 1]!, verts[verts.length - 2]!);
    verts = verts.slice(0, -1);
  }
  const ds = ctx.dimStyle;
  const size = dstyleOverride(o, 41) ?? ds.arrowSize * (ds.scale || 1);
  return {
    ...base,
    type: 'leader',
    vertices: verts,
    arrow: int(gs.find((x) => x.code === 71)?.value, 1) !== 0,
    arrowSize: size,
    ...(dogleg ? { dogleg } : {}),
    ...(int(gs.find((x) => x.code === 72)?.value) === 1 ? { spline: true } : {}),
    textHeight: flt(gs.find((x) => x.code === 40)?.value, ds.textHeight * (ds.scale || 1)) || ds.textHeight,
    kind: 'leader',
  };
}

/**
 * MULTILEADER: leader lines, landing and MTEXT content from the CONTEXT_DATA section.
 * Block content is not drawn (noted by the caller); missing parts degrade to what is present.
 */
function readMLeader(o: Obj, base: ReturnType<typeof commonProps>, ctx: ReadContext): LeaderEntity | null {
  const gs = o.groups;
  const paths: g.Point[][] = [];
  let text = '';
  let textPos: g.Point | undefined;
  let textHeight: number | undefined;
  let textWidth: number | undefined;
  let textRotation = 0;
  let textDir: g.Point | undefined;
  let attachment: number | undefined;
  let arrowSize: number | undefined;
  let hasBlock = false;
  let depth: string[] = [];
  let lastLeaderPoint: g.Point | undefined;
  let doglegVec: g.Point | undefined;
  let doglegLen: number | undefined;
  let line: g.Point[] | null = null;
  const sectionLines: g.Point[][] = [];
  let firstDogleg: g.Point | undefined;
  let commonArrow: number | undefined;
  let commonDogleg: number | undefined;
  let lineType = 1;
  const endSection = () => {
    // A LEADER{} section: each of its lines runs arrow -> ... -> last leader point, then the landing.
    for (const l of sectionLines) paths.push(lastLeaderPoint ? [...l, lastLeaderPoint] : l);
    if (!firstDogleg && lastLeaderPoint && doglegVec && doglegLen) firstDogleg = g.scale(g.normalize(doglegVec), doglegLen);
    sectionLines.length = 0;
    lastLeaderPoint = undefined;
    doglegVec = undefined;
    doglegLen = undefined;
  };
  for (let k = 0; k < gs.length; k += 1) {
    const p = gs[k]!;
    const top = depth[depth.length - 1];
    if (p.code === 300 && p.value.startsWith('CONTEXT_DATA')) {
      depth.push('CONTEXT');
      continue;
    }
    if (p.code === 301) {
      depth = depth.filter((d) => d !== 'CONTEXT');
      continue;
    }
    if (p.code === 302 && p.value.startsWith('LEADER{')) {
      depth.push('LEADER');
      continue;
    }
    if (p.code === 303) {
      endSection();
      depth.pop();
      continue;
    }
    if (p.code === 304 && p.value.startsWith('LEADER_LINE{')) {
      depth.push('LINE');
      line = [];
      continue;
    }
    if (p.code === 305) {
      if (line && line.length) sectionLines.push(line);
      line = null;
      depth.pop();
      continue;
    }
    const nextY = () => flt(gs[k + 1]?.code === p.code + 10 ? gs[k + 1]!.value : undefined);
    if (top === 'LINE') {
      if (p.code === 10) line?.push({ x: flt(p.value), y: nextY() });
      continue;
    }
    if (top === 'LEADER') {
      if (p.code === 10) lastLeaderPoint = { x: flt(p.value), y: nextY() };
      else if (p.code === 11) doglegVec = { x: flt(p.value), y: nextY() };
      else if (p.code === 40) doglegLen = flt(p.value);
      continue;
    }
    if (top === 'CONTEXT') {
      switch (p.code) {
        case 41:
          textHeight = flt(p.value);
          break;
        case 140:
          arrowSize = flt(p.value);
          break;
        case 304:
          text += p.value;
          break;
        case 12:
          textPos = { x: flt(p.value), y: nextY() };
          break;
        case 13:
          textDir = { x: flt(p.value), y: nextY() };
          break;
        case 42:
          textRotation = flt(p.value);
          break;
        case 43:
          textWidth = flt(p.value);
          break;
        case 171:
          attachment = int(p.value);
          break;
        case 296:
          hasBlock = int(p.value) !== 0;
          break;
        default:
          break;
      }
      continue;
    }
    // Common MLeader data after the context section.
    if (p.code === 170) lineType = int(p.value, 1);
    else if (p.code === 42) commonArrow = flt(p.value);
    else if (p.code === 41) commonDogleg = flt(p.value);
  }
  void hasBlock;
  const main = paths.shift();
  if (!main || main.length < 2) return null;
  const ds = ctx.dimStyle;
  const size = arrowSize ?? commonArrow ?? ds.arrowSize * (ds.scale || 1);
  const dogleg = firstDogleg ?? undefined;
  void commonDogleg;
  const plain = text ? mtextFromDxf(text) : '';
  const rot = textDir && (textDir.x !== 0 || textDir.y !== 0) ? Math.atan2(textDir.y, textDir.x) : textRotation;
  return {
    ...base,
    type: 'leader',
    vertices: main,
    arrow: lineType !== 0,
    arrowSize: size,
    ...(dogleg && g.len(dogleg) > 1e-12 ? { dogleg } : {}),
    ...(lineType === 2 ? { spline: true } : {}),
    ...(paths.length ? { extraPaths: paths } : {}),
    ...(plain ? { text: plain, ...(hasFormatting(text) ? { raw: text } : {}) } : {}),
    ...(textPos && plain ? { textPosition: textPos } : {}),
    textHeight: textHeight && textHeight > 0 ? textHeight : ds.textHeight,
    ...(attachment && attachment >= 1 && attachment <= 9 ? { textAttachment: attachment as MTextAttachment } : {}),
    ...(textWidth && textWidth > 0 ? { textWidth } : {}),
    ...(Math.abs(rot) > 1e-12 ? { textRotation: rot } : {}),
    kind: 'mleader',
  };
}

function readImage(o: Obj, base: ReturnType<typeof commonProps>): ImageEntity {
  const gs = afterSubclass(o, 'AcDbRasterImage');
  const find = (code: number) => gs.find((x) => x.code === code)?.value;
  const clipType = int(find(71), 1);
  const clip = pointList(gs, 14);
  return {
    ...base,
    type: 'image',
    path: '',
    position: pt(o, 10),
    u: pt(o, 11, { x: 1, y: 0 }),
    v: pt(o, 12, { x: 0, y: 1 }),
    size: { x: flt(find(13), 1), y: flt(find(23), 1) },
    ...(clip.length >= 2 ? { clip: clipType === 1 ? clip.slice(0, 2) : clip } : {}),
    ...(int(find(280)) === 1 ? { clipOn: true } : {}),
    flags: int(find(70), 7),
    brightness: int(find(281), 50),
    contrast: int(find(282), 50),
    fade: int(find(283), 0),
  };
}

/** ACAD_TABLE with legacy cell data (91/92 size, 141/142 sizes, 171.. per cell) -> native table. */
function readTable(o: Obj, base: ReturnType<typeof commonProps>): TableEntity | null {
  const gs = afterSubclass(o, 'AcDbTable');
  const firstCell = gs.findIndex((x) => x.code === 171);
  const head = firstCell >= 0 ? gs.slice(0, firstCell) : gs;
  const rows = int(head.find((x) => x.code === 91)?.value);
  const cols = int(head.find((x) => x.code === 92)?.value);
  const rowHeights = head.filter((x) => x.code === 141).map((x) => flt(x.value));
  const columnWidths = head.filter((x) => x.code === 142).map((x) => flt(x.value));
  if (rows < 1 || cols < 1 || rowHeights.length !== rows || columnWidths.length !== cols || firstCell < 0) return null;
  const chunks: Pair[][] = [];
  let cur: Pair[] | null = null;
  for (let k = firstCell; k < gs.length; k += 1) {
    const p = gs[k]!;
    if (p.code === 171) {
      cur = [];
      chunks.push(cur);
    }
    // Table-wide overrides follow the cell list.
    if (p.code === 280 || p.code === 281) cur = null;
    cur?.push(p);
  }
  if (chunks.length < rows * cols) return null;
  let anyText = false;
  const heights: number[] = [];
  const cells: TableCell[][] = [];
  for (let r = 0; r < rows; r += 1) {
    const row: TableCell[] = [];
    for (let c = 0; c < cols; c += 1) {
      const cg = chunks[r * cols + c]!;
      let text = cg.filter((x) => x.code === 2 || x.code === 3).map((x) => x.value).join('') + (cg.find((x) => x.code === 1)?.value ?? '');
      if (!text) text = cg.find((x) => x.code === 302 && x.value)?.value ?? '';
      const h = flt(cg.find((x) => x.code === 140)?.value);
      const align = int(cg.find((x) => x.code === 170)?.value);
      const spanC = int(cg.find((x) => x.code === 175)?.value, 1);
      const spanR = int(cg.find((x) => x.code === 176)?.value, 1);
      const plain = text ? mtextFromDxf(text) : '';
      if (plain) anyText = true;
      if (h > 0) heights.push(h);
      row.push({
        text: plain,
        ...(plain && hasFormatting(text) ? { raw: text } : {}),
        ...(h > 0 ? { height: h } : {}),
        ...(align >= 1 && align <= 9 ? { attachment: align as MTextAttachment } : {}),
        ...(spanC > 1 || spanR > 1 ? { span: { rows: Math.max(1, spanR), cols: Math.max(1, spanC) } } : {}),
      });
    }
    cells.push(row);
  }
  if (!anyText) return null;
  const dir = pt(o, 11, { x: 1, y: 0 });
  heights.sort((a, b) => a - b);
  return {
    ...base,
    type: 'table',
    position: pt(o, 10),
    rotation: Math.atan2(dir.y, dir.x),
    rowHeights,
    columnWidths,
    cells,
    textHeight: heights[Math.floor(heights.length / 2)] ?? 0.18,
  };
}

/** A table JCad wrote as an INSERT of an anonymous block with its data in JCAD_TABLE xdata. */
function readJcadTable(o: Obj, base: ReturnType<typeof commonProps>): TableEntity | null {
  const xd = xdata(o, TABLE_APP);
  if (!xd) return null;
  try {
    const meta = JSON.parse(xd.filter((x) => x.code === 1000).map((x) => x.value).join('')) as Partial<TableEntity>;
    if (!meta.position || !Array.isArray(meta.rowHeights) || !Array.isArray(meta.columnWidths) || !Array.isArray(meta.cells)) return null;
    return {
      ...base,
      type: 'table',
      position: meta.position,
      rotation: meta.rotation ?? 0,
      rowHeights: meta.rowHeights,
      columnWidths: meta.columnWidths,
      cells: meta.cells,
      textHeight: meta.textHeight ?? 0.18,
      ...(meta.margin !== undefined ? { margin: meta.margin } : {}),
    };
  } catch {
    return null;
  }
}

/** Field expressions in TEXT: evaluate for display and keep the code. */
function withTextField(text: string, ctx: ReadContext): { text: string; field?: FieldLink } {
  if (!hasFields(text)) return { text };
  const value = evaluateFields(text, ctx.fields);
  return { text: value, field: { code: text, value } };
}

function readEntityObj(o: Obj, ctx: ReadContext): Entity | null {
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
      // MTEXT: 10/20 attachment corner, 71 attachment point (1..9), 11/21 direction vector, 50 rotation (radians)
      const ap = Math.max(1, Math.min(9, Math.trunc(num(o, 71, 1)))) as MTextAttachment;
      const hasDir = has(o, 11);
      const rotation = hasDir ? Math.atan2(num(o, 21), num(o, 11)) : num(o, 50);
      const height = num(o, 40, 0.125);
      const source = o.groups
        .filter((x) => x.code === 1 || x.code === 3)
        .map((x) => x.value)
        .join('');
      // Fields are evaluated first; the expression is kept for saving.
      const raw = hasFields(source) ? evaluateFields(source, ctx.fields) : source;
      const plain = mtextFromDxf(raw);
      const field: FieldLink | undefined = raw !== source ? { code: source, value: plain } : undefined;
      if (has(o, 41)) {
        return {
          ...base,
          type: 'mtext',
          position: { x: num(o, 10), y: num(o, 20) },
          text: plain,
          ...(hasFormatting(raw) ? { raw } : {}),
          ...(field ? { field } : {}),
          height,
          width: Math.max(0, num(o, 41)),
          rotation,
          attachment: ap,
          lineSpacing: num(o, 44, 1) || 1,
        };
      }
      // Minimal MTEXT without a reference width: keep it as single-line TEXT.
      const col = (ap - 1) % 3;
      const row = Math.floor((ap - 1) / 3);
      const align: 'left' | 'center' | 'right' = col === 1 ? 'center' : col === 2 ? 'right' : 'left';
      const drop = row === 0 ? height : row === 1 ? height / 2 : 0;
      const corner = { x: num(o, 10), y: num(o, 20) };
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
      return readDimension(o, base, readDimStyleFromEntity(o, ctx.dimStyles, ctx.dimStyle));
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
      ctx.pendingImages?.set(im, str(o, 340).toUpperCase());
      return im;
    }
    case 'ACAD_TABLE': {
      // Cell data present: a native table. Otherwise it draws through its anonymous *T block (group 2).
      const block = str(o, 2);
      const table = readTable(o, base);
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

interface ReadContext {
  dimStyles: Map<string, DimStyle>;
  dimStyle: DimStyle;
  /** Block definitions read so far (BLOCKS precedes ENTITIES), for per-insert attribute visibility. */
  blocks?: Record<string, BlockDef>;
  /** Values for field expressions in TEXT / MTEXT. */
  fields?: FieldContext;
  /** IMAGE entities waiting for their IMAGEDEF (OBJECTS comes last), by IMAGEDEF handle. */
  pendingImages?: Map<ImageEntity, string>;
  /** Anonymous blocks replaced by native tables. */
  consumedBlocks?: Set<string>;
  /** Remarks about content that was simplified. */
  notes?: string[];
  /** Import report: dropped / simplified / kept objects. */
  report?: ImportReportBuilder;
  /** Unknown model-space records kept as raw group codes. */
  raw?: RawDxfEntity[];
  /** Where the objects being read are (report text). */
  where?: string;
}

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

function reportObj(ctx: ReadContext, o: Obj, action: 'dropped' | 'simplified' | 'kept', reason: string): void {
  if (!ctx.report) return;
  const handle = str(o, 5);
  ctx.report.add({ type: o.kind, action, reason, ...(handle ? { handle } : {}), layer: str(o, 8, '0'), ...(o.line ? { line: o.line } : {}), ...(ctx.where ? { where: ctx.where } : {}) });
}

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
