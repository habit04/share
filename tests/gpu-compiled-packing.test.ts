import { describe, expect, it } from 'vitest';
import type { DrawingState } from '../src/core/document';
import type { BlockDef, Entity, InsertEntity, Layer, LineEntity, TextEntity } from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import { GPU_EDIT_ENTITY_LIMIT, GPU_ZOOM_VERTEX_STRIDE, prepareCompiledZoom2D, prepareZoomLine, replacementZoomBounds, type Gpu2DView } from '../src/render/gpu-prototype/geometry2d';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 1 };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 20, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay = { selection: new Set<string>() };
const line: LineEntity = { id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } };
const text: TextEntity = { id: 'text', type: 'text', layer: '0', color: 1, position: { x: 0, y: 0 }, text: 'TAG A1', height: 1, rotation: 0, align: 'left' };
const drawing = (entities: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}, layers: readonly Layer[] = [layer]): DrawingState => ({ entities, blocks, layers, currentLayer: '0' });

describe('compiled typed packing and original owner certificates', () => {
  it.each([1, 2])('grows beyond initial typed storage and preserves old LINE-emitter bytes at DPR%s', (dpr) => {
    const lines = Array.from({ length: 600 }, (_, index): LineEntity => ({ ...line, id: `line-${index}`, color: index % 2 ? 2 : 4, a: { x: -20 + index % 4, y: -2 + index % 5 }, b: { x: 20, y: 2 - index % 5 } }));
    const state = drawing([...lines, text]);
    const camera = { ...view, dpr, twist: 0.2, lineweights: true };
    const result = prepareCompiledZoom2D(state, camera, overlay);
    const oldLineParts = lines.map((entity) => prepareZoomLine(entity, state, camera, overlay, result.extent).vertices);
    const textPart = prepareCompiledZoom2D(drawing([text]), camera, overlay).vertices;
    const expected = new Float32Array(oldLineParts.reduce((total, part) => total + part.length, textPart.length));
    let offset = 0;
    for (const part of [...oldLineParts, textPart]) { expected.set(part, offset); offset += part.length; }
    expect(result.vertices.length).toBeGreaterThan(1024 * 3 * GPU_ZOOM_VERTEX_STRIDE);
    expect(new Uint8Array(result.vertices.buffer)).toEqual(new Uint8Array(expected.buffer));
    expect(result.vertices.byteOffset).toBe(0);
    expect(result.vertices.buffer.byteLength).toBe(result.vertices.length * Float32Array.BYTES_PER_ELEMENT);
    expect(result.entities![599]!.first + result.entities![599]!.count).toBe(result.entities![600]!.first);
  });

  it('owns ordered spans and bounds for every top-level owner while only direct visible LINEs are editable', () => {
    const block: BlockDef = {
      name: 'B', basePoint: { x: 0, y: 0 },
      entities: [{ ...line, id: 'child-line' }, { ...text, id: 'child-text', position: { x: 1000, y: 3 } }],
      attributes: [{ tag: 'LABEL', prompt: '', default: 'B2', position: { x: 0, y: 0 }, height: 1, align: 'left' }],
    };
    const insert: InsertEntity = { id: 'owner-block', type: 'insert', block: 'B', position: { x: 1, y: 0 }, rotation: 0, scale: 1, attributes: {}, color: 'ByLayer', layer: '0' };
    const hidden: Entity = { ...line, id: 'hidden', type: 'circle', layer: 'HIDDEN', center: { x: Infinity, y: Infinity }, radius: 1, filled: true };
    const remote: LineEntity = { ...line, id: 'remote', a: { x: 2000, y: 0 }, b: { x: 2001, y: 0 } };
    const zero: LineEntity = { ...line, id: 'zero', a: { x: 5, y: 2 }, b: { x: 5, y: 2 } };
    const state = sealImmutableData(drawing([hidden, text, line, insert, remote, zero, { ...text, id: 'empty', text: '' }], { B: block }, [layer, { ...layer, name: 'HIDDEN', visible: false }]));
    const result = prepareCompiledZoom2D(state, view, overlay), entries = result.entities!;
    expect(entries).toHaveLength(state.entities.length);
    expect(entries.map((entry) => entry!.editableLine)).toEqual([false, false, true, false, true, true, false]);
    let cursor = 0;
    entries.forEach((entry, index) => {
      expect(entry!.entity).toBe(state.entities[index]);
      expect(entry!.first).toBe(cursor);
      cursor += entry!.count;
    });
    expect(cursor).toBe(result.vertices.length / GPU_ZOOM_VERTEX_STRIDE);
    expect(entries[0]).toMatchObject({ first: 0, count: 0, sourceBounds: null });
    expect(entries[3]!.sourceBounds!.max.x).toBeGreaterThan(20_000); // remote block text contributes despite zero emitted glyph vertices
    expect(entries[4]).toMatchObject({ count: 0, sourceBounds: { min: { x: 40_000, y: 0 }, max: { x: 40_020, y: 0 } } });
    expect(entries[5]).toMatchObject({ count: 0, sourceBounds: { min: { x: 100, y: -40 }, max: { x: 100, y: -40 } } });
    expect(entries[6]).toMatchObject({ count: 0, sourceBounds: null });
    expect(replacementZoomBounds(entries, -1, null)).toEqual(result.sourceBounds);
    // Counts stay in visible leaves: TEXT+LINE+three block leaves+remote+zero+empty TEXT.
    expect(result.entityCount).toBe(8);
    const expectedLine = prepareZoomLine(line, state, view, overlay, result.extent);
    const first = entries[2]!.first * GPU_ZOOM_VERTEX_STRIDE;
    expect(result.vertices.slice(first, first + entries[2]!.count * GPU_ZOOM_VERTEX_STRIDE)).toEqual(expectedLine.vertices);
    expect(entries[2]!.sourceBounds).toEqual(expectedLine.sourceBounds);
    expect(entries[2]!.color).toEqual(expectedLine.color);
    expect(entries[2]!.width).toBe(expectedLine.width);
  });

  it('disables ambiguous certificates without changing successful painter output', () => {
    const original = prepareCompiledZoom2D(drawing([line, { ...line, id: 'second' }, text]), view, overlay);
    for (const id of ['line', '']) {
      const result = prepareCompiledZoom2D(drawing([line, { ...line, id }, text]), view, overlay);
      expect(result.entities).toBeNull();
      expect(result.vertices).toEqual(original.vertices);
      expect(result.sourceBounds).toEqual(original.sourceBounds);
      expect(result.entityCount).toBe(3);
    }
  });

  it('bounds source-owner certificates even when most owners are hidden', () => {
    const hidden = Array.from({ length: GPU_EDIT_ENTITY_LIMIT + 1 }, (_, index): LineEntity => ({ ...line, id: `hidden-${index}`, layer: 'HIDDEN' }));
    const result = prepareCompiledZoom2D(drawing([...hidden, text], {}, [layer, { ...layer, name: 'HIDDEN', visible: false }]), view, overlay);
    expect(result.entities).toBeNull();
    expect(result.entityCount).toBe(1);
    expect(result.vertices).toEqual(prepareCompiledZoom2D(drawing([text]), view, overlay).vertices);
  });

  it('returns exact empty storage and retains a LINE source certificate even without emitted triangles', () => {
    const zero = { ...line, a: { x: 0, y: 0 }, b: { x: 0, y: 0 } };
    const result = prepareCompiledZoom2D(drawing([zero, { ...text, text: '' }]), view, overlay);
    expect(result.vertices.length).toBe(0);
    expect(result.vertices.byteLength).toBe(0);
    expect(result.vertices.buffer.byteLength).toBe(0);
    expect(result.entities![0]).toMatchObject({ editableLine: true, first: 0, count: 0, sourceBounds: { min: { x: 0, y: 0 }, max: { x: 0, y: 0 } } });
  });

  it('retains the old Float32 finite refusal before an overflowed extrusion can be published', () => {
    const extreme = { ...line, lineWeight: 1e40 };
    expect(() => prepareCompiledZoom2D(drawing([extreme, { ...text, text: '' }]), { ...view, dpr: 1e-40, lineweights: true }, overlay)).toThrow('Float32 stroke geometry exceeds finite limits');
  });
});
