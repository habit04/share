/**
 * PR #63 review P2 (D) — nested trace windows must keep the INNERMOST
 * file provenance (tests-first pins).
 *
 * `expandInsertTraced` (src/core/entities.ts) records one trace window per
 * expanded def (post-order: children complete before their parents), then
 * assigns per-entity sources by sorting the windows smallest-first and
 * UNCONDITIONALLY overwriting every index in each window. The enclosing
 * parent window is the largest, so it applies LAST and wins: a nested leaf
 * entity is labelled with its parent file instead of the file that
 * authored it. Layer resolution then consults the wrong file's table —
 * the completed 55ea1a6 review showed a parent DUP layer set OFF hiding a
 * leaf DUP line whose own layer is ON. The function and its dependencies
 * are unchanged at d3472c4, so the finding is open here.
 *
 * Pins (all RED at d3472c4):
 *  D1  existing three-file graph (host -> child -> grand): the
 *      grand-authored line's traced source is the GRAND file key, the
 *      child-authored line's is the CHILD file key.
 *  D2  parent-dup -> leaf-dup graph: the leaf file's two lines carry the
 *      LEAF file key; the parent-authored line carries the PARENT key.
 *  D3  draw-level consequence of D2: the parent file sets DUP OFF and the
 *      leaf file sets DUP ON — the leaf DUP line DRAWS.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPathPlatform } from '../src/app/paths';
import { readDxf } from '../src/io/dxf';
import { Drawing, type DrawingState } from '../src/core/document';
import type { BlockLookup } from '../src/core/entities';
import { expandInsertTraced, type BlockDef, type InsertEntity, type Layer, type LineEntity } from '../src/core/entities';
import {
  stageXrefLoad,
  type XrefFileReader,
  type XrefReadResult,
  type XrefSnapshot,
} from '../src/io/xref-loading';
import { buildResolvedXrefContext, type XrefSessionStamp } from '../src/app/xref-resolved';
import { drawEntity } from '../src/render/draw';

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

function projectFiles(): Map<string, string> {
  return new Map<string, string>([
    ['/proj/parts/child.dxf', fixture('child.dxf')],
    ['/proj/parts/grand.dxf', fixture('grand.dxf')],
    ['/proj/shared/leaf.dxf', fixture('leaf.dxf')],
    ['/proj/drawings/overlay-root.dxf', fixture('overlay-root.dxf')],
    ['/proj/drawings/kid.dxf', fixture('kid.dxf')],
  ]);
}

async function loadProject(hostName: string, hostPath: string) {
  const hostState = readDxf(fixture(hostName));
  const outcome = await stageXrefLoad({ hostState, hostPath }, { reader: fakeReader(projectFiles()) });
  const snapshot = outcome.snapshot!;
  const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
  const base = new Drawing(hostState).lookupBlock;
  return { hostState, snapshot, ctx, expansion: ctx.expansionLookup(base) };
}

beforeAll(() => setPathPlatform('posix'));
afterAll(() => setPathPlatform(null));

/* ---- recording canvas + draw-all loop (xref-draw-layers harness, verbatim idiom) ---- */
interface StrokeRec { style: string; points: { x: number; y: number }[] }

function recordingCanvas(): { ctx: CanvasRenderingContext2D; strokes: StrokeRec[] } {
  const strokes: StrokeRec[] = [];
  let path: { x: number; y: number }[] = [];
  const mock = {
    strokeStyle: '', fillStyle: '', globalAlpha: 1, lineWidth: 1, lineCap: '', lineJoin: '',
    save() { /* no-op */ }, restore() { /* no-op */ }, beginPath() { path = []; },
    moveTo(x: number, y: number) { path.push({ x, y }); },
    lineTo(x: number, y: number) { path.push({ x, y }); },
    closePath() { /* no-op */ }, setLineDash() { /* no-op */ }, getLineDash() { return []; },
    stroke() { strokes.push({ style: String(mock.strokeStyle), points: [...path] }); },
    fill() { /* no-op */ }, arc() { /* no-op */ }, ellipse() { /* no-op */ }, rect() { /* no-op */ }, clip() { /* no-op */ },
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

describe('PR #63 P2 (D): nested trace windows keep the innermost file provenance', () => {
  it('D1: in host -> child -> grand, the traced sources are each file\'s own key', async () => {
    const { hostState, snapshot, expansion } = await loadProject('host.dxf', '/proj/drawings/host.dxf');
    const childKey = snapshot.nodes[0]!.fileKey!;
    const grandKey = snapshot.nodes[0]!.children[0]!.fileKey!;
    const insert = hostState.entities[0] as InsertEntity;
    const traced = expandInsertTraced(insert, expansion).entities;
    const tracedLines = traced.filter((t) => t.entity.type === 'line');
    expect(tracedLines).toHaveLength(2);
    // Child-authored line (0,9)-(8,9) in child space, CHILD insert at (5,5).
    const childLine = tracedLines.find((t) => (t.entity as LineEntity).a.x === 5 && (t.entity as LineEntity).a.y === 14);
    expect(childLine?.source).toBe(childKey);
    // Grand-authored line (1,1)-(4,1), GRAND insert at (2,2) inside the
    // child def: the INNERMOST window owns it — the grand file, not the
    // enclosing child window that completes before it in output order.
    const grandLine = tracedLines.find((t) => (t.entity as LineEntity).a.x === 8 && (t.entity as LineEntity).a.y === 8);
    expect(grandLine?.source).toBe(grandKey);
  });

  async function loadDup() {
    const layer0: Layer = { name: '0', color: 7, visible: true, locked: false, lineWeight: -1 };
    const ins = (id: string, block: string): InsertEntity => ({ id, type: 'insert', layer: '0', color: 'ByLayer', block, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} });
    const pdDef: BlockDef = { name: 'PD', basePoint: { x: 0, y: 0 }, entities: [], attributes: [], xref: { path: 'parent-dup.dxf' } };
    const hostState: DrawingState = {
      entities: [ins('h-pd', 'PD')],
      layers: [layer0],
      blocks: { PD: pdDef },
      currentLayer: '0',
    };
    const files = new Map([
      ['/proj/parent-dup.dxf', fixture('parent-dup.dxf')],
      ['/proj/leaf-dup.dxf', fixture('leaf-dup.dxf')],
    ]);
    const outcome = await stageXrefLoad(
      { references: [{ blockName: 'PD', path: 'parent-dup.dxf' }], hostPath: '/proj/host-dup.dxf' },
      { reader: fakeReader(files) },
    );
    const snapshot: XrefSnapshot = outcome.snapshot!;
    const ctx = buildResolvedXrefContext(snapshot, stamp, hostState);
    const base = new Drawing(hostState).lookupBlock;
    return { hostState, snapshot, expansion: ctx.expansionLookup(base) };
  }

  it('D2: the leaf file\'s lines carry the leaf key, the parent line the parent key', async () => {
    const { hostState, snapshot, expansion } = await loadDup();
    const parentKey = snapshot.nodes[0]!.fileKey!;
    const leafKey = snapshot.nodes[0]!.children[0]!.fileKey!;
    const traced = expandInsertTraced(hostState.entities[0] as InsertEntity, expansion).entities;
    const byY = (y: number) => traced.find((t) => t.entity.type === 'line' && (t.entity as LineEntity).a.y === y);
    expect(byY(30)?.source).toBe(parentKey); // parent-authored control line (layer 0)
    expect(byY(10)?.source).toBe(leafKey);   // leaf-authored line on DUP
    expect(byY(50)?.source).toBe(leafKey);   // leaf-authored line on 0
  });

  it('D3: parent DUP OFF + leaf DUP ON — the leaf DUP line draws', async () => {
    const { hostState, expansion } = await loadDup();
    const strokes = drawAll(hostState, expansion);
    const ys = strokes.filter((s) => s.points.length === 2).map((s) => s.points[0]!.y).sort((a, b) => a - b);
    // y=30 (parent control), y=50 (leaf control) and — the pin — y=10, the
    // leaf DUP line, governed by the LEAF file's table where DUP is ON.
    // Labelled with the parent file (whose DUP is OFF) it is hidden.
    expect(ys).toEqual([10, 30, 50]);
  });
});
