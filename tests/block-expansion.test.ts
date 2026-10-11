/**
 * Security review E-13: block references expand to a bounded number of objects. Blocks that each
 * insert the previous one many times stay within the nesting depth while multiplying into
 * billions of objects (a "fan-out bomb"), and a block may insert itself. One reference expands to
 * at most MAX_INSERT_EXPANSION (2,000,000, as JCad 3D's DXF reader) objects, a block that inserts
 * itself is expanded once, the readers report both (kept: the blocks are saved as they are), and
 * EXPLODE leaves such a reference alone. Nothing throws and nothing blocks opening the drawing.
 */
import { describe, it, expect } from 'vitest';
import { explodeInsert, expandInsert, expansionReport, insertExpansionLimited, entityBounds, MAX_INSERT_EXPANSION, type BlockDef, type Entity, type InsertEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf, saveOverwriteWarning } from '../src/io/import-report';
import { reportNeedsAttention } from '../src/app/import-open';
import { Drawing } from '../src/core/document';
import { DraftingExplodeTool } from '../src/tools/drafting-modify';
import { fakeContext, drive } from './fake-context';

const line = (id: string): Entity => ({ type: 'line', id, layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } });
const insertOf = (block: string, id = `i-${block}`, x = 0): InsertEntity => ({ type: 'insert', id, layer: '0', color: 'ByLayer', block, position: { x, y: 0 }, rotation: 0, scale: 1, attributes: {} });
const block = (name: string, entities: Entity[]): BlockDef => ({ name, basePoint: { x: 0, y: 0 }, entities, attributes: [] });

/** B0 = 10 lines; Bk = 10 references to B(k-1): one reference to Bk expands to 10^(k+1) lines. */
function fanOut(levels: number): Record<string, BlockDef> {
  const blocks: Record<string, BlockDef> = { B0: block('B0', Array.from({ length: 10 }, (_, i) => line(`l${i}`))) };
  for (let k = 1; k <= levels; k += 1) blocks[`B${k}`] = block(`B${k}`, Array.from({ length: 10 }, (_, i) => insertOf(`B${k - 1}`, `i${k}-${i}`, i)));
  return blocks;
}

describe('block expansion budget (core/entities.ts, E-13)', () => {
  it('the cap is 2,000,000 objects per reference', () => {
    expect(MAX_INSERT_EXPANSION).toBe(2_000_000);
  });

  it('a fan-out bomb expands to the budget and stops, quickly', () => {
    const blocks = fanOut(8); // 10^9 lines through one reference
    const lookup = (n: string) => blocks[n];
    const t = performance.now();
    const r = expandInsert(insertOf('B8'), lookup, 50_000);
    expect(performance.now() - t).toBeLessThan(5000);
    expect(r.entities).toHaveLength(50_000);
    expect(r.truncated).toBe(true);
    expect(r.cyclic).toBe(false);
    // Within the budget nothing changes.
    const small = expandInsert(insertOf('B3'), lookup, 50_000);
    expect(small).toMatchObject({ truncated: false, cyclic: false });
    expect(small.entities).toHaveLength(10_000);
    expect(explodeInsert(insertOf('B3'), lookup)).toHaveLength(10_000);
    expect(insertExpansionLimited(insertOf('B3'), lookup)).toBe(false);
  });

  it('a block that inserts itself is expanded once (directly or through another block)', () => {
    const self: Record<string, BlockDef> = {
      A: block('A', [line('a'), insertOf('A', 'ia'), insertOf('A', 'ib')]),
      B: block('B', [line('b'), insertOf('C', 'ic')]),
      C: block('C', [line('c'), insertOf('B', 'ib2')]),
    };
    const lookup = (n: string) => self[n];
    const a = expandInsert(insertOf('A'), lookup);
    expect(a.entities.map((e) => e.type)).toEqual(['line']);
    expect(a.cyclic).toBe(true);
    const b = expandInsert(insertOf('B'), lookup);
    expect(b.entities).toHaveLength(2);
    expect(b.cyclic).toBe(true);
    const ins = insertOf('A');
    expect(explodeInsert(ins, lookup)).toHaveLength(1);
    expect(insertExpansionLimited(ins, lookup)).toBe(true);
    expect(entityBounds(ins, lookup)).toEqual({ min: { x: 0, y: 0 }, max: { x: 1, y: 0 } });
    // Using a block twice side by side is not a cycle.
    const twice: Record<string, BlockDef> = { L: block('L', [line('x')]), T: block('T', [insertOf('L', 'p'), insertOf('L', 'q', 5)]) };
    expect(expandInsert(insertOf('T'), (n) => twice[n])).toMatchObject({ truncated: false, cyclic: false });
  });

  it('expansionReport counts without expanding: oversized blocks, cycles, the drawing total', () => {
    const blocks = { ...fanOut(9), SELF: block('SELF', [line('s'), insertOf('SELF', 'is')]) };
    const t = performance.now();
    const r = expansionReport(blocks, [insertOf('B5', 'top1'), insertOf('B5', 'top2'), insertOf('SELF', 'top3')]);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(r.cyclic).toEqual(['SELF']);
    expect(r.oversized).toEqual(['B6', 'B7', 'B8', 'B9']);
    expect(r.total).toBe(2_000_001);
  });
});

describe('readers report the expansion and keep the blocks (E-13)', () => {
  /** A DXF whose blocks multiply to 10^9 lines, plus a self-inserting block, both referenced. */
  function bombDxf(): string {
    const g: string[] = ['0', 'SECTION', '2', 'BLOCKS'];
    g.push('0', 'BLOCK', '8', '0', '2', 'B0', '70', '0', '10', '0', '20', '0');
    for (let i = 0; i < 10; i += 1) g.push('0', 'LINE', '8', '0', '10', String(i), '20', '0', '11', String(i + 1), '21', '0');
    g.push('0', 'ENDBLK');
    for (let k = 1; k <= 8; k += 1) {
      g.push('0', 'BLOCK', '8', '0', '2', `B${k}`, '70', '0', '10', '0', '20', '0');
      for (let i = 0; i < 10; i += 1) g.push('0', 'INSERT', '8', '0', '2', `B${k - 1}`, '10', String(i), '20', '0');
      g.push('0', 'ENDBLK');
    }
    g.push('0', 'BLOCK', '8', '0', '2', 'SELF', '70', '0', '10', '0', '20', '0', '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '1', '21', '1', '0', 'INSERT', '8', '0', '2', 'SELF', '10', '2', '20', '0', '0', 'ENDBLK');
    g.push('0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES');
    g.push('0', 'INSERT', '8', '0', '2', 'B3', '10', '0', '20', '0'); // 10,000 lines: fine
    g.push('0', 'INSERT', '8', '0', '2', 'B8', '10', '0', '20', '50'); // 10^9 lines
    g.push('0', 'INSERT', '8', '0', '2', 'SELF', '10', '0', '20', '90');
    g.push('0', 'ENDSEC', '0', 'EOF', '');
    return g.join('\n');
  }

  it('readDxf opens it, reports the blocks as kept, and the file saves back unchanged in content', () => {
    const t = performance.now();
    const s = readDxf(bombDxf(), { filePath: '/jobs/bomb.dxf' });
    expect(performance.now() - t).toBeLessThan(5000);
    const report = importReportOf(s)!;
    const reasons = report.items.map((i) => `${i.type} ${i.action}: ${i.reason}`);
    expect(reasons).toContain('BLOCK kept: block "SELF" inserts itself (directly or through other blocks): the repeated reference is not drawn');
    expect(reasons).toContain('BLOCK kept: block "B8" expands to more than 2,000,000 objects through its nested blocks: each reference draws only the first 2,000,000, and EXPLODE leaves it a reference');
    expect(report.notes, JSON.stringify(report.notes)).toContain('The block references of this drawing expand to about 2,010,002 objects (more than 2,000,000): drawing and selecting may be slow and use much memory.');
    // Kept: neither the report dialog nor the "save over the original" question.
    expect(reportNeedsAttention(report)).toBe(false);
    expect(saveOverwriteWarning(s, '/jobs/bomb.dxf')).toBeNull();
    const back = readDxf(writeDxf(s));
    expect(Object.keys(back.blocks).sort()).toEqual(['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'SELF']);
    expect(back.blocks.B8!.entities).toHaveLength(10);
    expect(back.blocks.SELF!.entities.map((e) => e.type)).toEqual(['line', 'insert']);
  });

  it('EXPLODE leaves a reference whose expansion was cut short, and explodes the others', () => {
    const blocks = { ...fanOut(1), SELF: block('SELF', [line('s'), insertOf('SELF', 'is')]) };
    const doc = new Drawing({ blocks });
    doc.addEntities([insertOf('B1', 'ok'), insertOf('SELF', 'loop')]);
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['ok', 'loop']);
    drive(new DraftingExplodeTool(), ctx, []);
    expect(doc.entities.filter((e) => e.type === 'line')).toHaveLength(100);
    expect(doc.entities.filter((e) => e.type === 'insert').map((e) => e.id)).toEqual(['loop']);
    expect(ctx.logs.some((l) => l.includes('1 block reference(s) not exploded: the block inserts itself or expands to more than 2,000,000 objects.'))).toBe(true);
  });
});
