/** Stable, bounded plugin source reads. API v1 remains explicitly trusted page code. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');

const MAX_PLUGIN_MANIFEST_BYTES = 64 * 1024;
const MAX_PLUGIN_CODE_BYTES = 2 * 1024 * 1024;
const VERIFY_CHUNK_BYTES = 64 * 1024;
const FOLDER_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAIN_RE = /^[A-Za-z0-9._-]+\.js$/;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const changed = () => Object.assign(new Error('Plugin source changed while it was read; try again.'), { code: 'ERR_PLUGIN_CHANGED' });
// These are native realpath results, whose stored spelling is authoritative.
// Unicode folding (including path.relative on Windows) aliases distinct NTFS
// directories such as U+0130 and U+0049 U+0307; never fold canonical paths.
const samePath = (a, b) => a === b;
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const inside = (root, file) => { const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`; return file.length > prefix.length && file.startsWith(prefix); };

/** @param {unknown} name @returns {name is string} */
function isPluginFolderName(name) { return typeof name === 'string' && name !== '.' && name !== '..' && FOLDER_RE.test(name); }
/** @param {unknown} name @returns {string} */
function safePluginFolder(name) { if (!isPluginFolderName(name)) throw new Error('Invalid plugin folder name'); return name; }

/**
 * Stable aliases inside the whole plugins root retain API v1's existing policy.
 * The optional callback runs the existing main-process policy/logging first;
 * containment and handle identity are independently rechecked afterward.
 * @param {string} root main-owned plugins directory
 * @param {string} file logical plugin filename, constructed by this module
 * @param {number} maximum
 * @param {{ checkPath?: (file: string) => Promise<unknown> }} options
 */
async function readStablePluginFile(root, file, maximum, options) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) throw new Error('Invalid plugin root');
  await options.checkPath?.(file);
  let handle, verified = false;
  try {
    const realRoot = await fs.realpath(root), realFile = await fs.realpath(file);
    if (!inside(realRoot, realFile)) throw Object.assign(new Error('Invalid plugin path: source resolves outside the plugins root.'), { code: 'ERR_PLUGIN_PATH' });
    const rootBefore = await fs.stat(realRoot, { bigint: true }), before = await fs.stat(realFile, { bigint: true });
    if (!rootBefore.isDirectory()) throw new Error('Invalid plugin root');
    if (!before.isFile()) throw Object.assign(new Error('Plugin source is not a regular file.'), { code: 'EISDIR' });
    if (before.size > BigInt(maximum)) throw new Error(`${path.basename(file)} is larger than ${maximum / 1024} KiB`);
    verified = true;
    handle = await fs.open(realFile, READ_FLAGS);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(before, opened) || !samePath(await fs.realpath(root), realRoot) || !sameIdentity(rootBefore, await fs.stat(realRoot, { bigint: true })) || !samePath(await fs.realpath(file), realFile)) throw changed();
    const bytes = Buffer.alloc(Number(opened.size));
    let length = 0;
    while (length < bytes.length) {
      const remaining = bytes.length - length;
      const { bytesRead } = await handle.read(bytes, length, remaining, length);
      if (!Number.isInteger(bytesRead) || bytesRead < 1 || bytesRead > remaining) throw changed();
      length += bytesRead;
    }
    const extra = Buffer.alloc(1);
    const check = async () => {
      if (!sameFile(opened, await handle.stat({ bigint: true })) || !sameFile(opened, await fs.stat(realFile, { bigint: true })) || !samePath(await fs.realpath(file), realFile) || !samePath(await fs.realpath(root), realRoot) || !sameIdentity(rootBefore, await fs.stat(realRoot, { bigint: true }))) throw changed();
    };
    if ((await handle.read(extra, 0, 1, length)).bytesRead) throw changed();
    await check();
    // Native Windows stat timestamps can collide after a same-size edit. Compare
    // the captured raw bytes against a fresh explicit-position pass through the
    // same held descriptor, with at most 64 KiB extra memory (never another 2 MiB).
    const scratch = Buffer.allocUnsafe(Math.min(VERIFY_CHUNK_BYTES, Math.max(1, length)));
    let position = 0;
    while (position < length) {
      const count = Math.min(scratch.length, length - position);
      const { bytesRead } = await handle.read(scratch, 0, count, position);
      if (!Number.isInteger(bytesRead) || bytesRead < 1 || bytesRead > count || !bytes.subarray(position, position + bytesRead).equals(scratch.subarray(0, bytesRead))) throw changed();
      position += bytesRead;
    }
    if ((await handle.read(extra, 0, 1, length)).bytesRead) throw changed();
    await check();
    return bytes.toString('utf8');
  } catch (error) {
    if (verified && error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) throw changed();
    throw error;
  } finally { await handle?.close(); }
}

/**
 * @param {string} root
 * @param {unknown} folder
 * @param {{ checkPath?: (file: string) => Promise<unknown> }} [options]
 */
async function readPluginManifest(root, folder, options = {}) {
  return readStablePluginFile(root, path.join(root, safePluginFolder(folder), 'plugin.json'), MAX_PLUGIN_MANIFEST_BYTES, options);
}

/**
 * Return the same logical source path as the legacy loader/trust key. Missing
 * manifests return null; missing code and malformed entry names remain errors.
 * @param {string} root
 * @param {unknown} folder
 * @param {{ checkPath?: (file: string) => Promise<unknown> }} [options]
 * @returns {Promise<{manifest: string, code: string, path: string} | null>}
 */
async function readPluginSource(root, folder, options = {}) {
  const directory = path.join(root, safePluginFolder(folder));
  let manifest;
  try { manifest = await readPluginManifest(root, folder, options); }
  catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
  let main = 'main.js';
  try { const record = JSON.parse(manifest); if (record && record.main !== undefined) main = String(record.main); }
  catch { /* The renderer reports malformed JSON; the legacy default entry is retained. */ }
  if (!MAIN_RE.test(main)) throw new Error('plugin.json "main" must be a .js file in the plugin folder');
  const file = path.join(directory, main);
  return { manifest, code: await readStablePluginFile(root, file, MAX_PLUGIN_CODE_BYTES, options), path: file };
}

module.exports = { MAX_PLUGIN_MANIFEST_BYTES, MAX_PLUGIN_CODE_BYTES, MAIN_RE, isPluginFolderName, readPluginManifest, readPluginSource };
