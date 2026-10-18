/**
 * Q13 array-action fixture P30_LINEAR_ARRAY — native-fixture reader/oracle test.
 *
 * Status: BOUND. The HANDBUILT fixture landed 2026-10-18 (lead package
 * JCad-p30-Q13-array-handbuilt-oracle-v2.zip; intake SHA256SUMS 41/41 verified) and is
 * committed under tests/fixtures/native-dynamic-array-handbuilt/:
 *   p30-linear-array-HANDBUILT.dwg   sha256 75a8f4acf6160df6176c0171a6fc6963af6f1c3e711a96918c9ee863fa773d44
 *   p30-linear-array-HANDBUILT.dxf   sha256 e873d11a1f2a05bb0bdb3a646dbde58f516a3342912e842d7e4f401eea6049cf
 *   oracle-measure.json              sha256 ac03df5ab4ae092d6ce5128f8ae9f4f2f023fcb07e3597a4de3ebf91361c34b5
 *   PROVENANCE-Q13-HANDBUILT.md      sha256 690e13bf1e26d22a2e7a1dd36f25d33f97f0138a1e17afc13691e6fef7fc31af
 *   checks/check-C1.json             sha256 78d5ec8f609295192ffb4326d3d26d1dc362cac1ffcad7bdea527955c52c5af1
 * Built headless (accoreconsole + injection, the N1 method) from the production-frozen
 * recipe (recipes-q12-q13/Q13-RECIPE-PROPOSAL.md, section 6 rulings recorded 2026-10-17:
 * all as recommended — C1 distance-driven count with candidate rules R-A..R-D, C5
 * parameter name "Distance1", C6 four instances at insertions 0/240/480/700, C7 value
 * list {55, 60, 135} default 60, spacing 20, rows 1).
 *
 * The fixture is HANDBUILT, and the label is binding: its dynamic objects
 * (ACAD_EVALUATION_GRAPH with BLOCKLINEARPARAMETER "Distance1", BLOCKLINEARGRIP,
 * 2x BLOCKGRIPLOCATIONCOMPONENT, BLOCKARRAYACTION "Array1") are hand-written by
 * injection — layout COPIED from the shipped Autodesk sample block "Stud - Metric"
 * (lead decision C2, named in the provenance) — never Block-Editor-authored.
 *
 * MEASURED OUTCOME (AutoCAD 2027's own evaluation, recorded plainly — the expectations
 * below are encoded from the measurement, never bent toward a candidate): the hole
 * counts A/B/C/D are 1/6/6/2 at Distance1 60/135/135/55, which matches NONE of the
 * recipe's candidate rules R-A..R-D. Every EVALUATED state fits count = floor(v/20)
 * with copies at offsets 0, 20, ..., (count-1)*20 and NO copy at offset v — not even
 * at the exact multiple (the committed check-C1 evidence: B set to 60 through the API
 * evaluates to 3 holes on a new record *U5, last offset 40). Instance A, the untouched
 * default at v=60, is NOT an evaluated state: it sits on the named record and shows
 * only the single authored hole. The recipe premise "the authored geometry is the
 * zero-delta evaluated state" is therefore REFUTED for this array, and A is never fed
 * to the candidate table as an evaluated reading (J12 encodes exactly this).
 *
 * Part 1 (REAL) verifies the recipe's PREDICTION MACHINERY only: the frozen constants,
 * the four candidate count rules of recipe section 3.3 as pure functions, their
 * predicted count vectors / hole centres / last offsets, and the rule-independent
 * geometry derived from them. It tests arithmetic against the reviewed recipe — never
 * JCad against itself (recipe J12's discipline). It is unchanged from the skeleton.
 *
 * Part 2 (REAL, bound) mirrors recipe section 3.5's J-assertion table, driven by the
 * committed oracle-measure.json — never by the recipe. Honesty split, as in N1:
 * geometry, sharing, graph retention and round-trip are REAL; value recovery,
 * link-back resolution and the J12 rule identification are INVENTORY/analysis. Two
 * recorded cautions: the anonymous-record inventories of the shipped DWG and DXF
 * differ in AutoCAD's own read-backs (the DXF carries an unreferenced orphan *U3 the
 * reopened DWG lacks) — JCad's imports are asserted per path, never assumed identical;
 * and the DynamicBlockGUID changes per session (three distinct values are already on
 * record), so it is asserted as present, never pinned. J10 stays it.todo: no R2000
 * save-down ships with this fixture. The Windows branch of J9 is UNMEASURED for Q13 —
 * encoded by analogy to the accepted N1 J9 Shape B and verified only by the lead's
 * Windows rerun.
 *
 * Scope: Q13 only. No claim about Q10, Q11 or Q12.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readDxf, writeDxf } from '../src/io/dxf';
import { decodeDxfBytes } from '../src/io/encoding';
import { importReportOf } from '../src/io/import-report';
import type { DrawingState } from '../src/core/document';
import type { BlockDef, CircleEntity, InsertEntity, LineEntity, PolylineEntity, TextEntity } from '../src/core/entities';
import { entityBounds, explodeInsert } from '../src/core/entities';
import { unionBounds, type Bounds, type Point } from '../src/core/geometry';
import { setDynamicParameter } from '../src/core/parametric/apply';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
// @ts-expect-error plain JS reader shared with Electron/CLI, like tests/dwg-native-read.test.ts
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

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
// BOUND — recipe section 3.5's J-assertion table as real tests, driven by the
// committed oracle-measure.json (AutoCAD 2027's measurement), never by the recipe.
// REAL: J1, J4, J5, J7, J8, J9, J11 absence half. INVENTORY: J2, J3, J6, J11 statement
// half, J12 (identification analysis). J10 stays todo (no R2000 save-down shipped).

// ---------------------------------------------------------------- oracle

interface Q13OracleEntity {
  type: string;
  handle?: string;
  closed?: boolean;
  vertices?: number[][];
  center?: number[];
  radius?: number;
  start?: number[];
  end?: number[];
  tag?: string;
  position?: number[];
  height?: number;
  default?: string;
}
interface Q13ArrayFeature {
  count: number;
  centersDef: number[][];
  lastOffset: number;
}
interface Q13OracleInstance {
  instance: string;
  set?: string;
  blockName: string;
  insertion: number[];
  rotationDeg: number;
  properties: Array<{ name: string; value: unknown; readOnly: boolean; allowed?: number[] }>;
  extents: number[][];
  blockEntities: Q13OracleEntity[];
  attributes: Array<{ tag: string; text: string; position: number[] }>;
  arrayFeature: Q13ArrayFeature;
}
interface Q13AnonRecord {
  name: string;
  referencedByInstances: string[];
  holeCount: number;
  linkBack?: Array<[number, string]>;
}
interface Q13Oracle {
  definitionIsDynamic: boolean;
  definitionEntities: Q13OracleEntity[];
  instances: Q13OracleInstance[];
  anonymousRecords: Q13AnonRecord[];
  anonymousRecordsInDxfReadBack: Q13AnonRecord[];
  audit: { handbuiltInputOnOpen: number; beforeExport: number; afterReopenDwg: number; afterReopenDxf: number };
}
interface Q13CheckC1 {
  log: string[];
  after: { instances: Q13OracleInstance[]; anonymousRecords: Q13AnonRecord[] };
}

const fxDir = join(__dirname, 'fixtures', 'native-dynamic-array-handbuilt');
const q13Oracle = JSON.parse(readFileSync(join(fxDir, 'oracle-measure.json'), 'utf8')) as Q13Oracle;
const checkC1 = JSON.parse(readFileSync(join(fxDir, 'checks', 'check-C1.json'), 'utf8')) as Q13CheckC1;

const sha256Of = (name: string) => createHash('sha256').update(readFileSync(join(fxDir, name))).digest('hex');

const DXF_NAME = 'p30-linear-array-HANDBUILT.dxf';
const sourceText = decodeDxfBytes(readFileSync(join(fxDir, DXF_NAME))).text;
const imported = readDxf(sourceText);
const written = writeDxf(imported);
const roundTripped = readDxf(written);

// ---------------------------------------------------------------- helpers

const WORLD_TOL = 1e-6; // world-space (exploded) values, as in the accepted N1 test

const nearPt = (p: Point | undefined, x: number, y: number, tol: number) => {
  expect(p).toBeDefined();
  near(p!.x, x, tol);
  near(p!.y, y, tol);
};
const insertsOf = (s: DrawingState): InsertEntity[] => s.entities.filter((e): e is InsertEntity => e.type === 'insert');
const insertAt = (s: DrawingState, x: number, y: number): InsertEntity => {
  const ins = insertsOf(s).find((i) => i.position.x === x && i.position.y === y);
  expect(ins, `insert at ${x},${y}`).toBeDefined();
  return ins!;
};
const lookupOf = (s: DrawingState) => (n: string) => s.blocks[n];

function worldAabb(s: DrawingState, ins: InsertEntity): Bounds {
  const lookup = lookupOf(s);
  let bb: Bounds | null = null;
  for (const part of explodeInsert(ins, lookup)) bb = unionBounds(bb, entityBounds(part, lookup));
  expect(bb).not.toBeNull();
  return bb!;
}
function worldTag(s: DrawingState, ins: InsertEntity): TextEntity {
  const text = explodeInsert(ins, lookupOf(s)).find((e): e is TextEntity => e.type === 'text');
  expect(text).toBeDefined();
  return text!;
}
const countOccurrences = (text: string, marker: string) => text.split(marker).length - 1;

/** The group pairs of every object record of one kind in DXF text (as in the N1 test). */
function records(dxf: string, kind: string): Array<Array<[number, string]>> {
  const lines = dxf.split(/\r\n|\n/);
  const out: Array<Array<[number, string]>> = [];
  let cur: Array<[number, string]> | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i]!.trim(), 10);
    const value = lines[i + 1]!;
    if (code === 0) {
      cur = value === kind ? [] : null;
      if (cur) out.push(cur);
    } else cur?.push([code, value]);
  }
  return out;
}

const GRAPH_KINDS = ['ACAD_EVALUATION_GRAPH', 'BLOCKLINEARPARAMETER', 'BLOCKARRAYACTION', 'BLOCKLINEARGRIP', 'BLOCKGRIPLOCATIONCOMPONENT'] as const;

/** Hole centres of a record, sorted by x (definition space). */
function holeCentersOf(block: BlockDef): Array<[number, number]> {
  return block.entities
    .filter((e): e is CircleEntity => e.type === 'circle')
    .map((c) => [c.center.x, c.center.y] as [number, number])
    .sort((a, b) => a[0] - b[0]);
}

/** Radii of a record's circles, ordered by centre x. */
function holeRadiiOf(block: BlockDef): number[] {
  return block.entities
    .filter((e): e is CircleEntity => e.type === 'circle')
    .sort((a, b) => a.center.x - b.center.x)
    .map((c) => c.radius);
}

/**
 * Definition-space geometry of one record against one oracle entity list: plate
 * (points, and closed on the DXF expectations), every hole circle, the control line,
 * the ATTDEF. `dwg` drops the two facts the DWG path measurably loses (closed flag,
 * ATTDEF default) — those are asserted as losses in the J9 section, never borrowed.
 */
function expectRecordGeometry(block: BlockDef, oracleEntities: Q13OracleEntity[], dwg: boolean) {
  const plate = block.entities.find((e): e is PolylineEntity => e.type === 'polyline');
  const line = block.entities.find((e): e is LineEntity => e.type === 'line');
  const oPlate = oracleEntities.find((e) => e.type === 'LWPOLYLINE')!;
  const oLine = oracleEntities.find((e) => e.type === 'LINE')!;
  const oAtt = oracleEntities.find((e) => e.type === 'ATTDEF')!;
  const oCircles = oracleEntities.filter((e) => e.type === 'CIRCLE').sort((a, b) => a.center![0]! - b.center![0]!);
  expect(plate).toBeDefined();
  if (!dwg) expect(plate!.closed).toBe(oPlate.closed);
  expect(plate!.points).toHaveLength(oPlate.vertices!.length);
  plate!.points.forEach((p, i) => nearPt(p, oPlate.vertices![i]![0]!, oPlate.vertices![i]![1]!, DEF_TOL));
  expect(line).toBeDefined();
  nearPt(line!.a, oLine.start![0]!, oLine.start![1]!, DEF_TOL);
  nearPt(line!.b, oLine.end![0]!, oLine.end![1]!, DEF_TOL);
  const centers = holeCentersOf(block);
  const radii = holeRadiiOf(block);
  expect(centers).toHaveLength(oCircles.length);
  centers.forEach(([x, y], i) => {
    near(x, oCircles[i]!.center![0]!, DEF_TOL);
    near(y, oCircles[i]!.center![1]!, DEF_TOL);
    near(radii[i]!, oCircles[i]!.radius!, DEF_TOL);
  });
  expect(block.attributes).toHaveLength(1);
  const att = block.attributes[0]!;
  expect(att.tag).toBe(oAtt.tag);
  nearPt(att.position, oAtt.position![0]!, oAtt.position![1]!, DEF_TOL);
  near(att.height, oAtt.height!, DEF_TOL);
  if (!dwg) expect(att.default).toBe(oAtt.default);
}

/** World-space facts of one insert against its oracle instance; `blockName` is the JCad-side record key. */
function expectWorldFacts(s: DrawingState, o: Q13OracleInstance, blockName: string) {
  const ins = insertAt(s, o.insertion[0]!, o.insertion[1]!);
  expect(ins.block).toBe(blockName);
  near(ins.rotation, (o.rotationDeg * Math.PI) / 180, DEF_TOL);
  expect(ins.attributes).toEqual({ [o.attributes[0]!.tag]: o.attributes[0]!.text });
  const bb = worldAabb(s, ins);
  nearPt(bb.min, o.extents[0]![0]!, o.extents[0]![1]!, WORLD_TOL);
  nearPt(bb.max, o.extents[1]![0]!, o.extents[1]![1]!, WORLD_TOL);
  const tag = worldTag(s, ins);
  expect(tag.text).toBe(o.attributes[0]!.text);
  nearPt(tag.position, o.attributes[0]!.position[0]!, o.attributes[0]!.position[1]!, WORLD_TOL);
  return ins;
}

// ---------------------------------------------------------------- DXF

describe('p30-linear-array-HANDBUILT.dxf: array-action fixture, DXF import', () => {
  it('intake: the committed fixture files are byte-identical to the delivered HANDBUILT package; the manifest parses in the recipe section 3.2 shape', () => {
    // SHA-256s recorded at intake against the lead package's SHA256SUMS (41/41 OK);
    // the intake test pins them so any fixture drift fails here first.
    expect(sha256Of('p30-linear-array-HANDBUILT.dwg')).toBe('75a8f4acf6160df6176c0171a6fc6963af6f1c3e711a96918c9ee863fa773d44');
    expect(sha256Of(DXF_NAME)).toBe('e873d11a1f2a05bb0bdb3a646dbde58f516a3342912e842d7e4f401eea6049cf');
    expect(sha256Of('oracle-measure.json')).toBe('ac03df5ab4ae092d6ce5128f8ae9f4f2f023fcb07e3597a4de3ebf91361c34b5');
    expect(sha256Of(join('checks', 'check-C1.json'))).toBe('78d5ec8f609295192ffb4326d3d26d1dc362cac1ffcad7bdea527955c52c5af1');
    const provenance = readFileSync(join(fxDir, 'PROVENANCE-Q13-HANDBUILT.md'), 'utf8');
    expect(provenance).toContain('HANDBUILT');
    expect(provenance).toContain('Stud - Metric'); // the C2 donor, named in the provenance
    // Manifest shape (recipe section 3.2): dynamic definition, four instances each with
    // an arrayFeature, anonymous records, and a clean AUDIT at every recorded point.
    expect(q13Oracle.definitionIsDynamic).toBe(true);
    expect(q13Oracle.instances.map((i) => i.instance)).toEqual(['A', 'B', 'C', 'D']);
    for (const o of q13Oracle.instances) {
      expect(o.arrayFeature.count).toBeGreaterThanOrEqual(1);
      expect(o.arrayFeature.centersDef).toHaveLength(o.arrayFeature.count);
      expect(o.arrayFeature.lastOffset).toBe(
        o.arrayFeature.centersDef[o.arrayFeature.centersDef.length - 1]![0]! - o.arrayFeature.centersDef[0]![0]!,
      );
    }
    expect(q13Oracle.anonymousRecords.map((r) => r.name)).toEqual(['*U2', '*U4']);
    expect(q13Oracle.audit).toMatchObject({ handbuiltInputOnOpen: 0, beforeExport: 0, afterReopenDwg: 0, afterReopenDxf: 0 });
  });

  it('J1 (REAL) graph retention end-to-end: the graph — now including BLOCKARRAYACTION — survives import + write byte-identically', () => {
    const graph = imported.cadGraph;
    expect(graph).toBeDefined();
    expect(graph!.schema).toBe(1);
    expect(graph!.nodes.length).toBeGreaterThan(0); // node count deliberately not pinned (255 at bind time)
    const first = graph!.nodes[0]!;
    expect(first.anchor?.kind).toBe('raw');
    expect(first.type).toBe('HEADER');
    expect(first.groups[0]).toEqual([9, '$ACADVER']);
    expect(first.groups[1]).toEqual([1, 'AC1032']);
    // All five dynamic object types are among the raw-anchored nodes.
    const rawTypes = new Set(graph!.nodes.filter((n) => n.anchor?.kind === 'raw').map((n) => n.type));
    for (const kind of GRAPH_KINDS) expect(rawTypes.has(kind), kind).toBe(true);
    // The parameter node carries Distance1; the single array-action node is Array1,
    // its selection (group 330) is the hole CIRCLE's handle, and its donor-copied row
    // offset (140 = 50.8) and recipe column spacing (141 = 20) ride along as raw groups.
    const param = graph!.nodes.find((n) => n.type === 'BLOCKLINEARPARAMETER');
    expect(param!.groups).toContainEqual([300, 'Distance1']);
    const arrayNodes = graph!.nodes.filter((n) => n.type === 'BLOCKARRAYACTION');
    expect(arrayNodes).toHaveLength(1);
    const holeHandle = q13Oracle.definitionEntities.find((e) => e.type === 'CIRCLE')!.handle;
    expect(arrayNodes[0]!.groups).toContainEqual([300, 'Array1']);
    expect(arrayNodes[0]!.groups).toContainEqual([330, holeHandle]);
    expect(arrayNodes[0]!.groups).toContainEqual([140, '50.8']);
    expect(arrayNodes[0]!.groups).toContainEqual([141, '20.0']);
    // Marker counts are identical source vs written, and every graph object record's
    // group sequence is byte-identical after writeDxf.
    for (const marker of [...GRAPH_KINDS, 'Distance1', 'ACAD_ENHANCEDBLOCK']) {
      expect(countOccurrences(written, marker), marker).toBe(countOccurrences(sourceText, marker));
    }
    const expectedCounts: Record<(typeof GRAPH_KINDS)[number], number> = {
      ACAD_EVALUATION_GRAPH: 1, BLOCKLINEARPARAMETER: 1, BLOCKARRAYACTION: 1, BLOCKLINEARGRIP: 1, BLOCKGRIPLOCATIONCOMPONENT: 2,
    };
    for (const kind of GRAPH_KINDS) {
      const fromSource = records(sourceText, kind);
      expect(fromSource, kind).toHaveLength(expectedCounts[kind]);
      expect(records(written, kind), kind).toEqual(fromSource);
    }
  });

  it('J2 (INVENTORY) link-back XDATA is retained opaquely in the cad-graph but not resolved by any reader code', () => {
    const nodes = imported.cadGraph!.nodes;
    const recordOf = (name: string) => nodes.find((n) => n.type === 'BLOCK_RECORD' && n.anchor?.kind === 'table' && n.anchor.name === name);
    const named = recordOf(BLOCK_NAME);
    expect(named).toBeDefined();
    expect(named!.groups).toContainEqual([1001, 'AcDbDynamicBlockTrueName']);
    expect(named!.groups).toContainEqual([1000, BLOCK_NAME]);
    for (const anon of ['*U2', '*U3', '*U4']) {
      const rec = recordOf(anon);
      expect(rec, anon).toBeDefined();
      const at = rec!.groups.findIndex(([c, v]) => c === 1001 && v === 'AcDbBlockRepBTag');
      expect(at, `${anon} BTag`).toBeGreaterThanOrEqual(0);
      // The retained payload points back at the named record's handle — as raw XDATA only.
      expect(rec!.groups.slice(at).find(([c]) => c === 1005)?.[1]).toBe(named!.sourceHandle);
    }
    // The DynamicBlockGUID is retained on the named record — presence only, never a
    // value: AutoCAD replaces it per session (three distinct values already on record
    // across the build, check-C1 and this DXFOUT), so pinning one would be false.
    const guidAt = named!.groups.findIndex(([c, v]) => c === 1001 && v === 'AcDbDynamicBlockGUID');
    expect(guidAt).toBeGreaterThanOrEqual(0);
    expect(named!.groups[guidAt + 1]?.[0]).toBe(1000);
    expect(named!.groups[guidAt + 1]?.[1]).toMatch(/^\{[^}]+\}$/);
    // No resolved link: the anonymous inserts carry no reference to the named block anywhere.
    for (const ins of insertsOf(imported).filter((i) => i.block !== BLOCK_NAME)) {
      expect(ins.dynamic).toBeUndefined();
      expect(Object.values(ins)).not.toContain(BLOCK_NAME);
    }
  });

  it('J3 (INVENTORY) no Distance1 value recovery exists: no dynamic state; the Origin row is AutoCAD-derived, nothing fabricated', () => {
    for (const block of Object.values(imported.blocks)) {
      expect(block.dynamic).toBeUndefined();
      expect(block.dynamicRetained).toBeUndefined();
    }
    for (const ins of insertsOf(imported)) {
      expect(ins.dynamic).toBeUndefined();
      expect(ins.dynamicRetained).toBeUndefined();
    }
    // 'Distance1' and 'Origin' exist in the model ONLY inside the retained cadGraph records.
    const { cadGraph: _graph, ...model } = imported;
    expect(JSON.stringify(model)).not.toContain('Distance1');
    expect(JSON.stringify(model)).not.toContain('Origin');
    // Accounted for on the AutoCAD side, not an error: every instance exposes Distance1
    // with the recipe list, and the derived Origin row is the parameter base point.
    for (const o of q13Oracle.instances) {
      const dist = o.properties.find((p) => p.name === 'Distance1');
      expect(dist!.readOnly).toBe(false);
      expect(dist!.allowed).toEqual([55, 60, 135]);
      const origin = o.properties.find((p) => p.name === 'Origin');
      expect(origin).toBeDefined();
      expect(origin!.readOnly).toBe(true);
      expect(origin!.value).toMatchObject({ X: 0, Y: 30, Z: 0 });
    }
  });

  it('J4 (REAL) evaluated geometry per instance matches the manifest: per-record holes, plate, control line, TAG1, world facts', () => {
    expectRecordGeometry(imported.blocks[BLOCK_NAME]!, q13Oracle.definitionEntities, false);
    for (const o of q13Oracle.instances) {
      expectRecordGeometry(imported.blocks[o.blockName]!, o.blockEntities, false);
      expectWorldFacts(imported, o, o.blockName);
      // The manifest's arrayFeature is the record's measured hole pattern, exactly:
      // count, centres (definition space) and last offset all agree with the import.
      const centers = holeCentersOf(imported.blocks[o.blockName]!);
      expect(centers).toHaveLength(o.arrayFeature.count);
      centers.forEach(([x, y], i) => {
        near(x, o.arrayFeature.centersDef[i]![0]!, DEF_TOL);
        near(y, o.arrayFeature.centersDef[i]![1]!, DEF_TOL);
      });
      expect(centers[centers.length - 1]![0] - centers[0]![0]).toBe(o.arrayFeature.lastOffset);
    }
  });

  it('J5 (REAL) sharing exactly as the manifest records: A named, B/C one anonymous record, D distinct — plus the orphan as a per-path inventory fact', () => {
    expect(Object.keys(imported.blocks).sort()).toEqual(['*U2', '*U3', '*U4', 'P30_LINEAR_ARRAY']);
    const byId = (id: string) => q13Oracle.instances.find((i) => i.instance === id)!;
    expect(insertAt(imported, ...byId('A').insertion as [number, number]).block).toBe(BLOCK_NAME);
    expect(insertAt(imported, ...byId('B').insertion as [number, number]).block).toBe('*U2');
    expect(insertAt(imported, ...byId('C').insertion as [number, number]).block).toBe('*U2');
    expect(insertAt(imported, ...byId('D').insertion as [number, number]).block).toBe('*U4');
    expect(insertsOf(imported).filter((i) => i.block === '*U2')).toHaveLength(2);
    // The manifest's anonymous records (DWG read-back) and their referencing agree.
    expect(
      q13Oracle.anonymousRecords.map(({ name, referencedByInstances, holeCount }) => ({ name, referencedByInstances, holeCount })),
    ).toEqual([
      { name: '*U2', referencedByInstances: ['B', 'C'], holeCount: 6 },
      { name: '*U4', referencedByInstances: ['D'], holeCount: 2 },
    ]);
    // ORPHAN, per-path inventory fact (DXF path): AutoCAD's DXF read-back carries an
    // unreferenced *U3 (6 holes) that the reopened DWG's read-back lacks — a divergence
    // in AutoCAD's own outputs, disclosed in the lead addendum. On THIS JCad path the
    // record is present, carries the same 6-hole bake as *U2, and no insert references it.
    // (*U3 absence must never be asserted on either JCad path; the DWG import's ANON_U3
    // is asserted in the J9 section.)
    expect(q13Oracle.anonymousRecordsInDxfReadBack.map((r) => r.name)).toEqual(['*U2', '*U3', '*U4']);
    expect(q13Oracle.anonymousRecordsInDxfReadBack.find((r) => r.name === '*U3')).toMatchObject({ referencedByInstances: [], holeCount: 6 });
    expect(insertsOf(imported).some((i) => i.block === '*U3')).toBe(false);
    expect(holeCentersOf(imported.blocks['*U3']!)).toEqual(holeCentersOf(imported.blocks['*U2']!));
  });

  it('J6 (INVENTORY) no native-instance edit path: the parameter API refuses these inserts (no-dynamic-definition, input-state identity)', () => {
    for (const ins of insertsOf(imported)) {
      const result = setDynamicParameter(imported, ins.id, 'Distance1', 120);
      expect(result.problem).toBe('no-dynamic-definition');
      expect(result.state).toBe(imported);
    }
  });

  it('J7 (REAL) TAG1 value P-100 and placement survive import on all four instances', () => {
    for (const o of q13Oracle.instances) {
      const ins = insertAt(imported, o.insertion[0]!, o.insertion[1]!);
      expect(ins.attributes).toEqual({ TAG1: 'P-100' });
      const tag = worldTag(imported, ins);
      expect(tag.text).toBe('P-100');
      nearPt(tag.position, o.attributes[0]!.position[0]!, o.attributes[0]!.position[1]!, WORLD_TOL);
      // And the ATTDEF itself keeps its default and authored placement in every record.
      const att = imported.blocks[o.blockName]!.attributes[0]!;
      expect(att.default).toBe('P-100');
      nearPt(att.position, 10, 45, DEF_TOL);
    }
  });

  it('J8 (REAL) round trip: import -> save -> re-import yields identical geometry (J4 stable) and J1 holds', () => {
    expect(writeDxf(roundTripped)).toBe(written);
    expect(Object.keys(roundTripped.blocks).sort()).toEqual(Object.keys(imported.blocks).sort());
    for (const o of q13Oracle.instances) {
      expectRecordGeometry(roundTripped.blocks[o.blockName]!, o.blockEntities, false);
      expectWorldFacts(roundTripped, o, o.blockName);
    }
    // J1 holds on the re-read state: the graph is still there with all five dynamic types.
    const rtRawTypes = new Set(roundTripped.cadGraph!.nodes.filter((n) => n.anchor?.kind === 'raw').map((n) => n.type));
    for (const kind of GRAPH_KINDS) expect(rtRawTypes.has(kind), kind).toBe(true);
    // The recovered-values clause is vacuous per J3: there are no recovered values whose
    // stability could be checked; the retained graph bytes are the stability claim (J1).
  });

  it('J11 (absence half, REAL): no JCAD_DYNAMIC carrier exists in the source, the model, or the written output', () => {
    expect(countOccurrences(sourceText, 'JCAD_DYNAMIC')).toBe(0);
    expect(JSON.stringify(imported)).not.toContain('JCAD_DYNAMIC');
    expect(countOccurrences(written, 'JCAD_DYNAMIC')).toBe(0);
    const items = importReportOf(imported)?.items ?? [];
    expect(items.some((i) => i.type === 'JCAD_DYNAMIC')).toBe(false);
  });

  it('J11: the import report records the graph classes as kept — and (INVENTORY) never states values were unrecovered', () => {
    const items = importReportOf(imported)?.items ?? [];
    const expectedKept: Record<(typeof GRAPH_KINDS)[number], number> = {
      ACAD_EVALUATION_GRAPH: 1, BLOCKLINEARPARAMETER: 1, BLOCKARRAYACTION: 1, BLOCKLINEARGRIP: 1, BLOCKGRIPLOCATIONCOMPONENT: 2,
    };
    for (const kind of GRAPH_KINDS) {
      const kept = items.filter((i) => i.type === kind);
      expect(kept, kind).toHaveLength(expectedKept[kind]);
      for (const item of kept) {
        expect(item.action).toBe('kept');
        expect(item.reason).toContain('not simulated');
      }
    }
    // Statement half (unmet, recorded as inventory): no item says the parameter values
    // could not be recovered — the report is silent about the loss J3 documents.
    expect(items.some((i) => /unrecovered|not recovered|no parameter value/i.test(i.reason))).toBe(false);
  });
});

// ---------------------------------------------------------------- J12

describe('J12 identification (INVENTORY — analysis on AutoCAD\u2019s numbers, not a JCad pass/fail)', () => {
  it('measured counts (A,B,D) = (1,6,2) match NONE of R-A..R-D; every evaluated state fits count = floor(v/20) with no endpoint copy; the untouched default A is not an evaluated state — the recipe premise is REFUTED for this array', () => {
    const byId = (id: string) => q13Oracle.instances.find((i) => i.instance === id)!;
    const distOf = (o: Q13OracleInstance) => o.properties.find((p) => p.name === 'Distance1')!.value as number;
    // The measured vectors, from AutoCAD's manifest (arrayFeature per instance) — and
    // the JCad import independently shows the same per-record hole patterns (J4/J5).
    const measuredFull = q13Oracle.instances.map((o) => o.arrayFeature.count);
    const measuredABD = [byId('A'), byId('B'), byId('D')].map((o) => o.arrayFeature.count);
    const measuredOffsetsABD = [byId('A'), byId('B'), byId('D')].map((o) => o.arrayFeature.lastOffset);
    expect(measuredFull).toEqual([1, 6, 6, 2]);
    expect(measuredABD).toEqual([1, 6, 2]);
    expect(measuredOffsetsABD).toEqual([0, 100, 20]);
    // (a) NO candidate rule predicts the measurement, over (A,B,C,D) or over (A,B,D).
    for (const r of RULES) {
      expect(countVector(r), r.id).not.toEqual(measuredFull);
      expect([r.count(60), r.count(135), r.count(55)], r.id).not.toEqual(measuredABD);
    }
    // (b) Every EVALUATED state fits count = floor(v/S): B and C at v=135, D at v=55,
    // and check-C1's B re-set to v=60 through the API (which baked a new record *U5).
    // Copies sit at offsets 0, S, ..., (count-1)*S from copy 0, and there is NO copy
    // at offset v — not even at the exact multiple v=60, where C1's offsets are
    // [0, 20, 40], never [0, 20, 40, 60]. This is encoded as measured, not bent
    // toward any candidate: R-A/R-C/R-D all predicted an endpoint copy at v=60.
    const c1B = checkC1.after.instances.find((i) => i.instance === 'B')!;
    expect(checkC1.log).toEqual(['B Distance1 := 60 ok']);
    expect(distOf(c1B)).toBe(60);
    expect(c1B.blockName).toBe('*U5');
    expect(checkC1.after.anonymousRecords.find((r) => r.name === '*U5')).toMatchObject({ referencedByInstances: ['B'], holeCount: 3 });
    const evaluated: Array<{ v: number; feature: Q13ArrayFeature; where: string }> = [
      { v: distOf(byId('B')), feature: byId('B').arrayFeature, where: 'B (v=135)' },
      { v: distOf(byId('C')), feature: byId('C').arrayFeature, where: 'C (v=135)' },
      { v: distOf(byId('D')), feature: byId('D').arrayFeature, where: 'D (v=55)' },
      { v: distOf(c1B), feature: c1B.arrayFeature, where: 'check-C1 B:=60' },
    ];
    for (const { v, feature, where } of evaluated) {
      expect(feature.count, where).toBe(Math.floor(v / S));
      expect(feature.lastOffset, where).toBe((feature.count - 1) * S);
      expect(feature.lastOffset, where).toBeLessThan(v);
      expect(feature.centersDef.map(([x]) => x! - HOLE.center[0]), where).toEqual(
        Array.from({ length: feature.count }, (_, k) => k * S),
      );
      expect(feature.centersDef.some(([x]) => x! - HOLE.center[0] === v), where).toBe(false);
    }
    // (c) Instance A — the untouched default — is NOT an evaluated state. It never
    // left the named record and shows only the single authored hole (copy 0).
    const a = byId('A');
    expect(a.set).toBe('untouched');
    expect(distOf(a)).toBe(60);
    expect(a.blockName).toBe(BLOCK_NAME);
    expect(a.arrayFeature.count).toBe(1);
    expect(a.arrayFeature.centersDef).toEqual([[20, 30]]);
    expect(a.arrayFeature.lastOffset).toBe(0);
    // At the same value 60, an EVALUATED state reads floor(60/20) = 3 holes (C1's *U5,
    // above) — so A's 1 fits neither the evaluated rule nor any candidate read as an
    // evaluated default, and the recipe premise "authored geometry = the zero-delta
    // evaluated state" is REFUTED for this array. A is therefore never fed to the
    // candidate table as an evaluated reading. Note the refutation of the candidates
    // does not rest on A: at (B,D) alone every candidate already fails.
    expect(Math.floor(60 / S)).toBe(3);
    expect(a.arrayFeature.count).not.toBe(Math.floor(60 / S));
    const measuredBD = [byId('B').arrayFeature.count, byId('D').arrayFeature.count];
    for (const r of RULES) expect([r.count(135), r.count(55)], r.id).not.toEqual(measuredBD);
  });

  it.todo('J10 (todo per recipe) R2000 save-down: not shipped with this fixture; nothing to assert against');
});

// ---------------------------------------------------------------- DWG (J9)

describe('p30-linear-array-HANDBUILT.dwg: array-action fixture, DWG import (J9)', () => {
  let state: DrawingState;

  beforeAll(async () => {
    const { payload } = await readDwgPayload(readFileSync(join(fxDir, 'p30-linear-array-HANDBUILT.dwg')));
    state = convertDwg(payload as DwgImportPayload).state;
  }, 60_000);

  const anonOf = (name: string) => (name === BLOCK_NAME ? name : `ANON_${name.slice(1)}`);

  it('J9: imports through the native reader; inserts resolve to ANON names, never the DXF *U names', () => {
    expect(Object.keys(state.blocks).sort()).toEqual(['ANON_U2', 'ANON_U3', 'ANON_U4', 'P30_LINEAR_ARRAY']);
    expect(insertsOf(state).map((i) => i.block).sort()).toEqual(['ANON_U2', 'ANON_U2', 'ANON_U4', 'P30_LINEAR_ARRAY']);
  });

  it('J9/J4: geometry is oracle-exact on the DWG path too — per-record geometry and world facts', () => {
    expectRecordGeometry(state.blocks[BLOCK_NAME]!, q13Oracle.definitionEntities, true);
    const seen = new Set<string>();
    for (const o of q13Oracle.instances) {
      const key = anonOf(o.blockName);
      if (!seen.has(key)) {
        expectRecordGeometry(state.blocks[key]!, o.blockEntities, true);
        seen.add(key);
      }
      expectWorldFacts(state, o, key);
    }
    // The orphan's bake equals *U2's (asserted on its own record in the next test).
    const b = q13Oracle.instances.find((i) => i.instance === 'B')!;
    expectRecordGeometry(state.blocks['ANON_U3']!, b.blockEntities, true);
  });

  it('J5/J9: the orphan is a per-path inventory fact on BOTH JCad paths — ANON_U3 is present here, unreferenced, with the 6-hole bake', () => {
    // AutoCAD's own read-backs diverge (the reopened DWG lacks *U3; the DXF has it) —
    // that divergence is an AutoCAD read-back fact, NOT a JCad-import fact: JCad's DWG
    // import DOES carry the record, as ANON_U3. *U3 absence is asserted on neither path.
    expect(state.blocks['ANON_U3']).toBeDefined();
    expect(insertsOf(state).some((i) => i.block === 'ANON_U3')).toBe(false);
    expect(holeCentersOf(state.blocks['ANON_U3']!)).toEqual(holeCentersOf(state.blocks['ANON_U2']!));
    expect(holeCentersOf(state.blocks['ANON_U3']!)).toHaveLength(6);
  });

  it('J9 measured DWG loss (closed flag): the plate closed flag does not survive the DWG reader', () => {
    for (const block of Object.values(state.blocks)) {
      const plate = block.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
      expect(plate.closed).toBe(false);
    }
  });

  it('J9 measured DWG loss (ATTDEF default): the ATTDEF default "P-100" does not survive the DWG reader', () => {
    for (const block of Object.values(state.blocks)) {
      expect(block.attributes[0]!.default).toBe('');
    }
  });

  it('J9 measured DWG loss (object graph): absent on the Linux WASM fallback path, raw-preserved on the Windows native path', () => {
    // Platform split (accepted N1 J9 pattern): the reader attaches the checked native
    // metadata projection only on win32, so the two DWG paths retain different graph
    // shapes; each shape is asserted in full. The Windows shape for Q13 is UNMEASURED —
    // encoded by analogy to the accepted N1 correction-2 shape (schema 1, HEADER first,
    // the dynamic graph objects among the raw-anchored nodes, no omission item), with
    // BLOCKARRAYACTION in place of N1's BLOCKSTRETCHACTION — and is verified only by
    // the lead's Windows rerun.
    const graph = state.cadGraph;
    const items = importReportOf(state)?.items ?? [];
    const omission = items.some((i) => i.type === 'XDATA' && i.action === 'unsupported' && i.reason.includes('dynamic parameters'));
    if (graph === undefined) {
      // Shape A — Linux LibreDWG WASM fallback (this platform): no object graph is
      // retained at all, and the XDATA-omission item is the report trace of the loss.
      expect(graph).toBeUndefined();
      expect(omission).toBe(true);
    } else {
      // Shape B — Windows native path (BY ANALOGY, UNMEASURED for Q13): graph present,
      // schema 1, HEADER first ($ACADVER = AC1032), the five dynamic object types —
      // including BLOCKARRAYACTION — among the raw-anchored nodes; no omission item.
      expect(graph.schema).toBe(1);
      expect(graph.nodes.length).toBeGreaterThan(0);
      const first = graph.nodes[0]!;
      expect(first.anchor?.kind).toBe('raw');
      expect(first.type).toBe('HEADER');
      expect(first.groups[0]).toEqual([9, '$ACADVER']);
      expect(first.groups[1]).toEqual([1, 'AC1032']);
      const rawTypes = new Set(graph.nodes.filter((n) => n.anchor?.kind === 'raw').map((n) => n.type));
      for (const kind of GRAPH_KINDS) expect(rawTypes.has(kind), kind).toBe(true);
      expect(omission).toBe(false);
    }
  });

  it('J9 measured DWG invariant (dynamic state): the graph, absent or raw-preserved, is never decoded into dynamic state', () => {
    for (const block of Object.values(state.blocks)) {
      expect(block.dynamic).toBeUndefined();
      expect(block.dynamicRetained).toBeUndefined();
    }
    for (const ins of insertsOf(state)) {
      expect(ins.dynamic).toBeUndefined();
      expect(ins.dynamicRetained).toBeUndefined();
    }
    const { cadGraph: _graph, ...model } = state;
    expect(JSON.stringify(model)).not.toContain('Distance1');
  });
});
