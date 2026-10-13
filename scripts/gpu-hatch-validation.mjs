// Untimed native HATCH regression gates through existing editor and GPU development APIs.
// No app API additions. Existing Canvas and native codecs remain the references.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { chooseBenchmarkLineEdit } from './gpu-edit-candidate.mjs';
import { nativeHatchCases, commonIds, isolatedFallbacks, hatchInteriorProbes } from './gpu-hatch-cases.mjs';

const digest = (data) => createHash('sha256').update(data).digest('hex');
const failureDetails = (error) => error instanceof Error
  ? { name: error.name, message: error.message }
  : { name: 'NonErrorThrow', message: typeof error === 'string' ? error : `Thrown ${typeof error}` };
function assertNoGpuSubmission(frame, label) {
  assert.equal(frame.rendered, false, `${label}: complete Canvas`);
  assert.notEqual(frame.cacheReason, 'admission-deferred', `${label}: actual current-source refusal`);
  for (const key of ['bytes', 'uploadCalls', 'subrangeUploadBytes', 'subrangeUploadCalls', 'drawSubmissionMs', 'submissionMs']) assert.equal(frame[key], 0, `${label}: zero ${key}`);
  assert.equal(frame.uploadKind, 'none');
  assert.ok(typeof frame.reason === 'string' && frame.reason.trim(), `${label}: retain actual reason`);
}
function assertWarm(frame, label) {
  assert.equal(frame.rendered, true, `${label}: actual GPU`); assert.equal(frame.cacheHit, true, `${label}: certified warm reuse`);
  assert.equal(frame.uploadKind, 'none');
  for (const key of ['bytes', 'uploadCalls', 'subrangeUploadBytes', 'subrangeUploadCalls', 'geometryPreparationMs', 'partialPreparationMs']) assert.equal(frame[key], 0, `${label}: zero ${key}`);
}
function assertLineDelta(frame, action) {
  assert.equal(frame.rendered, true); assert.equal(frame.cacheReason, 'document-delta'); assert.equal(frame.uploadKind, 'subrange');
  assert.equal(frame.bytes, 168); assert.equal(frame.uploadCalls, 1); assert.equal(frame.subrangeUploadBytes, 168); assert.equal(frame.subrangeUploadCalls, 1);
  assert.equal(frame.geometryPreparationMs, frame.partialPreparationMs, 'Only the actual one-LINE partial preparation is reported'); assert.ok(frame.preparedEntities <= 1);
  if (action !== 'line-edit') { assert.equal(frame.editMemoHit, true); assert.equal(frame.preparedEntities, 0); assert.equal(frame.partialPreparationMs, 0); }
}
function assertHatchRebuild(frame) {
  assert.equal(frame.rendered, true); assert.equal(frame.cacheReason, 'document'); assert.equal(frame.uploadKind, 'full');
  assert.equal(frame.uploadCalls, 1); assert.ok(frame.bytes > 0);
  assert.equal(frame.subrangeUploadBytes, 0); assert.equal(frame.subrangeUploadCalls, 0); assert.equal(frame.editMemoHit, false);
}
async function capture(page) {
  return page.evaluate(() => {
    const ed = window.editor, v = ed.viewport;
    return { document: JSON.stringify(ed.doc.snapshot), entities: ed.doc.snapshot.entities, layers: ed.doc.snapshot.layers,
      camera: { center: { ...v.center }, scale: v.scale, twist: v.twist, width: v.width, height: v.height, dpr: v.dpr, drawingWidth: v.canvas.width, drawingHeight: v.canvas.height },
      history: ed.doc.history(), dirty: ed.doc.dirty, path: ed.doc.filePath, selection: [...ed.selection], hover: ed.overlay.hover ?? null, display: { settings: { ...v.settings }, selectionEffect: v.settings.selectionEffect, color: ed.doc.currentColor } };
  });
}
async function load(page, fixture) {
  await page.evaluate((fixture) => {
    const ed = window.editor, api = window.gpuPrototype, v = ed.viewport;
    api.setMode('canvas'); ed.selection.clear(); ed.setHover(null); v.settings.selectionEffect = 'solid';
    // Existing development input sets the SAME lineweight display used by Canvas and GPU.
    api.loadFixture('compound-ordered');
    ed.loadState({ entities: fixture.entities, layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }], blocks: {}, currentLayer: '0' }, null);
    v.center = fixture.center; v.scale = fixture.scale; v.twist = fixture.twist; v.settings.gridVisible = false;
    v.renderCurrent();
  }, fixture);
  const value = await capture(page);
  assert.deepEqual(value.entities, fixture.entities, `${fixture.name}: complete original authoring data reaches Drawing`);
  assert.deepEqual(value.camera.center, fixture.center); assert.equal(value.camera.scale, fixture.scale); assert.equal(value.camera.twist, fixture.twist);
  assert.equal(value.path, null); assert.equal(value.dirty, false);
  const sealed = await page.evaluate(() => window.editor.doc.snapshot.entities.every((entity) => Object.isFrozen(entity) && (entity.type !== 'hatch' || Object.isFrozen(entity.loops) && entity.loops.every((loop) => Object.isFrozen(loop.points) && loop.points.every(Object.isFrozen)))));
  assert.equal(sealed, true, 'Real Drawing source is frozen recursively; the core regression suite proves runtime certification separately');
  return value;
}
async function mutate(page, action, lineCandidate = null) {
  return page.evaluate(async ({ action, lineCandidate }) => {
    const ed = window.editor, api = window.gpuPrototype, v = ed.viewport;
    const before = ed.doc.snapshot;
    if (action === 'line-edit') ed.doc.replaceEntities([lineCandidate.edited]);
    else if (action === 'hatch-style-edit' || action === 'phase-boundary-edit') {
      const source = ed.doc.entities.find((entity) => entity.id === 'H-LINE');
      if (action === 'hatch-style-edit') ed.doc.replaceEntities([{ ...source, trueColor: 0x2244aa }]);
      else ed.doc.replaceEntities([{ ...source, origin: { x: 0, y: 0.375 }, loops: source.loops.map((loop, index) => index === 2 ? { ...loop, points: loop.points.map((point) => ({ x: point.x + 0.125, y: point.y })) } : loop) }]);
    } else if (action === 'undo' || action === 'redo') { if (!ed.doc[action]()) throw new Error(`${action}: no history step`); }
    else throw new Error(`Unknown hatch mutation ${action}`);
    if (ed.doc.snapshot === before) throw new Error(`${action}: no source change`);
    const frame = api.renderNow();
    let completionMs = null;
    if (frame.rendered) { completionMs = await api.completed(); if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error(`${action}: GPU completion missing`); }
    else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
    return { action, frame, completionMs, document: JSON.stringify(ed.doc.snapshot), camera: { center: { ...v.center }, scale: v.scale, twist: v.twist, width: v.width, height: v.height, dpr: v.dpr, drawingWidth: v.canvas.width, drawingHeight: v.canvas.height } };
  }, { action, lineCandidate });
}
async function restoredOwnerFrame(page) {
  return page.evaluate(async () => {
    const api = window.gpuPrototype, v = window.editor.viewport, original = v.render;
    const descriptor = Object.getOwnPropertyDescriptor(v, 'render');
    const frames = [];
    let resolveFrame, rejectFrame, timer;
    const observed = new Promise((resolve, reject) => { resolveFrame = resolve; rejectFrame = reject; });
    Object.defineProperty(v, 'render', { configurable: true, writable: true, value: /** @this {any} */ function (...args) {
      try { const value = Reflect.apply(original, this, args); const frame = api.renderStats(); frames.push(frame); if (frame.rendered) resolveFrame(frame); return value; }
      catch (error) { rejectFrame(error); throw error; }
    } });
    try {
      timer = setTimeout(() => rejectFrame(new Error('First automatic restored hatch frame missing within10seconds')), 10000);
      api.restoreContext();
      const frame = await observed, completionMs = await api.completed();
      if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('Restored hatch completion missing');
      return { frame, completionMs, automaticFrames: frames, ownerTriggered: true };
    } finally { clearTimeout(timer); if (descriptor) Object.defineProperty(v, 'render', descriptor); else delete v.render; }
  });
}
function changedPixels(a, b) {
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  let count = 0; for (let index = 0; index < a.data.length; index += 4) if ([0, 1, 2, 3].some((channel) => a.data[index + channel] !== b.data[index + channel])) count++;
  return count;
}
function families(source) {
  if (source.solid) return [];
  if (source.patternLines?.length) return source.patternLines;
  const angles = { LINE: [0], NET: [0, Math.PI / 2], ANSI31: [Math.PI / 4], ANSI37: [Math.PI / 4, 3 * Math.PI / 4] }[source.pattern];
  assert.ok(angles, `Authored supported pattern ${source.pattern}`);
  return angles.map((angle) => { const rotation = angle + source.angle, spacing = 0.125 * source.scale; return { angle: rotation, base: source.origin ?? { x: 0, y: 0 }, offset: { x: -Math.sin(rotation) * spacing, y: Math.cos(rotation) * spacing }, dashes: [] }; });
}
function assertFamilies(actual, expected, label) {
  assert.equal(actual.length, expected.length, `${label}: family count/order`);
  actual.forEach((a, index) => {
    const b = expected[index];
    assert.ok(Math.abs(Math.atan2(Math.sin(a.angle - b.angle), Math.cos(a.angle - b.angle))) <= 1e-12, `${label}: directed family angle`);
    for (const field of ['base', 'offset']) for (const axis of ['x', 'y']) assert.ok(Math.abs(a[field][axis] - b[field][axis]) <= 1e-10, `${label}: original ${field}.${axis}`);
    assert.equal(a.dashes.length, b.dashes.length); a.dashes.forEach((dash, position) => assert.ok(Math.abs(dash - b.dashes[position]) <= 1e-10));
  });
}
/** Selected independently useful frozen4027 parser: inspect actual saved HATCH records. */
function savedHatchRecords(text) {
  const lines = text.split(/\r?\n/), records = [];
  let section = '', record = null;
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const code = Number(lines[index].trim()), value = lines[index + 1].trim();
    if (code === 0 && value === 'SECTION') { section = lines[index + 3]?.trim(); continue; }
    if (code === 0 && value === 'ENDSEC') { section = ''; record = null; continue; }
    if (section !== 'ENTITIES') continue;
    if (code === 0) { record = value === 'HATCH' ? [] : null; if (record) records.push(record); }
    if (record) record.push({ code, value });
  }
  return records;
}
function savedFamilies(record) {
  const result = [];
  for (let index = 0; index < record.length; index++) {
    if (record[index].code !== 53) continue;
    const take = (code) => { const value = record[index++]; assert.equal(value.code, code); return Number(value.value); };
    const angle = take(53) * Math.PI / 180, base = { x: take(43), y: take(44) }, offset = { x: take(45), y: take(46) }, count = take(79), dashes = [];
    for (let dash = 0; dash < count; dash++) dashes.push(take(49));
    index--; result.push({ angle, base, offset, dashes });
  }
  return result;
}
/** Untimed correctness increment; existing timed benchmark and precision policies are unchanged.
 * @param {{page:any,app:any,root:string,out:string,profile:string,pairAtCurrent:any,prototypeContext:any,missedForeground:any,result:any}} options
 */
async function validateNativeHatchesBody({ page, app, root, out, profile, pairAtCurrent, prototypeContext, missedForeground, result }) {
  assert.equal(result.worktreeModified, false, 'Native evidence requires a frozen clean source commit');
  assert.equal(execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), result.sourceSha);
  const evidence = { outcome: 'started', sourceSha: result.sourceSha, hardware: result.hardware, cases: {}, comparisons: {}, interiors: [], edits: [], controls: [], contextRecovery: null, saveReopen: null,
    limits: ['Authored private DXF/native Canvas raster validation; no external CAD fixture or new codec claim.', 'Existing source/native Float32 certificates are exercised by actual GPU admission; no dimensionAudit or native painter-command API is claimed.', 'One observed adapter per run; physical AMD and other hardware remain separate. High-zoom control records actual hardware DPR; it does not replace the original separate synthetic DPR2 source test.'] };
  Object.assign(result, { hatchCoverage: evidence });
  const privateScope = await app.evaluate(({ app }, expected) => {
    const paths = process.getBuiltinModule('node:path');
    if (paths.resolve(app.getPath('userData')).toLowerCase() !== paths.resolve(expected.profile).toLowerCase()) throw new Error('Hatch private profile is not the benchmark owner');
    if (paths.resolve(app.getAppPath()).toLowerCase() !== paths.resolve(expected.root).toLowerCase()) throw new Error('Hatch app path is not the frozen worktree');
    const relative = paths.relative(paths.resolve(expected.root), paths.resolve(expected.out));
    if (!relative || relative.startsWith('..') || paths.isAbsolute(relative)) throw new Error('Hatch output is not inside its own worktree');
    return { appPath: app.getAppPath(), userData: app.getPath('userData'), output: paths.resolve(expected.out), verified: true };
  }, { root, out, profile });
  Object.assign(evidence, { privateScope });
  const pair = async (label, supported, warm = false) => {
    evidence.activeProbe = label;
    const before = await capture(page), value = await pairAtCurrent(label, supported, warm), after = await capture(page);
    assert.equal(after.document, before.document, `${label}: reference comparison keeps complete source`); assert.deepEqual(after.camera, before.camera); assert.deepEqual(after.history, before.history); assert.equal(after.dirty, before.dirty); assert.deepEqual(after.selection, before.selection); assert.equal(after.hover, before.hover); assert.deepEqual(after.display, before.display);
    assert.notEqual(value.evidence.gpuFrame.cacheReason, 'admission-deferred'); assert.equal(value.evidence.gpuFrame.rendered, supported);
    assert.ok(value.evidence.twoPixelCoverageMissFraction < 0.005);
    if (supported) { assert.ok(value.evidence.imageDifferenceFraction < 0.001); if (warm) assertWarm(value.evidence.gpuFrame, label); }
    else { assertNoGpuSubmission(value.evidence.gpuFrame, label); assert.equal(value.evidence.imageDifferenceFraction, 0); assert.equal(Buffer.compare(value.images[0].data, value.images[1].data), 0); }
    evidence.comparisons[label] = value.evidence;
    return value;
  };
  const cases = nativeHatchCases(), common = cases[0];
  const baseline = await load(page, common);
  assert.deepEqual(baseline.entities.filter((entity) => entity.type === 'hatch').map((entity) => entity.id), commonIds);
  evidence.cases[common.name] = { source: common.source, sourceHash: digest(JSON.stringify(common)), initial: baseline };
  const initialPair = await pair('hatch-common-zero-baseline', true); Object.assign(evidence, { initialAdmission: initialPair.evidence.gpuFrame });
  const native = await prototypeContext(page); assert.equal(native.state, 'ready'); assert.equal(native.rendered, true);
  Object.assign(evidence, { observedOwnedContext: native });

  // Fixed independent interior oracles do not derive positions/colors from GPU vertices.
  try {
    await page.evaluate(() => {
      const v = window.editor.viewport, before = v.toScreen({ x: -5, y: -0.75 });
      const target = { x: (Math.floor(before.x * v.dpr) + 0.5) / v.dpr, y: (Math.floor(before.y * v.dpr) + 0.5) / v.dpr };
      v.center = { x: v.center.x + (before.x - target.x) / v.scale, y: v.center.y + (target.y - before.y) / v.scale };
      window.editor.render();
    });
    const probePair = await pair('hatch-known-islands-phase-color-interiors', true);
    const positions = await page.evaluate((probes) => { const v = window.editor.viewport; return probes.map((probe) => ({ ...probe, screen: v.toScreen(probe.point), width: v.width, height: v.height, dpr: v.dpr })); }, hatchInteriorProbes);
    for (const probe of positions) {
      const colors = probePair.images.map((image) => {
        const x = Math.floor(probe.screen.x * image.width / probe.width), y = Math.floor(probe.screen.y * image.height / probe.height);
        assert.ok(x > 1 && y > 1 && x < image.width - 2 && y < image.height - 2, `${probe.label}: visible native interior`);
        return [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
      });
      for (const rgba of colors) { assert.equal(rgba[3], 255); probe.rgb.forEach((channel, index) => assert.ok(Math.abs(rgba[index] - channel) <= 2, `${probe.label}: independent actual Canvas/GPU color`)); }
      evidence.interiors.push({ ...probe, canvasRgba: colors[0], gpuRgba: colors[1], provenance: 'fixed authored original-phase/loop/dash/order oracle; actual hardware raster, no GPU mesh input' });
    }
  } finally { await page.evaluate((camera) => { const v = window.editor.viewport; v.center = camera.center; v.scale = camera.scale; v.twist = camera.twist; window.editor.render(); }, baseline.camera); }
  assert.equal((await capture(page)).document, baseline.document);

  const warm = await page.evaluate(async () => {
    const v = window.editor.viewport, api = window.gpuPrototype;
    v.zoomAt({ x: v.width / 2, y: v.height / 2 }, 1.05); v.panByPixels(18 / v.dpr, -12 / v.dpr);
    const frame = api.renderNow(), completionMs = await api.completed();
    if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('Hatch warm GPU completion missing');
    return { frame, completionMs };
  });
  assertWarm(warm.frame, 'hatch warm pan/zoom'); const warmState = await capture(page);
  const warmPair = await pair('hatch-warm-pan-zoom', true, true);
  const candidate = chooseBenchmarkLineEdit({ entities: warmState.entities, layers: warmState.layers }, warmState.camera, 'L');
  let editedLinePair;
  for (const action of ['line-edit', 'undo', 'redo', 'undo']) {
    const transition = await mutate(page, action, candidate); assertLineDelta(transition.frame, action); assert.deepEqual(transition.camera, warmState.camera);
    const currentPair = await pair(`hatch-companion-${action}-${evidence.edits.length}`, true, true);
    if (action === 'line-edit') { assert.ok(changedPixels(warmPair.images[0], currentPair.images[0]) > 0); assert.ok(changedPixels(warmPair.images[1], currentPair.images[1]) > 0); for (const index of [0, 1]) assert.ok(pixelmatch(warmPair.images[index].data, currentPair.images[index].data, null, warmPair.images[index].width, warmPair.images[index].height, { threshold: 0.15 }) > 0, 'The actual companion edit is visibly different before undo'); editedLinePair = currentPair; }
    else { const expected = action === 'redo' ? editedLinePair : warmPair; assert.equal(Buffer.compare(expected.images[0].data, currentPair.images[0].data), 0); assert.equal(Buffer.compare(expected.images[1].data, currentPair.images[1].data), 0); }
    evidence.edits.push({ kind: 'companion-line', candidate, ...transition, accuracy: currentPair.evidence });
  }
  assert.equal((await capture(page)).document, warmState.document);
  for (const kind of ['hatch-style-edit', 'phase-boundary-edit']) {
    let firstEdited;
    for (const action of [kind, 'undo', 'redo', 'undo']) {
      const transition = await mutate(page, action); assertHatchRebuild(transition.frame); assert.deepEqual(transition.camera, warmState.camera);
      const currentPair = await pair(`hatch-${kind}-${action}-${evidence.edits.length}`, true, true);
      if (action === kind) { assert.ok(changedPixels(warmPair.images[0], currentPair.images[0]) > 0); assert.ok(changedPixels(warmPair.images[1], currentPair.images[1]) > 0); firstEdited = currentPair; }
      else { const expected = action === 'redo' ? firstEdited : warmPair; assert.equal(Buffer.compare(expected.images[0].data, currentPair.images[0].data), 0); assert.equal(Buffer.compare(expected.images[1].data, currentPair.images[1].data), 0); }
      evidence.edits.push({ kind, ...transition, accuracy: currentPair.evidence });
    }
    assert.equal((await capture(page)).document, warmState.document);
  }

  const contextBefore = await prototypeContext(page); await page.evaluate(() => window.gpuPrototype.loseContext());
  await page.waitForFunction(() => window.gpuPrototype.status().device === 'lost', null, { timeout: 10000 });
  const lost = await pair('hatch-real-context-loss-complete-canvas', false);
  const restored = await restoredOwnerFrame(page);
  assert.equal(restored.frame.rendered, true); assert.equal(restored.frame.cacheHit, false); assert.equal(restored.frame.uploadKind, 'full'); assert.equal(restored.frame.uploadCalls, 1); assert.ok(restored.frame.bytes > 0);
  const restoredPair = await pair('hatch-first-owner-context-restoration', true, true), restoredState = await capture(page);
  assert.equal(restoredState.document, warmState.document); assert.deepEqual(restoredState.camera, warmState.camera);
  assert.equal(Buffer.compare(warmPair.images[1].data, restoredPair.images[1].data), 0);
  evidence.contextRecovery = { before: contextBefore, warm, lost: lost.evidence, firstAutomaticRestoration: restored, after: await prototypeContext(page), accuracy: restoredPair.evidence, documentUnchanged: true, cameraUnchanged: true, rendererResourcesReset: false };

  // Keep a real, visibly changed immutable hatch at the native Save As boundary.
  const saveEdit = await mutate(page, 'phase-boundary-edit'); assertHatchRebuild(saveEdit.frame);
  const savedBefore = await capture(page), preSave = await pair('hatch-edited-before-real-dxf-save', true, true);
  assert.ok(changedPixels(warmPair.images[0], preSave.images[0]) > 0); assert.equal(savedBefore.dirty, true);
  const savePath = resolve(out, `hatch-edited-native-${Date.now()}.dxf`); assert.equal(dirname(savePath), resolve(out)); assert.equal(existsSync(savePath), false);
  await app.evaluate(({ dialog }, destination) => {
    const state = /** @type {any} */ (globalThis), dialogs = /** @type {any} */ (dialog), paths = process.getBuiltinModule('node:path');
    if (paths.dirname(paths.resolve(destination.path)).toLowerCase() !== paths.resolve(destination.out).toLowerCase()) throw new Error('Hatch save escaped private output');
    if (state.__hatchDialogs) throw new Error('Another hatch dialog owner exists');
    state.__hatchDialogs = { save: [destination.path], open: [destination.path], events: [], originalSave: dialogs.showSaveDialog, originalOpen: dialogs.showOpenDialog };
    dialogs.showSaveDialog = async (_window, options) => { const next = state.__hatchDialogs.save.shift(); state.__hatchDialogs.events.push({ kind: 'save', title: options?.title, path: next ?? null }); return next ? { canceled: false, filePath: next } : { canceled: true }; };
    dialogs.showOpenDialog = async (_window, options) => { const next = state.__hatchDialogs.open.shift(); state.__hatchDialogs.events.push({ kind: 'open', title: options?.title, path: next ?? null }); return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] }; };
  }, { path: savePath, out });
  try {
    assert.equal(await page.evaluate(() => window.editor.saveFile(true, 'dxf')), true, 'Actual Save As/IPC/atomic writer');
    const bytes = readFileSync(savePath), records = savedHatchRecords(bytes.toString('utf8')), original = savedBefore.entities.filter((entity) => entity.type === 'hatch');
    assert.equal(records.length, original.length);
    records.forEach((record, index) => {
      const source = original[index], value = (code) => record.find((pair) => pair.code === code)?.value;
      assert.equal(value(2), source.pattern); assert.equal(Number(value(70)), 0); assert.equal(Number(value(71)), 0);
      assert.equal(Number(value(91)), source.loops.length); assert.equal(Number(value(75)), source.style ?? 0);
      assert.equal(record.filter((pair) => pair.code === 92).length, source.loops.length); assertFamilies(savedFamilies(record), families(source), `${source.id}: actual saved native families`);
    });
    assert.equal(await page.evaluate(() => window.editor.openFile()), true, 'Actual Open/IPC/reader');
    for (let count = 0; count < 8 && await page.locator('.import-report-dialog').count(); count++) await page.locator('.import-report-dialog .modal-footer button').filter({ hasText: /^Close$/ }).first().click();
    assert.equal(await page.locator('.modal').count(), 0);
    await page.evaluate((camera) => { const v = window.editor.viewport; v.center = camera.center; v.scale = camera.scale; v.twist = camera.twist; window.editor.render(); }, savedBefore.camera);
    const reopened = await capture(page); assert.equal(reopened.path, savePath); assert.equal(reopened.dirty, false); assert.deepEqual(reopened.camera, savedBefore.camera);
    assert.deepEqual(reopened.entities.map((entity) => entity.type), savedBefore.entities.map((entity) => entity.type));
    assert.ok(reopened.entities.every((entity) => !savedBefore.entities.some((old) => old.id === entity.id)), 'Actual reader assigns fresh IDs');
    const nextHatches = reopened.entities.filter((entity) => entity.type === 'hatch');
    nextHatches.forEach((source, index) => {
      const prior = original[index]; assert.deepEqual(source.loops, prior.loops); assertFamilies(families(source), families(prior), `${prior.id}: reopened original-world families`);
      for (const field of ['solid', 'pattern', 'layer', 'color', 'trueColor', 'lineWeight', 'transparency']) assert.deepEqual(source[field], prior[field]);
      assert.equal(!!source.double, !!prior.double); assert.equal(source.style ?? 0, prior.style ?? 0);
    });
    const lineAuthoring = (source) => ({ a: source.a, b: source.b, layer: source.layer, color: source.color, trueColor: source.trueColor, lineWeight: source.lineWeight, transparency: source.transparency ?? 255, linetype: source.linetype ?? 'ByLayer', ltscale: source.ltscale ?? 1 });
    assert.deepEqual(reopened.entities.filter((entity) => entity.type === 'line').map(lineAuthoring), savedBefore.entities.filter((entity) => entity.type === 'line').map(lineAuthoring));
    const reopenedPair = await pair('hatch-after-real-edited-dxf-reopen', true);
    const diff = new PNG({ width: preSave.images[0].width, height: preSave.images[0].height });
    assert.equal(reopenedPair.images[0].width, diff.width); assert.equal(reopenedPair.images[0].height, diff.height);
    const different = pixelmatch(preSave.images[0].data, reopenedPair.images[0].data, diff.data, diff.width, diff.height, { threshold: 0.15 });
    const miss = Math.max(missedForeground(preSave.images[0], reopenedPair.images[0]), missedForeground(reopenedPair.images[0], preSave.images[0]));
    assert.ok(different / (diff.width * diff.height) < 0.001, 'Independent pre-save Canvas raster is preserved'); assert.ok(miss < 0.005, 'Independent pre-save geometric coverage is preserved');
    writeFileSync(resolve(out, 'hatch-independent-edited-save-reopen-diff.png'), PNG.sync.write(diff));
    assert.equal(Buffer.compare(readFileSync(savePath), bytes), 0, 'Open does not rewrite saved bytes');
    const dialogs = await app.evaluate(() => { const d = /** @type {any} */ (globalThis).__hatchDialogs; return { events: d.events, remainingSave: d.save.length, remainingOpen: d.open.length }; });
    assert.equal(dialogs.remainingSave, 0); assert.equal(dialogs.remainingOpen, 0);
    evidence.saveReopen = { actualIpc: true, actualAtomicSave: true, path: savePath, sha256: digest(bytes), nativeRecords: records.length, savedBefore, reopened, dialogs,
      canvasRoundTrip: { imageDifferenceFraction: different / (diff.width * diff.height), twoPixelCoverageMissFraction: miss, rawDifferentPixels: changedPixels(preSave.images[0], reopenedPair.images[0]) }, accuracy: reopenedPair.evidence, originalWorldFamiliesAndLoopsPreserved: true, decorativeOriginMayCanonicalize: true, rendererResourcesReset: false };
  } finally { await app.evaluate(({ dialog }) => { const state = /** @type {any} */ (globalThis), d = state.__hatchDialogs, dialogs = /** @type {any} */ (dialog); dialogs.showSaveDialog = d.originalSave; dialogs.showOpenDialog = d.originalOpen; delete state.__hatchDialogs; }); }

  // Original unsafe sources/poses remain explicit negative controls. No blanket reason whitelist.
  for (const fixture of cases.slice(1)) {
    const source = await load(page, fixture), actual = await pair(fixture.name, false);
    assert.equal(actual.evidence.gpuFrame.reason, fixture.reason, `${fixture.name}: intended current source safety guard`);
    evidence.controls.push({ name: fixture.name, source: fixture.source, sourceHash: digest(JSON.stringify(fixture)), snapshot: source, accuracy: actual.evidence });
  }
  const fallback = cases.find((fixture) => fixture.name === 'hatches-fallback-original');
  for (const control of isolatedFallbacks) {
    const fixture = { ...fallback, name: `hatch-isolated-${control.id}`, twist: 0, entities: fallback.entities.filter((entity) => entity.type === 'line' || entity.id === control.id) };
    const source = await load(page, fixture), actual = await pair(fixture.name, false);
    assert.equal(actual.evidence.gpuFrame.reason, control.reason, `${control.id}: intended unmasked source refusal`);
    evidence.controls.push({ name: fixture.name, source, accuracy: actual.evidence });
  }
  for (const id of commonIds) for (const kind of ['selected', 'hovered']) {
    await load(page, common); await page.evaluate(({ id, kind }) => { const ed = window.editor; if (kind === 'selected') ed.selection.add(id); else ed.setHover(id); ed.render(); }, { id, kind });
    const actual = await pair(`hatch-${id}-${kind}`, false);
    assert.equal(actual.evidence.gpuFrame.reason, 'Hatch annotation or highlight requires Canvas');
    evidence.controls.push({ id, kind, accuracy: actual.evidence });
  }
  assert.equal(execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), result.sourceSha, 'Native source stayed frozen');
  evidence.bodyOutcome = 'passed';
  result.validation.push('HATCH: authored LINE/NET/ANSI31/ANSI37/file families and islands, strict actual raster/color/order, zero-upload warm pan/zoom, visible168-byte companion LINE edit/undo, full hatch style/phase/boundary edit/undo/redo, same-scene automatic context restoration, real private edited DXF IPC save/reopen against independent pre-save Canvas, and original unsafe/isolated/highlight zero-GL complete Canvas controls.');
  return evidence;
}

/** Preserve the caller source/history/camera and primary failure across private authoring probes. */
export async function validateNativeHatches(options) {
  const saved = await options.page.evaluate(() => {
    const ed = window.editor, v = ed.viewport, api = window.gpuPrototype;
    return { snapshot: ed.doc.snapshot, document: JSON.stringify(ed.doc.snapshot), path: ed.doc.filePath, dirty: ed.doc.dirty,
      history: ed.doc.history(), selection: [...ed.selection], hover: ed.overlay.hover ?? null, color: ed.doc.currentColor,
      camera: { center: { ...v.center }, scale: v.scale, twist: v.twist, width: v.width, height: v.height, dpr: v.dpr }, settings: { ...v.settings },
      mode: api.status().mode, fixture: api.fixtureMetadata()?.name ?? null, suggestedName: ed.suggestedName };
  });
  let primaryError, primaryFailed = false, value;
  try { value = await validateNativeHatchesBody(options); }
  catch (error) {
    primaryFailed = true; primaryError = error;
    if (options.result.hatchCoverage) Object.assign(options.result.hatchCoverage, { outcome: 'failed', bodyOutcome: 'failed' });
    // Preserve the failing pose/source before restoring the caller. The outer
    // benchmark failure capture observes the restored compound scene instead.
    if (options.result.hatchCoverage) {
      try {
        options.result.hatchCoverage.failure = {
          probe: options.result.hatchCoverage.activeProbe ?? 'initialization',
          state: await capture(options.page),
          diagnostics: await options.page.evaluate(() => ({ status: window.gpuPrototype.status(), frame: window.gpuPrototype.renderStats() })),
        };
      } catch (captureError) {
        options.result.hatchCoverage.failureCapture = { outcome: 'failed', ...failureDetails(captureError) };
      }
    }
  }
  // Cleanup runs after either body outcome. Rethrow the original failure only
  // after cleanup so its identity survives a secondary restoration failure.
  {
    try {
      const cleanup = await options.page.evaluate(async (saved) => {
        const ed = window.editor, v = ed.viewport, api = window.gpuPrototype;
        api.setMode('canvas'); ed.selection.clear(); ed.setHover(null);
        // The two supported hook locations are a known benchmark fixture or a fresh default private app.
        // Restore display through the existing fixture API; do not add a renderer/display escape hatch.
        api.loadFixture(saved.fixture ?? 'dense-lines');
        ed.doc.load(saved.snapshot, saved.path); ed.doc.restoreHistory(saved.history); ed.doc.dirty = saved.dirty; ed.doc.currentColor = saved.color;
        ed.suggestedName = saved.suggestedName; Object.assign(v.settings, saved.settings);
        v.center = saved.camera.center; v.scale = saved.camera.scale; v.twist = saved.camera.twist;
        for (const id of saved.selection) ed.selection.add(id); ed.setHover(saved.hover); api.setMode(saved.mode);
        const frame = api.renderNow();
        if (frame.rendered) { const completed = await api.completed(); if (!(typeof completed === 'number' && Number.isFinite(completed) && completed >= 0)) throw new Error('Hatch cleanup GPU completion missing'); }
        else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
        if (JSON.stringify(ed.doc.snapshot) !== saved.document) throw new Error('Hatch cleanup did not restore full caller source');
        if (JSON.stringify(ed.doc.history()) !== JSON.stringify(saved.history)) throw new Error('Hatch cleanup did not restore caller history');
        const camera = { center: { ...v.center }, scale: v.scale, twist: v.twist, width: v.width, height: v.height, dpr: v.dpr };
        if (JSON.stringify(camera) !== JSON.stringify(saved.camera)) throw new Error('Hatch cleanup did not restore caller camera/surface');
        if (ed.doc.filePath !== saved.path || ed.doc.dirty !== saved.dirty) throw new Error('Hatch cleanup changed caller saving state');
        return { outcome: 'passed', documentRestored: true, historyRestored: true, cameraRestored: true, savingStateRestored: true, rendererResourcesReset: false };
      }, saved);
      if (options.result.hatchCoverage) options.result.hatchCoverage.cleanup = cleanup;
    } catch (cleanupError) {
      if (options.result.hatchCoverage) Object.assign(options.result.hatchCoverage, { outcome: 'failed', cleanup: { outcome: 'failed', ...failureDetails(cleanupError) } });
      if (!primaryFailed) throw cleanupError;
    }
  }
  if (primaryFailed) throw primaryError;
  if (options.result.hatchCoverage) options.result.hatchCoverage.outcome = 'passed';
  return value;
}
