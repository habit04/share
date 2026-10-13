import type { Editor } from './editor';
import { Gpu2DRenderer, type Gpu2DRenderResult } from '../render/gpu-prototype/renderer2d';
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
  let last: Gpu2DRenderResult = { rendered: false, reason: 'Canvas 2D selected', preparationMs: 0, submissionMs: 0, bytes: 0 };
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
    const reject = (reason: string) => {
      canvas.style.display = 'none';
      last = { ...last, rendered: false, reason };
      indicator.textContent = `Experimental: Canvas 2D${mode === 'gpu' ? ' fallback' : ''}`;
      indicator.title = reason;
      return false;
    };
    if (mode !== 'gpu') return reject('Canvas 2D selected');
    if (vp.settings.gridVisible) return reject('Grid visible: Canvas 2D preserves grid/geometry compositing order (F7 toggles grid)');
    if (vp.layoutPainter || vp.underlay || vp.fitRect) return reject('Layouts and underlays use Canvas 2D');
    if (overlay.preview.length || overlay.ghost.length) return reject('Tool previews use Canvas 2D');
    try {
      renderer ??= new Gpu2DRenderer(canvas, () => editor.render());
      last = renderer.render(editor.doc.snapshot, { width: vp.width, height: vp.height, dpr: vp.dpr, scale: vp.scale, center: vp.center, twist: vp.twist, background: vp.settings.background, lineweights: lineweightDisplay.enabled }, { selection: overlay.selection, hover: overlay.hover, solidSelection: vp.settings.selectionEffect === 'solid' });
      if (!last.rendered) return reject(last.reason ?? 'GPU rendering unavailable');
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
    loadFixture: (name: string) => {
      const base = bigDrawing(name === 'dense-lines' ? 38000 : 5000, name === 'mixed-schematic' ? 1000 : 0, name === 'mixed-schematic' ? 500 : 0);
      if (name === 'curves' || name === 'precision') {
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
      editor.viewport.settings.gridVisible = false;
      editor.viewport.renderCurrent();
    },
    status: () => ({ mode, ...last, device: renderer?.device.state ?? 'not-created', capabilities: renderer?.device.capabilities() ?? null, demo: demoHandle?.status() ?? null }),
    renderNow: () => { editor.viewport.renderCurrent(); return { ...last }; },
    completed: () => renderer?.device.completed() ?? Promise.resolve(null),
    loseContext: () => { lossControl = renderer?.device.gl.getExtension('WEBGL_lose_context') ?? null; lossControl?.loseContext(); },
    restoreContext: () => lossControl?.restoreContext(),
    dispose: () => { demoHandle?.dispose(); demoHandle = null; mode = 'canvas'; renderer?.dispose(); renderer = null; canvas.style.display = 'none'; view.experimentalSceneRenderer = null; canvas.remove(); indicator.remove(); editor.render(); },
  } });
}
