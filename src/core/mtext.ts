/**
 * Multi-line text (MTEXT): paragraphs, word wrap to a reference width, nine
 * attachment points and a line-spacing factor (1 = the 5/3 default).
 */
import type { Point } from './geometry';
import * as g from './geometry';
import type { EntityBase, TextEntity } from './entities';

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

/** Lay out an MTEXT into single-line TEXT pieces in world space. */
export function mtextLayout(m: MTextEntity, measure: Measure): TextEntity[] {
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
      type: 'text',
      position: g.add(m.position, g.rotate(local, m.rotation)),
      text,
      height: m.height,
      rotation: m.rotation,
      align,
    });
  });
  return out;
}

/** Convert our paragraphs to DXF MTEXT content (\P paragraph separator). */
export function mtextToDxf(text: string): string {
  return text.replace(/\n/g, '\\P');
}

/** Strip DXF MTEXT formatting codes, keeping paragraph breaks as '\n'. */
export function mtextFromDxf(raw: string): string {
  return raw
    .replace(/\\P/g, '\n')
    .replace(/\\~/g, ' ')
    .replace(/\\\\/g, '\u0001')
    .replace(/\{\\[A-Za-z][^;]*;([^}]*)\}/g, '$1')
    .replace(/\\[A-Za-z][^;\\]*;/g, '')
    .replace(/[{}]/g, '')
    .replace(/\u0001/g, '\\');
}
