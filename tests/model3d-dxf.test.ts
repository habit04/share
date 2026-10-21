/** DXF persistence of experimental 3D solids: polyface meshes with JCAD_3D XDATA (milestone 5). */
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { defaultReadLimitExcess, DxfReadError, readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf, type ImportReportItem } from '../src/io/import-report';
import { convertDwg } from '../src/io/dwg';
import { addSolids, model3dOf, newSolid, withModel3D } from '../src/model3d/model';
import { boxMesh, cylinderMesh, primitiveMesh, sphereMesh, torusMesh } from '../src/model3d/primitives';
import { frameFromPlane, v3, WORLD_XY_FRAME, type Frame3 } from '../src/model3d/math';
import { meshIsClosed, meshTriangleCount, meshVolume, transformMesh } from '../src/model3d/mesh';
import { mat4Translation } from '../src/model3d/math';
import type { Feature3D, Solid3D } from '../src/model3d/types';
import { MAX_PAYLOAD_BYTES, MODEL3D_FILE_VERSION } from '../src/model3d/file-format';
import { exactReal, MAX_POLYFACE_VERTICES } from '../src/io/dxf/mesh3d-write';
import { FOREIGN_POLYFACE_REASON, POLYFACE_UNSUPPORTED_REASON } from '../src/io/dxf/mesh3d-read';
import { MAX_SOLID_TRIANGLES } from '../src/model3d/budget';

const tilted: Frame3 = frameFromPlane({ origin: v3(10.1, -3.3, 0.7), normal: v3(0.3, -0.2, 0.9) });

function stateWith(solids: readonly Solid3D[], extraLayers: DrawingState['layers'] = []): DrawingState {
  const base = new Drawing().snapshot;
  return withModel3D({ ...base, layers: [...base.layers, ...extraLayers] }, addSolids(model3dOf(base), solids));
}

function roundTrip(state: DrawingState, model3d = true): DrawingState {
  return readDxf(writeDxf(state), { model3d });
}

function items(state: DrawingState): readonly ImportReportItem[] {
  return importReportOf(state)?.items ?? [];
}

const box = (): Solid3D => {
  const feature: Feature3D = { kind: 'box', frame: tilted, width: 2.5, depth: 1.25, height: 0.3 };
  return newSolid({ feature, mesh: primitiveMesh(feature), layer: 'PARTS', color: 3, name: 'Enclosure base' });
};
const cylinder = (): Solid3D => {
  const feature: Feature3D = { kind: 'cylinder', frame: tilted, radius: 0.7, height: 4.1, segments: 48 };
  return newSolid({ feature, mesh: primitiveMesh(feature) });
};
const profile = { frame: WORLD_XY_FRAME, loops: [[{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 1.5 }, { x: 0, y: 1.5 }], [{ x: 1, y: 0.5 }, { x: 2, y: 0.5 }, { x: 1.5, y: 1 }]] };
const extrude = (): Solid3D => newSolid({ feature: { kind: 'extrude', profile, distance: -2.75 }, mesh: boxMesh(3, 1.5, 2.75), color: 'ByLayer', layer: 'PARTS' });
const revolve = (): Solid3D => newSolid({ feature: { kind: 'revolve', profile, axis: { origin: v3(0, 0, 0), dir: v3(0, 1, 0) }, angle: Math.PI * 1.5 }, mesh: sphereMesh(1.3, 20, 9), color: 0 });
const booleanTree = (): Solid3D => {
  const a: Feature3D = { kind: 'box', frame: WORLD_XY_FRAME, width: 4, depth: 4, height: 1 };
  const b: Feature3D = { kind: 'cylinder', frame: tilted, radius: 0.5, height: 2 };
  const c: Feature3D = { kind: 'torus', frame: WORLD_XY_FRAME, majorRadius: 2, minorRadius: 0.25, segments: 12, rings: 6 };
  const feature: Feature3D = { kind: 'boolean', op: 'subtract', operands: [{ kind: 'boolean', op: 'union', operands: [a, c] }, b] };
  return newSolid({ feature, mesh: transformMesh(cylinderMesh(1.1, 0.4, 7), mat4Translation(1 / 3, 2 / 7, -5 / 9)), name: 'Gland plate ünïcödé "quoted" \\U+0041 \\\\ end  ' });
};
const meshSolid = (): Solid3D => newSolid({ feature: { kind: 'mesh', source: 'edited' }, mesh: boxMesh(0.1, 0.2, 0.30000000000000004), color: 255 });

/** JSON (and DXF numbers) have no negative zero: -0 is written as 0, everything else is exact. */
const noNegativeZero = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function expectSameSolid(read: Solid3D, written: Solid3D): void {
  expect(read.id).toBe(written.id);
  expect(read.layer).toBe(written.layer);
  expect(read.color).toEqual(written.color);
  expect(read.name).toBe(written.name);
  expect('name' in read).toBe('name' in written);
  expect(read.feature).toEqual(noNegativeZero(written.feature));
  expect(read.mesh.positions).toEqual(written.mesh.positions.map((n) => n + 0));
  expect(read.mesh.indices).toEqual(written.mesh.indices);
}

describe('3D solids round trip through DXF', () => {
  it('keeps ids, layers, colours, names, feature trees and exact meshes', () => {
    const solids = [box(), cylinder(), extrude(), revolve(), booleanTree(), meshSolid()];
    const state = stateWith(solids, [{ name: 'PARTS', color: 5, visible: true, locked: false, lineWeight: 0.25 }]);
    const back = roundTrip(state);
    expect(back.model3d?.solids).toHaveLength(solids.length);
    back.model3d!.solids.forEach((s, i) => expectSameSolid(s, solids[i]!));
    expect(importReportOf(back)).toBeUndefined();
    // Writing what was read gives the same file again.
    expect(writeDxf(back)).toBe(writeDxf(state));
    // The read state is accepted by the document (sealed, within budget).
    const doc = new Drawing();
    doc.load(back);
    expect(doc.snapshot.model3d?.solids).toHaveLength(solids.length);
  });

  it('writes the DXF reference polyface layout (not verified in AutoCAD): POLYLINE 64, VERTEX 192 / 128, SEQEND, JCAD_3D', () => {
    const s = newSolid({ feature: { kind: 'box', frame: WORLD_XY_FRAME, width: 1, depth: 1, height: 1 }, mesh: boxMesh(1, 1, 1), layer: 'PARTS', color: 1 });
    const text = writeDxf(stateWith([s]));
    const lines = text.split('\r\n');
    const at = lines.indexOf('POLYLINE');
    expect(lines.slice(at - 1, at + 21)).toEqual(['0', 'POLYLINE', '5', expect.any(String), '330', '1F', '100', 'AcDbEntity', '8', 'PARTS', '62', '1', '100', 'AcDbPolyFaceMesh', '66', '1', '10', '0', '20', '0', '30', '0']);
    expect(lines.slice(at + 21, at + 29)).toEqual(['70', '64', '71', '8', '72', '12', '1001', 'JCAD_3D']);
    const handle = lines[at + 2]!;
    expect(text.split('AcDbPolyFaceMeshVertex').length - 1).toBe(8);
    expect(text.split('AcDbFaceRecord').length - 1).toBe(12);
    expect(text).toContain(`330\r\n${handle}\r\n100\r\nAcDbEntity\r\n8\r\nPARTS\r\n62\r\n1\r\n100\r\nAcDbFaceRecord\r\n10\r\n0\r\n20\r\n0\r\n30\r\n0\r\n70\r\n128\r\n71\r\n`);
    expect(text).toMatch(/0\r\nSEQEND\r\n5\r\n[0-9A-F]+\r\n330\r\n/);
    expect(text).toContain('100\r\nAcDbRegAppTableRecord\r\n2\r\nJCAD_3D\r\n');
    // The payload is 7-bit, whitespace-free and within the 255-byte group limit.
    const app = lines.indexOf('JCAD_3D', at);
    const chunks: string[] = [];
    for (let i = app + 1; lines[i] === '1000'; i += 2) chunks.push(lines[i + 1]!);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.length <= 250 && /^[\x21-\x7e]+$/.test(c))).toBe(true);
    expect(JSON.parse(chunks.join(''))).toEqual({ v: MODEL3D_FILE_VERSION, id: s.id, feature: s.feature });
  });

  it('formats coordinates exactly, without exponents', () => {
    for (const n of [0, -0, 1, -2.5, 0.1 + 0.2, 6.123233995736766e-17, -1.5e-7, 1e21, 123456789.123, Number.MIN_VALUE, -Number.MAX_VALUE]) {
      const s = exactReal(n);
      expect(s).not.toMatch(/e/i);
      expect(Number(s)).toBe(n === 0 ? 0 : n);
    }
    expect(exactReal(-0)).toBe('0');
    expect(() => exactReal(NaN)).toThrow(RangeError);
  });

  it('keeps layer colour inheritance: ByLayer solids on their layer, missing layers created', () => {
    const s = newSolid({ feature: { kind: 'mesh', source: 'edited' }, mesh: boxMesh(1, 1, 1), layer: 'GHOST' });
    const back = roundTrip(stateWith([s]));
    expect(back.model3d!.solids[0]!.color).toBe('ByLayer');
    expect(back.layers.find((l) => l.name === 'GHOST')).toMatchObject({ color: 7, visible: true });
    const colored = roundTrip(stateWith([{ ...s, layer: 'RED' }], [{ name: 'RED', color: 1, visible: true, locked: false, lineWeight: 0.25 }]));
    expect(colored.layers.find((l) => l.name === 'RED')?.color).toBe(1);
    expect(colored.model3d!.solids[0]).toMatchObject({ layer: 'RED', color: 'ByLayer' });
  });

  it('loads into a Drawing whose undo restores a deleted solid', () => {
    const doc = new Drawing();
    doc.load(roundTrip(stateWith([box(), meshSolid()])));
    const [first] = doc.snapshot.model3d!.solids;
    doc.transact((s) => withModel3D(s, { ...model3dOf(s), solids: model3dOf(s).solids.filter((x) => x.id !== first!.id) }));
    expect(doc.snapshot.model3d!.solids).toHaveLength(1);
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot.model3d!.solids.map((s) => s.id)).toEqual([first!.id, expect.any(String)]);
    expect(doc.canUndo()).toBe(false);
  });

  it('reads JCad solids with 3D disabled too, and says they are hidden', () => {
    const solids = [box(), booleanTree()];
    const back = roundTrip(stateWith(solids), false);
    back.model3d!.solids.forEach((s, i) => expectSameSolid(s, solids[i]!));
    const report = importReportOf(back)!;
    expect(report.items).toEqual([]);
    expect(report.notes.join(' ')).toMatch(/contains 2 experimental 3D objects\. They are kept and saved/);
  });

  // T-FLAKE: measured p99 8.9 s under maxWorkers=2 family load (n=10 runs; solo p50 4.9 s); budget = p99 x 2 rounded up. Timed out at the 5 s default in full-suite runs.
  it('splits a mesh beyond the 16-bit polyface limits into several records and joins them on read', () => {
    // The densest torus has 32,768 vertices and 65,536 triangles: one more vertex than a record holds.
    const two = torusMesh(5, 1, 256, 128);
    expect(two.positions.length / 3).toBeGreaterThan(MAX_POLYFACE_VERTICES);
    const s = newSolid({ feature: { kind: 'mesh', source: 'edited' }, mesh: two, name: 'dense' });
    const text = writeDxf(stateWith([s]));
    expect(text.split('\r\nPOLYLINE\r\n').length - 1).toBeGreaterThan(1);
    const back = readDxf(text, { model3d: true });
    expect(importReportOf(back)).toBeUndefined();
    const r = back.model3d!.solids;
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: s.id, name: 'dense', feature: s.feature });
    expect(meshTriangleCount(r[0]!.mesh)).toBe(meshTriangleCount(two));
    expect(r[0]!.mesh.positions.length).toBe(two.positions.length);
    expect(meshVolume(r[0]!.mesh)).toBeCloseTo(meshVolume(two), 9);
    expect(meshIsClosed(r[0]!.mesh)).toBe(true);
  }, 18000);

  // T-FLAKE: measured p99 7.8 s under maxWorkers=2 family load (n=10 runs; solo p50 4.0 s); budget = p99 x 2 rounded up. Timed out at the 5 s default in full-suite runs.
  it('keeps and reports a split solid whose records are incomplete', () => {
    const s = newSolid({ feature: { kind: 'mesh', source: 'edited' }, mesh: torusMesh(5, 1, 256, 128) });
    const text = writeDxf(stateWith([s]));
    const starts = [...text.matchAll(/\r\n0\r\nPOLYLINE\r\n/g)].map((m) => m.index!);
    expect(starts.length).toBe(3);
    // Remove the first record: the other two are orphans; remove the second: the first is incomplete.
    const cut = (from: number, to: number) => text.slice(0, starts[from]) + text.slice(starts[to]!);
    const noFirst = readDxf(cut(0, 1), { model3d: true });
    expect(noFirst.model3d!.solids).toHaveLength(2);
    expect(items(noFirst).map((i) => i.reason)).toEqual([expect.stringMatching(/^part 2 of 3 of a 3D object without its first record/), expect.stringMatching(/^part 3 of 3/)]);
    const noSecond = readDxf(cut(1, 2), { model3d: true });
    expect(noSecond.model3d!.solids).toHaveLength(1);
    expect(noSecond.model3d!.solids[0]!.id).toBe(s.id);
    expect(items(noSecond).map((i) => i.reason)).toEqual(['1 record of the 3 that make up this 3D object is missing: the mesh is incomplete']);
  }, 16000);

  it('degrades a construction history too large for the file to a mesh feature', () => {
    const loop = Array.from({ length: 900 }, (_, i) => ({ x: Math.cos(i / 143.2394) * 3.000000001, y: Math.sin(i / 143.2394) * 3.000000001 }));
    const s = newSolid({ feature: { kind: 'extrude', profile: { frame: tilted, loops: [loop] }, distance: 1 }, mesh: boxMesh(1, 1, 1), name: 'big history' });
    expect(JSON.stringify(s.feature).length).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    const back = roundTrip(stateWith([s]));
    expect(back.model3d!.solids[0]).toMatchObject({ id: s.id, name: 'big history', feature: { kind: 'mesh', source: 'edited' }, mesh: s.mesh });
  });

  it('fails an oversized file the way an oversized 2D file fails: the budget rejects the state', () => {
    // A minimal hand-written polyface with one more face than a solid may have (short records keep the text small).
    const faces = MAX_SOLID_TRIANGLES + 1;
    const rec = (...groups: Array<string | number>) => groups.join('\r\n') + '\r\n';
    const parts = [rec(0, 'SECTION', 2, 'ENTITIES', 0, 'POLYLINE', 8, 0, 70, 64)];
    for (const [x, y] of [[0, 0], [1, 0], [0, 1]]) parts.push(rec(0, 'VERTEX', 10, x!, 20, y!, 30, 0, 70, 192));
    parts.push(rec(0, 'VERTEX', 70, 128, 71, 1, 72, 2, 73, 3).repeat(faces));
    parts.push(rec(0, 'SEQEND', 0, 'ENDSEC', 0, 'EOF'));
    const text = parts.join('');
    // With the default limits the reader refuses it like any oversized DXF ...
    expect(() => readDxf(text, { model3d: true })).toThrow(DxfReadError);
    expect(defaultReadLimitExcess(text)).toMatch(/^the file has 2,500,028 group pairs; JCad opens at most 2,000,000$/);
    // Raising tokenizer limits cannot raise the retained graph's independent 250,000-node
    // limit. Every source face has an identity now, so this earlier specific guard refuses it.
    let error: unknown;
    try { readDxf(text, { model3d: true, maxPairs: 4_000_000, maxRecords: 1_000_000 }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(DxfReadError);
    expect(error).toMatchObject({ message: 'Invalid or oversized retained CAD object graph.', truncated: false });
    expect(faces).toBe(500_001);
    // Two reads of a 2.5-million-pair file: about 4 s alone, more with the suite in parallel.
  }, 30_000);

  it('refuses to write a solid without triangles instead of dropping it', () => {
    // The model helpers never build one (model3d-model.test.ts); a hand-made state still fails loudly.
    const s: Solid3D = { id: 'e-empty', layer: '0', color: 'ByLayer', feature: { kind: 'mesh', source: 'edited' }, mesh: { positions: [0, 0, 0], indices: [] } };
    expect(() => writeDxf({ ...new Drawing().snapshot, model3d: { version: 1, solids: [s] } })).toThrow(/cannot be saved: the mesh has no triangles/);
  });
});

// ---------------------------------------------------------------- hand-written polyface records

/** A minimal AC1015 DXF whose ENTITIES section holds `body` (groups as code/value pairs). */
function dxf(body: Array<[number, string | number]>): string {
  const pairs: Array<[number, string | number]> = [[0, 'SECTION'], [2, 'ENTITIES'], ...body, [0, 'ENDSEC'], [0, 'EOF']];
  return pairs.map(([c, v]) => `${c}\r\n${v}`).join('\r\n') + '\r\n';
}

type Groups = Array<[number, string | number]>;
const vertex = (x: number, y: number, z: number): Groups => [[0, 'VERTEX'], [8, 'M'], [100, 'AcDbEntity'], [100, 'AcDbVertex'], [100, 'AcDbPolyFaceMeshVertex'], [10, x], [20, y], [30, z], [70, 192]];
const face = (...idx: number[]): Groups => [[0, 'VERTEX'], [8, 'M'], [100, 'AcDbEntity'], [100, 'AcDbFaceRecord'], [10, 0], [20, 0], [30, 0], [70, 128], ...idx.map((v, i): [number, number] => [71 + i, v])];
/** A tetrahedron (4 vertices, 4 outward faces) with an optional quad face set instead. */
const TETRA: Groups = [...vertex(0, 0, 0), ...vertex(1, 0, 0), ...vertex(0, 1, 0), ...vertex(0, 0, 1)];
const TETRA_FACES: Groups = [...face(1, 3, 2), ...face(1, 2, 4), ...face(2, 3, 4), ...face(3, 1, 4)];
const polyface = (body: Groups, xdata: Groups = [], extra: Groups = []): Groups => [[0, 'POLYLINE'], [5, 'A1'], [100, 'AcDbEntity'], [8, 'M'], ...extra, [100, 'AcDbPolyFaceMesh'], [66, 1], [10, 0], [20, 0], [30, 0], [70, 64], [71, 4], [72, 4], ...xdata, ...body, [0, 'SEQEND'], [8, 'M']];
const jcad = (payload: unknown): Groups => {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const out: Groups = [[1001, 'JCAD_3D']];
  for (let i = 0; i < text.length; i += 250) out.push([1000, text.slice(i, i + 250)]);
  return out;
};

describe('reading polyface meshes', () => {
  it('imports an AutoCAD polyface without JCad data as a mesh solid when 3D is enabled', () => {
    const s = readDxf(dxf(polyface([...TETRA, ...TETRA_FACES], [], [[62, 4]])), { model3d: true });
    const solid = s.model3d!.solids[0]!;
    expect(solid).toMatchObject({ layer: 'M', color: 4, feature: { kind: 'mesh', source: 'imported' } });
    expect(solid.mesh).toEqual({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3] });
    expect(meshIsClosed(solid.mesh)).toBe(true);
    expect(items(s)).toEqual([expect.objectContaining({ type: 'POLYLINE', action: 'simplified', handle: 'A1', layer: 'M', where: 'model space', reason: FOREIGN_POLYFACE_REASON })]);
    expect(s.layers.some((l) => l.name === 'M')).toBe(true);
  });

  it('retains a foreign polyface exactly without displaying it when 3D is disabled', () => {
    for (const opts of [{}, { model3d: false }]) {
      const s = readDxf(dxf(polyface([...TETRA, ...TETRA_FACES])), opts);
      expect(s.model3d).toBeUndefined();
      expect(items(s)).toEqual([expect.objectContaining({ type: 'POLYLINE', action: 'kept', reason: expect.stringContaining(POLYFACE_UNSUPPORTED_REASON) })]);
      const reopened = readDxf(writeDxf(s), { model3d: true });
      expect(reopened.model3d!.solids[0]!.mesh).toEqual({ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3] });
      expect(reopened.cadGraph!.nodes.find(node => node.type === 'POLYLINE')?.sourceHandle).toBe('A1');
      expect(POLYFACE_UNSUPPORTED_REASON).toBe('polyface meshes are not supported');
    }
  });

  it('keeps polygon meshes (flag 16) dropped and reported', () => {
    const body: Groups = [[0, 'POLYLINE'], [8, '0'], [100, 'AcDbPolygonMesh'], [70, 16], [71, 2], [72, 2], ...vertex(0, 0, 0), ...vertex(1, 0, 0), ...vertex(0, 1, 0), ...vertex(1, 1, 0), [0, 'SEQEND']];
    const s = readDxf(dxf(body), { model3d: true });
    expect(s.model3d).toBeUndefined();
    expect(items(s)).toEqual([expect.objectContaining({ action: 'dropped', reason: 'polygon meshes are not supported' })]);
  });

  it('splits quads into two triangles and reports skipped edge faces and open meshes', () => {
    // A unit square as one quad plus an edge-only face: an open surface.
    const body = polyface([...vertex(0, 0, 0), ...vertex(1, 0, 0), ...vertex(1, 1, 0), ...vertex(0, 1, 0), ...face(1, 2, 3, 4), ...face(1, -3), ...face(2, 3, 3)]);
    const s = readDxf(dxf(body), { model3d: true });
    expect(s.model3d!.solids[0]!.mesh.indices).toEqual([0, 1, 2, 0, 2, 3]);
    const reasons = items(s).map((i) => i.reason);
    expect(reasons[0]).toMatch(/^imported polyface mesh: not editable parametrically; 1 four-sided face split into triangles; the mesh is not closed/);
    expect(reasons[1]).toBe('2 faces with fewer than 3 distinct vertices (edges) not kept');
  });

  it('drops the whole record when a face names a vertex it does not have', () => {
    const s = readDxf(dxf(polyface([...TETRA, ...face(1, 2, 5)], jcad({ v: 1, id: 'eabc', feature: { kind: 'mesh', source: 'edited' } }))), { model3d: true });
    expect(s.model3d).toBeUndefined();
    expect(items(s)).toEqual([expect.objectContaining({ action: 'kept', reason: expect.stringContaining('polyface mesh: face record 1 refers to vertex 5, but the mesh has 4 vertices') })]);
    expect(s.cadGraph!.nodes.some(node => node.type === 'VERTEX' && node.groups.some(([code, value]) => code === 73 && value === '5'))).toBe(true);
    expect(() => writeDxf(s)).toThrow(/malformed retained polyface|unconsumed JCAD_3D/);
  });

  it('drops records with unreadable numbers or stray vertex kinds', () => {
    const badNumber = polyface([...vertex(0, 0, 0).map(([c, v]): [number, string | number] => [c, c === 20 ? 'NaN' : v]), ...vertex(1, 0, 0), ...vertex(0, 1, 0), ...face(1, 2, 3)]);
    const badState = readDxf(dxf(badNumber), { model3d: true });
    expect(items(badState)[0]).toMatchObject({ action: 'kept', reason: expect.stringContaining('polyface mesh: invalid numeric group 20') });
    expect(badState.cadGraph!.nodes.some(node => node.groups.some(([code, value]) => code === 20 && value === 'NaN'))).toBe(true);
    expect(() => writeDxf(badState)).toThrow(/malformed retained polyface: invalid numeric group 20/);
    const stray = polyface([...TETRA, ...TETRA_FACES, [0, 'VERTEX'], [70, 0], [10, 1], [20, 1], [30, 1]]);
    const strayState = readDxf(dxf(stray), { model3d: true });
    expect(items(strayState)[0]).toMatchObject({ action: 'kept', reason: expect.stringMatching(/neither a polyface mesh vertex nor a face record/) });
    expect(() => writeDxf(strayState)).toThrow(/neither a polyface mesh vertex nor a face record/);
    const empty = polyface([...TETRA]);
    const emptyState = readDxf(dxf(empty), { model3d: true });
    expect(items(emptyState)[0]).toMatchObject({ action: 'kept', reason: expect.stringContaining('polyface mesh: it has no faces') });
    expect(() => writeDxf(emptyState)).toThrow(/source mesh has no faces/);
  });

  it('keeps a solid whose history is malformed as a mesh feature and reports it', () => {
    for (const [payload, why] of [
      ['{"v":1,"id":"e1",', /not valid JSON/],
      [{ v: 1, id: 'e1', feature: { kind: 'gear', teeth: 12 } }, /feature\.kind "gear" is not a known feature kind/],
      [{ v: 1, id: 'e1', feature: { kind: 'box', frame: WORLD_XY_FRAME, width: -1, depth: 1, height: 1 } }, /feature\.width must be positive/],
      [{ v: 1, id: 'e1', feature: { kind: 'box', frame: WORLD_XY_FRAME, width: 1, depth: 1, height: 1, colour: 'red' } }, /unknown field "colour"/],
      [{ v: 1, id: 'e1', feature: { kind: 'boolean', op: 'union', operands: [{ kind: 'mesh', source: 'edited' }] } }, /operands must hold exactly two/],
      [{ v: 1, id: 'e1', extra: true, feature: { kind: 'mesh', source: 'edited' } }, /unknown field "extra"/],
      [[1, 2], /not a JSON object/],
      [{ id: 'e1' }, /no valid version/],
    ] as const) {
      const s = readDxf(dxf(polyface([...TETRA, ...TETRA_FACES], jcad(payload))), { model3d: true });
      const solid = s.model3d!.solids[0]!;
      expect(solid.feature).toEqual({ kind: 'mesh', source: 'imported' });
      expect(solid.mesh.indices).toHaveLength(12);
      const report = items(s);
      expect(report).toHaveLength(1);
      expect(report[0]).toMatchObject({ action: 'simplified', reason: expect.stringMatching(why) });
      expect(report[0]!.reason).toMatch(/kept as a mesh, not editable parametrically$/);
    }
  });

  it('reports a payload of a newer JCad as unsupported and keeps the mesh, id and name', () => {
    const s = readDxf(dxf(polyface([...TETRA, ...TETRA_FACES], jcad({ v: 2, id: 'e-future', name: 'Next', feature: { kind: 'nurbs', data: [1] } }))));
    expect(s.model3d!.solids[0]).toMatchObject({ id: 'e-future', name: 'Next', feature: { kind: 'mesh', source: 'imported' } });
    expect(items(s)).toEqual([expect.objectContaining({ action: 'unsupported', reason: expect.stringMatching(/written by a newer JCad \(3D data version 2; this version reads 1\)/) })]);
  });

  it('assigns fresh ids to duplicate or malformed ids', () => {
    const rec = (id: unknown, handle: string) => polyface([...TETRA, ...TETRA_FACES], jcad({ v: 1, id, feature: { kind: 'mesh', source: 'edited' } })).map(([code, value]): [number, string | number] => [code, code === 5 ? handle : value]);
    const s = readDxf(dxf([...rec('e-same', 'A1'), ...rec('e-same', 'A2'), ...rec('bad id with spaces', 'A3'), ...rec(42, 'A4')]));
    const ids = s.model3d!.solids.map((x) => x.id);
    expect(ids[0]).toBe('e-same');
    expect(new Set(ids).size).toBe(4);
    expect(ids.slice(1).every((id) => /^e[0-9a-z]+$/.test(id))).toBe(true);
    expect(items(s)).toEqual([]);
    expect(new Set(s.cadGraph!.nodes.filter(node => node.type === 'POLYLINE').map(node => node.sourceHandle)).size).toBe(4);
    expect(() => readDxf(dxf([...rec('e-same', 'A1'), ...rec('e-same', 'A1')]))).toThrow(/share source handle A1|Duplicate CAD object handle A1/);
  });

  it('reports polyfaces in blocks and on layouts instead of reading them', () => {
    const text = dxf(polyface([...TETRA, ...TETRA_FACES], [], [[67, 1]]));
    const s = readDxf(text, { model3d: true });
    expect(s.model3d).toBeUndefined();
    expect(items(s)[0]).toMatchObject({ action: 'kept' });
    expect(s.cadGraph!.nodes.find(node => node.type === 'POLYLINE')?.groups).toContainEqual([67, '1']);
    expect(() => writeDxf(s)).toThrow(/outside model space/);
  });

  it('drops a record whose mesh vertex has no coordinates', () => {
    const body = polyface([...vertex(0, 0, 0), ...vertex(1, 0, 0).filter(([c]) => c !== 30), ...vertex(0, 1, 0), ...face(1, 2, 3)]);
    const s = readDxf(dxf(body), { model3d: true });
    expect(items(s)).toEqual([expect.objectContaining({ action: 'kept', reason: expect.stringContaining('polyface mesh: mesh vertex 2 has no coordinate group 30') })]);
    expect(() => writeDxf(s)).toThrow(/mesh vertex 2 has no coordinate group 30/);
  });

  it('keeps ACI 0, and reports out-of-range or negative colours as ByLayer', () => {
    const read = (c: number) => readDxf(dxf(polyface([...TETRA, ...TETRA_FACES], jcad({ v: 1, id: 'e1', feature: { kind: 'mesh', source: 'edited' } }), [[62, c]])));
    expect(read(0).model3d!.solids[0]!.color).toBe(0);
    expect(items(read(0))).toEqual([]);
    expect(read(256).model3d!.solids[0]!.color).toBe('ByLayer');
    for (const c of [-3, 300]) {
      const s = read(c);
      expect(s.model3d!.solids[0]!.color).toBe('ByLayer');
      expect(items(s)).toEqual([expect.objectContaining({ action: 'simplified', reason: `colour ${c} is not an ACI colour (0 to 256): ByLayer is used` })]);
    }
  });

  it('rejects malformed JCAD_3D envelopes: duplicate data, long chunks, oversized payloads, bad parts', () => {
    const ok = { v: 1, id: 'e1', feature: { kind: 'mesh', source: 'edited' } };
    const cases: Array<[Groups, RegExp]> = [
      [[...jcad(ok), ...jcad(ok)], /has the JCad 3D data twice/],
      [[[1001, 'JCAD_3D'], [1000, 'x'.repeat(256)]], /an XDATA string exceeds 255 characters/],
      [[[1001, 'JCAD_3D'], ...Array.from({ length: 61 }, (): [number, string] => [1000, 'x'.repeat(250)])], /exceeds 15,000 bytes/],
      [[[1001, 'JCAD_3D'], [1070, 1]], /unexpected XDATA group 1070/],
      [jcad({ ...ok, parts: 0 }), /"parts" must be an integer from 1 to 1000/],
      [jcad({ ...ok, parts: 1001 }), /"parts" must be an integer from 1 to 1000/],
      [jcad({ ...ok, parts: 2, part: 2 }), /"part" must be an integer below "parts"/],
      [jcad({ ...ok, parts: 1.5 }), /"parts" must be an integer/],
    ];
    for (const [xdata, why] of cases) {
      const s = readDxf(dxf(polyface([...TETRA, ...TETRA_FACES], xdata)));
      expect(s.model3d!.solids[0]!.feature).toEqual({ kind: 'mesh', source: 'imported' });
      expect(items(s)).toEqual([expect.objectContaining({ action: 'simplified', reason: expect.stringMatching(why) })]);
    }
  });

  it('rejects hostile or invalid histories with a path: deep booleans, __proto__ keys, bad frames, zero axes', () => {
    let deep: Feature3D = { kind: 'mesh', source: 'edited' };
    for (let i = 0; i < 65; i++) deep = { kind: 'boolean', op: 'union', operands: [deep, { kind: 'mesh', source: 'edited' }] };
    const skew = { origin: v3(0, 0, 0), xAxis: v3(1, 0, 0), yAxis: v3(0.1, 1, 0), zAxis: v3(0, 0, 1) };
    const left = { origin: v3(0, 0, 0), xAxis: v3(1, 0, 0), yAxis: v3(0, 1, 0), zAxis: v3(0, 0, -1) };
    const long = { ...WORLD_XY_FRAME, xAxis: v3(2, 0, 0) };
    const cases: Array<[string, RegExp]> = [
      [JSON.stringify({ v: 1, id: 'e1', feature: deep }), /nests deeper than 64 levels/],
      ['{"v":1,"id":"e1","__proto__":{"polluted":true},"feature":{"kind":"mesh","source":"edited"}}', /unknown field "__proto__"/],
      ['{"v":1,"id":"e1","feature":{"kind":"mesh","source":"edited","__proto__":{}}}', /feature has an unknown field "__proto__"/],
      [JSON.stringify({ v: 1, id: 'e1', feature: { kind: 'box', frame: skew, width: 1, depth: 1, height: 1 } }), /feature.frame.yAxis must be a unit vector|feature.frame axes must be pairwise orthogonal/],
      [JSON.stringify({ v: 1, id: 'e1', feature: { kind: 'box', frame: left, width: 1, depth: 1, height: 1 } }), /feature.frame.zAxis must equal xAxis × yAxis/],
      [JSON.stringify({ v: 1, id: 'e1', feature: { kind: 'box', frame: long, width: 1, depth: 1, height: 1 } }), /feature.frame.xAxis must be a unit vector/],
      [JSON.stringify({ v: 1, id: 'e1', feature: { kind: 'revolve', profile, axis: { origin: v3(0, 0, 0), dir: v3(0, 0, 0) }, angle: 1 } }), /feature.axis.dir must not be the zero vector/],
    ];
    for (const [payload, why] of cases) {
      const s = readDxf(dxf(polyface([...TETRA, ...TETRA_FACES], jcad(payload))));
      expect(s.model3d!.solids[0]!.feature).toEqual({ kind: 'mesh', source: 'imported' });
      expect(items(s)).toEqual([expect.objectContaining({ action: 'simplified', reason: expect.stringMatching(why) })]);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    }
  });

  it('cleans names: control characters removed, at most 255 characters, reported', () => {
    const s = readDxf(dxf(polyface([...TETRA, ...TETRA_FACES], jcad({ v: 1, id: 'e1', name: `A\u0007B${'x'.repeat(300)}`, feature: { kind: 'mesh', source: 'edited' } }))));
    expect(s.model3d!.solids[0]!.name).toBe(`AB${'x'.repeat(253)}`);
    expect(items(s)).toEqual([expect.objectContaining({ action: 'simplified', reason: 'the name was shortened to 255 characters or had control characters removed' })]);
    const plain = readDxf(dxf(polyface([...TETRA, ...TETRA_FACES], jcad({ v: 1, id: 'e2', name: 'Ünïcödé name', feature: { kind: 'mesh', source: 'edited' } }))));
    expect(plain.model3d!.solids[0]!.name).toBe('Ünïcödé name');
    expect(items(plain)).toEqual([]);
  });

  it('drops a JCad polyface inside a block definition and reports it', () => {
    const block: Groups = [[0, 'SECTION'], [2, 'BLOCKS'], [0, 'BLOCK'], [8, '0'], [2, 'HAS3D'], [70, 0], [10, 0], [20, 0], [30, 0],
      ...polyface([...TETRA, ...TETRA_FACES], jcad({ v: 1, id: 'e-in-block', feature: { kind: 'mesh', source: 'edited' } })), [0, 'ENDBLK'], [0, 'ENDSEC']];
    const text = block.map(([c, v]) => `${c}\r\n${v}`).join('\r\n') + '\r\n' + dxf([]);
    for (const model3d of [true, false]) {
      const s = readDxf(text, { model3d });
      expect(s.model3d).toBeUndefined();
      expect(items(s)).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'POLYLINE', action: 'kept', where: 'block "HAS3D"', reason: expect.stringContaining('3D polyface meshes are read in model space only') })]));
      expect(s.cadGraph!.nodes.some(node => node.type === 'POLYLINE' && node.section === 'BLOCKS')).toBe(true);
      expect(() => writeDxf(s)).toThrow(/unconsumed JCAD_3D|outside model space/);
    }
  });

  it('DWG import: polyface meshes from the LibreDWG converter are dropped and reported, not read as solids', () => {
    // DWG opens use io/dwg.ts convertDwg on the LibreDWG payload, not the DXF reader.
    const { state } = convertDwg({ header: {}, layers: [], blocks: [], entities: [{ type: 'POLYLINE_PFACE', handle: 'A1', layer: '0' } as never] });
    expect(state.model3d).toBeUndefined();
    expect(importReportOf(state)?.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'POLYLINE_PFACE', action: 'dropped' })]));
  });

  it('retains other XDATA and native colour properties without claiming their display effects', () => {
    const s = readDxf(dxf(polyface([...TETRA, ...TETRA_FACES], [[1001, 'OTHER_APP'], [1000, 'x']], [[420, 0xff0000]])), { model3d: true });
    const reasons = items(s).map((i) => i.reason);
    expect(reasons[0]).toContain('retained in the CAD graph');
    expect(reasons[1]).toContain('effects may not be displayed');
    const reopened = readDxf(writeDxf(s));
    const parent = reopened.cadGraph!.nodes.find(node => node.type === 'POLYLINE')!;
    expect(parent.groups).toContainEqual([420, String(0xff0000)]);
    expect(parent.groups).toContainEqual([1001, 'OTHER_APP']);
    expect(parent.groups).toContainEqual([1000, 'x']);
  });
});
