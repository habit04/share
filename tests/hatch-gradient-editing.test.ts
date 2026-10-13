import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { HatchEntity, InsertEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { hatchEditTool } from '../src/tools/drafting-annot';
import { DraftingExplodeTool } from '../src/tools/drafting-modify';
import { fakeContext, drive } from './fake-context';

const hatch = (): HatchEntity => ({ id: 'h', type: 'hatch', layer: '0', color: 1, solid: true, pattern: 'SOLID', angle: 0, scale: 1,
  loops: [{ points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }] }],
  gradient: { name: 'LINEAR', angle: 0, shift: 0, tint: 0.5, singleColor: false, colors: [{ position: 0, color: 0 }, { position: 1, trueColor: 0xffffff }] } });
function setup() { const doc = new Drawing({ entities: [hatch()] }), ctx = fakeContext(doc); ctx.selection.add('h'); return { doc, ctx }; }

describe('gradient editing without silent fill loss', () => {
  it('edits native angle with undo/redo and DXF reopen', () => {
    const { doc, ctx } = setup(), before = doc.snapshot;
    drive(hatchEditTool(), ctx, ['Properties', 'Angle', '45']);
    expect((doc.entities[0] as HatchEntity).gradient!.angle).toBeCloseTo(Math.PI / 4);
    expect(doc.undo()).toBe(true); expect(doc.snapshot).toBe(before); expect(doc.redo()).toBe(true);
    expect((readDxf(writeDxf(doc.snapshot)).entities[0] as HatchEntity).gradient!.angle).toBeCloseTo(Math.PI / 4);
  });
  it('retains a shifted definition and discloses the unsupported display', () => {
    const { doc, ctx } = setup();
    drive(hatchEditTool(), ctx, ['Properties', 'Shift', '0.5']);
    expect((doc.entities[0] as HatchEntity).gradient!.shift).toBe(0.5);
    expect(ctx.logs.join('\n')).toMatch(/shift.*retained.*solid fill/s);
  });
  it('rejects out-of-range shift without changing the document', () => {
    const { doc, ctx } = setup(), before = doc.snapshot;
    drive(hatchEditTool(), ctx, ['Properties', 'Shift', '2']);
    expect(doc.snapshot).toBe(before);
    expect(ctx.logs.join('\n')).toContain('between 0 and 1');
  });
  it('rejects pattern conversion that native DXF cannot retain without changing history', () => {
    const { doc, ctx } = setup(), before = doc.snapshot, history = doc.history();
    drive(hatchEditTool(), ctx, ['Properties', 'Pattern', 'ANSI31', '1', '0']);
    expect(doc.snapshot).toBe(before); expect(doc.history()).toEqual(history);
    expect(ctx.logs.join('\n')).toContain('hatch is unchanged');
  });
  it('explicit SOLID pattern selection retains the previous native gradient as inactive data', () => {
    const { doc, ctx } = setup(), original = (doc.entities[0] as HatchEntity).gradient!;
    drive(hatchEditTool(), ctx, ['Properties', 'Pattern', 'SOLID']);
    const h = doc.entities[0] as HatchEntity;
    expect(h.solid).toBe(true); expect(h.pattern).toBe('SOLID');
    expect(h.gradient).toEqual({ ...original, kind: 0 });
    const back = readDxf(writeDxf(doc.snapshot)).entities[0] as HatchEntity;
    expect(back.gradient!.kind).toBe(0); expect(back.gradient!.colors).toEqual(original.colors);
    expect(ctx.logs.join('\n')).toContain('retained as inactive');
  });
  it.each(['hatch', 'insert'])('EXPLODE keeps %s gradient content, history and selection', (kind) => {
    const h = hatch();
    const insert: InsertEntity = { id: 'i', type: 'insert', layer: '0', color: 'ByLayer', block: 'G', position: { x: 0, y: 0 }, scale: 2, scaleY: 3, rotation: Math.PI / 4, attributes: {} };
    const doc = new Drawing({ entities: [kind === 'hatch' ? h : insert], blocks: { G: { name: 'G', basePoint: { x: 0, y: 0 }, attributes: [], entities: [h] } } });
    const ctx = fakeContext(doc); ctx.selection.add(doc.entities[0]!.id);
    const before = doc.snapshot, history = doc.history();
    drive(new DraftingExplodeTool(), ctx, []);
    expect(doc.snapshot).toBe(before); expect(doc.history()).toEqual(history);
    expect([...ctx.selection]).toEqual([doc.entities[0]!.id]);
    expect(ctx.logs.join('\n')).toMatch(/gradients retained.*cannot preserve/s);
  });
  it('EXPLODE retains an inactive native descriptor instead of discarding it', () => {
    const h = hatch(), doc = new Drawing({ entities: [{ ...h, gradient: { ...h.gradient!, kind: 0 } }] });
    const ctx = fakeContext(doc); ctx.selection.add('h');
    const before = doc.snapshot;
    drive(new DraftingExplodeTool(), ctx, []);
    expect(doc.snapshot).toBe(before); expect([...ctx.selection]).toEqual(['h']);
    expect(ctx.logs.join('\n')).toContain('gradients retained');
  });
  it.each(['hatch', 'insert'])('mixed EXPLODE keeps the protected %s selected along with new ordinary geometry', (kind) => {
    const h = hatch();
    const insert: InsertEntity = { id: 'protected', type: 'insert', block: 'G', layer: '0', color: 1, position: { x: 0, y: 0 }, rotation: 0.4, scale: 1, attributes: {} };
    const ordinary = { ...insert, id: 'ordinary', block: 'L' };
    const protectedEntity = kind === 'hatch' ? h : insert;
    const ordinaryHatch = { ...h, id: 'ordinary-hatch', gradient: undefined };
    const doc = new Drawing({ entities: [protectedEntity, ordinary, ordinaryHatch], blocks: {
      G: { name: 'G', basePoint: { x: 0, y: 0 }, attributes: [], entities: [h] },
      L: { name: 'L', basePoint: { x: 0, y: 0 }, attributes: [], entities: [{ id: 'line', type: 'line', layer: '0', color: 1, a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }] },
    } });
    const ctx = fakeContext(doc); ctx.selection = new Set([protectedEntity.id, ordinary.id, ordinaryHatch.id]);
    drive(new DraftingExplodeTool(), ctx, []);
    expect(doc.entities.some((e) => e.id === protectedEntity.id)).toBe(true);
    expect(doc.entities.some((e) => e.id === ordinary.id)).toBe(false);
    expect(ctx.selection.has(protectedEntity.id)).toBe(true);
    expect(doc.entities.filter((e) => e.type === 'line').every((e) => ctx.selection.has(e.id))).toBe(true);
    expect(doc.entities.filter((e) => e.type === 'polyline').length).toBeGreaterThan(0);
    expect(doc.entities.every((e) => ctx.selection.has(e.id))).toBe(true);
  });
});
