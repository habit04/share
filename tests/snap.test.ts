import { describe, it, expect } from 'vitest';
import { findObjectSnap, constrainDirection, defaultSnapSettings } from '../src/core/snap';
import { pickEntity, selectByBox } from '../src/core/selection';
import type { Entity } from '../src/core/entities';

const lookup = () => undefined;
const ents: Entity[] = [
  { id: 'l1', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 4, y: 0 } },
  { id: 'l2', layer: '0', color: 'ByLayer', type: 'line', a: { x: 2, y: -2 }, b: { x: 2, y: 2 } },
  { id: 'c1', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 10, y: 10 }, radius: 1 },
  { id: 'l3', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 5 }, b: { x: 4, y: 5 } },
];

describe('snapping', () => {
  const s = defaultSnapSettings();
  it('prefers endpoint near a line end', () => {
    const r = findObjectSnap({ x: 3.95, y: 0.02 }, ents, lookup, s, 0.2, null, new Set());
    expect(r?.kind).toBe('endpoint');
    expect(r?.point).toEqual({ x: 4, y: 0 });
  });
  it('finds intersections of two lines', () => {
    const r = findObjectSnap({ x: 2.05, y: 0.05 }, ents, lookup, s, 0.2, null, new Set());
    expect(r?.kind).toBe('intersection');
    expect(r!.point.x).toBeCloseTo(2);
    expect(r!.point.y).toBeCloseTo(0);
  });
  it('finds midpoint and center', () => {
    expect(findObjectSnap({ x: 2.05, y: 5.05 }, ents, lookup, s, 0.2, null, new Set())?.kind).toBe('midpoint');
    expect(findObjectSnap({ x: 10.05, y: 10.02 }, ents, lookup, s, 0.2, null, new Set())?.kind).toBe('center');
  });
  it('returns null when osnap is off or nothing is near', () => {
    expect(findObjectSnap({ x: 50, y: 50 }, ents, lookup, s, 0.2, null, new Set())).toBeNull();
    expect(findObjectSnap({ x: 4, y: 0 }, ents, lookup, { ...s, osnap: false }, 0.2, null, new Set())).toBeNull();
  });
  it('ortho constrains to the dominant axis', () => {
    const o = { ...s, ortho: true };
    expect(constrainDirection({ x: 0, y: 0 }, { x: 5, y: 1 }, o)).toEqual({ x: 5, y: 0 });
    expect(constrainDirection({ x: 0, y: 0 }, { x: 1, y: 5 }, o)).toEqual({ x: 0, y: 5 });
  });
});

describe('selection', () => {
  it('pickEntity picks the closest within aperture', () => {
    expect(pickEntity({ x: 1, y: 0.05 }, ents, lookup, 0.1, new Set())?.id).toBe('l1');
    expect(pickEntity({ x: 1, y: 1 }, ents, lookup, 0.1, new Set())).toBeNull();
    expect(pickEntity({ x: 1, y: 0.05 }, ents, lookup, 0.1, new Set(['0']))).toBeNull();
  });
  it('window vs crossing selection', () => {
    const box = { min: { x: 1, y: -1 }, max: { x: 3, y: 1 } };
    expect(selectByBox(box, 'window', ents, lookup, new Set()).map((e) => e.id)).toEqual([]);
    expect(selectByBox(box, 'crossing', ents, lookup, new Set()).map((e) => e.id).sort()).toEqual(['l1', 'l2']);
    const big = { min: { x: -1, y: -3 }, max: { x: 5, y: 3 } };
    expect(selectByBox(big, 'window', ents, lookup, new Set()).map((e) => e.id).sort()).toEqual(['l1', 'l2']);
    const withL3 = { min: { x: -1, y: -3 }, max: { x: 5, y: 6 } };
    expect(selectByBox(withL3, 'window', ents, lookup, new Set())).toHaveLength(3);
  });

  it('crossing box entirely inside a circle selects nothing', () => {
    const box = { min: { x: 9.8, y: 9.8 }, max: { x: 10.2, y: 10.2 } };
    expect(selectByBox(box, 'crossing', ents, lookup, new Set())).toHaveLength(0);
  });
  it('perpendicular snap from a base point', () => {
    const s2 = { ...defaultSnapSettings(), endpoint: false, midpoint: false, intersection: false };
    const r = findObjectSnap({ x: 1.05, y: 0.1 }, ents, lookup, s2, 0.2, { x: 1, y: 3 }, new Set());
    expect(r?.kind).toBe('perpendicular');
    expect(r!.point.x).toBeCloseTo(1);
    expect(r!.point.y).toBeCloseTo(0);
  });
  it('hidden layers are excluded from snapping', () => {
    expect(findObjectSnap({ x: 3.95, y: 0.02 }, ents, lookup, defaultSnapSettings(), 0.2, null, new Set(['0']))).toBeNull();
  });
});
