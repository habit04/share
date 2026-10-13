/** Saving drawings with experimental 3D solids: the warning text and the confirm in every save path. */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import { readDxf } from '../src/io/dxf';
import { exportDwgCopy } from '../src/app/export-dwg';
import { Autosaver, type AutosaveSession, type AutosaveStore } from '../src/app/autosave';
import { newDocumentId } from '../src/app/sessions';
import { model3dSaveWarning } from '../src/model3d/save-guard';
import { addSolids, model3dOf, newSolid, withModel3D } from '../src/model3d/model';
import { boxMesh } from '../src/model3d/primitives';

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
  ed.doc.addEntities([{ id: `t-${counter}`, type: 'text', layer: '0', color: 'ByLayer', text: 'flat', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left' }]);
  const add3d = (n = 1) => ed.doc.transact((s) => withModel3D(s, addSolids(model3dOf(s), Array.from({ length: n }, solid))));
  return { ed, bridge, writes, logs, confirm, add3d, dxf, dwg };
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
  it('a 2D-only save never asks', async () => {
    const f = setup(false);
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(1);
  });

  it('No cancels a DXF save and keeps the drawing modified', async () => {
    const f = setup(false);
    f.add3d(2);
    expect(await f.ed.saveFile(false)).toBe(false);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.confirm.mock.calls[0]![1]).toMatch(/contains 2 experimental 3D objects/);
    expect(f.writes).toEqual([]);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.logs.join('\n')).toMatch(/Not saved/);
  });

  it('Yes saves the 2D content without the solids, which stay in the open drawing', async () => {
    const f = setup(true);
    f.add3d();
    const state = f.ed.doc.snapshot;
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.writes.map((w) => w.format)).toEqual(['dxf']);
    expect(readDxf(f.writes[0]!.text).entities).toHaveLength(1);
    expect(f.ed.doc.snapshot).toBe(state);
    expect(f.ed.doc.snapshot.model3d?.solids).toHaveLength(1);
    // The same unchanged state was already approved.
    expect(await f.ed.saveFile(false)).toBe(true);
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
  });

  it('asks before a DWG export copy', async () => {
    const f = setup(false);
    f.add3d();
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.bridge.chooseDwgPath).not.toHaveBeenCalled();
    f.confirm.mockResolvedValue(true);
    expect(await exportDwgCopy(f.ed)).toBe(true);
    expect(f.writes.map((w) => w.format)).toEqual(['export']);
  });

  it('autosave writes a recovery copy without asking or failing', async () => {
    const doc = new Drawing();
    doc.transact((s) => withModel3D(s, addSolids(model3dOf(s), [solid()])));
    const session: AutosaveSession = { id: 1, docId: newDocumentId(), dirty: true, state: doc.snapshot, filePath: null, untitledName: 'Drawing1.dxf' };
    const written: string[] = [];
    const store: AutosaveStore = { write: async (_n, text) => { written.push(text); }, list: async () => [], read: async () => null, remove: async () => {} };
    const saver = new Autosaver({ all: [session] }, store, () => 0);
    const errors = vi.fn();
    saver.onError = errors;
    expect(await saver.runNow()).toBe(1);
    expect(errors).not.toHaveBeenCalled();
    expect(written).toHaveLength(1);
    expect(() => readDxf(written[0]!)).not.toThrow();
  });
});
