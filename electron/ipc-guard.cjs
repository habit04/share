/**
 * IPC caller validation and file-path allow lists for the main process (electron/main.cjs).
 *
 * Every `ipcMain.handle / on / once` registered through `guardIpc` first checks that the message
 * came from the application window's main frame, showing the application page (dist/index.html,
 * or the Vite dev server in development). Anything else - another window, a sub-frame, a page
 * the window was navigated to - is refused: `handle` rejects with "Unauthorized IPC caller",
 * `on` / `once` drop the message. Refusals are never rate-limited, only logged
 * (`<userData>/ipc-rejections.log`, kept under 256 KB, and the console).
 *
 * `createPathPolicy` holds the path rules shared by every file IPC: the paths the user chose in a
 * native dialog (or that a project file chosen that way lists) are "known" and may be read by
 * name; only some of them may be written (electron/path-registry.cjs), and each write channel
 * accepts its own file type only; images may be read next to known files or where a drawing that
 * was opened says they are, never from a network share another file merely names; everything is
 * checked for type, length, NUL bytes and being absolute first.
 *
 * `externalUrl` is the rule for links handed to the system browser.
 */
const path = require('node:path');
const fsSync = require('node:fs');
const { networkHost } = require('./path-registry.cjs');

const MAX_PATH = 4096;
const MAX_REJECTION_LOG = 256 * 1024;

/**
 * @typedef {object} RejectionLogger
 * @property {(kind: string, detail: string) => void} reject
 */

/**
 * @param {() => string} stateDir  folder for ipc-rejections.log (app.getPath('userData'))
 * @returns {RejectionLogger}
 */
function createRejectionLog(stateDir) {
  return {
    reject(kind, detail) {
      const line = `[${new Date().toISOString()}] ${kind}: ${detail}\n`;
      console.warn(`JCad: refused ${kind}: ${detail}`);
      try {
        const dir = stateDir();
        fsSync.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'ipc-rejections.log');
        let size = 0;
        try {
          size = fsSync.statSync(file).size;
        } catch {
          /* first entry */
        }
        if (size > MAX_REJECTION_LOG) fsSync.renameSync(file, `${file}.1`);
        fsSync.appendFileSync(file, line);
      } catch {
        /* logging must never break the IPC path */
      }
    },
  };
}

/**
 * Is this IPC event from the application page in the main window's top-level frame?
 * @param {Electron.IpcMainEvent | Electron.IpcMainInvokeEvent} ev
 * @param {Electron.BrowserWindow | null} win
 * @param {(url: string) => boolean} isAppUrl
 * @returns {string | null} null when trusted, else why not
 */
function untrustedReason(ev, win, isAppUrl) {
  if (!win || win.isDestroyed()) return 'no application window';
  const wc = win.webContents;
  if (!ev || ev.sender !== wc) return 'sender is not the application window';
  const frame = ev.senderFrame;
  if (!frame) return 'sender frame is gone';
  const main = wc.mainFrame;
  if (frame !== main && (frame.processId !== main.processId || frame.routingId !== main.routingId)) return 'sender is a sub-frame';
  if (frame.parent) return 'sender is a sub-frame';
  if (!isAppUrl(frame.url)) return `sender page is ${String(frame.url).slice(0, 200)}`;
  return null;
}

/**
 * Wrap ipcMain so every registered listener checks its caller first.
 * @param {Electron.IpcMain} ipcMain
 * @param {{ getWindow: () => Electron.BrowserWindow | null, isAppUrl: (url: string) => boolean, log: RejectionLogger }} opts
 */
function guardIpc(ipcMain, { getWindow, isAppUrl, log }) {
  /** Original listener -> wrapped listener, so removeListener keeps working. */
  const wrapped = new Map();
  /**
   * @param {string} channel
   * @param {any} ev
   */
  const trusted = (channel, ev) => {
    const why = untrustedReason(ev, getWindow(), isAppUrl);
    if (why) log.reject(`ipc ${channel}`, why);
    return !why;
  };
  /**
   * @param {string} channel
   * @param {(...args: any[]) => void} fn
   */
  const wrapListener = (channel, fn) => {
    /** @param {any} ev @param {...any} args */
    const w = (ev, ...args) => {
      if (trusted(channel, ev)) fn(ev, ...args);
    };
    wrapped.set(fn, w);
    return w;
  };
  return {
    /**
     * @param {string} channel
     * @param {(ev: Electron.IpcMainInvokeEvent, ...args: any[]) => any} fn
     */
    handle(channel, fn) {
      ipcMain.handle(channel, (ev, ...args) => {
        if (!trusted(channel, ev)) throw new Error('Unauthorized IPC caller');
        return fn(ev, ...args);
      });
    },
    /**
     * @param {string} channel
     * @param {(ev: Electron.IpcMainEvent, ...args: any[]) => void} fn
     */
    on(channel, fn) {
      ipcMain.on(channel, wrapListener(channel, fn));
      return this;
    },
    /**
     * @param {string} channel
     * @param {(ev: Electron.IpcMainEvent, ...args: any[]) => void} fn
     */
    once(channel, fn) {
      /** @param {any} ev @param {...any} args */
      const once = (ev, ...args) => {
        // Like EventEmitter.once, but only a trusted message consumes the listener.
        if (!trusted(channel, ev)) return;
        ipcMain.removeListener(channel, once);
        wrapped.delete(fn);
        fn(ev, ...args);
      };
      wrapped.set(fn, once);
      ipcMain.on(channel, once);
      return this;
    },
    /**
     * @param {string} channel
     * @param {(...args: any[]) => void} fn
     */
    removeListener(channel, fn) {
      const w = wrapped.get(fn);
      if (w) {
        ipcMain.removeListener(channel, w);
        wrapped.delete(fn);
      }
      return this;
    },
  };
}

/**
 * The URL test for the application page: the packaged / built `dist/index.html`, or the Vite dev
 * server's origin in development.
 * @param {string} indexFile absolute path of dist/index.html
 * @param {string | undefined} devUrl
 */
function appUrlTest(indexFile, devUrl) {
  const { fileURLToPath } = require('node:url');
  const fold = (/** @type {string} */ p) => {
    const r = path.resolve(p).normalize('NFC');
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  const target = fold(indexFile);
  const devOrigin = devUrl ? new URL(devUrl).origin : null;
  return (/** @type {string} */ url) => {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url);
      if (u.protocol === 'jcad:') return u.hostname === 'app' && !u.port && !u.username && !u.password && u.pathname === '/index.html';
      if (u.protocol === 'file:') {
        u.search = '';
        u.hash = '';
        // Compare file system paths, not URL spellings (percent-encoding, drive-letter case).
        return fold(fileURLToPath(u)) === target;
      }
      return devOrigin !== null && u.origin === devOrigin;
    } catch {
      return false;
    }
  };
}

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp)$/i;

/**
 * Path rules shared by the file IPC handlers.
 * @param {{ isKnownPath: (p: string) => boolean, isWritablePath?: (p: string) => boolean, knownPaths: () => Iterable<string>, log: RejectionLogger }} deps
 *   isWritablePath: may this known path be written by name (default: every known path)
 */
function createPathPolicy({ isKnownPath, isWritablePath = isKnownPath, knownPaths, log }) {
  /** Absolute image paths named by the drawings the main process has read (IMAGEDEF). */
  const referencedImages = new Set();
  /** The same for network paths (\\server\share\...), only those on the server of the drawing naming them. */
  const referencedNetwork = new Set();
  const norm = (/** @type {string} */ p) => {
    const r = path.resolve(p).normalize('NFC');
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  const netKey = (/** @type {string} */ p) => norm(p).toLowerCase();
  const remember = (/** @type {Set<string>} */ set, /** @type {string} */ key) => {
    set.add(key);
    if (set.size > 5000) set.delete(/** @type {string} */ (set.values().next().value));
  };

  /**
   * Basic shape of a path coming from the renderer.
   * @param {unknown} p
   * @returns {string | null} why it is refused, or null
   */
  function shapeProblem(p) {
    if (typeof p !== 'string' || p.length === 0) return 'not a path';
    if (p.length > MAX_PATH) return 'path too long';
    if (p.includes('\0')) return 'NUL byte in path';
    if (!path.isAbsolute(p)) return 'relative path';
    return null;
  }

  /** Is `child` the folder `dir` or inside it? */
  const inside = (/** @type {string} */ dir, /** @type {string} */ child) => {
    const rel = path.relative(dir, child);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };

  /**
   * Why the renderer may not write this path by name, or null when it may: the shape checks,
   * the channel's file type, then the write list (files the user chose, drawings listed by an opened
   * project: electron/path-registry.cjs).
   * @param {unknown} p
   * @param {RegExp} type  the file names this channel writes (e.g. /\.dxf$/i)
   * @returns {string | null}
   */
  function writeProblem(p, type) {
    const bad = shapeProblem(p);
    if (bad) return bad;
    const s = /** @type {string} */ (p);
    if (!type.test(s)) return 'wrong file type';
    if (!isKnownPath(s)) return 'not a file chosen by the user';
    if (!isWritablePath(s)) return 'read-only (named by a project file, not chosen by the user)';
    return null;
  }

  return {
    shapeProblem,
    writeProblem,
    /**
     * A path the renderer wants to write by name (save over, back up): see writeProblem. Returns
     * the path, or null after logging the refusal.
     * @param {unknown} p
     * @param {string} what  IPC channel, for the log
     * @param {RegExp} type  the file names this channel writes
     */
    writable(p, what, type) {
      const bad = writeProblem(p, type);
      if (bad) {
        log.reject(what, `${bad}: ${String(p).slice(0, 300)}`);
        return null;
      }
      return /** @type {string} */ (p);
    },
    /**
     * A path the renderer names directly (open by name, save over, back up): it must be one the
     * user chose in our dialogs. Returns the path, or null after logging the refusal.
     * @param {unknown} p
     * @param {string} what  IPC channel, for the log
     */
    known(p, what) {
      const bad = shapeProblem(p);
      if (bad) {
        log.reject(what, `${bad}: ${String(p).slice(0, 300)}`);
        return null;
      }
      const s = /** @type {string} */ (p);
      if (!isKnownPath(s)) {
        log.reject(what, `not a file chosen by the user: ${s.slice(0, 300)}`);
        return null;
      }
      return s;
    },
    /**
     * IMAGE bitmaps: an image file in the folder (or a sub-folder) of a file the user chose, or
     * one that a drawing the user opened references by its absolute path. An image on a network
     * share (\\server\share\..., //server/share/...) only next to a known file on that same
     * server: a drawing must not make the program connect (and sign in) to another computer.
     * @param {unknown} p
     * @returns {string | null} why it is refused, or null
     */
    imageProblem(p) {
      const bad = shapeProblem(p);
      if (bad) return bad;
      const s = /** @type {string} */ (p);
      if (!IMAGE_EXT.test(s)) return 'not an image file';
      const host = networkHost(s);
      if (host === '') return 'device path';
      const target = norm(s);
      if (host === null ? referencedImages.has(target) : referencedNetwork.has(netKey(s))) return null;
      // Next to a known file on the same kind of location: local next to local, a share only next to a file on that server.
      for (const k of knownPaths()) {
        if (!/\.(dxf|dwg)$/i.test(k) || networkHost(k) !== host) continue;
        if (inside(norm(path.dirname(k)), target)) return null;
      }
      return host === null ? 'not next to a drawing the user opened' : 'network path not next to a file the user opened on that server';
    },
    /** Resolve the actual image target before granting access; links cannot extend the scope. */
    async imagePath(file) {
      const bad = this.imageProblem(file);
      if (bad) throw new Error(bad);
      const fs = require('node:fs/promises');
      const actual = await fs.realpath(file);
      if (networkHost(actual) !== networkHost(file)) throw new Error('Image link changes the network location');
      const actualBad = this.imageProblem(actual);
      if (actualBad) throw new Error('Image resolves outside the permitted drawing folders');
      return actual;
    },
    /**
     * Remember the image files a drawing references (absolute, or relative to its folder). A
     * network path is kept only when the drawing is on that server too.
     * @param {string} drawingPath
     * @param {Iterable<string>} names
     */
    rememberImages(drawingPath, names) {
      const dir = path.dirname(drawingPath);
      const drawingHost = networkHost(drawingPath);
      for (const n of names) {
        if (typeof n !== 'string' || !n.trim() || n.length > MAX_PATH || n.includes('\0')) continue;
        const name = n.trim();
        if (!IMAGE_EXT.test(name)) continue;
        const abs = path.isAbsolute(name) || /^[A-Za-z]:[\\/]/.test(name) || networkHost(name) !== null ? name : path.join(dir, name);
        const host = networkHost(abs);
        if (host === null) remember(referencedImages, norm(abs));
        else if (host !== '' && host === drawingHost) remember(referencedNetwork, netKey(abs));
      }
    },
    /**
     * A file inside a folder the main process owns (plugins, packs): after resolving symbolic
     * links it must still be inside that folder.
     * @param {string} root
     * @param {string} file
     * @param {string} what
     */
    async insideRoot(root, file, what) {
      const fs = require('node:fs/promises');
      let realRoot;
      let realFile;
      try {
        realRoot = await fs.realpath(root);
        realFile = await fs.realpath(file);
      } catch (err) {
        if (err && err.code === 'ENOENT') return file; // the caller reports the missing file
        throw err;
      }
      if (!inside(realRoot, realFile)) {
        log.reject(what, `${file} resolves outside ${root}`);
        throw new Error('Invalid path');
      }
      return file;
    },
  };
}

/**
 * IMAGEDEF file names in DXF text (OBJECTS section, group code 1 of each IMAGEDEF object).
 * @param {string} text
 * @returns {string[]}
 */
function dxfImageNames(text) {
  const out = [];
  if (typeof text !== 'string' || !text.includes('IMAGEDEF')) return out;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i + 1 < lines.length; i += 2) {
    if (lines[i].trim() !== '0' || lines[i + 1].trim() !== 'IMAGEDEF') continue;
    for (let j = i + 2; j + 1 < lines.length; j += 2) {
      const code = lines[j].trim();
      if (code === '0') break;
      if (code === '1') out.push(lines[j + 1]);
    }
  }
  return out;
}

const REPO_PATH = '/habit04/share';

/**
 * A link the application may hand to the system browser: a page of this project's GitHub
 * repository, or (with `cashApp`) a Cash App profile. The URL is parsed first and compared by
 * scheme, host and path, after the parser resolved "." / ".." segments (also percent-encoded
 * ones and backslashes), so ".." cannot leave the repository; a user name / password, a port, an
 * encoded "/" or "\\" in the path, and anything over 16,000 characters are refused.
 * @param {unknown} u
 * @param {{ cashApp?: boolean }} [opts]
 * @returns {string | null} the normalised URL to open, or null
 */
function externalUrl(u, { cashApp = true } = {}) {
  if (typeof u !== 'string' || u.length === 0 || u.length > 16000) return null;
  let url;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  if (/%2f|%5c/i.test(url.pathname)) return null;
  if (url.hostname === 'github.com' && (url.pathname === REPO_PATH || url.pathname.startsWith(`${REPO_PATH}/`))) return url.href;
  if (cashApp && url.hostname === 'cash.app' && /^\/\$[A-Za-z][A-Za-z0-9_-]{0,19}$/.test(url.pathname) && !url.search && !url.hash) return url.href;
  return null;
}

module.exports = { guardIpc, appUrlTest, untrustedReason, createRejectionLog, createPathPolicy, dxfImageNames, externalUrl };
