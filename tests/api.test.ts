import { describe, it, expect, beforeAll } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import type { Entity, InsertEntity } from '../src/core/entities';
import { API_VERSION, createApi, installApi, normalizeEntity, frozenCopy, type JcadApi } from '../src/app/api';

// A real Editor over a stub canvas: requestAnimationFrame never fires, so nothing is drawn.
let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const makeEditor = () => new Editor(canvas());

/** Feed the active tool like the command line does. */
function type(ed: EditorType, text: string): void {
  if (text === '') ed.pressEnter();
  else ed.submitInput(text);
}

describe('jcad API: document', () => {
  it('hands out frozen copies and records one undo step per change', () => {
    const ed = makeEditor();
    const { api } = createApi(ed, 'test');
    expect(api.apiVersion).toBe(API_VERSION);
    const [id] = api.document.add({ type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } });
    const e = api.document.entity(id!)!;
    expect(e.layer).toBe(ed.doc.currentLayer);
    expect(Object.isFrozen(e)).toBe(true);
    expect(Object.isFrozen((e as { a: object }).a)).toBe(true);
    expect(() => {
      (e as { layer: string }).layer = 'X';
    }).toThrow();
    // the document's own object is not the one handed out
    expect(ed.doc.entity(id!)).not.toBe(e);
    api.document.replace({ ...e, b: { x: 5, y: 0 } });
    expect((ed.doc.entity(id!) as { b: { x: number } }).b.x).toBe(5);
    expect(api.document.remove([id!])).toBe(1);
    expect(ed.doc.entity(id!)).toBeUndefined();
    ed.doc.undo();
    expect((ed.doc.entity(id!) as { b: { x: number } }).b.x).toBe(5);
    ed.doc.undo();
    expect((ed.doc.entity(id!) as { b: { x: number } }).b.x).toBe(1);
  });

  it('groups changes made inside transact into one undo step and rolls back on error', () => {
    const ed = makeEditor();
    const { api } = createApi(ed, 'test');
    const before = ed.doc.entities.length;
    const ids = api.document.transact(() => {
      const a = api.document.add([{ type: 'circle', center: { x: 0, y: 0 }, radius: 1 }, { type: 'text', position: { x: 0, y: 0 }, text: 'A', layer: 'NEWLAYER' }]);
      // reads see the pending state
      expect(api.document.entities({ type: 'circle' })).toHaveLength(1);
      api.document.remove(a[0]!);
      return a;
    });
    expect(ids).toHaveLength(2);
    expect(ed.doc.entities.length).toBe(before + 1);
    expect(ed.doc.layer('NEWLAYER')).toBeDefined(); // missing layers are created
    expect(ed.doc.entity(ids[1]!)!.type).toBe('text');
    ed.doc.undo();
    expect(ed.doc.entities.length).toBe(before);
    expect(() =>
      api.document.transact(() => {
        api.document.add({ type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(ed.doc.entities.length).toBe(before);
  });

  it('validates entity input', () => {
    const ed = makeEditor();
    const s = ed.doc.snapshot;
    expect(() => normalizeEntity({ type: 'blob' }, s, 'add')).toThrow(/Unknown entity type/);
    expect(() => normalizeEntity({ type: 'line', a: { x: 0, y: 0 } }, s, 'add')).toThrow(/needs "b"/);
    expect(() => normalizeEntity({ type: 'line', a: { x: 0, y: NaN }, b: { x: 1, y: 1 } }, s, 'add')).toThrow(/finite/);
    expect(() => normalizeEntity({ type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, run: () => 1 }, s, 'add')).toThrow(/plain data/);
    expect(() => normalizeEntity({ type: 'insert', block: 'NOPE', position: { x: 0, y: 0 } }, s, 'add')).toThrow(/not defined/);
    expect(() => normalizeEntity({ id: 'nope', type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 1 } }, s, 'replace')).toThrow(/No entity/);
    const t = normalizeEntity({ type: 'text', position: { x: 1, y: 2 }, text: 42 }, s, 'add') as Entity & { text: string; height: number; align: string };
    expect(t).toMatchObject({ text: '42', height: 0.125, align: 'left', color: 'ByLayer' });
  });

  it('selects, reports layers, blocks, header and extents, and geometry helpers', () => {
    const ed = makeEditor();
    const { api } = createApi(ed, 'test');
    const ids = api.document.add([
      { type: 'line', a: { x: 0, y: 0 }, b: { x: 3, y: 4 } },
      { type: 'line', a: { x: 10, y: 10 }, b: { x: 11, y: 11 } },
    ]);
    expect(api.document.select([...ids, 'missing'])).toEqual(ids);
    expect([...ed.selection]).toEqual(ids);
    expect(api.document.selection()).toEqual(ids);
    expect(api.document.layers().some((l) => l.name === '0')).toBe(true);
    expect(api.document.blocks().length).toBeGreaterThan(0);
    expect(api.document.header().dimStyle.name).toBe('Standard');
    expect(api.document.extents()!.max.x).toBeGreaterThanOrEqual(11);
    expect(api.geometry.distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(api.geometry.deg(api.geometry.angle({ x: 0, y: 0 }, { x: 0, y: 1 }))).toBeCloseTo(90);
    expect(api.geometry.polar({ x: 1, y: 1 }, 0, 2)).toEqual({ x: 3, y: 1 });
    expect(api.geometry.bounds([ids[0]!])).toEqual({ min: { x: 0, y: 0 }, max: { x: 3, y: 4 } });
    expect(api.document.info().fileName).toMatch(/\.dxf$/i);
  });
});

describe('jcad API: electrical', () => {
  it('lists components and wires and sets attributes as one undo step', () => {
    const ed = makeEditor();
    const { api } = createApi(ed, 'test');
    const block = Object.keys(ed.doc.blocks).find((n) => ed.doc.blocks[n]!.attributes.some((a) => a.tag === 'TAG1'))!;
    const [cid] = api.document.add({ type: 'insert', block, position: { x: 1, y: 1 }, attributes: { TAG1: 'CR1', MFG: 'ACME' } });
    api.document.add([
      { type: 'insert', block, position: { x: 5, y: 1 } },
      { type: 'line', a: { x: 0, y: 0 }, b: { x: 5, y: 0 }, layer: 'WIRES' },
      { type: 'line', a: { x: 0, y: 1 }, b: { x: 5, y: 1 }, layer: '0' },
    ]);
    expect(api.electrical.components().map((c) => c.attributes.TAG1)).toEqual(['CR1']);
    expect(api.electrical.wires()).toHaveLength(1);
    api.electrical.setAttributes(cid!, { cat: 'X-100', desc1: 7 });
    const ins = ed.doc.entity(cid!) as InsertEntity;
    expect(ins.attributes).toMatchObject({ TAG1: 'CR1', CAT: 'X-100', DESC1: '7' });
    ed.doc.undo();
    expect((ed.doc.entity(cid!) as InsertEntity).attributes.CAT).toBeUndefined();
    expect(() => api.electrical.setAttributes('nope', {})).toThrow(/No block insert/);
    expect(typeof api.electrical.crossReference()).toBe('number');
  });
});

describe('jcad API: commands, prompts and events', () => {
  it('registers commands that run with the API, catches their errors and refuses to shadow built-ins', async () => {
    const ed = makeEditor();
    const handle = createApi(ed, 'demo');
    const { api } = handle;
    const seen: Array<string | undefined> = [];
    api.commands.register({ name: 'hello', aliases: ['hi'], description: 'Say hello', run: (j, arg) => void seen.push(arg ?? j.plugin.name) });
    ed.runCommand('HI');
    ed.runCommand('HELLO world');
    expect(seen).toEqual(['demo', 'world']);
    expect(api.commands.list().find((c) => c.name === 'HELLO')).toMatchObject({ aliases: ['HI'], plugin: 'demo', description: 'Say hello' });
    expect(() => api.commands.register({ name: 'LINE', run: () => {} })).toThrow(/already exists/);
    expect(() => api.commands.register({ name: 'bad name', run: () => {} })).toThrow(/Invalid command name/);
    api.commands.register({ name: 'BROKEN', run: () => { throw new Error('kaput'); } });
    api.commands.register({ name: 'ASYNCBROKEN', run: async () => { throw new Error('later'); } });
    ed.runCommand('BROKEN');
    ed.runCommand('ASYNCBROKEN');
    await new Promise((r) => setTimeout(r, 0));
    expect(ed.history.some((l) => l === '[demo] command BROKEN: kaput')).toBe(true);
    expect(ed.history.some((l) => l === '[demo] command ASYNCBROKEN: later')).toBe(true);
    // re-registering your own command is allowed (reload)
    api.commands.register({ name: 'HELLO', run: () => void seen.push('again') });
    ed.runCommand('HELLO');
    expect(seen.at(-1)).toBe('again');
    handle.dispose();
    expect(ed.commands.has('HELLO')).toBe(false);
    expect(ed.commands.has('HI')).toBe(false);
    expect(ed.commands.has('LINE')).toBe(true);
    expect(() => api.document.add([])).toThrow(/unloaded/);
  });

  it('prompts on the command line: text, points and selections; Esc resolves null', async () => {
    const ed = makeEditor();
    const { api } = createApi(ed, 'demo');
    const p1 = api.ui.prompt('Label prefix', 'X');
    expect(ed.prompt).toBe('Label prefix <X>');
    type(ed, 'Motor 1');
    expect(await p1).toBe('Motor 1');
    const p2 = api.ui.prompt('Label prefix', 'X');
    type(ed, '');
    expect(await p2).toBe('X');
    const p3 = api.ui.prompt('Anything');
    ed.cancel();
    expect(await p3).toBeNull();
    const pt = api.ui.pick.point('Pick a point:');
    type(ed, '3,4');
    expect(await pt).toEqual({ x: 3, y: 4 });
    const [lid] = api.document.add({ type: 'line', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } });
    const sel = api.ui.pick.entities('Pick lines:');
    expect(ed.prompt).toBe('Pick lines:');
    ed.submitInput('ALL');
    type(ed, '');
    expect(await sel).toContain(lid);
    expect(ed.tool).toBeNull();
  });

  it('emits documentChanged, selectionChanged, commandStarted/Ended and drawingOpened; listeners are isolated', () => {
    const ed = makeEditor();
    const handle = createApi(ed, 'events');
    const { api } = handle;
    const log: string[] = [];
    api.events.on('documentChanged', () => void log.push('doc'));
    api.events.on('selectionChanged', (ids) => void log.push(`sel:${(ids as string[]).length}`));
    api.events.on('commandStarted', (n) => void log.push(`start:${String(n)}`));
    api.events.on('commandEnded', (n) => void log.push(`end:${String(n)}`));
    api.events.on('drawingOpened', () => void log.push('opened'));
    api.events.on('documentChanged', () => {
      throw new Error('bad listener');
    });
    api.document.add({ type: 'point', position: { x: 0, y: 0 } });
    expect(log).toContain('doc');
    expect(ed.history.some((l) => l.includes('[events] documentChanged listener: bad listener'))).toBe(true);
    log.length = 0;
    ed.runCommand('LINE');
    expect(log).toEqual(['start:LINE']);
    ed.cancel();
    expect(log).toEqual(['start:LINE', 'end:LINE']);
    log.length = 0;
    ed.runCommand('SELECTALL');
    expect(log[0]).toBe('start:SELECTALL');
    expect(log).toContain('end:SELECTALL');
    expect(log.some((l) => l.startsWith('sel:'))).toBe(true);
    log.length = 0;
    ed.newDrawingNow();
    expect(log).toContain('opened');
    // a tool command followed by another command ends the first one first
    log.length = 0;
    ed.runCommand('LINE');
    ed.runCommand('CIRCLE');
    expect(log.filter((l) => l.startsWith('start') || l.startsWith('end'))).toEqual(['start:LINE', 'end:LINE', 'start:CIRCLE']);
    ed.cancel();
    handle.dispose();
    log.length = 0;
    api.events.off('documentChanged', () => {});
    ed.doc.addEntities([{ id: 'p9', type: 'point', layer: '0', color: 'ByLayer', position: { x: 1, y: 1 } } as Entity]);
    expect(log).toEqual([]);
  });

  it('limits settings to an allowlist and keeps plugin settings apart', () => {
    const ed = makeEditor();
    const { api } = createApi(ed, 'prefs');
    expect(typeof api.settings.get('gridVisible')).toBe('boolean');
    api.settings.set('ortho', true);
    expect(ed.snap.ortho).toBe(true);
    api.settings.set('crosshairSize', 500);
    expect(ed.settings.crosshairSize).toBe(100);
    expect(() => api.settings.set('recentFiles', [])).toThrow(/cannot be changed/);
    expect(() => api.settings.get('recentFiles')).toThrow(/not available/);
    expect(() => api.settings.set('ortho', 'yes')).toThrow(/boolean/);
    api.settings.set('plugin:prefix', 'M');
    expect(api.settings.get('plugin:prefix')).toBe('M');
    expect(createApi(ed, 'other').api.settings.get('plugin:prefix')).toBeUndefined();
  });
});

describe('installApi', () => {
  it('exposes one console API on window.jcadApi', () => {
    const ed = makeEditor();
    const g = globalThis as { window?: { jcadApi?: JcadApi } };
    g.window = {};
    try {
      const api = installApi(ed);
      expect(installApi(ed)).toBe(api);
      expect(g.window.jcadApi).toBe(api);
      expect(api.plugin.name).toBe('console');
      expect(Object.isFrozen(api) && Object.isFrozen(api.document)).toBe(true);
    } finally {
      delete g.window;
    }
  });

  it('caches frozen copies per source object', () => {
    const o = { a: { b: 1 } };
    expect(frozenCopy(o)).toBe(frozenCopy(o));
    expect(frozenCopy(o)).not.toBe(o);
  });
});
