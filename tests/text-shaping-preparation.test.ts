/**
 * Step-1 gate tests (12.5 engine switch-over): the preparation layer's
 * safe-unit rule. The observed Windows evidence (PR #23 tree docs):
 * a four-mark item matches its whole-word shaping; an eight-mark
 * cross-item split DIFFERS. Admission must therefore follow an actual
 * whole-vs-item comparison — never a mark count, never cluster
 * alignment alone — and every non-admission is a named refusal.
 */
import { describe, expect, it } from 'vitest';
import type { ShapeKey, ShapedRun } from '../src/core/text-shaping';
import type { ShapedRunContext } from '../src/core/text-shaping-snapshot';
import {
  admitItemProduction,
  agreedItemResultEncoding,
  compareItemAgreement,
  type ItemAdmissionRequest,
} from '../src/core/text-shaping-preparation';
import { glyph, makeKey, makeRun, sha256 } from './helpers/shaping-fixture';

const BEH = '\u0628';
/** One epoch token per capture: both productions share it by identity. */
const EPOCH = {};
const MARK = '\u064B'; // fathatan — a transparent combining mark

/** beh + N transparent marks + beh; the marks cluster with the first beh. */
const paragraph = (marks: number): string => BEH + MARK.repeat(marks) + BEH;

const ctx = (key: ShapeKey, text: string, itemText: string): ShapedRunContext => ({
  key,
  itemText,
  itemTextSha256: sha256(itemText),
  glyphCount: 2000,
  unitsPerEm: 16384,
});

interface Production {
  key: ShapeKey;
  text: string;
  run: ShapedRun;
  validation: ShapedRunContext;
}

function reference(marks: number): Production {
  const text = paragraph(marks);
  const key = makeKey({ paragraphText: text, itemStart: 0, itemEnd: text.length, fontEpoch: EPOCH });
  const run = makeRun(key, text, {
    glyphs: [glyph(42, 0, marks + 1, { xAdvance: 600 }), glyph(43, marks + 1, marks + 2, { xAdvance: 550 })],
  });
  return { key, text, run, validation: ctx(key, text, text) };
}

/** The item production for [0, marks+1): the first beh plus its marks. */
function item(marks: number, gid: number, xAdvance = 600): Production {
  const text = paragraph(marks);
  const itemText = text.slice(0, marks + 1);
  const key = makeKey({ paragraphText: text, itemStart: 0, itemEnd: marks + 1, fontEpoch: EPOCH });
  const run = makeRun(key, itemText, { glyphs: [glyph(gid, 0, marks + 1, { xAdvance })] });
  return { key, text, run, validation: ctx(key, text, itemText) };
}

const request = (
  ref: Production | null,
  itm: Production,
  producedByShapedRegionRules = true,
): ItemAdmissionRequest => ({
  contextStart: 0,
  contextEnd: itm.text.length,
  reference: ref === null ? null : { run: ref.run, validation: ref.validation },
  item: { run: itm.run, validation: itm.validation },
  producedByShapedRegionRules,
  digestSha256Hex: sha256,
});

describe('preparation: safe-unit admission follows the comparison, not the mark count', () => {
  it('whole-context consumption needs no proof and no reference', () => {
    const whole = reference(8);
    const result = admitItemProduction(request(null, whole));
    expect(result.safe).toBe(true);
    if (result.safe) {
      expect(result.basis).toBe('whole-context');
      expect(result.proof).toBeNull();
    }
  });

  it('the observed eight-mark split refuses when the item production disagrees', () => {
    // The item-alone production yields a different glyph for the item
    // (an unjoined form) than the whole-context production — exactly
    // the recorded eight-mark divergence.
    const result = admitItemProduction(request(reference(8), item(8, 99)));
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.problem).toContain('unsafe-boundary:');
      expect(result.problem).toContain('cluster');
    }
  });

  it('the four-mark control admits when the productions agree, with a genuine proof', () => {
    const itm = item(4, 42);
    const result = admitItemProduction(request(reference(4), itm));
    expect(result.safe).toBe(true);
    if (result.safe) {
      expect(result.basis).toBe('shaped-region-item');
      expect(result.proof).not.toBeNull();
      expect(result.proof?.source).toBe('preparation-comparison');
      expect(result.proof?.contextSha256).toBe(itm.key.contextSha256);
      expect(result.proof?.itemStart).toBe(itm.key.itemStart);
      expect(result.proof?.itemEnd).toBe(itm.key.itemEnd);
      expect(result.proof?.agreementSha256).toBe(sha256(agreedItemResultEncoding(itm.key, itm.run)));
    }
  });

  it('an eight-mark item also admits when its productions agree (no count threshold)', () => {
    const result = admitItemProduction(request(reference(8), item(8, 42)));
    expect(result.safe).toBe(true);
    if (result.safe) expect(result.basis).toBe('shaped-region-item');
  });

  it('a 32-mark run admits only via agreement and refuses on disagreement', () => {
    expect(admitItemProduction(request(reference(32), item(32, 42))).safe).toBe(true);
    const refused = admitItemProduction(request(reference(32), item(32, 99)));
    expect(refused.safe).toBe(false);
    if (!refused.safe) expect(refused.problem).toContain('unsafe-boundary:');
  });

  it('a single differing advance refuses (the comparison is exact)', () => {
    const result = admitItemProduction(request(reference(4), item(4, 42, 601)));
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.problem).toContain('unsafe-boundary:');
      expect(result.problem).toContain('xAdvance');
    }
  });

  it('a start subitem with positionally derived flags admits (bot only, no eot)', () => {
    // Buffer flags are positional (§3.3): a subitem ending before the
    // context end cannot carry eot. The reference carries both.
    const text = paragraph(4);
    const itemText = text.slice(0, 5);
    const key = makeKey({ paragraphText: text, itemStart: 0, itemEnd: 5, fontEpoch: EPOCH, bufferFlags: ['bot'] });
    const run = makeRun(key, itemText, { glyphs: [glyph(42, 0, 5, { xAdvance: 600 })] });
    const itm: Production = { key, text, run, validation: ctx(key, text, itemText) };
    const result = admitItemProduction(request(reference(4), itm));
    expect(result.safe).toBe(true);
    if (result.safe) expect(result.basis).toBe('shaped-region-item');
  });

  it('an end subitem with positionally derived flags admits (eot only, no bot)', () => {
    const text = paragraph(8);
    const itemText = text.slice(9, 10);
    const key = makeKey({ paragraphText: text, itemStart: 9, itemEnd: 10, fontEpoch: EPOCH, bufferFlags: ['eot'] });
    const run = makeRun(key, itemText, { glyphs: [glyph(43, 0, 1, { xAdvance: 550 })] });
    const itm: Production = { key, text, run, validation: ctx(key, text, itemText) };
    const result = admitItemProduction(request(reference(8), itm));
    expect(result.safe).toBe(true);
    if (result.safe) expect(result.basis).toBe('shaped-region-item');
  });

  it('compareItemAgreement reports agreement and disagreement directly', () => {
    expect(compareItemAgreement(reference(4).run, item(4, 42).run).agree).toBe(true);
    const no = compareItemAgreement(reference(4).run, item(4, 99).run);
    expect(no.agree).toBe(false);
    if (!no.agree) expect(no.problem).toContain('unsafe-boundary:');
  });
});

describe('preparation: structural refusals stay named and fail closed', () => {
  it('a boundary inside a reference cluster refuses as a straddle', () => {
    const text = paragraph(8);
    const key = makeKey({ paragraphText: text, itemStart: 0, itemEnd: 5, fontEpoch: EPOCH });
    const run = makeRun(key, text.slice(0, 5), { glyphs: [glyph(42, 0, 5, { xAdvance: 600 })] });
    const itm: Production = { key, text, run, validation: ctx(key, text, text.slice(0, 5)) };
    const result = admitItemProduction(request(reference(8), itm));
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.problem).toContain('straddles');
  });

  it('a proper subitem without a reference refuses', () => {
    const result = admitItemProduction(request(null, item(4, 42)));
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.problem).toContain('no whole-context reference');
  });

  it('an agreeing foreign split still refuses (provenance is required)', () => {
    const result = admitItemProduction(request(reference(4), item(4, 42), false));
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.problem).toContain('safe unit');
  });

  it('an item produced under a different shaping identity refuses', () => {
    const text = paragraph(4);
    const itemText = text.slice(0, 5);
    const key = makeKey({ paragraphText: text, itemStart: 0, itemEnd: 5, fontEpoch: EPOCH, engineArtifactSha256: sha256('a different artifact') });
    const run = makeRun(key, itemText, { glyphs: [glyph(42, 0, 5, { xAdvance: 600 })] });
    const itm: Production = { key, text, run, validation: ctx(key, text, itemText) };
    const result = admitItemProduction(request(reference(4), itm));
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.problem).toContain('unsafe-boundary:');
      expect(result.problem).toContain('engineArtifactSha256');
    }
  });

  it('an invalid item run refuses with its validation problem, before any comparison', () => {
    const text = paragraph(4);
    const itemText = text.slice(0, 5);
    const key = makeKey({ paragraphText: text, itemStart: 0, itemEnd: 5, fontEpoch: EPOCH });
    const run = makeRun(key, itemText, { glyphs: [glyph(42, 0, 5, { xAdvance: 600 })], advanceX: 12345 });
    const itm: Production = { key, text, run, validation: ctx(key, text, itemText) };
    const result = admitItemProduction(request(reference(4), itm));
    expect(result.safe).toBe(false);
  });
});
