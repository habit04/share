/**
 * Partial opening (io/import-recovery.ts): an import whose only budget problem is individual
 * block references expanding past the per-reference limit opens without those references,
 * each exclusion listed in the import report. Overflow that no reference explains — block
 * definitions alone, plain geometry — stays fatal.
 */
import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { MAX_BLOCK_EXPANSION_WORK, type BlockDef, type Entity, type InsertEntity } from '../src/core/entities';
import { validateGeometryBudget } from '../src/core/geometry-budget';
import { GeometryBudgetError } from '../src/core/geometry-budget-error';
import { defaultLayout } from '../src/core/layouts';
import { recoverOversizedReferences } from '../src/io/import-recovery';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf, type ImportReportItem } from '../src/io/import-report';

const line = (id: string): Entity => ({ type: 'line', id, layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } });
const insertOf = (blockName: string, id: string, extra: Partial<InsertEntity> = {}): InsertEntity => ({
  type: 'insert', id, layer: 'SIGNS', color: 'ByLayer', block: blockName, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {}, ...extra,
});
const blockDef = (name: string, entities: Entity[]): BlockDef => ({ name, basePoint: { x: 0, y: 0 }, entities, attributes: [] });

/**
 * LEAF holds 400 lines; HEAVY holds 300 references to LEAF, so one reference to HEAVY expands
 * to 1 + 300 x (1 + 400) = 120,301 work — over the 100,000 per-reference limit — while the
 * definitions themselves total only 700 work.
 */
function heavyBlocks(): Record<string, BlockDef> {
  return {
    LEAF: blockDef('LEAF', Array.from({ length: 400 }, (_, i) => line(`leaf-${i}`))),
    HEAVY: blockDef('HEAVY', Array.from({ length: 300 }, (_, i) => insertOf('LEAF', `heavy-${i}`))),
  };
}

const stateWith = (entities: Entity[], blocks: Record<string, BlockDef> = {}, layouts?: DrawingState['layouts']): DrawingState => ({
  ...new Drawing().snapshot,
  entities,
  blocks,
  ...(layouts ? { layouts } : {}),
});

function collect() {
  const items: ImportReportItem[] = [];
  const notes: string[] = [];
  return { items, notes, add: (i: ImportReportItem) => items.push(i), note: (t: string) => notes.push(t) };
}

describe('partial opening: oversized block references (io/import-recovery.ts)', () => {
  it('excludes the one oversized reference and opens everything else', () => {
    const state = stateWith([line('keep-1'), insertOf('HEAVY', 'bad-1', { cadIdentity: '2A4' }), line('keep-2')], heavyBlocks());
    expect(() => validateGeometryBudget(state)).toThrow(/Block expansion exceeds/);
    const c = collect();
    const opened = recoverOversizedReferences(state, c.add, c.note);
    expect(opened.entities.map((e) => e.id)).toEqual(['keep-1', 'keep-2']);
    expect(() => validateGeometryBudget(opened)).not.toThrow();
    expect(c.items).toHaveLength(1);
    expect(c.items[0]).toMatchObject({ type: 'INSERT', action: 'dropped', handle: '2A4', layer: 'SIGNS', where: 'model space' });
    expect(c.items[0]!.reason).toContain('"HEAVY"');
    expect(c.items[0]!.reason).toContain('at least 100,251');
    expect(c.items[0]!.reason).toContain(MAX_BLOCK_EXPANSION_WORK.toLocaleString('en-US'));
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0]).toContain('excluded during import');
    // The definitions stay: only the reference was excluded.
    expect(Object.keys(opened.blocks)).toEqual(['LEAF', 'HEAVY']);
  });

  it('excludes two offending references, one per pass', () => {
    const state = stateWith([insertOf('HEAVY', 'bad-1'), line('keep'), insertOf('HEAVY', 'bad-2')], heavyBlocks());
    const c = collect();
    const opened = recoverOversizedReferences(state, c.add, c.note);
    expect(opened.entities.map((e) => e.id)).toEqual(['keep']);
    expect(c.items.map((i) => i.type)).toEqual(['INSERT', 'INSERT']);
    expect(() => validateGeometryBudget(opened)).not.toThrow();
  });

  it('excludes an oversized reference from a layout, naming the layout', () => {
    const layout = { ...defaultLayout('Sheet A'), entities: [insertOf('HEAVY', 'bad-layout'), line('paper-keep')] };
    const state = stateWith([line('model-keep')], heavyBlocks(), [layout]);
    const c = collect();
    const opened = recoverOversizedReferences(state, c.add, c.note);
    expect(opened.entities.map((e) => e.id)).toEqual(['model-keep']);
    expect(opened.layouts![0]!.entities.map((e) => e.id)).toEqual(['paper-keep']);
    expect(c.items[0]).toMatchObject({ type: 'INSERT', action: 'dropped', where: 'layout "Sheet A"' });
  });

  it('drops the largest reference when only the whole-drawing total is over', () => {
    // Each reference to MID expands to 20,051 work (legal on its own); 55 of them push the
    // whole drawing past 1,000,000, so references are excluded until the total fits.
    const blocks: Record<string, BlockDef> = {
      MID: blockDef('MID', Array.from({ length: 50 }, (_, i) => insertOf('LEAF', `mid-${i}`))), // 50 x 401 = 20,050 per reference
      ...heavyBlocks(),
    };
    const refs = Array.from({ length: 55 }, (_, i) => insertOf('MID', `ref-${i}`)); // total 55 x 20,051 > 1,000,000
    const state = stateWith(refs, blocks);
    expect(() => validateGeometryBudget(state)).toThrow(/Drawing expansion exceeds/);
    const c = collect();
    const opened = recoverOversizedReferences(state, c.add, c.note);
    expect(() => validateGeometryBudget(opened)).not.toThrow();
    expect(c.items.length).toBeGreaterThan(0);
    expect(c.items.every((i) => i.type === 'INSERT' && i.action === 'dropped')).toBe(true);
    expect(opened.entities.length).toBeLessThan(refs.length);
  });

  it('overflow from plain geometry stays fatal', () => {
    const big: Entity = { type: 'polyline', id: 'huge', layer: '0', color: 'ByLayer', closed: false, points: Array.from({ length: 1_000_002 }, (_, i) => ({ x: i, y: 0 })) };
    const state = stateWith([big]);
    const c = collect();
    expect(() => recoverOversizedReferences(state, c.add, c.note)).toThrow(GeometryBudgetError);
    expect(c.items).toHaveLength(0);
  });

  it('definitions alone over the budget stay fatal, referenced or not', () => {
    const huge: Entity = { type: 'polyline', id: 'huge', layer: '0', color: 'ByLayer', closed: false, points: Array.from({ length: 1_000_002 }, (_, i) => ({ x: i, y: 0 })) };
    const state = stateWith([insertOf('FAT', 'ref')], { FAT: blockDef('FAT', [huge]) });
    const c = collect();
    expect(() => recoverOversizedReferences(state, c.add, c.note)).toThrow(GeometryBudgetError);
    expect(c.items).toHaveLength(0);
  });

  it('a normal drawing is returned untouched, with nothing reported', () => {
    const state = stateWith([line('a'), insertOf('LEAF', 'ok')], heavyBlocks());
    const c = collect();
    const opened = recoverOversizedReferences(state, c.add, c.note);
    expect(opened).toBe(state);
    expect(c.items).toHaveLength(0);
    expect(c.notes).toHaveLength(0);
  });

  it('readDxf removes an oversized reference through its retained graph and reports its source handle', () => {
    const source = stateWith([line('keep-1'), insertOf('HEAVY', 'bad-1'), line('keep-2')], heavyBlocks());
    const opened = readDxf(writeDxf(source), { filePath: '/drawings/heavy.dxf' });
    expect(opened.cadGraph).toBeDefined();
    expect(opened.entities.some((e) => e.type === 'insert')).toBe(false);
    expect(importReportOf(opened)?.items.find((i) => i.type === 'INSERT' && i.action === 'dropped')).toMatchObject({ handle: expect.stringMatching(/^[0-9A-F]+$/), where: 'model space' });
    expect(() => validateGeometryBudget(opened)).not.toThrow();
    expect(readDxf(writeDxf(opened)).entities.some((e) => e.type === 'insert')).toBe(false);
  });
});
