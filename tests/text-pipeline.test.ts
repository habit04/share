/**
 * §2 pipeline regression set (contract v4 + the engine brief):
 * Arabic joining context, the §11 8-mark whole-context case,
 * Hebrew/Arabic bidi with numbers, Indic reordering and marks,
 * Latin ligatures (direct route), CJK passthrough, mark runs.
 */
import { describe, expect, it } from 'vitest';
import { itemizeParagraph, splitByCoverage, SHAPING_FEATURES, type ItemizedItem } from '../src/core/text-pipeline';

function rangeOf(item: ItemizedItem) {
  return item.route === 'shaped'
    ? { start: item.derivation.itemStart, end: item.derivation.itemEnd }
    : { start: item.itemStart, end: item.itemEnd };
}
function shapedItems(text: string) {
  return itemizeParagraph(text).items.filter((item) => item.route === 'shaped');
}
function routes(text: string) {
  return itemizeParagraph(text).items.map((item) => item.route);
}

describe('itemizeParagraph', () => {
  it('keeps an Arabic word as one shaped item with rtl direction', () => {
    const result = itemizeParagraph('سلام');
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item.route).toBe('shaped');
    if (item.route === 'shaped') {
      expect(item.derivation.script).toBe('Arab');
      expect(item.derivation.direction).toBe('rtl');
      expect(item.derivation.bidiLevel).toBe(1);
      expect(item.derivation.bufferFlags).toEqual(['bot', 'eot']);
      expect(item.derivation.features).toBe(SHAPING_FEATURES);
    }
  });

  it('keeps the 8-mark Arabic run in the same item as its base (§11 case)', () => {
    const text = 'ب' + 'ً'.repeat(8) + 'x';
    const result = itemizeParagraph(text);
    const arabic = result.items.find((item) => item.route === 'shaped');
    expect(arabic).toBeDefined();
    if (arabic?.route === 'shaped') {
      expect(arabic.derivation.itemStart).toBe(0);
      expect(arabic.derivation.itemEnd).toBe(text.length - 1);
    }
    expect(routes(text)).toEqual(['shaped', 'direct']);
  });

  it('splits a digit run inside Arabic text into its own item (uniform-level rule)', () => {
    const text = 'عدد 123 عدد';
    const result = itemizeParagraph(text);
    // The digits sit on their own (even) level run: a separate
    // item from both Arabic runs. The §7.1 gate admits a pure
    // digit run, so it takes the direct route — the itemization
    // split, not the route, is what the uniform-level rule pins.
    expect(result.items.map((item) => { const r = rangeOf(item); return text.slice(r.start, r.end); })).toEqual(['عدد ', '123', ' عدد']);
    expect(result.items[1]!.route).toBe('direct');
    expect(result.levels[4]).toBe(2);
    const arabic = result.items.filter((item) => item.route === 'shaped');
    expect(arabic).toHaveLength(2);
  });

  it('routes Hebrew text to the engine and Hebrew digits to their own item', () => {
    const text = 'שלום 42';
    const result = itemizeParagraph(text);
    expect(result.items.map((item) => { const r = rangeOf(item); return text.slice(r.start, r.end); })).toEqual(['שלום ', '42']);
    const hebrew = result.items[0]!;
    expect(hebrew.route).toBe('shaped');
    if (hebrew.route === 'shaped') {
      expect(hebrew.derivation.script).toBe('Hebr');
      expect(hebrew.derivation.direction).toBe('rtl');
    }
    expect(result.items[1]!.route).toBe('direct');
  });

  it('keeps a Devanagari conjunct in one item and one grapheme', () => {
    const text = 'क्षत्रिय';
    const result = itemizeParagraph(text);
    expect(result.graphemeBoundaries).toContain(0);
    expect(result.graphemeBoundaries).toContain(text.length);
    expect(result.graphemeBoundaries).not.toContain(1);
    expect(result.graphemeBoundaries).not.toContain(2);
    expect(shapedItems(text)).toHaveLength(1);
  });

  it('routes plain Latin and CJK through the admitted direct path', () => {
    expect(routes('office work')).toEqual(['direct']);
    expect(routes('中文测试')).toEqual(['direct']);
    expect(routes('한국어')).toEqual(['direct']);
  });

  it('itemizes mixed Latin/Arabic as two items with their own levels', () => {
    const result = itemizeParagraph('abc سلام');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]!.route).toBe('direct');
    const arabic = result.items[1]!;
    if (arabic.route === 'shaped') {
      expect(arabic.derivation.bidiLevel).toBe(1);
      expect(arabic.derivation.bufferFlags).toEqual(['eot']);
    }
  });

  it('never lets an item span a grapheme boundary at its edges', () => {
    const text = 'a' + 'ب' + 'ً'.repeat(3) + 'c';
    const result = itemizeParagraph(text);
    const boundarySet = new Set(result.graphemeBoundaries);
    for (const item of result.items) {
      const { start, end } = rangeOf(item);
      expect(boundarySet.has(start)).toBe(true);
      expect(boundarySet.has(end)).toBe(true);
    }
  });
});

describe('splitByCoverage', () => {
  it('moves a split before a mark back to the grapheme start (mark migration)', () => {
    const text = 'بًx';
    const boundaries = [0, 2, 3];
    // Base covered, mark and x not: the naive split at 1 is inside
    // the grapheme [0,2) and must move back to 0, so the mark is
    // produced with its base's subitem.
    const parts = splitByCoverage(text, 0, 3, boundaries, (cp) => cp === 0x0628);
    expect(parts[0]).toEqual({ start: 0, end: 2, covered: true });
    expect(parts[1]).toEqual({ start: 2, end: 3, covered: false });
  });
  it('keeps uniform coverage unsplit', () => {
    expect(splitByCoverage('abc', 0, 3, [0, 1, 2, 3], () => true))
      .toEqual([{ start: 0, end: 3, covered: true }]);
  });
});
