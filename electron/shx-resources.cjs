/** Read-only SHX resources in roots chosen by the main process. No path from a drawing grants access. */
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_SHX_BYTES = 8 * 1024 * 1024;
const MAX_SHX_DIRECTORIES = 16;
const error = (message) => Object.assign(new Error(message), { code: 'ERR_SHX_RESOURCE' });
// These are canonical realpaths, including the filesystem's stored name spelling.
// Windows path.relative/toLowerCase can merge distinct Unicode NTFS directories.
const samePath = (a, b) => a === b;
const inside = (root, target) => {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target.startsWith(prefix) && target.length > prefix.length;
};
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/** @param {unknown} request @returns {string} */
function shxFilename(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw error('Invalid SHX resource request.');
  const value = /** @type {{font?: unknown}} */ (request).font;
  if (typeof value !== 'string') throw error('Invalid SHX resource request.');
  let name = value;
  if (!name || name.length > 255 || name !== name.trim() || /[\u0000-\u001f\u007f\\/:*?"<>|]/.test(name) || name === '.' || name === '..' || name.endsWith('.') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\s*(?:\.|$)/i.test(name)) throw error('SHX resource must be a safe font filename.');
  if (!/\.shx$/i.test(name)) {
    if (name.includes('.')) throw error('Only SHX resources may be read.');
    name += '.shx';
  }
  if (path.basename(name) !== name) throw error('SHX resource must be a filename.');
  return name;
}

/**
 * The caller supplies trusted font roots, scoped to a drawing or native file
 * choice. This module never searches installed CAD products or network paths.
 * @param {unknown} request { font: string }, a literal basename
 * @param {{ directories: readonly string[] }} options main-owned authorized roots
 * @returns {Promise<{ bytes: Uint8Array, resolvedPath: string, sha256: string, resourceId: string }>}
 */
async function readShxResource(request, options) {
  const filename = shxFilename(request);
  if (!options || !Array.isArray(options.directories) || !options.directories.length || options.directories.length > MAX_SHX_DIRECTORIES) throw error('No authorized SHX resource directories.');
  const directories = [...options.directories];
  for (const directory of directories) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.length > 4096 || /[\u0000-\u001f]/.test(directory) || /^[\\/]{2}/.test(directory) || (process.platform === 'win32' && directory.replace(/^[A-Za-z]:/, '').includes(':'))) throw error('Invalid SHX resource directory.');
  }
  for (const directory of directories) {
    const candidate = path.join(directory, filename);
    let handle;
    try {
      const root = await fs.realpath(directory);
      const rootStat = await fs.stat(root);
      if (!rootStat.isDirectory() || /^[\\/]{2}/.test(root)) throw error('Invalid SHX resource root.');
      const resolvedPath = await fs.realpath(candidate);
      if (!inside(root, resolvedPath)) throw error('SHX resource escapes its authorized directory.');
      const before = await fs.stat(resolvedPath, { bigint: true });
      if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_SHX_BYTES)) throw error('SHX resource is not a bounded regular file.');
      handle = await fs.open(candidate, constants.O_RDONLY);
      const opened = await handle.stat({ bigint: true });
      if (!sameFile(before, opened) || !opened.isFile() || !samePath(await fs.realpath(candidate), resolvedPath) || !samePath(await fs.realpath(directory), root)) throw error('SHX resource changed while opening.');
      const bytes = Buffer.alloc(Number(opened.size));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) throw error('SHX resource changed while reading.');
        offset += bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await handle.read(extra, 0, 1, offset)).bytesRead || !sameFile(opened, await handle.stat({ bigint: true })) || !sameFile(opened, await fs.stat(resolvedPath, { bigint: true })) || !samePath(await fs.realpath(candidate), resolvedPath) || !samePath(await fs.realpath(directory), root)) throw error('SHX resource changed while reading.');
      const signature = bytes.subarray(0, 64).toString('ascii');
      if (!/^AutoCAD-86 (?:shapes|unifont|bigfont) 1\.[01]\r\n\x1a/.test(signature)) throw error('The selected resource is not a recognized SHX program.');
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      return { bytes: Uint8Array.from(bytes), resolvedPath, sha256, resourceId: JSON.stringify([resolvedPath, sha256]) };
    } catch (cause) {
      if (cause && (cause.code === 'ENOENT' || cause.code === 'ENOTDIR')) continue;
      throw cause;
    } finally { await handle?.close(); }
  }
  throw error(`SHX resource "${filename}" was not found in an authorized directory.`);
}

module.exports = { MAX_SHX_BYTES, MAX_SHX_DIRECTORIES, readShxResource, shxFilename };
