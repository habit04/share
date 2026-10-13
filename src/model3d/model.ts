/**
 * Pure helpers over `DrawingState.model3d`. Every function returns new objects (or the input
 * unchanged when nothing changes, so identity checks and the geometry-budget cache keep working)
 * and never mutates sealed state. Solid ids are stable: adding, replacing and removing solids
 * never renumbers the others.
 */
import type { DrawingState } from '../core/document';
import { newId } from '../core/entities';
import { sealImmutableData } from '../core/immutable-data';
import { type Aabb, aabbUnion } from './math';
import { meshBounds, meshTriangleCount } from './mesh';
import type { Model3D, Solid3D } from './types';

/**
 * Throw an Error when a solid has no triangles. An empty solid has nothing to show, pick or save
 * (a polyface record without faces is not valid DXF), so the model never holds one: a command
 * whose result is empty removes the solid instead.
 */
export function assertSolidNotEmpty(solid: Pick<Solid3D, 'id' | 'mesh'>): void {
  if (meshTriangleCount(solid.mesh) === 0) throw new Error(`3D solid ${solid.id} has no triangles; an empty solid cannot be stored.`);
}

/** The empty model (sealed, shared): what a drawing without 3D content behaves like. */
export const EMPTY_MODEL3D: Model3D = sealImmutableData<Model3D>({ version: 1, solids: [] });

/** The drawing's 3D model, or EMPTY_MODEL3D when it has none. */
export function model3dOf(state: DrawingState): Model3D {
  return state.model3d ?? EMPTY_MODEL3D;
}

/** True when the drawing holds at least one solid (what save warnings and the 3D view key on). */
export function hasSolids(state: DrawingState): boolean {
  return (state.model3d?.solids.length ?? 0) > 0;
}

/**
 * The state with `model` as its 3D model. An empty model removes the field instead, so a drawing
 * whose last solid was deleted has exactly the shape of a plain 2D drawing again. Returns `state`
 * itself when nothing changes.
 */
export function withModel3D(state: DrawingState, model: Model3D): DrawingState {
  if (model.solids.length === 0) {
    if (state.model3d === undefined) return state;
    const { model3d: _drop, ...rest } = state;
    return rest;
  }
  return state.model3d === model ? state : { ...state, model3d: model };
}

/**
 * The model with `solids` appended in order. Throws an Error when an id is already used (in the
 * model or twice in `solids`): ids identify solids across undo states and selections, so a
 * duplicate is a programming error rather than something to repair silently. An empty solid
 * (no triangles) throws too (`assertSolidNotEmpty`).
 */
export function addSolids(model: Model3D, solids: readonly Solid3D[]): Model3D {
  if (solids.length === 0) return model;
  const ids = new Set(model.solids.map((s) => s.id));
  for (const s of solids) {
    assertSolidNotEmpty(s);
    if (ids.has(s.id)) throw new Error(`3D solid id ${s.id} is already in use.`);
    ids.add(s.id);
  }
  return { ...model, solids: [...model.solids, ...solids] };
}

/** The model without the solids whose ids are listed; the same model when none of them exist. */
export function removeSolids(model: Model3D, ids: Iterable<string>): Model3D {
  const drop = new Set(ids);
  if (drop.size === 0) return model;
  const solids = model.solids.filter((s) => !drop.has(s.id));
  return solids.length === model.solids.length ? model : { ...model, solids };
}

/**
 * The model with the solid of the same id replaced in place (order kept). Returns the model
 * unchanged when no solid has that id or the replacement is the same object. Throws an Error
 * when the replacement has no triangles (`assertSolidNotEmpty`).
 */
export function replaceSolid(model: Model3D, solid: Solid3D): Model3D {
  const i = model.solids.findIndex((s) => s.id === solid.id);
  if (i < 0 || model.solids[i] === solid) return model;
  assertSolidNotEmpty(solid);
  const solids = [...model.solids];
  solids[i] = solid;
  return { ...model, solids };
}

/** The solid with this id, if any. */
export function solidById(model: Model3D, id: string): Solid3D | undefined {
  return model.solids.find((s) => s.id === id);
}

/** World-space bounding box of every solid's mesh (drawing units), or null for an empty model. */
export function model3dBounds(model: Model3D): Aabb | null {
  let box: Aabb | null = null;
  for (const s of model.solids) box = aabbUnion(box, meshBounds(s.mesh));
  return box;
}

/** What `newSolid` needs: the geometry and history, optionally an id, layer, colour and name. */
export type NewSolidInput = Pick<Solid3D, 'mesh' | 'feature'> & Partial<Pick<Solid3D, 'id' | 'layer' | 'color' | 'name'>>;

/**
 * A new solid with a fresh `newId()` id unless one is given, layer '0' and colour ByLayer by
 * default. An absent `name` is left out entirely (no `name: undefined` key). Throws an Error for
 * a mesh without triangles (`assertSolidNotEmpty`).
 */
export function newSolid(partial: NewSolidInput): Solid3D {
  const id = partial.id ?? newId();
  assertSolidNotEmpty({ id, mesh: partial.mesh });
  const solid: Solid3D = {
    id,
    layer: partial.layer ?? '0',
    color: partial.color ?? 'ByLayer',
    mesh: partial.mesh,
    feature: partial.feature,
  };
  return partial.name === undefined ? solid : { ...solid, name: partial.name };
}
