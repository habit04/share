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
import { glyphFor } from '../render/hershey';

interface FixtureMetadata {
  name: string;
  probes: readonly { label: string; point: Point; rgb: readonly number[] }[];
  nearOriginReference?: string;
  block?: string;
  textStyle?: string;
  highlightProbes?: readonly { owner: string; label: string; point: Point; rgb: readonly number[]; region: readonly Point[] }[];
  curveConstructionReference?: { origin: Point; unit: number; localCenter: Point; roundedWorldCenter: Point; radius: number };
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

/** Source/math counterexamples: absolute Canvas addition collapses tiny edges. */
function collapsedWorldFixture(name: string): { state: DrawingState; metadata: FixtureMetadata; center: Point } {
  const base = bigDrawing(0, 0, 0), center = { x: 1e12, y: 1e12 };
  const p = (x: number, y: number): Point => ({ x: center.x + x, y: center.y + y });
  const common = { layer: '0', color: 7, lineWeight: 1 } as const;
  const entities: Entity[] = [{ ...common, id: 'COLLAPSE-EDIT', type: 'line', a: p(-30, -20), b: p(-10, -20) }];
  const blocks: Record<string, BlockDef> = {};
  if (name === 'collapse-polyline-fallback') {
    blocks['GPU-COLLAPSED-POLYLINE'] = { name: 'GPU-COLLAPSED-POLYLINE', basePoint: { x: 0, y: 0 }, attributes: [], entities: [{ ...common, id: 'collapsed-child', type: 'polyline', points: [{ x: -1e-5, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }], closed: false }] };
    entities.push({ ...common, id: 'COLLAPSE-OWNER', type: 'insert', block: 'GPU-COLLAPSED-POLYLINE', position: center, rotation: 0, scale: 1, attributes: {} });
  } else if (name === 'collapse-text-fallback') {
    entities.push({ ...common, id: 'COLLAPSE-TEXT', type: 'text', text: 'J', position: center, height: 21, widthFactor: 1e-6, rotation: 0, align: 'left' });
  } else {
    blocks['GPU-COLLAPSED-ATTRIB'] = { name: 'GPU-COLLAPSED-ATTRIB', basePoint: { x: 0, y: 0 }, entities: [], attributes: [{ tag: 'NARROW', prompt: '', default: 'J', position: { x: 0, y: 0 }, height: 21, widthFactor: 1e-6, align: 'left' }] };
    entities.push({ ...common, id: 'COLLAPSE-OWNER', type: 'insert', block: 'GPU-COLLAPSED-ATTRIB', position: center, rotation: 0, scale: 1, attributes: { NARROW: 'J' } });
  }
  return { state: { ...base, entities, blocks }, center, metadata: { name, probes: name === 'collapse-polyline-fallback' ? [{ label: 'Canvas collapsed edge has no below-cap miter spur', point: p(1, -1), rgb: [33, 40, 48] }] : [] } };
}

/** Preserve the native Canvas negative-bulge arc's implicit A-to-B connector. */
function negativeBulgeFixture(name: string): { state: DrawingState; metadata: FixtureMetadata } {
  const base = bigDrawing(0, 0, 0), common = { layer: '0', color: 7 } as const;
  const polyline: Entity = { ...common, id: 'NEGATIVE-BULGE', type: 'polyline', points: [{ x: -2, y: 0 }, { x: 2, y: 0 }], bulges: [-0.5], closed: false, trueColor: 0x22cc66 };
  const entities: Entity[] = [{ ...common, id: 'NEGATIVE-EDIT', type: 'line', a: { x: -3, y: -3 }, b: { x: 3, y: -3 } }];
  const blocks: Record<string, BlockDef> = {};
  if (name === 'negative-bulge-compound-fallback') {
    blocks['GPU-NEGATIVE-BULGE'] = { name: 'GPU-NEGATIVE-BULGE', basePoint: { x: 0, y: 0 }, attributes: [], entities: [polyline] };
    entities.push({ ...common, id: 'NEGATIVE-OWNER', type: 'insert', block: 'GPU-NEGATIVE-BULGE', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} });
  } else entities.push(polyline);
  return { state: { ...base, entities, blocks }, metadata: { name, probes: [{ label: 'Actual Canvas implicit A-to-B connector midpoint', point: { x: 0, y: 0 }, rgb: [34, 204, 102] }] } };
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
      { ...common, id: 'ordered-alpha-cross', type: 'text', trueColor: 0xffcc44, position: local(5.5, 6.3), text: 'X', height: 0.8 * unit, rotation: 0, align: 'left', style: 'GPU-STROKE' },
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
      attributePlacements: { NATIVE: { position: local(4.25, 3.5), alignmentPoint: local(7, 3.5), firstAlignmentPoint: local(4.25, 3.5), justification: { horizontal: 5, vertical: 0 }, height: 0.5 * unit, align: 'left', widthFactor: 1.5, oblique: Math.PI / 6 } } },
    { ...common, id: 'NESTED-OWNER', type: 'insert', block: complex.name, position: p(-5, -2), rotation: 0.22, scale: 1, attributes: {}, trueColor: 0xffdd33, lineWeight: 0.5 },
    text('TEXT-CONTROLS', 'A%%uB%%oC%%k %%d %%p %%c', -6, 3, { rotation: 0.07, widthFactor: 1.3, oblique: 0.2, trueColor: 0xbb77ee }),
    text('TEXT-ALPHA-CROSS', 'X', 4, 1.2, { height: 0.8 * unit, trueColor: 0xffcc44, lineWeight: 1 }),
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
  // Derive the intersection from the public-domain font data independently of
  // the GPU mesh. Both X subpaths overlap here, well away from insertion grips.
  const xGlyph = glyphFor('X');
  const a = xGlyph?.strokes[0]?.[0], b = xGlyph?.strokes[0]?.[1], c = xGlyph?.strokes[1]?.[0], d = xGlyph?.strokes[1]?.[1];
  if (!xGlyph || !a || !b || !c || !d || xGlyph.strokes.length !== 2 || xGlyph.strokes.some((stroke) => stroke.length !== 2)) throw new Error('Alpha probe requires the two straight native Hershey X strokes');
  const ux = b[0] - a[0], uy = b[1] - a[1], vx = d[0] - c[0], vy = d[1] - c[1];
  const t = ((c[0] - a[0]) * vy - (c[1] - a[1]) * vx) / (ux * vy - uy * vx);
  const crossing = { x: a[0] + t * ux, y: a[1] + t * uy };
  const highlightProbes = [{ owner: 'TEXT-ALPHA-CROSS', x: 4, y: 1.2 }, { owner: 'BLOCK-OWNER', x: 1.5, y: 1.3 }].map(({ owner, x, y }) => ({ owner, label: `${owner} crossing composites both glyph subpaths once`, point: p(x + crossing.x * 0.8, y + crossing.y * 0.8), rgb: [255, 204, 68], region: [p(x + 0.15, y + 0.15), p(x + 0.6, y + 0.65)] }));
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
    metadata: { name, block: ordered.name, textStyle: 'GPU-STROKE', highlightProbes, nearOriginReference: far ? 'compound-trillion-reference' : undefined, probes: [{ label: 'later top-level line covers block', point: p(0, 0), rgb: [255, 170, 34] }, { label: 'ByBlock truecolor and root width', point: p(0, 0.5), rgb: [34, 170, 255] }, { label: 'earlier line remains outside later stroke', point: p(2.5, 0), rgb: [238, 51, 68] }] },
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
      if (name === 'positive-bulge-precision-fallback') {
        const origin = { x: 1e12, y: 1e12 }, unit = 2 ** -13, common = { layer: '0', color: 7 } as const;
        const p = (x: number, y: number): Point => ({ x: origin.x + x * unit, y: origin.y + y * unit });
        editor.loadState({ ...base, entities: [
          { ...common, id: 'POSITIVE-EDIT', type: 'line', a: p(-12, -10), b: p(-8, -10) },
          { ...common, id: 'POSITIVE-BULGE', type: 'polyline', points: [p(-2, 0), p(2, 0)], bulges: [0.5], closed: false, trueColor: 0x22cc66 },
        ] }, null);
        view.center = origin; view.scale = 16384; view.twist = 0;
        fixtureMetadata = { name, probes: [], curveConstructionReference: { origin, unit, localCenter: { x: 0, y: 1.5 * unit }, roundedWorldCenter: { x: origin.x, y: origin.y + 1.5 * unit }, radius: 2.5 * unit } };
      } else if (name.startsWith('negative-bulge-')) {
        const fixture = negativeBulgeFixture(name);
        editor.loadState(fixture.state, null);
        view.center = { x: 0, y: 0 }; view.scale = 64; view.twist = 0;
        fixtureMetadata = fixture.metadata;
      } else if (name.startsWith('collapse-')) {
        const fixture = collapsedWorldFixture(name);
        editor.loadState(fixture.state, null);
        view.center = fixture.center; view.scale = 1; view.twist = 0;
        fixtureMetadata = fixture.metadata;
      } else if (name === 'arc-full-huge' || name === 'arc-sweep-fallback' || name === 'arc-angle-fallback') {
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
      lineweightDisplay.enabled = name === 'lineweights' || name === 'wide-curve-fallback' || name.startsWith('collapse-') || (name.startsWith('compound-') && name !== 'compound-dense');
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
