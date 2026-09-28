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
import { insertScales, insertScaleFields } from './dxf';
import type { Entity, BlockDef, Layer, AttributeDef, ColorSpec, MTextAttachment } from '../core/entities';
import { newId, entityBounds } from '../core/entities';
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
  blocks: Array<Pick<DwgBlockRecordTableEntry, 'name' | 'basePoint' | 'entities' | 'description'> & { handle?: string }>;
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
      handle: (b as { handle?: string }).handle,
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

interface DwgHatchVertex {
  x: number;
  y: number;
  bulge?: number;
}
interface DwgHatchEdge {
  type?: number; // 1 line, 2 arc, 3 ellipse, 4 spline
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  center?: { x: number; y: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  isCounterClockwise?: number | boolean;
  majorAxis?: { x: number; y: number };
  minorAxisRatio?: number;
  controlPoints?: Array<{ x: number; y: number }>;
  fitPoints?: Array<{ x: number; y: number }>;
}
interface DwgHatchPath {
  boundaryPathTypeFlag?: number; // 1 external, 2 polyline, 4 derived, 8 textbox, 16 outermost
  hasBulge?: number;
  isClosed?: number;
  vertices?: DwgHatchVertex[];
  edges?: DwgHatchEdge[];
}
interface DwgHatchLike {
  solidFill?: number | boolean;
  patternName?: string;
  boundaryPaths?: DwgHatchPath[];
}

const deg2rad = (d: number) => (d * Math.PI) / 180;

/** Points of one hatch boundary path (polyline paths keep their bulges; edge paths are sampled). */
function hatchPathGeometry(path: DwgHatchPath): { points: Point[]; bulges?: number[] } | null {
  if (path.vertices && path.vertices.length >= 2) {
    const points = path.vertices.map((v) => p2(v));
    const bulges = path.vertices.map((v) => v.bulge ?? 0);
    return { points, bulges: bulges.some((b) => Math.abs(b) > 1e-12) ? bulges : undefined };
  }
  const points: Point[] = [];
  const push = (pt: Point) => {
    const last = points[points.length - 1];
    if (!last || !g.eq(last, pt)) points.push(pt);
  };
  for (const ed of path.edges ?? []) {
    switch (ed.type) {
      case 1:
        if (ed.start) push(p2(ed.start));
        if (ed.end) push(p2(ed.end));
        break;
      case 2: {
        if (!ed.center || ed.radius === undefined) break;
        // Angles come in degrees in DXF-style payloads; radians are unlikely to exceed 2*pi.
        const toRad = (v: number) => (Math.abs(v) > 2 * Math.PI + 1e-6 ? deg2rad(v) : v);
        let s0 = toRad(ed.startAngle ?? 0);
        let e0 = toRad(ed.endAngle ?? 2 * Math.PI);
        const ccw = ed.isCounterClockwise === undefined ? true : Boolean(ed.isCounterClockwise);
        if (!ccw) [s0, e0] = [-s0, -e0];
        let sweep = e0 - s0;
        if (sweep <= 1e-9) sweep += 2 * Math.PI;
        const n = Math.max(4, Math.ceil((sweep / (2 * Math.PI)) * 32));
        for (let i = 0; i <= n; i += 1) {
          const t = s0 + (sweep * i) / n;
          push({ x: ed.center.x + ed.radius * Math.cos(t), y: ed.center.y + ed.radius * Math.sin(t) });
        }
        break;
      }
      case 3: {
        if (!ed.center || !ed.majorAxis) break;
        const ratio = ed.minorAxisRatio ?? 1;
        const s0 = ed.startAngle ?? 0;
        const e0 = ed.endAngle ?? 2 * Math.PI;
        let sweep = e0 - s0;
        if (sweep <= 1e-9) sweep += 2 * Math.PI;
        const n = Math.max(8, Math.ceil((sweep / (2 * Math.PI)) * 48));
        const minor = { x: -ed.majorAxis.y * ratio, y: ed.majorAxis.x * ratio };
        for (let i = 0; i <= n; i += 1) {
          const t = s0 + (sweep * i) / n;
          push({ x: ed.center.x + ed.majorAxis.x * Math.cos(t) + minor.x * Math.sin(t), y: ed.center.y + ed.majorAxis.y * Math.cos(t) + minor.y * Math.sin(t) });
        }
        break;
      }
      case 4: {
        for (const pt of ed.fitPoints?.length ? ed.fitPoints : ed.controlPoints ?? []) push(p2(pt));
        break;
      }
      default:
        break;
    }
  }
  return points.length >= 2 ? { points } : null;
}

/**
 * A HATCH becomes one closed polyline per boundary path. Solid hatches fill their outer
 * boundaries; pattern hatches keep only the outlines (the pattern itself is not drawn).
 */
export function convertHatch(e: DwgEntity): Entity[] {
  const h = e as unknown as DwgHatchLike;
  const base = baseProps(e);
  const solid = Boolean(h.solidFill) || /^SOLID$/i.test(h.patternName ?? '');
  const out: Entity[] = [];
  const paths = h.boundaryPaths ?? [];
  paths.forEach((path, i) => {
    const geom = hatchPathGeometry(path);
    if (!geom) return;
    const flag = path.boundaryPathTypeFlag ?? 0;
    const external = (flag & 1) === 1 || (flag & 16) === 16 || paths.length === 1;
    out.push({ ...base, id: i === 0 ? base.id : newId(), type: 'polyline', points: geom.points, closed: true, bulges: geom.bulges, ...(solid && external ? { filled: true } : {}) });
  });
  return out;
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
        rotation: (i.rotation ?? 0) + insertScales(i.xScale ?? 1, (i as { yScale?: number }).yScale ?? i.xScale ?? 1).rotationOffset,
        ...insertScaleFields(i.xScale ?? 1, (i as { yScale?: number }).yScale ?? i.xScale ?? 1),
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
  /** Human-readable remarks about approximations made during the import. */
  notes: string[];
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
  const notes: string[] = [];
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
      if (e.type === 'HATCH') {
        const parts = convertHatch(e);
        if (parts.length) entities.push(...parts);
        else skipped[e.type] = (skipped[e.type] ?? 0) + 1;
        continue;
      }
      const c = convertEntity(e, blockIndex, header.dimStyle);
      if (c) entities.push(c);
      else skipped[e.type] = (skipped[e.type] ?? 0) + 1;
    }
    const name = publicName(b.name);
    blocks[name] = { name, basePoint: p2(b.basePoint), entities, attributes, description: b.description || undefined };
  }

  // ACAD_TABLE entities draw through an anonymous *T<n> block that holds the rendered grid and
  // cell text. The entity's own fields are often unreadable; match blocks by handle first, then
  // hand out the unreferenced *T blocks in order.
  const insertedNames = new Set<string>();
  for (const e of payload.entities) if (e.type === 'INSERT') insertedNames.add(String((e as DwgInsertEntity).name ?? '').toUpperCase());
  const tableBlocksByHandle = new Map<string, string>();
  const spareTableBlocks: string[] = [];
  for (const b of payload.blocks) {
    if (!b.name || !/^\*T\d+$/i.test(b.name) || insertedNames.has(b.name.toUpperCase())) continue;
    if (b.handle) tableBlocksByHandle.set(String(b.handle).toUpperCase(), publicName(b.name));
    spareTableBlocks.push(publicName(b.name));
  }
  const tableInsert = (e: DwgEntity): Entity | null => {
    const t = e as unknown as { blockRecordHandle?: string; startPoint?: { x: number; y: number }; rowCount?: number };
    const byHandle = t.blockRecordHandle ? tableBlocksByHandle.get(String(t.blockRecordHandle).toUpperCase()) : undefined;
    const name = byHandle ?? spareTableBlocks.shift();
    if (!name) return null;
    if (byHandle) {
      const i = spareTableBlocks.indexOf(byHandle);
      if (i >= 0) spareTableBlocks.splice(i, 1);
    }
    const at = p2(t.startPoint);
    const ins: Entity = { ...baseProps(e), type: 'insert', block: name, position: at, rotation: 0, scale: 1, attributes: {} };
    if (!t.rowCount && at.x === 0 && at.y === 0) unplacedTables.push(ins);
    return ins;
  };
  /** Tables whose insertion point LibreDWG could not decode (2013+ DWG); placed after the pass. */
  const unplacedTables: Entity[] = [];

  const entities: Entity[] = [];
  for (const e of payload.entities) {
    if (e.isInPaperSpace || (e.handle && paperHandles.has(e.handle))) continue;
    if (e.type === 'ATTDEF' || e.type === 'VIEWPORT' || e.type === 'ATTRIB') continue; // ATTRIBs are folded into their INSERTs
    if (e.type === 'HATCH') {
      const parts = convertHatch(e);
      if (parts.length) entities.push(...parts);
      else skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      continue;
    }
    if (e.type === 'ACAD_TABLE') {
      const ins = tableInsert(e);
      if (ins) entities.push(ins);
      else skipped[e.type] = (skipped[e.type] ?? 0) + 1;
      continue;
    }
    const c = convertEntity(e, blockIndex, header.dimStyle, blocks);
    if (c) entities.push(c);
    else skipped[e.type] = (skipped[e.type] ?? 0) + 1;
  }

  // Estimate a place for tables with an unreadable insertion point: top-left inside the
  // largest block reference (the sheet border) when the table fits, else beside the drawing.
  if (unplacedTables.length) {
    const lookup = (n: string) => blocks[n];
    const others = entities.filter((e) => !unplacedTables.includes(e));
    let sheet: g.Bounds | null = null;
    let all: g.Bounds | null = null;
    for (const e of others) {
      const b = entityBounds(e, lookup);
      if (!b) continue;
      all = g.unionBounds(all, b);
      if (e.type === 'insert' && (!sheet || (b.max.x - b.min.x) * (b.max.y - b.min.y) > (sheet.max.x - sheet.min.x) * (sheet.max.y - sheet.min.y))) sheet = b;
    }
    let cursorX: number | null = null;
    for (const ins of unplacedTables) {
      if (ins.type !== 'insert') continue;
      const tb = entityBounds(ins, lookup);
      if (!tb) continue;
      const tw = tb.max.x - tb.min.x;
      const th = tb.max.y - tb.min.y;
      let target: Point | null = null;
      let where = '';
      if (sheet) {
        const margin = Math.max(0.5, (sheet.max.x - sheet.min.x) * 0.03);
        if (tw + 2 * margin <= sheet.max.x - sheet.min.x && th + 2 * margin <= sheet.max.y - sheet.min.y) {
          target = { x: sheet.min.x + margin, y: sheet.max.y - margin - th };
          where = 'inside the sheet border';
        }
      }
      if (!target && all) {
        cursorX = cursorX ?? all.max.x + Math.max(1, (all.max.x - all.min.x) * 0.05);
        target = { x: cursorX, y: all.max.y - th };
        cursorX += tw + 1;
        where = 'to the right of the drawing';
      }
      if (!target) continue;
      const idx = entities.indexOf(ins);
      entities[idx] = { ...ins, position: { x: ins.position.x + (target.x - tb.min.x), y: ins.position.y + (target.y - tb.min.y) } };
      notes.push(`Table ${ins.block}: this DWG format does not expose the table's position to the reader, so it was placed ${where} (estimated). MOVE it to its spot; a DXF saved from AutoCAD keeps the exact position.`);
    }
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

  return { state: { entities, layers, blocks, currentLayer, header }, skipped, notes };
}
