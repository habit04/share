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
import { textStyleOf, type TextStyle } from '../io/encoding';

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

// ---------------------------------------------------------------- text styles: Hershey strokes or a canvas font

/** How a text style is drawn: SHX fonts map to the Hershey strokes, TrueType fonts to a canvas font stack. */
export type TextRenderer =
  | { readonly kind: 'stroke'; readonly widthFactor: number; readonly oblique: number }
  | {
      readonly kind: 'canvas';
      /** CSS font-family list, most specific first. */
      readonly family: string;
      readonly bold: boolean;
      readonly italic: boolean;
      readonly widthFactor: number;
      /** Oblique angle in radians. */
      readonly oblique: number;
    };

/**
 * Text styles of the drawing being drawn. The viewport copies the document's
 * STYLE table here before each frame (like `renderSettings` in draw.ts).
 */
export const textStyleRegistry: { styles: Readonly<Record<string, TextStyle>> } = { styles: {} };

export function setTextStyles(styles: Readonly<Record<string, TextStyle>>): void {
  textStyleRegistry.styles = styles;
}

/** A TrueType / OpenType font file (the STYLE record's group 3), or a family name from the style's XDATA. */
export function isTrueTypeStyle(s: Pick<TextStyle, 'font' | 'family'>): boolean {
  return /\.(ttf|ttc|otf)$/i.test(s.font.trim()) || (!!s.family && !/\.shx$/i.test(s.font.trim()));
}

const SANS = '"Liberation Sans", Arimo, Helvetica, sans-serif';
/** Font files AutoCAD drawings commonly name, with metric-compatible free substitutes. */
const FONT_FAMILIES: Array<[RegExp, string]> = [
  [/^arial(n|nb|nbi|ni)?(bd|bi|i)?$/, `Arial, ${SANS}`],
  [/^(times|timesbd|timesbi|timesi)$/, '"Times New Roman", "Liberation Serif", Tinos, Times, serif'],
  [/^(cour|courbd|courbi|couri)$/, '"Courier New", "Liberation Mono", Cousine, monospace'],
  [/^(calibri|calibrib|calibrii|calibriz)$/, `Calibri, Carlito, ${SANS}`],
  [/^(cambria|cambriab|cambriai|cambriaz)$/, 'Cambria, Caladea, serif'],
  [/^(verdana|verdanab|verdanai|verdanaz)$/, `Verdana, "DejaVu Sans", ${SANS}`],
  [/^(tahoma|tahomabd)$/, `Tahoma, "DejaVu Sans", ${SANS}`],
  [/^(segoeui|segoeuib|segoeuii|segoeuiz)$/, `"Segoe UI", ${SANS}`],
  [/^(isocpeur|isocp|isoct|isoct2|isoct3)$/, `ISOCPEUR, "Liberation Sans Narrow", ${SANS}`],
  [/^(msgothic|msmincho|meiryo|yugoth\w*)$/, '"MS Gothic", "Yu Gothic", "Noto Sans CJK JP", "Noto Sans JP", sans-serif'],
  [/^(simsun|simhei|msyh\w*)$/, 'SimSun, "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif'],
  [/^(mingliu|msjh\w*)$/, 'MingLiU, "Microsoft JhengHei", "Noto Sans CJK TC", "Noto Sans TC", sans-serif'],
  [/^(gulim|batang|malgun\w*)$/, 'Gulim, "Malgun Gothic", "Noto Sans CJK KR", "Noto Sans KR", sans-serif'],
];

const quoteFamily = (name: string) => (/^[A-Za-z][\w-]*$/.test(name) ? name : `"${name.replace(/["\\]/g, '')}"`);
const fontBase = (font: string) => font.trim().replace(/^.*[\\/]/, '').replace(/\.(ttf|ttc|otf)$/i, '').toLowerCase();

/** CSS font stack for a style (a family name from XDATA wins over the file name). */
export function fontStack(s: Pick<TextStyle, 'font' | 'family'>): string {
  const base = fontBase(s.font);
  const known = FONT_FAMILIES.find(([re]) => re.test(base))?.[1];
  if (s.family) return `${quoteFamily(s.family)}, ${known ?? SANS}`;
  return known ?? `${quoteFamily(base || 'Arial')}, Arial, ${SANS}`;
}

/** Bold / italic from the style's TrueType flags, else from Windows font file names (arialbd, ariali, arialbi, calibriz). */
export function fontWeight(s: Pick<TextStyle, 'font' | 'bold' | 'italic'>): { bold: boolean; italic: boolean } {
  if (s.bold !== undefined || s.italic !== undefined) return { bold: !!s.bold, italic: !!s.italic };
  const m = /^(arial|times|cour|verdana|tahoma|calibri|cambria|segoeui)(bd|bi|i|b|z)$/.exec(fontBase(s.font));
  const suffix = m?.[2] ?? '';
  return { bold: suffix === 'bd' || suffix === 'bi' || suffix === 'b' || suffix === 'z', italic: suffix === 'i' || suffix === 'bi' || suffix === 'z' };
}

/** Look a style up by name, ignoring case (AutoCAD style names are case-insensitive). */
export function findTextStyle(name: string | undefined, styles: Readonly<Record<string, TextStyle>> = textStyleRegistry.styles): TextStyle | undefined {
  const n = name || 'Standard';
  return styles[n] ?? Object.values(styles).find((x) => x.name.toUpperCase() === n.toUpperCase());
}

/** The renderer for a style name (unknown names and SHX fonts draw with the Hershey strokes). */
export function textRenderer(styleName?: string, styles: Readonly<Record<string, TextStyle>> = textStyleRegistry.styles): TextRenderer {
  const s = findTextStyle(styleName, styles);
  const widthFactor = s?.widthFactor && s.widthFactor > 0 ? s.widthFactor : 1;
  const oblique = ((s?.oblique ?? 0) * Math.PI) / 180;
  if (!s || !isTrueTypeStyle(s)) return { kind: 'stroke', widthFactor, oblique };
  return { kind: 'canvas', family: fontStack(s), ...fontWeight(s), widthFactor, oblique };
}

/** Cap height of the usual sans-serif faces as a fraction of the em (Arial / Liberation Sans: 0.716). */
export const CAP_HEIGHT_EM = 0.716;

/** Canvas `font` shorthand for a text whose cap height is `capPx` CSS pixels. */
export function canvasFont(r: Extract<TextRenderer, { kind: 'canvas' }>, capPx: number): string {
  const px = Math.max(1, capPx / CAP_HEIGHT_EM);
  return `${r.italic ? 'italic ' : ''}${r.bold ? 'bold ' : ''}${Number(px.toFixed(2))}px ${r.family}`;
}

/** The 2D context calls `drawStyledText` makes (a CanvasRenderingContext2D satisfies it). */
export interface TextCanvas {
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  transform(a: number, b: number, c: number, d: number, e: number, f: number): void;
  scale(x: number, y: number): void;
  fillText(text: string, x: number, y: number): void;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
}

/**
 * Draw a TEXT entity whose style uses a TrueType font with the canvas font
 * stack. Returns false (nothing drawn) for SHX / unknown styles, so the caller
 * falls back to the Hershey strokes. draw.ts calls it at the top of drawText,
 * after the too-small placeholder:  `if (drawStyledText(ctx, e, tf)) return;`
 */
export function drawStyledText(
  ctx: TextCanvas,
  e: { readonly position: { x: number; y: number }; readonly text: string; readonly height: number; readonly rotation: number; readonly align: 'left' | 'center' | 'right'; readonly style?: string },
  tf: { toScreen(p: { x: number; y: number }): { x: number; y: number }; scale: number },
  styleName: string | undefined = textStyleOf(e),
): boolean {
  const r = textRenderer(styleName);
  if (r.kind !== 'canvas') return false;
  const p = tf.toScreen(e.position);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(-e.rotation);
  if (r.oblique) ctx.transform(1, 0, -Math.tan(r.oblique), 1, 0, 0);
  if (r.widthFactor !== 1) ctx.scale(r.widthFactor, 1);
  ctx.font = canvasFont(r, e.height * tf.scale);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = e.align;
  ctx.fillText(expandControlCodes(e.text), 0, 0);
  ctx.restore();
  return true;
}
