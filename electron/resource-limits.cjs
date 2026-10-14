/**
 * Size limits shared by the main process's file reads and writes and its plot requests
 * (security review E-7 / E-18). Ported from PR #2 (codex/electrical-review-fixes 2f89b0e,
 * electron/resource-limits.cjs), with the limits this project chose:
 *
 * - drawings (DXF and DWG): 128 MiB;
 * - project files: 8 MiB;
 * - plot / print sheets: at most 200 inches (5 m) a side; plotter rolls are shorter.
 *
 * `readLimitedFile` reads through one handle, so a file that grows between the size check and the
 * read cannot slip past the limit.
 */
'use strict';

const path = require('node:path');
const { constants } = require('node:fs');

/**
 * Read-only, and non-blocking where the system has it: opening a FIFO (named pipe) for reading
 * otherwise waits for a writer - for ever, in one of libuv's four threads, and the process cannot
 * even exit while it waits. A FIFO planted under a drawing's name then fails the size check's
 * "not a file" at once. Regular files ignore the flag.
 */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

const MAX_DRAWING_BYTES = 128 * 1024 * 1024;
const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const MAX_PAPER_INCHES = 200;

/** 512 MB, 64 MB, 64 KB ... for messages. */
function sizeText(bytes) {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Refuse a write payload over `maxBytes` UTF-8 bytes (the read side counts bytes too).
 * @param {unknown} text
 * @param {number} maxBytes
 * @param {string} [label]
 */
function validateTextSize(text, maxBytes, label = 'text') {
  if (typeof text !== 'string' || text.length > maxBytes || Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new Error(`Invalid ${label} payload: the file exceeds the supported size limit (${sizeText(maxBytes)}).`);
  }
}

/**
 * Plot and print sheet sizes from the renderer: finite, positive, at most 200 inches a side
 * (security review E-18). Missing sizes fall back to Letter later.
 * @param {unknown} sheet
 */
function validatePaperDimensions(sheet) {
  for (const key of ['width', 'height']) {
    const value = sheet && typeof sheet === 'object' ? /** @type {Record<string, unknown>} */ (sheet)[key] : undefined;
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_PAPER_INCHES)) {
      throw new Error(`Paper dimensions must be between 0 and ${MAX_PAPER_INCHES} inches.`);
    }
  }
}

/**
 * Read a regular file of at most `maxBytes` through one handle.
 * @param {{ open: (file: string, flags: number) => Promise<any> }} fs  fs/promises (injected by tests)
 * @param {string} file
 * @param {number} maxBytes
 * @param {BufferEncoding} [encoding]  return a string in this encoding instead of bytes
 * @param {{ beforeRead?: (handle:any)=>Promise<void>, afterRead?: (handle:any,bytes:Buffer)=>Promise<void> }} [checks] host-owned identity checks while the descriptor remains open
 * @returns {Promise<Buffer | string>}
 */
async function readLimitedFile(fs, file, maxBytes, encoding, checks) {
  const handle = await fs.open(file, READ_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error(`EISDIR: not a file, read '${file}'`), { code: 'EISDIR' });
    if (stat.size > maxBytes) throw new Error(`${path.basename(file)} is larger than ${sizeText(maxBytes)}`);
    if (checks?.beforeRead) await checks.beforeRead(handle);
    const bytes = Buffer.alloc(Math.min(stat.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes || length > stat.size) throw new Error(`${path.basename(file)} changed while it was read; try again.`);
    const result = bytes.subarray(0, length);
    if (checks?.afterRead) await checks.afterRead(handle, result);
    return encoding ? result.toString(encoding) : result;
  } finally {
    await handle.close();
  }
}

module.exports = { sizeText, MAX_DRAWING_BYTES, MAX_PROJECT_BYTES, MAX_PAPER_INCHES, validateTextSize, validatePaperDimensions, readLimitedFile };
