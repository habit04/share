import { describe, it, expect } from 'vitest';
import { autosaveName, localAutosaveStore, sessionsToAutosave, type KeyValueStorage } from '../src/app/autosave';
import { Drawing } from '../src/core/document';

function fakeStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe('autosave', () => {
  it('builds safe file names', () => {
    expect(autosaveName('Drawing1.dxf', 3)).toBe('Drawing1_3.sv.dxf');
    expect(autosaveName('my panel (rev B).dwg', 12)).toBe('my_panel_rev_B_12.sv.dxf');
    expect(autosaveName('', 1)).toBe('Drawing_1.sv.dxf');
  });
  it('local store writes, lists newest first, reads and removes', async () => {
    const store = localAutosaveStore(fakeStorage());
    await store.write('a.sv.dxf', 'AAA', { originalPath: '/x/a.dxf', title: 'a.dxf', savedAt: 10 });
    await store.write('b.sv.dxf', 'BBB', { originalPath: null, title: 'Drawing2.dxf', savedAt: 20 });
    const list = await store.list();
    expect(list.map((e) => e.name)).toEqual(['b.sv.dxf', 'a.sv.dxf']);
    expect(list[1]!.originalPath).toBe('/x/a.dxf');
    expect(await store.read('a.sv.dxf')).toBe('AAA');
    expect(await store.read('missing')).toBeNull();
    await store.remove('a.sv.dxf');
    expect((await store.list()).length).toBe(1);
  });
  it('only dirty sessions whose state changed since the last write are saved', () => {
    const d1 = new Drawing();
    const d2 = new Drawing();
    const sessions = [
      { id: 1, dirty: true, state: d1.snapshot },
      { id: 2, dirty: false, state: d2.snapshot },
      { id: 3, dirty: true, state: d2.snapshot },
    ];
    const last = new Map([[3, d2.snapshot]]);
    expect(sessionsToAutosave(sessions, last)).toEqual([1]);
    d2.addEntities([{ id: 'e', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]);
    sessions[2] = { id: 3, dirty: true, state: d2.snapshot };
    expect(sessionsToAutosave(sessions, last)).toEqual([1, 3]);
  });
});
