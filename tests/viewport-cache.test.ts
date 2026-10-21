import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/render/draw', async (original) => ({ ...await original<typeof import('../src/render/draw')>(), drawEntity: vi.fn() }));
vi.mock('../src/core/spatial-index', async (original) => ({ ...await original<typeof import('../src/core/spatial-index')>(), warmSpatialIndex: vi.fn() }));
import { Viewport, type ViewportOverlay } from '../src/render/viewport';
import { drawEntity } from '../src/render/draw';
import { warmSpatialIndex } from '../src/core/spatial-index';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import * as entities from '../src/core/entities';
import { createTextGeometryContext, FontMetricsRegistry, fontMetrics } from '../src/render/font-metrics';
import { bigDrawing } from './helpers/big-drawing';

function canvas(): HTMLCanvasElement {
  const ctx = new Proxy({ measureText: () => ({ width: 20 }) } as Record<string, unknown>, {
    get(target, key: string) { return target[key] ?? (target[key] = vi.fn()); },
    set(target, key: string, value) { target[key] = value; return true; },
  });
  return { width: 400, height: 300, getContext: () => ctx, ownerDocument: { createElement: () => canvas() } } as unknown as HTMLCanvasElement;
}
const overlay = (): ViewportOverlay => ({ preview: [], ghost: [], selection: new Set(), hover: null, selectionBox: null, snap: null, cursor: null, trackFrom: null, dynText: [], cursorMode: 'idle' });
function setup(element = canvas()) {
  const doc = new Drawing(bigDrawing(250, 0, 0)), vp = new Viewport(element, doc);
  vp.width = 400; vp.height = 300; vp.scale = 1; vp.center = { x: 100, y: 75 }; vp.settings.gridVisible = false;
  return { doc, vp };
}

interface RestorableCanvas {
  element: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  fills: { color: string; rect: number[] }[];
  children: RestorableCanvas[];
  painted: () => boolean;
  lose: () => Event;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}
const paintedCanvases = new WeakMap<object, () => boolean>();

/** Track backing-store loss and default source-over compositing for cached scene copies. */
function restorableCanvas(): RestorableCanvas {
  const element = canvas(), context = element.getContext('2d')!, events = new EventTarget();
  let painted = false;
  let lost = false;
  const fills: RestorableCanvas['fills'] = [];
  const children: RestorableCanvas[] = [];
  const addEventListener = vi.fn(events.addEventListener.bind(events));
  const removeEventListener = vi.fn(events.removeEventListener.bind(events));
  Object.assign(element, {
    addEventListener, removeEventListener, dispatchEvent: (event: Event) => {
      if (event.type === 'contextrestored') lost = false;
      return events.dispatchEvent(event);
    },
    ownerDocument: { createElement: () => {
      const child = restorableCanvas(); children.push(child); return child.element;
    } },
  });
  vi.mocked(context.fillRect).mockImplementation((x, y, width, height) => {
    if (lost) return;
    painted = true; fills.push({ color: String(context.fillStyle), rect: [x, y, width, height] });
  });
  vi.mocked(context.clearRect).mockImplementation(() => { if (!lost) painted = false; });
  vi.mocked(context.drawImage).mockImplementation((source) => {
    if (!lost) painted = painted || (paintedCanvases.get(source)?.() ?? false);
  });
  vi.mocked(context.isContextLost).mockImplementation(() => lost);
  paintedCanvases.set(element, () => painted);
  return { element, context, fills, children, painted: () => painted, addEventListener, removeEventListener, lose: () => {
    lost = true; painted = false;
    for (const child of children) child.lose();
    const event = new Event('contextlost', { cancelable: true });
    element.dispatchEvent(event);
    return event;
  } };
}

function animationFrames() {
  let serial = 0;
  const pending = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => { pending.set(++serial, callback); return serial; });
  const cancel = vi.fn((id: number) => { pending.delete(id); });
  vi.stubGlobal('requestAnimationFrame', request); vi.stubGlobal('cancelAnimationFrame', cancel);
  return { request, cancel, pendingCount: () => pending.size, flush: () => {
    const callbacks = [...pending.values()]; pending.clear();
    for (const callback of callbacks) callback(0);
  } };
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('viewport static scene caching', () => {
  it('keeps metric epochs in the bitmap cache and fresh spatial warmup without changing drawing history', async () => {
    vi.useFakeTimers(); const frames = animationFrames(), registry = new FontMetricsRegistry();
    const context = createTextGeometryContext(Object.freeze({}), registry), doc = new Drawing(bigDrawing(250, 0, 0), () => context);
    const vp = new Viewport(canvas(), doc); vp.width = 400; vp.height = 300; vp.scale = 1; vp.center = { x: 100, y: 75 }; vp.settings.gridVisible = false;
    try {
      const state = doc.snapshot, history = doc.history(), dirty = doc.dirty;
      vp.render(overlay()); vp.render(overlay()); expect(drawEntity).toHaveBeenCalledTimes(250);
      vp.requestRender(overlay()); await vi.advanceTimersByTimeAsync(50); expect(warmSpatialIndex).toHaveBeenCalledOnce();
      registry.invalidateFallbacks(); vp.render(overlay()); expect(drawEntity).toHaveBeenCalledTimes(500);
      vp.requestRender(overlay()); await vi.advanceTimersByTimeAsync(50); expect(warmSpatialIndex).toHaveBeenCalledTimes(2);
      expect(doc.snapshot).toBe(state); expect(doc.history()).toEqual(history); expect(doc.dirty).toBe(dirty);
      vp.dispose(); expect(frames.pendingCount()).toBe(0);
    } finally { vp.dispose(); }
  });

  it('font notifications discard bitmap listeners and queue a repaint, then unsubscribe on disposal', () => {
    const frames = animationFrames(), surface = restorableCanvas(), { doc, vp } = setup(surface.element);
    try {
      const state = doc.snapshot, history = doc.history(), dirty = doc.dirty;
      vp.render(overlay()); const saved = surface.children[0]!;
      fontMetrics.invalidateFallbacks(); expect(saved.removeEventListener).toHaveBeenCalledWith('contextlost', expect.any(Function));
      expect(saved.removeEventListener).toHaveBeenCalledWith('contextrestored', expect.any(Function)); expect(frames.pendingCount()).toBe(1);
      frames.flush(); expect(drawEntity).toHaveBeenCalledTimes(500);
      expect(doc.snapshot).toBe(state); expect(doc.history()).toEqual(history); expect(doc.dirty).toBe(dirty);
      vp.dispose(); fontMetrics.invalidateFallbacks(); expect(frames.pendingCount()).toBe(0);
    } finally { vp.dispose(); }
  });

  it('keeps selected text grips on the actual drawing text context', () => {
    const registry = new FontMetricsRegistry(), context = createTextGeometryContext(Object.freeze({}), registry);
    const doc = new Drawing({ entities: [{ id: 'label', type: 'text', text: 'H', position: { x: 0, y: 0 }, height: 2, rotation: 0, align: 'left', layer: '0', color: 7 }] }, () => context);
    const vp = new Viewport(canvas(), doc), grips = vi.spyOn(entities, 'gripPoints');
    try {
      const ov = { ...overlay(), selection: new Set(['label']) }; vp.render(ov);
      // 30.4 slice B: the viewport also passes the block lookup so dynamic
      // parameter grips are drawn where the pointer can pick them; the
      // text context argument this test pins is unchanged.
      expect(grips).toHaveBeenCalledWith(doc.entities[0], context, doc.lookupBlock);
    } finally { grips.mockRestore(); vp.dispose(); }
  });

  it('reuses model geometry for cursor-only frames but invalidates on edits and undo', () => {
    const { doc, vp } = setup(), ov = overlay();
    vp.render(ov); const first = vi.mocked(drawEntity).mock.calls.length;
    expect(first).toBe(250);
    vp.render({ ...ov, cursor: { x: 10, y: 10 } });
    expect(drawEntity).toHaveBeenCalledTimes(first);
    doc.transact((s) => ({ ...s, entities: s.entities.slice(1) }));
    vp.render(ov); expect(drawEntity).toHaveBeenCalledTimes(first + 249);
    doc.undo(); vp.render(ov); expect(drawEntity).toHaveBeenCalledTimes(first + 249 + 250);
    vp.dispose();
  });
  it('invalidates on pan, selection and appearance changes', () => {
    const { doc, vp } = setup(), ov = overlay();
    vp.render(ov);
    vp.center = { x: 101, y: 75 }; vp.render(ov);
    vp.render({ ...ov, selection: new Set([doc.entities[0]!.id]) });
    vp.settings.background = '#ffffff'; vp.render(ov);
    expect(drawEntity).toHaveBeenCalledTimes(1000);
    vp.dispose();
  });
  it('invalidates cached geometry when only the view rotation changes', () => {
    const { vp } = setup(), ov = overlay();
    vp.render(ov); const first = vi.mocked(drawEntity).mock.calls.length;
    vp.twist = Math.PI / 8; vp.render(ov); const rotated = vi.mocked(drawEntity).mock.calls.length;
    expect(rotated).toBeGreaterThan(first);
    vp.render(ov); expect(drawEntity).toHaveBeenCalledTimes(rotated);
    expect(vi.mocked(drawEntity).mock.calls[rotated - 1]![2].rotation).toBe(vp.twist);
    vp.dispose();
  });
  it('continues repainting custom underlays and documents containing asynchronous images', () => {
    const { doc, vp } = setup(), ov = overlay();
    vp.underlay = vi.fn(); vp.render(ov); vp.render(ov);
    expect(vp.underlay).toHaveBeenCalledTimes(2);
    vp.underlay = null;
    const image: Entity = { id: 'image', type: 'image', layer: '0', color: 'ByLayer', path: 'example.png', position: { x: 0, y: 0 }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, size: { x: 1, y: 1 } };
    doc.transact((s) => ({ ...s, blocks: { ...s.blocks, IMAGE_BLOCK: { name: 'IMAGE_BLOCK', basePoint: { x: 0, y: 0 }, entities: [image], attributes: [] } } }));
    vp.render(ov); vp.render(ov);
    expect(drawEntity).toHaveBeenCalledTimes(1000);
    vp.dispose();
  });
  it('warms the current spatial index once and cancels pending work on disposal', async () => {
    vi.useFakeTimers(); vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const { doc, vp } = setup();
    vp.requestRender(overlay()); await vi.advanceTimersByTimeAsync(50);
    expect(warmSpatialIndex).toHaveBeenCalledWith(doc.entities, doc.lookupBlock);
    vp.requestRender(overlay()); await vi.advanceTimersByTimeAsync(50);
    expect(warmSpatialIndex).toHaveBeenCalledOnce();
    doc.transact((s) => ({ ...s, entities: [...s.entities] }));
    vp.requestRender(overlay()); vp.dispose(); await vi.advanceTimersByTimeAsync(50);
    expect(warmSpatialIndex).toHaveBeenCalledOnce();
  });
});

describe('Canvas context restoration', () => {
  it('repaints a restored scene cache while the main Canvas context stays healthy', () => {
    vi.useFakeTimers(); const frames = animationFrames(), surface = restorableCanvas();
    const { doc, vp } = setup(surface.element), ov = overlay();
    const mainEvents = vi.fn();
    surface.element.addEventListener('contextlost', mainEvents); surface.element.addEventListener('contextrestored', mainEvents);
    try {
      vp.render(ov); vp.render(ov);
      expect(drawEntity).toHaveBeenCalledTimes(250);
      const cache = surface.children[0]!;
      expect(cache.painted()).toBe(true);
      const state = doc.snapshot;
      expect(cache.lose().defaultPrevented).toBe(false);
      expect(surface.context.isContextLost()).toBe(false); expect(surface.painted()).toBe(true);
      cache.element.dispatchEvent(new Event('contextrestored'));
      frames.flush();
      expect(mainEvents).not.toHaveBeenCalled(); expect(doc.snapshot).toBe(state);
      expect(vi.mocked(drawEntity).mock.calls.length).toBeGreaterThan(250);
      expect(surface.painted()).toBe(true);
    } finally { vp.dispose(); }
  });

  it('repaints Canvas fallback after only its saved bitmap was lost during a GPU frame', () => {
    vi.useFakeTimers(); const frames = animationFrames(), surface = restorableCanvas();
    const { doc, vp } = setup(surface.element), ov = overlay();
    const mainEvents = vi.fn();
    surface.element.addEventListener('contextlost', mainEvents); surface.element.addEventListener('contextrestored', mainEvents);
    try {
      vp.render(ov);
      const cache = surface.children[0]!, state = doc.snapshot;
      expect(cache.painted()).toBe(true); expect(drawEntity).toHaveBeenCalledTimes(250);
      // A successful sibling GPU frame normally clears the still-healthy main Canvas base.
      vp.experimentalSceneRenderer = () => true; vp.render(ov);
      expect(surface.painted()).toBe(false); expect(surface.context.isContextLost()).toBe(false);
      expect(cache.lose().defaultPrevented).toBe(false);
      cache.element.dispatchEvent(new Event('contextrestored'));
      vi.mocked(surface.context.fillRect).mockClear();
      // Same document/view/style key, but the sibling GPU now requires complete Canvas fallback.
      vp.experimentalSceneRenderer = () => false; vp.render(ov); frames.flush();
      expect(mainEvents).not.toHaveBeenCalled(); expect(surface.context.isContextLost()).toBe(false);
      expect(doc.snapshot).toBe(state);
      expect(surface.context.fillRect).toHaveBeenCalledWith(0, 0, vp.width, vp.height);
      expect(vi.mocked(drawEntity).mock.calls.length).toBeGreaterThan(250);
      expect(surface.painted()).toBe(true);
    } finally { vp.dispose(); }
  });

  it('discards a lost scene bitmap and repaints without an edit or mouse movement', () => {
    vi.useFakeTimers(); const frames = animationFrames(), surface = restorableCanvas();
    const { doc, vp } = setup(surface.element), ov = overlay();
    vp.render(ov); vp.render(ov);
    expect(drawEntity).toHaveBeenCalledTimes(250);
    expect(surface.painted()).toBe(true);
    const state = doc.snapshot;
    const render = vi.spyOn(vp, 'render');
    for (let cycle = 0; cycle < 2; cycle++) {
      const lost = surface.lose();
      expect(lost.defaultPrevented).toBe(false);
      expect(surface.painted()).toBe(false);
      vi.mocked(drawEntity).mockClear(); vi.mocked(surface.context.fillRect).mockClear(); vi.mocked(surface.context.drawImage).mockClear();
      render.mockClear();
      surface.element.dispatchEvent(new Event('contextrestored'));
      expect(frames.pendingCount()).toBe(1);
      frames.flush();
      expect(render).toHaveBeenCalledExactlyOnceWith(ov);
      expect(surface.context.fillRect).toHaveBeenCalledWith(0, 0, vp.width, vp.height);
      expect(drawEntity).toHaveBeenCalledTimes(250);
      expect(surface.context.drawImage).not.toHaveBeenCalled();
      expect(surface.painted()).toBe(true);
      expect(doc.snapshot).toBe(state);
      vp.render(ov); expect(drawEntity).toHaveBeenCalledTimes(250);
    }
    vp.dispose();
  });

  it('recovers with the latest document, view, settings and requested overlay', () => {
    vi.useFakeTimers(); const frames = animationFrames(), surface = restorableCanvas();
    const { doc, vp } = setup(surface.element);
    vp.render(overlay()); surface.lose();
    const preview: Entity = { id: 'preview', type: 'line', layer: '0', color: 1, a: { x: 10, y: 20 }, b: { x: 11, y: 20 } };
    const latest = { ...overlay(), preview: [preview], selection: new Set(['current-0']), hover: 'current-1' };
    vp.requestRender(latest);
    doc.transact((state) => ({ ...state, entities: Array.from({ length: 250 }, (_, i): Entity => ({
      id: `current-${i}`, type: 'line', layer: '0', color: 'ByLayer', a: { x: 10 + i / 10, y: 20 }, b: { x: 11 + i / 10, y: 20 },
    })) }));
    vp.width = 480; vp.height = 320; vp.dpr = 2; vp.center = { x: 24, y: 20 }; vp.scale = 3; vp.twist = 0.5;
    surface.element.width = 960; surface.element.height = 640;
    vp.settings.background = '#123456'; vp.settings.selectionEffect = 'solid';
    const state = doc.snapshot, render = vi.spyOn(vp, 'render');
    vi.mocked(drawEntity).mockClear(); vi.mocked(surface.context.fillRect).mockClear();
    surface.fills.length = 0;
    surface.element.dispatchEvent(new Event('contextrestored'));
    expect(frames.pendingCount()).toBe(1);
    frames.flush();
    expect(render).toHaveBeenCalledExactlyOnceWith(latest);
    expect(surface.context.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
    expect(surface.context.fillRect).toHaveBeenCalledWith(0, 0, 960, 640);
    expect(surface.fills[0]).toEqual({ color: '#123456', rect: [0, 0, 960, 640] });
    expect(drawEntity).toHaveBeenCalledTimes(251);
    expect(vi.mocked(drawEntity).mock.calls[0]![1]).toBe(doc.entities[0]);
    expect(vi.mocked(drawEntity).mock.calls[0]![2]).toMatchObject({ scale: 3, rotation: 0.5 });
    expect(vi.mocked(drawEntity).mock.calls[0]![2].toScreen({ x: 24, y: 20 })).toEqual({ x: 240, y: 160 });
    expect(vi.mocked(drawEntity).mock.calls[0]![5]).toMatchObject({ lineWidthOverride: 2.5, alpha: 0.95 });
    expect(vi.mocked(drawEntity).mock.calls[1]![5]).toMatchObject({ lineWidthOverride: 2, alpha: 0.95 });
    expect(vi.mocked(drawEntity).mock.lastCall![1]).toBe(preview);
    expect(surface.painted()).toBe(true); expect(doc.snapshot).toBe(state);
    vp.dispose();
  });

  it('does not schedule recovery before any overlay exists and removes its listener on disposal', () => {
    vi.useFakeTimers(); const frames = animationFrames(), surface = restorableCanvas();
    const { vp } = setup(surface.element);
    surface.element.dispatchEvent(new Event('contextrestored'));
    expect(frames.request).not.toHaveBeenCalled();
    expect(surface.addEventListener).toHaveBeenCalledOnce();
    const listener = surface.addEventListener.mock.calls[0]![1] as EventListener;
    vp.render(overlay()); surface.lose();
    surface.element.dispatchEvent(new Event('contextrestored'));
    expect(frames.pendingCount()).toBe(1);
    const requestsBeforeDispose = frames.request.mock.calls.length;
    vp.dispose();
    expect(surface.removeEventListener).toHaveBeenCalledWith('contextrestored', listener);
    expect(frames.pendingCount()).toBe(0);
    vi.mocked(drawEntity).mockClear(); vi.mocked(surface.context.fillRect).mockClear();
    surface.element.dispatchEvent(new Event('contextrestored'));
    listener(new Event('contextrestored')); // A stale event-dispatch callback is also inert.
    frames.flush();
    expect(frames.request).toHaveBeenCalledTimes(requestsBeforeDispose);
    expect(drawEntity).not.toHaveBeenCalled(); expect(surface.context.fillRect).not.toHaveBeenCalled();
    expect(surface.painted()).toBe(false);
  });

  it('keeps a replacement cache intact when a retired canvas dispatches or invokes stale callbacks', () => {
    vi.useFakeTimers(); const frames = animationFrames(), surface = restorableCanvas();
    const { doc, vp } = setup(surface.element), ov = overlay();
    try {
      vp.render(ov);
      const retired = surface.children[0]!;
      const staleListener = retired.addEventListener.mock.calls.find(([type]) => type === 'contextlost')![1] as EventListener;
      expect(retired.addEventListener).toHaveBeenCalledWith('contextrestored', staleListener);
      vp.center = { ...vp.center, x: vp.center.x + 1 }; vp.render(ov);
      expect(surface.children).toHaveLength(1); expect(retired.addEventListener).toHaveBeenCalledTimes(2);
      // Main restoration retires this bitmap and creates a new one on its queued frame.
      surface.element.dispatchEvent(new Event('contextrestored')); frames.flush();
      const replacement = surface.children[1]!, state = doc.snapshot;
      expect(replacement).not.toBe(retired); expect(replacement.painted()).toBe(true);
      expect(retired.removeEventListener).toHaveBeenCalledWith('contextlost', staleListener);
      expect(retired.removeEventListener).toHaveBeenCalledWith('contextrestored', staleListener);
      expect(retired.element.width).toBe(1); expect(retired.element.height).toBe(1);
      const requests = frames.request.mock.calls.length;
      vi.mocked(drawEntity).mockClear();
      retired.lose(); retired.element.dispatchEvent(new Event('contextrestored'));
      staleListener(new Event('contextlost')); staleListener(new Event('contextrestored'));
      expect(frames.pendingCount()).toBe(0); expect(frames.request).toHaveBeenCalledTimes(requests);
      vp.render(ov); frames.flush();
      expect(drawEntity).not.toHaveBeenCalled(); expect(surface.children).toHaveLength(2);
      expect(replacement.painted()).toBe(true); expect(doc.snapshot).toBe(state);
    } finally { vp.dispose(); }
  });

  it('detaches cache listeners and cancels recovery when the viewport is disposed', () => {
    vi.useFakeTimers(); const frames = animationFrames(), surface = restorableCanvas();
    const { doc, vp } = setup(surface.element), ov = overlay();
    vp.render(ov);
    const cache = surface.children[0]!, state = doc.snapshot;
    const listener = cache.addEventListener.mock.calls.find(([type]) => type === 'contextlost')![1] as EventListener;
    vp.requestRender(ov); expect(frames.pendingCount()).toBe(1);
    const requests = frames.request.mock.calls.length;
    vp.dispose();
    expect(cache.removeEventListener).toHaveBeenCalledWith('contextlost', listener);
    expect(cache.removeEventListener).toHaveBeenCalledWith('contextrestored', listener);
    expect(cache.element.width).toBe(1); expect(cache.element.height).toBe(1);
    expect(frames.pendingCount()).toBe(0);
    vi.mocked(drawEntity).mockClear(); vi.mocked(surface.context.fillRect).mockClear();
    cache.lose(); cache.element.dispatchEvent(new Event('contextrestored'));
    listener(new Event('contextlost')); listener(new Event('contextrestored'));
    frames.flush();
    expect(frames.request).toHaveBeenCalledTimes(requests);
    expect(drawEntity).not.toHaveBeenCalled(); expect(surface.context.fillRect).not.toHaveBeenCalled();
    expect(doc.snapshot).toBe(state);
  });

  it('retires a cache whose copy fails without preventing main-view painting', () => {
    vi.useFakeTimers(); const frames = animationFrames(), surface = restorableCanvas();
    const { doc, vp } = setup(surface.element), ov = overlay();
    try {
      vp.render(ov);
      const failed = surface.children[0]!;
      const staleListener = failed.addEventListener.mock.calls.find(([type]) => type === 'contextlost')![1] as EventListener;
      failed.context.drawImage = vi.fn(() => { throw new Error('Bitmap copy failed'); });
      vp.center = { ...vp.center, x: vp.center.x + 1 };
      expect(() => vp.render(ov)).not.toThrow();
      expect(surface.painted()).toBe(true); expect(drawEntity).toHaveBeenCalledTimes(500);
      expect(failed.removeEventListener).toHaveBeenCalledWith('contextlost', staleListener);
      expect(failed.removeEventListener).toHaveBeenCalledWith('contextrestored', staleListener);
      staleListener(new Event('contextrestored')); expect(frames.pendingCount()).toBe(0);
      vp.render(ov); expect(drawEntity).toHaveBeenCalledTimes(750);
      expect(surface.children).toHaveLength(2); expect(surface.children[1]!.painted()).toBe(true);
      const state = doc.snapshot;
      vp.render(ov); expect(drawEntity).toHaveBeenCalledTimes(750); expect(doc.snapshot).toBe(state);
    } finally { vp.dispose(); }
  });

  it('does not retain a newly created cache whose context is already lost', () => {
    vi.useFakeTimers(); const frames = animationFrames(), surface = restorableCanvas();
    const { doc, vp } = setup(surface.element), ov = overlay();
    Object.assign(surface.element, { ownerDocument: { createElement: () => {
      const cache = restorableCanvas(); cache.lose(); surface.children.push(cache); return cache.element;
    } } });
    try {
      const state = doc.snapshot;
      expect(() => vp.render(ov)).not.toThrow(); expect(surface.painted()).toBe(true);
      expect(() => vp.render(ov)).not.toThrow(); expect(drawEntity).toHaveBeenCalledTimes(500);
      for (const cache of surface.children) {
        expect(cache.context.drawImage).not.toHaveBeenCalled(); expect(cache.addEventListener).not.toHaveBeenCalled();
      }
      expect(frames.pendingCount()).toBe(0); expect(doc.snapshot).toBe(state);
    } finally { vp.dispose(); }
  });
});
