import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { Drawing, DEFAULT_HEADER } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf, geometryProblem } from '../src/io/import-report';
import { convertDwg, type DwgImportPayload } from '../src/io/dwg';
import { blockTransform, distanceToEntity, entityBounds, entityGeometryWork, explodeInsert, mirrorEntityAcross, moveGrip, pointInPolygon, scaleEntityBy, snapCandidates, translateEntity, type PolylineEntity, type InsertEntity } from '../src/core/entities';
import { polylineWidthGeometry, strokeOutlinePolygons } from '../src/core/polyline-widths';
import { drawEntity } from '../src/render/draw';
import { paintOpacityGroup, MAX_OPACITY_GROUP_PIXELS } from '../src/render/opacity-group';
import { drawingContext, plotPages, vectorPdf } from '../src/io/pdf-vector';
import type { PlotOptions } from '../src/app/plot';
import { pageContents, parseContentStream, parsePdfBasics } from './helpers/pdf';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures/polyline-widths.dxf'), 'utf8').replace(/\r\n/g, '\n');
const TABLOID_LANDSCAPE: PlotOptions = { paper: 'tabloid', orientation: 'landscape', scale: 'fit', margin: 0.5 };
const state = () => readDxf(fixture);
const lookup = () => undefined;
const tapered = (): PolylineEntity => ({ id: 'taper', layer: '0', color: 'ByLayer', type: 'polyline', closed: false, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], widths: [{ start: 0, end: 4 }, { start: 0, end: 0 }] });
const poly = (entity: unknown) => entity as PolylineEntity;

describe('native polyline widths from independent DXF records', () => {
  it('associates 40/41 with the outgoing vertex even before group20, overriding constant43', () => {
    const e = poly(state().entities[0]);
    expect(e.points).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]);
    expect(e.widths).toEqual([{ start: 0, end: 4 }, { start: 4, end: 2 }, { start: 7, end: 9 }]);
    expect(e.width).toBeUndefined();
    expect(e.bulges).toEqual([0, 1, 0]);
    expect(importReportOf(state())?.items.some((item) => /widths are not kept/.test(item.reason))).toBeFalsy();
  });
  it('inherits legacy POLYLINE defaults independently while explicit zero overrides them', () => {
    expect(poly(state().entities[1]).widths).toEqual([{ start: 2, end: 3 }, { start: 0, end: 6 }]);
  });
  it('keeps constant-width entities on their existing path', () => {
    const e = poly(state().entities[2]);
    expect(e.width).toBe(4);
    expect(e.widths).toBeUndefined();
    expect(entityBounds(e, lookup)).toEqual({ min: { x: -2, y: 28 }, max: { x: 12, y: 32 } });
  });
  it('writes vertex widths as native groups40/41 and reopens their unused terminal values', () => {
    const before = state(), encoded = writeDxf(before), after = readDxf(encoded);
    for (let i = 0; i < 3; i++) {
      expect(poly(after.entities[i]).widths).toEqual(poly(before.entities[i]).widths);
      expect(poly(after.entities[i]).width).toEqual(poly(before.entities[i]).width);
    }
    expect(encoded).toMatch(/40\r?\n7\r?\n41\r?\n9/);
    expect(encoded).not.toMatch(/43\r?\n20\r?\n/);
    expect(after.blocks.WIDE!.entities[0]).toMatchObject({ widths: [{ start: 2, end: 6 }, { start: 0, end: 0 }] });
  });
  it.each(['-1', '1e309', 'NaN', '1junk'])('drops and reports invalid vertex width %s', (value) => {
    const invalid = readDxf(fixture.replace('40\n0\n41\n4', `40\n${value}\n41\n4`));
    expect(invalid.entities).toHaveLength(3);
    expect(importReportOf(invalid)?.items.some((item) => item.action === 'dropped' && /width|finite|numeric/.test(item.reason))).toBe(true);
  });
  it('retains exposed DWG start/end data independently instead of copying the first start width', () => {
    const payload = { header: {}, layers: [], blocks: [], entities: [{ type: 'LWPOLYLINE', layer: '0', flag: 0, vertices: [{ x: 0, y: 0, startWidth: 2, endWidth: 6 }, { x: 10, y: 0, startWidth: 4, endWidth: 1 }] }, { type: 'POLYLINE2D', layer: '0', flag: 0, startWidth: 3, endWidth: 7, vertices: [{ x: 0, y: 0, startWidth: 0 }, { x: 10, y: 0, endWidth: 2 }] }] } as unknown as DwgImportPayload;
    const result = convertDwg(payload).state;
    expect(poly(result.entities[0]).widths).toEqual([{ start: 2, end: 6 }, { start: 4, end: 1 }]);
    expect(poly(result.entities[1]).widths).toEqual([{ start: 0, end: 7 }, { start: 3, end: 2 }]);
  });
});

describe('shared tapered geometry', () => {
  it('uses a tapered footprint and butt ends for bounds and hit testing', () => {
    const e = tapered();
    expect(entityBounds(e, lookup)).toEqual({ min: { x: 0, y: -2 }, max: { x: 10, y: 2 } });
    expect(distanceToEntity({ x: 9, y: 1 }, e, lookup)).toBe(0);
    expect(distanceToEntity({ x: 1, y: 1 }, e, lookup)).toBeCloseTo(0.8 / Math.hypot(1, 0.2));
    expect(distanceToEntity({ x: 11, y: 0 }, e, lookup)).toBeCloseTo(1);
    expect(snapCandidates(e, lookup).map((candidate) => candidate.point)).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }]);
  });
  it('interpolates width along a bulged segment and mirrors the visible sweep', () => {
    const e = { ...tapered(), widths: [{ start: 2, end: 6 }, { start: 0, end: 0 }], bulges: [1, 0] };
    const geometry = polylineWidthGeometry(e);
    expect(geometry.polygons[0]).toHaveLength(66);
    expect(distanceToEntity({ x: 5, y: -6.9 }, e, lookup)).toBe(0);
    const reflected = poly(mirrorEntityAcross(e, { x: 0, y: 0 }, { x: 1, y: 0 }));
    expect(reflected.widths).toEqual(e.widths);
    expect(distanceToEntity({ x: 5, y: 6.9 }, reflected, lookup)).toBe(0);
    expect(distanceToEntity({ x: 5, y: -6.9 }, reflected, lookup)).toBeGreaterThan(1);
  });
  it('connects an angular width join and includes the closing segment', () => {
    const e = { ...tapered(), closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], widths: [{ start: 2, end: 2 }, { start: 2, end: 2 }, { start: 2, end: 2 }] };
    expect(distanceToEntity({ x: 10.2, y: -0.2 }, e, lookup)).toBe(0);
    expect(distanceToEntity({ x: 5, y: 5 }, e, lookup)).toBe(0);
  });
  it('keeps explicit thin segments and avoids caching mutable custom entities', () => {
    const e = tapered();
    const widths = [{ start: 0, end: 0 }, { start: 0, end: 0 }];
    const mutable = { ...e, widths };
    expect(polylineWidthGeometry(mutable).polygons).toHaveLength(0);
    widths[0]!.end = 4;
    expect(polylineWidthGeometry(mutable).polygons).toHaveLength(1);
    expect(distanceToEntity({ x: 9, y: 1 }, mutable, lookup)).toBe(0);
  });
  it('keeps a closed zero-width outline thin without filling its interior', () => {
    const e = { ...tapered(), closed: true, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], widths: [{ start: 0, end: 0 }, { start: 0, end: 0 }, { start: 0, end: 0 }] };
    expect(polylineWidthGeometry(e).polygons).toHaveLength(0);
    expect(polylineWidthGeometry(e).thin).toHaveLength(3);
    expect(distanceToEntity({ x: 7, y: 3 }, e, lookup)).toBeGreaterThan(2);
  });
  it('scales both widths, and grip changes keep their vertex association', () => {
    const e = poly(scaleEntityBy(tapered(), { x: 0, y: 0 }, 3));
    expect(e.widths?.[0]).toEqual({ start: 0, end: 12 });
    const moved = poly(moveGrip(e, 1, { x: 20, y: 0 }));
    expect(moved.widths).toEqual(e.widths);
    expect(entityBounds(moved, lookup)).toEqual({ min: { x: 0, y: -6 }, max: { x: 20, y: 6 } });
    const inverted = poly(scaleEntityBy(tapered(), { x: 0, y: 0 }, -2));
    expect(inverted.widths?.[0]).toEqual({ start: 0, end: 8 });
    expect(geometryProblem(inverted)).toBeNull();
  });
  it('uses bounded outline work in the drawing and block budgets', () => {
    expect(entityGeometryWork(tapered())).toBeGreaterThan(tapered().points.length);
    const heavy = { ...tapered(), points: Array.from({ length: 90_000 }, (_, x) => ({ x, y: 0 })), widths: Array.from({ length: 90_000 }, () => ({ start: 2, end: 4 })) };
    expect(() => new Drawing({ entities: [heavy] })).toThrow(/geometry budget/);
  });
  it('rejects mutable invalid widths and overflowing derived geometry before accepting an edit', () => {
    const doc = new Drawing({ entities: [tapered()] }), before = doc.snapshot;
    expect(() => doc.replaceEntities([{ ...tapered(), widths: [{ start: -1, end: 4 }, { start: 0, end: 0 }] }])).toThrow(/width/);
    expect(doc.snapshot).toBe(before);
    expect(geometryProblem({ ...tapered(), points: [{ x: 1e308, y: 0 }, { x: -1e308, y: 0 }] })).toMatch(/finite coordinate/);
    expect(geometryProblem({ ...tapered(), bulges: [1e308, 0] })).toMatch(/finite coordinate/);
  });
});

describe('nonuniform blocks and output', () => {
  it('transforms the width footprint directionally and keeps centerline snaps', () => {
    const s = state(), e = s.entities[3] as InsertEntity, parts = explodeInsert(e, (name) => s.blocks[name]);
    const transformed = poly(parts[0]);
    expect(entityBounds(transformed, lookup)).toEqual({ min: { x: 30, y: 18.5 }, max: { x: 50, y: 21.5 } });
    expect(distanceToEntity({ x: 49, y: 21 }, transformed, lookup)).toBe(0);
    expect(distanceToEntity({ x: 31, y: 21 }, transformed, lookup)).toBeGreaterThan(0);
    expect(snapCandidates(transformed, lookup).map((candidate) => candidate.point)).toEqual([{ x: 30, y: 20 }, { x: 50, y: 20 }, { x: 40, y: 20 }]);
    const translated = poly(translateEntity(transformed, { x: 2, y: 3 }));
    expect(entityBounds(translated, lookup)).toEqual({ min: { x: 32, y: 21.5 }, max: { x: 52, y: 24.5 } });
    const stretched = poly(moveGrip(transformed, 1, { x: 60, y: 20 }));
    expect(entityBounds(stretched, lookup)?.max.x).toBeCloseTo(60);
  });
  it('keeps native widths when saving a nonuniform reference', () => {
    const s = state(), reopened = readDxf(writeDxf(s)), reference = reopened.entities[3] as InsertEntity;
    expect(reference.scaleY).toBe(0.5);
    expect(poly(reopened.blocks.WIDE!.entities[0]).widths).toEqual(poly(s.blocks.WIDE!.entities[0]).widths);
    expect(entityBounds(reference, (name) => reopened.blocks[name])).toEqual(entityBounds(s.entities[3]!, (name) => s.blocks[name]));
  });
  it.each([false, true])('saves flattened affine geometry as native nested blocks, including shear and mirror=%s', (mirror) => {
    const source = { ...tapered(), bulges: [1, 0] };
    const tf = (p: { x: number; y: number }) => ({ x: 7 + (mirror ? -2 : 2) * p.x + p.y, y: 3 + p.y });
    const e = poly(blockTransform(source, tf, 0, 2, 1, mirror));
    const s = new Drawing({ entities: [e] }).snapshot, reopened = readDxf(writeDxf(s));
    const before = entityBounds(e, lookup)!, after = entityBounds(reopened.entities[0]!, (name) => reopened.blocks[name])!;
    expect(after.min.x).toBeCloseTo(before.min.x, 5);
    expect(after.min.y).toBeCloseTo(before.min.y, 5);
    expect(after.max.x).toBeCloseTo(before.max.x, 5);
    expect(after.max.y).toBeCloseTo(before.max.y, 5);
    expect(Object.values(reopened.blocks).flatMap((block) => block.entities).some((entity) => entity.type === 'polyline' && entity.widths?.[0]?.end === 4)).toBe(true);
  });
  it('refuses affine export wrappers that would hide a visible deeply nested polyline', () => {
    const frame = blockTransform(tapered(), (p) => ({ x: p.x * 2 + p.y, y: p.y }), 0, 2, 1, false);
    const reference = (block: string): InsertEntity => ({ id: block, type: 'insert', block, layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} });
    const blocks = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`B${i}`, { name: `B${i}`, basePoint: { x: 0, y: 0 }, attributes: [], entities: [i === 7 ? frame : reference(`B${i + 1}`)] }]));
    const s = new Drawing({ entities: [reference('B0')], blocks }).snapshot;
    expect(explodeInsert(s.entities[0] as InsertEntity, (name) => s.blocks[name])).toHaveLength(1);
    expect(() => writeDxf(s)).toThrow(/safe block nesting limit/);
  });
  it('draws the same tapered filled footprint on canvas and vector PDF', () => {
    const e = tapered(), points: number[][] = [];
    const ctx = { save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: (x: number, y: number) => points.push([x, y]), lineTo: (x: number, y: number) => points.push([x, y]) } as unknown as CanvasRenderingContext2D;
    const s = new Drawing({ entities: [e] }).snapshot;
    drawEntity(ctx, e, { scale: 1, toScreen: (p) => p }, s.layers, lookup);
    expect(ctx.fill).toHaveBeenCalledOnce();
    expect(points).toContainEqual([10, 2]);
    expect(points).toContainEqual([10, -2]);
    const bytes = vectorPdf(plotPages(s, lookup, 'model', TABLOID_LANDSCAPE), drawingContext(s, lookup), { mode: 'color', lineweights: false, usePlotStyles: false }, 'Taper');
    const pdf = parsePdfBasics(bytes), streams = pageContents(pdf, (data) => new Uint8Array(inflateSync(data)));
    expect(pdf.errors).toEqual([]);
    expect(parseContentStream(streams[0]!).counts.f).toBeGreaterThan(0);
    expect(parseContentStream(streams[0]!).counts.l).toBeGreaterThanOrEqual(3);
  });
  it('clips dashed canvas and PDF strokes to the same tapered outline', () => {
    const e = { ...tapered(), linetype: 'DASHED' }, points: number[][] = [];
    const ctx = { save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), getLineDash: () => [3, 2], clip: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: (x: number, y: number) => points.push([x, y]), lineTo: (x: number, y: number) => points.push([x, y]) } as unknown as CanvasRenderingContext2D;
    const s = new Drawing({ entities: [e], header: { ...DEFAULT_HEADER, linetypes: [{ name: 'DASHED', description: 'test dashes', pattern: [3, -2] }] } }).snapshot;
    drawEntity(ctx, e, { scale: 1, toScreen: (p) => p }, s.layers, lookup);
    expect(ctx.clip).toHaveBeenCalledOnce();
    expect(ctx.stroke).toHaveBeenCalledOnce();
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(points).toContainEqual([10, 2]);
    expect(points).toContainEqual([10, -2]);
    const bytes = vectorPdf(plotPages(s, lookup, 'model', TABLOID_LANDSCAPE), drawingContext(s, lookup), { mode: 'color', lineweights: false, usePlotStyles: false }, 'Dashed taper');
    const pdf = parsePdfBasics(bytes), streams = pageContents(pdf, (data) => new Uint8Array(inflateSync(data)));
    const summary = parseContentStream(streams[0]!);
    expect(pdf.errors).toEqual([]);
    expect(summary.errors).toEqual([]);
    expect(summary.counts.W).toBe(1);
    expect(summary.counts.S).toBeGreaterThan(0);
    expect(summary.counts.f ?? 0).toBe(0);
    expect(summary.dashes.some((dash) => dash !== '[]')).toBe(true);
  });
});

describe('single paint operation for overlapping wide-polyline outlines', () => {
  const corner = (thin = false): PolylineEntity => ({ ...tapered(), points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], widths: [{ start: 2, end: 2 }, { start: thin ? 0 : 2, end: thin ? 0 : 2 }, { start: 0, end: 0 }] });
  const area = (polygon: readonly { x: number; y: number }[]) => polygon.reduce((sum, p, i) => { const q = polygon[(i + 1) % polygon.length]!; return sum + p.x * q.y - q.x * p.y; }, 0);

  it.each([false, true])('fills a continuous corner and explicit-zero segment at alpha0.5 once (thin=%s)', (thin) => {
    const paths: Array<Array<{ x: number; y: number }>> = [];
    let current: Array<{ x: number; y: number }> = [];
    const ctx = { globalAlpha: 1, save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), getLineDash: () => [], beginPath: () => { paths.length = 0; }, closePath: () => {}, fill: vi.fn(), stroke: vi.fn(), moveTo: (x: number, y: number) => { current = [{ x, y }]; paths.push(current); }, lineTo: (x: number, y: number) => current.push({ x, y }) } as unknown as CanvasRenderingContext2D;
    drawEntity(ctx, corner(thin), { scale: 1, toScreen: (p) => p }, [], lookup, { alpha: 0.5 });
    expect(ctx.globalAlpha).toBe(0.5);
    expect(ctx.fill).toHaveBeenCalledOnce();
    expect(ctx.stroke).not.toHaveBeenCalled();
    expect(paths.every((polygon) => area(polygon) >= 0)).toBe(true);
    // These outlines overlap, so the old per-polygon fills painted this point twice or more.
    const overlap = { x: 9.75, y: 0.25 };
    expect(paths.filter((polygon) => pointInPolygon(overlap, polygon)).length).toBeGreaterThan(1);
  });

  it.each([false, true])('retains each dashed segment mask inside one opaque cropped composite (thin=%s)', (thin) => {
    const internalAlpha: number[] = [], compositeAlpha: number[] = [];
    const group = { globalAlpha: 1, save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), setLineDash: vi.fn(), clip: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: () => internalAlpha.push(group.globalAlpha), moveTo: vi.fn(), lineTo: vi.fn() };
    const surface = { width: 1, height: 1, getContext: () => group };
    const parent = { width: 100, height: 100, ownerDocument: { createElement: () => surface } };
    const ctx = { canvas: parent, globalAlpha: 1, save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), drawImage: () => compositeAlpha.push(ctx.globalAlpha), getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), setLineDash: vi.fn(), getLineDash: () => [3, 2], clip: vi.fn(), beginPath: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn() } as unknown as CanvasRenderingContext2D;
    drawEntity(ctx, corner(thin), { scale: 1, toScreen: (p) => p }, [], lookup, { alpha: 0.5 });
    const masks = polylineWidthGeometry(corner(thin));
    expect(group.clip).toHaveBeenCalledTimes(masks.strokes.length);
    expect(internalAlpha).toEqual(Array(masks.strokes.length + Number(thin)).fill(1));
    expect(compositeAlpha).toEqual([0.5]);
    expect(ctx.clip).not.toHaveBeenCalled();
    expect(ctx.stroke).not.toHaveBeenCalled();
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(surface.width * surface.height).toBeLessThanOrEqual(MAX_OPACITY_GROUP_PIXELS);
  });

  it.each([false, true])('uses one PDF fill while opaque dashes retain individual masks (dashed=%s)', (dashed) => {
    const e = { ...corner(true), lineWeight: 0.5, ...(dashed ? { linetype: 'DASHED' } : {}) };
    const s = new Drawing({ entities: [e], header: { ...DEFAULT_HEADER, linetypes: [{ name: 'DASHED', description: 'test', pattern: [3, -2] }] } }).snapshot;
    const pdf = parsePdfBasics(vectorPdf(plotPages(s, lookup, 'model', TABLOID_LANDSCAPE), drawingContext(s, lookup), { mode: 'color', lineweights: true, usePlotStyles: false }));
    const summary = parseContentStream(pageContents(pdf, (data) => new Uint8Array(inflateSync(data)))[0]!);
    expect(pdf.errors).toEqual([]);
    expect(summary.errors).toEqual([]);
    expect(summary.counts.f ?? 0).toBe(dashed ? 0 : 1);
    expect(summary.counts.S ?? 0).toBe(dashed ? polylineWidthGeometry(e).strokes.length + 1 : 0);
    expect(summary.counts.W ?? 0).toBe(dashed ? polylineWidthGeometry(e).strokes.length : 0);
  });

  it('leaves an all-thin path as one native stroke and a filled SOLID on its existing path', () => {
    const thin = { ...corner(), widths: [{ start: 0, end: 0 }, { start: 0, end: 0 }, { start: 0, end: 0 }] };
    const solid = { ...corner(), filled: true, closed: true };
    for (const e of [thin, solid]) {
      const ctx = { save: vi.fn(), restore: vi.fn(), setLineDash: vi.fn(), getLineDash: () => [], beginPath: vi.fn(), closePath: vi.fn(), fill: vi.fn(), stroke: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn() } as unknown as CanvasRenderingContext2D;
      drawEntity(ctx, e, { scale: 1, toScreen: (p) => p }, [], lookup, { alpha: 0.5 });
      expect(ctx.fill).toHaveBeenCalledTimes(e === solid ? 1 : 0);
      expect(ctx.stroke).toHaveBeenCalledTimes(e === thin ? 1 : 0);
    }
  });

  it('rejects nonfinite strip widths and derived strip coordinates', () => {
    expect(() => strokeOutlinePolygons([[{ x: 0, y: 0 }, { x: 1, y: 0 }]], Infinity)).toThrow(/finite/);
    expect(() => strokeOutlinePolygons([[{ x: 0, y: 1e308 }, { x: 1e308, y: 1e308 }]], 1.7e308)).toThrow(/finite coordinate/);
  });

  it('tiles large visible groups without overlapping composites and refuses excessive surface/work budgets', () => {
    const tiles: Array<{ x: number; y: number; width: number; height: number; alpha: number }> = [];
    const group = { setTransform: vi.fn(), setLineDash: vi.fn(), globalAlpha: 1 };
    const surface = { width: 1, height: 1, getContext: () => group };
    const parent = { width: 10000, height: 10, ownerDocument: { createElement: () => surface } };
    const ctx = { canvas: parent, globalAlpha: 0.5, lineWidth: 1, save: vi.fn(), restore: vi.fn(), setTransform: vi.fn(), getLineDash: () => [], getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), drawImage: (_canvas: unknown, x: number, y: number) => tiles.push({ x, y, width: surface.width, height: surface.height, alpha: ctx.globalAlpha }) } as unknown as CanvasRenderingContext2D;
    paintOpacityGroup(ctx, [[{ x: 0, y: 0 }, { x: 9000, y: 1 }]], (p) => p, () => expect(group.globalAlpha).toBe(1));
    expect(tiles).toHaveLength(5);
    for (let i = 0; i < tiles.length; i++) {
      expect(tiles[i]!.width * tiles[i]!.height).toBeLessThanOrEqual(MAX_OPACITY_GROUP_PIXELS);
      expect(tiles[i]!.alpha).toBe(0.5);
      if (i) expect(tiles[i]!.x).toBe(tiles[i - 1]!.x + tiles[i - 1]!.width);
    }
    parent.width = parent.height = 50000;
    expect(() => paintOpacityGroup(ctx, [[{ x: 0, y: 0 }, { x: 49999, y: 49999 }]], (p) => p, () => {})).toThrow(/bounded visible compositing area/);
    parent.width = 5000; parent.height = 10;
    const heavy = Array<{ x: number; y: number }>(700_000).fill({ x: 0, y: 0 });
    heavy.push({ x: 4999, y: 1 });
    expect(() => paintOpacityGroup(ctx, [heavy], (p) => p, () => {})).toThrow(/work budget/);
  });
});
