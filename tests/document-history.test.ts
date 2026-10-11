import { describe, it, expect } from 'vitest';
import { Drawing, DEFAULT_HEADER, type DrawingState } from '../src/core/document';
import type { Entity, BlockDef } from '../src/core/entities';
import { pickEntity } from '../src/core/selection';
import { defaultLayout } from '../src/core/layouts';

const line = (id: string, y = 0): Entity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y }, b: { x: 10, y } });

describe('Drawing constructor', () => {
  it('keeps the supplied header, space, layouts, meta and current layer', () => {
    const header = { ...DEFAULT_HEADER, ltscale: 4, pdmode: 3, celtype: 'DASHED' };
    const layouts = [defaultLayout('Sheet A', 'mm')];
    const init: DrawingState = {
      entities: [line('a')],
      layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }, { name: 'X', color: 1, visible: true, locked: false, lineWeight: 0.25 }],
      blocks: {},
      currentLayer: 'X',
      header,
      meta: { k: 1 },
      layouts,
      space: { layout: 'Sheet A' },
    };
    const d = new Drawing(init);
    expect(d.header).toBe(header);
    expect(d.space).toEqual({ layout: 'Sheet A' });
    expect(d.snapshot.layouts).toBe(layouts);
    expect(d.snapshot.meta).toEqual({ k: 1 });
    expect(d.currentLayer).toBe('X');
    expect(d.snapshot).toEqual(init);
  });

  it('fills only the required fields with defaults and adds no undefined keys', () => {
    const d = new Drawing({ header: undefined });
    expect(Object.keys(d.snapshot).sort()).toEqual(['blocks', 'currentLayer', 'entities', 'layers']);
    expect(d.header).toBe(DEFAULT_HEADER);
  });
});

describe('settings outside the undo history', () => {
  it('header variables survive Undo and Redo of geometry edits', () => {
    const d = new Drawing();
    d.addEntities([line('a')]);
    d.setHeader({ ltscale: 5 });
    d.addEntities([line('b', 1)]);
    expect(d.undo()).toBe(true);
    expect(d.undo()).toBe(true);
    expect(d.entities).toHaveLength(0);
    expect(d.header.ltscale).toBe(5);
    expect(d.redo()).toBe(true);
    expect(d.redo()).toBe(true);
    expect(d.header.ltscale).toBe(5);
    expect(d.entities).toHaveLength(2);
  });

  it('a header change made inside a transaction stays undoable with that step', () => {
    const d = new Drawing();
    d.transact((s) => ({ ...s, header: { ...(s.header ?? DEFAULT_HEADER), pdmode: 3 } }));
    d.setHeader({ ltscale: 7 });
    d.undo();
    expect(d.header.pdmode).toBe(0);
    expect(d.header.ltscale).toBe(7);
  });

  it('the current layer survives Undo, except in states where that layer does not exist', () => {
    const d = new Drawing();
    d.addEntities([line('a')]);
    d.setCurrentLayer('WIRES');
    d.undo();
    expect(d.currentLayer).toBe('WIRES');
    d.redo();
    // A layer created (undoably) and made current: undoing the creation falls back.
    d.addLayer({ name: 'NEW', color: 2, visible: true, locked: false, lineWeight: 0.25 });
    d.setCurrentLayer('NEW');
    d.undo();
    expect(d.layer('NEW')).toBeUndefined();
    expect(d.currentLayer).toBe('WIRES');
    d.redo();
    expect(d.currentLayer).toBe('NEW');
  });

  it('the active space and quiet layout changes survive Undo', () => {
    const d = new Drawing({ layouts: [defaultLayout('L1')] });
    d.addEntities([line('a')]);
    d.setSpace({ layout: 'L1' });
    d.patchQuiet((s) => ({ ...s, layouts: (s.layouts ?? []).map((l) => ({ ...l, plotScale: '1:2' })) }));
    d.undo();
    expect(d.space).toEqual({ layout: 'L1' });
    expect(d.snapshot.layouts?.[0]?.plotScale).toBe('1:2');
    expect(d.snapshot.entities).toHaveLength(0);
  });

  it('library blocks added quietly are not taken away by Undo', () => {
    const d = new Drawing();
    d.addEntities([line('a')]);
    const blk: BlockDef = { name: 'LIB', basePoint: { x: 0, y: 0 }, entities: [line('l')], attributes: [] };
    d.ensureBlocks([blk]);
    d.addEntities([{ id: 'i', layer: '0', color: 'ByLayer', type: 'insert', block: 'LIB', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} }]);
    d.undo();
    d.undo();
    expect(d.blocks.LIB).toBe(blk);
    d.redo();
    d.redo();
    expect(d.blocks.LIB).toBe(blk);
  });

  it('meta (import report, retained records, symbol data) travels with the history', () => {
    const d = new Drawing({ meta: { dxfRawEntities: [{ type: '3DFACE', layer: '0', groups: [] }] } });
    d.addEntities([line('a')]);
    d.transact((s) => ({ ...s, meta: { ...(s.meta ?? {}), x: 1 } }));
    d.undo();
    expect(d.snapshot.meta?.dxfRawEntities).toHaveLength(1);
    expect(d.snapshot.meta?.x).toBeUndefined();
    d.undo();
    expect(d.snapshot.meta?.dxfRawEntities).toHaveLength(1);
  });
});

describe('picking overlapping objects', () => {
  const none = new Set<string>();
  it('selects the topmost of two coincident lines (last drawn)', () => {
    const ents = [line('bottom'), line('top')];
    expect(pickEntity({ x: 5, y: 0 }, ents, () => undefined, 0.5, none)?.id).toBe('top');
    expect(pickEntity({ x: 5, y: 0.2 }, ents, () => undefined, 0.5, none)?.id).toBe('top');
  });
  it('still prefers a strictly closer object lower in the draw order', () => {
    const ents = [line('near', 0), line('far', 0.3)];
    expect(pickEntity({ x: 5, y: 0.1 }, ents, () => undefined, 0.5, none)?.id).toBe('near');
  });
  it('skips hidden and locked layers before applying the rule', () => {
    const ents = [line('bottom'), { ...line('top'), layer: 'L' } as Entity];
    expect(pickEntity({ x: 5, y: 0 }, ents, () => undefined, 0.5, new Set(['L']))?.id).toBe('bottom');
    expect(pickEntity({ x: 5, y: 0 }, ents, () => undefined, 0.5, none, new Set(['L']))?.id).toBe('bottom');
  });
  it('an object exactly at the aperture distance is still picked', () => {
    expect(pickEntity({ x: 5, y: 0.5 }, [line('a')], () => undefined, 0.5, none)?.id).toBe('a');
  });
});
