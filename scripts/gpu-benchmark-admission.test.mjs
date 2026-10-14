import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { observeActualGpuAdmission } from './gpu-benchmark-admission.mjs';

// Inert scheduling tests, not native GPU or Canvas correctness evidence. Execute
// the serialized page function in a fresh browser-like realm, without imports.
/** @param {{frame?:Record<string, unknown>, own?:boolean}} [options] */
function fixture({ frame: initial = { rendered: false, cacheReason: 'admission-deferred', reason: 'budget policy' }, own = false } = {}) {
  let clock = 0, nextTimer = 0, frame = initial, renderFailure = null, fenceFailure = null, fence = null;
  const timers = new Map(), calls = [], result = {}, sentinel = {}, counts = { reads: 0, fences: 0, renderRequests: 0, modeChanges: 0, resets: 0 };
  const originalRender = /** @this {unknown} */ function (...args) { calls.push({ receiver: this, args }); if (renderFailure) throw renderFailure; return sentinel; };
  const prototype = { render: originalRender };
  const viewport = Object.assign(Object.create(prototype), { center: { x: 3, y: -4 }, scale: 5, twist: 0, width: 1216, height: 552, dpr: 1,
    settings: { background: '#212830', gridVisible: false, selectionEffect: 'solid' }, lastOverlay: { selection: new Set(), hover: null, preview: [], ghost: [] },
    layoutPainter: null, underlay: null, fitRect: null, experimentalSceneRenderer() {} });
  if (own) Object.defineProperty(viewport, 'render', { value: originalRender, writable: true, configurable: true, enumerable: true });
  const originalDescriptor = Object.getOwnPropertyDescriptor(viewport, 'render');
  const doc = { snapshot: { entities: [{ id: 'L', a: { x: 0, y: 0 }, b: { x: 2, y: 0 } }] }, dirty: true, history: () => ({ undo: 1, redo: 0 }) };
  const editor = { doc, viewport, selection: new Set() };
  const canvas = { width: 1216, height: 552, getContext: () => ({ getImageData() { counts.reads++; clock += 2; return result; } }) };
  const api = { status: () => ({ mode: 'gpu' }), renderStats: () => frame,
    async completed() { counts.fences++; if (fenceFailure) throw fenceFailure; if (fence) return await fence; clock += 3; return 3; },
    renderNow() { counts.renderRequests++; throw new Error('Observer must not request rendering'); },
    setMode() { counts.modeChanges++; throw new Error('Observer must not change mode'); },
    reset2DRenderer() { counts.resets++; throw new Error('Observer must not reset resources'); } };
  const context = { window: { editor, gpuPrototype: api }, document: { getElementById: id => id === 'drawing' ? canvas : null }, performance: { now: () => clock },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, at: clock + delay }); return id; },
    clearTimeout(id) { timers.delete(id); } };
  const expected = { document: JSON.stringify(doc.snapshot), camera: { center: { ...viewport.center }, scale: viewport.scale, twist: viewport.twist, width: viewport.width, height: viewport.height, dpr: viewport.dpr } };
  const observe = () => runInNewContext(`(${observeActualGpuAdmission.toString()})(expected)`, { ...context, expected });
  const advance = ms => { clock += ms; for (const [id, job] of [...timers]) if (job.at <= clock) { timers.delete(id); job.callback(); } };
  const clean = () => {
    assert.equal(viewport.render, originalRender); assert.deepEqual(Object.getOwnPropertyDescriptor(viewport, 'render'), originalDescriptor);
    assert.equal(Object.getPrototypeOf(viewport), prototype); assert.equal(timers.size, 0);
    for (const key of ['renderRequests', 'modeChanges', 'resets']) assert.equal(counts[key], 0);
  };
  return { observe, advance, clean, context, viewport, doc, canvas, api, expected, counts, calls, timers, sentinel,
    setFrame(value) { frame = value; }, renderError(value) { renderFailure = value; }, completionError(value) { fenceFailure = value; }, completionPromise(value) { fence = value; } };
}
const actualCanvas = { rendered: false, cacheReason: 'document', reason: 'Stroke geometry exceeds prototype budget', geometryPreparationMs: 71, uploadKind: 'none', bytes: 0, uploadCalls: 0 };
const actualGpu = { rendered: true, cacheReason: 'document-delta', geometryPreparationMs: 0.4, uploadKind: 'subrange', bytes: 168, uploadCalls: 1 };

test('waits through deferred policy and observes the owner automatic actual Canvas admission', async () => {
  const f = fixture(); const pending = f.observe();
  let done = false; pending.then(() => { done = true; }); await Promise.resolve(); assert.equal(done, false);
  f.context.setTimeout(() => { f.setFrame(actualCanvas); f.viewport.render(f.viewport.lastOverlay); }, 100);
  f.advance(99); await Promise.resolve(); assert.equal(done, false);
  f.advance(1); const proof = await pending;
  assert.equal(proof.frame.cacheReason, 'document'); assert.equal(proof.frame.geometryPreparationMs, 71);
  assert.equal(proof.initialFrame.cacheReason, 'admission-deferred'); assert.equal(proof.waitMs, 100); assert.equal(proof.observedFrames, 2);
  assert.equal(proof.settledBeforeObservation, false); assert.equal(proof.completedFrameWallMs, 102); assert.equal(proof.completionWaitMs, 2);
  assert.equal(f.counts.reads, 1); assert.equal(f.counts.fences, 0); f.clean();
});

test('consumes already settled GPU admission without another viewport frame', async () => {
  const f = fixture({ frame: actualGpu }); const proof = await f.observe();
  assert.equal(proof.frame.cacheReason, 'document-delta'); assert.equal(proof.settledBeforeObservation, true);
  assert.equal(proof.waitMs, 0); assert.equal(proof.observedFrames, 1); assert.equal(proof.reportedCompletionMs, 3);
  assert.equal(f.calls.length, 0); assert.equal(f.counts.fences, 1); assert.equal(f.counts.reads, 0); f.clean();
});

test('does not count another deferred frame as actual source admission', async () => {
  const f = fixture(); const pending = f.observe();
  assert.equal(f.viewport.render('automatic-deferred'), f.sentinel);
  f.advance(120); f.setFrame(actualCanvas); f.viewport.render('automatic-actual');
  const proof = await pending; assert.equal(proof.observedFrames, 3); assert.equal(proof.waitMs, 120); f.clean();
});

/** @type {Array<[string, (f:ReturnType<typeof fixture>) => void, RegExp]>} */
const mutationCases = [
  ['changed JSON', f => { f.doc.snapshot.entities[0].b.x = 4; }, /Drawing changed/],
  ['same-JSON replacement snapshot', f => { f.doc.snapshot = structuredClone(f.doc.snapshot); }, /Drawing changed/],
  ['camera', f => { f.viewport.center.x += 1; }, /Camera or viewport changed/],
  ['DPR', f => { f.viewport.dpr = 2; }, /Camera or viewport changed/],
  ['background', f => { f.viewport.settings.background = '#ffffff'; }, /Geometry display/],
  ['selection', f => { f.context.window.editor.selection.add('L'); }, /Geometry display/],
  ['overlay', f => { f.viewport.lastOverlay.preview = [{ id: 'preview' }]; }, /Geometry display/],
  ['backing dimensions', f => { f.canvas.width += 1; }, /Geometry display/],
  ['dirty state', f => { f.doc.dirty = false; }, /Geometry display/],
  ['history', f => { f.doc.history = () => ({ undo: 2, redo: 0 }); }, /Geometry display/],
];
for (const [label, mutate, error] of mutationCases) test(`rejects ${label} change while awaiting source admission and restores the hook`, async () => {
  const f = fixture({ own: true }); const pending = f.observe(); mutate(f); f.setFrame(actualCanvas);
  assert.equal(f.viewport.render('automatic'), f.sentinel); await assert.rejects(pending, error); f.clean();
});

test('times out exactly at the original ten-second frame bound and restores inherited method', async () => {
  const f = fixture(); const pending = f.observe(); const rejected = assert.rejects(pending, /within 10 seconds/);
  f.advance(9999); assert.equal(f.timers.size, 1); f.advance(1); await rejected; assert.equal(f.counts.reads, 0); f.clean();
});

test('preserves render receiver, arguments, result and original own property descriptor', async () => {
  const f = fixture({ own: true }); const pending = f.observe(); const receiver = {}, first = {}, second = {};
  f.setFrame(actualCanvas); assert.equal(f.viewport.render.call(receiver, first, second), f.sentinel);
  await pending; assert.equal(f.calls[0].receiver, receiver); assert.equal(f.calls[0].args[0], first); assert.equal(f.calls[0].args[1], second); f.clean();
});

test('keeps the original renderer exception authoritative and cleans timer/hook', async () => {
  const f = fixture({ own: true }); const pending = f.observe(); const failure = new Error('Native renderer threw'); f.renderError(failure);
  assert.throws(() => f.viewport.render('owned-overlay'), error => error === failure);
  await assert.rejects(pending, error => error === failure); f.clean();
});

test('rejects an invalid or failed real GPU completion', async () => {
  const f = fixture({ frame: actualGpu }); const failure = new Error('Fence unavailable'); f.completionError(failure);
  await assert.rejects(f.observe(), error => error === failure); f.clean();
});

test('rechecks the complete drawing after GPU completion rather than only before fence wait', async () => {
  const f = fixture({ frame: actualGpu }); /** @type {{complete?: (value:unknown) => void}} */ const completion = {};
  f.completionPromise(new Promise(resolve => { completion.complete = resolve; })); const pending = f.observe();
  f.doc.snapshot.entities[0].b.x = 8; assert.ok(completion.complete, 'GPU completion resolver must be installed'); completion.complete(1); await assert.rejects(pending, /Drawing changed/); f.clean();
});

test('rejects initial mismatched drawing/camera without installing a hook', async () => {
  const f = fixture(); f.expected.camera.scale = 999; await assert.rejects(f.observe(), /Camera or viewport changed/); f.clean();
});
for (const completion of [null, undefined, NaN, Infinity, -1]) test(`rejects invalid completed-GPU timing ${String(completion)}`, async () => {
  const f = fixture({ frame: actualGpu }); f.completionPromise(Promise.resolve(completion));
  await assert.rejects(f.observe(), /completion was not observed/); f.clean();
});

test('does not accept invalid frame telemetry as completed admission', async () => {
  const f = fixture({ frame: { rendered: false, reason: 'Unknown: no current frame' } });
  await assert.rejects(f.observe(), /frame telemetry is unavailable/); f.clean();
});

test('refuses a non-configurable renderer without changing the original descriptor', async () => {
  const f = fixture({ own: true }); Object.defineProperty(f.viewport, 'render', { configurable: false });
  const before = Object.getOwnPropertyDescriptor(f.viewport, 'render');
  await assert.rejects(f.observe(), /redefine property/); assert.deepEqual(Object.getOwnPropertyDescriptor(f.viewport, 'render'), before); assert.equal(f.timers.size, 0);
});