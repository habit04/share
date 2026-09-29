import { describe, it, expect } from 'vitest';
import { readDxf, writeDxf } from '../src/io/dxf';
import { textStylesOf, textStyleOf, textStyleFromGroups, isPlainStandard, STANDARD_TEXT_STYLE, withTextStyle } from '../src/io/encoding';
import { textRenderer, drawStyledText, fontStack, fontWeight, canvasFont, setTextStyles, isTrueTypeStyle, CAP_HEIGHT_EM, type TextCanvas } from '../src/render/hershey';
import type { TextEntity, MTextEntity } from '../src/core/entities';
import { drawEntity } from '../src/render/draw';

const style = (name: string, font: string, extra: string[] = []) => ['0', 'STYLE', '2', name, '70', '0', '40', '0', '41', '1', '50', '0', '71', '0', '42', '0.2', '3', font, '4', '', ...extra];

const DXF = [
  '0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'STYLE', '70', '4',
  ...style('Standard', 'txt'),
  ...style('ARIAL', 'arial.ttf'),
  ...style('ROMANS', 'romans.shx'),
  ...['0', 'STYLE', '2', 'NARROW', '70', '0', '40', '0', '41', '0.8', '50', '15', '71', '0', '42', '0.2', '3', 'arialbi.ttf', '4', ''],
  ...style('TITLE', '', ['1001', 'ACAD', '1000', 'Segoe UI', '1071', String(0x2000000 | 0x22)]),
  '0', 'ENDTAB', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES',
  '0', 'TEXT', '8', '0', '10', '1', '20', '2', '40', '0.2', '1', 'Motor 1', '7', 'ARIAL',
  '0', 'TEXT', '8', '0', '10', '1', '20', '3', '40', '0.2', '1', 'Plain', '7', 'Standard',
  '0', 'MTEXT', '8', '0', '10', '0', '20', '0', '40', '0.25', '41', '4', '1', 'Title block', '7', 'TITLE',
  '0', 'ENDSEC', '0', 'EOF',
].join('\n');

describe('STYLE table', () => {
  const state = readDxf(DXF);
  const styles = textStylesOf(state);

  it('reads font file, big font, flags, height, width factor, oblique and TrueType XDATA', () => {
    expect(Object.keys(styles).sort()).toEqual(['ARIAL', 'NARROW', 'ROMANS', 'Standard', 'TITLE']);
    expect(styles.ARIAL!.font).toBe('arial.ttf');
    expect(styles.NARROW).toMatchObject({ widthFactor: 0.8, oblique: 15, font: 'arialbi.ttf' });
    expect(styles.TITLE).toMatchObject({ family: 'Segoe UI', bold: true });
    expect(styles.TITLE!.italic).toBeUndefined();
    expect(isPlainStandard(styles.Standard!)).toBe(true);
    expect(textStyleFromGroups([{ code: 2, value: 'SHAPES' }, { code: 70, value: '1' }])).toBeNull();
  });

  it('keeps the style name on TEXT and MTEXT (Standard is implicit)', () => {
    const texts = state.entities.filter((e): e is TextEntity => e.type === 'text');
    expect(texts.map((t) => textStyleOf(t))).toEqual(['ARIAL', undefined]);
    const m = state.entities.find((e): e is MTextEntity => e.type === 'mtext')!;
    expect(textStyleOf(m)).toBe('TITLE');
    expect(withTextStyle(texts[1]!, 'STANDARD')).toBe(texts[1]);
  });

  it('writes the STYLE table and group 7 back', () => {
    const out = writeDxf(state);
    expect(out).toMatch(/STYLE\r\n5\r\n[0-9A-F]+\r\n330\r\n3\r\n100\r\nAcDbSymbolTableRecord\r\n100\r\nAcDbTextStyleTableRecord\r\n2\r\nARIAL\r\n70\r\n0\r\n/);
    expect(out).toContain('3\r\narial.ttf');
    expect(out).toContain('1000\r\nSegoe UI');
    const back = readDxf(out);
    expect(textStylesOf(back)).toEqual(styles);
    expect(back.entities.map((e) => textStyleOf(e))).toEqual(['ARIAL', undefined, 'TITLE']);
    // A drawing without styles still writes exactly one Standard record and no meta appears on reading.
    const plain = readDxf(writeDxf({ entities: [], layers: state.layers, blocks: {}, currentLayer: '0' }));
    expect(plain.meta).toBeUndefined();
    expect(STANDARD_TEXT_STYLE.font).toBe('txt');
  });
});

describe('TrueType text rendering hook', () => {
  const styles = textStylesOf(readDxf(DXF));

  it('maps .ttf styles to a canvas font stack and SHX fonts to the Hershey strokes', () => {
    expect(textRenderer('ARIAL', styles)).toMatchObject({ kind: 'canvas', bold: false, italic: false });
    expect(textRenderer('arial', styles).kind).toBe('canvas'); // style names ignore case
    expect(textRenderer('ROMANS', styles).kind).toBe('stroke');
    expect(textRenderer(undefined, styles).kind).toBe('stroke');
    expect(textRenderer('MISSING', styles).kind).toBe('stroke');
    const narrow = textRenderer('NARROW', styles);
    expect(narrow).toMatchObject({ kind: 'canvas', bold: true, italic: true, widthFactor: 0.8 });
    expect(narrow.oblique).toBeCloseTo((15 * Math.PI) / 180);
    expect(fontStack({ font: 'arial.ttf' })).toMatch(/^Arial, "Liberation Sans"/);
    expect(fontStack({ font: 'times.ttf' })).toContain('"Liberation Serif"');
    expect(fontStack({ font: 'foo bar.ttf' })).toMatch(/^"foo bar", Arial/);
    expect(fontStack({ font: '', family: 'Segoe UI' })).toMatch(/^"Segoe UI"/);
    expect(fontWeight({ font: 'arialbd.ttf' })).toEqual({ bold: true, italic: false });
    expect(fontWeight({ font: 'ariali.ttf' })).toEqual({ bold: false, italic: true });
    expect(isTrueTypeStyle({ font: 'isocp.shx' })).toBe(false);
  });

  it('draws with the font sized to the cap height and falls back for SHX', () => {
    setTextStyles(styles);
    const calls: string[] = [];
    const ctx: TextCanvas = {
      save: () => calls.push('save'),
      restore: () => calls.push('restore'),
      translate: (x, y) => calls.push(`translate ${x} ${y}`),
      rotate: (a) => calls.push(`rotate ${a}`),
      transform: () => calls.push('transform'),
      scale: (x, y) => calls.push(`scale ${x} ${y}`),
      fillText: (t) => calls.push(`fill ${t} ${ctx.font}`),
      font: '',
      textAlign: 'left',
      textBaseline: 'alphabetic',
    };
    const tf = { scale: 100, toScreen: (p: { x: number; y: number }) => ({ x: p.x * 100, y: 500 - p.y * 100 }) };
    const e = { position: { x: 1, y: 2 }, text: '%%c10', height: 0.2, rotation: 0, align: 'left' as const, style: 'ARIAL' };
    expect(drawStyledText(ctx, e, tf)).toBe(true);
    expect(calls).toContain('translate 100 300');
    const px = Number((20 / CAP_HEIGHT_EM).toFixed(2));
    expect(calls.find((c) => c.startsWith('fill'))).toBe(`fill ⌀10 ${px}px Arial, "Liberation Sans", Arimo, Helvetica, sans-serif`);
    calls.length = 0;
    expect(drawStyledText(ctx, { ...e, style: 'ROMANS' }, tf)).toBe(false);
    expect(calls).toEqual([]);
    expect(drawStyledText(ctx, { ...e, style: 'NARROW' }, tf)).toBe(true);
    expect(calls).toContain('scale 0.8 1');
    expect(calls).toContain('transform');
    expect(canvasFont({ kind: 'canvas', family: 'Arial', bold: true, italic: true, widthFactor: 1, oblique: 0 }, 7.16)).toBe('italic bold 10px Arial');
    setTextStyles({});
  });
});

describe('canvas drawing of styled text', () => {
  /** A 2D context that records fillText calls with the font in effect and accepts every other call. */
  const recorder = () => {
    const fills: string[] = [];
    let strokes = 0;
    const state: Record<string, unknown> = { font: '', lineWidth: 1 };
    const ctx = new Proxy(state, {
      get: (t, k: string) => {
        if (k in t) return t[k];
        if (k === 'fillText') return (text: string) => fills.push(`${text} | ${String(t.font)}`);
        if (k === 'stroke') return () => void (strokes += 1);
        return () => {};
      },
      set: (t, k: string, v) => {
        t[k] = v;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, fills, strokes: () => strokes };
  };
  const tf = { scale: 100, toScreen: (p: { x: number; y: number }) => ({ x: p.x * 100, y: 500 - p.y * 100 }) };
  const styles = readDxf(DXF);

  it('draws TEXT with a TrueType style in the canvas font and SHX styles with strokes', () => {
    setTextStyles(textStylesOf(styles));
    const t: TextEntity = { id: 't', layer: '0', color: 7, type: 'text', position: { x: 0, y: 0 }, text: 'Motor', height: 0.2, rotation: 0, align: 'left' };
    const r = recorder();
    drawEntity(r.ctx, withTextStyle(t, 'ARIAL'), tf, styles.layers, () => undefined);
    expect(r.fills).toEqual([`Motor | ${Number((20 / CAP_HEIGHT_EM).toFixed(2))}px Arial, "Liberation Sans", Arimo, Helvetica, sans-serif`]);
    const shx = recorder();
    drawEntity(shx.ctx, withTextStyle(t, 'ROMANS'), tf, styles.layers, () => undefined);
    expect(shx.fills).toEqual([]);
    expect(shx.strokes()).toBeGreaterThan(0);
    setTextStyles({});
  });

  it('applies the MTEXT style to formatted runs too', () => {
    setTextStyles(textStylesOf(styles));
    const m = withTextStyle<MTextEntity>(
      { id: 'm', layer: '0', color: 7, type: 'mtext', position: { x: 0, y: 1 }, text: 'plain red', raw: 'plain {\\C1;red}', height: 0.2, rotation: 0, width: 0, attachment: 1 },
      'ARIAL',
    );
    const r = recorder();
    drawEntity(r.ctx, m, tf, styles.layers, () => undefined);
    expect(r.fills.map((f) => f.split(' | ')[0])).toEqual(['plain', 'red']);
    expect(r.fills.every((f) => f.includes('Arial'))).toBe(true);
    setTextStyles({});
  });
});
