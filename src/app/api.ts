/**
 * The stable scripting / plugin API ("jcad"), version 1.
 *
 * Plugins, SCRIPTRUN scripts and the developer console (`window.jcadApi`) get an object of
 * this shape. Everything handed out is a plain frozen copy; changes go through
 * `document.add / replace / remove / transact`, which record undo steps like any command.
 * Errors thrown by plugin code (command handlers, event listeners) are caught and logged
 * with the plugin's name; they never reach the editor.
 *
 * The reference is docs/PLUGIN-API.md. Keep this file and that document in step, and
 * bump API_VERSION only for incompatible changes.
 */
import type { Editor, CommandDef } from './editor';
import type { Entity, InsertEntity, LineEntity, Layer, BlockDef } from '../core/entities';
import { newId, entityBounds } from '../core/entities';
import type { DrawingState, DrawingHeader } from '../core/document';
import type { Point, Bounds } from '../core/geometry';
import * as g from '../core/geometry';
import { scriptTool, text as textStep, point as pointStep, select as selectStep, type Step } from '../tools/script';
import type { ToolContext } from '../tools/types';
import { isWire } from '../electrical/ladder';
import { updateCrossReferences } from '../electrical/xref';
import { withInsertAttributes } from '../electrical/attributes';
import { modal, button } from '../ui/dialogkit';
import { esc } from '../ui/dom';

export const API_VERSION = 1;
const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export type ApiEvent = 'documentChanged' | 'selectionChanged' | 'commandStarted' | 'commandEnded' | 'drawingOpened';
export const API_EVENTS: readonly ApiEvent[] = ['documentChanged', 'selectionChanged', 'commandStarted', 'commandEnded', 'drawingOpened'];

export interface PluginCommand {
  name: string;
  aliases?: string[];
  description?: string;
  /** Replace a built-in command of the same name (off by default: registering an existing name throws). */
  override?: boolean;
  run(jcad: JcadApi, arg?: string): unknown;
}

export interface CommandInfo {
  readonly name: string;
  readonly aliases: readonly string[];
  readonly description: string;
  /** Plugin that registered it (undefined for built-in commands). */
  readonly plugin?: string;
}

export interface DialogOptions {
  title?: string;
  /** Body HTML (plugins run with full access; the HTML is inserted as given). */
  html?: string;
  /** Plain text body (escaped); used when `html` is absent. */
  text?: string;
  width?: number;
  /** Footer buttons; the promise resolves with the clicked label (default ["OK"]). */
  buttons?: string[];
  /** Called with the dialog body once it is in the page (wire up your own controls here). */
  onOpen?(body: HTMLElement, close: (result?: string | null) => void): void;
}

export interface DocumentInfo {
  readonly fileName: string;
  readonly filePath: string | null;
  readonly dirty: boolean;
}

export interface JcadApi {
  readonly apiVersion: number;
  /** Application version (package.json). */
  readonly version: string;
  readonly plugin: {
    readonly name: string;
    /** Run when the plugin is unloaded or reloaded (PLUGINRELOAD). */
    onUnload(fn: () => void): void;
  };
  readonly commands: {
    register(cmd: PluginCommand): () => void;
    run(name: string, arg?: string): void;
    list(): CommandInfo[];
  };
  readonly document: {
    info(): DocumentInfo;
    entities(filter?: { type?: string; layer?: string }): readonly Entity[];
    entity(id: string): Entity | null;
    selection(): string[];
    select(ids: readonly string[]): string[];
    add(entities: unknown[] | unknown): string[];
    replace(entities: unknown[] | unknown): string[];
    remove(ids: readonly string[] | string): number;
    transact<T>(fn: () => T): T;
    layers(): readonly Layer[];
    currentLayer(): string;
    blocks(): readonly BlockDef[];
    extents(): Bounds | null;
    header(): DrawingHeader;
    undo(): boolean;
    redo(): boolean;
  };
  readonly electrical: {
    components(): readonly InsertEntity[];
    wires(): readonly LineEntity[];
    setAttributes(id: string, values: Record<string, unknown>): void;
    crossReference(): number;
  };
  readonly ui: {
    log(msg: unknown): void;
    prompt(text: string, dflt?: string): Promise<string | null>;
    pick: {
      point(prompt?: string): Promise<Point | null>;
      entities(prompt?: string): Promise<string[]>;
    };
    alert(msg: string, title?: string): Promise<void>;
    confirm(msg: string, title?: string): Promise<boolean>;
    openDialog(options: string | DialogOptions): Promise<string | null>;
  };
  readonly events: {
    on(ev: ApiEvent, fn: (payload?: unknown) => void): () => void;
    off(ev: ApiEvent, fn: (payload?: unknown) => void): void;
  };
  readonly settings: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    keys(): string[];
  };
  readonly files: {
    readText(accept?: string): Promise<{ name: string; text: string } | null>;
    saveText(name: string, text: string, filterName?: string): Promise<string | null>;
  };
  readonly geometry: {
    distance(a: Point, b: Point): number;
    angle(from: Point, to: Point): number;
    polar(from: Point, angle: number, distance: number): Point;
    midpoint(a: Point, b: Point): Point;
    bounds(items: ReadonlyArray<Entity | string>): Bounds | null;
    rad(deg: number): number;
    deg(rad: number): number;
  };
}

// ------------------------------------------------------------------ frozen copies

const frozenCache = new WeakMap<object, unknown>();

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** A frozen deep copy (cached per source object: document state is immutable, so the copy stays valid). */
export function frozenCopy<T>(o: T): T {
  if (!o || typeof o !== 'object') return o;
  const hit = frozenCache.get(o as object);
  if (hit) return hit as T;
  const copy = deepFreeze(structuredClone(o));
  frozenCache.set(o as object, copy);
  return copy;
}

// ------------------------------------------------------------------ entity input

const ENTITY_TYPES = new Set(['line', 'circle', 'arc', 'polyline', 'text', 'insert', 'ellipse', 'point', 'xline', 'ray', 'mtext', 'dimension']);
const POINT_KEYS = ['a', 'b', 'center', 'position', 'p1', 'p2', 'linePoint', 'base', 'direction', 'majorAxis', 'textPosition'];
const REQUIRED: Record<string, string[]> = {
  line: ['a', 'b'],
  circle: ['center', 'radius'],
  arc: ['center', 'radius', 'startAngle', 'endAngle'],
  polyline: ['points'],
  text: ['position', 'text'],
  insert: ['block', 'position'],
  ellipse: ['center', 'majorAxis', 'ratio'],
  point: ['position'],
  xline: ['base', 'direction'],
  ray: ['base', 'direction'],
  mtext: ['position', 'text'],
  dimension: ['kind', 'p1', 'p2', 'linePoint'],
};

const isPoint = (p: unknown): p is Point => !!p && typeof p === 'object' && Number.isFinite((p as Point).x) && Number.isFinite((p as Point).y);

/**
 * Turn plugin input into an Entity: plain data only, a known type, the required fields, finite
 * coordinates, defaults for id / layer / colour and the per-type optional fields.
 */
export function normalizeEntity(input: unknown, state: DrawingState, mode: 'add' | 'replace', header?: DrawingHeader): Entity {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('An entity must be a plain object.');
  let e: Record<string, unknown>;
  try {
    e = structuredClone(input) as Record<string, unknown>;
  } catch {
    throw new TypeError('Entities must be plain data (no functions or class instances).');
  }
  const type = e.type;
  if (typeof type !== 'string' || !ENTITY_TYPES.has(type)) throw new TypeError(`Unknown entity type "${String(type)}".`);
  if (mode === 'replace') {
    const old = typeof e.id === 'string' ? state.entities.find((x) => x.id === e.id) : undefined;
    if (!old) throw new Error(`No entity with id "${String(e.id)}" to replace.`);
    if (old.type !== type) throw new Error(`Entity ${String(e.id)} is a ${old.type}; replace cannot change its type.`);
  } else if (typeof e.id !== 'string' || !e.id || state.entities.some((x) => x.id === e.id)) e.id = newId();
  if (typeof e.layer !== 'string' || !e.layer) e.layer = state.currentLayer;
  if (e.color === undefined) e.color = 'ByLayer';
  else if (e.color !== 'ByLayer' && !(Number.isInteger(e.color) && (e.color as number) >= 0 && (e.color as number) <= 256)) throw new TypeError('color must be "ByLayer" or an AutoCAD colour number 0-256.');
  for (const k of REQUIRED[type] ?? []) if (e[k] === undefined) throw new TypeError(`A ${type} needs "${k}".`);
  for (const k of POINT_KEYS) if (e[k] !== undefined && !isPoint(e[k])) throw new TypeError(`"${k}" must be a point {x, y} with finite numbers.`);
  switch (type) {
    case 'polyline':
      if (!Array.isArray(e.points) || e.points.length < 2 || !e.points.every(isPoint)) throw new TypeError('A polyline needs at least two points.');
      if (e.closed === undefined) e.closed = false;
      break;
    case 'circle':
    case 'arc':
      if (!((e.radius as number) > 0)) throw new TypeError('radius must be a positive number.');
      break;
    case 'text':
    case 'mtext':
      e.text = String(e.text);
      if (e.height === undefined) e.height = 0.125;
      if (e.rotation === undefined) e.rotation = 0;
      if (type === 'text' && e.align === undefined) e.align = 'left';
      if (type === 'mtext' && e.width === undefined) e.width = 0;
      if (!((e.height as number) > 0)) throw new TypeError('height must be a positive number.');
      break;
    case 'insert': {
      const block = String(e.block);
      if (!state.blocks[block]) throw new Error(`Block "${block}" is not defined in this drawing.`);
      if (e.rotation === undefined) e.rotation = 0;
      if (e.scale === undefined) e.scale = 1;
      const attrs: Record<string, string> = {};
      if (e.attributes && typeof e.attributes === 'object') for (const [k, v] of Object.entries(e.attributes as Record<string, unknown>)) attrs[k] = String(v ?? '');
      e.attributes = attrs;
      break;
    }
    case 'dimension':
      if (e.rotation === undefined) e.rotation = 0;
      if (e.style === undefined) e.style = header?.dimStyle;
      break;
    case 'ellipse':
      if (e.startParam === undefined) e.startParam = 0;
      if (e.endParam === undefined) e.endParam = Math.PI * 2;
      break;
  }
  return e as unknown as Entity;
}

/** Layers referenced by `entities` that the state lacks, with default properties. */
function withMissingLayers(s: DrawingState, entities: readonly Entity[]): DrawingState {
  const have = new Set(s.layers.map((l) => l.name));
  const add: Layer[] = [];
  for (const e of entities)
    if (!have.has(e.layer)) {
      have.add(e.layer);
      add.push({ name: e.layer, color: 7, visible: true, locked: false, lineWeight: 0.25 });
    }
  return add.length ? { ...s, layers: [...s.layers, ...add] } : s;
}

const toArray = <T>(v: T[] | T): T[] => (Array.isArray(v) ? v : [v]);

function logText(msg: unknown): string {
  if (typeof msg === 'string') return msg;
  try {
    return JSON.stringify(msg) ?? String(msg);
  } catch {
    return String(msg);
  }
}

// ------------------------------------------------------------------ per-editor hub (events, transactions, registry)

type Listener = (payload?: unknown) => void;

interface Hub {
  editor: Editor;
  listeners: Map<ApiEvent, Set<{ fn: Listener; owner: string }>>;
  pending: DrawingState | null;
  /** Command definitions registered through the API, with the owning plugin. */
  owned: Map<CommandDef, string>;
  active: { name: string; tool: unknown } | null;
  log: (owner: string, err: unknown, where: string) => void;
}

const hubs = new WeakMap<Editor, Hub>();

function reportError(editor: Editor, owner: string, err: unknown, where: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  editor.log(`[${owner}] ${where}: ${msg}`);
  if (typeof console !== 'undefined') console.error(`[jcad plugin ${owner}] ${where}`, err);
}

function hubOf(editor: Editor): Hub {
  const existing = hubs.get(editor);
  if (existing) return existing;
  const hub: Hub = { editor, listeners: new Map(), pending: null, owned: new Map(), active: null, log: (o, e, w) => reportError(editor, o, e, w) };
  hubs.set(editor, hub);
  const emit = (ev: ApiEvent, payload?: unknown) => {
    for (const l of [...(hub.listeners.get(ev) ?? [])]) {
      try {
        const r = l.fn(payload) as unknown;
        if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch((err) => hub.log(l.owner, err, `${ev} listener`));
      } catch (err) {
        hub.log(l.owner, err, `${ev} listener`);
      }
    }
  };
  editor.on('change', () => emit('documentChanged'));
  editor.on('selection', () => emit('selectionChanged', [...editor.selection]));
  // drawingOpened: a 'file' event that brought a different document state (open / new / tab switch, not save).
  let lastState: DrawingState = editor.doc.snapshot;
  let lastPath: string | null = editor.doc.filePath;
  editor.on('file', () => {
    const s = editor.doc.snapshot;
    const path = editor.doc.filePath;
    const changed = s !== lastState;
    lastState = s;
    lastPath = path;
    if (changed) emit('drawingOpened', { fileName: editor.fileName(), filePath: lastPath });
  });
  // commandStarted / commandEnded: wrap runCommand on this instance (every command line, menu and ribbon entry goes through it).
  const original = editor.runCommand.bind(editor);
  editor.on('tool', () => {
    if (hub.active && editor.tool !== hub.active.tool) {
      const n = hub.active.name;
      hub.active = null;
      emit('commandEnded', n);
    }
  });
  editor.runCommand = (input: string) => {
    const name = input.trim().split(/\s+/)[0]?.toUpperCase();
    const def = name ? editor.commands.get(name) : undefined;
    if (!def) {
      original(input);
      return;
    }
    if (hub.active) {
      const n = hub.active.name;
      hub.active = null;
      emit('commandEnded', n);
    }
    emit('commandStarted', def.name);
    const before = editor.tool;
    try {
      original(input);
    } finally {
      if (editor.tool && editor.tool !== before) hub.active = { name: def.name, tool: editor.tool };
      else emit('commandEnded', def.name);
    }
  };
  return hub;
}

// ------------------------------------------------------------------ settings

/** Settings plugins may change (the rest of UserSettings is read-only or private). */
const WRITABLE_SETTINGS: Record<string, 'boolean' | 'number'> = {
  gridVisible: 'boolean',
  gridSnap: 'boolean',
  ortho: 'boolean',
  polar: 'boolean',
  osnap: 'boolean',
  dynamicInput: 'boolean',
  lineweightDisplay: 'boolean',
  crosshairSize: 'number',
};
const READABLE_SETTINGS = [...Object.keys(WRITABLE_SETTINGS), 'symbolStandard', 'units', 'unitSuffix', 'precision', 'snapSpacing', 'gridSpacing', 'polarIncrement', 'language', 'workspace', 'modelBackground'];
const PLUGIN_SETTINGS_PREFIX = 'jcad.plugins.settings.';

function pluginStore(owner: string): { read(): Record<string, unknown>; write(v: Record<string, unknown>): void } {
  const key = PLUGIN_SETTINGS_PREFIX + owner;
  const mem: Record<string, unknown> = {};
  return {
    read() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        return raw ? (JSON.parse(raw) as Record<string, unknown>) : { ...mem };
      } catch {
        return { ...mem };
      }
    },
    write(v) {
      Object.assign(mem, v);
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(v));
      } catch {
        /* storage unavailable: kept for the session */
      }
    },
  };
}

// ------------------------------------------------------------------ DOM helpers (dialogs, file picker)

const hasDom = () => typeof document !== 'undefined' && typeof document.createElement === 'function';

function openDialog(editor: Editor, options: string | DialogOptions): Promise<string | null> {
  const o: DialogOptions = typeof options === 'string' ? { html: options } : options;
  if (!hasDom()) {
    editor.log(o.text ?? (o.html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const m = modal(esc(o.title ?? 'Plugin'), o.width ?? 480, 'dark');
    let done = false;
    const close = (result: string | null = null) => {
      if (done) return;
      done = true;
      m.close();
      resolve(result);
    };
    m.onClose(() => close(null));
    if (o.html !== undefined) m.body.innerHTML = o.html;
    else {
      const p = document.createElement('div');
      p.style.whiteSpace = 'pre-wrap';
      p.textContent = o.text ?? '';
      m.body.appendChild(p);
    }
    (o.buttons ?? ['OK']).forEach((label, i) => {
      const b = button(label, i === 0);
      b.addEventListener('click', () => close(label));
      m.footer.appendChild(b);
    });
    o.onOpen?.(m.body, (r) => close(r ?? null));
  });
}

/** Native file picker (works in the browser and in Electron's renderer). */
export function pickTextFile(accept: string): Promise<{ name: string; text: string } | null> {
  if (!hasDom()) return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      void f.text().then(
        (text) => resolve({ name: f.name, text }),
        () => resolve(null),
      );
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

// ------------------------------------------------------------------ the API object

export interface ApiHandle {
  readonly api: JcadApi;
  /** Unregister the owner's commands and listeners and run its unload hooks. */
  dispose(): void;
}

/**
 * Build an API object owned by `owner` (a plugin name, "script" or "console"). Commands and
 * event listeners it registers are tracked so `dispose()` (plugin reload / unload) removes them.
 */
export function createApi(editor: Editor, owner: string): ApiHandle {
  const hub = hubOf(editor);
  const doc = () => editor.doc;
  const state = () => hub.pending ?? editor.doc.snapshot;
  const mutate = (fn: (s: DrawingState) => DrawingState) => {
    if (hub.pending) hub.pending = fn(hub.pending);
    else editor.doc.transact(fn);
  };
  const myCommands = new Set<CommandDef>();
  const myListeners: Array<{ ev: ApiEvent; entry: { fn: Listener; owner: string } }> = [];
  const unloaders: Array<() => void> = [];
  let disposed = false;
  const guard = () => {
    if (disposed) throw new Error(`Plugin "${owner}" has been unloaded.`);
  };

  /** Run a prompt as a tiny generator tool; resolves `cancelValue` on Esc or when another command starts. */
  function promptTool<T>(name: string, body: (ctx: ToolContext) => Step<T>, cancelValue: T): Promise<T> {
    guard();
    return new Promise<T>((resolve) => {
      let settled = false;
      const settle = (v: T) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      editor.startTool(
        scriptTool(name, function* (ctx) {
          try {
            settle(yield* body(ctx));
          } finally {
            settle(cancelValue);
          }
        }),
      );
    });
  }

  const commands: JcadApi['commands'] = {
    register(cmd) {
      guard();
      if (!cmd || typeof cmd !== 'object' || typeof cmd.run !== 'function') throw new TypeError('commands.register needs { name, run(jcad, arg) }.');
      const name = String(cmd.name ?? '').toUpperCase();
      const aliases = (cmd.aliases ?? []).map((a) => String(a).toUpperCase());
      for (const n of [name, ...aliases]) if (!/^[A-Z_][A-Z0-9_.-]{0,63}$/.test(n)) throw new TypeError(`Invalid command name "${n}" (letters, digits, _ . -).`);
      for (const n of [name, ...aliases]) {
        const existing = editor.commands.get(n);
        if (existing && hub.owned.get(existing) !== owner && !cmd.override) throw new Error(`Command ${n} already exists${hub.owned.has(existing) ? ` (plugin ${hub.owned.get(existing)})` : ''}; pass override: true to replace it.`);
      }
      const def: CommandDef = {
        name,
        aliases,
        description: String(cmd.description ?? `${name} (plugin ${owner})`),
        startsTool: false,
        run: (_ed, arg) => {
          try {
            const r = cmd.run(api, arg) as unknown;
            if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch((err) => hub.log(owner, err, `command ${name}`));
          } catch (err) {
            hub.log(owner, err, `command ${name}`);
          }
        },
      };
      editor.register(def);
      hub.owned.set(def, owner);
      myCommands.add(def);
      return () => unregister(def);
    },
    run(name, arg) {
      guard();
      const n = String(name).trim();
      editor.runCommand(arg !== undefined && arg !== '' ? `${n} ${arg}` : n);
    },
    list() {
      const seen = new Set<CommandDef>();
      const out: CommandInfo[] = [];
      for (const d of editor.commands.values()) {
        if (seen.has(d)) continue;
        seen.add(d);
        out.push(frozenCopy({ name: d.name, aliases: [...d.aliases], description: d.description, ...(hub.owned.has(d) ? { plugin: hub.owned.get(d) } : {}) }));
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
  };

  function unregister(def: CommandDef): void {
    for (const n of [def.name, ...def.aliases]) if (editor.commands.get(n) === def) editor.commands.delete(n);
    hub.owned.delete(def);
    myCommands.delete(def);
  }

  const documentApi: JcadApi['document'] = {
    info: () => frozenCopy({ fileName: editor.fileName(), filePath: doc().filePath, dirty: doc().dirty }),
    entities(filter) {
      const list = state().entities.filter((e) => (!filter?.type || e.type === filter.type) && (!filter?.layer || e.layer === filter.layer));
      return Object.freeze(list.map((e) => frozenCopy(e)));
    },
    entity(id) {
      const e = state().entities.find((x) => x.id === id);
      return e ? frozenCopy(e) : null;
    },
    selection: () => [...editor.selection],
    select(ids) {
      guard();
      const have = new Set(state().entities.map((e) => e.id));
      const valid = [...new Set(toArray(ids as string[]).map(String))].filter((id) => have.has(id));
      editor.selection = new Set(valid);
      editor.notify('selection');
      editor.render();
      return valid;
    },
    add(input) {
      guard();
      const s0 = state();
      const list = toArray(input).map((x) => normalizeEntity(x, s0, 'add', doc().header));
      const ids = new Set<string>();
      for (const e of list) {
        if (ids.has(e.id)) throw new Error(`Duplicate id "${e.id}" in add().`);
        ids.add(e.id);
      }
      if (list.length) mutate((s) => withMissingLayers({ ...s, entities: [...s.entities, ...list] }, list));
      return list.map((e) => e.id);
    },
    replace(input) {
      guard();
      const s0 = state();
      const list = toArray(input).map((x) => normalizeEntity(x, s0, 'replace', doc().header));
      if (list.length) {
        const map = new Map(list.map((e) => [e.id, e]));
        mutate((s) => withMissingLayers({ ...s, entities: s.entities.map((e) => map.get(e.id) ?? e) }, list));
      }
      return list.map((e) => e.id);
    },
    remove(input) {
      guard();
      const set = new Set(toArray(input as string[]).map(String));
      const n = state().entities.filter((e) => set.has(e.id)).length;
      if (n) mutate((s) => ({ ...s, entities: s.entities.filter((e) => !set.has(e.id)) }));
      return n;
    },
    transact<T>(fn: () => T): T {
      guard();
      if (typeof fn !== 'function') throw new TypeError('transact needs a function.');
      if (hub.pending) return fn(); // nested: part of the outer step
      hub.pending = editor.doc.snapshot;
      let result: T;
      try {
        result = fn();
        if (result && typeof (result as unknown as Promise<unknown>).then === 'function') throw new Error('transact callbacks must be synchronous (one undo step); await prompts before calling transact.');
      } catch (err) {
        hub.pending = null;
        throw err;
      }
      const next = hub.pending;
      hub.pending = null;
      if (next !== editor.doc.snapshot) editor.doc.transact(() => next);
      return result;
    },
    layers: () => Object.freeze(state().layers.map((l) => frozenCopy(l))),
    currentLayer: () => state().currentLayer,
    blocks: () => Object.freeze(Object.values(state().blocks).map((b) => frozenCopy(b))),
    extents: () => {
      const b = doc().extents();
      return b ? frozenCopy(b) : null;
    },
    header: () => frozenCopy(doc().header),
    undo() {
      guard();
      if (hub.pending) throw new Error('undo is not available inside transact.');
      return editor.doc.undo();
    },
    redo() {
      guard();
      if (hub.pending) throw new Error('redo is not available inside transact.');
      return editor.doc.redo();
    },
  };

  const electrical: JcadApi['electrical'] = {
    components: () => Object.freeze(state().entities.filter((e): e is InsertEntity => e.type === 'insert' && !!e.attributes.TAG1).map((e) => frozenCopy(e))),
    wires: () => Object.freeze(state().entities.filter((e): e is LineEntity => isWire(e)).map((e) => frozenCopy(e))),
    setAttributes(id, values) {
      guard();
      const e = state().entities.find((x) => x.id === id);
      if (!e || e.type !== 'insert') throw new Error(`No block insert with id "${id}".`);
      if (!values || typeof values !== 'object') throw new TypeError('setAttributes needs an object of TAG: value pairs.');
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) clean[String(k).toUpperCase()] = v === null || v === undefined ? '' : String(v);
      mutate((s) => withInsertAttributes(s, new Map([[id, clean]])));
    },
    crossReference() {
      guard();
      if (hub.pending) throw new Error('crossReference cannot run inside transact.');
      return updateCrossReferences(editor.doc);
    },
  };

  const ui: JcadApi['ui'] = {
    log: (msg) => editor.log(logText(msg)),
    prompt: (text, dflt) => promptTool('PROMPT', () => textStep(`${text}${dflt !== undefined ? ` <${dflt}>` : ''}`.trim(), dflt ?? '', true), null as string | null),
    pick: {
      point: (prompt = 'Specify point:') => promptTool('GETPOINT', (ctx) => pointStep(ctx, prompt), null as Point | null),
      entities: (prompt = 'Select objects:') => promptTool('SELECT', (ctx) => selectStep(ctx, prompt, false), [] as string[]),
    },
    alert: (msg, title) => openDialog(editor, { title: title ?? owner, text: String(msg) }).then(() => undefined),
    confirm: (msg, title) => {
      if (!hasDom()) return (editor.ui?.confirm(title ?? owner, String(msg)) ?? Promise.resolve(false)).then(Boolean);
      return openDialog(editor, { title: title ?? owner, text: String(msg), buttons: ['Yes', 'No'] }).then((r) => r === 'Yes');
    },
    openDialog: (options) => openDialog(editor, options),
  };

  const events: JcadApi['events'] = {
    on(ev, fn) {
      guard();
      if (!API_EVENTS.includes(ev)) throw new TypeError(`Unknown event "${String(ev)}". Events: ${API_EVENTS.join(', ')}.`);
      if (typeof fn !== 'function') throw new TypeError('events.on needs a listener function.');
      const entry = { fn, owner };
      let set = hub.listeners.get(ev);
      if (!set) hub.listeners.set(ev, (set = new Set()));
      set.add(entry);
      myListeners.push({ ev, entry });
      return () => events.off(ev, fn);
    },
    off(ev, fn) {
      const set = hub.listeners.get(ev);
      if (!set) return;
      for (const entry of set)
        if (entry.fn === fn && entry.owner === owner) {
          set.delete(entry);
          const i = myListeners.findIndex((l) => l.entry === entry);
          if (i >= 0) myListeners.splice(i, 1);
        }
    },
  };

  const store = pluginStore(owner);
  const settings: JcadApi['settings'] = {
    get(key) {
      const k = String(key);
      if (k.startsWith('plugin:')) return store.read()[k.slice(7)];
      if (!READABLE_SETTINGS.includes(k)) throw new Error(`Setting "${k}" is not available to plugins. Use "plugin:<name>" keys for your own settings.`);
      return frozenCopy((editor.settings as unknown as Record<string, unknown>)[k]);
    },
    set(key, value) {
      guard();
      const k = String(key);
      if (k.startsWith('plugin:')) {
        const v = store.read();
        v[k.slice(7)] = structuredClone(value);
        store.write(v);
        return;
      }
      const kind = WRITABLE_SETTINGS[k];
      if (!kind) throw new Error(`Setting "${k}" cannot be changed by plugins. Writable: ${Object.keys(WRITABLE_SETTINGS).join(', ')}.`);
      if (typeof value !== kind || (kind === 'number' && !Number.isFinite(value))) throw new TypeError(`Setting "${k}" must be a ${kind}.`);
      const v = k === 'crosshairSize' ? Math.max(1, Math.min(100, Math.round(value as number))) : value;
      editor.settings = { ...editor.settings, [k]: v };
      editor.applySettings();
      editor.persistSettings();
      editor.notify('snap');
      editor.render();
    },
    keys: () => [...READABLE_SETTINGS],
  };

  const files: JcadApi['files'] = {
    readText: (accept = '.txt,.csv,.json,.js,.scr,.dxf') => pickTextFile(accept),
    async saveText(name, text, filterName = 'Text') {
      guard();
      const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? 'txt';
      const bridge = editor.fileBridge;
      if (!bridge?.saveText) {
        editor.log('Saving files is not available here.');
        return null;
      }
      return bridge.saveText(name, String(text), filterName, ext);
    },
  };

  const geometry: JcadApi['geometry'] = {
    distance: (a, b) => g.dist(a, b),
    angle: (a, b) => g.angleOf(a, b),
    polar: (p, a, d) => g.polar(p, a, d),
    midpoint: (a, b) => g.mid(a, b),
    bounds(items) {
      const s = state();
      let b: Bounds | null = null;
      for (const it of items) {
        const e = typeof it === 'string' ? s.entities.find((x) => x.id === it) : it;
        if (e) b = g.unionBounds(b, entityBounds(e, (n) => s.blocks[n]));
      }
      return b;
    },
    rad: (d) => g.rad(d),
    deg: (r) => g.deg(r),
  };

  const api: JcadApi = Object.freeze({
    apiVersion: API_VERSION,
    version: APP_VERSION,
    plugin: Object.freeze({
      name: owner,
      onUnload(fn: () => void) {
        if (typeof fn === 'function') unloaders.push(fn);
      },
    }),
    commands: Object.freeze(commands),
    document: Object.freeze(documentApi),
    electrical: Object.freeze(electrical),
    ui: Object.freeze({ ...ui, pick: Object.freeze(ui.pick) }),
    events: Object.freeze(events),
    settings: Object.freeze(settings),
    files: Object.freeze(files),
    geometry: Object.freeze(geometry),
  });

  return {
    api,
    dispose() {
      if (disposed) return;
      for (const fn of unloaders.splice(0)) {
        try {
          fn();
        } catch (err) {
          hub.log(owner, err, 'unload');
        }
      }
      for (const def of [...myCommands]) unregister(def);
      for (const { ev, entry } of myListeners.splice(0)) hub.listeners.get(ev)?.delete(entry);
      disposed = true;
    },
  };
}

declare global {
  interface Window {
    /** The plugin API for the developer console and automation (the preload bridge is `window.jcad`). */
    jcadApi?: JcadApi;
  }
}

const installed = new WeakMap<Editor, JcadApi>();

/**
 * Create the console-owned API and expose it as `window.jcadApi`. Idempotent; returns the API.
 * Call once after the Editor's commands are registered.
 */
export function installApi(editor: Editor): JcadApi {
  const hit = installed.get(editor);
  if (hit) return hit;
  const { api } = createApi(editor, 'console');
  installed.set(editor, api);
  if (typeof window !== 'undefined') window.jcadApi = api;
  return api;
}
