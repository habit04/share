/** Actual Editor/session/save code; native proof verification below is an explicit host transport double. */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType, FileBridge, OpenResult } from '../src/app/editor';
import { Drawing } from '../src/core/document';
import { readDxf, writeDxf } from '../src/io/dxf';
import { adoptOpenedSourceProof, captureOpenedSourceProof, forgetOpenedSourceProof } from '../src/app/opened-source-proof';
import { resetWindowsPathIdentitiesForTests, setPathPlatform } from '../src/app/paths';
import { SaveAdmission } from '../src/app/save-admission';

let Editor: typeof EditorType, sequence = 0;
beforeAll(async () => { globalThis.requestAnimationFrame = () => 1; globalThis.cancelAnimationFrame = () => {}; Editor = (await import('../src/app/editor')).Editor; });
afterEach(() => { vi.restoreAllMocks(); resetWindowsPathIdentitiesForTests(); setPathPlatform(null); });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function drawing(x: number) { const d = new Drawing(); d.addEntities([{ id: `point-${x}`, type: 'point', layer: '0', color: 'ByLayer', position: { x, y: 0 } }]); return d.snapshot; }
type Source = NonNullable<Parameters<NonNullable<FileBridge['bindSaveAdmission']>>[3]>;
function setup() {
  const root = `C:\\opened-source-renderer-${++sequence}`, original = `${root}\\original.dxf`, copy = `${root}\\copy.dxf`;
  setPathPlatform('win32');
  const editor = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
  const disk = new Map([[original, writeDxf(drawing(1))]]), aliases = new Map<string, string>(), evidence = new Map<string, { path: string; canonical: string; text: string }>();
  const receipts = new Map<string, { path: string; identityPath: string; openedSourceProof?: string }>(), bindings = new Map<string, { path: string; source?: Source }>();
  let order = 0, nextProof = 0;
  const events: string[] = [], released: string[] = [], saved = vi.fn(), canonical = (path: string) => aliases.get(path) ?? path;
  const mint = (path: string) => { const proof = `proof-${++nextProof}`; evidence.set(proof, { path, canonical: canonical(path), text: disk.get(canonical(path))! }); return proof; };
  const validate = (path: string, source?: Source) => {
    if (!source) throw new Error('ERR_OPENED_SOURCE_REQUIRED: Missing source context.');
    const proof = source.proof ? evidence.get(source.proof) : undefined;
    const sameOriginal = source.path && (path === source.path || canonical(path) === (proof?.canonical ?? canonical(source.path)));
    if (source.mode === 'in-place' || sameOriginal) {
      if (!proof || canonical(source.path!) !== proof.canonical || canonical(path) !== proof.canonical || disk.get(proof.canonical) !== proof.text) throw new Error('ERR_OPENED_SOURCE_CHANGED: The original drawing changed outside JCad. Reload it or use Save As for a separate copy.');
    }
  };
  const bridge: FileBridge = {
    platform: 'win32', openDxf: async () => null,
    openDrawing: vi.fn(async path => { if (!path || !disk.has(canonical(path))) return null; return { kind: 'dxf' as const, path, identityPath: canonical(path), text: disk.get(canonical(path))!, openedSourceProof: mint(path) }; }),
    releaseOpenedSourceProof: vi.fn(async proof => { released.push(proof); events.push(`release:${proof}`); evidence.delete(proof); }),
    issueSaveAdmission: vi.fn(async () => { const ticket = `save-${++order}`; events.push(`issue:${ticket}`); return ticket; }),
    bindSaveAdmission: vi.fn(async (ticket, _kind, path, source) => { events.push(`bind:${ticket}`); validate(path, source); bindings.set(ticket, { path, source }); return { identityPath: canonical(path), exists: disk.has(canonical(path)) }; }),
    cancelSaveAdmission: vi.fn(async ticket => { events.push(`cancel:${ticket}`); bindings.delete(ticket); }),
    chooseDrawingPath: vi.fn(async () => copy),
    saveDxf: vi.fn(async (path, text, _suggest, opts) => {
      const ticket = opts!.admission!, binding = bindings.get(ticket)!; validate(binding.path, binding.source);
      disk.set(canonical(path!), text); const openedSourceProof = mint(path!);
      receipts.set(ticket, { path: path!, identityPath: canonical(path!), openedSourceProof }); events.push(`write:${ticket}`); return path;
    }),
    saveAdmissionResult: vi.fn(async ticket => { const receipt = receipts.get(ticket) ?? null; receipts.delete(ticket); return receipt; }),
  };
  editor.fileBridge = bridge;
  editor.ui = { pickSymbol: async () => null, editComponent: async () => null, ladderSettings: async value => value, textInput: async (_t, _l, value) => value, confirm: async () => true, saveChanges: async () => 'discard' };
  editor.hooks.drawingSaved = saved;
  const edit = (x = 111) => editor.doc.addEntities([{ id: `local-${x}`, type: 'point', layer: '0', color: 'ByLayer', position: { x, y: 0 } }]);
  const source = () => { const captured = captureOpenedSourceProof(editor.sessions.current, bridge, editor.doc.filePath, 'in-place')!; const hint = captured.hint; void captured.release(); return hint; };
  const open = () => editor.openFile(original);
  return { editor, bridge, root, original, copy, disk, aliases, evidence, receipts, bindings, events, released, mint, saved, edit, source, open };
}

describe('opened proof runtime ownership', () => {
  it('keeps evidence out of drawing/session/history and preserves it through edits, undo and tab switches', async () => {
    const f = setup(); expect(await f.open()).toBe(true); const session = f.editor.sessions.current, hint = f.source();
    f.edit(); f.editor.doc.undo(); f.editor.doc.redo(); f.editor.sessions.add(); f.editor.sessions.switchTo(0);
    expect(f.source()).toEqual(hint); expect(f.released).toEqual([]);
    expect(JSON.stringify(session)).not.toContain(hint.proof); expect(JSON.stringify(f.editor.doc.snapshot)).not.toContain(hint.proof); expect(JSON.stringify(f.editor.doc.history())).not.toContain(hint.proof);
  });
  it('releases closed and replaced owners, while parked tab restoration retains them', async () => {
    const f = setup(); await f.open(); const proof = f.source().proof!;
    f.editor.sessions.add(); f.editor.sessions.switchTo(0); expect(f.released).toEqual([]);
    f.editor.newDrawingNow(); f.editor.sessions.sync(); expect(f.released).toEqual([proof]); expect(f.source().proof).toBeNull();
    await f.open(); const next = f.source().proof!; f.editor.sessions.close(0); expect(f.released).toEqual([proof, next]);
  });
  it('releases a background load replacement but does not release its pending borrow before cleanup', async () => {
    const f = setup(); await f.open(); const session = f.editor.sessions.current, borrow = captureOpenedSourceProof(session, f.bridge, f.original, 'in-place')!;
    f.editor.sessions.add(); f.editor.sessions.loadInto(session.id, drawing(2), f.original);
    expect(f.released).toEqual([]); expect(borrow.hint.proof).toBe('proof-1');
    await borrow.release(); await borrow.release(); expect(f.released).toEqual(['proof-1']);
  });
  it('refuses adoption into another content generation and releases the unused token', async () => {
    const f = setup(); await f.open(); const session = f.editor.sessions.current, generation = session.contentGeneration, unused = f.mint(f.original);
    f.editor.newDrawingNow(); f.editor.sessions.sync();
    expect(adoptOpenedSourceProof(session, generation, f.bridge, unused, f.original)).toBe(false); await Promise.resolve();
    expect(f.released).toContain(unused); expect(f.source().proof).toBeNull();
  });
});

describe('accepted Open evidence', () => {
  it('releases a duplicate Open result without refreshing the existing dirty tab baseline', async () => {
    const f = setup(); await f.open(); f.edit(); const old = f.source().proof!; f.editor.sessions.add();
    f.disk.set(f.original, writeDxf(drawing(999))); expect(await f.open()).toBe(true);
    expect(f.editor.sessions.active).toBe(0); expect(f.source().proof).toBe(old); expect(f.released).toEqual(['proof-2']);
    expect(await f.editor.saveFile(false)).toBe(false); expect(f.editor.doc.dirty).toBe(true); expect(f.disk.get(f.original)).toBe(writeDxf(drawing(999))); expect(f.saved).not.toHaveBeenCalled();
  });
  it('reloads only the accepted generation and releases its preceding proof', async () => {
    const f = setup(); await f.open(); f.disk.set(f.original, writeDxf(drawing(999))); expect(await f.open()).toBe(true);
    expect(f.source().proof).toBe('proof-2'); expect(f.released).toEqual(['proof-1']);
    f.edit(); expect(await f.editor.saveFile(false)).toBe(true); expect(f.source().proof).toBe('proof-3');
  });
  it('attaches a switched Open to its original background tab, not the active tab', async () => {
    const f = setup(), read = deferred<OpenResult | null>(); f.bridge.openDrawing = vi.fn(() => read.promise);
    const originalSession = f.editor.sessions.current, opening = f.open(); await vi.waitFor(() => expect(f.bridge.openDrawing).toHaveBeenCalled()); f.editor.sessions.add();
    read.resolve({ kind: 'dxf', path: f.original, text: f.disk.get(f.original)!, openedSourceProof: f.mint(f.original) }); expect(await opening).toBe(true);
    const captured = captureOpenedSourceProof(originalSession, f.bridge, f.original, 'in-place')!;
    expect(f.source().proof).toBeNull(); expect(captured.hint.proof).toBe('proof-1'); await captured.release();
    f.editor.sessions.switchTo(0); expect(f.source().proof).toBe('proof-1');
  });
  it('attaches a late Open after edits to its new tab and leaves the edited original untouched', async () => {
    const f = setup(), read = deferred<OpenResult | null>(); f.bridge.openDrawing = vi.fn(() => read.promise);
    const original = f.editor.sessions.current, opening = f.open(); await vi.waitFor(() => expect(f.bridge.openDrawing).toHaveBeenCalled()); f.edit();
    read.resolve({ kind: 'dxf', path: f.original, text: f.disk.get(f.original)!, openedSourceProof: f.mint(f.original) }); expect(await opening).toBe(true);
    expect(f.editor.sessions.current).not.toBe(original); expect(f.source().proof).toBe('proof-1'); expect(original.dirty).toBe(true);
    const captured = captureOpenedSourceProof(original, f.bridge, null, 'save-as')!; expect(captured.hint.proof).toBeNull(); await captured.release();
  });
  it('releases unused proof on decode failure or rejected geometry', async () => {
    const f = setup(); f.editor.readDxfText = vi.fn(async () => null); expect(await f.open()).toBe(false); expect(f.released).toEqual(['proof-1']);
    f.editor.readDxfText = vi.fn(async () => { throw new Error('Malformed drawing'); }); expect(await f.open()).toBe(false); expect(f.released).toEqual(['proof-1', 'proof-2']);
  });
  it('does not attach an Open proof after a reentrant replacement during load', async () => {
    const f = setup(); let replaced = false; f.editor.on('change', () => { if (!replaced) { replaced = true; f.editor.newDrawingNow(); } });
    expect(await f.open()).toBe(true); expect(f.source().proof).toBeNull(); expect(f.released).toEqual(['proof-1']); expect(f.editor.doc.filePath).toBeNull();
  });
  it('accepts the fallback DXF opener proof and gives a closed-target Open its separate new tab', async () => {
    const f = setup(); delete f.bridge.openDrawing;
    f.bridge.openDxf = vi.fn(async () => ({ path: f.original, text: f.disk.get(f.original)!, openedSourceProof: f.mint(f.original) }));
    expect(await f.open()).toBe(true); expect(f.source().proof).toBe('proof-1');
    const read = deferred<OpenResult | null>(); f.bridge.openDrawing = vi.fn(() => read.promise); f.editor.sessions.add();
    const target = f.editor.sessions.current, opening = f.editor.openFile(f.copy); await vi.waitFor(() => expect(f.bridge.openDrawing).toHaveBeenCalled()); f.editor.sessions.close(f.editor.sessions.active);
    f.disk.set(f.copy, writeDxf(drawing(4))); read.resolve({ kind: 'dxf', path: f.copy, text: f.disk.get(f.copy)!, openedSourceProof: f.mint(f.copy) }); expect(await opening).toBe(true);
    expect(f.editor.sessions.all).not.toContain(target); expect(f.source().proof).toBe('proof-1'); f.editor.sessions.switchTo(1); expect(f.source().proof).toBe('proof-2');
  });
});

describe('ordinary Save source propagation and adoption', () => {
  it('refuses an external pre-request change twice without writing, cleaning or notifying recovery', async () => {
    const f = setup(); await f.open(); f.edit(); const before = f.editor.doc.snapshot, history = f.editor.doc.history(), outside = writeDxf(drawing(999)); f.disk.set(f.original, outside);
    expect(await f.editor.saveFile(false)).toBe(false); f.edit(222); expect(await f.editor.saveFile(false)).toBe(false);
    expect(f.disk.get(f.original)).toBe(outside); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(f.saved).not.toHaveBeenCalled(); expect(f.editor.doc.dirty).toBe(true); expect(f.source().proof).toBe('proof-1');
    expect(f.editor.doc.history().undo).toContain(before); expect(f.editor.doc.history().undo).toContain(history.undo[0]); expect(f.editor.lastFileError).toMatch(/original drawing changed/);
    expect(f.bridge.bindSaveAdmission).toHaveBeenCalledWith('save-1', 'drawing', f.original, { proof: 'proof-1', path: f.original, mode: 'in-place' });
  });
  it('advances only verified own saves and passes the new baseline to a second save', async () => {
    const f = setup(); await f.open(); f.edit(); expect(await f.editor.saveFile(false)).toBe(true); expect(f.source().proof).toBe('proof-2'); expect(f.editor.doc.dirty).toBe(false);
    f.edit(222); expect(await f.editor.saveFile(false)).toBe(true); expect(f.source().proof).toBe('proof-3'); expect(f.released).toEqual(['proof-1', 'proof-2']);
    expect(f.bridge.bindSaveAdmission).toHaveBeenLastCalledWith('save-2', 'drawing', f.original, { proof: 'proof-2', path: f.original, mode: 'in-place' });
  });
  it('captures the original proof before an awaited picker, and allows a separate copy without adopting external bytes', async () => {
    const f = setup(); await f.open(); f.edit(); const picker = deferred<string | null>(); f.bridge.chooseDrawingPath = vi.fn(() => picker.promise);
    const saving = f.editor.saveFile(true); await vi.waitFor(() => expect(f.bridge.chooseDrawingPath).toHaveBeenCalled()); f.disk.set(f.original, writeDxf(drawing(999))); picker.resolve(f.copy);
    expect(await saving).toBe(true); expect(f.disk.get(f.original)).toBe(writeDxf(drawing(999))); expect(f.editor.doc.filePath).toBe(f.copy); expect(f.source()).toEqual({ proof: 'proof-2', path: f.copy, mode: 'in-place' });
    expect(f.bridge.bindSaveAdmission).toHaveBeenCalledWith('save-1', 'drawing', f.copy, { proof: 'proof-1', path: f.original, mode: 'save-as' });
  });
  it('guards Save As onto a native source alias and normal Save after logical retarget', async () => {
    const f = setup(); await f.open(); f.edit(); const alias = `${f.root}\\alias.dxf`; f.aliases.set(alias, f.original); f.bridge.chooseDrawingPath = vi.fn(async () => alias); f.disk.set(f.original, writeDxf(drawing(999)));
    expect(await f.editor.saveFile(true)).toBe(false); expect(f.bridge.saveDxf).not.toHaveBeenCalled();
    const other = `${f.root}\\other.dxf`; f.disk.set(other, writeDxf(drawing(5))); f.aliases.set(f.original, other);
    expect(await f.editor.saveFile(false)).toBe(false); expect(f.disk.get(other)).toBe(writeDxf(drawing(5))); expect(f.source().proof).toBe('proof-1');
  });
  it('refuses a manual/recovered known path without evidence but permits a separate copy', async () => {
    const f = setup(); f.editor.loadState(drawing(1), f.original); f.edit(); expect(f.source().proof).toBeNull();
    expect(await f.editor.saveFile(false)).toBe(false); expect(f.bridge.saveDxf).not.toHaveBeenCalled(); expect(await f.editor.saveFile(true)).toBe(true); expect(f.source().proof).toBe('proof-1');
  });
  it('adopts a successful save despite newer unsaved edits and keeps them dirty', async () => {
    const f = setup(); await f.open(); f.edit(); const gate = deferred<void>(), write = f.bridge.saveDxf!;
    f.bridge.saveDxf = vi.fn(async (...args: Parameters<FileBridge['saveDxf']>) => { await gate.promise; return write(...args); }); const saving = f.editor.saveFile(false);
    await vi.waitFor(() => expect(f.bridge.saveDxf).toHaveBeenCalled()); f.edit(222); gate.resolve(); expect(await saving).toBe(true);
    expect(f.editor.doc.dirty).toBe(true); expect(f.source().proof).toBe('proof-2'); expect(readDxf(f.disk.get(f.original)!).entities).toHaveLength(2); expect(f.editor.doc.entities).toHaveLength(3);
  });
  it('keeps a pending source borrowed through close/joined admission cleanup, then releases the unused receipt', async () => {
    const f = setup(); await f.open(); f.edit(); const gate = deferred<void>(), cleanup = deferred<void>(), write = f.bridge.saveDxf!;
    f.bridge.saveDxf = vi.fn(async (...args: Parameters<FileBridge['saveDxf']>) => { await gate.promise; return write(...args); }); f.bridge.cancelSaveAdmission = vi.fn(async ticket => { f.events.push(`cancel:${ticket}`); await cleanup.promise; });
    const saving = f.editor.saveFile(false); await vi.waitFor(() => expect(f.bridge.saveDxf).toHaveBeenCalled()); f.editor.sessions.close(0); expect(f.released).toEqual([]);
    gate.resolve(); await vi.waitFor(() => expect(f.bridge.cancelSaveAdmission).toHaveBeenCalled()); expect(f.released).toEqual([]); cleanup.resolve(); expect(await saving).toBe(true);
    expect(f.released).toEqual(['proof-1', 'proof-2']); expect(f.source().proof).toBeNull();
  });
  it('does not adopt a completed save after the same tab content was replaced', async () => {
    const f = setup(); await f.open(); f.edit(); const gate = deferred<void>(), write = f.bridge.saveDxf!;
    f.bridge.saveDxf = vi.fn(async (...args: Parameters<FileBridge['saveDxf']>) => { await gate.promise; return write(...args); }); const saving = f.editor.saveFile(false);
    await vi.waitFor(() => expect(f.bridge.saveDxf).toHaveBeenCalled()); f.editor.loadState(drawing(77), null); const replacement = f.editor.doc.snapshot; gate.resolve(); expect(await saving).toBe(true);
    expect(f.editor.doc.snapshot).toBe(replacement); expect(f.editor.doc.filePath).toBeNull(); expect(f.source().proof).toBeNull(); expect(f.released).toEqual(['proof-1', 'proof-2']);
  });
  it('releases a late older Save As receipt and retains the newer destination proof', async () => {
    const f = setup(); await f.open(); f.edit(); const first = `${f.root}\\slow.dxf`, second = `${f.root}\\newer.dxf`, gate = deferred<void>(), write = f.bridge.saveDxf!;
    let destination = first; f.bridge.chooseDrawingPath = vi.fn(async () => destination); f.bridge.saveDxf = vi.fn(async (...args: Parameters<FileBridge['saveDxf']>) => { if (args[0] === first) await gate.promise; return write(...args); });
    const older = f.editor.saveFile(true); await vi.waitFor(() => expect(f.bridge.saveDxf).toHaveBeenCalled()); destination = second; f.edit(222); expect(await f.editor.saveFile(true)).toBe(true); const newest = f.source();
    gate.resolve(); expect(await older).toBe(true); expect(f.source()).toEqual(newest); expect(f.editor.doc.filePath).toBe(second); expect(f.released).toContain('proof-3'); expect(f.evidence.has(newest.proof!)).toBe(true);
  });
  it('keeps baseline and recovery dirty after failed or unverified saves, releasing unused minted proof', async () => {
    const f = setup(); await f.open(); f.edit(); const before = f.source(), write = f.bridge.saveDxf!;
    f.bridge.saveDxf = vi.fn(async () => { throw new Error('ENOSPC'); }); expect(await f.editor.saveFile(false)).toBe(false); expect(f.source()).toEqual(before);
    f.bridge.saveDxf = write; f.bridge.saveAdmissionResult = vi.fn(async ticket => { const receipt = f.receipts.get(ticket)!; return { ...receipt, path: 'wrong path' }; });
    expect(await f.editor.saveFile(false)).toBe(false); expect(f.source()).toEqual(before); expect(f.released).toContain('proof-2'); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled();
  });
  it('rejects a missing verified proof on a new host rather than clearing dirty state', async () => {
    const f = setup(); await f.open(); f.edit(); f.bridge.saveAdmissionResult = vi.fn(async ticket => { const receipt = f.receipts.get(ticket)!; return { path: receipt.path, identityPath: receipt.identityPath }; });
    expect(await f.editor.saveFile(false)).toBe(false); expect(f.editor.doc.dirty).toBe(true); expect(f.source().proof).toBe('proof-1'); expect(f.saved).not.toHaveBeenCalled();
  });
  it('refuses malformed commit proofs and unavailable guarded host support before treating a save as verified', async () => {
    const f = setup(); await f.open(); f.edit(); f.bridge.saveAdmissionResult = vi.fn(async ticket => ({ ...f.receipts.get(ticket)!, openedSourceProof: 'invalid\nproof' }));
    expect(await f.editor.saveFile(false)).toBe(false); expect(f.source().proof).toBe('proof-1'); expect(f.editor.doc.dirty).toBe(true); expect(f.saved).not.toHaveBeenCalled();
    const another = setup(); await another.open(); another.edit(); delete another.bridge.issueSaveAdmission; delete another.bridge.bindSaveAdmission; delete another.bridge.cancelSaveAdmission;
    expect(await another.editor.saveFile(false)).toBe(false); expect(another.bridge.saveDxf).not.toHaveBeenCalled(); expect(another.source().proof).toBe('proof-1');
  });
  it('releases a cancelled picker borrow without releasing the live tab source', async () => {
    const f = setup(); await f.open(); f.edit(); f.bridge.chooseDrawingPath = vi.fn(async () => null);
    expect(await f.editor.saveFile(true)).toBe(false); expect(f.released).toEqual([]); expect(f.bridge.bindSaveAdmission).not.toHaveBeenCalled();
    f.editor.newDrawingNow(); f.editor.sessions.sync(); expect(f.released).toEqual(['proof-1']);
  });
  it('leaves old/browser bridge argument contracts unchanged', async () => {
    const f = setup(); delete f.bridge.releaseOpenedSourceProof; delete f.bridge.saveAdmissionResult;
    f.bridge.bindSaveAdmission = vi.fn(async (_t, _k, path) => path); f.bridge.saveDxf = vi.fn(async path => path); f.editor.loadState(drawing(1), f.original); f.edit();
    expect(await f.editor.saveFile(false)).toBe(true); expect(f.bridge.bindSaveAdmission).toHaveBeenCalledWith('save-1', 'drawing', f.original);
    forgetOpenedSourceProof(f.editor.sessions.current);
  });
  it('releases unexpected non-drawing receipt tokens instead of retaining source ownership', async () => {
    const f = setup(); const admission = new SaveAdmission(f.bridge, 'project'); await admission.ready; const proof = f.mint(f.original);
    f.receipts.set(admission.ticket!, { path: f.original, identityPath: f.original, openedSourceProof: proof }); await admission.confirmSaved(f.original); await admission.close(); expect(f.released).toEqual([proof]);
  });
  it('keeps generic closed-file drawing admissions compatible with modern identity-only receipts', async () => {
    const f = setup(), admission = new SaveAdmission(f.bridge, 'drawing');
    f.bridge.bindSaveAdmission = vi.fn(async (_ticket, _kind, path) => ({ identityPath: path, exists: false }));
    await admission.bind(f.copy); f.receipts.set(admission.ticket!, { path: f.copy, identityPath: f.copy });
    await expect(admission.confirmSaved(f.copy)).resolves.toBeUndefined(); await admission.close();
    expect(f.bridge.bindSaveAdmission).toHaveBeenCalledWith('save-1', 'drawing', f.copy); expect(f.released).toEqual([]);
  });
  it('releases a generic closed-file receipt token and leaves the opened tab baseline intact', async () => {
    const f = setup(); await f.open(); const baseline = f.source(), admission = new SaveAdmission(f.bridge, 'drawing');
    f.bridge.bindSaveAdmission = vi.fn(async (_ticket, _kind, path) => ({ identityPath: path, exists: false }));
    await admission.bind(f.copy); f.disk.set(f.copy, writeDxf(drawing(55))); const unexpected = f.mint(f.copy);
    f.receipts.set(admission.ticket!, { path: f.copy, identityPath: f.copy, openedSourceProof: unexpected });
    await expect(admission.confirmSaved(f.copy)).resolves.toBeUndefined(); await admission.close();
    expect(f.released).toEqual([unexpected]); expect(f.source()).toEqual(baseline);
  });
});
