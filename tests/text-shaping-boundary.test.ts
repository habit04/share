/**
 * Boundary controls for the 12.5 lead-review correction round
 * (corrections 1–6 and addenda A–E). These pin the refusal boundaries
 * around the delivered contract: item/digest binding, sealed-snapshot
 * integrity, the extraction code range, lossless wire representability,
 * fail-closed boundary safety, the transport ledger's phase contract,
 * and structural no-throw validation. Synthetic interface tests only —
 * not font/PDF/Windows/native acceptance.
 */
import { describe, expect, it } from 'vitest';
import {
  SHAPING_LIMITS,
  deriveShapeKey,
  validateShapeKey,
  validateShapeRequest,
  type ShapeKey,
  type ShapedGlyph,
} from '../src/core/text-shaping';
import {
  ShapeKeyEncoder,
  ShapeSnapshotBuilder,
  checkVisualClusterOrder,
  validateShapedRun,
  type ShapedRunContext,
} from '../src/core/text-shaping-snapshot';
import {
  SHAPED_RUN_WIRE,
  ShapeTransportLedger,
  jobChargeBytes,
  preflightShapedResult,
} from '../src/core/text-shaping-transport';
import {
  assignExtractionCodes,
  checkItemBoundarySafety,
  type SafeUnitAgreementProof,
} from '../src/core/text-shaping-extraction';
import { glyph, makeDerivation, makeKey, makeRequest, makeRun, sha256 } from './helpers/shaping-fixture';

const ARABIC = '\u0627\u0628';
const FACE = { glyphCount: 2000, unitsPerEm: 2048 } as const;

function ctxFor(key: ShapeKey, itemText: string): ShapedRunContext {
  return { key, itemText, itemTextSha256: sha256(itemText), ...FACE };
}

describe('correction 1: item/digest binding boundaries', () => {
  const epoch = {};
  const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: epoch });
  const goodRun = () => makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });

  it('a longer item than the key span refuses', () => {
    const longer = ARABIC + ARABIC[0]!;
    const run = makeRun(key, longer, { glyphs: [glyph(100, 0, 1), glyph(101, 1, 2), glyph(102, 2, 3)] });
    expect(validateShapedRun(run, ctxFor(key, longer))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('item-binding'),
    });
  });

  it('an omitted trusted digest refuses, in validation and in the builder', () => {
    const ctx = { key, itemText: ARABIC, ...FACE } as ShapedRunContext;
    expect(validateShapedRun(goodRun(), ctx)).toMatchObject({
      ok: false,
      problem: expect.stringContaining('trusted expected item digest is required'),
    });
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch });
    const addCtx = { itemText: ARABIC, ...FACE } as Omit<ShapedRunContext, 'key'>;
    expect(builder.add(key, goodRun(), addCtx)).toMatchObject({ ok: false });
  });

  it('a malformed trusted digest refuses', () => {
    const ctx = { key, itemText: ARABIC, itemTextSha256: 'not-a-digest', ...FACE };
    expect(validateShapedRun(goodRun(), ctx)).toMatchObject({
      ok: false,
      problem: expect.stringContaining('item-binding'),
    });
  });

  it('an equal-length item whose binding carries a different text digest refuses', () => {
    const run = goodRun();
    const forged = { ...run, binding: { ...run.binding, itemTextSha256: sha256('different text') } };
    expect(validateShapedRun(forged, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('binding-mismatch'),
    });
  });

  it('a valid nonzero-offset item validates against its span and digest', () => {
    const paragraph = `AB ${ARABIC}`;
    const offsetKey = makeKey({ paragraphText: paragraph, itemStart: 3, itemEnd: 5, bufferFlags: ['eot'], fontEpoch: {} });
    const run = makeRun(offsetKey, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    expect(validateShapedRun(run, ctxFor(offsetKey, ARABIC))).toEqual({ ok: true });
  });
});

describe('correction 2: sealed-snapshot integrity beyond the lead case', () => {
  it('a constructor-supplied encoder mutated after sealing cannot redirect a serve', () => {
    const epoch = {};
    const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: epoch });
    const run = makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    const encoder = new ShapeKeyEncoder();
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch, encoder });
    expect(builder.add(key, run, ctxFor(key, ARABIC)).ok).toBe(true);
    const storedEncoding = encoder.encode(key);
    const snapshot = builder.seal();
    const other = { ...key, programSha256: sha256('another font program') };
    encoder.encode = () => storedEncoding;
    expect(snapshot.get(other)).toBeUndefined();
    // The true key is still served under this poisoning: the stored
    // binding comparison, not the encoding, decides identity.
    expect(snapshot.get(key)).toBe(run);
  });

  it('a mutated encodeToken cannot make a snapshot serve the wrong program either', () => {
    const epoch = {};
    const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: epoch });
    const run = makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    const encoder = new ShapeKeyEncoder();
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch, encoder });
    builder.add(key, run, ctxFor(key, ARABIC));
    const snapshot = builder.seal();
    const other = { ...key, programSha256: sha256('another font program') };
    encoder.encodeToken = () => 'token#1';
    // Worst case under token poisoning is a miss, never a wrong serve.
    expect(snapshot.get(other)).toBeUndefined();
  });
});

describe('addendum B: plain data and runtime-frozen caps', () => {
  it('a getter-backed run metric is refused at snapshot admission, before any read of it', () => {
    const epoch = {};
    const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: epoch });
    const run = makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    let reads = 0;
    const evil = { ...run };
    Object.defineProperty(evil, 'advanceX', {
      enumerable: true,
      get: () => {
        reads++;
        return 1000;
      },
    });
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch });
    expect(builder.add(key, evil, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('non-plain-data'),
    });
    expect(reads).toBe(0);
  });

  it('a getter-backed key field is refused at snapshot admission', () => {
    const epoch = {};
    const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: epoch });
    const evilKey = { ...key };
    Object.defineProperty(evilKey, 'script', { enumerable: true, get: () => 'Arab' });
    const run = makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch });
    expect(builder.add(evilKey, run, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('non-plain-data'),
    });
  });

  it('the limits and wire tables are frozen at runtime, not only as const', () => {
    expect(Object.isFrozen(SHAPING_LIMITS)).toBe(true);
    expect(Reflect.set(SHAPING_LIMITS, 'maxWorkers', 99)).toBe(false);
    expect(SHAPING_LIMITS.maxWorkers).toBe(2);
    expect(Object.isFrozen(SHAPED_RUN_WIRE)).toBe(true);
    expect(SHAPED_RUN_WIRE.headerFields).toContain('advanceX:i64');
    expect(SHAPED_RUN_WIRE.headerFields).toContain('ink.xMax:i32');
  });
});

describe('addendum A: validation refuses malformed structures without throwing', () => {
  const epoch = {};
  const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: epoch });
  const run = makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });

  it('request and key validation refuse nulls, missing arrays, and bad identities', () => {
    expect(validateShapeRequest(null as unknown as Parameters<typeof validateShapeRequest>[0]).ok).toBe(false);
    expect(validateShapeKey(null as unknown as ShapeKey).ok).toBe(false);
    expect(validateShapeKey({ ...key, features: null } as unknown as ShapeKey)).toMatchObject({ ok: false });
    expect(validateShapeKey({ ...key, bufferFlags: undefined } as unknown as ShapeKey)).toMatchObject({ ok: false });
    expect(validateShapeKey({ ...key, variationCoords: null } as unknown as ShapeKey)).toMatchObject({ ok: false });
    expect(validateShapeKey({ ...key, paragraphSha256: 'short' })).toMatchObject({
      ok: false,
      problem: expect.stringContaining('paragraphSha256'),
    });
    expect(validateShapeKey({ ...key, engine: 'some other engine' })).toMatchObject({ ok: false });
    expect(validateShapeKey({ ...key, script: 'Ar' })).toMatchObject({ ok: false });
    expect(validateShapeKey({ ...key, contextKind: 'bogus' } as unknown as ShapeKey)).toMatchObject({ ok: false });
    const derived = deriveShapeKey(
      makeRequest({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2 }),
      { ...makeDerivation({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2 }), bufferFlags: null } as unknown as ReturnType<typeof makeDerivation>,
    );
    expect(derived.ok).toBe(false);
  });

  it('run validation refuses missing parts and non-positive host face data', () => {
    const ctx = ctxFor(key, ARABIC);
    expect(validateShapedRun(null as unknown as typeof run, ctx).ok).toBe(false);
    expect(validateShapedRun({ ...run, glyphs: null } as unknown as typeof run, ctx).ok).toBe(false);
    expect(validateShapedRun({ ...run, uncovered: undefined } as unknown as typeof run, ctx).ok).toBe(false);
    expect(validateShapedRun({ ...run, ink: null } as unknown as typeof run, ctx).ok).toBe(false);
    expect(validateShapedRun({ ...run, binding: null } as unknown as typeof run, ctx).ok).toBe(false);
    expect(validateShapedRun({ ...run, glyphs: [null] } as unknown as typeof run, ctx).ok).toBe(false);
    expect(validateShapedRun(run, { ...ctx, glyphCount: 0 }).ok).toBe(false);
    expect(validateShapedRun(run, { ...ctx, unitsPerEm: -2048 }).ok).toBe(false);
    expect(validateShapedRun(run, { ...ctx, key: null } as unknown as ShapedRunContext).ok).toBe(false);
  });
});

describe('addendum C: capture generations and visual cluster order', () => {
  it('two snapshots of one epoch but different generations each serve only their own runs', () => {
    // Generation ownership control: the epoch token is shared, the
    // builders are distinct owners. Neither snapshot can serve the other
    // generation's run for the same key. (Discarding a builder is not
    // itself a cancellation proof for in-flight work — that ownership
    // belongs to the future preparation layer; what is pinned here is
    // that a sealed snapshot's contents are exactly its own builder's
    // validated entries, attributed by captureGeneration.)
    const epoch = { lineage: 'shared' };
    const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: epoch });
    const runGen1 = makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    const runGen2 = makeRun(key, ARABIC, {
      glyphs: [glyph(101, 1, 2, { xAdvance: 900 }), glyph(100, 0, 1, { xAdvance: 900 })],
    });
    const builder1 = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch });
    const builder2 = new ShapeSnapshotBuilder({ captureGeneration: 2, fontEpoch: epoch });
    expect(builder1.add(key, runGen1, ctxFor(key, ARABIC)).ok).toBe(true);
    expect(builder2.add(key, runGen2, ctxFor(key, ARABIC)).ok).toBe(true);
    const snap1 = builder1.seal();
    const snap2 = builder2.seal();
    expect(snap1.captureGeneration).toBe(1);
    expect(snap2.captureGeneration).toBe(2);
    expect(snap1.get(key)).toBe(runGen1);
    expect(snap2.get(key)).toBe(runGen2);
    expect(snap1.get(key)).not.toBe(runGen2);
  });

  it('visual cluster order: monotone in the item direction, equal allowed, swapped refused', () => {
    const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: {} });
    const decreasing = makeRun(key, ARABIC, { glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)] });
    const increasing = makeRun(key, ARABIC, { glyphs: [glyph(100, 0, 1), glyph(101, 1, 2)] });
    const shared = makeRun(key, ARABIC, { glyphs: [glyph(101, 0, 2), glyph(102, 0, 2)] });
    expect(checkVisualClusterOrder(decreasing, 'rtl')).toEqual({ ok: true });
    expect(checkVisualClusterOrder(increasing, 'ltr')).toEqual({ ok: true });
    expect(checkVisualClusterOrder(shared, 'ltr')).toEqual({ ok: true });
    expect(checkVisualClusterOrder(shared, 'rtl')).toEqual({ ok: true });
    // The same stored sequences read in the wrong direction are swapped
    // distinct clusters — including the logical-order RTL fake shape.
    expect(checkVisualClusterOrder(increasing, 'rtl')).toMatchObject({
      ok: false,
      problem: expect.stringContaining('cluster-order'),
    });
    expect(checkVisualClusterOrder(decreasing, 'ltr')).toMatchObject({ ok: false });
  });
});

describe('correction 3: code-range boundaries', () => {
  const oneGlyph = [{ glyph: 2, clusterStart: 0, clusterEnd: 1 }];

  it('zero-glyph calls are defined no-ops, including at the exhausted sentinel', () => {
    expect(assignExtractionCodes({ glyphs: [], itemText: '', firstCode: 1 })).toEqual({
      ok: true,
      value: { assignments: [], nextCode: 1 },
    });
    expect(assignExtractionCodes({ glyphs: [], itemText: '', firstCode: 65535 })).toEqual({
      ok: true,
      value: { assignments: [], nextCode: 65535 },
    });
    // The sentinel is a resting state, not an assignable code.
    expect(assignExtractionCodes({ glyphs: oneGlyph, itemText: 'A', firstCode: 65535 }).ok).toBe(false);
    expect(assignExtractionCodes({ glyphs: [], itemText: '', firstCode: 0 }).ok).toBe(false);
    expect(assignExtractionCodes({ glyphs: oneGlyph, itemText: 'A', firstCode: 1.5 }).ok).toBe(false);
  });

  it('an explicit maxCodes may narrow but never raise or invalidate the budget', () => {
    expect(assignExtractionCodes({ glyphs: oneGlyph, itemText: 'A', firstCode: 10, maxCodes: 10 }).ok).toBe(true);
    expect(assignExtractionCodes({ glyphs: oneGlyph, itemText: 'A', firstCode: 10, maxCodes: 9 }).ok).toBe(false);
    expect(assignExtractionCodes({ glyphs: oneGlyph, itemText: 'A', firstCode: 1, maxCodes: 65535 }).ok).toBe(false);
    expect(assignExtractionCodes({ glyphs: oneGlyph, itemText: 'A', firstCode: 1, maxCodes: 0 }).ok).toBe(false);
  });

  it('malformed glyph and cluster inputs refuse before any substring is taken', () => {
    const supplementary = '\u{20000}';
    // A [0, 1) cluster over a supplementary scalar would extract a lone
    // high surrogate; a [1, 2) cluster a lone low surrogate. Both refuse.
    expect(
      assignExtractionCodes({ glyphs: [{ glyph: 9, clusterStart: 0, clusterEnd: 1 }], itemText: supplementary, firstCode: 1 }),
    ).toMatchObject({ ok: false, problem: expect.stringContaining('lone-surrogate') });
    expect(
      assignExtractionCodes({ glyphs: [{ glyph: 9, clusterStart: 1, clusterEnd: 2 }], itemText: supplementary, firstCode: 1 }).ok,
    ).toBe(false);
    expect(
      assignExtractionCodes({ glyphs: [{ glyph: 9, clusterStart: 0, clusterEnd: 2 }], itemText: supplementary, firstCode: 1 }).ok,
    ).toBe(true);
    expect(assignExtractionCodes({ glyphs: [{ glyph: -1, clusterStart: 0, clusterEnd: 1 }], itemText: 'A', firstCode: 1 }).ok).toBe(false);
    expect(assignExtractionCodes({ glyphs: [{ glyph: 2.5, clusterStart: 0, clusterEnd: 1 }], itemText: 'A', firstCode: 1 }).ok).toBe(false);
    expect(assignExtractionCodes({ glyphs: [{ glyph: 2, clusterStart: 0, clusterEnd: 2 }], itemText: 'A', firstCode: 1 }).ok).toBe(false);
  });
});

describe('correction 4 / addendum D: lossless representability boundaries', () => {
  const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: {} });

  it('fractional glyph metrics and fractional or out-of-range ink refuse', () => {
    const fraction = makeRun(key, ARABIC, {
      glyphs: [glyph(101, 1, 2, { xAdvance: 500.5 }), glyph(100, 0, 1)],
    });
    expect(validateShapedRun(fraction, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('integer font-unit'),
    });
    const inkFraction = makeRun(key, ARABIC, {
      glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)],
      ink: { xMin: 0, yMin: -200, xMax: 990.5, yMax: 700 },
    });
    expect(validateShapedRun(inkFraction, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('ink-bounds'),
    });
    const inkOverflow = makeRun(key, ARABIC, {
      glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)],
      ink: { xMin: 0, yMin: -200, xMax: 2147483648, yMax: 700 },
    });
    expect(validateShapedRun(inkOverflow, ctxFor(key, ARABIC))).toMatchObject({ ok: false });
    // The full signed i32 range itself is representable and accepted.
    const inkEdge = makeRun(key, ARABIC, {
      glyphs: [glyph(101, 1, 2), glyph(100, 0, 1)],
      ink: { xMin: -2147483648, yMin: -200, xMax: 2147483647, yMax: 700 },
    });
    expect(validateShapedRun(inkEdge, ctxFor(key, ARABIC))).toEqual({ ok: true });
  });

  it('preflight refuses non-integer item lengths and unsafe counts', () => {
    for (const itemUtf16Length of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(preflightShapedResult({ itemUtf16Length, counts: { glyphCount: 1, uncoveredCount: 0 } })).toMatchObject({
        ok: false,
        problem: expect.stringContaining('preflight-counts'),
      });
    }
    expect(
      preflightShapedResult({ itemUtf16Length: 10, counts: { glyphCount: 2 ** 53, uncoveredCount: 0 } }).ok,
    ).toBe(false);
  });
});

describe('correction 5: boundary-safety proof boundaries', () => {
  const clusters: readonly (readonly [number, number])[] = [
    [0, 8],
    [8, 16],
  ];
  // Round-2 correction 5: the fixture proof binds the full shape
  // identity plus the ownership marker, and the base input carries
  // the trusted expectation. The identity is a real derived key over
  // shaped (Arabic) text — direct Latin text never reaches the shaper
  // and has no ShapeKey (§7.1) — and the bound context digest is that
  // key's own context digest.
  // Round-3 correction R3: the key is derived over the SIXTEEN-
  // character context the boundary input below describes. The round-2
  // fixture derived it over an eight-character paragraph while the
  // boundary claimed a sixteen-character context, so the digest bound
  // in every field was an eight-character context's digest presented
  // as a sixteen-character context's — the incoherent fixture the R3
  // review flagged. Assertions unchanged.
  const expectedKey = makeKey({ paragraphText: '\u0627\u0628'.repeat(8), itemStart: 0, itemEnd: 8 });
  const contextSha256 = expectedKey.contextSha256;
  const agreementSha256 = sha256('synthetic-agreed-result');
  const proof: SafeUnitAgreementProof = {
    contextSha256,
    itemStart: 0,
    itemEnd: 8,
    key: expectedKey,
    source: 'preparation-comparison',
    agreementSha256,
  };

  it('the eight-mark split with the provenance flag flipped true still refuses without a proof', () => {
    const result = checkItemBoundarySafety({
      contextStart: 0,
      contextEnd: 16,
      itemStart: 0,
      itemEnd: 8,
      referenceClusters: clusters,
      producedByShapedRegionRules: true,
    });
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.problem).toContain('agreement proof');
  });

  it('a proof bound to another context or another range proves nothing', () => {
    const base = {
      contextStart: 0,
      contextEnd: 16,
      itemStart: 0,
      itemEnd: 8,
      referenceClusters: clusters,
      producedByShapedRegionRules: true,
      contextSha256,
      expectedKey,
      expectedAgreementSha256: agreementSha256,
    } as const;
    expect(checkItemBoundarySafety({ ...base, safeUnitProof: { ...proof, contextSha256: sha256('other context') } }).safe).toBe(false);
    expect(checkItemBoundarySafety({ ...base, safeUnitProof: { ...proof, itemEnd: 9 } }).safe).toBe(false);
    expect(checkItemBoundarySafety({ ...base, safeUnitProof: { ...proof, agreementSha256: 'nope' } }).safe).toBe(false);
    // And a correctly bound proof admits — the synthetic stand-in for the
    // comparison a future preparation layer will actually perform.
    expect(checkItemBoundarySafety({ ...base, safeUnitProof: proof })).toEqual({
      safe: true,
      basis: 'shaped-region-item',
    });
  });

  it('equally malformed ranges are refused as malformed, never as a whole context', () => {
    expect(
      checkItemBoundarySafety({
        contextStart: 8,
        contextEnd: 8,
        itemStart: 8,
        itemEnd: 8,
        referenceClusters: null,
        producedByShapedRegionRules: false,
      }),
    ).toMatchObject({ safe: false, problem: expect.stringContaining('malformed-range') });
    expect(
      checkItemBoundarySafety({
        contextStart: 10,
        contextEnd: 0,
        itemStart: 10,
        itemEnd: 0,
        referenceClusters: null,
        producedByShapedRegionRules: false,
      }).safe,
    ).toBe(false);
    expect(
      checkItemBoundarySafety({
        contextStart: 0,
        contextEnd: 10,
        itemStart: 0.5,
        itemEnd: 4,
        referenceClusters: null,
        producedByShapedRegionRules: true,
      }).safe,
    ).toBe(false);
  });
});

describe('correction 6 / addendum E: ledger phase contract and the 32 MiB peak', () => {
  it('two maximum jobs exactly fill the cap; one more result copy does not fit', () => {
    // P = 8,257,536 program bytes, R = 262,144 result bytes: one job
    // charges 2P + R = 16,777,216; two jobs charge exactly 32 MiB.
    const perJob = jobChargeBytes(8_257_536, 262_144);
    expect(perJob).toBe(16_777_216);
    const ledger = new ShapeTransportLedger();
    expect(ledger.reserve('job-1', perJob).ok).toBe(true);
    expect(ledger.reserve('job-2', perJob).ok).toBe(true);
    expect(ledger.totalChargedBytes).toBe(SHAPING_LIMITS.maxAggregateTransportBytes);
    // Under clone semantics a second simultaneous result copy per job
    // would need +262,144 more; the cap refuses it outright. The single
    // allowance is exact only because the result crosses detached.
    expect(ledger.reserve('one-more-copy', jobChargeBytes(0, 262_144))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('transport-aggregate-cap'),
    });
  });

  it('a successful job releases only after its result is validated or discarded', () => {
    const ledger = new ShapeTransportLedger();
    const charge = jobChargeBytes(1000, 500);
    expect(ledger.reserve('job', charge).ok).toBe(true);
    expect(ledger.activate('job').ok).toBe(true);
    // Discard before any terminal outcome: there is no result yet.
    expect(ledger.noteResultDiscarded('job')).toMatchObject({ ok: false });
    expect(ledger.noteTerminal('job', 'success').ok).toBe(true);
    expect(ledger.jobState('job')).toMatchObject({ resultTransferred: true, resultValidated: false, resultDiscarded: false });
    // Reverse order: exit-join before the result reaches a terminal
    // phase is refused, and the charge is still fully held.
    expect(ledger.noteWorkerExited('job')).toMatchObject({
      ok: false,
      problem: expect.stringContaining('result-phase'),
    });
    expect(ledger.totalChargedBytes).toBe(charge);
    expect(ledger.noteResultDiscarded('job').ok).toBe(true);
    expect(ledger.noteResultDiscarded('job')).toMatchObject({ ok: false });
    expect(ledger.noteWorkerExited('job')).toMatchObject({ ok: true, releasedBytes: charge });
    expect(ledger.totalChargedBytes).toBe(0);
  });

  it('validated and discarded are mutually exclusive terminal phases of the result', () => {
    const ledger = new ShapeTransportLedger();
    ledger.reserve('job', 100);
    ledger.activate('job');
    ledger.noteTerminal('job', 'success');
    expect(ledger.noteResultValidated('job').ok).toBe(true);
    expect(ledger.noteResultDiscarded('job')).toMatchObject({ ok: false });
    expect(ledger.noteWorkerExited('job').ok).toBe(true);
    // A job that produced no result needs no result phase at all.
    const cancelled = new ShapeTransportLedger();
    cancelled.reserve('job', 100);
    cancelled.activate('job');
    cancelled.noteTerminal('job', 'cancelled');
    expect(cancelled.jobState('job')).toMatchObject({ resultTransferred: false });
    expect(cancelled.noteWorkerExited('job').ok).toBe(true);
  });
});

describe('round-2 correction 2: canonical array admission binds iteration to stored data', () => {
  const epoch = {};
  const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: epoch });

  it('a sparse glyph array is refused at admission: a hole is not stored data', () => {
    const sparse: ShapedGlyph[] = [];
    sparse[0] = glyph(101, 1, 2);
    sparse.length = 2;
    // Explicit ink: the run must be constructible without iterating the
    // sparse array, so the refusal under test is the admission walk's.
    const run = makeRun(key, ARABIC, { glyphs: sparse, ink: { xMin: 0, yMin: -200, xMax: 1000, yMax: 700 } });
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch });
    expect(builder.add(key, run, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('non-plain-data'),
    });
  });

  it('an Array-subclass glyph array is refused at admission', () => {
    class GlyphArray extends Array<ShapedGlyph> {}
    const arr = GlyphArray.from([glyph(101, 1, 2), glyph(100, 0, 1)]);
    const run = makeRun(key, ARABIC, { glyphs: arr });
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch });
    expect(builder.add(key, run, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('non-plain-data'),
    });
  });

  it('a slot that exists only as an inherited index getter is refused', () => {
    const proto: Record<string, unknown> = {};
    Object.defineProperty(proto, '1', { enumerable: true, get: () => glyph(100, 0, 1) });
    Object.setPrototypeOf(proto, Array.prototype);
    const arr: ShapedGlyph[] = [glyph(101, 1, 2)];
    arr.length = 2;
    Object.setPrototypeOf(arr, proto);
    const run = makeRun(key, ARABIC, { glyphs: arr });
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: epoch });
    expect(builder.add(key, run, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('non-plain-data'),
    });
  });

  it('validateShapedRun reads indexed data: an iterator cannot hide out-of-range GIDs from direct validation', () => {
    const indexed = [glyph(999999, 1, 2), glyph(999999, 0, 1)];
    Object.defineProperty(indexed, Symbol.iterator, {
      value: function* () {
        yield glyph(101, 1, 2);
        yield glyph(100, 0, 1);
      },
      enumerable: false,
    });
    const run = makeRun(key, ARABIC, { glyphs: indexed, ink: { xMin: 0, yMin: -200, xMax: 1000, yMax: 700 } });
    expect(validateShapedRun(run, ctxFor(key, ARABIC))).toMatchObject({
      ok: false,
      problem: expect.stringContaining('glyph-range'),
    });
  });
});

describe('round-2 correction 3: malformed scalar formatting', () => {
  it('a symbol buffer flag refuses without throwing during refusal formatting', () => {
    const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: {} });
    const bad = { ...key, bufferFlags: [Symbol('bot-ish')] } as unknown as ShapeKey;
    expect(validateShapeKey(bad).ok).toBe(false);
  });

  it('a null builder run refuses before any dereference', () => {
    const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: {} });
    const builder = new ShapeSnapshotBuilder({ captureGeneration: 1, fontEpoch: key.fontEpoch });
    expect(builder.add(key, null as unknown as Parameters<typeof builder.add>[1], ctxFor(key, ARABIC)).ok).toBe(false);
  });
});

describe('round-2 correction 5: safe-unit proof full binding fakes', () => {
  const clusters: readonly (readonly [number, number])[] = [
    [0, 8],
    [8, 16],
  ];
  // Round-3 correction R3: derived over the sixteen-character context
  // the base input describes (see the correction-5 block above).
  const boundKey = makeKey({ paragraphText: '\u0627\u0628'.repeat(8), itemStart: 0, itemEnd: 8 });
  const contextSha256 = boundKey.contextSha256;
  const agreementSha256 = sha256('synthetic-agreed-result');
  const boundProof: SafeUnitAgreementProof = {
    contextSha256,
    itemStart: 0,
    itemEnd: 8,
    key: boundKey,
    source: 'preparation-comparison',
    agreementSha256,
  };
  const base = {
    contextStart: 0,
    contextEnd: 16,
    itemStart: 0,
    itemEnd: 8,
    referenceClusters: clusters,
    producedByShapedRegionRules: true,
    contextSha256,
    safeUnitProof: boundProof,
    expectedKey: boundKey,
    expectedAgreementSha256: agreementSha256,
  } as const;

  it('a fully bound proof with a matching trusted expectation admits', () => {
    expect(checkItemBoundarySafety(base)).toEqual({ safe: true, basis: 'shaped-region-item' });
  });

  it('a proof minted under another program refuses', () => {
    const forged = { ...boundProof, key: { ...boundKey, programSha256: sha256('another program') } };
    expect(checkItemBoundarySafety({ ...base, safeUnitProof: forged }).safe).toBe(false);
  });

  it('a proof minted under another engine artifact refuses', () => {
    const forged = { ...boundProof, key: { ...boundKey, engineArtifactSha256: sha256('another artifact') } };
    expect(checkItemBoundarySafety({ ...base, safeUnitProof: forged }).safe).toBe(false);
  });

  it('a proof minted under other shaping settings refuses', () => {
    const forged = { ...boundProof, key: { ...boundKey, features: ['liga=off'] } };
    expect(checkItemBoundarySafety({ ...base, safeUnitProof: forged }).safe).toBe(false);
  });

  it('a proof minted under another epoch refuses (identity, not value)', () => {
    expect(checkItemBoundarySafety({ ...base, expectedKey: { ...boundKey, fontEpoch: {} } }).safe).toBe(false);
  });

  it('a well-formed but unexpected agreement digest refuses', () => {
    const forged = { ...boundProof, agreementSha256: sha256('a different agreed result') };
    expect(checkItemBoundarySafety({ ...base, safeUnitProof: forged }).safe).toBe(false);
  });

  it('an absent trusted expectation fails closed', () => {
    expect(checkItemBoundarySafety({ ...base, expectedKey: undefined }).safe).toBe(false);
    expect(checkItemBoundarySafety({ ...base, expectedAgreementSha256: undefined }).safe).toBe(false);
  });

  it('a proof without the preparation-ownership marker refuses', () => {
    const forged = { ...boundProof, source: 'producer-asserted' } as unknown as SafeUnitAgreementProof;
    expect(checkItemBoundarySafety({ ...base, safeUnitProof: forged }).safe).toBe(false);
  });
});
