/**
 * Hershey "Roman Simplex" single-stroke font, used to render TEXT entities the
 * way AutoCAD's txt.shx does. Font data is public-domain Hershey data (see
 * fonts/HERSHEY-LICENSE for the required acknowledgement).
 *
 * Glyph coordinates: the .jhf file encodes each vertex relative to 'R' (82).
 * The Roman Simplex cap height is 21 units (y from -12 .. 9 with y down), so
 * we normalise so that a capital letter is exactly 1.0 tall with the baseline
 * at y = 0 and +y up (matching world coordinates).
 */
import jhf from './fonts/rowmans.jhf?raw';

export interface Glyph {
  /** Advance width in normalised units (cap height = 1). */
  advance: number;
  /** Left bearing offset already applied; polylines in normalised units. */
  strokes: Array<Array<[number, number]>>;
}

const CAP = 21; // Simplex cap height in raw units (baseline 9, cap top -12)
const BASELINE = 9;

function parseLine(line: string): Glyph | null {
  if (line.length < 10) return null;
  const R = 82;
  const n = parseInt(line.slice(5, 8), 10) - 1;
  const left = line.charCodeAt(8) - R;
  const right = line.charCodeAt(9) - R;
  const strokes: Array<Array<[number, number]>> = [];
  let cur: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const cx = line.charCodeAt(10 + i * 2) - R;
    const cy = line.charCodeAt(11 + i * 2) - R;
    if (cx === -50 && cy === 0) {
      if (cur.length) strokes.push(cur);
      cur = [];
    } else {
      cur.push([(cx - left) / CAP, (BASELINE - cy) / CAP]);
    }
  }
  if (cur.length) strokes.push(cur);
  return { advance: (right - left) / CAP, strokes };
}

const glyphs = new Map<number, Glyph>();
(() => {
  const lines = jhf.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // rowmans.jhf lists the 96 printable ASCII glyphs in order, starting at space (32).
  lines.forEach((l, i) => {
    const g = parseLine(l);
    if (g) glyphs.set(32 + i, g);
  });
})();

// Symbols AutoCAD reaches through %%c (diameter), %%d (degree) and %%p (plus/minus),
// which the Hershey set lacks. Drawn here as original simple strokes.
const circleStroke = (cx: number, cy: number, r: number, n = 16): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= n; i += 1) out.push([cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  return out;
};
glyphs.set(0x2300, { advance: 1.0, strokes: [circleStroke(0.5, 0.5, 0.4), [[0.1, 0.05], [0.9, 0.95]]] }); // ⌀
glyphs.set(0xd8, glyphs.get(0x2300)!); // Ø
glyphs.set(0xb0, { advance: 0.55, strokes: [circleStroke(0.25, 0.85, 0.15, 12)] }); // °
glyphs.set(0xb1, { advance: 0.9, strokes: [[[0.45, 0.25], [0.45, 0.85]], [[0.1, 0.55], [0.8, 0.55]], [[0.1, 0.0], [0.8, 0.0]]] }); // ±

/** Expand AutoCAD control codes: %%c -> ⌀, %%d -> °, %%p -> ±, %%% -> %. */
export function expandControlCodes(text: string): string {
  if (!text.includes('%%')) return text;
  return text.replace(/%%([cCdDpP%])/g, (_m, c: string) => {
    switch (c.toLowerCase()) {
      case 'c':
        return '\u2300';
      case 'd':
        return '\u00b0';
      case 'p':
        return '\u00b1';
      default:
        return '%';
    }
  });
}

export function glyphFor(ch: string): Glyph | undefined {
  return glyphs.get(ch.charCodeAt(0));
}

/** Width of a string at the given cap height. */
export function strokeTextWidth(text: string, height: number): number {
  let w = 0;
  for (const ch of expandControlCodes(text)) {
    const g = glyphs.get(ch.charCodeAt(0)) ?? glyphs.get(63); // '?' for unknown
    w += (g?.advance ?? 0.7) * height;
  }
  return w;
}

/**
 * Produce world-space stroke polylines for a text string. `origin` is the
 * baseline start (left/center/right aligned per `align`), `rotation` radians.
 */
export function strokeText(
  text: string,
  origin: { x: number; y: number },
  height: number,
  rotation: number,
  align: 'left' | 'center' | 'right',
): Array<Array<{ x: number; y: number }>> {
  const total = strokeTextWidth(text, height);
  const offset = align === 'center' ? -total / 2 : align === 'right' ? -total : 0;
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const out: Array<Array<{ x: number; y: number }>> = [];
  let pen = offset;
  for (const ch of expandControlCodes(text)) {
    const g = glyphs.get(ch.charCodeAt(0)) ?? glyphs.get(63);
    if (!g) continue;
    for (const stroke of g.strokes) {
      out.push(
        stroke.map(([gx, gy]) => {
          const lx = pen + gx * height;
          const ly = gy * height;
          return { x: origin.x + lx * c - ly * s, y: origin.y + lx * s + ly * c };
        }),
      );
    }
    pen += g.advance * height;
  }
  return out;
}

export const hasStrokeFont = glyphs.size > 0;
