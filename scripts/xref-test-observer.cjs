'use strict';
/**
 * TEST-ONLY broker observer for the P20.2 native xref refresh gate.
 * Implemented under the lead's G2 ruling (17 October 2026) for REVIEW;
 * no execution of this hook is admitted until the implemented source and
 * a specific native execution are separately accepted.
 *
 * Launch route (source-supported, Electron v44.7.2 default_app): the
 * reviewed runner starts the NORMAL application with this file preloaded
 * by the Electron CLI, before the repository-root application argument:
 *
 *   electron --require <absolute path to this file> <repository root>
 *
 * default_app parses --require before the first application positional,
 * preloads this module, then loads the normal application package with
 * its pinned package main. This file never becomes the app entry, never
 * rewrites package.json, never calls app.setAppPath.
 *
 * Fail-closed opt-in: the reviewed runner supplies exactly
 * JCAD_XREF_TEST_OBSERVER=1 and JCAD_XREF_OBSERVER_TARGET_SHA256=<sha256
 * of electron/xref-read.cjs from the delivery manifest>. Missing or wrong
 * values abort startup. This is a test launch guard, not an authority.
 *
 * Canonical identity: there is exactly ONE pinned identity for the
 * target, computed once below as require.resolve() of the lexical path -
 * i.e. the string the CommonJS loader itself produces via
 * Module._resolveFilename (including its realpath step), which is the
 * very string the loader uses as the require.cache key and as
 * module.filename. That one string is used for the startup hash (the
 * file bytes are read through it), the startup cache scan, the
 * interception comparison, and the facade metadata. (The previous
 * revision pinned the lexical path.join spelling on the startup side
 * while the loader resolved a different spelling, so the two could
 * silently disagree - e.g. through a symlinked app directory.)
 *
 * Cache scan / alias handling: before any interception is installed,
 * every require.cache key is compared against the target by canonical
 * (realpath) form. If the target is already cached - under the canonical
 * spelling OR under any alias spelling - NO interception is installed
 * (nothing is left dangling), the facade is still exposed, and coverage
 * is invalidated from the start: samples report captured:false with the
 * invalidated reason, the app runs unobserved, and the harness BLOCKs
 * every stats-derived criterion. Configuration errors that precede the
 * scan (missing/wrong opt-in, missing/malformed/mismatched target hash)
 * still abort startup exactly as before.
 *
 * Finite boundary: the global Module._load hook is restored the moment
 * the target loads (existing behaviour, success or failure). If the
 * target has NOT loaded within OBSERVER_LOAD_BOUNDARY_MS, the boundary
 * fires: it restores the global loader (only if it is still this
 * file's wrapper) and invalidates coverage with reason
 * 'target-not-loaded-within-boundary'. The boundary timer is armed at
 * THIS MODULE's load, unconditionally - it does not wait for, or
 * depend on, the Electron app's 'ready' event, so a startup that
 * stalls before ready (or never reaches it) is still bounded. (An
 * earlier revision armed the timer only from 'ready' when an Electron
 * app existed, which left a pre-ready stall with no timer at all.)
 * The timer is unref'd and is cleared the moment interception
 * installs. The boundary can only ever invalidate - it can never make
 * any criterion pass.
 *
 * Capture: the interception resolves every request exactly as the
 * original loader does and touches ONLY the one canonical target. The
 * factory passthrough calls the original exactly once per actual call
 * with identical arguments/deps identity, captures the FIRST broker it
 * returns, and returns the SAME object to the caller. The narrow factory
 * wrapper (and its counter) stays installed for the declared observed
 * lifetime (the harness run): a later factory call still invokes the
 * original normally - product behaviour is unchanged - but invalidates
 * the one-instance claim. Restoring the wrapped export in-process would
 * require exposing a mutation surface the ruling forbids; the declared
 * shutdown boundary is the owned app process's exit (the runner owns and
 * joins that process).
 *
 * Facade: globalThis.__xrefTestObserver exposes ONLY a frozen sample()
 * function and frozen scalar metadata. No broker reference, token,
 * registry, grant, read, cancel or dispose capability leaves this file.
 * Samples are fresh frozen copies: { seq, atMs (main-process monotonic
 * clock), captured, factoryCalls, invalidated, stats } where stats is
 * the broker's raw aggregate (contexts, tickets, activeOps,
 * retiredActiveOps, reservedRawBytes, disposed) - no per-owner view is
 * computed or claimed.
 */

const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

/** Declared finite boundary for the target module to load (see header). */
const OBSERVER_LOAD_BOUNDARY_MS = 30_000;

if (process.env.JCAD_XREF_TEST_OBSERVER !== '1') {
  throw new Error('xref-test-observer: refusing to start without JCAD_XREF_TEST_OBSERVER=1 (reviewed runner opt-in)');
}
const expectedTargetSha = process.env.JCAD_XREF_OBSERVER_TARGET_SHA256;
if (typeof expectedTargetSha !== 'string' || !/^[0-9a-f]{64}$/.test(expectedTargetSha)) {
  throw new Error('xref-test-observer: JCAD_XREF_OBSERVER_TARGET_SHA256 must name the pinned target hash');
}

const repoRoot = path.resolve(__dirname, '..');
const lexicalTargetPath = path.join(repoRoot, 'electron', 'xref-read.cjs');
// The ONE canonical pinned identity (see header): the loader's own
// resolution of the target, used for every check and comparison below.
// Throws (fail-closed startup) if the target file does not exist.
const targetPath = require.resolve(lexicalTargetPath);
const targetSha256 = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
if (targetSha256 !== expectedTargetSha) {
  throw new Error(`xref-test-observer: target identity mismatch for ${targetPath}`);
}

let factoryCalls = 0;
/** @type {null | object} */
let captured = null;
/** @type {null | string} */
let invalidated = null;
let seq = 0;

// Startup cache scan (see header): canonical-form comparison of every
// cached key against the target. Any hit - canonical spelling or alias -
// means the target was loaded before this observer could intercept, so
// coverage is invalid from the start and NO hook is installed below.
{
  /** @param {string} p @returns {string} */
  const canonicalForm = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };
  const targetCanonical = canonicalForm(targetPath);
  const hits = Object.keys(require.cache).filter((key) => canonicalForm(key) === targetCanonical);
  if (hits.length > 0) {
    invalidated = hits.some((key) => key !== targetPath)
      ? 'target-already-cached-alias'
      : 'target-already-cached';
  }
}

const originalLoad = Module._load;

/**
 * Resolve a load request exactly as the original loader would, without
 * loading it. Returns the absolute filename or null when unresolvable.
 * The returned string is the loader's canonical form (see header), so it
 * compares directly against the pinned targetPath.
 * @param {unknown} request @param {unknown} parent
 * @returns {string | null}
 */
function resolveRequest(request, parent) {
  try {
    return Module._resolveFilename(/** @type {string} */ (request), /** @type {object} */ (parent), false, undefined);
  } catch {
    return null;
  }
}

/**
 * @param {object} brokerModule the genuinely loaded xref-read module
 */
function installFactoryWrapper(brokerModule) {
  const originalFactory = /** @type {any} */ (brokerModule).createXrefReadBroker;
  if (typeof originalFactory !== 'function') {
    throw new Error('xref-test-observer: target module has no createXrefReadBroker export');
  }
  /** @type {any} */ (brokerModule).createXrefReadBroker = function (...args) {
    factoryCalls += 1;
    const broker = originalFactory.apply(this, args);
    if (captured === null) captured = broker;
    else if (invalidated === null) invalidated = 'second-broker-instance';
    return broker;
  };
}

// ------------------------------------------------------------ finite boundary
let interceptionInstalled = false;
/** @type {null | object} */
let boundaryTimer = null;

function clearBoundary() {
  if (boundaryTimer !== null) {
    clearTimeout(/** @type {any} */ (boundaryTimer));
    boundaryTimer = null;
  }
}

function expireBoundary() {
  boundaryTimer = null;
  if (interceptionInstalled) return;
  // Restore the global loader only if it is still THIS file's wrapper -
  // never clobber a hook anyone else installed after us.
  if (Module._load === interceptionLoad) Module._load = originalLoad;
  if (invalidated === null) invalidated = 'target-not-loaded-within-boundary';
}

function armBoundary() {
  if (boundaryTimer !== null || interceptionInstalled) return;
  boundaryTimer = setTimeout(expireBoundary, OBSERVER_LOAD_BOUNDARY_MS);
  if (typeof (/** @type {any} */ (boundaryTimer).unref) === 'function') (/** @type {any} */ (boundaryTimer)).unref();
}

// ------------------------------------------------------------ interception
/**
 * The finite Module._load interception. Installed only when the startup
 * cache scan found the target unloaded; restored the moment the target
 * loads, or by the boundary above if it never does.
 * @param {string} request @param {object} parent @param {boolean} isMain
 * @returns {unknown}
 */
function interceptionLoad(request, parent, isMain) {
  const resolved = resolveRequest(request, parent);
  if (resolved !== targetPath) {
    return originalLoad.call(this, request, parent, isMain);
  }
  try {
    const brokerModule = originalLoad.call(this, request, parent, isMain);
    installFactoryWrapper(brokerModule);
    interceptionInstalled = true;
    clearBoundary();
    return brokerModule;
  } catch (error) {
    // The original error propagates unchanged (identity preserved); the
    // interception is finished either way and coverage is invalid.
    if (invalidated === null) invalidated = 'target-load-failed';
    throw error;
  } finally {
    // Finite interception: the broad loader hook never persists past the
    // target's installation, including on failure.
    Module._load = originalLoad;
  }
}

if (invalidated === null) {
  Module._load = interceptionLoad;
  // Arm the finite boundary NOW, at module load, in all cases -
  // independent of Electron readiness (see header). A startup that
  // stalls before 'ready' is bounded by the same timer. If arming
  // itself fails, leave no hook behind: restore the original loader
  // (only if it is still this file's wrapper) and invalidate coverage.
  try {
    armBoundary();
  } catch {
    if (Module._load === interceptionLoad) Module._load = originalLoad;
    invalidated = 'observer-install-failed';
  }
}

/**
 * One frozen stats sample. The raw broker never leaves this closure.
 * @returns {Readonly<object>}
 */
function sample() {
  seq += 1;
  const base = { seq, atMs: performance.now(), factoryCalls, invalidated };
  if (captured === null) return Object.freeze({ ...base, captured: false, stats: null });
  const raw = /** @type {any} */ (captured).stats();
  const stats = Object.freeze({
    contexts: raw.contexts, tickets: raw.tickets, activeOps: raw.activeOps,
    retiredActiveOps: raw.retiredActiveOps, reservedRawBytes: raw.reservedRawBytes, disposed: raw.disposed,
  });
  return Object.freeze({ ...base, captured: true, stats });
}

const facade = Object.freeze({
  sample,
  meta: Object.freeze({
    targetPath,
    targetSha256,
    optIn: 'JCAD_XREF_TEST_OBSERVER=1',
    observer: 'xref-test-observer',
    boundaryMs: OBSERVER_LOAD_BOUNDARY_MS,
  }),
});
globalThis.__xrefTestObserver = facade;
