import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Drawing } from '../src/core/document';
import { mapCadEntities } from '../src/core/cad-graph';
import { moveGrip, translateEntity, type PolylineEntity } from '../src/core/entities';
import { defaultLayout, paperEntities, pointInViewport, viewportAt, type LayoutViewport } from '../src/core/layouts';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';
import { drawingContext, layoutPageSpec, renderPdfPages } from '../src/io/pdf-vector';
import { paintLayout, paperTransform, renderPageToCanvas } from '../src/render/layouts';
import type { Viewport } from '../src/render/viewport';

const clip: PolylineEntity = {
  id: 'clip', type: 'polyline', layer: '0', color: 2, trueColor: 0x123456,
  points: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 8 }, { x: 2, y: 8 }], closed: true,
};
const viewport = (): LayoutViewport => ({ id: 'v', center: { x: 5, y: 5 }, width: 6, height: 6,
  view: { center: { x: 100, y: 200 }, scale: 0.5, twist: Math.PI / 6 }, layer: '0', on: true, clipBoundary: clip });
function scene() {
  const source = readDxf(readFileSync(new URL('./fixtures/interchange/r2000-layouts-titleblock.dxf', import.meta.url), 'utf8'));
  // This scene tests authored geometry/rendering. Native graph-bearing layout
  // replacement is tested separately and must require an explicit transition.
  const { cadGraph: _graph, ...bare } = source;
  const geometry = mapCadEntities(bare, entity => { const { cadIdentity: _identity, ...plain } = entity; return plain; });
  return new Drawing({ ...geometry, layouts: [{ ...defaultLayout('Polygon'), pristine: undefined, viewports: [viewport()] }], space: { layout: 'Polygon' } });
}

describe('native polygon viewport clipping', () => {
  it('reopens an AutoCAD 2027 normalized native clip and keeps it through an edit/save cycle', () => {
    const state = readDxf(readFileSync(new URL('./fixtures/interchange/r2018-viewport-polygon.dxf', import.meta.url), 'utf8'));
    const layout = state.layouts!.find((l) => l.name === 'Polygon')!;
    expect(layout.viewports[0]!.clipBoundary?.points).toEqual(clip.points);
    const doc = new Drawing({ ...state, space: { layout: 'Polygon' } });
    const frame = doc.entities.find((e) => e.id === layout.viewports[0]!.id)!;
    doc.replaceEntities([translateEntity(frame, { x: 1, y: 2 })]);
    const back = readDxf(writeDxf(doc.snapshot)).layouts!.find((l) => l.name === 'Polygon')!;
    expect(back.viewports[0]!.clipBoundary?.points).toEqual(clip.points.map((p) => ({ x: p.x + 1, y: p.y + 2 })));
    expect(back.viewports[0]!.view.twist).toBeCloseTo(Math.PI / 6, 9);
  });
  it('uses the concave interior and boundary for viewport activation', () => {
    const v = viewport();
    expect(pointInViewport(v, { x: 3, y: 7 })).toBe(true);
    expect(pointInViewport(v, { x: 7, y: 3 })).toBe(true);
    expect(pointInViewport(v, { x: 7, y: 7 })).toBe(false);
    expect(pointInViewport(v, { x: 4, y: 6 })).toBe(true);
    expect(pointInViewport(v, { x: 9, y: 3 })).toBe(false);
    expect(viewportAt({ ...defaultLayout('Polygon'), viewports: [v] }, { x: 7, y: 7 })).toBeUndefined();
  });

  it('imports, moves, undoes, saves and reopens a native handle-linked clip without rotating model geometry', () => {
    const original = scene();
    const text = writeDxf(original.snapshot);
    expect(text).toMatch(/\r\n340\r\n[0-9A-F]+\r\n/);
    const state = readDxf(text);
    const v = state.layouts![0]!.viewports[0]!;
    expect(v.clipBoundary).toMatchObject({ points: clip.points, color: 2, trueColor: 0x123456, closed: true });
    expect(state.layouts![0]!.entities).toHaveLength(0); // clip is one viewport outline, not a duplicated paper object
    expect(importReportOf(state)?.items.some((item) => item.type === 'VIEWPORT')).toBeFalsy();
    const doc = new Drawing({ ...state, space: { layout: 'Polygon' } });
    const model = doc.snapshot.entities;
    const [frame] = paperEntities(doc.snapshot.layouts![0]!);
    doc.replaceEntities([translateEntity(frame!, { x: 1, y: 2 })]);
    const moved = doc.snapshot.layouts![0]!.viewports[0]!;
    expect(moved.center).toEqual({ x: 6, y: 7 });
    expect(moved.view).toEqual(v.view);
    expect(doc.snapshot.entities).toBe(model);
    doc.undo(); expect(doc.snapshot.layouts![0]!.viewports[0]!.clipBoundary?.points).toEqual(clip.points);
    doc.redo();
    const back = readDxf(writeDxf(doc.snapshot));
    expect(back.layouts![0]!.viewports[0]!.clipBoundary?.points).toEqual(clip.points.map((p) => ({ x: p.x + 1, y: p.y + 2 })));
    expect(back.layouts![0]!.viewports[0]!.view.twist).toBeCloseTo(Math.PI / 6, 9);
    expect(back.entities.map(({ id: _id, ...e }) => e)).toEqual(state.entities.map(({ id: _id, ...e }) => e));
  });

  it('preserves a four-vertex polygon when editing a grip instead of forcing it into a rectangle', () => {
    const doc = scene();
    const four = { ...viewport(), clipBoundary: { ...clip, points: [{ x: 5, y: 2 }, { x: 8, y: 5 }, { x: 5, y: 8 }, { x: 2, y: 5 }] } };
    doc.load({ ...doc.snapshot, layouts: [{ ...defaultLayout('Polygon'), viewports: [four] }], space: { layout: 'Polygon' } });
    const frame = doc.entities[0]!;
    const changed = moveGrip(frame, 0, { x: 5, y: 1 })!;
    doc.replaceEntities([changed]);
    expect(doc.snapshot.layouts![0]!.viewports[0]!.clipBoundary!.points).toEqual([{ x: 5, y: 1 }, ...four.clipBoundary.points.slice(1)]);
    expect(doc.snapshot.layouts![0]!.viewports[0]!.width).toBe(6);
    expect(doc.snapshot.layouts![0]!.viewports[0]!.height).toBe(7);
    expect(pointInViewport(doc.snapshot.layouts![0]!.viewports[0]!, { x: 5, y: 1 })).toBe(true);
  });

  it('warns about curved clips while retaining the readable boundary geometry', () => {
    const text = writeDxf(scene().snapshot).replace('10\r\n2\r\n20\r\n2\r\n10\r\n8', '10\r\n2\r\n20\r\n2\r\n42\r\n0.5\r\n10\r\n8');
    const state = readDxf(text);
    expect(state.layouts![0]!.viewports[0]!.clipBoundary).toBeUndefined();
    expect(state.layouts![0]!.entities.some((e) => e.type === 'polyline' && e.bulges?.some((b) => b !== 0))).toBe(true);
    expect(importReportOf(state)!.items).toContainEqual(expect.objectContaining({ type: 'VIEWPORT', action: 'simplified', reason: expect.stringMatching(/clipping boundary/) }));
  });

  it('refuses to silently export an invalid retained clip', () => {
    const doc = scene();
    expect(() => writeDxf({ ...doc.snapshot, layouts: [{ ...defaultLayout('Invalid'), viewports: [{ ...viewport(), clipBoundary: { ...clip, points: clip.points.slice(0, 2) } }] }] })).toThrow(/clip boundary/);
  });

  it('gives shared immutable clip copies distinct native handles and owners', () => {
    const doc = scene(), layout = doc.snapshot.layouts![0]!;
    const text = writeDxf({ ...doc.snapshot, layouts: [layout, { ...layout, name: 'Copy', viewports: [{ ...layout.viewports[0]!, id: 'copy' }] }] });
    const records = text.split(/\r\n0\r\n(?=[A-Z][A-Z0-9_]*\r\n)/);
    const boundaries = records.filter((r) => r.startsWith('LWPOLYLINE\r\n') && /\r\n90\r\n6\r\n/.test(r));
    expect(boundaries).toHaveLength(2);
    const handles = boundaries.map((r) => /\r\n5\r\n([^\r]+)/.exec(r)![1]);
    const owners = boundaries.map((r) => /\r\n330\r\n([^\r]+)/.exec(r)![1]);
    expect(new Set(handles).size).toBe(2); expect(new Set(owners).size).toBe(2);
    const pointers = records.filter((r) => r.startsWith('VIEWPORT\r\n')).flatMap((r) => /\r\n340\r\n([^\r]+)/.exec(r)?.[1] ?? []);
    expect(pointers.sort()).toEqual(handles.sort());
    expect(readDxf(text).layouts!.every((l) => l.viewports[0]!.clipBoundary?.points.length === 6)).toBe(true);
  });

  it('retains disabled boundary data while keeping the native enable flag off', () => {
    const doc = scene(), layout = doc.snapshot.layouts![0]!;
    const source = { ...doc.snapshot, layouts: [{ ...layout, viewports: [{ ...viewport(), clipOn: false }] }] };
    const back = readDxf(writeDxf(source));
    const v = back.layouts![0]!.viewports[0]!;
    expect(v.clipOn).toBe(false); expect(v.clipBoundary?.points).toEqual(clip.points);
    expect(pointInViewport(v, { x: 7, y: 7 })).toBe(true);
    expect(layoutPageSpec(back, back.layouts![0]!, doc.lookupBlock).groups[0]!.clipPolygon).toBeUndefined();
    expect(readDxf(writeDxf(back)).layouts![0]!.viewports[0]!.clipOn).toBe(false);
  });

  it('plots a clip boundary using its own appearance even when the viewport layer is no-plot', () => {
    const doc = scene(), layout = doc.snapshot.layouts![0]!;
    const state = { ...doc.snapshot, layers: [...doc.layers, { name: 'VIEWPORTS', color: 8, visible: true, locked: false, lineWeight: 0.25, plot: false }],
      layouts: [{ ...layout, viewports: [{ ...viewport(), layer: 'VIEWPORTS' }] }] };
    const page = layoutPageSpec(state, state.layouts[0]!, doc.lookupBlock);
    expect(page.groups.at(-1)!.entities).toContain(clip);
    const stream = renderPdfPages([page], drawingContext(state, doc.lookupBlock), { mode: 'color', lineweights: true, usePlotStyles: true })[0]!.content;
    expect(stream).toContain('0.071 0.204 0.337 RG');
  });

  it('projects and edits the boundary appearance independently of the viewport layer', () => {
    const layout = { ...defaultLayout('Polygon'), viewports: [{ ...viewport(), layer: 'VIEWPORTS' }] };
    const doc = new Drawing({ layouts: [layout], space: { layout: 'Polygon' } });
    const frame = doc.entities[0]!;
    expect(frame).toMatchObject({ layer: clip.layer, color: clip.color, trueColor: clip.trueColor });
    doc.replaceEntities([{ ...frame, layer: 'CLIPS', color: 3, trueColor: 0x987654 }]);
    const changed = doc.snapshot.layouts![0]!.viewports[0]!;
    expect(changed.layer).toBe('VIEWPORTS');
    expect(changed.clipBoundary).toMatchObject({ layer: 'CLIPS', color: 3, trueColor: 0x987654 });
    doc.undo(); expect(doc.snapshot.layouts![0]!.viewports[0]!.clipBoundary).toEqual(clip);
  });

  it('includes retained clip geometry when revalidating the drawing budget', () => {
    const doc = scene(), before = doc.snapshot;
    const points = Array.from({ length: 8192 }, (_, i) => ({ x: i, y: i % 2 }));
    const many = Array.from({ length: 130 }, (_, i) => ({ ...viewport(), id: String(i), clipBoundary: { ...clip, id: `clip-${i}`, points } }));
    expect(() => doc.transactDrawing((s) => ({ ...s, layouts: [{ ...s.layouts![0]!, viewports: many }] }))).toThrow(/geometry budget|expansion exceeds/);
    expect(doc.snapshot).toBe(before); expect(doc.dirty).toBe(false);
  });

  it('uses the same polygon in Canvas layout, raster plotting and vector plotting', () => {
    const doc = scene(), layout = doc.snapshot.layouts![0]!, pv = { center: { x: 5, y: 5 }, scale: 10 };
    const paths: Array<{ points: number[][]; rule: unknown }> = [];
    let points: number[][] = [];
    const api: Record<string, unknown> = {
      beginPath: () => { points = []; }, moveTo: (x: number, y: number) => points.push([x, y]), lineTo: (x: number, y: number) => points.push([x, y]),
      clip: (rule: unknown) => paths.push({ points: [...points], rule }),
    };
    const ctx = new Proxy(api, { get: (obj, key: string) => obj[key] ?? (() => {}), set: (obj, key: string, value) => { obj[key] = value; return true; } }) as unknown as CanvasRenderingContext2D;
    paintLayout(ctx, { width: 200, height: 200, px: (n: number) => n } as Viewport, { selection: new Set(), hover: null } as unknown as Parameters<typeof paintLayout>[2], { doc, paperView: () => pv });
    expect(paths.find((p) => p.rule === 'evenodd')!.points).toEqual(clip.points.map((p) => { const s = paperTransform(pv, 200, 200).toScreen(p); return [s.x, s.y]; }));
    const page = layoutPageSpec(doc.snapshot, layout, doc.lookupBlock), context = drawingContext(doc.snapshot, doc.lookupBlock);
    const stream = renderPdfPages([page], context, { mode: 'color', lineweights: true, usePlotStyles: true })[0]!.content;
    expect(stream).toContain('144 144 m 576 144 l 576 288 l 288 288 l 288 576 l 144 576 l h W* n');
    paths.length = 0;
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    renderPageToCanvas(canvas, page, context, { mode: 'color', lineweights: true, usePlotStyles: true }, 72);
    expect(paths.find((p) => p.rule === 'evenodd')!.points).toEqual(page.groups[0]!.clipPolygon!.map((p) => [p.x, canvas.height - p.y]));
  });
});
