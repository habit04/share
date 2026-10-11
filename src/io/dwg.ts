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
  DwgSplineEntity,
  DwgLeaderEntity,
  DwgMultiLeaderEntity,
  DwgImageEntity,
  DwgTableEntity,
} from '@mlightcad/libredwg-web';
import { insertScales, insertScaleFields } from './dxf';
import type { Entity, BlockDef, Layer, AttributeDef, ColorSpec, MTextAttachment, SplineEntity, HatchEntity, HatchLoop, LeaderEntity, ImageEntity, TableEntity, TableCell, FieldLink } from '../core/entities';
import { translateEntity } from '../core/entities';
import { DIMSTYLES_META_KEY, DIM_VARIABLES, diffDimStyles, dimStyleFromRecordPairs } from '../core/dimension';
import { findLinetype, type Linetype } from '../core/linetypes';
import { paperFromSize, unitsOfHost, uniformMargins, newViewportId, type Layout, type LayoutViewport } from '../core/layouts';
import { textStylesMeta, type TextStyle } from './encoding';
import { fontImportWarning } from './font-warning';
import { ImportReportBuilder, geometryProblem, withImportData, type ImportReport } from './import-report';
import { findPattern, LoopBuilder, edgeArc, fitPatternToLines } from '../core/hatch';
import { isValidNurbs, nurbsPoints, interpolateFitPoints, splineWorkProblem, SplineWorkLimitError } from '../core/spline';
import { evaluateFields, hasFields } from '../core/fields';
import { newId, entityBounds } from '../core/entities';
import type { DrawingState, DrawingHeader } from '../core/document';
import { DEFAULT_LAYERS, DEFAULT_HEADER } from '../core/document';
import type { Point } from '../core/geometry';
import * as g from '../core/geometry';
import { STANDARD_DIMSTYLE, withDimVars, type DimStyle } from '../core/dimension';
import { mtextFromDxf, hasFormatting } from '../core/mtext';
import { LINEWEIGHTS } from '../core/linetypes';
import type { LinearUnits } from '../core/units';
import { cadPrecision } from '../core/units';

/** Subset of DwgDatabase we actually need (what the main process sends over IPC). */
export interface DwgImportPayload {
  header: { CLAYER?: unknown; INSUNITS?: unknown } & Record<string, unknown>;
  entities: DwgEntity[];
  /** `color` is the layer's RGB (meaningful when colorIndex is 256: a true-colour layer). */
  layers: Array<{ name: string; handle?: string; colorIndex: number; color?: number; off: boolean; frozen: boolean; locked: boolean; lineweight: number; lineType?: string; standardFlag?: number; plotFlag?: number }>;
  blocks: Array<Pick<DwgBlockRecordTableEntry, 'name' | 'basePoint' | 'entities' | 'description'> & { handle?: string; flags?: number }>;
  version?: string;
  /** IMAGEDEF objects (handle -> file name) so IMAGE entities know their file. Optional: older readers omit it. */
  imageDefs?: Array<{ handle: string; fileName: string }>;
  /** STYLE table (text styles). Optional (older readers omit the table data below). */
  styles?: DwgPayloadStyle[];
  /** DIMSTYLE table: records with the DIM* variables by name (as the header has them). */
  dimStyles?: Array<Record<string, unknown> & { name: string }>;
  /** LTYPE table: dash patterns. */
  linetypes?: DwgPayloadLinetype[];
  /** LAYOUT objects: name, tab order, the BLOCK_RECORD of their paper space, paper limits. */
  layouts?: DwgPayloadLayout[];
  /** Object metadata omitted from the drawing model, summarized for loss reporting. */
  omittedObjectTypes?: Record<string, number>;
}

export interface DwgPayloadStyle {
  name: string;
  handle?: string;
  standardFlag?: number;
  fixedTextHeight?: number;
  widthFactor?: number;
  /** Radians (DWG). */
  obliqueAngle?: number;
  textGenerationFlag?: number;
  font?: string;
  bigFont?: string;
}
export interface DwgPayloadLinetype {
  name: string;
  description?: string;
  standardFlag?: number;
  pattern?: Array<{ elementLength: number; elementTypeFlag?: number }>;
}
export interface DwgPayloadLayout {
  name: string;
  tabOrder: number;
  /** Handle of the layout's *Paper_Space BLOCK_RECORD. */
  blockHandle: string;
  minLimit?: { x: number; y: number };
  maxLimit?: { x: number; y: number };
  plotSettings?: { paperWidth?: number; paperHeight?: number; plotPaperUnit?: number; plotRotation?: number; marginLeft?: number; marginBottom?: number; marginRight?: number; marginTop?: number; printScaleNominator?: number; printScaleDenominator?: number; configName?: string; currentStyleSheet?: string };
}

/** Trim a full DwgDatabase down to the payload (drops thumbnails, dictionaries, classes). */
export function toImportPayload(db: DwgDatabase, version?: string): DwgImportPayload {
  return {
    header: (db.header ?? {}) as DwgImportPayload['header'],
    entities: db.entities ?? [],
    layers: (db.tables?.LAYER?.entries ?? []).map((l) => ({
      name: l.name,
      ...((l as { handle?: string }).handle ? { handle: String((l as { handle?: string }).handle) } : {}),
      colorIndex: l.colorIndex,
      color: l.color,
      standardFlag: l.standardFlag,
      plotFlag: l.plotFlag,
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
      flags: (b as { flags?: number }).flags,
    })),
    version,
    imageDefs: (db.objects?.IMAGEDEF ?? []).map((d) => ({ handle: String(d.handle ?? ''), fileName: d.fileName ?? '' })),
    styles: (db.tables?.STYLE?.entries ?? []).map((t) => ({
      name: t.name,
      ...((t as { handle?: string }).handle ? { handle: String((t as { handle?: string }).handle) } : {}),
      standardFlag: t.standardFlag,
      fixedTextHeight: t.fixedTextHeight,
      widthFactor: t.widthFactor,
      obliqueAngle: t.obliqueAngle,
      textGenerationFlag: t.textGenerationFlag,
      font: t.font,
      bigFont: t.bigFont,
    })),
    dimStyles: (db.tables?.DIMSTYLE?.entries ?? []).map((d) => ({ ...(d as unknown as Record<string, unknown>), name: d.name })),
    linetypes: (db.tables?.LTYPE?.entries ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      standardFlag: t.standardFlag,
      pattern: (t.pattern ?? []).map((x) => ({ elementLength: x.elementLength, elementTypeFlag: x.elementTypeFlag })),
    })),
    layouts: (db.objects?.LAYOUT ?? []).map((l) => ({ name: l.layoutName, tabOrder: l.tabOrder, blockHandle: String(l.paperSpaceTableId ?? ''), minLimit: l.minLimit, maxLimit: l.maxLimit, ...((l as unknown as { paperWidth?: number }).paperWidth !== undefined ? { plotSettings: l as unknown as DwgPayloadLayout['plotSettings'] } : {}) })),
    omittedObjectTypes: Object.fromEntries(Object.entries(db.objects ?? {}).filter(([kind]) => !['LAYOUT', 'IMAGEDEF', 'IMAGEDEF_REACTOR'].includes(kind)).map(([kind, values]) => [kind, Array.isArray(values) ? values.length : 1])),
  };
}

const p2 = (p: { x: number; y: number } | undefined): Point => ({ x: p?.x ?? 0, y: p?.y ?? 0 });

/** DWG colour: 256 / absent = ByLayer, 0 = ByBlock (kept: block content takes the reference's colour), 1..255 ACI. */
function color(e: DwgEntity): ColorSpec {
  const c = e.colorIndex;
  if (c === undefined || c === 256 || c < 0 || c > 256) return 'ByLayer';
  return c;
}

/** True colour (RGB) of an entity: LibreDWG sets `color` only for true-colour (method 0xC2) objects. */
function trueColorOf(e: { color?: number }): number | undefined {
  return typeof e.color === 'number' && Number.isFinite(e.color) ? e.color & 0xffffff : undefined;
}

/** DWG lineweight enum: 0..23 index the standard table, 29 ByLayer, 30 ByBlock, 31 Default. */
function lineweightMm(code: number | undefined): number | undefined {
  if (code === undefined || code < 0 || code > 23) return undefined;
  return LINEWEIGHTS[code];
}

function baseProps(e: DwgEntity): { id: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number; ltscale?: number; trueColor?: number } {
  const out: { id: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number; ltscale?: number; trueColor?: number } = { id: newId(), layer: e.layer || '0', color: color(e) };
  const tc = trueColorOf(e);
  if (tc !== undefined) out.trueColor = tc;
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

const deg2rad = (d: number) => d * (Math.PI / 180);

const MAX_HATCH_EDGE_SAMPLES = 64;
class HatchGeometryError extends Error {}
const finiteHatchPoint = (pt: Point): Point => {
  if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) throw new HatchGeometryError('non-finite coordinate derived from hatch boundary data');
  return pt;
};
/** Reduce endpoints individually before subtraction; large finite angles cannot overflow a sweep. */
function hatchEdgeArc(edge: DwgHatchEdge & { isCCW?: number | boolean }): { a0: number; sweep: number } {
  const start = angleRad(edge.startAngle);
  const end = angleRad(edge.endAngle ?? 2 * Math.PI);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new HatchGeometryError('non-finite hatch boundary angle');
  const ccw = edge.isCCW ?? edge.isCounterClockwise;
  return edgeArc(g.deg(g.normAngle(start)), g.deg(g.normAngle(end)), ccw === undefined ? true : Boolean(ccw));
}
const hatchEdgeSamples = (sweep: number, minimum: number, perTurn: number): number => Math.max(minimum, Math.min(MAX_HATCH_EDGE_SAMPLES, Math.ceil(Math.abs(sweep) / (2 * Math.PI) * perTurn)));
function checkHatchArc(center: Point, radius: number): void {
  finiteHatchPoint(center);
  if (!Number.isFinite(radius) || radius < 0) throw new HatchGeometryError('invalid hatch boundary radius');
  finiteHatchPoint({ x: center.x + radius, y: center.y + radius });
  finiteHatchPoint({ x: center.x - radius, y: center.y - radius });
}

/** Points of one hatch boundary path (polyline paths keep their bulges; edge paths are sampled). */
function hatchPathGeometry(path: DwgHatchPath): { points: Point[]; bulges?: number[] } | null {
  if (path.vertices && path.vertices.length >= 2) {
    const points = path.vertices.map((v) => finiteHatchPoint(p2(v)));
    const bulges = path.vertices.map((v) => v.bulge ?? 0);
    return { points, bulges: bulges.some((b) => Math.abs(b) > 1e-12) ? bulges : undefined };
  }
  const points: Point[] = [];
  const push = (pt: Point) => {
    finiteHatchPoint(pt);
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
        checkHatchArc(ed.center, ed.radius);
        const { a0, sweep } = hatchEdgeArc(ed);
        const n = hatchEdgeSamples(sweep, 4, 32);
        for (let i = 0; i <= n; i += 1) {
          const t = a0 + (sweep * i) / n;
          push({ x: ed.center.x + ed.radius * Math.cos(t), y: ed.center.y + ed.radius * Math.sin(t) });
        }
        break;
      }
      case 3: {
        if (!ed.center || !ed.majorAxis) break;
        const ratio = ed.minorAxisRatio ?? 1;
        const { a0, sweep } = hatchEdgeArc(ed);
        const n = hatchEdgeSamples(sweep, 8, 48);
        const minor = finiteHatchPoint({ x: -ed.majorAxis.y * ratio, y: ed.majorAxis.x * ratio });
        for (let i = 0; i <= n; i += 1) {
          const t = a0 + (sweep * i) / n;
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


// ------------------------------------------------------------------ SPLINE / HATCH / LEADER / MULTILEADER / IMAGE / TABLE

type Base = ReturnType<typeof baseProps>;

function convertSpline(s: DwgSplineEntity, base: Base): SplineEntity | null {
  const cps = (s.controlPoints ?? []).map((q) => p2(q));
  const fit = (s.fitPoints ?? []).map((q) => p2(q));
  if (cps.length < 2 && fit.length < 2) return null;
  const weights = s.weights && s.weights.length === cps.length && s.weights.some((w) => Math.abs(w - 1) > 1e-12) ? [...s.weights] : undefined;
  const tan = (t: { x: number; y: number } | undefined) => (t && (t.x !== 0 || t.y !== 0) ? p2(t) : undefined);
  const st = tan(s.startTangent);
  const et = tan(s.endTangent);
  const workProblem = splineWorkProblem({ degree: Math.max(1, s.degree || 3), knots: s.knots ?? [], controlPoints: cps }, fit.length, { closed: ((s.flag ?? 0) & 1) === 1, startTangent: st, endTangent: et });
  if (workProblem) throw new SplineWorkLimitError(workProblem);
  return {
    ...base,
    type: 'spline',
    degree: Math.max(1, s.degree || 3),
    knots: [...(s.knots ?? [])],
    controlPoints: cps,
    ...(weights ? { weights } : {}),
    ...(fit.length ? { fitPoints: fit } : {}),
    closed: ((s.flag ?? 0) & 1) === 1,
    ...(((s.flag ?? 0) & 2) === 2 ? { periodic: true } : {}),
    ...(st ? { startTangent: st } : {}),
    ...(et ? { endTangent: et } : {}),
  };
}

/** LibreDWG angles are radians; payloads built from DXF-style data may carry degrees. */
const angleRad = (v: number | undefined): number => {
  const a = v ?? 0;
  return Math.abs(a) > 2 * Math.PI + 1e-6 ? deg2rad(a) : a;
};

interface DwgHatchEdgeAny extends DwgHatchEdge {
  isCCW?: boolean | number;
  end?: { x: number; y: number };
  lengthOfMinorAxis?: number;
  fitDatum?: Array<{ x: number; y: number }>;
  degree?: number;
  knots?: number[];
}

function hatchLoopFromPath(path: DwgHatchPath): HatchLoop | null {
  if (path.vertices && path.vertices.length >= 2) {
    const points = path.vertices.map((v) => finiteHatchPoint(p2(v)));
    const bulges = path.vertices.map((v) => v.bulge ?? 0);
    return { points, ...(bulges.some((b) => Math.abs(b) > 1e-12) ? { bulges } : {}) };
  }
  const b = new LoopBuilder();
  for (const raw of (path.edges ?? []) as DwgHatchEdgeAny[]) {
    const ccwRaw = raw.isCCW ?? raw.isCounterClockwise;
    const ccw = ccwRaw === undefined ? true : Boolean(ccwRaw);
    switch (raw.type) {
      case 1:
        if (raw.start && raw.end) b.segment(finiteHatchPoint(p2(raw.start)), finiteHatchPoint(p2(raw.end)), 0);
        break;
      case 2: {
        if (!raw.center || raw.radius === undefined) break;
        checkHatchArc(raw.center, raw.radius);
        const { a0, sweep } = hatchEdgeArc({ ...raw, isCCW: ccw });
        b.arc(p2(raw.center), raw.radius, a0, sweep);
        break;
      }
      case 3: {
        const major = raw.majorAxis ?? raw.end;
        if (!raw.center || !major) break;
        const ratio = raw.minorAxisRatio ?? raw.lengthOfMinorAxis ?? 1;
        const { a0, sweep } = hatchEdgeArc({ ...raw, isCCW: ccw });
        const minor = finiteHatchPoint({ x: -major.y * ratio, y: major.x * ratio });
        const steps = hatchEdgeSamples(sweep, 8, 64);
        const pts: Point[] = [];
        for (let i = 0; i <= steps; i += 1) {
          const t = a0 + (sweep * i) / steps;
          pts.push(finiteHatchPoint({ x: raw.center.x + major.x * Math.cos(t) + minor.x * Math.sin(t), y: raw.center.y + major.y * Math.cos(t) + minor.y * Math.sin(t) }));
        }
        b.polyline(pts);
        break;
      }
      case 4: {
        const cps = (raw.controlPoints ?? []).map((q) => p2(q));
        const fit = (raw.fitDatum?.length ? raw.fitDatum : raw.fitPoints ?? []).map((q) => p2(q));
        const curve = { degree: raw.degree ?? 3, knots: raw.knots ?? [], controlPoints: cps };
        const workProblem = splineWorkProblem(curve, fit.length, {}, 8);
        if (workProblem) throw new SplineWorkLimitError(workProblem);
        const pts = isValidNurbs(curve) ? nurbsPoints(curve, 8) : fit.length >= 2 ? nurbsPoints(interpolateFitPoints(fit) ?? curve, 8) : cps;
        b.polyline(pts.map(finiteHatchPoint));
        break;
      }
      default:
        break;
    }
  }
  return b.loop();
}

interface DwgHatchFull extends DwgHatchLike {
  associativity?: number;
  hatchStyle?: number;
  patternType?: number;
  patternAngle?: number;
  patternScale?: number;
  definitionLines?: Array<{ angle: number; base: { x: number; y: number }; offset: { x: number; y: number }; dashLengths?: number[] }>;
  isDouble?: number | boolean;
}

/** A DWG HATCH as a real hatch entity (boundary loops + pattern); null when no loop is usable. */
export function convertHatchEntity(e: DwgEntity): HatchEntity | null {
  const h = e as unknown as DwgHatchFull;
  const loops = (h.boundaryPaths ?? []).map(hatchLoopFromPath).filter((l): l is HatchLoop => !!l && l.points.length >= 2);
  if (!loops.length) return null;
  const name = (h.patternName ?? '').trim().toUpperCase() || 'SOLID';
  const solid = Boolean(h.solidFill) || name === 'SOLID';
  const angle = angleRad(h.patternAngle);
  const scale = h.patternScale && h.patternScale > 0 ? h.patternScale : 1;
  const defLines = (h.definitionLines ?? []).map((l) => ({ angle: angleRad(l.angle), base: p2(l.base), offset: p2(l.offset), dashes: [...(l.dashLengths ?? [])] }));
  const fit = solid ? { angle, scale } : fitPatternToLines(findPattern(name), angle, scale, defLines, Boolean(h.isDouble));
  return {
    ...baseProps(e),
    type: 'hatch',
    pattern: solid ? 'SOLID' : name,
    solid,
    angle: fit.angle,
    scale: fit.scale,
    ...(fit.origin ? { origin: fit.origin } : {}),
    loops,
    ...(fit.patternLines ? { patternLines: fit.patternLines } : {}),
    ...(h.associativity ? { associative: true } : {}),
    ...(h.hatchStyle ? { style: h.hatchStyle } : {}),
    ...(h.patternType !== undefined ? { patternType: h.patternType } : {}),
  };
}

function convertLeader(l: DwgLeaderEntity, base: Base, dimStyle: DimStyle, annotation?: DwgEntity): LeaderEntity | null {
  const verts = (l.vertices ?? []).map((q) => p2(q));
  if (verts.length < 2) return null;
  let vertices = verts;
  let dogleg: Point | undefined;
  if (l.isHooklineExists && verts.length >= 3) {
    dogleg = g.sub(verts[verts.length - 1]!, verts[verts.length - 2]!);
    vertices = verts.slice(0, -1);
  }
  const out: LeaderEntity = {
    ...base,
    type: 'leader',
    vertices,
    arrow: l.isArrowheadEnabled !== false,
    arrowSize: dimStyle.arrowSize * (dimStyle.scale || 1),
    ...(dogleg ? { dogleg } : {}),
    ...(l.isSpline ? { spline: true } : {}),
    textHeight: l.textHeight && l.textHeight > 0 ? l.textHeight : dimStyle.textHeight,
    kind: 'leader',
  };
  if (annotation && annotation.type === 'MTEXT') {
    const m = annotation as DwgMTextEntity;
    const raw = m.text ?? '';
    const text = mtextFromDxf(raw);
    const rot = m.direction && (m.direction.x !== 0 || m.direction.y !== 0) ? Math.atan2(m.direction.y, m.direction.x) : m.rotation ?? 0;
    return {
      ...out,
      text,
      ...(hasFormatting(raw) ? { raw } : {}),
      textPosition: p2(m.insertionPoint),
      textHeight: m.textHeight || out.textHeight,
      textAttachment: Math.max(1, Math.min(9, m.attachmentPoint ?? 1)) as MTextAttachment,
      ...(m.rectWidth && m.rectWidth > 0 ? { textWidth: m.rectWidth } : {}),
      ...(Math.abs(rot) > 1e-12 ? { textRotation: rot } : {}),
    };
  }
  return out;
}

function convertMLeader(m: DwgMultiLeaderEntity, base: Base, dimStyle: DimStyle, notes: string[]): LeaderEntity | null {
  const paths: Point[][] = [];
  let dogleg: Point | undefined;
  for (const sec of m.leaderSections ?? []) {
    const last = sec.lastLeaderLinePoint ? p2(sec.lastLeaderLinePoint) : undefined;
    for (const line of sec.leaderLines ?? []) {
      const pts = (line.vertices ?? []).map((q) => p2(q));
      if (last) pts.push(last);
      if (pts.length >= 2) paths.push(pts);
    }
    const len = sec.doglegLength ?? m.doglegLength ?? 0;
    if (!dogleg && last && sec.doglegVector && len > 0 && m.doglegEnabled !== false) dogleg = g.scale(g.normalize(p2(sec.doglegVector)), len);
  }
  const main = paths.shift();
  if (!main) return null;
  if (m.hasBlock || m.contentType === 1) notes.push('MULTILEADER block content is not drawn; the leader and its text are kept.');
  const raw = m.textContent ?? '';
  const text = raw ? mtextFromDxf(raw) : '';
  const dir = m.textDirection;
  const rot = dir && (dir.x !== 0 || dir.y !== 0) ? Math.atan2(dir.y, dir.x) : m.textRotation ?? 0;
  const att = m.textAttachment ?? m.textAttachmentPoint;
  return {
    ...base,
    type: 'leader',
    vertices: main,
    arrow: m.leaderLineType !== 0,
    arrowSize: m.arrowheadSize && m.arrowheadSize > 0 ? m.arrowheadSize : dimStyle.arrowSize * (dimStyle.scale || 1),
    ...(dogleg ? { dogleg } : {}),
    ...(m.leaderLineType === 2 ? { spline: true } : {}),
    ...(paths.length ? { extraPaths: paths } : {}),
    ...(text && m.textAnchor ? { text, textPosition: p2(m.textAnchor), ...(hasFormatting(raw) ? { raw } : {}) } : {}),
    textHeight: m.textHeight && m.textHeight > 0 ? m.textHeight : dimStyle.textHeight,
    ...(att && att >= 1 && att <= 9 ? { textAttachment: att as MTextAttachment } : {}),
    ...(m.textWidth && m.textWidth > 0 ? { textWidth: m.textWidth } : {}),
    ...(Math.abs(rot) > 1e-12 ? { textRotation: rot } : {}),
    kind: 'mleader',
  };
}

function convertImage(im: DwgImageEntity, base: Base, imageDefs: ReadonlyMap<string, string>, notes: string[]): ImageEntity {
  const path = imageDefs.get(String(im.imageDefHandle ?? '').toUpperCase()) ?? '';
  if (!path) notes.push('IMAGE: the image file name is not available from this DWG reader; the frame is kept.');
  const clip = (im.clippingBoundaryPath ?? []).map((q) => p2(q));
  return {
    ...base,
    type: 'image',
    path,
    position: p2(im.position),
    u: p2(im.uPixel),
    v: p2(im.vPixel),
    size: { x: im.imageSize?.x || 1, y: im.imageSize?.y || 1 },
    ...(clip.length >= 2 ? { clip: im.clippingBoundaryType === 1 ? clip.slice(0, 2) : clip } : {}),
    ...(im.clipping ? { clipOn: true } : {}),
    flags: im.flags ?? 7,
    brightness: im.brightness ?? 50,
    contrast: im.contrast ?? 50,
    fade: im.fade ?? 0,
  };
}

/** ACAD_TABLE with readable cell data -> native table (null otherwise; the *T block is used instead). */
export function convertTable(e: DwgEntity): TableEntity | null {
  const t = e as unknown as Partial<DwgTableEntity>;
  const rows = t.rowCount ?? 0;
  const cols = t.columnCount ?? 0;
  const rh = t.rowHeightArr ?? [];
  const cw = t.columnWidthArr ?? [];
  const cells = t.cells ?? [];
  if (rows < 1 || cols < 1 || rh.length !== rows || cw.length !== cols || cells.length < rows * cols) return null;
  if (!cells.some((c) => c.text && c.text.trim())) return null;
  const grid: TableCell[][] = [];
  const heights: number[] = [];
  for (let r = 0; r < rows; r += 1) {
    const row: TableCell[] = [];
    for (let c = 0; c < cols; c += 1) {
      const cell = cells[r * cols + c]!;
      const raw = cell.text ?? '';
      const text = raw ? mtextFromDxf(raw) : '';
      const spanC = Math.max(1, Math.round(cell.borderWidth ?? 1));
      const spanR = Math.max(1, Math.round(cell.borderHeight ?? 1));
      if (cell.textHeight > 0) heights.push(cell.textHeight);
      const att = cell.attachmentPoint as number | undefined;
      row.push({
        text,
        ...(text && hasFormatting(raw) ? { raw } : {}),
        ...(cell.textHeight > 0 ? { height: cell.textHeight } : {}),
        ...(att && att >= 1 && att <= 9 ? { attachment: att as MTextAttachment } : {}),
        ...(spanC > 1 || spanR > 1 ? { span: { rows: spanR, cols: spanC } } : {}),
      });
    }
    grid.push(row);
  }
  heights.sort((a, b) => a - b);
  const dir = t.directionVector;
  return {
    ...baseProps(e),
    type: 'table',
    position: p2(t.startPoint),
    rotation: dir && (dir.x !== 0 || dir.y !== 0) ? Math.atan2(dir.y, dir.x) : 0,
    rowHeights: [...rh],
    columnWidths: [...cw],
    cells: grid,
    textHeight: heights[Math.floor(heights.length / 2)] ?? 0.18,
  };
}

/** Field expressions in DWG text (rare: DWG keeps codes in FIELD objects) are evaluated like DXF. */
function textWithField(text: string): { text: string; field?: FieldLink } {
  if (!hasFields(text)) return { text };
  const value = evaluateFields(text, {});
  return { text: value, field: { code: text, value } };
}

/** Lookups for entity types that refer to other objects (LEADER -> MTEXT, IMAGE -> IMAGEDEF). */
interface ConvertExtras {
  annotations: ReadonlyMap<string, DwgEntity>;
  imageDefs: ReadonlyMap<string, string>;
  notes: string[];
  /** Named dimension styles by upper-case name (DIMSTYLE table). */
  dimStyles?: ReadonlyMap<string, DimStyle>;
}

function convertEntity(e: DwgEntity, blockIndex: Map<string, string>, dimStyle: DimStyle = STANDARD_DIMSTYLE, blocks?: Record<string, BlockDef>, extras?: ConvertExtras): Entity | null {
  const base = baseProps(e);
  switch (e.type) {
    case 'SPLINE':
      return convertSpline(e as DwgSplineEntity, base);
    case 'LEADER': {
      const l = e as DwgLeaderEntity;
      return convertLeader(l, base, dimStyle, l.associatedAnnotation ? extras?.annotations.get(String(l.associatedAnnotation).toUpperCase()) : undefined);
    }
    case 'MULTILEADER':
      return convertMLeader(e as DwgMultiLeaderEntity, base, dimStyle, extras?.notes ?? []);
    case 'IMAGE':
      return convertImage(e as DwgImageEntity, base, extras?.imageDefs ?? new Map(), extras?.notes ?? []);
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
    case 'POLYLINE3D': {
      // Flattened to its XY projection (reported as simplified by the caller).
      const pl = e as unknown as { flag?: number; vertices?: Array<{ x: number; y: number }> };
      const verts = pl.vertices ?? [];
      if (verts.length === 0) return null;
      return { ...base, type: 'polyline', points: verts.map((v) => p2(v)), closed: ((pl.flag ?? 0) & 1) === 1 };
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
      return { ...base, type: 'text', position, ...textWithField(t.text ?? ''), height, rotation, align, ...(t.styleName && !/^standard$/i.test(t.styleName) ? { style: t.styleName } : {}), ...(t.xScale && t.xScale !== 1 ? { widthFactor: t.xScale } : {}) };
    }
    case 'MTEXT': {
      const m = e as DwgMTextEntity;
      const h = m.textHeight || 0.125;
      const ap = Math.max(1, Math.min(9, m.attachmentPoint ?? 1)) as MTextAttachment; // 1..9: TL TC TR ML MC MR BL BC BR
      const rot = m.direction && (m.direction.x !== 0 || m.direction.y !== 0) ? Math.atan2(m.direction.y, m.direction.x) : m.rotation ?? 0;
      const source = m.text ?? '';
      const raw = hasFields(source) ? evaluateFields(source, {}) : source;
      const plain = mtextFromDxf(raw);
      return {
        ...base,
        type: 'mtext',
        position: p2(m.insertionPoint),
        text: plain,
        ...(hasFormatting(raw) ? { raw } : {}),
        ...(raw !== source ? { field: { code: source, value: plain } } : {}),
        height: h,
        width: Math.max(0, m.rectWidth ?? 0),
        rotation: rot,
        attachment: ap,
        lineSpacing: m.lineSpacing && m.lineSpacing > 0 ? m.lineSpacing : 1,
        ...(m.styleName && !/^standard$/i.test(m.styleName) ? { style: m.styleName } : {}),
        ...((m.columnType === 1 || m.columnType === 2) && m.columnWidth > 0 && m.columnHeightCount > 0 && m.columnHeightCount <= 256 ? { columns: { type: m.columnType as 1 | 2, count: m.columnHeightCount, width: m.columnWidth, gutter: Math.max(0, m.columnGutter ?? 0), autoHeight: !!m.columnAutoHeight, reversed: !!m.columnFlowReversed, heights: (m.columnHeights ?? []).slice(0, m.columnHeightCount) } } : {}),
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
    case 'DIMENSION': {
      const named = (e as { styleName?: string }).styleName;
      let style = (named && extras?.dimStyles?.get(named.toUpperCase())) || dimStyle;
      if (e.xdata?.appName === 'ACAD') {
        const flat = e.xdata.value.flatMap((v) => Array.isArray(v.value) ? v.value : [v]);
        const start = flat.findIndex((v) => v.value === 'DSTYLE');
        const pairs: Array<readonly [number, number | string]> = [];
        for (let i = start + 1; start >= 0 && i + 1 < flat.length; i += 1) if (flat[i]!.code === 1070 && typeof flat[i]!.value === 'number' && !Array.isArray(flat[i + 1]!.value)) { pairs.push([flat[i]!.value as number, flat[i + 1]!.value as number | string]); i += 1; }
        if (pairs.length) style = dimStyleFromRecordPairs(style.name, pairs, style);
      }
      return convertDimension(e as DwgDimensionEntity, base, style);
    }
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
  /** The import report (also attached to `state.meta.importReport`); null when nothing was lost. */
  report: ImportReport | null;
}

/** Text styles of the STYLE table (oblique radians -> degrees; shape-file entries skipped). */
function convertStyles(styles: readonly DwgPayloadStyle[], report: ImportReportBuilder): Record<string, TextStyle> {
  const out: Record<string, TextStyle> = {};
  let fixedHeights = 0;
  for (const t of styles) {
    if (!t.name || ((t.standardFlag ?? 0) & 1) === 1) continue;
    const oblique = typeof t.obliqueAngle === 'number' && Number.isFinite(t.obliqueAngle) ? (t.obliqueAngle * 180) / Math.PI : 0;
    out[t.name] = {
      name: t.name,
      font: t.font ?? '',
      bigFont: t.bigFont ?? '',
      flags: (t.standardFlag ?? 0) & 4,
      height: t.fixedTextHeight && t.fixedTextHeight > 0 ? t.fixedTextHeight : 0,
      widthFactor: t.widthFactor && t.widthFactor > 0 ? t.widthFactor : 1,
      oblique: Math.abs(oblique) < 1e-9 ? 0 : oblique,
      generation: t.textGenerationFlag ?? 0,
    };
    if (!t.fixedTextHeight) fixedHeights += 1;
    const fontWarning = fontImportWarning(out[t.name]!);
    if (fontWarning) report.add({ type: 'STYLE', action: 'unsupported', reason: fontWarning });
  }
  // LibreDWG does not decode a style's fixed text height (it always reports 0).
  if (fixedHeights && styles.some((t) => t.name && !/^standard$/i.test(t.name))) {
    report.add({ type: 'STYLE', action: 'unsupported', reason: `fixed text heights of ${fixedHeights} text style(s) are not exposed by the DWG reader (text keeps its own height)` });
  }
  return out;
}

/** Linetypes of the LTYPE table beyond the standard set (same rules as the DXF reader). */
function convertLinetypes(list: readonly DwgPayloadLinetype[], report: ImportReportBuilder): Linetype[] {
  const out: Linetype[] = [];
  for (const lt of list) {
    if (!lt.name || /^(BYLAYER|BYBLOCK|CONTINUOUS)$/i.test(lt.name)) continue;
    const elements = lt.pattern ?? [];
    const pattern = elements.map((x) => x.elementLength).filter((v) => Number.isFinite(v));
    if (elements.some((x) => ((x.elementTypeFlag ?? 0) & 6) !== 0)) {
      report.add({ type: 'LTYPE', action: 'simplified', reason: `linetype ${lt.name}: its embedded text / shape elements are not kept (the dashes are)` });
    }
    const std = findLinetype(lt.name);
    if (std && std.pattern.length === pattern.length && std.pattern.every((v, k) => Math.abs(v - pattern[k]!) < 1e-9)) continue;
    out.push({ name: lt.name, description: lt.description ?? '', pattern });
  }
  return out;
}

/** Entity types convertEntity handles (a null result for these means an unsupported variant). */
const DWG_CONVERTED_TYPES = new Set(['SPLINE', 'LEADER', 'MULTILEADER', 'IMAGE', 'LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'POLYLINE2D', 'POLYLINE3D', 'TEXT', 'MTEXT', 'ELLIPSE', 'POINT', 'XLINE', 'RAY', 'SOLID', 'DIMENSION', 'INSERT']);

/** DWG viewport status bits (VIEWPORT 90): display locked, viewport off. */
const DWG_VP_LOCKED = 16384;
const DWG_VP_OFF = 131072;

/**
 * Paper-space layouts from the LAYOUT objects and their *Paper_Space blocks. LibreDWG does not
 * expose the page setup: the sheet is taken from the layout limits (paper-space drawing units,
 * the limits' lower-left corner being the sheet corner) and the plot settings are defaults.
 */
function convertLayouts(
  payload: DwgImportPayload,
  convert: (e: DwgEntity, where: string) => Entity | null,
  host: { entities: readonly Entity[]; header: DrawingHeader },
  report: ImportReportBuilder,
): Layout[] | undefined {
  const units = unitsOfHost(host);
  const out: Array<{ layout: Layout; tab: number }> = [];
  let unknownFrozen = 0;
  const layerNames = new Map(payload.layers.flatMap((l) => l.handle ? [[l.handle.toUpperCase(), l.name] as const] : []));
  for (const lo of payload.layouts ?? []) {
    if (!lo.name || /^model$/i.test(lo.name)) continue;
    const block = payload.blocks.find((b) => b.handle && String(b.handle).toUpperCase() === lo.blockHandle.toUpperCase());
    if (block && /^\*MODEL_SPACE$/i.test(block.name ?? '')) continue;
    const min = lo.minLimit ?? { x: 0, y: 0 };
    const max = lo.maxLimit ?? { x: 0, y: 0 };
    const w = max.x - min.x;
    const h = max.y - min.y;
    const valid = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
    const orientation = valid && w < h ? 'portrait' : 'landscape';
    // The limits are in paper units, which the DWG reader does not tell: the drawing units first,
    // the other unit when only that one gives a known sheet (an R14 drawing has no INSUNITS).
    const other = units === 'mm' ? 'in' : 'mm';
    const guess = valid ? paperFromSize(w, h, units, orientation) : null;
    const alt = guess && guess.id === 'custom' ? paperFromSize(w, h, other, orientation) : null;
    const paper = guess ? (alt && alt.id !== 'custom' ? alt : guess) : { id: units === 'mm' ? 'a3' : 'tabloid', width: units === 'mm' ? 297 : 11, height: units === 'mm' ? 420 : 17, units, orientation: 'landscape' as const };
    const vps = (block?.entities ?? []).filter((e) => e.type === 'VIEWPORT') as Array<DwgEntity & { viewportId?: number }>;
    // The overall paper-space viewport has id 1 (else: the first VIEWPORT, as the DXF reader does).
    const overall = vps.find((v) => v.viewportId === 1) ?? vps[0];
    // AutoCAD paper space has its origin at the printable-area corner: the limits start at -margin.
    const margin = valid ? Math.max(0, Math.min(-min.x, -min.y)) : units === 'mm' ? 6.35 : 0.25;
    const offset = valid ? { x: -min.x, y: -min.y } : { x: margin, y: margin };
    const where = `layout "${lo.name}"`;
    const entities: Entity[] = [];
    const viewports: LayoutViewport[] = [];
    for (const e of block?.entities ?? []) {
      if (e.type === 'ATTRIB' || e.type === 'ATTDEF') continue;
      if (e.type === 'VIEWPORT') {
        const v = e as DwgEntity & { viewportId?: number; viewportCenter?: { x: number; y: number }; width?: number; height?: number; displayCenter?: { x: number; y: number }; viewHeight?: number; statusBitFlags?: number; clippingBoundaryId?: string; viewTwistAngle?: number; frozenLayerIds?: string[]; frozenLayers?: string[] };
        if (e === overall) continue; // the overall paper-space viewport
        const vw = v.width ?? 0;
        const vh = v.height ?? 0;
        const viewHeight = v.viewHeight ?? 0;
        const item = { type: 'VIEWPORT', layer: e.layer || '0', where, ...(e.handle ? { handle: String(e.handle) } : {}) };
        if (!(vw > 0 && vh > 0 && viewHeight > 0)) {
          report.add({ ...item, action: 'dropped', reason: 'invalid viewport size or view height' });
          continue;
        }
        if (v.clippingBoundaryId && v.clippingBoundaryId !== '0') report.add({ ...item, action: 'simplified', reason: 'its clipping boundary is not kept: the viewport shows its whole rectangle' });
        if (v.viewTwistAngle && Math.abs(v.viewTwistAngle) > 1e-9) report.add({ ...item, action: 'simplified', reason: 'its twisted view is shown untwisted' });
        const flags = v.statusBitFlags ?? 0;
        const frozen = v.frozenLayers ?? v.frozenLayerIds?.map((id) => layerNames.get(String(id).toUpperCase()) ?? (payload.layers.some((l) => l.name === id) ? id : undefined)).filter((n): n is string => !!n);
        if (!v.frozenLayers && !v.frozenLayerIds) unknownFrozen += 1;
        else if (v.frozenLayerIds && frozen?.length !== v.frozenLayerIds.length) report.add({ ...item, action: 'simplified', reason: 'some frozen layer handles could not be resolved; the resolved frozen layers are kept' });
        viewports.push({
          id: newViewportId(),
          center: { x: (v.viewportCenter?.x ?? 0) + offset.x, y: (v.viewportCenter?.y ?? 0) + offset.y },
          width: vw,
          height: vh,
          view: { center: p2(v.displayCenter), scale: vh / viewHeight, ...(flags & DWG_VP_LOCKED ? { locked: true } : {}) },
          layer: e.layer || '0',
          on: !(flags & DWG_VP_OFF),
          ...(frozen?.length ? { frozenLayers: frozen } : {}),
        });
        continue;
      }
      const c = convert(e, where);
      if (c) entities.push(offset.x || offset.y ? translateEntity(c, offset) : c);
    }
    const ps = lo.plotSettings;
    const plotPaper = ps && (ps.paperWidth ?? 0) > 0 && (ps.paperHeight ?? 0) > 0 ? paperFromSize(ps.paperWidth!, ps.paperHeight!, ps.plotPaperUnit === 0 ? 'in' : 'mm', ps.plotRotation === 1 || ps.plotRotation === 3 ? 'landscape' : 'portrait') : null;
    const layout: Layout = {
      name: lo.name,
      paper: plotPaper ?? paper,
      plotScale: ps?.printScaleNominator && ps.printScaleDenominator ? `${ps.printScaleNominator}:${ps.printScaleDenominator}` : '1:1',
      margins: ps ? { left: ps.marginLeft ?? margin, bottom: ps.marginBottom ?? margin, right: ps.marginRight ?? margin, top: ps.marginTop ?? margin } : uniformMargins(margin),
      entities,
      viewports,
      plotStyle: 'monochrome',
      ...(entities.length === 0 && viewports.length === 0 ? { pristine: true } : {}),
    };
    out.push({ layout, tab: lo.tabOrder ?? out.length + 1 });
    report.add({ type: 'LAYOUT', action: 'unsupported', where, reason: ps ? 'exposed page size, margins and scale are kept; plot device and external plot style tables are not retained' : 'page setup (plot device, plot scale, plot style) is not exposed by the DWG reader: the paper size is taken from the layout limits' });
  }
  if (unknownFrozen) report.add({ type: 'VIEWPORT', action: 'unsupported', reason: `layers frozen in individual viewports (VPLAYER) are not exposed by the DWG reader: ${unknownFrozen} viewport(s) show every layer` });
  out.sort((a, b) => a.tab - b.tab);
  const layouts = out.map((o) => o.layout);
  if (layouts.length === 0) return undefined;
  if (layouts.length === 1 && layouts[0]!.pristine && /^layout1$/i.test(layouts[0]!.name)) return undefined;
  return layouts;
}

/** A dimension style from DIM* variables (header variables or a DIMSTYLE record, same names). */
function dimStyleFromVars(h: Record<string, unknown>, name: string): DimStyle {
  const num = (k: string, d: number): number => {
    const v = h[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
  };
  const dimlunit = Math.trunc(num('DIMLUNIT', 2));
  const basic: DimStyle = {
    name,
    textHeight: num('DIMTXT', STANDARD_DIMSTYLE.textHeight),
    arrowSize: num('DIMASZ', STANDARD_DIMSTYLE.arrowSize),
    extOffset: num('DIMEXO', STANDARD_DIMSTYLE.extOffset),
    extExtend: num('DIMEXE', STANDARD_DIMSTYLE.extExtend),
    textGap: num('DIMGAP', STANDARD_DIMSTYLE.textGap),
    centerMark: num('DIMCEN', STANDARD_DIMSTYLE.centerMark),
    scale: num('DIMSCALE', 1) || 1,
    decimals: cadPrecision(num('DIMDEC', 4), 4),
    lunit: (dimlunit >= 1 && dimlunit <= 5 ? dimlunit : 2) as LinearUnits,
    angularDecimals: num('DIMADEC', 0) === -1 ? -1 : cadPrecision(num('DIMADEC', 0)),
  };
  // The rest of the DIM* variables (arrows, tolerances, alternate units, text placement, colours ...)
  // when LibreDWG provides them. Colours may come as a number or as a { index } colour object.
  return withDimVars(basic, (key) => {
    const v = h[key];
    if (typeof v === 'number' || typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof (v as { index?: unknown }).index === 'number') return (v as { index: number }).index;
    return undefined;
  });
}

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
  const dimStyle = dimStyleFromVars(h, typeof h.DIMSTYLE === 'string' && h.DIMSTYLE ? h.DIMSTYLE : 'Standard');
  return {
    ...DEFAULT_HEADER,
    units: {
      lunits: (lunits >= 1 && lunits <= 5 ? lunits : 2) as LinearUnits,
      luprec: cadPrecision(num('LUPREC', 4), 4),
      insunits: Math.trunc(num('INSUNITS', 1)),
      auprec: cadPrecision(num('AUPREC', 0)),
      ...(typeof h.AUNITS === 'number' && Number.isFinite(h.AUNITS) ? { aunits: h.AUNITS } : {}),
    },
    ltscale: num('LTSCALE', 1) || 1,
    ...(typeof h.CELTSCALE === 'number' && Number.isFinite(h.CELTSCALE) ? { celtscale: h.CELTSCALE } : {}),
    ...(typeof h.TEXTSTYLE === 'string' && h.TEXTSTYLE ? { textStyle: h.TEXTSTYLE } : {}),
    limits: { min: pt('LIMMIN', DEFAULT_HEADER.limits.min), max: pt('LIMMAX', DEFAULT_HEADER.limits.max) },
    pdmode: Math.trunc(num('PDMODE', 0)),
    pdsize: num('PDSIZE', 0),
    dimStyle,
    celtype: typeof h.CELTYPE === 'string' && h.CELTYPE ? h.CELTYPE : 'ByLayer',
  };
}

export function convertDwg(payload: DwgImportPayload, sourcePath?: string | null): DwgImportResult {
  let records = payload.entities.length + payload.layers.length + payload.blocks.length;
  for (const block of payload.blocks) records += block.entities.length;
  if (records > 250_000) throw new Error('DWG exceeds the import record limit (250000).');
  let metadataNodes = 0, stringLength = 0;
  const checkStrings = (value: unknown, depth = 0): void => {
    if (++metadataNodes > 2_000_000) throw new Error('DWG metadata exceeds the import allocation budget.');
    if (typeof value === 'string' && value.length > 1024 * 1024) throw new Error('DWG value exceeds the import string length limit (1048576).');
    if (typeof value === 'string' && (stringLength += value.length) > 64 * 1024 * 1024) throw new Error('DWG strings exceed the total import size limit.');
    if (depth > 64) throw new Error('DWG metadata nesting exceeds the import limit.');
    if (value && typeof value === 'object') for (const entry of Object.values(value)) checkStrings(entry, depth + 1);
  };
  checkStrings(payload);
  const skipped: Record<string, number> = {};
  const notes: string[] = [];
  const report = new ImportReportBuilder();
  for (const source of [payload.header, ...(payload.dimStyles ?? [])]) for (const name of ['DIMDEC', 'DIMADEC', 'DIMALTD', 'DIMTDEC', 'LUPREC', 'AUPREC']) {
    if (source[name] === undefined) continue;
    const value = Number(source[name]);
    if (!Number.isInteger(value) || value < (name === 'DIMADEC' ? -1 : 0) || value > 8) report.add({ type: source === payload.header ? 'HEADER' : 'DIMSTYLE', action: 'simplified', reason: `${name} precision ${String(source[name]).slice(0, 40)} is outside its valid range; a bounded display precision is used` });
  }
  const supportedDimNames = new Set([...DIM_VARIABLES.map((v) => v.name), 'DIMSTYLE', 'DIMTOL', 'DIMLIM', 'DIMTIH', 'DIMTOH', 'DIMZIN', 'DIMSAH', 'DIMBLK']);
  for (const source of [payload.header, ...(payload.dimStyles ?? [])]) {
    const unsupported = Object.entries(source).filter(([name, value]) => name.startsWith('DIM') && !supportedDimNames.has(name) && value !== '' && Number(value) !== 0).map(([name]) => name);
    if (unsupported.length) report.add({ type: source === payload.header ? 'HEADER' : 'DIMSTYLE', action: 'simplified', reason: `${unsupported.join(', ')} settings exposed by the DWG reader are not modeled or written back; supported dimension variables are kept` });
  }
  report.add({ type: 'XDATA', action: 'unsupported', reason: 'the DWG reader may omit application XDATA, extension dictionaries, fields and dynamic parameters; these cannot be guaranteed on DXF save. Compare a source DXF export when metadata fidelity matters' });
  for (const [type, count] of Object.entries(payload.omittedObjectTypes ?? {})) if (count > 0) report.add({ type, action: 'dropped', reason: `${count} object metadata record(s) exposed by the DWG reader are not retained in the drawing model` });
  const currentStyleName = typeof payload.header.DIMSTYLE === 'string' ? payload.header.DIMSTYLE : 'Standard';
  const currentStyleRecord = payload.dimStyles?.find((s) => s.name.toUpperCase() === currentStyleName.toUpperCase());
  const styleByHandle = new Map((payload.styles ?? []).flatMap((s) => s.handle ? [[s.handle.toUpperCase(), s.name] as const] : []));
  const mergedHeader = { ...currentStyleRecord, ...payload.header };
  const currentTextStyle = mergedHeader.DIMTXSTY === undefined ? undefined : styleByHandle.get(String(mergedHeader.DIMTXSTY).toUpperCase());
  const baseHeader = readHeader({ ...mergedHeader, ...(currentTextStyle ? { DIMTXSTY: currentTextStyle } : {}) });
  const linetypes = convertLinetypes(payload.linetypes ?? [], report);
  const header: DrawingHeader = linetypes.length ? { ...baseHeader, linetypes } : baseHeader;
  // Named dimension styles: the DIMSTYLE records; the current one is the header's DIM* variables.
  const dimStyles = new Map<string, DimStyle>();
  for (const d of payload.dimStyles ?? []) if (d.name) {
    const textStyle = d.DIMTXSTY === undefined ? undefined : styleByHandle.get(String(d.DIMTXSTY).toUpperCase());
    dimStyles.set(d.name.toUpperCase(), dimStyleFromVars({ ...d, ...(textStyle ? { DIMTXSTY: textStyle } : {}) }, d.name));
  }
  if (dimStyles.has(header.dimStyle.name.toUpperCase())) dimStyles.set(header.dimStyle.name.toUpperCase(), header.dimStyle);
  /** An entity the converter could not use: counted and listed in the import report. */
  const skip = (e: DwgEntity, where: string, reason?: string) => {
    skipped[e.type] = (skipped[e.type] ?? 0) + 1;
    report.add({ type: e.type, action: 'dropped', reason: reason ?? `${e.type} objects are not supported`, ...(e.handle ? { handle: String(e.handle) } : {}), layer: e.layer || '0', where });
  };
  /**
   * Convert one entity and check it like a DXF one (non-finite coordinates, negative radii ...);
   * anything not converted is counted and listed in the report.
   */
  const convertChecked = (e: DwgEntity, where: string, blockDefs: Record<string, BlockDef> | undefined, extras: ConvertExtras): Entity | null => {
    const previousNotes = extras.notes.length;
    let c: Entity | null;
    try {
      c = convertEntity(e, blockIndex, header.dimStyle, blockDefs, extras);
    } catch (err) {
      if (!(err instanceof SplineWorkLimitError)) throw err;
      skip(e, where, err.message);
      return null;
    }
    if (!c) {
      skip(e, where, e.type === 'DIMENSION' ? 'this dimension type is not supported (ordinate dimensions, or unreadable definition points)' : DWG_CONVERTED_TYPES.has(e.type) ? 'its data is incomplete or of a variant that is not supported' : undefined);
      return null;
    }
    const bad = geometryProblem(c);
    if (!bad) {
      const item = { type: e.type, ...(e.handle ? { handle: String(e.handle) } : {}), layer: e.layer || '0', where };
      for (const note of extras.notes.slice(previousNotes)) report.add({ ...item, action: 'simplified', reason: note });
      if (e.xdata) report.add({ ...item, action: 'simplified', reason: `application XDATA (${e.xdata.appName || 'unnamed'}) is not written back; supported DSTYLE values are applied to dimensions` });
      if (e.transparency || e.colorName) report.add({ ...item, action: 'simplified', reason: 'transparency/color-book names are not kept; RGB/ACI color is kept' });
      if (c.type === 'mtext' && c.columns) report.add({ ...item, action: 'simplified', reason: 'MTEXT column definitions are kept in JCAD_MTEXT_COLUMNS for JCad reimport; external CAD displays one column in AutoCAD 2000 export' });
      if (e.type === 'MTEXT' && (e as DwgMTextEntity).backgroundFill) report.add({ ...item, action: 'simplified', reason: 'MTEXT background fill is not kept' });
      if (e.type === 'POLYLINE3D') report.add({ type: e.type, action: 'simplified', reason: '3D polyline: flattened to its XY projection', ...(e.handle ? { handle: String(e.handle) } : {}), layer: e.layer || '0', where });
      return c;
    }
    skip(e, where, `invalid geometry: ${bad}`);
    return null;
  };
  const isLayout = (name: string) => /^\*(MODEL_SPACE|PAPER_SPACE)/i.test(name);
  // Anonymous blocks (*U12 ...) hold dynamic-block and array geometry; keep them under a legal name.
  const publicName = (name: string) => (name.startsWith('*') ? `ANON_${name.slice(1).replace(/[^A-Za-z0-9_]/g, '_')}` : name);
  const blockIndex = new Map<string, string>();
  for (const b of payload.blocks) if (b.name && !isLayout(b.name)) blockIndex.set(b.name.toUpperCase(), publicName(b.name));
  // libredwg-web lists paper-space entities in db.entities without flagging them: skip them by handle.
  const paperHandles = new Set<string>();
  for (const b of payload.blocks) if (b.name && /^\*PAPER_SPACE/i.test(b.name)) for (const e of b.entities) if (e.handle) paperHandles.add(e.handle);

  const imageDefs = new Map<string, string>();
  for (const d of payload.imageDefs ?? []) if (d.handle) imageDefs.set(d.handle.toUpperCase(), d.fileName);
  /** MTEXT annotations of LEADERs: merged into the leader and not converted on their own. */
  const annotationsOf = (list: readonly DwgEntity[]) => {
    const byHandle = new Map<string, DwgEntity>();
    for (const e of list) if (e.type === 'MTEXT' && e.handle) byHandle.set(String(e.handle).toUpperCase(), e);
    const used = new Map<string, DwgEntity>();
    for (const e of list) {
      const h = e.type === 'LEADER' ? (e as DwgLeaderEntity).associatedAnnotation : undefined;
      const ann = h ? byHandle.get(String(h).toUpperCase()) : undefined;
      if (ann) used.set(String(h).toUpperCase(), ann);
    }
    return used;
  };
  const noteSet = new Set<string>();
  const extrasFor = (list: readonly DwgEntity[]): ConvertExtras & { consumed: Set<DwgEntity> } => {
    const annotations = annotationsOf(list);
    return { annotations, imageDefs, notes: [], consumed: new Set(annotations.values()), dimStyles };
  };
  /** HATCH: a real hatch entity; outline polylines when the boundary cannot be rebuilt. */
  const hatchOf = (e: DwgEntity, where: string): { parts: Entity[]; reason?: string } => {
    try {
      const h = convertHatchEntity(e);
      if (h && !geometryProblem(h)) {
        if (h.associative) report.add({ type: 'HATCH', action: 'simplified', handle: String(e.handle ?? ''), where, reason: 'associative boundary links are not kept; hatch geometry is kept and saved non-associative' });
        return { parts: [h] };
      }
    } catch (err) {
      if (err instanceof HatchGeometryError) return { parts: [], reason: `invalid geometry: ${err.message}` };
      if (err instanceof SplineWorkLimitError) return { parts: [], reason: err.message };
      /* fall back to outlines */
    }
    let parts: Entity[];
    try {
      parts = convertHatch(e);
    } catch (err) {
      if (err instanceof HatchGeometryError) return { parts: [], reason: `invalid geometry: ${err.message}` };
      throw err;
    }
    if (parts.length) { noteSet.add('HATCH: some hatch boundaries could not be rebuilt and were imported as outlines.'); report.add({ type: 'HATCH', action: 'simplified', handle: String(e.handle ?? ''), where, reason: 'some hatch boundaries could not be rebuilt; imported as outlines' }); }
    return { parts: parts.filter((part) => !geometryProblem(part)) };
  };

  const blocks: Record<string, BlockDef> = {};
  for (const b of payload.blocks) {
    if (!b.name || isLayout(b.name)) continue;
    const entities: Entity[] = [];
    const attributes: AttributeDef[] = [];
    const bx = extrasFor(b.entities);
    for (const e of b.entities) {
      if (bx.consumed.has(e)) continue;
      if (e.type === 'ATTDEF') {
        attributes.push(convertAttdef(e as DwgAttdefEntity));
        continue;
      }
      if (e.type === 'HATCH') {
        const { parts, reason } = hatchOf(e, `block "${b.name}"`);
        if (parts.length) entities.push(...parts);
        else skip(e, `block "${b.name}"`, reason ?? 'the hatch boundary could not be read');
        continue;
      }
      const c = convertChecked(e, `block "${b.name}"`, undefined, bx);
      if (c) entities.push(c);
    }
    for (const n of bx.notes) noteSet.add(n);
    const name = publicName(b.name);
    const isXref = ((b.flags ?? 0) & 4) === 4;
    blocks[name] = { name, basePoint: p2(b.basePoint), entities, attributes, description: b.description || undefined, ...(isXref ? { xref: { path: b.name, ...(((b.flags ?? 0) & 8) === 8 ? { overlay: true } : {}) } } : {}) };
    if (isXref) noteSet.add(`XREF ${b.name}: the reference is kept, but the DWG reader does not expose its file path (the block name is used).`);
    if (isXref) report.add({ type: 'XREF', action: 'simplified', reason: `external reference "${b.name}" file path is not exposed; the block name is used as an estimate` });
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
  const mx = extrasFor(payload.entities);
  for (const e of payload.entities) {
    if (e.isInPaperSpace || (e.handle && paperHandles.has(e.handle))) continue;
    if (e.type === 'ATTDEF' || e.type === 'VIEWPORT' || e.type === 'ATTRIB') continue; // ATTRIBs are folded into their INSERTs
    if (mx.consumed.has(e)) continue; // a LEADER's MTEXT, merged into the leader
    if (e.type === 'HATCH') {
      const { parts, reason } = hatchOf(e, 'model space');
      if (parts.length) entities.push(...parts);
      else skip(e, 'model space', reason ?? 'the hatch boundary could not be read');
      continue;
    }
    if (e.type === 'ACAD_TABLE') {
      const native = convertTable(e);
      if (native) {
        const bad = geometryProblem(native);
        if (bad) { skip(e, 'model space', `invalid geometry: ${bad}`); continue; }
        entities.push(native);
        report.add({ type: 'ACAD_TABLE', action: 'simplified', ...(e.handle ? { handle: String(e.handle) } : {}), layer: e.layer || '0', where: 'model space', reason: 'table cells and sizes are kept; native table editing, formulas and advanced cell/style formatting are not modeled, and export uses an INSERT picture with JCAD_TABLE data' });
        // Its *T block is no longer drawn.
        const bh = (e as unknown as { blockRecordHandle?: string }).blockRecordHandle;
        const bname = bh ? tableBlocksByHandle.get(String(bh).toUpperCase()) : undefined;
        if (bname) {
          delete blocks[bname];
          const k = spareTableBlocks.indexOf(bname);
          if (k >= 0) spareTableBlocks.splice(k, 1);
        }
        continue;
      }
      const ins = tableInsert(e);
      if (ins) { entities.push(ins); report.add({ type: 'ACAD_TABLE', action: 'simplified', handle: String(e.handle ?? ''), where: 'model space', reason: 'unreadable cell data is replaced by its anonymous picture block; table editing, formulas and cell metadata are lost' }); }
      else skip(e, 'model space', 'the table data and its block could not be read');
      continue;
    }
    const c = convertChecked(e, 'model space', blocks, mx);
    if (c) entities.push(c);
  }
  for (const n of mx.notes) noteSet.add(n);

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
      report.add({ type: 'ACAD_TABLE', action: 'simplified', where: 'model space', reason: `table ${ins.block} position was estimated ${where}; the DWG reader did not expose the insertion point` });
    }
  }

  // The DWG reader's own `locked` is unreliable (reported for every layer); bit 4 of the layer flags
  // is the lock in every DWG version (R14: 64 + 4 + 1, R2000+: 16 + 4 + 1 for a frozen locked layer).
  // Plot flags exist from R2000 on: an R14 file reports 0 for every layer.
  const plotFlags = payload.layers.some((l) => l.plotFlag === 1);
  const layers: Layer[] = payload.layers
    .filter((l) => l.name)
    .map((l) => ({
      ...(plotFlags && l.plotFlag === 0 ? { plot: false } : {}),
      name: l.name,
      // colorIndex 256 marks a true-colour layer (its RGB in `color`); 7 is the ACI shown by older readers.
      color: Math.abs(l.colorIndex) >= 1 && Math.abs(l.colorIndex) <= 255 ? Math.abs(l.colorIndex) : 7,
      ...(l.colorIndex === 256 && typeof l.color === 'number' ? { trueColor: l.color & 0xffffff } : {}),
      visible: !l.off && !l.frozen,
      ...(l.frozen ? { frozen: true } : {}),
      ...((l.standardFlag ?? 0) & 48 ? { xrefFlags: (l.standardFlag ?? 0) & 48 } : {}),
      locked: typeof l.standardFlag === 'number' ? (l.standardFlag & 4) !== 0 : !!l.locked,
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

  // Paper space: layouts with their entities and viewports.
  const layouts = convertLayouts(
    payload,
    (e, where) => convertChecked(e, where, blocks, mx),
    { entities, header },
    report,
  );
  for (const l of layouts ?? []) {
    for (const e of l.entities) ensure(e.layer);
    for (const v of l.viewports) ensure(v.layer);
  }

  notes.push(...noteSet);
  for (const [type, n] of Object.entries(skipped)) notes.push(`${type}: ${n} object(s) of this type are not supported and were skipped.`);
  for (const n of noteSet) report.note(n);
  for (const n of notes) report.note(n);
  const styleMeta = textStylesMeta(convertStyles(payload.styles ?? [], report));
  const named = [...dimStyles.values()].filter((d) => !(d.name.toUpperCase() === 'STANDARD' && diffDimStyles(d, STANDARD_DIMSTYLE).length === 0));
  const meta: Record<string, unknown> = { ...(styleMeta ?? {}), ...(named.length ? { [DIMSTYLES_META_KEY]: Object.fromEntries(named.map((d) => [d.name, d])) } : {}) };
  const base: DrawingState = { entities, layers, blocks, currentLayer, header, ...(Object.keys(meta).length ? { meta } : {}), ...(layouts ? { layouts } : {}) };
  const built = report.empty ? null : report.build('DWG', sourcePath);
  return { state: withImportData(base, built), skipped, notes, report: built };
}
