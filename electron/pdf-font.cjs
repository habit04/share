/** Confined, read-only installed TrueType programs for one captured Windows PDF export. */
const { readWindowsFontData } = require('./font-metrics.cjs');

/** @returns {never} */
function fail(message) { throw new Error(`PDF font: ${message}`); }

/**
 * https://learn.microsoft.com/en-us/typography/opentype/spec/os2#fstype
 * Full embedding satisfies no-subsetting. Preview/print fonts need a read-only PDF,
 * which this exporter does not provide; installed/editable fonts alone are accepted.
 * @param {number} fsType @param {number} os2Version @returns {string | null}
 */
function pdfFontEmbeddingProblem(fsType, os2Version) {
  if (!Number.isInteger(fsType) || fsType < 0 || fsType > 65535 || !Number.isInteger(os2Version) || os2Version < 0 || os2Version > 5) return 'invalid embedding permissions';
  if (fsType & 1) return 'reserved embedding permission bit';
  if (os2Version >= 2 && fsType & 0xfcf0) return 'reserved embedding permission bits';
  if (os2Version >= 2 && fsType & 0x0200) return 'bitmap-only embedding';
  const permission = fsType & 14;
  if (os2Version >= 3 && ![0, 2, 4, 8].includes(permission)) return 'conflicting embedding permissions';
  // Versions0/1 ignore bits4..15; versions0..2 allow the least restrictive usage bit.
  if (permission & 8) return null;
  if (permission & 4) return 'preview/print embedding requires a read-only PDF';
  if (permission & 2) return 'restricted font embedding';
  return null;
}

/** nameID6 is a platform-independent PostScript invocation name, never synthesized. */
function postscriptName(data) {
  const count = data.readUInt16BE(2), storage = data.readUInt16BE(4);
  let result;
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 12, platform = data.readUInt16BE(at), encoding = data.readUInt16BE(at + 2), id = data.readUInt16BE(at + 6);
    if (id !== 6) continue;
    const unicode = platform === 0 || platform === 3 && (encoding === 1 || encoding === 10);
    if (!unicode && !(platform === 1 && encoding === 0)) continue;
    const length = data.readUInt16BE(at + 8), offset = storage + data.readUInt16BE(at + 10);
    // The metadata reader has already checked every name record's byte range.
    if (!length || length > (unicode ? 126 : 63) || unicode && length % 2) fail('invalid PostScript nameID6 string');
    let value;
    try { value = new TextDecoder(unicode ? 'utf-16be' : 'macintosh', { fatal: true }).decode(data.subarray(offset, offset + length)); }
    catch { fail('invalid PostScript nameID6 encoding'); }
    if (!/^[\x21-\x7e]{1,63}$/.test(value) || /[[\](){}<>/%]/.test(value)) fail('invalid PostScript nameID6 name');
    if (result !== undefined && result !== value) fail('conflicting PostScript nameID6 records');
    result = value;
  }
  if (!result) fail('PostScript nameID6 is required for embedding');
  return result;
}

/**
 * Bytes and descriptor values come from the exact same confined, race-checked file read.
 * No font bytes are returned when the native embedding permissions refuse this export.
 * @param {import('./font-metrics.cjs').FontMetricsRequest} request
 * @param {{ fontsDirectory?: string }} [options]
 */
async function readWindowsPdfFont(request, options) {
  const { metrics, bytes } = await readWindowsFontData(request, options);
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), signature = data.readUInt32BE(0);
  if (signature === 0x74746366) fail('TrueType collections are not supported for embedding');
  if (signature !== 0x00010000 && signature !== 0x74727565) fail('standalone TrueType glyf outlines are required');
  // The shared metadata parser validated all SFNT table ranges, overlaps and formats.
  const tables = new Map();
  for (let i = 0; i < data.readUInt16BE(4); i++) {
    const at = 12 + i * 16, start = data.readUInt32BE(at + 8), length = data.readUInt32BE(at + 12);
    tables.set(data.toString('latin1', at, at + 4), data.subarray(start, start + length));
  }
  const table = (tag, length) => {
    const found = tables.get(tag);
    if (!found || found.length < length) fail(`missing or truncated ${tag} table`);
    return found;
  };
  const os2 = table('OS/2', 78), hhea = table('hhea', 36), post = table('post', 32);
  const os2Version = os2.readUInt16BE(0), problem = pdfFontEmbeddingProblem(os2.readUInt16BE(8), os2Version);
  if (problem) fail(problem);
  const ascender = hhea.readInt16BE(4), descender = hhea.readInt16BE(6), weight = os2.readUInt16BE(4), italicAngle = post.readInt32BE(4) / 65536;
  if (ascender < 0 || descender > 0) fail('unsupported font vertical metrics');
  if (weight < 1 || weight > 1000 || Math.abs(italicAngle) > 90) fail('invalid font weight or italic angle');
  if (![0x00010000, 0x00020000, 0x00025000, 0x00030000].includes(post.readUInt32BE(0))) fail('unsupported post table version');
  return { bytes, metrics, postscriptName: postscriptName(table('name', 6)), ascender, descender,
    italicAngle, weight, isFixedPitch: !!post.readUInt32BE(12), os2Version };
}

module.exports = { readWindowsPdfFont, pdfFontEmbeddingProblem };
