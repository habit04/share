/**
 * Native dynamic-block fixture P30_LINEAR_STRETCH (tests/fixtures/native-dynamic-handbuilt/) —
 * HANDBUILT, and the label is binding: the plain block was authored in headless AutoCAD
 * (accoreconsole, R2018 DXFOUT -> base.dxf), but the dynamic objects (ACAD_EVALUATION_GRAPH with
 * BLOCKLINEARPARAMETER "Distance1" (0,30)->(100,30), list 80/100/120/140, BLOCKLINEARGRIP,
 * 2x BLOCKGRIPLOCATIONCOMPONENT, BLOCKSTRETCHACTION "Stretch1") were HAND-WRITTEN into the file
 * (see PROVENANCE-HANDBUILT.md in the fixture folder) because this PC has no Block Editor.
 * AutoCAD itself then accepted the file (AUDIT 0 errors, IsDynamicBlock = true), set Distance1
 * per instance through its DynamicBlockReferenceProperty API (A untouched = 100, B = 120,
 * C = 120 at 30 degrees) and recorded its own evaluation in oracle-measure.json, which is the
 * oracle every expected value below is driven from (structural facts — names, counts — are
 * hardcoded; geometry, extents and attribute positions are read out of the oracle).
 *
 * Q10 fixture (tests/fixtures/native-dynamic-handbuilt-r2000/) — HANDBUILT lineage, and the
 * label is binding there too: an AutoCAD 2027 SAVEAS 2000 + DXFOUT v2000 derivative of the
 * N1 DWG above (never Block-Editor-authored; see PROVENANCE-Q10-HANDBUILT.md in that
 * folder). AutoCAD reopened each R2000 file and measured it read-only; the three read-back
 * JSONs (read-source-current / read-R2000-dwg / read-R2000-dxf) are the Q10 oracle. They
 * report EFFECTIVE identity (the definition as P30_LINEAR_STRETCH for every insert), so
 * every JCad-side name fact in the J10 tests is asserted from the import, never from
 * those JSONs.
 *
 * Recipe r6 section 3.5 map — each J is marked REAL (the reader/writer behavior is exercised
 * and asserted) or INVENTORY (no such capability exists today; the test asserts the concrete
 * negative/structural fact instead of faking coverage):
 *   J1  REAL      — DXF retention: graph object records survive a write byte-identically.
 *   J2  INVENTORY — anonymous->named link-back XDATA is retained opaquely; nothing resolves it.
 *   J3  INVENTORY — no Distance1 value recovery exists in the reader; plate widths below are
 *                   GEOMETRY facts, not recovered parameter values. The oracle's read-only
 *                   derived "Origin" property (0,30) is likewise unmodeled, by design.
 *   J4  REAL      — definition + per-block geometry import (DXF).
 *   J6  INVENTORY — no native-instance edit path: the parameter API refuses these inserts.
 *   J7  REAL      — instance resolution, anonymous sharing (B and C share *U2), *U3 orphan.
 *   J8  REAL      — write -> read -> write byte-stability; re-read facts stable (its
 *                   recovered-values clause is vacuous per J3).
 *   J9  REAL      — DWG import through the native reader: same oracle geometry; the measured
 *                   DWG losses are asserted as facts, never borrowed from the DXF results.
 *                   The object-graph loss is platform-split (absent on the Linux WASM
 *                   fallback path; on the Windows native path the graph is present
 *                   with mixed anchor kinds and the dynamic graph objects retained
 *                   among the raw-anchored nodes — Windows review, 2026-10-17) and
 *                   is asserted per shape in its own test.
 *   J10 REAL      — Q10 R2000 save-down (the r2000 fixture dir above): AC1015 DXF parse,
 *                   graph retention and write byte-stability, oracle-exact geometry on both
 *                   the DXF and DWG paths, *U3 dropped by AutoCAD's save-down.
 *       INVENTORY — on the DXF path the true name is NOT resolved: the definition arrives
 *                   keyed *U1 and P30_LINEAR_STRETCH survives only as raw
 *                   AcDbDynamicBlockTrueName XDATA on *U1's record; no Distance1 value
 *                   recovery (as J3) — the values live only as baked plate widths.
 *   J11 REAL (absence half) — no JCAD_DYNAMIC carrier is invented for native data.
 *       INVENTORY (statement half) — the import report never states that parameter values
 *                   were unrecovered; asserted as a concrete absence, not papered over.
 * NOT covered by these fixtures at all: Block-Editor-authored byte layout, GUI/Properties
 * palette behavior (M0), Q11 third-party re-evaluation, Q12/Q13 (recipes proposed; no
 * Q12/Q13 fixture is built or shipped).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

// ---------------------------------------------------------------- oracle

interface OracleEntity {
  type: string;
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
interface OracleInstance {
  instance: string;
  blockName: string;
  insertion: number[];
  rotationDeg: number;
  properties: Array<{ name: string; value: unknown; readOnly: boolean }>;
  extents: number[][];
  blockEntities: OracleEntity[];
  attributes: Array<{ tag: string; text: string; position: number[] }>;
}
interface Oracle {
  definitionIsDynamic: boolean;
  definitionEntities: OracleEntity[];
  instances: OracleInstance[];
}

const dir = join(__dirname, 'fixtures', 'native-dynamic-handbuilt');
const oracle = JSON.parse(readFileSync(join(dir, 'oracle-measure.json'), 'utf8')) as Oracle;
const DXF_NAME = 'p30-linear-stretch-HANDBUILT.dxf';

const dxfText = (name: string) => decodeDxfBytes(readFileSync(join(dir, name))).text;
const sourceText = dxfText(DXF_NAME);
const imported = readDxf(sourceText);
const written = writeDxf(imported);
const roundTripped = readDxf(written);

// ---------------------------------------------------------------- helpers

const DEF_TOL = 1e-9; // definition-space geometry
const WORLD_TOL = 1e-6; // world-space (exploded) values

const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
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
const count = (text: string, marker: string) => text.split(marker).length - 1;

/** The group pairs of every object record of one kind in DXF text (as in interchange-fixtures). */
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

const GRAPH_KINDS = ['ACAD_EVALUATION_GRAPH', 'BLOCKLINEARPARAMETER', 'BLOCKSTRETCHACTION', 'BLOCKLINEARGRIP', 'BLOCKGRIPLOCATIONCOMPONENT'] as const;

/** Definition-space geometry of one block against one oracle entity list (J4). */
function expectBlockGeometry(block: BlockDef, oracleEntities: OracleEntity[]) {
  const plate = block.entities.find((e): e is PolylineEntity => e.type === 'polyline');
  const circle = block.entities.find((e): e is CircleEntity => e.type === 'circle');
  const line = block.entities.find((e): e is LineEntity => e.type === 'line');
  const oPlate = oracleEntities.find((e) => e.type === 'LWPOLYLINE')!;
  const oCircle = oracleEntities.find((e) => e.type === 'CIRCLE')!;
  const oLine = oracleEntities.find((e) => e.type === 'LINE')!;
  const oAtt = oracleEntities.find((e) => e.type === 'ATTDEF')!;
  expect(block.entities).toHaveLength(3);
  expect(plate).toBeDefined();
  expect(plate!.closed).toBe(true);
  expect(plate!.points).toHaveLength(oPlate.vertices!.length);
  plate!.points.forEach((p, i) => nearPt(p, oPlate.vertices![i]![0]!, oPlate.vertices![i]![1]!, DEF_TOL));
  expect(circle).toBeDefined();
  nearPt(circle!.center, oCircle.center![0]!, oCircle.center![1]!, DEF_TOL);
  near(circle!.radius, oCircle.radius!, DEF_TOL);
  expect(line).toBeDefined();
  nearPt(line!.a, oLine.start![0]!, oLine.start![1]!, DEF_TOL);
  nearPt(line!.b, oLine.end![0]!, oLine.end![1]!, DEF_TOL);
  expect(block.attributes).toHaveLength(1);
  const att = block.attributes[0]!;
  expect(att.tag).toBe(oAtt.tag);
  nearPt(att.position, oAtt.position![0]!, oAtt.position![1]!, DEF_TOL);
  near(att.height, oAtt.height!, DEF_TOL);
  expect(att.default).toBe(oAtt.default);
}

/** World-space facts of one insert against its oracle instance (J7 geometry half). */
function expectWorldFacts(s: DrawingState, o: OracleInstance) {
  const ins = insertAt(s, o.insertion[0]!, o.insertion[1]!);
  expect(ins.block).toBe(o.blockName);
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

describe('p30-linear-stretch-HANDBUILT.dxf: native dynamic definition, DXF import', () => {
  it('J4: the named definition imports with the oracle geometry; per-block geometry follows each anonymous record', () => {
    expect(oracle.definitionIsDynamic).toBe(true);
    expectBlockGeometry(imported.blocks['P30_LINEAR_STRETCH']!, oracle.definitionEntities);
    for (const o of oracle.instances) expectBlockGeometry(imported.blocks[o.blockName]!, o.blockEntities);
  });

  it('J4/J3: plate widths 100/120/120 are GEOMETRY facts of the baked records — no parameter value is recovered', () => {
    // GEOMETRY comment (binding): each block below is a separate baked record whose polyline
    // width is read off its vertices. Nothing in the reader turns the width back into a
    // Distance1 value; the next test (J3) asserts that no parameter value surfaces anywhere.
    const widthOf = (name: string) => {
      const plate = imported.blocks[name]!.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
      return Math.max(...plate.points.map((p) => p.x)) - Math.min(...plate.points.map((p) => p.x));
    };
    const expected = new Map<string, number>();
    for (const o of oracle.instances) {
      const plate = o.blockEntities.find((e) => e.type === 'LWPOLYLINE')!;
      expected.set(o.blockName, Math.max(...plate.vertices!.map((v) => v[0]!)) - Math.min(...plate.vertices!.map((v) => v[0]!)));
    }
    expect([...expected.values()]).toEqual([100, 120]); // oracle: A=100 (named), B/C=120 (*U2)
    for (const [name, w] of expected) near(widthOf(name), w, DEF_TOL);
    near(widthOf('*U3'), 120, DEF_TOL); // orphan record carries the same baked geometry
  });

  it('J3 INVENTORY: no dynamic state, definition or parameter value surfaces on any block or insert', () => {
    for (const block of Object.values(imported.blocks)) {
      expect(block.dynamic).toBeUndefined();
      expect(block.dynamicRetained).toBeUndefined();
    }
    for (const ins of insertsOf(imported)) {
      expect(ins.dynamic).toBeUndefined();
      expect(ins.dynamicRetained).toBeUndefined();
    }
    // 'Distance1' exists in the model ONLY inside the retained cadGraph object records.
    const { cadGraph: _graph, ...model } = imported;
    expect(JSON.stringify(model)).not.toContain('Distance1');
    expect(imported.cadGraph!.nodes.some((n) => n.type === 'BLOCKLINEARPARAMETER' && n.groups.some(([c, v]) => c === 300 && v === 'Distance1'))).toBe(true);
  });

  it('J3 INVENTORY: the oracle Origin property (0,30) is accounted for — import succeeds and the model fabricates no dynamic property for it', () => {
    const origins = oracle.instances.flatMap((o) => o.properties.filter((p) => p.name === 'Origin'));
    expect(origins).toHaveLength(3);
    for (const origin of origins) {
      expect(origin.readOnly).toBe(true);
      expect(origin.value).toMatchObject({ X: 0, Y: 30, Z: 0 }); // the parameter base point, per AutoCAD
    }
    // Accounted for, not an error: the import above completed, and 'Origin' appears nowhere
    // in the model outside the retained object graph.
    const { cadGraph: _graph, ...model } = imported;
    expect(JSON.stringify(model)).not.toContain('Origin');
  });

  it('J7: instances resolve to the named and shared anonymous records; *U3 is an unreferenced orphan', () => {
    expect(Object.keys(imported.blocks).sort()).toEqual(['*U2', '*U3', 'P30_LINEAR_STRETCH']);
    const [a, b, c] = oracle.instances;
    const insA = expectWorldFacts(imported, a!);
    const insB = expectWorldFacts(imported, b!);
    const insC = expectWorldFacts(imported, c!);
    expect(insA.block).toBe('P30_LINEAR_STRETCH');
    // Q7 observed natively and preserved here: equal values share ONE anonymous record.
    expect(insB.block).toBe('*U2');
    expect(insC.block).toBe('*U2');
    expect(insertsOf(imported).filter((i) => i.block === '*U2')).toHaveLength(2);
    expect(new Set(insertsOf(imported).map((i) => i.block)).size).toBe(2);
    // *U3 orphan inventory fact: defined, geometry identical to *U2, referenced by no insert.
    expect(insertsOf(imported).some((i) => i.block === '*U3')).toBe(false);
    const proj = (blk: BlockDef) => blk.entities.map((e) => (e.type === 'polyline' ? e.points : e.type === 'line' ? [e.a, e.b] : e.type === 'circle' ? [e.center, e.radius] : e.type));
    expect(proj(imported.blocks['*U3']!)).toEqual(proj(imported.blocks['*U2']!));
  });

  it('J1: the evaluation graph is retained — marker counts identical and every graph object record byte-identical after writeDxf', () => {
    for (const marker of [...GRAPH_KINDS, 'Distance1', 'ACAD_ENHANCEDBLOCK']) {
      expect(count(written, marker), marker).toBe(count(sourceText, marker));
    }
    const expectedCounts: Record<(typeof GRAPH_KINDS)[number], number> = {
      ACAD_EVALUATION_GRAPH: 1, BLOCKLINEARPARAMETER: 1, BLOCKSTRETCHACTION: 1, BLOCKLINEARGRIP: 1, BLOCKGRIPLOCATIONCOMPONENT: 2,
    };
    for (const kind of GRAPH_KINDS) {
      const fromSource = records(sourceText, kind);
      expect(fromSource, kind).toHaveLength(expectedCounts[kind]);
      expect(records(written, kind), kind).toEqual(fromSource);
    }
  });

  it('J8: write -> read -> write is byte-stable and the re-read facts are unchanged', () => {
    expect(writeDxf(roundTripped)).toBe(written);
    expect(Object.keys(roundTripped.blocks).sort()).toEqual(Object.keys(imported.blocks).sort());
    for (const o of oracle.instances) expectWorldFacts(roundTripped, o);
    // J8's recovered-values clause is vacuous per J3: there are no recovered values whose
    // stability could be checked; the retained graph bytes are the stability claim (J1).
  });

  it('J11 (absence half, REAL): no JCAD_DYNAMIC carrier exists in the source, the model, or the written output', () => {
    expect(count(sourceText, 'JCAD_DYNAMIC')).toBe(0);
    expect(JSON.stringify(imported)).not.toContain('JCAD_DYNAMIC');
    expect(count(written, 'JCAD_DYNAMIC')).toBe(0);
    const items = importReportOf(imported)?.items ?? [];
    expect(items.some((i) => i.type === 'JCAD_DYNAMIC')).toBe(false);
  });

  it('J11: the import report records the graph classes as kept — and (INVENTORY) never states values were unrecovered', () => {
    const items = importReportOf(imported)?.items ?? [];
    for (const kind of GRAPH_KINDS) {
      const kept = items.filter((i) => i.type === kind);
      expect(kept.length, kind).toBeGreaterThanOrEqual(1);
      for (const item of kept) {
        expect(item.action).toBe('kept');
        expect(item.reason).toContain('not simulated');
      }
    }
    expect(items.filter((i) => i.type === 'BLOCKGRIPLOCATIONCOMPONENT')).toHaveLength(2);
    // Statement half (unmet, recorded as inventory): no item says the parameter values
    // could not be recovered — the report is silent about the loss J3 documents.
    expect(items.some((i) => /unrecovered|not recovered|no parameter value/i.test(i.reason))).toBe(false);
  });

  it('J2 INVENTORY: link-back XDATA is retained opaquely on the anonymous BLOCK_RECORDs; no insert resolves it', () => {
    const nodes = imported.cadGraph!.nodes;
    const recordOf = (name: string) => nodes.find((n) => n.type === 'BLOCK_RECORD' && n.anchor?.kind === 'table' && n.anchor.name === name);
    const named = recordOf('P30_LINEAR_STRETCH');
    expect(named).toBeDefined();
    expect(named!.groups).toContainEqual([1001, 'AcDbDynamicBlockTrueName']);
    expect(named!.groups).toContainEqual([1000, 'P30_LINEAR_STRETCH']);
    for (const anon of ['*U2', '*U3']) {
      const rec = recordOf(anon);
      expect(rec, anon).toBeDefined();
      const at = rec!.groups.findIndex(([c, v]) => c === 1001 && v === 'AcDbBlockRepBTag');
      expect(at, `${anon} BTag`).toBeGreaterThanOrEqual(0);
      // The retained payload points back at the named record's handle — as raw XDATA only.
      expect(rec!.groups.slice(at).find(([c]) => c === 1005)?.[1]).toBe(named!.sourceHandle);
    }
    // No resolved link: the anonymous inserts carry no reference to the named block anywhere.
    for (const ins of insertsOf(imported).filter((i) => i.block !== 'P30_LINEAR_STRETCH')) {
      expect(ins.dynamic).toBeUndefined();
      expect(Object.values(ins)).not.toContain('P30_LINEAR_STRETCH');
    }
  });

  it('J6 INVENTORY: there is no native-instance edit path — the parameter API refuses these inserts atomically', () => {
    for (const ins of insertsOf(imported)) {
      const result = setDynamicParameter(imported, ins.id, 'Distance1', 120);
      expect(result.problem).toBe('no-dynamic-definition');
      expect(result.state).toBe(imported);
    }
  });

  it('aux: p30-handbuilt-def.dxf imports one block with the graph retained and zero inserts', () => {
    const text = dxfText('p30-handbuilt-def.dxf');
    const s = readDxf(text);
    expect(Object.keys(s.blocks)).toEqual(['P30_LINEAR_STRETCH']);
    expect(insertsOf(s)).toHaveLength(0);
    expectBlockGeometry(s.blocks['P30_LINEAR_STRETCH']!, oracle.definitionEntities);
    const out = writeDxf(s);
    expect(count(out, 'ACAD_EVALUATION_GRAPH')).toBe(count(text, 'ACAD_EVALUATION_GRAPH'));
    expect(count(out, 'ACAD_EVALUATION_GRAPH')).toBeGreaterThanOrEqual(1);
    for (const kind of GRAPH_KINDS) expect(records(out, kind)).toEqual(records(text, kind));
  });

  it('aux: base.dxf imports the same block with zero graph markers, before and after write', () => {
    const text = dxfText('base.dxf');
    const s = readDxf(text);
    expect(Object.keys(s.blocks)).toEqual(['P30_LINEAR_STRETCH']);
    expect(insertsOf(s)).toHaveLength(0);
    expectBlockGeometry(s.blocks['P30_LINEAR_STRETCH']!, oracle.definitionEntities);
    for (const marker of [...GRAPH_KINDS, 'Distance1', 'ACAD_ENHANCEDBLOCK']) {
      expect(count(text, marker), marker).toBe(0);
      expect(count(writeDxf(s), marker), marker).toBe(0);
    }
  });

});

// ---------------------------------------------------------------- DWG (J9)

describe('p30-linear-stretch-HANDBUILT.dwg: native DWG import (J9)', () => {
  let state: DrawingState;

  beforeAll(async () => {
    const { payload } = await readDwgPayload(readFileSync(join(dir, 'p30-linear-stretch-HANDBUILT.dwg')));
    state = convertDwg(payload as DwgImportPayload).state;
  }, 60_000);

  it('imports through the native reader; inserts resolve to ANON names, never the DXF *U names', () => {
    expect(Object.keys(state.blocks).sort()).toEqual(['ANON_U2', 'ANON_U3', 'P30_LINEAR_STRETCH']);
    expect(insertsOf(state).map((i) => i.block).sort()).toEqual(['ANON_U2', 'ANON_U2', 'P30_LINEAR_STRETCH']);
  });

  it('geometry is oracle-exact: definition-space blocks and world expansion match the AutoCAD evaluation', () => {
    expectBlockGeometryDwg(state.blocks['P30_LINEAR_STRETCH']!, oracle.instances[0]!.blockEntities);
    expectBlockGeometryDwg(state.blocks['ANON_U2']!, oracle.instances[1]!.blockEntities);
    expectBlockGeometryDwg(state.blocks['ANON_U3']!, oracle.instances[1]!.blockEntities); // orphan = same baked geometry
    for (const o of oracle.instances) {
      const ins = insertAt(state, o.insertion[0]!, o.insertion[1]!);
      expect(ins.block).toBe(o.blockName === '*U2' ? 'ANON_U2' : o.blockName);
      near(ins.rotation, (o.rotationDeg * Math.PI) / 180, DEF_TOL);
      // The ATTRIB value survives the DWG path even though the ATTDEF default does not (below).
      expect(ins.attributes).toEqual({ TAG1: 'P-100' });
      const bb = worldAabb(state, ins);
      nearPt(bb.min, o.extents[0]![0]!, o.extents[0]![1]!, WORLD_TOL);
      nearPt(bb.max, o.extents[1]![0]!, o.extents[1]![1]!, WORLD_TOL);
      const tag = worldTag(state, ins);
      expect(tag.text).toBe('P-100');
      nearPt(tag.position, o.attributes[0]!.position[0]!, o.attributes[0]!.position[1]!, WORLD_TOL);
    }
  });

  it('measured DWG loss (closed flag): the plate closed flag does not survive the DWG reader', () => {
    for (const block of Object.values(state.blocks)) {
      const plate = block.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
      expect(plate.closed).toBe(false);
    }
  });

  it('measured DWG loss (ATTDEF default): the ATTDEF default "P-100" does not survive the DWG reader', () => {
    for (const block of Object.values(state.blocks)) {
      expect(block.attributes[0]!.default).toBe('');
    }
  });

  it('measured DWG loss (object graph): absent on the Linux WASM fallback path, raw-preserved on the Windows native path', () => {
    // Platform split (Windows review, 2026-10-17): scripts/dwg-reader.mjs attaches the
    // checked native metadata projection only on win32, so the two DWG paths retain
    // different graph shapes. Each shape is asserted in full below; the earlier bundled
    // version of this test hard-coded the Linux shape and failed on Windows.
    const graph = state.cadGraph;
    const items = importReportOf(state)?.items ?? [];
    const omission = items.some((i) => i.type === 'XDATA' && i.action === 'unsupported' && i.reason.includes('dynamic parameters'));
    if (graph === undefined) {
      // Shape A — Linux LibreDWG WASM fallback (this platform): no object graph is
      // retained at all, and the one report trace of the loss is the generic
      // XDATA-omission item, which convertDwg emits only on the fallback path
      // (src/io/dwg.ts, under !nativeProjected).
      expect(graph).toBeUndefined();
      expect(omission).toBe(true);
    } else {
      // Shape B — Windows native path (measured by the reviewer's probe on this
      // fixture, Windows re-review of 2026-10-17; verified only by their rerun): the
      // graph is present, schema 1, beginning with the HEADER record
      // ($ACADVER = AC1032). Anchor kinds are MIXED — they vary by record nature
      // (raw / entity / dictionary / table / layout); 'raw' is not universal. The
      // key retained fact: the dynamic graph objects are among the raw-anchored
      // nodes, so on this path they are retained raw, not lost — the 'no graph'
      // loss asserted for Shape A is Linux-only. Exact node counts are
      // deliberately not pinned. The fallback's XDATA-omission item is not emitted
      // on this path: the metadata was retained, not omitted.
      expect(graph.schema).toBe(1);
      expect(graph.nodes.length).toBeGreaterThan(0);
      const first = graph.nodes[0]!;
      expect(first.anchor?.kind).toBe('raw');
      expect(first.type).toBe('HEADER');
      expect(first.groups[0]).toEqual([9, '$ACADVER']);
      expect(first.groups[1]).toEqual([1, 'AC1032']);
      const rawTypes = new Set(
        graph.nodes.filter((n) => n.anchor?.kind === 'raw').map((n) => n.type),
      );
      for (const type of [
        'ACAD_EVALUATION_GRAPH',
        'BLOCKLINEARPARAMETER',
        'BLOCKLINEARGRIP',
        'BLOCKGRIPLOCATIONCOMPONENT',
        'BLOCKSTRETCHACTION',
      ]) {
        expect(rawTypes.has(type)).toBe(true);
      }
      expect(omission).toBe(false);
    }
  });

  it('measured DWG invariant (dynamic state): the graph, absent or raw-preserved, is never decoded into dynamic state', () => {
    // Universal on both platform shapes: raw retention is not decoding — no block or
    // insert carries dynamic state, and no Distance1 value surfaces outside the
    // retained raw graph itself.
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

// ---------------------------------------------------------------- Q10 oracle

interface PluginEntity {
  type: string;
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
interface PluginInstance {
  blockName: string;
  effectiveName: string;
  isDynamicBlock: boolean;
  insertion: number[];
  rotationDeg: number;
  properties: Array<{ name: string; value: unknown; allowed: unknown[] }>;
  extents: number[][];
  attributes: Array<{ tag: string; text: string; position: number[] }>;
}
interface PluginRead {
  blocks: Array<{ name: string; isAnonymous: boolean; isDynamic: boolean; entities: PluginEntity[] }>;
  instances: PluginInstance[];
}

const q10Dir = join(__dirname, 'fixtures', 'native-dynamic-handbuilt-r2000');
const q10RawSource = JSON.parse(readFileSync(join(q10Dir, 'read-source-current.json'), 'utf8')) as Record<string, unknown>;
const q10RawDwg = JSON.parse(readFileSync(join(q10Dir, 'read-R2000-dwg.json'), 'utf8')) as Record<string, unknown>;
const q10RawDxf = JSON.parse(readFileSync(join(q10Dir, 'read-R2000-dxf.json'), 'utf8')) as Record<string, unknown>;
const q10Read = q10RawDxf as unknown as PluginRead;

// The plugin read-backs report effective identity: the definition record is named
// P30_LINEAR_STRETCH and B/C's record *U2. JCad's R2000 DXF import keys the definition
// record *U1 instead (asserted below, from the import). The adaptation maps records to
// JCad keys POSITIONALLY/BY GEOMETRY — the *U1 candidate is the record whose geometry
// equals the read-back definition geometry — never by trusting the plugin's names.
const q10DefEntities = q10Read.blocks.find((b) => b.name === 'P30_LINEAR_STRETCH')!.entities as OracleEntity[];
const q10BakeEntities = q10Read.blocks.find((b) => b.name === '*U2')!.entities as OracleEntity[];
const q10KeyOf = (pluginName: string) => (pluginName === 'P30_LINEAR_STRETCH' ? '*U1' : '*U2');
const q10Instances: OracleInstance[] = q10Read.instances.map((inst, i) => ({
  instance: 'ABC'[i]!,
  blockName: q10KeyOf(inst.blockName),
  insertion: inst.insertion,
  rotationDeg: inst.rotationDeg,
  properties: inst.properties.map((p) => ({ name: p.name, value: p.value, readOnly: p.name === 'Origin' })),
  extents: inst.extents,
  blockEntities: inst.blockName === 'P30_LINEAR_STRETCH' ? q10DefEntities : q10BakeEntities,
  attributes: inst.attributes,
}));

const q10DxfText = (name: string) => decodeDxfBytes(readFileSync(join(q10Dir, name))).text;
const q10Source = q10DxfText('p30-linear-stretch-HANDBUILT-R2000.dxf');
const q10Imported = readDxf(q10Source);
const q10Written = writeDxf(q10Imported);
const q10RoundTripped = readDxf(q10Written);

/** The $ACADVER value of a DXF text, read as a group pair (9 = name, 1 = value). */
function acadverOf(dxf: string): string | undefined {
  const lines = dxf.split(/\r\n|\n/);
  for (let i = 0; i + 3 < lines.length; i += 2) {
    if (lines[i]!.trim() === '9' && lines[i + 1]!.trim() === '$ACADVER') return lines[i + 3]!.trim();
  }
  return undefined;
}

// ---------------------------------------------------------------- Q10 DXF

describe('Q10 p30-linear-stretch-HANDBUILT-R2000.dxf: R2000 save-down, DXF import (J10)', () => {
  it('J10 META: the three AutoCAD read-backs agree in every measured field — the Q10 oracle identity holds', () => {
    // Only the header fields that necessarily differ are removed: `file` (three
    // different paths) and `drawingVersion` (AC1032 source vs AC1015 save-downs).
    // Everything AutoCAD measured — blocks, instances, properties, extents — must be
    // identical across the source read and both R2000 read-backs (PROVENANCE-Q10).
    const strip = (j: Record<string, unknown>) => {
      const { file: _file, drawingVersion: _version, ...rest } = j;
      return rest;
    };
    expect(q10RawSource['drawingVersion']).toBe('AC1032');
    expect(q10RawDwg['drawingVersion']).toBe('AC1015');
    expect(q10RawDxf['drawingVersion']).toBe('AC1015');
    expect(strip(q10RawDwg)).toEqual(strip(q10RawSource));
    expect(strip(q10RawDxf)).toEqual(strip(q10RawSource));
  });

  it('J10: the AC1015 DXF parses cleanly; block keys are exactly {*U1, *U2} and the inserts reference *U1/*U2/*U2', () => {
    expect(acadverOf(q10Source)).toBe('AC1015');
    expect(Object.keys(q10Imported.blocks).sort()).toEqual(['*U1', '*U2']);
    expect(insertsOf(q10Imported).map((i) => i.block).sort()).toEqual(['*U1', '*U2', '*U2']);
    expect(insertsOf(q10Imported).filter((i) => i.block === '*U2')).toHaveLength(2);
  });

  it('J10: *U1 carries the oracle definition geometry and *U2 the 120 bake — mapped by geometry, not by name', () => {
    // AutoCAD's read-back names the definition P30_LINEAR_STRETCH; JCad keys it *U1.
    // The identification is earned here: *U1's imported geometry equals the read-back
    // DEFINITION geometry (100-wide plate), and *U2's equals the read-back 120 bake.
    expectBlockGeometry(q10Imported.blocks['*U1']!, q10DefEntities);
    expectBlockGeometry(q10Imported.blocks['*U2']!, q10BakeEntities);
  });

  it('J10: world facts are oracle-exact — AABBs, TAG1 positions, rotation, shared *U2', () => {
    for (const o of q10Instances) expectWorldFacts(q10Imported, o);
    const [a, b, c] = q10Instances;
    expect(insertAt(q10Imported, a!.insertion[0]!, a!.insertion[1]!).block).toBe('*U1');
    expect(insertAt(q10Imported, b!.insertion[0]!, b!.insertion[1]!).block).toBe('*U2');
    expect(insertAt(q10Imported, c!.insertion[0]!, c!.insertion[1]!).block).toBe('*U2');
  });

  it('J10: graph retention — schema 1, the five dynamic types among raw-anchored nodes, the parameter node carries Distance1', () => {
    const graph = q10Imported.cadGraph;
    expect(graph).toBeDefined();
    expect(graph!.schema).toBe(1);
    const first = graph!.nodes[0]!;
    expect(first.anchor?.kind).toBe('raw');
    expect(first.type).toBe('HEADER');
    expect(first.groups[0]).toEqual([9, '$ACADVER']);
    expect(first.groups[1]).toEqual([1, 'AC1015']);
    const rawTypes = new Set(graph!.nodes.filter((n) => n.anchor?.kind === 'raw').map((n) => n.type));
    for (const kind of GRAPH_KINDS) expect(rawTypes.has(kind), kind).toBe(true);
    // The parameter's NAME survives only inside the retained graph records (see the
    // no-recovery inventory test below) — retention, not decoding.
    expect(graph!.nodes.some((n) => n.type === 'BLOCKLINEARPARAMETER' && n.groups.some(([c, v]) => c === 300 && v === 'Distance1'))).toBe(true);
    // Node counts are deliberately not pinned (293 on this path vs 228 in N1's R2018 DXF).
  });

  it('J10: graph records are byte-identical after writeDxf, write -> read -> write is byte-stable, and the written $ACADVER stays AC1015', () => {
    for (const marker of [...GRAPH_KINDS, 'Distance1', 'ACAD_ENHANCEDBLOCK']) {
      expect(count(q10Written, marker), marker).toBe(count(q10Source, marker));
    }
    const expectedCounts: Record<(typeof GRAPH_KINDS)[number], number> = {
      ACAD_EVALUATION_GRAPH: 1, BLOCKLINEARPARAMETER: 1, BLOCKSTRETCHACTION: 1, BLOCKLINEARGRIP: 1, BLOCKGRIPLOCATIONCOMPONENT: 2,
    };
    for (const kind of GRAPH_KINDS) {
      const fromSource = records(q10Source, kind);
      expect(fromSource, kind).toHaveLength(expectedCounts[kind]);
      expect(records(q10Written, kind), kind).toEqual(fromSource);
    }
    expect(writeDxf(q10RoundTripped)).toBe(q10Written);
    expect(Object.keys(q10RoundTripped.blocks).sort()).toEqual(['*U1', '*U2']);
    for (const o of q10Instances) expectWorldFacts(q10RoundTripped, o);
    expect(acadverOf(q10Written)).toBe('AC1015');
  });

  it('J10: *U3 is ABSENT — AutoCAD save-down dropped the unreferenced orphan on this path', () => {
    // Contrast with N1, where *U3 is an inventory fact of both paths (J7 / J9): the
    // R2000 files contain no *U3 block key and no graph record for it.
    expect(q10Imported.blocks['*U3']).toBeUndefined();
    expect(insertsOf(q10Imported).some((i) => i.block === '*U3')).toBe(false);
    expect(q10Imported.cadGraph!.nodes.some((n) => n.anchor?.kind === 'table' && n.anchor.name === '*U3')).toBe(false);
    expect(JSON.stringify(q10Imported.cadGraph)).not.toContain('*U3');
    expect(q10RoundTripped.blocks['*U3']).toBeUndefined();
  });

  it('J10: the import report records the graph classes as kept, behavior not simulated', () => {
    const items = importReportOf(q10Imported)?.items ?? [];
    for (const kind of GRAPH_KINDS) {
      const kept = items.filter((i) => i.type === kind);
      expect(kept.length, kind).toBeGreaterThanOrEqual(1);
      for (const item of kept) {
        expect(item.action).toBe('kept');
        expect(item.reason).toContain('not simulated');
      }
    }
    expect(items.filter((i) => i.type === 'BLOCKGRIPLOCATIONCOMPONENT')).toHaveLength(2);
  });

  it('J10 INVENTORY: no block is keyed P30_LINEAR_STRETCH — the true name is NOT resolved from its XDATA', () => {
    expect(q10Imported.blocks['P30_LINEAR_STRETCH']).toBeUndefined();
    expect(insertsOf(q10Imported).some((i) => i.block === 'P30_LINEAR_STRETCH')).toBe(false);
    // The name survives only as raw XDATA on *U1's own BLOCK_RECORD — retained, unread.
    const nodes = q10Imported.cadGraph!.nodes;
    const u1 = nodes.find((n) => n.type === 'BLOCK_RECORD' && n.anchor?.kind === 'table' && n.anchor.name === '*U1');
    expect(u1).toBeDefined();
    const at = u1!.groups.findIndex(([c, v]) => c === 1001 && v === 'AcDbDynamicBlockTrueName');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(u1!.groups[at + 1]).toEqual([1000, 'P30_LINEAR_STRETCH']);
    // No resolved link: *U1's inserts carry no reference to the name anywhere.
    for (const ins of insertsOf(q10Imported).filter((i) => i.block === '*U1')) {
      expect(ins.dynamic).toBeUndefined();
      expect(Object.values(ins)).not.toContain('P30_LINEAR_STRETCH');
    }
  });

  it('J10 INVENTORY: the *U2 link-back BTag XDATA targets handle 265 — the *U1 record — retained opaquely', () => {
    const nodes = q10Imported.cadGraph!.nodes;
    const recordOf = (name: string) => nodes.find((n) => n.type === 'BLOCK_RECORD' && n.anchor?.kind === 'table' && n.anchor.name === name);
    const u1 = recordOf('*U1')!;
    const u2 = recordOf('*U2')!;
    expect(u1.sourceHandle).toBe('265');
    const at = u2.groups.findIndex(([c, v]) => c === 1001 && v === 'AcDbBlockRepBTag');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(u2.groups.slice(at).find(([c]) => c === 1005)?.[1]).toBe('265');
    expect(u2.groups.slice(at).find(([c]) => c === 1005)?.[1]).toBe(u1.sourceHandle);
  });

  it('J10 INVENTORY: no Distance1 value recovery — the read-back values 100/120/120 live only as baked plate widths; Origin unmodeled', () => {
    // The AutoCAD read-back STATES the values JCad does not recover.
    const values = q10Read.instances.map((inst) => inst.properties.find((p) => p.name === 'Distance1')!.value);
    expect(values).toEqual([100, 120, 120]);
    for (const block of Object.values(q10Imported.blocks)) {
      expect(block.dynamic).toBeUndefined();
      expect(block.dynamicRetained).toBeUndefined();
    }
    for (const ins of insertsOf(q10Imported)) {
      expect(ins.dynamic).toBeUndefined();
      expect(ins.dynamicRetained).toBeUndefined();
    }
    const { cadGraph: _graph, ...model } = q10Imported;
    expect(JSON.stringify(model)).not.toContain('Distance1');
    expect(JSON.stringify(model)).not.toContain('Origin');
    // The values are embodied ONLY in the baked geometry: plate widths 100 (*U1) / 120 (*U2).
    const widthOf = (name: string) => {
      const plate = q10Imported.blocks[name]!.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
      return Math.max(...plate.points.map((p) => p.x)) - Math.min(...plate.points.map((p) => p.x));
    };
    near(widthOf('*U1'), 100, DEF_TOL);
    near(widthOf('*U2'), 120, DEF_TOL);
    // Origin (0,30) is exposed by the read-back for every instance and modeled nowhere.
    for (const inst of q10Read.instances) {
      expect(inst.properties.find((p) => p.name === 'Origin')!.value).toMatchObject({ X: 0, Y: 30, Z: 0 });
    }
  });

  it('J10 INVENTORY: there is no native-instance edit path — the parameter API refuses these inserts atomically', () => {
    for (const ins of insertsOf(q10Imported)) {
      const result = setDynamicParameter(q10Imported, ins.id, 'Distance1', 120);
      expect(result.problem).toBe('no-dynamic-definition');
      expect(result.state).toBe(q10Imported);
    }
  });
});

// ---------------------------------------------------------------- Q10 DWG

describe('Q10 p30-linear-stretch-HANDBUILT-R2000.dwg: R2000 save-down, DWG import (J10)', () => {
  let q10Dwg: DrawingState;

  beforeAll(async () => {
    const { payload } = await readDwgPayload(readFileSync(join(q10Dir, 'p30-linear-stretch-HANDBUILT-R2000.dwg')));
    q10Dwg = convertDwg(payload as DwgImportPayload).state;
  }, 60_000);

  it('J10 DWG: the named block KEEPS its name on this path; only *U2 becomes ANON_U2, and there is no ANON_U3', () => {
    // The DWG path preserves the definition's real name (unlike the DXF path's *U1):
    // asserted from the import, since the plugin read-backs hide every rename.
    expect(Object.keys(q10Dwg.blocks).sort()).toEqual(['ANON_U2', 'P30_LINEAR_STRETCH']);
    expect(insertsOf(q10Dwg).map((i) => i.block).sort()).toEqual(['ANON_U2', 'ANON_U2', 'P30_LINEAR_STRETCH']);
    expect(q10Dwg.blocks['ANON_U3']).toBeUndefined();
  });

  it('J10 DWG: geometry is oracle-exact — definition blocks, world AABBs and TAG1 positions', () => {
    expectBlockGeometryDwg(q10Dwg.blocks['P30_LINEAR_STRETCH']!, q10DefEntities);
    expectBlockGeometryDwg(q10Dwg.blocks['ANON_U2']!, q10BakeEntities);
    for (const o of q10Instances) {
      const ins = insertAt(q10Dwg, o.insertion[0]!, o.insertion[1]!);
      expect(ins.block).toBe(o.blockName === '*U1' ? 'P30_LINEAR_STRETCH' : 'ANON_U2');
      near(ins.rotation, (o.rotationDeg * Math.PI) / 180, DEF_TOL);
      expect(ins.attributes).toEqual({ TAG1: 'P-100' });
      const bb = worldAabb(q10Dwg, ins);
      nearPt(bb.min, o.extents[0]![0]!, o.extents[0]![1]!, WORLD_TOL);
      nearPt(bb.max, o.extents[1]![0]!, o.extents[1]![1]!, WORLD_TOL);
      const tag = worldTag(q10Dwg, ins);
      expect(tag.text).toBe('P-100');
      nearPt(tag.position, o.attributes[0]!.position[0]!, o.attributes[0]!.position[1]!, WORLD_TOL);
    }
  });

  it('J10 DWG loss (closed flag): the plate closed flag does not survive the DWG reader', () => {
    for (const block of Object.values(q10Dwg.blocks)) {
      const plate = block.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
      expect(plate.closed).toBe(false);
    }
  });

  it('J10 DWG loss (ATTDEF default): the ATTDEF default "P-100" does not survive the DWG reader', () => {
    for (const block of Object.values(q10Dwg.blocks)) {
      expect(block.attributes[0]!.default).toBe('');
    }
  });

  it('J10 DWG loss (object graph): absent on the Linux WASM fallback path, raw-preserved on the Windows native path', () => {
    // Same platform split as J9 (the reader attaches the checked native metadata
    // projection only on win32), each shape asserted in full. The Linux shape is
    // measured here; the Windows shape for this AC1015 file is UNMEASURED — it is
    // encoded by analogy to the accepted N1 J9 Shape B (schema 1, HEADER first with
    // the file's own $ACADVER, the five dynamic types among raw-anchored nodes, no
    // omission item) and is verified only by the Windows rerun.
    const graph = q10Dwg.cadGraph;
    const items = importReportOf(q10Dwg)?.items ?? [];
    const omission = items.some((i) => i.type === 'XDATA' && i.action === 'unsupported' && i.reason.includes('dynamic parameters'));
    if (graph === undefined) {
      // Shape A — Linux LibreDWG WASM fallback (this platform): no graph, and the
      // XDATA-omission item is the report trace of the loss (emitted only here).
      expect(graph).toBeUndefined();
      expect(omission).toBe(true);
    } else {
      // Shape B — Windows native path (BY ANALOGY to N1 correction-2, UNMEASURED for
      // AC1015): graph present, schema 1, HEADER first ($ACADVER = AC1015), dynamic
      // graph objects retained among the raw-anchored nodes, no omission item.
      expect(graph.schema).toBe(1);
      expect(graph.nodes.length).toBeGreaterThan(0);
      const first = graph.nodes[0]!;
      expect(first.anchor?.kind).toBe('raw');
      expect(first.type).toBe('HEADER');
      expect(first.groups[0]).toEqual([9, '$ACADVER']);
      expect(first.groups[1]).toEqual([1, 'AC1015']);
      const rawTypes = new Set(
        graph.nodes.filter((n) => n.anchor?.kind === 'raw').map((n) => n.type),
      );
      for (const kind of GRAPH_KINDS) expect(rawTypes.has(kind), kind).toBe(true);
      expect(omission).toBe(false);
    }
  });

  it('J10 DWG invariant (dynamic state): the graph, absent or raw-preserved, is never decoded into dynamic state', () => {
    for (const block of Object.values(q10Dwg.blocks)) {
      expect(block.dynamic).toBeUndefined();
      expect(block.dynamicRetained).toBeUndefined();
    }
    for (const ins of insertsOf(q10Dwg)) {
      expect(ins.dynamic).toBeUndefined();
      expect(ins.dynamicRetained).toBeUndefined();
    }
    const { cadGraph: _graph, ...model } = q10Dwg;
    expect(JSON.stringify(model)).not.toContain('Distance1');
  });
});

function expectBlockGeometryDwg(block: BlockDef, oracleEntities: OracleEntity[]) {
  const plate = block.entities.find((e): e is PolylineEntity => e.type === 'polyline');
  const circle = block.entities.find((e): e is CircleEntity => e.type === 'circle');
  const line = block.entities.find((e): e is LineEntity => e.type === 'line');
  const oPlate = oracleEntities.find((e) => e.type === 'LWPOLYLINE')!;
  const oCircle = oracleEntities.find((e) => e.type === 'CIRCLE')!;
  const oLine = oracleEntities.find((e) => e.type === 'LINE')!;
  const oAtt = oracleEntities.find((e) => e.type === 'ATTDEF')!;
  expect(block.entities).toHaveLength(3);
  expect(plate).toBeDefined();
  expect(plate!.points).toHaveLength(oPlate.vertices!.length);
  plate!.points.forEach((p, i) => nearPt(p, oPlate.vertices![i]![0]!, oPlate.vertices![i]![1]!, DEF_TOL));
  nearPt(circle!.center, oCircle.center![0]!, oCircle.center![1]!, DEF_TOL);
  near(circle!.radius, oCircle.radius!, DEF_TOL);
  nearPt(line!.a, oLine.start![0]!, oLine.start![1]!, DEF_TOL);
  nearPt(line!.b, oLine.end![0]!, oLine.end![1]!, DEF_TOL);
  expect(block.attributes).toHaveLength(1);
  expect(block.attributes[0]!.tag).toBe(oAtt.tag);
  nearPt(block.attributes[0]!.position, oAtt.position![0]!, oAtt.position![1]!, DEF_TOL);
  near(block.attributes[0]!.height, oAtt.height!, DEF_TOL);
}
