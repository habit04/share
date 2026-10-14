/** Production Editor/plot/PDF producers; main ownership/order is an explicit transport double. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { deflateSync } from 'node:zlib';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { defaultLayout } from '../src/core/layouts';
import { ExportAdmission, capturePlot } from '../src/app/export-admission';
import { plotLayoutsOrVector } from '../src/app/plot-vector';
import * as pdfIo from '../src/io/pdf';
import * as draw from '../src/render/draw';
import { parsePdfBasics } from './helpers/pdf';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import { resetWindowsPathIdentitiesForTests, samePath, setPathPlatform } from '../src/app/paths';

let Editor: typeof EditorType, serial = 0;
beforeAll(async () => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}; Editor = (await import('../src/app/editor')).Editor; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); draw.renderSettings.imageLoader = undefined; draw.clearImageCache(); resetWindowsPathIdentitiesForTests(); setPathPlatform(null); });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const options = { paper: 'letter', orientation: 'portrait' as const, scale: 'fit', margin: 0.5, output: 'vector' as const };
const choice = (output: 'vector' | 'raster' = 'vector', action: 'pdf' | 'print' = 'pdf') => ({ action, options: { ...options, output } });
const text = (value = 'A'): Entity => ({ id: 'text', type: 'text', layer: '0', color: 'ByLayer', style: 'FACE', text: value, position: { x: 0, y: 0 }, height: 7.3, rotation: 0, align: 'left' });
const line = (): Entity => ({ id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 5 } });
const image = (): Entity => ({ id: 'image', type: 'image', layer: '0', color: 'ByLayer', path: 'old-image.png', position: { x: 2, y: 3 }, u: { x: 1, y: 0 }, v: { x: 0, y: 1 }, size: { x: 1, y: 1 } });
function setup(entities: Entity[] = [text()]) {
  const editor = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
  editor.loadState(new Drawing({ entities, meta: { textStyles: { FACE: { name: 'FACE', font: 'arial.ttf', bigFont: '', flags: 0, height: 0, widthFactor: 1, oblique: 0, generation: 0 } } } }).snapshot, `C:\\plot-${++serial}\\Drawing.dxf`);
  setPathPlatform('win32');
  const destination = `C:\\plot-${serial}\\Output.pdf`, physical = `C:\\native-plot-${serial}\\Output.pdf`, events: string[] = [];
  const tickets = new Map<string, { order: number; owner: number; path?: string; baseline?: Uint8Array | string }>(), receipts = new Map<string, { path: string; identityPath: string }>(), disk = new Map<string, Uint8Array | string>();
  let issued = 0, latest = 0, owner = 0;
  const fail = (code: string) => Object.assign(new Error(code), { code });
  const check = (ticket: string, path?: string) => {
    const entry = tickets.get(ticket);
    if (!entry || entry.owner !== owner) throw fail('ERR_SAVE_CANCELLED');
    if (path !== undefined && entry.path !== path) throw fail('ERR_SAVE_TICKET');
    return entry;
  };
  const write = async (payload: Uint8Array | string, opts?: { path?: string; admission?: string }) => {
    const entry = check(opts!.admission!, opts!.path!); events.push(`write:${entry.order}`);
    if (entry.order < latest) throw fail('ERR_SAVE_STALE');
    if (disk.get(opts!.path!) !== entry.baseline) throw fail('ERR_WINDOWS_PATH_CHANGED');
    disk.set(opts!.path!, typeof payload === 'string' ? payload : new Uint8Array(payload)); latest = entry.order;
    receipts.set(opts!.admission!, { path: opts!.path!, identityPath: physical }); return opts!.path!;
  };
  const bridge: FileBridge = {
    platform: 'win32', openDxf: async () => null, saveDxf: async () => { throw new Error('A plot must not save its drawing'); },
    issueSaveAdmission: vi.fn(async kind => { const ticket = `pdf-${++issued}`; events.push(`issue:${kind}:${issued}`); tickets.set(ticket, { order: issued, owner }); return ticket; }),
    choosePdfPath: vi.fn(async (_name, ticket) => { check(ticket!); events.push(`picker:${ticket}`); return destination; }),
    bindSaveAdmission: vi.fn(async (ticket, kind, path) => { const entry = check(ticket); events.push(`bind:${kind}:${entry.order}`); entry.path = path; entry.baseline = disk.get(path); return { identityPath: physical, exists: disk.has(path) }; }),
    cancelSaveAdmission: vi.fn(async ticket => { events.push(`cancel:${ticket}`); tickets.delete(ticket); }),
    saveAdmissionResult: vi.fn(async ticket => { events.push(`receipt:${ticket}`); const receipt = receipts.get(ticket) ?? null; receipts.delete(ticket); return receipt; }),
    savePdf: vi.fn(async (bytes, _name, opts) => write(bytes, opts)),
    plotPdf: vi.fn(async (url, _name, _landscape, _sheet, opts) => write(url, opts)),
    pdfFont: vi.fn(async request => { events.push('font'); return { font: pdfFontFixture({ family: request.family, bold: request.bold, italic: request.italic }) }; }),
    printDrawing: vi.fn(async () => true),
  };
  editor.fileBridge = bridge; editor.hooks.plot = vi.fn(async () => { events.push('plot-dialog'); return choice(); });
  const saved = vi.fn(); editor.hooks.drawingSaved = saved;
  const compressor = vi.spyOn(pdfIo, 'deflate').mockImplementation(async bytes => { events.push('compress'); return new Uint8Array(deflateSync(bytes)); });
  return { editor, bridge, destination, physical, events, tickets, receipts, disk, saved, compressor, reload: () => { owner += 1; }, replace: (value = 'B') => editor.doc.replaceEntities([text(value)]) };
}
function pdfText(bytes: Uint8Array) { const info = parsePdfBasics(bytes); expect(info.errors).toEqual([]); return [...info.objects.values()].filter(object => object.stream).map(object => new TextDecoder().decode(object.stream)).join('\n'); }
function canvasHost() {
  const contexts: CanvasRenderingContext2D[] = [], canvases: HTMLCanvasElement[] = [];
  vi.stubGlobal('document', { createElement(name: string) {
    if (name !== 'canvas') throw new Error(`Unexpected document element ${name}`);
    const ctx = new Proxy({ measureText: (value: string) => ({ width: value.length * 7, actualBoundingBoxLeft: 0, actualBoundingBoxRight: value.length * 7, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 0 }), getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, 255]) }) }, { get(target, property) { return Reflect.get(target, property) ?? (() => {}); } }) as unknown as CanvasRenderingContext2D;
    const canvas = { width: 0, height: 0, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,AAAA' } as unknown as HTMLCanvasElement;
    contexts.push(ctx); canvases.push(canvas); return canvas;
  } });
  return { contexts, canvases };
}

describe('PDF export request and destination order', () => {
  it('issues before the first plot dialog, binds before fonts/compression and consumes a receipt without drawing aliases', async () => {
    const f = setup(), snapshot = f.editor.doc.snapshot, history = f.editor.doc.history(), selected = new Set(['text']); f.editor.selection = selected; f.editor.doc.dirty = true;
    await f.editor.plot();
    expect(f.events[0]).toBe('issue:pdf-export:1'); expect(f.events[1]).toBe('plot-dialog');
    expect(f.events.indexOf('bind:pdf-export:1')).toBeLessThan(f.events.indexOf('font')); expect(f.events.indexOf('bind:pdf-export:1')).toBeLessThan(f.events.indexOf('compress'));
    expect(f.bridge.choosePdfPath).toHaveBeenCalledWith('Drawing.pdf', 'pdf-1');
    expect(f.bridge.savePdf).toHaveBeenCalledWith(expect.any(Uint8Array), 'Drawing.pdf', { path: f.destination, admission: 'pdf-1' });
    expect(f.bridge.saveAdmissionResult).toHaveBeenCalledWith('pdf-1'); expect(samePath(f.destination, f.physical)).toBe(false);
    expect(f.editor.doc.snapshot).toBe(snapshot); expect(f.editor.doc.history()).toEqual(history); expect(f.editor.doc.dirty).toBe(true); expect(f.editor.selection).toBe(selected); expect(f.saved).not.toHaveBeenCalled(); expect(f.tickets.size).toBe(0);
  });
  it('suppresses an older font producer after a newer vector export to the same destination', async () => {
    const f = setup(), font = deferred<void>(); let requests = 0;
    f.bridge.pdfFont = vi.fn(async request => { f.events.push('font'); if (++requests === 1) await font.promise; return { font: pdfFontFixture({ family: request.family, bold: request.bold, italic: request.italic }) }; });
    const old = f.editor.plot(); await vi.waitFor(() => expect(requests).toBe(1)); f.replace('B'); await f.editor.plot(); const newer = f.disk.get(f.destination);
    font.resolve(); await old;
    expect(f.disk.get(f.destination)).toBe(newer); expect(pdfText(newer as Uint8Array)).toContain('<0042>'); expect(f.editor.history.at(-1)).toMatch(/ERR_SAVE_STALE|newer/); expect(f.tickets.size).toBe(0);
  });
  it('suppresses an older compression result after a newer export while preserving the current edits', async () => {
    const f = setup(), compression = deferred<void>(); let calls = 0;
    f.compressor.mockImplementation(async bytes => { if (++calls === 1) await compression.promise; return new Uint8Array(deflateSync(bytes)); });
    const old = f.editor.plot(); await vi.waitFor(() => expect(calls).toBe(1)); f.replace('B'); const current = f.editor.doc.snapshot, history = f.editor.doc.history(); await f.editor.plot(); const newer = f.disk.get(f.destination);
    compression.resolve(); await old;
    expect(f.disk.get(f.destination)).toBe(newer); expect(f.editor.doc.snapshot).toBe(current); expect(f.editor.doc.history()).toEqual(history); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled();
  });
  it('binds before delayed image loading and suppresses its old result after the newer export', async () => {
    canvasHost(); const f = setup([image()]), bitmap = deferred<ImageBitmap | null>();
    const oldLoader = vi.fn(() => bitmap.promise); draw.renderSettings.imageLoader = oldLoader;
    const old = f.editor.plot(); await vi.waitFor(() => expect(oldLoader).toHaveBeenCalledWith('old-image.png')); expect(f.events).toContain('bind:pdf-export:1');
    f.editor.doc.replaceEntities([line()]); draw.renderSettings.imageLoader = vi.fn(async () => null); await f.editor.plot(); const newer = f.disk.get(f.destination);
    bitmap.resolve({ width: 1, height: 1 } as ImageBitmap); await old;
    expect(f.disk.get(f.destination)).toBe(newer); expect(oldLoader).toHaveBeenCalledOnce(); expect(f.tickets.size).toBe(0);
  });
  it('holds captured state/name/geometry across the PDF picker and tab changes', async () => {
    const f = setup(), picker = deferred<string | null>(); f.bridge.choosePdfPath = vi.fn(() => picker.promise);
    const original = f.editor.doc.snapshot, originalSession = f.editor.sessions.current, plotting = f.editor.plot(); await vi.waitFor(() => expect(f.bridge.choosePdfPath).toHaveBeenCalled());
    f.editor.sessions.add(new Drawing({ entities: [text('B')] }).snapshot, 'C:\\other\\New.dxf', true); picker.resolve(f.destination); await plotting;
    expect(f.bridge.savePdf).toHaveBeenCalledWith(expect.any(Uint8Array), 'Drawing.pdf', expect.any(Object)); expect(pdfText(f.disk.get(f.destination) as Uint8Array)).toContain('<0041>');
    expect(originalSession.state).toBe(original); expect(f.editor.doc.filePath).toBe('C:\\other\\New.dxf'); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled();
  });
  it('retains plot-choice timing: edits during the options dialog are captured before the file picker', async () => {
    const f = setup(), dialog = deferred<{ options: typeof options; action: 'pdf' } | null>(); f.editor.hooks.plot = vi.fn(() => dialog.promise);
    const plotting = f.editor.plot(); expect(f.events[0]).toBe('issue:pdf-export:1'); f.replace('B'); dialog.resolve({ options, action: 'pdf' }); await plotting;
    expect(pdfText(f.disk.get(f.destination) as Uint8Array)).toContain('<0042>');
  });
  it.each(['plot dialog', 'PDF picker'] as const)('cancels at %s without producers or mutation', async where => {
    const f = setup(), original = f.editor.doc.snapshot, history = f.editor.doc.history();
    if (where === 'plot dialog') f.editor.hooks.plot = vi.fn(async () => null); else f.bridge.choosePdfPath = vi.fn(async () => null);
    await f.editor.plot(); expect(f.bridge.pdfFont).not.toHaveBeenCalled(); expect(f.compressor).not.toHaveBeenCalled(); expect(f.bridge.savePdf).not.toHaveBeenCalled(); expect(f.tickets.size).toBe(0);
    expect(f.editor.doc.snapshot).toBe(original); expect(f.editor.doc.history()).toEqual(history); expect(f.saved).not.toHaveBeenCalled();
  });
  it.each([['vector', false], ['raster', false], ['vector', true], ['raster', true]] as const)('keeps %s empty/all-hidden model output out of the native picker (hidden=%s)', async (output, hidden) => {
    const f = setup(hidden ? [line()] : []); f.editor.hooks.plot = vi.fn(async () => choice(output));
    if (hidden) f.editor.doc.transactDrawing(state => ({ ...state, layers: state.layers.map(layer => ({ ...layer, visible: false })) }));
    const snapshot = f.editor.doc.snapshot, history = f.editor.doc.history(), dirty = f.editor.doc.dirty;
    await f.editor.plot();
    expect(f.bridge.choosePdfPath).not.toHaveBeenCalled(); expect(f.bridge.pdfFont).not.toHaveBeenCalled(); expect(f.compressor).not.toHaveBeenCalled(); expect(f.bridge.savePdf).not.toHaveBeenCalled(); expect(f.bridge.plotPdf).not.toHaveBeenCalled();
    expect(f.editor.history.at(-1)).toBe('Nothing to plot: this tab has no visible objects.'); expect(f.tickets.size).toBe(0); expect(f.editor.doc.snapshot).toBe(snapshot); expect(f.editor.doc.history()).toEqual(history); expect(f.editor.doc.dirty).toBe(dirty);
  });
  it('refuses retired owner output after an awaited font producer without adopting a fresh ticket', async () => {
    const f = setup(), font = deferred<void>(); f.bridge.pdfFont = vi.fn(async request => { await font.promise; return { font: pdfFontFixture({ family: request.family, bold: request.bold, italic: request.italic }) }; });
    const plotting = f.editor.plot(); await vi.waitFor(() => expect(f.bridge.pdfFont).toHaveBeenCalled()); f.reload(); f.replace('B'); font.resolve(); await plotting;
    expect(f.disk.size).toBe(0); expect(f.editor.doc.dirty).toBe(true); expect(f.bridge.issueSaveAdmission).toHaveBeenCalledOnce(); expect(f.editor.history.at(-1)).toMatch(/ERR_SAVE_CANCELLED/);
  });
  it('reports a missing or unverified commit receipt without claiming a successful plot or cleaning the drawing', async () => {
    const f = setup(); f.editor.doc.dirty = true; f.bridge.saveAdmissionResult = vi.fn(async () => null);
    await f.editor.plot(); expect(f.disk.size).toBe(1); expect(f.editor.history.at(-1)).toMatch(/file was replaced.*Review the destination/); expect(f.editor.history.at(-1)).not.toMatch(/Plotted to/); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled();
    f.bridge.savePdf = vi.fn(async () => { throw new Error('ERR_SAVE_COMMITTED: EACCES after replacement'); });
    await f.editor.plot(); expect(f.editor.history.at(-1)).toMatch(/file was replaced.*Review the destination/); expect(f.tickets.size).toBe(0);
  });
  it('keeps old/browser bridge argument contracts without early chooser or admission calls', async () => {
    const f = setup(); delete f.bridge.choosePdfPath; f.bridge.savePdf = vi.fn(async () => 'download.pdf');
    await f.editor.plot(); expect(f.bridge.issueSaveAdmission).not.toHaveBeenCalled(); expect(f.bridge.savePdf).toHaveBeenCalledWith(expect.any(Uint8Array), 'Drawing.pdf'); expect(f.bridge.saveAdmissionResult).not.toHaveBeenCalled();
  });
  it('protects direct vector entry points as well as the public plot command', async () => {
    const f = setup(); expect(await plotLayoutsOrVector(f.editor, { action: 'pdf', options })).toBe(true);
    expect(f.events[0]).toBe('issue:pdf-export:1'); expect(f.events.indexOf('bind:pdf-export:1')).toBeLessThan(f.events.indexOf('font')); expect(f.tickets.size).toBe(0);
  });
});

describe('raster PDF ordering and cleanup', () => {
  it('binds before the actual model raster producer and uses its captured drawing across a picker edit', async () => {
    canvasHost(); const f = setup([line()]), picker = deferred<string | null>(); f.editor.hooks.plot = vi.fn(async () => choice('raster')); f.bridge.choosePdfPath = vi.fn(() => picker.promise);
    const drawEntity = vi.spyOn(draw, 'drawEntity'), plotting = f.editor.plot(); await vi.waitFor(() => expect(f.bridge.choosePdfPath).toHaveBeenCalled());
    expect(drawEntity).not.toHaveBeenCalled(); f.editor.doc.transactDrawing(state => ({ ...state, entities: [{ ...line(), id: 'later-line', b: { x: 100, y: 50 } }] })); picker.resolve(f.destination); await plotting;
    expect(drawEntity.mock.calls.some(call => call[1].id === 'line')).toBe(true); expect(drawEntity.mock.calls.some(call => call[1].id === 'later-line')).toBe(false);
    expect(f.bridge.plotPdf).toHaveBeenCalledWith('data:image/png;base64,AAAA', 'Drawing.pdf', expect.any(Boolean), expect.any(Object), { path: f.destination, admission: 'pdf-1' }); expect(f.editor.doc.dirty).toBe(true);
  });
  it('suppresses an older delayed raster bridge result after a newer vector PDF export', async () => {
    canvasHost(); const f = setup([line()]), gate = deferred<void>(), write = f.bridge.plotPdf!;
    f.editor.hooks.plot = vi.fn(async () => choice('raster')); f.bridge.plotPdf = vi.fn(async (...args: Parameters<NonNullable<FileBridge['plotPdf']>>) => { await gate.promise; return write(...args); });
    const old = f.editor.plot(); await vi.waitFor(() => expect(f.bridge.plotPdf).toHaveBeenCalled()); f.editor.hooks.plot = vi.fn(async () => choice()); await f.editor.plot(); const newer = f.disk.get(f.destination); gate.resolve(); await old;
    expect(f.disk.get(f.destination)).toBe(newer); expect(f.editor.history.at(-1)).toMatch(/ERR_SAVE_STALE/); expect(f.tickets.size).toBe(0);
  });
  it('binds before rasterizing a paper layout and preserves the normal print path', async () => {
    canvasHost(); const f = setup([line()]), layout = { ...defaultLayout('Sheet'), pristine: false, entities: [line()], viewports: [] };
    f.editor.doc.transactDrawing(state => ({ ...state, layouts: [layout], space: { layout: 'Sheet' } }));
    f.editor.hooks.plot = vi.fn(async () => choice('raster')); await f.editor.plot();
    expect(f.bridge.plotPdf).toHaveBeenCalledWith('data:image/png;base64,AAAA', 'Drawing - Sheet.pdf', expect.any(Boolean), expect.any(Object), { path: f.destination, admission: 'pdf-1' });
    f.editor.hooks.plot = vi.fn(async () => choice('raster', 'print')); await f.editor.print(); expect(f.bridge.printDrawing).toHaveBeenCalledOnce(); expect(f.tickets.size).toBe(0);
  });
  it.each([true, false])('holds a paper-layout image loader across the PDF picker (available=%s)', async available => {
    canvasHost(); const f = setup([line()]), picker = deferred<string | null>(), oldLoader = vi.fn(async () => null), laterLoader = vi.fn(async () => null);
    const layout = { ...defaultLayout('Images'), pristine: false, entities: [image()], viewports: [] };
    f.editor.doc.transactDrawing(state => ({ ...state, layouts: [layout], space: { layout: 'Images' } }));
    f.editor.hooks.plot = vi.fn(async () => choice('raster')); f.bridge.choosePdfPath = vi.fn(() => picker.promise);
    draw.renderSettings.imageLoader = available ? oldLoader : undefined;
    const plotting = f.editor.plot(); await vi.waitFor(() => expect(f.bridge.choosePdfPath).toHaveBeenCalled());
    expect(oldLoader).not.toHaveBeenCalled(); draw.renderSettings.imageLoader = laterLoader;
    picker.resolve(f.destination); await plotting;
    if (available) expect(oldLoader).toHaveBeenCalledWith('old-image.png'); else expect(oldLoader).not.toHaveBeenCalled();
    expect(laterLoader).not.toHaveBeenCalled(); expect(f.bridge.plotPdf).toHaveBeenCalledOnce(); expect(f.saved).not.toHaveBeenCalled();
  });
  it('memoizes close and joins a delayed active bridge write plus receipt cleanup', async () => {
    const f = setup(), gate = deferred<void>(), write = f.bridge.savePdf!, admission = new ExportAdmission(f.bridge);
    await admission.choose('Drawing.pdf'); f.bridge.savePdf = vi.fn(async (...args: Parameters<NonNullable<FileBridge['savePdf']>>) => { await gate.promise; return write(...args); });
    const sending = admission.savePdf(new Uint8Array([1]), 'Drawing.pdf'), rejected = expect(sending).rejects.toMatchObject({ code: 'ERR_SAVE_CANCELLED' });
    let finished = false; const first = admission.close(); expect(admission.close()).toBe(first); void first.then(() => { finished = true; }); await Promise.resolve(); await Promise.resolve(); expect(finished).toBe(false);
    gate.resolve(); await rejected; await first; expect(finished).toBe(true); expect(f.tickets.size).toBe(0); expect(f.disk.size).toBe(0);
  });
  it('keeps captured resources outside drawing/history data', () => {
    const f = setup(), captured = capturePlot(f.editor), snapshot = f.editor.doc.snapshot, history = f.editor.doc.history();
    expect(Object.isFrozen(captured)).toBe(true); expect(captured.state).toBe(snapshot); expect(captured.base).toBe('Drawing'); expect(captured.geometry).toBeDefined(); expect(captured.vectorGeometry).toBeDefined();
    expect(f.editor.doc.snapshot).toBe(snapshot); expect(f.editor.doc.history()).toEqual(history); expect(JSON.stringify(snapshot)).not.toContain('pdf-export'); expect(f.saved).not.toHaveBeenCalled();
  });
});
