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
 * Data integrity: every write serialises the whole registry, so a write is
 * only allowed once the initial `load()` has read the file successfully.
 * Reads and writes share one promise chain (`load()` runs after in-flight
 * writes, writes wait for the load); when the file cannot be read or parsed
 * the library refuses to write and reports it through `lastError`, and
 * entries this version cannot understand are carried through unchanged
 * (`unparsed`) instead of being dropped on the next save.
 *
 * Pure of DOM: the store is injected, so the module works under vitest.
 */
import type { AttributeDef, BlockDef, Entity, InsertEntity } from '../core/entities';
import type { DrawingState } from '../core/document';
import { DEFAULT_LAYERS } from '../core/document';
import { writeDxf } from '../io/dxf';
import { validBlockName } from '../tools/blocks';
import { registerTagPrefixes, unregisterTagPrefix } from './symbols';
import { registerSymbolRole } from './families';

export type SymbolStandard = 'JIC' | 'IEC';

export interface UserSymbol {
  block: BlockDef;
  standard: SymbolStandard;
  category: string;
  family: string;
  /** WDTYPE override (COIL, CONTACT, TERM, PLC or a family code); undefined = the family. */
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
  /** The stored document, or null when no library has been written yet. Rejects on any other failure. */
  read(): Promise<string | null>;
  /** Replace the stored document. Rejects when the write did not happen (quota, permissions, disk). */
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

/**
 * Browser fallback: one localStorage entry (also used by the tests with a Map-backed fake).
 * Storage errors (quota exceeded, access denied) propagate so the library reports them.
 */
export function localUserLibraryStore(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }, key = USER_LIBRARY_KEY): UserLibraryStore {
  return {
    async read() {
      return storage.getItem(key);
    },
    async write(json) {
      storage.setItem(key, json);
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
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPoint = (v: unknown): v is { x: number; y: number } => isRecord(v) && isNum(v.x) && isNum(v.y);
const isAlign = (v: unknown): v is 'left' | 'center' | 'right' => v === 'left' || v === 'center' || v === 'right';

/** Accepted WDTYPE values: the ACADE roles or a family code (letters and digits, up to 8). */
const WDTYPE_RE = /^(COIL|CONTACT|TERM|PLC|[A-Z][A-Z0-9]{0,7})$/;
/** Upper-cased, whitelisted WDTYPE, or undefined when the value is not one we store. */
export function normalizeWdtype(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const w = v.trim().toUpperCase();
  return WDTYPE_RE.test(w) ? w : undefined;
}

/** Trimmed, upper-cased block name, or the reason it cannot be used. */
export function normalizeSymbolName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'has no block name' };
  const name = raw.trim().toUpperCase();
  if (!name) return { error: 'has an empty block name' };
  if (/\s/.test(name)) return { error: `"${name}" contains whitespace; block names cannot` };
  if (!validBlockName(name)) return { error: `"${name}" is not a valid block name (no <>/\\":;?*|,=\` characters)` };
  return { name };
}

/** Validate and normalise one block entity from JSON. Returns the entity or the reason it was rejected. */
function parseEntity(v: unknown, i: number): { entity: Entity } | { error: string } {
  if (!isRecord(v)) return { error: `entity ${i + 1} is not an object` };
  if (typeof v.type !== 'string') return { error: `entity ${i + 1} has no type` };
  if (typeof v.layer !== 'string') return { error: `${v.type} entity ${i + 1} has no layer` };
  const bad = (what: string) => ({ error: `${v.type} entity ${i + 1} ${what}` });
  const base = { ...v, id: typeof v.id === 'string' && v.id ? v.id : `u${i + 1}`, color: v.color ?? 'ByLayer' } as Record<string, unknown>;
  const ok = (e: Record<string, unknown>) => ({ entity: e as unknown as Entity });
  switch (v.type) {
    case 'line':
      return isPoint(v.a) && isPoint(v.b) ? ok(base) : bad('needs points a and b');
    case 'circle':
      return isPoint(v.center) && isNum(v.radius) && v.radius > 0 ? ok(base) : bad('needs a center and a positive radius');
    case 'arc':
      return isPoint(v.center) && isNum(v.radius) && v.radius > 0 && isNum(v.startAngle) && isNum(v.endAngle) ? ok(base) : bad('needs a center, a positive radius and start / end angles');
    case 'polyline':
      if (!Array.isArray(v.points) || v.points.length === 0 || !v.points.every(isPoint)) return bad('needs a non-empty points array');
      if (v.bulges !== undefined && (!Array.isArray(v.bulges) || !v.bulges.every(isNum))) return bad('has a bulges list that is not numeric');
      return ok({ ...base, closed: v.closed === true });
    case 'text':
      if (!isPoint(v.position) || typeof v.text !== 'string' || !isNum(v.height) || v.height <= 0) return bad('needs a position, text and a positive height');
      return ok({ ...base, rotation: isNum(v.rotation) ? v.rotation : 0, align: isAlign(v.align) ? v.align : 'left' });
    case 'mtext':
      if (!isPoint(v.position) || typeof v.text !== 'string' || !isNum(v.height) || v.height <= 0 || typeof v.attachment !== 'string') return bad('needs a position, text, a positive height and an attachment');
      return ok({ ...base, width: isNum(v.width) ? v.width : 0, rotation: isNum(v.rotation) ? v.rotation : 0, lineSpacing: isNum(v.lineSpacing) ? v.lineSpacing : 1 });
    case 'insert':
      if (typeof v.block !== 'string' || !v.block.trim() || !isPoint(v.position)) return bad('needs a block name and a position');
      return ok({ ...base, rotation: isNum(v.rotation) ? v.rotation : 0, scale: isNum(v.scale) && v.scale !== 0 ? v.scale : 1, attributes: isRecord(v.attributes) ? v.attributes : {} });
    case 'ellipse':
      return isPoint(v.center) && isPoint(v.majorAxis) && isNum(v.ratio) && v.ratio > 0 && isNum(v.startParam) && isNum(v.endParam) ? ok(base) : bad('needs a center, a major axis, a ratio and start / end parameters');
    case 'point':
      return isPoint(v.position) ? ok(base) : bad('needs a position');
    case 'xline':
    case 'ray':
      return isPoint(v.base) && isPoint(v.direction) ? ok(base) : bad('needs a base point and a direction');
    case 'dimension':
      return typeof v.kind === 'string' && isPoint(v.p1) && isPoint(v.p2) && isPoint(v.linePoint) && isRecord(v.style) ? ok({ ...base, rotation: isNum(v.rotation) ? v.rotation : 0 }) : bad('needs a kind, p1, p2, linePoint and a style');
    default:
      return { error: `entity ${i + 1} has an unknown type "${v.type}"` };
  }
}

/**
 * Validate one attribute definition from JSON (prompt / default / align get their defaults).
 * Optional fields: `invisible`, `rotation`, and the Symbol Builder's ATTDEF extras
 * `constant`, `verify`, `preset` and `placeholder` (see AttributeDefExt); files written
 * before these existed simply do not carry them.
 */
function parseAttributeDef(v: unknown, i: number): { attribute: AttributeDef } | { error: string } {
  if (!isRecord(v)) return { error: `attribute ${i + 1} is not an object` };
  if (typeof v.tag !== 'string' || !v.tag.trim()) return { error: `attribute ${i + 1} has no tag` };
  if (!isPoint(v.position) || !isNum(v.height) || v.height <= 0) return { error: `attribute ${v.tag} needs a position and a positive height` };
  const flag = (k: 'invisible' | 'constant' | 'verify' | 'preset' | 'placeholder') => (v[k] === true ? { [k]: true } : {});
  return {
    attribute: {
      tag: v.tag,
      prompt: typeof v.prompt === 'string' ? v.prompt : '',
      default: typeof v.default === 'string' ? v.default : '',
      position: v.position,
      height: v.height,
      align: isAlign(v.align) ? v.align : 'left',
      ...flag('invisible'),
      ...(isNum(v.rotation) && v.rotation !== 0 ? { rotation: v.rotation } : {}),
      ...flag('constant'),
      ...flag('verify'),
      ...flag('preset'),
      ...flag('placeholder'),
    } as AttributeDef,
  };
}

/**
 * Validate one library entry from JSON. Throws with a message that names the symbol and
 * the first problem; the entry is never repaired beyond upper-casing the name and
 * filling optional presentation fields.
 */
export function validateUserSymbol(v: unknown): UserSymbol {
  if (!isRecord(v) || !isRecord(v.block)) throw new Error('entry has no block');
  const b = v.block;
  const named = normalizeSymbolName(b.name);
  if ('error' in named) throw new Error(`entry ${named.error}`);
  const name = named.name;
  const fail = (what: string): never => {
    throw new Error(`${name}: ${what}`);
  };
  if (!isPoint(b.basePoint)) fail('basePoint is not a point');
  if (!Array.isArray(b.entities)) fail('entities is not an array');
  if (!Array.isArray(b.attributes)) fail('attributes is not an array');
  const entities: Entity[] = [];
  for (const [i, e] of (b.entities as unknown[]).entries()) {
    const r = parseEntity(e, i);
    if ('error' in r) fail(r.error);
    else entities.push(r.entity);
  }
  const attributes: AttributeDef[] = [];
  for (const [i, a] of (b.attributes as unknown[]).entries()) {
    const r = parseAttributeDef(a, i);
    if ('error' in r) fail(r.error);
    else attributes.push(r.attribute);
  }
  if (entities.length === 0 && attributes.length === 0) fail('has no geometry and no attributes');
  const block: BlockDef = {
    name,
    basePoint: b.basePoint as { x: number; y: number },
    entities,
    attributes,
    ...(typeof b.description === 'string' ? { description: b.description } : {}),
  };
  const standard: SymbolStandard = v.standard === 'IEC' ? 'IEC' : 'JIC';
  const now = Date.now();
  const wdtype = normalizeWdtype(v.wdtype);
  return {
    block,
    standard,
    category: typeof v.category === 'string' && v.category.trim() ? v.category.trim() : DEFAULT_USER_CATEGORY,
    family: typeof v.family === 'string' && v.family.trim() ? v.family.trim().toUpperCase() : 'DEV',
    ...(wdtype ? { wdtype } : {}),
    created: typeof v.created === 'number' ? v.created : now,
    modified: typeof v.modified === 'number' ? v.modified : now,
  };
}

/** Validate one library entry from JSON; null when it is rejected (see `validateUserSymbol` for the reason). */
export function parseUserSymbol(v: unknown): UserSymbol | null {
  try {
    return validateUserSymbol(v);
  } catch {
    return null;
  }
}

export interface ParsedUserLibrary {
  symbols: UserSymbol[];
  /** Entries this version could not parse, verbatim (written back unchanged). */
  unparsed: unknown[];
  /** One message per unparsed entry. */
  errors: string[];
}

/** Parse a library document (or a bare array / single symbol), keeping the entries it cannot read. Throws when the text is not JSON. */
export function parseUserLibraryDocument(text: string): ParsedUserLibrary {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a JSON file');
  }
  const list: unknown[] = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw.symbols) ? raw.symbols : isRecord(raw) && isRecord(raw.block) ? [raw] : [];
  const out: ParsedUserLibrary = { symbols: [], unparsed: [], errors: [] };
  for (const item of list) {
    try {
      out.symbols.push(validateUserSymbol(item));
    } catch (err) {
      out.unparsed.push(item);
      out.errors.push((err as Error).message);
    }
  }
  return out;
}

/** Parse a library document into its readable entries. Throws when nothing in a non-empty file is readable. */
export function parseUserLibrary(text: string): UserSymbol[] {
  const parsed = parseUserLibraryDocument(text);
  if (parsed.symbols.length === 0 && parsed.unparsed.length > 0) throw new Error(`No valid symbols in the file: ${parsed.errors.join('; ')}`);
  return parsed.symbols;
}

export function serializeUserLibrary(symbols: readonly UserSymbol[], unparsed: readonly unknown[] = []): string {
  return JSON.stringify({ format: USER_LIBRARY_FORMAT, version: USER_LIBRARY_VERSION, symbols: [...symbols, ...unparsed] }, null, 1);
}

/** Block name of an entry we could not parse (to drop it once a readable symbol of that name replaces it). */
const unparsedName = (u: unknown): string | undefined => (isRecord(u) && isRecord(u.block) && typeof u.block.name === 'string' ? u.block.name.trim().toUpperCase() : undefined);

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export type UserLibraryListener = () => void;

export interface ImportReport {
  added: number;
  updated: number;
  /** Existing symbols left alone (`replace: false`). */
  skipped: number;
  /** Entries skipped because their name is reserved (a built-in symbol). */
  reserved: number;
  /** Entries rejected as malformed, with the reason. */
  rejected: string[];
}

export class UserLibrary {
  private symbols = new Map<string, UserSymbol>();
  private listeners = new Set<UserLibraryListener>();
  private store: UserLibraryStore;
  /** Reads and writes of the store, in order. */
  private writeChain: Promise<void> = Promise.resolve();
  /** Settles when the most recent `load()` has finished (resolved before any load is requested). */
  private loaded: Promise<void> = Promise.resolve();
  /** The last `load()` could not read or parse the library: writes are refused until a load succeeds. */
  private loadFailed = false;
  private loadError: string | null = null;
  /** Entries the last load could not parse, carried through every write untouched. */
  private unparsed: unknown[] = [];
  /** Set when the library could not be read or written (surfaced by the UI); cleared by a successful write. */
  lastError: string | null = null;
  /** Names an import must not take (built-in symbols); `library.ts` installs the real check. */
  private reserved: (name: string) => boolean = () => false;

  constructor(store: UserLibraryStore = memoryUserLibraryStore()) {
    this.store = store;
  }

  /** Install the persistence store (main.ts, once the bridge is known). */
  setStore(store: UserLibraryStore): void {
    this.store = store;
  }

  /** Install the default reserved-name check used by `importJson` (the built-in library cannot be imported here without a cycle). */
  setReservedNames(isReserved: (name: string) => boolean): void {
    this.reserved = isReserved;
  }

  /** False after a failed `load()`: the on-disk library is left alone until it can be read. */
  get writable(): boolean {
    return !this.loadFailed;
  }

  /**
   * Read the persisted library into the registry. Runs after any write already in
   * flight, and writes requested meanwhile wait for it. Entries added to the registry
   * before the load finished are kept (they win over a same-named entry on disk).
   * Returns the number of symbols in the registry.
   */
  async load(): Promise<number> {
    const run = async () => {
      let text: string | null = null;
      try {
        text = await this.store.read();
      } catch (err) {
        this.fail(`could not read the user library: ${errorMessage(err)}`);
        return;
      }
      let parsed: ParsedUserLibrary = { symbols: [], unparsed: [], errors: [] };
      if (text !== null && text.trim()) {
        try {
          parsed = parseUserLibraryDocument(text);
        } catch (err) {
          this.fail(`could not parse the user library: ${errorMessage(err)}`);
          return;
        }
      }
      this.loadFailed = false;
      this.loadError = null;
      for (const s of parsed.symbols) {
        if (this.symbols.has(s.block.name)) continue;
        this.symbols.set(s.block.name, s);
        this.register(s);
      }
      this.unparsed = parsed.unparsed.filter((u) => !this.symbols.has(unparsedName(u) ?? ''));
      const n = parsed.errors.length;
      this.lastError = n ? `${n} entr${n === 1 ? 'y' : 'ies'} could not be read by this version and ${n === 1 ? 'is' : 'are'} kept unchanged: ${parsed.errors.join('; ')}` : null;
      this.emit();
    };
    const pending = this.writeChain.then(run);
    this.loaded = pending;
    await pending;
    return this.symbols.size;
  }

  private fail(message: string): void {
    this.loadFailed = true;
    this.loadError = message;
    this.lastError = message;
    this.emit();
  }

  private refusal(): string {
    return `library not loaded (${this.loadError ?? 'unknown error'}); refusing to overwrite user-library.json. Fix or move the file and restart.`;
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
    registerSymbolRole(name, undefined);
  }

  /**
   * Queue a write of the whole library. Writes are serialised and wait for the initial
   * load; the document is serialised when the write runs so it reflects every change
   * made until then. Failures are recorded in `lastError`, never thrown. When the load
   * failed the write is refused (the file may hold symbols we could not read).
   */
  private persist(): Promise<void> {
    if (this.loadFailed) {
      // The load has already settled with an error: report it now so the caller can show it.
      this.lastError = this.refusal();
      return this.writeChain;
    }
    const write = async () => {
      if (this.loadFailed) throw new Error(this.refusal());
      await this.store.write(serializeUserLibrary(this.all(), this.unparsed));
    };
    this.writeChain = Promise.all([this.loaded, this.writeChain])
      .then(write)
      .then(
        () => void (this.lastError = null),
        (err: unknown) => void (this.lastError = errorMessage(err)),
      );
    return this.writeChain;
  }

  /** Wait for pending reads and writes (tests, shutdown). */
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
    return this.symbols.get(name) ?? this.symbols.get(name.trim().toUpperCase());
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

  /** Put an entry in the registry (replacing an unreadable entry of the same name) and register its prefix / role. */
  private enter(entry: UserSymbol): void {
    this.symbols.set(entry.block.name, entry);
    this.unparsed = this.unparsed.filter((u) => unparsedName(u) !== entry.block.name);
    this.register(entry);
  }

  /**
   * Add or replace a symbol (same block name, upper-cased). Returns the stored entry.
   * Throws when the block name is not a valid, whitespace-free block name.
   */
  put(sym: Omit<UserSymbol, 'created' | 'modified'> & Partial<Pick<UserSymbol, 'created' | 'modified'>>): UserSymbol {
    const named = normalizeSymbolName(sym.block.name);
    if ('error' in named) throw new Error(`Symbol ${named.error}`);
    const name = named.name;
    const now = Date.now();
    const prev = this.symbols.get(name);
    const wdtype = normalizeWdtype(sym.wdtype);
    const entry: UserSymbol = {
      ...sym,
      block: name === sym.block.name ? sym.block : { ...sym.block, name },
      family: sym.family.trim().toUpperCase() || 'DEV',
      created: sym.created ?? prev?.created ?? now,
      modified: sym.modified ?? now,
    };
    if (wdtype) entry.wdtype = wdtype;
    else delete entry.wdtype;
    this.enter(entry);
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

  /** Rename a symbol (block name changes, everything else is kept). Fails when the new name exists or is invalid. */
  rename(oldName: string, newName: string): boolean {
    const s = this.get(oldName);
    const named = normalizeSymbolName(newName);
    if (!s || 'error' in named || this.symbols.has(named.name)) return false;
    this.symbols.delete(s.block.name);
    this.unregister(s.block.name);
    this.enter({ ...s, block: { ...s.block, name: named.name }, modified: Date.now() });
    void this.persist();
    this.emit();
    return true;
  }

  /** JSON export of some symbols (default: the whole library). */
  exportJson(names?: readonly string[]): string {
    const list = names ? names.map((n) => this.get(n)).filter((s): s is UserSymbol => !!s) : this.all();
    return serializeUserLibrary(list);
  }

  /**
   * Merge a JSON library / symbol file into the registry. Malformed entries are rejected
   * (listed in the report with their name and the reason) and names for which
   * `isReserved` (default: the check installed with `setReservedNames`, i.e. built-in
   * symbols) is true are skipped. Throws when the text is not JSON or holds no readable
   * symbol.
   */
  importJson(text: string, opts: { replace?: boolean; isReserved?: (name: string) => boolean } = {}): ImportReport {
    const parsed = parseUserLibraryDocument(text);
    if (parsed.symbols.length === 0 && parsed.unparsed.length > 0) throw new Error(`No valid symbols in the file: ${parsed.errors.join('; ')}`);
    const report: ImportReport = { added: 0, updated: 0, skipped: 0, reserved: 0, rejected: parsed.errors };
    const isReserved = opts.isReserved ?? this.reserved;
    for (const s of parsed.symbols) {
      if (isReserved(s.block.name)) {
        report.reserved += 1;
        continue;
      }
      const exists = this.symbols.has(s.block.name);
      if (exists && opts.replace === false) {
        report.skipped += 1;
        continue;
      }
      this.enter(s);
      if (exists) report.updated += 1;
      else report.added += 1;
    }
    if (report.added || report.updated) {
      void this.persist();
      this.emit();
    } else if (report.rejected.length) {
      this.lastError = `Import rejected ${report.rejected.length} malformed entr${report.rejected.length === 1 ? 'y' : 'ies'}: ${report.rejected.join('; ')}`;
    }
    return report;
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
