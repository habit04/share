/** Actual Editor/Drawing/CAD graph and project commands; Windows IPC/files are explicit transport doubles. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType, FileBridge } from '../src/app/editor';
import { Drawing, type DrawingState } from '../src/core/document';
import type { CadNode } from '../src/core/cad-graph';
import type { Entity } from '../src/core/entities';
import { commitSheets, loadProjectSheets, projectUi, type LoadedSheet } from '../src/app/commands-electrical';
import { type ProjectBatchBinding, type ProjectSaveBatchBridge } from '../src/app/project-save-batch';
import { adoptOpenedSourceProof, captureOpenedSourceProof } from '../src/app/opened-source-proof';
import { resetWindowsPathIdentitiesForTests, setPathPlatform } from '../src/app/paths';
import { readDxf, writeDxf } from '../src/io/dxf';

let Editor: typeof EditorType, sequence = 0;
beforeAll(async () => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}; Editor = (await import('../src/app/editor')).Editor; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetWindowsPathIdentitiesForTests(); setPathPlatform(null); });
const point = (id: string, x: number): Entity => ({ id, type: 'point', layer: '0', color: 'ByLayer', position: { x, y: 0 } });
function graphFixture(name: string): DrawingState {
  const a = { ...point(`${name}-a`, 0), cadIdentity: `${name}:a` }, b = { ...point(`${name}-b`, 1), cadIdentity: `${name}:b` };
  const nodes: CadNode[] = [
    { id: a.cadIdentity, sourceHandle: 'A', type: 'POINT', section: 'ENTITIES', anchor: { kind: 'entity', id: a.id }, baselineEntity: a, groups: [[5, 'A'], [360, 'D']], references: [{ groupIndex: 1, kind: 'hard-owner', target: `${name}:record`, role: 'extension' }] },
    { id: b.cadIdentity, sourceHandle: 'B', type: 'POINT', section: 'ENTITIES', anchor: { kind: 'entity', id: b.id }, baselineEntity: b, groups: [[5, 'B']] },
    { id: `${name}:record`, sourceHandle: 'D', type: 'XRECORD', section: 'OBJECTS', groups: [[5, 'D'], [330, 'A'], [340, 'B'], [1, `private opaque ${name}`], [310, '00017F80FF']], references: [{ groupIndex: 1, kind: 'soft-pointer', target: a.cadIdentity, role: 'owner' }, { groupIndex: 2, kind: 'hard-pointer', target: b.cadIdentity }] },
  ];
  return { ...new Drawing().snapshot, entities: [a, b], cadGraph: { schema: 1, documentId: `private-${name}`, sourceFormat: 'DXF', nodes } };
}
function peerId(state: DrawingState): string {
  const record = state.cadGraph!.nodes.find(node => node.type === 'XRECORD')!;
  const peer = state.cadGraph!.nodes.find(node => node.id === record.references!.find(ref => ref.kind === 'hard-pointer')!.target)!;
  if (peer.anchor?.kind !== 'entity') throw new Error('Missing native peer anchor');
  return peer.anchor.id;
}
function retainedPayload(state: DrawingState) { return state.cadGraph!.nodes.find(node => node.type === 'XRECORD')!.groups.filter(([code]) => code === 1 || code === 310); }
const failure = (code: string) => Object.assign(new Error(code), { code });

function setup(closedCount = 2) {
  setPathPlatform('win32'); vi.stubGlobal('window', { jcad: {} });
  const root = `C:\\private-graph-project-${++sequence}`, disk = new Map<string, string>(), backups = new Map<string, string>(), events: string[] = [];
  const editor = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
  editor.loadState(graphFixture('active'), `${root}\\active.dxf`);
  editor.doc.addEntities([point('active-existing-edit', 3)]); editor.doc.addEntities([point('active-redo-edit', 4)]); editor.doc.undo();
  const parkedIndex = editor.sessions.addInBackground(graphFixture('parked'), `${root}\\parked.dxf`);
  editor.sessions.switchTo(parkedIndex);
  editor.doc.addEntities([point('parked-existing-edit', 3)]); editor.doc.addEntities([point('parked-redo-edit', 4)]); editor.doc.undo(); editor.selection = new Set(['parked-a']);
  editor.sessions.switchTo(0);
  for (let index = 0; index < closedCount; index++) disk.set(`${root}\\closed-${index}.dxf`, writeDxf(new Drawing(graphFixture(`closed-${index}`)).snapshot));
  editor.replaceProject({ name: 'Graph project', path: `${root}\\P.jcadproj.json`, drawings: [{ file: 'active.dxf' }, { file: 'parked.dxf' }, ...Array.from({ length: closedCount }, (_, index) => ({ file: `closed-${index}.dxf` }))] }, false);
  const children = new Map<string, { path: string; original: string; closed: boolean }>(), receipts = new Map<string, { path: string; identityPath: string }>(), parents = new Set<string>();
  let selected = new Set<string>(), phase = 'issued';
  const assertBasis = () => { for (const child of children.values()) if (disk.get(child.path) !== child.original) throw failure('ERR_WINDOWS_PATH_CHANGED'); };
  const bridge: FileBridge & ProjectSaveBatchBridge = {
    platform: 'win32', openDxf: async () => null,
    issueProjectSaveBatch: vi.fn(async () => { events.push('issue'); parents.add('parent'); return 'parent'; }),
    bindProjectSaveBatch: vi.fn(async (_parent: string, paths: string[]) => { phase = 'bound'; events.push('bind'); return paths.map((path, index): ProjectBatchBinding => { const original = disk.get(path); if (original === undefined) return { index, path, missing: true }; const childTicket = `child-${index}`; children.set(childTicket, { path, original, closed: false }); return { index, path, childTicket, identityPath: path, exists: true }; }); }),
    openProjectSaveBatchDrawing: vi.fn(async (_parent, ticket) => { events.push(`read:${ticket}`); const child = children.get(ticket)!; assertBasis(); return { kind: 'dxf' as const, path: child.path, identityPath: child.path, text: child.original }; }),
    sealProjectSaveBatch: vi.fn(async (_parent, tickets) => { assertBasis(); phase = 'sealed'; selected = new Set(tickets); events.push('seal'); }),
    beginProjectSaveBatchCommit: vi.fn(async (_parent, tickets) => { assertBasis(); phase = 'committing'; selected = new Set(tickets ?? [...selected]); events.push('begin'); }),
    cancelProjectSaveBatch: vi.fn(async ticket => { parents.delete(ticket); children.forEach(child => { child.closed = true; }); events.push('cancel:parent'); }),
    cancelSaveAdmission: vi.fn(async ticket => { const child = children.get(ticket); if (child) child.closed = true; events.push(`cancel:${ticket}`); }),
    saveAdmissionResult: vi.fn(async ticket => { const value = receipts.get(ticket) ?? null; receipts.delete(ticket); return value; }),
    issueSaveAdmission: vi.fn(async () => { throw new Error('Batch must not acquire an ordinary order'); }),
    bindSaveAdmission: vi.fn(async (_ticket, _kind, path) => path),
    resolvePathIdentity: vi.fn(async path => disk.has(path) ? path : null),
    releaseOpenedSourceProof: vi.fn(async () => {}),
    openDrawing: vi.fn(async path => path && disk.has(path) ? { kind: 'dxf' as const, path, identityPath: path, text: disk.get(path)! } : null),
    backupFile: vi.fn(async (path, opts) => { const child = children.get(opts?.admission ?? ''); if (!child || child.closed || phase !== 'sealed' || !selected.has(opts?.admission ?? '')) throw failure('ERR_SAVE_TICKET'); assertBasis(); backups.set(path, disk.get(path)!); events.push(`backup:${path}`); return { ok: true as const, path: `${path}.bak` }; }),
    saveDxf: vi.fn(async (path, text, _name, opts) => { const ticket = opts?.admission ?? '', child = children.get(ticket); if (!path || !child || child.closed || phase !== 'committing' || !selected.has(ticket)) throw failure('ERR_SAVE_TICKET'); if (disk.get(path) !== child.original) throw failure('ERR_WINDOWS_PATH_CHANGED'); disk.set(path, text); receipts.set(ticket, { path, identityPath: path }); events.push(`write:${path}`); return path; }),
  };
  editor.fileBridge = bridge; editor.selection = new Set(['active-a']);
  for (const session of editor.sessions.all) expect(adoptOpenedSourceProof(session, session.contentGeneration, bridge, `proof-${session.id}`, session.filePath!)).toBe(true);
  const saved = vi.fn(); editor.hooks.drawingSaved = saved;
  vi.spyOn(projectUi, 'confirmFiles').mockResolvedValue({ files: true, backup: true }); vi.spyOn(projectUi, 'confirmLoss').mockResolvedValue(true); vi.spyOn(projectUi, 'confirmNoBackup').mockResolvedValue(false);
  const snapshot = () => ({ state: editor.doc.snapshot, history: editor.doc.history(), dirty: editor.doc.dirty, revision: editor.doc.revision, selection: [...editor.selection], path: editor.doc.filePath, project: editor.project, tabs: editor.sessions.all.map(session => ({ id: session.id, state: session.state, undo: [...session.undo], redo: [...session.redo], dirty: session.dirty, revision: session.revision, generation: session.contentGeneration, path: session.filePath, selection: [...session.selection] })) });
  const proofs = async () => { const values = []; for (const session of editor.sessions.all) { const source = captureOpenedSourceProof(session, bridge, session.filePath, 'in-place'); values.push(source?.hint); await source?.release(); } return values; };
  const changes = (sheets: readonly LoadedSheet[], order = sheets.map((_sheet, index) => index)) => new Map(order.map(index => { const state = sheets[index]!.doc.snapshot; return [index, { state: { ...state, entities: [...state.entities.map(({ cadIdentity: _identity, ...entity }) => entity), point(`added-${index}`, 10 + index)] }, detail: 'graph-preserving update' }]; }));
  const closed = () => parents.size === 0 && [...children.values()].every(child => child.closed);
  return { editor, bridge, root, disk, backups, events, saved, snapshot, proofs, changes, closed };
}

describe('graph-aware complete project preflight', () => {
  it.each(['active', 'parked', 'closed'] as const)('refuses a later invalid %s proposal before review, backups, writes or open-state mutation', async target => {
    const f = setup(), loaded = await loadProjectSheets(f.editor, { forSave: true });
    expect(JSON.stringify(loaded.skipped)).toBe('[]'); expect(loaded.sheets).toHaveLength(4);
    const index = target === 'active' ? 0 : target === 'parked' ? 1 : loaded.sheets.length - 1;
    const order = loaded.sheets.map((_sheet, at) => at).filter(at => at !== index).concat(index), changes = f.changes(loaded.sheets, order);
    const state = loaded.sheets[index]!.doc.snapshot, peer = peerId(state); changes.set(index, { state: { ...state, entities: state.entities.filter(entity => entity.id !== peer) }, detail: 'invalid later hard dependency' });
    const before = f.snapshot(), beforeDisk = [...f.disk], proofs = await f.proofs();
    expect(before.dirty).toBe(true); expect(before.history.undo.length).toBeGreaterThan(0); expect(before.history.redo.length).toBeGreaterThan(0); expect(before.tabs[1]!.undo.length).toBeGreaterThan(0); expect(before.tabs[1]!.redo.length).toBeGreaterThan(0);
    await expect(commitSheets(f.editor, loaded.sheets, changes, 'Graph update', 'test', true)).rejects.toThrow(/XRECORD group 340 has a hard dependency/);
    expect(projectUi.confirmFiles).not.toHaveBeenCalled(); expect(projectUi.confirmLoss).not.toHaveBeenCalled(); expect(projectUi.confirmNoBackup).not.toHaveBeenCalled();
    expect(f.bridge.backupFile).not.toHaveBeenCalled(); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.bridge.sealProjectSaveBatch).not.toHaveBeenCalled(); expect(f.bridge.beginProjectSaveBatchCommit).not.toHaveBeenCalled();
    expect(f.snapshot()).toEqual(before); f.editor.sessions.all.forEach((session, at) => expect(session.state).toBe(before.tabs[at]!.state)); expect(f.editor.doc.snapshot).toBe(before.state);
    expect([...f.disk]).toEqual(beforeDisk); expect(f.backups.size).toBe(0); expect(await f.proofs()).toEqual(proofs); expect(f.bridge.releaseOpenedSourceProof).not.toHaveBeenCalled(); expect(f.saved).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });

  it('commits prepared active/parked graphs in one undo step each and restores exact graph snapshots with undo/redo', async () => {
    const f = setup(0), loaded = await loadProjectSheets(f.editor, { forSave: true }), before = f.snapshot(), proofs = await f.proofs();
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Graph update', 'test');
    expect(result).toEqual({ open: 2, written: 0, failed: [], conflicts: [], notSaved: [] });
    const active = f.editor.doc.snapshot, parked = f.editor.sessions.all[1]!.state;
    expect(active.entities.find(entity => entity.id === 'active-a')!.cadIdentity).toBe('active:a'); expect(parked.entities.find(entity => entity.id === 'parked-a')!.cadIdentity).toBe('parked:a');
    expect(retainedPayload(active)).toEqual(retainedPayload(before.state)); expect(retainedPayload(parked)).toEqual(retainedPayload(before.tabs[1]!.state));
    expect(f.editor.doc.history().undo).toHaveLength(before.history.undo.length + 1); expect(f.editor.sessions.all[1]!.undo).toHaveLength(before.tabs[1]!.undo.length + 1);
    expect(f.editor.doc.history().redo).toEqual([]); expect(f.editor.sessions.all[1]!.redo).toEqual([]);
    expect(f.editor.doc.dirty).toBe(true); expect(f.editor.sessions.all[1]!.dirty).toBe(true);
    expect(f.editor.doc.undo()).toBe(true); expect(f.editor.doc.snapshot).toBe(before.state); expect(f.editor.doc.redo()).toBe(true); expect(f.editor.doc.snapshot).toBe(active);
    expect(f.editor.sessions.switchTo(1)).toBe(true); expect(f.editor.doc.snapshot).toBe(parked); expect(f.editor.doc.undo()).toBe(true); expect(f.editor.doc.snapshot).toBe(before.tabs[1]!.state); expect(f.editor.doc.redo()).toBe(true); expect(f.editor.doc.snapshot).toBe(parked);
    expect(await f.proofs()).toEqual(proofs); expect(f.bridge.releaseOpenedSourceProof).not.toHaveBeenCalled(); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });

  it('accepts its own graph-prepared open transitions and then writes closed graph updates with exact backups', async () => {
    const f = setup(), loaded = await loadProjectSheets(f.editor, { forSave: true }), beforeDisk = new Map(f.disk), proofs = await f.proofs();
    expect(JSON.stringify(loaded.skipped)).toBe('[]'); expect(loaded.sheets).toHaveLength(4);
    const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Graph update', 'test');
    expect(result).toEqual({ open: 2, written: 2, failed: [], conflicts: [], notSaved: [] }); expect(f.bridge.saveDxf).toHaveBeenCalledTimes(2); expect(f.bridge.issueSaveAdmission).not.toHaveBeenCalled();
    for (const [path, original] of beforeDisk) { expect(f.backups.get(path)).toBe(original); const reopened = readDxf(f.disk.get(path)!); expect(reopened.entities.some(entity => entity.id.startsWith('added-') || entity.type === 'point' && entity.position.x >= 12)).toBe(true); expect(retainedPayload(reopened)).toEqual(retainedPayload(readDxf(original))); expect(reopened.cadGraph!.nodes.filter(node => node.type === 'XRECORD')).toHaveLength(1); }
    expect(f.events.indexOf('begin')).toBeLessThan(f.events.findIndex(event => event.startsWith('write:'))); expect(f.events.indexOf('cancel:parent')).toBeGreaterThan(f.events.findIndex(event => event.startsWith('write:')));
    expect(await f.proofs()).toEqual(proofs); expect(f.bridge.releaseOpenedSourceProof).not.toHaveBeenCalled(); expect(f.saved).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
  });

  it('preserves a reentrant unowned graph edit and stops every later parked/closed update', async () => {
    const f = setup(), loaded = await loadProjectSheets(f.editor, { forSave: true }), beforeDisk = [...f.disk], parked = f.editor.sessions.all[1]!.state, proofs = await f.proofs();
    expect(JSON.stringify(loaded.skipped)).toBe('[]'); expect(loaded.sheets).toHaveLength(4);
    let first = true; const stop = f.editor.doc.subscribe(doc => { if (first) { first = false; doc.transactDrawing(state => ({ ...state, entities: [...state.entities, point('newer-unowned-edit', 99)] })); } });
    try {
      const result = await commitSheets(f.editor, loaded.sheets, f.changes(loaded.sheets), 'Graph update', 'test');
      expect(result?.open).toBe(1); expect(result?.written).toBe(0); expect(result?.conflicts.join(' ')).toMatch(/source active.dxf.*edited/); expect(result?.failed).toEqual([]);
      expect(f.editor.doc.entities.some(entity => entity.id === 'added-0')).toBe(true); expect(f.editor.doc.entities.some(entity => entity.id === 'newer-unowned-edit')).toBe(true); expect(f.editor.doc.dirty).toBe(true);
      expect(retainedPayload(f.editor.doc.snapshot)).toEqual(retainedPayload(loaded.sheets[0]!.base!)); expect(f.editor.sessions.all[1]!.state).toBe(parked); expect([...f.disk]).toEqual(beforeDisk); expect(f.bridge.saveDxf).not.toHaveBeenCalled();
      const after = f.editor.doc.snapshot; expect(f.editor.doc.undo()).toBe(true); expect(f.editor.doc.entities.some(entity => entity.id === 'newer-unowned-edit')).toBe(false); expect(f.editor.doc.entities.some(entity => entity.id === 'added-0')).toBe(true); expect(f.editor.doc.redo()).toBe(true); expect(f.editor.doc.snapshot).toBe(after);
      expect(await f.proofs()).toEqual(proofs); expect(f.bridge.releaseOpenedSourceProof).not.toHaveBeenCalled(); expect(f.closed()).toBe(true);
    } finally { stop(); }
  });
});
