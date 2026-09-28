/**
 * Catalog packs: signed manufacturer catalogs sold separately from the (GPL) app.
 *
 * A pack is one `*.jcadpack.json` file issued to a buyer (see docs/CATALOG-PACKS.md
 * and scripts/pack-sign.mjs). The publisher signs the canonical JSON of the document
 * (keys sorted, no whitespace, `signature` member removed) with an Ed25519 key; the
 * app carries the matching public key(s) in `pack-keys.json` and verifies the file
 * with WebCrypto before installing it. An unsigned, tampered or unknown-key pack is
 * refused. An *expired* pack is still loaded (the buyer keeps the data they paid
 * for) but is flagged so the UI can show "expired on <date>" and the log a warning.
 *
 * Honesty note: this is a free-software application. The check cannot stop someone
 * who rebuilds the app without it; it exists to make honest use easy (one file,
 * "Licensed to <name>", refuses corrupt files) and casual sharing unattractive
 * (the buyer's name is inside every pack and cannot be edited without breaking
 * the signature).
 *
 * Persistence mirrors the user library: installed packs are copied unchanged into
 * `userData/packs/` through the `packsList/packsRead/packsWrite/packsRemove` bridge
 * (atomic writes in electron/main.cjs), or into one localStorage entry
 * (`jcad.packs.v1`) in a browser. The file is stored verbatim so its signature keeps
 * verifying on every start. Pure of DOM: the store and the clock are injected so
 * the module works under vitest.
 */
import { normaliseCatalog, setPackCatalog, type CatalogItem } from './catalog';
import builtinKeys from './pack-keys.json';

export const PACK_FORMAT = 'jcad-pack/1';
export const PACKS_KEY = 'jcad.packs.v1';
export const MAX_PACK_BYTES = 20 * 1024 * 1024;
/** File names the store accepts (also enforced by electron/main.cjs). */
export const PACK_FILE_RE = /^[A-Za-z0-9._-]+\.jcadpack\.json$/;
export const PACK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Publisher public keys compiled into this build: keyId -> base64 raw Ed25519 key. */
export const PACK_KEYS: Readonly<Record<string, string>> = builtinKeys as Record<string, string>;

export interface PackLicense {
  licensee: string;
  /** YYYY-MM-DD. */
  issued: string;
  /** YYYY-MM-DD (last valid day) or null for a perpetual licence. */
  expires: string | null;
  seats: number;
}

export interface PackSignature {
  alg: string;
  keyId: string;
  /** base64 */
  value: string;
}

export interface PackDocument {
  format: typeof PACK_FORMAT;
  id: string;
  name: string;
  publisher: string;
  version: string;
  kind: string;
  description?: string;
  license: PackLicense;
  /** Raw catalog rows as published (normalised by `packCatalogItems`). */
  catalog: unknown[];
  signature?: PackSignature;
  /** Members this version does not know are kept (they are part of the signed payload). */
  [extra: string]: unknown;
}

export interface VerifyResult {
  ok: boolean;
  /** Why the pack was refused (`ok === false`). */
  reason?: string;
  keyId?: string;
  licensee: string;
  expires: string | null;
  /** True when `expires` is before the verification date. Never set for a refused pack. */
  expired: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------- canonical JSON

/**
 * Deterministic JSON for signing: object keys sorted, no whitespace, `undefined`
 * members dropped, numbers / strings as JSON.stringify writes them. Must stay
 * byte-for-byte identical to `canonicalJson` in scripts/pack-sign.mjs.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

/** The bytes a signature covers: the document without its `signature` member. */
export function signingPayload(pack: Record<string, unknown>): Uint8Array {
  const { signature: _sig, ...rest } = pack;
  return new TextEncoder().encode(canonicalJson(rest));
}

// ---------------------------------------------------------------- parsing

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s: unknown): s is string => typeof s === 'string' && ISO_DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/**
 * Parse and structurally validate a pack file. Throws with a message naming the
 * first problem. Signature *presence* is checked here (unsigned packs are never
 * accepted); its validity is `verifyPack`'s job.
 */
export function parsePack(text: string): PackDocument {
  if (typeof text !== 'string') throw new Error('Not a text file');
  if (text.length > MAX_PACK_BYTES) throw new Error(`Pack is larger than ${MAX_PACK_BYTES / (1024 * 1024)} MB`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a JSON file');
  }
  if (!isRecord(raw)) throw new Error('Not a pack: the file is not a JSON object');
  if (raw.format !== PACK_FORMAT) throw new Error(`Not a JCad pack (format is ${JSON.stringify(raw.format ?? null)}, expected "${PACK_FORMAT}")`);
  const str = (k: string): string => {
    const v = raw[k];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Pack has no ${k}`);
    return v;
  };
  const id = str('id');
  if (!PACK_ID_RE.test(id)) throw new Error(`Pack id "${id}" is not valid (letters, digits, . _ -; up to 64 characters)`);
  const name = str('name');
  const publisher = str('publisher');
  const version = str('version');
  const kind = str('kind');
  if (kind !== 'catalog') throw new Error(`This version only installs catalog packs (pack kind is "${kind}")`);
  if (!Array.isArray(raw.catalog)) throw new Error('Pack has no catalog array');
  const lic = raw.license;
  if (!isRecord(lic)) throw new Error('Pack has no license block');
  if (typeof lic.licensee !== 'string' || !lic.licensee.trim()) throw new Error('Pack license has no licensee');
  if (!isIsoDate(lic.issued)) throw new Error('Pack license has no valid issued date (YYYY-MM-DD)');
  if (lic.expires !== null && lic.expires !== undefined && !isIsoDate(lic.expires)) throw new Error('Pack license expiry is not a YYYY-MM-DD date or null');
  const sig = raw.signature;
  if (sig === undefined) throw new Error('Unsigned pack: only packs signed by the publisher can be installed');
  if (!isRecord(sig) || typeof sig.alg !== 'string' || typeof sig.keyId !== 'string' || typeof sig.value !== 'string') throw new Error('Pack signature block is malformed');
  return {
    ...raw,
    format: PACK_FORMAT,
    id,
    name,
    publisher,
    version,
    kind,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    license: { licensee: lic.licensee, issued: lic.issued, expires: lic.expires ?? null, seats: typeof lic.seats === 'number' && lic.seats > 0 ? lic.seats : 1 },
    catalog: raw.catalog,
    signature: { alg: sig.alg, keyId: sig.keyId, value: sig.value },
  };
}

// ---------------------------------------------------------------- verification

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('not base64');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** True when the licence's last valid day (UTC) is before `now`. */
export function isExpired(expires: string | null | undefined, now: number = Date.now()): boolean {
  if (!expires || !ISO_DATE_RE.test(expires)) return false;
  const end = Date.parse(`${expires}T00:00:00Z`) + 86_400_000;
  return Number.isFinite(end) && end <= now;
}

/** Ed25519 verification with WebCrypto (Chromium 130 / Node 22). Injected for tests. */
export interface SubtleLike {
  importKey(format: 'raw', keyData: Uint8Array, algorithm: { name: string }, extractable: boolean, usages: KeyUsage[]): Promise<CryptoKey>;
  verify(algorithm: { name: string }, key: CryptoKey, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
}

function subtle(): SubtleLike {
  const s = (globalThis as { crypto?: { subtle?: SubtleLike } }).crypto?.subtle;
  if (!s) throw new Error('WebCrypto is not available in this environment');
  return s;
}

/**
 * Verify a parsed pack against the publisher keys. Never throws: every failure
 * is reported as `{ ok: false, reason }`. `expired` is informational (see the
 * module comment: expired packs still load).
 */
export async function verifyPack(pack: PackDocument, keys: Readonly<Record<string, string>> = PACK_KEYS, now: number = Date.now(), crypto: SubtleLike | null = null): Promise<VerifyResult> {
  const base = { licensee: pack.license.licensee, expires: pack.license.expires, expired: false };
  const sig = pack.signature;
  if (!sig) return { ...base, ok: false, reason: 'Unsigned pack: only packs signed by the publisher can be installed' };
  if (sig.alg !== 'ed25519') return { ...base, ok: false, keyId: sig.keyId, reason: `Unsupported signature algorithm "${sig.alg}" (this version knows ed25519)` };
  const pub = keys[sig.keyId];
  if (!pub) return { ...base, ok: false, keyId: sig.keyId, reason: `The pack was signed with key "${sig.keyId}", which this version of JCad does not know (known: ${Object.keys(keys).join(', ') || 'none'}). Update the app or ask the publisher for a pack signed with a current key.` };
  let ok = false;
  try {
    const c = crypto ?? subtle();
    const rawKey = base64ToBytes(pub);
    if (rawKey.length !== 32) throw new Error('bad key length');
    const key = await c.importKey('raw', rawKey, { name: 'Ed25519' }, false, ['verify']);
    ok = await c.verify({ name: 'Ed25519' }, key, base64ToBytes(sig.value), signingPayload(pack as unknown as Record<string, unknown>));
  } catch (err) {
    return { ...base, ok: false, keyId: sig.keyId, reason: `Signature could not be checked: ${errorMessage(err)}` };
  }
  if (!ok) return { ...base, ok: false, keyId: sig.keyId, reason: 'The signature does not match the pack contents: the file was modified after it was issued, or it is corrupt. Ask the publisher for a fresh copy.' };
  return { ...base, ok: true, keyId: sig.keyId, expired: isExpired(pack.license.expires, now) };
}

/** Catalog rows of a pack, normalised like the built-in catalog, tagged with the pack name as their source. */
export function packCatalogItems(pack: PackDocument): CatalogItem[] {
  return normaliseCatalog(pack.catalog, 'pack', pack.name);
}

/** Stable, store-safe file name for a pack id. */
export function packFileName(id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/\.{2,}/g, '.').replace(/^[._-]+/, '') || 'pack';
  return `${safe}.jcadpack.json`;
}

export function validPackFileName(name: string): boolean {
  return typeof name === 'string' && name.length <= 200 && PACK_FILE_RE.test(name) && !name.includes('..');
}

// ---------------------------------------------------------------- persistence

export interface PackStore {
  /** File names of the stored packs. */
  list(): Promise<string[]>;
  /** The stored text, or null when the file is missing. */
  read(name: string): Promise<string | null>;
  write(name: string, text: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Human-readable location of the files (shown in the Packs dialog), when known. */
  location?(): Promise<string | null>;
}

/** Electron bridge (see electron/preload.cjs). */
export interface PacksBridge {
  packsList(): Promise<string[]>;
  packsRead(name: string): Promise<string | null>;
  packsWrite(name: string, text: string): Promise<void>;
  packsRemove(name: string): Promise<void>;
  packsDir?(): Promise<string>;
  /** Native file picker for a pack; resolves null when cancelled. */
  pickPackFile?(): Promise<{ name: string; text: string } | null>;
}

export function bridgePackStore(b: PacksBridge): PackStore {
  return {
    list: () => b.packsList(),
    read: (n) => b.packsRead(n),
    write: (n, t) => b.packsWrite(n, t),
    remove: (n) => b.packsRemove(n),
    location: async () => (b.packsDir ? b.packsDir() : null),
  };
}

export interface KeyValueStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Browser fallback: every pack in one localStorage entry ({ fileName: text }). */
export function localPackStore(storage: KeyValueStorageLike, key = PACKS_KEY): PackStore {
  const readAll = (): Record<string, string> => {
    const raw = storage.getItem(key);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isRecord(parsed)) return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string' && validPackFileName(k)) out[k] = v;
      return out;
    } catch {
      return {};
    }
  };
  return {
    async list() {
      return Object.keys(readAll()).sort();
    },
    async read(name) {
      return readAll()[name] ?? null;
    },
    async write(name, text) {
      if (!validPackFileName(name)) throw new Error('Invalid pack file name');
      const all = readAll();
      all[name] = text;
      storage.setItem(key, JSON.stringify(all));
    },
    async remove(name) {
      const all = readAll();
      if (!(name in all)) return;
      delete all[name];
      storage.setItem(key, JSON.stringify(all));
    },
    location: async () => `browser storage (${key})`,
  };
}

/** No persistence beyond this process (default before main.ts installs a store; unit tests). */
export function memoryPackStore(): PackStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async list() {
      return [...files.keys()].sort();
    },
    async read(name) {
      return files.get(name) ?? null;
    },
    async write(name, text) {
      if (!validPackFileName(name)) throw new Error('Invalid pack file name');
      files.set(name, text);
    },
    async remove(name) {
      files.delete(name);
    },
  };
}

// ---------------------------------------------------------------- registry

export interface InstalledPack {
  /** File name in the store. */
  file: string;
  doc: PackDocument;
  verified: VerifyResult;
  items: CatalogItem[];
}

/** One-line status for lists and logs. */
export function packStatus(p: InstalledPack): string {
  if (!p.verified.ok) return `refused: ${p.verified.reason ?? 'invalid'}`;
  return p.verified.expired ? `expired on ${p.verified.expires}` : p.verified.expires ? `valid until ${p.verified.expires}` : 'valid (perpetual)';
}

export type PackListener = () => void;

/**
 * Installed packs, in install order. Catalog rows of every valid pack are merged
 * into the catalog lookups after the user catalog and before the built-in one
 * (`setPackCatalog`). Verification happens on install and again on every load,
 * so editing a stored file disables it (`load()` reports the reason and leaves
 * the file alone).
 */
export class PackRegistry {
  private packs: InstalledPack[] = [];
  private listeners = new Set<PackListener>();
  private store: PackStore;
  private keys: Readonly<Record<string, string>>;
  private now: () => number;
  private crypto: SubtleLike | null;
  /** Problems from the last `load()` (unreadable or refused files), for the log / dialog. */
  errors: string[] = [];
  /** Where the store keeps the files (filled by `load()`), for the dialog. */
  location: string | null = null;
  /** Set when `setPackCatalog` should not be called (tests that only exercise the registry). */
  private publish: (items: CatalogItem[]) => void;

  constructor(opts: { store?: PackStore; keys?: Readonly<Record<string, string>>; now?: () => number; crypto?: SubtleLike | null; publish?: (items: CatalogItem[]) => void } = {}) {
    this.store = opts.store ?? memoryPackStore();
    this.keys = opts.keys ?? PACK_KEYS;
    this.now = opts.now ?? (() => Date.now());
    this.crypto = opts.crypto ?? null;
    this.publish = opts.publish ?? setPackCatalog;
  }

  /** Install the persistence store (main.ts, once the bridge is known). */
  setStore(store: PackStore): void {
    this.store = store;
  }
  /** Replace the trusted keys (tests; a future "import publisher key" feature). */
  setKeys(keys: Readonly<Record<string, string>>): void {
    this.keys = keys;
  }

  onChange(fn: PackListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    this.publish(this.catalogItems());
    for (const fn of this.listeners) fn();
  }

  list(): InstalledPack[] {
    return [...this.packs];
  }
  get size(): number {
    return this.packs.length;
  }
  get(id: string): InstalledPack | undefined {
    return this.packs.find((p) => p.doc.id === id);
  }
  /** Catalog rows of every accepted pack, in install order (expired packs included). */
  catalogItems(): CatalogItem[] {
    return this.packs.filter((p) => p.verified.ok).flatMap((p) => p.items);
  }

  /** Parse + verify without installing (the dialog uses it to preview a file). */
  async check(text: string): Promise<{ doc: PackDocument; verified: VerifyResult }> {
    const doc = parsePack(text);
    const verified = await verifyPack(doc, this.keys, this.now(), this.crypto);
    return { doc, verified };
  }

  /**
   * Read every stored pack, verify it and merge the valid ones. Files that cannot be
   * parsed or verified are skipped (listed in `errors`) and left in the store so a
   * later version with a newer key can still load them.
   */
  async load(): Promise<{ loaded: number; errors: string[] }> {
    const errors: string[] = [];
    let names: string[] = [];
    try {
      names = (await this.store.list()).filter(validPackFileName).sort();
    } catch (err) {
      errors.push(`could not list the packs folder: ${errorMessage(err)}`);
    }
    try {
      this.location = this.store.location ? await this.store.location() : null;
    } catch {
      this.location = null;
    }
    const next: InstalledPack[] = [];
    for (const file of names) {
      try {
        const text = await this.store.read(file);
        if (text === null) continue;
        const { doc, verified } = await this.check(text);
        if (!verified.ok) {
          errors.push(`${file}: ${verified.reason}`);
          continue;
        }
        if (next.some((p) => p.doc.id === doc.id)) {
          errors.push(`${file}: duplicate pack id "${doc.id}" (already loaded from another file)`);
          continue;
        }
        next.push({ file, doc, verified, items: packCatalogItems(doc) });
      } catch (err) {
        errors.push(`${file}: ${errorMessage(err)}`);
      }
    }
    // Packs installed while the load was running (same id) win over the stored copy.
    for (const p of this.packs) if (!next.some((q) => q.doc.id === p.doc.id)) next.push(p);
    this.packs = next;
    this.errors = errors;
    this.emit();
    return { loaded: this.packs.length, errors };
  }

  /**
   * Verify a pack file and install it: the text is stored verbatim under a name derived
   * from the pack id (an older copy of the same id is replaced), then merged into the
   * catalog. Throws with the refusal reason when the pack cannot be accepted. An expired
   * pack is accepted; check `verified.expired` on the result to warn the user.
   */
  async install(text: string, fileName?: string): Promise<InstalledPack> {
    const { doc, verified } = await this.check(text);
    if (!verified.ok) throw new Error(verified.reason ?? 'invalid pack');
    const file = fileName && validPackFileName(fileName) ? fileName : packFileName(doc.id);
    const previous = this.get(doc.id);
    await this.store.write(file, text);
    if (previous && previous.file !== file) {
      try {
        await this.store.remove(previous.file);
      } catch {
        /* the new file is in place; the old one is skipped as a duplicate id on the next load */
      }
    }
    const entry: InstalledPack = { file, doc, verified, items: packCatalogItems(doc) };
    const i = this.packs.findIndex((p) => p.doc.id === doc.id);
    if (i >= 0) this.packs[i] = entry;
    else this.packs.push(entry);
    this.emit();
    return entry;
  }

  /** Remove a pack by id (the stored file is deleted). False when no such pack is installed. */
  async remove(id: string): Promise<boolean> {
    const p = this.get(id);
    if (!p) return false;
    await this.store.remove(p.file);
    this.packs = this.packs.filter((q) => q !== p);
    this.emit();
    return true;
  }
}

/** The application-wide registry (main.ts installs the persistent store and loads it). */
export const packRegistry = new PackRegistry();
