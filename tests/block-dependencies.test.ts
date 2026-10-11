/**
 * Nested block cache invalidation: a reference's expansion (and its bounds, picking through the
 * spatial index) is cached per insert; the cache must notice when a block *inside* the referenced
 * block is redefined, removed, added later or restored by undo, not only the referenced block
 * itself. Adapted from PR #2 (codex/electrical-review-fixes 2f89b0e, tests/block-dependencies.test.ts):
 * the dependencies are the definitions the expansion actually used (core/entities.ts
 * insertDependencies), within the same depth limit as rendering; the geometry-budget cases of
 * that file are not ported (see tests/block-expansion.test.ts for the expansion budget).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Drawing, DEFAULT_LAYERS } from '../src/core/document';
import { entityBounds, explodeInsert, insertDependencies, type BlockDef, type Entity, type InsertEntity } from '../src/core/entities';
import { warmSpatialIndex, spatialIndexSettings } from '../src/core/spatial-index';
import { pickEntity } from '../src/core/selection';

const insert = (block: string, id = block): InsertEntity => ({ id, type: 'insert', block, layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} });
const line = (x: number): Entity => ({ id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x, y: 0 }, b: { x: x + 1, y: 0 } });
const block = (name: string, entities: Entity[]): BlockDef => ({ name, entities, basePoint: { x: 0, y: 0 }, attributes: [] });
afterEach(() => {
  spatialIndexSettings.minEntities = 2000;
});

describe('transitive block cache dependencies', () => {
  it('refreshes insert geometry and spatial selection after a nested redefine, removal and undo', () => {
    spatialIndexSettings.minEntities = 1;
    const ins = insert('OUTER');
    const doc = new Drawing({ entities: [ins], layers: DEFAULT_LAYERS, blocks: { OUTER: block('OUTER', [insert('INNER')]), INNER: block('INNER', [line(0)]) }, currentLayer: '0' });
    const pick = (x: number) => {
      warmSpatialIndex(doc.entities, doc.lookupBlock);
      return pickEntity({ x, y: 0 }, doc.entities, doc.lookupBlock, 0.1, new Set())?.id;
    };
    expect(entityBounds(ins, doc.lookupBlock)?.min.x).toBe(0);
    expect(pick(0.5)).toBe(ins.id);
    doc.defineBlock(block('INNER', [line(100)]));
    expect(entityBounds(ins, doc.lookupBlock)?.min.x).toBe(100);
    expect(pick(0.5)).toBeUndefined();
    expect(pick(100.5)).toBe(ins.id);
    doc.removeBlocks(['INNER']);
    expect(explodeInsert(ins, doc.lookupBlock)).toEqual([]);
    expect(pick(100.5)).toBeUndefined();
    doc.undo();
    expect(pick(100.5)).toBe(ins.id);
    doc.undo();
    expect(pick(0.5)).toBe(ins.id);
  });

  it('notices a nested definition that was missing and is added later', () => {
    const defs: Record<string, BlockDef> = { OUTER: block('OUTER', [insert('LATER')]) };
    const ins = insert('OUTER');
    const lookup = (name: string) => defs[name];
    expect(explodeInsert(ins, lookup)).toEqual([]);
    expect(insertDependencies(ins, lookup)).toEqual(new Map([['OUTER', defs.OUTER], ['LATER', undefined]]));
    defs.LATER = block('LATER', [line(10)]);
    expect(entityBounds(ins, lookup)?.min.x).toBe(10);
  });

  it('depends only on definitions within the drawing depth (deeper ones are not drawn)', () => {
    const definitions: Record<string, BlockDef> = { B10: block('B10', [line(100)]) };
    for (let i = 9; i >= 0; i -= 1) definitions[`B${i}`] = block(`B${i}`, [insert(`B${i + 1}`)]);
    const lookup = (name: string) => definitions[name];
    expect(explodeInsert(insert('B0'), lookup)).toEqual([]);
    const deps = insertDependencies(insert('B0', 'b0'), lookup);
    expect(deps.has('B8')).toBe(true);
    expect(deps.has('B9')).toBe(false);
    expect(deps.has('B10')).toBe(false);
    // A shallower reference to the same nested block depends on it.
    expect(insertDependencies(insert('B8', 'b8'), lookup).get('B10')).toBe(definitions.B10);
  });
});
