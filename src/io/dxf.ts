/**
 * DXF (AC1015 / AutoCAD 2000) reader and writer.
 * Entities: LINE, CIRCLE, ARC, LWPOLYLINE (bulges, constant width), POLYLINE,
 * TEXT, MTEXT, INSERT (+ ATTRIB), ELLIPSE, POINT, XLINE, RAY, SOLID/TRACE,
 * DIMENSION (with its anonymous *D block). Tables: LAYER (linetype, lineweight,
 * frozen/off/locked), LTYPE (dash patterns), VIEW, DIMSTYLE, BLOCK_RECORD.
 * Header: units, limits, LTSCALE, PDMODE/PDSIZE, DIM* variables, CELTYPE/CELWEIGHT.
 */
import type { Entity, BlockDef, Layer, AttributeDef, ColorSpec, DimensionEntity, PolylineEntity, MTextEntity, DimStyle } from '../core/entities';
import { newId, dimensionParts, textWidth, insertTransform } from '../core/entities';
import { dimensionTextPoint, dimensionMeasurement, STANDARD_DIMSTYLE } from '../core/dimension';
import { mtextToDxf, mtextFromDxf, type MTextAttachment } from '../core/mtext';
import type { DrawingState, DrawingHeader, NamedView } from '../core/document';
import { DEFAULT_LAYERS, DEFAULT_HEADER } from '../core/document';
import { STANDARD_LINETYPES, findLinetype, patternLength, type Linetype } from '../core/linetypes';
import type { LinearUnits } from '../core/units';
import * as g from '../core/geometry';

// ---------------------------------------------------------------- writing

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const s = n.toFixed(10).replace(/\.?0+$/, '');
  return s === '-0' || s === '' ? '0' : s;
}

class Writer {
  private out: string[] = [];
  private handle = 0x100;
  pair(code: number, value: string | number): void {
    this.out.push(String(code), typeof value === 'number' ? fmt(value) : value);
  }
  nextHandle(): string {
    this.handle += 1;
    return this.handle.toString(16).toUpperCase();
  }
  lastHandle(): number {
    return this.handle;
  }
  toString(): string {
    return this.out.join('\r\n') + '\r\n';
  }
}

function colorCode(c: ColorSpec): number {
  return c === 'ByLayer' ? 256 : c;
}

function writeEntityCommon(w: Writer, e: Entity, owner: string, kind: string, subclass: string): void {
  w.pair(0, kind);
  w.pair(5, w.nextHandle());
  w.pair(330, owner);
  w.pair(100, 'AcDbEntity');
  w.pair(8, e.layer);
  if (e.linetype && e.linetype.toUpperCase() !== 'BYLAYER') w.pair(6, e.linetype);
  if (e.color !== 'ByLayer') w.pair(62, colorCode(e.color));
  if (e.ltscale !== undefined && e.ltscale !== 1) w.pair(48, e.ltscale);
  if (e.lineWeight !== undefined) w.pair(370, e.lineWeight < 0 ? Math.round(e.lineWeight) : Math.round(e.lineWeight * 100));
  w.pair(100, subclass);
}

function writeTextLike(w: Writer, position: g.Point, height: number, text: string, rotation: number, align: 'left' | 'center' | 'right'): void {
  w.pair(10, position.x);
  w.pair(20, position.y);
  w.pair(30, 0);
  w.pair(40, height);
  w.pair(1, text);
  if (rotation !== 0) w.pair(50, g.deg(rotation));
  const h = align === 'center' ? 1 : align === 'right' ? 2 : 0;
  if (h !== 0) {
    w.pair(72, h);
    w.pair(11, position.x);
    w.pair(21, position.y);
    w.pair(31, 0);
  }
}

function writePolyline(w: Writer, e: PolylineEntity, owner: string): void {
  if (e.filled && e.closed && (e.points.length === 3 || e.points.length === 4)) {
    // Filled triangles/quads (dimension arrowheads) are SOLIDs so every reader fills them.
    writeEntityCommon(w, e, owner, 'SOLID', 'AcDbTrace');
    const p = e.points;
    // SOLID vertex order is 1-2-4-3 (bow tie convention)
    const order = p.length === 3 ? [p[0]!, p[1]!, p[2]!, p[2]!] : [p[0]!, p[1]!, p[3]!, p[2]!];
    order.forEach((pt, i) => {
      w.pair(10 + i, pt.x);
      w.pair(20 + i, pt.y);
      w.pair(30 + i, 0);
    });
    return;
  }
  writeEntityCommon(w, e, owner, 'LWPOLYLINE', 'AcDbPolyline');
  w.pair(90, e.points.length);
  w.pair(70, e.closed ? 1 : 0);
  if (e.width) w.pair(43, e.width);
  e.points.forEach((p, i) => {
    w.pair(10, p.x);
    w.pair(20, p.y);
    const b = e.bulges?.[i] ?? 0;
    if (Math.abs(b) > 1e-12) w.pair(42, b);
  });
}

function writeMText(w: Writer, e: MTextEntity, owner: string): void {
  writeEntityCommon(w, e, owner, 'MTEXT', 'AcDbMText');
  w.pair(10, e.position.x);
  w.pair(20, e.position.y);
  w.pair(30, 0);
  w.pair(40, e.height);
  w.pair(41, e.width);
  w.pair(71, e.attachment);
  w.pair(72, 1);
  const text = mtextToDxf(e.text);
  // Long strings go in 250-char chunks of code 3 followed by a final code 1.
  let rest = text;
  while (rest.length > 250) {
    w.pair(3, rest.slice(0, 250));
    rest = rest.slice(250);
  }
  w.pair(1, rest);
  w.pair(7, 'Standard');
  w.pair(11, Math.cos(e.rotation));
  w.pair(21, Math.sin(e.rotation));
  w.pair(31, 0);
  w.pair(73, 1);
  w.pair(44, e.lineSpacing || 1);
}

const DIM_TYPE: Record<DimensionEntity['kind'], number> = { linear: 0, aligned: 1, angular: 5, diameter: 3, radius: 4 };

function radialPoints(e: DimensionEntity): { q: g.Point; far: g.Point } {
  const r = g.dist(e.p1, e.p2);
  const toLoc = g.sub(e.linePoint, e.p1);
  const dir = g.len(toLoc) > 1e-9 ? g.normalize(toLoc) : g.normalize(g.sub(e.p2, e.p1));
  return { q: g.add(e.p1, g.scale(dir, r)), far: g.sub(e.p1, g.scale(dir, r)) };
}

function writeDimension(w: Writer, e: DimensionEntity, owner: string, blockName: string): void {
  writeEntityCommon(w, e, owner, 'DIMENSION', 'AcDbDimension');
  w.pair(280, 0);
  w.pair(2, blockName);
  let defpoint: g.Point;
  switch (e.kind) {
    case 'linear':
    case 'aligned': {
      const u = e.kind === 'linear' ? { x: Math.cos(e.rotation), y: Math.sin(e.rotation) } : g.len(g.sub(e.p2, e.p1)) > 1e-12 ? g.normalize(g.sub(e.p2, e.p1)) : { x: 1, y: 0 };
      defpoint = g.add(e.linePoint, g.scale(u, g.dot(g.sub(e.p2, e.linePoint), u)));
      break;
    }
    case 'radius':
      defpoint = e.p1;
      break;
    case 'diameter':
      defpoint = radialPoints(e).q;
      break;
    case 'angular':
      defpoint = e.linePoint;
      break;
  }
  w.pair(10, defpoint.x);
  w.pair(20, defpoint.y);
  w.pair(30, 0);
  const tp = e.textPosition ?? dimensionTextPoint(e, textWidth);
  w.pair(11, tp.x);
  w.pair(21, tp.y);
  w.pair(31, 0);
  w.pair(70, DIM_TYPE[e.kind] | 32 | (e.textPosition ? 128 : 0));
  w.pair(71, 5);
  w.pair(42, dimensionMeasurement(e));
  if (e.text !== undefined && e.text !== '') w.pair(1, e.text);
  w.pair(3, e.style.name);
  switch (e.kind) {
    case 'linear':
    case 'aligned':
      w.pair(100, 'AcDbAlignedDimension');
      w.pair(13, e.p1.x);
      w.pair(23, e.p1.y);
      w.pair(33, 0);
      w.pair(14, e.p2.x);
      w.pair(24, e.p2.y);
      w.pair(34, 0);
      if (e.kind === 'linear') {
        w.pair(50, g.deg(e.rotation));
        w.pair(100, 'AcDbRotatedDimension');
      }
      break;
    case 'radius':
    case 'diameter': {
      w.pair(100, e.kind === 'radius' ? 'AcDbRadialDimension' : 'AcDbDiametricDimension');
      const { q, far } = radialPoints(e);
      const p15 = e.kind === 'radius' ? q : far;
      w.pair(15, p15.x);
      w.pair(25, p15.y);
      w.pair(35, 0);
      w.pair(40, Math.max(0, g.dist(e.linePoint, q)));
      break;
    }
    case 'angular':
      w.pair(100, 'AcDb3PointAngularDimension');
      w.pair(13, e.p1.x);
      w.pair(23, e.p1.y);
      w.pair(33, 0);
      w.pair(14, e.p2.x);
      w.pair(24, e.p2.y);
      w.pair(34, 0);
      w.pair(15, e.center?.x ?? 0);
      w.pair(25, e.center?.y ?? 0);
      w.pair(35, 0);
      break;
  }
}

function writeEntity(w: Writer, e: Entity, owner: string, blocks: Readonly<Record<string, BlockDef>>, dimBlocks?: Map<string, string>): void {
  switch (e.type) {
    case 'line':
      writeEntityCommon(w, e, owner, 'LINE', 'AcDbLine');
      w.pair(10, e.a.x);
      w.pair(20, e.a.y);
      w.pair(30, 0);
      w.pair(11, e.b.x);
      w.pair(21, e.b.y);
      w.pair(31, 0);
      break;
    case 'circle':
      if (e.filled) {
        // Solid dot: a DONUT with zero inner radius = closed LWPOLYLINE of two bulge-1 vertices with constant width.
        writeEntityCommon(w, e, owner, 'LWPOLYLINE', 'AcDbPolyline');
        w.pair(90, 2);
        w.pair(70, 1);
        w.pair(43, e.radius);
        w.pair(10, e.center.x - e.radius / 2);
        w.pair(20, e.center.y);
        w.pair(42, 1);
        w.pair(10, e.center.x + e.radius / 2);
        w.pair(20, e.center.y);
        w.pair(42, 1);
        break;
      }
      writeEntityCommon(w, e, owner, 'CIRCLE', 'AcDbCircle');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(40, e.radius);
      break;
    case 'arc':
      writeEntityCommon(w, e, owner, 'ARC', 'AcDbCircle');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(40, e.radius);
      w.pair(100, 'AcDbArc');
      w.pair(50, g.deg(g.normAngle(e.startAngle)));
      w.pair(51, g.deg(g.normAngle(e.endAngle)));
      break;
    case 'polyline':
      writePolyline(w, e, owner);
      break;
    case 'text': {
      writeEntityCommon(w, e, owner, 'TEXT', 'AcDbText');
      writeTextLike(w, e.position, e.height, e.text, e.rotation, e.align);
      w.pair(100, 'AcDbText');
      break;
    }
    case 'mtext':
      writeMText(w, e, owner);
      break;
    case 'ellipse':
      writeEntityCommon(w, e, owner, 'ELLIPSE', 'AcDbEllipse');
      w.pair(10, e.center.x);
      w.pair(20, e.center.y);
      w.pair(30, 0);
      w.pair(11, e.majorAxis.x);
      w.pair(21, e.majorAxis.y);
      w.pair(31, 0);
      w.pair(210, 0);
      w.pair(220, 0);
      w.pair(230, 1);
      w.pair(40, e.ratio);
      w.pair(41, e.startParam);
      w.pair(42, e.endParam);
      break;
    case 'point':
      writeEntityCommon(w, e, owner, 'POINT', 'AcDbPoint');
      w.pair(10, e.position.x);
      w.pair(20, e.position.y);
      w.pair(30, 0);
      break;
    case 'xline':
    case 'ray': {
      writeEntityCommon(w, e, owner, e.type === 'xline' ? 'XLINE' : 'RAY', e.type === 'xline' ? 'AcDbXline' : 'AcDbRay');
      const d = g.normalize(e.direction);
      w.pair(10, e.base.x);
      w.pair(20, e.base.y);
      w.pair(30, 0);
      w.pair(11, d.x);
      w.pair(21, d.y);
      w.pair(31, 0);
      break;
    }
    case 'dimension':
      writeDimension(w, e, owner, dimBlocks?.get(e.id) ?? '*D0');
      break;
    case 'insert': {
      const block = blocks[e.block];
      const hasAttribs = block ? block.attributes.length > 0 : false;
      writeEntityCommon(w, e, owner, 'INSERT', 'AcDbBlockReference');
      if (hasAttribs) w.pair(66, 1);
      w.pair(2, e.block);
      w.pair(10, e.position.x);
      w.pair(20, e.position.y);
      w.pair(30, 0);
      const sy = e.scaleY ?? e.scale;
      if (e.scale !== 1 || sy !== 1 || e.mirror) {
        w.pair(41, e.mirror ? -e.scale : e.scale);
        w.pair(42, sy);
        w.pair(43, e.scale);
      }
      if (e.rotation !== 0) w.pair(50, g.deg(e.rotation));
      if (hasAttribs && block) {
        const toWorld = insertTransform(e, block);
        for (const a of block.attributes) {
          const value = e.attributes[a.tag] ?? a.default;
          // Attribute position in world space
          const world = toWorld(a.position);
          w.pair(0, 'ATTRIB');
          w.pair(5, w.nextHandle());
          w.pair(330, owner);
          w.pair(100, 'AcDbEntity');
          w.pair(8, e.layer);
          w.pair(100, 'AcDbText');
          writeTextLike(w, world, a.height * Math.sqrt(e.scale * sy), value, e.rotation + (a.rotation ?? 0), e.mirror ? (a.align === 'left' ? 'right' : a.align === 'right' ? 'left' : a.align) : a.align);
          w.pair(100, 'AcDbAttribute');
          w.pair(2, a.tag);
          w.pair(70, a.invisible || e.hiddenAttributes?.includes(a.tag) ? 1 : 0);
        }
        w.pair(0, 'SEQEND');
        w.pair(5, w.nextHandle());
        w.pair(330, owner);
        w.pair(100, 'AcDbEntity');
        w.pair(8, e.layer);
      }
      break;
    }
  }
}

/** Linetype names referenced anywhere in the drawing (layers, entities, block entities). */
function usedLinetypes(state: DrawingState): Linetype[] {
  const names = new Set<string>();
  for (const l of state.layers) if (l.linetype) names.add(l.linetype.toUpperCase());
  const scan = (list: readonly Entity[]) => {
    for (const e of list) if (e.linetype) names.add(e.linetype.toUpperCase());
  };
  scan(state.entities);
  for (const b of Object.values(state.blocks)) scan(b.entities);
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
  const dimEntities = state.entities.filter((e): e is DimensionEntity => e.type === 'dimension');
  dimEntities.forEach((d, i) => {
    const name = `*D${i + 1}`;
    dimBlocks.set(d.id, name);
    blockRecordHandles.set(name, w.nextHandle());
  });
  const linetypes = usedLinetypes(state);

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
  hv('$DIMSCALE', 40, ds.scale);
  hv('$DIMASZ', 40, ds.arrowSize);
  hv('$DIMEXO', 40, ds.extOffset);
  hv('$DIMEXE', 40, ds.extExtend);
  hv('$DIMTXT', 40, ds.textHeight);
  hv('$DIMCEN', 40, ds.centerMark);
  hv('$DIMGAP', 40, ds.textGap);
  hv('$DIMTAD', 70, 0);
  hv('$DIMTIH', 70, 1);
  hv('$DIMTOH', 70, 1);
  hv('$DIMDEC', 70, ds.decimals);
  hv('$DIMADEC', 70, ds.angularDecimals);
  hv('$DIMLUNIT', 70, ds.lunit);
  w.pair(0, 'ENDSEC');

  // CLASSES (empty)
  w.pair(0, 'SECTION');
  w.pair(2, 'CLASSES');
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
  table('LAYER', '2', state.layers.length, () => {
    for (const l of state.layers) {
      record('LAYER', '2', 'AcDbLayerTableRecord', l.name, (l.locked ? 4 : 0) | (l.frozen ? 1 : 0));
      w.pair(62, l.visible || l.frozen ? l.color : -l.color);
      w.pair(6, l.linetype && l.linetype.toUpperCase() !== 'BYLAYER' ? l.linetype : 'Continuous');
      w.pair(370, Math.round(l.lineWeight * 100));
      w.pair(390, 'F');
    }
  });
  table('STYLE', '3', 1, () => {
    record('STYLE', '3', 'AcDbTextStyleTableRecord', 'Standard');
    w.pair(40, 0);
    w.pair(41, 1);
    w.pair(50, 0);
    w.pair(71, 0);
    w.pair(42, 0.2);
    w.pair(3, 'txt');
    w.pair(4, '');
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
  table('APPID', '9', 1, () => {
    record('APPID', '9', 'AcDbRegAppTableRecord', 'ACAD');
  });
  table('DIMSTYLE', 'A', 1, () => {
    w.pair(100, 'AcDbDimStyleTable');
    w.pair(0, 'DIMSTYLE');
    w.pair(105, w.nextHandle());
    w.pair(330, 'A');
    w.pair(100, 'AcDbSymbolTableRecord');
    w.pair(100, 'AcDbDimStyleTableRecord');
    w.pair(2, ds.name);
    w.pair(70, 0);
    w.pair(40, ds.scale);
    w.pair(41, ds.arrowSize);
    w.pair(42, ds.extOffset);
    w.pair(44, ds.extExtend);
    w.pair(140, ds.textHeight);
    w.pair(141, ds.centerMark);
    w.pair(147, ds.textGap);
    w.pair(73, 1);
    w.pair(74, 1);
    w.pair(77, 0);
    w.pair(179, ds.angularDecimals);
    w.pair(271, ds.decimals);
    w.pair(277, ds.lunit);
  });
  table('BLOCK_RECORD', '1', 2 + blockRecordHandles.size, () => {
    const brec = (handle: string, name: string) => {
      w.pair(0, 'BLOCK_RECORD');
      w.pair(5, handle);
      w.pair(330, '1');
      w.pair(100, 'AcDbSymbolTableRecord');
      w.pair(100, 'AcDbBlockTableRecord');
      w.pair(2, name);
      w.pair(70, 0);
      w.pair(280, 1);
      w.pair(281, 0);
    };
    brec(MODEL_SPACE, '*Model_Space');
    brec(PAPER_SPACE, '*Paper_Space');
    for (const [name, handle] of blockRecordHandles) brec(handle, name);
  });
  w.pair(0, 'ENDSEC');

  // BLOCKS
  w.pair(0, 'SECTION');
  w.pair(2, 'BLOCKS');
  const blockShell = (owner: string, name: string, base: { x: number; y: number }, flags: number, description: string | undefined, body: () => void) => {
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
    w.pair(1, '');
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
  for (const b of blockList) {
    const owner = blockRecordHandles.get(b.name)!;
    blockShell(owner, b.name, b.basePoint, b.attributes.length > 0 ? 2 : 0, b.description, () => {
      for (const e of b.entities) writeEntity(w, e, owner, state.blocks);
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
        w.pair(70, a.invisible ? 1 : 0);
      }
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
  for (const e of state.entities) writeEntity(w, e, MODEL_SPACE, state.blocks, dimBlocks);
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
  w.pair(0, 'DICTIONARY');
  w.pair(5, 'D');
  w.pair(330, 'C');
  w.pair(100, 'AcDbDictionary');
  w.pair(281, 1);
  w.pair(0, 'ENDSEC');
  w.pair(0, 'EOF');
  // The handle seed must exceed every handle used in the file.
  return w.toString().replace('HANDSEED_PLACEHOLDER', (w.lastHandle() + 1).toString(16).toUpperCase());
}

// ---------------------------------------------------------------- reading

interface Pair {
  code: number;
  value: string;
}

function tokenize(text: string): Pair[] {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i]!.trim(), 10);
    if (Number.isNaN(code)) continue;
    pairs.push({ code, value: lines[i + 1]!.replace(/\s+$/, '') });
  }
  return pairs;
}

interface Obj {
  kind: string;
  groups: Pair[];
}

/** Group pairs into objects starting at each code 0. */
function objects(pairs: Pair[], start: number, end: number): Obj[] {
  const out: Obj[] = [];
  let cur: Obj | null = null;
  for (let i = start; i < end; i += 1) {
    const p = pairs[i]!;
    if (p.code === 0) {
      cur = { kind: p.value, groups: [] };
      out.push(cur);
    } else if (cur) cur.groups.push(p);
  }
  return out;
}

const num = (o: Obj, code: number, dflt = 0): number => {
  const p = o.groups.find((x) => x.code === code);
  if (!p) return dflt;
  const v = parseFloat(p.value);
  return Number.isNaN(v) ? dflt : v;
};
const has = (o: Obj, code: number): boolean => o.groups.some((x) => x.code === code);
const str = (o: Obj, code: number, dflt = ''): string => o.groups.find((x) => x.code === code)?.value ?? dflt;
const pt = (o: Obj, xCode: number, dflt: g.Point = { x: 0, y: 0 }): g.Point => (has(o, xCode) ? { x: num(o, xCode), y: num(o, xCode + 10) } : dflt);

/** Entity properties common to every DXF entity (layer, colour, linetype, lineweight, ltscale). */
function commonProps(o: Obj): { id: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number; ltscale?: number } {
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
  const common = { ...base, type: 'dimension' as const, text, textPosition: userText, style };
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
      return { ...base, type: 'text', position, text: str(o, 1), height, rotation, align };
    }
    case 'MTEXT': {
      // MTEXT: 10/20 attachment corner, 71 attachment point (1..9), 11/21 direction vector, 50 rotation (radians)
      const ap = Math.max(1, Math.min(9, Math.trunc(num(o, 71, 1)))) as MTextAttachment;
      const hasDir = has(o, 11);
      const rotation = hasDir ? Math.atan2(num(o, 21), num(o, 11)) : num(o, 50);
      const height = num(o, 40, 0.125);
      const raw = o.groups
        .filter((x) => x.code === 1 || x.code === 3)
        .map((x) => x.value)
        .join('');
      if (has(o, 41)) {
        return {
          ...base,
          type: 'mtext',
          position: { x: num(o, 10), y: num(o, 20) },
          text: mtextFromDxf(raw),
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
      return { ...base, type: 'text', position, text: mtextFromDxf(raw).replace(/\n/g, ' '), height, rotation, align };
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
    case 'INSERT': {
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
}

/** Parse a list of entity objects, folding ATTRIB/SEQEND into inserts and VERTEX into polylines. */
function readEntities(objs: Obj[], ctx: ReadContext): Entity[] {
  const out: Entity[] = [];
  let i = 0;
  while (i < objs.length) {
    const o = objs[i]!;
    if (o.kind === 'POLYLINE') {
      const pts: g.Point[] = [];
      const bulges: number[] = [];
      const closed = (num(o, 70) & 1) === 1;
      let j = i + 1;
      while (j < objs.length && objs[j]!.kind === 'VERTEX') {
        pts.push({ x: num(objs[j]!, 10), y: num(objs[j]!, 20) });
        bulges.push(num(objs[j]!, 42, 0));
        j += 1;
      }
      if (j < objs.length && objs[j]!.kind === 'SEQEND') j += 1;
      const width = num(o, 40, 0);
      out.push({
        ...commonProps(o),
        type: 'polyline',
        points: pts,
        closed,
        bulges: bulges.some((b) => Math.abs(b) > 1e-12) ? bulges : undefined,
        width: width > 0 ? width : undefined,
      });
      i = j;
      continue;
    }
    const e = readEntityObj(o, ctx);
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
    if (e) out.push(e);
    i += 1;
  }
  return out;
}

function readDimStyleRecord(o: Obj, base: DimStyle): DimStyle {
  const lunit = Math.trunc(num(o, 277, base.lunit));
  return {
    name: str(o, 2) || base.name,
    scale: num(o, 40, base.scale) || 1,
    arrowSize: num(o, 41, base.arrowSize),
    extOffset: num(o, 42, base.extOffset),
    extExtend: num(o, 44, base.extExtend),
    textHeight: num(o, 140, base.textHeight),
    centerMark: num(o, 141, base.centerMark),
    textGap: num(o, 147, base.textGap),
    angularDecimals: Math.max(0, Math.trunc(num(o, 179, base.angularDecimals))),
    decimals: Math.trunc(num(o, 271, base.decimals)),
    lunit: (lunit >= 1 && lunit <= 5 ? lunit : base.lunit) as LinearUnits,
  };
}

export function readDxf(text: string): DrawingState {
  const pairs = tokenize(text);
  const layers: Layer[] = [];
  const blocks: Record<string, BlockDef> = {};
  let entities: Entity[] = [];
  let currentLayer = '0';
  const headerVars = new Map<string, Pair[]>();
  const dimStyles = new Map<string, DimStyle>();
  const linetypes: Linetype[] = [];
  const views: NamedView[] = [];
  // Header DIM* variables define the current style; the DIMSTYLE table gives named styles.
  let headerDimStyle: DimStyle = STANDARD_DIMSTYLE;
  const ctx: ReadContext = { dimStyles, dimStyle: STANDARD_DIMSTYLE, blocks };

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
        const lunit = Math.trunc(hnum('$DIMLUNIT', STANDARD_DIMSTYLE.lunit));
        headerDimStyle = {
          name: headerVars.get('$DIMSTYLE')?.[0]?.value || 'Standard',
          scale: hnum('$DIMSCALE', 1) || 1,
          arrowSize: hnum('$DIMASZ', STANDARD_DIMSTYLE.arrowSize),
          extOffset: hnum('$DIMEXO', STANDARD_DIMSTYLE.extOffset),
          extExtend: hnum('$DIMEXE', STANDARD_DIMSTYLE.extExtend),
          textHeight: hnum('$DIMTXT', STANDARD_DIMSTYLE.textHeight),
          centerMark: hnum('$DIMCEN', STANDARD_DIMSTYLE.centerMark),
          textGap: hnum('$DIMGAP', STANDARD_DIMSTYLE.textGap),
          decimals: Math.trunc(hnum('$DIMDEC', STANDARD_DIMSTYLE.decimals)),
          angularDecimals: Math.max(0, Math.trunc(hnum('$DIMADEC', 0))),
          lunit: (lunit >= 1 && lunit <= 5 ? lunit : 2) as LinearUnits,
        };
        ctx.dimStyle = headerDimStyle;
      } else if (name === 'TABLES') {
        for (const o of objs) {
          if (o.kind === 'LAYER') {
            const name2 = str(o, 2);
            if (!name2) continue;
            const c = Math.trunc(num(o, 62, 7));
            const flags = Math.trunc(num(o, 70));
            const lt = str(o, 6);
            layers.push({
              name: name2,
              color: Math.abs(c) || 7,
              visible: c >= 0 && (flags & 1) === 0, // negative colour = off, flag 1 = frozen
              frozen: (flags & 1) === 1 || undefined,
              locked: (flags & 4) === 4,
              lineWeight: num(o, 370, 25) / 100,
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
            const ds = readDimStyleRecord(o, STANDARD_DIMSTYLE);
            dimStyles.set(ds.name.toUpperCase(), ds);
          } else if (o.kind === 'VIEW') {
            const vname = str(o, 2);
            if (vname) views.push({ name: vname, center: pt(o, 10), height: num(o, 40, 10) || 10 });
          }
        }
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
          const attributes: AttributeDef[] = inner
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
                ...(Math.abs(rotation) > 1e-9 ? { rotation } : {}),
              };
            });
          const bname = str(o, 2);
          const anonymousLayout = /^\*(MODEL_SPACE|PAPER_SPACE)/i.test(bname);
          const dimensionPicture = /^\*D\d*$/i.test(bname);
          if (bname && !anonymousLayout && !dimensionPicture) {
            blocks[bname] = {
              name: bname,
              basePoint: { x: num(o, 10), y: num(o, 20) },
              entities: readEntities(
                inner.filter((x) => x.kind !== 'ATTDEF'),
                ctx,
              ),
              attributes,
              description: str(o, 4) || undefined,
            };
          }
          k = m + 1;
        }
      } else if (name === 'ENTITIES') {
        entities = readEntities(objs, ctx);
      }
      i = j + 1;
    } else i += 1;
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
  const namedStyle = dimStyles.get(headerDimStyle.name.toUpperCase());
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
    // Header DIM* variables win when present (they describe the current style); otherwise the named record.
    dimStyle: headerVars.has('$DIMTXT') ? headerDimStyle : namedStyle ?? headerDimStyle,
    linetypes,
    views,
    celtype: /^BYLAYER$/i.test(celtype) ? 'ByLayer' : celtype,
    celweight: celweightRaw >= 0 ? celweightRaw / 100 : undefined,
  };

  return { entities, layers, blocks, currentLayer, header };
}
