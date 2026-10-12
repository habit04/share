/** DWG copies preserve the working document and serialize exports to a shared destination. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import { readDxf } from '../src/io/dxf';
import { LIBRARY_SYMBOLS } from '../src/electrical/library';
import { withImportData, type ImportReport } from '../src/io/import-report';
import { exportDwgCopy, hasDwgExport, registerDwgExportCommand } from '../src/app/export-dwg';
import { captureRevision, saveQueue } from '../src/app/savequeue';
import { nativeMenuCommands } from '../scripts/native-menu-commands.mjs';

let Editor: typeof EditorType;
let counter = 0;
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

function setup() {
  counter += 1;
  const out = `C:\\drawings\\export-test-${counter}.dwg`;
  const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement);
  ed.doc.filePath = `C:\\drawings\\working-${counter}.dxf`;
  const writes: Array<{ path: string; text: string }> = [];
  const logs: string[] = [];
  ed.log = (text) => { logs.push(text); };
  const bridge: FileBridge = {
    platform: 'win32',
    openDxf: async () => null,
    saveDxf: vi.fn(async () => null),
    dwgExportStatus: vi.fn(async () => ({ available: true })),
    chooseDwgPath: vi.fn(async () => out),
    exportDwg: vi.fn(async (path, text) => { writes.push({ path, text }); return path; }),
  };
  ed.fileBridge = bridge;
  const confirm = vi.fn(async (_title: string, _message: string) => true);
  ed.ui = { pickSymbol: async () => null, editComponent: async () => null, ladderSettings: async (i) => i, textInput: async (_t, _l, i) => i, confirm };
  const drawingSaved = vi.fn();
  ed.hooks.drawingSaved = drawingSaved;
  const edit = (label: string) => ed.doc.addEntities([{ id: `t-${label}`, type: 'text', layer: '0', color: 'ByLayer', text: label, position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left' }]);
  return { ed, bridge, out, writes, logs, confirm, drawingSaved, edit };
}

function importOriginal(f: ReturnType<typeof setup>, action: 'dropped' | 'unsupported' = 'dropped') {
  const report: ImportReport = {
    format: 'DWG', sourcePath: f.out,
    counts: { CUSTOM: { [action]: 1 } },
    items: [{ type: 'CUSTOM', action, reason: 'not readable' }], omitted: 0, notes: [],
  };
  f.ed.doc.load(withImportData(new Drawing().snapshot, report), f.out);
}

describe('portable DWG export coordination', () => {
  it('registers a discoverable export command only for a capable Windows desktop bridge', async () => {
    const f = setup();
    const commandName = (command: string) => command.split(/\s+/)[0]!.toUpperCase();
    const sharedMenu = new Set([...nativeMenuCommands('linux'), ...nativeMenuCommands('darwin')].map(commandName));
    const windowsOnly = nativeMenuCommands('win32').map(commandName).filter((name) => !sharedMenu.has(name));
    expect(windowsOnly.length, 'Expected a Windows desktop-only menu branch.').toBeGreaterThan(0);
    for (const platform of [undefined, 'darwin', 'linux']) {
      f.bridge.platform = platform;
      expect(hasDwgExport(f.bridge)).toBe(false);
      registerDwgExportCommand(f.ed);
      expect(f.ed.commands.has('EXPORTDWG')).toBe(false);
      for (const name of windowsOnly) expect(f.ed.commands.has(name), `${name} must respect the desktop capability scope.`).toBe(false);
    }
    f.bridge.platform = 'win32';
    registerDwgExportCommand(f.ed);
    for (const name of windowsOnly) expect(f.ed.commands.has(name), `The Windows native menu dispatches ${name}; its production registrar must provide it.`).toBe(true);
    expect(f.ed.commands.get('EXPORTDWG')?.description).toMatch(/portable writer/);
    await f.ed.commands.get('EXPORTDWG')!.run(f.ed);
    expect(f.writes).toHaveLength(1);
    expect(f.bridge.saveDxf).not.toHaveBeenCalled();
    expect(hasDwgExport({ ...f.bridge, exportDwg: undefined })).toBe(false);
  });

  it('reports unavailable writers and unsupported editions before opening a picker', async () => {
    const f = setup();
    f.bridge.dwgExportStatus = vi.fn(async () => ({ available: false, reason: 'Writer integrity check failed.' }));
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.logs.join('\n')).toMatch(/Writer integrity check failed/);
    expect(f.bridge.chooseDwgPath).not.toHaveBeenCalled();
    f.bridge.platform = 'linux';
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.logs.join('\n')).toMatch(/Windows desktop edition/);
    expect(f.writes).toEqual([]);
  });

  it('does not write after a canceled destination dialog', async () => {
    const f = setup();
    f.edit('before');
    const state = f.ed.doc.snapshot;
    f.bridge.chooseDwgPath = async () => null;
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.ed.doc.snapshot).toBe(state);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.drawingSaved).not.toHaveBeenCalled();
  });

  it('exports pruned DXF without rebinding, marking clean, or changing history and recovery bookkeeping', async () => {
    const f = setup();
    f.edit('captured');
    const state = f.ed.doc.snapshot;
    const path = f.ed.doc.filePath;
    const history = f.ed.doc.history;
    expect(await exportDwgCopy(f.ed)).toBe(true);
    expect(f.ed.doc.snapshot).toBe(state);
    expect(f.ed.doc.filePath).toBe(path);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.ed.doc.history).toEqual(history);
    expect(f.drawingSaved).not.toHaveBeenCalled();
    const copy = readDxf(f.writes[0]!.text);
    expect(copy.entities.map((e) => e.type === 'text' && e.text)).toEqual(['captured']);
    expect(copy.blocks[LIBRARY_SYMBOLS[0]!.name]).toBeUndefined();
    expect(Object.keys(copy.blocks).length).toBeLessThan(Object.keys(state.blocks).length);
    expect(copy.blocks.WD_TITLEBLOCK).toBeDefined(); // Drawing-private blocks are retained.
    expect(f.logs.join('\n')).toMatch(/Save the working drawing separately as DXF/);
  });

  it('preserves an already clean DXF document as clean after exporting', async () => {
    const f = setup();
    const path = f.ed.doc.filePath;
    expect(f.ed.doc.dirty).toBe(false);
    expect(await exportDwgCopy(f.ed)).toBe(true);
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.ed.doc.filePath).toBe(path);
    expect(f.drawingSaved).not.toHaveBeenCalled();
  });

  it('reports conversion errors while leaving all drawing and recovery state intact', async () => {
    const f = setup();
    f.edit('unsaved');
    const state = f.ed.doc.snapshot;
    f.bridge.exportDwg = async () => { throw new Error('DWG output validation failed.'); };
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.logs.join('\n')).toMatch(/DWG export failed.*output validation failed.*recovery copy are kept/s);
    expect(f.ed.doc.snapshot).toBe(state);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.drawingSaved).not.toHaveBeenCalled();
  });

  it('keeps edits made while conversion runs out of the captured copy and still dirty', async () => {
    const f = setup();
    f.edit('captured');
    const gate = deferred<string>();
    f.bridge.exportDwg = vi.fn(async (path, text) => { f.writes.push({ path, text }); return gate.promise; });
    const pending = exportDwgCopy(f.ed);
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    f.edit('later');
    gate.resolve(f.out);
    expect(await pending).toBe(true);
    expect(f.writes[0]!.text).toContain('captured');
    expect(f.writes[0]!.text).not.toContain('later');
    expect(f.ed.doc.entities).toHaveLength(2);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.logs.join('\n')).toMatch(/edits made during export are not in this copy/);
    expect(f.drawingSaved).not.toHaveBeenCalled();
  });

  it.each(['edit', 'replace'] as const)('cancels when a destination dialog is pending and the drawing changes: %s', async (change) => {
    const f = setup();
    const gate = deferred<string>();
    f.bridge.chooseDwgPath = vi.fn(async () => gate.promise);
    const pending = exportDwgCopy(f.ed);
    await vi.waitFor(() => expect(f.bridge.chooseDwgPath).toHaveBeenCalled());
    if (change === 'edit') f.edit('changed');
    else f.ed.doc.load(new Drawing().snapshot, 'C:\\drawings\\replacement.dxf');
    gate.resolve(f.out);
    expect(await pending).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.logs.join('\n')).toMatch(/drawing changed or closed/);
  });

  it('checks the captured revision after awaiting writer availability', async () => {
    const f = setup();
    const gate = deferred<{ available: boolean }>();
    f.bridge.dwgExportStatus = async () => gate.promise;
    const pending = exportDwgCopy(f.ed);
    f.edit('newer');
    gate.resolve({ available: true });
    expect(await pending).toBe(false);
    expect(f.bridge.chooseDwgPath).not.toHaveBeenCalled();
  });

  it('never changes a replacement document after an older export finishes', async () => {
    const f = setup();
    f.edit('old');
    const gate = deferred<string>();
    f.bridge.exportDwg = vi.fn(async () => gate.promise);
    const pending = exportDwgCopy(f.ed);
    await vi.waitFor(() => expect(f.bridge.exportDwg).toHaveBeenCalled());
    f.ed.doc.load(new Drawing().snapshot, 'C:\\drawings\\replacement-after.dxf');
    const replacement = f.ed.doc.snapshot;
    gate.resolve(f.out);
    expect(await pending).toBe(true);
    expect(f.ed.doc.snapshot).toBe(replacement);
    expect(f.ed.doc.filePath).toBe('C:\\drawings\\replacement-after.dxf');
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.drawingSaved).not.toHaveBeenCalled();
    expect(f.logs.join('\n')).toMatch(/closed or was replaced meanwhile/);
  });

  it.each(['dropped', 'unsupported'] as const)('asks before replacing the imported source containing %s content', async (action) => {
    const f = setup();
    importOriginal(f, action);
    expect(await exportDwgCopy(f.ed)).toBe(true);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.confirm.mock.calls[0]![0]).toBe('Replace the original DWG?');
    expect(f.confirm.mock.calls[0]![1]).toMatch(/cannot recover content already lost during import/);
    expect(await exportDwgCopy(f.ed)).toBe(true);
    expect(f.confirm).toHaveBeenCalledTimes(2); // Prior export/SAVE approval is never reused.
  });

  it('declining source replacement chooses a copy and preserves the original', async () => {
    const f = setup();
    importOriginal(f);
    f.confirm.mockResolvedValue(false);
    const copy = f.out.replace('.dwg', '-copy.dwg');
    let choice = 0;
    f.bridge.chooseDwgPath = async () => choice++ === 0 ? f.out : copy;
    expect(await exportDwgCopy(f.ed)).toBe(true);
    expect(f.writes.map((w) => w.path)).toEqual([copy]);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.ed.doc.filePath).toBe(f.out);
  });

  it('rejects a replacement document while the import loss confirmation is pending', async () => {
    const f = setup();
    importOriginal(f);
    f.ed.ui!.confirm = async () => { f.ed.doc.load(new Drawing().snapshot, null); return true; };
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.writes).toEqual([]);
  });

  it('cannot overwrite a lossy source without a confirmation interface', async () => {
    const f = setup();
    importOriginal(f);
    f.ed.ui = null;
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.writes).toEqual([]);
  });

  it('orders two exports to the same path and writes the newest captured revision last', async () => {
    const f = setup();
    f.edit('first');
    const gate = deferred<string>();
    f.bridge.exportDwg = vi.fn(async (path, text) => { f.writes.push({ path, text }); return f.writes.length === 1 ? gate.promise : path; });
    const first = exportDwgCopy(f.ed);
    await vi.waitFor(() => expect(f.writes).toHaveLength(1));
    f.edit('second');
    const second = exportDwgCopy(f.ed);
    await vi.waitFor(() => expect(f.bridge.chooseDwgPath).toHaveBeenCalledTimes(2));
    expect(f.writes).toHaveLength(1);
    gate.resolve(f.out);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(f.writes).toHaveLength(2);
    expect(f.writes[0]!.text).not.toContain('second');
    expect(f.writes[1]!.text).toContain('second');
  });

  it('drops an older export whose destination dialog finished after a newer export', async () => {
    const f = setup();
    const gate = deferred<string>();
    let n = 0;
    f.bridge.chooseDwgPath = vi.fn(async () => ++n === 1 ? gate.promise : f.out);
    const older = exportDwgCopy(f.ed);
    await vi.waitFor(() => expect(f.bridge.chooseDwgPath).toHaveBeenCalledTimes(1));
    expect(await exportDwgCopy(f.ed)).toBe(true);
    gate.resolve(f.out);
    expect(await older).toBe(false);
    expect(f.writes).toHaveLength(1);
    expect(f.logs.join('\n')).toMatch(/newer drawing revision was already written/);
  });

  it('rechecks an acknowledged source after waiting behind a write to that same file', async () => {
    const f = setup();
    importOriginal(f);
    const gate = deferred<string>();
    const blocker = saveQueue.run(f.out, captureRevision(), () => gate.promise);
    const pending = exportDwgCopy(f.ed);
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(1));
    f.edit('unsafe-new-revision');
    gate.resolve(f.out);
    await blocker;
    expect(await pending).toBe(false);
    expect(f.writes).toEqual([]);
  });

  it('cancels a queued copy after its source tab has been closed', async () => {
    const f = setup();
    const source = f.ed.sessions.current;
    const gate = deferred<string>();
    const blocker = saveQueue.run(f.out, captureRevision(), () => gate.promise);
    const pending = exportDwgCopy(f.ed);
    await vi.waitFor(() => expect(f.bridge.chooseDwgPath).toHaveBeenCalled());
    f.ed.sessions.add();
    f.ed.sessions.close(f.ed.sessions.all.findIndex((s) => s.id === source.id));
    gate.resolve(f.out);
    await blocker;
    expect(await pending).toBe(false);
    expect(f.writes).toEqual([]);
  });

});
