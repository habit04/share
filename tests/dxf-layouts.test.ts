import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readDxf, writeDxf } from '../src/io/dxf';
import { annotationScaleRatio } from '../src/io/cad-graph-dxf';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, TextEntity, InsertEntity, MTextEntity } from '../src/core/entities';
import { defaultLayout, paperFor, sheetSize, isScaleName, VIEWPORT_LAYER, type Layout } from '../src/core/layouts';
import { TITLE_BLOCK } from '../src/electrical/templates';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'latin1');

/** Group-code pairs of a DXF text. */
function pairs(text: string): Array<[number, string]> {
  const lines = text.split(/\r\n|\n/);
  const out: Array<[number, string]> = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([parseInt(lines[i]!.trim(), 10), lines[i + 1]!.trim()]);
  return out;
}

function sampleState(): DrawingState {
  const d = new Drawing({
    entities: [
      { id: 'm1', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 40, y: 20 } },
      { id: 'm2', layer: 'WIRES', color: 'ByLayer', type: 'text', position: { x: 2, y: 2 }, text: 'ANNO', height: 0.125, rotation: 0, align: 'left', annotative: true } as TextEntity,
    ],
  });
  d.ensureBlocks([TITLE_BLOCK]);
  const tb: InsertEntity = { id: 'p2', layer: '0', color: 'ByLayer', type: 'insert', block: TITLE_BLOCK.name, position: { x: 10.5, y: 0.5 }, rotation: 0, scale: 1, attributes: { TITLE: 'MOTORS', DWGNO: 'E-1' } };
  const sheet1: Layout = {
    ...defaultLayout('Sheet1'),
    pristine: undefined,
    plotStyle: 'grayscale',
    margins: { left: 0.25, bottom: 0.5, right: 0.25, top: 0.375 },
    entities: [{ id: 'p1', layer: '0', color: 1, type: 'text', position: { x: 1, y: 10 }, text: 'PAPER NOTE', height: 0.2, rotation: 0, align: 'left' }, tb],
    viewports: [
      { id: 'a', center: { x: 5, y: 6 }, width: 8, height: 7, view: { center: { x: 20, y: 10 }, scale: 0.25 }, layer: VIEWPORT_LAYER.name, on: true, frozenLayers: ['WIRES'] },
      { id: 'b', center: { x: 13, y: 6 }, width: 6, height: 4, view: { center: { x: 5, y: 5 }, scale: 2, locked: true }, layer: VIEWPORT_LAYER.name, on: false },
    ],
  };
  const sheet2: Layout = {
    ...defaultLayout('Metric', 'mm'),
    pristine: undefined,
    paper: paperFor('a3', 'portrait'),
    plotScale: 'fit',
    plotLineweights: false,
    entities: [{ id: 'p3', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 100, y: 100 }, radius: 20 }],
    viewports: [{ id: 'c', center: { x: 150, y: 250 }, width: 200, height: 150, view: { center: { x: 20, y: 10 }, scale: 5 }, layer: VIEWPORT_LAYER.name, on: true }],
  };
  const s = d.snapshot;
  return { ...s, layers: [...s.layers, VIEWPORT_LAYER], layouts: [sheet1, sheet2], header: { ...d.header, cannoscale: '1:4', annoAllVisible: false } };
}

describe('DXF layouts: round trip', () => {
  const state = sampleState();
  const text = writeDxf(state);
  const back = readDxf(text);

  it('keeps model space free of paper-space entities', () => {
    expect(back.entities.map((e) => e.type)).toEqual(['line', 'text']);
  });
  it('writes AutoCAD structures: BLOCK_RECORD -> LAYOUT links, ACAD_LAYOUT dictionary, VIEWPORT ids, group 67', () => {
    const p = pairs(text);
    const kinds = p.filter(([c]) => c === 0).map(([, v]) => v);
    expect(kinds.filter((k) => k === 'LAYOUT')).toHaveLength(3); // Sheet1, Metric, Model
    expect(kinds.filter((k) => k === 'VIEWPORT')).toHaveLength(2 + 3); // an overall paper viewport per layout + 3 floating
    expect(p.some(([c, v]) => c === 3 && v === 'ACAD_LAYOUT')).toBe(true);
    expect(p.some(([c, v]) => c === 2 && v === '*Paper_Space0')).toBe(true);
    // Every BLOCK_RECORD 340 names a LAYOUT handle.
    const layoutHandles = new Set<string>();
    for (let i = 0; i < p.length; i += 1) if (p[i]![0] === 0 && p[i]![1] === 'LAYOUT') layoutHandles.add(p[i + 1]![1]);
    const links = p.filter(([c]) => c === 340).map(([, v]) => v).filter((h) => layoutHandles.has(h));
    expect(links).toHaveLength(3);
    expect(p.filter(([c, v]) => c === 67 && v === '1').length).toBeGreaterThan(5);
    // Q11 F2 rework: the annotation names are never HEADER variables in JCad's output
    // at any version — AutoCAD keeps the current annotation scale as a DICTIONARYVAR
    // in the variable dictionary and reports a HEADER $CANNOSCALE as unknown; the
    // settings on this state ride the dictionary instead (see the round-trip tests
    // below). This AC1015 write pins the absence at the floor.
    const verAt = p.findIndex(([c, v]) => c === 9 && v === '$ACADVER');
    expect(p[verAt + 1]).toEqual([1, 'AC1015']);
    expect(p.some(([c, v]) => c === 9 && v === '$CANNOSCALE')).toBe(false);
    expect(p.some(([c, v]) => c === 9 && v === '$ANNOALLVISIBLE')).toBe(false);
    expect(p.some(([c, v]) => c === 1001 && v === 'AcadAnnotative')).toBe(true);
  });
  it('reads layouts back: names, order, paper, margins, plot settings', () => {
    expect(back.layouts!.map((l) => l.name)).toEqual(['Sheet1', 'Metric']);
    const [s1, s2] = back.layouts!;
    expect(s1!.paper).toMatchObject({ id: 'tabloid', units: 'in', orientation: 'landscape' });
    expect(sheetSize(s1!)).toEqual({ width: 17, height: 11 });
    expect(s1!.margins.left).toBeCloseTo(0.25, 9);
    expect(s1!.margins.bottom).toBeCloseTo(0.5, 9);
    expect(s1!.margins.top).toBeCloseTo(0.375, 9);
    expect(s1!.plotStyle).toBe('grayscale');
    expect(s1!.plotScale).toBe('1:1');
    expect(s2!.paper).toMatchObject({ id: 'a3', units: 'mm', orientation: 'portrait' });
    expect(sheetSize(s2!)).toEqual({ width: 297, height: 420 });
    expect(s2!.plotScale).toBe('fit');
    expect(s2!.plotLineweights).toBe(false);
  });
  it('reads viewports back with their view, scale, lock, on/off and frozen layers', () => {
    const [s1, s2] = back.layouts!;
    expect(s1!.viewports).toHaveLength(2);
    const [a, b] = s1!.viewports;
    expect(a!.center.x).toBeCloseTo(5, 9);
    expect(a!.center.y).toBeCloseTo(6, 9);
    expect(a!.width).toBeCloseTo(8, 9);
    expect(a!.height).toBeCloseTo(7, 9);
    expect(a!.view.center).toEqual({ x: 20, y: 10 });
    expect(a!.view.scale).toBeCloseTo(0.25, 12);
    expect(a!.frozenLayers).toEqual(['WIRES']);
    expect(a!.on).toBe(true);
    expect(a!.layer).toBe('VIEWPORTS');
    expect(b!.view.locked).toBe(true);
    expect(b!.on).toBe(false);
    expect(b!.view.scale).toBeCloseTo(2, 12);
    expect(s2!.viewports[0]!.center.x).toBeCloseTo(150, 9);
    expect(s2!.viewports[0]!.view.scale).toBeCloseTo(5, 12);
  });
  it('reads paper-space entities back at the same paper coordinates', () => {
    const [s1, s2] = back.layouts!;
    const note = s1!.entities.find((e) => e.type === 'text') as TextEntity;
    expect(note.text).toBe('PAPER NOTE');
    expect(note.position.x).toBeCloseTo(1, 9);
    expect(note.position.y).toBeCloseTo(10, 9);
    const tb = s1!.entities.find((e) => e.type === 'insert') as InsertEntity;
    expect(tb.block).toBe('WD_TITLEBLOCK');
    expect(tb.position.x).toBeCloseTo(10.5, 9);
    expect(tb.attributes.TITLE).toBe('MOTORS');
    const c = s2!.entities[0] as Extract<Entity, { type: 'circle' }>;
    expect(c.center.x).toBeCloseTo(100, 9);
  });
  it('keeps CANNOSCALE, ANNOALLVISIBLE, annotative flags and no-plot layers', () => {
    // Q11 F2 rework: the annotation values are recovered from the variable dictionary
    // at every version, never from HEADER pairs. They are asserted on an AC1024 write
    // of the same state (a transparent layer raises the format), which additionally
    // pins the placement — no $CANNOSCALE / $ANNOALLVISIBLE pair anywhere, the values
    // carried by DICTIONARYVAR records; the entity/layer facts below still read from
    // the AC1015 round trip.
    const hi = { ...state, layers: state.layers.map((l) => l.name === 'WIRES' ? { ...l, transparency: 64 } : l) };
    const hiText = writeDxf(hi), hiPairs = pairs(hiText), hiBack = readDxf(hiText);
    expect(hiPairs.some(([c, v]) => c === 9 && v === '$CANNOSCALE')).toBe(false);
    expect(hiPairs.some(([c, v]) => c === 9 && v === '$ANNOALLVISIBLE')).toBe(false);
    expect(hiPairs.some(([c, v]) => c === 3 && v === 'AcDbVariableDictionary')).toBe(true);
    expect(hiPairs.filter(([c, v]) => c === 0 && v === 'DICTIONARYVAR')).toHaveLength(2);
    expect(hiBack.header?.cannoscale).toBe('1:4');
    expect(hiBack.header?.annoAllVisible).toBe(false);
    expect(back.entities.find((e) => e.type === 'text')?.annotative).toBe(true);
    expect(back.layers.find((l) => l.name === 'VIEWPORTS')?.plot).toBe(false);
  });
  it('keeps CANNOSCALE 1:4 and ANNOALLVISIBLE off through save/read at AC1015 and AC1032 (Q11 F2 rework no-loss proof)', () => {
    // The lead's condition on the F2 rework: a drawing carrying BOTH annotation
    // settings (cannoscale '1:4', annoAllVisible false — the shared fixture state)
    // keeps both through JCad save -> JCad read at the AC1015 floor and at AC1032,
    // with the values carried by DICTIONARYVAR records in the variable dictionary,
    // never by HEADER pairs, and the second save byte-identical.
    // F2 round 2: the AC1032 leg is a GENUINELY WRITTEN AC1032 output. The earlier
    // leg spliced the $ACADVER token of an AC1015 write up to AC1032; the Windows
    // gate found AutoCAD rejects that file ('Group 91 ... expected ... discarded')
    // because every other version-shaped structure (the CLASS instance counts
    // above all) still says AC1015. Here an MTEXT with a text-frame background
    // (flags 16 — the content feature that requires AC1032) raises the seed write
    // itself, so writeDxf produces a coherent AC1032 file end to end; the extra
    // MTEXT exists only in that leg's seed state. The legs also pin the Item 1
    // scale list: exactly one ACAD_SCALELIST holding the '1:4' SCALE entry.
    const variableValues = (written: string): Record<string, string> => {
      const p = pairs(written), records: { type: string; groups: Array<[number, string]> }[] = [];
      for (const [code, value] of p) {
        if (code === 0) records.push({ type: value, groups: [] });
        else records.at(-1)?.groups.push([code, value]);
      }
      const byHandle = new Map(records.map(r => [r.groups.find(([c]) => c === 5)?.[1], r]));
      const entriesOf = (record: { groups: Array<[number, string]> }): Array<[string, string]> => {
        const entries: Array<[string, string]> = [];
        for (let i = 0; i + 1 < record.groups.length; i += 1) {
          if (record.groups[i]![0] === 3 && record.groups[i + 1]![0] === 350) entries.push([record.groups[i]![1], record.groups[i + 1]![1]]);
        }
        return entries;
      };
      const root = records.find(r => r.type === 'DICTIONARY' && entriesOf(r).some(([name]) => name === 'AcDbVariableDictionary'));
      const dictionaryHandle = root ? entriesOf(root).find(([name]) => name === 'AcDbVariableDictionary')?.[1] : undefined;
      const dictionary = dictionaryHandle ? byHandle.get(dictionaryHandle) : undefined;
      const values: Record<string, string> = {};
      if (dictionary?.type === 'DICTIONARY') for (const [name, handle] of entriesOf(dictionary)) {
        const variable = byHandle.get(handle);
        if (variable?.type === 'DICTIONARYVAR') values[name] = variable.groups.find(([c]) => c === 1)?.[1] ?? '';
      }
      return values;
    };
    const scaleListEntries = (written: string): Array<{ name: string; paper: string; drawing: string; unit: string }> => {
      const p = pairs(written), records: { type: string; groups: Array<[number, string]> }[] = [];
      for (const [code, value] of p) {
        if (code === 0) records.push({ type: value, groups: [] });
        else records.at(-1)?.groups.push([code, value]);
      }
      const byHandle = new Map(records.map(r => [r.groups.find(([c]) => c === 5)?.[1], r]));
      const entriesOf = (record: { groups: Array<[number, string]> }): Array<[string, string]> => {
        const entries: Array<[string, string]> = [];
        for (let i = 0; i + 1 < record.groups.length; i += 1) {
          if (record.groups[i]![0] === 3 && record.groups[i + 1]![0] === 350) entries.push([record.groups[i]![1], record.groups[i + 1]![1]]);
        }
        return entries;
      };
      const root = records.find(r => r.type === 'DICTIONARY' && entriesOf(r).some(([name]) => name === 'ACAD_SCALELIST'));
      const dictionaryHandle = root ? entriesOf(root).find(([name]) => name === 'ACAD_SCALELIST')?.[1] : undefined;
      const dictionary = dictionaryHandle ? byHandle.get(dictionaryHandle) : undefined;
      const entries: Array<{ name: string; paper: string; drawing: string; unit: string }> = [];
      if (dictionary?.type === 'DICTIONARY') for (const [, handle] of entriesOf(dictionary)) {
        const scale = byHandle.get(handle);
        if (scale?.type === 'SCALE') entries.push({
          name: scale.groups.find(([c]) => c === 300)?.[1] ?? '',
          paper: scale.groups.find(([c]) => c === 140)?.[1] ?? '',
          drawing: scale.groups.find(([c]) => c === 141)?.[1] ?? '',
          unit: scale.groups.find(([c]) => c === 290)?.[1] ?? '',
        });
      }
      return entries;
    };
    // Both legs start from a read-back state (one save/read in), so the byte fixed
    // point asserted below is the graph-path invariant the rest of the suite pins;
    // the model-write -> graph-write transition itself has a pre-existing,
    // unrelated layer-table asymmetry (an extra BORDER layer record) at the base.
    const framed: MTextEntity = { id: 'm3', layer: '0', color: 'ByLayer', type: 'mtext', position: { x: 30, y: 30 }, text: 'NOTE', height: 0.25, width: 10, rotation: 0, attachment: 1, lineSpacing: 1, background: { flags: 16, scale: 1.5, color: 'ByLayer' } };
    const legs: Array<[string, DrawingState]> = [
      ['AC1015', readDxf(writeDxf(state))],
      ['AC1032', readDxf(writeDxf({ ...state, entities: [...state.entities, framed] }))],
    ];
    for (const [version, source] of legs) {
      const written = writeDxf(source), writtenPairs = pairs(written), writtenBack = readDxf(written);
      const verAt = writtenPairs.findIndex(([c, v]) => c === 9 && v === '$ACADVER');
      expect(writtenPairs[verAt + 1]).toEqual([1, version]);
      expect(writtenPairs.some(([c, v]) => c === 9 && v === '$CANNOSCALE')).toBe(false);
      expect(writtenPairs.some(([c, v]) => c === 9 && v === '$ANNOALLVISIBLE')).toBe(false);
      expect(variableValues(written)).toEqual({ CANNOSCALE: '1:4', ANNOALLVISIBLE: '0' });
      expect(writtenPairs.filter(([c, v]) => c === 3 && v === 'ACAD_SCALELIST')).toHaveLength(1);
      expect(scaleListEntries(written)).toEqual([{ name: '1:4', paper: '1.0', drawing: '4.0', unit: '0' }]);
      expect(writtenBack.header?.cannoscale).toBe('1:4');
      expect(writtenBack.header?.annoAllVisible).toBe(false);
      expect(writeDxf(writtenBack)).toBe(written);
    }
  });
  it('registers the DICTIONARYVAR CLASS record on a fresh write that creates variables (Q11 F2 rework C1)', () => {
    // C1: the model writer's CLASSES registration was keyed on the variable
    // dictionary handle, which is only allocated later in OBJECTS — dead code
    // on fresh writes. Pin the record's presence and specimen shape on a
    // genuine fresh (model-path) write of the shared fixture state: group 91
    // (instance count) is omitted at AC1015 and carries the created-variable
    // count above it (here driven to AC1024 by a transparent layer, the same
    // device the companion round-trip test above uses).
    const classRecord = (written: string) => {
      const p = pairs(written), records: Array<[number, string]>[] = [];
      for (const pair of p) {
        if (pair[0] === 0) records.push([pair]);
        else records.at(-1)?.push(pair);
      }
      return records.find(r => r.some(([c, v]) => c === 1 && v === 'DICTIONARYVAR'));
    };
    const fresh = classRecord(text);
    expect(fresh).toBeDefined();
    expect(fresh).toContainEqual([2, 'AcDbDictionaryVar']);
    expect(fresh).toContainEqual([3, 'ObjectDBX Classes']);
    expect(fresh!.some(([c]) => c === 91)).toBe(false);
    const hiVer: DrawingState = { ...state, layers: state.layers.map((l) => l.name === 'WIRES' ? { ...l, transparency: 64 } : l) };
    const freshHi = classRecord(writeDxf(hiVer));
    expect(freshHi).toBeDefined();
    expect(freshHi).toContainEqual([91, '2']);
  });
  it('creates the ACAD_SCALELIST entry for the current scale on a fresh graph-less write (Q11 F2 r2 review C1)', () => {
    // Review C1: the (c) legs above start from read-back states, so their
    // writes exercise the preserve pass, which creates the list there; the
    // MODEL writer's own creation (writer.ts, graph-less state) had no
    // committed pin — disabling it failed nothing. The describe-level `text`
    // is exactly that write: the shared fixture state carries no cadGraph.
    expect(state.cadGraph).toBeUndefined();
    const p = pairs(text), records: Array<[number, string]>[] = [];
    for (const pair of p) {
      if (pair[0] === 0) records.push([pair]);
      else records.at(-1)?.push(pair);
    }
    const scales = records.filter(r => r[0]![1] === 'SCALE');
    expect(scales).toHaveLength(1);
    expect(scales[0]).toContainEqual([300, '1:4']);
    expect(scales[0]).toContainEqual([140, '1.0']);
    expect(scales[0]).toContainEqual([141, '4.0']);
    expect(scales[0]).toContainEqual([290, '0']);
    expect(p.filter(([c, v]) => c === 3 && v === 'ACAD_SCALELIST')).toHaveLength(1);
  });
  it('annotationScaleRatio parses only plain positive N:M names (Q11 F2 r2 review C2)', () => {
    // Review C2: the parser is the sole guard between an isScaleName-valid
    // cannoscale and a fabricated SCALE entry; pin its contract directly.
    expect(annotationScaleRatio('1:4')).toEqual({ numerator: '1.0', denominator: '4.0', unit: false });
    expect(annotationScaleRatio('1:1')).toEqual({ numerator: '1.0', denominator: '1.0', unit: true });
    expect(annotationScaleRatio('3:8')).toEqual({ numerator: '3.0', denominator: '8.0', unit: false });
    expect(annotationScaleRatio('1:2.5')).toEqual({ numerator: '1.0', denominator: '2.5', unit: false });
    expect(annotationScaleRatio('1=4')).toBeNull();
    expect(annotationScaleRatio('1/4')).toBeNull();
    expect(annotationScaleRatio('0:4')).toBeNull();
    expect(annotationScaleRatio('1:0')).toBeNull();
    expect(annotationScaleRatio('1/8" = 1\'-0"')).toBeNull();
    expect(annotationScaleRatio('')).toBeNull();
    expect(annotationScaleRatio('abc')).toBeNull();
  });
  it('a second round trip is stable', () => {
    const again = readDxf(writeDxf(back));
    const strip = (l: Layout) => ({ ...l, entities: l.entities.map((e) => ({ ...e, id: '', cadIdentity: '' })), viewports: l.viewports.map((v) => ({ ...v, id: '' })) });
    expect(again.layouts!.map(strip)).toEqual(back.layouts!.map(strip));
  });
  it('retains the declared pristine Layout1 and its identities when a new sheet is added', () => {
    const plain = new Drawing({ entities: [{ id: 'x', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }] }).snapshot;
    const t = writeDxf(plain);
    expect(t).toContain('Layout1');
    const r = readDxf(t);
    expect(r.layouts).toHaveLength(1);
    expect(r.layouts![0]).toMatchObject({ name: 'Layout1', pristine: true, entities: [], viewports: [] });
    expect(r.cadGraph!.nodes.find(node => node.type === 'LAYOUT' && node.anchor?.kind === 'layout')?.anchor).toEqual({ kind: 'layout', name: 'Layout1' });
    expect(r.entities).toHaveLength(1);
    const added: Layout = { ...defaultLayout('Rotated sheet'), pristine: undefined,
      viewports: [{ id: 'added', center: { x: 5, y: 4 }, width: 8, height: 6, view: { center: { x: 50, y: 40 }, scale: 0.25, twist: 0.25 }, layer: '0', on: true }],
      entities: [{ id: 'new-paper', type: 'text', layer: '0', color: 'ByLayer', position: { x: 1, y: 1 }, text: 'Paper note', height: 0.125, rotation: 0, align: 'left' }],
    };
    const expanded = { ...r, layouts: [...r.layouts!, added] };
    const written = writeDxf(expanded), lines = written.trimEnd().split(/\r\n|\r|\n/);
    const records: { type: string; groups: [number, string][] }[] = [];
    let current: (typeof records)[number] | undefined;
    for (let index = 0; index < lines.length; index += 2) {
      const code = Number(lines[index]), value = lines[index + 1]!;
      if (code === 0) { current = { type: value, groups: [] }; records.push(current); }
      else current?.groups.push([code, value]);
    }
    const group = (record: (typeof records)[number], code: number) => record.groups.find(([key]) => key === code)?.[1];
    const papers = records.filter(record => record.type === 'BLOCK_RECORD' && group(record, 2)?.startsWith('*Paper_Space'));
    expect(papers.map(record => group(record, 2))).toEqual(['*Paper_Space', '*Paper_Space0']);
    expect(new Set(papers.map(record => group(record, 5))).size).toBe(2);
    const declared = records.filter(record => record.type === 'LAYOUT').map(record => {
      const start = record.groups.findIndex(([code, value]) => code === 100 && value === 'AcDbLayout');
      const groups = record.groups.slice(start + 1);
      return { name: groups.find(([code]) => code === 1)?.[1], owner: groups.find(([code]) => code === 330)?.[1] };
    });
    expect(declared.find(layout => layout.name === 'Layout1')?.owner).toBe(group(papers[0]!, 5));
    expect(declared.find(layout => layout.name === 'Rotated sheet')?.owner).toBe(group(papers[1]!, 5));
    const reopened = readDxf(written);
    expect(reopened.layouts!.map(layout => [layout.name, layout.entities.length, layout.viewports.length])).toEqual([['Layout1', 0, 0], ['Rotated sheet', 1, 1]]);
    expect(reopened.layouts![1]!.viewports[0]!.view.twist).toBeCloseTo(0.25, 9);
    expect(reopened.entities).toHaveLength(1);
  });
});

describe('DXF layouts: AutoCAD file', () => {
  const state = readDxf(fixture('acad-layouts.dxf'));
  it('keeps the paper-space VIEWPORTs and TEXT out of model space', () => {
    expect(state.entities.map((e) => e.type)).toEqual(['line', 'circle']);
  });
  it('imports Layout1 with its viewport (paper origin at the printable corner) and Layout2 from *Paper_Space0', () => {
    expect(state.layouts!.map((l) => l.name)).toEqual(['Layout1', 'Layout2']);
    const [l1, l2] = state.layouts!;
    expect(l1!.paper).toMatchObject({ id: 'tabloid', units: 'in', orientation: 'landscape' });
    expect(l1!.plotStyle).toBe('monochrome');
    expect(l1!.viewports).toHaveLength(1);
    const v = l1!.viewports[0]!;
    // AutoCAD's 8,5 is 8.25,5.25 from the sheet corner with a 6.35 mm (0.25 in) margin.
    expect(v.center.x).toBeCloseTo(8.25, 9);
    expect(v.center.y).toBeCloseTo(5.25, 9);
    expect(v.width).toBe(15);
    expect(v.height).toBe(9);
    expect(v.view.center).toEqual({ x: 10, y: 5 });
    expect(v.view.scale).toBeCloseTo(0.5, 12);
    expect(v.frozenLayers).toEqual(['HIDDENVP']);
    expect(v.layer).toBe('VPORTS');
    const note = l1!.entities[0] as TextEntity;
    expect(note.text).toBe('GENERAL NOTES');
    expect(note.position.x).toBeCloseTo(1.25, 9);
    expect(l2!.paper).toMatchObject({ id: 'a3', units: 'mm', orientation: 'landscape' });
    expect(l2!.plotStyle).toBe('color');
    const v2 = l2!.viewports[0]!;
    expect(v2.center.x).toBeCloseTo(207.5, 9);
    expect(v2.center.y).toBeCloseTo(160, 9);
    expect(v2.view.scale).toBeCloseTo(25, 9);
    expect(v2.view.locked).toBe(true);
    expect(state.layers.find((l) => l.name === 'VPORTS')?.plot).toBe(false);
  });
  it('the AutoCAD example drawing keeps its two (empty) layouts', () => {
    const ex = readDxf(readFileSync(join(__dirname, '..', 'fixtures', 'example_2000.dxf'), 'latin1'));
    expect(ex.layouts!.map((l) => l.name)).toEqual(['Layout1', 'Layout2']);
    expect(ex.layouts![0]!.paper).toMatchObject({ id: 'letter', units: 'mm', orientation: 'landscape' });
    expect(ex.layouts![0]!.pristine).toBe(true);
  });
});

describe('$CANNOSCALE from a file is a scale name, never markup', () => {
  const withScale = (name: string) => ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '9', '$CANNOSCALE', '2', name, '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
  it('keeps ordinary scale names, including feet and inches', () => {
    expect(readDxf(withScale('1:4')).header?.cannoscale).toBe('1:4');
    expect(readDxf(withScale('1/8" = 1\'-0"')).header?.cannoscale).toBe('1/8" = 1\'-0"');
  });
  it('ignores a value with markup characters or of absurd length (the status bar would show it)', () => {
    expect(readDxf(withScale('<img src=x onerror=alert(1)>')).header?.cannoscale).toBeUndefined();
    expect(readDxf(withScale('1:2 & more')).header?.cannoscale).toBeUndefined();
    expect(readDxf(withScale('1'.repeat(65))).header?.cannoscale).toBeUndefined();
    expect(isScaleName('1:1')).toBe(true);
    expect(isScaleName('a\u0007b')).toBe(false);
    expect(isScaleName('   ')).toBe(false);
    expect(isScaleName(undefined)).toBe(false);
  });
});
