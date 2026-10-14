import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from '../src/app/editor';
import type { EditorEvent } from '../src/app/editor/types';
import type { Viewport, ViewportOverlay } from '../src/render/viewport';
import { Drawing } from '../src/core/document';
import { createGpu2dController, installGpu2dCandidateSelector } from '../src/app/gpu-2d-candidate';
import { emptyGpuDiagnostics, gpuDiagnosticsLines, setDiagnosticRenderer } from '../src/app/gpu-diagnostics';

// Mock-only app/controller boundaries; renderer precision and native output have their own gates.
const gpu = vi.hoisted(() => ({ render: vi.fn((..._args: unknown[]) => ({ rendered: true })), created: vi.fn(), dispose: vi.fn(), clear: vi.fn(),
  device: { state: 'ready', capabilities: () => null }, changed: (() => {}) as () => void }));
vi.mock('../src/render/gpu-prototype/renderer2d', () => ({
  emptyGpu2DRenderResult: (reason: string) => ({ rendered: false, reason }),
  Gpu2DRenderer: class {
    device = gpu.device;
    constructor(_canvas: HTMLCanvasElement, changed: () => void) { gpu.created(); gpu.changed = changed; }
    render = gpu.render; dispose = gpu.dispose; clearRefusalCache = gpu.clear;
  },
}));

function fixture() {
  const elements: Array<{ style: Record<string, string>; dataset: Record<string, string>; remove: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('document', { createElement: () => {
    const element = { style: {}, dataset: {}, remove: vi.fn() }; elements.push(element); return element;
  } });
  const pageEvents = new Map<string, () => void>();
  const globals = { addEventListener: vi.fn((name: string, fn: () => void) => pageEvents.set(name, fn)),
    removeEventListener: vi.fn((name: string, fn: () => void) => { if (pageEvents.get(name) === fn) pageEvents.delete(name); }) };
  vi.stubGlobal('window', globals);
  const events = new Map<EditorEvent, Set<() => void>>();
  const overlay: ViewportOverlay = { selection: new Set<string>(), hover: null, preview: [], ghost: [], selectionBox: null,
    snap: null, cursor: null, trackFrom: null, dynText: [], cursorMode: 'idle' };
  const doc = new Drawing();
  doc.addEntities([{ id: 'retained-line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 5 } }]);
  doc.transact(state => ({ ...state, meta: { ...state.meta, 'retained-test-literal': { unicode: 'Δ 雷', payload: 'F0A' } } }));
  const view = { canvas: { before: vi.fn() }, width: 800, height: 600, dpr: 1.25, scale: 10, center: { x: 0, y: 0 }, twist: 0,
    settings: { gridVisible: false, background: '#212830', selectionEffect: 'solid' }, experimentalSceneRenderer: null,
  } as unknown as Viewport;
  const commands = new Map<string, Parameters<Editor['register']>[0]>();
  const editor = { viewport: view, doc, register: (command: Parameters<Editor['register']>[0]) => commands.set(command.name, command),
    log: vi.fn(), render: vi.fn(), on: (event: EditorEvent, fn: () => void) => {
      const listeners = events.get(event) ?? new Set(); listeners.add(fn); events.set(event, listeners); return () => listeners.delete(fn);
    },
  } as unknown as Editor;
  return { editor, view, doc, elements, globals, pageEvents, commands, overlay,
    select: (arg?: string) => commands.get('GPURENDERER')!.run!(editor, arg),
    paint: () => view.experimentalSceneRenderer?.(view, overlay) ?? false,
    emit: (event: EditorEvent) => { for (const fn of events.get(event) ?? []) fn(); } };
}
const rendererLine = () => gpuDiagnosticsLines(emptyGpuDiagnostics()).find(line => line.startsWith('JCad renderer:'));
const retained = (f: ReturnType<typeof fixture>) => ({ snapshot: f.doc.snapshot, revision: f.doc.revision,
  dirty: f.doc.dirty, filePath: f.doc.filePath, history: f.doc.history() });
const assertRetained = (f: ReturnType<typeof fixture>, before: ReturnType<typeof retained>) => {
  expect(f.doc.snapshot).toBe(before.snapshot); expect(f.doc.revision).toBe(before.revision); expect(f.doc.dirty).toBe(before.dirty);
  expect(f.doc.filePath).toBe(before.filePath); expect(f.doc.history()).toEqual(before.history);
};
beforeEach(() => { gpu.render.mockReset().mockReturnValue({ rendered: true }); gpu.device.state = 'ready'; });
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); setDiagnosticRenderer(() => 'Canvas 2D'); });

describe('explicit ordinary-build candidate 2D selector', () => {
  it('registers only explicit mode selection without allocating a backing/device, exposing a global, or persisting preferences', () => {
    const f = fixture(), before = retained(f), selector = installGpu2dCandidateSelector(f.editor);
    expect([...f.commands.keys()]).toEqual(['GPURENDERER']); expect(f.view.experimentalSceneRenderer).toBeNull();
    for (const arg of [undefined, '', 'auto', 'webgl', 'canvas']) f.select(arg);
    expect(f.elements).toHaveLength(0); expect(gpu.created).not.toHaveBeenCalled();
    expect(f.pageEvents.size).toBe(0); expect('gpuPrototype' in f.globals).toBe(false);
    expect(f.editor.log).toHaveBeenCalledWith('GPURENDERER GPU or GPURENDERER CANVAS (current: canvas).');
    assertRetained(f, before); selector.dispose();
  });

  it('lazily renders the same source/lookup after GPU selection and switches back to complete Canvas without changing the drawing', () => {
    const f = fixture(), before = retained(f), selector = installGpu2dCandidateSelector(f.editor);
    f.select(' GPU '); expect(gpu.created).not.toHaveBeenCalled(); expect(f.elements).toHaveLength(0);
    expect(f.paint()).toBe(true); expect(gpu.created).toHaveBeenCalledTimes(1);
    expect(f.elements[0]!.dataset).toEqual({ gpuCandidate: '2d' }); expect(f.elements[0]!.style.display).toBe('block');
    expect(gpu.render.mock.calls[0]?.[0]).toBe(before.snapshot); expect(gpu.render.mock.calls[0]?.[3]).toBe(f.doc.lookupBlock);
    expect(gpu.render.mock.calls[0]?.[1]).toMatchObject({ width: 800, height: 600, dpr: 1.25, scale: 10, twist: 0 });
    expect(rendererLine()).toContain('WebGL2 drawing base scene');
    f.select('unknown'); expect(f.paint()).toBe(true); expect(gpu.created).toHaveBeenCalledTimes(1);
    f.select('CANVAS'); const calls = gpu.render.mock.calls.length;
    expect(f.paint()).toBe(false); expect(gpu.render).toHaveBeenCalledTimes(calls); expect(f.elements[0]!.style.display).toBe('none');
    expect(rendererLine()).toBe('JCad renderer: Canvas 2D'); assertRetained(f, before); selector.dispose();
  });

  it('defers a first GPU selection during active 3D and resumes on the existing 2D viewport after exit', () => {
    const f = fixture(), before = retained(f); let active = true;
    const selector = installGpu2dCandidateSelector(f.editor, () => active);
    f.select('gpu'); expect(f.paint()).toBe(false);
    expect(f.editor.viewport).toBe(f.view); expect(f.elements).toHaveLength(0);
    expect(gpu.created).not.toHaveBeenCalled(); expect(gpu.render).not.toHaveBeenCalled();
    expect(rendererLine()).toBe('JCad renderer: WebGL2 experimental 3D modelling viewport');
    active = false; f.emit('view'); expect(f.paint()).toBe(true);
    expect(f.editor.viewport).toBe(f.view); expect(f.view.canvas.before).toHaveBeenCalledTimes(1);
    expect(f.elements[0]!.dataset).toEqual({ gpuCandidate: '2d' }); expect(f.elements[0]!.style.display).toBe('block');
    expect(gpu.created).toHaveBeenCalledTimes(1); expect(gpu.render).toHaveBeenCalledTimes(1);
    expect(rendererLine()).toContain('WebGL2 drawing base scene');
    selector.dispose(); expect(f.view.experimentalSceneRenderer).toBeNull(); expect(f.pageEvents.size).toBe(0);
    expect(f.elements[0]!.remove).toHaveBeenCalledTimes(1); expect(gpu.dispose).toHaveBeenCalledTimes(1);
    const renders = vi.mocked(f.editor.render).mock.calls.length;
    f.emit('view'); f.emit('log'); gpu.changed(); expect(f.editor.render).toHaveBeenCalledTimes(renders);
    assertRetained(f, before);
  });

  it('starts a new selector on Canvas after a selected editor is disposed', () => {
    const first = fixture(), selected = installGpu2dCandidateSelector(first.editor); first.select('gpu'); first.paint(); selected.dispose();
    const fresh = fixture(), restarted = installGpu2dCandidateSelector(fresh.editor);
    expect(fresh.view.experimentalSceneRenderer).toBeNull(); expect(fresh.elements).toHaveLength(0); expect(fresh.paint()).toBe(false);
    fresh.select('canvas'); expect(fresh.elements).toHaveLength(0); restarted.dispose();
  });
});

const refusals: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  ['grid', f => { f.view.settings.gridVisible = true; }],
  ['layout', f => { f.view.layoutPainter = () => {}; }],
  ['underlay', f => { f.view.underlay = () => {}; }],
  ['fit rectangle', f => { f.view.fitRect = { x: 0, y: 0, w: 1, h: 1 }; }],
  ['preview', f => { f.overlay.preview = f.doc.entities; }],
  ['ghost', f => { f.overlay.ghost = f.doc.entities; }],
];
describe('shared candidate fallback and lifecycle (mock-only)', () => {
  it.each(refusals)('refuses the complete %s view before any GPU allocation', (_name, apply) => {
    const f = fixture(), before = retained(f), core = createGpu2dController(f.editor); core.setMode('gpu'); apply(f);
    expect(f.paint()).toBe(false); expect(gpu.created).not.toHaveBeenCalled(); expect(gpu.render).not.toHaveBeenCalled();
    expect(f.elements).toHaveLength(0); expect(rendererLine()).toBe('JCad renderer: Canvas 2D'); assertRetained(f, before); core.dispose();
  });

  it('hides an admitted backing on refusal and preserves the actual refusal reason/telemetry', () => {
    const f = fixture(), before = retained(f), core = createGpu2dController(f.editor); core.setMode('gpu'); expect(f.paint()).toBe(true);
    const refusal = { rendered: false, reason: 'Unsupported native text', uploadCalls: 0, bytes: 0, cacheReason: 'refusal-hit' };
    gpu.render.mockReturnValueOnce(refusal);
    expect(f.paint()).toBe(false); expect(core.renderStats()).toEqual(refusal); expect(f.elements[0]!.style.display).toBe('none');
    expect(rendererLine()).toBe('JCad renderer: Canvas 2D'); assertRetained(f, before); core.dispose();
  });

  it('returns complete Canvas on constructor or render failure without changing drawing/history', () => {
    const f = fixture(), before = retained(f), core = createGpu2dController(f.editor); core.setMode('gpu');
    gpu.created.mockImplementationOnce(() => { throw new Error('Context creation unavailable'); });
    expect(f.paint()).toBe(false); expect(gpu.render).not.toHaveBeenCalled(); expect(f.elements[0]!.style.display).toBe('none');
    expect(core.state().reason).toContain('full view uses Canvas');
    gpu.render.mockImplementationOnce(() => { throw new Error('Shader or draw failed'); }); expect(f.paint()).toBe(false);
    expect(rendererLine()).toBe('JCad renderer: Canvas 2D'); assertRetained(f, before); core.dispose();
  });

  it('keeps selected mode through lost/ready callbacks while reporting fallback until an actual successful redraw', () => {
    const f = fixture(), before = retained(f), core = createGpu2dController(f.editor); core.setMode('gpu'); f.paint();
    gpu.device.state = 'lost'; gpu.changed(); gpu.render.mockReturnValueOnce({ rendered: false });
    expect(rendererLine()).toBe('JCad renderer: Canvas 2D'); expect(f.paint()).toBe(false); expect(f.elements[0]!.style.display).toBe('none');
    gpu.device.state = 'ready'; gpu.changed(); expect(rendererLine()).toBe('JCad renderer: Canvas 2D');
    expect(f.paint()).toBe(true); expect(core.state().mode).toBe('gpu'); expect(rendererLine()).toContain('WebGL2 drawing base scene');
    expect(gpu.created).toHaveBeenCalledTimes(1); assertRetained(f, before); core.dispose();
  });

  it('hides immediately for active 3D, resumes the selected mode on exit, and releases only its hook/listeners on pagehide', () => {
    const f = fixture(), before = retained(f); let active = false;
    const core = createGpu2dController(f.editor, () => active); core.setMode('gpu'); expect(f.paint()).toBe(true);
    active = true; f.emit('log'); expect(f.elements[0]!.style.display).toBe('none');
    const submissions = gpu.render.mock.calls.length; expect(f.paint()).toBe(false); expect(gpu.render).toHaveBeenCalledTimes(submissions);
    expect(rendererLine()).toBe('JCad renderer: WebGL2 experimental 3D modelling viewport');
    active = false; f.emit('view'); expect(f.paint()).toBe(true);
    f.pageEvents.get('pagehide')!(); expect(gpu.dispose).toHaveBeenCalledTimes(1); expect(f.view.experimentalSceneRenderer).toBeNull();
    expect(f.elements[0]!.remove).toHaveBeenCalledTimes(1); const renders = vi.mocked(f.editor.render).mock.calls.length;
    f.emit('log'); f.emit('view'); gpu.changed(); expect(f.editor.render).toHaveBeenCalledTimes(renders);
    core.dispose(); expect(gpu.dispose).toHaveBeenCalledTimes(1); assertRetained(f, before);
  });

  it("does not clear a subsequent owner’s scene hook during disposal", () => {
    const f = fixture(), core = createGpu2dController(f.editor), next = vi.fn(() => false);
    f.view.experimentalSceneRenderer = next; core.dispose(); expect(f.view.experimentalSceneRenderer).toBe(next);
  });
});
