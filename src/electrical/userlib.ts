/**
 * User symbol library: symbols made with the Symbol Builder (AESYMBUILDER).
 *
 * The library is an in-memory registry with a change event, persisted as one
 * JSON document (`user-library.json` in the Electron app-data folder through
 * the `userLibraryRead` / `userLibraryWrite` bridge, or the localStorage key
 * `jcad.userlib.v1` in a browser). `library.ts` merges it into the icon menu,
 * the search and `findLibrarySymbol`; the tag prefix (family) and coil /
 * contact role of every user symbol are registered so tagging and
 * cross-referencing treat them like built-in symbols.
 *
 * Pure of DOM: the store is injected, so the module works under vitest.
 */
import type { BlockDef, InsertEntity } from '../core/entities';
import type { DrawingState } from '../core/document';
import { DEFAULT_LAYERS } from '../core/document';
import { writeDxf } from '../io/dxf';
import { registerTagPrefixes, unregisterTagPrefix } from './symbols';
import { registerSymbolRole } from './families';

export type SymbolStandard = 'JIC' | 'IEC';

export interface UserSymbol {
  block: BlockDef;
  standard: SymbolStandard;
  category: string;
  family: string;
  /** WDTYPE override (COIL, CONTACT, TERM, PLC); undefined = the family. */
  wdtype?: string;
  created: number;
  modified: number;
}

export const USER_LIBRARY_KEY = 'jcad.userlib.v1';
export const USER_LIBRARY_FORMAT = 'jcad-user-library';
export const USER_LIBRARY_VERSION = 1;
/** Prefix of the icon-menu categories that hold user symbols. */
export const USER_CATEGORY_PREFIX = 'User: ';
export const DEFAULT_USER_CATEGORY = 'User symbols';

export interface UserLibraryStore {
  read(): Promise<string | null>;
  write(json: string): Promise<void>;
}

/** Electron bridge (see electron/preload.cjs). */
export interface UserLibraryBridge {
  userLibraryRead(): Promise<string | null>;
  userLibraryWrite(json: string): Promise<void>;
}

export function bridgeUserLibraryStore(b: UserLibraryBridge): UserLibraryStore {
  return { read: () => b.userLibraryRead(), write: (json) => b.userLibraryWrite(json) };
}

/** Browser fallback: one localStorage entry (also used by the tests with a Map-backed fake). */
export function localUserLibraryStore(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }, key = USER_LIBRARY_KEY): UserLibraryStore {
  return {
    async read() {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    async write(json) {
      try {
        storage.setItem(key, json);
      } catch {
        /* quota exceeded or storage unavailable */
      }
    },
  };
}

/** No persistence (default before main.ts installs a store; unit tests). */
export const memoryUserLibraryStore = (): UserLibraryStore & { json: string | null } => {
  const s = {
    json: null as string | null,
    async read() {
      return s.json;
    },
    async write(json: string) {
      s.json = json;
    },
  };
  return s;
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Exact-name pattern registered with tagPrefix for a user symbol. */
export const userSymbolPattern = (name: string): RegExp => new RegExp(`^${escapeRegExp(name)}$`);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isPoint = (v: unknown): v is { x: number; y: number } => isRecord(v) && typeof v.x === 'number' && typeof v.y === 'number' && Number.isFinite(v.x) && Number.isFinite(v.y);

/** Validate one library entry from JSON (unknown shapes are rejected, not repaired). */
export function parseUserSymbol(v: unknown): UserSymbol | null {
  if (!isRecord(v) || !isRecord(v.block)) return null;
  const b = v.block;
  if (typeof b.name !== 'string' || !b.name || !isPoint(b.basePoint) || !Array.isArray(b.entities) || !Array.isArray(b.attributes)) return null;
  for (const e of b.entities) if (!isRecord(e) || typeof e.type !== 'string' || typeof e.layer !== 'string') return null;
  for (const a of b.attributes) if (!isRecord(a) || typeof a.tag !== 'string' || !isPoint(a.position) || typeof a.height !== 'number') return null;
  const block: BlockDef = {
    name: b.name,
    basePoint: b.basePoint,
    entities: b.entities as BlockDef['entities'],
    attributes: b.attributes as BlockDef['attributes'],
    ...(typeof b.description === 'string' ? { description: b.description } : {}),
  };
  const standard: SymbolStandard = v.standard === 'IEC' ? 'IEC' : 'JIC';
  const now = Date.now();
  return {
    block,
    standard,
    category: typeof v.category === 'string' && v.category.trim() ? v.category.trim() : DEFAULT_USER_CATEGORY,
    family: typeof v.family === 'string' && v.family.trim() ? v.family.trim().toUpperCase() : 'DEV',
    ...(typeof v.wdtype === 'string' && v.wdtype ? { wdtype: v.wdtype } : {}),
    created: typeof v.created === 'number' ? v.created : now,
    modified: typeof v.modified === 'number' ? v.modified : now,
  };
}

/** Parse a library document (or a bare array / single symbol) into entries. */
export function parseUserLibrary(text: string): UserSymbol[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a JSON file');
  }
  const list: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.symbols) ? raw.symbols : isRecord(raw) && isRecord(raw.block) ? [raw] : [];
  const out: UserSymbol[] = [];
  for (const item of list) {
    const s = parseUserSymbol(item);
    if (s) out.push(s);
  }
  if (out.length === 0 && list.length > 0) throw new Error('No valid symbols in the file');
  return out;
}

export function serializeUserLibrary(symbols: readonly UserSymbol[]): string {
  return JSON.stringify({ format: USER_LIBRARY_FORMAT, version: USER_LIBRARY_VERSION, symbols }, null, 1);
}

export type UserLibraryListener = () => void;

export class UserLibrary {
  private symbols = new Map<string, UserSymbol>();
  private listeners = new Set<UserLibraryListener>();
  private store: UserLibraryStore;
  private writeChain: Promise<void> = Promise.resolve();
  /** Set when a persisted write failed (surfaced by the UI). */
  lastError: string | null = null;

  constructor(store: UserLibraryStore = memoryUserLibraryStore()) {
    this.store = store;
  }

  /** Install the persistence store (main.ts, once the bridge is known). */
  setStore(store: UserLibraryStore): void {
    this.store = store;
  }

  /** Replace the registry with the persisted library. Returns the number of symbols loaded. */
  async load(): Promise<number> {
    let text: string | null = null;
    try {
      text = await this.store.read();
    } catch (err) {
      this.lastError = (err as Error).message;
    }
    for (const name of [...this.symbols.keys()]) this.unregister(name);
    this.symbols.clear();
    if (text) {
      try {
        for (const s of parseUserLibrary(text)) this.symbols.set(s.block.name, s);
      } catch (err) {
        this.lastError = (err as Error).message;
      }
    }
    for (const s of this.symbols.values()) this.register(s);
    this.emit();
    return this.symbols.size;
  }

  onChange(fn: UserLibraryListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  private register(s: UserSymbol): void {
    registerTagPrefixes([[userSymbolPattern(s.block.name), s.family]]);
    registerSymbolRole(s.block.name, s.wdtype === 'COIL' ? 'coil' : s.wdtype === 'CONTACT' ? 'child' : 'none');
  }
  private unregister(name: string): void {
    unregisterTagPrefix(userSymbolPattern(name));
    registerSymbolRole(name, 'none');
  }

  /** Queue a write of the whole library (writes are serialised; failures are recorded, never thrown). */
  private persist(): Promise<void> {
    const json = serializeUserLibrary(this.all());
    this.writeChain = this.writeChain
      .then(() => this.store.write(json))
      .then(
        () => void (this.lastError = null),
        (err: unknown) => void (this.lastError = err instanceof Error ? err.message : String(err)),
      );
    return this.writeChain;
  }

  /** Wait for pending writes (tests, shutdown). */
  flush(): Promise<void> {
    return this.writeChain;
  }

  all(): UserSymbol[] {
    return [...this.symbols.values()].sort((a, b) => a.block.name.localeCompare(b.block.name));
  }
  get size(): number {
    return this.symbols.size;
  }
  get(name: string): UserSymbol | undefined {
    return this.symbols.get(name) ?? this.symbols.get(name.toUpperCase());
  }
  has(name: string): boolean {
    return this.get(name) !== undefined;
  }
  names(): string[] {
    return this.all().map((s) => s.block.name);
  }
  /** Distinct category names of one standard, in first-seen order. */
  categories(standard: SymbolStandard): string[] {
    const out: string[] = [];
    for (const s of this.all()) if (s.standard === standard && !out.includes(s.category)) out.push(s.category);
    return out;
  }
  /** Symbols of one standard grouped by category, as icon-menu categories named "User: <category>". */
  categoriesOf(standard: SymbolStandard): Array<{ name: string; symbols: BlockDef[] }> {
    return this.categories(standard).map((c) => ({ name: USER_CATEGORY_PREFIX + c, symbols: this.all().filter((s) => s.standard === standard && s.category === c).map((s) => s.block) }));
  }

  /** Add or replace a symbol (same block name). Returns the stored entry. */
  put(sym: Omit<UserSymbol, 'created' | 'modified'> & Partial<Pick<UserSymbol, 'created' | 'modified'>>): UserSymbol {
    const name = sym.block.name;
    const now = Date.now();
    const prev = this.symbols.get(name);
    const entry: UserSymbol = { ...sym, family: sym.family.toUpperCase(), created: sym.created ?? prev?.created ?? now, modified: sym.modified ?? now };
    this.symbols.set(name, entry);
    this.register(entry);
    void this.persist();
    this.emit();
    return entry;
  }

  remove(name: string): boolean {
    const s = this.get(name);
    if (!s) return false;
    this.symbols.delete(s.block.name);
    this.unregister(s.block.name);
    void this.persist();
    this.emit();
    return true;
  }

  /** Rename a symbol (block name changes, everything else is kept). Fails when the new name exists. */
  rename(oldName: string, newName: string): boolean {
    const s = this.get(oldName);
    const target = newName.trim().toUpperCase();
    if (!s || !target || this.symbols.has(target)) return false;
    this.symbols.delete(s.block.name);
    this.unregister(s.block.name);
    const entry: UserSymbol = { ...s, block: { ...s.block, name: target }, modified: Date.now() };
    this.symbols.set(target, entry);
    this.register(entry);
    void this.persist();
    this.emit();
    return true;
  }

  /** JSON export of some symbols (default: the whole library). */
  exportJson(names?: readonly string[]): string {
    const list = names ? names.map((n) => this.get(n)).filter((s): s is UserSymbol => !!s) : this.all();
    return serializeUserLibrary(list);
  }

  /** Merge a JSON library / symbol file into the registry. */
  importJson(text: string, opts: { replace?: boolean } = {}): { added: number; updated: number; skipped: number } {
    const list = parseUserLibrary(text);
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const s of list) {
      const exists = this.symbols.has(s.block.name);
      if (exists && opts.replace === false) {
        skipped += 1;
        continue;
      }
      this.symbols.set(s.block.name, s);
      this.register(s);
      if (exists) updated += 1;
      else added += 1;
    }
    if (added || updated) {
      void this.persist();
      this.emit();
    }
    return { added, updated, skipped };
  }
}

/** The application-wide user library (main.ts installs the persistent store and loads it). */
export const userLibrary = new UserLibrary();

/**
 * DXF text of one symbol as a block file. AutoCAD's WBLOCK writes the block's
 * geometry into model space; we instead write a drawing whose BLOCKS section
 * holds the block definition and whose model space has a single reference of
 * it at the origin, so both the definition (with its attributes) and a visible
 * instance survive the round trip through any DXF reader.
 */
export function symbolToDxf(block: BlockDef): string {
  const insert: InsertEntity = { id: 'sym-insert', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: block.name, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {} };
  const state: DrawingState = { entities: [insert], layers: DEFAULT_LAYERS.map((l) => ({ ...l })), blocks: { [block.name]: block }, currentLayer: '0' };
  return writeDxf(state);
}
