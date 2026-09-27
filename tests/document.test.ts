import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';

const line = (id: string): Entity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });

describe('Drawing undo/redo', () => {
  it('undo and redo restore entity lists', () => {
    const d = new Drawing();
    d.addEntities([line('a')]);
    d.addEntities([line('b')]);
    expect(d.entities.map((e) => e.id)).toEqual(['a', 'b']);
    expect(d.undo()).toBe(true);
    expect(d.entities.map((e) => e.id)).toEqual(['a']);
    expect(d.redo()).toBe(true);
    expect(d.entities.map((e) => e.id)).toEqual(['a', 'b']);
    expect(d.redo()).toBe(false);
  });
  it('a new transaction clears the redo stack', () => {
    const d = new Drawing();
    d.addEntities([line('a')]);
    d.undo();
    d.addEntities([line('c')]);
    expect(d.canRedo()).toBe(false);
    expect(d.entities.map((e) => e.id)).toEqual(['c']);
  });
  it('replaceEntities keeps order and removeEntities drops ids', () => {
    const d = new Drawing();
    d.addEntities([line('a'), line('b'), line('c')]);
    d.replaceEntities([{ ...line('b'), layer: 'WIRES' }]);
    expect(d.entities[1]!.layer).toBe('WIRES');
    d.removeEntities(['a', 'c']);
    expect(d.entities.map((e) => e.id)).toEqual(['b']);
    expect(d.dirty).toBe(true);
  });
  it('notifies subscribers once per change', () => {
    const d = new Drawing();
    let n = 0;
    d.subscribe(() => (n += 1));
    d.addEntities([line('a')]);
    d.addEntities([]); // no-op
    expect(n).toBe(1);
  });
  it('load resets history', () => {
    const d = new Drawing();
    d.addEntities([line('a')]);
    d.load(new Drawing().snapshot, '/tmp/x.dxf');
    expect(d.canUndo()).toBe(false);
    expect(d.filePath).toBe('/tmp/x.dxf');
    expect(d.dirty).toBe(false);
  });
});
