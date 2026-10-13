/**
 * Milestone 4 3DDIM prototype (src/tools3d/dim3d.ts): an ordinary 2D aligned dimension between
 * two 3D points projected onto the construction plane.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { DimensionEntity } from '../src/core/entities';
import { dimensionMeasurement } from '../src/core/dimension';
import { v3 } from '../src/model3d/math';
import { axesFrame } from '../src/tools3d/context';
import { dim3dTool } from '../src/tools3d/dim3d';
import { drive3d, fake3dContext } from './helpers/context3d';

const dims = (doc: Drawing) => doc.entities.filter((e): e is DimensionEntity => e.type === 'dimension');

describe('3DDIM', () => {
  it('writes an aligned 2D dimension between points on the plane', async () => {
    const doc = new Drawing();
    const ctx = fake3dContext(doc);
    await drive3d(dim3dTool(), ctx, ['40,0', '44,0', { move: { x: 42, y: -1 } }, '42,-2']);
    const [d] = dims(doc);
    expect(d).toMatchObject({ kind: 'aligned', p1: { x: 40, y: 0 }, p2: { x: 44, y: 0 }, linePoint: { x: 42, y: -2 }, layer: '0' });
    expect(dimensionMeasurement(d!)).toBeCloseTo(4, 12);
    expect(ctx.logs[0]).toMatch(/^3DDIM \(prototype\)/);
    expect(ctx.logs.at(-1)).toBe('Dimension text = 4.0000 (measured 4.0000)');
    // The rubber band showed the dimension, and is cleared at the end.
    expect(ctx.preview).toEqual([]);
    doc.undo();
    expect(dims(doc)).toHaveLength(0);
  });

  it('projects off-plane points and logs the true 3D distance; Enter places the line', async () => {
    const doc = new Drawing();
    const ctx = fake3dContext(doc);
    await drive3d(dim3dTool(), ctx, ['40,0,0', '44,3,2', '']);
    const [d] = dims(doc);
    expect(dimensionMeasurement(d!)).toBeCloseTo(5, 12);
    expect(ctx.logs).toContain('3DDIM: a point is off the construction plane; the dimension measures the projected distance 5.0000. True 3D distance: 5.3852.');
    // Enter: a fifth of the length to the left of p1 -> p2.
    expect(d!.linePoint.x).toBeCloseTo(42 - 0.6, 12);
    expect(d!.linePoint.y).toBeCloseTo(1.5 + 0.8, 12);
  });

  it('a raised XY plane: on-plane points, drawn at z = 0 with a note', async () => {
    const doc = new Drawing();
    const ctx = fake3dContext(doc, { plane: axesFrame('XY', v3(0, 0, 5)) });
    await drive3d(dim3dTool(), ctx, ['0,0', '0,7', '3,3']);
    const [d] = dims(doc);
    expect(dimensionMeasurement(d!)).toBeCloseTo(7, 12);
    expect(ctx.logs.some((l) => l.includes('off the construction plane'))).toBe(false);
    expect(ctx.logs).toContain('3DDIM: 2D entities have no elevation; the dimension is drawn on z = 0 below the construction plane.');
  });

  it('refuses planes not parallel to the drawing plane and coincident projections', async () => {
    const doc = new Drawing();
    const ctx = fake3dContext(doc, { plane: axesFrame('XZ') });
    await drive3d(dim3dTool(), ctx, ['0,0', '1,0']);
    expect(ctx.logs[0]).toMatch(/^3DDIM: 2D dimensions lie on the drawing plane/);
    expect(dims(doc)).toHaveLength(0);
    const ctx2 = fake3dContext(doc);
    await drive3d(dim3dTool(), ctx2, ['1,1,0', '1,1,9']);
    expect(ctx2.logs.at(-1)).toBe('3DDIM: the points coincide on the construction plane; nothing to dimension (3D distance 9.0000).');
    expect(dims(doc)).toHaveLength(0);
  });

  it('uses the current layer and dimension style', async () => {
    const doc = new Drawing();
    doc.addLayer({ ...doc.layers[0]!, name: 'DIMS' });
    doc.setCurrentLayer('DIMS');
    const ctx = fake3dContext(doc);
    await drive3d(dim3dTool(), ctx, ['0,0', '2,0', '1,1']);
    expect(dims(doc)[0]).toMatchObject({ layer: 'DIMS', style: doc.header.dimStyle });
  });
});
