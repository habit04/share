import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { validateNativeHatches } from './gpu-hatch-validation.mjs';

// Mock-only exception/evidence contract tests for the actual exported wrapper.
// No page callback, renderer, native CAD codec or Electron process is executed.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceSha = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim();

/** @param {{primary:unknown,captureFailure?:unknown,diagnosticsFailure?:unknown,cleanupFailure?:unknown}} options */
function fixture(options) {
  const callerSnapshot = { entities: [{ id: 'caller', type: 'line' }] };
  const saved = { snapshot: callerSnapshot, document: JSON.stringify(callerSnapshot), path: 'caller.dxf', dirty: false,
    history: { undo: [], redo: [] }, selection: [], hover: null, color: 'ByLayer',
    camera: { center: { x: 3, y: -4 }, scale: 25, twist: 0, width: 1280, height: 720, dpr: 1 }, settings: { gridVisible: false },
    mode: 'gpu', fixture: 'compound-ordered', suggestedName: null };
  const failureState = { document: JSON.stringify({ entities: [{ id: 'failed-hatch', type: 'hatch' }] }),
    camera: { center: { x: 123, y: -77 }, scale: 400, twist: 0.43, width: 1280, height: 720, dpr: 2 },
    dirty: true, path: 'failed-probe.dxf', selection: ['failed-hatch'], hover: null };
  const diagnostics = { status: { device: 'lost', mode: 'gpu' }, frame: { rendered: false, reason: 'failed probe marker' } };
  const cleanup = { outcome: 'passed', documentRestored: true, historyRestored: true, cameraRestored: true, savingStateRestored: true, rendererResourcesReset: false };
  const calls = [];
  /** @type {Array<{kind:string,value?:unknown,fails?:boolean,error?:unknown}>} */
  const steps = [
    { kind: 'caller', value: saved },
    { kind: 'failed-state', value: failureState, fails: Object.hasOwn(options, 'captureFailure'), error: options.captureFailure },
  ];
  if (!Object.hasOwn(options, 'captureFailure')) steps.push({ kind: 'failed-diagnostics', value: diagnostics, fails: Object.hasOwn(options, 'diagnosticsFailure'), error: options.diagnosticsFailure });
  steps.push({ kind: 'cleanup', value: cleanup, fails: Object.hasOwn(options, 'cleanupFailure'), error: options.cleanupFailure });
  const page = { async evaluate(_callback, arg) {
    const next = steps.shift(); assert.ok(next, 'No unexpected page evaluation'); calls.push(next.kind);
    if (next.kind === 'cleanup') assert.equal(arg, saved, 'Cleanup receives the original caller snapshot, not failed probe state');
    if (next.fails) throw next.error;
    return next.value;
  } };
  let appCalls = 0;
  const out = resolve(root, '.codex-local', 'mock-hatch-cleanup'), profile = resolve(out, 'profile');
  const app = { async evaluate(_callback, expected) {
    appCalls++; calls.push('body-private-scope'); assert.equal(appCalls, 1); assert.deepEqual(expected, { root, out, profile });
    throw options.primary;
  } };
  // Synthetic precondition reaches the mocked privateScope. It does not claim
  // that the uncommitted test working tree is clean native benchmark evidence.
  const result = { sourceSha, worktreeModified: false, hardware: null, validation: [] };
  const run = () => validateNativeHatches({ page, app, root, out, profile, result,
    pairAtCurrent() { throw new Error('Body must stop at privateScope'); },
    prototypeContext() { throw new Error('No native context in mock-only test'); },
    missedForeground() { throw new Error('No raster in mock-only test'); } });
  return { run, result, saved, failureState, diagnostics, cleanup, calls, finished() { assert.equal(steps.length, 0); assert.equal(appCalls, 1); } };
}

/** Captures rejection without relying on Error truthiness or type. */
async function rejection(run) {
  let rejected = false, value;
  try { await run(); } catch (error) { rejected = true; value = error; }
  assert.equal(rejected, true, 'The failed body must reject even after successful cleanup');
  return value;
}

/** @param {ReturnType<typeof fixture>} value */
function assertFailed(value) {
  const evidence = /** @type {any} */ (value.result).hatchCoverage;
  assert.ok(evidence, 'Actual body initializes evidence before the deliberate scope failure');
  assert.equal(evidence.outcome, 'failed'); assert.equal(evidence.bodyOutcome, 'failed');
  assert.deepEqual(value.result.validation, [], 'Failed body must not publish a passed gate');
  value.finished();
  return evidence;
}

test('mock-only: original primary Error and failed pose survive successful caller cleanup', async () => {
  const primary = new Error('primary probe failure'); const f = fixture({ primary });
  assert.equal(await rejection(f.run), primary);
  const evidence = assertFailed(f);
  assert.deepEqual(evidence.failure, { probe: 'initialization', state: f.failureState, diagnostics: f.diagnostics });
  assert.notDeepEqual(evidence.failure.state.camera, f.saved.camera);
  assert.equal(evidence.cleanup, f.cleanup);
  assert.deepEqual(f.calls, ['caller', 'body-private-scope', 'failed-state', 'failed-diagnostics', 'cleanup']);
});

test('mock-only: secondary cleanup Error is recorded without replacing the primary Error or failed pose', async () => {
  const primary = new Error('primary probe failure'), secondary = new TypeError('caller restoration failure');
  const f = fixture({ primary, cleanupFailure: secondary });
  assert.equal(await rejection(f.run), primary);
  const evidence = assertFailed(f);
  assert.equal(evidence.failure.state, f.failureState); assert.equal(evidence.failure.diagnostics, f.diagnostics);
  assert.deepEqual(evidence.cleanup, { outcome: 'failed', name: secondary.name, message: secondary.message });
  assert.deepEqual(f.calls, ['caller', 'body-private-scope', 'failed-state', 'failed-diagnostics', 'cleanup']);
});

test('mock-only: failure-state capture and cleanup faults remain secondary to the original Error', async () => {
  const primary = new Error('primary probe failure'), capture = new Error('page unavailable during failure capture'), cleanup = new Error('cleanup unavailable');
  const f = fixture({ primary, captureFailure: capture, cleanupFailure: cleanup });
  assert.equal(await rejection(f.run), primary);
  const evidence = assertFailed(f);
  assert.deepEqual(evidence.failureCapture, { outcome: 'failed', name: capture.name, message: capture.message });
  assert.deepEqual(evidence.cleanup, { outcome: 'failed', name: cleanup.name, message: cleanup.message });
  assert.deepEqual(f.calls, ['caller', 'body-private-scope', 'failed-state', 'cleanup']);
});

test('mock-only: diagnostic capture fault still runs cleanup and retains the primary Error', async () => {
  const primary = new Error('primary probe failure'), capture = new Error('diagnostics unavailable');
  const f = fixture({ primary, diagnosticsFailure: capture });
  assert.equal(await rejection(f.run), primary);
  const evidence = assertFailed(f);
  assert.deepEqual(evidence.failureCapture, { outcome: 'failed', name: capture.name, message: capture.message });
  assert.equal(evidence.cleanup, f.cleanup);
  assert.deepEqual(f.calls, ['caller', 'body-private-scope', 'failed-state', 'failed-diagnostics', 'cleanup']);
});

for (const [label, primary] of [['undefined', undefined], ['null', null], ['false', false], ['zero', 0], ['negative zero', -0], ['empty string', ''], ['NaN', NaN]]) {
  test(`mock-only: falsy primary ${label} survives capture and cleanup errors by identity`, async () => {
    const capture = new Error('secondary capture fault'), cleanup = new Error('secondary cleanup fault');
    const f = fixture({ primary, captureFailure: capture, cleanupFailure: cleanup });
    assert.equal(await rejection(f.run), primary);
    const evidence = assertFailed(f);
    assert.deepEqual(evidence.failureCapture, { outcome: 'failed', name: capture.name, message: capture.message });
    assert.deepEqual(evidence.cleanup, { outcome: 'failed', name: cleanup.name, message: cleanup.message });
    assert.deepEqual(f.calls, ['caller', 'body-private-scope', 'failed-state', 'cleanup']);
  });
}

/** @type {Array<[string, unknown, string]>} */
const secondaryValues = [['null', null, 'Thrown object'], ['undefined', undefined, 'Thrown undefined'], ['zero', 0, 'Thrown number']];
for (const [label, secondary, message] of secondaryValues) {
  test(`mock-only: secondary ${label} capture and cleanup faults never replace the original Error`, async () => {
    const primary = new Error('original primary');
    const f = fixture({ primary, captureFailure: secondary, cleanupFailure: secondary });
    assert.equal(await rejection(f.run), primary);
    const evidence = assertFailed(f);
    assert.deepEqual(evidence.failureCapture, { outcome: 'failed', name: 'NonErrorThrow', message });
    assert.deepEqual(evidence.cleanup, { outcome: 'failed', name: 'NonErrorThrow', message });
    assert.deepEqual(f.calls, ['caller', 'body-private-scope', 'failed-state', 'cleanup']);
  });
}

test('mock-only: falsy primary survives null diagnostic and cleanup faults', async () => {
  const f = fixture({ primary: false, diagnosticsFailure: null, cleanupFailure: null });
  assert.equal(await rejection(f.run), false);
  const evidence = assertFailed(f);
  assert.deepEqual(evidence.failureCapture, { outcome: 'failed', name: 'NonErrorThrow', message: 'Thrown object' });
  assert.deepEqual(evidence.cleanup, { outcome: 'failed', name: 'NonErrorThrow', message: 'Thrown object' });
  assert.deepEqual(f.calls, ['caller', 'body-private-scope', 'failed-state', 'failed-diagnostics', 'cleanup']);
});

test('mock-only: numeric primary survives boolean capture and empty-string cleanup faults', async () => {
  const f = fixture({ primary: 0, captureFailure: false, cleanupFailure: '' });
  assert.equal(await rejection(f.run), 0);
  const evidence = assertFailed(f);
  assert.deepEqual(evidence.failureCapture, { outcome: 'failed', name: 'NonErrorThrow', message: 'Thrown boolean' });
  assert.deepEqual(evidence.cleanup, { outcome: 'failed', name: 'NonErrorThrow', message: '' });
  assert.deepEqual(f.calls, ['caller', 'body-private-scope', 'failed-state', 'cleanup']);
});

test('mock-only: arbitrary secondary objects are not inspected or coerced during evidence recording', async () => {
  let propertyReads = 0, coercions = 0;
  const secondary = {
    get name() { propertyReads++; throw new Error('Diagnostic name getter must not run'); },
    get message() { propertyReads++; throw new Error('Diagnostic message getter must not run'); },
    [Symbol.toPrimitive]() { coercions++; throw new Error('Diagnostic coercion must not run'); },
  };
  const primary = new Error('original primary'); const f = fixture({ primary, captureFailure: secondary, cleanupFailure: secondary });
  assert.equal(await rejection(f.run), primary);
  const evidence = assertFailed(f);
  assert.equal(propertyReads, 0); assert.equal(coercions, 0);
  assert.deepEqual(evidence.failureCapture, { outcome: 'failed', name: 'NonErrorThrow', message: 'Thrown object' });
  assert.deepEqual(evidence.cleanup, { outcome: 'failed', name: 'NonErrorThrow', message: 'Thrown object' });
  assert.deepEqual(f.calls, ['caller', 'body-private-scope', 'failed-state', 'cleanup']);
});
