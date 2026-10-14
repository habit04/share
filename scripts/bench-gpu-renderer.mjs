// Build first: npx vite build --mode gpu-experimental
// A real Windows Electron run, private profile, identical camera/drawing for both modes.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { applicationWindow } from './electron-window.mjs';
import { chooseBenchmarkLineEdit } from './gpu-edit-candidate.mjs';
import { analyzeFallbackRestoration } from './gpu-fallback-restoration.mjs';
import { matchesBenchmarkFallbackReason, mixedSchematicFallbackReasons } from './gpu-benchmark-fallback.mjs';
import { observeActualGpuAdmission } from './gpu-benchmark-admission.mjs';
import { validateNativeHatches } from './gpu-hatch-validation.mjs';
import { validateNativeDimensions } from './gpu-dimension-validation.mjs';

const cliArgs = process.argv.slice(2);
assert.ok(cliArgs.length <= 1 && cliArgs.every((argument) => argument === '--high-performance'), 'Usage: node scripts/bench-gpu-renderer.mjs [--high-performance]');
const highPerformance = cliArgs.includes('--high-performance');
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'e2e-output/gpu-renderer');
mkdirSync(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const worktreeModified = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim();
const started = performance.now();
const profile = resolve(out, `profile-${Date.now()}`);
const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`, ...(highPerformance ? ['--force_high_performance_gpu'] : [])], cwd: root, env, timeout: 60000 });
const result = { sourceSha, worktreeModified, platform: process.platform, arch: process.arch, applicationLaunchMs: 0, hardware: null, viewport: null, comparisons: {}, contextRecovery: [], validation: [], scope: null, measurementSemantics: { firstSubmissionMs: 'CPU wall time of the actual mode-triggered viewport frame; firstFrame.completedFrameWallMs also includes mode/rAF scheduling and completion observation.', cpuSubmissionMedianMs: 'Legacy field: complete viewport render CPU wall time, not just GL submission.', totalRenderMedianMs: 'Observed completed-frame wall time including camera/document mutation for moving/edit workloads; excludes next-rAF wait and desktop presentation.', preparationMs: 'Legacy GPU pre-GL CPU total; detailed cache lookup and geometry preparation are separate.', submissionMs: 'Legacy GPU GL CPU total including initialization/upload/draw; detailed stages are separate.', documentDelta: 'Partial entity preparation is distinct from full-scene rebuilds; uploadKind separately records full, subrange or no successful-frame issuance. Edit memo statistics refer to bounded owned geometry history.', gpuAttempt: 'Requested-GPU attempt CPU stages and requested uploads, including refused attempts; null means unavailable. actualRenderer labels the completed frame. Canvas fallback wall time includes the refused attempt and full Canvas rendering/readback.' }, gpuPreference: { requested: highPerformance ? 'high-performance' : 'default', electronSwitch: highPerformance ? '--force_high_performance_gpu' : null, scope: 'Private launched app only; requested preference is not proof of active hardware.' }, limitations: ['Single Windows machine or CI runner; OS caches not purged.', 'Cold frames reset renderer resources and the Canvas scene cache, not process/driver caches; drawing fixture loading precedes measurement.', 'Mode-triggered first-frame latency includes animation-frame scheduling; frame CPU and completion waits are also reported separately.', 'Drawing pointer input is disabled during comparisons so hover changes cannot alter the measured scene; hover invalidation is covered by regression tests.', 'GPU fence wall waits include driver/CPU scheduling and exclude final desktop presentation.', 'Canvas readback completion is not a pure GPU timer.', 'GPU memory is uploaded buffer bytes only; JS heap is approximate and shared with the whole application.', 'Edit/undo measures one immutable visible line with fixed style/count/order; other edits may still require full preparation, upload or complete-view Canvas fallback. Geometry and subrange-upload stages are CPU issuance, with successful-frame fence wall completion reported separately.'] };

/** Inspect only an owner-created, currently rendering context; missing proof remains Unknown. */
async function prototypeContext(page) {
  return page.evaluate(() => {
    const status = window.gpuPrototype.status();
    const proof = { state: status.device, rendered: status.rendered, unmaskedVendor: 'Unknown', unmaskedRenderer: 'Unknown' };
    if (status.device === 'ready' && status.rendered) {
      try {
        const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('[data-gpu-prototype="2d"]'));
        const gl = canvas?.getContext('webgl2');
        if (gl && !gl.isContextLost()) {
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          const text = (value) => typeof value === 'string' && value.trim() ? value.slice(0, 240) : 'Unknown';
          if (debug) {
            proof.unmaskedVendor = text(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL));
            proof.unmaskedRenderer = text(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL));
          }
        }
      } catch { /* Metadata does not replace the existing correctness gates. */ }
    }
    return proof;
  });
}
/** Observe the first frame caused by mode selection, including synchronous implementations. */
async function modeFrame(page, mode) {
  return page.evaluate(async (next) => {
    const api = window.gpuPrototype, v = window.editor.viewport;
    const originalRender = v.render;
    let resolveFrame, rejectFrame, timer;
    const observed = new Promise((resolve, reject) => { resolveFrame = resolve; rejectFrame = reject; });
    v.render = /** @this {any} */ function (overlay) {
      try { originalRender.call(this, overlay); resolveFrame(api.renderStats()); }
      catch (error) { rejectFrame(error); throw error; }
    };
    try {
      timer = setTimeout(() => rejectFrame(new Error('Mode-triggered comparison frame did not arrive within 10 seconds')), 10000);
      api.setMode(next);
      const status = /** @type {any} */ (await observed);
      if (next === 'canvas' && status.rendered) throw new Error('Canvas comparison unexpectedly rendered through GPU');
      if (status.rendered) {
        const completion = await api.completed();
        if (!(typeof completion === 'number' && Number.isFinite(completion) && completion >= 0)) throw new Error('Comparison GPU completion was not observed (timeout or context loss)');
      } else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
      return status;
    } finally { clearTimeout(timer); v.render = originalRender; }
  }, mode);
}
// Compare geometric coverage with a two-pixel rasterization allowance. Pixelmatch
// still reports color/AA differences; coverage does not pretend they are equivalent.
function missedForeground(a, b) {
  const foreground = (image, x, y) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
    const i = (y * image.width + x) * 4;
    return Math.hypot(image.data[i] - 33, image.data[i + 1] - 40, image.data[i + 2] - 48) > 30;
  };
  let count = 0, missing = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    if (!foreground(a, x, y)) continue;
    count++;
    let found = false;
    for (let dy = -2; dy <= 2 && !found; dy++) for (let dx = -2; dx <= 2; dx++) if (foreground(b, x + dx, y + dy)) { found = true; break; }
    if (!found) missing++;
  }
  return count ? missing / count : 0;
}
function changedRgbaPixels(a, b) {
  assert.equal(a.width, b.width); assert.equal(a.height, b.height);
  let changed = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    if (a.data[index] !== b.data[index] || a.data[index + 1] !== b.data[index + 1] || a.data[index + 2] !== b.data[index + 2] || a.data[index + 3] !== b.data[index + 3]) changed++;
  }
  return changed;
}

/** Animation cadence supplement, before any benchmark drawing-context readback.
 * These CPU/rAF observations are not completion or desktop presentation timers.
 */
async function noReadbackCadence(page) {
  return page.evaluate(async () => {
    const ed = window.editor, api = window.gpuPrototype, v = ed.viewport;
    const ctx = /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d');
    const originalReadback = ctx.getImageData, hadOwnReadback = Object.hasOwn(ctx, 'getImageData');
    let readbackCalls = 0;
    ctx.getImageData = () => { readbackCalls++; throw new Error('Drawing getImageData is prohibited during no-readback cadence measurement'); };
    const summarize = (values) => {
      const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
      return { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)] ?? null, p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null, max: sorted.at(-1) ?? null };
    };
    const camera = () => ({ center: { ...v.center }, scale: v.scale, twist: v.twist });
    const evidence = { outcome: 'started', beforeAnyBenchmarkReadback: true, drawingGetImageDataCalls: 0, canvasBackend: 'Unknown', contextAttributesBefore: ctx.getContextAttributes(), contextAttributesAfter: null, samplesPerWorkflow: 30, comparisons: {}, semantics: 'CPU mutation/render and consecutive rAF-boundary cadence only; no getImageData, screenshot, toDataURL, GPU fence or completion observation during this phase. Shared fresh drawing context; AB/BA order is balanced across workflows and caches are retained.', rendererResourcesReset: false };
    const stages = ['cacheLookupMs', 'geometryPreparationMs', 'partialPreparationMs', 'initializationMs', 'uploadMs', 'subrangeUploadMs', 'drawSubmissionMs'];
    const counters = ['bytes', 'uploadCalls', 'subrangeUploadBytes', 'subrangeUploadCalls', 'preparedEntities', 'reusedEntities', 'editHistoryBytes', 'editHistoryEntries'];
    const frameTelemetry = (status, mode, expectedGPU, fallbackReason, poseDependentBudget) => {
      if (mode === 'gpu' && !poseDependentBudget && status.rendered !== expectedGPU) throw new Error(`No-readback scene admission differs from its explicit classification; expectedGPU=${expectedGPU}, reason=${status.reason}`);
      if (mode === 'gpu' && !status.rendered && fallbackReason && !status.reason?.includes(fallbackReason)) throw new Error(`No-readback refused scene must record its expected safety reason: ${status.reason}`);
      if (mode === 'canvas' && status.rendered) throw new Error('No-readback Canvas mode unexpectedly used GPU');
      if (status.rendered && !(status.cacheMinRatio > 0 && status.cacheMinRatio <= 1 && Number.isFinite(status.cacheMinRatio) && status.cacheMaxRatio >= 1 && Number.isFinite(status.cacheMaxRatio))) throw new Error('No-readback GPU frame is missing its actual certified zoom interval');
      if (status.rendered) for (const key of [...stages, ...counters]) if (!(typeof status[key] === 'number' && Number.isFinite(status[key]) && status[key] >= 0)) throw new Error(`No-readback GPU telemetry ${key} is missing/invalid`);
      if (mode === 'gpu' && !status.rendered && (status.bytes !== 0 || status.uploadCalls !== 0)) throw new Error('No-readback budget refusal must preserve complete Canvas before GL uploads');
      const admissionPolicyDeferred = mode === 'gpu' && status.cacheReason === 'admission-deferred';
      if (admissionPolicyDeferred && (status.rendered || status.geometryPreparationMs !== 0 || status.partialPreparationMs !== 0 || status.bytes !== 0 || status.uploadCalls !== 0 || !status.reason?.includes('Stroke geometry exceeds prototype budget'))) throw new Error('Deferred admission must explain its prior budget refusal, with complete Canvas and no current geometry preparation/uploads');
      const available = (key) => {
        if (status[key] === undefined || status[key] === null) return null;
        if (!(typeof status[key] === 'number' && Number.isFinite(status[key]) && status[key] >= 0)) throw new Error(`No-readback attempted GPU telemetry ${key} is invalid`);
        return status[key];
      };
      return { actualRenderer: status.rendered ? 'gpu' : 'canvas', reason: status.reason ?? null, gpuAttempt: mode === 'gpu' ? { rendered: status.rendered, reason: status.reason ?? null, admissionPolicyDeferred, admissionEvidence: admissionPolicyDeferred ? 'Deferred policy based on a prior slow budget refusal; current geometry not evaluated' : status.rendered ? 'Current GPU scene admitted' : status.cacheReason === 'refusal-hit' ? 'Exact-view certified prior geometry refusal' : 'Actual refused attempt at this pose; reported reason retained', ...Object.fromEntries([...stages, ...counters].map((key) => [key, available(key)])), requestedUploadBytes: available('bytes'), cacheHit: status.cacheHit, cacheReason: status.cacheReason, uploadKind: status.uploadKind, editMemoHit: status.editMemoHit, cacheMinRatio: available('cacheMinRatio'), cacheMaxRatio: available('cacheMaxRatio') } : null };
    };
    const firstModeFrame = async (mode, expectedGPU, fallbackReason, poseDependentBudget) => {
      const original = v.render;
      let timer, resolveFrame, rejectFrame;
      const observed = new Promise((resolve, reject) => { resolveFrame = resolve; rejectFrame = reject; });
      v.render = /** @this {any} */ function (overlay) {
        const started = performance.now();
        try { original.call(this, overlay); resolveFrame({ viewportRenderCpuMs: performance.now() - started, ...frameTelemetry(api.renderStats(), mode, expectedGPU, fallbackReason, poseDependentBudget) }); }
        catch (error) { rejectFrame(error); throw error; }
      };
      try {
        timer = setTimeout(() => rejectFrame(new Error('No-readback mode-triggered frame timed out')), 10000);
        api.setMode(mode);
        return /** @type {any} */ (await observed);
      } finally { clearTimeout(timer); v.render = original; }
    };
    const measure = async (mode, motion, initial, expectedGPU, fallbackReason, poseDependentBudget, fixture) => {
      v.center = { ...initial.center }; v.scale = initial.scale; v.twist = initial.twist;
      const baseline = JSON.stringify(ed.doc.snapshot), firstFrame = await firstModeFrame(mode, expectedGPU, fallbackReason, poseDependentBudget);
      const editCandidate = /** @type {any} */ (window).__gpuBenchmarkLineEdit(ed.doc.snapshot, v, fixture);
      const line = editCandidate.original, edited = editCandidate.edited;
      const frames = [];
      await new Promise((resolve, reject) => {
        let previousTimestamp = null, pending = null, index = 0;
        const callback = (timestamp) => {
          try {
            const boundaryNow = performance.now();
            if (pending) {
              pending.observedNextRafBoundaryWallMs = boundaryNow - pending.workflowStarted;
              frames.push(pending); pending = null;
            }
            if (index === 30) { resolve(undefined); return; }
            const i = index++, started = performance.now(), before = ed.doc.snapshot;
            let documentMutationMs = 0, cameraUpdateMs = 0, action = motion;
            if (motion === 'edit-undo') {
              const mutationStart = performance.now();
              if (i % 2) { if (!ed.doc.undo()) throw new Error('No-readback edit cannot undo'); action = 'undo-line-edit'; }
              else { ed.doc.replaceEntities([edited]); action = 'edit-visible-line'; }
              documentMutationMs = performance.now() - mutationStart;
            } else {
              const cameraStart = performance.now();
              if (motion === 'pan') v.panByPixels(i % 2 ? -2 : 2, i % 2 ? -1 : 1);
              if (motion === 'bounded-zoom') v.zoomAt({ x: v.width / 2, y: v.height / 2 }, initial.scale * (1 + 0.1 * (i + 1) / 30) / v.scale);
              if (motion === 'sustained-zoom') v.zoomAt({ x: v.width / 2, y: v.height / 2 }, 1.02);
              cameraUpdateMs = performance.now() - cameraStart;
            }
            const renderStarted = performance.now(), status = api.renderNow(), renderEnded = performance.now();
            pending = { index: i, action, workflowStarted: started, viewportRenderCpuMs: renderEnded - renderStarted, documentMutationMs, cameraUpdateMs, workflowCpuMs: renderEnded - started, rafCallbackIntervalMs: previousTimestamp === null ? null : timestamp - previousTimestamp, observedNextRafBoundaryWallMs: null, camera: camera(), ...frameTelemetry(status, mode, expectedGPU, fallbackReason, poseDependentBudget) };
            previousTimestamp = timestamp;
            // State verification is outside the measured CPU span. The next-rAF
            // wall observation necessarily includes this harness bookkeeping.
            if (motion === 'edit-undo') {
              if (ed.doc.snapshot === before) throw new Error('No-readback edit/undo was a no-op');
              if (JSON.stringify(ed.doc.entities.find((entity) => entity.id === line.id)) !== JSON.stringify(i % 2 ? line : edited)) throw new Error('No-readback edit/undo did not change/restore the line');
            }
            requestAnimationFrame(callback);
          } catch (error) { reject(error); }
        };
        requestAnimationFrame(callback);
      });
      if (frames.length !== 30 || frames.some((frame) => !(typeof frame.observedNextRafBoundaryWallMs === 'number' && Number.isFinite(frame.observedNextRafBoundaryWallMs) && frame.observedNextRafBoundaryWallMs >= 0))) throw new Error('No-readback workflow must record all 30 finite next-boundary observations');
      if (frames.slice(1).some((frame) => !(typeof frame.rafCallbackIntervalMs === 'number' && Number.isFinite(frame.rafCallbackIntervalMs) && frame.rafCallbackIntervalMs >= 0))) throw new Error('No-readback workflow must record 29 finite consecutive callback intervals');
      if (JSON.stringify(ed.doc.snapshot) !== baseline) throw new Error('No-readback workflow did not restore its exact drawing snapshot');
      const terminalCamera = camera();
      const gpuContext = (() => {
        const proof = { state: api.status().device, unmaskedVendor: 'Unknown', unmaskedRenderer: 'Unknown' };
        if (mode !== 'gpu' || !api.status().rendered || api.status().device !== 'ready') return proof;
        const gl = /** @type {HTMLCanvasElement} */ (document.querySelector('[data-gpu-prototype="2d"]')).getContext('webgl2');
        const debug = gl?.getExtension('WEBGL_debug_renderer_info');
        if (debug && !gl.isContextLost()) { proof.unmaskedVendor = gl.getParameter(debug.UNMASKED_VENDOR_WEBGL); proof.unmaskedRenderer = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL); }
        return proof;
      })();
      v.center = { ...initial.center }; v.scale = initial.scale; v.twist = initial.twist; api.renderNow();
      const summary = Object.fromEntries(['viewportRenderCpuMs', 'documentMutationMs', 'cameraUpdateMs', 'workflowCpuMs', 'rafCallbackIntervalMs', 'observedNextRafBoundaryWallMs'].map((key) => [key, summarize(frames.map((frame) => frame[key]))]));
      const byActualRenderer = Object.fromEntries(['gpu', 'canvas'].map((renderer) => [renderer, Object.fromEntries(['viewportRenderCpuMs', 'documentMutationMs', 'cameraUpdateMs', 'workflowCpuMs', 'rafCallbackIntervalMs', 'observedNextRafBoundaryWallMs'].map((key) => [key, summarize(frames.filter((frame) => frame.actualRenderer === renderer).map((frame) => frame[key]))]))]));
      const gpuStages = Object.fromEntries([...stages, ...counters].map((key) => [key, summarize(frames.filter((frame) => frame.actualRenderer === 'gpu').map((frame) => frame.gpuAttempt[key]))]));
      const gpuAttemptStages = Object.fromEntries([...stages, ...counters].map((key) => [key, summarize(frames.map((frame) => frame.gpuAttempt?.[key]))]));
      const uploadKinds = frames.filter((frame) => frame.actualRenderer === 'gpu').reduce((counts, frame) => { const kind = frame.gpuAttempt.uploadKind; counts[kind] = (counts[kind] ?? 0) + 1; return counts; }, {});
      const attempts = frames.filter((frame) => frame.gpuAttempt), refused = attempts.filter((frame) => !frame.gpuAttempt.rendered);
      const refusedAttemptStages = Object.fromEntries([...stages, ...counters].map((key) => [key, summarize(refused.map((frame) => frame.gpuAttempt[key]))]));
      return { requestedMode: mode, expectedSupportsGPU: expectedGPU, poseDependentBudgetAdmission: poseDependentBudget, expectedFallbackReason: fallbackReason, aggregateRendererScope: poseDependentBudget && mode === 'gpu' ? 'Requested GPU with potentially mixed actual GPU/Canvas samples; byActualRenderer separates both' : `Requested ${mode}; actual renderer recorded per sample`, motion, firstModeTriggeredCpuFrame: firstFrame, frameSamples: frames, summary, byActualRenderer, gpuStages, gpuAttemptStages, successfulGpuIssuanceKinds: uploadKinds, refusedGpuAttempts: { count: refused.length, deferredPolicyFrames: refused.filter((frame) => frame.gpuAttempt.admissionPolicyDeferred).length, exactViewRefusalMemoFrames: refused.filter((frame) => frame.gpuAttempt.cacheReason === 'refusal-hit').length, actualPoseAttemptFrames: refused.filter((frame) => !frame.gpuAttempt.admissionPolicyDeferred && frame.gpuAttempt.cacheReason !== 'refusal-hit').length, stages: refusedAttemptStages, reasons: refused.reduce((counts, frame) => { const reason = frame.reason ?? 'missing'; counts[reason] = (counts[reason] ?? 0) + 1; return counts; }, {}) }, actualRendererCounts: frames.reduce((counts, frame) => { counts[frame.actualRenderer] = (counts[frame.actualRenderer] ?? 0) + 1; return counts; }, {}), initialCamera: initial, terminalCamera, snapshotRestored: true, visibleLineId: motion === 'edit-undo' ? line.id : null, topLevelLineEdit: motion === 'edit-undo' ? { sourceIndex: ed.doc.entities.indexOf(line), id: line.id, entityType: line.type, visibleLayer: true, original: line, edited, candidate: editCandidate, childTextOrInsertEdit: false } : null, gpuContext, completionObserved: false, presentationObserved: false };
    };
    try {
      for (const { name: fixture, expectedGPU, fallbackReason = null } of [{ name: 'dense-lines', expectedGPU: true }, { name: 'compound-tags', expectedGPU: true }, { name: 'compound-dense', expectedGPU: false, fallbackReason: 'Stroke geometry exceeds prototype budget' }]) {
        api.setMode('canvas'); api.loadFixture(fixture);
        const initial = camera(), baseline = JSON.stringify(ed.doc.snapshot), workflows = {};
        const state = ed.doc.snapshot, texts = state.entities.filter((entity) => entity.type === 'text');
        const counts = state.entities.reduce((counts, entity) => { counts[entity.type] = (counts[entity.type] ?? 0) + 1; return counts; }, {});
        const usedBlockNames = [...new Set(state.entities.filter((entity) => entity.type === 'insert').map((insert) => insert.block))].sort();
        const description = { entityCount: state.entities.length, counts, referencedBlockNames: usedBlockNames, blocks: usedBlockNames.map((name) => ({ name, childTypes: state.blocks[name]?.entities.map((entity) => entity.type), attributeCount: state.blocks[name]?.attributes.length })), topLevelTextStrings: texts.map((entity) => entity.text), topLevelTextCharacters: texts.reduce((total, entity) => total + entity.text.length, 0), expandedAttributeCount: state.entities.filter((entity) => entity.type === 'insert').reduce((total, insert) => total + (state.blocks[insert.block]?.attributes.length ?? 0), 0), textPixels: texts.map((entity) => entity.height * v.scale), attributePixels: usedBlockNames.flatMap((name) => state.blocks[name]?.attributes.map((attribute) => attribute.height * v.scale) ?? []) };
        if (fixture !== 'dense-lines') {
          const expectedBlock = fixture === 'compound-tags' ? 'GPU-TAGS-SYM' : 'GPU-DENSE-SYM';
          if (description.entityCount !== 6500 || counts.line !== 5000 || counts.insert !== 1000 || counts.text !== 500 || description.expandedAttributeCount !== 1000) throw new Error('No-readback compound stress fixture lost its exact 6500 entity/1000 attribute shape');
          if (JSON.stringify(description.referencedBlockNames) !== JSON.stringify([expectedBlock]) || JSON.stringify(description.blocks) !== JSON.stringify([{ name: expectedBlock, childTypes: ['line', 'line', 'line', 'line'], attributeCount: 1 }])) throw new Error('No-readback compound stress fixture differs from its actually referenced straight-stroke block shape');
          if (texts.some((entity, index) => entity.text !== (fixture === 'compound-tags' ? `T${index}` : `LABEL ${index} MOTOR STARTER`))) throw new Error('No-readback compound stress fixture label data differs from its explicit short-tag/long-label input');
          if (![...description.textPixels, ...description.attributePixels].every((pixels) => pixels * 0.8 > 2.5)) throw new Error('No-readback compound stress glyphs must stay above QTEXT in the admitted band');
        }
        for (const [index, motion] of ['pan', 'bounded-zoom', 'sustained-zoom', 'edit-undo'].entries()) {
          const modeOrder = index % 2 ? ['gpu', 'canvas'] : ['canvas', 'gpu'], pair = { modeOrder, canvas: null, gpu: null };
          for (const mode of modeOrder) pair[mode] = await measure(mode, motion, initial, expectedGPU, fallbackReason, fixture === 'compound-dense', fixture);
          if (motion === 'edit-undo' && expectedGPU) {
            for (const frame of pair.gpu.frameSamples) {
              const attempt = frame.gpuAttempt;
              if (attempt.cacheReason !== 'document-delta' || attempt.uploadKind !== 'subrange' || attempt.bytes !== 168 || attempt.uploadCalls !== 1 || attempt.subrangeUploadBytes !== 168 || attempt.subrangeUploadCalls !== 1 || attempt.preparedEntities > 1) throw new Error('No-readback admitted top-level LINE edit must retain its six-vertex slot and issue exactly168bytes/one upload');
            }
          }
          if (JSON.stringify(ed.doc.snapshot) !== baseline) throw new Error('No-readback paired workflows changed the drawing');
          if (JSON.stringify(pair.canvas.terminalCamera) !== JSON.stringify(pair.gpu.terminalCamera)) throw new Error('No-readback paired workflows ended on different cameras');
          for (let frame = 0; frame < 30; frame++) if (JSON.stringify(pair.canvas.frameSamples[frame].camera) !== JSON.stringify(pair.gpu.frameSamples[frame].camera)) throw new Error(`No-readback ${motion} paired sample${frame} used different cameras`);
          workflows[motion] = pair;
        }
        evidence.comparisons[fixture] = { workflows, description, expectedSupportsGPU: expectedGPU, poseDependentBudgetAdmission: fixture === 'compound-dense', expectedFallbackReason: fallbackReason, performanceCategory: expectedGPU ? 'Requested GPU admitted: CPU and cadence observations, no completion claim' : 'Baseline budget refusal with pose-dependent admission: per-frame GPU, full Canvas and deferred policy are separate; requested-mode aggregates may mix actual renderers', samePairedSnapshotAndCamera: true, snapshotRestored: true };
      }
      if (readbackCalls !== 0) throw new Error(`No-readback phase attempted ${readbackCalls} drawing-context reads`);
      evidence.outcome = 'passed';
      return evidence;
    } finally {
      evidence.drawingGetImageDataCalls = readbackCalls;
      evidence.contextAttributesAfter = ctx.getContextAttributes();
      if (hadOwnReadback) ctx.getImageData = originalReadback;
      else delete ctx.getImageData;
    }
  });
}
let benchmarkPage = null, activeFixture = null;
try {
  result.scope = await app.evaluate(({ app }, expected) => {
    const path = process.getBuiltinModule('node:path');
    if (path.resolve(app.getPath('userData')).toLowerCase() !== path.resolve(expected).toLowerCase()) throw new Error('Private benchmark profile could not be verified');
    return { privateProfileVerified: true, highPerformanceSwitchPresent: app.commandLine.hasSwitch('force_high_performance_gpu') };
  }, profile);
  assert.equal(result.scope.highPerformanceSwitchPresent, highPerformance, 'Private app GPU preference switch must match the requested CLI mode');
  const page = await applicationWindow(app);
  benchmarkPage = page;
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.waitForFunction(() => !!window.editor && !!window.gpuPrototype);
  result.applicationLaunchMs = performance.now() - started;
  await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('jcad://app/')); win.setSize(1500, 940); });
  await page.waitForTimeout(300);
  for (let attempt = 0; attempt < 20; attempt++) {
    result.hardware = await page.evaluate(() => window.jcad.gpuDiagnostics());
    if (result.hardware.state !== 'pending') break;
    await page.waitForTimeout(300);
  }
  if (result.hardware.state !== 'ready') result.limitations.push(`Hardware diagnostic collection: ${result.hardware.state}; adapter/acceleration conclusions are limited.`);
  result.viewport = await page.evaluate(() => { const v = window.editor.viewport; return { width: v.width, height: v.height, dpr: v.dpr }; });
  // A visible Windows window can receive rollover events during screenshot capture.
  // Hold the comparison scene constant; interactive selection/demo checks follow separately.
  await page.addStyleTag({ content: '[data-gpu-prototype="indicator"] { visibility:hidden !important } #drawing { pointer-events:none !important }' });
  await page.mouse.move(0, 0);
  await page.evaluate(() => window.editor.setHover(null));
  // One geometry-only selector runs before the fresh phase. Freeze its first ID
  // per fixture so later pixel evidence cannot replace an already measured edit.
  await page.evaluate(`(() => { const choose = ${chooseBenchmarkLineEdit.toString()}; const ids = new Map(); window.__gpuBenchmarkLineEdit = (state, view, fixture) => { const candidate = choose(state, view, ids.get(fixture) ?? null); if (!ids.has(fixture)) ids.set(fixture, candidate.original.id); return candidate; }; })();`);
  activeFixture = 'fresh-profile-no-readback-cadence';
  const cadenceContextBefore = await prototypeContext(page);
  const cadenceEvidence = await noReadbackCadence(page);
  Object.assign(cadenceEvidence, { graphicsDiagnosticsBefore: result.hardware, graphicsDiagnosticsAfter: await page.evaluate(() => window.jcad.gpuDiagnostics()), prototypeContextBefore: cadenceContextBefore, prototypeContextAfter: await prototypeContext(page), nextBoundaryIncludesHarnessBookkeeping: true });
  Object.assign(result, { noReadbackCadence: cadenceEvidence });
  result.limitations.push('The legacy completed-frame dataset performs a Canvas getImageData read every sample. Chromium may change acceleration after repeated implicit readback; the separate fresh-profile no-readback cadence dataset runs first and does not prove completion, presentation or the current Canvas backend. Both modes share the fresh drawing context and retained caches; AB/BA order is balanced across workloads.');
  const canvasSelfConsistency = [];
  Object.assign(result, { canvasSelfConsistency });
  const stableCanvasReference = async (label, path) => {
    const state = () => page.evaluate(() => { const v = window.editor.viewport, ctx = /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d'); return { document: JSON.stringify(window.editor.doc.snapshot), camera: { center: { ...v.center }, scale: v.scale, twist: v.twist }, width: v.width, height: v.height, dpr: v.dpr, contextAttributes: ctx.getContextAttributes(), alpha: ctx.globalAlpha, composite: ctx.globalCompositeOperation }; });
    const baseline = await state(), evidence = { label, untimed: true, maximumCaptures: 4, samples: [], outcome: 'started', rendererResourcesReset: false, canvasSceneDiscarded: false, backendCause: 'Unproven' };
    canvasSelfConsistency.push(evidence);
    let previousScreen = null, previousRaw = null;
    for (let attempt = 0; attempt < evidence.maximumCaptures; attempt++) {
      const frame = await modeFrame(page, 'canvas');
      const capturePath = resolve(out, `${label}-canvas-self-${attempt}.png`);
      await page.locator('#drawing').screenshot({ path: capturePath });
      const screen = PNG.sync.read(readFileSync(capturePath));
      const rawDataUrl = await page.evaluate(() => /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).toDataURL('image/png'));
      const raw = PNG.sync.read(Buffer.from(rawDataUrl.split(',')[1], 'base64'));
      const current = await state();
      assert.deepEqual(current, baseline, `${label}: Canvas self-consistency retains the exact snapshot/camera/context state`);
      const difference = (a, b) => {
        if (!a) return null;
        let maxChannelDifference = 0;
        for (let index = 0; index < a.data.length; index++) maxChannelDifference = Math.max(maxChannelDifference, Math.abs(a.data[index] - b.data[index]));
        return { rawDifferentPixels: changedRgbaPixels(a, b), maxChannelDifference };
      };
      const screenshotDifference = difference(previousScreen, screen), canvasReadbackDifference = difference(previousRaw, raw);
      evidence.samples.push({ attempt, capturePath, frame, screenshotDifference, canvasReadbackDifference, camera: current.camera, contextAttributes: current.contextAttributes });
      if (screenshotDifference?.rawDifferentPixels === 0 && canvasReadbackDifference?.rawDifferentPixels === 0) {
        evidence.outcome = 'passed';
        Object.assign(evidence, { acceptedCapture: attempt, identicalConsecutiveCanvasCaptures: true, documentUnchanged: true, cameraUnchanged: true });
        writeFileSync(path, PNG.sync.write(screen));
        return { frame, image: screen, evidence };
      }
      previousScreen = screen; previousRaw = raw;
    }
    evidence.outcome = 'failed';
    assert.fail(`${label}: Canvas reference did not become self-consistent within ${evidence.maximumCaptures} explicitly recorded captures`);
  };
  const fixtures = [
    ...['curves', 'precision', 'precision-trillion', 'lineweights'].map((name) => ({ name, supportsGPU: false, supportsDeltas: false, fallbackReason: 'Unsupported Canvas stroke construction: native float arc connection is unproved' })),
    { name: 'dense-lines', supportsGPU: true },
    // Historical 6,500-entity input retains its tiny PERF_SYM circle. Its fitted
    // radius is inside the stroke/precision margin, so the whole view uses Canvas.
    { name: 'mixed-schematic', supportsGPU: false, supportsDeltas: false, fallbackReason: 'Curve stroke overlap or precision margin requires Canvas rendering' },
    { name: 'wide-curve-fallback', supportsGPU: false },
    ...['curve-control', 'precision-control', 'lineweights-control'].map((name) => ({ name, supportsGPU: false, supportsDeltas: false, fallbackReason: 'Unsupported Canvas stroke construction: native float arc connection is unproved' })),
    { name: 'direct-arc-control', supportsGPU: true },
    { name: 'direct-arc-precision-control', supportsGPU: true },
    { name: 'direct-arc-lineweights-control', supportsGPU: true },
    { name: 'arc-full-huge', supportsGPU: true },
    { name: 'arc-sweep-fallback', supportsGPU: false, fallbackReason: 'Unsupported Canvas ARC sweep beyond one revolution' },
    { name: 'arc-angle-fallback', supportsGPU: false, fallbackReason: 'Unsupported Canvas ARC angular precision range' },
    ...['polyline', 'text', 'attrib'].map((kind) => ({ name: `collapse-${kind}-fallback`, supportsGPU: false, supportsDeltas: false, fallbackReason: 'Unsupported Canvas stroke construction:' })),
    ...['direct', 'compound'].map((kind) => ({ name: `negative-bulge-${kind}-fallback`, supportsGPU: false, supportsDeltas: false, fallbackReason: 'Unsupported Canvas stroke construction: negative bulge has native connector' })),
    { name: 'positive-bulge-precision-fallback', supportsGPU: false, supportsDeltas: false, fallbackReason: 'Unsupported Canvas stroke construction: native float arc connection is unproved' },
    { name: 'compound-dense', supportsGPU: false, supportsDeltas: false, fallbackReason: 'Stroke geometry exceeds prototype budget' },
    { name: 'compound-tags', supportsGPU: true, supportsDeltas: true },
    { name: 'compound-ordered', supportsGPU: true, supportsDeltas: true },
    { name: 'compound-trillion-reference', supportsGPU: true, supportsDeltas: true },
    // Canvas's absolute glyph/block offsets may quantize at this origin; preserve
    // complete Canvas until parity is proved rather than relaxing the image gate.
    { name: 'compound-trillion', supportsGPU: false, supportsDeltas: false },
    ...['ttf', 'mtext', 'dash', 'alpha', 'geometry'].map((kind) => ({ name: `compound-fallback-${kind}`, supportsGPU: false, supportsDeltas: false })),
  ];
  const nativeRotationReason = 'Unsupported Canvas stroke construction: native context rotation is unproved';
  const describeFixture = () => page.evaluate(() => {
    const state = window.editor.doc.snapshot, scale = window.editor.viewport.scale;
    const counts = state.entities.reduce((counts, entity) => { counts[entity.type] = (counts[entity.type] ?? 0) + 1; return counts; }, {});
    const pending = state.entities.filter((entity) => entity.type === 'insert').map((insert) => insert.block), referenced = new Set();
    for (let index = 0; index < pending.length; index++) {
      const name = pending[index];
      if (referenced.has(name)) continue;
      referenced.add(name);
      const block = state.blocks[name];
      if (block) for (const entity of block.entities) if (entity.type === 'insert') pending.push(entity.block);
    }
    // loadState supplies unused ElectricalCatalog definitions. Preserve them in
    // the document; scene/setup proof describes only actually referenced blocks.
    const referencedBlockNames = [...referenced].sort();
    const usedBlocks = referencedBlockNames.map((name) => state.blocks[name]).filter(Boolean);
    const topLevelTextStrings = state.entities.filter((entity) => entity.type === 'text').map((entity) => entity.text);
    return { entityCount: state.entities.length, counts, metadata: window.gpuPrototype.fixtureMetadata(), catalogBlockCount: Object.keys(state.blocks).length, referencedBlockNames,
      blocks: referencedBlockNames.map((name) => state.blocks[name] ? { name, childTypes: state.blocks[name].entities.map((entity) => entity.type), attributeCount: state.blocks[name].attributes.length } : { name, missing: true, childTypes: [], attributeCount: 0 }),
      topLevelTextStrings, topLevelTextCharacters: topLevelTextStrings.reduce((total, text) => total + text.length, 0), expandedAttributeCount: state.entities.filter((entity) => entity.type === 'insert').reduce((total, insert) => total + (state.blocks[insert.block]?.attributes.length ?? 0), 0),
      textPixels: state.entities.filter((entity) => entity.type === 'text').map((entity) => entity.height * scale), attributePixels: usedBlocks.flatMap((block) => block.attributes.map((attribute) => attribute.height * scale)) };
  });
  const assertFixtureSetup = (name, description) => {
    if (name.startsWith('direct-arc-') && name.endsWith('-control')) {
      assert.equal(description.entityCount, name === 'direct-arc-lineweights-control' ? 4 : 3);
      assert.deepEqual(description.counts, { line: name === 'direct-arc-lineweights-control' ? 2 : 1, circle: 1, arc: 1 });
      assert.equal(description.metadata.controlArc.id, 'A');
      assert.equal(description.metadata.controlArc.initialMoveTo, false);
      assert.equal(description.metadata.controlPolyline, undefined);
      return;
    }
    if (name.endsWith('-control')) {
      assert.equal(description.entityCount, name === 'lineweights-control' ? 5 : 4);
      assert.deepEqual(description.counts, { line: name === 'lineweights-control' ? 2 : 1, circle: 1, arc: 1, polyline: 1 });
      assert.equal(description.metadata.controlPolyline.points.length, 2, 'Distinct curve control contains one isolated curved segment');
      assert.ok(description.metadata.controlPolyline.bulge > 0);
      return;
    }
    if (name !== 'compound-dense' && name !== 'compound-tags') return;
    const blockName = name === 'compound-tags' ? 'GPU-TAGS-SYM' : 'GPU-DENSE-SYM';
    assert.equal(description.entityCount, 6500);
    assert.deepEqual(description.counts, { line: 5000, insert: 1000, text: 500 });
    assert.deepEqual(description.referencedBlockNames, [blockName]);
    assert.deepEqual(description.blocks, [{ name: blockName, childTypes: ['line', 'line', 'line', 'line'], attributeCount: 1 }]);
    assert.equal(description.expandedAttributeCount, 1000);
    assert.deepEqual(description.topLevelTextStrings, Array.from({ length: 500 }, (_, index) => name === 'compound-tags' ? `T${index}` : `LABEL ${index} MOTOR STARTER`), `${name}: exact label data distinguishes short-tag stress input from preserved long-label budget input`);
    assert.equal(description.topLevelTextCharacters, description.topLevelTextStrings.reduce((total, text) => total + text.length, 0));
    assert.ok([...description.textPixels, ...description.attributePixels].every((pixels) => pixels * 0.8 > 2.5), 'Distinct dense compound glyphs remain readable inside the admitted minimum zoom band');
  };
  // Justin's exact selected sharp-corner case: preserve the original input and
  // prove reliable full Canvas resolution without claiming a refined GPU bound.
  activeFixture = 'exact-selected-sharp-join-priority';
  const sharpJoinPriority = { outcome: 'started', untimedCorrectnessProbe: true, fixture: 'curves', originalFixtureChanged: false, resolution: null, canvasSelfConsistency: null, nativeCommands: [], cleanup: null, assessedRefinementRoute: { status: 'Read-only assessment; no GPU implementation or native bound validated', smoothReservePhysicalPixels: 0.0625, joinReservePhysicalPixels: 0.0625, existingTotalCurveReservePhysicalPixels: 0.125, unchangedTolerancePhysicalPixels: 0.25, nativeGpuFixClaimed: false } };
  Object.assign(result, { sharpJoinPriority });
  await page.evaluate(() => {
    const ed = window.editor, v = ed.viewport, api = window.gpuPrototype, g = /** @type {any} */ (window);
    g.__sharpJoinPrioritySaved = { snapshot: ed.doc.snapshot, document: JSON.stringify(ed.doc.snapshot), history: ed.doc.history(), filePath: ed.doc.filePath, dirty: ed.doc.dirty, color: ed.doc.currentColor, selection: [...ed.selection], hover: /** @type {any} */ (v).lastOverlay?.hover ?? null, camera: { center: { ...v.center }, scale: v.scale, twist: v.twist }, settings: { ...v.settings }, mode: api.status().mode, metadata: api.fixtureMetadata() };
    api.setMode('canvas'); api.loadFixture('curves'); ed.selection.clear(); ed.selection.add('P'); ed.setHover(null);
    v.center = { x: 3.5, y: 2.5 }; v.scale = 95.17241379310344; v.twist = 0; v.settings.selectionEffect = 'solid';
    const proto = CanvasRenderingContext2D.prototype, methods = ['beginPath', 'moveTo', 'lineTo', 'arc', 'stroke'], originals = {};
    g.__sharpJoinPriorityCommands = { originals, commands: [], strokes: [] };
    for (const method of methods) {
      const original = proto[method]; originals[method] = original;
      proto[method] = /** @this {CanvasRenderingContext2D} */ function (...args) {
        if (this.canvas === document.getElementById('drawing')) {
          const probe = g.__sharpJoinPriorityCommands;
          if (method === 'beginPath') probe.commands = [];
          else if (method === 'stroke') {
            const transform = this.getTransform();
            probe.strokes.push({ commands: probe.commands.map((command) => ({ method: command.method, args: [...command.args] })), color: this.strokeStyle, lineWidth: this.lineWidth, miterLimit: this.miterLimit, lineJoin: this.lineJoin, lineCap: this.lineCap, alpha: this.globalAlpha, contextTransform: { a: transform.a, b: transform.b, c: transform.c, d: transform.d, e: transform.e, f: transform.f } });
          } else probe.commands.push({ method, args: [...args] });
        }
        return Reflect.apply(original, this, args);
      };
    }
  });
  try {
    const exactInput = await page.evaluate(() => {
      const ed = window.editor, v = ed.viewport;
      return { document: JSON.stringify(ed.doc.snapshot), entities: ed.doc.entities, selected: [...ed.selection], selectionEffect: v.settings.selectionEffect, camera: { center: { ...v.center }, scale: v.scale, twist: v.twist, dpr: v.dpr }, width: v.width, height: v.height };
    });
    assert.deepEqual(exactInput.camera, { center: { x: 3.5, y: 2.5 }, scale: 95.17241379310344, twist: 0, dpr: 1 });
    assert.deepEqual(exactInput.selected, ['P']); assert.equal(exactInput.selectionEffect, 'solid');
    assert.equal(exactInput.entities.length, 4);
    const selected = exactInput.entities.find((entity) => entity.id === 'P');
    assert.deepEqual(selected.points, [{ x: 0, y: 4 }, { x: 1, y: 5 }, { x: 2, y: 4 }]);
    assert.deepEqual(selected.bulges, [0.5, 0]);
    const reference = await stableCanvasReference('exact-selected-sharp-join-priority', resolve(out, 'exact-selected-sharp-join-priority-canvas.png'));
    sharpJoinPriority.canvasSelfConsistency = reference.evidence;
    const frame = await modeFrame(page, 'gpu');
    Object.assign(sharpJoinPriority, { gpuAttempt: frame, exactInput: { entities: exactInput.entities, selected: exactInput.selected, selectionEffect: exactInput.selectionEffect, camera: exactInput.camera, width: exactInput.width, height: exactInput.height } });
    assert.equal(frame.rendered, false);
    assert.notEqual(frame.cacheReason, 'admission-deferred', 'Exact priority case requires actual admission, not deferred policy');
    assert.ok(frame.reason?.startsWith('Unsupported Canvas stroke construction: native float arc connection is unproved'));
    assert.equal(frame.bytes, 0); assert.equal(frame.uploadCalls, 0); assert.equal(frame.subrangeUploadBytes, 0); assert.equal(frame.subrangeUploadCalls, 0);
    const path = resolve(out, 'exact-selected-sharp-join-priority-full-fallback.png');
    await page.locator('#drawing').screenshot({ path });
    const fallback = PNG.sync.read(readFileSync(path));
    assert.equal(fallback.width, reference.image.width); assert.equal(fallback.height, reference.image.height);
    assert.equal(Buffer.compare(reference.image.data, fallback.data), 0, 'Exact selected sharp-corner priority case resolves through identical complete-view Canvas RGBA');
    const native = await page.evaluate(() => /** @type {any} */ (window).__sharpJoinPriorityCommands.strokes);
    sharpJoinPriority.nativeCommands = native;
    const selectedStrokes = native.filter((stroke) => stroke.color === '#0000ff' && stroke.commands.some((command) => command.method === 'arc') && stroke.commands.some((command) => command.method === 'lineTo'));
    assert.ok(selectedStrokes.length >= 2, 'Actual selected Canvas ARC→LINE stroke is observed in reference and fallback frames');
    for (const stroke of selectedStrokes) {
      assert.deepEqual(stroke.commands.map((command) => command.method), ['moveTo', 'arc', 'lineTo']);
      assert.equal(stroke.lineWidth, 2.5); assert.equal(stroke.miterLimit, 10); assert.equal(stroke.lineJoin, 'miter'); assert.equal(stroke.lineCap, 'butt'); assert.equal(stroke.alpha, 0.95);
      assert.deepEqual(stroke.contextTransform, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    }
    assert.equal(await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot)), exactInput.document, 'Exact priority probe leaves the original fixture snapshot unchanged');
    Object.assign(sharpJoinPriority, { outcome: 'passed', resolution: 'Exact selected 2.5CSSpx/miter10 sharp-corner case closed through reliable complete Canvas fallback under the broader native ARC-connection guard; no accurate GPU fix claimed', rawDifferentPixels: changedRgbaPixels(reference.image, fallback), actualSelectedCanvasStrokes: selectedStrokes, zeroGpuUploads: true });
  } finally {
    sharpJoinPriority.cleanup = await page.evaluate(() => {
      const ed = window.editor, v = ed.viewport, api = window.gpuPrototype, g = /** @type {any} */ (window), saved = g.__sharpJoinPrioritySaved, probe = g.__sharpJoinPriorityCommands;
      if (probe) for (const method of Object.keys(probe.originals)) CanvasRenderingContext2D.prototype[method] = probe.originals[method];
      api.setMode('canvas');
      if (saved.metadata?.name) api.loadFixture(saved.metadata.name);
      ed.doc.load(saved.snapshot, saved.filePath); ed.doc.restoreHistory(saved.history); ed.doc.dirty = saved.dirty; ed.doc.currentColor = saved.color;
      for (const key of Object.keys(v.settings)) if (!Object.hasOwn(saved.settings, key)) delete v.settings[key];
      Object.assign(v.settings, saved.settings); v.center = saved.camera.center; v.scale = saved.camera.scale; v.twist = saved.camera.twist;
      ed.selection.clear(); for (const id of saved.selection) ed.selection.add(id); ed.setHover(saved.hover); api.setMode(saved.mode); api.renderNow();
      const restored = { snapshotRestored: JSON.stringify(ed.doc.snapshot) === saved.document, selectionRestored: JSON.stringify([...ed.selection]) === JSON.stringify(saved.selection), cameraRestored: JSON.stringify({ center: { ...v.center }, scale: v.scale, twist: v.twist }) === JSON.stringify(saved.camera), settingsRestored: JSON.stringify(v.settings) === JSON.stringify(saved.settings), historyRestored: JSON.stringify(ed.doc.history()) === JSON.stringify(saved.history), modeRestored: api.status().mode === saved.mode };
      delete g.__sharpJoinPrioritySaved; delete g.__sharpJoinPriorityCommands;
      return restored;
    });
    assert.ok(Object.values(sharpJoinPriority.cleanup).every((restored) => restored === true), 'Exact priority probe restores snapshot/selection/camera/history/mode');
  }
  writeFileSync(resolve(out, 'sharp-join-priority.json'), JSON.stringify({ sourceSha, worktreeModified, overallBenchmark: 'pending', ...sharpJoinPriority }, null, 2));
  console.log(JSON.stringify({ milestone: 'exact-selected-sharp-join', sourceSha, scope: 'Native correctness probe only; overall benchmark pending', outcome: sharpJoinPriority.outcome, resolution: sharpJoinPriority.resolution }));
  const wideConnection = { outcome: 'started', untimedCorrectnessProbe: true, fixture: 'positive-bulge-native-connection-fallback', requested: { width: 8192, height: 800, dpr: 1 }, explicitUntimedFramebufferAllocation: true, gpuGeometryAtSyntheticSizeClaimed: false, normalTimedDatasetDimensionsUnchanged: true, maximumCanvasCaptures: 4, samples: [], gpuAttempt: null, actualCommands: null, actualFramebuffer: null, cleanup: null };
  Object.assign(result, { wideNativeConnectionFallback: wideConnection });
  const wideCapacity = await page.evaluate(() => {
    const status = window.gpuPrototype.status(), canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('[data-gpu-prototype="2d"]'));
    if (status.device !== 'ready') return { available: false, reason: `Current owner device ${status.device}; synthetic framebuffer coverage unavailable` };
    const gl = canvas.getContext('webgl2');
    return { available: !!gl && !gl.isContextLost(), maxViewportDims: gl ? [...gl.getParameter(gl.MAX_VIEWPORT_DIMS)] : null, maxRenderbufferSize: gl?.getParameter(gl.MAX_RENDERBUFFER_SIZE), maxTextureSize: gl?.getParameter(gl.MAX_TEXTURE_SIZE) };
  });
  Object.assign(wideConnection, { capacity: wideCapacity });
  if (!wideCapacity.available || wideCapacity.maxViewportDims[0] < 8192 || wideCapacity.maxViewportDims[1] < 800 || wideCapacity.maxRenderbufferSize < 8192 || wideCapacity.maxTextureSize < 8192) {
    Object.assign(wideConnection, { outcome: 'not-run', reason: 'Actual live device limits do not prove an 8192x800 framebuffer; no hardware coverage claimed' });
  } else {
    try {
    await page.evaluate(() => {
      const ed = window.editor, v = ed.viewport, api = window.gpuPrototype, g = /** @type {any} */ (window), canvas = v.canvas, ctx = canvas.getContext('2d'), gpu = /** @type {HTMLCanvasElement} */ (document.querySelector('[data-gpu-prototype="2d"]'));
      g.__wideConnectionSaved = { snapshot: ed.doc.snapshot, document: JSON.stringify(ed.doc.snapshot), history: ed.doc.history(), filePath: ed.doc.filePath, dirty: ed.doc.dirty, color: ed.doc.currentColor, selection: [...ed.selection], hover: /** @type {any} */ (v).lastOverlay?.hover ?? null, camera: { center: { ...v.center }, scale: v.scale, twist: v.twist, width: v.width, height: v.height, dpr: v.dpr }, canvas: { width: canvas.width, height: canvas.height }, gpuCanvas: { width: gpu.width, height: gpu.height }, settings: { ...v.settings }, mode: api.status().mode, metadata: api.fixtureMetadata(), resize: v.resize };
      api.setMode('canvas'); api.loadFixture('positive-bulge-native-connection-fallback'); ed.selection.clear(); ed.setHover(null);
      // This private synthetic backing-store probe does not resize the app window
      // or alter any ordinary fixture/trajectory. Restore the real resize hook.
      v.resize = () => {}; v.width = 8192; v.height = 800; v.dpr = 1;
      canvas.width = 8192; canvas.height = 800; v.center = { x: 0, y: 0 }; v.scale = 1; v.twist = 0;
      // Admission refuses before production framebuffer resize. Allocate the
      // existing owner backing explicitly for this synthetic capacity check.
      gpu.width = 8192; gpu.height = 800;
      const gl = gpu.getContext('webgl2');
      if (gl.isContextLost() || gl.drawingBufferWidth !== 8192 || gl.drawingBufferHeight !== 800) throw new Error('Explicit synthetic GPU framebuffer allocation failed');
      v.settings.background = '#212830'; v.settings.gridVisible = false; v.settings.ucsIconVisible = false;
      const originalArc = ctx.arc, originalMove = ctx.moveTo, originalBegin = ctx.beginPath;
      g.__wideConnectionCommands = { originalArc, originalMove, originalBegin, ownArc: Object.hasOwn(ctx, 'arc'), ownMove: Object.hasOwn(ctx, 'moveTo'), ownBegin: Object.hasOwn(ctx, 'beginPath'), previous: null, calls: [] };
      ctx.beginPath = function () { g.__wideConnectionCommands.previous = null; return originalBegin.call(this); };
      ctx.moveTo = function (x, y) { g.__wideConnectionCommands.previous = { x, y }; return originalMove.call(this, x, y); };
      ctx.arc = function (...args) { const t = this.getTransform(); g.__wideConnectionCommands.calls.push({ args, previousPoint: g.__wideConnectionCommands.previous, color: this.strokeStyle, lineWidth: this.lineWidth, lineCap: this.lineCap, lineJoin: this.lineJoin, miterLimit: this.miterLimit, alpha: this.globalAlpha, contextTransform: { a: t.a, b: t.b, c: t.c, d: t.d, e: t.e, f: t.f } }); return Reflect.apply(originalArc, this, args); };
      g.__wideConnectionDocument = JSON.stringify(ed.doc.snapshot);
    });
      let previous = null, accepted = null;
      for (let attempt = 0; attempt < wideConnection.maximumCanvasCaptures; attempt++) {
        const frame = await modeFrame(page, 'canvas');
        const capture = await page.evaluate(() => { const ed = window.editor, v = ed.viewport; return { png: v.canvas.toDataURL('image/png'), document: JSON.stringify(ed.doc.snapshot), camera: { center: { ...v.center }, scale: v.scale, twist: v.twist, width: v.width, height: v.height, dpr: v.dpr } }; });
        assert.deepEqual(capture.camera, { center: { x: 0, y: 0 }, scale: 1, twist: 0, width: 8192, height: 800, dpr: 1 });
        assert.equal(capture.document, await page.evaluate(() => /** @type {any} */ (window).__wideConnectionDocument));
        const png = Buffer.from(capture.png.split(',')[1], 'base64'), image = PNG.sync.read(png);
        assert.equal(image.width, 8192); assert.equal(image.height, 800);
        const path = resolve(out, `wide-native-connection-canvas-self-${attempt}.png`); writeFileSync(path, png);
        const difference = previous ? changedRgbaPixels(previous, image) : null;
        wideConnection.samples.push({ attempt, frame, path, rawDifferentPixels: difference, camera: capture.camera });
        if (difference === 0) { accepted = image; break; } previous = image;
      }
      assert.ok(accepted, 'Synthetic wide Canvas must be independently self-consistent within bounded captures');
      const frame = await modeFrame(page, 'gpu'); wideConnection.gpuAttempt = frame;
      assert.equal(frame.rendered, false); assert.notEqual(frame.cacheReason, 'admission-deferred');
      assert.ok(frame.reason?.includes('Unsupported Canvas stroke construction: native float arc connection is unproved'));
      assert.equal(frame.bytes, 0); assert.equal(frame.uploadCalls, 0); assert.equal(frame.subrangeUploadBytes, 0); assert.equal(frame.subrangeUploadCalls, 0);
      const capture = await page.evaluate(() => {
        const v = window.editor.viewport, canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('[data-gpu-prototype="2d"]')), gl = canvas.getContext('webgl2');
        return { png: v.canvas.toDataURL('image/png'), actualFramebuffer: { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight, gpuCanvasWidth: canvas.width, gpuCanvasHeight: canvas.height, contextLost: gl.isContextLost() }, commands: /** @type {any} */ (window).__wideConnectionCommands.calls, documentUnchanged: JSON.stringify(window.editor.doc.snapshot) === /** @type {any} */ (window).__wideConnectionDocument };
      });
      Object.assign(wideConnection, { actualFramebuffer: capture.actualFramebuffer, actualCommands: capture.commands });
      assert.deepEqual(capture.actualFramebuffer, { width: 8192, height: 800, gpuCanvasWidth: 8192, gpuCanvasHeight: 800, contextLost: false });
      const fallbackPng = Buffer.from(capture.png.split(',')[1], 'base64'), fallback = PNG.sync.read(fallbackPng);
      writeFileSync(resolve(out, 'wide-native-connection-fallback.png'), fallbackPng);
      assert.equal(pixelmatch(accepted.data, fallback.data, null, 8192, 800, { threshold: 0.15 }), 0);
      assert.equal(Buffer.compare(accepted.data, fallback.data), 0, '8192x800 fallback preserves every Canvas RGBA channel');
      const actualArc = capture.commands.find((call) => call.color === '#44bb55' && call.lineWidth === 16);
      assert.ok(actualArc); assert.deepEqual(actualArc.previousPoint, { x: 4096.00015, y: 400 });
      assert.deepEqual(actualArc.args.slice(0, 4), [5096.00025, 400, 1000.0001, -Math.PI]);
      assert.equal(Math.abs(actualArc.args[4]), 0); assert.equal(actualArc.args[5], true);
      assert.equal(actualArc.lineCap, 'butt'); assert.equal(actualArc.lineJoin, 'miter'); assert.equal(actualArc.alpha, 1); assert.equal(actualArc.miterLimit, 10);
      assert.deepEqual(actualArc.contextTransform, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      let greenAboveInitialCap = 0;
      for (let y = 376; y < 400; y++) for (let x = 4072; x < 4120; x++) { const i = (y * 8192 + x) * 4; if ([68, 187, 85, 255].every((channel, c) => fallback.data[i + c] === channel)) greenAboveInitialCap++; }
      assert.equal(capture.documentUnchanged, true);
      Object.assign(wideConnection, { outcome: 'passed', exactCompleteCanvasRgba: true, rawDifferentPixels: 0, zeroGpuUploads: true, greenAboveInitialCap, nativeBackendCause: 'Unproved; actual commands and current full-view Canvas parity recorded', documentUnchanged: true });
    } finally {
      wideConnection.cleanup = await page.evaluate(() => {
        const ed = window.editor, v = ed.viewport, api = window.gpuPrototype, g = /** @type {any} */ (window), saved = g.__wideConnectionSaved, probe = g.__wideConnectionCommands, ctx = v.canvas.getContext('2d'), gpu = /** @type {HTMLCanvasElement} */ (document.querySelector('[data-gpu-prototype="2d"]'));
        if (probe) {
          if (probe.ownArc) ctx.arc = probe.originalArc; else delete /** @type {any} */ (ctx).arc;
          if (probe.ownMove) ctx.moveTo = probe.originalMove; else delete /** @type {any} */ (ctx).moveTo;
          if (probe.ownBegin) ctx.beginPath = probe.originalBegin; else delete /** @type {any} */ (ctx).beginPath;
        }
        v.resize = saved.resize; api.setMode('canvas'); if (saved.metadata?.name) api.loadFixture(saved.metadata.name);
        ed.doc.load(saved.snapshot, saved.filePath); ed.doc.restoreHistory(saved.history); ed.doc.dirty = saved.dirty; ed.doc.currentColor = saved.color;
        v.canvas.width = saved.canvas.width; v.canvas.height = saved.canvas.height;
        gpu.width = saved.gpuCanvas.width; gpu.height = saved.gpuCanvas.height;
        Object.assign(v, saved.camera); for (const key of Object.keys(v.settings)) if (!Object.hasOwn(saved.settings, key)) delete v.settings[key]; Object.assign(v.settings, saved.settings);
        ed.selection.clear(); for (const id of saved.selection) ed.selection.add(id); ed.setHover(saved.hover); api.setMode(saved.mode); api.renderNow();
        const restored = { documentRestored: JSON.stringify(ed.doc.snapshot) === saved.document, historyRestored: JSON.stringify(ed.doc.history()) === JSON.stringify(saved.history), cameraRestored: JSON.stringify({ center: { ...v.center }, scale: v.scale, twist: v.twist, width: v.width, height: v.height, dpr: v.dpr }) === JSON.stringify(saved.camera), selectionRestored: JSON.stringify([...ed.selection]) === JSON.stringify(saved.selection), settingsRestored: JSON.stringify(v.settings) === JSON.stringify(saved.settings), canvasBackingRestored: v.canvas.width === saved.canvas.width && v.canvas.height === saved.canvas.height, gpuBackingRestored: gpu.width === saved.gpuCanvas.width && gpu.height === saved.gpuCanvas.height, resizeHookRestored: v.resize === saved.resize, modeRestored: api.status().mode === saved.mode };
        delete g.__wideConnectionSaved; delete g.__wideConnectionCommands; delete g.__wideConnectionDocument;
        return restored;
      });
      assert.ok(Object.values(wideConnection.cleanup).every((restored) => restored === true), 'Synthetic probe restores the normal timed document/camera/backing/settings/history');
    }
  }
  const fixturePreflight = [];
  Object.assign(result, { fixturePreflight });
  // Fail new fixture setup/admission/image gates before expensive timed loops.
  // This uses the same native data and camera and is explicitly untimed. The
  // measured loops reload fixtures and retain their existing cold resource reset.
  const microedgePreflight = { name: 'straight-microedge-native-fallback', supportsGPU: false, fallbackReason: 'Unsupported Canvas stroke construction: native float segment topology is unproved' };
  for (const { name, supportsGPU, fallbackReason = null } of [...fixtures, microedgePreflight].filter((fixture) => ['curves', 'precision', 'precision-trillion', 'lineweights'].includes(fixture.name) || fixture.name.endsWith('-control') || fixture.name.startsWith('compound-') || fixture.name.startsWith('arc-') || fixture.name.startsWith('collapse-') || fixture.name.startsWith('negative-bulge-') || fixture.name === 'positive-bulge-precision-fallback' || fixture.name === 'straight-microedge-native-fallback')) {
    activeFixture = `preflight:${name}`;
    await page.evaluate((name) => { window.gpuPrototype.setMode('canvas'); window.editor.viewport.twist = 0; window.gpuPrototype.loadFixture(name); }, name);
    const description = await describeFixture();
    const preflightEvidence = { name, untimed: true, outcome: 'started', description, expectedSupportsGPU: supportsGPU };
    fixturePreflight.push(preflightEvidence);
    assertFixtureSetup(name, description);
    const baseline = await page.evaluate(() => { const v = window.editor.viewport; return { document: JSON.stringify(window.editor.doc.snapshot), camera: { center: { ...v.center }, scale: v.scale, twist: v.twist } }; });
    if (name.startsWith('collapse-')) {
      assert.deepEqual(baseline.camera, { center: { x: 1e12, y: 1e12 }, scale: 1, twist: 0 }, `${name}: counterexample uses its exact source-verified world camera`);
      assert.equal(result.viewport.dpr, 1, `${name}: independent collapsed-spur fixture is specified at DPR1`);
    }
    if (name === 'positive-bulge-precision-fallback') {
      assert.deepEqual(baseline.camera, { center: { x: 1e12, y: 1e12 }, scale: 16384, twist: 0 }, 'Positive-bulge counterexample uses the independently verified world camera');
      assert.equal(result.viewport.dpr, 1, 'Positive-bulge independent native construction probe is specified at DPR1');
    }
    if (name === 'straight-microedge-native-fallback') {
      assert.deepEqual(baseline.camera, { center: { x: 0, y: 0 }, scale: 10, twist: 0 });
      assert.deepEqual(result.viewport, { width: 1216, height: 552, dpr: 1 }, 'Microedge proof retains the measured ordinary viewport dimensions');
      const exact = await page.evaluate(() => window.editor.doc.entities.find((entity) => entity.id === 'MICROEDGE-P'));
      assert.deepEqual(exact.points, [{ x: -1e-6, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 10 }]);
      assert.equal(exact.bulges, undefined); assert.equal(exact.lineWeight, 4);
    }
    const images = [], controlSelectedImages = [];
    let gpuFrame;
    const observeNativeArc = name.endsWith('-control') || name === 'arc-full-huge' || name.startsWith('negative-bulge-') || name === 'positive-bulge-precision-fallback';
    if (observeNativeArc) {
      await page.evaluate(() => {
        const g = /** @type {any} */ (window), proto = CanvasRenderingContext2D.prototype;
        const original = proto.arc, originalMoveTo = proto.moveTo, originalBeginPath = proto.beginPath;
        g.__gpuBenchmarkArcProbe = { original, originalMoveTo, originalBeginPath, calls: [], previousPoint: null };
        proto.beginPath = /** @this {CanvasRenderingContext2D} */ function () {
          if (this.canvas === document.getElementById('drawing')) g.__gpuBenchmarkArcProbe.previousPoint = null;
          return originalBeginPath.call(this);
        };
        proto.moveTo = /** @this {CanvasRenderingContext2D} */ function (x, y) {
          if (this.canvas === document.getElementById('drawing')) g.__gpuBenchmarkArcProbe.previousPoint = { x, y };
          return originalMoveTo.call(this, x, y);
        };
        CanvasRenderingContext2D.prototype.arc = /** @this {CanvasRenderingContext2D} */ function (x, y, radius, start, end, counterclockwise) {
          if (this.canvas === document.getElementById('drawing')) {
            const arcStartPoint = { x: x + radius * Math.cos(start), y: y + radius * Math.sin(start) }, arcEndPoint = { x: x + radius * Math.cos(end), y: y + radius * Math.sin(end) };
            const transform = this.getTransform();
            g.__gpuBenchmarkArcProbe.calls.push({ center: { x, y }, radius, start, end, counterclockwise: counterclockwise ?? false, color: this.strokeStyle, lineWidth: this.lineWidth, alpha: this.globalAlpha, contextTransform: { a: transform.a, b: transform.b, c: transform.c, d: transform.d, e: transform.e, f: transform.f }, previousPoint: g.__gpuBenchmarkArcProbe.previousPoint, arcStartPoint, arcEndPoint });
            g.__gpuBenchmarkArcProbe.previousPoint = arcEndPoint;
          }
          return original.call(this, x, y, radius, start, end, counterclockwise);
        };
        // Observe the real painter, not an already-cached Canvas bitmap. This is
        // untimed instrumentation; measured cold/reset semantics stay unchanged.
        window.editor.viewport.discardScene();
      });
    }
    let canvasArcCalls = [];
    try {
      for (const mode of ['canvas', 'gpu']) {
        const path = resolve(out, `${name}-preflight-${mode}.png`);
        if (mode === 'canvas' && !supportsGPU) {
          const reference = await stableCanvasReference(`${name}-preflight`, path);
          images.push(reference.image);
          Object.assign(preflightEvidence, { canvasSelfConsistency: reference.evidence });
          continue;
        }
        const frame = await modeFrame(page, mode);
        if (mode === 'gpu') {
          gpuFrame = frame;
          Object.assign(preflightEvidence, { gpuFrame });
          assert.notEqual(frame.cacheReason, 'admission-deferred', `${name}: preflight mode toggle requires actual same-pose admission, not a deferred policy claim`);
          assert.equal(frame.rendered, supportsGPU, `${name}: untimed admission preflight; refusal: ${frame.reason ?? 'none'}`);
          if (fallbackReason) assert.ok(frame.reason?.includes(fallbackReason), `${name}: preflight refusal matches '${fallbackReason}', actual: ${frame.reason ?? 'none'}`);
          if (name === 'compound-dense') assert.equal(frame.reason, 'Stroke geometry exceeds prototype budget', 'Long-label baseline preflight proves its actual exact budget refusal');
          if (name === 'straight-microedge-native-fallback') { assert.equal(frame.bytes, 0); assert.equal(frame.uploadCalls, 0); }
          if (name === 'compound-tags') assert.equal(frame.preparedEntities + frame.reusedEntities, 10_500, 'Short-tag dense admission visits only the 5,000 wires, 4,000 block strokes, 1,000 attributes and 500 labels; unused catalog definitions remain unrendered');
        }
        await page.locator('#drawing').screenshot({ path });
        images.push(PNG.sync.read(readFileSync(path)));
      }
      if (name.endsWith('-control')) {
        const selectionBefore = await page.evaluate(() => ({ ids: [...window.editor.selection], effect: window.editor.viewport.settings.selectionEffect }));
        try {
          await page.evaluate((selectedId) => { const ed = window.editor; ed.selection.clear(); ed.selection.add(selectedId); ed.viewport.settings.selectionEffect = 'solid'; }, name.startsWith('direct-arc-') ? 'A' : 'P');
          for (const mode of ['canvas', 'gpu']) {
            if (mode === 'canvas' && !supportsGPU) {
              controlSelectedImages.push((await stableCanvasReference(`${name}-preflight-selected`, resolve(out, `${name}-preflight-selected-${mode}.png`))).image);
              continue;
            }
            const frame = await modeFrame(page, mode);
            if (mode === 'gpu') {
              assert.equal(frame.rendered, supportsGPU, `${name}: selected curve preserves actual admission classification`);
              if (!supportsGPU) { assert.equal(frame.bytes, 0); assert.equal(frame.uploadCalls, 0); assert.ok(frame.reason?.includes(fallbackReason)); }
            }
            const path = resolve(out, `${name}-preflight-selected-${mode}.png`);
            await page.locator('#drawing').screenshot({ path });
            controlSelectedImages.push(PNG.sync.read(readFileSync(path)));
          }
        } finally {
          await page.evaluate((before) => { const ed = window.editor; ed.selection.clear(); for (const id of before.ids) ed.selection.add(id); ed.viewport.settings.selectionEffect = before.effect; window.gpuPrototype.renderNow(); }, selectionBefore);
        }
      }
    } finally {
      if (observeNativeArc) canvasArcCalls = await page.evaluate(() => {
        const g = /** @type {any} */ (window), probe = g.__gpuBenchmarkArcProbe;
        if (!probe) return [];
        CanvasRenderingContext2D.prototype.arc = probe.original;
        CanvasRenderingContext2D.prototype.moveTo = probe.originalMoveTo;
        CanvasRenderingContext2D.prototype.beginPath = probe.originalBeginPath;
        delete g.__gpuBenchmarkArcProbe;
        return probe.calls;
      });
      if (observeNativeArc) Object.assign(preflightEvidence, { canvasArcCalls });
    }
    assert.equal(images[0].width, images[1].width); assert.equal(images[0].height, images[1].height);
    const diff = new PNG({ width: images[0].width, height: images[0].height });
    const pixels = pixelmatch(images[0].data, images[1].data, diff.data, diff.width, diff.height, { threshold: 0.15 });
    const miss = Math.max(missedForeground(images[0], images[1]), missedForeground(images[1], images[0]));
    writeFileSync(resolve(out, `${name}-preflight-diff.png`), PNG.sync.write(diff));
    assert.ok(miss < 0.005, `${name}: preflight preserves the existing geometric coverage gate`);
    if (!supportsGPU) {
      assert.equal(pixels, 0, `${name}: preflight fallback matches Canvas exactly`);
      assert.equal(Buffer.compare(images[0].data, images[1].data), 0, `${name}: preflight fallback has identical RGBA pixels`);
    } else if (name !== 'compound-tags') assert.ok(pixels / (diff.width * diff.height) < 0.001, `${name}: preflight preserves the strict small-scene raster gate`);
    if (name.endsWith('-control')) {
      const directArc = name.startsWith('direct-arc-');
      const control = await page.evaluate(({ directArc, name }) => {
        const editor = window.editor, v = editor.viewport, metadata = window.gpuPrototype.fixtureMetadata();
        const selected = editor.doc.entities.find((entity) => entity.id === (directArc ? metadata.controlArc.id : 'P'));
        if (!selected || selected.type !== (directArc ? 'arc' : 'polyline')) throw new Error('Missing unique selected opacity control');
        // Match core/entities.ts gripPoints: ARC endpoints, world-space arc midpoint,
        // and center; POLYLINE vertices. Project only after the world additions.
        const polar = (angle) => ({ x: selected.center.x + selected.radius * Math.cos(angle), y: selected.center.y + selected.radius * Math.sin(angle) });
        let sweep = directArc ? (selected.endAngle - selected.startAngle) % (Math.PI * 2) : 0;
        if (sweep < 0) sweep += Math.PI * 2;
        if (directArc && sweep < 1e-9) sweep = Math.PI * 2;
        const grips = directArc ? [polar(selected.startAngle), polar(selected.startAngle + sweep / 2), polar(selected.endAngle), selected.center] : selected.points;
        const selectionGrips = grips.map((world, index) => ({ label: directArc ? ['start', 'midpoint', 'end', 'center'][index] : `vertex-${index}`, world, screen: v.toScreen(world) }));
        const weighted = name === 'lineweights-control' || name === 'direct-arc-lineweights-control';
        const otherGeometry = editor.doc.entities.filter((entity) => entity.id !== selected.id).map((entity) => {
          const layer = editor.doc.layers.find((layer) => layer.name === entity.layer);
          const mm = entity.lineWeight !== undefined && entity.lineWeight >= 0 ? entity.lineWeight : layer?.lineWeight ?? 0.25;
          const lineWidth = weighted ? Math.max(1, Math.round(mm / 0.25 * 10) / 10) : 1;
          if (entity.type === 'line') return { id: entity.id, type: entity.type, a: v.toScreen(entity.a), b: v.toScreen(entity.b), lineWidth };
          if (entity.type === 'arc' || entity.type === 'circle') return { id: entity.id, type: entity.type, center: v.toScreen(entity.center), radius: entity.radius * v.scale, lineWidth };
          throw new Error(`Unexpected opacity-control neighbor: ${entity.type}`);
        });
        const probeGeometry = { selectionGrips, otherGeometry, gripHalfSize: v.settings.gripSize ?? 4, gripColor: v.settings.gripColor ?? '#1a3dff' };
        if (directArc) {
          const arc = metadata.controlArc, center = v.toScreen(arc.center), radius = arc.radius * v.scale;
          return { ...arc, ...probeGeometry, screenCenter: center, screenRadius: radius, screenA: { x: center.x + radius * Math.cos(-arc.startAngle), y: center.y + radius * Math.sin(-arc.startAngle) }, screenB: { x: center.x + radius * Math.cos(-arc.endAngle), y: center.y + radius * Math.sin(-arc.endAngle) }, width: v.width, height: v.height, dpr: v.dpr };
        }
        const polyline = metadata.controlPolyline;
        return { ...polyline, ...probeGeometry, screenA: v.toScreen(polyline.points[0]), screenB: v.toScreen(polyline.points[1]), width: v.width, height: v.height, dpr: v.dpr };
      }, { directArc, name });
      const close = (a, b) => a && Math.hypot(a.x - b.x, a.y - b.y) < 1e-8;
      const sourceArc = (call) => directArc ? call.previousPoint === null && close(call.center, control.screenCenter) && Math.abs(call.radius - control.screenRadius) < 1e-8 && call.start === -control.startAngle && call.end === -control.endAngle : close(call.previousPoint, control.screenA);
      const ordinaryArc = canvasArcCalls.find((call) => call.color === control.color && call.alpha === 1 && sourceArc(call));
      const selectedArc = canvasArcCalls.find((call) => call.color === control.color && call.alpha === 0.95 && sourceArc(call));
      assert.ok(ordinaryArc && selectedArc, directArc ? `${name}: actual direct Canvas ARC begins a path without an initial moveTo` : `${name}: actual preserved positive-bulge Canvas path retains its initial moveTo; GPU correctly refuses the unproved native connection`);
      assert.equal(ordinaryArc.lineWidth, control.expectedCssLineWidth, `${name}: actual native ordinary lineweight`);
      assert.equal(selectedArc.lineWidth, 2.5, `${name}: actual native solid-selection width`);
      for (const arc of [ordinaryArc, selectedArc]) assert.deepEqual(arc.contextTransform, { a: control.dpr, b: 0, c: 0, d: control.dpr, e: 0, f: 0 }, `${name}: native context transform records the actual DPR`);
      const expectedSelectedRgba = [...control.rgb.map((value, index) => Math.round(0.95 * value + 0.05 * [33, 40, 48][index])), 255];
      const arcPoint = (fraction) => {
        const angle = ordinaryArc.start + (ordinaryArc.end - ordinaryArc.start) * fraction;
        return { x: ordinaryArc.center.x + ordinaryArc.radius * Math.cos(angle), y: ordinaryArc.center.y + ordinaryArc.radius * Math.sin(angle) };
      };
      const samplesAt = (image, point) => {
        const x = Math.floor(point.x * image.width / control.width), y = Math.floor(point.y * image.height / control.height), samples = [];
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const index = ((y + dy) * image.width + x + dx) * 4;
          samples.push([...image.data.subarray(index, index + 4)]);
        }
        return samples;
      };
      const originalMidpoint = arcPoint(0.5);
      const originalMidpointDiagnostics = controlSelectedImages.map((image, rendererIndex) => ({
        renderer: rendererIndex === 0 ? 'canvas' : 'gpu-requested', point: originalMidpoint,
        expectedSelectedRgba, rgbaSamples: samplesAt(image, originalMidpoint),
        gripCoordinates: control.selectionGrips,
        overlappingGrips: control.selectionGrips.filter(({ screen }) => Math.abs(originalMidpoint.x - Math.round(screen.x)) <= control.gripHalfSize + 1 && Math.abs(originalMidpoint.y - Math.round(screen.y)) <= control.gripHalfSize + 1),
      }));
      const roiRadius = Math.SQRT2 * 6, requiredClearance = 12 + roiRadius;
      const candidates = [0.25, 0.75, 1 / 3, 2 / 3].map((fraction) => {
        const point = arcPoint(fraction);
        const gripClearance = Math.min(...control.selectionGrips.map(({ screen }) => Math.hypot(point.x - screen.x, point.y - screen.y)));
        const otherClearance = Math.min(...control.otherGeometry.map((entity) => {
          if (entity.type !== 'line') return Math.abs(Math.hypot(point.x - entity.center.x, point.y - entity.center.y) - entity.radius) - entity.lineWidth / 2;
          const dx = entity.b.x - entity.a.x, dy = entity.b.y - entity.a.y;
          const t = Math.max(0, Math.min(1, ((point.x - entity.a.x) * dx + (point.y - entity.a.y) * dy) / (dx * dx + dy * dy)));
          return Math.hypot(point.x - entity.a.x - t * dx, point.y - entity.a.y - t * dy) - entity.lineWidth / 2;
        }));
        return { fraction, point, gripClearance, otherClearance, inViewport: point.x > 6 && point.y > 6 && point.x < control.width - 6 && point.y < control.height - 6 };
      });
      // Choose by source geometry only, never by image color or renderer outcome.
      const chosen = candidates.find((candidate) => candidate.inViewport && candidate.gripClearance >= Math.max(12, Math.SQRT2 * (control.gripHalfSize + 1)) + roiRadius && candidate.otherClearance >= requiredClearance);
      Object.assign(preflightEvidence, { opacityProbeGeometry: { originalMidpointDiagnostics, candidates, chosen, requiredClearance, roiRadius, gripSource: 'core/entities.ts gripPoints-equivalent world construction' } });
      assert.ok(chosen, `${name}: independent opacity probe clears every selection grip and neighboring primitive by 12 CSS pixels plus its ROI`);
      const point = chosen.point;
      const region = { left: Math.floor((point.x - 6) * images[0].width / control.width), right: Math.ceil((point.x + 6) * images[0].width / control.width), top: Math.floor((point.y - 6) * images[0].height / control.height), bottom: Math.ceil((point.y + 6) * images[0].height / control.height) };
      const opacityProbes = controlSelectedImages.map((image, rendererIndex) => {
        const samples = samplesAt(image, point);
        assert.ok(samples.some((rgba) => expectedSelectedRgba.every((value, index) => Math.abs(value - rgba[index]) <= 2)), `${name}: actual selected curve has independently expected 0.95 opacity; expected ${expectedSelectedRgba}`);
        let changed = 0;
        for (let py = region.top; py <= region.bottom; py++) for (let px = region.left; px <= region.right; px++) {
          const index = (py * image.width + px) * 4;
          if ([0, 1, 2, 3].some((channel) => images[rendererIndex].data[index + channel] !== image.data[index + channel])) changed++;
        }
        assert.ok(changed > 0, `${name}: selection visibly changes actual curve pixels outside grips`);
        return { point, fraction: chosen.fraction, expectedSelectedRgba, rgbaSamples: samples, regionRawDifferentPixels: changed, originalMidpointDiagnostic: originalMidpointDiagnostics[rendererIndex], excludesEndpointGrips: true, excludesAllSelectionGrips: true, gripClearance: chosen.gripClearance, otherGeometryClearance: chosen.otherClearance };
      });
      const selectedPixels = pixelmatch(controlSelectedImages[0].data, controlSelectedImages[1].data, null, controlSelectedImages[0].width, controlSelectedImages[0].height, { threshold: 0.15 });
      const selectedMiss = Math.max(missedForeground(controlSelectedImages[0], controlSelectedImages[1]), missedForeground(controlSelectedImages[1], controlSelectedImages[0]));
      assert.ok(selectedPixels / (diff.width * diff.height) < 0.001 && selectedMiss < 0.005, `${name}: selected control retains the unchanged strict raster/coverage gates`);
      if (!supportsGPU) { assert.equal(selectedPixels, 0); assert.equal(Buffer.compare(controlSelectedImages[0].data, controlSelectedImages[1].data), 0, 'Preserved positive-bulge selected control has exact full Canvas RGBA'); }
      Object.assign(preflightEvidence, { [directArc ? 'directArcGpuControl' : 'preservedPositiveBulgeCanvasFallback']: { control, actualOrdinaryCanvasArc: ordinaryArc, actualSelectedCanvasArc: selectedArc, initialMoveToPresent: !directArc, actualPhysicalOrdinaryWidth: ordinaryArc.lineWidth * control.dpr, actualPhysicalSelectedWidth: selectedArc.lineWidth * control.dpr, independentSelectedOpacity: opacityProbes, selectedImageDifferenceFraction: selectedPixels / (diff.width * diff.height), selectedTwoPixelCoverageMissFraction: selectedMiss, expectedSupportsGPU: supportsGPU } });
    }
    if (name === 'arc-full-huge') {
      assert.ok(canvasArcCalls.some((call) => call.radius === 128 && call.start === 0 && call.end === Math.PI * 2), 'Huge equal angles invoke the actual Canvas full-circle painter with canonical start zero');
      const cardinalPixels = await page.evaluate(() => {
        const v = window.editor.viewport;
        return [{ x: 2, y: 0 }, { x: -2, y: 0 }, { x: 0, y: 2 }, { x: 0, y: -2 }].map((point) => ({ screen: v.toScreen(point), width: v.width, height: v.height }));
      });
      for (const image of images) for (const point of cardinalPixels) {
        const x = Math.round(point.screen.x * image.width / point.width), y = Math.round(point.screen.y * image.height / point.height);
        let foundGreen = false;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const index = ((y + dy) * image.width + x + dx) * 4;
          if (image.data[index + 1] - image.data[index] > 60 && image.data[index + 1] - image.data[index + 2] > 30) foundGreen = true;
        }
        assert.ok(foundGreen, 'Completed full-circle image contains the actual green ARC at every cardinal point');
      }
      Object.assign(preflightEvidence, { canvasArcCalls, fullCircleCardinalCoverage: true });
    }
    if (name.startsWith('negative-bulge-')) {
      const nativePositions = await page.evaluate(() => {
        const v = window.editor.viewport;
        return { a: v.toScreen({ x: -2, y: 0 }), b: v.toScreen({ x: 2, y: 0 }), midpoint: v.toScreen({ x: 0, y: 0 }), width: v.width, height: v.height };
      });
      const close = (a, b) => a && Math.hypot(a.x - b.x, a.y - b.y) < 1e-8;
      const nativeArc = canvasArcCalls.find((call) => call.color === '#22cc66' && call.radius === 160 && close(call.previousPoint, nativePositions.a) && close(call.arcStartPoint, nativePositions.b) && close(call.arcEndPoint, nativePositions.a));
      assert.ok(nativeArc, `${name}: actual Canvas moves to A, then native negative-bulge ARC starts at B and ends at A`);
      const connectorCoverage = images.map((image) => {
        const x = Math.round(nativePositions.midpoint.x * image.width / nativePositions.width), y = Math.round(nativePositions.midpoint.y * image.height / nativePositions.height);
        const samples = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const index = ((y + dy) * image.width + x + dx) * 4;
          samples.push([...image.data.subarray(index, index + 4)]);
        }
        // The curved part is 64 CSS pixels above this interior midpoint. Green
        // here independently proves the native arc's implicit straight connector.
        assert.ok(samples.some((rgba) => rgba[1] - rgba[0] > 30 && rgba[1] - rgba[2] > 20), `${name}: actual Canvas image includes the independent A-to-B connector midpoint`);
        return { screen: nativePositions.midpoint, rgbaSamples: samples, nativeConnectorPresent: true };
      });
      Object.assign(preflightEvidence, { canvasArcCalls, nativeArc, connectorCoverage, independentlyObservedNativeCanvasConnector: true });
    }
    if (name === 'positive-bulge-precision-fallback') {
      const construction = await page.evaluate(() => {
        const v = window.editor.viewport, reference = window.gpuPrototype.fixtureMetadata().curveConstructionReference;
        return { reference, expectedRoundedWorldScreenCenter: v.toScreen(reference.roundedWorldCenter), expectedRebasedLocalScreenCenter: { x: v.width / 2 + reference.localCenter.x * v.scale, y: v.height / 2 - reference.localCenter.y * v.scale }, expectedCssRadius: reference.radius * v.scale };
      });
      assert.equal(construction.reference.unit, 2 ** -13);
      assert.equal(construction.reference.roundedWorldCenter.y, 1e12 + 2 * 2 ** -13, 'Independent world addition rounds the 1.5-ULP bulge center to two ULPs');
      assert.equal(construction.expectedCssRadius, 5, 'Radius5CSSpx remains outside the old half-linewidth/precision overlap margin');
      const nativeArc = canvasArcCalls.find((call) => call.color === '#22cc66' && call.radius === construction.expectedCssRadius && Math.hypot(call.center.x - construction.expectedRoundedWorldScreenCenter.x, call.center.y - construction.expectedRoundedWorldScreenCenter.y) < 1e-8);
      assert.ok(nativeArc, 'Actual Canvas native ARC uses the independently expected rounded world center and radius');
      const independentLocalDisplacementCss = Math.hypot(construction.expectedRoundedWorldScreenCenter.x - construction.expectedRebasedLocalScreenCenter.x, construction.expectedRoundedWorldScreenCenter.y - construction.expectedRebasedLocalScreenCenter.y);
      assert.equal(independentLocalDisplacementCss, 1, 'Rounded native world construction differs from the independent local reference by one CSS pixel');
      Object.assign(preflightEvidence, { canvasArcCalls, nativeCurveConstruction: { ...construction, actualCanvasArc: nativeArc, independentLocalDisplacementCss, independentMathReference: true, oldGpuNativeObservationClaimed: false } });
    }
    if (name.startsWith('collapse-') || name === 'straight-microedge-native-fallback') {
      const probes = await page.evaluate(() => { const v = window.editor.viewport; return window.gpuPrototype.fixtureMetadata().probes.map((probe) => ({ ...probe, screen: v.toScreen(probe.point), width: v.width, height: v.height })); });
      const actualCanvasProbes = [];
      for (const probe of probes) {
        const x = Math.round(probe.screen.x * images[0].width / probe.width), y = Math.round(probe.screen.y * images[0].height / probe.height), index = (y * images[0].width + x) * 4;
        const rgba = [...images[0].data.subarray(index, index + 4)];
        assert.deepEqual(rgba, [...probe.rgb, 255], `${name}: actual Canvas collapsed segment does not add the independent below-cap spur`);
        actualCanvasProbes.push({ ...probe, rgba });
      }
      Object.assign(preflightEvidence, { actualCanvasProbes });
    }
    const after = await page.evaluate(() => { const v = window.editor.viewport; return { document: JSON.stringify(window.editor.doc.snapshot), camera: { center: { ...v.center }, scale: v.scale, twist: v.twist } }; });
    assert.deepEqual(after, baseline, `${name}: admission preflight leaves the complete drawing/catalog and camera unchanged`);
    Object.assign(preflightEvidence, { outcome: 'passed', gpuFrame, imageDifferenceFraction: pixels / (diff.width * diff.height), twoPixelCoverageMissFraction: miss, documentUnchanged: true, cameraUnchanged: true, rendererResourcesReset: false });
  }
  for (const { name: fixture, supportsGPU, supportsDeltas = supportsGPU, fallbackReason = null } of fixtures) {
    activeFixture = fixture;
    const poseDependentBudget = fixture === 'compound-dense';
    const denseRaster = fixture === 'dense-lines' || fixture === 'compound-tags' || poseDependentBudget;
    await page.evaluate((name) => { window.gpuPrototype.setMode('canvas'); window.editor.viewport.twist = 0; window.gpuPrototype.loadFixture(name); }, fixture);
    await page.waitForTimeout(100);
    const fixtureDescription = await describeFixture();
    assertFixtureSetup(fixture, fixtureDescription);
    const cadenceEdit = result.noReadbackCadence.comparisons[fixture]?.workflows['edit-undo'];
    let originalCameraEditCertificate = null;
    if (cadenceEdit || supportsGPU) {
      // Certify the already measured ID/vector at its exact original camera,
      // after the entire fresh phase. Pixel output never selects another line.
      const chosen = cadenceEdit ? cadenceEdit.canvas.topLevelLineEdit : await page.evaluate((fixture) => { const candidate = /** @type {any} */ (window).__gpuBenchmarkLineEdit(window.editor.doc.snapshot, window.editor.viewport, fixture); return { id: candidate.original.id, original: candidate.original, edited: candidate.edited, candidate }; }, fixture);
      if (cadenceEdit) {
        assert.equal(chosen.id, cadenceEdit.gpu.topLevelLineEdit.id, 'Fresh paired modes edit the same frozen LINE');
        assert.deepEqual(chosen.edited, cadenceEdit.gpu.topLevelLineEdit.edited);
      }
      const certificateCamera = cadenceEdit ? cadenceEdit.canvas.initialCamera : await page.evaluate(() => { const v = window.editor.viewport; return { center: { ...v.center }, scale: v.scale, twist: v.twist }; });
      const certificate = { outcome: 'started', untimed: true, separateLaterReadbackPhase: true, selectedId: chosen.id, candidate: chosen.candidate, camera: certificateCamera, canvasPixels: null, canvasRawRgbaPixels: null, gpuPixels: null, gpuRawRgbaPixels: null, expectedSupportsGPU: supportsGPU, gpuStages: {}, accuracy: {}, snapshotRestored: false, historyRestored: false, rendererResourcesReset: false };
      originalCameraEditCertificate = certificate;
      Object.assign(result, { activeOriginalCameraEditCertificate: { fixture, proof: certificate } });
      if (cadenceEdit) Object.assign(result.noReadbackCadence.comparisons[fixture], { laterCanvasEditCertificate: certificate });
      const saved = await page.evaluate((camera) => {
        const ed = window.editor, v = ed.viewport;
        if (JSON.stringify({ center: { ...v.center }, scale: v.scale, twist: v.twist }) !== JSON.stringify(camera)) throw new Error('Late timed edit certificate must retain the measured camera');
        return { document: JSON.stringify(ed.doc.snapshot), history: ed.doc.history(), dirty: ed.doc.dirty };
      }, certificate.camera);
      const gpuImage = async (label, frame) => {
        assert.equal(frame.rendered, supportsGPU, `${fixture}: original-camera edit certificate preserves its actual renderer`);
        assert.notEqual(frame.cacheReason, 'admission-deferred', 'Original-camera edit correctness requires actual admission');
        if (!supportsGPU) { assert.ok(matchesBenchmarkFallbackReason(fixture, fallbackReason, frame.reason)); assert.equal(frame.bytes, 0); assert.equal(frame.uploadCalls, 0); }
        const path = resolve(out, `${fixture}-timed-edit-${label}-gpu.png`);
        await page.locator('#drawing').screenshot({ path });
        certificate.gpuStages[label] = { frame, actualRenderer: frame.rendered ? 'gpu' : 'canvas', context: await prototypeContext(page) };
        return PNG.sync.read(readFileSync(path));
      };
      const comparePair = (canvas, gpu, label) => {
        const pixels = pixelmatch(canvas.data, gpu.data, null, canvas.width, canvas.height, { threshold: 0.15 });
        const miss = Math.max(missedForeground(canvas, gpu), missedForeground(gpu, canvas));
        certificate.accuracy[label] = { imageDifferenceFraction: pixels / (canvas.width * canvas.height), twoPixelCoverageMissFraction: miss, rawDifferentPixels: changedRgbaPixels(canvas, gpu) };
        assert.ok(miss < 0.005, `${fixture}: original-camera ${label} keeps the strict bidirectional coverage gate`);
        if (!supportsGPU) { assert.equal(pixels, 0); assert.equal(Buffer.compare(canvas.data, gpu.data), 0); }
        else if (!denseRaster) assert.ok(pixels / (canvas.width * canvas.height) < 0.001, `${fixture}: original-camera ${label} keeps the strict raster gate`);
      };
      const mutateGpu = async (action) => {
        const retained = await modeFrame(page, 'gpu');
        assert.equal(retained.rendered, supportsGPU);
        if (supportsGPU) { assert.equal(retained.cacheHit, true); assert.equal(retained.bytes, 0); assert.equal(retained.uploadCalls, 0); }
        const transition = await page.evaluate(async ({ action, original, edited }) => {
          const ed = window.editor, api = window.gpuPrototype, previous = ed.doc.snapshot;
          const started = performance.now();
          if (action === 'edit') ed.doc.replaceEntities([edited]);
          else if (action === 'undo') { if (!ed.doc.undo()) throw new Error('Original-camera GPU edit cannot undo'); }
          else if (action === 'redo') { if (!ed.doc.redo()) throw new Error('Original-camera GPU edit cannot redo'); }
          const frame = api.renderNow(), completionStarted = performance.now();
          let reportedCompletionMs = null;
          if (frame.rendered) { reportedCompletionMs = await api.completed(); if (!(typeof reportedCompletionMs === 'number' && Number.isFinite(reportedCompletionMs) && reportedCompletionMs >= 0)) throw new Error('Original-camera GPU edit completion unavailable'); }
          else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
          if (ed.doc.snapshot === previous) throw new Error('Original-camera edit transition was a no-op');
          if (JSON.stringify(ed.doc.entities.find((entity) => entity.id === original.id)) !== JSON.stringify(action === 'undo' ? original : edited)) throw new Error('Original-camera edit did not apply/restore its frozen LINE');
          return { frame, completedFrameWallMs: performance.now() - started, completionWaitMs: performance.now() - completionStarted, reportedCompletionMs, admissionState: { document: JSON.stringify(ed.doc.snapshot), camera: { center: { ...ed.viewport.center }, scale: ed.viewport.scale, twist: ed.viewport.twist, width: ed.viewport.width, height: ed.viewport.height, dpr: ed.viewport.dpr } } };
        }, { action, original: chosen.original, edited: chosen.edited });
        // This certificate is untimed. A slow budget refusal deliberately defers
        // fresh document admission until the owner's automatic idle retry. Keep
        // the original mutation frame and latency; observe current admission
        // separately without requesting renders or changing the product policy.
        if (transition.frame.cacheReason === 'admission-deferred') {
          assert.equal(poseDependentBudget, true, 'Only the original dense budget certificate may observe automatic idle admission');
          assert.equal(supportsGPU, false);
          transition.admissionObservation = await page.evaluate(observeActualGpuAdmission, transition.admissionState);
        }
        transition.correctnessFrame = transition.admissionObservation?.frame ?? transition.frame;
        delete transition.admissionState;
        if (supportsGPU) {
          assert.equal(transition.frame.rendered, true); assert.equal(transition.frame.cacheReason, 'document-delta'); assert.equal(transition.frame.uploadKind, 'subrange');
          assert.equal(transition.frame.bytes, 168); assert.equal(transition.frame.uploadCalls, 1); assert.equal(transition.frame.subrangeUploadBytes, 168); assert.equal(transition.frame.subrangeUploadCalls, 1);
          assert.ok(transition.frame.preparedEntities <= 1); assert.ok(transition.frame.partialPreparationMs <= transition.frame.geometryPreparationMs);
          if (action !== 'edit') assert.equal(transition.frame.editMemoHit, true);
        }
        return transition;
      };
      try {
        const baseline = (await stableCanvasReference(`${fixture}-timed-edit-baseline`, resolve(out, `${fixture}-timed-edit-baseline-canvas.png`))).image;
        const baselineGpu = await gpuImage('baseline', await modeFrame(page, 'gpu')); comparePair(baseline, baselineGpu, 'baseline');
        assert.equal(await page.evaluate((original) => JSON.stringify(window.editor.doc.entities.find((entity) => entity.id === original.id)) === JSON.stringify(original), chosen.original), true);
        const edit = await mutateGpu('edit');
        const editedGpu = await gpuImage('edited-before-undo', edit.correctnessFrame); Object.assign(certificate.gpuStages['edited-before-undo'], { completion: edit });
        const edited = (await stableCanvasReference(`${fixture}-timed-edit-edited`, resolve(out, `${fixture}-timed-edit-edited-canvas.png`))).image;
        comparePair(edited, editedGpu, 'edited-before-undo');
        certificate.canvasPixels = pixelmatch(baseline.data, edited.data, null, baseline.width, baseline.height, { threshold: 0.15 });
        certificate.canvasRawRgbaPixels = changedRgbaPixels(baseline, edited);
        assert.ok(certificate.canvasPixels > 0, `${fixture}: the frozen timed edit must visibly change actual Canvas at its measured camera`);
        assert.ok(certificate.canvasRawRgbaPixels > 0, `${fixture}: the frozen timed edit must change actual Canvas RGBA`);
        certificate.gpuPixels = pixelmatch(baselineGpu.data, editedGpu.data, null, baselineGpu.width, baselineGpu.height, { threshold: 0.15 });
        certificate.gpuRawRgbaPixels = changedRgbaPixels(baselineGpu, editedGpu);
        assert.ok(certificate.gpuPixels > 0 && certificate.gpuRawRgbaPixels > 0, `${fixture}: actual GPU/fallback must visibly show the frozen edit before undo`);
        const undo = await mutateGpu('undo'), undoneGpu = await gpuImage('undo', undo.correctnessFrame); Object.assign(certificate.gpuStages.undo, { completion: undo });
        assert.equal(Buffer.compare(baselineGpu.data, undoneGpu.data), 0, 'Original-camera GPU/fallback undo restores exact pixels');
        const undone = (await stableCanvasReference(`${fixture}-timed-edit-undo`, resolve(out, `${fixture}-timed-edit-undo-canvas.png`))).image;
        assert.equal(Buffer.compare(baseline.data, undone.data), 0, 'Timed LINE undo restores exact Canvas pixels');
        comparePair(undone, undoneGpu, 'undo');
        const redo = await mutateGpu('redo'), redoneGpu = await gpuImage('redo', redo.correctnessFrame); Object.assign(certificate.gpuStages.redo, { completion: redo });
        assert.equal(Buffer.compare(editedGpu.data, redoneGpu.data), 0, 'Original-camera GPU/fallback redo restores exact edited pixels');
        const redone = (await stableCanvasReference(`${fixture}-timed-edit-redo`, resolve(out, `${fixture}-timed-edit-redo-canvas.png`))).image;
        assert.equal(Buffer.compare(edited.data, redone.data), 0); comparePair(redone, redoneGpu, 'redo');
        await mutateGpu('undo');
        assert.equal(await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot)), saved.document);
        certificate.outcome = 'passed';
      } finally {
        const restored = await page.evaluate(({ document: baselineDocument, history, dirty }) => {
          const ed = window.editor;
          if (JSON.stringify(ed.doc.snapshot) !== baselineDocument && !ed.doc.undo()) throw new Error('Timed edit certificate cleanup cannot undo');
          if (JSON.stringify(ed.doc.snapshot) !== baselineDocument) throw new Error('Timed edit certificate cleanup changed the snapshot');
          ed.doc.restoreHistory(history); ed.doc.dirty = dirty;
          return { snapshotRestored: true, historyRestored: JSON.stringify(ed.doc.history()) === JSON.stringify(history) };
        }, saved);
        Object.assign(certificate, restored);
        assert.equal(certificate.historyRestored, true);
      }
    }
    const measure = async (mode, motion = 'pan-zoom', retainEndCamera = false) => page.evaluate(async ({ mode, samples, motion, retainEndCamera, fixture }) => {
      const ed = window.editor, api = window.gpuPrototype, v = ed.viewport;
      const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('drawing'));
      const ctx = canvas.getContext('2d');
      const center = { ...v.center }, scale = v.scale, twist = v.twist;
      const baselineDocument = JSON.stringify(ed.doc.snapshot);
      const summarize = (values) => {
        const sorted = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
        return { count: sorted.length, median: sorted[Math.floor(sorted.length / 2)] ?? null, p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? null, max: sorted.at(-1) ?? null };
      };
      const stages = ['cacheLookupMs', 'geometryPreparationMs', 'partialPreparationMs', 'initializationMs', 'uploadMs', 'subrangeUploadMs', 'drawSubmissionMs', 'preparationMs', 'submissionMs'];
      const entityMetrics = ['preparedEntities', 'reusedEntities', 'editHistoryBytes', 'editHistoryEntries'];
      const uploadMetrics = ['bytes', 'uploadCalls', 'subrangeUploadBytes', 'subrangeUploadCalls'];
      const finishSample = async (status, started, renderStarted, renderEnded, label, extra = {}) => {
        const completionStart = performance.now();
        const reportedCompletionMs = status.rendered ? await api.completed() : null;
        if (status.rendered && !(typeof reportedCompletionMs === 'number' && Number.isFinite(reportedCompletionMs) && reportedCompletionMs >= 0)) throw new Error(`${label}: GPU completion was not observed (timeout or context loss)`);
        if (!status.rendered) ctx.getImageData(0, 0, 1, 1);
        const completedAt = performance.now();
        const admissionPolicyDeferred = mode === 'gpu' && status.cacheReason === 'admission-deferred';
        if (admissionPolicyDeferred && (status.rendered || status.geometryPreparationMs !== 0 || status.partialPreparationMs !== 0 || status.bytes !== 0 || status.uploadCalls !== 0 || !status.reason?.includes('Stroke geometry exceeds prototype budget'))) throw new Error(`${label}: deferred admission must label its prior budget refusal with complete Canvas and no current preparation/uploads`);
        if (status.rendered) {
          if (!(status.cacheMinRatio > 0 && status.cacheMinRatio <= 1 && Number.isFinite(status.cacheMinRatio) && status.cacheMaxRatio >= 1 && Number.isFinite(status.cacheMaxRatio))) throw new Error(`${label}: missing actual certified zoom interval`);
          for (const key of [...stages, ...entityMetrics, ...uploadMetrics, 'geometryVertices']) {
            if (!(typeof status[key] === 'number' && Number.isFinite(status[key]) && status[key] >= 0)) throw new Error(`${label}: invalid or missing GPU telemetry ${key}`);
          }
          for (const key of [...entityMetrics, ...uploadMetrics, 'geometryVertices']) if (!Number.isInteger(status[key])) throw new Error(`${label}: invalid integer GPU telemetry ${key}`);
          if (typeof status.cacheHit !== 'boolean' || typeof status.editMemoHit !== 'boolean' || !['cold', 'mutable', 'document', 'document-delta', 'view-style', 'zoom-range', 'pan-range', 'precision', 'hit', 'not-checked'].includes(status.cacheReason) || !['none', 'subrange', 'full'].includes(status.uploadKind)) throw new Error(`${label}: invalid or missing GPU cache/upload telemetry`);
          if (status.uploadKind === 'none' && (status.bytes !== 0 || status.uploadCalls !== 0)) throw new Error(`${label}: zero-upload frame has upload work`);
          if (status.uploadKind === 'subrange' && (status.bytes !== status.subrangeUploadBytes || status.uploadCalls !== status.subrangeUploadCalls || status.uploadCalls === 0)) throw new Error(`${label}: subrange telemetry disagrees with successful upload issuance`);
          if (status.uploadKind !== 'subrange' && (status.subrangeUploadBytes !== 0 || status.subrangeUploadCalls !== 0 || status.subrangeUploadMs !== 0)) throw new Error(`${label}: full/zero-upload frame reports subrange work`);
          if (status.partialPreparationMs > status.geometryPreparationMs || status.subrangeUploadMs > status.uploadMs) throw new Error(`${label}: stage subsets exceed their totals`);
          if (status.editHistoryBytes > 1024 * 1024 || status.editHistoryEntries > 256) throw new Error(`${label}: edit memo exceeds its bounded history budget`);
        } else if (typeof status.reason !== 'string' || !status.reason.trim()) throw new Error(`${label}: Canvas fallback must record its reason`);
        const available = (key) => {
          if (status[key] === undefined || status[key] === null) return null;
          if (!(typeof status[key] === 'number' && Number.isFinite(status[key]) && status[key] >= 0)) throw new Error(`${label}: invalid provided GPU-attempt telemetry ${key}`);
          return status[key];
        };
        // A refused GPU attempt still incurs CPU preparation before Canvas completes
        // the frame. Keep those measurements separate from successful GPU work.
        const gpuAttempt = mode === 'gpu' ? { rendered: status.rendered, reason: status.reason ?? null, admissionPolicyDeferred, admissionEvidence: admissionPolicyDeferred ? 'Deferred policy based on a prior slow budget refusal; current geometry not evaluated' : status.rendered ? 'Current GPU scene admitted' : status.cacheReason === 'refusal-hit' ? 'Exact-view certified prior geometry refusal' : 'Actual refused attempt at this pose; reported reason retained', ...Object.fromEntries([...stages, ...entityMetrics, 'subrangeUploadBytes', 'subrangeUploadCalls'].map((key) => [key, available(key)])), requestedUploadBytes: available('bytes'), uploadCalls: available('uploadCalls'), uploadKind: status.uploadKind ?? null, geometryVertices: available('geometryVertices'), editMemoHit: typeof status.editMemoHit === 'boolean' ? status.editMemoHit : null, cacheHit: typeof status.cacheHit === 'boolean' ? status.cacheHit : null, cacheReason: status.cacheReason ?? null, cacheMinRatio: available('cacheMinRatio'), cacheMaxRatio: available('cacheMaxRatio') } : null;
        const sample = { label, requestedRenderer: mode, actualRenderer: status.rendered ? 'gpu' : 'canvas', gpuAttempt, rendered: status.rendered, reason: status.reason ?? null, cpuSubmissionMs: renderEnded - renderStarted, renderToCompletionWallMs: completedAt - renderStarted, workflowWallMs: completedAt - started, completedFrameWallMs: completedAt - started, completionWaitMs: completedAt - completionStart, reportedCompletionMs, uploadBytes: status.rendered ? status.bytes : null, uploadCalls: status.rendered ? status.uploadCalls : null, uploadKind: status.rendered ? status.uploadKind : null, subrangeUploadBytes: status.rendered ? status.subrangeUploadBytes : null, subrangeUploadCalls: status.rendered ? status.subrangeUploadCalls : null, geometryVertices: status.rendered ? status.geometryVertices : null, cacheMinRatio: status.rendered ? status.cacheMinRatio : null, cacheMaxRatio: status.rendered ? status.cacheMaxRatio : null, ...Object.fromEntries(entityMetrics.map((key) => [key, status.rendered ? status[key] : null])), editMemoHit: status.rendered ? status.editMemoHit : null, cacheHit: status.rendered ? status.cacheHit : null, cacheReason: status.rendered ? status.cacheReason : 'not-checked', center: { ...v.center }, scale: v.scale, twist: v.twist, ...extra };
        for (const stage of stages) sample[stage] = status.rendered && typeof status[stage] === 'number' ? status[stage] : null;
        return sample;
      };
      const statistics = (frames) => {
        // Delta preparation is deliberately a cache miss, but it does not rebuild the
        // full scene. A repaired upload can be full even after delta CPU preparation.
        const rebuilds = frames.filter((frame) => frame.rendered && frame.cacheHit === false && frame.cacheReason !== 'document-delta');
        const deltas = frames.filter((frame) => frame.rendered && frame.cacheReason === 'document-delta');
        const fullUploads = frames.filter((frame) => frame.rendered && frame.uploadKind === 'full');
        const subrangeUploads = frames.filter((frame) => frame.rendered && frame.uploadKind === 'subrange');
        const zeroUploads = frames.filter((frame) => frame.rendered && frame.uploadKind === 'none');
        const numeric = ['cpuSubmissionMs', 'renderToCompletionWallMs', 'workflowWallMs', 'completedFrameWallMs', 'completionWaitMs', 'uploadBytes', 'uploadCalls', 'subrangeUploadBytes', 'subrangeUploadCalls', 'geometryVertices', 'documentMutationMs', 'cameraUpdateMs', ...entityMetrics, ...stages];
        const aggregate = (samples) => Object.fromEntries(numeric.map((key) => [key, summarize(samples.map((frame) => frame[key]))]));
        const attempts = frames.filter((frame) => frame.gpuAttempt);
        const attemptedStages = [...stages, ...entityMetrics, 'requestedUploadBytes', 'uploadCalls', 'subrangeUploadBytes', 'subrangeUploadCalls', 'geometryVertices'];
        const aggregateAttempts = (samples) => Object.fromEntries(attemptedStages.map((key) => [key, summarize(samples.map((frame) => frame.gpuAttempt?.[key]))]));
        const indices = (samples) => frames.flatMap((frame, index) => samples.includes(frame) ? [index] : []);
        return { all: aggregate(frames), rebuild: aggregate(rebuilds), documentDelta: aggregate(deltas), uploads: { full: aggregate(fullUploads), subrange: aggregate(subrangeUploads), none: aggregate(zeroUploads) }, editMemoHits: frames.filter((frame) => frame.rendered && frame.editMemoHit).length, gpuAttempts: { cacheReasons: attempts.reduce((counts, frame) => { const reason = frame.gpuAttempt.cacheReason ?? 'missing-telemetry'; counts[reason] = (counts[reason] ?? 0) + 1; return counts; }, {}), count: attempts.length, completedGpuFrames: attempts.filter((frame) => frame.rendered).length, canvasFallbackFrames: attempts.filter((frame) => !frame.rendered).length, all: aggregateAttempts(attempts), byAction: Object.fromEntries([...new Set(attempts.map((frame) => frame.label))].map((label) => [label, aggregateAttempts(attempts.filter((frame) => frame.label === label))])) }, byAction: Object.fromEntries([...new Set(frames.map((frame) => frame.label))].map((label) => [label, aggregate(frames.filter((frame) => frame.label === label))])), rebuildFrameIndices: indices(rebuilds), documentDeltaFrameIndices: indices(deltas), fullUploadFrameIndices: indices(fullUploads), subrangeUploadFrameIndices: indices(subrangeUploads), zeroUploadFrameIndices: indices(zeroUploads), cacheReasons: frames.reduce((counts, frame) => { counts[frame.cacheReason ?? 'missing-telemetry'] = (counts[frame.cacheReason ?? 'missing-telemetry'] ?? 0) + 1; return counts; }, {}) };
      };
      // Observe the actual setMode-triggered frame. Calling renderNow afterwards would
      // measure a second, warmed frame and hide initialization/geometry/upload costs.
      const setupStarted = performance.now();
      const coldSetup = { gpuResourcesReset: false, canvasSceneDiscarded: false, untimed: true, elapsedMs: 0 };
      if (mode === 'gpu') {
        if (typeof api.reset2DRenderer !== 'function') throw new Error('Cold benchmark requires the development reset2DRenderer hook');
        api.reset2DRenderer();
        coldSetup.gpuResourcesReset = true;
      }
      if (typeof v.discardScene === 'function') { v.discardScene(); coldSetup.canvasSceneDiscarded = true; }
      coldSetup.elapsedMs = performance.now() - setupStarted;
      const originalRender = v.render;
      let resolveFirst, rejectFirst, firstTimer;
      const observedFirst = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject; });
      v.render = /** @this {any} */ function (overlay) {
        const renderStarted = performance.now();
        try {
          originalRender.call(this, overlay);
          const renderEnded = performance.now();
          resolveFirst({ status: api.renderStats(), renderStarted, renderEnded });
        } catch (error) { rejectFirst(error); throw error; }
      };
      let first, firstFrame, firstStart;
      try {
        firstTimer = setTimeout(() => rejectFirst(new Error('Mode-triggered benchmark frame did not arrive within 10 seconds')), 10000);
        firstStart = performance.now();
        api.setMode(mode);
        const observed = /** @type {any} */ (await observedFirst);
        first = observed.status;
        firstFrame = await finishSample(first, firstStart, observed.renderStarted, observed.renderEnded, 'mode-triggered-first', { modeToRenderStartMs: observed.renderStarted - firstStart });
      } finally { clearTimeout(firstTimer); v.render = originalRender; }
      const redrawFrames = [];
      for (let i = 0; i < 15; i++) {
        const start = performance.now();
        const status = api.renderNow();
        redrawFrames.push(await finishSample(status, start, start, performance.now(), 'warm-redraw'));
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      }
      const frames = [], intervals = [];
      const editCandidate = /** @type {any} */ (window).__gpuBenchmarkLineEdit(ed.doc.snapshot, v, fixture);
      const editLine = editCandidate.original, editedLine = editCandidate.edited;
      const offCenterAmplitude = Math.min(0.1, 64 / (Math.max(v.width, v.height) * v.dpr * 0.22));
      for (let i = 0; i < samples; i++) {
        const documentBefore = ed.doc.snapshot;
        const start = performance.now();
        let action = motion, documentMutationMs = 0, cameraUpdateMs = 0;
        if (motion === 'edit-undo') {
          const mutationStart = performance.now();
          if (i % 2) {
            if (!ed.doc.undo()) throw new Error('Representative edit could not be undone');
            action = 'undo-line-edit';
          } else {
            ed.doc.replaceEntities([editedLine]);
            action = 'edit-visible-line';
          }
          documentMutationMs = performance.now() - mutationStart;
        } else {
          const cameraStart = performance.now();
          if (motion === 'pan' || motion === 'pan-zoom') v.panByPixels(i % 2 ? -2 : 2, i % 2 ? -1 : 1);
          if (motion === 'pan-zoom') v.zoomAt({ x: v.width / 2, y: v.height / 2 }, i % 2 ? 1 / 1.005 : 1.005);
          if (motion === 'bounded-zoom' || motion === 'off-center-zoom') {
            const ratio = 1 + (motion === 'off-center-zoom' ? offCenterAmplitude : 0.1) * (i + 1) / samples;
            v.zoomAt({ x: v.width * (motion === 'off-center-zoom' ? 0.7 : 0.5), y: v.height * (motion === 'off-center-zoom' ? 0.3 : 0.5) }, scale * ratio / v.scale);
          }
          if (motion === 'sustained-zoom') v.zoomAt({ x: v.width / 2, y: v.height / 2 }, 1.02);
          if (motion === 'min-edge' || motion === 'max-edge') {
            const progress = (i + 1) / samples;
            const ratio = 1 + ((motion === 'min-edge' ? 0.8 : 1.25) - 1) * progress;
            // Set the desired pose relative to the copied cold anchor, without rendering
            // intermediate camera resets. Pan approaches the 128-physical-pixel border.
            v.center = { ...center }; v.scale = scale; v.twist = twist;
            v.zoomAt({ x: v.width / 2, y: v.height / 2 }, ratio);
            v.panByPixels(120 / v.dpr * progress, -112 / v.dpr * progress);
          }
          cameraUpdateMs = performance.now() - cameraStart;
        }
        const renderStarted = performance.now();
        const status = api.renderNow();
        frames.push(await finishSample(status, start, renderStarted, performance.now(), action, { documentMutationMs, cameraUpdateMs }));
        // Validate outside the measured workflow; serializing/searching is benchmark overhead.
        if (motion === 'edit-undo') {
          if (ed.doc.snapshot === documentBefore) throw new Error(`${action}: drawing transition was a no-op`);
          const actual = ed.doc.entities.find((entity) => entity.id === editLine.id);
          if (JSON.stringify(actual) !== JSON.stringify(i % 2 ? editLine : editedLine)) throw new Error(`${action}: edited line was not changed/restored as requested`);
        }
        const before = performance.now();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        intervals.push(performance.now() - before);
      }
      const lastCamera = { center: { ...v.center }, scale: v.scale, twist: v.twist };
      if (motion === 'edit-undo' && JSON.stringify(ed.doc.snapshot) !== baselineDocument) throw new Error('Edit/undo benchmark changed the drawing');
      let cameraReset = null;
      if (!retainEndCamera) {
        const resetStarted = performance.now();
        v.center = center; v.scale = scale; v.twist = twist;
        const renderStarted = performance.now();
        const status = api.renderNow();
        cameraReset = await finishSample(status, resetStarted, renderStarted, performance.now(), 'untimed-camera-reset', { untimed: true });
      }
      const summary = statistics(frames), redrawSummary = statistics(redrawFrames);
      Object.assign(summary, { aggregateRendererScope: 'Requested-mode completed-frame aggregates; actual GPU/Canvas samples are separated below, and GPU-only numeric stages remain successful-frame-only', actualRendererCounts: frames.reduce((counts, frame) => { counts[frame.actualRenderer] = (counts[frame.actualRenderer] ?? 0) + 1; return counts; }, {}), byActualRenderer: Object.fromEntries(['gpu', 'canvas'].map((renderer) => [renderer, Object.fromEntries(['cpuSubmissionMs', 'workflowWallMs', 'renderToCompletionWallMs', 'completedFrameWallMs', 'completionWaitMs'].map((key) => [key, summarize(frames.filter((frame) => frame.actualRenderer === renderer).map((frame) => frame[key]))]))])) });
      const heap = /** @type {any} */ (performance).memory?.usedJSHeapSize ?? null;
      return { firstSubmissionMs: firstFrame.cpuSubmissionMs, first, firstFrame, coldSetup, redrawCpuMedianMs: redrawSummary.all.cpuSubmissionMs.median, redrawTotalMedianMs: redrawSummary.all.completedFrameWallMs.median, cpuSubmissionMedianMs: summary.all.cpuSubmissionMs.median, completionWaitMedianMs: summary.all.completionWaitMs.median, totalRenderMedianMs: summary.all.completedFrameWallMs.median, totalRenderP95Ms: summary.all.completedFrameWallMs.p95, totalRenderMaxMs: summary.all.completedFrameWallMs.max, preparationMedianMs: summary.all.preparationMs.median, rafWaitMedianMs: summarize(intervals).median, uploadedBytes: frames.map((frame) => frame.uploadBytes), uploadedCalls: frames.map((frame) => frame.uploadCalls), frameSamples: frames, summary, warmRedraw: { samples: redrawFrames, summary: redrawSummary }, camera: { initial: { center, scale, twist }, last: lastCamera, terminalRetained: retainEndCamera, untimedReset: cameraReset }, editUndo: motion === 'edit-undo' ? { entityId: editLine.id, topLevelSourceIndex: ed.doc.entities.indexOf(editLine), entityType: editLine.type, visible: true, visibleLayer: true, childTextOrInsertEdit: false, original: editLine, edited: editedLine, candidate: editCandidate, snapshotRestored: true } : null, samples, motion, heapBytes: heap, status: api.status() };
    }, { mode, samples: 30, motion, retainEndCamera, fixture });
    const compareTrajectoryEnd = async (label, camera, initialCamera) => {
      const terminal = await page.evaluate(() => ({ center: { ...window.editor.viewport.center }, scale: window.editor.viewport.scale, twist: window.editor.viewport.twist }));
      assert.deepEqual(terminal, camera, `${fixture}: ${label} proof starts on the actual terminal camera/cache`);
      const images = [];
      let gpuFrame, evidence;
      try {
        for (const mode of ['canvas', 'gpu']) {
          const path = resolve(out, `${fixture}-${label}-${mode}.png`);
          if (mode === 'canvas' && !supportsGPU) { images.push((await stableCanvasReference(`${fixture}-${label}`, path)).image); continue; }
          const frame = await modeFrame(page, mode);
          if (mode === 'gpu') {
            gpuFrame = frame;
            assert.notEqual(frame.cacheReason, 'admission-deferred', `${fixture}: ${label} mode toggle requires actual same-pose admission`);
            if (supportsGPU && !poseDependentBudget) {
              assert.equal(frame.rendered, true, `${fixture}: ${label} comparison uses GPU; refusal: ${frame.reason ?? 'none'}`);
              assert.equal(frame.bytes, 0, `${fixture}: ${label} comparison reuses the terminal geometry bytes`);
              assert.equal(frame.uploadCalls, 0, `${fixture}: ${label} comparison makes no upload calls`);
            } else if (!poseDependentBudget) assert.equal(frame.rendered, false, `${fixture}: ${label} comparison preserves whole-view fallback`);
          }
          await page.locator('#drawing').screenshot({ path });
          images.push(PNG.sync.read(readFileSync(path)));
        }
        assert.equal(images[0].width, images[1].width); assert.equal(images[0].height, images[1].height);
        const diff = new PNG({ width: images[0].width, height: images[0].height });
        const pixels = pixelmatch(images[0].data, images[1].data, diff.data, diff.width, diff.height, { threshold: 0.15 });
        writeFileSync(resolve(out, `${fixture}-${label}-diff.png`), PNG.sync.write(diff));
        const miss = Math.max(missedForeground(images[0], images[1]), missedForeground(images[1], images[0]));
        assert.ok(miss < 0.005, `${fixture}: ${label} endpoint retains geometry within two pixels`);
        if (!gpuFrame.rendered) {
          assert.equal(pixels, 0, `${fixture}: ${label} whole-view fallback matches Canvas exactly`);
          assert.equal(Buffer.compare(images[0].data, images[1].data), 0, `${fixture}: ${label} whole-view fallback has identical RGBA pixels`);
        } else if (!denseRaster) assert.ok(pixels / (diff.width * diff.height) < 0.001, `${fixture}: ${label} endpoint retains the existing raster accuracy gate`);
        evidence = { camera, gpuFrame, actualRenderer: gpuFrame.rendered ? 'gpu' : 'canvas', poseDependentBudgetAdmission: poseDependentBudget, actualAdmissionRequired: true, imageDifferenceFraction: pixels / (diff.width * diff.height), twoPixelCoverageMissFraction: miss, untimedCameraReset: null };
      } finally {
        const reset = await page.evaluate(async (next) => {
          const v = window.editor.viewport, api = window.gpuPrototype;
          const started = performance.now();
          v.center = next.center; v.scale = next.scale; v.twist = next.twist;
          const frame = api.renderNow();
          let completionMs = null;
          if (frame.rendered) {
            completionMs = await api.completed();
            if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('Untimed camera reset GPU completion was not observed');
          } else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
          return { untimed: true, camera: next, elapsedMs: performance.now() - started, completionMs, frame };
        }, initialCamera);
        if (evidence) evidence.untimedCameraReset = reset;
      }
      return evidence;
    };
    const canvasResult = await measure('canvas');
    if (supportsGPU) await page.locator('#drawing').screenshot({ path: resolve(out, `${fixture}-canvas.png`) });
    else await stableCanvasReference(`${fixture}-centered-reference`, resolve(out, `${fixture}-canvas.png`));
    const gpuResult = await measure('gpu', 'pan-zoom', true);
    if (fallbackReason) assert.ok(matchesBenchmarkFallbackReason(fixture, fallbackReason, gpuResult.firstFrame.reason), `${fixture}: admission refuses with '${fallbackReason}', actual: ${gpuResult.firstFrame.reason ?? 'none'}`);
    const panZoomImage = await compareTrajectoryEnd('pan-zoom', gpuResult.camera.last, gpuResult.camera.initial);
    if (poseDependentBudget) { await modeFrame(page, 'canvas'); await modeFrame(page, 'gpu'); }
    const centeredGpuFrame = await page.evaluate(() => window.gpuPrototype.renderStats());
    assert.notEqual(centeredGpuFrame.cacheReason, 'admission-deferred', `${fixture}: centered comparison requires actual admission`);
    const context = await prototypeContext(page);
    await page.locator('#drawing').screenshot({ path: resolve(out, `${fixture}-gpu.png`) });
    const a = PNG.sync.read(readFileSync(resolve(out, `${fixture}-canvas.png`)));
    const b = PNG.sync.read(readFileSync(resolve(out, `${fixture}-gpu.png`)));
    assert.equal(a.width, b.width); assert.equal(a.height, b.height);
    const diff = new PNG({ width: a.width, height: a.height });
    const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.15 });
    writeFileSync(resolve(out, `${fixture}-diff.png`), PNG.sync.write(diff));
    const coverageMiss = Math.max(missedForeground(a, b), missedForeground(b, a));
    const panCanvas = await measure('canvas', 'pan');
    const panGpu = await measure('gpu', 'pan', true);
    const panImage = await compareTrajectoryEnd('pan-only', panGpu.camera.last, panGpu.camera.initial);
    const boundedCanvas = await measure('canvas', 'bounded-zoom');
    const boundedGpu = await measure('gpu', 'bounded-zoom', true);
    const boundedImage = await compareTrajectoryEnd('bounded-zoom', boundedGpu.camera.last, boundedGpu.camera.initial);
    const sustainedCanvas = await measure('canvas', 'sustained-zoom');
    const sustainedGpu = await measure('gpu', 'sustained-zoom', true);
    const sustainedImage = await compareTrajectoryEnd('sustained-zoom', sustainedGpu.camera.last, sustainedGpu.camera.initial);
    const offCenterCanvas = await measure('canvas', 'off-center-zoom');
    const offCenterGpu = await measure('gpu', 'off-center-zoom', true);
    const offCenterImage = await compareTrajectoryEnd('off-center-zoom', offCenterGpu.camera.last, offCenterGpu.camera.initial);
    const minEdgeCanvas = await measure('canvas', 'min-edge');
    const minEdgeGpu = await measure('gpu', 'min-edge', true);
    const minEdgeImage = await compareTrajectoryEnd('min-edge', minEdgeGpu.camera.last, minEdgeGpu.camera.initial);
    const maxEdgeCanvas = await measure('canvas', 'max-edge');
    const maxEdgeGpu = await measure('gpu', 'max-edge', true);
    const maxEdgeImage = await compareTrajectoryEnd('max-edge', maxEdgeGpu.camera.last, maxEdgeGpu.camera.initial);
    const editCanvas = await measure('canvas', 'edit-undo');
    const editGpu = await measure('gpu', 'edit-undo', true);
    const editImage = await compareTrajectoryEnd('edit-undo', editGpu.camera.last, editGpu.camera.initial);
    const trajectoryEndpoints = { panZoom: panZoomImage, pan: panImage, boundedZoom: boundedImage, sustainedZoom: sustainedImage, offCenterZoom: offCenterImage, minimumZoom: minEdgeImage, maximumZoom: maxEdgeImage, editUndo: editImage };
    // Thirty alternating edits finish on the original document. A correct terminal
    // image alone could therefore conceal a broken upload that never showed an edit.
    // Check edit, undo and redo separately, outside timing, retaining one live cache
    // throughout each Canvas reference / GPU comparison at a twisted, panned zoom.
    const editCorrectness = { untimed: true, setup: null, transitions: {}, comparisons: {}, editedImageChanged: null, restorationControls: {}, nativeReferenceOutcome: 'pending', relativeCanvasRestorationOutcome: 'pending', snapshotRestored: false, resourcesReset: false, expectedActualRenderer: 'canvas', originalTwistedPosePreserved: true, nativeGpuEditFreshnessClaimed: false, admittedSceneRotationRefusal: supportsGPU || poseDependentBudget ? nativeRotationReason : null };
    Object.assign(result, { activeEditCorrectness: { fixture, proof: editCorrectness } });
    const proofBaseline = await page.evaluate(() => {
      const ed = window.editor, v = ed.viewport;
      /** @type {any} */ (window).__gpuBenchmarkRestoreSnapshots = { baseline: ed.doc.snapshot, baselineJson: JSON.stringify(ed.doc.snapshot), edited: null, editedJson: null };
      return { document: JSON.stringify(ed.doc.snapshot), camera: { center: { ...v.center }, scale: v.scale, twist: v.twist } };
    });
    try {
      const setup = await page.evaluate(async ({ budgetPose, fixture }) => {
        const ed = window.editor, v = ed.viewport, api = window.gpuPrototype;
        const complete = async (frame) => {
          if (frame.rendered) {
            const completionMs = await api.completed();
            if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('Edit proof setup GPU completion was not observed');
            return completionMs;
          }
          /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
          return null;
        };
        // Twist establishes the anchor once, before the edit. No renderer-resource
        // reset or anchor change occurs during the edit/undo/redo comparisons.
        v.twist += 0.17;
        if (budgetPose) { api.setMode('canvas'); api.setMode('gpu'); }
        const anchor = api.renderNow();
        const anchorCompletionMs = await complete(anchor);
        v.zoomAt({ x: v.width / 2, y: v.height / 2 }, 1.05);
        v.panByPixels(24 / v.dpr, -17 / v.dpr);
        if (budgetPose) { api.setMode('canvas'); api.setMode('gpu'); }
        const warm = api.renderNow();
        const warmCompletionMs = await complete(warm);
        const candidate = /** @type {any} */ (window).__gpuBenchmarkLineEdit(ed.doc.snapshot, v, fixture);
        const { original, edited, displacementCss } = candidate;
        return { anchor, anchorCompletionMs, warm, warmCompletionMs, original, edited, candidate, topLevelSourceIndex: ed.doc.entities.indexOf(original), sourceEntityType: original.type, visibleLayer: true, childTextOrInsertEdit: false, expectedRetainedVertices: 6, displacementCss, camera: { center: { ...v.center }, scale: v.scale, twist: v.twist } };
      }, { budgetPose: poseDependentBudget, fixture });
      editCorrectness.setup = setup;
      assert.equal(setup.original.id, editCanvas.editUndo.entityId, `${fixture}: twisted correctness proof retains the measured Canvas edit LINE`);
      assert.equal(setup.original.id, editGpu.editUndo.entityId, `${fixture}: twisted correctness proof retains the measured GPU/fallback edit LINE`);
      assert.equal(setup.warm.rendered, false, `${fixture}: original twisted edit pose retains complete-view Canvas`);
      assert.notEqual(setup.warm.cacheReason, 'admission-deferred', 'Twisted edit proof uses actual admission at its retained camera');
      if (supportsGPU || poseDependentBudget) assert.ok(setup.warm.reason?.includes(nativeRotationReason), `${fixture}: only the owned native-context rotation refusal allows this previously admitted scene to use Canvas`);
      assert.equal(setup.warm.bytes, 0); assert.equal(setup.warm.uploadCalls, 0);
      const proofImages = {};
      let baselineInvariants;
      const captureRestorationInvariants = async (label) => page.evaluate((label) => {
        const ed = window.editor, v = ed.viewport, retained = /** @type {any} */ (window).__gpuBenchmarkRestoreSnapshots;
        const original = label === 'baseline' || label === 'undo';
        const expectedState = original ? retained.baseline : retained.edited, expectedJson = original ? retained.baselineJson : retained.editedJson;
        if (ed.doc.snapshot !== expectedState) throw new Error(`${label}: restoration must retain the exact immutable snapshot identity`);
        if (JSON.stringify(ed.doc.snapshot) !== expectedJson) throw new Error(`${label}: restoration must retain the complete document JSON`);
        const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')), rect = canvas.getBoundingClientRect();
        const overlay = /** @type {any} */ (v).lastOverlay;
        return {
          snapshotReference: original ? 'baseline' : 'edited', snapshotIdentityMatches: true, documentJsonMatches: true, documentJsonLength: expectedJson.length,
          view: { camera: { center: { ...v.center }, scale: v.scale, twist: v.twist }, width: v.width, height: v.height, dpr: v.dpr, windowDpr: window.devicePixelRatio,
            backing: { width: canvas.width, height: canvas.height }, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
            settings: JSON.parse(JSON.stringify(v.settings)), overlay: overlay ? JSON.parse(JSON.stringify({ ...overlay, selection: [...overlay.selection] })) : null },
        };
      }, label);
      const compareEditedState = async (label) => {
        const images = [];
        let gpuFrame;
        for (const mode of ['canvas', 'gpu']) {
          const path = resolve(out, `${fixture}-edit-proof-${label}-${mode}.png`);
          if (mode === 'canvas') { images.push((await stableCanvasReference(`${fixture}-edit-proof-${label}`, path)).image); continue; }
          const frame = await modeFrame(page, mode);
          if (mode === 'gpu') {
            gpuFrame = frame;
            assert.notEqual(frame.cacheReason, 'admission-deferred', `${fixture}: edited ${label} correctness requires actual admission at the retained pose`);
            assert.equal(frame.rendered, false, `${fixture}: ${label} preserves full Canvas at the original nonzero twist`);
            if (supportsGPU || poseDependentBudget) assert.ok(frame.reason?.includes(nativeRotationReason), `${fixture}: ${label} refuses only for the owned native-context rotation limitation`);
            assert.equal(frame.bytes, 0); assert.equal(frame.uploadCalls, 0);
            if (frame.rendered && (!poseDependentBudget || label !== 'baseline' || setup.warm.rendered)) {
              assert.equal(frame.cacheHit, true, `${fixture}: ${label} comparison retains the edited cache`);
              assert.equal(frame.uploadKind, 'none', `${fixture}: ${label} comparison cannot hide a patch behind a new upload`);
              assert.equal(frame.bytes, 0);
              assert.equal(frame.uploadCalls, 0);
            }
          }
          await page.locator('#drawing').screenshot({ path });
          images.push(PNG.sync.read(readFileSync(path)));
        }
        assert.equal(images[0].width, images[1].width); assert.equal(images[0].height, images[1].height);
        const diff = new PNG({ width: images[0].width, height: images[0].height });
        const pixels = pixelmatch(images[0].data, images[1].data, diff.data, diff.width, diff.height, { threshold: 0.15 });
        const miss = Math.max(missedForeground(images[0], images[1]), missedForeground(images[1], images[0]));
        writeFileSync(resolve(out, `${fixture}-edit-proof-${label}-diff.png`), PNG.sync.write(diff));
        assert.ok(miss < 0.005, `${fixture}: ${label} edited geometry matches within two pixels`);
        if (!gpuFrame.rendered) {
          assert.equal(pixels, 0, `${fixture}: ${label} fallback matches Canvas exactly`);
          assert.equal(Buffer.compare(images[0].data, images[1].data), 0, `${fixture}: ${label} fallback has identical RGBA pixels`);
        } else if (!denseRaster) assert.ok(pixels / (diff.width * diff.height) < 0.001, `${fixture}: ${label} preserves the raster accuracy gate`);
        assert.deepEqual(await page.evaluate(() => { const v = window.editor.viewport; return { center: { ...v.center }, scale: v.scale, twist: v.twist }; }), setup.camera, `${fixture}: ${label} comparison keeps the original warm edit camera`);
        const restorationInvariants = await captureRestorationInvariants(label);
        if (label === 'baseline') baselineInvariants = restorationInvariants;
        else assert.deepEqual(restorationInvariants.view, baselineInvariants.view, `${fixture}: ${label} preserves the complete camera, physical surface, DPR, rectangle and overlays`);
        proofImages[label] = images;
        editCorrectness.comparisons[label] = { gpuFrame, actualRenderer: gpuFrame.rendered ? 'gpu' : 'canvas', poseDependentBudgetAdmission: poseDependentBudget, restorationInvariants, imageDifferenceFraction: pixels / (diff.width * diff.height), twoPixelCoverageMissFraction: miss };
      };
      const transition = async (action) => {
        const proof = await page.evaluate(async ({ action, edited, original, budgetPose }) => {
          const ed = window.editor, api = window.gpuPrototype;
          const previous = ed.doc.snapshot;
          if (action === 'edit') {
            ed.doc.replaceEntities([edited]);
            const retained = /** @type {any} */ (window).__gpuBenchmarkRestoreSnapshots;
            retained.edited = ed.doc.snapshot; retained.editedJson = JSON.stringify(ed.doc.snapshot);
          }
          else if (action === 'undo') { if (!ed.doc.undo()) throw new Error('Warm edit proof cannot undo'); }
          else if (action === 'redo') { if (!ed.doc.redo()) throw new Error('Warm edit proof cannot redo'); }
          else throw new Error(`Unknown edit proof action ${action}`);
          if (budgetPose) { api.setMode('canvas'); api.setMode('gpu'); }
          const frame = api.renderNow();
          let completionMs = null;
          if (frame.rendered) {
            completionMs = await api.completed();
            if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error(`${action}: edit proof GPU completion was not observed`);
          } else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
          if (ed.doc.snapshot === previous) throw new Error(`${action}: edit proof drawing transition was a no-op`);
          const expected = action === 'undo' ? original : edited;
          if (JSON.stringify(ed.doc.entities.find((entity) => entity.id === original.id)) !== JSON.stringify(expected)) throw new Error(`${action}: edit proof did not change/restore the requested entity`);
          const retained = /** @type {any} */ (window).__gpuBenchmarkRestoreSnapshots;
          if (ed.doc.snapshot !== (action === 'undo' ? retained.baseline : retained.edited)) throw new Error(`${action}: edit proof must retain the exact snapshot object identity`);
          if (JSON.stringify(ed.doc.snapshot) !== (action === 'undo' ? retained.baselineJson : retained.editedJson)) throw new Error(`${action}: edit proof must retain the complete document JSON`);
          return { frame, completionMs, actualLine: expected, snapshotIdentityMatches: true, documentJsonMatches: true };
        }, { action, edited: setup.edited, original: setup.original, budgetPose: poseDependentBudget });
        assert.notEqual(proof.frame.cacheReason, 'admission-deferred', 'Twisted edit transition proves actual current-state admission');
        assert.equal(proof.frame.rendered, false, `${fixture}: ${action} preserves complete Canvas at the original twist`);
        if (supportsGPU || poseDependentBudget) assert.ok(proof.frame.reason?.includes(nativeRotationReason), `${fixture}: ${action} cannot substitute an unknown GPU failure for the native-context limitation`);
        assert.equal(proof.frame.bytes, 0); assert.equal(proof.frame.uploadCalls, 0);
        if (proof.frame.rendered && (supportsDeltas || (poseDependentBudget && proof.frame.cacheReason === 'document-delta'))) {
          assert.equal(proof.frame.cacheReason, 'document-delta', `${fixture}: ${action} uses partial scene preparation`);
          assert.equal(proof.frame.uploadKind, 'subrange', `${fixture}: ${action} updates the live GPU buffer`);
          assert.equal(proof.frame.bytes, 168, `${fixture}: ${action} uploads only six line vertices`);
          assert.equal(proof.frame.uploadCalls, 1);
          assert.equal(proof.frame.subrangeUploadBytes, 168);
          assert.equal(proof.frame.subrangeUploadCalls, 1);
          assert.ok(proof.frame.preparedEntities <= 1);
          if (action !== 'edit') assert.equal(proof.frame.editMemoHit, true, `${fixture}: ${action} reuses owned prior line geometry`);
        } else if (proof.frame.rendered) {
          assert.equal(proof.frame.cacheReason, 'document', `${fixture}: ${action} prepares the complete compound scene`);
          assert.equal(proof.frame.uploadKind, 'full', `${fixture}: ${action} cannot patch an uncertified compound slot`);
          assert.equal(proof.frame.subrangeUploadBytes, 0);
          assert.equal(proof.frame.subrangeUploadCalls, 0);
          assert.equal(proof.frame.editMemoHit, false);
        }
        editCorrectness.transitions[action] = proof;
      };
      await compareEditedState('baseline');
      await transition('edit');
      await compareEditedState('edited-before-undo');
      const changedCanvas = pixelmatch(proofImages.baseline[0].data, proofImages['edited-before-undo'][0].data, null, proofImages.baseline[0].width, proofImages.baseline[0].height, { threshold: 0.15 });
      const changedGpu = pixelmatch(proofImages.baseline[1].data, proofImages['edited-before-undo'][1].data, null, proofImages.baseline[1].width, proofImages.baseline[1].height, { threshold: 0.15 });
      const changedCanvasRgba = changedRgbaPixels(proofImages.baseline[0], proofImages['edited-before-undo'][0]);
      const changedGpuRgba = changedRgbaPixels(proofImages.baseline[1], proofImages['edited-before-undo'][1]);
      editCorrectness.editedImageChanged = { canvasPixels: changedCanvas, gpuPixels: changedGpu, canvasRawRgbaPixels: changedCanvasRgba, gpuRawRgbaPixels: changedGpuRgba, displacementCss: setup.displacementCss };
      assert.ok(changedCanvas > 0 && changedGpu > 0, `${fixture}: the edited line must visibly change both completed images before undo`);
      assert.ok(changedCanvasRgba > 0 && changedGpuRgba > 0, `${fixture}: edited images must have raw RGBA changes before undo`);
      const assertRestoration = (beforeLabel, afterLabel) => {
        const before = proofImages[beforeLabel], after = proofImages[afterLabel];
        const originalCrossStateRgba = { canvasBufferCompare: Buffer.compare(before[0].data, after[0].data), requestedGpuBufferCompare: Buffer.compare(before[1].data, after[1].data) };
        const pngSha256 = Object.fromEntries([beforeLabel, afterLabel].flatMap((label) => ['canvas', 'gpu'].map((mode) => [`${label}-${mode}`, createHash('sha256').update(readFileSync(resolve(out, `${fixture}-edit-proof-${label}-${mode}.png`))).digest('hex')])));
        if (editCorrectness.comparisons[afterLabel].gpuFrame.rendered) {
          assert.equal(originalCrossStateRgba.requestedGpuBufferCompare, 0, `${fixture}: ${afterLabel} restores the exact GPU RGBA image`);
          editCorrectness.restorationControls[afterLabel] = { beforeLabel, originalCrossStateRgba, pngSha256, actualRenderer: 'gpu', exactGpuRestoration: true };
          return;
        }
        const control = analyzeFallbackRestoration(before[0], after[0], before[1], after[1]);
        editCorrectness.restorationControls[afterLabel] = { beforeLabel, originalCrossStateRgba, pngSha256, actualRenderer: 'canvas', ...control,
          semantics: 'The original cross-state RGBA result remains evidence. Any native-reference drift is inconclusive; fallback must reproduce the signed Native Canvas restoration change exactly, without a pixel tolerance.' };
        assert.equal(control.differentialMatches, true, `${fixture}: ${afterLabel} fallback signed RGBA restoration must equal Native Canvas byte for byte`);
      };
      await transition('undo');
      await compareEditedState('undo');
      assertRestoration('baseline', 'undo');
      await transition('redo');
      await compareEditedState('redo');
      assertRestoration('edited-before-undo', 'redo');
      editCorrectness.nativeReferenceOutcome = Object.values(editCorrectness.restorationControls).some((control) => control.nativeReferenceOutcome === 'inconclusive') ? 'inconclusive' : 'exact';
      editCorrectness.relativeCanvasRestorationOutcome = 'passed';
      await transition('undo');
      assert.equal(await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot)), proofBaseline.document, `${fixture}: edit proof restores the exact drawing snapshot`);
      editCorrectness.snapshotRestored = true;
    } finally {
      // An assertion failure must not leave a private benchmark document edited.
      await page.evaluate(async ({ camera, baselineDocument }) => {
        const ed = window.editor, v = ed.viewport, api = window.gpuPrototype;
        try {
          if (JSON.stringify(ed.doc.snapshot) !== baselineDocument && !ed.doc.undo()) throw new Error('Edit proof cleanup could not undo its owned edit');
          if (JSON.stringify(ed.doc.snapshot) !== baselineDocument) throw new Error('Edit proof cleanup did not restore its original drawing snapshot');
          v.center = camera.center; v.scale = camera.scale; v.twist = camera.twist;
          const frame = api.renderNow();
          if (frame.rendered) {
            const completionMs = await api.completed();
            if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('Edit proof camera cleanup completion was not observed');
          } else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
        } finally { delete /** @type {any} */ (window).__gpuBenchmarkRestoreSnapshots; }
      }, { camera: proofBaseline.camera, baselineDocument: proofBaseline.document });
    }
    result.comparisons[fixture] = { expectedSupportsGPU: supportsGPU, poseDependentBudgetAdmission: poseDependentBudget, aggregateRendererScope: poseDependentBudget ? 'Baseline budget refusal; requested-GPU workflows may mix actual GPU/Canvas/deferred policy, with per-frame and by-renderer metrics' : 'Fixed fixture admission classification', canvas: canvasResult, gpu: gpuResult, prototypeContext: context, panOnly: { canvas: panCanvas, gpu: panGpu, endpoint: panImage }, boundedZoom: { canvas: boundedCanvas, gpu: boundedGpu, endpoint: boundedImage }, sustainedZoom: { canvas: sustainedCanvas, gpu: sustainedGpu, endpoint: sustainedImage }, offCenterZoom: { canvas: offCenterCanvas, gpu: offCenterGpu, endpoint: offCenterImage }, cacheEnvelopeEdges: { min: { canvas: minEdgeCanvas, gpu: minEdgeGpu, endpoint: minEdgeImage }, max: { canvas: maxEdgeCanvas, gpu: maxEdgeGpu, endpoint: maxEdgeImage } }, editUndo: { canvas: editCanvas, gpu: editGpu, endpoint: editImage, correctness: editCorrectness }, trajectoryEndpoints, wholeViewFallbackEndpoints: poseDependentBudget ? Object.fromEntries(Object.entries(trajectoryEndpoints).filter(([, endpoint]) => !endpoint.gpuFrame.rendered)) : supportsGPU ? null : trajectoryEndpoints, imageDifferenceFraction: pixels / (a.width * a.height), twoPixelCoverageMissFraction: coverageMiss };
    Object.assign(result.comparisons[fixture], { originalCameraEditCertificate });
    Object.assign(result.comparisons[fixture], { fixtureDescription, expectedSupportsDeltas: supportsDeltas, expectedFallbackReason: fallbackReason, expectedFallbackReasons: fixture === 'mixed-schematic' ? mixedSchematicFallbackReasons : null, centeredActualAdmission: centeredGpuFrame, rasterGate: poseDependentBudget ? 'Exact RGBA whenever Canvas; when actually GPU-admitted, dense raster difference reported with unchanged bidirectional two-pixel coverage gate' : denseRaster ? 'Dense raster difference reported; unchanged bidirectional two-pixel coverage gate' : supportsGPU ? 'Strict pixelmatch fraction <0.001 and bidirectional two-pixel miss <0.005' : 'Complete-view Canvas with identical RGBA pixels' });
    for (const [name, canvas, gpu] of [['pan/zoom', canvasResult, gpuResult], ['pan', panCanvas, panGpu], ['bounded zoom', boundedCanvas, boundedGpu], ['sustained zoom', sustainedCanvas, sustainedGpu], ['off-center zoom', offCenterCanvas, offCenterGpu], ['minimum zoom with edge pan', minEdgeCanvas, minEdgeGpu], ['maximum zoom with edge pan', maxEdgeCanvas, maxEdgeGpu], ['edit/undo', editCanvas, editGpu]]) {
      assert.deepEqual(canvas.camera.initial, gpu.camera.initial, `${fixture}: ${name} pairs start at identical cameras`);
      assert.ok([canvas.firstFrame, ...canvas.warmRedraw.samples, ...canvas.frameSamples].every((frame) => frame.rendered === false), `${fixture}: ${name} baseline samples must use Canvas`);
    }
    for (const [name, workload] of [['pan/zoom', gpuResult], ['pan', panGpu], ['bounded zoom', boundedGpu], ['sustained zoom', sustainedGpu], ['off-center zoom', offCenterGpu], ['minimum zoom with edge pan', minEdgeGpu], ['maximum zoom with edge pan', maxEdgeGpu], ['edit/undo', editGpu]]) {
      const completedSamples = [workload.firstFrame, ...workload.warmRedraw.samples, ...workload.frameSamples];
      if (fixture === 'compound-dense') {
        assert.notEqual(workload.firstFrame.gpuAttempt.cacheReason, 'admission-deferred', `${fixture}: ${name} cold resources require actual geometry admission`);
        assert.equal(workload.firstFrame.reason, 'Stroke geometry exceeds prototype budget', `${fixture}: ${name} cold frame records actual exact budget refusal`);
      }
      if (!poseDependentBudget) assert.ok(completedSamples.every((frame) => frame.rendered === supportsGPU), `${fixture}: ${name} samples must not silently mix GPU and Canvas renderers; refusal: ${completedSamples.find((frame) => frame.rendered !== supportsGPU)?.reason ?? 'none'}`);
      if (fallbackReason) assert.ok(completedSamples.filter((frame) => !frame.rendered).every((frame) => matchesBenchmarkFallbackReason(fixture, fallbackReason, frame.reason)), `${fixture}: ${name} actual fallback frames keep their safety reason; actual: ${completedSamples.find((frame) => !frame.rendered && !matchesBenchmarkFallbackReason(fixture, fallbackReason, frame.reason))?.reason ?? 'none'}`);
      if (fixture === 'mixed-schematic') for (const frame of completedSamples) {
        assert.equal(frame.actualRenderer, 'canvas');
        assert.equal(frame.gpuAttempt.uploadKind, 'none');
        assert.equal(frame.gpuAttempt.requestedUploadBytes, 0);
        assert.equal(frame.gpuAttempt.uploadCalls, 0);
        assert.equal(frame.gpuAttempt.drawSubmissionMs, 0);
      }
      if (supportsGPU) assert.equal(workload.firstFrame.cacheReason, 'cold', `${fixture}: ${name} mode-triggered first frame includes cold geometry work`);
    }
    if (fixture === 'mixed-schematic') {
      const refusalMemoProof = { warmRedrawFrames: 0, movingPoseRetries: [], unchangedViewImage: null };
      for (const [label, workload] of [['pan/zoom', gpuResult], ['pan', panGpu], ['bounded zoom', boundedGpu], ['sustained zoom', sustainedGpu], ['off-center zoom', offCenterGpu], ['minimum zoom with edge pan', minEdgeGpu], ['maximum zoom with edge pan', maxEdgeGpu], ['edit/undo', editGpu]]) {
        assert.notEqual(workload.firstFrame.gpuAttempt.cacheReason, 'refusal-hit', `${fixture}: ${label} cold resource setup retries actual geometry admission`);
        assert.ok(workload.firstFrame.gpuAttempt.geometryPreparationMs > 0, `${fixture}: ${label} cold refusal includes actual geometry preparation`);
        assert.equal(workload.warmRedraw.samples.length, 15);
        for (const frame of workload.warmRedraw.samples) {
          const attempt = frame.gpuAttempt;
          assert.equal(frame.actualRenderer, 'canvas');
          assert.equal(attempt.cacheReason, 'refusal-hit', `${fixture}: unchanged ${label} redraw reuses only its exact-view refusal`);
          assert.equal(attempt.geometryPreparationMs, 0);
          assert.equal(attempt.partialPreparationMs, 0);
          assert.equal(attempt.uploadKind, 'none');
          assert.equal(attempt.requestedUploadBytes, 0);
          assert.equal(attempt.uploadCalls, 0);
          refusalMemoProof.warmRedrawFrames++;
        }
        if (workload.motion !== 'edit-undo') {
          let previous = workload.warmRedraw.samples.at(-1);
          let changedPoses = 0;
          for (const frame of workload.frameSamples) {
            const changedPose = !Object.is(previous.scale, frame.scale) || !Object.is(previous.twist, frame.twist) || !Object.is(previous.center.x, frame.center.x) || !Object.is(previous.center.y, frame.center.y);
            if (changedPose) {
              assert.notEqual(frame.gpuAttempt.cacheReason, 'refusal-hit', `${fixture}: ${label} changed camera retries instead of reusing a stale refusal`);
              assert.ok(frame.gpuAttempt.geometryPreparationMs > 0, `${fixture}: ${label} retry measures actual geometry preparation`);
              assert.equal(frame.actualRenderer, 'canvas');
              assert.ok(matchesBenchmarkFallbackReason(fixture, fallbackReason, frame.reason));
              assert.equal(frame.gpuAttempt.requestedUploadBytes, 0);
              assert.equal(frame.gpuAttempt.uploadCalls, 0);
              changedPoses++;
            }
            previous = frame;
          }
          assert.ok(changedPoses > 0, `${fixture}: ${label} includes actual camera transitions`);
          refusalMemoProof.movingPoseRetries.push({ label, changedPoses, samples: workload.frameSamples.length });
        }
      }
      // Endpoint references toggle the mode and deliberately clear refusal memo.
      // Prove one completed Canvas image through the unchanged memo-hit path too.
      const memoFrame = await page.evaluate(() => window.gpuPrototype.renderNow());
      assert.equal(memoFrame.rendered, false);
      assert.equal(memoFrame.cacheReason, 'refusal-hit');
      assert.equal(memoFrame.geometryPreparationMs, 0);
      assert.equal(memoFrame.bytes, 0); assert.equal(memoFrame.uploadCalls, 0);
      assert.deepEqual(await page.evaluate(() => { const v = window.editor.viewport; return { center: { ...v.center }, scale: v.scale, twist: v.twist }; }), canvasResult.camera.initial);
      const memoImagePath = resolve(out, `${fixture}-unchanged-refusal-memo.png`);
      await page.locator('#drawing').screenshot({ path: memoImagePath });
      const memoImage = PNG.sync.read(readFileSync(memoImagePath));
      assert.equal(Buffer.compare(a.data, memoImage.data), 0, 'Unchanged refusal-memo frame still completes the exact original Canvas view');
      refusalMemoProof.unchangedViewImage = { frame: memoFrame, identicalCanvasRgba: true, actualRenderer: 'canvas', untimed: true };
      Object.assign(result.comparisons[fixture], { refusalMemoProof });
    }
    if (!centeredGpuFrame.rendered) {
      if (!poseDependentBudget) assert.equal(gpuResult.status.rendered, false, `${fixture}: unsupported full scene must fall back`);
      assert.equal(pixels, 0, 'whole-view fallback must match Canvas exactly');
      assert.equal(Buffer.compare(a.data, b.data), 0, `${fixture}: centered whole-view fallback has identical RGBA pixels`);
    } else if (poseDependentBudget) {
      assert.ok(coverageMiss < 0.005, `${fixture}: actually admitted centered budget scene retains the unchanged dense coverage gate`);
    } else {
      assert.equal(gpuResult.status.rendered, true, `${fixture} uses GPU`);
      assert.equal(gpuResult.firstFrame.cacheReason, 'cold', `${fixture}: mode-triggered first frame includes cold geometry work`);
      assert.ok(panGpu.uploadedBytes.every((bytes) => bytes === 0), `${fixture}: bounded pan reuses uploaded geometry`);
      for (const [name, workload] of [['bounded zoom', boundedGpu], ['off-center bounded zoom', offCenterGpu], ['minimum zoom with edge pan', minEdgeGpu], ['maximum zoom with edge pan', maxEdgeGpu]]) {
        assert.ok(workload.frameSamples.every((frame) => frame.rendered && frame.cacheHit === true && frame.uploadBytes === 0 && frame.uploadCalls === 0), `${fixture}: ${name} reuses geometry without uploads for all 30 frames`);
      }
      const initialInterval = { minRatio: sustainedGpu.firstFrame.cacheMinRatio, maxRatio: sustainedGpu.firstFrame.cacheMaxRatio };
      assert.ok(initialInterval.minRatio > 0 && initialInterval.minRatio <= 1 && Number.isFinite(initialInterval.minRatio) && initialInterval.maxRatio >= 1 && Number.isFinite(initialInterval.maxRatio), `${fixture}: sustained zoom reports its actual cold geometry certificate`);
      if (fixture === 'compound-tags' || fixture === 'dense-lines') assert.ok(initialInterval.maxRatio >= 1.02 ** 30, `${fixture}: the representative straight-stroke certificate includes the unchanged sustained-zoom endpoint`);
      const sustainedRatios = sustainedGpu.frameSamples.map((frame) => frame.scale / sustainedGpu.firstFrame.scale);
      const remainsCertified = sustainedRatios.every((ratio) => ratio >= initialInterval.minRatio && ratio <= initialInterval.maxRatio);
      Object.assign(result.comparisons[fixture], { sustainedZoomCertificate: { initialInterval, anchorScale: sustainedGpu.firstFrame.scale, prescribedEndpointRatio: 1.02 ** 30, actualEndpointRatio: sustainedRatios.at(-1), allThirtySamplesInsideInitialCertificate: remainsCertified } });
      if (remainsCertified) {
        for (const frame of sustainedGpu.frameSamples) {
          assert.equal(frame.actualRenderer, 'gpu'); assert.equal(frame.cacheHit, true);
          assert.equal(frame.geometryPreparationMs, 0); assert.equal(frame.partialPreparationMs, 0);
          assert.equal(frame.uploadKind, 'none'); assert.equal(frame.uploadBytes, 0); assert.equal(frame.uploadCalls, 0);
        }
      } else assert.ok(sustainedGpu.frameSamples.some((frame) => frame.cacheReason === 'zoom-range' && frame.uploadKind === 'full' && frame.uploadCalls > 0), `${fixture}: crossing the actual sustained-zoom certificate reports a full rebuild/upload`);
      if (supportsDeltas) {
        assert.ok(editGpu.frameSamples.every((frame) => frame.cacheReason === 'document-delta' && frame.uploadKind === 'subrange' && frame.uploadBytes === 168 && frame.uploadCalls === 1 && frame.subrangeUploadBytes === 168 && frame.subrangeUploadCalls === 1 && frame.preparedEntities <= 1), `${fixture}: all 30 visible edit/undo frames update one six-vertex subrange`);
        assert.equal(editGpu.summary.rebuildFrameIndices.length, 0, `${fixture}: delta updates must not be counted as full-scene rebuilds`);
        assert.equal(editGpu.summary.fullUploadFrameIndices.length, 0, `${fixture}: valid edit/undo workloads do not upload the full scene`);
        assert.ok(editGpu.frameSamples.filter((frame) => frame.label === 'undo-line-edit').every((frame) => frame.editMemoHit === true && frame.preparedEntities === 0 && frame.partialPreparationMs === 0), `${fixture}: timed undo frames reuse memoized owned line geometry`);
      } else {
        assert.ok(editGpu.frameSamples.every((frame) => frame.cacheReason === 'document' && frame.uploadKind === 'full' && frame.subrangeUploadBytes === 0 && frame.subrangeUploadCalls === 0), `${fixture}: all 30 compound edit/undo frames use complete preparation/uploads`);
        assert.equal(editGpu.summary.rebuildFrameIndices.length, 30);
        assert.equal(editGpu.summary.subrangeUploadFrameIndices.length, 0);
      }
      assert.ok(coverageMiss < 0.005, `${fixture}: supported geometry matches within two pixels`);
      if (!denseRaster) assert.ok(pixels / (a.width * a.height) < 0.001, `${fixture}: bounded raster differences`);
    }
    console.log(`${fixture}: Canvas ${canvasResult.totalRenderMedianMs.toFixed(2)} ms, requested GPU ${gpuResult.totalRenderMedianMs.toFixed(2)} ms (actual ${gpuResult.firstFrame.actualRenderer}); image difference ${(100 * pixels / (a.width * a.height)).toFixed(3)}%; ${gpuResult.status.reason ?? 'GPU'}`);
    console.log(`${fixture} pan only: Canvas ${panCanvas.totalRenderMedianMs.toFixed(2)} ms, requested GPU ${panGpu.totalRenderMedianMs.toFixed(2)} ms (actual ${panGpu.firstFrame.actualRenderer}); requested-GPU viewport CPU ${panGpu.cpuSubmissionMedianMs.toFixed(2)} ms, uploads ${panGpu.uploadedBytes.filter((bytes) => bytes > 0).length}/${panGpu.samples}`);
    for (const [name, canvas, gpu] of [['bounded zoom', boundedCanvas, boundedGpu], ['sustained zoom', sustainedCanvas, sustainedGpu], ['off-center zoom', offCenterCanvas, offCenterGpu], ['minimum zoom with edge pan', minEdgeCanvas, minEdgeGpu], ['maximum zoom with edge pan', maxEdgeCanvas, maxEdgeGpu], ['edit/undo', editCanvas, editGpu]]) {
      console.log(`${fixture} ${name}: completed-frame median/p95/max Canvas ${canvas.totalRenderMedianMs.toFixed(2)}/${canvas.totalRenderP95Ms.toFixed(2)}/${canvas.totalRenderMaxMs.toFixed(2)} ms, requested GPU ${gpu.totalRenderMedianMs.toFixed(2)}/${gpu.totalRenderP95Ms.toFixed(2)}/${gpu.totalRenderMaxMs.toFixed(2)} ms; full-preparation frames ${gpu.summary.rebuildFrameIndices.join(',') || 'none'}; delta frames ${gpu.summary.documentDeltaFrameIndices.join(',') || 'none'}; full/subrange uploads ${gpu.summary.fullUploadFrameIndices.length}/${gpu.summary.subrangeUploadFrameIndices.length}`);
    }
    // Compare a translated cached frame too: a centered image alone cannot detect missing
    // strokes that entered through the cache's overscan border or a wrong translation sign.
    await page.evaluate(() => { const v = window.editor.viewport; v.panByPixels(24 / v.dpr, -17 / v.dpr); });
    const pannedImages = [];
    let pannedGpuFrame;
    for (const mode of ['canvas', 'gpu']) {
      const path = resolve(out, `${fixture}-pan-${mode}.png`);
      if (mode === 'canvas' && !supportsGPU) { pannedImages.push((await stableCanvasReference(`${fixture}-legacy-panned`, path)).image); continue; }
      const status = await modeFrame(page, mode);
      if (mode === 'gpu') {
        pannedGpuFrame = status;
        assert.notEqual(status.cacheReason, 'admission-deferred', `${fixture}: legacy pan correctness requires actual current-pose admission`);
        if (!poseDependentBudget) assert.equal(status.rendered, supportsGPU, `${fixture}: legacy pan retains its fixed admission classification`);
      }
      if (mode === 'gpu' && supportsGPU) {
        assert.equal(status.rendered, true, `${fixture}: panned comparison uses GPU`);
        assert.equal(status.bytes, 0, `${fixture}: panned comparison reuses uploaded geometry`);
      }
      await page.locator('#drawing').screenshot({ path });
      pannedImages.push(PNG.sync.read(readFileSync(path)));
    }
    const panMiss = Math.max(missedForeground(pannedImages[0], pannedImages[1]), missedForeground(pannedImages[1], pannedImages[0]));
    if (!pannedGpuFrame.rendered) {
      assert.equal(pixelmatch(pannedImages[0].data, pannedImages[1].data, null, pannedImages[0].width, pannedImages[0].height, { threshold: 0.15 }), 0, `${fixture}: legacy panned whole-view fallback matches Canvas exactly`);
      assert.equal(Buffer.compare(pannedImages[0].data, pannedImages[1].data), 0, `${fixture}: legacy panned whole-view fallback has identical RGBA pixels`);
    }
    result.comparisons[fixture].pannedTwoPixelCoverageMissFraction = panMiss;
    if (poseDependentBudget) Object.assign(result.comparisons[fixture], { pannedActualAdmission: pannedGpuFrame, pannedImageDifferenceFraction: pixelmatch(pannedImages[0].data, pannedImages[1].data, null, pannedImages[0].width, pannedImages[0].height, { threshold: 0.15 }) / (pannedImages[0].width * pannedImages[0].height) });
    assert.ok(panMiss < 0.005, `${fixture}: cached panned frame matches geometry within two pixels`);
    const cadenceFixture = result.noReadbackCadence.comparisons[fixture];
    if (cadenceFixture) {
      const endpointLinks = [];
      for (const [motion, endpoint, legacyCanvas, legacyGpu] of [['pan', panImage, panCanvas, panGpu], ['bounded-zoom', boundedImage, boundedCanvas, boundedGpu], ['sustained-zoom', sustainedImage, sustainedCanvas, sustainedGpu], ['edit-undo', editImage, editCanvas, editGpu]]) {
        const cadencePair = cadenceFixture.workflows[motion];
        if (motion === 'edit-undo') for (const [mode, legacy] of [['canvas', legacyCanvas], ['gpu', legacyGpu]]) assert.equal(cadencePair[mode].topLevelLineEdit.id, legacy.editUndo.entityId, `${fixture}: the later ${mode} timing and correctness use the frozen fresh-phase LINE`);
        for (const [mode, legacy] of [['canvas', legacyCanvas], ['gpu', legacyGpu]]) {
          assert.deepEqual(cadencePair[mode].initialCamera, legacy.camera.initial, `${fixture}: no-readback ${motion} ${mode} uses the same source-specific strict-image initial camera`);
          assert.deepEqual(cadencePair[mode].terminalCamera, endpoint.camera, `${fixture}: no-readback ${motion} ${mode} terminal camera is covered by the later completed-frame strict accuracy image`);
        }
        endpointLinks.push({ motion, initialCamera: cadencePair.canvas.initialCamera, terminalCamera: endpoint.camera, laterLegacyStrictEndpoint: endpoint, editedFrameFreshness: motion === 'edit-undo' ? editCorrectness.editedImageChanged : null, sameSourceAndFixture: true, separateLaterReadbackPhase: true });
      }
      Object.assign(cadenceFixture, { laterSourceSpecificAccuracy: endpointLinks });
    }
    if (fixture === 'compound-tags' || fixture === 'dense-lines') {
      const sustainedRatio = 1.02 ** 30;
      const saved = await page.evaluate(() => { const ed = window.editor, v = ed.viewport; return { document: JSON.stringify(ed.doc.snapshot), mode: window.gpuPrototype.status().mode, camera: { center: { ...v.center }, scale: v.scale, twist: v.twist } }; });
      const boundary = { outcome: 'started', untimedCorrectnessProbe: true, fixture, originalSustainedRatio: sustainedRatio, originalSustainedEndpointUnchanged: true, singleExplicitColdSetup: true, resetsDuringWarmOrBoundaryFrames: false, documentUnchanged: false, cameraRestored: false, samples: {}, accuracy: {} };
      Object.assign(result.comparisons[fixture], { certifiedZoomBoundary: boundary });
      const timedFrame = (scale, modeTrigger = false) => page.evaluate(async ({ scale, modeTrigger }) => {
        const api = window.gpuPrototype, v = window.editor.viewport, original = v.render;
        let resolveFrame, rejectFrame, timer;
        const observed = new Promise((resolve, reject) => { resolveFrame = resolve; rejectFrame = reject; });
        v.render = /** @this {any} */ function (overlay) {
          const started = performance.now();
          try { original.call(this, overlay); resolveFrame({ frame: api.renderStats(), viewportRenderCpuMs: performance.now() - started }); }
          catch (error) { rejectFrame(error); throw error; }
        };
        try {
          timer = setTimeout(() => rejectFrame(new Error('Certified interval probe did not render within 10 seconds')), 10000);
          const started = performance.now();
          if (scale !== null) v.scale = scale;
          if (modeTrigger) api.setMode('gpu'); else api.renderNow();
          const sample = /** @type {any} */ (await observed), completionStarted = performance.now();
          let reportedCompletionMs = null;
          if (sample.frame.rendered) {
            reportedCompletionMs = await api.completed();
            if (!(typeof reportedCompletionMs === 'number' && Number.isFinite(reportedCompletionMs) && reportedCompletionMs >= 0)) throw new Error('Certified interval GPU fence completion was not observed');
          } else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
          return { ...sample, observedCompletionWaitMs: performance.now() - completionStarted, completedFrameWallMs: performance.now() - started, reportedCompletionMs, actualRenderer: sample.frame.rendered ? 'gpu' : 'canvas', camera: { center: { ...v.center }, scale: v.scale, twist: v.twist }, semantics: 'Actual viewport CPU and fence/readback completed wall observation; preparation/upload CPU issuance are in frame stages; excludes desktop presentation' };
        } finally { clearTimeout(timer); v.render = original; }
      }, { scale, modeTrigger });
      const accuracyAtCurrentPose = async (label) => {
        const canvas = (await stableCanvasReference(`${fixture}-certified-${label}`, resolve(out, `${fixture}-certified-${label}-canvas.png`))).image;
        const gpuFrame = await modeFrame(page, 'gpu');
        assert.notEqual(gpuFrame.cacheReason, 'admission-deferred', 'Interval correctness uses actual current-pose admission');
        const path = resolve(out, `${fixture}-certified-${label}-gpu.png`);
        await page.locator('#drawing').screenshot({ path });
        const gpu = PNG.sync.read(readFileSync(path)), diff = new PNG({ width: canvas.width, height: canvas.height });
        const pixels = pixelmatch(canvas.data, gpu.data, diff.data, diff.width, diff.height, { threshold: 0.15 });
        const miss = Math.max(missedForeground(canvas, gpu), missedForeground(gpu, canvas));
        writeFileSync(resolve(out, `${fixture}-certified-${label}-diff.png`), PNG.sync.write(diff));
        assert.ok(miss < 0.005, 'Certified/beyond-interval dense scene retains the unchanged bidirectional coverage gate');
        if (!gpuFrame.rendered) { assert.equal(pixels, 0); assert.equal(Buffer.compare(canvas.data, gpu.data), 0, 'Beyond-interval refusal preserves complete exact Canvas'); }
        else { assert.equal(gpuFrame.cacheHit, true, 'Endpoint images retain the just-prepared live scene'); assert.equal(gpuFrame.bytes, 0); assert.equal(gpuFrame.uploadCalls, 0); }
        boundary.accuracy[label] = { gpuFrame, actualRenderer: gpuFrame.rendered ? 'gpu' : 'canvas', imageDifferenceFraction: pixels / (diff.width * diff.height), twoPixelCoverageMissFraction: miss, rawDifferentPixels: changedRgbaPixels(canvas, gpu) };
      };
      try {
        await page.evaluate(() => { const api = window.gpuPrototype; api.setMode('canvas'); api.reset2DRenderer(); });
        const cold = await timedFrame(null, true);
        boundary.samples.cold = cold;
        assert.equal(cold.frame.rendered, true); assert.equal(cold.frame.cacheReason, 'cold');
        assert.ok(cold.frame.cacheMinRatio > 0 && cold.frame.cacheMinRatio <= 1 && Number.isFinite(cold.frame.cacheMinRatio) && cold.frame.cacheMaxRatio >= 1 && Number.isFinite(cold.frame.cacheMaxRatio), 'The separate boundary probe reports its actual stored certificate');
        assert.ok(cold.frame.cacheMaxRatio >= sustainedRatio, `${fixture}: the separately prepared straight-stroke certificate includes the original sustained endpoint`);
        Object.assign(boundary, { anchorCamera: cold.camera, actualCertifiedInterval: { minRatio: cold.frame.cacheMinRatio, maxRatio: cold.frame.cacheMaxRatio, minScale: cold.camera.scale * cold.frame.cacheMinRatio, maxScale: cold.camera.scale * cold.frame.cacheMaxRatio } });
        const insideRatio = cold.frame.cacheMaxRatio * (1 - 1e-6), outsideRatio = cold.frame.cacheMaxRatio * 1.01;
        const inside = await timedFrame(cold.camera.scale * insideRatio);
        boundary.samples.inside = inside;
        assert.equal(inside.frame.rendered, true); assert.equal(inside.frame.cacheHit, true);
        assert.equal(inside.frame.geometryPreparationMs, 0); assert.equal(inside.frame.bytes, 0); assert.equal(inside.frame.uploadCalls, 0);
        await accuracyAtCurrentPose('inside');
        const outside = await timedFrame(cold.camera.scale * outsideRatio);
        boundary.samples.beyond = outside;
        assert.equal(outside.frame.cacheReason, 'zoom-range', 'Crossing the actual stored certificate requires a genuine admission retry');
        assert.ok(outside.frame.geometryPreparationMs > 0, 'Beyond-interval geometry preparation is measured explicitly');
        if (outside.frame.rendered) { assert.equal(outside.frame.cacheHit, false); assert.equal(outside.frame.uploadKind, 'full'); assert.ok(outside.frame.bytes > 0); assert.ok(outside.frame.uploadCalls > 0); }
        else { assert.equal(outside.frame.bytes, 0); assert.equal(outside.frame.uploadCalls, 0); assert.equal(outside.frame.uploadKind, 'none'); }
        await accuracyAtCurrentPose('beyond');
        assert.equal(await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot)), saved.document);
        boundary.documentUnchanged = true; boundary.outcome = 'passed';
      } finally {
        await page.evaluate(({ camera, mode }) => { const v = window.editor.viewport; v.center = camera.center; v.scale = camera.scale; v.twist = camera.twist; window.gpuPrototype.setMode(mode); }, { camera: saved.camera, mode: saved.mode });
        await modeFrame(page, saved.mode);
        const restored = await page.evaluate(() => { const v = window.editor.viewport; return { center: { ...v.center }, scale: v.scale, twist: v.twist }; });
        assert.deepEqual(restored, saved.camera); boundary.cameraRestored = true;
        assert.equal(await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot)), saved.document);
      }
    }
  }
  activeFixture = 'compound-untimed-correctness';
  // Compound checks use the application's painter, Drawing transactions, codecs,
  // preload/IPC and atomic saves. Only native file-dialog answers are queued.
  const compoundEvidence = { comparisons: {}, interiorProbes: [], glyphHighlights: [], dependencyTransitions: [], contextRecovery: null, largeCoordinates: null, saveReopen: null };
  const pairAtCurrent = async (label, expectedGPU, requireWarm = false) => {
    const images = [];
    let gpuFrame;
    for (const mode of ['canvas', 'gpu']) {
      const path = resolve(out, `${label}-${mode}.png`);
      if (mode === 'canvas' && !expectedGPU) { images.push((await stableCanvasReference(label, path)).image); continue; }
      const frame = await modeFrame(page, mode);
      if (mode === 'gpu') {
        gpuFrame = frame;
        assert.notEqual(frame.cacheReason, 'admission-deferred', `${label}: mode toggle requires actual same-pose admission for correctness`);
        assert.equal(frame.rendered, expectedGPU, `${label}: expected actual renderer; refusal: ${frame.reason ?? 'none'}`);
        if (expectedGPU && requireWarm) {
          assert.equal(frame.cacheHit, true, `${label}: comparison retains prepared compound scene`);
          assert.equal(frame.uploadKind, 'none', `${label}: comparison retains uploaded compound scene`);
          assert.equal(frame.bytes, 0); assert.equal(frame.uploadCalls, 0);
        }
      }
      await page.locator('#drawing').screenshot({ path });
      images.push(PNG.sync.read(readFileSync(path)));
    }
    assert.equal(images[0].width, images[1].width); assert.equal(images[0].height, images[1].height);
    const diff = new PNG({ width: images[0].width, height: images[0].height });
    const pixels = pixelmatch(images[0].data, images[1].data, diff.data, diff.width, diff.height, { threshold: 0.15 });
    const miss = Math.max(missedForeground(images[0], images[1]), missedForeground(images[1], images[0]));
    writeFileSync(resolve(out, `${label}-diff.png`), PNG.sync.write(diff));
    assert.ok(miss < 0.005, `${label}: complete geometric coverage`);
    if (expectedGPU) assert.ok(pixels / (diff.width * diff.height) < 0.001, `${label}: unchanged strict compound raster gate`);
    else {
      assert.equal(pixels, 0, `${label}: complete-view fallback matches Canvas exactly`);
      assert.equal(Buffer.compare(images[0].data, images[1].data), 0, `${label}: fallback has identical RGBA pixels`);
    }
    const evidence = { gpuFrame, imageDifferenceFraction: pixels / (diff.width * diff.height), twoPixelCoverageMissFraction: miss, rawDifferentPixels: changedRgbaPixels(images[0], images[1]) };
    compoundEvidence.comparisons[label] = evidence;
    return { images, evidence };
  };
  await page.evaluate(() => { window.gpuPrototype.setMode('canvas'); window.editor.selection.clear(); window.editor.setHover(null); window.gpuPrototype.loadFixture('compound-ordered'); });
  const ordinaryCompound = await pairAtCurrent('compound-order-interiors', true);
  const probePositions = await page.evaluate(() => {
    const v = window.editor.viewport;
    return window.gpuPrototype.fixtureMetadata().probes.map((probe) => ({ ...probe, screen: v.toScreen(probe.point), viewport: { width: v.width, height: v.height } }));
  });
  for (const probe of probePositions) {
    const colors = ordinaryCompound.images.map((image) => {
      const x = Math.round(probe.screen.x * image.width / probe.viewport.width), y = Math.round(probe.screen.y * image.height / probe.viewport.height);
      assert.ok(x > 0 && y > 0 && x < image.width - 1 && y < image.height - 1, `${probe.label}: visible interior probe`);
      const index = (y * image.width + x) * 4;
      return [...image.data.subarray(index, index + 4)];
    });
    for (const rgba of colors) {
      assert.ok(probe.rgb.every((value, index) => Math.abs(value - rgba[index]) <= 2), `${probe.label}: interior preserves drawing order/truecolor`);
      assert.equal(rgba[3], 255);
    }
    compoundEvidence.interiorProbes.push({ label: probe.label, screen: probe.screen, expectedRgb: probe.rgb, canvasRgba: colors[0], gpuRgba: colors[1] });
  }
  const glyphProbePositions = await page.evaluate(() => {
    const v = window.editor.viewport, metadata = window.gpuPrototype.fixtureMetadata();
    return metadata.highlightProbes.map((probe) => ({ ...probe, screen: v.toScreen(probe.point), regionScreen: probe.region.map((point) => v.toScreen(point)), viewport: { width: v.width, height: v.height }, background: v.settings.background }));
  });
  const glyphPixel = (image, probe) => {
    const x = Math.floor(probe.screen.x * image.width / probe.viewport.width), y = Math.floor(probe.screen.y * image.height / probe.viewport.height);
    assert.ok(x >= 0 && y >= 0 && x < image.width && y < image.height, `${probe.label}: visible overlapping-stroke interior`);
    const index = (y * image.width + x) * 4;
    return [...image.data.subarray(index, index + 4)];
  };
  const glyphRegionChanges = (baseline, highlighted, probe) => {
    const xs = probe.regionScreen.map((point) => point.x * baseline.width / probe.viewport.width), ys = probe.regionScreen.map((point) => point.y * baseline.height / probe.viewport.height);
    const region = { left: Math.max(0, Math.floor(Math.min(...xs))), right: Math.min(baseline.width - 1, Math.ceil(Math.max(...xs))), top: Math.max(0, Math.floor(Math.min(...ys))), bottom: Math.min(baseline.height - 1, Math.ceil(Math.max(...ys))) };
    let rawDifferentPixels = 0;
    for (let y = region.top; y <= region.bottom; y++) for (let x = region.left; x <= region.right; x++) {
      const index = (y * baseline.width + x) * 4;
      if ([0, 1, 2, 3].some((channel) => baseline.data[index + channel] !== highlighted.data[index + channel])) rawDifferentPixels++;
    }
    return { region, rawDifferentPixels, excludesInsertionGrip: true };
  };
  for (const probe of glyphProbePositions) for (const image of ordinaryCompound.images) {
    const rgba = glyphPixel(image, probe);
    assert.ok(probe.rgb.every((channel, index) => Math.abs(channel - rgba[index]) <= 2), `${probe.label}: ordinary overlapping glyph has an opaque foreground interior`);
    assert.equal(rgba[3], 255);
  }
  const controlsRegion = await page.evaluate(() => {
    const v = window.editor.viewport;
    return { label: 'TEXT-CONTROLS visible letter interiors beyond insertion grip', regionScreen: [{ x: -5.7, y: 3.1 }, { x: -2, y: 3.38 }].map((point) => v.toScreen(point)), viewport: { width: v.width, height: v.height } };
  });
  for (const owner of ['TEXT-CONTROLS', 'BLOCK-OWNER', 'TEXT-ALPHA-CROSS']) {
    await page.evaluate((id) => { const ed = window.editor; ed.viewport.settings.selectionEffect = 'solid'; ed.selection.add(id); ed.render(); }, owner);
    const selectedPair = await pairAtCurrent(`compound-${owner}-selected`, true);
    await page.evaluate((id) => { const ed = window.editor; ed.selection.clear(); ed.setHover(id); }, owner);
    const hoveredPair = await pairAtCurrent(`compound-${owner}-hovered`, true);
    const probe = glyphProbePositions.find((probe) => probe.owner === owner);
    for (const { highlight, pair } of [{ highlight: 'selected', pair: selectedPair }, { highlight: 'hovered', pair: hoveredPair }]) {
      const regionProof = ordinaryCompound.images.map((image, index) => glyphRegionChanges(image, pair.images[index], probe ?? controlsRegion));
      assert.ok(regionProof.every((proof) => proof.rawDifferentPixels > 0), `${owner}: ${highlight} changes actual glyph pixels outside insertion grips in both renderers`);
      const interior = probe ? pair.images.map((image) => glyphPixel(image, probe)) : null;
      const expectedAlphaOnce = probe ? probe.rgb.map((value, index) => Math.round(0.95 * value + 0.05 * [33, 40, 48][index])) : null;
      if (probe) {
        assert.equal(probe.background.toLowerCase(), '#212830', 'Independent alpha oracle uses the actual opaque fixture background');
        for (const rgba of interior) {
          assert.ok(expectedAlphaOnce.every((value, index) => Math.abs(value - rgba[index]) <= 2), `${probe.label}: ${highlight} composites 0.95 opacity once across overlapping glyph subpaths; expected ${expectedAlphaOnce}, actual ${rgba}`);
          assert.equal(rgba[3], 255);
        }
      }
      compoundEvidence.glyphHighlights.push({ owner, highlight, regionProof: { canvas: regionProof[0], gpu: regionProof[1] }, overlapInterior: probe ? { label: probe.label, screen: probe.screen, expectedAlpha: 0.95, expectedRgba: [...expectedAlphaOnce, 255], baselineCanvasRgba: glyphPixel(ordinaryCompound.images[0], probe), baselineGpuRgba: glyphPixel(ordinaryCompound.images[1], probe), canvasRgba: interior[0], gpuRgba: interior[1], independentFontDataIntersection: true } : null });
    }
    await page.evaluate(() => { window.editor.setHover(null); window.editor.selection.clear(); window.editor.render(); });
  }
  const qtextBaseline = await page.evaluate(() => { const ed = window.editor, v = ed.viewport; return { document: JSON.stringify(ed.doc.snapshot), camera: { center: { ...v.center }, scale: v.scale, twist: v.twist } }; });
  const qtextTransitions = [];
  try {
    for (const pixels of [2.49, 2.5, 2.51]) {
      const transition = await page.evaluate(async (pixels) => {
        const ed = window.editor, v = ed.viewport, api = window.gpuPrototype;
        const entity = ed.doc.entities.find((entity) => entity.id === 'TEXT-QTEXT');
        ed.doc.replaceEntities([{ ...entity, height: pixels / v.scale }]);
        const frame = api.renderNow(), completionMs = frame.rendered ? await api.completed() : null;
        if (frame.rendered && !(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('QTEXT transition GPU completion was not observed');
        return { requestedPixels: pixels, actualPixels: ed.doc.entities.find((entity) => entity.id === 'TEXT-QTEXT').height * v.scale, frame, completionMs };
      }, pixels);
      assert.equal(transition.frame.rendered, true, 'QTEXT native thresholds are supported at ordinary coordinates');
      assert.equal(transition.frame.uploadKind, 'full', 'Compound QTEXT edit prepares/uploads the changed scene');
      const pair = await pairAtCurrent(`compound-qtext-${String(pixels).replace('.', '-')}`, true, true);
      qtextTransitions.push({ ...transition, accuracy: pair.evidence });
    }
    // A real camera zoom crosses the current glyph/placeholder decision. Record
    // that rebuild, rather than incorrectly requiring every narrow-band zoom to hit.
    const crossing = await page.evaluate(async () => {
      const v = window.editor.viewport, api = window.gpuPrototype;
      v.zoomAt({ x: v.width / 2, y: v.height / 2 }, 2.49 / 2.51);
      const frame = api.renderNow(), completionMs = frame.rendered ? await api.completed() : null;
      if (frame.rendered && !(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('QTEXT camera crossing completion was not observed');
      return { actualPixels: window.editor.doc.entities.find((entity) => entity.id === 'TEXT-QTEXT').height * v.scale, frame, completionMs };
    });
    assert.equal(crossing.frame.rendered, true);
    assert.equal(crossing.frame.cacheReason, 'zoom-range', 'QTEXT camera crossing rebuilds before stale glyph reuse');
    assert.equal(crossing.frame.uploadKind, 'full');
    qtextTransitions.push({ ...crossing, accuracy: (await pairAtCurrent('compound-qtext-camera-crossing', true, true)).evidence });
  } finally {
    await page.evaluate(async (baseline) => {
      const ed = window.editor, v = ed.viewport, api = window.gpuPrototype;
      for (let count = 0; JSON.stringify(ed.doc.snapshot) !== baseline.document && count < 3; count++) if (!ed.doc.undo()) throw new Error('QTEXT owned edits could not be undone');
      if (JSON.stringify(ed.doc.snapshot) !== baseline.document) throw new Error('QTEXT cleanup did not restore its exact snapshot');
      v.center = baseline.camera.center; v.scale = baseline.camera.scale; v.twist = baseline.camera.twist;
      const frame = api.renderNow();
      if (frame.rendered) { const completed = await api.completed(); if (!(typeof completed === 'number' && Number.isFinite(completed) && completed >= 0)) throw new Error('QTEXT cleanup completion was not observed'); }
    }, qtextBaseline);
  }
  Object.assign(compoundEvidence, { qtextTransitions });
  const compoundBaseline = await page.evaluate(() => {
    const ed = window.editor, v = ed.viewport;
    return { document: JSON.stringify(ed.doc.snapshot), camera: { center: { ...v.center }, scale: v.scale, twist: v.twist } };
  });
  const baselinePair = await pairAtCurrent('compound-dependency-baseline', true);
  const mutateDependency = async (action, undoOf = null) => {
    const transition = await page.evaluate(async (action) => {
      const ed = window.editor, api = window.gpuPrototype, metadata = api.fixtureMetadata();
      const before = ed.doc.snapshot;
      if (action === 'block-redefine') {
        const block = ed.doc.snapshot.blocks[metadata.block];
        ed.doc.defineBlock({ ...block, entities: block.entities.map((entity) => entity.id === 'ordered-wire' ? { ...entity, a: { x: entity.a.x + 0.25, y: entity.a.y }, b: { x: entity.b.x + 0.25, y: entity.b.y }, trueColor: 0xaa44ff } : entity) });
      } else if (action === 'style-to-ttf') {
        ed.doc.transact((state) => {
          const styles = state.meta.textStyles;
          return { ...state, meta: { ...state.meta, textStyles: { ...styles, [metadata.textStyle]: { ...styles[metadata.textStyle], font: 'arial.ttf' } } } };
        });
      } else if (action === 'undo') { if (!ed.doc.undo()) throw new Error('Compound dependency change cannot be undone'); }
      else throw new Error(`Unknown compound dependency action ${action}`);
      if (ed.doc.snapshot === before) throw new Error(`${action}: dependency edit was a no-op`);
      const frame = api.renderNow();
      let completionMs = null;
      if (frame.rendered) {
        completionMs = await api.completed();
        if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error(`${action}: compound GPU completion was not observed`);
      } else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
      return { action, frame, completionMs, camera: { center: { ...ed.viewport.center }, scale: ed.viewport.scale, twist: ed.viewport.twist } };
    }, action);
    assert.deepEqual(transition.camera, compoundBaseline.camera, `${action}: dependency mutation keeps the actual camera/renderer owner`);
    assert.equal(transition.frame.subrangeUploadCalls, 0, `${action}: dependency edits cannot patch primitive slots`);
    if (action === 'style-to-ttf') {
      assert.equal(transition.frame.rendered, false, 'Unsupported STYLE change falls back before partial submission');
      assert.equal(transition.frame.uploadCalls, 0);
    } else {
      assert.equal(transition.frame.rendered, true, `${action}: supported compound scene renders`);
      if (action === 'undo' && undoOf === 'style-refusal') {
        // The refused STYLE produced no GL upload. Restoring the exact previous
        // immutable dependencies can therefore reuse its still-valid GPU scene.
        // A full repair is valid too; neither path may patch compound slots.
        assert.ok(['none', 'full'].includes(transition.frame.uploadKind), 'STYLE-refusal undo uses a valid warm scene or full repair');
        if (transition.frame.uploadKind === 'none') {
          assert.equal(transition.frame.cacheHit, true, 'Zero-upload STYLE undo retains the prior valid prepared scene');
          assert.equal(transition.frame.bytes, 0);
          assert.equal(transition.frame.uploadCalls, 0);
        } else assert.ok(transition.frame.uploadCalls > 0, 'Full STYLE-undo repair reports actual upload issuance');
      } else assert.equal(transition.frame.uploadKind, 'full', `${action}: changed block geometry invalidates the uploaded scene`);
    }
    Object.assign(transition, { undoOf });
    compoundEvidence.dependencyTransitions.push(transition);
    return transition;
  };
  await mutateDependency('block-redefine');
  const redefinedPair = await pairAtCurrent('compound-block-redefined', true, true);
  const blockChangedCanvas = changedRgbaPixels(baselinePair.images[0], redefinedPair.images[0]);
  const blockChangedGpu = changedRgbaPixels(baselinePair.images[1], redefinedPair.images[1]);
  assert.ok(blockChangedCanvas > 0 && blockChangedGpu > 0, 'Block redefinition visibly changes both current completed images');
  compoundEvidence.dependencyTransitions.at(-1).rawChangedPixels = { canvas: blockChangedCanvas, gpu: blockChangedGpu };
  await mutateDependency('undo', 'block-redefine');
  const blockUndo = await pairAtCurrent('compound-block-undo', true, true);
  assert.equal(Buffer.compare(baselinePair.images[1].data, blockUndo.images[1].data), 0, 'Block undo restores exact original GPU image');
  await mutateDependency('style-to-ttf');
  const ttfPair = await pairAtCurrent('compound-style-ttf-fallback', false);
  assert.ok(changedRgbaPixels(baselinePair.images[0], ttfPair.images[0]) > 0, 'STYLE change visibly changes actual Canvas text');
  await mutateDependency('undo', 'style-refusal');
  const styleUndo = await pairAtCurrent('compound-style-undo', true, true);
  assert.equal(Buffer.compare(baselinePair.images[1].data, styleUndo.images[1].data), 0, 'STYLE undo restores exact original GPU image');
  assert.equal(await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot)), compoundBaseline.document, 'Both dependency edits/undos preserve the original complete snapshot');
  // Recovery after compound dependency invalidations exercises the same current
  // scene, camera and renderer owner. This is WebGL-loss proof, not GPU-process proof.
  const compoundWarm = await page.evaluate(async () => {
    const v = window.editor.viewport, api = window.gpuPrototype;
    v.zoomAt({ x: v.width / 2, y: v.height / 2 }, 1.05); v.panByPixels(18 / v.dpr, -12 / v.dpr);
    const frame = api.renderNow(), completionMs = await api.completed();
    if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('Warm compound recovery completion was not observed');
    return { frame, completionMs, document: JSON.stringify(window.editor.doc.snapshot), camera: { center: { ...v.center }, scale: v.scale, twist: v.twist } };
  });
  assert.equal(compoundWarm.frame.rendered, true); assert.equal(compoundWarm.frame.cacheHit, true); assert.equal(compoundWarm.frame.bytes, 0); assert.equal(compoundWarm.frame.uploadCalls, 0);
  const warmCompoundPair = await pairAtCurrent('compound-recovery-warm', true, true);
  const compoundBefore = await prototypeContext(page);
  await page.evaluate(() => window.gpuPrototype.loseContext());
  await page.waitForFunction(() => window.gpuPrototype.status().device === 'lost');
  const lostCompoundPair = await pairAtCurrent('compound-recovery-lost-full-fallback', false);
  await page.evaluate(() => window.gpuPrototype.restoreContext());
  await page.waitForFunction(() => window.gpuPrototype.status().device === 'ready');
  const restoredCompound = await modeFrame(page, 'gpu');
  assert.equal(restoredCompound.rendered, true);
  const restoredCompoundPair = await pairAtCurrent('compound-recovery-restored', true, true);
  assert.equal(await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot)), compoundWarm.document);
  assert.deepEqual(await page.evaluate(() => { const v = window.editor.viewport; return { center: { ...v.center }, scale: v.scale, twist: v.twist }; }), compoundWarm.camera);
  compoundEvidence.contextRecovery = { warm: compoundWarm, before: compoundBefore, lost: lostCompoundPair.evidence, restored: restoredCompound, after: await prototypeContext(page), accuracy: restoredCompoundPair.evidence, warmAccuracy: warmCompoundPair.evidence, documentUnchanged: true, cameraUnchanged: true, scope: 'Actual WebGL context loss/restoration after warm block redefinition and STYLE undo; no compound GPU-process recovery claim.' };
  // Independent near-origin input has the same representable native anchors and
  // block definitions. Record Canvas quantization separately; far fallback does
  // not claim that its geometry matches the near-origin mathematical reference.
  await page.evaluate(() => { window.gpuPrototype.setMode('canvas'); window.gpuPrototype.loadFixture('compound-trillion-reference'); });
  const nearCompound = await pairAtCurrent('compound-trillion-near-origin-reference', true);
  await page.evaluate(() => { window.gpuPrototype.setMode('canvas'); window.gpuPrototype.loadFixture('compound-trillion'); });
  const farCompound = await pairAtCurrent('compound-trillion-precision-fallback', false);
  const farCanvasDiff = pixelmatch(nearCompound.images[0].data, farCompound.images[0].data, null, nearCompound.images[0].width, nearCompound.images[0].height, { threshold: 0.15 });
  compoundEvidence.largeCoordinates = { nearOrigin: nearCompound.evidence, farOrigin: farCompound.evidence, canvasNearVsFarImageDifferenceFraction: farCanvasDiff / (nearCompound.images[0].width * nearCompound.images[0].height), canvasNearVsFarRawDifferentPixels: changedRgbaPixels(nearCompound.images[0], farCompound.images[0]), parityUnprovenUsesCompleteCanvas: true, origin: { x: 1e12, y: -1e12 }, scale: 4096, nativeAnchorUnit: 1 / 64 };
  // Real save and reopen of the supported compound scene, using the current
  // codecs/IPC. Renderer resources are retained across the file operation.
  await page.evaluate(() => { window.gpuPrototype.setMode('canvas'); window.gpuPrototype.loadFixture('compound-ordered'); });
  const beforeSavePair = await pairAtCurrent('compound-before-save', true);
  const savedNativeOverride = await page.evaluate(() => {
    const ed = window.editor, owner = ed.doc.entities.find((entity) => entity.type === 'insert' && entity.block === 'GPU-ORDERED'), placement = owner.attributePlacements.NATIVE;
    const definition = ed.doc.snapshot.blocks['GPU-ORDERED'].attributes.find((attribute) => attribute.tag === 'NATIVE');
    const fields = (value) => ({ position: value.position, alignmentPoint: value.alignmentPoint, firstAnchor: value.firstAlignmentPoint ?? value.position, height: value.height, widthFactor: value.widthFactor, oblique: value.oblique, align: value.align, justification: value.justification });
    return { override: fields(placement), definition: fields(definition) };
  });
  for (const key of ['position', 'alignmentPoint', 'height', 'widthFactor', 'oblique']) assert.notDeepEqual(savedNativeOverride.override[key], savedNativeOverride.definition[key], `Native ATTRIB ${key} is a visibly distinct per-insert override before saving`);
  const saveCamera = await page.evaluate(() => { const v = window.editor.viewport; return { center: { ...v.center }, scale: v.scale, twist: v.twist }; });
  const savedPath = resolve(out, 'compound-native-save-reopen.dxf');
  await app.evaluate(({ dialog }, path) => {
    const state = /** @type {any} */ (globalThis);
    const nativeDialogs = /** @type {any} */ (dialog);
    state.__compoundDialogs = { save: [path], open: [path], events: [], originalSave: nativeDialogs.showSaveDialog, originalOpen: nativeDialogs.showOpenDialog };
    nativeDialogs.showSaveDialog = async (_window, options) => {
      const next = state.__compoundDialogs.save.shift(); state.__compoundDialogs.events.push({ kind: 'save', title: options?.title, path: next ?? null });
      return next ? { canceled: false, filePath: next } : { canceled: true };
    };
    nativeDialogs.showOpenDialog = async (_window, options) => {
      const next = state.__compoundDialogs.open.shift(); state.__compoundDialogs.events.push({ kind: 'open', title: options?.title, path: next ?? null });
      return next ? { canceled: false, filePaths: [next] } : { canceled: true, filePaths: [] };
    };
  }, savedPath);
  try {
    assert.equal(await page.evaluate(() => window.editor.saveFile(true, 'dxf')), true, 'Compound Save As uses real IPC/DXF/atomic write');
    const savedText = readFileSync(savedPath, 'utf8');
    for (const nativeKind of ['BLOCK', 'ATTDEF', 'ATTRIB', 'TEXT', 'STYLE']) assert.ok(new RegExp(`(?:^|\\r?\\n)[ \\t]*0\\r?\\n${nativeKind}(?:\\r?\\n|$)`).test(savedText), `Saved native ${nativeKind} records exist`);
    for (const value of ['GPU-ORDERED', 'GPU-NESTED', 'GPU-STROKE', 'ATTR', 'FIT TEXT', 'ALIGN']) assert.ok(savedText.includes(value), `Saved native compound data includes ${value}`);
    const priorIds = await page.evaluate(() => window.editor.doc.entities.map((entity) => entity.id));
    assert.equal(await page.evaluate(() => window.editor.openFile()), true, 'Compound reopen uses actual reader/IPC');
    for (let attempts = 0; attempts < 8 && await page.locator('.import-report-dialog').count(); attempts++) await page.locator('.import-report-dialog .modal-footer button').filter({ hasText: /^Close$/ }).first().click();
    assert.equal(await page.locator('.modal').count(), 0, 'Compound reopen has no remaining dialog');
    const reopened = await page.evaluate((camera) => {
      const ed = window.editor, v = ed.viewport;
      v.center = camera.center; v.scale = camera.scale; v.twist = camera.twist;
      return { ids: ed.doc.entities.map((entity) => entity.id), path: ed.doc.filePath, dirty: ed.doc.dirty, blocks: Object.keys(ed.doc.snapshot.blocks), nativeTexts: ed.doc.entities.filter((entity) => entity.type === 'text').map((entity) => ({ text: entity.text, justification: entity.justification, position: entity.position, alignmentPoint: entity.alignmentPoint, widthFactor: entity.widthFactor, oblique: entity.oblique })), owner: ed.doc.entities.find((entity) => entity.type === 'insert' && entity.block === 'GPU-ORDERED') };
    }, saveCamera);
    assert.ok(reopened.ids.every((id) => !priorIds.includes(id)), 'Compound reopen parses fresh entity identities');
    assert.equal(reopened.path, savedPath); assert.equal(reopened.dirty, false);
    assert.ok(reopened.blocks.includes('GPU-ORDERED') && reopened.blocks.includes('GPU-NESTED'));
    assert.equal(reopened.owner.attributes.TAG, 'ATTR');
    assert.ok(reopened.owner.hiddenAttributes.includes('HIDDEN'));
    const reopenedNative = reopened.owner.attributePlacements.NATIVE;
    const reopenedOverride = { position: reopenedNative.position, alignmentPoint: reopenedNative.alignmentPoint, firstAnchor: reopenedNative.firstAlignmentPoint ?? reopenedNative.position, height: reopenedNative.height, widthFactor: reopenedNative.widthFactor, oblique: reopenedNative.oblique, align: reopenedNative.align, justification: reopenedNative.justification };
    assert.deepEqual(reopenedOverride, savedNativeOverride.override, 'Real native ATTRIB reopen retains every distinct saved placement/height/width/oblique/justification value; binding identities are separate metadata');
    assert.equal(reopened.nativeTexts.find((entity) => entity.text === 'FIT TEXT').justification.horizontal, 5);
    assert.equal(reopened.nativeTexts.find((entity) => entity.text === 'ALIGN').justification.horizontal, 3);
    const reopenPair = await pairAtCurrent('compound-after-real-save-reopen', true);
    // Both renderers agreeing after import does not prove the codec preserved the
    // drawing: a lost placement/style could be wrong in both. Check appearance
    // independently against the pre-save Canvas image at the identical camera.
    const roundTripDiff = new PNG({ width: beforeSavePair.images[0].width, height: beforeSavePair.images[0].height });
    assert.equal(reopenPair.images[0].width, roundTripDiff.width); assert.equal(reopenPair.images[0].height, roundTripDiff.height);
    const roundTripPixels = pixelmatch(beforeSavePair.images[0].data, reopenPair.images[0].data, roundTripDiff.data, roundTripDiff.width, roundTripDiff.height, { threshold: 0.15 });
    const roundTripMiss = Math.max(missedForeground(beforeSavePair.images[0], reopenPair.images[0]), missedForeground(reopenPair.images[0], beforeSavePair.images[0]));
    assert.ok(roundTripPixels / (roundTripDiff.width * roundTripDiff.height) < 0.001, 'Native save/reopen preserves the pre-save Canvas raster accuracy gate');
    assert.ok(roundTripMiss < 0.005, 'Native save/reopen preserves pre-save geometry coverage');
    writeFileSync(resolve(out, 'compound-native-save-reopen-roundtrip-diff.png'), PNG.sync.write(roundTripDiff));
    assert.equal(Buffer.compare(readFileSync(savedPath), Buffer.from(savedText)), 0, 'Reading/reopening never changes the saved native bytes');
    const dialogs = await app.evaluate(() => { const d = /** @type {any} */ (globalThis).__compoundDialogs; return { remainingSave: d.save.length, remainingOpen: d.open.length, events: d.events }; });
    assert.equal(dialogs.remainingSave, 0); assert.equal(dialogs.remainingOpen, 0);
    compoundEvidence.saveReopen = { actualIpc: true, atomicSaveSucceeded: true, freshReadIds: true, nativeRecordKinds: ['BLOCK', 'ATTDEF', 'ATTRIB', 'TEXT', 'STYLE'], nativeBytes: Buffer.byteLength(savedText), drawing: reopened, distinctNativeOverride: { beforeSave: savedNativeOverride, reopened: reopenedOverride, exactValuesPreserved: true }, dialogs, accuracy: reopenPair.evidence, canvasRoundTrip: { imageDifferenceFraction: roundTripPixels / (roundTripDiff.width * roundTripDiff.height), twoPixelCoverageMissFraction: roundTripMiss, rawDifferentPixels: changedRgbaPixels(beforeSavePair.images[0], reopenPair.images[0]) }, rendererResourcesReset: false };
  } finally {
    await app.evaluate(({ dialog }) => { const d = /** @type {any} */ (globalThis).__compoundDialogs; const nativeDialogs = /** @type {any} */ (dialog); nativeDialogs.showSaveDialog = d.originalSave; nativeDialogs.showOpenDialog = d.originalOpen; delete /** @type {any} */ (globalThis).__compoundDialogs; });
  }
  Object.assign(result, { compoundCoverage: compoundEvidence });
  result.validation.push('Ordered nested blocks/ATTRIB/stroke TEXT: strict raster, color interiors, selected/hovered whole glyph batches, block/STYLE dependency edit+undo, same-scene WebGL recovery, independent trillion reference/refusal, and actual DXF IPC save/reopen');
  const beforeHatchFixture = activeFixture;
  activeFixture = 'hatch-untimed-correctness';
  await validateNativeHatches({ page, app, root, out, profile, pairAtCurrent, prototypeContext, missedForeground, result });
  activeFixture = beforeHatchFixture;
  const beforeDimensionFixture = activeFixture;
  activeFixture = 'dimension-untimed-correctness';
  await validateNativeDimensions({ page, app, root, out, profile, pairAtCurrent, prototypeContext, missedForeground, result });
  activeFixture = beforeDimensionFixture;
  // Lose the actual device after a proved zoom-cache hit, then verify the restored
  // scene at that same camera before the pre-existing repeated recovery checks.
  await page.evaluate(() => { window.gpuPrototype.setMode('canvas'); window.editor.viewport.twist = 0; window.gpuPrototype.loadFixture('direct-arc-lineweights-control'); });
  const warmZoomStart = await modeFrame(page, 'gpu');
  assert.equal(warmZoomStart.rendered, true, 'Wide-stroke recovery fixture uses GPU');
  await page.evaluate(() => { const v = window.editor.viewport; v.zoomAt({ x: v.width / 2, y: v.height / 2 }, 1.1); });
  const warmZoomHit = await modeFrame(page, 'gpu');
  assert.equal(warmZoomHit.rendered, true);
  assert.equal(warmZoomHit.cacheHit, true, 'Recovery starts after a real warm zoom-cache hit');
  assert.equal(warmZoomHit.bytes, 0);
  assert.equal(warmZoomHit.uploadCalls, 0);
  const zoomRecoveryDocument = await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot));
  const zoomRecoveryCamera = await page.evaluate(() => { const v = window.editor.viewport; return { center: { ...v.center }, scale: v.scale, twist: v.twist }; });
  await modeFrame(page, 'canvas');
  const zoomReferencePath = resolve(out, 'warm-zoom-recovery-canvas.png');
  await page.locator('#drawing').screenshot({ path: zoomReferencePath });
  const beforeZoomLoss = await modeFrame(page, 'gpu');
  assert.equal(beforeZoomLoss.rendered, true);
  assert.equal(beforeZoomLoss.bytes, 0, 'Canvas reference does not reset the warm zoom cache');
  assert.equal(beforeZoomLoss.uploadCalls, 0);
  const zoomContextBefore = await prototypeContext(page);
  await page.evaluate(() => window.gpuPrototype.loseContext());
  await page.waitForFunction(() => window.gpuPrototype.status().device === 'lost');
  assert.equal(await page.evaluate(() => window.gpuPrototype.renderNow().rendered), false);
  await page.evaluate(() => window.gpuPrototype.restoreContext());
  await page.waitForFunction(() => window.gpuPrototype.status().device === 'ready');
  const restoredZoom = await modeFrame(page, 'gpu');
  assert.equal(restoredZoom.rendered, true, 'Restored device draws the zoomed wide-stroke scene');
  const restoredZoomPath = resolve(out, 'warm-zoom-recovery-gpu.png');
  await page.locator('#drawing').screenshot({ path: restoredZoomPath });
  const zoomReference = PNG.sync.read(readFileSync(zoomReferencePath));
  const zoomRestored = PNG.sync.read(readFileSync(restoredZoomPath));
  assert.equal(zoomReference.width, zoomRestored.width); assert.equal(zoomReference.height, zoomRestored.height);
  const zoomDiff = new PNG({ width: zoomReference.width, height: zoomReference.height });
  const zoomPixels = pixelmatch(zoomReference.data, zoomRestored.data, zoomDiff.data, zoomDiff.width, zoomDiff.height, { threshold: 0.15 });
  const zoomMiss = Math.max(missedForeground(zoomReference, zoomRestored), missedForeground(zoomRestored, zoomReference));
  writeFileSync(resolve(out, 'warm-zoom-recovery-diff.png'), PNG.sync.write(zoomDiff));
  assert.ok(zoomMiss < 0.005, 'Restored warm zoom scene retains complete geometry within two pixels');
  assert.ok(zoomPixels / (zoomDiff.width * zoomDiff.height) < 0.001, 'Restored warm zoom scene retains the existing raster accuracy gate');
  assert.equal(await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot)), zoomRecoveryDocument);
  assert.deepEqual(await page.evaluate(() => { const v = window.editor.viewport; return { center: { ...v.center }, scale: v.scale, twist: v.twist }; }), zoomRecoveryCamera);
  result.contextRecovery.push({ scenario: 'loss-after-warm-zoom-hit', fixture: 'direct-arc-lineweights-control', camera: zoomRecoveryCamera, warmZoomHit, beforeZoomLoss, restoredZoom, before: zoomContextBefore, after: await prototypeContext(page), imageDifferenceFraction: zoomPixels / (zoomDiff.width * zoomDiff.height), twoPixelCoverageMissFraction: zoomMiss, documentUnchanged: true });
  result.validation.push('Real context loss after a zero-upload warm zoom hit; restored wide-stroke accuracy and unchanged document/camera');
  // Existing selection logic is unchanged; solid highlight uses the GPU scene and Canvas grips.
  await page.evaluate(() => { const ed = window.editor; window.gpuPrototype.loadFixture('direct-arc-control'); ed.viewport.settings.selectionEffect = 'solid'; ed.selection.add('L'); ed.render(); });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.gpuPrototype.renderNow().rendered), true);
  await page.locator('#drawing').screenshot({ path: resolve(out, 'selection.png') });
  result.validation.push('Distinct direct-ARC control: selection highlight/grips and preflight independent native commands without initial moveTo, width/DPR/0.95 opacity');
  await page.evaluate(() => window.editor.selection.clear());
  for (let cycle = 0; cycle < 2; cycle++) {
    const before = await prototypeContext(page);
    await page.evaluate(() => window.gpuPrototype.loseContext());
    await page.waitForFunction(() => window.gpuPrototype.status().device === 'lost');
    assert.equal(await page.evaluate(() => window.gpuPrototype.renderNow().rendered), false);
    await page.evaluate(() => window.gpuPrototype.restoreContext());
    await page.waitForFunction(() => window.gpuPrototype.status().device === 'ready');
    assert.equal(await page.evaluate(() => window.gpuPrototype.renderNow().rendered), true);
    result.contextRecovery.push({ fixture: 'direct-arc-control', cycle: cycle + 1, before, after: await prototypeContext(page) });
  }
  await page.evaluate(() => window.editor.viewport.settings.gridVisible = true);
  assert.equal(await page.evaluate(() => window.gpuPrototype.renderNow().rendered), false, 'grid layering preserved through full Canvas fallback');
  await page.evaluate(() => window.editor.viewport.settings.gridVisible = false);
  result.validation.push('Two real WebGL context-loss/restoration cycles; grid full-view fallback');
  const before = await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot));
  await page.evaluate(() => window.editor.runCommand('GPU3DDEMO'));
  await page.waitForFunction(() => window.gpuPrototype.status().demo?.state === 'ready' && window.gpuPrototype.status().demo.frames > 0);
  await page.screenshot({ path: resolve(out, 'demo3d.png') });
  const demoCanvas = page.locator('[data-gpu-demo] canvas');
  const object = await page.evaluate(() => window.gpuPrototype.status().demo.objects[0]);
  assert.ok(object.screen?.visible);
  await demoCanvas.click({ position: { x: object.screen.x, y: object.screen.y } });
  assert.equal(await page.evaluate(() => window.gpuPrototype.status().demo.selected), object.id);
  const demoCamera = await page.evaluate(() => window.gpuPrototype.status().demo.camera);
  const box = await demoCanvas.boundingBox();
  await page.mouse.move(box.x + 200, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + 250, box.y + 200, { steps: 8 });
  await page.mouse.up();
  assert.notEqual(await page.evaluate(() => window.gpuPrototype.status().demo.camera.yaw), demoCamera.yaw);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  await page.mouse.move(box.x + 275, box.y + 210, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  assert.notDeepEqual(await page.evaluate(() => window.gpuPrototype.status().demo.camera.target), demoCamera.target);
  const distance = await page.evaluate(() => window.gpuPrototype.status().demo.camera.distance);
  await page.mouse.wheel(0, -100);
  await page.waitForFunction((previous) => window.gpuPrototype.status().demo.camera.distance !== previous, distance);
  await page.getByRole('button', { name: 'Orthographic', exact: true }).click();
  assert.equal(await page.evaluate(() => window.gpuPrototype.status().demo.projection), 'orthographic');
  await page.getByRole('button', { name: 'Perspective', exact: true }).click();
  assert.equal(await page.evaluate(() => window.gpuPrototype.status().demo.projection), 'perspective');
  const framesBeforeLoss = await page.evaluate(() => window.gpuPrototype.status().demo.frames);
  await page.evaluate(() => {
    const gl = /** @type {HTMLCanvasElement} */ (document.querySelector('[data-gpu-demo] canvas')).getContext('webgl2');
    window.__demoLossControl = gl.getExtension('WEBGL_lose_context');
    window.__demoLossControl.loseContext();
  });
  await page.waitForFunction(() => window.gpuPrototype.status().demo.state === 'lost');
  await page.evaluate(() => window.__demoLossControl.restoreContext());
  await page.waitForFunction((previous) => window.gpuPrototype.status().demo.state === 'ready' && window.gpuPrototype.status().demo.frames > previous, framesBeforeLoss);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot)), before);
  result.validation.push('Separate 3D demonstration: orbit/pan/zoom, picking, both projections, context restoration, no document modification');
  await page.evaluate(() => window.editor.runCommand('GPU3DDEMO'));
  await page.waitForFunction(() => window.gpuPrototype.status().demo?.state === 'ready');
  await page.evaluate(() => window.gpuPrototype.dispose());
  assert.equal(await page.evaluate(() => document.querySelectorAll('[data-gpu-prototype="2d"]').length), 0);
  assert.equal(await page.locator('[data-gpu-demo]').count(), 0);
  await page.keyboard.press('Escape');
  result.validation.push('Resource/canvas disposal');
  assert.deepEqual(errors, []);
  writeFileSync(resolve(out, 'comparison.json'), JSON.stringify(result, null, 2));
  console.log('GPU renderer Windows prototype checks passed.');
} catch (error) {
  // Keep failures explicit and separate from successful comparison.json evidence.
  // A refused admission must remain visible even if it happened before a fixture
  // completed all measured workflows and therefore has no published summary.
  let current = null;
  try {
    current = await benchmarkPage?.evaluate(() => {
      const v = window.editor?.viewport;
      return { renderer: window.gpuPrototype?.renderStats(), camera: v ? { center: { ...v.center }, scale: v.scale, twist: v.twist, dpr: v.dpr } : null, fixture: window.gpuPrototype?.fixtureMetadata(), entityCount: window.editor?.doc.entities.length };
    });
  } catch { /* The primary benchmark error remains authoritative after an app failure. */ }
  writeFileSync(resolve(out, 'failure.json'), JSON.stringify({ outcome: 'failed', sourceSha, worktreeModified, activeFixture, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), current, partialResult: result }, null, 2));
  throw error;
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
