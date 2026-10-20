import { describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { readLegacyLocalStorage, _internals } = require('../electron/legacy-leveldb.cjs') as {
  readLegacyLocalStorage: (dir: string) => Record<string, string>;
  _internals: {
    crc32c: (b: Buffer) => number;
    maskCrc: (n: number) => number;
    readLogRecords: (b: Buffer, o?: { strict?: boolean }) => Buffer[];
    snappyDecompress: (b: Buffer) => Buffer;
  };
};

const FIXTURES = resolve(import.meta.dirname, 'fixtures', 'legacy-leveldb');

function fixtureDir(shape: string) {
  return join(FIXTURES, shape, 'leveldb');
}

function expected(shape: string) {
  return JSON.parse(readFileSync(join(FIXTURES, shape, 'expected.json'), 'utf8')) as Record<string, string>;
}

describe('legacy leveldb reader — real Chromium stores (round 12)', () => {
  // Every fixture under tests/fixtures/legacy-leveldb was written by
  // REAL Electron (localStorage on a file:// page) and verified by a
  // read-back launch before capture; expected.json is that ground
  // truth, not the reader's own output.
  for (const shape of ['simple', 'deleted', 'utf16', 'many', 'logonly', 'overwrite']) {
    it(`reads the ${shape} store exactly`, () => {
      const values = readLegacyLocalStorage(fixtureDir(shape));
      expect(Object.getPrototypeOf(values)).toBeNull();
      expect({ ...values }).toEqual(expected(shape));
    });
  }

  it('CRC-32C matches the standard check vector', () => {
    expect(_internals.crc32c(Buffer.from('123456789', 'ascii'))).toBe(0xe3069283);
  });

  it('a torn tail ends the log replay without losing earlier batches', () => {
    // Copy the simple store and append garbage + a fake extra batch:
    // the reader must still serve the intact prefix.
    const root = mkdtempSync(join(tmpdir(), 'jcad-leveldb-torn-'));
    try {
      const dir = join(root, 'leveldb');
      mkdirSync(dir, { recursive: true });
      for (const name of readdirSync(fixtureDir('simple'))) copyFileSync(join(fixtureDir('simple'), name), join(dir, name));
      const log = readFileSync(join(dir, '000003.log'));
      writeFileSync(join(dir, '000003.log'), Buffer.concat([log, Buffer.from([0xff, 0xff, 0xff, 0xff, 0x40, 0x00, 0x01, 0xaa, 0xbb])]));
      expect({ ...readLegacyLocalStorage(dir) }).toEqual(expected('simple'));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('MANIFEST corruption is a hard failure, never a guess', () => {
    const root = mkdtempSync(join(tmpdir(), 'jcad-leveldb-manifest-'));
    try {
      const dir = join(root, 'leveldb');
      mkdirSync(dir, { recursive: true });
      for (const name of readdirSync(fixtureDir('simple'))) copyFileSync(join(fixtureDir('simple'), name), join(dir, name));
      const manifest = readFileSync(join(dir, 'MANIFEST-000001'));
      manifest[20] = (manifest[20] ?? 0) ^ 0xff; // inside the comparator string: CRC no longer matches
      writeFileSync(join(dir, 'MANIFEST-000001'), manifest);
      expect(() => readLegacyLocalStorage(dir)).toThrow(/CRC|leveldb/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Round 12b (R12-3): the strict MANIFEST read tolerates ONLY a final
  // record cut off by the end of the file (the writer died mid-append;
  // leveldb's log reader reports that as EOF). A CRC mismatch, or a
  // record that overruns its block while the file goes on, still throws.
  describe('strict MANIFEST read: only an EOF-truncated final record is tolerated (round 12b, R12-3)', () => {
    const logRecord = (payload: Buffer, type = 1) => {
      const header = Buffer.alloc(7);
      header.writeUInt16LE(payload.length, 4);
      header[6] = type;
      header.writeUInt32LE(_internals.maskCrc(_internals.crc32c(Buffer.concat([Buffer.from([type]), payload]))), 0);
      return Buffer.concat([header, payload]);
    };
    // A valid VersionEdit: comparator (tag 1) = `length` bytes of 'x'.
    const comparatorEdit = (length: number) => {
      const varint: number[] = [];
      for (let n = length; ; n >>>= 7) { if (n < 0x80) { varint.push(n); break; } varint.push((n & 0x7f) | 0x80); }
      return Buffer.concat([Buffer.from([1, ...varint]), Buffer.alloc(length, 0x78)]);
    };
    const withManifest = (tail: (manifest: Buffer) => Buffer, check: (dir: string) => void) => {
      const root = mkdtempSync(join(tmpdir(), 'jcad-leveldb-r12-3-'));
      try {
        const dir = join(root, 'leveldb');
        mkdirSync(dir, { recursive: true });
        for (const name of readdirSync(fixtureDir('simple'))) copyFileSync(join(fixtureDir('simple'), name), join(dir, name));
        const manifest = readFileSync(join(dir, 'MANIFEST-000001'));
        writeFileSync(join(dir, 'MANIFEST-000001'), tail(manifest));
        check(dir);
      } finally { rmSync(root, { recursive: true, force: true }); }
    };

    it('drops a final record truncated by the end of the file', () => {
      withManifest((m) => Buffer.concat([m, logRecord(comparatorEdit(40)).subarray(0, 7 + 12)]), (dir) => {
        expect({ ...readLegacyLocalStorage(dir) }).toEqual(expected('simple'));
      });
    });

    it('drops a final header truncated by the end of the file', () => {
      withManifest((m) => Buffer.concat([m, logRecord(comparatorEdit(40)).subarray(0, 4)]), (dir) => {
        expect({ ...readLegacyLocalStorage(dir) }).toEqual(expected('simple'));
      });
    });

    it('drops an unfinished fragmented final record (FIRST, then the end of the file)', () => {
      withManifest((m) => Buffer.concat([m, logRecord(comparatorEdit(40), 2)]), (dir) => {
        expect({ ...readLegacyLocalStorage(dir) }).toEqual(expected('simple'));
      });
    });

    it('a CRC mismatch in the final, complete record still throws', () => {
      withManifest((m) => {
        const record = logRecord(comparatorEdit(40));
        record[record.length - 1] = (record[record.length - 1] ?? 0) ^ 0x01;
        return Buffer.concat([m, record]);
      }, (dir) => {
        expect(() => readLegacyLocalStorage(dir)).toThrow(/record CRC mismatch/);
      });
    });

    it('a record that overruns its 32 KiB block while the file goes on still throws (truncation not at EOF)', () => {
      // The second record starts after the 41-byte fixture record and
      // claims 10 bytes more than its block holds; its CRC is valid and
      // its payload is a well-formed VersionEdit, so only the block
      // bound can refuse it. The file continues into the next block.
      withManifest((m) => {
        const room = 32_768 - m.length - 7;
        const record = logRecord(comparatorEdit(room + 10 - 4)); // 1 tag + 3 varint bytes
        expect(record.length).toBe(7 + room + 10);
        return Buffer.concat([m, record, Buffer.alloc(100)]);
      }, (dir) => {
        expect(() => readLegacyLocalStorage(dir)).toThrow(/overruns its block/);
      });
    });

    it('a block-overrunning record still throws when the file ends exactly at the block boundary', () => {
      withManifest((m) => {
        const room = 32_768 - m.length - 7;
        const record = logRecord(comparatorEdit(room + 10 - 4));
        return Buffer.concat([m, record]).subarray(0, 32_768);
      }, (dir) => {
        expect(() => readLegacyLocalStorage(dir)).toThrow(/overruns its block/);
      });
    });
  });

  it('a MANIFEST naming a table file that is not on disk fails the leg', () => {
    // Hand-build a MANIFEST whose VersionEdit adds one live table,
    // with a correct masked CRC so the failure is the missing file,
    // not a parse error.
    const root = mkdtempSync(join(tmpdir(), 'jcad-leveldb-table-'));
    try {
      const dir = join(root, 'leveldb');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'CURRENT'), 'MANIFEST-000001\n');
      // VersionEdit: comparator(1)='x', log(2)=0, next(3)=10, seq(4)=0,
      // new_file(7): level 0, number 5, size 100, smallest '', largest ''.
      const payload = Buffer.from([
        1, 1, 0x78, 2, 0, 3, 10, 4, 0,
        7, 0, 5, 100, 0, 0,
      ]);
      const header = Buffer.alloc(7);
      header.writeUInt16LE(payload.length, 4);
      header[6] = 1;
      const crc = _internals.maskCrc(_internals.crc32c(Buffer.concat([Buffer.from([1]), payload])));
      header.writeUInt32LE(crc, 0);
      writeFileSync(join(dir, 'MANIFEST-000001'), Buffer.concat([header, payload]));
      expect(() => readLegacyLocalStorage(dir)).toThrow(/ENOENT|no such file/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // The big fixtures' values are 200,000 chars each; expected.json
  // records { bytes, sha256 } per key (verified by a real read-back
  // launch at capture time), so the reader's output is hashed the
  // same way here.
  for (const shape of ['big', 'bigcycle', 'snappy']) {
    it(`reads the ${shape} store's real .ldb tables exactly`, async () => {
      const { createHash } = await import('node:crypto');
      const manifest = JSON.parse(readFileSync(join(FIXTURES, shape, 'expected.json'), 'utf8')) as Record<string, { bytes: number; sha256: string }>;
      const values = readLegacyLocalStorage(fixtureDir(shape));
      const digest: Record<string, { bytes: number; sha256: string }> = {};
      for (const [key, value] of Object.entries(values)) {
        const bytes = Buffer.from(value, 'utf8');
        digest[key] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      }
      expect(digest).toEqual(manifest);
    });
  }

  it('parses the oversize store at format level (the leg-level cap is not the reader’s)', () => {
    const values = readLegacyLocalStorage(fixtureDir('oversize'));
    expect(Object.keys(values)).toEqual(['oversize']);
    expect(values['oversize']).toHaveLength(1_500_000);
  });

  it('Snappy decoder round-trips the format’s element kinds', () => {
    const snappy = _internals.snappyDecompress as (b: Buffer) => Buffer;
    // literal-only: length 3, tag 0x00 (len-1 in high bits: (3-1)<<2 = 8)
    expect(snappy(Buffer.from([3, 8, 0x61, 0x62, 0x63])).toString()).toBe('abc');
    // literal 'abcd' then copy(1): tag kind1, len 4+((tag>>2)&7), offset from low bits+next byte
    const src = Buffer.from([8, 12, 0x61, 0x62, 0x63, 0x64, (0 << 2) | 1, 4]);
    expect(snappy(src).toString()).toBe('abcdabcd');
    // overlapping copy builds a run: literal 'a', copy(2) len 5 offset 1
    const run = Buffer.from([6, 0, 0x61, ((5 - 1) << 2) | 2, 1, 0]);
    expect(snappy(run).toString()).toBe('aaaaaa');
  });

  it('Snappy decoder throws — never hangs — on a crafted long-form literal length (REVIEW-round12 F1)', () => {
    const snappy = _internals.snappyDecompress as (b: Buffer) => Buffer;
    // The reviewer's probe: promised output 0x10, literal tag 0xfc
    // (long form, 4 length bytes) whose top byte 0x80 made the
    // signed-shift length negative and the decoder spin.
    expect(() => snappy(Buffer.from([0x10, 0xfc, 0x00, 0x00, 0x00, 0x80]))).toThrow(/snappy/);
    // A well-formed length that merely exceeds the promised output
    // also throws rather than trusting the input.
    expect(() => snappy(Buffer.from([2, 0xfc, 0x05, 0x00, 0x00, 0x00, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66]))).toThrow(/snappy/);
  });
});
