import { describe, it, expect } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, HatchEntity, InsertEntity, TextEntity, BlockDef } from '../src/core/entities';
import { defaultLayout, paperFor, type Layout } from '../src/core/layouts';
import {
  vectorPdf,
  vectorPdfCompressed,
  plotPages,
  modelPageSpec,
  drawingContext,
  dashPattern,
  mmToPt,
  plotColor,
  isWinAnsi,
  type PdfPlotStyle,
} from '../src/io/pdf-vector';
import type { PlotOptions } from '../src/app/plot';
import { parsePdfBasics, pageContents, parseContentStream, pageFonts } from './helpers/pdf';

const TABLOID_LANDSCAPE: PlotOptions = { paper: 'tabloid', orientation: 'landscape', scale: 'fit', margin: 0.5 };
const COLOR: PdfPlotStyle = { mode: 'color', lineweights: true, usePlotStyles: true };
const MONO: PdfPlotStyle = { mode: 'monochrome', lineweights: true, usePlotStyles: true };

const base = { layer: '0', color: 'ByLayer' as const };
const BLOCK: BlockDef = {
  name: 'BYBLK',
  basePoint: { x: 0, y: 0 },
  entities: [{ id: 'b1', layer: '0', color: 0, type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }],
  attributes: [],
};

function sampleState(): DrawingState {
  const hatchSolid: HatchEntity = { id: 'h1', ...base, color: 3, type: 'hatch', pattern: 'SOLID', solid: true, angle: 0, scale: 1, loops: [{ points: [{ x: 12, y: 1 }, { x: 15, y: 1 }, { x: 15, y: 3 }, { x: 12, y: 3 }], closed: true } as never] };
  const hatchLines: HatchEntity = { id: 'h2', ...base, type: 'hatch', pattern: 'ANSI31', solid: false, angle: 0, scale: 1, loops: [{ points: [{ x: 12, y: 4 }, { x: 15, y: 4 }, { x: 15, y: 6 }, { x: 12, y: 6 }], closed: true } as never] };
  const ins: InsertEntity = { id: 'i1', ...base, color: 5, type: 'insert', block: 'BYBLK', position: { x: 2, y: 7 }, rotation: 0, scale: 2, attributes: {} };
  const entities: Entity[] = [
    { id: 'l1', ...base, color: 1, type: 'line', a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, lineWeight: 0.25 },
    { id: 'l2', ...base, layer: 'DASH', type: 'line', a: { x: 0, y: 2 }, b: { x: 10, y: 2 } },
    { id: 'c1', ...base, type: 'circle', center: { x: 5, y: 5 }, radius: 2 },
    { id: 'a1', ...base, type: 'arc', center: { x: 5, y: 5 }, radius: 3, startAngle: 0, endAngle: Math.PI / 2 },
    { id: 'e1', ...base, type: 'ellipse', center: { x: 8, y: 8 }, majorAxis: { x: 1.5, y: 0 }, ratio: 0.5, startParam: 0, endParam: Math.PI * 2 },
    { id: 'p1', ...base, type: 'polyline', points: [{ x: 0, y: 9 }, { x: 3, y: 9 }, { x: 3, y: 10 }], bulges: [0.5, 0], closed: false },
    { id: 't1', ...base, type: 'text', position: { x: 0, y: 11 }, text: 'STROKED 1', height: 0.25, rotation: 0, align: 'left' },
    { id: 't2', ...base, type: 'text', position: { x: 6, y: 11 }, text: 'Helvetica (A)', height: 0.25, rotation: 0, align: 'left', style: 'ARIAL' } as TextEntity,
    { id: 't3', ...base, type: 'text', position: { x: 6, y: 12 }, text: 'Ω ohms', height: 0.25, rotation: 0, align: 'left', style: 'ARIAL' } as TextEntity,
    hatchSolid,
    hatchLines,
    ins,
    { id: 'hid', ...base, layer: 'HIDDEN_LAYER', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } },
    { id: 'np', ...base, layer: 'NOPLOT', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } },
  ];
  const d = new Drawing({
    entities,
    blocks: { BYBLK: BLOCK },
    layers: [
      { name: '0', color: 7, visible: true, locked: false, lineWeight: 0.5 },
      { name: 'DASH', color: 2, visible: true, locked: false, lineWeight: 0.35, linetype: 'DASHED' },
      { name: 'HIDDEN_LAYER', color: 1, visible: false, locked: false, lineWeight: 0.25 },
      { name: 'NOPLOT', color: 1, visible: true, locked: false, lineWeight: 0.25, plot: false },
    ],
    meta: { textStyles: { ARIAL: { name: 'ARIAL', font: 'arial.ttf', bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 } } },
  });
  return d.snapshot;
}

function plot(state: DrawingState, style: PdfPlotStyle, what: string = 'model', opts: PlotOptions = TABLOID_LANDSCAPE) {
  const lookup = (n: string) => state.blocks[n];
  const pages = plotPages(state, lookup, what, opts);
  const bytes = vectorPdf(pages, drawingContext(state, lookup), style, 'Test');
  const info = parsePdfBasics(bytes);
  const contents = pageContents(info, (b) => new Uint8Array(inflateSync(b)));
  return { bytes, info, pages: contents.map(parseContentStream) };
}

describe('vector PDF plot of model space', () => {
  const state = sampleState();
  const { bytes, info, pages } = plot(state, COLOR);
  const c = pages[0]!;

  it('is a sound single-page PDF with the tabloid landscape page size', () => {
    expect(info.errors).toEqual([]);
    expect(info.pages).toHaveLength(1);
    expect(info.pages[0]!.width).toBe(1224);
    expect(info.pages[0]!.height).toBe(792);
    expect(c.errors).toEqual([]);
    if (process.env.JCAD_PDF_OUT) writeFileSync(process.env.JCAD_PDF_OUT, bytes);
  });
  it('draws paths: lines (m/l/S), Bezier curves for circles / arcs / ellipses / bulges, filled hatch, stroked hatch lines', () => {
    expect(c.counts.m).toBeGreaterThan(10);
    expect(c.counts.l).toBeGreaterThan(10);
    expect(c.counts.c).toBeGreaterThanOrEqual(4 + 1 + 4 + 1); // circle, quarter arc, ellipse, bulge arc
    expect(c.counts['f*']).toBe(1);
    expect(c.counts.S).toBeGreaterThan(5);
    expect(c.pathOps).toBeGreaterThan(50);
    // Hidden and no-plot layers are left out: nothing is drawn from (0,0) to (1,1) in drawing units.
    expect(c.ops.filter((o) => o.op === 'l').length).toBeGreaterThan(0);
  });
  it('uses Helvetica for TrueType styles when the text is WinAnsi and strokes otherwise', () => {
    expect(c.counts.BT).toBe(1);
    expect(c.texts).toEqual(['Helvetica (A)']);
    expect(c.fonts).toEqual(['F1']);
    expect(pageFonts(info, info.pages[0]!.num)).toEqual({ F1: 'Helvetica' });
    expect(isWinAnsi('Ω ohms')).toBe(false);
    expect(isWinAnsi('Größe 50°')).toBe(true);
  });
  it('resolves colours: ACI 7 black, ByLayer, ByBlock from the insert, true colours', () => {
    expect(c.strokeColors).toContain('1 0 0'); // ACI 1 line
    expect(c.strokeColors).toContain('0 0 0'); // ACI 7 plots black
    expect(c.strokeColors).toContain('1 1 0'); // DASH layer colour 2
    expect(c.strokeColors).toContain('0 0 1'); // ByBlock line inside the blue insert
    expect(c.fillColors).toContain('0 1 0'); // solid hatch colour 3
  });
  it('maps lineweights to points (0.25 mm = 0.709 pt, layer 0.35 mm, layer 0.5 mm)', () => {
    expect(mmToPt(0.25)).toBeCloseTo(0.7087, 4);
    expect(c.widths).toContain(0.709);
    expect(c.widths).toContain(0.992);
    expect(c.widths).toContain(1.417);
  });
  it('plots dashed linetypes with the d operator, scaled by LTSCALE', () => {
    const dashed = c.dashes.filter((d) => d !== '[]');
    expect(dashed.length).toBe(1);
    const k = modelPageSpec(state, (n) => state.blocks[n], TABLOID_LANDSCAPE)!.page.groups[0]!.k;
    const [on, off] = dashed[0]!.slice(1, -1).split(' ').map(Number);
    expect(on).toBeCloseTo(0.5 * k, 2);
    expect(off).toBeCloseTo(0.25 * k, 2);
    const doubled = plot({ ...state, header: { ...new Drawing().header, ltscale: 2 } }, COLOR).pages[0]!;
    const [on2] = doubled.dashes.filter((d) => d !== '[]')[0]!.slice(1, -1).split(' ').map(Number);
    expect(on2).toBeCloseTo(on! * 2, 2);
    expect(dashPattern([0.5, -0.25, 0, -0.25], 10)).toEqual([5, 2.5, 0, 2.5]);
    expect(dashPattern([0.001, -0.001], 1)).toEqual([]);
  });
  it('monochrome plots every colour black; grayscale and screening transform colours', () => {
    const mono = plot(state, MONO).pages[0]!;
    expect(mono.strokeColors).toEqual(['0 0 0']);
    expect(mono.fillColors).toEqual(['0 0 0']);
    expect(plotColor([1, 0, 0], { mode: 'grayscale', lineweights: true, usePlotStyles: true })).toEqual([0.299, 0.299, 0.299]);
    expect(plotColor([0, 0, 0], { mode: 'screening', screening: 25, lineweights: true, usePlotStyles: true })).toEqual([0.75, 0.75, 0.75]);
    expect(plotColor([1, 0, 0], { mode: 'monochrome', lineweights: true, usePlotStyles: false })).toEqual([1, 0, 0]);
  });
  it('lineweights off plots the thinnest lines', () => {
    const thin = plot(state, { ...MONO, lineweights: false }).pages[0]!;
    expect(thin.widths.every((w) => w === 0 || w >= 1)).toBe(true);
    expect(thin.widths).toContain(0);
    expect(thin.widths).not.toContain(0.709);
  });
  it('Flate-compressed content streams decode to the same operators', async () => {
    const lookup = (n: string) => state.blocks[n];
    const packed = await vectorPdfCompressed(plotPages(state, lookup, 'model', TABLOID_LANDSCAPE), drawingContext(state, lookup), COLOR, 'Test', (b) => new Uint8Array(deflateSync(b)));
    const info2 = parsePdfBasics(packed);
    expect(info2.errors).toEqual([]);
    expect(packed.length).toBeLessThan(bytes.length);
    const c2 = parseContentStream(pageContents(info2, (b) => new Uint8Array(inflateSync(b)))[0]!);
    expect(c2.counts).toEqual(c.counts);
  });
  it('embeds images as XObjects clipped to their boundary', () => {
    const img: Entity = { id: 'im', ...base, type: 'image', path: 'logo.png', position: { x: 0, y: 0 }, u: { x: 0.01, y: 0 }, v: { x: 0, y: 0.01 }, size: { x: 4, y: 2 } };
    const s = { ...state, entities: [...state.entities, img] };
    const lookup = (n: string) => s.blocks[n];
    const rgb = new Uint8Array(4 * 2 * 3).fill(128);
    const bytes2 = vectorPdf(plotPages(s, lookup, 'model', TABLOID_LANDSCAPE), drawingContext(s, lookup, () => ({ width: 4, height: 2, data: new Uint8Array(deflateSync(rgb)), kind: 'rgb', deflated: true })), COLOR);
    const info2 = parsePdfBasics(bytes2);
    expect(info2.errors).toEqual([]);
    expect(info2.images).toHaveLength(1);
    expect(info2.images[0]).toMatchObject({ width: 4, height: 2, filters: ['FlateDecode'] });
    const c2 = parseContentStream(pageContents(info2, (b) => new Uint8Array(inflateSync(b)))[0]!);
    expect(c2.counts.Do).toBe(1);
    expect(c2.counts.W).toBeGreaterThanOrEqual(1);
    expect(c2.counts.cm).toBe(1);
  });
});

describe('vector PDF plot of layouts', () => {
  const model = sampleState();
  const sheet: Layout = {
    ...defaultLayout('Sheet1'),
    pristine: undefined,
    plotStyle: 'monochrome',
    entities: [{ id: 'pt', ...base, type: 'text', position: { x: 1, y: 1 }, text: 'PAPER', height: 0.2, rotation: 0, align: 'left' }],
    viewports: [
      { id: 'v1', center: { x: 5, y: 5 }, width: 8, height: 8, view: { center: { x: 5, y: 5 }, scale: 0.5 }, layer: 'VPORTS', on: true },
      { id: 'v2', center: { x: 13, y: 5 }, width: 6, height: 6, view: { center: { x: 5, y: 5 }, scale: 0.25 }, layer: 'VPORTS', on: true, frozenLayers: ['DASH'] },
    ],
  };
  const a3: Layout = { ...defaultLayout('A3', 'mm'), pristine: undefined, paper: paperFor('a3', 'portrait'), entities: [{ id: 'q', ...base, type: 'line', a: { x: 10, y: 10 }, b: { x: 100, y: 10 } }], viewports: [] };
  const state: DrawingState = { ...model, layers: [...model.layers, { name: 'VPORTS', color: 8, visible: true, locked: false, lineWeight: 0.25, plot: false }], layouts: [sheet, a3] };

  it('writes one page per layout with each paper size (all layouts)', () => {
    const { info, pages } = plot(state, MONO, 'layouts');
    expect(info.errors).toEqual([]);
    expect(info.pages.map((p) => [p.width, p.height])).toEqual([
      [1224, 792],
      [841.89, 1190.551],
    ]);
    for (const p of pages) expect(p.errors).toEqual([]);
  });
  it('clips each viewport and draws model space at its scale; frames on a no-plot layer are left out', () => {
    const { pages } = plot(state, MONO, 'Sheet1');
    const c = pages[0]!;
    // Two viewport clips (re W n) and no frame rectangles (re S) because VPORTS does not plot.
    expect(c.counts.re).toBe(2);
    expect(c.counts.W).toBe(2);
    expect(c.counts.n).toBe(2);
    expect(c.strokeColors).toEqual(['0 0 0']);
    // The frozen DASH layer is plotted in viewport 1 only: one dash array.
    expect(c.dashes.filter((d) => d !== '[]')).toHaveLength(1);
    // Linetype dashes use paper units in viewports (PSLTSCALE 1): 0.5 paper inch = 36 pt.
    expect(c.dashes.find((d) => d !== '[]')).toBe('[36 18]');
  });
  it('plots frames when their layer plots', () => {
    const s2: DrawingState = { ...state, layers: state.layers.map((l) => (l.name === 'VPORTS' ? { ...l, plot: true } : l)) };
    const c = plot(s2, MONO, 'Sheet1').pages[0]!;
    expect(c.counts.re).toBe(4);
  });
});
