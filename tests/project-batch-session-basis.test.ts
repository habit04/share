/** Real Editor/session checks; the project IPC transport and files are explicit doubles. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { commitSheets, loadProjectSheets, projectUi, type LoadedSheet } from '../src/app/commands-electrical';
import type { ProjectBatchBinding, ProjectSaveBatchBridge } from '../src/app/project-save-batch';
import { registerWindowsPathIdentity, resetWindowsPathIdentitiesForTests, setPathPlatform } from '../src/app/paths';
import { readDxf, writeDxf } from '../src/io/dxf';

let Editor: typeof EditorType;
beforeAll(async () => {
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetWindowsPathIdentitiesForTests(); setPathPlatform(null); });
const point = (id: string): Entity => ({ id, type: 'point', layer: '0', color: 'ByLayer', position: { x: 1, y: 2 } });
const deferred = <T>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(done => { resolve = done; }), resolve: (value: T) => resolve(value) }; };

function setup(count: number, activeFile = 'active.dxf', closedFile?: string) {
  setPathPlatform('win32'); vi.stubGlobal('window', { jcad: {} });
  const root = 'C:\\session-basis', blank = writeDxf(new Drawing().snapshot), disk = new Map<string, string>();
  const editor = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
  editor.doc.load({ ...editor.doc.snapshot, entities: [point('active')] }, `${root}\\${activeFile}`);
  editor.replaceProject({ name: 'Basis', path: `${root}\\basis.jcadproj.json`, drawings: Array.from({ length: count }, (_, i) => ({ file: closedFile ?? `closed-${i}.dxf` })) }, false);
  for (const row of editor.project.drawings) disk.set(`${root}\\${row.file}`, blank);
  const pins = new Map<string, { path: string; original: string }>(), receipts = new Map<string, { path: string; identityPath: string }>();
  const bridge: FileBridge & ProjectSaveBatchBridge = {
    platform: 'win32', openDxf: async () => null,
    issueProjectSaveBatch: vi.fn(async () => 'parent'),
    bindProjectSaveBatch: vi.fn(async (_parent: string, paths: string[]) => paths.map((path, index): ProjectBatchBinding => {
      const childTicket = `child-${index}`; pins.set(childTicket, { path, original: disk.get(path)! });
      return { index, path, childTicket, identityPath: path, exists: true };
    })),
    openProjectSaveBatchDrawing: vi.fn(async (_parent, ticket) => { const pin = pins.get(ticket)!; return { kind: 'dxf' as const, path: pin.path, identityPath: pin.path, text: pin.original }; }),
    sealProjectSaveBatch: vi.fn(async () => {}), beginProjectSaveBatchCommit: vi.fn(async () => {}), cancelProjectSaveBatch: vi.fn(async () => {}),
    cancelSaveAdmission: vi.fn(async () => {}),
    openDrawing: vi.fn(async path => path && disk.has(path) ? { kind: 'dxf' as const, path, identityPath: path, text: disk.get(path)! } : null),
    saveAdmissionResult: vi.fn(async ticket => { const result = receipts.get(ticket) ?? null; receipts.delete(ticket); return result; }),
    saveDxf: vi.fn(async (path, text, _name, options) => {
      const ticket = options?.admission ?? '', pin = pins.get(ticket)!;
      if (!path || pin.path !== path || disk.get(path) !== pin.original) throw new Error('Changed test source');
      disk.set(path, text); receipts.set(ticket, { path, identityPath: path }); return path;
    }),
  };
  editor.fileBridge = bridge;
  vi.spyOn(projectUi, 'confirmFiles').mockResolvedValue({ files: true, backup: false });
  vi.spyOn(projectUi, 'confirmLoss').mockResolvedValue(true);
  const changes = (sheets: readonly LoadedSheet[]) => new Map(sheets.map((sheet, index) => [index, { state: { ...sheet.doc.snapshot, entities: [...sheet.doc.entities, point(`added-${index}`)] }, detail: 'update' }]));
  return { editor, bridge, disk, root, changes };
}

describe('fresh synchronous project session basis', () => {
  it('synchronises sessions a bounded number of times while retaining every closed source check', async () => {
    const count = 16, f = setup(count), loaded = await loadProjectSheets(f.editor, { forSave: true });
    const sync = vi.spyOn(f.editor.sessions, 'sync');
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Basis', 'test');
    expect(result?.written).toBe(count); expect(result?.conflicts).toEqual([]); expect(result?.failed).toEqual([]);
    // A per-sheet capture inside every complete basis scan requires >1,300
    // captures here. Fresh captures per scan/per await boundary stay linear.
    expect(sync.mock.calls.length).toBeLessThan(count * 12 + 32);
    expect(f.bridge.openDrawing).toHaveBeenCalledTimes(count * 2);
    expect(f.bridge.saveDxf).toHaveBeenCalledTimes(count);
    expect(f.bridge.saveAdmissionResult).toHaveBeenCalledTimes(count);
    expect(f.bridge.cancelProjectSaveBatch).toHaveBeenCalledOnce();
    for (let i = 0; i < count; i++) {
      const reopened = readDxf(f.disk.get(`${f.root}\\closed-${i}.dxf`)!);
      expect(reopened.entities).toHaveLength(1);
      expect(reopened.entities[0]).toMatchObject({ type: 'point', position: { x: 1, y: 2 } });
    }
  });

  it('keeps distinct Windows Unicode paths distinct during complete basis scans', async () => {
    const f = setup(1, 'I\u0307.dxf', '\u0130.dxf'), loaded = await loadProjectSheets(f.editor, { forSave: true });
    expect(loaded.sheets[0]?.source).toBe('file');
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Unicode', 'test');
    expect(result?.written).toBe(1); expect(result?.conflicts).toEqual([]); expect(f.editor.doc.filePath).toBe(`${f.root}\\I\u0307.dxf`);
  });

  it('rejects the complete project basis if synchronising sessions replaces the project', async () => {
    const f = setup(2), loaded = await loadProjectSheets(f.editor, { forSave: true }), original = [...f.disk];
    const synchronise = f.editor.sessions.sync.bind(f.editor.sessions);
    const sync = vi.spyOn(f.editor.sessions, 'sync').mockImplementationOnce(() => {
      synchronise(); f.editor.replaceProject({ ...f.editor.project, name: 'Replacement' }, false);
    });
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Replacement', 'test');
    expect(result?.written).toBe(0); expect(result?.conflicts).toHaveLength(2);
    expect(result?.conflicts.every(message => message.includes('project changed'))).toBe(true);
    expect(sync).toHaveBeenCalledOnce();
    expect(f.bridge.openDrawing).not.toHaveBeenCalled(); expect(f.bridge.sealProjectSaveBatch).not.toHaveBeenCalled();
    expect(f.bridge.beginProjectSaveBatchCommit).not.toHaveBeenCalled(); expect(f.bridge.saveDxf).not.toHaveBeenCalled();
    expect([...f.disk]).toEqual(original); expect(f.editor.project.name).toBe('Replacement');
  });

  it('recaptures native aliases after an awaited read when a closed source opens in a tab', async () => {
    const f = setup(1), loaded = await loadProjectSheets(f.editor, { forSave: true }), original = [...f.disk];
    const gate = deferred<Awaited<ReturnType<NonNullable<FileBridge['openDrawing']>>>>(), read = f.bridge.openDrawing!;
    f.bridge.openDrawing = vi.fn(async path => { const result = await read(path); await gate.promise; return result; });
    const committing = commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Alias', 'test');
    await vi.waitFor(() => expect(f.bridge.openDrawing).toHaveBeenCalledOnce());
    const alias = `${f.root}\\native-alias.dxf`;
    registerWindowsPathIdentity(alias, loaded.sheets[0]!.path!);
    f.editor.sessions.addInBackground(new Drawing().snapshot, alias);
    gate.resolve(null);
    const result = await committing;
    expect(result?.written).toBe(0); expect(result?.conflicts.join(' ')).toMatch(/opened in a tab/);
    expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect([...f.disk]).toEqual(original);
    expect(f.editor.sessions.all.some(session => session.filePath === alias)).toBe(true);
    expect(f.bridge.cancelProjectSaveBatch).toHaveBeenCalledOnce();
  });
});
