/**
 * Dimension entities, dimension styles and the geometry that draws them
 * (extension lines, dimension line, arrowheads and text), following AutoCAD.
 *
 * The "Standard" style: DIMTXT 0.18, DIMASZ 0.18, DIMEXO 0.0625, DIMEXE 0.18,
 * DIMGAP 0.09, DIMCEN 0.09, DIMDLI 0.38, DIMTAD 0 (text centred in a broken
 * dimension line), closed-filled arrowheads.
 *
 * Everything added after the first release (arrowhead types, text placement,
 * extension-line suppression, tolerances, alternate units, DIMPOST ...) is an
 * optional field on DimStyle so styles built elsewhere (DXF/DWG import, older
 * drawings) stay valid; `resolveDimStyle` fills in the AutoCAD defaults.
 */
import type { Point } from './geometry';
import * as g from './geometry';
import type { EntityBase, LineEntity, PolylineEntity, TextEntity, ArcEntity, CircleEntity, ColorSpec } from './entities';
import type { DrawingState } from './document';
import { formatLength, formatAngle, type LinearUnits } from './units';

export type DimKind = 'linear' | 'aligned' | 'radius' | 'diameter' | 'angular';

/** Arrowhead shapes (DIMBLK / DIMBLK1 / DIMBLK2). */
export type DimArrow = 'closed-filled' | 'closed-blank' | 'closed' | 'open' | 'oblique' | 'arch-tick' | 'dot' | 'dot-small' | 'dot-blank' | 'none';

/** Arrowhead choices with their AutoCAD block names (the name DXF $DIMBLK / DIMBLK records use). */
export const DIM_ARROWS: ReadonlyArray<{ readonly id: DimArrow; readonly label: string; readonly block: string }> = [
  { id: 'closed-filled', label: 'Closed filled', block: '' },
  { id: 'closed-blank', label: 'Closed blank', block: '_CLOSEDBLANK' },
  { id: 'closed', label: 'Closed', block: '_CLOSED' },
  { id: 'open', label: 'Open', block: '_OPEN' },
  { id: 'oblique', label: 'Oblique', block: '_OBLIQUE' },
  { id: 'arch-tick', label: 'Architectural tick', block: '_ARCHTICK' },
  { id: 'dot', label: 'Dot', block: '_DOT' },
  { id: 'dot-small', label: 'Dot small', block: '_DOTSMALL' },
  { id: 'dot-blank', label: 'Dot blank', block: '_DOTBLANK' },
  { id: 'none', label: 'None', block: '_NONE' },
];

/** DIMTAD: 0 centred, 1 above, 2 outside (away from the defining points), 4 below. */
export type DimTextVertical = 'centered' | 'above' | 'outside' | 'below';
/** DIMTIH / DIMTOH: aligned with the dimension line, always horizontal, or ISO (aligned inside, horizontal outside). */
export type DimTextAlign = 'aligned' | 'horizontal' | 'iso';
/** DIMJUST: 0 centred, 1 next to extension line 1, 2 next to extension line 2. */
export type DimTextJustify = 'centered' | 'ext1' | 'ext2';
/** DIMTOL / DIMLIM plus the "basic" (boxed) display of the Tolerances tab. */
export type DimTolerance = 'none' | 'symmetrical' | 'deviation' | 'limits' | 'basic';
/** DIMATFIT: what moves outside the extension lines first when text and arrows do not both fit. */
export type DimFit = 'best' | 'arrows' | 'text' | 'both';

export interface DimStyle {
  readonly name: string;
  /** DIMTXT */
  readonly textHeight: number;
  /** DIMASZ */
  readonly arrowSize: number;
  /** DIMEXO: gap between the origin and the start of the extension line. */
  readonly extOffset: number;
  /** DIMEXE: how far the extension line runs past the dimension line. */
  readonly extExtend: number;
  /** DIMGAP */
  readonly textGap: number;
  /** DIMCEN: centre mark size for radial dimensions (0 = none). */
  readonly centerMark: number;
  /** DIMSCALE: overall scale applied to all sizes above. */
  readonly scale: number;
  /** DIMDEC */
  readonly decimals: number;
  /** DIMLUNIT */
  readonly lunit: LinearUnits;
  /** DIMADEC */
  readonly angularDecimals: number;

  // ---- Lines ------------------------------------------------------------
  /** DIMDLI: baseline spacing (DIMBASELINE offsets each new dimension line by this). */
  readonly baselineSpacing?: number;
  /** DIMDLE: dimension line extension past the extension lines (tick arrowheads only). */
  readonly dimLineExtend?: number;
  /** DIMSD1 / DIMSD2: suppress the first / second half of the dimension line. */
  readonly suppressDimLine1?: boolean;
  readonly suppressDimLine2?: boolean;
  /** DIMSE1 / DIMSE2: suppress the first / second extension line. */
  readonly suppressExt1?: boolean;
  readonly suppressExt2?: boolean;
  /** DIMCLRD / DIMCLRE: dimension line and extension line colours (undefined = the dimension's colour). */
  readonly dimLineColor?: ColorSpec;
  readonly extLineColor?: ColorSpec;

  // ---- Symbols and arrows -----------------------------------------------
  /** DIMBLK1 (DIMBLK): first arrowhead. */
  readonly arrow?: DimArrow;
  /** DIMBLK2: second arrowhead (undefined = same as the first). */
  readonly arrow2?: DimArrow;

  // ---- Text ---------------------------------------------------------------
  readonly textVertical?: DimTextVertical;
  readonly textAlign?: DimTextAlign;
  readonly textJustify?: DimTextJustify;
  /** DIMCLRT (undefined = the dimension's colour). */
  readonly textColor?: ColorSpec;

  // ---- Fit ----------------------------------------------------------------
  /** DIMATFIT */
  readonly fit?: DimFit;
  /** DIMTIX: always keep text between the extension lines. */
  readonly textInside?: boolean;
  /** DIMTOFL: draw the dimension line between the extension lines even when the arrows are outside. */
  readonly dimLineInside?: boolean;

  // ---- Primary units ------------------------------------------------------
  /** DIMPOST: prefix/suffix; `<>` marks where the measurement goes, otherwise the text is a suffix. */
  readonly post?: string;
  /** DIMRND: round measurements to this increment (0 = none). */
  readonly round?: number;
  /** DIMLFAC: measurement scale factor for linear dimensions. */
  readonly linearFactor?: number;
  /** DIMZIN 4 / 8: suppress leading / trailing zeros of decimal numbers. */
  readonly suppressLeadingZeros?: boolean;
  readonly suppressTrailingZeros?: boolean;

  // ---- Alternate units ----------------------------------------------------
  /** DIMALT */
  readonly altUnits?: boolean;
  /** DIMALTF (25.4: inches -> millimetres) */
  readonly altFactor?: number;
  /** DIMALTD */
  readonly altDecimals?: number;
  /** DIMALTU */
  readonly altLunit?: LinearUnits;
  /** DIMAPOST (`<>` marks the value; default wraps it in brackets). */
  readonly altPost?: string;
  /** Alternate value after the primary one or on a line below it. */
  readonly altPlacement?: 'after' | 'below';

  // ---- Tolerances ---------------------------------------------------------
  readonly tolerance?: DimTolerance;
  /** DIMTP / DIMTM: upper and lower deviation (DIMTM is entered positive, as in AutoCAD). */
  readonly tolPlus?: number;
  readonly tolMinus?: number;
  /** DIMTDEC */
  readonly tolDecimals?: number;
  /** DIMTFAC: tolerance text height as a fraction of DIMTXT. */
  readonly tolScale?: number;
}

/** Every option filled in. */
export type ResolvedDimStyle = Required<Omit<DimStyle, 'dimLineColor' | 'extLineColor' | 'textColor' | 'arrow2'>> & {
  readonly dimLineColor?: ColorSpec;
  readonly extLineColor?: ColorSpec;
  readonly textColor?: ColorSpec;
  readonly arrow2: DimArrow;
};

/** AutoCAD defaults for the optional style fields (imperial "Standard"). */
export const DIM_DEFAULTS = {
  baselineSpacing: 0.38,
  dimLineExtend: 0,
  suppressDimLine1: false,
  suppressDimLine2: false,
  suppressExt1: false,
  suppressExt2: false,
  arrow: 'closed-filled' as DimArrow,
  textVertical: 'centered' as DimTextVertical,
  textAlign: 'aligned' as DimTextAlign,
  textJustify: 'centered' as DimTextJustify,
  fit: 'best' as DimFit,
  textInside: false,
  dimLineInside: true,
  post: '',
  round: 0,
  linearFactor: 1,
  suppressLeadingZeros: false,
  suppressTrailingZeros: false,
  altUnits: false,
  altFactor: 25.4,
  altDecimals: 2,
  altLunit: 2 as LinearUnits,
  altPost: '',
  altPlacement: 'after' as 'after' | 'below',
  tolerance: 'none' as DimTolerance,
  tolPlus: 0,
  tolMinus: 0,
  tolDecimals: 4,
  tolScale: 1,
} as const;

export const STANDARD_DIMSTYLE: DimStyle = {
  name: 'Standard',
  textHeight: 0.18,
  arrowSize: 0.18,
  extOffset: 0.0625,
  extExtend: 0.18,
  textGap: 0.09,
  centerMark: 0.09,
  scale: 1,
  decimals: 4,
  lunit: 2,
  angularDecimals: 0,
};

/** ISO-25, the metric default (millimetre drawings). */
export const ISO25_DIMSTYLE: DimStyle = {
  name: 'ISO-25',
  textHeight: 2.5,
  arrowSize: 2.5,
  extOffset: 0.625,
  extExtend: 1.25,
  textGap: 0.625,
  centerMark: 2.5,
  scale: 1,
  decimals: 2,
  lunit: 2,
  angularDecimals: 0,
  baselineSpacing: 3.75,
  textVertical: 'above',
  altFactor: 0.0394,
  altDecimals: 3,
  tolDecimals: 2,
};

/** Fill in the defaults for every optional field. */
export function resolveDimStyle(s: DimStyle): ResolvedDimStyle {
  const out: Record<string, unknown> = { ...DIM_DEFAULTS };
  for (const [k, v] of Object.entries(s)) if (v !== undefined) out[k] = v;
  out.arrow2 = s.arrow2 ?? s.arrow ?? DIM_DEFAULTS.arrow;
  return out as ResolvedDimStyle;
}

export interface DimensionEntity extends EntityBase {
  readonly type: 'dimension';
  readonly kind: DimKind;
  /**
   * linear/aligned: extension line origins.
   * radius/diameter: p1 = centre, p2 = a point on the circle (sets the direction).
   * angular: points on the two legs.
   */
  readonly p1: Point;
  readonly p2: Point;
  /**
   * linear/aligned: a point on the dimension line.
   * radius/diameter: where the text goes (inside or outside the circle).
   * angular: a point on the dimension arc.
   */
  readonly linePoint: Point;
  /** linear only: direction of the dimension line (0 horizontal, π/2 vertical). */
  readonly rotation: number;
  /** angular: the vertex. */
  readonly center?: Point;
  /** Text override: undefined/'' = measurement, '<>' inserts the measurement, ' ' suppresses. */
  readonly text?: string;
  /** User-moved text centre (undefined = default placement). */
  readonly textPosition?: Point;
  /** DIMTEDIT Angle / DIMEDIT Rotate: absolute text angle (radians); undefined = the style decides. DXF group 53. */
  readonly textRotation?: number;
  /** DIMEDIT Oblique: absolute angle of the extension lines of a linear/aligned dimension (radians). DXF group 52. */
  readonly oblique?: number;
  readonly style: DimStyle;
}

export type DimPart = LineEntity | PolylineEntity | TextEntity | ArcEntity | CircleEntity;
export type Measure = (text: string, height: number) => number;

/** Measured value of a dimension in drawing units (radians for angular). */
export function dimensionMeasurement(d: DimensionEntity): number {
  switch (d.kind) {
    case 'linear': {
      const u = { x: Math.cos(d.rotation), y: Math.sin(d.rotation) };
      return Math.abs(g.dot(g.sub(d.p2, d.p1), u));
    }
    case 'aligned':
      return g.dist(d.p1, d.p2);
    case 'radius':
      return g.dist(d.p1, d.p2);
    case 'diameter':
      return 2 * g.dist(d.p1, d.p2);
    case 'angular': {
      if (!d.center) return 0;
      const [s, e] = angularSweep(d);
      return g.normAngle(e - s);
    }
  }
}

// ------------------------------------------------------------------ text formatting

/** DIMRND rounding. */
export function roundTo(v: number, inc: number): number {
  if (!(inc > 0)) return v;
  return Math.round(v / inc) * inc;
}

/** Decimal zero suppression (DIMZIN 4 / 8); other unit formats are returned unchanged. */
export function suppressZeros(text: string, leading: boolean, trailing: boolean): string {
  let t = text;
  if (!/^[-+]?\d*\.?\d+$/.test(t)) return t;
  if (trailing && t.includes('.')) t = t.replace(/0+$/, '').replace(/\.$/, '');
  if (leading) t = t.replace(/^([-+]?)0\./, '$1.');
  if (t === '' || t === '-' || t === '.') t = '0';
  return t;
}

/** Format a linear value with a unit format / precision and the style's zero suppression. */
export function formatDimNumber(v: number, lunit: LinearUnits, decimals: number, s: Pick<ResolvedDimStyle, 'suppressLeadingZeros' | 'suppressTrailingZeros'>): string {
  const t = formatLength(v, { lunits: lunit, luprec: decimals });
  return lunit === 2 ? suppressZeros(t, s.suppressLeadingZeros, s.suppressTrailingZeros) : t;
}

/** DIMPOST / DIMAPOST: `<>` is replaced by the value, anything else is appended. */
export function applyPost(value: string, post: string): string {
  if (!post) return value;
  return post.includes('<>') ? post.replace(/<>/g, value) : value + post;
}

/** Tolerance number: signed ("+0.0100") or plain. */
export function formatTolerance(v: number, s: ResolvedDimStyle, signed: boolean): string {
  const t = formatDimNumber(Math.abs(v), 2, s.tolDecimals, s);
  if (!signed) return t;
  // AutoCAD shows a zero deviation without a sign.
  if (Math.abs(v) < 1e-12) return t;
  return (v < 0 ? '-' : '+') + t;
}

/** The text of a dimension broken into the pieces the geometry lays out. */
export interface DimTextLayout {
  /** Main line (measurement with prefix/suffix, symmetrical tolerance, alternate units after). Empty for limits. */
  readonly main: string;
  /** Stacked text to the right (deviation) or instead of the main text (limits). */
  readonly upper?: string;
  readonly lower?: string;
  /** Alternate units placed below the main line. */
  readonly altBelow?: string;
  /** Basic dimension: a box around the main text. */
  readonly box?: boolean;
}

function scaledValue(d: DimensionEntity, s: ResolvedDimStyle, raw: number): number {
  const v = d.kind === 'angular' ? raw : raw * (s.linearFactor || 1);
  return d.kind === 'angular' ? v : roundTo(v, s.round);
}

function primaryString(d: DimensionEntity, s: ResolvedDimStyle, v: number): string {
  if (d.kind === 'angular') return `${formatAngle(v, s.angularDecimals)}%%d`;
  const prefix = d.kind === 'radius' ? 'R' : d.kind === 'diameter' ? '%%c' : '';
  return applyPost(prefix + formatDimNumber(v, s.lunit, s.decimals, s), s.post);
}

function altString(d: DimensionEntity, s: ResolvedDimStyle, v: number): string {
  if (!s.altUnits || d.kind === 'angular') return '';
  const a = formatDimNumber(v * (s.altFactor || 1), s.altLunit, s.altDecimals, s);
  return s.altPost ? applyPost(a, s.altPost) : `[${a}]`;
}

/** Split the dimension's text into main / stacked / alternate parts. */
export function dimensionTextLayout(d: DimensionEntity): DimTextLayout {
  const s = resolveDimStyle(d.style);
  const v = scaledValue(d, s, dimensionMeasurement(d));
  if (d.text === ' ') return { main: '' };
  const override = d.text !== undefined && d.text !== '' ? d.text : null;
  // A text override without "<>" replaces the measurement, its tolerance and alternate value.
  if (override !== null && !override.includes('<>')) return { main: override };
  const angular = d.kind === 'angular';
  const alt = altString(d, s, v);
  const altAfter = alt && s.altPlacement === 'after' ? ` ${alt}` : '';
  const altBelow = alt && s.altPlacement === 'below' ? alt : undefined;
  const wrap = (primary: string) => (override !== null ? override.replace(/<>/g, primary) : primary);
  const primary = primaryString(d, s, v);
  switch (s.tolerance) {
    case 'symmetrical': {
      const tol = angular ? `${formatAngle(g.rad(s.tolPlus), s.tolDecimals)}%%d` : formatTolerance(s.tolPlus, s, false);
      return { main: wrap(`${primary}%%p${tol}`) + altAfter, altBelow };
    }
    case 'deviation': {
      const up = angular ? `+${formatAngle(g.rad(s.tolPlus), s.tolDecimals)}%%d` : formatTolerance(s.tolPlus, s, true);
      const lo = angular ? `-${formatAngle(g.rad(s.tolMinus), s.tolDecimals)}%%d` : formatTolerance(-s.tolMinus, s, true);
      return { main: wrap(primary) + altAfter, upper: up, lower: lo, altBelow };
    }
    case 'limits': {
      const hi = primaryString(d, s, angular ? v + g.rad(s.tolPlus) : v + s.tolPlus);
      const lo = primaryString(d, s, angular ? v - g.rad(s.tolMinus) : v - s.tolMinus);
      return { main: override !== null ? override.replace(/<>/g, '') : '', upper: hi, lower: lo, altBelow: alt || undefined };
    }
    case 'basic':
      return { main: wrap(primary) + altAfter, box: true, altBelow };
    default:
      return { main: wrap(primary) + altAfter, altBelow };
  }
}

/** Text shown by the dimension on one line (log messages, dynamic input), honouring the override. */
export function dimensionText(d: DimensionEntity): string {
  const t = dimensionTextLayout(d);
  let out = t.main;
  if (t.upper !== undefined && t.lower !== undefined) out = out ? `${out} ${t.upper}/${t.lower}` : `${t.upper}/${t.lower}`;
  if (t.altBelow) out = out ? `${out} ${t.altBelow}` : t.altBelow;
  return out;
}

/** Start/end angles (CCW) of the arc of an angular dimension, chosen so the arc passes by linePoint. */
function angularSweep(d: DimensionEntity): [number, number] {
  const c = d.center!;
  const a1 = g.angleOf(c, d.p1);
  const a2 = g.angleOf(c, d.p2);
  const ap = g.angleOf(c, d.linePoint);
  return g.angleInSweep(ap, a1, a2) ? [a1, a2] : [a2, a1];
}

// ------------------------------------------------------------------ geometry

interface Ctx {
  d: DimensionEntity;
  s: ResolvedDimStyle;
  k: number;
  measure: Measure;
  out: DimPart[];
  n: number;
  texts: number;
  /** Centre of the text block (DXF group 11). */
  textCenter: Point | null;
}

type Role = 'dim' | 'ext' | 'text';

function base(c: Ctx, suffix: string, role: Role = 'dim'): { id: string; layer: string; color: ColorSpec; linetype?: string; lineWeight?: number } {
  const d = c.d;
  const override = role === 'text' ? c.s.textColor : role === 'ext' ? c.s.extLineColor : c.s.dimLineColor;
  return { id: `${d.id}:${suffix}`, layer: d.layer, color: override ?? d.color, linetype: d.linetype, lineWeight: d.lineWeight };
}

function line(c: Ctx, a: Point, b: Point, role: Role = 'dim'): void {
  if (g.dist(a, b) < 1e-9) return;
  c.n += 1;
  c.out.push({ ...base(c, `l${c.n}`, role), type: 'line', a, b });
}

const TICKS: ReadonlySet<DimArrow> = new Set(['oblique', 'arch-tick']);
/** How far the dimension line stops short of the arrow tip (blank arrowheads are not crossed by the line). */
export function arrowBackoff(type: DimArrow, size: number): number {
  if (type === 'closed-blank') return size;
  if (type === 'dot-blank') return size / 4;
  return 0;
}

/**
 * Arrowhead `type` with its tip at `tip`, pointing along `dir` (the body lies behind the tip).
 * Exported for the Dimension Style Manager's arrow previews and for tests.
 */
export function arrowParts(type: DimArrow, tip: Point, dir: Point, size: number, props: Omit<EntityBase, 'id'> & { id: string }): DimPart[] {
  const u = g.normalize(dir);
  if (size <= 0 || g.len(u) < 1e-12) return [];
  const n = { x: -u.y, y: u.x };
  const back = g.sub(tip, g.scale(u, size));
  const w = size / 6;
  const id = (s: string) => `${props.id}${s}`;
  switch (type) {
    case 'none':
      return [];
    case 'closed-filled':
      return [{ ...props, id: id(''), type: 'polyline', closed: true, filled: true, points: [tip, g.add(back, g.scale(n, w)), g.sub(back, g.scale(n, w))] }];
    case 'closed-blank':
    case 'closed': {
      const out: DimPart[] = [{ ...props, id: id(''), type: 'polyline', closed: true, points: [tip, g.add(back, g.scale(n, w)), g.sub(back, g.scale(n, w))] }];
      return out;
    }
    case 'open':
      return [{ ...props, id: id(''), type: 'polyline', closed: false, points: [g.add(back, g.scale(n, w)), tip, g.sub(back, g.scale(n, w))] }];
    case 'oblique':
    case 'arch-tick': {
      // Ticks slant the same way at both ends ("/"), whatever the arrow direction.
      const f = u.x > 1e-9 || (Math.abs(u.x) <= 1e-9 && u.y > 0) ? u : g.scale(u, -1);
      const v = g.normalize(g.add(f, { x: -f.y, y: f.x }));
      const half = size / 2;
      const a = g.sub(tip, g.scale(v, half));
      const b = g.add(tip, g.scale(v, half));
      if (type === 'oblique') return [{ ...props, id: id(''), type: 'line', a, b }];
      return [{ ...props, id: id(''), type: 'polyline', closed: false, points: [a, b], width: size / 8 }];
    }
    case 'dot':
      return [{ ...props, id: id(''), type: 'circle', center: tip, radius: size / 4, filled: true }];
    case 'dot-small':
      return [{ ...props, id: id(''), type: 'circle', center: tip, radius: size / 16, filled: true }];
    case 'dot-blank':
      return [{ ...props, id: id(''), type: 'circle', center: tip, radius: size / 4 }];
  }
}

function arrow(c: Ctx, which: 1 | 2, tip: Point, dir: Point): void {
  const type = which === 1 ? c.s.arrow : c.s.arrow2;
  c.n += 1;
  c.out.push(...arrowParts(type, tip, dir, c.s.arrowSize * c.k, base(c, `a${c.n}`)));
}

function textEntity(c: Ctx, center: Point, str: string, h: number, rotation: number, align: 'left' | 'center' | 'right'): void {
  if (!str) return;
  const up = { x: -Math.sin(rotation), y: Math.cos(rotation) };
  // `center` is the middle of the text line; the entity position is its baseline anchor.
  const pos = g.sub(center, g.scale(up, h / 2));
  c.texts += 1;
  c.out.push({ ...base(c, c.texts === 1 ? 't' : `t${c.texts}`, 'text'), type: 'text', position: pos, text: str, height: h, rotation, align });
}

interface Block {
  lay: DimTextLayout;
  /** Extent along the text direction. */
  w: number;
  /** Extent across the text direction. */
  h: number;
  mainW: number;
  stackW: number;
  stackGap: number;
  th: number;
  sh: number;
  altW: number;
}

function measureBlock(c: Ctx): Block {
  const lay = dimensionTextLayout(c.d);
  const th = c.s.textHeight * c.k;
  const sh = th * (c.s.tolScale || 1);
  const mainW = lay.main ? c.measure(lay.main, th) : 0;
  const stacked = lay.upper !== undefined && lay.lower !== undefined;
  const stackW = stacked ? Math.max(c.measure(lay.upper!, sh), c.measure(lay.lower!, sh)) : 0;
  const stackGap = stacked && mainW > 0 ? th * 0.25 : 0;
  const altW = lay.altBelow ? c.measure(lay.altBelow, th) : 0;
  const lineW = mainW + stackGap + stackW;
  const lineH = stacked ? Math.max(mainW > 0 ? th : 0, sh * 2.3) : lay.main ? th : 0;
  const gap = c.s.textGap * c.k;
  const w = Math.max(lineW, altW) + (lay.box ? 2 * gap : 0);
  const h = lineH + (lay.altBelow ? th + gap : 0) + (lay.box ? 2 * gap : 0);
  return { lay, w, h, mainW, stackW, stackGap, th, sh, altW };
}

/** Lay the text block out centred on `center` with direction `rot`. */
function drawBlock(c: Ctx, b: Block, center: Point, rot: number): void {
  if (b.w <= 0 && b.h <= 0) return;
  c.textCenter = c.textCenter ?? center;
  const ux = { x: Math.cos(rot), y: Math.sin(rot) };
  const uy = { x: -Math.sin(rot), y: Math.cos(rot) };
  const at = (x: number, y: number) => g.add(center, g.add(g.scale(ux, x), g.scale(uy, y)));
  const gap = c.s.textGap * c.k;
  const lineW = b.mainW + b.stackGap + b.stackW;
  // With alternate units below, the first line sits above the centre.
  const lineY = b.lay.altBelow ? (b.th + gap) / 2 : 0;
  const x0 = -lineW / 2;
  if (b.lay.main) textEntity(c, at(x0 + b.mainW / 2, lineY), b.lay.main, b.th, rot, 'center');
  if (b.lay.upper !== undefined && b.lay.lower !== undefined) {
    const sx = x0 + b.mainW + b.stackGap;
    const dy = b.sh * 0.65;
    textEntity(c, at(sx, lineY + dy), b.lay.upper, b.sh, rot, 'left');
    textEntity(c, at(sx, lineY - dy), b.lay.lower, b.sh, rot, 'left');
  }
  if (b.lay.altBelow) textEntity(c, at(0, lineY - b.th - gap), b.lay.altBelow, b.th, rot, 'center');
  if (b.lay.box && b.mainW > 0) {
    const hw = b.mainW / 2 + gap;
    const hh = b.th / 2 + gap;
    const cx = x0 + b.mainW / 2;
    c.n += 1;
    c.out.push({ ...base(c, `b${c.n}`), type: 'polyline', closed: true, points: [at(cx - hw, lineY - hh), at(cx + hw, lineY - hh), at(cx + hw, lineY + hh), at(cx - hw, lineY + hh)] });
  }
}

/** Text direction that reads left-to-right / bottom-to-top like AutoCAD. */
function readable(angle: number): number {
  let a = g.normAngle(angle);
  if (a > Math.PI / 2 + 1e-9 && a <= (3 * Math.PI) / 2 + 1e-9) a += Math.PI;
  return g.normAngle(a);
}

/** Size of the text block measured along / across a line of direction `lineAngle`. */
function extents(b: Block, rot: number, lineAngle: number): { along: number; across: number } {
  const t = rot - lineAngle;
  const cs = Math.abs(Math.cos(t));
  const sn = Math.abs(Math.sin(t));
  return { along: cs * b.w + sn * b.h, across: sn * b.w + cs * b.h };
}

/** Draw the parameter interval [t0, t1] of the line a + dir·t minus the `cuts`. */
function segments(c: Ctx, a: Point, dir: Point, t0: number, t1: number, cuts: Array<[number, number]>): void {
  let pieces: Array<[number, number]> = [[t0, t1]];
  for (const [lo, hi] of cuts) {
    const next: Array<[number, number]> = [];
    for (const [s, e] of pieces) {
      if (hi <= s || lo >= e) next.push([s, e]);
      else {
        if (lo > s) next.push([s, lo]);
        if (hi < e) next.push([hi, e]);
      }
    }
    pieces = next;
  }
  for (const [s, e] of pieces) if (e - s > 1e-9) line(c, g.add(a, g.scale(dir, s)), g.add(a, g.scale(dir, e)));
}

type Placement = { textInside: boolean; arrowsInside: boolean };

/** DIMATFIT / DIMTIX: decide what goes between the extension lines. */
function fitDecision(s: ResolvedDimStyle, L: number, along: number, asz: number, gap: number): Placement {
  const both = along + 2 * gap + 2 * asz <= L + 1e-9;
  const arrowsFit = 2 * asz <= L + 1e-9;
  const textFits = along + 2 * gap <= L + 1e-9;
  if (along <= 1e-12) return { textInside: true, arrowsInside: arrowsFit };
  let r: Placement;
  if (both) r = { textInside: true, arrowsInside: true };
  else
    switch (s.fit) {
      case 'arrows':
        r = { textInside: textFits, arrowsInside: false };
        break;
      case 'text':
        r = { textInside: false, arrowsInside: arrowsFit };
        break;
      case 'both':
        r = { textInside: false, arrowsInside: false };
        break;
      default:
        r = arrowsFit ? { textInside: false, arrowsInside: true } : textFits ? { textInside: true, arrowsInside: false } : { textInside: false, arrowsInside: false };
    }
  if (s.textInside) r = { ...r, textInside: true };
  return r;
}

function linearParts(c: Ctx): void {
  const { d, k, s } = c;
  let u: Point;
  if (d.kind === 'linear') u = { x: Math.cos(d.rotation), y: Math.sin(d.rotation) };
  else {
    const v = g.sub(d.p2, d.p1);
    u = g.len(v) < 1e-12 ? { x: 1, y: 0 } : g.normalize(v);
  }
  const n = { x: -u.y, y: u.x };
  // Extension lines run along `e`: perpendicular to the dimension line, or at the DIMEDIT oblique angle.
  let e = n;
  if (d.oblique !== undefined) {
    const o = { x: Math.cos(d.oblique), y: Math.sin(d.oblique) };
    if (Math.abs(g.dot(o, n)) > 1e-6) e = o;
  }
  const en = g.dot(e, n);
  const foot = (p: Point) => g.add(p, g.scale(e, g.dot(g.sub(d.linePoint, p), n) / en));
  const a1 = foot(d.p1);
  const a2 = foot(d.p2);
  const exo = s.extOffset * k;
  const exe = s.extExtend * k;
  const asz = s.arrowSize * k;
  const gap = s.textGap * k;
  // Extension lines
  ([[d.p1, a1, s.suppressExt1], [d.p2, a2, s.suppressExt2]] as Array<[Point, Point, boolean]>).forEach(([p, a, suppressed]) => {
    if (suppressed) return;
    const v = g.sub(a, p);
    const L = g.len(v);
    if (L <= exo + 1e-9) return;
    const dir = g.scale(v, 1 / L);
    line(c, g.add(p, g.scale(dir, exo)), g.add(a, g.scale(dir, exe)), 'ext');
  });
  const L = g.dist(a1, a2);
  const dir = L < 1e-12 ? u : g.normalize(g.sub(a2, a1));
  const lineAngle = Math.atan2(dir.y, dir.x);
  const block = measureBlock(c);
  const aligned = readable(lineAngle);
  const up = { x: -Math.sin(aligned), y: Math.cos(aligned) };
  const rotFor = (inside: boolean) => (d.textRotation !== undefined ? d.textRotation : s.textAlign === 'horizontal' || (s.textAlign === 'iso' && !inside) ? 0 : aligned);
  const mid = g.mid(a1, a2);
  const tOf = (p: Point) => g.dot(g.sub(p, a1), dir);
  const cuts: Array<[number, number]> = [];
  let place: Placement;
  if (d.textPosition) {
    // User-placed text: full dimension line, text where the user put it, broken if it sits on the line.
    place = { textInside: true, arrowsInside: 2 * asz <= L + 1e-9 };
    const rot = rotFor(true);
    const ext = extents(block, rot, lineAngle);
    drawBlock(c, block, d.textPosition, rot);
    const off = Math.abs(g.dot(g.sub(d.textPosition, a1), n));
    if (off < ext.across / 2 + 1e-9) {
      const t = tOf(d.textPosition);
      cuts.push([t - ext.along / 2 - gap, t + ext.along / 2 + gap]);
    }
  } else {
    const rotIn = rotFor(true);
    const extIn = extents(block, rotIn, lineAngle);
    place = fitDecision(s, L, extIn.along, asz, gap);
    const rot = rotFor(place.textInside);
    const ext = extents(block, rot, lineAngle);
    if (place.textInside) {
      // DIMJUST: along the line
      let center = mid;
      if (s.textJustify === 'ext1') center = g.add(a1, g.scale(dir, (place.arrowsInside ? asz : 0) + gap + ext.along / 2));
      else if (s.textJustify === 'ext2') center = g.sub(a2, g.scale(dir, (place.arrowsInside ? asz : 0) + gap + ext.along / 2));
      // DIMTAD: across the line
      const vertical = s.textVertical;
      const lift = ext.across / 2 + gap;
      if (vertical === 'above') center = g.add(center, g.scale(up, lift));
      else if (vertical === 'below') center = g.sub(center, g.scale(up, lift));
      else if (vertical === 'outside') {
        const side = Math.sign(g.dot(g.sub(d.linePoint, g.mid(d.p1, d.p2)), n)) || 1;
        center = g.add(center, g.scale(n, side * lift));
      } else {
        const t = tOf(center);
        cuts.push([t - ext.along / 2 - gap, t + ext.along / 2 + gap]);
      }
      drawBlock(c, block, center, rot);
    } else {
      // Text does not fit: beside the dimension line, on its "up" side (DIMTMOVE 2-like).
      drawBlock(c, block, g.add(mid, g.scale(up, ext.across / 2 + gap)), rot);
    }
  }
  // Dimension line (parameter t along dir from a1)
  const arrowsInside = place.arrowsInside;
  const tick1 = TICKS.has(s.arrow);
  const tick2 = TICKS.has(s.arrow2);
  const dle = s.dimLineExtend * k;
  let t0 = 0;
  let t1 = L;
  if (arrowsInside) {
    t0 = tick1 ? -dle : arrowBackoff(s.arrow, asz);
    t1 = tick2 ? L + dle : L - arrowBackoff(s.arrow2, asz);
  }
  if (s.suppressDimLine1) cuts.push([-Infinity, L / 2]);
  if (s.suppressDimLine2) cuts.push([L / 2, Infinity]);
  if (arrowsInside || s.dimLineInside) segments(c, a1, dir, t0, t1, cuts);
  if (!arrowsInside) {
    segments(c, a1, dir, -2 * asz, -arrowBackoff(s.arrow, asz), s.suppressDimLine1 ? [[-Infinity, Infinity]] : []);
    segments(c, a1, dir, L + arrowBackoff(s.arrow2, asz), L + 2 * asz, s.suppressDimLine2 ? [[-Infinity, Infinity]] : []);
  }
  if (!s.suppressDimLine1) arrow(c, 1, a1, arrowsInside ? g.scale(dir, -1) : dir);
  if (!s.suppressDimLine2) arrow(c, 2, a2, arrowsInside ? dir : g.scale(dir, -1));
}

function centerMark(c: Ctx, center: Point): void {
  const m = c.s.centerMark * c.k;
  if (m <= 0) return;
  line(c, { x: center.x - m, y: center.y }, { x: center.x + m, y: center.y });
  line(c, { x: center.x, y: center.y - m }, { x: center.x, y: center.y + m });
}

function radialParts(c: Ctx): void {
  const { d, k, s } = c;
  const center = d.p1;
  const r = g.dist(d.p1, d.p2);
  if (r < 1e-12) return;
  const toLoc = g.sub(d.linePoint, center);
  const dir = g.len(toLoc) > 1e-9 ? g.normalize(toLoc) : g.normalize(g.sub(d.p2, d.p1));
  const q = g.add(center, g.scale(dir, r));
  const asz = s.arrowSize * k;
  const gap = s.textGap * k;
  const block = measureBlock(c);
  const textAt = d.textPosition ?? d.linePoint;
  const inside = g.dist(textAt, center) <= r - 1e-9;
  if (inside) {
    const from = d.kind === 'diameter' ? g.sub(center, g.scale(dir, r)) : center;
    // Radial text stays horizontal unless the style asks for aligned text explicitly (DIMTIH off).
    const rot = d.textRotation ?? (d.style.textAlign === 'aligned' ? readable(Math.atan2(dir.y, dir.x)) : 0);
    drawBlock(c, block, textAt, rot);
    const ext = extents(block, rot, Math.atan2(dir.y, dir.x));
    const L = g.dist(from, q);
    const t = g.dot(g.sub(textAt, from), dir);
    segments(c, from, dir, d.kind === 'diameter' ? arrowBackoff(s.arrow, asz) : 0, L - arrowBackoff(s.arrow2, asz), [[t - ext.along / 2 - gap, t + ext.along / 2 + gap]]);
    arrow(c, 2, q, dir);
    if (d.kind === 'diameter') arrow(c, 1, from, g.scale(dir, -1));
  } else {
    // Leader from the circle out to the text with a horizontal landing (DIMTOH = 1: horizontal text).
    const landingDir = dir.x >= 0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
    const elbow = textAt;
    const landingEnd = g.add(elbow, g.scale(landingDir, asz));
    line(c, g.add(q, g.scale(dir, arrowBackoff(s.arrow2, asz))), elbow);
    line(c, elbow, landingEnd);
    arrow(c, 2, q, g.scale(dir, -1));
    const rot = d.textRotation ?? 0;
    const tCenter = g.add(landingEnd, { x: landingDir.x * (gap + block.w / 2), y: 0 });
    drawBlock(c, block, tCenter, rot);
    centerMark(c, center);
  }
}

function angularParts(c: Ctx): void {
  const { d, k, s } = c;
  if (!d.center) return;
  const center = d.center;
  const r = g.dist(d.linePoint, center);
  if (r < 1e-12) return;
  const [a1, a2] = angularSweep(d);
  const sweep = g.normAngle(a2 - a1) || 2 * Math.PI;
  const exo = s.extOffset * k;
  const exe = s.extExtend * k;
  const asz = s.arrowSize * k;
  const gap = s.textGap * k;
  const h = s.textHeight * k;
  // Extension lines along the legs when the leg points are inside the arc radius
  ([[d.p1, s.suppressExt1], [d.p2, s.suppressExt2]] as Array<[Point, boolean]>).forEach(([p, suppressed]) => {
    if (suppressed) return;
    const dp = g.dist(p, center);
    if (dp >= r - 1e-9) return;
    const u = g.normalize(g.sub(p, center));
    line(c, g.add(p, g.scale(u, exo)), g.add(center, g.scale(u, r + exe)), 'ext');
  });
  const block = measureBlock(c);
  const midA = a1 + sweep / 2;
  const textCenter = d.textPosition ?? g.polar(center, midA, r);
  drawBlock(c, block, textCenter, d.textRotation ?? 0);
  const arcId = () => {
    c.n += 1;
    return `${d.id}:c${c.n}`;
  };
  const pushArc = (sa: number, ea: number) => {
    if (ea - sa < 1e-6) return;
    c.out.push({ ...base(c, ''), id: arcId(), type: 'arc', center, radius: r, startAngle: sa, endAngle: ea });
  };
  const b1 = arrowBackoff(s.arrow, asz) / r;
  const b2 = arrowBackoff(s.arrow2, asz) / r;
  const half = (block.w / 2 + gap) / r; // half chord angle of the text gap
  const tA = g.angleOf(center, textCenter);
  const onArc = Math.abs(g.dist(textCenter, center) - r) < h && g.angleInSweep(tA, a1, a2);
  const s0 = a1 + b1;
  const s1 = a1 + sweep - b2;
  if (onArc && 2 * half < sweep) {
    const rel = g.normAngle(tA - a1);
    pushArc(s0, a1 + rel - half);
    pushArc(a1 + rel + half, s1);
  } else pushArc(s0, s1);
  const arcLen = r * sweep;
  const startTan = { x: -Math.sin(a1), y: Math.cos(a1) };
  const endTan = { x: -Math.sin(a2), y: Math.cos(a2) };
  const p1 = g.polar(center, a1, r);
  const p2 = g.polar(center, a2, r);
  if (arcLen >= 2 * asz) {
    arrow(c, 1, p1, g.scale(startTan, -1));
    arrow(c, 2, p2, endTan);
  } else {
    arrow(c, 1, p1, startTan);
    arrow(c, 2, p2, g.scale(endTan, -1));
  }
}

function run(d: DimensionEntity, measure: Measure): Ctx {
  const s = resolveDimStyle(d.style);
  const c: Ctx = { d, s, k: s.scale || 1, measure, out: [], n: 0, texts: 0, textCenter: null };
  switch (d.kind) {
    case 'linear':
    case 'aligned':
      linearParts(c);
      break;
    case 'radius':
    case 'diameter':
      radialParts(c);
      break;
    case 'angular':
      angularParts(c);
      break;
  }
  return c;
}

/** Build the primitive entities that draw a dimension. */
export function dimensionGeometry(d: DimensionEntity, measure: Measure): DimPart[] {
  return run(d, measure).out;
}

/** Default text midpoint (DXF group 11) for a dimension. */
export function dimensionTextPoint(d: DimensionEntity, measure: Measure): Point {
  return run(d, measure).textCenter ?? d.linePoint;
}

// ------------------------------------------------------------------ named dimension styles

/**
 * Named dimension styles of a drawing. The header keeps the *current* style
 * (`header.dimStyle`); the named set lives in `state.meta.dimStyles` (keyed by
 * name) until DrawingHeader grows a field for it. "Standard" always exists.
 */
export const DIMSTYLES_META_KEY = 'dimStyles';

export function namedDimStyles(state: DrawingState): DimStyle[] {
  const raw = state.meta?.[DIMSTYLES_META_KEY];
  const out = new Map<string, DimStyle>();
  const add = (s: DimStyle) => {
    if (!out.has(s.name.toUpperCase())) out.set(s.name.toUpperCase(), s);
  };
  if (raw && typeof raw === 'object') for (const s of Object.values(raw as Record<string, DimStyle>)) if (s && typeof s.name === 'string') add(s);
  const current = state.header?.dimStyle;
  if (current) add(current);
  add(STANDARD_DIMSTYLE);
  return [...out.values()].sort((a, b) => (a.name === 'Standard' ? -1 : b.name === 'Standard' ? 1 : a.name.localeCompare(b.name)));
}

export function findDimStyle(state: DrawingState, name: string): DimStyle | undefined {
  const key = name.trim().toUpperCase();
  return namedDimStyles(state).find((s) => s.name.toUpperCase() === key);
}

function storedStyles(state: DrawingState): Record<string, DimStyle> {
  const raw = state.meta?.[DIMSTYLES_META_KEY];
  return raw && typeof raw === 'object' ? { ...(raw as Record<string, DimStyle>) } : {};
}

/**
 * Save (or redefine) a named style. Dimensions that use a style of that name are
 * updated too, as AutoCAD does when a style is modified; pass `updateDimensions = false` to keep them.
 */
export function withDimStyle(state: DrawingState, style: DimStyle, updateDimensions = true): DrawingState {
  const styles = storedStyles(state);
  for (const k of Object.keys(styles)) if (k.toUpperCase() === style.name.toUpperCase()) delete styles[k];
  styles[style.name] = style;
  const key = style.name.toUpperCase();
  const entities = updateDimensions
    ? state.entities.map((e) => (e.type === 'dimension' && e.style.name.toUpperCase() === key && e.style !== style ? { ...e, style } : e))
    : state.entities;
  return { ...state, entities, meta: { ...(state.meta ?? {}), [DIMSTYLES_META_KEY]: styles } };
}

/** Remove a named style (Standard, the current style and styles in use cannot be deleted; returns the state unchanged). */
export function withoutDimStyle(state: DrawingState, name: string): DrawingState {
  const key = name.toUpperCase();
  if (key === 'STANDARD' || state.header?.dimStyle.name.toUpperCase() === key || dimStyleUsage(state, name) > 0) return state;
  const styles = storedStyles(state);
  let changed = false;
  for (const k of Object.keys(styles))
    if (k.toUpperCase() === key) {
      delete styles[k];
      changed = true;
    }
  return changed ? { ...state, meta: { ...(state.meta ?? {}), [DIMSTYLES_META_KEY]: styles } } : state;
}

/** Number of dimensions drawn with the named style. */
export function dimStyleUsage(state: DrawingState, name: string): number {
  const key = name.toUpperCase();
  return state.entities.filter((e) => e.type === 'dimension' && e.style.name.toUpperCase() === key).length;
}

// ------------------------------------------------------------------ DIM* variables

export interface DimVar {
  /** System variable name (DIMTXT ...). */
  readonly name: string;
  readonly key: keyof DimStyle;
  /** DXF group code in a DIMSTYLE table record (undefined = header variable only / not stored). */
  readonly code?: number;
  /** DXF header variable group code ($DIMTXT 40 ...). */
  readonly headerCode: number;
  readonly description: string;
  readonly kind: 'number' | 'integer' | 'boolean' | 'string' | 'enum' | 'color';
  /** enum: DXF integer <-> style value. */
  readonly values?: ReadonlyArray<readonly [number, string]>;
}

/**
 * Every DIM* variable the style carries, with its DXF group codes, so the DXF
 * reader/writer can map DIMSTYLE records and header variables mechanically.
 */
export const DIM_VARIABLES: readonly DimVar[] = [
  { name: 'DIMSCALE', key: 'scale', code: 40, headerCode: 40, description: 'Overall dimension scale', kind: 'number' },
  { name: 'DIMASZ', key: 'arrowSize', code: 41, headerCode: 40, description: 'Arrow size', kind: 'number' },
  { name: 'DIMEXO', key: 'extOffset', code: 42, headerCode: 40, description: 'Extension line offset from origin', kind: 'number' },
  { name: 'DIMDLI', key: 'baselineSpacing', code: 43, headerCode: 40, description: 'Baseline spacing', kind: 'number' },
  { name: 'DIMEXE', key: 'extExtend', code: 44, headerCode: 40, description: 'Extension beyond dimension line', kind: 'number' },
  { name: 'DIMRND', key: 'round', code: 45, headerCode: 40, description: 'Round distances to', kind: 'number' },
  { name: 'DIMDLE', key: 'dimLineExtend', code: 46, headerCode: 40, description: 'Dimension line extension beyond ticks', kind: 'number' },
  { name: 'DIMTP', key: 'tolPlus', code: 47, headerCode: 40, description: 'Upper tolerance value', kind: 'number' },
  { name: 'DIMTM', key: 'tolMinus', code: 48, headerCode: 40, description: 'Lower tolerance value', kind: 'number' },
  { name: 'DIMTXT', key: 'textHeight', code: 140, headerCode: 40, description: 'Text height', kind: 'number' },
  { name: 'DIMCEN', key: 'centerMark', code: 141, headerCode: 40, description: 'Center mark size', kind: 'number' },
  { name: 'DIMALTF', key: 'altFactor', code: 143, headerCode: 40, description: 'Alternate units multiplier', kind: 'number' },
  { name: 'DIMLFAC', key: 'linearFactor', code: 144, headerCode: 40, description: 'Linear measurement scale factor', kind: 'number' },
  { name: 'DIMTFAC', key: 'tolScale', code: 146, headerCode: 40, description: 'Tolerance text height scale', kind: 'number' },
  { name: 'DIMGAP', key: 'textGap', code: 147, headerCode: 40, description: 'Offset from dimension line (text gap)', kind: 'number' },
  { name: 'DIMSE1', key: 'suppressExt1', code: 75, headerCode: 70, description: 'Suppress extension line 1', kind: 'boolean' },
  { name: 'DIMSE2', key: 'suppressExt2', code: 76, headerCode: 70, description: 'Suppress extension line 2', kind: 'boolean' },
  {
    name: 'DIMTAD',
    key: 'textVertical',
    code: 77,
    headerCode: 70,
    description: 'Text vertical position (0 centered, 1 above, 2 outside, 4 below)',
    kind: 'enum',
    values: [
      [0, 'centered'],
      [1, 'above'],
      [2, 'outside'],
      [4, 'below'],
    ],
  },
  { name: 'DIMALT', key: 'altUnits', code: 170, headerCode: 70, description: 'Alternate units on', kind: 'boolean' },
  { name: 'DIMALTD', key: 'altDecimals', code: 171, headerCode: 70, description: 'Alternate units decimal places', kind: 'integer' },
  { name: 'DIMTOFL', key: 'dimLineInside', code: 172, headerCode: 70, description: 'Force line inside extension lines', kind: 'boolean' },
  { name: 'DIMTIX', key: 'textInside', code: 174, headerCode: 70, description: 'Place text inside extensions', kind: 'boolean' },
  { name: 'DIMSD1', key: 'suppressDimLine1', code: 281, headerCode: 70, description: 'Suppress the first dimension line', kind: 'boolean' },
  { name: 'DIMSD2', key: 'suppressDimLine2', code: 282, headerCode: 70, description: 'Suppress the second dimension line', kind: 'boolean' },
  { name: 'DIMCLRD', key: 'dimLineColor', code: 176, headerCode: 70, description: 'Dimension line color', kind: 'color' },
  { name: 'DIMCLRE', key: 'extLineColor', code: 177, headerCode: 70, description: 'Extension line color', kind: 'color' },
  { name: 'DIMCLRT', key: 'textColor', code: 178, headerCode: 70, description: 'Dimension text color', kind: 'color' },
  { name: 'DIMADEC', key: 'angularDecimals', code: 179, headerCode: 70, description: 'Angular decimal places', kind: 'integer' },
  { name: 'DIMDEC', key: 'decimals', code: 271, headerCode: 70, description: 'Decimal places', kind: 'integer' },
  { name: 'DIMTDEC', key: 'tolDecimals', code: 272, headerCode: 70, description: 'Tolerance decimal places', kind: 'integer' },
  { name: 'DIMALTU', key: 'altLunit', code: 273, headerCode: 70, description: 'Alternate units format (1-5)', kind: 'integer' },
  { name: 'DIMLUNIT', key: 'lunit', code: 277, headerCode: 70, description: 'Linear unit format (1-5)', kind: 'integer' },
  {
    name: 'DIMJUST',
    key: 'textJustify',
    code: 280,
    headerCode: 70,
    description: 'Horizontal text position (0 centered, 1 ext line 1, 2 ext line 2)',
    kind: 'enum',
    values: [
      [0, 'centered'],
      [1, 'ext1'],
      [2, 'ext2'],
    ],
  },
  {
    name: 'DIMATFIT',
    key: 'fit',
    code: 289,
    headerCode: 70,
    description: 'Fit: 0 both outside, 1 arrows first, 2 text first, 3 best fit',
    kind: 'enum',
    values: [
      [0, 'both'],
      [1, 'arrows'],
      [2, 'text'],
      [3, 'best'],
    ],
  },
  { name: 'DIMPOST', key: 'post', code: 3, headerCode: 1, description: 'Prefix/suffix of primary text (<> = value)', kind: 'string' },
  { name: 'DIMAPOST', key: 'altPost', code: 4, headerCode: 1, description: 'Prefix/suffix of alternate text', kind: 'string' },
  { name: 'DIMBLK1', key: 'arrow', headerCode: 1, description: 'First arrow block', kind: 'string' },
  { name: 'DIMBLK2', key: 'arrow2', headerCode: 1, description: 'Second arrow block', kind: 'string' },
];

/** DIMBLK block name for an arrow type ('' = closed filled). */
export function arrowBlockName(a: DimArrow): string {
  return DIM_ARROWS.find((x) => x.id === a)?.block ?? '';
}

/** Arrow type for a DIMBLK block name (case-insensitive; unknown = closed filled). */
export function arrowFromBlockName(name: string): DimArrow {
  const n = name.trim().toUpperCase();
  const withUnderscore = n.startsWith('_') ? n : `_${n}`;
  return DIM_ARROWS.find((x) => x.block === withUnderscore)?.id ?? (n === '_CLOSED' || n === 'CLOSED' ? 'closed' : 'closed-filled');
}

/** DIMTOL / DIMLIM flag pair for a tolerance mode. */
export function toleranceFlags(t: DimTolerance): { dimtol: number; dimlim: number } {
  return { dimtol: t === 'symmetrical' || t === 'deviation' ? 1 : 0, dimlim: t === 'limits' ? 1 : 0 };
}

/**
 * Value of a DIM* variable as DXF stores it (numbers, 0/1 flags, enum integers, colour numbers,
 * block names for DIMBLK1/2). DIMTOL/DIMLIM/DIMSAH/DIMTIH/DIMTOH are derived fields.
 */
export function dimVarValue(s: DimStyle, name: string): number | string {
  const r = resolveDimStyle(s);
  const up = name.toUpperCase();
  if (up === 'DIMTOL') return toleranceFlags(r.tolerance).dimtol;
  if (up === 'DIMLIM') return toleranceFlags(r.tolerance).dimlim;
  if (up === 'DIMSAH') return r.arrow2 !== r.arrow ? 1 : 0;
  if (up === 'DIMBLK') return arrowBlockName(r.arrow);
  if (up === 'DIMTIH') return r.textAlign === 'aligned' ? 0 : 1;
  if (up === 'DIMTOH') return r.textAlign === 'horizontal' ? 1 : 0;
  const v = DIM_VARIABLES.find((x) => x.name === up);
  if (!v) throw new Error(`Unknown dimension variable ${name}`);
  const val = (r as unknown as Record<string, unknown>)[v.key];
  switch (v.kind) {
    case 'boolean':
      return val ? 1 : 0;
    case 'enum':
      return v.values!.find(([, s2]) => s2 === val)?.[0] ?? 0;
    case 'color':
      return val === undefined || val === 'ByLayer' ? 0 : (val as number); // 0 = BYBLOCK in DXF: the dimension's own colour
    case 'string':
      return v.key === 'arrow' || v.key === 'arrow2' ? arrowBlockName(val as DimArrow) : String(val ?? '');
    default:
      return val as number;
  }
}

/** Apply a DIM* variable value (as DXF stores it) to a style. Unknown names return the style unchanged. */
export function withDimVar(s: DimStyle, name: string, value: number | string): DimStyle {
  const up = name.toUpperCase();
  const num = typeof value === 'number' ? value : parseFloat(value);
  const r = resolveDimStyle(s);
  if (up === 'DIMTOL') {
    const plusMinus = r.tolerance === 'symmetrical' || r.tolerance === 'deviation';
    if (num !== 0) return { ...s, tolerance: plusMinus ? r.tolerance : Math.abs(r.tolPlus - r.tolMinus) < 1e-12 ? 'symmetrical' : 'deviation' };
    return plusMinus ? { ...s, tolerance: 'none' } : s;
  }
  if (up === 'DIMLIM') {
    if (num !== 0) return { ...s, tolerance: 'limits' };
    return r.tolerance === 'limits' ? { ...s, tolerance: 'none' } : s;
  }
  if (up === 'DIMBLK') return { ...s, arrow: arrowFromBlockName(String(value)), arrow2: undefined };
  if (up === 'DIMTIH' || up === 'DIMTOH') {
    const tih = up === 'DIMTIH' ? num !== 0 : r.textAlign !== 'aligned';
    const toh = up === 'DIMTOH' ? num !== 0 : r.textAlign === 'horizontal';
    return { ...s, textAlign: tih && toh ? 'horizontal' : !tih && !toh ? 'aligned' : 'iso' };
  }
  if (up === 'DIMSAH') return num ? s : { ...s, arrow2: undefined };
  const v = DIM_VARIABLES.find((x) => x.name === up);
  if (!v) return s;
  switch (v.kind) {
    case 'boolean':
      return { ...s, [v.key]: num !== 0 };
    case 'integer': {
      let n = Math.max(0, Math.round(num));
      if (v.key === 'lunit' || v.key === 'altLunit') n = Math.max(1, Math.min(5, n));
      return { ...s, [v.key]: n };
    }
    case 'enum': {
      const hit = v.values!.find(([k2]) => k2 === Math.round(num));
      return hit ? { ...s, [v.key]: hit[1] } : s;
    }
    case 'color':
      return { ...s, [v.key]: num > 0 && num < 256 ? Math.round(num) : undefined };
    case 'string':
      if (v.key === 'arrow' || v.key === 'arrow2') return { ...s, [v.key]: arrowFromBlockName(String(value)) };
      return { ...s, [v.key]: String(value) };
    default:
      return Number.isFinite(num) ? { ...s, [v.key]: num } : s;
  }
}

/**
 * DIMSTYLE table record group pairs for a style (without the 0/5/105/330/100/2/70 framing the
 * writer adds). Arrow blocks are referenced by handle in real DIMSTYLE records (342/343/344),
 * so they are left to header variables ($DIMBLK, $DIMBLK1, $DIMBLK2) or XDATA.
 */
export function dimStyleRecordPairs(s: DimStyle): Array<[number, number | string]> {
  const out: Array<[number, number | string]> = [];
  for (const v of DIM_VARIABLES) if (v.code !== undefined) out.push([v.code, dimVarValue(s, v.name)]);
  out.push([71, dimVarValue(s, 'DIMTOL')], [72, dimVarValue(s, 'DIMLIM')], [73, dimVarValue(s, 'DIMTIH')], [74, dimVarValue(s, 'DIMTOH')], [173, dimVarValue(s, 'DIMSAH')]);
  return out;
}

/** Read a style back from DIMSTYLE record pairs (the inverse of dimStyleRecordPairs). */
export function dimStyleFromRecordPairs(name: string, pairs: ReadonlyArray<readonly [number, number | string]>, fallback: DimStyle = STANDARD_DIMSTYLE): DimStyle {
  let s: DimStyle = { ...fallback, name };
  const byCode = new Map<number, number | string>();
  for (const [c, v] of pairs) byCode.set(c, v);
  for (const v of DIM_VARIABLES) if (v.code !== undefined && byCode.has(v.code)) s = withDimVar(s, v.name, byCode.get(v.code)!);
  if (byCode.has(73) || byCode.has(74)) {
    const tih = Number(byCode.get(73) ?? 1) !== 0;
    const toh = Number(byCode.get(74) ?? 1) !== 0;
    s = { ...s, textAlign: tih && toh ? 'horizontal' : !tih && !toh ? 'aligned' : 'iso' };
  }
  const tol = Number(byCode.get(71) ?? 0);
  const lim = Number(byCode.get(72) ?? 0);
  const r = resolveDimStyle(s);
  const tolerance: DimTolerance = lim ? 'limits' : tol ? (Math.abs(r.tolPlus - r.tolMinus) < 1e-12 ? 'symmetrical' : 'deviation') : r.tolerance === 'basic' ? 'basic' : 'none';
  return { ...s, tolerance };
}

/** Every DIM* variable (plus the derived DIMTOL/DIMLIM/DIMSAH/DIMTIH/DIMTOH/DIMBLK) with its DXF value. */
export function dimVarList(s: DimStyle): Array<{ name: string; value: number | string; description: string }> {
  const extra: Array<[string, string]> = [
    ['DIMBLK', 'Arrow block (both ends)'],
    ['DIMSAH', 'Separate arrow blocks'],
    ['DIMTIH', 'Text inside horizontal'],
    ['DIMTOH', 'Text outside horizontal'],
    ['DIMTOL', 'Generate tolerances'],
    ['DIMLIM', 'Generate dimension limits'],
  ];
  const rows = [...DIM_VARIABLES.map((v) => ({ name: v.name, description: v.description })), ...extra.map(([name, description]) => ({ name, description }))];
  return rows.map((r) => ({ ...r, value: dimVarValue(s, r.name) })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Variables whose values differ between two styles (DIMSTYLE Compare / Restore ~name). */
export function diffDimStyles(a: DimStyle, b: DimStyle): Array<{ name: string; description: string; a: number | string; b: number | string }> {
  const lb = new Map(dimVarList(b).map((r) => [r.name, r.value]));
  return dimVarList(a)
    .filter((r) => {
      const other = lb.get(r.name);
      return typeof r.value === 'number' && typeof other === 'number' ? Math.abs(r.value - other) > 1e-12 : r.value !== other;
    })
    .map((r) => ({ name: r.name, description: r.description, a: r.value, b: lb.get(r.name)! }));
}
