/** Independent synthetic correction-round controls; no engine/native/PDF claim. */
import { describe, expect, it } from 'vitest';
import { ShapeSnapshotBuilder, validateShapedRun } from '../src/core/text-shaping-snapshot';
import { validateShapeKey, type ShapeKey } from '../src/core/text-shaping';
import { glyph, makeKey, makeRun, sha256, syntheticInk } from './helpers/shaping-fixture';

const text = '\u0627\u0628';
const face = { glyphCount: 2000, unitsPerEm: 2048 };
function example() {
  const key = makeKey({ paragraphText: text, itemStart: 0, itemEnd: text.length });
  const run = makeRun(key, text, {
    glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)],
    // Explicit original model bounds; independent of the changed default helper.
    ink: { xMin: 0, yMin: -200, xMax: 1000, yMax: 700 },
  });
  return { key, run, context: { key, itemText: text, itemTextSha256: sha256(text), ...face } };
}

describe('integer i64 run totals agree with the declared wire representation', () => {
  it('refuses a fractional x total even inside the prior sum tolerance', () => {
    const { run, context } = example();
    expect(validateShapedRun({ ...run, advanceX: 1000 + 5e-7 }, context).ok).toBe(false);
  });

  it('refuses a fractional y total even inside the prior sum tolerance', () => {
    const { run, context } = example();
    expect(validateShapedRun({ ...run, advanceY: 5e-7 }, context).ok).toBe(false);
  });
});

describe('synthetic glyph-local boxes are placed at accumulated run positions', () => {
  it('unions two ordinary advance boxes at their distinct pen positions', () => {
    const ink = syntheticInk([glyph(101, 1, 2), glyph(100, 0, 1)]);
    expect(ink.xMin).toBe(0);
    expect(ink.xMax).toBe(1000);
  });

  it('keeps signed negative advances ordered and includes accumulated placement', () => {
    const ink = syntheticInk([glyph(101, 1, 2, { xAdvance: -500 }), glyph(100, 0, 1, { xAdvance: -500 })]);
    expect(ink.xMin).toBe(-1000);
    expect(ink.xMax).toBe(0);
  });

  it('translates the synthetic vertical extent by the actual glyph offset', () => {
    const ink = syntheticInk([glyph(100, 0, 1, { yOffset: 1000 })]);
    expect(ink.yMin).toBe(800);
    expect(ink.yMax).toBe(1700);
  });
});

describe('snapshot plain-data gate binds iteration to stored indexed glyph data', () => {
  it('control: admits canonical plain arrays and exact integer bounds', () => {
    const { key, run, context } = example();
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });
    expect(builder.add(key, run, context).ok).toBe(true);
    expect(builder.seal().get(key)?.glyphs[0]?.glyph).toBe(101);
  });

  it('refuses an own iterator that hides stored out-of-range glyph ids', () => {
    const { key, context } = example();
    const indexed = [glyph(999999, 1, 2), glyph(999999, 0, 1)];
    Object.defineProperty(indexed, Symbol.iterator, {
      value: function* () { yield glyph(101, 1, 2); yield glyph(100, 0, 1); },
      enumerable: false,
    });
    const run = makeRun(key, text, { glyphs: indexed, ink: { xMin: 0, yMin: -200, xMax: 1000, yMax: 700 } });
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });
    expect(builder.add(key, run, context).ok).toBe(false);
  });
});

describe('explicit long-run controls preserve the actual reviewed input', () => {
  it('control: accepts pen-accumulated long-run ink within the delivered i32 range', () => {
    const item = '\u0627'.repeat(3000);
    const key = makeKey({ paragraphText: item, itemStart: 0, itemEnd: item.length });
    const run = makeRun(key, item, {
      glyphs: Array.from({ length: item.length }, (_, i) => glyph(100, i, i + 1, { xAdvance: 1000 })),
      ink: { xMin: 0, yMin: -200, xMax: 3000000, yMax: 700 },
    });
    expect(validateShapedRun(run, { key, itemText: item, itemTextSha256: sha256(item), ...face }).ok).toBe(true);
  });

  it('observation: the original explicit three-billion ink input is now refused', () => {
    const item = '\u0627'.repeat(3000);
    const key = makeKey({ paragraphText: item, itemStart: 0, itemEnd: item.length });
    const run = makeRun(key, item, {
      glyphs: Array.from({ length: item.length }, (_, i) => glyph(100, i, i + 1, { xAdvance: 1000000 })),
      ink: { xMin: 0, yMin: -200, xMax: 3000000000, yMax: 700 },
    });
    const result = validateShapedRun(run, { key, itemText: item, itemTextSha256: sha256(item), glyphCount: 2000, unitsPerEm: 16384 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('ink-bounds:');
  });
});

describe('malformed boundary data refuses instead of throwing', () => {
  it('refuses a null builder key before reading its epoch', () => {
    const { key, run, context } = example();
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });
    expect(builder.add(null as unknown as ShapeKey, run, context).ok).toBe(false);
  });

  it('refuses a symbol digest without regexp coercion', () => {
    const { key } = example();
    const bad = { ...key, programSha256: Symbol('malformed producer digest') } as unknown as ShapeKey;
    expect(validateShapeKey(bad).ok).toBe(false);
  });

  it('refuses a symbol feature without regexp coercion', () => {
    const { key } = example();
    const bad = { ...key, features: [Symbol('malformed producer feature')] } as unknown as ShapeKey;
    expect(validateShapeKey(bad).ok).toBe(false);
  });
});
