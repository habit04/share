/**
 * v0.6.4 pre-release review finding F-A (regression vs v0.6.3): the
 * round-6 stale-reactor cleanup in ensureAssociativeHatchReactors removed
 * ANY {ACAD_REACTORS 330 <hatch>} entry naming a hatch written 71 = 0 —
 * from every record in the file, including the hatch's own extension
 * DICTIONARY (its ACAD_XDICTIONARY target), which legitimately reacts to
 * its owning hatch. Every non-associative hatch with an xdictionary lost
 * that back-reactor on a plain open -> save.
 *
 * The cleanup is now confined to ENTITY records (100 AcDbEntity), where a
 * reactor toward a hatch can only be a boundary back-pointer. OBJECTS
 * records are never edited, and an entry the record's own owner explains
 * is kept. #48's boundary-side cleanup (tests/hatch-assoc-dxf.test.ts,
 * round 6 (c)) is unchanged.
 */
import { describe, it, expect } from 'vitest';
import { readDxf, writeDxf } from '../src/io/dxf';
import { ensureAssociativeHatchReactors } from '../src/io/cad-graph-dxf';

type Pair = readonly [number, string | number];
const dxf = (fields: Pair[]) => fields.flat().join('\n');
type Rec = { kind: string; groups: Array<[number, string]> };
function records(text: string): Rec[] {
  const lines = text.split(/\r?\n/);
  const out: Rec[] = [];
  let cur: Rec | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim()); const value = lines[i + 1]!;
    if (code === 0) { cur = { kind: value.trim(), groups: [] }; out.push(cur); } else cur?.groups.push([code, value.trim()]);
  }
  return out;
}
const group = (rec: Rec, code: number): string | undefined => rec.groups.find(([c]) => c === code)?.[1];
const reactorsOf = (rec: Rec) => {
  const out: string[] = []; let inside = false;
  for (const [c, v] of rec.groups) { if (c === 102 && v === '{ACAD_REACTORS') inside = true; else if (c === 102 && v === '}' && inside) inside = false; else if (inside && c === 330) out.push(v); }
  return out;
};
const byHandle = (recs: Rec[], kind: string, handle: string | undefined): Rec | undefined => recs.find((r) => r.kind === kind && group(r, 5) === handle);

/**
 * Non-associative SOLID hatch 51 with an extension dictionary D1 (reactor
 * -> 51, owner 51) owning an XRECORD D2 (reactor -> D1). Polyline 50
 * carries a stale reactor to 51 (left behind by an earlier associative
 * save): that one IS a boundary back-pointer and must go.
 */
const xdictHatch = (): string => dxf([
  [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'ENTITIES'],
  [0, 'LWPOLYLINE'], [5, '50'], [102, '{ACAD_REACTORS'], [330, '51'], [102, '}'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbPolyline'],
  [90, 4], [70, 1], [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10],
  [0, 'HATCH'], [5, '51'], [102, '{ACAD_XDICTIONARY'], [360, 'D1'], [102, '}'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbHatch'],
  [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1],
  [2, 'SOLID'], [70, 1], [71, 0], [91, 1],
  [92, 3], [72, 0], [73, 1], [93, 4],
  [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10],
  [97, 0], [75, 0], [76, 1], [98, 0],
  [0, 'ENDSEC'],
  [0, 'SECTION'], [2, 'OBJECTS'],
  [0, 'DICTIONARY'], [5, 'C'], [330, '0'], [100, 'AcDbDictionary'], [281, 1],
  [0, 'DICTIONARY'], [5, 'D1'], [102, '{ACAD_REACTORS'], [330, '51'], [102, '}'], [330, '51'], [100, 'AcDbDictionary'], [280, 1], [281, 1], [3, 'MYAPP'], [360, 'D2'],
  [0, 'XRECORD'], [5, 'D2'], [102, '{ACAD_REACTORS'], [330, 'D1'], [102, '}'], [330, 'D1'], [100, 'AcDbXrecord'], [280, 1], [1, 'payload'],
  [0, 'ENDSEC'], [0, 'EOF'],
]);

describe('F-A: reactor cleanup never edits OBJECTS records', () => {
  it('ensureAssociativeHatchReactors alone: the xdictionary keeps its back-reactor, the boundary entity loses its stale one', () => {
    const text = xdictHatch();
    const out = ensureAssociativeHatchReactors(text);
    const recs = records(out);
    expect(reactorsOf(byHandle(recs, 'DICTIONARY', 'D1')!)).toEqual(['51']);
    expect(reactorsOf(byHandle(recs, 'XRECORD', 'D2')!)).toEqual(['D1']);
    // The entity-side stale pointer is still removed, block and all (#48 round 6).
    const poly = byHandle(recs, 'LWPOLYLINE', '50')!;
    expect(reactorsOf(poly)).toEqual([]);
    expect(poly.groups.some(([c, v]) => c === 102 && v === '{ACAD_REACTORS')).toBe(false);
  });

  it('full read -> write: the xdictionary back-reactor survives a plain save, and the second save is stable', () => {
    const written = writeDxf(readDxf(xdictHatch()));
    const recs = records(written);
    const hatch = recs.find((r) => r.kind === 'HATCH')!;
    expect(group(hatch, 71)).toBe('0');
    const xi = hatch.groups.findIndex(([c, v]) => c === 102 && v === '{ACAD_XDICTIONARY');
    expect(xi).toBeGreaterThanOrEqual(0);
    const xdictPtr = hatch.groups[xi + 1]![1];
    const d1 = byHandle(recs, 'DICTIONARY', xdictPtr);
    expect(d1).toBeDefined();
    expect(reactorsOf(d1!)).toEqual([group(hatch, 5)]);
    expect(group(d1!, 330)).toBe(group(hatch, 5));
    // Stale boundary-side pointer gone, boundary still present.
    const poly = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(reactorsOf(poly)).toEqual([]);
    const again = writeDxf(readDxf(written));
    expect(again).toBe(written);
  });

  it('an OBJECTS record whose reactor names a demoted hatch for any other reason is left alone too', () => {
    // An XRECORD in the named-objects dictionary reacting to hatch 51: not an entity, never edited.
    const withObject = xdictHatch().replace(
      '0\nENDSEC\n0\nEOF',
      '0\nXRECORD\n5\nE1\n102\n{ACAD_REACTORS\n330\n51\n102\n}\n330\nC\n100\nAcDbXrecord\n280\n1\n1\nnote\n0\nENDSEC\n0\nEOF',
    );
    expect(withObject).toContain('E1');
    const out = records(ensureAssociativeHatchReactors(withObject));
    expect(reactorsOf(byHandle(out, 'XRECORD', 'E1')!)).toEqual(['51']);
  });
});
