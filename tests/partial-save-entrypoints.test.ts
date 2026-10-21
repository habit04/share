/** Source protection is checked after native identity discovery and in closed project updates. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import { withImportData, isPartialImport, type ImportReport } from '../src/io/import-report';
import { registerWindowsPathIdentity, resetWindowsPathIdentitiesForTests, setPathPlatform } from '../src/app/paths';
import { exportDwgCopy } from '../src/app/export-dwg';
import { commitSheets, loadProjectSheets, projectUi } from '../src/app/commands-electrical';
import { type ProjectSaveBatchBridge } from '../src/app/project-save-batch';
import { partialImportProvenance } from '../src/io/import-provenance';
import { restoreAutosaveImportData } from '../src/app/autosave';
import { adoptOpenedSourceProof } from '../src/app/opened-source-proof';

let Editor: typeof EditorType;
beforeAll(async () => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}; Editor = (await import('../src/app/editor')).Editor; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetWindowsPathIdentitiesForTests(); setPathPlatform(null); });
const createEditor = () => new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
const point = { type: 'point' as const, id: 'edited', layer: '0', color: 'ByLayer' as const, position: { x: 2, y: 3 } };
function report(sourcePath: string, loss: 'dropped' | 'simplified' | 'recovered'): ImportReport {
  return { format: 'DWG', sourcePath, counts: loss === 'recovered' ? {} : { INSERT: { [loss]: 1 } }, items: loss === 'recovered' ? [] : [{ type: 'INSERT', action: loss, reason: 'source loss' }], notes: [], omitted: 0, ...(loss === 'recovered' ? { recovered: { line: 2, message: 'source ended early' } } : {}) };
}

describe('partial import native alias protection', () => {
  it.each(['save', 'export'] as const)('refuses %s after either destination or source alias identity is discovered', async operation => {
    for (const loss of ['dropped', 'simplified', 'recovered'] as const) for (const knownSource of [true, false]) {
      resetWindowsPathIdentitiesForTests(); setPathPlatform('win32');
      const source = 'C:\\source-junction\\partial.dwg', destination = 'C:\\other-junction\\partial.dwg', canonical = 'C:\\real\\partial.dwg';
      if (knownSource) registerWindowsPathIdentity(source, canonical);
      const ed = createEditor(); ed.doc.load(withImportData(new Drawing().snapshot, report(source, loss)), source); ed.doc.addEntities([point]);
      const before = ed.doc.snapshot, history = ed.doc.history();
      const bridge: FileBridge = { platform: 'win32', openDxf: async () => null, saveDxf: vi.fn(async () => destination), saveDwg: vi.fn(async () => destination), exportDwg: vi.fn(async () => destination), dwgExportStatus: vi.fn(async () => ({ available: true })), chooseDrawingPath: vi.fn(async () => destination), chooseDwgPath: vi.fn(async () => destination), issueSaveAdmission: vi.fn(async () => 'ticket'), bindSaveAdmission: vi.fn(async () => ({ exists: true, identityPath: canonical })), cancelSaveAdmission: vi.fn(async () => {}), resolvePathIdentity: vi.fn(async () => canonical) };
      ed.fileBridge = bridge; const confirm = vi.fn(async () => true); ed.ui = { pickSymbol: async () => null, editComponent: async () => null, ladderSettings: async v => v, textInput: async (_t, _l, v) => v, confirm };
      const saved = operation === 'save' ? await ed.saveFile(true) : await exportDwgCopy(ed);
      expect(saved).toBe(false); expect(bridge.bindSaveAdmission).toHaveBeenCalledOnce(); expect(bridge.resolvePathIdentity).toHaveBeenCalledWith(source);
      expect(bridge.saveDxf).not.toHaveBeenCalled(); expect(bridge.saveDwg).not.toHaveBeenCalled(); expect(bridge.exportDwg).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled();
      expect(ed.lastFileError).toMatch(/cannot be saved over its source/); expect(ed.doc.snapshot).toBe(before); expect(ed.doc.history()).toEqual(history); expect(ed.doc.dirty).toBe(true); expect(ed.doc.filePath).toBe(source);
      expect(bridge.cancelSaveAdmission).toHaveBeenCalledOnce();
    }
  });

  it('refuses a partial Save As when a legacy bridge hides its destination until after writing', async () => {
    const ed = createEditor(), source = '/drawings/partial.dxf'; ed.doc.load(withImportData(new Drawing().snapshot, report(source, 'dropped')), source);
    const saveDxf = vi.fn(async () => source); ed.fileBridge = { openDxf: async () => null, saveDxf };
    expect(await ed.saveFile(true)).toBe(false); expect(saveDxf).not.toHaveBeenCalled(); expect(ed.lastFileError).toMatch(/destination chosen before writing/);
    ed.fileBridge = { ...ed.fileBridge, saveDxfCreatesCopy: true };
    expect(await ed.saveFile(true)).toBe(true); expect(saveDxf).toHaveBeenCalledOnce();
  });

  it.each(['save', 'export'] as const)('refuses %s to an existing destination when source identity cannot be verified', async operation => {
    const source = 'C:\\unverified-source\\partial.dwg', destination = 'C:\\selected\\existing.dwg';
    const ed = createEditor(); ed.doc.load(withImportData(new Drawing().snapshot, report(source, 'dropped')), source);
    const bridge: FileBridge = { platform: 'win32', openDxf: async () => null, saveDxf: vi.fn(async () => destination), saveDwg: vi.fn(async () => destination), exportDwg: vi.fn(async () => destination), chooseDrawingPath: async () => destination, chooseDwgPath: async () => destination, dwgExportStatus: async () => ({ available: true }), issueSaveAdmission: async () => 'ticket', bindSaveAdmission: async () => ({ exists: true, identityPath: destination }), cancelSaveAdmission: async () => {}, resolvePathIdentity: async () => null };
    ed.fileBridge = bridge; const confirm = vi.fn(async () => true); ed.ui = { pickSymbol: async () => null, editComponent: async () => null, ladderSettings: async v => v, textInput: async (_t, _l, v) => v, confirm };
    expect(operation === 'save' ? await ed.saveFile(true) : await exportDwgCopy(ed)).toBe(false);
    expect(ed.lastFileError).toMatch(/source identity is unverified/); expect(confirm).not.toHaveBeenCalled(); expect(bridge.saveDxf).not.toHaveBeenCalled(); expect(bridge.saveDwg).not.toHaveBeenCalled(); expect(bridge.exportDwg).not.toHaveBeenCalled();
  });
});

describe('closed project partial import source protection', () => {
  it.each((['legacy', 'batch'] as const).flatMap(mode => (['dropped', 'simplified', 'recovered'] as const).map(loss => ({ mode, loss }))))('refuses $mode $loss writes before loss consent, backups or producers', async ({ mode, loss }) => {
    setPathPlatform('win32'); vi.stubGlobal('window', { jcad: {} });
    const ed = createEditor(), path = 'C:\\partial-project\\closed.dxf';
    ed.replaceProject({ name: 'P', path: 'C:\\partial-project\\P.jcadproj.json', drawings: [{ file: 'closed.dxf' }] }, false);
    const source = readFileSync(join(__dirname, 'fixtures', 'unsupported-content.dxf'), 'latin1');
    const saveDxf = vi.fn(async () => path), backupFile = vi.fn(async () => ({ ok: true as const, path: `${path}.bak` }));
    const bridge: FileBridge & Partial<ProjectSaveBatchBridge> = { platform: 'win32', openDxf: async () => null, openDrawing: async () => ({ kind: 'dxf', path, text: source }), saveDxf, backupFile, resolvePathIdentity: async p => p, issueSaveAdmission: vi.fn(async () => 'ordinary'), bindSaveAdmission: vi.fn(async (_t, _k, p) => ({ exists: true, identityPath: p })), cancelSaveAdmission: vi.fn(async () => {}) };
    if (mode === 'batch') Object.assign(bridge, { saveAdmissionResult: vi.fn(async () => null), issueProjectSaveBatch: vi.fn(async () => 'parent'), bindProjectSaveBatch: vi.fn(async (_p: string, paths: string[]) => paths.map((p, index) => ({ index, path: p, childTicket: `child-${index}`, identityPath: p, exists: true }))), openProjectSaveBatchDrawing: vi.fn(async () => ({ kind: 'dxf', path, identityPath: path, text: source })), sealProjectSaveBatch: vi.fn(async () => {}), beginProjectSaveBatchCommit: vi.fn(async () => {}), cancelProjectSaveBatch: vi.fn(async () => {}) });
    ed.fileBridge = bridge;
    const confirmFiles = vi.spyOn(projectUi, 'confirmFiles').mockResolvedValue({ files: true, backup: true }), confirmLoss = vi.spyOn(projectUi, 'confirmLoss').mockResolvedValue(true);
    const loaded = await loadProjectSheets(ed, { forSave: true }); expect(loaded.skipped).toEqual([]); expect(loaded.sheets).toHaveLength(1);
    const sheet = loaded.sheets[0]!; expect(sheet.source).toBe('file'); expect(isPartialImport(sheet.doc.snapshot)).toBe(true);
    // Individual loss reports naturally survive closed-file loading above. Exercise each
    // refusal reason independently, including a previously recovered state supplied by a caller.
    sheet.doc.load(withImportData(sheet.doc.snapshot, { ...report(path, loss), format: 'DXF' }), path);
    const result = await commitSheets(ed, loaded.sheets, new Map([[0, { state: { ...sheet.doc.snapshot, entities: [...sheet.doc.snapshot.entities, point] }, detail: 'project update' }]]), 'Update', 'Test', true);
    expect(confirmFiles).toHaveBeenCalledOnce(); expect(confirmLoss).not.toHaveBeenCalled(); expect(backupFile).not.toHaveBeenCalled(); expect(saveDxf).not.toHaveBeenCalled(); expect(result?.written).toBe(0); expect(result?.failed.join('\n')).toMatch(/cannot be saved over its source/);
    expect(bridge.cancelSaveAdmission).toHaveBeenCalled();
    if (mode === 'batch') expect(bridge.cancelProjectSaveBatch).toHaveBeenCalled();
  });
});

describe('source protection after a partial copy is recovered', () => {
  it('still refuses the original import while allowing continued saving of an independently verified copy', async () => {
    const source = 'C:\\original\\drawing.dwg', copy = 'C:\\copies\\drawing-copy.dxf';
    const original = withImportData(new Drawing().snapshot, report(source, 'dropped'));
    const recovered = restoreAutosaveImportData(new Drawing().snapshot, { originalPath: copy, partialImportSourcePath: source, partialImport: partialImportProvenance(original) });
    const ed = createEditor(); ed.doc.load(recovered, copy); ed.doc.addEntities([point]);
    const bridge: FileBridge = { platform: 'win32', openDxf: async () => null, chooseDrawingPath: async () => source, saveDxf: vi.fn(async () => copy), dwgExportStatus: async () => ({ available: true }), saveDwg: vi.fn(async () => source), issueSaveAdmission: async () => 'ticket', bindSaveAdmission: vi.fn(async (_ticket, _kind, path) => ({ exists: true, identityPath: path })), cancelSaveAdmission: async () => {}, resolvePathIdentity: async path => path, releaseOpenedSourceProof: vi.fn(async () => {}), saveAdmissionResult: async () => ({ path: copy, identityPath: copy, openedSourceProof: 'b'.repeat(48) }) };
    ed.fileBridge = bridge;
    // Transport double for a separately authorized, verified opening of the copy. The
    // autosave data itself contains no proof and cannot establish this main-owned evidence.
    adoptOpenedSourceProof(ed.sessions.current, ed.sessions.current.contentGeneration, bridge, 'a'.repeat(48), copy);
    expect(await ed.saveFile(true)).toBe(false); expect(bridge.saveDwg).not.toHaveBeenCalled(); expect(bridge.saveDxf).not.toHaveBeenCalled();
    expect(await ed.saveFile(false)).toBe(true); expect(bridge.saveDxf).toHaveBeenCalledWith(copy, expect.any(String), expect.any(String), { admission: 'ticket' });
    expect(ed.doc.filePath).toBe(copy); expect(isPartialImport(ed.doc.snapshot)).toBe(true);
  });

  it('forged diagnostic source metadata cannot grant a lookup, destination or source proof', async () => {
    const copy = 'C:\\authorized\\copy.dxf', forged = 'C:\\not-authorized\\victim.dwg';
    const state = withImportData(new Drawing().snapshot, report('/source.dwg', 'dropped'));
    const recovered = restoreAutosaveImportData(new Drawing().snapshot, { originalPath: copy, partialImportSourcePath: forged, partialImport: partialImportProvenance(state) });
    const ed = createEditor(); ed.doc.load(recovered, copy);
    const authorized = new Set([copy]), nativeLookups: string[] = [];
    const bridge: FileBridge = { platform: 'win32', openDxf: async () => null, saveDxf: vi.fn(async () => copy), issueSaveAdmission: async () => 'ticket', bindSaveAdmission: vi.fn(async (_t, _k, target) => { expect(authorized.has(target)).toBe(true); return { exists: true, identityPath: target }; }), cancelSaveAdmission: async () => {}, releaseOpenedSourceProof: vi.fn(async () => {}), resolvePathIdentity: async path => { if (!authorized.has(path)) return null; nativeLookups.push(path); return path; } };
    ed.fileBridge = bridge;
    expect(await ed.saveFile(false)).toBe(false); expect(bridge.saveDxf).not.toHaveBeenCalled(); expect(nativeLookups).toEqual([]); expect([...authorized]).toEqual([copy]);
    expect(bridge.bindSaveAdmission).toHaveBeenCalledWith('ticket', 'drawing', copy, expect.objectContaining({ proof: null, path: copy }));
    expect(ed.lastFileError).toMatch(/source identity is unverified/);
  });
});
