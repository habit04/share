/** Independent unconsumed-interface controls; synthetic identities, no engine or native I/O. */
import { describe, expect, it } from 'vitest';
import { checkItemBoundarySafety, type ItemBoundaryInput, type SafeUnitAgreementProof } from '../src/core/text-shaping-extraction';
import { validateShapeKey, type ShapeKey } from '../src/core/text-shaping';
import { glyph, makeKey, sha256, syntheticInk } from './helpers/shaping-fixture';

const AGREEMENT = sha256('lead-owned exact synthetic comparison record');

function inputFor(key: ShapeKey, contextStart: number, contextEnd: number, clusters: ItemBoundaryInput['referenceClusters']): ItemBoundaryInput {
  const proof: SafeUnitAgreementProof = {
    contextSha256: key.contextSha256,
    itemStart: key.itemStart,
    itemEnd: key.itemEnd,
    key,
    source: 'preparation-comparison',
    agreementSha256: AGREEMENT,
  };
  return {
    contextStart, contextEnd, itemStart: key.itemStart, itemEnd: key.itemEnd,
    referenceClusters: clusters, producedByShapedRegionRules: true,
    contextSha256: key.contextSha256, safeUnitProof: proof,
    expectedKey: key, expectedAgreementSha256: AGREEMENT,
  };
}

function paragraphFixture(): ItemBoundaryInput {
  const key = makeKey({
    paragraphText: '\u0627\u0628'.repeat(8), itemStart: 0, itemEnd: 8,
    bufferFlags: ['bot'], fontEpoch: {},
  });
  return inputFor(key, 0, 16, [[0, 8], [8, 16]]);
}

function lineFixture(): ItemBoundaryInput {
  const key = makeKey({
    paragraphText: '\u0627\u0628'.repeat(12), itemStart: 8, itemEnd: 16,
    contextKind: 'line', contextStart: 4, contextEnd: 20,
    lineLevels: Array.from({ length: 16 }, () => 1), bufferFlags: [], fontEpoch: {},
  });
  return inputFor(key, 4, 20, [[4, 8], [8, 16], [16, 20]]);
}

describe('lead: one coherent identity across safe-unit key, proof header and input', () => {
  it('control: admits a coherent subitem of a genuine sixteen-character synthetic context', () => {
    const input = paragraphFixture();
    expect(validateShapeKey(input.expectedKey!).ok).toBe(true);
    expect(checkItemBoundarySafety(input)).toEqual({ safe: true, basis: 'shaped-region-item' });
  });

  it('control: admits a coherent nonzero paragraph/line-frame offset', () => {
    const input = lineFixture();
    expect(validateShapeKey(input.expectedKey!).ok).toBe(true);
    expect(input.expectedKey!.contextItemStart).toBe(4);
    expect(input.expectedKey!.contextItemEnd).toBe(12);
    expect(checkItemBoundarySafety(input)).toEqual({ safe: true, basis: 'shaped-region-item' });
  });

  it('refuses relabelled context headers that disagree with the unchanged trusted key', () => {
    const input = paragraphFixture();
    const relabelledDigest = sha256('\u0628\u0627'.repeat(8));
    expect(relabelledDigest).not.toBe(input.expectedKey!.contextSha256);
    const proof = { ...input.safeUnitProof!, contextSha256: relabelledDigest };
    expect(validateShapeKey(input.expectedKey!).ok).toBe(true);
    expect(checkItemBoundarySafety({ ...input, contextSha256: relabelledDigest, safeUnitProof: proof }).safe).toBe(false);
  });

  it('refuses relabelled item headers while both equal valid keys still identify the first item', () => {
    const input = paragraphFixture();
    const proof = { ...input.safeUnitProof!, itemStart: 8, itemEnd: 16 };
    expect(validateShapeKey(input.expectedKey!).ok).toBe(true);
    expect(input.expectedKey!.itemStart).toBe(0);
    expect(input.expectedKey!.itemEnd).toBe(8);
    expect(checkItemBoundarySafety({ ...input, itemStart: 8, itemEnd: 16, safeUnitProof: proof }).safe).toBe(false);
  });

  it('refuses a boundary context origin inconsistent with the unchanged valid key frame', () => {
    const input = lineFixture();
    expect(validateShapeKey(input.expectedKey!).ok).toBe(true);
    // Key remains item[8,16), context-relative[4,12), hence origin4.
    // Header claims origin0 while keeping every proof/key/digest unchanged.
    expect(checkItemBoundarySafety({ ...input, contextStart: 0, referenceClusters: [[0, 8], [8, 16], [16, 20]] }).safe).toBe(false);
  });

  it('control: refuses a bearer digest that differs from the unchanged trusted comparison record', () => {
    const input = paragraphFixture();
    const proof = { ...input.safeUnitProof!, agreementSha256: sha256('another result') };
    expect(checkItemBoundarySafety({ ...input, safeUnitProof: proof }).safe).toBe(false);
  });
});

describe('lead: restored authored ink accounts for signed advances in both pen axes', () => {
  it('control: unions independently placed boxes across signed x/y pen motion', () => {
    const ink = syntheticInk([
      glyph(101, 1, 2, { xAdvance: -500, yAdvance: 1000, xOffset: 10, yOffset: 20 }),
      glyph(100, 0, 1, { xAdvance: 200, yAdvance: -50, xOffset: -30, yOffset: -100 }),
    ]);
    // First placed box: x[-490,10], y[-180,720].
    // Second, at pen(-500,1000): x[-530,-330], y[700,1600].
    expect(ink).toEqual({ xMin: -530, yMin: -180, xMax: 10, yMax: 1600 });
  });
});
