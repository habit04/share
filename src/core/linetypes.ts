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
  const out: number[] = [];
  let period = 0;
  for (const seg of pattern) {
    const px = Math.abs(seg) * k;
    period += px;
    if (seg === 0) out.push(1); // dot
    else if (seg > 0) out.push(Math.max(px, 1));
    else out.push(px);
  }
  if (period < minPeriodPx) return [];
  // Canvas requires an even number of entries to alternate dash/gap correctly.
  if (out.length % 2 === 1) return [...out, ...out];
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
