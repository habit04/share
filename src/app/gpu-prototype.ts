import type { Editor } from './editor';
import { Gpu2DRenderer, emptyGpu2DRenderResult, type Gpu2DRenderResult } from '../render/gpu-prototype/renderer2d';
import { mountGpuDemo } from '../render/gpu-prototype/demo3d';
import { modal, button } from '../ui/dialogkit';
import { lineweightDisplay } from '../render/draw';
import { bigDrawing } from '../../tests/helpers/big-drawing';
import { setDiagnosticRenderer } from './gpu-diagnostics';
import type { DrawingState } from '../core/document';
import { DEFAULT_HEADER } from '../core/document';
import type { BlockDef, Entity, TextEntity } from '../core/entities';
import type { Point } from '../core/geometry';
import { STANDARD_TEXT_STYLE } from '../io/encoding';

interface FixtureMetadata {
  name: string;
  probes: readonly { label: string; point: Point; rgb: readonly number[] }[];
  nearOriginReference?: string;
  block?: string;
  textStyle?: string;
}

/** Separate admitted stress input; the historical PERF_SYM and mixed fixture stay intact. */
function denseCompoundFixture(): DrawingState {
  const source = bigDrawing(5000, 1000, 500);
  const block: BlockDef = {
    name: 'GPU-DENSE-SYM', basePoint: { x: 0, y: 0 },
    entities: [
      { id: 'dense-left', layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.25, y: 0 }, b: { x: -0.05, y: 0 } },
      { id: 'dense-right', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0.05, y: 0 }, b: { x: 0.25, y: 0 } },
      { id: 'dense-post-left', layer: '0', color: 'ByLayer', type: 'line', a: { x: -0.05, y: -0.1 }, b: { x: -0.05, y: 0.1 } },
      { id: 'dense-post-right', layer: '0', color: 'ByLayer', type: 'line', a: { x: 0.05, y: -0.1 }, b: { x: 0.05, y: 0.1 } },
    ],
    // Visible glyphs stay well above QTEXT throughout the standard .8..1.25 band.
    attributes: [{ tag: 'TAG1', prompt: 'Tag', default: 'X', position: { x: 0, y: 0.25 }, height: 1.25, align: 'center' }],
  };
  return { ...source, blocks: { [block.name]: block }, entities: source.entities.map((entity) => entity.type === 'insert' ? { ...entity, block: block.name } : entity.type === 'text' ? { ...entity, height: 2 } : entity) };
}

/** Ordered native primitives; no renderer-specific glyph or placement formula. */
function compoundFixture(name: string): { state: DrawingState; center: Point; scale: number; twist: number; metadata: FixtureMetadata } {
  const far = name === 'compound-trillion';
  const unit = far || name === 'compound-trillion-reference' ? 1 / 64 : 1;
  const center = far ? { x: 1e12, y: -1e12 } : { x: 0, y: 0 };
  const p = (x: number, y: number): Point => ({ x: center.x + x * unit, y: center.y + y * unit });
  const local = (x: number, y: number): Point => ({ x: x * unit, y: y * unit });
  const base = bigDrawing(0, 0, 0);
  const common = { layer: '0', color: 7 } as const;
  const text = (id: string, value: string, x: number, y: number, patch: Partial<TextEntity> = {}): TextEntity => ({ ...common, id, type: 'text', position: p(x, y), text: value, height: 0.45 * unit, rotation: 0, align: 'left', style: 'GPU-STROKE', ...patch });
  const nested: BlockDef = {
    name: 'GPU-NESTED', basePoint: local(1, 2), attributes: [],
    entities: [
      { ...common, id: 'nested-wire', type: 'line', color: 0, a: local(1, 2), b: local(2.5, 2), lineWeight: 10 },
      { ...common, id: 'nested-text', type: 'text', color: 0, position: local(1, 2.4), text: 'NEST', height: 0.35 * unit, rotation: 0.1, align: 'left', style: 'GPU-STROKE' },
      { ...common, id: 'explicit-text', type: 'text', trueColor: 0x33ee88, position: local(1, 3), text: 'TRUE', height: 0.3 * unit, rotation: 0, align: 'left' },
    ],
  };
  const ordered: BlockDef = {
    name: 'GPU-ORDERED', basePoint: local(4, 5),
    entities: [
      { ...common, id: 'ordered-wire', type: 'line', color: 0, a: local(4, 3), b: local(4, 7), lineWeight: 10 },
      { ...common, id: 'ordered-label', type: 'text', trueColor: 0x44ddff, position: local(4.35, 5.6), text: 'Ag%%uB%%k', height: 0.4 * unit, rotation: 0, align: 'left', widthFactor: 1.25, oblique: 0.18, style: 'GPU-STROKE' },
      { ...common, id: 'hidden-child', type: 'text', layer: 'GPU-HIDDEN', position: local(4, 5), text: 'HIDDEN', height: unit, rotation: 0, align: 'left' },
    ],
    attributes: [
      { tag: 'TAG', prompt: 'Tag', default: 'DEFAULT', position: local(4.5, 4.4), height: 0.35 * unit, align: 'left', color: 0, style: 'GPU-STROKE' },
      { tag: 'NATIVE', prompt: '', default: 'FIT', position: local(4.5, 4), alignmentPoint: local(6.5, 4), justification: { horizontal: 5, vertical: 0 }, height: 0.3 * unit, align: 'left', widthFactor: 1.2, oblique: 0.1 },
      { tag: 'INVISIBLE', prompt: '', default: 'INVISIBLE', position: local(4, 5), height: unit, align: 'left', invisible: true },
      { tag: 'HIDDEN', prompt: '', default: 'HIDDEN', position: local(4, 5), height: unit, align: 'left' },
    ],
  };
  const complex: BlockDef = {
    name: 'GPU-COMPLEX', basePoint: local(4, 5), attributes: [],
    entities: [
      { ...common, id: 'complex-wire', type: 'line', color: 0, a: local(4, 5), b: local(7, 5), lineWeight: 8 },
      { ...common, id: 'nested-owner', type: 'insert', block: nested.name, position: local(4.5, 5.4), rotation: 0.28, scale: 1, attributes: {}, color: 0 },
    ],
  };
  const entities: Entity[] = [
    { ...common, id: 'ORDER-BEFORE', type: 'line', trueColor: 0xee3344, a: p(-3, 0), b: p(3, 0), lineWeight: 2.5 },
    { ...common, id: 'BLOCK-OWNER', type: 'insert', block: ordered.name, position: p(0, 0), rotation: 0, scale: 1, attributes: { TAG: 'ATTR' }, hiddenAttributes: ['HIDDEN'], trueColor: 0x22aaff, lineWeight: 1,
      attributePlacements: { NATIVE: { position: local(4.5, 4), alignmentPoint: local(6.5, 4), firstAlignmentPoint: local(4.5, 4), justification: { horizontal: 5, vertical: 0 }, height: 0.3 * unit, align: 'left', widthFactor: 1.2, oblique: 0.1 } } },
    { ...common, id: 'NESTED-OWNER', type: 'insert', block: complex.name, position: p(-5, -2), rotation: 0.22, scale: 1, attributes: {}, trueColor: 0xffdd33, lineWeight: 0.5 },
    text('TEXT-CONTROLS', 'A%%uB%%oC%%k %%d %%p %%c', -6, 3, { rotation: 0.07, widthFactor: 1.3, oblique: 0.2, trueColor: 0xbb77ee }),
    text('TEXT-FIT', 'FIT TEXT', -6, 2, { alignmentPoint: p(-2, 2.5), firstAlignmentPoint: p(-6, 2), justification: { horizontal: 5, vertical: 0 }, widthFactor: 1.2, oblique: 0.15 }),
    text('TEXT-ALIGNED', 'ALIGN', -6, 1, { alignmentPoint: p(-3, 1.3), firstAlignmentPoint: p(-6, 1), justification: { horizontal: 3, vertical: 0 }, trueColor: 0xeeaacc }),
    text('TEXT-CENTER', 'CENTER', 4, -1.8, { align: 'center', rotation: -0.18, widthFactor: 0.8, trueColor: 0x99ccff }),
    text('TEXT-RIGHT', 'RIGHT', 6, -2.6, { align: 'right', rotation: 0.12, trueColor: 0x77ffaa }),
    text('TEXT-QTEXT', '%%uQTEXT%%k', 3, -3.1, { height: 0.02 * unit, widthFactor: 1.3, rotation: 0.2 }),
    { ...common, id: 'EDGE-L', type: 'line', trueColor: 0x44bb55, a: p(-12, -1), b: p(-7.9, 1), lineWeight: 1 },
    text('EDGE-TEXT', 'CLIP', 8.5, 2.4, { rotation: 0.1 }),
    { ...common, id: 'ORDER-AFTER', type: 'line', trueColor: 0xffaa22, a: p(-1, 0), b: p(1, 0), lineWeight: 2 },
    { ...common, id: 'EDIT-L', type: 'line', trueColor: 0xffffff, a: p(-5, -3), b: p(-2, -3), lineWeight: 0.5 },
  ];
  const blocks: Record<string, BlockDef> = { [nested.name]: nested, [ordered.name]: ordered, [complex.name]: complex };
  const styles = { Standard: STANDARD_TEXT_STYLE, 'GPU-STROKE': { ...STANDARD_TEXT_STYLE, name: 'GPU-STROKE', font: 'romans.shx' }, 'GPU-UNSAFE': { ...STANDARD_TEXT_STYLE, name: 'GPU-UNSAFE', font: 'arial.ttf' } };
  if (name.startsWith('compound-fallback-')) {
    let unsafe: Entity = { ...common, id: 'late-ttf', type: 'text', position: local(0, 0), text: 'TTF', height: 0.5 * unit, rotation: 0, align: 'left', style: 'GPU-UNSAFE' };
    if (name.endsWith('-mtext')) unsafe = { ...common, id: 'late-mtext', type: 'mtext', position: local(0, 0), text: 'MTEXT\nLATE', height: 0.5 * unit, width: 3 * unit, rotation: 0, attachment: 1, lineSpacing: 1 };
    if (name.endsWith('-dash')) unsafe = { ...common, id: 'late-dash', type: 'line', a: local(-1, 0), b: local(1, 0), linetype: 'DASHED' };
    if (name.endsWith('-alpha')) unsafe = { ...common, id: 'late-alpha', type: 'line', a: local(-1, 0), b: local(1, 0), transparency: 128 };
    if (name.endsWith('-geometry')) unsafe = { ...common, id: 'late-fill', type: 'polyline', points: [local(-1, 0), local(1, 0), local(0, 1)], closed: true, filled: true };
    blocks['GPU-LATE-UNSAFE'] = { name: 'GPU-LATE-UNSAFE', basePoint: local(0, 0), attributes: [], entities: [{ ...common, id: 'late-valid', type: 'line', a: local(-1, -1), b: local(1, -1) }, unsafe] };
    entities.push({ ...common, id: 'LATE-OWNER', type: 'insert', block: 'GPU-LATE-UNSAFE', position: p(4, 0), rotation: 0.1, scale: 1, attributes: {} });
  }
  return {
    state: { ...base, entities, blocks, layers: [...base.layers, { name: 'GPU-HIDDEN', color: 1, visible: false, locked: false, lineWeight: 0.5 }], meta: { textStyles: styles }, header: { ...DEFAULT_HEADER, linetypes: [{ name: 'DASHED', description: 'Native benchmark dashed refusal', pattern: [0.5 * unit, -0.25 * unit] }] } },
    center, scale: 64 / unit, twist: 0,
    metadata: { name, block: ordered.name, textStyle: 'GPU-STROKE', nearOriginReference: far ? 'compound-trillion-reference' : undefined, probes: [{ label: 'later top-level line covers block', point: p(0, 0), rgb: [255, 170, 34] }, { label: 'ByBlock truecolor and root width', point: p(0, 0.5), rgb: [34, 170, 255] }, { label: 'earlier line remains outside later stroke', point: p(2.5, 0), rgb: [238, 51, 68] }] },
  };
}

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
  let fixtureMetadata: FixtureMetadata | null = null;
  const indicator = document.createElement('button');
  indicator.dataset.gpuPrototype = 'indicator';
  indicator.textContent = 'Experimental: Canvas 2D';
  indicator.title = 'Toggle experimental GPU / Canvas renderer. Unsupported views use Canvas automatically.';
  Object.assign(indicator.style, { position: 'absolute', left: '12px', top: '12px', zIndex: '3', background: '#26384a', color: '#fff', padding: '6px', border: '1px solid #6a7c8a' });
  view.canvas.parentElement!.append(indicator);
  let demoHandle: ReturnType<typeof mountGpuDemo> | null = null;
  setDiagnosticRenderer(() => mode === 'gpu' && last.rendered && renderer?.device.state === 'ready' ? 'WebGL2 drawing base scene + Canvas 2D editing overlays (experimental)' : 'Canvas 2D');
  const setMode = (next: 'canvas' | 'gpu') => {
    // Mode toggles retry admission, while retaining any valid prepared/uploaded
    // scene so Canvas reference comparisons do not force an unrelated rebuild.
    if (mode !== next) renderer?.clearRefusalCache();
    mode = next;
    editor.render();
  };
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
      fixtureMetadata = null;
      const base = bigDrawing(name === 'dense-lines' ? 38000 : 5000, name === 'mixed-schematic' ? 1000 : 0, name === 'mixed-schematic' ? 500 : 0);
      if (name === 'arc-full-huge' || name === 'arc-sweep-fallback' || name === 'arc-angle-fallback') {
        const startAngle = name === 'arc-full-huge' ? 1e20 : name === 'arc-angle-fallback' ? 1e12 : 0;
        const endAngle = name === 'arc-full-huge' ? startAngle : name === 'arc-angle-fallback' ? startAngle + Math.PI / 2 : 5 * Math.PI / 2;
        const style = { layer: '0', color: 7 };
        editor.loadState({ ...base, entities: [
          { ...style, id: 'L', type: 'line', trueColor: 0xffffff, a: { x: -3, y: -3 }, b: { x: 3, y: -3 } },
          { ...style, id: 'A', type: 'arc', trueColor: 0x22cc66, center: { x: 0, y: 0 }, radius: 2, startAngle, endAngle },
        ] }, null);
        view.center = { x: 0, y: 0 }; view.scale = 64; view.twist = 0;
        fixtureMetadata = { name, probes: [] };
      } else if (name === 'compound-dense') {
        editor.loadState(denseCompoundFixture(), null);
        fixtureMetadata = { name, block: 'GPU-DENSE-SYM', probes: [] };
      } else if (name.startsWith('compound-')) {
        const fixture = compoundFixture(name);
        editor.loadState(fixture.state, null);
        view.center = fixture.center; view.scale = fixture.scale; view.twist = fixture.twist;
        fixtureMetadata = fixture.metadata;
      } else if (name === 'precision-trillion') {
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
      lineweightDisplay.enabled = name === 'lineweights' || name === 'wide-curve-fallback' || (name.startsWith('compound-') && name !== 'compound-dense');
      lineweightDisplay.pxPerMm = undefined;
      editor.viewport.settings.gridVisible = false;
      editor.viewport.renderCurrent();
    },
    fixtureMetadata: () => fixtureMetadata,
    status: () => ({ mode, ...last, device: renderer?.device.state ?? 'not-created', capabilities: renderer?.device.capabilities() ?? null, demo: demoHandle?.status() ?? null }),
    renderStats: () => ({ ...last }),
    renderNow: () => { editor.viewport.renderCurrent(); return { ...last }; },
    completed: () => renderer?.device.completed() ?? Promise.resolve(null),
    loseContext: () => { lossControl = renderer?.device.gl.getExtension('WEBGL_lose_context') ?? null; lossControl?.loseContext(); },
    restoreContext: () => lossControl?.restoreContext(),
    dispose: () => { demoHandle?.dispose(); demoHandle = null; if (mode !== 'canvas') renderer?.clearRefusalCache(); mode = 'canvas'; renderer?.dispose(); renderer = null; canvas.style.display = 'none'; view.experimentalSceneRenderer = null; canvas.remove(); indicator.remove(); editor.render(); },
  } });
}
