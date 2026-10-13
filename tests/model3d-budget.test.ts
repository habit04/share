/** The 3D triangle budget and its place in the drawing geometry budget (identity caching included). */
import { describe, expect, it, vi } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { GeometryBudgetError } from '../src/core/geometry-budget-error';
import { prepareDrawingState, validateGeometryBudget } from '../src/core/geometry-budget';
import { MAX_MODEL3D_TRIANGLES, MAX_SOLID_TRIANGLES, validateModel3DBudget } from '../src/model3d/budget';
import { addSolids, model3dOf, newSolid, withModel3D } from '../src/model3d/model';
import { boxMesh } from '../src/model3d/primitives';
import type { Mesh3D, } from '../src/model3d/mesh';
import type { Model3D } from '../src/model3d/types';
import * as budget from '../src/model3d/budget';

vi.mock('../src/model3d/budget', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/model3d/budget')>();
  return { ...actual, validateModel3DBudget: vi.fn(actual.validateModel3DBudget) };
});

/** A mesh claiming `triangles` triangles; every index points at the single vertex (budgets only count). */
function heavyMesh(triangles: number): Mesh3D {
  return { positions: [0, 0, 0], indices: new Array<number>(triangles * 3).fill(0) };
}

const feature = { kind: 'mesh', source: 'imported' } as const;

function modelOf(...meshes: Mesh3D[]): Model3D {
  return { version: 1, solids: meshes.map((mesh) => newSolid({ mesh, feature })) };
}

describe('validateModel3DBudget', () => {
  it('accepts drawings without 3D and models within the limits', () => {
    const base = new Drawing().snapshot;
    expect(() => validateModel3DBudget(base)).not.toThrow();
    expect(() => validateModel3DBudget({ ...base, model3d: modelOf(heavyMesh(MAX_SOLID_TRIANGLES)) })).not.toThrow();
  });

  it('rejects a solid over the per-solid limit', () => {
    const base = new Drawing().snapshot;
    expect(() => validateModel3DBudget({ ...base, model3d: modelOf(heavyMesh(MAX_SOLID_TRIANGLES + 1)) })).toThrow(GeometryBudgetError);
    // Vertices cannot exceed what the triangle limit could reference.
    const vertexHeavy = { positions: new Array<number>(9 * MAX_SOLID_TRIANGLES + 3).fill(0), indices: [] };
    expect(() => validateModel3DBudget({ ...base, model3d: modelOf(vertexHeavy) })).toThrow(GeometryBudgetError);
  });

  it('rejects a model over the total limit', () => {
    const base = new Drawing().snapshot;
    const share = heavyMesh(MAX_SOLID_TRIANGLES);
    const count = MAX_MODEL3D_TRIANGLES / MAX_SOLID_TRIANGLES;
    expect(() => validateModel3DBudget({ ...base, model3d: modelOf(...new Array<Mesh3D>(count).fill(share)) })).not.toThrow();
    expect(() => validateModel3DBudget({ ...base, model3d: modelOf(...new Array<Mesh3D>(count).fill(share), boxMesh(1, 1, 1)) })).toThrow(GeometryBudgetError);
  });

  it('rejects a model whose total vertex count exceeds 3 * MAX_MODEL3D_TRIANGLES', () => {
    const base = new Drawing().snapshot;
    // Each solid is within its own limits (no triangles, the per-solid vertex maximum).
    const points: Mesh3D = { positions: new Array<number>(9 * MAX_SOLID_TRIANGLES).fill(0), indices: [] };
    const count = MAX_MODEL3D_TRIANGLES / MAX_SOLID_TRIANGLES;
    expect(() => validateModel3DBudget({ ...base, model3d: modelOf(...new Array<Mesh3D>(count).fill(points)) })).not.toThrow();
    expect(() => validateModel3DBudget({ ...base, model3d: modelOf(...new Array<Mesh3D>(count).fill(points), boxMesh(1, 1, 1)) })).toThrow(GeometryBudgetError);
  });

  it('counts whole triangles and whole vertices, like meshTriangleCount', () => {
    const base = new Drawing().snapshot;
    // Two stray indices beyond the limit do not form a triangle.
    const ragged: Mesh3D = { positions: [0, 0, 0], indices: new Array<number>(3 * MAX_SOLID_TRIANGLES + 2).fill(0) };
    expect(() => validateModel3DBudget({ ...base, model3d: modelOf(ragged) })).not.toThrow();
  });

  it('rejects malformed models with a budget error, not a crash', () => {
    const base = new Drawing().snapshot;
    expect(() => validateModel3DBudget({ ...base, model3d: { version: 1, solids: null } as unknown as Model3D })).toThrow(GeometryBudgetError);
    expect(() => validateModel3DBudget({ ...base, model3d: { version: 1, solids: [{ id: 'x' }] } as unknown as Model3D })).toThrow(GeometryBudgetError);
  });
});

describe('geometry budget integration', () => {
  it('Drawing refuses an over-budget model and leaves the document unchanged', () => {
    expect(() => new Drawing({ model3d: modelOf(heavyMesh(MAX_SOLID_TRIANGLES + 1)) })).toThrow(GeometryBudgetError);
    const doc = new Drawing();
    const before = doc.snapshot;
    expect(() => doc.transact((s) => withModel3D(s, modelOf(heavyMesh(MAX_SOLID_TRIANGLES + 1))))).toThrow(GeometryBudgetError);
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
  });

  it('skips the 3D check when the accepted previous snapshot has the same model', () => {
    const check = vi.mocked(budget.validateModel3DBudget);
    const doc = new Drawing();
    doc.transact((s) => withModel3D(s, addSolids(model3dOf(s), [newSolid({ mesh: boxMesh(1, 1, 1), feature })])));
    check.mockClear();
    doc.setHeader({ ltscale: 3 }); // settings only
    expect(check).not.toHaveBeenCalled();
    doc.addEntities([{ id: 'l1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }]); // 2D only
    expect(check).not.toHaveBeenCalled();
    doc.transact((s) => withModel3D(s, addSolids(model3dOf(s), [newSolid({ mesh: boxMesh(2, 2, 2), feature })]))); // 3D changed
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('a changed model is checked even when 2D geometry is identical', () => {
    const accepted: DrawingState = prepareDrawingState({ ...new Drawing().snapshot });
    const next: DrawingState = { ...accepted, model3d: modelOf(heavyMesh(MAX_SOLID_TRIANGLES + 1)) };
    expect(() => validateGeometryBudget(next, accepted)).toThrow(GeometryBudgetError);
    const same: DrawingState = { ...accepted, currentLayer: 'MISC' };
    expect(() => validateGeometryBudget(same, accepted)).not.toThrow();
  });
});
