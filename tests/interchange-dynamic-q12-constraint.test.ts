/**
 * Q12 constraint-parameter fixture P30_CONSTRAINT_WIDTH — native-fixture reader/oracle test.
 *
 * Status: BOUND. The HANDBUILT fixture landed 2026-10-18 (lead package
 * JCad-p30-Q12-constraint-handbuilt-oracle-v2.zip; intake SHA256SUMS verified) and is
 * committed under tests/fixtures/native-dynamic-constraint-handbuilt/:
 *   p30-constraint-width-HANDBUILT.dwg   sha256 1b569b715e1965b7214ae0a1f74e7572c7dac346a057e96d41447baa9af2090a
 *   p30-constraint-width-HANDBUILT.dxf   sha256 2abce92d62e7d05cf1686ad532c1dfbf3259a26cef49b7faeaadcd20cbe5a539
 *   oracle-measure.json                  sha256 7a07c88584da2105858009ee874b64380765f5fd5c0e43b001b879b97ef99f31
 *   PROVENANCE-Q12-HANDBUILT.md          sha256 52366df30b825faec2ab82118ff11402c167f3379937068c32c174b1a546dc0b
 * Built headless (accoreconsole, AutoCAD 2027) from the production-frozen recipe
 * (recipes-q12-q13/Q12-RECIPE-PROPOSAL.md, section 6 rulings recorded 2026-10-17:
 * D1 horizontal distance, D3 List {80,100,120,140}, D4 the full 14-constraint network,
 * D5 model work OUT OF SCOPE, D9 IsDynamicBlock recorded as measured).
 *
 * The fixture is HANDBUILT, and the label is binding: the 14-constraint network was
 * authored by AutoCAD's own .NET associative/constraint API in a throwaway profile
 * (the D2(a) fallback), and only the Width1 BLOCKHORIZONTALCONSTRAINTPARAMETER and its
 * wiring were hand-written by injection, layout copied from the shipped Autodesk sample
 * block "Window - Metric" (donor named in the provenance) — never Block-Editor-authored.
 *
 * MEASURED OUTCOMES (AutoCAD 2027's own evaluation, encoded exactly as measured):
 * IsDynamicBlock = true for the constraint-only definition; every record is 0 DOF /
 * WellDefined; Width1 carries the List {80,100,120,140} plus a read-only derived Origin
 * row, and the eight supporting dimensional constraints are NOT exposed as properties.
 * A (Width1 100, untouched) sits on the named record; B and C (both 120) sit on SEPARATE
 * anonymous records with SEPARATE constraint networks — recipe expectation E4 (equal
 * values share one record) is a MEASURED NO. Their baked geometry is value-identical
 * (compared with tolerance — AutoCAD's own coordinates carry ~1.4e-14 noise).
 *
 * This file mirrors recipe section 3.5's J-table (J1–J11). Honesty split, as in N1:
 * retention, geometry, resolution and round-trip are REAL; value recovery and link-back
 * resolution are INVENTORY (concrete negatives). Two recorded traps shape the
 * assertions: (1) every record models eight DIMENSION entities for the supporting
 * constraints, which distort any full-insert bounds — this test asserts record geometry
 * and GEOMETRY-ONLY world extents only, never raw/full extents; (2) anonymous record
 * names differ per path and per read-back (the shipped DXF names C's record *U13,
 * AutoCAD's reopened-DWG read-back calls it *U12) — instances are bound by INSERT
 * everywhere, never by *U name. The *D dimension blocks are absent from the DXF model
 * entirely (the reader does not retain them; the writer synthesizes fresh *D names) but
 * present on the DWG import as ANON_D* records — asserted per path. The
 * DynamicBlockGUID is regenerated per session: presence only, never a value. J11 stays
 * it.todo: no R2000 save-down ships with this fixture. J9's DWG object-graph shape is
 * MEASURED on both platforms and is the same shape on both: for this DWG the checked
 * native metadata projection is rejected — on Windows, LibreDWG returns compatibility
 * flag 64 for the read (the lead's Windows probe: VALIDATION.md +
 * windows-evidence/j9-web-probe.json on their side) — so JCad imports through the
 * fallback reader on Windows exactly as on the Linux WASM path: no cadGraph is
 * retained on the DWG path on either platform, and the associative constraint web is
 * therefore NOT captured there (the DXF path retains it in full — J1). The only
 * platform-specific report fact is the CAD_METADATA 'unsupported' item carrying the
 * flags-64 note, which the rejected projection produces on win32 only.
 *
 * Scope: Q12 only. No claim about Q10, Q11 or Q13.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readDxf, writeDxf } from '../src/io/dxf';
import { decodeDxfBytes } from '../src/io/encoding';
import { importReportOf } from '../src/io/import-report';
import type { DrawingState } from '../src/core/document';
import type { CadNode } from '../src/core/cad-graph';
import type { BlockDef, CircleEntity, InsertEntity, LineEntity, PolylineEntity, TextEntity } from '../src/core/entities';
import { entityBounds, explodeInsert } from '../src/core/entities';
import { unionBounds, type Bounds, type Point } from '../src/core/geometry';
import { setDynamicParameter } from '../src/core/parametric/apply';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
// @ts-expect-error plain JS reader shared with Electron/CLI, like tests/dwg-native-read.test.ts
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

// ------------------------------------------------------------------ constants

const DEF_TOL = 1e-9; // definition-space geometry, as in the accepted N1 test
const WORLD_TOL = 1e-6; // world-space (exploded) values, as in the accepted N1 test

const near = (a: number, b: number, tol: number) =>
  expect(Math.abs(a - b), `${a} vs ${b}`).toBeLessThanOrEqual(tol);
const nearPt = (p: Point | undefined, x: number, y: number, tol: number) => {
  expect(p).toBeDefined();
  near(p!.x, x, tol);
  near(p!.y, y, tol);
};

const BLOCK_NAME = 'P30_CONSTRAINT_WIDTH';
const PARAMETER_NAME = 'Width1';
const VALUE_LIST = [80, 100, 120, 140];

/** The nine driving variables of every constraint network (recipe section 1.2). */
const VARIABLE_NAMES = ['Width1', 'Height1', 'HoleX', 'HoleY', 'HoleRad', 'LineX1', 'LineY1', 'LineX2', 'LineY2'];
const VARIABLE_VALUES_NAMED = ['100', '60', '30', '30', '10', '30', '20', '10', '40'];

interface RecordGeometry {
  plate: Array<[number, number]>;
  circle: { center: [number, number]; radius: number };
  line: { a: [number, number]; b: [number, number] };
}
/** Authored state (Width1 = 100): the named record, identical to the N1 geometry. */
const AUTHORED_GEOMETRY: RecordGeometry = {
  plate: [
    [0, 0],
    [100, 0],
    [100, 60],
    [0, 60],
  ],
  circle: { center: [30, 30], radius: 10 },
  line: { a: [70, 20], b: [90, 40] },
};
/** Evaluated state (Width1 = 120): plate widened, line rides the right edge, circle unmoved. */
const BAKED_GEOMETRY: RecordGeometry = {
  plate: [
    [0, 0],
    [120, 0],
    [120, 60],
    [0, 60],
  ],
  circle: { center: [30, 30], radius: 10 },
  line: { a: [90, 20], b: [110, 40] },
};
const TAG1 = { tag: 'TAG1', position: [10, 45] as [number, number], height: 5, default: 'P-100' };

interface Q12InstanceSpec {
  id: 'A' | 'B' | 'C';
  insertion: [number, number];
  rotationDeg: number;
  value: number;
  dxfRecord: string;
  dwgRecord: string;
  geometry: RecordGeometry;
}
/** Bound by INSERT everywhere; the record keys are the measured per-path names. */
const INSTANCES: Q12InstanceSpec[] = [
  { id: 'A', insertion: [0, 0], rotationDeg: 0, value: 100, dxfRecord: BLOCK_NAME, dwgRecord: BLOCK_NAME, geometry: AUTHORED_GEOMETRY },
  { id: 'B', insertion: [200, 0], rotationDeg: 0, value: 120, dxfRecord: '*U10', dwgRecord: 'ANON_U10', geometry: BAKED_GEOMETRY },
  { id: 'C', insertion: [400, 0], rotationDeg: 30, value: 120, dxfRecord: '*U13', dwgRecord: 'ANON_U13', geometry: BAKED_GEOMETRY },
];
/**
 * The constraint-web + evaluation-graph object kinds retained in the cad-graph, with
 * their per-kind record counts in this fixture (structural facts of the retained web:
 * 3 constraint groups, 27 variables = 3 networks x 9, 24 dimension dependency bodies;
 * the graph's TOTAL node count is deliberately never pinned — it moved 399 -> 403
 * across a single write at bind time).
 */
const WEB_KIND_COUNTS: Record<string, number> = {
  BLOCKHORIZONTALCONSTRAINTPARAMETER: 1,
  BLOCKPARAMDEPENDENCYBODY: 3,
  ACDBASSOCNETWORK: 4,
  ACDBASSOC2DCONSTRAINTGROUP: 3,
  ACDBASSOCVARIABLE: 27,
  ACDBASSOCVALUEDEPENDENCY: 27,
  ACDBASSOCGEOMDEPENDENCY: 18,
  ACDBASSOCDEPENDENCY: 27,
  ASSOCDIMDEPENDENCYBODY: 24,
  ACDB_DYNAMICBLOCKPURGEPREVENTER_VERSION: 1,
  ACDB_DYNAMICBLOCKPROXYNODE: 1,
  ACAD_EVALUATION_GRAPH: 1,
  BLOCKLINEARGRIP: 1,
  BLOCKGRIPLOCATIONCOMPONENT: 2,
};
const WEB_KINDS = Object.keys(WEB_KIND_COUNTS);

// ------------------------------------------------------------------ oracle type

interface Q12OracleEntity {
  type: string;
  closed?: boolean;
  vertices?: number[][];
  center?: number[];
  radius?: number;
  start?: number[];
  end?: number[];
  tag?: string;
  default?: string;
  position?: number[];
  height?: number;
}
interface Q12OracleProperty {
  name: string;
  value: unknown;
  readOnly: boolean;
  allowed: number[];
}
interface Q12OracleInstance {
  instance: string;
  blockName: string;
  insertion: number[];
  rotationDeg: number;
  properties: Q12OracleProperty[];
  extentsGeometryOnly: number[][];
  attributes: Array<{ tag: string; text: string; position: number[] }>;
  constraintState: { record: string; variables: Record<string, string> };
  blockEntities: Q12OracleEntity[];
}
interface Q12Oracle {
  definitionIsDynamic: boolean;
  definitionEntities: Q12OracleEntity[];
  definitionConstraints: Array<{ name?: string; kind: string }>;
  definitionNetworkState: { variables: Record<string, string> };
  instances: Q12OracleInstance[];
  anonymousRecords: Array<{ name: string; referencedByInstances: string[]; linkBack: Array<[number, string]> }>;
  anonymousURecordNamesInBuildSession: Record<string, string>;
  audit: {
    handbuiltInputOnOpen: number;
    beforeExport: number;
    afterReopenDwg: number;
    afterReopenDxf: number;
  };
}

const fxDir = join(__dirname, 'fixtures', 'native-dynamic-constraint-handbuilt');
const q12Oracle = JSON.parse(readFileSync(join(fxDir, 'oracle-measure.json'), 'utf8')) as Q12Oracle;
const sha256Of = (name: string) => createHash('sha256').update(readFileSync(join(fxDir, name))).digest('hex');

const DXF_NAME = 'p30-constraint-width-HANDBUILT.dxf';
const sourceText = decodeDxfBytes(readFileSync(join(fxDir, DXF_NAME))).text;
const imported = readDxf(sourceText);
const written = writeDxf(imported);
const roundTripped = readDxf(written);

// ------------------------------------------------------------------ helpers

const insertsOf = (s: DrawingState): InsertEntity[] => s.entities.filter((e): e is InsertEntity => e.type === 'insert');
const insertAt = (s: DrawingState, x: number, y: number): InsertEntity => {
  const ins = insertsOf(s).find((i) => i.position.x === x && i.position.y === y);
  expect(ins, `insert at ${x},${y}`).toBeDefined();
  return ins!;
};
const lookupOf = (s: DrawingState) => (n: string) => s.blocks[n];

/**
 * World AABB of an insert over GEOMETRY ONLY (plate polyline, circle, line) — the
 * oracle's extentsGeometryOnly definition. The eight DIMENSION entities each record
 * carries (and the ATTRIB text) are excluded: full-insert bounds are distorted by the
 * dimensions and are never asserted anywhere in this file.
 */
function worldGeometryAabb(s: DrawingState, ins: InsertEntity): Bounds {
  const lookup = lookupOf(s);
  let bb: Bounds | null = null;
  for (const part of explodeInsert(ins, lookup)) {
    if (part.type !== 'polyline' && part.type !== 'circle' && part.type !== 'line') continue;
    bb = unionBounds(bb, entityBounds(part, lookup));
  }
  expect(bb).not.toBeNull();
  return bb!;
}
/** Full world AABB (all exploded parts, dimensions included) — used ONLY to document the trap. */
function worldFullAabb(s: DrawingState, ins: InsertEntity): Bounds {
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

/** The group pairs of every object record of one kind in DXF text (as in the N1/Q13 tests). */
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

/** Trimmed values of one group code on a cad-graph node (numeric groups ride as padded strings). */
const groupVals = (node: Pick<CadNode, 'groups'>, code: number): string[] =>
  node.groups.filter(([c]) => c === code).map(([, v]) => v.trim());

/**
 * Record geometry against the expected plate/circle/line, with tolerance (never exact
 * comparison — AutoCAD's coordinates carry ~1.4e-14 noise). Every record also models
 * exactly eight DIMENSION entities (the supporting constraints); they are counted here
 * and excluded from every bounds assertion. `dwg` drops the two facts the DWG path
 * measurably loses (plate closed flag, ATTDEF default) — asserted as losses in J9.
 */
function expectRecordGeometry(block: BlockDef, geom: RecordGeometry, dwg: boolean) {
  const plate = block.entities.find((e): e is PolylineEntity => e.type === 'polyline');
  const circle = block.entities.find((e): e is CircleEntity => e.type === 'circle');
  const line = block.entities.find((e): e is LineEntity => e.type === 'line');
  expect(plate).toBeDefined();
  if (!dwg) expect(plate!.closed).toBe(true);
  expect(plate!.points).toHaveLength(geom.plate.length);
  plate!.points.forEach((p, i) => nearPt(p, geom.plate[i]![0]!, geom.plate[i]![1]!, DEF_TOL));
  expect(circle).toBeDefined();
  nearPt(circle!.center, geom.circle.center[0], geom.circle.center[1], DEF_TOL);
  near(circle!.radius, geom.circle.radius, DEF_TOL);
  expect(line).toBeDefined();
  nearPt(line!.a, geom.line.a[0], geom.line.a[1], DEF_TOL);
  nearPt(line!.b, geom.line.b[0], geom.line.b[1], DEF_TOL);
  expect(block.entities.filter((e) => e.type === 'dimension')).toHaveLength(8);
  expect(block.attributes).toHaveLength(1);
  const att = block.attributes[0]!;
  expect(att.tag).toBe(TAG1.tag);
  nearPt(att.position, TAG1.position[0], TAG1.position[1], DEF_TOL);
  near(att.height, TAG1.height, DEF_TOL);
  if (!dwg) expect(att.default).toBe(TAG1.default);
}

/** Two records' plate/circle/line are value-identical (tolerance compare, never stringify). */
function expectSameGeometry(a: BlockDef, b: BlockDef) {
  const grab = (blk: BlockDef) => ({
    plate: blk.entities.find((e): e is PolylineEntity => e.type === 'polyline')!,
    circle: blk.entities.find((e): e is CircleEntity => e.type === 'circle')!,
    line: blk.entities.find((e): e is LineEntity => e.type === 'line')!,
  });
  const ga = grab(a);
  const gb = grab(b);
  ga.plate.points.forEach((p, i) => nearPt(gb.plate.points[i], p.x, p.y, DEF_TOL));
  nearPt(gb.circle.center, ga.circle.center.x, ga.circle.center.y, DEF_TOL);
  near(gb.circle.radius, ga.circle.radius, DEF_TOL);
  nearPt(gb.line.a, ga.line.a.x, ga.line.a.y, DEF_TOL);
  nearPt(gb.line.b, ga.line.b.x, ga.line.b.y, DEF_TOL);
}

/** World facts of one instance: geometry-only extents + TAG1, against the oracle. */
function expectWorldFacts(s: DrawingState, o: Q12OracleInstance, sp: Q12InstanceSpec) {
  const ins = insertAt(s, sp.insertion[0], sp.insertion[1]);
  near(ins.rotation, (sp.rotationDeg * Math.PI) / 180, DEF_TOL);
  const bb = worldGeometryAabb(s, ins);
  nearPt(bb.min, o.extentsGeometryOnly[0]![0]!, o.extentsGeometryOnly[0]![1]!, WORLD_TOL);
  nearPt(bb.max, o.extentsGeometryOnly[1]![0]!, o.extentsGeometryOnly[1]![1]!, WORLD_TOL);
  const tag = worldTag(s, ins);
  expect(tag.text).toBe(o.attributes[0]!.text);
  nearPt(tag.position, o.attributes[0]!.position[0]!, o.attributes[0]!.position[1]!, WORLD_TOL);
  return ins;
}
const oracleInstance = (id: Q12InstanceSpec['id']): Q12OracleInstance =>
  q12Oracle.instances.find((i) => i.instance === id)!;

// ------------------------------------------------------------------ DXF

describe('p30-constraint-width-HANDBUILT.dxf: constraint-parameter fixture, DXF import', () => {
  it('intake: the committed fixture files are byte-identical to the delivered HANDBUILT package; the manifest parses in the recipe section 3.2 shape', () => {
    // SHA-256s recorded at intake against the lead package's SHA256SUMS; pinned here so
    // any fixture drift fails first.
    expect(sha256Of('p30-constraint-width-HANDBUILT.dwg')).toBe('1b569b715e1965b7214ae0a1f74e7572c7dac346a057e96d41447baa9af2090a');
    expect(sha256Of(DXF_NAME)).toBe('2abce92d62e7d05cf1686ad532c1dfbf3259a26cef49b7faeaadcd20cbe5a539');
    expect(sha256Of('oracle-measure.json')).toBe('7a07c88584da2105858009ee874b64380765f5fd5c0e43b001b879b97ef99f31');
    expect(sha256Of('PROVENANCE-Q12-HANDBUILT.md')).toBe('52366df30b825faec2ab82118ff11402c167f3379937068c32c174b1a546dc0b');
    const provenance = readFileSync(join(fxDir, 'PROVENANCE-Q12-HANDBUILT.md'), 'utf8');
    expect(provenance).toContain('HANDBUILT');
    // The D2(a) authoring: the network was written by AutoCAD's own constraint API;
    // only Width1 was injected, from the "Window - Metric" donor.
    expect(provenance).toContain('.NET associative/constraint API');
    expect(provenance).toContain('hand-written by injection');
    expect(provenance).toContain('Window - Metric');
    // Manifest shape (recipe section 3.2, incl. the definitionConstraints extension):
    // D9 recorded as measured — a constraint-only definition IS dynamic.
    expect(q12Oracle.definitionIsDynamic).toBe(true);
    expect(q12Oracle.definitionConstraints).toHaveLength(14);
    expect(q12Oracle.definitionConstraints.filter((c) => c.kind.endsWith('distance') || c.kind === 'radius')).toHaveLength(9);
    expect(q12Oracle.definitionConstraints.find((c) => c.name === 'Width1')).toMatchObject({ kind: 'horizontal-distance' });
    expect(q12Oracle.definitionNetworkState.variables).toEqual({
      Width1: '100', Height1: '60', HoleX: '30', HoleY: '30', HoleRad: '10',
      LineX1: '30', LineY1: '20', LineX2: '10', LineY2: '40',
    });
    // Per instance the API exposes Width1 (with the built List) and the read-only
    // derived Origin row — and NOT the eight supporting constraints.
    expect(q12Oracle.instances.map((i) => i.instance)).toEqual(['A', 'B', 'C']);
    for (const o of q12Oracle.instances) {
      expect(o.properties.map((p) => p.name)).toEqual(['Width1', 'Origin']);
      const w = o.properties[0]!;
      expect(w.readOnly).toBe(false);
      expect(w.allowed).toEqual(VALUE_LIST);
      expect(o.properties[1]!.readOnly).toBe(true); // Origin: AutoCAD-derived, accounted for, not an error
      expect(o.constraintState.variables.Width1).toBe(String(o === q12Oracle.instances[0] ? 100 : 120));
    }
    // AUDIT reported zero errors at every recorded point.
    expect(q12Oracle.audit).toMatchObject({ handbuiltInputOnOpen: 0, beforeExport: 0, afterReopenDwg: 0, afterReopenDxf: 0 });
  });

  it('J1 (REAL) retention: the associative constraint web, retained raw as a sibling of the evaluation graph, is byte-stable across write', () => {
    const graph = imported.cadGraph;
    expect(graph).toBeDefined();
    expect(graph!.schema).toBe(1);
    expect(graph!.nodes.length).toBeGreaterThan(0); // total node count deliberately NOT pinned (399 -> 403 across one write)
    const first = graph!.nodes[0]!;
    expect(first.anchor?.kind).toBe('raw');
    expect(first.type).toBe('HEADER');
    expect(first.groups[0]).toEqual([9, '$ACADVER']);
    expect(first.groups[1]).toEqual([1, 'AC1032']);
    // Every tracked web/evaluation kind is among the raw-anchored nodes — the constraint
    // web (ACDBASSOCNETWORK, 3x ACDBASSOC2DCONSTRAINTGROUP, 27x ACDBASSOCVARIABLE, the
    // dependency bodies) rides as a SIBLING of the ACAD_EVALUATION_GRAPH, not inside it.
    const rawTypes = new Set(graph!.nodes.filter((n) => n.anchor?.kind === 'raw').map((n) => n.type));
    for (const kind of WEB_KINDS) expect(rawTypes.has(kind), kind).toBe(true);
    // Per-kind object records are byte-identical source -> written, at the pinned counts.
    for (const kind of WEB_KINDS) {
      const fromSource = records(sourceText, kind);
      expect(fromSource, kind).toHaveLength(WEB_KIND_COUNTS[kind]!);
      expect(records(written, kind), kind).toEqual(fromSource);
    }
    // Marker parity source vs written for the web and its link-back/GUID strings.
    for (const marker of [...WEB_KINDS, 'Width1', 'AcDbBlockRepBTag', 'AcDbDynamicBlockTrueName', 'AcDbDynamicBlockGUID']) {
      expect(countOccurrences(written, marker), marker).toBe(countOccurrences(sourceText, marker));
    }
    // Scoped to the retained records: the *D dimension blocks are NOT retained — the
    // source DXF carries them as BLOCK records, yet no *D key exists in the model.
    expect(sourceText).toContain('*D2');
    expect(Object.keys(imported.blocks).sort()).toEqual(['*U10', '*U13', BLOCK_NAME]);
    expect(Object.keys(imported.blocks).some((k) => k.startsWith('*D'))).toBe(false);
    // On write the writer synthesizes fresh *D dimension-block names (a write artifact,
    // not retained records): the written text carries *D names, the re-read model does not.
    expect(written).toContain('*D1');
    expect(Object.keys(roundTripped.blocks).some((k) => k.startsWith('*D'))).toBe(false);
    // The written file stays R2018.
    const rtFirst = roundTripped.cadGraph!.nodes[0]!;
    expect(rtFirst.groups[0]).toEqual([9, '$ACADVER']);
    expect(rtFirst.groups[1]).toEqual([1, 'AC1032']);
  });

  it('F1 (REAL, Q11) writer *D sharing: the 24 written DIMENSIONs reference exactly 12 distinct synthesized *D blocks', () => {
    // Content-key dedup (Q11 F1): dimensions whose generated pictures are identical
    // share one *D block — 8 distinct graphics in the named record plus 4 new ones at
    // Width1 = 120; the radius and the *U records' line dimensions share across
    // records. AutoCAD's own file carries 18 (its count also depends on evaluation
    // history and is deliberately NOT the target); before the fix JCad wrote 24.
    const dims = records(written, 'DIMENSION');
    expect(dims).toHaveLength(24);
    const refs = dims.map((r) => r.find(([code]) => code === 2)?.[1]);
    expect(new Set(refs).size).toBe(12);
    const blockNames = records(written, 'BLOCK_RECORD')
      .map((r) => r.find(([code]) => code === 2)?.[1] ?? '')
      .filter((n) => /^\*D\d+$/.test(n));
    expect(blockNames).toHaveLength(12);
    expect(new Set(blockNames)).toEqual(new Set(refs));
  });

  it('F2 (REAL, Q11) header emission: the written header never re-emits the retained $LASTSAVEDBY; the 2008+ names follow the target version', () => {
    // The retained graph keeps the source's $LASTSAVEDBY verbatim — retention is not
    // emission: after a JCad save JCad is the last saver, so the source author's name
    // is never written back, at any version (Q11 F2).
    const headerNode = imported.cadGraph!.nodes.find((n) => n.type === 'HEADER' && n.section === 'HEADER')!;
    expect(headerNode.groups).toContainEqual([9, '$LASTSAVEDBY']);
    expect(written).not.toContain('$LASTSAVEDBY');
    // This file writes at AC1032, where the AutoCAD 2008+ names are legal and stay
    // (their suppression at AC1015/AC1018 is pinned in tests/dxf-layouts.test.ts and
    // tests/layout-native-page-settings.test.ts).
    expect(written).toContain('$CANNOSCALE');
  });

  it('J1 (REAL) the retained Width1 parameter node carries the full native encoding: name, points, value set', () => {
    const params = imported.cadGraph!.nodes.filter((n) => n.type === 'BLOCKHORIZONTALCONSTRAINTPARAMETER');
    expect(params).toHaveLength(1);
    const param = params[0]!;
    expect(param.groups).toContainEqual([300, 'Width1']);
    expect(param.groups).toContainEqual([305, 'Width1']);
    // The constrained points ride verbatim: base (0,0) -> end (100,0) (groups 1010/1011).
    expect(groupVals(param, 1010)).toEqual(['0.0']);
    expect(groupVals(param, 1011)).toEqual(['100.0']);
    // The value set rides verbatim: group 96 = 8 (list encoding), group 175 = 4 values,
    // group 144 = the list itself, in order.
    expect(groupVals(param, 96)).toEqual(['8']);
    expect(groupVals(param, 175)).toEqual(['4']);
    expect(groupVals(param, 144)).toEqual(['80.0', '100.0', '120.0', '140.0']);
  });

  it('J2 resolution (REAL): the three inserts resolve by INSERT — A to the named record, B to *U10, C to *U13', () => {
    // The shipped DXF's own names (the build-session record names in the manifest);
    // AutoCAD's reopened-DWG read-back calls C's record *U12 — names are per-path
    // facts, so binding is by INSERT position, never by *U name.
    expect(q12Oracle.anonymousURecordNamesInBuildSession).toEqual({ A: BLOCK_NAME, B: '*U10', C: '*U13' });
    for (const sp of INSTANCES) {
      expect(insertAt(imported, sp.insertion[0], sp.insertion[1]).block).toBe(sp.dxfRecord);
    }
    expect(insertsOf(imported)).toHaveLength(3);
  });

  it('J2 link-back (INVENTORY): the *U records\u2019 BTag XDATA is retained opaquely in the graph; nothing resolves it', () => {
    const nodes = imported.cadGraph!.nodes;
    const recordOf = (name: string) =>
      nodes.find((n) => n.type === 'BLOCK_RECORD' && n.anchor?.kind === 'table' && n.anchor.name === name);
    const named = recordOf(BLOCK_NAME);
    expect(named).toBeDefined();
    expect(named!.sourceHandle).toBe('265');
    for (const anon of ['*U10', '*U13']) {
      const rec = recordOf(anon);
      expect(rec, anon).toBeDefined();
      const at = rec!.groups.findIndex(([c, v]) => c === 1001 && v === 'AcDbBlockRepBTag');
      expect(at, `${anon} BTag`).toBeGreaterThanOrEqual(0);
      // The retained payload points back at the named record's handle — raw XDATA only.
      expect(rec!.groups.slice(at).find(([c]) => c === 1005)?.[1]).toBe(named!.sourceHandle);
    }
    // The DynamicBlockGUID rides on the named record — presence only, never a value:
    // AutoCAD regenerates it per session, so pinning one would be false.
    const guidAt = named!.groups.findIndex(([c, v]) => c === 1001 && v === 'AcDbDynamicBlockGUID');
    expect(guidAt).toBeGreaterThanOrEqual(0);
    expect(named!.groups[guidAt + 1]?.[0]).toBe(1000);
    expect(named!.groups[guidAt + 1]?.[1]).toMatch(/^\{[^}]+\}$/);
    // No resolution: the anonymous inserts carry no reference to the named block.
    for (const ins of insertsOf(imported).filter((i) => i.block !== BLOCK_NAME)) {
      expect(ins.dynamic).toBeUndefined();
      expect(Object.values(ins)).not.toContain(BLOCK_NAME);
    }
  });

  it('J3 (INVENTORY) no Width1 value recovery: no dynamic state, no constraint state — values live only in the *U geometry and the raw graph', () => {
    for (const block of Object.values(imported.blocks)) {
      expect(block.dynamic).toBeUndefined();
      expect(block.dynamicRetained).toBeUndefined();
    }
    for (const ins of insertsOf(imported)) {
      expect(ins.dynamic).toBeUndefined();
      expect(ins.dynamicRetained).toBeUndefined();
    }
    // No definition-scoped constraint attachment is fabricated (recipe gap CG1 / ruling
    // D5): the drawing state has no constraints field at all.
    expect((imported as { constraints?: unknown }).constraints).toBeUndefined();
    expect(Object.keys(imported)).not.toContain('constraints');
    // 'Width1' exists in the model ONLY inside the retained cadGraph records.
    const { cadGraph: _graph, ...model } = imported;
    expect(JSON.stringify(model)).not.toContain('Width1');
    // The raw graph, by contrast, DOES carry the full encoding (asserted in J1): three
    // ACDBASSOCVARIABLE networks whose Width1 values are 100 / 120 / 120 — raw
    // retention, never model recovery.
    const variables = imported.cadGraph!.nodes.filter((n) => n.type === 'ACDBASSOCVARIABLE');
    expect(variables).toHaveLength(27);
    const pairs = variables.map((n) => groupVals(n, 1).slice(0, 2));
    expect(pairs.map((p) => p[0])).toEqual([...VARIABLE_NAMES, ...VARIABLE_NAMES, ...VARIABLE_NAMES]);
    expect(pairs.filter((p) => p[0] === 'Width1').map((p) => p[1])).toEqual(['100', '120', '120']);
    expect(pairs.slice(0, 9).map((p) => p[1])).toEqual(VARIABLE_VALUES_NAMED);
  });

  it('J4 (REAL) evaluated geometry per instance matches the manifest: record geometry and geometry-only world extents', () => {
    // Named record == the oracle's definition entities (the authored state).
    expectRecordGeometry(imported.blocks[BLOCK_NAME]!, AUTHORED_GEOMETRY, false);
    for (const sp of INSTANCES) {
      expectRecordGeometry(imported.blocks[sp.dxfRecord]!, sp.geometry, false);
      expectWorldFacts(imported, oracleInstance(sp.id), sp);
    }
    // The trap, documented: full-insert bounds (dimensions included) do NOT match the
    // geometry-only extents — instance A's full bounds reach x = -25.18 from the
    // constraint DIMENSION entities, far outside the plate. That is why no assertion
    // in this file ever uses raw/full extents.
    const aFull = worldFullAabb(imported, insertAt(imported, 0, 0));
    const aGeom = worldGeometryAabb(imported, insertAt(imported, 0, 0));
    expect(aFull.min.x).toBeLessThan(aGeom.min.x - 1);
    expect(aFull.min.y).toBeLessThan(aGeom.min.y - 1);
  });

  it('J5 (REAL, from manifest) E4 is a measured NO: B and C hold separate records and separate networks with value-identical geometry', () => {
    const bRec = imported.blocks['*U10']!;
    const cRec = imported.blocks['*U13']!;
    expect(bRec).not.toBe(cRec);
    expect(insertAt(imported, 200, 0).block).toBe('*U10');
    expect(insertAt(imported, 400, 0).block).toBe('*U13');
    // Value-identical baked geometry (tolerance compare — never exact stringify).
    expectSameGeometry(bRec, cRec);
    // Separate networks: the graph carries THREE ACDBASSOC2DCONSTRAINTGROUPs and two
    // DISTINCT Width1 = 120 variables (one per non-default network).
    const groups = imported.cadGraph!.nodes.filter((n) => n.type === 'ACDBASSOC2DCONSTRAINTGROUP');
    expect(groups).toHaveLength(3);
    const width120 = imported.cadGraph!.nodes.filter(
      (n) => n.type === 'ACDBASSOCVARIABLE' && groupVals(n, 1)[0] === 'Width1' && groupVals(n, 1)[1] === '120',
    );
    expect(width120).toHaveLength(2);
    expect(new Set(width120.map((n) => groupVals(n, 5)[0])).size).toBe(2);
    // The manifest's own referencing (AutoCAD's reopened-DWG read-back names): B -> *U10,
    // C -> *U12 — distinct records there too, each link-backed to the named handle 265.
    expect(
      q12Oracle.anonymousRecords
        .filter((r) => r.name.startsWith('*U'))
        .map(({ name, referencedByInstances, linkBack }) => ({ name, referencedByInstances, linkBack })),
    ).toEqual([
      { name: '*U10', referencedByInstances: ['B'], linkBack: [[1001, 'AcDbBlockRepBTag'], [1070, '1'], [1005, '265']] },
      { name: '*U12', referencedByInstances: ['C'], linkBack: [[1001, 'AcDbBlockRepBTag'], [1070, '1'], [1005, '265']] },
    ]);
    // Every model record is referenced (no orphan *U on this path): the anonymous
    // inventory is exactly the two baked records, and each is used by exactly one insert.
    expect(insertsOf(imported).filter((i) => i.block === '*U10')).toHaveLength(1);
    expect(insertsOf(imported).filter((i) => i.block === '*U13')).toHaveLength(1);
  });

  it('J6 (INVENTORY) no native-instance edit path: setDynamicParameter(\u2018Width1\u2019) refuses all three inserts with input-state identity', () => {
    for (const ins of insertsOf(imported)) {
      const result = setDynamicParameter(imported, ins.id, PARAMETER_NAME, 140);
      expect(result.problem).toBe('no-dynamic-definition');
      expect(result.state).toBe(imported);
    }
  });

  it('J7 (REAL) TAG1 value P-100 and placement survive import on all three instances', () => {
    for (const sp of INSTANCES) {
      const ins = insertAt(imported, sp.insertion[0], sp.insertion[1]);
      expect(ins.attributes).toEqual({ TAG1: 'P-100' });
      const tag = worldTag(imported, ins);
      expect(tag.text).toBe('P-100');
      const o = oracleInstance(sp.id);
      nearPt(tag.position, o.attributes[0]!.position[0]!, o.attributes[0]!.position[1]!, WORLD_TOL);
      // The ATTDEF itself keeps its default and authored placement in every record.
      const att = imported.blocks[sp.dxfRecord]!.attributes[0]!;
      expect(att.default).toBe('P-100');
      nearPt(att.position, TAG1.position[0], TAG1.position[1], DEF_TOL);
      near(att.height, TAG1.height, DEF_TOL);
    }
  });

  it('J8 (REAL) round trip: import -> save -> re-import yields identical geometry and the retained web stays byte-stable', () => {
    // Writing the re-import is a fixed point (the retained web survives the cycle).
    expect(writeDxf(roundTripped)).toBe(written);
    expect(Object.keys(roundTripped.blocks).sort()).toEqual(Object.keys(imported.blocks).sort());
    for (const sp of INSTANCES) {
      expectRecordGeometry(roundTripped.blocks[sp.dxfRecord]!, sp.geometry, false);
      expectWorldFacts(roundTripped, oracleInstance(sp.id), sp);
    }
    // J1 holds on the re-read state: per-kind records still byte-identical to source.
    for (const kind of WEB_KINDS) {
      expect(records(written, kind), kind).toEqual(records(sourceText, kind));
    }
    const rtRawTypes = new Set(roundTripped.cadGraph!.nodes.filter((n) => n.anchor?.kind === 'raw').map((n) => n.type));
    for (const kind of WEB_KINDS) expect(rtRawTypes.has(kind), kind).toBe(true);
    // The *D exclusion holds across the trip: synthesized on write, never retained.
    expect(Object.keys(roundTripped.blocks).some((k) => k.startsWith('*D'))).toBe(false);
    // The recovered-values clause is vacuous per J3: there are no recovered values
    // whose stability could be checked; the retained graph bytes are the claim.
  });

  it('J10 (REAL negatives): no JCAD_DYNAMIC and no JCAD_CONSTRAINTS carrier exists in the source, the model, or the written output', () => {
    for (const marker of ['JCAD_DYNAMIC', 'JCAD_CONSTRAINTS']) {
      expect(countOccurrences(sourceText, marker)).toBe(0);
      expect(JSON.stringify(imported)).not.toContain(marker);
      expect(countOccurrences(written, marker)).toBe(0);
    }
    const items = importReportOf(imported)?.items ?? [];
    expect(items.some((i) => i.type === 'JCAD_DYNAMIC' || i.type === 'JCAD_CONSTRAINTS')).toBe(false);
    // And no DynamicBlockDefinition / ConstraintSet is fabricated from the native
    // network: no block or insert carries dynamic state (J3) and the state has no
    // constraints field (J3) — the import is clean, the mechanism simply unmodeled.
  });

  it('J10: the import report keeps every constraint-web type \u2018not simulated\u2019 — and (INVENTORY) never states values were unrecovered', () => {
    const items = importReportOf(imported)?.items ?? [];
    for (const kind of WEB_KINDS) {
      const kept = items.filter((i) => i.type === kind);
      expect(kept, kind).toHaveLength(WEB_KIND_COUNTS[kind]!);
      for (const item of kept) {
        expect(item.action).toBe('kept');
        expect(item.reason).toContain('not simulated');
      }
    }
    // Statement half (unmet, recorded as inventory): no item says the Width1 values
    // could not be recovered — the report is silent about the loss J3 documents.
    expect(items.some((i) => /unrecovered|not recovered|no parameter value/i.test(i.reason))).toBe(false);
  });

  it.todo('J11 (todo per recipe) R2000 save-down: not shipped with this fixture; nothing to assert against');
});

// ------------------------------------------------------------------ DWG (J9)

describe('p30-constraint-width-HANDBUILT.dwg: constraint-parameter fixture, DWG import (J9)', () => {
  let state: DrawingState;

  beforeAll(async () => {
    const { payload } = await readDwgPayload(readFileSync(join(fxDir, 'p30-constraint-width-HANDBUILT.dwg')));
    state = convertDwg(payload as DwgImportPayload).state;
  }, 60_000);

  it('J9/J2: imports through the native reader; inserts resolve by INSERT to the named record and ANON_U records; the *D dimension blocks are present on this path', () => {
    const keys = Object.keys(state.blocks);
    expect(keys).toHaveLength(21); // named + 2 ANON_U + 18 ANON_D
    expect(keys.filter((k) => /^ANON_D\d+$/.test(k))).toHaveLength(18);
    expect(keys.filter((k) => !/^ANON_D\d+$/.test(k)).sort()).toEqual(['ANON_U10', 'ANON_U13', BLOCK_NAME]);
    for (const sp of INSTANCES) {
      expect(insertAt(state, sp.insertion[0], sp.insertion[1]).block).toBe(sp.dwgRecord);
    }
    // Path-scoped *D fact: on the DWG import the dimension blocks ARE present (as
    // ANON_D*) — the exact opposite of the DXF model, where they are absent entirely.
    // No insert references any of them.
    expect(insertsOf(state).some((i) => i.block.startsWith('ANON_D'))).toBe(false);
  });

  it('J9/J4 (REAL): geometry is oracle-exact on the DWG path too — per-record geometry and geometry-only world extents', () => {
    for (const sp of INSTANCES) {
      expectRecordGeometry(state.blocks[sp.dwgRecord]!, sp.geometry, true);
      expectWorldFacts(state, oracleInstance(sp.id), sp);
    }
    // E4's measured NO holds on this path too: B's and C's records are distinct with
    // value-identical geometry.
    expect(state.blocks['ANON_U10']).not.toBe(state.blocks['ANON_U13']);
    expectSameGeometry(state.blocks['ANON_U10']!, state.blocks['ANON_U13']!);
  });

  it('J9 measured DWG loss (closed flag): the plate closed flag does not survive the DWG reader', () => {
    for (const sp of INSTANCES) {
      const plate = state.blocks[sp.dwgRecord]!.entities.find((e): e is PolylineEntity => e.type === 'polyline')!;
      expect(plate.closed).toBe(false);
    }
  });

  it('J9 measured DWG loss (ATTDEF default): the ATTDEF default does not survive, but the ATTRIB value P-100 does', () => {
    for (const sp of INSTANCES) {
      expect(state.blocks[sp.dwgRecord]!.attributes[0]!.default).toBe('');
      const ins = insertAt(state, sp.insertion[0], sp.insertion[1]);
      expect(ins.attributes).toEqual({ TAG1: 'P-100' });
      expect(worldTag(state, ins).text).toBe('P-100');
    }
  });

  it('J9 measured DWG loss (object graph): no object graph is retained on the DWG path on either platform — the native projection is rejected for this DWG', () => {
    // Single shape, MEASURED on both platforms (Linux here; Windows per the lead's
    // probe — VALIDATION.md + windows-evidence/j9-web-probe.json on their side): for
    // THIS DWG, LibreDWG returns compatibility flag 64 for the native read, so the
    // checked native metadata projection is rejected and JCad imports through the
    // fallback reader on Windows exactly as on the Linux WASM path. Unlike
    // N1/Q10/Q13 — whose Windows projections attach — no cadGraph is retained here
    // on either platform, so the associative constraint web is lost with it on the
    // DWG path (the DXF path retains it in full; J1). These assertions are
    // unconditional: if a graph ever appears on this path, this test must FAIL,
    // not branch.
    expect(state.cadGraph).toBeUndefined();
    const items = importReportOf(state)?.items ?? [];
    // The fallback reader's trace of the loss, present on both platforms: the
    // generic XDATA-omission item (its reason names dynamic parameters).
    expect(items.some((i) => i.type === 'XDATA' && i.action === 'unsupported' && i.reason.includes('dynamic parameters'))).toBe(true);
    if (process.platform === 'win32') {
      // win32 only: the rejected projection additionally leaves a CAD_METADATA
      // 'unsupported' item whose reason carries the decoder's compatibility-flags
      // note (the rejection item in convertDwg, src/io/dwg.ts; the flags text is
      // produced by scripts/dwg-native-metadata.mjs when the read reports flags).
      // On Linux the payload carries no native metadata at all, so no such item
      // can exist there (the Q12 recon report contains zero CAD_METADATA items)
      // and nothing is asserted about it off win32.
      const metadataItem = items.find((i) => i.type === 'CAD_METADATA' && i.action === 'unsupported');
      expect(metadataItem).toBeDefined();
      expect(metadataItem!.reason).toContain('compatibility flags 64');
    }
  });

  it('J9 measured DWG invariant (dynamic/constraint state): the unretained web is never decoded into dynamic or constraint state', () => {
    for (const block of Object.values(state.blocks)) {
      expect(block.dynamic).toBeUndefined();
      expect(block.dynamicRetained).toBeUndefined();
    }
    for (const ins of insertsOf(state)) {
      expect(ins.dynamic).toBeUndefined();
      expect(ins.dynamicRetained).toBeUndefined();
    }
    expect((state as { constraints?: unknown }).constraints).toBeUndefined();
    const { cadGraph: _graph, ...model } = state;
    expect(JSON.stringify(model)).not.toContain('Width1');
  });

  it('J6 (INVENTORY) on the DWG path too: setDynamicParameter(\u2018Width1\u2019) refuses all three inserts with input-state identity', () => {
    for (const ins of insertsOf(state)) {
      const result = setDynamicParameter(state, ins.id, PARAMETER_NAME, 140);
      expect(result.problem).toBe('no-dynamic-definition');
      expect(result.state).toBe(state);
    }
  });
});
