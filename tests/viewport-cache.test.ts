import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/render/draw', async (original) => ({ ...await original<typeof import('../src/render/draw')>(), drawEntity: vi.fn() }));
vi.mock('../src/core/spatial-index', async (original) => ({ ...await original<typeof import('../src/core/spatial-index')>(), warmSpatialIndex: vi.fn() }));
import { Viewport, type ViewportOverlay } from '../src/render/viewport';
import { drawEntity } from '../src/render/draw';
import { warmSpatialIndex } from '../src/core/spatial-index';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
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
  painted: () => boolean;
  lose: () => Event;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}
const paintedCanvases = new WeakMap<object, () => boolean>();

/** A lost cache bitmap copies transparency until geometry is repainted. */
function restorableCanvas(): RestorableCanvas {
  const element = canvas(), context = element.getContext('2d')!, events = new EventTarget();
  let painted = false;
  const fills: RestorableCanvas['fills'] = [];
  const children: RestorableCanvas[] = [];
  const addEventListener = vi.fn(events.addEventListener.bind(events));
  const removeEventListener = vi.fn(events.removeEventListener.bind(events));
  Object.assign(element, {
    addEventListener, removeEventListener, dispatchEvent: events.dispatchEvent.bind(events),
    ownerDocument: { createElement: () => {
      const child = restorableCanvas(); children.push(child); return child.element;
    } },
  });
  vi.mocked(context.fillRect).mockImplementation((x, y, width, height) => {
    painted = true; fills.push({ color: String(context.fillStyle), rect: [x, y, width, height] });
  });
  vi.mocked(context.clearRect).mockImplementation(() => { painted = false; });
  vi.mocked(context.drawImage).mockImplementation((source) => { painted = paintedCanvases.get(source)?.() ?? false; });
  paintedCanvases.set(element, () => painted);
  return { element, context, fills, painted: () => painted, addEventListener, removeEventListener, lose: () => {
    painted = false;
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
  return { request, cancel, flush: () => {
    const callbacks = [...pending.values()]; pending.clear();
    for (const callback of callbacks) callback(0);
  } };
}
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('viewport static scene caching', () => {
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
  it('discards a lost scene bitmap and repaints without an edit or mouse movement', () => {
    vi.useFakeTimers(); const frames = animationFrames(), surface = restorableCanvas();
    const { doc, vp } = setup(surface.element), ov = overlay();
    vp.render(ov); vp.render(ov);
    expect(drawEntity).toHaveBeenCalledTimes(250);
    expect(surface.painted()).toBe(true);
    const state = doc.snapshot;
    for (let cycle = 0; cycle < 2; cycle++) {
      const lost = surface.lose();
      expect(lost.defaultPrevented).toBe(false);
      expect(surface.painted()).toBe(false);
      vi.mocked(drawEntity).mockClear(); vi.mocked(surface.context.fillRect).mockClear(); vi.mocked(surface.context.drawImage).mockClear();
      surface.element.dispatchEvent(new Event('contextrestored'));
      expect(frames.request).toHaveBeenCalledTimes(cycle + 1);
      frames.flush();
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
    vp.settings.background = '#123456'; vp.settings.selectionEffect = 'solid';
    const state = doc.snapshot, render = vi.spyOn(vp, 'render');
    vi.mocked(drawEntity).mockClear(); vi.mocked(surface.context.fillRect).mockClear();
    surface.fills.length = 0;
    surface.element.dispatchEvent(new Event('contextrestored'));
    expect(frames.cancel).toHaveBeenCalledOnce();
    frames.flush();
    expect(render).toHaveBeenCalledExactlyOnceWith(latest);
    expect(surface.context.setTransform).toHaveBeenLastCalledWith(2, 0, 0, 2, 0, 0);
    expect(surface.context.fillRect).toHaveBeenCalledWith(0, 0, 480, 320);
    expect(surface.fills[0]).toEqual({ color: '#123456', rect: [0, 0, 480, 320] });
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
    expect(frames.request).toHaveBeenCalledOnce();
    vp.dispose();
    expect(surface.removeEventListener).toHaveBeenCalledWith('contextrestored', listener);
    expect(frames.cancel).toHaveBeenCalledOnce();
    vi.mocked(drawEntity).mockClear(); vi.mocked(surface.context.fillRect).mockClear();
    surface.element.dispatchEvent(new Event('contextrestored'));
    listener(new Event('contextrestored')); // A stale event-dispatch callback is also inert.
    frames.flush();
    expect(frames.request).toHaveBeenCalledOnce();
    expect(drawEntity).not.toHaveBeenCalled(); expect(surface.context.fillRect).not.toHaveBeenCalled();
    expect(surface.painted()).toBe(false);
  });
});
