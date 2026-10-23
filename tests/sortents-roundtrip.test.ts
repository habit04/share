import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDxf, writeDxf } from '../src/io/dxf';
import { tokenize } from '../src/io/dxf/groups';

/**
 * Hub task 1ca25d02 (lead's P17 native gate, pre-existing at main): re-saving
 * an AutoCAD drawing rewrote every sort handle in the SORTENTSTABLE object
 * to the table's OWN handle, so AutoCAD AUDIT reports eDuplicateKey.
 *
 * The genuine fixture r2018-truecolor-linetypes.dxf carries an AutoCAD
 * SORTENTSTABLE (handle 27D, owned by the *Model_Space ACAD_SORTENTS
 * dictionary) whose single entry sorts the HATCH 27C with sort handle 279.
 * In the table body the entries are (331 = entity handle, 5 = sort handle)
 * pairs: those trailing group 5s are DATA, not the record's handle — the
 * record's handle is the FIRST group 5, exactly as recordsOf reads it.
 */

const fixture = readFileSync(new URL('./fixtures/interchange/r2018-truecolor-linetypes.dxf', import.meta.url), 'utf8');

type Group = readonly [number, string];

function sortentsTables(text: string): Group[][] {
  const pairs = tokenize(text);
  const tables: Group[][] = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i]!.code !== 0 || pairs[i]!.value !== 'SORTENTSTABLE') continue;
    const groups: Group[] = [];
    for (let j = i + 1; j < pairs.length && pairs[j]!.code !== 0; j++) groups.push([pairs[j]!.code, pairs[j]!.value]);
    tables.push(groups);
  }
  return tables;
}

/** The (entity handle, sort handle) entry pairs of one SORTENTSTABLE body. */
function sortEntries(groups: readonly Group[]): [string, string][] {
  const entries: [string, string][] = [];
  for (let i = 0; i + 1 < groups.length; i++) {
    if (groups[i]![0] === 331 && groups[i + 1]![0] === 5) entries.push([groups[i]![1], groups[i + 1]![1]]);
  }
  return entries;
}

describe('SORTENTSTABLE draw-order round trip', () => {
  it('preserves the genuine AutoCAD sort handle on an unedited re-save', () => {
    const before = sortentsTables(fixture);
    expect(before).toHaveLength(1);
    expect(sortEntries(before[0]!)).toEqual([['27C', '279']]);
    const after = sortentsTables(writeDxf(readDxf(fixture)));
    expect(after).toHaveLength(1);
    // The whole retained record must come back byte-verbatim at group level:
    // the sort value 279 must not collapse onto the table handle 27D.
    expect(after[0]).toEqual(before[0]);
    expect(sortEntries(after[0]!)).toEqual([['27C', '279']]);
  });

  it('preserves every sort handle of a multi-entry table', () => {
    // Mirror the genuine shape with several entries: more (331, 5) pairs
    // appended after the fixture's own entry. The extra 331s name entities
    // that exist in the fixture (LINE 270, LWPOLYLINE 272, CIRCLE 274); the
    // extra sort handles (115, 116, 117) are handle values no record in the
    // file defines, below its $HANDSEED 282, exactly like the genuine 279.
    const entry = '331\r\n27C\r\n  5\r\n279\r\n';
    const extended = fixture.replace(entry,
      entry + '331\r\n270\r\n  5\r\n115\r\n331\r\n272\r\n  5\r\n116\r\n331\r\n274\r\n  5\r\n117\r\n');
    expect(extended).not.toBe(fixture);
    const expected: [string, string][] = [['27C', '279'], ['270', '115'], ['272', '116'], ['274', '117']];
    expect(sortEntries(sortentsTables(extended)[0]!)).toEqual(expected);
    const after = sortentsTables(writeDxf(readDxf(extended)));
    expect(after).toHaveLength(1);
    expect(sortEntries(after[0]!)).toEqual(expected);
    // No sort handle may be rewritten to the table's own handle (27D), and
    // the keys must stay distinct — duplicates are the eDuplicateKey AUDIT
    // failure this task fixes.
    const sorts = sortEntries(after[0]!).map(([, sort]) => sort);
    expect(new Set(sorts).size).toBe(sorts.length);
    expect(sorts).not.toContain('27D');
  });

  it('keeps the preserved table a fixed point on a second round trip', () => {
    const entry = '331\r\n27C\r\n  5\r\n279\r\n';
    const extended = fixture.replace(entry,
      entry + '331\r\n270\r\n  5\r\n115\r\n331\r\n272\r\n  5\r\n116\r\n331\r\n274\r\n  5\r\n117\r\n');
    const once = writeDxf(readDxf(extended));
    expect(writeDxf(readDxf(once))).toBe(once);
  });
});
