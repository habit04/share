import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { readDxf, writeDxf } from '../src/io/dxf';
import { explodeInsert, inheritedColor, bakeInheritedColor, type Entity, type InsertEntity } from '../src/core/entities';
import { resolveColor, trueColorCss, colorDisplay } from '../src/render/draw';
import { aciToCss } from '../src/render/palette';
import { vectorPdf, plotPages, drawingContext, type PdfPlotStyle } from '../src/io/pdf-vector';
import type { DrawingState } from '../src/core/document';
import { parsePdfBasics, pageContents, parseContentStream } from './helpers/pdf';

// Hand-written fixture: INNER holds  L201 layer 0 ByBlock, L202 layer 0 ByLayer, L203 layer A ByBlock,
// C204 explicit colour 6, L205 layer A ByLayer. OUTER nests INNER three times (layer 0 ByBlock,
// layer A colour 2, layer A ByLayer). Layers: L1 red (1), L2 green (3), A blue (5), TC true colour #123456.
const state = readDxf(readFileSync(join(__dirname, 'fixtures', 'block-colors.dxf'), 'latin1'));
const lookup = (n: string) => state.blocks[n];
const top = (i: number) => state.entities[i] as InsertEntity;
/** Colours of an insert's exploded content, in block order (INNER: 5 objects per nested insert). */
const colors = (ins: InsertEntity): string[] => explodeInsert(ins, lookup).map((e) => resolveColor(e, state.layers));
const RED = aciToCss(1);
const GREEN = aciToCss(3);
const BLUE = aciToCss(5);
const YELLOW = aciToCss(2);
const CYAN = aciToCss(4);
const MAGENTA = aciToCss(6);
const WHITE = aciToCss(7);

describe('block colour inheritance (ByLayer 256 vs ByBlock 0)', () => {
  it('reads ByBlock as 0 and ByLayer as ByLayer', () => {
    const inner = state.blocks.INNER!.entities;
    expect(inner.map((e) => e.color)).toEqual([0, 'ByLayer', 0, 6, 'ByLayer']);
    expect(state.entities.map((e) => e.color)).toEqual(['ByLayer', 4, 1, 0, 'ByLayer']);
  });

  it('ByLayer outer insert: ByBlock content takes the insert layer colour, nested inserts propagate', () => {
    expect(colors(top(0))).toEqual([
      // INNER on layer 0, ByBlock, inside OUTER on L1 ByLayer: everything resolves to L1 except explicit / own-layer objects
      RED, RED, RED, MAGENTA, BLUE,
      // INNER on A, explicit yellow: ByBlock -> yellow, layer-0 ByLayer floats to A (blue)
      YELLOW, BLUE, YELLOW, MAGENTA, BLUE,
      // INNER on A ByLayer: ByBlock -> A's colour
      BLUE, BLUE, BLUE, MAGENTA, BLUE,
    ]);
  });

  it('explicit outer insert colour reaches ByBlock objects only; layer-0 ByLayer objects show the layer colour', () => {
    expect(colors(top(1))).toEqual([
      CYAN, GREEN, CYAN, MAGENTA, BLUE,
      YELLOW, BLUE, YELLOW, MAGENTA, BLUE,
      BLUE, BLUE, BLUE, MAGENTA, BLUE,
    ]);
  });

  it('a true-colour insert passes its RGB to ByBlock objects', () => {
    expect(colors(top(2))).toEqual([trueColorCss(0xabcdef), RED, trueColorCss(0xabcdef), MAGENTA, BLUE]);
  });

  it('ByBlock at the top level shows in the foreground colour', () => {
    expect(colors(top(3))).toEqual([WHITE, GREEN, WHITE, MAGENTA, BLUE]);
    colorDisplay.paper = true;
    try {
      expect(resolveColor(explodeInsert(top(3), lookup)[0]!, state.layers)).toBe('#000000');
    } finally {
      colorDisplay.paper = false;
    }
  });

  it('a true-colour layer colours ByLayer content and ByBlock content of a ByLayer insert', () => {
    expect(colors(top(4))).toEqual([trueColorCss(0x123456), trueColorCss(0x123456), trueColorCss(0x123456), MAGENTA, BLUE]);
  });

  it('keeps the own layer of ByBlock objects for visibility (only the colour comes from the insert layer)', () => {
    const parts = explodeInsert(top(0), lookup);
    expect(parts[2]!.layer).toBe('A');
    expect(parts[2]!.colorLayer).toBe('L1');
    expect(parts[0]!.layer).toBe('L1');
  });

  it('inheritedColor: explicit colours are untouched', () => {
    const ins = { id: 'i', layer: 'L1', color: 3 as const };
    expect(inheritedColor({ id: 'x', layer: '0', color: 5 }, ins)).toEqual({ color: 5 });
    expect(inheritedColor({ id: 'x', layer: '0', color: 5, trueColor: 0x10 }, ins)).toEqual({ color: 5, trueColor: 0x10 });
    expect(inheritedColor({ id: 'x', layer: '0', color: 'ByLayer' }, ins)).toEqual({ color: 'ByLayer' });
    expect(inheritedColor({ id: 'x', layer: '0', color: 0 }, ins)).toEqual({ color: 3 });
    expect(inheritedColor({ id: 'x', layer: '0', color: 0 }, { id: 'i', layer: 'L1', color: 'ByLayer' })).toEqual({ color: 'ByLayer', colorLayer: 'L1' });
    expect(inheritedColor({ id: 'x', layer: '0', color: 0 }, { id: 'i', layer: 'L1', color: 0 })).toEqual({ color: 0 });
  });

  it('EXPLODE bakes the inherited colour (no display-only field is stored)', () => {
    const parts = explodeInsert(top(0), lookup).map((e) => bakeInheritedColor(e, state.layers));
    expect(parts.every((e) => e.colorLayer === undefined)).toBe(true);
    expect(parts[2]!.color).toBe(1);
    expect(parts[2]!.layer).toBe('A');
  });

  it('round-trips the colour codes through the DXF writer (0 and 256 stay distinct)', () => {
    const back = readDxf(writeDxf(state));
    expect(back.blocks.INNER!.entities.map((e) => e.color)).toEqual([0, 'ByLayer', 0, 6, 'ByLayer']);
    expect(back.layers.find((l) => l.name === 'TC')?.trueColor).toBe(0x123456);
    expect(colors(back.entities[1] as InsertEntity)).toEqual(colors(top(1)));
  });
});

describe('block colour inheritance in the vector PDF plot', () => {
  const COLOR: PdfPlotStyle = { mode: 'color', lineweights: true, usePlotStyles: true };
  const plotColors = (entities: Entity[]): string[] => {
    const s: DrawingState = { ...state, entities };
    const lk = (n: string) => s.blocks[n];
    const pages = plotPages(s, lk, 'model', { paper: 'tabloid', orientation: 'landscape', scale: 'fit', margin: 0.5 });
    const bytes = vectorPdf(pages, drawingContext(s, lk), COLOR, 'Test');
    const contents = pageContents(parsePdfBasics(bytes), (b) => new Uint8Array(inflateSync(b)));
    return parseContentStream(contents[0]!).strokeColors;
  };
  it('uses the same resolution: nested ByBlock -> insert colour, layer-0 ByLayer -> insert layer', () => {
    const c = plotColors([top(1)]);
    expect(c).toContain('0 1 1'); // cyan: ByBlock content of the cyan OUTER
    expect(c).toContain('0 1 0'); // green: layer-0 ByLayer content on L2
    expect(c).toContain('1 1 0'); // yellow: ByBlock content of the yellow nested INNER
  });
  it('ByBlock content of a ByLayer insert plots in the insert layer colour', () => {
    const c = plotColors([top(4)]);
    const rgb = [0x12, 0x34, 0x56].map((v) => +(v / 255).toFixed(3));
    expect(c.some((x) => x.split(' ').map(Number).every((v, i) => Math.abs(v - rgb[i]!) < 0.01))).toBe(true);
  });
});
