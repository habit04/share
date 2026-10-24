import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDxf } from '../src/io/dxf';
import { preserveDxfCadGraph } from '../src/io/cad-graph-dxf';
import { tokenize } from '../src/io/dxf/groups';
import type { DrawingState } from '../src/core/document';
import type { CadAnchor } from '../src/core/cad-graph';

/**
 * Hub task 5347a4bc, round 6 (the LibreDWG equivalence half): the
 * generated-record rewrite in preserveDxfCadGraph remapped EVERY group
 * 5/105 through the generated-handle map, treating payload 5s as record
 * identities. A SORTENTSTABLE entry's group 5 is a sort handle — an
 * ordering key in handle space that no record owns (the retained path
 * passes it verbatim; see sortents-roundtrip.test.ts and PR #49). When
 * the value happened to equal a handle the writer had allocated to a
 * generated record, the sort value collapsed onto that record's handle;
 * an unresolvable one reached the DWG as 0, LibreDWG's readback dropped
 * it, and the metadata equivalence postflight refused every such export
 * with 'SORTENTSTABLE group count changed'. Only the FIRST group 5
 * (first 105 for DIMSTYLE) — the position recordsOf reads the handle
 * from — is an identity.
 *
 * These tests drive preserveDxfCadGraph with a writer-shaped
 * regeneration of the genuine fixture: fresh record handles with the
 * payload copied verbatim, plus the anchor registrations the model
 * writer makes as it emits (write-core's cadAnchors), all derived from
 * ONE readDxf — node ids are minted per read, so anchors built from a
 * second read could never match. The regenerated table record is not
 * matched to a graph node (its owner chain carries the fresh handles),
 * which is exactly the record class the rewrite mishandled; the
 * retained table is emitted beside it and asserted too.
 */

const fixture = readFileSync(new URL('./fixtures/interchange/r2018-truecolor-linetypes.dxf', import.meta.url), 'utf8');

type Group = readonly [number, string];

function recordsOfType(text: string, type: string): Group[][] {
  const pairs = tokenize(text);
  const records: Group[][] = [];
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i]!.code !== 0 || pairs[i]!.value !== type) continue;
    const groups: Group[] = [];
    for (let j = i + 1; j < pairs.length && pairs[j]!.code !== 0; j++) groups.push([pairs[j]!.code, pairs[j]!.value]);
    records.push(groups);
  }
  return records;
}

const sortentsTables = (text: string): Group[][] => recordsOfType(text, 'SORTENTSTABLE');

/** The (entity handle, sort handle) entry pairs of one SORTENTSTABLE body. */
function sortEntries(groups: readonly Group[]): [string, string][] {
  const entries: [string, string][] = [];
  for (let i = 0; i + 1 < groups.length; i++) {
    if (groups[i]![0] === 331 && groups[i + 1]![0] === 5) entries.push([groups[i]![1], groups[i + 1]![1]]);
  }
  return entries;
}

function swap(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`fixture anchor missing: ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

/**
 * The writer-shaped regeneration of the fixture: the ACAD_SORTENTS
 * dictionary is emitted under the fresh handle 279 — the exact value of
 * the table's un-owned sort handle — and the table itself under 501,
 * with every reference to the dictionary carrying its fresh handle.
 */
function regenerated(text: string): string {
  let generated = swap(text, 'DICTIONARY\r\n  5\r\n15D\r\n', 'DICTIONARY\r\n  5\r\n279\r\n');
  generated = swap(generated, '360\r\n27D\r\n', '360\r\n501\r\n');
  generated = swap(generated, 'SORTENTSTABLE\r\n  5\r\n27D\r\n', 'SORTENTSTABLE\r\n  5\r\n501\r\n');
  return generated.split('330\r\n15D\r\n').join('330\r\n279\r\n');
}

const RENAMES = new Map([['15D', '279'], ['27D', '501']]);

/** The anchor registrations the model writer makes as it emits each record. */
function writerAnchors(state: DrawingState, renames: ReadonlyMap<string, string>): Map<string, CadAnchor> {
  const anchors = new Map<string, CadAnchor>();
  for (const node of state.cadGraph!.nodes) {
    if (!node.sourceHandle || !node.anchor) continue;
    anchors.set(renames.get(node.sourceHandle) ?? node.sourceHandle, node.anchor);
  }
  return anchors;
}

function preserved(generated: string, source: string, renames: ReadonlyMap<string, string> = RENAMES): string {
  const state = readDxf(source);
  return preserveDxfCadGraph(generated, state, writerAnchors(state, renames));
}

describe('SORTENTSTABLE sort handles on the generated path', () => {
  it('keeps an un-owned sort handle that collides with a generated record handle', () => {
    const out = preserved(regenerated(fixture), fixture);
    const tables = sortentsTables(out);
    // The generated path really engaged: beside the retained table
    // (identity restored to 27D) sits the regenerated record, still
    // carrying its fresh allocation — and BOTH keep the payload.
    expect(tables).toHaveLength(2);
    expect(tables.some(groups => groups[0]![1] === '27D')).toBe(true);
    for (const table of tables) {
      expect(sortEntries(table)).toEqual([['27C', '279']]);
    }
    // The retained record is the source record, group for group.
    expect(tables.find(groups => groups[0]![1] === '27D')).toEqual(sortentsTables(fixture)[0]);
    const [, sort] = sortEntries(tables[0]!)[0]!;
    expect(sort).not.toBe('0');
  });

  it('keeps every sort value of a multi-entry table byte-identical under collisions', () => {
    // More (331, 5) entries, mirroring the genuine shape: 279 collides
    // with the dictionary's generated handle, 501 with the table's own
    // generated handle, 116/117 are owned by no record at all.
    const entry = '331\r\n27C\r\n  5\r\n279\r\n';
    const extended = fixture.replace(entry,
      entry + '331\r\n270\r\n  5\r\n501\r\n331\r\n272\r\n  5\r\n116\r\n331\r\n274\r\n  5\r\n117\r\n');
    expect(extended).not.toBe(fixture);
    const expected: [string, string][] = [['27C', '279'], ['270', '501'], ['272', '116'], ['274', '117']];
    expect(sortEntries(sortentsTables(extended)[0]!)).toEqual(expected);
    const out = preserved(regenerated(extended), extended);
    const tables = sortentsTables(out);
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(sortEntries(table)).toEqual(expected);
      const sorts = sortEntries(table).map(([, sort]) => sort);
      // No sort key may collapse onto another (the eDuplicateKey AUDIT
      // failure of Hub task 1ca25d02), none may be rewritten to the
      // table's own handle, and none may degenerate to 0.
      expect(new Set(sorts).size).toBe(sorts.length);
      expect(sorts).not.toContain('27D');
      expect(sorts).not.toContain('0');
    }
  });

  it('still remaps the anonymous BLOCK/ENDBLK structural pair', () => {
    // Guard: narrowing the rewrite to the identity position must not
    // weaken the structural remap — a generated BLOCK/ENDBLK pair
    // under fresh handles still gets its identities restored.
    let generated = regenerated(fixture);
    generated = swap(generated, 'BLOCK\r\n  5\r\n20\r\n', 'BLOCK\r\n  5\r\n4FF\r\n');
    generated = swap(generated, 'ENDBLK\r\n  5\r\n21\r\n', 'ENDBLK\r\n  5\r\n4FE\r\n');
    const renames = new Map([...RENAMES, ['20', '4FF'], ['21', '4FE']]);
    const out = preserved(generated, fixture, renames);
    const blocks = recordsOfType(out, 'BLOCK');
    const modelSpace = blocks.find(groups => groups.some(([code, value]) => code === 2 && value === '*Model_Space'));
    expect(modelSpace?.[0]).toEqual([5, '20']);
    const endblk = recordsOfType(out, 'ENDBLK').find(groups => groups[0]?.[1] === '21');
    expect(endblk).toBeDefined();
    // And the table in the same drawing is untouched by the remap.
    for (const table of sortentsTables(out)) {
      expect(sortEntries(table)).toEqual([['27C', '279']]);
    }
  });
});
