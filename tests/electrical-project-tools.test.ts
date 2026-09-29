import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity, InsertEntity, LineEntity, TextEntity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { ALL_SYMBOLS } from '../src/electrical/symbols';
import { breakWire } from '../src/electrical/ladder';
import { DEFAULT_WD_SETTINGS, writeWdSettings } from '../src/electrical/wdm';
import { writeDxf, readDxf } from '../src/io/dxf';
import { assignWireNumbers, planWireNumbers, WIREFIXED_LAYER } from '../src/electrical/wires';
import { retagDrawing, isFixedTag } from '../src/electrical/tags';
import { formatXref } from '../src/electrical/xref';
import { withBlockAttributes, withInsertAttributes } from '../src/electrical/attributes';
import {
  makeSheet,
  buildProjectXref,
  applyProjectXref,
  projectRefText,
  crossSheetFormat,
  xrefProblems,
  planProjectRetag,
  withTags,
  planProjectWireNumbers,
  withWireNumbers,
  locationView,
  locationViewReport,
  sheetCodes,
  recordProjectStatus,
  projectStatus,
  type ProjectSheet,
} from '../src/electrical/project-tools';

const ins = (block: string, x: number, y: number, attrs: Record<string, string>): InsertEntity => ({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x, y }, rotation: 0, scale: 1, attributes: attrs });
const ref = (y: number, t: string): Entity => ({ id: newId(), layer: 'MISC', color: 'ByLayer', type: 'text', position: { x: 0.75, y: y - 0.06 }, text: t, height: 0.125, rotation: 0, align: 'right' });
const wire = (x1: number, y: number, x2: number): LineEntity => ({ id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x: x1, y }, b: { x: x2, y } });

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

/** A drawing with ladder references first..first+n-1 at y = 8, 7, 6 ... and the given rungs. */
function sheetDoc(sheet: string, firstRef: number, rungs: Array<Array<[string, number, Record<string, string>]>>, wd: Partial<typeof DEFAULT_WD_SETTINGS> = {}): Drawing {
  const d = new Drawing();
  d.ensureBlocks(ALL_SYMBOLS);
  writeWdSettings(d, { ...DEFAULT_WD_SETTINGS, sheet, ...wd });
  const ents: Entity[] = [];
  rungs.forEach((r, i) => {
    ents.push(ref(8 - i, String(firstRef + i)), ...rung(8 - i, r));
  });
  d.addEntities(ents);
  return d;
}

const sheetOf = (d: Drawing, name: string, index: number): ProjectSheet => makeSheet(d, { name, path: `/p/${name}`, index });
const xrefTexts = (d: Drawing | { entities: readonly Entity[] }) => d.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === 'XREF').map((e) => e.text);
const find = (d: Drawing, block: string, tag?: string) => d.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === block && (tag === undefined || e.attributes.TAG1 === tag))!;

describe('project-wide cross-reference', () => {
  const project = () => {
    const s1 = sheetDoc('1', 100, [[['HPB11_NO', 3, { TAG1: 'PB100' }], ['HCR1', 8, { TAG1: 'CR100', DESC1: 'RUN' }]], [['HCR1_NO', 3, { TAG1: 'CR100' }], ['HLT1R', 8, { TAG1: 'LT101' }]]], { xrefFormat: '%S.%N' });
    const s3 = sheetDoc('3', 300, [[['HCR1_NO', 3, { TAG1: 'CR100' }], ['HKM1', 8, { TAG1: 'M300' }]], [['HCR1_NC', 3, { TAG1: 'CR100' }], ['HLT1R', 8, { TAG1: 'LT301' }]], [['HCR1_NO', 3, { TAG1: 'CR999' }]]], { xrefFormat: '%S.%N' });
    return [sheetOf(s1, '001.dxf', 0), sheetOf(s3, '003.dxf', 1)];
  };
  it('links a contact on sheet 3 to its coil on sheet 1 and back', () => {
    const sheets = project();
    const entries = buildProjectXref(sheets);
    const cr = entries.find((x) => x.tag === 'CR100')!;
    expect(cr.coil?.sheet.name).toBe('001.dxf');
    expect(cr.contacts.map((c) => `${c.sheet.sheet}.${c.ref}:${c.kind}`)).toEqual(['1.101:NO', '3.300:NO', '3.301:NC']);
    const s3 = applyProjectXref(entries, sheets[1]!);
    const s1 = applyProjectXref(entries, sheets[0]!);
    // contacts on sheet 3 show the coil's sheet / rung
    expect(xrefTexts(s3).filter((t) => t === '1.100')).toHaveLength(2);
    // the coil lists every contact, including those on sheet 3
    expect(xrefTexts(s1)).toEqual(expect.arrayContaining(['1.101', '3.300', '3.301 NC']));
    // XREF attributes are written and defined on the block so DXF keeps them
    const contact = s3.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HCR1_NC')!;
    expect(contact.attributes.XREF).toBe('1.100');
    const coil = s1.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HCR1')!;
    expect(coil.attributes.XREFNO).toBe('1.101,3.300');
    expect(coil.attributes.XREFNC).toBe('3.301');
    const back = readDxf(writeDxf(s1));
    const coil2 = back.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HCR1')!;
    expect(coil2.attributes.XREFNO).toBe('1.101,3.300');
  });
  it('reports unresolved children and duplicate parents', () => {
    const sheets = project();
    const extra = sheetDoc('4', 400, [[['HCR1', 8, { TAG1: 'CR100' }]]]);
    const all = [...sheets, sheetOf(extra, '004.dxf', 2)];
    const problems = xrefProblems(buildProjectXref(all));
    expect(problems.find((p) => p.kind === 'no-parent')).toMatchObject({ tag: 'CR999', sheet: '003.dxf', ref: '302' });
    expect(problems.find((p) => p.kind === 'duplicate-parent')).toMatchObject({ tag: 'CR100', sheet: '004.dxf' });
    const s3 = applyProjectXref(buildProjectXref(all), all[1]!);
    expect(xrefTexts(s3)).toContain('no coil');
  });
  it('uses the same-sheet format on the same sheet and the cross-sheet format elsewhere', () => {
    expect(crossSheetFormat('%N')).toBe('%S.%N');
    expect(crossSheetFormat('%S/%N')).toBe('%S/%N');
    expect(formatXref('105', { xrefFormat: '%I-%L %S.%N', sheet: '2', inst: 'A', loc: 'B' })).toBe('A-B 2.105');
    const s1 = sheetDoc('1', 100, [[['HCR1', 8, { TAG1: 'CR100' }]], [['HCR1_NO', 3, { TAG1: 'CR100' }]]]);
    const s2 = sheetDoc('2', 200, [[['HCR1_NO', 3, { TAG1: 'CR100' }]]]);
    const sheets = [sheetOf(s1, 'a.dxf', 0), sheetOf(s2, 'b.dxf', 1)];
    const x = buildProjectXref(sheets).find((e) => e.tag === 'CR100')!;
    expect(projectRefText(x.contacts[0]!, x.coil!)).toBe('101');
    expect(projectRefText(x.contacts[1]!, x.coil!)).toBe('2.200');
    expect(projectRefText(x.coil!, x.contacts[1]!)).toBe('1.100');
  });
  it('is location aware: codes select the parent and prefix references to other locations', () => {
    const s1 = sheetDoc('1', 100, [[['HCR1', 8, { TAG1: 'CR1', INST: 'MCC1', LOC: 'PNL1' }]], [['HCR1', 8, { TAG1: 'CR1', INST: 'MCC1', LOC: 'PNL2' }]]]);
    const s2 = sheetDoc('2', 200, [[['HCR1_NO', 3, { TAG1: 'CR1', INST: 'MCC1', LOC: 'PNL2' }], ['HLT1R', 8, { TAG1: 'LT1', INST: 'MCC1', LOC: 'DESK' }]], [['HCR1_NC', 3, { TAG1: 'CR1', INST: 'MCC1', LOC: 'DESK' }]]]);
    const sheets = [sheetOf(s1, 'a.dxf', 0), sheetOf(s2, 'b.dxf', 1)];
    const entries = buildProjectXref(sheets);
    const pnl2 = entries.find((e) => e.tag === 'CR1' && e.loc === 'PNL2')!;
    expect(pnl2.coil?.ref).toBe('101');
    expect(pnl2.contacts).toHaveLength(1);
    // a contact in location DESK with no parent there is unresolved (no tag-only fallback when it has codes)
    expect(xrefProblems(entries).some((p) => p.kind === 'no-parent' && p.sheet === 'b.dxf' && p.ref === '201')).toBe(true);
    // the contact in PNL2 is in the same location as its coil: no prefix
    const st = applyProjectXref(entries, sheets[1]!);
    expect(xrefTexts(st)).toContain('1.101');
    // a DESK contact linked to the PNL2 coil (explicit link through the same codes is not possible), so check the prefix helper directly
    const desk = { ...pnl2.contacts[0]!, loc: 'DESK' };
    expect(projectRefText(pnl2.coil!, desk)).toBe('+MCC1-PNL2 1.101');
  });
  it('children without codes fall back to a parent with the same tag', () => {
    const s1 = sheetDoc('1', 100, [[['HCR1', 8, { TAG1: 'CR7', INST: 'MCC1' }]]]);
    const s2 = sheetDoc('2', 200, [[['HCR1_NO', 3, { TAG1: 'CR7' }]]]);
    const x = buildProjectXref([sheetOf(s1, 'a.dxf', 0), sheetOf(s2, 'b.dxf', 1)]).find((e) => e.tag === 'CR7')!;
    expect(x.coil).not.toBeNull();
    expect(x.contacts).toHaveLength(1);
  });
});

describe('project-wide retag', () => {
  it('renumbers with sheet-based tags, keeps fixed tags and carries children across sheets', () => {
    const s1 = sheetDoc('1', 100, [[['HPB11_NO', 3, { TAG1: 'PB1' }], ['HCR1', 8, { TAG1: 'CR5' }]], [['HCR1_NO', 3, { TAG1: 'CR5' }], ['HLT1R', 8, { TAG1: 'LT9', TAGFIXED: '1' }]]], { tagFormat: '%F%N' });
    const s2 = sheetDoc('2', 200, [[['HCR1_NO', 3, { TAG1: 'CR5' }], ['HLT1R', 8, { TAG1: 'LT1' }]]], { tagFormat: '%F%N' });
    const sheets = [sheetOf(s1, 'a.dxf', 0), sheetOf(s2, 'b.dxf', 1)];
    const plan = planProjectRetag(sheets, 'all');
    const a = withTags(s1.snapshot, plan.changes.get(0)!);
    const b = withTags(s2.snapshot, plan.changes.get(1)!);
    const tag = (st: typeof a, block: string) => st.entities.filter((e): e is InsertEntity => e.type === 'insert' && e.block === block).map((e) => e.attributes.TAG1);
    expect(tag(a, 'HPB11_NO')).toEqual(['PB100']);
    expect(tag(a, 'HCR1')).toEqual(['CR100']);
    expect(tag(a, 'HCR1_NO')).toEqual(['CR100']);
    expect(tag(b, 'HCR1_NO')).toEqual(['CR100']); // child on another sheet follows its coil
    expect(tag(a, 'HLT1R')).toEqual(['LT9']); // fixed
    expect(tag(b, 'HLT1R')).toEqual(['LT200']);
    expect(plan.renamed.map((r) => `${r.from}->${r.to}`)).toEqual(expect.arrayContaining(['PB1->PB100', 'CR5->CR100', 'LT1->LT200']));
  });
  it('resolves duplicate tags across drawings in duplicates mode', () => {
    const s1 = sheetDoc('1', 100, [[['HPB11_NO', 3, { TAG1: 'PB100' }], ['HCR1', 8, { TAG1: 'CR100' }]], [['HCR1_NO', 3, { TAG1: 'CR100' }]]]);
    const s2 = sheetDoc('2', 100, [[['HPB11_NO', 3, { TAG1: 'PB100' }], ['HCR1', 8, { TAG1: 'CR100' }]], [['HCR1_NO', 3, { TAG1: 'CR100' }]]]);
    const sheets = [sheetOf(s1, 'a.dxf', 0), sheetOf(s2, 'b.dxf', 1)];
    const plan = planProjectRetag(sheets, 'duplicates');
    expect(plan.changes.get(0)).toBeUndefined();
    const b = withTags(s2.snapshot, plan.changes.get(1)!);
    const tags = b.entities.filter((e): e is InsertEntity => e.type === 'insert' && !!e.attributes.TAG1).map((e) => `${e.block}=${e.attributes.TAG1}`);
    expect(tags).toEqual(expect.arrayContaining(['HPB11_NO=PB100A', 'HCR1=CR100A', 'HCR1_NO=CR100A']));
  });
  it('keeps IEC tags unique per installation / location and marks fixed tags', () => {
    const s1 = sheetDoc('1', 100, [[['HCR1', 8, { TAG1: 'K1', INST: 'A1' }]], [['HCR1', 8, { TAG1: 'K1', INST: 'A2' }]]], { tagMode: 'sequential', tagFormat: '%F%N' });
    const plan = planProjectRetag([sheetOf(s1, 'a.dxf', 0)], 'duplicates');
    expect(plan.count).toBe(0); // same tag in different installations is not a duplicate
    const fixed = ins('HCR1', 0, 0, { TAG1: 'CR1', TAGFIXED: 'Y' });
    expect(isFixedTag(fixed)).toBe(true);
    expect(isFixedTag(ins('HCR1', 0, 0, { TAG1: 'CR1' }))).toBe(false);
  });
  it('single-drawing RETAG keeps fixed tags too', () => {
    const d = sheetDoc('1', 100, [[['HCR1', 8, { TAG1: 'CR100', TAGFIXED: '1' }]], [['HCR1', 8, { TAG1: 'CR7' }]]]);
    retagDrawing(d, DEFAULT_WD_SETTINGS);
    expect(find(d, 'HCR1', 'CR100')).toBeDefined();
    expect(d.entities.filter((e): e is InsertEntity => e.type === 'insert' && e.block === 'HCR1').map((e) => e.attributes.TAG1).sort()).toEqual(['CR100', 'CR101']);
  });
});

describe('project-wide wire numbers', () => {
  const plain = (sheet: string) => {
    const d = new Drawing();
    d.ensureBlocks(ALL_SYMBOLS);
    writeWdSettings(d, { ...DEFAULT_WD_SETTINGS, sheet, wireMode: 'sequential' });
    d.addEntities([wire(1, 8, 5), wire(1, 7, 5), wire(1, 6, 5)]);
    return d;
  };
  it('numbers each sheet from sheet x 100 and keeps numbers unique across drawings', () => {
    const a = plain('1');
    const b = plain('2');
    // a fixed number on sheet 2 that sheet 1 would otherwise use
    b.addEntities([{ id: newId(), type: 'text', layer: WIREFIXED_LAYER, color: 'ByLayer', position: { x: 1.2, y: 6.05 }, text: '101', height: 0.125, rotation: 0, align: 'left' }]);
    const sheets = [sheetOf(a, 'a.dxf', 0), sheetOf(b, 'b.dxf', 1)];
    const plan = planProjectWireNumbers(sheets, { perSheet: true });
    expect(plan.get(0)!.map((t) => t.text)).toEqual(['100', '102', '103']);
    expect(plan.get(1)!.map((t) => t.text)).toEqual(['200', '201']);
    const st = withWireNumbers(b.snapshot, plan.get(1)!);
    expect(st.entities.filter((e) => e.type === 'text' && (e.layer === 'WIRENO' || e.layer === WIREFIXED_LAYER))).toHaveLength(3);
  });
  it('drawing start numbers stay unique project-wide; reference mode gets letter suffixes on repeats', () => {
    const a = plain('1');
    const b = plain('2');
    const plan = planProjectWireNumbers([sheetOf(a, 'a.dxf', 0), sheetOf(b, 'b.dxf', 1)], { perSheet: false });
    const all = [...plan.values()].flat().map((t) => t.text);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual(['100', '101', '102', '103', '104', '105']);
    const r1 = sheetDoc('1', 100, [[['HPB11_NO', 3, { TAG1: 'PB100' }]]]);
    const r2 = sheetDoc('2', 100, [[['HPB11_NO', 3, { TAG1: 'PB200' }]]]);
    const p2 = planProjectWireNumbers([sheetOf(r1, 'a.dxf', 0), sheetOf(r2, 'b.dxf', 1)]);
    expect(p2.get(0)!.map((t) => t.text)).toEqual(['100']);
    expect(p2.get(1)!.map((t) => t.text)).toEqual(['100A']);
  });
  it('planWireNumbers honours %S and the used set; assignWireNumbers still works per drawing', () => {
    const d = plain('4');
    const used = new Set(['4-100']);
    expect(planWireNumbers(d.entities, { format: '%S-%N', sheet: '4', used, mode: 'sequential' }).map((t) => t.text)).toEqual(['4-101', '4-102', '4-103']);
    expect(used.has('4-103')).toBe(true);
    expect(assignWireNumbers(d, 10)).toBe(3);
  });
});

describe('Location View', () => {
  it('groups components by installation / location with counts, drawing and rung', () => {
    const s1 = sheetDoc('1', 100, [[['HPB11_NO', 3, { TAG1: 'PB100', INST: 'MCC1', LOC: 'DESK' }], ['HCR1', 8, { TAG1: 'CR100', INST: 'MCC1', LOC: 'PNL1' }]], [['HCR1_NO', 3, { TAG1: 'CR100', INST: 'MCC1', LOC: 'PNL1' }], ['HLT1R', 8, { TAG1: 'LT101' }]]]);
    const s2 = sheetDoc('2', 200, [[['HT0001', 2, { TERM01: '5', TAGSTRIP: 'TB1', LOC: 'PNL1', INST: 'MCC1', JUMPER: 'J1' }], ['HT0001', 5, { TERM01: '6', TAGSTRIP: 'TB1', LOC: 'PNL1', INST: 'MCC1', JUMPER: 'J1' }]]], { iecInstallation: '', iecLocation: '' });
    const sheets = [sheetOf(s1, 'a.dxf', 0), sheetOf(s2, 'b.dxf', 1)];
    const groups = locationView(sheets, { jumperText: (e) => (e.attributes.JUMPER ? `${e.attributes.JUMPER}` : '') });
    expect(groups.map((g) => `${g.label}:${g.devices}`)).toEqual(['+MCC1-DESK:1', '+MCC1-PNL1:3', '(no location):1']);
    const pnl = groups[1]!;
    expect(pnl.rows.map((r) => `${r.tag}/${r.kind}/${r.drawing}/${r.ref}`)).toEqual(['CR100/device/a.dxf/100', 'CR100/contact/a.dxf/101', 'TB1:5/terminal/b.dxf/200', 'TB1:6/terminal/b.dxf/200']);
    expect(pnl.rows[2]!.jumpers).toBe('J1');
    const r = locationViewReport(groups, '+MCC1-PNL1');
    expect(r.rows).toHaveLength(4);
    expect(r.columns).toContain('Jumpers');
    expect(locationView(sheets, { includeContacts: false })[1]!.rows).toHaveLength(3);
  });
  it('uses the drawing default codes and records Project Manager status', () => {
    const s = sheetDoc('1', 100, [[['HPB11_NO', 3, { TAG1: 'PB100' }]]], { iecInstallation: 'PLANT', iecLocation: 'MCC' });
    const sh = sheetOf(s, 'x.dxf', 0);
    expect(locationView([sh])[0]!.label).toBe('+PLANT-MCC');
    expect(sheetCodes(sh)).toEqual({ inst: ['PLANT'], loc: ['MCC'] });
    recordProjectStatus([sh], []);
    expect(projectStatus.get('/p/x.dxf')).toMatchObject({ inst: ['PLANT'], loc: ['MCC'], xrefIssues: 0 });
  });
});

describe('attribute helpers', () => {
  it('adds invisible attribute definitions so extra insert values reach the DXF', () => {
    const d = new Drawing();
    d.ensureBlocks(ALL_SYMBOLS);
    const t = ins('HT0001', 2, 5, { TERM01: '1' });
    d.addEntities([t]);
    const st = withInsertAttributes(d.snapshot, new Map([[t.id, { JUMPER: 'J4' }]]));
    expect(st.blocks.HT0001!.attributes.find((a) => a.tag === 'JUMPER')?.invisible).toBe(true);
    expect(withBlockAttributes(st, 'HT0001', ['JUMPER'])).toBe(st);
    const back = readDxf(writeDxf(st));
    const t2 = back.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HT0001')!;
    expect(t2.attributes.JUMPER).toBe('J4');
  });
  it('sheet numbers come from the project entry, WD_M or the position', () => {
    const d = new Drawing();
    expect(makeSheet(d, { name: 'a', index: 2 }).sheet).toBe('3');
    expect(makeSheet(d, { name: 'a', index: 2, entrySheet: 'E7' }).settings.sheet).toBe('E7');
    writeWdSettings(d, { ...DEFAULT_WD_SETTINGS, sheet: '12' });
    expect(makeSheet(d, { name: 'a', index: 0 }).sheet).toBe('12');
    expect(makeSheet(d, { name: 'a', index: 0, projectSettings: { tagFormat: '%F%S%N' } }).settings.tagFormat).toBe('%F%S%N');
  });
});
