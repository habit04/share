/**
 * PR #63 review P2 (C) — the page-size channel wrapper must preserve the
 * xref lookup channels (tests-first pins).
 *
 * `withUnderlaySizeChannel` (src/core/entities.ts) is the wrapper every
 * captured plot composition applies to add the underlay page-size channel:
 * the raster composition at src/app/editor/plotting.ts and the vector
 * composition at src/app/plot-vector.ts. At d3472c4 the wrapper returned a
 * callable carrying only textGeometry and underlaySizeOf, DISCARDING the
 * captured lookup's forDef and sources channels. Both plot paths then fell
 * back to unsourced expansion: referenced content was culled and styled
 * against the HOST layer table, and a dangling name inside a referenced
 * file could borrow a same-named root xref def. Drawings with no PDF
 * underlays regress the same way — the size channel is installed
 * unconditionally.
 *
 * Pins (all RED at d3472c4):
 *  C0  the wrapper delegates sources and forDef, and a forDef-derived
 *      lookup wrapped by the same helper keeps its channels (nesting).
 *  C1  raster (renderPlotImage): a child ON layer named like a host OFF
 *      layer draws — 3 strokes (2 at base).
 *  C2  raster (renderPlotImage): a dangling child block name does not
 *      borrow the same-named root xref — 3 strokes (5 at base).
 *  C3  vector (plotPages + vectorPdf through the wrapped lookup): the
 *      child DUP line plots in the child's green and the CHILDONLY line
 *      in the child's red (both culled/mis-styled at base).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPathPlatform } from '../src/app/paths';
import { readDxf } from '../src/io/dxf';
import { Drawing, type DrawingState } from '../src/core/document';
import type { BlockDef, InsertEntity, Layer } from '../src/core/entities';
import { withUnderlaySizeChannel, underlaySizeResolver } from '../src/core/entities';
import {
  stageXrefLoad,
  type XrefFileReader,
  type XrefReadResult,
} from '../src/io/xref-loading';
import { buildResolvedXrefContext, type ResolvedXrefContext, type XrefSessionStamp } from '../src/app/xref-resolved';
import { renderPlotImage } from '../src/app/editor/plotting';
import type { CapturedPlot } from '../src/app/export-admission';
import type { Editor } from '../src/app/editor';
import { layoutPage, type PlotOptions } from '../src/app/plot';
import { plotPages, drawingContext, vectorPdf } from '../src/io/pdf-vector';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'xref', name), 'utf8');
const stamp: XrefSessionStamp = { docId: 'doc-1', contentGeneration: 1 };

function fakeReader(files: Map<string, string>): XrefFileReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async readText(resolvedPath: string): Promise<XrefReadResult> {
      calls.push(resolvedPath);
      const text = files.get(resolvedPath);
      if (text === undefined) {
        const error = new Error(`ENOENT: no such file or directory, open '${resolvedPath}'`) as Error & { code?: string };
        error.code = 'ENOENT';
        throw error;
      }
      return text;
    },
  };
}

async function loadWith(hostName: string, hostPath: string, files: Map<string, string>) {
  const hostState = readDxf(fixture(hostName));
  const outcome = await stageXrefLoad({ hostState, hostPath }, { reader: fakeReader(files) });
  const snapshot = outcome.snapshot!;
  const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
  const base = new Drawing(hostState).lookupBlock;
  return { hostState, snapshot, ctx, expansion: ctx.expansionLookup(base) };
}

beforeAll(() => setPathPlatform('posix'));
afterAll(() => setPathPlatform(null));

/* ---- canvas rig: records every stroke() with its path (R1 harness idiom) ---- */
interface StrokeRec { curved: boolean; points: { x: number; y: number }[] }
function stubDocument() {
  const rig = { strokes: [] as StrokeRec[] };
  const makeCanvas = () => {
    let path: { x: number; y: number }[] = [];
    let curved = false;
    const base = {
      globalAlpha: 1, fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '', font: '',
      textAlign: 'left', textBaseline: 'alphabetic',
      measureText: (t: string) => ({ width: t.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
      save() { /* state push not needed for stroke recording */ },
      restore() { /* state pop not needed for stroke recording */ },
      beginPath() { path = []; curved = false; },
      moveTo(x: number, y: number) { path.push({ x, y }); },
      lineTo(x: number, y: number) { path.push({ x, y }); },
      closePath() { /* no-op */ },
      setLineDash() { /* no-op */ },
      getLineDash() { return []; },
      stroke() { rig.strokes.push({ curved, points: [...path] }); },
      fill() { /* no-op */ },
      fillRect() { /* paper background: not a stroke */ },
      arc() { curved = true; },
      ellipse() { curved = true; },
      rect() { /* no-op */ },
      drawImage() { /* no-op */ },
      getImageData: (x: number, y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    };
    const ctx = new Proxy(base, {
      get: (t, p) => (typeof p === 'symbol' ? undefined : Reflect.get(t, p) ?? (() => { /* generic canvas no-op */ })),
    });
    return { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,AAAA' };
  };
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`);
      return makeCanvas();
    },
  });
  return rig;
}

const OPTS: PlotOptions = { paper: 'tabloid', orientation: 'landscape', scale: 'fit', margin: 0.5 };
const ed = { log: () => { /* captured */ } } as unknown as Editor;
const capturedFor = (state: DrawingState, ctx: ResolvedXrefContext): CapturedPlot => ({
  state, base: 'p2c', bridge: null, security: 'none', underlayBytes: async () => new Uint8Array(), xref: ctx,
});
const near = (a: number, b: number) => Math.abs(a - b) <= 2;
const lineStrokes = (strokes: StrokeRec[]) => strokes.filter((s) => !s.curved && s.points.length === 2);

describe('PR #63 P2 (C): the size-channel wrapper preserves the xref lookup channels', () => {
  it('C0: delegates sources and forDef; a forDef-derived lookup keeps its channels when wrapped again', async () => {
    const { hostState, expansion } = await loadWith('host-layers.dxf', '/proj/host-layers.dxf',
      new Map([['/proj/child-layers.dxf', fixture('child-layers.dxf')]]));
    const wrapped = withUnderlaySizeChannel(expansion, underlaySizeResolver(hostState.underlays));
    expect(wrapped.sources).toBe(expansion.sources);
    expect(wrapped.forDef).toBeTypeOf('function');
    expect(wrapped.underlaySizeOf).toBeTypeOf('function');
    // Nesting: scoping into the LX root def through the wrapper yields a
    // lookup that delegates exactly the channels the raw scoped lookup
    // carries (a per-file variant has textGeometry + forDef; sources is a
    // graph-global channel read from the entry lookup by the traced
    // expansion, so the variant neither gains nor loses one here).
    const rootDef = expansion('LX');
    expect(rootDef).toBeTruthy();
    const rawScoped = expansion.forDef!('LX', rootDef!);
    const scoped = wrapped.forDef!('LX', rootDef!);
    expect(scoped).toBeTruthy();
    expect(scoped!.sources).toBe(rawScoped!.sources);
    expect(typeof scoped!.forDef).toBe(typeof rawScoped!.forDef);
    expect(scoped!.forDef).toBeTypeOf('function');
    expect(scoped!.underlaySizeOf).toBeTypeOf('function');
  });

  it('C1 (raster): a child ON layer named like a host OFF layer draws through renderPlotImage — 3 strokes', async () => {
    const { hostState, ctx } = await loadWith('host-layers.dxf', '/proj/host-layers.dxf',
      new Map([['/proj/child-layers.dxf', fixture('child-layers.dxf')]]));
    const rig = stubDocument();
    const img = await renderPlotImage(ed, OPTS, capturedFor(hostState, ctx));
    vi.unstubAllGlobals();
    expect(img).not.toBeNull();
    // The child content bounds are (0,0)-(10,40); the host DUP line (y=60)
    // is on a hidden host layer and never enters the bounds or the sheet.
    const lay = layoutPage(10, 40, OPTS);
    const sheetY = (y: number) => lay.origin.y * 150 + (40 - y) * lay.scale * 150;
    const lines = lineStrokes(rig.strokes);
    expect(lines).toHaveLength(3);
    for (const drawingY of [0, 20, 40]) {
      const hit = lines.find((s) => s.points.every((p) => near(p.y, sheetY(drawingY))));
      expect(hit, `expected a plotted line for drawing y=${drawingY}`).toBeTruthy();
    }
  });

  it('C2 (raster): a dangling child block name does not borrow the same-named root xref — 3 strokes', async () => {
    const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -1 };
    const ins = (id: string, block: string): InsertEntity => ({ id, type: 'insert', layer: '0', color: 'ByLayer', block, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} });
    const dxDef: BlockDef = { name: 'DX', basePoint: { x: 0, y: 0 }, entities: [], attributes: [], xref: { path: 'child-dangling.dxf' } };
    const nosuchDef: BlockDef = { name: 'NOSUCH', basePoint: { x: 0, y: 0 }, entities: [], attributes: [], xref: { path: 'leaf.dxf' } };
    const hostState: DrawingState = {
      entities: [ins('h-dx', 'DX'), ins('h-nosuch', 'NOSUCH')],
      layers: [layer0],
      blocks: { DX: dxDef, NOSUCH: nosuchDef },
      currentLayer: '0',
    };
    const files = new Map([
      ['/proj/child-dangling.dxf', fixture('child-dangling.dxf')],
      ['/proj/leaf.dxf', fixture('leaf.dxf')],
    ]);
    const outcome = await stageXrefLoad(
      { references: [{ blockName: 'DX', path: 'child-dangling.dxf' }, { blockName: 'NOSUCH', path: 'leaf.dxf' }], hostPath: '/proj/host-root-collision.dxf' },
      { reader: fakeReader(files) },
    );
    const ctx = buildResolvedXrefContext(outcome.snapshot!, stamp, hostState);
    const rig = stubDocument();
    const img = await renderPlotImage(ed, OPTS, capturedFor(hostState, ctx));
    vi.unstubAllGlobals();
    expect(img).not.toBeNull();
    // Correct: DX contributes its one real line (the dangling NOSUCH inside
    // it is refused) and the NOSUCH root contributes the leaf line + circle:
    // 2 line strokes + 1 curve stroke. Borrowing the root def inside DX
    // adds the leaf content a second time: 3 lines + 2 curves = 5.
    expect(rig.strokes).toHaveLength(3);
    expect(lineStrokes(rig.strokes)).toHaveLength(2);
    expect(rig.strokes.filter((s) => s.curved)).toHaveLength(1);
  });

  it('C3 (vector): the wrapped lookup plots the child lines in their own file colours', async () => {
    const { hostState, expansion } = await loadWith('host-layers.dxf', '/proj/host-layers.dxf',
      new Map([['/proj/child-layers.dxf', fixture('child-layers.dxf')]]));
    // The exact composition plot-vector.ts applies for the vector path.
    const sized = withUnderlaySizeChannel(expansion, underlaySizeResolver(hostState.underlays));
    const pages = plotPages(hostState, sized, 'model', { paper: 'letter', orientation: 'landscape', scale: 'fit', margin: 0.25 });
    expect(pages).toHaveLength(1);
    const bytes = vectorPdf(pages, drawingContext(hostState, sized), { mode: 'color', lineweights: true, usePlotStyles: true });
    const content = new TextDecoder().decode(bytes);
    // Child DUP (ACI 3, green in the child's table) and CHILDONLY (ACI 1,
    // red). Through the host table the child DUP line is culled outright
    // (host DUP is OFF) and CHILDONLY falls back to black.
    expect(content).toContain('0 1 0 RG');
    expect(content).toContain('1 0 0 RG');
  });
});
