import { describe, it, expect } from 'vitest';
import type { Entity } from '../src/core/entities';
import { selectByFence, selectByPolygon } from '../src/core/selection';
import { findObjectSnap, defaultSnapSettings, tangentPoints, trackFromPoints, trackingAngles, osmode, applyOsmode } from '../src/core/snap';
import { fakeContext, drive } from './fake-context';
import { selectTool, qselect, qselectTool, selectionKeyword, selectionHistory } from '../src/tools/select';
import { wildcardMatch } from '../src/app/commands-drafting';

const lookup = () => undefined;
const props = { layer: '0', color: 'ByLayer' as const };
const ents: Entity[] = [
  { id: 'l1', ...props, type: 'line', a: { x: 0, y: 0 }, b: { x: 4, y: 0 } },
  { id: 'l2', ...props, type: 'line', a: { x: 2, y: -2 }, b: { x: 2, y: 2 } },
  { id: 'c1', ...props, type: 'circle', center: { x: 10, y: 10 }, radius: 1 },
  { id: 't1', layer: 'TAGS', color: 'ByLayer', type: 'text', position: { x: 6, y: 6 }, text: 'X', height: 0.2, rotation: 0, align: 'left' },
  { id: 'p1', ...props, type: 'point', position: { x: 20, y: 20 } },
];

describe('selection modes', () => {
  it('fence selects what the fence crosses', () => {
    const ids = selectByFence([{ x: 1, y: -1 }, { x: 1, y: 1 }, { x: 3, y: 1 }], ents, lookup, new Set()).map((e) => e.id);
    expect(ids.sort()).toEqual(['l1', 'l2']);
    expect(selectByFence([{ x: 30, y: 30 }, { x: 31, y: 31 }], ents, lookup, new Set())).toHaveLength(0);
  });
  it('window polygon needs everything inside, crossing polygon accepts touching', () => {
    const tri = [{ x: -1, y: -1 }, { x: 7, y: -1 }, { x: -1, y: 7 }];
    expect(selectByPolygon(tri, 'window', ents, lookup, new Set()).map((e) => e.id)).toEqual(['l1']);
    expect(selectByPolygon(tri, 'crossing', ents, lookup, new Set()).map((e) => e.id).sort()).toEqual(['l1', 'l2']);
    const around = [{ x: 8, y: 8 }, { x: 12, y: 8 }, { x: 12, y: 12 }, { x: 8, y: 12 }];
    expect(selectByPolygon(around, 'window', ents, lookup, new Set()).map((e) => e.id)).toEqual(['c1']);
  });
  it('SELECT tool with ALL, Remove, Fence and Window keywords', () => {
    const ctx = fakeContext();
    ctx.doc.addEntities(ents);
    drive(selectTool(), ctx, ['ALL', 'R', { x: 20, y: 20 }, '']);
    expect([...ctx.selection].sort()).toEqual(['c1', 'l1', 'l2', 't1']);
    drive(selectTool(), ctx, ['F', { x: 1, y: -1 }, { x: 1, y: 1 }, '', '']);
    expect([...ctx.selection]).toEqual(['l1']);
    drive(selectTool(), ctx, ['W', { x: -1, y: -3 }, { x: 5, y: 3 }, 'P', '']);
    expect([...ctx.selection].sort()).toEqual(['l1', 'l2']);
    expect(ctx.prompts).toContain('Select objects:');
    expect(ctx.logs.some((l) => /found/.test(l))).toBe(true);
  });
  it('keywords typed at another command\'s Select objects prompt', () => {
    const ctx = fakeContext();
    ctx.doc.addEntities(ents);
    const ids = new Set<string>();
    expect(selectionKeyword('L', ctx, ids)).toBe(true);
    expect([...ids]).toEqual(['p1']);
    selectionHistory.previous = ['c1'];
    ids.clear();
    expect(selectionKeyword('p', ctx, ids)).toBe(true);
    expect([...ids]).toEqual(['c1']);
    expect(selectionKeyword('nonsense', ctx, ids)).toBe(false);
  });
  it('QSELECT filters by type, layer and colour', () => {
    expect(qselect(ents, { type: 'LINE' }).map((e) => e.id)).toEqual(['l1', 'l2']);
    expect(qselect(ents, { layer: 'tags' }).map((e) => e.id)).toEqual(['t1']);
    expect(qselect(ents, { type: '*', color: 'ByLayer' })).toHaveLength(5);
    const ctx = fakeContext();
    ctx.doc.addEntities(ents);
    drive(qselectTool('circle'), ctx, []);
    expect([...ctx.selection]).toEqual(['c1']);
    drive(qselectTool(), ctx, ['Text', 'TAGS', '']);
    expect([...ctx.selection]).toEqual(['t1']);
  });
  it('wildcards in names', () => {
    expect(wildcardMatch('WIRE*', 'WIRES')).toBe(true);
    expect(wildcardMatch('W?RES,TAGS', 'tags')).toBe(true);
    expect(wildcardMatch('WIRE', 'WIRES')).toBe(false);
  });
});

describe('object snap additions and tracking', () => {
  it('tangent points from an external point', () => {
    const t = tangentPoints({ x: 2, y: 0 }, { x: 0, y: 0 }, 1);
    expect(t).toHaveLength(2);
    for (const p of t) {
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(1);
      // radius is perpendicular to the tangent
      expect(p.x * (p.x - 2) + p.y * p.y).toBeCloseTo(0);
    }
    expect(tangentPoints({ x: 0.5, y: 0 }, { x: 0, y: 0 }, 1)).toHaveLength(0);
  });
  it('tangent and node snaps are found when enabled', () => {
    const s = { ...defaultSnapSettings(), endpoint: false, midpoint: false, center: false, intersection: false, perpendicular: false, tangent: true, node: true };
    const [t1] = tangentPoints({ x: 12, y: 10 }, { x: 10, y: 10 }, 1);
    const r = findObjectSnap({ x: t1!.x + 0.02, y: t1!.y }, ents, lookup, s, 0.2, { x: 12, y: 10 }, new Set());
    expect(r?.kind).toBe('tangent');
    expect(findObjectSnap({ x: 20.05, y: 20 }, ents, lookup, s, 0.2, null, new Set())?.kind).toBe('node');
    expect(findObjectSnap({ x: 20.05, y: 20 }, ents, lookup, { ...s, node: false }, 0.2, null, new Set())).toBeNull();
  });
  it('OSMODE bit field round trips', () => {
    const s = defaultSnapSettings();
    const v = osmode(s);
    expect(v & 1).toBe(1); // endpoint
    expect(v & 256).toBe(0); // tangent off
    applyOsmode(s, 1 | 256);
    expect(s.tangent).toBe(true);
    expect(s.midpoint).toBe(false);
  });
  it('tracking snaps to orthogonal alignment paths and their intersections', () => {
    const s = { ...defaultSnapSettings(), otrack: true };
    expect(trackingAngles(s)).toEqual([0, Math.PI / 2]);
    const single = trackFromPoints({ x: 5, y: 0.05 }, [{ x: 0, y: 0 }], s, 0.2)!;
    expect(single.point).toEqual({ x: 5, y: 0 });
    expect(single.paths).toHaveLength(1);
    const cross = trackFromPoints({ x: 4.1, y: 3.05 }, [{ x: 4, y: 0 }, { x: 0, y: 3 }], s, 0.2)!;
    expect(cross.point.x).toBeCloseTo(4);
    expect(cross.point.y).toBeCloseTo(3);
    expect(cross.paths).toHaveLength(2);
    expect(trackFromPoints({ x: 5, y: 5 }, [{ x: 0, y: 0 }], s, 0.2)).toBeNull();
    // polar tracking adds 45° paths
    const polar = { ...s, polarTracking: true, polarIncrement: 45 };
    expect(trackingAngles(polar)).toHaveLength(4);
    expect(trackFromPoints({ x: 3, y: 3.05 }, [{ x: 0, y: 0 }], polar, 0.2)?.point.y).toBeCloseTo(3.025);
  });
});
