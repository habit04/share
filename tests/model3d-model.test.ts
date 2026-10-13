/** The 3D model inside DrawingState: pure helpers, sealing through Drawing, undo / redo. */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { isImmutableData } from '../src/core/immutable-data';
import { WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import {
  EMPTY_MODEL3D, addSolids, hasSolids, model3dBounds, model3dOf, newSolid, removeSolids, replaceSolid, solidById, withModel3D,
} from '../src/model3d/model';
import { primitiveMesh } from '../src/model3d/primitives';
import type { BoxFeature, Model3D, Solid3D } from '../src/model3d/types';

function box(x: number, id?: string): Solid3D {
  const feature: BoxFeature = { kind: 'box', frame: { ...WORLD_XY_FRAME, origin: v3(x, 0, 0) }, width: 1, depth: 1, height: 1 };
  return newSolid({ id, mesh: primitiveMesh(feature), feature });
}

describe('model helpers', () => {
  it('newSolid assigns fresh ids and defaults', () => {
    const a = box(0), b = box(0);
    expect(a.id).not.toBe(b.id);
    expect(a.layer).toBe('0');
    expect(a.color).toBe('ByLayer');
    expect('name' in a).toBe(false);
    const named = newSolid({ mesh: a.mesh, feature: a.feature, layer: 'SYMS', color: 3, name: 'Part', id: 'p1' });
    expect(named).toMatchObject({ id: 'p1', layer: 'SYMS', color: 3, name: 'Part' });
  });

  it('add / remove / replace keep ids and order and never mutate the input', () => {
    const a = box(0, 'a'), b = box(2, 'b'), c = box(4, 'c');
    const m1 = addSolids(EMPTY_MODEL3D, [a, b]);
    const m2 = addSolids(m1, [c]);
    expect(m2.solids.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(m1.solids.map((s) => s.id)).toEqual(['a', 'b']);
    expect(EMPTY_MODEL3D.solids).toHaveLength(0);
    expect(addSolids(m2, [])).toBe(m2);
    expect(() => addSolids(m2, [box(9, 'b')])).toThrow(/already in use/);
    expect(() => addSolids(EMPTY_MODEL3D, [box(0, 'x'), box(1, 'x')])).toThrow(/already in use/);

    const b2 = { ...b, color: 5 };
    const m3 = replaceSolid(m2, b2);
    expect(m3.solids.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(solidById(m3, 'b')).toBe(b2);
    expect(solidById(m2, 'b')).toBe(b);
    expect(replaceSolid(m2, b)).toBe(m2);
    expect(replaceSolid(m2, box(0, 'zz'))).toBe(m2);

    const m4 = removeSolids(m3, ['a', 'missing']);
    expect(m4.solids.map((s) => s.id)).toEqual(['b', 'c']);
    expect(solidById(m4, 'c')).toBe(c);
    expect(removeSolids(m4, ['missing'])).toBe(m4);
    expect(removeSolids(m4, [])).toBe(m4);
    expect(solidById(m4, 'a')).toBeUndefined();
  });

  it('bounds cover every solid', () => {
    expect(model3dBounds(EMPTY_MODEL3D)).toBeNull();
    const m = addSolids(EMPTY_MODEL3D, [box(0), box(10)]);
    expect(model3dBounds(m)).toEqual({ min: v3(-0.5, -0.5, 0), max: v3(10.5, 0.5, 1) });
  });

  it('withModel3D adds the field and an empty model removes it again', () => {
    const plain = new Drawing().snapshot;
    expect('model3d' in plain).toBe(false);
    expect(hasSolids(plain)).toBe(false);
    expect(model3dOf(plain)).toBe(EMPTY_MODEL3D);
    expect(withModel3D(plain, EMPTY_MODEL3D)).toBe(plain);
    const model = addSolids(EMPTY_MODEL3D, [box(0)]);
    const with3d = withModel3D(plain, model);
    expect(with3d.model3d).toBe(model);
    expect(hasSolids(with3d)).toBe(true);
    expect(withModel3D(with3d, model)).toBe(with3d);
    const back = withModel3D(with3d, removeSolids(model, [model.solids[0]!.id]));
    expect('model3d' in back).toBe(false);
    expect(back.entities).toBe(plain.entities);
  });
});

describe('Drawing with a 3D model', () => {
  it('new Drawing({ model3d }) keeps and seals the model', () => {
    const model: Model3D = { version: 1, solids: [box(0, 's1')] };
    const doc = new Drawing({ model3d: model });
    expect(doc.snapshot.model3d).toBe(model);
    expect(isImmutableData(model)).toBe(true);
    expect(Object.isFrozen(model.solids[0]!.mesh.positions)).toBe(true);
    expect(Object.isFrozen(model.solids[0]!.feature)).toBe(true);
    expect(() => { (model.solids as Solid3D[]).push(box(1)); }).toThrow(TypeError);
  });

  it('undo / redo restore solids like geometry', () => {
    const doc = new Drawing();
    const first = box(0, 'first');
    doc.transact((s) => withModel3D(s, addSolids(model3dOf(s), [first])));
    const afterAdd = doc.snapshot;
    doc.transact((s) => withModel3D(s, replaceSolid(model3dOf(s), { ...first, layer: 'MISC' })));
    expect(solidById(model3dOf(doc.snapshot), 'first')!.layer).toBe('MISC');
    doc.transact((s) => withModel3D(s, removeSolids(model3dOf(s), ['first'])));
    expect(hasSolids(doc.snapshot)).toBe(false);

    expect(doc.undo()).toBe(true);
    expect(solidById(model3dOf(doc.snapshot), 'first')!.layer).toBe('MISC');
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot).toBe(afterAdd);
    expect(solidById(model3dOf(doc.snapshot), 'first')).toBe(first);
    expect(doc.undo()).toBe(true);
    expect(hasSolids(doc.snapshot)).toBe(false);
    expect(doc.redo()).toBe(true);
    expect(doc.snapshot).toBe(afterAdd);
  });

  it('settings outside the history keep the 3D model of every state', () => {
    const doc = new Drawing();
    doc.transact((s) => withModel3D(s, addSolids(model3dOf(s), [box(0, 'kept')])));
    const model = doc.snapshot.model3d;
    doc.setHeader({ ltscale: 2 });
    expect(doc.snapshot.model3d).toBe(model);
    doc.undo();
    expect(doc.snapshot.header?.ltscale).toBe(2);
    expect(hasSolids(doc.snapshot)).toBe(false);
    doc.redo();
    expect(doc.snapshot.model3d).toBe(model);
  });
});
