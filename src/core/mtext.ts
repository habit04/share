/**
 * Multi-line text (MTEXT): paragraphs, word wrap to a reference width, nine
 * attachment points and a line-spacing factor (1 = the 5/3 default).
 *
 * The entity's `text` is plain (paragraphs separated by '\n'). Text read from a
 * DXF / DWG also keeps the original formatted content in `raw`; while `raw` still
 * matches `text` it drives the formatted layout (colours, heights, width factor,
 * oblique, underline / overline / strike-through, stacked fractions, paragraph
 * alignment) and is written back unchanged.
 */
import type { Point } from './geometry';
import * as g from './geometry';
import type { ColorSpec, EntityBase, TextEntity, FieldLink } from './entities';

/** 1 TL, 2 TC, 3 TR, 4 ML, 5 MC, 6 MR, 7 BL, 8 BC, 9 BR */
export type MTextAttachment = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export interface MTextEntity extends EntityBase {
  readonly type: 'mtext';
  /** Attachment point (see `attachment`). */
  readonly position: Point;
  /** Paragraphs separated by '\n'. */
  readonly text: string;
  readonly height: number;
  /** Reference rectangle width; 0 = no wrapping. */
  readonly width: number;
  readonly rotation: number;
  readonly attachment: MTextAttachment;
  /** Line spacing factor (1 = 1.6667 × height between baselines). */
  readonly lineSpacing: number;
  /** DXF content with inline format codes (\C, \H, \S ...), kept while it still matches `text`. */
  readonly raw?: string;
  /** Field expression the text was evaluated from (%<\AcVar Date>% ...). */
  readonly field?: FieldLink;
}

export type Measure = (text: string, height: number) => number;

export const LINE_SPACING = 5 / 3;

/** Word-wrap one paragraph to `width` (0 = no wrapping). Words longer than the width stay whole. */
export function wrapParagraph(paragraph: string, width: number, height: number, measure: Measure): string[] {
  if (width <= 0) return [paragraph];
  const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (cur && measure(candidate, height) > width + 1e-9) {
      lines.push(cur);
      cur = w;
    } else cur = candidate;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** All display lines of an MTEXT after wrapping. */
export function mtextLines(m: Pick<MTextEntity, 'text' | 'width' | 'height'>, measure: Measure): string[] {
  const out: string[] = [];
  for (const para of m.text.replace(/\\P/g, '\n').split('\n')) out.push(...wrapParagraph(para, m.width, m.height, measure));
  return out;
}

export function mtextAlign(attachment: MTextAttachment): 'left' | 'center' | 'right' {
  const col = (attachment - 1) % 3;
  return col === 0 ? 'left' : col === 1 ? 'center' : 'right';
}

/** Overall box size of the laid-out text (unrotated). */
export function mtextExtents(m: MTextEntity, measure: Measure): { width: number; height: number; lines: string[] } {
  const lines = mtextLines(m, measure);
  const lineH = m.height * LINE_SPACING * (m.lineSpacing || 1);
  const height = m.height + (lines.length - 1) * lineH;
  let width = 0;
  for (const l of lines) width = Math.max(width, measure(l, m.height));
  return { width, height, lines };
}

// ------------------------------------------------------------------ format codes

export interface MTextStyle {
  readonly height: number;
  readonly widthFactor: number;
  /** Oblique angle, radians. */
  readonly oblique: number;
  /** ACI colour override (undefined = the entity's colour). */
  readonly color?: number;
  /** 0xRRGGBB true colour override. */
  readonly trueColor?: number;
  readonly underline: boolean;
  readonly overline: boolean;
  readonly strike: boolean;
  readonly bold: boolean;
  readonly italic: boolean;
}

export type MTextItem = { kind: 'text'; text: string; style: MTextStyle } | { kind: 'stack'; top: string; bottom: string; type: '^' | '/' | '#'; style: MTextStyle };

export interface MTextParagraph {
  align?: 'left' | 'center' | 'right' | 'justify';
  items: MTextItem[];
}

const NBSP = ' ';

function readUntilSemicolon(s: string, i: number): { value: string; next: number } {
  const j = s.indexOf(';', i);
  if (j < 0) return { value: s.slice(i), next: s.length };
  return { value: s.slice(i, j), next: j + 1 };
}

/** Parse MTEXT content with format codes into paragraphs of styled runs. */
export function parseMText(raw: string, baseHeight: number): MTextParagraph[] {
  const paras: MTextParagraph[] = [{ items: [] }];
  const base: MTextStyle = { height: baseHeight, widthFactor: 1, oblique: 0, underline: false, overline: false, strike: false, bold: false, italic: false };
  let style = base;
  const stack: MTextStyle[] = [];
  let buf = '';
  const cur = () => paras[paras.length - 1]!;
  const flush = () => {
    if (!buf) return;
    const items = cur().items;
    const last = items[items.length - 1];
    if (last && last.kind === 'text' && last.style === style) last.text += buf;
    else items.push({ kind: 'text', text: buf, style });
    buf = '';
  };
  const set = (patch: Partial<MTextStyle>) => {
    flush();
    style = { ...style, ...patch };
  };
  const newPara = () => {
    flush();
    const align = cur().align;
    paras.push(align ? { items: [], align } : { items: [] });
  };
  const num = (v: string) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '\n') {
      newPara();
      i += 1;
      continue;
    }
    if (ch === '{') {
      flush();
      stack.push(style);
      i += 1;
      continue;
    }
    if (ch === '}') {
      flush();
      style = stack.pop() ?? base;
      i += 1;
      continue;
    }
    if (ch === '%' && raw[i + 1] === '%' && i + 2 < raw.length) {
      const c = raw[i + 2]!;
      const lc = c.toLowerCase();
      if (lc === 'u') {
        set({ underline: !style.underline });
        i += 3;
        continue;
      }
      if (lc === 'o') {
        set({ overline: !style.overline });
        i += 3;
        continue;
      }
      if (lc === 'k') {
        set({ strike: !style.strike });
        i += 3;
        continue;
      }
      if (/\d/.test(c)) {
        const m = /^\d{1,3}/.exec(raw.slice(i + 2))!;
        buf += String.fromCharCode(parseInt(m[0], 10));
        i += 2 + m[0].length;
        continue;
      }
      // %%c %%d %%p %%% stay as written; the stroke font expands them.
      buf += raw.slice(i, i + 3);
      i += 3;
      continue;
    }
    if (ch !== '\\' || i + 1 >= raw.length) {
      buf += ch;
      i += 1;
      continue;
    }
    const code = raw[i + 1]!;
    i += 2;
    switch (code) {
      case 'P':
      case 'N':
      case 'X':
        newPara();
        break;
      case '~':
        buf += NBSP;
        break;
      case '\\':
      case '{':
      case '}':
        buf += code;
        break;
      case 'C': {
        const r = readUntilSemicolon(raw, i);
        i = r.next;
        const n = num(r.value);
        if (n !== null) set(n === 0 || n === 256 ? { color: undefined, trueColor: undefined } : { color: Math.round(n), trueColor: undefined });
        break;
      }
      case 'c': {
        const r = readUntilSemicolon(raw, i);
        i = r.next;
        const n = num(r.value);
        // Inline true colour is stored low byte = red (BGR order).
        if (n !== null) set({ trueColor: ((n & 0xff) << 16) | (n & 0xff00) | ((n >> 16) & 0xff), color: undefined });
        break;
      }
      case 'H': {
        const r = readUntilSemicolon(raw, i);
        i = r.next;
        const rel = /x$/i.test(r.value.trim());
        const n = num(r.value);
        if (n !== null && n > 0) set({ height: rel ? style.height * n : n });
        break;
      }
      case 'W': {
        const r = readUntilSemicolon(raw, i);
        i = r.next;
        const rel = /x$/i.test(r.value.trim());
        const n = num(r.value);
        if (n !== null && n > 0) set({ widthFactor: rel ? style.widthFactor * n : n });
        break;
      }
      case 'Q': {
        const r = readUntilSemicolon(raw, i);
        i = r.next;
        const n = num(r.value);
        if (n !== null) set({ oblique: g.rad(n) });
        break;
      }
      case 'f':
      case 'F': {
        const r = readUntilSemicolon(raw, i);
        i = r.next;
        const b = /\|b(\d)/i.exec(r.value);
        const it = /\|i(\d)/i.exec(r.value);
        set({ bold: b ? b[1] !== '0' : false, italic: it ? it[1] !== '0' : false });
        break;
      }
      case 'L':
        set({ underline: true });
        break;
      case 'l':
        set({ underline: false });
        break;
      case 'O':
        set({ overline: true });
        break;
      case 'o':
        set({ overline: false });
        break;
      case 'K':
        set({ strike: true });
        break;
      case 'k':
        set({ strike: false });
        break;
      case 'S': {
        // Stack: top^bottom (tolerance), top/bottom (horizontal bar), top#bottom (diagonal).
        let j = i;
        let body = '';
        while (j < raw.length && raw[j] !== ';') {
          if (raw[j] === '\\' && j + 1 < raw.length) {
            body += raw[j + 1] === ';' ? ';' : raw[j + 1];
            j += 2;
            continue;
          }
          body += raw[j];
          j += 1;
        }
        i = Math.min(raw.length, j + 1);
        const m = /[\^/#]/.exec(body);
        flush();
        if (m) {
          const top = body.slice(0, m.index);
          const bottom = body.slice(m.index + 1).replace(/^ /, '');
          cur().items.push({ kind: 'stack', top, bottom, type: m[0] as '^' | '/' | '#', style });
        } else buf += body;
        break;
      }
      case 'U': {
        const m = /^\+([0-9A-Fa-f]{4,6})/.exec(raw.slice(i));
        if (m) {
          buf += String.fromCodePoint(parseInt(m[1]!, 16));
          i += m[0].length;
        }
        break;
      }
      case 'M': {
        const m = /^\+[0-9A-Fa-f]{5}/.exec(raw.slice(i));
        if (m) i += m[0].length;
        break;
      }
      case 'p': {
        const r = readUntilSemicolon(raw, i);
        i = r.next;
        const q = /q([lcrjd])/i.exec(r.value);
        if (q) {
          flush();
          const a = q[1]!.toLowerCase();
          cur().align = a === 'c' ? 'center' : a === 'r' ? 'right' : a === 'j' ? 'justify' : 'left';
        }
        break;
      }
      case 'A':
      case 'T': {
        i = readUntilSemicolon(raw, i).next;
        break;
      }
      default: {
        // Unknown code: drop it together with its argument when one follows (\Xvalue;).
        const semi = raw.indexOf(';', i);
        const nextBreak = raw.slice(i).search(/[\s\\{}]/);
        if (semi >= 0 && (nextBreak < 0 || semi < i + nextBreak)) i = semi + 1;
        break;
      }
    }
  }
  flush();
  return paras;
}

/** Plain text of parsed paragraphs (stacks become "top/bottom"). */
export function paragraphsPlain(paras: readonly MTextParagraph[]): string {
  return paras
    .map((p) =>
      p.items
        .map((it) => (it.kind === 'text' ? it.text : `${it.top}${it.type === '^' ? ' ' : '/'}${it.bottom}`))
        .join('')
        .replace(/ /g, ' '),
    )
    .join('\n');
}

/** Convert our paragraphs to DXF MTEXT content (\P paragraph separator). */
export function mtextToDxf(text: string): string {
  return text.replace(/\n/g, '\\P');
}

/** Strip DXF MTEXT formatting codes, keeping paragraph breaks as '\n'. */
export function mtextFromDxf(raw: string): string {
  return paragraphsPlain(parseMText(raw, 1));
}

/** True when content carries formatting beyond paragraph breaks. */
export function hasFormatting(raw: string): boolean {
  return /\\[^P]|[{}]|%%[uUoOkK\d]/.test(raw);
}

/** The formatted content to lay out, or null when `raw` is absent or no longer matches the text. */
export function formattedSource(m: Pick<MTextEntity, 'text' | 'raw'>): string | null {
  if (!m.raw || !hasFormatting(m.raw)) return null;
  return mtextFromDxf(m.raw) === m.text ? m.raw : null;
}

// ------------------------------------------------------------------ layout

/** A decoration stroke (underline, overline, strike-through, fraction bar) in world space. */
export interface MTextStroke {
  a: Point;
  b: Point;
  color?: number;
  trueColor?: number;
}

export interface MTextLayout {
  texts: TextEntity[];
  strokes: MTextStroke[];
}

/** Lay out an MTEXT into single-line TEXT pieces in world space. */
export function mtextLayout(m: MTextEntity, measure: Measure): TextEntity[] {
  return mtextLayoutFull(m, measure).texts;
}

/** Full layout: text pieces plus decoration strokes. */
export function mtextLayoutFull(m: MTextEntity, measure: Measure): MTextLayout {
  const src = formattedSource(m);
  if (src !== null) return formattedLayout(m, parseMText(src, m.height), measure);
  const { height: H, lines } = mtextExtents(m, measure);
  const lineH = m.height * LINE_SPACING * (m.lineSpacing || 1);
  const row = Math.floor((m.attachment - 1) / 3);
  const top = row === 0 ? 0 : row === 1 ? H / 2 : H;
  const align = mtextAlign(m.attachment);
  const out: TextEntity[] = [];
  lines.forEach((text, i) => {
    const local = { x: 0, y: top - m.height - i * lineH };
    out.push({
      id: `${m.id}:${i}`,
      layer: m.layer,
      color: m.color,
      linetype: m.linetype,
      lineWeight: m.lineWeight,
      ...(m.trueColor !== undefined ? { trueColor: m.trueColor } : {}),
      type: 'text',
      position: g.add(m.position, g.rotate(local, m.rotation)),
      text,
      height: m.height,
      rotation: m.rotation,
      align,
    });
  });
  return { texts: out, strokes: [] };
}

const STACK_SCALE = 0.7;

interface Frag {
  kind: 'text' | 'stack';
  text: string;
  top?: string;
  bottom?: string;
  stackType?: '^' | '/' | '#';
  style: MTextStyle;
  width: number;
  space: boolean;
}

function fragWidth(f: Omit<Frag, 'width'>, measure: Measure): number {
  const s = f.style;
  if (f.kind === 'text') return measure(f.text.replace(/ /g, ' '), s.height) * s.widthFactor;
  const h = s.height * STACK_SCALE;
  const wt = measure(f.top ?? '', h) * s.widthFactor;
  const wb = measure(f.bottom ?? '', h) * s.widthFactor;
  return f.stackType === '#' ? wt + wb + s.height * 0.3 : Math.max(wt, wb);
}

function formattedLayout(m: MTextEntity, paras: MTextParagraph[], measure: Measure): MTextLayout {
  interface Line {
    frags: Frag[];
    width: number;
    height: number;
    align: 'left' | 'center' | 'right' | 'justify';
  }
  const defaultAlign = mtextAlign(m.attachment);
  const lines: Line[] = [];
  for (const para of paras) {
    // Fragments: runs split at spaces; a word may span several runs.
    const frags: Frag[] = [];
    for (const it of para.items) {
      if (it.kind === 'stack') {
        const f = { kind: 'stack' as const, text: '', top: it.top, bottom: it.bottom, stackType: it.type, style: it.style, space: false };
        frags.push({ ...f, width: fragWidth(f, measure) });
        continue;
      }
      for (const piece of it.text.split(/( +)/)) {
        if (!piece) continue;
        const f = { kind: 'text' as const, text: piece, style: it.style, space: /^ +$/.test(piece) };
        frags.push({ ...f, width: fragWidth(f, measure) });
      }
    }
    const align = para.align ?? defaultAlign;
    const lineHeight = (fs: Frag[]) => fs.reduce((h, f) => Math.max(h, f.style.height), 0) || m.height;
    const finish = (fs: Frag[]) => {
      while (fs.length && fs[fs.length - 1]!.space) fs.pop();
      lines.push({ frags: fs, width: fs.reduce((w, f) => w + f.width, 0), height: lineHeight(fs), align });
    };
    let cur: Frag[] = [];
    let curW = 0;
    let k = 0;
    while (k < frags.length) {
      // Next word = consecutive non-space fragments (plus the spaces before it).
      const word: Frag[] = [];
      while (k < frags.length && frags[k]!.space) word.push(frags[k++]!);
      while (k < frags.length && !frags[k]!.space) word.push(frags[k++]!);
      const ww = word.reduce((w, f) => w + f.width, 0);
      const visible = word.filter((f) => !f.space);
      if (m.width > 0 && cur.some((f) => !f.space) && curW + ww > m.width + 1e-9) {
        finish(cur);
        cur = [...visible];
        curW = visible.reduce((w, f) => w + f.width, 0);
      } else {
        cur.push(...word);
        curW += ww;
      }
    }
    finish(cur);
  }
  const spacing = LINE_SPACING * (m.lineSpacing || 1);
  const H = lines.reduce((h, l, i) => h + (i === 0 ? l.height : l.height * spacing), 0);
  const row = Math.floor((m.attachment - 1) / 3);
  const col = (m.attachment - 1) % 3;
  const top = row === 0 ? 0 : row === 1 ? H / 2 : H;
  const maxW = lines.reduce((w, l) => Math.max(w, l.width), 0);
  const boxW = m.width > 0 ? Math.max(m.width, 0) : maxW;
  const boxLeft = col === 0 ? 0 : col === 1 ? -boxW / 2 : -boxW;
  const toWorld = (x: number, y: number) => g.add(m.position, g.rotate({ x, y }, m.rotation));
  const texts: TextEntity[] = [];
  const strokes: MTextStroke[] = [];
  let baseline = top;
  let n = 0;
  const color = (s: MTextStyle): { color: ColorSpec; trueColor?: number } =>
    s.trueColor !== undefined ? { color: m.color, trueColor: s.trueColor } : s.color !== undefined ? { color: s.color } : { color: m.color, ...(m.trueColor !== undefined ? { trueColor: m.trueColor } : {}) };
  const piece = (text: string, x: number, y: number, s: MTextStyle, h: number) => {
    if (!text.trim()) return;
    const c = color(s);
    texts.push({
      id: `${m.id}:${n++}`,
      layer: m.layer,
      linetype: m.linetype,
      lineWeight: m.lineWeight,
      ...c,
      type: 'text',
      position: toWorld(x, y),
      text: text.replace(/ /g, ' '),
      height: h,
      rotation: m.rotation,
      align: 'left',
      ...(Math.abs(s.widthFactor - 1) > 1e-9 ? { widthFactor: s.widthFactor } : {}),
      ...(s.oblique || s.italic ? { oblique: s.oblique || g.rad(15) } : {}),
      ...(s.bold ? { bold: true } : {}),
    });
  };
  const stroke = (x0: number, x1: number, y: number, s: MTextStyle) => {
    const c = color(s);
    strokes.push({ a: toWorld(x0, y), b: toWorld(x1, y), ...(typeof c.color === 'number' ? { color: c.color } : {}), ...(c.trueColor !== undefined ? { trueColor: c.trueColor } : {}) });
  };
  lines.forEach((line, i) => {
    baseline -= i === 0 ? line.height : line.height * spacing;
    const slack = boxW - line.width;
    let x = boxLeft + (line.align === 'center' ? slack / 2 : line.align === 'right' ? slack : 0);
    const gaps = line.frags.filter((f) => f.space).length;
    const extra = line.align === 'justify' && gaps > 0 && i < lines.length - 1 && m.width > 0 ? slack / gaps : 0;
    for (const f of line.frags) {
      const s = f.style;
      const h = s.height;
      const w = f.width + (f.space ? extra : 0);
      if (f.kind === 'text') {
        piece(f.text, x, baseline, s, h);
      } else {
        const sh = h * STACK_SCALE;
        const wt = measure(f.top ?? '', sh) * s.widthFactor;
        const wb = measure(f.bottom ?? '', sh) * s.widthFactor;
        if (f.stackType === '/') {
          const bar = baseline + h * 0.5;
          piece(f.top ?? '', x + (f.width - wt) / 2, bar + h * 0.1, s, sh);
          piece(f.bottom ?? '', x + (f.width - wb) / 2, bar - h * 0.1 - sh, s, sh);
          stroke(x, x + f.width, bar, s);
        } else if (f.stackType === '#') {
          piece(f.top ?? '', x, baseline + h * 0.45, s, sh);
          const sx = x + wt;
          const c = color(s);
          strokes.push({ a: toWorld(sx, baseline), b: toWorld(sx + h * 0.3, baseline + h), ...(typeof c.color === 'number' ? { color: c.color } : {}), ...(c.trueColor !== undefined ? { trueColor: c.trueColor } : {}) });
          piece(f.bottom ?? '', sx + h * 0.3, baseline, s, sh);
        } else {
          piece(f.top ?? '', x, baseline + h * 0.55, s, sh);
          piece(f.bottom ?? '', x, baseline - h * 0.25, s, sh);
        }
      }
      if (s.underline) stroke(x, x + w, baseline - h * 0.2, s);
      if (s.overline) stroke(x, x + w, baseline + h * 1.2, s);
      if (s.strike) stroke(x, x + w, baseline + h * 0.45, s);
      x += w;
    }
  });
  return { texts, strokes };
}
