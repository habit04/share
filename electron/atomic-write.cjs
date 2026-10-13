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
// times with a short back-off. A failed rename fails the save, leaving the original and any
// completed backup intact. A direct copy could truncate the only complete copy.
//
// Failures are re-thrown as `CODE: reason, '<destination>'` errors that keep `.code`, so the renderer
// (src/app/file-errors.ts) can show which file failed instead of the temporary name.
//
// Symbolic links (security review E-5). A save never writes through a link: a destination that is
// itself a symbolic link (or a junction) is refused with ELOOP - what an O_NOFOLLOW open gives -
// and the renderer says so, so a local user who can write a shared folder cannot plant
// `out.dxf -> ~/.profile` (or a link to another file in a sub-folder) and have the next save
// overwrite that file. Linked folders on the way are normal (macOS /var -> /private/var, Fedora
// Silverblue /home -> /var/home, Windows junctions and 8.3 names): the folder is resolved once and
// the write goes to that resolved folder ("pinned"); just before the temporary file replaces the
// destination the folder is resolved again, and a folder swapped for a link in between is refused
// without touching anything through it. With `root` (the project's folder, for a drawing that a
// project opened only by name lists) the resolved folder must also be inside the resolved `root`,
// so a linked sub-folder cannot lead such a write out of the project. The temporary files are
// created exclusively (O_EXCL / COPYFILE_EXCL, never through a link of that name). Destinations,
// backups and temporary names are rechecked before use; linked file destinations are refused.
// Node has no portable openat/renameat API: a hostile local process can still race a final check.
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { constants: fsConstants, realpath: realpathByLinks } = require('node:fs');
const { promisify } = require('node:util');
const { describeFileError } = require('./file-errors.cjs');

const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_DELAYS_MS = [15, 40, 90, 200];

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

/**
 * Queue spelling for a resolved destination. Windows existing leaves use native stored spelling;
 * only ASCII folds here, since JavaScript Unicode folding merges distinct NTFS names.
 * Missing non-ASCII aliases still require main-owned save admissions before slow producers.
 * @param {string} p
 * @param {string} platform
 */
function foldPath(p, platform) {
  const resolved = path.resolve(p);
  const r = platform === 'win32' ? resolved : resolved.normalize('NFC');
  if (platform === 'win32') return r.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  return platform === 'darwin' ? r.toLowerCase() : r;
}

/**
 * Is `child` the folder `dir` or inside it? Both are resolved paths (links already followed).
 * @param {string} dir
 * @param {string} child
 * @param {string} [platform]
 */
function isInsideFolder(dir, child, platform = process.platform) {
  if (platform === 'win32') {
    // Both arguments have native realpath spelling. path.relative also folds Unicode.
    const root = path.resolve(dir), target = path.resolve(child);
    return target === root || target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
  }
  const rel = path.relative(foldPath(dir, platform), foldPath(child, platform));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The refusal of a write through a symbolic link (E-5): ELOOP, the code an O_NOFOLLOW open gives
 * for a link, so src/app/file-errors.ts explains it.
 * @param {string} file  the path as the caller named it
 */
function linkError(file) {
  const e = /** @type {Error & { code?: string, path?: string }} */ (new Error(`ELOOP: symbolic link not followed, write '${file}'`));
  e.code = 'ELOOP';
  e.path = file;
  return e;
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
 * Resolve physical destinations concurrently, then reserve their write queues in invocation
 * order. Reservation does not await the write itself: unrelated files still write concurrently.
 * A failed resolution or write cannot poison later reservations.
 */
function createCanonicalWriteQueue(resolveKey = defaultWriter.canonicalWriteKey) {
  const enqueue = createWriteQueue();
  let admission = Promise.resolve();
  return function enqueueCanonical(file, job) {
    // Handle early rejection even while an earlier destination is still being resolved.
    const resolved = Promise.resolve().then(() => resolveKey(file)).then(
      (key) => ({ key, error: null, ok: true }),
      (error) => ({ key: null, error, ok: false }),
    );
    const reserved = admission.then(async () => {
      const result = await resolved;
      if (!result.ok) throw result.error;
      return { run: enqueue(result.key, () => job(result.key)) };
    });
    admission = reserved.then(() => undefined, () => undefined);
    return reserved.then(({ run }) => run);
  };
}

/**
 * Build the writer around an fs/promises-compatible object (tests inject failures through it).
 * `hooks.beforeRename(tmp, dest)` runs after the temporary file is complete and before it replaces
 * the destination; tests throw from it to simulate a crash at the worst moment.
 * `realpathFallback(p)`: resolves `p` when fs.realpath fails for another reason than a missing
 * path (default: Node's link-by-link fs.realpath with the real file system, none with an injected one).
 */
function createAtomicWriter(fs = fsp, options = {}) {
  const platform = options.platform || process.platform;
  const delays = options.renameDelays || RENAME_DELAYS_MS;
  const hooks = options.hooks || {};
  /** @type {((p: string) => Promise<string>) | null} */
  const realpathFallback = options.realpathFallback !== undefined ? options.realpathFallback : fs === fsp ? promisify(realpathByLinks) : null;

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

  /**
   * Create `file` exclusively (O_EXCL: never through a link of that name), write and fsync it.
   * `created.yes` is set once the file exists, so a failure removes only a file we created.
   */
  async function writeAndSync(file, data, encoding, created) {
    const fh = await fs.open(file, 'wx');
    created.yes = true;
    try {
      if (typeof data === 'string') await fh.writeFile(data, encoding || 'utf8');
      else await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
  }

  /** Rename with retries for sharing violations; never truncate the destination. */
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

  async function lstatOrNull(file) {
    try {
      return await fs.lstat(file);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
      throw err;
    }
  }

  /**
   * The resolved path, or null when it does not exist (yet). fs/promises' realpath is the native
   * one: on Windows it asks the volume for the final path (GetFinalPathNameByHandle), which RAM
   * disks and some network, virtual and FUSE drives cannot answer (EISDIR, EPERM or UNKNOWN). 0.4.1
   * then wrote to the path as given; refusing would make every save on such a drive fail, so the
   * links are resolved one component at a time instead (lstat + readlink), and the checks hold.
   */
  async function realpathInfoOrNull(p) {
    try {
      return { actual: await fs.realpath(p), native: true };
    } catch (err) {
      const code = err && err.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      if (!realpathFallback || code === 'ELOOP') throw err;
      try {
        return { actual: await realpathFallback(p), native: false };
      } catch (again) {
        if (again && (again.code === 'ENOENT' || again.code === 'ENOTDIR')) return null;
        throw err;
      }
    }
  }

  async function realpathOrNull(p) { return (await realpathInfoOrNull(p))?.actual ?? null; }

  // Node's link-by-link Windows fallback preserves requested casing. Check actual directory
  // identities rather than guessing a Unicode case table when native realpath is unavailable.
  async function fallbackInside(root, child) {
    const identity = await fs.stat(root, { bigint: true });
    if (!identity.isDirectory() || typeof identity.ino !== 'bigint' || identity.ino === 0n) return false;
    let folder = child;
    for (let depth = 0; depth < 128; depth++) {
      const stat = await fs.stat(folder, { bigint: true });
      if (stat.isDirectory() && stat.dev === identity.dev && stat.ino === identity.ino) return true;
      const parent = path.dirname(folder);
      if (parent === folder) return false;
      folder = parent;
    }
    return false;
  }

  async function fallbackStoredLeaf(folder, requested) {
    const leaf = path.basename(requested), expected = await fs.lstat(requested, { bigint: true });
    if (typeof expected.ino !== 'bigint' || expected.ino === 0n) throw linkError(requested);
    /** @type {string | null} */ let match = null;
    let ambiguous = false, count = 0;
    const entries = await fs.opendir(folder);
    for await (const entry of entries) {
      if (++count > 65536) throw linkError(requested);
      // An exact entry is unambiguous even if another name is a hard link to it.
      if (entry.name === leaf) return path.join(folder, leaf);
      if (!entry.isFile()) continue;
      const candidate = path.join(folder, entry.name), stat = await fs.lstat(candidate, { bigint: true });
      if (stat.isFile() && stat.dev === expected.dev && stat.ino === expected.ino) {
        if (match) ambiguous = true; else match = candidate;
      }
    }
    if (!match || ambiguous) throw linkError(requested);
    return match;
  }

  /**
   * Where a write of `file` lands (E-5): its folder resolved ("pinned") and the file name, or an
   * ELOOP error when the file is a symbolic link, or when its resolved folder is outside the
   * resolved `root`. A folder that does not exist is left to the write itself (ENOENT).
   * @param {string} file
   * @param {string | undefined} root
   * @returns {Promise<{ dest: string, dir: string | null }>}  dir: the pinned folder (null when missing)
   */
  async function confinedTarget(file, root) {
    const dirInfo = await realpathInfoOrNull(path.dirname(file));
    const realDir = dirInfo?.actual ?? null;
    if (realDir === null) return { dest: file, dir: null };
    if (root) {
      const rootInfo = await realpathInfoOrNull(root);
      const realRoot = rootInfo?.actual ?? path.resolve(root);
      if (!isInsideFolder(realRoot, realDir, platform) &&
          !(platform === 'win32' && (!dirInfo?.native || rootInfo && !rootInfo.native) && await fallbackInside(realRoot, realDir))) throw linkError(file);
    }
    let dest = path.join(realDir, path.basename(file));
    const st = await lstatOrNull(dest);
    if (st && st.isSymbolicLink()) throw linkError(file);
    if (platform === 'win32' && st && st.isFile()) {
      // Rename through a differently cased alias changes the stored leaf and splits subsequent
      // queue/backup identities. Preserve the native existing leaf, including Unicode aliases.
      const existingInfo = await realpathInfoOrNull(dest);
      const existing = existingInfo?.native ? existingInfo.actual : await fallbackStoredLeaf(realDir, dest);
      if (!existing || path.dirname(existing) !== realDir) throw linkError(file);
      dest = existing;
    }
    return { dest, dir: realDir };
  }

  /** The same destination resolution as a write, used only for main-process queue identity. */
  async function canonicalWriteKey(file) {
    if (typeof file !== 'string' || !file) throw new Error('Invalid path');
    try {
      return foldPath((await confinedTarget(file, undefined)).dest, platform);
    } catch (err) {
      throw fileError(err, file, 'write');
    }
  }

  /**
   * Pin both the requested and canonical parent chains. Existing linked folders are compatible,
   * but replacing any component, retargeting a link, or introducing a link after capture fails.
   * Recheck before each use and rename, including cleanup, so it cannot delete through a swap.
   */
  async function guardPath(file, root) {
    const { dest, dir } = await confinedTarget(file, root);
    if (dir === null) throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT', path: path.dirname(file) });
    const parents = [];
    const visited = new Set();
    const capture = async (start) => {
      let folder = start;
      while (!visited.has(folder)) {
        const stat = await lstatOrNull(folder);
        if (!stat || (!stat.isDirectory() && !stat.isSymbolicLink())) throw linkError(file);
        const real = await realpathOrNull(folder);
        if (!real) throw linkError(file);
        parents.push({ folder, real, linked: stat.isSymbolicLink(), dev: stat.dev, ino: stat.ino });
        visited.add(folder);
        const parent = path.dirname(folder);
        if (parent === folder) break;
        folder = parent;
      }
    };
    await capture(path.dirname(file));
    await capture(dir);
    if (root) await capture(path.resolve(root));
    const check = async (tmp) => {
      for (const pin of parents) {
        const stat = await lstatOrNull(pin.folder);
        if (!stat || stat.isSymbolicLink() !== pin.linked || (!pin.linked && !stat.isDirectory()) ||
            await realpathOrNull(pin.folder) !== pin.real ||
            (pin.ino !== undefined && (stat.ino !== pin.ino || stat.dev !== pin.dev))) throw linkError(file);
      }
      for (const candidate of [dest, tmp].filter(Boolean)) {
        const stat = await lstatOrNull(candidate);
        if (stat && stat.isSymbolicLink()) throw linkError(file);
      }
    };
    await check();
    return { dest, check };
  }

  /**
   * Copy `from` to `dest` through a temporary file + rename. The temporary file is created
   * exclusively, and the supplied guard checks the source, destination and temp name before
   * use. Linked destinations and changed folders fail without a direct copy. Errors name
   * `src` or `dest`.
   */
  async function copyThroughTemp(src, from, dest, check) {
    const tmp = tempNameFor(dest);
    let exists = false;
    try {
      await check();
      try {
        await fs.copyFile(from, tmp, fsConstants.COPYFILE_EXCL);
      } catch (err) {
        exists = !!err && err.code === 'EEXIST'; // a file (or link) of that name is not ours
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
      if (!exists) await removeQuietly(tmp, check);
      throw fileError(err, err && err.code === 'ENOENT' && (err.path === from || err.path === src) ? src : dest, 'copy');
    }
  }

  /**
   * Copy `src` to `dest` through a temporary file + rename (used for `.bak` copies and the
   * backup-file IPC). Returns `dest`. Like a write (E-5), `src` must not be a symbolic link, and
   * with `opts.root` both folders must resolve inside that folder: a backup must not copy a file
   * from elsewhere into the folder or write outside it.
   * @param {string} src
   * @param {string} dest
   * @param {{ root?: string }} [opts]
   */
  async function copyFileAtomic(src, dest, opts = {}) {
    let source;
    try {
      source = await guardPath(src, opts.root);
    } catch (err) {
      throw fileError(err, src, 'copy');
    }
    try {
      const target = await guardPath(dest, opts.root);
      const check = async (tmp) => { await source.check(); await target.check(tmp); };
      return await copyThroughTemp(src, source.dest, target.dest, check);
    } catch (err) {
      throw fileError(err, dest, 'copy');
    }
  }

  /**
   * Write `data` (string or bytes) to `file` crash-safely.
   * opts.backup: keep the previous content as `<file>.bak` (one generation).
   * opts.encoding: string encoding (default utf8).
   * opts.root: a folder the file's resolved folder must be inside (a project's folder); see the
   *   module comment (E-5). A destination that is a symbolic link is refused with ELOOP.
   * Resolves { path (the file written, in its resolved folder), backup (path or null), method ('rename') }.
   */
  async function atomicWriteFile(file, data, opts = {}) {
    if (typeof file !== 'string' || !file) throw new Error('Invalid path');
    let backup = null;
    let tmp = '';
    const tmpCreated = { yes: false };
    let check;
    try {
      const target = await guardPath(file, opts.root);
      const dest = target.dest;
      check = target.check;
      // A queued alias may have been retargeted while it waited. Never write a different
      // destination from the queue reservation; it could race that destination's other saves.
      if (opts.expectedDestination && foldPath(dest, platform) !== opts.expectedDestination) throw linkError(file);
      tmp = tempNameFor(dest);
      const before = await existingStat(dest);
      if (before && before.isDirectory()) {
        const e = /** @type {Error & { code?: string }} */ (new Error('illegal operation on a directory'));
        e.code = 'EISDIR';
        throw e;
      }
      // rename() would replace a read-only file without complaint on POSIX: refuse like a plain
      // write would, so marking a drawing read-only still protects it.
      if (before) await fs.access(dest, (fs.constants || fsp.constants).W_OK);
      await writeAndSync(tmp, data, opts.encoding, tmpCreated);
      await check(tmp);
      if (before && platform !== 'win32') {
        // Keep the permission bits of the file being replaced (the temp file got the umask default).
        await fs.chmod(tmp, before.mode & 0o7777).catch(() => {});
      }
      if (before && opts.backup) backup = await copyFileAtomic(dest, `${dest}.bak`, opts);
      if (hooks.beforeRename) await hooks.beforeRename(tmp, dest);
      const method = await replace(tmp, dest, check);
      tmpCreated.yes = false;
      await syncDir(path.dirname(dest));
      return { path: dest, backup, method };
    } catch (err) {
      if (tmpCreated.yes) await removeQuietly(tmp, check);
      throw fileError(err, file, 'write');
    }
  }

  return { atomicWriteFile, copyFileAtomic, replace, canonicalWriteKey };
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
  isInsideFolder,
  createAtomicWriter,
  createWriteQueue,
  createCanonicalWriteQueue,
  atomicWriteFile: defaultWriter.atomicWriteFile,
  copyFileAtomic: defaultWriter.copyFileAtomic,
  fileError,
  isTempName,
  tempNameFor,
};
