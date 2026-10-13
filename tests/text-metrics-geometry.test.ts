import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { compoundParts, dimensionParts, distanceToEntity, entityBounds, entitySegments, explodeCompound, explodeInsert, gripPoints, leaderParts, mtextDecorations, mtextMasks, mtextParts, snapCandidates, tableParts, textBounds, textCorners, textWidth, type BlockDef, type BlockLookup, type DimensionEntity, type InsertEntity, type LeaderEntity, type TableEntity, type TextEntity } from '../src/core/entities';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import { mtextFromDxf, mtextLayoutFull, type MTextEntity } from '../src/core/mtext';
import { metricTextPlacement, type TextAppearance, type TextGeometryContext, type TextMetricResult, type TextMetricStyle } from '../src/core/text-metrics';

interface MetricOptions {
  unit: number;
  widthFactor: number;
  oblique: number;
  left: number;
  overhang: number;
  ascent: number;
  descent: number;
}
/** Deterministic backend: tests geometry propagation without claiming installed-font proof. */
function context(options: Partial<MetricOptions> = {}): TextGeometryContext {
  const o = { unit: 1, widthFactor: 1, oblique: 0, left: -0.2, overhang: 0.1, ascent: 1.1, descent: 0.3, ...options };
  return {
    cacheKey: {},
    resolve(input: TextMetricStyle): TextAppearance {
      if (input.style === 'SHX') return { kind: 'stroke', widthFactor: 9, oblique: 1 };
      return { kind: 'canvas', family: input.style ?? 'Arial', bold: !!input.bold, italic: !!input.italic,
        widthFactor: input.widthFactor ?? o.widthFactor, oblique: input.oblique ?? o.oblique };
    },
    measure(text: string, height: number, appearance: TextAppearance): TextMetricResult {
      const advance = text.length * height * o.unit * (appearance.kind === 'canvas' && appearance.bold ? 2 : 1);
      if (!text.trim()) return { advance, left: 0, right: 0, ascent: 0, descent: 0 };
      return { advance, left: o.left * height, right: advance + o.overhang * height, ascent: o.ascent * height, descent: o.descent * height };
    },
  };
}
const text = (patch: Partial<TextEntity> = {}): TextEntity => ({ id: 'text', type: 'text', layer: '0', color: 'ByLayer', text: 'Ay', position: { x: 10, y: 20 }, height: 2, rotation: 0, align: 'left', style: 'FACE', ...patch });
const mtext = (raw: string, patch: Partial<MTextEntity> = {}): MTextEntity => ({ id: 'm', type: 'mtext', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: mtextFromDxf(raw), raw, height: 1, width: 0, rotation: 0, attachment: 1, lineSpacing: 1, style: 'FACE', ...patch });
const lookupWith = (metrics: TextGeometryContext): BlockLookup => Object.assign(() => undefined, { textGeometry: metrics });

describe('context-aware TrueType TEXT geometry', () => {
  it('includes signed bearings and descenders in world bounds and hit testing', () => {
    const metrics = context(), t = text();
    const b = textBounds(t, metrics);
    expect(b.min.x).toBeCloseTo(9.6); expect(b.min.y).toBeCloseTo(19.4);
    expect(b.max.x).toBeCloseTo(14.2); expect(b.max.y).toBeCloseTo(22.2);
    expect(distanceToEntity({ x: 10, y: 19.5 }, t, lookupWith(metrics))).toBe(0);
    expect(distanceToEntity({ x: 10, y: 19.5 }, t, () => undefined)).toBeGreaterThan(0);
    expect(t.position).toEqual({ x: 10, y: 20 }); expect(t.widthFactor).toBeUndefined();
  });

  it('resolves STYLE width/oblique and honors explicit width1/oblique0 without mutating data', () => {
    const metrics = context({ widthFactor: 0.5, oblique: Math.atan(0.25) });
    const inherited = textBounds(text(), metrics), explicit = textBounds(text({ widthFactor: 1, oblique: 0 }), metrics);
    expect(inherited.min.x).toBeCloseTo(9.65); expect(inherited.max.x).toBeCloseTo(12.65);
    expect(explicit.min.x).toBeCloseTo(9.6); expect(explicit.max.x).toBeCloseTo(14.2);
  });

  it.each(['left', 'center', 'right'] as const)('uses native bearing/overhang placement for %s alignment', (align) => {
    const metrics = context(), t = text({ align }), placed = metricTextPlacement(t, metrics), b = textBounds(t, metrics);
    const offset = align === 'center' ? -1.9 : align === 'right' ? -4.2 : 0;
    expect(placed.offset).toBeCloseTo(offset);
    expect(b.min.x).toBeCloseTo(9.6 + offset); expect(b.max.x).toBeCloseTo(14.2 + offset);
  });

  it('rotates the actual glyph rectangle rather than an advance/cap rectangle', () => {
    const b = textBounds(text({ rotation: Math.PI / 2 }), context());
    expect(b.min.x).toBeCloseTo(7.8); expect(b.max.x).toBeCloseTo(10.6);
    expect(b.min.y).toBeCloseTo(19.6); expect(b.max.y).toBeCloseTo(24.2);
  });

  it.each([3, 5] as const)('fits native horizontal mode %i with measured overhang and second anchors', (horizontal) => {
    const metrics = context({ left: 0, overhang: 0.5, ascent: 1, descent: 0, widthFactor: 0.5 });
    const t = text({ position: { x: 0, y: 0 }, alignmentPoint: { x: 0, y: 10 }, rotation: 1, justification: { horizontal, vertical: 0 } });
    const placed = metricTextPlacement(t, metrics), b = textBounds(t, metrics);
    expect(placed.text.rotation).toBeCloseTo(Math.PI / 2);
    expect(b.min.y).toBeCloseTo(0); expect(b.max.y).toBeCloseTo(10);
    expect(placed.text.height).toBeCloseTo(horizontal === 5 ? 2 : 8);
    expect(placed.text.widthFactor).toBeCloseTo(horizontal === 5 ? 2 : 0.5);
    expect(t.height).toBe(2); expect(t.widthFactor).toBeUndefined(); expect(t.rotation).toBe(1);
  });

  it('keeps whitespace selectable with its logical rectangle', () => {
    const metrics = context({ widthFactor: 0.5 });
    expect(textBounds(text({ text: '  ' }), metrics)).toEqual({ min: { x: 10, y: 20 }, max: { x: 12, y: 22 } });
  });

  it('preserves exact context-free and SHX stroke geometry', () => {
    const t = text({ style: 'SHX', widthFactor: 0.8, oblique: 0.2 });
    expect(textCorners(t, context())).toEqual(textCorners(t));
    expect(textBounds(t).max.x).toBeCloseTo(10 + textWidth(t.text, t.height) * 0.8 + 2 * Math.tan(0.2));
  });
});

describe('font context through MTEXT layout, masks and caches', () => {
  it('wraps plain text with its actual named-face advance and keeps style on every piece', () => {
    const m = mtext('aa bb', { raw: undefined, width: 4 }), metrics = context();
    const pieces = mtextParts(m, metrics);
    expect(pieces.map((p) => p.text)).toEqual(['aa', 'bb']);
    expect(pieces.every((p) => p.style === m.style)).toBe(true);
    expect(pieces[1]!.position.y - pieces[0]!.position.y).toBeCloseTo(-5 / 3);
    expect(mtextParts(m, metrics)).toBe(pieces);
  });

  it('measures bold formatted runs and preserves the existing synthetic italic appearance', () => {
    const m = mtext('aa {\\fArial|b1|i1;bb}', { width: 5 }), pieces = mtextParts(m, context());
    expect(pieces.map((p) => p.text)).toEqual(['aa', 'bb']);
    expect(pieces[1]!.position.x).toBe(0); expect(pieces[1]!.position.y).toBeCloseTo(-8 / 3);
    expect(pieces[1]!.bold).toBe(true); expect(pieces[1]!.oblique).toBeCloseTo(Math.PI / 12);
    expect(Object.hasOwn(pieces[1]!, 'italic')).toBe(false);
    expect(pieces.every((p) => p.style === 'FACE')).toBe(true);
  });

  it('applies inherited and nondefault inline width factors exactly once', () => {
    const m = mtext('a{\\W2;b}c'), metrics = context({ widthFactor: 0.5 });
    const pieces = mtextParts(m, metrics);
    expect(pieces.map((p) => p.position.x)).toEqual([0, 0.5, 2.5]);
    expect(pieces.map((p) => p.widthFactor)).toEqual([undefined, 2, undefined]);
    const plain = mtextParts(mtext('aa bb', { raw: undefined, width: 3 }), metrics);
    expect(plain).toHaveLength(1); expect(plain[0]!.text).toBe('aa bb');
  });

  it('measures fraction children and decorations with the same bold run and inherited width', () => {
    const m = mtext('\\fArial|b1;\\L\\S1/22;\\l'), metrics = context({ widthFactor: 0.5 });
    const pieces = mtextParts(m, metrics), lines = mtextDecorations(m, metrics);
    expect(pieces.map((p) => [p.text, p.height, p.position.x])).toEqual([['1', 0.7, 0.35], ['22', 0.7, 0]]);
    expect(pieces.every((p) => p.bold && p.style === 'FACE')).toBe(true);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.b.x - lines[0]!.a.x).toBeCloseTo(1.4);
    expect(lines[1]!.b.x - lines[1]!.a.x).toBeCloseTo(1.4);
  });

  it('passes optional run formatting to existing standalone MTEXT measurement callbacks', () => {
    const seen: boolean[] = [];
    const layout = mtextLayoutFull(mtext('a{\\fArial|b1;\\S1/22;}'), (value, height, run) => {
      seen.push(!!run?.bold); return value.length * height * (run?.bold ? 2 : 1);
    });
    expect(seen).toContain(false); expect(seen).toContain(true);
    expect(layout.texts.every((p) => p.style === 'FACE')).toBe(true);
    expect(layout.strokes[0]!.b.x - layout.strokes[0]!.a.x).toBeCloseTo(2.8);
  });

  it('uses glyph bearings and descenders for masks, entity bounds and frame intersection segments', () => {
    const m = mtext('a b', { background: { flags: 17, scale: 1, color: 1 } }), metrics = context(), lookup = lookupWith(metrics);
    const masks = mtextMasks(m, metrics);
    expect(masks).toHaveLength(1);
    expect(masks[0]![0]!.x).toBeCloseTo(-0.2); expect(masks[0]![0]!.y).toBeCloseTo(-1.3);
    expect(masks[0]![2]!.x).toBeCloseTo(3.1); expect(masks[0]![2]!.y).toBeCloseTo(0.1);
    expect(entityBounds(m, lookup)?.min.y).toBeCloseTo(-1.3);
    expect(distanceToEntity({ x: 0, y: -1.25 }, m, lookup)).toBe(0);
    expect(entitySegments(m, lookup)).toEqual(masks[0]!.map((p, i) => [p, masks[0]![(i + 1) % 4]!]));
  });

  it('refreshes parts and masks when the metric key changes while preserving raw/source data', () => {
    const m = mtext('aa bb', { width: 4, background: { flags: 1, scale: 1, color: 1 } });
    const narrow = context({ unit: 0.5 }), wide = context({ unit: 1 });
    const first = mtextParts(m, narrow), second = mtextParts(m, wide);
    expect(first).not.toBe(second); expect(new Set(first.map((p) => p.position.y)).size).toBe(1);
    expect(new Set(second.map((p) => p.position.y)).size).toBe(2);
    expect(mtextMasks(m, wide)[0]![0]!.y).toBeCloseTo(-1 - 5 / 3 - 0.3);
    expect(mtextParts(m, narrow)).toEqual(first);
    expect(m.raw).toBe('aa bb'); expect(m.text).toBe('aa bb'); expect(m.width).toBe(4);
  });

  it('flows newly wrapped lines through declared column heights when font metrics change', () => {
    const m = mtext('a b c d', { width: 3, columns: { type: 1, count: 2, width: 3, gutter: 2, autoHeight: false, reversed: false, heights: [3, 3] } });
    const narrow = mtextParts(m, context({ unit: 0.5 })), wide = mtextParts(m, context({ unit: 2 }));
    expect(narrow.every((p) => p.id.startsWith('m:col0:'))).toBe(true);
    expect(wide.map((p) => [p.text, p.position.x])).toEqual([['a', 0], ['b', 0], ['c', 5], ['d', 5]]);
    expect(m.columns?.heights).toEqual([3, 3]); expect(m.raw).toBe('a b c d');
  });

  it('rotates font-aware masks around the parent attachment point', () => {
    const m = mtext('a b', { rotation: Math.PI / 2, position: { x: 10, y: 20 }, background: { flags: 17, scale: 1, color: 1 } });
    const metrics = context(), mask = mtextMasks(m, metrics)[0]!;
    expect(mask[0]!.x).toBeCloseTo(11.3); expect(mask[0]!.y).toBeCloseTo(19.8);
    expect(mask[2]!.x).toBeCloseTo(9.9); expect(mask[2]!.y).toBeCloseTo(23.1);
    expect(entityBounds(m, lookupWith(metrics))?.min.x).toBeCloseTo(9.9);
  });

  it('keeps SHX and context-free MTEXT flow, decorations and masks identical', () => {
    const m = mtext('\\La b\\l\\P\\S1/2;', { style: 'SHX', background: { flags: 17, scale: 1.5, color: 2 } });
    expect(mtextParts(m, context())).toEqual(mtextParts(m));
    expect(mtextDecorations(m, context())).toEqual(mtextDecorations(m));
    expect(mtextMasks(m, context())).toEqual(mtextMasks(m));
  });
});

describe('nested INSERT font-bound cache invalidation', () => {
  it('reuses expansion geometry but refreshes text bounds for a changed font context', () => {
    const leaf: BlockDef = { name: 'LEAF', basePoint: { x: 0, y: 0 }, entities: [text({ position: { x: 1, y: 2 }, height: 1 })], attributes: [] };
    const inner: InsertEntity = { id: 'inner', type: 'insert', layer: '0', color: 'ByLayer', block: 'LEAF', position: { x: 3, y: 4 }, rotation: 0, scale: 1, attributes: {} };
    const parent: BlockDef = { name: 'PARENT', basePoint: { x: 0, y: 0 }, entities: [inner], attributes: [] };
    const insert: InsertEntity = { ...inner, id: 'outer', block: 'PARENT', position: { x: 10, y: 20 }, scale: 2 };
    const drawing = new Drawing({ entities: [insert], blocks: { LEAF: leaf, PARENT: parent } });
    const accepted = drawing.entities[0]! as InsertEntity;
    let active = context({ unit: 1, left: 0, overhang: 0, ascent: 1, descent: 0 });
    const lookup: BlockLookup = (name) => drawing.blocks[name];
    Object.defineProperty(lookup, 'textGeometry', { get: () => active });
    const expanded = explodeInsert(accepted, lookup), first = entityBounds(accepted, lookup);
    expect(first).toEqual({ min: { x: 18, y: 32 }, max: { x: 22, y: 34 } });
    active = context({ unit: 2, left: 0, overhang: 0, ascent: 1, descent: 0 });
    expect(entityBounds(accepted, lookup)).toEqual({ min: { x: 18, y: 32 }, max: { x: 26, y: 34 } });
    expect(explodeInsert(accepted, lookup)).toBe(expanded);
    expect(drawing.dirty).toBe(false); expect(drawing.history().undo).toHaveLength(0);
  });
});

describe('generated annotation font contexts', () => {
  const dimension = (): DimensionEntity => ({
    id: 'dim', type: 'dimension', layer: '0', color: 'ByLayer', kind: 'linear', p1: { x: 0, y: 0 }, p2: { x: 20, y: 0 }, linePoint: { x: 10, y: 5 }, rotation: 0, text: 'AB',
    style: { ...STANDARD_DIMSTYLE, name: 'DIMSTYLE is not a font', textStyle: 'Standard', textHeight: 1, arrowSize: 0, textGap: 0.25, scale: 1, arrow: 'none', arrow2: 'none', suppressExt1: true, suppressExt2: true },
  });
  const leader = (): LeaderEntity => ({ id: 'leader', type: 'leader', layer: '0', color: 'ByLayer', vertices: [{ x: 0, y: 0 }, { x: 1, y: 1 }], arrow: false, arrowSize: 0, text: 'aa bb', textPosition: { x: 10, y: 10 }, textWidth: 4, textHeight: 1 });
  const table = (): TableEntity => ({ id: 'table', type: 'table', layer: '0', color: 'ByLayer', position: { x: 0, y: 10 }, rotation: 0, rowHeights: [4], columnWidths: [4], cells: [[{ text: 'aa bb', attachment: 5 }]], textHeight: 1, margin: 0 });
  const horizontalLines = (d: DimensionEntity, metrics: TextGeometryContext) => dimensionParts(d, metrics).filter((p) => p.type === 'line' && p.a.y === 5 && p.b.y === 5).map((p) => p.type === 'line' ? [p.a.x, p.b.x] : []);

  it('sizes the Standard TrueType dimension gap with one inherited width factor and refreshes on font change', () => {
    const d = dimension(), narrow = context({ unit: 1, widthFactor: 0.5 }), wide = context({ unit: 2, widthFactor: 0.5 });
    const first = dimensionParts(d, narrow);
    expect(horizontalLines(d, narrow)).toEqual([[0, 9.25], [10.75, 20]]);
    expect(dimensionParts(d, narrow)).toBe(first);
    expect(horizontalLines(d, wide)).toEqual([[0, 8.75], [11.25, 20]]);
    expect(dimensionParts(d, wide)).not.toBe(first);
    expect(entitySegments(d, lookupWith(wide))).toEqual([
      [{ x: 0, y: 5 }, { x: 8.75, y: 5 }], [{ x: 11.25, y: 5 }, { x: 20, y: 5 }],
    ]);
    expect(distanceToEntity({ x: 8.8, y: 5 }, d, lookupWith(wide))).toBeGreaterThan(0);
    expect(d.style.textHeight).toBe(1); expect(d.style.name).toBe('DIMSTYLE is not a font');
  });

  it('resolves DIMTXSTY rather than the dimension style object/name', () => {
    const metrics = context(), requested: TextMetricStyle[] = [], resolve = metrics.resolve.bind(metrics);
    metrics.resolve = (input) => { requested.push(input); return resolve(input); };
    const d = { ...dimension(), style: { ...dimension().style, textStyle: 'Named face' } };
    const pieces = dimensionParts(d, metrics);
    expect(requested[0]).toEqual({ style: 'Named face' });
    expect(pieces.find((p): p is TextEntity => p.type === 'text')!.style).toBe('Named face');
  });

  it('keeps text snap/grip placement on the same context as a dimension fit decision', () => {
    const d = { ...dimension(), p2: { x: 4, y: 0 }, linePoint: { x: 2, y: 5 } };
    const metrics = context({ unit: 3 }), lookup = lookupWith(metrics);
    const label = dimensionParts(d, metrics).find((p): p is TextEntity => p.type === 'text')!;
    expect(label.position.y).toBeGreaterThan(4.5); // The wider text no longer fits inside.
    expect(gripPoints(d, metrics).at(-1)).toEqual(label.position);
    expect(snapCandidates(d, lookup).find((p) => p.kind === 'insertion')?.point).toEqual(label.position);
    expect(entityBounds(d, lookup)?.max.x).toBeGreaterThan(4);
  });

  it('reflows leader annotation through Standard metrics while preserving its saved anchor and paths', () => {
    const e = leader(), narrow = context({ unit: 0.5 }), wide = context({ unit: 1 });
    const first = leaderParts(e, narrow), m1 = first.find((p): p is MTextEntity => p.type === 'mtext')!;
    expect(m1.style).toBeUndefined(); // The current leader model does not retain a named font.
    expect(mtextParts(m1, narrow).map((p) => [p.text, p.position])).toEqual([['aa bb', { x: 10, y: 9 }]]);
    const second = compoundParts(e, wide), m2 = second.find((p): p is MTextEntity => p.type === 'mtext')!;
    expect(second).not.toBe(first); expect(leaderParts(e, wide)).toBe(second);
    expect(mtextParts(m2, wide).map((p) => p.text)).toEqual(['aa', 'bb']);
    expect(mtextParts(m2, wide)[1]!.position.y).toBeCloseTo(9 - 5 / 3);
    expect(second.filter((p) => p.type !== 'mtext')).toEqual(first.filter((p) => p.type !== 'mtext'));
    expect(explodeCompound(e, wide)?.find((p) => p.type === 'mtext')).toMatchObject({ text: e.text, position: e.textPosition, width: e.textWidth });
    expect(e.textPosition).toEqual({ x: 10, y: 10 }); expect(e.vertices).toEqual([{ x: 0, y: 0 }, { x: 1, y: 1 }]);
  });

  it('reflows table cell text at its middle attachment with a changed Standard font context', () => {
    const e = table(), narrow = context({ unit: 0.5 }), wide = context({ unit: 1 });
    const first = tableParts(e, narrow), m1 = first.find((p): p is MTextEntity => p.type === 'mtext')!;
    expect(m1.style).toBeUndefined(); // TABLE cells currently have no named font field.
    expect(mtextParts(m1, narrow).map((p) => p.position.y)).toEqual([7.5]);
    const second = compoundParts(e, wide), m2 = second.find((p): p is MTextEntity => p.type === 'mtext')!;
    expect(second).not.toBe(first); expect(tableParts(e, wide)).toBe(second);
    expect(mtextParts(m2, wide).map((p) => p.text)).toEqual(['aa', 'bb']);
    expect(mtextParts(m2, wide)[0]!.position.y).toBeCloseTo(8 + (1 + 5 / 3) / 2 - 1);
    expect(second.filter((p) => p.type === 'line')).toEqual(first.filter((p) => p.type === 'line'));
    expect(explodeCompound(e, wide)?.find((p) => p.type === 'mtext')).toMatchObject({ text: 'aa bb', position: { x: 2, y: 8 }, width: 4 });
    expect(e.cells[0]![0]!.text).toBe('aa bb'); expect(e.rowHeights).toEqual([4]);
  });

  it('preserves all generated SHX/context-free annotation geometry', () => {
    const stroke = context(); stroke.resolve = () => ({ kind: 'stroke', widthFactor: 9, oblique: 1 });
    stroke.measure = () => { throw new Error('Legacy SHX annotation geometry must not use a TrueType backend'); };
    const d = dimension(), l = leader(), t = table();
    expect(dimensionParts(d, stroke)).toEqual(dimensionParts(d));
    expect(leaderParts(l, stroke)).toEqual(leaderParts(l));
    expect(tableParts(t, stroke)).toEqual(tableParts(t));
    for (const e of [l, t]) expect(entityBounds(e, lookupWith(stroke))).toEqual(entityBounds(e, () => undefined));
  });
});
