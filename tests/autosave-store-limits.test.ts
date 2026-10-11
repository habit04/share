import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { MemFs } from './helpers/memfs';
import { Rng } from './helpers/fuzz';

const require = createRequire(import.meta.url);
interface Store {
  list(): Promise<Array<{ name: string }>>;
  read(name: string): Promise<string | null>;
  write(name: string, text: string, meta: unknown): Promise<void>;
}
const { createAutosaveStore } = require('../electron/autosave-store.cjs') as { createAutosaveStore(dir: string, deps: { fs: MemFs; uuid?: () => string }): Store };
const { MAX_DRAWING_BYTES } = require('../electron/resource-limits.cjs') as { MAX_DRAWING_BYTES: number };
const DIR = '/data/autosave';
const NAME = '11111111-1111-4111-8111-111111111111.sv.dxf';
const MAX_METADATA_BYTES = 8 * 1024 * 1024;

function fixture() {
  const fs = new MemFs(new Rng(17));
  const sizes = new Map<string, number>();
  const open = fs.open.bind(fs);
  fs.open = async (file, flags) => {
    const handle = await open(file, flags);
    const key = file.replace(/\\/g, '/');
    const stat = handle.stat;
    handle.stat = async () => ({ ...await stat(), ...(sizes.has(key) ? { size: sizes.get(key)! } : {}) });
    return handle;
  };
  fs.put(`${DIR}/${NAME}`, 'original recovery');
  fs.put(`${DIR}/index.json`, JSON.stringify({ version: 1, entries: { [NAME]: { title: 'Recovered drawing', savedAt: 1 } } }));
  return { fs, sizes, store: createAutosaveStore(DIR, { fs }) };
}

describe('recovery store byte limits', () => {
  it('rejects an oversized recovery copy before reading, keeps it listed and retries after repair', async () => {
    const { fs, sizes, store } = fixture();
    sizes.set(`${DIR}/${NAME}`, MAX_DRAWING_BYTES + 1);
    await expect(store.read(NAME)).rejects.toThrow(new RegExp(`${NAME.replace(/\./g, '\\.')} is larger than 128 MB`));
    expect(fs.trace.some((entry) => entry.includes('fh.read'))).toBe(false);
    expect(fs.trace.some((entry) => entry.includes('fh.close'))).toBe(true);
    expect(fs.get(`${DIR}/${NAME}`)).toBe('original recovery');
    expect((await store.list()).map((entry) => entry.name)).toEqual([NAME]);
    sizes.clear();
    expect(await store.read(NAME)).toBe('original recovery');
  });

  it('reports an oversized index without modifying recovery files, then retries initialization', async () => {
    const { fs, sizes, store } = fixture();
    const index = fs.get(`${DIR}/index.json`);
    sizes.set(`${DIR}/index.json`, MAX_METADATA_BYTES + 1);
    await expect(store.list()).rejects.toThrow(/index\.json is larger than 8 MB/);
    expect(fs.get(`${DIR}/index.json`)).toBe(index);
    expect(fs.get(`${DIR}/${NAME}`)).toBe('original recovery');
    expect(fs.trace.some((entry) => entry.includes('fh.read'))).toBe(false);
    sizes.clear();
    expect((await store.list()).map((entry) => entry.name)).toEqual([NAME]);
  });

  it('keeps an oversized legacy sidecar and its recovery original until a later successful retry', async () => {
    const { fs, sizes } = fixture();
    const legacy = 'Panel_1.sv.dxf';
    fs.put(`${DIR}/${legacy}`, 'legacy recovery');
    fs.put(`${DIR}/${legacy}.json`, '{"title":"Panel"}');
    sizes.set(`${DIR}/${legacy}.json`, MAX_METADATA_BYTES + 1);
    const store = createAutosaveStore(DIR, { fs, uuid: () => '22222222-2222-4222-8222-222222222222' });
    await expect(store.list()).rejects.toThrow(/Panel_1\.sv\.dxf\.json is larger than 8 MB/);
    expect(fs.get(`${DIR}/${legacy}`)).toBe('legacy recovery');
    expect(fs.get(`${DIR}/${legacy}.json`)).toBe('{"title":"Panel"}');
    sizes.clear();
    expect(await store.list()).toHaveLength(2);
    expect(await store.read('22222222-2222-4222-8222-222222222222.sv.dxf')).toBe('legacy recovery');
  });

  it('refuses unreadable future writes before touching the previous copy and reads UTF-8 copies', async () => {
    const { fs, store } = fixture();
    await expect(store.write(NAME, 'x'.repeat(MAX_DRAWING_BYTES + 1), {})).rejects.toThrow(/size limit/);
    expect(fs.trace).toEqual([]);
    expect(fs.get(`${DIR}/${NAME}`)).toBe('original recovery');
    await store.write(NAME, '中文 💡', { savedAt: 2 });
    expect(await store.read(NAME)).toBe('中文 💡');
  });
});
