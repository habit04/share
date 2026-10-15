/**
 * Pure, bounded extraction of one face of a TrueType Collection (TTC) as a standalone
 * SFNT program, for full-program PDF embedding. Table bytes are copied verbatim — glyphs,
 * metrics, Unicode mappings and OS/2 embedding permissions are preserved exactly and no
 * subsetting is performed. Source table checksums are not trusted or verified; directory
 * checksums and the head checkSumAdjustment are recomputed for the standalone layout.
 * No I/O and no font program execution: the caller supplies one already-confined read.
 * Format: https://learn.microsoft.com/en-us/typography/opentype/spec/otff
 */
const MAX_TTC_FACES = 64;
const MAX_TTC_TABLES = 128;
const MAX_EXTRACTED_BYTES = 64 * 1024 * 1024;
const CHECKSUM_MAGIC = 0xb1b0afba;

/** @returns {never} */
function fail(message) { throw new Error(`TTC extract: ${message}`); }
/** @param {Buffer} data @param {number} offset @param {number} length @param {string} what */
function need(data, offset, length, what) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset > data.length || length > data.length - offset) fail(`truncated or invalid ${what}`);
}
/** Sum of big-endian uint32 words; the caller guarantees a multiple-of-four length. @param {Buffer} data @param {number} offset @param {number} length */
function checksum(data, offset, length) {
  let sum = 0;
  for (let at = offset; at < offset + length; at += 4) sum = (sum + data.readUInt32BE(at)) >>> 0;
  return sum;
}

/**
 * @param {Buffer | Uint8Array} input TTC file bytes from a single confined read.
 * @param {number} [faceIndex] Face to extract; the installed-font reader selects face 0.
 * @param {{ maxFaces?: number, maxTables?: number, maxOutputBytes?: number }} [options]
 * @returns {Buffer} A fresh standalone SFNT program owning no memory shared with the input.
 */
function extractTtcFace(input, faceIndex = 0, options = {}) {
  const maxFaces = options.maxFaces ?? MAX_TTC_FACES, maxTables = options.maxTables ?? MAX_TTC_TABLES, maxOutputBytes = options.maxOutputBytes ?? MAX_EXTRACTED_BYTES;
  if (!Number.isInteger(maxFaces) || maxFaces < 1 || maxFaces > 1024 || !Number.isInteger(maxTables) || maxTables < 1 || maxTables > 1024 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 28) fail('invalid extraction limits');
  if (!Number.isInteger(faceIndex) || faceIndex < 0) fail('invalid TrueType collection face index');
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  need(data, 0, 12, 'TrueType collection header');
  if (data.toString('latin1', 0, 4) !== 'ttcf') fail('not a TrueType collection');
  const version = data.readUInt32BE(4), count = data.readUInt32BE(8);
  if (version !== 0x00010000 && version !== 0x00020000) fail('unsupported TrueType collection version');
  if (!count || count > maxFaces) fail('invalid TrueType collection face count');
  const headerLength = 12 + count * 4 + (version === 0x00020000 ? 12 : 0);
  need(data, 12, headerLength - 12, 'TrueType collection directory');
  if (version === 0x00020000) {
    const at = 12 + count * 4, tag = data.readUInt32BE(at), length = data.readUInt32BE(at + 4), signatureOffset = data.readUInt32BE(at + 8);
    if (!tag && (length || signatureOffset) || tag && (tag !== 0x44534947 || !length || signatureOffset < headerLength)) fail('invalid TrueType collection signature fields');
    if (tag) need(data, signatureOffset, length, 'TrueType collection signature');
  }
  if (faceIndex >= count) fail('TrueType collection face index is out of range');
  const offsets = new Set();
  for (let i = 0; i < count; i++) {
    const entry = data.readUInt32BE(12 + i * 4);
    if (entry < headerLength || entry % 4 || offsets.has(entry)) fail('invalid or duplicate TrueType collection face offset');
    need(data, entry, 12, 'TrueType collection face');
    offsets.add(entry);
  }
  const faceOffset = data.readUInt32BE(12 + faceIndex * 4);
  const flavor = data.readUInt32BE(faceOffset);
  if (flavor === 0x4f54544f) fail('CFF outlines are unsupported; a TrueType glyf font is required');
  if (flavor !== 0x00010000 && flavor !== 0x74727565) fail('unsupported SFNT outline format');
  const tableCount = data.readUInt16BE(faceOffset + 4);
  if (!tableCount || tableCount > maxTables) fail('invalid SFNT table count');
  need(data, faceOffset + 12, tableCount * 16, 'SFNT table directory');
  const directoryEnd = faceOffset + 12 + tableCount * 16;
  /** @type {{ tag: string, offset: number, length: number }[]} */
  const records = [];
  const tags = new Set();
  for (let i = 0; i < tableCount; i++) {
    const at = faceOffset + 12 + i * 16, tag = data.toString('latin1', at, at + 4), start = data.readUInt32BE(at + 8), length = data.readUInt32BE(at + 12);
    if (!/^[\x20-\x7e]{4}$/.test(tag) || tags.has(tag)) fail('invalid or duplicate SFNT table tag');
    need(data, start, length, `${tag} table`);
    if (start % 4 || (length && start < directoryEnd && start + length > faceOffset)) fail(`invalid ${tag} table offset`);
    tags.add(tag); records.push({ tag, offset: start, length });
  }
  const ranges = records.filter((record) => record.length).map((record) => ({ offset: record.offset, length: record.length })).sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < ranges.length; i++) if (ranges[i].offset < ranges[i - 1].offset + ranges[i - 1].length) fail('overlapping SFNT tables');
  const head = records.find((record) => record.tag === 'head');
  if (!head || head.length < 12) fail('missing or truncated head table');
  let outputLength = 12 + tableCount * 16;
  for (const record of records) outputLength += Math.ceil(record.length / 4) * 4;
  if (outputLength > maxOutputBytes) fail('extracted font exceeds the output size limit');
  const sorted = [...records].sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const result = Buffer.alloc(outputLength);
  result.writeUInt32BE(flavor, 0); result.writeUInt16BE(tableCount, 4);
  const selector = Math.floor(Math.log2(tableCount)), searchRange = 2 ** selector * 16;
  result.writeUInt16BE(searchRange, 6); result.writeUInt16BE(selector, 8); result.writeUInt16BE(tableCount * 16 - searchRange, 10);
  let position = 12 + tableCount * 16;
  /** @type {Map<string, number>} */
  const placed = new Map();
  for (const record of sorted) {
    data.copy(result, position, record.offset, record.offset + record.length);
    placed.set(record.tag, position); position += Math.ceil(record.length / 4) * 4;
  }
  // The head checksum is computed with checkSumAdjustment treated as zero (spec).
  const headStart = /** @type {number} */ (placed.get('head'));
  result.writeUInt32BE(0, headStart + 8);
  sorted.forEach((record, i) => {
    const at = 12 + i * 16, start = /** @type {number} */ (placed.get(record.tag));
    result.write(record.tag, at, 'latin1');
    result.writeUInt32BE(checksum(result, start, Math.ceil(record.length / 4) * 4), at + 4);
    result.writeUInt32BE(start, at + 8); result.writeUInt32BE(record.length, at + 12);
  });
  result.writeUInt32BE((CHECKSUM_MAGIC - checksum(result, 0, result.length)) >>> 0, headStart + 8);
  return result;
}

module.exports = { extractTtcFace, MAX_TTC_FACES, MAX_TTC_TABLES, MAX_EXTRACTED_BYTES };
