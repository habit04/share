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
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { hatchEditTool } from '../src/tools/drafting-annot';
import { fakeContext, drive } from './fake-context';

type Pair = readonly [number, string | number];

/** A closed square LWPOLYLINE (handle 50) + a SOLID hatch (handle 51) over it. */
function assocDxf(opts: { associative?: boolean; refHandle?: string; duplicateBoundary?: boolean } = {}): string {
  const associative = opts.associative ?? true;
  const ref = opts.refHandle ?? '50';
  const fields: Pair[] = [
    [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'LWPOLYLINE'], [5, '50'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbPolyline'],
    [90, 4], [70, 1],
    [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10],
    // The acceptance 4B specimen: a SECOND LWPOLYLINE carrying the SAME
    // handle 50 (an invalid file), shifted +100 in x so the two same-handle
    // records are distinguishable by their geometry.
    ...(opts.duplicateBoundary ? [
      [0, 'LWPOLYLINE'], [5, '50'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbPolyline'],
      [90, 4], [70, 1],
      [10, 100], [20, 0], [10, 110], [20, 0], [10, 110], [20, 10], [10, 100], [20, 10],
    ] as Pair[] : []),
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

  it('duplicate boundary handle (acceptance 4B): the link resolves to the LAST same-handle entity and the import report says so', () => {
    // AMENDMENT-P17-HANDLES O4, as accepted: on an invalid file whose records
    // reuse a handle, references to that handle resolve to the last object
    // with the handle in the file, deterministically — and the import report
    // states that behaviour plainly, not only that the CAD metadata could
    // not be imported safely.
    for (let read = 0; read < 2; read++) {
      const state = readDxf(assocDxf({ duplicateBoundary: true }));
      const polys = state.entities.filter((e): e is PolylineEntity => e.type === 'polyline');
      expect(polys).toHaveLength(2);
      const last = polys.find((p) => p.points[0]!.x === 100)!;
      expect(last).toBeDefined();
      const hatch = state.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
      expect(hatch.associative).toBe(true);
      expect(hatch.loops[0]!.boundaryRefs).toEqual([last.id]);
      const report = importReportOf(state);
      const dup = report?.items.find((item) => /Duplicate CAD object handle 50/.test(item.reason));
      expect(dup).toBeDefined();
      expect(dup!.type).toBe('CAD_METADATA');
      expect(dup!.reason).toMatch(/could not be imported safely/);
      expect(dup!.reason).toMatch(/resolve to the last object with that handle in the file/);
    }
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

describe('P17 R1: boundary back-reactors ({ACAD_REACTORS}) and the O5 save rule', () => {
  // Native gate finding (PR #44): an associative hatch written by JCad
  // carried 71 = 1 and the 97/330 boundary list, but the boundary object
  // never carried the back-pointer {ACAD_REACTORS / 330 <hatch> / }, so
  // AutoCAD AUDIT reported 'Boundary Missing a Reactor — Remove
  // Associativity' and the hatch did not follow boundary edits. Every
  // case below is RED at base 0ef61bb for exactly that reason (the O5
  // case: base writes the cross-owner link as 71 = 1).
  /** 330 values inside a record's {ACAD_REACTORS …} block, in file order. */
  const reactorsOf = (rec: { groups: Array<[number, string]> }): string[] => {
    const out: string[] = [];
    let inside = false;
    for (const [c, v] of rec.groups) {
      if (c === 102 && v === '{ACAD_REACTORS') inside = true;
      else if (c === 102 && v === '}' && inside) inside = false;
      else if (inside && c === 330) out.push(v);
    }
    return out;
  };
  const props = { layer: '0', color: 'ByLayer' as const };
  const sq = (x: number, y: number, s: number) => [
    { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
  ];
  const boundaryPoly = (id: string, x = 0, y = 0, s = 10): PolylineEntity => ({
    id, ...props, type: 'polyline', points: sq(x, y, s), closed: true,
  });
  const solidHatch = (id: string, boundaryId: string): HatchEntity => ({
    id, ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1,
    loops: [{ points: sq(0, 0, 10), boundaryRefs: [boundaryId] }], associative: true,
  });

  it('SOLID: the boundary object carries {ACAD_REACTORS -> the hatch handle}', () => {
    const recs = records(writeDxf(readDxf(assocDxf())));
    const hatch = recs.find((r) => r.kind === 'HATCH')!;
    const poly = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(hatch, 71)).toBe('1');
    expect(reactorsOf(poly)).toEqual([group(hatch, 5)]);
  });

  it('PAT: a patterned associative hatch writes the back-reactor too', () => {
    const state: DrawingState = {
      entities: [
        boundaryPoly('b1'),
        { id: 'h1', ...props, type: 'hatch', pattern: 'ANSI31', solid: false, angle: 0, scale: 1, associative: true,
          loops: [{ points: sq(0, 0, 10), boundaryRefs: ['b1'] }] },
      ],
      layers: [], blocks: {}, currentLayer: '0',
    };
    const recs = records(writeDxf(state));
    const hatch = recs.find((r) => r.kind === 'HATCH')!;
    const poly = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(hatch, 71)).toBe('1');
    expect(reactorsOf(poly)).toEqual([group(hatch, 5)]);
  });

  it('GRAD: a gradient associative hatch writes the back-reactor too', () => {
    const state: DrawingState = {
      entities: [
        boundaryPoly('b1'),
        { id: 'h1', ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1, associative: true,
          loops: [{ points: sq(0, 0, 10), boundaryRefs: ['b1'] }],
          gradient: { name: 'LINEAR', angle: 0, shift: 0, singleColor: false, tint: 0.5, kind: 1,
            colors: [{ position: 0, color: 0 }, { position: 1, trueColor: 0xffffff }] } },
      ],
      layers: [], blocks: {}, currentLayer: '0',
    };
    const recs = records(writeDxf(state));
    const hatch = recs.find((r) => r.kind === 'HATCH')!;
    const poly = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(hatch, 71)).toBe('1');
    expect(reactorsOf(poly)).toEqual([group(hatch, 5)]);
  });

  it('a boundary shared by two hatches carries both hatch handles, once each', () => {
    const state: DrawingState = {
      entities: [boundaryPoly('b1'), solidHatch('h1', 'b1'), solidHatch('h2', 'b1')],
      layers: [], blocks: {}, currentLayer: '0',
    };
    const recs = records(writeDxf(state));
    const poly = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    const hatches = recs.filter((r) => r.kind === 'HATCH');
    expect(hatches).toHaveLength(2);
    for (const h of hatches) expect(group(h, 71)).toBe('1');
    expect(reactorsOf(poly)).toEqual(hatches.map((h) => group(h, 5)));
  });

  it('a hatch and boundary inside one block definition: the back-reactor lands on the block-internal boundary', () => {
    const plain = readDxf(assocDxf());
    const blocked: DrawingState = {
      ...plain,
      entities: [],
      blocks: { BLK: { name: 'BLK', basePoint: { x: 0, y: 0 }, entities: plain.entities, attributes: [] } },
    };
    const recs = records(writeDxf(blocked));
    const hatch = recs.find((r) => r.kind === 'HATCH')!;
    const poly = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(hatch, 71)).toBe('1');
    expect(reactorsOf(poly)).toEqual([group(hatch, 5)]);
  });

  /** A boundary polyline (50) that already reacts to a LINE (60), plus the SOLID hatch (51) over it. */
  const mergeDxf = (): string => {
    const fields: Pair[] = [
      [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'LINE'], [5, '60'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbLine'],
      [10, 0], [20, 20], [11, 5], [21, 20],
      [0, 'LWPOLYLINE'], [5, '50'],
      [102, '{ACAD_REACTORS'], [330, '60'], [102, '}'],
      [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbPolyline'],
      [90, 4], [70, 1],
      [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10],
      [0, 'HATCH'], [5, '51'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbHatch'],
      [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1],
      [2, 'SOLID'], [70, 1], [71, 1], [91, 1],
      [92, 3], [72, 0], [73, 1], [93, 4],
      [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10],
      [97, 1], [330, '50'],
      [75, 0], [76, 1], [98, 0],
      [0, 'ENDSEC'], [0, 'EOF'],
    ];
    return fields.flat().join('\n');
  };

  it('merge: a pre-existing reactor is preserved and the hatch reactor is added, once each', () => {
    const recs = records(writeDxf(readDxf(mergeDxf())));
    const poly = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    const line = recs.find((r) => r.kind === 'LINE')!;
    const hatch = recs.find((r) => r.kind === 'HATCH')!;
    const reactors = reactorsOf(poly);
    expect(reactors).toContain(group(line, 5));
    expect(reactors).toContain(group(hatch, 5));
    expect(reactors).toHaveLength(2);
    expect(new Set(reactors).size).toBe(2);
  });

  it('idempotence: save -> reopen -> save is byte-stable and reactors never duplicate', () => {
    const once = writeDxf(readDxf(mergeDxf()));
    const twice = writeDxf(readDxf(once));
    expect(twice).toBe(once);
    const poly = records(twice).find((r) => r.kind === 'LWPOLYLINE')!;
    expect(reactorsOf(poly)).toHaveLength(2);
  });

  it('O5: a cross-owner association is saved non-associative (71 = 0), boundary handle list retained, no back-reactor', () => {
    const plain = readDxf(assocDxf());
    const hatch = plain.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
    const poly = plain.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
    const crossed: DrawingState = {
      ...plain,
      entities: [hatch],
      blocks: { BLK: { name: 'BLK', basePoint: { x: 0, y: 0 }, entities: [poly], attributes: [] } },
    };
    const recs = records(writeDxf(crossed));
    const writtenHatch = recs.find((r) => r.kind === 'HATCH')!;
    const writtenPoly = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(writtenHatch, 71)).toBe('0');
    expect(boundaryRefsOf(writtenHatch)).toEqual([group(writtenPoly, 5)]);
    expect(reactorsOf(writtenPoly)).toEqual([]);
  });
});

describe('P17 additions (Codex P1-d): retained handle links are emitted, not dropped', () => {
  // Codex PR #44 P1-d: the writer emitted only boundaryRefs-derived links;
  // a loop's retained raw handles (HatchLoop.boundaryHandles) were silently
  // dropped, so a block-resident hatch linked to a model-space boundary
  // lost the link on save — the reopened file had nothing, and 97/71 were
  // gone. A retained handle that names an entity this writer emits (via
  // its source identity) is a link like any other: it joins the 97/330
  // list, follows the same O5 owner rule, and composes with the R1
  // back-reactor pass. A handle naming NO object in the drawing stays
  // unemitted — absence is not a link.
  const props = { layer: '0', color: 'ByLayer' as const };
  const sq = (x: number, y: number, s: number) => [
    { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
  ];
  /** 330 values inside a record's {ACAD_REACTORS …} block, in file order. */
  const reactorsOf = (rec: { groups: Array<[number, string]> }): string[] => {
    const out: string[] = [];
    let inside = false;
    for (const [c, v] of rec.groups) {
      if (c === 102 && v === '{ACAD_REACTORS') inside = true;
      else if (c === 102 && v === '}' && inside) inside = false;
      else if (inside && c === 330) out.push(v);
    }
    return out;
  };

  it('a block hatch whose retained handle names a model-space boundary writes the link, stays 71 = 0 (O5), and survives a second save', () => {
    const modelPoly: PolylineEntity = {
      id: 'm1', ...props, type: 'polyline', points: sq(0, 0, 10), closed: true, cadIdentity: '50',
    };
    const blockHatch: HatchEntity = {
      id: 'bh1', ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1,
      loops: [{ points: sq(0, 0, 10), boundaryHandles: ['50'] }],
    };
    const state: DrawingState = {
      entities: [modelPoly], layers: [], currentLayer: '0',
      blocks: { BLK: { name: 'BLK', basePoint: { x: 0, y: 0 }, entities: [blockHatch], attributes: [] } },
    };
    const written = writeDxf(state);
    const recs = records(written);
    const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
    const polyRec = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(hatchRec, 97)).toBe('1');
    expect(boundaryRefsOf(hatchRec)).toEqual([group(polyRec, 5)]);
    expect(group(hatchRec, 71)).toBe('0');
    expect(reactorsOf(polyRec)).toEqual([]);
    // Reopen: the block hatch retains the handle as written; the second
    // save emits it again — 97/71 do not clear.
    const reopened = readDxf(written);
    const reHatch = reopened.blocks['BLK']!.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
    expect(reHatch.loops[0]!.boundaryHandles).toEqual([group(polyRec, 5)]);
    const recs2 = records(writeDxf(reopened));
    const hatch2 = recs2.find((r) => r.kind === 'HATCH')!;
    const poly2 = recs2.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(hatch2, 97)).toBe('1');
    expect(boundaryRefsOf(hatch2)).toEqual([group(poly2, 5)]);
    expect(group(hatch2, 71)).toBe('0');
  });

  it('a retained handle naming a boundary in the SAME block is a live same-owner link (71 = 1, back-reactor written)', () => {
    const polyInBlock: PolylineEntity = {
      id: 'bp1', ...props, type: 'polyline', points: sq(0, 0, 10), closed: true, cadIdentity: '50',
    };
    const hatchInBlock: HatchEntity = {
      id: 'bh1', ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1,
      loops: [{ points: sq(0, 0, 10), boundaryHandles: ['50'] }],
    };
    const state: DrawingState = {
      entities: [], layers: [], currentLayer: '0',
      blocks: { BLK: { name: 'BLK', basePoint: { x: 0, y: 0 }, entities: [polyInBlock, hatchInBlock], attributes: [] } },
    };
    const recs = records(writeDxf(state));
    const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
    const polyRec = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(hatchRec, 97)).toBe('1');
    expect(boundaryRefsOf(hatchRec)).toEqual([group(polyRec, 5)]);
    expect(group(hatchRec, 71)).toBe('1');
    expect(reactorsOf(polyRec)).toEqual([group(hatchRec, 5)]);
  });

  it('a loop naming one boundary by BOTH entity id and retained handle emits the link once', () => {
    const poly: PolylineEntity = {
      id: 'm1', ...props, type: 'polyline', points: sq(0, 0, 10), closed: true, cadIdentity: '50',
    };
    const hatch: HatchEntity = {
      id: 'h1', ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1, associative: true,
      loops: [{ points: sq(0, 0, 10), boundaryRefs: ['m1'], boundaryHandles: ['50'] }],
    };
    const state: DrawingState = { entities: [poly, hatch], layers: [], blocks: {}, currentLayer: '0' };
    const recs = records(writeDxf(state));
    const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
    const polyRec = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(hatchRec, 97)).toBe('1');
    expect(boundaryRefsOf(hatchRec)).toEqual([group(polyRec, 5)]);
    expect(group(hatchRec, 71)).toBe('1');
    expect(reactorsOf(polyRec)).toEqual([group(hatchRec, 5)]);
  });

  it('a retained handle naming NO object in the drawing is still not emitted (absence is not a link)', () => {
    const hatch: HatchEntity = {
      id: 'h1', ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1,
      loops: [{ points: sq(0, 0, 10), boundaryHandles: ['7E'] }],
    };
    const state: DrawingState = { entities: [hatch], layers: [], blocks: {}, currentLayer: '0' };
    const hatchRec = records(writeDxf(state)).find((r) => r.kind === 'HATCH')!;
    expect(group(hatchRec, 97)).toBe('0');
    expect(boundaryRefsOf(hatchRec)).toEqual([]);
    expect(group(hatchRec, 71)).toBe('0');
  });
});

describe('P17 round 2 (Codex P1): retained graph anchors (REGION/BODY) as hatch boundaries', () => {
  // Codex PR #44 round 2, P1 (writer.ts / write-entities.ts): the
  // source-handle index only covered ENTITIES, so an imported hatch whose
  // boundary is a retained REGION or BODY — kept in the cad graph as a raw
  // record and still emitted on save — wrote 97 = 0 and lost the link.
  // Retained graph anchors join the lookup and the link is remapped to the
  // anchor's emitted handle; a retained handle that names a graph object
  // the writer does NOT emit as a boundary refuses the save atomically
  // instead of being silently dropped.
  const reactorsOf = (rec: { groups: Array<[number, string]> }): string[] => {
    const out: string[] = [];
    let inside = false;
    for (const [c, v] of rec.groups) {
      if (c === 102 && v === '{ACAD_REACTORS') inside = true;
      else if (c === 102 && v === '}' && inside) inside = false;
      else if (inside && c === 330) out.push(v);
    }
    return out;
  };
  /** A retained REGION/BODY (handle 60) + a SOLID hatch (51) naming it as its boundary. */
  const rawBoundaryDxf = (kind: 'REGION' | 'BODY', handle = '60'): string => {
    const fields: Pair[] = [
      [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, kind], [5, handle], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbModelerGeometry'],
      [1, 'ACIS data placeholder line one'], [1, 'ACIS data placeholder line two'],
      [0, 'HATCH'], [5, '51'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbHatch'],
      [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1],
      [2, 'SOLID'], [70, 1], [71, 1], [91, 1],
      [92, 3], [72, 0], [73, 1], [93, 4],
      [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10],
      [97, 1], [330, handle],
      [75, 0], [76, 1], [98, 0],
      [0, 'ENDSEC'], [0, 'EOF'],
    ];
    return fields.flat().join('\n');
  };

  for (const kind of ['REGION', 'BODY'] as const) {
    it(`an imported hatch linked to a retained ${kind} keeps the link (97/330 remapped, 71 = 1, back-reactor)`, () => {
      const state = readDxf(rawBoundaryDxf(kind));
      const hatch = state.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
      expect(hatch.loops[0]!.boundaryHandles).toEqual(['60']);
      const written = writeDxf(state);
      const recs = records(written);
      const rawRec = recs.find((r) => r.kind === kind)!;
      const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
      expect(rawRec).toBeDefined();
      expect(group(rawRec, 5)).toBe('60');
      expect(group(hatchRec, 97)).toBe('1');
      expect(boundaryRefsOf(hatchRec)).toEqual(['60']);
      expect(group(hatchRec, 71)).toBe('1');
      expect(reactorsOf(rawRec)).toEqual([group(hatchRec, 5)]);
      // Reopen + save again: the link is a fixed point, not a one-save survival.
      const recs2 = records(writeDxf(readDxf(written)));
      const raw2 = recs2.find((r) => r.kind === kind)!;
      const hatch2 = recs2.find((r) => r.kind === 'HATCH')!;
      expect(group(hatch2, 97)).toBe('1');
      expect(boundaryRefsOf(hatch2)).toEqual(['60']);
      expect(group(hatch2, 71)).toBe('1');
      expect(reactorsOf(raw2)).toEqual([group(hatch2, 5)]);
    });
  }

  it('a retained handle naming a graph object that is not an emitted boundary refuses the save atomically', () => {
    // The hatch's boundary handle (70) names the drawing's DICTIONARY —
    // an object the retained graph carries but that is not a boundary the
    // writer emits. Dropping the link silently is the P1 failure mode;
    // the save must refuse, not write a hatch that lost its boundary.
    const fields: Pair[] = [
      [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'HATCH'], [5, '51'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbHatch'],
      [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1],
      [2, 'SOLID'], [70, 1], [71, 1], [91, 1],
      [92, 3], [72, 0], [73, 1], [93, 4],
      [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10],
      [97, 1], [330, '70'],
      [75, 0], [76, 1], [98, 0],
      [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'OBJECTS'],
      [0, 'DICTIONARY'], [5, '70'], [330, '0'], [100, 'AcDbDictionary'], [280, 0], [281, 1],
      [0, 'ENDSEC'], [0, 'EOF'],
    ];
    const state = readDxf(fields.flat().join('\n'));
    const hatch = state.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
    expect(hatch.loops[0]!.boundaryHandles).toEqual(['70']);
    expect(() => writeDxf(state)).toThrow(/boundary handle 70/i);
  });
});

describe('P17 round 3 (Codex PR #48 P1): retained anchors colliding with fixed structural handles', () => {
  // Codex PR #48, the one remaining P1 (writer.ts / write-entities.ts):
  // round 2's anchorAvoid withholds a hatch-named anchor handle from
  // the writer's ALLOCATOR, but the generated stream also carries FIXED
  // structural handles that are never allocated — the root dictionary
  // (C), the model-space BLOCK_RECORD (1F), the other symbol tables and
  // dictionaries. Those records enter preserveDxfCadGraph's
  // generated-reference rewrite map keyed by their handle, so a retained
  // REGION/BODY whose SOURCE handle is C or 1F aliased them: the
  // hatch's raw 330 was rewritten to the dictionary / block record (or
  // the boundary record duplicated the structural handle outright).
  // The fix remaps such an anchor to a fresh writer handle BEFORE the
  // rewrite map exists — the retained record is emitted under the fresh
  // handle and the hatch names it — so a boundary reference can never
  // alias a fixed structural handle.
  const reactorsOf = (rec: { groups: Array<[number, string]> }): string[] => {
    const out: string[] = [];
    let inside = false;
    for (const [c, v] of rec.groups) {
      if (c === 102 && v === '{ACAD_REACTORS') inside = true;
      else if (c === 102 && v === '}' && inside) inside = false;
      else if (inside && c === 330) out.push(v);
    }
    return out;
  };
  /** A retained REGION/BODY at `handle` + a SOLID hatch (51) naming it as its boundary.
   * The boundary is owned by the model-space BLOCK_RECORD, which the graph
   * carries under its own handle (20) — in a real file the boundary's handle
   * colliding with the writer's fixed 1F does not make it its own owner. */
  const rawBoundaryDxf = (kind: 'REGION' | 'BODY', handle: string): string => {
    const fields: Pair[] = [
      [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'TABLES'],
      [0, 'TABLE'], [2, 'BLOCK_RECORD'], [5, '1'], [330, '0'], [100, 'AcDbSymbolTable'], [70, 2],
      [0, 'BLOCK_RECORD'], [5, '20'], [330, '1'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbBlockTableRecord'], [2, '*Model_Space'], [70, 0], [280, 1], [281, 0],
      [0, 'BLOCK_RECORD'], [5, '21'], [330, '1'], [100, 'AcDbSymbolTableRecord'], [100, 'AcDbBlockTableRecord'], [2, '*Paper_Space'], [70, 0], [280, 1], [281, 0],
      [0, 'ENDTAB'], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, kind], [5, handle], [330, '20'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbModelerGeometry'],
      [1, 'ACIS data placeholder line one'], [1, 'ACIS data placeholder line two'],
      [0, 'HATCH'], [5, '51'], [330, '20'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbHatch'],
      [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1],
      [2, 'SOLID'], [70, 1], [71, 1], [91, 1],
      [92, 3], [72, 0], [73, 1], [93, 4],
      [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10],
      [97, 1], [330, handle],
      [75, 0], [76, 1], [98, 0],
      [0, 'ENDSEC'], [0, 'EOF'],
    ];
    return fields.flat().join('\n');
  };

  for (const kind of ['REGION', 'BODY'] as const) {
    for (const fixed of ['C', '1F'] as const) {
      it(`a retained ${kind} at fixed handle ${fixed}: the link is remapped to a fresh handle naming the boundary`, () => {
        const state = readDxf(rawBoundaryDxf(kind, fixed));
        const hatch = state.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
        expect(hatch.loops[0]!.boundaryHandles).toEqual([fixed]);
        const written = writeDxf(state);
        const recs = records(written);
        const rawRec = recs.find((r) => r.kind === kind)!;
        const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
        expect(rawRec).toBeDefined();
        const fresh = group(rawRec, 5)!;
        // The boundary is NOT emitted under the structural handle…
        expect(fresh).not.toBe(fixed);
        // …the hatch's target resolves to exactly one record — the boundary.
        // (The structural record itself is in the file under the merge's own
        // handle; what the aliasing broke was the RESOLUTION, so that is
        // what is pinned here.)
        const atFresh = recs.filter((r) => group(r, 5) === fresh);
        expect(atFresh).toHaveLength(1);
        expect(atFresh[0]!.kind).toBe(kind);
        const structural = fixed === 'C'
          ? recs.find((r) => r.kind === 'DICTIONARY')
          : recs.find((r) => r.kind === 'BLOCK_RECORD' && group(r, 2) === '*Model_Space');
        expect(structural).toBeDefined();
        expect(group(structural!, 5)).not.toBe(fresh);
        // …no handle in the file is duplicated…
        const handles = recs.map((r) => group(r, 5)).filter((h): h is string => h !== undefined);
        expect(new Set(handles).size).toBe(handles.length);
        // …and the hatch points at the boundary's fresh handle, associatively.
        expect(group(hatchRec, 97)).toBe('1');
        expect(boundaryRefsOf(hatchRec)).toEqual([fresh]);
        expect(group(hatchRec, 71)).toBe('1');
        expect(reactorsOf(rawRec)).toEqual([group(hatchRec, 5)]);
        // Reopen + save again: the remapped link is a fixed point.
        const recs2 = records(writeDxf(readDxf(written)));
        const raw2 = recs2.find((r) => r.kind === kind)!;
        const hatch2 = recs2.find((r) => r.kind === 'HATCH')!;
        expect(group(raw2, 5)).toBe(fresh);
        expect(boundaryRefsOf(hatch2)).toEqual([fresh]);
        expect(group(hatch2, 71)).toBe('1');
        expect(reactorsOf(raw2)).toEqual([group(hatch2, 5)]);
      });
    }
  }

  it('a retained REGION at 103 (allocator range, withheld since round 2) is NOT remapped', () => {
    const state = readDxf(rawBoundaryDxf('REGION', '103'));
    const written = writeDxf(state);
    const recs = records(written);
    const rawRec = recs.find((r) => r.kind === 'REGION')!;
    const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
    expect(group(rawRec, 5)).toBe('103');
    expect(boundaryRefsOf(hatchRec)).toEqual(['103']);
    expect(group(hatchRec, 71)).toBe('1');
    expect(reactorsOf(rawRec)).toEqual([group(hatchRec, 5)]);
    const recs2 = records(writeDxf(readDxf(written)));
    expect(group(recs2.find((r) => r.kind === 'REGION')!, 5)).toBe('103');
    expect(boundaryRefsOf(recs2.find((r) => r.kind === 'HATCH')!)).toEqual(['103']);
  });
});

describe('P17 round 2 (Codex P1): the O5 classification covers the COMPLETE emitted boundary set', () => {
  // Codex PR #44 round 2, P1 (write-entities.ts): ANY same-owner boundary
  // used to enable 71 = 1 while foreign-owned boundaries were still
  // emitted, with no back-reactor for them — a hatch AutoCAD sees as
  // associative whose foreign boundary carries no reactor. The ruling:
  // if ANY emitted boundary is foreign-owned, the WHOLE hatch is 71 = 0
  // and no reactors are written for it; the handle list is retained.
  const props = { layer: '0', color: 'ByLayer' as const };
  const sq = (x: number, y: number, s: number) => [
    { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
  ];
  const reactorsOf = (rec: { groups: Array<[number, string]> }): string[] => {
    const out: string[] = [];
    let inside = false;
    for (const [c, v] of rec.groups) {
      if (c === 102 && v === '{ACAD_REACTORS') inside = true;
      else if (c === 102 && v === '}' && inside) inside = false;
      else if (inside && c === 330) out.push(v);
    }
    return out;
  };
  /** Every loop's 97/330 list, in loop order. */
  const boundaryRefListsOf = (rec: { groups: Array<[number, string]> }): string[][] => {
    const out: string[][] = [];
    rec.groups.forEach(([c, v], i) => {
      if (c !== 97) return;
      const count = Number(v);
      out.push(rec.groups.slice(i + 1, i + 1 + count).filter(([cc]) => cc === 330).map(([, vv]) => vv));
    });
    return out;
  };
  const localPoly = (id: string): PolylineEntity => ({
    id, ...props, type: 'polyline', points: sq(0, 0, 10), closed: true,
  });
  const foreignPoly = (id: string): PolylineEntity => ({
    id, ...props, type: 'polyline', points: sq(30, 0, 10), closed: true,
  });
  const mixedState = (hatch: HatchEntity): DrawingState => ({
    entities: [localPoly('m1'), hatch], layers: [], currentLayer: '0',
    blocks: { BLK: { name: 'BLK', basePoint: { x: 0, y: 0 }, entities: [foreignPoly('bp1')], attributes: [] } },
  });

  /** The written LWPOLYLINE records, identified by first-point x (0 = the local square, 30 = the other). */
  const polyAt = (recs: Array<{ kind: string; groups: Array<[number, string]> }>, x: string) =>
    recs.filter((r) => r.kind === 'LWPOLYLINE').find((p) => group(p, 10) === x)!;

  it('mixed ownership inside ONE loop: the whole hatch is 71 = 0, both links retained, no reactors anywhere', () => {
    const hatch: HatchEntity = {
      id: 'h1', ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1, associative: true,
      loops: [{ points: sq(0, 0, 10), boundaryRefs: ['m1', 'bp1'] }],
    };
    const recs = records(writeDxf(mixedState(hatch)));
    const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
    const local = polyAt(recs, '0'), foreign = polyAt(recs, '30');
    expect(group(hatchRec, 71)).toBe('0');
    expect(boundaryRefListsOf(hatchRec)).toEqual([[group(local, 5), group(foreign, 5)]]);
    expect(reactorsOf(local)).toEqual([]);
    expect(reactorsOf(foreign)).toEqual([]);
  });

  it('mixed ownership across SEPARATE loops: the whole hatch is 71 = 0, both links retained, no reactors anywhere', () => {
    const hatch: HatchEntity = {
      id: 'h1', ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1, associative: true,
      loops: [
        { points: sq(0, 0, 10), boundaryRefs: ['m1'] },
        { points: sq(30, 0, 10), boundaryRefs: ['bp1'] },
      ],
    };
    const recs = records(writeDxf(mixedState(hatch)));
    const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
    const local = polyAt(recs, '0'), foreign = polyAt(recs, '30');
    expect(group(hatchRec, 71)).toBe('0');
    expect(boundaryRefListsOf(hatchRec)).toEqual([[group(local, 5)], [group(foreign, 5)]]);
    expect(reactorsOf(local)).toEqual([]);
    expect(reactorsOf(foreign)).toEqual([]);
  });

  it('guard: a multi-loop hatch whose boundaries are ALL same-owner stays 71 = 1 with back-reactors', () => {
    const hatch: HatchEntity = {
      id: 'h1', ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1, associative: true,
      loops: [
        { points: sq(0, 0, 10), boundaryRefs: ['m1'] },
        { points: sq(30, 0, 10), boundaryRefs: ['m2'] },
      ],
    };
    const state: DrawingState = {
      entities: [localPoly('m1'), foreignPoly('m2'), hatch], layers: [], blocks: {}, currentLayer: '0',
    };
    const recs = records(writeDxf(state));
    const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
    const first = polyAt(recs, '0'), second = polyAt(recs, '30');
    expect(group(hatchRec, 71)).toBe('1');
    expect(boundaryRefListsOf(hatchRec)).toEqual([[group(first, 5)], [group(second, 5)]]);
    for (const p of [first, second]) expect(reactorsOf(p)).toEqual([group(hatchRec, 5)]);
  });
});

describe('P17 round 4 (lead ruling): 71 = 0 is inert on read; HATCHEDIT Disassociate sticks', () => {
  // Round 4 item 1: a hatch saved 71 = 0 (the round-2 mixed-owner shapes
  // below) must REOPEN inert — its retained 97/330 list stays raw handles,
  // never live refs — so a later boundary edit cannot move its fill, and
  // the next save still writes 71 = 0. At c0f70e9 the read resolver
  // promotes the local handle to a live ref regardless of the 71 flag, so
  // the reopened hatch is associative and the fill follows the boundary.
  // Round 4 item 2: HATCHEDIT's Disassociate must clear the links
  // themselves (refs AND retained handles on every loop), not just the
  // flag — at c0f70e9 the tool only flips the flag, maintenance refreshes
  // the fill on the next boundary edit, and the writer re-derives 71 = 1.
  const props = { layer: '0', color: 'ByLayer' as const };
  const sq = (x: number, y: number, s: number) => [
    { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
  ];
  const boundaryRefListsOf = (rec: { groups: Array<[number, string]> }): string[][] => {
    const out: string[][] = [];
    rec.groups.forEach(([c, v], i) => {
      if (c !== 97) return;
      const count = Number(v);
      out.push(rec.groups.slice(i + 1, i + 1 + count).filter(([cc]) => cc === 330).map(([, vv]) => vv));
    });
    return out;
  };
  const localPoly = (id: string): PolylineEntity => ({
    id, ...props, type: 'polyline', points: sq(0, 0, 10), closed: true,
  });
  const foreignPoly = (id: string): PolylineEntity => ({
    id, ...props, type: 'polyline', points: sq(30, 0, 10), closed: true,
  });
  const mixedState = (hatch: HatchEntity): DrawingState => ({
    entities: [localPoly('m1'), hatch], layers: [], currentLayer: '0',
    blocks: { BLK: { name: 'BLK', basePoint: { x: 0, y: 0 }, entities: [foreignPoly('bp1')], attributes: [] } },
  });
  const hatchOf = (state: DrawingState): HatchEntity => state.entities.find((e): e is HatchEntity => e.type === 'hatch')!;

  const expectInertAfterReopen = (hatch: HatchEntity): void => {
    const saved = writeDxf(mixedState(hatch));
    const hatchRec = records(saved).find((r) => r.kind === 'HATCH')!;
    expect(group(hatchRec, 71)).toBe('0');
    const writtenLists = boundaryRefListsOf(hatchRec);
    expect(writtenLists.flat()).toHaveLength(2);
    const doc = new Drawing(readDxf(saved));
    const reopened = hatchOf(doc.snapshot);
    expect(reopened.associative).toBe(false);
    for (const loop of reopened.loops) expect(loop.boundaryRefs).toBeUndefined();
    expect(reopened.loops.map((l) => [...(l.boundaryHandles ?? [])])).toEqual(writtenLists);
    const fillBefore = reopened.loops.map((l) => l.points.map((p) => ({ ...p })));
    const local = doc.snapshot.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
    doc.replaceEntities([{ ...local, points: sq(100, 100, 10) }]);
    expect(hatchOf(doc.snapshot).loops.map((l) => l.points)).toEqual(fillBefore);
    const hatchRec2 = records(writeDxf(doc.snapshot)).find((r) => r.kind === 'HATCH')!;
    expect(group(hatchRec2, 71)).toBe('0');
    expect(boundaryRefListsOf(hatchRec2)).toEqual(writtenLists);
  };

  it('mixed-in-one-loop saved 71 = 0 reopens inert: moving the local boundary leaves the fill unchanged, second save still 71 = 0', () => {
    expectInertAfterReopen({
      id: 'h1', ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1, associative: true,
      loops: [{ points: sq(0, 0, 10), boundaryRefs: ['m1', 'bp1'] }],
    });
  });

  it('mixed-across-loops saved 71 = 0 reopens inert: moving the local boundary leaves the fill unchanged, second save still 71 = 0', () => {
    expectInertAfterReopen({
      id: 'h1', ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1, associative: true,
      loops: [
        { points: sq(0, 0, 10), boundaryRefs: ['m1'] },
        { points: sq(30, 0, 10), boundaryRefs: ['bp1'] },
      ],
    });
  });

  it('HATCHEDIT Disassociate via the real tool clears refs and handles on all loops, never refreshes, saves 71 = 0 / 97 = 0, reopens inert, and undo restores the link', () => {
    const doc = new Drawing(readDxf(assocDxf()));
    const poly0 = doc.snapshot.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
    const hatch0 = hatchOf(doc.snapshot);
    expect(hatch0.associative).toBe(true);
    expect(hatch0.loops[0]!.boundaryRefs).toEqual([poly0.id]);
    const ctx = fakeContext(doc);
    ctx.selection.add(hatch0.id);
    drive(hatchEditTool(), ctx, ['Disassociate']);
    const h1 = hatchOf(doc.snapshot);
    expect(h1.associative).toBe(false);
    for (const loop of h1.loops) {
      expect(loop.boundaryRefs).toBeUndefined();
      expect(loop.boundaryHandles).toBeUndefined();
    }
    const fillBefore = h1.loops.map((l) => l.points.map((p) => ({ ...p })));
    doc.replaceEntities([{ ...poly0, points: sq(100, 100, 10) }]);
    expect(hatchOf(doc.snapshot).loops.map((l) => l.points)).toEqual(fillBefore);
    const saved = writeDxf(doc.snapshot);
    const rec = records(saved).find((r) => r.kind === 'HATCH')!;
    expect(group(rec, 71)).toBe('0');
    expect(group(rec, 97)).toBe('0');
    const reopened = readDxf(saved).entities.find((e): e is HatchEntity => e.type === 'hatch')!;
    expect(reopened.associative).toBeFalsy();
    expect(reopened.loops[0]!.boundaryRefs).toBeUndefined();
    // Undo the boundary move, then undo the disassociate: the link returns.
    expect(doc.undo()).toBe(true);
    expect(doc.undo()).toBe(true);
    const h3 = hatchOf(doc.snapshot);
    expect(h3.associative).toBe(true);
    expect(h3.loops[0]!.boundaryRefs).toEqual([poly0.id]);
  });
});

describe('P17 round 5 (lead ruling): a HATCH is never an active boundary — DEMOTE', () => {
  // Codex PR #48 P2: nothing stopped a hatch's boundaryRefs /
  // boundaryHandles from naming a HATCH entity — itself or another
  // hatch — and the writer emitted such a link at 71 = 1 with reactors
  // while the reader promoted a read DXF's hatch-naming 97/330 entries
  // to live refs. The ruling is DEMOTE, on both sides: on write, any
  // loop linking to a hatch demotes the WHOLE hatch (71 = 0, no
  // reactors, the hatch handle is NOT emitted in 97/330 at all, the
  // other links stay as inert raw handles under 71 = 0, geometry
  // untouched); on read, a DXF naming itself or another HATCH in
  // 97/330 imports that hatch inert (whole list raw, associative
  // pinned false), whatever its 71 says. At a2f44e4 cases (1)-(4) and
  // the write leg of (6) fail; (5) and the model leg of (6) are pins.
  const props = { layer: '0', color: 'ByLayer' as const };
  const sq = (x: number, y: number, s: number) => [
    { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
  ];
  const boundaryRefListsOf = (rec: { groups: Array<[number, string]> }): string[][] => {
    const out: string[][] = [];
    rec.groups.forEach(([c, v], i) => {
      if (c !== 97) return;
      const count = Number(v);
      out.push(rec.groups.slice(i + 1, i + 1 + count).filter(([cc]) => cc === 330).map(([, vv]) => vv));
    });
    return out;
  };
  const reactorsOf = (rec: { groups: Array<[number, string]> }): string[] => {
    const out: string[] = [];
    let inside = false;
    for (const [c, v] of rec.groups) {
      if (c === 102 && v === '{ACAD_REACTORS') inside = true;
      else if (c === 102 && v === '}' && inside) inside = false;
      else if (inside && c === 330) out.push(v);
    }
    return out;
  };
  const poly = (id: string, x = 0): PolylineEntity => ({
    id, ...props, type: 'polyline', points: sq(x, 0, 10), closed: true,
  });
  const hatchEnt = (id: string, refs: readonly string[], x = 0, associative: boolean | undefined = true): HatchEntity => ({
    id, ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1,
    ...(associative !== undefined ? { associative } : {}),
    loops: [{ points: sq(x, 0, 10), boundaryRefs: [...refs] }],
  });
  const stateOf = (entities: DrawingState['entities']): DrawingState => ({
    entities, layers: [], blocks: {}, currentLayer: '0',
  });
  const hatchOf = (state: DrawingState, id?: string): HatchEntity =>
    state.entities.find((e): e is HatchEntity => e.type === 'hatch' && (id === undefined || e.id === id))!;

  it('(1) SELF: a hatch bounded by itself demotes on save — 71 = 0, no reactors, its own handle absent from 97/330, other links retained inert, geometry intact; reopen inert', () => {
    const state = stateOf([poly('m1'), hatchEnt('h1', ['h1', 'm1'])]);
    const saved = writeDxf(state);
    const recs = records(saved);
    const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
    const polyRec = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(hatchRec, 71)).toBe('0');
    // The self handle is NOT emitted at all; the polyline link is
    // retained, inert under 71 = 0.
    expect(boundaryRefListsOf(hatchRec)).toEqual([[group(polyRec, 5)]]);
    expect(reactorsOf(polyRec)).toEqual([]);
    // Geometry intact: the loop still carries its 4 points.
    expect(group(hatchRec, 93)).toBe('4');
    // Reopen inert, and the demotion survives a second save.
    const doc = new Drawing(readDxf(saved));
    const reopened = hatchOf(doc.snapshot);
    expect(reopened.associative).toBe(false);
    expect(reopened.loops[0]!.boundaryRefs).toBeUndefined();
    expect(reopened.loops[0]!.boundaryHandles).toEqual([group(polyRec, 5)]);
    const hatchRec2 = records(writeDxf(doc.snapshot)).find((r) => r.kind === 'HATCH')!;
    expect(group(hatchRec2, 71)).toBe('0');
    expect(boundaryRefListsOf(hatchRec2)).toEqual([[group(polyRec, 5)]]);
    // Pure self-boundary: nothing at all is emitted in 97/330.
    const pure = records(writeDxf(stateOf([hatchEnt('h1', ['h1'])]))).find((r) => r.kind === 'HATCH')!;
    expect(group(pure, 71)).toBe('0');
    expect(group(pure, 97)).toBe('0');
    expect(boundaryRefListsOf(pure)).toEqual([[]]);
  });

  it('(2) OTHER HATCH: hatch A bounded by hatch B demotes; B and its own association are unaffected', () => {
    const state = stateOf([poly('m1'), hatchEnt('hb', ['m1'], 0), hatchEnt('ha', ['hb'], 20)]);
    const recs = records(writeDxf(state));
    const hatchRecs = recs.filter((r) => r.kind === 'HATCH');
    const polyRec = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    const recB = hatchRecs.find((r) => group(r, 71) === '1')!;
    const recA = hatchRecs.find((r) => group(r, 71) === '0')!;
    expect(recB).toBeDefined();
    expect(recA).toBeDefined();
    // B is unaffected: still associative to the polyline, which carries
    // B's back-reactor and nobody else's.
    expect(boundaryRefListsOf(recB)).toEqual([[group(polyRec, 5)]]);
    expect(reactorsOf(polyRec)).toEqual([group(recB, 5)]);
    // A demoted: B's handle is NOT in A's list (A has no other links).
    expect(boundaryRefListsOf(recA)).toEqual([[]]);
    expect(group(recA, 93)).toBe('4');
    // Reopen: A inert (its emitted list was empty — the hatch handle
    // was never written — so there is nothing to pin; the flag is the
    // plain non-associative posture and no refs exist), B still live,
    // and a second save still demotes A.
    const reopened = readDxf(writeDxf(state));
    const a2 = reopened.entities.filter((e): e is HatchEntity => e.type === 'hatch')
      .find((h) => h.associative !== true)!;
    expect(a2.associative).not.toBe(true);
    expect(a2.loops[0]!.boundaryRefs).toBeUndefined();
    expect(a2.loops[0]!.boundaryHandles).toBeUndefined();
    const recs2 = records(writeDxf(reopened)).filter((r) => r.kind === 'HATCH');
    expect(recs2.filter((r) => group(r, 71) === '0')).toHaveLength(1);
    expect(recs2.filter((r) => group(r, 71) === '1')).toHaveLength(1);
    const b2 = reopened.entities.filter((e): e is HatchEntity => e.type === 'hatch')
      .find((h) => h.associative === true)!;
    expect(b2.loops[0]!.boundaryRefs).toHaveLength(1);
  });

  it('(3) IMPORTED SELF: a DXF naming the hatch itself in 97/330 (71 = 1 in the file) imports inert and never re-emits the self link', () => {
    // assocDxf's hatch carries handle 51; refHandle '51' names itself.
    const state = readDxf(assocDxf({ refHandle: '51' }));
    const hatch = hatchOf(state);
    expect(hatch.associative).toBe(false);
    expect(hatch.loops[0]!.boundaryRefs).toBeUndefined();
    expect(hatch.loops[0]!.boundaryHandles).toEqual(['51']);
    const report = importReportOf(state);
    expect(report?.items.some((item) => /names a hatch as a boundary/.test(item.reason))).toBe(true);
    // Re-save: 71 = 0 and the self handle is not emitted, live or inert.
    const rec = records(writeDxf(state)).find((r) => r.kind === 'HATCH')!;
    expect(group(rec, 71)).toBe('0');
    expect(group(rec, 97)).toBe('0');
    expect(boundaryRefsOf(rec)).toEqual([]);
    // The re-saved file names no hatch at all (97 = 0), so its reopen
    // is a plain non-associative hatch: no flag pin, no refs, no
    // retained handles — inert by absence.
    const reopened = hatchOf(readDxf(writeDxf(state)));
    expect(reopened.associative).not.toBe(true);
    expect(reopened.loops[0]!.boundaryRefs).toBeUndefined();
    expect(reopened.loops[0]!.boundaryHandles).toBeUndefined();
  });

  it('(4) IMPORTED OTHER HATCH: a DXF where hatch A names hatch B imports A inert, B live; re-save keeps A inert', () => {
    const hatchRecord = (handle: string, ref: string, x: number): Pair[] => [
      [0, 'HATCH'], [5, handle], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbHatch'],
      [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1],
      [2, 'SOLID'], [70, 1], [71, 1], [91, 1],
      [92, 3], [72, 0], [73, 1], [93, 4],
      [10, x], [20, 0], [10, x + 10], [20, 0], [10, x + 10], [20, 10], [10, x], [20, 10],
      [97, 1], [330, ref],
      [75, 0], [76, 1], [98, 0],
    ];
    const fields: Pair[] = [
      [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [0, 'ENDSEC'],
      [0, 'SECTION'], [2, 'ENTITIES'],
      [0, 'LWPOLYLINE'], [5, '50'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbPolyline'],
      [90, 4], [70, 1],
      [10, 0], [20, 0], [10, 10], [20, 0], [10, 10], [20, 10], [10, 0], [20, 10],
      ...hatchRecord('51', '50', 0),
      ...hatchRecord('52', '51', 20),
      [0, 'ENDSEC'], [0, 'EOF'],
    ];
    const state = readDxf(fields.flat().join('\n'));
    const polyEnt = state.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
    const hatches = state.entities.filter((e): e is HatchEntity => e.type === 'hatch');
    expect(hatches).toHaveLength(2);
    const a = hatches.find((h) => h.associative !== true)!;
    const b = hatches.find((h) => h.associative === true)!;
    // A (handle 52, naming B) is inert: flag pinned false, list raw.
    expect(a.associative).toBe(false);
    expect(a.loops[0]!.boundaryRefs).toBeUndefined();
    expect(a.loops[0]!.boundaryHandles).toEqual(['51']);
    // B (handle 51, naming the polyline) is unaffected and live.
    expect(b.loops[0]!.boundaryRefs).toEqual([polyEnt.id]);
    // Re-save: A stays 71 = 0 and B's written handle is absent from A's
    // list; B stays 71 = 1 naming the polyline.
    const recs = records(writeDxf(state));
    const hatchRecs = recs.filter((r) => r.kind === 'HATCH');
    const recA = hatchRecs.find((r) => group(r, 71) === '0')!;
    const recB = hatchRecs.find((r) => group(r, 71) === '1')!;
    const polyRec = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(recA).toBeDefined();
    expect(boundaryRefListsOf(recA)).toEqual([[]]);
    expect(boundaryRefListsOf(recB)).toEqual([[group(polyRec, 5)]]);
  });

  it('(5) CONTROL: a polyline-bounded hatch stays 71 = 1 with live refs and reactors, and refreshes on boundary edits', () => {
    const state = readDxf(assocDxf());
    const recs = records(writeDxf(state));
    const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
    const polyRec = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(hatchRec, 71)).toBe('1');
    expect(boundaryRefsOf(hatchRec)).toEqual([group(polyRec, 5)]);
    expect(reactorsOf(polyRec)).toEqual([group(hatchRec, 5)]);
    const doc = new Drawing(state);
    const hatch = hatchOf(doc.snapshot);
    expect(hatch.associative).toBe(true);
    const polyEnt = doc.snapshot.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
    expect(hatch.loops[0]!.boundaryRefs).toEqual([polyEnt.id]);
    doc.replaceEntities([{ ...polyEnt, points: sq(100, 100, 10) }]);
    expect(hatchOf(doc.snapshot).loops[0]!.points).toEqual(sq(100, 100, 10));
  });

  it('(6) EXPLICIT NON-ASSOCIATIVE SELF: a hatch modelled associative = false naming itself emits no self link and stays inert end-to-end', () => {
    const state = stateOf([hatchEnt('h1', ['h1'], 0, false)]);
    const rec = records(writeDxf(state)).find((r) => r.kind === 'HATCH')!;
    expect(group(rec, 71)).toBe('0');
    // The self handle is not emitted even as an inert retained entry.
    expect(group(rec, 97)).toBe('0');
    expect(boundaryRefsOf(rec)).toEqual([]);
    const reopened = hatchOf(readDxf(writeDxf(state)));
    expect(reopened.associative).toBeFalsy();
    expect(reopened.loops[0]!.boundaryRefs).toBeUndefined();
  });
});

describe('P17 round 6 (lead ruling, final): cross-space demotion, stale-reactor cleanup, canonical handles', () => {
  // Codex closed round 5's same-list cases at 7227319 but found the
  // cross-space / cleanup gaps. (1) Round 5's read check resolves
  // 97/330 only against hatches in the SAME entity list: a model-space
  // hatch naming a HATCH that lives in a block definition — or a
  // retained raw HATCH record — still imports LIVE through its local
  // links. The fix is a drawing-wide canonical lookup of hatch handles
  // (every HATCH record in the file), consulted alongside the same-list
  // check. (2) When a hatch demotes, reactor pointers OTHER records
  // carry to it (preserved from the input by the graph merge) are never
  // removed: the shared boundary keeps naming the demoted hatch. The
  // final-text reactor pass must drop pointers to 71 = 0 hatches while
  // keeping active and unrelated reactors, order intact. (3) The new
  // lookup keys handles canonically: 00050 matches 50. At 7227319 cases
  // (a)-(d) fail; the controls (e) hold.
  const props = { layer: '0', color: 'ByLayer' as const };
  const sq = (x: number, y: number, s: number) => [
    { x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s },
  ];
  const boundaryRefListsOf = (rec: { groups: Array<[number, string]> }): string[][] => {
    const out: string[][] = [];
    rec.groups.forEach(([c, v], i) => {
      if (c !== 97) return;
      const count = Number(v);
      out.push(rec.groups.slice(i + 1, i + 1 + count).filter(([cc]) => cc === 330).map(([, vv]) => vv));
    });
    return out;
  };
  const reactorsOf = (rec: { groups: Array<[number, string]> }): string[] => {
    const out: string[] = [];
    let inside = false;
    for (const [c, v] of rec.groups) {
      if (c === 102 && v === '{ACAD_REACTORS') inside = true;
      else if (c === 102 && v === '}' && inside) inside = false;
      else if (inside && c === 330) out.push(v);
    }
    return out;
  };
  const squarePairs = (x: number, y = 0, s = 10): Pair[] => [
    [10, x], [20, y], [10, x + s], [20, y], [10, x + s], [20, y + s], [10, x], [20, y + s],
  ];
  const polyRecord = (handle: string, x = 0, reactors: string[] = []): Pair[] => [
    [0, 'LWPOLYLINE'], [5, handle],
    ...(reactors.length ? [[102, '{ACAD_REACTORS'], ...reactors.map((r): Pair => [330, r]), [102, '}']] as Pair[] : []),
    [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbPolyline'],
    [90, 4], [70, 1], ...squarePairs(x),
  ];
  const hatchRecord = (handle: string, refs: string[], x = 0, associative = true): Pair[] => [
    [0, 'HATCH'], [5, handle], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbHatch'],
    [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1],
    [2, 'SOLID'], [70, 1], [71, associative ? 1 : 0], [91, 1],
    [92, 3], [72, 0], [73, 1], [93, 4], ...squarePairs(x),
    [97, refs.length], ...refs.map((r): Pair => [330, r]),
    [75, 0], [76, 1], [98, 0],
  ];
  const dxfFile = (entities: Pair[], blocks: Pair[] = []): string => [
    [0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1015'], [0, 'ENDSEC'],
    ...(blocks.length ? [[0, 'SECTION'], [2, 'BLOCKS'], ...blocks, [0, 'ENDSEC']] as Pair[] : []),
    [0, 'SECTION'], [2, 'ENTITIES'], ...entities,
    [0, 'ENDSEC'], [0, 'EOF'],
  ].flat().join('\n');
  const blockDef = (name: string, inner: Pair[]): Pair[] => [
    [0, 'BLOCK'], [5, '40'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockBegin'],
    [2, name], [70, 0], [10, 0], [20, 0], [3, name], [1, ''],
    ...inner,
    [0, 'ENDBLK'], [5, '41'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockEnd'],
  ];
  const modelHatchOf = (state: DrawingState): HatchEntity =>
    state.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
  const namesHatchReport = (state: DrawingState): boolean =>
    importReportOf(state)?.items.some((item) => /names a hatch as a boundary/.test(item.reason)) ?? false;

  it('(a) CROSS-SPACE: a model hatch naming a HATCH inside a block definition imports inert; moving the local boundary leaves the fill unchanged; re-save stays inert', () => {
    const text = dxfFile(
      [...polyRecord('50'), ...hatchRecord('51', ['50', '60'])],
      blockDef('BLK', hatchRecord('60', [], 100, false)),
    );
    const state = readDxf(text);
    // The target hatch IS modelled — in its own list (the block def).
    const blockHatch = state.blocks['BLK']!.entities.find((e) => e.type === 'hatch');
    expect(blockHatch).toBeDefined();
    const a = modelHatchOf(state);
    expect(a.associative).toBe(false);
    expect(a.loops[0]!.boundaryRefs).toBeUndefined();
    expect(a.loops[0]!.boundaryHandles).toEqual(['50', '60']);
    expect(namesHatchReport(state)).toBe(true);
    // Moving the local boundary must not change the fill.
    const doc = new Drawing(state);
    const fillBefore = modelHatchOf(doc.snapshot).loops.map((l) => l.points.map((p) => ({ ...p })));
    const polyEnt = doc.snapshot.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
    doc.replaceEntities([{ ...polyEnt, points: sq(100, 100, 10) }]);
    expect(modelHatchOf(doc.snapshot).loops.map((l) => l.points)).toEqual(fillBefore);
    // Re-save stays inert, and the block hatch's written handle never
    // enters A's list (the local link stays, inert).
    const recs = records(writeDxf(state));
    const hatchRecs = recs.filter((r) => r.kind === 'HATCH');
    const recA = hatchRecs.find((r) => group(r, 71) === '0' && boundaryRefListsOf(r).flat().length > 0)!;
    const recBlock = hatchRecs.find((r) => r !== recA && !boundaryRefListsOf(r).flat().length)!;
    const polyRec = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(recA).toBeDefined();
    expect(recBlock).toBeDefined();
    expect(boundaryRefListsOf(recA)).toEqual([[group(polyRec, 5)]]);
    expect(boundaryRefListsOf(recA).flat()).not.toContain(group(recBlock, 5));
    const reopened = modelHatchOf(readDxf(writeDxf(state)));
    expect(reopened.associative).toBe(false);
    expect(reopened.loops[0]!.boundaryRefs).toBeUndefined();
  });

  it('(b) UNMODELLED RECORD: a model hatch naming a HATCH no entity list models (inside a *D dimension-picture block) imports inert and re-saves inert', () => {
    // A HATCH inside a *D block is converted NOWHERE: not into model
    // space, not into a stored block definition, not into a layout.
    // (In this build its picture record does not enter the CAD graph
    // either — *D pictures are regenerated from their dimensions — so
    // nothing of it is written back; that is precisely why the read
    // lookup is built from the source records: retention status must
    // not change the verdict. The graph-retained variant of the shape
    // is the writer-side hatchAnchorHandles case, round 5.) A hatch
    // naming it still names a HATCH in the file.
    const dimBlock: Pair[] = [
      [0, 'BLOCK'], [5, '40'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockBegin'],
      [2, '*D1'], [70, 0], [10, 0], [20, 0], [3, '*D1'], [1, ''],
      ...hatchRecord('62', [], 100, false),
      [0, 'ENDBLK'], [5, '41'], [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbBlockEnd'],
    ];
    const text = dxfFile([...polyRecord('50'), ...hatchRecord('51', ['50', '62'])], dimBlock);
    const state = readDxf(text);
    // The named hatch is modelled NOWHERE.
    const allHatches = [...state.entities, ...Object.values(state.blocks).flatMap((b) => b.entities)]
      .filter((e) => e.type === 'hatch');
    expect(allHatches).toHaveLength(1);
    const a = modelHatchOf(state);
    expect(a.associative).toBe(false);
    expect(a.loops[0]!.boundaryRefs).toBeUndefined();
    // The raw link itself is retained on the loop (not lost, not live).
    expect(a.loops[0]!.boundaryHandles).toEqual(['50', '62']);
    expect(namesHatchReport(state)).toBe(true);
    // Re-save: A stays 71 = 0 with only the local link emitted inert;
    // the named handle enters no list (it names no emitted object).
    const saved = writeDxf(state);
    const recs = records(saved);
    const hatchRecs = recs.filter((r) => r.kind === 'HATCH');
    expect(hatchRecs).toHaveLength(1);
    const recA = hatchRecs[0]!;
    const polyRec = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(group(recA, 71)).toBe('0');
    expect(boundaryRefListsOf(recA)).toEqual([[group(polyRec, 5)]]);
    const reopened = modelHatchOf(readDxf(saved));
    expect(reopened.associative).toBe(false);
    expect(reopened.loops[0]!.boundaryRefs).toBeUndefined();
  });

  it('(c) STALE REACTORS: the shared boundary [113, 114] -> [114] once 113 demotes; unrelated reactors naming the active hatch survive; an emptied reactor block is removed whole', () => {
    // Polyline 50 is shared by hatches 113 and 114 and its input
    // reactors name both. 113 also names hatch 115, so 113 demotes on
    // save; 114 stays active. Polyline 52 is nobody's boundary but
    // carries the same input reactor pair (the unrelated-keep pin).
    // LINE 64 reacts ONLY to 113: its block must disappear entirely.
    // Polyline 53 belongs to 115 alone and gains its reactor from the
    // completion pass — cleanup and completion compose in one save.
    const lineRecord: Pair[] = [
      [0, 'LINE'], [5, '64'],
      [102, '{ACAD_REACTORS'], [330, '113'], [102, '}'],
      [330, '1F'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbLine'],
      [10, 0], [20, 20], [11, 5], [21, 20],
    ];
    const text = dxfFile([
      ...polyRecord('50', 0, ['113', '114']),
      ...polyRecord('52', 30, ['113', '114']),
      ...lineRecord,
      ...hatchRecord('113', ['50', '115']),
      ...hatchRecord('114', ['50']),
      ...polyRecord('53', 60),
      ...hatchRecord('115', ['53'], 60),
    ]);
    const saved = writeDxf(readDxf(text));
    const recs = records(saved);
    const hatchRecs = recs.filter((r) => r.kind === 'HATCH');
    const demoted = hatchRecs.find((r) => group(r, 71) === '0')!;
    const active = hatchRecs.filter((r) => group(r, 71) === '1');
    expect(demoted).toBeDefined();
    expect(active).toHaveLength(2);
    // Identify written handles by role, not by source spelling.
    const poly50 = recs.find((r) => r.kind === 'LWPOLYLINE' && boundaryRefListsOf(demoted).flat().includes(group(r, 5)!))!;
    const h114 = active.find((r) => boundaryRefListsOf(r).flat().includes(group(poly50, 5)!))!;
    const h115 = active.find((r) => r !== h114)!;
    const poly53 = recs.find((r) => r.kind === 'LWPOLYLINE' && boundaryRefListsOf(h115).flat().includes(group(r, 5)!))!;
    const poly52 = recs.filter((r) => r.kind === 'LWPOLYLINE').find((r) => r !== poly50 && r !== poly53)!;
    const line = recs.find((r) => r.kind === 'LINE')!;
    // The Codex pin: [113, 114] -> exactly [114], on both carriers.
    expect(reactorsOf(poly50)).toEqual([group(h114, 5)]);
    expect(reactorsOf(poly52)).toEqual([group(h114, 5)]);
    // The demoted hatch's own list: the hatch handle is gone, the
    // local link stays inert.
    expect(boundaryRefListsOf(demoted)).toEqual([[group(poly50, 5)]]);
    // Completion still lands for the other active hatch.
    expect(reactorsOf(poly53)).toEqual([group(h115, 5)]);
    // LINE 64's block named only the demoted hatch: removed whole.
    expect(reactorsOf(line)).toEqual([]);
    expect(line.groups.some(([c, v]) => c === 102 && v === '{ACAD_REACTORS')).toBe(false);
    // A second generation keeps the cleaned state exactly: no record
    // names the demoted hatch, the three single-reactor carriers
    // remain, and LINE's block stays gone.
    const recs2 = records(writeDxf(readDxf(saved)));
    const demoted2 = recs2.find((r) => r.kind === 'HATCH' && group(r, 71) === '0')!;
    expect(demoted2).toBeDefined();
    for (const r of recs2) expect(reactorsOf(r)).not.toContain(group(demoted2, 5));
    expect(recs2.filter((r) => r.kind === 'LWPOLYLINE' && reactorsOf(r).length === 1)).toHaveLength(3);
    expect(recs2.find((r) => r.kind === 'LINE')!.groups.some(([c, v]) => c === 102 && v === '{ACAD_REACTORS')).toBe(false);
  });

  it('(d) CANONICALIZATION: naming another hatch by a zero-padded spelling (00050 vs 50) demotes exactly like the canonical spelling', () => {
    const text = dxfFile([
      ...polyRecord('4F'),
      ...hatchRecord('50', ['4F'], 30),
      ...hatchRecord('51', ['4F', '00050']),
    ]);
    const state = readDxf(text);
    const hatches = state.entities.filter((e): e is HatchEntity => e.type === 'hatch');
    expect(hatches).toHaveLength(2);
    // B is the hatch that stays live with no raw handles; A is the other.
    const b = hatches.find((h) => h.associative === true && h.loops[0]!.boundaryHandles === undefined)!;
    const a = hatches.find((h) => h !== b)!;
    expect(b).toBeDefined();
    // A named B ('50') as '00050': demoted, whole list raw, reported.
    expect(a.associative).toBe(false);
    expect(a.loops[0]!.boundaryRefs).toBeUndefined();
    expect(a.loops[0]!.boundaryHandles).toEqual(['4F', '00050']);
    expect(namesHatchReport(state)).toBe(true);
    // Write side: the retained padded handle canonicalizes to B, a
    // hatch, so it is governed — never emitted; A stays 71 = 0, B
    // stays live with its back-reactor.
    const recs = records(writeDxf(state));
    const hatchRecs = recs.filter((r) => r.kind === 'HATCH');
    const recA = hatchRecs.find((r) => group(r, 71) === '0')!;
    const recB = hatchRecs.find((r) => group(r, 71) === '1')!;
    const polyRec = recs.find((r) => r.kind === 'LWPOLYLINE')!;
    expect(recA).toBeDefined();
    expect(recB).toBeDefined();
    expect(boundaryRefListsOf(recA)).toEqual([[group(polyRec, 5)]]);
    expect(boundaryRefListsOf(recA).flat()).not.toContain(group(recB, 5));
    expect(reactorsOf(polyRec)).toEqual([group(recB, 5)]);
  });

  it('(e1) CONTROL: a model hatch naming a cross-space POLYLINE (not a hatch) is NOT demoted by the new lookup — the local link stays live, the foreign handle stays raw', () => {
    const text = dxfFile(
      [...polyRecord('50'), ...hatchRecord('51', ['50', '63'])],
      blockDef('BLK', polyRecord('63', 100)),
    );
    const state = readDxf(text);
    const a = modelHatchOf(state);
    expect(a.associative).toBe(true);
    const polyEnt = state.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
    expect(a.loops[0]!.boundaryRefs).toEqual([polyEnt.id]);
    expect(a.loops[0]!.boundaryHandles).toEqual(['63']);
    expect(namesHatchReport(state)).toBe(false);
  });

  it('(e2) CONTROL: an ordinary cross-owner link keeps the round-2 O5 write posture — 71 = 0 with BOTH links emitted inert (unlike a hatch link, which is dropped)', () => {
    const polyEnt = (id: string, x = 0): PolylineEntity => ({
      id, ...props, type: 'polyline', points: sq(x, 0, 10), closed: true,
    });
    const hatch: HatchEntity = {
      id: 'h1', ...props, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1, associative: true,
      loops: [{ points: sq(0, 0, 10), boundaryRefs: ['m1', 'bp1'] }],
    };
    const state: DrawingState = {
      entities: [polyEnt('m1'), hatch], layers: [], currentLayer: '0',
      blocks: { BLK: { name: 'BLK', basePoint: { x: 0, y: 0 }, entities: [polyEnt('bp1', 30)], attributes: [] } },
    };
    const recs = records(writeDxf(state));
    const hatchRec = recs.find((r) => r.kind === 'HATCH')!;
    expect(group(hatchRec, 71)).toBe('0');
    expect(boundaryRefListsOf(hatchRec).flat()).toHaveLength(2);
    expect(reactorsOf(recs.find((r) => r.kind === 'LWPOLYLINE')!)).toEqual([]);
  });
});
