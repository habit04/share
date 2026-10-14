import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/render/draw', async (original) => ({ ...await original<typeof import('../src/render/draw')>(), drawEntity: vi.fn() }));
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { drawEntity } from '../src/render/draw';
import { backingSize, Viewport, type ViewportOverlay } from '../src/render/viewport';

type Matrix = [number, number, number, number, number, number];
type Rgba = [number, number, number, number];
interface Paint {
  kind: 'fill' | 'clear' | 'blit' | 'geometry';
  matrix: Matrix;
  rect?: number[];
  source?: HTMLCanvasElement;
  argumentCount?: number;
  entity?: Entity;
}
interface Surface {
  element: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  children: Surface[];
  paints: Paint[];
  matrix(): Matrix;
  pixels(): Uint8ClampedArray;
  mark(x: number, y: number, color: Rgba): void;
  throwOnBlit: Error | null;
}
const surfaces = new WeakMap<object, Surface>();

/** Small independent pixel model for rectangle coverage/source-over and bitmap copies.
 * Fractional physical coverage exposes repeated-alpha edges; scaled copies cannot
 * pass the byte comparison of a deliberately nonuniform cached bitmap.
 */
function surface(): Surface {
  let width = 1, height = 1, pixels = new Uint8ClampedArray(4), matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const paints: Paint[] = [], children: Surface[] = [], events = new EventTarget();
  const stack: Array<{ matrix: Matrix; fillStyle: unknown; globalAlpha: unknown }> = [];
  const target: Record<string, unknown> = { fillStyle: '#000000', globalAlpha: 1, measureText: () => ({ width: 10 }), isContextLost: () => false };
  const pixel = (x: number, y: number) => (y * width + x) * 4;
  const rectangle = (x: number, y: number, w: number, h: number, visit: (index: number, coverage: number, px: number, py: number) => void) => {
    const left = x * matrix[0] + matrix[4], top = y * matrix[3] + matrix[5];
    const right = left + w * matrix[0], bottom = top + h * matrix[3];
    for (let py = Math.max(0, Math.floor(top)); py < Math.min(height, Math.ceil(bottom)); py++) for (let px = Math.max(0, Math.floor(left)); px < Math.min(width, Math.ceil(right)); px++) {
      const coverage = Math.max(0, Math.min(px + 1, right) - Math.max(px, left)) * Math.max(0, Math.min(py + 1, bottom) - Math.max(py, top));
      if (coverage) visit(pixel(px, py), coverage, px, py);
    }
  };
  const composite = (index: number, color: Rgba, coverage: number) => {
    const alpha = color[3] / 255 * coverage, before = pixels[index + 3]! / 255, after = alpha + before * (1 - alpha);
    for (let channel = 0; channel < 3; channel++) pixels[index + channel] = after ? (color[channel]! * alpha + pixels[index + channel]! * before * (1 - alpha)) / after : 0;
    pixels[index + 3] = after * 255;
  };
  Object.assign(target, {
    setTransform: vi.fn((...value: Matrix) => { matrix = [...value]; }),
    save: () => stack.push({ matrix: [...matrix], fillStyle: target.fillStyle, globalAlpha: target.globalAlpha }),
    restore: () => { const saved = stack.pop(); if (saved) { matrix = saved.matrix; target.fillStyle = saved.fillStyle; target.globalAlpha = saved.globalAlpha; } },
    fillRect: vi.fn((x: number, y: number, w: number, h: number) => {
      paints.push({ kind: 'fill', matrix: [...matrix], rect: [x, y, w, h] });
      const css = String(target.fillStyle), value = Number.parseInt(css.slice(1), 16);
      const rgba: Rgba = [value >> 16 & 255, value >> 8 & 255, value & 255, Math.round(Number(target.globalAlpha) * 255)];
      rectangle(x, y, w, h, (index, coverage) => composite(index, rgba, coverage));
    }),
    clearRect: vi.fn((x: number, y: number, w: number, h: number) => {
      paints.push({ kind: 'clear', matrix: [...matrix], rect: [x, y, w, h] });
      rectangle(x, y, w, h, (index, coverage) => { pixels[index + 3] = pixels[index + 3]! * (1 - coverage); if (!pixels[index + 3]) pixels.fill(0, index, index + 4); });
    }),
    drawImage: vi.fn((...args: [HTMLCanvasElement, number, number, number?, number?]) => {
      const [image, dx, dy, dw, dh] = args, source = surfaces.get(image)!;
      paints.push({ kind: 'blit', matrix: [...matrix], source: image, argumentCount: args.length });
      if (current.throwOnBlit) throw current.throwOnBlit;
      const sourcePixels = source.pixels().slice(), destW = dw ?? image.width, destH = dh ?? image.height;
      const physicalX = dx * matrix[0] + matrix[4], physicalY = dy * matrix[3] + matrix[5];
      rectangle(dx, dy, destW, destH, (index, coverage, px, py) => {
        const sx = Math.floor((px + 0.5 - physicalX) / (destW * matrix[0]) * image.width);
        const sy = Math.floor((py + 0.5 - physicalY) / (destH * matrix[3]) * image.height);
        if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) return;
        const offset = (sy * image.width + sx) * 4;
        composite(index, Array.from(sourcePixels.slice(offset, offset + 4)) as Rgba, coverage);
      });
    }),
  });
  const context = new Proxy(target, {
    get(object, key: string) { return object[key] ?? (object[key] = vi.fn()); },
    set(object, key: string, value) { object[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  const reset = () => { pixels = new Uint8ClampedArray(width * height * 4); matrix = [1, 0, 0, 1, 0, 0]; stack.length = 0; target.fillStyle = '#000000'; target.globalAlpha = 1; };
  const element = Object.assign(new EventTarget(), {
    getContext: () => context,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
    ownerDocument: { createElement: () => { const child = surface(); children.push(child); return child.element; } },
  }) as unknown as HTMLCanvasElement;
  Object.defineProperties(element, {
    width: { get: () => width, set: (value: number) => { width = value; reset(); } },
    height: { get: () => height, set: (value: number) => { height = value; reset(); } },
  });
  const current: Surface = { element, context, children, paints, matrix: () => [...matrix], pixels: () => pixels,
    mark: (x, y, color) => pixels.set(color, pixel(x, y)), throwOnBlit: null };
  surfaces.set(element, current); surfaces.set(context, current);
  return current;
}

const overlay = (): ViewportOverlay => ({ preview: [], ghost: [], selection: new Set(), hover: null, selectionBox: null, snap: null, cursor: null, trackFrom: null, dynText: [], cursorMode: 'idle' });
const identity: Matrix = [1, 0, 0, 1, 0, 0];
const background: Rgba = [33, 40, 48, 255];
const geometry: Entity = { id: 'line', type: 'line', color: 'ByLayer', layer: '0', a: { x: -1, y: 0 }, b: { x: 1, y: 0 } };
function setup(dpr: number, count = 0) {
  const output = surface(), doc = new Drawing({ entities: Array.from({ length: count }, (_, index) => ({ ...geometry, id: `line-${index}` })), blocks: {}, layers: [{ name: '0', color: 3, visible: true, locked: false, lineWeight: 0.25 }], currentLayer: '0' });
  const vp = new Viewport(output.element, doc), dimensions = backingSize(10, 7, dpr);
  vp.width = 10; vp.height = 7; vp.dpr = dpr; vp.scale = 1; vp.center = { x: 0, y: 0 }; vp.settings.gridVisible = false;
  output.element.width = dimensions.width; output.element.height = dimensions.height;
  vi.mocked(drawEntity).mockImplementation((context, entity) => { const current = surfaces.get(context)!; current.paints.push({ kind: 'geometry', matrix: current.matrix(), entity }); });
  return { output, doc, vp, dimensions };
}
function expectPixels(output: Surface, rgba = background) {
  const expected = new Uint8ClampedArray(output.element.width * output.element.height * 4);
  for (let offset = 0; offset < expected.length; offset += 4) expected.set(rgba, offset);
  expect(output.pixels()).toEqual(expected);
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('fractional DPR physical backing coverage', () => {
  it.each([1.25, 1.5, 1.75, 2.5])('paints every backing pixel exactly on every uncached frame at DPR%s', (dpr) => {
    const { output, vp, dimensions } = setup(dpr);
    try {
      for (let frame = 0; frame < 4; frame++) {
        vp.render(overlay());
        expectPixels(output);
        expect(output.paints.filter((paint) => paint.kind === 'fill').at(-1)).toMatchObject({ matrix: identity, rect: [0, 0, dimensions.width, dimensions.height] });
        expect(output.matrix()).toEqual([dpr, 0, 0, dpr, 0, 0]);
      }
    } finally { vp.dispose(); }
  });

  it.each([1.25, 1.5, 1.75, 2.5])('copies a nonuniform cached bitmap 1:1 and restores geometry DPR%s', (dpr) => {
    const { output, vp, doc } = setup(dpr, 200), ov = overlay();
    try {
      vp.render(ov);
      const cache = output.children[0]!;
      expect(cache.paints.find((paint) => paint.kind === 'blit')).toMatchObject({ matrix: identity, source: output.element, argumentCount: 3 });
      for (let y = 0; y < cache.element.height; y++) for (let x = 0; x < cache.element.width; x++) cache.mark(x, y, [x * 11 % 256, y * 17 % 256, (x + y) * 7 % 256, 255]);
      const expected = cache.pixels().slice(), state = doc.snapshot;
      for (let frame = 0; frame < 3; frame++) {
        vp.render({ ...ov, preview: [geometry] });
        expect(output.pixels()).toEqual(expected);
        expect(output.paints.filter((paint) => paint.kind === 'blit').at(-1)).toMatchObject({ matrix: identity, source: cache.element, argumentCount: 3 });
        expect(output.paints.filter((paint) => paint.kind === 'geometry').at(-1)).toMatchObject({ matrix: [dpr, 0, 0, dpr, 0, 0], entity: geometry });
        expect(output.matrix()).toEqual([dpr, 0, 0, dpr, 0, 0]);
      }
      expect(drawEntity).toHaveBeenCalledTimes(203); expect(doc.snapshot).toBe(state);
    } finally { vp.dispose(); }
  });

  it('clears every physical overlay pixel on GPU success and restores the same full Canvas bitmap on fallback', () => {
    const { output, vp, doc } = setup(1.25, 200), ov = overlay();
    try {
      vp.render(ov); const state = doc.snapshot;
      let succeeds = true;
      vp.experimentalSceneRenderer = vi.fn(() => { expect(output.matrix()).toEqual([1.25, 0, 0, 1.25, 0, 0]); return succeeds; });
      vp.render(ov);
      expectPixels(output, [0, 0, 0, 0]);
      expect(output.paints.filter((paint) => paint.kind === 'clear').at(-1)).toMatchObject({ matrix: identity, rect: [0, 0, output.element.width, output.element.height] });
      succeeds = false; vp.render(ov);
      expectPixels(output); expect(drawEntity).toHaveBeenCalledTimes(200); expect(doc.snapshot).toBe(state);
      expect(output.matrix()).toEqual([1.25, 0, 0, 1.25, 0, 0]);
    } finally { vp.dispose(); }
  });

  it('invalidates a cached scene after backing-only changes and uses actual physical dimensions', () => {
    const { output, vp } = setup(1.25, 200), ov = overlay();
    try {
      vp.render(ov); vp.render(ov); expect(drawEntity).toHaveBeenCalledTimes(200);
      output.element.width += 1; output.element.height += 1;
      vp.render(ov);
      expect(drawEntity).toHaveBeenCalledTimes(400); expectPixels(output);
      expect(output.paints.filter((paint) => paint.kind === 'fill').at(-1)).toMatchObject({ matrix: identity, rect: [0, 0, output.element.width, output.element.height] });
      expect(output.children[0]!.element.width).toBe(output.element.width); expect(output.children[0]!.element.height).toBe(output.element.height);
      vp.render(ov); expect(drawEntity).toHaveBeenCalledTimes(400); expectPixels(output);
      expect(output.paints.filter((paint) => paint.kind === 'blit').at(-1)).toMatchObject({ matrix: identity, argumentCount: 3 });
    } finally { vp.dispose(); }
  });

  it.each(['underlay', 'layoutPainter'] as const)('restores DPR before %s and preview painting', (kind) => {
    const { output, vp } = setup(1.25, 2), order: string[] = [];
    try {
      vp[kind] = (context) => { order.push(kind); expect(output.matrix()).toEqual([1.25, 0, 0, 1.25, 0, 0]); context.fillRect(1, 1, 1, 1); };
      vi.mocked(drawEntity).mockImplementation((context, entity) => { order.push(entity.id); expect(surfaces.get(context)!.matrix()).toEqual([1.25, 0, 0, 1.25, 0, 0]); });
      vp.render({ ...overlay(), preview: [geometry] });
      expect(order).toEqual(kind === 'underlay' ? ['underlay', 'line-0', 'line-1', 'line'] : ['layoutPainter', 'line']);
      expect(output.paints[0]).toMatchObject({ kind: 'fill', matrix: identity });
    } finally { vp.dispose(); }
  });

  it('restores DPR even when a cached bitmap blit throws', () => {
    const { output, vp } = setup(1.25, 200);
    try {
      vp.render(overlay()); output.throwOnBlit = new Error('bitmap rejected');
      expect(() => vp.render(overlay())).toThrow('bitmap rejected');
      expect(output.matrix()).toEqual([1.25, 0, 0, 1.25, 0, 0]);
    } finally { vp.dispose(); }
  });
});
