/**
 * Resource limits for the experimental 3D model, enforced with the 2D geometry budget whenever a
 * drawing state is prepared (see src/core/geometry-budget.ts). The 2D budget counts expansion work
 * per entity; a mesh's cost is its triangle count, which bounds memory for positions, display
 * buffers and per-triangle work such as picking.
 */
import type { DrawingState } from '../core/document';
import { GeometryBudgetError } from '../core/geometry-budget-error';
import { meshTriangleCount, meshVertexCount } from './mesh';

/** Most triangles one solid may have (a few dense imported parts, or a 256 x 128 sphere many times over). */
export const MAX_SOLID_TRIANGLES = 500_000;
/** Most triangles across every solid of a drawing. */
export const MAX_MODEL3D_TRIANGLES = 2_000_000;

/**
 * Throw a GeometryBudgetError when a solid or the whole model exceeds the triangle limits, or
 * stores more vertices than its triangle limit could reference (3 per triangle: per solid
 * 3 * MAX_SOLID_TRIANGLES, in total 3 * MAX_MODEL3D_TRIANGLES), so positions cannot grow without
 * bound behind a small triangle count. Counts use `meshTriangleCount` / `meshVertexCount` (whole
 * triangles / xyz triples). A missing `model3d` costs nothing. Structural validity (index ranges,
 * finiteness) is the producer's job (`validateMesh`); this check is O(number of solids) so it can
 * run on every prepared state.
 */
export function validateModel3DBudget(state: DrawingState): void {
  const model = state.model3d;
  if (model === undefined) return;
  if (!model || !Array.isArray(model.solids)) throw new GeometryBudgetError('The 3D model is malformed.');
  let triangles = 0, vertices = 0;
  for (const solid of model.solids) {
    const mesh = solid?.mesh;
    if (!mesh || !Array.isArray(mesh.indices) || !Array.isArray(mesh.positions)) throw new GeometryBudgetError('A 3D solid has no valid mesh.');
    const t = meshTriangleCount(mesh), v = meshVertexCount(mesh);
    if (t > MAX_SOLID_TRIANGLES || v > 3 * MAX_SOLID_TRIANGLES) {
      throw new GeometryBudgetError(`A 3D solid has ${t.toLocaleString('en-US')} triangles and ${v.toLocaleString('en-US')} vertices; the safe limit is ${MAX_SOLID_TRIANGLES.toLocaleString('en-US')} triangles per solid.`);
    }
    triangles += t;
    vertices += v;
    if (triangles > MAX_MODEL3D_TRIANGLES || vertices > 3 * MAX_MODEL3D_TRIANGLES) {
      throw new GeometryBudgetError(`The 3D model exceeds the safe limit of ${MAX_MODEL3D_TRIANGLES.toLocaleString('en-US')} triangles.`);
    }
  }
}
