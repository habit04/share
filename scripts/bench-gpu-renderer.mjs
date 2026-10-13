// Build first: npx vite build --mode gpu-experimental
// A real Windows Electron run, private profile, identical camera/drawing for both modes.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { applicationWindow } from './electron-window.mjs';

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
try {
  result.scope = await app.evaluate(({ app }, expected) => {
    const path = process.getBuiltinModule('node:path');
    if (path.resolve(app.getPath('userData')).toLowerCase() !== path.resolve(expected).toLowerCase()) throw new Error('Private benchmark profile could not be verified');
    return { privateProfileVerified: true, highPerformanceSwitchPresent: app.commandLine.hasSwitch('force_high_performance_gpu') };
  }, profile);
  assert.equal(result.scope.highPerformanceSwitchPresent, highPerformance, 'Private app GPU preference switch must match the requested CLI mode');
  const page = await applicationWindow(app);
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
  const fixtures = [
    { name: 'curves', supportsGPU: true },
    { name: 'precision', supportsGPU: true },
    { name: 'precision-trillion', supportsGPU: true },
    { name: 'lineweights', supportsGPU: true },
    { name: 'dense-lines', supportsGPU: true },
    { name: 'mixed-schematic', supportsGPU: false },
    { name: 'wide-curve-fallback', supportsGPU: false },
  ];
  for (const { name: fixture, supportsGPU } of fixtures) {
    await page.evaluate((name) => { window.gpuPrototype.setMode('canvas'); window.editor.viewport.twist = 0; window.gpuPrototype.loadFixture(name); }, fixture);
    await page.waitForTimeout(100);
    const measure = async (mode, motion = 'pan-zoom', retainEndCamera = false) => page.evaluate(async ({ mode, samples, motion, retainEndCamera }) => {
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
        if (status.rendered) {
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
        const gpuAttempt = mode === 'gpu' ? { rendered: status.rendered, reason: status.reason ?? null, ...Object.fromEntries([...stages, ...entityMetrics, 'subrangeUploadBytes', 'subrangeUploadCalls'].map((key) => [key, available(key)])), requestedUploadBytes: available('bytes'), uploadCalls: available('uploadCalls'), uploadKind: status.uploadKind ?? null, geometryVertices: available('geometryVertices'), editMemoHit: typeof status.editMemoHit === 'boolean' ? status.editMemoHit : null, cacheHit: typeof status.cacheHit === 'boolean' ? status.cacheHit : null, cacheReason: status.cacheReason ?? null } : null;
        const sample = { label, requestedRenderer: mode, actualRenderer: status.rendered ? 'gpu' : 'canvas', gpuAttempt, rendered: status.rendered, reason: status.reason ?? null, cpuSubmissionMs: renderEnded - renderStarted, renderToCompletionWallMs: completedAt - renderStarted, workflowWallMs: completedAt - started, completedFrameWallMs: completedAt - started, completionWaitMs: completedAt - completionStart, reportedCompletionMs, uploadBytes: status.rendered ? status.bytes : null, uploadCalls: status.rendered ? status.uploadCalls : null, uploadKind: status.rendered ? status.uploadKind : null, subrangeUploadBytes: status.rendered ? status.subrangeUploadBytes : null, subrangeUploadCalls: status.rendered ? status.subrangeUploadCalls : null, geometryVertices: status.rendered ? status.geometryVertices : null, ...Object.fromEntries(entityMetrics.map((key) => [key, status.rendered ? status[key] : null])), editMemoHit: status.rendered ? status.editMemoHit : null, cacheHit: status.rendered ? status.cacheHit : null, cacheReason: status.rendered ? status.cacheReason : 'not-checked', center: { ...v.center }, scale: v.scale, twist: v.twist, ...extra };
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
        return { all: aggregate(frames), rebuild: aggregate(rebuilds), documentDelta: aggregate(deltas), uploads: { full: aggregate(fullUploads), subrange: aggregate(subrangeUploads), none: aggregate(zeroUploads) }, editMemoHits: frames.filter((frame) => frame.rendered && frame.editMemoHit).length, gpuAttempts: { count: attempts.length, completedGpuFrames: attempts.filter((frame) => frame.rendered).length, canvasFallbackFrames: attempts.filter((frame) => !frame.rendered).length, all: aggregateAttempts(attempts), byAction: Object.fromEntries([...new Set(attempts.map((frame) => frame.label))].map((label) => [label, aggregateAttempts(attempts.filter((frame) => frame.label === label))])) }, byAction: Object.fromEntries([...new Set(frames.map((frame) => frame.label))].map((label) => [label, aggregate(frames.filter((frame) => frame.label === label))])), rebuildFrameIndices: indices(rebuilds), documentDeltaFrameIndices: indices(deltas), fullUploadFrameIndices: indices(fullUploads), subrangeUploadFrameIndices: indices(subrangeUploads), zeroUploadFrameIndices: indices(zeroUploads), cacheReasons: frames.reduce((counts, frame) => { counts[frame.cacheReason ?? 'missing-telemetry'] = (counts[frame.cacheReason ?? 'missing-telemetry'] ?? 0) + 1; return counts; }, {}) };
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
      // Prefer the latest visible line in painter order so later wires cannot
      // completely conceal the representative changed line in the dense fixture.
      const editLine = [...ed.doc.entities].reverse().find((entity) => {
        if (entity.type !== 'line') return false;
        const midpoint = v.toScreen({ x: (entity.a.x + entity.b.x) / 2, y: (entity.a.y + entity.b.y) / 2 });
        return midpoint.x >= 0 && midpoint.x <= v.width && midpoint.y >= 0 && midpoint.y <= v.height;
      });
      if (motion === 'edit-undo' && !editLine) throw new Error('Edit benchmark needs a visible existing line');
      const editedLine = editLine ? { ...editLine, a: { x: editLine.a.x + 2 / scale, y: editLine.a.y }, b: { x: editLine.b.x + 2 / scale, y: editLine.b.y } } : null;
      if (motion === 'edit-undo' && editedLine.a.x === editLine.a.x && editedLine.b.x === editLine.b.x) throw new Error('Representative edit is below coordinate precision');
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
      const heap = /** @type {any} */ (performance).memory?.usedJSHeapSize ?? null;
      return { firstSubmissionMs: firstFrame.cpuSubmissionMs, first, firstFrame, coldSetup, redrawCpuMedianMs: redrawSummary.all.cpuSubmissionMs.median, redrawTotalMedianMs: redrawSummary.all.completedFrameWallMs.median, cpuSubmissionMedianMs: summary.all.cpuSubmissionMs.median, completionWaitMedianMs: summary.all.completionWaitMs.median, totalRenderMedianMs: summary.all.completedFrameWallMs.median, totalRenderP95Ms: summary.all.completedFrameWallMs.p95, totalRenderMaxMs: summary.all.completedFrameWallMs.max, preparationMedianMs: summary.all.preparationMs.median, rafWaitMedianMs: summarize(intervals).median, uploadedBytes: frames.map((frame) => frame.uploadBytes), uploadedCalls: frames.map((frame) => frame.uploadCalls), frameSamples: frames, summary, warmRedraw: { samples: redrawFrames, summary: redrawSummary }, camera: { initial: { center, scale, twist }, last: lastCamera, terminalRetained: retainEndCamera, untimedReset: cameraReset }, editUndo: motion === 'edit-undo' ? { entityId: editLine.id, visible: true, snapshotRestored: true } : null, samples, motion, heapBytes: heap, status: api.status() };
    }, { mode, samples: 30, motion, retainEndCamera });
    const compareTrajectoryEnd = async (label, camera, initialCamera) => {
      const terminal = await page.evaluate(() => ({ center: { ...window.editor.viewport.center }, scale: window.editor.viewport.scale, twist: window.editor.viewport.twist }));
      assert.deepEqual(terminal, camera, `${fixture}: ${label} proof starts on the actual terminal camera/cache`);
      const images = [];
      let gpuFrame, evidence;
      try {
        for (const mode of ['canvas', 'gpu']) {
          const frame = await modeFrame(page, mode);
          if (mode === 'gpu') {
            gpuFrame = frame;
            if (supportsGPU) {
              assert.equal(frame.rendered, true, `${fixture}: ${label} comparison uses GPU`);
              assert.equal(frame.bytes, 0, `${fixture}: ${label} comparison reuses the terminal geometry bytes`);
              assert.equal(frame.uploadCalls, 0, `${fixture}: ${label} comparison makes no upload calls`);
            } else assert.equal(frame.rendered, false, `${fixture}: ${label} comparison preserves whole-view fallback`);
          }
          const path = resolve(out, `${fixture}-${label}-${mode}.png`);
          await page.locator('#drawing').screenshot({ path });
          images.push(PNG.sync.read(readFileSync(path)));
        }
        assert.equal(images[0].width, images[1].width); assert.equal(images[0].height, images[1].height);
        const diff = new PNG({ width: images[0].width, height: images[0].height });
        const pixels = pixelmatch(images[0].data, images[1].data, diff.data, diff.width, diff.height, { threshold: 0.15 });
        writeFileSync(resolve(out, `${fixture}-${label}-diff.png`), PNG.sync.write(diff));
        const miss = Math.max(missedForeground(images[0], images[1]), missedForeground(images[1], images[0]));
        assert.ok(miss < 0.005, `${fixture}: ${label} endpoint retains geometry within two pixels`);
        if (!supportsGPU) {
          assert.equal(pixels, 0, `${fixture}: ${label} whole-view fallback matches Canvas exactly`);
          assert.equal(Buffer.compare(images[0].data, images[1].data), 0, `${fixture}: ${label} whole-view fallback has identical RGBA pixels`);
        } else if (fixture !== 'dense-lines') assert.ok(pixels / (diff.width * diff.height) < 0.001, `${fixture}: ${label} endpoint retains the existing raster accuracy gate`);
        evidence = { camera, gpuFrame, imageDifferenceFraction: pixels / (diff.width * diff.height), twoPixelCoverageMissFraction: miss, untimedCameraReset: null };
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
    await page.locator('#drawing').screenshot({ path: resolve(out, `${fixture}-canvas.png`) });
    const gpuResult = await measure('gpu', 'pan-zoom', true);
    const panZoomImage = await compareTrajectoryEnd('pan-zoom', gpuResult.camera.last, gpuResult.camera.initial);
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
    const editCorrectness = { untimed: true, setup: null, transitions: {}, comparisons: {}, editedImageChanged: null, snapshotRestored: false, resourcesReset: false };
    const proofBaseline = await page.evaluate(() => {
      const ed = window.editor, v = ed.viewport;
      return { document: JSON.stringify(ed.doc.snapshot), camera: { center: { ...v.center }, scale: v.scale, twist: v.twist } };
    });
    try {
      const setup = await page.evaluate(async () => {
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
        const anchor = api.renderNow();
        const anchorCompletionMs = await complete(anchor);
        v.zoomAt({ x: v.width / 2, y: v.height / 2 }, 1.05);
        v.panByPixels(24 / v.dpr, -17 / v.dpr);
        const warm = api.renderNow();
        const warmCompletionMs = await complete(warm);
        const original = [...ed.doc.entities].reverse().find((entity) => {
          if (entity.type !== 'line') return false;
          const midpoint = v.toScreen({ x: (entity.a.x + entity.b.x) / 2, y: (entity.a.y + entity.b.y) / 2 });
          return midpoint.x >= 4 && midpoint.x <= v.width - 4 && midpoint.y >= 4 && midpoint.y <= v.height - 4;
        });
        if (!original) throw new Error('Warm-camera edit proof needs a visible line');
        const edited = { ...original, a: { x: original.a.x + 2 / v.scale, y: original.a.y }, b: { x: original.b.x + 2 / v.scale, y: original.b.y } };
        if (edited.a.x === original.a.x && edited.b.x === original.b.x) throw new Error('Warm-camera edit proof is below coordinate precision');
        const screenBefore = v.toScreen(original.a), screenAfter = v.toScreen(edited.a);
        const displacementCss = Math.hypot(screenAfter.x - screenBefore.x, screenAfter.y - screenBefore.y);
        if (!(displacementCss >= 1)) throw new Error('Warm-camera edit must move a visible line by at least one CSS pixel');
        return { anchor, anchorCompletionMs, warm, warmCompletionMs, original, edited, displacementCss, camera: { center: { ...v.center }, scale: v.scale, twist: v.twist } };
      });
      editCorrectness.setup = setup;
      if (supportsGPU) {
        assert.equal(setup.warm.rendered, true, `${fixture}: edit proof starts on GPU`);
        assert.equal(setup.warm.cacheHit, true, `${fixture}: edit proof starts on a warm camera/cache`);
        assert.equal(setup.warm.uploadKind, 'none');
        assert.equal(setup.warm.bytes, 0);
        assert.equal(setup.warm.uploadCalls, 0);
      } else assert.equal(setup.warm.rendered, false, `${fixture}: edit proof retains complete-view fallback`);
      const proofImages = {};
      const compareEditedState = async (label) => {
        const images = [];
        let gpuFrame;
        for (const mode of ['canvas', 'gpu']) {
          const frame = await modeFrame(page, mode);
          if (mode === 'gpu') {
            gpuFrame = frame;
            assert.equal(frame.rendered, supportsGPU, `${fixture}: ${label} has the expected actual renderer`);
            if (supportsGPU) {
              assert.equal(frame.cacheHit, true, `${fixture}: ${label} comparison retains the edited cache`);
              assert.equal(frame.uploadKind, 'none', `${fixture}: ${label} comparison cannot hide a patch behind a new upload`);
              assert.equal(frame.bytes, 0);
              assert.equal(frame.uploadCalls, 0);
            }
          }
          const path = resolve(out, `${fixture}-edit-proof-${label}-${mode}.png`);
          await page.locator('#drawing').screenshot({ path });
          images.push(PNG.sync.read(readFileSync(path)));
        }
        assert.equal(images[0].width, images[1].width); assert.equal(images[0].height, images[1].height);
        const diff = new PNG({ width: images[0].width, height: images[0].height });
        const pixels = pixelmatch(images[0].data, images[1].data, diff.data, diff.width, diff.height, { threshold: 0.15 });
        const miss = Math.max(missedForeground(images[0], images[1]), missedForeground(images[1], images[0]));
        writeFileSync(resolve(out, `${fixture}-edit-proof-${label}-diff.png`), PNG.sync.write(diff));
        assert.ok(miss < 0.005, `${fixture}: ${label} edited geometry matches within two pixels`);
        if (!supportsGPU) {
          assert.equal(pixels, 0, `${fixture}: ${label} fallback matches Canvas exactly`);
          assert.equal(Buffer.compare(images[0].data, images[1].data), 0, `${fixture}: ${label} fallback has identical RGBA pixels`);
        } else if (fixture !== 'dense-lines') assert.ok(pixels / (diff.width * diff.height) < 0.001, `${fixture}: ${label} preserves the raster accuracy gate`);
        assert.deepEqual(await page.evaluate(() => { const v = window.editor.viewport; return { center: { ...v.center }, scale: v.scale, twist: v.twist }; }), setup.camera, `${fixture}: ${label} comparison keeps the original warm edit camera`);
        proofImages[label] = images;
        editCorrectness.comparisons[label] = { gpuFrame, imageDifferenceFraction: pixels / (diff.width * diff.height), twoPixelCoverageMissFraction: miss };
      };
      const transition = async (action) => {
        const proof = await page.evaluate(async ({ action, edited, original }) => {
          const ed = window.editor, api = window.gpuPrototype;
          const previous = ed.doc.snapshot;
          if (action === 'edit') ed.doc.replaceEntities([edited]);
          else if (action === 'undo') { if (!ed.doc.undo()) throw new Error('Warm edit proof cannot undo'); }
          else if (action === 'redo') { if (!ed.doc.redo()) throw new Error('Warm edit proof cannot redo'); }
          else throw new Error(`Unknown edit proof action ${action}`);
          const frame = api.renderNow();
          let completionMs = null;
          if (frame.rendered) {
            completionMs = await api.completed();
            if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error(`${action}: edit proof GPU completion was not observed`);
          } else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
          if (ed.doc.snapshot === previous) throw new Error(`${action}: edit proof drawing transition was a no-op`);
          const expected = action === 'undo' ? original : edited;
          if (JSON.stringify(ed.doc.entities.find((entity) => entity.id === original.id)) !== JSON.stringify(expected)) throw new Error(`${action}: edit proof did not change/restore the requested entity`);
          return { frame, completionMs, actualLine: expected };
        }, { action, edited: setup.edited, original: setup.original });
        assert.equal(proof.frame.rendered, supportsGPU, `${fixture}: ${action} proof preserves actual renderer`);
        if (supportsGPU) {
          assert.equal(proof.frame.cacheReason, 'document-delta', `${fixture}: ${action} uses partial scene preparation`);
          assert.equal(proof.frame.uploadKind, 'subrange', `${fixture}: ${action} updates the live GPU buffer`);
          assert.equal(proof.frame.bytes, 168, `${fixture}: ${action} uploads only six line vertices`);
          assert.equal(proof.frame.uploadCalls, 1);
          assert.equal(proof.frame.subrangeUploadBytes, 168);
          assert.equal(proof.frame.subrangeUploadCalls, 1);
          assert.ok(proof.frame.preparedEntities <= 1);
          if (action !== 'edit') assert.equal(proof.frame.editMemoHit, true, `${fixture}: ${action} reuses owned prior line geometry`);
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
      assert.ok(changedCanvas > 0 && changedGpu > 0, `${fixture}: the edited line must visibly change both completed images before undo`);
      assert.ok(changedCanvasRgba > 0 && changedGpuRgba > 0, `${fixture}: edited images must have raw RGBA changes before undo`);
      editCorrectness.editedImageChanged = { canvasPixels: changedCanvas, gpuPixels: changedGpu, canvasRawRgbaPixels: changedCanvasRgba, gpuRawRgbaPixels: changedGpuRgba, displacementCss: setup.displacementCss };
      await transition('undo');
      await compareEditedState('undo');
      assert.equal(Buffer.compare(proofImages.baseline[1].data, proofImages.undo[1].data), 0, `${fixture}: undo restores the original GPU/fallback RGBA image`);
      await transition('redo');
      await compareEditedState('redo');
      assert.equal(Buffer.compare(proofImages['edited-before-undo'][1].data, proofImages.redo[1].data), 0, `${fixture}: redo restores the edited GPU/fallback RGBA image`);
      await transition('undo');
      assert.equal(await page.evaluate(() => JSON.stringify(window.editor.doc.snapshot)), proofBaseline.document, `${fixture}: edit proof restores the exact drawing snapshot`);
      editCorrectness.snapshotRestored = true;
    } finally {
      // An assertion failure must not leave a private benchmark document edited.
      await page.evaluate(async ({ camera, baselineDocument }) => {
        const ed = window.editor, v = ed.viewport, api = window.gpuPrototype;
        if (JSON.stringify(ed.doc.snapshot) !== baselineDocument && !ed.doc.undo()) throw new Error('Edit proof cleanup could not undo its owned edit');
        if (JSON.stringify(ed.doc.snapshot) !== baselineDocument) throw new Error('Edit proof cleanup did not restore its original drawing snapshot');
        v.center = camera.center; v.scale = camera.scale; v.twist = camera.twist;
        const frame = api.renderNow();
        if (frame.rendered) {
          const completionMs = await api.completed();
          if (!(typeof completionMs === 'number' && Number.isFinite(completionMs) && completionMs >= 0)) throw new Error('Edit proof camera cleanup completion was not observed');
        } else /** @type {HTMLCanvasElement} */ (document.getElementById('drawing')).getContext('2d').getImageData(0, 0, 1, 1);
      }, { camera: proofBaseline.camera, baselineDocument: proofBaseline.document });
    }
    result.comparisons[fixture] = { expectedSupportsGPU: supportsGPU, canvas: canvasResult, gpu: gpuResult, prototypeContext: context, panOnly: { canvas: panCanvas, gpu: panGpu, endpoint: panImage }, boundedZoom: { canvas: boundedCanvas, gpu: boundedGpu, endpoint: boundedImage }, sustainedZoom: { canvas: sustainedCanvas, gpu: sustainedGpu, endpoint: sustainedImage }, offCenterZoom: { canvas: offCenterCanvas, gpu: offCenterGpu, endpoint: offCenterImage }, cacheEnvelopeEdges: { min: { canvas: minEdgeCanvas, gpu: minEdgeGpu, endpoint: minEdgeImage }, max: { canvas: maxEdgeCanvas, gpu: maxEdgeGpu, endpoint: maxEdgeImage } }, editUndo: { canvas: editCanvas, gpu: editGpu, endpoint: editImage, correctness: editCorrectness }, trajectoryEndpoints, wholeViewFallbackEndpoints: supportsGPU ? null : trajectoryEndpoints, imageDifferenceFraction: pixels / (a.width * a.height), twoPixelCoverageMissFraction: coverageMiss };
    for (const [name, canvas, gpu] of [['pan/zoom', canvasResult, gpuResult], ['pan', panCanvas, panGpu], ['bounded zoom', boundedCanvas, boundedGpu], ['sustained zoom', sustainedCanvas, sustainedGpu], ['off-center zoom', offCenterCanvas, offCenterGpu], ['minimum zoom with edge pan', minEdgeCanvas, minEdgeGpu], ['maximum zoom with edge pan', maxEdgeCanvas, maxEdgeGpu], ['edit/undo', editCanvas, editGpu]]) {
      assert.deepEqual(canvas.camera.initial, gpu.camera.initial, `${fixture}: ${name} pairs start at identical cameras`);
      assert.ok([canvas.firstFrame, ...canvas.warmRedraw.samples, ...canvas.frameSamples].every((frame) => frame.rendered === false), `${fixture}: ${name} baseline samples must use Canvas`);
    }
    for (const [name, workload] of [['pan/zoom', gpuResult], ['pan', panGpu], ['bounded zoom', boundedGpu], ['sustained zoom', sustainedGpu], ['off-center zoom', offCenterGpu], ['minimum zoom with edge pan', minEdgeGpu], ['maximum zoom with edge pan', maxEdgeGpu], ['edit/undo', editGpu]]) {
      assert.ok([workload.firstFrame, ...workload.warmRedraw.samples, ...workload.frameSamples].every((frame) => frame.rendered === supportsGPU), `${fixture}: ${name} samples must not silently mix GPU and Canvas renderers`);
      if (supportsGPU) assert.equal(workload.firstFrame.cacheReason, 'cold', `${fixture}: ${name} mode-triggered first frame includes cold geometry work`);
    }
    if (!supportsGPU) {
      assert.equal(gpuResult.status.rendered, false, `${fixture}: unsupported full scene must fall back`);
      assert.equal(pixels, 0, 'whole-view fallback must match Canvas exactly');
      assert.equal(Buffer.compare(a.data, b.data), 0, `${fixture}: centered whole-view fallback has identical RGBA pixels`);
    } else {
      assert.equal(gpuResult.status.rendered, true, `${fixture} uses GPU`);
      assert.equal(gpuResult.firstFrame.cacheReason, 'cold', `${fixture}: mode-triggered first frame includes cold geometry work`);
      assert.ok(panGpu.uploadedBytes.every((bytes) => bytes === 0), `${fixture}: bounded pan reuses uploaded geometry`);
      for (const [name, workload] of [['bounded zoom', boundedGpu], ['off-center bounded zoom', offCenterGpu], ['minimum zoom with edge pan', minEdgeGpu], ['maximum zoom with edge pan', maxEdgeGpu]]) {
        assert.ok(workload.frameSamples.every((frame) => frame.rendered && frame.cacheHit === true && frame.uploadBytes === 0 && frame.uploadCalls === 0), `${fixture}: ${name} reuses geometry without uploads for all 30 frames`);
      }
      assert.ok(sustainedGpu.frameSamples.some((frame) => frame.cacheReason === 'zoom-range' && frame.uploadCalls > 0), `${fixture}: sustained zoom reports cache-envelope rebuild frames`);
      assert.ok(editGpu.frameSamples.every((frame) => frame.cacheReason === 'document-delta' && frame.uploadKind === 'subrange' && frame.uploadBytes === 168 && frame.uploadCalls === 1 && frame.subrangeUploadBytes === 168 && frame.subrangeUploadCalls === 1 && frame.preparedEntities <= 1), `${fixture}: all 30 visible edit/undo frames update one six-vertex subrange`);
      assert.equal(editGpu.summary.rebuildFrameIndices.length, 0, `${fixture}: delta updates must not be counted as full-scene rebuilds`);
      assert.equal(editGpu.summary.fullUploadFrameIndices.length, 0, `${fixture}: valid edit/undo workloads do not upload the full scene`);
      assert.ok(editGpu.frameSamples.filter((frame) => frame.label === 'undo-line-edit').every((frame) => frame.editMemoHit === true && frame.preparedEntities === 0 && frame.partialPreparationMs === 0), `${fixture}: timed undo frames reuse memoized owned line geometry`);
      assert.ok(coverageMiss < 0.005, `${fixture}: supported geometry matches within two pixels`);
      if (fixture !== 'dense-lines') assert.ok(pixels / (a.width * a.height) < 0.001, `${fixture}: bounded raster differences`);
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
    for (const mode of ['canvas', 'gpu']) {
      const status = await modeFrame(page, mode);
      if (mode === 'gpu' && supportsGPU) {
        assert.equal(status.rendered, true, `${fixture}: panned comparison uses GPU`);
        assert.equal(status.bytes, 0, `${fixture}: panned comparison reuses uploaded geometry`);
      }
      const path = resolve(out, `${fixture}-pan-${mode}.png`);
      await page.locator('#drawing').screenshot({ path });
      pannedImages.push(PNG.sync.read(readFileSync(path)));
    }
    const panMiss = Math.max(missedForeground(pannedImages[0], pannedImages[1]), missedForeground(pannedImages[1], pannedImages[0]));
    if (!supportsGPU) {
      assert.equal(pixelmatch(pannedImages[0].data, pannedImages[1].data, null, pannedImages[0].width, pannedImages[0].height, { threshold: 0.15 }), 0, `${fixture}: legacy panned whole-view fallback matches Canvas exactly`);
      assert.equal(Buffer.compare(pannedImages[0].data, pannedImages[1].data), 0, `${fixture}: legacy panned whole-view fallback has identical RGBA pixels`);
    }
    result.comparisons[fixture].pannedTwoPixelCoverageMissFraction = panMiss;
    assert.ok(panMiss < 0.005, `${fixture}: cached panned frame matches geometry within two pixels`);
  }
  // Lose the actual device after a proved zoom-cache hit, then verify the restored
  // scene at that same camera before the pre-existing repeated recovery checks.
  await page.evaluate(() => { window.gpuPrototype.setMode('canvas'); window.editor.viewport.twist = 0; window.gpuPrototype.loadFixture('lineweights'); });
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
  result.contextRecovery.push({ scenario: 'loss-after-warm-zoom-hit', camera: zoomRecoveryCamera, warmZoomHit, beforeZoomLoss, restoredZoom, before: zoomContextBefore, after: await prototypeContext(page), imageDifferenceFraction: zoomPixels / (zoomDiff.width * zoomDiff.height), twoPixelCoverageMissFraction: zoomMiss, documentUnchanged: true });
  result.validation.push('Real context loss after a zero-upload warm zoom hit; restored wide-stroke accuracy and unchanged document/camera');
  // Existing selection logic is unchanged; solid highlight uses the GPU scene and Canvas grips.
  await page.evaluate(() => { const ed = window.editor; window.gpuPrototype.loadFixture('curves'); ed.viewport.settings.selectionEffect = 'solid'; ed.selection.add('L'); ed.render(); });
  await page.waitForTimeout(80);
  assert.equal(await page.evaluate(() => window.gpuPrototype.renderNow().rendered), true);
  await page.locator('#drawing').screenshot({ path: resolve(out, 'selection.png') });
  result.validation.push('Selection highlight and grips');
  await page.evaluate(() => window.editor.selection.clear());
  for (let cycle = 0; cycle < 2; cycle++) {
    const before = await prototypeContext(page);
    await page.evaluate(() => window.gpuPrototype.loseContext());
    await page.waitForFunction(() => window.gpuPrototype.status().device === 'lost');
    assert.equal(await page.evaluate(() => window.gpuPrototype.renderNow().rendered), false);
    await page.evaluate(() => window.gpuPrototype.restoreContext());
    await page.waitForFunction(() => window.gpuPrototype.status().device === 'ready');
    assert.equal(await page.evaluate(() => window.gpuPrototype.renderNow().rendered), true);
    result.contextRecovery.push({ cycle: cycle + 1, before, after: await prototypeContext(page) });
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
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
