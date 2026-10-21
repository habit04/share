/**
 * P17 slice 1 acceptance: associative hatch retention through DXF
 * import -> save -> reopen (PROPOSAL-P17, LEDGER).
 *
 * Written BEFORE the implementation: at base 038cb7b4 the reader
 * consumes and discards the boundary-path source handles (97/330) and
 * the writer hardcodes 71 = 0 / 97 = 0, so every retention case here
 * fails at base. The fixture case uses r2000-hatch-curves.dxf (HATCH
 * handle 51, boundary LWPOLYLINE 50) — a HAND-WRITTEN AutoCAD-format
 * fixture (creating commit 3c1e83b: "nine hand-written AutoCAD-layout
 * DXF files"), NOT authored by AutoCAD. A genuine natively-authored
 * associative-hatch fixture is a lead/Windows-gate item; the build
 * recipe is in evidence-p17/RECIPE-native-associative-hatch-fixture.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HatchEntity, PolylineEntity } from '../src/core/entities';
import type { DrawingState } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';

type Pair = readonly [number, string | number];

/** A closed square LWPOLYLINE (handle 50) + a SOLID hatch (handle 51) over it. */
function assocDxf(opts: { associative?: boolean; refHandle?: string } = {}): string {
  const associative = opts.associative ?? true;
  const ref = opts.refHandle ?? '50';
  const fields: Pair[] = [
    [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LWPOLYLINE'], [5, '50'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbPolyline'],
    [90, 4], [70, 1],
    [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10],
    [0, 'HATCH'], [5, '51'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbHatch'],
    [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1],
    [2, 'SOLID'], [70, 1], [71, associative ? 1 : 0], [91, 1],
    [92, 3], [72, 0], [73, 1], [93, 4],
    [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10],
    [97, associative ? 1 : 0], ...(associative ? [[330, ref]] as Pair[] : []),
    [75, 0], [76, 1], [98, 0],
    [0, 'ENDSEC'], [0, 'EOF'],
  ];
  return fields.flat().join('\n');
}

/** Split written DXF into per-entity group lists, in file order. */
function records(text: string): Array<{ kind: string; groups: Array<[number, string]> }> {
  const lines = text.split(/\r?\n/);
  const out: Array<{ kind: string; groups: Array<[number, string]> }> = [];
  let cur: { kind: string; groups: Array<[number, string]> } | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]);
    const value = lines[i + 1]!;
    if (code === 0) {
      cur = { kind: value, groups: [] };
      out.push(cur);
    } else if (cur) cur.groups.push([code, value]);
  }
  return out;
}
const group = (rec: { groups: Array<[number, string]> }, code: number): string | undefined =>
  rec.groups.find(([c]) => c === code)?.[1];
/** The 330 that follows a 97 inside a record (the boundary-path source list). */
const boundaryRefsOf = (rec: { groups: Array<[number, string]> }): string[] => {
  const at = rec.groups.findIndex(([c]) => c === 97);
  if (at < 0) return [];
  const count = Number(rec.groups[at]![1]);
  return rec.groups.slice(at + 1, at + 1 + count).filter(([c]) => c === 330).map(([, v]) => v);
};

describe('associative HATCH: DXF retention round-trip', () => {
  it('import resolves the per-loop boundary handle to the boundary entity id', () => {
    const state = readDxf(assocDxf());
    const hatch = state.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
    const poly = state.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
    expect(hatch.associative).toBe(true);
    expect(hatch.loops).toHaveLength(1);
    expect(hatch.loops[0]!.boundaryRefs).toEqual([poly.id]);
    expect(hatch.loops[0]!.boundaryHandles).toBeUndefined();
  });

  it('save writes 71 = 1 and the loop 97/330 naming the boundary handle actually written', () => {
    const written = writeDxf(readDxf(assocDxf()));
    const recs = records(written);
    const hatch = recs.find((r) => r.kind === 'HATCH')!;
    const poly = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(hatch, 71)).toBe('1');
    expect(group(hatch, 97)).toBe('1');
    expect(boundaryRefsOf(hatch)).toEqual([group(poly, 5)]);
  });

  it('reopening the saved file resolves the association again (fixed point)', () => {
    const once = readDxf(assocDxf());
    const twice = readDxf(writeDxf(once));
    const hatch = twice.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
    const poly = twice.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
    expect(hatch.associative).toBe(true);
    expect(hatch.loops[0]!.boundaryRefs).toEqual([poly.id]);
    expect(hatch.loops[0]!.points).toEqual(once.entities.find((e): e is HatchEntity => e.type === 'hatch')!.loops[0]!.points);
  });

  it('a non-associative hatch keeps the exact base write behaviour (71 = 0, 97 = 0)', () => {
    const written = writeDxf(readDxf(assocDxf({ associative: false })));
    const hatch = records(written).find((r) => r.kind === 'HATCH')!;
    expect(group(hatch, 71)).toBe('0');
    expect(group(hatch, 97)).toBe('0');
    expect(boundaryRefsOf(hatch)).toEqual([]);
  });

  it('an unresolvable boundary handle is retained as a raw handle and reported, never invented as a link', () => {
    const state = readDxf(assocDxf({ refHandle: '7E' }));
    const hatch = state.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
    expect(hatch.loops[0]!.boundaryRefs).toBeUndefined();
    expect(hatch.loops[0]!.boundaryHandles).toEqual(['7E']);
    expect(hatch.associative).toBeUndefined();
    const report = importReportOf(state);
    expect(report?.items.some((item) => /associative hatch/i.test(item.reason) && /7E/.test(item.reason))).toBe(true);
    // And it is not written back as a phantom 330.
    const written = records(writeDxf(state)).find((r) => r.kind === 'HATCH')!;
    expect(group(written, 71)).toBe('0');
    expect(boundaryRefsOf(written)).toEqual([]);
  });

  it('an associative hatch inside a block definition keeps its link through save/reopen (layouts mechanism)', () => {
    // Associations resolve per entity list (model space, paper layouts and
    // block definitions share the read-pass resolution), so a hatch whose
    // boundary lives in the same block definition round-trips its link.
    const plain = readDxf(assocDxf());
    const blocked: DrawingState = {
      ...plain,
      entities: [],
      blocks: { BLK: { name: 'BLK', basePoint: { x: 0, y: 0 }, entities: plain.entities, attributes: [] } },
    };
    const reopened = readDxf(writeDxf(blocked));
    const def = reopened.blocks['BLK']!;
    expect(def).toBeDefined();
    const hatch = def.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
    const poly = def.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
    expect(hatch.associative).toBe(true);
    expect(hatch.loops[0]!.boundaryRefs).toEqual([poly.id]);
  });

  it('the hand-written fixture hatch (handle 51 -> LWPOLYLINE 50) retains and re-emits its link', () => {
    const text = readFileSync(join(__dirname, 'fixtures/interchange/r2000-hatch-curves.dxf'), 'utf8');
    const state = readDxf(text);
    // cadIdentity is the cad-graph node id "<session>:<source handle>".
    const hatch = state.entities.find((e): e is HatchEntity => e.type === 'hatch' && e.cadIdentity?.endsWith(':51') === true)!;
    const poly = state.entities.find((e) => e.cadIdentity?.endsWith(':50'))!;
    expect(hatch.associative).toBe(true);
    expect(hatch.loops[0]!.boundaryRefs).toEqual([poly.id]);
    const written = writeDxf(state);
    const recs = records(written);
    const writtenHatch = recs.find((r) => r.kind === 'HATCH' && group(r, 2) === 'ANSI31' && group(r, 71) === '1');
    expect(writtenHatch).toBeDefined();
    const reopened = readDxf(written);
    const reHatch = reopened.entities.find((e): e is HatchEntity => e.type === 'hatch' && e.associative === true)!;
    const rePoly = reopened.entities.find((e): e is PolylineEntity => e.type === 'polyline' && (reHatch.loops[0]!.boundaryRefs?.includes(e.id) ?? false));
    expect(rePoly).toBeDefined();
  });
});
