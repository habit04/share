import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity, InsertEntity, LineEntity, TextEntity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { ALL_SYMBOLS, findSymbol, tagPrefix } from '../src/electrical/symbols';
import { IEC_SYMBOLS } from '../src/electrical/iec';
import { connectionPoints, acadeAttributes, withAcadeAttributes, descriptionOf, instLoc } from '../src/electrical/attributes';
import { DEFAULT_WD_SETTINGS, readWdSettings, writeWdSettings, findWdM, settingsFromAttributes, attributesFromSettings } from '../src/electrical/wdm';
import { formatTag, letterSuffix, nextTag, usedTags, usedTagsOfFamily, retagDrawing } from '../src/electrical/tags';
import { searchCatalog, findCatalogItem, parseCatalog, BUILTIN_CATALOG, catalogFamilies, catalogFamilyFor } from '../src/electrical/catalog';
import { toggleVariant, isChild, isParentComponent, isCoil } from '../src/electrical/families';
import { buildXref, contactSummary, contactTable, parentCandidates, childAttributes, childBlockFor, updateCrossReferences, formatXref } from '../src/electrical/xref';
import { breakWire, wireDot } from '../src/electrical/ladder';
import { writeDxf, readDxf } from '../src/io/dxf';

const ins = (block: string, x: number, y: number, attrs: Record<string, string>): InsertEntity => ({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x, y }, rotation: 0, scale: 1, attributes: attrs });
const ref = (y: number, t: string): Entity => ({ id: newId(), layer: 'MISC', color: 'ByLayer', type: 'text', position: { x: 0.75, y: y - 0.06 }, text: t, height: 0.125, rotation: 0, align: 'right' });
const wire = (x1: number, y: number, x2: number): LineEntity => ({ id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x: x1, y }, b: { x: x2, y } });

describe('ACADE attribute model', () => {
  it('every symbol carries the data and X?TERM wire-connection attributes', () => {
    for (const s of [...ALL_SYMBOLS, ...IEC_SYMBOLS]) {
      if (s.name === 'WDDOT') continue;
      const tags = s.attributes.map((a) => a.tag);
      expect(tags.some((t) => /^X[1248]TERM\d\d$/.test(t)), `${s.name} has no wire connection attribute`).toBe(true);
      if (tags.includes('TAG1')) for (const t of ['INST', 'LOC', 'MFG', 'CAT', 'ASSYCODE', 'RATING1', 'WDTYPE', 'DESC2', 'DESC3']) expect(tags, `${s.name} lacks ${t}`).toContain(t);
      for (const a of s.attributes) if (/^(INST|LOC|MFG|CAT|X\dTERM)/.test(a.tag)) expect(a.invisible, `${a.tag} on ${s.name} should be invisible`).toBe(true);
    }
  });
  it('derives connection points from the symbol geometry', () => {
    const pts = connectionPoints(findSymbol('HCR1_NO')!);
    expect(pts.map((p) => p.tag)).toEqual(['X1TERM01', 'X4TERM02']);
    expect(pts[0]!.point.x).toBeCloseTo(-0.375);
    expect(connectionPoints(findSymbol('HCB3')!)).toHaveLength(6);
    expect(connectionPoints(findSymbol('HGND')!).map((p) => p.tag)).toEqual(['X2TERM01']);
    expect(connectionPoints(findSymbol('HPLCI')!).map((p) => p.tag)).toEqual(['X1TERM01']);
    expect(connectionPoints(findSymbol('HXF1')!)).toHaveLength(4);
  });
  it('gives contacts their conventional pin numbers and the terminal a TAGSTRIP', () => {
    const nc = findSymbol('HCR1_NC')!;
    expect(nc.attributes.find((a) => a.tag === 'X1TERM01')!.default).toBe('11');
    expect(nc.attributes.find((a) => a.tag === 'X4TERM02')!.default).toBe('12');
    expect(findSymbol('HCR1')!.attributes.find((a) => a.tag === 'WDTYPE')!.default).toBe('COIL');
    expect(findSymbol('HT0001')!.attributes.some((a) => a.tag === 'TAGSTRIP')).toBe(true);
    expect(acadeAttributes(findSymbol('HCR1')!, 'CR').every((a) => !findSymbol('HCR1')!.attributes.slice(0, 2).some((b) => b.tag === a.tag))).toBe(true);
    const twice = withAcadeAttributes(findSymbol('HCR1')!, 'CR');
    expect(twice.attributes).toHaveLength(findSymbol('HCR1')!.attributes.length);
  });
  it('exports all attributes to DXF and reads them back', () => {
    const d = new Drawing();
    d.ensureBlocks(ALL_SYMBOLS);
    d.addEntities([ins('HPB11_NO', 3, 8, { TAG1: 'PB100', DESC1: 'START', INST: 'MCC1', LOC: 'PNL1', MFG: 'SWITCHCO', CAT: 'SP22-FG-1NO', X1TERM01: '3', X4TERM02: '4' })]);
    const back = readDxf(writeDxf(d.snapshot));
    const e = back.entities.find((x) => x.type === 'insert' && x.block === 'HPB11_NO');
    expect(e?.type === 'insert' && e.attributes).toMatchObject({ INST: 'MCC1', LOC: 'PNL1', MFG: 'SWITCHCO', X1TERM01: '3', X4TERM02: '4' });
    const blk = back.blocks.HPB11_NO!;
    expect(blk.attributes.find((a) => a.tag === 'X1TERM01')?.invisible).toBe(true);
    expect(descriptionOf({ DESC1: 'A', DESC2: '', DESC3: 'C' })).toBe('A C');
    expect(instLoc({ INST: 'MCC1', LOC: 'PNL1' })).toBe('+MCC1-PNL1');
  });
  it('tag prefixes cover the new families', () => {
    expect(tagPrefix('HKM1')).toBe('M');
    expect(tagPrefix('HMO1')).toBe('MTR');
    expect(tagPrefix('HPX11_NO')).toBe('PRS');
    expect(tagPrefix('IEC_Y_VALVE')).toBe('Y');
    expect(tagPrefix('HSV1')).toBe('SV');
  });
});

describe('WD_M drawing settings', () => {
  it('round-trips settings through the WD_M block and DXF', () => {
    const d = new Drawing();
    expect(readWdSettings(d)).toEqual(DEFAULT_WD_SETTINGS);
    writeWdSettings(d, { ...DEFAULT_WD_SETTINGS, sheet: '3', tagMode: 'sequential', tagFormat: '%F%S%N', iecInstallation: 'MCC1', wirePosition: 'below' });
    const wdm = findWdM(d)!;
    expect(wdm.layer).toBe('WD_M');
    expect(d.layer('WD_M')?.visible).toBe(false);
    const s = readWdSettings(d);
    expect(s.sheet).toBe('3');
    expect(s.tagMode).toBe('sequential');
    expect(s.tagFormat).toBe('%F%S%N');
    expect(s.wirePosition).toBe('below');
    // update in place, not duplicated
    writeWdSettings(d, { ...s, sheet: '4' });
    expect(d.entities.filter((e) => e.type === 'insert' && e.block === 'WD_M')).toHaveLength(1);
    const back = readDxf(writeDxf(d.snapshot));
    const doc2 = new Drawing();
    doc2.load(back);
    expect(readWdSettings(doc2).sheet).toBe('4');
    expect(readWdSettings(doc2).iecInstallation).toBe('MCC1');
    expect(settingsFromAttributes(attributesFromSettings(DEFAULT_WD_SETTINGS))).toEqual(DEFAULT_WD_SETTINGS);
  });
});

describe('tag formatting and RETAG', () => {
  it('formats tags with family, number, sheet and suffixes', () => {
    expect(formatTag('%F%N', { family: 'PB', number: '101' })).toBe('PB101');
    expect(formatTag('%S-%F%N', { family: 'CR', number: '3', sheet: '2' })).toBe('2-CR3');
    expect(formatTag('%I%L%F%N', { family: 'K', number: '1', inst: '+A1', loc: '-P1' })).toBe('+A1-P1K1');
    expect(letterSuffix(1)).toBe('A');
    expect(letterSuffix(26)).toBe('Z');
    expect(letterSuffix(27)).toBe('AA');
  });
  it('reference mode adds letter suffixes, sequential mode counts up', () => {
    const used = new Set(['PB101', 'PB101A']);
    expect(nextTag(used, 'PB', '101', DEFAULT_WD_SETTINGS)).toBe('PB101B');
    expect(nextTag(used, 'PB', '102', DEFAULT_WD_SETTINGS)).toBe('PB102');
    const seq = { ...DEFAULT_WD_SETTINGS, tagMode: 'sequential' as const, tagStart: 1 };
    expect(nextTag(new Set(['PB1', 'PB2']), 'PB', '101', seq)).toBe('PB3');
    // no rung reference: falls back to sequential
    expect(nextTag(new Set(['CR1']), 'CR', null, DEFAULT_WD_SETTINGS)).toBe('CR2');
  });
  it('used tags ignore child contacts', () => {
    const d = new Drawing();
    d.addEntities([ins('HCR1', 5, 8, { TAG1: 'CR100' }), ins('HCR1_NO', 3, 7, { TAG1: 'CR100' }), ins('HPB11_NO', 2, 8, { TAG1: 'PB100' })]);
    expect([...usedTags(d)].sort()).toEqual(['CR100', 'PB100']);
    expect(usedTagsOfFamily(d, 'CR')).toEqual(['CR100']);
  });
  it('RETAG renumbers in ladder order and carries child contacts along', () => {
    const d = new Drawing();
    d.addEntities([
      ref(8, '100'),
      ref(7, '101'),
      ref(6, '102'),
      ins('HPB11_NO', 2, 8, { TAG1: 'PB7' }),
      ins('HPB12_NC', 4, 8, { TAG1: 'PB9' }),
      ins('HCR1', 8, 7, { TAG1: 'CR55' }),
      ins('HCR1_NO', 3, 6, { TAG1: 'CR55' }),
      ins('HCR1_NC', 5, 6, { TAG1: 'CR55' }),
    ]);
    const r = retagDrawing(d, DEFAULT_WD_SETTINGS);
    expect(r.count).toBe(5);
    const tags = d.entities.filter((e): e is InsertEntity => e.type === 'insert').map((e) => `${e.block}:${e.attributes.TAG1}`);
    expect(tags).toEqual(['HPB11_NO:PB100', 'HPB12_NC:PB100A', 'HCR1:CR101', 'HCR1_NO:CR101', 'HCR1_NC:CR101']);
    // idempotent
    expect(retagDrawing(d, DEFAULT_WD_SETTINGS).count).toBe(0);
    // sequential per sheet format
    retagDrawing(d, { ...DEFAULT_WD_SETTINGS, tagMode: 'sequential', tagFormat: '%S%F%N', sheet: '2' });
    expect(d.entities.find((e) => e.type === 'insert' && e.block === 'HCR1_NC')!.type === 'insert' && (d.entities.find((e) => e.type === 'insert' && e.block === 'HCR1_NC') as InsertEntity).attributes.TAG1).toBe('2CR1');
  });
});

describe('catalog', () => {
  it('has generic parts for every main family', () => {
    for (const f of ['PB', 'CR', 'M', 'OL', 'FU', 'CB', 'LT', 'MTR', 'TB', 'PLC', 'TD', 'SS', 'LS']) expect(BUILTIN_CATALOG.some((i) => i.family === f), f).toBe(true);
    expect(catalogFamilies()).toContain('PB');
    expect(catalogFamilyFor('S')).toBe('PB');
    expect(catalogFamilyFor('KM')).toBe('M');
  });
  it('searches by family and all words of the text, NO/NC first', () => {
    const r = searchCatalog({ family: 'PB', text: 'green flush' });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((i) => i.family === 'PB' && /GREEN/.test(i.desc) && /FLUSH/.test(i.desc))).toBe(true);
    const nc = searchCatalog({ family: 'PB', type: 'NC' });
    expect(nc[0]!.type).toBe('NC');
    expect(searchCatalog({ text: 'zzz-nothing' })).toHaveLength(0);
    expect(findCatalogItem('switchco', 'sp22-fr-1no')?.desc).toContain('RED');
  });
  it('parses user catalog files (array or {items}) and rejects junk', () => {
    const items = parseCatalog('{"items":[{"family":"pb","mfg":"acme","cat":"x1","desc":"thing"},{"bad":1}]}');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ family: 'PB', mfg: 'ACME', cat: 'X1', source: 'user' });
    expect(() => parseCatalog('{"x":1}')).toThrow();
    expect(searchCatalog({ text: 'thing' }, items)).toHaveLength(1);
  });
});

describe('parent / child relationships', () => {
  const doc = () => {
    const d = new Drawing();
    d.ensureBlocks([...ALL_SYMBOLS, ...IEC_SYMBOLS]);
    d.addEntities([
      ref(8, '100'),
      ref(7, '101'),
      ref(6, '102'),
      ins('HCR1', 8, 8, { TAG1: 'CR100', DESC1: 'MOTOR RUN', INST: 'MCC1', LOC: 'PNL1' }),
      ins('HKM1', 8, 7, { TAG1: 'M101', DESC1: 'CONVEYOR' }),
      ins('HCR1_NO', 3, 7, { TAG1: 'CR100' }),
      ins('HCR1_NO', 3, 6, { TAG1: 'CR100' }),
      ins('HCR1_NC', 5, 6, { TAG1: 'CR100' }),
    ]);
    return d;
  };
  it('classifies coils, children and parents', () => {
    const d = doc();
    const coil = d.entities.find((e) => e.type === 'insert' && e.block === 'HCR1')!;
    const contact = d.entities.find((e) => e.type === 'insert' && e.block === 'HCR1_NO')!;
    expect(isCoil(coil)).toBe(true);
    expect(isChild(contact)).toBe(true);
    expect(isParentComponent(contact)).toBe(false);
    expect(isParentComponent(coil)).toBe(true);
    expect(isChild(ins('HPB11_NO', 0, 0, {}))).toBe(false);
  });
  it('lists parents with contact counts and copies data to children', () => {
    const d = doc();
    const parents = parentCandidates(d);
    expect(parents.map((p) => `${p.tag}:${p.contacts}`)).toEqual(['CR100:3', 'M101:0']);
    const coil = d.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'HCR1')!;
    expect(childAttributes(coil)).toEqual({ TAG1: 'CR100', INST: 'MCC1', LOC: 'PNL1', DESC1: 'MOTOR RUN' });
    expect(childBlockFor('HKM1', 'NC')).toBe('HKM1_NC');
    expect(childBlockFor('IEC_KM_COIL', 'NO')).toBe('IEC_KM_NO');
    expect(childBlockFor('HTD2', 'NO')).toBe('HTD2_NO');
  });
  it('builds the ACADE-style contact summary and table', () => {
    const d = doc();
    const x = buildXref(d).find((e) => e.tag === 'CR100')!;
    expect(contactSummary(x, DEFAULT_WD_SETTINGS)).toBe('NO 101, 102 / NC 102');
    expect(contactSummary(x, { xrefFormat: '%S-%N', sheet: '2' })).toBe('NO 2-101, 2-102 / NC 2-102');
    expect(formatXref(null, DEFAULT_WD_SETTINGS)).toBe('?');
    const tbl = contactTable(x, DEFAULT_WD_SETTINGS);
    expect(tbl.filter((e) => e.type === 'line').length).toBeGreaterThanOrEqual(6);
    expect(tbl.filter((e) => e.type === 'text').map((e) => (e as TextEntity).text)).toEqual(['NO', '101, 102', 'NC', '102']);
    expect(updateCrossReferences(d)).toBe(2);
    const texts = d.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === 'XREF').map((e) => e.text);
    expect(texts.filter((t) => t === '100')).toHaveLength(3);
    // one reference per line beside the coil; NC references carry an "NC" suffix
    expect(texts).toContain('101');
    expect(texts).toContain('102 NC');
    expect(texts).not.toContain('(no contacts)');
    updateCrossReferences(d, { ...DEFAULT_WD_SETTINGS, xrefStyle: 'table' });
    expect(d.entities.filter((e): e is TextEntity => e.type === 'text' && e.layer === 'XREF').map((e) => e.text)).not.toContain('(no contacts)');
  });
  it('toggles NO / NC variants in place', () => {
    const exists = (n: string) => !!findSymbol(n);
    expect(toggleVariant('HCR1_NO', exists)).toBe('HCR1_NC');
    expect(toggleVariant('HPB12_NC', exists)).toBe('HPB11_NO');
    expect(toggleVariant('HTD1_NC', exists)).toBe('HTD1_NO');
    expect(toggleVariant('HCR1', exists)).toBeNull();
    expect(toggleVariant('HLT1R', exists)).toBeNull();
  });
});

describe('misc helpers', () => {
  it('wire dot and breakWire still behave', () => {
    expect(wireDot({ x: 1, y: 2 }).block).toBe('WDDOT');
    expect(breakWire(wire(0, 1, 5), 2, 3)).toHaveLength(2);
  });
});
