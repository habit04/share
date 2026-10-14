/**
 * Error handling of the 3D core (milestone 6 audit, docs/3D-TESTING.md): the classification helper
 * for commands, and regressions for the defects the fixtures and fuzzers found.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { GeometryBudgetError } from '../src/core/geometry-budget-error';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { Model3DInputError, describeModel3DError, isModel3DUserError } from '../src/model3d/errors';
import { FeatureEvalError, evaluateFeature } from '../src/model3d/feature-eval';
import { KernelError, UnavailableKernel } from '../src/model3d/kernel/kernel';
import { WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import { addSolids, model3dOf, newSolid, withModel3D } from '../src/model3d/model';
import { boxMesh, primitiveMesh, requireSolidMesh } from '../src/model3d/primitives';
import { invertWinding, meshIsClosed, meshVolume } from '../src/model3d/mesh';
import { extrudeMesh, revolveMesh } from '../src/model3d/sweep';
import type { Feature3D, Profile3D } from '../src/model3d/types';

const square = (x: number, y: number, s: number) => [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }];

describe('describeModel3DError', () => {
  it('keeps the messages of the documented errors and flags everything else as internal', async () => {
    expect(describeModel3DError(new Model3DInputError('Box width must be a positive finite number (got 0).'))).toEqual({ kind: 'input', message: 'Box width must be a positive finite number (got 0).' });
    // The builders throw it (a RangeError subclass, so the old contract still holds).
    const thrown = (() => { try { boxMesh(0, 1, 1); } catch (e) { return e; } return null; })();
    expect(thrown).toBeInstanceOf(Model3DInputError);
    expect(thrown).toBeInstanceOf(RangeError);
    expect(new FeatureEvalError('x')).toBeInstanceOf(Model3DInputError);
    expect(describeModel3DError(new GeometryBudgetError('too many'))).toEqual({ kind: 'budget', message: 'too many' });
    expect(describeModel3DError(new FeatureEvalError('mesh'))).toEqual({ kind: 'history', message: 'mesh' });
    const unavailable = await new UnavailableKernel('no WebAssembly').boolean('union', boxMesh(1, 1, 1), boxMesh(1, 1, 1)).catch((e: unknown) => e);
    expect(unavailable).toBeInstanceOf(KernelError);
    expect(describeModel3DError(unavailable)).toMatchObject({ kind: 'kernel', code: 'unavailable' });
    for (const bug of [new TypeError("Cannot read properties of undefined (reading 'x')"), new Error('Triangulation failed'), new RangeError('Maximum call stack size exceeded'), new RangeError('Invalid array length'), new RangeError('Box width must be positive'), 'thrown string', null]) {
      const r = describeModel3DError(bug);
      expect(r.kind).toBe('internal');
      expect(r.message).toMatch(/^Internal error in the 3D modeller \(.*\); the operation was not applied\.$/);
      expect(isModel3DUserError(bug)).toBe(false);
    }
  });
});

describe('regressions found by the milestone 6 fixtures and fuzzers', () => {
  it('a revolve history with its segment count survives a DXF round trip (was rejected as an unknown field)', () => {
    const profile: Profile3D = { frame: WORLD_XY_FRAME, loops: [square(1, 0, 1)] };
    const feature: Feature3D = { kind: 'revolve', profile, axis: { origin: v3(0, 0, 0), dir: v3(0, 1, 0) }, angle: Math.PI, segments: 12 };
    const solid = newSolid({ id: 'rev-segments', feature, mesh: revolveMesh(profile, feature.axis, feature.angle, 12) });
    const base = new Drawing().snapshot;
    const back = readDxf(writeDxf(withModel3D(base, addSolids(model3dOf(base), [solid]))), { model3d: true });
    expect(importReportOf(back)).toBeUndefined();
    expect(back.model3d!.solids[0]!.feature).toEqual(feature);
  });

  it('refuses a primitive or extrusion that collapses or overflows at its position (was a zero-volume mesh)', () => {
    const far = { ...WORLD_XY_FRAME, origin: v3(0, 0, -1e300) };
    expect(() => primitiveMesh({ kind: 'sphere', frame: far, radius: 0.5, segments: 8, rings: 4 })).toThrow(/no usable volume at this size and position/);
    expect(() => primitiveMesh({ kind: 'box', frame: WORLD_XY_FRAME, width: 1e200, depth: 1e200, height: 1e200 })).toThrow(Model3DInputError);
    expect(() => extrudeMesh({ frame: far, loops: [square(0, 0, 1)] }, 1)).toThrow(/The extrusion has no usable volume/);
    // An inside-out or structurally broken builder result is a programming error, not user input.
    expect(() => requireSolidMesh('box', invertWinding(boxMesh(1, 1, 1)))).toThrow(/^Internal error: the box builder produced an inside-out mesh/);
    expect(isModel3DUserError((() => { try { requireSolidMesh('box', { positions: [0, 0, 0], indices: [0, 0, 5] }); } catch (e) { return e; } return null; })())).toBe(false);
    expect(() => requireSolidMesh('box', { positions: [NaN, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] })).toThrow(Model3DInputError);
    // Ordinary placements are unaffected.
    expect(() => primitiveMesh({ kind: 'sphere', frame: { ...WORLD_XY_FRAME, origin: v3(1e6, -1e6, 5e5) }, radius: 0.001 })).not.toThrow();
  });

  it('reports a profile that cannot be triangulated in the revolution plane as a Model3DInputError (was a plain Error)', async () => {
    // Valid profile, axis in its plane but 1e300 away: every point gets the same radius.
    const profile: Profile3D = { frame: WORLD_XY_FRAME, loops: [square(1, 0, 1)] };
    const axis = { origin: v3(-1e300, 0, 0), dir: v3(0, 1, 0) };
    expect(() => revolveMesh(profile, axis, Math.PI, 8)).toThrow(Model3DInputError);
    expect(() => revolveMesh(profile, axis, Math.PI, 8)).toThrow(/Cannot revolve/);
    const rejected = await evaluateFeature({ kind: 'revolve', profile, axis, angle: Math.PI, segments: 8 }, new UnavailableKernel('none')).catch((e: unknown) => e);
    expect(isModel3DUserError(rejected)).toBe(true);
  });

  it('found by the 10x soak: a missing profile frame and a profile point snapped onto the axis', () => {
    // frame: null escaped validateFrame as a TypeError.
    const noFrame = { frame: null, loops: [square(1, 0, 1)] } as unknown as Profile3D;
    expect(() => extrudeMesh(noFrame, 1)).toThrow(/the profile frame is missing/);
    expect(() => extrudeMesh(noFrame, 1)).toThrow(Model3DInputError);
    // A vertex 1e-12 from the axis next to one on it gave two pole vertices at one place: an open mesh.
    const profile: Profile3D = { frame: WORLD_XY_FRAME, loops: [[{ x: 0.5, y: 0 }, { x: 4.5, y: 0 }, { x: 4.5, y: 4 }, { x: 0.5, y: 1e-12 }]] };
    const axis = { origin: v3(0, 0, 0), dir: v3(1, 0, 0) };
    for (const angle of [Math.PI / 2, 2 * Math.PI]) {
      const mesh = revolveMesh(profile, axis, angle, 16);
      expect(meshIsClosed(mesh)).toBe(true);
      expect(meshVolume(mesh)).toBeGreaterThan(0);
    }
  });
});
