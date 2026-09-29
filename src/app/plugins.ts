/**
 * Plugin loading.
 *
 * Desktop: every folder `<userData>/plugins/<name>/` with a `plugin.json` (and the `main.js`
 * it names) is a plugin. The main process lists and reads them (IPC `plugins-list`,
 * `plugins-read`, `plugins-dir`); the renderer runs the code with the plugin API as its only
 * argument: `new Function('jcad', code)`. When the page's Content-Security-Policy forbids
 * that (the Electron renderer does), the code runs in the page through the preload's
 * `pluginsEval` instead, with the same single `jcad` argument.
 *
 * Browser: PLUGINLOAD picks the files (a single .js, or plugin.json + main.js) with a file
 * input; they last for the session.
 *
 * Before a plugin runs the first time, the user confirms it. The answer is remembered in
 * localStorage under `jcad.plugins.trusted`, keyed by where the plugin came from and the
 * SHA-256 of its code, so a changed plugin is asked about again.
 *
 * A plugin that throws while loading (or later, in a command or event listener) is reported
 * on the command line with its name; the editor carries on.
 */
import type { Editor } from './editor';
import { API_VERSION, createApi, pickTextFile, type ApiHandle, type JcadApi } from './api';
import { modal, button } from '../ui/dialogkit';
import { esc } from '../ui/dom';

export interface PluginManifest {
  /** Letters, digits, dot, dash, underscore (1-64). */
  name: string;
  version?: string;
  description?: string;
  author?: string;
  /** Entry file next to plugin.json (default main.js). */
  main?: string;
  /** Plugin API version the plugin was written for (default 1). */
  apiVersion?: number;
}

export interface PluginSource {
  manifest: PluginManifest;
  code: string;
  /** Where it came from: a folder path, or the picked file name. */
  path: string;
  origin: 'folder' | 'file' | 'script';
  /** Folder name under userData/plugins (origin 'folder'). */
  folder?: string;
}

export type PluginStatus = 'loaded' | 'error' | 'declined';

export interface LoadedPlugin {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly path: string;
  readonly origin: PluginSource['origin'];
  readonly folder?: string;
  status: PluginStatus;
  error?: string;
  /** Commands the plugin registered. */
  commands: string[];
}

/** The preload bridge entries (electron/preload.cjs). */
export interface PluginsBridge {
  pluginsDir(): Promise<string>;
  pluginsList(): Promise<Array<{ folder: string; manifest: string | null; error?: string }>>;
  pluginsRead(folder: string): Promise<{ manifest: string; code: string; path: string } | null>;
  /** Run a script in the page (used when CSP forbids `new Function`). */
  pluginsEval?(source: string): Promise<unknown>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PluginHostOptions {
  bridge?: PluginsBridge | null;
  /** Ask the user (default: a modal dialog). */
  confirm?(name: string, path: string): Promise<boolean>;
  /** Where trust answers are kept (default localStorage). */
  storage?: StorageLike | null;
  /** Run plugin code (default: `new Function('jcad', code)`, falling back to the bridge). */
  evaluate?(code: string, api: JcadApi, name: string): Promise<unknown>;
  /** File picker for PLUGINLOAD / SCRIPTRUN (default: an <input type=file>). */
  pickFiles?(accept: string, multiple: boolean): Promise<Array<{ name: string; text: string }>>;
}

export const TRUST_KEY = 'jcad.plugins.trusted';
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CODE = 2 * 1024 * 1024;

// ------------------------------------------------------------------ helpers

/** Parse and check a plugin.json. Throws with a readable message. */
export function parseManifest(text: string, fallbackName?: string): PluginManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`plugin.json is not valid JSON (${(err as Error).message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('plugin.json must be an object');
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === 'string' && o.name ? o.name : fallbackName;
  if (!name || !NAME_RE.test(name)) throw new Error(`plugin name "${String(name)}" must be 1-64 letters, digits, dot, dash or underscore`);
  const main = o.main === undefined ? 'main.js' : String(o.main);
  if (!/^[A-Za-z0-9._-]+\.js$/.test(main)) throw new Error(`"main" must be a .js file name in the plugin folder, not "${main}"`);
  const apiVersion = o.apiVersion === undefined ? 1 : Number(o.apiVersion);
  if (!Number.isInteger(apiVersion) || apiVersion < 1) throw new Error('"apiVersion" must be a positive integer');
  return {
    name,
    main,
    apiVersion,
    ...(typeof o.version === 'string' ? { version: o.version } : {}),
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    ...(typeof o.author === 'string' ? { author: o.author } : {}),
  };
}

/** SHA-256 (hex) of the code; FNV-1a when WebCrypto is unavailable. */
export async function codeHash(code: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const buf = await subtle.digest('SHA-256', new TextEncoder().encode(code));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < code.length; i += 1) {
    h ^= code.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv-${h.toString(16)}`;
}

interface TrustEntry {
  answer: 'yes' | 'no';
  hash: string;
  at: number;
}

function readTrust(storage: StorageLike | null): Record<string, TrustEntry> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(TRUST_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    return v && typeof v === 'object' ? (v as Record<string, TrustEntry>) : {};
  } catch {
    return {};
  }
}

function writeTrust(storage: StorageLike | null, v: Record<string, TrustEntry>): void {
  try {
    storage?.setItem(TRUST_KEY, JSON.stringify(v));
  } catch {
    /* storage unavailable: the answer lasts for the session */
  }
}

const trustKey = (src: PluginSource) => `${src.origin}:${src.path}`;

declare global {
  interface Window {
    __jcadPluginSlots?: Record<string, JcadApi>;
  }
}

function bridgeFromWindow(): PluginsBridge | null {
  if (typeof window === 'undefined') return null;
  const b = (window as unknown as { jcad?: Partial<PluginsBridge> }).jcad;
  return b && typeof b.pluginsList === 'function' && typeof b.pluginsRead === 'function' && typeof b.pluginsDir === 'function' ? (b as PluginsBridge) : null;
}

/**
 * Run plugin code with `jcad` as its only parameter. Resolves when the code (and a promise it
 * returns) has finished; rejects with the plugin's error.
 */
export async function evaluatePlugin(code: string, api: JcadApi, name: string, bridge: PluginsBridge | null): Promise<unknown> {
  const src = `${code}\n//# sourceURL=jcad-plugins/${encodeURIComponent(name)}.js`;
  let fn: ((jcad: JcadApi) => unknown) | null = null;
  try {
    fn = new Function('jcad', src) as (jcad: JcadApi) => unknown;
  } catch (err) {
    // A syntax error is the plugin's; an EvalError means the page's CSP forbids eval.
    if (!(err instanceof EvalError) || !bridge?.pluginsEval) throw err;
  }
  if (fn) return await fn.call(undefined, api);
  const slot = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const slots = (window.__jcadPluginSlots ??= {});
  slots[slot] = api;
  const key = JSON.stringify(slot);
  try {
    return await bridge!.pluginsEval!(
      `(function(){var s=window.__jcadPluginSlots,jcad=s[${key}];delete s[${key}];` +
        `var r=(function(jcad){\n${src}\n}).call(undefined,jcad);` +
        `return r&&typeof r.then==='function'?r.then(function(){return true;}):true;})()`,
    );
  } finally {
    delete slots[slot];
  }
}

function defaultConfirm(editor: Editor): (name: string, path: string) => Promise<boolean> {
  return (name, path) => {
    const message = `Load plugin ${name} from ${path}? Plugins run with full access to your drawings.`;
    if (typeof document === 'undefined') return editor.ui?.confirm('Load plugin', message) ?? Promise.resolve(false);
    return new Promise((resolve) => {
      const m = modal('Load Plugin', 460, 'dark');
      let done = false;
      const finish = (v: boolean) => {
        if (done) return;
        done = true;
        m.close();
        resolve(v);
      };
      m.onClose(() => finish(false));
      m.body.innerHTML = `<div style="font-size:12px;line-height:1.5">Load plugin <b>${esc(name)}</b> from<br><code style="word-break:break-all">${esc(path)}</code>?<br><br>Plugins run with full access to your drawings. Load only plugins you trust. Your answer is remembered until the plugin's code changes.</div>`;
      const yes = button('Load', true);
      const no = button("Don't Load");
      yes.addEventListener('click', () => finish(true));
      no.addEventListener('click', () => finish(false));
      m.footer.append(yes, no);
    });
  };
}

async function defaultPick(accept: string, multiple: boolean): Promise<Array<{ name: string; text: string }>> {
  if (typeof document === 'undefined') return [];
  if (!multiple) {
    const f = await pickTextFile(accept);
    return f ? [f] : [];
  }
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const list = [...(input.files ?? [])];
      input.remove();
      void Promise.all(list.map(async (f) => ({ name: f.name, text: await f.text() }))).then(resolve, () => resolve([]));
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve([]);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** Plugin source from picked files: one .js, or plugin.json plus the .js it names. */
export function sourceFromFiles(files: ReadonlyArray<{ name: string; text: string }>): PluginSource {
  const manifestFile = files.find((f) => /(^|[\\/])plugin\.json$/i.test(f.name) || /\.json$/i.test(f.name));
  const jsFiles = files.filter((f) => /\.js$/i.test(f.name));
  if (manifestFile) {
    const manifest = parseManifest(manifestFile.text);
    const main = jsFiles.find((f) => f.name.split(/[\\/]/).pop() === manifest.main) ?? (jsFiles.length === 1 ? jsFiles[0] : undefined);
    if (!main) throw new Error(`Select plugin.json together with its ${manifest.main}.`);
    return { manifest, code: main.text, path: main.name, origin: 'file' };
  }
  if (jsFiles.length !== 1) throw new Error('Select one .js file (or plugin.json with its main .js file).');
  const f = jsFiles[0]!;
  const base = f.name.split(/[\\/]/).pop()!.replace(/\.js$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64) || 'plugin';
  return { manifest: { name: base, main: f.name, apiVersion: 1 }, code: f.text, path: f.name, origin: 'file' };
}

// ------------------------------------------------------------------ host

export class PluginHost {
  private readonly entries = new Map<string, { info: LoadedPlugin; handle: ApiHandle | null; source: PluginSource }>();
  private readonly bridge: PluginsBridge | null;
  private readonly confirmFn: (name: string, path: string) => Promise<boolean>;
  private readonly storage: StorageLike | null;
  private readonly evaluateFn: (code: string, api: JcadApi, name: string) => Promise<unknown>;
  readonly pickFiles: (accept: string, multiple: boolean) => Promise<Array<{ name: string; text: string }>>;

  constructor(
    readonly editor: Editor,
    opts: PluginHostOptions = {},
  ) {
    this.bridge = opts.bridge === undefined ? bridgeFromWindow() : opts.bridge;
    this.confirmFn = opts.confirm ?? defaultConfirm(editor);
    this.storage = opts.storage === undefined ? (typeof localStorage !== 'undefined' ? localStorage : null) : opts.storage;
    this.evaluateFn = opts.evaluate ?? ((code, api, name) => evaluatePlugin(code, api, name, this.bridge));
    this.pickFiles = opts.pickFiles ?? defaultPick;
  }

  get hasFolder(): boolean {
    return this.bridge !== null;
  }

  async pluginsDir(): Promise<string | null> {
    try {
      return this.bridge ? await this.bridge.pluginsDir() : null;
    } catch {
      return null;
    }
  }

  list(): LoadedPlugin[] {
    return [...this.entries.values()].map((e) => ({ ...e.info, commands: this.commandsOf(e.info.name) }));
  }

  get(name: string): LoadedPlugin | undefined {
    const e = this.entries.get(name.toUpperCase());
    return e ? { ...e.info, commands: this.commandsOf(e.info.name) } : undefined;
  }

  private commandsOf(name: string): string[] {
    const out = new Set<string>();
    const api = this.entries.get(name.toUpperCase())?.handle?.api;
    if (!api) return [];
    for (const c of api.commands.list()) if (c.plugin === name) out.add(c.name);
    return [...out].sort();
  }

  /** Is this code trusted? Asks when unknown or changed; `ask` = false never asks (declined stays declined). */
  private async trusted(src: PluginSource, reask: boolean): Promise<boolean> {
    const hash = await codeHash(src.code);
    const all = readTrust(this.storage);
    const key = trustKey(src);
    const hit = all[key];
    if (hit && hit.hash === hash && (hit.answer === 'yes' || !reask)) return hit.answer === 'yes';
    const yes = await this.confirmFn(src.manifest.name, src.path);
    all[key] = { answer: yes ? 'yes' : 'no', hash, at: Date.now() };
    writeTrust(this.storage, all);
    return yes;
  }

  /** Forget remembered answers (all, or one plugin's by name). Returns how many were removed. */
  forget(name?: string): number {
    const all = readTrust(this.storage);
    let n = 0;
    for (const k of Object.keys(all)) {
      const entry = this.list().find((p) => `${p.origin}:${p.path}` === k);
      if (!name || entry?.name.toUpperCase() === name.toUpperCase() || k.toUpperCase().includes(name.toUpperCase())) {
        delete all[k];
        n += 1;
      }
    }
    writeTrust(this.storage, all);
    return n;
  }

  /**
   * Load (or reload) one plugin. `reask` asks again about a plugin the user declined before
   * (an explicit PLUGINLOAD); automatic loading at start-up keeps a "no".
   */
  async load(src: PluginSource, reask = false): Promise<LoadedPlugin> {
    const name = src.manifest.name;
    const info: LoadedPlugin = {
      name,
      version: src.manifest.version ?? '',
      description: src.manifest.description ?? '',
      path: src.path,
      origin: src.origin,
      ...(src.folder ? { folder: src.folder } : {}),
      status: 'declined',
      commands: [],
    };
    const key = name.toUpperCase();
    if ((src.manifest.apiVersion ?? 1) > API_VERSION) {
      info.status = 'error';
      info.error = `needs plugin API version ${src.manifest.apiVersion}; this JCad Electrical provides version ${API_VERSION}`;
      this.editor.log(`Plugin ${name}: ${info.error}.`);
      this.replace(key, { info, handle: null, source: src });
      return info;
    }
    if (src.code.length > MAX_CODE) {
      info.status = 'error';
      info.error = 'code is larger than 2 MB';
      this.editor.log(`Plugin ${name}: ${info.error}.`);
      this.replace(key, { info, handle: null, source: src });
      return info;
    }
    if (!(await this.trusted(src, reask))) {
      this.editor.log(`Plugin ${name} not loaded (not trusted). PLUGINLOAD${src.folder ? ` ${src.folder}` : ''} asks again.`);
      this.replace(key, { info, handle: null, source: src });
      return info;
    }
    const handle = createApi(this.editor, name);
    this.replace(key, { info, handle, source: src });
    try {
      await this.evaluateFn(src.code, handle.api, name);
      info.status = 'loaded';
      const cmds = this.commandsOf(name);
      this.editor.log(`Plugin ${name}${info.version ? ` ${info.version}` : ''} loaded${cmds.length ? `: ${cmds.join(', ')}` : ''}.`);
    } catch (err) {
      info.status = 'error';
      info.error = err instanceof Error ? err.message : String(err);
      this.editor.log(`[${name}] failed to load: ${info.error}`);
      if (typeof console !== 'undefined') console.error(`[jcad plugin ${name}]`, err);
      // A plugin that failed half-way keeps nothing it registered.
      handle.dispose();
      this.entries.set(key, { info, handle: null, source: src });
    }
    return info;
  }

  private replace(key: string, entry: { info: LoadedPlugin; handle: ApiHandle | null; source: PluginSource }): void {
    this.entries.get(key)?.handle?.dispose();
    this.entries.set(key, entry);
  }

  /** Unload a plugin (its commands, listeners and onUnload hooks). */
  unload(name: string): boolean {
    const key = name.toUpperCase();
    const e = this.entries.get(key);
    if (!e) return false;
    e.handle?.dispose();
    this.entries.delete(key);
    return true;
  }

  /** Read one plugin folder through the bridge. */
  async readFolder(folder: string): Promise<PluginSource> {
    if (!this.bridge) throw new Error('No plugins folder in the browser edition; use PLUGINLOAD to pick the files.');
    const r = await this.bridge.pluginsRead(folder);
    if (!r) throw new Error(`No plugin folder "${folder}".`);
    return { manifest: parseManifest(r.manifest, folder), code: r.code, path: r.path, origin: 'folder', folder };
  }

  /** Load every plugin in userData/plugins (start-up). */
  async loadAll(): Promise<LoadedPlugin[]> {
    if (!this.bridge) return [];
    let folders: Array<{ folder: string; manifest: string | null; error?: string }>;
    try {
      folders = await this.bridge.pluginsList();
    } catch (err) {
      this.editor.log(`Plugins: cannot list the plugins folder (${(err as Error).message}).`);
      return [];
    }
    const out: LoadedPlugin[] = [];
    for (const f of folders) {
      if (f.error || f.manifest === null) {
        this.editor.log(`Plugin folder ${f.folder}: ${f.error ?? 'no plugin.json'}.`);
        continue;
      }
      try {
        out.push(await this.load(await this.readFolder(f.folder)));
      } catch (err) {
        this.editor.log(`Plugin folder ${f.folder}: ${(err as Error).message}.`);
      }
    }
    return out;
  }

  /** Reload one plugin (by name) or all: folder plugins are read again from disk. */
  async reload(name?: string): Promise<LoadedPlugin[]> {
    const targets = name ? [this.entries.get(name.toUpperCase())].filter((x) => !!x) : [...this.entries.values()];
    if (name && targets.length === 0) {
      this.editor.log(`No plugin named ${name}. PLUGINS lists them.`);
      return [];
    }
    const out: LoadedPlugin[] = [];
    for (const t of targets) {
      try {
        const src = t!.source.origin === 'folder' && t!.source.folder ? await this.readFolder(t!.source.folder) : t!.source;
        out.push(await this.load(src, true));
      } catch (err) {
        this.editor.log(`Plugin ${t!.info.name}: ${(err as Error).message}.`);
      }
    }
    if (!name && this.bridge) {
      // New folders that appeared since start-up.
      try {
        for (const f of await this.bridge.pluginsList()) {
          const known = [...this.entries.values()].some((e) => e.source.folder === f.folder);
          if (!known && f.manifest !== null && !f.error) out.push(await this.load(await this.readFolder(f.folder)));
        }
      } catch (err) {
        this.editor.log(`Plugins: ${(err as Error).message}.`);
      }
    }
    return out;
  }

  /**
   * SCRIPTRUN: run a one-off script against the API (after the same confirmation). Commands and
   * listeners it registers stay until the application closes.
   */
  async runScript(fileName: string, code: string): Promise<boolean> {
    const src: PluginSource = { manifest: { name: fileName, apiVersion: 1 }, code, path: fileName, origin: 'script' };
    if (!(await this.trusted(src, true))) {
      this.editor.log(`Script ${fileName} not run.`);
      return false;
    }
    const owner = `script:${fileName.replace(/[^A-Za-z0-9._-]/g, '-')}`;
    const handle = createApi(this.editor, owner);
    try {
      await this.evaluateFn(code, handle.api, owner);
      this.editor.log(`Script ${fileName} finished.`);
      return true;
    } catch (err) {
      this.editor.log(`[${owner}] ${err instanceof Error ? err.message : String(err)}`);
      if (typeof console !== 'undefined') console.error(`[jcad script ${fileName}]`, err);
      return false;
    }
  }
}

const hosts = new WeakMap<Editor, PluginHost>();

/** The editor's plugin host (created with the default bridge / dialogs / storage on first use). */
export function pluginHost(editor: Editor, opts?: PluginHostOptions): PluginHost {
  let h = hosts.get(editor);
  if (!h || opts) {
    h = new PluginHost(editor, opts);
    hosts.set(editor, h);
  }
  return h;
}

// ------------------------------------------------------------------ commands

const registered = new WeakSet<Editor>();

/** PLUGINS, PLUGINLOAD, PLUGINRELOAD and SCRIPTRUN. Idempotent. */
export function registerPluginCommands(editor: Editor): void {
  if (registered.has(editor)) return;
  registered.add(editor);
  const reg = (name: string, aliases: string[], description: string, run: (ed: Editor, arg?: string) => void) => editor.register({ name, aliases, description, run });
  const failed = (ed: Editor) => (err: unknown) => ed.log(`Plugins: ${err instanceof Error ? err.message : String(err)}`);

  reg('PLUGINS', ['PLUGINLIST'], 'List plugins and the plugins folder [Unload <name> | Forget [<name>]]', (ed, arg) => {
    const host = pluginHost(ed);
    const [opt, ...rest] = (arg ?? '').trim().split(/\s+/).filter(Boolean);
    const target = rest.join(' ');
    if (opt && /^u(nload)?$/i.test(opt)) {
      ed.log(target && host.unload(target) ? `Plugin ${target} unloaded.` : `No plugin named ${target || '(none given)'}.`);
      return;
    }
    if (opt && /^f(orget)?$/i.test(opt)) {
      const n = host.forget(target || undefined);
      ed.log(`${n} remembered plugin answer(s) forgotten; those plugins are asked about again.`);
      return;
    }
    void (async () => {
      const dir = await host.pluginsDir();
      const list = host.list();
      ed.log(`Plugin API version ${API_VERSION}.`);
      ed.log(dir ? `Plugins folder: ${dir}` : 'Browser edition: load plugins with PLUGINLOAD (they last for this session).');
      if (list.length === 0) ed.log('No plugins loaded.');
      for (const p of list)
        ed.log(`  ${p.name.padEnd(20)} ${(p.version || '-').padEnd(8)} ${p.status.padEnd(8)} ${p.origin === 'folder' ? p.folder : p.path}${p.commands.length ? `  [${p.commands.join(', ')}]` : ''}${p.error ? `  (${p.error})` : ''}`);
    })().catch(failed(ed));
  });

  reg('PLUGINLOAD', ['LOADPLUGIN'], 'Load a plugin: a folder name from the plugins folder, or pick plugin files', (ed, arg) => {
    const host = pluginHost(ed);
    void (async () => {
      const name = (arg ?? '').trim();
      if (name && host.hasFolder) {
        await host.load(await host.readFolder(name), true);
        return;
      }
      const files = await host.pickFiles('.js,.json', true);
      if (files.length === 0) return;
      await host.load(sourceFromFiles(files), true);
    })().catch(failed(ed));
  });

  reg('PLUGINRELOAD', [], 'Reload one plugin (by name) or all plugins', (ed, arg) => {
    void pluginHost(ed)
      .reload((arg ?? '').trim() || undefined)
      .then((r) => ed.log(`${r.filter((p) => p.status === 'loaded').length} plugin(s) reloaded.`))
      .catch(failed(ed));
  });

  reg('SCRIPTRUN', ['JSRUN', 'RUNSCRIPT'], 'Run a JavaScript file against the plugin API (like SCRIPT, in JavaScript)', (ed) => {
    const host = pluginHost(ed);
    void (async () => {
      const [f] = await host.pickFiles('.js', false);
      if (!f) return;
      await host.runScript(f.name, f.text);
    })().catch(failed(ed));
  });
}

/**
 * Start-up: register the plugin commands and load every plugin from userData/plugins
 * (desktop). Resolves with what was loaded; never rejects.
 */
export async function loadPlugins(editor: Editor): Promise<LoadedPlugin[]> {
  registerPluginCommands(editor);
  try {
    return await pluginHost(editor).loadAll();
  } catch (err) {
    editor.log(`Plugins: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
