/**
 * Milestone 4 transforms: the pure solid / feature transforms (src/tools3d/solid-edit.ts), the
 * 3DMOVE / 3DROTATE / 3DSCALE prompts (src/tools3d/transform.ts), the 2D MOVE / COPY / ROTATE /
 * SCALE / MIRROR commands on mixed 2D + 3D selections, and the docs/3D-EDITING.md replay through a
 * real Editor (flag on, 3D mode off).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity, LineEntity } from '../src/core/entities';
import {
  type Frame3, type Mat4, WORLD_XY_FRAME, isOrthonormalFrame, mat4Multiply, mat4Scaling, v3,
} from '../src/model3d/math';
import { type Mesh3D, meshBounds, meshIsClosed, meshVertex, meshVertexCount, meshVolume } from '../src/model3d/mesh';
import { addSolids, model3dOf, newSolid } from '../src/model3d/model';
import { primitiveMesh } from '../src/model3d/primitives';
import { evaluateFeature } from '../src/model3d/feature-eval';
import type { Feature3D, PrimitiveFeature, Profile3D, Solid3D } from '../src/model3d/types';
import {
  aboutPoint, commitWithSolids, ghostSolids, mirrorAcrossLine2d, mirrorAcrossPlane, rotationAbout, scalingAbout, similarityOf, transformFeature,
  transformSolid, translationMatrix,
} from '../src/tools3d/solid-edit';
import { angleAboutAxis, axisThrough, move3dTool, planeAxis, resetTransformDefaults, rotate3dTool, scale3dTool } from '../src/tools3d/transform';
import { evaluateLocal } from '../src/tools3d/properties-edit';
import { axesFrame } from '../src/tools3d/context';
import { CopyTool, MoveTool, RotateTool } from '../src/tools/modify';
import { MirrorTool, ScaleTool } from '../src/tools/edit';
import { drive } from './fake-context';
import { directKernel, drive3d, fake3dContext } from './helpers/context3d';
import type { Editor as EditorType } from '../src/app/editor';
import type { installExperimental3d as InstallType } from '../src/app/experimental-3d';
import { RIBBON } from '../src/ui/ribbon';
import { resetModellingDefaults } from '../src/tools3d/primitives';

// ------------------------------------------------------------------ helpers

const at = (x: number, y: number, z = 0): Frame3 => ({ ...WORLD_XY_FRAME, origin: v3(x, y, z) });

/** A box spanning x0..x0+w, y0..y0+d, z0..z0+h. */
function boxFeature(x0: number, y0: number, z0: number, w: number, d: number, h: number): PrimitiveFeature {
  return { kind: 'box', frame: at(x0 + w / 2, y0 + d / 2, z0), width: w, depth: d, height: h };
}

function solidOf(feature: Feature3D, mesh: Mesh3D = evaluateLocal(feature), id?: string): Solid3D {
  return newSolid({ id, mesh, feature });
}

function docWith(...solids: Solid3D[]): Drawing {
  const doc = new Drawing();
  doc.updateModel3D((m) => addSolids(m, solids));
  return doc;
}

const solidsIn = (doc: Drawing) => model3dOf(doc.snapshot).solids;
const solid = (doc: Drawing, id: string) => solidsIn(doc).find((s) => s.id === id)!;

/** Every vertex of `a` has a vertex of `b` within `tol` and vice versa (same counts). */
function sameVertexSet(a: Mesh3D, b: Mesh3D, tol = 1e-6): boolean {
  if (meshVertexCount(a) !== meshVertexCount(b)) return false;
  const near = (m: Mesh3D, p: { x: number; y: number; z: number }) => {
    for (let i = 0; i < meshVertexCount(m); i++) {
      const q = meshVertex(m, i);
      if (Math.abs(q.x - p.x) <= tol && Math.abs(q.y - p.y) <= tol && Math.abs(q.z - p.z) <= tol) return true;
    }
    return false;
  };
  for (let i = 0; i < meshVertexCount(a); i++) if (!near(b, meshVertex(a, i))) return false;
  for (let i = 0; i < meshVertexCount(b); i++) if (!near(a, meshVertex(b, i))) return false;
  return true;
}

function maxPositionDiff(a: Mesh3D, b: Mesh3D): number {
  if (a.positions.length !== b.positions.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.positions.length; i++) d = Math.max(d, Math.abs(a.positions[i]! - b.positions[i]!));
  return d;
}

const RECT_WITH_HOLE: Profile3D = {
  frame: WORLD_XY_FRAME,
  loops: [
    [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }],
    [{ x: 1, y: 1 }, { x: 1, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 1 }],
  ],
};
const REV_PROFILE: Profile3D = { frame: WORLD_XY_FRAME, loops: [[{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 2.5, y: 3 }, { x: 1, y: 3 }]] };

const FEATURES: Array<[string, Feature3D]> = [
  ['box', boxFeature(-1, 2, 3, 4, 2, 1.5)],
  ['wedge', { kind: 'wedge', frame: at(1, 1, 0), width: 4, depth: 3, height: 2 }],
  ['cylinder', { kind: 'cylinder', frame: at(0, 0, 1), radius: 2, height: 3 }],
  ['cylinder (7 segments)', { kind: 'cylinder', frame: at(2, 0, 0), radius: 1, height: 2, segments: 7 }],
  ['cone frustum', { kind: 'cone', frame: at(0, 3, 0), baseRadius: 2, topRadius: 0.5, height: 3, segments: 9 }],
  ['sphere', { kind: 'sphere', frame: at(4, 4, 4), radius: 1.5, segments: 12, rings: 7 }],
  ['torus', { kind: 'torus', frame: at(-3, 0, 2), majorRadius: 3, minorRadius: 0.5, segments: 11, rings: 5 }],
  ['extrude with hole', { kind: 'extrude', profile: RECT_WITH_HOLE, distance: 2 }],
  ['extrude downward', { kind: 'extrude', profile: RECT_WITH_HOLE, distance: -1.5 }],
  ['revolve half turn', { kind: 'revolve', profile: REV_PROFILE, axis: { origin: v3(0, 0, 0), dir: v3(0, 1, 0) }, angle: Math.PI, segments: 12 }],
  ['revolve full turn', { kind: 'revolve', profile: REV_PROFILE, axis: { origin: v3(0, 0, 0), dir: v3(0, 2, 0) }, angle: 2 * Math.PI, segments: 10 }],
];

const MATRICES: Array<[string, Mat4, number]> = [
  ['translation', translationMatrix(v3(3, -2, 7)), 1],
  ['rotation about a skew axis', rotationAbout(v3(1, 2, 3), v3(1, 1, 0.5), 0.7), 1],
  ['uniform scale 2.5', scalingAbout(v3(2, 0, 1), 2.5), 2.5],
  ['mirror in a skew plane', mirrorAcrossPlane(v3(1, 0, 0), v3(1, 2, 3)), 1],
  ['mirror and scale 0.5', mat4Multiply(mirrorAcrossPlane(v3(0, 1, 0), v3(0, 0, 1)), scalingAbout(v3(0, 0, 0), 0.5)), 0.5],
  ['2D mirror line', mirrorAcrossLine2d({ x: 0, y: -1 }, { x: 3, y: 2 }), 1],
];

// ------------------------------------------------------------------ pure transforms

describe('transformSolid / transformFeature', () => {
  for (const [fname, feature] of FEATURES) {
    for (const [mname, m, k] of MATRICES) {
      it(`${fname} under ${mname}: volume, closedness and re-evaluated feature agree`, () => {
        const s = solidOf(feature);
        const t = transformSolid(s, m);
        expect(t.id).toBe(s.id);
        expect(meshIsClosed(t.mesh)).toBe(true);
        const v0 = meshVolume(s.mesh), v1 = meshVolume(t.mesh);
        expect(v1).toBeGreaterThan(0);
        expect(Math.abs(Math.abs(v1) - Math.abs(v0) * k ** 3)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v0) * k ** 3));
        const again = evaluateLocal(t.feature);
        expect(sameVertexSet(again, t.mesh, 1e-6)).toBe(true);
        expect(Math.abs(meshVolume(again) - v1)).toBeLessThanOrEqual(1e-6 * Math.max(1, v1));
        if (!similarityOf(m).mirror) expect(maxPositionDiff(again, t.mesh)).toBeLessThanOrEqual(1e-6);
        if ('frame' in t.feature) expect(isOrthonormalFrame(t.feature.frame)).toBe(true);
        if (t.feature.kind === 'extrude' || t.feature.kind === 'revolve') expect(isOrthonormalFrame(t.feature.profile.frame)).toBe(true);
      });
    }
  }

  it('transforms Boolean operands recursively; the kernel re-run matches the moved mesh', async () => {
    const kernel = directKernel();
    const a = boxFeature(0, 0, 0, 2, 2, 2), b = boxFeature(1, 0, 0, 2, 2, 2);
    const feature: Feature3D = { kind: 'boolean', op: 'union', operands: [a, b] };
    const mesh = await evaluateFeature(feature, kernel);
    const s = solidOf(feature, mesh);
    for (const [, m, k] of MATRICES) {
      const t = transformSolid(s, m);
      expect(t.feature.kind).toBe('boolean');
      const again = await evaluateFeature(t.feature, kernel);
      // The kernel works in single-precision-like tolerances: compare to 1e-6.
      expect(meshVolume(again)).toBeCloseTo(12 * k ** 3, 6);
      expect(Math.abs(meshVolume(t.mesh) - meshVolume(s.mesh) * k ** 3)).toBeLessThan(1e-9);
      const b1 = meshBounds(again)!, b2 = meshBounds(t.mesh)!;
      for (const ax of ['x', 'y', 'z'] as const) {
        expect(b1.min[ax]).toBeCloseTo(b2.min[ax], 6);
        expect(b1.max[ax]).toBeCloseTo(b2.max[ax], 6);
      }
    }
  });

  it('keeps mesh features as they are and turns malformed histories into edited meshes', () => {
    const mesh = primitiveMesh(boxFeature(0, 0, 0, 1, 1, 1));
    expect(transformFeature({ kind: 'mesh', source: 'imported' }, translationMatrix(v3(1, 0, 0)))).toEqual({ kind: 'mesh', source: 'imported' });
    const bogus = { kind: 'blob' } as unknown as Feature3D;
    expect(transformFeature(bogus, translationMatrix(v3(1, 0, 0)))).toEqual({ kind: 'mesh', source: 'edited' });
    const t = transformSolid(solidOf({ kind: 'mesh', source: 'imported' }, mesh), translationMatrix(v3(1, 0, 0)));
    expect(meshBounds(t.mesh)!.min.x).toBeCloseTo(1, 12);
  });

  it('refuses transforms that are not similarities', () => {
    expect(() => similarityOf(mat4Scaling(1, 2, 1))).toThrow(/uniform/);
    expect(() => similarityOf(mat4Scaling(0, 0, 0))).toThrow(RangeError);
    const shear: Mat4 = [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(() => similarityOf(shear)).toThrow(RangeError);
    const proj: Mat4 = [1, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(() => similarityOf(proj)).toThrow(/affine/);
    expect(() => transformSolid(solidOf(boxFeature(0, 0, 0, 1, 1, 1)), mat4Scaling(1, 2, 1))).toThrow(RangeError);
    expect(() => mirrorAcrossPlane(v3(0, 0, 0), v3(0, 0, 0))).toThrow(RangeError);
  });

  it('ghosts transform the mesh only, under a ghost id', () => {
    const s = solidOf(boxFeature(0, 0, 0, 1, 1, 1));
    const [g] = ghostSolids([s], translationMatrix(v3(0, 0, 5)));
    expect(g!.id).not.toBe(s.id);
    expect(meshBounds(g!.mesh)!.min.z).toBeCloseTo(5, 12);
    expect(g!.feature).toBe(s.feature);
    expect(ghostSolids([s], mat4Scaling(0, 0, 0))).toEqual([]);
  });

  it('rotation helpers: axis angles follow the right-hand rule', () => {
    const z = planeAxis(WORLD_XY_FRAME, 'Z', v3(0, 0, 0));
    expect(angleAboutAxis(z, v3(0, 1, 0))).toBeCloseTo(Math.PI / 2, 12);
    expect(angleAboutAxis(z, v3(0, 0, 3))).toBeNull();
    const x = planeAxis(WORLD_XY_FRAME, 'X', v3(0, 0, 0));
    expect(angleAboutAxis(x, v3(0, 0, 1))).toBeCloseTo(Math.PI / 2, 12);
    const y = planeAxis(WORLD_XY_FRAME, 'Y', v3(0, 0, 0));
    expect(angleAboutAxis(y, v3(1, 0, 0))).toBeCloseTo(Math.PI / 2, 12);
    expect(axisThrough(v3(1, 1, 1), v3(1, 1, 1))).toBeNull();
    const a = axisThrough(v3(0, 0, 0), v3(0, 0, 5))!;
    expect(a.dir).toEqual(v3(0, 0, 1));
    expect(aboutPoint(mat4Scaling(1, 1, 1), v3(3, 4, 5))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });
});

// ------------------------------------------------------------------ 3D commands

describe('3DMOVE', () => {
  beforeEach(resetTransformDefaults);

  it('moves by a base point and a typed relative second point, with a ghost, as one undo step', async () => {
    const s = solidOf(boxFeature(0, 0, 0, 10, 10, 5));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    await drive3d(move3dTool(), ctx, [{ select: [s.id] }, '0,0,0', { move: { x: 4, y: 0 } }, '@20,0,3']);
    expect(ctx.previews.length).toBeGreaterThan(0);
    expect(meshBounds(ctx.previews.at(-1)![0]!.mesh)!.min.x).toBeCloseTo(4, 9);
    const m = solid(doc, s.id);
    expect(meshBounds(m.mesh)).toEqual({ min: v3(20, 0, 3), max: v3(30, 10, 8) });
    expect(sameVertexSet(evaluateLocal(m.feature), m.mesh)).toBe(true);
    expect(ctx.logs).toContain('3DMOVE: 1 solid moved.');
    expect(ctx.preview3d).toEqual([]);
    doc.undo();
    expect(solid(doc, s.id)).toBe(s);
  });

  it('Displacement option and Enter (base point as displacement)', async () => {
    const s = solidOf(boxFeature(0, 0, 0, 1, 1, 1));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    await drive3d(move3dTool(), ctx, [{ select: [s.id] }, 'D', '1,2,3']);
    expect(meshBounds(solid(doc, s.id).mesh)!.min).toEqual(v3(1, 2, 3));
    expect(ctx.prompts).toContain('Specify displacement <0.0000,0.0000,0.0000>:');
    // Enter at the displacement prompt repeats the last displacement.
    await drive3d(move3dTool(), ctx, [{ select: [s.id] }, '', '']);
    expect(meshBounds(solid(doc, s.id).mesh)!.min).toEqual(v3(2, 4, 6));
    await drive3d(move3dTool(), ctx, [{ select: [s.id] }, '0,0,-1', '']);
    expect(meshBounds(solid(doc, s.id).mesh)!.min).toEqual(v3(2, 4, 5));
  });

  it('works on a construction plane (plane coordinates) and reports ignored 2D objects', async () => {
    const s = solidOf(boxFeature(0, 0, 0, 1, 1, 1));
    const doc = docWith(s);
    doc.addEntities([{ id: 'L1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
    const ctx = fake3dContext(doc, { plane: axesFrame('XZ') });
    await drive3d(move3dTool(), ctx, [{ select: ['L1', s.id] }, 'D', '0,0,2']);
    // XZ plane: its Z axis is world -Y.
    expect(meshBounds(solid(doc, s.id).mesh)!.min).toEqual(v3(0, -2, 0));
    expect(ctx.logs).toContain('1 object is not a 3D solid and was ignored.');
    expect(doc.entities[0]).toMatchObject({ a: { x: 0, y: 0 } });
  });

  it('refuses selections without solids and zero displacements', async () => {
    const s = solidOf(boxFeature(0, 0, 0, 1, 1, 1));
    const doc = docWith(s);
    doc.addEntities([{ id: 'L1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
    const ctx = fake3dContext(doc);
    await drive3d(move3dTool(), ctx, [{ select: ['L1'] }]);
    expect(ctx.logs).toContain('3DMOVE: no 3D solids selected.');
    const before = doc.snapshot;
    await drive3d(move3dTool(), ctx, [{ select: [s.id] }, '1,1,1', '1,1,1']);
    expect(ctx.logs).toContain('3DMOVE: zero displacement; nothing moved.');
    expect(doc.snapshot).toBe(before);
  });
});

describe('3DROTATE', () => {
  beforeEach(resetTransformDefaults);

  it('rotates 90 degrees about the plane Z axis through the base point (Enter = Z)', async () => {
    const s = solidOf(boxFeature(20, 0, 0, 10, 10, 5));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    await drive3d(rotate3dTool(), ctx, [{ select: [s.id] }, '20,0,0', '', { move: { x: 20, y: 5 } }, '90']);
    const b = meshBounds(solid(doc, s.id).mesh)!;
    expect(b.min.x).toBeCloseTo(10, 9);
    expect(b.max.x).toBeCloseTo(20, 9);
    expect(b.min.y).toBeCloseTo(0, 9);
    expect(b.max.y).toBeCloseTo(10, 9);
    expect(meshVolume(solid(doc, s.id).mesh)).toBeCloseTo(500, 9);
    expect(ctx.previews.length).toBeGreaterThan(0);
    const m = solid(doc, s.id);
    expect(maxPositionDiff(evaluateLocal(m.feature), m.mesh)).toBeLessThan(1e-9);
  });

  it('X / Y axes, two-point axes, picked angles and Reference', async () => {
    const s = solidOf(boxFeature(0, 0, 0, 10, 10, 5));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    // +90 about X through the origin: y 0..10 -> z 0..10, z 0..5 -> y -5..0.
    await drive3d(rotate3dTool(), ctx, [{ select: [s.id] }, '0,0,0', 'X', '90']);
    let b = meshBounds(solid(doc, s.id).mesh)!;
    expect(b.min.y).toBeCloseTo(-5, 9);
    expect(b.max.z).toBeCloseTo(10, 9);
    doc.undo();
    // Y axis, angle by a picked (typed) point: the point (0,0,-1) is +90 about Y from +Z... (zero direction = plane Z).
    await drive3d(rotate3dTool(), ctx, [{ select: [s.id] }, '0,0,0', 'Y', '1,0,0']);
    b = meshBounds(solid(doc, s.id).mesh)!;
    // +90 about Y: x -> -z, z -> x.
    expect(b.min.z).toBeCloseTo(-10, 9);
    expect(b.max.x).toBeCloseTo(5, 9);
    doc.undo();
    // Two points: the axis along +Z through (10,10,0); Reference 0, new angle 180.
    await drive3d(rotate3dTool(), ctx, [{ select: [s.id] }, '0,0,0', '2P', '10,10,0', '10,10,1', 'R', '0', '180']);
    b = meshBounds(solid(doc, s.id).mesh)!;
    expect(b.min.x).toBeCloseTo(10, 9);
    expect(b.max.x).toBeCloseTo(20, 9);
    expect(b.min.y).toBeCloseTo(10, 9);
    doc.undo();
    // Reference by two points (direction 45 deg) and a new angle by Points (direction 135 deg): +90.
    await drive3d(rotate3dTool(), ctx, [{ select: [s.id] }, '0,0,0', 'Z', 'R', '0,0,0', '1,1,0', 'P', '0,0,0', '-1,1,0']);
    b = meshBounds(solid(doc, s.id).mesh)!;
    expect(b.min.x).toBeCloseTo(-10, 9);
    expect(b.max.y).toBeCloseTo(10, 9);
    expect(ctx.logs).toContain('Rotation angle: 90.0000 degrees.');
  });

  it('reports zero rotations, undefined angles and coincident axis points', async () => {
    const s = solidOf(boxFeature(0, 0, 0, 1, 1, 1));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    await drive3d(rotate3dTool(), ctx, [{ select: [s.id] }, '0,0,0', '', '360']);
    expect(ctx.logs).toContain('3DROTATE: zero rotation; nothing changed.');
    await drive3d(rotate3dTool(), ctx, [{ select: [s.id] }, '0,0,0', '2P', '1,1,1', '1,1,1', '', '0,0,5', '45']);
    expect(ctx.logs).toContain('The axis points coincide; specify two different points.');
    expect(ctx.logs).toContain('The point lies on the rotation axis; pick another point or type an angle.');
    expect(meshVolume(solid(doc, s.id).mesh)).toBeCloseTo(1, 9);
    expect(ctx.logs).toContain('3DROTATE: 1 solid rotated.');
  });
});

describe('3DSCALE', () => {
  beforeEach(resetTransformDefaults);

  it('scales by a factor, a picked point and Reference; refuses non-positive factors', async () => {
    const s = solidOf(boxFeature(0, 0, 0, 10, 10, 5));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    await drive3d(scale3dTool(), ctx, [{ select: [s.id] }, '0,0,0', '0', '-1', { move: { x: 3, y: 0 } }, '2']);
    expect(ctx.logs.filter((l) => l.startsWith('Value must be positive'))).toHaveLength(2);
    expect(ctx.previews.length).toBeGreaterThan(0);
    expect(meshVolume(solid(doc, s.id).mesh)).toBeCloseTo(4000, 6);
    expect(solid(doc, s.id).feature).toMatchObject({ width: 20, depth: 20, height: 10 });
    // Reference 4 -> new length 2: factor 0.5.
    await drive3d(scale3dTool(), ctx, [{ select: [s.id] }, '0,0,0', 'R', '4', '2']);
    expect(meshVolume(solid(doc, s.id).mesh)).toBeCloseTo(500, 9);
    // Reference by two points (length 2), new length by a point from the base (distance 6): x3.
    await drive3d(scale3dTool(), ctx, [{ select: [s.id] }, '0,0,0', 'R', '0,0,0', '2,0,0', '0,6,0']);
    expect(meshVolume(solid(doc, s.id).mesh)).toBeCloseTo(500 * 27, 6);
    // Points option for the new length (length 1 against the reference 2): x0.5.
    await drive3d(scale3dTool(), ctx, [{ select: [s.id] }, '0,0,0', 'R', '2', 'P', '0,0,0', '0,0,1']);
    expect(meshVolume(solid(doc, s.id).mesh)).toBeCloseTo(500 * 27 / 8, 6);
    // Factor by a picked point: distance 2 from the base.
    await drive3d(scale3dTool(), ctx, [{ select: [s.id] }, '0,0,0', '0,0,2']);
    expect(meshVolume(solid(doc, s.id).mesh)).toBeCloseTo(500 * 27, 6);
    const m = solid(doc, s.id);
    expect(maxPositionDiff(evaluateLocal(m.feature), m.mesh)).toBeLessThan(1e-6);
    // Five scalings, five undo steps back to the original.
    for (let i = 0; i < 5; i++) doc.undo();
    expect(solid(doc, s.id)).toBe(s);
  });

  it('factor 1 changes nothing', async () => {
    const s = solidOf(boxFeature(0, 0, 0, 1, 1, 1));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    const before = doc.snapshot;
    await drive3d(scale3dTool(), ctx, [{ select: [s.id] }, '0,0,0', '1']);
    expect(ctx.logs).toContain('3DSCALE: scale factor 1; nothing changed.');
    expect(doc.snapshot).toBe(before);
  });
});

// ------------------------------------------------------------------ 2D commands with solids

describe('2D MOVE / COPY / ROTATE / SCALE / MIRROR on solids', () => {
  const line = (): LineEntity => ({ id: 'L1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });

  it('MOVE moves a mixed selection (line and solid) in one undo step, with solid ghosts', () => {
    const s = solidOf(boxFeature(0, 0, 0, 2, 2, 2));
    const doc = docWith(s);
    doc.addEntities([line()]);
    const ctx = fake3dContext(doc);
    const before = doc.snapshot;
    drive(new MoveTool(), ctx, [{ select: ['L1', s.id] }, { x: 0, y: 0 }, { move: { x: 1, y: 1 } }, { x: 3, y: 4 }]);
    expect(ctx.previews.length).toBe(1);
    expect(doc.entities[0]).toMatchObject({ a: { x: 3, y: 4 }, b: { x: 13, y: 4 } });
    expect(meshBounds(solid(doc, s.id).mesh)).toEqual({ min: v3(3, 4, 0), max: v3(5, 6, 2) });
    expect(sameVertexSet(evaluateLocal(solid(doc, s.id).feature), solid(doc, s.id).mesh)).toBe(true);
    doc.undo();
    expect(doc.snapshot).toBe(before);
  });

  it('MOVE without solids takes the 2D path exactly as before', () => {
    const doc = new Drawing();
    doc.addEntities([line()]);
    const ctx = fake3dContext(doc);
    drive(new MoveTool(), ctx, [{ select: ['L1'] }, { x: 0, y: 0 }, { move: { x: 1, y: 1 } }, { x: 3, y: 4 }]);
    expect(ctx.previews).toEqual([]);
    expect(doc.entities[0]).toMatchObject({ a: { x: 3, y: 4 } });
    expect(doc.snapshot.model3d).toBeUndefined();
  });

  it('COPY duplicates a solid with a new id (each copy one undo step)', () => {
    const s = solidOf(boxFeature(0, 0, 0, 2, 2, 2));
    const doc = docWith(s);
    doc.addEntities([line()]);
    const ctx = fake3dContext(doc);
    drive(new CopyTool(), ctx, [{ select: ['L1', s.id] }, { x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 20 }, { enter: true }]);
    const all = solidsIn(doc);
    expect(all).toHaveLength(3);
    expect(new Set(all.map((x) => x.id)).size).toBe(3);
    expect(all[0]).toBe(s);
    expect(meshBounds(all[2]!.mesh)!.min).toEqual(v3(0, 20, 0));
    expect(doc.entities).toHaveLength(3);
    doc.undo();
    expect(solidsIn(doc)).toHaveLength(2);
    expect(doc.entities).toHaveLength(2);
  });

  it('mixed COPY / MIRROR preserve source appearance like 2D-only copies despite changed current defaults', () => {
    const s = solidOf(boxFeature(0, 0, 0, 2, 2, 2));
    const doc = docWith(s);
    const source = { ...line(), layer: 'Equipment', color: 4, linetype: 'CENTER', lineWeight: 0.35 };
    doc.addEntities([source]);
    doc.currentColor = 1;
    doc.setHeader({ celtype: 'DASHED' });
    const ctx = fake3dContext(doc);
    const beforeCopy = doc.snapshot;
    drive(new CopyTool(), ctx, [{ select: ['L1', s.id] }, { x: 0, y: 0 }, { x: 0, y: 10 }, { enter: true }]);
    expect(doc.entities[1]).toMatchObject({ layer: 'Equipment', color: 4, linetype: 'CENTER', lineWeight: 0.35, a: { x: 0, y: 10 } });
    expect(solidsIn(doc)).toHaveLength(2);
    // The same complete appearance and geometry as a 2D-only COPY of the line.
    const doc2 = new Drawing();
    doc2.addEntities([source]);
    doc2.currentColor = 1;
    doc2.setHeader({ celtype: 'DASHED' });
    drive(new CopyTool(), fake3dContext(doc2), [{ select: ['L1'] }, { x: 0, y: 0 }, { x: 0, y: 10 }, { enter: true }]);
    const { id: _a, ...mixed } = doc.entities[1]!;
    const { id: _b, ...plain } = doc2.entities[1]!;
    expect(mixed).toEqual(plain);
    expect([...ctx.selection]).toEqual(['L1', s.id]);
    ctx.selection = new Set();
    const beforeMirror = doc.snapshot;
    drive(new MirrorTool(), ctx, [{ select: ['L1', s.id] }, { x: -1, y: 0 }, { x: -1, y: 5 }]);
    expect(doc.entities.at(-1)).toMatchObject({ layer: 'Equipment', color: 4, linetype: 'CENTER', lineWeight: 0.35 });
    expect([...ctx.selection]).toEqual(['L1', s.id]);
    const afterMirror = doc.snapshot;
    doc.undo(); expect(doc.snapshot).toBe(beforeMirror); doc.redo(); expect(doc.snapshot).toBe(afterMirror);
    doc.undo(); doc.undo(); expect(doc.snapshot).toBe(beforeCopy);
  });

  it('ROTATE turns solids about the world Z axis through the base point', () => {
    const s = solidOf(boxFeature(0, 0, 0, 4, 2, 1));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    drive(new RotateTool(), ctx, [{ select: [s.id] }, { x: 0, y: 0 }, '90']);
    const b = meshBounds(solid(doc, s.id).mesh)!;
    expect(b.min.x).toBeCloseTo(-2, 9);
    expect(b.max.y).toBeCloseTo(4, 9);
    expect(meshVolume(solid(doc, s.id).mesh)).toBeCloseTo(8, 9);
    // A picked angle point works too (the 2D commands keep their selection: pick-first next time).
    expect(ctx.selection.has(s.id)).toBe(true);
    drive(new RotateTool(), ctx, [{ x: 0, y: 0 }, { x: -1, y: 0 }]);
    expect(meshBounds(solid(doc, s.id).mesh)!.min.y).toBeCloseTo(-4, 9);
  });

  it('SCALE scales solids uniformly about the base point on z = 0', () => {
    const s = solidOf(boxFeature(1, 1, 1, 1, 1, 1));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    drive(new ScaleTool(), ctx, [{ select: [s.id] }, { x: 0, y: 0 }, '3']);
    expect(meshVolume(solid(doc, s.id).mesh)).toBeCloseTo(27, 9);
    expect(meshBounds(solid(doc, s.id).mesh)).toEqual({ min: v3(3, 3, 3), max: v3(6, 6, 6) });
    drive(new ScaleTool(), ctx, [{ x: 0, y: 0 }, { x: 0, y: 0.5 }]);
    expect(meshVolume(solid(doc, s.id).mesh)).toBeCloseTo(27 / 8, 9);
  });

  it('MIRROR adds a mirrored copy with a positive volume and a consistent feature', () => {
    const wedge: Feature3D = { kind: 'wedge', frame: at(3, 1, 0), width: 4, depth: 2, height: 3 };
    const s = solidOf(wedge);
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    drive(new MirrorTool(), ctx, [{ select: [s.id] }, { x: 0, y: -5 }, { move: { x: 0, y: 3 } }, { x: 0, y: 5 }]);
    expect(ctx.previews.length).toBe(1);
    const all = solidsIn(doc);
    expect(all).toHaveLength(2);
    const m = all[1]!;
    expect(m.id).not.toBe(s.id);
    expect(meshVolume(m.mesh)).toBeCloseTo(meshVolume(s.mesh), 9);
    expect(meshVolume(m.mesh)).toBeGreaterThan(0);
    expect(meshIsClosed(m.mesh)).toBe(true);
    expect(meshBounds(m.mesh)).toEqual({ min: v3(-5, 0, 0), max: v3(-1, 2, 3) });
    expect(sameVertexSet(primitiveMesh(m.feature as PrimitiveFeature), m.mesh)).toBe(true);
  });

  it('a refused transform leaves the drawing unchanged and says so', () => {
    const s = solidOf(boxFeature(0, 0, 0, 1, 1, 1));
    const doc = docWith(s);
    const ctx = fake3dContext(doc);
    const before = doc.snapshot;
    expect(commitWithSolids(ctx, [s.id], mat4Scaling(1, 2, 1), {})).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(ctx.logs.at(-1)).toMatch(/uniform scaling.*unchanged/);
    expect(commitWithSolids(ctx, ['nothing'], mat4Scaling(1, 2, 1), {})).toBe(false);
  });

  it('applies the 2D entity edits in the same step as the solids', () => {
    const s = solidOf(boxFeature(0, 0, 0, 1, 1, 1));
    const doc = docWith(s);
    doc.addEntities([line()]);
    const ctx = fake3dContext(doc);
    const added: Entity = { id: 'L2', type: 'line', layer: '0', color: 'ByLayer', a: { x: 5, y: 5 }, b: { x: 6, y: 5 } };
    const undoBefore = doc.history().undo.length;
    commitWithSolids(ctx, [s.id, 'L1'], translationMatrix(v3(1, 0, 0)), { replace: [{ ...line(), a: { x: 1, y: 0 } }], add: [added] });
    expect(doc.history().undo.length).toBe(undoBefore + 1);
    expect(doc.entities.map((e) => e.id)).toEqual(['L1', 'L2']);
    expect(doc.entities[0]).toMatchObject({ a: { x: 1, y: 0 } });
  });
});

// ------------------------------------------------------------------ docs replay

let Editor: typeof EditorType;
let installExperimental3d: typeof InstallType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
  ({ installExperimental3d } = await import('../src/app/experimental-3d'));
});
afterEach(() => {
  const i = RIBBON.findIndex((t) => t.name === '3D');
  if (i >= 0) RIBBON.splice(i, 1);
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

describe('docs/3D-EDITING.md replay (transforms)', () => {
  it('produces the results the document states', async () => {
    resetModellingDefaults();
    resetTransformDefaults();
    const ed = new Editor(canvas());
    ed.settings = { ...ed.settings, experimental3d: true };
    const jcad3d = installExperimental3d(ed)!;
    const run = (c: string, ...xs: string[]) => {
      void ed.runCommand(c);
      for (const x of xs) ed.submitInput(x);
    };
    const id = () => jcad3d.solidIds().at(-1)!;
    const last = () => model3dOf(ed.doc.snapshot).solids.at(-1)!;
    const box = () => meshBounds(last().mesh)!;

    run('BOX', '0,0', '10,10', '5');
    run('3DMOVE', id(), '', '0,0,0', '@20,0,3');
    expect(box()).toEqual({ min: v3(20, 0, 3), max: v3(30, 10, 8) });
    run('3DMOVE', id(), '', 'D', '0,0,-3');
    expect(box()).toEqual({ min: v3(20, 0, 0), max: v3(30, 10, 5) });
    run('3DROTATE', id(), '', '20,0,0', '', '90');
    expect(box().min.x).toBeCloseTo(10, 9);
    expect(box().max.x).toBeCloseTo(20, 9);
    expect(box().max.y).toBeCloseTo(10, 9);
    run('3DROTATE', id(), '', '10,0,0', 'X', '90');
    expect(box().min.y).toBeCloseTo(-5, 9);
    expect(box().max.z).toBeCloseTo(10, 9);
    run('3DSCALE', id(), '', '10,0,0', '2');
    expect(meshVolume(last().mesh)).toBeCloseTo(4000, 6);
    run('3DSCALE', id(), '', '10,0,0', 'R', '4', '2');
    expect(meshVolume(last().mesh)).toBeCloseTo(500, 9);
    ed.runCommand('UNDO');
    expect(meshVolume(last().mesh)).toBeCloseTo(4000, 6);
    ed.runCommand('REDO');
    expect(meshVolume(last().mesh)).toBeCloseTo(500, 9);

    // Mixed 2D + 3D MOVE, COPY and MIRROR of a solid.
    run('BOX', '0,40', '2,42', '2');
    const b = id();
    run('LINE', '0,30', '10,30', '');
    run('MOVE', 'L', b, '', '0,0', '0,5');
    expect(meshBounds(last().mesh)!.min).toEqual(v3(0, 45, 0));
    expect(ed.doc.entities.at(-1)).toMatchObject({ a: { x: 0, y: 35 }, b: { x: 10, y: 35 } });
    ed.cancel(); // Esc: MOVE keeps its selection (2D behaviour); clear it before the next command
    run('COPY', b, '', '0,0', '5,0', '');
    expect(jcad3d.solidIds()).toHaveLength(3);
    expect(meshBounds(last().mesh)!.min).toEqual(v3(5, 45, 0));
    ed.cancel();
    run('MIRROR', b, '', '-1,0', '-1,10');
    expect(jcad3d.solidIds()).toHaveLength(4);
    expect(meshBounds(last().mesh)!.max.x).toBeCloseTo(-2, 9);
    expect(meshVolume(last().mesh)).toBeCloseTo(8, 9);

    // Measurement, the dimension prototype and a parameter edit.
    ed.cancel(); // Esc: MIRROR keeps its selection too
    const logged = (re: RegExp) => ed.history.some((l) => re.test(l));
    run('3DDIST', '0,0,0', '3,4,12');
    expect(ed.history).toContain('Distance = 13.0000, Angle in XY Plane = 53.13, Angle from XY Plane = 67.38');
    expect(logged(/^Planar distance .* = 5\.0000$/)).toBe(true);
    run('BOX', '40,0', '44,3', '2');
    const m = id();
    run('3DMASSPROP', m, '');
    expect(ed.history).toContain('Volume:        24.0000');
    expect(ed.history).toContain('Surface area:  52.0000');
    expect(ed.history).toContain('Centroid:      X: 42.0000  Y: 1.5000  Z: 1.0000');
    run('3DAREA', '42,1');
    expect(ed.history).toContain('Area = 12.0000, Perimeter = 14.0000');
    run('3DDIM', '40,0', '44,0', '42,-2');
    expect(ed.history).toContain('Dimension text = 4.0000 (measured 4.0000)');
    run('3DDIM', '40,0,0', '44,3,2', '');
    expect(logged(/projected distance 5\.0000\. True 3D distance: 5\.3852\.$/)).toBe(true);
    expect(ed.doc.entities.filter((e) => e.type === 'dimension')).toHaveLength(2);
    jcad3d.setParameter(m, '/width', '6');
    await jcad3d.idle();
    expect(last().id).toBe(m);
    expect(meshVolume(last().mesh)).toBeCloseTo(36, 9);
    jcad3d.setParameter(m, '/width', '-1');
    expect(logged(/^PROPERTIES: Width must be positive and finite \(got -1\)\. The solid is unchanged\.$/)).toBe(true);
    expect(meshVolume(last().mesh)).toBeCloseTo(36, 9);
  });
});
