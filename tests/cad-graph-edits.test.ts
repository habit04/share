import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, InsertEntity, LineEntity, BlockDef } from '../src/core/entities';
import { translateEntity } from '../src/core/entities';
import { CadGraphError, type CadNode } from '../src/core/cad-graph';
import { defaultLayout, makeViewport } from '../src/core/layouts';
import { CopyTool, MoveTool, RotateTool } from '../src/tools/modify';
import { MirrorTool, ScaleTool } from '../src/tools/edit';
import { alignTool, arrayPolarTool, arrayRectTool } from '../src/tools/drafting-modify';
import { blockTool } from '../src/tools/blocks';
import { layoutController } from '../src/tools/layouts';
import { EntityClipboard } from '../src/ui/clipboard';
import { createApi } from '../src/app/api';
import type { Editor as EditorType } from '../src/app/editor';
import { drive, fakeContext } from './fake-context';
import { readDxf, writeDxf } from '../src/io/dxf';

const line = (id: string, x: number, y: number): LineEntity => ({ id, type: 'line', layer: '0', color: 'ByLayer', a: { x, y }, b: { x: x + 2, y } });
function fixture(): DrawingState {
  const a = { ...line('a', 1, 2), cadIdentity: 'src:a' }, b = { ...line('b', 5, 2), cadIdentity: 'src:b' }, c = { ...line('c', 8, 4), cadIdentity: 'src:c' };
  const nodes: CadNode[] = [
    { id: 'src:a', sourceHandle: 'A', type: 'LINE', section: 'ENTITIES', anchor: { kind: 'entity', id: 'a' }, baselineEntity: a,
      groups: [[5, 'A'], [360, 'D'], [1001, 'APP'], [1010, '1'], [1020, '2'], [1030, '3'], [1011, '1'], [1021, '2'], [1031, '3'], [1012, '2'], [1022, '0'], [1032, '4'], [1013, '1'], [1023, '0'], [1033, '0'], [1041, '2']],
      references: [{ groupIndex: 1, kind: 'hard-owner', target: 'src:dict', role: 'extension' }] },
    ...[b, c].map(entity => ({ id: entity.cadIdentity, sourceHandle: entity.id.toUpperCase(), type: 'LINE', section: 'ENTITIES', anchor: { kind: 'entity' as const, id: entity.id }, baselineEntity: entity, groups: [[5, entity.id.toUpperCase()] as const] })),
    { id: 'src:dict', sourceHandle: 'D', type: 'DICTIONARY', section: 'OBJECTS', groups: [[5, 'D'], [330, 'A'], [3, 'APP'], [360, 'E']], references: [{ groupIndex: 1, kind: 'soft-pointer', target: 'src:a', role: 'owner' }, { groupIndex: 3, kind: 'hard-owner', target: 'src:record' }] },
    { id: 'src:record', sourceHandle: 'E', type: 'XRECORD', section: 'OBJECTS', groups: [[5, 'E'], [330, 'D'], [160, '9007199254740993'], [310, '00017F80FF'], [1005, 'B'], [1005, 'C'], [320, 'ABC']], references: [{ groupIndex: 1, kind: 'soft-pointer', target: 'src:dict', role: 'owner' }, { groupIndex: 4, kind: 'soft-pointer', target: 'src:b' }, { groupIndex: 5, kind: 'soft-pointer', target: 'src:c' }, { groupIndex: 6, kind: 'arbitrary' }] },
  ];
  return { ...new Drawing({ entities: [a, b, c].map(({ cadIdentity: _identity, ...entity }) => entity) }).snapshot, entities: [a, b, c], cadGraph: { schema: 1, documentId: 'source-drawing', sourceFormat: 'DWG', nodes } };
}
const node = (state: DrawingState, id: string): CadNode => state.cadGraph!.nodes.find(value => value.id === id)!;
function record(state: DrawingState, entity: Entity): CadNode {
  const root = node(state, entity.cadIdentity!), dict = node(state, root.references![0]!.target!);
  return node(state, dict.references!.find(ref => ref.kind === 'hard-owner')!.target!);
}
const coords = (state: DrawingState, entity: Entity, code = 1011) => [code, code + 10, code + 20].map(c => Number(node(state, entity.cadIdentity!).groups.find(([group]) => group === c)![1]));
function expectPoint(actual: number[], expected: number[]): void { actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 10)); }
function selected(doc: Drawing, ids = ['a', 'b']) { const ctx = fakeContext(doc); ctx.selection = new Set(ids); return ctx; }
function expectPeer(state: DrawingState, a: Entity, b: Entity): void {
  const payload = record(state, a); expect(payload.references!.find(ref => ref.groupIndex === 4)!.target).toBe(b.cadIdentity);
  expect(payload.groups.slice(2, 4)).toEqual([[160, '9007199254740993'], [310, '00017F80FF']]);
}
let Editor: typeof EditorType;
beforeAll(async () => {
  Object.assign(globalThis, { requestAnimationFrame: () => 1, cancelAnimationFrame: () => {} });
  Editor = (await import('../src/app/editor')).Editor;
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
function editor(state = fixture()) { const ed = new Editor(canvas()); ed.doc.load(state); return ed; }
function clipboardEditor(doc: Drawing) {
  const logs: string[] = [];
  const ed = { doc, selection: new Set(['a', 'b']), entitiesSelected: () => doc.entities.filter(entity => ed.selection.has(entity.id)), cursorPosition: () => null, log: (message: string) => logs.push(message), notify: () => {}, render: () => {}, runCommand: () => doc.removeEntities(ed.selection) } as unknown as EditorType;
  return { ed, logs, clipboard: new EntityClipboard(ed) };
}

describe('CAD metadata in interactive edit commands', () => {
  it('MOVE preserves identities, transforms only geometric XDATA, and records exact undo/redo', () => {
    const doc = new Drawing(fixture()), before = doc.snapshot;
    drive(new MoveTool(), selected(doc), [{ x: 0, y: 0 }, { x: 3, y: 4 }]);
    const after = doc.snapshot; expect(doc.entity('a')!.cadIdentity).toBe('src:a'); expectPoint(coords(after, doc.entity('a')!), [4, 6, 3]);
    expectPoint(coords(after, doc.entity('a')!, 1010), [1, 2, 3]); expectPeer(after, doc.entity('a')!, doc.entity('b')!);
    doc.undo(); expect(doc.snapshot).toBe(before); doc.redo(); expect(doc.snapshot).toBe(after);
  });
  it('ROTATE and SCALE update XYZ positions/vectors, directions and distances using their documented meanings', () => {
    const rotation = new Drawing(fixture()); drive(new RotateTool(), selected(rotation, ['a']), [{ x: 0, y: 0 }, '90']);
    expectPoint(coords(rotation.snapshot, rotation.entity('a')!), [-2, 1, 3]); expectPoint(coords(rotation.snapshot, rotation.entity('a')!, 1012), [0, 2, 4]); expectPoint(coords(rotation.snapshot, rotation.entity('a')!, 1013), [0, 1, 0]);
    const scale = new Drawing(fixture()); drive(new ScaleTool(), selected(scale, ['a']), [{ x: 1, y: 2 }, '2']);
    expectPoint(coords(scale.snapshot, scale.entity('a')!), [1, 2, 6]); expectPoint(coords(scale.snapshot, scale.entity('a')!, 1012), [4, 0, 8]); expectPoint(coords(scale.snapshot, scale.entity('a')!, 1013), [1, 0, 0]);
    expect(node(scale.snapshot, 'src:a').groups.find(([code]) => code === 1041)).toEqual([1041, '4']);
  });
  it('COPY repeated displacements and MIRROR clone owned metadata with peer links to their own copied sets', () => {
    const doc = new Drawing(fixture()); drive(new CopyTool(), selected(doc), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, '']);
    expect(doc.entities).toHaveLength(7);
    for (const [index, x] of [[3, 11], [5, 21]]) { expectPeer(doc.snapshot, doc.entities[index!]!, doc.entities[index! + 1]!); expectPoint(coords(doc.snapshot, doc.entities[index!]!), [x!, 2, 3]); }
    doc.undo(); expect(doc.entities).toHaveLength(5);
    const mirror = new Drawing(fixture()); drive(new MirrorTool(), selected(mirror), [{ x: 0, y: 0 }, { x: 0, y: 1 }]);
    expectPeer(mirror.snapshot, mirror.entities[3]!, mirror.entities[4]!); expectPoint(coords(mirror.snapshot, mirror.entities[3]!), [-1, 2, 3]); expectPoint(coords(mirror.snapshot, mirror.entities[3]!, 1013), [-1, 0, 0]);
  });
  it('rectangular ARRAY pairs every cell independently and undoes the whole array once', () => {
    const doc = new Drawing(fixture()), before = doc.snapshot; drive(arrayRectTool(), selected(doc), ['2', '2', '5', '10']);
    expect(doc.entities).toHaveLength(9);
    for (let index = 3; index < 9; index += 2) expectPeer(doc.snapshot, doc.entities[index]!, doc.entities[index + 1]!);
    expectPoint(coords(doc.snapshot, doc.entities[3]!), [11, 2, 3]); expectPoint(coords(doc.snapshot, doc.entities[5]!), [1, 7, 3]); expectPoint(coords(doc.snapshot, doc.entities[7]!), [11, 7, 3]);
    doc.undo(); expect(doc.snapshot).toBe(before);
  });
  it.each(['Yes', 'No'])('polar ARRAY %s keeps cell peers and uses the same per-object transform as geometry', rotate => {
    const doc = new Drawing(fixture()); drive(arrayPolarTool(), selected(doc), [{ x: 0, y: 0 }, '3', '180', rotate]);
    expect(doc.entities).toHaveLength(7);
    for (let index = 3; index < 7; index += 2) { const a = doc.entities[index] as LineEntity; expectPeer(doc.snapshot, a, doc.entities[index + 1]!); expectPoint(coords(doc.snapshot, a), [a.a.x, a.a.y, 3]); }
    expectPoint(coords(doc.snapshot, doc.entities[3]!, 1013), rotate === 'Yes' ? [0, 1, 0] : [1, 0, 0]);
  });
  it('ALIGN applies translation, rotation and optional uniform XYZ scale in one intent', () => {
    const doc = new Drawing(fixture()); drive(alignTool(), selected(doc), [{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 1, y: 0 }, { x: 10, y: 22 }, '', 'Yes']);
    expectPoint(coords(doc.snapshot, doc.entity('a')!), [6, 22, 6]); expectPoint(coords(doc.snapshot, doc.entity('a')!, 1013), [0, 1, 0]); expectPeer(doc.snapshot, doc.entity('a')!, doc.entity('b')!);
  });
  it('BLOCK clones selected peer graphs into its definition before erasing the originals', () => {
    const doc = new Drawing(fixture()), before = doc.snapshot;
    drive(blockTool(), fakeContext(doc), ['PAIR', { x: 0, y: 0 }, { select: ['a', 'b'] }]);
    expect(doc.blocks.PAIR!.entities).toHaveLength(2); expectPeer(doc.snapshot, doc.blocks.PAIR!.entities[0]!, doc.blocks.PAIR!.entities[1]!);
    expect(doc.entity('a')).toBeUndefined(); expect(doc.snapshot.cadGraph!.nodes.some(node => node.id === 'src:a')).toBe(false);
    doc.undo(); expect(doc.snapshot).toBe(before);
  });
  it('copies the independent AutoCAD line-owned dictionary and remaps its link to the copied peer through DXF saving', () => {
    const source = readDxf(readFileSync(join(import.meta.dirname, 'fixtures/interchange/r2018-views-fields.dxf'), 'utf8'));
    const lineA = source.entities.find(entity => source.cadGraph!.nodes.some(node => node.id === entity.cadIdentity && node.sourceHandle === '18D'))!;
    const lineB = source.entities.find(entity => source.cadGraph!.nodes.some(node => node.id === entity.cadIdentity && node.sourceHandle === '18E'))!;
    expect(lineA).toBeDefined(); expect(lineB).toBeDefined();
    const doc = new Drawing(source), before = doc.snapshot;
    drive(new CopyTool(), selected(doc, [lineA.id, lineB.id]), [{ x: 0, y: 0 }, { x: 5, y: 10 }, '']);
    const a = doc.entities.at(-2)!, b = doc.entities.at(-1)!, root = node(doc.snapshot, a.cadIdentity!);
    const extension = node(doc.snapshot, root.references!.find(ref => ref.role === 'extension')!.target!);
    const owned = node(doc.snapshot, extension.references!.find(ref => ref.kind === 'soft-owner' || ref.kind === 'hard-owner')!.target!);
    expect(owned.groups.find(([code]) => code === 1)).toEqual([1, 'owned by the line']);
    expect(owned.references!.find(ref => !ref.role && owned.groups[ref.groupIndex]![0] === 330)!.target).toBe(b.cadIdentity);
    const back = readDxf(writeDxf(doc.snapshot));
    const payload = back.cadGraph!.nodes.find(node => node.type === 'XRECORD' && node.groups.some(([code, value]) => code === 160 && value.trim() === '9007199254740993'))!;
    expect(payload.groups.find(([code]) => code === 310)).toEqual([310, '00017F80FF']);
    expect(back.cadGraph!.nodes.filter(node => node.type === 'XRECORD' && node.groups.some(([code, value]) => code === 1 && value === 'owned by the line'))).toHaveLength(2);
    doc.undo(); expect(doc.snapshot).toBe(before);
  });
});

describe('CAD-bearing clipboard and plugin copies', () => {
  it('cross-document COPYCLIP synthesizes one native FIELD registry and saves the filename FIELD plus line-owned dictionary', () => {
    const source = readDxf(readFileSync(join(import.meta.dirname, 'fixtures/interchange/r2018-views-fields.dxf'), 'utf8'), { filePath: 'C:/Drawings/copied-plan.dwg' });
    const doc = new Drawing(source), { ed, clipboard } = clipboardEditor(doc);
    ed.selection = new Set(source.entities.filter(entity => entity.type === 'mtext' || source.cadGraph!.nodes.some(node => node.id === entity.cadIdentity && ['18D', '18E'].includes(node.sourceHandle ?? ''))).map(entity => entity.id));
    expect(ed.selection.size).toBe(3); clipboard.copy(); doc.load(new Drawing().snapshot); const before = doc.snapshot;
    clipboard.paste(); expect(doc.entities).toHaveLength(3);
    const graph = doc.snapshot.cadGraph!, registry = graph.nodes.find(node => node.type === 'FIELDLIST')!;
    expect(graph.nodes.filter(node => node.type === 'FIELD')).toHaveLength(2);
    expect(graph.nodes.filter(node => node.type === 'FIELDLIST')).toHaveLength(1);
    expect(graph.nodes.filter(node => node.type === 'CLASS' && node.groups.some(([code, value]) => code === 1 && value.trim() === 'FIELDLIST'))).toHaveLength(1);
    const roots = graph.nodes.filter(node => node.anchor?.kind === 'dictionary' && node.anchor.path.length === 0);
    expect(roots).toHaveLength(1);
    const entry = roots[0]!.groups.findIndex(([code, value]) => code === 3 && value === 'ACAD_FIELDLIST');
    expect(roots[0]!.references!.find(ref => ref.groupIndex === entry + 1)!.target).toBe(registry.id);
    const memberRefs = registry.references!.filter(ref => !ref.role && registry.groups[ref.groupIndex]![0] === 330);
    const subclass = registry.groups.findIndex(([code, value]) => code === 100 && value === 'AcDbFieldList');
    expect(memberRefs).toHaveLength(2); expect(memberRefs.every(ref => ref.groupIndex < subclass && node(doc.snapshot, ref.target!).type === 'FIELD')).toBe(true);
    expect(registry.groups.find(([code]) => code === 90)).toEqual([90, '2']);
    const one = writeDxf(doc.snapshot), back = readDxf(one, { filePath: 'C:/Drawings/pasted-plan.dwg' });
    expect(writeDxf(readDxf(one))).toBe(one);
    expect(back.entities.find(entity => entity.type === 'mtext' && entity.field?.native)?.type).toBe('mtext');
    expect(back.cadGraph!.nodes.filter(node => node.type === 'FIELDLIST')).toHaveLength(1);
    const reopenedRoots = back.cadGraph!.nodes.filter(node => node.type === 'DICTIONARY' && node.groups.some(([code, value]) => code === 330 && value.trim() === '0'));
    expect(reopenedRoots).toHaveLength(1); expect(reopenedRoots[0]!.anchor).toEqual({ kind: 'dictionary', path: [] });
    const reopenedRegistry = back.cadGraph!.nodes.find(node => node.type === 'FIELDLIST')!;
    expect(reopenedRegistry.references!.filter(ref => ref.role === 'owner' || ref.role === 'reactor').every(ref => ref.target === reopenedRoots[0]!.id)).toBe(true);
    const reopenedEntry = reopenedRoots[0]!.groups.findIndex(([code, value]) => code === 3 && value === 'ACAD_FIELDLIST');
    expect(reopenedRoots[0]!.references!.find(ref => ref.groupIndex === reopenedEntry + 1)?.target).toBe(reopenedRegistry.id);
    expect(back.cadGraph!.nodes.some(node => node.type === 'XRECORD' && node.groups.some(([code, value]) => code === 1 && value === 'owned by the line'))).toBe(true);
    doc.undo(); expect(doc.snapshot).toBe(before); doc.redo(); expect(doc.entities).toHaveLength(3);
  });
  it('native FIELD CLASS instance counts follow copied fields and manual override while undo restores the source graph', () => {
    const source = readDxf(readFileSync(join(import.meta.dirname, 'fixtures/interchange/r2018-views-fields.dxf'), 'utf8'));
    const doc = new Drawing(source), { ed, clipboard } = clipboardEditor(doc), text = doc.entities.find(entity => entity.type === 'mtext')!;
    const fieldClassCount = (state: DrawingState) => state.cadGraph!.nodes.find(node => node.type === 'CLASS' && node.groups.some(([code, value]) => code === 1 && value.trim() === 'FIELD'))!.groups.find(([code]) => code === 91)![1];
    ed.selection = new Set([text.id]); clipboard.copy(); clipboard.paste({ x: 50, y: 50 });
    expect(fieldClassCount(readDxf(writeDxf(doc.snapshot)))).toBe('4');
    const copy = doc.entities.at(-1)!; expect(copy.type).toBe('mtext');
    if (copy.type !== 'mtext') throw new Error('Expected copied MTEXT');
    const copied = doc.snapshot; doc.replaceEntities([{ ...copy, text: 'Manual', field: undefined }]);
    expect(fieldClassCount(readDxf(writeDxf(doc.snapshot)))).toBe('2');
    doc.undo(); expect(doc.snapshot).toBe(copied); expect(fieldClassCount(readDxf(writeDxf(doc.snapshot)))).toBe('4');
  });
  it('a captured same-document clipboard survives a subsequent MOVE without losing external links or double-transforming metadata', () => {
    const doc = new Drawing(fixture()), { clipboard } = clipboardEditor(doc); clipboard.copy();
    drive(new MoveTool(), selected(doc), [{ x: 0, y: 0 }, { x: 20, y: 0 }]); clipboard.paste({ x: 11, y: 2 });
    const a = doc.entities[3]!, b = doc.entities[4]!; expectPeer(doc.snapshot, a, b); expectPoint(coords(doc.snapshot, a), [11, 2, 3]);
    expect(record(doc.snapshot, a).references!.find(ref => ref.groupIndex === 5)!.target).toBe('src:c'); expect(doc.snapshot.cadGraph!.diagnostics).toBeUndefined();
  });
  it('CUT all source nodes retains document identity and pastes the captured owned data atomically', () => {
    const doc = new Drawing(fixture()), { ed, clipboard } = clipboardEditor(doc); ed.selection.add('c'); clipboard.cut();
    expect(doc.entities).toHaveLength(0); expect(doc.snapshot.cadGraph!.nodes).toHaveLength(0);
    clipboard.paste(); expect(doc.entities).toHaveLength(3); expectPeer(doc.snapshot, doc.entities[0]!, doc.entities[1]!); expect(doc.snapshot.cadGraph!.documentId).toBe('source-drawing');
    doc.undo(); expect(doc.entities).toHaveLength(0);
  });
  it('cross-document paste keeps copied peers/int64/binary exact, reports external soft links, and creates a distinct document identity', () => {
    const doc = new Drawing(fixture()), { clipboard, logs } = clipboardEditor(doc); clipboard.copy(); doc.load(new Drawing().snapshot); clipboard.paste({ x: 11, y: 2 });
    expect(doc.entities).toHaveLength(2); expectPeer(doc.snapshot, doc.entities[0]!, doc.entities[1]!); expectPoint(coords(doc.snapshot, doc.entities[0]!), [11, 2, 3]);
    expect(record(doc.snapshot, doc.entities[0]!).groups[5]).toEqual([1005, '0']); expect(logs.some(message => message.includes('external source reference'))).toBe(true); expect(doc.snapshot.cadGraph!.documentId).not.toBe('source-drawing');
  });
  it('a missing hard dependency refuses paste without changing selection, dirty state or history', () => {
    const source = fixture(), payload = node(source, 'src:record');
    const hard: DrawingState = { ...source, cadGraph: { ...source.cadGraph!, nodes: source.cadGraph!.nodes.map(value => value === payload ? { ...payload, groups: [...payload.groups, [340, 'C'] as const], references: [...payload.references!, { groupIndex: 7, kind: 'hard-pointer' as const, target: 'src:c' }] } : value) } };
    const doc = new Drawing(hard), { ed, clipboard, logs } = clipboardEditor(doc); clipboard.copy(); doc.load(new Drawing().snapshot); const before = doc.snapshot, selection = ed.selection;
    clipboard.paste(); expect(doc.snapshot).toBe(before); expect(doc.canUndo()).toBe(false); expect(doc.dirty).toBe(false); expect(ed.selection).toBe(selection); expect(logs.at(-1)).toMatch(/Paste canceled:.*hard reference.*outside the copied set/);
  });
  it('clipboard carries nested block geometry from its closed source and refuses conflicting destination definitions', () => {
    const leaf: BlockDef = { name: 'LEAF', basePoint: { x: 0, y: 0 }, attributes: [], entities: [line('leaf', 0, 0)] };
    const insert: InsertEntity = { id: 'i', type: 'insert', layer: '0', color: 'ByLayer', block: 'LEAF', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} };
    const outer: BlockDef = { name: 'OUTER', basePoint: { x: 0, y: 0 }, attributes: [], entities: [insert] };
    const doc = new Drawing({ blocks: { LEAF: leaf, OUTER: outer }, entities: [{ ...insert, id: 'a', block: 'OUTER' }] }), { clipboard, logs } = clipboardEditor(doc); clipboard.copy(); doc.load(new Drawing().snapshot); clipboard.paste();
    expect(Object.keys(doc.blocks)).toEqual(['OUTER', 'LEAF']); expect(doc.blocks.LEAF!.entities[0]!.id).not.toBe('leaf'); expect(doc.blocks.OUTER!.entities[0]!.id).not.toBe('i');
    doc.load(new Drawing({ blocks: { OUTER: { ...outer, basePoint: { x: 99, y: 0 } } } }).snapshot); const before = doc.snapshot; clipboard.paste(); expect(doc.snapshot).toBe(before); expect(logs.at(-1)).toMatch(/conflicting definition/);
  });
  it('API add duplicates an exact CAD copy set and nested API transactions retain metadata in one undo step', () => {
    const ed = editor(), { api } = createApi(ed, 'metadata'), before = ed.doc.snapshot;
    const ids = api.document.transact(() => api.document.add(api.document.entities().filter(entity => entity.id !== 'c')));
    expectPeer(ed.doc.snapshot, ed.doc.entity(ids[0]!)!, ed.doc.entity(ids[1]!)!); ed.doc.undo(); expect(ed.doc.snapshot).toBe(before);
    expect(() => api.document.add({ ...api.document.entity('a')!, a: { x: 20, y: 2 } })).toThrow(CadGraphError); expect(ed.doc.snapshot).toBe(before);
  });
  it('human commands report metadata refusals once and leave the active drawing unchanged', () => {
    const ed = editor(), before = ed.doc.snapshot;
    ed.register({ name: 'METADATAFAIL', aliases: [], description: '', run: () => ed.doc.addEntities([{ ...translateEntity(ed.doc.entity('a')!, { x: 3, y: 0 }), id: 'undeclared' }]) });
    expect(() => ed.runCommand('METADATAFAIL')).not.toThrow(); expect(ed.doc.snapshot).toBe(before); expect(ed.doc.canUndo()).toBe(false);
    expect(ed.history.filter(message => message.startsWith('Edit canceled:'))).toHaveLength(1); expect(ed.history.at(-1)).toMatch(/clone batch/); expect(ed.history.at(-1)).not.toMatch(/Reduce the geometry/);
    const { api } = createApi(ed, 'metadata'); expect(() => api.commands.run('METADATAFAIL')).toThrow(CadGraphError);
  });
  it('layout copies clone viewport/layout owned metadata together with paper entities', () => {
    const source = fixture(), layout = { ...defaultLayout('Sheet'), entities: source.entities, viewports: [{ ...makeViewport({ x: 2, y: 3 }, { x: 8, y: 7 }, '0', null), id: 'v1' }] };
    const structural: CadNode[] = [
      { id: 'src:layout', sourceHandle: 'F', type: 'LAYOUT', section: 'OBJECTS', anchor: { kind: 'layout', name: 'Sheet' }, groups: [[5, 'F'], [360, '10']], references: [{ groupIndex: 1, kind: 'hard-owner', target: 'src:layout-data', role: 'extension' }] },
      { id: 'src:layout-data', sourceHandle: '10', type: 'XRECORD', section: 'OBJECTS', groups: [[5, '10'], [340, '11']], references: [{ groupIndex: 1, kind: 'hard-pointer', target: 'src:viewport' }] },
      { id: 'src:viewport', sourceHandle: '11', type: 'VIEWPORT', section: 'ENTITIES', anchor: { kind: 'viewport', id: 'v1' }, groups: [[5, '11'], [1001, 'VIEW_APP'], [1005, 'A']], references: [{ groupIndex: 2, kind: 'soft-pointer', target: 'src:a' }] },
    ];
    const state = { ...source, entities: [], layouts: [layout], cadGraph: { ...source.cadGraph!, nodes: [...source.cadGraph!.nodes, ...structural] } };
    const ed = editor(state), controller = layoutController(ed); expect(controller.copyLayout('Sheet', 'Copy')).toBe('Copy');
    const copy = ed.doc.layouts[1]!, graph = ed.doc.snapshot.cadGraph!, copiedLayout = graph.nodes.find(value => value.anchor?.kind === 'layout' && value.anchor.name === 'Copy')!;
    const data = node(ed.doc.snapshot, copiedLayout.references![0]!.target!), viewport = node(ed.doc.snapshot, data.references![0]!.target!);
    expect(viewport.anchor).toEqual({ kind: 'viewport', id: copy.viewports[0]!.id }); expect(viewport.references![0]!.target).toBe(copy.entities[0]!.cadIdentity); expectPeer(ed.doc.snapshot, copy.entities[0]!, copy.entities[1]!);
  });
});
