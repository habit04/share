'use strict';

// Round 12: read the legacy Local Storage leveldb in the main process,
// in pure JS, so the migration never opens the store with Chromium
// again (no LOCK, no append-open of MANIFEST/.log, no CURRENT
// rewrite — plain fs reads with full sharing; the r10 CI failure
// showed Chromium's own open of a fresh copy can stall for seconds
// against the OS's on-close scans).
//
// Sources, mirroring what Chromium would serve after recovery:
//   - every numbered *.log write-ahead file in the directory
//     (Chromium recovery replays all logs at or beyond the
//     MANIFEST's log number; replaying the rest is harmless here
//     because the merge below is purely sequence-ordered — a stale
//     log's entries carry older sequences than the table they were
//     compacted into, and identical (key, sequence) pairs replay to
//     the same values);
//   - the MANIFEST's live .ldb table set (footer/index/data
//     blocks, prefix-compressed entries, Snappy where used,
//     per-block CRCs verified — table corruption throws, never
//     guesses).
// The merge keeps, per user key, the entry with the highest
// sequence; a deletion at the highest sequence drops the key.
//
// Integrity: log record CRCs (masked CRC-32C) are verified. A
// corrupt or torn record ENDS that log's replay (Chromium recovery
// semantics — a crashed writer's tail must not lose the batches
// before it). MANIFEST corruption instead throws (only a final
// record truncated by the end of the file is dropped, as leveldb
// does — round 12b, R12-3): the descriptor
// decides which tables are live, and guessing there could serve
// deleted data. Any other parse failure throws, and the caller
// takes the existing failed-leg path (no marker, retry next
// launch). Nothing here writes, locks, or creates anything.

const fs = require('node:fs');
const path = require('node:path');

const LOG_BLOCK_SIZE = 32_768;
const TABLE_MAGIC = 0xdb4775248b80fb57n;

// ---------------------------------------------------------------- CRC-32C

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32c(buffer, initial = 0) {
  let c = ~initial;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}

function maskCrc(crc) {
  // (crc >> 15) | (crc << 17) in uint32 — the right shift must be
  // LOGICAL: a signed >> sign-extends CRCs above 2^31 and corrupts
  // the mask (the standard check vector alone does not catch this;
  // the first real Chromium record did).
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

// ------------------------------------------------------------------ varints

function readVarint32(buffer, offset) {
  let result = 0;
  let shift = 0;
  let at = offset;
  while (at < buffer.length && shift <= 28) {
    const byte = buffer[at++];
    result |= (byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value: result >>> 0, next: at };
    shift += 7;
  }
  throw new Error('leveldb: malformed varint32');
}

function readVarint64(buffer, offset) {
  let result = 0n;
  let shift = 0n;
  let at = offset;
  while (at < buffer.length && shift <= 63n) {
    const byte = buffer[at++];
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value: result, next: at };
    shift += 7n;
  }
  throw new Error('leveldb: malformed varint64');
}

function readLengthPrefixed(buffer, offset) {
  const { value: length, next } = readVarint32(buffer, offset);
  if (next + length > buffer.length) throw new Error('leveldb: length-prefixed field overruns its record');
  return { value: buffer.subarray(next, next + length), next: next + length };
}

// --------------------------------------------------------------- log reader

// Logical records from a leveldb log file (data .log and MANIFEST
// alike). Stops at the first corrupt/torn record and returns what
// was assembled before it (Chromium recovery semantics); with
// `strict` it throws instead (MANIFEST use) — except for a final
// record truncated by the end of the file, which leveldb itself
// treats as EOF (round 12b, R12-3).
function readLogRecords(buffer, { strict = false } = {}) {
  const records = [];
  let fragments = null;
  let offset = 0;
  const fail = (message) => {
    if (strict) throw new Error(`leveldb log: ${message}`);
    return false;
  };
  while (offset + 7 <= buffer.length) {
    const blockRemaining = LOG_BLOCK_SIZE - (offset % LOG_BLOCK_SIZE);
    if (blockRemaining < 7) { offset += blockRemaining; continue; }
    const length = buffer.readUInt16LE(offset + 4);
    const type = buffer[offset + 6];
    if (length === 0 && type === 0) { offset += blockRemaining; continue; } // trailer padding
    // Recyclable records (reuse_logs) carry a 4-byte log number in an
    // 11-byte header; the CRC then covers type + log number + payload.
    const recyclable = type >= 5 && type <= 8;
    const headerSize = recyclable ? 11 : 7;
    const recordEnd = offset + headerSize + length;
    const blockEnd = offset + blockRemaining;
    // Round 12b (R12-3): a record cut off by the END OF THE FILE (the
    // writer died mid-append, inside the file's last, partial block)
    // is dropped, together with any unfinished fragmented record, in
    // BOTH modes — leveldb's log reader reports this as EOF, not as
    // corruption, so the strict MANIFEST read tolerates it too. A
    // record that overruns its 32 KiB block while the file goes on (or
    // ends exactly at that block's boundary) is a malformed length
    // (leveldb: "bad record length"), and fails.
    if (recordEnd > buffer.length && buffer.length < blockEnd) break;
    if (recordEnd > blockEnd) { if (!fail('record overruns its block')) break; }
    const payload = buffer.subarray(offset + headerSize, offset + headerSize + length);
    const storedCrc = buffer.readUInt32LE(offset);
    const crcInput = recyclable
      ? Buffer.concat([buffer.subarray(offset + 6, offset + 11), payload])
      : Buffer.concat([buffer.subarray(offset + 6, offset + 7), payload]);
    if (maskCrc(crc32c(crcInput)) !== storedCrc) { if (!fail('record CRC mismatch')) break; }
    const kind = recyclable ? type - 4 : type;
    if (kind === 1) { // FULL
      if (fragments) { if (!fail('FULL record inside a fragmented sequence')) break; }
      records.push(Buffer.from(payload));
    } else if (kind === 2) { // FIRST
      if (fragments) { if (!fail('FIRST record inside a fragmented sequence')) break; }
      fragments = [Buffer.from(payload)];
    } else if (kind === 3) { // MIDDLE
      if (!fragments) { if (!fail('MIDDLE record without a FIRST')) break; }
      else fragments.push(Buffer.from(payload));
    } else if (kind === 4) { // LAST
      if (!fragments) { if (!fail('LAST record without a FIRST')) break; }
      else {
        fragments.push(Buffer.from(payload));
        records.push(Buffer.concat(fragments));
        fragments = null;
      }
    } else if (!fail(`unknown record type ${type}`)) break;
    offset += headerSize + length;
  }
  return records;
}

// -------------------------------------------------------------- write batch

// A WriteBatch payload: 8-byte sequence, 4-byte op count, then ops
// (1 = put key value, 0 = delete key). Calls `apply(sequence, kind,
// key, value?)` per op with the op's own sequence (base + index).
function readWriteBatch(payload, apply) {
  if (payload.length < 12) throw new Error('leveldb log: write batch shorter than its header');
  let sequence = payload.readBigUInt64LE(0);
  const count = payload.readUInt32LE(8);
  let offset = 12;
  for (let i = 0; i < count; i++) {
    if (offset >= payload.length) throw new Error('leveldb log: write batch ends mid-op');
    const kind = payload[offset++];
    if (kind !== 0 && kind !== 1) throw new Error(`leveldb log: unknown write op ${kind}`);
    const key = readLengthPrefixed(payload, offset);
    offset = key.next;
    let value = null;
    if (kind === 1) {
      const read = readLengthPrefixed(payload, offset);
      value = read.value;
      offset = read.next;
    }
    apply(sequence, kind, key.value, value);
    sequence += 1n;
  }
  if (offset !== payload.length) throw new Error('leveldb log: write batch has trailing bytes');
}

// ---------------------------------------------------------------- MANIFEST

// Replay the MANIFEST's VersionEdits into the live table set:
// Map<fileNumber, level>. Throws on any malformation — the
// descriptor decides which tables are live, so it is read strictly.
function readManifestState(manifestBuffer) {
  const records = readLogRecords(manifestBuffer, { strict: true });
  const live = new Map();
  let logNumber = 0n;
  for (const record of records) {
    let offset = 0;
    while (offset < record.length) {
      const tag = readVarint32(record, offset);
      offset = tag.next;
      switch (tag.value) {
        case 1: offset = readLengthPrefixed(record, offset).next; break; // comparator
        case 2: { const v = readVarint64(record, offset); logNumber = v.value; offset = v.next; break; }
        case 3: offset = readVarint64(record, offset).next; break; // next file
        case 4: offset = readVarint64(record, offset).next; break; // last sequence
        case 5: { // compact pointer: level + internal key
          offset = readVarint32(record, offset).next;
          offset = readLengthPrefixed(record, offset).next;
          break;
        }
        case 6: { // deleted file: level + number
          offset = readVarint32(record, offset).next;
          const v = readVarint64(record, offset);
          live.delete(Number(v.value));
          offset = v.next;
          break;
        }
        case 7: { // new file: level + number + size + smallest + largest
          const level = readVarint32(record, offset);
          const number = readVarint64(record, level.next);
          const size = readVarint64(record, number.next);
          const smallest = readLengthPrefixed(record, size.next);
          const largest = readLengthPrefixed(record, smallest.next);
          live.set(Number(number.value), level.value);
          offset = largest.next;
          break;
        }
        case 9: offset = readVarint64(record, offset).next; break; // prev log number
        default: throw new Error(`leveldb MANIFEST: unknown VersionEdit tag ${tag.value}`);
      }
    }
  }
  return { liveTables: live, logNumber };
}

// -------------------------------------------------------------- table files

// Raw Snappy block decompression (the framing used inside leveldb
// tables): a varint uncompressed length, then literal/copy elements.
// Copies may overlap the output (run-length style) and are applied
// byte by byte, as the format requires.
function snappyDecompress(buffer) {
  const head = readVarint32(buffer, 0);
  const expected = head.value;
  let offset = head.next;
  const out = [];
  const byteAt = (/** @type {number} */ i) => out[i];
  while (offset < buffer.length) {
    const tag = buffer[offset++];
    const kind = tag & 0x03;
    if (kind === 0) { // literal
      let length = tag >> 2;
      if (length >= 60) {
        const extra = length - 59;
        if (offset + extra > buffer.length) throw new Error('snappy: literal length overruns input');
        // Assemble UNSIGNED (multiplication, not signed shifts): a
        // top byte >= 0x80 through int32 shifts made the length
        // negative, the copy loop ran zero times and the read
        // position walked backwards — a hang, not a throw
        // (REVIEW-round12 F1, probe [0x10, 0xfc, 0, 0, 0, 0x80]).
        length = 0;
        for (let i = 0; i < extra; i++) length += buffer[offset + i] * 2 ** (8 * i);
        offset += extra;
      }
      length += 1;
      if (length > expected - out.length) throw new Error('snappy: literal exceeds the promised output length');
      if (offset + length > buffer.length) throw new Error('snappy: literal overruns input');
      for (let i = 0; i < length; i++) out.push(buffer[offset + i]);
      offset += length;
    } else {
      let length;
      let copyOffset;
      if (kind === 1) {
        length = 4 + ((tag >> 2) & 0x7);
        if (offset >= buffer.length) throw new Error('snappy: copy(1) missing offset byte');
        copyOffset = ((tag & 0xe0) << 3) | buffer[offset++];
      } else if (kind === 2) {
        length = (tag >> 2) + 1;
        if (offset + 2 > buffer.length) throw new Error('snappy: copy(2) missing offset bytes');
        copyOffset = buffer.readUInt16LE(offset);
        offset += 2;
      } else {
        length = (tag >> 2) + 1;
        if (offset + 4 > buffer.length) throw new Error('snappy: copy(4) missing offset bytes');
        copyOffset = buffer.readUInt32LE(offset);
        offset += 4;
      }
      if (copyOffset === 0 || copyOffset > out.length) throw new Error('snappy: copy offset outside the output');
      for (let i = 0; i < length; i++) out.push(byteAt(out.length - copyOffset));
    }
  }
  if (out.length !== expected) throw new Error(`snappy: decoded ${out.length} bytes, header promised ${expected}`);
  return Buffer.from(out);
}

function readBlockHandle(buffer, offset) {
  const off = readVarint64(buffer, offset);
  const size = readVarint64(buffer, off.next);
  return { offset: Number(off.value), size: Number(size.value), next: size.next };
}

// One table block: contents + 5-byte trailer (compression type +
// masked CRC of contents and the type byte). Verified, then
// decompressed. Any failure throws — table bytes decide live data.
function readTableBlock(table, handle) {
  const end = handle.offset + handle.size;
  if (end + 5 > table.length) throw new Error('leveldb table: block overruns the file');
  const contents = table.subarray(handle.offset, end);
  const compression = table[end];
  const storedCrc = table.readUInt32LE(end + 1);
  const crcInput = Buffer.concat([contents, Buffer.from([compression])]);
  if (maskCrc(crc32c(crcInput)) !== storedCrc) throw new Error('leveldb table: block CRC mismatch');
  if (compression === 0) return Buffer.from(contents);
  if (compression === 1) return snappyDecompress(contents);
  throw new Error(`leveldb table: unknown block compression ${compression}`);
}

// Prefix-compressed entries of one data/index block. The restart
// array (uint32 offsets + count) closes the block; entries live
// before it. Returns [{ key, value }] with keys fully reconstructed.
function readBlockEntries(block) {
  if (block.length < 4) throw new Error('leveldb table: block shorter than its restart count');
  const restarts = block.readUInt32LE(block.length - 4);
  const entriesEnd = block.length - 4 * (restarts + 1);
  if (entriesEnd < 0) throw new Error('leveldb table: restart array overruns the block');
  const entries = [];
  let offset = 0;
  let lastKey = Buffer.alloc(0);
  while (offset < entriesEnd) {
    const shared = readVarint32(block, offset);
    const nonShared = readVarint32(block, shared.next);
    const valueLength = readVarint32(block, nonShared.next);
    let at = valueLength.next;
    if (shared.value > lastKey.length) throw new Error('leveldb table: shared prefix longer than the previous key');
    if (at + nonShared.value + valueLength.value > entriesEnd) throw new Error('leveldb table: entry overruns the block');
    const key = Buffer.concat([lastKey.subarray(0, shared.value), block.subarray(at, at + nonShared.value)]);
    at += nonShared.value;
    const value = block.subarray(at, at + valueLength.value);
    entries.push({ key, value: Buffer.from(value) });
    lastKey = key;
    offset = at + valueLength.value;
  }
  if (offset !== entriesEnd) throw new Error('leveldb table: entries do not end at the restart array');
  return entries;
}

// Replay one .ldb table into the merge: footer (48 bytes, magic
// verified) -> index block -> each data block's entries. Internal
// keys are user key + 8-byte (sequence << 8 | type); type 1 is a
// value, 0 a deletion — the same kind numbers as write-batch ops.
function readTableFile(buffer, apply) {
  if (buffer.length < 48) throw new Error('leveldb table: file shorter than its footer');
  const footer = buffer.subarray(buffer.length - 48);
  if (footer.readBigUInt64LE(40) !== TABLE_MAGIC) throw new Error('leveldb table: footer magic mismatch');
  const metaindex = readBlockHandle(footer, 0);
  const index = readBlockHandle(footer, metaindex.next);
  const indexEntries = readBlockEntries(readTableBlock(buffer, index));
  for (const { value } of indexEntries) {
    const handle = readBlockHandle(value, 0);
    for (const { key, value: entryValue } of readBlockEntries(readTableBlock(buffer, handle))) {
      if (key.length < 8) throw new Error('leveldb table: internal key shorter than its suffix');
      const packed = key.readBigUInt64LE(key.length - 8);
      const kind = Number(packed & 0xffn);
      if (kind !== 0 && kind !== 1) throw new Error(`leveldb table: unknown entry type ${kind}`);
      apply(packed >> 8n, kind, key.subarray(0, key.length - 8), kind === 1 ? entryValue : null);
    }
  }
}

// Chromium Local Storage (leveldb) v1 schema. Data keys are
// '_' + origin + '\x00' + encoded script key; values are encoded
// text. Both use the same encoding marker, verified byte-for-byte
// against real Chromium stores: 0x00 + UTF-16LE, or 0x01 +
// Latin-1. META:* and VERSION keys never start with the data
// prefix, so the prefix filter excludes them by construction.
const DATA_KEY_PREFIX = Buffer.from('_file://\x00', 'latin1');

function decodeEncodedText(bytes, what) {
  if (bytes.length === 0) throw new Error(`legacy leveldb: stored ${what} has no encoding byte`);
  if (bytes[0] === 0x00) return bytes.subarray(1).toString('utf16le');
  if (bytes[0] === 0x01) return bytes.subarray(1).toString('latin1');
  throw new Error(`legacy leveldb: unknown ${what} encoding byte ${bytes[0]}`);
}

function decodeScriptKey(bytes) {
  return decodeEncodedText(bytes, 'key');
}

function decodeValue(bytes) {
  return decodeEncodedText(bytes, 'value');
}

// ------------------------------------------------------------- public read

const MAX_TOTAL_BYTES = 256 * 1024 * 1024; // sanity bound on bytes read
// Round 12b (R12-7): the size bound's error carries this code, so the
// caller can tell "too large" apart from "cannot decode" (only the
// latter preserves a copy of the store).
const LEGACY_STORE_TOO_LARGE = 'LEGACY_STORE_TOO_LARGE';
const tooLarge = () => Object.assign(new Error('legacy leveldb: store exceeds the read size bound'), { code: LEGACY_STORE_TOO_LARGE });
// Fable follow-up N1 (non-blocking at the 12b gate): short-circuit
// BEFORE any parsing when the store's on-disk data files (numbered
// tables + logs) already exceed 64 MiB. The per-read 256 MiB bound
// below only trips after the MANIFEST and some files have been
// read and parsed; a store this large is refused either way (the
// leg's own accounting caps preferences at 8 MiB), so refuse it
// from the directory listing alone — no CURRENT read, no MANIFEST
// parse, no table bytes touched.
const PRE_PARSE_SIZE_BOUND = 64 * 1024 * 1024;
// Round 12b (R12-7 widening): a file the store's own metadata says
// exists — the MANIFEST that CURRENT names, a live table the MANIFEST
// names, or a log the directory listing just returned — but that is
// missing is CORRUPTION to leveldb (Status::Corruption: "CURRENT points
// to a non-existent file", "missing files"), and Chromium's recovery would
// recreate the store. Its ENOENT is rethrown as this code, without the
// fs error's syscall, so the caller classifies it as a decode failure:
// the store is preserved and the leg fails. Absence of the directory or
// of CURRENT stays a plain fs ENOENT ("no store").
const LEGACY_STORE_MISSING_FILE = 'LEGACY_STORE_MISSING_FILE';
function readReferencedFile(leveldbDir, name, what) {
  try {
    return fs.readFileSync(path.join(leveldbDir, name));
  } catch (error) {
    if (/** @type {{ code?: unknown }} */ (error)?.code !== 'ENOENT') throw error;
    throw Object.assign(new Error(`legacy leveldb: ENOENT: ${what} ${name} is missing (a corrupt store)`), { code: LEGACY_STORE_MISSING_FILE, cause: error });
  }
}

/**
 * Read the file:// origin's legacy localStorage dictionary from a
 * Local Storage leveldb directory, without opening the database.
 * Returns a null-prototype { key: string } dictionary (the same
 * shape the hidden-window dump produced). Throws on any parse
 * failure; the caller treats a throw as a failed migration leg.
 * @param {string} leveldbDir
 * @returns {Record<string, string>}
 */
function readLegacyLocalStorage(leveldbDir) {
  let onDiskBytes = 0;
  for (const name of fs.readdirSync(leveldbDir)) {
    if (!/^\d+\.(?:ldb|log)$/.test(name)) continue;
    onDiskBytes += fs.statSync(path.join(leveldbDir, name)).size;
    if (onDiskBytes > PRE_PARSE_SIZE_BOUND) throw tooLarge();
  }
  const current = fs.readFileSync(path.join(leveldbDir, 'CURRENT'), 'utf8').trim();
  if (!/^MANIFEST-\d+$/.test(current)) throw new Error('legacy leveldb: CURRENT does not name a MANIFEST');
  const manifest = readReferencedFile(leveldbDir, current, 'CURRENT names');
  const { liveTables } = readManifestState(manifest);
  const entries = new Map(); // hex(userKey) -> { sequence, kind, key, value }
  let totalBytes = manifest.length;
  const apply = (sequence, kind, key, value) => {
    const id = key.toString('hex');
    const prior = entries.get(id);
    if (!prior || sequence >= prior.sequence) entries.set(id, { sequence, kind, key, value });
  };
  const tableNumbers = [...liveTables.keys()].sort((a, b) => a - b);
  for (const number of tableNumbers) {
    const buffer = readReferencedFile(leveldbDir, `${String(number).padStart(6, '0')}.ldb`, 'the MANIFEST names table');
    totalBytes += buffer.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw tooLarge();
    readTableFile(buffer, apply);
  }
  const logNames = fs.readdirSync(leveldbDir)
    .filter((name) => /^\d+\.log$/.test(name))
    .sort((a, b) => Number(a.slice(0, -4)) - Number(b.slice(0, -4)));
  for (const name of logNames) {
    const buffer = readReferencedFile(leveldbDir, name, 'the directory lists log');
    totalBytes += buffer.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw tooLarge();
    for (const record of readLogRecords(buffer)) readWriteBatch(record, apply);
  }
  const result = Object.create(null);
  for (const { kind, key, value } of entries.values()) {
    if (kind === 0) continue; // the newest entry for this key is a deletion
    if (key.length <= DATA_KEY_PREFIX.length || !key.subarray(0, DATA_KEY_PREFIX.length).equals(DATA_KEY_PREFIX)) continue;
    result[decodeScriptKey(key.subarray(DATA_KEY_PREFIX.length))] = decodeValue(value);
  }
  return result;
}

module.exports = { readLegacyLocalStorage, LEGACY_STORE_TOO_LARGE, LEGACY_STORE_MISSING_FILE, _internals: { crc32c, maskCrc, readLogRecords, readWriteBatch, readManifestState, decodeScriptKey, decodeValue, snappyDecompress, readTableFile, TABLE_MAGIC } };
