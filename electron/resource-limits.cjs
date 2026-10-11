/** Bounds shared by Electron file loading and plot requests. */
const MAX_DRAWING_BYTES = 128 * 1024 * 1024;
const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const MAX_PAPER_INCHES = 200;
/** Match write limits to UTF-8 read limits, including multibyte project/catalog names. */
function validateTextSize(text, maxBytes, label = 'text') {
  if (typeof text !== 'string' || text.length > maxBytes || Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`Invalid ${label} payload: file exceeds the supported size limit.`);
  }
}
function validatePaperDimensions(sheet) {
  for (const key of ['width', 'height']) {
    const value = sheet && sheet[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > MAX_PAPER_INCHES)) {
      throw new Error('Paper dimensions must be between 0 and 200 inches.');
    }
  }
}
async function readLimitedFile(fs, file, maxBytes, encoding) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('File exceeds the supported size limit.');
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes || length > stat.size) throw new Error('File changed or exceeds the supported size limit; try opening it again.');
    const result = bytes.subarray(0, length);
    return encoding ? result.toString(encoding) : result;
  } finally { await handle.close(); }
}
module.exports = { MAX_DRAWING_BYTES, MAX_PROJECT_BYTES, MAX_PAPER_INCHES, validateTextSize, validatePaperDimensions, readLimitedFile };
