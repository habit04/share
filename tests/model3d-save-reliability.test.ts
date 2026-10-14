/** Real renderer/state/DXF code. Native admissions below are explicitly a host transport double;
 * injected quota failures exercise recovery policy without constructing multi-million-pair files. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing, validateDrawingState, type DrawingState } from '../src/core/document';
import { STANDARD_DIMSTYLE, resolveDimStyle } from '../src/core/dimension';
import type { CadNode } from '../src/core/cad-graph';
import * as dxf from '../src/io/dxf';
import { Autosaver, autosaveName, omitted3dText, type AutosaveMeta, type AutosaveSession, type AutosaveStore } from '../src/app/autosave';
import { adoptOpenedSourceProof, captureOpenedSourceProof, forgetOpenedSourceProof } from '../src/app/opened-source-proof';
import { exportDwgCopy } from '../src/app/export-dwg';
import { resetWindowsPathIdentitiesForTests, setPathPlatform } from '../src/app/paths';
import { dimension3dMeasurement, makeDimension3D } from '../src/model3d/dimension3d';
import { WORLD_XY_FRAME } from '../src/model3d/math';
import { withModel3D } from '../src/model3d/model';
import { DXF_READ_LIMITS } from '../src/model3d/file-format';
import { MODEL3D_DWG_REFUSAL, model3dDxfLimitRefusal, recoveryDxf } from '../src/model3d/save-guard';
import type { Dimension3D } from '../src/model3d/types';

let Editor: typeof EditorType, sequence = 0;
beforeAll(async () => {
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
afterEach(() => { vi.restoreAllMocks(); resetWindowsPathIdentitiesForTests(); setPathPlatform(null); });
const dimension = (end = 10) => makeDimension3D({ id: 'dimension-3d', kind: 'aligned', plane: WORLD_XY_FRAME,
  p1: { x: 0, y: 0, z: 0 }, p2: { x: end, y: 0, z: 0 }, location: { x: 5, y: 3, z: 0 }, style: STANDARD_DIMSTYLE });
function state(end = 10): DrawingState { return withModel3D(new Drawing().snapshot, { version: 1, solids: [], dimensions: [dimension(end)] }); }
function expectDimensionsReopened(reopened: DrawingState, expected: readonly Dimension3D[]) {
  validateDrawingState(reopened);
  const actual = reopened.model3d!.dimensions!; expect(actual).toHaveLength(expected.length);
  actual.forEach((dimension, index) => {
    const { cadIdentity, style, ...geometry } = dimension, { cadIdentity: _originalIdentity, style: beforeStyle, ...before } = expected[index]!;
    expect(geometry).toEqual(before); expect(resolveDimStyle(style)).toEqual(resolveDimStyle(beforeStyle));
    expect(dimension3dMeasurement(dimension)).toBe(dimension3dMeasurement(expected[index]!));
    // Reopening deliberately adds a fresh graph identity; verify its actual native anchor
    // rather than treating provenance as authored geometry or dropping arbitrary properties.
    expect(cadIdentity).toEqual(expect.any(String));
    const graph = reopened.cadGraph!, native = graph.nodes.find(node => node.id === cadIdentity)!;
    expect(native).toMatchObject({ type: 'DIMENSION', anchor: { kind: 'dimension3d', id: dimension.id } });
    const pictures = graph.nodes.filter(node => node.anchor?.kind === 'dimension3d' && node.anchor.id === dimension.id && node.anchor.part === 'picture-block');
    expect(pictures).toHaveLength(1); expect(pictures[0]!.type).toBe('BLOCK_RECORD');
    const pictureName = native.groups.find(([code]) => code === 2)![1];
    expect(pictures[0]!.groups.find(([code]) => code === 2)![1]).toBe(pictureName);
    for (const node of [native, pictures[0]!]) for (const reference of node.references ?? []) if (reference.target) expect(graph.nodes.filter(candidate => candidate.id === reference.target)).toHaveLength(1);
  });
  expect(reopened.cadGraph!.nodes.filter(node => node.anchor?.kind === 'dimension3d' && !node.anchor.part)).toHaveLength(expected.length);
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function editorHost(extension: 'dxf' | 'dwg' = 'dxf') {
  setPathPlatform('win32');
  const original = String.raw`C:\three-dimensional-save-${++sequence}\original.${extension}`, copy = original.replace(/original\.(dxf|dwg)$/, 'copy.dxf');
  const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
  ed.doc.transact(current => withModel3D(current, { version: 1, solids: [], dimensions: [dimension()] })); ed.doc.filePath = original;
  const events: string[] = [], writes: { path: string; text: string }[] = [], receipts = new Map<string, { path: string; identityPath: string; openedSourceProof: string }>();
  let issued = 0;
  const bridge: FileBridge = {
    platform: 'win32', openDxf: async () => null,
    issueSaveAdmission: vi.fn(async () => { const ticket = `3d-save-${++issued}`; events.push(`issue:${ticket}`); return ticket; }),
    bindSaveAdmission: vi.fn(async ticket => { events.push(`bind:${ticket}`); return { identityPath: original, exists: true }; }),
    cancelSaveAdmission: vi.fn(async ticket => { events.push(`cancel:${ticket}`); }),
    releaseOpenedSourceProof: vi.fn(async proof => { events.push(`release:${proof}`); }),
    chooseDrawingPath: vi.fn(async () => copy), chooseDwgPath: vi.fn(async () => original.replace(/\.dxf$/, '.dwg')),
    dwgExportStatus: vi.fn(async () => ({ available: true })), saveDwg: vi.fn(async path => path), exportDwg: vi.fn(async path => path),
    saveDxf: vi.fn(async (path, text, _suggest, options) => {
      const ticket = options!.admission!; writes.push({ path: path!, text });
      receipts.set(ticket, { path: path!, identityPath: path!, openedSourceProof: `saved-${ticket}` }); events.push(`write:${ticket}`); return path;
    }),
    saveAdmissionResult: vi.fn(async ticket => { const value = receipts.get(ticket) ?? null; receipts.delete(ticket); return value; }),
  };
  ed.fileBridge = bridge; ed.log = vi.fn(); ed.hooks.drawingSaved = vi.fn();
  const session = ed.sessions.current;
  adoptOpenedSourceProof(session, session.contentGeneration, bridge, 'original-proof', original);
  return { ed, bridge, session, original, copy, events, writes };
}
function autosaveHost(initial: DrawingState) {
  const session: AutosaveSession = { id: 77, docId: '11111111-1111-4111-8111-111111111111', dirty: true, state: initial, filePath: String.raw`C:\original.dxf`, untitledName: 'original.dxf' };
  const files = new Map<string, { text: string; meta: AutosaveMeta }>();
  const store: AutosaveStore = {
    write: vi.fn(async (name, text, meta) => { files.set(name, { text, meta }); }), list: async () => [], read: async name => files.get(name)?.text ?? null,
    remove: vi.fn(async name => { files.delete(name); }),
  };
  const saver = new Autosaver({ all: [session] }, store, () => 0), errors = vi.fn(); saver.onError = errors;
  return { session, store, saver, errors, files, name: autosaveName(session.docId) };
}

describe('dimensions-only save and reopen safety', () => {
  it('checks actual reader record limits when only DIM3D is present', () => {
    const text = '0\nX\n'.repeat(DXF_READ_LIMITS.maxRecords + 1);
    expect(model3dDxfLimitRefusal(state(), text)).toMatch(/has 1 3D dimension.*250,001 records/);
    expect(model3dDxfLimitRefusal(new Drawing().snapshot, text)).toBeNull();
  });
  it('roundtrips complete DIM3D recovery with experimental rendering disabled', () => {
    const before = state(), copy = recoveryDxf(before), reopened = dxf.readDxf(copy.text, { model3d: false });
    expect(copy.omitted3d).toBe(0); expectDimensionsReopened(reopened, before.model3d!.dimensions!);
    expect(reopened.entities).toEqual([]); expect(dxf.defaultReadLimitExcess(copy.text)).toBeNull();
  });
  it('refuses bound DWG Save and EXPORTDWG for hidden DIM3D and joins admissions/source borrows', async () => {
    const f = editorHost('dwg'), snapshot = f.ed.doc.snapshot, history = f.ed.doc.history();
    expect(await f.ed.saveFile(false)).toBe(false); expect(await exportDwgCopy(f.ed)).toBe(false);
    expect(f.ed.lastFileError).toBe(MODEL3D_DWG_REFUSAL); expect(f.writes).toEqual([]);
    expect(f.bridge.bindSaveAdmission).not.toHaveBeenCalled(); expect(f.bridge.dwgExportStatus).not.toHaveBeenCalled();
    expect(f.bridge.chooseDrawingPath).not.toHaveBeenCalled(); expect(f.bridge.chooseDwgPath).not.toHaveBeenCalled();
    expect(f.bridge.cancelSaveAdmission).toHaveBeenCalledTimes(2); expect(f.ed.doc.snapshot).toBe(snapshot);
    expect(f.ed.doc.history()).toEqual(history); expect(f.ed.doc.filePath).toBe(f.original); expect(f.ed.doc.dirty).toBe(true);
    expect(f.ed.hooks.drawingSaved).not.toHaveBeenCalled();
    forgetOpenedSourceProof(f.session); await Promise.resolve(); expect(f.bridge.releaseOpenedSourceProof).toHaveBeenCalledExactlyOnceWith('original-proof');
  });
  it('refuses an injected DIM3D quota before choosing or writing, and releases the source borrow', async () => {
    const f = editorHost(), snapshot = f.ed.doc.snapshot;
    vi.spyOn(dxf, 'defaultReadLimitExcess').mockReturnValue('injected record budget');
    expect(await f.ed.saveFile(true)).toBe(false); expect(f.bridge.chooseDrawingPath).not.toHaveBeenCalled(); expect(f.writes).toEqual([]);
    expect(f.ed.doc.snapshot).toBe(snapshot); expect(f.ed.doc.dirty).toBe(true); expect(f.bridge.cancelSaveAdmission).toHaveBeenCalledOnce();
    forgetOpenedSourceProof(f.session); await Promise.resolve(); expect(f.bridge.releaseOpenedSourceProof).toHaveBeenCalledExactlyOnceWith('original-proof');
  });
  it('keeps the captured native proof/ticket and newer edits through a DIM3D DXF save', async () => {
    const f = editorHost(), gate = deferred<void>(), writer = f.bridge.saveDxf!;
    f.bridge.saveDxf = vi.fn(async (...args: Parameters<FileBridge['saveDxf']>) => { await gate.promise; return writer(...args); });
    const captured = f.ed.doc.snapshot, saving = f.ed.saveFile(false);
    try {
      await vi.waitFor(() => { expect(f.ed.lastFileError).toBeNull(); expect(f.bridge.saveDxf).toHaveBeenCalled(); });
      f.ed.doc.addEntities([{ id: 'newer-point', type: 'point', layer: '0', color: 'ByLayer', position: { x: 20, y: 30 } }]);
      gate.resolve(); expect(await saving).toBe(true);
      expect(f.bridge.bindSaveAdmission).toHaveBeenCalledWith('3d-save-1', 'drawing', f.original, { proof: 'original-proof', path: f.original, mode: 'in-place' });
      expect(f.bridge.saveDxf).toHaveBeenCalledWith(f.original, expect.any(String), expect.any(String), { admission: '3d-save-1' });
      const back = dxf.readDxf(f.writes[0]!.text, { model3d: false }); expectDimensionsReopened(back, captured.model3d!.dimensions!); expect(back.entities).toEqual([]);
      expect(f.ed.doc.dirty).toBe(true); expect(f.ed.doc.entities).toHaveLength(1);
      const source = captureOpenedSourceProof(f.session, f.bridge, f.original, 'in-place')!;
      expect(source.hint.proof).toBe('saved-3d-save-1'); await source.release();
    } finally { gate.resolve(); await saving; }
  });
});

describe('recovery omissions preserve existing complete bytes', () => {
  const dimensionQuota = () => vi.spyOn(dxf, 'defaultReadLimitExcess').mockImplementation(text => text.includes('"kind":"dimension3d"') ? 'injected dimension record budget' : null);
  it('keeps every previous good backup byte and revision when newer DIM3D no longer fits', async () => {
    const first = state(), f = autosaveHost(first); expect(await f.saver.runNow()).toBe(1);
    const good = f.files.get(f.name)!; f.session.state = state(20); dimensionQuota();
    expect(await f.saver.runNow()).toBe(0); expect(f.files.get(f.name)).toBe(good); expect(f.store.write).toHaveBeenCalledOnce();
    expect(f.saver.backedUpState(f.session.id)).toBe(first); expect(f.session.dirty).toBe(true); expect(f.store.remove).not.toHaveBeenCalled();
    expect(f.errors.mock.calls[0]![1].message).toMatch(/1 3D object.*previous recovery copy is kept/);
  });
  it('creates only a reopenable first fallback with truthful DIM3D omission, never marks the full revision backed up', async () => {
    const f = autosaveHost(state()); dimensionQuota(); expect(await f.saver.runNow()).toBe(1);
    const partial = f.files.get(f.name)!; expect(partial.meta.omitted3d).toBe(1);
    expect(omitted3dText(partial.meta)).toContain('1 3D object'); expect(dxf.readDxf(partial.text).model3d).toBeUndefined();
    expect(f.saver.backedUpState(f.session.id)).toBeUndefined(); expect(f.session.state.model3d!.dimensions).toHaveLength(1);
    expect(await f.saver.runNow()).toBe(0); expect(f.files.get(f.name)).toBe(partial); expect(f.store.write).toHaveBeenCalledOnce();
  });
  it('preserves an adopted recovery copy instead of replacing it with an incomplete one', async () => {
    const f = autosaveHost(state()); f.files.set(f.name, { text: dxf.writeDxf(state()), meta: { originalPath: null, title: 'recovered', savedAt: 1 } });
    const previous = f.files.get(f.name)!; f.saver.adopt(f.session.id, f.name); dimensionQuota();
    expect(await f.saver.runNow()).toBe(0); expect(f.files.get(f.name)).toBe(previous); expect(f.store.write).not.toHaveBeenCalled(); expect(f.errors).toHaveBeenCalledOnce();
  });
  it('refuses a residual over-budget 2D projection rather than writing an unreopenable fallback', async () => {
    const f = autosaveHost(state()); vi.spyOn(dxf, 'defaultReadLimitExcess').mockReturnValue('injected residual 2D budget');
    expect(await f.saver.runNow()).toBe(0); expect(f.store.write).not.toHaveBeenCalled(); expect(f.saver.backedUpState(f.session.id)).toBeUndefined();
    expect(f.errors.mock.calls[0]![1].message).toMatch(/still too large.*previous recovery copy is kept/i);
  });
  it('refuses omission with a retained hard dependency and leaves original graph/data untouched', () => {
    const imported = dxf.readDxf(dxf.writeDxf(state()), { model3d: true }), graph = imported.cadGraph!;
    const carrier = graph.nodes.find(node => node.type === 'DIMENSION' && node.section === 'ENTITIES')!;
    expect(carrier?.sourceHandle).toBeTruthy();
    const dependent: CadNode = { id: 'protected-hard-reference', type: 'XRECORD', section: 'OBJECTS', sourceHandle: 'FFFFF0',
      groups: [[5, 'FFFFF0'], [100, 'AcDbXrecord'], [340, carrier.sourceHandle!]], references: [{ groupIndex: 2, kind: 'hard-pointer', target: carrier.id, sourceHandle: carrier.sourceHandle! }] };
    const protectedState = { ...imported, cadGraph: { ...graph, nodes: [...graph.nodes, dependent] } };
    vi.spyOn(dxf, 'defaultReadLimitExcess').mockReturnValue('injected dimension quota');
    expect(() => recoveryDxf(protectedState)).toThrow(/hard dependency|referenced CAD data/i);
    expect(protectedState.model3d!.dimensions).toHaveLength(1); expect(protectedState.cadGraph.nodes.at(-1)).toBe(dependent);
    expect(protectedState.cadGraph.nodes).toContain(carrier);
  });
});
