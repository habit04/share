/** Native Windows identities for main-owned, already-authorized file paths. No access is granted here. */
'use strict';
const fsp = require('node:fs/promises');
const { createHash } = require('node:crypto');
const path = require('node:path').win32;

const MAX_PATH_LENGTH = 4096;
const MAX_PARENT_DEPTH = 128;
const MAX_CONTENT_BYTES = 128 * 1024 * 1024;
const MAX_PDF_CONTENT_BYTES = 512 * 1024 * 1024;
const HASH_CHUNK_BYTES = 256 * 1024;
const fail = (code, message) => Object.assign(new Error(message), { code });
const asciiCaseFold = (value) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Validate normal drive/UNC paths before any metadata access; never infer a current drive. */
function absoluteWindowsPath(value, file = true) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH || /[\u0000-\u001f\u007f]/.test(value) || !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+)/.test(value) || /^[\\/]{2}[?.][\\/]/.test(value)) throw fail('ERR_WINDOWS_PATH', 'A bounded absolute Windows path is required.');
  const resolved = path.resolve(value);
  const root = path.parse(resolved).root;
  if (/[<>:"|?*]/.test(resolved.slice(root.length))) throw fail('ERR_WINDOWS_PATH', 'Windows streams and wildcard paths are not save destinations.');
  if (file && (!path.basename(resolved) || resolved === root)) throw fail('ERR_WINDOWS_PATH', 'A file destination is required.');
  for (const component of resolved.slice(root.length).split('\\')) {
    if (/[. ]$/.test(component) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\s*(?:\.|$)/i.test(component)) throw fail('ERR_WINDOWS_PATH', 'Ambiguous Windows names are not file destinations.');
  }
  return resolved;
}

/** Exact comparisons are safe only after native realpath produced stored spelling. */
function canonicalInside(root, target) {
  if (target === root) return true;
  const prefix = root.endsWith('\\') ? root : `${root}\\`;
  return target.startsWith(prefix);
}
const identityOf = (stat) => {
  if (typeof stat.dev !== 'bigint' || typeof stat.ino !== 'bigint') throw fail('ERR_WINDOWS_IDENTITY', 'Native bigint filesystem identities are required.');
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
};
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const versionOf = (stat) => {
  const identity = identityOf(stat);
  for (const key of ['size', 'mtimeNs', 'ctimeNs']) if (typeof stat[key] !== 'bigint') throw fail('ERR_WINDOWS_IDENTITY', 'Native bigint file versions are required.');
  return Object.freeze({ ...identity, size: String(stat.size), mtimeNs: String(stat.mtimeNs), ctimeNs: String(stat.ctimeNs) });
};
/** @param {FileVersion|null} version */
const fileVersionKey = (version) => version === null ? null : JSON.stringify([version.dev, version.ino, version.size, version.mtimeNs, version.ctimeNs, version.sha256 ?? null]);
const statVersionKey = (version) => JSON.stringify([version.dev, version.ino, version.size, version.mtimeNs, version.ctimeNs]);
const abortCheck = (signal) => { if (signal?.aborted) throw fail('ERR_SAVE_CANCELLED', 'The file-content check was cancelled.'); };

/** @typedef {{readonly dev:string, readonly ino:string}} FileIdentity */
/** @typedef {FileIdentity & {readonly size:string, readonly mtimeNs:string, readonly ctimeNs:string, readonly sha256?:string}} FileVersion */
/** @typedef {{readonly logicalPath:string, readonly destinationPath:string, readonly canonicalPath:string, readonly canonicalParent:string, readonly parentExists:boolean, readonly parentIdentity:FileIdentity, readonly ancestorLogicalPath:string, readonly canonicalAncestor:string, readonly missingParents:readonly string[], readonly queueKey:string, readonly targetKey:string, readonly exists:boolean, readonly fileVersion:FileVersion|null, readonly hashContent?:boolean, readonly contentLimit?:number, readonly root?:string, readonly canonicalRoot?:string, readonly rootIdentity?:FileIdentity}} WindowsWriteTarget */

/** Hash fresh bytes through one held descriptor. Caller must authorize before calling.
 * Regular file symlinks are supported here for standalone opens; save pins impose their own policy.
 * @param {string} value
 * @param {{fs?:typeof fsp,maxBytes?:number,pdfExport?:boolean,signal?:AbortSignal,expectedCanonicalPath?:string,expectedVersion?:FileVersion}} [options]
 * @returns {Promise<{sha256:string,bytes:number,canonicalPath:string,version:FileVersion}>}
 */
async function coherentFileDigest(value, { fs = fsp, maxBytes = MAX_CONTENT_BYTES, pdfExport = false, signal, expectedCanonicalPath, expectedVersion } = {}) {
  const file = absoluteWindowsPath(value);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > (pdfExport === true ? MAX_PDF_CONTENT_BYTES : MAX_CONTENT_BYTES)) throw fail('ERR_WINDOWS_CONTENT_LIMIT', 'A bounded file-content limit is required.');
  const changed = () => fail('ERR_WINDOWS_PATH_CHANGED', 'The file changed during its content check.');
  abortCheck(signal);
  const canonicalPath = await fs.realpath(file);
  if (expectedCanonicalPath !== undefined && canonicalPath !== expectedCanonicalPath) throw changed();
  let handle;
  try {
    abortCheck(signal);
    handle = await fs.open(file, fsp.constants.O_RDONLY | fsp.constants.O_NONBLOCK);
    abortCheck(signal);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw fail('ERR_WINDOWS_CONTENT_TYPE', 'Only regular file contents can be checked.');
    const version = versionOf(before), key = statVersionKey(version), size = before.size;
    if (size < 0n || size > BigInt(maxBytes)) throw fail('ERR_WINDOWS_CONTENT_LIMIT', 'The file exceeds the content-check limit.');
    if (expectedVersion && statVersionKey(expectedVersion) !== key) throw changed();
    const pathCheck = async () => {
      abortCheck(signal);
      const logical = await fs.stat(file, { bigint: true });
      if (!logical.isFile() || statVersionKey(versionOf(logical)) !== key || await fs.realpath(file) !== canonicalPath) throw changed();
      const physical = await fs.stat(canonicalPath, { bigint: true });
      if (!physical.isFile() || statVersionKey(versionOf(physical)) !== key) throw changed();
      abortCheck(signal);
    };
    await pathCheck();
    const scratch = Buffer.allocUnsafe(HASH_CHUNK_BYTES), hash = createHash('sha256');
    const bytes = Number(size);
    let position = 0;
    while (position < bytes) {
      abortCheck(signal);
      const length = Math.min(scratch.byteLength, bytes - position);
      const { bytesRead } = await handle.read(scratch, 0, length, position);
      if (!Number.isInteger(bytesRead) || bytesRead < 1 || bytesRead > length) throw changed();
      abortCheck(signal);
      hash.update(scratch.subarray(0, bytesRead)); position += bytesRead;
    }
    abortCheck(signal);
    if ((await handle.read(scratch, 0, 1, bytes)).bytesRead !== 0 || statVersionKey(versionOf(await handle.stat({ bigint: true }))) !== key) throw changed();
    await pathCheck();
    const sha256 = hash.digest('hex');
    if (expectedVersion?.sha256 !== undefined && expectedVersion.sha256 !== sha256) throw changed();
    await handle.close(); handle = undefined;
    await pathCheck();
    return Object.freeze({ sha256, bytes, canonicalPath, version });
  } finally { if (handle) await handle.close(); }
}

/**
 * Metadata capture performs no content reads. Its caller must authorize the exact
 * logical path and any network connection first. Canonical strings never pass
 * through Unicode folding or path.relative (which folds Unicode on Windows).
 * @param {{fs?:typeof fsp}} [options]
 */
function createWindowsPathIdentity({ fs = fsp } = {}) {
  const pins = new WeakSet();
  const changed = () => fail('ERR_WINDOWS_PATH_CHANGED', 'The chosen filesystem path changed while saving.');
  async function lstatOrMissing(file) {
    try { return await fs.lstat(file, { bigint: true }); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }
  async function directory(logical) {
    const canonical = await fs.realpath(logical), stat = await fs.stat(canonical, { bigint: true });
    if (!stat.isDirectory()) throw fail('ENOTDIR', 'The save parent is not a directory.');
    const identity = identityOf(stat);
    if (await fs.realpath(logical) !== canonical || !sameIdentity(identity, identityOf(await fs.stat(canonical, { bigint: true })))) throw changed();
    return { canonical, identity };
  }
  async function ancestor(logicalParent) {
    let logical = logicalParent;
    const missing = [];
    for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth++) {
      try { const found = await directory(logical); return { logical, ...found, missing: Object.freeze(missing.reverse()) }; }
      catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        const parent = path.dirname(logical);
        if (parent === logical) throw error;
        missing.push(path.basename(logical)); logical = parent;
      }
    }
    throw fail('ERR_WINDOWS_PATH_DEPTH', 'The save parent exceeds the path depth limit.');
  }

  /** Capture a coherent, immutable write destination without creating directories or files.
   * @returns {Promise<WindowsWriteTarget>}
   */
  async function captureWriteTarget(value, rootValue) {
    const logicalPath = absoluteWindowsPath(value), root = rootValue === undefined ? undefined : absoluteWindowsPath(rootValue, false);
    const rootInfo = root === undefined ? undefined : await directory(root);
    for (let attempt = 0; attempt < 3; attempt++) {
      const parent = await ancestor(path.dirname(logicalPath));
      const canonicalParent = path.join(parent.canonical, ...parent.missing);
      if (rootInfo && !canonicalInside(rootInfo.canonical, canonicalParent)) throw fail('ELOOP', 'The save destination resolves outside its authorized root.');
      const before = await lstatOrMissing(logicalPath);
      if (before?.isSymbolicLink()) throw fail('ELOOP', 'A symbolic file destination is not followed.');
      if (before && !before.isFile()) throw fail('EISDIR', 'The save destination is not a regular file.');
      let canonicalPath = path.join(canonicalParent, path.basename(logicalPath));
      if (before) {
        canonicalPath = await fs.realpath(logicalPath);
        if (path.dirname(canonicalPath) !== canonicalParent) throw changed();
        const physical = await fs.stat(canonicalPath, { bigint: true });
        if (!physical.isFile() || fileVersionKey(versionOf(before)) !== fileVersionKey(versionOf(physical))) throw changed();
      }
      const after = await lstatOrMissing(logicalPath);
      if ((!before && after) || (before && !after)) continue;
      if (before && after && (after.isSymbolicLink() || !after.isFile() || fileVersionKey(versionOf(before)) !== fileVersionKey(versionOf(after)) || await fs.realpath(logicalPath) !== canonicalPath)) throw changed();
      const parentAfter = await directory(parent.logical);
      if (parentAfter.canonical !== parent.canonical || !sameIdentity(parent.identity, parentAfter.identity)) throw changed();
      if (rootInfo) {
        const rootAfter = await directory(root);
        if (rootAfter.canonical !== rootInfo.canonical || !sameIdentity(rootAfter.identity, rootInfo.identity)) throw changed();
      }
      const queueKey = JSON.stringify([parent.canonical, parent.identity.dev, parent.identity.ino]);
      const targetKey = JSON.stringify([canonicalParent, parent.identity.dev, parent.identity.ino, path.basename(canonicalPath)]);
      const destinationPath = path.join(path.dirname(logicalPath), path.basename(canonicalPath));
      const pin = Object.freeze({ logicalPath, destinationPath, canonicalPath, canonicalParent, parentExists: parent.missing.length === 0, parentIdentity: parent.identity,
        ancestorLogicalPath: parent.logical, canonicalAncestor: parent.canonical, missingParents: parent.missing, queueKey, targetKey, exists: before !== null,
        fileVersion: before === null ? null : versionOf(before),
        ...(rootInfo ? { root, canonicalRoot: rootInfo.canonical, rootIdentity: rootInfo.identity } : {}) });
      pins.add(pin); return pin;
    }
    throw changed();
  }

  /** Re-resolve native identities after slow work/queue waits; preserveLeaf also guards a commit's actual destination. */
  /** @param {WindowsWriteTarget} pin @param {{preserveLeaf?:boolean, preserveVersion?:boolean,signal?:AbortSignal,metadataOnly?:boolean}} [options] */
  async function revalidate(pin, { preserveLeaf = false, preserveVersion = false, signal, metadataOnly = false } = {}) {
    if (!pin || !pins.has(pin)) throw fail('ERR_WINDOWS_IDENTITY', 'Only this helper\'s immutable captured paths can be revalidated.');
    if (metadataOnly && preserveVersion && pin.hashContent) throw fail('ERR_WINDOWS_IDENTITY', 'Content evidence cannot be checked with metadata alone.');
    abortCheck(signal);
    const originalAncestor = await directory(pin.ancestorLogicalPath);
    if (originalAncestor.canonical !== pin.canonicalAncestor || !sameIdentity(originalAncestor.identity, pin.parentIdentity)) throw changed();
    let current = await captureWriteTarget(pin.logicalPath, pin.root);
    if (current.canonicalParent !== pin.canonicalParent || pin.parentExists && (!current.parentExists || current.queueKey !== pin.queueKey) || pin.canonicalRoot !== current.canonicalRoot || pin.rootIdentity && (!current.rootIdentity || !sameIdentity(pin.rootIdentity, current.rootIdentity))) throw changed();
    if (preserveLeaf && current.canonicalPath !== pin.canonicalPath) throw changed();
    if (pin.hashContent && !metadataOnly) current = await captureContentTarget(current, { signal, maxBytes: pin.contentLimit ?? MAX_CONTENT_BYTES });
    if (preserveVersion && fileVersionKey(current.fileVersion) !== fileVersionKey(pin.fileVersion)) throw changed();
    abortCheck(signal);
    return current;
  }
  /** Add fresh content evidence without rebinding the captured native namespace.
   * A larger budget is selected only by trusted main PDF-export code; all normal
   * drawings/readers use the unchanged 128 MiB default. The branded pin seals it.
   * @param {WindowsWriteTarget} pin @param {{signal?:AbortSignal,maxBytes?:number}} [options]
   * @returns {Promise<WindowsWriteTarget>}
   */
  async function captureContentTarget(pin, { signal, maxBytes = MAX_CONTENT_BYTES } = {}) {
    if (maxBytes !== MAX_CONTENT_BYTES && maxBytes !== MAX_PDF_CONTENT_BYTES) throw fail('ERR_WINDOWS_CONTENT_LIMIT', 'An explicit drawing or PDF content budget is required.');
    const before = await revalidate(pin, { preserveLeaf: true, metadataOnly: true, signal });
    if ((before.fileVersion === null) !== (pin.fileVersion === null) || before.fileVersion && pin.fileVersion && statVersionKey(before.fileVersion) !== statVersionKey(pin.fileVersion)) throw changed();
    let fileVersion = pin.fileVersion;
    if (fileVersion !== null) {
      const digest = await coherentFileDigest(pin.logicalPath, { fs, signal, maxBytes, pdfExport: maxBytes === MAX_PDF_CONTENT_BYTES, expectedCanonicalPath: pin.canonicalPath, expectedVersion: fileVersion });
      fileVersion = Object.freeze({ ...fileVersion, sha256: digest.sha256 });
    }
    await revalidate(before, { preserveLeaf: true, preserveVersion: true, signal });
    const content = Object.freeze({ ...pin, hashContent: true, contentLimit: maxBytes, fileVersion });
    pins.add(content); return content;
  }
  return Object.freeze({ captureWriteTarget, captureContentTarget, revalidate });
}

module.exports = { MAX_PATH_LENGTH, MAX_PARENT_DEPTH, MAX_CONTENT_BYTES, MAX_PDF_CONTENT_BYTES, HASH_CHUNK_BYTES, asciiCaseFold, absoluteWindowsPath, canonicalInside, fileVersionKey, coherentFileDigest, createWindowsPathIdentity };
