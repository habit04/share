/**
 * writeDxf: an AC1015 (AutoCAD 2000) DXF file from a drawing. Handles are allocated in file
 * order, so the sections are written in sequence: HEADER, CLASSES, TABLES, BLOCKS, ENTITIES and
 * OBJECTS (paper space comes from io/dxf-layouts.ts). Experimental 3D solids are polyface meshes at
 * the end of ENTITIES (io/dxf/mesh3d-write.ts), followed by true 3D dimensions as DIMENSIONs in
 * their planes (io/dxf/dim3d-write.ts, each with a *D picture block after the 2D dimensions'); a
 * drawing without them writes none of this.
 */
import type { DrawingState } from '../../core/document';
import type { Linetype } from '../../core/linetypes';
import type { Entity, DimensionEntity, Layer, AttributeAppearance } from '../../core/entities';
import { rawEntitiesOf } from '../import-report';
import { findLinetype, patternLength, STANDARD_LINETYPES, complexLinetypeProblem, linetypeShapeStyleProblem } from '../../core/linetypes';
import { Writer, setPaperOwners, emptyExtras, writeTextLike, writeTextStyle, writeEntityCommon } from './write-core';
import { DEFAULT_HEADER } from '../../core/document';
import { planLayouts, extraBlockRecords, layoutHandleOf, writeLayoutContent, writeLayoutObjects } from '../dxf-layouts';
import { isScaleName } from '../../core/layouts';
import type { WriteExtras } from './write-core';
import * as g from '../../core/geometry';
import { dimHeaderVars, dimStylesToWrite, dimStyleXdata } from './dimstyles';
import { textStylesForWrite, textStyleOf, STANDARD_TEXT_STYLE, textStyleGroups, encodeDxfText, shapeStylesOf, shapeStyleGroups } from '../encoding';
import { writeComplexLinetypeElements } from './complex-linetypes';
import { DIMSTYLE_APP, TABLE_APP, DYNAMIC_APP, CONSTRAINTS_APP, ANNO_APP, MTEXT_COLUMNS_APP, MTEXT_BACKGROUND_APP, MODEL3D_APP } from './codes';
import { chunkDynamicPayload, encodeDynamicDefinition } from './dynamic-data';
import { encodeConstraints } from './constraints-data';
import { writeSolid } from './mesh3d-write';
import { writeDimension3D, writeDimension3DPicture } from './dim3d-write';
import { dimension3dTo2d } from '../../model3d/dimension3d';
import { writeRetainedSolid } from './model3d-carriers';
import type { CadNode } from '../../core/cad-graph';
import { dimStyleRecordPairs } from '../../core/dimension';
import { writeEntityAnno, writeEntity } from './write-entities';
import { attdefFlags } from '../../electrical/symbol-builder-core';
import { tableParts, dimensionParts } from '../../core/entities';
import { entityMTextBackground } from '../../core/mtext-background';
import { materializePolylineWidthFrames } from './polyline-width-blocks';
import { LAYER_TRANSPARENCY_APP, transparencyToDxf, validColorName } from '../../core/appearance';
import { namedCameraDisplayCenter, planarNamedCamera } from '../../core/named-view';
import { graphAnnotationCarrier, preserveDxfCadGraph } from '../cad-graph-dxf';

/** Linetype names referenced anywhere in the drawing (layers, entities, block entities). */
function usedLinetypes(state: DrawingState): Linetype[] {
  const names = new Set<string>();
  for (const l of state.layers) if (l.linetype) names.add(l.linetype.toUpperCase());
  const scan = (list: readonly Entity[]) => {
    for (const e of list) if (e.linetype) names.add(e.linetype.toUpperCase());
  };
  scan(state.entities);
  for (const b of Object.values(state.blocks)) scan(b.entities);
  for (const l of state.layouts ?? []) {
    scan(l.entities);
    for (const v of l.viewports) if (v.clipBoundary) scan([v.clipBoundary]);
  }
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

/**
 * Content key for a dimension's generated picture (Q11 F1): the canonical serialization of
 * the parts exactly as the *D block writer emits them (including its ByLayer -> 0 color
 * mapping), with identity fields removed (part ids embed the owning dimension's id) and
 * numbers at write precision (write-core fmt rounds to 10 decimals). Equal keys therefore
 * mean byte-identical picture bodies; unequal keys can still render alike only through
 * fields the writer never emits, never the reverse.
 */
function dimensionPictureKey(d: DimensionEntity): string {
  const canonical = (value: unknown): unknown => {
    if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(10)) : 0;
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value).sort()) {
        if (key === 'id' || key === 'cadIdentity') continue;
        out[key] = canonical((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(dimensionParts(d).map((part) => canonical({ ...part, color: part.color === 'ByLayer' ? 0 : part.color })));
}

export function writeDxf(state: DrawingState): string {
  state = materializePolylineWidthFrames(state);
  const w = new Writer();
  // ACAD_PLOTSTYLENAME: the dictionary layers point at (390) and its "Normal" entry (AutoCAD's
  // AUDIT reports layers whose plot style handle names no object).
  const plotStyleDictionary = w.nextHandle();
  const normalPlotStyle = w.nextHandle();
  // Q11 F2 rework: the annotation settings (cannoscale / annoAllVisible) are not HEADER
  // variables in AutoCAD — they live as DICTIONARYVARs in the AcDbVariableDictionary, at
  // every DXF version. Emit only what is set (CANNOSCALE when a valid scale name is set;
  // ANNOALLVISIBLE only when false, as '0' — at the default AutoCAD omits both
  // everywhere), and create the dictionary only when the retained graph carries none:
  // when it carries one, the graph path refreshes/inserts the values and a second
  // dictionary must never appear. (A carried variable implies a carried dictionary —
  // the dictionary path is how annotationVariables finds it.)
  const annotationCarrier = graphAnnotationCarrier(state);
  const createCannoVariable = !annotationCarrier.dictionary && state.header?.cannoscale !== undefined && isScaleName(state.header.cannoscale);
  const createAnnoVariable = !annotationCarrier.dictionary && state.header?.annoAllVisible === false;
  const variableDictionary = createCannoVariable || createAnnoVariable ? w.nextHandle() : null;
  const cannoVariable = createCannoVariable ? w.nextHandle() : null;
  const annoVariable = createAnnoVariable ? w.nextHandle() : null;
  const MODEL_SPACE = '1F';
  const PAPER_SPACE = '1B';
  const header = state.header ?? DEFAULT_HEADER;
  const ds = header.dimStyle;
  const blockList = Object.values(state.blocks);
  // Pre-assign a BLOCK_RECORD handle per block; block entities use it as their owner (330).
  const blockRecordHandles = new Map<string, string>();
  for (const b of blockList) blockRecordHandles.set(b.name, w.nextHandle());
  // Anonymous *D blocks that carry each dimension's picture. Dimensions whose generated
  // pictures are identical share one block, named in first-appearance order (Q11 F1):
  // AutoCAD shares *D graphics across a drawing's records, and one block per distinct
  // content is the reproducible part of that behavior (AutoCAD's own count also depends
  // on its evaluation history, so it is not the target).
  const dimBlocks = new Map<string, string>();
  const dimPictures: Array<{ name: string; dimension: DimensionEntity }> = [];
  const layoutPlan = planLayouts(state, w, PAPER_SPACE);
  setPaperOwners(layoutPlan.paperOwners);
  // Dimensions inside block definitions get their picture block too (a DIMENSION naming no block
  // is invalid).
  const dimEntities = [...state.entities, ...layoutPlan.entities, ...blockList.flatMap((b) => b.entities)].filter((e): e is DimensionEntity => e.type === 'dimension');
  const pictureByKey = new Map<string, string>();
  for (const d of dimEntities) {
    const key = dimensionPictureKey(d);
    let name = pictureByKey.get(key);
    if (name === undefined) {
      name = `*D${dimPictures.length + 1}`;
      pictureByKey.set(key, name);
      dimPictures.push({ name, dimension: d });
      blockRecordHandles.set(name, w.nextHandle());
    }
    dimBlocks.set(d.id, name);
  }
  // Experimental true 3D dimensions: a picture block each, numbered after the 2D dimensions'.
  const dims3d = state.model3d?.dimensions ?? [];
  const dim3dBlocks = new Map<string, string>();
  dims3d.forEach((d, i) => {
    const name = `*D${dimPictures.length + i + 1}`;
    dim3dBlocks.set(d.id, name);
    const handle = w.nextHandle();
    blockRecordHandles.set(name, handle);
    w.anchor(handle, { kind: 'dimension3d', id: d.id, part: 'picture-block' });
  });
  // Their 2D equivalents (plane coordinates) for the style tables (DIMSTYLE, STYLE).
  const dims3dAs2d = dims3d.map(dimension3dTo2d);
  const linetypes = usedLinetypes(state);
  // Images (IMAGEDEF + reactor per image) and tables (an anonymous block each) anywhere in the drawing.
  const extras: WriteExtras = { ...emptyExtras(), arrowSize: ds.arrowSize * (ds.scale || 1) };
  const allEntities: Entity[] = [...state.entities, ...layoutPlan.entities];
  for (const b of blockList) allEntities.push(...b.entities);
  // LTYPE340 points forward to STYLE. Reserve real target handles before writing LTYPE.
  const textStyles = textStylesForWrite(state), shapeStyles = Object.entries(shapeStylesOf(state));
  for (const lt of linetypes) {
    const problem = complexLinetypeProblem(lt);
    if (problem) throw new Error(`Cannot preserve complex linetype "${lt.name}": ${problem}.`);
    for (const element of lt.complex?.elements ?? []) {
      const reference = element.style;
      if (reference?.kind === 'text' && !textStyles.some((style) => style.name.toUpperCase() === reference.name.toUpperCase())) {
        throw new Error(`Cannot preserve complex linetype "${lt.name}": text STYLE "${reference.name}" is missing.`);
      }
    }
  }
  const requiredTextStyles = new Set([header.textStyle, ds.textStyle, ...allEntities.map((e) => e.type === 'dimension' ? e.style.textStyle : textStyleOf(e)), ...dims3dAs2d.map(d => d.style.textStyle)].filter((n): n is string => !!n));
  for (const name of requiredTextStyles) if (!textStyles.some((style) => style.name.toUpperCase() === name.toUpperCase())) textStyles.push({ ...STANDARD_TEXT_STYLE, name });
  for (const style of textStyles) w.textStyleHandles.set(style.name.toUpperCase(), w.nextHandle());
  const shapeHandles = new Map<string, string>();
  for (const [sourceId, shape] of shapeStyles) {
    const problem = linetypeShapeStyleProblem(shape);
    if (!sourceId || sourceId.length > 255 || /[\u0000\r\n]/.test(sourceId) || problem) throw new Error(`Cannot preserve shape STYLE resource "${sourceId}": ${problem || 'invalid identity'}.`);
    shapeHandles.set(sourceId, w.nextHandle());
  }
  // Choose the highest native format required anywhere, including associated text/attributes.
  const appearances = [...allEntities, ...state.layers, ...blockList.flatMap((b) => b.attributes),
    ...allEntities.flatMap<AttributeAppearance>((e) => e.type === 'insert' ? Object.values(e.attributePlacements ?? {}) : e.type === 'leader' && e.textAppearance ? [e.textAppearance] : [])];
  const appearanceVersion = allEntities.some((e) => (entityMTextBackground(e)?.flags ?? 0) & 16) ? 'AC1032'
    : appearances.some((e) => e.transparency !== undefined) ? 'AC1024'
      : allEntities.some((e) => entityMTextBackground(e)) ? 'AC1021'
        : allEntities.some((e) => e.type === 'hatch' && e.gradient) || appearances.some((e) => e.colorName !== undefined || e.trueColor !== undefined) ? 'AC1018' : 'AC1015';
  const sourceVersion = state.cadGraph?.sourceVersion;
  const acadVersion = sourceVersion && /^AC10(?:15|18|21|24|27|32)$/.test(sourceVersion) && sourceVersion > appearanceVersion ? sourceVersion : appearanceVersion;
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
  // 2D points: $LIMMIN / $LIMMAX have no Z (group 30) in AC1015.
  const hpt = (name: string, p: g.Point) => {
    w.pair(9, name);
    w.pair(10, p.x);
    w.pair(20, p.y);
  };
  hv('$ACADVER', 1, acadVersion);
  hv('$DWGCODEPAGE', 3, 'ANSI_1252');
  hv('$HANDSEED', 5, 'HANDSEED_PLACEHOLDER');
  hv('$INSUNITS', 70, header.units.insunits);
  hv('$LUNITS', 70, header.units.lunits);
  hv('$LUPREC', 70, header.units.luprec);
  hv('$AUNITS', 70, header.units.aunits ?? 0);
  hv('$AUPREC', 70, header.units.auprec);
  hv('$CLAYER', 8, state.currentLayer);
  hv('$CELTYPE', 6, header.celtype || 'ByLayer');
  hv('$CELWEIGHT', 370, header.celweight === undefined ? -1 : Math.round(header.celweight * 100));
  hv('$LTSCALE', 40, header.ltscale);
  hv('$CELTSCALE', 40, header.celtscale ?? 1);
  hpt('$LIMMIN', header.limits.min);
  hpt('$LIMMAX', header.limits.max);
  hv('$PDMODE', 70, header.pdmode);
  hv('$PDSIZE', 40, header.pdsize);
  hv('$TEXTSTYLE', 7, encodeDxfText(header.textStyle || 'Standard'));
  hv('$DIMSTYLE', 2, ds.name);
  for (const [name, code, value] of dimHeaderVars(ds)) if (name !== 'DIMLUNIT') hv(`$${name}`, code, value);
  hv('$DIMLUNIT', 70, ds.lunit);
  // No $CANNOSCALE / $ANNOALLVISIBLE here: not HEADER variables (Q11 F2 rework) —
  // they are written as DICTIONARYVARs in OBJECTS below.
  w.pair(0, 'ENDSEC');

  // CLASSES: the plot style dictionary's object types, and raster images' when there are images.
  w.pair(0, 'SECTION');
  w.pair(2, 'CLASSES');
  {
    const cls = (name: string, cpp: string, flags: number, isEntity: boolean, instances = 1) => {
      w.pair(0, 'CLASS');
      w.pair(1, name);
      w.pair(2, cpp);
      w.pair(3, 'ISM');
      w.pair(90, flags);
      if (acadVersion !== 'AC1015') w.pair(91, instances);
      w.pair(280, 0);
      w.pair(281, isEntity ? 1 : 0);
    };
    cls('ACDBDICTIONARYWDFLT', 'AcDbDictionaryWithDefault', 0, false);
    cls('ACDBPLACEHOLDER', 'AcDbPlaceHolder', 0, false);
    if (imageDict) {
      cls('IMAGE', 'AcDbRasterImage', 127, true, extras.imageReactors.size);
      cls('IMAGEDEF', 'AcDbRasterImageDef', 0, false, extras.imageDefs.size);
      cls('IMAGEDEF_REACTOR', 'AcDbRasterImageDefReactor', 1, false, extras.imageReactors.size);
    }
    if (variableDictionary) {
      // AutoCAD's specimen registration (the HANDBUILT fixtures): app name
      // 'ObjectDBX Classes', instance count = the DICTIONARYVARs created below.
      w.pair(0, 'CLASS');
      w.pair(1, 'DICTIONARYVAR');
      w.pair(2, 'AcDbDictionaryVar');
      w.pair(3, 'ObjectDBX Classes');
      w.pair(90, 0);
      if (acadVersion !== 'AC1015') w.pair(91, (cannoVariable ? 1 : 0) + (annoVariable ? 1 : 0));
      w.pair(280, 0);
      w.pair(281, 0);
    }
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
  const record = (kind: string, owner: string, subclass: string, name: string, flags = 0, reservedHandle?: string) => {
    w.pair(0, kind);
    w.pair(5, reservedHandle ?? w.nextHandle());
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
      record('LTYPE', '5', 'AcDbLinetypeTableRecord', lt.name, lt.complex?.flags ?? 0);
      w.pair(3, lt.description);
      w.pair(72, lt.complex?.alignment ?? 65);
      w.pair(73, lt.pattern.length);
      w.pair(40, lt.complex?.totalPatternLength ?? patternLength(lt.pattern));
      writeComplexLinetypeElements(w, lt, shapeHandles);
    };
    ltRecord({ name: 'ByBlock', description: '', pattern: [] });
    ltRecord({ name: 'ByLayer', description: '', pattern: [] });
    ltRecord(STANDARD_LINETYPES[0]!);
    for (const lt of linetypes) ltRecord(lt);
  });
  const layerHandles = new Map<string, string>();
  // Layers of retained raw records that were deleted since: written so the records stay valid.
  const graphHandles = new Set(state.cadGraph?.nodes.flatMap(node => node.sourceHandle ? [node.sourceHandle.toUpperCase()] : []) ?? []);
  const rawRecords = rawEntitiesOf(state).filter(record => !record.handle || !graphHandles.has(record.handle.toUpperCase()));
  const layerList: Layer[] = [...state.layers];
  for (const r of rawRecords) if (!layerList.some((l) => l.name === r.layer)) layerList.push({ name: r.layer, color: 7, visible: true, locked: false, lineWeight: 0.25 });
  // Likewise the layers of 3D solids and dimensions (the model3d helpers do not keep the layer table in step).
  for (const s of [...(state.model3d?.solids ?? []), ...dims3d]) if (!layerList.some((l) => l.name === s.layer)) layerList.push({ name: s.layer, color: 7, visible: true, locked: false, lineWeight: 0.25 });
  table('LAYER', '2', layerList.length, () => {
    for (const l of layerList) {
      // Flags 16 / 32 (xref-dependent, resolved) are kept from the source file.
      record('LAYER', '2', 'AcDbLayerTableRecord', l.name, (l.locked ? 4 : 0) | (l.frozen ? 1 : 0) | ((l.xrefFlags ?? 0) & 48));
      layerHandles.set(l.name, w.lastHandle().toString(16).toUpperCase());
      w.pair(62, l.visible || l.frozen ? l.color : -l.color);
      if (l.trueColor !== undefined) w.pair(420, l.trueColor & 0xffffff);
      if (l.colorName !== undefined) {
        if (!validColorName(l.colorName)) throw new Error('Invalid layer named/color-book identity.');
        w.pair(430, l.colorName);
      }
      w.pair(6, l.linetype && l.linetype.toUpperCase() !== 'BYLAYER' ? l.linetype : 'Continuous');
      w.pair(370, Math.round(l.lineWeight * 100));
      if (l.plot === false) w.pair(290, 0);
      w.pair(390, normalPlotStyle);
      if (l.transparency !== undefined) {
        w.pair(1001, LAYER_TRANSPARENCY_APP);
        w.pair(1071, transparencyToDxf(l.transparency));
      }
    }
  });
  table('STYLE', '3', textStyles.length + shapeStyles.length, () => {
    for (const ts of textStyles) {
      record('STYLE', '3', 'AcDbTextStyleTableRecord', encodeDxfText(ts.name), ts.flags, w.textStyleHandles.get(ts.name.toUpperCase()));
      for (const [code, value] of textStyleGroups(ts)) w.pair(code, value);
    }
    for (const [sourceId, shape] of shapeStyles) {
      record('STYLE', '3', 'AcDbTextStyleTableRecord', encodeDxfText(shape.name), shape.flags, shapeHandles.get(sourceId));
      w.anchor(shapeHandles.get(sourceId)!, { kind: 'shape-style', sourceId });
      for (const [code, value] of shapeStyleGroups(shape)) w.pair(code, value);
    }
  });
  table('VIEW', '6', header.views.length, () => {
    for (const v of header.views) {
      record('VIEW', '6', 'AcDbViewTableRecord', v.name, v.camera?.flags ?? 0);
      const camera = v.camera;
      const center = camera ? planarNamedCamera(camera) ? namedCameraDisplayCenter({ ...camera, twist: v.twist ?? camera.twist }, v.center) : camera.displayCenter : v.center;
      w.pair(40, v.height);
      w.pair(10, center.x);
      w.pair(20, center.y);
      w.pair(41, v.width ?? camera?.width ?? v.height * 1.5);
      w.pair(11, camera?.direction.x ?? 0);
      w.pair(21, camera?.direction.y ?? 0);
      w.pair(31, camera?.direction.z ?? 1);
      w.pair(12, camera?.target.x ?? 0);
      w.pair(22, camera?.target.y ?? 0);
      w.pair(32, camera?.target.z ?? 0);
      w.pair(42, camera?.lensLength ?? 50);
      w.pair(43, camera?.frontClip ?? 0);
      w.pair(44, camera?.backClip ?? 0);
      w.pair(50, g.deg(v.twist ?? camera?.twist ?? 0));
      w.pair(71, camera?.mode ?? 0);
    }
  });
  table('UCS', '7', 0, () => {});
  const annotative = allEntities.some((e) => e.annotative);
  // Priority 30: JCAD_DYNAMIC is registered only when a definition or instance payload exists.
  const dynamicApp = blockList.some((b) => b.dynamic || b.dynamicRetained) || allEntities.some((e) => e.type === 'insert' && (e.dynamic || e.dynamicRetained));
  // Priority 30.4: JCAD_CONSTRAINTS likewise, only when a set (or its retained payload) exists.
  const constraintsApp = state.constraints !== undefined || state.constraintsRetained !== undefined;
  const columnMtext = allEntities.some((e) => e.type === 'mtext' ? e.columns : e.type === 'leader' && e.textColumns);
  const layerTransparency = state.layers.some((l) => l.transparency !== undefined);
  const inactiveMtext = allEntities.some((e) => entityMTextBackground(e)?.flags === 0);
  // Experimental 3D solids (polyface meshes with JCAD_3D data); a 2D drawing writes none of this.
  const solids = state.model3d?.solids ?? [];
  const model3dApp = solids.length > 0 || dims3d.length > 0;
  table('APPID', '9', (tableList.length ? 3 : 2) + (annotative ? 1 : 0) + (columnMtext ? 1 : 0) + (layerTransparency ? 1 : 0) + (inactiveMtext ? 1 : 0) + (model3dApp ? 1 : 0) + (dynamicApp ? 1 : 0) + (constraintsApp ? 1 : 0), () => {
    record('APPID', '9', 'AcDbRegAppTableRecord', 'ACAD');
    record('APPID', '9', 'AcDbRegAppTableRecord', DIMSTYLE_APP);
    if (tableList.length) record('APPID', '9', 'AcDbRegAppTableRecord', TABLE_APP);
    if (dynamicApp) record('APPID', '9', 'AcDbRegAppTableRecord', DYNAMIC_APP);
    if (constraintsApp) record('APPID', '9', 'AcDbRegAppTableRecord', CONSTRAINTS_APP);
    if (annotative) record('APPID', '9', 'AcDbRegAppTableRecord', ANNO_APP);
    if (columnMtext) record('APPID', '9', 'AcDbRegAppTableRecord', MTEXT_COLUMNS_APP);
    if (layerTransparency) record('APPID', '9', 'AcDbRegAppTableRecord', LAYER_TRANSPARENCY_APP);
    if (inactiveMtext) record('APPID', '9', 'AcDbRegAppTableRecord', MTEXT_BACKGROUND_APP);
    if (model3dApp) record('APPID', '9', 'AcDbRegAppTableRecord', MODEL3D_APP);
  });
  // Dimensions on layouts count too, so their (unnamed) styles get a record.
  const dimStyleList = dimStylesToWrite(state, dims3dAs2d.length ? [...allEntities, ...dims3dAs2d] : allEntities);
  for (const style of dimStyleList) w.dimensionStyles.set(style.name.toUpperCase(), style);
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
      w.pair(340, w.textStyleHandles.get((style.textStyle ?? 'Standard').toUpperCase()) ?? w.textStyleHandles.get('STANDARD')!);
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
  const blockShell = (owner: string, name: string, base: { x: number; y: number }, flags: number, description: string | undefined, body: () => void, path = '', xdataBody?: () => void) => {
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
    // XDATA on the BLOCK record itself (priority 30 definition carrier): after the
    // AcDbBlockBegin groups, before the first block entity — the only position that
    // attaches the payload to the BLOCK object.
    if (xdataBody) xdataBody();
    body();
    w.pair(0, 'ENDBLK');
    w.pair(5, w.nextHandle());
    w.pair(330, owner);
    w.pair(100, 'AcDbEntity');
    w.pair(8, '0');
    w.pair(100, 'AcDbBlockEnd');
  };
  blockShell(MODEL_SPACE, '*Model_Space', { x: 0, y: 0 }, 0, undefined, () => {}, '', () => {
    // Priority 30.4 drawing-level carrier: the constraint set rides the
    // *Model_Space BLOCK record (the drawing's one always-present record),
    // the same attachment JCAD_DYNAMIC uses on named BLOCK records. A
    // modeled set is re-encoded canonically against the entities being
    // written; a retained payload is re-emitted verbatim (chunked only),
    // never re-escaped or re-shaped. A constraints-free drawing emits
    // nothing here (and registers no APPID above): the fixed point holds.
    const payload = state.constraints ? encodeConstraints(state.constraints, state.entities.map((e) => e.id)) : state.constraintsRetained;
    if (payload === undefined) return;
    w.pair(1001, CONSTRAINTS_APP);
    for (const chunk of chunkDynamicPayload(payload)) w.pair(1000, chunk);
  });
  blockShell(PAPER_SPACE, '*Paper_Space', { x: 0, y: 0 }, 0, undefined, () => {});
  // Layouts after the first keep their paper space in *Paper_Space0, *Paper_Space1 ...
  const writePaperEntity = (e: Entity, owner: string) => writeEntityAnno(w, e, owner, state.blocks, dimBlocks, extras);
  for (const r of layoutPlan.records.slice(1)) blockShell(r.blockRecord, r.blockName, { x: 0, y: 0 }, 0, undefined, () => writeLayoutContent(w, r, writePaperEntity, layerHandles));
  for (const b of blockList) {
    const owner = blockRecordHandles.get(b.name)!;
    // Anonymous blocks (*T tables, *U dynamic blocks) must carry flag 1 or AutoCAD rejects the name.
    const xrefFlags = b.xref ? 4 | (b.xref.overlay ? 8 : 0) : 0;
    blockShell(owner, b.name, b.basePoint, (b.attributes.length > 0 ? 2 : 0) | (b.name.startsWith('*') ? 1 : 0) | xrefFlags, b.description, () => {
      for (const e of b.entities) writeEntityAnno(w, e, owner, state.blocks, dimBlocks, extras);
      for (const a of b.attributes) {
        writeEntityCommon(w, { ...a, id: a.tag, type: 'text', text: a.default, rotation: a.rotation ?? 0, color: a.color ?? 'ByLayer', layer: a.layer ?? '0' }, owner, 'ATTDEF', 'AcDbText');
        writeTextLike(w, a.position, a.height, a.default, a.rotation ?? 0, a.align, a);
        writeTextStyle(w, a);
        w.pair(100, 'AcDbAttributeDefinition');
        w.pair(3, a.prompt);
        w.pair(2, a.tag);
        w.pair(70, attdefFlags(a));
        if (a.justification?.vertical) w.pair(74, a.justification.vertical);
      }
    }, b.xref?.path ?? '', () => {
      // A modeled definition is re-encoded canonically; a retained payload is
      // re-emitted verbatim (chunked only), never re-escaped or re-shaped.
      const payload = b.dynamic ? encodeDynamicDefinition(b.dynamic, b.entities.map((e) => e.id)) : b.dynamicRetained;
      if (payload === undefined) return;
      w.pair(1001, DYNAMIC_APP);
      for (const chunk of chunkDynamicPayload(payload)) w.pair(1000, chunk);
    });
  }
  for (const [t, name] of tableList) {
    const owner = blockRecordHandles.get(name)!;
    blockShell(owner, name, { x: 0, y: 0 }, 1, undefined, () => {
      for (const part of tableParts(t)) writeEntity(w, part, owner, state.blocks, undefined, extras);
    });
  }
  for (const { name, dimension } of dimPictures) {
    const owner = blockRecordHandles.get(name)!;
    blockShell(owner, name, { x: 0, y: 0 }, 1, undefined, () => {
      for (const part of dimensionParts(dimension)) writeEntity(w, { ...part, color: part.color === 'ByLayer' ? 0 : part.color } as Entity, owner, state.blocks);
    });
  }
  for (const d of dims3d) {
    const name = dim3dBlocks.get(d.id)!;
    const owner = blockRecordHandles.get(name)!;
    blockShell(owner, name, { x: 0, y: 0 }, 1, undefined, () => writeDimension3DPicture(w, d, owner));
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
  // Experimental 3D solids: one polyface mesh (or several for a very large mesh) each, in model space.
  const solidNodes = new Map<string, CadNode[]>();
  for (const node of state.cadGraph?.nodes ?? []) if (node.anchor?.kind === 'solid3d') {
    const list = solidNodes.get(node.anchor.id);
    if (list) list.push(node); else solidNodes.set(node.anchor.id, [node]);
  }
  for (const s of solids) if (!writeRetainedSolid(w, state, s, MODEL_SPACE, solidNodes.get(s.id) ?? [])) writeSolid(w, s, MODEL_SPACE);
  // Experimental true 3D dimensions: DIMENSIONs in their planes (OCS), with JCAD_3D data.
  for (const d of dims3d) writeDimension3D(w, d, MODEL_SPACE, dim3dBlocks.get(d.id)!);
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
  w.pair(3, 'ACAD_PLOTSTYLENAME');
  w.pair(350, plotStyleDictionary);
  if (imageDict) {
    w.pair(3, 'ACAD_IMAGE_DICT');
    w.pair(350, imageDict);
  }
  if (variableDictionary) {
    // AutoCAD keeps the variable dictionary as the root dictionary's last entry.
    w.pair(3, 'AcDbVariableDictionary');
    w.pair(350, variableDictionary);
  }
  w.pair(0, 'DICTIONARY');
  w.pair(5, 'D');
  w.pair(330, 'C');
  w.pair(100, 'AcDbDictionary');
  w.pair(281, 1);
  writeLayoutObjects(w, layoutPlan, MODEL_SPACE, 'C');
  w.pair(0, 'ACDBDICTIONARYWDFLT');
  w.pair(5, plotStyleDictionary);
  w.pair(330, 'C');
  w.pair(100, 'AcDbDictionary');
  w.pair(281, 1);
  w.pair(3, 'Normal');
  w.pair(350, normalPlotStyle);
  w.pair(100, 'AcDbDictionaryWithDefault');
  w.pair(340, normalPlotStyle);
  w.pair(0, 'ACDBPLACEHOLDER');
  w.pair(5, normalPlotStyle);
  w.pair(330, plotStyleDictionary);
  if (variableDictionary) {
    // The variable dictionary and its DICTIONARYVARs, in AutoCAD's exact shape.
    w.pair(0, 'DICTIONARY');
    w.pair(5, variableDictionary);
    w.pair(330, 'C');
    w.pair(100, 'AcDbDictionary');
    w.pair(281, 1);
    if (cannoVariable) { w.pair(3, 'CANNOSCALE'); w.pair(350, cannoVariable); }
    if (annoVariable) { w.pair(3, 'ANNOALLVISIBLE'); w.pair(350, annoVariable); }
    const dictionaryVariable = (handle: string, val: string) => {
      w.pair(0, 'DICTIONARYVAR');
      w.pair(5, handle);
      w.pair(102, '{ACAD_REACTORS');
      w.pair(330, variableDictionary);
      w.pair(102, '}');
      w.pair(330, variableDictionary);
      w.pair(100, 'DictionaryVariables');
      w.pair(280, 0);
      w.pair(1, val);
    };
    if (cannoVariable) dictionaryVariable(cannoVariable, state.header!.cannoscale!);
    if (annoVariable) dictionaryVariable(annoVariable, '0');
  }
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
  const plain = preserveDxfCadGraph(w.toString(), state, w.cadAnchors);
  return encodeDxfText(plain.replace('HANDSEED_PLACEHOLDER', (w.lastHandle() + 1).toString(16).toUpperCase()), acadVersion);
}
