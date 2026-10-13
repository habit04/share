/**
 * Rigid and similarity transforms of experimental 3D solids (milestone 4 of docs/3D-PLAN.md),
 * shared by the 3D editing commands (src/tools3d/transform.ts), the 2D MOVE / COPY / ROTATE /
 * SCALE / MIRROR commands when the selection holds solids, and the 3D grips.
 *
 * A transform updates BOTH representations of a solid so they stay consistent:
 * - the mesh, through `transformMesh` (which reverses the winding of a mirror, so the solid stays
 *   outward-facing with a positive volume);
 * - the feature history: primitive frames, profile frames and revolution axes are mapped by the
 *   matrix, sizes scale with it, Boolean operands are transformed recursively and a `mesh`
 *   feature needs nothing (its mesh is the whole story). Re-evaluating a transformed feature
 *   therefore reproduces the transformed mesh (exactly the same vertex set for primitives and
 *   sweeps; a re-run Boolean gives the kernel's result for the moved operands).
 *
 * Only similarity transforms are supported (rotation, translation, uniform scale, reflection):
 * they map orthonormal frames to orthonormal frames up to a common factor. A mirror would make a
 * frame left-handed; every primitive and profile is symmetric about its frame's XZ plane, so the
 * frame's Y axis is reversed (and profile loops are mirrored in Y and re-ordered to keep the outer
 * loop counter-clockwise), which keeps frames right-handed and the geometry identical.
 *
 * All matrices are world (WCS) matrices in the column-major layout of src/model3d/math.ts.
 */
import type { Point } from '../core/geometry';
import type { Entity } from '../core/entities';
import { newId } from '../core/entities';
import {
  type Frame3, type Mat4, type Vec3, cross3, dot3, len3, mat4Determinant, mat4Multiply, mat4RotationAxis, mat4Scaling, mat4Translation,
  normalize3, scale3, sub3, transformDirection, transformPoint, v3,
} from '../model3d/math';
import { transformMesh } from '../model3d/mesh';
import { addSolids, model3dOf, replaceSolid, solidById, withModel3D } from '../model3d/model';
import type { Feature3D, Profile3D, Solid3D } from '../model3d/types';
import type { ToolContext } from '../tools/types';

/** The scale factor and handedness of a similarity matrix. */
export interface Similarity {
  /** Uniform scale factor (> 0). */
  readonly scale: number;
  /** True when the matrix mirrors space (negative determinant). */
  readonly mirror: boolean;
}

/**
 * Analyse `m` as an affine similarity (rotation / reflection times a uniform scale, plus a
 * translation). Throws a RangeError for a projective, singular, shearing or non-uniformly scaling
 * matrix: such a transform cannot be expressed on primitive frames.
 */
export function similarityOf(m: Mat4): Similarity {
  if (m.length !== 16 || !m.every(Number.isFinite)) throw new RangeError('The transform has non-finite values.');
  if (m[3] !== 0 || m[7] !== 0 || m[11] !== 0 || m[15] !== 1) throw new RangeError('The transform is not affine.');
  const cols = [v3(m[0]!, m[1]!, m[2]!), v3(m[4]!, m[5]!, m[6]!), v3(m[8]!, m[9]!, m[10]!)];
  const lens = cols.map(len3);
  const s = (lens[0]! + lens[1]! + lens[2]!) / 3;
  if (!(s > 0) || !Number.isFinite(s)) throw new RangeError('The transform collapses the solid (zero scale).');
  const tol = 1e-9;
  if (lens.some((l) => Math.abs(l - s) > tol * s)) throw new RangeError('Only uniform scaling is supported for 3D solids.');
  const s2 = s * s;
  if (Math.abs(dot3(cols[0]!, cols[1]!)) > tol * s2 || Math.abs(dot3(cols[1]!, cols[2]!)) > tol * s2 || Math.abs(dot3(cols[0]!, cols[2]!)) > tol * s2) {
    throw new RangeError('Shearing transforms are not supported for 3D solids.');
  }
  return { scale: s, mirror: mat4Determinant(m) < 0 };
}

/**
 * The frame mapped by `m` (a similarity): origin transformed, axes rotated and re-orthonormalised
 * (Gram-Schmidt, so repeated edits do not drift). For a mirror the Y axis is reversed so the frame
 * stays right-handed (see the module comment).
 */
export function transformFrame(frame: Frame3, m: Mat4, sim: Similarity = similarityOf(m)): Frame3 {
  const x = normalize3(transformDirection(m, frame.xAxis));
  let y = transformDirection(m, frame.yAxis);
  if (sim.mirror) y = scale3(y, -1);
  y = normalize3(sub3(y, scale3(x, dot3(x, y))));
  return { origin: transformPoint(m, frame.origin), xAxis: x, yAxis: y, zAxis: cross3(x, y) };
}

/** The profile mapped by `m`: frame mapped, loops scaled (and mirrored in Y for a reflection). */
export function transformProfile(profile: Profile3D, m: Mat4, sim: Similarity = similarityOf(m)): Profile3D {
  const s = sim.scale;
  const loops = profile.loops.map((loop) => {
    const pts: Point[] = loop.map((p) => ({ x: p.x * s, y: sim.mirror ? -p.y * s : p.y * s }));
    // Mirroring Y reverses each loop's orientation: reverse the order (keeping the first point) so
    // the outer loop stays counter-clockwise and holes clockwise.
    return sim.mirror && pts.length > 1 ? [pts[0]!, ...pts.slice(1).reverse()] : pts;
  });
  return { frame: transformFrame(profile.frame, m, sim), loops };
}

/** Deepest Boolean nesting transformed feature by feature; deeper (malformed) trees become `mesh`. */
const MAX_TRANSFORM_DEPTH = 256;

/**
 * The feature history mapped by the similarity `m` (see the module comment). A tree that is too
 * deep or contains an unknown kind becomes `{ kind: 'mesh', source: 'edited' }`: its mesh is still
 * transformed, only the (already unusable) history is dropped.
 */
export function transformFeature(feature: Feature3D, m: Mat4, sim: Similarity = similarityOf(m)): Feature3D {
  const edited: Feature3D = { kind: 'mesh', source: 'edited' };
  const walk = (f: Feature3D, depth: number): Feature3D | null => {
    if (depth > MAX_TRANSFORM_DEPTH || !f || typeof f !== 'object') return null;
    const s = sim.scale;
    switch (f.kind) {
      case 'box': case 'wedge':
        return { ...f, frame: transformFrame(f.frame, m, sim), width: f.width * s, depth: f.depth * s, height: f.height * s };
      case 'cylinder':
        return { ...f, frame: transformFrame(f.frame, m, sim), radius: f.radius * s, height: f.height * s };
      case 'cone':
        return { ...f, frame: transformFrame(f.frame, m, sim), baseRadius: f.baseRadius * s, topRadius: f.topRadius * s, height: f.height * s };
      case 'sphere':
        return { ...f, frame: transformFrame(f.frame, m, sim), radius: f.radius * s };
      case 'torus':
        return { ...f, frame: transformFrame(f.frame, m, sim), majorRadius: f.majorRadius * s, minorRadius: f.minorRadius * s };
      case 'extrude':
        return { ...f, profile: transformProfile(f.profile, m, sim), distance: f.distance * s };
      case 'revolve': {
        // A reflection turns a right-handed rotation into a left-handed one: reverse the axis.
        const dir = transformDirection(m, f.axis.dir);
        return { ...f, profile: transformProfile(f.profile, m, sim), axis: { origin: transformPoint(m, f.axis.origin), dir: sim.mirror ? scale3(dir, -1) : dir } };
      }
      case 'boolean': {
        if (!Array.isArray(f.operands)) return null;
        const operands: Feature3D[] = [];
        for (const o of f.operands) {
          const t = walk(o, depth + 1);
          if (!t) return null;
          operands.push(t);
        }
        return { ...f, operands };
      }
      case 'mesh':
        return f;
      default:
        return null;
    }
  };
  return walk(feature, 1) ?? edited;
}

/** The solid with mesh and feature mapped by the similarity `m`; `id` gives it a new id (COPY). */
export function transformSolid(solid: Solid3D, m: Mat4, id?: string): Solid3D {
  const sim = similarityOf(m);
  return { ...solid, id: id ?? solid.id, mesh: transformMesh(solid.mesh, m), feature: transformFeature(solid.feature, m, sim) };
}

// ------------------------------------------------------------------ matrices

/** Translation by `d` (world units). */
export function translationMatrix(d: Vec3): Mat4 {
  return mat4Translation(d.x, d.y, d.z);
}

/** `m` applied about the point `p` instead of the origin: T(p) * m * T(-p). */
export function aboutPoint(m: Mat4, p: Vec3): Mat4 {
  return mat4Multiply(mat4Translation(p.x, p.y, p.z), mat4Multiply(m, mat4Translation(-p.x, -p.y, -p.z)));
}

/** Rotation by `angle` radians about the line through `origin` along `dir` (right-hand rule). */
export function rotationAbout(origin: Vec3, dir: Vec3, angle: number): Mat4 {
  return aboutPoint(mat4RotationAxis(dir, angle), origin);
}

/** Uniform scale by `k` about the point `p`. */
export function scalingAbout(p: Vec3, k: number): Mat4 {
  return aboutPoint(mat4Scaling(k, k, k), p);
}

/** Reflection in the plane through `point` with normal `normal` (need not be unit length). */
export function mirrorAcrossPlane(point: Vec3, normal: Vec3): Mat4 {
  const n = normalize3(normal);
  if (len3(n) === 0) throw new RangeError('The mirror plane needs a direction.');
  const { x, y, z } = n;
  const r: Mat4 = [1 - 2 * x * x, -2 * x * y, -2 * x * z, 0, -2 * x * y, 1 - 2 * y * y, -2 * y * z, 0, -2 * x * z, -2 * y * z, 1 - 2 * z * z, 0, 0, 0, 0, 1];
  return aboutPoint(r, point);
}

/**
 * The 2D MIRROR line a-b as a 3D reflection: the vertical plane (containing the world Z axis
 * direction) through the line on the drawing plane, so a solid is mirrored like the 2D objects.
 */
export function mirrorAcrossLine2d(a: Point, b: Point): Mat4 {
  return mirrorAcrossPlane(v3(a.x, a.y, 0), v3(-(b.y - a.y), b.x - a.x, 0));
}

// ------------------------------------------------------------------ editing the drawing

/** The solids (model space) among `ids`, in selection order; [] in a paper-space layout. */
export function solidsInSelection(ctx: ToolContext, ids: Iterable<string>): Solid3D[] {
  if (ctx.doc.space) return [];
  const model = ctx.solids ? ctx.solids() : model3dOf(ctx.doc.snapshot);
  if (model.solids.length === 0) return [];
  const out: Solid3D[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const s = solidById(model, id);
    if (s) out.push(s);
  }
  return out;
}

/** What one edit changes, applied as a single undo step by `commitSolidEdit`. */
export interface SolidEdit {
  /** Solids to transform (their current state). */
  readonly solids: readonly Solid3D[];
  readonly matrix: Mat4;
  /** Add transformed copies with new ids instead of replacing the solids (COPY, MIRROR). */
  readonly copy?: boolean;
  /** 2D entities to replace by id in the same step (MOVE / ROTATE / SCALE of a mixed selection). */
  readonly replaceEntities?: readonly Entity[];
  /** 2D entities to add in the same step (COPY / MIRROR of a mixed selection), added as given. */
  readonly addEntities?: readonly Entity[];
}

/**
 * Apply an edit as ONE undoable step: transformed solids (replaced in place, or added as copies
 * with fresh ids) together with the 2D replacements and additions. Returns the new solids.
 * Throws RangeError (unsupported transform) or GeometryBudgetError before anything changes.
 */
export function commitSolidEdit(ctx: Pick<ToolContext, 'doc'>, edit: SolidEdit): Solid3D[] {
  const out = edit.solids.map((s) => transformSolid(s, edit.matrix, edit.copy ? newId() : undefined));
  const repl = new Map((edit.replaceEntities ?? []).map((e) => [e.id, e]));
  const adds = edit.addEntities ?? [];
  ctx.doc.transact((st) => {
    let entities = st.entities;
    if (repl.size) entities = entities.map((e) => repl.get(e.id) ?? e);
    if (adds.length) entities = [...entities, ...adds];
    let model = model3dOf(st);
    if (edit.copy) model = addSolids(model, out);
    else for (const s of out) model = replaceSolid(model, s);
    return withModel3D(entities === st.entities ? st : { ...st, entities }, model);
  });
  return out;
}

/**
 * For the 2D modify commands: when `ids` hold solids, apply the edit to them together with the
 * 2D changes in one step and return true; return false (changing nothing) when there are no
 * solids, so the command takes its unchanged 2D path.
 */
export function commitWithSolids(ctx: ToolContext, ids: Iterable<string>, matrix: Mat4, entities: { replace?: readonly Entity[]; add?: readonly Entity[]; copy?: boolean }): boolean {
  const solids = solidsInSelection(ctx, ids);
  if (solids.length === 0) return false;
  try {
    commitSolidEdit(ctx, { solids, matrix, copy: entities.copy, replaceEntities: entities.replace, addEntities: entities.add });
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    ctx.log(`${err.message} The drawing is unchanged.`);
  }
  return true;
}

/** Id suffix of ghost solids drawn while a transform is dragged. */
export const GHOST_SUFFIX = ':ghost';

/** Ghosts of `solids` under `m` (mesh only; never stored). Empty when the matrix is unusable. */
export function ghostSolids(solids: readonly Solid3D[], m: Mat4): Solid3D[] {
  if (!m.every(Number.isFinite) || mat4Determinant(m) === 0) return [];
  return solids.map((s) => ({ ...s, id: s.id + GHOST_SUFFIX, mesh: transformMesh(s.mesh, m) }));
}

/** Show ghosts of the selection's solids under `m` (no-op without solids or a 3D view). */
export function previewSolidsFor(ctx: ToolContext, ids: Iterable<string>, m: Mat4): void {
  if (!ctx.setPreview3d) return;
  const solids = solidsInSelection(ctx, ids);
  if (solids.length) ctx.setPreview3d(ghostSolids(solids, m));
}
