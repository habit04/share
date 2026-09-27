import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity, InsertEntity, LineEntity, TextEntity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { ALL_SYMBOLS } from '../src/electrical/symbols';
import { breakWire } from '../src/electrical/ladder';
import { assignWireNumbers } from '../src/electrical/wires';
import { footprintSpec, footprintBlock, schematicList, makeFootprint, nextItemNumber, itemNumberFor, makeBalloon, makeNameplate, splitDescription, terminalStripTable, applyTerminalEdits, panelRows, BALLOON_BLOCK, NAMEPLATE_BLOCK } from '../src/electrical/panel';
import { buildMotorCircuit, makeTagger, DEFAULT_CIRCUIT, CIRCUIT_KINDS } from '../src/electrical/circuits';
import { auditIssues, auditSummary } from '../src/electrical/audit';
import { plcIoReport, wireLabelReport, missingCatalogReport, terminalStripReport, panelReport, reportToEntities, mergeReports, electricalAudit, REPORTS, billOfMaterial, wireFromToReport } from '../src/electrical/reports';
import { buildPlcModule, DEFAULT_PLC, signalReference } from '../src/tools/plc';
import { parseProject, serializeProject, titleBlockFields, projectDrawingIndex, resolveProjectPath } from '../src/app/project';
import { newFromTemplate, SHEET_SIZES, TITLE_BLOCK, updateTitleBlock } from '../src/electrical/templates';
import { DEFAULT_WD_SETTINGS, writeWdSettings } from '../src/electrical/wdm';
import { isChild, isParentComponent } from '../src/electrical/families';
import { writeDxf, readDxf } from '../src/io/dxf';

const ins = (block: string, x: number, y: number, attrs: Record<string, string>): InsertEntity => ({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x, y }, rotation: 0, scale: 1, attributes: attrs });
const ref = (y: number, t: string): Entity => ({ id: newId(), layer: 'MISC', color: 'ByLayer', type: 'text', position: { x: 0.75, y: y - 0.06 }, text: t, height: 0.125, rotation: 0, align: 'right' });
const wire = (x1: number, y: number, x2: number, layer = 'WIRES'): LineEntity => ({ id: newId(), layer, color: 'ByLayer', type: 'line', a: { x: x1, y }, b: { x: x2, y } });
const rail = (x: number, y0: number, y1: number): LineEntity => ({ id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x, y: y0 }, b: { x, y: y1 } });

/** A rung from x0 to x1 with components at the given x positions (wire broken +-0.375 around each). */
function rung(y: number, comps: Array<[string, number, Record<string, string>]>, x0 = 1, x1 = 10, layer = 'WIRES'): Entity[] {
  let pieces: LineEntity[] = [wire(x0, y, x1, layer)];
  const out: Entity[] = [];
  for (const [b, x, attrs] of comps) {
    const target = pieces.find((p) => Math.min(p.a.x, p.b.x) <= x && Math.max(p.a.x, p.b.x) >= x)!;
    pieces = pieces.filter((p) => p !== target).concat(breakWire(target, x - 0.375, x + 0.375));
    out.push(ins(b, x, y, attrs));
  }
  return [...out, ...pieces];
}

function schematic(): Drawing {
  const d = new Drawing();
  d.ensureBlocks(ALL_SYMBOLS);
  d.addEntities([
    ref(8, '100'),
    ref(7, '101'),
    ref(6, '102'),
    rail(1, 8.5, 5.5),
    rail(10, 8.5, 5.5),
    ...rung(8, [
      ['HPB12_NC', 3, { TAG1: 'PB100', DESC1: 'STOP', MFG: 'SWITCHCO', CAT: 'SP22-FR-1NC', INST: 'MCC1', LOC: 'PNL1' }],
      ['HCR1', 8, { TAG1: 'CR100', DESC1: 'MOTOR RUN CONTROL RELAY', MFG: 'RELIACO', CAT: 'RC-4PDT-120A' }],
    ]),
    ...rung(7, [
      ['HCR1_NO', 3, { TAG1: 'CR100' }],
      ['HLT1R', 8, { TAG1: 'LT101', DESC1: 'RUNNING' }],
    ]),
    ...rung(6, [
      ['HT0001', 2, { TERM01: '5', TAGSTRIP: 'TB1' }],
      ['HPLCI', 8, { TAG1: 'I:0/3', DESC1: 'GATE CLOSED' }],
    ]),
  ]);
  assignWireNumbers(d, 100);
  return d;
}

describe('panel layout', () => {
  it('sizes footprints per family and builds blocks with P_ attributes', () => {
    expect(footprintSpec('PB').width).toBeCloseTo(0.9);
    expect(footprintSpec('KM').family).toBe('M');
    expect(footprintSpec('ZZZ').width).toBe(1);
    const b = footprintBlock('CR');
    expect(b.name).toBe('WD_FP_CR');
    const tags = b.attributes.map((a) => a.tag);
    expect(tags).toEqual(expect.arrayContaining(['P_TAG1', 'P_ITEM', 'P_DESC1', 'P_MFG', 'P_CAT']));
    expect(b.attributes.find((a) => a.tag === 'P_MFG')?.invisible).toBe(true);
    expect(b.entities.some((e) => e.type === 'circle')).toBe(true);
  });
  it('lists schematic components with placement status and inserts footprints', () => {
    const s = schematic();
    const panel = new Drawing();
    panel.ensureBlocks([footprintBlock('PB'), BALLOON_BLOCK, NAMEPLATE_BLOCK]);
    let rows = schematicList([{ name: 'sch.dxf', entities: s.entities }], panel.entities);
    expect(rows.map((r) => r.tag)).toEqual(['CR100', 'I:0/3', 'LT101', 'PB100', 'TB1:5']);
    expect(rows.every((r) => !r.placed)).toBe(true);
    const pb = rows.find((r) => r.tag === 'PB100')!;
    expect(pb.family).toBe('PB');
    expect(pb.ref).toBe('100');
    const item = String(nextItemNumber(panel.entities));
    expect(item).toBe('1');
    const fp = makeFootprint(pb, { x: 2, y: 2 }, item);
    panel.addEntities([fp]);
    expect(fp.block).toBe('WD_FP_PB');
    expect(fp.attributes).toMatchObject({ P_TAG1: 'PB100', P_ITEM: '1', P_DESC1: 'STOP', P_MFG: 'SWITCHCO', P_CAT: 'SP22-FR-1NC', P_INST: 'MCC1', P_LOC: 'PNL1' });
    rows = schematicList([{ name: 'sch.dxf', entities: s.entities }], panel.entities);
    expect(rows.find((r) => r.tag === 'PB100')!.placed).toBe(true);
    expect(itemNumberFor(panel.entities, 'PB100')).toBe('1');
    expect(nextItemNumber(panel.entities)).toBe(2);
    const balloon = makeBalloon(fp, { x: 3, y: 3 }, '1', panel.lookupBlock);
    expect(balloon.map((e) => e.type)).toEqual(['line', 'insert']);
    expect((balloon[1] as InsertEntity).attributes.ITEM).toBe('1');
    const np = makeNameplate({ x: 0, y: 0 }, 'CR100', 'MOTOR RUN CONTROL RELAY');
    expect(np.attributes.NP_DESC1).toBe('MOTOR RUN CONTROL');
    expect(np.attributes.NP_DESC2).toBe('RELAY');
    expect(splitDescription('SHORT')).toEqual(['SHORT', '']);
    const pr = panelRows(panel.entities);
    expect(pr[0]).toMatchObject({ item: '1', tag: 'PB100', loc: '+MCC1-PNL1' });
    // footprints survive DXF with their attributes
    const back = readDxf(writeDxf(panel.snapshot));
    const fp2 = back.entities.find((e) => e.type === 'insert' && e.block === 'WD_FP_PB');
    expect(fp2?.type === 'insert' && fp2.attributes.P_TAG1).toBe('PB100');
  });
  it('builds the terminal strip table with wires and devices on both sides', () => {
    const s = schematic();
    const rows = terminalStripTable(s.entities, s.lookupBlock);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ strip: 'TB1', number: '5', leftDevice: 'L1', leftWire: '102', rightWire: '102', rightDevice: 'I:0/3', ref: '102' }); // terminals pass the wire number through
    const edited = [{ ...rows[0]!, number: '7', strip: 'TB2' }];
    const rep = applyTerminalEdits(s.entities, edited);
    expect(rep).toHaveLength(1);
    expect(rep[0]!.attributes).toMatchObject({ TERM01: '7', TAGSTRIP: 'TB2' });
    expect(applyTerminalEdits(s.entities, rows)).toHaveLength(0);
    const r = terminalStripReport(s);
    expect(r.rows[0]![1]).toBe('5');
  });
});

describe('circuit builder', () => {
  const settings = DEFAULT_WD_SETTINGS;
  it('builds a start/stop circuit with seal-in contact, tags and a ladder', () => {
    const d = new Drawing();
    d.ensureBlocks(ALL_SYMBOLS);
    const refOf = (y: number) => String(100 + Math.round((8 - y) / 1));
    const ents = buildMotorCircuit({ ...DEFAULT_CIRCUIT, left: 1, right: 10, top: 8, spacing: 1, drawLadder: true }, makeTagger(d, settings, refOf));
    d.addEntities(ents);
    const inserts = ents.filter((e): e is InsertEntity => e.type === 'insert' && e.block !== 'WDDOT');
    const tags = inserts.map((e) => `${e.block}:${e.attributes.TAG1}`);
    expect(tags).toContain('HPB12_NC:PB100');
    expect(tags).toContain('HPB11_NO:PB100A');
    expect(tags).toContain('HKM1:M100');
    // the seal-in and run-light contacts are children of M100
    expect(tags.filter((t) => t === 'HKM1_NO:M100')).toHaveLength(2);
    expect(tags).toContain('HLT1G:LT101');
    expect(inserts.filter(isChild).every((c) => c.attributes.TAG1 === 'M100')).toBe(true);
    expect(ents.filter((e) => e.type === 'insert' && e.block === 'WDDOT')).toHaveLength(2);
    expect(ents.filter((e) => e.type === 'text' && e.layer === 'MISC').map((e) => (e as TextEntity).text)).toEqual(['100', '101']);
    // wires are broken around every component (no wire crosses a symbol)
    for (const c of inserts) {
      const crossing = ents.filter((e): e is LineEntity => e.type === 'line' && e.layer === 'WIRES' && e.a.y === e.b.y && e.a.y === c.position.y && Math.min(e.a.x, e.b.x) < c.position.x && Math.max(e.a.x, e.b.x) > c.position.x);
      expect(crossing, `wire crosses ${c.attributes.TAG1}`).toHaveLength(0);
    }
    expect(assignWireNumbers(d, 100)).toBeGreaterThanOrEqual(3);
    const issues = auditIssues(d).filter((i) => i.severity === 'error');
    expect(issues).toHaveLength(0);
  });
  it('reversing and jog circuits link contacts to the right parents', () => {
    const d = new Drawing();
    d.ensureBlocks(ALL_SYMBOLS);
    const rev = buildMotorCircuit({ ...DEFAULT_CIRCUIT, kind: 'reversing', drawLadder: true }, makeTagger(d, settings, () => null));
    const rInserts = rev.filter((e): e is InsertEntity => e.type === 'insert' && e.block !== 'WDDOT');
    const coils = rInserts.filter((e) => e.block === 'HKM1').map((e) => e.attributes.TAG1);
    expect(coils).toEqual(['M1', 'M2']);
    const ncTags = rInserts.filter((e) => e.block === 'HKM1_NC').map((e) => e.attributes.TAG1).sort();
    expect(ncTags).toEqual(['M1', 'M2']);
    expect(rInserts.every((e) => e.attributes.TAG1 !== '')).toBe(true);
    const jog = buildMotorCircuit({ ...DEFAULT_CIRCUIT, kind: 'jog', standard: 'IEC', drawLadder: false }, makeTagger(d, settings, () => null));
    const jInserts = jog.filter((e): e is InsertEntity => e.type === 'insert' && e.block !== 'WDDOT');
    expect(jInserts.some((e) => e.block === 'IEC_K_COIL')).toBe(true);
    expect(jInserts.filter((e) => e.block === 'IEC_K_NO').every((e) => e.attributes.TAG1 === 'K1')).toBe(true);
    expect(jInserts.filter((e) => e.block === 'IEC_S_PB_NO').map((e) => e.attributes.DESC1).sort()).toEqual(['JOG', 'START']);
    expect(CIRCUIT_KINDS.map((k) => k.kind)).toEqual(['start-stop', 'reversing', 'jog']);
  });
});

describe('audit', () => {
  it('finds structural problems with positions for jump-to', () => {
    const d = schematic();
    d.addEntities([
      ins('HCR1_NO', 5, 7, { TAG1: 'CR999' }), // orphan, off wire
      ins('HLT1R', 6, 8, { TAG1: 'PB100' }), // duplicate tag, off wire
      wire(12, 3, 14), // dangling both ends, unnumbered
      { id: newId(), type: 'text', layer: 'WIRENO', color: 'ByLayer', position: { x: 12.15, y: 3.05 }, text: '100', height: 0.125, rotation: 0, align: 'left' } as TextEntity,
    ]);
    const issues = auditIssues(d);
    const checks = new Set(issues.map((i) => i.check));
    expect(checks).toContain('Duplicate tag');
    expect(checks).toContain('Contact without coil');
    expect(checks).toContain('Dangling wire');
    expect(checks).toContain('Duplicate wire number');
    expect(checks).toContain('Missing catalog data');
    expect(checks).toContain('Component not on a wire');
    expect(checks).not.toContain('Unnumbered wire');
    expect(issues.every((i) => i.position && i.entityId)).toBe(true);
    const dup = issues.find((i) => i.check === 'Duplicate tag')!;
    expect(dup.severity).toBe('error');
    const s = auditSummary(issues);
    expect(s.errors).toBeGreaterThan(0);
    // errors are listed first
    expect(issues[0]!.severity).toBe('error');
    const report = electricalAudit(d);
    expect(report.columns).toEqual(['Check', 'Item', 'Detail', 'Severity']);
  });
  it('a clean schematic has no errors and components on wires are not flagged', () => {
    const d = schematic();
    const issues = auditIssues(d);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
    expect(issues.filter((i) => i.check === 'Component not on a wire')).toHaveLength(0);
    expect(issues.some((i) => i.check === 'Missing catalog data' && i.item === 'LT101')).toBe(true);
    expect(issues.some((i) => i.check === 'Missing catalog data' && i.item === 'PB100')).toBe(false);
  });
});

describe('reports', () => {
  it('PLC I/O report lists module addresses and PLC point symbols with wires and devices', () => {
    const d = schematic();
    d.addEntities(buildPlcModule({ x: 12, y: 10 }, { ...DEFAULT_PLC, tag: 'PLC1', points: 2 }));
    // a device on the first module input wire
    d.addEntities([...rung(9.5, [['HLS11_NO', 10.5, { TAG1: 'LS200', DESC1: 'DOOR' }]], 9.5, 11.25)]);
    assignWireNumbers(d, 100);
    const r = plcIoReport(d);
    const mod = r.rows.filter((row) => row[0] === 'PLC1');
    expect(mod.map((row) => row[1])).toEqual(['I:0/0', 'I:0/1']);
    expect(mod[0]![2]).toBe('Input');
    expect(mod[0]![4]).toBe('LS200');
    expect(mod[0]![5]).toBe('DOOR');
    expect(mod[0]![3]).not.toBe('');
    const point = r.rows.find((row) => row[1] === 'I:0/3')!;
    expect(point[2]).toBe('Input');
    expect(point[5]).toBe('GATE CLOSED');
    expect(point[6]).toBe('102');
  });
  it('wire label and missing catalog reports', () => {
    const d = schematic();
    const labels = wireLabelReport(d);
    const w100 = labels.rows.find((r) => r[0] === '100')!;
    expect(w100[1]).toBe('WIRES');
    expect(w100[2]).toContain('16 AWG');
    expect(w100[4]).toContain('L1');
    expect(w100[4]).toContain('PB100');
    expect(parseFloat(w100[5]!)).toBeGreaterThan(0);
    const missing = missingCatalogReport(d);
    expect(missing.rows.map((r) => r[0])).toEqual(['I:0/3', 'LT101']);
    expect(missing.rows[1]![4]).toBe('MFG, CAT');
    const bom = billOfMaterial(d);
    expect(bom.rows.some((r) => r[2] === 'RC-4PDT-120A' && r[5] === 'CR100')).toBe(true);
    const ft = wireFromToReport(d);
    expect(ft.rows.find((r) => r[0] === '101')!.slice(1, 3)).toEqual(['L1', 'CR100']);
    expect(REPORTS.map((r) => r.key)).toEqual(expect.arrayContaining(['labels', 'plc', 'missing', 'strip', 'panel']));
    expect(panelReport(d).rows).toHaveLength(0);
  });
  it('merges project-wide reports and puts a report on the drawing as a table', () => {
    const a = schematic();
    const merged = mergeReports([{ drawing: 'a.dxf', report: billOfMaterial(a) }, { drawing: 'b.dxf', report: billOfMaterial(a) }]);
    expect(merged.columns[0]).toBe('Drawing');
    expect(merged.rows.length).toBe(billOfMaterial(a).rows.length * 2);
    expect(merged.rows[0]![0]).toBe('a.dxf');
    const ents = reportToEntities({ title: 'T', columns: ['A', 'B'], rows: [['1', 'x'], ['2', 'y']] }, { x: 0, y: 10 }, { layer: 'REPORT' });
    const texts = ents.filter((e): e is TextEntity => e.type === 'text');
    expect(texts.map((t) => t.text)).toEqual(['T', 'A', 'B', '1', 'x', '2', 'y']);
    expect(ents.filter((e) => e.type === 'line').length).toBeGreaterThanOrEqual(7);
    expect(ents.every((e) => e.layer === 'REPORT')).toBe(true);
    expect(Math.max(...texts.map((t) => t.position.y))).toBeGreaterThan(10);
    expect(Math.min(...texts.map((t) => t.position.y))).toBeLessThan(10);
  });
  it('signal arrow references use sheet / rung', () => {
    const d = schematic();
    expect(signalReference(d, { x: 5, y: 7 })).toBe('1/101');
    writeWdSettings(d, { ...DEFAULT_WD_SETTINGS, sheet: '4' });
    expect(signalReference(d, { x: 5, y: 8 })).toBe('4/100');
    expect(signalReference(d, { x: 5, y: 1 })).toBe('5.0,1.0');
  });
});

describe('project and title block', () => {
  it('parses settings and description lines, resolves catalog paths', () => {
    const p = parseProject('{"name":"Line 1","descriptions":["ACME PLANT","CUSTOMER X"],"settings":{"catalogFile":"parts.json","tagMode":"sequential","installation":"MCC1"},"drawings":[{"file":"001.dxf","description":"POWER","sheet":"1","dwgno":"E-001"},{"file":"002.dxf"}]}', '/proj/line1.jcadproj.json');
    expect(p.settings).toMatchObject({ catalogFile: 'parts.json', tagMode: 'sequential', installation: 'MCC1' });
    expect(p.descriptions).toEqual(['ACME PLANT', 'CUSTOMER X']);
    expect(p.drawings[0]).toMatchObject({ dwgno: 'E-001', sheet: '1' });
    expect(resolveProjectPath(p, 'parts.json')).toBe('/proj/parts.json');
    const again = parseProject(serializeProject(p));
    expect(again.settings?.catalogFile).toBe('parts.json');
    expect(again.descriptions).toEqual(['ACME PLANT', 'CUSTOMER X']);
    expect(projectDrawingIndex(p, '/proj/002.dxf')).toBe(1);
    expect(projectDrawingIndex(p, '/elsewhere/002.dxf')).toBe(1);
    expect(projectDrawingIndex(p, null)).toBe(-1);
  });
  it('fills title block fields from project + drawing and writes them into the sheet', () => {
    const p = parseProject('{"name":"Line 1","descriptions":["ACME PLANT","CUSTOMER X","JOB 42"],"drawings":[{"file":"001.dxf","description":"POWER","dwgno":"E-001"},{"file":"002.dxf","description":"CONTROL"}]}', '/proj/l.jcadproj.json');
    const f = titleBlockFields(p, 1);
    expect(f).toMatchObject({ PROJECT: 'ACME PLANT', CUSTOMER: 'CUSTOMER X', JOB: 'JOB 42', TITLE: 'CONTROL', SHEET: '2 OF 2', DWGNO: '002' });
    expect(titleBlockFields(p, -1, 'FALLBACK').TITLE).toBe('FALLBACK');
    const d = new Drawing();
    d.load(newFromTemplate(SHEET_SIZES[0]!, {}));
    expect(updateTitleBlock(d, f)).toBe(true);
    const tb = d.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === TITLE_BLOCK.name)!;
    expect(tb.attributes.TITLE).toBe('CONTROL');
    expect(tb.attributes.SHEET).toBe('2 OF 2');
    expect(tb.attributes.CUSTOMER).toBeUndefined(); // not an attribute of this title block
    expect(updateTitleBlock(new Drawing(), f)).toBe(false);
    expect(isParentComponent(tb)).toBe(false);
  });
});
