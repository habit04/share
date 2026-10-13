/**
 * DXF persistence of true 3D dimensions (src/io/dxf/dim3d-write.ts, dim3d-read.ts): DIMENSION
 * entities in their plane's OCS with JCAD_3D data, round trips in several planes (negative
 * normals included), the 2D reader's behaviour with 3D off, damaged data and the save guards.
 */
import { describe, expect, it } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import type { DimensionEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { type Frame3, type Vec3, dot3, frameFromPlane, v3 } from '../src/model3d/math';
import { dimension3dLocation, dimension3dMeasurement, dimension3dText, makeDimension3D, planeWorld } from '../src/model3d/dimension3d';
import { decodeDimensionPayload, encodeDimensionPayload } from '../src/model3d/file-format';
import { addDimensions3D, addSolids, model3dOf, newSolid, withModel3D } from '../src/model3d/model';
import { boxMesh } from '../src/model3d/primitives';
import { MODEL3D_DWG_REFUSAL, model3dDwgRefusal, recoveryDxf } from '../src/model3d/save-guard';
import type { Dimension3D } from '../src/model3d/types';
import { axesFrame, flipFrame } from '../src/tools3d/context';

const PLANES: Array<[string, Frame3]> = [
  ['tilted', frameFromPlane({ origin: v3(1.25, -2.5, 3.75), normal: v3(0.3, -0.2, 0.9) })],
  ['negative tilted normal', frameFromPlane({ origin: v3(-4, 0.5, 2), normal: v3(-0.2, -0.9, -0.4) })],
  ['XZ (normal -Y)', axesFrame('XZ', v3(0, 7.5, 0))],
  ['YZ (normal +X)', axesFrame('YZ', v3(-3, 0, 0))],
  ['XY raised', axesFrame('XY', v3(0, 0, 12.5))],
  ['XY upside down (normal -Z)', flipFrame(axesFrame('XY', v3(0, 0, -2)))],
  ['rotated in its plane', { origin: v3(2, 3, 4), xAxis: v3(0, 0.6, 0.8), yAxis: v3(0, -0.8, 0.6), zAxis: v3(1, 0, 0) }],
];

const P = (f: Frame3, x: number, y: number, z = 0): Vec3 => planeWorld(f, { x, y }, z);
const style = STANDARD_DIMSTYLE;

/** One dimension of every kind in plane `f` (one of them projected, one with a text override). */
function dimsIn(f: Frame3, tag: string): Dimension3D[] {
  const a60 = Math.PI / 3;
  return [
    makeDimension3D({ id: `${tag}-al`, kind: 'aligned', plane: f, p1: P(f, 0.1, 0.2), p2: P(f, 3.1, 4.2), location: P(f, 0, 3), style, layer: 'DIMS', color: 4 }),
    makeDimension3D({ id: `${tag}-lx`, kind: 'linear', axis: 'x', plane: f, p1: P(f, 1, 1), p2: P(f, 4.5, 5), location: P(f, 2, 7), style }),
    makeDimension3D({ id: `${tag}-ly`, kind: 'linear', axis: 'y', plane: f, p1: P(f, 1, 1), p2: P(f, 4.5, 5), location: P(f, 7, 3), style, textOverride: 'H = <>' }),
    makeDimension3D({ id: `${tag}-an`, kind: 'angular', plane: f, vertex: P(f, -1, -1), p1: P(f, 1, -1), p2: P(f, -1 + Math.cos(a60), -1 + Math.sin(a60)), location: P(f, -0.2, -0.6), style }),
    makeDimension3D({ id: `${tag}-pr`, kind: 'aligned', plane: f, p1: P(f, 0, 0), p2: P(f, 3, 4, 2.5), location: P(f, -1, 2), style }),
  ];
}

function stateWith(dims: readonly Dimension3D[], solids = false): DrawingState {
  const base = new Drawing().snapshot;
  let model = addDimensions3D(model3dOf(base), dims);
  if (solids) model = addSolids(model, [newSolid({ id: 'box-1', mesh: boxMesh(1, 2, 3), feature: { kind: 'mesh', source: 'edited' } })]);
  return withModel3D({ ...base, layers: [...base.layers, { name: 'DIMS', color: 2, visible: true, locked: false, lineWeight: 0.25 }] }, model);
}

/** JSON (and DXF numbers) have no negative zero. */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function expectSame(read: Dimension3D, written: Dimension3D): void {
  expect(read.id).toBe(written.id);
  expect(read.kind).toBe(written.kind);
  expect(read.layer).toBe(written.layer);
  expect(read.color).toBe(written.color);
  expect(read.plane).toEqual(plain(written.plane));
  expect(read.p1).toEqual(plain(written.p1));
  expect(read.p2).toEqual(plain(written.p2));
  expect(read.vertex).toEqual(written.vertex && plain(written.vertex));
  expect(read.axis).toBe(written.axis);
  expect(read.textOverride).toBe(written.textOverride);
  expect(read.projected).toBe(written.projected);
  expect(read.style.name).toBe(written.style.name);
  expect(read.offset).toBeCloseTo(written.offset, 9);
  expect(dimension3dMeasurement(read)).toBe(dimension3dMeasurement(written));
  expect(dimension3dText(read)).toBe(dimension3dText(written));
}

/** The DIMENSION records of a DXF text, as [code, value] pair lists. */
function dimensionRecords(text: string): Array<Array<[string, string]>> {
  const lines = text.split('\r\n');
  const out: Array<Array<[string, string]>> = [];
  let cur: Array<[string, string]> | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i]!.trim(), value = lines[i + 1]!;
    if (code === '0') {
      cur = value === 'DIMENSION' ? [] : null;
      if (cur) out.push(cur);
    } else if (cur) cur.push([code, value]);
  }
  return out;
}

describe('3D dimensions round trip through DXF', () => {
  for (const [name, f] of PLANES) {
    it(`keeps ids, kinds, plane, points and measurements exactly: ${name}`, () => {
      const dims = dimsIn(f, name.replace(/\W+/g, ''));
      expect(dims[4]!.projected).toBe(true);
      const state = stateWith(dims);
      const text = writeDxf(state);
      for (const model3d of [true, false]) {
        const back = readDxf(text, { model3d });
        expect(back.entities.filter((e) => e.type === 'dimension')).toHaveLength(0);
        const read = back.model3d?.dimensions ?? [];
        expect(read).toHaveLength(dims.length);
        read.forEach((d, i) => expectSame(d, dims[i]!));
        if (model3d) expect(importReportOf(back)).toBeUndefined();
        else expect(importReportOf(back)?.notes.join(' ')).toMatch(/contains 5 experimental 3D dimensions/);
      }
      // The written records follow the DXF OCS convention.
      const recs = dimensionRecords(text);
      expect(recs).toHaveLength(5);
      for (const [k, rec] of recs.entries()) {
        const get = (c: string) => rec.find(([code]) => code === c)?.[1];
        expect([Number(get('210')), Number(get('220')), Number(get('230'))]).toEqual([f.zAxis.x + 0, f.zAxis.y + 0, f.zAxis.z + 0]);
        expect(Number(get('70')) & 15).toBe([1, 0, 0, 5, 1][k]);
        expect(get('2')).toMatch(/^\*D\d+$/);
        expect(get('3')).toBe('Standard');
        expect(get('1001')).toBe('JCAD_3D');
        // 13 is the stored world point (WCS), exactly.
        expect([Number(get('13')), Number(get('23')), Number(get('33'))]).toEqual([dims[k]!.p1.x + 0, dims[k]!.p1.y + 0, dims[k]!.p1.z + 0]);
        // 11 (text midpoint) is in OCS: its Z is the plane's elevation along the normal.
        expect(Number(get('31'))).toBeCloseTo(dot3(f.origin, f.zAxis), 6);
      }
      expect(recs[4]!.find(([c]) => c === '1')?.[1]).toBe('<> (projected)');
      expect(recs[2]!.find(([c]) => c === '1')?.[1]).toBe('H = <>');
      // Saving what was read gives the same file again.
      expect(writeDxf(readDxf(text, { model3d: true }))).toBe(text);
    });
  }

  it('writes a *D picture block per dimension, in the plane, after the 2D dimensions', () => {
    const f = PLANES[0]![1];
    const base = new Drawing();
    base.addEntities([{ id: 'd2', type: 'dimension', kind: 'aligned', layer: '0', color: 'ByLayer', p1: { x: 0, y: 0 }, p2: { x: 4, y: 0 }, linePoint: { x: 2, y: 1 }, rotation: 0, style } as DimensionEntity]);
    const state = withModel3D(base.snapshot, addDimensions3D(model3dOf(base.snapshot), dimsIn(f, 'pic').slice(0, 1)));
    const text = writeDxf(state);
    expect(text).toContain('\r\n2\r\n*D1\r\n');
    expect(text).toContain('\r\n2\r\n*D2\r\n');
    const at = text.indexOf('\r\nAcDbBlockBegin\r\n2\r\n*D2\r\n');
    expect(at).toBeGreaterThan(0);
    const block = text.slice(at, text.indexOf('ENDBLK', at));
    expect(block).toContain('\r\nLINE\r\n');
    expect(block).toContain('\r\nSOLID\r\n'); // filled arrowheads
    expect(block).toContain('\r\nTEXT\r\n');
    // The 2D dimension is untouched and still reads as 2D; the 3D one as 3D.
    const back = readDxf(text, { model3d: false });
    expect(back.entities.filter((e) => e.type === 'dimension')).toHaveLength(1);
    expect(back.model3d?.dimensions).toHaveLength(1);
    expect(Object.keys(back.blocks).filter((n) => n.startsWith('*D'))).toEqual([]);
  });

  it('keeps dimensions next to solids; ids stay unique', () => {
    const dims = dimsIn(PLANES[2]![1], 'mix');
    const back = readDxf(writeDxf(stateWith(dims, true)), { model3d: true });
    expect(back.model3d?.solids.map((s) => s.id)).toEqual(['box-1']);
    expect(back.model3d?.dimensions?.map((d) => d.id)).toEqual(dims.map((d) => d.id));
    // A dimension id that clashes with a solid's (a hand-edited file) gets a fresh one.
    const s = stateWith(dims, true);
    const clash = readDxf(writeDxf({ ...s, model3d: { ...s.model3d!, dimensions: [{ ...dims[0]!, id: 'box-1' }] } }), { model3d: true });
    expect(clash.model3d?.dimensions?.[0]?.id).not.toBe('box-1');
  });

  it('the payload holds only the id, the plane frame and the projected flag', () => {
    const d = dimsIn(PLANES[0]![1], 'pl')[4]!;
    const decoded = decodeDimensionPayload(encodeDimensionPayload(d));
    expect(decoded).toEqual({ status: 'ok', id: d.id, plane: plain(d.plane), offset: d.offset, projected: true });
    expect(decodeDimensionPayload('{"v":1,"kind":"dimension3d","offset":"x"}').status).toBe('invalid');
    expect(decodeDimensionPayload('{"v":1,"id":"a","kind":"dimension3d","extra":1}').status).toBe('invalid');
    expect(decodeDimensionPayload('{"v":1,"id":"a","kind":"box"}').status).toBe('invalid');
    expect(decodeDimensionPayload('{"v":1,"kind":"dimension3d","plane":{"origin":{"x":0,"y":0,"z":0},"xAxis":{"x":2,"y":0,"z":0},"yAxis":{"x":0,"y":1,"z":0},"zAxis":{"x":0,"y":0,"z":1}}}').status).toBe('invalid');
    expect(decodeDimensionPayload('{"v":1,"kind":"dimension3d","projected":false}').status).toBe('invalid');
    expect(decodeDimensionPayload('{"v":2,"id":"a","kind":"dimension3d"}')).toEqual({ status: 'newer', version: 2, id: 'a' });
    expect(decodeDimensionPayload('nope').status).toBe('invalid');
  });
});

/** Text of one dimension written in plane `f` with its JCAD_3D data removed (another program's file). */
function foreign(f: Frame3, kind: 'aligned' | 'angular' = 'aligned'): string {
  const d = kind === 'aligned' ? dimsIn(f, 'fx')[0]! : dimsIn(f, 'fx')[3]!;
  const text = writeDxf(stateWith([d]));
  return text.replace(/\r\n1001\r\nJCAD_3D\r\n1000\r\n[^\r]*(?:\r\n1000\r\n[^\r]*)*/, '');
}

/** The 100 subclass markers of a DIMENSION record, in order. */
const subclasses = (rec: Array<[string, string]>) => rec.filter(([c]) => c === '100').map(([, v]) => v);

/** A minimal ENTITIES-only DXF with one DIMENSION record (groups after the layer). */
function dimensionFile(groups: string): string {
  return `0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nDIMENSION\r\n5\r\n100\r\n100\r\nAcDbEntity\r\n8\r\n0\r\n100\r\nAcDbDimension\r\n2\r\n*D1\r\n${groups}0\r\nENDSEC\r\n0\r\nEOF\r\n`;
}
const g3 = (code: number, q: Vec3) => `${code}\r\n${q.x}\r\n${code + 10}\r\n${q.y}\r\n${code + 20}\r\n${q.z}\r\n`;
const ext = (n: Vec3) => `210\r\n${n.x}\r\n220\r\n${n.y}\r\n230\r\n${n.z}\r\n`;

describe('DIMENSION subclass markers', () => {
  it('aligned: AcDbDimension, AcDbAlignedDimension; linear: + AcDbRotatedDimension; angular: AcDb3PointAngularDimension only', () => {
    const recs = dimensionRecords(writeDxf(stateWith(dimsIn(PLANES[0]![1], 'sub'))));
    expect(recs.map(subclasses)).toEqual([
      ['AcDbEntity', 'AcDbDimension', 'AcDbAlignedDimension'],
      ['AcDbEntity', 'AcDbDimension', 'AcDbAlignedDimension', 'AcDbRotatedDimension'],
      ['AcDbEntity', 'AcDbDimension', 'AcDbAlignedDimension', 'AcDbRotatedDimension'],
      ['AcDbEntity', 'AcDbDimension', 'AcDb3PointAngularDimension'],
      ['AcDbEntity', 'AcDbDimension', 'AcDbAlignedDimension'],
    ]);
  });
});

describe('reading DIMENSIONs of other programs', () => {
  it('a rotated linear DIMENSION (50 = 30 degrees in a tilted plane) measures along that direction', () => {
    const n = PLANES[0]![1].zAxis;
    const ocs = frameFromPlane({ origin: v3(0, 0, 0), normal: n });
    const w = (x: number, y: number) => planeWorld(ocs, { x, y }, 2);
    const a = Math.PI / 6;
    const text = dimensionFile(g3(10, w(0, 3)) + '70\r\n0\r\n' + ext(n) + '100\r\nAcDbAlignedDimension\r\n' + g3(13, w(0, 0)) + g3(14, w(4, 1)) + '50\r\n30\r\n100\r\nAcDbRotatedDimension\r\n');
    const [d] = readDxf(text, { model3d: true }).model3d?.dimensions ?? [];
    expect(d?.kind).toBe('linear');
    expect(d!.axis).toBe('x');
    // The plane X axis runs at 30 degrees in the OCS.
    expect(dot3(d!.plane.xAxis, ocs.xAxis)).toBeCloseTo(Math.cos(a), 12);
    expect(dot3(d!.plane.xAxis, ocs.yAxis)).toBeCloseTo(Math.sin(a), 12);
    expect(dimension3dMeasurement(d!)).toBeCloseTo(4 * Math.cos(a) + 1 * Math.sin(a), 12);
  });

  it('a DIMENSION with extrusion (0, 0, -1): the 3D path with 3D on, flat (with a note) with 3D off', () => {
    const n = v3(0, 0, -1);
    const text = dimensionFile(g3(10, v3(2, 3, -1)) + '70\r\n1\r\n' + ext(n) + '100\r\nAcDbAlignedDimension\r\n' + g3(13, v3(0, 0, -1)) + g3(14, v3(4, 0, -1)));
    const on = readDxf(text, { model3d: true });
    const [d] = on.model3d?.dimensions ?? [];
    expect(d?.plane.zAxis).toEqual(n);
    // The Arbitrary Axis Algorithm: the OCS X axis of -Z is world -X.
    expect(d!.plane.xAxis).toEqual(v3(-1, 0, 0));
    expect(d!.plane.origin.z).toBeCloseTo(-1, 12);
    expect(dimension3dMeasurement(d!)).toBeCloseTo(4, 12);
    expect(d!.projected).toBeUndefined();
    // The dimension line is where 10 says (y = 3), whatever the orientation.
    expect(dimension3dLocation(d!).y).toBeCloseTo(3, 12);
    const off = readDxf(text, { model3d: false });
    expect(off.model3d).toBeUndefined();
    expect(off.entities.filter((e) => e.type === 'dimension')).toHaveLength(1);
    expect(importReportOf(off)?.notes.some((t) => /1 dimension of this drawing lies in a plane other than the XY plane \(or faces -Z\) and was read flat/.test(t))).toBe(true);
    expect((importReportOf(off)?.items ?? []).filter((i) => i.type === 'DIMENSION')).toEqual([]);
  });

  const f = PLANES[0]![1];
  it('with 3D off: the unchanged 2D path (flat, no 3D model, no new report items)', () => {
    const text = foreign(f);
    expect(text).not.toContain('JCAD_3D\r\n1000');
    const back = readDxf(text, { model3d: false });
    expect(back.model3d).toBeUndefined();
    const dims = back.entities.filter((e): e is DimensionEntity => e.type === 'dimension');
    expect(dims).toHaveLength(1);
    // The 2D reader takes the x, y of the world points 13 / 14, as before 3D support.
    const d = dimsIn(f, 'fx')[0]!;
    expect(dims[0]!.p1).toEqual({ x: d.p1.x, y: d.p1.y });
    expect(dims[0]!.p2).toEqual({ x: d.p2.x, y: d.p2.y });
    expect((importReportOf(back)?.items ?? []).filter((i) => i.type === 'DIMENSION')).toEqual([]);
  });

  it('with 3D on: a DIMENSION in a tilted plane becomes a 3D dimension in its OCS plane', () => {
    for (const kind of ['aligned', 'angular'] as const) {
      const back = readDxf(foreign(f, kind), { model3d: true });
      expect(back.entities.filter((e) => e.type === 'dimension')).toHaveLength(0);
      const [d] = back.model3d?.dimensions ?? [];
      const w = kind === 'aligned' ? dimsIn(f, 'fx')[0]! : dimsIn(f, 'fx')[3]!;
      expect(d!.kind).toBe(kind);
      expect(d!.plane.zAxis).toEqual(plain(f.zAxis));
      expect(dimension3dMeasurement(d!)).toBeCloseTo(dimension3dMeasurement(w), 12);
      expect(d!.projected).toBeUndefined();
    }
  });

  it('with 3D on: an XY-plane DIMENSION stays 2D', () => {
    const text = foreign(axesFrame('XY'));
    const back = readDxf(text, { model3d: true });
    expect(back.model3d).toBeUndefined();
    expect(back.entities.filter((e) => e.type === 'dimension')).toHaveLength(1);
  });

  it('reads a two-line angular DIMENSION (type 2) in a tilted plane', () => {
    const ocs = frameFromPlane({ origin: v3(0, 0, 0), normal: f.zAxis });
    const elev = 1.5;
    const w = (x: number, y: number) => planeWorld(ocs, { x, y }, elev);
    const g3 = (code: number, q: Vec3) => `${code}\r\n${q.x}\r\n${code + 10}\r\n${q.y}\r\n${code + 20}\r\n${q.z}\r\n`;
    const rec = '0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nDIMENSION\r\n5\r\n100\r\n100\r\nAcDbEntity\r\n8\r\n0\r\n100\r\nAcDbDimension\r\n2\r\n*D1\r\n'
      + g3(10, w(0, 3)) + '11\r\n1\r\n21\r\n1\r\n31\r\n1.5\r\n70\r\n2\r\n' + `210\r\n${f.zAxis.x}\r\n220\r\n${f.zAxis.y}\r\n230\r\n${f.zAxis.z}\r\n`
      + '100\r\nAcDb2LineAngularDimension\r\n' + g3(13, w(1, 0)) + g3(14, w(3, 0)) + g3(15, w(0, 1)) + `16\r\n1\r\n26\r\n1\r\n36\r\n${elev}\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n`;
    const back = readDxf(rec, { model3d: true });
    const [d] = back.model3d?.dimensions ?? [];
    expect(d?.kind).toBe('angular');
    expect(dimension3dMeasurement(d!)).toBeCloseTo(Math.PI / 2, 12);
    expect(d!.vertex!.x).toBeCloseTo(w(0, 0).x, 12);
    expect(d!.vertex!.z).toBeCloseTo(w(0, 0).z, 12);
  });
});

describe('damaged or edited JCad 3D dimension data', () => {
  const f = PLANES[1]![1];
  it('unreadable data keeps the dimension (new id, plane from the extrusion) and reports it', () => {
    const d = dimsIn(f, 'bad')[0]!;
    const text = writeDxf(stateWith([d])).replace(`"id":"${d.id}"`, '"oops":1');
    const back = readDxf(text, { model3d: true });
    const [r] = back.model3d?.dimensions ?? [];
    expect(r!.id).not.toBe(d.id);
    expect(r!.plane.zAxis).toEqual(plain(f.zAxis));
    expect(dimension3dMeasurement(r!)).toBeCloseTo(dimension3dMeasurement(d), 12);
    expect(importReportOf(back)?.items.some((i) => i.action === 'simplified' && /unknown field "oops"/.test(i.reason))).toBe(true);
  });

  it('a plane that no longer matches the record is rebuilt from the extrusion', () => {
    const d = dimsIn(f, 'moved')[0]!;
    // Another program moved the dimension along its normal (10 changed) but kept the data.
    const text = writeDxf(stateWith([d]));
    const rec = dimensionRecords(text)[0]!;
    const x10 = rec.find(([c]) => c === '10')![1];
    const moved = text.replace(`\r\n10\r\n${x10}\r\n`, `\r\n10\r\n${Number(x10) + 3}\r\n`);
    const back = readDxf(moved, { model3d: true });
    expect(back.model3d?.dimensions?.[0]?.id).toBe(d.id);
    expect(importReportOf(back)?.items.some((i) => /stored measurement plane does not match/.test(i.reason))).toBe(true);
  });

  it('an unsupported type in JCad data is dropped with a reason', () => {
    const d = dimsIn(f, 'type')[0]!;
    const text = writeDxf(stateWith([d])).replace(/\r\n70\r\n33\r\n/, '\r\n70\r\n36\r\n');
    const back = readDxf(text, { model3d: true });
    expect(back.model3d).toBeUndefined();
    expect(importReportOf(back)?.items.some((i) => i.type === 'DIMENSION' && i.action === 'dropped' && /only aligned, linear and angular/.test(i.reason))).toBe(true);
  });
});

describe('save guards with 3D dimensions', () => {
  it('DWG saves are refused; recovery copies keep the dimensions', () => {
    const state = stateWith(dimsIn(PLANES[0]![1], 'g').slice(0, 2));
    expect(model3dDwgRefusal(state)).toBe(MODEL3D_DWG_REFUSAL);
    expect(model3dDwgRefusal(new Drawing().snapshot)).toBeNull();
    const { text, omitted3d } = recoveryDxf(state);
    expect(omitted3d).toBe(0);
    expect(readDxf(text).model3d?.dimensions).toHaveLength(2);
  });

  it('an empty dimension list writes exactly the 2D file', () => {
    const base = new Drawing().snapshot;
    expect(writeDxf({ ...base, model3d: { version: 1, solids: [], dimensions: [] } })).toBe(writeDxf(base));
  });
});
