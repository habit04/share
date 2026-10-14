import type { Editor } from './editor';
import { Gpu2DRenderer, emptyGpu2DRenderResult, type Gpu2DRenderResult } from '../render/gpu-prototype/renderer2d';
import { lineweightDisplay } from '../render/draw';
import { setDiagnosticRenderer } from './gpu-diagnostics';

export type Gpu2dMode = 'canvas' | 'gpu';
export interface Gpu2dModeState extends Gpu2DRenderResult { mode: Gpu2dMode; active3d: boolean }

/** Shared runtime only: no fixtures, debugger globals, preferences or document writes. */
export function createGpu2dController(editor: Editor, active3d: () => boolean = () => false,
  options: { developmentCanvas?: boolean } = {}) {
  const view = editor.viewport;
  let canvas: HTMLCanvasElement | null = null;
  const ensureCanvas = () => {
    if (!canvas) {
      canvas = document.createElement('canvas');
      if (options.developmentCanvas) canvas.dataset.gpuPrototype = '2d';
      else canvas.dataset.gpuCandidate = '2d';
      Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', display: 'none' });
      view.canvas.before(canvas);
    }
    return canvas;
  };
  if (options.developmentCanvas) ensureCanvas();
  let mode: Gpu2dMode = 'canvas';
  let renderer: Gpu2DRenderer | null = null;
  let lossControl: WEBGL_lose_context | null = null;
  let resettingRenderer = false, disposed = false;
  let last = emptyGpu2DRenderResult('Canvas 2D selected');
  const listeners = new Set<(state: Gpu2dModeState) => void>();
  const state = (): Gpu2dModeState => ({ mode, ...last, active3d: active3d() });
  const notify = () => { if (listeners.size) { const value = state(); for (const fn of listeners) fn(value); } };
  setDiagnosticRenderer(() => active3d() ? 'WebGL2 experimental 3D modelling viewport' : mode === 'gpu' && last.rendered && renderer?.device.state === 'ready' ? 'WebGL2 drawing base scene + Canvas 2D editing overlays (experimental)' : 'Canvas 2D');
  let in3d = active3d();
  const sync3dMode = () => {
    if (disposed) return;
    const next = active3d();
    if (next) {
      if (canvas) canvas.style.display = 'none';
      last = emptyGpu2DRenderResult('Experimental 3D viewport active');
    }
    notify();
    if (next !== in3d) { in3d = next; editor.render(); }
  };
  const unsubscribe3d = [editor.on('log', sync3dMode), editor.on('view', sync3dMode)];
  sync3dMode();
  const setMode = (next: Gpu2dMode) => {
    if (disposed) return;
    // Mode toggles retry admission while retaining certified prepared/uploaded scenes.
    if (mode !== next) renderer?.clearRefusalCache();
    mode = next;
    editor.render();
  };
  const renderScene: NonNullable<typeof view.experimentalSceneRenderer> = (vp, overlay) => {
    const reject = (reason: string, metrics = emptyGpu2DRenderResult(reason)) => {
      if (canvas) canvas.style.display = 'none';
      last = { ...metrics, rendered: false, reason };
      notify();
      return false;
    };
    if (disposed) return false;
    if (active3d()) return reject('Experimental 3D viewport active');
    if (mode !== 'gpu') return reject('Canvas 2D selected');
    if (vp.settings.gridVisible) return reject('Grid visible: Canvas 2D preserves grid/geometry compositing order (F7 toggles grid)');
    if (vp.layoutPainter || vp.underlay || vp.fitRect) return reject('Layouts and underlays use Canvas 2D');
    if (overlay.preview.length || overlay.ghost.length) return reject('Tool previews use Canvas 2D');
    try {
      renderer ??= new Gpu2DRenderer(ensureCanvas(), () => { if (!resettingRenderer && !disposed) editor.render(); });
      last = renderer.render(editor.doc.snapshot, { width: vp.width, height: vp.height, dpr: vp.dpr, scale: vp.scale, center: vp.center, twist: vp.twist, background: vp.settings.background, lineweights: lineweightDisplay.enabled }, { selection: overlay.selection, hover: overlay.hover, solidSelection: vp.settings.selectionEffect === 'solid' }, editor.doc.lookupBlock);
      if (!last.rendered) return reject(last.reason ?? 'GPU rendering unavailable', last);
      ensureCanvas().style.display = 'block';
      notify();
      return true;
    } catch { return reject('GPU initialization or rendering failed; the full view uses Canvas 2D'); }
  };
  view.experimentalSceneRenderer = renderScene;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const off of unsubscribe3d) off();
    window.removeEventListener?.('pagehide', dispose);
    if (mode !== 'canvas') renderer?.clearRefusalCache();
    mode = 'canvas';
    resettingRenderer = true;
    try { renderer?.dispose(); }
    finally {
      renderer = null; lossControl = null; resettingRenderer = false;
      if (canvas) { canvas.style.display = 'none'; canvas.remove(); canvas = null; }
      if (view.experimentalSceneRenderer === renderScene) view.experimentalSceneRenderer = null;
      last = emptyGpu2DRenderResult('Canvas 2D selected');
      notify(); listeners.clear(); editor.render();
    }
  };
  window.addEventListener?.('pagehide', dispose);
  return {
    setMode, state, dispose,
    subscribe: (fn: (value: Gpu2dModeState) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    status: () => ({ mode, ...last, device: renderer?.device.state ?? 'not-created', capabilities: renderer?.device.capabilities() ?? null }),
    renderStats: () => ({ ...last }),
    renderNow: () => { view.renderCurrent(); return { ...last }; },
    completed: () => renderer?.device.completed() ?? Promise.resolve(null),
    reset2DRenderer: () => {
      const previous = renderer; renderer = null; lossControl = null; resettingRenderer = true;
      try { previous?.dispose(); } finally { resettingRenderer = false; }
      last = emptyGpu2DRenderResult('Experimental renderer reset');
      if (canvas) canvas.style.display = 'none';
    },
    loseContext: () => { lossControl = renderer?.device.gl.getExtension('WEBGL_lose_context') ?? null; lossControl?.loseContext(); },
    restoreContext: () => lossControl?.restoreContext(),
  };
}

/** Explicit ephemeral production selection. Merely registering creates no canvas/device. */
export function installGpu2dCandidateSelector(editor: Editor, active3d: () => boolean = () => false) {
  let controller: ReturnType<typeof createGpu2dController> | null = null;
  editor.register({ name: 'GPURENDERER', aliases: [], description: 'Candidate 2D renderer [GPU/Canvas]; Canvas is the default', run: (_ed, arg) => {
    const requested = arg?.trim().toLowerCase();
    if (requested !== 'gpu' && requested !== 'canvas') {
      editor.log('GPURENDERER GPU or GPURENDERER CANVAS (current: ' + (controller?.state().mode ?? 'canvas') + ').');
      return;
    }
    if (requested === 'gpu') controller ??= createGpu2dController(editor, active3d);
    controller?.setMode(requested);
  } });
  return { dispose: () => { controller?.dispose(); controller = null; } };
}
