import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import type { installExperimental3d as Install3d } from '../src/app/experimental-3d';
import { installGpu2dCandidateSelector } from '../src/app/gpu-2d-candidate';
import { emptyGpuDiagnostics, gpuDiagnosticsLines, setDiagnosticRenderer } from '../src/app/gpu-diagnostics';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '../src/app/settings';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import { makeDimension3D } from '../src/model3d/dimension3d';
import { WORLD_XY_FRAME, v3 } from '../src/model3d/math';
import { addDimensions3D, addSolids, model3dOf, newSolid } from '../src/model3d/model';
import { primitiveMesh } from '../src/model3d/primitives';
import type { PrimitiveFeature } from '../src/model3d/types';
import { RIBBON } from '../src/ui/ribbon';
import { fakeViewport3d } from './helpers/fake-viewport3d';

// Real Editor/document/command registration in main.ts order. Canvas drawing, GPU submission
// and active 3D drawing are stubbed: this does not certify native rendering or GPU accuracy.
const gpu = vi.hoisted(() => ({ created: vi.fn(), dispose: vi.fn(), clear: vi.fn(),
  render: vi.fn((..._args: unknown[]) => ({ rendered: true })) }));
vi.mock('../src/render/gpu-prototype/renderer2d', () => ({
  emptyGpu2DRenderResult: (reason: string) => ({ rendered: false, reason }),
  Gpu2DRenderer: class {
    device = { state: 'ready', capabilities: () => null };
    constructor() { gpu.created(); }
    render = gpu.render; dispose = gpu.dispose; clearRefusalCache = gpu.clear;
  },
}));

let Editor: typeof EditorType;
let installExperimental3d: typeof Install3d;
const cleanups: Array<() => void> = [];
beforeAll(async () => {
  Editor = (await import('../src/app/editor')).Editor;
  ({ installExperimental3d } = await import('../src/app/experimental-3d'));
});
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('document', undefined);
  vi.stubGlobal('Worker', vi.fn());
  gpu.render.mockReset().mockReturnValue({ rendered: true });
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  const tab = RIBBON.findIndex(value => value.name === '3D');
  if (tab >= 0) RIBBON.splice(tab, 1);
  vi.unstubAllGlobals(); vi.clearAllMocks();
  setDiagnosticRenderer(() => 'Canvas 2D');
});

function fixture(optOut = false) {
  const raw = optOut ? JSON.stringify({ ...DEFAULT_SETTINGS, experimental3d: false }) : null;
  const storage = { getItem: vi.fn((key: string) => key === SETTINGS_KEY ? raw : null), setItem: vi.fn() };
  const globals = { devicePixelRatio: 1.25, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', globals);
  const context = vi.fn((kind: string) => {
    if (kind !== '2d') throw new Error('Registration must not allocate a WebGL context');
    return {};
  });
  const canvas = { getContext: context, getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }),
    width: 0, height: 0, before: vi.fn() } as unknown as HTMLCanvasElement;
  const ed = new Editor(canvas);
  const requestedRender = vi.spyOn(ed.viewport, 'requestRender');
  cleanups.push(() => ed.viewport.dispose());
  // Reuse the production model constructors used by the 3D selection regression fixtures.
  const feature: PrimitiveFeature = { kind: 'box', frame: WORLD_XY_FRAME, width: 1, depth: 1, height: 1 };
  const solid = newSolid({ id: 'retained-solid', layer: '0', feature, mesh: primitiveMesh(feature) });
  const dimension = makeDimension3D({ id: 'retained-dimension', kind: 'aligned', layer: '0', color: 'ByLayer',
    plane: WORLD_XY_FRAME, style: STANDARD_DIMSTYLE, p1: v3(0, 0, 0), p2: v3(1, 0, 0), location: v3(0, 1, 0) });
  ed.doc.load({ ...ed.doc.snapshot,
    entities: [{ id: 'line-2d', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 2, y: 0 } }],
    model3d: addDimensions3D(addSolids(model3dOf(ed.doc.snapshot), [solid]), [dimension]),
    meta: { retained: { unicode: 'Δ 雷', literal: 'F0A' } },
  });
  const elements: Array<{ style: Record<string, string>; dataset: Record<string, string>; remove: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('document', { createElement: vi.fn(() => {
    const element = { style: {}, dataset: {}, remove: vi.fn() }; elements.push(element); return element;
  }) });
  return { ed, storage, globals, context, elements,
    paint: () => {
      ed.render();
      const overlay = requestedRender.mock.lastCall?.[0];
      if (!overlay) throw new Error('Editor.render must submit its overlay through Viewport.requestRender');
      return ed.viewport.experimentalSceneRenderer?.(ed.viewport, overlay) ?? false;
    } };
}

function register(f: ReturnType<typeof fixture>) {
  // Match the ordinary (not gpu-experimental) startup path in src/main.ts.
  const three = installExperimental3d(f.ed);
  setDiagnosticRenderer(() => three?.active ? 'WebGL2 experimental 3D modelling viewport' : 'Canvas 2D');
  const selector = installGpu2dCandidateSelector(f.ed, () => three?.active ?? false);
  cleanups.push(() => { selector.dispose(); three?.disposeKernel(); });
  return three;
}
const rendererLine = () => gpuDiagnosticsLines(emptyGpuDiagnostics()).find(line => line.startsWith('JCad renderer:'));
const retained = (ed: EditorType) => ({ snapshot: ed.doc.snapshot, revision: ed.doc.revision, dirty: ed.doc.dirty,
  filePath: ed.doc.filePath, history: ed.doc.history(), settings: ed.settings });
function assertRetained(ed: EditorType, before: ReturnType<typeof retained>) {
  expect(ed.doc.snapshot).toBe(before.snapshot); expect(ed.doc.revision).toBe(before.revision);
  expect(ed.doc.dirty).toBe(before.dirty); expect(ed.doc.filePath).toBe(before.filePath);
  expect(ed.doc.history()).toEqual(before.history); expect(ed.settings).toBe(before.settings);
}

describe('combined ordinary GPU selector and default 3D registration (mock rendering)', () => {
  it('starts on Canvas with both command families ready and no GPU canvas, viewport, kernel or document mutation', () => {
    const f = fixture(), before = retained(f.ed), log = [...f.ed.history];
    expect(f.ed.settings.experimental3d).toBe(true);
    expect(f.ed.settings.importForeign3d).toBe(false);
    const three = register(f)!;
    for (const name of ['GPURENDERER', '3DMODE', '3DVIEW', 'BOX', '3DMOVE', 'DIM3D']) expect(f.ed.commands.has(name), name).toBe(true);
    expect(RIBBON.filter(tab => tab.name === '3D')).toHaveLength(1);
    expect(f.globals).toHaveProperty('jcad3d', three);
    expect(three.active).toBe(false); expect(three.viewport).toBeNull(); expect(three.kernelStarted).toBe(false);
    expect(f.ed.viewport.experimentalSceneRenderer).toBeNull(); expect(f.paint()).toBe(false);
    expect(f.elements).toEqual([]); expect(gpu.created).not.toHaveBeenCalled(); expect(Worker).not.toHaveBeenCalled();
    expect(f.context.mock.calls).toEqual([['2d']]);
    expect(rendererLine()).toBe('JCad renderer: Canvas 2D');
    expect(f.ed.history).toEqual(log); expect(f.storage.setItem).not.toHaveBeenCalled(); assertRetained(f.ed, before);
  });

  it('selects GPU explicitly while registered 3D stays inactive, then restores Canvas without changing retained data', async () => {
    const f = fixture(), before = retained(f.ed), three = register(f)!;
    await f.ed.runCommand('GPURENDERER GPU');
    expect(gpu.created).not.toHaveBeenCalled(); expect(f.elements).toEqual([]);
    // The fresh profile's visible grid must retain complete Canvas fallback. Disable only
    // this view's grid in the harness to exercise the separately admitted GPU submission.
    expect(f.ed.viewport.settings.gridVisible).toBe(true); expect(f.paint()).toBe(false);
    expect(gpu.created).not.toHaveBeenCalled(); expect(f.elements).toEqual([]);
    f.ed.viewport.settings.gridVisible = false;
    expect(f.paint()).toBe(true); expect(gpu.created).toHaveBeenCalledTimes(1);
    expect(f.elements).toHaveLength(1); expect(f.elements[0]!.dataset).toEqual({ gpuCandidate: '2d' });
    expect(gpu.render.mock.calls[0]?.[0]).toBe(before.snapshot);
    expect(gpu.render.mock.calls[0]?.[3]).toBe(f.ed.doc.lookupBlock);
    expect(rendererLine()).toContain('WebGL2 drawing base scene');
    expect(three.active).toBe(false); expect(three.viewport).toBeNull(); expect(three.kernelStarted).toBe(false);
    expect(Worker).not.toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled(); assertRetained(f.ed, before);
    const submissions = gpu.render.mock.calls.length;
    await f.ed.runCommand('GPURENDERER CANVAS');
    expect(f.paint()).toBe(false); expect(gpu.render).toHaveBeenCalledTimes(submissions);
    expect(f.elements[0]!.style.display).toBe('none'); expect(rendererLine()).toBe('JCad renderer: Canvas 2D');
    assertRetained(f.ed, before);
  });

  it('keeps a persisted 3D opt-out while making the independent explicit GPU selector available', async () => {
    const f = fixture(true), before = retained(f.ed), commands = [...f.ed.commands.keys()];
    expect(f.ed.settings.experimental3d).toBe(false); expect(register(f)).toBeNull();
    expect([...f.ed.commands.keys()].filter(name => !commands.includes(name))).toEqual(['GPURENDERER']);
    for (const name of ['3DMODE', '3DVIEW', 'BOX', 'DIM3D']) expect(f.ed.commands.has(name), name).toBe(false);
    expect(f.globals).not.toHaveProperty('jcad3d'); expect(RIBBON.some(tab => tab.name === '3D')).toBe(false);
    expect(f.paint()).toBe(false); expect(f.elements).toEqual([]); expect(gpu.created).not.toHaveBeenCalled();
    f.ed.viewport.settings.gridVisible = false;
    await f.ed.runCommand('GPURENDERER GPU'); expect(f.paint()).toBe(true);
    expect(f.ed.settings.experimental3d).toBe(false); expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(Worker).not.toHaveBeenCalled(); assertRetained(f.ed, before);
  });

  it('defers the selected GPU until the same registered 3D controller leaves its active viewport', async () => {
    const f = fixture(), before = retained(f.ed), three = register(f)!;
    three.viewport = fakeViewport3d(f.ed.doc);
    await f.ed.runCommand('GPURENDERER GPU');
    expect(f.paint()).toBe(false); expect(f.elements).toEqual([]); expect(gpu.created).not.toHaveBeenCalled();
    expect(rendererLine()).toBe('JCad renderer: WebGL2 experimental 3D modelling viewport');
    three.viewport = null; f.ed.notify('view');
    f.ed.viewport.settings.gridVisible = false;
    expect(f.paint()).toBe(true); expect(gpu.created).toHaveBeenCalledTimes(1);
    expect(three.kernelStarted).toBe(false); expect(Worker).not.toHaveBeenCalled(); assertRetained(f.ed, before);
  });

  it('keeps hidden retained 3D out of GPU-selected 2D ERASE ALL and preserves one-step undo and redo', async () => {
    const f = fixture(), before = retained(f.ed), three = register(f)!;
    f.ed.viewport.settings.gridVisible = false;
    await f.ed.runCommand('GPURENDERER GPU'); expect(f.paint()).toBe(true);
    const ids = new Set<string>(); expect(f.ed.selectionKeyword?.('ALL', ids)).toBe(true);
    expect([...ids]).toEqual(['line-2d']); assertRetained(f.ed, before);
    await f.ed.runCommand('ERASE'); f.ed.submitInput('ALL'); f.ed.submitInput('');
    const erased = f.ed.doc.snapshot;
    expect(erased.entities).toEqual([]); expect(erased.model3d).toBe(before.snapshot.model3d);
    expect(erased.meta).toBe(before.snapshot.meta); expect(f.ed.doc.dirty).toBe(true);
    expect(f.ed.doc.history().undo).toHaveLength(1); expect(f.ed.doc.history().redo).toHaveLength(0);
    expect(f.paint()).toBe(true); expect(gpu.render.mock.lastCall?.[0]).toBe(erased);
    f.ed.doc.undo(); expect(f.ed.doc.snapshot).toBe(before.snapshot);
    // Drawing.undo deliberately stays dirty, even when it restores the initially loaded state.
    expect(f.ed.doc.dirty).toBe(true); expect(f.ed.doc.history().undo).toHaveLength(0);
    expect(f.ed.doc.history().redo).toHaveLength(1); expect(f.paint()).toBe(true);
    f.ed.doc.redo(); expect(f.ed.doc.snapshot).toBe(erased); expect(f.ed.doc.dirty).toBe(true);
    expect(f.ed.doc.history().undo).toHaveLength(1); expect(f.ed.doc.history().redo).toHaveLength(0);
    expect(erased.model3d).toBe(before.snapshot.model3d); expect(f.paint()).toBe(true);
    expect(three.active).toBe(false); expect(three.viewport).toBeNull(); expect(three.kernelStarted).toBe(false);
    expect(Worker).not.toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled();
  });
});
