import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import { CadGraphError, type CadNode } from '../src/core/cad-graph';
import { importReportOf } from '../src/io/import-report';
import { translateEntity } from '../src/core/entities';
import { attachDxfCadGraph } from '../src/io/cad-graph-dxf';
import { tokenize } from '../src/io/dxf/groups';

const fixture = readFileSync(new URL('./fixtures/interchange/r2018-views-fields.dxf', import.meta.url), 'utf8');
const group = (node: CadNode, code: number) => node.groups.find(([c]) => c === code)?.[1].trim();
const opened = () => readDxf(fixture, { filePath: 'C:/Drawings/test-plan.dwg' });
describe('independent AutoCAD metadata oracle through DXF', () => {
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
    for (const original of complex) {
      const retained = back.cadGraph!.nodes.find(node => node.sourceHandle === original.sourceHandle)!;
      expect(retained.groups).toEqual(original.groups);
      for (const ref of retained.references!.filter(ref => retained.groups[ref.groupIndex]![0] === 340)) expect(back.cadGraph!.nodes.find(node => node.id === ref.target)?.type).toBe('STYLE');
    }
    expect(writeDxf(back)).toBe(one);
    const edited = { ...source, header: { ...source.header!, linetypes: source.header!.linetypes.map(line => line.name === 'GAS_LINE' ? { ...line, pattern: line.pattern.map((length, index) => index === 0 ? length + 1 : length) } : line) } };
    expect(() => writeDxf(edited)).toThrow(/edited complex linetype GAS_LINE.*native regeneration/);
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
