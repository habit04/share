/**
 * Drawing units (UNITS command / $LUNITS, $LUPREC, $INSUNITS).
 * LUNITS: 1 scientific, 2 decimal, 3 engineering, 4 architectural, 5 fractional.
 */
export type LinearUnits = 1 | 2 | 3 | 4 | 5;

export interface UnitSettings {
  /** $LUNITS */
  readonly lunits: LinearUnits;
  /** $LUPREC: decimal places (decimal/scientific/engineering) or fraction denominator power (architectural/fractional). */
  readonly luprec: number;
  /** $INSUNITS: 0 unitless, 1 inches, 2 feet, 4 millimetres, 5 centimetres, 6 metres. */
  readonly insunits: number;
  /** $AUPREC angular precision (decimal degrees). */
  readonly auprec: number;
}

export const DEFAULT_UNITS: UnitSettings = { lunits: 2, luprec: 4, insunits: 1, auprec: 0 };

export const LUNIT_NAMES: Record<LinearUnits, string> = {
  1: 'Scientific',
  2: 'Decimal',
  3: 'Engineering',
  4: 'Architectural',
  5: 'Fractional',
};

export const INSUNIT_NAMES: Record<number, string> = {
  0: 'Unitless',
  1: 'Inches',
  2: 'Feet',
  4: 'Millimeters',
  5: 'Centimeters',
  6: 'Meters',
};

/** Reduce a fraction of `num / 2^power` to lowest terms as "a/b" (empty when zero). */
function fraction(num: number, denom: number): string {
  if (num === 0) return '';
  let n = num;
  let d = denom;
  while (n % 2 === 0 && d > 1) {
    n /= 2;
    d /= 2;
  }
  return `${n}/${d}`;
}

/** Whole part plus reduced fraction, rounded to the nearest 1/2^prec. Returns [whole, fractionText]. */
function toFraction(v: number, prec: number): [number, string] {
  const denom = 2 ** Math.max(0, Math.min(8, Math.round(prec)));
  let whole = Math.floor(v);
  let num = Math.round((v - whole) * denom);
  if (num === denom) {
    whole += 1;
    num = 0;
  }
  return [whole, fraction(num, denom)];
}

/** Format a length in drawing units the way AutoCAD's LUNITS/LUPREC display it. */
export function formatLength(value: number, units: Pick<UnitSettings, 'lunits' | 'luprec'> = DEFAULT_UNITS): string {
  const v = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  switch (units.lunits) {
    case 1:
      return sign + v.toExponential(units.luprec).replace(/e([+-])(\d)$/, 'E$10$2').replace('e', 'E');
    case 3: {
      const feet = Math.floor(v / 12);
      const inches = v - feet * 12;
      return `${sign}${feet}'-${inches.toFixed(units.luprec)}"`;
    }
    case 4: {
      // Round first so 11.999" rolls into the next foot.
      const denom = 2 ** Math.max(0, Math.min(8, Math.round(units.luprec)));
      const total = Math.round(v * denom) / denom;
      const feet = Math.floor(total / 12);
      const [whole, frac] = toFraction(total - feet * 12, units.luprec);
      const inchText = frac ? (whole ? `${whole} ${frac}` : frac) : String(whole);
      return `${sign}${feet}'-${inchText}"`;
    }
    case 5: {
      const [whole, frac] = toFraction(v, units.luprec);
      return sign + (frac ? (whole ? `${whole} ${frac}` : frac) : String(whole));
    }
    default:
      return sign + v.toFixed(units.luprec);
  }
}

/** Format an angle (radians) in decimal degrees. */
export function formatAngle(rad: number, auprec = 0): string {
  let d = (rad * 180) / Math.PI;
  d = ((d % 360) + 360) % 360;
  const s = d.toFixed(auprec);
  return s === (360).toFixed(auprec) ? (0).toFixed(auprec) : s;
}

/** Format an area (square drawing units). */
export function formatArea(value: number, units: Pick<UnitSettings, 'lunits' | 'luprec'> = DEFAULT_UNITS): string {
  if (units.lunits === 4 || units.lunits === 3) {
    const sqft = value / 144;
    return `${value.toFixed(units.luprec)} sq in (${sqft.toFixed(units.luprec)} sq ft)`;
  }
  return formatLength(value, { ...units, lunits: units.lunits === 5 ? 2 : units.lunits });
}

/**
 * Parse a distance typed at the command line. Accepts plain numbers and
 * architectural input such as 1'-3 1/2", 1'3", 6", 3/4".
 */
export function parseDistance(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(t)) return parseFloat(t);
  const m = /^(-)?(?:(\d+(?:\.\d+)?)')?-?\s*(?:(\d+(?:\.\d+)?)?(?:\s+|-)?(?:(\d+)\/(\d+))?"?)?$/.exec(t);
  if (!m || (!m[2] && !m[3] && !m[4])) return null;
  let v = 0;
  if (m[2]) v += parseFloat(m[2]) * 12;
  if (m[3]) v += parseFloat(m[3]);
  if (m[4] && m[5]) v += parseInt(m[4], 10) / parseInt(m[5], 10);
  return m[1] ? -v : v;
}

/** Conversion factor from one $INSUNITS code to another (unknown codes are treated as 1:1). */
export function insunitsFactor(from: number, to: number): number {
  const toInches: Record<number, number> = { 1: 1, 2: 12, 4: 1 / 25.4, 5: 1 / 2.54, 6: 1 / 0.0254 };
  const a = toInches[from];
  const b = toInches[to];
  if (!a || !b) return 1;
  return a / b;
}
