import { describe, it, expect } from 'vitest';
import { mirrorEntity, scaleEntity } from '../src/tools/edit';
import type { Entity, ArcEntity } from '../src/core/entities';
import { arcEndpoints } from '../src/core/entities';

describe('edit tool helpers', () => {
  it('mirrors a line across a vertical axis', () => {
    const line: Entity = { id: 'l', layer: '0', color: 'ByLayer', type: 'line', a: { x: 1, y: 1 }, b: { x: 2, y: 3 } };
    const m = mirrorEntity(line, { x: 0, y: 0 }, { x: 0, y: 1 });
    if (m.type === 'line') {
      expect(m.a.x).toBeCloseTo(-1);
      expect(m.a.y).toBeCloseTo(1);
      expect(m.b.x).toBeCloseTo(-2);
      expect(m.b.y).toBeCloseTo(3);
    }
  });
  it('mirrors an arc keeping it counter-clockwise', () => {
    const arc: ArcEntity = { id: 'a', layer: '0', color: 'ByLayer', type: 'arc', center: { x: 2, y: 0 }, radius: 1, startAngle: 0, endAngle: Math.PI / 2 };
    const m = mirrorEntity(arc, { x: 0, y: 0 }, { x: 0, y: 1 }) as ArcEntity;
    const [s, e] = arcEndpoints(m);
    // original endpoints (3,0) and (2,1) -> mirrored (-3,0) and (-2,1); CCW order must start at (-2,1)
    expect(s.x).toBeCloseTo(-2);
    expect(s.y).toBeCloseTo(1);
    expect(e.x).toBeCloseTo(-3);
    expect(e.y).toBeCloseTo(0);
  });
  it('scales about a base point', () => {
    const c: Entity = { id: 'c', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 2, y: 2 }, radius: 1 };
    const s = scaleEntity(c, { x: 0, y: 0 }, 3);
    if (s.type === 'circle') {
      expect(s.center).toEqual({ x: 6, y: 6 });
      expect(s.radius).toBe(3);
    }
    const t: Entity = { id: 't', layer: '0', color: 'ByLayer', type: 'text', position: { x: 1, y: 1 }, text: 'x', height: 0.1, rotation: 0, align: 'left' };
    const st = scaleEntity(t, { x: 1, y: 1 }, 2);
    if (st.type === 'text') {
      expect(st.position).toEqual({ x: 1, y: 1 });
      expect(st.height).toBeCloseTo(0.2);
    }
  });
});
