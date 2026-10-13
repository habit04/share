/** Native Windows identities for main-owned, already-authorized file paths. No access is granted here. */
'use strict';
const fsp = require('node:fs/promises');
const path = require('node:path').win32;

const MAX_PATH_LENGTH = 4096;
const MAX_PARENT_DEPTH = 128;
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
const fileVersionKey = (version) => version === null ? null : JSON.stringify([version.dev, version.ino, version.size, version.mtimeNs, version.ctimeNs]);

/** @typedef {{readonly dev:string, readonly ino:string}} FileIdentity */
/** @typedef {FileIdentity & {readonly size:string, readonly mtimeNs:string, readonly ctimeNs:string}} FileVersion */
/** @typedef {{readonly logicalPath:string, readonly destinationPath:string, readonly canonicalPath:string, readonly canonicalParent:string, readonly parentExists:boolean, readonly parentIdentity:FileIdentity, readonly ancestorLogicalPath:string, readonly canonicalAncestor:string, readonly missingParents:readonly string[], readonly queueKey:string, readonly targetKey:string, readonly exists:boolean, readonly fileVersion:FileVersion|null, readonly root?:string, readonly canonicalRoot?:string, readonly rootIdentity?:FileIdentity}} WindowsWriteTarget */

/**
 * This helper performs metadata reads only. Its caller must authorize the exact
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
  /** @param {WindowsWriteTarget} pin @param {{preserveLeaf?:boolean, preserveVersion?:boolean}} [options] */
  async function revalidate(pin, { preserveLeaf = false, preserveVersion = false } = {}) {
    if (!pin || !pins.has(pin)) throw fail('ERR_WINDOWS_IDENTITY', 'Only this helper\'s immutable captured paths can be revalidated.');
    const originalAncestor = await directory(pin.ancestorLogicalPath);
    if (originalAncestor.canonical !== pin.canonicalAncestor || !sameIdentity(originalAncestor.identity, pin.parentIdentity)) throw changed();
    const current = await captureWriteTarget(pin.logicalPath, pin.root);
    if (current.canonicalParent !== pin.canonicalParent || pin.parentExists && (!current.parentExists || current.queueKey !== pin.queueKey) || pin.canonicalRoot !== current.canonicalRoot || pin.rootIdentity && (!current.rootIdentity || !sameIdentity(pin.rootIdentity, current.rootIdentity))) throw changed();
    if (preserveLeaf && current.canonicalPath !== pin.canonicalPath) throw changed();
    if (preserveVersion && fileVersionKey(current.fileVersion) !== fileVersionKey(pin.fileVersion)) throw changed();
    return current;
  }
  return Object.freeze({ captureWriteTarget, revalidate });
}

module.exports = { MAX_PATH_LENGTH, MAX_PARENT_DEPTH, asciiCaseFold, absoluteWindowsPath, canonicalInside, fileVersionKey, createWindowsPathIdentity };
