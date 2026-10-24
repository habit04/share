import { describe, it, expect } from 'vitest';
import type { UnderlayEntity } from '../src/core/entities';
import {
  entityTypeName, underlayFramePoints, underlayParts, compoundParts, entityBounds,
  distanceToEntity, gripPoints, moveGrip, snapCandidates, entitySegments,
  translateEntity, rotateEntity, scaleEntityBy, mirrorEntityAcross, blockTransform,
  explodeCompound, entityGeometryWork,
} from '../src/core/entities';
import { geometryProblem } from '../src/io/import-report';

// P28 wiring, stage A (RULING-P28 C4): the UnderlayEntity variant in the
// entity union and its exhaustive-consumer behaviour. Transforms move the
// placement (position / rotation / scales / clip) and must never touch
// definitionHandle, retainedGroups, or the definition's stored path (the
// path is not on the entity at all).

const props = { layer: 'U', color: 'ByLayer' as const };
const lookup = () => undefined;
const underlay = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', ...props, type: 'underlay', kind: 'pdf', definitionHandle: 'AB',
  position: { x: 10, y: 20 }, scaleX: 2, scaleY: 3, rotation: 0, flags: 2,
  retainedGroups: [[291, 'kept']], ...over,
});

describe('UnderlayEntity consumers', () => {
  it('type name is the DXF record name per kind', () => {
    expect(entityTypeName(underlay())).toBe('PDFUNDERLAY');
    expect(entityTypeName(underlay({ kind: 'dwf' }))).toBe('DWFUNDERLAY');
    expect(entityTypeName(underlay({ kind: 'dgn' }))).toBe('DGNUNDERLAY');
  });

  it('frame points are the unit frame under the placement transform', () => {
    expect(underlayFramePoints(underlay())).toEqual([
      { x: 10, y: 20 }, { x: 12, y: 20 }, { x: 12, y: 23 }, { x: 10, y: 23 },
    ]);
    const rot = underlayFramePoints(underlay({ rotation: Math.PI / 2, scaleX: 1, scaleY: 1, position: { x: 0, y: 0 } }));
    expect(rot[1]!.x).toBeCloseTo(0);
    expect(rot[1]!.y).toBeCloseTo(1);
    expect(rot[2]!.x).toBeCloseTo(-1);
  });

  it('parts are frame + cross, with no label (a label needs a real definition)', () => {
    const e = underlay();
    const parts = underlayParts(e);
    expect(parts.map((p) => p.type)).toEqual(['polyline', 'line', 'line']);
    expect(compoundParts(e, undefined)).toBe(parts);
    expect(parts.some((p) => p.type === 'text')).toBe(false);
  });

  it('bounds, hit distance, grips, snaps and segments all see the frame', () => {
    const e = underlay();
    expect(entityBounds(e, lookup)).toEqual({ min: { x: 10, y: 20 }, max: { x: 12, y: 23 } });
    expect(distanceToEntity({ x: 11, y: 21 }, e, lookup)).toBe(0);
    expect(distanceToEntity({ x: 20, y: 21 }, e, lookup)).toBeGreaterThan(0);
    expect(gripPoints(e)).toHaveLength(4);
    expect(snapCandidates(e, lookup)).toHaveLength(5);
    expect(entitySegments(e, lookup).length).toBeGreaterThanOrEqual(6);
    const moved = moveGrip(e, 0, { x: 0, y: 0 }) as UnderlayEntity;
    expect(moved.position).toEqual({ x: 0, y: 0 });
  });

  it('similarity transforms move the placement and never the reference', () => {
    const e = underlay({ clipBoundary: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
    const t = translateEntity(e, { x: 5, y: -5 }) as UnderlayEntity;
    expect(t.position).toEqual({ x: 15, y: 15 });
    expect(t.definitionHandle).toBe('AB');
    expect(t.retainedGroups).toBe(e.retainedGroups);
    const r = rotateEntity(e, { x: 10, y: 20 }, Math.PI / 2) as UnderlayEntity;
    expect(r.rotation).toBeCloseTo(Math.PI / 2);
    // The clip is definition-space (page) data: stored verbatim, never remapped.
    expect(r.clipBoundary).toBe(e.clipBoundary);
    expect(r.definitionHandle).toBe('AB');
    const s = scaleEntityBy(e, { x: 0, y: 0 }, 2) as UnderlayEntity;
    expect(s.scaleX).toBeCloseTo(4);
    expect(s.scaleY).toBeCloseTo(6);
    const m = mirrorEntityAcross(e, { x: 0, y: 0 }, { x: 0, y: 1 }) as UnderlayEntity;
    // The corner sequence maps exactly: the mirrored frame is the reflection
    // (all four corners — v0.6.4 review F-H: magnitudes alone turned a
    // MIRROR into a rotation, which only corners 0 and 1 could not tell).
    const before = underlayFramePoints(e);
    const after = underlayFramePoints(m);
    for (let i = 0; i < 4; i += 1) {
      expect(after[i]!.x).toBeCloseTo(-before[i]!.x);
      expect(after[i]!.y).toBeCloseTo(before[i]!.y);
    }
    expect(m.scaleY).toBeLessThan(0); // the reflection is carried by the Y scale sign (INSERT convention)
    expect(m.definitionHandle).toBe('AB');
    expect(m.retainedGroups).toBe(e.retainedGroups);
  });

  it('F-H: MIRROR over the X axis reflects the frame (10,20)…(10,21) to (10,-20)…(10,-21)', () => {
    const e = underlay({ position: { x: 10, y: 20 }, scaleX: 1, scaleY: 1, rotation: 0 });
    expect(underlayFramePoints(e)).toEqual([{ x: 10, y: 20 }, { x: 11, y: 20 }, { x: 11, y: 21 }, { x: 10, y: 21 }]);
    const m = mirrorEntityAcross(e, { x: 0, y: 0 }, { x: 1, y: 0 }) as UnderlayEntity;
    const expected = [{ x: 10, y: -20 }, { x: 11, y: -20 }, { x: 11, y: -21 }, { x: 10, y: -21 }];
    underlayFramePoints(m).forEach((p, i) => {
      expect(p.x).toBeCloseTo(expected[i]!.x);
      expect(p.y).toBeCloseTo(expected[i]!.y);
    });
    expect(m.scaleX).toBeCloseTo(1);
    expect(m.scaleY).toBeCloseTo(-1);
    // Mirroring twice restores the original handedness.
    const back = mirrorEntityAcross(m, { x: 0, y: 0 }, { x: 1, y: 0 }) as UnderlayEntity;
    expect(back.scaleY).toBeCloseTo(1);
    underlayFramePoints(back).forEach((p, i) => {
      expect(p.x).toBeCloseTo(underlayFramePoints(e)[i]!.x);
      expect(p.y).toBeCloseTo(underlayFramePoints(e)[i]!.y);
    });
  });

  it('block transform (affineCompound) scales the axes, leaves page-space data alone', () => {
    const e = underlay({ clipBoundary: [{ x: 0.5, y: 0.5 }] });
    const b = blockTransform(e, (p) => ({ x: p.x * 3, y: p.y * 3 }), 0, 3, 3, false) as UnderlayEntity;
    expect(b.scaleX).toBeCloseTo(6);
    expect(b.scaleY).toBeCloseTo(9);
    expect(b.clipBoundary).toBe(e.clipBoundary);
    expect(b.definitionHandle).toBe('AB');
    expect(b.retainedGroups).toBe(e.retainedGroups);
  });

  it('explode invents no decoded content: the exact return is null', () => {
    // A reference does not explode into its referent (the IMAGE precedent);
    // EXPLODE on an underlay is refused by returning null.
    expect(explodeCompound(underlay())).toBeNull();
  });

  it('geometry work charges the stored size: clip points + retained groups (C5)', () => {
    const hostile = underlay({
      clipBoundary: Array.from({ length: 500 }, (_, i) => ({ x: i, y: i })),
      retainedGroups: Array.from({ length: 300 }, () => [291, 'x'] as const),
    });
    expect(entityGeometryWork(hostile)).toBeGreaterThanOrEqual(800);
    expect(entityGeometryWork(underlay())).toBe(2); // base 1 + 1 retained group
  });

  it('geometryProblem gates a hand-built placement through the model validator', () => {
    expect(geometryProblem(underlay())).toBeNull();
    expect(geometryProblem(underlay({ definitionHandle: '' }))).toMatch(/definition reference/);
    expect(geometryProblem(underlay({ scaleX: 0 }))).toBeTruthy();
  });
});
