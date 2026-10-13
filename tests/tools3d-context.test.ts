import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { WORLD_XY_FRAME, isOrthonormalFrame, v3 } from '../src/model3d/math';
import { addSolids, newSolid } from '../src/model3d/model';
import { primitiveMesh } from '../src/model3d/primitives';
import type { BoxFeature } from '../src/model3d/types';
import { axesFrame, closestOnAxis, heightBetween, parsePoint3, planeLabel, planeToWorld, worldToPlane } from '../src/tools3d/context';
import { planeTool } from '../src/tools3d/plane';
import { drive3d, fake3dContext } from './helpers/context3d';

describe('construction-plane coordinates', () => {
  it('axis frames are right-handed and orthonormal; plane <-> world round trips', () => {
    for (const k of ['XY', 'XZ', 'YZ'] as const) {
      const f = axesFrame(k, v3(1, 2, 3));
      expect(isOrthonormalFrame(f)).toBe(true);
      const q = planeToWorld(f, { x: 4, y: -5 }, 6);
      expect(worldToPlane(f, q)).toEqual(v3(4, -5, 6));
    }
    expect(axesFrame('XZ').zAxis).toEqual(v3(0, -1, 0));
  });

  it('parses typed 3D and 2D input in plane coordinates, absolute and relative', () => {
    const f = axesFrame('XZ');
    expect(parsePoint3('1,2,3', WORLD_XY_FRAME, null)).toEqual(v3(1, 2, 3));
    expect(parsePoint3('@1,1,1', WORLD_XY_FRAME, v3(1, 2, 3))).toEqual(v3(2, 3, 4));
    expect(parsePoint3('1,2', f, null)).toEqual(v3(1, 0, 2));
    // Relative 2D input keeps the last point's height above the plane.
    expect(parsePoint3('@1,0', WORLD_XY_FRAME, v3(0, 0, 5))).toEqual(v3(1, 0, 5));
    expect(parsePoint3('2<90', WORLD_XY_FRAME, null)!.y).toBeCloseTo(2, 12);
    expect(parsePoint3('1e1,0,0', WORLD_XY_FRAME, null)).toEqual(v3(10, 0, 0));
    expect(parsePoint3('abc', WORLD_XY_FRAME, null)).toBeNull();
    expect(parsePoint3('1,2,3,4', WORLD_XY_FRAME, null)).toBeNull();
  });

  it('heights: along the normal, the in-plane distance on the plane, the ray closest approach', () => {
    const n = v3(0, 0, 1);
    expect(heightBetween(v3(0, 0, 0), v3(3, 4, -2), n)).toBe(-2);
    expect(heightBetween(v3(0, 0, 0), v3(3, 4, 0), n)).toBe(5);
    expect(closestOnAxis(v3(1, 1, 0), n, { origin: v3(1, -10, 7), dir: v3(0, 1, 0) })).toBeCloseTo(7, 12);
    expect(closestOnAxis(v3(0, 0, 0), n, { origin: v3(5, 5, 5), dir: v3(0, 0, 1) })).toBeNull();
  });

  it('labels a plane with its origin when it is not 0,0,0', () => {
    expect(planeLabel('World', WORLD_XY_FRAME)).toBe('World');
    expect(planeLabel('XY', axesFrame('XY', v3(0, 0, 5)))).toBe('XY @ 0,0,5');
  });
});

describe('3DPLANE', () => {
  const boxSolid = () => {
    const feature: BoxFeature = { kind: 'box', frame: WORLD_XY_FRAME, width: 4, depth: 4, height: 2 };
    return newSolid({ mesh: primitiveMesh(feature), feature });
  };

  it('World / XY / XZ / YZ / Origin, and the default (Enter) is World', async () => {
    const ctx = fake3dContext();
    await drive3d(planeTool(), ctx, ['XZ']);
    expect(ctx.planeName).toBe('XZ');
    expect(ctx.plane.zAxis).toEqual(v3(0, -1, 0));
    await drive3d(planeTool(), ctx, ['O', '0,0,5']);
    // Origin typed in the current plane's coordinates: z of XZ is world -Y.
    expect(ctx.plane.origin).toEqual(v3(0, -5, 0));
    expect(ctx.logs.at(-1)).toBe('Construction plane: XZ @ 0,-5,0.');
    await drive3d(planeTool('yz'), ctx, []);
    expect(ctx.planeName).toBe('YZ');
    expect(ctx.plane.origin).toEqual(v3(0, -5, 0));
    await drive3d(planeTool(), ctx, ['']);
    expect(ctx.plane).toBe(WORLD_XY_FRAME);
    expect(ctx.prompts).toContain('Specify construction plane [World/Top/Front/Right/Solid face/Origin] <World>:');
  });

  it('Face: the plane of the solid face picked (from the plan view: looking down)', async () => {
    const doc = new Drawing();
    doc.updateModel3D((m) => addSolids(m, [boxSolid()]));
    const ctx = fake3dContext(doc);
    await drive3d(planeTool(), ctx, ['S', '10,10', '1,1']);
    expect(ctx.logs).toContain('No solid face there; pick a face of a solid.');
    expect(ctx.planeName).toBe('Face');
    expect(ctx.plane.origin).toEqual(v3(1, 1, 2));
    expect(ctx.plane.zAxis.z).toBeCloseTo(1, 6);
    expect(isOrthonormalFrame(ctx.plane)).toBe(true);
  });

  it('Face from a 3D-view pick uses the hit normal (a side face)', async () => {
    const doc = new Drawing();
    const s = boxSolid();
    doc.updateModel3D((m) => addSolids(m, [s]));
    const ctx = fake3dContext(doc);
    ctx.picks.push({ p2: { x: 2, y: 0 }, point: v3(2, 0, 1), ray: { origin: v3(10, 0, 1), dir: v3(-1, 0, 0) }, hit: { id: s.id, t: 8, point: v3(2, 0, 1), normal: v3(1, 0, 0), triangle: 0 } });
    await drive3d(planeTool(), ctx, ['Face', { x: 2, y: 0 }]);
    expect(ctx.plane.origin).toEqual(v3(2, 0, 1));
    expect(ctx.plane.zAxis).toEqual(v3(1, 0, 0));
  });
});
