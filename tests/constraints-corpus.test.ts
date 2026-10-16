/**
 * Priority 30.3.4 — realistic-corpus measurement (design §9.2).
 *
 * The design's solver-library decision trigger: if the hand-written
 * engine returns `unsolved` — or the WRONG conflict verdict — on more
 * than 5% of a realistic corpus of ≥50 cases whose expected outcome is
 * solvable-or-conflicting, the evidence says evaluate a proven solver
 * library (with Codex review). This file IS that corpus: parameterized
 * families (full-scheme rectangles, bolt-hole patterns, tangent-fillet
 * plates, slots, symmetric brackets, plus conflicting and
 * expected-unsolved controls), each case asserting its hand-derived
 * expected status class. DOF counts in the family comments are
 * hand-derived; engine `remaining` is asserted wherever the count is a
 * pure rank count.
 *
 * Metric (asserted by the final test): bad / denominator, where the
 * denominator is the cases expected fully/under/conflicting and a case
 * is bad when an expected-solvable case returns unsolved or
 * conflicting, or an expected-conflicting case returns anything else.
 *
 * Posing policy: geometry is drawn CONSISTENT (coincident joints exact,
 * as placed with CAD snaps) and cases differ from their driving values
 * by realistic edits — the engine's actual usage is one batch solve per
 * edit (design §9.1). Free placement jitter is used only where it does
 * not break a coincident joint (bolt centres; rectangle/bracket corner
 * jitter, which stage 2 adopts robustly, is kept as basin evidence for
 * line/circle systems).
 *
 * MEASURED OUTCOME ON THIS ENGINE (30.3.4): the fillet, slot and
 * point-triangle families fail — see finding F-3034-1/F-3034-2 in the
 * 'finding' block at the bottom of this file. Those case tests are RED
 * on purpose: they assert the analytically correct expectation, and
 * their failure IS the §9.2 measurement. Do not weaken an expectation
 * to turn them green; a solver improvement should flip them honestly.
 */
import { describe, expect, it } from 'vitest';
import type { ArcEntity, CircleEntity, Entity, LineEntity, PointEntity } from '../src/core/entities';
import type { Constraint, ConstraintSet } from '../src/core/constraints/model';
import { analyzeConstraints, solveConstraints, type SolveResult } from '../src/core/constraints/solve';

const base = { layer: '0', color: 'ByLayer' as const };
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({ ...base, id, type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by } });
const circle = (id: string, cx: number, cy: number, r: number): CircleEntity => ({ ...base, id, type: 'circle', center: { x: cx, y: cy }, radius: r });
const arc = (id: string, cx: number, cy: number, r: number, a0: number, a1: number): ArcEntity => ({ ...base, id, type: 'arc', center: { x: cx, y: cy }, radius: r, startAngle: a0, endAngle: a1 });
const point = (id: string, x: number, y: number): PointEntity => ({ ...base, id, type: 'point', position: { x, y } });

const set = (...constraints: Constraint[]): ConstraintSet => ({ constraints });
const ref = (entityId: string, anchor: Constraint['refs'][number]['anchor'], index?: number) => ({ entityId, anchor, ...(index !== undefined ? { index } : {}) });
const byId = (entities: readonly Entity[]) => new Map(entities.map((e) => [e.id, e]));
const asLine = (e: Entity) => e as LineEntity;
const asCircle = (e: Entity) => e as CircleEntity;
const len = (l: LineEntity) => Math.hypot(l.b.x - l.a.x, l.b.y - l.a.y);

type Class = 'fully' | 'under' | 'conflicting' | 'unsolved';
interface CorpusCase {
  readonly id: string;
  readonly build: () => { entities: readonly Entity[]; constraints: ConstraintSet };
  readonly expect: Class;
  /** Hand-derived rank remaining for ok cases. */
  readonly remaining?: number;
  readonly check?: (result: SolveResult) => void;
}

const cases: CorpusCase[] = [];
const add = (c: CorpusCase) => cases.push(c);

// ---------------------------------------------------------------------------
// Family A — full-scheme rectangles (§7 case-1 scheme).
// DOF 16; consumed: coincident cycle 8 + H/V 4 + fixed 2 + width/height
// distances 2 = 16 ⇒ fully. Geometry starts slightly jittered.
// ---------------------------------------------------------------------------

function rectFull(w: number, h: number, ox = 0, oy = 0, jitter = 0.12) {
  const j0 = Math.min(jitter, 0.04 * Math.min(w, h));
  const j = (n: number) => (n % 3 === 0 ? j0 : n % 3 === 1 ? -j0 * 0.6 : j0 * 0.3);
  const entities = [
    line('bottom', ox, oy, ox + w + j(1), oy + j(2)),
    line('right', ox + w + j(1), oy + j(2), ox + w + j(3), oy + h + j(4)),
    line('top', ox + w + j(3), oy + h + j(4), ox + j(5), oy + h + j(6)),
    line('left', ox + j(5), oy + h + j(6), ox, oy),
  ];
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
    { id: 'dw', kind: 'distance', role: 'driving', value: w, refs: [ref('bottom', 'whole')] },
    { id: 'dh', kind: 'distance', role: 'driving', value: h, refs: [ref('right', 'whole')] },
  );
  return { entities, constraints };
}

const rectSizes: ReadonlyArray<readonly [number, number, number, number]> = [
  [10, 5, 0, 0],
  [16, 9, 5, -3],
  [3, 3, 100, 200],
  [250, 80, -40, 17],
  [1, 1, 0, 0],
  [7.5, 2.25, 2, 2],
  [40, 2, 0, 0],
  [2, 40, 0, 0],
  [12, 12, -7, -7],
  [1000, 1, 0, 0],
  [6, 6, 1e5, -1e5],
  [0.5, 0.25, 0, 0],
];
rectSizes.forEach(([w, h, ox, oy], i) => {
  add({
    id: `rect-full-${String(i + 1).padStart(2, '0')}`,
    build: () => rectFull(w, h, ox, oy),
    expect: 'fully',
    remaining: 0,
    check: (r) => {
      const out = byId(r.entities!);
      // Engine accuracy is relative to the system scale S (§5.4), so the
      // checks are relative too: 2e-6 of scale, ~2000× the residual tol.
      const close = (actual: number, expected: number) =>
        expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2e-6 * Math.max(1, Math.abs(expected), Math.abs(ox), Math.abs(oy)));
      close(len(asLine(out.get('bottom')!)), w);
      close(len(asLine(out.get('right')!)), h);
      const a = asLine(out.get('bottom')!).a;
      close(a.x, ox);
      close(a.y, oy);
    },
  });
});

// ---------------------------------------------------------------------------
// Family B — rectangles missing one scheme element (rank counts by hand).
// ---------------------------------------------------------------------------

function rectMinus(drop: 'dh' | 'fix' | 'dw-dh' | 'c4', w = 10, h = 5) {
  const { entities, constraints } = rectFull(w, h);
  const kept = constraints.constraints.filter((c) => {
    if (drop === 'dh') return c.id !== 'dh';
    if (drop === 'fix') return c.id !== 'fix';
    if (drop === 'dw-dh') return c.id !== 'dw' && c.id !== 'dh';
    return c.id !== 'c4';
  });
  return { entities, constraints: set(...kept) };
}
// Missing the height distance: 15 consumed of 16 ⇒ remaining 1.
for (const [i, [w, h]] of [
  [10, 5],
  [18, 7],
  [4, 2.5],
].entries()) {
  add({ id: `rect-under-height-${i + 1}`, build: () => rectMinus('dh', w, h), expect: 'under', remaining: 1 });
}
// Missing the fixed corner: the H/V constraints still pin the
// orientation absolutely, so only the 2 translations remain ⇒ 2.
for (let i = 0; i < 2; i += 1) {
  add({ id: `rect-under-nofix-${i + 1}`, build: () => rectMinus('fix'), expect: 'under', remaining: 2 });
}
// Missing both distances ⇒ remaining 2.
add({ id: 'rect-under-nodims', build: () => rectMinus('dw-dh'), expect: 'under', remaining: 2 });
// Open corner (no c4): the free quantities are the top line's length
// (its end x, carrying the left line's start) and the left end's y
// ⇒ remaining 2.
add({ id: 'rect-under-open-corner', build: () => rectMinus('c4'), expect: 'under', remaining: 2 });

// ---------------------------------------------------------------------------
// Family C — bolt-hole rows. k circles, DOF 3k; consumed: fixed 2 +
// (k−1) horizontal centre pairs + (k−1) pitch distances + (k−1) equal
// radii + 1 driving radius = 3k ⇒ fully.
// ---------------------------------------------------------------------------

function boltRow(k: number, pitch: number, radius: number) {
  const entities: Entity[] = [];
  for (let i = 0; i < k; i += 1) {
    entities.push(circle(`C${i}`, i * pitch + (i % 2 === 0 ? 0.2 : -0.15), (i % 3) * 0.11 - 0.1, radius * (i % 2 === 0 ? 1.05 : 0.94)));
  }
  const constraints: Constraint[] = [{ id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('C0', 'center')] }];
  for (let i = 1; i < k; i += 1) {
    constraints.push({ id: `h${i}`, kind: 'horizontal', role: 'driving', refs: [ref(`C${i - 1}`, 'center'), ref(`C${i}`, 'center')] });
    constraints.push({ id: `d${i}`, kind: 'distance', role: 'driving', value: pitch, refs: [ref(`C${i - 1}`, 'center'), ref(`C${i}`, 'center')] });
    constraints.push({ id: `e${i}`, kind: 'equal', role: 'driving', refs: [ref('C0', 'whole'), ref(`C${i}`, 'whole')] });
  }
  constraints.push({ id: 'r0', kind: 'radius', role: 'driving', value: radius, refs: [ref('C0', 'whole')] });
  return { entities, constraints: set(...constraints) };
}

const rows: ReadonlyArray<readonly [number, number, number]> = [
  [2, 8, 3],
  [3, 10, 2.5],
  [4, 12.5, 4],
  [5, 6, 1.5],
  [6, 20, 5],
  [3, 15, 6],
  [2, 25, 8],
  [4, 9, 2],
  [7, 11, 3.5],
  [5, 30, 10],
];
rows.forEach(([k, pitch, radius], i) => {
  add({
    id: `bolt-row-${String(i + 1).padStart(2, '0')}`,
    build: () => boltRow(k, pitch, radius),
    expect: 'fully',
    remaining: 0,
    check: (r) => {
      const out = byId(r.entities!);
      const close = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThanOrEqual(2e-6 * Math.max(1, Math.abs(expected)));
      // The fixed constraint grounds C0 at its DRAWN (jittered) position;
      // the row extends from there.
      const origin = asCircle(out.get('C0')!).center;
      for (let n = 0; n < k; n += 1) {
        const c = asCircle(out.get(`C${n}`)!);
        close(c.radius, radius);
        close(c.center.y, origin.y);
        close(c.center.x, origin.x + n * pitch);
      }
    },
  });
});

// ---------------------------------------------------------------------------
// Family D — bolt grids. Both grids ground the first circle, align
// rows/columns with H/V pairs, drive every row pitch and the first
// column pitch, and equalize radii: the far rows' pitch distances are
// nominally redundant (they follow from the verticals + first row) but
// consistent, so the rank count lands exactly on the DOF total
// (2×2: 12; 3×2: 18) ⇒ fully, remaining 0.
// ---------------------------------------------------------------------------

function boltGrid(cols: number, rowsN: number, px: number, py: number, radius: number) {
  const id = (cx: number, cy: number) => `G${cx}_${cy}`;
  const entities: Entity[] = [];
  for (let cy = 0; cy < rowsN; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      entities.push(circle(id(cx, cy), cx * px + 0.18, cy * py - 0.13, radius * 1.04));
    }
  }
  const constraints: Constraint[] = [{ id: 'fix', kind: 'fixed', role: 'driving', refs: [ref(id(0, 0), 'center')] }];
  for (let cy = 0; cy < rowsN; cy += 1) {
    for (let cx = 1; cx < cols; cx += 1) {
      constraints.push({ id: `h${cx}_${cy}`, kind: 'horizontal', role: 'driving', refs: [ref(id(cx - 1, cy), 'center'), ref(id(cx, cy), 'center')] });
      constraints.push({ id: `dx${cx}_${cy}`, kind: 'distance', role: 'driving', value: px, refs: [ref(id(cx - 1, cy), 'center'), ref(id(cx, cy), 'center')] });
    }
  }
  for (let cx = 0; cx < cols; cx += 1) {
    for (let cy = 1; cy < rowsN; cy += 1) {
      constraints.push({ id: `v${cx}_${cy}`, kind: 'vertical', role: 'driving', refs: [ref(id(cx, cy - 1), 'center'), ref(id(cx, cy), 'center')] });
      if (cx === 0) {
        constraints.push({ id: `dy${cy}`, kind: 'distance', role: 'driving', value: py, refs: [ref(id(0, cy - 1), 'center'), ref(id(0, cy), 'center')] });
      }
    }
  }
  let first = true;
  for (let cy = 0; cy < rowsN; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      if (first) {
        first = false;
        continue;
      }
      constraints.push({ id: `e${cx}_${cy}`, kind: 'equal', role: 'driving', refs: [ref(id(0, 0), 'whole'), ref(id(cx, cy), 'whole')] });
    }
  }
  constraints.push({ id: 'r0', kind: 'radius', role: 'driving', value: radius, refs: [ref(id(0, 0), 'whole')] });
  return { entities, constraints: set(...constraints) };
}

add({
  id: 'bolt-grid-2x2',
  build: () => boltGrid(2, 2, 10, 8, 3),
  expect: 'fully',
  remaining: 0,
  check: (r) => {
    const out = byId(r.entities!);
    // G0_0 is fixed at its drawn position; G1_1 sits one pitch away.
    const o = asCircle(out.get('G0_0')!).center;
    const c = asCircle(out.get('G1_1')!).center;
    expect(Math.abs(c.x - (o.x + 10))).toBeLessThanOrEqual(2e-5);
    expect(Math.abs(c.y - (o.y + 8))).toBeLessThanOrEqual(2e-5);
  },
});
add({ id: 'bolt-grid-3x2', build: () => boltGrid(3, 2, 12, 12, 2), expect: 'fully', remaining: 0 });

// ---------------------------------------------------------------------------
// Family E — plate outline with one tangent fillet. 4 lines + 1 arc,
// DOF 21; consumed: coincident 10 + H/V 4 + tangent 2 + fixed 2 +
// width/height distances 2 = 20 ⇒ remaining 1 (the fillet radius).
// Adding a driving radius ⇒ fully.
// ---------------------------------------------------------------------------

/** Drawn exactly at (W0, H0, R0); driven to (W, H) and, when
 *  driveRadius is set, radius R. Joints are exact (snapped). */
function filletPlate(W0: number, H0: number, R0: number, W: number, H: number, driveRadius: number | null) {
  const entities = [
    line('bottom', 0, 0, W0, 0),
    line('right', W0, 0, W0, H0 - R0),
    arc('fillet', W0 - R0, H0 - R0, R0, 0, Math.PI / 2),
    line('top', W0 - R0, H0, 0, H0),
    line('left', 0, H0, 0, 0),
  ];
  const constraints: Constraint[] = [
    { id: 'j1', kind: 'coincident', role: 'driving', refs: [ref('bottom', 'end'), ref('right', 'start')] },
    { id: 'j2', kind: 'coincident', role: 'driving', refs: [ref('right', 'end'), ref('fillet', 'start')] },
    { id: 'j3', kind: 'coincident', role: 'driving', refs: [ref('fillet', 'end'), ref('top', 'start')] },
    { id: 'j4', kind: 'coincident', role: 'driving', refs: [ref('top', 'end'), ref('left', 'start')] },
    { id: 'j5', kind: 'coincident', role: 'driving', refs: [ref('left', 'end'), ref('bottom', 'start')] },
    { id: 'hb', kind: 'horizontal', role: 'driving', refs: [ref('bottom', 'whole')] },
    { id: 'ht', kind: 'horizontal', role: 'driving', refs: [ref('top', 'whole')] },
    { id: 'vr', kind: 'vertical', role: 'driving', refs: [ref('right', 'whole')] },
    { id: 'vl', kind: 'vertical', role: 'driving', refs: [ref('left', 'whole')] },
    { id: 't1', kind: 'tangent', role: 'driving', refs: [ref('right', 'whole'), ref('fillet', 'whole')] },
    { id: 't2', kind: 'tangent', role: 'driving', refs: [ref('top', 'whole'), ref('fillet', 'whole')] },
    { id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('bottom', 'start')] },
    { id: 'dw', kind: 'distance', role: 'driving', value: W, refs: [ref('bottom', 'whole')] },
    { id: 'dh', kind: 'distance', role: 'driving', value: H, refs: [ref('left', 'whole')] },
  ];
  if (driveRadius !== null) constraints.push({ id: 'dr', kind: 'radius', role: 'driving', value: driveRadius, refs: [ref('fillet', 'whole')] });
  return { entities, constraints: set(...constraints) };
}

// Drawn consistent with the driven W/H and the radius left free: the
// drawn state already satisfies every driving constraint, so the class
// is 'under'. (Its reported `remaining` is NOT asserted: it carries
// finding F-3034-2's tangent-rank excess — nominal 1, reported 3.)
add({ id: 'fillet-under-1', build: () => filletPlate(20, 12, 4.4, 20, 12, null), expect: 'under' });
// A fillet radius edit — the canonical fillet operation.
add({ id: 'fillet-full-1', build: () => filletPlate(20, 12, 4.4, 20, 12, 4), expect: 'fully', remaining: 0 });
// A plate resize with the radius free.
add({ id: 'fillet-under-2', build: () => filletPlate(28, 17, 6, 30, 18, null), expect: 'under', remaining: 1 });
// A plate resize plus radius edit.
add({
  id: 'fillet-full-2',
  build: () => filletPlate(28, 17, 5.2, 30, 18, 6),
  expect: 'fully',
  remaining: 0,
  check: (r) => {
    const out = byId(r.entities!);
    const f = out.get('fillet') as ArcEntity;
    expect(Math.abs(f.radius - 6)).toBeLessThanOrEqual(2e-5);
    expect(Math.abs(f.center.x - 24)).toBeLessThanOrEqual(2e-5);
    expect(Math.abs(f.center.y - 12)).toBeLessThanOrEqual(2e-5);
  },
});

// ---------------------------------------------------------------------------
// Family F — slot: 2 lines + 2 semicircular arcs. DOF 18; consumed:
// coincident 8 + tangent 4 + fixed 2 + centre distance 1 + radii 2 +
// top horizontal 1 = 18 ⇒ fully. Without the horizontal the whole slot
// can still rotate about the fixed centre ⇒ remaining 1.
// ---------------------------------------------------------------------------

/** Drawn exactly at (L0, R0); driven to (L, R). Joints exact. */
function slot(L0: number, R0: number, L: number, R: number, withHorizontal: boolean) {
  const entities = [
    line('top', 0, R0, L0, R0),
    line('bottom', L0, -R0, 0, -R0),
    arc('rightArc', L0, 0, R0, Math.PI / 2, -Math.PI / 2),
    arc('leftArc', 0, 0, R0, -Math.PI / 2, Math.PI / 2),
  ];
  const constraints: Constraint[] = [
    { id: 'j1', kind: 'coincident', role: 'driving', refs: [ref('top', 'end'), ref('rightArc', 'start')] },
    { id: 'j2', kind: 'coincident', role: 'driving', refs: [ref('rightArc', 'end'), ref('bottom', 'start')] },
    { id: 'j3', kind: 'coincident', role: 'driving', refs: [ref('bottom', 'end'), ref('leftArc', 'start')] },
    { id: 'j4', kind: 'coincident', role: 'driving', refs: [ref('leftArc', 'end'), ref('top', 'start')] },
    { id: 't1', kind: 'tangent', role: 'driving', refs: [ref('top', 'whole'), ref('rightArc', 'whole')] },
    { id: 't2', kind: 'tangent', role: 'driving', refs: [ref('bottom', 'whole'), ref('rightArc', 'whole')] },
    { id: 't3', kind: 'tangent', role: 'driving', refs: [ref('bottom', 'whole'), ref('leftArc', 'whole')] },
    { id: 't4', kind: 'tangent', role: 'driving', refs: [ref('top', 'whole'), ref('leftArc', 'whole')] },
    { id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('leftArc', 'center')] },
    { id: 'dc', kind: 'distance', role: 'driving', value: L, refs: [ref('leftArc', 'center'), ref('rightArc', 'center')] },
    { id: 'rl', kind: 'radius', role: 'driving', value: R, refs: [ref('leftArc', 'whole')] },
    { id: 'rr', kind: 'radius', role: 'driving', value: R, refs: [ref('rightArc', 'whole')] },
  ];
  if (withHorizontal) constraints.push({ id: 'ht', kind: 'horizontal', role: 'driving', refs: [ref('top', 'whole')] });
  return { entities, constraints: set(...constraints) };
}

add({ id: 'slot-full-1', build: () => slot(10, 5, 11, 5.5, true), expect: 'fully', remaining: 0 });
add({ id: 'slot-under-1', build: () => slot(10, 5, 11, 5.5, false), expect: 'under', remaining: 1 });
add({ id: 'slot-full-2', build: () => slot(24, 6, 22, 5.4, true), expect: 'fully', remaining: 0 });
add({ id: 'slot-under-2', build: () => slot(8, 3, 8.8, 3.3, false), expect: 'under', remaining: 1 });

// ---------------------------------------------------------------------------
// Family G — L-bracket outline, 6 lines in a coincident cycle. DOF 24;
// consumed: coincident 12 + H/V 6 + fixed 2 + three length distances 3
// = 23 ⇒ remaining 1 (the step height). Adding the step length ⇒ fully.
// ---------------------------------------------------------------------------

function bracket(W: number, H: number, T: number, S: number, driveStep: boolean) {
  const entities = [
    line('l1', 0, 0, W, 0.1),
    line('l2', W, 0.1, W - 0.12, S),
    line('l3', W - 0.12, S, T, S + 0.09),
    line('l4', T, S + 0.09, T + 0.11, H),
    line('l5', T + 0.11, H, 0, H - 0.08),
    line('l6', 0, H - 0.08, 0, 0),
  ];
  const constraints: Constraint[] = [
    { id: 'j1', kind: 'coincident', role: 'driving', refs: [ref('l1', 'end'), ref('l2', 'start')] },
    { id: 'j2', kind: 'coincident', role: 'driving', refs: [ref('l2', 'end'), ref('l3', 'start')] },
    { id: 'j3', kind: 'coincident', role: 'driving', refs: [ref('l3', 'end'), ref('l4', 'start')] },
    { id: 'j4', kind: 'coincident', role: 'driving', refs: [ref('l4', 'end'), ref('l5', 'start')] },
    { id: 'j5', kind: 'coincident', role: 'driving', refs: [ref('l5', 'end'), ref('l6', 'start')] },
    { id: 'j6', kind: 'coincident', role: 'driving', refs: [ref('l6', 'end'), ref('l1', 'start')] },
    { id: 'h1', kind: 'horizontal', role: 'driving', refs: [ref('l1', 'whole')] },
    { id: 'h3', kind: 'horizontal', role: 'driving', refs: [ref('l3', 'whole')] },
    { id: 'h5', kind: 'horizontal', role: 'driving', refs: [ref('l5', 'whole')] },
    { id: 'v2', kind: 'vertical', role: 'driving', refs: [ref('l2', 'whole')] },
    { id: 'v4', kind: 'vertical', role: 'driving', refs: [ref('l4', 'whole')] },
    { id: 'v6', kind: 'vertical', role: 'driving', refs: [ref('l6', 'whole')] },
    { id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('l1', 'start')] },
    { id: 'dw', kind: 'distance', role: 'driving', value: W, refs: [ref('l1', 'whole')] },
    { id: 'dh', kind: 'distance', role: 'driving', value: H, refs: [ref('l6', 'whole')] },
    { id: 'dt', kind: 'distance', role: 'driving', value: W - T, refs: [ref('l3', 'whole')] },
  ];
  if (driveStep) constraints.push({ id: 'ds', kind: 'distance', role: 'driving', value: S, refs: [ref('l2', 'whole')] });
  return { entities, constraints: set(...constraints) };
}

add({ id: 'bracket-under-1', build: () => bracket(20, 14, 8, 6, false), expect: 'under', remaining: 1 });
add({ id: 'bracket-full-1', build: () => bracket(20, 14, 8, 6, true), expect: 'fully', remaining: 0 });
add({ id: 'bracket-full-2', build: () => bracket(12, 9, 5, 4, true), expect: 'fully', remaining: 0 });

// ---------------------------------------------------------------------------
// Family H — conflicting schemes (the §5.6 evidence rule must fire).
// ---------------------------------------------------------------------------

function rectConflict(w: number) {
  const { entities, constraints } = rectFull(w, 5, 0, 0, 0);
  const extra: Constraint = { id: 'dx', kind: 'distance', role: 'driving', value: w + 4, refs: [ref('bottom', 'start'), ref('bottom', 'end')] };
  return { entities, constraints: set(...constraints.constraints, extra) };
}
add({ id: 'conflict-rect-1', build: () => rectConflict(10), expect: 'conflicting' });
add({ id: 'conflict-rect-2', build: () => rectConflict(24), expect: 'conflicting' });

/** The edit flow: geometry is a consistent 10/10/16 triangle
 *  (A(0,0), B(10,0), C(−2.8, 9.6) — a 2.8-9.6-10 right triangle); the
 *  BC distance is then driven to the impossible 30. */
function triangle(s: number) {
  const entities = [point('A', 0, 0), point('B', 10 * s, 0), point('C', -2.8 * s, 9.6 * s)];
  const constraints = set(
    { id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('A', 'position')] },
    { id: 'dab', kind: 'distance', role: 'driving', value: 10 * s, refs: [ref('A', 'position'), ref('B', 'position')] },
    { id: 'dac', kind: 'distance', role: 'driving', value: 10 * s, refs: [ref('A', 'position'), ref('C', 'position')] },
    { id: 'dbc', kind: 'distance', role: 'driving', value: 30 * s, refs: [ref('B', 'position'), ref('C', 'position')] },
  );
  return { entities, constraints };
}
add({ id: 'conflict-triangle-1', build: () => triangle(1), expect: 'conflicting' });
add({ id: 'conflict-triangle-2', build: () => triangle(2.5), expect: 'conflicting' });

function parallelPerp(dx: number, dy: number) {
  const entities = [line('A', 0, 0, 10, 0), line('B', 0, 5, dx, dy)];
  const constraints = set(
    { id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('A', 'start')] },
    { id: 'pa', kind: 'parallel', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
    { id: 'pe', kind: 'perpendicular', role: 'driving', refs: [ref('A', 'whole'), ref('B', 'whole')] },
  );
  return { entities, constraints };
}
add({ id: 'conflict-parperp-1', build: () => parallelPerp(10, 9), expect: 'conflicting' });
add({ id: 'conflict-parperp-2', build: () => parallelPerp(4, 12), expect: 'conflicting' });

add({
  id: 'conflict-bolt-span',
  build: () => {
    const { entities, constraints } = boltRow(3, 8, 3);
    const extra: Constraint = { id: 'span', kind: 'distance', role: 'driving', value: 20, refs: [ref('C0', 'center'), ref('C2', 'center')] };
    return { entities, constraints: set(...constraints.constraints, extra) };
  },
  expect: 'conflicting',
});

add({
  id: 'conflict-slot-separation',
  build: () => {
    const { entities, constraints } = slot(10, 5, 10, 5, true);
    // Tangency pins the centre-to-line distance at the radius (5); the
    // point–line distance demands 7.
    const extra: Constraint = { id: 'sep', kind: 'distance', role: 'driving', value: 7, refs: [ref('leftArc', 'center'), ref('top', 'whole')] };
    return { entities, constraints: set(...constraints.constraints, extra) };
  },
  expect: 'conflicting',
});

// ---------------------------------------------------------------------------
// Family I — expected-unsolved controls (excluded from the trigger
// denominator): degenerate band, over-cap input, pre-cancelled token.
// ---------------------------------------------------------------------------

add({
  id: 'unsolved-degenerate-band',
  build: () => ({
    entities: [line('L', 0, 0, 1, 0)],
    constraints: set({ id: 'd', kind: 'distance', role: 'driving', value: 5e-13, refs: [ref('L', 'whole')] }),
  }),
  expect: 'unsolved',
});
add({
  id: 'unsolved-over-cap',
  build: () => {
    const entities: Entity[] = [];
    const constraints: Constraint[] = [{ id: 'fix', kind: 'fixed', role: 'driving', refs: [ref('P0', 'position')] }];
    for (let i = 0; i < 258; i += 1) entities.push(point(`P${i}`, i * 0.5, i % 5));
    for (let i = 1; i < 258; i += 1) {
      constraints.push({ id: `c${i}`, kind: 'coincident', role: 'driving', refs: [ref(`P${i - 1}`, 'position'), ref(`P${i}`, 'position')] });
    }
    return { entities, constraints: set(...constraints) };
  },
  expect: 'unsolved',
});

// ---------------------------------------------------------------------------
// Runner: per-case class assertions + the §9.2 trigger metric.
// ---------------------------------------------------------------------------

function classOf(r: SolveResult): Class {
  if (r.ok) return r.status === 'fully-constrained' ? 'fully' : 'under';
  return r.status === 'conflicting' ? 'conflicting' : 'unsolved';
}

describe('realistic corpus (§9.2)', () => {
  for (const c of cases) {
    it(`${c.id} → ${c.expect}`, () => {
      const { entities, constraints } = c.build();
      const r = solveConstraints(entities, constraints);
      expect(classOf(r)).toBe(c.expect);
      if (c.expect === 'fully' || c.expect === 'under') {
        expect(r.ok).toBe(true);
        if (c.remaining !== undefined) expect(r.dof.remaining).toBe(c.remaining);
      } else {
        expect(r.ok).toBe(false);
        expect(r.entities).toBeUndefined();
      }
      c.check?.(r);
    });
  }

  it('the corpus itself meets the ≥50-case bar with every family represented', () => {
    expect(cases.length).toBeGreaterThanOrEqual(50);
    const families = new Set(cases.map((c) => c.id.split('-')[0]));
    expect([...families].sort()).toEqual(['bolt', 'bracket', 'conflict', 'fillet', 'rect', 'slot', 'unsolved']);
  });

  it('§9.2 trigger metric: ≤5% unsolved/wrong-conflict among solvable-or-conflicting cases', () => {
    const scored = cases.filter((c) => c.expect !== 'unsolved');
    const bad: string[] = [];
    for (const c of scored) {
      const { entities, constraints } = c.build();
      const got = classOf(solveConstraints(entities, constraints));
      const wrong =
        (c.expect === 'conflicting' && got !== 'conflicting') ||
        ((c.expect === 'fully' || c.expect === 'under') && (got === 'conflicting' || got === 'unsolved'));
      if (wrong) bad.push(`${c.id} (expected ${c.expect}, got ${got})`);
    }
    const metric = bad.length / scored.length;
    // The finding, if any, is in this message: case ids + exact metric.
    expect(bad, `trigger metric ${(metric * 100).toFixed(2)}% over ${scored.length} scored cases`).toEqual([]);
    expect(metric).toBeLessThanOrEqual(0.05);
  });
});

// ---------------------------------------------------------------------------
// FINDING F-3034 — measured behaviour of record (30.3.4). These tests pin
// what the engine DOES today on tangent systems, so the evidence lives
// in the suite next to the corpus it explains. They are not assertions
// of correct behaviour: a solver improvement should flip the corpus
// expectations above and update these pins in the same change.
//
// Root phenomenon (measured, probes in the 30.3.4 session): at an
// exactly-tangent configuration the tangent row is numerically
// near-dependent on the coincident rows of the shared endpoint. The
// resulting near-null direction (arc-centre motion along the tangent)
// (1) deflates the Jacobian rank by 1 per tangent constraint, and
// (2) makes the damped Gauss–Newton relaxation crawl whenever a solve
// must move an arc centre, reaching MAX_ITERATIONS "while still
// progressing" (§5.5's honest iteration-limit) instead of converging.
// ---------------------------------------------------------------------------

describe('finding F-3034 — tangent-system behaviour of record', () => {
  it('F-3034-1: a +2% slot length edit (arc centres must move) stalls to the iteration limit', () => {
    const { entities, constraints } = slot(10, 5, 10.2, 5, true);
    const r = solveConstraints(entities, constraints);
    expect(r.ok).toBe(false);
    expect(r.failure?.code).toBe('iteration-limit');
    expect(r.entities).toBeUndefined();
  });

  it('F-3034-1 control: the same slot with a radius-only edit (centres stay) solves even at +20%', () => {
    const { entities, constraints } = slot(10, 5, 10, 6, true);
    const r = solveConstraints(entities, constraints);
    expect(r.ok).toBe(true);
  });

  it('F-3034-1: a −1% fillet radius edit (centre must move) stalls likewise', () => {
    const { entities, constraints } = filletPlate(20, 12, 4.4, 20, 12, 4.35);
    const r = solveConstraints(entities, constraints);
    expect(r.ok).toBe(false);
    expect(r.failure?.code).toBe('iteration-limit');
  });

  it('F-3034-2: the status reporter overstates remaining by 1 per tangent at exact tangency', () => {
    const { entities, constraints } = filletPlate(20, 12, 4, 20, 12, 4);
    const a = analyzeConstraints(entities, constraints);
    expect(a.dof.total).toBe(21);
    // Nominal consumption is 21 (fully constrained). The Jacobian rank
    // at the exactly-tangent point reads 19 — one lost per tangent —
    // so a fully-constrained plate reports 'underconstrained'.
    expect(a.dof.effectiveConsumed).toBe(19);
    expect(a.dof.remaining).toBe(2);
    expect(a.status).toBe('underconstrained');
  });
});
