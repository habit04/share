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

/** Run `operation`, retrying ONLY filesystem contention until the bounded
 * wait expires. Any other error, and expiry, propagates. The contention set
 * carries the codes the lead's Windows gate observed when a copy raced a
 * live database directory (round 7, R6-6): EBUSY/EPERM for locked files,
 * EPIPE for a broken write into a held directory, ENOTEMPTY when the stale
 * copy's directory was repopulated mid-remove. */
const CONTENTION_CODES = new Set(['EBUSY', 'EPERM', 'EPIPE', 'ENOTEMPTY']);
async function withBoundedContentionWait(operation, deadlineMs = LEGACY_COPY_WAIT_MS) {
  const deadline = Date.now() + deadlineMs;
  let delay = 25;
  for (;;) {
    try { return await operation(); }
    catch (error) {
      if (!CONTENTION_CODES.has(error?.code) || Date.now() >= deadline) throw error;
      await contentionWait(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 2, 250);
    }
  }
}

/** The copy-side state the recreate check compares (round 7, R6-1): the table
 * files the copy carried and the highest MANIFEST number. A healthy leveldb
 * open rewrites CURRENT/MANIFEST and deletes the old log, so a naive
 * before/after file comparison would refuse healthy reads — these are the
 * signals that survive a healthy open but not a recreate. */
function snapshotCopyState(leveldbDir) {
  let names;
  try { names = fsSync.readdirSync(leveldbDir); }
  catch { return { ldbFiles: [], manifestMax: null }; }
  const ldbFiles = [];
  let manifestMax = null;
  for (const name of names) {
    if (name.endsWith('.ldb')) ldbFiles.push(name);
    const manifest = /^MANIFEST-(\d+)$/.exec(name);
    if (manifest) manifestMax = Math.max(manifestMax ?? 0, Number(manifest[1]));
  }
  return { ldbFiles, manifestMax };
}

/** The head of the partition leveldb's LOG (never LOG.old: at open, Chromium
 * rotates the previous session's log aside and starts a fresh one, so LOG
 * carries THIS open's record). 'Creating DB' is written at the start of a
 * fresh log, so a bounded head read suffices. Null when unreadable. */
function readCopyLogHead(leveldbDir) {
  let fd;
  try {
    fd = fsSync.openSync(path.join(leveldbDir, 'LOG'), 'r');
    const buffer = Buffer.alloc(256 * 1024);
    const read = fsSync.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.toString('utf8', 0, read);
  } catch { return null; }
  finally { if (fd !== undefined) { try { fsSync.closeSync(fd); } catch { /* best effort */ } } }
}

/** R6-1 guard (round 7, replacing round 6's F2): F2 watched the ORIGINAL,
 * which nothing opens any more — the recreate hazard moved to the COPY. If
 * Chromium's recovery recreated the partition's leveldb, the read above
 * silently produced an empty dictionary that the gate would seal with a
 * permanent marker. Refuse instead (the gate sets legacyMigrationFailed, no
 * marker is written, the next launch retries) when the copy's LOG records a
 * creation, a copied table file is gone, or the MANIFEST numbering went
 * down — a recreation restarts all three. */
function assertCopyNotRecreated(leveldbDir, before) {
  const log = readCopyLogHead(leveldbDir);
  if (log !== null && log.includes('Creating DB')) {
    throw new Error('Legacy storage copy was recreated during the migration read (LOG records Creating DB); refusing to acknowledge the migration');
  }
  const after = snapshotCopyState(leveldbDir);
  for (const name of before.ldbFiles) {
    if (!after.ldbFiles.includes(name)) throw new Error(`Legacy storage copy lost ${name} during the migration read; refusing to acknowledge the migration`);
  }
  if (before.manifestMax !== null && (after.manifestMax === null || after.manifestMax < before.manifestMax)) {
    throw new Error('Legacy storage copy MANIFEST number went down during the migration read; refusing to acknowledge the migration');
  }
}

/** Copy the legacy leveldb (minus LOCK) into the partition's leveldb
 * directory, replacing any stale copy. Main-process file I/O only — with
 * this copy in place, Chromium never opens the original leveldb in this
 * process. The copy itself is synchronous (a handful of small files, once);
 * only the contention wait between attempts is asynchronous. */
async function copyLeveldbToPartition(sourceDir, destDir) {
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

/** The migration partition's storage directory, derived from the user-data
 * layout (Electron places partition storage under Partitions/<name>, the
 * name being the partition string without its persist: prefix). Derived —
 * never asked of a session (round 7, R6-6): on Windows a partition session
 * opens its Local Storage leveldb the moment it exists, so the copy must
 * be placed before any session is created, which leaves no session to ask. */
function legacyPartitionDir(userDataDir) {
  return path.join(userDataDir, 'Partitions', LEGACY_MIGRATION_PARTITION.replace(/^persist:/, ''));
}

/** Start the partition copy NOW and return its handle (round 7, R6-2 +
 * R6-6): session-free main-process file I/O, begun at the top of the ready
 * callback, long before legacyStorage creates the partition session — so
 * the copy is settled before any live database can hold the directory, and
 * nothing ever writes into a directory a live session holds. The promise
 * resolves to the copy-side state (R6-1) once the copy lands; the 2 s
 * contention bound stays on the copy only. Never throws synchronously. */
function startLegacyStorageCopy({ userDataDir }) {
  const partitionDir = legacyPartitionDir(userDataDir);
  const leveldbDir = path.join(partitionDir, 'Local Storage', 'leveldb');
  const promise = (async () => {
    await copyLeveldbToPartition(path.join(userDataDir, 'Local Storage', 'leveldb'), leveldbDir);
    return snapshotCopyState(leveldbDir);
  })();
  void promise.catch(() => {}); // Observed via the await in legacyStorage; startup must not see it unhandled first.
  return { partitionDir, leveldbDir, promise };
}

/** Remove the migration partition's storage directory (round 7, R6-4): a
 * partition left behind by a crashed or cleanup-failed launch must not let
 * a stale copy of the user's legacy storage persist indefinitely. */
function removeLegacyMigrationPartition(userDataDir) {
  try {
    fsSync.rmSync(legacyPartitionDir(userDataDir), { recursive: true, force: true });
    return true;
  } catch { return false; }
}

/** Begin the one-time migration at startup (round 7, R6-2 + R6-4 + R6-6).
 * When the migration marker already exists the migration is done: remove
 * any stale partition copy once — BEFORE anything calls fromPartition —
 * and return null (the gate will not run the legacy leg). Otherwise start
 * the session-free copy and return its handle for legacyStorage. Never
 * throws. */
function beginLegacyMigration({ userDataDir, markerPath }) {
  let markerPresent = false;
  try { markerPresent = fsSync.existsSync(markerPath); } catch { markerPresent = false; }
  if (markerPresent) {
    removeLegacyMigrationPartition(userDataDir);
    return null;
  }
  return startLegacyStorageCopy({ userDataDir });
}

/** Read the old file-origin storage without executing the old application or any plugins.
 * Round 6 (F1a): the read runs against a main-process COPY of the legacy
 * leveldb in a private partition — the confirmed stall was the migration
 * page's first synchronous localStorage touch blocking in Chromium's
 * browser-side open of the ORIGINAL leveldb, a database the previous process
 * had closed moments earlier (and whose recovery path can wipe it). The
 * original is only ever touched by bounded main-process file I/O here.
 * Round 7 (R6-2): the copy arrives STARTED — `copy` is the handle from
 * beginLegacyMigration, begun at the top of the ready callback. Round 7
 * (R6-6): it is awaited BEFORE the partition session is created — the
 * lead's Windows gate showed fromPartition opens the partition's leveldb
 * immediately, and a copy written into that live directory fails with
 * file-in-use errors while Chromium rebuilds the database (0 of 7 seeded
 * values served). Nothing here writes into a directory a live session
 * holds. */
async function legacyStorage({ BrowserWindow, session, indexFile, copy }) {
  if (!copy) throw new Error('Legacy migration copy was not started');
  const copyState = await copy.promise;
  const partitionSession = session.fromPartition(LEGACY_MIGRATION_PARTITION);
  const partitionProtocol = partitionSession.protocol;
  const { leveldbDir } = copy;
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
    // R6-1: refuse if Chromium recreated the COPY mid-flight — its empty
    // dictionary must never be sealed as a completed migration.
    assertCopyNotRecreated(leveldbDir, copyState);
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

module.exports = { APP_URL, LEGACY_MIGRATION_PARTITION, WORKER_CSP, assetPath, assetResponseHeaders, beginLegacyMigration, installAssetHandler, legacyStorage, removeLegacyMigrationPartition, rendererStartUrl, servedPath, startLegacyStorageCopy, withAssetHeaders, withBoundedContentionWait };
