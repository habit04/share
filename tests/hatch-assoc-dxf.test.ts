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
