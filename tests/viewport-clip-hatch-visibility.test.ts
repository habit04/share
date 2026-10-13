import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { Entity, HatchEntity, InsertEntity, PolylineEntity } from '../src/core/entities';
import { distanceToEntity, hatchGeometry, rotateEntity, scaleEntityBy, translateEntity } from '../src/core/entities';
import { defaultLayout, paperToModel, type LayoutViewport } from '../src/core/layouts';
import { pickEntity, viewportSelectionEntities } from '../src/core/selection';
import { readDxf, writeDxf } from '../src/io/dxf';

const props = { layer: '0', color: 'ByLayer' as const };
const square = (low: number, high: number) => ({ points: [{ x: low, y: low }, { x: high, y: low }, { x: high, y: high }, { x: low, y: high }] });
const boundary: PolylineEntity = { ...props, id: 'clip', type: 'polyline', closed: true,
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 }] };
const viewport = (twist = 0, scale = 1): LayoutViewport => ({ id: 'vp', center: { x: 5, y: 5 }, width: 10, height: 10,
  ...props, on: true, view: { center: { x: 5, y: 5 }, scale, twist }, clipBoundary: boundary });
const hatch = (over: Partial<HatchEntity> = {}): HatchEntity => ({ ...props, id: 'hatch', type: 'hatch', pattern: 'LINE',
  solid: false, angle: 0, scale: 1, origin: { x: 0, y: 0.05 }, loops: [square(-1, 11)], ...over });
const insert = (id: string, block: string, over: Partial<InsertEntity> = {}): InsertEntity => ({ ...props, id,
  type: 'insert', block, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {}, ...over });

function scene(entities: Entity[], vp = viewport()): Drawing {
  return new Drawing({ entities, layouts: [{ ...defaultLayout('Sheet'), pristine: undefined, viewports: [vp] }], space: { layout: 'Sheet', viewport: vp.id } });
}
const visible = (doc: Drawing) => viewportSelectionEntities(doc.snapshot, doc.entities, doc.lookupBlock);

describe('hatch visibility inside polygon viewports', () => {
  it('keeps enclosing pattern strokes even when the hatch outlines and clip vertices miss them', () => {
    const h = hatch(), doc = scene([h]);
    expect(hatchGeometry(h).segments).toHaveLength(96);
    expect(boundary.points.every((p) => distanceToEntity(p, h, doc.lookupBlock) > 0.001)).toBe(true);
    expect(distanceToEntity({ x: 2, y: 2.05 }, h, doc.lookupBlock)).toBe(0);
    expect(visible(doc)).toEqual([h]);
    expect(pickEntity({ x: 2, y: 2.05 }, visible(doc), doc.lookupBlock, 0.1, new Set())?.id).toBe(h.id);
  });

  it.each([0, 0.43, Math.PI / 2])('keeps enclosing strokes at viewport twist %s and scale 1:2', (twist) => {
    const vp = viewport(twist, 0.5);
    const h = rotateEntity(scaleEntityBy(hatch(), vp.center, 2), vp.center, -twist) as HatchEntity;
    const doc = scene([h], vp), target = paperToModel(vp, { x: 2, y: 2.05 });
    expect(distanceToEntity(target, h, doc.lookupBlock)).toBeLessThan(1e-8);
    expect(visible(doc).map((e) => e.id)).toEqual([h.id]);
    expect(pickEntity(target, visible(doc), doc.lookupBlock, 0.1, new Set())?.id).toBe(h.id);
  });

  it('keeps pattern dots within the clip', () => {
    const h = hatch({ pattern: 'DOTS', patternLines: [{ angle: 0, base: { x: 0.05, y: 0.05 }, offset: { x: 0, y: 0.25 }, dashes: [0, -0.25] }] });
    const doc = scene([h]);
    expect(hatchGeometry(h).segments.every(([a, b]) => a.x === b.x && a.y === b.y)).toBe(true);
    expect(visible(doc)).toEqual([h]);
  });

  it('excludes an enclosing hatch whose sparse pattern has no geometry within the clip', () => {
    const h = hatch({ patternLines: [{ angle: 0, base: { x: 0, y: 20 }, offset: { x: 0, y: 100 }, dashes: [] }] });
    expect(hatchGeometry(h).segments).toHaveLength(0);
    expect(visible(scene([h]))).toEqual([]);
  });

  it.each(['pattern', 'solid', 'dense'] as const)('keeps %s fills visible but excludes a clip wholly within an island', (kind) => {
    const settings = kind === 'solid' ? { solid: true, pattern: 'SOLID' } : kind === 'dense' ? { scale: 0.000001 } : {};
    const whole = hatch(settings), hole = hatch({ ...settings, id: 'island', loops: [square(-2, 12), square(-1, 11)] });
    if (kind === 'dense') expect(hatchGeometry(whole).dense).toBe(true);
    expect(visible(scene([whole, hole])).map((e) => e.id)).toEqual([whole.id]);
  });

  it('retains visible hatches in nested and array inserts', () => {
    const nested = insert('nested', 'Outer'), array = insert('array', 'Inner', { columns: 2, columnSpacing: 100 });
    const doc = scene([nested, array]);
    doc.defineBlock({ name: 'Inner', basePoint: { x: 0, y: 0 }, attributes: [], entities: [hatch()] });
    doc.defineBlock({ name: 'Outer', basePoint: { x: 0, y: 0 }, attributes: [], entities: [insert('inner', 'Inner')] });
    expect(visible(doc).map((e) => e.id)).toEqual([nested.id, array.id]);
  });

  it('recomputes visible strokes after edits and undo/redo without changing the model geometry', () => {
    const h = hatch(), doc = scene([h]), first = visible(doc);
    expect(first).toEqual([h]);
    expect(visible(doc)).toBe(first);
    doc.replaceEntities([{ ...h, patternLines: [{ angle: 0, base: { x: 0, y: 20 }, offset: { x: 0, y: 100 }, dashes: [] }] }]);
    expect(visible(doc)).toEqual([]);
    doc.undo(); expect(visible(doc)).toEqual([h]);
    doc.redo(); expect(visible(doc)).toEqual([]);
    expect(doc.entities[0]).toMatchObject({ id: h.id, loops: h.loops });
  });

  it('keeps native DXF pattern hatches editable after import, undo/redo, save and reopen', () => {
    const source = scene([hatch()]);
    const doc = new Drawing(readDxf(writeDxf(source.snapshot)));
    const vp = doc.snapshot.layouts![0]!.viewports[0]!;
    doc.setSpace({ layout: 'Sheet', viewport: vp.id });
    const h = doc.entities.find((e): e is HatchEntity => e.type === 'hatch')!;
    expect(visible(doc)).toEqual([h]);
    doc.replaceEntities([{ ...translateEntity(h, { x: 0, y: 0.25 }), color: 3 }]);
    expect(visible(doc)).toHaveLength(1);
    doc.undo(); expect(visible(doc)).toEqual([h]);
    doc.redo();
    const reopened = new Drawing(readDxf(writeDxf(doc.snapshot)));
    reopened.setSpace({ layout: 'Sheet', viewport: reopened.snapshot.layouts![0]!.viewports[0]!.id });
    const saved = reopened.entities.find((e) => e.type === 'hatch');
    expect(saved).toMatchObject({ type: 'hatch', color: 3, solid: false, pattern: 'LINE' });
    expect(visible(reopened)).toEqual([saved]);
    expect(reopened.snapshot.layouts![0]!.viewports[0]!.clipBoundary?.points).toEqual(boundary.points);
  });
});
