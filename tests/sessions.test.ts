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
