import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { SessionManager, sessionTitle, type SessionHost } from '../src/app/sessions';

const line = (id: string): Entity => ({ id, layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });

function makeHost(): SessionHost & { loads: number } {
  const doc = new Drawing();
  const host = {
    doc,
    viewport: { center: { x: 5, y: 4 }, scale: 80 },
    selection: new Set<string>(),
    loads: 0,
    loadState(state: DrawingState, path: string | null) {
      doc.load(state, path);
      this.loads += 1;
      // Editor.loadState zooms to extents and clears the selection.
      this.viewport = { center: { x: 0, y: 0 }, scale: 1 };
      this.selection.clear();
    },
  };
  return host;
}

describe('document sessions', () => {
  it('seals borrowed background snapshots when accepting and replacing a parked tab', () => {
    const host = makeHost();
    const sessions = new SessionManager(host);
    const entities = [line('borrowed')];
    const state = { ...host.doc.snapshot, entities };
    const index = sessions.addInBackground(state, '/background.dxf');
    const session = sessions.all[index]!;
    expect(session.state).toBe(state);
    expect(() => entities.push(line('mutation'))).toThrow(TypeError);
    const replacement = { ...host.doc.snapshot, entities: [line('replacement')] };
    sessions.loadInto(session.id, replacement, '/replacement.dxf');
    expect(session.state).toBe(replacement);
    expect(() => replacement.entities.pop()).toThrow(TypeError);
    expect(sessions.switchTo(index)).toBe(true);
    expect(host.doc.entities.map((entity) => entity.id)).toEqual(['replacement']);
  });

  it('detects edit and undo back to the same snapshot while tab restoration keeps its revision', () => {
    const host = makeHost(), sessions = new SessionManager(host);
    const original = sessions.current.state, before = sessions.current.revision;
    host.doc.addEntities([line('temporary')]); host.doc.undo();
    expect(sessions.current.state).toBe(original);
    expect(sessions.current.revision).toBeGreaterThan(before);
    const revision = sessions.current.revision;
    sessions.add(); sessions.switchTo(0);
    expect(sessions.current.revision).toBe(revision);
    host.doc.patchQuiet((state) => ({ ...state, meta: { quiet: true } }));
    expect(sessions.current.revision).toBeGreaterThan(revision);
  });
  it('tracks content replacements separately from edits, switching and recovered tabs', () => {
    const host = makeHost(), sessions = new SessionManager(host);
    const session = sessions.current, original = session.contentGeneration;
    host.doc.addEntities([line('edit')]);
    expect(sessions.current.contentGeneration).toBe(original);
    sessions.add(new Drawing().snapshot, '/recovered.dxf', true);
    const recovered = sessions.current, recoveredGeneration = recovered.contentGeneration;
    sessions.switchTo(0); sessions.switchTo(1);
    expect(sessions.current.contentGeneration).toBe(recoveredGeneration);
    expect(sessions.current.dirty).toBe(true);
    sessions.loadInto(recovered.id, new Drawing().snapshot, '/replacement.dxf');
    expect(sessions.current.contentGeneration).toBeGreaterThan(recoveredGeneration);
    const loadedGeneration = sessions.current.contentGeneration;
    sessions.switchTo(0);
    sessions.loadInto(recovered.id, new Drawing().snapshot, '/background.dxf');
    expect(sessions.all[1]!.contentGeneration).toBeGreaterThan(loadedGeneration);
    const backgroundGeneration = sessions.all[1]!.contentGeneration;
    sessions.switchTo(1);
    expect(sessions.current.contentGeneration).toBe(backgroundGeneration);
  });
  it('starts with one untitled session and names new ones sequentially', () => {
    const host = makeHost();
    const sm = new SessionManager(host);
    expect(sm.count).toBe(1);
    expect(sm.titleOf(0)).toBe('Drawing1.dxf');
    sm.add();
    expect(sm.count).toBe(2);
    expect(sm.active).toBe(1);
    expect(sm.titleOf(1)).toBe('Drawing2.dxf');
    expect(sessionTitle({ filePath: 'C:\\work\\panel.dxf', untitledName: 'x' })).toBe('panel.dxf');
  });

  it('switching preserves entities, undo history, dirty flag, view and selection', () => {
    const host = makeHost();
    const sm = new SessionManager(host);
    host.doc.addEntities([line('a')]);
    host.doc.addEntities([line('b')]);
    host.selection = new Set(['a']);
    host.viewport.center = { x: 9, y: 9 };
    host.viewport.scale = 33;
    expect(host.doc.dirty).toBe(true);

    sm.add();
    expect(host.doc.entities).toHaveLength(0);
    expect(host.doc.dirty).toBe(false);
    expect(host.doc.canUndo()).toBe(false);
    host.doc.addEntities([line('z')]);

    expect(sm.switchTo(0)).toBe(true);
    expect(host.doc.entities.map((e) => e.id)).toEqual(['a', 'b']);
    expect(host.doc.dirty).toBe(true);
    expect(host.doc.canUndo()).toBe(true);
    expect(host.selection).toEqual(new Set(['a']));
    expect(host.viewport.center).toEqual({ x: 9, y: 9 });
    expect(host.viewport.scale).toBe(33);
    expect(host.doc.undo()).toBe(true);
    expect(host.doc.entities.map((e) => e.id)).toEqual(['a']);
    expect(host.doc.canRedo()).toBe(true);

    sm.switchTo(1);
    expect(host.doc.entities.map((e) => e.id)).toEqual(['z']);
    expect(sm.switchTo(1)).toBe(false);
    expect(sm.switchTo(7)).toBe(false);
  });

  it('cycles with wrap-around and reports dirty state across tabs', () => {
    const host = makeHost();
    const sm = new SessionManager(host);
    sm.add();
    sm.add();
    expect(sm.active).toBe(2);
    sm.cycle(1);
    expect(sm.active).toBe(0);
    sm.cycle(-1);
    expect(sm.active).toBe(2);
    expect(sm.anyDirty()).toBe(false);
    host.doc.addEntities([line('q')]);
    sm.cycle(1);
    expect(sm.isDirty(2)).toBe(true);
    expect(sm.isDirty(0)).toBe(false);
    expect(sm.anyDirty()).toBe(true);
  });

  it('closing tabs keeps a sensible active tab and never leaves zero documents', () => {
    const host = makeHost();
    const sm = new SessionManager(host);
    host.doc.addEntities([line('first')]);
    sm.add(); // 1
    host.doc.addEntities([line('second')]);
    sm.add(); // 2 active
    sm.close(0); // close a tab left of the active one
    expect(sm.count).toBe(2);
    expect(sm.active).toBe(1);
    expect(host.doc.entities).toHaveLength(0);
    sm.close(1); // close the active (last) tab -> previous becomes active
    expect(sm.active).toBe(0);
    expect(host.doc.entities.map((e) => e.id)).toEqual(['second']);
    sm.close(0); // closing the only tab yields a fresh Drawing1
    expect(sm.count).toBe(1);
    expect(host.doc.entities).toHaveLength(0);
    expect(sm.titleOf(0)).toBe('Drawing1.dxf');
  });

  it('a listener that reads the session list while a tab is loading cannot wipe its dirty flag or undo history', () => {
    // The file tabs refresh on the 'file' event that Editor.loadState emits, and read
    // sessions.all (which syncs the live document) - in the middle of the switch.
    const host = makeHost();
    let sm!: SessionManager;
    const load = host.loadState.bind(host);
    host.loadState = (state, path) => {
      load(state, path);
      void sm.all;
    };
    sm = new SessionManager(host);
    host.doc.addEntities([line('a')]);
    host.doc.addEntities([line('b')]);
    sm.add();
    sm.switchTo(0);
    expect(host.doc.dirty).toBe(true);
    expect(sm.isDirty(0)).toBe(true);
    expect(host.doc.canUndo()).toBe(true);
    expect(host.doc.undo()).toBe(true);
    expect(host.doc.entities.map((e) => e.id)).toEqual(['a']);
    sm.switchTo(1);
    expect(sm.anyDirty()).toBe(true);
  });

  it('openInTab reuses a pristine tab, switches to an already-open file and drops a cancelled tab', async () => {
    const host = makeHost();
    const sm = new SessionManager(host);
    const opener = (path: string | null) => async (file?: string) => {
      if (path === null) return; // cancelled dialog
      const d = new Drawing();
      d.addEntities([line(file ?? path)]);
      host.loadState(d.snapshot, file ?? path);
    };
    await sm.openInTab(undefined, opener('/a.dxf'));
    expect(sm.count).toBe(1); // pristine Drawing1 reused
    expect(host.doc.filePath).toBe('/a.dxf');
    await sm.openInTab('/b.dxf', opener('/b.dxf'));
    expect(sm.count).toBe(2);
    expect(sm.active).toBe(1);
    await sm.openInTab('/a.dxf', opener('/a.dxf'));
    expect(sm.count).toBe(2); // already open: switched instead
    expect(sm.active).toBe(0);
    await sm.openInTab(undefined, opener(null));
    expect(sm.count).toBe(2); // cancelled: the temporary tab is gone
    expect(sm.active).toBe(0);
    expect(host.doc.filePath).toBe('/a.dxf');
  });
});

describe('session close — onDocClosed hook (Stage-1 fix A)', () => {
  it('fires exactly once per close with the closing session docId, including the last-tab blank replacement', () => {
    const host = makeHost();
    const sm = new SessionManager(host);
    const seen: string[] = [];
    sm.onDocClosed = (docId) => seen.push(docId);
    const firstDocId = sm.all[0]!.docId;
    sm.addInBackground(host.doc.snapshot, null);
    const secondDocId = sm.all[1]!.docId;
    expect(secondDocId).not.toBe(firstDocId);
    sm.close(1); // background tab
    expect(seen).toEqual([secondDocId]);
    sm.close(0); // the only remaining tab -> splice-to-empty path pushes a fresh blank session
    expect(seen).toEqual([secondDocId, firstDocId]);
    expect(sm.count).toBe(1);
    expect(sm.all[0]!.docId).not.toBe(firstDocId);
  });

  it('does not fire for an out-of-range index', () => {
    const host = makeHost();
    const sm = new SessionManager(host);
    const seen: string[] = [];
    sm.onDocClosed = (docId) => seen.push(docId);
    sm.close(5);
    sm.close(-1);
    expect(seen).toEqual([]);
    expect(sm.count).toBe(1);
  });

  it('close behaves exactly as before when no hook is set', () => {
    const host = makeHost();
    const sm = new SessionManager(host);
    expect(sm.onDocClosed).toBeNull();
    sm.addInBackground(host.doc.snapshot, null);
    sm.close(1);
    expect(sm.count).toBe(1);
    sm.close(0);
    expect(sm.count).toBe(1);
    expect(sm.titleOf(0)).toBe('Drawing1.dxf');
  });
});
