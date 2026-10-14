import { describe, expect, it } from 'vitest';
import { Drawing, prepareDrawingTransition, type DrawingState } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { tokenize, type Pair } from '../src/io/dxf/groups';
import { newSolid } from '../src/model3d/model';
import { boxMesh } from '../src/model3d/primitives';
import { makeDimension3D } from '../src/model3d/dimension3d';
import { frameFromPlane, v3 } from '../src/model3d/math';
import { importReportOf } from '../src/io/import-report';
import { mergeDwgCadGraph } from '../src/io/cad-graph-dwg';
import { convertDwg } from '../src/io/dwg';
import { validateCadState } from '../src/core/cad-graph';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';

const encode = (pairs: readonly Pair[]) => pairs.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n';
function mutate(text: string, kind: string, edit: (groups: Pair[]) => Pair[], occurrence = 0): string {
  const pairs = tokenize(text);
  let at = -1;
  for (let index = 0; index < pairs.length; index++) if (pairs[index]!.code === 0 && pairs[index]!.value === kind && occurrence-- === 0) { at = index; break; }
  if (at < 0) throw new Error(`Missing ${kind}`);
  let end = at + 1;
  while (end < pairs.length && pairs[end]!.code !== 0) end++;
  pairs.splice(at + 1, end - at - 1, ...edit(pairs.slice(at + 1, end)));
  return encode(pairs);
}
const pair = (code: number, value: string): Pair => ({ code, value });
function source(): string {
  const plain = new Drawing().snapshot;
  return writeDxf({ ...plain, entities: [{ type: 'line', id: 'two-d', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 2, y: 1 } }], model3d: { version: 1,
    solids: [newSolid({ id: 'solid', name: 'Source solid', mesh: boxMesh(2, 3, 4), feature: { kind: 'mesh', source: 'edited' } })],
    dimensions: [makeDimension3D({ id: 'dimension3d', kind: 'aligned', style: STANDARD_DIMSTYLE, plane: frameFromPlane({ origin: v3(0, 0, 0), normal: v3(0, 0, 1) }), p1: v3(0, 0, 0), p2: v3(3, 0, 0), location: v3(0, 2, 0) })],
  } });
}
function carrier(state: DrawingState, kind: 'solid3d' | 'dimension3d', part?: string) {
  const result = state.cadGraph?.nodes.find(node => node.anchor?.kind === kind && node.anchor.part === part);
  if (!result) throw new Error(`Missing carrier ${kind}/${part ?? 'primary'}`);
  return result;
}

describe('3D source carrier identities joined to the retained CAD graph', () => {
  it('binds exact parents, every follower and the dimension picture, with 3D display disabled', () => {
    const state = readDxf(source());
    expect(state.model3d?.solids).toHaveLength(1);
    expect(state.model3d?.dimensions).toHaveLength(1);
    const solid = state.model3d!.solids[0]!;
    expect(solid.cadIdentity).toBe(carrier(state, 'solid3d').id);
    expect(state.model3d!.dimensions![0]!.cadIdentity).toBe(carrier(state, 'dimension3d').id);
    const followers = state.cadGraph!.nodes.filter(node => node.anchor?.kind === 'solid3d' && node.anchor.part);
    expect(followers).toHaveLength(solid.mesh.positions.length / 3 + solid.mesh.indices.length / 3 + 1);
    expect(followers.every(node => !!node.sourceHandle)).toBe(true);
    expect(carrier(state, 'dimension3d', 'picture-block').type).toBe('BLOCK_RECORD');
    const reopened = readDxf(writeDxf(state));
    expect(carrier(reopened, 'solid3d').sourceHandle).toBe(carrier(state, 'solid3d').sourceHandle);
    expect(carrier(reopened, 'dimension3d').sourceHandle).toBe(carrier(state, 'dimension3d').sourceHandle);
    expect(reopened.model3d!.solids[0]!.mesh).toEqual(solid.mesh);
    expect(new Set([...reopened.entities.map(entity => entity.id), ...reopened.model3d!.solids.map(item => item.id), ...reopened.model3d!.dimensions!.map(item => item.id)]).size).toBe(3);
    expect(() => validateCadState(reopened)).not.toThrow();
  });

  it('retains other-app opaque text and exact parent→follower links while regenerating own history', () => {
    let text = source();
    const first = readDxf(text), follower = carrier(first, 'solid3d', 'polyface:0:vertex:0:mesh:0');
    text = mutate(text, 'POLYLINE', groups => [...groups, pair(1001, 'THIRD_PARTY_3D'), pair(1000, 'literal \\U+0041'), pair(1005, follower.sourceHandle!)]);
    text = mutate(text, 'VERTEX', groups => [...groups, pair(102, '{OPAQUE_APP'), pair(1001, 'JCAD_3D'), pair(1000, 'not a real payload'), pair(102, '}'), pair(1001, 'FOLLOWER_APP'), pair(1000, 'vertex metadata')]);
    const state = readDxf(text), solid = state.model3d!.solids[0]!;
    const next = { ...state, model3d: { ...state.model3d!, solids: [{ ...solid, name: 'Renamed' }] } };
    const reopened = readDxf(writeDxf(next));
    expect(reopened.model3d!.solids[0]!.name).toBe('Renamed');
    expect(carrier(reopened, 'solid3d').groups).toContainEqual([1000, 'literal \\U+0041']);
    expect(carrier(reopened, 'solid3d').groups).toContainEqual([1005, follower.sourceHandle!]);
    expect(carrier(reopened, 'solid3d', 'polyface:0:vertex:0:mesh:0').groups).toContainEqual([1000, 'not a real payload']);
    expect(carrier(reopened, 'solid3d', 'polyface:0:vertex:0:mesh:0').groups).toContainEqual([1000, 'vertex metadata']);
    expect(carrier(reopened, 'solid3d').groups.filter(([code, name]) => code === 1001 && name === 'JCAD_3D')).toHaveLength(1);
  });

  it('does not interpret fake flags, coordinates or own payloads inside opaque 102 blocks', () => {
    const original = readDxf(source());
    let text = mutate(source(), 'POLYLINE', groups => [pair(102, '{OPAQUE_NATIVE_FIELDS'), pair(70, '4294967360'), pair(1001, 'JCAD_3D'), pair(1000, 'not the own payload'), pair(102, '}'), ...groups]);
    text = mutate(text, 'VERTEX', groups => [pair(102, '{OPAQUE_VERTEX_FIELDS'), pair(70, '0'), pair(10, '999'), pair(20, '888'), pair(30, '777'), pair(102, '}'), ...groups]);
    const state = readDxf(text);
    expect(state.model3d!.solids[0]!.mesh).toEqual(original.model3d!.solids[0]!.mesh);
    const reopened = readDxf(writeDxf(state));
    expect(reopened.model3d!.solids[0]!.mesh).toEqual(original.model3d!.solids[0]!.mesh);
    expect(carrier(reopened, 'solid3d').groups).toContainEqual([70, '4294967360']);
    expect(carrier(reopened, 'solid3d', 'polyface:0:vertex:0:mesh:0').groups).toContainEqual([10, '999']);
  });

  it('regenerates translated coordinates through explicit mesh slots and keeps invisible source edges', () => {
    const text = mutate(source(), 'VERTEX', groups => groups.map(group => group.code === 71 ? { ...group, value: `-${group.value}` } : group), 8);
    const state = readDxf(text), solid = state.model3d!.solids[0]!;
    const positions = solid.mesh.positions.map((value, index) => value + (index % 3 === 0 ? 7 : index % 3 === 2 ? 2 : 0));
    const next = { ...state, model3d: { ...state.model3d!, solids: [{ ...solid, mesh: { ...solid.mesh, positions } }] } };
    const reopened = readDxf(writeDxf(next));
    expect(reopened.model3d!.solids[0]!.mesh.positions).toEqual(positions);
    expect(carrier(reopened, 'solid3d', 'polyface:0:face:0').groups.find(([code]) => code === 71)?.[1]).toMatch(/^-/);
    expect(carrier(reopened, 'solid3d', 'polyface:0:face:0').sourceHandle).toBe(carrier(state, 'solid3d', 'polyface:0:face:0').sourceHandle);
  });

  it('refuses topology edits instead of reassigning retained face handles by ordinal', () => {
    const state = readDxf(source()), solid = state.model3d!.solids[0]!;
    const indices = [...solid.mesh.indices]; [indices[0], indices[1]] = [indices[1]!, indices[0]!];
    const next = { ...state, model3d: { ...state.model3d!, solids: [{ ...solid, mesh: { ...solid.mesh, indices } }] } };
    expect(() => writeDxf(next)).toThrow(/topolog|correspondence/i);
    expect(state.model3d!.solids[0]!.mesh.indices).toEqual(solid.mesh.indices);
  });

  it('preserves source quadrilateral face identity instead of assigning its handle to a new triangle', () => {
    const text = mutate(source(), 'VERTEX', groups => [...groups, pair(74, '5')], 8);
    const state = readDxf(text);
    const face = carrier(state, 'solid3d', 'polyface:0:face:0');
    const reopened = readDxf(writeDxf(state));
    expect(carrier(reopened, 'solid3d', 'polyface:0:face:0').sourceHandle).toBe(face.sourceHandle);
    expect(carrier(reopened, 'solid3d', 'polyface:0:face:0').groups).toContainEqual([74, '5']);
    expect(reopened.model3d!.solids[0]!.mesh).toEqual(state.model3d!.solids[0]!.mesh);
  });

  it('gives a copied DIM3D its own picture symbol and preserves every native handle relationship', () => {
    const state = readDxf(source()), original = state.model3d!.dimensions![0]!;
    const clone = { ...original, id: 'copied-dimension3d' };
    const next = prepareDrawingTransition(state, { ...state, model3d: { ...state.model3d!, dimensions: [original, clone] } },
      { cloneBatches: [{ entityIds: {}, dimension3dIds: { [original.id]: clone.id } }] });
    const reopened = readDxf(writeDxf(next));
    expect(reopened.model3d!.dimensions).toHaveLength(2);
    const pictures = reopened.cadGraph!.nodes.filter(node => node.anchor?.kind === 'dimension3d' && node.anchor.part === 'picture-block');
    expect(pictures).toHaveLength(2);
    expect(new Set(pictures.map(node => node.groups.find(([code]) => code === 2)?.[1])).size).toBe(2);
    expect(new Set(pictures.map(node => node.sourceHandle)).size).toBe(2);
    expect(() => validateCadState(reopened)).not.toThrow();
  });

  it('retains a newer own solid payload on unchanged save and refuses edits', () => {
    const text = mutate(source(), 'POLYLINE', groups => groups.map(group => group.code === 1000 ? { ...group, value: group.value.replace('"v":1', '"v":99') } : group));
    const state = readDxf(text), solid = state.model3d!.solids[0]!;
    const reopened = readDxf(writeDxf(state));
    expect(carrier(reopened, 'solid3d').groups).toEqual(carrier(state, 'solid3d').groups);
    expect(() => writeDxf({ ...state, model3d: { ...state.model3d!, solids: [{ ...solid, name: 'unsafe replacement' }] } })).toThrow(/unknown|newer|invalid/i);
  });

  it('retains newer DIM3D data and refuses regeneration instead of downgrading its own payload', () => {
    const text = mutate(source(), 'DIMENSION', groups => groups.map(group => group.code === 1000 ? { ...group, value: group.value.replace('"v":1', '"v":99') } : group));
    const state = readDxf(text);
    expect(state.model3d!.dimensions).toHaveLength(1);
    expect(carrier(state, 'dimension3d').groups.some(([code, value]) => code === 1000 && value.includes('"v":99'))).toBe(true);
    expect(() => writeDxf(state)).toThrow(/unknown, newer or invalid JCAD_3D payload/);
  });

  it('keeps unconsumed foreign model-space polyfaces and reports retained data', () => {
    const text = mutate(source(), 'POLYLINE', groups => groups.slice(0, groups.findIndex(group => group.code === 1001 && group.value === 'JCAD_3D')));
    const state = readDxf(text);
    expect(state.model3d?.solids ?? []).toHaveLength(0);
    expect(importReportOf(state)?.items.find(item => item.type === 'POLYLINE')?.action).toBe('kept');
    const rewritten = writeDxf(state);
    const reopened = readDxf(rewritten, { model3d: true });
    expect(reopened.model3d?.solids).toHaveLength(1);
    expect(reopened.model3d!.solids[0]!.mesh).toEqual(readDxf(source()).model3d!.solids[0]!.mesh);
  });

  it.each(['4294967360', '-4294967232', '9007194959773760', '64.0', '6.4e1'])('rejects malformed native flags before bitwise classification: %s', flags => {
    const state = readDxf(mutate(source(), 'POLYLINE', groups => groups.map(group => group.code === 70 ? { ...group, value: flags } : group)));
    expect(state.model3d?.solids ?? []).toHaveLength(0);
    expect(importReportOf(state)?.items.some(item => item.reason.includes('structural flags'))).toBe(true);
  });

  it.each(['4294967329', '-4294967263', '33.0'])('rejects malformed DIM3D flags before applying the dimension mask: %s', flags => {
    const state = readDxf(mutate(source(), 'DIMENSION', groups => groups.map(group => group.code === 70 ? { ...group, value: flags } : group)));
    expect(state.model3d?.dimensions ?? []).toHaveLength(0);
    expect(state.cadGraph?.nodes.some(node => node.type === 'DIMENSION' && node.groups.some(([code, value]) => code === 70 && value === flags))).toBe(true);
    expect(() => writeDxf(state)).toThrow(/unsupported JCAD_3D dimension/);
  });

  it('joins native own 3D projection explicitly rather than dropping its consumed graph carriers', () => {
    const projected = readDxf(source());
    const base = { ...new Drawing().snapshot, entities: [] };
    const joined = mergeDwgCadGraph(base, projected);
    expect(joined.model3d?.solids[0]!.id).toBe(projected.model3d!.solids[0]!.id);
    expect(joined.model3d?.dimensions?.[0]!.id).toBe(projected.model3d!.dimensions![0]!.id);
    expect(() => validateCadState(joined)).not.toThrow();
    const collision = { ...base, entities: [{ type: 'line' as const, id: projected.model3d!.solids[0]!.id, layer: '0', color: 'ByLayer' as const, a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }] };
    expect(() => mergeDwgCadGraph(collision, projected)).toThrow(/collid/i);
  });

  it('refuses incomplete native own-carrier projections without executing a native reader', () => {
    // Synthetic protocol evidence only; this does not certify a DWG/native helper roundtrip.
    const metadata = { schemaVersion: 1, complete: false, dxf: source(), notes: [], objects: [], readError: 1 };
    expect(() => convertDwg({ header: {}, layers: [], blocks: [], entities: [], nativeMetadata: metadata as never })).toThrow(/2D fallback would lose/);
  });

  it('does not turn opaque own-looking data into a native carrier claim on incomplete projection', () => {
    const dxf = '0\r\nSECTION\r\n2\r\nENTITIES\r\n0\r\nPOLYLINE\r\n102\r\n{OTHER_APP\r\n1001\r\nJCAD_3D\r\n1000\r\nopaque\r\n102\r\n}\r\n70\r\n0\r\n0\r\nENDSEC\r\n0\r\nEOF\r\n';
    const metadata = { schemaVersion: 1, complete: false, dxf, notes: [], objects: [], readError: 1 };
    const result = convertDwg({ header: {}, layers: [], blocks: [], entities: [], nativeMetadata: metadata as never });
    expect(result.state.model3d).toBeUndefined();
    expect(result.report?.items.some(item => item.type === 'CAD_METADATA' && item.action === 'unsupported')).toBe(true);
  });
});
