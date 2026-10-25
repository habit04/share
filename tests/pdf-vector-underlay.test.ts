/** Writer-level underlay pins (src/io/pdf-vector.ts) for the #57
 * real-app gate findings D2 and D3.
 *
 * D2: a 2-point (rectangle) clip boundary must reach the vector
 * writer's clip path as the 4 rectangle corners — the same clip
 * expressed as 4 stored points must produce byte-identical output.
 * End-to-end on the in-repo golden whose PDFUNDERLAY carries exactly
 * the 2-point form.
 *
 * D3: the vector writer must frame the image by the LOADED page
 * size when the stored definition carries no extent (AutoCAD-read
 * definitions never do) — the screen path and the resolver's source
 * already substitute it; the writer was the one consumer that did
 * not, so AutoCAD-read files plotted their image in a 1x1-unit
 * frame (the lead's repro: a 2-unit image against a 432-unit
 * screen frame).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity, UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import { readDxf } from '../src/io/dxf';
import { plotPages, vectorPdf, drawingContext, type PdfPlotStyle, type PdfUnderlayImage } from '../src/io/pdf-vector';
import type { PlotOptions } from '../src/app/plot';
import { parsePdfBasics, pageContents } from './helpers/pdf';

const COLOR: PdfPlotStyle = { mode: 'color', lineweights: true, usePlotStyles: true };
const OPTS: PlotOptions = { paper: 'tabloid', orientation: 'landscape', scale: 'fit', margin: 0.5 };

const hitFor = (page: { width: number; height: number }): PdfUnderlayImage => ({
  data: { width: 4, height: 3, data: new Uint8Array(4 * 3 * 3).fill(120), kind: 'rgb' },
  page,
});

function writeUnderlayPdf(state: DrawingState, page: { width: number; height: number }): string {
  const lookup = (n: string) => state.blocks[n];
  const pages = plotPages(state, lookup, 'model', OPTS);
  const bytes = vectorPdf(pages, drawingContext(state, lookup, undefined, () => hitFor(page)), COLOR, 'gate');
  const info = parsePdfBasics(bytes);
  return pageContents(info, (b) => new Uint8Array(inflateSync(b))).join('\n');
}

/** The image clip path (`... m ... l ... h W n`) from a content stream. */
function imageClip(contents: string): string | undefined {
  return contents.match(/[-\d.]+ [-\d.]+ m(?: [-\d.]+ [-\d.]+ l)+ h W n/)?.[0];
}
const clipSegments = (clip: string): number => (clip.match(/ l/g) ?? []).length;

const DEF: UnderlayDefinition = {
  id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'sheet.pdf',
  extent: { width: 200, height: 100 }, retainedGroups: [],
};
const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '41',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});
function handStateDef(e: UnderlayEntity, def: UnderlayDefinition): DrawingState {
  return new Drawing({
    entities: [e],
    blocks: {},
    layers: [{ name: 'U', color: 7, visible: true, locked: false, lineWeight: 0.5 }],
    underlays: { d: def },
  }).snapshot;
}
function handState(e: UnderlayEntity): DrawingState {
  return handStateDef(e, DEF);
}

/** The image placement matrix (`... cm /Im0 Do`) from a content stream. */
function imageMatrix(contents: string): string | undefined {
  return contents.match(/[-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ [-\d.]+ cm \/Im0 Do/)?.[0];
}

describe('D2: the vector writer clips a 2-point rectangle clip as a rectangle', () => {
  it('the emitted clip path has the 4 rectangle corners (3 line segments), not the 2-point diagonal', () => {
    const contents = writeUnderlayPdf(handState(placement({ flags: 3, clipBoundary: [{ x: 10, y: 90 }, { x: 190, y: 10 }] })), { width: 200, height: 100 });
    expect(contents).toContain(' Do'); // the image plots at all
    const clip = imageClip(contents);
    expect(clip).toBeDefined();
    expect(clipSegments(clip!)).toBe(3);
  });

  it('the same clip stored as 4 points produces byte-identical contents', () => {
    const two = writeUnderlayPdf(handState(placement({ flags: 3, clipBoundary: [{ x: 10, y: 90 }, { x: 190, y: 10 }] })), { width: 200, height: 100 });
    const four = writeUnderlayPdf(handState(placement({
      flags: 3,
      clipBoundary: [{ x: 10, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 90 }, { x: 10, y: 90 }],
    })), { width: 200, height: 100 });
    expect(two).toBe(four);
  });

  it('end-to-end on the golden: the acad2027 PDFUNDERLAY (2-point clip) plots its image inside the rectangle clip', () => {
    const text = readFileSync('tests/fixtures/interchange/r2018-pdf-underlay-dict-acad2027.dxf', 'utf8');
    const state = readDxf(text);
    const e = state.entities.find((x) => x.type === 'underlay') as UnderlayEntity;
    expect(e).toBeDefined();
    // The fixture's stored form IS the 2-point rectangle (the lead's repro).
    expect(e.clipBoundary).toHaveLength(2);
    const contents = writeUnderlayPdf(state, { width: 612, height: 792 });
    expect(contents).toContain(' Do');
    const clip = imageClip(contents);
    expect(clip).toBeDefined();
    expect(clipSegments(clip!)).toBe(3);
    // And it renders identically to the same drawing with the clip
    // stored as the 4 rectangle corners (underlay coordinates).
    const [a, b] = e.clipBoundary!;
    const rect = [
      { x: Math.min(a!.x, b!.x), y: Math.min(a!.y, b!.y) },
      { x: Math.max(a!.x, b!.x), y: Math.min(a!.y, b!.y) },
      { x: Math.max(a!.x, b!.x), y: Math.max(a!.y, b!.y) },
      { x: Math.min(a!.x, b!.x), y: Math.max(a!.y, b!.y) },
    ];
    const cloned: DrawingState = {
      ...state,
      entities: state.entities.map((x): Entity => (x.id === e.id ? { ...e, clipBoundary: rect } : x)),
    };
    expect(writeUnderlayPdf(cloned, { width: 612, height: 792 })).toBe(contents);
  });
});

describe('D3: the vector writer frames an extent-less definition by the loaded page size', () => {
  const PAGE = { width: 612, height: 792 };
  const extentLess: UnderlayDefinition = { id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'sheet.pdf', retainedGroups: [] };
  const withExtent: UnderlayDefinition = { ...extentLess, extent: PAGE };

  it('an extent-less def plots the image at the loaded page size — the same matrix as a def storing that extent', () => {
    const fromLoaded = writeUnderlayPdf(handStateDef(placement(), extentLess), PAGE);
    const fromStored = writeUnderlayPdf(handStateDef(placement(), withExtent), PAGE);
    expect(fromLoaded).toContain(' Do');
    expect(imageMatrix(fromLoaded)).toBeDefined();
    expect(imageMatrix(fromLoaded)).toBe(imageMatrix(fromStored));
    expect(fromLoaded).toBe(fromStored); // frame parts agree too — the whole plot is the same
  });

  it('a stored extent still wins over the loaded page size (precedence unchanged)', () => {
    const stored = { width: 200, height: 100 };
    const def = { ...extentLess, extent: stored };
    const hookBig = writeUnderlayPdf(handStateDef(placement(), def), PAGE);
    const hookSame = writeUnderlayPdf(handStateDef(placement(), def), stored);
    expect(imageMatrix(hookBig)).toBeDefined();
    expect(hookBig).toBe(hookSame);
  });
});
