import { afterEach, describe, expect, it } from 'vitest';
import { Drawing, DEFAULT_LAYERS } from '../src/core/document';
import { collectBlockDependencies, entityBounds, explodeInsert, insertDependencies, type BlockDef, type Entity, type InsertEntity } from '../src/core/entities';
import { SessionManager } from '../src/app/sessions';
import { warmSpatialIndex, spatialIndexSettings } from '../src/core/spatial-index';
import { pickEntity } from '../src/core/selection';
import { validateGeometryBudget } from '../src/core/geometry-budget';
import { sealImmutableData } from '../src/core/immutable-data';

const insert = (block: string, id = block): InsertEntity => ({ id, type: 'insert', block, layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} });
const line = (x: number): Entity => ({ id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x, y: 0 }, b: { x: x + 1, y: 0 } });
const block = (name: string, entities: Entity[]): BlockDef => ({ name, entities, basePoint: { x: 0, y: 0 }, attributes: [] });
afterEach(() => { spatialIndexSettings.minEntities = 2000; });
describe('transitive block cache dependencies', () => {
  it('rechecks direct mutable block definitions after a prior expansion on the same identity', () => {
    const ins = insert('B');
    const entities = [line(0)];
    const definition = block('B', entities);
    const lookup = () => definition;
    expect(explodeInsert(ins, lookup)).toHaveLength(1);
    const heavy: Entity = { id: 'heavy', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'X'.repeat(1_000_000), height: 1, rotation: 0, align: 'left' };
    entities.push(heavy);
    expect(() => explodeInsert(ins, lookup)).toThrow(/geometry budget/);
    expect(() => entityBounds(ins, lookup)).toThrow(/geometry budget/);
    expect(Object.isFrozen(ins)).toBe(false);
    expect(Object.isFrozen(definition)).toBe(false);
  });

  it('requires every reachable definition to be immutable before caching a sealed insert', () => {
    const ins = sealImmutableData(insert('OUTER'));
    const outer = sealImmutableData(block('OUTER', [insert('INNER')]));
    const entities = [line(0)];
    const inner = block('INNER', entities);
    const lookup = (name: string) => name === 'OUTER' ? outer : inner;
    expect(explodeInsert(ins, lookup)).toHaveLength(1);
    const heavy: Entity = { id: 'heavy', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'X'.repeat(1_000_000), height: 1, rotation: 0, align: 'left' };
    entities.push(heavy);
    expect(() => explodeInsert(ins, lookup)).toThrow(/geometry budget/);
    expect(() => entityBounds(ins, lookup)).toThrow(/geometry budget/);
  });

  it('recomputes a mutable insert even when its block definition is immutable', () => {
    const definition = sealImmutableData(block('B', [line(0)]));
    const ins = insert('B');
    const lookup = () => definition;
    expect(entityBounds(ins, lookup)?.min.x).toBe(0);
    (ins.position as { x: number }).x = 100;
    expect(entityBounds(ins, lookup)?.min.x).toBe(100);
    (ins.attributes as Record<string, string>).TAG1 = 'X'.repeat(100_000);
    expect(() => explodeInsert(ins, lookup)).toThrow(/geometry budget/);
  });

  it('refreshes insert geometry and spatial selection after nested redefine, removal and undo', () => {
    spatialIndexSettings.minEntities = 1;
    const ins = insert('OUTER');
    const doc = new Drawing({ entities: [ins], layers: DEFAULT_LAYERS, blocks: { OUTER: block('OUTER', [insert('INNER')]), INNER: block('INNER', [line(0)]) }, currentLayer: '0' });
    const pick = (x: number) => { warmSpatialIndex(doc.entities, doc.lookupBlock); return pickEntity({ x, y: 0 }, doc.entities, doc.lookupBlock, 0.1, new Set())?.id; };
    expect(entityBounds(ins, doc.lookupBlock)?.min.x).toBe(0);
    expect(pick(0.5)).toBe(ins.id);
    doc.defineBlock(block('INNER', [line(100)]));
    expect(entityBounds(ins, doc.lookupBlock)?.min.x).toBe(100);
    expect(pick(0.5)).toBeUndefined(); expect(pick(100.5)).toBe(ins.id);
    doc.removeBlocks(['INNER']); expect(explodeInsert(ins, doc.lookupBlock)).toEqual([]);
    expect(pick(100.5)).toBeUndefined();
    doc.undo(); expect(pick(100.5)).toBe(ins.id);
    doc.undo(); expect(pick(0.5)).toBe(ins.id);
  });
  it('invalidates a cached missing nested definition when the block is later added', () => {
    const defs: Record<string, BlockDef> = { OUTER: block('OUTER', [insert('LATER')]) };
    const ins = insert('OUTER'), lookup = (name: string) => defs[name];
    expect(explodeInsert(ins, lookup)).toEqual([]);
    expect(insertDependencies(ins, lookup)).toEqual(new Map([['OUTER', defs.OUTER], ['LATER', undefined]]));
    defs.LATER = block('LATER', [line(10)]);
    expect(entityBounds(ins, lookup)?.min.x).toBe(10);
  });
  it('rejects acyclic exponential expansion before exhausting memory', () => {
    const defs: Record<string, BlockDef> = { B0: block('B0', [line(0)]) };
    for (let i = 1; i <= 5; i++) defs[`B${i}`] = block(`B${i}`, Array.from({ length: 10 }, (_, j) => insert(`B${i - 1}`, `i${i}-${j}`)));
    expect(() => explodeInsert(insert('B5'), (name) => defs[name])).toThrow(/geometry budget/);
  });
  it('rejects an oversized import before changing the active document or undo history', () => {
    const doc = new Drawing(); doc.addEntities([line(30)]); doc.filePath = 'keep.dxf';
    const before = doc.snapshot, history = doc.history(), loadCount = doc.loadCount;
    const defs: Record<string, BlockDef> = { B0: block('B0', [line(0)]) };
    for (let i = 1; i <= 5; i++) defs[`B${i}`] = block(`B${i}`, Array.from({ length: 10 }, (_, j) => insert(`B${i - 1}`, `${i}-${j}`)));
    expect(() => doc.load({ ...before, blocks: defs, entities: [insert('B5')] }, 'bad.dxf')).toThrow(/geometry budget/);
    expect(doc.snapshot).toBe(before); expect(doc.history()).toEqual(history);
    expect(doc.filePath).toBe('keep.dxf'); expect(doc.dirty).toBe(true); expect(doc.loadCount).toBe(loadCount);
  });
  it('caps aggregate expansion across many individually acceptable references, including paper space', () => {
    const defs = { B: block('B', Array.from({ length: 50_000 }, (_, j) => ({ ...line(j), id: `${j}` }))) };
    const state = new Drawing().snapshot;
    expect(() => validateGeometryBudget({ ...state, blocks: defs, entities: Array.from({ length: 21 }, (_, j) => insert('B', `${j}`)) })).toThrow(/Drawing expansion/);
    expect(() => validateGeometryBudget({ ...state, blocks: defs, entities: [insert('B')] })).not.toThrow();
  });
  it('estimates recursive block references with the same bounded depth as rendering', () => {
    const state = new Drawing().snapshot;
    expect(() => validateGeometryBudget({ ...state, entities: [insert('A')], blocks: { A: block('A', [insert('A'), line(0)]) } })).not.toThrow();
  });

  it('counts repeated coordinate and string workloads before allocating expanded instances', () => {
    const polyline: Entity = { id: 'heavy', type: 'polyline', layer: '0', color: 'ByLayer', points: Array.from({ length: 10_000 }, (_, x) => ({ x, y: 0 })), closed: false };
    const state = new Drawing().snapshot;
    const blocks = { HEAVY: block('HEAVY', [polyline]) };
    expect(() => validateGeometryBudget({ ...state, blocks, entities: Array.from({ length: 101 }, (_, index) => insert('HEAVY', `${index}`)) })).toThrow(/Drawing expansion/);
    const tooHeavy = block('TOO_HEAVY', [{ ...polyline, points: Array.from({ length: 100_000 }, (_, x) => ({ x, y: 0 })) }]);
    expect(() => explodeInsert(insert('TOO_HEAVY'), () => tooHeavy)).toThrow(/geometry budget/);
    const heavyText: Entity = { id: 'heavy-text', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'X'.repeat(10_000), height: 1, rotation: 0, align: 'left' };
    expect(() => validateGeometryBudget({ ...state, blocks: { TEXT: block('TEXT', [heavyText]) }, entities: Array.from({ length: 101 }, (_, index) => insert('TEXT', `${index}`)) })).toThrow(/Drawing expansion/);
  });

  it('ignores definitions beyond the expansion depth consistently in prevalidation and dependency caches', () => {
    const definitions: Record<string, BlockDef> = { B10: block('B10', Array.from({ length: 100_001 }, (_, index) => line(index))) };
    for (let i = 9; i >= 0; i--) definitions[`B${i}`] = block(`B${i}`, [insert(`B${i + 1}`)]);
    const doc = new Drawing({ entities: [insert('B0')], blocks: definitions });
    expect(explodeInsert(doc.entities[0] as InsertEntity, doc.lookupBlock)).toEqual([]);
    expect(() => entityBounds(doc.entities[0]!, doc.lookupBlock)).not.toThrow();
    spatialIndexSettings.minEntities = 1;
    expect(() => warmSpatialIndex(doc.entities, doc.lookupBlock)).not.toThrow();
    const dependencies = collectBlockDependencies('B0', doc.lookupBlock);
    expect(dependencies.has('B10')).toBe(false);
    const used = insertDependencies(doc.entities[0] as InsertEntity, doc.lookupBlock);
    expect(used.has('B8')).toBe(true);
    expect(used.has('B9')).toBe(false);
    expect(used.has('B10')).toBe(false);
    const shallower: Record<string, BlockDef> = { ...definitions, B10: block('B10', [line(100)]) };
    expect(insertDependencies(insert('B8'), (name) => shallower[name]).get('B10')).toBe(shallower.B10);
  });

  it('tracks a nested block at a shallower depth when it is also a separate root insert', () => {
    const definitions: Record<string, BlockDef> = { B10: block('B10', [line(100)]) };
    for (let i = 9; i >= 0; i--) definitions[`B${i}`] = block(`B${i}`, [insert(`B${i + 1}`)]);
    const dependencies = collectBlockDependencies('B0', (name) => definitions[name]);
    collectBlockDependencies('B8', (name) => definitions[name], dependencies);
    expect(dependencies.get('B10')).toBe(definitions.B10);
  });

  it('rejects an invalid close target before removing the active tab', () => {
    const doc = new Drawing();
    const host = { doc, viewport: { center: { x: 0, y: 0 }, scale: 1 }, selection: new Set<string>(), loadState: (state: typeof doc.snapshot, path: string | null) => doc.load(state, path) };
    const sessions = new SessionManager(host);
    sessions.add();
    doc.addEntities([line(30)]);
    const before = doc.snapshot, history = doc.history();
    const parked = sessions.all[0]!;
    const heavy: Entity = { id: 'oversize', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'X'.repeat(1_000_001), height: 1, rotation: 0, align: 'left' };
    parked.state = { ...parked.state, entities: [heavy] };
    expect(() => sessions.close(1)).toThrow(/geometry budget/);
    expect(sessions.count).toBe(2); expect(sessions.active).toBe(1);
    expect(doc.snapshot).toBe(before); expect(doc.history()).toEqual(history);
    expect(doc.dirty).toBe(true);
  });
});
