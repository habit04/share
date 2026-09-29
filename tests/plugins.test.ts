import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Editor as EditorType } from '../src/app/editor';
import type { InsertEntity, TextEntity } from '../src/core/entities';
import { PluginHost, TRUST_KEY, parseManifest, sourceFromFiles, codeHash, evaluatePlugin, registerPluginCommands, pluginHost, loadPlugins, type PluginsBridge, type StorageLike } from '../src/app/plugins';
import { createApi } from '../src/app/api';

let Editor: typeof EditorType;
beforeAll(async () => {
  const g = globalThis as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
const makeEditor = () => new Editor(canvas());
const tick = () => new Promise((r) => setTimeout(r, 0));

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

/** plugins/<folder>/{plugin.json, main.js} held in memory, like the main-process handlers. */
function fakeBridge(folders: Record<string, { manifest: string | null; code?: string }>): PluginsBridge & { folders: typeof folders } {
  return {
    folders,
    pluginsDir: async () => '/user/plugins',
    pluginsList: async () => Object.entries(folders).map(([folder, f]) => (f.manifest === null ? { folder, manifest: null, error: 'no plugin.json' } : { folder, manifest: f.manifest })),
    pluginsRead: async (folder) => {
      const f = folders[folder];
      if (!f || f.manifest === null) return null;
      return { manifest: f.manifest, code: f.code ?? '', path: `/user/plugins/${folder}/main.js` };
    },
  };
}

const manifest = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: '1.0.0', main: 'main.js', ...extra });
const example = (name: string) => ({
  manifest: readFileSync(join(__dirname, '..', 'examples', 'plugins', name, 'plugin.json'), 'utf8'),
  code: readFileSync(join(__dirname, '..', 'examples', 'plugins', name, 'main.js'), 'utf8'),
});

describe('plugin manifests and sources', () => {
  it('validates plugin.json', () => {
    expect(parseManifest(manifest('ok'))).toMatchObject({ name: 'ok', main: 'main.js', apiVersion: 1, version: '1.0.0' });
    expect(parseManifest('{}', 'folder-name').name).toBe('folder-name');
    expect(() => parseManifest('{nope')).toThrow(/not valid JSON/);
    expect(() => parseManifest(manifest('bad name'))).toThrow(/plugin name/);
    expect(() => parseManifest(manifest('x', { main: '../evil.js' }))).toThrow(/"main"/);
    expect(() => parseManifest(manifest('x', { apiVersion: 0 }))).toThrow(/apiVersion/);
  });

  it('builds a source from picked files', () => {
    expect(sourceFromFiles([{ name: 'My Tool.js', text: 'x' }]).manifest.name).toBe('My-Tool');
    const s = sourceFromFiles([
      { name: 'plugin.json', text: manifest('pair', { main: 'entry.js' }) },
      { name: 'entry.js', text: 'code' },
    ]);
    expect(s).toMatchObject({ code: 'code', origin: 'file', manifest: { name: 'pair' } });
    expect(() => sourceFromFiles([{ name: 'plugin.json', text: manifest('lonely') }])).toThrow(/together/);
    expect(() => sourceFromFiles([])).toThrow(/one \.js/);
  });

  it('hashes code with SHA-256', async () => {
    expect(await codeHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('PluginHost', () => {
  it('asks once per plugin, remembers the answer and asks again when the code changes', async () => {
    const ed = makeEditor();
    const storage = memoryStorage();
    const asked: string[] = [];
    const bridge = fakeBridge({ hello: example('hello') });
    const confirm = async (name: string, path: string) => {
      asked.push(`${name}@${path}`);
      return true;
    };
    const host = new PluginHost(ed, { bridge, storage, confirm });
    const loaded = await host.loadAll();
    expect(loaded.map((p) => p.status)).toEqual(['loaded']);
    expect(asked).toEqual(['hello@/user/plugins/hello/main.js']);
    expect(JSON.parse(storage.data.get(TRUST_KEY)!)['folder:/user/plugins/hello/main.js'].answer).toBe('yes');
    expect(host.get('hello')!.commands).toEqual(['HELLO']);
    // HELLO logs the selection count
    ed.selection = new Set(['a', 'b']);
    ed.runCommand('HELLO');
    expect(ed.history.at(-1)).toBe('Hello from hello! 2 objects selected.');
    // a second start: remembered, no question
    const ed2 = makeEditor();
    await new PluginHost(ed2, { bridge, storage, confirm }).loadAll();
    expect(asked).toHaveLength(1);
    expect(ed2.commands.has('HELLO')).toBe(true);
    // changed code: asked again
    bridge.folders.hello = { ...bridge.folders.hello!, code: `${bridge.folders.hello!.code}\n// v2` };
    await new PluginHost(makeEditor(), { bridge, storage, confirm }).loadAll();
    expect(asked).toHaveLength(2);
  });

  it('keeps a declined plugin unloaded at start-up but asks again on PLUGINLOAD', async () => {
    const ed = makeEditor();
    const storage = memoryStorage();
    let answer = false;
    let asks = 0;
    const bridge = fakeBridge({ hello: example('hello') });
    const host = new PluginHost(ed, { bridge, storage, confirm: async () => (asks++, answer) });
    await host.loadAll();
    expect(host.get('hello')!.status).toBe('declined');
    expect(ed.commands.has('HELLO')).toBe(false);
    await host.loadAll();
    expect(asks).toBe(1);
    answer = true;
    await host.load(await host.readFolder('hello'), true);
    expect(asks).toBe(2);
    expect(host.get('hello')!.status).toBe('loaded');
    expect(host.forget('hello')).toBe(1);
  });

  it('catches plugin errors, reports them with the plugin name and keeps nothing half-registered', async () => {
    const ed = makeEditor();
    const bridge = fakeBridge({
      broken: { manifest: manifest('broken'), code: "jcad.commands.register({ name: 'HALF', run() {} });\nthrow new Error('oops');" },
      syntax: { manifest: manifest('syntax'), code: 'this is not javascript (' },
      future: { manifest: manifest('future', { apiVersion: 99 }), code: '' },
      asyncfail: { manifest: manifest('asyncfail'), code: "return Promise.reject(new Error('async oops'));" },
      nomanifest: { manifest: null },
    });
    const host = new PluginHost(ed, { bridge, storage: memoryStorage(), confirm: async () => true });
    const out = await host.loadAll();
    expect(out.map((p) => `${p.name}:${p.status}`).sort()).toEqual(['asyncfail:error', 'broken:error', 'future:error', 'syntax:error']);
    expect(ed.commands.has('HALF')).toBe(false);
    expect(ed.history).toContain('[broken] failed to load: oops');
    expect(ed.history).toContain('[asyncfail] failed to load: async oops');
    expect(ed.history.some((l) => l.startsWith('[syntax] failed to load:'))).toBe(true);
    expect(ed.history.some((l) => /future: needs plugin API version 99/.test(l))).toBe(true);
    expect(ed.history).toContain('Plugin folder nomanifest: no plugin.json.');
  });

  it('reloads a plugin from disk: old commands go, onUnload runs, new code runs', async () => {
    const ed = makeEditor();
    const bridge = fakeBridge({
      counter: { manifest: manifest('counter'), code: "jcad.commands.register({ name: 'ONE', run(j) { j.ui.log('one'); } }); jcad.plugin.onUnload(() => jcad.ui.log('bye'));" },
    });
    const host = new PluginHost(ed, { bridge, storage: memoryStorage(), confirm: async () => true });
    await host.loadAll();
    expect(ed.commands.has('ONE')).toBe(true);
    bridge.folders.counter!.code = "jcad.commands.register({ name: 'TWO', run(j) { j.ui.log('two'); } });";
    bridge.folders.later = { manifest: manifest('later'), code: '' };
    const r = await host.reload();
    expect(r.map((p) => p.name).sort()).toEqual(['counter', 'later']);
    expect(ed.history).toContain('bye');
    expect(ed.commands.has('ONE')).toBe(false);
    expect(ed.commands.has('TWO')).toBe(true);
    expect(host.unload('counter')).toBe(true);
    expect(ed.commands.has('TWO')).toBe(false);
  });

  it('runs one-off scripts after confirmation', async () => {
    const ed = makeEditor();
    let ok = true;
    const host = new PluginHost(ed, { bridge: null, storage: memoryStorage(), confirm: async () => ok });
    const code = "jcad.document.add({ type: 'text', position: { x: 1, y: 1 }, text: 'from script' });";
    expect(await host.runScript('label.js', code)).toBe(true);
    expect(ed.doc.entities.some((e) => e.type === 'text' && e.text === 'from script')).toBe(true);
    expect(await host.runScript('bad.js', "throw new Error('nope')")).toBe(false);
    expect(ed.history.at(-1)).toBe('[script:bad.js] nope');
    ok = false;
    expect(await host.runScript('other.js', 'x')).toBe(false);
  });

  it('falls back to the preload bridge when the page CSP forbids new Function', async () => {
    const ed = makeEditor();
    const { api } = createApi(ed, 'csp');
    const g = globalThis as Record<string, unknown>;
    const RealFunction = Function;
    g.window = {};
    const bridge = fakeBridge({});
    const ran: string[] = [];
    // Emulates webFrame.executeJavaScript: evaluates the source as a script in the page.
    bridge.pluginsEval = async (source: string) => {
      ran.push(source);
      return new RealFunction('window', `return ${source}`)(g.window);
    };
    vi.stubGlobal('Function', function () {
      throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source");
    });
    try {
      await evaluatePlugin("jcad.ui.log('ran via bridge ' + jcad.plugin.name);", api, 'csp', bridge);
    } finally {
      vi.unstubAllGlobals();
      delete g.window;
    }
    expect(ran).toHaveLength(1);
    expect(ed.history.at(-1)).toBe('ran via bridge csp');
    // a real syntax error is still the plugin's error
    await expect(evaluatePlugin('(', api, 'csp', bridge)).rejects.toThrow(SyntaxError);
  });
});

describe('example plugins', () => {
  it('numbered-labels places incrementing labels at picked points and remembers the prefix', async () => {
    const ed = makeEditor();
    const host = new PluginHost(ed, { bridge: fakeBridge({ 'numbered-labels': example('numbered-labels') }), storage: memoryStorage(), confirm: async () => true });
    await host.loadAll();
    ed.runCommand('NUMLABEL');
    await tick();
    expect(ed.prompt).toBe('Label prefix <P>');
    ed.submitInput('M');
    await tick();
    expect(ed.prompt).toBe('First number <1>');
    ed.submitInput('7');
    await tick();
    ed.submitInput('1,1');
    await tick();
    ed.submitInput('2,1');
    await tick();
    expect(ed.prompt).toMatch(/Location for M9/);
    ed.pressEnter();
    await tick();
    const labels = ed.doc.entities.filter((e): e is TextEntity => e.type === 'text').map((t) => `${t.text}@${t.position.x}`);
    expect(labels).toEqual(['M7@1', 'M8@2']);
    expect(ed.history.at(-1)).toBe('2 labels placed; the next number is M9.');
    ed.runCommand('NLABEL');
    await tick();
    expect(ed.prompt).toBe('Label prefix <M>');
    ed.cancel();
  });

  it('bom-summary counts components by MFG and CAT', async () => {
    const ed = makeEditor();
    const block = Object.keys(ed.doc.blocks).find((n) => ed.doc.blocks[n]!.attributes.some((a) => a.tag === 'TAG1'))!;
    const ins = (id: string, tag: string, mfg: string, cat: string): InsertEntity => ({ id, type: 'insert', layer: '0', color: 'ByLayer', block, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG1: tag, MFG: mfg, CAT: cat } });
    ed.doc.addEntities([ins('a', 'CR1', 'AB', '700-P'), ins('b', 'CR2', 'AB', '700-P'), ins('c', 'PB1', 'SIEMENS', '3SU'), ins('d', 'X', '', '')]);
    const host = new PluginHost(ed, { bridge: fakeBridge({ 'bom-summary': example('bom-summary') }), storage: memoryStorage(), confirm: async () => true });
    await host.loadAll();
    ed.runCommand('BOMSUMMARY');
    await tick();
    expect(ed.history).toContain('BOMSUMMARY: 4 component(s), 3 catalog line(s).');
    // no DOM here: the dialog's text goes to the command line
    const text = ed.history.at(-1)!;
    expect(text).toMatch(/\(no MFG\) \(no CAT\) 1 X/);
    expect(text).toMatch(/AB 700-P 2 CR1, CR2/);
    expect(text).toMatch(/SIEMENS 3SU 1 PB1/);
  });
});

describe('plugin commands', () => {
  it('registers PLUGINS, PLUGINLOAD, PLUGINRELOAD and SCRIPTRUN once and lists plugins', async () => {
    const ed = makeEditor();
    registerPluginCommands(ed);
    registerPluginCommands(ed);
    for (const n of ['PLUGINS', 'PLUGINLOAD', 'PLUGINRELOAD', 'SCRIPTRUN']) expect(ed.commands.has(n)).toBe(true);
    const picks: Array<Array<{ name: string; text: string }>> = [[{ name: 'hello.js', text: example('hello').code }], [{ name: 's.js', text: "jcad.ui.log('script ran')" }]];
    pluginHost(ed, { bridge: fakeBridge({}), storage: memoryStorage(), confirm: async () => true, pickFiles: async () => picks.shift() ?? [] });
    ed.runCommand('PLUGINLOAD');
    await tick();
    await tick();
    expect(ed.commands.has('HELLO')).toBe(true);
    ed.runCommand('SCRIPTRUN');
    await tick();
    await tick();
    expect(ed.history).toContain('script ran');
    ed.runCommand('PLUGINS');
    await tick();
    expect(ed.history).toContain('Plugins folder: /user/plugins');
    expect(ed.history.some((l) => /hello\s+-\s+loaded\s+hello\.js\s+\[HELLO\]/.test(l))).toBe(true);
    ed.runCommand('PLUGINS Unload hello');
    expect(ed.commands.has('HELLO')).toBe(false);
  });

  it('loadPlugins never rejects', async () => {
    const ed = makeEditor();
    const bridge = fakeBridge({});
    bridge.pluginsList = async () => {
      throw new Error('disk on fire');
    };
    pluginHost(ed, { bridge, storage: memoryStorage(), confirm: async () => true });
    expect(await loadPlugins(ed)).toEqual([]);
    expect(ed.history.some((l) => l.includes('disk on fire'))).toBe(true);
  });
});
