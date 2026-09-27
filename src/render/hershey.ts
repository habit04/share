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

export function glyphFor(ch: string): Glyph | undefined {
  return glyphs.get(ch.charCodeAt(0));
}

/** Width of a string at the given cap height. */
export function strokeTextWidth(text: string, height: number): number {
  let w = 0;
  for (const ch of text) {
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
  for (const ch of text) {
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
