import { describe, expect, it } from 'vitest';
import { comparePdfViewerText, PDF_VIEWER_TEXT_LIMITS } from '../scripts/pdf-viewer-text.mjs';

describe('native PDF viewer source-text comparison', () => {
  it.each(['', ' EDITED'])('preserves the actual native-font fixture with spatial separators%s', suffix => {
    // Independent DXF TEXT entities at (20,40)/(100,40), not one joined string.
    const source = Object.freeze(['A\u00a0B A B', `BAHN DEFAULT AB 0123${suffix}`]);
    const actual = `A\u00a0B A B BAHN DEFAULT AB 0123${suffix}`;
    expect(actual.replace(/\r\n?|\n/gu, '') === source.join('')).toBe(false);
    expect(comparePdfViewerText(actual, source)).toEqual({ ok: true, sourceFragments: 2, separators: [' '] });
    expect(source).toEqual(['A\u00a0B A B', `BAHN DEFAULT AB 0123${suffix}`]);
  });

  it.each(['', ' ', '\n', '\r\n', ' \r\n ', ' '.repeat(16)])('accepts only bounded inter-entity layout %j', separator => {
    expect(comparePdfViewerText(`A B${separator}C\u00a0D`, ['A B', 'C\u00a0D']).ok).toBe(true);
  });

  it.each([
    ['lost internal space', 'AB\nC\u00a0D'],
    ['added internal space', 'A  B\nC\u00a0D'],
    ['inserted internal newline', 'A\n B\nC\u00a0D'],
    ['inserted internal CR', 'A B\nC\r\u00a0D'],
    ['NBSP converted to space', 'A B\nC D'],
    ['NBSP removed', 'A B\nCD'],
    ['missing glyph', 'A B\nC\u00a0'],
    ['wrong order', 'C\u00a0D\nA B'],
    ['extra boundary letter', 'A BxC\u00a0D'],
    ['extra boundary NBSP', 'A B\u00a0C\u00a0D'],
    ['extra boundary tab', 'A B\tC\u00a0D'],
    ['extra boundary formfeed', 'A B\fC\u00a0D'],
    ['extra boundary zero-width space', 'A B\u200bC\u00a0D'],
    ['extra boundary Unicode line separator', 'A B\u2028C\u00a0D'],
    ['unmatched prefix letter', 'xA B\nC\u00a0D'],
    ['unmatched prefix space', ' A B\nC\u00a0D'],
    ['unmatched suffix letter', 'A B\nC\u00a0Dx'],
    ['unmatched suffix newline', 'A B\nC\u00a0D\n'],
  ])('refuses %s without normalizing source characters', (_name, actual) => {
    expect(comparePdfViewerText(actual, ['A B', 'C\u00a0D']).ok).toBe(false);
  });

  it('preserves supplementary Unicode and literal zero-width/source whitespace', () => {
    const source = Object.freeze(['\u00a0A\u{20000}B\u200b', 'C\tD']);
    expect(comparePdfViewerText('\u00a0A\u{20000}B\u200b\nC\tD', source).ok).toBe(true);
    expect(comparePdfViewerText('\u00a0A\u{20001}B\u200b\nC\tD', source).ok).toBe(false);
    expect(comparePdfViewerText('\u00a0A\u{20000}B\nC\tD', source).ok).toBe(false);
    expect(comparePdfViewerText('\u00a0A\u{20000}B\u200b\nC D', source).ok).toBe(false);
  });

  it('does not fold canonically equivalent Unicode', () => {
    expect(comparePdfViewerText('A\u0301', ['\u00c1']).ok).toBe(false);
    expect(comparePdfViewerText('A\u0301', ['A\u0301']).ok).toBe(true);
  });

  it.each([null, undefined, 1, {}, ['A']])('refuses non-string actual text %j', actual => {
    expect(comparePdfViewerText(actual, ['A'])).toMatchObject({ ok: false, reason: 'invalid-actual' });
  });

  it.each([null, undefined, 'A', {}, []].map(fragments => ({ fragments })))('refuses missing/non-array source fragments $fragments', ({ fragments }) => {
    expect(comparePdfViewerText('A', fragments)).toMatchObject({ ok: false, reason: 'invalid-fragments' });
  });

  it.each([[''], [' A'], ['A '], ['\nA'], ['A\r'], ['A', 1], new Array(1)])('refuses ambiguous or invalid source fragments %j', (...fragments) => {
    expect(comparePdfViewerText('A', fragments)).toMatchObject({ ok: false, reason: 'unsupported-fragment' });
  });

  it('enforces fixed input/source/fragment/separator caps at their exact boundaries', () => {
    const { maxActualCodeUnits: units, maxFragments, maxSeparatorCodeUnits } = PDF_VIEWER_TEXT_LIMITS;
    const text = 'A'.repeat(units);
    expect(comparePdfViewerText(text, [text]).ok).toBe(true);
    expect(comparePdfViewerText(text + 'A', [text])).toMatchObject({ ok: false, reason: 'actual-limit' });
    expect(comparePdfViewerText('', ['A'.repeat(units + 1)])).toMatchObject({ ok: false, reason: 'source-limit' });
    expect(comparePdfViewerText('', ['A'.repeat(units), 'B'])).toMatchObject({ ok: false, reason: 'source-limit' });
    const fragments = Array.from({ length: maxFragments }, () => 'A');
    expect(comparePdfViewerText(fragments.join(''), fragments).ok).toBe(true);
    expect(comparePdfViewerText('', [...fragments, 'A'])).toMatchObject({ ok: false, reason: 'fragment-limit' });
    expect(comparePdfViewerText('A' + ' '.repeat(maxSeparatorCodeUnits + 1) + 'B', ['A', 'B'])).toMatchObject({ ok: false, reason: 'separator-limit' });
    expect(Object.isFrozen(PDF_VIEWER_TEXT_LIMITS)).toBe(true);
  });

  it('refuses sparse source arrays even if a private prototype supplies a string', () => {
    expect(comparePdfViewerText('A', new Array(1))).toMatchObject({ ok: false, reason: 'unsupported-fragment' });
    const inherited = new Array(1);
    Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), { 0: 'A' }));
    expect(inherited[0]).toBe('A');
    expect(Object.hasOwn(inherited, 0)).toBe(false);
    expect(comparePdfViewerText('A', inherited)).toMatchObject({ ok: false, reason: 'unsupported-fragment' });
  });

  it('handles repeated/overlapping source strings literally without sorting or mutating them', () => {
    const source = Object.freeze(['A', 'AB', 'A']);
    expect(comparePdfViewerText('AAB\nA', source)).toEqual({ ok: true, sourceFragments: 3, separators: ['', '\n'] });
    expect(comparePdfViewerText('AABAextra', source)).toMatchObject({ ok: false, reason: 'trailing-content', fragmentIndex: 3, offset: 4 });
    expect(source).toEqual(['A', 'AB', 'A']);
  });
});
