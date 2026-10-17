/**
 * Additional adversarial controls for the 12.5 correction round 2 — items
 * 1, 2, 3 and 5 only, deliberately NOT duplicating the lead file
 * (tests/lead-shaping-corrections-review.test.ts) or the round-1 boundary
 * file. Authored by the round-2 review helper, trialled by the heavy-test
 * owner against both the delivered tree (0aaed598) and the corrected tree,
 * and adopted here with four item-5 field adaptations to the landed API
 * (proof identity is a nested `key: ShapeKey`; input-side expectation
 * fields are `expectedKey` / `expectedAgreementSha256`).
 *
 * Trial evidence (validation-12.5-corrections-r2/EXTRA-CONTROLS-TRIAL.md):
 * 15/15 pass on the corrected tree; 5 pass / 10 fail on the delivered
 * tree. Ten tests are genuine before/after demonstrations of the round-2
 * corrections; five are defense-in-depth pins or controls that already
 * behaved at the delivered base (2^53 declared total, sparse glyph array,
 * getter-backed glyph element, null key via validateShapeKey, and the
 * item-5 positive control) — pins, not before/after evidence.
 *
 * Synthetic only: no engine/native/PDF claim.
 */
import { describe, expect, it } from 'vitest';
import { ShapeSnapshotBuilder, validateShapedRun, type ShapedRunContext } from '../src/core/text-shaping-snapshot';
import { validateShapeKey, type ShapeKey, type ShapedGlyph } from '../src/core/text-shaping';
import { checkItemBoundarySafety, type ItemBoundaryInput, type SafeUnitAgreementProof } from '../src/core/text-shaping-extraction';
import { glyph, makeKey, makeRun, sha256 } from './helpers/shaping-fixture';

const ARABIC = '\u0627\u0628';
const FACE = { glyphCount: 2000, unitsPerEm: 2048 };
const INK = { xMin: 0, yMin: -200, xMax: 1000, yMax: 700 };

const epoch = {};
const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: epoch });
const ctxFor = (k: ShapeKey): ShapedRunContext => ({ key: k, itemText: ARABIC, itemTextSha256: sha256(ARABIC), ...FACE });
const addCtx = (_k: ShapeKey) => ({ itemText: ARABIC, itemTextSha256: sha256(ARABIC), ...FACE });
const twoGlyphs = () => [glyph(101, 1, 2), glyph(100, 0, 1)];

describe('extra [item 1]: integer totals beyond the lead cases', () => {
  it('refuses a negative sub-tolerance residue on the x total', () => {
    const run = makeRun(key, ARABIC, { glyphs: twoGlyphs() });
    expect(validateShapedRun(run, ctxFor(key)).ok).toBe(true);
    // Sum is exactly 1000; 1000 - 5e-7 sat inside the old 1e-6 tolerance.
    expect(validateShapedRun({ ...run, advanceX: 1000 - 5e-7 }, ctxFor(key)).ok).toBe(false);
  });

  it('refuses a sub-tolerance residue on a nonzero y total', () => {
    const glyphs = [glyph(101, 1, 2, { yAdvance: 500 }), glyph(100, 0, 1, { yAdvance: 500 })];
    const run = makeRun(key, ARABIC, { glyphs });
    expect(run.advanceY).toBe(1000);
    expect(validateShapedRun(run, ctxFor(key)).ok).toBe(true);
    expect(validateShapedRun({ ...run, advanceY: 1000 + 5e-7 }, ctxFor(key)).ok).toBe(false);
  });

  it('refuses a declared total outside the safe-integer range', () => {
    const run = makeRun(key, ARABIC, { glyphs: twoGlyphs() });
    expect(validateShapedRun({ ...run, advanceX: 2 ** 53 }, ctxFor(key)).ok).toBe(false);
  });
});

describe('extra [item 2]: canonical array binding beyond the lead iterator case', () => {
  const builder = () => new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });

  it('refuses a sparse glyph array instead of throwing on the hole', () => {
    const sparse: ShapedGlyph[] = [glyph(101, 1, 2)];
    sparse.length = 2; // hole at index 1: iteration yields undefined, storage reads undefined
    const run = makeRun(key, ARABIC, { glyphs: sparse, ink: INK });
    expect(builder().add(key, run, addCtx(key)).ok).toBe(false);
  });

  it('refuses an Array subclass instance as the glyph array', () => {
    class GlyphList extends Array<ShapedGlyph> {}
    const listed = GlyphList.from(twoGlyphs());
    const run = makeRun(key, ARABIC, { glyphs: listed, ink: INK });
    expect(builder().add(key, run, addCtx(key)).ok).toBe(false);
  });

  it('refuses an inherited index getter that supplies the second glyph', () => {
    const arr: ShapedGlyph[] = [glyph(101, 1, 2)];
    arr.length = 2; // no OWN index 1
    const proto = Object.create(Array.prototype) as object;
    Object.defineProperty(proto, '1', { configurable: true, get: () => glyph(100, 0, 1) });
    Object.setPrototypeOf(arr, proto); // iteration reads the getter; own-descriptor walks see nothing
    const run = makeRun(key, ARABIC, { glyphs: arr, ink: INK });
    expect(builder().add(key, run, addCtx(key)).ok).toBe(false);
  });

  it('refuses a getter-backed glyph element (own accessor, not data)', () => {
    const arr: ShapedGlyph[] = [glyph(101, 1, 2), glyph(100, 0, 1)];
    Object.defineProperty(arr, '1', { configurable: true, enumerable: true, get: () => glyph(100, 0, 1) });
    const run = makeRun(key, ARABIC, { glyphs: arr, ink: INK });
    expect(builder().add(key, run, addCtx(key)).ok).toBe(false);
  });
});

describe('extra [item 3]: malformed scalars at the remaining throw sites', () => {
  it('refuses a symbol buffer flag without coercion during refusal formatting', () => {
    const bad = { ...key, bufferFlags: [Symbol('malformed producer flag')] } as unknown as ShapeKey;
    expect(validateShapeKey(bad).ok).toBe(false);
  });

  it('refuses a symbol trusted item digest through run validation', () => {
    const run = makeRun(key, ARABIC, { glyphs: twoGlyphs() });
    const badCtx = { ...ctxFor(key), itemTextSha256: Symbol('malformed host digest') } as unknown as ShapedRunContext;
    expect(validateShapedRun(run, badCtx).ok).toBe(false);
  });

  it('refuses a null key through direct key validation without throwing', () => {
    expect(validateShapeKey(null as unknown as ShapeKey).ok).toBe(false);
  });
});

describe('extra [item 5]: safe-unit proof must bind identity and the trusted result', () => {
  const paragraph = '\u0627'.repeat(8) + '\u0628'.repeat(8);
  const epoch5 = {};
  const key5 = makeKey({ paragraphText: paragraph, itemStart: 0, itemEnd: 8, fontEpoch: epoch5 });
  const agreed = sha256('synthetic-agreed-result');
  const clusters: readonly (readonly [number, number])[] = [
    [0, 8],
    [8, 16],
  ];

  // The fully-bound proof shape as landed in round-2 correction 5: the
  // complete shape identity travels as ONE nested `key` (a full ShapeKey)
  // on the proof, beside the context/range binding and ownership marker.
  const boundProof = (agreementSha256: string): SafeUnitAgreementProof =>
    ({
      contextSha256: key5.contextSha256,
      itemStart: 0,
      itemEnd: 8,
      agreementSha256,
      key: key5,
      source: 'preparation-comparison',
    }) as SafeUnitAgreementProof;

  const boundInput = (proof: SafeUnitAgreementProof, withExpectation: boolean): ItemBoundaryInput =>
    ({
      contextStart: 0,
      contextEnd: 16,
      itemStart: 0,
      itemEnd: 8,
      referenceClusters: clusters,
      producedByShapedRegionRules: true,
      contextSha256: key5.contextSha256,
      safeUnitProof: proof,
      ...(withExpectation ? { expectedAgreementSha256: agreed, expectedKey: key5 } : {}),
    }) as ItemBoundaryInput;

  it('admits a fully bound proof against a matching trusted expectation', () => {
    expect(checkItemBoundarySafety(boundInput(boundProof(agreed), true))).toEqual({
      safe: true,
      basis: 'shaped-region-item',
    });
  });

  it('refuses the same proof replayed under a different program', () => {
    const proof = { ...boundProof(agreed), key: { ...key5, programSha256: sha256('another font program') } } as SafeUnitAgreementProof;
    expect(checkItemBoundarySafety(boundInput(proof, true)).safe).toBe(false);
  });

  it('refuses the same proof replayed under a different epoch token', () => {
    const proof = { ...boundProof(agreed), key: { ...key5, fontEpoch: {} } } as unknown as SafeUnitAgreementProof;
    expect(checkItemBoundarySafety(boundInput(proof, true)).safe).toBe(false);
  });

  it('refuses a proof whose agreed-result digest is not the trusted expected one', () => {
    const proof = boundProof(sha256('a different agreed result'));
    expect(checkItemBoundarySafety(boundInput(proof, true)).safe).toBe(false);
  });

  it('fails closed when no trusted expectation is supplied at all', () => {
    expect(checkItemBoundarySafety(boundInput(boundProof(agreed), false)).safe).toBe(false);
  });
});
