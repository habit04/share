/** Real Editor/Drawing/project commands; the native IPC transport is an explicit test double. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { defaultLayout } from '../src/core/layouts';
import { makeSheet } from '../src/electrical/project-tools';
import { readDxf, writeDxf } from '../src/io/dxf';
import * as dxf from '../src/io/dxf';
import { commitSheets, loadProjectSheets, projectUi, type LoadedSheet } from '../src/app/commands-electrical';
import { ProjectSaveBatch, type ProjectBatchBinding, type ProjectSaveBatchBridge } from '../src/app/project-save-batch';
import { pathIdentityKey, registerWindowsPathIdentity, resetWindowsPathIdentitiesForTests, samePath, setPathPlatform } from '../src/app/paths';

let Editor: typeof EditorType, sequence = 0;
beforeAll(async () => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}; Editor = (await import('../src/app/editor')).Editor; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetWindowsPathIdentitiesForTests(); setPathPlatform(null); });
const error = (code: string) => Object.assign(new Error(code), { code });
const note = (text: string): Entity => ({ id: `note-${text}`, type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left', text });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

function setup(count = 1, open = false) {
  setPathPlatform('win32'); vi.stubGlobal('window', { jcad: {} });
  const root = `C:\\project-batch-${++sequence}`, events: string[] = [], disk = new Map<string, string>(), aliases = new Map<string, string>();
  const parents = new Set<string>(), children = new Map<string, { path: string; canonical: string; original: string; read: boolean; closed: boolean }>(), receipts = new Map<string, { path: string; identityPath: string }>();
  const editor = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
  const initial = editor.doc.snapshot;
  editor.doc.load({ ...initial, entities: [note('active original')] }, `${root}\\active.dxf`);
  if (open) editor.sessions.addInBackground({ ...initial, entities: [note('parked original')] }, `${root}\\parked.dxf`);
  editor.replaceProject({ name: 'P', path: `${root}\\P.jcadproj.json`, drawings: [...(open ? [{ file: 'active.dxf' }, { file: 'parked.dxf' }] : []), ...Array.from({ length: count }, (_, index) => ({ file: `closed-${index}.dxf` }))] }, false);
  const blank = writeDxf(new Drawing().snapshot);
  for (let i = 0; i < count; i++) disk.set(`${root}\\closed-${i}.dxf`, blank);
  let next = 0, selected = new Set<string>(), phase = 'issued';
  const assertBasis = () => { for (const child of children.values()) if (child.read && disk.get(child.path) !== child.original) throw error('ERR_WINDOWS_PATH_CHANGED'); };
  const bridge: FileBridge & ProjectSaveBatchBridge = {
    platform: 'win32', openDxf: async () => null,
    issueProjectSaveBatch: vi.fn(async () => { const ticket = `parent-${++next}`; events.push('issue:parent'); parents.add(ticket); return ticket; }),
    bindProjectSaveBatch: vi.fn(async (_parent: string, paths: string[]) => {
      phase = 'bound'; events.push(`bind:${paths.length}`);
      return paths.map((path, index): ProjectBatchBinding => {
        const text = disk.get(path); if (text === undefined) return { index, path, missing: true };
        const childTicket = `child-${index}`, canonical = aliases.get(path) ?? path;
        children.set(childTicket, { path, canonical, original: text, read: false, closed: false });
        return { index, path, childTicket, identityPath: canonical, exists: true };
      });
    }),
    openProjectSaveBatchDrawing: vi.fn(async (_parent, ticket) => {
      events.push(`read:${ticket}`); const child = children.get(ticket)!;
      if (disk.get(child.path) !== child.original) throw error('ERR_WINDOWS_PATH_CHANGED'); child.read = true;
      return { kind: 'dxf' as const, path: child.path, identityPath: child.canonical, text: child.original };
    }),
    sealProjectSaveBatch: vi.fn(async (_parent, tickets) => { events.push('seal'); assertBasis(); selected = new Set(tickets); phase = 'sealed'; }),
    beginProjectSaveBatchCommit: vi.fn(async (_parent, tickets) => { events.push('begin'); assertBasis(); selected = new Set(tickets ?? [...selected]); phase = 'committing'; }),
    cancelProjectSaveBatch: vi.fn(async ticket => { events.push('cancel:parent'); parents.delete(ticket); for (const child of children.values()) child.closed = true; }),
    issueSaveAdmission: vi.fn(async () => { events.push('issue:ordinary'); return 'ordinary'; }),
    bindSaveAdmission: vi.fn(async (_ticket, _kind, path) => path),
    cancelSaveAdmission: vi.fn(async ticket => { events.push(`cancel:${ticket}`); const child = children.get(ticket); if (child) child.closed = true; }),
    resolvePathIdentity: vi.fn(async path => disk.has(path) ? aliases.get(path) ?? path : null),
    saveAdmissionResult: vi.fn(async ticket => { const receipt = receipts.get(ticket) ?? null; receipts.delete(ticket); return receipt; }),
    openDrawing: vi.fn(async path => path && disk.has(path) ? { kind: 'dxf' as const, path, identityPath: aliases.get(path) ?? path, text: disk.get(path)! } : null),
    backupFile: vi.fn(async (path, options) => { events.push(`backup:${options?.admission}`); if (phase !== 'sealed' || !selected.has(options?.admission ?? '')) throw error('ERR_SAVE_TICKET'); return { ok: true as const, path: `${path}.bak` }; }),
    saveDxf: vi.fn(async (path, text, _name, options) => {
      events.push(`write:${options?.admission}`); const ticket = options?.admission ?? '', child = children.get(ticket);
      if (!path || !child || child.closed || phase !== 'committing' || !selected.has(ticket)) throw error('ERR_SAVE_TICKET');
      if (disk.get(path) !== child.original) throw error('ERR_WINDOWS_PATH_CHANGED');
      disk.set(path, text); receipts.set(ticket, { path, identityPath: child.canonical }); return path;
    }),
  };
  editor.fileBridge = bridge; const saved = vi.fn(); editor.hooks.drawingSaved = saved;
  vi.spyOn(projectUi, 'confirmFiles').mockResolvedValue({ files: true, backup: false }); vi.spyOn(projectUi, 'confirmLoss').mockResolvedValue(true);
  vi.spyOn(projectUi, 'confirmNoBackup').mockResolvedValue(false);
  const changes = (sheets: readonly LoadedSheet[], indexes = sheets.map((_sheet, index) => index)) => new Map(indexes.map(index => [index, { state: { ...sheets[index]!.doc.snapshot, entities: [...sheets[index]!.doc.entities, note(`update-${index}`)] }, detail: 'update' }]));
  const snapshot = () => ({ doc: editor.doc.snapshot, history: editor.doc.history(), dirty: editor.doc.dirty, space: editor.doc.space, revision: editor.doc.revision, selected: [...editor.selection], tabs: editor.sessions.all.map(session => ({ id: session.id, state: session.state, undo: [...session.undo], redo: [...session.redo], dirty: session.dirty, revision: session.revision, path: session.filePath })) });
  const closed = () => parents.size === 0 && [...children.values()].every(child => child.closed);
  return { editor, bridge, events, disk, aliases, children, parents, receipts, root, saved, changes, snapshot, closed };
}

describe('one parent order for a bounded Windows project calculation', () => {
  it.each([33, 65, 512])('updates %i small closed drawings without late ordinary orders', async count => {
    const f = setup(count), loaded = await loadProjectSheets(f.editor, { forSave: true });
    expect(f.bridge.issueProjectSaveBatch).toHaveBeenCalledOnce(); expect(f.bridge.issueSaveAdmission).not.toHaveBeenCalled();
    expect(f.events.indexOf(`bind:${count}`)).toBeLessThan(f.events.findIndex(event => event.startsWith('read:')));
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.written).toBe(count); expect(result?.failed).toEqual([]); expect(f.bridge.saveAdmissionResult).toHaveBeenCalledTimes(count);
    expect(f.events.indexOf('begin')).toBeLessThan(f.events.findIndex(event => event.startsWith('write:'))); expect(f.closed()).toBe(true); expect(f.saved).not.toHaveBeenCalled();
    expect(readDxf(f.disk.get(`${f.root}\\closed-${count - 1}.dxf`)!).entities.some(entity => entity.type === 'text' && entity.text === `update-${count - 1}`)).toBe(true);
  }, 15000);
  it('awaits the immediately issued parent before touching project/session snapshots', async () => {
    const f = setup(), gate = deferred<string>(), project = f.editor.project;
    f.bridge.issueProjectSaveBatch = vi.fn(() => { f.events.push('issue:delayed'); return gate.promise; });
    Object.defineProperty(f.editor, 'project', { configurable: true, get() { f.events.push('snapshot:project'); return project; } });
    const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(f.editor.sessions), 'all')!.get!;
    vi.spyOn(f.editor.sessions, 'all', 'get').mockImplementation(() => { f.events.push('snapshot:tabs'); return getter.call(f.editor.sessions); });
    const loading = loadProjectSheets(f.editor, { forSave: true }); expect(f.events).toEqual(['issue:delayed']);
    gate.resolve('parent'); const loaded = await loading; expect(f.events[1]).toBe('snapshot:project');
    await commitSheets(f.editor, loaded.sheets, new Map(), 'none', 'none'); expect(f.closed()).toBe(true);
  });
  it('skips a missing source without registering a provisional alias or creating a child', async () => {
    const f = setup(2), missing = `${f.root}\\closed-1.dxf`; f.disk.delete(missing);
    const loaded = await loadProjectSheets(f.editor, { forSave: true }); expect(loaded.sheets).toHaveLength(1); expect(loaded.skipped[0]).toMatch(/file not found/);
    expect(pathIdentityKey(missing)).toMatch(/^lexical:/); expect(f.children.size).toBe(1);
    expect((await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test'))?.written).toBe(1); expect(f.closed()).toBe(true);
  });
  it('does not issue write orders for read-only loads', async () => {
    const f = setup(2); await loadProjectSheets(f.editor); expect(f.bridge.issueProjectSaveBatch).not.toHaveBeenCalled(); expect(f.bridge.issueSaveAdmission).not.toHaveBeenCalled();
  });
  it('releases an oversized manifest before reads or tab/file mutations', async () => {
    const f = setup(513, true), before = f.snapshot(), original = [...f.disk];
    await expect(loadProjectSheets(f.editor, { forSave: true })).rejects.toThrow(/too many closed drawings/);
    expect(f.bridge.openProjectSaveBatchDrawing).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before); expect([...f.disk]).toEqual(original); expect(f.closed()).toBe(true);
  });
  it('releases every child when a coherent read reports a changed original pin', async () => {
    const f = setup(2, true), before = f.snapshot(); f.bridge.openProjectSaveBatchDrawing = vi.fn(async () => { throw error('ERR_WINDOWS_PATH_CHANGED'); });
    await expect(loadProjectSheets(f.editor, { forSave: true })).rejects.toThrow(/ERR_WINDOWS_PATH_CHANGED/);
    expect(f.snapshot()).toEqual(before); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('refuses duplicate open rows with different sheet metadata before copying or calculating drawings', async () => {
    const f = setup(0, true); f.editor.replaceProject({ ...f.editor.project, drawings: [{ file: 'active.dxf', sheet: '1', description: 'First' }, { file: 'active.dxf', sheet: '2', description: 'Second' }] }, false);
    const before = f.snapshot(), produce = vi.spyOn(Drawing.prototype, 'load');
    await expect(loadProjectSheets(f.editor, { forSave: true })).rejects.toThrow(/same open drawing/);
    expect(produce).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before); expect(f.bridge.sealProjectSaveBatch).not.toHaveBeenCalled(); expect(f.bridge.beginProjectSaveBatchCommit).not.toHaveBeenCalled(); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
});

describe('complete preflight before any tab mutation', () => {
  it.each(['sealProjectSaveBatch', 'beginProjectSaveBatchCommit'] as const)('preserves all state/history/dirty/selection on %s failure', async method => {
    const f = setup(2, true), loaded = await loadProjectSheets(f.editor, { forSave: true }), before = f.snapshot(), original = [...f.disk];
    f.bridge[method] = vi.fn(async () => { throw error('ERR_SAVE_LEDGER_LIMIT'); });
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.open).toBe(0); expect(result?.written).toBe(0); expect(result?.failed.join(' ')).toMatch(/no drawing or tab changed/);
    expect(f.snapshot()).toEqual(before); expect([...f.disk]).toEqual(original); expect(f.closed()).toBe(true);
  });
  it('checks unchanged source tabs used in the calculation, including edit followed by Undo', async () => {
    const f = setup(1, true), loaded = await loadProjectSheets(f.editor, { forSave: true });
    f.editor.doc.addEntities([note('temporary')]); f.editor.doc.undo(); const before = f.snapshot();
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets, [2]), 'Batch', 'test');
    expect(result?.conflicts.join(' ')).toMatch(/active.dxf.*edited/); expect(f.snapshot()).toEqual(before); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('checks an unselected closed source whose data influenced a selected drawing', async () => {
    const f = setup(2, true), loaded = await loadProjectSheets(f.editor, { forSave: true }), before = f.snapshot();
    f.disk.set(`${f.root}\\closed-1.dxf`, writeDxf(new Drawing({ entities: [note('external change')] }).snapshot));
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets, [0, 2]), 'Batch', 'test');
    expect(result?.open).toBe(0); expect(result?.written).toBe(0); expect(f.snapshot()).toEqual(before); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('does not partially change an earlier tab when the final drawing fails serialization', async () => {
    const f = setup(2, true), loaded = await loadProjectSheets(f.editor, { forSave: true }), before = f.snapshot(), serializer = dxf.writeDxf;
    vi.spyOn(dxf, 'writeDxf').mockImplementation(state => { if (state.entities.some(entity => entity.type === 'text' && entity.text === 'update-3')) throw new Error('retained unsupported property cannot be saved'); return serializer(state); });
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.failed.join(' ')).toMatch(/retained unsupported/); expect(f.snapshot()).toEqual(before); expect(f.bridge.backupFile).not.toHaveBeenCalled(); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('cancels after confirmation without modifying files, tabs or recovery hooks', async () => {
    const f = setup(1, true), loaded = await loadProjectSheets(f.editor, { forSave: true }), before = f.snapshot(); vi.mocked(projectUi.confirmFiles).mockResolvedValue(null);
    expect(await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test')).toBeNull(); expect(f.snapshot()).toEqual(before); expect(f.saved).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('rechecks all open tabs after the final native preflight callback', async () => {
    const f = setup(1, true), loaded = await loadProjectSheets(f.editor, { forSave: true }), begin = f.bridge.beginProjectSaveBatchCommit;
    f.bridge.beginProjectSaveBatchCommit = vi.fn(async (...args: Parameters<ProjectSaveBatchBridge['beginProjectSaveBatchCommit']>) => { await begin(...args); f.editor.doc.addEntities([note('late user edit')]); });
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.open).toBe(0); expect(f.editor.doc.entities.some(entity => entity.type === 'text' && entity.text === 'late user edit')).toBe(true); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
});

describe('backup and receipt lifetimes', () => {
  it('uses selected children for backups and writes, while Continue Without Backup keeps the same order', async () => {
    const f = setup(1, true), loaded = await loadProjectSheets(f.editor, { forSave: true }); vi.mocked(projectUi.confirmFiles).mockResolvedValue({ files: true, backup: true }); vi.mocked(projectUi.confirmNoBackup).mockResolvedValue(true);
    f.bridge.backupFile = vi.fn(async (_path, options) => { f.events.push(`failed-backup:${options?.admission}`); return { ok: false as const, error: 'private permission failure' }; });
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.open).toBe(2); expect(result?.written).toBe(1); expect(f.bridge.backupFile).toHaveBeenCalledWith(`${f.root}\\closed-0.dxf`, { admission: 'child-0' });
    expect(f.bridge.saveDxf).toHaveBeenCalledWith(`${f.root}\\closed-0.dxf`, expect.any(String), expect.any(String), { backup: false, admission: 'child-0' }); expect(f.events.indexOf('seal')).toBeLessThan(f.events.indexOf('failed-backup:child-0')); expect(f.closed()).toBe(true);
  });
  it('narrows final host scope after a declined backup without issuing a replacement ticket', async () => {
    const f = setup(2, true), loaded = await loadProjectSheets(f.editor, { forSave: true }); vi.mocked(projectUi.confirmFiles).mockResolvedValue({ files: true, backup: true });
    f.bridge.backupFile = vi.fn(async path => path.endsWith('closed-0.dxf') ? { ok: false as const, error: 'failed' } : { ok: true as const, path: `${path}.bak` });
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.open).toBe(2); expect(result?.written).toBe(1); expect(f.bridge.beginProjectSaveBatchCommit).toHaveBeenCalledWith(expect.any(String), ['child-1']); expect(f.bridge.issueSaveAdmission).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('refuses a stale backup before changing any tab or asking Continue Without Backup', async () => {
    const f = setup(1, true), loaded = await loadProjectSheets(f.editor, { forSave: true }), before = f.snapshot(); vi.mocked(projectUi.confirmFiles).mockResolvedValue({ files: true, backup: true });
    f.bridge.backupFile = vi.fn(async () => { throw error('ERR_SAVE_STALE'); });
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.open).toBe(0); expect(result?.conflicts.join(' ')).toMatch(/nothing changed/); expect(projectUi.confirmNoBackup).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before); expect(f.closed()).toBe(true);
  });
  it('uses captured commit identity and refuses an unavailable receipt without a fresh lookup', async () => {
    const f = setup(), loaded = await loadProjectSheets(f.editor, { forSave: true });
    f.bridge.resolvePathIdentity = vi.fn(async () => { throw new Error('fresh identity would refer to a retargeted path'); }); f.bridge.saveAdmissionResult = vi.fn(async () => null);
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.written).toBe(0); expect(result?.failed.join(' ')).toMatch(/receipt is unavailable/); expect(f.bridge.resolvePathIdentity).not.toHaveBeenCalled(); expect(f.saved).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('joins one pending cancellation when an event and finally both close the parent', async () => {
    const f = setup(), gate = deferred<void>(); f.bridge.cancelProjectSaveBatch = vi.fn(async () => gate.promise);
    const batch = new ProjectSaveBatch(f.bridge); await batch.ready;
    const first = batch.close(), second = batch.close(); expect(second).toBe(first); expect(f.bridge.cancelProjectSaveBatch).toHaveBeenCalledOnce(); let done = false; void second.then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false); gate.resolve(); await second; expect(done).toBe(true);
  });
  it('cancels an awaited host save when a source tab changes and preserves newer edits', async () => {
    const f = setup(2, true), loaded = await loadProjectSheets(f.editor, { forSave: true }), gate = deferred<void>(), originalCancel = f.bridge.cancelProjectSaveBatch, before = [...f.disk], sessionChange = f.editor.sessions.onChange;
    f.bridge.saveDxf = vi.fn(async () => { await gate.promise; throw error('ERR_SAVE_CANCELLED'); });
    f.bridge.cancelProjectSaveBatch = vi.fn(async ticket => { await originalCancel(ticket); gate.resolve(); });
    const saving = commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test'); await vi.waitFor(() => expect(f.bridge.saveDxf).toHaveBeenCalledOnce());
    f.editor.doc.addEntities([note('edit while native save waits')]); expect(f.bridge.cancelProjectSaveBatch).toHaveBeenCalledOnce();
    const result = await saving; expect(result?.written).toBe(0); expect(result?.conflicts.join(' ')).toMatch(/source active.dxf.*pending save cancelled or unconfirmed/); expect([...f.disk]).toEqual(before);
    expect(f.editor.doc.entities.some(entity => entity.type === 'text' && entity.text === 'edit while native save waits')).toBe(true); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled(); expect(f.bridge.saveDxf).toHaveBeenCalledOnce(); expect(f.editor.sessions.onChange).toBe(sessionChange); expect(f.closed()).toBe(true);
  });
  it('reports a write that committed before cancellation as a partial result, without later outputs', async () => {
    const f = setup(2, true), loaded = await loadProjectSheets(f.editor, { forSave: true }), gate = deferred<void>(), write = f.bridge.saveDxf, originalCancel = f.bridge.cancelProjectSaveBatch, untouched = f.disk.get(`${f.root}\\closed-1.dxf`);
    f.bridge.saveDxf = vi.fn(async (...args: Parameters<FileBridge['saveDxf']>) => { const path = await write(...args); await gate.promise; return path; });
    f.bridge.cancelProjectSaveBatch = vi.fn(async ticket => { await originalCancel(ticket); gate.resolve(); });
    const saving = commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test'); await vi.waitFor(() => expect(f.bridge.saveDxf).toHaveBeenCalledOnce());
    f.editor.doc.addEntities([note('edit after rename')]); const result = await saving;
    expect(result?.written).toBe(1); expect(result?.conflicts.join(' ')).toMatch(/saved before source active.dxf.*partial project result/); expect(result?.warnings?.join(' ')).toMatch(/write completed while a source changed/);
    expect(f.disk.get(`${f.root}\\closed-1.dxf`)).toBe(untouched); expect(f.bridge.saveDxf).toHaveBeenCalledOnce(); expect(f.bridge.saveAdmissionResult).toHaveBeenCalledWith('child-0'); expect(f.editor.doc.entities.some(entity => entity.type === 'text' && entity.text === 'edit after rename')).toBe(true); expect(f.closed()).toBe(true);
  });
});

describe('open drawing history and reentrant edits', () => {
  it.each([true, false])('updates an unchanged untitled drawing in an empty project (batch host: %s)', async batchHost => {
    const f = setup(0); f.editor.doc.filePath = null; f.editor.replaceProject({ name: 'Empty', drawings: [] }, false);
    if (!batchHost) f.bridge.platform = 'browser';
    const loaded = await loadProjectSheets(f.editor, { forSave: true }), previous = f.editor.doc.snapshot;
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.open).toBe(1); expect(result?.conflicts).toEqual([]); expect(f.editor.doc.filePath).toBeNull(); expect(f.editor.doc.dirty).toBe(true);
    expect(f.editor.doc.undo()).toBe(true); expect(f.editor.doc.snapshot).toBe(previous); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.saved).not.toHaveBeenCalled();
    if (batchHost) { expect(f.bridge.bindProjectSaveBatch).toHaveBeenCalledWith(expect.any(String), []); expect(f.bridge.beginProjectSaveBatchCommit).toHaveBeenCalledWith(expect.any(String), []); expect(f.closed()).toBe(true); }
  });
  it.each([false, true])('checks an unselected untitled source basis without confusing null paths (edited: %s)', async edited => {
    const f = setup(1); f.editor.doc.filePath = null;
    const loaded = await loadProjectSheets(f.editor, { forSave: true }), source = f.editor.sessions.current, doc = new Drawing(); doc.load(source.state);
    const basis: LoadedSheet = { ...makeSheet(doc, { name: 'Drawing1', index: -1 }), source: 'active', sessionId: source.id, session: source, base: source.state, sessionRevision: source.revision, history: f.editor.doc.history(), projectState: f.editor.projectState, projectBatch: loaded.sheets[0]!.projectBatch };
    const sheets = [basis, ...loaded.sheets]; if (edited) f.editor.doc.addEntities([note('new unsaved source edit')]);
    const result = await commitSheets(f.editor, sheets, f.changes(sheets, [1]), 'Batch', 'test');
    expect(result?.written).toBe(edited ? 0 : 1); expect(result?.open).toBe(0); expect(f.editor.doc.filePath).toBeNull(); expect(f.saved).not.toHaveBeenCalled();
    if (edited) expect(result?.conflicts.join(' ')).toMatch(/Drawing1.*edited/); else expect(result?.conflicts).toEqual([]); expect(f.closed()).toBe(true);
  });
  it('updates paper-space model geometry without intermediate space changes or losing layout history', async () => {
    const f = setup(0, true); f.editor.doc.transactDrawing(state => ({ ...state, layouts: [defaultLayout('L1')], space: { layout: 'L1' } }));
    const loaded = await loadProjectSheets(f.editor, { forSave: true }); let triggered = false;
    f.editor.doc.subscribe(doc => { if (!doc.space) { triggered = true; doc.addEntities([note('user edit during model switch')]); } });
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets, [0]), 'Batch', 'test');
    expect(result?.open).toBe(1); expect(triggered).toBe(false); expect(f.editor.doc.space).toEqual({ layout: 'L1' }); f.editor.doc.undo(); expect(f.editor.doc.space).toEqual({ layout: 'L1' }); expect(f.closed()).toBe(true);
  });
  it('keeps a reentrant user edit after a committed update and reports notification failure honestly', async () => {
    const f = setup(0, true), loaded = await loadProjectSheets(f.editor, { forSave: true }); let first = true;
    f.editor.doc.subscribe(doc => { if (first) { first = false; doc.transactDrawing(state => ({ ...state, entities: [...state.entities, note('newer user edit')] })); throw new Error('listener failed after committing'); } });
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets, [0]), 'Batch', 'test');
    expect(result?.open).toBe(1); expect(result?.failed).toEqual([]); expect(result?.warnings?.join(' ')).toMatch(/listener failed/); expect(f.editor.doc.entities.some(entity => entity.type === 'text' && entity.text === 'newer user edit')).toBe(true); expect(f.editor.doc.dirty).toBe(true); expect(f.editor.doc.canUndo()).toBe(true); expect(f.closed()).toBe(true);
  });
  it('preserves a newer reentrant source edit and refuses later dependent outputs', async () => {
    const f = setup(1, true), loaded = await loadProjectSheets(f.editor, { forSave: true }), parked = f.editor.sessions.all[1]!.state; let first = true;
    f.editor.doc.subscribe(doc => { if (first) { first = false; doc.transactDrawing(state => ({ ...state, entities: [...state.entities, note('newer source tag')] })); } });
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.open).toBe(1); expect(result?.written).toBe(0); expect(result?.conflicts.join(' ')).toMatch(/source active.dxf.*edited/);
    expect(f.editor.sessions.all[1]!.state).toBe(parked); expect(f.editor.doc.entities.some(entity => entity.type === 'text' && entity.text === 'newer source tag')).toBe(true);
    expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('rechecks open-source basis after an asynchronous disk check immediately before a write', async () => {
    const f = setup(1, true), loaded = await loadProjectSheets(f.editor, { forSave: true }), read = f.bridge.openDrawing!; let count = 0;
    f.bridge.openDrawing = vi.fn(async path => { const result = await read(path); if (++count === 2) f.editor.doc.transactDrawing(state => ({ ...state, entities: [...state.entities, note('edit during final disk check')] })); return result; });
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.open).toBe(2); expect(result?.written).toBe(0); expect(result?.conflicts.join(' ')).toMatch(/source active.dxf.*edited/);
    expect(f.editor.doc.entities.some(entity => entity.type === 'text' && entity.text === 'edit during final disk check')).toBe(true); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('applies to captured session IDs after a tab switch and trims parked history to the native limit', async () => {
    const f = setup(0, true), parked = f.editor.sessions.all[1]!, past: DrawingState = new Drawing().snapshot;
    parked.undo = Array.from({ length: f.editor.doc.undoLimit }, () => past);
    const loaded = await loadProjectSheets(f.editor, { forSave: true }); f.editor.sessions.switchTo(1);
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Batch', 'test');
    expect(result?.open).toBe(2); expect(f.editor.doc.filePath).toBe(`${f.root}\\parked.dxf`); const active = f.editor.sessions.all.find(session => session.filePath === `${f.root}\\active.dxf`)!;
    expect(active.dirty).toBe(true); expect(f.editor.doc.history().undo).toHaveLength(f.editor.doc.undoLimit); expect(f.closed()).toBe(true);
  });
});

describe('malformed native manifest refusal', () => {
  it('does not publish earlier aliases when the final returned native identity conflicts', async () => {
    const f = setup(2), first = `${f.root}\\closed-0.dxf`, second = `${f.root}\\closed-1.dxf`, canonical = `${f.root}\\real-first.dxf`;
    f.aliases.set(first, canonical); registerWindowsPathIdentity(second, `${f.root}\\already-known.dxf`);
    await expect(loadProjectSheets(f.editor, { forSave: true })).rejects.toThrow(/another native file/); expect(samePath(first, canonical)).toBe(false); expect(f.bridge.openProjectSaveBatchDrawing).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('refuses duplicate child capabilities before publishing aliases or reading source bytes', async () => {
    const f = setup(2), bind = f.bridge.bindProjectSaveBatch;
    f.bridge.bindProjectSaveBatch = vi.fn(async (...args: Parameters<ProjectSaveBatchBridge['bindProjectSaveBatch']>) => (await bind(...args)).map(record => 'childTicket' in record ? { ...record, childTicket: 'same-child' } : record));
    await expect(loadProjectSheets(f.editor, { forSave: true })).rejects.toThrow(/invalid project admission/); expect(f.bridge.openProjectSaveBatchDrawing).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('refuses distinct child capabilities pointing to one canonical target before publishing aliases', async () => {
    const f = setup(2), first = `${f.root}\\closed-0.dxf`, second = `${f.root}\\closed-1.dxf`, canonical = `${f.root}\\native-same.dxf`; f.aliases.set(first, canonical); f.aliases.set(second, canonical);
    await expect(loadProjectSheets(f.editor, { forSave: true })).rejects.toThrow(/same native file/);
    expect(pathIdentityKey(first)).toMatch(/^lexical:/); expect(pathIdentityKey(second)).toMatch(/^lexical:/); expect(f.bridge.openProjectSaveBatchDrawing).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });
  it('cannot transfer a retained child to a different path or another parent', async () => {
    const f = setup(), parent = new ProjectSaveBatch(f.bridge), children = await parent.bind([`${f.root}\\closed-0.dxf`]), child = children[0]!;
    await expect(child.bind(`${f.root}\\other.dxf`)).rejects.toThrow(/cannot be transferred/); const other = new ProjectSaveBatch(f.bridge);
    await expect(other.read(child)).rejects.toThrow(/invalid project admission/); await parent.close(); await other.close(); expect(f.closed()).toBe(true);
  });
});
