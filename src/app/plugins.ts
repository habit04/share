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
 * Plugins run in the application page (see docs/PLUGIN-API.md, "Security"): they are isolated
 * from each other only as far as errors go. The one exception is a plugin whose manifest opts
 * into P25 isolation (`apiVersion: 2` + `isolation: "worker"` + `capabilities`, admitted as
 * PROPOSAL-P25 / LEDGER L-011): it runs in the isolated realm in ./plugin-isolation with only
 * its declared capabilities, and fails closed — never in the page — when no realm is available. A plugin that throws while loading, whose load
 * promise rejects, that does not finish loading within `loadTimeoutMs`, or whose trust check
 * fails is reported on the command line with its name and marked as failed; loading carries on
 * with the next plugin. Errors later on (commands, event listeners, rejected promises, timers
 * and other callbacks whose stack points into the plugin's code) are reported the same way.
 */
import type { Editor } from './editor';
import { API_VERSION, createApi, pickTextFile, pluginErrorMessage, type ApiHandle, type JcadApi } from './api';
import { parseCapabilitySet } from './plugin-isolation/capabilities';
import { IsolatedPluginSession, type RealmTransport } from './plugin-isolation/host';
import { browserWorkerTransport } from './plugin-isolation/browser-transport';
import { modal, button } from '../ui/dialogkit';
import { esc } from '../ui/dom';
import { ensureFileLimit, MAX_PLUGIN_FILE_BYTES, MAX_PROJECT_FILE_BYTES } from '../io/file-limits';

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
  /**
   * P25 isolation opt-in (PROPOSAL-P25, admitted LEDGER L-011): 'worker' runs
   * the plugin in the isolated realm (API v2) instead of the trusted page.
   * Absent (or 'page') is exactly the legacy v1 behaviour.
   */
  isolation?: 'page' | 'worker';
  /** Declared capabilities for an isolated ('worker') plugin: required there, forbidden on the page path. */
  capabilities?: string[];
}

/**
 * What the trust prompt is told about an isolated ('worker') plugin
 * (L-011 C3): that it runs isolated, and the capability set it declared.
 * Legacy v1 plugins get no details object — their prompt is unchanged.
 */
export interface PluginTrustDetails {
  isolation: 'worker';
  capabilities: string[];
}

export interface PluginSource {
  manifest: PluginManifest;
  code: string;
  /**
   * The entry's EXACT FILE BYTES when the source was read from disk
   * (folder reads, R2). Hashing (trust + the snapshot's approved-entry
   * verification) digests these bytes, never a decode/re-encode of
   * `code`. `code` itself — the lossy UTF-8 decode — remains what v1
   * evaluates, unchanged.
   */
  codeBytes?: Uint8Array;
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
  pluginsRead(folder: string): Promise<{ manifest: string; code: string; codeBytes?: Uint8Array; path: string } | null>;
  /** Run a script in the page (used when CSP forbids `new Function`). */
  pluginsEval?(source: string): Promise<unknown>;
  /**
   * CSP hosting (AMENDMENT-P25-CSP-HOSTING Part A2; Fable F1; W-1): ask
   * the main process to serve this (already trusted) plugin folder's
   * package to its isolated realm. Main vets the package from its own
   * record — the renderer passes the folder NAME, never a path —
   * snapshots it and returns the session's served URLs plus the
   * snapshot's MANIFEST hash. `approvedEntryHash` is the SHA-256 of
   * the entry code this host's trust flow approved (the codeHash of
   * the loaded source); `approvedManifestHash`, when the trust record
   * remembers one, is the manifest hash of the whole package that
   * approval covered. Main verifies its snapshot against BOTH and
   * refuses a changed entry OR a changed dependency with
   * ERR_PLUGIN_CHANGED (W-1: approval binds the whole snapshot).
   * Absent in the plain browser.
   */
  pluginsServeIsolatedPackage?(folder: string, approvedEntryHash?: string, approvedManifestHash?: string): Promise<{ sessionId: string; baseUrl: string; entryUrl: string; manifestHash?: string }>;
  /** Drop a plugin-realm serving registration (the session was disposed). */
  pluginsUnserveIsolatedPackage?(sessionId: string): Promise<unknown>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PluginHostOptions {
  bridge?: PluginsBridge | null;
  /** Ask the user (default: a modal dialog). `details` is set only for isolated ('worker') plugins. */
  confirm?(name: string, path: string, details?: PluginTrustDetails): Promise<boolean>;
  /**
   * Create the transport for an isolated ('worker') plugin's realm (default:
   * a platform Worker where one exists, else none — an isolated load then
   * fails closed rather than running in the page, L-011 C2).
   */
  realmTransport?: () => RealmTransport | null;
  /** Where trust answers are kept (default localStorage). */
  storage?: StorageLike | null;
  /** Run plugin code (default: `new Function('jcad', code)`, falling back to the bridge). */
  evaluate?(code: string, api: JcadApi, name: string): Promise<unknown>;
  /** File picker for PLUGINLOAD / SCRIPTRUN (default: an <input type=file>). */
  pickFiles?(accept: string, multiple: boolean): Promise<Array<{ name: string; text: string }>>;
  /** How long a plugin's load may take before it is marked failed and the next one loads (default 30 s). */
  loadTimeoutMs?: number;
}

/** Default limit for a plugin's load (its top-level code and the promise it returns). */
export const PLUGIN_LOAD_TIMEOUT_MS = 30_000;

/** Plugin name from a stack trace or script URL that points into plugin code (`jcad-plugins/<name>.js`). */
export function pluginNameFromStack(text: string | undefined | null): string | null {
  // Greedy up to the last ".js" before the line number: the encoded name may itself end in ".js".
  const m = /jcad-plugins\/([^/\s:)]+)\.js/.exec(String(text ?? ''));
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/** Resolve `p`, or reject after `ms` with a message naming the plugin. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (!(ms > 0) || !Number.isFinite(ms)) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} did not finish within ${Math.round(ms / 1000)} s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export const TRUST_KEY = 'jcad.plugins.trusted';
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_CODE = 2 * 1024 * 1024;

/**
 * The jcad.js shim body — byte-identical to the one the main process
 * serves for plugin-realm packages (electron/renderer-origin.cjs
 * PLUGIN_REALM_JCAD_SHIM, byte-pinned in tests/plugin-realm-serving.test.ts).
 * The blob: fallback in isolatedModuleUrl mints the same shim as a blob
 * module so a module-authored entry's `import jcad from './jcad.js'`
 * resolves in the plain browser exactly as it does in the packaged realm.
 */
const JCAD_SHIM_MODULE = 'export default globalThis[Symbol.for("jcad.isolated.jcad")];';

// ------------------------------------------------------------------ helpers

/**
 * The admitted isolated-manifest semantics (PROPOSAL-P25, LEDGER L-011),
 * shared by parseManifest and PluginHost.load — load also sees programmatic
 * sources that never went through a parser, and their refusal must be just
 * as atomic. Returns the refusal message, or null when valid. A manifest
 * declaring neither field is a legacy v1 manifest and always valid here.
 */
function isolatedManifestError(m: { apiVersion?: number; isolation?: string; capabilities?: unknown }): string | null {
  if (m.isolation !== undefined && m.isolation !== 'page' && m.isolation !== 'worker') {
    return `"isolation" must be "page" or "worker", not ${JSON.stringify(m.isolation)}`;
  }
  try {
    parseCapabilitySet(m.capabilities);
  } catch (err) {
    return (err as Error).message;
  }
  if (m.isolation === 'worker') {
    if (m.apiVersion !== 2) return 'an isolated ("worker") plugin must declare "apiVersion": 2 (API v2 is the asynchronous realm API)';
    if (m.capabilities === undefined) return 'an isolated ("worker") plugin must declare "capabilities" (use [] for a plugin that only loads)';
  } else if (m.capabilities !== undefined) {
    return '"capabilities" requires "isolation": "worker" (the trusted page path enforces no capabilities; declaring them there would be misleading)';
  }
  return null;
}

/**
 * The default realm transport: a platform Worker where one exists, else
 * none. There is deliberately no fallback — an isolated plugin whose realm
 * cannot be created fails closed (load ERROR) rather than running in the
 * page (L-011 C2). In the packaged renderer the realm loads the plugin's
 * entry as a module served by the main process under the worker CSP
 * (AMENDMENT-P25-CSP-HOSTING); a realm that never finishes loading still
 * fails closed on the session's load timeout.
 */
function defaultRealmTransport(): RealmTransport | null {
  if (typeof Worker === 'undefined') return null;
  try {
    return browserWorkerTransport();
  } catch {
    return null;
  }
}

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
  const isoError = isolatedManifestError({ apiVersion, isolation: o.isolation as string | undefined, capabilities: o.capabilities });
  if (isoError) throw new Error(isoError);
  const isolation = o.isolation as PluginManifest['isolation'];
  return {
    name,
    main,
    apiVersion,
    ...(isolation !== undefined ? { isolation } : {}),
    ...(o.capabilities !== undefined ? { capabilities: [...parseCapabilitySet(o.capabilities)] } : {}),
    ...(typeof o.version === 'string' ? { version: o.version } : {}),
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    ...(typeof o.author === 'string' ? { author: o.author } : {}),
  };
}

/** SHA-256 (hex) of the code; FNV-1a ("fnv-...") when WebCrypto is unavailable, which never remembers trust. */
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

/**
 * SHA-256 (hex) of EXACT BYTES; FNV-1a over the bytes when WebCrypto is
 * unavailable, which never remembers trust. The R2 canonical form: for a
 * source read from disk, both the trust/approval hash and the hash the
 * snapshot verifies against are taken over the file's raw bytes — never
 * over a decode/re-encode round trip, which is lossy for non-UTF-8
 * bytes and made main's raw-byte hash unmatchable (ERR_PLUGIN_CHANGED
 * on an unchanged file). For UTF-8-clean files the digest equals
 * `codeHash` of the decoded text, so nothing else changes.
 */
export async function codeHashBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const buf = await subtle.digest('SHA-256', bytes as BufferSource);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv-${h.toString(16)}`;
}

/** A source's approval hash: its raw file bytes when it has them (folder reads), else its text. */
async function sourceHash(src: PluginSource): Promise<string> {
  return src.codeBytes ? codeHashBytes(src.codeBytes) : codeHash(src.code);
}

interface TrustEntry {
  answer: 'yes' | 'no';
  hash: string;
  /**
   * W-1: for a folder plugin served to the isolated realm, the MANIFEST
   * hash of the whole package the remembered answer approved (over the
   * sorted (path, sha256) list of every snapshotted file, entry
   * included), as reported by main at the first served load under this
   * approval. Absent until then — and absent for page plugins, whose
   * approval binds the entry alone (they execute no served graph).
   */
  manifestHash?: string;
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

/**
 * The serve path's trust failure (main refusing a package that changed
 * since approval): main raises it with the ERR_PLUGIN_CHANGED code, and
 * its IPC handler also names the token in the message — the only part
 * of an error that always survives ipcRenderer.invoke — so both forms
 * are recognised here.
 */
function isPluginChangedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown };
  return e.code === 'ERR_PLUGIN_CHANGED' || (typeof e.message === 'string' && e.message.includes('ERR_PLUGIN_CHANGED'));
}

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
    if (!(err instanceof EvalError)) throw err;
    if (!bridge?.pluginsEval) throw new Error(`this page's Content-Security-Policy does not allow running plugin code and no desktop bridge is available (${err.message.trim()})`);
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

function defaultConfirm(editor: Editor): (name: string, path: string, details?: PluginTrustDetails) => Promise<boolean> {
  return (name, path, details) => {
    // L-011 C3: a worker plugin's prompt presents its isolated status and
    // declared capability set instead of the full-access warning. With no
    // details (every legacy v1 plugin) both texts are byte-identical to v1.
    const risk = details
      ? `It runs isolated in a separate realm, limited to these declared capabilities: ${details.capabilities.length ? details.capabilities.join(', ') : '(none)'}.`
      : 'Plugins run with full access to your drawings.';
    const message = `Load plugin ${name} from ${path}? ${risk}`;
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
      const riskHtml = details
        ? `This plugin runs <b>isolated</b> in a separate realm, limited to its declared capabilities:<br><code style="word-break:break-all">${esc(details.capabilities.join(', ') || '(none)')}</code>.`
        : 'Plugins run with full access to your drawings.';
      m.body.innerHTML = `<div style="font-size:12px;line-height:1.5">Load plugin <b>${esc(name)}</b> from<br><code style="word-break:break-all">${esc(path)}</code>?<br><br>${riskHtml} Load only plugins you trust. Your answer is remembered until the plugin's code changes.</div>`;
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
    const f = await pickTextFile(accept, MAX_PLUGIN_FILE_BYTES);
    return f ? [f] : [];
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = true;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const list = [...(input.files ?? [])];
      input.remove();
      try {
        if (list.length > 64 || list.reduce((sum, file) => sum + file.size, 0) > MAX_PROJECT_FILE_BYTES) throw new Error('Select at most 64 plugin files totaling no more than 8 MiB.');
        for (const file of list) ensureFileLimit(file, /\.json$/i.test(file.name) ? 64 * 1024 : MAX_PLUGIN_FILE_BYTES);
      } catch (error) { reject(error); return; }
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

/** The most recent PluginHost of each editor (the one uncaught plugin errors are reported to). */
const currentHost = new WeakMap<Editor, PluginHost>();

/**
 * Errors that escape a plugin's own callbacks (a timer, a DOM listener, an unhandled promise)
 * reach the window. When the stack points into plugin code (`jcad-plugins/<name>.js`) they are
 * reported with the plugin's name, like errors in its commands, instead of surfacing as anonymous
 * page errors. Installed once per editor.
 */
function watchUncaught(editor: Editor): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('error', (ev: ErrorEvent) => {
    const name = pluginNameFromStack(ev.filename) ?? pluginNameFromStack((ev.error as Error | undefined)?.stack);
    if (!name) return;
    ev.preventDefault();
    currentHost.get(editor)?.reportUncaught(name, ev.error ?? ev.message);
  });
  window.addEventListener('unhandledrejection', (ev: PromiseRejectionEvent) => {
    const name = pluginNameFromStack((ev.reason as Error | undefined)?.stack);
    if (!name) return;
    ev.preventDefault();
    currentHost.get(editor)?.reportUncaught(name, ev.reason);
  });
}

/** One loaded (or loading) plugin. A worker plugin's `handle` is its session's API handle. */
interface HostEntry {
  info: LoadedPlugin;
  handle: ApiHandle | null;
  /** The isolated-realm session of a worker plugin; null on the page path. */
  session: IsolatedPluginSession | null;
  source: PluginSource;
}

/** Dispose an entry exactly once over its two resources: a session's dispose() also disposes its API handle. */
function disposeEntry(entry: HostEntry): void {
  if (entry.session) entry.session.dispose();
  else entry.handle?.dispose();
}

export class PluginHost {
  private readonly entries = new Map<string, HostEntry>();
  private readonly bridge: PluginsBridge | null;
  private readonly confirmFn: (name: string, path: string, details?: PluginTrustDetails) => Promise<boolean>;
  private readonly storage: StorageLike | null;
  private readonly evaluateFn: (code: string, api: JcadApi, name: string) => Promise<unknown>;
  private readonly realmTransportFactory: (() => RealmTransport | null) | null;
  private readonly loadTimeoutMs: number;
  readonly pickFiles: (accept: string, multiple: boolean) => Promise<Array<{ name: string; text: string }>>;

  constructor(
    readonly editor: Editor,
    opts: PluginHostOptions = {},
  ) {
    this.bridge = opts.bridge === undefined ? bridgeFromWindow() : opts.bridge;
    this.confirmFn = opts.confirm ?? defaultConfirm(editor);
    this.storage = opts.storage === undefined ? (typeof localStorage !== 'undefined' ? localStorage : null) : opts.storage;
    this.evaluateFn = opts.evaluate ?? ((code, api, name) => evaluatePlugin(code, api, name, this.bridge));
    this.realmTransportFactory = opts.realmTransport ?? null;
    this.pickFiles = opts.pickFiles ?? defaultPick;
    this.loadTimeoutMs = opts.loadTimeoutMs ?? PLUGIN_LOAD_TIMEOUT_MS;
    const first = !currentHost.has(editor);
    currentHost.set(editor, this);
    if (first) watchUncaught(editor);
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

  /** Report an error raised outside the plugin's API callbacks (see watchUncaught). */
  reportUncaught(name: string, err: unknown): void {
    const message = pluginErrorMessage(err);
    this.editor.log(`[${name}] ${message}`);
    const e = this.entries.get(name.toUpperCase());
    if (e && e.info.status === 'loaded') e.info.error = message;
    if (typeof console !== 'undefined') console.warn(`[jcad plugin ${name}]`, err);
  }

  /** Is this code trusted? Asks when unknown or changed; `ask` = false never asks (declined stays declined). */
  private async trusted(src: PluginSource, reask: boolean, current: () => boolean = () => true): Promise<boolean> {
    const hash = await sourceHash(src);
    if (!current()) return false;
    const all = readTrust(this.storage);
    const key = trustKey(src);
    const hit = all[key];
    // Only a SHA-256 digest remembers an answer (security review E-10): with the FNV-1a fallback
    // (no WebCrypto) a changed plugin could keep a remembered "yes", so it is asked every run.
    const strongHash = /^[0-9a-f]{64}$/.test(hash);
    if (strongHash && hit && hit.hash === hash && (hit.answer === 'yes' || !reask)) return hit.answer === 'yes';
    // C3: the trust decision for a worker plugin is told its declared
    // capabilities + isolated status; a legacy plugin's call is unchanged.
    const details: PluginTrustDetails | undefined =
      src.manifest.isolation === 'worker' ? { isolation: 'worker', capabilities: [...(src.manifest.capabilities ?? [])] } : undefined;
    const yes = await this.confirmFn(src.manifest.name, src.path, details);
    if (!current()) return false;
    if (strongHash) all[key] = { answer: yes ? 'yes' : 'no', hash, at: Date.now() };
    else delete all[key];
    writeTrust(this.storage, all);
    return yes;
  }

  /** Drop the remembered trust answer for one source, so its next load asks again. */
  private forgetSource(src: PluginSource): void {
    const all = readTrust(this.storage);
    const key = trustKey(src);
    if (key in all) {
      delete all[key];
      writeTrust(this.storage, all);
    }
  }

  /**
   * W-1: remember the manifest hash main reported for a served package,
   * bound to the approval that serve ran under. Only a remembered "yes"
   * for THIS entry hash gains a manifest (the E-10 discipline: an
   * unremembered approval — the FNV fallback, a declined answer — binds
   * nothing beyond itself).
   */
  private rememberManifestHash(src: PluginSource, approvedEntryHash: string, manifestHash: string): void {
    if (!/^[0-9a-f]{64}$/.test(manifestHash)) return;
    const all = readTrust(this.storage);
    const key = trustKey(src);
    const hit = all[key];
    if (!hit || hit.answer !== 'yes' || hit.hash !== approvedEntryHash) return;
    if (hit.manifestHash !== manifestHash) {
      all[key] = { ...hit, manifestHash };
      writeTrust(this.storage, all);
    }
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
    // Bind confirmation and execution to the same source, even if a caller
    // changes its input object while hashing/confirmation is outstanding.
    src = { ...src, manifest: { ...src.manifest } };
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
    const entry: HostEntry = { info, handle: null, session: null, source: src };
    this.replace(key, entry);
    const current = () => this.entries.get(key) === entry;
    const superseded = () => {
      info.status = 'error';
      info.error = 'Loading was superseded or the plugin was unloaded.';
      return info;
    };
    if (!current()) return superseded();
    // Isolated-manifest semantics are enforced here too, not only in
    // parseManifest: a programmatic source can carry fields no parser
    // checked, and refusal must be atomic — before the version ceiling,
    // trust, transport creation, or any execution (L-011 C2).
    if (src.manifest.isolation !== undefined || src.manifest.capabilities !== undefined) {
      const isoError = isolatedManifestError(src.manifest);
      if (isoError) {
        info.status = 'error';
        info.error = isoError;
        this.editor.log(`Plugin ${name}: ${isoError}.`);
        return info;
      }
    }
    const isolated = src.manifest.isolation === 'worker';
    // A valid worker manifest declares apiVersion 2 by definition; the v1
    // ceiling below applies to the page path only.
    if (!isolated && (src.manifest.apiVersion ?? 1) > API_VERSION) {
      info.status = 'error';
      info.error = `needs plugin API version ${src.manifest.apiVersion}; this JCad Electrical provides version ${API_VERSION}`;
      this.editor.log(`Plugin ${name}: ${info.error}.`);
      return info;
    }
    if (src.code.length > MAX_CODE) {
      info.status = 'error';
      info.error = 'code is larger than 2 MB';
      this.editor.log(`Plugin ${name}: ${info.error}.`);
      return info;
    }
    let trusted: boolean;
    try {
      trusted = await this.trusted(src, reask, current);
    } catch (err) {
      if (!current()) return superseded();
      info.status = 'error';
      info.error = `could not confirm the plugin (${pluginErrorMessage(err)})`;
      this.editor.log(`Plugin ${name}: ${info.error}.`);
      return info;
    }
    if (!current()) return superseded();
    if (!trusted) {
      this.editor.log(`Plugin ${name} not loaded (not trusted). PLUGINLOAD${src.folder ? ` ${src.folder}` : ''} asks again.`);
      return info;
    }
    if (isolated) return this.loadIsolated(src, entry, current, superseded);
    const handle = createApi(this.editor, name);
    entry.handle = handle;
    try {
      // A load that never settles must not hold up the other plugins.
      await withTimeout(Promise.resolve(this.evaluateFn(src.code, handle.api, name)), this.loadTimeoutMs, 'loading');
      if (!current()) { handle.dispose(); return superseded(); }
      info.status = 'loaded';
      const cmds = this.commandsOf(name);
      this.editor.log(`Plugin ${name}${info.version ? ` ${info.version}` : ''} loaded${cmds.length ? `: ${cmds.join(', ')}` : ''}.`);
    } catch (err) {
      if (!current()) { handle.dispose(); return superseded(); }
      info.status = 'error';
      info.error = pluginErrorMessage(err);
      // Revoke before diagnostics; even a failing page logger must not retain
      // commands or listeners from a partially loaded plugin.
      entry.handle = null;
      handle.dispose();
      this.editor.log(`[${name}] failed to load: ${info.error}`);
      if (typeof console !== 'undefined') console.error(`[jcad plugin ${name}]`, err);
    }
    return info;
  }

  /**
   * Load a trusted worker plugin into its isolated realm. Fail-closed
   * throughout (L-011 C2): no realm transport, a realm that never finishes
   * loading, or a realm-side failure is a load ERROR — the code never runs
   * in the page as a fallback.
   */
  private async loadIsolated(
    src: PluginSource,
    entry: HostEntry,
    current: () => boolean,
    superseded: () => LoadedPlugin,
  ): Promise<LoadedPlugin> {
    const { info } = entry;
    const name = src.manifest.name;
    let transport: RealmTransport | null = null;
    try {
      transport = this.realmTransportFactory ? this.realmTransportFactory() : defaultRealmTransport();
    } catch {
      transport = null;
    }
    if (!transport) {
      info.status = 'error';
      info.error = 'plugin declares "isolation": "worker" but no isolated realm transport is available in this environment; refusing to run it in the page';
      this.editor.log(`Plugin ${name}: ${info.error}.`);
      return info;
    }
    // Part B3 (AMENDMENT-P25-CSP-HOSTING): the realm loads its entry as a
    // module — the host obtains the module URL before the session exists,
    // and no body string ever crosses the handshake. Nothing available
    // means the load fails closed (L-011 C2), exactly like a missing
    // transport.
    let plan: { moduleUrl: string; servedSessionId?: string; revoke?: () => void } | null = null;
    let refusal: string | null = null;
    try {
      const resolved = await this.isolatedModuleUrl(src, transport, current);
      if (resolved && 'refusal' in resolved) refusal = resolved.refusal;
      else plan = resolved;
    } catch {
      plan = null;
    }
    // PR #38 [P2]: an unload that landed during the module-URL await
    // (the serve inside it already revoked the session) supersedes the
    // load BEFORE any session is constructed.
    if (!current()) {
      transport.terminate();
      return superseded();
    }
    if (!plan) {
      transport.terminate();
      info.status = 'error';
      info.error = refusal ?? 'plugin declares "isolation": "worker" but its entry cannot be provided to the realm as a module in this environment; refusing to run it in the page';
      this.editor.log(`Plugin ${name}: ${info.error}.`);
      return info;
    }
    // Condition (c): a served registration lives exactly as long as the
    // session — the session's single dispose choke point unserves it on
    // unload, supersede, failed load and timeout alike.
    const servedSessionId = plan.servedSessionId;
    const unserve =
      servedSessionId && this.bridge?.pluginsUnserveIsolatedPackage
        ? () => {
            void Promise.resolve(this.bridge!.pluginsUnserveIsolatedPackage!(servedSessionId)).catch(() => undefined);
          }
        : null;
    let session: IsolatedPluginSession;
    try {
      session = new IsolatedPluginSession(this.editor, {
        owner: name,
        capabilities: src.manifest.capabilities ?? [],
        transport,
        // The host's own load budget (production default 30 s); the larger
        // budgets in the test harnesses are harness-only and never wired in.
        loadTimeoutMs: this.loadTimeoutMs,
        ...(unserve ? { onDisposed: unserve } : {}),
      });
    } catch (err) {
      plan.revoke?.();
      unserve?.();
      info.status = 'error';
      info.error = pluginErrorMessage(err);
      this.editor.log(`Plugin ${name}: ${info.error}.`);
      return info;
    }
    entry.session = session;
    entry.handle = session.apiHandle;
    try {
      await session.loadModule(plan.moduleUrl);
      if (!current()) {
        session.dispose();
        return superseded();
      }
      info.status = 'loaded';
      const cmds = this.commandsOf(name);
      this.editor.log(`Plugin ${name}${info.version ? ` ${info.version}` : ''} loaded (isolated)${cmds.length ? `: ${cmds.join(', ')}` : ''}.`);
    } catch (err) {
      if (!current()) {
        session.dispose();
        return superseded();
      }
      info.status = 'error';
      info.error = pluginErrorMessage(err);
      // Revoke before diagnostics, exactly like the page path: no commands,
      // listeners or realm survive a failed load.
      entry.session = null;
      entry.handle = null;
      session.dispose();
      this.editor.log(`[${name}] failed to load: ${info.error}`);
      if (typeof console !== 'undefined') console.error(`[jcad plugin ${name}]`, err);
    } finally {
      // A blob: entry/shim pair is revoked once the load has settled — the
      // realm has imported them by then (or never will).
      plan.revoke?.();
    }
    return info;
  }

  /**
   * Resolve how this isolated load's entry reaches the realm as a module
   * (Part B3), in order:
   *  1. PACKAGED: the bridge serves the plugin folder's main-vetted
   *     package and the realm loads the served entryUrl — the only URL
   *     the packaged transport ever selects (condition C-J1: it never
   *     selects a string path, and no blob is minted here);
   *  1b. PACKAGED, NOT FROM THE FOLDER (Fable F2): where a serving
   *     bridge exists, the realm worker is served under the worker CSP,
   *     whose `script-src 'self'` refuses blob: imports — a picked-file
   *     or script plugin would fall through to the blob branch below
   *     and fail opaquely at the load timeout. The served transport is
   *     the designed packaged path and it serves installed folder
   *     packages only, so the load is refused here, explicitly, at
   *     selection time ({ refusal }).
   *  2. a transport-provided module URL (the Node test harness's file://
   *     modules, Part B4);
   *  3. PLAIN BROWSER / DEV: blob: modules minted from the entry text —
   *     valid there because no worker CSP is served; under the packaged
   *     worker CSP `blob:` is refused by `script-src 'self'`, and the
   *     packaged path above never selects it. The entry text is
   *     module-authored, so its `./jcad.js` specifier is rewritten to a
   *     shim blob carrying the identical one-line shim body.
   * Returns null when none is available: the load then fails closed.
   */
  private async isolatedModuleUrl(
    src: PluginSource,
    transport: RealmTransport,
    current?: () => boolean,
  ): Promise<{ moduleUrl: string; servedSessionId?: string; revoke?: () => void } | { refusal: string } | null> {
    if (src.origin === 'folder' && src.folder && this.bridge?.pluginsServeIsolatedPackage) {
      // Fable F1: main snapshots the package at registration and verifies
      // the snapshot's entry against the hash this load's trust flow
      // approved — `sourceHash`, the same digest `trusted()` computed and
      // the user confirmed for this source: the entry's raw file bytes
      // when the source carries them (R2), else its text.
      // W-1: the approval binds the WHOLE snapshot, not just the entry —
      // when the trust record remembers a manifest hash under this very
      // approval, it travels with the entry hash and main verifies the
      // whole graph against it; the manifest main reports back from a
      // successful serve is remembered for the next load.
      const approvedEntryHash = await sourceHash(src);
      const remembered = readTrust(this.storage)[trustKey(src)];
      const approvedManifestHash =
        remembered && remembered.answer === 'yes' && remembered.hash === approvedEntryHash && typeof remembered.manifestHash === 'string'
          ? remembered.manifestHash
          : undefined;
      let served: { sessionId: string; baseUrl: string; entryUrl: string; manifestHash?: string } | null;
      try {
        served = await this.bridge.pluginsServeIsolatedPackage(src.folder, approvedEntryHash, approvedManifestHash);
      } catch (err) {
        if (!isPluginChangedError(err)) throw err;
        // The package on disk no longer matches the approval — a changed
        // entry, or (W-1) a changed dependency under an unchanged entry.
        // Forget the remembered answer so the next load asks again, and
        // refuse THIS load (fail-closed, L-011 C2).
        this.forgetSource(src);
        return {
          refusal:
            'plugin declares "isolation": "worker" but its package changed since it was approved (the entry or a file in its module graph differs from the approved package); refusing to run it — reload the plugin to approve the new package',
        };
      }
      // PR #38 [P2] (Codex review, 2026-10-22): recheck the load
      // generation after the serve await. If the plugin was unloaded
      // (or superseded) while main snapshotted and registered the
      // package, the served session is revoked here and the load
      // abandons — the plugin is never constructed or started on a
      // session whose owner has already gone.
      if (current && !current()) {
        if (typeof served?.sessionId === 'string' && served.sessionId && this.bridge?.pluginsUnserveIsolatedPackage) {
          void Promise.resolve(this.bridge.pluginsUnserveIsolatedPackage(served.sessionId)).catch(() => undefined);
        }
        return null;
      }
      if (!served || typeof served.entryUrl !== 'string' || !served.entryUrl) return null;
      if (typeof served.manifestHash === 'string') this.rememberManifestHash(src, approvedEntryHash, served.manifestHash);
      return {
        moduleUrl: served.entryUrl,
        ...(typeof served.sessionId === 'string' && served.sessionId ? { servedSessionId: served.sessionId } : {}),
      };
    }
    if (this.bridge?.pluginsServeIsolatedPackage && src.origin !== 'folder') {
      return {
        refusal:
          'plugin declares "isolation": "worker" but it was not loaded from the plugins folder; in the desktop app an isolated plugin must be installed in the plugins folder so the app can serve its package to the isolated realm — a picked-file or script plugin cannot be served; refusing to run it in the page',
      };
    }
    if (typeof transport.moduleUrlFor === 'function') {
      const url = transport.moduleUrlFor(src.code);
      return url ? { moduleUrl: url } : null;
    }
    if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const shimUrl = URL.createObjectURL(new Blob([JCAD_SHIM_MODULE], { type: 'text/javascript' }));
      try {
        const text = src.code.split("'./jcad.js'").join(`'${shimUrl}'`).split('"./jcad.js"').join(`"${shimUrl}"`);
        const entryUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }));
        return {
          moduleUrl: entryUrl,
          revoke: () => {
            URL.revokeObjectURL(entryUrl);
            URL.revokeObjectURL(shimUrl);
          },
        };
      } catch {
        URL.revokeObjectURL(shimUrl);
        return null;
      }
    }
    return null;
  }

  private replace(key: string, entry: HostEntry): void {
    const previous = this.entries.get(key);
    this.entries.set(key, entry);
    if (previous) disposeEntry(previous);
  }

  /** Unload a plugin (its commands, listeners and onUnload hooks). */
  unload(name: string): boolean {
    const key = name.toUpperCase();
    const e = this.entries.get(key);
    if (!e) return false;
    this.entries.delete(key);
    disposeEntry(e);
    return true;
  }

  /** Read one plugin folder through the bridge. */
  async readFolder(folder: string): Promise<PluginSource> {
    if (!this.bridge) throw new Error('No plugins folder in the browser edition; use PLUGINLOAD to pick the files.');
    const r = await this.bridge.pluginsRead(folder);
    if (!r) throw new Error(`No plugin folder "${folder}".`);
    return { manifest: parseManifest(r.manifest, folder), code: r.code, ...(r.codeBytes ? { codeBytes: r.codeBytes } : {}), path: r.path, origin: 'folder', folder };
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
        this.editor.log(`Plugin folder ${f.folder}: ${err instanceof Error ? err.message : String(err)}.`);
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
        if (this.entries.get(t!.info.name.toUpperCase()) !== t) continue;
        out.push(await this.load(src, true));
      } catch (err) {
        this.editor.log(`Plugin ${t!.info.name}: ${(err as Error).message}.`);
      }
    }
    if (!name && this.bridge) {
      // New folders that appeared since start-up; one bad folder does not stop the others.
      let folders: Array<{ folder: string; manifest: string | null; error?: string }> = [];
      try {
        folders = await this.bridge.pluginsList();
      } catch (err) {
        this.editor.log(`Plugins: ${err instanceof Error ? err.message : String(err)}.`);
      }
      for (const f of folders) {
        const known = [...this.entries.values()].some((e) => e.source.folder === f.folder);
        if (known || f.manifest === null || f.error) continue;
        try {
          out.push(await this.load(await this.readFolder(f.folder)));
        } catch (err) {
          this.editor.log(`Plugin folder ${f.folder}: ${err instanceof Error ? err.message : String(err)}.`);
        }
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
      handle.dispose();
      this.editor.log(`[${owner}] ${pluginErrorMessage(err)}`);
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
