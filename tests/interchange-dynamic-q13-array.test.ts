/**
 * Q13 array-action fixture P30_LINEAR_ARRAY — SKELETON test file.
 *
 * Status: SKELETON. The HANDBUILT fixture does not exist yet; the lead seat builds it
 * headless (accoreconsole + injection, the N1 method) from the production-frozen recipe
 * (recipes-q12-q13/Q13-RECIPE-PROPOSAL.md, section 6 rulings recorded 2026-10-17: all
 * as recommended — C1 distance-driven count with candidate rules R-A..R-D, C5 parameter
 * name "Distance1", C6 four instances at insertions 0/240/480/700, C7 value list
 * {55, 60, 135} default 60, spacing 20, rows 1). This file binds the moment the fixture
 * package lands; until then it asserts NOTHING about any produced file and NOTHING
 * about JCad's reader.
 *
 * The fixture will be HANDBUILT, and the label is binding: its dynamic objects
 * (ACAD_EVALUATION_GRAPH with BLOCKLINEARPARAMETER "Distance1", BLOCKLINEARGRIP,
 * 2x BLOCKGRIPLOCATIONCOMPONENT, BLOCKARRAYACTION "Array1") are hand-written by
 * injection — layout copied from a shipped Autodesk sample if one carries a
 * BLOCKARRAYACTION (the lead has studied the "Stud - Metric" layout), otherwise
 * layout-derived and labeled as such in the provenance — never Block-Editor-authored.
 *
 * Part 1 (REAL, green now) verifies the recipe's PREDICTION MACHINERY only: the frozen
 * constants, the four candidate count rules of recipe section 3.3 as pure functions,
 * their predicted count vectors / hole centres / last offsets, and the rule-independent
 * geometry derived from them. It tests arithmetic against the reviewed recipe — never
 * JCad against itself (recipe J12's discipline, applied to the skeleton itself).
 *
 * Part 2 (PENDING) mirrors recipe section 3.5's J-assertion table exactly, as it.todo.
 * Each entry becomes a real test when the fixture lands, driven by the committed
 * oracle — never by this recipe. Binding requires, under
 * tests/fixtures/native-dynamic-q13-array/:
 *   p30-linear-array-HANDBUILT.dwg, p30-linear-array-HANDBUILT.dxf,
 *   oracle-measure.json (recipe section 3.2 shape, incl. per-instance arrayFeature
 *   {count, centersDef, lastOffset} and anonymousRecords), PROVENANCE-HANDBUILT.md.
 *
 * Scope: Q13 only. No claim about Q10, Q11 or Q12.
 */
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------- frozen recipe

const DEF_TOL = 1e-9; // definition-space / derived geometry, as in the accepted N1 test

const near = (a: number, b: number, tol: number) =>
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol);

const BLOCK_NAME = 'P30_LINEAR_ARRAY';
const PARAMETER_NAME = 'Distance1';
const ACTION_NAME = 'Array1';

/** Definition geometry (recipe section 1.1, authored in this order). */
const PLATE = {
  vertices: [
    [0, 0],
    [180, 0],
    [180, 60],
    [0, 60],
  ] as Array<[number, number]>,
  closed: true,
  width: 180,
  height: 60,
};
const HOLE = { center: [20, 30] as [number, number], radius: 5 }; // the arrayed feature; copy 0 is this circle
const CONTROL_LINE = { start: [150, 10] as [number, number], end: [170, 25] as [number, number] }; // never arrayed
const TAG1 = { tag: 'TAG1', position: [10, 45] as [number, number], height: 5, default: 'P-100' }; // never arrayed

/** Linear parameter + array action (recipe sections 1.2 / 1.3). */
const PARAMETER = {
  name: PARAMETER_NAME,
  base: [0, 30] as [number, number],
  endpoint: [60, 30] as [number, number],
  grips: 2,
  values: [55, 60, 135],
  defaultValue: 60,
};
const ARRAY_ACTION = {
  name: ACTION_NAME,
  spacing: 20,
  rows: 1,
  selection: 'hole', // exactly one entity: the hole CIRCLE — not the plate, control line or TAG1
};

interface Q13Instance {
  id: 'A' | 'B' | 'C' | 'D';
  insertion: [number, number];
  rotationDeg: number;
  value: number;
}
/** Recipe section 1.5: A default/exact-multiple witness, B larger value, C = B + rotation (sharing witness), D just below. */
const INSTANCES: Q13Instance[] = [
  { id: 'A', insertion: [0, 0], rotationDeg: 0, value: 60 },
  { id: 'B', insertion: [240, 0], rotationDeg: 0, value: 135 },
  { id: 'C', insertion: [480, 0], rotationDeg: 30, value: 135 },
  { id: 'D', insertion: [700, 0], rotationDeg: 0, value: 55 },
];
const instance = (id: Q13Instance['id']): Q13Instance => INSTANCES.find((i) => i.id === id)!;

// ------------------------------------------------------- candidate count rules

interface CountRule {
  id: 'R-A' | 'R-B' | 'R-C' | 'R-D';
  count: (v: number) => number;
}
const S = ARRAY_ACTION.spacing;
const roundHalfUp = (x: number): number => Math.floor(x + 0.5);

/** Recipe section 3.3's candidate set — pure functions of (value, spacing, default). */
const RULES: CountRule[] = [
  // R-A (PROPOSED — JCad's own rule): floor(v/S)+1, endpoint inclusive.
  { id: 'R-A', count: (v) => Math.floor(v / S) + 1 },
  // R-B (delta from default): floor((v-default)/S)+1.
  { id: 'R-B', count: (v) => Math.floor((v - PARAMETER.defaultValue) / S) + 1 },
  // R-C (round v/S, half up): round(v/S)+1.
  { id: 'R-C', count: (v) => roundHalfUp(v / S) + 1 },
  // R-D (endpoint exclusive): floor(v/S)+1, -1 at exact multiples of S.
  { id: 'R-D', count: (v) => Math.floor(v / S) + 1 - (v % S === 0 ? 1 : 0) },
];
const rule = (id: CountRule['id']): CountRule => RULES.find((r) => r.id === id)!;

/** Count vector over (A, B, C, D), in instance order. */
const countVector = (r: CountRule): number[] => INSTANCES.map((i) => r.count(i.value));

/** Predicted hole centres (definition space) for a rule at value v: copy k at (20 + k*S, 30). */
const centersX = (r: CountRule, v: number): number[] =>
  Array.from({ length: Math.max(0, r.count(v)) }, (_, k) => HOLE.center[0] + k * S);

/** Offset of the last copy from copy 0; null when the rule admits no copy at all. */
const lastOffset = (r: CountRule, v: number): number | null => {
  const n = r.count(v);
  return n > 0 ? (n - 1) * S : null;
};

// ------------------------------------------------------------- rotation helper

const rotate = (x: number, y: number, deg: number): [number, number] => {
  const rad = (deg * Math.PI) / 180;
  return [x * Math.cos(rad) - y * Math.sin(rad), x * Math.sin(rad) + y * Math.cos(rad)];
};
const worldPoint = (ins: Q13Instance, x: number, y: number): [number, number] => {
  const [rx, ry] = rotate(x, y, ins.rotationDeg);
  return [ins.insertion[0] + rx, ins.insertion[1] + ry];
};
const worldAabbOfPlate = (ins: Q13Instance): { min: [number, number]; max: [number, number] } => {
  const pts = PLATE.vertices.map(([x, y]) => worldPoint(ins, x, y));
  return {
    min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1]))],
    max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))],
  };
};

// =================================================================== Part 1

describe('Q13 skeleton - Part 1: frozen recipe constants', () => {
  it('block, parameter and action identities (recipe sections 1.0/1.2/1.3)', () => {
    expect(BLOCK_NAME).toBe('P30_LINEAR_ARRAY');
    expect(PARAMETER.name).toBe('Distance1');
    expect(ACTION_NAME).toBe('Array1');
    expect(PARAMETER.base).toEqual([0, 30]);
    expect(PARAMETER.endpoint).toEqual([60, 30]);
    expect(PARAMETER.grips).toBe(2);
    // The authored segment length equals the default: the authored geometry is the zero-delta state.
    expect(PARAMETER.endpoint[0] - PARAMETER.base[0]).toBe(PARAMETER.defaultValue);
    expect(ARRAY_ACTION.spacing).toBe(20);
    expect(ARRAY_ACTION.rows).toBe(1);
    expect(ARRAY_ACTION.selection).toBe('hole');
  });

  it('definition geometry is exactly the recipe section 1.1 table', () => {
    expect(PLATE.vertices).toEqual([
      [0, 0],
      [180, 0],
      [180, 60],
      [0, 60],
    ]);
    expect(PLATE.closed).toBe(true);
    expect(HOLE.center).toEqual([20, 30]);
    expect(HOLE.radius).toBe(5);
    expect(CONTROL_LINE.start).toEqual([150, 10]);
    expect(CONTROL_LINE.end).toEqual([170, 25]);
    expect(TAG1.tag).toBe('TAG1');
    expect(TAG1.position).toEqual([10, 45]);
    expect(TAG1.height).toBe(5);
    expect(TAG1.default).toBe('P-100');
  });

  it('value list {55, 60, 135}, default 60, spacing 20 - the measurement instruments (recipe D2/D3)', () => {
    expect(PARAMETER.values).toEqual([55, 60, 135]);
    expect(PARAMETER.defaultValue).toBe(60);
    // 60 is an exact multiple of the spacing: the default doubles as the endpoint witness.
    expect(PARAMETER.defaultValue).toBe(3 * S);
    expect(PARAMETER.defaultValue % S).toBe(0);
    // 55 sits just below that multiple; 135's quotient 6.75 separates floor from round.
    expect(55 % S).not.toBe(0);
    expect(55).toBeLessThan(PARAMETER.defaultValue);
    expect(135 / S).toBe(6.75);
  });

  it('instance table A/B/C/D: insertions 0/240/480/700, values 60/135/135/55, C rotated 30 (recipe section 1.5)', () => {
    expect(INSTANCES.map((i) => i.id)).toEqual(['A', 'B', 'C', 'D']);
    expect(INSTANCES.map((i) => i.insertion)).toEqual([
      [0, 0],
      [240, 0],
      [480, 0],
      [700, 0],
    ]);
    expect(INSTANCES.map((i) => i.value)).toEqual([60, 135, 135, 55]);
    expect(INSTANCES.map((i) => i.rotationDeg)).toEqual([0, 0, 30, 0]);
    // B and C carry the same value (the sharing witness premise, recipe E4); A is untouched default.
    expect(instance('B').value).toBe(instance('C').value);
    expect(instance('A').value).toBe(PARAMETER.defaultValue);
  });
});

describe('Q13 skeleton - Part 1: candidate count rules (recipe section 3.3)', () => {
  it('R-A floor(v/S)+1 predicts (A,B,C,D) = 4/7/7/3, endpoint inclusive at the exact multiple', () => {
    expect(countVector(rule('R-A'))).toEqual([4, 7, 7, 3]);
    // At A (v = 60, exact multiple) the last copy sits exactly at offset v.
    expect(lastOffset(rule('R-A'), instance('A').value)).toBe(instance('A').value);
  });

  it('R-B floor((v-default)/S)+1 predicts 1/4/4/0 - and its 0 at D is impossible for an evaluated instance', () => {
    expect(countVector(rule('R-B'))).toEqual([1, 4, 4, 0]);
    // Recipe section 3.3, R-B row: copy 0 always exists, so any measured count >= 1 at D
    // refutes R-B as well. The other three rules never predict fewer than 1 copy.
    for (const r of RULES.filter((x) => x.id !== 'R-B'))
      for (const i of INSTANCES) expect(r.count(i.value)).toBeGreaterThanOrEqual(1);
  });

  it('R-C round(v/S)+1 (half up) predicts 4/8/8/4', () => {
    expect(countVector(rule('R-C'))).toEqual([4, 8, 8, 4]);
  });

  it('R-D endpoint-exclusive predicts 3/7/7/3 - the exact multiple loses its endpoint copy', () => {
    expect(countVector(rule('R-D'))).toEqual([3, 7, 7, 3]);
    // At A the last offset falls one spacing short of v, unlike R-A.
    expect(lastOffset(rule('R-D'), instance('A').value)).toBe(instance('A').value - S);
  });

  it('discrimination: the four count vectors are pairwise distinct, over (A,B,C,D) and over (A,B,D)', () => {
    const vectors = RULES.map((r) => countVector(r));
    for (let a = 0; a < vectors.length; a++)
      for (let b = a + 1; b < vectors.length; b++) expect(vectors[a]).not.toEqual(vectors[b]);
    // J12 intersects on (A,B,D) — C shares B's value, so the projection must still discriminate.
    const abd = RULES.map((r) => [r.count(60), r.count(135), r.count(55)]);
    for (let a = 0; a < abd.length; a++)
      for (let b = a + 1; b < abd.length; b++) expect(abd[a]).not.toEqual(abd[b]);
    // R-A vs R-D differ ONLY at A: the default instance's count is load-bearing,
    // with the last offset as a second discriminator (60 vs 40 at A).
    const ra = countVector(rule('R-A'));
    const rd = countVector(rule('R-D'));
    expect(ra.map((n, k) => n - rd[k]!)).toEqual([1, 0, 0, 0]);
    expect(lastOffset(rule('R-A'), 60)).not.toBe(lastOffset(rule('R-D'), 60));
  });
});

describe('Q13 skeleton - Part 1: predicted hole centres and last offsets', () => {
  it('R-A centres and last offsets are exactly the recipe section 3.3 table', () => {
    const ra = rule('R-A');
    expect(centersX(ra, 60)).toEqual([20, 40, 60, 80]);
    expect(lastOffset(ra, 60)).toBe(60);
    expect(centersX(ra, 135)).toEqual([20, 40, 60, 80, 100, 120, 140]);
    expect(lastOffset(ra, 135)).toBe(120);
    expect(centersX(ra, 55)).toEqual([20, 40, 60]);
    expect(lastOffset(ra, 55)).toBe(40);
    // B and C share the value, so their definition-space centres are identical.
    expect(centersX(ra, instance('B').value)).toEqual(centersX(ra, instance('C').value));
  });

  it('R-B / R-C / R-D centres and last offsets for A, B, D follow their counts', () => {
    // R-B: A a single copy at the origin hole; B four copies; D none admitted.
    expect(centersX(rule('R-B'), 60)).toEqual([20]);
    expect(lastOffset(rule('R-B'), 60)).toBe(0);
    expect(centersX(rule('R-B'), 135)).toEqual([20, 40, 60, 80]);
    expect(lastOffset(rule('R-B'), 135)).toBe(60);
    expect(centersX(rule('R-B'), 55)).toEqual([]);
    expect(lastOffset(rule('R-B'), 55)).toBeNull();
    // R-C: B rounds up to 8 copies — the widest array of any candidate.
    expect(centersX(rule('R-C'), 60)).toEqual([20, 40, 60, 80]);
    expect(lastOffset(rule('R-C'), 60)).toBe(60);
    expect(centersX(rule('R-C'), 135)).toEqual([20, 40, 60, 80, 100, 120, 140, 160]);
    expect(lastOffset(rule('R-C'), 135)).toBe(140);
    expect(centersX(rule('R-C'), 55)).toEqual([20, 40, 60, 80]);
    expect(lastOffset(rule('R-C'), 55)).toBe(60);
    // R-D: only the exact multiple (A) changes vs R-A.
    expect(centersX(rule('R-D'), 60)).toEqual([20, 40, 60]);
    expect(lastOffset(rule('R-D'), 60)).toBe(40);
    expect(centersX(rule('R-D'), 135)).toEqual([20, 40, 60, 80, 100, 120, 140]);
    expect(lastOffset(rule('R-D'), 135)).toBe(120);
    expect(centersX(rule('R-D'), 55)).toEqual([20, 40, 60]);
    expect(lastOffset(rule('R-D'), 55)).toBe(40);
  });
});

describe('Q13 skeleton - Part 1: rule-independent geometry', () => {
  it('world AABBs from the plate: A/B/D by translation, C by rotation (recipe section 3.3)', () => {
    const a = worldAabbOfPlate(instance('A'));
    expect(a.min).toEqual([0, 0]);
    expect(a.max).toEqual([180, 60]);
    const b = worldAabbOfPlate(instance('B'));
    expect(b.min).toEqual([240, 0]);
    expect(b.max).toEqual([420, 60]);
    const d = worldAabbOfPlate(instance('D'));
    expect(d.min).toEqual([700, 0]);
    expect(d.max).toEqual([880, 60]);
    const c = worldAabbOfPlate(instance('C'));
    near(c.min[0], 450, DEF_TOL);
    near(c.min[1], 0, DEF_TOL);
    near(c.max[0], 635.884572681, DEF_TOL);
    near(c.max[1], 141.961524227, DEF_TOL);
    // The instances never collide: C's rotated plate ends before D begins.
    expect(c.max[0]).toBeLessThan(instance('D').insertion[0]);
  });

  it('TAG1 world positions: A (10,45), B (250,45), D (710,45), C by rotation', () => {
    for (const [id, x, y] of [
      ['A', 10, 45],
      ['B', 250, 45],
      ['D', 710, 45],
    ] as const) {
      const [wx, wy] = worldPoint(instance(id), TAG1.position[0], TAG1.position[1]);
      near(wx, x, DEF_TOL);
      near(wy, y, DEF_TOL);
    }
    const [cx, cy] = worldPoint(instance('C'), TAG1.position[0], TAG1.position[1]);
    near(cx, 466.160254038, DEF_TOL);
    near(cy, 43.97114317, DEF_TOL);
  });

  it("every rule's copies stay inside the plate and never overlap (worst case 160 + r5 = 165 < 180)", () => {
    let worst = 0;
    for (const r of RULES)
      for (const i of INSTANCES) {
        const cs = centersX(r, i.value);
        for (let k = 0; k < cs.length; k++) {
          const ck = cs[k]!;
          expect(ck - HOLE.radius).toBeGreaterThanOrEqual(0);
          expect(ck + HOLE.radius).toBeLessThan(PLATE.width);
          if (k > 0) expect(ck - cs[k - 1]!).toBe(S); // spacing 20 > 2r: copies never overlap
          worst = Math.max(worst, ck);
        }
        // The hole row stays inside the plate vertically under every rule.
        expect(HOLE.center[1] - HOLE.radius).toBeGreaterThanOrEqual(0);
        expect(HOLE.center[1] + HOLE.radius).toBeLessThanOrEqual(PLATE.height);
      }
    // The global worst case is R-C at v = 135: last centre 160, extent 165 < 180 —
    // which is why the plate corners bound every extents box regardless of the rule.
    expect(worst).toBe(160);
    expect(worst + HOLE.radius).toBe(165);
  });
});

// =================================================================== Part 2
// PENDING — binds when the HANDBUILT fixture package lands (see header). Each entry
// mirrors recipe section 3.5's J-table (number and assertion) and becomes a real test
// driven by the committed oracle-measure.json, never by the recipe.

describe('Q13 fixture binding - PENDING (recipe section 3.5)', () => {
  it.todo(
    'intake: fixture package committed under tests/fixtures/native-dynamic-q13-array/ ' +
      '(p30-linear-array-HANDBUILT.dwg/.dxf, oracle-measure.json, PROVENANCE-HANDBUILT.md); SHA-256s verified ' +
      'against the provenance; manifest parses in the recipe section 3.2 shape incl. arrayFeature ' +
      '{count, centersDef, lastOffset} and anonymousRecords',
  );
  it.todo(
    'J1 (REAL) graph retention end-to-end: after import + save + re-read, the graph records\u2019 group ' +
      'sequences \u2014 now including BLOCKARRAYACTION \u2014 are byte-identical to source',
  );
  it.todo(
    'J2 (INVENTORY) A resolves to the named definition; B/C/D to *U records; link-back XDATA ' +
      '(AcDbBlockRepBTag / AcDbDynamicBlockTrueName) is retained opaquely in the cad-graph but not resolved ' +
      'by any reader code',
  );
  it.todo(
    'J3 (INVENTORY) no Distance1 value recovery exists: no dynamic state on inserts/blocks; the value is ' +
      'embodied only in *U geometry; the Origin row is AutoCAD-derived \u2014 clean import, nothing fabricated, ' +
      'not an error',
  );
  it.todo(
    'J4 (REAL) evaluated geometry per instance matches the manifest (never this recipe): per-record hole ' +
      'centres/counts; plate single and unchanged; control line and TAG1 placement unchanged (definition ' +
      'space); world expansions match manifest extents/TAG1 positions',
  );
  it.todo(
    'J5 (REAL, from manifest) sharing exactly as the manifest records (E4/E5): B and C the same anonymous ' +
      'record if the manifest shows sharing; A named; D distinct',
  );
  it.todo(
    'J6 (INVENTORY) no native-instance edit path: the parameter API refuses these inserts ' +
      '(no-dynamic-definition, input-state identity), so it cannot write into a shared *U record',
  );
  it.todo('J7 (REAL) TAG1 value P-100 and placement survive import on all four instances');
  it.todo(
    'J8 (REAL) round trip: import -> save -> re-import yields identical geometry (J4 stable) and J1 holds; ' +
      'the recovered-values clause is vacuous per J3, noted as such',
  );
  it.todo(
    'J9 (REAL, per shape) DWG asserted separately, per platform shape: Linux WASM path \u2014 no graph in the ' +
      'model; Windows native path \u2014 schema-1 raw-preserved graph with BLOCKARRAYACTION among the ' +
      'raw-anchored nodes; geometry oracle-exact on both; losses as measured, never borrowed across paths',
  );
  it.todo('J10 (todo per recipe) R2000 save-down: not shipped with this fixture; nothing to assert against');
  it.todo(
    'J11 (REAL absence half / INVENTORY statement half) JCAD_DYNAMIC count is 0 in source, model and written ' +
      'output; the import report does not state values were unrecovered',
  );
  it.todo(
    'J12 (INVENTORY \u2014 identification, analysis not a JCad pass/fail) the manifest\u2019s measured per-instance ' +
      'count + last offset, tabulated against section 3.3\u2019s candidates, identifies the native rule: the ' +
      'measured (A,B,D) count vector matches EXACTLY ONE candidate vector and the test reports which \u2014 on ' +
      'AutoCAD\u2019s numbers, never JCad verified against itself',
  );
});
