/**
 * Priority 30.3.1 — bounded 2D constraint solver (design §5), first slice.
 *
 * Coverage in this slice: model + validation (validate.ts), DOF accounting,
 * stage-1 analysis, stage-2 direct construction rules 1–6 (`fixed`,
 * `coincident` point↔point, `concentric`, `horizontal`/`vertical`,
 * `equal` radius, `radius`/`diameter`), and the stage-3 damped
 * Gauss–Newton skeleton exercised by coincident cycles. Kinds scheduled
 * for later slices (parallel, perpendicular, distance, angle, tangent,
 * equal length, point-on-object coincident) are validated by the model
 * but refused here with 'unsupported-constraint' — never silently ignored,
 * because a driving constraint the solver skipped would fake success.
 *
 * Pure and deterministic: same input ⇒ same output, bit-for-bit. Work is
 * bounded by an integer counter, never a timer. A failed or cancelled
 * solve returns no entities; inputs are never mutated, so the document
 * is unchanged by construction (design §6).
 */
import { dist, normAngle, type Point } from '../geometry';
import type { Entity } from '../entities';
import {
  anchorKey,
  entityDof,
  isConstrainable,
  nominalConsumption,
  resolveAnchorPoint,
  segmentEndpoints,
  type ConstrainableEntity,
  type Constraint,
  type ConstraintSet,
} from './model';
import { resolveShape, validateConstraints, type ConstraintProblem, type ConstraintShape, type Side } from './validate';

// ---------------------------------------------------------------------------
// Fixed constants (design §5.5). Exported for tests; NOT user settings.
// They change only by spec revision — never to make a test pass.
// ---------------------------------------------------------------------------

export const RESIDUAL_TOL = 1e-9;
export const STEP_TOL = 1e-10;
export const CONFLICT_TOL = 1e-6;
export const DEGENERATE_REL = 1e-12;
export const MAX_VARIABLES = 512;
export const MAX_CONSTRAINTS = 1024;
export const MAX_ITERATIONS = 50;
export const SOLVE_WORK_LIMIT = 200_000;
/** Variable movement below CHANGE_EPS_FACTOR · S counts as unmoved. */
export const CHANGE_EPS_FACTOR = 1e-12;

// ---------------------------------------------------------------------------
// Public result shapes (design §5.1, §3.3)
// ---------------------------------------------------------------------------

export type SolveStatus = 'fully-constrained' | 'underconstrained' | 'conflicting' | 'unsolved';

export type SolveFailureCode =
  | 'conflicting-constraints'
  | 'degenerate-geometry'
  | 'work-limit-exceeded'
  | 'iteration-limit'
  | 'numeric-failure'
  | 'cancelled'
  /** A validation problem (§4 / input guards) stopped the solve before
   *  stage 1; the problems themselves are in `SolveResult.problems`. */
  | 'validation-failed'
  /** An active driving constraint whose kind/shape belongs to a later
   *  30.3 slice. Not in the design's §5.7 list (which assumes the full
   *  engine); refusing atomically is the honest slice-1 behavior. */
  | 'unsupported-constraint';

export interface SolveOptions {
  readonly token?: { readonly cancelled: boolean };
  /** Test-only override (design §5.1); default SOLVE_WORK_LIMIT. */
  readonly workLimit?: number;
}

export interface DofReport {
  readonly total: number;
  readonly nominalConsumed: number;
  readonly effectiveConsumed: number;
  readonly remaining: number;
  readonly perEntity: readonly { readonly entityId: string; readonly dof: number; readonly remaining: number }[];
}

export interface ConstraintDiagnostic {
  readonly constraintId: string;
  readonly state: 'satisfied' | 'violated' | 'redundant' | 'unresolved' | 'suppressed' | 'reference';
  /** Max normalized residual over the constraint's rows (0 for reference /
   *  suppressed, whose states carry the information instead). */
  readonly residual: number;
  /** Live measured value for dimensional constraints (driving + reference). */
  readonly measured?: number;
}

export interface SolveNote {
  readonly code: 'bulge-carried';
  readonly entityId: string;
  readonly constraintId?: string;
}

export interface SolveResult {
  readonly ok: boolean;
  readonly status: SolveStatus;
  /** Present iff ok: a NEW array; unmoved entities keep object identity. */
  readonly entities?: readonly Entity[];
  readonly dof: DofReport;
  readonly diagnostics: readonly ConstraintDiagnostic[];
  readonly notes: readonly SolveNote[];
  readonly failure?: { readonly code: SolveFailureCode; readonly constraintIds: readonly string[]; readonly message: string };
  readonly problems?: readonly ConstraintProblem[];
  readonly workUsed: number;
}

export interface AnalysisResult {
  readonly problems: readonly ConstraintProblem[];
  readonly dof: DofReport;
  readonly diagnostics: readonly ConstraintDiagnostic[];
  /** Null when validation problems exist. 'unsolved' here means "not
   *  satisfied at current geometry" — analysis never claims a conflict,
   *  which requires a stationary point (design §5.6). */
  readonly status: SolveStatus | null;
}

// ---------------------------------------------------------------------------
// Variable layout and point expressions
// ---------------------------------------------------------------------------

interface EntVars {
  readonly entity: ConstrainableEntity;
  readonly inputIndex: number;
  offset: number; // index of the entity's first variable in the working array
  readonly count: number;
}

function varCount(e: ConstrainableEntity): number {
  return entityDof(e);
}

function readVars(e: ConstrainableEntity, out: Float64Array, offset: number): void {
  switch (e.type) {
    case 'point':
      out[offset] = e.position.x;
      out[offset + 1] = e.position.y;
      break;
    case 'line':
      out[offset] = e.a.x;
      out[offset + 1] = e.a.y;
      out[offset + 2] = e.b.x;
      out[offset + 3] = e.b.y;
      break;
    case 'circle':
      out[offset] = e.center.x;
      out[offset + 1] = e.center.y;
      out[offset + 2] = e.radius;
      break;
    case 'arc':
      out[offset] = e.center.x;
      out[offset + 1] = e.center.y;
      out[offset + 2] = e.radius;
      out[offset + 3] = e.startAngle;
      out[offset + 4] = e.endAngle;
      break;
    case 'polyline':
      e.points.forEach((p, i) => {
        out[offset + 2 * i] = p.x;
        out[offset + 2 * i + 1] = p.y;
      });
      break;
  }
}

interface Deriv {
  readonly v: number;
  readonly px: number;
  readonly py: number;
}

/** A point anchor expressed over the working variables, with analytic
 *  derivatives (∂p/∂var as (px, py) pairs). */
interface PointExpr {
  readonly vars: readonly number[];
  /** Set when the expr is exactly a variable pair (x = vars[at], y = +1):
   *  stage 2 may adopt coordinates into it directly. */
  readonly varPair: number | null;
  readonly midOf: readonly [PointExpr, PointExpr] | null;
  eval(vars: Float64Array): Point;
  derivs(vars: Float64Array): readonly Deriv[];
}

function varPairExpr(at: number): PointExpr {
  return {
    vars: [at, at + 1],
    varPair: at,
    midOf: null,
    eval: (vars) => ({ x: vars[at]!, y: vars[at + 1]! }),
    derivs: () => [
      { v: at, px: 1, py: 0 },
      { v: at + 1, px: 0, py: 1 },
    ],
  };
}

function midExpr(a: PointExpr, b: PointExpr): PointExpr {
  const vars = [...new Set([...a.vars, ...b.vars])];
  return {
    vars,
    varPair: null,
    midOf: [a, b],
    eval: (vs) => {
      const pa = a.eval(vs);
      const pb = b.eval(vs);
      return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 };
    },
    derivs: (vs) => {
      const merged = new Map<number, { px: number; py: number }>();
      for (const d of [...a.derivs(vs), ...b.derivs(vs)]) {
        const m = merged.get(d.v) ?? { px: 0, py: 0 };
        m.px += d.px / 2;
        m.py += d.py / 2;
        merged.set(d.v, m);
      }
      return [...merged].map(([v, m]) => ({ v, px: m.px, py: m.py }));
    },
  };
}

function arcEndExpr(centerAt: number, radiusVar: number, angleVar: number): PointExpr {
  const vars = [centerAt, centerAt + 1, radiusVar, angleVar];
  return {
    vars,
    varPair: null,
    midOf: null,
    eval: (vs) => {
      const r = vs[radiusVar]!;
      const a = vs[angleVar]!;
      return { x: vs[centerAt]! + r * Math.cos(a), y: vs[centerAt + 1]! + r * Math.sin(a) };
    },
    derivs: (vs) => {
      const r = vs[radiusVar]!;
      const a = vs[angleVar]!;
      return [
        { v: centerAt, px: 1, py: 0 },
        { v: centerAt + 1, px: 0, py: 1 },
        { v: radiusVar, px: Math.cos(a), py: Math.sin(a) },
        { v: angleVar, px: -r * Math.sin(a), py: r * Math.cos(a) },
      ];
    },
  };
}

/** Build the point expression for a validated point-anchor side, against a
 *  layout lookup (entity id → EntVars). */
function pointExpr(side: Side, layout: ReadonlyMap<string, EntVars>): PointExpr {
  const ev = layout.get(side.entity.id)!;
  const o = ev.offset;
  const e = side.entity;
  const ref = side.ref;
  switch (e.type) {
    case 'point':
      return varPairExpr(o);
    case 'line':
      if (ref.anchor === 'start') return varPairExpr(o);
      if (ref.anchor === 'end') return varPairExpr(o + 2);
      return midExpr(varPairExpr(o), varPairExpr(o + 2)); // midpoint
    case 'circle':
      return varPairExpr(o); // center
    case 'arc':
      if (ref.anchor === 'center') return varPairExpr(o);
      if (ref.anchor === 'start') return arcEndExpr(o, o + 2, o + 3);
      return arcEndExpr(o, o + 2, o + 4); // end
    case 'polyline': {
      const n = e.points.length;
      const vertex = (i: number) => varPairExpr(o + 2 * (e.closed ? i % n : i));
      if (ref.anchor === 'start') return vertex(0);
      if (ref.anchor === 'end') return vertex(e.closed ? 0 : n - 1);
      if (ref.anchor === 'vertex') return vertex(ref.index!);
      // midpoint of segment `index`
      const i = e.closed ? ref.index! % n : ref.index!;
      return midExpr(vertex(i), vertex(i + 1));
    }
  }
}

function radiusVar(side: Side, layout: ReadonlyMap<string, EntVars>): number {
  return layout.get(side.entity.id)!.offset + 2;
}

/** The two endpoint expressions of a segment side (line 'whole' / polyline
 *  'segment'). */
function segmentExprs(side: Side, layout: ReadonlyMap<string, EntVars>): readonly [PointExpr, PointExpr] {
  const ev = layout.get(side.entity.id)!;
  const o = ev.offset;
  const e = side.entity;
  if (e.type === 'line') return [varPairExpr(o), varPairExpr(o + 2)];
  const n = (e as Extract<ConstrainableEntity, { type: 'polyline' }>).points.length;
  const pl = e as Extract<ConstrainableEntity, { type: 'polyline' }>;
  const i = pl.closed ? side.ref.index! % n : side.ref.index!;
  return [varPairExpr(o + 2 * i), varPairExpr(o + 2 * ((i + 1) % n))];
}

// ---------------------------------------------------------------------------
// Residuals (design §5.4) — slice-1 forms, normalized by S
// ---------------------------------------------------------------------------

interface ResidualSet {
  readonly constraint: Constraint;
  readonly rowCount: number;
  /** Union of variables this constraint's rows read. */
  readonly vars: readonly number[];
  eval(vars: Float64Array, out: Float64Array, at: number): void;
  /** Dense Jacobian rows over the component's variables. */
  jac(vars: Float64Array, out: Float64Array, rowAt: number, nVars: number): void;
}

function pointPairResidual(c: Constraint, a: PointExpr, b: PointExpr, S: number): ResidualSet {
  const vars = [...new Set([...a.vars, ...b.vars])];
  const rows = (vars_: Float64Array, out: Float64Array, at: number) => {
    const pa = a.eval(vars_);
    const pb = b.eval(vars_);
    out[at] = (pb.x - pa.x) / S;
    out[at + 1] = (pb.y - pa.y) / S;
  };
  return {
    constraint: c,
    rowCount: 2,
    vars,
    eval: rows,
    jac: (vars_, out, rowAt, nVars) => {
      for (const d of b.derivs(vars_)) {
        out[rowAt * nVars + d.v] += d.px / S;
        out[(rowAt + 1) * nVars + d.v] += d.py / S;
      }
      for (const d of a.derivs(vars_)) {
        out[rowAt * nVars + d.v] -= d.px / S;
        out[(rowAt + 1) * nVars + d.v] -= d.py / S;
      }
    },
  };
}

function fixedResidual(c: Constraint, p: PointExpr, p0: Point, S: number): ResidualSet {
  return {
    constraint: c,
    rowCount: 2,
    vars: p.vars,
    eval: (vars, out, at) => {
      const pp = p.eval(vars);
      out[at] = (pp.x - p0.x) / S;
      out[at + 1] = (pp.y - p0.y) / S;
    },
    jac: (vars, out, rowAt, nVars) => {
      for (const d of p.derivs(vars)) {
        out[rowAt * nVars + d.v] += d.px / S;
        out[(rowAt + 1) * nVars + d.v] += d.py / S;
      }
    },
  };
}

function hvResidual(c: Constraint, p: PointExpr, q: PointExpr, S: number): ResidualSet {
  const horizontal = c.kind === 'horizontal';
  const vars = [...new Set([...p.vars, ...q.vars])];
  return {
    constraint: c,
    rowCount: 1,
    vars,
    eval: (vs, out, at) => {
      const pp = p.eval(vs);
      const pq = q.eval(vs);
      out[at] = (horizontal ? pq.y - pp.y : pq.x - pp.x) / S;
    },
    jac: (vs, out, rowAt, nVars) => {
      for (const d of q.derivs(vs)) out[rowAt * nVars + d.v] += (horizontal ? d.py : d.px) / S;
      for (const d of p.derivs(vs)) out[rowAt * nVars + d.v] -= (horizontal ? d.py : d.px) / S;
    },
  };
}

function scalarResidual(c: Constraint, vars: readonly number[], value: (vs: Float64Array) => number, grads: readonly { v: number; g: number }[]): ResidualSet {
  return {
    constraint: c,
    rowCount: 1,
    vars,
    eval: (vs, out, at) => {
      out[at] = value(vs);
    },
    jac: (_vs, out, rowAt, nVars) => {
      for (const { v, g } of grads) out[rowAt * nVars + v] += g;
    },
  };
}

/** Slice-1 supported shapes. Everything else returns null (unsupported in
 *  this slice) — the caller refuses, never skips. */
function buildResidual(c: Constraint, shape: ConstraintShape, layout: ReadonlyMap<string, EntVars>, S: number): ResidualSet | null {
  switch (shape.form) {
    case 'coincident-points':
      return pointPairResidual(c, pointExpr(shape.a, layout), pointExpr(shape.b, layout), S);
    case 'concentric':
      return pointPairResidual(c, pointExpr({ entity: shape.a.entity, ref: { entityId: shape.a.entity.id, anchor: 'center' } }, layout), pointExpr({ entity: shape.b.entity, ref: { entityId: shape.b.entity.id, anchor: 'center' } }, layout), S);
    case 'fixed': {
      const expr = pointExpr(shape.point, layout);
      const p0 = resolveAnchorPoint(shape.point.entity, shape.point.ref);
      return fixedResidual(c, expr, p0, S);
    }
    case 'hv-segment': {
      const [p, q] = segmentExprs(shape.seg, layout);
      return hvResidual(c, p, q, S);
    }
    case 'hv-points':
      return hvResidual(c, pointExpr(shape.a, layout), pointExpr(shape.b, layout), S);
    case 'equal-radius': {
      const ra = radiusVar(shape.a, layout);
      const rb = radiusVar(shape.b, layout);
      return scalarResidual(c, [ra, rb], (vs) => (vs[rb]! - vs[ra]!) / S, [
        { v: ra, g: -1 / S },
        { v: rb, g: 1 / S },
      ]);
    }
    case 'radius': {
      const r = radiusVar(shape.target, layout);
      const target = c.kind === 'diameter' ? c.value! / 2 : c.value!;
      return scalarResidual(c, [r], (vs) => (vs[r]! - target) / S, [{ v: r, g: 1 / S }]);
    }
    default:
      return null;
  }
}

function shapeEntities(shape: ConstraintShape): readonly Side[] {
  switch (shape.form) {
    case 'coincident-points':
    case 'hv-points':
    case 'direction-pair':
    case 'equal-length':
    case 'equal-radius':
    case 'concentric':
    case 'tangent':
      return [shape.a, shape.b];
    case 'coincident-object':
      return [shape.point, shape.object];
    case 'hv-segment':
    case 'distance-length':
      return [shape.seg];
    case 'fixed':
      return [shape.point];
    case 'distance-points':
      return [shape.a, shape.b];
    case 'distance-point-line':
      return [shape.point, shape.seg];
    case 'radius':
      return [shape.target];
  }
}

function shapeSupported(shape: ConstraintShape): boolean {
  switch (shape.form) {
    case 'coincident-points':
    case 'concentric':
    case 'fixed':
    case 'hv-segment':
    case 'hv-points':
    case 'equal-radius':
    case 'radius':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Small dense linear algebra (Gaussian elimination with partial pivoting)
// ---------------------------------------------------------------------------

/** Numerical rank of a dense m×n matrix; pivot threshold 1e-10 relative to
 *  the largest entry (design §5.6). Optionally restricted to a column subset. */
function denseRank(J: Float64Array, m: number, n: number, cols?: readonly number[]): number {
  const useCols = cols ?? Array.from({ length: n }, (_, i) => i);
  const k = useCols.length;
  if (m === 0 || k === 0) return 0;
  const a = new Float64Array(m * k);
  let maxAbs = 0;
  for (let r = 0; r < m; r += 1) {
    for (let c = 0; c < k; c += 1) {
      const v = J[r * n + useCols[c]!]!;
      a[r * k + c] = v;
      if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
    }
  }
  if (maxAbs === 0) return 0;
  const tol = 1e-10 * maxAbs;
  let rank = 0;
  let row = 0;
  for (let col = 0; col < k && row < m; col += 1) {
    let piv = -1;
    let best = tol;
    for (let r = row; r < m; r += 1) {
      const v = Math.abs(a[r * k + col]!);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (piv < 0) continue;
    for (let c = 0; c < k; c += 1) {
      const t = a[row * k + c]!;
      a[row * k + c] = a[piv * k + c]!;
      a[piv * k + c] = t;
    }
    const pv = a[row * k + col]!;
    for (let r = row + 1; r < m; r += 1) {
      const f = a[r * k + col]! / pv;
      if (f === 0) continue;
      for (let c = col; c < k; c += 1) a[r * k + c] = a[r * k + c]! - f * a[row * k + c]!;
    }
    rank += 1;
    row += 1;
  }
  return rank;
}

/** Solve A x = b (dense n×n) with partial pivoting. Returns null when
 *  singular at the §5.4 pivot threshold (1e-12 relative). */
function solveDense(A0: Float64Array, b0: Float64Array, n: number): Float64Array | null {
  if (n === 0) return new Float64Array(0);
  const a = new Float64Array(A0);
  const b = new Float64Array(b0);
  let maxAbs = 0;
  for (const v of a) if (Math.abs(v) > maxAbs) maxAbs = Math.abs(v);
  if (maxAbs === 0) return null;
  const tol = 1e-12 * maxAbs;
  for (let col = 0; col < n; col += 1) {
    let piv = -1;
    let best = tol;
    for (let r = col; r < n; r += 1) {
      const v = Math.abs(a[r * n + col]!);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (piv < 0) return null;
    if (piv !== col) {
      for (let c = 0; c < n; c += 1) {
        const t = a[col * n + c]!;
        a[col * n + c] = a[piv * n + c]!;
        a[piv * n + c] = t;
      }
      const tb = b[col]!;
      b[col] = b[piv]!;
      b[piv] = tb;
    }
    const pv = a[col * n + col]!;
    for (let r = col + 1; r < n; r += 1) {
      const f = a[r * n + col]! / pv;
      if (f === 0) continue;
      for (let c = col; c < n; c += 1) a[r * n + c] = a[r * n + c]! - f * a[col * n + c]!;
      b[r] = b[r]! - f * b[col]!;
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r -= 1) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c += 1) s -= a[r * n + c]! * x[c]!;
    x[r] = s / a[r * n + r]!;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Preparation: validation + input guards + shapes + participation
// ---------------------------------------------------------------------------

interface ActiveC {
  readonly c: Constraint;
  readonly shape: ConstraintShape;
}

interface Prep {
  readonly problems: readonly ConstraintProblem[];
  readonly byId: ReadonlyMap<string, Entity>;
  /** Active (driving, non-suppressed) constraints with resolvable shapes, stored order. */
  readonly active: readonly ActiveC[];
  readonly unsupported: readonly Constraint[];
  readonly participating: readonly ConstrainableEntity[];
  readonly totalVars: number;
  readonly nominalConsumed: number;
}

function guardProblems(entities: readonly Entity[]): ConstraintProblem[] {
  const problems: ConstraintProblem[] = [];
  const bad = (e: Entity, what: string) =>
    problems.push({ code: 'invalid-value', entityId: e.id, message: `Entity '${e.id}' (${e.type}) has ${what}; the solver refuses non-finite or out-of-range input.` });
  for (const e of entities) {
    if (!isConstrainable(e)) continue;
    const nums: number[] = [];
    switch (e.type) {
      case 'point':
        nums.push(e.position.x, e.position.y);
        break;
      case 'line':
        nums.push(e.a.x, e.a.y, e.b.x, e.b.y);
        break;
      case 'circle':
        nums.push(e.center.x, e.center.y, e.radius);
        if (!(e.radius > 0)) bad(e, 'a non-positive radius');
        break;
      case 'arc':
        nums.push(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle);
        if (!(e.radius > 0)) bad(e, 'a non-positive radius');
        break;
      case 'polyline':
        for (const p of e.points) nums.push(p.x, p.y);
        break;
    }
    if (nums.some((v) => !Number.isFinite(v) || Math.abs(v) > 1e15)) bad(e, 'a non-finite coordinate or a coordinate beyond 1e15');
  }
  return problems;
}

function prepare(entities: readonly Entity[], set: ConstraintSet): Prep {
  const byId = new Map<string, Entity>(entities.map((e) => [e.id, e]));
  const problems: ConstraintProblem[] = [...guardProblems(entities), ...validateConstraints(entities, set)];
  const active: ActiveC[] = [];
  const unsupported: Constraint[] = [];
  const participatingIds = new Set<string>();
  let nominalConsumed = 0;

  if (problems.length === 0) {
    for (const c of set.constraints) {
      if (c.suppressed || c.role !== 'driving') continue;
      const sides = c.refs.map((ref) => ({ entity: byId.get(ref.entityId) as ConstrainableEntity, ref }));
      const shape = resolveShape(c, sides)!;
      active.push({ c, shape });
      nominalConsumed += nominalConsumption(c.kind, shape.form === 'coincident-object' ? 'point-object' : 'point-point');
      if (!shapeSupported(shape)) unsupported.push(c);
      for (const s of shapeEntities(shape)) participatingIds.add(s.entity.id);
    }
  } else {
    // Participation/nominal figures for the failure report only.
    for (const c of set.constraints) {
      if (c.suppressed || c.role !== 'driving') continue;
      nominalConsumed += nominalConsumption(c.kind, c.kind === 'coincident' && c.refs.some((r) => r.anchor === 'whole') ? 'point-object' : 'point-point');
      for (const r of c.refs) {
        const e = byId.get(r.entityId);
        if (e && isConstrainable(e)) participatingIds.add(e.id);
      }
    }
  }
  const participating = entities.filter((e): e is ConstrainableEntity => participatingIds.has(e.id) && isConstrainable(e));
  return {
    problems,
    byId,
    active,
    unsupported,
    participating,
    totalVars: participating.reduce((n, e) => n + varCount(e), 0),
    nominalConsumed,
  };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

interface Comp {
  readonly list: readonly EntVars[];
  readonly layout: ReadonlyMap<string, EntVars>;
  readonly active: readonly ActiveC[];
  readonly S: number;
  readonly vars0: Float64Array;
  readonly residuals: readonly ResidualSet[];
  readonly rowOffset: ReadonlyMap<string, number>;
  readonly totalRows: number;
}

function makeLayout(list: readonly ConstrainableEntity[], inputIndex: ReadonlyMap<string, number>): { list: EntVars[]; layout: Map<string, EntVars>; vars0: Float64Array } {
  const evs: EntVars[] = [];
  const layout = new Map<string, EntVars>();
  let offset = 0;
  for (const entity of list) {
    const ev: EntVars = { entity, inputIndex: inputIndex.get(entity.id)!, offset, count: varCount(entity) };
    offset += ev.count;
    evs.push(ev);
    layout.set(entity.id, ev);
  }
  const vars0 = new Float64Array(offset);
  for (const ev of evs) readVars(ev.entity, vars0, ev.offset);
  return { list: evs, layout, vars0 };
}

function buildComp(list: readonly ConstrainableEntity[], active: readonly ActiveC[], inputIndex: ReadonlyMap<string, number>): Comp {
  const { list: evs, layout, vars0 } = makeLayout(list, inputIndex);
  let S = 1;
  for (const v of vars0) if (Math.abs(v) > S) S = Math.abs(v);
  for (const { c } of active) if (c.value !== undefined && Math.abs(c.value) > S) S = Math.abs(c.value);
  const residuals = active.map(({ c, shape }) => buildResidual(c, shape, layout, S)!);
  const rowOffset = new Map<string, number>();
  let totalRows = 0;
  for (const r of residuals) {
    rowOffset.set(r.constraint.id, totalRows);
    totalRows += r.rowCount;
  }
  return { list: evs, layout, active, S, vars0, residuals, rowOffset, totalRows };
}

function buildComponents(prep: Prep, inputIndex: ReadonlyMap<string, number>): Comp[] {
  // Union-find over participating entity ids, joined by active constraints.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== cur) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  for (const e of prep.participating) parent.set(e.id, e.id);
  for (const { shape } of prep.active) {
    const sides = shapeEntities(shape);
    for (let i = 1; i < sides.length; i += 1) {
      const ra = find(sides[0]!.entity.id);
      const rb = find(sides[i]!.entity.id);
      if (ra !== rb) parent.set(rb, ra); // deterministic: first side's root wins (input order)
    }
  }
  const groups = new Map<string, ConstrainableEntity[]>();
  for (const e of prep.participating) {
    const root = find(e.id);
    const g = groups.get(root) ?? [];
    g.push(e);
    groups.set(root, g);
  }
  const comps: Comp[] = [];
  for (const g of groups.values()) {
    const ids = new Set(g.map((e) => e.id));
    const active = prep.active.filter(({ shape }) => shapeEntities(shape).every((s) => ids.has(s.entity.id)));
    comps.push(buildComp(g, active, inputIndex));
  }
  // Deterministic order: by first appearance of the earliest entity in input.
  comps.sort((a, b) => Math.min(...a.list.map((e) => e.inputIndex)) - Math.min(...b.list.map((e) => e.inputIndex)));
  return comps;
}

// ---------------------------------------------------------------------------
// Stage 2 — direct construction (design §5.3, rules 1–6)
// ---------------------------------------------------------------------------

interface Work {
  used: number;
  readonly limit: number;
}

type Poll = () => boolean;

function axisValue(expr: PointExpr, axis: 'x' | 'y', det: Uint8Array, vals: Float64Array): number | null {
  if (expr.varPair !== null) {
    const v = axis === 'x' ? expr.varPair : expr.varPair + 1;
    return det[v] ? vals[v]! : null;
  }
  if (expr.midOf) {
    const a = axisValue(expr.midOf[0], axis, det, vals);
    const b = axisValue(expr.midOf[1], axis, det, vals);
    return a !== null && b !== null ? (a + b) / 2 : null;
  }
  if (expr.vars.every((v) => det[v])) {
    const p = expr.eval(vals);
    return axis === 'x' ? p.x : p.y;
  }
  return null;
}

function fullyDetermined(expr: PointExpr, det: Uint8Array): boolean {
  return expr.vars.every((v) => det[v]);
}

/** Run stage 2 over a component. Returns the determined-value vector, or a
 *  failure code ('cancelled' | 'work-limit-exceeded'). */
function stage2(comp: Comp, work: Work, poll: Poll): { vals: Float64Array; det: Uint8Array } | { failure: 'cancelled' | 'work-limit-exceeded' } {
  const nVars = comp.vars0.length;
  const det = new Uint8Array(nVars);
  const vals = new Float64Array(comp.vars0);

  // Rules 2+3 chaining: union-find over point *nodes* keyed by anchor
  // identity, built from the coincident / concentric constraints directly —
  // constraints sharing an anchor merge into one adoption group.
  const nodeKey = (side: Side) => anchorKey(side.entity, side.ref);
  const uf = new Map<string, string>();
  const ufFind = (x: string): string => {
    let root = x;
    while ((uf.get(root) ?? root) !== root) root = uf.get(root)!;
    return root;
  };
  const ufUnion = (a: string, b: string) => {
    const ra = ufFind(a);
    const rb = ufFind(b);
    if (ra !== rb) uf.set(rb, ra);
  };
  interface NodeInfo {
    expr: PointExpr;
  }
  const nodes = new Map<string, NodeInfo>();
  const registerNode = (side: Side, expr: PointExpr) => {
    const k = nodeKey(side);
    if (!uf.has(k)) uf.set(k, k);
    if (!nodes.has(k)) nodes.set(k, { expr });
  };
  for (const { shape } of comp.active) {
    if (shape.form === 'coincident-points') {
      registerNode(shape.a, pointExpr(shape.a, comp.layout));
      registerNode(shape.b, pointExpr(shape.b, comp.layout));
      ufUnion(nodeKey(shape.a), nodeKey(shape.b));
    } else if (shape.form === 'concentric') {
      const centerSide = (s: Side): Side => ({ entity: s.entity, ref: { entityId: s.entity.id, anchor: 'center' } });
      registerNode(centerSide(shape.a), pointExpr(centerSide(shape.a), comp.layout));
      registerNode(centerSide(shape.b), pointExpr(centerSide(shape.b), comp.layout));
      ufUnion(nodeKey(centerSide(shape.a)), nodeKey(centerSide(shape.b)));
    }
  }

  /** Adopt the determined point of each merged node group into every
   *  direct-variable member. Returns the number of adoptions (work units). */
  const adoptGroups = (): number => {
    // group key (uf root) → member node keys, in registration order
    const byRoot = new Map<string, string[]>();
    for (const k of nodes.keys()) {
      const root = ufFind(k);
      const arr = byRoot.get(root) ?? [];
      arr.push(k);
      byRoot.set(root, arr);
    }
    let adoptions = 0;
    for (const keys of byRoot.values()) {
      if (keys.length < 2) continue;
      let source: Point | null = null;
      for (const k of keys) {
        const info = nodes.get(k)!;
        if (fullyDetermined(info.expr, det)) {
          source = info.expr.eval(vals);
          break;
        }
      }
      if (!source) continue;
      for (const k of keys) {
        const info = nodes.get(k)!;
        if (info.expr.varPair === null || fullyDetermined(info.expr, det)) continue;
        const at = info.expr.varPair;
        // Respect already-determined coordinates: a determined coordinate
        // that disagrees with the group point is a conflict for stage 3,
        // never an overwrite.
        const conflictX = det[at] && vals[at] !== source.x;
        const conflictY = det[at + 1] && vals[at + 1] !== source.y;
        if (conflictX || conflictY) continue;
        vals[at] = source.x;
        vals[at + 1] = source.y;
        det[at] = 1;
        det[at + 1] = 1;
        adoptions += 1;
      }
    }
    return adoptions;
  };

  let passes = 0;
  for (;;) {
    if (poll()) return { failure: 'cancelled' };
    if (work.used > work.limit) return { failure: 'work-limit-exceeded' };
    passes += 1;
    if (passes > nVars + 2) break; // each firing determines ≥1 variable; hard stop
    let fired = false;
    const fire = () => {
      fired = true;
      work.used += 1;
    };
    // Rule 1 — fixed grounds its anchor point (values are the entry values).
    for (const { shape } of comp.active) {
      if (shape.form !== 'fixed') continue;
      const expr = pointExpr(shape.point, comp.layout);
      let newly = false;
      for (const v of expr.vars) if (!det[v]) newly = true;
      if (newly) {
        for (const v of expr.vars) det[v] = 1;
        fire();
      }
    }
    // Rules 2+3 — coincident / concentric adoption over merged node groups.
    const adoptions = adoptGroups();
    if (adoptions > 0) {
      fired = true;
      work.used += adoptions;
    }
    // Rule 4 — horizontal / vertical coordinate copy.
    for (const { c, shape } of comp.active) {
      if (shape.form !== 'hv-segment' && shape.form !== 'hv-points') continue;
      const [p, q] =
        shape.form === 'hv-segment' ? segmentExprs(shape.seg, comp.layout) : [pointExpr(shape.a, comp.layout), pointExpr(shape.b, comp.layout)];
      const axis = c.kind === 'horizontal' ? 'y' : 'x';
      for (const [src, dst] of [
        [p, q],
        [q, p],
      ] as const) {
        const value = axisValue(src, axis, det, vals);
        if (value === null || dst.varPair === null) continue;
        const at = axis === 'x' ? dst.varPair : dst.varPair + 1;
        if (!det[at]) {
          vals[at] = value;
          det[at] = 1;
          fire();
        }
      }
    }
    // Rule 5 — equal radius copy.
    for (const { shape } of comp.active) {
      if (shape.form !== 'equal-radius') continue;
      const ra = radiusVar(shape.a, comp.layout);
      const rb = radiusVar(shape.b, comp.layout);
      if (det[ra] && !det[rb]) {
        vals[rb] = vals[ra]!;
        det[rb] = 1;
        fire();
      } else if (det[rb] && !det[ra]) {
        vals[ra] = vals[rb]!;
        det[ra] = 1;
        fire();
      }
    }
    // Rule 6 — radius / diameter set directly.
    for (const { c, shape } of comp.active) {
      if (shape.form !== 'radius') continue;
      const r = radiusVar(shape.target, comp.layout);
      if (!det[r]) {
        vals[r] = c.kind === 'diameter' ? c.value! / 2 : c.value!;
        det[r] = 1;
        fire();
      }
    }
    if (!fired) break;
  }
  return { vals, det };
}

// ---------------------------------------------------------------------------
// Stage 3 — bounded damped Gauss–Newton (design §5.4)
// ---------------------------------------------------------------------------

interface CompOutcome {
  readonly ok: boolean;
  readonly vars: Float64Array;
  readonly mag: ReadonlyMap<string, number>;
  readonly failure?: { readonly code: SolveFailureCode; readonly constraintIds: readonly string[]; readonly message: string };
}

function evalAll(comp: Comp, vars: Float64Array, work: Work): Float64Array {
  const out = new Float64Array(comp.totalRows);
  for (const r of comp.residuals) r.eval(vars, out, comp.rowOffset.get(r.constraint.id)!);
  work.used += comp.totalRows;
  return out;
}

function jacAll(comp: Comp, vars: Float64Array, work: Work): Float64Array {
  const nVars = comp.vars0.length;
  const J = new Float64Array(comp.totalRows * nVars);
  for (const r of comp.residuals) r.jac(vars, J, comp.rowOffset.get(r.constraint.id)!, nVars);
  work.used += comp.totalRows * nVars;
  return J;
}

function magMap(comp: Comp, r: Float64Array): Map<string, number> {
  const mag = new Map<string, number>();
  for (const rs of comp.residuals) {
    const at = comp.rowOffset.get(rs.constraint.id)!;
    let m = 0;
    for (let i = 0; i < rs.rowCount; i += 1) m = Math.max(m, Math.abs(r[at + i]!));
    mag.set(rs.constraint.id, m);
  }
  return mag;
}

function maxAbs(a: Float64Array): number {
  let m = 0;
  for (const v of a) if (Math.abs(v) > m) m = Math.abs(v);
  return m;
}

function solveComponent(comp: Comp, work: Work, poll: Poll): CompOutcome {
  const nVars = comp.vars0.length;
  // Stage 1 degenerate detection for slice-1 kinds (design §5.3): a
  // horizontal/vertical segment of ~zero length has no direction; a
  // concentric partner with ~zero radius is degenerate.
  for (const { c, shape } of comp.active) {
    if (shape.form === 'hv-segment') {
      const ends = segmentEndpoints(shape.seg.entity, shape.seg.ref)!;
      if (dist(ends[0], ends[1]) < DEGENERATE_REL * comp.S) {
        return {
          ok: false,
          vars: comp.vars0,
          mag: new Map(),
          failure: { code: 'degenerate-geometry', constraintIds: [c.id], message: `Constraint '${c.id}' (${c.kind}) references a zero-length segment, which has no direction.` },
        };
      }
    }
    if (shape.form === 'concentric') {
      for (const s of [shape.a, shape.b]) {
        const r = (s.entity as Extract<ConstrainableEntity, { type: 'circle' | 'arc' }>).radius;
        if (r < DEGENERATE_REL * comp.S) {
          return {
            ok: false,
            vars: comp.vars0,
            mag: new Map(),
            failure: { code: 'degenerate-geometry', constraintIds: [c.id], message: `Constraint '${c.id}' (concentric) references entity '${s.entity.id}' with a degenerate radius.` },
          };
        }
      }
    }
  }

  const s2 = stage2(comp, work, poll);
  if ('failure' in s2) {
    return {
      ok: false,
      vars: comp.vars0,
      mag: new Map(),
      failure: {
        code: s2.failure,
        constraintIds: comp.active.map((a) => a.c.id),
        message: s2.failure === 'cancelled' ? 'Solve cancelled.' : `Work limit of ${work.limit} exceeded during construction.`,
      },
    };
  }
  const { vals, det } = s2;

  // Which constraints did stage 2 discharge? Satisfied at the determined
  // values with every variable they read determined.
  const r0 = evalAll(comp, vals, work);
  const mag0 = magMap(comp, r0);
  const discharged = new Set<string>();
  for (const rs of comp.residuals) {
    if (rs.vars.every((v) => det[v]) && (mag0.get(rs.constraint.id) ?? Infinity) <= RESIDUAL_TOL) discharged.add(rs.constraint.id);
  }
  const freeSet = new Set<number>();
  for (const rs of comp.residuals) {
    if (discharged.has(rs.constraint.id)) continue;
    for (const v of rs.vars) freeSet.add(v);
  }
  if (freeSet.size === 0) {
    return { ok: true, vars: vals, mag: mag0 };
  }
  const free = [...freeSet].sort((a, b) => a - b);

  let x = new Float64Array(vals);
  let r = r0;
  let mag = mag0;
  if (maxAbs(r) <= RESIDUAL_TOL) return { ok: true, vars: x, mag };

  let lambda = 1e-3;
  let lastStep = Infinity;
  let iterations = 0;
  let converged = false;
  let stationary = false;
  for (iterations = 1; iterations <= MAX_ITERATIONS; iterations += 1) {
    if (poll()) {
      return { ok: false, vars: x, mag, failure: { code: 'cancelled', constraintIds: comp.active.map((a) => a.c.id), message: 'Solve cancelled.' } };
    }
    if (work.used > work.limit) {
      return { ok: false, vars: x, mag, failure: { code: 'work-limit-exceeded', constraintIds: comp.active.map((a) => a.c.id), message: `Work limit of ${work.limit} exceeded during relaxation.` } };
    }
    const J = jacAll(comp, x, work);
    // Normal equations over free variables: A = JfᵀJf, g = Jfᵀr.
    const f = free.length;
    const A = new Float64Array(f * f);
    const g = new Float64Array(f);
    for (let row = 0; row < comp.totalRows; row += 1) {
      for (let i = 0; i < f; i += 1) {
        const jiv = J[row * nVars + free[i]!]!;
        if (jiv === 0) continue;
        g[i] = g[i]! + jiv * r[row]!;
        for (let j = 0; j < f; j += 1) A[i * f + j] = A[i * f + j]! + jiv * J[row * nVars + free[j]!]!;
      }
    }
    let accepted = false;
    let step = new Float64Array(nVars);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const Ad = new Float64Array(A);
      for (let i = 0; i < f; i += 1) Ad[i * f + i] = Ad[i * f + i]! + lambda * (Ad[i * f + i]! !== 0 ? Math.abs(Ad[i * f + i]!) : 1);
      const neg = new Float64Array(f);
      for (let i = 0; i < f; i += 1) neg[i] = -g[i]!;
      const delta = solveDense(Ad, neg, f);
      if (delta === null) {
        lambda *= 10;
        if (lambda > 1e6) break;
        continue;
      }
      const trial = new Float64Array(x);
      step = new Float64Array(nVars);
      for (let i = 0; i < f; i += 1) {
        trial[free[i]!] = trial[free[i]!]! + delta[i]!;
        step[free[i]!] = delta[i]!;
      }
      if (![...trial].every((v) => Number.isFinite(v))) {
        lambda *= 10;
        if (lambda > 1e6) break;
        continue;
      }
      // Mid-solve degeneracy: a driven radius crossing the degenerate band.
      let degenerate = false;
      for (const ev of comp.list) {
        if (ev.entity.type === 'circle' || ev.entity.type === 'arc') {
          if (trial[ev.offset + 2]! < DEGENERATE_REL * comp.S) degenerate = true;
        }
      }
      if (degenerate) {
        return {
          ok: false,
          vars: x,
          mag,
          failure: { code: 'degenerate-geometry', constraintIds: comp.active.map((a) => a.c.id), message: 'A driven radius collapsed toward zero during the solve.' },
        };
      }
      const rTrial = evalAll(comp, trial, work);
      if (maxAbs(rTrial) < maxAbs(r)) {
        x = trial;
        r = rTrial;
        mag = magMap(comp, r);
        lastStep = maxAbs(step);
        lambda = Math.max(lambda / 10, 1e-12);
        accepted = true;
        break;
      }
      lambda *= 10;
      if (lambda > 1e6) break;
    }
    if (!accepted) {
      stationary = true;
      break;
    }
    if (maxAbs(r) <= RESIDUAL_TOL && lastStep <= STEP_TOL * comp.S) {
      converged = true;
      break;
    }
    if (lastStep <= STEP_TOL * comp.S && maxAbs(r) > RESIDUAL_TOL) {
      stationary = true;
      break;
    }
  }
  if (converged) return { ok: true, vars: x, mag };
  if (stationary || iterations > MAX_ITERATIONS) {
    const finalMag = maxAbs(r);
    if (stationary && finalMag > CONFLICT_TOL) {
      const ids = comp.active.filter((a) => (mag.get(a.c.id) ?? 0) > CONFLICT_TOL).map((a) => a.c.id);
      return {
        ok: false,
        vars: x,
        mag,
        failure: { code: 'conflicting-constraints', constraintIds: ids, message: `Constraints cannot be satisfied simultaneously (stationary residual ${finalMag}).` },
      };
    }
    if (stationary) {
      return {
        ok: false,
        vars: x,
        mag,
        failure: { code: 'numeric-failure', constraintIds: comp.active.filter((a) => (mag.get(a.c.id) ?? 0) > RESIDUAL_TOL).map((a) => a.c.id), message: 'The relaxation became stationary above the residual tolerance but below the conflict tolerance.' },
      };
    }
    return {
      ok: false,
      vars: x,
      mag,
      failure: { code: 'iteration-limit', constraintIds: comp.active.filter((a) => (mag.get(a.c.id) ?? 0) > RESIDUAL_TOL).map((a) => a.c.id), message: `Iteration limit (${MAX_ITERATIONS}) reached while still progressing.` },
    };
  }
  return { ok: true, vars: x, mag };
}

// ---------------------------------------------------------------------------
// Measured values and diagnostics
// ---------------------------------------------------------------------------

function measuredValue(c: Constraint, shape: ConstraintShape | null, byId: ReadonlyMap<string, Entity>): number | undefined {
  if (!shape) return undefined;
  // Measure against the geometry in `byId` (result geometry after a
  // successful solve, input geometry otherwise) — the shape's own entity
  // references point at the input, so re-resolve every side by id.
  const ent = (s: Side): ConstrainableEntity => (byId.get(s.entity.id) as ConstrainableEntity | undefined) ?? s.entity;
  try {
    switch (shape.form) {
      case 'radius': {
        const e = ent(shape.target) as Extract<ConstrainableEntity, { type: 'circle' | 'arc' }>;
        return c.kind === 'diameter' ? 2 * e.radius : e.radius;
      }
      case 'distance-points': {
        const p = resolveAnchorPoint(ent(shape.a), shape.a.ref);
        const q = resolveAnchorPoint(ent(shape.b), shape.b.ref);
        if (c.distanceMode === 'horizontal') return Math.abs(q.x - p.x);
        if (c.distanceMode === 'vertical') return Math.abs(q.y - p.y);
        return dist(p, q);
      }
      case 'distance-point-line': {
        const p = resolveAnchorPoint(ent(shape.point), shape.point.ref);
        const ends = segmentEndpoints(ent(shape.seg), shape.seg.ref)!;
        const d = dist(ends[0], ends[1]);
        if (d === 0) return dist(p, ends[0]);
        const ux = (ends[1].x - ends[0].x) / d;
        const uy = (ends[1].y - ends[0].y) / d;
        return Math.abs(ux * (p.y - ends[0].y) - uy * (p.x - ends[0].x));
      }
      case 'distance-length': {
        const ends = segmentEndpoints(ent(shape.seg), shape.seg.ref)!;
        return dist(ends[0], ends[1]);
      }
      case 'direction-pair': {
        if (c.kind !== 'angle') return undefined;
        const ea = segmentEndpoints(ent(shape.a), shape.a.ref)!;
        const eb = segmentEndpoints(ent(shape.b), shape.b.ref)!;
        const ta = Math.atan2(ea[1].y - ea[0].y, ea[1].x - ea[0].x);
        const tb = Math.atan2(eb[1].y - eb[0].y, eb[1].x - eb[0].x);
        return normAngle(tb - ta);
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

interface DiagContext {
  readonly magById: ReadonlyMap<string, number>;
  readonly redundant: ReadonlySet<string>;
  /** 'solved': driving states from residuals; 'conflict': violated marking;
   *  'failed': driving constraints are unresolved unless satisfied. */
  readonly mode: 'solved' | 'conflict' | 'failed';
  readonly geometry: readonly Entity[];
  readonly shapes: ReadonlyMap<string, ConstraintShape | null>;
}

function buildDiagnostics(set: ConstraintSet, ctx: DiagContext): ConstraintDiagnostic[] {
  const byId = new Map<string, Entity>(ctx.geometry.map((e) => [e.id, e]));
  return set.constraints.map((c) => {
    const shape = ctx.shapes.get(c.id) ?? null;
    if (c.suppressed) {
      return { constraintId: c.id, state: 'suppressed' as const, residual: 0, measured: measuredValue(c, shape, byId) };
    }
    if (c.role === 'reference') {
      return { constraintId: c.id, state: 'reference' as const, residual: 0, measured: measuredValue(c, shape, byId) };
    }
    const mag = ctx.magById.get(c.id);
    let state: ConstraintDiagnostic['state'];
    if (ctx.mode === 'solved') {
      state = ctx.redundant.has(c.id) ? 'redundant' : 'satisfied';
    } else if (ctx.mode === 'conflict') {
      state = mag !== undefined && mag > CONFLICT_TOL ? 'violated' : mag !== undefined && mag <= RESIDUAL_TOL ? 'satisfied' : 'unresolved';
    } else {
      state = mag !== undefined && mag <= RESIDUAL_TOL ? 'satisfied' : 'unresolved';
    }
    return {
      constraintId: c.id,
      state,
      residual: mag ?? 0,
      measured: measuredValue(c, shape, byId),
    };
  });
}

function shapeMap(prep: Prep, set: ConstraintSet, entities: readonly Entity[]): Map<string, ConstraintShape | null> {
  const byId = new Map<string, Entity>(entities.map((e) => [e.id, e]));
  const map = new Map<string, ConstraintShape | null>();
  for (const { c, shape } of prep.active) map.set(c.id, shape);
  for (const c of set.constraints) {
    if (map.has(c.id)) continue;
    const sides: Side[] = [];
    let ok = true;
    for (const ref of c.refs) {
      const e = byId.get(ref.entityId);
      if (!e || !isConstrainable(e)) {
        ok = false;
        break;
      }
      sides.push({ entity: e, ref });
    }
    map.set(c.id, ok ? resolveShape(c, sides) : null);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Materialization (design §5.1/§5.5): rebuild only entities whose variables
// moved beyond CHANGE_EPS; everything else keeps object identity.
// ---------------------------------------------------------------------------

function materialize(e: ConstrainableEntity, vars: Float64Array, offset: number): Entity {
  switch (e.type) {
    case 'point':
      return { ...e, position: { x: vars[offset]!, y: vars[offset + 1]! } };
    case 'line':
      return {
        ...e,
        a: { x: vars[offset]!, y: vars[offset + 1]! },
        b: { x: vars[offset + 2]!, y: vars[offset + 3]! },
      };
    case 'circle':
      return { ...e, center: { x: vars[offset]!, y: vars[offset + 1]! }, radius: vars[offset + 2]! };
    case 'arc':
      return {
        ...e,
        center: { x: vars[offset]!, y: vars[offset + 1]! },
        radius: vars[offset + 2]!,
        startAngle: vars[offset + 3]!,
        endAngle: vars[offset + 4]!,
      };
    case 'polyline':
      return {
        ...e,
        points: e.points.map((_, i) => ({ x: vars[offset + 2 * i]!, y: vars[offset + 2 * i + 1]! })),
      };
  }
}

// ---------------------------------------------------------------------------
// solveConstraints
// ---------------------------------------------------------------------------

export function solveConstraints(entities: readonly Entity[], set: ConstraintSet, options: SolveOptions = {}): SolveResult {
  const work: Work = { used: 0, limit: options.workLimit ?? SOLVE_WORK_LIMIT };
  const poll: Poll = () => options.token?.cancelled === true;
  const inputIndex = new Map<string, number>(entities.map((e, i) => [e.id, i] as const));
  const prep = prepare(entities, set);
  const shapes = shapeMap(prep, set, entities);
  const nominalDof = (): DofReport => ({
    total: prep.participating.reduce((n, e) => n + entityDof(e), 0),
    nominalConsumed: prep.nominalConsumed,
    effectiveConsumed: 0,
    remaining: prep.participating.reduce((n, e) => n + entityDof(e), 0),
    perEntity: prep.participating.map((e) => ({ entityId: e.id, dof: entityDof(e), remaining: entityDof(e) })),
  });
  const fail = (
    code: SolveFailureCode,
    constraintIds: readonly string[],
    message: string,
    extra?: Partial<SolveResult>,
  ): SolveResult => ({
    ok: false,
    status: code === 'conflicting-constraints' ? 'conflicting' : 'unsolved',
    dof: nominalDof(),
    diagnostics: buildDiagnostics(set, { magById: new Map(), redundant: new Set(), mode: code === 'conflicting-constraints' ? 'conflict' : 'failed', geometry: entities, shapes }),
    notes: [],
    failure: { code, constraintIds, message },
    workUsed: work.used,
    ...extra,
  });

  if (prep.problems.length > 0) {
    return fail('validation-failed', prep.problems.map((p) => p.constraintId).filter((x): x is string => x !== undefined), 'Constraint validation failed; no solve was attempted.', {
      problems: prep.problems,
      workUsed: 0,
    });
  }
  if (prep.totalVars > MAX_VARIABLES || prep.active.length > MAX_CONSTRAINTS) {
    return fail(
      'work-limit-exceeded',
      set.constraints.filter((c) => !c.suppressed && c.role === 'driving').map((c) => c.id),
      prep.totalVars > MAX_VARIABLES
        ? `System has ${prep.totalVars} variables, exceeding MAX_VARIABLES (${MAX_VARIABLES}).`
        : `System has more than MAX_CONSTRAINTS (${MAX_CONSTRAINTS}) active driving constraints.`,
      { workUsed: 0 },
    );
  }
  if (prep.unsupported.length > 0) {
    return fail(
      'unsupported-constraint',
      prep.unsupported.map((c) => c.id),
      `Constraint(s) ${prep.unsupported.map((c) => `'${c.id}' (${c.kind})`).join(', ')} belong to a later 30.3 slice and are not solved by this build.`,
    );
  }

  const comps = buildComponents(prep, inputIndex);
  const outcomes: CompOutcome[] = [];
  for (const comp of comps) {
    if (poll()) return fail('cancelled', comp.active.map((a) => a.c.id), 'Solve cancelled.');
    if (poll()) return fail('cancelled', comp.active.map((a) => a.c.id), 'Solve cancelled.');
    const outcome = solveComponent(comp, work, poll);
    outcomes.push(outcome);
    if (!outcome.ok && (outcome.failure!.code === 'cancelled' || outcome.failure!.code === 'work-limit-exceeded')) {
      return fail(outcome.failure!.code, outcome.failure!.constraintIds, outcome.failure!.message);
    }
  }

  const magById = new Map<string, number>();
  for (const o of outcomes) for (const [k, v] of o.mag) magById.set(k, v);

  const failures = outcomes.filter((o) => !o.ok);
  if (failures.length > 0) {
    const conflict = failures.find((f) => f.failure!.code === 'conflicting-constraints');
    const chosen = conflict ?? failures[0]!;
    const violatedIds = conflict
      ? set.constraints.filter((c) => (magById.get(c.id) ?? 0) > CONFLICT_TOL && !c.suppressed && c.role === 'driving').map((c) => c.id)
      : chosen.failure!.constraintIds;
    return {
      ok: false,
      status: conflict ? 'conflicting' : 'unsolved',
      dof: nominalDof(),
      diagnostics: buildDiagnostics(set, { magById, redundant: new Set(), mode: conflict ? 'conflict' : 'failed', geometry: entities, shapes }),
      notes: [],
      failure: { code: chosen.failure!.code, constraintIds: violatedIds, message: chosen.failure!.message },
      workUsed: work.used,
    };
  }

  if (poll()) return fail('cancelled', [], 'Solve cancelled.');

  // Materialize.
  const finalVarsByEntity = new Map<string, { vars: Float64Array; initial: Float64Array; ev: EntVars; S: number }>();
  comps.forEach((comp, i) => {
    const outcome = outcomes[i]!;
    for (const ev of comp.list) finalVarsByEntity.set(ev.entity.id, { vars: outcome.vars, initial: comp.vars0, ev, S: comp.S });
  });
  const resultEntities: Entity[] = entities.map((e) => {
    const fin = finalVarsByEntity.get(e.id);
    if (!fin) return e;
    let moved = false;
    for (let i = 0; i < fin.ev.count; i += 1) {
      if (Math.abs(fin.vars[fin.ev.offset + i]! - fin.initial[fin.ev.offset + i]!) > CHANGE_EPS_FACTOR * fin.S) moved = true;
    }
    return moved ? materialize(fin.ev.entity, fin.vars, fin.ev.offset) : e;
  });

  // Bulge-carried notes (design §2.5): a moved bulged polyline vertex.
  const notes: SolveNote[] = [];
  resultEntities.forEach((e, i) => {
    if (e === entities[i]) return;
    if (e.type === 'polyline' && e.bulges?.some((b) => b !== 0)) {
      const first = set.constraints.find((c) => !c.suppressed && c.role === 'driving' && c.refs.some((r) => r.entityId === e.id));
      notes.push({ code: 'bulge-carried', entityId: e.id, constraintId: first?.id });
    }
  });

  // DOF rank machinery at the result (design §5.6/§3.3).
  let effectiveConsumed = 0;
  const redundant = new Set<string>();
  const perEntityRemaining = new Map<string, number>();
  let probeBudgetOut = false;
  comps.forEach((comp, ci) => {
    const outcome = outcomes[ci]!;
    if (comp.totalRows > 0) {
      if (work.used + comp.totalRows * comp.vars0.length > work.limit) {
        probeBudgetOut = true;
        return;
      }
      const J = jacAll(comp, outcome.vars, work);
      const rank = denseRank(J, comp.totalRows, comp.vars0.length);
      effectiveConsumed += rank;
      // Redundancy probes.
      for (const rs of comp.residuals) {
        const rowsExcept = comp.totalRows - rs.rowCount;
        if (work.used + rowsExcept * comp.vars0.length > work.limit) {
          probeBudgetOut = true;
          break;
        }
        const sub = new Float64Array(rowsExcept * comp.vars0.length);
        let w = 0;
        for (let rI = 0; rI < comp.totalRows; rI += 1) {
          if (rI >= comp.rowOffset.get(rs.constraint.id)! && rI < comp.rowOffset.get(rs.constraint.id)! + rs.rowCount) continue;
          for (let cI = 0; cI < comp.vars0.length; cI += 1) {
            sub[w] = J[rI * comp.vars0.length + cI]!;
            w += 1;
          }
        }
        work.used += rowsExcept * comp.vars0.length;
        if (denseRank(sub, rowsExcept, comp.vars0.length) === rank && (magById.get(rs.constraint.id) ?? Infinity) <= RESIDUAL_TOL) {
          redundant.add(rs.constraint.id);
        }
      }
      // Per-entity remaining: sequential marginal rank in input order.
      let cumulative = 0;
      const colsSoFar: number[] = [];
      for (const ev of comp.list) {
        for (let vI = 0; vI < ev.count; vI += 1) colsSoFar.push(ev.offset + vI);
        if (probeBudgetOut) {
          perEntityRemaining.set(ev.entity.id, -1);
          continue;
        }
        if (work.used + comp.totalRows * colsSoFar.length > work.limit) {
          probeBudgetOut = true;
          perEntityRemaining.set(ev.entity.id, -1);
          continue;
        }
        work.used += comp.totalRows * colsSoFar.length;
        const r = denseRank(J, comp.totalRows, comp.vars0.length, colsSoFar);
        perEntityRemaining.set(ev.entity.id, ev.count - (r - cumulative));
        cumulative = r;
      }
    } else {
      for (const ev of comp.list) perEntityRemaining.set(ev.entity.id, ev.count);
    }
  });

  const total = prep.participating.reduce((n, e) => n + entityDof(e), 0);
  const dof: DofReport = {
    total,
    nominalConsumed: prep.nominalConsumed,
    effectiveConsumed,
    remaining: total - effectiveConsumed,
    perEntity: prep.participating.map((e) => ({
      entityId: e.id,
      dof: entityDof(e),
      remaining: perEntityRemaining.get(e.id) ?? entityDof(e),
    })),
  };

  return {
    ok: true,
    status: dof.remaining === 0 ? 'fully-constrained' : 'underconstrained',
    entities: resultEntities,
    dof,
    diagnostics: buildDiagnostics(set, { magById, redundant, mode: 'solved', geometry: resultEntities, shapes }),
    notes,
    workUsed: work.used,
  };
}

// ---------------------------------------------------------------------------
// analyzeConstraints — DOF + status reporting against current geometry,
// no motion (design §8, slice 30.3.1 "status reporter for the no-solve case")
// ---------------------------------------------------------------------------

export function analyzeConstraints(entities: readonly Entity[], set: ConstraintSet): AnalysisResult {
  const prep = prepare(entities, set);
  const shapes = shapeMap(prep, set, entities);
  const total = prep.participating.reduce((n, e) => n + entityDof(e), 0);
  if (prep.problems.length > 0) {
    return {
      problems: prep.problems,
      dof: {
        total,
        nominalConsumed: prep.nominalConsumed,
        effectiveConsumed: 0,
        remaining: total,
        perEntity: prep.participating.map((e) => ({ entityId: e.id, dof: entityDof(e), remaining: entityDof(e) })),
      },
      diagnostics: buildDiagnostics(set, { magById: new Map(), redundant: new Set(), mode: 'failed', geometry: entities, shapes }),
      status: null,
    };
  }
  const inputIndex = new Map<string, number>(entities.map((e, i) => [e.id, i] as const));
  const { layout, vars0 } = makeLayout(prep.participating, inputIndex);
  let S = 1;
  for (const v of vars0) if (Math.abs(v) > S) S = Math.abs(v);
  for (const { c } of prep.active) if (c.value !== undefined && Math.abs(c.value) > S) S = Math.abs(c.value);

  const work: Work = { used: 0, limit: SOLVE_WORK_LIMIT };
  const magById = new Map<string, number>();
  let effectiveConsumed = 0;
  const perEntityRemaining = new Map<string, number>();
  const supportedActive = prep.active.filter(({ shape }) => shapeSupported(shape));
  if (supportedActive.length > 0) {
    const residuals = supportedActive.map(({ c, shape }) => buildResidual(c, shape, layout, S)!);
    let totalRows = 0;
    const offsets = new Map<string, number>();
    for (const r of residuals) {
      offsets.set(r.constraint.id, totalRows);
      totalRows += r.rowCount;
    }
    const r0 = new Float64Array(totalRows);
    for (const rs of residuals) rs.eval(vars0, r0, offsets.get(rs.constraint.id)!);
    for (const rs of residuals) {
      const at = offsets.get(rs.constraint.id)!;
      let m = 0;
      for (let i = 0; i < rs.rowCount; i += 1) m = Math.max(m, Math.abs(r0[at + i]!));
      magById.set(rs.constraint.id, m);
    }
    const nVars = vars0.length;
    const J = new Float64Array(totalRows * nVars);
    for (const rs of residuals) rs.jac(vars0, J, offsets.get(rs.constraint.id)!, nVars);
    work.used += totalRows * nVars;
    effectiveConsumed = denseRank(J, totalRows, nVars);
    let cumulative = 0;
    const colsSoFar: number[] = [];
    let budgetOut = false;
    for (const e of prep.participating) {
      const ev = layout.get(e.id)!;
      for (let vI = 0; vI < ev.count; vI += 1) colsSoFar.push(ev.offset + vI);
      if (budgetOut || work.used + totalRows * colsSoFar.length > work.limit) {
        budgetOut = true;
        perEntityRemaining.set(e.id, -1);
        continue;
      }
      work.used += totalRows * colsSoFar.length;
      const r = denseRank(J, totalRows, nVars, colsSoFar);
      perEntityRemaining.set(e.id, ev.count - (r - cumulative));
      cumulative = r;
    }
  } else {
    for (const e of prep.participating) perEntityRemaining.set(e.id, entityDof(e));
  }
  const remaining = total - effectiveConsumed;
  const allSatisfied = prep.active.every(({ c }) => {
    const m = magById.get(c.id);
    return m !== undefined && m <= RESIDUAL_TOL;
  });
  const status: SolveStatus =
    prep.unsupported.length > 0 || !allSatisfied ? 'unsolved' : remaining === 0 ? 'fully-constrained' : 'underconstrained';
  return {
    problems: [],
    dof: {
      total,
      nominalConsumed: prep.nominalConsumed,
      effectiveConsumed,
      remaining,
      perEntity: prep.participating.map((e) => ({ entityId: e.id, dof: entityDof(e), remaining: perEntityRemaining.get(e.id) ?? entityDof(e) })),
    },
    diagnostics: buildDiagnostics(set, {
      magById,
      redundant: new Set(),
      mode: status === 'unsolved' ? 'failed' : 'solved',
      geometry: entities,
      shapes,
    }),
    status,
  };
}
