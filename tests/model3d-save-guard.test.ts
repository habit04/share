/**
 * Saving drawings with experimental 3D solids (milestone 5 policy): DXF Save / Save As / autosave
 * hold the solids without asking; DWG Save and EXPORTDWG refuse instead of dropping them.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import { readDxf } from '../src/io/dxf';
import { exportDwgCopy } from '../src/app/export-dwg';
import { Autosaver, type AutosaveMeta, type AutosaveSession, type AutosaveStore } from '../src/app/autosave';
import { readDxfForOpen } from '../src/app/import-open';
import { newDocumentId } from '../src/app/sessions';
import { MODEL3D_DWG_REFUSAL, model3dDwgRefusal, model3dDxfLimitRefusal, model3dDxfSaveNotes } from '../src/model3d/save-guard';
import { DXF_READ_LIMITS } from '../src/model3d/file-format';
import { omitted3dText } from '../src/app/autosave';
import { addSolids, model3dOf, newSolid, withModel3D } from '../src/model3d/model';
import { boxMesh } from '../src/model3d/primitives';
import { WORLD_XY_FRAME } from '../src/model3d/math';
import type { Solid3D } from '../src/model3d/types';
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

const solid = (): Solid3D => newSolid({ mesh: boxMesh(1, 1, 1), feature: { kind: 'box', frame: WORLD_XY_FRAME, width: 1, depth: 1, height: 1 }, name: 'part' });
/** A solid whose construction history is far larger than one polyface record may carry. */
const hugeHistory = (): Solid3D => newSolid({
  mesh: boxMesh(1, 1, 1),
  feature: { kind: 'extrude', distance: 1, profile: { frame: WORLD_XY_FRAME, loops: [Array.from({ length: 2000 }, (_, i) => ({ x: Math.cos(i / 318.31) + 1e-9, y: Math.sin(i / 318.31) + 1e-9 }))] } },
});

/**
 * A valid solid whose polyface records (13 group pairs per face) exceed the reader's 2,000,000
 * group pairs while staying inside the geometry budget: 160,000 triangles over three vertices.
 */
const tooLargeForDxf = (): Solid3D => newSolid({
  feature: { kind: 'mesh', source: 'edited' },
  mesh: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: Array.from({ length: 160_000 * 3 }, (_, i) => i % 3) },
});

function setup(chosen: 'dwg' | 'dxf' = 'dwg') {
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
    chooseDrawingPath: vi.fn(async () => (chosen === 'dwg' ? dwg : dxf)),
    saveDxf: vi.fn(async (path, text) => { writes.push({ format: 'dxf', path: path ?? dxf, text }); return path ?? dxf; }),
    dwgExportStatus: vi.fn(async () => ({ available: true })),
    saveDwg: vi.fn(async (path, text) => { writes.push({ format: 'dwg', path, text }); return path; }),
    chooseDwgPath: vi.fn(async () => dwg),
    exportDwg: vi.fn(async (path, text) => { writes.push({ format: 'export', path, text }); return path; }),
  };
  ed.fileBridge = bridge;
  const confirm = vi.fn(async (_title: string, _message: string) => true);
  ed.ui = { pickSymbol: async () => null, editComponent: async () => null, ladderSettings: async (i) => i, textInput: async (_t, _l, i) => i, confirm };
  const drawingSaved = vi.fn();
  ed.hooks.drawingSaved = drawingSaved;
  ed.doc.addEntities([{ id: `t-${counter}`, type: 'text', layer: '0', color: 'ByLayer', text: 'flat', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left' }]);
  const add3d = (make: () => Solid3D = solid, n = 1) => ed.doc.transact((s) => withModel3D(s, addSolids(model3dOf(s), Array.from({ length: n }, make))));
  return { ed, bridge, writes, logs, confirm, drawingSaved, add3d, dxf, dwg };
}

describe('save-guard helpers', () => {
  it('refuses DWG only for drawings with solids', () => {
    const plain = new Drawing().snapshot;
    expect(model3dDwgRefusal(plain)).toBeNull();
    expect(model3dDwgRefusal({ ...plain, model3d: { version: 1, solids: [] } })).toBeNull();
    expect(model3dDwgRefusal(withModel3D(plain, addSolids(model3dOf(plain), [solid()])))).toBe(MODEL3D_DWG_REFUSAL);
    expect(MODEL3D_DWG_REFUSAL).toBe('DWG files cannot hold 3D objects in this version; save as DXF, or enable Experimental 3D (Options > Files) to view or erase them');
  });

  it('notes oversized histories, nothing for ordinary drawings', () => {
    const plain = new Drawing().snapshot;
    expect(model3dDxfSaveNotes(plain)).toEqual([]);
    expect(model3dDxfSaveNotes(withModel3D(plain, addSolids(model3dOf(plain), [solid()])))).toEqual([]);
    const big = withModel3D(plain, addSolids(model3dOf(plain), [hugeHistory(), solid(), hugeHistory()]));
    expect(model3dDxfSaveNotes(big)).toEqual(['2 3D objects have construction histories too large for the DXF file: saved as plain meshes (the geometry is kept; after reopening they are not editable parametrically).']);
  });

  it('refuses DXF text beyond the reader limits only when the drawing has solids', () => {
    const plain = new Drawing().snapshot;
    const tooLong = '0\r\nX\r\n'.repeat(DXF_READ_LIMITS.maxPairs + 1);
    expect(model3dDxfLimitRefusal(plain, tooLong)).toBeNull();
    const with3d = withModel3D(plain, addSolids(model3dOf(plain), [solid()]));
    expect(model3dDxfLimitRefusal(with3d, 'small\r\n')).toBeNull();
    expect(model3dDxfLimitRefusal(with3d, tooLong)).toBe("the drawing's 3D objects have 12 triangles, which makes a DXF file JCad could not open again (the file has 2,000,001 group pairs; JCad opens at most 2,000,000; limits: 2,000,000 group pairs, 250,000 records, 134,217,728 characters). Reduce the 3D model (fewer objects or less mesh detail) and save again");
    expect(DXF_READ_LIMITS).toEqual({ maxPairs: 2_000_000, maxRecords: 250_000, maxSourceLength: 134_217_728 });
  });
});

describe('save flows with 3D solids', () => {
  it('a 2D-only save never asks and marks the drawing clean', async () => {
    const f = setup();
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.writes).toHaveLength(1);
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.drawingSaved).toHaveBeenCalledTimes(1);
  });

  it('a DXF save no longer warns: it writes the solids and marks the drawing clean', async () => {
    const f = setup();
    f.add3d(solid, 2);
    const state = f.ed.doc.snapshot;
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.writes.map((w) => w.format)).toEqual(['dxf']);
    const back = readDxf(f.writes[0]!.text, { model3d: true });
    expect(back.entities).toHaveLength(1);
    expect(back.model3d!.solids.map((s) => s.id)).toEqual(state.model3d!.solids.map((s) => s.id));
    expect(back.model3d!.solids[0]!.feature).toEqual(state.model3d!.solids[0]!.feature);
    expect(f.ed.doc.dirty).toBe(false);
    expect(f.drawingSaved).toHaveBeenCalledWith(expect.any(Number), state, f.dxf);
    expect(f.logs.join('\n')).not.toMatch(/3D/);
  });

  it('saves without an interface too (nothing to confirm any more)', async () => {
    const f = setup();
    f.add3d();
    f.ed.ui = null;
    expect(await f.ed.saveFile(false)).toBe(true);
    expect(f.writes.map((w) => w.format)).toEqual(['dxf']);
    expect(f.ed.lastFileError).toBeNull();
  });

  it('Save As DXF logs, without blocking, the histories it stores as plain meshes', async () => {
    const f = setup('dxf');
    f.add3d(hugeHistory);
    expect(await f.ed.saveFile(true)).toBe(true);
    expect(f.logs).toContain('1 3D object has a construction history too large for the DXF file: saved as plain meshes (the geometry is kept; after reopening it is not editable parametrically).');
    expect(readDxf(f.writes[0]!.text).model3d!.solids[0]!.feature).toEqual({ kind: 'mesh', source: 'edited' });
    expect(f.ed.doc.dirty).toBe(false);
  });

  it('refuses a DXF save whose solids make a file JCad could not reopen; the drawing stays modified', async () => {
    const f = setup('dxf');
    f.add3d(tooLargeForDxf);
    const state = f.ed.doc.snapshot;
    for (const saveAs of [false, true]) {
      expect(await f.ed.saveFile(saveAs)).toBe(false);
      expect(f.writes).toEqual([]);
      expect(f.bridge.chooseDrawingPath).not.toHaveBeenCalled();
      expect(f.ed.lastFileError).toMatch(/^the drawing's 3D objects have 160,000 triangles, which makes a DXF file JCad could not open again \(the file has [\d,]+ group pairs; JCad opens at most 2,000,000; limits: 2,000,000 group pairs, 250,000 records, .*\)\. Reduce the 3D model/);
      expect(f.logs.at(-1)).toBe(`Not saved: ${f.ed.lastFileError}.`);
      expect(f.ed.doc.dirty).toBe(true);
      expect(f.ed.doc.snapshot).toBe(state);
      expect(f.drawingSaved).not.toHaveBeenCalled();
    }
    // EXPORTDWG never writes solids at all.
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.writes).toEqual([]);
  });

  it('Save As to a DWG refuses a drawing with solids: nothing written, nothing dropped', async () => {
    const f = setup('dwg');
    f.add3d();
    const state = f.ed.doc.snapshot;
    expect(await f.ed.saveFile(true)).toBe(false);
    expect(f.bridge.chooseDrawingPath).toHaveBeenCalledTimes(1);
    expect(f.bridge.saveDwg).not.toHaveBeenCalled();
    expect(f.bridge.dwgExportStatus).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    expect(f.ed.lastFileError).toBe(MODEL3D_DWG_REFUSAL);
    expect(f.logs).toContain(`Not saved: ${MODEL3D_DWG_REFUSAL}.`);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.ed.doc.snapshot).toBe(state);
    expect(f.ed.doc.dirty).toBe(true);
    expect(f.ed.doc.filePath).toBe(f.dxf);
  });

  it('Save of a drawing bound to a DWG refuses before any dialog', async () => {
    const f = setup('dwg');
    f.ed.doc.filePath = f.dwg;
    f.add3d();
    expect(await f.ed.saveFile(false)).toBe(false);
    expect(f.bridge.chooseDrawingPath).not.toHaveBeenCalled();
    expect(f.writes).toEqual([]);
    expect(f.ed.lastFileError).toBe(MODEL3D_DWG_REFUSAL);
    // Save As DXF still works for the same drawing.
    f.bridge.chooseDrawingPath = vi.fn(async () => f.dxf);
    expect(await f.ed.saveFile(true)).toBe(true);
    expect(f.writes.map((w) => w.format)).toEqual(['dxf']);
  });

  it('a 2D drawing still saves as DWG', async () => {
    const f = setup('dwg');
    expect(await f.ed.saveFile(true)).toBe(true);
    expect(f.writes.map((w) => w.format)).toEqual(['dwg']);
    expect(f.writes[0]!.text).not.toContain('JCAD_3D');
  });

  it('EXPORTDWG refuses a drawing with solids and exports 2D drawings as before', async () => {
    const f = setup();
    expect(await exportDwgCopy(f.ed)).toBe(true);
    expect(f.writes.map((w) => w.format)).toEqual(['export']);
    f.add3d();
    expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.bridge.chooseDwgPath).toHaveBeenCalledTimes(1);
    expect(f.bridge.exportDwg).toHaveBeenCalledTimes(1);
    expect(f.ed.lastFileError).toBe(MODEL3D_DWG_REFUSAL);
    expect(f.logs).toContain(`DWG export canceled: ${MODEL3D_DWG_REFUSAL}.`);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.ed.doc.snapshot.model3d?.solids).toHaveLength(1);
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

  it('writes the solids into the recovery copy without asking, and the recovery path reads them back', async () => {
    const doc = new Drawing();
    doc.transact((s) => withModel3D(s, addSolids(model3dOf(s), [solid(), solid()])));
    const r = run(doc.snapshot);
    expect(await r.saver.runNow()).toBe(1);
    expect(r.errors).not.toHaveBeenCalled();
    expect('omitted3d' in r.written[0]!.meta).toBe(false);
    const confirm = vi.fn(async () => true);
    for (const enabled of [true, false]) {
      // Recovery reads like OPEN; with the experimental setting off, JCad's own solids are still kept.
      const back = (await readDxfForOpen(r.written[0]!.text, null, confirm, enabled))!;
      expect(back.model3d!.solids).toEqual(doc.snapshot.model3d!.solids.map((s) => ({ ...s })));
      const recovered = new Drawing();
      recovered.load(back);
      expect(recovered.snapshot.model3d!.solids).toHaveLength(2);
    }
    expect(confirm).not.toHaveBeenCalled();
  });

  it('writes the recovery copy without solids that would make it unreadable, and records how many', async () => {
    const doc = new Drawing();
    doc.transact((s) => withModel3D(s, addSolids(model3dOf(s), [tooLargeForDxf(), solid()])));
    const r = run(doc.snapshot);
    expect(await r.saver.runNow()).toBe(1);
    expect(r.errors).not.toHaveBeenCalled();
    const { text, meta } = r.written[0]!;
    expect(meta.omitted3d).toBe(2);
    expect(text).not.toContain('JCAD_3D');
    const back = (await readDxfForOpen(text, null, async () => true, true))!;
    expect(back.model3d).toBeUndefined();
    expect(back.entities).toEqual([]);
    // The open drawing keeps its solids; the recovery dialog says what the backup lacks.
    expect(doc.snapshot.model3d!.solids).toHaveLength(2);
    expect(omitted3dText(meta)).toBe('This backup does not contain 2 3D objects: they were too large for a recovery file JCad can reopen.');
    expect(omitted3dText({ omitted3d: 1 })).toBe('This backup does not contain 1 3D object: it was too large for a recovery file JCad can reopen.');
    expect(omitted3dText({})).toBeNull();
  });

  it('2D-only recovery metadata is unchanged', async () => {
    const r = run(new Drawing().snapshot);
    await r.saver.runNow();
    expect('omitted3d' in r.written[0]!.meta).toBe(false);
    expect(r.written[0]!.text).not.toContain('JCAD_3D');
  });

  it('the desktop recovery index still reads the milestone-1 count and ignores junk', async () => {
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
