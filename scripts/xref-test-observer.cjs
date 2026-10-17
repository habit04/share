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
 * Capture: a finite Module._load interception resolves every request
 * exactly as the original loader does and touches ONLY the one canonical
 * target (electron/xref-read.cjs, hash-pinned, not already cached). The
 * moment the target module is loaded, its createXrefReadBroker export is
 * wrapped and the global Module._load is restored (including on failure),
 * so no broad loader hook persists. The factory passthrough calls the
 * original exactly once per actual call with identical arguments/deps
 * identity, captures the FIRST broker it returns, and returns the SAME
 * object to the caller. The narrow factory wrapper (and its counter)
 * stays installed for the declared observed lifetime (the harness run):
 * a later factory call still invokes the original normally - product
 * behaviour is unchanged - but invalidates the one-instance claim.
 * Restoring the wrapped export in-process would require exposing a
 * mutation surface the ruling forbids; the declared shutdown boundary is
 * the owned app process's exit (the runner owns and joins that process).
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

if (process.env.JCAD_XREF_TEST_OBSERVER !== '1') {
  throw new Error('xref-test-observer: refusing to start without JCAD_XREF_TEST_OBSERVER=1 (reviewed runner opt-in)');
}
const expectedTargetSha = process.env.JCAD_XREF_OBSERVER_TARGET_SHA256;
if (typeof expectedTargetSha !== 'string' || !/^[0-9a-f]{64}$/.test(expectedTargetSha)) {
  throw new Error('xref-test-observer: JCAD_XREF_OBSERVER_TARGET_SHA256 must name the pinned target hash');
}

const repoRoot = path.resolve(__dirname, '..');
const targetPath = path.join(repoRoot, 'electron', 'xref-read.cjs');
const targetSha256 = crypto.createHash('sha256').update(fs.readFileSync(targetPath)).digest('hex');
if (targetSha256 !== expectedTargetSha) {
  throw new Error(`xref-test-observer: target identity mismatch for ${targetPath}`);
}
if (require.cache[targetPath]) {
  throw new Error('xref-test-observer: target module is already cached before interception; coverage invalid');
}

let factoryCalls = 0;
/** @type {null | object} */
let captured = null;
/** @type {null | string} */
let invalidated = null;
let seq = 0;

const originalLoad = Module._load;

/**
 * Resolve a load request exactly as the original loader would, without
 * loading it. Returns the absolute filename or null when unresolvable.
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

Module._load = function (request, parent, isMain) {
  const resolved = resolveRequest(request, parent);
  if (resolved !== targetPath) {
    return originalLoad.call(this, request, parent, isMain);
  }
  try {
    const brokerModule = originalLoad.call(this, request, parent, isMain);
    installFactoryWrapper(brokerModule);
    return brokerModule;
  } finally {
    // Finite interception: the broad loader hook never persists past the
    // target's installation, including on failure.
    Module._load = originalLoad;
  }
};

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
  }),
});
globalThis.__xrefTestObserver = facade;
