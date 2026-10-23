import { describe, it, expect } from 'vitest';
import { readDxf, writeDxf } from '../src/io/dxf';
import type { DrawingState } from '../src/core/document';

// P28 PR #42 fix (2) — Codex P1: underlay definition identity in the
// cad-graph merge. Before the fix the dedupe key was (kind + stored
// path), omitting the page, and dictionary-owned definitions keyed by
// their dictionary path instead — which the generated records (owned
// by the root dictionary directly) never reproduce. Two pages of one
// PDF therefore grew 2 -> 3 -> 5 -> 9 -> 17 definitions over
// save/reopen passes, and a path edit on dictionary-owned definitions
// left the stale records beside the new ones (4 definitions, old path
// included). Definitions are keyed by their real identity — kind +
// stored path + page/model as stored — regardless of dictionary
// ownership, and a path the model edited still matches its generated
// record on (kind, page) when that pairing is unambiguous.

const TEST_TIMEOUT = 30_000;

interface DefSpec { path: string; page: string; extra?: readonly (readonly [string, string])[] }

function buildDxf(defs: readonly DefSpec[], opts: { dictionaryOwned?: boolean } = {}): string {
  const lines: string[] = ['0', 'SECTION', '2', 'ENTITIES'];
  defs.forEach((def, i) => {
    const handle = `${40 + i * 3}`, defHandle = `${41 + i * 3}`;
    lines.push(
      '0', 'PDFUNDERLAY', '5', handle, '330', '2E', '100', 'AcDbEntity', '8', 'U', '100', 'AcDbPdfUnderlay',
      '340', defHandle, '10', '10', '20', '20', '41', '2', '42', '3', '70', '3',
      '14', '0', '24', '0', '14', '100', '24', '50',
    );
  });
  lines.push('0', 'ENDSEC', '0', 'SECTION', '2', 'OBJECTS');
  if (opts.dictionaryOwned) {
    lines.push('0', 'DICTIONARY', '5', 'C', '330', '0', '100', 'AcDbDictionary', '281', '1',
      '3', 'ACAD_PDFDEFINITIONS', '350', 'D',
      '3', 'JCAD_UNRELATED', '350', 'E');
    lines.push('0', 'DICTIONARY', '5', 'D', '330', 'C', '100', 'AcDbDictionary', '281', '1',
      ...defs.flatMap((def, i) => ['3', `floor ${def.page}`, '350', `${41 + i * 3}`]));
    lines.push('0', 'XRECORD', '5', 'E', '330', 'C', '100', 'AcDbXrecord', '1', 'unrelated metadata - keep me', '90', '4242');
  }
  defs.forEach((def, i) => {
    lines.push('0', 'PDFDEFINITION', '5', `${41 + i * 3}`, '330', opts.dictionaryOwned ? 'D' : 'C',
      '100', 'AcDbObject', '100', 'AcDbPdfDefinition', '1', def.path, '2', def.page,
      ...(def.extra ?? []).flatMap(([code, value]) => [code, value]));
  });
  lines.push('0', 'ENDSEC', '0', 'EOF');
  return lines.join('\n');
}

const countDefs = (text: string): number => (text.match(/\r\n0\r\nPDFDEFINITION\r\n/g) ?? []).length;
const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1;

function passes(dxf: string, n: number): { texts: string[]; states: DrawingState[] } {
  const texts: string[] = [];
  const states: DrawingState[] = [];
  let state = readDxf(dxf);
  states.push(state);
  for (let i = 0; i < n; i += 1) {
    const text = writeDxf(state);
    texts.push(text);
    state = readDxf(text);
    states.push(state);
  }
  return { texts, states };
}

const TWO_PAGES: readonly DefSpec[] = [
  { path: 'plans\\floor.pdf', page: 'Page 1', extra: [['90', '7']] },
  { path: 'plans\\floor.pdf', page: 'Page 2', extra: [['90', '9']] },
];

describe('underlay definition identity (PR #42 fix 2)', () => {
  it('two pages of one PDF stay at exactly 2 definitions over 4 save/reopen passes', () => {
    const { texts, states } = passes(buildDxf(TWO_PAGES), 4);
    for (const text of texts) expect(countDefs(text)).toBe(2);
    for (const state of states) expect(Object.values(state.underlays ?? {})).toHaveLength(2);
    // Each definition's retained extras ride along exactly once per pass.
    for (const text of texts) {
      expect(countOccurrences(text, '\r\n90\r\n7\r\n')).toBe(1);
      expect(countOccurrences(text, '\r\n90\r\n9\r\n')).toBe(1);
    }
    expect(texts[3]).toBe(texts[2]); // byte-stable once settled
  }, TEST_TIMEOUT);

  it('dictionary-owned: two pages of one PDF stay at exactly 2 definitions over 4 passes, unrelated dictionary metadata kept', () => {
    const { texts, states } = passes(buildDxf(TWO_PAGES, { dictionaryOwned: true }), 4);
    for (const text of texts) expect(countDefs(text)).toBe(2);
    for (const state of states) expect(Object.values(state.underlays ?? {})).toHaveLength(2);
    for (const text of texts) {
      expect(countOccurrences(text, 'unrelated metadata - keep me')).toBe(1);
      expect(countOccurrences(text, '\r\n90\r\n7\r\n')).toBe(1);
      expect(countOccurrences(text, '\r\n90\r\n9\r\n')).toBe(1);
    }
    expect(texts[3]).toBe(texts[2]);
  }, TEST_TIMEOUT);

  it('dictionary-owned: a path edit gives exactly 2 definitions with the new path and no stale record', () => {
    const state = readDxf(buildDxf(TWO_PAGES, { dictionaryOwned: true }));
    const edited: DrawingState = {
      ...state,
      underlays: Object.fromEntries(
        Object.entries(state.underlays ?? {}).map(([id, def]) => [id, { ...def, sourcePath: 'plans\\floor-v2.pdf' }]),
      ),
    };
    const text = writeDxf(edited);
    expect(countDefs(text)).toBe(2);
    expect(countOccurrences(text, 'plans\\floor-v2.pdf')).toBe(2);
    expect(countOccurrences(text, 'plans\\floor.pdf')).toBe(0);
    // And the edited drawing stays at 2 across further passes.
    const again = readDxf(text);
    expect(Object.values(again.underlays ?? {})).toHaveLength(2);
    expect(countDefs(writeDxf(again))).toBe(2);
  }, TEST_TIMEOUT);

  it('different-file control: two definitions of different files stay at 2 over 4 passes', () => {
    const defs: readonly DefSpec[] = [
      { path: 'plans\\floor.pdf', page: 'Page 1', extra: [['90', '7']] },
      { path: 'plans\\roof.pdf', page: 'Page 1', extra: [['90', '9']] },
    ];
    const { texts, states } = passes(buildDxf(defs), 4);
    for (const text of texts) expect(countDefs(text)).toBe(2);
    for (const state of states) expect(Object.values(state.underlays ?? {})).toHaveLength(2);
    expect(texts[3]).toBe(texts[2]);
  }, TEST_TIMEOUT);
});

// PR #42 cleanup (4) — Codex P2: the (kind, page) secondary match
// pairs only an UNAMBIGUOUS 1-and-1 remainder. Two PDFs both on
// page 1 with BOTH paths edited in one transaction leave a 2-and-2
// remainder, which b95f2d5 left unmatched on purpose — and the merge
// then emitted the two stale records beside the two new ones (4
// definitions). Edited definitions now bind FIRST by the model's
// definition/reference identity: each placement matched by its
// entity anchor, its retained node references its definition node,
// and its generated record points at the generated definition
// record — a chain that proves the pairing even when kind and page
// collide. A remainder that still cannot be paired unambiguously
// refuses the save atomically instead of duplicating silently.

const editPaths = (state: DrawingState, renames: ReadonlyMap<string, string>): DrawingState => ({
  ...state,
  underlays: Object.fromEntries(
    Object.entries(state.underlays ?? {}).map(([id, def]) => [id, { ...def, sourcePath: renames.get(def.sourcePath) ?? def.sourcePath }]),
  ),
});

describe('underlay definition binding by reference identity (PR #42 cleanup 4)', () => {
  it('two PDFs both on page 1 with both paths edited in one transaction give exactly 2 definitions with the new paths', () => {
    const defs: readonly DefSpec[] = [
      { path: 'plans\\a.pdf', page: 'Page 1', extra: [['90', '7']] },
      { path: 'plans\\b.pdf', page: 'Page 1', extra: [['90', '9']] },
    ];
    const state = readDxf(buildDxf(defs));
    const edited = editPaths(state, new Map([
      ['plans\\a.pdf', 'plans\\a-v2.pdf'],
      ['plans\\b.pdf', 'plans\\b-v2.pdf'],
    ]));
    const text = writeDxf(edited);
    expect(countDefs(text)).toBe(2);
    expect(countOccurrences(text, 'plans\\a-v2.pdf')).toBe(1);
    expect(countOccurrences(text, 'plans\\b-v2.pdf')).toBe(1);
    expect(countOccurrences(text, 'plans\\a.pdf')).toBe(0);
    expect(countOccurrences(text, 'plans\\b.pdf')).toBe(0);
    // Each definition's retained extras merged exactly once.
    expect(countOccurrences(text, '\r\n90\r\n7\r\n')).toBe(1);
    expect(countOccurrences(text, '\r\n90\r\n9\r\n')).toBe(1);
    // And the result is stable: reopening keeps 2, with the new paths.
    const again = readDxf(text);
    expect(Object.values(again.underlays ?? {}).map((d) => d.sourcePath).sort()).toEqual(['plans\\a-v2.pdf', 'plans\\b-v2.pdf']);
    expect(countDefs(writeDxf(again))).toBe(2);
  }, TEST_TIMEOUT);

  it('two unreferenced page-1 definitions with both paths edited cannot be paired: the save refuses atomically', () => {
    // No placements -> no reference chain -> nothing proves which
    // generated record succeeds which retained one (same kind, same
    // page, both paths moved). Refusing is the ruled outcome; writing
    // both pairs (4 definitions) is the bug.
    const lines: string[] = ['0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'SECTION', '2', 'OBJECTS'];
    const defs: readonly DefSpec[] = [
      { path: 'plans\\a.pdf', page: 'Page 1', extra: [['90', '7']] },
      { path: 'plans\\b.pdf', page: 'Page 1', extra: [['90', '9']] },
    ];
    defs.forEach((def, i) => {
      lines.push('0', 'PDFDEFINITION', '5', `${41 + i * 3}`, '330', 'C',
        '100', 'AcDbObject', '100', 'AcDbPdfDefinition', '1', def.path, '2', def.page,
        ...(def.extra ?? []).flatMap(([code, value]) => [code, value]));
    });
    lines.push('0', 'ENDSEC', '0', 'EOF');
    const state = readDxf(lines.join('\n'));
    expect(Object.values(state.underlays ?? {})).toHaveLength(2);
    const edited = editPaths(state, new Map([
      ['plans\\a.pdf', 'plans\\a-v2.pdf'],
      ['plans\\b.pdf', 'plans\\b-v2.pdf'],
    ]));
    expect(() => writeDxf(edited)).toThrow(/cannot be paired unambiguously/);
  }, TEST_TIMEOUT);
});
