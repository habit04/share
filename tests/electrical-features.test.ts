import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { newId } from '../src/core/entities';
import { ALL_SYMBOLS } from '../src/electrical/symbols';
import { IEC_SYMBOLS } from '../src/electrical/iec';
import { buildXref, updateCrossReferences } from '../src/electrical/xref';
import { billOfMaterial, componentReport, wireFromToReport, electricalAudit, reportToCsv } from '../src/electrical/reports';
import { newFromTemplate, SHEET_SIZES, TITLE_BLOCK } from '../src/electrical/templates';
import { parseProject, serializeProject, resolveDrawingPath } from '../src/app/project';
import { pushRecent } from '../src/app/settings';
import { buildPlcModule, buildTerminalStrip, DEFAULT_PLC, DEFAULT_STRIP } from '../src/tools/plc';
import { assignWireNumbers, breakWire } from '../src/tools/electrical';
import { applyGrip } from '../src/app/editor';
import { writeDxf, readDxf } from '../src/io/dxf';
import { SessionManager, type SessionHost } from '../src/app/sessions';
import { Autosaver, type AutosaveStore } from '../src/app/autosave';

const ins = (block: string, x: number, y: number, attrs: Record<string, string>): Entity => ({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x, y }, rotation: 0, scale: 1, attributes: attrs });
const ref = (y: number, t: string): Entity => ({ id: newId(), layer: 'MISC', color: 'ByLayer', type: 'text', position: { x: 0.75, y: y - 0.06 }, text: t, height: 0.125, rotation: 0, align: 'right' });
const wire = (x1: number, y: number, x2: number): Entity => ({ id: newId(), layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x: x1, y }, b: { x: x2, y } });

function ladderDoc(): Drawing {
  const d = new Drawing();
  d.ensureBlocks([...ALL_SYMBOLS, ...IEC_SYMBOLS]);
  d.addEntities([
    ref(8, '100'),
    ref(7, '101'),
    ref(6, '102'),
    ...breakWire({ ...(wire(1, 8, 10) as Extract<Entity, { type: 'line' }>) }, 5 - 0.375, 5 + 0.375),
    ins('HCR1', 5, 8, { TAG1: 'CR100', DESC1: 'RUN', MFG: 'ACME', CAT: 'R-1' }),
    ...breakWire({ ...(wire(1, 7, 10) as Extract<Entity, { type: 'line' }>) }, 3 - 0.375, 3 + 0.375),
    ins('HCR1_NO', 3, 7, { TAG1: 'CR100' }),
    ...breakWire({ ...(wire(1, 6, 10) as Extract<Entity, { type: 'line' }>) }, 4 - 0.375, 4 + 0.375),
    ins('HCR1_NC', 4, 6, { TAG1: 'CR100' }),
    ins('HPB11_NO', 7, 6, { TAG1: 'PB102', DESC1: 'START', MFG: 'ACME', CAT: 'PB-22' }),
    ins('HPB11_NO', 8, 6, { TAG1: 'PB103', DESC1: 'JOG', MFG: 'ACME', CAT: 'PB-22' }),
    ins('HT0001', 2, 5, { TERM01: '7' }),
  ]);
  return d;
}

describe('cross references', () => {
  it('links coils and contacts by tag with rung references', () => {
    const d = ladderDoc();
    const x = buildXref(d);
    const cr = x.find((e) => e.tag === 'CR100')!;
    expect(cr.coilRef).toBe('100');
    expect(cr.contacts.map((c) => `${c.kind}${c.ref}`).sort()).toEqual(['NC102', 'NO101']);
    const n = updateCrossReferences(d);
    expect(n).toBe(1);
    let xrefTexts = d.entities.filter((e) => e.type === 'text' && e.layer === 'XREF').map((e) => (e.type === 'text' ? e.text : ''));
    // ACADE-style references beside the coil, one per line, NC marked
    expect(xrefTexts).toContain('101');
    expect(xrefTexts).toContain('102 NC');
    // table style: NO / NC rows with rung references drawn with lines
    updateCrossReferences(d, { xrefFormat: '%N', sheet: '1', xrefStyle: 'table' });
    xrefTexts = d.entities.filter((e) => e.type === 'text' && e.layer === 'XREF').map((e) => (e.type === 'text' ? e.text : ''));
    expect(xrefTexts).toContain('NO');
    expect(xrefTexts).toContain('101');
    expect(xrefTexts).toContain('NC');
    expect(xrefTexts).toContain('102');
    expect(d.entities.some((e) => e.type === 'line' && e.layer === 'XREF')).toBe(true);
    expect(xrefTexts.filter((t) => t === '100')).toHaveLength(2);
    expect(d.layer('XREF')).toBeDefined();
    // re-running replaces
    const count = d.entities.filter((e) => e.layer === 'XREF').length;
    updateCrossReferences(d, { xrefFormat: '%N', sheet: '1', xrefStyle: 'table' });
    expect(d.entities.filter((e) => e.layer === 'XREF')).toHaveLength(count);
  });
});

describe('reports', () => {
  it('bill of material groups by catalog and skips contacts', () => {
    const r = billOfMaterial(ladderDoc());
    const pb = r.rows.find((row) => row[2] === 'PB-22')!;
    expect(pb[1]).toBe('2');
    expect(pb[5]).toBe('PB102, PB103');
    expect(r.rows.some((row) => row[5]?.includes('CR100') && row[2] === 'R-1')).toBe(true);
    expect(r.rows.filter((row) => row[5]?.includes('CR100'))).toHaveLength(1);
  });
  it('component report lists tags with rung and catalog data', () => {
    const r = componentReport(ladderDoc());
    const row = r.rows.find((x) => x[0] === 'CR100')!;
    expect(row[2]).toBe('ACME');
    expect(row[r.columns.indexOf('Rung')]).toBe('100');
    expect(r.rows.some((x) => x[0] === '7')).toBe(true);
  });
  it('wire from/to finds the devices touching each numbered net', () => {
    const d = ladderDoc();
    assignWireNumbers(d);
    const r = wireFromToReport(d);
    const w100 = r.rows.find((x) => x[0] === '100')!;
    expect([w100[1], w100[2]]).toContain('CR100');
  });
  it('audit reports duplicates and orphan contacts', () => {
    const d = ladderDoc();
    d.addEntities([ins('HLT1R', 9, 6, { TAG1: 'PB102' }), ins('HCR1_NO', 6, 7, { TAG1: 'CR999' })]);
    const r = electricalAudit(d);
    expect(r.rows.some((x) => x[0] === 'Duplicate tag' && x[1] === 'PB102')).toBe(true);
    expect(r.rows.some((x) => x[0] === 'Contact without coil' && x[1] === 'CR999')).toBe(true);
    expect(r.rows.some((x) => x[0] === 'Unnumbered wire')).toBe(true);
  });
  it('csv export quotes commas and quotes', () => {
    const csv = reportToCsv({ title: 't', columns: ['a', 'b'], rows: [['x,y', 'say "hi"']] });
    expect(csv).toBe('a,b\r\n"x,y","say ""hi"""\r\n');
  });
});

describe('templates and projects', () => {
  it('creates a sheet with border, zones and a title block insert', () => {
    const s = newFromTemplate(SHEET_SIZES[1]!, { TITLE: 'MOTOR CONTROL' });
    const tb = s.entities.find((e) => e.type === 'insert' && e.block === TITLE_BLOCK.name);
    expect(tb).toBeDefined();
    if (tb?.type === 'insert') expect(tb.attributes.TITLE).toBe('MOTOR CONTROL');
    expect(s.layers.some((l) => l.name === 'BORDER')).toBe(true);
    expect(s.blocks[TITLE_BLOCK.name]).toBeDefined();
    // title block survives a DXF round trip with attributes
    const back = readDxf(writeDxf(s));
    const tb2 = back.entities.find((e) => e.type === 'insert' && e.block === TITLE_BLOCK.name);
    if (tb2?.type === 'insert') expect(tb2.attributes.TITLE).toBe('MOTOR CONTROL');
  });
  it('parses, serialises and resolves project files', () => {
    const p = parseProject('{"name":"Line 1","drawings":[{"file":"001.dxf","description":"Power"},{"file":"/abs/002.dxf"},{"bad":true}]}', '/proj/line1.jcadproj.json');
    expect(p.drawings).toHaveLength(2);
    expect(resolveDrawingPath(p, p.drawings[0]!)).toBe('/proj/001.dxf');
    expect(resolveDrawingPath(p, p.drawings[1]!)).toBe('/abs/002.dxf');
    const again = parseProject(serializeProject(p));
    expect(again.name).toBe('Line 1');
    expect(() => parseProject('{"name":"x"}')).toThrow();
  });
  it('recent list is de-duplicated and capped', () => {
    let l: string[] = [];
    for (let i = 0; i < 12; i += 1) l = pushRecent(l, `f${i}`);
    expect(l).toHaveLength(9);
    expect(l[0]).toBe('f11');
    l = pushRecent(l, 'f5');
    expect(l[0]).toBe('f5');
    expect(l.filter((f) => f === 'f5')).toHaveLength(1);
  });
});

describe('parametric builders', () => {
  it('PLC module has one stub and address per point', () => {
    const ents = buildPlcModule({ x: 0, y: 10 }, { ...DEFAULT_PLC, points: 4 });
    expect(ents.filter((e) => e.type === 'line' && e.layer === 'WIRES')).toHaveLength(4);
    const addrs = ents.filter((e) => e.type === 'text' && e.layer === 'TAGS').map((e) => (e.type === 'text' ? e.text : ''));
    expect(addrs).toContain('I:0/3');
  });
  it('terminal strip numbers terminals sequentially', () => {
    const ents = buildTerminalStrip({ x: 0, y: 0 }, { ...DEFAULT_STRIP, count: 3, firstNumber: 5 });
    const nums = ents.filter((e) => e.type === 'text' && e.layer === 'TERMS').map((e) => (e.type === 'text' ? e.text : ''));
    expect(nums).toEqual(['5', '6', '7']);
  });
  it('grip stretch semantics', () => {
    const line: Entity = { id: 'l', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 2, y: 0 } };
    expect((applyGrip(line, 2, { x: 5, y: 1 }) as Extract<Entity, { type: 'line' }>).b).toEqual({ x: 5, y: 1 });
    const mid = applyGrip(line, 1, { x: 2, y: 1 }) as Extract<Entity, { type: 'line' }>;
    expect(mid.a).toEqual({ x: 1, y: 1 });
    expect(mid.b).toEqual({ x: 3, y: 1 });
    const c: Entity = { id: 'c', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 0, y: 0 }, radius: 1 };
    expect((applyGrip(c, 1, { x: 3, y: 0 }) as Extract<Entity, { type: 'circle' }>).radius).toBe(3);
  });
});

describe('symbol tabs: dirty prompt and autosave', () => {
  function host(): SessionHost {
    const doc = new Drawing();
    return {
      doc,
      viewport: { center: { x: 0, y: 0 }, scale: 1 },
      selection: new Set<string>(),
      loadState(state, path) {
        doc.load(state, path);
      },
    };
  }
  it('a dirty Symbol Builder tab counts for the close prompt but is skipped by the DXF autosave', async () => {
    const h = host();
    const sm = new SessionManager(h);
    // tab 2 is a symbol session (the Symbol Builder registers its id), opened dirty like SymbolBuilder.open does
    const symbolTab = sm.add(undefined, null, true);
    const symbolId = sm.all[symbolTab]!.id;
    expect(sm.anyDirty()).toBe(true); // onQueryDirty -> sessions.anyDirty(): closing the app prompts for the symbol
    sm.switchTo(0);
    expect(sm.anyDirty()).toBe(true);
    const written: string[] = [];
    const store: AutosaveStore = {
      async write(name) {
        written.push(name);
      },
      async list() {
        return [];
      },
      async read() {
        return null;
      },
      async remove() {},
    };
    const saver = new Autosaver(sm, store, () => 10, (id) => id === symbolId);
    expect(await saver.runNow()).toBe(0);
    expect(written).toEqual([]);
    // a dirty drawing tab is still autosaved
    h.doc.addEntities([wire(0, 1, 5)]);
    expect(await saver.runNow()).toBe(1);
    expect(written).toHaveLength(1);
  });
});
