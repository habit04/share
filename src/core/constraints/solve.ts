/**
 * Priority 30.3 — bounded 2D constraint solver (design §5).
 *
 * Coverage: model + validation (validate.ts), DOF accounting, stage-1
 * analysis, stage-2 direct construction rules 1–10, and the stage-3
 * damped Gauss–Newton relaxation. Slice 30.3.1 landed rules 1–6
 * (`fixed`, `coincident` point↔point, `concentric`, `horizontal`/
 * `vertical`, `equal` radius, `radius`/`diameter`); slice 30.3.2 adds
 * rules 7–10 (`distance` point↔point construction, `parallel`/
 * `perpendicular` orientation adoption, `equal` length, `angle`) and
 * the remaining residual forms: direction pairs, equal length, all
 * distance modes, and point-on-object coincident (line / circle / arc
 * objects). Slice 30.3.3 adds `tangent` (line–curve and circle–circle,
 * §5.4; no stage-2 rule exists for it — §5.3 names tangent conditions
 * as stage-3 work) and point-on-object coincident on a polyline 'whole'
 * (minimum over segments, §2.1 "per segment"). The only shape still
 * refused with 'unsupported-constraint' — never silently ignored,
 * because a driving constraint the solver skipped would fake success —
 * is a point-on-object coincident whose polyline object has fewer than
 * two points and therefore no segment to measure against.
 *
 * Pure and deterministic: same input ⇒ same output, bit-for-bit. Work is
 * bounded by an integer counter, never a timer. A failed or cancelled
 * solve returns no entities; inputs are never mutated, so the document
 * is unchanged by construction (design §6).
 */
import { circleCircleIntersections, dist, normAngle, type Point } from '../geometry';
import type { Entity } from '../entities';
import {
  anchorKey,
  entityDof,
  hasBulge,
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

export type SolveStatus =
  | 'fully-constrained'
  | 'underconstrained'
  | 'conflicting'
  | 'unsolved'
  /** The solve succeeded and its geometry is reported, but the §3.3
   *  rank probe was budget-skipped for at least one component, so no
   *  DOF verdict exists: `dof.effectiveConsumed` and `dof.remaining`
   *  are the stated unknown (-1), never an invented figure (review
   *  R12). Analysis never produces this status — it always computes
   *  its rank. */
  | 'rank-unknown';

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
  /** Circle–circle tangent only: the branch chosen once at entry from the
   *  current geometry (design §5.4 — recorded in diagnostics, never
   *  switched mid-solve). */
  readonly branch?: 'external' | 'internal';
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
  /** Circle–circle tangent: entry branch (design §5.4), surfaced in the
   *  constraint's diagnostic. */
  readonly branch?: 'external' | 'internal';
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
        out[rowAt * nVars + d.v] = out[rowAt * nVars + d.v]! + d.px / S;
        out[(rowAt + 1) * nVars + d.v] = out[(rowAt + 1) * nVars + d.v]! + d.py / S;
      }
      for (const d of a.derivs(vars_)) {
        out[rowAt * nVars + d.v] = out[rowAt * nVars + d.v]! - d.px / S;
        out[(rowAt + 1) * nVars + d.v] = out[(rowAt + 1) * nVars + d.v]! - d.py / S;
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
        out[rowAt * nVars + d.v] = out[rowAt * nVars + d.v]! + d.px / S;
        out[(rowAt + 1) * nVars + d.v] = out[(rowAt + 1) * nVars + d.v]! + d.py / S;
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
      for (const d of q.derivs(vs)) out[rowAt * nVars + d.v] = out[rowAt * nVars + d.v]! + (horizontal ? d.py : d.px) / S;
      for (const d of p.derivs(vs)) out[rowAt * nVars + d.v] = out[rowAt * nVars + d.v]! - (horizontal ? d.py : d.px) / S;
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
      for (const { v, g } of grads) out[rowAt * nVars + v] = out[rowAt * nVars + v]! + g;
    },
  };
}

/** A scalar residual whose gradient is expressed as point gradients over
 *  point expressions plus direct variable terms — the pattern shared by
 *  every slice-2 form (direction pairs, lengths, distances, point-on-
 *  object). `value`/`grads` return RAW quantities; `norm` normalizes
 *  (1/S for length forms, 1 for the scale-free direction forms, §5.4). */
interface PointGrad {
  readonly expr: PointExpr;
  readonly gx: number;
  readonly gy: number;
}
interface ScalarGrads {
  readonly points: readonly PointGrad[];
  readonly varTerms: readonly { v: number; g: number }[];
}

function scalarFormResidual(
  c: Constraint,
  vars: readonly number[],
  norm: number,
  value: (vs: Float64Array) => number,
  grads: (vs: Float64Array) => ScalarGrads,
): ResidualSet {
  return {
    constraint: c,
    rowCount: 1,
    vars,
    eval: (vs, out, at) => {
      out[at] = value(vs) * norm;
    },
    jac: (vs, out, rowAt, nVars) => {
      const g = grads(vs);
      for (const t of g.points) {
        for (const d of t.expr.derivs(vs)) {
          out[rowAt * nVars + d.v] = out[rowAt * nVars + d.v]! + norm * (t.gx * d.px + t.gy * d.py);
        }
      }
      for (const t of g.varTerms) out[rowAt * nVars + t.v] = out[rowAt * nVars + t.v]! + norm * t.g;
    },
  };
}

/** Signed principal wrap to (−π, π] — the §5.4 angle residual's wrap.
 *  (The geometry module's normAngle normalizes to [0, 2π) for measured
 *  angles; a residual of 2π − ε for an almost-satisfied angle would be
 *  wrong, so the residual wraps signed.) */
function wrapPi(a: number): number {
  const t = 2 * Math.PI;
  let r = a % t;
  if (r <= -Math.PI) r += t;
  else if (r > Math.PI) r -= t;
  return r;
}

interface SegGeom {
  readonly d: Point;
  readonly L: number;
  readonly ux: number;
  readonly uy: number;
}

function segGeom(p: PointExpr, q: PointExpr, vs: Float64Array): SegGeom {
  const pp = p.eval(vs);
  const qq = q.eval(vs);
  const d = { x: qq.x - pp.x, y: qq.y - pp.y };
  const L = Math.hypot(d.x, d.y);
  return { d, L, ux: L > 0 ? d.x / L : 0, uy: L > 0 ? d.y / L : 0 };
}

/** Point-grad terms for a scalar depending on a segment's unit direction
 *  through g = ∂f/∂û: the projection (I − ûûᵀ)·g / L applied at the end
 *  point, negated at the start point. Zero-length ⇒ zero gradient (the
 *  stage-1 degenerate check refuses such segments for direction kinds). */
function dirGradTerms(p: PointExpr, q: PointExpr, s: SegGeom, gx: number, gy: number): PointGrad[] {
  if (s.L === 0) {
    return [
      { expr: p, gx: 0, gy: 0 },
      { expr: q, gx: 0, gy: 0 },
    ];
  }
  const dotUG = s.ux * gx + s.uy * gy;
  const vx = (gx - s.ux * dotUG) / s.L;
  const vy = (gy - s.uy * dotUG) / s.L;
  return [
    { expr: q, gx: vx, gy: vy },
    { expr: p, gx: -vx, gy: -vy },
  ];
}

/** Point-grad terms for a scalar depending on a segment's length:
 *  ∂len/∂end = û, ∂len/∂start = −û. */
function lenGradTerms(p: PointExpr, q: PointExpr, s: SegGeom): PointGrad[] {
  return [
    { expr: q, gx: s.ux, gy: s.uy },
    { expr: p, gx: -s.ux, gy: -s.uy },
  ];
}

function exprVars(...exprs: readonly PointExpr[]): readonly number[] {
  return [...new Set(exprs.flatMap((e) => [...e.vars]))];
}

/** The point-on-line scalar f = cross(d, w) / L, with d = B − A the
 *  segment vector and w = P − A — shared by coincident point-on-line and
 *  point–line distance (§5.4), plus its analytic gradients:
 *  ∂f/∂P = perp(d)/L; ∂f/∂d = perp-components (w.y, −w.x)/L − f·d/L²;
 *  ∂f/∂A = −∂f/∂P − ∂f/∂d; ∂f/∂B = ∂f/∂d. */
function lineCrossForm(pE: PointExpr, aE: PointExpr, bE: PointExpr, vs: Float64Array): { f: number; grads: ScalarGrads } {
  const A = aE.eval(vs);
  const B = bE.eval(vs);
  const P = pE.eval(vs);
  const d = { x: B.x - A.x, y: B.y - A.y };
  const w = { x: P.x - A.x, y: P.y - A.y };
  const L = Math.hypot(d.x, d.y);
  if (L === 0) {
    return {
      f: 0,
      grads: {
        points: [
          { expr: pE, gx: 0, gy: 0 },
          { expr: aE, gx: 0, gy: 0 },
          { expr: bE, gx: 0, gy: 0 },
        ],
        varTerms: [],
      },
    };
  }
  const f = (d.x * w.y - d.y * w.x) / L;
  const gp = { x: -d.y / L, y: d.x / L }; // ∂f/∂P = ∂f/∂w
  const gd = { x: w.y / L - (f * d.x) / (L * L), y: -w.x / L - (f * d.y) / (L * L) }; // ∂f/∂d
  return {
    f,
    grads: {
      points: [
        { expr: pE, gx: gp.x, gy: gp.y },
        { expr: bE, gx: gd.x, gy: gd.y },
        { expr: aE, gx: -gp.x - gd.x, gy: -gp.y - gd.y },
      ],
      varTerms: [],
    },
  };
}

function scaleGrads(g: ScalarGrads, k: number): ScalarGrads {
  if (k === 1) return g;
  return {
    points: g.points.map((t) => ({ expr: t.expr, gx: t.gx * k, gy: t.gy * k })),
    varTerms: g.varTerms.map((t) => ({ v: t.v, g: t.g * k })),
  };
}

type TangentBranch = 'external' | 'internal';

/** Tangent line–curve (§5.4): (distToLine(c) − r)/S over the infinite
 *  line. The center's side of the line is an entry branch exactly like
 *  the circle–circle one: σ = sign of the signed distance at entry is
 *  captured once, so the residual is smooth and the circle is never
 *  flipped across the line mid-solve. Arc curve sides use their circle
 *  carrier (center + radius), as for point-on-circle (§5.4). */
function tangentLineCurveResidual(
  c: Constraint,
  seg: Side,
  curve: Side,
  layout: ReadonlyMap<string, EntVars>,
  S: number,
  entry: Float64Array,
): ResidualSet {
  const [aE, bE] = segmentExprs(seg, layout);
  const cE = pointExpr({ entity: curve.entity, ref: { entityId: curve.entity.id, anchor: 'center' } }, layout);
  const rv = radiusVar(curve, layout);
  const vars = [...new Set([...exprVars(cE, aE, bE), rv])];
  const sigma = lineCrossForm(cE, aE, bE, entry).f < 0 ? -1 : 1;
  return scalarFormResidual(
    c,
    vars,
    1 / S,
    (vs) => sigma * lineCrossForm(cE, aE, bE, vs).f - vs[rv]!,
    (vs) => {
      const g = scaleGrads(lineCrossForm(cE, aE, bE, vs).grads, sigma);
      return { points: g.points, varTerms: [{ v: rv, g: -1 }] };
    },
  );
}

/** Tangent circle–circle (§5.4): (dist(c₁,c₂) − (r₁+r₂))/S externally,
 *  (dist − |r₁−r₂|)/S internally. The branch is chosen once at entry —
 *  internal when the entry geometry is internally tangent within the
 *  residual tolerance (dist < |r₁−r₂| + RESIDUAL_TOL·S) — recorded on
 *  the residual set for diagnostics, and never switched mid-solve.
 *  Arc sides use their circle carriers. */
function tangentCircleCircleResidual(
  c: Constraint,
  s1: Side,
  s2: Side,
  layout: ReadonlyMap<string, EntVars>,
  S: number,
  entry: Float64Array,
): ResidualSet {
  const centerOf = (s: Side) => pointExpr({ entity: s.entity, ref: { entityId: s.entity.id, anchor: 'center' } }, layout);
  const c1E = centerOf(s1);
  const c2E = centerOf(s2);
  const r1 = radiusVar(s1, layout);
  const r2 = radiusVar(s2, layout);
  const vars = [...new Set([...exprVars(c1E, c2E), r1, r2])];
  const d0 = dist(c1E.eval(entry), c2E.eval(entry));
  const branch: TangentBranch = d0 < Math.abs(entry[r1]! - entry[r2]!) + RESIDUAL_TOL * S ? 'internal' : 'external';
  const rs = scalarFormResidual(
    c,
    vars,
    1 / S,
    (vs) => {
      const d = dist(c1E.eval(vs), c2E.eval(vs));
      return branch === 'external' ? d - (vs[r1]! + vs[r2]!) : d - Math.abs(vs[r1]! - vs[r2]!);
    },
    (vs) => {
      const p1 = c1E.eval(vs);
      const p2 = c2E.eval(vs);
      const d = dist(p1, p2);
      const ux = d > 0 ? (p2.x - p1.x) / d : 0;
      const uy = d > 0 ? (p2.y - p1.y) / d : 0;
      // ∂(−|r₁−r₂|): −sign(r₁−r₂) on r₁, +sign(r₁−r₂) on r₂ (external:
      // −1 on both). At r₁ = r₂ either subgradient is valid; +1 is used.
      const s = vs[r1]! < vs[r2]! ? -1 : 1;
      return {
        points: [
          { expr: c2E, gx: ux, gy: uy },
          { expr: c1E, gx: -ux, gy: -uy },
        ],
        varTerms:
          branch === 'external'
            ? [
                { v: r1, g: -1 },
                { v: r2, g: -1 },
              ]
            : [
                { v: r1, g: -s },
                { v: r2, g: s },
              ],
      };
    },
  );
  return { ...rs, branch };
}

/** Point-on-object coincident on a polyline 'whole' (§2.1: the 'whole'
 *  anchor on a polyline is per segment): the residual is the distance
 *  from the point to the polyline — the minimum over segments of the
 *  clamped point-to-segment distance — normalized by S. The active
 *  segment is the argmin, ties broken by the lowest segment index
 *  (stored order), so the form is deterministic. Its gradient is taken
 *  at the active segment with the projection parameter frozen (envelope
 *  theorem: at an interior projection ∂dist/∂t = 0, at a clamped end t
 *  is locally constant). Bulges are not part of the form: they are
 *  carried data (§2.5), and a solve engaging a bulged polyline reports
 *  'bulge-carried' rather than pretending the arc is the chord. */
function coincidentPolylineResidual(
  c: Constraint,
  point: Side,
  object: Side,
  layout: ReadonlyMap<string, EntVars>,
  S: number,
): ResidualSet | null {
  const pl = object.entity as Extract<ConstrainableEntity, { type: 'polyline' }>;
  const n = pl.points.length;
  const segCount = pl.closed ? n : n - 1;
  if (segCount < 1) return null; // no segment to measure against — refused by the caller
  const o = layout.get(pl.id)!.offset;
  const vertex = (i: number) => varPairExpr(o + 2 * (pl.closed ? i % n : i));
  const segments: readonly (readonly [PointExpr, PointExpr])[] = Array.from({ length: segCount }, (_, i) => [vertex(i), vertex(i + 1)] as const);
  const pE = pointExpr(point, layout);
  const vars = [...new Set([...pE.vars, ...segments.flatMap(([a, b]) => [...a.vars, ...b.vars])])];
  /** Active segment at `vs`: its endpoints, frozen projection parameter,
   *  distance, and unit vector from the projection to the point. */
  const active = (vs: Float64Array) => {
    const P = pE.eval(vs);
    let best: { a: PointExpr; b: PointExpr; t: number; d: number; gx: number; gy: number } | null = null;
    for (const [aE, bE] of segments) {
      const A = aE.eval(vs);
      const B = bE.eval(vs);
      const dx = B.x - A.x;
      const dy = B.y - A.y;
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.min(1, Math.max(0, ((P.x - A.x) * dx + (P.y - A.y) * dy) / L2)) : 0;
      const wx = P.x - (A.x + t * dx);
      const wy = P.y - (A.y + t * dy);
      const d = Math.hypot(wx, wy);
      if (best === null || d < best.d) {
        best = { a: aE, b: bE, t, d, gx: d > 0 ? wx / d : 0, gy: d > 0 ? wy / d : 0 };
      }
    }
    return best!;
  };
  return scalarFormResidual(
    c,
    vars,
    1 / S,
    (vs) => active(vs).d,
    (vs) => {
      const act = active(vs);
      if (act.d === 0) {
        // On the segment: the distance is 0 and any subgradient is
        // valid; the zero gradient is used (cf. dist = 0 in §5.4 forms).
        return { points: [{ expr: pE, gx: 0, gy: 0 }], varTerms: [] };
      }
      return {
        points: [
          { expr: pE, gx: act.gx, gy: act.gy },
          { expr: act.a, gx: -(1 - act.t) * act.gx, gy: -(1 - act.t) * act.gy },
          { expr: act.b, gx: -act.t * act.gx, gy: -act.t * act.gy },
        ],
        varTerms: [],
      };
    },
  );
}

/** Supported shapes. Everything else returns null (unsupported in this
 *  build) — the caller refuses, never skips. `entry` is the component's
 *  entry variable vector: entry-fixed signs (§5.4 distance modes,
 *  point–line distance) are captured from it, never re-derived mid-solve. */
function buildResidual(c: Constraint, shape: ConstraintShape, layout: ReadonlyMap<string, EntVars>, S: number, entry: Float64Array): ResidualSet | null {
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
    case 'direction-pair': {
      const [p1, q1] = segmentExprs(shape.a, layout);
      const [p2, q2] = segmentExprs(shape.b, layout);
      const vars = exprVars(p1, q1, p2, q2);
      if (c.kind === 'angle') {
        // wrap(θ₂ − θ₁ − value), scale-free (§5.4). ∂θ/∂end = perp(d)/L²,
        // ∂θ/∂start = −perp(d)/L²; side a enters with the opposite sign.
        return scalarFormResidual(
          c,
          vars,
          1,
          (vs) => {
            const s1 = segGeom(p1, q1, vs);
            const s2 = segGeom(p2, q2, vs);
            return wrapPi(Math.atan2(s2.d.y, s2.d.x) - Math.atan2(s1.d.y, s1.d.x) - c.value!);
          },
          (vs) => {
            const s1 = segGeom(p1, q1, vs);
            const s2 = segGeom(p2, q2, vs);
            const terms: PointGrad[] = [];
            if (s2.L > 0) {
              const gx = -s2.d.y / (s2.L * s2.L);
              const gy = s2.d.x / (s2.L * s2.L);
              terms.push({ expr: q2, gx, gy }, { expr: p2, gx: -gx, gy: -gy });
            }
            if (s1.L > 0) {
              const gx = s1.d.y / (s1.L * s1.L);
              const gy = -s1.d.x / (s1.L * s1.L);
              terms.push({ expr: q1, gx, gy }, { expr: p1, gx: -gx, gy: -gy });
            }
            return { points: terms, varTerms: [] };
          },
        );
      }
      // parallel: cross(û₁, û₂) · perpendicular: dot(û₁, û₂) — both
      // scale-free (§5.4). ∂cross/∂û₁ = (û₂.y, −û₂.x), ∂cross/∂û₂ =
      // (−û₁.y, û₁.x); ∂dot/∂û₁ = û₂, ∂dot/∂û₂ = û₁.
      const parallel = c.kind === 'parallel';
      return scalarFormResidual(
        c,
        vars,
        1,
        (vs) => {
          const s1 = segGeom(p1, q1, vs);
          const s2 = segGeom(p2, q2, vs);
          return parallel ? s1.ux * s2.uy - s1.uy * s2.ux : s1.ux * s2.ux + s1.uy * s2.uy;
        },
        (vs) => {
          const s1 = segGeom(p1, q1, vs);
          const s2 = segGeom(p2, q2, vs);
          const g1: [number, number] = parallel ? [s2.uy, -s2.ux] : [s2.ux, s2.uy];
          const g2: [number, number] = parallel ? [-s1.uy, s1.ux] : [s1.ux, s1.uy];
          return {
            points: [...dirGradTerms(p1, q1, s1, g1[0], g1[1]), ...dirGradTerms(p2, q2, s2, g2[0], g2[1])],
            varTerms: [],
          };
        },
      );
    }
    case 'equal-length': {
      const [p1, q1] = segmentExprs(shape.a, layout);
      const [p2, q2] = segmentExprs(shape.b, layout);
      return scalarFormResidual(
        c,
        exprVars(p1, q1, p2, q2),
        1 / S,
        (vs) => segGeom(p2, q2, vs).L - segGeom(p1, q1, vs).L,
        (vs) => {
          const s1 = segGeom(p1, q1, vs);
          const s2 = segGeom(p2, q2, vs);
          return {
            points: [
              ...lenGradTerms(p2, q2, s2),
              ...lenGradTerms(p1, q1, s1).map((t) => ({ expr: t.expr, gx: -t.gx, gy: -t.gy })),
            ],
            varTerms: [],
          };
        },
      );
    }
    case 'distance-points': {
      const pE = pointExpr(shape.a, layout);
      const qE = pointExpr(shape.b, layout);
      const mode = c.distanceMode ?? 'aligned';
      if (mode === 'horizontal' || mode === 'vertical') {
        // ((q − p)·axis − σ·value)/S with σ the entry sign, fixed during
        // the solve so the constraint never flips its points (§2.7/§5.4).
        const axis = mode === 'horizontal' ? 'x' : 'y';
        const sigma = (axis === 'x' ? qE.eval(entry).x - pE.eval(entry).x : qE.eval(entry).y - pE.eval(entry).y) < 0 ? -1 : 1;
        const gq: [number, number] = axis === 'x' ? [1, 0] : [0, 1];
        return scalarFormResidual(
          c,
          exprVars(pE, qE),
          1 / S,
          (vs) => (axis === 'x' ? qE.eval(vs).x - pE.eval(vs).x : qE.eval(vs).y - pE.eval(vs).y) - sigma * c.value!,
          () => ({
            points: [
              { expr: qE, gx: gq[0], gy: gq[1] },
              { expr: pE, gx: -gq[0], gy: -gq[1] },
            ],
            varTerms: [],
          }),
        );
      }
      // (dist − value)/S. At dist = 0 the gradient is undefined; the
      // zero gradient is used (a subgradient choice), so the row reports
      // its residual but cannot by itself separate coincident points —
      // construction rule 7 or another row must do that.
      return scalarFormResidual(
        c,
        exprVars(pE, qE),
        1 / S,
        (vs) => dist(pE.eval(vs), qE.eval(vs)) - c.value!,
        (vs) => {
          const pp = pE.eval(vs);
          const qq = qE.eval(vs);
          const d = dist(pp, qq);
          const ux = d > 0 ? (qq.x - pp.x) / d : 0;
          const uy = d > 0 ? (qq.y - pp.y) / d : 0;
          return {
            points: [
              { expr: qE, gx: ux, gy: uy },
              { expr: pE, gx: -ux, gy: -uy },
            ],
            varTerms: [],
          };
        },
      );
    }
    case 'distance-length': {
      const [pE, qE] = segmentExprs(shape.seg, layout);
      return scalarFormResidual(
        c,
        exprVars(pE, qE),
        1 / S,
        (vs) => segGeom(pE, qE, vs).L - c.value!,
        (vs) => ({ points: lenGradTerms(pE, qE, segGeom(pE, qE, vs)), varTerms: [] }),
      );
    }
    case 'distance-point-line': {
      const pE = pointExpr(shape.point, layout);
      const [aE, bE] = segmentExprs(shape.seg, layout);
      // (σ·signedDist − value)/S; σ is the entry sign of the signed
      // distance, fixed during the solve (§5.4).
      const sigma = lineCrossForm(pE, aE, bE, entry).f < 0 ? -1 : 1;
      return scalarFormResidual(
        c,
        exprVars(pE, aE, bE),
        1 / S,
        (vs) => sigma * lineCrossForm(pE, aE, bE, vs).f - c.value!,
        (vs) => scaleGrads(lineCrossForm(pE, aE, bE, vs).grads, sigma),
      );
    }
    case 'coincident-object': {
      const pE = pointExpr(shape.point, layout);
      if (shape.object.entity.type === 'line') {
        const [aE, bE] = segmentExprs(shape.object, layout);
        return scalarFormResidual(
          c,
          exprVars(pE, aE, bE),
          1 / S,
          (vs) => lineCrossForm(pE, aE, bE, vs).f,
          (vs) => lineCrossForm(pE, aE, bE, vs).grads,
        );
      }
      if (shape.object.entity.type === 'circle' || shape.object.entity.type === 'arc') {
        // (dist(p, c) − r)/S over the full circle (§5.4).
        const cE = pointExpr({ entity: shape.object.entity, ref: { entityId: shape.object.entity.id, anchor: 'center' } }, layout);
        const rv = radiusVar(shape.object, layout);
        const vars = [...new Set([...exprVars(pE, cE), rv])];
        return scalarFormResidual(
          c,
          vars,
          1 / S,
          (vs) => dist(pE.eval(vs), cE.eval(vs)) - vs[rv]!,
          (vs) => {
            const pp = pE.eval(vs);
            const cc = cE.eval(vs);
            const d = dist(pp, cc);
            const ux = d > 0 ? (pp.x - cc.x) / d : 0;
            const uy = d > 0 ? (pp.y - cc.y) / d : 0;
            return {
              points: [
                { expr: pE, gx: ux, gy: uy },
                { expr: cE, gx: -ux, gy: -uy },
              ],
              varTerms: [{ v: rv, g: -1 }],
            };
          },
        );
      }
      // Polyline 'whole' object: minimum over segments (per-segment
      // reading of the §2.1 'whole' anchor).
      return coincidentPolylineResidual(c, shape.point, shape.object, layout, S);
    }
    case 'tangent': {
      const segSide = (s: Side): boolean =>
        (s.entity.type === 'line' && s.ref.anchor === 'whole') || (s.entity.type === 'polyline' && s.ref.anchor === 'segment');
      if (segSide(shape.a) && !segSide(shape.b)) return tangentLineCurveResidual(c, shape.a, shape.b, layout, S, entry);
      if (segSide(shape.b) && !segSide(shape.a)) return tangentLineCurveResidual(c, shape.b, shape.a, layout, S, entry);
      return tangentCircleCircleResidual(c, shape.a, shape.b, layout, S, entry);
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
    case 'direction-pair': // parallel / perpendicular / angle (30.3.2)
    case 'equal-length': // 30.3.2
    case 'distance-points': // all modes (30.3.2)
    case 'distance-point-line': // 30.3.2
    case 'distance-length': // 30.3.2
    case 'tangent': // line–curve and circle–circle (30.3.3)
      return true;
    case 'coincident-object':
      // Line / circle / arc objects have §5.4 residual forms; a polyline
      // 'whole' is the minimum over its segments (30.3.3) — but a
      // polyline with fewer than two points has no segment to measure
      // against and stays refused.
      if (shape.object.entity.type === 'polyline') return shape.object.entity.points.length >= 2;
      return shape.object.entity.type === 'line' || shape.object.entity.type === 'circle' || shape.object.entity.type === 'arc';
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

/** One damped least-squares step for the stage-3 relaxation
 *  (F-3034 avenue 1): the δ minimizing ‖[Jf; μI]δ + [r; 0]‖₂, computed
 *  by Householder QR with column pivoting on the augmented system —
 *  never through the normal equations, whose κ(J)² conditioning
 *  destroyed the fold directions the tangent systems live on.
 *  Pivoting is deterministic: at each step the remaining column with
 *  the largest trailing norm is taken, ties to the lowest position.
 *  With μ > 0 the augmented matrix has full column rank, so a step
 *  always exists; null is returned only for a degenerate (zero or
 *  non-finite) pivot, mirroring the singularity refusal of the dense
 *  solver this replaced — the caller escalates λ and retries. */
function qrLeastSquaresStep(Jf: Float64Array, m: number, f: number, r: Float64Array, mu: number): Float64Array | null {
  if (f === 0) return new Float64Array(0);
  const rows = m + f;
  const A = new Float64Array(rows * f);
  const b = new Float64Array(rows);
  for (let i = 0; i < m; i += 1) {
    for (let j = 0; j < f; j += 1) A[i * f + j] = Jf[i * f + j]!;
    b[i] = -r[i]!;
  }
  for (let j = 0; j < f; j += 1) A[(m + j) * f + j] = mu;
  const perm = Array.from({ length: f }, (_, i) => i);
  for (let k = 0; k < f; k += 1) {
    // Pivot: largest trailing column norm among columns k..f−1.
    let piv = -1;
    let best = -1;
    for (let j = k; j < f; j += 1) {
      let s = 0;
      for (let i = k; i < rows; i += 1) {
        const v = A[i * f + j]!;
        s += v * v;
      }
      if (s > best) {
        best = s;
        piv = j;
      }
    }
    if (piv < 0 || best === 0) return null;
    if (piv !== k) {
      for (let i = 0; i < rows; i += 1) {
        const t = A[i * f + k]!;
        A[i * f + k] = A[i * f + piv]!;
        A[i * f + piv] = t;
      }
      const tp = perm[k]!;
      perm[k] = perm[piv]!;
      perm[piv] = tp;
    }
    // Householder reflection zeroing column k below the diagonal.
    let normx = 0;
    for (let i = k; i < rows; i += 1) {
      const v = A[i * f + k]!;
      normx += v * v;
    }
    normx = Math.sqrt(normx);
    if (normx === 0 || !Number.isFinite(normx)) return null;
    const a0 = A[k * f + k]!;
    const alpha = a0 >= 0 ? -normx : normx;
    const v = new Float64Array(rows - k);
    for (let i = k; i < rows; i += 1) v[i - k] = A[i * f + k]!;
    v[0] = v[0]! - alpha;
    let vv = 0;
    for (const t of v) vv += t * t;
    if (vv === 0 || !Number.isFinite(vv)) return null;
    const tau = 2 / vv;
    for (let j = k; j < f; j += 1) {
      let s = 0;
      for (let i = k; i < rows; i += 1) s += v[i - k]! * A[i * f + j]!;
      s *= tau;
      if (s === 0) continue;
      for (let i = k; i < rows; i += 1) A[i * f + j] = A[i * f + j]! - s * v[i - k]!;
    }
    let sb = 0;
    for (let i = k; i < rows; i += 1) sb += v[i - k]! * b[i]!;
    sb *= tau;
    if (sb !== 0) {
      for (let i = k; i < rows; i += 1) b[i] = b[i]! - sb * v[i - k]!;
    }
    A[k * f + k] = alpha;
    for (let i = k + 1; i < rows; i += 1) A[i * f + k] = 0;
  }
  // Back-substitution on the pivoted upper triangle.
  const y = new Float64Array(f);
  for (let k = f - 1; k >= 0; k -= 1) {
    let s = b[k]!;
    for (let j = k + 1; j < f; j += 1) s -= A[k * f + j]! * y[j]!;
    const d = A[k * f + k]!;
    if (d === 0 || !Number.isFinite(d)) return null;
    y[k] = s / d;
  }
  const delta = new Float64Array(f);
  for (let k = 0; k < f; k += 1) delta[perm[k]!] = y[k]!;
  return delta;
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
  // Duplicate ids (30.3.4): every lookup in the engine — and in §4
  // validation — is keyed by entity id, so a duplicate makes refs
  // ambiguous and would silently alias two distinct entities' variables
  // (one entity's geometry overwriting the other's in the result). The
  // whole input is refused, naming each duplicated id once.
  const seen = new Set<string>();
  const dupReported = new Set<string>();
  for (const e of entities) {
    if (seen.has(e.id) && !dupReported.has(e.id)) {
      dupReported.add(e.id);
      problems.push({ code: 'duplicate-entity', entityId: e.id, message: `Entity id '${e.id}' appears more than once in the input; constraint references would be ambiguous.` });
    }
    seen.add(e.id);
  }
  // Defensive numeric reads (30.3.4): entities are plain data and may
  // arrive JSON-shaped with fields missing or of the wrong type. A
  // missing field must surface as this refusal, never as a TypeError.
  const num = (v: unknown): number => (typeof v === 'number' ? v : NaN);
  const coords = (p: unknown): [number, number] => {
    const q = p as { x?: unknown; y?: unknown } | null | undefined;
    return [num(q?.x), num(q?.y)];
  };
  for (const e of entities) {
    if (!isConstrainable(e)) continue;
    const nums: number[] = [];
    switch (e.type) {
      case 'point':
        nums.push(...coords(e.position));
        break;
      case 'line':
        nums.push(...coords(e.a), ...coords(e.b));
        break;
      case 'circle':
        nums.push(...coords(e.center), num(e.radius));
        if (!(num(e.radius) > 0)) bad(e, 'a non-positive radius');
        break;
      case 'arc':
        nums.push(...coords(e.center), num(e.radius), num(e.startAngle), num(e.endAngle));
        if (!(num(e.radius) > 0)) bad(e, 'a non-positive radius');
        break;
      case 'polyline': {
        // A polyline with no points has no anchors to resolve: its
        // 'start' would alias the *next* entity's variables (30.3.4).
        const pts = Array.isArray(e.points) ? e.points : [];
        if (pts.length === 0) {
          bad(e, 'no points');
          break;
        }
        for (const p of pts) nums.push(...coords(p));
        break;
      }
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
  /** Circle–circle tangent branches chosen at entry (§5.4). */
  readonly branchById: ReadonlyMap<string, 'external' | 'internal'>;
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
  const residuals = active.map(({ c, shape }) => buildResidual(c, shape, layout, S, vars0)!);
  const rowOffset = new Map<string, number>();
  const branchById = new Map<string, 'external' | 'internal'>();
  let totalRows = 0;
  for (const r of residuals) {
    rowOffset.set(r.constraint.id, totalRows);
    totalRows += r.rowCount;
    if (r.branch) branchById.set(r.constraint.id, r.branch);
  }
  return { list: evs, layout, active, S, vars0, residuals, rowOffset, totalRows, branchById };
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

/** Rule 7 locus: the known line or circle a point is constrained to, from
 *  an already-determined point-on-object coincident or a second distance
 *  to a determined point (design §5.3 rule 7). Stored order decides when
 *  several loci exist. Null when no determined locus exists — the rule
 *  then does not fire (rules never guess). */
type Locus = { readonly kind: 'line'; readonly a: Point; readonly b: Point } | { readonly kind: 'circle'; readonly c: Point; readonly r: number };

function findLocus(comp: Comp, pSide: Side, selfId: string, det: Uint8Array, vals: Float64Array): Locus | null {
  const key = anchorKey(pSide.entity, pSide.ref);
  for (const { shape } of comp.active) {
    if (shape.form !== 'coincident-object' || anchorKey(shape.point.entity, shape.point.ref) !== key) continue;
    const obj = shape.object;
    if (obj.entity.type === 'line') {
      const [e0, e1] = segmentExprs(obj, comp.layout);
      if (fullyDetermined(e0, det) && fullyDetermined(e1, det)) return { kind: 'line', a: e0.eval(vals), b: e1.eval(vals) };
    } else if (obj.entity.type === 'circle' || obj.entity.type === 'arc') {
      const ce = pointExpr({ entity: obj.entity, ref: { entityId: obj.entity.id, anchor: 'center' } }, comp.layout);
      const rv = radiusVar(obj, comp.layout);
      if (fullyDetermined(ce, det) && det[rv]) return { kind: 'circle', c: ce.eval(vals), r: vals[rv]! };
    }
  }
  for (const { c: other, shape } of comp.active) {
    if (other.id === selfId || shape.form !== 'distance-points' || (other.distanceMode ?? 'aligned') !== 'aligned') continue;
    for (const [s, o] of [
      [shape.a, shape.b],
      [shape.b, shape.a],
    ] as const) {
      if (anchorKey(s.entity, s.ref) !== key) continue;
      const oe = pointExpr(o, comp.layout);
      if (fullyDetermined(oe, det)) return { kind: 'circle', c: oe.eval(vals), r: other.value! };
    }
  }
  return null;
}

/** Intersections of the circle (center, v) with a rule-7 locus. The line
 *  is the infinite line through the locus segment (the §5.4 point-on-line
 *  form is an infinite-line form). */
function intersectLocus(center: Point, v: number, locus: Locus): Point[] {
  if (locus.kind === 'circle') return circleCircleIntersections(center, v, locus.c, locus.r);
  const d = { x: locus.b.x - locus.a.x, y: locus.b.y - locus.a.y };
  const w = { x: locus.a.x - center.x, y: locus.a.y - center.y };
  const A = d.x * d.x + d.y * d.y;
  if (A === 0) return [];
  const B = w.x * d.x + w.y * d.y;
  const Cc = w.x * w.x + w.y * w.y - v * v;
  const disc = B * B - A * Cc;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  const at = (t: number): Point => ({ x: locus.a.x + t * d.x, y: locus.a.y + t * d.y });
  return disc === 0 ? [at(-B / A)] : [at((-B + sq) / A), at((-B - sq) / A)];
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
    // Rule 1 — fixed grounds its anchor point (values are the entry
    // values). Only an anchor that IS a variable pair grounds anything.
    // A derived anchor (arc endpoint, line/polyline midpoint) is a point
    // CONSTRAINT on the derived position — two equations over the
    // variables it reads — not a determination of each of them: the
    // delivered rule marked an arc endpoint's center, radius and angle
    // all determined, freezing the arc so a feasible radius edit then
    // manufactured a conflict (review R04). Derived anchors are left
    // to stage 3, whose residual expresses exactly those two equations.
    for (const { shape } of comp.active) {
      if (shape.form !== 'fixed') continue;
      const expr = pointExpr(shape.point, comp.layout);
      if (expr.varPair === null) continue;
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
    // Rule 7 — distance point↔point (design §5.3.7). Horizontal/vertical
    // modes set the one coordinate directly (entry sign kept, §2.7). The
    // aligned form fires only when one point is determined and the other
    // is constrained to a known line/circle: intersect, and choose the
    // intersection closest to the point's current position (ties: the
    // smaller angle around the known point). Never a guess: no locus, no
    // firing. A determined coordinate that disagrees with the chosen
    // point is left for stage 3, exactly as in rule 2 adoption.
    for (const { c, shape } of comp.active) {
      if (shape.form !== 'distance-points') continue;
      const mode = c.distanceMode ?? 'aligned';
      const aE = pointExpr(shape.a, comp.layout);
      const bE = pointExpr(shape.b, comp.layout);
      if (mode === 'horizontal' || mode === 'vertical') {
        const off = mode === 'horizontal' ? 0 : 1;
        const axis = mode === 'horizontal' ? 'x' : 'y';
        for (const [pE, cE] of [
          [aE, bE],
          [bE, aE],
        ] as const) {
          const cVal = axisValue(cE, axis, det, vals);
          if (cVal === null || pE.varPair === null || det[pE.varPair + off]) continue;
          const sigma = vals[pE.varPair + off]! - cVal < 0 ? -1 : 1;
          vals[pE.varPair + off] = cVal + sigma * c.value!;
          det[pE.varPair + off] = 1;
          fire();
        }
        continue;
      }
      for (const [pSide, pE, cE] of [
        [shape.a, aE, bE],
        [shape.b, bE, aE],
      ] as const) {
        if (pE.varPair === null || fullyDetermined(pE, det) || !fullyDetermined(cE, det)) continue;
        const locus = findLocus(comp, pSide, c.id, det, vals);
        if (!locus) continue;
        const center = cE.eval(vals);
        const candidates = intersectLocus(center, c.value!, locus);
        if (candidates.length === 0) continue;
        const current = pE.eval(vals);
        candidates.sort(
          (p, q) => dist(p, current) - dist(q, current) || Math.atan2(p.y - center.y, p.x - center.x) - Math.atan2(q.y - center.y, q.x - center.x),
        );
        const chosen = candidates[0]!;
        const at = pE.varPair;
        if ((det[at] && vals[at] !== chosen.x) || (det[at + 1] && vals[at + 1] !== chosen.y)) continue;
        vals[at] = chosen.x;
        vals[at + 1] = chosen.y;
        det[at] = 1;
        det[at + 1] = 1;
        fire();
      }
    }
    // Rule 8 — parallel / perpendicular orientation adoption (§5.3.8):
    // one direction determined, the other segment has a determined
    // endpoint — rotate the free endpoint about the fixed one to the
    // target direction, preserving current length; of the two target
    // directions (±), the branch closest to the current endpoint wins.
    for (const { c, shape } of comp.active) {
      if (shape.form !== 'direction-pair' || (c.kind !== 'parallel' && c.kind !== 'perpendicular')) continue;
      for (const [known, free] of [
        [shape.a, shape.b],
        [shape.b, shape.a],
      ] as const) {
        const [kp, kq] = segmentExprs(known, comp.layout);
        if (!fullyDetermined(kp, det) || !fullyDetermined(kq, det)) continue;
        const ka = kp.eval(vals);
        const kb = kq.eval(vals);
        const kd = { x: kb.x - ka.x, y: kb.y - ka.y };
        const kL = Math.hypot(kd.x, kd.y);
        if (kL < DEGENERATE_REL * comp.S) continue;
        const ku = { x: kd.x / kL, y: kd.y / kL };
        const targets =
          c.kind === 'parallel'
            ? [ku, { x: -ku.x, y: -ku.y }]
            : [
                { x: -ku.y, y: ku.x },
                { x: ku.y, y: -ku.x },
              ];
        const [fp, fq] = segmentExprs(free, comp.layout);
        let placed = false;
        for (const [fixedE, freeE] of [
          [fp, fq],
          [fq, fp],
        ] as const) {
          if (!fullyDetermined(fixedE, det) || freeE.varPair === null || det[freeE.varPair] || det[freeE.varPair + 1]) continue;
          const fixedPt = fixedE.eval(vals);
          const freePt = freeE.eval(vals);
          const L = dist(freePt, fixedPt);
          if (L < DEGENERATE_REL * comp.S) continue;
          let best = targets[0]!;
          let bestDist = Infinity;
          for (const t of targets) {
            const dd = dist({ x: fixedPt.x + L * t.x, y: fixedPt.y + L * t.y }, freePt);
            if (dd < bestDist) {
              bestDist = dd;
              best = t;
            }
          }
          vals[freeE.varPair] = fixedPt.x + L * best.x;
          vals[freeE.varPair + 1] = fixedPt.y + L * best.y;
          det[freeE.varPair] = 1;
          det[freeE.varPair + 1] = 1;
          fire();
          placed = true;
          break;
        }
        if (placed) break;
      }
    }
    // Rule 9 — equal length rescale (§5.3.9): known length on one
    // segment, the other has a determined endpoint — rescale the free
    // endpoint about the fixed one to the known length.
    for (const { shape } of comp.active) {
      if (shape.form !== 'equal-length') continue;
      for (const [known, free] of [
        [shape.a, shape.b],
        [shape.b, shape.a],
      ] as const) {
        const [kp, kq] = segmentExprs(known, comp.layout);
        if (!fullyDetermined(kp, det) || !fullyDetermined(kq, det)) continue;
        const lenK = dist(kp.eval(vals), kq.eval(vals));
        if (lenK < DEGENERATE_REL * comp.S) continue;
        const [fp, fq] = segmentExprs(free, comp.layout);
        let placed = false;
        for (const [fixedE, freeE] of [
          [fp, fq],
          [fq, fp],
        ] as const) {
          if (!fullyDetermined(fixedE, det) || freeE.varPair === null || det[freeE.varPair] || det[freeE.varPair + 1]) continue;
          const fixedPt = fixedE.eval(vals);
          const freePt = freeE.eval(vals);
          const lenC = dist(freePt, fixedPt);
          if (lenC < DEGENERATE_REL * comp.S) continue;
          const k = lenK / lenC;
          vals[freeE.varPair] = fixedPt.x + (freePt.x - fixedPt.x) * k;
          vals[freeE.varPair + 1] = fixedPt.y + (freePt.y - fixedPt.y) * k;
          det[freeE.varPair] = 1;
          det[freeE.varPair + 1] = 1;
          fire();
          placed = true;
          break;
        }
        if (placed) break;
      }
    }
    // Rule 10 — angle to the target absolute direction (§5.3.10): one
    // line determined, the other has a determined endpoint — rotate the
    // free endpoint about the fixed one, preserving current length.
    // The residual is θ_b − θ_a = value, so a determined side b fixes
    // side a's target at θ_b − value.
    for (const { c, shape } of comp.active) {
      if (shape.form !== 'direction-pair' || c.kind !== 'angle') continue;
      for (const [detSide, freeSide, sign] of [
        [shape.a, shape.b, 1],
        [shape.b, shape.a, -1],
      ] as const) {
        const [dp, dq] = segmentExprs(detSide, comp.layout);
        if (!fullyDetermined(dp, det) || !fullyDetermined(dq, det)) continue;
        const da = dp.eval(vals);
        const db = dq.eval(vals);
        const theta = Math.atan2(db.y - da.y, db.x - da.x) + sign * c.value!;
        const target = { x: Math.cos(theta), y: Math.sin(theta) };
        const [fp, fq] = segmentExprs(freeSide, comp.layout);
        let placed = false;
        for (const [fixedE, freeE] of [
          [fp, fq],
          [fq, fp],
        ] as const) {
          if (!fullyDetermined(fixedE, det) || freeE.varPair === null || det[freeE.varPair] || det[freeE.varPair + 1]) continue;
          const fixedPt = fixedE.eval(vals);
          const freePt = freeE.eval(vals);
          const L = dist(freePt, fixedPt);
          if (L < DEGENERATE_REL * comp.S) continue;
          vals[freeE.varPair] = fixedPt.x + L * target.x;
          vals[freeE.varPair + 1] = fixedPt.y + L * target.y;
          det[freeE.varPair] = 1;
          det[freeE.varPair + 1] = 1;
          fire();
          placed = true;
          break;
        }
        if (placed) break;
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

// ---------------------------------------------------------------------------
// Result-geometry validation (review R03). The stage-1 checks and the
// mid-solve trial check only watch the forms they enumerate, so the
// delivered engine could return SUCCESS with collapsed geometry: a
// coincident pull joining a line's own endpoints, a horizontal+vertical
// pair on one segment, an equal-length/radius adoption of a sub-band
// measure, or a stage-2 construction writing both endpoints onto one
// point. Before any success is returned, the result is validated
// against the entry geometry: any segment length or radius that was
// at/above the engine's own degenerate band (DEGENERATE_REL·S, §5.5)
// at entry and falls below it in the result refuses the solve with
// 'degenerate-geometry' — the collapsed geometry is never returned.
// Geometry already below the band at entry is not a collapse (it was
// never valid by the band's reading) and is left to the other checks.
// ---------------------------------------------------------------------------

function geometryMeasures(e: ConstrainableEntity, vars: Float64Array, offset: number): readonly number[] {
  switch (e.type) {
    case 'line':
      return [Math.hypot(vars[offset + 2]! - vars[offset]!, vars[offset + 3]! - vars[offset + 1]!)];
    case 'circle':
    case 'arc':
      return [vars[offset + 2]!];
    case 'polyline': {
      const n = e.points.length;
      const segCount = e.closed ? n : n - 1;
      const ms: number[] = [];
      for (let i = 0; i < segCount; i += 1) {
        const j = (i + 1) % n;
        ms.push(Math.hypot(vars[offset + 2 * j]! - vars[offset + 2 * i]!, vars[offset + 2 * j + 1]! - vars[offset + 2 * i + 1]!));
      }
      return ms;
    }
    default:
      return [];
  }
}

/** The first entity whose valid-at-entry geometry `vars` collapses, if any. */
function findCollapse(comp: Comp, vars: Float64Array): { readonly entityId: string } | null {
  const band = DEGENERATE_REL * comp.S;
  for (const ev of comp.list) {
    const before = geometryMeasures(ev.entity, comp.vars0, ev.offset);
    const after = geometryMeasures(ev.entity, vars, ev.offset);
    for (let i = 0; i < before.length; i += 1) {
      if (before[i]! >= band && after[i]! < band) return { entityId: ev.entity.id };
    }
  }
  return null;
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

// ---------------------------------------------------------------------------
// Translation-invariant satisfaction of length-dimensional constraints
// (review R02). Length residuals are normalized by the component scale S
// (design §5.4), so the normalized acceptance bound RESIDUAL_TOL·S grows
// with the drawing's coordinates: at |coordinates| ≳ 1e9 it exceeds one
// whole drawing unit, and the delivered engine reported a driving
// distance of 11 "satisfied" while the points were still 10 apart.
// Satisfaction of a length-dimensional DRIVING constraint (distance /
// radius / diameter) is therefore also verified unnormalized, against
// the constraint's own scale — its target and measured quantity, both
// translation-invariant: |actual − target| ≤ TOL · max(1, |target|,
// |actual|). RESIDUAL_TOL / CONFLICT_TOL themselves are unchanged; at
// S ≤ the constraint's own scale the two criteria coincide, so behaviour
// at ordinary coordinates is identical. Angle is scale-free (radians)
// and geometric residuals keep the §5.4 normalized reading.
// ---------------------------------------------------------------------------

/** The target of a length-dimensional constraint in the units its
 *  residual measures (diameter residuals measure the radius). */
function lengthTarget(c: Constraint): number {
  return c.kind === 'diameter' ? c.value! / 2 : c.value!;
}

function isLengthDimensional(c: Constraint): boolean {
  return c.kind === 'distance' || c.kind === 'radius' || c.kind === 'diameter';
}

/** Is a driving constraint satisfied at the given normalized residual
 *  magnitude? `S` is the scale the residual was normalized by, so
 *  `normalizedMag · S` is the raw (unnormalized) error. */
function drivingSatisfied(c: Constraint, normalizedMag: number, S: number): boolean {
  if (normalizedMag > RESIDUAL_TOL) return false;
  if (!isLengthDimensional(c)) return true;
  const rawErr = normalizedMag * S;
  // |actual| ≤ |target| + rawErr, so this local scale never understates
  // max(1, |target|, |actual|).
  const local = Math.max(1, Math.abs(lengthTarget(c)) + rawErr);
  return rawErr <= RESIDUAL_TOL * local;
}

/** Conflict evidence (§5.6) for a length-dimensional constraint, on the
 *  same translation-invariant scale: the raw error exceeds
 *  CONFLICT_TOL · max(1, |target|, |actual|). */
function drivingViolated(c: Constraint, normalizedMag: number, S: number): boolean {
  if (!isLengthDimensional(c)) return false;
  const rawErr = normalizedMag * S;
  const local = Math.max(1, Math.abs(lengthTarget(c)) + rawErr);
  return rawErr > CONFLICT_TOL * local;
}

/** Every residual set of the component satisfied (normalized criterion,
 *  plus the R02 unnormalized criterion for length-dimensional kinds). */
function allSatisfied(comp: Comp, mag: ReadonlyMap<string, number>): boolean {
  for (const rs of comp.residuals) {
    if (!drivingSatisfied(rs.constraint, mag.get(rs.constraint.id) ?? Infinity, comp.S)) return false;
  }
  return true;
}

function maxAbs(a: Float64Array): number {
  let m = 0;
  for (const v of a) if (Math.abs(v) > m) m = Math.abs(v);
  return m;
}

function solveComponent(comp: Comp, work: Work, poll: Poll): CompOutcome {
  const nVars = comp.vars0.length;
  // Stage 1 degenerate detection (design §5.3): a segment of ~zero length
  // has no direction, so any kind that reads its direction (horizontal/
  // vertical, parallel/perpendicular/angle, point-on-line forms, and the
  // line side of a tangent — its distance-to-line form divides by the
  // segment length) refuses; a tangent/concentric partner with ~zero
  // radius is degenerate (§5.3 names tangent explicitly).
  for (const { c, shape } of comp.active) {
    const dirSides: readonly Side[] | null =
      shape.form === 'hv-segment'
        ? [shape.seg]
        : shape.form === 'direction-pair'
          ? [shape.a, shape.b]
          : shape.form === 'distance-point-line'
            ? [shape.seg]
            : shape.form === 'coincident-object' && shape.object.entity.type === 'line'
              ? [shape.object]
              : shape.form === 'tangent'
                ? [shape.a, shape.b].filter((s) => segmentEndpoints(s.entity, s.ref) !== null)
                : null;
    if (dirSides) {
      for (const s of dirSides) {
        const ends = segmentEndpoints(s.entity, s.ref)!;
        if (dist(ends[0], ends[1]) < DEGENERATE_REL * comp.S) {
          return {
            ok: false,
            vars: comp.vars0,
            mag: new Map(),
            failure: { code: 'degenerate-geometry', constraintIds: [c.id], message: `Constraint '${c.id}' (${c.kind}) references a zero-length segment, which has no direction.` },
          };
        }
      }
    }
    const curveSides: readonly Side[] | null =
      shape.form === 'concentric'
        ? [shape.a, shape.b]
        : shape.form === 'tangent'
          ? [shape.a, shape.b].filter((s) => s.entity.type === 'circle' || s.entity.type === 'arc')
          : null;
    if (curveSides) {
      for (const s of curveSides) {
        const r = (s.entity as Extract<ConstrainableEntity, { type: 'circle' | 'arc' }>).radius;
        if (r < DEGENERATE_REL * comp.S) {
          return {
            ok: false,
            vars: comp.vars0,
            mag: new Map(),
            failure: { code: 'degenerate-geometry', constraintIds: [c.id], message: `Constraint '${c.id}' (${c.kind}) references entity '${s.entity.id}' with a degenerate radius.` },
          };
        }
      }
    }
    // A line-length distance whose target is inside the degenerate band
    // would collapse its segment (§5.7: a driven length crossing
    // DEGENERATE_REL·S; §7 case 9(iii)). A point–point distance of 0 is
    // legitimate and is not this form. If the segment is already inside
    // the band there is nothing to collapse and the row simply reads ~0.
    if (shape.form === 'distance-length' && c.value! < DEGENERATE_REL * comp.S) {
      const ends = segmentEndpoints(shape.seg.entity, shape.seg.ref)!;
      if (dist(ends[0], ends[1]) >= DEGENERATE_REL * comp.S) {
        return {
          ok: false,
          vars: comp.vars0,
          mag: new Map(),
          failure: {
            code: 'degenerate-geometry',
            constraintIds: [c.id],
            message: `Constraint '${c.id}' (distance) drives the length of entity '${shape.seg.entity.id}' to ${c.value}, collapsing it through the degenerate band.`,
          },
        };
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

  // R03 gate: every success path below passes through here first.
  const collapseFailure = (vars: Float64Array, mag: ReadonlyMap<string, number>): CompOutcome | null => {
    const hit = findCollapse(comp, vars);
    if (!hit) return null;
    const ids = comp.active.filter((a) => shapeEntities(a.shape).some((s) => s.entity.id === hit.entityId)).map((a) => a.c.id);
    return {
      ok: false,
      vars: comp.vars0,
      mag,
      failure: {
        code: 'degenerate-geometry',
        constraintIds: ids.length > 0 ? ids : comp.active.map((a) => a.c.id),
        message: `The solve would collapse entity '${hit.entityId}' — a segment length or radius that was valid at entry falls below the degenerate band (DEGENERATE_REL·S); the collapsed result is refused.`,
      },
    };
  };

  // Which constraints did stage 2 discharge? Satisfied at the determined
  // values with every variable they read determined. Satisfaction is the
  // R02-aware predicate: a length-dimensional constraint whose raw error
  // is hidden by the component scale is NOT discharged — stage 3 must
  // still move its geometry.
  const r0 = evalAll(comp, vals, work);
  const mag0 = magMap(comp, r0);
  const discharged = new Set<string>();
  for (const rs of comp.residuals) {
    if (rs.vars.every((v) => det[v]) && drivingSatisfied(rs.constraint, mag0.get(rs.constraint.id) ?? Infinity, comp.S)) discharged.add(rs.constraint.id);
  }
  const freeSet = new Set<number>();
  for (const rs of comp.residuals) {
    if (discharged.has(rs.constraint.id)) continue;
    for (const v of rs.vars) freeSet.add(v);
  }
  if (freeSet.size === 0) {
    const cf = collapseFailure(vals, mag0);
    if (cf) return cf;
    return { ok: true, vars: vals, mag: mag0 };
  }
  const free = [...freeSet].sort((a, b) => a - b);

  // Endpoint variable pairs of every segment whose residual form reads
  // its length or direction (direction pairs, the length and point–line
  // distance forms, point-on-line, the line side of a tangent), with
  // entry lengths, for the mid-solve degeneracy check: a segment that
  // starts outside the degenerate band and collapses into it mid-solve
  // leaves its residual form undefined (design §5.7). The entry guard
  // keeps a segment that legitimately starts inside the band (possible
  // only for the distance-length form, which stage 1 does not refuse)
  // from tripping the check.
  const collapseSegVars: { a: number; b: number; entry: number }[] = [];
  for (const { shape } of comp.active) {
    const segSides: readonly Side[] =
      shape.form === 'direction-pair' || shape.form === 'tangent'
        ? [shape.a, shape.b]
        : shape.form === 'distance-length' || shape.form === 'distance-point-line'
          ? [shape.seg]
          : shape.form === 'coincident-object' && shape.object.entity.type === 'line'
            ? [shape.object]
            : [];
    for (const s of segSides) {
      if (segmentEndpoints(s.entity, s.ref) === null) continue;
      const [e0, e1] = segmentExprs(s, comp.layout);
      if (e0.varPair !== null && e1.varPair !== null) {
        const pa = e0.eval(comp.vars0);
        const pb = e1.eval(comp.vars0);
        collapseSegVars.push({ a: e0.varPair, b: e1.varPair, entry: dist(pa, pb) });
      }
    }
  }

  let x = new Float64Array(vals);
  let r = r0;
  let mag = mag0;
  if (allSatisfied(comp, mag)) {
    const cf = collapseFailure(x, mag);
    if (cf) return cf;
    return { ok: true, vars: x, mag };
  }

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
    // Levenberg step over the free variables, computed by QR of the
    // Jacobian itself (F-3034 avenue 1). The delivered engine formed
    // the normal equations A = JfᵀJf; at the tangent fold the Jacobian
    // is singular AT the solution, and squaring it (condition number
    // κ(J)²) destroyed the small singular directions entirely: the
    // elimination returned steps carrying a large component along the
    // near-null arc-centre direction, which changes no residual but
    // counted in full in `lastStep`, so the iteration crept along the
    // fold until MAX_ITERATIONS with the residual already at 1e-13.
    // Solving the damped least-squares problem on Jf directly —
    // min ‖[Jf; μI]δ + [r; 0]‖ by Householder QR with deterministic
    // column pivoting — keeps the conditioning at κ(J), and the μI
    // block suppresses exactly the sub-μ singular directions instead
    // of amplifying their numerical noise.
    const f = free.length;
    const Jf = new Float64Array(comp.totalRows * f);
    for (let row = 0; row < comp.totalRows; row += 1) {
      for (let i = 0; i < f; i += 1) Jf[row * f + i] = J[row * nVars + free[i]!]!;
    }
    let accepted = false;
    let step = new Float64Array(nVars);
    // Damping scale for this iteration: κ = the largest squared column
    // norm of Jf (the largest normal-equation diagonal), and the
    // augmentation is μI with μ = √(λ·κ). The damping stays a scalar
    // multiple of the identity at the system's own scale: per-diagonal
    // Marquardt scaling is NOT used — it breaks the eigen-decomposition
    // of the rank-1 blocks that direction/distance rows produce,
    // coupling a radial right-hand side into large tangential steps (a
    // point driven to a target distance slid sideways along its circle
    // instead of moving radially). A scalar κ keeps the damping
    // scale-free across coordinate magnitudes (case 8a, S ≈ 1e8)
    // without that coupling. Work accounting: each QR factorization is
    // charged (totalRows + f)·f units — the same order as the jacAll
    // charge (totalRows·nVars) it accompanies, so workUsed stays
    // deterministic and comparable in magnitude to the delivered engine.
    let kappa = 0;
    for (let i = 0; i < f; i += 1) {
      let s = 0;
      for (let row = 0; row < comp.totalRows; row += 1) s += Jf[row * f + i]! * Jf[row * f + i]!;
      if (s > kappa) kappa = s;
    }
    if (kappa === 0) kappa = 1;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      work.used += (comp.totalRows + f) * f;
      const delta = qrLeastSquaresStep(Jf, comp.totalRows, f, r, Math.sqrt(lambda * kappa));
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
      // Mid-solve degeneracy: a driven radius crossing the degenerate
      // band, or a length/direction-reading segment collapsing from
      // outside the band into it.
      let degenerate = false;
      for (const ev of comp.list) {
        if (ev.entity.type === 'circle' || ev.entity.type === 'arc') {
          if (trial[ev.offset + 2]! < DEGENERATE_REL * comp.S) degenerate = true;
        }
      }
      for (const sv of collapseSegVars) {
        if (sv.entry < DEGENERATE_REL * comp.S) continue;
        const dx = trial[sv.b]! - trial[sv.a]!;
        const dy = trial[sv.b + 1]! - trial[sv.a + 1]!;
        if (Math.hypot(dx, dy) < DEGENERATE_REL * comp.S) degenerate = true;
      }
      if (degenerate) {
        return {
          ok: false,
          vars: x,
          mag,
          failure: { code: 'degenerate-geometry', constraintIds: comp.active.map((a) => a.c.id), message: 'A driven radius or direction collapsed toward zero during the solve.' },
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
    // Convergence requires genuine satisfaction — the R02 predicate, so
    // a normalized pass cannot end the solve while a driving distance is
    // still a whole unit off at large coordinates. Note the stationary
    // test below deliberately keeps its delivered form (small step with
    // the NORMALIZED residual still open): a dimensionally-unmet but
    // still-progressing iteration has a step that is only "small"
    // relative to the huge component S, and its steps keep being
    // accepted — it is converging, not stationary, and must be allowed
    // to reach the unnormalized bound (or the iteration limit).
    if (allSatisfied(comp, mag) && lastStep <= STEP_TOL * comp.S) {
      converged = true;
      break;
    }
    if (lastStep <= STEP_TOL * comp.S && maxAbs(r) > RESIDUAL_TOL) {
      stationary = true;
      break;
    }
  }
  if (converged) {
    const cf = collapseFailure(x, mag);
    if (cf) return cf;
    return { ok: true, vars: x, mag };
  }
  if (stationary || iterations > MAX_ITERATIONS) {
    const finalMag = maxAbs(r);
    // Conflict evidence (§5.6): a normalized residual above CONFLICT_TOL,
    // or — for length-dimensional constraints, whose normalized residual
    // shrinks with the drawing's translation (R02) — a raw error above
    // CONFLICT_TOL on the constraint's own scale.
    const conflictEvidence = (a: ActiveC): boolean =>
      (mag.get(a.c.id) ?? 0) > CONFLICT_TOL || drivingViolated(a.c, mag.get(a.c.id) ?? 0, comp.S);
    if (stationary && (finalMag > CONFLICT_TOL || comp.active.some(conflictEvidence))) {
      const ids = comp.active.filter(conflictEvidence).map((a) => a.c.id);
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
        failure: {
          code: 'numeric-failure',
          constraintIds: comp.active.filter((a) => !drivingSatisfied(a.c, mag.get(a.c.id) ?? Infinity, comp.S)).map((a) => a.c.id),
          message: 'The relaxation became stationary above the residual tolerance but below the conflict tolerance.',
        },
      };
    }
    return {
      ok: false,
      vars: x,
      mag,
      failure: { code: 'iteration-limit', constraintIds: comp.active.filter((a) => (mag.get(a.c.id) ?? 0) > RESIDUAL_TOL).map((a) => a.c.id), message: `Iteration limit (${MAX_ITERATIONS}) reached while still progressing.` },
    };
  }
  // Defensive: the loop always exits through a flag above; never claim
  // success the satisfaction predicate cannot back.
  if (allSatisfied(comp, mag)) {
    const cf = collapseFailure(x, mag);
    if (cf) return cf;
    return { ok: true, vars: x, mag };
  }
  return {
    ok: false,
    vars: x,
    mag,
    failure: { code: 'iteration-limit', constraintIds: comp.active.filter((a) => !drivingSatisfied(a.c, mag.get(a.c.id) ?? Infinity, comp.S)).map((a) => a.c.id), message: `Iteration limit (${MAX_ITERATIONS}) reached while still progressing.` },
  };
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
  /** Circle–circle tangent entry branches (§5.4); empty when unknown. */
  readonly branchById?: ReadonlyMap<string, 'external' | 'internal'>;
}

/** Diagnostic-level satisfaction / violation of a driving constraint,
 *  R02-aware: for length-dimensional kinds the measured value (computed
 *  from the reported geometry, in the constraint's own units) must agree
 *  with the target on the translation-invariant scale — a normalized
 *  residual pass at |coordinates| ≳ 1e9 must not print "satisfied" over
 *  a whole-unit error. */
function diagSatisfied(c: Constraint, mag: number | undefined, measured: number | undefined): boolean {
  if (mag === undefined || mag > RESIDUAL_TOL) return false;
  if (isLengthDimensional(c) && c.value !== undefined && measured !== undefined) {
    const local = Math.max(1, Math.abs(c.value), Math.abs(measured));
    if (Math.abs(measured - c.value) > RESIDUAL_TOL * local) return false;
  }
  return true;
}

function diagViolated(c: Constraint, mag: number | undefined, measured: number | undefined): boolean {
  if (mag !== undefined && mag > CONFLICT_TOL) return true;
  if (isLengthDimensional(c) && c.value !== undefined && measured !== undefined) {
    const local = Math.max(1, Math.abs(c.value), Math.abs(measured));
    if (Math.abs(measured - c.value) > CONFLICT_TOL * local) return true;
  }
  return false;
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
    const measured = measuredValue(c, shape, byId);
    let state: ConstraintDiagnostic['state'];
    if (ctx.mode === 'solved') {
      state = ctx.redundant.has(c.id) ? 'redundant' : diagSatisfied(c, mag, measured) ? 'satisfied' : 'unresolved';
    } else if (ctx.mode === 'conflict') {
      state = diagViolated(c, mag, measured) ? 'violated' : diagSatisfied(c, mag, measured) ? 'satisfied' : 'unresolved';
    } else {
      state = diagSatisfied(c, mag, measured) ? 'satisfied' : 'unresolved';
    }
    const branch = ctx.branchById?.get(c.id);
    return {
      constraintId: c.id,
      state,
      residual: mag ?? 0,
      measured,
      ...(branch ? { branch } : {}),
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
  const branchById = new Map<string, 'external' | 'internal'>();
  for (const comp of comps) for (const [k, v] of comp.branchById) branchById.set(k, v);

  const failures = outcomes.filter((o) => !o.ok);
  if (failures.length > 0) {
    const conflict = failures.find((f) => f.failure!.code === 'conflicting-constraints');
    const chosen = conflict ?? failures[0]!;
    // R02: the violated set of a conflicting result uses the same
    // translation-invariant evidence as the diagnostics — a driving
    // distance a whole unit off at 1e9 coordinates is violated even
    // though its normalized residual is below CONFLICT_TOL.
    const geomById = new Map<string, Entity>(entities.map((e) => [e.id, e]));
    const violatedIds = conflict
      ? set.constraints
          .filter((c) => !c.suppressed && c.role === 'driving' && diagViolated(c, magById.get(c.id), measuredValue(c, shapes.get(c.id) ?? null, geomById)))
          .map((c) => c.id)
      : chosen.failure!.constraintIds;
    return {
      ok: false,
      status: conflict ? 'conflicting' : 'unsolved',
      dof: nominalDof(),
      diagnostics: buildDiagnostics(set, { magById, redundant: new Set(), mode: conflict ? 'conflict' : 'failed', geometry: entities, shapes, branchById }),
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
  // Point-on-object on a bulged polyline (§2.5): the form measures the
  // point against the polyline's segments while the bulges ride along
  // as carried data — if the point (or the polyline) moved under such a
  // constraint, the carried bulge is part of the result and is reported
  // rather than silently treated as the chord's arc.
  const movedById = new Map<string, boolean>(entities.map((e, i) => [e.id, resultEntities[i] !== e]));
  for (const { c, shape } of prep.active) {
    if (shape.form !== 'coincident-object' || shape.object.entity.type !== 'polyline' || !hasBulge(shape.object.entity)) continue;
    if (!movedById.get(shape.point.entity.id) && !movedById.get(shape.object.entity.id)) continue;
    if (notes.some((n) => n.entityId === shape.object.entity.id && n.constraintId === c.id)) continue;
    notes.push({ code: 'bulge-carried', entityId: shape.object.entity.id, constraintId: c.id });
  }

  // DOF rank machinery at the result (design §5.6/§3.3).
  let effectiveConsumed = 0;
  const redundant = new Set<string>();
  const perEntityRemaining = new Map<string, number>();
  let probeBudgetOut = false;
  // R12: if ANY component's main rank probe is budget-skipped, the
  // overall rank is unknown — skipped components must not silently
  // contribute 0 to effectiveConsumed (which fabricated a positive
  // `remaining` and an 'underconstrained' verdict).
  let rankUnknown = false;
  comps.forEach((comp, ci) => {
    const outcome = outcomes[ci]!;
    if (comp.totalRows > 0) {
      if (work.used + comp.totalRows * comp.vars0.length > work.limit) {
        probeBudgetOut = true;
        rankUnknown = true;
        return;
      }
      const J = jacAll(comp, outcome.vars, work);
      const rank = denseRank(J, comp.totalRows, comp.vars0.length);
      effectiveConsumed += rank;
      // Redundancy probes (design §5.6), sequential in reverse stored
      // order: a constraint is redundant when removing it from the rows
      // that remain (its own rows plus those of constraints not already
      // marked) does not reduce the rank, and its residual is satisfied.
      // Probing last-to-first makes the earliest-stored constraint the
      // keeper and a later duplicate the redundant one; each marked
      // constraint was removable at its probe, so the marked set is
      // jointly removable — marking both members of a dependent pair
      // (the simultaneous reading) would be wrong, because deleting
      // both would lose rank the report claims is preserved.
      const excluded = new Uint8Array(comp.totalRows);
      for (let ri = comp.residuals.length - 1; ri >= 0; ri -= 1) {
        const rs = comp.residuals[ri]!;
        if ((magById.get(rs.constraint.id) ?? Infinity) > RESIDUAL_TOL) continue;
        const at = comp.rowOffset.get(rs.constraint.id)!;
        const probeRows: number[] = [];
        for (let rI = 0; rI < comp.totalRows; rI += 1) {
          if (excluded[rI] || (rI >= at && rI < at + rs.rowCount)) continue;
          probeRows.push(rI);
        }
        if (work.used + probeRows.length * comp.vars0.length > work.limit) {
          probeBudgetOut = true;
          break;
        }
        const sub = new Float64Array(probeRows.length * comp.vars0.length);
        probeRows.forEach((rI, w) => {
          for (let cI = 0; cI < comp.vars0.length; cI += 1) sub[w * comp.vars0.length + cI] = J[rI * comp.vars0.length + cI]!;
        });
        work.used += probeRows.length * comp.vars0.length;
        if (denseRank(sub, probeRows.length, comp.vars0.length) === rank) {
          redundant.add(rs.constraint.id);
          for (let rI = at; rI < at + rs.rowCount; rI += 1) excluded[rI] = 1;
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
    // R12: the stated unknown (-1 — the same marker the per-entity
    // report uses) when any component's rank probe was budget-skipped;
    // never a sum that treats skipped components as consuming 0.
    effectiveConsumed: rankUnknown ? -1 : effectiveConsumed,
    remaining: rankUnknown ? -1 : total - effectiveConsumed,
    perEntity: prep.participating.map((e) => ({
      entityId: e.id,
      dof: entityDof(e),
      // §3.3: when the rank factorization itself was budget-skipped, the
      // entities of that component were never probed — their remaining
      // is the stated unknown (-1), not a silently-reported full DOF
      // (30.3.4; the fallback previously claimed "nothing consumed").
      remaining: perEntityRemaining.get(e.id) ?? (probeBudgetOut ? -1 : entityDof(e)),
    })),
  };

  return {
    ok: true,
    status: rankUnknown ? 'rank-unknown' : dof.remaining === 0 ? 'fully-constrained' : 'underconstrained',
    entities: resultEntities,
    dof,
    diagnostics: buildDiagnostics(set, { magById, redundant, mode: 'solved', geometry: resultEntities, shapes, branchById }),
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
  const branchById = new Map<string, 'external' | 'internal'>();
  let effectiveConsumed = 0;
  const perEntityRemaining = new Map<string, number>();
  const supportedActive = prep.active.filter(({ shape }) => shapeSupported(shape));
  if (supportedActive.length > 0) {
    const residuals = supportedActive.map(({ c, shape }) => buildResidual(c, shape, layout, S, vars0)!);
    for (const r of residuals) if (r.branch) branchById.set(r.constraint.id, r.branch);
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
  const geomById = new Map<string, Entity>(entities.map((e) => [e.id, e]));
  const allSatisfied = prep.active.every(({ c }) => {
    const m = magById.get(c.id);
    if (m === undefined || m > RESIDUAL_TOL) return false;
    // R02: the normalized reading is not sufficient evidence for a
    // length-dimensional constraint at large coordinates.
    if (isLengthDimensional(c) && c.value !== undefined) {
      const mv = measuredValue(c, shapes.get(c.id) ?? null, geomById);
      if (mv !== undefined && Math.abs(mv - c.value) > RESIDUAL_TOL * Math.max(1, Math.abs(c.value), Math.abs(mv))) return false;
    }
    return true;
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
      branchById,
    }),
    status,
  };
}
