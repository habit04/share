import { describe, expect, it } from 'vitest';
import { Drawing, validateDrawingState, type DrawingState } from '../src/core/document';
import { defaultLayout, makeViewport } from '../src/core/layouts';
import type { BlockDef, LineEntity, PolylineEntity } from '../src/core/entities';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import { SessionManager, type SessionHost } from '../src/app/sessions';
import { boxMesh } from '../src/model3d/primitives';
import { makeDimension3D } from '../src/model3d/dimension3d';
import { WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import type { Model3D, Solid3D } from '../src/model3d/types';

const solid = (): Solid3D => ({ id: 's', layer: '0', color: 'ByLayer', mesh: boxMesh(2, 3, 4), feature: { kind: 'mesh', source: 'imported' } });
const dimension = () => makeDimension3D({ id: 'd', kind: 'aligned', plane: WORLD_XY_FRAME, p1: v3(0, 0, 0), p2: v3(2, 0, 1), location: v3(1, 2, 0), style: STANDARD_DIMSTYLE });
const state = (): DrawingState => ({ ...new Drawing().snapshot, model3d: { version: 1, solids: [solid()], dimensions: [dimension()] } });
const line: LineEntity = { id: 's', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } };

describe('complete 3D snapshot validation', () => {
  it.each([
    ['version', (model: Model3D) => ({ ...model, version: 2 })],
    ['position', (model: Model3D) => ({ ...model, solids: [{ ...model.solids[0]!, mesh: { ...model.solids[0]!.mesh, positions: [NaN, 0, 0] } }] })],
    ['index', (model: Model3D) => ({ ...model, solids: [{ ...model.solids[0]!, mesh: { ...model.solids[0]!.mesh, indices: [0, 1, 999] } }] })],
    ['partial triangle', (model: Model3D) => ({ ...model, solids: [{ ...model.solids[0]!, mesh: { ...model.solids[0]!.mesh, indices: [0, 1] } }] })],
    ['unknown feature', (model: Model3D) => ({ ...model, solids: [{ ...model.solids[0]!, feature: { kind: 'future' } }] })],
    ['frame', (model: Model3D) => ({ ...model, dimensions: [{ ...model.dimensions![0]!, plane: { ...WORLD_XY_FRAME, xAxis: v3(2, 0, 0) } }] })],
    ['style', (model: Model3D) => ({ ...model, dimensions: [{ ...model.dimensions![0]!, style: { ...STANDARD_DIMSTYLE, textHeight: Infinity } }] })],
    ['axis', (model: Model3D) => ({ ...model, dimensions: [{ ...model.dimensions![0]!, kind: 'linear', axis: 'z' }] })],
  ])('refuses malformed %s before loading, history or dirty mutation', (_name, change) => {
    const doc = new Drawing(state()), before = doc.snapshot, history = doc.history();
    const bad = { ...state(), model3d: change(state().model3d!) as Model3D };
    expect(() => validateDrawingState(bad, before)).toThrow();
    expect(() => doc.load(bad, 'bad.dxf')).toThrow();
    expect(() => doc.transactDrawing(() => bad)).toThrow();
    expect(doc.snapshot).toBe(before); expect(doc.filePath).toBeNull(); expect(doc.dirty).toBe(false); expect(doc.history()).toEqual(history);
  });
  it('requires unique IDs against model, blocks, paper, viewport and disabled clip carriers', () => {
    const base = state(), layout = defaultLayout('Paper');
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [line], attributes: [] };
    const clip: PolylineEntity = { id: 's', type: 'polyline', layer: '0', color: 'ByLayer', closed: true, points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 2 }] };
    const viewport = makeViewport({ x: 6, y: 7 }, { x: 14, y: 13 }, '0', null, 1);
    const cases: DrawingState[] = [
      { ...base, entities: [line] }, { ...base, blocks: { B: block } },
      { ...base, entities: [{ ...line, id: 'other' }, { ...line, id: 'other' }] },
      { ...base, layouts: [{ ...layout, entities: [line] }] },
      { ...base, layouts: [{ ...layout, viewports: [{ ...viewport, id: 's' }] }] },
      { ...base, layouts: [{ ...layout, viewports: [{ ...viewport, clipBoundary: clip, clipOn: false }] }] },
      { ...base, model3d: { ...base.model3d!, dimensions: [{ ...dimension(), id: 's' }] } },
    ];
    for (const bad of cases) expect(() => validateDrawingState(bad)).toThrow(/unique IDs/);
  });
  it('rechecks mutable caller data and rejects cyclic histories within the depth budget', () => {
    const input = state(), mesh = input.model3d!.solids[0]!.mesh;
    validateDrawingState(input);
    (mesh.positions as number[])[0] = Infinity;
    expect(() => validateDrawingState(input)).toThrow(/finite/);
    const feature: { kind: 'boolean'; op: 'union'; operands: unknown[] } = { kind: 'boolean', op: 'union', operands: [] };
    feature.operands = [feature, { kind: 'mesh', source: 'edited' }];
    expect(() => validateDrawingState({ ...state(), model3d: { version: 1, solids: [{ ...solid(), feature: feature as unknown as Solid3D['feature'] }] } })).toThrow(/history budget/);
  });
  it.each(['state', 'undo', 'redo'] as const)('refuses malformed parked %s before switching or removing the active tab', field => {
    const doc = new Drawing(state());
    const host: SessionHost = { doc, viewport: { center: { x: 0, y: 0 }, scale: 2 }, selection: new Set(['s']), loadState: (next, path) => doc.load(next, path) };
    const sessions = new SessionManager(host), index = sessions.addInBackground(state(), 'parked.dxf');
    const parked = sessions.all[index]!, before = doc.snapshot, active = sessions.active, selection = host.selection;
    const bad = { ...state(), model3d: { version: 1, solids: [{ ...solid(), mesh: { positions: [0, 0, 0], indices: [999, 0, 0] } }] } } as DrawingState;
    if (field === 'state') parked.state = bad; else parked[field] = [bad];
    expect(() => sessions.switchTo(index)).toThrow(/index/);
    expect(() => sessions.close(active)).toThrow(/index/);
    expect(sessions.count).toBe(2); expect(sessions.active).toBe(active); expect(doc.snapshot).toBe(before); expect(host.selection).toBe(selection); expect(doc.dirty).toBe(false);
  });
});
