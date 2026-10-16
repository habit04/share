/**
 * Priority 30.3.4 — hardening and reference-constraint completeness
 * (design §8, slice 30.3.4).
 *
 * Reference completeness (§2.3): reference forms of EVERY dimensional
 * kind measure and report in diagnostics, never enter the variable
 * system, consume 0 DOF, and can never fail a solve. Suppressed
 * constraints behave the same way for solving purposes.
 *
 * Hardening (§5.5 input guards): malformed plain-data input — duplicate
 * entity ids, non-finite or missing geometry fields, empty polylines —
 * is refused as a validation-class failure with workUsed 0. It never
 * throws, never hangs, and never partially mutates.
 *
 * Case 15's solver-side half (§6/§7): a failed solve leaves the caller's
 * entities untouched; a successful one differs in exactly the entities
 * that had to move. (The document/transact half is 30.4.)
 */
import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity, PolylineEntity } from '../src/core/entities';
import type { Constraint, ConstraintSet } from '../src/core/constraints/model';
import { MAX_CONSTRAINTS, MAX_VARIABLES, analyzeConstraints, solveConstraints } from '../src/core/constraints/solve';

const base = { layer: '0', color: 'ByLayer' as const };
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ ...base, id, type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by } });
const circle = (id: string, cx: number, cy: number, r: number): CircleEntity => ({ ...base, id, type: 'circle', center: { x: cx, y: cy }, radius: r });
const arc = (id: string, cx: number, cy: number, r: number, a0: number, a1: number): ArcEntity => ({ ...base, id, type: 'arc', center: { x: cx, y: cy }, radius: r, startAngle: a0, endAngle: a1 });
const point = (id: string, x: number, y: number): PointEntity => ({ ...base, id, type: 'point', position: { x, y } });
const polyline = (id: string, pts: readonly (readonly [number, number])[], closed = false): PolylineEntity => ({
  ...base,
  id,
  type: 'polyline',
  points: pts.map(([x, y]) => ({ x, y })),
  closed,
});

const set = (...constraints: Constraint[]): ConstraintSet => ({ constraints });
const ref = (entityId: string, anchor: Constraint['refs'][number]['anchor'], index?: number) => ({ entityId, anchor, ...(index !== undefined ? { index } : {}) });
const byId = (entities: readonly Entity[]) => new Map(entities.map((e) => [e.id, e]));
const diag = (r: ReturnType<typeof solveConstraints>, id: string) => r.diagnostics.find((d) => d.constraintId === id);

// ---------------------------------------------------------------------------
// Reference completeness (§2.3) — every dimensional kind, every form
// ---------------------------------------------------------------------------

describe('reference completeness (§2.3)', () => {
  it('a reference angle measures the live angle and re-measures after driving motion', () => {
    // A along +X, B at 30°. First measure with only the reference
    // present; then drive B to 60° and check the reference re-measures.
    const A = line('A', 0, 0, 10, 0);
    const B = line('B', 0, 0, 8.660254037844387, 5); // 30°, length 10
    const entities = [A, B];
    const referenceOnly = solveConstraints(
      entities,
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('B', 'start')] },
        { id: 'ra', kind: 'angle', role: 'reference', refs: [ref('A', 'whole'), ref('B', 'whole')] },
      ),
    );
    expect(referenceOnly.ok).toBe(true);
    expect(diag(referenceOnly, 'ra')?.state).toBe('reference');
    expect(diag(referenceOnly, 'ra')?.measured).toBeCloseTo(Math.PI / 6, 12);
    // Reference consumes 0: only the two fixed constraints consume DOF.
    expect(referenceOnly.dof.nominalConsumed).toBe(4);

    const rotated = solveConstraints(
      entities,
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'fb', kind: 'fixed', role: 'driving', refs: [ref('B', 'start')] },
        { id: 'da', kind: 'angle', role: 'driving', value: Math.PI / 3, refs: [ref('A', 'whole'), ref('B', 'whole')] },
        { id: 'ra', kind: 'angle', role: 'reference', refs: [ref('A', 'whole'), ref('B', 'whole')] },
      ),
    );
    expect(rotated.ok).toBe(true);
    expect(diag(rotated, 'ra')?.measured).toBeCloseTo(Math.PI / 3, 9);
  });

  it('a reference diameter measures 2r and tracks a driving radius change', () => {
    const C = circle('C', 1, 2, 4);
    const result = solveConstraints(
      [C],
      set(
        { id: 'dr', kind: 'radius', role: 'driving', value: 7, refs: [ref('C', 'whole')] },
        { id: 'rd', kind: 'diameter', role: 'reference', refs: [ref('C', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    expect(diag(result, 'rd')?.state).toBe('reference');
    expect(diag(result, 'rd')?.measured).toBe(14);
    expect(result.dof.nominalConsumed).toBe(1); // only the driving radius
  });

  it('a reference radius on an arc measures the arc radius', () => {
    const A = arc('A', 0, 0, 6, 0, Math.PI / 2);
    const result = solveConstraints([A], set({ id: 'rr', kind: 'radius', role: 'reference', refs: [ref('A', 'whole')] }));
    expect(result.ok).toBe(true);
    expect(diag(result, 'rr')).toMatchObject({ state: 'reference', measured: 6 });
    expect(result.dof.total).toBe(0); // reference-only entities do not participate
  });

  it('a reference distance in length form measures the segment and re-measures after a drive', () => {
    const L = line('L', 0, 0, 3, 4); // length 5
    const before = solveConstraints([L], set({ id: 'rd', kind: 'distance', role: 'reference', refs: [ref('L', 'whole')] }));
    expect(diag(before, 'rd')?.measured).toBe(5);
    const after = solveConstraints(
      [L],
      set(
        { id: 'dd', kind: 'distance', role: 'driving', value: 10, refs: [ref('L', 'whole')] },
        { id: 'rd', kind: 'distance', role: 'reference', refs: [ref('L', 'whole')] },
      ),
    );
    expect(after.ok).toBe(true);
    expect(diag(after, 'rd')?.measured).toBeCloseTo(10, 9);
  });

  it('a reference point–line distance measures the perpendicular distance', () => {
    const L = line('L', 0, 0, 10, 0);
    const P = point('P', 3, 4);
    const result = solveConstraints(
      [L, P],
      set({ id: 'rd', kind: 'distance', role: 'reference', refs: [ref('P', 'position'), ref('L', 'whole')] }),
    );
    expect(result.ok).toBe(true);
    expect(diag(result, 'rd')).toMatchObject({ state: 'reference', measured: 4 });
  });

  it('reference distance modes measure |Δx| and |Δy| respectively', () => {
    const P = point('P', 0, 0);
    const Q = point('Q', -3, 4);
    const result = solveConstraints(
      [P, Q],
      set(
        { id: 'rh', kind: 'distance', role: 'reference', distanceMode: 'horizontal', refs: [ref('P', 'position'), ref('Q', 'position')] },
        { id: 'rv', kind: 'distance', role: 'reference', distanceMode: 'vertical', refs: [ref('P', 'position'), ref('Q', 'position')] },
      ),
    );
    expect(result.ok).toBe(true);
    expect(diag(result, 'rh')?.measured).toBe(3);
    expect(diag(result, 'rv')?.measured).toBe(4);
  });

  it('a reference still reports its measurement when a sibling constraint fails validation', () => {
    const C = circle('C', 0, 0, 5);
    const result = solveConstraints(
      [C],
      set(
        { id: 'rr', kind: 'radius', role: 'reference', refs: [ref('C', 'whole')] },
        { id: 'orphan', kind: 'distance', role: 'driving', value: 3, refs: [ref('C', 'center'), ref('GONE', 'position')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validation-failed');
    expect(result.problems?.map((p) => p.code)).toContain('missing-reference');
    // Set-level refusal — but the reference diagnostic is still a live
    // measurement against the (unchanged) input geometry, not a blank.
    expect(diag(result, 'rr')).toMatchObject({ state: 'reference', measured: 5 });
  });

  it('a reference never fails a solve: a conflicting driving system stays conflicting, the reference stays a measurement', () => {
    const A = line('A', 0, 0, 10, 0);
    const B = line('B', 0, 5, 10, 9);
    const result = solveConstraints(
      [A, B],
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'pa', kind: 'parallel', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
        { id: 'pe', kind: 'perpendicular', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
        { id: 'rd', kind: 'distance', role: 'reference', refs: [ref('A', 'start'), ref('B', 'start')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe('conflicting');
    expect(diag(result, 'rd')?.state).toBe('reference');
    expect(diag(result, 'rd')?.measured).toBe(5);
  });

  it('a suppressed driving constraint reports suppressed, measures, consumes 0 and does not drive', () => {
    const C = circle('C', 0, 0, 4);
    const result = solveConstraints([C], set({ id: 'sr', kind: 'radius', role: 'driving', value: 9, suppressed: true, refs: [ref('C', 'whole')] }));
    expect(result.ok).toBe(true);
    expect(diag(result, 'sr')).toMatchObject({ state: 'suppressed', measured: 4 });
    expect(result.dof.nominalConsumed).toBe(0);
    expect(result.entities![0]).toBe(C); // nothing was driven to 9
  });
});

// ---------------------------------------------------------------------------
// Input guards (§5.5): malformed plain data is refused, never crashes
// ---------------------------------------------------------------------------

describe('input guards (§5.5)', () => {
  it('duplicate entity ids are refused — two entities may not share the id every ref resolves through', () => {
    const first = line('L', 0, 0, 10, 1);
    const second = line('L', 100, 100, 110, 105);
    const result = solveConstraints(
      [first, second],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
        { id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validation-failed');
    expect(result.workUsed).toBe(0);
    expect(result.problems?.map((p) => p.code)).toContain('duplicate-entity');
    expect(result.entities).toBeUndefined();
  });

  it('a zero-point polyline is refused instead of aliasing the next entity’s variables', () => {
    const empty = { ...base, id: 'PL', type: 'polyline', points: [], closed: false } as unknown as PolylineEntity;
    const P = point('P', 3, 4);
    const result = solveConstraints(
      [empty, P],
      set({ id: 'c', kind: 'coincident', role: 'driving', refs: [ref('PL', 'start'), ref('P', 'position')] }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validation-failed');
    expect(result.problems?.map((p) => p.code)).toContain('invalid-value');
    expect(result.workUsed).toBe(0);
  });

  it('a one-point polyline stays legal: its start anchor behaves as a point', () => {
    const one = polyline('PL', [[1, 1]]);
    const P = point('P', 3, 4);
    const result = solveConstraints(
      [one, P],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('P', 'position')] },
        { id: 'c', kind: 'coincident', role: 'driving', refs: [ref('PL', 'start'), ref('P', 'position')] },
      ),
    );
    expect(result.ok).toBe(true);
    const out = byId(result.entities!);
    expect((out.get('PL') as PolylineEntity).points).toEqual([{ x: 3, y: 4 }]);
  });

  it('a line with a missing endpoint field is a refusal, not a throw', () => {
    const broken = { ...base, id: 'L', type: 'line', a: { x: 0, y: 0 } } as unknown as LineEntity;
    const result = solveConstraints([broken], set({ id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] }));
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validation-failed');
    expect(result.problems?.map((p) => p.code)).toContain('invalid-value');
  });

  it('a polyline with a missing points field is a refusal, not a throw', () => {
    const broken = { ...base, id: 'PL', type: 'polyline', closed: false } as unknown as PolylineEntity;
    const L = line('L', 0, 0, 5, 0);
    const result = solveConstraints(
      [broken, L],
      set({ id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] }),
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('validation-failed');
    expect(result.problems?.map((p) => p.code)).toContain('invalid-value');
  });

  it('NaN and Infinity smuggled into geometry fields are refused with workUsed 0', () => {
    const nanVertex = { ...base, id: 'PL', type: 'polyline', points: [{ x: 0, y: 0 }, { x: NaN, y: 2 }], closed: false } as unknown as PolylineEntity;
    const r1 = solveConstraints([nanVertex], set({ id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('PL', 'segment', 0)] }));
    expect(r1.failure?.code).toBe('validation-failed');
    expect(r1.workUsed).toBe(0);

    const infArc = arc('A', 0, 0, 5, 0, Infinity);
    const r2 = solveConstraints([infArc], set({ id: 'r', kind: 'radius', role: 'driving', value: 6, refs: [ref('A', 'whole')] }));
    expect(r2.failure?.code).toBe('validation-failed');
    expect(r2.workUsed).toBe(0);

    const huge = circle('C', 1e16, 0, 5);
    const r3 = solveConstraints([huge], set({ id: 'r', kind: 'radius', role: 'driving', value: 6, refs: [ref('C', 'whole')] }));
    expect(r3.failure?.code).toBe('validation-failed');
  });

  it('a NaN polyline index is an invalid-anchor problem, not a crash', () => {
    const PL = polyline('PL', [
      [0, 0],
      [1, 1],
    ]);
    const result = solveConstraints([PL], set({ id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('PL', 'segment', NaN)] }));
    expect(result.ok).toBe(false);
    expect(result.problems?.map((p) => p.code)).toContain('invalid-anchor');
  });
});

// ---------------------------------------------------------------------------
// Structural edge cases
// ---------------------------------------------------------------------------

describe('structural edge cases', () => {
  it('an empty constraint set solves vacuously: ok, input identity, no work', () => {
    const L = line('L', 0, 0, 10, 1);
    const entities = [L];
    const result = solveConstraints(entities, set());
    expect(result.ok).toBe(true);
    // §5.6's formula on an empty system: remaining = 0 ⇒ fully-constrained.
    expect(result.status).toBe('fully-constrained');
    expect(result.dof.total).toBe(0); // nothing participates
    expect(result.workUsed).toBe(0);
    expect(result.entities![0]).toBe(L);
  });

  it('an empty entity list with an empty set is ok; with a constraint it is missing-reference', () => {
    const okResult = solveConstraints([], set());
    expect(okResult.ok).toBe(true);
    expect(okResult.entities).toEqual([]);
    const bad = solveConstraints([], set({ id: 'r', kind: 'radius', role: 'reference', refs: [ref('C', 'whole')] }));
    expect(bad.ok).toBe(false);
    expect(bad.problems?.map((p) => p.code)).toContain('missing-reference');
  });

  it('one entity through several anchors: a line’s own start↔end distance drives its length', () => {
    const L = line('L', 0, 0, 3, 4); // length 5
    const result = solveConstraints(
      [L],
      set(
        { id: 'f', kind: 'fixed', role: 'driving', refs: [ref('L', 'start')] },
        { id: 'd', kind: 'distance', role: 'driving', value: 10, refs: [ref('L', 'start'), ref('L', 'end')] },
        { id: 'h', kind: 'horizontal', role: 'driving', refs: [ref('L', 'whole')] },
      ),
    );
    expect(result.ok).toBe(true);
    const solved = byId(result.entities!).get('L') as LineEntity;
    expect(Math.hypot(solved.b.x - solved.a.x, solved.b.y - solved.a.y)).toBeCloseTo(10, 9);
    // The fixed corner is rebuilt from stage-3 variables, so it carries
    // solver noise far below every §5.5 tolerance (cf. slice-2 case 1).
    expect(Math.hypot(solved.a.x, solved.a.y)).toBeLessThanOrEqual(1e-9);
    expect(solved.b.y).toBeCloseTo(0, 9); // horizontal won over the original slope
  });
});

// ---------------------------------------------------------------------------
// Caps at the boundary (§5.5): at-cap solves, over-cap refuses at 0 work
// ---------------------------------------------------------------------------

describe('size caps at the boundary (§5.5)', () => {
  it(`exactly MAX_VARIABLES (${MAX_VARIABLES}) variables solves; the rank probe honestly reports its budget fallback`, () => {
    // 256 points = 512 variables, chained coincident with the first fixed.
    const entities: Entity[] = [];
    const constraints: Constraint[] = [{ id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('P0', 'position')] }];
    for (let i = 0; i < 256; i += 1) entities.push(point(`P${i}`, i * 0.37, (i % 7) * 1.3));
    for (let i = 1; i < 256; i += 1) {
      constraints.push({ id: `c${i}`, kind: 'coincident', role: 'driving', refs: [ref(`P${i - 1}`, 'position'), ref(`P${i}`, 'position')] });
    }
    const result = solveConstraints(entities, set(...constraints));
    expect(result.ok).toBe(true);
    for (const e of result.entities!) {
      expect((e as PointEntity).position).toEqual({ x: 0, y: 0 }); // all adopted P0
    }
    // The Jacobian rank probe costs rows×vars = 512×512 > SOLVE_WORK_LIMIT,
    // so per-entity remaining is the §3.3 stated unknown (-1), never a
    // silently-reported full DOF. analyzeConstraints agrees.
    expect(result.dof.perEntity.every((p) => p.remaining === -1)).toBe(true);
    const analysis = analyzeConstraints(entities, set(...constraints));
    expect(analysis.dof.perEntity.every((p) => p.remaining === -1)).toBe(true);
  });

  it(`exactly MAX_CONSTRAINTS (${MAX_CONSTRAINTS}) active constraints solves`, () => {
    // 64 points tied by a coincident web (1023 distinct pairs) plus one
    // fixed point grounding the web: stage 2 adopts every point onto P0,
    // so the at-cap system discharges without relaxation. 1024 distinct
    // signatures — no duplicates.
    const entities: Entity[] = [];
    for (let i = 0; i < 64; i += 1) entities.push(point(`P${i}`, (i % 8) * 3.1, Math.floor(i / 8) * 2.7));
    const constraints: Constraint[] = [{ id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('P0', 'position')] }];
    let n = 0;
    for (let i = 0; i < 64 && n < MAX_CONSTRAINTS - 1; i += 1) {
      for (let j = i + 1; j < 64 && n < MAX_CONSTRAINTS - 1; j += 1) {
        constraints.push({ id: `k${n}`, kind: 'coincident', role: 'driving', refs: [ref(`P${i}`, 'position'), ref(`P${j}`, 'position')] });
        n += 1;
      }
    }
    expect(constraints).toHaveLength(MAX_CONSTRAINTS);
    const result = solveConstraints(entities, set(...constraints));
    expect(result.ok).toBe(true);
    for (const e of result.entities!) {
      expect((e as PointEntity).position).toEqual({ x: 0, y: 0 }); // all adopted P0 exactly
    }
  });

  it('an at-cap system whose relaxation exceeds the work budget fails honestly (the caps gate admission; §5.5’s budget governs solving)', () => {
    // The same 64 points tied by 1024 horizontal/vertical pair forms:
    // admitted (nothing refuses at the cap check), but the relaxation
    // Jacobian charge is rows×vars per iteration, so the designed
    // SOLVE_WORK_LIMIT stops it mid-solve — workUsed > 0, no result.
    const entities: Entity[] = [];
    for (let i = 0; i < 64; i += 1) entities.push(point(`P${i}`, (i % 8) * 3.1, Math.floor(i / 8) * 2.7));
    const constraints: Constraint[] = [];
    let n = 0;
    for (let i = 0; i < 64 && n < MAX_CONSTRAINTS; i += 1) {
      for (let j = i + 1; j < 64 && n < MAX_CONSTRAINTS; j += 1) {
        constraints.push({
          id: `k${n}`,
          kind: n % 2 === 0 ? 'horizontal' : 'vertical',
          role: 'driving',
          refs: [ref(`P${i}`, 'position'), ref(`P${j}`, 'position')],
        });
        n += 1;
      }
    }
    const result = solveConstraints(entities, set(...constraints));
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('work-limit-exceeded');
    expect(result.workUsed).toBeGreaterThan(0);
    expect(result.entities).toBeUndefined();
  }, 60_000);

  it(`MAX_CONSTRAINTS + 1 active constraints refuse before stage 1 with workUsed 0`, () => {
    const entities: Entity[] = [];
    for (let i = 0; i < 64; i += 1) entities.push(point(`P${i}`, i, i * 2));
    const constraints: Constraint[] = [];
    let n = 0;
    for (let i = 0; i < 64 && n < MAX_CONSTRAINTS + 1; i += 1) {
      for (let j = i + 1; j < 64 && n < MAX_CONSTRAINTS + 1; j += 1) {
        constraints.push({
          id: `k${n}`,
          kind: n % 2 === 0 ? 'horizontal' : 'vertical',
          role: 'driving',
          refs: [ref(`P${i}`, 'position'), ref(`P${j}`, 'position')],
        });
        n += 1;
      }
    }
    const result = solveConstraints(entities, set(...constraints));
    expect(result.ok).toBe(false);
    expect(result.failure?.code).toBe('work-limit-exceeded');
    expect(result.workUsed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cancellation between stages (§5.5 poll points)
// ---------------------------------------------------------------------------

describe('cancellation between stages (§5.5)', () => {
  it('a token tripped during stage-2 construction cancels with partial work charged', () => {
    // Case-13 geometry discharges entirely in stage 2 (no stage 3), so a
    // trip after the first few polls lands inside construction.
    const C1 = circle('C1', 0, 0, 3);
    const C2 = circle('C2', 9, 9, 8);
    const entities = [C1, C2];
    const constraints = set(
      { id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('C1', 'center')] },
      { id: 'con', kind: 'concentric', role: 'driving', refs: [ref('C1', 'whole'), ref('C2', 'whole')] },
      { id: 'eq', kind: 'equal', role: 'driving', refs: [ref('C1', 'whole'), ref('C2', 'whole')] },
      { id: 'rad', kind: 'radius', role: 'driving', value: 5, refs: [ref('C1', 'whole')] },
    );
    const control = solveConstraints(entities, constraints);
    expect(control.ok).toBe(true);

    let reads = 0;
    const token = {
      get cancelled() {
        reads += 1;
        return reads > 4; // pre-component polls pass; a stage-2 pass poll trips
      },
    };
    const cut = solveConstraints(entities, constraints, { token });
    expect(cut.ok).toBe(false);
    expect(cut.failure?.code).toBe('cancelled');
    expect(cut.entities).toBeUndefined();
    expect(cut.workUsed).toBeGreaterThan(0);
    expect(cut.workUsed).toBeLessThan(control.workUsed);
  });
});

// ---------------------------------------------------------------------------
// §7 case 15, solver-side half: the adapter contract (§6)
// ---------------------------------------------------------------------------

describe('adapter contract (§6, case 15 solver side)', () => {
  it('a failed solve leaves the caller’s entities untouched — same objects, same order, no result array', () => {
    const A = line('A', 0, 0, 10, 0);
    const B = line('B', 0, 5, 10, 9);
    const entities: readonly Entity[] = [A, B];
    const result = solveConstraints(
      entities,
      set(
        { id: 'fa', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
        { id: 'pa', kind: 'parallel', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
        { id: 'pe', kind: 'perpendicular', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
      ),
    );
    expect(result.ok).toBe(false);
    expect(result.entities).toBeUndefined();
    expect(entities[0]).toBe(A);
    expect(entities[1]).toBe(B);
    expect(entities).toHaveLength(2);
  });

  it('a successful solve returns a new array differing in exactly the entities that had to move', () => {
    // §7 case 1's motion, from scratch: width driven to 16 on a grounded
    // 10-wide rectangle moves the bottom line's free end, both vertical
    // lines and the top line; the left line's endpoints are already where
    // every constraint wants them, so it keeps object identity.
    const bottom = line('bottom', 0, 0, 10, 0);
    const right = line('right', 10, 0, 10, 5);
    const top = line('top', 10, 5, 0, 5);
    const left = line('left', 0, 5, 0, 0);
    const entities: readonly Entity[] = [bottom, right, top, left];
    const constraints = set(
      { id: 'c1', kind: 'coincident', role: 'driving', refs: [ref('bottom', 'end'), ref('right', 'start')] },
      { id: 'c2', kind: 'coincident', role: 'driving', refs: [ref('right', 'end'), ref('top', 'start')] },
      { id: 'c3', kind: 'coincident', role: 'driving', refs: [ref('top', 'end'), ref('left', 'start')] },
      { id: 'c4', kind: 'coincident', role: 'driving', refs: [ref('left', 'end'), ref('bottom', 'start')] },
      { id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('bottom', 'start')] },
      { id: 'hb', kind: 'horizontal', role: 'driving', refs: [ref('bottom', 'whole')] },
      { id: 'ht', kind: 'horizontal', role: 'driving', refs: [ref('top', 'whole')] },
      { id: 'vr', kind: 'vertical', role: 'driving', refs: [ref('right', 'whole')] },
      { id: 'vl', kind: 'vertical', role: 'driving', refs: [ref('left', 'whole')] },
      { id: 'w', kind: 'distance', role: 'driving', value: 16, refs: [ref('bottom', 'start'), ref('bottom', 'end')] },
      { id: 'h', kind: 'distance', role: 'driving', value: 5, refs: [ref('left', 'start'), ref('left', 'end')] },
    );
    const result = solveConstraints(entities, constraints);
    expect(result.ok).toBe(true);
    expect(result.entities).not.toBe(entities);
    const movedIds = result.entities!.filter((e, i) => e !== entities[i]).map((e) => e.id).sort();
    expect(movedIds).toEqual(['bottom', 'right', 'top']);
    expect(result.entities![3]).toBe(left); // unmoved keeps identity
    // The caller's array is untouched.
    expect(entities[0]).toBe(bottom);
    expect(entities[1]).toBe(right);
    expect(entities[2]).toBe(top);
  });
});
