import { describe, it, expect, beforeAll } from 'vitest';
import { RecoveryActions, type RecoveryHost } from '../src/app/recovery-actions';
import type { AutosaveEntry } from '../src/app/autosave';
import type { Editor as EditorType } from '../src/app/editor';
import type { FileErrorInfo } from '../src/app/file-errors';
import { Drawing, type DrawingState } from '../src/core/document';
import { SessionManager, type SessionHost } from '../src/app/sessions';

const entry = (name: string, title = `${name}.dxf`): AutosaveEntry => ({ name, title, originalPath: null, savedAt: 1 });

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** Fake host: files in a Map; read can be held open to simulate a slow disk. */
function fakeHost(names: string[]) {
  const files = new Map(names.map((n) => [n, `DXF ${n}`]));
  const opened: string[] = [];
  const removed: string[] = [];
  let gate: ReturnType<typeof deferred<void>> | null = null;
  const failRemove = new Set<string>();
  const host: RecoveryHost = {
    async read(name) {
      if (gate) await gate.promise;
      return files.get(name) ?? null;
    },
    async remove(name) {
      if (gate) await gate.promise;
      if (failRemove.has(name)) throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '/data/autosave/${name}'`), { code: 'EBUSY' });
      removed.push(name);
      files.delete(name);
    },
    openRecovered(e, text) {
      if (text.includes('BROKEN')) throw new Error('Not a DXF file');
      opened.push(e.name);
    },
  };
  return {
    host,
    files,
    opened,
    removed,
    failRemove,
    hold() {
      gate = deferred<void>();
    },
    release() {
      const g = gate;
      gate = null;
      g?.resolve();
    },
  };
}

describe('Drawing Recovery Manager actions', () => {
  it('a double click (two clicks before the first finishes) opens the backup once', async () => {
    const h = fakeHost(['a', 'b']);
    const r = new RecoveryActions([entry('a'), entry('b')], h.host);
    h.hold();
    const first = r.open('a');
    const second = r.open('a'); // the second click of a double click
    expect(r.busy).toBe(true);
    expect(await second).toEqual({ status: 'ignored' });
    h.release();
    expect(await first).toEqual({ status: 'done' });
    expect(await r.open('a')).toEqual({ status: 'ignored' }); // already open: not listed any more
    expect(h.opened).toEqual(['a']);
    expect(r.listed.map((e) => e.name)).toEqual(['b']);
    expect(r.wasOpened('a')).toBe(true);
  });

  it('while one action runs, every other action is ignored (buttons disabled)', async () => {
    const h = fakeHost(['a', 'b', 'c']);
    const r = new RecoveryActions([entry('a'), entry('b'), entry('c')], h.host);
    const states: boolean[] = [];
    r.onChange = () => states.push(r.busy);
    h.hold();
    const opening = r.open('a');
    expect(await r.discard('b')).toEqual({ status: 'ignored' });
    expect(await r.open('c')).toEqual({ status: 'ignored' });
    expect(await r.discardAll()).toEqual({ status: 'ignored' });
    h.release();
    await opening;
    expect(states).toEqual([true, false]);
    expect(h.removed).toEqual([]);
    expect(h.opened).toEqual(['a']);
  });

  it('Discard All deletes only the backups still listed, never one opened in this session', async () => {
    const h = fakeHost(['a', 'b', 'c']);
    const r = new RecoveryActions([entry('a'), entry('b'), entry('c')], h.host);
    await r.open('b'); // b now belongs to an open drawing and is kept until it is saved
    await r.discard('c');
    const res = await r.discardAll();
    expect(res).toEqual({ status: 'done', removed: ['a'], failed: [] });
    expect(h.removed).toEqual(['c', 'a']);
    expect(h.files.has('b')).toBe(true);
    expect(r.listed).toEqual([]);
  });

  it('Discard All keeps entries it could not delete listed, with the reason', async () => {
    const h = fakeHost(['a', 'b']);
    h.failRemove.add('a');
    const r = new RecoveryActions([entry('a'), entry('b')], h.host);
    const res = await r.discardAll();
    expect(res).toEqual({ status: 'done', removed: ['b'], failed: ['a'] });
    expect(r.listed.map((e) => e.name)).toEqual(['a']);
    expect(r.errors.get('a')).toMatch(/^Could not delete the backup: EBUSY/);
    expect(r.busy).toBe(false);
  });

  it('a backup that cannot be read or parsed stays listed with its error; the next try can succeed', async () => {
    const h = fakeHost(['a', 'b']);
    h.files.set('b', 'BROKEN');
    const r = new RecoveryActions([entry('a'), entry('b'), entry('gone')], h.host);
    expect(await r.open('b')).toEqual({ status: 'failed', error: 'Recovery failed: Not a DXF file' });
    expect(r.isListed('b')).toBe(true);
    const gone = await r.open('gone');
    expect(gone.status).toBe('failed');
    expect(r.errors.get('gone')).toMatch(/no longer exists/);
    h.files.set('b', 'DXF b');
    expect(await r.open('b')).toEqual({ status: 'done' });
    expect(r.errors.has('b')).toBe(false);
  });

  it('a read failure with an OS error code gets a plain-language message', async () => {
    const r = new RecoveryActions([entry('a')], {
      read: async () => {
        throw new Error("Error invoking remote method 'autosave-read': Error: EACCES: permission denied, open '/data/autosave/a.sv.dxf'");
      },
      remove: async () => {},
      openRecovered: () => {},
    });
    const res = await r.open('a');
    expect(res).toEqual({ status: 'failed', error: expect.stringMatching(/^"a\.sv\.dxf" could not be read: you do not have permission to read/) });
  });
});

describe('opening a backup as a modified drawing', () => {
  it('stays modified even when a listener reads the session list while the tab is being loaded', () => {
    const doc = new Drawing();
    let sm: SessionManager;
    const seen: boolean[] = [];
    const host: SessionHost = {
      doc,
      viewport: { center: { x: 0, y: 0 }, scale: 1 },
      selection: new Set(),
      loadState(state: DrawingState, p: string | null) {
        doc.load(state, p);
        // Editor.loadState emits 'file'; main.ts listeners used to call sessions.current here,
        // which captured the just-loaded (clean) document over the recovered session.
        seen.push(sm.current.dirty);
      },
    };
    sm = new SessionManager(host);
    const recovered = new Drawing();
    recovered.addEntities([{ id: 'x', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }]);
    const idx = sm.add(recovered.snapshot, '/jobs/panel.dxf', true);
    expect(seen).toEqual([true]);
    expect(sm.isDirty(idx)).toBe(true);
    expect(sm.current.dirty).toBe(true);
    expect(sm.activeId).toBe(sm.current.id);
    sm.switchTo(0);
    sm.switchTo(idx);
    expect(sm.isDirty(idx)).toBe(true);
    expect(doc.entities.map((e) => e.id)).toEqual(['x']);
  });
});

// ------------------------------------------------------------------ save failures (Editor.saveFile)
let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

function editorWithBridge(saveDxf: (path: string | null, text: string, name: string) => Promise<string | null>) {
  const ed = new Editor(canvas());
  const calls: Array<string | null> = [];
  ed.fileBridge = {
    openDxf: async () => null,
    saveDxf: (p, t, n) => {
      calls.push(p);
      return saveDxf(p, t, n);
    },
  };
  ed.doc.load(ed.doc.snapshot, '/jobs/panel.dxf');
  ed.doc.addEntities([{ id: 'l1', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }]);
  return { ed, calls };
}

describe('save failures', () => {
  it('a failed save keeps the drawing modified, keeps its autosave entry and explains why', async () => {
    const { ed, calls } = editorWithBridge(async () => {
      throw new Error("Error invoking remote method 'save-dxf': Error: ENOSPC: no space left on device, write '/jobs/panel.dxf'");
    });
    const saved: number[] = [];
    const dialogs: FileErrorInfo[] = [];
    ed.hooks.drawingSaved = (id) => saved.push(id);
    ed.hooks.saveError = async (info) => {
      dialogs.push(info);
      return 'cancel';
    };
    let fileEvents = 0;
    ed.on('file', () => (fileEvents += 1));
    expect(ed.doc.dirty).toBe(true);
    expect(await ed.saveFile(false)).toBe(false);
    expect(ed.doc.dirty).toBe(true);
    expect(ed.sessions.isDirty(ed.sessions.active)).toBe(true);
    expect(saved).toEqual([]); // the autosave / recovery entry is not marked clean
    expect(fileEvents).toBe(0);
    expect(calls).toEqual(['/jobs/panel.dxf']);
    expect(dialogs).toHaveLength(1);
    expect(dialogs[0]).toMatchObject({ code: 'ENOSPC', kind: 'disk-full', path: '/jobs/panel.dxf' });
    expect(ed.history.some((l) => l.startsWith('Save failed: "panel.dxf" could not be saved: there is not enough free space on the disk.'))).toBe(true);
  });

  it('Retry saves to the same file; Save As... asks for another destination', async () => {
    let fail = 2;
    const { ed, calls } = editorWithBridge(async (p) => {
      if (fail > 0) {
        fail -= 1;
        throw Object.assign(new Error(`EACCES: permission denied, write '${p}'`), { code: 'EACCES' });
      }
      return p ?? '/elsewhere/panel.dxf';
    });
    const choices: Array<'retry' | 'saveas'> = ['retry', 'saveas'];
    const saved: string[] = [];
    ed.hooks.saveError = async (info) => {
      expect(info.kind).toBe('permission');
      return choices.shift()!;
    };
    ed.hooks.drawingSaved = (_id, state, path) => {
      expect(state).toBe(ed.doc.snapshot);
      saved.push(path);
    };
    expect(await ed.saveFile(false)).toBe(true);
    expect(calls).toEqual(['/jobs/panel.dxf', '/jobs/panel.dxf', null]);
    expect(saved).toEqual(['/elsewhere/panel.dxf']);
    expect(ed.doc.dirty).toBe(false);
    expect(ed.doc.filePath).toBe('/elsewhere/panel.dxf');
  });

  it('without an error dialog (headless) the failure is logged and nothing is lost', async () => {
    const { ed } = editorWithBridge(async () => {
      throw new Error('EBUSY: resource busy or locked, open');
    });
    expect(await ed.saveFile(false)).toBe(false);
    expect(ed.doc.dirty).toBe(true);
    expect(ed.history.at(-1)).toMatch(/locked by another program/);
  });
});
