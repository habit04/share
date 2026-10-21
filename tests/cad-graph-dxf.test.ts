import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing, type DrawingState } from '../src/core/document';
import { CadGraphError, type CadNode } from '../src/core/cad-graph';
import { importReportOf } from '../src/io/import-report';
import { translateEntity } from '../src/core/entities';
import { attachDxfCadGraph } from '../src/io/cad-graph-dxf';
import { tokenize } from '../src/io/dxf/groups';
import { EntityClipboard } from '../src/ui/clipboard';
import type { Editor } from '../src/app/editor';
import { paperFromSize, sheetSize } from '../src/core/layouts';

const fixture = readFileSync(new URL('./fixtures/interchange/r2018-views-fields.dxf', import.meta.url), 'utf8');
const group = (node: CadNode, code: number) => node.groups.find(([c]) => c === code)?.[1].trim();
const opened = () => readDxf(fixture, { filePath: 'C:/Drawings/test-plan.dwg' });
describe('independent AutoCAD metadata oracle through DXF', () => {
  it('retains versioned native table-style properties and their typed owned slot through repeated saves', () => {
    const pairs = tokenize(fixture), start = pairs.findIndex(pair => pair.code === 0 && pair.value.trim() === 'TABLESTYLE');
    const marker = pairs.findIndex((pair, index) => index > start && pair.code === 100 && pair.value.trim() === 'AcDbTableStyle');
    const metadata = [[102, '{JCAD_TABLESTYLE_NATIVE_V1'], [90, '0'], [91, '101'], [360, '0'], [92, '3'], [93, '1'], [93, '2'], [93, '3'], [102, '}']] as const;
    pairs.splice(marker, 0, ...metadata.map(([code, value]) => ({ code, value })));
    const source = readDxf(pairs.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n');
    const style = source.cadGraph!.nodes.find(node => node.type === 'TABLESTYLE')!;
    const at = style.groups.findIndex(([code, value]) => code === 102 && value === '{JCAD_TABLESTYLE_NATIVE_V1');
    expect(style.groups.slice(at, at + metadata.length)).toEqual(metadata);
    expect(style.references!.find(ref => ref.groupIndex === at + 3)).toMatchObject({ kind: 'hard-owner', sourceHandle: '0' });
    const once = writeDxf(source), back = readDxf(once), retained = back.cadGraph!.nodes.find(node => node.sourceHandle === style.sourceHandle)!;
    expect(retained.groups).toEqual(style.groups);
    expect(writeDxf(back)).toBe(once);
  });
  it('keeps retained shade-plot and opaque layout properties in their original subclasses through page edits and repeated saves', () => {
    const raw = tokenize(readFileSync(new URL('./fixtures/interchange/r2000-layouts-titleblock.dxf', import.meta.url), 'utf8'));
    const start = raw.findIndex(pair => pair.code === 0 && pair.value.trim() === 'LAYOUT');
    const marker = raw.findIndex((pair, index) => index > start && pair.code === 100 && pair.value.trim() === 'AcDbLayout');
    raw.splice(marker, 0, { code: 77, value: '5' }, { code: 78, value: '240' }, { code: 310, value: '0001FE' });
    const end = raw.findIndex((pair, index) => index > marker && pair.code === 0);
    raw.splice(end, 0, { code: 310, value: '0002FD' });
    const source = readDxf(raw.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n');
    const layout = source.cadGraph!.nodes.find(node => node.type === 'LAYOUT' && node.anchor?.kind === 'layout' && node.anchor.name !== 'Model')!;
    const name = layout.anchor?.kind === 'layout' ? layout.anchor.name : '';
    const edited = { ...source, layouts: source.layouts!.map(sheet => sheet.name === name ? { ...sheet, paper: paperFromSize(24, 18, sheet.paper.units, 'landscape')! } : sheet) };
    const once = writeDxf(edited), back = readDxf(once);
    const retained = back.cadGraph!.nodes.find(node => node.sourceHandle === layout.sourceHandle)!;
    const at = retained.groups.findIndex(([code, value]) => code === 100 && value === 'AcDbLayout');
    expect(retained.groups.slice(0, at)).toContainEqual([77, '5']);
    expect(retained.groups.slice(0, at)).toContainEqual([78, '240']);
    expect(retained.groups.slice(0, at)).toContainEqual([310, '0001FE']);
    expect(retained.groups.slice(at)).toContainEqual([310, '0002FD']);
    expect(retained.groups.slice(at).some(([code]) => code === 77 || code === 78)).toBe(false);
    expect(sheetSize(back.layouts!.find(sheet => sheet.name === name)!)).toEqual({ width: 24, height: 18 });
    expect(writeDxf(back)).toBe(once);
  });
  it('retains the distinct DIMSTYLE symbol flags and nondefault repeated text-fill color', () => {
    const source = opened(), style = source.cadGraph!.nodes.find(node => node.type === 'DIMSTYLE')!;
    const end = style.groups.findIndex(([code]) => code === 1001);
    const groups = style.groups.map(([code, value]) => [code, code === 70 ? '16' : value] as const);
    groups.splice(end < 0 ? groups.length : end, 0, [69, '2'], [70, '7']);
    const controlled = { ...source, cadGraph: { ...source.cadGraph!, nodes: source.cadGraph!.nodes.map(node => node === style ? { ...node, groups } : node) } };
    const once = writeDxf(controlled), back = readDxf(once), retained = back.cadGraph!.nodes.find(node => node.sourceHandle === style.sourceHandle)!;
    expect(retained.groups.filter(([code]) => code === 70)).toEqual([[70, '16'], [70, '7']]);
    expect(retained.groups).toContainEqual([69, '2']);
    expect(writeDxf(back)).toBe(once);
  });
  it.each(['malformed identity', 'duplicate identity', 'malformed pointer'])('reports %s while keeping bounded semantic geometry, but strict native projection refuses', kind => {
    const rows: [number, string][] = [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [5, kind === 'malformed identity' ? 'P1' : 'A'], [8, '0'], [10, '0'], [20, '0'], [11, '1'], [21, '1'], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'OBJECTS'], [0, 'XRECORD'], [5, kind === 'duplicate identity' ? 'A' : 'B'], [100, 'AcDbXrecord'], [280, '1'], [1, 'literal payload'], ...(kind === 'malformed pointer' ? [[340, 'not-a-handle'] as [number, string]] : []), [0, 'ENDSEC'], [0, 'EOF']];
    const pairs = tokenize(rows.flatMap(([code, value]) => [String(code), value]).join('\r\n') + '\r\n');
    const base = new Drawing({ entities: [{ id: 'a', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }] }).snapshot;
    const source = { ...base, entities: [{ ...base.entities[0]!, cadIdentity: kind === 'malformed identity' ? 'P1' : 'A' }] }, losses: string[] = [];
    const back = attachDxfCadGraph(source, pairs, { onGraphUnavailable: reason => losses.push(reason) });
    expect(back.entities).toEqual(base.entities); expect(back.cadGraph).toBeUndefined(); expect(losses).toHaveLength(1); expect(losses[0]).toMatch(/could not be imported safely/);
    expect(() => attachDxfCadGraph(source, pairs)).toThrow(CadGraphError);
    expect(() => attachDxfCadGraph(source, pairs, { sourceFormat: 'DWG', onGraphUnavailable: () => {} })).toThrow(CadGraphError);
  });
  it('retains legacy raw geometry only in model space and never reintroduces dropped block/paper 3DFACE', () => {
    const source = readDxf(readFileSync(new URL('./fixtures/unsupported-content.dxf', import.meta.url), 'utf8'));
    expect(source.cadGraph!.nodes.filter(node => node.type === '3DFACE').map(node => node.sourceHandle)).toEqual(['101']);
    const back = readDxf(writeDxf(source));
    expect(back.cadGraph!.nodes.filter(node => node.type === '3DFACE')).toHaveLength(1);
    const model = back.cadGraph!.nodes.find(node => node.type === 'BLOCK_RECORD' && node.groups.some(([code, value]) => code === 2 && value === '*Model_Space'))!;
    const face = back.cadGraph!.nodes.find(node => node.type === '3DFACE')!;
    expect(face.references!.find(ref => ref.role === 'owner')!.target).toBe(model.id);
    expect(face.groups.find(([code]) => code === 1001)).toEqual([1001, 'SOMEAPP']);
    expect(importReportOf(back)?.items.some(item => item.type === '3DFACE' && item.action === 'dropped')).toBe(false);
  });
  it('rebinds only a retained model record common owner, preserving its distinct application pointer', () => {
    const source = readDxf(readFileSync(new URL('./fixtures/unsupported-content.dxf', import.meta.url), 'utf8'));
    const face = source.cadGraph!.nodes.find(node => node.type === '3DFACE')!, target = source.cadGraph!.nodes.find(node => node.type === 'LINE')!;
    const at = face.groups.findIndex(([code]) => code === 1001);
    const groups = [...face.groups.slice(0, at), [330, target.sourceHandle!] as const, ...face.groups.slice(at)];
    const changed = { ...source, cadGraph: { ...source.cadGraph!, nodes: source.cadGraph!.nodes.map(node => node === face ? { ...face, groups, references: [...face.references!.map(ref => ({ ...ref, groupIndex: ref.groupIndex >= at ? ref.groupIndex + 1 : ref.groupIndex })), { groupIndex: at, kind: 'soft-pointer' as const, target: target.id }] } : node) } };
    const back = readDxf(writeDxf(changed)), retained = back.cadGraph!.nodes.find(node => node.type === '3DFACE')!;
    const owner = retained.references!.find(ref => ref.role === 'owner')!, application = retained.references!.find(ref => !ref.role && retained.groups[ref.groupIndex]![0] === 330)!;
    expect(back.cadGraph!.nodes.find(node => node.id === owner.target)?.type).toBe('BLOCK_RECORD');
    expect(back.cadGraph!.nodes.find(node => node.id === application.target)?.type).toBe('LINE');
    expect(application.target).not.toBe(owner.target);
  });
  it('preserves complete complex linetype text/shape structure and typed style dependencies across repeated saves', () => {
    const source = readDxf(readFileSync(new URL('./fixtures/interchange/r2018-truecolor-linetypes.dxf', import.meta.url), 'utf8'));
    const complex = source.cadGraph!.nodes.filter(node => node.type === 'LTYPE' && node.groups.some(([code]) => code === 340));
    expect(complex).toHaveLength(2);
    const one = writeDxf(source), back = readDxf(one);
    const numeric = new Set([70, 72, 73, 40, 49, 74, 75, 46, 50, 44, 45]);
    // Numeric groups compare at the writer's own precision (15 significant digits): a genuine
    // AutoCAD save spells the GAS_LINE dash -6.349999999999999, whose double the writer
    // canonicalises to -6.35 on save (checklist r2018-truecolor-linetypes #19).
    const normalized = (groups: readonly (readonly [number, string])[]) => groups.map(([code, value]) => [code, numeric.has(code) ? String(Number(Number(value).toPrecision(15))) : value]);
    for (const original of complex) {
      const retained = back.cadGraph!.nodes.find(node => node.sourceHandle === original.sourceHandle)!;
      expect(normalized(retained.groups)).toEqual(normalized(original.groups));
      for (const ref of retained.references!.filter(ref => retained.groups[ref.groupIndex]![0] === 340)) expect(back.cadGraph!.nodes.find(node => node.id === ref.target)?.type).toBe('STYLE');
    }
    expect(writeDxf(back)).toBe(one);
    const edited = { ...source, header: { ...source.header!, linetypes: source.header!.linetypes.map(line => line.name === 'GAS_LINE' ? { ...line, pattern: line.pattern.map((length, index) => index === 0 ? length + 1 : length), complex: { ...line.complex!, totalPatternLength: line.complex!.totalPatternLength! + 1 } } : line) } };
    const regenerated = readDxf(writeDxf(edited)).header!.linetypes.find(line => line.name === 'GAS_LINE')!;
    // Element-wise at 12 digits, not double-exact: the genuine file's long-spelled dash
    // (-6.349999999999999, one ULP below -6.35) is canonicalised by the writer on save
    // (checklist r2018-truecolor-linetypes #19).
    const editedPattern = edited.header.linetypes.find(line => line.name === 'GAS_LINE')!.pattern;
    expect(regenerated.pattern).toHaveLength(editedPattern.length);
    regenerated.pattern.forEach((v, i) => expect(v).toBeCloseTo(editedPattern[i]!, 12));
    expect(regenerated.complex).toEqual(edited.header.linetypes.find(line => line.name === 'GAS_LINE')!.complex);
    const described = { ...source, header: { ...source.header!, linetypes: source.header!.linetypes.map(line => line.name === 'GAS_LINE' ? { ...line, description: 'Updated description' } : line) } };
    const changed = readDxf(writeDxf(described)); expect(changed.header!.linetypes.find(line => line.name === 'GAS_LINE')!.description).toBe('Updated description');
  });
  it('keeps independent AutoCAD opaque Unicode/Xrecord escape and JSON strings exact across repeated saves', () => {
    const text = readFileSync(new URL('./fixtures/interchange/r2018-unicode-metadata.dxf', import.meta.url), 'utf8');
    const expected = JSON.parse(readFileSync(new URL('./fixtures/interchange/r2018-unicode-metadata.expected.json', import.meta.url), 'utf8')) as { opaqueStrings: { handle: string; code: number; value: string }[] };
    const source = readDxf(text), one = writeDxf(source), reopened = readDxf(one), two = writeDxf(reopened);
    for (const state of [source, reopened]) for (const sample of expected.opaqueStrings) {
      const node = state.cadGraph!.nodes.find(node => node.sourceHandle === sample.handle)!;
      expect(node.groups.find(([code]) => code === sample.code)?.[1]).toBe(sample.value);
    }
    expect(two).toBe(one); expect(source.header!.views.some(view => /[Δ雷]/.test(view.name))).toBe(true);
  });
  it('opaque Unicode escapes cannot add new records or alter DXF structure', () => {
    const opaque = 'Literal \\U+000A0\\U+000ASECTION\\U+000A2\\U+000AENTITIES \\U+0030 JSON {"literal":"\\\\U+0041"}';
    const pairs: [number, string][] = [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [5, 'A'], [8, '0'], [10, '0'], [20, '0'], [11, '1'], [21, '1'], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'OBJECTS'], [0, 'DICTIONARY'], [5, 'B'], [330, '0'], [100, 'AcDbDictionary'], [3, 'APP_LITERAL'], [350, 'C'], [0, 'XRECORD'], [5, 'C'], [330, 'B'], [100, 'AcDbXrecord'], [280, '1'], [1, opaque], [0, 'ENDSEC'], [0, 'EOF']];
    const source = readDxf(pairs.flatMap(([code, value]) => [String(code), value]).join('\r\n') + '\r\n');
    expect(source.entities).toHaveLength(1); expect(source.entities[0]!.type).toBe('line');
    const original = source.cadGraph!.nodes.find(node => node.type === 'XRECORD')!; expect(original.groups.find(([code]) => code === 1)).toEqual([1, opaque]);
    const one = writeDxf(source), back = readDxf(one); expect(back.entities).toHaveLength(1); expect(back.cadGraph!.nodes.find(node => node.type === 'XRECORD')!.groups.find(([code]) => code === 1)).toEqual([1, opaque]);
    expect(writeDxf(back)).toBe(one);
  });
  it('repeated saves preserve exact metadata and reach a byte-identical fixed point', () => {
    const one = writeDxf(opened()), two = writeDxf(readDxf(one));
    expect(two).toBe(one); expect(writeDxf(readDxf(two))).toBe(two);
  });
  it('retains native dictionary defaults, hard ownership and unknown groups after editing and COPYCLIP', () => {
    const pairs = tokenize(fixture);
    const changeRecord = (type: string, change: (groups: typeof pairs) => typeof pairs) => {
      const at = pairs.findIndex(pair => pair.code === 0 && pair.value.trim() === type);
      const end = pairs.findIndex((pair, index) => index > at && pair.code === 0);
      expect(at).toBeGreaterThan(0); expect(end).toBeGreaterThan(at);
      pairs.splice(at + 1, end - at - 1, ...change(pairs.slice(at + 1, end)));
    };
    changeRecord('DICTIONARY', groups => {
      const entry = groups.findIndex(pair => pair.code === 3 && pair.value === 'ACAD_GROUP');
      expect(entry).toBeGreaterThan(0);
      groups[entry + 1] = { code: 360, value: groups[entry + 1]!.value };
      groups.splice(groups.findIndex(pair => pair.code === 281), 0, { code: 280, value: '1' });
      return groups;
    });
    let dictionaryHandle = '';
    changeRecord('ACDBDICTIONARYWDFLT', groups => {
      dictionaryHandle = groups.find(pair => pair.code === 5)!.value.trim();
      groups[groups.findIndex(pair => pair.code === 340)] = { code: 340, value: 'EFFFFF' };
      const subclass = groups.findIndex(pair => pair.code === 100 && pair.value === 'AcDbDictionaryWithDefault');
      groups.splice(subclass, 0, { code: 3, value: 'Custom' }, { code: 360, value: 'EFFFFF' });
      groups.push({ code: 290, value: '1' }, { code: 1, value: 'opaque dictionary {"target":"102"}' });
      return groups;
    });
    const objectEnd = pairs.reduce((last, pair, index) => pair.code === 0 && pair.value === 'ENDSEC' ? index : last, -1);
    pairs.splice(objectEnd, 0, { code: 0, value: 'ACDBPLACEHOLDER' }, { code: 5, value: 'EFFFFF' }, { code: 330, value: dictionaryHandle });
    const source = readDxf(pairs.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n');
    const rootOf = (state: DrawingState) => state.cadGraph!.nodes.find(node => node.anchor?.kind === 'dictionary' && node.anchor.path.length === 0)!;
    const defaultOf = (state: DrawingState) => state.cadGraph!.nodes.find(node => node.type === 'ACDBDICTIONARYWDFLT')!;
    const check = (state: DrawingState) => {
      const root = rootOf(state), dictionary = defaultOf(state);
      expect(root.groups).toEqual(rootOf(source).groups);
      expect(dictionary.groups).toEqual(defaultOf(source).groups);
      const entry = root.groups.findIndex(([code, name]) => code === 3 && name === 'ACAD_GROUP');
      expect(root.references!.find(ref => ref.groupIndex === entry + 1)!.kind).toBe('hard-owner');
      const target = dictionary.references!.find(ref => dictionary.groups[ref.groupIndex]![0] === 340)!.target;
      expect(state.cadGraph!.nodes.find(node => node.id === target)?.sourceHandle).toBe('EFFFFF');
    };
    check(readDxf(writeDxf(source)));
    const doc = new Drawing(source), selected = new Set(source.entities.filter(entity => source.cadGraph!.nodes.some(node => node.anchor?.kind === 'entity' && node.anchor.id === entity.id && ['18D', '18E'].includes(node.sourceHandle ?? ''))).map(entity => entity.id));
    expect(selected.size).toBe(2);
    const ed = { doc, selection: selected, entitiesSelected: () => doc.entities.filter(entity => selected.has(entity.id)), cursorPosition: () => null, log: () => {}, notify: () => {}, render: () => {} } as unknown as Editor;
    const clipboard = new EntityClipboard(ed); expect(clipboard.copy()).toBe(true); clipboard.paste({ x: 50, y: 50 });
    expect(doc.entities).toHaveLength(source.entities.length + 2);
    const line = doc.entities.find(entity => selected.has(entity.id))!;
    doc.replaceEntities([translateEntity(line, { x: 3, y: 4 })], { transforms: [{ entityIds: [line.id], transform: { xx: 1, xy: 0, yx: 0, yy: 1, tx: 3, ty: 4 } }] });
    const one = writeDxf(doc.snapshot), reopened = readDxf(one);
    check(reopened); expect(writeDxf(reopened)).toBe(one);
  });
  it('native FIELD links serialize the display cache in MTEXT while the expression stays on owned FIELD objects', () => {
    const source = opened(), entity = source.entities.find(e => e.type === 'mtext')!;
    expect(entity.type === 'mtext' && entity.field?.native).toBe(true);
    const text = writeDxf(source); const pairs = tokenize(text), at = pairs.findIndex(pair => pair.code === 0 && pair.value === 'MTEXT');
    const next = pairs.findIndex((pair, index) => index > at && pair.code === 0), body = pairs.slice(at, next < 0 ? undefined : next);
    expect(body.filter(pair => pair.code === 1 || pair.code === 3).map(pair => pair.value).join('')).toBe('Drawing: test-plan');
    expect(text).toContain('%<\\_FldIdx 0>%');
  });
  it('interprets Unicode escapes in known native FIELD expressions without rewriting retained expression groups', () => {
    const pairs = tokenize(fixture), parent = pairs.findIndex(pair => pair.code === 2 && pair.value.startsWith('Drawing: %<'));
    expect(parent).toBeGreaterThan(0); pairs[parent] = { ...pairs[parent]!, value: '\\U+0394 ' + pairs[parent]!.value };
    const source = readDxf(pairs.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n', { filePath: 'C:/Drawings/legacy.dwg' });
    expect(source.entities.find(entity => entity.type === 'mtext')).toMatchObject({ text: 'Δ Drawing: legacy', field: { native: true, code: 'Δ Drawing: %<\\AcVar Filename \\f "%fn2">%' } });
    const original = source.cadGraph!.nodes.find(node => node.type === 'FIELD' && node.groups.some(([code, value]) => code === 2 && value.startsWith('\\U+0394 ')))!;
    expect(original).toBeDefined();
    const back = readDxf(writeDxf(source), { filePath: 'C:/Drawings/legacy.dwg' });
    expect(back.cadGraph!.nodes.find(node => node.sourceHandle === original.sourceHandle)!.groups.find(([code]) => code === 2)).toEqual(original.groups.find(([code]) => code === 2));
    expect(back.entities.find(entity => entity.type === 'mtext')).toMatchObject({ text: 'Δ Drawing: legacy' });
  });
  it('interprets exponentially reused child slots within a bounded budget while retaining all native records/cache', () => {
    const rows: [number, string][] = [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'TEXT'], [5, 'A'], [102, '{ACAD_XDICTIONARY'], [360, 'B'], [102, '}'], [100, 'AcDbEntity'], [8, '0'], [100, 'AcDbText'], [10, '0'], [20, '0'], [40, '1'], [1, 'Source cache'], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'OBJECTS'], [0, 'DICTIONARY'], [5, 'B'], [330, 'A'], [100, 'AcDbDictionary'], [3, 'ACAD_FIELD'], [360, 'C'], [0, 'DICTIONARY'], [5, 'C'], [330, 'B'], [100, 'AcDbDictionary'], [3, 'TEXT'], [360, '100']];
    for (let depth = 0; depth < 25; depth++) {
      const handle = (0x100 + depth).toString(16).toUpperCase(), child = (0x101 + depth).toString(16).toUpperCase();
      rows.push([0, 'FIELD'], [5, handle], [330, depth ? (0xff + depth).toString(16).toUpperCase() : 'C'], [100, 'AcDbField'], [1, '_text'], [2, depth === 24 ? 'Leaf' : '%<\\_FldIdx 0>%%<\\_FldIdx 1>%']);
      if (depth < 24) rows.push([360, child], [360, child]);
    }
    rows.push([0, 'ENDSEC'], [0, 'EOF']);
    const pairs = tokenize(rows.flatMap(([code, value]) => [String(code), value]).join('\r\n') + '\r\n');
    const messages: string[] = [], state = new Drawing({ entities: [{ id: 't', cadIdentity: undefined, type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left', text: 'Source cache' }] }).snapshot;
    const attached = attachDxfCadGraph({ ...state, entities: [{ ...state.entities[0]!, cadIdentity: 'A' }] }, pairs, { onFieldUnavailable: (_handle, reason) => messages.push(reason) });
    const entity = attached.entities[0]!;
    expect(entity.type === 'text' && entity.text).toBe('Source cache'); expect(entity.type === 'text' && entity.field).toBeUndefined();
    expect(attached.cadGraph!.nodes.filter(node => node.type === 'FIELD')).toHaveLength(25); expect(messages.some(message => message.includes('interpretation budget'))).toBe(true);
  });
  it('interprets all named cameras and native child FIELD expressions', () => {
    const state = opened();
    expect(state.header!.views.map(v => v.name)).toEqual(['SITE_NORTH', 'SITE_ANGLE', 'FUTURE_3D']);
    expect(state.header!.views[0]!.center).toEqual({ x: 105, y: 202.5 });
    expect(state.header!.views[1]!.twist).toBeCloseTo(Math.PI / 6, 10);
    expect(state.header!.views[2]!.camera!.direction).toEqual({ x: 1, y: 2, z: 3 });
    const text = state.entities.find(e => e.type === 'mtext');
    expect(text?.type === 'mtext' && text.field?.code).toBe('Drawing: %<\\AcVar Filename \\f "%fn2">%');
    expect(text?.type === 'mtext' && text.text).toBe('Drawing: test-plan');
    expect(state.cadGraph!.nodes.filter(n => n.type === 'FIELD')).toHaveLength(2);
  });
  it('saves exact integers/binary and connected references after a geometry edit', () => {
    const doc = new Drawing(opened()), line = doc.entities.find(e => e.type === 'line')!;
    doc.replaceEntities([translateEntity(line, { x: 3, y: 4 })], { transforms: [{ entityIds: [line.id], transform: { xx: 1, xy: 0, yx: 0, yy: 1, tx: 3, ty: 4 } }] });
    const written = writeDxf(doc.snapshot), reopened = readDxf(written, { filePath: 'C:/Drawings/test-plan.dwg' });
    expect(written).toContain('AC1032');
    const payload = reopened.cadGraph!.nodes.find(n => n.type === 'XRECORD' && group(n, 160));
    expect(group(payload!, 160)).toBe('9007199254740993');
    expect(group(payload!, 310)).toBe('00017F80FF');
    expect(group(payload!, 1)).toBe('Payload F0A is literal text');
    const edges = payload!.references!.filter(r => [330, 340].includes(payload!.groups[r.groupIndex]![0]) && !r.role);
    expect(edges).toHaveLength(2);
    expect(edges.every(r => !!r.target && reopened.cadGraph!.nodes.some(n => n.id === r.target && n.type === 'LINE'))).toBe(true);
    expect(reopened.cadGraph!.nodes.filter(n => n.type === 'FIELD')).toHaveLength(2);
    expect(reopened.header!.views[1]!.camera!.target.z).toBe(7);
    expect(reopened.header!.views[2]!.camera!.direction).toEqual({ x: 1, y: 2, z: 3 });
  });
});
