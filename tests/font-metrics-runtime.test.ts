import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { entityBounds, type TextEntity } from '../src/core/entities';
import { spatialIndexFor, spatialIndexSettings } from '../src/core/spatial-index';
import { metricTextPlacement, type NativeFontMetrics } from '../src/core/text-metrics';
import { FontMetricsRegistry, createTextGeometryContext, fontMetrics, nativeFontMetricsProblem } from '../src/render/font-metrics';
import { capturedPlotLookup } from '../src/app/plot-fonts';
import { drawStyledText, setTextStyles, fontStack, fontWeight, textRenderer, type TextCanvas } from '../src/render/hershey';
import { renderPageToCanvas } from '../src/render/layouts';
import { drawingContext, type PdfPageSpec } from '../src/io/pdf-vector';
import { STANDARD_TEXT_STYLE, type TextStyle } from '../src/io/encoding';

// Independently authored rectangular glyph metrics, never copied font programs.
function font(family = 'TestFace'): NativeFontMetrics {
  const cmap = Array<number>(65536).fill(0); cmap[65] = 1; cmap[66] = 2; cmap[103] = 3; cmap[32] = 4; cmap[0xd8] = 5;
  return { family, subfamily: 'Regular', unitsPerEm: 1000, capitalHeight: 700, fsType: 0, winDescent: 200, bold: false, italic: false,
    fontBounds: [-50, -200, 800, 700], advances: [600, 600, 500, 450, 250, 650],
    glyphBounds: [[0, 0, 500, 700], [-50, 0, 650, 700], [0, 0, 480, 700], [-20, -200, 430, 500], [0, 0, 0, 0], [0, 0, 600, 700]], cmap, groups: [] };
}
const style = (family = 'TestFace'): TextStyle => ({ ...STANDARD_TEXT_STYLE, name: 'FACE', font: 'testface.ttf', family });
const text = (): TextEntity => ({ id: 't', type: 'text', layer: '0', color: 1, text: 'ABg', position: { x: 0, y: 0 }, height: 7, rotation: 0, align: 'left', style: 'FACE' });
const face = (family = 'TestFace') => ({ kind: 'canvas' as const, family, bold: false, italic: false, widthFactor: 1, oblique: 0 });
function setup() {
  const registry = new FontMetricsRegistry();
  const context = createTextGeometryContext({ FACE: style() }, registry), appearance = context.resolve(text());
  expect(appearance.kind).toBe('canvas');
  registry.register(appearance as ReturnType<typeof face>, font());
  return { registry, context, appearance };
}
function canvasRecorder() {
  const calls: Array<{ text: string; x: number; font: string; kerning: string }> = [];
  const values: Record<string, unknown> = { font: '', fontKerning: 'auto', lineWidth: 1 };
  const ctx = new Proxy(values, {
    get: (target, property) => property === 'fillText' ? (value: string, x: number) => calls.push({ text: value, x, font: String(target.font), kerning: String(target.fontKerning) }) : property in target ? target[property as string] : () => {},
    set: (target, property, value) => { target[property as string] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

describe('native font metrics runtime', () => {
  it('uses only valid owned STYLE records, including a legitimate constructor name', () => {
    expect(textRenderer('constructor', {})).toMatchObject({ kind: 'stroke' });
    expect(textRenderer('toString', {})).toMatchObject({ kind: 'stroke' });
    expect(textRenderer('FACE', { broken: { name: 'FACE', font: null } as unknown as TextStyle })).toMatchObject({ kind: 'stroke' });
    expect(textRenderer('constructor', { constructor: { ...style(), name: 'constructor' } })).toMatchObject({ kind: 'canvas' });
  });
  it.each([
    ['arialnbi.ttf', '"Arial Narrow"', true, true], ['consolab.ttf', 'Consolas', true, false],
    ['trebucit.ttf', '"Trebuchet MS"', false, true], ['georgiaz.ttf', 'Georgia', true, true],
    ['comicz.ttf', '"Comic Sans MS"', true, true], ['gothicbi.ttf', '"Century Gothic"', true, true],
    ['palabi.ttf', '"Palatino Linotype"', true, true],
  ] as const)('resolves Windows filename %s to its actual family and face', (filename, family, bold, italic) => {
    expect(fontStack({ font: filename })).toMatch(new RegExp(`^${family}`));
    expect(fontWeight({ font: filename })).toEqual({ bold, italic });
    expect(fontWeight({ font: filename, bold: false, italic: false })).toEqual({ bold: false, italic: false });
  });
  it('uses native A height, unkerned advances, bearings and descenders', () => {
    const { context, appearance } = setup();
    expect(context.fontSize!(7, appearance)).toBe(10);
    expect(context.measure('ABg', 7, appearance)).toEqual({ advance: 15.5, left: -0.5, right: 15.3, ascent: 7, descent: 2 });
    expect(context.advances!('ABg', 7, appearance)).toEqual([6, 5, 4.5]);
    expect(context.advances!('A\u0301', 7, appearance)).toBeNull();
    expect(context.advances!('\u4e00', 7, appearance)).toBeNull();
  });
  it('keeps unverified composite origins on Canvas while known ordinary glyphs use native metrics', () => {
    const registry = new FontMetricsRegistry(), context = createTextGeometryContext({ FACE: style() }, registry);
    const appearance = context.resolve(text());
    registry.register(appearance as ReturnType<typeof face>, { ...font(), glyphBoundsKnown: [true, true, false, true, true, true] });
    expect(context.advances!('A', 7, appearance)).toEqual([6]);
    expect(context.advances!('AB', 7, appearance)).toBeNull();
    expect(nativeFontMetricsProblem({ ...font(), glyphBoundsKnown: [true] })).toMatch(/origin flags/);
  });
  it('preserves whole-run shaping for mapped Hangul Jamo and other contextual scripts', () => {
    const registry = new FontMetricsRegistry(), context = createTextGeometryContext({ FACE: style() }, registry), input = font(), cmap = [...input.cmap];
    for (const code of [0x1100, 0x1161, 0xa960, 0xd7b0, 0x1a20, 0xa980]) cmap[code] = 1;
    const appearance = context.resolve(text()); registry.register(appearance as ReturnType<typeof face>, { ...input, cmap });
    for (const value of ['\u1100\u1161', '\ua960\ud7b0', '\u1a20', '\ua980']) expect(context.advances!(value, 7, appearance)).toBeNull();
    expect(context.advances!('AB', 7, appearance)).toEqual([6, 5]);
  });
  it('retains signed ink distances for glyphs entirely above or below the baseline', () => {
    const registry = new FontMetricsRegistry(), context = createTextGeometryContext({ FACE: style() }, registry);
    const appearance = context.resolve(text()), input = font(), boxes = input.glyphBounds.map((box) => [...box] as [number, number, number, number]);
    boxes[2] = [0, 100, 480, 500]; boxes[3] = [-20, -200, 430, -100];
    registry.register(appearance as ReturnType<typeof face>, { ...input, glyphBounds: boxes });
    expect(context.measure('B', 7, appearance)).toMatchObject({ ascent: 5, descent: -1 });
    expect(context.measure('g', 7, appearance)).toMatchObject({ ascent: -1, descent: 2 });
    expect(context.measure(' ', 7, appearance)).toEqual({ advance: 2.5, left: 0, right: 0, ascent: 0, descent: 0 });
  });
  it('fits the right overhang and centers both native ink bearings consistently', () => {
    const { context } = setup();
    const t = { ...text(), text: 'A', align: 'center' as const };
    expect(metricTextPlacement(t, context).offset).toBe(-3);
    const fitted = metricTextPlacement({ ...t, align: 'left' as const, justification: { horizontal: 5 as const, vertical: 0 as const }, alignmentPoint: { x: 13, y: 0 } }, context);
    expect(fitted.text.widthFactor).toBe(2);
  });
  it('uses face descent for native bottom and actual ink midpoint for special MIDDLE', () => {
    const { context } = setup();
    const t = { ...text(), position: { x: 10, y: 20 } };
    expect(metricTextPlacement({ ...t, justification: { horizontal: 0, vertical: 1 } }, context).text.position).toEqual({ x: 10, y: 22 });
    expect(metricTextPlacement({ ...t, justification: { horizontal: 0, vertical: 2 } }, context).text.position).toEqual({ x: 10, y: 16.5 });
    expect(metricTextPlacement({ ...t, justification: { horizontal: 0, vertical: 3 } }, context).text.position).toEqual({ x: 10, y: 13 });
    expect(metricTextPlacement({ ...t, justification: { horizontal: 4, vertical: 0 } }, context).text.position).toEqual({ x: 10, y: 17.5 });
  });
  it('draws matching per-glyph advances without kerning or ligature substitutions', () => {
    const { context } = setup(), { ctx, calls } = canvasRecorder();
    expect(drawStyledText(ctx as TextCanvas, text(), { scale: 10, toScreen: (p) => p }, 'FACE', context)).toBe(true);
    expect(calls.map((call) => [call.text, call.x])).toEqual([['A', 0], ['B', 60], ['g', 110]]);
    expect(calls.every((call) => call.font.startsWith('100px ') && call.kerning === 'none')).toBe(true);
  });
  it('bounds, selection and warmed indexes follow STYLE-only edits and undo/redo', () => {
    const registry = new FontMetricsRegistry(), styles = { FACE: style() };
    const contexts = new WeakMap<object, ReturnType<typeof createTextGeometryContext>>();
    const provider = (table: Readonly<Record<string, TextStyle>>) => { let context = contexts.get(table); if (!context) { context = createTextGeometryContext(table, registry); contexts.set(table, context); } return context; };
    const doc = new Drawing({ entities: [text()], meta: { textStyles: styles } }, provider);
    registry.register(provider(styles).resolve(text()) as ReturnType<typeof face>, font());
    const oldMin = spatialIndexSettings.minEntities; spatialIndexSettings.minEntities = 0;
    try {
      spatialIndexFor(doc.entities, doc.lookupBlock);
      const first = spatialIndexFor(doc.entities, doc.lookupBlock)!;
      const original = entityBounds(doc.entities[0]!, doc.lookupBlock)!;
      doc.transactDrawing((state) => ({ ...state, meta: { ...state.meta, textStyles: { FACE: { ...style(), widthFactor: 2 } } } }));
      expect(doc.entities[0]).toBe(first.entities[0]);
      const second = spatialIndexFor(doc.entities, doc.lookupBlock)!;
      expect(second).not.toBe(first); expect(second.bounds[0]!.max.x).toBe(original.max.x * 2);
      expect(doc.undo()).toBe(true); expect(entityBounds(doc.entities[0]!, doc.lookupBlock)).toEqual(original);
      expect(doc.redo()).toBe(true); expect(entityBounds(doc.entities[0]!, doc.lookupBlock)!.max.x).toBe(original.max.x * 2);
    } finally { spatialIndexSettings.minEntities = oldMin; }
  });
  it('invalidates warmed metrics when native fonts arrive without changing dirty/history/state', async () => {
    const registry = new FontMetricsRegistry(), context = createTextGeometryContext({ FACE: style() }, registry);
    const doc = new Drawing({ entities: [text()] }, () => context), before = doc.snapshot, history = doc.history();
    const key = context.cacheKey;
    let reads = 0;
    registry.setReader(async () => { reads += 1; return font(); });
    context.resolve(text()); context.resolve(text());
    await registry.ready();
    expect(reads).toBe(1); expect(context.cacheKey).not.toBe(key);
    expect(doc.snapshot).toBe(before); expect(doc.history()).toEqual(history); expect(doc.dirty).toBe(false);
    expect(entityBounds(doc.entities[0]!, doc.lookupBlock)!.min.y).toBe(-2);
  });
  it('rejects mismatched and malformed native data before registration', () => {
    expect(nativeFontMetricsProblem({ ...font(), capitalHeight: 0 })).toMatch(/height/);
    expect(nativeFontMetricsProblem({ ...font(), advances: [Infinity] })).toMatch(/glyph count|advance/);
    expect(nativeFontMetricsProblem({ ...font(), groups: [[0x10000, 0x10005, 1]] })).toMatch(/Unicode font range/);
    const registry = new FontMetricsRegistry();
    expect(() => registry.register(face('WrongFace'), font())).toThrow(/does not match/);
    expect(() => registry.register(face(), { ...font(), cmap: [1] })).toThrow(/character map/);
    expect(nativeFontMetricsProblem({ ...font(), glyphBoundsKnown: [true, false, true, true, true, true] })).toMatch(/capital A/);
  });
  it('isolates registered metrics from later caller mutation without stale cache keys', () => {
    const registry = new FontMetricsRegistry(), input = font(), context = createTextGeometryContext({ FACE: style() }, registry);
    const appearance = context.resolve(text()); registry.register(appearance as ReturnType<typeof face>, input);
    const key = context.cacheKey, before = context.measure('ABg', 7, appearance);
    expect(before.advance).toBe(15.5);
    (input.advances as number[])[1] = 1000;
    (input.glyphBounds[1] as unknown as number[])[2] = 1000;
    (input.cmap as number[])[65] = 0;
    expect(context.cacheKey).toBe(key); expect(context.measure('ABg', 7, appearance)).toEqual(before);
  });
  it.each(['advances', 'glyphBounds', 'cmap', 'fontBounds', 'glyphBoundsKnown', 'groups'] as const)('rejects sparse %s before geometry can consume it', (field) => {
    const input = { ...font(), glyphBoundsKnown: [true, true, true, true, true, true], groups: [[0x10000, 0x10000, 1] as [number, number, number]] };
    const array = [...input[field]]; delete array[0];
    expect(nativeFontMetricsProblem({ ...input, [field]: array })).not.toBeNull();
    const registry = new FontMetricsRegistry(); expect(() => registry.register(face(), { ...input, [field]: array })).toThrow();
  });
  it('rejects sparse nested glyph/range tuples', () => {
    const box = [0, 0, 500, 700]; delete box[0];
    const group = [0x10000, 0x10000, 1]; delete group[0];
    expect(nativeFontMetricsProblem({ ...font(), glyphBounds: [box as [number, number, number, number], ...font().glyphBounds.slice(1)] })).not.toBeNull();
    expect(nativeFontMetricsProblem({ ...font(), groups: [group as [number, number, number]] })).not.toBeNull();
  });
  it('ignores stale reader completion and retries through the current reader', async () => {
    const registry = new FontMetricsRegistry(), context = createTextGeometryContext({ FACE: style() }, registry);
    let finish!: (value: NativeFontMetrics) => void;
    registry.setReader(() => new Promise((resolve) => { finish = resolve; }));
    context.resolve(text());
    let reads = 0;
    registry.setReader(async () => { reads += 1; return font(); });
    context.resolve(text()); expect(reads).toBe(0);
    finish({ ...font(), capitalHeight: 350 }); await registry.ready();
    context.resolve(text()); await registry.ready();
    expect(reads).toBe(1); expect(context.fontSize!(7, context.resolve(text()))).toBe(10);
  });
  it('raster plots use the captured drawing styles instead of the last viewport registry', () => {
    const doc = new Drawing({ entities: [text()], meta: { textStyles: { FACE: style() } } });
    const page: PdfPageSpec = { label: 'test', width: 100, height: 100, groups: [{ entities: doc.entities, k: 10, e: 0, f: 0, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] };
    const { ctx, calls } = canvasRecorder();
    const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
    setTextStyles({ FACE: style('OtherFace') });
    try { renderPageToCanvas(canvas, page, drawingContext(doc.snapshot, doc.lookupBlock), { mode: 'color', lineweights: true, usePlotStyles: false }, 72); }
    finally { setTextStyles({}); }
    expect(calls).toHaveLength(1); expect(calls[0]!.font).toContain('TestFace');
    expect(doc.dirty).toBe(false);
  });
  it('awaits installed and formatted bold fonts while retaining a pending plot snapshot', async () => {
    const originalBlock = { name: 'b', basePoint: { x: 0, y: 0 }, entities: [text()], attributes: [] };
    const m = { id: 'm', type: 'mtext' as const, layer: '0', color: 1 as const, text: 'A', raw: '{\\fTestFace|b1;A}', style: 'FACE', position: { x: 0, y: 0 }, height: 7, width: 20, rotation: 0, attachment: 1 as const, lineSpacing: 1 };
    const doc = new Drawing({ entities: [m], blocks: { b: originalBlock }, meta: { textStyles: { FACE: style() } } });
    const snapshot = doc.snapshot, requests: boolean[] = [];
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    fontMetrics.setReader(async (request) => { requests.push(!!request.bold); await barrier; return { ...font(), bold: !!request.bold }; });
    try {
      const waiting = capturedPlotLookup(snapshot);
      doc.transactDrawing((state) => ({ ...state, blocks: {}, meta: { textStyles: { FACE: style('OtherFace') } } }));
      release(); const lookup = await waiting;
      expect(requests).toEqual([false, true]); expect(lookup('b')).toBe(snapshot.blocks.b);
      expect(lookup.textGeometry!.resolve(text())).toMatchObject({ kind: 'canvas', family: expect.stringMatching(/^TestFace,/) });
      expect(lookup.textGeometry!.fontSize!(7, lookup.textGeometry!.resolve({ style: 'FACE', bold: true }))).toBe(10);
      expect(doc.snapshot.meta?.textStyles).not.toBe(snapshot.meta?.textStyles);
    } finally { fontMetrics.setReader(undefined); }
  });
});
