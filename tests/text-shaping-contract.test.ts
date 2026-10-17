/**
 * Synthetic contract tests for the 12.5 shaping interface (contract v4 §11,
 * §12). These pin the contract's identity, immutability, admission, and
 * host-boundary validation behaviour against a fake producer's data. They
 * are NOT font, PDF, Windows, or native acceptance.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyItemRoute,
  deriveShapeKey,
  requestIdentity,
  validateSelectedFaceRef,
  validateShapeKey,
  validateShapeRequest,
  type ShapeKey,
  type ShapePrepState,
  type ShapeRequest,
} from '../src/core/text-shaping';
import {
  ShapeKeyEncoder,
  ShapeSnapshotBuilder,
  validateShapedRun,
  type ShapedRunContext,
} from '../src/core/text-shaping-snapshot';
import { glyph, makeDerivation, makeFaceRef, makeKey, makeRequest, makeRun, sha256 } from './helpers/shaping-fixture';

// Arabic beh + alef: outside the native gate's admitted ranges, so the item
// belongs to the shaped path.
const ARABIC = '\u0627\u0628';
const ARABIC_ITEM = { paragraphText: ARABIC, itemStart: 0, itemEnd: 2 } as const;
const FACE = { glyphCount: 2000, unitsPerEm: 2048 } as const;

function ctxFor(key: ShapeKey, itemText: string): ShapedRunContext {
  return { key, itemText, itemTextSha256: sha256(itemText), ...FACE };
}

describe('clarification 1: opaque epoch identity never collapses through JSON', () => {
  it('distinct empty-object tokens are distinct keys, although JSON equates them', () => {
    const epochA = {};
    const epochB = {};
    // The hazard: JSON serialization cannot tell the two epochs apart.
    expect(JSON.stringify(epochA)).toBe(JSON.stringify(epochB));
    const keyA = makeKey({ ...ARABIC_ITEM, fontEpoch: epochA });
    const keyB = makeKey({ ...ARABIC_ITEM, fontEpoch: epochB });
    const encoder = new ShapeKeyEncoder();
    expect(encoder.encode(keyA)).not.toBe(encoder.encode(keyB));
    // And the same token always encodes to the same key.
    const keyA2 = makeKey({ ...ARABIC_ITEM, fontEpoch: epochA });
    expect(encoder.encode(keyA2)).toBe(encoder.encode(keyA));
  });

  it('a snapshot never serves a stale epoch (superseded generation misses)', () => {
    const staleEpoch = { generation: 5 };
    const currentEpoch = { generation: 6 };
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 6, fontEpoch: currentEpoch });
    const key = makeKey({ ...ARABIC_ITEM, fontEpoch: currentEpoch });
    const run = makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    expect(builder.add(key, run, ctxFor(key, ARABIC)).ok).toBe(true);
    const snapshot = builder.seal();
    expect(snapshot.get(key)).toBe(run);
    // Same everything, but the OLD epoch token: a different key, a miss.
    const staleKey = makeKey({ ...ARABIC_ITEM, fontEpoch: staleEpoch });
    expect(snapshot.get(staleKey)).toBeUndefined();
    expect(snapshot.shaped(staleKey)).toEqual({ state: 'missing' });
    // The stale token cannot even be added to the current snapshot.
    const lateBuilder = new ShapeSnapshotBuilder({ captureGeneration: 6, fontEpoch: currentEpoch });
    const staleRun = makeRun(staleKey, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    expect(lateBuilder.add(staleKey, staleRun, ctxFor(staleKey, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('epoch-mismatch'),
    });
  });

  it('a cancelled batch leaves no partial snapshot', () => {
    const epoch = {};
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch });
    const key = makeKey({ ...ARABIC_ITEM, fontEpoch: epoch });
    const run = makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    expect(builder.add(key, run, ctxFor(key, ARABIC)).ok).toBe(true);
    // Cancellation = the builder is discarded unsealed. A fresh snapshot
    // for the capture has the item fully missing, never half-present.
    const fresh = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch }).seal();
    expect(fresh.size).toBe(0);
    expect(fresh.shaped(key)).toEqual({ state: 'missing' });
  });

  it('snapshot storage is private, deep-frozen, and has no mutator', () => {
    const epoch = {};
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch });
    const key = makeKey({ ...ARABIC_ITEM, fontEpoch: epoch });
    const run = makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    builder.add(key, run, ctxFor(key, ARABIC));
    const snapshot = builder.seal();

    const stored = snapshot.get(key)!;
    // Mutation through every reachable reference fails or has no effect.
    expect(() => (stored.glyphs as unknown as unknown[]).push(glyph(1, 0, 1))).toThrow();
    expect(() => {
      (stored as { advanceX: number }).advanceX = 999;
    }).toThrow();
    expect(() => {
      (stored.binding as { script: string }).script = 'Latn';
    }).toThrow();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect((snapshot as unknown as Record<string, unknown>).set).toBeUndefined();
    expect((snapshot as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect((snapshot as unknown as Record<string, unknown>).clear).toBeUndefined();
    // The keys copy is frozen and is not live storage.
    const keys = snapshot.keys();
    expect(Object.isFrozen(keys)).toBe(true);
    expect(() => (keys as unknown as unknown[]).pop()).toThrow();
    // Lookups are byte-identical to the sealed state after all attempts.
    expect(snapshot.get(key)).toBe(stored);
    expect(stored.advanceX).toBe(1000);
    expect(stored.binding.script).toBe('Arab');
    // The epoch token itself was NOT frozen by sealing (it is host-owned).
    expect(Object.isFrozen(epoch)).toBe(false);
  });
});

describe('identity: offsets, contexts, lines, artifacts (§3.1, §11)', () => {
  it('identical item text at different paragraph offsets never collides', () => {
    const epoch = {};
    const first = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: epoch });
    const second = makeKey({
      paragraphText: ARABIC + ARABIC,
      itemStart: 2,
      itemEnd: 4,
      bufferFlags: ['eot'],
      fontEpoch: epoch,
    });
    const encoder = new ShapeKeyEncoder();
    expect(encoder.encode(first)).not.toBe(encoder.encode(second));
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch, encoder });
    const run = makeRun(first, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    builder.add(first, run, ctxFor(first, ARABIC));
    const snapshot = builder.seal();
    expect(snapshot.get(first)).toBe(run);
    expect(snapshot.get(second)).toBeUndefined();
    // Translation is explicit data: paragraph offset = binding.itemStart + cluster.
    expect(run.binding.itemStart + run.glyphs[0]!.clusterStart).toBe(1);
  });

  it('the same range as a paragraph item and as a line item are different keys', () => {
    const epoch = {};
    const asParagraph = makeKey({ ...ARABIC_ITEM, fontEpoch: epoch });
    const asLine = makeKey({
      paragraphText: ARABIC,
      itemStart: 0,
      itemEnd: 2,
      contextKind: 'line',
      contextStart: 0,
      contextEnd: 2,
      lineLevels: [1, 1],
      fontEpoch: epoch,
    });
    expect(asLine.contextKind).toBe('line');
    expect(asLine.lineLevelsSha256).not.toBeNull();
    expect(asParagraph.lineLevelsSha256).toBeNull();
    const encoder = new ShapeKeyEncoder();
    expect(encoder.encode(asParagraph)).not.toBe(encoder.encode(asLine));
  });

  it('program, face, and engine-artifact identity each distinguish keys', () => {
    const epoch = {};
    const base = makeKey({ ...ARABIC_ITEM, fontEpoch: epoch });
    const encoder = new ShapeKeyEncoder();
    const otherProgram = makeKey({
      ...ARABIC_ITEM,
      fontEpoch: epoch,
      face: makeFaceRef({ programSha256: sha256('a-different-program') }),
    });
    const otherFace = makeKey({ ...ARABIC_ITEM, fontEpoch: epoch, face: makeFaceRef({ faceIndex: 2 }) });
    const otherArtifact = makeKey({
      ...ARABIC_ITEM,
      fontEpoch: epoch,
      engineArtifactSha256: sha256('a-different-wasm-build'),
    });
    expect(encoder.encode(otherProgram)).not.toBe(encoder.encode(base));
    expect(encoder.encode(otherFace)).not.toBe(encoder.encode(base));
    expect(encoder.encode(otherArtifact)).not.toBe(encoder.encode(base));
  });
});

describe('clarification 2: TTC source index vs engine index 0', () => {
  // Synthetic stand-in for the standalone Nirmala case: the host selected
  // source face 1 of a collection; the engine is handed the extracted
  // standalone SFNT for that face and addresses it at index 0.
  const nirmalaStandalone = makeFaceRef({
    programSha256: sha256('synthetic-standalone-sfnt-extracted-from-nirmala-face-1'),
    faceIndex: 1,
  });
  const DEVANAGARI = '\u0915'; // ka — shaped-path text for a Devanagari face

  it('binds source face 1 and engine index 0 to the host-selected program', () => {
    expect(validateSelectedFaceRef(nirmalaStandalone)).toEqual({ ok: true });
    const request: ShapeRequest = {
      ...makeRequest({ paragraphText: DEVANAGARI, itemStart: 0, itemEnd: 1, direction: 'ltr', bidiLevel: 0 }),
      face: nirmalaStandalone,
    };
    expect(requestIdentity(request)).toEqual({
      programSha256: nirmalaStandalone.programSha256,
      faceIndex: 1,
      engineFaceIndex: 0,
    });
    const key = makeKey({
      paragraphText: DEVANAGARI,
      itemStart: 0,
      itemEnd: 1,
      direction: 'ltr',
      bidiLevel: 0,
      script: 'Deva',
      face: nirmalaStandalone,
    });
    expect(key.faceIndex).toBe(1);
    // A run shaped from the standalone program at engine 0 validates
    // against this binding.
    const run = makeRun(key, DEVANAGARI, { glyphs: [glyph(42, 0, 1)] });
    expect(run.binding.engineFaceIndex).toBe(0);
    expect(validateShapedRun(run, ctxFor(key, DEVANAGARI)).ok).toBe(true);
  });

  it('a result claiming engine index 1 is refused as mis-bound', () => {
    // This is a contract refusal of a mis-bound result, NOT a claim that
    // the pinned engine fails at index 1: on the pinned engine, index 1
    // happens to yield the same glyphs for the recorded probe. The
    // contract binds the extraction the host actually made (index 0).
    const key = makeKey({
      paragraphText: DEVANAGARI,
      itemStart: 0,
      itemEnd: 1,
      direction: 'ltr',
      bidiLevel: 0,
      script: 'Deva',
      face: nirmalaStandalone,
    });
    const run = makeRun(key, DEVANAGARI, { glyphs: [glyph(42, 0, 1)] });
    const misBound = { ...run, binding: { ...run.binding, engineFaceIndex: 1 as unknown as 0 } };
    expect(validateShapedRun(misBound, ctxFor(key, DEVANAGARI))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('engineFaceIndex'),
    });
    const badRef = { ...nirmalaStandalone, engineFaceIndex: 1 as unknown as 0 };
    expect(validateSelectedFaceRef(badRef)).toMatchObject({ ok: false });
  });

  it('caller STYLE appearance is not authority for identity', () => {
    const request = makeRequest({ ...ARABIC_ITEM, face: nirmalaStandalone });
    const restyled: ShapeRequest = {
      ...request,
      appearance: { kind: 'canvas', family: 'Some Other Family', bold: true, italic: true, widthFactor: 1, oblique: 0 },
    };
    expect(requestIdentity(restyled)).toEqual(requestIdentity(request));
    // A face record asserted by anyone but the host selection is refused.
    const callerMinted = { ...nirmalaStandalone, source: 'caller-asserted' as unknown as 'host-selection' };
    expect(validateSelectedFaceRef(callerMinted)).toMatchObject({
      ok: false,
      problem: expect.stringContaining('host selection'),
    });
  });
});

describe('admission: protected direct items and request shape (§7.1)', () => {
  it('items the native gate admits are protected and refused at the shaping boundary', () => {
    for (const text of ['fi', 'ffi', 'AV', 'Hello']) {
      expect(classifyItemRoute(text)).toBe('direct');
      const request = makeRequest({ paragraphText: text, itemStart: 0, itemEnd: text.length, direction: 'ltr', bidiLevel: 0 });
      expect(validateShapeRequest(request)).toMatchObject({
        ok: false,
        problem: expect.stringContaining('protected-direct-item'),
      });
    }
    // The prep-state union says so explicitly: admitted items are 'direct',
    // never 'missing' (which would suppress their native rendering).
    const direct: ShapePrepState = { state: 'direct', reason: 'admitted-native' };
    expect(direct.state).toBe('direct');
  });

  it('in a mixed paragraph the admitted side stays direct, the rest may shape', () => {
    const paragraph = `AB ${ARABIC}`;
    const latin = makeRequest({ paragraphText: paragraph, itemStart: 0, itemEnd: 2, direction: 'ltr', bidiLevel: 0 });
    expect(validateShapeRequest(latin)).toMatchObject({
      ok: false,
      problem: expect.stringContaining('protected-direct-item'),
    });
    const arabic = makeRequest({ paragraphText: paragraph, itemStart: 3, itemEnd: 5, direction: 'rtl', bidiLevel: 1, bufferFlags: ['eot'] });
    expect(validateShapeRequest(arabic)).toEqual({ ok: true });
  });

  it('malformed requests refuse: surrogate splits, parity, line levels, variations', () => {
    // Supplementary-plane char + combining mark (mark makes it shaped-path);
    // itemEnd = 1 would split the surrogate pair.
    const split = makeRequest({
      paragraphText: '\u{20000}\u0301',
      itemStart: 0,
      itemEnd: 1,
      direction: 'ltr',
      bidiLevel: 0,
    });
    expect(validateShapeRequest(split)).toMatchObject({
      ok: false,
      problem: expect.stringContaining('surrogate'),
    });
    const parity = makeRequest({ ...ARABIC_ITEM, direction: 'ltr', bidiLevel: 1 });
    expect(validateShapeRequest(parity)).toMatchObject({ ok: false, problem: expect.stringContaining('parity') });
    const lineNoLevels = deriveShapeKey(
      makeRequest({ ...ARABIC_ITEM, contextKind: 'line', contextStart: 0, contextEnd: 2 }),
      makeDerivation({ ...ARABIC_ITEM, contextKind: 'line', contextStart: 0, contextEnd: 2 }),
    );
    expect(lineNoLevels).toMatchObject({ ok: false, problem: expect.stringContaining('lineLevelsSha256') });
    const variations = deriveShapeKey(makeRequest(ARABIC_ITEM), {
      ...makeDerivation(ARABIC_ITEM),
      variationCoords: { wght: 700 },
    });
    expect(variations).toMatchObject({ ok: false, problem: expect.stringContaining('variation') });
    const badFlags = deriveShapeKey(makeRequest(ARABIC_ITEM), {
      ...makeDerivation(ARABIC_ITEM),
      bufferFlags: ['eot'], // item starts its context, so BOT must be present
    });
    expect(badFlags).toMatchObject({ ok: false, problem: expect.stringContaining('bot') });
  });
});

describe('host-boundary validation (§10.1, clarifications 4 and 5)', () => {
  const key = makeKey({ ...ARABIC_ITEM, fontEpoch: {} });
  const baseRun = () =>
    makeRun(key, ARABIC, {
      glyphs: [glyph(101, 1, 2, { xOffset: -25 }), glyph(100, 0, 1)],
      ink: { xMin: -120, yMin: -200, xMax: 990, yMax: 700 },
    });

  it('accepts a valid run with signed metrics (negative offsets and ink)', () => {
    expect(validateShapedRun(baseRun(), ctxFor(key, ARABIC))).toEqual({ ok: true });
  });

  it('clarification 4: the per-glyph bound is not an accumulated-sum bound', () => {
    // An ordinary long run: 40 glyphs, each within the per-glyph bound
    // (64 x 1000 upem), whose TOTAL far exceeds one glyph's bound. It must
    // validate — the total is bounded as a sum, not as a glyph.
    const longText = ARABIC.repeat(20);
    const longKey = makeKey({ paragraphText: longText, itemStart: 0, itemEnd: longText.length, fontEpoch: {} });
    const glyphs = Array.from({ length: 40 }, (_, i) => glyph(100 + i, i, i + 1, { xAdvance: 60000 }));
    const run = makeRun(longKey, longText, { glyphs });
    expect(run.advanceX).toBe(2400000);
    const ctx = { key: longKey, itemText: longText, itemTextSha256: sha256(longText), glyphCount: 2000, unitsPerEm: 1000 };
    expect(validateShapedRun(run, ctx)).toEqual({ ok: true });
    // But ONE glyph over the per-glyph bound refuses.
    const oneBad = makeRun(key, ARABIC, {
      glyphs: [glyph(101, 1, 2, { xAdvance: 64 * 1000 + 1 }), glyph(100, 0, 1)],
    });
    const ctx1000 = { ...ctxFor(key, ARABIC), unitsPerEm: 1000 };
    expect(validateShapedRun(oneBad, ctx1000)).toMatchObject({
      ok: false,
      problem: expect.stringContaining('per-glyph bound'),
    });
  });

  it('both advance sums are validated independently (§10.1.3)', () => {
    const wrongY = makeRun(key, ARABIC, {
      glyphs: [glyph(101, 1, 2, { yAdvance: 10 }), glyph(100, 0, 1, { yAdvance: 10 })],
      advanceY: 0, // x sum is right; the y sum is not
    });
    expect(validateShapedRun(wrongY, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('advance-sum'),
    });
    const nan = makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2, { xAdvance: Number.NaN }), glyph(100, 0, 1)] });
    expect(validateShapedRun(nan, ctxFor(key, ARABIC))).toMatchObject({ ok: false });
  });

  it('GIDs are bounded by the host face record, not by the result', () => {
    const atLimit = makeRun(key, ARABIC, { glyphs: [glyph(2000, 1, 2), glyph(100, 0, 1)] });
    expect(validateShapedRun(atLimit, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('glyph-range'),
    });
    const negative = makeRun(key, ARABIC, { glyphs: [glyph(-1, 1, 2), glyph(100, 0, 1)] });
    expect(validateShapedRun(negative, ctxFor(key, ARABIC))).toMatchObject({ ok: false });
  });

  it('the partition closes exactly: gaps, partial overlaps, split surrogates refuse', () => {
    const gap = makeRun(key, ARABIC, { glyphs: [glyph(100, 0, 1)] });
    expect(validateShapedRun(gap, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('cluster-partition'),
    });
    const overlap = makeRun(key, ARABIC, { glyphs: [glyph(101, 0, 2), glyph(100, 1, 2)] });
    expect(validateShapedRun(overlap, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('partially overlap'),
    });
    // One-to-many: two glyphs SHARING one cluster range is exact, not overlap.
    const shared = makeRun(key, ARABIC, { glyphs: [glyph(101, 0, 2), glyph(102, 0, 2)] });
    expect(validateShapedRun(shared, ctxFor(key, ARABIC))).toEqual({ ok: true });
  });

  it('clarification 5: hidden ignorables are cluster associations, not uncovered ranges', () => {
    const withZwj = '\u0627\u200d'; // alef + ZWJ
    const zwjKey = makeKey({ paragraphText: withZwj, itemStart: 0, itemEnd: 2, fontEpoch: {} });
    // Engine-default-hide: the ZWJ arrives as a real, zero-advance glyph
    // entry with its own cluster — covered, NOT uncovered (§3.3, §4).
    const hidden = makeRun(zwjKey, withZwj, {
      glyphs: [glyph(100, 0, 1), glyph(3, 1, 2, { xAdvance: 0 })],
    });
    expect(validateShapedRun(hidden, ctxFor(zwjKey, withZwj))).toEqual({ ok: true });
    // Claiming the same range BOTH covered and uncovered is a contradiction.
    const doubleClaimed = makeRun(zwjKey, withZwj, {
      glyphs: [glyph(100, 0, 1), glyph(3, 1, 2, { xAdvance: 0 })],
      uncovered: [{ start: 1, end: 2, kind: 'default-ignorable' }],
    });
    expect(validateShapedRun(doubleClaimed, ctxFor(zwjKey, withZwj))).toMatchObject({ ok: false });
    // A genuinely entry-less ZWJ range is uncovered by set difference, and
    // its kind is read off its content.
    const entryLess = makeRun(zwjKey, withZwj, {
      glyphs: [glyph(100, 0, 1)],
      uncovered: [{ start: 1, end: 2, kind: 'default-ignorable' }],
    });
    expect(validateShapedRun(entryLess, ctxFor(zwjKey, withZwj))).toEqual({ ok: true });
    // A ZWJ is not a consumed bidi control; the mislabel refuses.
    const mislabelled = makeRun(zwjKey, withZwj, {
      glyphs: [glyph(100, 0, 1)],
      uncovered: [{ start: 1, end: 2, kind: 'bidi-control' }],
    });
    expect(validateShapedRun(mislabelled, ctxFor(zwjKey, withZwj))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('uncovered-kind'),
    });
    // A consumed bidi control (LRE) is uncovered as 'bidi-control'.
    const withControl = '\u0627\u202a';
    const controlKey = makeKey({ paragraphText: withControl, itemStart: 0, itemEnd: 2, fontEpoch: {} });
    const controlRun = makeRun(controlKey, withControl, {
      glyphs: [glyph(100, 0, 1)],
      uncovered: [{ start: 1, end: 2, kind: 'bidi-control' }],
    });
    expect(validateShapedRun(controlRun, ctxFor(controlKey, withControl))).toEqual({ ok: true });
  });

  it('binding mismatches refuse, including a look-alike epoch token', () => {
    const run = baseRun();
    const wrongScript = { ...run, binding: { ...run.binding, script: 'Latn' } };
    expect(validateShapedRun(wrongScript, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('binding-mismatch'),
    });
    const epochKey = makeKey({ ...ARABIC_ITEM, fontEpoch: { gen: 1 } });
    const epochRun = makeRun(epochKey, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    // A deserialized look-alike with identical JSON is a different token.
    const lookAlike = { ...epochRun, binding: { ...epochRun.binding, fontEpoch: { gen: 1 } } };
    expect(JSON.stringify(lookAlike.binding.fontEpoch)).toBe(JSON.stringify(epochRun.binding.fontEpoch));
    expect(validateShapedRun(lookAlike, ctxFor(epochKey, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('fontEpoch'),
    });
    expect(validateShapeKey(epochKey)).toEqual({ ok: true });
  });

  it('snapshot aggregate accounting refuses past the cap (§10.1.7)', () => {
    const epoch = {};
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch });
    // Each distinct paragraph gives a distinct key over the same item; each
    // run is near the per-item wire cap (9,300 glyphs over a 2,325-unit
    // item, 4 sharing each unit cluster), so the 8 MiB aggregate refuses
    // after ~32 runs.
    const itemText = '\u0627'.repeat(2325);
    const glyphs = Array.from({ length: 9300 }, (_, g) =>
      glyph(100 + (g % 50), Math.floor(g / 4), Math.floor(g / 4) + 1),
    );
    let added = 0;
    for (let i = 0; i < 40; i++) {
      const paragraphText = itemText + String(i);
      const itemKey = makeKey({ paragraphText, itemStart: 0, itemEnd: itemText.length, fontEpoch: epoch });
      const run = makeRun(itemKey, itemText, { glyphs });
      const result = builder.add(itemKey, run, { itemText, itemTextSha256: sha256(itemText), ...FACE });
      if (!result.ok) {
        expect(result.problem).toContain('snapshot-aggregate-cap');
        break;
      }
      added++;
    }
    expect(added).toBeGreaterThan(0);
    expect(added).toBeLessThan(40);
  });
});
