/** Serve only bundled renderer assets from a secure origin, with a one-time preference migration. */
const path = require('node:path');
const fs = require('node:fs/promises');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { preferenceDictionary } = require('./renderer-preferences.cjs');
const APP_URL = 'jcad://app/index.html';

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

/** A plugin-realm session id: minted in the main process (128-bit random hex, or a test double of that shape). */
const PLUGIN_REALM_SESSION = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The one virtual plugin-realm file, served from main rather than from disk
 * (AMENDMENT-P25-CSP-HOSTING Part A1/B2): a realm module's
 * `import jcad from './jcad.js'` resolves to this body, which hands the module
 * the session's own jcad proxy the realm bootstrap parked on the realm global
 * under this well-known symbol for exactly the duration of the import.
 */
const PLUGIN_REALM_JCAD_SHIM = 'export default globalThis[Symbol.for("jcad.isolated.jcad")];';

/**
 * Fable F1 (the lead's ruling, 2026-10-21): the total size cap of one
 * session's snapshot. There is no package-total plugin limit elsewhere
 * in the codebase (plugin-files.cjs caps individual reads), so the
 * snapshot carries its own: 32 MiB of in-memory module bytes per
 * session, refused over the cap with a clear error at registration.
 */
const PLUGIN_REALM_SNAPSHOT_MAX_BYTES = 32 * 1024 * 1024;

/** The v1 plugin-changed failure (electron/plugin-files.cjs), reused by the snapshot's trust check. */
function pluginChangedError(message = 'Plugin source changed while it was read; try again.') {
  return Object.assign(new Error(message), { code: 'ERR_PLUGIN_CHANGED' });
}

/**
 * AMENDMENT-P25-CSP-HOSTING Part A1, as amended by Fable F1: the
 * plugin-realm served snapshots, sessionId -> the snapshot main took of
 * one main-vetted plugin package at registration time. Registrations are
 * minted and held ONLY in the main process, live exactly as long as the
 * isolated session they serve, and are dropped when the renderer reports
 * the session disposed (Part A2's unserve), when the main window closes
 * and on app quit (main.cjs wires both). Nothing is persisted, and —
 * the F1 property — the snapshot's bytes are read from disk exactly
 * once, at registration; serving never re-reads disk, so the bytes the
 * realm executes are the bytes that were vetted and hash-verified at
 * registration (approved bytes = executed bytes).
 */
function createPluginRealmRegistry() {
  const snapshots = new Map();
  const owners = new Map();
  // PR #38 [P2] (Codex review, 2026-10-22): a registration GENERATION.
  // Registering is async on the handler side (the F1 snapshot build is
  // awaited first), so a registration prepared for a renderer that has
  // since gone away (render-process-gone / destroyed — F4's clear())
  // must not commit into the cleared registry and serve. clear() bumps
  // the generation; a register() carrying the generation captured
  // before the build commits only if it is still current, and reports
  // the discard (false) so the handler can fail the load closed.
  let generation = 0;
  return {
    /** The current registration generation (see register()). */
    generation() { return generation; },
    /**
     * @param {string} sessionId
     * @param {{ files: Map<string, { bytes: Buffer, sha256: string }>, entrySha256: string, manifestSha256: string, totalBytes: number }} snapshot
     * @param {unknown} [owner] the registering contents (W-3): when
     * recorded, only this owner may unregister the session.
     * @param {number} [expectedGeneration] when given, the registration
     * commits only if it equals the current generation (PR #38 [P2]).
     * @returns {boolean} whether the registration committed
     */
    register(sessionId, snapshot, owner, expectedGeneration) {
      if (expectedGeneration !== undefined && expectedGeneration !== generation) return false;
      snapshots.set(sessionId, snapshot);
      if (owner !== undefined) owners.set(sessionId, owner);
      else owners.delete(sessionId);
      return true;
    },
    /**
     * Drop one registration. W-3 sender/owner check: a registration
     * WITH a recorded owner refuses an unregister from any other
     * sender (a no-op returning false — one window cannot end another
     * window's plugin session); a registration with no recorded owner
     * unregisters as before. clear() is the main process's own
     * teardown and is never owner-checked.
     * @param {string} sessionId
     * @param {unknown} [owner] the sender asking to unregister
     * @returns {boolean} whether a registration was dropped
     */
    unregister(sessionId, owner) {
      if (owners.has(sessionId) && owners.get(sessionId) !== owner) return false;
      owners.delete(sessionId);
      return snapshots.delete(sessionId);
    },
    clear() { generation += 1; snapshots.clear(); owners.clear(); },
    /** @param {string} sessionId */
    lookup(sessionId) { return snapshots.get(sessionId); },
  };
}

/**
 * Replace comments in a module's source with spaces (newlines kept), so
 * the recogniser below sees comment-interposed forms (`import /*c*\/ {y}
 * from '…'`, `import // note` <newline> `{z} from '…'`) exactly as the
 * parser does. String and template-literal contents are preserved
 * verbatim — their text may BE a specifier, and a comment marker inside
 * a string is not a comment. Deliberately a scanner, not a parser: its
 * only failure modes are the recogniser's own (bounded over/under-match,
 * see STATIC_MODULE_SPECIFIER).
 * @param {string} source
 * @returns {string}
 */
function stripModuleComments(source) {
  let out = '';
  let i = 0;
  let state = 'code'; // code | sq | dq | tpl | line | block
  const tplBraces = []; // brace depth of each open template ${…}
  while (i < source.length) {
    const c = source[i];
    const d = source[i + 1] ?? '';
    if (state === 'code') {
      if (c === '/' && d === '/') { state = 'line'; out += ' '; i += 2; continue; }
      if (c === '/' && d === '*') { state = 'block'; out += ' '; i += 2; continue; }
      if (c === "'") state = 'sq';
      else if (c === '"') state = 'dq';
      else if (c === '`') state = 'tpl';
      else if (tplBraces.length > 0 && c === '{') tplBraces[tplBraces.length - 1] += 1;
      else if (tplBraces.length > 0 && c === '}') {
        tplBraces[tplBraces.length - 1] -= 1;
        if (tplBraces[tplBraces.length - 1] === 0) { tplBraces.pop(); state = 'tpl'; }
      }
      out += c; i += 1; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; }
      i += 1; continue;
    }
    if (state === 'block') {
      if (c === '*' && d === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += '\n';
      i += 1; continue;
    }
    // String / template states: copy verbatim (honouring escapes).
    out += c;
    if (c === '\\' && i + 1 < source.length) { out += source[i + 1]; i += 2; continue; }
    if (state === 'sq' && c === "'") state = 'code';
    else if (state === 'dq' && c === '"') state = 'code';
    else if (state === 'tpl' && c === '`') state = 'code';
    else if (state === 'tpl' && c === '$' && d === '{') { out += d; i += 2; tplBraces.push(1); state = 'code'; continue; }
    i += 1;
  }
  return out;
}

/**
 * Static module specifiers in one module's source: `import … from '…'`,
 * `export … from '…'` and bare `import '…'`, with string literals only.
 * Runs over the comment-stripped source and tolerates the spaceless
 * forms minifiers emit (`import{x}from'…'`, `export*from'…'`,
 * `export{y}from'…'`) — Fable F1 re-check R1. Deliberately a recogniser,
 * not a parser: an over-match (a specifier-shaped string in code) can
 * only ADD a package file to the snapshot — hash-recorded, inside the
 * package — never reach outside it, and an under-match (a computed
 * specifier) is a dynamic import, governed by the serve-time snapshot
 * lookup like any other request. Dynamic `import(…)` never matches:
 * the clause grammar has no `(`.
 */
const STATIC_MODULE_SPECIFIER = /\b(?:import|export)\s*(?:\{[^{}]*\}|\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\{[^{}]*\}|\*(?:\s+as\s+[A-Za-z_$][\w$]*)?))?)?\s*from\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;

/** @param {string} source @returns {string[]} */
function staticModuleSpecifiers(source) {
  const out = [];
  for (const match of stripModuleComments(source).matchAll(STATIC_MODULE_SPECIFIER)) out.push(match[1] ?? match[2]);
  return out;
}

/**
 * Resolve a relative specifier against the importing file's
 * package-relative path, URL-style (`/` segments, dot segments folded).
 * Returns the package-relative path, or null when the specifier climbs
 * above the package root (such a module can never be served under this
 * session, so it is no part of the snapshot).
 * @param {string} fromRelPath
 * @param {string} specifier
 * @returns {string | null}
 */
function resolvePackageSpecifier(fromRelPath, specifier) {
  const parts = fromRelPath.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(segment);
  }
  return parts.join('/');
}

/**
 * Stat one snapshot file under the serving discipline (Part A1, condition
 * (b)) applied at registration: the file's real path must sit under the
 * package's real root under EXACTLY the requested relative spelling, so
 * symlink/junction escapes and case aliases are refused rather than
 * snapshotted. This is the walk's PRE-READ step: the snapshot cap is
 * charged from the returned size BEFORE the file is opened or buffered
 * (Fable F1 re-check R3a — the charge can never be poisoned by a torn
 * pre-stat, because the read re-verifies every stat field through the
 * held handle and the post-walk second pass re-stats and re-hashes the
 * whole set). Returns the stat identity, or null when no regular file
 * exists under that spelling (a specifier naming nothing is simply not
 * part of the graph — if live code imports it, the load fails closed at
 * the serve-time lookup).
 * @param {string} realRoot
 * @param {string} relPath
 * @returns {Promise<{realFile: string, size: bigint, mtimeNs: bigint, ctimeNs: bigint, dev: bigint, ino: bigint} | null>}
 */
async function statSnapshotFile(realRoot, relPath) {
  let realFile;
  try {
    realFile = await fs.realpath(path.join(realRoot, ...relPath.split('/')));
  } catch {
    return null;
  }
  const contained = containedAssetRelative(realRoot, realFile);
  if (contained === null || servedPath(contained) !== `/${relPath}`) {
    throw new Error(`plugin module "${relPath}" resolves outside its package or under a different spelling; refusing to serve this package`);
  }
  let st;
  try {
    st = await fs.stat(realFile, { bigint: true });
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return { realFile, size: st.size, mtimeNs: st.mtimeNs, ctimeNs: st.ctimeNs, dev: st.dev, ino: st.ino };
}

function sameStatIdentity(a, b) {
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Read one snapshot file EXACTLY once through a held handle, verifying
 * the handle's stat still matches the PRE-READ stat on both sides of the
 * read. A file that changes while it is read fails with
 * ERR_PLUGIN_CHANGED, v1's stable-read discipline.
 * @param {{realFile: string, size: bigint, mtimeNs: bigint, ctimeNs: bigint, dev: bigint, ino: bigint}} info
 * @returns {Promise<Buffer>}
 */
async function readSnapshotFile(info) {
  const handle = await fs.open(info.realFile, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameStatIdentity(before, info)) throw pluginChangedError();
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (!sameStatIdentity(after, before) || BigInt(bytes.length) !== before.size) throw pluginChangedError();
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Take the F1 snapshot of one vetted plugin package: read the entry plus
 * its static module graph (relative `import`/`export … from` specifiers,
 * resolved inside the package) exactly once, record a SHA-256 per file,
 * and — when the caller supplies the hashes the user approved — verify
 * the snapshot against them. Two checks, one trust decision (W-1, the
 * lead's ruling 2026-10-22): the ENTRY check compares the entry file's
 * hash alone (the approval's original identity, and the fast path the
 * renderer's own read can compute), and the MANIFEST check compares a
 * hash over the sorted (path, sha256) list of EVERY snapshotted file —
 * entry included — so a changed dependency with an unchanged entry also
 * fails. Either mismatch is the trust check failing: the error carries
 * v1's ERR_PLUGIN_CHANGED code. Dynamic `import()` specifiers
 * are not walked (they are computed at run time); they resolve at serve
 * time against this same snapshot — a path in the snapshot serves, a
 * path outside it is refused (404). The one virtual file, the root
 * `jcad.js` shim, is main's own constant and never package content, so
 * it is never snapshotted.
 * @param {string} realRoot the package directory's real path
 * @param {string} entryRelPath the entry's package-relative path (the manifest's "main")
 * @param {{ approvedEntryHash?: string, approvedManifestHash?: string, maxBytes?: number }} [options]
 * @returns {Promise<{ files: Map<string, { bytes: Buffer, sha256: string }>, entrySha256: string, manifestSha256: string, pluginJsonSha256: string | undefined, totalBytes: number }>}
 */
async function buildPluginRealmSnapshot(realRoot, entryRelPath, options = {}) {
  const maxBytes = options.maxBytes ?? PLUGIN_REALM_SNAPSHOT_MAX_BYTES;
  const files = new Map();
  const stats = new Map();
  let totalBytes = 0;
  const seen = new Set();
  const queue = [entryRelPath];
  while (queue.length > 0) {
    const relPath = /** @type {string} */ (queue.shift());
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    const info = await statSnapshotFile(realRoot, relPath);
    if (info === null) continue;
    // R3(a): the cap is charged from the PRE-READ stat size — an
    // over-cap file is refused here, before it is opened or buffered.
    if (totalBytes + Number(info.size) > maxBytes) {
      throw new Error(`plugin package snapshot exceeds the ${maxBytes}-byte snapshot limit at "${relPath}"; refusing to serve this package`);
    }
    const bytes = await readSnapshotFile(info);
    totalBytes += bytes.length;
    files.set(relPath, { bytes, sha256: createHash('sha256').update(bytes).digest('hex') });
    stats.set(relPath, info);
    for (const specifier of staticModuleSpecifiers(bytes.toString('utf8'))) {
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
      const resolved = resolvePackageSpecifier(relPath, specifier);
      if (resolved === null || resolved === 'jcad.js' || !/\.m?js$/.test(resolved)) continue;
      if (!seen.has(resolved)) queue.push(resolved);
    }
  }
  // PR #38 [P1] (Codex review, 2026-10-22): plugin.json joins the
  // MANIFEST. Approval binds the POLICY (capabilities, the isolation
  // flag), not just the code — W-1's manifest covered the module graph
  // only, so a plugin.json-only change (the entry byte-identical) was
  // silently granted under the old approval. The manifest file is read
  // here with the same stability discipline as a graph file and its
  // hash joins the manifest lines below under its package-relative
  // path "plugin.json"; it is NOT retained in the served files map
  // (the realm never serves it — its bytes are the vetted policy, not
  // package content) and it is not charged to the snapshot cap (it is
  // hashed and dropped, never held; the serve handler's own manifest
  // read is size-capped before this build runs). A package without
  // plugin.json snapshots exactly as before.
  let pluginJson = null;
  if (!files.has('plugin.json')) {
    const info = await statSnapshotFile(realRoot, 'plugin.json');
    if (info !== null) {
      const bytes = await readSnapshotFile(info);
      pluginJson = { sha256: createHash('sha256').update(bytes).digest('hex'), info };
    }
  }
  // R3(b): SECOND-PASS RE-VERIFICATION. The per-read handle checks above
  // prove each file was stable WHILE it was read; they cannot prove the
  // set is one version — an early file can change after its read while
  // later files are walked. Re-stat and re-hash EVERY snapshotted file;
  // any drift aborts the registration with ERR_PLUGIN_CHANGED, so a
  // mixed-version snapshot is never registered or served.
  for (const [relPath, file] of files) {
    const recorded = stats.get(relPath);
    const now = await statSnapshotFile(realRoot, relPath);
    if (now === null || !sameStatIdentity(now, recorded)) {
      throw pluginChangedError('Plugin source changed while it was being snapshotted; reload the plugin to retry.');
    }
    const bytes = await readSnapshotFile(now);
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw pluginChangedError('Plugin source changed while it was being snapshotted; reload the plugin to retry.');
    }
  }
  if (pluginJson) {
    const now = await statSnapshotFile(realRoot, 'plugin.json');
    if (now === null || !sameStatIdentity(now, pluginJson.info)) {
      throw pluginChangedError('Plugin source changed while it was being snapshotted; reload the plugin to retry.');
    }
    const bytes = await readSnapshotFile(now);
    if (createHash('sha256').update(bytes).digest('hex') !== pluginJson.sha256) {
      throw pluginChangedError('Plugin source changed while it was being snapshotted; reload the plugin to retry.');
    }
  }
  const entry = files.get(entryRelPath);
  if (!entry) throw new Error(`plugin entry "${entryRelPath}" could not be read from the package`);
  if (options.approvedEntryHash !== undefined && options.approvedEntryHash !== entry.sha256) {
    throw pluginChangedError('Plugin source changed since it was approved; reload the plugin to approve the new source.');
  }
  // W-1: the MANIFEST hash — SHA-256 over the canonical manifest text:
  // one line per snapshotted file, "<sha256>\0<package-relative path>\n",
  // lines ordered by path (code-unit order). The NUL separator and the
  // fixed-width hash keep the encoding unambiguous for any path a
  // package can contain. The entry is one of the lines, so the manifest
  // binds the entry too; the separate entry check above remains as the
  // approval's fast path (and the only check for a first registration,
  // which has no remembered manifest yet).
  const manifestPaths = [...files.keys()];
  if (pluginJson) manifestPaths.push('plugin.json');
  const manifestText = manifestPaths.sort().map((relPath) => `${relPath === 'plugin.json' && pluginJson ? pluginJson.sha256 : files.get(relPath).sha256}\0${relPath}\n`).join('');
  const manifestSha256 = createHash('sha256').update(manifestText, 'utf8').digest('hex');
  if (options.approvedManifestHash !== undefined && options.approvedManifestHash !== manifestSha256) {
    throw pluginChangedError('Plugin package changed since it was approved; reload the plugin to approve the new package.');
  }
  return { files, entrySha256: entry.sha256, manifestSha256, pluginJsonSha256: pluginJson ? pluginJson.sha256 : undefined, totalBytes };
}

/**
 * A `/plugin-realm/<session>/<relpath>` URL-style path naming a script: the
 * CSP-hosting amendment serves a registered plugin package's files under the
 * same worker CSP as the bundled worker scripts. Only a .js/.mjs final
 * segment under a session segment qualifies, and dot segments never do (the
 * handler refuses them outright, and this decision is only ever consulted
 * with the verified served path, never the raw request URL).
 * @param {string} pathname
 */
function isPluginRealmScriptPath(pathname) {
  const parts = pathname.split('/');
  if (parts.length < 4 || parts[0] !== '' || parts[1] !== 'plugin-realm') return false;
  if (!PLUGIN_REALM_SESSION.test(parts[2])) return false;
  const rel = parts.slice(3);
  if (rel.some((seg) => seg === '' || seg === '.' || seg === '..')) return false;
  return /\.m?js$/.test(rel[rel.length - 1]);
}

/**
 * Extra response headers for the bundled file at `pathname`: WORKER_CSP for worker scripts,
 * nothing for anything else (the page, its scripts and styles, the wasm). The handler passes the
 * path of the file actually served (its real path relative to the real bundle root), never the
 * requested URL, so aliases that resolve to a worker file (a Windows 8.3 short name such as
 * `MANIFO~1.JS`, another letter case) still get the header. Case-insensitive as a second line of
 * defence for case-insensitive file systems. A plugin-realm script served from a registered
 * package (CSP-hosting amendment) carries the same header, under the same decide-from-the-
 * served-file discipline.
 * @param {string} pathname
 * @returns {Record<string, string>}
 */
function assetResponseHeaders(pathname) {
  return WORKER_SCRIPT.test(pathname) || isPluginRealmScriptPath(pathname) ? { 'Content-Security-Policy': WORKER_CSP } : {};
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

/**
 * Serve one file of a registered plugin package from its registration
 * snapshot (AMENDMENT-P25-CSP-HOSTING Part A1, as amended by Fable F1).
 * Disk is never re-read here: the response body is the snapshot's
 * in-memory bytes — the exact bytes main read, confined and hash-verified
 * at registration — so a package replaced on disk mid-session changes
 * nothing the realm executes. A requested path that is not in the
 * snapshot is refused (404): under snapshot serving the snapshot IS the
 * package, for static and dynamic imports alike. Malformed paths keep
 * the confinement refusals of the disk-serving discipline (dot segments,
 * backslashes and separators inside a segment are refused outright).
 * The virtual `jcad.js` shim is answered from main and shadows any
 * package file of that name, as before.
 * @param {URL} url the parsed request URL (host already validated by the caller)
 * @param {ReturnType<typeof createPluginRealmRegistry>} pluginRealm
 */
async function pluginRealmResponse(url, pluginRealm) {
  // W-3: EVERY plugin-realm response — served file, shim and refusal
  // alike — carries X-Content-Type-Options: nosniff, so no response
  // from this root can be MIME-sniffed into a different content type.
  const respond = (response) => {
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
  const parts = url.pathname.split('/').slice(2); // [sessionId, ...rel]
  const sessionId = parts[0];
  const rawRel = parts.slice(1);
  if (!sessionId || !PLUGIN_REALM_SESSION.test(sessionId) || rawRel.length === 0) return respond(new Response('Not found', { status: 404 }));
  let rel;
  try {
    rel = rawRel.map((seg) => decodeURIComponent(seg));
  } catch { return respond(new Response('Not found', { status: 404 })); }
  if (rel.some((seg) => seg === '' || seg === '.' || seg === '..' || /[/\\\0:]/.test(seg))) return respond(new Response('Forbidden', { status: 403 }));
  const snapshot = pluginRealm.lookup(sessionId);
  if (!snapshot) return respond(new Response('Not found', { status: 404 }));
  const relPath = rel.join('/');
  const decideAs = `/plugin-realm/${sessionId}/${relPath}`;
  if (relPath === 'jcad.js') {
    return respond(withAssetHeaders(new Response(PLUGIN_REALM_JCAD_SHIM, { headers: { 'content-type': 'text/javascript' } }), decideAs));
  }
  const file = snapshot.files.get(relPath);
  if (!file) return respond(new Response('Not found', { status: 404 }));
  return respond(withAssetHeaders(new Response(file.bytes, { headers: { 'content-type': 'text/javascript' } }), decideAs));
}

function installAssetHandler({ protocol, net, root, pluginRealm }) {
  protocol.handle('jcad', async (request) => {
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
      const url = new URL(request.url);
      if (url.pathname.startsWith('/plugin-realm/')) {
        // W-3: the realm's pre-dispatch refusals (no realm registered, or a
        // wrong-host request) carry nosniff too, like every response
        // pluginRealmResponse produces — no plugin-realm response is
        // MIME-sniffable, whichever branch answers it.
        if (!pluginRealm) return new Response('Not found', { status: 404, headers: { 'X-Content-Type-Options': 'nosniff' } });
        if (url.protocol !== 'jcad:' || url.hostname !== 'app' || url.port || url.username || url.password) return new Response('Not found', { status: 404, headers: { 'X-Content-Type-Options': 'nosniff' } });
        return await pluginRealmResponse(url, pluginRealm);
      }
      const file = assetPath(root, request.url);
      const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
      const relative = containedAssetRelative(realRoot, realFile);
      if (!relative) return new Response('Forbidden', { status: 403 });
      // Decide headers from the file that is served, not from the URL that asked for it.
      return withAssetHeaders(await net.fetch(pathToFileURL(realFile).href), servedPath(relative));
    } catch { return new Response('Not found', { status: 404 }); }
  });
}


const fsSync = require('node:fs');
const { readLegacyLocalStorage, LEGACY_STORE_TOO_LARGE } = require('./legacy-leveldb.cjs');
/** Read the old file-origin storage without executing the old application or any plugins.
 *
 * Round 12: the read is a pure-JS parse of the legacy leveldb in this
 * process (electron/legacy-leveldb.cjs) — plain fs reads with full
 * sharing. Nothing opens the store with Chromium: no LOCK, no
 * append-open of MANIFEST/.log, no CURRENT rewrite, and the whole
 * copy/partition/hidden-window path of rounds 6-11 is gone, taking
 * the stall class it could not escape (Chromium's leveldb open of a
 * fresh copy colliding with the OS's on-close scans) with it. Any
 * parse failure throws, and the caller takes the failed-leg path
 * (no marker, retry next launch) — there is no window fallback.
 * The 8 MiB accounting is the dump's own, unchanged: the UTF-8 JSON
 * size of the dictionary, brackets included.
 *
 * Round 12b (R12-4): the read itself runs BEFORE whenReady
 * (readLegacyStoreBeforeReady, called from main.cjs right after the
 * pre-ready snapshot), so it never overlaps the default session's
 * own open of the store at whenReady. This leg only consumes that
 * result: a caught read error is rethrown here (the gate's failed
 * leg: no marker, retry next launch), a dictionary goes through the
 * unchanged accounting and validation. No result at all (the store
 * was not read before ready) is also a failed leg, never an empty
 * success.
 * @param {{ read: { values: Record<string, string> } | { error: unknown } | null }} options */
async function legacyStorage({ read }) {
  if (!read) throw new Error('The legacy store was not read before ready');
  if ('error' in read) throw read.error;
  const values = read.values;
  let size = 2;
  const encoder = new TextEncoder();
  for (const [key, value] of Object.entries(values)) {
    size += encoder.encode(JSON.stringify([key, value])).byteLength;
    if (size > 8 * 1024 * 1024) throw new Error('Legacy preferences exceed 8 MiB');
  }
  return preferenceDictionary(values);
}

/**
 * Round 12b (R12-7, data preservation): a read error that says the
 * store's BYTES are bad — any parse/decode failure of the reader —
 * as opposed to a filesystem error (ENOENT-type absence, an AV
 * lock's EBUSY/EPERM: Node system errors carry a `syscall`), which
 * says nothing about the bytes, and as opposed to the reader's
 * size bound (a large store is not a corrupt one).
 * A file the store's metadata names but that is missing (the MANIFEST
 * CURRENT names, a live table, a listed log) is corruption to leveldb: the reader rethrows
 * that ENOENT as LEGACY_STORE_MISSING_FILE, with no syscall, so it is
 * a decode failure here too (R12-7 widening). Absence of the
 * directory or of CURRENT stays an fs error.
 * @param {unknown} error
 */
function legacyStoreDecodeFailure(error) {
  if (!error || typeof error !== 'object') return true;
  const { syscall, code } = /** @type {{ syscall?: unknown, code?: unknown }} */ (error);
  if (typeof syscall === 'string') return false;
  return code !== LEGACY_STORE_TOO_LARGE;
}

/**
 * Round 12b (R12-7, data preservation): COPY the legacy store (never
 * move, never delete; LOCK excluded) to
 * <Local Storage>/leveldb.preserved-<timestamp> before whenReady. A
 * store the reader cannot decode is one the default session's own
 * leveldb recovery may recreate at whenReady, wiping its bytes; the
 * copy keeps them for a later fix, while Chromium's behaviour is
 * unchanged. Bounded: once per distinct failure — skipped when an
 * existing leveldb.preserved-* directory already holds the same
 * MANIFEST file name(s) and size(s) (CURRENT's when the store has no
 * MANIFEST). MANIFEST files are copied LAST, so a copy torn by a
 * failure never satisfies that check. The path is logged once. Never
 * throws: any failure is logged and the caller continues.
 * @param {string} leveldbDir
 * @param {{ logError: (kind: string, error: unknown) => void, now?: () => Date }} options
 * @returns {string | null} the preserved copy, or null (skipped or failed)
 */
function preserveLegacyStore(leveldbDir, { logError, now = () => new Date() }) {
  try {
    const parent = path.dirname(leveldbDir);
    const prefix = `${path.basename(leveldbDir)}.preserved-`;
    const files = fsSync.readdirSync(leveldbDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== 'LOCK').map((entry) => entry.name);
    const manifests = files.filter((name) => name.startsWith('MANIFEST-'));
    const identity = (manifests.length ? manifests : ['CURRENT'])
      .map((name) => ({ name, size: fsSync.statSync(path.join(leveldbDir, name)).size }));
    for (const name of fsSync.readdirSync(parent)) {
      if (!name.startsWith(prefix)) continue;
      const earlier = path.join(parent, name);
      const same = identity.every((file) => {
        try { return fsSync.statSync(path.join(earlier, file.name)).size === file.size; } catch { return false; }
      });
      if (same) return null;
    }
    // Fable follow-up N2 (non-blocking at the 12b gate): bound the
    // preserved copies themselves. A store that keeps failing to
    // decode in new states would otherwise leave one copy per
    // launch forever; at 3 existing copies the bytes are already
    // kept, so skip and say so — once, through the same log.
    const existing = fsSync.readdirSync(parent).filter((name) => name.startsWith(prefix)).length;
    if (existing >= 3) {
      logError('renderer preference migration', new Error(`Legacy store preservation skipped: ${existing} preserved copies already exist beside ${leveldbDir}`));
      return null;
    }
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    let target = path.join(parent, `${prefix}${stamp}`);
    for (let counter = 2; fsSync.existsSync(target); counter += 1) target = path.join(parent, `${prefix}${stamp}-${counter}`);
    fsSync.mkdirSync(target);
    const ordered = [...files.filter((name) => !name.startsWith('MANIFEST-')), ...manifests];
    for (const name of ordered) fsSync.copyFileSync(path.join(leveldbDir, name), path.join(target, name), fsSync.constants.COPYFILE_EXCL);
    logError('renderer preference migration', new Error(`Unreadable legacy store preserved at ${target}`));
    return target;
  } catch (error) {
    logError('renderer preference migration', error);
    return null;
  }
}

/**
 * Round 12b (R12-4): the synchronous pre-ready read of the legacy
 * store. main.cjs calls it after the single-instance lock and the
 * legacy-store snapshot, before app.whenReady() and before anything
 * touches the default session. It never throws: it returns the
 * dictionary, or the caught error for the leg to fail with.
 * R12-7: on a decode failure it first preserves a copy of the store
 * (preserveLegacyStore, which never throws), still before whenReady.
 * @param {string} leveldbDir
 * @param {{ logError: (kind: string, error: unknown) => void, now?: () => Date }} options
 * @returns {{ values: Record<string, string> } | { error: unknown }}
 */
function readLegacyStoreBeforeReady(leveldbDir, { logError, now }) {
  try {
    return { values: readLegacyLocalStorage(leveldbDir) };
  } catch (error) {
    if (legacyStoreDecodeFailure(error)) preserveLegacyStore(leveldbDir, { logError, now });
    return { error };
  }
}

module.exports = { APP_URL, WORKER_CSP, PLUGIN_REALM_JCAD_SHIM, PLUGIN_REALM_SNAPSHOT_MAX_BYTES, assetPath, assetResponseHeaders, buildPluginRealmSnapshot, createPluginRealmRegistry, installAssetHandler, legacyStorage, legacyStoreDecodeFailure, preserveLegacyStore, readLegacyStoreBeforeReady, rendererStartUrl, servedPath, withAssetHeaders };