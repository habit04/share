/** Complete value checks for live and parked 3D snapshots; never re-evaluates a feature. */
import type { DrawingState } from '../core/document';
import { isImmutableData } from '../core/immutable-data';
import { GeometryBudgetError } from '../core/geometry-budget-error';
import { resolveDimStyle } from '../core/dimension';
import { MAX_DIMENSIONS3D, MAX_MODEL3D_TRIANGLES, MAX_SOLID_TRIANGLES } from './budget';
import { makeDimension3D, dimension3dSpec } from './dimension3d';
import { MAX_FEATURE_DEPTH, validateFeature, validSolidId } from './file-format';
import { finite3, isOrthonormalFrame } from './math';
import { validateMesh } from './mesh';
import type { Dimension3D, Solid3D } from './types';

const solidsChecked = new WeakSet<Solid3D>(), dimensionsChecked = new WeakSet<Dimension3D>();
const fail = (message: string): never => { throw new GeometryBudgetError(message); };
const named = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024;
const color = (value: unknown): boolean => value === 'ByLayer' || value === 'ByBlock' || Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffff;
const identity = (value: unknown): boolean => value === undefined || named(value);

/** Bound expanded feature validation before its copying parser walks a caller-owned tree. */
function featureWork(feature: Solid3D['feature']): void {
  const pending = [{ feature, depth: 0 }];
  let work = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++work > 1_000_000 || item.depth > MAX_FEATURE_DEPTH) fail('3D feature validation exceeds the safe history budget.');
    if (item.feature?.kind === 'boolean') {
      if (!Array.isArray(item.feature.operands) || item.feature.operands.length !== 2) fail('A 3D Boolean feature needs exactly two operands.');
      for (const child of item.feature.operands) pending.push({ feature: child, depth: item.depth + 1 });
    }
    const profile = item.feature?.kind === 'extrude' || item.feature?.kind === 'revolve' ? item.feature.profile : undefined;
    if (profile && Array.isArray(profile.loops)) for (const loop of profile.loops) {
      if (!Array.isArray(loop) || (work += loop.length) > 1_000_000) fail('3D profile history exceeds the safe validation budget.');
    }
  }
}

export function validateSolid3D(solid: Solid3D): void {
  if (solid && isImmutableData(solid) && solidsChecked.has(solid)) return;
  if (!solid || !validSolidId(solid.id) || !named(solid.layer) || !color(solid.color) || !identity(solid.cadIdentity)) fail('A 3D solid has invalid identity or appearance.');
  if (solid.name !== undefined && (typeof solid.name !== 'string' || solid.name.length > 255 || /[\u0000-\u001f\u007f-\u009f]/.test(solid.name))) fail('A 3D solid has an invalid name.');
  if (!solid.mesh || !Array.isArray(solid.mesh.positions) || !Array.isArray(solid.mesh.indices)) fail('A 3D solid has no valid mesh.');
  if (solid.mesh.indices.length > MAX_SOLID_TRIANGLES * 3 || solid.mesh.positions.length > MAX_SOLID_TRIANGLES * 9) fail('A 3D solid exceeds the safe geometry budget.');
  const problem = validateMesh(solid.mesh);
  if (problem) fail(`Invalid 3D mesh: ${problem}.`);
  if (solid.mesh.indices.length === 0) fail('An empty 3D solid cannot be displayed or saved.');
  featureWork(solid.feature);
  const feature = validateFeature(solid.feature);
  if ('problem' in feature) fail(`Invalid 3D history: ${feature.problem}.`);
  if (isImmutableData(solid)) solidsChecked.add(solid);
}

export function validateDimension3D(dimension: Dimension3D): void {
  if (dimension && isImmutableData(dimension) && dimensionsChecked.has(dimension)) return;
  if (!dimension || !validSolidId(dimension.id) || !named(dimension.layer) || !color(dimension.color) || !identity(dimension.cadIdentity)) fail('A 3D dimension has invalid identity or appearance.');
  if (!['aligned', 'linear', 'angular'].includes(dimension.kind) || !dimension.plane || !dimension.plane.origin || !dimension.plane.xAxis || !dimension.plane.yAxis || !dimension.plane.zAxis || !isOrthonormalFrame(dimension.plane, 1e-6)) fail('A 3D dimension has an invalid measurement plane or kind.');
  if (!dimension.p1 || !dimension.p2 || !finite3(dimension.p1) || !finite3(dimension.p2) || dimension.vertex !== undefined && (!dimension.vertex || !finite3(dimension.vertex)) || !Number.isFinite(dimension.offset)) fail('A 3D dimension has non-finite definition points or offset.');
  if (dimension.axis !== undefined && !['x', 'y'].includes(dimension.axis) || dimension.projected !== undefined && dimension.projected !== true || dimension.textOverride !== undefined && (typeof dimension.textOverride !== 'string' || dimension.textOverride.length > 1_000_000)) fail('A 3D dimension has invalid axis, text or projection data.');
  if (!dimension.style || typeof dimension.style !== 'object' || Object.keys(dimension.style).length > 128 || Object.values(dimension.style).some(value => typeof value === 'number' && !Number.isFinite(value))) fail('A 3D dimension has an invalid style.');
  const style = resolveDimStyle(dimension.style);
  if (![style.textHeight, style.arrowSize, style.extOffset, style.extExtend, style.textGap, style.scale].every(value => Number.isFinite(value) && value >= 0 && Number.isFinite(value * (style.scale || 1)))) fail('A 3D dimension style has invalid sizes.');
  try { makeDimension3D(dimension3dSpec(dimension)); }
  catch (error) { if (error instanceof RangeError) fail(`Invalid 3D dimension: ${error.message}`); throw error; }
  if (isImmutableData(dimension)) dimensionsChecked.add(dimension);
}

export function validateModel3DState(state: DrawingState): void {
  const model = state.model3d;
  if (model === undefined) return;
  if (!model || model.version !== 1 || !Array.isArray(model.solids) || model.dimensions !== undefined && !Array.isArray(model.dimensions)) fail('The 3D model is malformed or has an unsupported version.');
  if ((model.dimensions?.length ?? 0) > MAX_DIMENSIONS3D) fail('The drawing exceeds the safe 3D dimension budget.');
  let triangles = 0, vertices = 0;
  for (const solid of model.solids) {
    validateSolid3D(solid);
    triangles += solid.mesh.indices.length / 3; vertices += solid.mesh.positions.length / 3;
    if (triangles > MAX_MODEL3D_TRIANGLES || vertices > 3 * MAX_MODEL3D_TRIANGLES) fail('The drawing exceeds the safe 3D geometry budget.');
  }
  for (const dimension of model.dimensions ?? []) validateDimension3D(dimension);
}
