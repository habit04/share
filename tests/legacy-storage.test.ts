import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { legacyStorage } = require('../electron/renderer-origin.cjs') as {
  legacyStorage: (options: { leveldbDir: string }) => Promise<Record<string, string>>;
};

// Round 12 rewrote the legacy leg: legacyStorage is now the in-process
// leveldb read (electron/legacy-leveldb.cjs) plus the dump's own 8 MiB
// accounting and the production preferenceDictionary validation. The
// window/copy/partition harness that filled this file through round
// 11 is deleted with the path it tested; the reader's format-level
// behaviour is covered in tests/legacy-leveldb.test.ts against the
// same real-Electron fixtures.
const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'legacy-leveldb');
const store = (shape: string) => join(FIXTURES, shape, 'leveldb');
const expected = (shape: string) => JSON.parse(readFileSync(join(FIXTURES, shape, 'expected.json'), 'utf8')) as Record<string, string>;

describe('legacy storage (round 12: in-process leveldb read)', () => {
  for (const shape of ['simple', 'deleted', 'utf16', 'many', 'logonly', 'overwrite']) {
    it(`returns the ${shape} store's preferences`, async () => {
      await expect(legacyStorage({ leveldbDir: store(shape) })).resolves.toEqual(expected(shape));
    });
  }

  it('applies the 8 MiB accounting: the oversize store parses but the leg refuses it', async () => {
    // oversize holds one 1,500,000-char control-char value: ~3 MB
    // stored, 9,000,016 bytes once JSON-escaped — over the cap,
    // exactly the refusal the in-page dump produced for oversize.
    await expect(legacyStorage({ leveldbDir: store('oversize') })).rejects.toThrow(/exceed 8 MiB/);
  });

  it('a torn store (directory without CURRENT) fails the leg', async () => {
    await expect(legacyStorage({ leveldbDir: store('logonly') + '-nonexistent' })).rejects.toThrow();
    const { mkdtempSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'jcad-legacy-torn-'));
    try {
      mkdirSync(join(dir, 'leveldb'), { recursive: true });
      await expect(legacyStorage({ leveldbDir: join(dir, 'leveldb') })).rejects.toThrow(/CURRENT/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
