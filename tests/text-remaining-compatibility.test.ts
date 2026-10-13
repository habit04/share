import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Drawing } from '../src/core/document';
import type { MTextEntity } from '../src/core/entities';
import { mtextFromDxf, mtextLayoutFull } from '../src/core/mtext';
import { readDxf, writeDxf } from '../src/io/dxf';
import { drawStyledText, setTextStyles, type TextCanvas } from '../src/render/hershey';

const measure = (text: string, height: number) => text.length * height;
const mt = (raw: string, width = 10): MTextEntity => ({
  id: 'm', layer: '0', color: 'ByLayer', type: 'mtext', position: { x: 0, y: 0 },
  text: mtextFromDxf(raw), raw, height: 1, width, rotation: 0, attachment: 1, lineSpacing: 1,
});

describe('remaining MTEXT paragraph compatibility', () => {
  it('keeps the last line of every justified paragraph at its natural spacing', () => {
    const layout = mtextLayoutFull(mt('\\pxqj;a b\\Pa b'), measure);
    expect(layout.texts.map((t) => [t.text, t.position.x])).toEqual([['a', 0], ['b', 2], ['a', 0], ['b', 2]]);
  });

  it('justifies wrapped lines independently while leaving each paragraph end unexpanded', () => {
    const layout = mtextLayoutFull(mt('\\pxqj;aa bb cc dd\\Pee ff gg hh', 6), measure);
    expect(layout.texts.map((t) => [t.text, t.position.x])).toEqual([
      ['aa', 0], ['bb', 4], ['cc', 0], ['dd', 3],
      ['ee', 0], ['ff', 4], ['gg', 0], ['hh', 3],
    ]);
    expect(new Set(layout.texts.map((t) => t.position.y)).size).toBe(4);
  });

  it('never compresses oversized lines into negative justification spacing', () => {
    const layout = mtextLayoutFull(mt('\\pxqj;  abcdef z', 4), measure);
    expect(layout.texts.map((t) => [t.text, t.position.x])).toEqual([['abcdef', 2], ['z', 0]]);
  });

  it('ignores trailing spaces for wrapping without creating extra baselines', () => {
    const layout = mtextLayoutFull(mt('\\pxqj;aa bb     \\Pcc', 5), measure);
    expect(layout.texts.map((t) => t.text)).toEqual(['aa', 'bb', 'cc']);
    expect(new Set(layout.texts.map((t) => t.position.y)).size).toBe(2);
    expect(layout.texts[2]!.position.y - layout.texts[0]!.position.y).toBeCloseTo(-5 / 3);
  });

  it('preserves formatting and corrected paragraph layout after a fixture edit, undo/redo and DXF reopen', () => {
    const state = readDxf(readFileSync(new URL('./fixtures/interchange/r2018-mtext.dxf', import.meta.url), 'utf8'));
    const original = state.entities.find((e): e is MTextEntity => e.type === 'mtext')!;
    expect(original).toBeDefined();
    const drawing = new Drawing();
    drawing.load(state);
    const raw = '\\pxqj;aa bb cc dd\\Pee ff gg hh';
    drawing.replaceEntities([{ ...original, raw, text: mtextFromDxf(raw), width: 6, height: 1 }]);
    expect(drawing.dirty).toBe(true);
    drawing.undo();
    expect((drawing.entity(original.id) as MTextEntity).raw).toBe(original.raw);
    drawing.redo();
    const edited = drawing.entity(original.id) as MTextEntity;
    const reopened = readDxf(writeDxf(drawing.snapshot)).entities.find((e): e is MTextEntity => e.type === 'mtext' && e.raw === raw)!;
    expect(reopened).toBeDefined();
    const signature = (m: MTextEntity) => mtextLayoutFull(m, measure).texts.map((t) => ({ text: t.text, position: t.position, height: t.height }));
    expect(signature(reopened)).toEqual(signature(edited));
    expect(reopened.raw).toBe(raw);
  });
});

describe('explicit defaults on styled Canvas TEXT', () => {
  afterEach(() => setTextStyles({}));

  const recorder = () => {
    const calls: Array<{ kind: string; values: number[] }> = [];
    const ctx: TextCanvas = {
      save: () => {}, restore: () => {}, translate: (x, y) => calls.push({ kind: 'translate', values: [x, y] }), rotate: () => {},
      transform: (...values) => calls.push({ kind: 'transform', values }),
      scale: (...values) => calls.push({ kind: 'scale', values }), fillText: () => {}, measureText: () => ({ width: 100 }),
      font: '', textAlign: 'left', textBaseline: 'alphabetic',
    };
    return { ctx, calls };
  };
  const tf = { scale: 10, toScreen: (p: { x: number; y: number }) => p };
  const text = { position: { x: 0, y: 0 }, text: 'ab', height: 1, rotation: 0, align: 'left' as const, style: 'NARROW' };
  const styles = { NARROW: { name: 'NARROW', font: 'arial.ttf', bigFont: '', height: 0, widthFactor: 0.5, oblique: 15, flags: 0, generation: 0 } };

  it('lets explicit widthFactor=1 and oblique=0 override nondefault STYLE values', () => {
    setTextStyles(styles);
    const { ctx, calls } = recorder();
    expect(drawStyledText(ctx, { ...text, widthFactor: 1, oblique: 0 }, tf)).toBe(true);
    expect(calls.filter((c) => c.kind === 'scale' || c.kind === 'transform')).toEqual([]);
  });

  it('continues inheriting STYLE values when entity overrides are absent', () => {
    setTextStyles(styles);
    const { ctx, calls } = recorder();
    expect(drawStyledText(ctx, text, tf)).toBe(true);
    expect(calls.find((c) => c.kind === 'scale')!.values).toEqual([0.5, 1]);
    expect(calls.find((c) => c.kind === 'transform')!.values[2]).toBeCloseTo(-Math.tan(Math.PI / 12));
  });
});
