import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
type Preferences = Record<string, string>;
type Contents = {
  getURL(): string;
  isDestroyed(): boolean;
  isCrashed(): boolean;
  executeJavaScriptInIsolatedWorld(world: number, scripts: { code: string }[]): Promise<unknown>;
};
type Store = {
  read(): Promise<Preferences | null>;
  checkpoint(contents: unknown, migration?: boolean): Promise<Preferences>;
  latest(): Preferences | null;
};
const {
  MAX_PREFERENCE_BYTES, MIGRATION_KEY, CHECKPOINT_NAME, MIGRATION_NAME,
  preferenceDictionary, decodePreferences, SNAPSHOT_SCRIPT, snapshotPreferences, createPreferenceStore,
} = require('../electron/renderer-preferences.cjs') as {
  MAX_PREFERENCE_BYTES: number;
  MIGRATION_KEY: string;
  CHECKPOINT_NAME: string;
  MIGRATION_NAME: string;
  preferenceDictionary(values: unknown): Preferences;
  decodePreferences(text: unknown): Preferences;
  SNAPSHOT_SCRIPT: string;
  snapshotPreferences(contents: Contents): Promise<Preferences>;
  createPreferenceStore(options: {
    stateDir(): string;
    fs?: typeof fs;
    write?: (file: string, text: string) => Promise<unknown>;
    snapshot?: (contents: unknown) => Promise<unknown>;
  }): Store;
};
const { createAtomicWriter } = require('../electron/atomic-write.cjs') as {
  createAtomicWriter(files: typeof fs, options: {
    hooks: { beforeRename(tmp: string, destination: string): Promise<void> };
  }): { atomicWriteFile(file: string, text: string): Promise<unknown> };
};

const directories: string[] = [];
async function profile() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'jcad-preferences-test-'));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class TestStorage {
  private readonly values: Map<string, string>;
  constructor(entries: [string, string][]) { this.values = new Map(entries); }
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
}
function snapshotText(entries: [string, string][]) {
  const storage = new TestStorage(entries);
  // Page code can shadow methods on the instance; the isolated script uses native prototypes.
  Object.defineProperties(storage, {
    key: { value: () => { throw new Error('instance key must not run'); } },
    getItem: { value: () => { throw new Error('instance getItem must not run'); } },
  });
  return runInNewContext(SNAPSHOT_SCRIPT, { localStorage: storage, Storage: TestStorage, TextEncoder }) as string;
}
function contents(execute: Contents['executeJavaScriptInIsolatedWorld'], url = 'jcad://app/index.html'): Contents {
  return { getURL: () => url, isDestroyed: () => false, isCrashed: () => false, executeJavaScriptInIsolatedWorld: execute };
}

describe('bounded renderer preference dictionaries', () => {
  it('preserves arbitrary string keys safely and excludes the internal migration marker', () => {
    const source = JSON.parse('{"__proto__":"own value","constructor":"stored","toJSON":"text","empty":""}') as Preferences;
    source[MIGRATION_KEY] = '1';
    const values = preferenceDictionary(source);
    expect(Object.getPrototypeOf(values)).toBeNull();
    expect(Object.hasOwn(values, '__proto__')).toBe(true);
    expect(values['__proto__']).toBe('own value');
    expect(values['constructor']).toBe('stored');
    expect(values['toJSON']).toBe('text');
    expect(values['empty']).toBe('');
    expect(Object.hasOwn(values, MIGRATION_KEY)).toBe(false);
    expect(decodePreferences(JSON.stringify(values))).toEqual(values);
  });

  it('rejects getters without evaluating them, custom prototypes, symbols and non-string values', () => {
    const getter = vi.fn(() => 'secret');
    const accessor = Object.defineProperty({}, 'theme', { enumerable: true, get: getter });
    const hidden = Object.defineProperty({}, 'theme', { value: 'dark' });
    for (const invalid of [accessor, hidden, Object.create({ theme: 'dark' }), { [Symbol('theme')]: 'dark' },
      { theme: null }, { theme: 7 }, { theme: {} }, { theme: () => 'dark' }, ['dark'], null]) {
      expect(() => preferenceDictionary(invalid)).toThrow(/Invalid renderer preferences/);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(preferenceDictionary(Object.assign(Object.create(null), { theme: 'dark' }))).toEqual({ theme: 'dark' });
  });

  it('counts JSON escapes, UTF-8 keys and values, and exact object overhead at the limit', () => {
    const exact = { a: 'x'.repeat(MAX_PREFERENCE_BYTES - Buffer.byteLength('{"a":""}')) };
    expect(Buffer.byteLength(JSON.stringify(preferenceDictionary(exact)))).toBe(MAX_PREFERENCE_BYTES);
    expect(() => preferenceDictionary({ a: `${exact.a}x` })).toThrow(/8 MiB/);
    const escaped = { a: '"'.repeat((MAX_PREFERENCE_BYTES - 8) / 2) };
    expect(Buffer.byteLength(JSON.stringify(preferenceDictionary(escaped)))).toBe(MAX_PREFERENCE_BYTES);
    expect(() => preferenceDictionary({ a: `${escaped.a}\\` })).toThrow(/8 MiB/);
    expect(() => preferenceDictionary({ 雷: '雷'.repeat(Math.floor(MAX_PREFERENCE_BYTES / 3)) })).toThrow(/8 MiB/);
    expect(preferenceDictionary({ '\n"雷': '\u0000\\Δ' })).toEqual({ '\n"雷': '\u0000\\Δ' });
  });

  it('rejects oversized raw JSON, malformed files and structurally invalid dictionaries', () => {
    expect(() => decodePreferences(`{"a":"${'雷'.repeat(Math.floor(MAX_PREFERENCE_BYTES / 3))}"}`)).toThrow(/8 MiB/);
    for (const invalid of ['{', '[]', 'null', '{"theme":true}', '{"theme":{"value":"dark"}}']) {
      expect(() => decodePreferences(invalid)).toThrow();
    }
    expect(() => decodePreferences(' '.repeat(MAX_PREFERENCE_BYTES + 1))).toThrow(/8 MiB/);
    expect(decodePreferences('{}')).toEqual({});
  });
});

describe('isolated renderer snapshots', () => {
  it('serializes real storage values including escaped and prototype-named keys', () => {
    const text = snapshotText([['__proto__', 'safe'], ['constructor', 'value'], ['\n"雷', '\u0000\\Δ'], [MIGRATION_KEY, '1']]);
    expect(decodePreferences(text)).toEqual(Object.fromEntries([['__proto__', 'safe'], ['constructor', 'value'], ['\n"雷', '\u0000\\Δ']]));
    expect(Object.hasOwn(JSON.parse(text), '__proto__')).toBe(true);
    expect(Object.hasOwn(JSON.parse(text), MIGRATION_KEY)).toBe(false);
  });

  it('rejects over-budget snapshots before they cross the process boundary', () => {
    expect(Buffer.byteLength(snapshotText([['a', 'x'.repeat(MAX_PREFERENCE_BYTES - 8)]]))).toBe(MAX_PREFERENCE_BYTES);
    expect(() => snapshotText([['a', '"'.repeat((MAX_PREFERENCE_BYTES - 8) / 2 + 1)]])).toThrow(/8 MiB/);
    expect(() => snapshotText([['雷', '雷'.repeat(Math.floor(MAX_PREFERENCE_BYTES / 3))]])).toThrow(/8 MiB/);
  });

  it('captures only the exact healthy application page and validates its returned JSON', async () => {
    const execute = vi.fn(async () => '{"theme":"dark"}');
    expect(await snapshotPreferences(contents(execute, 'jcad://app/index.html?startup=1#tools'))).toEqual({ theme: 'dark' });
    expect(execute).toHaveBeenCalledWith(999, [{ code: SNAPSHOT_SCRIPT }]);
    execute.mockClear();
    for (const url of ['https://app/index.html', 'jcad://other/index.html', 'jcad://app/assets/page.html',
      'jcad://user@app/index.html', 'jcad://app:123/index.html']) {
      await expect(snapshotPreferences(contents(execute, url))).rejects.toThrow(/trusted preferences renderer/);
    }
    await expect(snapshotPreferences({ ...contents(execute), isDestroyed: () => true })).rejects.toThrow();
    await expect(snapshotPreferences({ ...contents(execute), isCrashed: () => true })).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    await expect(snapshotPreferences(contents(async () => '{"theme":4}'))).rejects.toThrow(/Invalid renderer preferences/);
  });

  it('times out a hung capture without committing a late result or poisoning later saves', async () => {
    const dir = await profile();
    vi.useFakeTimers();
    const late = deferred<string>();
    const write = vi.fn(async () => undefined);
    const store = createPreferenceStore({ stateDir: () => dir, write });
    const first = store.checkpoint(contents(async () => late.promise)).then(() => null, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toEqual(expect.objectContaining({ message: 'Renderer preference checkpoint timed out' }));
    expect(write).not.toHaveBeenCalled();
    await store.checkpoint(contents(async () => '{"theme":"fresh"}'));
    expect(write).toHaveBeenCalledExactlyOnceWith(join(dir, CHECKPOINT_NAME), '{"theme":"fresh"}');
    late.resolve('{"theme":"stale"}');
    await Promise.resolve();
    expect(write).toHaveBeenCalledTimes(1);
  });
});

describe('atomic renderer preference checkpoints', () => {
  it('returns null only for a missing checkpoint and reads a valid empty checkpoint', async () => {
    const dir = await profile();
    const store = createPreferenceStore({ stateDir: () => dir });
    expect(await store.read()).toBeNull();
    await fs.writeFile(join(dir, CHECKPOINT_NAME), '{}');
    expect(await store.read()).toEqual({});
    await fs.writeFile(join(dir, CHECKPOINT_NAME), '{bad');
    await expect(store.read()).rejects.toThrow();
    await fs.writeFile(join(dir, CHECKPOINT_NAME), ' '.repeat(MAX_PREFERENCE_BYTES + 1));
    await expect(store.read()).rejects.toThrow(/larger/);
  });

  it('serializes capture and commit together before admitting a later capture', async () => {
    const dir = await profile();
    const capture = deferred<Preferences>();
    const commit = deferred<void>();
    const events: string[] = [];
    let sequence = 0;
    const store = createPreferenceStore({
      stateDir: () => dir,
      snapshot: async () => {
        const current = ++sequence;
        events.push(`capture ${current}`);
        return current === 1 ? capture.promise : { theme: 'new' };
      },
      write: async (_file, text) => {
        events.push(`write ${text}`);
        if (text === '{"theme":"old"}') await commit.promise;
      },
    });
    const first = store.checkpoint({});
    const second = store.checkpoint({});
    await Promise.resolve();
    expect(events).toEqual(['capture 1']);
    capture.resolve({ theme: 'old' });
    await vi.waitFor(() => expect(events).toContain('write {"theme":"old"}'));
    expect(events).toEqual(['capture 1', 'write {"theme":"old"}']);
    commit.resolve(undefined);
    await Promise.all([first, second]);
    expect(events).toEqual(['capture 1', 'write {"theme":"old"}', 'capture 2', 'write {"theme":"new"}']);
  });

  it('preserves the last disk checkpoint after an atomic commit fault and writes no migration marker', async () => {
    const dir = await profile();
    const file = join(dir, CHECKPOINT_NAME);
    const previous = '{"theme":"previous","deleted":"still present"}';
    await fs.writeFile(file, previous);
    const writer = createAtomicWriter(fs, { hooks: {
      beforeRename: async (_tmp, destination) => {
        if (destination === file) throw Object.assign(new Error('disk full before replace'), { code: 'ENOSPC' });
      },
    } });
    const store = createPreferenceStore({ stateDir: () => dir, write: writer.atomicWriteFile, snapshot: async () => ({ theme: 'new' }) });
    await expect(store.checkpoint({}, true)).rejects.toThrow(/ENOSPC/);
    expect(await fs.readFile(file, 'utf8')).toBe(previous);
    await expect(fs.stat(join(dir, MIGRATION_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readdir(dir)).toEqual([CHECKPOINT_NAME]);
  });

  it('commits the checkpoint before the migration marker and retains it if the marker write fails', async () => {
    const dir = await profile();
    const events: string[] = [];
    const writer = createAtomicWriter(fs, { hooks: {
      beforeRename: async (_tmp, destination) => {
        events.push(destination);
        if (destination === join(dir, MIGRATION_NAME)) throw Object.assign(new Error('marker failed'), { code: 'EACCES' });
      },
    } });
    const store = createPreferenceStore({ stateDir: () => dir, write: writer.atomicWriteFile, snapshot: async () => ({ theme: 'latest' }) });
    await expect(store.checkpoint({}, true)).rejects.toThrow(/EACCES/);
    expect(events).toEqual([join(dir, CHECKPOINT_NAME), join(dir, MIGRATION_NAME)]);
    expect(await store.read()).toEqual({ theme: 'latest' });
    await expect(fs.stat(join(dir, MIGRATION_NAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovery uses the latest complete dictionary, preserving updates and deletions across launches', async () => {
    const dir = await profile();
    let current: Preferences = { theme: 'old', plugin: 'removed later', [MIGRATION_KEY]: '1' };
    const store = createPreferenceStore({ stateDir: () => dir, snapshot: async () => current });
    await store.checkpoint({}, true);
    expect(await fs.readFile(join(dir, MIGRATION_NAME), 'utf8')).toBe('1');
    current = { theme: 'new' };
    await store.checkpoint({});
    expect(store.latest()).toEqual({ theme: 'new' });
    const recovered = await createPreferenceStore({ stateDir: () => dir }).read();
    expect(recovered).toEqual({ theme: 'new' });
    expect(Object.hasOwn(recovered!, 'plugin')).toBe(false);
    expect(Object.hasOwn(recovered!, MIGRATION_KEY)).toBe(false);
    current = {};
    await store.checkpoint({});
    expect(store.latest()).toEqual({});
    expect(await createPreferenceStore({ stateDir: () => dir }).read()).toEqual({});
  });
});
