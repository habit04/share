/** Session-owned runtime fonts stay outside immutable drawings and pending plot captures. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { Drawing, type DrawingState } from '../src/core/document';
import { entityBounds, type Entity, type TextEntity } from '../src/core/entities';
import type { TextGeometryContext } from '../src/core/text-metrics';
import { SessionManager, type SessionHost } from '../src/app/sessions';
import { SessionShxResources, registerShxCommand } from '../src/app/shx-resources';
import type { Editor, CommandDef } from '../src/app/editor';
import { capturedPlotLookup } from '../src/app/plot-fonts';
import { capturedPdfLookup } from '../src/app/pdf-fonts';
import { drawingContext, renderPdfPages, type PdfPageSpec } from '../src/io/pdf-vector';
import { textStylesOf, type TextStyle } from '../src/io/encoding';
import { textGeometryForStyles } from '../src/render/font-metrics';
import type { ShxResource } from '../src/render/shx-fonts';
import { fontRecords, shxFixture } from './helpers/shx-fixture';

const style = (font = 'font.shx', widthFactor = 1): TextStyle => ({ name: 'FACE', font, bigFont: '', flags: 0, height: 0, widthFactor, oblique: 0, generation: 0 });
const text = (): TextEntity => ({ type: 'text', id: 'text', layer: '0', color: 'ByLayer', style: 'FACE', text: 'A', position: { x: 0, y: 0 }, rotation: 0, height: 10, align: 'left' });
const line = (): Entity => ({ type: 'line', id: 'edit', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } });
const state = (font = 'font.shx') => new Drawing({ entities: [text()], meta: { textStyles: { FACE: style(font) } } }).snapshot;
function resource(above = 10, resolvedPath = 'C:\\private\\first\\font.shx'): ShxResource {
  const bytes = shxFixture('unifont', [{ ...fontRecords[0]!, program: [above, 2, 2, 0, 0, 0] }, ...fontRecords.slice(1)]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, resolvedPath, sha256, resourceId: JSON.stringify([resolvedPath, sha256]) };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function makeEditor(initial = state()) {
  let sessions!: SessionManager;
  const render = vi.fn(), changed = vi.fn(), logs: string[] = [];
  const shxResources = new SessionShxResources((session) => { changed(session); if (sessions.current === session) render(); });
  const doc = new Drawing(initial, (styles) => sessions ? shxResources.for(sessions.current).geometry(styles) : textGeometryForStyles(styles));
  const host: SessionHost = { doc, viewport: { center: { x: 5, y: 4 }, scale: 80 }, selection: new Set(['text']), loadState(next, filePath) { doc.load(next, filePath); this.selection.clear(); } };
  sessions = new SessionManager(host);
  const choose = vi.fn<() => Promise<ShxResource | null>>(async () => null), commands = new Map<string, CommandDef>();
  const editor = { ...host, sessions, shxResources, render, log: (value: string) => logs.push(value), fileBridge: { platform: 'win32', openShxFont: choose }, register: (command: CommandDef) => commands.set(command.name, command) } as unknown as Editor;
  registerShxCommand(editor);
  const run = async () => { await commands.get('SHXFONT')!.run(editor); };
  const geometry = () => doc.lookupBlock.textGeometry!;
  const runAt = (context: TextGeometryContext) => context.shxRun?.('A', 10, context.resolve({ style: 'FACE' }));
  const advance = () => { const run = runAt(geometry()); return run?.ok ? run.advance : null; };
  const load = (selected: ShxResource) => shxResources.for(sessions.current).load(selected);
  return { editor, host, doc, sessions, shxResources, changed, render, logs, choose, run, geometry, runAt, advance, load, commands };
}
/** Only digest completion is deferred; resources and programs remain authored real data. */
function deferredDigests() {
  const jobs: Array<{ sha256: string; resolve(value: ArrayBuffer): void }> = [];
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (_algorithm, data) => {
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return await new Promise<ArrayBuffer>((resolve) => jobs.push({ sha256, resolve }));
  });
  const started = async (count = 1) => { for (let i = 0; i < 8; i++) await Promise.resolve(); expect(jobs).toHaveLength(count); };
  const finish = (index = 0) => { const job = jobs[index]!; job.resolve(Uint8Array.from(Buffer.from(job.sha256, 'hex')).buffer); };
  return { jobs, started, finish };
}
const plotStyle = { mode: 'color' as const, lineweights: true, usePlotStyles: false };
const page = (drawing: DrawingState): PdfPageSpec => ({ width: 200, height: 150, label: 'Captured', groups: [{ entities: drawing.entities, hidden: new Set(), k: 1, e: 20, f: 30, ltUnit: 1, annoFactor: 1 }] });
afterEach(() => vi.restoreAllMocks());

describe('SHX drawing-session ownership', () => {
  it('keeps identical STYLE basenames in different tabs isolated through the injected Drawing lookup', async () => {
    const f = makeEditor(), first = f.sessions.current;
    await f.load(resource()); expect(f.advance()).toBe(10); expect(entityBounds(f.doc.entities[0]!, f.doc.lookupBlock)!.max.x).toBe(8);
    const firstGeneration = first.contentGeneration;
    f.sessions.add(state(), 'C:\\second\\drawing.dxf'); const second = f.sessions.current;
    expect(f.advance()).toBeNull(); await f.load(resource(20, 'C:\\private\\second\\font.shx'));
    expect(f.advance()).toBe(5); expect(entityBounds(f.doc.entities[0]!, f.doc.lookupBlock)!.max.x).toBe(4);
    f.sessions.switchTo(0); expect(f.advance()).toBe(10); expect(f.sessions.current).toBe(first); expect(first.contentGeneration).toBe(firstGeneration);
    f.sessions.switchTo(1); expect(f.advance()).toBe(5); expect(f.sessions.current).toBe(second);
    expect(f.sessions.all.map((session) => session.dirty)).toEqual([false, false]);
  });

  it('runtime load invalidates cached geometry while snapshot, undo/redo, dirty flag, view and selection stay untouched', async () => {
    const f = makeEditor(); f.doc.addEntities([line()]); f.doc.undo(); f.doc.dirty = false;
    const before = { state: f.doc.snapshot, history: f.doc.history(), revision: f.doc.revision, generation: f.sessions.current.contentGeneration, selection: new Set(f.host.selection), viewport: structuredClone(f.host.viewport) };
    const context = f.geometry(), cache = context.cacheKey;
    expect(f.advance()).toBeNull(); await f.load(resource());
    expect(f.geometry()).toBe(context); expect(context.cacheKey).not.toBe(cache); expect(f.advance()).toBe(10);
    expect(f.doc.snapshot).toBe(before.state); expect(f.doc.history()).toEqual(before.history); expect(f.doc.revision).toBe(before.revision); expect(f.doc.dirty).toBe(false);
    expect(f.sessions.current.contentGeneration).toBe(before.generation); expect(f.host.selection).toEqual(before.selection); expect(f.host.viewport).toEqual(before.viewport);
    expect(JSON.stringify(f.doc.snapshot)).not.toContain('resourceId'); expect(JSON.stringify(f.doc.snapshot)).not.toContain('C:\\\\private'); expect(f.render).toHaveBeenCalledTimes(1);
  });

  it('STYLE edits and undo/redo keep tab resources, restoring the matching filename and effective width', async () => {
    const f = makeEditor(); await f.load(resource()); await f.load(resource(20, 'C:\\private\\second\\other.shx'));
    const generation = f.sessions.current.contentGeneration;
    f.doc.transactDrawing((drawing) => ({ ...drawing, meta: { ...drawing.meta, textStyles: { FACE: style('other.shx', 0.5) } } }));
    expect(f.advance()).toBe(5); expect(entityBounds(f.doc.entities[0]!, f.doc.lookupBlock)!.max.x).toBe(2);
    expect(f.doc.undo()).toBe(true); expect(f.advance()).toBe(10); expect(entityBounds(f.doc.entities[0]!, f.doc.lookupBlock)!.max.x).toBe(8);
    expect(f.doc.redo()).toBe(true); expect(f.advance()).toBe(5); expect(entityBounds(f.doc.entities[0]!, f.doc.lookupBlock)!.max.x).toBe(2);
    expect(f.sessions.current.contentGeneration).toBe(generation); expect(f.doc.dirty).toBe(true);
  });

  it('keeps composed/decomposed basenames distinct when JavaScript lowercase expands a character', async () => {
    const composed = '\u0130.shx', decomposed = 'I\u0307.shx', f = makeEditor(state(composed));
    // Both lowercase to i + combining dot, although NTFS retains two filenames.
    expect(composed.toLowerCase()).toBe(decomposed.toLowerCase());
    await f.load(resource(10, `C:\\private\\first\\${composed}`)); expect(f.advance()).toBe(10);
    await f.load(resource(20, `C:\\private\\second\\${decomposed}`)); expect(f.advance()).toBe(10);
    f.doc.transactDrawing((drawing) => ({ ...drawing, meta: { ...drawing.meta, textStyles: { FACE: style(decomposed) } } })); expect(f.advance()).toBe(5);
    expect(f.doc.undo()).toBe(true); expect(f.advance()).toBe(10);
  });

  it('matches ASCII filename case and requires exact non-ASCII spelling for explicit resources', async () => {
    const f = makeEditor(state('FONT.SHX')); await f.load(resource()); expect(f.advance()).toBe(10);
    await f.load(resource(20, 'C:\\private\\second\\\u00c9.shx'));
    f.doc.transactDrawing((drawing) => ({ ...drawing, meta: { ...drawing.meta, textStyles: { FACE: style('\u00e9.shx') } } })); expect(f.advance()).toBeNull();
    f.doc.transactDrawing((drawing) => ({ ...drawing, meta: { ...drawing.meta, textStyles: { FACE: style('\u00c9.shx') } } })); expect(f.advance()).toBe(5);
  });

  it('reloading the same snapshot into the same tab invalidates resources independently of state identity', async () => {
    const f = makeEditor(), session = f.sessions.current; await f.load(resource());
    const resources = f.shxResources.for(session), generation = session.contentGeneration, snapshot = f.doc.snapshot;
    expect(f.sessions.loadInto(session.id, snapshot, 'C:\\reloaded.dxf')).toBe(true);
    expect(f.sessions.current.contentGeneration).toBeGreaterThan(generation); expect(f.shxResources.for(session)).not.toBe(resources); expect(f.advance()).toBeNull();
    expect(f.doc.snapshot).toBe(snapshot); expect(f.doc.dirty).toBe(false); expect(f.doc.history()).toEqual({ undo: [], redo: [] });
  });

  it('background content replacement clears only that tab and retains captured geometry', async () => {
    const f = makeEditor(), first = f.sessions.current; await f.load(resource());
    const captured = f.shxResources.for(first).capture(textStylesOf(f.doc.snapshot), true);
    f.sessions.add(state()); const second = f.sessions.current; await f.load(resource(20, 'C:\\private\\second\\font.shx'));
    const secondResources = f.shxResources.for(second);
    expect(f.sessions.loadInto(first.id, state(), 'C:\\replacement.dxf')).toBe(true);
    expect(f.advance()).toBe(5); expect(f.shxResources.for(second)).toBe(secondResources); expect(f.runAt(captured)).toMatchObject({ ok: true, advance: 10 });
    f.sessions.switchTo(0); expect(f.advance()).toBeNull();
  });
});

describe('asynchronous SHX native choice and session generations', () => {
  it('a tab switch during native choice binds the selected font to its original tab only', async () => {
    const f = makeEditor(), original = f.sessions.current, choice = deferred<ShxResource | null>();
    f.choose.mockReturnValueOnce(choice.promise); const pending = f.run();
    f.sessions.add(state()); await f.load(resource(20, 'C:\\private\\second\\font.shx')); const current = f.sessions.current;
    const snapshot = f.doc.snapshot, cache = f.geometry().cacheKey; f.render.mockClear();
    choice.resolve(resource()); await pending;
    expect(f.sessions.current).toBe(current); expect(f.advance()).toBe(5); expect(f.geometry().cacheKey).toBe(cache); expect(f.doc.snapshot).toBe(snapshot); expect(f.render).not.toHaveBeenCalled();
    f.sessions.switchTo(f.sessions.indexOfId(original.id)); expect(f.advance()).toBe(10); expect(f.doc.dirty).toBe(false);
  });

  it.each(['close', 'replace', 'background replace'] as const)('rejects a native choice when the original drawing is %s', async (action) => {
    const f = makeEditor(), original = f.sessions.current, resources = f.shxResources.for(original), load = vi.spyOn(resources, 'load'), choice = deferred<ShxResource | null>();
    f.choose.mockReturnValueOnce(choice.promise); const pending = f.run();
    if (action === 'close') f.sessions.close(0);
    else if (action === 'replace') f.sessions.loadInto(original.id, state(), 'C:\\replacement.dxf');
    else { f.sessions.add(state()); f.sessions.loadInto(original.id, state(), 'C:\\replacement.dxf'); }
    const snapshot = f.doc.snapshot, history = f.doc.history(), generation = f.sessions.current.contentGeneration;
    choice.resolve(resource()); await pending;
    expect(load).not.toHaveBeenCalled(); expect(f.advance()).toBeNull(); expect(f.logs.join(' ')).toMatch(/closed or replaced/);
    expect(f.doc.snapshot).toBe(snapshot); expect(f.doc.history()).toEqual(history); expect(f.doc.dirty).toBe(false); expect(f.sessions.current.contentGeneration).toBe(generation);
    if (action === 'background replace') { f.sessions.switchTo(0); expect(f.advance()).toBeNull(); }
  });

  it('a tab switch while the hash is pending finishes only the original session resource', async () => {
    const f = makeEditor(); f.sessions.add(state()); await f.load(resource(20, 'C:\\private\\second\\font.shx')); const second = f.sessions.current;
    f.sessions.switchTo(0); const first = f.sessions.current, digests = deferredDigests();
    f.choose.mockResolvedValueOnce(resource()); const pending = f.run(); await digests.started();
    f.sessions.switchTo(1); const snapshot = f.doc.snapshot, cache = f.geometry().cacheKey; f.render.mockClear(); digests.finish(); await pending;
    expect(f.sessions.current).toBe(second); expect(f.doc.snapshot).toBe(snapshot); expect(f.geometry().cacheKey).toBe(cache); expect(f.advance()).toBe(5); expect(f.render).not.toHaveBeenCalled();
    f.sessions.switchTo(0); expect(f.sessions.current).toBe(first); expect(f.advance()).toBe(10);
  });

  it.each(['close', 'replace', 'background replace'] as const)('a digest finishing after %s cannot bind to a replacement/current drawing', async (action) => {
    const f = makeEditor(), original = f.sessions.current, digests = deferredDigests();
    f.choose.mockResolvedValueOnce(resource()); const pending = f.run(); await digests.started();
    if (action === 'close') f.sessions.close(0);
    else if (action === 'replace') f.sessions.loadInto(original.id, state(), 'C:\\replacement.dxf');
    else { f.sessions.add(state()); f.sessions.loadInto(original.id, state(), 'C:\\replacement.dxf'); }
    const snapshot = f.doc.snapshot, history = f.doc.history(), generation = f.sessions.current.contentGeneration;
    digests.finish(); await pending;
    expect(f.advance()).toBeNull(); expect(f.logs.join(' ')).not.toContain('Loaded'); expect(f.doc.snapshot).toBe(snapshot); expect(f.doc.history()).toEqual(history); expect(f.doc.dirty).toBe(false);
    expect(f.sessions.current.contentGeneration).toBe(generation);
    if (action === 'background replace') { f.sessions.switchTo(0); expect(f.advance()).toBeNull(); }
  });

  it('keeps the newest same-basename selection when digest completions arrive out of order', async () => {
    const f = makeEditor(), digests = deferredDigests();
    f.choose.mockResolvedValueOnce(resource()).mockResolvedValueOnce(resource(20, 'C:\\private\\second\\font.shx'));
    const earlier = f.run(); await digests.started(); const later = f.run(); await digests.started(2);
    digests.finish(1); await later; expect(f.advance()).toBe(5);
    digests.finish(0); await earlier; expect(f.advance()).toBe(5); expect(entityBounds(f.doc.entities[0]!, f.doc.lookupBlock)!.max.x).toBe(4);
    expect(f.doc.dirty).toBe(false); expect(f.doc.history()).toEqual({ undo: [], redo: [] });
  });

  it('allows an earlier successful choice when the newer same-basename choice fails hash verification', async () => {
    const f = makeEditor(), digests = deferredDigests(), bad = resource(20, 'C:\\private\\second\\font.shx');
    f.choose.mockResolvedValueOnce(resource()).mockResolvedValueOnce({ ...bad, sha256: '0'.repeat(64), resourceId: JSON.stringify([bad.resolvedPath, '0'.repeat(64)]) });
    const earlier = f.run(); await digests.started(); const later = f.run(); await digests.started(2);
    digests.finish(1); await later; expect(f.advance()).toBeNull(); expect(f.logs.join(' ')).toMatch(/resource identity/);
    digests.finish(0); await earlier; expect(f.advance()).toBe(10); expect(entityBounds(f.doc.entities[0]!, f.doc.lookupBlock)!.max.x).toBe(8);
    expect(f.doc.dirty).toBe(false); expect(f.doc.history()).toEqual({ undo: [], redo: [] });
  });

  it('orders async choices independently for different filenames in the same tab', async () => {
    const f = makeEditor(), digests = deferredDigests();
    f.choose.mockResolvedValueOnce(resource()).mockResolvedValueOnce(resource(20, 'C:\\private\\second\\other.shx'));
    const earlier = f.run(); await digests.started(); const later = f.run(); await digests.started(2);
    digests.finish(1); await later; expect(f.advance()).toBeNull(); digests.finish(0); await earlier; expect(f.advance()).toBe(10);
    f.doc.transactDrawing((drawing) => ({ ...drawing, meta: { ...drawing.meta, textStyles: { FACE: style('other.shx') } } })); expect(f.advance()).toBe(5);
    expect(f.doc.undo()).toBe(true); expect(f.advance()).toBe(10);
  });

  it('ordinary edits and undo while the chooser waits keep its session generation and restored history', async () => {
    const f = makeEditor(), original = f.sessions.current, generation = original.contentGeneration, choice = deferred<ShxResource | null>();
    f.choose.mockReturnValueOnce(choice.promise); const pending = f.run();
    f.doc.addEntities([line()]); expect(f.doc.undo()).toBe(true); const snapshot = f.doc.snapshot, history = f.doc.history();
    choice.resolve(resource()); await pending;
    expect(f.sessions.current).toBe(original); expect(original.contentGeneration).toBe(generation); expect(f.advance()).toBe(10);
    expect(f.doc.snapshot).toBe(snapshot); expect(f.doc.history()).toEqual(history); expect(f.doc.dirty).toBe(true); expect(f.doc.canRedo()).toBe(true);
  });

  it('keeps immutable plot geometry and PDF paths through rebind, STYLE edit, tab switch and reload', async () => {
    const f = makeEditor(), session = f.sessions.current; await f.load(resource()); const snapshot = f.doc.snapshot;
    const geometry = f.shxResources.for(session).capture(textStylesOf(snapshot), true), key = geometry.cacheKey;
    const lookup = await capturedPlotLookup(snapshot, geometry), prepared = await capturedPdfLookup(snapshot, undefined, page(snapshot).groups, lookup);
    const context = { ...drawingContext(snapshot, prepared.lookup), textGeometry: prepared.geometry }, original = renderPdfPages([page(snapshot)], context, plotStyle)[0]!.content;
    await f.load(resource(20, 'C:\\private\\new\\font.shx')); expect(f.advance()).toBe(5);
    f.doc.transactDrawing((drawing) => ({ ...drawing, meta: { ...drawing.meta, textStyles: { FACE: style('missing.shx') } } }));
    f.sessions.add(state()); f.sessions.loadInto(session.id, state(), 'C:\\replacement.dxf');
    expect(geometry.cacheKey).toBe(key); expect(f.runAt(geometry)).toMatchObject({ ok: true, advance: 10 });
    expect(renderPdfPages([page(snapshot)], context, plotStyle)[0]!.content).toBe(original); expect(original).toMatch(/\bm\s/); expect(original).not.toContain(' Tj');
  });

  it('cancellation, chooser failure and hash failure leave drawing history untouched and allow a later load', async () => {
    const f = makeEditor(); f.doc.addEntities([line()]); const snapshot = f.doc.snapshot, history = f.doc.history(), generation = f.sessions.current.contentGeneration;
    await f.run(); f.choose.mockRejectedValueOnce(new Error('Picker failed')); await f.run();
    const bad = resource(); f.choose.mockResolvedValueOnce({ ...bad, sha256: '0'.repeat(64), resourceId: JSON.stringify([bad.resolvedPath, '0'.repeat(64)]) }); await f.run();
    expect(f.advance()).toBeNull(); expect(f.logs.join(' ')).toMatch(/Picker failed/); expect(f.logs.join(' ')).toMatch(/resource identity/);
    expect(f.doc.snapshot).toBe(snapshot); expect(f.doc.history()).toEqual(history); expect(f.doc.dirty).toBe(true); expect(f.sessions.current.contentGeneration).toBe(generation);
    f.choose.mockResolvedValueOnce(resource()); await f.run(); expect(f.advance()).toBe(10); expect(f.doc.snapshot).toBe(snapshot); expect(f.doc.history()).toEqual(history);
  });

  it.each(['web', 'linux', 'darwin'] as const)('has explicit unavailable feedback without a native read on %s', async (platform) => {
    const f = makeEditor(); f.editor.fileBridge!.platform = platform === 'web' ? undefined : platform;
    await f.run(); expect(f.choose).not.toHaveBeenCalled(); expect(f.logs.join(' ')).toMatch(/Windows desktop/); expect(f.doc.dirty).toBe(false);
    expect(f.commands.get('SHXFONT')!.aliases).toContain('SHXLOAD');
  });
});
