/** Normal SAVE / SAVEAS use the portable writer and the same revision-safe bookkeeping as DXF. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import { readDxf } from '../src/io/dxf';
import { withImportData, type ImportReport } from '../src/io/import-report';
import { captureRevision, saveQueue } from '../src/app/savequeue';

let Editor: typeof EditorType;
let sequence = 0;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function setup(format: 'dxf' | 'dwg' = 'dwg') {
  sequence += 1;
  const original = `C:\\drawings\\normal-save-${sequence}.${format}`;
  const out = `C:\\drawings\\normal-save-as-${sequence}.dwg`;
  const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement);
  ed.doc.filePath = original;
  const writes: Array<{ format: string; path: string; text: string }> = [];
  const logs: string[] = [];
  ed.log = (text) => { logs.push(text); };
  const bridge: FileBridge = {
    platform: 'win32',
    openDxf: async () => null,
    chooseDrawingPath: vi.fn(async () => out),
    saveDxf: vi.fn(async (path, text) => { const destination = path ?? original.replace(/\.dwg$/, '.dxf'); writes.push({ format: 'dxf', path: destination, text }); return destination; }),
    dwgExportStatus: vi.fn(async () => ({ available: true })),
    saveDwg: vi.fn(async (path, text) => { writes.push({ format: 'dwg', path, text }); return path; }),
    exportDwg: vi.fn(async () => null),
  };
  ed.fileBridge = bridge;
  const confirm = vi.fn(async (_title: string, _message: string) => true);
  ed.ui = { pickSymbol: async () => null, editComponent: async () => null, ladderSettings: async (i) => i, textInput: async (_t, _l, i) => i, confirm };
  const drawingSaved = vi.fn();
  ed.hooks.drawingSaved = drawingSaved;
  const edit = (label: string) => ed.doc.addEntities([{ id: `save-${label}`, type: 'text', layer: '0', color: 'ByLayer', text: label, position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left' }]);
  return { ed, bridge, original, out, writes, logs, confirm, drawingSaved, edit };
}

function imported(f: ReturnType<typeof setup>, action: 'dropped' | 'unsupported' = 'dropped') {
  const report: ImportReport = { format: 'DWG', sourcePath: f.original, counts: { CUSTOM: { [action]: 1 } }, items: [{ type: 'CUSTOM', action, reason: 'not readable' }], omitted: 0, notes: [] };
  f.ed.doc.load(withImportData(new Drawing().snapshot, report), f.original);
  f.edit('imported');
}

describe('normal DWG saves in the editor', () => {
  it('saves an existing DWG through the portable writer and marks precisely that revision saved', async () => {
    const f = setup();
    f.edit('captured');
    const state = f.ed.doc.snapshot;
    const history = f.ed.doc.history();
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.writes.map(({ format, path }) => ({ format, path }))).toEqual([{ format: 'dwg', path: f.original }]);
    expect(readDxf(f.writes[0]!.text).entities).toHaveLength(1);
    expect(f.bridge.chooseDrawingPath).not.toHaveBeenCalled();
    expect(f.bridge.saveDxf).not.toHaveBeenCalled();
    expect(f.bridge.exportDwg).not.toHaveBeenCalled();
    expect(f.ed.doc.snapshot).toBe(state);
    expect(f.ed.doc.history()).toEqual(history);
    expect(f.ed.doc.filePath).toBe(f.original);
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.drawingSaved).toHaveBeenCalledWith(f.ed.sessions.activeId, state, f.original);
  });

  it('SAVEAS can select DWG then DXF, and the next SAVE uses the selected format and binding', async () => {
    const f = setup('dxf');
    f.edit('dwg-copy');
    expect(await f.ed.saveFile(true)).toBe(true);
    expect(f.ed.doc.filePath).toBe(f.out);
    f.edit('second-dwg-save');
    expect(await f.ed.saveFile(false)).toBe(true);
    const dxf = f.out.replace(/\.dwg$/, '.dxf');
    f.bridge.chooseDrawingPath = vi.fn(async () => dxf);
    f.edit('dxf-copy');
    expect(await f.ed.saveFile(true)).toBe(true);
    expect(f.ed.doc.filePath).toBe(dxf);
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.writes.map(({ format, path }) => ({ format, path }))).toEqual([{ format: 'dwg', path: f.out }, { format: 'dwg', path: f.out }, { format: 'dxf', path: dxf }]);
    expect(f.bridge.dwgExportStatus).toHaveBeenCalledTimes(2);
    expect(f.drawingSaved).toHaveBeenCalledTimes(3);
  });

  it('keeps the working binding, dirty state, history and recovery hook after destination cancellation', async () => {
    const f = setup('dxf');
    f.edit('unsaved');
    const state = f.ed.doc.snapshot, history = f.ed.doc.history();
    f.bridge.chooseDrawingPath = async () => null;
    expect(await f.ed.saveFile(true)).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.ed.doc.snapshot).toBe(state);
    expect(f.ed.doc.history()).toEqual(history);
    expect(f.ed.doc.filePath).toBe(f.original);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.drawingSaved).not.toHaveBeenCalled();
  });

  it.each(['unavailable', 'refused', 'canceled'] as const)('does not mark the drawing saved when DWG conversion is %s', async (failure) => {
    const f = setup();
    f.edit('unsaved');
    const state = f.ed.doc.snapshot, history = f.ed.doc.history();
    if (failure === 'unavailable') f.bridge.dwgExportStatus = async () => ({ available: false, reason: 'Writer integrity check failed.' });
    else if (failure === 'refused') f.bridge.saveDwg = async () => { throw new Error('Cannot preserve retained 3DSOLID objects. Save DXF.'); };
    else f.bridge.saveDwg = async () => null;
    expect(await f.ed.saveFile(false)).toBe(false);
    expect(f.bridge.saveDxf).not.toHaveBeenCalled();
    expect(f.ed.doc.snapshot).toBe(state);
    expect(f.ed.doc.history()).toEqual(history);
    expect(f.ed.doc.filePath).toBe(f.original);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.drawingSaved).not.toHaveBeenCalled();
    if (failure === 'unavailable') expect(f.ed.lastFileError).toMatch(/Writer integrity check failed/);
    if (failure === 'refused') expect(f.ed.lastFileError).toMatch(/3DSOLID/);
  });

  it('offers Save As after a DWG failure and can recover by saving DXF', async () => {
    const f = setup();
    f.edit('unsaved');
    f.bridge.saveDwg = vi.fn(async () => { throw new Error('Portable writer refused this drawing.'); });
    const dxf = f.out.replace(/\.dwg$/, '.dxf');
    f.bridge.chooseDrawingPath = async () => dxf;
    f.ed.hooks.saveError = vi.fn(async () => 'saveas' as const);
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.bridge.saveDwg).toHaveBeenCalledTimes(1);
    expect(f.writes.map((write) => write.path)).toEqual([dxf]);
    expect(f.ed.doc.filePath).toBe(dxf);
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.drawingSaved).toHaveBeenCalledTimes(1);
  });

  it.each(['linux', 'darwin', undefined])('keeps DXF saving in editions without Windows DWG capability: %s', async (platform) => {
    const f = setup();
    f.bridge.platform = platform;
    const dxf = f.out.replace(/\.dwg$/, '.dxf');
    f.bridge.chooseDrawingPath = vi.fn(async () => dxf);
    f.edit('dxfcopy');
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.bridge.chooseDrawingPath).toHaveBeenCalledWith(f.original.split(/[\\/]/).pop()!.replace(/\.dwg$/, '.dxf'));
    expect(f.bridge.dwgExportStatus).not.toHaveBeenCalled();
    expect(f.bridge.saveDwg).not.toHaveBeenCalled();
    expect(f.writes.map((write) => write.format)).toEqual(['dxf']);
    expect(f.ed.doc.filePath).toBe(dxf);
  });

  it('does not use a DXF writer for a DWG selection on an incapable bridge', async () => {
    const f = setup('dxf');
    f.bridge.saveDwg = undefined;
    f.edit('unsaved');
    expect(await f.ed.saveFile(true)).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.ed.doc.filePath).toBe(f.original);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.ed.lastFileError).toMatch(/Windows desktop edition/);
  });

  it('explicit DXF Save As restricts the picker and never invokes the DWG writer', async () => {
    const f = setup();
    f.edit('dxfsnapshot');
    const dxf = f.out.replace(/\.dwg$/, '.dxf');
    f.bridge.chooseDrawingPath = vi.fn(async () => dxf);
    expect(await f.ed.saveFile(true, 'dxf')).toBe(true);
    expect(f.bridge.chooseDrawingPath).toHaveBeenCalledWith(f.original.split(/[\\/]/).pop()!.replace(/\.dwg$/, '.dxf'), 'dxf');
    expect(f.bridge.saveDwg).not.toHaveBeenCalled();
    expect(f.bridge.dwgExportStatus).not.toHaveBeenCalled();
    expect(f.writes.map((write) => write.format)).toEqual(['dxf']);
    expect(f.ed.doc.filePath).toBe(dxf);
    expect(f.ed.doc.dirty).toBe(false);
  });

  it('rejects a DWG destination returned to an explicit DXF picker before writing anything', async () => {
    const f = setup();
    f.edit('unsaved');
    expect(await f.ed.saveFile(true, 'dxf')).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.bridge.dwgExportStatus).not.toHaveBeenCalled();
    expect(f.ed.doc.filePath).toBe(f.original);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.drawingSaved).not.toHaveBeenCalled();
    expect(f.ed.lastFileError).toMatch(/DXF save destination/);
  });

  it('preserves the explicit DXF picker restriction when retrying a failed save', async () => {
    const f = setup();
    f.edit('retry');
    const dxf = f.out.replace(/\.dwg$/, '.dxf');
    f.bridge.chooseDrawingPath = vi.fn(async () => dxf);
    let writes = 0;
    f.bridge.saveDxf = vi.fn(async () => {
      if (++writes === 1) throw new Error('Disk unavailable.');
      return dxf;
    });
    f.ed.hooks.saveError = async () => 'retry';
    expect(await f.ed.saveFile(true, 'dxf')).toBe(true);
    expect(f.bridge.chooseDrawingPath).toHaveBeenCalledTimes(2);
    for (const args of vi.mocked(f.bridge.chooseDrawingPath!).mock.calls) expect(args[1]).toBe('dxf');
    expect(f.bridge.saveDwg).not.toHaveBeenCalled();
    expect(f.drawingSaved).toHaveBeenCalledTimes(1);
  });

  it('keeps edits made during conversion dirty and checkpoints only the captured revision', async () => {
    const f = setup();
    f.edit('captured');
    const state = f.ed.doc.snapshot;
    const gate = deferred<string>();
    f.bridge.saveDwg = vi.fn(async (path, text) => { f.writes.push({ format: 'dwg', path, text }); return gate.promise; });
    const pending = f.ed.saveFile(false);
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    f.edit('later');
    gate.resolve(f.original);
    expect(await pending).toBe(true);
    expect(f.writes[0]!.text).not.toContain('later');
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.drawingSaved).toHaveBeenCalledWith(f.ed.sessions.activeId, state, f.original);
  });

  it('serializes two saves to one DWG destination and leaves the newest revision clean', async () => {
    const f = setup();
    f.edit('first');
    const gate = deferred<string>();
    f.bridge.saveDwg = vi.fn(async (path, text) => { f.writes.push({ format: 'dwg', path, text }); return f.writes.length === 1 ? gate.promise : path; });
    const first = f.ed.saveFile(false);
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    f.edit('second');
    const second = f.ed.saveFile(false);
    expect(f.writes).toHaveLength(1);
    gate.resolve(f.original);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[0]!.text).not.toContain('second');
    expect(f.writes[1]!.text).toContain('second');
    expect(f.ed.doc.filePath).toBe(f.original);
    expect(f.ed.doc.dirty).toBe(false);
  });

  it('an older DWG completion cannot replace a newer DXF Save As binding or recovery checkpoint', async () => {
    const f = setup();
    f.edit('older-dwg');
    const gate = deferred<string>();
    f.bridge.saveDwg = async () => gate.promise;
    const older = f.ed.saveFile(false);
    await vi.waitFor(() => expect(f.bridge.dwgExportStatus).toHaveBeenCalled());
    f.edit('newer-dxf');
    const state = f.ed.doc.snapshot;
    const dxf = f.out.replace(/\.dwg$/, '.dxf');
    f.bridge.chooseDrawingPath = async () => dxf;
    expect(await f.ed.saveFile(true)).toBe(true);
    gate.resolve(f.original);
    expect(await older).toBe(true);
    expect(f.ed.doc.filePath).toBe(dxf);
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.drawingSaved).toHaveBeenCalledTimes(1);
    expect(f.drawingSaved).toHaveBeenCalledWith(f.ed.sessions.activeId, state, dxf);
  });

  it('drops an older Save As whose destination dialog finishes after a newer save of that DWG', async () => {
    const f = setup();
    f.edit('old');
    const gate = deferred<string>();
    f.bridge.chooseDrawingPath = vi.fn(async () => gate.promise);
    const older = f.ed.saveFile(true);
    await vi.waitFor(() => expect(f.bridge.chooseDrawingPath).toHaveBeenCalled());
    f.edit('new');
    expect(await f.ed.saveFile(false)).toBe(true);
    gate.resolve(f.original);
    expect(await older).toBe(false);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.text).toContain('new');
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.drawingSaved).toHaveBeenCalledTimes(1);
  });

  it('does not rebind or checkpoint a replacement document when conversion already in progress finishes', async () => {
    const f = setup();
    f.edit('old');
    const gate = deferred<string>();
    f.bridge.saveDwg = vi.fn(async () => gate.promise);
    const pending = f.ed.saveFile(false);
    await vi.waitFor(() => expect(f.bridge.saveDwg).toHaveBeenCalled());
    const replacementPath = f.original.replace(/\.dwg$/, '-replacement.dxf');
    f.ed.doc.load(new Drawing().snapshot, replacementPath);
    const state = f.ed.doc.snapshot, history = f.ed.doc.history();
    gate.resolve(f.original);
    expect(await pending).toBe(true);
    expect(f.ed.doc.filePath).toBe(replacementPath);
    expect(f.ed.doc.snapshot).toBe(state);
    expect(f.ed.doc.history()).toEqual(history);
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.drawingSaved).not.toHaveBeenCalled();
  });

  it('cancels a queued save when its source tab closes before the writer starts', async () => {
    const f = setup();
    f.edit('closed');
    const source = f.ed.sessions.current;
    const gate = deferred<string>();
    const blocker = saveQueue.run(f.original, captureRevision(), () => gate.promise);
    const pending = f.ed.saveFile(false);
    f.ed.sessions.add();
    f.ed.sessions.close(f.ed.sessions.all.findIndex((session) => session === source));
    gate.resolve(f.original);
    await blocker;
    expect(await pending).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.drawingSaved).not.toHaveBeenCalled();
  });

  it('warns before normal Save overwrites a DWG with unsupported import content', async () => {
    const f = setup();
    imported(f, 'unsupported');
    f.confirm.mockResolvedValue(false);
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.confirm.mock.calls[0]![0]).toBe('Save over the original file?');
    expect(f.writes.map((write) => write.path)).toEqual([f.out]);
    expect(f.ed.doc.filePath).toBe(f.out);
  });

  it('refuses normal Save over a DWG whose import dropped content (partial import)', async () => {
    const f = setup();
    imported(f, 'dropped');
    expect(await f.ed.saveFile(false)).toBe(false);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    expect(f.ed.doc.filePath).toBe(f.original);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.ed.lastFileError).toMatch(/partial import/);
    expect(f.logs.join('\n')).toMatch(/Not saved: .*partial import/);
    expect(f.drawingSaved).not.toHaveBeenCalled();
  });

  it('refuses a queued lossy-source save without asking, even after a revision change', async () => {
    const f = setup();
    imported(f);
    const gate = deferred<string>();
    const blocker = saveQueue.run(f.original, captureRevision(), () => gate.promise);
    const pending = f.ed.saveFile(false);
    f.edit('unreviewed');
    gate.resolve(f.original);
    await blocker;
    expect(await pending).toBe(false);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.drawingSaved).not.toHaveBeenCalled();
  });

  it('cancels an acknowledged unsupported-source save after a queued revision changes', async () => {
    const f = setup();
    imported(f, 'unsupported');
    const gate = deferred<string>();
    const blocker = saveQueue.run(f.original, captureRevision(), () => gate.promise);
    const pending = f.ed.saveFile(false);
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(1));
    f.edit('unreviewed');
    gate.resolve(f.original);
    await blocker;
    expect(await pending).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.drawingSaved).not.toHaveBeenCalled();
  });

  it('does not save a replaced tab while writer availability is pending', async () => {
    const f = setup();
    f.edit('old');
    const gate = deferred<{ available: boolean }>();
    f.bridge.dwgExportStatus = vi.fn(async () => gate.promise);
    const pending = f.ed.saveFile(false);
    await vi.waitFor(() => expect(f.bridge.dwgExportStatus).toHaveBeenCalled());
    const replacementPath = f.original.replace(/\.dwg$/, '-replacement.dxf');
    f.ed.doc.load(new Drawing().snapshot, replacementPath);
    gate.resolve({ available: true });
    expect(await pending).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.ed.doc.filePath).toBe(replacementPath);
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.drawingSaved).not.toHaveBeenCalled();
  });
});
