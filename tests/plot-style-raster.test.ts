import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { expandInsert, explodeInsert, type AttributeDef, type BlockDef, type Entity, type EntityBase, type HatchEntity, type InsertEntity, type Layer, type LeaderEntity, type MTextEntity, type TextEntity } from '../src/core/entities';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import { annotationDisplay, colorDisplay, drawEntity, lineweightDisplay, renderSettings } from '../src/render/draw';
import { renderPageToCanvas } from '../src/render/layouts';
import { plotObjectProperties } from '../src/render/plot-appearance';
import { readPlotStyleTable } from '../src/io/plot-styles';
import { drawingContext, type PdfPageSpec, type PdfPlotStyle } from '../src/io/pdf-vector';
import { STANDARD_TEXT_STYLE } from '../src/io/encoding';
import { plotStyleProgram, plotStyleText } from './helpers/plot-style-fixture';

const layers: readonly Layer[] = [
  { name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'RED', color: 1, visible: true, locked: false, lineWeight: 0.25 },
  { name: 'BLUE', color: 5, visible: true, locked: false, lineWeight: 0.4 },
  { name: 'RGB', color: 1, trueColor: 0xff0000, visible: true, locked: false, lineWeight: 0.6 },
];
const point = { x: 0, y: 0 };
const line = (extra: Partial<EntityBase> = {}): Entity => ({ id: 'line', type: 'line', layer: 'RED', color: 'ByLayer', a: point, b: { x: 5, y: 0 }, ...extra });
const insert = (block: string, extra: Partial<InsertEntity> = {}): InsertEntity => ({ id: 'insert', type: 'insert', block, layer: 'RED', color: 'ByLayer', position: point, rotation: 0, scale: 1, attributes: {}, ...extra });
const block = (name: string, entities: readonly Entity[]): BlockDef => ({ name, basePoint: point, attributes: [], entities });
const table = (kind: 'ctb' | 'stb' = 'ctb') => readPlotStyleTable(plotStyleProgram(plotStyleText({ kind, weights: [0, 0.7, 0.35], entries: kind === 'ctb' ? {
  0: { mode_color: String(0xc2008000 | 0), color_policy: '5', lineweight: '2' },
  2: { mode_color: String(0xc2ff00ff | 0), color_policy: '5' },
  4: { mode_color: String(0xc2ff8000 | 0), color_policy: '5', lineweight: '3' },
} : { 1: { mode_color: String(0xc2008000 | 0), color_policy: '5', lineweight: '2' } } }), kind));

type Paint = { kind: string; color: unknown; width: number; alpha: number; dash: number[] };
function canvasRecorder(throwAt?: string) {
  const state: Record<string, unknown> = { strokeStyle: '#abcdef', fillStyle: '#abcdef', lineWidth: 1, globalAlpha: 1, font: '', fontKerning: 'auto', dash: [] };
  const saved: Record<string, unknown>[] = [], paints: Paint[] = [], stops: Array<readonly [number, string]> = [];
  const paint = (kind: string, fill: boolean) => {
    if (throwAt === kind) throw new Error(`Injected ${kind} failure`);
    paints.push({ kind, color: state[fill ? 'fillStyle' : 'strokeStyle'], width: Number(state.lineWidth), alpha: Number(state.globalAlpha), dash: [...state.dash as number[]] });
  };
  const api: Record<string, unknown> = {
    save: () => saved.push({ ...state, dash: [...state.dash as number[]] }),
    restore: () => { const previous = saved.pop(); if (previous) Object.assign(state, previous); },
    setLineDash: (dash: number[]) => { state.dash = [...dash]; }, getLineDash: () => state.dash,
    stroke: () => paint('stroke', false), strokeRect: () => paint('strokeRect', false),
    fill: () => paint('fill', true), fillRect: () => paint('fillRect', true), fillText: () => paint('fillText', true),
    measureText: (text: string) => ({ width: text.length * 5, actualBoundingBoxLeft: 0, actualBoundingBoxRight: text.length * 5, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 }),
    createLinearGradient: () => {
      if (throwAt === 'gradient') throw new Error('Injected gradient failure');
      return { addColorStop: (offset: number, color: string) => stops.push([offset, color]) };
    },
  };
  const ctx = new Proxy(state, { get: (target, key) => api[String(key)] ?? target[String(key)] ?? (() => {}), set: (target, key, value) => { target[String(key)] = value; return true; } }) as unknown as CanvasRenderingContext2D;
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  return { ctx, canvas, state, saved, paints, stops };
}
function scene(entities: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}) {
  const doc = new Drawing({ entities, blocks, layers });
  const page: PdfPageSpec = { label: 'Author plot', width: 200, height: 100, groups: [{ entities: doc.snapshot.entities, k: 1, e: 0, f: 0, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] };
  return { doc, page, ctx: drawingContext(doc.snapshot, doc.lookupBlock) };
}
function style(source: Awaited<ReturnType<typeof table>>, extra: Partial<PdfPlotStyle> = {}): PdfPlotStyle {
  return { mode: 'monochrome', usePlotStyles: true, lineweights: true, table: source, issues: new Set(), ...extra };
}
function gradient(): HatchEntity {
  return { id: 'gradient', type: 'hatch', layer: 'RED', color: 1, solid: true, pattern: 'SOLID', angle: 0, scale: 1,
    loops: [{ points: [point, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }] }],
    gradient: { name: 'LINEAR', angle: 0, shift: 0, singleColor: false, tint: 0.5, colors: [{ position: 0, color: 1 }, { position: 1, color: 5, trueColor: 0x0000ff }] } };
}
const painted = (r: ReturnType<typeof canvasRecorder>) => r.paints.filter((paint) => paint.kind !== 'fillRect');

describe('captured CTB/STB raster plotting', () => {
  it('uses effective ACI slots and physical mm widths while explicit/inherited TrueColor bypass CTB', async () => {
    const s = scene([line(), line({ id: 'blue', color: 5 }), line({ id: 'rgb', trueColor: 0xff0000 }), line({ id: 'layer-rgb', layer: 'RGB' })]);
    const before = JSON.stringify(s.doc.snapshot), r = canvasRecorder();
    renderPageToCanvas(r.canvas, s.page, s.ctx, style(await table()), 254);
    expect(painted(r).map((paint) => [paint.color, paint.width])).toEqual([['#008000', 7], ['#ff8000', 3.5], ['#ff0000', 2.5], ['#ff0000', 6]]);
    expect(JSON.stringify(s.doc.snapshot)).toBe(before);
    expect(s.doc.dirty).toBe(false);
    expect(r.saved).toHaveLength(0);
  });

  it('honours disabled table styles/lineweights and explicit named STB selection', async () => {
    const s = scene([line()]);
    for (const [settings, expected] of [[{ usePlotStyles: false }, ['#ff0000', 2.5]], [{ lineweights: false }, ['#008000', 1]]] as const) {
      const r = canvasRecorder(); renderPageToCanvas(r.canvas, s.page, s.ctx, style(await table(), settings), 254);
      expect(painted(r).map((paint) => [paint.color, paint.width])).toEqual([expected]);
    }
    const source = await table('stb');
    for (const [namedStyle, color] of [[undefined, '#ff0000'], ['Style_1', '#008000']] as const) {
      const r = canvasRecorder(); renderPageToCanvas(r.canvas, s.page, s.ctx, style(source, { namedStyle }), 254);
      expect(painted(r)[0]?.color).toBe(color);
    }
  });

  it('styles block children independently and retains unplotted nested ByBlock widths', async () => {
    const leaf = block('LEAF', [line({ id: 'leaf', layer: '0', color: 3, lineWeight: -2 })]);
    const parent = block('PARENT', [insert('LEAF', { lineWeight: 0.9 }), line({ id: 'bylayer', layer: 'BLUE' })]);
    const top = insert('PARENT', { lineWeight: 0.18 }), s = scene([top], { LEAF: leaf, PARENT: parent }), r = canvasRecorder();
    renderPageToCanvas(r.canvas, s.page, s.ctx, style(await table()), 254);
    expect(painted(r).map((paint) => [paint.color, paint.width])).toEqual([['#ff00ff', 9], ['#ff8000', 3.5]]);
  });

  it('retains DIMCLRD/CLRE/CLRT colours including ByBlock and independent dimension lineweights', async () => {
    const dimension: Entity = { id: 'dim', type: 'dimension', layer: 'RED', color: 1, lineWeight: 0.2,
      kind: 'linear', p1: point, p2: { x: 10, y: 0 }, linePoint: { x: 0, y: 5 }, rotation: 0,
      style: { ...STANDARD_DIMSTYLE, textHeight: 0.2, arrowSize: 0, dimLineColor: 5, extLineColor: 3, textColor: 0, dimLineWeight: 0.4, extLineWeight: 0.6 } };
    const s = scene([dimension]), r = canvasRecorder();
    renderPageToCanvas(r.canvas, s.page, s.ctx, style(await table()), 254);
    const colors = painted(r).map((paint) => [paint.color, paint.width]);
    expect(colors).toContainEqual(['#ff8000', 3.5]);
    expect(colors).toContainEqual(['#ff00ff', 6]);
    expect(colors).toContainEqual(['#008000', 7]);
  });

  it('keeps formatted MTEXT run colors and a separately layered leader annotation', async () => {
    const text: MTextEntity = { id: 'm', type: 'mtext', layer: 'RED', color: 1, position: point, text: 'RED BLUE RGB', raw: 'RED {\\C5;BLUE} {\\c16711680;RGB}', height: 0.2, width: 0, rotation: 0, attachment: 1, lineSpacing: 1 };
    const leader: LeaderEntity = { id: 'leader', type: 'leader', layer: 'RED', color: 1, vertices: [point, { x: 5, y: 0 }], arrow: false, arrowSize: 0,
      text: 'NOTE', textPosition: { x: 6, y: 0 }, textHeight: 0.2, textLayer: 'BLUE', textAppearance: { color: 'ByLayer' } };
    const s = scene([text, leader]), r = canvasRecorder();
    renderPageToCanvas(r.canvas, s.page, s.ctx, style(await table()), 254);
    const colors = painted(r).map((paint) => paint.color);
    expect(colors).toContain('#008000'); expect(colors).toContain('#ff8000'); expect(colors).toContain('#0000ff');
    expect(colors.at(-1)).toBe('#ff8000');
  });

  it('styles explicit MTEXT masks and viewport frames while keeping paper masks white', async () => {
    const base: MTextEntity = { id: 'mask', type: 'mtext', layer: 'RED', color: 1, position: point, text: 'MASK', height: 0.2, width: 0, rotation: 0, attachment: 1, lineSpacing: 1 };
    const s = scene([{ ...base, background: { flags: 17, scale: 1.5, color: 5 } }, { ...base, id: 'paper', background: { flags: 3, scale: 1.5, color: 5 } }]);
    const page = { ...s.page, groups: [{ ...s.page.groups[0]!, frames: [{ x: 0, y: 0, w: 50, h: 30, layer: 'BLUE' }] }] };
    const r = canvasRecorder(); renderPageToCanvas(r.canvas, page, s.ctx, style(await table()), 254);
    expect(painted(r).filter((paint) => paint.kind === 'fill').map((paint) => paint.color)).toEqual(['#ff8000', '#ffffff']);
    expect(painted(r).find((paint) => paint.kind === 'strokeRect')).toMatchObject({ color: '#ff8000', width: 3.5 });
  });

  it('keeps native gradient colors and explicitly reports unverified table interaction', async () => {
    const s = scene([gradient()]), r = canvasRecorder(), settings = style(await table());
    renderPageToCanvas(r.canvas, s.page, s.ctx, settings, 254);
    expect(r.stops).toEqual([[0, '#ff0000'], [1, '#0000ff']]);
    expect([...settings.issues!]).toContain('Gradient hatch plot-style interpretation is unverified; retained gradient colours and existing fill fallback are used.');
  });

  it('preserves the default Canvas monochrome path when there is no table', () => {
    const s = scene([line({ trueColor: 0xff0000 })]), r = canvasRecorder();
    renderPageToCanvas(r.canvas, s.page, s.ctx, { mode: 'monochrome', usePlotStyles: true, lineweights: true }, 254);
    expect(painted(r)).toMatchObject([{ color: '#000000', width: 2.5 }]);
    const direct = canvasRecorder(); drawEntity(direct.ctx, line({ trueColor: 0xff0000 }), { scale: 1, toScreen: (p) => p }, layers, () => undefined);
    expect(painted(direct)).toMatchObject([{ color: '#ff0000', width: 1 }]);
  });

  it.each(['stroke', 'gradient', 'fillText'])('unwinds Canvas/global context after %s fails', async (failure) => {
    const native: TextEntity = { id: 'text', type: 'text', layer: 'RED', color: 1, text: 'NATIVE', position: point, height: 10, rotation: 0, align: 'left', style: 'FACE' };
    const doc = new Drawing({ entities: [failure === 'gradient' ? gradient() : failure === 'fillText' ? native : line()], layers,
      meta: { textStyles: { FACE: { ...STANDARD_TEXT_STYLE, name: 'FACE', font: 'author.ttf', family: 'Author' } } } });
    const page: PdfPageSpec = { label: 'Error', width: 200, height: 100, groups: [{ entities: doc.snapshot.entities, k: 1, e: 0, f: 0, rotation: 0.3, clip: { x: 0, y: 0, w: 100, h: 100 }, hidden: new Set(), ltUnit: 1, annoFactor: 2 }] };
    const before = { lw: { ...lineweightDisplay }, anno: { ...annotationDisplay }, paper: colorDisplay.paper, ltscale: renderSettings.ltscale, linetypes: renderSettings.linetypes };
    const r = canvasRecorder(failure), settings = style(await table());
    expect(() => renderPageToCanvas(r.canvas, page, drawingContext(doc.snapshot, doc.lookupBlock), settings, 254)).toThrow();
    expect(r.saved).toHaveLength(0);
    expect(r.state.strokeStyle).toBe('#abcdef'); expect(r.state.globalAlpha).toBe(1); expect(r.state.lineWidth).toBe(1);
    expect(lineweightDisplay.enabled).toBe(before.lw.enabled); expect(lineweightDisplay.pxPerMm).toBe(before.lw.pxPerMm);
    expect(annotationDisplay).toEqual(before.anno); expect(colorDisplay.paper).toBe(before.paper);
    expect(renderSettings.ltscale).toBe(before.ltscale); expect(renderSettings.linetypes).toBe(before.linetypes);
    expect(doc.dirty).toBe(false);
  });
});

describe('plot-only INSERT width expansion', () => {
  it('does not contaminate warmed public caches and preserves arrays/sheared geometry', () => {
    const leaf = block('LEAF', [line({ layer: '0', color: 0, lineWeight: -2 })]);
    const middle = block('MIDDLE', [insert('LEAF', { layer: '0', lineWeight: 0.9, rotation: Math.PI / 4 })]);
    const top = insert('MIDDLE', { scale: 2, scaleY: 3, columns: 2, columnSpacing: 7, lineWeight: 0.35 }), doc = new Drawing({ entities: [top], blocks: { LEAF: leaf, MIDDLE: middle }, layers });
    const capturedTop = doc.snapshot.entities[0] as InsertEntity;
    const warmed = explodeInsert(capturedTop, doc.lookupBlock);
    const expansion = expandInsert(capturedTop, doc.lookupBlock, 100, (e) => plotObjectProperties(e, layers).lineweightMm);
    expect(expansion.entities).toHaveLength(2);
    expect(expansion.entities.map((e) => e.lineWeight)).toEqual([0.9, 0.9]);
    const geometry = (entity: Entity) => { const clone = { ...entity }; delete clone.lineWeight; return clone; };
    expect(expansion.entities.map(geometry)).toEqual(warmed.map(geometry));
    expect(explodeInsert(capturedTop, doc.lookupBlock)).toBe(warmed);
    expect(warmed.map((e) => e.lineWeight)).toEqual([-2, -2]);
    expect(top.lineWeight).toBe(0.35); expect(middle.entities[0]?.lineWeight).toBe(0.9); expect(leaf.entities[0]?.lineWeight).toBe(-2);
  });

  it('resolves retained attribute leaf ByBlock widths and still enforces expansion budgets/cycles', () => {
    const attribute = { tag: 'NOTE', prompt: '', default: 'TEXT', position: point, height: 1, align: 'left', layer: '0', color: 0, lineWeight: -2 } as AttributeDef & { lineWeight: number };
    const source = { ...block('SOURCE', [line({ lineWeight: -2 }), insert('SOURCE')]), attributes: [attribute] };
    const top = insert('SOURCE', { lineWeight: 0.8 }), lookup = (name: string) => name === 'SOURCE' ? source : undefined;
    const limited = expandInsert(top, lookup, 1, (e) => plotObjectProperties(e, layers).lineweightMm);
    expect(limited.truncated).toBe(true); expect(limited.entities).toHaveLength(1);
    const full = expandInsert(top, lookup, 100, (e) => plotObjectProperties(e, layers).lineweightMm);
    expect(full.cyclic).toBe(true);
    expect(full.entities.filter((e) => e.type === 'text').map((e) => e.lineWeight)).toEqual([0.8]);
    expect(attribute.lineWeight).toBe(-2);
    expect(() => expandInsert(top, lookup, 100, () => NaN)).toThrow('finite');
  });
});
