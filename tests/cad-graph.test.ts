import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, TextEntity } from '../src/core/entities';
import { translateEntity } from '../src/core/entities';
import { CadGraphError, cadReferences, canonicalCadHandle, cloneCadEntitySets, graphOf, reconcileCadGraph, transformCadGroups, validateCadGraph, type CadGraph, type CadGroup, type CadNode } from '../src/core/cad-graph';

const handleA = 'FFFFFFFFFFFFFFFF';
const line = (id: string, identity?: string): Entity => ({ id, ...(identity ? { cadIdentity: identity } : {}), type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });
function fixture(extra: CadNode[] = []): DrawingState {
  const a = line('a', 'src:a'), b = line('b', 'src:b'), external = line('external', 'src:external');
  const nodes: CadNode[] = [
    { id: 'src:a', sourceHandle: handleA, type: 'LINE', section: 'ENTITIES', anchor: { kind: 'entity', id: 'a' }, baselineEntity: a, groups: [[5, handleA], [360, '80']], references: [{ groupIndex: 1, kind: 'hard-owner', target: 'src:dict', role: 'extension' }] },
    { id: 'src:b', sourceHandle: '10', type: 'LINE', section: 'ENTITIES', anchor: { kind: 'entity', id: 'b' }, baselineEntity: b, groups: [[5, '10']] },
    { id: 'src:external', sourceHandle: '30', type: 'LINE', section: 'ENTITIES', anchor: { kind: 'entity', id: 'external' }, baselineEntity: external, groups: [[5, '30']] },
    { id: 'src:dict', sourceHandle: '80', type: 'DICTIONARY', section: 'OBJECTS', anchor: { kind: 'dictionary', path: ['a'] }, groups: [[5, '80'], [330, handleA], [3, 'APP_DATA'], [350, '81']], references: [{ groupIndex: 1, kind: 'soft-pointer', target: 'src:a', role: 'owner' }, { groupIndex: 3, kind: 'soft-owner', target: 'src:record' }] },
    { id: 'src:record', sourceHandle: '81', type: 'XRECORD', section: 'OBJECTS', groups: [[5, '81'], [330, '80'], [1, 'opaque 123 ABC'], [1001, 'APP_DATA'], [1005, '10'], [320, '30']], references: [{ groupIndex: 1, kind: 'soft-pointer', target: 'src:dict', role: 'owner' }, { groupIndex: 4, kind: 'soft-pointer', target: 'src:b', role: 'xdata' }, { groupIndex: 5, kind: 'arbitrary', target: 'src:external' }] },
    ...extra,
  ];
  return { ...new Drawing().snapshot, entities: [a, b, external], cadGraph: { schema: 1, sourceFormat: 'DXF', sourceVersion: 'AC1032', nodes } };
}
const node = (state: DrawingState, id: string): CadNode => graphOf(state)!.nodes.find((node) => node.id === id)!;
const translated = (state: DrawingState, oldId: string, newId: string): Entity => ({ ...translateEntity(state.entities.find((entity) => entity.id === oldId)!, { x: 5, y: 2 }), id: newId });

describe('retained CAD graph validation and identities', () => {
  it('bounds regenerated handle hints and rejects aliases with semantic source handles', () => {
    const graph = fixture().cadGraph!;
    expect(() => validateCadGraph({ ...graph, generatedHandles: [{ key: 'picture', handle: '10' }] })).toThrow(/conflict/);
    expect(() => validateCadGraph({ ...graph, generatedHandles: [{ key: 'picture', handle: '100' }, { key: 'picture', handle: '101' }] })).toThrow(/duplicate/);
    expect(() => validateCadGraph({ ...graph, generatedHandles: [{ key: 'picture', handle: '0' }] })).toThrow(/conflict/);
    validateCadGraph({ ...graph, generatedHandles: [{ key: 'picture', handle: '100' }] });
  });
  it('keeps plain source anchors without attaching graph identities to ordinary edited or copied geometry', () => {
    const original = fixture(), plain = original.entities.map(({ cadIdentity: _identity, ...entity }) => entity as Entity);
    const state: DrawingState = { ...original, entities: plain, cadGraph: { ...original.cadGraph!, nodes: original.cadGraph!.nodes.filter(node => node.anchor?.kind === 'entity' && !node.anchor.part).map(node => ({ ...node, groups: node.groups.filter(([code]) => code === 5), references: [], baselineEntity: plain.find(entity => node.anchor?.kind === 'entity' && entity.id === node.anchor.id) })) } };
    const doc = new Drawing(state); doc.replaceEntities([translateEntity(doc.entity('a')!, { x: 4, y: 0 })]);
    expect(doc.entity('a')!.cadIdentity).toBeUndefined(); expect(doc.snapshot.cadGraph!.nodes).toHaveLength(3);
    doc.addEntities([{ ...doc.entity('a')!, id: 'a1' }], false, { cloneBatches: [{ entityIds: { a: 'a1' } }] });
    expect(doc.entity('a1')!.cadIdentity).toBeUndefined(); expect(doc.snapshot.cadGraph!.nodes.some(node => node.anchor?.kind === 'entity' && node.anchor.id === 'a1')).toBe(true);
    expect(() => new Drawing({ entities: doc.entities })).not.toThrow();
  });
  it('keeps full 64-bit hexadecimal handles without numeric rounding', () => {
    expect(canonicalCadHandle('ffffffffffffffff')).toBe(handleA);
    expect(canonicalCadHandle('0000000000000010')).toBe('10');
    expect(() => canonicalCadHandle('10000000000000000')).toThrow(CadGraphError);
    const state = fixture(); validateCadGraph(state.cadGraph!); expect(node(state, 'src:a').sourceHandle).toBe(handleA);
    expect(cadReferences([[340, handleA], [1005, '10'], [320, '30']], new Map([[handleA, 'a'], ['10', 'b'], ['30', 'c']]))).toEqual([{ groupIndex: 0, kind: 'hard-pointer', target: 'a', sourceHandle: handleA }, { groupIndex: 1, kind: 'soft-pointer', target: 'b', sourceHandle: '10', role: 'xdata' }, { groupIndex: 2, kind: 'arbitrary', target: 'c', sourceHandle: '30' }]);
  });
  it('rejects duplicate handles, missing typed edges and nonexistent targets before accepting a document', () => {
    const graph = fixture().cadGraph!;
    expect(() => validateCadGraph({ ...graph, nodes: [...graph.nodes, { id: 'duplicate', type: 'XRECORD', section: 'OBJECTS', sourceHandle: '0000000000000010', groups: [] }] })).toThrow(/Duplicate/);
    expect(() => validateCadGraph({ ...graph, nodes: graph.nodes.map((node) => node.id === 'src:record' ? { ...node, references: [] } : node) })).toThrow(/typed reference/);
    expect(() => validateCadGraph({ ...graph, nodes: graph.nodes.map((node) => node.id === 'src:record' ? { ...node, references: [{ groupIndex: 1, kind: 'soft-pointer' as const, target: 'missing' }, ...node.references!.slice(1)] } : node) })).toThrow(/missing object/);
    expect(() => new Drawing({ entities: [line('ghost', 'unavailable')] })).toThrow(/retained object graph/);
  });
  it('rejects oversized raw values and protects immutability after load', () => {
    const graph: CadGraph = { schema: 1, sourceFormat: 'DXF', nodes: [{ id: 'raw', type: 'XRECORD', section: 'OBJECTS', groups: [[1, 'x'.repeat(1024 * 1024 + 1)]] }] };
    expect(() => validateCadGraph(graph)).toThrow(/group pair/);
    const doc = new Drawing(fixture()); expect(Object.isFrozen(doc.snapshot.cadGraph)).toBe(true); expect(Object.isFrozen(node(doc.snapshot, 'src:record').groups[0])).toBe(true);
  });
  it('keeps identity and metadata for same-ID edits, with exact undo and redo snapshots', () => {
    const doc = new Drawing(fixture()), before = doc.snapshot;
    doc.replaceEntities([translateEntity(doc.entities[0]!, { x: 7, y: -3 })]);
    expect(doc.entity('a')!.cadIdentity).toBe('src:a'); expect(doc.snapshot.cadGraph).toBe(before.cadGraph); const after = doc.snapshot;
    doc.undo(); expect(doc.snapshot).toBe(before); doc.redo(); expect(doc.snapshot).toBe(after);
  });
  it('refuses undeclared copies atomically', () => {
    const doc = new Drawing(fixture()), before = doc.snapshot;
    expect(() => doc.addEntities([translated(before, 'a', 'a1')])).toThrow(/explicit clone batch/);
    expect(doc.snapshot).toBe(before); expect(doc.dirty).toBe(false); expect(doc.canUndo()).toBe(false);
  });
  it('keeps the independent AutoCAD oracle XRECORD integer, binary and literal text exact through edit/undo', () => {
    const oracle = JSON.parse(readFileSync(join(__dirname, 'fixtures/interchange/r2018-views-fields.expected.json'), 'utf8')) as { records: Array<{ type: string; handle: string; groups: Array<{ code: number; value: string }> }> };
    const record = oracle.records.find((record) => record.type === 'XRECORD' && record.groups.some((group) => group.code === 160))!;
    const groups = record.groups.map((group): CadGroup => [group.code, group.value]);
    const raw: CadNode = { id: 'oracle-record', type: record.type, sourceHandle: record.handle, section: 'OBJECTS', anchor: { kind: 'raw' }, groups, references: cadReferences(groups, new Map()) };
    const doc = new Drawing({ entities: [line('line')], cadGraph: { schema: 1, sourceFormat: 'DWG', sourceVersion: 'AC1032', nodes: [raw] } }), before = doc.snapshot;
    doc.replaceEntities([translateEntity(doc.entities[0]!, { x: 3, y: 4 })]);
    expect(node(doc.snapshot, 'oracle-record').groups).toContainEqual([160, '9007199254740993']); expect(node(doc.snapshot, 'oracle-record').groups).toContainEqual([310, '00017F80FF']); expect(node(doc.snapshot, 'oracle-record').groups).toContainEqual([1, 'Payload F0A is literal text']);
    doc.undo(); expect(doc.snapshot).toBe(before); expect(node(doc.snapshot, 'oracle-record').groups).toEqual(groups);
  });
});

describe('metadata copy batches and dependency remapping', () => {
  it('clones each selected owned subtree and remaps copied peer references while leaving arbitrary handles literal', () => {
    const doc = new Drawing(fixture()), before = doc.snapshot;
    doc.addEntities([translated(before, 'a', 'a1'), translated(before, 'b', 'b1')], false, { cloneBatches: [{ entityIds: { a: 'a1', b: 'b1' } }] });
    const graph = doc.snapshot.cadGraph!, a1 = doc.entity('a1')!, b1 = doc.entity('b1')!;
    expect(a1.cadIdentity).not.toBe('src:a'); expect(b1.cadIdentity).not.toBe('src:b');
    const root = node(doc.snapshot, a1.cadIdentity!), dict = node(doc.snapshot, root.references![0]!.target!), record = node(doc.snapshot, dict.references![1]!.target!);
    expect(record.references!.find((ref) => ref.groupIndex === 4)!.target).toBe(b1.cadIdentity);
    expect(record.references!.find((ref) => ref.groupIndex === 5)!.target).toBe('src:external'); expect(record.groups[5]).toEqual([320, '30']);
    expect(graph.nodes.filter((node) => !before.cadGraph!.nodes.includes(node)).every((node) => node.sourceHandle === undefined)).toBe(true);
    expect(node(doc.snapshot, 'src:record').references![1]!.target).toBe('src:b');
    const copied = doc.snapshot; doc.undo(); expect(doc.snapshot).toBe(before); doc.redo(); expect(doc.snapshot).toBe(copied);
  });
  it('uses separate array-cell maps instead of a single ambiguous old-to-new mapping', () => {
    const doc = new Drawing(fixture()), before = doc.snapshot;
    doc.addEntities(['1', '2'].flatMap((suffix) => [translated(before, 'a', `a${suffix}`), translated(before, 'b', `b${suffix}`)]), false, { cloneBatches: [{ entityIds: { a: 'a1', b: 'b1' } }, { entityIds: { a: 'a2', b: 'b2' } }] });
    for (const suffix of ['1', '2']) {
      const root = node(doc.snapshot, doc.entity(`a${suffix}`)!.cadIdentity!), dict = node(doc.snapshot, root.references![0]!.target!), record = node(doc.snapshot, dict.references![1]!.target!);
      expect(record.references!.find((ref) => ref.groupIndex === 4)!.target).toBe(doc.entity(`b${suffix}`)!.cadIdentity);
    }
  });
  it('cross-document copies clear external soft links with a diagnostic, preserving arbitrary literal values', () => {
    const source = fixture(), target = new Drawing();
    target.addEntities([translated(source, 'a', 'a1')], false, { cloneBatches: [{ entityIds: { a: 'a1' }, sourceState: source }] });
    const root = node(target.snapshot, target.entity('a1')!.cadIdentity!), dict = node(target.snapshot, root.references![0]!.target!), record = node(target.snapshot, dict.references![1]!.target!);
    expect(record.groups[4]).toEqual([1005, '0']); expect(record.references![1]!.target).toBeUndefined(); expect(record.groups[5]).toEqual([320, '30']); expect(record.references![2]!.target).toBeUndefined();
    expect(target.snapshot.cadGraph!.diagnostics![0]!.message).toMatch(/external source reference.*set to 0/);
    expect(node(source, 'src:record').groups[4]).toEqual([1005, '10']);
  });
  it('cross-document hard links require a copied dependency or an existing matched target anchor', () => {
    const source = fixture(); const raw = node(source, 'src:record');
    const hardSource = { ...source, cadGraph: { ...source.cadGraph!, nodes: source.cadGraph!.nodes.map((node) => node === raw ? { ...node, groups: [...node.groups, [340, '10'] as const], references: [...node.references!, { groupIndex: 6, kind: 'hard-pointer' as const, target: 'src:b' }] } : node) } };
    const target = new Drawing(), before = target.snapshot;
    expect(() => target.addEntities([translated(hardSource, 'a', 'a1')], false, { cloneBatches: [{ entityIds: { a: 'a1' }, sourceState: hardSource }] })).toThrow(/hard reference.*outside the copied set/);
    expect(target.snapshot).toBe(before);
    target.addEntities([translated(hardSource, 'a', 'a1'), translated(hardSource, 'b', 'b1')], false, { cloneBatches: [{ entityIds: { a: 'a1', b: 'b1' }, sourceState: hardSource }] });
    expect(target.entity('b1')!.cadIdentity).not.toBe('src:b');
  });
  it('the standalone clone helper also supports captured cross-document graph state', () => {
    const source = fixture(), target = { ...new Drawing().snapshot, entities: [translated(source, 'a', 'a1')] };
    const copied = cloneCadEntitySets(target, [{ entityIds: { a: 'a1' }, sourceState: source }]);
    expect(copied.entities[0]!.cadIdentity).not.toBe('src:a'); validateCadGraph(copied.cadGraph!);
  });
  it('refuses to duplicate unresolved hard dependencies, even within the same drawing', () => {
    const base = fixture(), raw = node(base, 'src:record'), graph = { ...base.cadGraph!, nodes: base.cadGraph!.nodes.map((node) => node === raw ? { ...node, groups: [...node.groups, [340, 'DEAD'] as const], references: [...node.references!, { groupIndex: 6, kind: 'hard-pointer' as const, sourceHandle: 'DEAD' }] } : node) };
    const source = { ...base, cadGraph: graph }, doc = new Drawing(source), before = doc.snapshot;
    expect(() => doc.addEntities([translated(source, 'a', 'a1')], false, { cloneBatches: [{ entityIds: { a: 'a1' } }] })).toThrow(/unresolved hard reference/); expect(doc.snapshot).toBe(before);
  });
  it('carries required CLASSES definitions across documents, reuses compatible definitions and refuses conflicts', () => {
    const definition: CadNode = { id: 'class', type: 'CLASS', section: 'CLASSES', anchor: { kind: 'raw' }, groups: [[1, 'XRECORD'], [2, 'AcDbXrecord'], [3, 'ObjectDBX Classes'], [90, '0'], [91, '1']] };
    const source = fixture([definition]); const copied = cloneCadEntitySets({ ...new Drawing().snapshot, entities: [translated(source, 'a', 'a1')] }, [{ sourceState: source, entityIds: { a: 'a1' } }]);
    expect(copied.cadGraph!.nodes.filter((node) => node.section === 'CLASSES')).toHaveLength(1);
    const targetClass = { ...definition, id: 'destination-class', groups: definition.groups.map((pair) => pair[0] === 91 ? [91, '22'] as const : pair) };
    const target = { ...new Drawing().snapshot, entities: [translated(source, 'a', 'a1')], cadGraph: { schema: 1 as const, sourceFormat: 'DXF' as const, nodes: [targetClass] } };
    expect(cloneCadEntitySets(target, [{ sourceState: source, entityIds: { a: 'a1' } }]).cadGraph!.nodes.filter((node) => node.section === 'CLASSES')).toEqual([targetClass]);
    const conflict = { ...target, cadGraph: { ...target.cadGraph, nodes: [{ ...targetClass, groups: [[1, 'XRECORD'] as const, [2, 'OtherClass'] as const] }] } };
    expect(() => cloneCadEntitySets(conflict, [{ sourceState: source, entityIds: { a: 'a1' } }])).toThrow(/conflicting CAD class/);
  });
});

describe('erase, fields and immutable metadata dependencies', () => {
  it('copies and prunes native FIELDLIST membership/count with exact undo for overrides', () => {
    const text: TextEntity = { id: 't', cadIdentity: 'text', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left', text: 'Cached', field: { code: '%<\\AcVar Filename>%', value: 'Cached', native: true } };
    const graph: CadGraph = { schema: 1, sourceFormat: 'DWG', nodes: [
      { id: 'text', sourceHandle: 'A', type: 'TEXT', section: 'ENTITIES', anchor: { kind: 'entity', id: 't' }, baselineEntity: text, groups: [[360, 'B']], references: [{ groupIndex: 0, kind: 'hard-owner', role: 'extension', target: 'dict' }] },
      { id: 'dict', sourceHandle: 'B', type: 'DICTIONARY', section: 'OBJECTS', groups: [[3, 'ACAD_FIELD'], [360, 'C']], references: [{ groupIndex: 1, kind: 'hard-owner', target: 'field-dict' }] },
      { id: 'field-dict', sourceHandle: 'C', type: 'DICTIONARY', section: 'OBJECTS', groups: [[3, 'TEXT'], [360, 'D']], references: [{ groupIndex: 1, kind: 'hard-owner', target: 'field' }] },
      { id: 'field', sourceHandle: 'D', type: 'FIELD', section: 'OBJECTS', groups: [[2, '\\AcVar Filename']] },
      { id: 'list', sourceHandle: 'E', type: 'FIELDLIST', section: 'OBJECTS', groups: [[100, 'AcDbFieldList'], [90, '1'], [330, 'D']], references: [{ groupIndex: 2, kind: 'soft-pointer', target: 'field' }] },
    ] };
    const doc = new Drawing({ entities: [text], cadGraph: graph }), before = doc.snapshot;
    doc.addEntities([{ ...text, id: 'copy' }], false, { cloneBatches: [{ entityIds: { t: 'copy' } }] });
    expect(node(doc.snapshot, 'list').groups.find(([code]) => code === 90)).toEqual([90, '2']);
    expect(node(doc.snapshot, 'list').references!.every(ref => node(doc.snapshot, ref.target!).type === 'FIELD')).toBe(true);
    doc.undo(); expect(doc.snapshot).toBe(before);
    doc.replaceEntities([{ ...text, text: 'Manual', field: undefined }]);
    expect(node(doc.snapshot, 'list').groups).toEqual([[100, 'AcDbFieldList'], [90, '0']]); expect(node(doc.snapshot, 'list').references).toEqual([]);
    doc.undo(); expect(doc.snapshot).toBe(before);
  });
  const aliasState = (): DrawingState => {
    const source = fixture(), record = node(source, 'src:record');
    return { ...source, cadGraph: { ...source.cadGraph!, nodes: source.cadGraph!.nodes.map(value => value === record ? { ...record, groups: record.groups.map((pair, index) => index === 1 ? [330, '82'] as const : pair), references: record.references!.map(ref => ref.role === 'owner' ? { ...ref, target: 'canonical-owner' } : ref) } : value).concat([{ id: 'canonical-owner', sourceHandle: '82', type: 'DICTIONARY', section: 'OBJECTS', groups: [[3, 'SharedData'], [350, '81']], references: [{ groupIndex: 1, kind: 'soft-owner', target: 'src:record' }] }]) } };
  };
  it('erasing an aliasing extension dictionary leaves another application canonical owner and object intact', () => {
    const doc = new Drawing(aliasState()); doc.removeEntities(['a']);
    expect(node(doc.snapshot, 'src:dict')).toBeUndefined(); expect(node(doc.snapshot, 'src:record')).toBeDefined(); expect(node(doc.snapshot, 'canonical-owner').groups).toEqual([[3, 'SharedData'], [350, '81']]);
  });
  it('cross-document soft-owned aliases remove their dictionary name/edge together with a contextual warning', () => {
    const source = aliasState(), target = new Drawing();
    target.addEntities([translated(source, 'a', 'a1')], false, { cloneBatches: [{ entityIds: { a: 'a1' }, sourceState: source }] });
    const root = node(target.snapshot, target.entity('a1')!.cadIdentity!), dictionary = node(target.snapshot, root.references![0]!.target!);
    expect(dictionary.groups).toEqual([[5, '80'], [330, handleA]]); expect(dictionary.references).toHaveLength(1);
    expect(target.snapshot.cadGraph!.nodes.some(node => node.type === 'XRECORD')).toBe(false); expect(target.snapshot.cadGraph!.diagnostics![0]!.message).toMatch(/dictionary entry.*removed/);
  });
  it('erases an entity and its owned metadata; repairs soft refs and retains unrelated objects', () => {
    const doc = new Drawing(fixture()); doc.removeEntities(['b']);
    expect(node(doc.snapshot, 'src:record').groups[4]).toEqual([1005, '0']);
    doc.removeEntities(['a']); expect(doc.snapshot.cadGraph!.nodes.map((node) => node.id)).toEqual(['src:external']);
    doc.undo(); expect(doc.snapshot.cadGraph!.nodes.map((node) => node.id)).toContain('src:dict');
  });
  it('hard incoming dependencies refuse erase and preserve dirty/history state', () => {
    const watcher: CadNode = { id: 'watcher', type: 'XRECORD', section: 'OBJECTS', groups: [[340, handleA]], references: [{ groupIndex: 0, kind: 'hard-pointer', target: 'src:a' }] };
    const doc = new Drawing(fixture([watcher])), before = doc.snapshot;
    expect(() => doc.removeEntities(['a'])).toThrow(/XRECORD group 340.*hard dependency/);
    expect(doc.snapshot).toBe(before); expect(doc.dirty).toBe(false); expect(doc.canUndo()).toBe(false);
  });
  it('known GROUP membership is removed on erase without retaining a dangling handle', () => {
    const group: CadNode = { id: 'group', type: 'GROUP', section: 'OBJECTS', groups: [[300, 'Selected objects'], [340, handleA], [340, '10']], references: [{ groupIndex: 1, kind: 'hard-pointer', target: 'src:a' }, { groupIndex: 2, kind: 'hard-pointer', target: 'src:b' }] };
    const doc = new Drawing(fixture([group])); doc.removeEntities(['a']);
    expect(node(doc.snapshot, 'group').groups).toEqual([[300, 'Selected objects'], [340, '10']]); expect(node(doc.snapshot, 'group').references![0]!.groupIndex).toBe(1); validateCadGraph(doc.snapshot.cadGraph!);
  });
  it('removes logically owned attribute/annotation records even when their source owner points at a block record', () => {
    const part: CadNode = { id: 'attribute', type: 'ATTRIB', section: 'ENTITIES', anchor: { kind: 'entity', id: 'a', part: 'attribute:TAG' }, groups: [] }, doc = new Drawing(fixture([part]));
    doc.removeEntities(['a']); expect(doc.snapshot.cadGraph!.nodes.some((node) => node.id === 'attribute')).toBe(false);
  });
  it('manual text invalidates only ACAD_FIELD metadata; field reevaluation and other app entries remain', () => {
    const base = fixture(), text: TextEntity = { id: 'a', cadIdentity: 'src:a', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, rotation: 0, align: 'left', height: 1, text: 'cached', field: { code: '%<\\AcVar Filename>%', value: 'cached' } };
    const graph: CadGraph = { ...base.cadGraph!, nodes: base.cadGraph!.nodes.map((node) => node.id === 'src:a' ? { ...node, type: 'TEXT', baselineEntity: text } : node.id === 'src:dict' ? { ...node, groups: [...node.groups, [3, 'ACAD_FIELD'] as const, [350, '90'] as const], references: [...node.references!, { groupIndex: 5, kind: 'soft-owner' as const, target: 'field-dict' }] } : node).concat([
      { id: 'field-dict', sourceHandle: '90', type: 'DICTIONARY', section: 'OBJECTS', anchor: { kind: 'dictionary', path: ['a', 'ACAD_FIELD'] }, groups: [[330, '80'], [3, 'TEXT'], [360, '91']], references: [{ groupIndex: 0, kind: 'soft-pointer', target: 'src:dict', role: 'owner' }, { groupIndex: 2, kind: 'hard-owner', target: 'field' }] },
      { id: 'field', sourceHandle: '91', type: 'FIELD', section: 'OBJECTS', groups: [[330, '90'], [2, '%<\\AcVar Filename>%']], references: [{ groupIndex: 0, kind: 'soft-pointer', target: 'field-dict', role: 'owner' }] },
      { id: 'unrelated-field', sourceHandle: '92', type: 'FIELD', section: 'OBJECTS', groups: [[330, '81'], [2, 'Application-specific field data']], references: [{ groupIndex: 0, kind: 'soft-pointer', target: 'src:record', role: 'owner' }] },
    ]) };
    const state = { ...base, entities: [text, ...base.entities.slice(1)], cadGraph: graph }, doc = new Drawing(state);
    doc.replaceEntities([{ ...text, text: 'new cached', field: { ...text.field!, value: 'new cached' } }]); expect(node(doc.snapshot, 'field')).toBeDefined();
    doc.replaceEntities([{ ...text, text: 'manual' }]); expect(graphOf(doc.snapshot)!.nodes.some((node) => node.id === 'field')).toBe(false);
    expect(node(doc.snapshot, 'src:dict').groups).toEqual([[5, '80'], [330, handleA], [3, 'APP_DATA'], [350, '81']]); expect(node(doc.snapshot, 'src:record')).toBeDefined(); expect(node(doc.snapshot, 'unrelated-field')).toBeDefined();
    doc.undo(); expect(node(doc.snapshot, 'field')).toBeDefined();
  });
  it('removed table and viewport anchors honor retained incoming hard dependencies', () => {
    const base = fixture(), table: CadNode = { id: 'layer', type: 'LAYER', section: 'TABLES', anchor: { kind: 'table', table: 'LAYER', name: 'EXTRA' }, groups: [] };
    const watcher: CadNode = { id: 'watcher', type: 'XRECORD', section: 'OBJECTS', groups: [[340, '99']], references: [{ groupIndex: 0, kind: 'hard-pointer', target: 'layer' }] };
    const state = { ...base, layers: [...base.layers, { name: 'EXTRA', color: 7, visible: true, locked: false, lineWeight: 0.25 }], cadGraph: { ...base.cadGraph!, nodes: [...base.cadGraph!.nodes, table, watcher] } }, doc = new Drawing(state), before = doc.snapshot;
    expect(() => doc.removeLayers(['EXTRA'])).toThrow(/hard dependency/); expect(doc.snapshot).toBe(before);
  });
});

describe('documented XDATA transform semantics', () => {
  const data: readonly CadGroup[] = [[1, 'opaque'], [1011, '44'], [1001, 'APP'], [1010, '1'], [1020, '2'], [1030, '3'], [1011, '1'], [1021, '2'], [1031, '3'], [1012, '1'], [1022, '2'], [1032, '3'], [1013, '1'], [1023, '0'], [1033, '0'], [1040, '7'], [1041, '4'], [1042, '5'], [1004, 'ABCDEF'], [1000, 'handle FFFFFFFFFFFFFFFF stays literal']];
  it('moves only world positions and scales XYZ positions/displacements/distances without scaling directions', () => {
    const translated = transformCadGroups(data, { xx: 1, xy: 0, yx: 0, yy: 1, tx: 10, ty: -5 });
    expect(translated.slice(6, 9)).toEqual([[1011, '11'], [1021, '-3'], [1031, '3']]); expect(translated.slice(9, 15)).toEqual(data.slice(9, 15));
    const scaled = transformCadGroups(data, { xx: 2, xy: 0, yx: 0, yy: 2, zz: 2, tx: 0, ty: 0, distanceScale: 2 });
    expect(scaled.slice(6, 12)).toEqual([[1011, '2'], [1021, '4'], [1031, '6'], [1012, '2'], [1022, '4'], [1032, '6']]); expect(scaled.slice(12, 15)).toEqual(data.slice(12, 15));
    expect(scaled.slice(15, 18)).toEqual([[1040, '7'], [1041, '8'], [1042, '10']]); expect(scaled.slice(0, 6)).toEqual(data.slice(0, 6)); expect(scaled.slice(18)).toEqual(data.slice(18));
  });
  it('rotates and mirrors direction vectors while preserving Z unless the transform explicitly changes it', () => {
    const rotated = transformCadGroups(data, { xx: 0, xy: -1, yx: 1, yy: 0, tx: 0, ty: 0 });
    expect(rotated.slice(6, 9)).toEqual([[1011, '-2'], [1021, '1'], [1031, '3']]); expect(rotated.slice(12, 15)).toEqual([[1013, '0'], [1023, '1'], [1033, '0']]);
    const mirrored = transformCadGroups(data, { xx: -1, xy: 0, yx: 0, yy: 1, tx: 0, ty: 0 }); expect(mirrored.slice(12, 15)).toEqual([[1013, '-1'], [1023, '0'], [1033, '0']]);
    expect(() => transformCadGroups(data, { xx: 2, xy: 0, yx: 0, yy: 1, tx: 0, ty: 0 })).toThrow(/nonuniform/);
  });
  it('transform edit intent updates owned metadata atomically and undo restores exact groups', () => {
    const base = fixture(), graph = { ...base.cadGraph!, nodes: base.cadGraph!.nodes.map((node) => node.id === 'src:record' ? { ...node, groups: [...node.groups, [1011, '1'] as const, [1021, '2'] as const, [1031, '3'] as const] } : node) }, doc = new Drawing({ ...base, cadGraph: graph }), before = doc.snapshot;
    doc.replaceEntities([translateEntity(doc.entity('a')!, { x: 10, y: -5 })], { transforms: [{ entityIds: ['a'], transform: { xx: 1, xy: 0, yx: 0, yy: 1, tx: 10, ty: -5 } }] });
    expect(node(doc.snapshot, 'src:record').groups.slice(-3)).toEqual([[1011, '11'], [1021, '-3'], [1031, '3']]); doc.undo(); expect(doc.snapshot).toBe(before);
    expect(() => reconcileCadGraph(before, { ...before, entities: before.entities.map((entity) => entity.id === 'a' ? translateEntity(entity, { x: 1, y: 0 }) : entity) }, { transforms: [{ entityIds: ['a'], transform: { xx: NaN, xy: 0, yx: 0, yy: 1, tx: 0, ty: 0 } }] })).toThrow(CadGraphError);
  });
});
