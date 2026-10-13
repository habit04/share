import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Drawing } from '../src/core/document';
import { leaderParts, type LeaderEntity } from '../src/core/entities';
import { mtextFromDxf, mtextLayoutFull, type MTextEntity, type MTextColumns, type MTextAttachment } from '../src/core/mtext';
import { mtextBackgroundPolygons } from '../src/core/mtext-background';
import { readDxf, writeDxf } from '../src/io/dxf';

const measure = (text: string, height: number) => text.length * height;
const columns: MTextColumns = { type: 1, count: 2, width: 3, gutter: 2, autoHeight: false, reversed: false, heights: [3, 3] };
const mt = (raw: string, over: Partial<MTextEntity> = {}): MTextEntity => ({
  id: 'm', layer: '0', color: 'ByLayer', type: 'mtext', position: { x: 0, y: 0 },
  text: mtextFromDxf(raw), raw, height: 1, width: 3, rotation: 0, attachment: 1, lineSpacing: 1, columns, ...over,
});
const parts = (m: MTextEntity) => mtextLayoutFull(m, measure).texts;
const columnTexts = (m: MTextEntity, index: number) => parts(m).filter((t) => t.id.startsWith(`${m.id}:col${index}:`)).map((t) => t.text);

describe('declared-height MTEXT column flow', () => {
  it('flows wrapped lines through static heights without inserting breaks into the source', () => {
    const m = mt('a b c d e f g h');
    expect(columnTexts(m, 0)).toEqual(['a', 'b', 'c', 'd']);
    expect(columnTexts(m, 1)).toEqual(['e', 'f', 'g', 'h']);
    expect(parts(m).find((t) => t.text === 'e')!.position).toEqual({ x: 5, y: -1 });
    expect(m.raw).toBe('a b c d e f g h');
    expect(m.columns).toBe(columns);
  });

  it('uses each dynamic-manual column height in logical flow order', () => {
    const m = mt('A\\PB\\PC\\PD\\PE', { columns: { ...columns, type: 2, count: 3, heights: [1, 3, 3] } });
    expect([0, 1, 2].map((i) => columnTexts(m, i))).toEqual([['A'], ['B', 'C'], ['D', 'E']]);
    expect(parts(m).map((t) => t.position.x)).toEqual([0, 5, 5, 10, 10]);
  });

  it('keeps the height comparison relative to drawing units for very small text', () => {
    const m = mt('A\\PB\\PC\\PD', { height: 1e-12, columns: { ...columns, heights: [3e-12, 3e-12] } });
    expect(columnTexts(m, 0)).toEqual(['A', 'B']);
    expect(columnTexts(m, 1)).toEqual(['C', 'D']);
  });

  it('honors explicit breaks before filling the remaining height', () => {
    const m = mt('A\\NB\\PC');
    expect(columnTexts(m, 0)).toEqual(['A']);
    expect(columnTexts(m, 1)).toEqual(['B', 'C']);
  });

  it('counts blank paragraphs and line-spacing advances against the column height', () => {
    const blank = mt('A\\P\\PB');
    expect(columnTexts(blank, 0)).toEqual(['A']);
    expect(columnTexts(blank, 1)).toEqual(['B']);
    const spaced = mt('A\\PB\\PC', { lineSpacing: 2, columns: { ...columns, heights: [5, 5] } });
    expect(columnTexts(spaced, 0)).toEqual(['A', 'B']);
    expect(columnTexts(spaced, 1)).toEqual(['C']);
  });

  it('keeps oversized first lines whole and retains every excess line in the final column', () => {
    const m = mt('{\\H4;T}\\Pone\\Ptwo\\Pthree', { columns: { ...columns, width: 20, heights: [2, 2] } });
    expect(columnTexts(m, 0)).toEqual(['T']);
    expect(columnTexts(m, 1)).toEqual(['one', 'two', 'three']);
    expect(parts(m).find((t) => t.text === 'T')!.height).toBe(4);
    expect(parts(m).find((t) => t.text === 'one')!.position.y).toBe(-1);
  });

  it('keeps excess explicit-break content in the last declared column', () => {
    const m = mt('A\\NB\\NC\\ND');
    expect(columnTexts(m, 0)).toEqual(['A']);
    expect(columnTexts(m, 1)).toEqual(['B', 'C', 'D']);
  });

  it('reverses physical placement while retaining logical text order and mask IDs', () => {
    const m = mt('A\\PB\\PC\\PD', { columns: { ...columns, reversed: true } });
    expect(columnTexts(m, 0)).toEqual(['A', 'B']);
    expect(columnTexts(m, 1)).toEqual(['C', 'D']);
    expect(parts(m).map((t) => t.position.x)).toEqual([5, 5, 0, 0]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9] as MTextAttachment[])('aligns all columns to one content box at attachment %i', (attachment) => {
    const m = mt('A\\PB\\PC', { attachment });
    const rendered = parts(m);
    const row = Math.floor((attachment - 1) / 3), col = (attachment - 1) % 3;
    const height = 1 + 5 / 3;
    const top = row === 0 ? 0 : row === 1 ? height / 2 : height;
    const left = col === 0 ? 0 : col === 1 ? -4 : -8;
    expect(rendered[0]!.position.x).toBeCloseTo(left + col);
    expect(rendered[0]!.position.y).toBeCloseTo(top - 1);
    expect(rendered.find((t) => t.text === 'C')!.position.y).toBeCloseTo(top - 1);
  });

  it('rotates the full column positions around the attachment point', () => {
    const m = mt('A\\PB\\PC', { position: { x: 10, y: 20 }, rotation: Math.PI / 2 });
    const third = parts(m).find((t) => t.text === 'C')!;
    expect(third.position.x).toBeCloseTo(11);
    expect(third.position.y).toBeCloseTo(25);
  });

  it('keeps justification on a paragraph continued in another column', () => {
    const m = mt('\\pxqj;aa bb cc dd ee ff', { columns: { ...columns, count: 3, width: 6, heights: [1, 1, 1] } });
    expect(parts(m).map((t) => [t.text, t.position.x])).toEqual([['aa', 0], ['bb', 4], ['cc', 8], ['dd', 12], ['ee', 16], ['ff', 19]]);
  });

  it('carries scoped colors, fraction bars, decorations and separated masks through flow', () => {
    const m = mt('{\\C1;\\LRED\\P\\S1/2;\\l}\\Ptail', {
      columns: { ...columns, width: 10, heights: [1, 1] }, background: { flags: 1, scale: 1.5, color: 2 },
    });
    const layout = mtextLayoutFull(m, measure);
    expect(layout.texts.map((t) => [t.text, t.color])).toEqual([['RED', 1], ['1', 1], ['2', 1], ['tail', 'ByLayer']]);
    expect(layout.texts[0]!.id).toContain(':col0:');
    expect(layout.texts.slice(1).every((t) => t.id.includes(':col1:'))).toBe(true);
    expect(layout.strokes).toHaveLength(3);
    const masks = mtextBackgroundPolygons(m, measure, layout);
    expect(masks).toHaveLength(2);
    expect(Math.max(...masks[0]!.map((p) => p.x))).toBeLessThanOrEqual(10);
    expect(Math.min(...masks[1]!.map((p) => p.x))).toBeGreaterThanOrEqual(12);
  });

  it.each([
    { ...columns, autoHeight: true },
    { ...columns, heights: [] },
    { ...columns, heights: [3] },
    { ...columns, heights: [0, 3] },
  ])('preserves the explicit-break fallback when declared heights cannot drive flow: %j', (fallback) => {
    const m = mt('A\\PB\\PC\\ND', { columns: fallback });
    expect(columnTexts(m, 0)).toEqual(['A', 'B', 'C']);
    expect(columnTexts(m, 1)).toEqual(['D']);
  });

  it('applies the same height flow to MTEXT associated with a LEADER', () => {
    const raw = 'A\\PB\\PC';
    const leader: LeaderEntity = {
      id: 'leader', type: 'leader', layer: '0', color: 'ByLayer', vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      arrow: false, arrowSize: 1, text: mtextFromDxf(raw), raw, textHeight: 1,
      textPosition: { x: 0, y: 0 }, textAttachment: 1, textColumns: columns,
    };
    const annotation = leaderParts(leader).find((e): e is MTextEntity => e.type === 'mtext')!;
    expect(columnTexts(annotation, 0)).toEqual(['A', 'B']);
    expect(columnTexts(annotation, 1)).toEqual(['C']);
  });

  it('keeps column definitions and flowed appearance through a native fixture edit, undo/redo and DXF reopen', () => {
    const state = readDxf(readFileSync(new URL('./fixtures/interchange/r2018-mtext.dxf', import.meta.url), 'utf8'));
    const original = state.entities.find((e): e is MTextEntity => e.type === 'mtext' && !!e.columns)!;
    expect(original).toBeDefined();
    const drawing = new Drawing();
    drawing.load(state);
    const raw = '\\La b c d e f g h\\l';
    drawing.replaceEntities([{ ...original, raw, text: mtextFromDxf(raw), height: 1, width: 3, columns }]);
    expect(drawing.dirty).toBe(true);
    drawing.undo();
    expect((drawing.entity(original.id) as MTextEntity).columns).toEqual(original.columns);
    drawing.redo();
    const edited = drawing.entity(original.id) as MTextEntity;
    const reopened = readDxf(writeDxf(drawing.snapshot)).entities.find((e): e is MTextEntity => e.type === 'mtext' && e.raw === raw)!;
    expect(reopened.columns).toEqual(columns);
    const signature = (m: MTextEntity) => mtextLayoutFull(m, measure).texts.map((t) => ({ text: t.text, position: t.position, height: t.height }));
    expect(signature(reopened)).toEqual(signature(edited));
  });
});
