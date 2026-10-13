/** Production guarded Drawing + Plot IPC, native Windows identities/FDs/atomic IO.
 * Native dialogs and hidden printToPDF lifecycle are explicit test doubles; this
 * suite does not certify Electron's real printing or native dialog ordering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { decodeDxfBytes } from '../src/io/encoding';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import { parsePdfBasics } from './helpers/pdf';

const require = createRequire(import.meta.url);
const atomic = require('../electron/atomic-write.cjs');
const { createPathRegistry } = require('../electron/path-registry.cjs');
const { createPathPolicy, guardIpc } = require('../electron/ipc-guard.cjs');
type Handler = (ev: unknown, ...args: unknown[]) => unknown;
type SaveChoice = { canceled: boolean; filePath?: string };
type Opened = { path: string; text: string; openedSourceProof: string };
type PrintJob = { entered: ReturnType<typeof deferred<void>>; result: ReturnType<typeof deferred<Uint8Array>>; cleanup?: ReturnType<typeof deferred<void>>; cleanupEntered?: ReturnType<typeof deferred<void>> };
const privateRoot = path.resolve('.codex-local/windows-export-ipc-tests');
const cleanupWindows: EventEmitter[] = [], cleanupDeferred: Array<() => void> = [], tasks: Promise<unknown>[] = [];
let dir: string;
function pdf(stamp: string) {
  const stream = `0 0 10 10 re f\n% ${stamp}\n`, objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 4 0 R >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let text = '%PDF-1.4\n'; const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(text)); text += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const start = Buffer.byteLength(text); text += `xref\n0 5\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(text));
}
function deferred<T>(cleanupValue?: T) {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); void promise.catch(() => {});
  cleanupDeferred.push(() => resolve(cleanupValue as T)); return { promise, resolve, reject };
}
function track<T>(promise: Promise<T>): Promise<T> { tasks.push(promise); void promise.catch(() => {}); return promise; }
const png = 'data:image/png;base64,YQ==', sheet = { width: 8.5, height: 11 };
const nativeDxf = readFileSync(new URL('./fixtures/interchange/r2018-shx-text.dxf', import.meta.url), 'utf8');
const foreignDrawing = new Drawing(readDxf(nativeDxf));
foreignDrawing.addEntities([{ id: 'outside-edit', type: 'point', layer: '0', color: 'ByLayer', position: { x: 777, y: 3 } }]);
const editedDxf = writeDxf(foreignDrawing.snapshot);
beforeEach(async () => { await fs.mkdir(privateRoot, { recursive: true }); dir = await fs.mkdtemp(path.join(privateRoot, 'case-')); });
afterEach(async () => {
  vi.restoreAllMocks(); for (const win of cleanupWindows.splice(0)) win.emit('closed');
  for (const release of cleanupDeferred.splice(0)) release(); await Promise.allSettled(tasks.splice(0));
  if (path.dirname(dir) !== privateRoot || !path.basename(dir).startsWith('case-')) throw new Error('Unsafe private Windows export IPC cleanup');
  await fs.rm(dir, { recursive: true, force: true });
});
function setup() {
  const registry = createPathRegistry(), handlers = new Map<string, Handler>(), log = { reject: vi.fn() };
  const frame = { processId: 1, routingId: 1, parent: null, url: 'jcad://app/index.html' };
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: frame });
  const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: contents }); cleanupWindows.push(win);
  const ev = { sender: contents, senderFrame: frame };
  const ipcMain = guardIpc({ handle: (channel: string, handler: Handler) => handlers.set(channel, handler) }, { getWindow: () => win, isAppUrl: (url: string) => url === frame.url, log });
  const pathPolicy = createPathPolicy({ isKnownPath: (file: string) => registry.isKnown(file), isWritablePath: (file: string) => registry.isWritable(file), knownPaths: () => registry.paths(), log });
  const choices: Array<string | Promise<SaveChoice>> = [], jobs: PrintJob[] = [], hidden: HiddenWindow[] = [];
  const dialog = {
    showSaveDialog: vi.fn(async () => { const choice = choices.shift(); if (choice === undefined) throw new Error('The test must declare its native dialog result.'); return typeof choice === 'string' ? { canceled: false, filePath: choice } : choice; }),
    showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })), showMessageBox: vi.fn(async () => ({ response: 0 })),
  };
  class HiddenWindow {
    destroyed = false;
    readonly job: PrintJob;
    readonly webContents: { executeJavaScript: ReturnType<typeof vi.fn>; printToPDF: ReturnType<typeof vi.fn> };
    constructor() {
      const job = jobs.shift(); if (!job) throw new Error('The test must declare a mock printToPDF job.'); this.job = job; hidden.push(this);
      this.webContents = { executeJavaScript: vi.fn(async () => true), printToPDF: vi.fn(async () => {
        job.entered.resolve();
        try { return await job.result.promise; }
        finally { job.cleanupEntered?.resolve(); if (job.cleanup) await job.cleanup.promise; }
      }) };
    }
    async loadURL() {}
    isDestroyed() { return this.destroyed; }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.job.result.reject(new Error('Mock native print request destroyed')); } }
    static fromWebContents() { return win; }
  }
  const enqueueWrite = atomic.createCanonicalWriteQueue();
  const appData = { enqueueWrite, writeUserFile: (file: string, data: string | Uint8Array, opts: object = {}) => enqueueWrite(file, (key: string) => atomic.atomicWriteFile(file, data, { ...opts, expectedDestination: key })) };
  function load(relative: string, overrides: Record<string, unknown>) {
    const file = path.resolve(relative), localRequire = createRequire(file), module = { exports: {} as any };
    new Function('require', 'module', readFileSync(file, 'utf8'))((name: string) => name in overrides ? overrides[name] : localRequire(name), module); return module.exports;
  }
  const ctx = { ipcMain, rejections: log, registry, pathPolicy, senderWindow: () => win, mainWindow: win, saveOrder: undefined as any };
  load('electron/main/ipc-drawings.cjs', { electron: { dialog }, './app-data.cjs': appData, './dwg.cjs': { decodeDxf: (bytes: Uint8Array) => Promise.resolve(decodeDxfBytes(bytes)), readDwgWithProgress: () => { throw new Error('This export test does not validate or substitute a native DWG reader.'); } }, '../portable-dwg.cjs': { createPortableDwgExporter: () => ({ status: () => ({ available: false }), export: () => { throw new Error('Native DWG export is outside this test.'); } }) } }).registerDrawingIpc(ctx, { takeHandedOverProject: () => false });
  load('electron/main/ipc-plot.cjs', { electron: { dialog, BrowserWindow: HiddenWindow }, './app-data.cjs': appData, './window.cjs': { secureContents: () => {} } }).registerPlotIpc(ctx);
  const invoke = (channel: string, ...args: unknown[]) => track(Promise.resolve().then(() => handlers.get(channel)!(ev, ...args)));
  const open = async (file: string) => { registry.grant(file); return await invoke('open-drawing', file) as Opened; };
  const bindPdf = async (file: string) => { registry.grant(file); const ticket = await invoke('issue-save-admission', 'pdf-export') as string; await invoke('bind-save-admission', ticket, 'pdf-export', file); return ticket; };
  const job = (withCleanup = false) => { const entry: PrintJob = { entered: deferred<void>(), result: deferred<Uint8Array>(pdf('CLEANUP')) }; if (withCleanup) { entry.cleanup = deferred<void>(); entry.cleanupEntered = deferred<void>(); } jobs.push(entry); return entry; };
  return { registry, handlers, contents, win, ev, ctx, choices, dialog, hidden, invoke, open, bindPdf, job };
}
function idle(f: ReturnType<typeof setup>) { expect(f.ctx.saveOrder.stats()).toMatchObject({ pending: 0, queuedBytes: 0, ordinaryQueuedBytes: 0, pdfQueuedBytes: 0, queues: 0 }); expect(f.hidden.every(hidden => hidden.destroyed)).toBe(true); }

describe.runIf(process.platform === 'win32')('Production export IPC with mock native dialog/print lifecycle and real private Windows files', () => {
  it('refuses an older legacy raster conversion after a newer vector PDF commits', async () => {
    const f = setup(), file = path.join(dir, 'Output.pdf'), old = f.job(); await fs.writeFile(file, pdf('BASELINE')); f.choices.push(file);
    const raster = f.invoke('plot-pdf', png, 'Output.pdf', false, sheet); await old.entered.promise;
    f.choices.push(file); await expect(f.invoke('save-pdf', pdf('NEWER-VECTOR'), 'Output.pdf')).resolves.toBe(file);
    old.result.resolve(pdf('OLDER-RASTER')); await expect(raster).rejects.toThrow(/ERR_SAVE_STALE/);
    expect(new Uint8Array(await fs.readFile(file))).toEqual(pdf('NEWER-VECTOR')); const parsed = parsePdfBasics(await fs.readFile(file)); expect(parsed.pages).toHaveLength(1); expect(parsed.errors).toEqual([]); idle(f);
  });
  it('refuses an older text export whose mock dialog completes after a newer export', async () => {
    const f = setup(), file = path.join(dir, 'Report.csv'), choice = deferred<SaveChoice>({ canceled: true }); f.choices.push(choice.promise);
    const older = f.invoke('save-text', 'Report.csv', 'OLDER', 'CSV', 'csv'); await vi.waitFor(() => expect(f.dialog.showSaveDialog).toHaveBeenCalledOnce());
    f.choices.push(file); await f.invoke('save-text', 'Report.csv', 'NEWER', 'CSV', 'csv'); choice.resolve({ canceled: false, filePath: file });
    await expect(older).rejects.toThrow(/ERR_SAVE_STALE/); expect(await fs.readFile(file, 'utf8')).toBe('NEWER'); idle(f);
  });
  it('refuses the old non-project text bypass onto a protected opened DXF after an outside edit', async () => {
    const f = setup(), file = path.join(dir, 'Original.dxf'); await fs.writeFile(file, nativeDxf); const opened = await f.open(file); expect(opened.openedSourceProof).toMatch(/^[a-f0-9]{48}$/);
    await fs.writeFile(file, editedDxf); await fs.writeFile(`${file}.bak`, 'PREVIOUS BACKUP'); f.choices.push(file);
    await expect(f.invoke('save-text', 'Snapshot.dxf', opened.text, 'DXF Drawing', 'dxf')).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    expect(await fs.readFile(file, 'utf8')).toBe(editedDxf); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('PREVIOUS BACKUP');
    expect(readDxf(await fs.readFile(file, 'utf8')).entities.length).toBeGreaterThan(0); idle(f);
    await f.invoke('release-opened-source-proof', opened.openedSourceProof);
  });
  it.each(['navigation', 'renderer-loss', 'closed'] as const)('destroys the old owner mock hidden converter and never writes after %s', async reason => {
    const f = setup(), file = path.join(dir, 'Retired.pdf'), old = f.job(); f.choices.push(file); const raster = f.invoke('plot-pdf', png, 'Retired.pdf', false, sheet); await old.entered.promise;
    if (reason === 'navigation') f.contents.emit('did-start-navigation', {}, 'jcad://app/index.html', false, true); else if (reason === 'renderer-loss') f.contents.emit('render-process-gone'); else f.win.emit('closed');
    await expect(raster).rejects.toThrow(); expect(f.hidden[0]!.destroyed).toBe(true); expect(await fs.readdir(dir)).toEqual([]); idle(f);
  });
  it('keeps the early modern chooser unbound and older than a later legacy export before renderer production', async () => {
    const f = setup(), file = path.join(dir, 'Early.pdf'), ticket = await f.invoke('issue-save-admission', 'pdf-export'); f.choices.push(file);
    await expect(f.invoke('choose-pdf-path', 'Early.pdf', ticket)).resolves.toBe(file);
    await expect(f.invoke('save-pdf', pdf('UNBOUND'), 'Early.pdf', { path: file, admission: ticket })).rejects.toThrow(/ERR_SAVE_TICKET/);
    f.choices.push(file); await f.invoke('save-pdf', pdf('NEWER-LEGACY'), 'Early.pdf');
    await f.invoke('bind-save-admission', ticket, 'pdf-export', file);
    await expect(f.invoke('save-pdf', pdf('OLDER-MODERN'), 'Early.pdf', { path: file, admission: ticket })).rejects.toThrow(/ERR_SAVE_STALE/);
    expect(new Uint8Array(await fs.readFile(file))).toEqual(pdf('NEWER-LEGACY')); expect(f.dialog.showSaveDialog).toHaveBeenCalledTimes(2); idle(f);
  });
  it.each(['legacy-raster', 'legacy-text', 'shared-project'] as const)('uses the same order for a modern bound PDF and newer %s', async later => {
    const f = setup(), file = path.join(dir, later === 'shared-project' ? 'Project.jcadproj.json' : 'Shared.pdf'), ticket = await f.bindPdf(file);
    const old = f.job(); const pending = f.invoke('plot-pdf', png, 'Shared.pdf', false, sheet, { path: file, admission: ticket }); await old.entered.promise;
    if (later === 'legacy-raster') { const newer = f.job(); newer.result.resolve(pdf('NEWER-RASTER')); f.choices.push(file); await f.invoke('plot-pdf', png, 'Shared.pdf', false, sheet); }
    else { f.choices.push(file); await f.invoke('save-text', later === 'shared-project' ? 'Project.jcadproj.json' : 'report.csv', 'NEWER-TEXT', later === 'shared-project' ? 'JCad Electrical Project' : 'CSV', later === 'shared-project' ? 'json' : 'csv'); }
    old.result.resolve(pdf('OLDER-MODERN')); await expect(pending).rejects.toThrow(/ERR_SAVE_STALE/);
    expect(await fs.readFile(file, 'utf8')).toContain(later === 'legacy-raster' ? 'NEWER-RASTER' : 'NEWER-TEXT'); idle(f);
  });
  it('returns a one-use modern PDF receipt without changing opened drawing evidence', async () => {
    const f = setup(), source = path.join(dir, 'Original.dxf'), target = path.join(dir, 'Copy.dat'); await fs.writeFile(source, nativeDxf); const opened = await f.open(source), ticket = await f.bindPdf(target);
    const before = f.ctx.saveOrder.stats().openedSources; await f.invoke('save-pdf', pdf('MODERN'), 'Copy.pdf', { path: target, admission: ticket });
    expect(await f.invoke('save-admission-result', ticket)).toEqual({ path: target, identityPath: await fs.realpath(target) }); expect(await f.invoke('save-admission-result', ticket)).toBeNull();
    expect(f.ctx.saveOrder.stats().openedSources).toEqual(before); expect(await fs.readFile(source, 'utf8')).toBe(nativeDxf); expect(f.dialog.showSaveDialog).not.toHaveBeenCalled(); idle(f);
    await f.invoke('release-opened-source-proof', opened.openedSourceProof);
  });
  it('refuses outside content changes after bind before constructing a hidden converter or replacing bytes', async () => {
    const f = setup(), file = path.join(dir, 'Outside.pdf'); await fs.writeFile(file, pdf('ORIGINAL')); const ticket = await f.bindPdf(file); await fs.writeFile(file, pdf('OUTSIDE'));
    await expect(f.invoke('plot-pdf', png, 'Outside.pdf', false, sheet, { path: file, admission: ticket })).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED/);
    expect(f.hidden).toHaveLength(0); expect(new Uint8Array(await fs.readFile(file))).toEqual(pdf('OUTSIDE')); idle(f);
  });
  it('refuses outside edits during hidden conversion before the atomic write', async () => {
    const f = setup(), file = path.join(dir, 'Outside.pdf'); await fs.writeFile(file, pdf('ORIGINAL')); const ticket = await f.bindPdf(file), pending = f.job();
    const saving = f.invoke('plot-pdf', png, 'Outside.pdf', false, sheet, { path: file, admission: ticket }); await pending.entered.promise;
    await fs.writeFile(file, pdf('OUTSIDE')); pending.result.resolve(pdf('OWN')); await expect(saving).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED/);
    expect(new Uint8Array(await fs.readFile(file))).toEqual(pdf('OUTSIDE')); expect(await fs.readdir(dir)).toEqual(['Outside.pdf']); idle(f);
  });
  it('does not grant a native chooser result after same-owner ticket cancellation', async () => {
    const f = setup(), file = path.join(dir, 'Canceled-choice.pdf'), ticket = await f.invoke('issue-save-admission', 'pdf-export'), choice = deferred<SaveChoice>({ canceled: true }); f.choices.push(choice.promise);
    const choosing = f.invoke('choose-pdf-path', 'Canceled-choice.pdf', ticket); await vi.waitFor(() => expect(f.dialog.showSaveDialog).toHaveBeenCalledOnce());
    await f.invoke('cancel-save-admission', ticket, 'pdf-export'); choice.resolve({ canceled: false, filePath: file });
    await expect(choosing).rejects.toThrow(/ERR_SAVE_TICKET/); expect(f.registry.isKnown(file)).toBe(false); expect(f.hidden).toHaveLength(0); idle(f);
  });
  it('does not grant an old-document native chooser result after navigation', async () => {
    const f = setup(), file = path.join(dir, 'Old-choice.pdf'), ticket = await f.invoke('issue-save-admission', 'pdf-export'), choice = deferred<SaveChoice>({ canceled: true }); f.choices.push(choice.promise);
    const choosing = f.invoke('choose-pdf-path', 'Old-choice.pdf', ticket); await vi.waitFor(() => expect(f.dialog.showSaveDialog).toHaveBeenCalledOnce());
    f.contents.emit('did-start-navigation', {}, 'jcad://app/index.html', false, true); choice.resolve({ canceled: false, filePath: file });
    await expect(choosing).rejects.toThrow(/ERR_SAVE_CANCELLED/); expect(f.registry.isKnown(file)).toBe(false); idle(f);
  });
  it.each(['junction', 'hardlink'] as const)('refuses generic PDF and text exports through a native %s alias to the opened source', async aliasType => {
    const f = setup(), folder = path.join(dir, 'Source'); await fs.mkdir(folder); const file = path.join(folder, 'Original.dxf'); await fs.writeFile(file, nativeDxf); const opened = await f.open(file);
    const alias = aliasType === 'hardlink' ? path.join(dir, 'Wrong-filter.pdf') : path.join(dir, 'Link', 'Original.dxf');
    if (aliasType === 'hardlink') await fs.link(file, alias); else await fs.symlink(folder, path.dirname(alias), 'junction');
    f.choices.push(alias); await expect(f.invoke('save-pdf', pdf('OVERWRITE'), 'Wrong-filter.pdf')).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    f.choices.push(alias); await expect(f.invoke('save-text', 'report.csv', 'OVERWRITE', 'CSV', 'csv')).rejects.toThrow(/ERR_OPENED_SOURCE_PROOF/);
    expect(await fs.readFile(file, 'utf8')).toBe(nativeDxf); expect(f.hidden).toHaveLength(0); idle(f); await f.invoke('release-opened-source-proof', opened.openedSourceProof);
  });
  it('rejects missing, wrong-kind, forged, unbound, transferred and unauthorized modern tickets before a hidden window', async () => {
    const f = setup(), file = path.join(dir, 'Chosen.pdf'), other = path.join(dir, 'Other.pdf'), unknown = path.join(dir, 'Unknown.pdf'); f.registry.grant(file); f.registry.grant(other);
    const wrong = await f.invoke('issue-save-admission', 'drawing'), unbound = await f.invoke('issue-save-admission', 'pdf-export'), bound = await f.bindPdf(file);
    for (const opts of [{ path: file }, { path: file, admission: 'forged' }, { path: file, admission: wrong }, { path: file, admission: unbound }, { path: other, admission: bound }, { path: unknown, admission: bound }, { path: '..\\escape.pdf', admission: bound }, { path: `${file}:stream`, admission: bound }]) await expect(f.invoke('plot-pdf', png, 'Chosen.pdf', false, sheet, opts)).rejects.toThrow();
    expect(f.hidden).toHaveLength(0); expect(f.dialog.showSaveDialog).not.toHaveBeenCalled(); expect(await fs.readdir(dir)).toEqual([]);
    await f.invoke('cancel-save-admission', wrong, 'drawing'); await f.invoke('cancel-save-admission', unbound, 'pdf-export'); await f.invoke('cancel-save-admission', bound, 'pdf-export'); idle(f);
  });
  it('rejects foreign and already-bound chooser tickets before invoking a dialog or hidden converter', async () => {
    const first = setup(), second = setup(), file = path.join(dir, 'Chosen.pdf'), foreign = await first.invoke('issue-save-admission', 'pdf-export'), bound = await second.bindPdf(file);
    await expect(second.invoke('choose-pdf-path', 'Chosen.pdf', foreign)).rejects.toThrow(/ERR_SAVE_TICKET/); await expect(second.invoke('choose-pdf-path', 'Chosen.pdf', bound)).rejects.toThrow(/ERR_SAVE_TICKET/);
    expect(second.dialog.showSaveDialog).not.toHaveBeenCalled(); expect(second.hidden).toHaveLength(0); await first.invoke('cancel-save-admission', foreign, 'pdf-export'); await second.invoke('cancel-save-admission', bound, 'pdf-export'); idle(first); idle(second);
  });
  it('guards combined handlers against subframes before picker, grant, allocation or conversion', async () => {
    const f = setup(), file = path.join(dir, 'Untrusted.pdf'), ev = { ...f.ev, senderFrame: { processId: 1, routingId: 2, parent: f.ev.senderFrame, url: 'jcad://app/index.html' } };
    for (const [channel, args] of [['choose-pdf-path', ['Untrusted.pdf']], ['plot-pdf', [png, 'Untrusted.pdf', false, sheet]], ['save-pdf', [pdf('UNTRUSTED'), 'Untrusted.pdf']], ['save-text', ['Untrusted.csv', 'text', 'CSV', 'csv']]] as const) await expect(Promise.resolve().then(() => f.handlers.get(channel)!(ev, ...args))).rejects.toThrow(/Unauthorized IPC caller/);
    expect(f.dialog.showSaveDialog).not.toHaveBeenCalled(); expect(f.registry.isKnown(file)).toBe(false); expect(f.hidden).toHaveLength(0); idle(f);
  });
  it('joins cancellation through mock native print request destruction and asynchronous cleanup', async () => {
    const f = setup(), file = path.join(dir, 'Canceled.pdf'), ticket = await f.bindPdf(file), pending = f.job(true);
    const saving = f.invoke('plot-pdf', png, 'Canceled.pdf', false, sheet, { path: file, admission: ticket }); await pending.entered.promise;
    let joined = false; const canceling = f.invoke('cancel-save-admission', ticket, 'pdf-export').then(() => { joined = true; }); await pending.cleanupEntered!.promise;
    expect(joined).toBe(false); expect(f.hidden[0]!.destroyed).toBe(true); expect(f.ctx.saveOrder.stats().pending).toBe(1);
    pending.cleanup!.resolve(); await expect(saving).rejects.toThrow(); await canceling; expect(joined).toBe(true); expect(await fs.readdir(dir)).toEqual([]); idle(f);
  });
  it('refuses a mutated or malformed final PDF snapshot and allows a later valid retry', async () => {
    const f = setup(), file = path.join(dir, 'Output.pdf'); await fs.writeFile(file, pdf('BASELINE'));
    for (const bytes of [new Uint8Array([0, 1]), new Uint8Array(Buffer.from('NOT A PDF'))]) await expect(f.invoke('save-pdf', bytes, 'Output.pdf')).rejects.toThrow(/Invalid PDF payload/);
    expect(f.dialog.showSaveDialog).not.toHaveBeenCalled(); const choice = deferred<SaveChoice>({ canceled: true }), bytes = pdf('ORIGINAL'); f.choices.push(choice.promise);
    const saving = f.invoke('save-pdf', bytes, 'Output.pdf'); await vi.waitFor(() => expect(f.dialog.showSaveDialog).toHaveBeenCalledOnce()); bytes.fill(0); choice.resolve({ canceled: false, filePath: file });
    await expect(saving).rejects.toThrow(/Invalid PDF payload/); expect(new Uint8Array(await fs.readFile(file))).toEqual(pdf('BASELINE'));
    f.choices.push(file); await f.invoke('save-pdf', pdf('RETRY'), 'Output.pdf'); expect(new Uint8Array(await fs.readFile(file))).toEqual(pdf('RETRY')); expect(await fs.readdir(dir)).toEqual(['Output.pdf']); idle(f);
  });
  it('keeps legacy CSV behavior and both intended and unexpectedly selected project backups', async () => {
    const f = setup(), csv = path.join(dir, 'Report.csv'), project = path.join(dir, 'Project.jcadproj.json'), unexpected = path.join(dir, 'Unexpected.jcadproj.json');
    await fs.writeFile(csv, 'OLD CSV'); f.choices.push(csv); await f.invoke('save-text', 'Report.csv', 'NEW CSV', 'CSV', 'csv'); await expect(fs.stat(`${csv}.bak`)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const [file, suggestion, filter] of [[project, 'Project.jcadproj.json', 'JCad Electrical Project'], [unexpected, 'Report.csv', 'CSV']]) {
      await fs.writeFile(file!, 'OLD PROJECT'); f.choices.push(file!); await f.invoke('save-text', suggestion, '{"drawings":[]}', filter, 'json'); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('OLD PROJECT');
    }
    expect(await fs.readFile(csv, 'utf8')).toBe('NEW CSV'); idle(f);
  });
  it('applies the existing8MiB project limit to a late selected project filename without writing or backing up', async () => {
    const f = setup(), file = path.join(dir, 'Late.jcadproj.json'); await fs.writeFile(file, 'ORIGINAL'); await fs.writeFile(`${file}.bak`, 'PREVIOUS BACKUP'); f.choices.push(file);
    await expect(f.invoke('save-text', 'Report.csv', 'a'.repeat(8 * 1024 * 1024 + 1), 'CSV', 'csv')).rejects.toThrow(/too large|limit|exceeds/i);
    expect(await fs.readFile(file, 'utf8')).toBe('ORIGINAL'); expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('PREVIOUS BACKUP'); idle(f);
  });
  it('refuses an earlier async report ticket after a newer legacy text export completes before its payload arrives', async () => {
    const f = setup(), file = path.join(dir, 'Async-report.csv'), ticket = await f.invoke('issue-save-admission', 'text-export'), loaded = deferred<void>();
    const report = track((async () => { await loaded.promise; f.choices.push(file); return f.invoke('save-text', 'Async-report.csv', 'OLDER PROJECT REPORT', 'CSV', 'csv', { admission: ticket }); })());
    f.choices.push(file); await f.invoke('save-text', 'Async-report.csv', 'NEWER REPORT', 'CSV', 'csv'); loaded.resolve();
    await expect(report).rejects.toThrow(/ERR_SAVE_STALE/); expect(await fs.readFile(file, 'utf8')).toBe('NEWER REPORT');
    expect(await f.invoke('save-admission-result', ticket)).toBeNull(); expect(f.dialog.showSaveDialog).toHaveBeenCalledTimes(2); idle(f);
  });
  it('keeps an early async text ticket older than a later PDF on the same native target', async () => {
    const f = setup(), file = path.join(dir, 'Shared-output.bin'), ticket = await f.invoke('issue-save-admission', 'text-export');
    f.choices.push(file); await f.invoke('save-pdf', pdf('NEWER PDF'), 'Shared-output.pdf'); f.choices.push(file);
    await expect(f.invoke('save-text', 'Shared-output.csv', 'OLDER CSV', 'CSV', 'csv', { admission: ticket })).rejects.toThrow(/ERR_SAVE_STALE/);
    expect(new Uint8Array(await fs.readFile(file))).toEqual(pdf('NEWER PDF')); idle(f);
  });
  it('returns a consumed early text receipt without minting proofs or refreshing native drawing aliases', async () => {
    const f = setup(), original = path.join(dir, 'Original.dxf'), target = path.join(dir, 'Report.csv'); await fs.writeFile(original, nativeDxf); const opened = await f.open(original);
    const before = f.ctx.saveOrder.stats().openedSources, originalIdentity = await fs.realpath(original), ticket = await f.invoke('issue-save-admission', 'text-export'); f.choices.push(target);
    await expect(f.invoke('save-text', 'Report.csv', 'tag,count\nK1,2\n', 'CSV', 'csv', { admission: ticket })).resolves.toBe(target);
    expect(await f.invoke('save-admission-result', ticket)).toEqual({ path: target, identityPath: await fs.realpath(target) }); expect(await f.invoke('save-admission-result', ticket)).toBeNull();
    expect(f.ctx.saveOrder.stats().openedSources).toEqual(before); expect(await fs.realpath(original)).toBe(originalIdentity); expect(await fs.readFile(original, 'utf8')).toBe(nativeDxf);
    expect(f.registry.isWritable(original)).toBe(true); idle(f); await f.invoke('release-opened-source-proof', opened.openedSourceProof);
  });
  it('rejects malformed, wrong-kind, canceled and already-bound supplied text tickets before native picking or granting', async () => {
    const f = setup(), file = path.join(dir, 'Report.csv'), wrong = await f.invoke('issue-save-admission', 'pdf-export'), canceled = await f.invoke('issue-save-admission', 'text-export'), bound = await f.invoke('issue-save-admission', 'text-export');
    await f.invoke('cancel-save-admission', canceled, 'text-export'); f.registry.grant(file); await f.invoke('bind-save-admission', bound, 'text-export', file);
    for (const opts of [null, [], { admission: 3 }, { admission: '' }, { admission: 'forged' }, { admission: wrong }, { admission: canceled }, { admission: bound }]) await expect(f.invoke('save-text', 'Report.csv', 'CSV', 'CSV', 'csv', opts)).rejects.toThrow();
    expect(f.dialog.showSaveDialog).not.toHaveBeenCalled(); expect(f.registry.isKnown(path.join(dir, 'Unchosen.csv'))).toBe(false); expect(await fs.readdir(dir)).toEqual([]);
    await f.invoke('cancel-save-admission', wrong, 'pdf-export'); await f.invoke('cancel-save-admission', bound, 'text-export'); idle(f);
  });
  it('never accepts a renderer text pathname hint as a native choice or file grant', async () => {
    const f = setup(), unchosen = path.join(dir, 'Unchosen.csv'), ticket = await f.invoke('issue-save-admission', 'text-export');
    await expect(f.invoke('save-text', 'Report.csv', 'CSV', 'CSV', 'csv', { admission: ticket, path: unchosen })).rejects.toThrow(/Invalid text export admission options/);
    expect(f.dialog.showSaveDialog).not.toHaveBeenCalled(); expect(f.registry.isKnown(unchosen)).toBe(false); expect(await fs.readdir(dir)).toEqual([]);
    await f.invoke('cancel-save-admission', ticket, 'text-export'); idle(f);
  });
  it('rejects another host owner supplied text ticket before native picking', async () => {
    const first = setup(), second = setup(), ticket = await first.invoke('issue-save-admission', 'text-export');
    await expect(second.invoke('save-text', 'Foreign.csv', 'CSV', 'CSV', 'csv', { admission: ticket })).rejects.toThrow(/ERR_SAVE_TICKET/);
    expect(second.dialog.showSaveDialog).not.toHaveBeenCalled(); expect(await fs.readdir(dir)).toEqual([]); await first.invoke('cancel-save-admission', ticket, 'text-export'); idle(first); idle(second);
  });
  it('does not grant an early text native result after its same-owner ticket was canceled', async () => {
    const f = setup(), file = path.join(dir, 'Canceled-report.csv'), ticket = await f.invoke('issue-save-admission', 'text-export'), choice = deferred<SaveChoice>({ canceled: true }); f.choices.push(choice.promise);
    const choosing = f.invoke('save-text', 'Canceled-report.csv', 'CSV', 'CSV', 'csv', { admission: ticket }); await vi.waitFor(() => expect(f.dialog.showSaveDialog).toHaveBeenCalledOnce());
    await f.invoke('cancel-save-admission', ticket, 'text-export'); choice.resolve({ canceled: false, filePath: file });
    await expect(choosing).rejects.toThrow(/ERR_SAVE_TICKET/); expect(f.registry.isKnown(file)).toBe(false); expect(await fs.readdir(dir)).toEqual([]); idle(f);
  });
  it('preserves the early text kind when its native choice unexpectedly selects a project filename', async () => {
    const f = setup(), file = path.join(dir, 'Chosen.jcadproj.json'), ticket = await f.invoke('issue-save-admission', 'text-export'); await fs.writeFile(file, 'ORIGINAL'); f.choices.push(file);
    await f.invoke('save-text', 'Report.csv', '{"drawings":[]}', 'CSV', 'csv', { admission: ticket });
    expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('ORIGINAL'); expect(await f.invoke('save-admission-result', ticket)).toEqual({ path: file, identityPath: await fs.realpath(file) }); idle(f);
  });
});
