// Untimed native DIM regression gate. Focused native Intel/NVIDIA passed0423; full integrated benchmark remains required.
// Uses only existing editor/GPU APIs and the REAL benchmark pairAtCurrent callback.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { chooseBenchmarkLineEdit } from './gpu-edit-candidate.mjs';
import { nativeDimensionCases, fixedDimensionOracles, originalDimensionControlEvidence } from './gpu-dimension-cases.mjs';
import { verifySavedNativeDimensions, verifyReopenedDimension } from './gpu-dimension-roundtrip.mjs';
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
function assertDimensionRebuild(frame) {
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
    api.loadFixture(fixture.lineweights ? 'compound-ordered' : 'direct-arc-control');
    ed.loadState({ entities: fixture.entities, layers: [{ name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 }], blocks: {}, currentLayer: '0' }, null);
    v.center = fixture.center; v.scale = fixture.scale; v.twist = fixture.twist; v.settings.gridVisible = false; for (const id of fixture.selection ?? []) ed.selection.add(id);
    v.renderCurrent();
  }, fixture);
  const value = await capture(page);
  assert.deepEqual(value.entities, fixture.entities, `${fixture.name}: complete original authoring data reaches Drawing`);
  assert.deepEqual(value.camera.center, fixture.center); assert.equal(value.camera.scale, fixture.scale); assert.equal(value.camera.twist, fixture.twist);
  assert.equal(value.path, null); assert.equal(value.dirty, false);
  const sealed = await page.evaluate(() => window.editor.doc.snapshot.entities.every((entity) => Object.isFrozen(entity) && (entity.type !== 'dimension' || Object.isFrozen(entity.p1) && Object.isFrozen(entity.p2) && Object.isFrozen(entity.linePoint) && Object.isFrozen(entity.style))));
  assert.equal(sealed, true, 'Original DIM source/anchors/style are immutable in Drawing; native certificates still require actual admission');
  return value;
}
async function mutate(page, action, lineCandidate = null) {
  return page.evaluate(async ({ action, lineCandidate }) => {
    const ed = window.editor, api = window.gpuPrototype, v = ed.viewport, before = ed.doc.snapshot;
    if (action === 'line-edit') ed.doc.replaceEntities([lineCandidate.edited]);
    else if (action === 'dimension-edit' || action === 'dimension-style-edit' || action === 'save-authoring-edit') {
      const source = ed.doc.entities.find((entity) => entity.id === 'linear');
      if (!source) throw new Error('Original linear DIM source missing');
      const next = action === 'dimension-edit' ? { ...source, linePoint: { ...source.linePoint, y: source.linePoint.y + 0.5 } }
        : action === 'dimension-style-edit' ? { ...source, style: { ...source.style, arrowSize: 0.5, textHeight: 0.45, extLineColor: 1 } }
        : { ...source, p2: { ...source.p2, x: source.p2.x + 1 }, text: 'DIM <>', textPosition: { x: source.textPosition.x - 0.2, y: source.textPosition.y + 0.3 } };
      ed.doc.replaceEntities([next]);
    } else if (action === 'undo' || action === 'redo') { if (!ed.doc[action]()) throw new Error(`${action}: no actual history step`); }
    else throw new Error(`Unknown private DIM mutation ${action}`);
    if (ed.doc.snapshot === before) throw new Error(`${action}: no original source change`);
    const frame = api.renderNow(); let completionMs = null;
    if (frame.rendered) { completionMs = await api.completed(); if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('Actual DIM GPU completion missing'); }
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
      timer = setTimeout(() => rejectFrame(new Error('First automatic restored dimension frame missing within10seconds')), 10000);
      api.restoreContext();
      const frame = await observed, completionMs = await api.completed();
      if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('Restored dimension completion missing');
      return { frame, completionMs, automaticFrames: frames, ownerTriggered: true };
    } finally { clearTimeout(timer); if (descriptor) Object.defineProperty(v, 'render', descriptor); else delete v.render; }
  });
}
function changedPixels(a, b) {
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  let count = 0; for (let index = 0; index < a.data.length; index += 4) if ([0, 1, 2, 3].some((channel) => a.data[index + channel] !== b.data[index + channel])) count++;
  return count;
}

/** Actual admission for all positives and fixed exact source-bound negatives are REQUIRED.
 * @param {{page:any,app:any,root:string,out:string,profile:string,pairAtCurrent:any,prototypeContext:any,missedForeground:any,result:any}} options
 */
async function validateNativeDimensionsBody({ page, app, root, out, profile, pairAtCurrent, prototypeContext, missedForeground, result }) {
  assert.equal(result.worktreeModified, false, 'Native DIM evidence requires a clean frozen source');
  assert.equal(execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), result.sourceSha);
  const evidence = { outcome: 'started', sourceSha: result.sourceSha, hardware: result.hardware, cases: [], comparisons: {}, fixedInteriors: [], textCanvasReference: null, edits: [], controls: [], contextRecovery: null, saveReopen: null,
    limits: ['Focused real Intel/default and NVIDIA/high-performance native checks passed0423. Every fresh full integrated benchmark must independently prove all five admissions and retained exact original controls.',
      'No app dimensionAudit API, painter-command API, external CAD fixture or independent font correctness oracle.',
      'Original input is verified before saving; native DXF anchor re-materialization is field-specific and never described as exact raw authoring preservation.',
      'Original CPU .37/close-zoom viewport metadata is retained separately from actual hardware viewport/DPR.', 'One actual owned adapter per run; no physical AMD claim.'] };
  result.dimensionCoverage = evidence;
  evidence.privateScope = await app.evaluate(({ app }, expected) => {
    const paths = process.getBuiltinModule('node:path');
    if (paths.resolve(app.getPath('userData')).toLowerCase() !== paths.resolve(expected.profile).toLowerCase()) throw new Error('DIM private profile is not the benchmark owner');
    if (paths.resolve(app.getAppPath()).toLowerCase() !== paths.resolve(expected.root).toLowerCase()) throw new Error('DIM app is not the frozen GPU worktree');
    const relative = paths.relative(paths.resolve(expected.root), paths.resolve(expected.out));
    if (!relative || relative.startsWith('..') || paths.isAbsolute(relative)) throw new Error('DIM output escaped owned worktree');
    return { appPath: app.getAppPath(), userData: app.getPath('userData'), output: paths.resolve(expected.out), verified: true };
  }, { root, out, profile });
  const pair = async (label, expectedGPU, warm = false) => {
    evidence.activeProbe = label;
    const before = await capture(page), value = await pairAtCurrent(label, expectedGPU, warm), after = await capture(page);
    assert.equal(after.document, before.document); assert.deepEqual(after.camera, before.camera); assert.deepEqual(after.history, before.history);
    assert.equal(after.dirty, before.dirty); assert.deepEqual(after.selection, before.selection); assert.equal(after.hover, before.hover); assert.deepEqual(after.display, before.display);
    assert.notEqual(value.evidence.gpuFrame.cacheReason, 'admission-deferred'); assert.equal(value.evidence.gpuFrame.rendered, expectedGPU);
    assert.ok(value.evidence.twoPixelCoverageMissFraction < 0.005);
    if (expectedGPU) { assert.ok(value.evidence.imageDifferenceFraction < 0.001); if (warm) assertWarm(value.evidence.gpuFrame, label); }
    else { assertNoGpuSubmission(value.evidence.gpuFrame, label); assert.equal(value.evidence.imageDifferenceFraction, 0); assert.equal(Buffer.compare(value.images[0].data, value.images[1].data), 0); }
    evidence.comparisons[label] = value.evidence; return value;
  };
  const cases = nativeDimensionCases();
  for (const fixture of cases.individual) {
    const source = await load(page, fixture), actual = await pair(fixture.name, true);
    evidence.cases.push({ name: fixture.name, sourceHash: digest(JSON.stringify(fixture)), original: fixture, loaded: source, accuracy: actual.evidence });
  }
  const common = cases.common, baseline = await load(page, common), baselinePair = await pair(common.name, true);
  evidence.cases.push({ name: common.name, sourceHash: digest(JSON.stringify(common)), original: common, loaded: baseline, accuracy: baselinePair.evidence });
  evidence.observedOwnedContext = await prototypeContext(page); assert.equal(evidence.observedOwnedContext.state, 'ready'); assert.equal(evidence.observedOwnedContext.rendered, true);
  // Snap the ORIGINAL later ORDER crossing to a physical pixel center. Source data is unchanged.
  try {
    await page.evaluate(() => { const v = window.editor.viewport, p = v.toScreen({ x: -7, y: -2 });
      const target = { x: (Math.floor(p.x * v.dpr) + 0.5) / v.dpr, y: (Math.floor(p.y * v.dpr) + 0.5) / v.dpr };
      v.center = { x: v.center.x + (p.x - target.x) / v.scale, y: v.center.y + (target.y - p.y) / v.scale }; window.editor.render(); });
    const actual = await pair('dimension-original-fixed-arrow-role-order-text-interiors', true);
    const positions = await page.evaluate((oracle) => { const v = window.editor.viewport; return { width: v.width, height: v.height, dpr: v.dpr,
      roles: oracle.roles.map((probe) => ({ ...probe, screen: v.toScreen(probe.point) })), triangle: oracle.rightFilledArrow.points.map((point) => v.toScreen(point)),
      textCorners: oracle.textRegion.corners.map((point) => v.toScreen(point)) }; }, fixedDimensionOracles);
    const rgba = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
    const color = (value, rgb, label) => { assert.equal(value[3], 255); rgb.forEach((channel, index) => assert.ok(Math.abs(value[index] - channel) <= 2, label)); };
    const canvas = actual.images[0], gpu = actual.images[1];
    for (const probe of positions.roles) {
      const x = Math.floor(probe.screen.x * canvas.width / positions.width), y = Math.floor(probe.screen.y * canvas.height / positions.height);
      assert.ok(x > 1 && y > 1 && x < canvas.width - 2 && y < canvas.height - 2, `${probe.label}: actual visible original interior`);
      const values = actual.images.map((image) => rgba(image, x, y)); values.forEach((value) => color(value, probe.rgb, probe.label));
      evidence.fixedInteriors.push({ ...probe, actualRgba: values, provenance: 'Fixed original source/role color and painter-order probe; no GPU mesh input' });
    }
    const triangle = positions.triangle.map((point) => ({ x: point.x * canvas.width / positions.width, y: point.y * canvas.height / positions.height }));
    const signed = (p, a, b) => (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
    const edgeDistance = (p, a, b) => Math.abs(signed(p, a, b)) / Math.hypot(a.x - b.x, a.y - b.y);
    let filled = 0, exterior = 0;
    const minX = Math.floor(Math.min(...triangle.map((p) => p.x))) - 2, maxX = Math.ceil(Math.max(...triangle.map((p) => p.x))) + 2;
    const minY = Math.floor(Math.min(...triangle.map((p) => p.y))) - 2, maxY = Math.ceil(Math.max(...triangle.map((p) => p.y))) + 2;
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      assert.ok(x >= 0 && y >= 0 && x < canvas.width && y < canvas.height, 'Original arrow is wholly visible');
      const p = { x: x + 0.5, y: y + 0.5 }, signs = triangle.map((a, i) => signed(p, a, triangle[(i + 1) % 3]));
      const inside = signs.every((s) => s >= 0) || signs.every((s) => s <= 0);
      const margin = Math.min(...triangle.map((a, i) => edgeDistance(p, a, triangle[(i + 1) % 3])));
      if (inside && margin > 0.75) { color(rgba(canvas, x, y), fixedDimensionOracles.rightFilledArrow.rgb, 'Fixed original filled-arrow interior Canvas'); color(rgba(gpu, x, y), fixedDimensionOracles.rightFilledArrow.rgb, 'Fixed original filled-arrow interior GPU'); filled++; }
      // Exterior expected background is selected from Canvas to avoid neighboring original DIM line ink.
      if (!inside && margin > 0.75 && rgba(canvas, x, y).slice(0, 3).every((n, i) => n === fixedDimensionOracles.rightFilledArrow.background[i])) {
        color(rgba(gpu, x, y), fixedDimensionOracles.rightFilledArrow.background, 'Canvas-reference exterior detects an invented filled-arrow outline'); exterior++;
      }
    }
    assert.ok(filled > 0 && exterior > 0, 'Actual DPR supplies meaningful fixed interior and Canvas-reference exterior pixels');
    evidence.fixedInteriors.push({ role: 'original fill-only arrow', originalTriangle: fixedDimensionOracles.rightFilledArrow, physicalTriangle: triangle, fixedInteriorPixels: filled, canvasSelectedExteriorPixels: exterior });
    const corners = positions.textCorners.map((p) => ({ x: p.x * canvas.width / positions.width, y: p.y * canvas.height / positions.height }));
    let ink = 0;
    for (let y = Math.floor(Math.min(...corners.map((p) => p.y))); y <= Math.ceil(Math.max(...corners.map((p) => p.y))); y++) for (let x = Math.floor(Math.min(...corners.map((p) => p.x))); x <= Math.ceil(Math.max(...corners.map((p) => p.x))); x++) {
      assert.ok(x >= 0 && y >= 0 && x < canvas.width && y < canvas.height, 'Original text probe region visible');
      const value = rgba(canvas, x, y);
      if (value[3] === 255 && fixedDimensionOracles.textRegion.rgb.every((channel, i) => Math.abs(value[i] - channel) <= 2)) { color(rgba(gpu, x, y), fixedDimensionOracles.textRegion.rgb, 'Canvas-reference text-region ink'); ink++; }
    }
    assert.ok(ink > 0, 'Text-region gate contains actual Canvas ink');
    evidence.textCanvasReference = { ...fixedDimensionOracles.textRegion, comparedInkPixels: ink, derivedFormattedStrings: fixedDimensionOracles.expectedFormattedText, independentFontOrContentProof: false };
  } finally { await page.evaluate((camera) => { const v = window.editor.viewport; v.center = camera.center; v.scale = camera.scale; v.twist = camera.twist; window.editor.render(); }, baseline.camera); }
  assert.equal((await capture(page)).document, baseline.document);
  const warm = await page.evaluate(async () => { const v = window.editor.viewport, api = window.gpuPrototype;
    v.zoomAt({ x: v.width / 2, y: v.height / 2 }, 1.05); v.panByPixels(18 / v.dpr, -12 / v.dpr);
    const frame = api.renderNow(), completionMs = await api.completed(); if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('Actual warm DIM completion missing'); return { frame, completionMs }; });
  assertWarm(warm.frame, 'DIM warm pan/zoom'); const warmState = await capture(page), warmPair = await pair('dimension-warm-pan-zoom', true, true);
  const candidate = chooseBenchmarkLineEdit({ entities: warmState.entities, layers: warmState.layers }, warmState.camera, 'L');
  for (const kind of ['line-edit', 'dimension-edit', 'dimension-style-edit']) {
    let edited;
    for (const action of [kind, 'undo', 'redo', 'undo']) {
      const transition = await mutate(page, action, candidate); if (kind === 'line-edit') assertLineDelta(transition.frame, action); else assertDimensionRebuild(transition.frame);
      assert.deepEqual(transition.camera, warmState.camera);
      const actual = await pair(`dimension-${kind}-${action}-${evidence.edits.length}`, true, true);
      if (action === kind) { assert.ok(changedPixels(warmPair.images[0], actual.images[0]) > 0); assert.ok(changedPixels(warmPair.images[1], actual.images[1]) > 0);
        for (let i = 0; i < 2; i++) assert.ok(pixelmatch(warmPair.images[i].data, actual.images[i].data, null, actual.images[i].width, actual.images[i].height, { threshold: 0.15 }) > 0, 'Original-source edit is visibly different'); edited = actual; }
      else { const expected = action === 'redo' ? edited : warmPair; for (let i = 0; i < 2; i++) assert.equal(Buffer.compare(expected.images[i].data, actual.images[i].data), 0); }
      evidence.edits.push({ kind, ...transition, candidate: kind === 'line-edit' ? candidate : undefined, accuracy: actual.evidence });
    }
    assert.equal((await capture(page)).document, warmState.document);
  }
  const contextBefore = await prototypeContext(page); await page.evaluate(() => window.gpuPrototype.loseContext());
  await page.waitForFunction(() => window.gpuPrototype.status().device === 'lost', null, { timeout: 10000 });
  const lost = await pair('dimension-real-context-loss-complete-canvas', false), restored = await restoredOwnerFrame(page);
  assert.equal(restored.automaticFrames[0].rendered, true, 'The first automatic owner frame itself admits DIM; a later repair cannot hide a failed first frame'); assert.equal(restored.frame.rendered, true); assert.equal(restored.frame.cacheHit, false); assert.equal(restored.frame.uploadKind, 'full'); assert.equal(restored.frame.uploadCalls, 1); assert.ok(restored.frame.bytes > 0);
  const restoredPair = await pair('dimension-first-owner-context-restoration', true, true), restoredState = await capture(page);
  assert.equal(restoredState.document, warmState.document); assert.deepEqual(restoredState.camera, warmState.camera); assert.equal(Buffer.compare(warmPair.images[1].data, restoredPair.images[1].data), 0);
  evidence.contextRecovery = { before: contextBefore, lost: lost.evidence, firstAutomaticRestoration: restored, after: await prototypeContext(page), accuracy: restoredPair.evidence, rendererResourcesReset: false };
  // Native save can reveal an external codec dependency; never bypass it or repair the codec here.
  let saveError, saveFailed = false;
  try { evidence.saveReopen = await validateDimensionSaveReopen({ page, app, out, pair, missedForeground, warmPair, evidence }); }
  catch (error) { saveFailed = true; saveError = error; evidence.saveReopen = { ...evidence.saveReopen, outcome: 'blocked', dependency: 'native DIM save/validation gate; codec ownership applies only to a confirmed field-specific data-loss defect', ...failureDetails(error) }; try { evidence.saveReopen.beforeCleanup = await capture(page); } catch (captureError) { evidence.saveReopen.failureCapture = failureDetails(captureError); } }
  for (const fixture of cases.controls) {
    const source = await load(page, fixture), actual = await pair(fixture.name, false);
    const proof = originalDimensionControlEvidence[fixture.name];
    assert.ok(proof, `${fixture.name}: fixed reviewed original control exists`);
    assert.equal(proof.fixtureSha, digest(JSON.stringify(fixture)), `${fixture.name}: exact original fixture/pose provenance`);
    assert.equal(proof.kind, 'source-construction-refusal');
    assert.equal(actual.evidence.gpuFrame.reason, proof.reason, `${fixture.name}: original exact source safety guard; unknown/driver reasons cannot be accepted`);
    evidence.controls.push({ name: fixture.name, original: fixture, sourceHash: proof.fixtureSha, loaded: source, accuracy: actual.evidence, guardProof: proof, guardVerified: true });
  }
  assert.equal(execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), result.sourceSha);
  if (saveFailed) throw saveError;
  evidence.bodyOutcome = 'passed';
  result.validation.push('DIMENSION: original-source five-kind zero-twist admission, fixed fill/role/order interiors, separately labeled Canvas text ink, strict raster/coverage, immutable edit/undo/redo, warm zero-upload reuse, actual automatic context restoration, real edited native DXF and field-specific anchors against independent pre-save Canvas, and untouched original negative controls.');
  return evidence;
}
/** Preserve the caller source/history/camera and primary failure across private authoring probes. */
export async function validateNativeDimensions(options) {
  const saved = await options.page.evaluate(() => {
    const ed = window.editor, v = ed.viewport, api = window.gpuPrototype;
    return { snapshot: ed.doc.snapshot, document: JSON.stringify(ed.doc.snapshot), path: ed.doc.filePath, dirty: ed.doc.dirty,
      history: ed.doc.history(), selection: [...ed.selection], hover: ed.overlay.hover ?? null, color: ed.doc.currentColor,
      camera: { center: { ...v.center }, scale: v.scale, twist: v.twist, width: v.width, height: v.height, dpr: v.dpr }, settings: { ...v.settings },
      mode: api.status().mode, fixture: api.fixtureMetadata()?.name ?? null, suggestedName: ed.suggestedName };
  });
  let primaryError, primaryFailed = false, value;
  try { value = await validateNativeDimensionsBody(options); }
  catch (error) {
    primaryFailed = true; primaryError = error;
    if (options.result.dimensionCoverage) Object.assign(options.result.dimensionCoverage, { outcome: 'failed', bodyOutcome: 'failed' });
    // Preserve the failing pose/source before restoring the caller. The outer
    // benchmark failure capture observes the restored compound scene instead.
    if (options.result.dimensionCoverage) {
      try {
        options.result.dimensionCoverage.failure = { probe: options.result.dimensionCoverage.activeProbe ?? 'initialization' };
        options.result.dimensionCoverage.failure.state = await capture(options.page);
        options.result.dimensionCoverage.failure.diagnostics = await options.page.evaluate(() => ({ status: window.gpuPrototype.status(), frame: window.gpuPrototype.renderStats() }));
      } catch (captureError) {
        options.result.dimensionCoverage.failureCapture = { outcome: 'failed', ...failureDetails(captureError) };
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
        if (frame.rendered) { const completed = await api.completed(); if (!(typeof completed === 'number' && Number.isFinite(completed) && completed >= 0)) throw new Error('Dimension cleanup GPU completion missing'); }
        else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
        if (JSON.stringify(ed.doc.snapshot) !== saved.document) throw new Error('Dimension cleanup did not restore full caller source');
        if (JSON.stringify(ed.doc.history()) !== JSON.stringify(saved.history)) throw new Error('Dimension cleanup did not restore caller history');
        const camera = { center: { ...v.center }, scale: v.scale, twist: v.twist, width: v.width, height: v.height, dpr: v.dpr };
        if (JSON.stringify(camera) !== JSON.stringify(saved.camera)) throw new Error('Dimension cleanup did not restore caller camera/surface');
        if (ed.doc.filePath !== saved.path || ed.doc.dirty !== saved.dirty) throw new Error('Dimension cleanup changed caller saving state');
        if (JSON.stringify([...ed.selection]) !== JSON.stringify(saved.selection) || (ed.overlay.hover ?? null) !== saved.hover) throw new Error('Dimension cleanup did not restore selection/hover');
        if (JSON.stringify(v.settings) !== JSON.stringify(saved.settings) || ed.doc.currentColor !== saved.color || ed.suggestedName !== saved.suggestedName || api.status().mode !== saved.mode) throw new Error('Dimension cleanup did not restore caller display/mode');
        return { outcome: 'passed', documentRestored: true, historyRestored: true, cameraRestored: true, savingStateRestored: true, rendererResourcesReset: false };
      }, saved);
      if (options.result.dimensionCoverage) options.result.dimensionCoverage.cleanup = cleanup;
    } catch (cleanupError) {
      if (options.result.dimensionCoverage) Object.assign(options.result.dimensionCoverage, { outcome: 'failed', cleanup: { outcome: 'failed', ...failureDetails(cleanupError) } });
      if (!primaryFailed) throw cleanupError;
    }
  }
  if (primaryFailed) throw primaryError;
  if (options.result.dimensionCoverage) options.result.dimensionCoverage.outcome = 'passed';
  return value;
}


async function validateDimensionSaveReopen({ page, app, out, pair, missedForeground, warmPair, evidence }) {
  const transition = await mutate(page, 'save-authoring-edit'); assertDimensionRebuild(transition.frame);
  const savedBefore = await capture(page), preSave = await pair('dimension-edited-before-real-native-dxf-save', true, true); evidence.saveReopen = { outcome: 'started', transition, savedBefore };
  assert.ok(changedPixels(warmPair.images[0], preSave.images[0]) > 0); assert.equal(savedBefore.dirty, true);
  const edited = savedBefore.entities.find((entity) => entity.id === 'linear');
  assert.equal(edited.text, 'DIM <>'); assert.deepEqual(edited.textPosition, { x: -5.2, y: -1.7 }); assert.deepEqual(edited.p2, { x: 0, y: -4 });
  const savePath = resolve(out, `dimension-edited-native-${Date.now()}.dxf`); assert.equal(dirname(savePath), resolve(out)); assert.equal(existsSync(savePath), false);
  await app.evaluate(({ dialog }, destination) => {
    const state = /** @type {any} */ (globalThis), dialogs = /** @type {any} */ (dialog), paths = process.getBuiltinModule('node:path');
    if (paths.dirname(paths.resolve(destination.path)).toLowerCase() !== paths.resolve(destination.out).toLowerCase()) throw new Error('DIM save escaped private output');
    if (state.__dimensionDialogs) throw new Error('Another DIM dialog owner exists');
    state.__dimensionDialogs = { save: [destination.path], open: [destination.path], events: [], originalSave: dialogs.showSaveDialog, originalOpen: dialogs.showOpenDialog };
    dialogs.showSaveDialog = async (_window, options) => { const next = state.__dimensionDialogs.save.shift(); state.__dimensionDialogs.events.push({ kind: 'save', title: options?.title, path: next ?? null }); return next ? { canceled: false, filePath: next } : { canceled: true }; };
    dialogs.showOpenDialog = async (_window, options) => { const next = state.__dimensionDialogs.open.shift(); state.__dimensionDialogs.events.push({ kind: 'open', title: options?.title, path: next ?? null }); return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] }; };
  }, { path: savePath, out });
  let value, primaryError, primaryFailed = false;
  try {
    assert.equal(await page.evaluate(() => window.editor.saveFile(true, 'dxf')), true, 'Actual Save As/IPC/atomic writer');
    const bytes = readFileSync(savePath), original = savedBefore.entities.filter((entity) => entity.type === 'dimension');
    const records = verifySavedNativeDimensions(bytes.toString('utf8'), original); evidence.saveReopen.nativeRecords = records; evidence.saveReopen.path = savePath;
    assert.equal(await page.evaluate(() => window.editor.openFile()), true, 'Actual Open/IPC/reader');
    for (let count = 0; count < 8 && await page.locator('.import-report-dialog').count(); count++) await page.locator('.import-report-dialog .modal-footer button').filter({ hasText: /^Close$/ }).first().click();
    assert.equal(await page.locator('.modal').count(), 0);
    await page.evaluate((camera) => { const v = window.editor.viewport; v.center = camera.center; v.scale = camera.scale; v.twist = camera.twist; window.editor.render(); }, savedBefore.camera);
    const reopened = await capture(page); assert.equal(reopened.path, savePath); assert.equal(reopened.dirty, false); assert.deepEqual(reopened.camera, savedBefore.camera);
    assert.deepEqual(reopened.entities.map((entity) => entity.type), savedBefore.entities.map((entity) => entity.type));
    assert.ok(reopened.entities.every((entity) => !savedBefore.entities.some((old) => old.id === entity.id)), 'Actual reader assigns fresh IDs');
    evidence.saveReopen.reopened = reopened; const actualDimensions = reopened.entities.filter((entity) => entity.type === 'dimension');
    const authoring = actualDimensions.map((source, index) => verifyReopenedDimension(source, original[index]));
    const lineAuthoring = (source) => ({ a: source.a, b: source.b, layer: source.layer, color: source.color, trueColor: source.trueColor, lineWeight: source.lineWeight,
      transparency: source.transparency ?? 255, linetype: source.linetype ?? 'ByLayer', ltscale: source.ltscale ?? 1 });
    assert.deepEqual(reopened.entities.filter((entity) => entity.type === 'line').map(lineAuthoring), savedBefore.entities.filter((entity) => entity.type === 'line').map(lineAuthoring));
    const reopenedPair = await pair('dimension-after-real-edited-native-dxf-reopen', true);
    const diff = new PNG({ width: preSave.images[0].width, height: preSave.images[0].height });
    assert.equal(reopenedPair.images[0].width, diff.width); assert.equal(reopenedPair.images[0].height, diff.height);
    const different = pixelmatch(preSave.images[0].data, reopenedPair.images[0].data, diff.data, diff.width, diff.height, { threshold: 0.15 });
    const miss = Math.max(missedForeground(preSave.images[0], reopenedPair.images[0]), missedForeground(reopenedPair.images[0], preSave.images[0]));
    assert.ok(different / (diff.width * diff.height) < 0.001, 'Independent ORIGINAL pre-save Canvas raster survives native edit/save/reopen');
    assert.ok(miss < 0.005, 'Independent pre-save geometric coverage survives');
    writeFileSync(resolve(out, 'dimension-independent-edited-save-reopen-diff.png'), PNG.sync.write(diff));
    assert.equal(Buffer.compare(readFileSync(savePath), bytes), 0, 'Open does not rewrite saved bytes');
    const dialogs = await app.evaluate(() => { const d = /** @type {any} */ (globalThis).__dimensionDialogs; return { events: d.events, remainingSave: d.save.length, remainingOpen: d.open.length }; });
    assert.equal(dialogs.remainingSave, 0); assert.equal(dialogs.remainingOpen, 0);
    value = { outcome: 'passed', actualIpc: true, actualAtomicSave: true, dialogCleanup: null, path: savePath, sha256: digest(bytes), nativeEditableDimensionRecords: records,
      savedBefore, reopened, fieldSpecificAuthoringProof: authoring, dialogs, exactRawAuthoringSource: false,
      canvasRoundTrip: { imageDifferenceFraction: different / (diff.width * diff.height), twoPixelCoverageMissFraction: miss, rawDifferentPixels: changedPixels(preSave.images[0], reopenedPair.images[0]) },
      accuracy: reopenedPair.evidence, rendererResourcesReset: false };
  } catch (error) { primaryFailed = true; primaryError = error; }
  try { await app.evaluate(({ dialog }) => { const state = /** @type {any} */ (globalThis), d = state.__dimensionDialogs, dialogs = /** @type {any} */ (dialog);
    dialogs.showSaveDialog = d.originalSave; dialogs.showOpenDialog = d.originalOpen; delete state.__dimensionDialogs; }); }
  catch (cleanupError) { evidence.saveReopen.dialogCleanup = { outcome: 'failed', ...failureDetails(cleanupError) }; if (!primaryFailed) throw cleanupError; }
  if (primaryFailed) throw primaryError;
  value.dialogCleanup = { outcome: 'passed' }; return value;
}
