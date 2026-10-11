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
function setup() {
  const doc = new Drawing(bigDrawing(250, 0, 0)), vp = new Viewport(canvas(), doc);
  vp.width = 400; vp.height = 300; vp.scale = 1; vp.center = { x: 100, y: 75 }; vp.settings.gridVisible = false;
  return { doc, vp };
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
  it('continues repainting custom underlays and documents containing asynchronous images', () => {
    const { doc, vp } = setup(), ov = overlay();
    vp.underlay = vi.fn(); vp.render(ov); vp.render(ov);
    expect(vp.underlay).toHaveBeenCalledTimes(2);
    vp.underlay = null;
    doc.transact((s) => ({ ...s, blocks: { ...s.blocks, IMAGE_BLOCK: { name: 'IMAGE_BLOCK', basePoint: { x: 0, y: 0 }, entities: [{ type: 'image' } as Entity], attributes: [] } } }));
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
