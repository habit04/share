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
 *                   fallback path, raw-preserved on the Windows native path — Windows
 *                   review, 2026-10-17) and is asserted per shape in its own test.
 *   J10 TODO      — no R2000 save-down of this fixture is shipped.
 *   J11 REAL (absence half) — no JCAD_DYNAMIC carrier is invented for native data.
 *       INVENTORY (statement half) — the import report never states that parameter values
 *                   were unrecovered; asserted as a concrete absence, not papered over.
 * NOT covered by this fixture at all: Block-Editor-authored byte layout, GUI/Properties
 * palette behavior (M0), R2000 save-down (Q10), Q11 third-party re-evaluation, Q12/Q13.
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

  it.todo('J10: R2000 save-down of this fixture — no R2000 writer output of the native fixture is shipped, so there is nothing to reopen and compare');
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
      // Shape B — Windows native path (encoded from the Windows review of 2026-10-17;
      // verified only by the reviewer's Windows rerun): the graph is present and
      // raw-preserved — schema 1, every node raw-anchored, beginning with the header
      // record ($ACADVER = AC1032). The fallback's XDATA-omission item is not emitted
      // on this path: the metadata was retained, not omitted.
      expect(graph.schema).toBe(1);
      expect(graph.nodes.length).toBeGreaterThan(0);
      for (const node of graph.nodes) expect(node.anchor?.kind).toBe('raw');
      const first = graph.nodes[0]!;
      expect(first.type).toBe('HEADER');
      expect(first.groups[0]).toEqual([9, '$ACADVER']);
      expect(first.groups[1]).toEqual([1, 'AC1032']);
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

/** DWG def-space geometry: same oracle values as J4, but the two measured losses
 *  (closed flag, ATTDEF default) are asserted in the losses test, not here. */
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
