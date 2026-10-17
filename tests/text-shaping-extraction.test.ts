/**
 * Synthetic contract tests for the 12.5 extraction identity, subsetter
 * handoff, outline-validation obligations, and item-boundary safety
 * (contract v4 §5.2–§5.3, §10.2–§10.3, §2.5; clarifications 5 and 6).
 * Pure interface tests — not font/PDF/native acceptance.
 */
import { describe, expect, it } from 'vitest';
import { ok, refuse, type ShapeCheck } from '../src/core/text-shaping';
import {
  assignExtractionCodes,
  checkItemBoundarySafety,
  fallbackExtraction,
  subsetterGlyphSet,
  validateRunOutlines,
  type ShapedGlyphOutlineValidator,
} from '../src/core/text-shaping-extraction';
import { glyph, makeKey, makeRun, sha256 } from './helpers/shaping-fixture';

describe('extraction identity: occurrence-sensitive codes (§5.2, §5.3)', () => {
  it('a repeated GID inside one cluster extracts once, never twice', () => {
    // The reviewer's counterexample: logical `A` shapes to [G2, G2] in one
    // cluster. Occurrence identity gives the two slots two codes; only
    // the anchor (occurrence 0) carries the source; the repeat's code maps
    // to the empty string via an explicit bfchar entry.
    const result = assignExtractionCodes({
      glyphs: [
        { glyph: 2, clusterStart: 0, clusterEnd: 1 },
        { glyph: 2, clusterStart: 0, clusterEnd: 1 },
      ],
      itemText: 'A',
      firstCode: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [anchor, repeat] = result.value.assignments;
    expect(anchor).toMatchObject({ code: 1, glyph: 2, occurrence: 0, role: 'anchor', toUnicode: 'A' });
    expect(repeat).toMatchObject({ code: 2, glyph: 2, occurrence: 1, role: 'non-anchor', toUnicode: '' });
    expect(fallbackExtraction(result.value.assignments)).toBe('A');
    expect(result.value.nextCode).toBe(3);
  });

  it('aliased glyphs recover their own texts, in either input order', () => {
    // Two scalars aliasing one glyph in two clusters (§5.1 alias case).
    for (const text of ['AB', 'BA']) {
      const result = assignExtractionCodes({
        glyphs: [
          { glyph: 7, clusterStart: 0, clusterEnd: 1 },
          { glyph: 7, clusterStart: 1, clusterEnd: 2 },
        ],
        itemText: text,
        firstCode: 1,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(fallbackExtraction(result.value.assignments)).toBe(text);
      expect(result.value.assignments.map((a) => a.code)).toEqual([1, 2]);
    }
  });

  it('codes are document-unique: the same (glyph, cluster) in another run gets fresh codes', () => {
    const glyphs = [{ glyph: 2, clusterStart: 0, clusterEnd: 1 }];
    const first = assignExtractionCodes({ glyphs, itemText: 'A', firstCode: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = assignExtractionCodes({ glyphs, itemText: 'A', firstCode: first.value.nextCode });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.assignments[0]!.code).not.toBe(first.value.assignments[0]!.code);
    // Neither run inherits the other's extraction: each anchor still maps
    // to its own run's source under its own code.
    expect(fallbackExtraction(second.value.assignments)).toBe('A');
  });

  it('supplementary-plane aliases keep their own substrings', () => {
    const text = '\u{20000}\u{20001}'; // two supplementary scalars, 2 UTF-16 units each
    const both = assignExtractionCodes({
      glyphs: [
        { glyph: 9, clusterStart: 0, clusterEnd: 2 },
        { glyph: 9, clusterStart: 2, clusterEnd: 4 },
      ],
      itemText: text,
      firstCode: 1,
    });
    expect(both.ok).toBe(true);
    if (both.ok) expect(fallbackExtraction(both.value.assignments)).toBe(text);
    // A supplementary scalar aliasing a BMP-mapped glyph, and vice versa.
    const mixedText = '\u{20000}B';
    const mixed = assignExtractionCodes({
      glyphs: [
        { glyph: 9, clusterStart: 0, clusterEnd: 2 },
        { glyph: 9, clusterStart: 2, clusterEnd: 3 },
      ],
      itemText: mixedText,
      firstCode: 1,
    });
    expect(mixed.ok).toBe(true);
    if (mixed.ok) expect(fallbackExtraction(mixed.value.assignments)).toBe(mixedText);
  });

  it('the code budget refuses rather than merging occurrences (§5.2)', () => {
    const result = assignExtractionCodes({
      glyphs: Array.from({ length: 10 }, () => ({ glyph: 2, clusterStart: 0, clusterEnd: 1 })),
      itemText: 'A',
      firstCode: 65530,
    });
    expect(result).toMatchObject({ ok: false, problem: expect.stringContaining('code-budget') });
  });

  it('many-to-one clusters recover the whole substring exactly once', () => {
    const result = assignExtractionCodes({
      glyphs: [{ glyph: 55, clusterStart: 0, clusterEnd: 3 }],
      itemText: 'abc',
      firstCode: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.assignments).toHaveLength(1);
    expect(fallbackExtraction(result.value.assignments)).toBe('abc');
  });
});

describe('subsetter handoff and outline obligations (§10.2, §10.3)', () => {
  const ARABIC = '\u0627\u0628';
  const key = makeKey({ paragraphText: ARABIC, itemStart: 0, itemEnd: 2, fontEpoch: {} });

  it('the GID set passes to the subsetter unchanged, plus GID 0', () => {
    // GID 1300 stands in for a post-GSUB glyph with NO cmap entry: the
    // handoff has no cmap input at all, so it cannot be filtered away.
    const run = makeRun(key, ARABIC, { glyphs: [glyph(1300, 1, 2), glyph(5, 0, 1), glyph(1300, 1, 2)] });
    expect(subsetterGlyphSet(run)).toEqual([0, 5, 1300]);
  });

  it('outline validation is bound to the program, and one bad GID refuses the whole item', () => {
    const calls: [string, number][] = [];
    const validator: ShapedGlyphOutlineValidator = {
      validateGlyph(programSha256: string, gid: number): ShapeCheck {
        calls.push([programSha256, gid]);
        return gid === 999 ? refuse('unknown-bounds: charstring exceeds the evaluator caps') : ok();
      },
    };
    const good = makeRun(key, ARABIC, { glyphs: [glyph(1300, 1, 2), glyph(5, 0, 1)] });
    expect(validateRunOutlines(good, validator)).toEqual({ ok: true });
    // The validator was consulted per distinct GID against the BOUND
    // program hash — a post-GSUB GID with no cmap entry included.
    expect(calls).toContainEqual([key.programSha256, 1300]);
    const bad = makeRun(key, ARABIC, { glyphs: [glyph(999, 1, 2), glyph(5, 0, 1)] });
    expect(validateRunOutlines(bad, validator)).toMatchObject({
      ok: false,
      problem: expect.stringContaining('refused the whole item'),
    });
  });
});

describe('item-boundary safety (clarification 6)', () => {
  it('an item that is the whole context is a safe unit', () => {
    expect(
      checkItemBoundarySafety({
        contextStart: 0,
        contextEnd: 8,
        itemStart: 0,
        itemEnd: 8,
        referenceClusters: null,
        producedByShapedRegionRules: false,
      }),
    ).toEqual({ safe: true, basis: 'whole-context' });
  });

  it('a safe pipeline item inside the shaped region matches its reference (four-mark control)', () => {
    // The Windows control's safe case: a four-mark item produced by the
    // pipeline's own split rules, boundaries on reference cluster edges.
    // Lead correction 5: provenance + cluster geometry alone no longer
    // admit — the positive control now presents the identity-bound
    // agreement proof its safety claim always rested on (whole-context
    // and item-alone productions compared and in agreement for THIS
    // context digest and range). The assertion is unchanged; the
    // fixture supplies the proof the corrected contract requires.
    // Round-2 correction 5: the proof now binds the FULL requested
    // shape identity plus the preparation-ownership marker, and the
    // input carries the owner's trusted expectation. The identity is
    // a real derived key over shaped (Arabic) text — direct Latin
    // text never reaches the shaper and has no ShapeKey (§7.1) — and
    // the bound context digest is that key's own context digest.
    // Round-3 correction R3: the key is derived over the TEN-
    // character context the boundary input below describes; the
    // round-2 fixture derived it over a six-character paragraph, the
    // same incoherence the R3 review flagged in the boundary file.
    // The assertion is unchanged.
    const key = makeKey({ paragraphText: '\u0627\u0628'.repeat(5), itemStart: 0, itemEnd: 4 });
    const contextSha256 = key.contextSha256;
    const agreementSha256 = sha256('synthetic-four-mark-agreed-item-result');
    expect(
      checkItemBoundarySafety({
        contextStart: 0,
        contextEnd: 10,
        itemStart: 0,
        itemEnd: 4,
        referenceClusters: [
          [0, 4],
          [4, 10],
        ],
        producedByShapedRegionRules: true,
        contextSha256,
        safeUnitProof: {
          contextSha256,
          itemStart: 0,
          itemEnd: 4,
          key,
          source: 'preparation-comparison',
          agreementSha256,
        },
        expectedKey: key,
        expectedAgreementSha256: agreementSha256,
      }),
    ).toEqual({ safe: true, basis: 'shaped-region-item' });
  });

  it('a cross-item split is refused even when NO cluster straddles it (eight-mark control)', () => {
    // The Windows control's differing case: the split was imposed across
    // items by a boundary the pipeline did not make. Cluster alignment
    // alone must not admit it — absence of a straddle is insufficient.
    const result = checkItemBoundarySafety({
      contextStart: 0,
      contextEnd: 16,
      itemStart: 0,
      itemEnd: 8,
      referenceClusters: [
        [0, 8],
        [8, 16],
      ],
      producedByShapedRegionRules: false,
    });
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.problem).toContain('absence of a straddling cluster is not a safe unit');
  });

  it('a straddling reference cluster refuses, naming the boundary', () => {
    const result = checkItemBoundarySafety({
      contextStart: 0,
      contextEnd: 10,
      itemStart: 0,
      itemEnd: 4,
      referenceClusters: [
        [0, 6],
        [6, 10],
      ],
      producedByShapedRegionRules: true,
    });
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.problem).toContain('straddles the item boundary at 4');
    }
  });

  it('without a whole-context reference, a sub-context item is refused', () => {
    const result = checkItemBoundarySafety({
      contextStart: 0,
      contextEnd: 10,
      itemStart: 2,
      itemEnd: 6,
      referenceClusters: null,
      producedByShapedRegionRules: true,
    });
    expect(result.safe).toBe(false);
  });
});
