import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '../src/app/editor';
import type { EditorEvent } from '../src/app/editor/types';
import type { Viewport, ViewportOverlay } from '../src/render/viewport';
import { Drawing } from '../src/core/document';
import { installGpuPrototype } from '../src/app/gpu-prototype';
import { emptyGpuDiagnostics, gpuDiagnosticsLines, setDiagnosticRenderer } from '../src/app/gpu-diagnostics';

const gpu = vi.hoisted(() => ({ render: vi.fn((..._args: unknown[]) => ({ rendered: true })), created: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/render/gpu-prototype/renderer2d', () => ({
  emptyGpu2DRenderResult: (reason: string) => ({ rendered: false, reason }),
  Gpu2DRenderer: class {
    device = { state: 'ready', capabilities: () => null };
    constructor() { gpu.created(); }
    render = gpu.render;
    dispose = gpu.dispose;
    clearRefusalCache() {}
  },
}));

function fixture() {
  const elements: Array<{ style: Record<string, string>; dataset: Record<string, string>; remove: () => void }> = [];
  vi.stubGlobal('document', { createElement: () => {
    const element = { style: {}, dataset: {}, addEventListener: vi.fn(), remove: vi.fn(), textContent: '', title: '' };
    elements.push(element);
    return element;
  } });
  const globals: Record<string, unknown> = {};
  vi.stubGlobal('window', globals);
  const events = new Map<EditorEvent, Set<() => void>>();
  const overlay: ViewportOverlay = { selection: new Set<string>(), hover: null, preview: [], ghost: [],
    selectionBox: null, snap: null, cursor: null, trackFrom: null, dynText: [], cursorMode: 'idle' };
  const view = {
    canvas: { before: vi.fn(), parentElement: { append: vi.fn() } },
    width: 800, height: 600, dpr: 1, scale: 10, center: { x: 0, y: 0 }, twist: 0,
    settings: { gridVisible: false, background: '#000000', selectionEffect: 'solid' },
    experimentalSceneRenderer: null,
  } as unknown as Viewport;
  const doc = new Drawing();
  const editor = {
    viewport: view, doc, register: vi.fn(), render: vi.fn(),
    on: (event: EditorEvent, fn: () => void) => {
      const listeners = events.get(event) ?? new Set();
      listeners.add(fn); events.set(event, listeners);
      return () => listeners.delete(fn);
    },
  } as unknown as Editor;
  const api = () => globals.gpuPrototype as { setMode(mode: 'canvas' | 'gpu'): void; dispose(): void; status(): { rendered: boolean; reason?: string } };
  return { editor, view, doc, elements, api, render: () => view.experimentalSceneRenderer!(view, overlay),
    emit: (event: EditorEvent) => { for (const fn of events.get(event) ?? []) fn(); } };
}

const rendererLine = () => gpuDiagnosticsLines(emptyGpuDiagnostics()).find((line) => line.startsWith('JCad renderer:'));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); setDiagnosticRenderer(() => 'Canvas 2D'); });

describe('experimental GPU integration with the modelling viewport', () => {
  it('keeps Canvas as default and passes the actual per-drawing lookup to GPU admission', () => {
    setDiagnosticRenderer(() => 'WebGL2 experimental 3D modelling viewport');
    const f = fixture(); installGpuPrototype(f.editor);
    expect(f.render()).toBe(false); expect(gpu.created).not.toHaveBeenCalled();
    expect(rendererLine()).toBe('JCad renderer: Canvas 2D');
    f.api().setMode('gpu'); expect(f.render()).toBe(true);
    expect(rendererLine()).toBe('JCad renderer: WebGL2 drawing base scene + Canvas 2D editing overlays (experimental)');
    expect(gpu.render.mock.calls[0]?.[3]).toBe(f.doc.lookupBlock);
    f.api().dispose();
  });

  it('hides an already visible GPU backing immediately on 3D activation and resumes on exit', () => {
    const f = fixture(); let active = false; installGpuPrototype(f.editor, () => active);
    f.api().setMode('gpu'); expect(f.render()).toBe(true);
    expect(f.elements[0]!.style.display).toBe('block');
    const submitted = gpu.render.mock.calls.length;
    active = true; f.emit('log');
    expect(rendererLine()).toBe('JCad renderer: WebGL2 experimental 3D modelling viewport');
    expect(f.elements[0]!.style.display).toBe('none');
    expect(f.elements[1]!.style.visibility).toBe('hidden');
    expect(f.api().status()).toMatchObject({ rendered: false, reason: 'Experimental 3D viewport active' });
    expect(f.render()).toBe(false); expect(gpu.render).toHaveBeenCalledTimes(submitted);
    active = false; f.emit('view');
    expect(rendererLine()).toBe('JCad renderer: Canvas 2D');
    expect(f.elements[1]!.style.visibility).toBe(''); expect(f.render()).toBe(true);
    expect(rendererLine()).toBe('JCad renderer: WebGL2 drawing base scene + Canvas 2D editing overlays (experimental)');
    f.api().dispose();
  });

  it('reports Canvas when a requested GPU scene is refused and when GPU mode is disabled', () => {
    const f = fixture(); installGpuPrototype(f.editor);
    f.api().setMode('gpu');
    gpu.render.mockReturnValueOnce({ rendered: false });
    expect(f.render()).toBe(false);
    expect(rendererLine()).toBe('JCad renderer: Canvas 2D');
    expect(f.render()).toBe(true);
    expect(rendererLine()).toContain('WebGL2 drawing base scene');
    f.api().setMode('canvas'); expect(f.render()).toBe(false);
    expect(rendererLine()).toBe('JCad renderer: Canvas 2D');
    f.api().dispose();
  });

  it('does not create a GPU context while 3D is active and removes mode listeners on disposal', () => {
    const f = fixture(); let active = true; installGpuPrototype(f.editor, () => active);
    f.api().setMode('gpu'); expect(f.render()).toBe(false);
    expect(gpu.created).not.toHaveBeenCalled(); expect(gpu.render).not.toHaveBeenCalled();
    f.api().dispose(); const renders = vi.mocked(f.editor.render).mock.calls.length;
    active = false; f.emit('view'); f.emit('log');
    expect(f.editor.render).toHaveBeenCalledTimes(renders);
    expect(f.view.experimentalSceneRenderer).toBeNull();
  });
});
