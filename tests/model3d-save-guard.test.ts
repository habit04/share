/** Saving drawings with experimental 3D solids: the warning text and the confirm in every save path. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import { readDxf } from '../src/io/dxf';
import { exportDwgCopy } from '../src/app/export-dwg';
import { Autosaver, type AutosaveMeta, type AutosaveSession, type AutosaveStore } from '../src/app/autosave';
import { newDocumentId } from '../src/app/sessions';
import { MODEL3D_NO_UI_REASON, MODEL3D_SAVED_WITHOUT, model3dSaveWarning } from '../src/model3d/save-guard';
import { addSolids, model3dOf, newSolid, withModel3D } from '../src/model3d/model';
import { boxMesh } from '../src/model3d/primitives';
import { MemFs } from './helpers/memfs';
import { Rng } from './helpers/fuzz';

let Editor: typeof EditorType;
let counter = 0;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});

const solid = () => newSolid({ mesh: boxMesh(1, 1, 1), feature: { kind: 'mesh', source: 'edited' } });

function setup(answer: boolean) {
  counter += 1;
  const dxf = `C:\\drawings\\guard-${counter}.dxf`;
  const dwg = `C:\\drawings\\guard-${counter}.dwg`;
  const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }) } as unknown as HTMLCanvasElement);
  ed.doc.filePath = dxf;
  const writes: Array<{ format: string; path: string; text: string }> = [];
  const logs: string[] = [];
  ed.log = (text) => { logs.push(text); };
  const bridge: FileBridge = {
    platform: 'win32',
    openDxf: async () => null,
    chooseDrawingPath: vi.fn(async () => dwg),
    saveDxf: vi.fn(async (path, text) => { writes.push({ format: 'dxf', path: path ?? dxf, text }); return path ?? dxf; }),
    dwgExportStatus: vi.fn(async () => ({ available: true })),
    saveDwg: vi.fn(async (path, text) => { writes.push({ format: 'dwg', path, text }); return path; }),
    chooseDwgPath: vi.fn(async () => dwg),
    exportDwg: vi.fn(async (path, text) => { writes.push({ format: 'export', path, text }); return path; }),
  };
  ed.fileBridge = bridge;
  const confirm = vi.fn(async (_title: string, _message: string) => answer);
  ed.ui = { pickSymbol: async () => null, editComponent: async () => null, ladderSettings: async (i) => i, textInput: async (_t, _l, i) => i, confirm };
  const drawingSaved = vi.fn();
  ed.hooks.drawingSaved = drawingSaved;
  ed.doc.addEntities([{ id: `t-${counter}`, type: 'text', layer: '0', color: 'ByLayer', text: 'flat', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left' }]);
  const add3d = (n = 1) => ed.doc.transact((s) => withModel3D(s, addSolids(model3dOf(s), Array.from({ length: n }, solid))));
  return { ed, bridge, writes, logs, confirm, drawingSaved, add3d, dxf, dwg };
}

describe('model3dSaveWarning', () => {
  it('is null without solids and counts them otherwise', () => {
    const plain = new Drawing().snapshot;
    expect(model3dSaveWarning(plain)).toBeNull();
    expect(model3dSaveWarning({ ...plain, model3d: { version: 1, solids: [] } })).toBeNull();
    const one = withModel3D(plain, addSolids(model3dOf(plain), [solid()]));
    expect(model3dSaveWarning(one)).toBe('This drawing contains 1 experimental 3D object. 3D objects are not written to DXF or DWG files in this version and will be lost in the saved file. Save without them?');
    const three = withModel3D(plain, addSolids(model3dOf(plain), [solid(), solid(), solid()]));
    expect(model3dSaveWarning(three)).toMatch(/^This drawing contains 3 experimental 3D objects\. .* Save without them\?$/);
  });
});

describe('save flows with 3D solids', () => {
  it('a 2D-only save never asks and marks the drawing clean', async () => {
    const f = setup(false);
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(1);
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.drawingSaved).toHaveBeenCalledTimes(1);
  });

  it('No cancels a DXF save, keeps the drawing modified and records no file error', async () => {
    const f = setup(false);
    f.add3d(2);
    expect(await f.ed.saveFile(false)).toBe(false);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.confirm.mock.calls[0]![1]).toMatch(/contains 2 experimental 3D objects/);
    expect(f.writes).toEqual([]);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.ed.lastFileError).toBeNull();
    expect(f.logs.join('\n')).toMatch(/Not saved/);
  });

  it('Yes writes the 2D content, binds the file, but keeps the drawing modified and its recovery copy', async () => {
    const f = setup(true);
    f.add3d();
    f.ed.doc.filePath = null;
    f.bridge.chooseDrawingPath = vi.fn(async () => f.dxf);
    const state = f.ed.doc.snapshot;
    expect(await f.ed.saveFile(true)).toBe(true);
    expect(f.writes.map((w) => w.format)).toEqual(['dxf']);
    expect(readDxf(f.writes[0]!.text).entities).toHaveLength(1);
    expect(f.ed.doc.snapshot).toBe(state);
    expect(f.ed.doc.snapshot.model3d?.solids).toHaveLength(1);
    expect(f.ed.doc.filePath).toBe(f.dxf);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.ed.sessions.isDirty(f.ed.sessions.active)).toBe(true);
    expect(f.drawingSaved).not.toHaveBeenCalled();
    expect(f.logs).toContain(MODEL3D_SAVED_WITHOUT);
    // The same unchanged state was already approved.
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.ed.doc.dirty).toBe(true);
  });

  it('refuses without an interface instead of dropping the solids silently', async () => {
    const f = setup(true);
    f.add3d();
    f.ed.ui = null;
    expect(await f.ed.saveFile(false)).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.ed.lastFileError).toBe(MODEL3D_NO_UI_REASON);
    expect(f.logs.join('\n')).toContain(MODEL3D_NO_UI_REASON);
    expect(f.ed.doc.dirty).toBe(true);
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.bridge.chooseDwgPath).not.toHaveBeenCalled();
  });

  it('abandons the save when the drawing changes while the question is open', async () => {
    const f = setup(true);
    f.add3d();
    f.confirm.mockImplementationOnce(async () => {
      f.add3d();
      return true;
    });
    expect(await f.ed.saveFile(false)).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.ed.lastFileError).toMatch(/changed or closed/);
    // The stale answer was not recorded: the current state asks again.
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.confirm).toHaveBeenCalledTimes(2);
  });

  it('Retry after a failed write and a later DWG export reuse the answer for the same state', async () => {
    const f = setup(true);
    f.add3d();
    const save = f.bridge.saveDxf as ReturnType<typeof vi.fn>;
    save.mockRejectedValueOnce(new Error('disk full'));
    f.ed.hooks.saveError = vi.fn(async () => 'retry' as const);
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.ed.hooks.saveError).toHaveBeenCalledTimes(1);
    expect(f.writes.map((w) => w.format)).toEqual(['dxf']);
    expect(await exportDwgCopy(f.ed)).toBe(true);
    expect(f.writes.map((w) => w.format)).toEqual(['dxf', 'export']);
    expect(f.confirm).toHaveBeenCalledTimes(1);
  });

  it('asks before a DWG save as well', async () => {
    const f = setup(false);
    f.add3d();
    expect(await f.ed.saveFile(true)).toBe(false);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.bridge.chooseDrawingPath).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    f.confirm.mockResolvedValue(true);
    expect(await f.ed.saveFile(true)).toBe(true);
    expect(f.writes.map((w) => w.format)).toEqual(['dwg']);
    expect(f.ed.doc.dirty).toBe(true);
  });

  it('asks before a DWG export copy; No cancels without a file error', async () => {
    const f = setup(false);
    f.add3d();
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.bridge.chooseDwgPath).not.toHaveBeenCalled();
    expect(f.ed.lastFileError).toBeNull();
    f.confirm.mockResolvedValue(true);
    expect(await exportDwgCopy(f.ed)).toBe(true);
    expect(f.writes.map((w) => w.format)).toEqual(['export']);
  });

  it('export abandons a stale state when the drawing changes during the question', async () => {
    const f = setup(true);
    f.add3d();
    f.confirm.mockImplementationOnce(async () => {
      f.add3d();
      return true;
    });
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.writes).toEqual([]);
    expect(f.logs.join('\n')).toMatch(/changed or closed/);
  });
});

describe('autosave with 3D solids', () => {
  function run(state: Drawing['snapshot']) {
    const session: AutosaveSession = { id: 1, docId: newDocumentId(), dirty: true, state, filePath: null, untitledName: 'Drawing1.dxf' };
    const written: Array<{ text: string; meta: AutosaveMeta }> = [];
    const store: AutosaveStore = { write: async (_n, text, meta) => { written.push({ text, meta }); }, list: async () => [], read: async () => null, remove: async () => {} };
    const saver = new Autosaver({ all: [session] }, store, () => 0);
    const errors = vi.fn();
    saver.onError = errors;
    return { saver, written, errors };
  }

  it('writes a recovery copy without asking and records the omitted solids', async () => {
    const doc = new Drawing();
    doc.transact((s) => withModel3D(s, addSolids(model3dOf(s), [solid(), solid()])));
    const r = run(doc.snapshot);
    expect(await r.saver.runNow()).toBe(1);
    expect(r.errors).not.toHaveBeenCalled();
    expect(r.written).toHaveLength(1);
    expect(() => readDxf(r.written[0]!.text)).not.toThrow();
    expect(r.written[0]!.meta.omitted3d).toBe(2);
  });

  it('2D-only recovery metadata is unchanged', async () => {
    const r = run(new Drawing().snapshot);
    await r.saver.runNow();
    expect('omitted3d' in r.written[0]!.meta).toBe(false);
  });

  it('the desktop recovery index keeps the count and ignores junk', async () => {
    const require = createRequire(import.meta.url);
    const { createAutosaveStore } = require('../electron/autosave-store.cjs') as { createAutosaveStore(dir: string, deps: { fs: MemFs }): AutosaveStore };
    const store = createAutosaveStore('/data/autosave', { fs: new MemFs(new Rng(3)) });
    await store.write('11111111-1111-4111-8111-111111111111.sv.dxf', 'A', { originalPath: null, title: 'a.dxf', savedAt: 5, omitted3d: 3 });
    await store.write('22222222-2222-4222-8222-222222222222.sv.dxf', 'B', { originalPath: null, title: 'b.dxf', savedAt: 4, omitted3d: -1 });
    await store.write('33333333-3333-4333-8333-333333333333.sv.dxf', 'C', { originalPath: null, title: 'c.dxf', savedAt: 3 });
    const list = await store.list();
    expect(list.map((e) => e.omitted3d)).toEqual([3, undefined, undefined]);
    expect(list.map((e) => 'omitted3d' in e)).toEqual([true, false, false]);
  });
});
