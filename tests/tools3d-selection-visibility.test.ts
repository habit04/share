/** Retained 3D objects must not join a generic ALL selection in the Canvas 2D view. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import type { installExperimental3d as InstallType } from '../src/app/experimental-3d';
import { RIBBON } from '../src/ui/ribbon';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import { addDimensions3D, addSolids, model3dOf, newSolid } from '../src/model3d/model';
import { makeDimension3D } from '../src/model3d/dimension3d';
import { WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import { primitiveMesh } from '../src/model3d/primitives';
import type { PrimitiveFeature } from '../src/model3d/types';
import { fakeViewport3d } from './helpers/fake-viewport3d';

let Editor: typeof EditorType;
let installExperimental3d: typeof InstallType;
beforeAll(async () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  Editor = (await import('../src/app/editor')).Editor;
  ({ installExperimental3d } = await import('../src/app/experimental-3d'));
});
afterEach(() => {
  const i = RIBBON.findIndex((tab) => tab.name === '3D');
  if (i >= 0) RIBBON.splice(i, 1);
});
afterAll(() => vi.unstubAllGlobals());

const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

function fixture() {
  const ed = new Editor(canvas());
  ed.settings = { ...ed.settings, experimental3d: true };
  const feature: PrimitiveFeature = { kind: 'box', frame: WORLD_XY_FRAME, width: 1, depth: 1, height: 1 };
  const visibleSolid = newSolid({ id: 'solid-visible', layer: '0', feature, mesh: primitiveMesh(feature) });
  const hiddenSolid = newSolid({ id: 'solid-hidden', layer: 'HIDDEN', feature, mesh: primitiveMesh(feature) });
  const dimension = makeDimension3D({ id: 'dim-visible', kind: 'aligned', layer: '0', color: 'ByLayer', plane: WORLD_XY_FRAME, style: STANDARD_DIMSTYLE, p1: v3(0, 0, 0), p2: v3(1, 0, 0), location: v3(0, 1, 0) });
  const hiddenDimension = { ...dimension, id: 'dim-hidden', layer: 'HIDDEN' };
  const model = addDimensions3D(addSolids(model3dOf(ed.doc.snapshot), [visibleSolid, hiddenSolid]), [dimension, hiddenDimension]);
  ed.doc.load({
    ...ed.doc.snapshot,
    entities: [{ id: 'line-2d', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 2, y: 0 } }],
    layers: [...ed.doc.layers, { ...ed.doc.layers[0]!, name: 'HIDDEN', visible: false }],
    model3d: model,
  });
  const before = ed.doc.snapshot;
  const c = installExperimental3d(ed)!;
  const run = (command: string, ...inputs: string[]) => {
    void ed.runCommand(command);
    for (const text of inputs) ed.submitInput(text);
  };
  return { ed, c, before, run };
}

describe('ALL selection follows the active 2D or 3D view', () => {
  it('installing 3D tools and selecting ALL in 2D preserve the clean retained model', () => {
    const { ed, c, before } = fixture();
    expect(c.active).toBe(false);
    expect(c.kernelStarted).toBe(false);
    const ids = new Set<string>();
    expect(ed.selectionKeyword?.('ALL', ids)).toBe(true);
    expect([...ids]).toEqual(['line-2d']);
    expect(ed.doc.snapshot).toBe(before);
    expect(ed.doc.dirty).toBe(false);
    expect(ed.doc.history()).toEqual({ undo: [], redo: [] });
  });

  it('2D ERASE ALL changes only 2D entities in one undoable dirty step', () => {
    const { ed, before, run } = fixture();
    run('ERASE', 'ALL', '');
    const erased = ed.doc.snapshot;
    expect(ed.doc.entities).toEqual([]);
    expect(erased.model3d).toBe(before.model3d);
    expect(ed.doc.dirty).toBe(true);
    expect(ed.doc.history().undo).toHaveLength(1);
    ed.doc.undo();
    expect(ed.doc.snapshot).toBe(before);
    ed.doc.redo();
    expect(ed.doc.snapshot).toBe(erased);
    expect(ed.doc.snapshot.model3d).toBe(before.model3d);
  });

  it('2D MOVE ALL leaves invisible solids and dimensions at their original positions', () => {
    const { ed, before, run } = fixture();
    run('MOVE', 'ALL', '', '0,0', '4,5');
    const moved = ed.doc.snapshot;
    expect(ed.doc.entities[0]).toMatchObject({ a: { x: 4, y: 5 }, b: { x: 6, y: 5 } });
    expect(moved.model3d).toBe(before.model3d);
    expect(ed.doc.dirty).toBe(true);
    expect(ed.doc.history().undo).toHaveLength(1);
    ed.doc.undo();
    expect(ed.doc.snapshot).toBe(before);
    ed.doc.redo();
    expect(ed.doc.snapshot).toBe(moved);
  });

  it('active 3D ALL includes visible solids and dimensions and excludes hidden layers', () => {
    const { ed, c, before, run } = fixture();
    c.viewport = fakeViewport3d(ed.doc);
    expect(c.active).toBe(true);
    const ids = new Set<string>();
    expect(ed.selectionKeyword?.('all', ids)).toBe(true);
    expect([...ids].sort()).toEqual(['dim-visible', 'line-2d', 'solid-visible']);
    expect(ed.doc.snapshot).toBe(before);
    expect(ed.doc.dirty).toBe(false);
    run('ERASE', 'ALL', '');
    const erased = ed.doc.snapshot;
    expect(ed.doc.entities).toEqual([]);
    expect(model3dOf(erased).solids.map(solid => solid.id)).toEqual(['solid-hidden']);
    expect(model3dOf(erased).dimensions?.map(dimension => dimension.id)).toEqual(['dim-hidden']);
    expect(ed.doc.history().undo).toHaveLength(1);
    expect(ed.doc.dirty).toBe(true);
    ed.doc.undo();
    expect(ed.doc.snapshot).toBe(before);
    ed.doc.redo();
    expect(ed.doc.snapshot).toBe(erased);
    c.viewport = null;
    const twoDIds = new Set<string>();
    expect(ed.selectionKeyword?.('ALL', twoDIds)).toBe(true);
    expect([...twoDIds]).toEqual([]);
  });

  it('an explicit 3D id still permits intentional edits from the 2D view', () => {
    const { ed, c, before, run } = fixture();
    expect(c.active).toBe(false);
    const ids = new Set<string>();
    expect(ed.selectionKeyword?.('DIM-VISIBLE', ids)).toBe(true);
    expect([...ids]).toEqual(['dim-visible']);
    run('ERASE', 'solid-visible', '');
    expect(ed.doc.entities).toEqual(before.entities);
    expect(model3dOf(ed.doc.snapshot).solids.map(solid => solid.id)).toEqual(['solid-hidden']);
    expect(model3dOf(ed.doc.snapshot).dimensions).toEqual(before.model3d!.dimensions);
    expect(ed.doc.dirty).toBe(true);
    expect(ed.doc.history().undo).toHaveLength(1);
    ed.doc.undo();
    expect(ed.doc.snapshot).toBe(before);
  });

  it('a registered 3DMOVE ALL intentionally edits visible 3D objects without opening the viewport', () => {
    const { ed, c, before, run } = fixture();
    run('3DMOVE', 'ALL', '', '0,0,0', '@0,0,2');
    const moved = ed.doc.snapshot;
    expect(c.active).toBe(false);
    expect(c.kernelStarted).toBe(false);
    expect(ed.doc.entities).toEqual(before.entities);
    const solids = model3dOf(moved).solids;
    expect(solids[0]!.mesh.positions.filter((_, index) => index % 3 === 2)).toEqual(before.model3d!.solids[0]!.mesh.positions.filter((_, index) => index % 3 === 2).map(z => z + 2));
    expect(solids[1]).toBe(before.model3d!.solids[1]);
    const dimensions = model3dOf(moved).dimensions!;
    expect(dimensions[0]!.p1.z).toBe(2);
    expect(dimensions[0]!.p2.z).toBe(2);
    expect(dimensions[1]).toBe(before.model3d!.dimensions![1]);
    expect(ed.doc.dirty).toBe(true);
    expect(ed.doc.history().undo).toHaveLength(1);
    ed.doc.undo();
    expect(ed.doc.snapshot).toBe(before);
    ed.doc.redo();
    expect(ed.doc.snapshot).toBe(moved);
    // Finished 3D commands confer no permission on a later generic 2D selection.
    const ids = new Set<string>();
    expect(ed.selectionKeyword?.('ALL', ids)).toBe(true);
    expect([...ids]).toEqual(['line-2d']);
  });
});
