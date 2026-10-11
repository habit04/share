// Crash-safe file writes for the main process.
//
// Every user file (drawings, projects, exports, autosaves, the symbol library, the recent list and
// window state) is written the same way:
//
//   1. the new content goes to a temporary file in the destination's own folder and is fsync'ed;
//   2. when asked, the current file is copied to `<name>.bak` (also through a temporary file + rename,
//      so the backup itself is never half written);
//   3. the temporary file is renamed over the destination. rename() replaces the directory entry in
//      one step on every platform (Node uses MoveFileEx(MOVEFILE_REPLACE_EXISTING) on Windows), so a
//      crash or power cut leaves either the old file or the new one, never a truncated mix;
//   4. the folder is fsync'ed (POSIX) so the rename itself survives a power cut.
//
// Windows: virus scanners, search indexers and sync clients briefly open files without
// FILE_SHARE_DELETE, which makes rename fail with EPERM / EACCES / EBUSY. The rename is retried a few
// times with a short back-off. If replacement still fails, the write fails and leaves the original
// and any completed backup intact. A direct copy over the destination could truncate the only copy.
//
// Failures are re-thrown as `CODE: reason, '<destination>'` errors that keep `.code`, so the renderer
// (src/app/file-errors.ts) can show which file failed instead of the temporary name.
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { describeFileError } = require('./file-errors.cjs');

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_DELAYS_MS = [15, 40, 90, 200];
// macOS exposes these system directories through fixed, root-owned aliases.
const DARWIN_ALIASES = new Map([['/var', '/private/var'], ['/tmp', '/private/tmp'], ['/etc', '/private/etc']]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** `<name>.~<random>.tmp` next to the destination (a short name when the original is very long). */
function tempNameFor(file) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const rand = crypto.randomBytes(6).toString('hex');
  return path.join(dir, base.length > 180 ? `.~jcad-${rand}.tmp` : `${base}.~${rand}.tmp`);
}

/** Temporary files this module creates (used to clean folders that only we write, e.g. autosave). */
function isTempName(name) {
  return /\.~[0-9a-f]{12}\.tmp$/.test(name) || /^\.~jcad-[0-9a-f]{12}\.tmp$/.test(name);
}

/** Node's "ENOSPC: no space left on device, write" -> "no space left on device". */
function reasonOf(err) {
  const msg = String((err && err.message) || err || 'unknown error');
  return msg.replace(/^[A-Z][A-Z0-9_]+:\s*/, '').replace(/,\s*\w+(\s+'[^']*')?(\s*->\s*'[^']*')?\s*$/, '') || msg;
}

/** Re-throwable error naming the user's file (not our temporary file) and keeping the error code. */
function fileError(err, file, op) {
  if (err && err.jcadFileError) return err;
  const code = (err && typeof err.code === 'string' && err.code) || 'UNKNOWN';
  const out = /** @type {Error & { code?: string, path?: string, syscall?: string, cause?: unknown, jcadFileError?: boolean }} */ (new Error(`${code}: ${reasonOf(err)}, ${op} '${file}'`));
  out.code = code;
  out.path = file;
  out.syscall = op;
  out.cause = err;
  out.jcadFileError = true;
  return out;
}

/** Per-file promise chain: writes to the same file run one after another, in call order. */
function createWriteQueue() {
  const tails = new Map();
  return function enqueue(key, job) {
    const prev = tails.get(key) || Promise.resolve();
    const run = prev.then(job, job);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return run;
  };
}

/**
 * Build the writer around an fs/promises-compatible object (tests inject failures through it).
 * `hooks.beforeRename(tmp, dest)` runs after the temporary file is complete and before it replaces
 * the destination; tests throw from it to simulate a crash at the worst moment.
 */
function createAtomicWriter(fs = fsp, options = {}) {
  const platform = options.platform || process.platform;
  const delays = options.renameDelays || RENAME_DELAYS_MS;
  const hooks = options.hooks || {};

  async function removeQuietly(p, check) {
    try {
      if (check) await check(p);
      await fs.rm(p, { force: true });
    } catch {
      /* best effort */
    }
  }

  async function syncDir(dir) {
    if (platform === 'win32') return; // directories cannot be opened for fsync on Windows
    let fh = null;
    try {
      fh = await fs.open(dir, 'r');
      await fh.sync();
    } catch {
      /* not supported by every file system: the data itself is already synced */
    } finally {
      if (fh) await fh.close().catch(() => {});
    }
  }

  async function writeAndSync(file, data, encoding, created) {
    const fh = await fs.open(file, 'wx');
    created();
    try {
      if (typeof data === 'string') await fh.writeFile(data, encoding || 'utf8');
      else await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /** Rename with retries for transient Windows sharing violations; never truncate the destination. */
  async function replace(tmp, dest, check) {
    let lastErr = null;
    for (let attempt = 0; attempt <= delays.length; attempt += 1) {
      try {
        if (check) await check(tmp);
        await fs.rename(tmp, dest);
        return 'rename';
      } catch (err) {
        lastErr = err;
        const code = err && err.code;
        if (code === 'EXDEV') break;
        if (!RENAME_RETRY_CODES.has(code) || attempt === delays.length) break;
        await sleep(delays[attempt]);
      }
    }
    throw lastErr;
  }

  async function existingStat(file) {
    try {
      return await fs.lstat(file);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      throw err;
    }
  }

  function unsafePath(file) {
    return Object.assign(new Error('symbolic links, junctions, or changed parent folders cannot be written'), { code: 'ELOOP', path: file });
  }

  /** A fixed macOS system alias, never a user-created link or a link to another destination. */
  async function darwinAliasTarget(dir, stat) {
    const target = platform === 'darwin' && DARWIN_ALIASES.get(dir);
    if (!target || stat.uid !== 0 || path.posix.resolve('/', await fs.readlink(dir)) !== target) return undefined;
    // The alias entry and /private must be protected from replacement by ordinary users.
    for (const protectedDir of ['/', '/private']) {
      const parent = await existingStat(protectedDir);
      if (!parent || !parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022)) return undefined;
    }
    const destination = await existingStat(target);
    if (!destination || !destination.isDirectory() || destination.isSymbolicLink() || destination.uid !== 0 || await fs.realpath(dir) !== target) return undefined;
    return target;
  }

  /**
   * Pin the existing parent chain and reject links (including Windows junctions), except macOS's
   * protected /var, /tmp and /etc aliases. Both the alias and its /private target chain are pinned.
   * Rechecked before
   * each rename and after creating the temp file. Node has no portable renameat/openat API, so a
   * hostile process can still race the final check and rename; these checks bound that practical
   * TOCTOU window without following a link or falling back to a destructive copy.
   */
  async function guardPath(file) {
    const parents = [];
    const visited = new Set();
    const pinParents = async (start) => {
      let dir = start;
      while (!visited.has(dir)) {
        const stat = await existingStat(dir);
        if (!stat) throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path: dir });
        const alias = stat.isSymbolicLink() ? await darwinAliasTarget(dir, stat) : undefined;
        if (!alias && (!stat.isDirectory() || stat.isSymbolicLink())) throw unsafePath(dir);
        parents.push({ dir, real: await fs.realpath(dir), dev: stat.dev, ino: stat.ino, alias });
        visited.add(dir);
        if (alias) await pinParents(alias);
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    };
    await pinParents(path.dirname(file));
    const check = async (tmp) => {
      for (const pin of parents) {
        const stat = await existingStat(pin.dir);
        const alias = stat?.isSymbolicLink() ? await darwinAliasTarget(pin.dir, stat) : undefined;
        if (!stat || alias !== pin.alias || (!alias && (!stat.isDirectory() || stat.isSymbolicLink())) || await fs.realpath(pin.dir) !== pin.real ||
            (pin.ino !== undefined && (stat.ino !== pin.ino || stat.dev !== pin.dev))) throw unsafePath(pin.dir);
      }
      for (const p of [file, tmp].filter(Boolean)) {
        const stat = await existingStat(p);
        if (stat && stat.isSymbolicLink()) throw unsafePath(p);
      }
    };
    await check();
    return check;
  }

  /**
   * Copy `src` to `dest` through a temporary file + rename (used for `.bak` copies and the
   * backup-file IPC). Returns `dest`.
   */
  async function copyFileAtomic(src, dest) {
    const tmp = tempNameFor(dest);
    let created = false;
    let check;
    try {
      check = await guardPath(dest);
      const source = await existingStat(src);
      if (source && source.isSymbolicLink()) throw unsafePath(src);
      created = true;
      try {
        await fs.copyFile(src, tmp, (fs.constants || fsp.constants).COPYFILE_EXCL);
      } catch (err) {
        if (err && err.code === 'EEXIST') created = false;
        throw err;
      }
      await check(tmp);
      const fh = await fs.open(tmp, 'r+');
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
      await replace(tmp, dest, check);
      await syncDir(path.dirname(dest));
      return dest;
    } catch (err) {
      if (created) await removeQuietly(tmp, check);
      throw fileError(err, err && err.code === 'ENOENT' && err.path === src ? src : dest, 'copy');
    }
  }

  /**
   * Write `data` (string or bytes) to `file` crash-safely.
   * opts.backup: keep the previous content as `<file>.bak` (one generation).
   * opts.encoding: string encoding (default utf8).
   * Resolves { path, backup (path or null), method ('rename') }.
   */
  async function atomicWriteFile(file, data, opts = {}) {
    if (typeof file !== 'string' || !file) throw new Error('Invalid path');
    const dest = file;
    const tmp = tempNameFor(dest);
    let backup = null;
    let tmpCreated = false;
    let check;
    try {
      check = await guardPath(dest);
      const before = await existingStat(dest);
      if (before && before.isDirectory()) {
        const e = /** @type {Error & { code?: string }} */ (new Error('illegal operation on a directory'));
        e.code = 'EISDIR';
        throw e;
      }
      // rename() would replace a read-only file without complaint on POSIX: refuse like a plain
      // write would, so marking a drawing read-only still protects it.
      if (before) await fs.access(dest, (fs.constants || fsp.constants).W_OK);
      await writeAndSync(tmp, data, opts.encoding, () => { tmpCreated = true; });
      await check(tmp);
      if (before && platform !== 'win32') {
        // Keep the permission bits of the file being replaced (the temp file got the umask default).
        await fs.chmod(tmp, before.mode & 0o7777).catch(() => {});
      }
      if (before && opts.backup) backup = await copyFileAtomic(dest, `${dest}.bak`);
      if (hooks.beforeRename) await hooks.beforeRename(tmp, dest);
      const method = await replace(tmp, dest, check);
      tmpCreated = false;
      await syncDir(path.dirname(dest));
      return { path: dest, backup, method };
    } catch (err) {
      if (tmpCreated) await removeQuietly(tmp, check);
      throw fileError(err, dest, 'write');
    }
  }

  return { atomicWriteFile, copyFileAtomic, replace };
}

const defaultWriter = createAtomicWriter();

const BACKUP_RE = /\.(dxf|jcadproj\.json)$/i;
/**
 * The backup-file IPC: copy a drawing or project file to `<file>.bak` through a temporary file +
 * fsync + rename. Resolves { ok: true, path } or { ok: false, code, error } (a message for the user);
 * it never throws and never reports success without a complete copy on disk.
 * `allowed(file)` is the main process's path allow-list (the paths our own dialogs, the recent list
 * and open projects produced): like save-dxf, the renderer cannot name an arbitrary file.
 */
async function backupFile(file, copy = defaultWriter.copyFileAtomic, allowed = (/** @type {string} */ _file) => true) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !BACKUP_RE.test(file)) {
    return { ok: false, code: 'EINVAL', error: 'Only DXF drawings and project files (absolute paths) can be backed up.' };
  }
  if (!allowed(file)) {
    return { ok: false, code: 'EINVAL', error: `The backup copy of "${path.basename(file)}" could not be made: only drawings and project files you opened or saved yourself, and the drawings listed by a project you opened, can be backed up.` };
  }
  try {
    return { ok: true, path: await copy(file, `${file}.bak`) };
  } catch (err) {
    const info = describeFileError(err, { action: 'backup', path: file });
    return { ok: false, code: info.code, error: info.message };
  }
}

module.exports = {
  backupFile,
  createAtomicWriter,
  createWriteQueue,
  atomicWriteFile: defaultWriter.atomicWriteFile,
  copyFileAtomic: defaultWriter.copyFileAtomic,
  fileError,
  isTempName,
  tempNameFor,
};
