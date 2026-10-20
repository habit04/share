import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

type LegacyRead = { values: Record<string, string> } | { error: unknown } | null;
const require = createRequire(import.meta.url);
const { legacyStorage, readLegacyStoreBeforeReady } = require('../electron/renderer-origin.cjs') as {
  legacyStorage: (options: { read: LegacyRead }) => Promise<Record<string, string>>;
  readLegacyStoreBeforeReady: (leveldbDir: string) => { values: Record<string, string> } | { error: unknown };
};

// Round 12 rewrote the legacy leg: legacyStorage is now the in-process
// leveldb read (electron/legacy-leveldb.cjs) plus the dump's own 8 MiB
// accounting and the production preferenceDictionary validation. The
// window/copy/partition harness that filled this file through round
// 11 is deleted with the path it tested; the reader's format-level
// behaviour is covered in tests/legacy-leveldb.test.ts against the
// same real-Electron fixtures.
// Round 12b (R12-4): the read runs before whenReady
// (readLegacyStoreBeforeReady) and the leg only consumes its result,
// so each case below reads first, then hands the result to the leg.
const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'legacy-leveldb');
const store = (shape: string) => join(FIXTURES, shape, 'leveldb');
const expected = (shape: string) => JSON.parse(readFileSync(join(FIXTURES, shape, 'expected.json'), 'utf8')) as Record<string, string>;
const leg = (leveldbDir: string) => legacyStorage({ read: readLegacyStoreBeforeReady(leveldbDir) });

describe('legacy storage (round 12: in-process leveldb read)', () => {
  for (const shape of ['simple', 'deleted', 'utf16', 'many', 'logonly', 'overwrite']) {
    it(`returns the ${shape} store's preferences`, async () => {
      await expect(leg(store(shape))).resolves.toEqual(expected(shape));
    });
  }

  it('applies the 8 MiB accounting: the oversize store parses but the leg refuses it', async () => {
    // oversize holds one 1,500,000-char control-char value: ~3 MB
    // stored, 9,000,016 bytes once JSON-escaped — over the cap,
    // exactly the refusal the in-page dump produced for oversize.
    await expect(leg(store('oversize'))).rejects.toThrow(/exceed 8 MiB/);
  });

  it('a torn store (directory without CURRENT) fails the leg', async () => {
    await expect(leg(store('logonly') + '-nonexistent')).rejects.toThrow();
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'jcad-legacy-torn-'));
    try {
      mkdirSync(join(dir, 'leveldb'), { recursive: true });
      await expect(leg(join(dir, 'leveldb'))).rejects.toThrow(/CURRENT/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('legacy storage: the pre-ready read and the consuming leg (round 12b, R12-4)', () => {
  it('the pre-ready read never throws: it returns the dictionary or the caught error', () => {
    const ok = readLegacyStoreBeforeReady(store('simple'));
    expect('values' in ok && { ...ok.values }).toEqual(expected('simple'));
    const missing = readLegacyStoreBeforeReady(store('simple') + '-nonexistent');
    expect('error' in missing).toBe(true);
    expect(missing).toMatchObject({ error: { code: 'ENOENT' } });
  });

  it('the leg rethrows exactly the caught read error (the failed leg)', async () => {
    const failure = new Error('leveldb log: record CRC mismatch');
    await expect(legacyStorage({ read: { error: failure } })).rejects.toBe(failure);
  });

  it('the leg never re-reads: a consumed dictionary is served even after the store is gone', async () => {
    const { cpSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'jcad-legacy-preread-'));
    try {
      cpSync(store('utf16'), join(root, 'leveldb'), { recursive: true });
      const read = readLegacyStoreBeforeReady(join(root, 'leveldb'));
      rmSync(join(root, 'leveldb'), { recursive: true, force: true });
      await expect(legacyStorage({ read })).resolves.toEqual(expected('utf16'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('no pre-ready result at all fails the leg, never an empty success', async () => {
    await expect(legacyStorage({ read: null })).rejects.toThrow(/not read before ready/);
  });
});
