/**
 * v0.6.4 native gate B-2 (blocking) and B-3.
 *
 * B-2: JCad wrote PDFDEFINITION objects owned by the root dictionary but
 * never registered them in ACAD_PDFDEFINITIONS (DWF/DGN likewise). AutoCAD
 * loaded such a file with AUDIT 0, then dropped the definition as
 * unreachable on its first save; the reopened placement had a dead 340
 * (AUDIT 2, "AcDbPdfReference was not repaired"). The writer now emits one
 * definitions dictionary per kind in use under the root, with one
 * "<file stem> - <page>" entry per definition, each definition owned by and
 * reacting to it — AutoCAD's own layout (gate input u-acad-written.dxf,
 * committed as r2018-pdf-underlay-dict-acad2027.dxf).
 *
 * B-3: unmodelled definition groups (a pre-fix JCad save's "90 7") were
 * re-emitted after 1 / 2 and made AutoCAD discard the whole drawing. A
 * definition now writes only its spec groups.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { DrawingState } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';

type Rec = { kind: string; groups: Array<[number, string]> };
function records(text: string): Rec[] {
  const lines = text.split(/\r?\n/);
  const out: Rec[] = [];
  let cur: Rec | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    const value = lines[i + 1]!.trim();
    if (code === 0) { cur = { kind: value, groups: [] }; out.push(cur); } else cur?.groups.push([code, value]);
  }
  return out;
}
const group = (r: Rec, code: number): string | undefined => r.groups.find(([c]) => c === code)?.[1];
const codes = (r: Rec): number[] => r.groups.map(([c]) => c);
/** Dictionary entries (name -> handle) of a DICTIONARY record. */
const entries = (r: Rec): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (let i = 0; i + 1 < r.groups.length; i += 1) if (r.groups[i]![0] === 3 && [350, 360].includes(r.groups[i + 1]![0])) out.push([r.groups[i]![1], r.groups[i + 1]![1]]);
  return out;
};
const root = (recs: Rec[]): Rec => recs.find((r) => r.kind === 'DICTIONARY' && group(r, 330) === '0')!;
const dictAt = (recs: Rec[], handle: string | undefined): Rec | undefined => recs.find((r) => r.kind === 'DICTIONARY' && group(r, 5) === handle);

const jcadState = (defs: Array<{ id: string; handle: string; kind: 'pdf' | 'dwf' | 'dgn'; sourcePath: string; page?: string }>): DrawingState => ({
  entities: defs.map((d, i) => ({ id: `u${i}`, layer: '0', color: 'ByLayer' as const, type: 'underlay' as const, kind: d.kind, definitionHandle: d.handle, position: { x: i * 10, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [] })),
  layers: [], blocks: {}, currentLayer: '0',
  underlays: Object.fromEntries(defs.map((d) => [d.id, { ...d, retainedGroups: [] }])),
});

describe('B-2: underlay definitions are registered in the named-objects dictionary', () => {
  it('a JCad-created PDF underlay writes ACAD_PDFDEFINITIONS under the root, the definition owned by and reacting to it', () => {
    const out = writeDxf(jcadState([{ id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'plans/real.pdf', page: '1' }]));
    const recs = records(out);
    const rootEntries = entries(root(recs));
    const dictHandle = rootEntries.find(([name]) => name === 'ACAD_PDFDEFINITIONS')?.[1];
    expect(dictHandle).toBeDefined();
    expect(rootEntries.filter(([name]) => /DEFINITIONS$/.test(name)).map(([name]) => name)).toEqual(['ACAD_PDFDEFINITIONS']); // only the kind in use
    const dict = dictAt(recs, dictHandle)!;
    expect(dict).toBeDefined();
    // AutoCAD's layout: owner the root, no reactors block, AcDbDictionary, 281, entries.
    expect(codes(dict)).toEqual([5, 330, 100, 281, 3, 350]);
    expect(group(dict, 330)).toBe(group(root(recs), 5));
    const def = recs.find((r) => r.kind === 'PDFDEFINITION')!;
    expect(entries(dict)).toEqual([['real - 1', group(def, 5)!]]);
    // The definition: 5, {ACAD_REACTORS -> dict}, 330 dict, marker, 1, 2 — nothing else.
    expect(codes(def)).toEqual([5, 102, 330, 102, 330, 100, 1, 2]);
    expect(def.groups.filter(([c]) => c === 330).map(([, v]) => v)).toEqual([dictHandle, dictHandle]);
    expect(group(def, 1)).toBe('plans/real.pdf');
    expect(group(def, 2)).toBe('1');
    // The placement still names the definition; a second save is byte-stable.
    expect(group(recs.find((r) => r.kind === 'PDFUNDERLAY')!, 340)).toBe(group(def, 5));
    // Settled after one reopen (the reader adds the layer table a bare state lacks), then byte-stable.
    const settled = writeDxf(readDxf(out));
    expect(writeDxf(readDxf(settled))).toBe(settled);
    expect(codes(records(settled).find((r) => r.kind === 'PDFDEFINITION')!)).toEqual([5, 102, 330, 102, 330, 100, 1, 2]);
  });

  it('two definitions get unique entry names; a page-less definition is named by its file stem; kinds get their own dictionaries', () => {
    const out = writeDxf(jcadState([
      { id: 'a', handle: 'A1', kind: 'pdf', sourcePath: 'real.pdf', page: '1' },
      { id: 'b', handle: 'A2', kind: 'pdf', sourcePath: 'C:\\other\\real.pdf', page: '1' },
      { id: 'c', handle: 'A3', kind: 'pdf', sourcePath: 'site.pdf' },
      { id: 'd', handle: 'A4', kind: 'dgn', sourcePath: 'models/site.dgn', page: 'Default' },
    ]));
    const recs = records(out);
    const rootEntries = entries(root(recs));
    expect(rootEntries.filter(([name]) => /DEFINITIONS$/.test(name)).map(([name]) => name).sort()).toEqual(['ACAD_DGNDEFINITIONS', 'ACAD_PDFDEFINITIONS']);
    const pdfDict = dictAt(recs, rootEntries.find(([n]) => n === 'ACAD_PDFDEFINITIONS')![1])!;
    const dgnDict = dictAt(recs, rootEntries.find(([n]) => n === 'ACAD_DGNDEFINITIONS')![1])!;
    expect(entries(pdfDict).map(([n]) => n)).toEqual(['real - 1', 'real - 1 (2)', 'site']);
    expect(entries(dgnDict).map(([n]) => n)).toEqual(['site - Default']);
    // Every entry names a definition record of the right kind, each definition is owned by its dictionary.
    const defs = recs.filter((r) => /DEFINITION$/.test(r.kind));
    expect(defs).toHaveLength(4);
    for (const [, h] of entries(pdfDict)) expect(defs.find((d) => group(d, 5) === h)?.kind).toBe('PDFDEFINITION');
    for (const [, h] of entries(dgnDict)) expect(defs.find((d) => group(d, 5) === h)?.kind).toBe('DGNDEFINITION');
    for (const d of defs) expect(group(d, 330)).toBe(group(d.kind === 'PDFDEFINITION' ? pdfDict : dgnDict, 5));
    const settled = writeDxf(readDxf(out));
    expect(writeDxf(readDxf(settled))).toBe(settled);
    expect(records(settled).filter((r) => /DEFINITION$/.test(r.kind))).toHaveLength(4);
    expect(entries(root(records(settled))).filter(([name]) => /DEFINITIONS$/.test(name))).toHaveLength(2);
  });

  it('an AutoCAD-written file that already has ACAD_PDFDEFINITIONS round-trips byte-stable with no duplicate dictionary or entry', () => {
    const text = readFileSync('tests/fixtures/interchange/r2018-pdf-underlay-dict-acad2027.dxf', 'utf8');
    const out1 = writeDxf(readDxf(text));
    const recs = records(out1);
    const rootEntries = entries(root(recs));
    expect(rootEntries.filter(([name]) => name === 'ACAD_PDFDEFINITIONS')).toHaveLength(1);
    const dict = dictAt(recs, rootEntries.find(([n]) => n === 'ACAD_PDFDEFINITIONS')![1])!;
    expect(recs.filter((r) => r.kind === 'DICTIONARY' && entries(r).some(([n]) => n === 'real - 1'))).toHaveLength(1);
    const def = recs.find((r) => r.kind === 'PDFDEFINITION')!;
    expect(recs.filter((r) => r.kind === 'PDFDEFINITION')).toHaveLength(1);
    expect(entries(dict)).toEqual([['real - 1', group(def, 5)!]]); // the source's entry, exactly once
    expect(codes(def)).toEqual([5, 102, 330, 102, 330, 100, 1, 2]);
    expect(def.groups.filter(([c]) => c === 330).map(([, v]) => v)).toEqual([group(dict, 5), group(dict, 5)]);
    expect(group(recs.find((r) => r.kind === 'PDFUNDERLAY')!, 340)).toBe(group(def, 5));
    expect(writeDxf(readDxf(out1))).toBe(out1);
  });
});

describe('B-3: a definition writes only its spec groups', () => {
  const LEGACY = [
    '0', 'SECTION', '2', 'ENTITIES',
    '0', 'PDFUNDERLAY', '5', '40', '330', '1F', '100', 'AcDbEntity', '8', 'U', '100', 'AcDbPdfUnderlay',
    '340', '41', '10', '10', '20', '20', '41', '2', '42', '2', '70', '3', '280', '40', '281', '10', '14', '0', '24', '0', '14', '100', '24', '50',
    '0', 'ENDSEC',
    '0', 'SECTION', '2', 'OBJECTS',
    '0', 'PDFDEFINITION', '5', '41', '330', 'C', '1', 'real.pdf', '2', '1', '90', '7',
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');

  it('the pre-fix "90 7" legacy definition writes without the 90, inside the new dictionary', () => {
    const state = readDxf(LEGACY);
    expect(Object.values(state.underlays ?? {})[0]!.retainedGroups).toContainEqual([90, '7']); // retained on read
    const out = writeDxf(state);
    const recs = records(out);
    const def = recs.find((r) => r.kind === 'PDFDEFINITION')!;
    expect(codes(def)).toEqual([5, 102, 330, 102, 330, 100, 1, 2]);
    expect(out).not.toMatch(/\r\n90\r\n7\r\n/);
    const dict = dictAt(recs, entries(root(recs)).find(([n]) => n === 'ACAD_PDFDEFINITIONS')?.[1])!;
    expect(entries(dict)).toEqual([['real - 1', group(def, 5)!]]);
    expect(writeDxf(readDxf(out))).toBe(out);
  });
});
