/**
 * P20 slice 1 — captured-plotting agreement (design section 4 + 5.6).
 *
 * SPEC STATUS: these pins are the P20 specification for the captured-plot
 * wiring owned by the P28 lane (design 6.4): CapturedPlot gains a frozen
 * xref context pinned by stamp at capture time; capturedPlotLookup and
 * capturedPdfLookup wrap it; plotLayoutsOrVector threads the wrapped
 * lookups. They are written against the current signatures plus the
 * captured xref field, and go green when the P28 wiring lands — the
 * expansion agreement they assert is the design's section 4 invariant:
 * editor display, layout raster, model raster and vector PDF expand the
 * SAME synthesised defs through the SAME code under the SAME budget.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setPathPlatform } from '../src/app/paths';
import { readDxf } from '../src/io/dxf';
import type { DrawingState } from '../src/core/document';
import { explodeInsert, type Entity, type InsertEntity, type LineEntity } from '../src/core/entities';
import { capturePlot, type CapturedPlot } from '../src/app/export-admission';
import { capturedPlotLookup } from '../src/app/plot-fonts';
import { capturedPdfLookup } from '../src/app/pdf-fonts';
import { plottableState } from '../src/app/plot-vector';
import { plotPages } from '../src/io/pdf-vector';
import type { Editor as EditorType } from '../src/app/editor';
import type { FileBridge } from '../src/app/editor/types';
import type { ResolvedXrefContext } from '../src/app/xref-resolved';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'xref', name), 'utf8');
const hash = (text: string): string => { let h = 0; for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0; return String(h >>> 0); };
const dirOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));

function makeBridge(files: Map<string, string>): FileBridge {
  const broker = {
    async beginXrefContext() { return { token: 'tok' }; },
    async identifyXref(_token: string, path: string) {
      const text = files.get(path);
      if (text === undefined) throw new Error('ERR_XREF_MISSING: no readable file');
      return { ticket: path, identity: { id: `id:${path}`, owningLocation: dirOf(path), version: `v:${hash(text)}` } };
    },
    async readXref(_token: string, ticket: string) {
      const text = files.get(ticket);
      if (text === undefined) throw new Error('ERR_XREF_MISSING: no readable file');
      return { text, byteLength: Buffer.byteLength(text, 'utf8'), version: `v:${hash(text)}` };
    },
    async cancelXref() { return true; },
    async closeXrefContext() { return true; },
  };
  return broker as unknown as FileBridge;
}

const projectFiles = (): Map<string, string> => new Map<string, string>([
  ['/proj/drawings/host.dxf', fixture('host.dxf')],
  ['/proj/parts/child.dxf', fixture('child.dxf')],
  ['/proj/parts/grand.dxf', fixture('grand.dxf')],
  ['/proj/shared/leaf.dxf', fixture('leaf.dxf')],
  ['/proj/drawings/overlay-root.dxf', fixture('overlay-root.dxf')],
  ['/proj/drawings/kid.dxf', fixture('kid.dxf')],
  ['/proj/host-layers.dxf', fixture('host-layers.dxf')],
  ['/proj/child-layers.dxf', fixture('child-layers.dxf')],
]);

let Editor: typeof EditorType;
beforeAll(async () => {
  setPathPlatform('posix');
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
afterAll(() => setPathPlatform(null));

const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

interface Rig { ed: EditorType; files: Map<string, string>; registry: { controller: (docId: string) => { whenIdle(): Promise<void>; reload(): Promise<unknown>; context(): ResolvedXrefContext | null } | undefined; currentContextFor: (stamp: { docId: string; contentGeneration: number | string }) => ResolvedXrefContext | null }; }

function rig(): Rig {
  const ed = new Editor(canvas());
  const files = projectFiles();
  ed.fileBridge = makeBridge(files);
  const registry = (ed as unknown as { xrefSessions: Rig['registry'] }).xrefSessions;
  return { ed, files, registry };
}

async function openLoaded(ed: EditorType, registry: Rig['registry'], state: DrawingState, path: string): Promise<string> {
  ed.sessions.add(state, path);
  const session = ed.sessions.current;
  await registry.controller(session.docId)!.whenIdle();
  return session.docId;
}

const capturedXref = (captured: CapturedPlot): ResolvedXrefContext | null =>
  (captured as unknown as { xref?: ResolvedXrefContext | null }).xref ?? null;
const lines = (entities: readonly Entity[]): LineEntity[] => entities.filter((e): e is LineEntity => e.type === 'line');
const hostInsert = (state: DrawingState, index = 0): InsertEntity => state.entities.filter((e): e is InsertEntity => e.type === 'insert')[index]!;

describe('captured plotting (P)', () => {
  it('P1: capture pins the generation — a later reload does not change what the captured plot expands', async () => {
    const { ed, files, registry } = rig();
    const docId = await openLoaded(ed, registry, readDxf(fixture('host.dxf')), '/proj/drawings/host.dxf');
    const captured = capturePlot(ed);
    const xref = capturedXref(captured);
    expect(xref).toBeTruthy();
    expect(xref!.stamp).toEqual({ docId, contentGeneration: 1 });
    expect(xref!.generation).toBe(1);
    // Commit generation 2 with different child content.
    files.set('/proj/parts/child.dxf', fixture('child-b.dxf'));
    await registry.controller(docId)!.reload();
    expect(registry.controller(docId)!.context()!.generation).toBe(2);
    // The captured lookup still expands generation 1.
    const lookup = await capturedPlotLookup(captured.state, captured.geometry);
    const expanded = explodeInsert(hostInsert(captured.state, 0), lookup);
    expect(lines(expanded).some((l) => l.a.y === 9 && l.b.y === 9)).toBe(true); // gen-1 child line
    expect(lines(expanded).some((l) => l.a.x === 100)).toBe(false); // gen-2 marker absent
  });

  it('P2: a stamp mismatch refuses the wrap — the other document state expands as placeholders, never with this context', async () => {
    const { ed, registry } = rig();
    await openLoaded(ed, registry, readDxf(fixture('host.dxf')), '/proj/drawings/host.dxf');
    const captured = capturePlot(ed);
    expect(capturedXref(captured)).toBeTruthy();
    const lookup = await capturedPlotLookup(captured.state, captured.geometry);
    // Apply doc A's captured lookup to doc B's state (host-layers, never captured):
    const otherState = readDxf(fixture('host-layers.dxf'));
    const expanded = explodeInsert(hostInsert(otherState, 0), lookup);
    expect(lines(expanded).some((l) => l.layer === 'DUP')).toBe(false); // B's child content must not appear via A's context
  });

  it('P3: agreement — captured raster lookup, captured PDF lookup and the live wrap expand entity-for-entity', async () => {
    const { ed, registry } = rig();
    const docId = await openLoaded(ed, registry, readDxf(fixture('host.dxf')), '/proj/drawings/host.dxf');
    const captured = capturePlot(ed);
    const rasterLookup = await capturedPlotLookup(captured.state, captured.geometry);
    const pdfLookup = await capturedPdfLookup(captured.state, undefined, undefined, rasterLookup);
    const live = registry.currentContextFor({ docId, contentGeneration: 1 })!;
    const liveLookup = live.lookup((n: string) => captured.state.blocks[n]);
    const ins = hostInsert(captured.state, 0);
    const viaRaster = explodeInsert(ins, rasterLookup).map((e) => e.id);
    const viaPdf = explodeInsert(ins, pdfLookup).map((e) => e.id);
    const viaLive = explodeInsert(ins, liveLookup).map((e) => e.id);
    expect(viaRaster.length).toBeGreaterThan(0);
    expect(viaPdf).toEqual(viaRaster);
    expect(viaLive).toEqual(viaRaster);
  });

  it('P4: plottable extents include the loaded content when the captured lookup wraps', async () => {
    const { ed, registry } = rig();
    await openLoaded(ed, registry, readDxf(fixture('host.dxf')), '/proj/drawings/host.dxf');
    const captured = capturePlot(ed);
    const lookup = await capturedPlotLookup(captured.state, captured.geometry);
    const plottable = plottableState(captured.state, lookup);
    const ins = hostInsert(plottable, 0);
    const expanded = explodeInsert(ins, lookup);
    expect(lines(expanded).length).toBeGreaterThan(0);
    const base = plottableState(captured.state, (n: string) => captured.state.blocks[n]);
    expect(base).toBeTruthy();
    // The wrapped plottable state's measured extents cover the child content at (13,14)+.
    const { entityBounds } = await import('../src/core/entities');
    const bounds = entityBounds(ins, lookup)!;
    expect(bounds.max.x).toBeGreaterThanOrEqual(13);
    expect(bounds.max.y).toBeGreaterThanOrEqual(14);
  });

  it('P5: a failed reference plots as the named frame while loaded content plots, in the vector route', async () => {
    const { ed, files, registry } = rig();
    files.delete('/proj/shared/leaf.dxf'); // LEAFWIN will be missing
    // Rebuild the rig bridge over the reduced file set.
    ed.fileBridge = makeBridge(files);
    await openLoaded(ed, registry, readDxf(fixture('host.dxf')), '/proj/drawings/host.dxf');
    const captured = capturePlot(ed);
    const lookup = await capturedPlotLookup(captured.state, captured.geometry);
    const pages = plotPages(captured.state, lookup, 'model', {});
    expect(pages).toHaveLength(1);
    const drawn = pages[0]!.groups.flatMap((g) => (g as { entities?: readonly Entity[] }).entities ?? []);
    expect(drawn.some((e) => e.id.includes(':xf'))).toBe(true); // the placeholder frame is drawn
    expect(lines(drawn).length).toBeGreaterThan(0); // loaded CHILD content is drawn
  });

  it('P6: a background document plots with its own captured context, never the active document one', async () => {
    const { ed, registry } = rig();
    const docA = await openLoaded(ed, registry, readDxf(fixture('host.dxf')), '/proj/drawings/host.dxf');
    // Open B in the background, capture it while active, then return to A.
    const docB = await openLoaded(ed, registry, readDxf(fixture('host-layers.dxf')), '/proj/host-layers.dxf');
    const capturedB = capturePlot(ed);
    expect(capturedXref(capturedB)!.stamp.docId).toBe(docB);
    ed.sessions.switchTo(ed.sessions.indexOfId(ed.sessions.all.find((s) => s.docId === docA)!.id));
    const lookupB = await capturedPlotLookup(capturedB.state, capturedB.geometry);
    const expandedB = explodeInsert(hostInsert(capturedB.state, 0), lookupB);
    expect(lines(expandedB).some((l) => l.layer === 'CHILDONLY')).toBe(true); // B's own child content
    // A's live context knows nothing of B's reference.
    const liveA = registry.currentContextFor({ docId: docA, contentGeneration: 1 })!;
    expect(liveA.nodeFor('LX')).toBeUndefined();
  });
});
