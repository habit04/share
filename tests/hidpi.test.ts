import { describe, it, expect, afterEach, vi } from 'vitest';
import { crisp, hairline, backingSize, Viewport, type ViewportOverlay } from '../src/render/viewport';
import { Drawing } from '../src/core/document';

describe('crisp lines', () => {
  it('puts odd-width lines on device pixel centres and even-width lines on boundaries', () => {
    expect(crisp(10.7, 1)).toBe(10.5);
    expect(crisp(10, 1)).toBe(10.5);
    expect(crisp(10.7, 2)).toBe(10.5); // 1 CSS px = 2 device px: centre on a device boundary
    expect(crisp(10.2, 2)).toBe(10);
    // dpr 1.5, hairline = 2 device px (1.333 CSS px): the centre lands on a device boundary.
    const w = hairline(1.5);
    expect(w * 1.5).toBe(2);
    expect((crisp(10.3, 1.5, w) * 1.5) % 1).toBe(0);
    // dpr 1.25: hairline = 1 device px, centre at .5 device px
    expect((crisp(10.3, 1.25, hairline(1.25)) * 1.25) % 1).toBeCloseTo(0.5);
  });

  it('keeps 1 CSS px lines 1 CSS px wide at dpr 1 and 2', () => {
    expect(hairline(1)).toBe(1);
    expect(hairline(2)).toBe(1);
    expect(hairline(3)).toBe(1);
    expect(backingSize(801, 600, 2)).toEqual({ width: 1602, height: 1200 });
    expect(backingSize(801, 600, 1.25)).toEqual({ width: 1001, height: 750 });
    expect(backingSize(0, 0, 2)).toEqual({ width: 1, height: 1 });
  });
});

describe('devicePixelRatio changes', () => {
  const g = globalThis as unknown as Record<string, unknown>;
  afterEach(() => {
    delete g.window;
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
    vi.restoreAllMocks();
  });

  it('resizes the backing store when the window moves to a monitor with another scale', () => {
    const listeners = new Map<string, () => void>();
    const queries: string[] = [];
    const win = {
      devicePixelRatio: 1,
      matchMedia: (q: string) => {
        queries.push(q);
        return {
          media: q,
          addEventListener: (_t: string, fn: () => void) => listeners.set(q, fn),
          removeEventListener: (_t: string, fn: () => void) => {
            if (listeners.get(q) === fn) listeners.delete(q);
          },
        };
      },
    };
    g.window = win;
    const frames: Array<() => void> = [];
    g.requestAnimationFrame = (fn: () => void) => frames.push(fn);
    g.cancelAnimationFrame = () => {};
    const transforms: number[][] = [];
    const ctx = new Proxy(
      { setTransform: (...a: number[]) => void transforms.push(a), measureText: () => ({ width: 10 }) } as Record<string, unknown>,
      { get: (t, k) => (k in t ? t[k as string] : typeof k === 'string' && /^[a-z]/.test(k) ? () => {} : undefined), set: () => true },
    );
    const canvas = { width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width: 800, height: 600 }) } as unknown as HTMLCanvasElement;
    const vp = new Viewport(canvas, new Drawing());
    vp.resize();
    expect([canvas.width, canvas.height]).toEqual([800, 600]);
    expect(queries).toEqual(['(resolution: 1dppx)']);
    const overlay: ViewportOverlay = { preview: [], ghost: [], selection: new Set(), hover: null, selectionBox: null, snap: null, cursor: { x: 1, y: 1 }, trackFrom: null, dynText: [], cursorMode: 'idle' };
    vp.requestRender(overlay);
    frames.shift()!();
    expect(transforms.at(-1)).toEqual([1, 0, 0, 1, 0, 0]);
    let changed = 0;
    vp.onDprChange = () => void (changed += 1);
    // The window is dragged to a 200 % monitor: CSS size unchanged, the media query fires.
    win.devicePixelRatio = 2;
    listeners.get('(resolution: 1dppx)')!();
    expect(changed).toBe(1);
    expect(vp.dpr).toBe(2);
    expect([canvas.width, canvas.height]).toEqual([1600, 1200]);
    expect(vp.width).toBe(800); // CSS pixels: tools, pickbox and grips keep their size
    expect(queries.at(-1)).toBe('(resolution: 2dppx)');
    expect(listeners.has('(resolution: 1dppx)')).toBe(false);
    frames.shift()!(); // the change re-renders with the last overlay
    expect(transforms.at(-1)).toEqual([2, 0, 0, 2, 0, 0]);
    vp.dispose();
    expect(listeners.size).toBe(0);
  });
});
