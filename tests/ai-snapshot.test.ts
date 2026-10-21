import { describe, it, expect } from 'vitest';
import type { Entity } from '../src/core/entities';
import { DEFAULT_UNITS } from '../src/core/units';
import { buildSelectionSnapshot, serializeSnapshot } from '../src/ai/snapshot';
import { AI_MAX_GEOMETRY_POINTS, AI_MAX_OBJECTS, AI_MAX_SNAPSHOT_BYTES, AI_MAX_TEXT_CHARS } from '../src/ai/limits';
import type { AiBinding, AiSnapshotSource } from '../src/ai/types';

function binding(selectionIds: string[], over: Partial<AiBinding> = {}): AiBinding {
  return {
    sessionId: 1,
    docId: 'doc-1',
    contentGeneration: 1,
    docRevision: 7,
    docLoadCount: 1,
    space: { layout: null, viewport: null },
    selectionIds,
    ...over,
  };
}

function fakeSource(entities: Entity[], ids: string[], over: Partial<AiBinding> = {}): AiSnapshotSource {
  return {
    binding: () => binding(ids, over),
    units: () => ({ ...DEFAULT_UNITS, insunits: 1 }),
    selectedEntities: () => entities.filter((e) => ids.includes(e.id)),
    entityById: (id) => entities.find((e) => e.id === id),
    boundsFor: () => null,
    missingIdKind: (id) => (id.startsWith('solid') ? 'unsupported-object' : 'missing-object'),
  };
}

const line: Entity = {
  type: 'line', id: 'e-line', layer: 'WIRES', color: 'ByLayer',
  a: { x: 0, y: 0 }, b: { x: 3, y: 4 },
};
const circle: Entity = {
  type: 'circle', id: 'e-circle', layer: 'SYMS', color: 'ByLayer',
  center: { x: 10, y: 10 }, radius: 2,
};
const text: Entity = {
  type: 'text', id: 'e-text', layer: 'TAGS', color: 'ByLayer',
  position: { x: 1, y: 2 }, text: 'PB101 START', height: 2.5, rotation: 0, align: 'left',
};
const insert: Entity = {
  type: 'insert', id: 'e-insert', layer: 'SYMS', color: 'ByLayer',
  block: 'PB', position: { x: 5, y: 5 }, rotation: 0, scale: 1,
  attributes: { TAG1: 'PB101', DESC1: 'Start pushbutton' },
  hiddenAttributes: ['DESC1'],
};

describe('AI selection snapshot', () => {
  it('includes units, ids, geometry, layers and permitted text', () => {
    const snap = buildSelectionSnapshot(fakeSource([line, circle, text], ['e-line', 'e-circle', 'e-text']));
    expect(snap.kind).toBe('jcad.ai.selection-snapshot');
    expect(snap.units).toMatchObject({ insunits: 1, insunitsName: 'Inches' });
    expect(snap.space).toEqual({ kind: 'model' });
    expect(snap.selection).toMatchObject({ total: 3, included: 3, omittedCount: 0 });
    const lineSnap = snap.objects.find((o) => o.id === 'e-line')!;
    expect(lineSnap.layer).toBe('WIRES');
    expect(lineSnap.geometry.length).toBe(5);
    const textSnap = snap.objects.find((o) => o.id === 'e-text')!;
    expect(textSnap.text).toBe('PB101 START');
    expect(snap.serializedBytes).toBe(new TextEncoder().encode(serializeSnapshot(snap)).length);
  });

  it('includes insert attributes sorted by tag and flags hidden ones', () => {
    const snap = buildSelectionSnapshot(fakeSource([insert], ['e-insert']));
    const obj = snap.objects[0]!;
    expect(obj.attributes).toEqual([
      { tag: 'DESC1', value: 'Start pushbutton', hidden: true },
      { tag: 'TAG1', value: 'PB101' },
    ]);
    expect(obj.geometry.block).toBe('PB');
  });

  it('reports unsupported and missing selection ids instead of dropping them', () => {
    const snap = buildSelectionSnapshot(fakeSource([line], ['e-line', 'solid-9', 'ghost-1']));
    expect(snap.selection.total).toBe(3);
    expect(snap.selection.included).toBe(1);
    expect(snap.selection.omitted).toEqual([
      { id: 'solid-9', reason: 'unsupported-object' },
      { id: 'ghost-1', reason: 'missing-object' },
    ]);
  });

  it('records the active layout space by value', () => {
    const snap = buildSelectionSnapshot(fakeSource([line], ['e-line'], {
      space: { layout: 'Sheet 1', viewport: 'vp-2' },
    }));
    expect(snap.space).toEqual({ kind: 'layout', layout: 'Sheet 1', viewport: 'vp-2' });
  });

  it('truncates over-long text with an explicit note', () => {
    const long: Entity = { ...text, id: 'e-long', text: 'x'.repeat(AI_MAX_TEXT_CHARS + 50) };
    const snap = buildSelectionSnapshot(fakeSource([long], ['e-long']));
    expect(snap.objects[0]!.text).toHaveLength(AI_MAX_TEXT_CHARS);
    expect(snap.objects[0]!.notes?.join(' ')).toContain('truncated');
  });

  it('caps the object count and reports the rest as object-limit', () => {
    const many: Entity[] = Array.from({ length: AI_MAX_OBJECTS + 5 }, (_, i) => ({
      type: 'point', id: `p-${i}`, layer: '0', color: 'ByLayer', position: { x: i, y: 0 },
    }));
    const snap = buildSelectionSnapshot(fakeSource(many, many.map((e) => e.id)));
    expect(snap.selection.included).toBe(AI_MAX_OBJECTS);
    expect(snap.selection.omittedCount).toBe(5);
    expect(snap.selection.omitted.every((o) => o.reason === 'object-limit')).toBe(true);
  });

  it('enforces the serialized byte cap by omitting whole objects from the end', () => {
    const fat: Entity[] = Array.from({ length: AI_MAX_OBJECTS }, (_, i) => ({
      type: 'text', id: `t-${i}`, layer: 'TAGS', color: 'ByLayer',
      position: { x: i, y: i }, text: 'y'.repeat(AI_MAX_TEXT_CHARS), height: 2.5, rotation: 0, align: 'left',
    }));
    const snap = buildSelectionSnapshot(fakeSource(fat, fat.map((e) => e.id)));
    expect(snap.serializedBytes).toBeLessThanOrEqual(AI_MAX_SNAPSHOT_BYTES);
    expect(new TextEncoder().encode(serializeSnapshot(snap)).length).toBe(snap.serializedBytes);
    expect(snap.selection.included).toBeLessThan(AI_MAX_OBJECTS);
    expect(snap.selection.omitted.some((o) => o.reason === 'byte-limit')).toBe(true);
    expect(snap.selection.included + snap.selection.omittedCount).toBe(snap.selection.total);
  });

  it('keeps omission metadata bounded without changing reference ids or counts', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `${i}-${'雪'.repeat(250)}`);
    const snap = buildSelectionSnapshot(fakeSource([], ids));
    expect(snap.selection.omittedCount).toBe(100);
    expect(snap.selection.omittedListTruncated).toBe(true);
    expect(snap.selection.omitted.every(({ id }) => ids.includes(id))).toBe(true);
    expect(new TextEncoder().encode(serializeSnapshot(snap)).length).toBe(snap.serializedBytes);
    expect(snap.serializedBytes).toBeLessThanOrEqual(AI_MAX_SNAPSHOT_BYTES);
  });

  it('reports impossible root metadata as a controlled context error', () => {
    const source = fakeSource([], [], { space: { layout: '雪'.repeat(AI_MAX_SNAPSHOT_BYTES), viewport: null } });
    expect(() => buildSelectionSnapshot(source)).toThrow('drawing space metadata exceeds');
  });

  it('measures bulged and closed two-vertex polylines using their actual arcs', () => {
    const semicircle: Entity = {
      type: 'polyline', id: 'semi', layer: '0', color: 'ByLayer',
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }], closed: false, bulges: [1, 0],
    };
    const full: Entity = { ...semicircle, id: 'full', closed: true, bulges: [1, 1] };
    const snap = buildSelectionSnapshot(fakeSource([semicircle, full], ['semi', 'full']));
    expect(snap.objects[0]!.geometry.length).toBeCloseTo(Math.PI);
    expect(snap.objects[1]!.geometry.length).toBeCloseTo(2 * Math.PI);
  });

  it('samples large geometry without walking its remaining vertices or generic bounds', () => {
    const points = Array.from({ length: AI_MAX_GEOMETRY_POINTS + 1 }, (_, x) => ({ x, y: 0 }));
    Object.defineProperty(points, AI_MAX_GEOMETRY_POINTS, {
      get: () => { throw new Error('unbounded geometry was read'); },
    });
    const large: Entity = { type: 'polyline', id: 'large', layer: '0', color: 'ByLayer', points, closed: false };
    const source = fakeSource([large], ['large']);
    source.boundsFor = () => { throw new Error('generic bounds expanded geometry'); };
    const obj = buildSelectionSnapshot(source).objects[0]!;
    expect(obj.geometry.vertexCount).toBe(AI_MAX_GEOMETRY_POINTS + 1);
    expect(obj.geometry.length).toBeUndefined();
    expect(obj.notes?.join(' ')).toContain('measurement work limit');
  });

  it('bounds table scans even when the initial cells are blank', () => {
    const row = Array.from({ length: 65 }, () => ({ text: '' }));
    Object.defineProperty(row, 64, { get: () => { throw new Error('table scan exceeded its budget'); } });
    const table: Entity = {
      type: 'table', id: 'table', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 },
      cells: [row], rowHeights: [1], columnWidths: Array.from({ length: 65 }, () => 1),
      rotation: 0, textHeight: 0.2,
    };
    const source = fakeSource([table], ['table']);
    source.boundsFor = () => { throw new Error('generic table bounds expanded geometry'); };
    const obj = buildSelectionSnapshot(source).objects[0]!;
    expect(obj.geometry.columns).toBe(65);
    expect(obj.tableText).toEqual([]);
    expect(obj.notes?.join(' ')).toContain('later cell texts not included');
  });

  it('excludes inherited attributes and bounds names, tags and values explicitly', () => {
    const attributes = Object.assign(Object.create({ inherited: 'foreign-secret' }) as Record<string, string>, {
      ['tag'.repeat(400)]: 'value'.repeat(400),
    });
    const long: Entity = { ...insert, layer: 'layer'.repeat(400), block: 'block'.repeat(400), attributes };
    const snap = buildSelectionSnapshot(fakeSource([long], [long.id]));
    const obj = snap.objects[0]!;
    expect(serializeSnapshot(snap)).not.toContain('foreign-secret');
    expect(obj.attributes).toHaveLength(1);
    expect(obj.attributes![0]!.tag).toHaveLength(AI_MAX_TEXT_CHARS);
    expect(obj.attributes![0]!.value).toHaveLength(AI_MAX_TEXT_CHARS);
    expect(obj.layer).toHaveLength(AI_MAX_TEXT_CHARS);
    expect(obj.geometry.block).toHaveLength(AI_MAX_TEXT_CHARS);
    expect(obj.notes?.join(' ')).toContain('attribute tag: text truncated');
  });

  it('never includes image paths or field expressions', () => {
    const image: Entity = {
      type: 'image', id: 'e-img', layer: '0', color: 'ByLayer',
      path: 'C:\\secret\\client-logo.png', position: { x: 0, y: 0 },
      u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, size: { x: 10, y: 5 },
    };
    const fieldText: Entity = {
      ...text, id: 'e-field',
      field: { code: '%<\\AcVar Login>%', value: 'admin' },
    };
    const snap = buildSelectionSnapshot(fakeSource([image, fieldText], ['e-img', 'e-field']));
    const serialized = serializeSnapshot(snap);
    expect(serialized).not.toContain('client-logo');
    expect(serialized).not.toContain('AcVar');
    expect(serialized).not.toContain('admin');
    expect(snap.objects.find((o) => o.id === 'e-img')!.notes?.join(' ')).toContain('not included');
  });

  it('is deterministic for the same source state', () => {
    const source = fakeSource([line, circle, text, insert], ['e-line', 'e-circle', 'e-text', 'e-insert']);
    expect(serializeSnapshot(buildSelectionSnapshot(source)))
      .toBe(serializeSnapshot(buildSelectionSnapshot(source)));
  });

  it('handles an empty selection explicitly', () => {
    const snap = buildSelectionSnapshot(fakeSource([], []));
    expect(snap.selection).toMatchObject({ total: 0, included: 0, omittedCount: 0 });
    expect(snap.objects).toEqual([]);
  });
});
