import type { Editor } from './editor';
import { Gpu2DRenderer, emptyGpu2DRenderResult, type Gpu2DRenderResult } from '../render/gpu-prototype/renderer2d';
import { mountGpuDemo } from '../render/gpu-prototype/demo3d';
import { modal, button } from '../ui/dialogkit';
import { lineweightDisplay } from '../render/draw';
import { bigDrawing } from '../../tests/helpers/big-drawing';
import { setDiagnosticRenderer } from './gpu-diagnostics';

/** Inert in default builds; all state is ephemeral and outside Drawing/saving. */
export function installGpuPrototype(editor: Editor): void {
  const view = editor.viewport;
  const canvas = document.createElement('canvas');
  canvas.dataset.gpuPrototype = '2d';
  Object.assign(canvas.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', display: 'none' });
  view.canvas.before(canvas);
  let mode: 'canvas' | 'gpu' = 'canvas';
  let renderer: Gpu2DRenderer | null = null;
  let lossControl: WEBGL_lose_context | null = null;
  let resettingRenderer = false;
  let last: Gpu2DRenderResult = emptyGpu2DRenderResult('Canvas 2D selected');
  const indicator = document.createElement('button');
  indicator.dataset.gpuPrototype = 'indicator';
  indicator.textContent = 'Experimental: Canvas 2D';
  indicator.title = 'Toggle experimental GPU / Canvas renderer. Unsupported views use Canvas automatically.';
  Object.assign(indicator.style, { position: 'absolute', left: '12px', top: '12px', zIndex: '3', background: '#26384a', color: '#fff', padding: '6px', border: '1px solid #6a7c8a' });
  view.canvas.parentElement!.append(indicator);
  let demoHandle: ReturnType<typeof mountGpuDemo> | null = null;
  setDiagnosticRenderer(() => mode === 'gpu' && last.rendered && renderer?.device.state === 'ready' ? 'WebGL2 drawing base scene + Canvas 2D editing overlays (experimental)' : 'Canvas 2D');
  const setMode = (next: 'canvas' | 'gpu') => { mode = next; editor.render(); };
  indicator.addEventListener('click', () => setMode(mode === 'canvas' ? 'gpu' : 'canvas'));
  view.experimentalSceneRenderer = (vp, overlay) => {
    const reject = (reason: string, metrics = emptyGpu2DRenderResult(reason)) => {
      canvas.style.display = 'none';
      last = { ...metrics, rendered: false, reason };
      indicator.textContent = `Experimental: Canvas 2D${mode === 'gpu' ? ' fallback' : ''}`;
      indicator.title = reason;
      return false;
    };
    if (mode !== 'gpu') return reject('Canvas 2D selected');
    if (vp.settings.gridVisible) return reject('Grid visible: Canvas 2D preserves grid/geometry compositing order (F7 toggles grid)');
    if (vp.layoutPainter || vp.underlay || vp.fitRect) return reject('Layouts and underlays use Canvas 2D');
    if (overlay.preview.length || overlay.ghost.length) return reject('Tool previews use Canvas 2D');
    try {
      renderer ??= new Gpu2DRenderer(canvas, () => { if (!resettingRenderer) editor.render(); });
      last = renderer.render(editor.doc.snapshot, { width: vp.width, height: vp.height, dpr: vp.dpr, scale: vp.scale, center: vp.center, twist: vp.twist, background: vp.settings.background, lineweights: lineweightDisplay.enabled }, { selection: overlay.selection, hover: overlay.hover, solidSelection: vp.settings.selectionEffect === 'solid' });
      if (!last.rendered) return reject(last.reason ?? 'GPU rendering unavailable', last);
      canvas.style.display = 'block';
      indicator.textContent = 'Experimental: WebGL2';
      indicator.title = 'Drawing base scene: WebGL2; grid, cursor and editing overlays: Canvas 2D';
      return true;
    } catch {
      return reject('GPU initialization or rendering failed; the full view uses Canvas 2D');
    }
  };
  editor.register({ name: 'GPURENDERER', aliases: [], description: 'Experimental development renderer: Canvas / GPU', run: (_ed, arg) => { setMode(arg?.trim().toLowerCase() === 'canvas' ? 'canvas' : arg?.trim().toLowerCase() === 'gpu' ? 'gpu' : mode === 'canvas' ? 'gpu' : 'canvas'); } });
  editor.register({ name: 'GPU3DDEMO', aliases: [], description: 'Experimental demonstration meshes (no document changes)', run: () => {
    const m = modal('Experimental GPU 3D demonstration', 920, 'dark');
    const container = document.createElement('div');
    container.style.height = '540px';
    m.body.append(container);
    const demo = mountGpuDemo(container);
    demoHandle = demo;
    const dispose = () => { demo.dispose(); if (demoHandle === demo) demoHandle = null; };
    const close = button('Close');
    close.addEventListener('click', () => { dispose(); m.close(); });
    m.onClose(dispose);
    m.footer.append(close);
  } });
  // Development harness for reproducible tests. Never exposed by ordinary builds.
  Object.assign(window, { gpuPrototype: {
    setMode,
    // Cold-frame measurement resets only the owner-created experimental 2D context resources.
    // Do this before starting the benchmark timer; setMode then renders the actual first frame.
    reset2DRenderer: () => {
      const previous = renderer;
      renderer = null;
      lossControl = null;
      resettingRenderer = true;
      try { previous?.dispose(); }
      finally { resettingRenderer = false; }
      last = emptyGpu2DRenderResult('Experimental renderer reset');
      canvas.style.display = 'none';
    },
    loadFixture: (name: string) => {
      const base = bigDrawing(name === 'dense-lines' ? 38000 : 5000, name === 'mixed-schematic' ? 1000 : 0, name === 'mixed-schematic' ? 500 : 0);
      if (name === 'precision-trillion') {
        const origin = { x: 1e12, y: -1e12 };
        const p = (x: number, y: number) => ({ x: origin.x + x, y: origin.y + y });
        const style = { layer: '0', color: 7 };
        editor.loadState({ ...base, entities: [
          { ...style, id: 'L', type: 'line', a: p(-1 / 16, 1 / 8192), b: p(1 / 16, 1 / 8192) },
          { ...style, color: 1, id: 'C', type: 'circle', center: p(-1 / 32, 1 / 32), radius: 1 / 64 },
          { ...style, color: 3, id: 'A', type: 'arc', center: p(1 / 32, -1 / 64), radius: 3 / 128, startAngle: 0.2, endAngle: 3.8 },
          { ...style, color: 5, id: 'P', type: 'polyline', points: [p(-1 / 32, -1 / 32), p(1 / 32, -1 / 32), p(1 / 16, -1 / 64)], closed: false, bulges: [1, 0] },
        ] }, null);
        // All coordinates are representable at 1e12; two CSS pixels are four world ULPs.
        view.center = origin;
        view.scale = 4096;
        view.twist = 0.63;
      } else if (name === 'lineweights' || name === 'wide-curve-fallback') {
        const style = { layer: '0', color: 7 };
        editor.loadState({ ...base, entities: [
          { ...style, id: 'L', type: 'line', a: { x: -4, y: -1 }, b: { x: 4, y: 1 }, lineWeight: 1 },
          { ...style, color: 1, id: 'X', type: 'line', a: { x: -4, y: 1 }, b: { x: 4, y: -1 }, lineWeight: 2 },
          { ...style, color: 3, id: 'C', type: 'circle', center: { x: -2, y: 1.5 }, radius: name === 'wide-curve-fallback' ? 0.1 : 0.4, lineWeight: 10 },
          { ...style, color: 5, id: 'A', type: 'arc', center: { x: 2, y: 1 }, radius: name === 'wide-curve-fallback' ? 0.2 : 0.3, startAngle: 0.2, endAngle: 3.8, lineWeight: 6 },
          { ...style, color: 2, id: 'P', type: 'polyline', points: [{ x: -2, y: -1.5 }, { x: -1, y: -1.5 }, { x: -0.5, y: -0.75 }], closed: false, bulges: [0.6, 0], lineWeight: 4 },
        ] }, null);
        view.center = { x: 0, y: 0 };
        view.scale = 80;
        view.twist = 0;
      } else if (name === 'curves' || name === 'precision') {
        const shift = name === 'precision' ? 1e9 : 0;
        const p = (x: number, y: number) => ({ x: x + shift, y: y + shift });
        const style = { layer: '0', color: 7 };
        editor.loadState({ ...base, entities: [
          { ...style, id: 'L', type: 'line', a: p(0, 0), b: p(7, 5) },
          { ...style, color: 1, id: 'C', type: 'circle', center: p(3, 3), radius: 1 },
          { ...style, color: 3, id: 'A', type: 'arc', center: p(5, 2), radius: 1.5, startAngle: 0.2, endAngle: 3.8 },
          { ...style, color: 5, id: 'P', type: 'polyline', points: [p(0, 4), p(1, 5), p(2, 4)], closed: false, bulges: [0.5, 0] },
        ] }, null);
      } else editor.loadState(base, null);
      // Fixture-local display state must not leak into the ordinary comparison scenes.
      lineweightDisplay.enabled = name === 'lineweights' || name === 'wide-curve-fallback';
      lineweightDisplay.pxPerMm = undefined;
      editor.viewport.settings.gridVisible = false;
      editor.viewport.renderCurrent();
    },
    status: () => ({ mode, ...last, device: renderer?.device.state ?? 'not-created', capabilities: renderer?.device.capabilities() ?? null, demo: demoHandle?.status() ?? null }),
    renderStats: () => ({ ...last }),
    renderNow: () => { editor.viewport.renderCurrent(); return { ...last }; },
    completed: () => renderer?.device.completed() ?? Promise.resolve(null),
    loseContext: () => { lossControl = renderer?.device.gl.getExtension('WEBGL_lose_context') ?? null; lossControl?.loseContext(); },
    restoreContext: () => lossControl?.restoreContext(),
    dispose: () => { demoHandle?.dispose(); demoHandle = null; mode = 'canvas'; renderer?.dispose(); renderer = null; canvas.style.display = 'none'; view.experimentalSceneRenderer = null; canvas.remove(); indicator.remove(); editor.render(); },
  } });
}
