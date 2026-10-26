/**
 * P20 #58 review P2(2) — source-local layers in the real painter and plot
 * paths (design A.2, carried into live/layout/plot expansion).
 *
 * Installing only the wrapped block lookup left layer visibility and
 * colour at HOST-document values in drawEntity: with host-layers.dxf
 * (host DUP off) over child-layers.dxf (child DUP on, colour 3;
 * CHILDONLY red), the painter dropped the child's DUP line and drew
 * CHILDONLY in the host fallback colour. These pins run the production
 * surfaces — drawEntity as the viewport loop drives it, and the vector
 * PDF writer (plotPages -> drawingContext -> vectorPdf) as the captured
 * plot drives it — through the context's expansion lookup, whose defs
 * carry per-file provenance (sourceFileKeyForDef + fileLayers), and
 * assert the child's own records govern the child's content while the
 * host's records govern the host's, in both directions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPathPlatform } from '../src/app/paths';
import { readDxf } from '../src/io/dxf';
import { Drawing, type DrawingState } from '../src/core/document';
import type { BlockLookup, Entity, LineEntity } from '../src/core/entities';
import {
  stageXrefLoad,
  type XrefFileReader,
  type XrefReadResult,
  type XrefSnapshot,
} from '../src/io/xref-loading';
import { buildResolvedXrefContext, type ResolvedXrefContext, type XrefSessionStamp } from '../src/app/xref-resolved';
import { drawEntity, resolveColor } from '../src/render/draw';
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

interface Loaded { snapshot: XrefSnapshot; hostState: DrawingState; ctx: ResolvedXrefContext; expansion: BlockLookup }

async function loadWith(hostName: string, hostPath: string, files: Map<string, string>): Promise<Loaded> {
  const hostState = readDxf(fixture(hostName));
  const outcome = await stageXrefLoad({ hostState, hostPath }, { reader: fakeReader(files) });
  const snapshot = outcome.snapshot!;
  const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
  const base = new Drawing(hostState).lookupBlock;
  return { snapshot, hostState, ctx, expansion: ctx.expansionLookup(base) };
}

// ---- recording canvas (the cad-appearance pattern, extended to capture
// the stroke style and path of every stroked primitive) -----------------
interface StrokeRec { style: string; points: { x: number; y: number }[] }

function recordingCanvas(): { ctx: CanvasRenderingContext2D; strokes: StrokeRec[] } {
  const strokes: StrokeRec[] = [];
  let path: { x: number; y: number }[] = [];
  const mock = {
    strokeStyle: '', fillStyle: '', globalAlpha: 1, lineWidth: 1, lineCap: '', lineJoin: '',
    save() {}, restore() {}, beginPath() { path = []; },
    moveTo(x: number, y: number) { path.push({ x, y }); },
    lineTo(x: number, y: number) { path.push({ x, y }); },
    closePath() {}, setLineDash() {}, getLineDash() { return []; },
    stroke() { strokes.push({ style: String(mock.strokeStyle), points: [...path] }); },
    fill() {}, arc() {}, ellipse() {}, rect() {}, clip() {},
  };
  return { ctx: mock as unknown as CanvasRenderingContext2D, strokes };
}

const tf = { scale: 1, rotation: 0, toScreen: (p: { x: number; y: number }) => ({ x: p.x, y: p.y }) };

/** The viewport's model-space loop (viewport.ts): top-level culling by the host hidden set, then drawEntity per entity. */
function drawAll(state: DrawingState, lookup: BlockLookup): StrokeRec[] {
  const { ctx, strokes } = recordingCanvas();
  const hidden = new Set(state.layers.filter((l) => !l.visible).map((l) => l.name));
  for (const e of state.entities) {
    if (hidden.has(e.layer)) continue;
    drawEntity(ctx, e, tf, state.layers, lookup, { hidden });
  }
  return strokes;
}

const lineAt = (strokes: StrokeRec[], y: number): StrokeRec | undefined =>
  strokes.find((s) => s.points.length === 2 && s.points[0]!.y === y && s.points[1]!.y === y);
const lines = (entities: readonly Entity[]): LineEntity[] => entities.filter((e): e is LineEntity => e.type === 'line');

beforeAll(() => setPathPlatform('posix'));
afterAll(() => setPathPlatform(null));

describe('source-local layers in the painter (P2(2))', () => {
  it('L1: child content on a layer the host has OFF still draws — the child record governs; the host line on that layer stays hidden', async () => {
    const files = new Map<string, string>([['/proj/child-layers.dxf', fixture('child-layers.dxf')]]);
    const { hostState, expansion } = await loadWith('host-layers.dxf', '/proj/host-layers.dxf', files);
    const strokes = drawAll(hostState, expansion);
    // The child's DUP line (y=0) is drawn even though the host's DUP is off.
    expect(lineAt(strokes, 0)).toBeTruthy();
    // The child's layer-0 line (y=20) is drawn.
    expect(lineAt(strokes, 20)).toBeTruthy();
    // The host's own DUP line (y=60) stays hidden by the host record.
    expect(lineAt(strokes, 60)).toBeUndefined();
  });

  it('L2: a child-only layer takes the child colour, not the host fallback', async () => {
    const files = new Map<string, string>([['/proj/child-layers.dxf', fixture('child-layers.dxf')]]);
    const { hostState, ctx, expansion, snapshot } = await loadWith('host-layers.dxf', '/proj/host-layers.dxf', files);
    const strokes = drawAll(hostState, expansion);
    const childOnly = lineAt(strokes, 40);
    expect(childOnly).toBeTruthy();
    const childKey = ctx.nodeFor('LX')!.fileKey!;
    const childLine = lines(snapshot.files[childKey]!.state.entities).find((l) => l.layer === 'CHILDONLY')!;
    // Resolved against the CHILD's table (colour 1, red)...
    expect(childOnly!.style).toBe(resolveColor(childLine, ctx.fileLayers(childKey)));
    // ...not against the host's table, which has no CHILDONLY at all.
    expect(childOnly!.style).not.toBe(resolveColor(childLine, hostState.layers));
    expect(ctx.fileLayers(childKey).find((l) => l.name === 'CHILDONLY')!.color).toBe(1);
  });

  it('L3: a layer OFF in the child culls child content even when the host has it ON; host content on it still draws', async () => {
    const files = new Map<string, string>([['/proj/child-layers-off.dxf', fixture('child-layers-off.dxf')]]);
    const { hostState, expansion } = await loadWith('host-layers2.dxf', '/proj/host-layers2.dxf', files);
    const strokes = drawAll(hostState, expansion);
    expect(lineAt(strokes, 0)).toBeTruthy(); // child DUP (on in child)
    expect(lineAt(strokes, 40)).toBeTruthy(); // child CHILDONLY
    // The child's CHILDOFF line (y=80) is culled by the CHILD record,
    // even though the host's CHILDOFF is on...
    expect(lineAt(strokes, 80)).toBeUndefined();
    // ...while the host's own CHILDOFF line (y=100) draws.
    expect(lineAt(strokes, 100)).toBeTruthy();
    // And the host's DUP line (y=60) still stays hidden.
    expect(lineAt(strokes, 60)).toBeUndefined();
  });

  it('L4: the vector plot path honours the same source-local layers', async () => {
    const files = new Map<string, string>([['/proj/child-layers.dxf', fixture('child-layers.dxf')]]);
    const { hostState, expansion } = await loadWith('host-layers.dxf', '/proj/host-layers.dxf', files);
    const pages = plotPages(hostState, expansion, 'model', { paper: 'letter', orientation: 'landscape', scale: 'fit', margin: 0.25 });
    expect(pages).toHaveLength(1);
    // The colour plot style (the plot dialog's colour mode): the default
    // monochrome style would mask the colour half of this pin.
    const bytes = vectorPdf(pages, drawingContext(hostState, expansion), { mode: 'color', lineweights: true, usePlotStyles: true });
    const content = new TextDecoder().decode(bytes);
    // The child's DUP line plots with the CHILD's colour (ACI 3 green) —
    // through the host table it was culled outright by the host's DUP-off.
    expect(content).toContain('0 1 0 RG');
    // CHILDONLY plots with the child's ACI 1 red — through the host table
    // it fell back to the default colour (plotted black, 0 0 0).
    expect(content).toContain('1 0 0 RG');
  });
});
