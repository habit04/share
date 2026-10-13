import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { HatchEntity } from '../src/core/entities';
import { blockTransform } from '../src/core/entities';
import { drawEntity } from '../src/render/draw';
import { renderPdfPages, assembleVectorPdf, drawingContext, type PdfPageSpec } from '../src/io/pdf-vector';
import { parsePdfBasics } from './helpers/pdf';

const loop = (x: number, y: number, width: number, height: number) => ({ points: [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }] });
const hatch = (): HatchEntity => ({ id: 'gradient', type: 'hatch', layer: '0', color: 3, solid: true, pattern: 'SOLID', angle: 0, scale: 1,
  loops: [loop(0, 0, 20, 10), loop(5, 2, 4, 4)], gradient: { name: 'LINEAR', angle: 0, shift: 0, singleColor: false, tint: 0.5,
    colors: [{ position: 0, color: 0 }, { position: 1, color: 5, trueColor: 0x0000ff }] } });
const style = { mode: 'color' as const, lineweights: true, usePlotStyles: true };
function page(entity: HatchEntity, rotation = 0): PdfPageSpec {
  return { label: 'Gradient', width: 400, height: 200, groups: [{ entities: [entity], k: 10, e: 50, f: 20, rotation, hidden: new Set(), ltUnit: 10, annoFactor: 1,
    clip: { x: 0, y: 0, w: 400, h: 200 }, clipPolygon: [{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 0, y: 200 }] }] };
}
function recorder() {
  const axes: number[][] = [], stops: Array<[number, string]> = [], fills: string[] = [];
  const api: Record<string, unknown> = { globalAlpha: 1, createLinearGradient: (...values: number[]) => { axes.push(values); return { addColorStop: (offset: number, color: string) => stops.push([offset, color]) }; },
    fill: (rule: string) => fills.push(rule), setLineDash: () => {} };
  for (const name of ['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'stroke', 'translate', 'rotate']) api[name] = () => {};
  return { ctx: api as unknown as CanvasRenderingContext2D, axes, stops, fills };
}

describe('verified unshifted LINEAR gradient painters', () => {
  it('paints native black and RGB stops through the even-odd boundary', () => {
    const r = recorder();
    drawEntity(r.ctx, hatch(), { scale: 10, toScreen: (p) => ({ x: 10 * p.x, y: 100 - 10 * p.y }) }, new Drawing().layers, () => undefined);
    expect(r.axes).toHaveLength(1);
    r.axes[0]!.forEach((value, i) => expect(value).toBeCloseTo([0, 100, 200, 100][i]!, 9));
    expect(r.stops).toEqual([[0, '#000000'], [1, '#0000ff']]);
    expect(r.fills).toEqual(['evenodd']);
  });
  it('uses the dual affine axis for sheared block gradients', () => {
    const h = blockTransform(hatch(), (p) => ({ x: 2 * p.x + p.y, y: 3 * p.y }), 0, 2, 3, false) as HatchEntity;
    const r = recorder();
    drawEntity(r.ctx, h, { scale: 1, toScreen: (p) => p }, new Drawing().layers, () => undefined);
    const [sx, sy, ex, ey] = r.axes[0]!;
    const dx = ex! - sx!, dy = ey! - sy!, norm = dx * dx + dy * dy;
    const value = (x: number, y: number) => ((x - sx!) * dx + (y - sy!) * dy) / norm;
    expect(value(20, 0)).toBeCloseTo(0.5);
    expect(value(30, 30)).toBeCloseTo(0.5);
  });
  it.each(['CYLINDER', 'UNKNOWN'])('retains an unsupported %s descriptor while using the fill fallback', (name) => {
    const h = hatch(), r = recorder();
    drawEntity(r.ctx, { ...h, gradient: { ...h.gradient!, name } }, { scale: 1, toScreen: (p) => p }, new Drawing().layers, () => undefined);
    expect(r.axes).toHaveLength(0); expect(r.fills).toEqual(['evenodd']);
  });
  it('does not invent shifted colors or bypass a monochrome/selection override', () => {
    for (const shifted of [true, false]) {
      const h = hatch(), r = recorder();
      drawEntity(r.ctx, { ...h, gradient: { ...h.gradient!, shift: shifted ? 1 : 0 } }, { scale: 1, toScreen: (p) => p }, new Drawing().layers, () => undefined, shifted ? {} : { strokeOverride: '#000000' });
      expect(r.axes).toHaveLength(0);
    }
  });
  it('emits smooth axial PDF shading with hole/viewport clips, rotation and opacity', () => {
    const h = { ...hatch(), transparency: 128 };
    const doc = new Drawing({ entities: [h] });
    const rendered = renderPdfPages([page(h, Math.PI / 6)], drawingContext(doc.snapshot, doc.lookupBlock), style)[0]!;
    expect(rendered.content).toContain('W* n');
    expect(rendered.content).toContain('/G1 sh Q');
    expect(rendered.content).toContain('/A128 gs');
    expect(rendered.gradients).toEqual([{ name: 'G1', colors: [[0, 0, 0], [0, 0, 1]] }]);
    expect(rendered.images).toEqual([]);
    const parsed = parsePdfBasics(assembleVectorPdf([rendered]));
    expect(parsed.errors).toEqual([]);
    expect([...parsed.objects.values()].some((o) => o.dict.includes('/ShadingType 2'))).toBe(true);
    expect([...parsed.objects.values()].some((o) => o.dict.includes('/Shading << /G1'))).toBe(true);
  });
  it('maps PDF endpoint colors through grayscale and monochrome plot styles', () => {
    const h = hatch(), doc = new Drawing({ entities: [h] });
    const ctx = drawingContext(doc.snapshot, doc.lookupBlock);
    const mono = renderPdfPages([page(h)], ctx, { ...style, mode: 'monochrome' })[0]!;
    expect(mono.gradients![0]!.colors).toEqual([[0, 0, 0], [0, 0, 0]]);
    const gray = renderPdfPages([page(h)], ctx, { ...style, mode: 'grayscale' })[0]!;
    expect(gray.gradients![0]!.colors[1]).toEqual([0.114, 0.114, 0.114]);
  });
  it('uses native gradient ACI7 as white even on paper when RGB is absent', () => {
    const source = hatch(), h = { ...source, gradient: { ...source.gradient!, colors: [{ position: 0, color: 0 }, { position: 1, color: 7 }] } };
    const doc = new Drawing({ entities: [h] });
    const rendered = renderPdfPages([page(h)], drawingContext(doc.snapshot, doc.lookupBlock), style)[0]!;
    expect(rendered.gradients![0]!.colors).toEqual([[0, 0, 0], [1, 1, 1]]);
  });
  it('refuses overflowing or precision-collapsed PDF gradient matrices instead of formatting them as zero', () => {
    for (const frame of [
      { origin: { x: 0, y: 0 }, x: { x: 1e307, y: 0 }, y: { x: 0, y: 1e307 } },
      { origin: { x: 1e100, y: 0 }, x: { x: 1, y: 0 }, y: { x: 0, y: 1 } },
      // Finite matrix collapses only after the writer's three-decimal formatting.
      { origin: { x: 0, y: 0 }, x: { x: 1, y: 1 }, y: { x: 1, y: 1.000001 } },
      // PDF numbers cannot use the exponent notation returned by toFixed at large scales.
      { origin: { x: 0, y: 0 }, x: { x: 1e21, y: 0 }, y: { x: 0, y: 1e21 } },
    ]) {
      const h = { ...hatch(), gradientFrame: frame }, doc = new Drawing({ entities: [h] });
      const source = page(h), huge = { ...source, groups: source.groups.map((group) => ({ ...group, k: 100 })) };
      expect(() => renderPdfPages([huge], drawingContext(doc.snapshot, doc.lookupBlock), style)).toThrow('Cannot plot hatch gradient');
    }
  });
});
