import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Drawing } from '../src/core/document';
import { entityBounds, mtextDecorations, mtextParts, textBounds, type BlockLookup } from '../src/core/entities';
import { mtextFromDxf, type MTextEntity } from '../src/core/mtext';
import type { NativeFontMetrics, TextGeometryContext } from '../src/core/text-metrics';
import { readDxf, writeDxf } from '../src/io/dxf';
import { textStylesOf } from '../src/io/encoding';
import { FontMetricsRegistry, createTextGeometryContext } from '../src/render/font-metrics';

const mt = (raw: string, patch: Partial<MTextEntity> = {}): MTextEntity => ({ id: 'm', type: 'mtext', layer: '0', color: 'ByLayer', text: mtextFromDxf(raw), raw, position: { x: 0, y: 0 }, height: 10, width: 0, rotation: 0, attachment: 1, lineSpacing: 1, style: 'FACE', ...patch });
const lookup = (textGeometry: TextGeometryContext): BlockLookup => Object.assign(() => undefined, { textGeometry });

/** Independently authored glyph boxes: always-on coverage, not a native-font substitute. */
function syntheticContext(): TextGeometryContext {
  const glyphs: Record<string, readonly [number, number, number, number, number]> = {
    H: [10, 1, 8, 10, 0], g: [8, -0.5, 7, 7, 3], i: [5, 0.5, 4, 11, 0],
    R: [10, -2, 12, 10, 0], d: [8, 0, 8, 6, 30], ' ': [3, 0, 0, 0, 0],
  };
  return {
    cacheKey: {},
    resolve: (input) => ({ kind: 'canvas', family: 'Test', bold: !!input.bold, italic: false, widthFactor: input.widthFactor ?? 1, oblique: input.oblique ?? 0 }),
    measure(text, height, appearance) {
      const scale = height / 10, weight = appearance.kind === 'canvas' && appearance.bold ? 2 : 1;
      let advance = 0, left = Infinity, right = -Infinity, ascent = -Infinity, descent = -Infinity;
      for (const character of text) {
        const [step, l, r, a, d] = glyphs[character] ?? glyphs.H!;
        if (character !== ' ') { left = Math.min(left, advance + l * scale); right = Math.max(right, advance + r * scale); ascent = Math.max(ascent, a * scale); descent = Math.max(descent, d * scale); }
        advance += step * scale * weight;
      }
      return Number.isFinite(left) ? { advance, left, right, ascent, descent } : { advance, left: 0, right: 0, ascent: 0, descent: 0 };
    },
  };
}

describe('MTEXT ink attachment and wrap with authored glyph bounds', () => {
  const attachments = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;
  it.each(attachments)('positions each line ink and final descender at attachment %i', (attachment) => {
    const ctx = syntheticContext(), m = mt('H\\Pg', { attachment, width: 60 });
    const parts = mtextParts(m, ctx), row = Math.floor((attachment - 1) / 3), col = (attachment - 1) % 3;
    const H = 10 + 50 / 3 + 3, shift = row === 0 ? 0 : row === 1 ? H / 2 : H;
    expect(parts.map((p) => p.text)).toEqual(['H', 'g']);
    expect(parts[0]!.position.y).toBeCloseTo(shift - 10);
    expect(parts[1]!.position.y).toBeCloseTo(shift - 10 - 50 / 3);
    for (const part of parts) {
      const bounds = textBounds(part, ctx);
      expect(col === 0 ? bounds.min.x : col === 1 ? (bounds.min.x + bounds.max.x) / 2 : bounds.max.x).toBeCloseTo(0);
    }
    const bounds = entityBounds(m, lookup(ctx))!;
    expect(bounds.max.y).toBeCloseTo(shift); expect(bounds.min.y).toBeCloseTo(shift - H);
    // Formatting with an otherwise identical run must keep the same attachment geometry.
    expect(mtextParts(mt('\\C1;H\\Pg', { attachment, width: 60 }), ctx).map((p) => p.position)).toEqual(parts.map((p) => p.position));
    expect(m.position).toEqual({ x: 0, y: 0 }); expect(m.raw).toBe('H\\Pg');
  });

  it('uses actual first-line ascent and lowest ink, while blank paragraphs retain nominal advances', () => {
    const ctx = syntheticContext(), tall = mtextParts(mt('i\\Pg'), ctx);
    expect(tall[0]!.position.y).toBeCloseTo(-11); expect(textBounds(tall[0]!, ctx).max.y).toBeCloseTo(0);
    const earlyDescender = entityBounds(mt('d\\PH', { attachment: 7 }), lookup(ctx))!;
    expect(earlyDescender.min.y).toBeCloseTo(0); expect(earlyDescender.max.y).toBeCloseTo(36);
    const blank = mtextParts(mt('H\\P\\Pg', { raw: undefined }), ctx);
    expect(blank.map((p) => p.text)).toEqual(['H', '', 'g']);
    expect(blank[2]!.position.y - blank[0]!.position.y).toBeCloseTo(-100 / 3);
  });

  it('wraps by candidate ink span without replacing pen advances or splitting oversized words', () => {
    const ctx = syntheticContext();
    expect(mtextParts(mt('H H H H', { width: 46 }), ctx).map((p) => p.text)).toEqual(['H H H H']);
    expect(mtextParts(mt('H H H H', { width: 45 }), ctx).map((p) => p.text)).toEqual(['H H H', 'H']);
    expect(mtextParts(mt('R R', { width: 26 }), ctx).map((p) => p.text)).toEqual(['R', 'R']);
    expect(mtextParts(mt('HHHH H', { width: 20 }), ctx).map((p) => p.text)).toEqual(['HHHH', 'H']);
    const formatted = mtextParts(mt('\\C1;H H H H', { width: 46 }), ctx);
    expect(new Set(formatted.map((p) => p.position.y)).size).toBe(1);
    expect(formatted.map((p) => p.position.x)).toEqual([-1, 12, 25, 38]);
  });

  it.each(['qc', 'qr'] as const)('fits explicit %s paragraph ink inside the reference width', (alignment) => {
    const ctx = syntheticContext();
    for (const attachment of attachments) {
      const m = mt(`\\p${alignment};H\\Pg`, { attachment, width: 60 }), parts = mtextParts(m, ctx);
      const col = (attachment - 1) % 3, left = col === 0 ? 0 : col === 1 ? -30 : -60;
      for (const part of parts) {
        const bounds = textBounds(part, ctx);
        expect(alignment === 'qc' ? (bounds.min.x + bounds.max.x) / 2 : bounds.max.x).toBeCloseTo(left + (alignment === 'qc' ? 30 : 60));
      }
    }
  });

  it('keeps mixed-run advances, bold wrapping, fraction children and decorations together', () => {
    const ctx = syntheticContext(), m = mt('H{\\W2;H}{\\fTest|b1;H}', { attachment: 5 });
    const parts = mtextParts(m, ctx);
    expect(parts[1]!.position.x - parts[0]!.position.x).toBeCloseTo(10);
    expect(parts[2]!.position.x - parts[1]!.position.x).toBeCloseTo(20);
    expect(parts.map((p) => p.widthFactor)).toEqual([undefined, 2, undefined]);
    expect(parts[2]!.bold).toBe(true);
    const wrapped = mtextParts(mt('H {\\fTest|b1;HH}', { width: 35 }), ctx);
    expect(new Set(wrapped.map((p) => p.position.y)).size).toBe(2);
    const fraction = mt('\\L\\Sg/H;\\l', { attachment: 9 }), children = mtextParts(fraction, ctx), strokes = mtextDecorations(fraction, ctx);
    const allX = [...children.flatMap((p) => [textBounds(p, ctx).min.x, textBounds(p, ctx).max.x]), ...strokes.flatMap((p) => [p.a.x, p.b.x])];
    expect(Math.max(...allX)).toBeCloseTo(0);
    expect(Math.min(...children.map((p) => textBounds(p, ctx).min.y))).toBeCloseTo(0);
    expect(strokes).toHaveLength(2); expect(fraction.raw).toBe('\\L\\Sg/H;\\l');
  });
});

// AutoCAD 2027 synthetic plots, AUDIT 0. PDF origins are quantized by about 0.1 drawing
// units. Direct native evidence covers AP1/5/9; the remaining attachments above are synthetic.
const nativeBaselines = [
  ['ARIAL_ORACLE', 1, [-1.1832460733, -9.9721792890], [-0.4136125654, -26.6491499227]],
  ['ARIAL_ORACLE', 5, [-5.0549738220, 4.7805255023], [-3.6439790576, -11.8964451314]],
  ['ARIAL_ORACLE', 9, [-8.9371727749, 19.6136012365], [-6.7565445026, 2.9366306028]],
  ['COURIER_ORACLE', 1, [-0.8795811518, -10.0200927357], [-1.0078534031, -26.6970633694]],
  ['COURIER_ORACLE', 5, [-5.2643979058, 4.9891808346], [-5.3926701571, -11.6877897991]],
  ['COURIER_ORACLE', 9, [-9.6492146597, 19.9984544049], [-9.7774869110, 3.3214837713]],
  ['TIMES_ORACLE', 1, [-0.3089005236, -10.0200927357], [-0.4371727749, -26.6970633694]],
  ['TIMES_ORACLE', 5, [-5.2172774869, 4.9412673879], [-3.6780104712, -11.7357032457]],
  ['TIMES_ORACLE', 9, [-10.3717277487, 19.8222565688], [-7.0366492147, 3.1452859351]],
] as const;
const nativeTimesX = [
  ['default', 55, 1, -0.3429319372, -0.3429319372], ['default', 55, 5, -22.1727748691, -14.2198952880], ['default', 55, 9, -43.8743455497, -27.9685863874],
  ['default', 60, 1, -0.4136125654, -0.4136125654], ['default', 60, 5, -30.1963350785, -6.2094240838], ['default', 60, 9, -59.8612565445, -11.8874345550],
  ['qc', 55, 1, 5.2774869110, 13.3586387435], ['qc', 55, 5, -22.1963350785, -14.1151832461], ['qc', 55, 9, -49.6701570681, -41.7172774869],
  ['qc', 60, 1, -0.1806282723, 23.8062827225], ['qc', 60, 5, -30.1020942408, -6.1151832461], ['qc', 60, 9, -60.1413612565, -36.1544502618],
  ['qr', 55, 1, 11.0261780105, 27.0602094241], ['qr', 55, 5, -16.4476439791, -0.4136125654], ['qr', 55, 9, -43.9214659686, -28.0157068063],
  ['qr', 60, 1, 0.0418848168, 48.1439790576], ['qr', 60, 5, -29.8691099476, 18.1047120419], ['qr', 60, 9, -59.9083769634, -11.9345549738],
] as const;
const windowsFonts = join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts');
const installed = process.platform === 'win32' && ['arial.ttf', 'arialbd.ttf', 'cour.ttf', 'times.ttf'].every((file) => existsSync(join(windowsFonts, file)));
const require = createRequire(import.meta.url);
const { readWindowsFontMetrics } = require('../electron/font-metrics.cjs') as { readWindowsFontMetrics(input: { font: string; family?: string; bold?: boolean; italic?: boolean }): Promise<NativeFontMetrics> };

describe.runIf(installed)('installed Windows fonts against native MTEXT facts', () => {
  const state = readDxf(readFileSync(new URL('./fixtures/interchange/r2018-font-metrics.dxf', import.meta.url), 'utf8'));
  const registry = new FontMetricsRegistry(), ctx = createTextGeometryContext(textStylesOf(state), registry);
  beforeAll(async () => {
    registry.setReader(readWindowsFontMetrics);
    for (const style of ['ARIAL_ORACLE', 'ARIAL_BOLD_ORACLE', 'COURIER_ORACLE', 'TIMES_ORACLE']) ctx.resolve({ style });
    await registry.ready();
  });

  it.each(nativeBaselines)('matches %s H\\Pg attachment %i ink and nominal leading', (style, attachment, first, last) => {
    const parts = mtextParts(mt('H\\Pg', { style, attachment, width: 60 }), ctx);
    expect(parts.map((p) => p.text)).toEqual(['H', 'g']);
    for (const [part, reference] of [[parts[0]!, first], [parts[1]!, last]] as const) {
      expect(Math.abs(part.position.x - reference[0])).toBeLessThan(0.13);
      expect(Math.abs(part.position.y - reference[1])).toBeLessThan(0.13);
    }
    expect(parts[0]!.position.y - parts[1]!.position.y).toBeCloseTo(50 / 3);
  });

  it.each(nativeTimesX)('matches Times %s width%i attachment%i wrapping and horizontal origins', (paragraph, width, attachment, firstX, lastX) => {
    const raw = `${paragraph === 'default' ? '' : `\\p${paragraph};`}iii iii iii iii iii`;
    const parts = mtextParts(mt(raw, { style: 'TIMES_ORACLE', attachment, width }), ctx);
    const ys = [...new Set(parts.map((p) => p.position.y))];
    expect(ys).toHaveLength(2);
    const lines = ys.map((y) => parts.filter((p) => p.position.y === y));
    expect(lines.map((line) => line.map((p) => p.text).join(' '))).toEqual(width === 60 ? ['iii iii iii iii', 'iii'] : ['iii iii iii', 'iii iii']);
    expect(Math.abs(lines[0]![0]!.position.x - firstX)).toBeLessThan(0.13);
    expect(Math.abs(lines[1]![0]!.position.x - lastX)).toBeLessThan(0.13);
    // The native tall i has special leading; its vertical formula remains explicitly unclaimed.
  });

  it('matches committed native fixture wrapping for four faces and preserves edited data through undo/redo and DXF reopen', () => {
    const expected = { ARIAL_ORACLE: [4, 1], ARIAL_BOLD_ORACLE: [4, 1], COURIER_ORACLE: [1, 1, 1, 1, 1], TIMES_ORACLE: [4, 1] };
    for (const source of state.entities.filter((e): e is MTextEntity => e.type === 'mtext')) {
      expect(mtextParts(source, ctx).map((p) => p.text.split(' ').length)).toEqual(expected[source.style as keyof typeof expected]);
    }
    const drawing = new Drawing(state, () => ctx), original = drawing.entities.find((e): e is MTextEntity => e.type === 'mtext' && e.style === 'TIMES_ORACLE')!;
    const raw = '\\pqc;iii iii iii iii iii\\PH\\Pg';
    drawing.replaceEntities([{ ...original, raw, text: mtextFromDxf(raw), attachment: 5, width: 55 }]);
    expect(drawing.dirty).toBe(true); drawing.undo(); expect(drawing.entity(original.id)).toEqual(original); drawing.redo();
    const edited = drawing.entity(original.id) as MTextEntity, reopened = readDxf(writeDxf(drawing.snapshot));
    const saved = reopened.entities.find((e): e is MTextEntity => e.type === 'mtext' && e.raw === raw)!;
    expect(saved).toMatchObject({ raw, text: edited.text, style: edited.style, attachment: 5, width: 55 });
    const reopenedCtx = createTextGeometryContext(textStylesOf(reopened), registry);
    const signature = (m: MTextEntity, c: TextGeometryContext) => mtextParts(m, c).map((p) => ({ text: p.text, position: p.position, height: p.height, style: p.style, align: p.align }));
    expect(signature(saved, reopenedCtx)).toEqual(signature(edited, ctx));
    expect(new Drawing(reopened, () => reopenedCtx).dirty).toBe(false);
    expect(textStylesOf(reopened).TIMES_ORACLE).toEqual(textStylesOf(state).TIMES_ORACLE);
  });
});
