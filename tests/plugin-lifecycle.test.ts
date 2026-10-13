import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import { createApi, type JcadApi } from '../src/app/api';
import { PluginHost, codeHash, evaluatePlugin, TRUST_KEY, type PluginSource, type PluginsBridge } from '../src/app/plugins';

let Editor: typeof EditorType;
beforeAll(async () => {
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const makeEditor = () => new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const source = (path: string, code = '', name = 'race'): PluginSource => ({ manifest: { name, apiVersion: 1 }, code, path, origin: 'file' });
const registration = (name: string) => `jcad.commands.register({ name: '${name}', run(j) { j.ui.log('${name} ran'); } });`;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('plugin host load ownership', () => {
  it.each(['resolve', 'reject'])('keeps the newer same-name entry after a stale evaluation %s', async (result) => {
    const editor = makeEditor(), gate = deferred<void>(), started = deferred<void>(); let retained!: JcadApi;
    const host = new PluginHost(editor, { storage: null, confirm: async () => true, evaluate: async (code, api, name) => {
      await evaluatePlugin(code, api, name, null);
      if (code.includes("'OLD'")) { retained = api; started.resolve(); await gate.promise; }
    } });
    const old = host.load(source('old.js', registration('OLD'))); await started.promise;
    const next = await host.load(source('new.js', registration('NEXTCMD'), 'RACE'));
    if (result === 'resolve') gate.resolve(); else gate.reject(new Error('late old failure'));
    expect((await old).error).toMatch(/superseded/);
    expect(next.status).toBe('loaded'); expect(host.get('race')).toMatchObject({ path: 'new.js', status: 'loaded', commands: ['NEXTCMD'] });
    expect(() => retained.document.entities()).toThrow(/unloaded/);
    expect(editor.commands.has('OLD')).toBe(false); expect(editor.history.some((line) => /old failure/.test(line))).toBe(false);
    expect(host.unload('race')).toBe(true); expect(editor.commands.has('NEXTCMD')).toBe(false);
  });
  it.each(['allow', 'decline', 'reject'])('ignores a stale %s confirmation and keeps the newer trust answer', async (answer) => {
    const editor = makeEditor(), gate = deferred<boolean>(), asked = deferred<void>(), data = new Map<string, string>(), newSource = source('same.js', registration('NEXTCMD'));
    let oldAsked = false;
    const host = new PluginHost(editor, { storage: { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }, confirm: async () => {
      if (!oldAsked) { oldAsked = true; asked.resolve(); return gate.promise; } return true;
    } });
    const old = host.load(source('same.js', registration('OLD'))); await asked.promise;
    await host.load(newSource);
    if (answer === 'reject') gate.reject(new Error('old confirmation failed')); else gate.resolve(answer === 'allow');
    expect((await old).error).toMatch(/superseded/);
    expect(host.get('race')).toMatchObject({ status: 'loaded', commands: ['NEXTCMD'] }); expect(editor.commands.has('OLD')).toBe(false);
    expect(JSON.parse(data.get(TRUST_KEY)!)['file:same.js']).toMatchObject({ answer: 'yes', hash: await codeHash(newSource.code) });
  });
  it('unloads an outstanding confirmation without allowing its late answer to execute', async () => {
    const editor = makeEditor(), gate = deferred<boolean>(), asked = deferred<void>(), evaluate = vi.fn(async () => {});
    const host = new PluginHost(editor, { storage: null, evaluate, confirm: async () => { asked.resolve(); return gate.promise; } });
    const loading = host.load(source('pending.js')); await asked.promise;
    expect(host.unload('race')).toBe(true); gate.resolve(true);
    expect((await loading).error).toMatch(/unloaded/); expect(host.get('race')).toBeUndefined(); expect(evaluate).not.toHaveBeenCalled();
  });
  it('binds a confirmed load to the original code and manifest', async () => {
    const editor = makeEditor(), gate = deferred<boolean>(), asked = deferred<void>(), original = source('original.js', registration('ORIGINAL'));
    const host = new PluginHost(editor, { storage: null, confirm: async () => { asked.resolve(); return gate.promise; } });
    const loading = host.load(original); await asked.promise;
    original.code = registration('ALTERED'); original.manifest.name = 'altered'; gate.resolve(true);
    expect((await loading).name).toBe('race'); expect(editor.commands.has('ORIGINAL')).toBe(true); expect(editor.commands.has('ALTERED')).toBe(false);
  });
  it.each(['unload', 'replace'])('does not resurrect a plugin after a delayed folder reload and %s', async (change) => {
    const editor = makeEditor(), gate = deferred<{ manifest: string; code: string; path: string } | null>(), read = deferred<void>();
    const bridge: PluginsBridge = { pluginsDir: async () => '/plugins', pluginsList: async () => [], pluginsRead: async () => { read.resolve(); return gate.promise; } };
    const host = new PluginHost(editor, { bridge, storage: null, confirm: async () => true });
    await host.load({ ...source('folder/old.js', registration('OLD')), origin: 'folder', folder: 'race' });
    const reloading = host.reload('race'); await read.promise;
    if (change === 'unload') host.unload('race'); else await host.load(source('new.js', registration('NEXTCMD')));
    gate.resolve({ manifest: '{"name":"race"}', code: registration('DISK'), path: 'folder/new.js' });
    expect(await reloading).toEqual([]); expect(editor.commands.has('DISK')).toBe(false);
    expect(host.get('race')?.path).toBe(change === 'unload' ? undefined : 'new.js');
  });
  it('does not overwrite a reentrant load started by an unload hook', async () => {
    const editor = makeEditor(); let inner: Promise<unknown> | undefined;
    const host = new PluginHost(editor, { storage: null, confirm: async () => true, evaluate: async (code, api, name) => {
      await evaluatePlugin(code, api, name, null);
      if (code === registration('OLD')) api.plugin.onUnload(() => { inner = host.load(source('inner.js', registration('INNER'))); });
    } });
    await host.load(source('old.js', registration('OLD')));
    expect((await host.load(source('outer.js', registration('OUTER')))).error).toMatch(/superseded/); await inner;
    expect(host.get('race')).toMatchObject({ path: 'inner.js', status: 'loaded', commands: ['INNER'] }); expect(editor.commands.has('OUTER')).toBe(false);
    host.unload('race'); expect(editor.commands.has('INNER')).toBe(false);
  });
  it('disposes a failed one-off script instead of retaining partial registrations', async () => {
    const editor = makeEditor(), host = new PluginHost(editor, { storage: null, confirm: async () => true });
    expect(await host.runScript('failed.js', `${registration('HALF')} throw new Error('failed script');`)).toBe(false);
    expect(editor.commands.has('HALF')).toBe(false);
  });
  it('cleans a partial load even when the thrown value cannot be converted to text', async () => {
    const editor = makeEditor(), host = new PluginHost(editor, { storage: null, confirm: async () => true });
    const loaded = await host.load(source('broken.js', `${registration('PARTIAL')} throw { toString() { throw new Error('conversion failed'); } };`));
    expect(loaded).toMatchObject({ status: 'error', error: 'Plugin error could not be displayed.' }); expect(editor.commands.has('PARTIAL')).toBe(false);
    host.unload('race');
  });
});

describe('disposed plugin API handles', () => {
  it('revokes reads and UI/file entry points while preserving immutable identity values', async () => {
    const editor = makeEditor(), handle = createApi(editor, 'revoked'), { api } = handle;
    api.document.add({ type: 'point', position: { x: 1, y: 2 } }); const before = [...editor.history]; handle.dispose();
    const retained = [
      () => api.document.info(), () => api.document.entities(), () => api.document.entity('x'), () => api.document.selection(),
      () => api.document.layers(), () => api.document.currentLayer(), () => api.document.blocks(), () => api.document.extents(), () => api.document.header(),
      () => api.electrical.components(), () => api.electrical.wires(), () => api.commands.list(), () => api.settings.get('gridVisible'), () => api.settings.keys(),
      () => api.geometry.distance({ x: 0, y: 0 }, { x: 1, y: 1 }), () => api.geometry.bounds([]), () => api.geometry.rad(90),
      () => api.ui.log('late'), () => api.ui.alert('late'), () => api.ui.confirm('late'), () => api.ui.openDialog('late'),
      () => api.ui.prompt('late'), () => api.ui.pick.point(), () => api.ui.pick.entities(), () => api.files.readText(), () => api.plugin.onUnload(() => {}),
    ];
    for (const read of retained) expect(read).toThrow(/unloaded/);
    await expect(api.files.saveText('late.txt', 'late')).rejects.toThrow(/unloaded/);
    expect(editor.history).toEqual(before); expect(api.plugin.name).toBe('revoked'); expect(api.apiVersion).toBe(1);
  });
  it('preserves synchronous unload hooks, prevents reentrant disposal and refuses retained hooks', () => {
    const editor = makeEditor(), handle = createApi(editor, 'hooks'), calls: string[] = [];
    handle.api.plugin.onUnload(() => { calls.push('first'); handle.api.ui.log('bye'); handle.dispose(); expect(() => handle.api.plugin.onUnload(() => {})).toThrow(/being unloaded/); });
    handle.api.plugin.onUnload(() => calls.push('second'));
    handle.dispose(); handle.dispose(); expect(calls).toEqual(['first', 'second']); expect(editor.history).toContain('bye');
    expect(() => handle.api.ui.log('after')).toThrow(/unloaded/);
  });
  it('always revokes and cleans up after a non-stringifiable unload error', async () => {
    const editor = makeEditor(), handle = createApi(editor, 'hostile'), listener = vi.fn(), second = vi.fn();
    handle.api.commands.register({ name: 'HOSTILECMD', run: () => {} }); handle.api.events.on('documentChanged', listener);
    const prompt = handle.api.ui.prompt('Pending');
    handle.api.plugin.onUnload(() => { throw { toString() { throw new Error('conversion failed'); } }; });
    handle.api.plugin.onUnload(second); expect(() => handle.dispose()).not.toThrow(); handle.dispose();
    expect(second).toHaveBeenCalledTimes(1); expect(editor.commands.has('HOSTILECMD')).toBe(false); expect(await prompt).toBeNull();
    expect(() => handle.api.document.entities()).toThrow(/unloaded/); expect(editor.history).toContain('[hostile] unload: Plugin error could not be displayed.');
    createApi(editor, 'active').api.document.add({ type: 'point', position: { x: 0, y: 0 } }); expect(listener).not.toHaveBeenCalled();
  });
  it('does not leave an unhandled rejection from an asynchronous unload hook', async () => {
    const editor = makeEditor(), handle = createApi(editor, 'async-hook');
    handle.api.plugin.onUnload(async () => { throw new Error('late unload rejection'); }); handle.dispose(); await tick();
    expect(() => handle.api.ui.log('late')).toThrow(/unloaded/);
  });
  it('rolls back a transaction when the plugin unloads during its synchronous callback', () => {
    const editor = makeEditor(), handle = createApi(editor, 'transaction'), original = editor.doc.snapshot;
    expect(() => handle.api.document.transact(() => { handle.api.document.add({ type: 'point', position: { x: 1, y: 1 } }); handle.dispose(); })).toThrow(/unloaded/);
    expect(editor.doc.snapshot).toBe(original); expect(editor.doc.dirty).toBe(false);
  });
  it('rolls back both levels when a nested plugin unloads inside another active transaction', () => {
    const editor = makeEditor(), outer = createApi(editor, 'outer'), nested = createApi(editor, 'nested'), original = editor.doc.snapshot;
    expect(() => outer.api.document.transact(() => nested.api.document.transact(() => { nested.api.document.add({ type: 'point', position: { x: 1, y: 1 } }); nested.dispose(); }))).toThrow(/unloaded/);
    expect(editor.doc.snapshot).toBe(original); expect(editor.doc.dirty).toBe(false); outer.dispose();
  });
  it('restores the nested pending state when an outer transaction catches its unload error', () => {
    const editor = makeEditor(), outer = createApi(editor, 'outer'), nested = createApi(editor, 'nested'); let retained!: string;
    outer.api.document.transact(() => {
      retained = outer.api.document.add({ type: 'point', position: { x: 0, y: 0 } })[0]!;
      expect(() => nested.api.document.transact(() => { nested.api.document.add({ type: 'point', position: { x: 1, y: 1 } }); nested.dispose(); })).toThrow(/unloaded/);
      expect(outer.api.document.entities()).toHaveLength(1);
    });
    expect(editor.doc.entities.map(entity => entity.id)).toEqual([retained]);
    expect(editor.doc.undo()).toBe(true); expect(editor.doc.entities).toEqual([]); outer.dispose();
  });
  it('rejects a thenable from a nested callback and rolls back its pending edits', () => {
    const editor = makeEditor(), outer = createApi(editor, 'outer'), nested = createApi(editor, 'nested'), original = editor.doc.snapshot;
    expect(() => outer.api.document.transact(() => nested.api.document.transact(() => { nested.api.document.add({ type: 'point', position: { x: 1, y: 1 } }); return Promise.resolve(); }))).toThrow(/must be synchronous/);
    expect(editor.doc.snapshot).toBe(original); expect(editor.doc.dirty).toBe(false); outer.dispose(); nested.dispose();
  });
  it.each(['outer', 'nested'])('rolls back when a %s transaction result getter unloads its owner', (level) => {
    const editor = makeEditor(), outer = createApi(editor, 'outer'), nested = createApi(editor, 'nested'), original = editor.doc.snapshot;
    const active = level === 'outer' ? outer : nested;
    const callback = () => {
      active.api.document.add({ type: 'point', position: { x: 1, y: 1 } });
      return Object.defineProperty({ value: 7 }, 'then', { get() { active.dispose(); return undefined; } });
    };
    expect(() => outer.api.document.transact(() => level === 'outer' ? callback() : nested.api.document.transact(callback))).toThrow(/unloaded/);
    expect(editor.doc.snapshot).toBe(original); expect(editor.doc.dirty).toBe(false); outer.dispose(); nested.dispose();
  });
  it.each(['text', 'point', 'selection'])('cancels an owned %s prompt immediately on unload', async (kind) => {
    const editor = makeEditor(), handle = createApi(editor, 'prompt');
    const promise = kind === 'text' ? handle.api.ui.prompt('Secret') : kind === 'point' ? handle.api.ui.pick.point('Secret') : handle.api.ui.pick.entities('Secret');
    expect(editor.tool).not.toBeNull(); handle.dispose();
    expect(await promise).toEqual(kind === 'selection' ? [] : null); expect(editor.tool).toBeNull(); expect(editor.prompt).toBe('Type a command');
  });
  it('does not cancel another plugin prompt when a previously canceled owner unloads', async () => {
    const editor = makeEditor(), first = createApi(editor, 'first'), second = createApi(editor, 'second');
    const old = first.api.ui.prompt('Old'), current = second.api.ui.prompt('Current'); const tool = editor.tool;
    first.dispose(); expect(await old).toBeNull(); expect(editor.tool).toBe(tool); expect(editor.prompt).toBe('Current');
    editor.submitInput('answer'); expect(await current).toBe('answer'); second.dispose();
  });
  it('makes retained command definitions and unregister handles harmless to new commands', () => {
    const editor = makeEditor(), first = createApi(editor, 'same'), second = createApi(editor, 'same'), run = vi.fn();
    const remove = first.api.commands.register({ name: 'OWNED', run }), definition = editor.commands.get('OWNED')!;
    first.dispose(); second.api.commands.register({ name: 'OWNED', run });
    definition.run(editor); remove(); expect(run).not.toHaveBeenCalled(); expect(editor.commands.has('OWNED')).toBe(true);
    second.dispose(); expect(editor.commands.has('OWNED')).toBe(false);
  });
  it('does not remove a newer same-owner listener through a retained off handle', () => {
    const editor = makeEditor(), first = createApi(editor, 'same'), second = createApi(editor, 'same'), listener = vi.fn();
    const remove = first.api.events.on('documentChanged', listener); first.dispose(); second.api.events.on('documentChanged', listener);
    remove(); first.api.events.off('documentChanged', listener); second.api.document.add({ type: 'point', position: { x: 1, y: 1 } }); expect(listener).toHaveBeenCalledTimes(1);
    second.dispose();
  });
  it('skips a listener revoked after the current emission snapshot was taken', () => {
    const editor = makeEditor(), first = createApi(editor, 'first'), second = createApi(editor, 'second'), listener = vi.fn();
    first.api.events.on('documentChanged', () => second.dispose()); second.api.events.on('documentChanged', listener);
    first.api.document.add({ type: 'point', position: { x: 1, y: 1 } }); expect(listener).not.toHaveBeenCalled(); first.dispose();
  });
  it.each(['command', 'listener'])('suppresses late %s errors from unloaded API callbacks', async (kind) => {
    const editor = makeEditor(), handle = createApi(editor, 'late'), gate = deferred<void>();
    if (kind === 'command') { handle.api.commands.register({ name: 'PENDING', run: () => gate.promise }); editor.runCommand('PENDING'); }
    else { handle.api.events.on('documentChanged', () => gate.promise); handle.api.document.add({ type: 'point', position: { x: 0, y: 0 } }); }
    handle.dispose(); const history = [...editor.history]; gate.reject(new Error('late rejection')); await tick(); expect(editor.history).toEqual(history);
  });
  it('settles a pending host confirmation on disposal and suppresses its late result', async () => {
    const editor = makeEditor(), gate = deferred<boolean>(), handle = createApi(editor, 'confirm');
    editor.ui = { ...editor.ui!, confirm: () => gate.promise };
    const pending = handle.api.ui.confirm('Approve'); handle.dispose(); expect(await pending).toBe(false); gate.resolve(true); await tick();
    expect(() => handle.api.ui.confirm('late')).toThrow(/unloaded/);
  });
  it('suppresses a late native save result without claiming to cancel an already-issued write', async () => {
    const editor = makeEditor(), gate = deferred<string | null>(), save = vi.fn(() => gate.promise), handle = createApi(editor, 'save');
    editor.fileBridge = { saveText: save } as unknown as NonNullable<typeof editor.fileBridge>;
    const pending = handle.api.files.saveText('test.txt', 'contents'); expect(save).toHaveBeenCalledTimes(1); handle.dispose(); expect(await pending).toBeNull(); gate.resolve('test.txt'); await tick();
  });
  it('preserves active asynchronous rejections, including undefined rejection reasons', async () => {
    const editor = makeEditor(), handle = createApi(editor, 'active');
    editor.fileBridge = { saveText: () => Promise.reject(undefined) } as unknown as NonNullable<typeof editor.fileBridge>;
    await expect(handle.api.files.saveText('test.txt', 'contents')).rejects.toBeUndefined(); handle.dispose();
  });
  it('removes an outstanding file picker and ignores its late file-text response', async () => {
    const editor = makeEditor(), handle = createApi(editor, 'file'), gate = deferred<string>(), callbacks = new Map<string, () => void>(), remove = vi.fn();
    const input = { files: [{ name: 'private.txt', size: 8, text: () => gate.promise }], style: {}, remove, click: vi.fn(), addEventListener: (name: string, callback: () => void) => callbacks.set(name, callback) };
    vi.stubGlobal('document', { createElement: () => input, body: { appendChild() {} } });
    const pending = handle.api.files.readText(); callbacks.get('change')!(); handle.dispose(); expect(await pending).toBeNull(); expect(remove).toHaveBeenCalled();
    gate.resolve('late private data'); await tick(); callbacks.get('change')!(); expect(await pending).toBeNull();
  });
});
