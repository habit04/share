/**
 * Linetypes (acad.lin-style dash patterns). Pattern elements are lengths in
 * drawing units: positive = dash, negative = gap, 0 = dot. Scaled by LTSCALE
 * (and the entity's own scale) exactly like AutoCAD, so dashes shrink and grow
 * with zoom instead of staying a fixed pixel size.
 */
export interface Linetype {
  readonly name: string;
  readonly description: string;
  readonly pattern: readonly number[];
  /** Retained native complex elements; display keeps the dash pattern until glyph support. */
  readonly complex?: ComplexLinetype;
}

/** STYLE flag1 resources have independent identities; their names can legitimately be empty. */
export interface LinetypeShapeStyle {
  readonly name: string;
  readonly flags: number;
  readonly font: string;
  readonly bigFont: string;
  readonly height: number;
  readonly widthFactor: number;
  /** STYLE50 is in degrees, unlike complex-element50. */
  readonly oblique: number;
  readonly generation: number;
  readonly lastHeight: number;
}

export type LinetypeStyleReference =
  | { readonly kind: 'text'; readonly name: string; readonly sourceHandle?: string }
  | { readonly kind: 'shape'; readonly sourceId: string }
  | { readonly kind: 'unresolved'; readonly sourceHandle: string };

export interface ComplexLinetypeElement {
  /** Native74 bit flags retained without guessing undocumented semantics. */
  readonly flags: number;
  readonly shapeNumber?: number;
  readonly style?: LinetypeStyleReference;
  readonly scale?: number;
  /** Native LTYPE50 is in radians. */
  readonly rotation?: number;
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly text?: string;
}
export interface ComplexLinetype {
  readonly flags?: number;
  readonly alignment?: number;
  readonly totalPatternLength?: number;
  /** One element per retained group49, in native order. */
  readonly elements: readonly ComplexLinetypeElement[];
}

export const MAX_LINETYPE_ELEMENTS = 1024;
export const MAX_LINETYPE_TEXT = 4096;
const boundedString = (value: unknown, max: number, empty = true): value is string => typeof value === 'string' && value.length <= max && (empty || value.length > 0) && !/[\u0000\r\n]/.test(value);
const nativeInteger = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= -32768 && Number(value) <= 65535;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Reject malformed authored definitions before Writer can coerce NaN/Infinity to zero. */
export function complexLinetypeProblem(lt: Linetype): string | null {
  const native = lt.complex;
  if (!native) return null;
  if (!boundedString(lt.name, 255, false) || !boundedString(lt.description, MAX_LINETYPE_TEXT)) return 'invalid complex linetype name or description';
  if (/^(BYLAYER|BYBLOCK|CONTINUOUS)$/i.test(lt.name)) return 'complex data on a reserved linetype cannot be exported safely';
  if (!Array.isArray(lt.pattern) || lt.pattern.length > MAX_LINETYPE_ELEMENTS || !Array.isArray(native.elements) || native.elements.length !== lt.pattern.length) return 'invalid complex linetype element count';
  if (native.flags !== undefined && !nativeInteger(native.flags) || native.alignment !== undefined && !nativeInteger(native.alignment) || native.totalPatternLength !== undefined && (!finite(native.totalPatternLength) || native.totalPatternLength < 0)) return 'invalid complex linetype header';
  for (let i = 0; i < lt.pattern.length; i++) {
    const element = native.elements[i];
    if (!finite(lt.pattern[i]) || !element || !nativeInteger(element.flags)) return 'invalid complex linetype element';
    if (element.shapeNumber !== undefined && (!Number.isInteger(element.shapeNumber) || element.shapeNumber < 0 || element.shapeNumber > 65535)) return 'invalid complex linetype shape number';
    for (const field of ['scale', 'rotation', 'offsetX', 'offsetY'] as const) if (element[field] !== undefined && !finite(element[field])) return 'invalid complex linetype transform';
    if (element.text !== undefined && !boundedString(element.text, MAX_LINETYPE_TEXT)) return 'invalid complex linetype text';
    if ((element.flags & 2) && element.text === undefined) return 'complex linetype text is missing';
    const reference = element.style;
    if (reference) {
      if (reference.kind === 'text') {
        if (!boundedString(reference.name, 255, false) || reference.sourceHandle !== undefined && !boundedString(reference.sourceHandle, 255, false)) return 'invalid complex linetype text style';
      } else if (reference.kind === 'shape') {
        if (!boundedString(reference.sourceId, 255, false)) return 'invalid complex linetype shape style';
      } else if (reference.kind === 'unresolved') {
        return `unresolved complex linetype STYLE reference ${reference.sourceHandle || '(missing)'}`;
      } else return 'invalid complex linetype STYLE reference';
    }
    if (element.flags !== 0 && !reference) return 'complex linetype STYLE reference is missing';
  }
  return null;
}

export function linetypeShapeStyleProblem(style: LinetypeShapeStyle): string | null {
  if (!style || !boundedString(style.name, 255) || !boundedString(style.font, MAX_LINETYPE_TEXT, false) || !boundedString(style.bigFont, MAX_LINETYPE_TEXT)) return 'invalid shape STYLE name or font';
  if (!nativeInteger(style.flags) || !(style.flags & 1) || !nativeInteger(style.generation)) return 'invalid shape STYLE flags';
  for (const field of ['height', 'widthFactor', 'oblique', 'lastHeight'] as const) if (!finite(style[field])) return 'invalid shape STYLE metrics';
  return null;
}

export const CONTINUOUS = 'Continuous';

export const STANDARD_LINETYPES: readonly Linetype[] = [
  { name: CONTINUOUS, description: 'Solid line', pattern: [] },
  { name: 'DASHED', description: 'Dashed __ __ __ __ __ __ __ __ __ __ __ __ __ __ __', pattern: [0.5, -0.25] },
  { name: 'DASHED2', description: 'Dashed (.5x) _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _', pattern: [0.25, -0.125] },
  { name: 'HIDDEN', description: 'Hidden __ __ __ __ __ __ __ __ __ __ __ __ __ __ __ __', pattern: [0.25, -0.125] },
  { name: 'HIDDEN2', description: 'Hidden (.5x) _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ _', pattern: [0.125, -0.0625] },
  { name: 'CENTER', description: 'Center ____ _ ____ _ ____ _ ____ _ ____ _ ____', pattern: [1.25, -0.25, 0.25, -0.25] },
  { name: 'CENTER2', description: 'Center (.5x) ___ _ ___ _ ___ _ ___ _ ___ _ ___ _', pattern: [0.75, -0.125, 0.125, -0.125] },
  { name: 'PHANTOM', description: 'Phantom ______  __  __  ______  __  __  ______', pattern: [1.25, -0.25, 0.25, -0.25, 0.25, -0.25] },
  { name: 'PHANTOM2', description: 'Phantom (.5x) ___ _ _ ___ _ _ ___ _ _ ___ _ _', pattern: [0.625, -0.125, 0.125, -0.125, 0.125, -0.125] },
  { name: 'DOT', description: 'Dot . . . . . . . . . . . . . . . . . . . . . . . .', pattern: [0, -0.25] },
  { name: 'DOT2', description: 'Dot (.5x) ........................................', pattern: [0, -0.125] },
  { name: 'DASHDOT', description: 'Dash dot __ . __ . __ . __ . __ . __ . __ . __', pattern: [0.5, -0.25, 0, -0.25] },
  { name: 'DIVIDE', description: 'Divide ____ . . ____ . . ____ . . ____ . . ____', pattern: [0.5, -0.25, 0, -0.25, 0, -0.25] },
  { name: 'BORDER', description: 'Border __ __ . __ __ . __ __ . __ __ . __ __ .', pattern: [0.5, -0.25, 0.5, -0.25, 0, -0.25] },
];

const byName = new Map(STANDARD_LINETYPES.map((l) => [l.name.toUpperCase(), l]));

/** Look up a linetype by name (case-insensitive). Unknown names render continuous. */
export function findLinetype(name: string | undefined, extra?: readonly Linetype[]): Linetype | undefined {
  if (!name) return undefined;
  const key = name.toUpperCase();
  return extra?.find((l) => l.name.toUpperCase() === key) ?? byName.get(key);
}

export const isByLayer = (name: string | undefined): boolean => !name || name.toUpperCase() === 'BYLAYER';
export const isByBlock = (name: string | undefined): boolean => name !== undefined && name.toUpperCase() === 'BYBLOCK';

/**
 * Resolve the effective linetype name for an entity: entity override, else
 * layer linetype, else Continuous.
 */
export function effectiveLinetype(entityLinetype: string | undefined, layerLinetype: string | undefined): string {
  if (entityLinetype && !isByLayer(entityLinetype) && !isByBlock(entityLinetype)) return entityLinetype;
  return layerLinetype && !isByLayer(layerLinetype) ? layerLinetype : CONTINUOUS;
}

/**
 * Canvas dash array (in pixels) for a linetype at a given zoom. Returns [] for
 * continuous, or when the pattern would be too fine to see (AutoCAD then draws
 * the object continuous as well). Dots become 1 px dashes.
 */
export function dashArray(pattern: readonly number[], ltscale: number, pxPerUnit: number, minPeriodPx = 3): number[] {
  if (pattern.length === 0) return [];
  const k = ltscale * pxPerUnit;
  if (!Number.isFinite(k) || k <= 0) return [];
  const runs: Array<{ dash: boolean; length: number }> = [];
  let period = 0;
  for (const seg of pattern) {
    if (!Number.isFinite(seg)) return [];
    const px = Math.abs(seg) * k;
    period += px;
    if (!Number.isFinite(period)) return [];
    const dash = seg >= 0, last = runs[runs.length - 1];
    if (last?.dash === dash) last.length += px;
    else runs.push({ dash, length: px });
  }
  if (period < minPeriodPx) return [];
  // Native lengths carry their own signs; Canvas alternates array positions. Merge
  // same-kind runs before converting, keeping co-located dots as one minimum-pixel mark.
  const out = runs.map((run) => run.dash ? Math.max(run.length, 1) : run.length);
  if (!runs[0]!.dash) out.unshift(0);
  // A zero gap joins terminal/initial dashes across repetitions without shifting phase.
  // Duplicating an odd array instead would invert all signs in the second repetition.
  if (out.length % 2 === 1) out.push(0);
  return out;
}

/** Total pattern length in drawing units (DXF code 40 of the LTYPE record). */
export function patternLength(pattern: readonly number[]): number {
  return pattern.reduce((s, v) => s + Math.abs(v), 0);
}

/** Lineweight values AutoCAD offers (mm). -1 = ByLayer, -2 = ByBlock, -3 = Default. */
export const LINEWEIGHTS: readonly number[] = [0, 0.05, 0.09, 0.13, 0.15, 0.18, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.53, 0.6, 0.7, 0.8, 0.9, 1, 1.06, 1.2, 1.4, 1.58, 2, 2.11];

export function nearestLineweight(mm: number): number {
  let best = LINEWEIGHTS[0]!;
  for (const w of LINEWEIGHTS) if (Math.abs(w - mm) < Math.abs(best - mm)) best = w;
  return best;
}
