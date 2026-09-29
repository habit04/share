import { describe, it, expect } from 'vitest';
import type { MTextEntity, TextEntity } from '../src/core/entities';
import { mtextParts, mtextDecorations, entityBounds, textWidth } from '../src/core/entities';
import { parseMText, mtextFromDxf, mtextLayoutFull, formattedSource, hasFormatting, type MTextItem } from '../src/core/mtext';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';

const props = { layer: '0', color: 'ByLayer' as const };
const texts = (raw: string) => parseMText(raw, 1).flatMap((p) => p.items).filter((i): i is Extract<MTextItem, { kind: 'text' }> => i.kind === 'text');
const mt = (raw: string, over: Partial<MTextEntity> = {}): MTextEntity => ({ id: 'm', ...props, type: 'mtext', position: { x: 0, y: 0 }, text: mtextFromDxf(raw), raw, height: 1, width: 0, rotation: 0, attachment: 1, lineSpacing: 1, ...over });

describe('MTEXT format codes (parser)', () => {
  it('\\C colour index and \\c true colour (BGR order)', () => {
    const [a, b, c] = texts('{\\C1;red}{\\c16711680;blue}plain');
    expect(a!.style.color).toBe(1);
    expect(b!.style.trueColor).toBe(0x0000ff);
    expect(c!.style.color).toBeUndefined();
    expect(texts('\\C256;x')[0]!.style.color).toBeUndefined(); // ByLayer
  });
  it('\\H absolute and relative (x suffix) height', () => {
    const t = texts('a\\H2.5;b\\H0.5x;c');
    expect(t.map((x) => x.style.height)).toEqual([1, 2.5, 1.25]);
  });
  it('\\W width factor and \\Q oblique angle', () => {
    const [, w, q] = texts('a\\W0.8;b\\Q15;c');
    expect(w!.style.widthFactor).toBe(0.8);
    expect(q!.style.oblique).toBeCloseTo((15 * Math.PI) / 180);
  });
  it('\\L..\\l underline, \\O..\\o overline, \\K..\\k strike-through', () => {
    const t = texts('\\Lu\\l \\Oo\\o \\Kk\\k');
    expect(t.find((x) => x.text === 'u')!.style.underline).toBe(true);
    expect(t.find((x) => x.text === 'o')!.style.overline).toBe(true);
    expect(t.find((x) => x.text === 'k')!.style.strike).toBe(true);
    expect(t.find((x) => x.text === ' ')!.style.underline).toBe(false);
  });
  it('\\S stacking with ^, / and #', () => {
    const items = parseMText('1\\S1/2; \\S+0.1^-0.1; \\S3#4;', 1)[0]!.items;
    const stacks = items.filter((i) => i.kind === 'stack');
    expect(stacks.map((s) => s.kind === 'stack' && [s.top, s.bottom, s.type])).toEqual([
      ['1', '2', '/'],
      ['+0.1', '-0.1', '^'],
      ['3', '4', '#'],
    ]);
    expect(mtextFromDxf('1\\S1/2;')).toBe('11/2');
  });
  it('\\f keeps bold / italic and ignores the font', () => {
    const [b, i] = texts('{\\fArial|b1|i0|c0|p34;B}{\\fTimes|b0|i1;I}');
    expect(b!.style.bold).toBe(true);
    expect(b!.style.italic).toBe(false);
    expect(i!.style.italic).toBe(true);
  });
  it('\\pxqc / \\pxql / \\pxqr paragraph alignment', () => {
    const paras = parseMText('\\pxqc;centred\\P\\pxqr;right\\P\\pxql;left', 1);
    expect(paras.map((p) => p.align)).toEqual(['center', 'right', 'left']);
  });
  it('\\~ non-breaking space, \\\\ \\{ \\} escapes and \\U+ unicode', () => {
    expect(mtextFromDxf('a\\~b')).toBe('a b');
    expect(texts('a\\~b')[0]!.text).toBe('a\u00a0b');
    expect(mtextFromDxf('C:\\\\dir \\{x\\}')).toBe('C:\\dir {x}');
    expect(mtextFromDxf('\\U+00B0C \\U+2205')).toBe('\u00b0C \u2205');
  });
  it('%%d %%p %%c stay for the stroke font; %%u / %%o toggle underline / overline', () => {
    expect(mtextFromDxf('45%%d %%p0.1 %%c10')).toBe('45%%d %%p0.1 %%c10');
    const t = texts('%%uU%%u n %%oO');
    expect(t[0]!.style.underline).toBe(true);
    expect(t[1]!.style.underline).toBe(false);
    expect(t[2]!.style.overline).toBe(true);
    expect(mtextFromDxf('%%uU%%u')).toBe('U');
    expect(mtextFromDxf('%%065')).toBe('A');
  });
  it('strips unknown codes and alignment / tracking codes from plain text', () => {
    expect(mtextFromDxf('\\A1;\\T1.1;x\\Zfoo;y')).toBe('xy');
    expect(mtextFromDxf('{\\fArial|b0;Hello}\\PWorld')).toBe('Hello\nWorld');
    expect(hasFormatting('plain\\Ptext')).toBe(false);
    expect(hasFormatting('{\\C1;x}')).toBe(true);
  });
});

describe('MTEXT formatted layout', () => {
  it('colours, heights and width factors reach the text pieces', () => {
    const parts = mtextParts(mt('{\\C1;R}\\H2;{\\W0.5;W}'));
    expect(parts.map((p) => p.text)).toEqual(['R', 'W']);
    expect(parts[0]!.color).toBe(1);
    expect(parts[1]!.height).toBe(2);
    expect(parts[1]!.widthFactor).toBe(0.5);
    // The second run starts after the first one's width.
    expect(parts[1]!.position.x).toBeCloseTo(textWidth('R', 1));
  });
  it('underline / overline / strike make decoration strokes; stacks draw a fraction bar', () => {
    expect(mtextDecorations(mt('\\LU\\l'))).toHaveLength(1);
    expect(mtextDecorations(mt('\\Kk\\k \\Oo\\o'))).toHaveLength(2);
    const frac = mt('1\\S1/2;');
    const lay = mtextLayoutFull(frac, textWidth);
    expect(lay.texts.map((t) => t.text)).toEqual(['1', '1', '2']);
    expect(lay.texts[1]!.height).toBeCloseTo(0.7);
    expect(lay.texts[1]!.position.y).toBeGreaterThan(lay.texts[2]!.position.y);
    expect(lay.strokes).toHaveLength(1);
  });
  it('paragraph alignment positions lines inside the reference width', () => {
    const m = mt('\\pxqr;ab', { width: 10 });
    const [p] = mtextParts(m) as [TextEntity];
    expect(p.position.x + textWidth('ab', 1)).toBeCloseTo(10);
    const c = mtextParts(mt('\\pxqc;ab', { width: 10 }))[0]!;
    expect(c.position.x + textWidth('ab', 1) / 2).toBeCloseTo(5);
  });
  it('wraps words across runs and keeps a non-breaking space together', () => {
    const parts = mtextParts(mt('aaa{\\C1;bbb} ccc ddd', { width: textWidth('aaabbb ccc', 1) + 0.01 }));
    const ys = [...new Set(parts.map((p) => p.position.y.toFixed(4)))];
    expect(ys).toHaveLength(2);
    const nb = mtextParts(mt('xx\\~yy zz', { width: textWidth('xx yy', 1) + 0.01 }));
    expect(nb[0]!.text).toBe('xx yy');
  });
  it('stale formatting (text edited elsewhere) falls back to the plain layout', () => {
    const m = mt('{\\C1;R}');
    expect(formattedSource(m)).toBe('{\\C1;R}');
    const edited = { ...m, text: 'changed' };
    expect(formattedSource(edited)).toBeNull();
    expect(mtextParts(edited)[0]!.text).toBe('changed');
    expect(entityBounds(m, () => undefined)).not.toBeNull();
  });
});

describe('MTEXT codes in DXF', () => {
  it('keeps the formatted content on read and writes it back while it matches', () => {
    const raw = '{\\C1;\\LWARNING\\l}\\P\\H0.5x;1\\S1/2; in';
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'MTEXT', '8', '0', '10', '0', '20', '0', '40', '0.2', '41', '5', '71', '1', '1', raw, '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const m = readDxf(dxf).entities[0] as MTextEntity;
    expect(m.text).toBe('WARNING\n11/2 in');
    expect(m.raw).toBe(raw);
    const out = writeDxf({ ...new Drawing().snapshot, entities: [m] });
    expect(out).toContain(raw);
    // Edited text: the formatting is dropped and the new text written.
    const out2 = writeDxf({ ...new Drawing().snapshot, entities: [{ ...m, text: 'SAFE' }] });
    expect(out2).not.toContain('WARNING');
    expect(out2).toContain('\r\n1\r\nSAFE\r\n');
  });
  it('TEXT width factor (41) and oblique angle (51) round-trip', () => {
    const t: TextEntity = { id: 't', ...props, type: 'text', position: { x: 1, y: 1 }, text: 'NARROW', height: 0.2, rotation: 0, align: 'left', widthFactor: 0.7, oblique: (15 * Math.PI) / 180 };
    const back = readDxf(writeDxf({ ...new Drawing().snapshot, entities: [t] })).entities[0] as TextEntity;
    expect(back.widthFactor).toBeCloseTo(0.7);
    expect(back.oblique).toBeCloseTo((15 * Math.PI) / 180);
  });
  it('true colour (420) round-trips on any entity', () => {
    const d = new Drawing();
    d.addEntities([{ id: 'l', ...props, type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, trueColor: 0x3366cc }]);
    const back = readDxf(writeDxf(d.snapshot)).entities[0]!;
    expect(back.trueColor).toBe(0x3366cc);
  });
});
