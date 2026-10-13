import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Drawing, type DrawingState } from '../src/core/document';
import { translateEntity, type Entity, type LineEntity } from '../src/core/entities';
import { CadGraphError, type CadGraphEditIntent, type CadNode } from '../src/core/cad-graph';
import { defaultLayout } from '../src/core/layouts';
import { Writer, writeEntityCommon } from '../src/io/dxf/write-core';
import { readDxf, writeDxf } from '../src/io/dxf';
import { objects, tokenize } from '../src/io/dxf/groups';
import { attachDxfCadGraph } from '../src/io/cad-graph-dxf';

const line = (id: string): LineEntity => ({
  id, cadIdentity: `src:${id}`, type: 'line', layer: '0', color: 'ByLayer',
  a: { x: 1, y: 2 }, b: { x: 4, y: 2 },
});
const retained = (entity: Entity, handle: string): CadNode => ({
  id: entity.cadIdentity!, sourceHandle: handle, type: 'LINE', section: 'ENTITIES',
  anchor: { kind: 'entity', id: entity.id }, baselineEntity: entity,
  groups: [[5, handle], [1001, 'SCOPED'], [1011, '1'], [1021, '2'], [1031, '3']],
});
function drawing(): Drawing {
  const model = line('model'), paper = line('paper');
  return new Drawing({
    entities: [model], layouts: [{ ...defaultLayout('Paper'), entities: [paper] }],
    space: { layout: 'Paper' },
    cadGraph: { schema: 1, sourceFormat: 'DXF', nodes: [retained(model, 'A'), retained(paper, 'B')] },
  });
}
const metadata = (state: DrawingState, id: string) => state.cadGraph!.nodes.find(node => node.anchor?.kind === 'entity' && node.anchor.id === id)!;
const translation = (id: string, tx = 10): CadGraphEditIntent => ({
  transforms: [{ entityIds: [id], transform: { xx: 1, xy: 0, yx: 0, yy: 1, tx, ty: -5 } }],
});
const scope = (doc: Drawing, where: 'paper' | 'drawing', transition: (s: DrawingState) => DrawingState, intent: CadGraphEditIntent) => {
  if (where === 'paper') doc.transact(transition, intent);
  else doc.transactDrawing(transition, intent);
};

describe('combined scoped transactions and retained CAD graph', () => {
  it.each(['paper', 'drawing'] as const)('forwards transform intent in %s scope and restores exact snapshots', where => {
    const doc = drawing(), before = doc.snapshot, id = where === 'paper' ? 'paper' : 'model';
    scope(doc, where, state => ({ ...state, entities: state.entities.map(entity => translateEntity(entity, { x: 10, y: -5 })) }), translation(id));
    const after = doc.snapshot;
    expect(metadata(after, id).groups.slice(-3)).toEqual([[1011, '11'], [1021, '-3'], [1031, '3']]);
    const unchanged = where === 'paper' ? 'model' : 'paper';
    expect(metadata(after, unchanged)).toBe(metadata(before, unchanged));
    if (where === 'paper') expect(after.entities).toBe(before.entities);
    else expect(after.layouts).toBe(before.layouts);
    expect(doc.space).toBe(before.space);
    expect(doc.history().undo).toHaveLength(1);
    expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before);
    expect(doc.redo()).toBe(true); expect(doc.snapshot).toBe(after);
  });

  it.each(['paper', 'drawing'] as const)('declares copies with cloned metadata in %s scope', where => {
    const doc = drawing(), before = doc.snapshot, id = where === 'paper' ? 'paper' : 'model';
    const source = where === 'paper' ? doc.entities[0]! : doc.snapshot.entities[0]!;
    const copy = { ...translateEntity(source, { x: 10, y: -5 }), id: `${id}-copy` };
    scope(doc, where, state => ({ ...state, entities: [...state.entities, copy] }), {
      cloneBatches: [{ entityIds: { [id]: copy.id }, transform: translation(id).transforms![0]!.transform }],
    });
    const after = doc.snapshot, copied = metadata(after, copy.id);
    expect(copied.id).not.toBe(source.cadIdentity);
    expect(copied.groups.slice(-3)).toEqual([[1011, '11'], [1021, '-3'], [1031, '3']]);
    expect(metadata(after, id)).toBe(metadata(before, id));
    expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before);
    expect(doc.redo()).toBe(true); expect(doc.snapshot).toBe(after);
  });

  it.each(['paper', 'drawing'] as const)('rejects malformed graph edit intent atomically in %s scope', where => {
    const doc = drawing(), id = where === 'paper' ? 'paper' : 'model';
    scope(doc, where, state => ({ ...state, entities: state.entities.map(entity => translateEntity(entity, { x: 10, y: -5 })) }), translation(id));
    doc.undo(); doc.dirty = false;
    const before = doc.snapshot, history = doc.history(), revision = doc.revision;
    let notifications = 0; doc.subscribe(() => { notifications += 1; });
    expect(() => scope(doc, where, state => ({ ...state, entities: state.entities.map(entity => translateEntity(entity, { x: 1, y: 0 })) }), translation(id, NaN))).toThrow(CadGraphError);
    expect(doc.snapshot).toBe(before);
    expect(doc.history()).toEqual(history);
    expect(doc.revision).toBe(revision);
    expect(doc.dirty).toBe(false);
    expect(notifications).toBe(0);
    expect(doc.redo()).toBe(true);
  });
});

describe('reserved DXF handles and retained CAD anchors', () => {
  it('anchors the emitted reserved handle after further handle allocation', () => {
    const entity = line('clip'), writer = new Writer();
    const reserved = writer.reserveEntityHandle(entity), later = writer.nextHandle();
    writeEntityCommon(writer, entity, '1F', 'LWPOLYLINE', 'AcDbPolyline');
    expect(writer.toString()).toContain(`5\r\n${reserved}\r\n`);
    expect(writer.cadAnchors.get(reserved)).toEqual({ kind: 'entity', id: 'clip' });
    expect(writer.cadAnchors.has(later)).toBe(false);
  });
});

const clipped = (): DrawingState => readDxf(readFileSync(new URL('./fixtures/interchange/r2018-viewport-polygon.dxf', import.meta.url), 'utf8'));
function clipMetadata(): DrawingState {
  const state = clipped(), viewport = state.layouts!.find(layout => layout.name === 'Polygon')!.viewports[0]!;
  const clip = state.cadGraph!.nodes.find(node => node.anchor?.kind === 'viewport' && node.anchor.id === viewport.id && node.anchor.part === 'clip-boundary')!;
  const dictionary: CadNode = { id: 'clip:dictionary', sourceHandle: 'F00', type: 'DICTIONARY', section: 'OBJECTS',
    groups: [[5, 'F00'], [330, clip.sourceHandle!], [100, 'AcDbDictionary'], [281, '1'], [3, 'CLIP_APP'], [360, 'F01']],
    references: [{ groupIndex: 1, kind: 'soft-pointer', role: 'owner', target: clip.id }, { groupIndex: 5, kind: 'hard-owner', target: 'clip:payload' }] };
  const payload: CadNode = { id: 'clip:payload', sourceHandle: 'F01', type: 'XRECORD', section: 'OBJECTS',
    groups: [[5, 'F01'], [330, 'F00'], [100, 'AcDbXrecord'], [160, '9007199254740993'], [310, '00017F80FF'], [1001, 'CLIP_APP'], [1011, '1'], [1021, '2'], [1031, '3']],
    references: [{ groupIndex: 1, kind: 'soft-pointer', role: 'owner', target: dictionary.id }] };
  const groups = [...clip.groups], at = groups.findIndex(([code]) => code === 100);
  groups.splice(at, 0, [102, '{ACAD_XDICTIONARY'], [360, 'F00'], [102, '}']);
  const references = (clip.references ?? []).map(ref => ({ ...ref, groupIndex: ref.groupIndex >= at ? ref.groupIndex + 3 : ref.groupIndex }));
  references.push({ groupIndex: at + 1, kind: 'hard-owner', role: 'extension', target: dictionary.id });
  return { ...state, cadGraph: { ...state.cadGraph!, nodes: [...state.cadGraph!.nodes.map(node => node === clip ? { ...node, groups, references } : node), dictionary, payload] } };
}

describe('polygon viewport clips with retained native metadata', () => {
  it.each(['viewport mapping', 'clip pointer'] as const)('refuses a consumed clip with a mismatched %s association', mismatch => {
    const source = clipped(), layout = source.layouts!.find(layout => layout.name === 'Polygon')!;
    const base = new Drawing({ layouts: [{ ...layout, viewports: [{ ...layout.viewports[0]!, id: 'v' }] }] }).snapshot;
    const pairs = tokenize(writeDxf(base)), records = objects(pairs, 0, pairs.length);
    const viewport = records.find(record => record.kind === 'VIEWPORT' && record.groups.some(pair => pair.code === 69 && pair.value.trim() === '2'))!;
    const handle = viewport.groups.find(pair => pair.code === 5)!.value.trim();
    const clipHandle = viewport.groups.find(pair => pair.code === 340)!.value.trim();
    const state = { ...base, layouts: base.layouts!.map(sheet => ({ ...sheet, viewports: sheet.viewports.map(view => ({ ...view, clipBoundary: { ...view.clipBoundary!, cadIdentity: mismatch === 'clip pointer' ? 'BAD' : clipHandle } })) })) };
    expect(() => attachDxfCadGraph(state, pairs, { viewportHandles: new Map([[handle, mismatch === 'viewport mapping' ? 'other' : 'v']]) })).toThrow(/no exact source(?:VIEWPORT|340) association/);
  });

  it('retains padded/lowercase viewport and clip handles with exact owned payloads', () => {
    const original = clipMetadata();
    const pairs = tokenize(writeDxf(original)).map(pair => {
      const handle = pair.value.trim().toUpperCase();
      if (pair.code === 5 && (handle === '11D' || handle === '11E')) return { ...pair, value: `000${handle.toLowerCase()}` };
      if (pair.code === 340 && handle === '11D') return { ...pair, value: '11d' };
      return pair;
    });
    const source = readDxf(pairs.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n');
    const viewport = source.layouts!.find(layout => layout.name === 'Polygon')!.viewports[0]!;
    expect(viewport.clipBoundary?.points).toEqual(original.layouts!.find(layout => layout.name === 'Polygon')!.viewports[0]!.clipBoundary!.points);
    expect(source.cadGraph!.nodes.find(node => node.sourceHandle === '11E')!.anchor).toEqual({ kind: 'viewport', id: viewport.id });
    expect(source.cadGraph!.nodes.find(node => node.sourceHandle === '11D')!.anchor).toEqual({ kind: 'viewport', id: viewport.id, part: 'clip-boundary' });
    const once = writeDxf(source), back = readDxf(once);
    const payload = back.cadGraph!.nodes.find(node => node.sourceHandle === 'F01')!;
    expect(payload.groups).toContainEqual([160, '9007199254740993']);
    expect(payload.groups).toContainEqual([310, '00017F80FF']);
    expect(writeDxf(back)).toBe(once);
  });

  it('keeps the actual source340 clip association and exact DXF payload after a move and repeated save', () => {
    const state = clipMetadata(), doc = new Drawing({ ...state, space: { layout: 'Polygon' } }), before = doc.snapshot;
    const viewport = doc.snapshot.layouts!.find(layout => layout.name === 'Polygon')!.viewports[0]!;
    const sourceClip = doc.snapshot.cadGraph!.nodes.find(node => node.anchor?.kind === 'viewport' && node.anchor.id === viewport.id && node.anchor.part === 'clip-boundary')!;
    expect(sourceClip.sourceHandle).toBe('11D');
    const frame = doc.entities.find(entity => entity.id === viewport.id)!;
    doc.replaceEntities([translateEntity(frame, { x: 10, y: -5 })], translation(viewport.id));
    const after = doc.snapshot, payload = after.cadGraph!.nodes.find(node => node.id === 'clip:payload')!;
    expect(payload.groups.slice(-3)).toEqual([[1011, '11'], [1021, '-3'], [1031, '3']]);
    const once = writeDxf(after), back = readDxf(once);
    const savedClip = back.cadGraph!.nodes.find(node => node.sourceHandle === '11D')!;
    const savedDictionary = back.cadGraph!.nodes.find(node => node.sourceHandle === 'F00')!;
    const savedPayload = back.cadGraph!.nodes.find(node => node.sourceHandle === 'F01')!;
    expect(savedPayload.groups).toContainEqual([160, '9007199254740993']);
    expect(savedPayload.groups).toContainEqual([310, '00017F80FF']);
    expect(savedDictionary.references!.find(ref => ref.role === 'owner')!.target).toBe(savedClip.id);
    expect(savedPayload.references!.find(ref => ref.role === 'owner')!.target).toBe(savedDictionary.id);
    expect(savedClip.references!.find(ref => ref.role === 'extension')!.target).toBe(savedDictionary.id);
    expect(writeDxf(back)).toBe(once);
    expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before);
    expect(doc.redo()).toBe(true); expect(doc.snapshot).toBe(after);
  });

  it('copies consumed clip metadata with the declared viewport remap while retaining separate native handles', () => {
    const doc = new Drawing(clipMetadata()), before = doc.snapshot;
    const source = doc.layouts.find(layout => layout.name === 'Polygon')!, viewport = source.viewports[0]!;
    const copy = { ...source, name: 'Copy', viewports: [{ ...viewport, id: 'viewport-copy' }] };
    doc.transactDrawing(state => ({ ...state, layouts: [...state.layouts!, copy] }), { cloneBatches: [{ entityIds: {}, anchorRemaps: [
      { from: { kind: 'layout', name: source.name }, to: { kind: 'layout', name: copy.name } },
      { from: { kind: 'viewport', id: viewport.id }, to: { kind: 'viewport', id: copy.viewports[0]!.id } },
    ] }] });
    const after = doc.snapshot, graph = after.cadGraph!;
    const clips = graph.nodes.filter(node => node.anchor?.kind === 'viewport' && node.anchor.part === 'clip-boundary');
    expect(clips).toHaveLength(2);
    const copiedClip = clips.find(node => node.anchor?.kind === 'viewport' && node.anchor.id === 'viewport-copy')!;
    expect(copiedClip.id).not.toBe(clips.find(node => node.sourceHandle === '11D')!.id);
    const copiedDictionary = graph.nodes.find(node => node.id === copiedClip.references!.find(ref => ref.role === 'extension')!.target)!;
    const copiedPayload = graph.nodes.find(node => node.id === copiedDictionary.references!.find(ref => ref.kind === 'hard-owner')!.target)!;
    expect(copiedPayload.groups).toContainEqual([160, '9007199254740993']);
    const back = readDxf(writeDxf(after));
    const reopened = back.cadGraph!.nodes.filter(node => node.anchor?.kind === 'viewport' && node.anchor.part === 'clip-boundary');
    expect(reopened).toHaveLength(2);
    expect(new Set(reopened.map(node => node.sourceHandle)).size).toBe(2);
    expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before);
    expect(doc.redo()).toBe(true); expect(doc.snapshot).toBe(after);
  });

  it('keeps strict refusal for a stale layout replacement that bypassed reconciliation', () => {
    const source = clipped();
    expect(() => writeDxf({ ...source, layouts: [defaultLayout('Replacement')] })).toThrow(/edited object has no generated record/);
  });

  it('does not regenerate an unexposed source340 clip pointer from a rectangular fallback', () => {
    const text = readFileSync(new URL('./fixtures/interchange/r2018-viewport-polygon.dxf', import.meta.url), 'utf8');
    const source = readDxf(text.replace(/340\r?\n11D/, '340\r\nDEAD'));
    expect(source.layouts!.find(layout => layout.name === 'Polygon')!.viewports[0]!.clipBoundary).toBeUndefined();
    expect(() => writeDxf(source)).toThrow(/hard reference DEAD was not exposed/);
  });

  it('refuses an ambiguous shared source clip before a document load can replace existing edits', () => {
    const source = clipped(), layout = source.layouts!.find(layout => layout.name === 'Polygon')!, viewport = layout.viewports[0]!;
    const plain = new Drawing({ layouts: [{ ...layout, viewports: [viewport, { ...viewport, id: 'other' }] }] });
    let kind = '', firstClip: string | undefined;
    const pairs = tokenize(writeDxf(plain.snapshot)).map(pair => {
      if (pair.code === 0) kind = pair.value.trim();
      if (kind === 'VIEWPORT' && pair.code === 340) {
        if (firstClip !== undefined) return { ...pair, value: firstClip };
        firstClip = pair.value;
      }
      return pair;
    });
    const text = pairs.flatMap(pair => [String(pair.code), pair.value]).join('\r\n') + '\r\n';
    const { cadIdentity: _identity, ...unsaved } = line('unsaved');
    const doc = new Drawing(); doc.addEntities([unsaved]);
    const before = doc.snapshot, history = doc.history(), revision = doc.revision;
    expect(() => doc.load(readDxf(text))).toThrow(/Shared source viewport clips/);
    expect(doc.snapshot).toBe(before); expect(doc.history()).toEqual(history);
    expect(doc.revision).toBe(revision); expect(doc.dirty).toBe(true);
  });

  it('removes an explicitly detached clip and its owned payload, with exact undo and no stale340', () => {
    const doc = new Drawing(clipMetadata()), before = doc.snapshot;
    doc.transactDrawing(state => ({ ...state, layouts: state.layouts!.map(layout => ({ ...layout, viewports: layout.viewports.map(viewport => {
      const { clipBoundary: _clip, ...rest } = viewport;
      return rest;
    }) })) }));
    const after = doc.snapshot;
    expect(after.cadGraph!.nodes.some(node => node.anchor?.kind === 'viewport' && node.anchor.part === 'clip-boundary')).toBe(false);
    expect(after.cadGraph!.nodes.some(node => node.id === 'clip:payload')).toBe(false);
    const back = readDxf(writeDxf(after));
    expect(back.layouts!.find(layout => layout.name === 'Polygon')!.viewports[0]!.clipBoundary).toBeUndefined();
    expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before);
    expect(doc.redo()).toBe(true); expect(doc.snapshot).toBe(after);
  });

  it('refuses to detach a clip referenced by unrelated native hard metadata', () => {
    const state = clipMetadata(), clip = state.cadGraph!.nodes.find(node => node.anchor?.kind === 'viewport' && node.anchor.part === 'clip-boundary')!;
    const dependency: CadNode = { id: 'external:dependency', sourceHandle: 'F02', type: 'XRECORD', section: 'OBJECTS', groups: [[5, 'F02'], [340, clip.sourceHandle!]], references: [{ groupIndex: 1, kind: 'hard-pointer', target: clip.id }] };
    const doc = new Drawing({ ...state, cadGraph: { ...state.cadGraph!, nodes: [...state.cadGraph!.nodes, dependency] } }), before = doc.snapshot;
    expect(() => doc.transactDrawing(current => ({ ...current, layouts: current.layouts!.map(layout => ({ ...layout, viewports: layout.viewports.map(viewport => {
      const { clipBoundary: _clip, ...rest } = viewport;
      return rest;
    }) })) }))).toThrow(/hard dependency/);
    expect(doc.snapshot).toBe(before); expect(doc.canUndo()).toBe(false);
  });
});
