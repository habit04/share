/** Serve only bundled renderer assets from a secure origin, with a one-time preference migration. */
const path = require('node:path');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { preferenceDictionary } = require('./renderer-preferences.cjs');
const APP_URL = 'jcad://app/index.html';
const LEGACY_LOAD_TIMEOUT_MS = 15_000;
const LEGACY_READ_TIMEOUT_MS = 5_000;

/**
 * Content-Security-Policy sent with worker scripts (docs/SECURITY-REVIEW.md E-19). The renderer
 * page keeps its own strict policy (index.html <meta>), which does not govern a dedicated worker
 * loaded from its own URL: the worker gets only what its response carries. The Manifold kernel
 * worker needs to load nothing but bundled scripts, fetch its bundled manifold.wasm and compile it,
 * so everything else is refused: no remote fetch or import(), no images, fonts, frames or nested
 * workers. 'self' is the jcad://app origin (a registered standard, secure scheme).
 */
const WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'";

/** Worker bundles: Vite emits every worker entry and chunk as assets/worker/<name>-<hash>.js (vite.config.ts). */
const WORKER_SCRIPT = /^\/assets\/worker\/[A-Za-z0-9._-]+\.m?js$/i;

/**
 * Extra response headers for the bundled file at `pathname`: WORKER_CSP for worker scripts,
 * nothing for anything else (the page, its scripts and styles, the wasm). The handler passes the
 * path of the file actually served (its real path relative to the real bundle root), never the
 * requested URL, so aliases that resolve to a worker file (a Windows 8.3 short name such as
 * `MANIFO~1.JS`, another letter case) still get the header. Case-insensitive as a second line of
 * defence for case-insensitive file systems.
 * @param {string} pathname
 * @returns {Record<string, string>}
 */
function assetResponseHeaders(pathname) {
  return WORKER_SCRIPT.test(pathname) ? { 'Content-Security-Policy': WORKER_CSP } : {};
}

/**
 * The URL the main window loads. The 3D security probe (scripts/e2e-3d-security.mjs) needs the
 * kernel's test hooks, which the renderer enables only for `?jcad3dTestHooks=1`; that query is
 * added only when JCAD_3D_TEST_HOOKS=1 is set AND the build allows inspection (a development run
 * or the dedicated test build), never in a shipping build.
 * @param {Record<string, string | undefined>} env
 * @param {boolean} allowInspection
 */
function rendererStartUrl(env, allowInspection) {
  return allowInspection === true && env.JCAD_3D_TEST_HOOKS === '1' ? `${APP_URL}?jcad3dTestHooks=1` : APP_URL;
}

/**
 * `response` with the extra headers for `pathname` (the same response when there are none).
 * @param {Response} response
 * @param {string} pathname
 */
function withAssetHeaders(response, pathname) {
  const extra = Object.entries(assetResponseHeaders(pathname));
  if (!extra.length) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of extra) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function assetPath(root, url) {
  const u = new URL(url);
  if (u.protocol !== 'jcad:' || u.hostname !== 'app' || u.port || u.username || u.password) throw new Error('Unknown renderer origin');
  const name = decodeURIComponent(u.pathname);
  if (!name.startsWith('/') || /[\\\0:]/.test(name) || name.split('/').includes('..')) throw new Error('Invalid renderer asset path');
  const file = path.resolve(root, `.${name === '/' ? '/index.html' : name}`);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Renderer asset is outside the bundle');
  return file;
}

/**
 * The served file as a URL-style path: `/` + its real path relative to the real bundle root.
 * @param {string} relative  path.relative(realRoot, realFile)
 */
function servedPath(relative) {
  return `/${relative.split(path.sep).join('/')}`;
}

/** Native realpath returns stored spelling. Do not apply JavaScript Unicode case folding:
 * Windows can store distinct names that path.relative incorrectly treats as equal.
 * @param {string} realRoot
 * @param {string} realFile
 */
function containedAssetRelative(realRoot, realFile) {
  const prefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  return realFile.startsWith(prefix) ? realFile.slice(prefix.length) : null;
}

function installAssetHandler({ protocol, net, root }) {
  protocol.handle('jcad', async (request) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      const file = assetPath(root, request.url);
      const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
      const relative = containedAssetRelative(realRoot, realFile);
      if (!relative) return new Response('Forbidden', { status: 403 });
      // Decide headers from the file that is served, not from the URL that asked for it.
      return withAssetHeaders(await net.fetch(pathToFileURL(realFile).href), servedPath(relative));
    } catch { return new Response('Not found', { status: 404 }); }
  });
}

/** The private partition the one-time migration reads from (round 6, F1a). */
const LEGACY_MIGRATION_PARTITION = 'persist:legacy-migration';
/** Bounded main-process wait for the process that just exited (the seed in the
 * harness, the old app version for a real user) to release the legacy leveldb
 * files — Windows post-close contention can hold them briefly. This is I/O
 * robustness for the COPY only: the migration read keeps its single unchanged
 * 5 s bound and is never retried. */
const LEGACY_COPY_WAIT_MS = 2_000;

const contentionWait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Run `operation`, retrying ONLY filesystem contention (EBUSY/EPERM) until
 * the bounded wait expires. Any other error, and expiry, propagates. */
async function withBoundedContentionWait(operation, deadlineMs = LEGACY_COPY_WAIT_MS) {
  const deadline = Date.now() + deadlineMs;
  let delay = 25;
  for (;;) {
    try { return await operation(); }
    catch (error) {
      const code = error?.code;
      if ((code !== 'EBUSY' && code !== 'EPERM') || Date.now() >= deadline) throw error;
      await contentionWait(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 2, 250);
    }
  }
}

/** The leveldb file set of a directory: name -> { size, mtimeMs, ino } for
 * regular files. A missing directory reads as an empty set. Synchronous on
 * purpose: the set is a handful of small files on a one-time path, and a
 * synchronous snapshot cannot interleave with the read it brackets. */
function snapshotLeveldbFiles(dir) {
  const files = new Map();
  let names;
  try { names = fsSync.readdirSync(dir); }
  catch (error) { if (error?.code === 'ENOENT') return files; throw error; }
  for (const name of names) {
    try {
      const stat = fsSync.lstatSync(path.join(dir, name));
      if (stat.isFile()) files.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino });
    } catch { /* Raced removal: the after-read comparison reads absence as change. */ }
  }
  return files;
}

/** F2 guard (round 6): after the read, the ORIGINAL leveldb must not have
 * shrunk, lost a file, or had its CURRENT change identity. Any of those means
 * the data was destroyed mid-flight (Chromium's DeleteAndRecreateDatabase
 * recovery is the feared path): refuse — the gate sets legacyMigrationFailed,
 * no marker is written, and the next launch retries. */
function assertLeveldbIntact(before, after) {
  let beforeBytes = 0, afterBytes = 0;
  for (const entry of before.values()) beforeBytes += entry.size;
  for (const entry of after.values()) afterBytes += entry.size;
  if (afterBytes < beforeBytes) throw new Error('Legacy storage shrank during the migration read; refusing to acknowledge the migration');
  for (const name of before.keys()) {
    if (!after.has(name)) throw new Error(`Legacy storage lost ${name} during the migration read; refusing to acknowledge the migration`);
  }
  const b = before.get('CURRENT'), a = after.get('CURRENT');
  if ((b === undefined) !== (a === undefined)
    || (b !== undefined && a !== undefined && (b.ino !== a.ino || b.size !== a.size || b.mtimeMs !== a.mtimeMs))) {
    throw new Error('Legacy storage CURRENT changed identity during the migration read; refusing to acknowledge the migration');
  }
}

/** Copy the legacy leveldb (minus LOCK) into the private partition's Local
 * Storage, replacing any stale copy. Main-process file I/O only — with this
 * copy in place, Chromium never opens the original leveldb in this process.
 * The copy itself is synchronous (a handful of small files, once, only when
 * a legacy store exists); only the contention wait between attempts is
 * asynchronous. */
async function copyLeveldbToPartition(sourceDir, partitionDir) {
  const destDir = path.join(partitionDir, 'Local Storage', 'leveldb');
  await withBoundedContentionWait(() => {
    fsSync.rmSync(destDir, { recursive: true, force: true });
    let names;
    try { names = fsSync.readdirSync(sourceDir); }
    catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    fsSync.mkdirSync(destDir, { recursive: true });
    for (const name of names) {
      if (name === 'LOCK') continue;
      fsSync.cpSync(path.join(sourceDir, name), path.join(destDir, name), { recursive: true });
    }
  });
}

/** Read the old file-origin storage without executing the old application or any plugins.
 * Round 6 (F1a): the read runs against a main-process COPY of the legacy
 * leveldb in a private partition — the confirmed stall was the migration
 * page's first synchronous localStorage touch blocking in Chromium's
 * browser-side open of the ORIGINAL leveldb, a database the previous process
 * had closed moments earlier (and whose recovery path can wipe it). The
 * original is only ever touched by bounded main-process file I/O here. */
async function legacyStorage({ BrowserWindow, session, userDataDir, indexFile }) {
  const partitionSession = session.fromPartition(LEGACY_MIGRATION_PARTITION);
  const partitionProtocol = partitionSession.protocol;
  const originalDir = path.join(userDataDir, 'Local Storage', 'leveldb');
  // F2: snapshot the original's file set before the read.
  const before = snapshotLeveldbFiles(originalDir);
  const partitionDir = partitionSession.getStoragePath();
  if (!partitionDir) throw new Error('Legacy migration partition has no storage path');
  // The copy starts now — early, in parallel with the rest of startup init —
  // and is awaited before the hidden window loads.
  const copied = copyLeveldbToPartition(originalDir, partitionDir);
  void copied.catch(() => {}); // Observed via the await below; a window-construction throw must not leave it unhandled.
  // With file privileges fused off, Chromium denies access to the legacy file-origin store.
  // Relax origin checks only for this hidden, sandboxed migration window. Its exact file URL
  // serves constant HTML with default-src 'none'; no application, plugin or remote code runs.
  const window = new BrowserWindow({ show: false, webPreferences: { partition: LEGACY_MIGRATION_PARTITION, sandbox: true, nodeIntegration: false, contextIsolation: true, devTools: false, webSecurity: false, allowRunningInsecureContent: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  let handling = false;
  const contents = window.webContents, cleanup = [];
  let phase = 'load', stopError, result, cleanupError;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  // Handler installation can fail before the first phase starts waiting.
  void stopped.catch(() => {});
  const fail = (error) => {
    if (stopError) return;
    stopError = error;
    rejectStopped(error);
  };
  const listen = (name, callback) => {
    contents.on(name, callback);
    cleanup.push(() => contents.removeListener(name, callback));
  };
  const gone = () => fail(new Error(`Legacy preference migration ${phase}: renderer stopped`));
  listen('destroyed', gone);
  listen('render-process-gone', gone);
  const failedLoad = (_event, _code, _description, _url, isMainFrame) => {
    if (isMainFrame) fail(new Error(`Legacy preference migration ${phase}: page failed to load`));
  };
  listen('did-fail-load', failedLoad);
  listen('did-fail-provisional-load', failedLoad);
  const within = async (operation, deadline, stage) => {
    phase = stage;
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => { if (stopError) throw stopError; return operation(); }),
        stopped,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Legacy preference migration ${stage} timed out`)), Math.max(0, deadline - Date.now())); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const ready = () => {
    if (contents.isDestroyed() || contents.isCrashed()) throw new Error('Legacy preference migration readiness: renderer stopped');
    if (path.resolve(fileURLToPath(contents.getURL())) !== path.resolve(indexFile)) throw new Error('Legacy preference migration readiness: unexpected page');
    return !contents.isLoadingMainFrame();
  };
  let removeReady = () => {};
  try {
    // The constant-HTML handler lives on the PARTITION session's protocol
    // (round 6): the default session never serves the migration page.
    partitionProtocol.handle('file', (request) => {
      try {
        if (path.resolve(fileURLToPath(request.url)).toLowerCase() !== path.resolve(indexFile).toLowerCase()) return new Response('', { status: 403 });
        return new Response('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'">', { headers: { 'content-type': 'text/html' } });
      } catch { return new Response('', { status: 403 }); }
    });
    handling = true;
    // The window must not load before its storage is the copy.
    await copied;
    // Keep navigation and execution independently bounded; an unresolved native
    // Promise must not leave the only application window hidden indefinitely.
    const loadDeadline = Date.now() + LEGACY_LOAD_TIMEOUT_MS;
    await within(() => window.loadFile(indexFile), loadDeadline, 'load');
    await within(() => {
      if (ready()) return;
      return new Promise((resolve, reject) => {
        const onReady = () => {
          try { if (ready()) { removeReady(); resolve(undefined); } }
          catch (error) { removeReady(); reject(error); }
        };
        removeReady = () => {
          contents.removeListener('did-finish-load', onReady);
          contents.removeListener('did-stop-loading', onReady);
        };
        contents.on('did-finish-load', onReady);
        contents.on('did-stop-loading', onReady);
        // Match Electron's execution predicate and close the registration race.
        onReady();
      });
    }, loadDeadline, 'readiness');
    const values = await within(() => {
      if (!ready()) throw new Error('Legacy preference migration execute: page resumed loading');
      return contents.executeJavaScript(`(() => {
      const result = Object.create(null); const encoder = new TextEncoder(); let size = 2;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i), value = key === null ? null : localStorage.getItem(key);
        if (key === null || value === null) continue;
        // Include UTF-8 encoding and JSON escaping/overhead, rather than counting characters.
        size += encoder.encode(JSON.stringify([key, value])).byteLength;
        if (size > 8 * 1024 * 1024) return null;
        result[key] = value;
      }
      return result;
    })()`);
    }, Date.now() + LEGACY_READ_TIMEOUT_MS, 'execute');
    if (values === null) throw new Error('Legacy preferences exceed 8 MiB');
    result = preferenceDictionary(values);
    // F2: refuse if the original leveldb was destroyed mid-flight.
    assertLeveldbIntact(before, snapshotLeveldbFiles(originalDir));
  } finally {
    removeReady();
    for (const remove of cleanup) remove();
    try { if (!window.isDestroyed()) window.destroy(); } catch (error) { cleanupError = error; }
    try { if (handling) partitionProtocol.unhandle('file'); } catch (error) { cleanupError ??= error; }
    // Clear the partition in finally: the copied legacy data must not outlive
    // the migration, whatever the read's outcome was.
    try { await partitionSession.clearStorageData(); } catch (error) { cleanupError ??= error; }
  }
  // A primary error propagates through finally. Only a successful read reaches
  // this point, where incomplete cleanup must still prevent acknowledgement.
  if (cleanupError) throw cleanupError;
  return result;
}

module.exports = { APP_URL, LEGACY_MIGRATION_PARTITION, WORKER_CSP, assetPath, assetResponseHeaders, installAssetHandler, legacyStorage, rendererStartUrl, servedPath, withAssetHeaders, withBoundedContentionWait };
