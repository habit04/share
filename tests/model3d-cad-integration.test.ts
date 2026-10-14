import { describe, expect, it } from 'vitest';
import { Drawing, prepareDrawingTransition, validateDrawingState, type DrawingState } from '../src/core/document';
import { CadGraphError, type CadNode } from '../src/core/cad-graph';
import type { LineEntity } from '../src/core/entities';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import { makeDimension3D } from '../src/model3d/dimension3d';
import { WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import { model3dOf, removeObjects3D } from '../src/model3d/model';
import type { Solid3D } from '../src/model3d/types';
import { commitSolidEdit, mirrorAcrossLine2d, translationMatrix } from '../src/tools3d/solid-edit';
import { CopyTool, MoveTool, EraseTool } from '../src/tools/modify';
import { drive, fakeContext } from './fake-context';

function fixture(): DrawingState {
  const line: LineEntity = { id: 'line', cadIdentity: 'cad:line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 2, y: 0 } };
  const solid: Solid3D = { id: 'solid', cadIdentity: 'cad:solid', layer: '0', color: 'ByLayer', mesh: { positions: [0, 0, 0, 2, 0, 0, 0, 2, 0], indices: [0, 1, 2] }, feature: { kind: 'mesh', source: 'imported' } };
  const dim = { ...makeDimension3D({ id: 'dim', kind: 'aligned', plane: WORLD_XY_FRAME, p1: v3(0, 0, 0), p2: v3(2, 0, 0), location: v3(1, 2, 0), style: STANDARD_DIMSTYLE }), cadIdentity: 'cad:dim' };
  const nodes: CadNode[] = [
    { id: 'cad:line', sourceHandle: 'A', type: 'LINE', section: 'ENTITIES', anchor: { kind: 'entity', id: line.id }, baselineEntity: line, groups: [[5, 'A'], [1001, 'APP'], [1011, '0'], [1021, '0'], [1031, '0']] },
    { id: 'cad:solid', sourceHandle: 'B', type: 'POLYLINE', section: 'ENTITIES', anchor: { kind: 'solid3d', id: solid.id }, baselineSolid: solid, groups: [[5, 'B'], [360, 'D'], [1001, 'APP'], [1011, '0'], [1021, '0'], [1031, '0']], references: [{ groupIndex: 1, kind: 'hard-owner', target: 'cad:record', role: 'extension' }] },
    { id: 'cad:vertex', sourceHandle: 'C', type: 'VERTEX', section: 'ENTITIES', anchor: { kind: 'solid3d', id: solid.id, part: 'polyface:0:vertex:0:mesh:0' }, groups: [[5, 'C'], [330, 'B'], [1001, 'APP'], [1011, '1'], [1021, '2'], [1031, '3']], references: [{ groupIndex: 1, kind: 'soft-pointer', target: 'cad:solid', role: 'owner' }] },
    { id: 'cad:record', sourceHandle: 'D', type: 'XRECORD', section: 'OBJECTS', groups: [[5, 'D'], [330, 'B'], [340, 'A'], [160, '9007199254740993'], [310, '007FFF']], references: [{ groupIndex: 1, kind: 'soft-pointer', target: 'cad:solid', role: 'owner' }, { groupIndex: 2, kind: 'hard-pointer', target: 'cad:line' }] },
    { id: 'cad:dim', sourceHandle: 'E', type: 'DIMENSION', section: 'ENTITIES', anchor: { kind: 'dimension3d', id: dim.id }, baselineDimension3D: dim, groups: [[5, 'E'], [1001, 'APP'], [1011, '0'], [1021, '0'], [1031, '0']] },
    { id: 'cad:picture', sourceHandle: 'F', type: 'BLOCK_RECORD', section: 'TABLES', anchor: { kind: 'dimension3d', id: dim.id, part: 'picture-block' }, groups: [[5, 'F'], [2, '*D1']] },
  ];
  return { ...new Drawing().snapshot, entities: [line], model3d: { version: 1, solids: [solid], dimensions: [dim] }, cadGraph: { schema: 1, sourceFormat: 'DXF', documentId: 'carrier-test', nodes } };
}
const node = (state: DrawingState, id: string) => state.cadGraph!.nodes.find(value => value.id === id)!;
const point = (value: CadNode) => [1011, 1021, 1031].map(code => Number(value.groups.find(pair => pair[0] === code)![1]));
function selected(doc: Drawing) { const ctx = fakeContext(doc); ctx.selection = new Set(['line', 'solid', 'dim']); return ctx; }

describe('typed 3D CAD carriers in whole prepared transitions', () => {
  it('moves a mixed selection and every retained follower in one exact undo/redo step', () => {
    const doc = new Drawing(fixture()), before = doc.snapshot;
    drive(new MoveTool(), selected(doc), [{ x: 0, y: 0 }, { x: 3, y: 4 }]);
    expect(point(node(doc.snapshot, 'cad:solid'))).toEqual([3, 4, 0]);
    expect(point(node(doc.snapshot, 'cad:vertex'))).toEqual([4, 6, 3]);
    expect(point(node(doc.snapshot, 'cad:dim'))).toEqual([3, 4, 0]);
    expect(doc.snapshot.model3d!.solids[0]!.mesh.positions.slice(0, 3)).toEqual([3, 4, 0]);
    expect(node(doc.snapshot, 'cad:record').groups.slice(3)).toEqual([[160, '9007199254740993'], [310, '007FFF']]);
    const after = doc.snapshot;
    expect(doc.history().undo).toHaveLength(1); expect(doc.dirty).toBe(true);
    doc.undo(); expect(doc.snapshot).toBe(before); doc.redo(); expect(doc.snapshot).toBe(after);
  });
  it('copies 2D, solid and DIM3D as one set, remapping hard peer links and picture/follower identities', () => {
    const doc = new Drawing(fixture()), before = doc.snapshot;
    drive(new CopyTool(), selected(doc), [{ x: 0, y: 0 }, { x: 10, y: 0 }, '']);
    const copyLine = doc.entities[1]!, solid = doc.snapshot.model3d!.solids[1]!, dim = doc.snapshot.model3d!.dimensions![1]!;
    expect(solid.id).not.toBe('solid'); expect(solid.cadIdentity).not.toBe('cad:solid');
    expect(dim.id).not.toBe('dim'); expect(dim.cadIdentity).not.toBe('cad:dim');
    const solidNode = node(doc.snapshot, solid.cadIdentity!), record = node(doc.snapshot, solidNode.references![0]!.target!);
    expect(record.references!.find(ref => ref.groupIndex === 2)!.target).toBe(copyLine.cadIdentity);
    expect(point(solidNode)).toEqual([10, 0, 0]);
    expect(doc.snapshot.cadGraph!.nodes.some(value => value.anchor?.kind === 'solid3d' && value.anchor.id === solid.id && value.anchor.part === 'polyface:0:vertex:0:mesh:0')).toBe(true);
    expect(doc.snapshot.cadGraph!.nodes.some(value => value.anchor?.kind === 'dimension3d' && value.anchor.id === dim.id && value.anchor.part === 'picture-block')).toBe(true);
    expect(() => validateDrawingState(doc.snapshot)).not.toThrow();
    doc.undo(); expect(doc.snapshot).toBe(before);
  });
  it('refuses an imported mirrored topology before changing either half, dirty state or history', () => {
    const doc = new Drawing(fixture()), before = doc.snapshot, ctx = selected(doc), selection = ctx.selection;
    expect(() => commitSolidEdit(ctx, { solids: doc.snapshot.model3d!.solids, matrix: mirrorAcrossLine2d({ x: 0, y: 0 }, { x: 0, y: 1 }) })).toThrow(/topology/);
    expect(doc.snapshot).toBe(before); expect(doc.dirty).toBe(false); expect(doc.canUndo()).toBe(false); expect(ctx.selection).toBe(selection);
  });
  it('erases all selected carrier/follower metadata atomically and protects unselected hard dependents', () => {
    const doc = new Drawing(fixture()), before = doc.snapshot;
    drive(new EraseTool(), selected(doc), []);
    expect(doc.snapshot.model3d).toBeUndefined(); expect(doc.entities).toHaveLength(0); expect(doc.snapshot.cadGraph!.nodes).toHaveLength(0);
    doc.undo(); expect(doc.snapshot).toBe(before);
    const dependent: CadNode = { id: 'dependent', type: 'XRECORD', section: 'OBJECTS', groups: [[340, 'E']], references: [{ groupIndex: 0, kind: 'hard-pointer', target: 'cad:dim' }] };
    const guarded = new Drawing({ ...fixture(), cadGraph: { ...fixture().cadGraph!, nodes: [...fixture().cadGraph!.nodes, dependent] } }), untouched = guarded.snapshot;
    expect(() => guarded.updateModel3D(model => removeObjects3D(model, ['dim']))).toThrow(CadGraphError);
    expect(guarded.snapshot).toBe(untouched); expect(guarded.canUndo()).toBe(false); expect(guarded.dirty).toBe(false);
  });
  it('refuses raw model omission and shared identities, but permits a deliberate prepared deletion', () => {
    const state = fixture(), { model3d: _drop, ...bare } = state;
    expect(() => validateDrawingState(bare)).toThrow(/missing/);
    const reduced = prepareDrawingTransition(state, bare);
    expect(reduced.cadGraph!.nodes.map(value => value.id)).toEqual(['cad:line']);
    expect(() => new Drawing({ ...state, model3d: { ...state.model3d!, solids: [state.model3d!.solids[0]!, { ...state.model3d!.solids[0]!, id: 'copy' }] } })).toThrow(/identity/);
  });
  it('returns committed identities and refuses stale captured 3D edit sources', () => {
    const doc = new Drawing(fixture()), original = doc.snapshot.model3d!.solids[0]!;
    const result = commitSolidEdit({ doc }, { solids: [original], matrix: translationMatrix(v3(5, 0, 0)), copy: true });
    expect(result[0]).toBe(model3dOf(doc.snapshot).solids[1]); expect(result[0]!.cadIdentity).not.toBe(original.cadIdentity);
    commitSolidEdit({ doc }, { solids: [original], matrix: translationMatrix(v3(1, 0, 0)) });
    const before = doc.snapshot, history = doc.history();
    expect(() => commitSolidEdit({ doc }, { solids: [original], matrix: translationMatrix(v3(2, 0, 0)) })).toThrow(/source changed/);
    expect(doc.snapshot).toBe(before); expect(doc.history()).toEqual(history);
  });
});
