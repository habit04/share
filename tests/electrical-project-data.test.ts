import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity, InsertEntity, LineEntity, TextEntity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { ALL_SYMBOLS } from '../src/electrical/symbols';
import { breakWire } from '../src/electrical/ladder';
import { assignWireNumbers } from '../src/electrical/wires';
import { writeDxf, readDxf } from '../src/io/dxf';
import { parseDelimited, detectColumns, parsePlcIo, plcRowsToCsv, modulesFromRows, kindOf, addressGroup, rowsFromPlcReport, DEFAULT_PLC_IMPORT } from '../src/electrical/plc-import';
import { buildPlcModule, normalizePlcSettings, DEFAULT_PLC } from '../src/tools/plc';
import { plcIoReport, cableScheduleReport, terminalStripReport, terminalReport, reportToEntities, billOfMaterial, componentReport, REPORTS, withColumns } from '../src/electrical/reports';
import { CABLE_BLOCK, assignCable, cableSchedule, conductorCode, nextCableTag, connectionAt, wireEnds, addJumper, removeJumpers, jumperPartners, jumperText, jumperIds, withTerminalUpdates, isCableMarker } from '../src/electrical/cables';
import { applyTemplate, matchesFilter, upsertTemplate, removeTemplate, findTemplate, describeTemplate } from '../src/electrical/report-templates';
import { parseWdt, formatWdt, DEFAULT_WDT, projectMapping, titleBlockSources, evalSource, mappedValues, applyTitleBlockMapping, titleBlockInserts } from '../src/electrical/titleblock-map';
import { parseProject, serializeProject, titleBlockFields, type Project } from '../src/app/project';
import { newFromTemplate, SHEET_SIZES, TITLE_BLOCK } from '../src/electrical/templates';

const ins = (block: string, x: number, y: number, attrs: Record<string, string>): InsertEntity => ({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x, y }, rotation: 0, scale: 1, attributes: attrs });
const ref = (y: number, t: string): Entity => ({ id: newId(), layer: 'MISC', color: 'ByLayer', type: 'text', position: { x: 0.75, y: y - 0.06 }, text: t, height: 0.125, rotation: 0, align: 'right' });
const wire = (x1: number, y: number, x2: number): LineEntity => ({ id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x: x1, y }, b: { x: x2, y } });
const rail = (x: number, y0: number, y1: number): LineEntity => ({ id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x, y: y0 }, b: { x, y: y1 } });

function rung(y: number, comps: Array<[string, number, Record<string, string>]>, x0 = 1, x1 = 10): Entity[] {
  let pieces: LineEntity[] = [wire(x0, y, x1)];
  const out: Entity[] = [];
  for (const [b, x, attrs] of comps) {
    const target = pieces.find((p) => Math.min(p.a.x, p.b.x) <= x && Math.max(p.a.x, p.b.x) >= x)!;
    pieces = pieces.filter((p) => p !== target).concat(breakWire(target, x - 0.375, x + 0.375));
    out.push(ins(b, x, y, attrs));
  }
  return [...out, ...pieces];
}

describe('PLC I/O spreadsheet import', () => {
  const CSV = [
    'Address,Description 1,Description 2,Desc3,Wire No,Device Tag',
    'I:0/0,"START, MAIN",CONVEYOR,,1000,PB100',
    'I:0/1,STOP,"SAYS ""HALT""",,1001,PB101',
    'O:0/0,MOTOR,RUN,,2000,M200',
    'I:1/0,LEVEL HIGH,,,,LS300',
  ].join('\r\n');
  it('parses quoted CSV and TSV with auto-detected headers', () => {
    expect(parseDelimited('a,"b,c",d\n1,"x\ny",3')).toEqual([['a', 'b,c', 'd'], ['1', 'x\ny', '3']]);
    expect(parseDelimited('a\tb\n1\t2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseDelimited('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(detectColumns(['I/O Address', 'Desc 1', 'Wire Number', 'Component'])).toMatchObject({ address: 0, desc1: 1, wire: 2, device: 3 });
    expect(detectColumns(['Module', 'Address', 'I/O'])).toMatchObject({ module: 0, address: 1, kind: 2 });
    expect(detectColumns(['Foo', 'Bar'])).toBeNull();
    const p = parsePlcIo(CSV);
    expect(p.rows).toHaveLength(4);
    expect(p.rows[0]).toMatchObject({ address: 'I:0/0', desc1: 'START, MAIN', desc2: 'CONVEYOR', wire: '1000', device: 'PB100', kind: 'input', line: 2 });
    expect(p.rows[1]!.desc2).toBe('SAYS "HALT"');
    expect(p.rows[2]!.kind).toBe('output');
    const tsv = parsePlcIo('Address\tDescription\tDevice\n%IX0.0\tSTART\tPB1\n%QX0.0\tLAMP\tLT1\n');
    expect(tsv.rows.map((r) => `${r.address}:${r.kind}:${r.device}`)).toEqual(['%IX0.0:input:PB1', '%QX0.0:output:LT1']);
  });
  it('reads headerless files in the documented column order and flags duplicates', () => {
    const p = parsePlcIo('I:0/0,START,,,100,PB1\nI:0/0,AGAIN\n,NO ADDRESS');
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]).toMatchObject({ address: 'I:0/0', desc1: 'START', wire: '100', device: 'PB1' });
    expect(p.warnings.join(' ')).toMatch(/No header row/);
    expect(p.warnings.join(' ')).toMatch(/appears twice/);
    expect(p.warnings.join(' ')).toMatch(/no address/);
    expect(kindOf('Y0')).toBe('output');
    expect(kindOf('X0')).toBe('input');
    expect(kindOf('N7:0', 'Output')).toBe('output');
    expect(addressGroup('I:0/13')).toBe('I:0/');
    expect(addressGroup('%IX1.7')).toBe('%IX1.');
  });
  it('groups points into modules and builds them with descriptions, wire numbers and rungs', () => {
    const p = parsePlcIo(CSV);
    const mods = modulesFromRows(p.rows, { ...DEFAULT_PLC_IMPORT, pointsPerModule: 16 });
    expect(mods.map((m) => `${m.tag}:${m.kind}:${m.io!.length}`)).toEqual(['PLC1:input:2', 'PLC2:output:1', 'PLC3:input:1']);
    const small = modulesFromRows(p.rows, { ...DEFAULT_PLC_IMPORT, pointsPerModule: 1, firstTag: 'RACK7' });
    expect(small.map((m) => m.tag)).toEqual(['RACK7', 'RACK8', 'RACK9', 'RACK10']);
    const s = normalizePlcSettings({ ...mods[0]!, spacing: 1 });
    expect(s.points).toBe(2);
    const d = new Drawing();
    d.ensureBlocks(ALL_SYMBOLS);
    d.addEntities(buildPlcModule({ x: 5, y: 10 }, s));
    const texts = d.entities.filter((e): e is TextEntity => e.type === 'text');
    expect(texts.filter((t) => t.layer === 'TAGS').map((t) => t.text)).toEqual(['PLC1', 'I:0/0', 'I:0/1']);
    expect(texts.filter((t) => t.layer === 'DESC').map((t) => t.text)).toEqual(expect.arrayContaining(['START, MAIN', 'CONVEYOR', 'STOP']));
    expect(texts.filter((t) => t.layer === 'WIREFIXED').map((t) => t.text)).toEqual(['1000', '1001']);
    // the PLC I/O report reads the point descriptions and the fixed wire numbers back
    const rep = plcIoReport(d);
    expect(rep.rows.map((r) => [r[1], r[2], r[3], r[5]])).toEqual([
      ['I:0/0', 'Input', '1000', 'START, MAIN CONVEYOR'],
      ['I:0/1', 'Input', '1001', 'STOP SAYS "HALT"'],
    ]);
    const back = rowsFromPlcReport(rep.rows);
    expect(back[0]).toMatchObject({ module: 'PLC1', address: 'I:0/0', wire: '1000', kind: 'input' });
    // rungs with the device symbol
    const withRungs = buildPlcModule({ x: 5, y: 10 }, normalizePlcSettings({ ...mods[0]!, spacing: 1, rungs: true, deviceBlock: () => 'HPB11_NO' }));
    const devices = withRungs.filter((e): e is InsertEntity => e.type === 'insert');
    expect(devices.map((e) => `${e.block}:${e.attributes.TAG1}:${e.attributes.DESC1}`)).toEqual(['HPB11_NO:PB100:START, MAIN', 'HPB11_NO:PB101:STOP']);
    expect(devices[0]!.position.x).toBeLessThan(5 - 0.75);
    // the plain module is unchanged
    expect(buildPlcModule({ x: 0, y: 0 }, DEFAULT_PLC).filter((e) => e.type === 'line' && e.layer === 'WIRES')).toHaveLength(8);
  });
  it('exports the table back to CSV that parses to the same rows', () => {
    const p = parsePlcIo(plcRowsToCsv(parsePlcIo(CSV).rows));
    expect(p.warnings).toEqual([]);
    expect(p.rows.map((r) => [r.address, r.kind, r.desc1, r.desc2, r.wire, r.device])).toEqual(parsePlcIo(CSV).rows.map((r) => [r.address, r.kind, r.desc1, r.desc2, r.wire, r.device]));
  });
});

/** Two rungs: PB on the left, terminal and CR coil; wires numbered. */
function cableDoc(): Drawing {
  const d = new Drawing();
  d.ensureBlocks([...ALL_SYMBOLS, CABLE_BLOCK]);
  d.addEntities([
    ref(8, '100'),
    ref(7, '101'),
    rail(1, 8.5, 6.5),
    rail(10, 8.5, 6.5),
    ...rung(8, [
      ['HPB11_NO', 3, { TAG1: 'PB100', X1TERM01: '3', X4TERM02: '4' }],
      ['HT0001', 5, { TERM01: '1', TAGSTRIP: 'X1' }],
      ['HCR1', 8, { TAG1: 'CR100', X1TERM01: 'A1', X4TERM02: 'A2' }],
    ]),
    ...rung(7, [
      ['HT0001', 5, { TERM01: '2', TAGSTRIP: 'X1' }],
      ['HLT1R', 8, { TAG1: 'LT101' }],
    ]),
  ]);
  assignWireNumbers(d, 100);
  return d;
}

describe('cables', () => {
  it('assigns wires to a cable with conductor codes and from / to terminals', () => {
    const d = cableDoc();
    const w1 = d.entities.find((e): e is LineEntity => e.type === 'line' && e.a.y === 8 && Math.min(e.a.x, e.b.x) > 3 && Math.max(e.a.x, e.b.x) < 5)!;
    const w2 = d.entities.find((e): e is LineEntity => e.type === 'line' && e.a.y === 7 && Math.min(e.a.x, e.b.x) > 5 && Math.max(e.a.x, e.b.x) < 8)!;
    expect(connectionAt(d.entities, d.lookupBlock, { x: 3.375, y: 8 })).toBe('PB100:4');
    expect(connectionAt(d.entities, d.lookupBlock, { x: 7.625, y: 8 })).toBe('CR100:A1');
    const ends = wireEnds(d.entities, d.lookupBlock, w1);
    expect(ends).toEqual({ from: 'L1', to: 'L2' }); // the horizontal net runs rail to rail
    expect(nextCableTag(d.entities)).toBe('W1');
    const r = assignCable(d.entities, d.lookupBlock, [w1, w2], { cable: 'W1', type: '3G1.5', scheme: 'iec', first: 1 });
    expect(r.add.map((m) => m.attributes.CONDUCTOR)).toEqual(['BN', 'BK']);
    d.replaceWith(r.remove, r.add);
    expect(nextCableTag(d.entities)).toBe('W2');
    const rows = cableSchedule(d.entities, d.lookupBlock);
    expect(rows.map((x) => [x.cable, x.type, x.conductors, x.conductor, x.wire])).toEqual([
      ['W1', '3G1.5', 2, 'BK', '101'],
      ['W1', '3G1.5', 2, 'BN', '100'],
    ]);
    const rep = cableScheduleReport(d);
    expect(rep.columns).toEqual(['Cable', 'Type', 'Conductors', 'Conductor', 'Wire No.', 'From', 'To', 'Length', 'Rung']);
    expect(rep.rows[0]![7]).toBe(''); // length placeholder
    // re-assigning the same wire replaces its marker and keeps other conductors
    const again = assignCable(d.entities, d.lookupBlock, [w2], { cable: 'W1', type: '3G1.5', scheme: 'numbers', first: 1 });
    expect(again.remove).toHaveLength(1);
    expect(again.add[0]!.attributes.CONDUCTOR).toBe('1');
    expect(conductorCode('nfpa', 0)).toBe('BLK');
    expect(conductorCode('numbers', 2, 5)).toBe('7');
    // markers survive DXF
    const back = readDxf(writeDxf(d.snapshot));
    expect(back.entities.filter(isCableMarker).map((m) => m.attributes.CABLENO)).toEqual(['W1', 'W1']);
    expect(REPORTS.some((x) => x.key === 'cables')).toBe(true);
  });
  it('reads vertical wire ends at component pins', () => {
    const d = new Drawing();
    d.ensureBlocks(ALL_SYMBOLS);
    const a = ins('HPB11_NO', 3, 8, { TAG1: 'PB1', X1TERM01: '3', X4TERM02: '4' });
    const b = ins('HLT1R', 5, 6, { TAG1: 'LT1' });
    const v: LineEntity = { id: newId(), type: 'line', layer: 'WIRES', color: 'ByLayer', a: { x: 3.375, y: 8 }, b: { x: 3.375, y: 6 } };
    d.addEntities([a, b, v]);
    expect(wireEnds(d.entities, d.lookupBlock, v).from).toBe('PB1:4');
  });
});

describe('terminal jumpers', () => {
  it('records a jumper in both terminals, shows it in reports and removes it again', () => {
    const d = cableDoc();
    const [t1, t2] = d.entities.filter((e): e is InsertEntity => e.type === 'insert' && e.block === 'HT0001');
    const r = addJumper(d.entities, t1!, t2!);
    if ('error' in r) throw new Error(r.error);
    expect(r.id).toBe('J1');
    d.transact((s) => withTerminalUpdates(s, r.replace));
    const [a, b] = d.entities.filter((e): e is InsertEntity => e.type === 'insert' && e.block === 'HT0001');
    expect(jumperIds(a!)).toEqual(['J1']);
    expect(jumperPartners(d.entities, a!)).toEqual([{ id: 'J1', partners: ['2'] }]);
    expect(jumperText(b!, d.entities)).toBe('J1>1');
    const again = addJumper(d.entities, a!, b!);
    expect('error' in again && again.error).toMatch(/already/);
    const other = ins('HT0001', 0, 0, { TERM01: '9', TAGSTRIP: 'X2' });
    expect('error' in addJumper(d.entities, a!, other)).toBe(true);
    // reports
    const strip = terminalStripReport(d);
    expect(strip.columns[strip.columns.length - 1]).toBe('Jumper');
    expect(strip.rows.map((row) => row[7])).toEqual(['J1>2', 'J1>1']);
    expect(terminalReport(d).rows.map((row) => row[5])).toEqual(['J1>2', 'J1>1']);
    // the table placed on the drawing draws a bar joining the two rows
    const ents = reportToEntities(strip, { x: 0, y: 0 });
    const plain = reportToEntities(strip, { x: 0, y: 0 }, { jumperBars: false });
    expect(ents.filter((e) => e.type === 'line').length).toBe(plain.filter((e) => e.type === 'line').length + 3);
    // jumpers reach the DXF (JUMPER attribute defined on the terminal block)
    const back = readDxf(writeDxf(d.snapshot));
    expect(back.entities.filter((e): e is InsertEntity => e.type === 'insert' && e.block === 'HT0001').map((e) => e.attributes.JUMPER)).toEqual(['J1', 'J1']);
    // removal clears both ends
    const rep = removeJumpers(d.entities, a!);
    expect(rep).toHaveLength(2);
    d.replaceEntities(rep);
    expect(d.entities.filter((e): e is InsertEntity => e.type === 'insert' && e.block === 'HT0001').every((e) => jumperIds(e).length === 0)).toBe(true);
  });
});

describe('report column configuration and templates', () => {
  it('every report accepts a column list', () => {
    const d = cableDoc();
    for (const def of REPORTS) {
      const full = def.build(d);
      const cols = full.columns.slice(0, 2).reverse();
      const r = def.build(d, cols);
      expect(r.columns).toEqual(cols);
      expect(r.rows.every((row) => row.length === 2)).toBe(true);
    }
    expect(withColumns({ title: 'T', columns: ['A', 'B'], rows: [['1', '2']] }, ['b', 'nope'])).toEqual({ title: 'T', columns: ['B'], rows: [['2']] });
    expect(billOfMaterial(d, []).columns).toHaveLength(6);
  });
  it('applies filters, sort, columns and title', () => {
    const d = cableDoc();
    const r = applyTemplate(componentReport(d), { title: 'Relays and lights', columns: ['Tag', 'Rung'], sort: [{ column: 'Rung', desc: true }, { column: 'Tag' }], filters: [{ column: 'Tag', op: 'notempty' }, { column: 'Block', op: 'not', value: 'HPB' }] });
    expect(r.title).toBe('Relays and lights');
    expect(r.columns).toEqual(['Tag', 'Rung']);
    expect(r.rows.map((x) => x[0])).toEqual(['2', 'LT101', '1', 'CR100']);
    expect(matchesFilter('ABC', { column: 'x', op: 'starts', value: 'ab' })).toBe(true);
    expect(matchesFilter('', { column: 'x', op: 'empty' })).toBe(true);
    expect(matchesFilter('x', { column: 'x', op: 'equals', value: 'X' })).toBe(true);
  });
  it('stores templates in the project file (backward compatible)', () => {
    let p: Project = parseProject('{"name":"P","drawings":[{"file":"a.dxf"}]}');
    expect(p.reportTemplates).toBeUndefined();
    expect(serializeProject(p)).not.toMatch(/reportTemplates|titleBlockMap/);
    p = upsertTemplate(p, { name: 'Relays', report: 'components', columns: ['Tag'], sort: [{ column: 'Tag', desc: true }], filters: [{ column: 'Block', op: 'starts', value: 'HCR' }], output: 'csv', projectWide: true });
    p = upsertTemplate(p, { name: 'relays', report: 'bom' });
    expect(p.reportTemplates).toHaveLength(1);
    p = upsertTemplate(p, { name: 'Cables', report: 'cables', output: 'table' });
    const back = parseProject(serializeProject({ ...p, titleBlockMap: 'CLIENT = LINE2', drawings: [{ file: 'a.dxf', rev: 'B', date: '2026-01-02' }] }));
    expect(back.reportTemplates?.map((t) => t.name)).toEqual(['Cables', 'relays']);
    expect(findTemplate(back, 'CABLES')?.output).toBe('table');
    expect(back.titleBlockMap).toBe('CLIENT = LINE2');
    expect(back.drawings[0]).toMatchObject({ rev: 'B', date: '2026-01-02' });
    expect(describeTemplate(findTemplate(back, 'relays')!)).toMatch(/bom/);
    expect(removeTemplate(back, 'cables').reportTemplates).toHaveLength(1);
    // malformed entries are dropped
    const bad = parseProject('{"name":"P","drawings":[],"reportTemplates":[{"name":"x"},{"name":"ok","report":"bom","filters":[{"column":"A","op":"bogus"},{"column":"B","op":"equals","value":"1"}],"sort":[{"column":"A","desc":true},{"x":1}]},7]}');
    expect(bad.reportTemplates).toEqual([{ name: 'ok', report: 'bom', filters: [{ column: 'B', op: 'equals', value: '1' }], sort: [{ column: 'A', desc: true }] }]);
  });
});

describe('title block mapping (.wdt)', () => {
  const project = (): Project =>
    parseProject(JSON.stringify({ name: 'Line 1', description: 'PACKAGING LINE', descriptions: ['ACME PLANT', 'CUSTOMER X', 'JOB 42', 'JD'], drawings: [{ file: '001.dxf', description: 'POWER', dwgno: 'E-001', rev: 'C', date: '2026-03-04' }, { file: '002.dxf', description: 'CONTROL' }] }), '/proj/l.jcadproj.json');
  it('parses and writes the .wdt text format', () => {
    const m = parseWdt('; comment\nBLOCK = TB_A, TB_B\nclient = LINE2\nTITLE = DWGDESC|PROJDESC\nSHEET = %SHEET% OF %SHEETMAX%\nBY = "JCAD"\nnonsense\nCLIENT = LINE3\n');
    expect(m.blocks).toEqual(['TB_A', 'TB_B']);
    expect(m.entries).toEqual([
      { attribute: 'CLIENT', source: 'LINE3' },
      { attribute: 'TITLE', source: 'DWGDESC|PROJDESC' },
      { attribute: 'SHEET', source: '%SHEET% OF %SHEETMAX%' },
      { attribute: 'BY', source: '"JCAD"' },
    ]);
    expect(parseWdt(formatWdt(m))).toEqual(m);
    expect(projectMapping({}).entries.length).toBe(parseWdt(DEFAULT_WDT).entries.length);
    expect(projectMapping({ titleBlockMap: '; nothing' }).entries.length).toBeGreaterThan(0);
  });
  it('evaluates sources from project lines and drawing properties', () => {
    const p = project();
    const v = titleBlockSources(p, 0, undefined, '', '2026-09-29');
    expect(v).toMatchObject({ LINE1: 'ACME PLANT', CUSTOMER: 'CUSTOMER X', PROJ: 'Line 1', DWGDESC: 'POWER', DWGNO: 'E-001', SHEET: '1', SHEETMAX: '2', REV: 'C', DATE: '2026-03-04', FILENAME: '001' });
    expect(titleBlockSources(p, 1, undefined, '', '2026-09-29').DATE).toBe('2026-09-29');
    expect(evalSource('LINE9|PROJDESC', v)).toBe('PACKAGING LINE');
    expect(evalSource('%SHEET% OF %SHEETMAX%', v)).toBe('1 OF 2');
    expect(evalSource('%LINE9%', v)).toBe('');
    expect(evalSource('"FIXED"', v)).toBe('FIXED');
    // the built-in mapping gives the same fields as titleBlockFields()
    const mapped = mappedValues(projectMapping(p), titleBlockSources(p, 1));
    const classic = titleBlockFields(p, 1);
    for (const k of ['PROJECT', 'CUSTOMER', 'JOB', 'DRAWN', 'TITLE', 'SHEET', 'DWGNO', 'DATE']) expect(mapped[k], k).toBe(classic[k]);
  });
  it('writes mapped values into the title block of a drawing (only defined attributes, empty values never clear)', () => {
    const p = { ...project(), titleBlockMap: 'PROJECT = LINE2\nTITLE = DWGDESC\nREV = REV\nDRAWN = LINE9\nNOTDEFINED = PROJ\n' };
    const d = new Drawing();
    d.load(newFromTemplate(SHEET_SIZES[0]!, { DRAWN: 'BY HAND' }));
    const m = projectMapping(p);
    expect(titleBlockInserts(d.snapshot, m)).toHaveLength(1);
    const r = applyTitleBlockMapping(d.snapshot, m, titleBlockSources(p, 0));
    expect(r).toMatchObject({ found: 1, changed: 1 });
    const tb = r.state.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === TITLE_BLOCK.name)!;
    expect(tb.attributes).toMatchObject({ PROJECT: 'CUSTOMER X', TITLE: 'POWER', REV: 'C', DRAWN: 'BY HAND' });
    expect(tb.attributes.NOTDEFINED).toBeUndefined();
    expect(applyTitleBlockMapping(r.state, m, titleBlockSources(p, 0)).changed).toBe(0);
    // a user title block named with BLOCK =
    const custom = new Drawing();
    custom.defineBlock({ name: 'MY_TB', basePoint: { x: 0, y: 0 }, entities: [], attributes: [{ tag: 'CLIENT', prompt: 'c', default: '', position: { x: 0, y: 0 }, height: 0.1, align: 'left' }] });
    custom.addEntities([ins('MY_TB', 0, 0, { CLIENT: '' })]);
    const r2 = applyTitleBlockMapping(custom.snapshot, parseWdt('BLOCK = MY_TB\nCLIENT = LINE2'), titleBlockSources(p, 0));
    expect(r2.changed).toBe(1);
    expect(applyTitleBlockMapping(new Drawing().snapshot, m, {}).found).toBe(0);
  });
});
