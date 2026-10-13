/** Production renderer flows; the host bridge is an explicit transport double. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import * as dxf from '../src/io/dxf';
import { withImportData, type ImportReport } from '../src/io/import-report';
import { SaveAdmission } from '../src/app/save-admission';
import { exportDwgCopy } from '../src/app/export-dwg';
import { SaveQueue } from '../src/app/savequeue';
import { registerWindowsPathIdentity, resetWindowsPathIdentitiesForTests, samePath, pathKey, setPathPlatform, MAX_WINDOWS_PATH_IDENTITIES } from '../src/app/paths';
import { commitSheets, loadProjectSheets, projectUi, runProjectWireNumbers } from '../src/app/commands-electrical';

let Editor: typeof EditorType, sequence = 0;
beforeAll(async () => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}; Editor = (await import('../src/app/editor')).Editor; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetWindowsPathIdentitiesForTests(); setPathPlatform(null); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup() {
  const number = ++sequence, root = `C:\\renderer-admission-${number}`, original = `${root}\\original.dxf`, destination = `${root}\\copy.dxf`, events: string[] = [], active = new Set<string>(), aliases = new Map<string, string>(), disk = new Map<string, string>();
  setPathPlatform('win32');
  const editor = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
  editor.doc.filePath = original;
  let next = 0;
  const bridge: FileBridge = {
    platform: 'win32', openDxf: async () => null,
    issueSaveAdmission: vi.fn(async kind => { const ticket = `ticket-${++next}`; events.push(`issue:${kind}:${ticket}`); active.add(ticket); return ticket; }),
    bindSaveAdmission: vi.fn(async (ticket, kind, file) => { events.push(`bind:${kind}:${ticket}`); const canonical = aliases.get(file) ?? file; return { identityPath: canonical, exists: disk.has(file) || disk.has(canonical) }; }),
    cancelSaveAdmission: vi.fn(async ticket => { events.push(`cancel:${ticket}`); active.delete(ticket); }),
    resolvePathIdentity: vi.fn(async file => { const canonical = aliases.get(file) ?? file; return disk.has(file) || disk.has(canonical) ? canonical : null; }),
    chooseDrawingPath: vi.fn(async () => { events.push('picker:drawing'); return destination; }),
    chooseProjectPath: vi.fn(async () => { events.push('picker:project'); return `${root}\\copy.jcadproj.json`; }),
    chooseDwgPath: vi.fn(async () => { events.push('picker:dwg'); return `${root}\\copy.dwg`; }),
    dwgExportStatus: vi.fn(async () => { events.push('status:dwg'); return { available: true }; }),
    saveDxf: vi.fn(async (file, text, _suggest, options) => { events.push(`write:dxf:${options?.admission}`); if (file) disk.set(file, text); return file; }),
    saveDwg: vi.fn(async (file, text, ticket) => { events.push(`write:dwg:${ticket}`); disk.set(file, text); return file; }),
    exportDwg: vi.fn(async (file, text, ticket) => { events.push(`write:export:${ticket}`); disk.set(file, text); return file; }),
    saveProject: vi.fn(async (file, text, ticket) => { events.push(`write:project:${ticket}`); disk.set(file, text); return file; }),
    openDrawing: vi.fn(async file => { events.push('read:drawing'); return file && disk.has(file) ? { kind: 'dxf' as const, path: file, text: disk.get(file)! } : null; }),
    backupFile: vi.fn(async (file, options) => { events.push(`backup:${options?.admission}`); return { ok: true as const, path: `${file}.bak` }; }),
  };
  editor.fileBridge = bridge;
  editor.ui = { pickSymbol: async () => null, editComponent: async () => null, ladderSettings: async initial => initial, textInput: async (_title, _label, initial) => initial, confirm: vi.fn(async () => { events.push('confirm'); return true; }) };
  const saved = vi.fn(); editor.hooks.drawingSaved = saved;
  const edit = (label = 'captured') => editor.doc.addEntities([{ id: `entity-${number}-${label}`, type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, height: 1, rotation: 0, align: 'left', text: label }]);
  const serializer = dxf.writeDxf;
  vi.spyOn(dxf, 'writeDxf').mockImplementation((...args) => { events.push('serialize:dxf'); return serializer(...args); });
  return { editor, bridge, root, original, destination, events, active, aliases, disk, saved, edit };
}
function imported(f: ReturnType<typeof setup>, source: string) {
  const report: ImportReport = { format: 'DWG', sourcePath: source, counts: { CUSTOM: { dropped: 1 } }, items: [{ type: 'CUSTOM', action: 'dropped', reason: 'unreadable source object' }], omitted: 0, notes: [] };
  f.editor.doc.load(withImportData(new Drawing().snapshot, report), source); f.edit();
}

describe('native identity evidence in the renderer', () => {
  it('does not merge distinct NTFS Unicode strings by lexical lowercasing', () => {
    expect(pathKey('C:\\data\\\u0130.dxf')).not.toBe(pathKey('C:\\data\\I\u0307.dxf'));
    expect(samePath('C:\\data\\\u212a.dxf', 'C:\\data\\K.dxf')).toBe(false);
  });
  it('uses registered Unicode aliases in comparison and save ordering', async () => {
    const logical = 'C:\\identity-test\\\u1f80.dxf', canonical = 'C:\\identity-test\\\u1f88.dxf';
    expect(samePath(logical, canonical)).toBe(false); registerWindowsPathIdentity(logical, canonical); expect(samePath(logical, canonical)).toBe(true);
    const queue = new SaveQueue(), writer = vi.fn(async () => logical); queue.markCompleted(canonical, 2);
    expect(await queue.run(logical, 1, writer)).toEqual({ status: 'stale' }); expect(writer).not.toHaveBeenCalled();
  });
  it('lets exact registered case-sensitive leaves override ASCII lexical fallback', () => {
    registerWindowsPathIdentity('C:\\sensitive\\A.dxf', 'C:\\sensitive\\A.dxf'); registerWindowsPathIdentity('C:\\sensitive\\a.dxf', 'C:\\sensitive\\a.dxf');
    expect(samePath('C:\\sensitive\\A.dxf', 'C:\\sensitive\\a.dxf')).toBe(false);
  });
  it('refuses conflicting reassignment and capacity growth without evicting old protection', () => {
    const first = 'C:\\identity-cap\\\u1f80.dxf', canonical = 'C:\\identity-cap\\\u1f88.dxf'; registerWindowsPathIdentity(first, canonical);
    expect(() => registerWindowsPathIdentity(first, 'C:\\identity-cap\\other.dxf')).toThrow(/another native file/);
    for (let i = 0; i < MAX_WINDOWS_PATH_IDENTITIES - 2; i++) registerWindowsPathIdentity(`C:\\identity-cap\\${i}.dxf`, `C:\\identity-cap\\${i}.dxf`);
    expect(() => registerWindowsPathIdentity('C:\\identity-cap\\extra.dxf', 'C:\\identity-cap\\extra.dxf')).toThrow(/history is full/);
    expect(samePath(first, canonical)).toBe(true);
  });
  it('does not poison a missing Unicode candidate when another native spelling is created', async () => {
    const f = setup(), missing = `${f.root}\\\u1f80.dxf`, stored = `${f.root}\\\u1f88.dxf`;
    const old = new SaveAdmission(f.bridge, 'drawing'); await old.bind(missing); await old.close();
    expect(samePath(missing, stored)).toBe(false);
    f.disk.set(missing, 'newer native file'); f.aliases.set(missing, stored);
    const retry = new SaveAdmission(f.bridge, 'drawing'); await expect(retry.bind(missing)).resolves.toBeUndefined(); expect(samePath(missing, stored)).toBe(true); await retry.close();
  });
});

describe('drawing/project/export admission lifetimes', () => {
  it('issues immediately, waits before serialization, binds before writing and releases success', async () => {
    const f = setup(), gate = deferred<string>(); f.edit();
    f.bridge.issueSaveAdmission = vi.fn(() => { f.events.push('issue:delayed'); return gate.promise; });
    const saving = f.editor.saveFile(false); expect(f.events).toEqual(['issue:delayed']); expect(f.bridge.bindSaveAdmission).not.toHaveBeenCalled();
    gate.resolve('delayed-ticket'); expect(await saving).toBe(true);
    expect(f.events.indexOf('bind:drawing:delayed-ticket')).toBeLessThan(f.events.indexOf('serialize:dxf'));
    expect(f.bridge.saveDxf).toHaveBeenCalledWith(f.original, expect.any(String), expect.any(String), { admission: 'delayed-ticket' });
    expect(f.editor.doc.dirty).toBe(false); expect(f.saved).toHaveBeenCalledOnce(); expect(f.events.at(-1)).toBe('cancel:delayed-ticket');
  });
  it('reserves before a Save As picker and releases cancellation without changing recovery/dirty state', async () => {
    const f = setup(); f.edit(); f.bridge.chooseDrawingPath = vi.fn(async () => { f.events.push('picker:drawing'); return null; });
    const state = f.editor.doc.snapshot, history = f.editor.doc.history(); expect(await f.editor.saveFile(true)).toBe(false);
    expect(f.events).toEqual(['issue:drawing:ticket-1', 'picker:drawing', 'cancel:ticket-1']); expect(f.editor.doc.snapshot).toBe(state); expect(f.editor.doc.history()).toEqual(history); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled();
  });
  it('keeps edits made while the admitted write was pending dirty', async () => {
    const f = setup(), gate = deferred<string | null>(); f.edit('first'); f.bridge.saveDxf = vi.fn(() => gate.promise);
    const saving = f.editor.saveFile(false); await vi.waitFor(() => expect(f.bridge.saveDxf).toHaveBeenCalled()); f.edit('second'); gate.resolve(f.original);
    expect(await saving).toBe(true); expect(f.editor.doc.dirty).toBe(true); expect(f.active.size).toBe(0);
  });
  it('does not bind a replaced drawing or clear its recovery state after an older admitted save completes', async () => {
    const f = setup(), gate = deferred<string | null>(); f.edit('old'); f.bridge.saveDxf = vi.fn(() => gate.promise);
    const saving = f.editor.saveFile(false); await vi.waitFor(() => expect(f.bridge.saveDxf).toHaveBeenCalled()); f.editor.newDrawingNow(); f.edit('replacement');
    const replacement = f.editor.doc.snapshot, path = f.editor.doc.filePath; gate.resolve(f.original);
    expect(await saving).toBe(true); expect(f.editor.doc.snapshot).toBe(replacement); expect(f.editor.doc.filePath).toBe(path); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled(); expect(f.active.size).toBe(0);
  });
  it.each(['ERR_SAVE_STALE', 'ERR_SAVE_PAYLOAD_LIMIT'])('keeps dirty/recovery data and releases a %s write failure', async code => {
    const f = setup(); f.edit(); const state = f.editor.doc.snapshot; f.bridge.saveDxf = vi.fn(async () => { throw Object.assign(new Error(code), { code }); });
    expect(await f.editor.saveFile(false)).toBe(false); expect(f.editor.doc.snapshot).toBe(state); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled(); expect(f.active.size).toBe(0);
  });
  it('uses a fresh snapshot and ticket for the normal ungranted-path Save As fallback', async () => {
    const f = setup(); f.edit('before'); const bind = f.bridge.bindSaveAdmission!;
    f.bridge.bindSaveAdmission = vi.fn(async (ticket, kind, file) => { if (file === f.original) { f.edit('newer'); throw Object.assign(new Error('not authorized'), { code: 'ERR_SAVE_AUTHORIZATION' }); } return bind(ticket, kind, file); });
    expect(await f.editor.saveFile(false)).toBe(true); expect(f.editor.doc.filePath).toBe(f.destination); expect(f.editor.doc.dirty).toBe(false); expect(f.active.size).toBe(0);
    expect(f.events.indexOf('cancel:ticket-1')).toBeLessThan(f.events.indexOf('issue:drawing:ticket-2'));
    expect(readDxf(f.disk.get(f.destination)!).entities).toHaveLength(2);
  });
  it('binds/resolves native aliases before asking about import losses', async () => {
    const f = setup(), original = `${f.root}\\\u1f88.dxf`, alias = `${f.root}\\\u1f80.dxf`; imported(f, original);
    f.disk.set(original, 'original'); f.disk.set(alias, 'original'); f.aliases.set(alias, original); f.bridge.chooseDrawingPath = async () => alias;
    expect(await f.editor.saveFile(true)).toBe(true); expect(f.editor.ui!.confirm).toHaveBeenCalledOnce();
    expect(f.events.indexOf('bind:drawing:ticket-1')).toBeLessThan(f.events.indexOf('confirm')); expect(f.events.indexOf('confirm')).toBeLessThan(f.events.indexOf('serialize:dxf'));
  });
  it('requires explicit conservative loss review when a recovered source identity is unavailable', async () => {
    const f = setup(); imported(f, f.original);
    expect(await f.editor.saveFile(true)).toBe(true); expect(f.editor.ui!.confirm).toHaveBeenCalledWith('Review imported drawing before saving', expect.stringMatching(/could not be verified/));
  });
  it('confirms a successfully created native leaf before queue bookkeeping', async () => {
    const f = setup(), stored = `${f.root}\\\u1f88.dxf`, alias = `${f.root}\\\u1f80.dxf`; f.edit(); f.bridge.chooseDrawingPath = async () => alias;
    const write = f.bridge.saveDxf!; f.bridge.saveDxf = vi.fn(async (...args: Parameters<FileBridge['saveDxf']>) => { const path = await write(...args); f.aliases.set(alias, stored); return path; });
    expect(await f.editor.saveFile(true)).toBe(true); expect(samePath(alias, stored)).toBe(true);
    const queue = new SaveQueue(); queue.markCompleted(alias, 2); expect(await queue.run(stored, 1, async () => stored)).toEqual({ status: 'stale' });
  });
  it('keeps a missing alias retry usable after an old save becomes stale and a newer spelling is created', async () => {
    const f = setup(), missing = `${f.root}\\\u1f80.dxf`, stored = `${f.root}\\\u1f88.dxf`, release = deferred<void>(); f.edit('old'); f.aliases.set(missing, stored);
    let destination = missing; f.bridge.chooseDrawingPath = async () => destination;
    const write = f.bridge.saveDxf!;
    f.bridge.saveDxf = vi.fn(async (...args: Parameters<FileBridge['saveDxf']>) => { if (args[3]?.admission === 'ticket-1') { await release.promise; throw Object.assign(new Error('older host save'), { code: 'ERR_SAVE_STALE' }); } return write(...args); });
    const old = f.editor.saveFile(true); await vi.waitFor(() => expect(f.bridge.saveDxf).toHaveBeenCalled());
    destination = stored; f.edit('new'); expect(await f.editor.saveFile(true)).toBe(true); release.resolve(); expect(await old).toBe(false);
    expect(f.editor.doc.filePath).toBe(stored); expect(f.editor.doc.dirty).toBe(false); expect(f.saved).toHaveBeenCalledOnce();
    destination = missing; expect(await f.editor.saveFile(true)).toBe(true); expect(samePath(missing, stored)).toBe(true); expect(f.active.size).toBe(0);
  });
  it('registers the captured commit receipt after a junction retarget without re-resolving the path', async () => {
    const f = setup(), committed = `${f.root}\\PhysicalA\\copy.dxf`, retargeted = `${f.root}\\PhysicalB\\copy.dxf`; f.edit();
    f.bridge.saveAdmissionResult = vi.fn(async () => ({ path: f.destination, identityPath: committed }));
    f.bridge.resolvePathIdentity = vi.fn(async () => { throw new Error('Fresh lookup would identify the wrong file'); });
    const write = f.bridge.saveDxf!; f.bridge.saveDxf = vi.fn(async (...args: Parameters<FileBridge['saveDxf']>) => { const saved = await write(...args); f.aliases.set(f.destination, retargeted); return saved; });
    expect(await f.editor.saveFile(true)).toBe(true); expect(samePath(f.destination, committed)).toBe(true); expect(samePath(f.destination, retargeted)).toBe(false);
    expect(f.bridge.resolvePathIdentity).not.toHaveBeenCalled(); expect(f.bridge.saveAdmissionResult).toHaveBeenCalledWith('ticket-1'); expect(f.active.size).toBe(0);
  });
  it('keeps the drawing modified and its recovery hook untouched when a new host loses its commit receipt', async () => {
    const f = setup(); f.edit(); f.bridge.saveAdmissionResult = vi.fn(async () => null);
    expect(await f.editor.saveFile(false)).toBe(false); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled(); expect(f.active.size).toBe(0);
    expect(f.editor.lastFileError).toMatch(/receipt is unavailable/);
  });
  it('preserves old/browser bridge save behavior without adding ticket arguments', async () => {
    const f = setup(); f.edit(); delete f.bridge.issueSaveAdmission; delete f.bridge.bindSaveAdmission; delete f.bridge.cancelSaveAdmission;
    expect(await f.editor.saveFile(false)).toBe(true); expect(f.bridge.saveDxf).toHaveBeenCalledWith(f.original, expect.any(String), expect.any(String)); expect(f.events.some(event => event.startsWith('issue:'))).toBe(false);
  });
  it('passes a ticket to native DWG saving after binding and status checks', async () => {
    const f = setup(); f.editor.doc.filePath = `${f.root}\\original.dwg`; f.edit(); expect(await f.editor.saveFile(false)).toBe(true);
    expect(f.bridge.saveDwg).toHaveBeenCalledWith(`${f.root}\\original.dwg`, expect.any(String), 'ticket-1'); expect(f.events.indexOf('issue:drawing:ticket-1')).toBeLessThan(f.events.indexOf('status:dwg')); expect(f.active.size).toBe(0);
  });
  it('reserves project saves before the picker, rebase and serializer and keeps later edits dirty', async () => {
    const f = setup(), gate = deferred<string | null>(); f.editor.replaceProject({ name: 'P', drawings: [{ file: 'I\u0307.dxf' }] }, true); f.bridge.saveProject = vi.fn(() => gate.promise);
    const saving = f.editor.saveProject(true); await vi.waitFor(() => expect(f.bridge.saveProject).toHaveBeenCalled()); f.editor.updateProject({ ...f.editor.project, description: 'later' });
    gate.resolve(`${f.root}\\copy.jcadproj.json`); expect(await saving).toBe(true); expect(f.editor.projectDirty).toBe(true); expect(f.editor.project.description).toBe('later');
    expect(f.events.indexOf('issue:project:ticket-1')).toBeLessThan(f.events.indexOf('picker:project')); expect(f.bridge.saveProject).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('I\u0307.dxf'), 'ticket-1'); expect(f.active.size).toBe(0);
  });
  it('reserves DWG exports before status/picker and never marks the working drawing saved', async () => {
    const f = setup(); f.edit(); const state = f.editor.doc.snapshot, history = f.editor.doc.history(); expect(await exportDwgCopy(f.editor)).toBe(true);
    expect(f.events.indexOf('issue:export-copy:ticket-1')).toBeLessThan(f.events.indexOf('status:dwg')); expect(f.bridge.exportDwg).toHaveBeenCalledWith(`${f.root}\\copy.dwg`, expect.any(String), 'ticket-1');
    expect(f.editor.doc.snapshot).toBe(state); expect(f.editor.doc.history()).toEqual(history); expect(f.editor.doc.dirty).toBe(true); expect(f.editor.doc.filePath).toBe(f.original); expect(f.saved).not.toHaveBeenCalled(); expect(f.active.size).toBe(0);
  });
});

describe('project batch reservation completeness', () => {
  function project(f: ReturnType<typeof setup>, count = 1) {
    vi.stubGlobal('window', { jcad: {} }); f.editor.replaceProject({ name: 'P', path: `${f.root}\\P.jcadproj.json`, drawings: Array.from({ length: count }, (_, i) => ({ file: `closed-${i}.dxf` })) }, false);
    for (let i = 0; i < count; i++) f.disk.set(`${f.root}\\closed-${i}.dxf`, writeDxf(new Drawing().snapshot));
  }
  it('read-only sheets do not issue host write reservations', async () => {
    const f = setup(); project(f); await loadProjectSheets(f.editor); expect(f.bridge.issueSaveAdmission).not.toHaveBeenCalled();
  });
  it('reserves and binds every writable file before its first read, then closes unchanged work', async () => {
    const f = setup(); project(f, 2); const loaded = await loadProjectSheets(f.editor, { forSave: true });
    const firstRead = f.events.indexOf('read:drawing'); expect(f.events.indexOf('issue:drawing:ticket-2')).toBeLessThan(firstRead); expect(f.events.indexOf('bind:drawing:ticket-2')).toBeLessThan(firstRead);
    expect(f.active.size).toBe(2); await commitSheets(f.editor, loaded.sheets, new Map(), 'none', 'none'); expect(f.active.size).toBe(0);
  });
  it('refuses capacity before reading/calculating/mutating any sheet and reports the product error', async () => {
    const f = setup(); project(f, 3); const issue = f.bridge.issueSaveAdmission!; let count = 0;
    f.bridge.issueSaveAdmission = vi.fn(kind => ++count > 2 ? Promise.reject(Object.assign(new Error('Too many saves are pending.'), { code: 'ERR_SAVE_CAPACITY' })) : issue(kind));
    const original = f.editor.doc.snapshot; await runProjectWireNumbers(f.editor, false);
    expect(f.bridge.openDrawing).not.toHaveBeenCalled(); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.editor.doc.snapshot).toBe(original); expect(f.active.size).toBe(0); expect(f.editor.history.at(-1)).toMatch(/smaller project batch.*Nothing was changed/);
  });
  it('releases all reservations when the user cancels the batch dialog', async () => {
    const f = setup(); project(f); const loaded = await loadProjectSheets(f.editor, { forSave: true }); vi.spyOn(projectUi, 'confirmFiles').mockResolvedValue(null);
    expect(await commitSheets(f.editor, loaded.sheets, new Map([[0, { state: loaded.sheets[0]!.doc.snapshot, detail: 'test' }]]), 'test', 'test')).toBeNull();
    expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.active.size).toBe(0);
  });
  it('uses the same bound ticket for a backup and final DXF write', async () => {
    const f = setup(); project(f); const loaded = await loadProjectSheets(f.editor, { forSave: true }); vi.spyOn(projectUi, 'confirmFiles').mockResolvedValue({ files: true, backup: true });
    const result = await commitSheets(f.editor, loaded.sheets, new Map([[0, { state: loaded.sheets[0]!.doc.snapshot, detail: 'test' }]]), 'test', 'test');
    expect(result?.written).toBe(1); expect(f.bridge.backupFile).toHaveBeenCalledWith(`${f.root}\\closed-0.dxf`, { admission: 'ticket-1' });
    expect(f.bridge.saveDxf).toHaveBeenCalledWith(`${f.root}\\closed-0.dxf`, expect.any(String), expect.any(String), { backup: false, admission: 'ticket-1' }); expect(f.active.size).toBe(0);
  });
  it('retains the admitted write after the user chooses Continue Without Backup', async () => {
    const f = setup(); project(f); const loaded = await loadProjectSheets(f.editor, { forSave: true });
    vi.spyOn(projectUi, 'confirmFiles').mockResolvedValue({ files: true, backup: true }); vi.spyOn(projectUi, 'confirmNoBackup').mockResolvedValue(true);
    f.bridge.backupFile = vi.fn(async () => ({ ok: false as const, error: 'private backup failure' }));
    const result = await commitSheets(f.editor, loaded.sheets, new Map([[0, { state: loaded.sheets[0]!.doc.snapshot, detail: 'test' }]]), 'test', 'test');
    expect(result?.written).toBe(1); expect(f.bridge.saveDxf).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.any(String), { backup: false, admission: 'ticket-1' }); expect(f.active.size).toBe(0);
  });
  it('never overrides a stale backup refusal through Continue Without Backup', async () => {
    const f = setup(); project(f); const loaded = await loadProjectSheets(f.editor, { forSave: true });
    vi.spyOn(projectUi, 'confirmFiles').mockResolvedValue({ files: true, backup: true }); const consent = vi.spyOn(projectUi, 'confirmNoBackup').mockResolvedValue(true);
    f.bridge.backupFile = vi.fn(async () => { throw Object.assign(new Error('newer save'), { code: 'ERR_SAVE_STALE' }); });
    const result = await commitSheets(f.editor, loaded.sheets, new Map([[0, { state: loaded.sheets[0]!.doc.snapshot, detail: 'test' }]]), 'test', 'test');
    expect(result?.written).toBe(0); expect(result?.conflicts).toHaveLength(1); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(consent).not.toHaveBeenCalled(); expect(f.active.size).toBe(0);
  });
  it('closes every reservation when preparing one proposed drawing fails', async () => {
    const f = setup(); project(f, 2); const loaded = await loadProjectSheets(f.editor, { forSave: true }); const initial = f.editor.doc.snapshot;
    const bad = { ...loaded.sheets[0]!.doc.snapshot, entities: [{ id: 'bad', type: 'circle' as const, layer: '0', color: 'ByLayer' as const, center: { x: 0, y: 0 }, radius: NaN }] };
    await expect(commitSheets(f.editor, loaded.sheets, new Map([[0, { state: bad, detail: 'bad geometry' }]]), 'test', 'test')).rejects.toThrow();
    expect(f.active.size).toBe(0); expect(f.bridge.backupFile).not.toHaveBeenCalled(); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.editor.doc.snapshot).toBe(initial);
  });
  it('refuses late-ticket commits from read-only snapshots before any tabs/files change', async () => {
    const f = setup(); project(f); const loaded = await loadProjectSheets(f.editor); vi.spyOn(projectUi, 'confirmFiles').mockResolvedValue({ files: true, backup: false });
    await expect(commitSheets(f.editor, loaded.sheets, new Map([[0, { state: loaded.sheets[0]!.doc.snapshot, detail: 'test' }]]), 'test', 'test')).rejects.toThrow(/prepared without/);
    expect(f.bridge.issueSaveAdmission).not.toHaveBeenCalled(); expect(f.bridge.saveDxf).not.toHaveBeenCalled();
  });
});
