import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

type LegacyRead = { values: Record<string, string> } | { error: unknown } | null;
const require = createRequire(import.meta.url);
type LogError = (kind: string, error: unknown) => void;
const { legacyStorage, readLegacyStoreBeforeReady, preserveLegacyStore, legacyStoreDecodeFailure } = require('../electron/renderer-origin.cjs') as {
  legacyStorage: (options: { read: LegacyRead }) => Promise<Record<string, string>>;
  readLegacyStoreBeforeReady: (leveldbDir: string, options: { logError: LogError; now?: () => Date }) => { values: Record<string, string> } | { error: unknown };
  preserveLegacyStore: (leveldbDir: string, options: { logError: LogError; now?: () => Date }) => string | null;
  legacyStoreDecodeFailure: (error: unknown) => boolean;
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
const leg = (leveldbDir: string) => legacyStorage({ read: readLegacyStoreBeforeReady(leveldbDir, { logError: vi.fn() }) });

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
    const ok = readLegacyStoreBeforeReady(store('simple'), { logError: vi.fn() });
    expect('values' in ok && { ...ok.values }).toEqual(expected('simple'));
    const missing = readLegacyStoreBeforeReady(store('simple') + '-nonexistent', { logError: vi.fn() });
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
      const read = readLegacyStoreBeforeReady(join(root, 'leveldb'), { logError: vi.fn() });
      rmSync(join(root, 'leveldb'), { recursive: true, force: true });
      await expect(legacyStorage({ read })).resolves.toEqual(expected('utf16'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('no pre-ready result at all fails the leg, never an empty success', async () => {
    await expect(legacyStorage({ read: null })).rejects.toThrow(/not read before ready/);
  });
});

describe('legacy storage: preserving an undecodable store before ready (round 12b, R12-7)', () => {
  const PRESERVED = 'leveldb.preserved-';
  const withStore = async (body: (paths: { local: string; leveldb: string }) => Promise<void> | void, corrupt = true) => {
    const { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'jcad-legacy-preserve-'));
    try {
      const local = join(root, 'Local Storage');
      const leveldb = join(local, 'leveldb');
      mkdirSync(leveldb, { recursive: true });
      for (const name of readdirSync(store('simple'))) copyFileSync(join(store('simple'), name), join(leveldb, name));
      writeFileSync(join(leveldb, 'LOCK'), '');
      if (corrupt) {
        const manifest = readFileSync(join(leveldb, 'MANIFEST-000001'));
        manifest[20] = (manifest[20] ?? 0) ^ 0xff; // CRC no longer matches: a decode failure
        writeFileSync(join(leveldb, 'MANIFEST-000001'), manifest);
      }
      await body({ local, leveldb });
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  const snapshot = async (dir: string) => {
    const { readdirSync } = await import('node:fs');
    return Object.fromEntries(readdirSync(dir).sort().map((name) => [name, readFileSync(join(dir, name)).toString('base64')]));
  };
  const preservedDirs = async (local: string) => {
    const { readdirSync } = await import('node:fs');
    return readdirSync(local).filter((name) => name.startsWith(PRESERVED)).sort();
  };
  const at = (iso: string) => () => new Date(iso);

  it('copies the store byte for byte, LOCK excluded, logs the path once, leaves the original untouched and fails the leg', async () => {
    await withStore(async ({ local, leveldb }) => {
      const before = await snapshot(leveldb);
      const logError = vi.fn();
      const read = readLegacyStoreBeforeReady(leveldb, { logError, now: at('2026-10-20T12:00:00.000Z') });
      expect('error' in read).toBe(true);
      expect(await preservedDirs(local)).toEqual([`${PRESERVED}2026-10-20T12-00-00-000Z`]);
      const preserved = join(local, `${PRESERVED}2026-10-20T12-00-00-000Z`);
      const { LOCK, ...expectedCopy } = before;
      expect(LOCK).toBe('');
      expect(await snapshot(preserved)).toEqual(expectedCopy);
      expect(logError).toHaveBeenCalledOnce();
      expect(logError).toHaveBeenCalledWith('renderer preference migration', expect.objectContaining({ message: `Unreadable legacy store preserved at ${preserved}` }));
      expect(await snapshot(leveldb)).toEqual(before);
      await expect(legacyStorage({ read })).rejects.toBe((read as { error: unknown }).error);
    });
  });

  it('preserves once per distinct failure: the same MANIFEST name and size is skipped, a new one is copied', async () => {
    await withStore(async ({ local, leveldb }) => {
      const { appendFileSync } = await import('node:fs');
      const logError = vi.fn();
      readLegacyStoreBeforeReady(leveldb, { logError, now: at('2026-10-20T12:00:00.000Z') });
      readLegacyStoreBeforeReady(leveldb, { logError, now: at('2026-10-20T13:00:00.000Z') });
      expect(await preservedDirs(local)).toEqual([`${PRESERVED}2026-10-20T12-00-00-000Z`]);
      expect(logError).toHaveBeenCalledOnce();
      // A different failure (the MANIFEST grew; still corrupt) is preserved
      // again, never over the earlier copy (counter suffix on a same stamp).
      appendFileSync(join(leveldb, 'MANIFEST-000001'), Buffer.from([1, 2, 3]));
      const read = readLegacyStoreBeforeReady(leveldb, { logError, now: at('2026-10-20T12:00:00.000Z') });
      expect('error' in read).toBe(true);
      expect(await preservedDirs(local)).toEqual([`${PRESERVED}2026-10-20T12-00-00-000Z`, `${PRESERVED}2026-10-20T12-00-00-000Z-2`]);
      expect(logError).toHaveBeenCalledTimes(2);
      const now = await snapshot(leveldb);
      delete now['LOCK'];
      expect(await snapshot(join(local, `${PRESERVED}2026-10-20T12-00-00-000Z-2`))).toEqual(now);
    });
  });

  // A MANIFEST that CURRENT names but that is missing is corruption to
  // leveldb ("CURRENT points to a non-existent file"): preserved, and the
  // leg fails. Directory/CURRENT absence is covered further below.
  it('stops preserving at 3 copies and logs the skip (Fable N2)', async () => {
    await withStore(async ({ local, leveldb }) => {
      const { mkdirSync } = await import('node:fs');
      for (const stamp of ['2026-10-18T00-00-00-000Z', '2026-10-19T00-00-00-000Z', '2026-10-20T00-00-00-000Z']) {
        mkdirSync(join(local, `${PRESERVED}${stamp}`), { recursive: true });
      }
      const logError = vi.fn();
      const read = readLegacyStoreBeforeReady(leveldb, { logError, now: at('2026-10-20T12:00:00.000Z') });
      // The leg still fails; only the copy is skipped, and the skip
      // is what gets logged (the 3 existing copies keep the bytes).
      expect(read).toHaveProperty('error');
      expect(await preservedDirs(local)).toHaveLength(3);
      expect(logError).toHaveBeenCalledOnce();
      expect(logError).toHaveBeenCalledWith('renderer preference migration',
        expect.objectContaining({ message: expect.stringContaining('preservation skipped: 3 preserved copies') }));
    });
  });

  it('still preserves with 2 copies present — the cap is on the count, not the presence (Fable N2)', async () => {
    await withStore(async ({ local, leveldb }) => {
      const { mkdirSync } = await import('node:fs');
      for (const stamp of ['2026-10-18T00-00-00-000Z', '2026-10-19T00-00-00-000Z']) {
        mkdirSync(join(local, `${PRESERVED}${stamp}`), { recursive: true });
      }
      const logError = vi.fn();
      readLegacyStoreBeforeReady(leveldb, { logError, now: at('2026-10-20T12:00:00.000Z') });
      expect(await preservedDirs(local)).toHaveLength(3);
      expect(logError).toHaveBeenCalledWith('renderer preference migration',
        expect.objectContaining({ message: expect.stringContaining('Unreadable legacy store preserved at') }));
    });
  });

  it('a MANIFEST that CURRENT names but that is missing is corruption: preserved, the leg fails; only decode failures count', async () => {
    await withStore(async ({ local, leveldb }) => {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(join(leveldb, 'CURRENT'), 'MANIFEST-000009\n');
      const before = await snapshot(leveldb);
      const logError = vi.fn();
      const read = readLegacyStoreBeforeReady(leveldb, { logError, now: at('2026-10-20T15:00:00.000Z') });
      expect(read).toMatchObject({ error: { code: 'LEGACY_STORE_MISSING_FILE', message: expect.stringMatching(/ENOENT.*MANIFEST-000009/) } });
      const error = (read as { error: { syscall?: unknown; cause?: { code?: unknown } } }).error;
      expect(error.syscall).toBeUndefined();
      expect(error.cause?.code).toBe('ENOENT');
      expect(legacyStoreDecodeFailure(error)).toBe(true);
      const preserved = join(local, `${PRESERVED}2026-10-20T15-00-00-000Z`);
      expect(await preservedDirs(local)).toEqual([`${PRESERVED}2026-10-20T15-00-00-000Z`]);
      const { LOCK, ...expectedCopy } = before;
      expect(LOCK).toBe('');
      expect(await snapshot(preserved)).toEqual(expectedCopy);
      expect(logError).toHaveBeenCalledExactlyOnceWith('renderer preference migration', expect.objectContaining({ message: `Unreadable legacy store preserved at ${preserved}` }));
      expect(await snapshot(leveldb)).toEqual(before);
      await expect(legacyStorage({ read })).rejects.toBe(error);
    }, false);
    expect(legacyStoreDecodeFailure(new Error('leveldb log: record CRC mismatch'))).toBe(true);
    expect(legacyStoreDecodeFailure(Object.assign(new RangeError('out of range'), { code: 'ERR_OUT_OF_RANGE' }))).toBe(true);
    expect(legacyStoreDecodeFailure(Object.assign(new Error('EBUSY'), { code: 'EBUSY', syscall: 'open' }))).toBe(false);
    expect(legacyStoreDecodeFailure(Object.assign(new Error('too large'), { code: 'LEGACY_STORE_TOO_LARGE' }))).toBe(false);
  });

  // R12-7 widening: a table the MANIFEST names but that is missing is
  // corruption to leveldb (Chromium's recovery would recreate the
  // store), not "no store": it is preserved and the leg fails.
  it('a missing table the MANIFEST names is corruption: the store is preserved and the leg fails (round 12b, R12-7 widening)', async () => {
    const { cpSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'jcad-legacy-missing-table-'));
    try {
      const local = join(root, 'Local Storage');
      const leveldb = join(local, 'leveldb');
      // A real store whose MANIFEST lists 000003.ldb and 000006.ldb, with
      // 000006.ldb (the newer table, holding tt-victim's tombstone) gone.
      cpSync(store('table-tombstone'), leveldb, { recursive: true });
      rmSync(join(leveldb, '000006.ldb'));
      writeFileSync(join(leveldb, 'LOCK'), '');
      const before = await snapshot(leveldb);
      const logError = vi.fn();
      const read = readLegacyStoreBeforeReady(leveldb, { logError, now: at('2026-10-20T14:00:00.000Z') });
      expect(read).toMatchObject({ error: { code: 'LEGACY_STORE_MISSING_FILE', message: expect.stringMatching(/ENOENT.*000006\.ldb/) } });
      const error = (read as { error: { syscall?: unknown; cause?: { code?: unknown } } }).error;
      expect(error.syscall).toBeUndefined();
      expect(error.cause?.code).toBe('ENOENT');
      expect(legacyStoreDecodeFailure(error)).toBe(true);
      const preserved = join(local, `${PRESERVED}2026-10-20T14-00-00-000Z`);
      expect(await preservedDirs(local)).toEqual([`${PRESERVED}2026-10-20T14-00-00-000Z`]);
      const { LOCK, ...expectedCopy } = before;
      expect(LOCK).toBe('');
      expect(await snapshot(preserved)).toEqual(expectedCopy);
      expect(logError).toHaveBeenCalledExactlyOnceWith('renderer preference migration', expect.objectContaining({ message: `Unreadable legacy store preserved at ${preserved}` }));
      expect(await snapshot(leveldb)).toEqual(before);
      await expect(legacyStorage({ read })).rejects.toBe(error);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('absence of the directory or of CURRENT stays "no store": nothing is preserved (round 12b, R12-7 widening)', async () => {
    await withStore(async ({ local, leveldb }) => {
      const { rmSync } = await import('node:fs');
      rmSync(join(leveldb, 'CURRENT'));
      const logError = vi.fn();
      const read = readLegacyStoreBeforeReady(leveldb, { logError });
      expect(read).toMatchObject({ error: { code: 'ENOENT', syscall: 'open' } });
      expect(legacyStoreDecodeFailure((read as { error: unknown }).error)).toBe(false);
      expect(readLegacyStoreBeforeReady(join(local, 'no-such-leveldb'), { logError })).toMatchObject({ error: { code: 'ENOENT' } });
      expect(await preservedDirs(local)).toEqual([]);
      expect(logError).not.toHaveBeenCalled();
    }, false);
  });

  it('never throws: a failing copy is logged and the read still returns its error', async () => {
    const logError = vi.fn();
    expect(preserveLegacyStore(store('simple') + '-nonexistent', { logError })).toBeNull();
    expect(logError).toHaveBeenCalledExactlyOnceWith('renderer preference migration', expect.objectContaining({ code: 'ENOENT' }));
    await withStore(async ({ local, leveldb }) => {
      const before = await snapshot(leveldb);
      const failing = vi.fn();
      const read = readLegacyStoreBeforeReady(leveldb, { logError: failing, now: () => new Date(Number.NaN) });
      expect(read).toMatchObject({ error: { message: expect.stringMatching(/CRC/) } });
      expect(failing).toHaveBeenCalledExactlyOnceWith('renderer preference migration', expect.any(RangeError));
      expect(await preservedDirs(local)).toEqual([]);
      expect(await snapshot(leveldb)).toEqual(before);
    });
  });
});
