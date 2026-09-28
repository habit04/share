/**
 * DWG import. The binary parsing is done by LibreDWG (GPL-3.0) compiled to
 * WebAssembly (@mlightcad/libredwg-web). That runs in the Electron main
 * process (or Node CLI / tests); this module converts the resulting
 * DwgDatabase JSON into our DrawingState. Only types are imported here so the
 * renderer bundle never includes the WASM.
 */
import type {
  DwgDatabase,
  DwgEntity,
  DwgLineEntity,
  DwgCircleEntity,
  DwgArcEntity,
  DwgLWPolylineEntity,
  DwgPolyline2dEntity,
  DwgTextEntity,
  DwgMTextEntity,
  DwgInsertEntity,
  DwgAttdefEntity,
  DwgBlockRecordTableEntry,
  DwgEllipseEntity,
  DwgPointEntity,
  DwgXlineEntity,
  DwgRayEntity,
  DwgDimensionEntity,
  DwgSolidEntity,
} from '@mlightcad/libredwg-web';
import type { Entity, BlockDef, Layer, AttributeDef, ColorSpec, MTextAttachment } from '../core/entities';
import { newId } from '../core/entities';
import type { DrawingState, DrawingHeader } from '../core/document';
import { DEFAULT_LAYERS, DEFAULT_HEADER } from '../core/document';
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import { STANDARD_DIMSTYLE, type DimStyle } from '../core/dimension';
import { mtextFromDxf } from '../core/mtext';
import { LINEWEIGHTS } from '../core/linetypes';
import type { LinearUnits } from '../core/units';

/** Subset of DwgDatabase we actually need (what the main process sends over IPC). */
export interface DwgImportPayload {
  header: { CLAYER?: unknown; INSUNITS?: unknown } & Record<string, unknown>;
  entities: DwgEntity[];
  layers: Array<{ name: string; colorIndex: number; off: boolean; frozen: boolean; locked: boolean; lineweight: number; lineType?: string }>;
  blocks: Array<Pick<DwgBlockRecordTableEntry, 'name' | 'basePoint' | 'entities' | 'description'>>;
  version?: string;
}

/** Trim a full DwgDatabase down to the payload (drops thumbnails, dictionaries, classes). */
export function toImportPayload(db: DwgDatabase, version?: string): DwgImportPayload {
  return {
    header: (db.header ?? {}) as DwgImportPayload['header'],
    entities: db.entities ?? [],
    layers: (db.tables?.LAYER?.entries ?? []).map((l) => ({
      name: l.name,
      colorIndex: l.colorIndex,
      off: l.off,
      frozen: l.frozen,
      locked: l.locked,
      lineweight: l.lineweight,
      lineType: l.lineType,
    })),
    blocks: (db.tables?.BLOCK_RECORD?.entries ?? []).map((b) => ({
      name: b.name,
      basePoint: b.basePoint,
      entities: b.entities ?? [],
      description: b.description,
    })),
    version,
  };
}

const p2 = (p: { x: number; y: number } | undefined): Point => ({ x: p?.x ?? 0, y: p?.y ?? 0 });

function color(e: DwgEntity): ColorSpec {
  const c = e.colorIndex;
  if (c === undefined || c === 256 || c === 0) return 'ByLayer';
  return c;
}

/** DWG lineweight enum: 0..23 index the standard table, 29 ByLayer, 30 ByBlock, 31 Default. */
function lineweightMm(code: number | undefined): number | undefined {
  if (code === undefined || code < 0 || code > 23) return undefined;
  return LINEWEIGHTS[code];
}

function baseProps(e: DwgEntity): { id: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number; ltscale?: number } {
  const out: { id: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number; ltscale?: number } = { id: newId(), layer: e.layer || '0', color: color(e) };
  if (e.lineType && !/^bylayer$/i.test(e.lineType)) out.linetype = e.lineType;
  const lw = lineweightMm(e.lineweight);
  if (lw !== undefined) out.lineWeight = lw;
  if (e.lineTypeScale && e.lineTypeScale !== 1) out.ltscale = e.lineTypeScale;
  return out;
}

/** The union of LibreDWG's dimension subtypes, flattened to optional fields. */
interface DimAny {
  dimensionType?: number;
  definitionPoint?: { x: number; y: number };
  textPoint?: { x: number; y: number };
  text?: string;
  subDefinitionPoint1?: { x: number; y: number };
  subDefinitionPoint2?: { x: number; y: number };
  centerPoint?: { x: number; y: number };
  arcPoint?: { x: number; y: number };
  rotationAngle?: number;
  leaderLength?: number;
}

function convertDimension(raw: DwgDimensionEntity, base: ReturnType<typeof baseProps>, style: DimStyle): Entity | null {
  const d = raw as unknown as DimAny;
  const type = (d.dimensionType ?? 0) & 15;
  const userText = ((d.dimensionType ?? 0) & 128) !== 0 ? p2(d.textPoint) : undefined;
  const text = d.text && d.text !== '<>' ? d.text : undefined;
  const common = { ...base, type: 'dimension' as const, text, textPosition: userText, style };
  const dp = p2(d.definitionPoint);
  switch (type) {
    case 0:
      return { ...common, kind: 'linear', p1: p2(d.subDefinitionPoint1), p2: p2(d.subDefinitionPoint2), linePoint: dp, rotation: d.rotationAngle ?? 0 };
    case 1:
      return { ...common, kind: 'aligned', p1: p2(d.subDefinitionPoint1), p2: p2(d.subDefinitionPoint2), linePoint: dp, rotation: 0 };
    case 3: {
      const far = p2(d.centerPoint);
      const center = g.mid(dp, far);
      const dir = g.normalize(g.sub(dp, center));
      return { ...common, kind: 'diameter', p1: center, p2: dp, linePoint: userText ?? g.add(dp, g.scale(dir, d.leaderLength ?? 0)), rotation: 0 };
    }
    case 4: {
      const q = p2(d.centerPoint);
      const dir = g.normalize(g.sub(q, dp));
      return { ...common, kind: 'radius', p1: dp, p2: q, linePoint: userText ?? g.add(q, g.scale(dir, d.leaderLength ?? 0)), rotation: 0 };
    }
    case 5:
      return { ...common, kind: 'angular', p1: p2(d.subDefinitionPoint1), p2: p2(d.subDefinitionPoint2), center: p2(d.centerPoint), linePoint: dp, rotation: 0 };
    case 2: {
      const a1 = p2(d.subDefinitionPoint1);
      const a2 = p2(d.subDefinitionPoint2);
      const b1 = p2(d.centerPoint);
      const b2 = dp;
      const r = g.sub(a2, a1);
      const sv = g.sub(b2, b1);
      const denom = g.cross(r, sv);
      if (Math.abs(denom) < 1e-12) return null;
      const t = g.cross(g.sub(b1, a1), sv) / denom;
      const center = g.add(a1, g.scale(r, t));
      const far = (p: Point, q: Point) => (g.dist(p, center) >= g.dist(q, center) ? p : q);
      return { ...common, kind: 'angular', p1: far(a1, a2), p2: far(b1, b2), center, linePoint: p2(d.arcPoint), rotation: 0 };
    }
    default:
      return null;
  }
}

function halign(h: number | undefined): 'left' | 'center' | 'right' {
  if (h === 1 || h === 4) return 'center';
  if (h === 2) return 'right';
  return 'left';
}

function convertEntity(e: DwgEntity, blockIndex: Map<string, string>, dimStyle: DimStyle = STANDARD_DIMSTYLE, blocks?: Record<string, BlockDef>): Entity | null {
  const base = baseProps(e);
  switch (e.type) {
    case 'LINE': {
      const l = e as DwgLineEntity;
      return { ...base, type: 'line', a: p2(l.startPoint), b: p2(l.endPoint) };
    }
    case 'CIRCLE': {
      const c = e as DwgCircleEntity;
      return { ...base, type: 'circle', center: p2(c.center), radius: c.radius };
    }
    case 'ARC': {
      const a = e as DwgArcEntity;
      return { ...base, type: 'arc', center: p2(a.center), radius: a.radius, startAngle: a.startAngle, endAngle: a.endAngle };
    }
    case 'LWPOLYLINE': {
      const pl = e as DwgLWPolylineEntity;
      const verts = pl.vertices ?? [];
      if (verts.length === 0) return null;
      const closed = (pl.flag & 1) === 1;
      const cw = pl.constantWidth ?? 0;
      if (closed && verts.length === 2 && cw > 0 && Math.abs(verts[0]!.bulge - 1) < 1e-6 && Math.abs(verts[1]!.bulge - 1) < 1e-6) {
        const a = p2(verts[0]);
        const b = p2(verts[1]);
        return { ...base, type: 'circle', center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, radius: Math.hypot(b.x - a.x, b.y - a.y) / 2 + cw / 2, filled: true };
      }
      // Bulges are kept (the polyline entity carries arc segments); widths per vertex collapse to the constant width.
      const pts = verts.map((v) => p2(v));
      const bulges = verts.map((v) => v.bulge || 0);
      const hasBulge = bulges.some((b) => Math.abs(b) > 1e-12);
      const width = cw > 0 ? cw : verts[0]?.startWidth && verts.every((v) => Math.abs((v.startWidth ?? 0) - (verts[0]!.startWidth ?? 0)) < 1e-9) ? verts[0]!.startWidth : 0;
      return { ...base, type: 'polyline', points: pts, closed, bulges: hasBulge ? bulges : undefined, width: width && width > 0 ? width : undefined };
    }
    case 'POLYLINE2D': {
      const pl = e as DwgPolyline2dEntity;
      const verts = pl.vertices ?? [];
      if (verts.length === 0) return null;
      const closed = (pl.flag & 1) === 1;
      const pts = verts.map((v) => p2(v));
      const bulges = verts.map((v) => v.bulge || 0);
      return { ...base, type: 'polyline', points: pts, closed, bulges: bulges.some((b) => Math.abs(b) > 1e-12) ? bulges : undefined };
    }
    case 'TEXT': {
      const t = e as DwgTextEntity;
      const align = halign(t.halign);
      const h = t.halign ?? 0;
      const v = t.valign ?? 0;
      // Alignment point applies for any non-default justification except Aligned/Fit (3/5), which keep the first point.
      const useEnd = (h !== 0 || v !== 0) && h !== 3 && h !== 5 && t.endPoint && (t.endPoint.x !== 0 || t.endPoint.y !== 0);
      const height = t.textHeight || 0.125;
      const rotation = t.rotation ?? 0;
      let position = useEnd ? p2(t.endPoint) : p2(t.startPoint);
      const drop = v === 2 ? height / 2 : v === 3 ? height : 0;
      if (drop) position = { x: position.x + Math.sin(rotation) * drop, y: position.y - Math.cos(rotation) * drop };
      return { ...base, type: 'text', position, text: t.text ?? '', height, rotation, align };
    }
    case 'MTEXT': {
      const m = e as DwgMTextEntity;
      const h = m.textHeight || 0.125;
      const ap = Math.max(1, Math.min(9, m.attachmentPoint ?? 1)) as MTextAttachment; // 1..9: TL TC TR ML MC MR BL BC BR
      const rot = m.direction && (m.direction.x !== 0 || m.direction.y !== 0) ? Math.atan2(m.direction.y, m.direction.x) : m.rotation ?? 0;
      return {
        ...base,
        type: 'mtext',
        position: p2(m.insertionPoint),
        text: mtextFromDxf(m.text ?? ''),
        height: h,
        width: Math.max(0, m.rectWidth ?? 0),
        rotation: rot,
        attachment: ap,
        lineSpacing: m.lineSpacing && m.lineSpacing > 0 ? m.lineSpacing : 1,
      };
    }
    case 'ELLIPSE': {
      const el = e as DwgEllipseEntity;
      return {
        ...base,
        type: 'ellipse',
        center: p2(el.center),
        majorAxis: p2(el.majorAxisEndPoint),
        ratio: Math.min(1, Math.max(1e-6, el.axisRatio || 1)),
        startParam: el.startAngle ?? 0,
        endParam: el.endAngle ?? 2 * Math.PI,
      };
    }
    case 'POINT':
      return { ...base, type: 'point', position: p2((e as DwgPointEntity).position) };
    case 'XLINE': {
      const x = e as DwgXlineEntity;
      return { ...base, type: 'xline', base: p2(x.firstPoint), direction: g.normalize(p2(x.unitDirection)) };
    }
    case 'RAY': {
      const r = e as DwgRayEntity;
      return { ...base, type: 'ray', base: p2(r.firstPoint), direction: g.normalize(p2(r.unitDirection)) };
    }
    case 'SOLID': {
      const so = e as DwgSolidEntity;
      const c1 = p2(so.corner1);
      const c2 = p2(so.corner2);
      const c3 = p2(so.corner3);
      const c4 = so.corner4 ? p2(so.corner4) : c3;
      const points = g.eq(c3, c4) ? [c1, c2, c3] : [c1, c2, c4, c3];
      return { ...base, type: 'polyline', points, closed: true, filled: true };
    }
    case 'DIMENSION':
      return convertDimension(e as DwgDimensionEntity, base, dimStyle);
    case 'INSERT': {
      const i = e as DwgInsertEntity;
      const attrs: Record<string, string> = {};
      const hidden: string[] = [];
      for (const a of i.attribs ?? []) {
        const tag = a.tag || a.attrTag;
        attrs[tag] = a.text?.text ?? '';
        if (((a as { flags?: number }).flags ?? 0) & 1) hidden.push(tag);
      }
      const name = blockIndex.get((i.name ?? '').toUpperCase()) ?? i.name;
      // An invisible ATTRIB whose ATTDEF is visible hides that attribute on this insert only.
      const def = blocks?.[name];
      const hiddenHere = def ? hidden.filter((t) => def.attributes.some((a) => a.tag === t && !a.invisible)) : [];
      return {
        ...base,
        type: 'insert',
        block: name,
        position: p2(i.insertionPoint),
        rotation: i.rotation ?? 0,
        scale: Math.abs(i.xScale) || 1,
        attributes: attrs,
        ...(hiddenHere.length ? { hiddenAttributes: hiddenHere } : {}),
      };
    }
    default:
      return null;
  }
}

function convertAttdef(a: DwgAttdefEntity): AttributeDef {
  const t = a.text;
  const h = t?.halign ?? 0;
  const v = t?.valign ?? 0;
  const useAlign = (h !== 0 || v !== 0) && h !== 3 && h !== 5 && a.alignmentPoint && (a.alignmentPoint.x !== 0 || a.alignmentPoint.y !== 0);
  const height = t?.textHeight || 0.125;
  let position = useAlign ? p2(a.alignmentPoint) : p2(t?.startPoint);
  const drop = v === 2 ? height / 2 : v === 3 ? height : 0;
  if (drop) position = { x: position.x, y: position.y - drop };
  const rotation = t?.rotation ?? 0;
  return {
    tag: a.tag || a.attrTag || 'ATTR',
    prompt: a.prompt ?? '',
    default: t?.text ?? '',
    position,
    height,
    align: halign(h),
    invisible: ((a.flags ?? 0) & 1) === 1,
    ...(Math.abs(rotation) > 1e-9 ? { rotation } : {}),
  };
}

export interface DwgImportResult {
  state: DrawingState;
  skipped: Record<string, number>;
}

/** Convert a LibreDWG database payload into a DrawingState. */
/** Header variables LibreDWG exposes (numbers, strings, points). */
function readHeader(h: DwgImportPayload['header']): DrawingHeader {
  const num = (k: string, d: number): number => {
    const v = h[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const pt = (k: string, d: Point): Point => {
    const v = h[k] as { x?: number; y?: number } | undefined;
    return v && typeof v.x === 'number' && typeof v.y === 'number' ? { x: v.x, y: v.y } : d;
  };
  const lunits = Math.trunc(num('LUNITS', 2));
  const dimlunit = Math.trunc(num('DIMLUNIT', 2));
  const dimStyle: DimStyle = {
    name: typeof h.DIMSTYLE === 'string' && h.DIMSTYLE ? h.DIMSTYLE : 'Standard',
    textHeight: num('DIMTXT', STANDARD_DIMSTYLE.textHeight),
    arrowSize: num('DIMASZ', STANDARD_DIMSTYLE.arrowSize),
    extOffset: num('DIMEXO', STANDARD_DIMSTYLE.extOffset),
    extExtend: num('DIMEXE', STANDARD_DIMSTYLE.extExtend),
    textGap: num('DIMGAP', STANDARD_DIMSTYLE.textGap),
    centerMark: num('DIMCEN', STANDARD_DIMSTYLE.centerMark),
    scale: num('DIMSCALE', 1) || 1,
    decimals: Math.max(0, Math.trunc(num('DIMDEC', 4))),
    lunit: (dimlunit >= 1 && dimlunit <= 5 ? dimlunit : 2) as LinearUnits,
    angularDecimals: Math.max(0, Math.trunc(num('DIMADEC', 0))),
  };
  return {
    ...DEFAULT_HEADER,
    units: {
      lunits: (lunits >= 1 && lunits <= 5 ? lunits : 2) as LinearUnits,
      luprec: Math.max(0, Math.trunc(num('LUPREC', 4))),
      insunits: Math.trunc(num('INSUNITS', 1)),
      auprec: Math.max(0, Math.trunc(num('AUPREC', 0))),
    },
    ltscale: num('LTSCALE', 1) || 1,
    limits: { min: pt('LIMMIN', DEFAULT_HEADER.limits.min), max: pt('LIMMAX', DEFAULT_HEADER.limits.max) },
    pdmode: Math.trunc(num('PDMODE', 0)),
    pdsize: num('PDSIZE', 0),
    dimStyle,
    celtype: typeof h.CELTYPE === 'string' && h.CELTYPE ? h.CELTYPE : 'ByLayer',
  };
}

export function convertDwg(payload: DwgImportPayload): DwgImportResult {
  const skipped: Record<string, number> = {};
  const header = readHeader(payload.header ?? {});
  const isLayout = (name: string) => /^\*(MODEL_SPACE|PAPER_SPACE)/i.test(name);
  // Anonymous blocks (*U12 ...) hold dynamic-block and array geometry; keep them under a legal name.
  const publicName = (name: string) => (name.startsWith('*') ? `ANON_${name.slice(1).replace(/[^A-Za-z0-9_]/g, '_')}` : name);
  const blockIndex = new Map<string, string>();
  for (const b of payload.blocks) if (b.name && !isLayout(b.name)) blockIndex.set(b.name.toUpperCase(), publicName(b.name));
  // libredwg-web lists paper-space entities in db.entities without flagging them: skip them by handle.
  const paperHandles = new Set<string>();
  for (const b of payload.blocks) if (b.name && /^\*PAPER_SPACE/i.test(b.name)) for (const e of b.entities) if (e.handle) paperHandles.add(e.handle);

  const blocks: Record<string, BlockDef> = {};
  for (const b of payload.blocks) {
    if (!b.name || isLayout(b.name)) continue;
    const entities: Entity[] = [];
    const attributes: AttributeDef[] = [];
    for (const e of b.entities) {
      if (e.type === 'ATTDEF') {
        attributes.push(convertAttdef(e as DwgAttdefEntity));
        continue;
      }
      const c = convertEntity(e, blockIndex, header.dimStyle);
      if (c) entities.push(c);
      else skipped[e.type] = (skipped[e.type] ?? 0) + 1;
    }
    const name = publicName(b.name);
    blocks[name] = { name, basePoint: p2(b.basePoint), entities, attributes, description: b.description || undefined };
  }

  const entities: Entity[] = [];
  for (const e of payload.entities) {
    if (e.isInPaperSpace || (e.handle && paperHandles.has(e.handle))) continue;
    if (e.type === 'ATTDEF' || e.type === 'VIEWPORT' || e.type === 'ATTRIB') continue; // ATTRIBs are folded into their INSERTs
    const c = convertEntity(e, blockIndex, header.dimStyle, blocks);
    if (c) entities.push(c);
    else skipped[e.type] = (skipped[e.type] ?? 0) + 1;
  }

  const layers: Layer[] = payload.layers
    .filter((l) => l.name)
    .map((l) => ({
      name: l.name,
      color: Math.abs(l.colorIndex) || 7,
      visible: !l.off && !l.frozen,
      locked: !!l.locked,
      lineWeight: lineweightMm(l.lineweight) ?? 0.25,
      linetype: l.lineType && !/^(continuous|bylayer)$/i.test(l.lineType) ? l.lineType : undefined,
    }));
  const names = new Set(layers.map((l) => l.name));
  const ensure = (n: string) => {
    if (!names.has(n)) {
      names.add(n);
      layers.push(DEFAULT_LAYERS.find((d) => d.name === n) ?? { name: n, color: 7, visible: true, locked: false, lineWeight: 0.25 });
    }
  };
  ensure('0');
  for (const e of entities) ensure(e.layer);
  for (const b of Object.values(blocks)) for (const e of b.entities) ensure(e.layer);

  const rawClayer = typeof payload.header.CLAYER === 'string' ? payload.header.CLAYER : '0';
  const currentLayer =
    layers.find((l) => l.name === rawClayer)?.name ??
    layers.find((l) => l.name.toUpperCase().replace(/\s+/g, '_') === rawClayer.toUpperCase().replace(/\s+/g, '_'))?.name ??
    '0';

  return { state: { entities, layers, blocks, currentLayer, header }, skipped };
}
