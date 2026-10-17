/** Lead-owned interface regressions; synthetic only, no engine/native/PDF claim. */
import { describe, expect, it } from 'vitest';
import { ShapeSnapshotBuilder, validateShapedRun } from '../src/core/text-shaping-snapshot';
import { assignExtractionCodes } from '../src/core/text-shaping-extraction';
import { glyph, makeKey, makeRun, sha256 } from './helpers/shaping-fixture';

const text = '\u0627\u0628';
const face = { glyphCount: 2000, unitsPerEm: 2048 };
function example() {
  const key = makeKey({ paragraphText: text, itemStart: 0, itemEnd: text.length });
  const run = makeRun(key, text, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
  return { key, run, context: { key, itemText: text, itemTextSha256: sha256(text), ...face } };
}

describe('lead: item/key/snapshot binding', () => {
  it('control: exact item text and range validate', () => {
    const { run, context } = example();
    expect(validateShapedRun(run, context).ok).toBe(true);
  });

  it('refuses a one-character result claiming a two-character key even when its short text hash echoes', () => {
    const { key } = example();
    const short = text[0]!;
    const run = makeRun(key, short, { glyphs: [glyph(100, 0, 1)] });
    expect(validateShapedRun(run, { key, itemText: short, itemTextSha256: sha256(short), ...face }).ok).toBe(false);
  });

  it('does not seal that mismatched item as a ready two-character result', () => {
    const { key } = example();
    const short = text[0]!;
    const run = makeRun(key, short, { glyphs: [glyph(100, 0, 1)] });
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });
    expect(builder.add(key, run, { itemText: short, itemTextSha256: sha256(short), ...face }).ok).toBe(false);
  });

  it('a reachable encoder mutation cannot make a sealed snapshot serve the wrong font program', () => {
    const { key, run, context } = example();
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });
    expect(builder.add(key, run, context).ok).toBe(true);
    const encoded = builder.encoder.encode(key);
    const snapshot = builder.seal();
    const other = { ...key, programSha256: sha256('another font program') };
    expect(snapshot.get(other)).toBeUndefined();
    builder.encoder.encode = () => encoded;
    expect(snapshot.get(other)).toBeUndefined();
  });
});

describe('lead: assigned character-code budget matches current writer', () => {
  const glyphs = [{ glyph: 2, clusterStart: 0, clusterEnd: 1 }];

  it('control: first ordinary code is one', () => {
    const result = assignExtractionCodes({ glyphs, itemText: 'A', firstCode: 1 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.assignments[0]!.code).toBe(1);
  });

  it('refuses reserved code zero', () => {
    expect(assignExtractionCodes({ glyphs, itemText: 'A', firstCode: 0 }).ok).toBe(false);
  });

  it('admits the existing writer\'s final legal assigned code 65534', () => {
    expect(assignExtractionCodes({ glyphs, itemText: 'A', firstCode: 65534 }).ok).toBe(true);
  });

  it.each([NaN, Infinity, 70000])('refuses invalid or raised maxCodes override %s', maxCodes => {
    expect(assignExtractionCodes({ glyphs, itemText: 'A', firstCode: 65535, maxCodes }).ok).toBe(false);
  });
});

describe('lead: delivered signed-32-bit ink schema can represent accepted runs', () => {
  it('control: small accepted ink round-trips through the declared i32 field', () => {
    const { run, context } = example();
    expect(validateShapedRun(run, context).ok).toBe(true);
    const wire = new DataView(new ArrayBuffer(4));
    wire.setInt32(0, run.ink.xMax, true);
    expect(wire.getInt32(0, true)).toBe(run.ink.xMax);
  });

  it('refuses the bounded long run whose pen-accumulated ink exceeds the delivered i32 wire header', () => {
    const item = '\u0627'.repeat(3000);
    const key = makeKey({ paragraphText: item, itemStart: 0, itemEnd: item.length });
    const run = makeRun(key, item, { glyphs: Array.from({ length: item.length }, (_, i) => glyph(100, i, i + 1, { xAdvance: 1000000 })) });
    // Each advance <64*16384, 3000 glyphs use84064 wire bytes, context below65536UTF16.
    // This demonstrates the DECLARED schema, not an existing production serializer.
    const result = validateShapedRun(run, { key, itemText: item, itemTextSha256: sha256(item), glyphCount: 2000, unitsPerEm: 16384 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toContain('ink-bounds:');
    expect(run.ink.xMax).toBe(3000000000);
  });
});
