import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity } from '../src/core/entities';
import type { Constraint, ConstraintSet } from '../src/core/constraints/model';
import { analyzeConstraints, solveConstraints } from '../src/core/constraints/solve';

// Review round 2 (2026-10-16), solver items C01–C03 — my own regression
// shapes for the review's three acceptance cases (the review files
// themselves are never committed).

const base = { layer: '0', color: 'ByLayer' as const };
const ref = (entityId: string, anchor: Constraint['refs'][number]['anchor']) => ({ entityId, anchor });
const set = (...constraints: Constraint[]): ConstraintSet => ({ constraints });

describe('round 2 C03 — QR work budget', () => {
  const entities: PointEntity[] = [
    { ...base, id: 'P', type: 'point', position: { x: 0, y: 0 } },
    { ...base, id: 'Q', type: 'point', position: { x: 10, y: 0 } },
  ];
  const constraints = set({ id: 'distance', kind: 'distance', role: 'driving', value: 10.0000001, refs: [ref('P', 'position'), ref('Q', 'position')] });

  it('a solve whose QR work crosses the explicit cap refuses with no changed geometry', () => {
    const result = solveConstraints(entities, constraints, { workLimit: 26 });
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('work-limit-exceeded');
    expect(result.entities).toBeUndefined();
    expect(result.workUsed).toBeLessThanOrEqual(26 + 25); // charged, never silently unbounded
  });

  it('control: the same system solves under the default limit', () => {
    const result = solveConstraints(entities, constraints);
    expect(result.ok).toBe(true);
    const [p, q] = result.entities! as PointEntity[];
    expect(Math.hypot(q!.position.x - p!.position.x, q!.position.y - p!.position.y)).toBeCloseTo(10.0000001, 7);
  });
});

describe('round 2 C01 — materialization at accepted world offsets', () => {
  it('a driving radius reached internally is installed at centre offset 1e13', () => {
    const circle: CircleEntity = { ...base, id: 'C', type: 'circle', center: { x: 1e13, y: 0 }, radius: 10 };
    const constraints = set({ id: 'radius', kind: 'radius', role: 'driving', value: 11, refs: [ref('C', 'whole')] });
    const solved = solveConstraints([circle], constraints);
    expect(solved.ok).toBe(true);
    expect((solved.entities![0] as CircleEntity).radius).toBeCloseTo(11, 8);
    expect(solved.diagnostics[0]!.state).toBe('satisfied');
  });

  it('a driving distance reached by translation is installed at offset 1e13', () => {
    const entities: PointEntity[] = [
      { ...base, id: 'P', type: 'point', position: { x: 1e13, y: 0 } },
      { ...base, id: 'Q', type: 'point', position: { x: 1e13 + 10, y: 0 } },
    ];
    const constraints = set({ id: 'distance', kind: 'distance', role: 'driving', value: 11, refs: [ref('P', 'position'), ref('Q', 'position')] });
    const solved = solveConstraints(entities, constraints);
    expect(solved.ok).toBe(true);
    const [p, q] = solved.entities! as PointEntity[];
    expect(Math.hypot(q!.position.x - p!.position.x, q!.position.y - p!.position.y)).toBeCloseTo(11, 4);
  });

  it('control: ordinary-scale radius solve and untouched-entity identity are unchanged', () => {
    const circle: CircleEntity = { ...base, id: 'C', type: 'circle', center: { x: 0, y: 0 }, radius: 10 };
    const anchor: PointEntity = { ...base, id: 'A', type: 'point', position: { x: 50, y: 50 } };
    const constraints = set(
      { id: 'radius', kind: 'radius', role: 'driving', value: 11, refs: [ref('C', 'whole')] },
      { id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('A', 'position')] },
    );
    const solved = solveConstraints([circle, anchor], constraints);
    expect(solved.ok).toBe(true);
    expect((solved.entities![0] as CircleEntity).radius).toBeCloseTo(11, 9);
    expect(solved.entities![1]).toBe(anchor);
  });
});

describe('round 2 C02 — manifold-implied tangency stays redundant at any offset', () => {
  const constraints = set(
    { id: 'fixed-start', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
    { id: 'horizontal', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] },
    { id: 'vertical-center', kind: 'vertical', role: 'driving', refs: [ref('L', 'start'), ref('C', 'center')] },
    { id: 'point-on-circle', kind: 'coincident', role: 'driving', refs: [ref('L', 'start'), ref('C', 'whole')] },
    { id: 'length', kind: 'distance', role: 'driving', value: 10, refs: [ref('L', 'whole')] },
    { id: 'tangent', kind: 'tangent', role: 'driving', refs: [ref('L', 'whole'), ref('C', 'whole')] },
  );
  // Tangency is implied on the whole solution family (every r > 0 with
  // centre (offset, r) is exact): the tangent consumes nothing.
  for (const [radius, offset] of [[5, 0], [8, 0], [5, 1e6], [8, 1e6]] as const) {
    it(`r=${radius} at offset ${offset}: remaining 1, tangent redundant`, () => {
      const line: LineEntity = { ...base, id: 'L', type: 'line', a: { x: offset, y: 0 }, b: { x: offset + 10, y: 0 } };
      const circle: CircleEntity = { ...base, id: 'C', type: 'circle', center: { x: offset, y: radius }, radius };
      const entities: Entity[] = [line, circle];
      const analysis = analyzeConstraints(entities, constraints);
      expect(analysis.status).toBe('underconstrained');
      expect(analysis.dof.remaining).toBe(1);
      const solved = solveConstraints(entities, constraints);
      expect(solved.ok).toBe(true);
      expect(solved.dof.remaining).toBe(1);
      expect(solved.diagnostics.find((d) => d.constraintId === 'tangent')?.state).toBe('redundant');
    });
  }

  it('control: a fold tangent (arc start coincident with its tangent line) genuinely consumes', () => {
    // Arc centre (0,0) r 4, start at angle 0 = (4,0); line from the arc
    // start (4,0) to (4,3) is tangent to the arc's circle there. The
    // tangent row is a pointwise combination of the coincident rows at
    // this exact configuration ONLY (F-3034-2): it consumes a real DOF.
    const arc: ArcEntity = { ...base, id: 'A', type: 'arc', center: { x: 0, y: 0 }, radius: 4, startAngle: 0, endAngle: Math.PI / 2 };
    const line: LineEntity = { ...base, id: 'L', type: 'line', a: { x: 4, y: 0 }, b: { x: 4, y: 3 } };
    const cons = set(
      { id: 'fix-centre', kind: 'fixed', role: 'driving', refs: [ref('A', 'center')] },
      { id: 'radius', kind: 'radius', role: 'driving', value: 4, refs: [ref('A', 'whole')] },
      { id: 'co', kind: 'coincident', role: 'driving', refs: [ref('L', 'start'), ref('A', 'start')] },
      { id: 'tan', kind: 'tangent', role: 'driving', refs: [ref('L', 'whole'), ref('A', 'whole')] },
    );
    const analysis = analyzeConstraints([arc, line], cons);
    // total DOF 9; consumed: fixed 2 + radius 1 + coincident 2 + tangent 1 = 6.
    expect(analysis.dof.effectiveConsumed).toBe(6);
    expect(analysis.dof.remaining).toBe(3);
  });
});
