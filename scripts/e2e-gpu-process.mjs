// Run after npm run build:gpu. Native GPU-process failure in one private Windows app.
// Electron 44.7.0 ProcessMetric typings: app.getAppMetrics() is scoped to this app;
// pid + creationTime identify a process. No OS process enumeration or driver changes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { applicationWindow } from './electron-window.mjs';

const cliArgs = process.argv.slice(2);
assert.ok(cliArgs.every((argument) => ['--high-performance', '--cached-scene'].includes(argument)) && new Set(cliArgs).size === cliArgs.length, 'Usage: node scripts/e2e-gpu-process.mjs [--high-performance] [--cached-scene]');
const highPerformance = cliArgs.includes('--high-performance');
const cachedScene = cliArgs.includes('--cached-scene');
assert.equal(process.platform, 'win32', 'This native GPU-process probe currently supports Windows only');
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'e2e-output/gpu-process');
mkdirSync(out, { recursive: true });
const run = mkdtempSync(resolve(out, 'run-'));
const profile = resolve(run, 'profile');
const taskTmp = resolve(run, 'tmp');
mkdirSync(profile); mkdirSync(taskTmp);
const env = /** @type {NodeJS.ProcessEnv} */ ({ ...process.env, TEMP: taskTmp, TMP: taskTmp });
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const result = /** @type {any} */ ({
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeModified: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  platform: process.platform, arch: process.arch, outcome: 'running', scope: null,
  termination: null, nativeEvents: [], observation: null, restoration: null, checks: [],
  scene: { requested: cachedScene ? 'cached-curves-and-lines' : 'curves', addedLines: cachedScene ? 250 : 0 },
  gpuPreference: { requested: highPerformance ? 'high-performance' : 'default', electronSwitch: highPerformance ? '--force_high_performance_gpu' : null, scope: 'Private launched app only; requested preference is not proof of active hardware.' },
  limitations: [
    'One Windows runtime and one app-owned GPU-process termination; no hardware coverage matrix.',
    'No driver reset, persistent GPU disablement, system-wide adapter preference, or hardware-acceleration setting changes.',
    'Canvas 2D may itself use Chromium GPU acceleration; Canvas fallback does not prove CPU-only drawing.',
    'Renderer restart, application restart, and forced WebGL restoration are not used to claim native recovery.',
  ],
});
let launched;
let verifiedProfile = false;
const errors = [];

/** Optional proof only. Use the bounded preload projection; never request raw GPUInfo. */
async function captureGraphics(page, timeoutMs = 2000) {
  if (timeoutMs <= 0) return {
    observedAt: null,
    prototype: { state: 'unknown', rendered: false, unmaskedVendor: 'Unknown', unmaskedRenderer: 'Unknown' },
    diagnostics: { state: 'unavailable', reason: 'Optional graphics metadata deadline elapsed; no inspection attempted.' },
    diagnosticsSource: 'Bounded preload projection; may be cached.', metadataDeadlineMs: 0,
  };
  let budgetTimer;
  try { return await Promise.race([page.evaluate(async (deadlineMs) => {
    const status = window.gpuPrototype.status();
    const prototype = { state: status.device, rendered: status.rendered, unmaskedVendor: 'Unknown', unmaskedRenderer: 'Unknown' };
    // A lazy prototype canvas must retain the attributes requested by its actual owner.
    if (status.device === 'ready' && status.rendered) {
      try {
        const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('[data-gpu-prototype="2d"]'));
        const gl = canvas?.getContext('webgl2');
        if (gl && !gl.isContextLost()) {
          const debug = gl.getExtension('WEBGL_debug_renderer_info');
          const text = (value) => typeof value === 'string' && value.trim() ? value.slice(0, 240) : 'Unknown';
          if (debug) {
            prototype.unmaskedVendor = text(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL));
            prototype.unmaskedRenderer = text(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL));
          }
        }
      } catch { /* Unknown is evidence of unavailability, not a failed rendering gate. */ }
    }
    let timer;
    let diagnostics = { state: 'unavailable', reason: 'Optional diagnostics unavailable or metadata deadline reached.' };
    try {
      if (deadlineMs > 0 && typeof window.jcad?.gpuDiagnostics === 'function') {
        diagnostics = await Promise.race([
          window.jcad.gpuDiagnostics(),
          new Promise((resolve) => { timer = setTimeout(() => resolve(diagnostics), deadlineMs); }),
        ]);
      }
    } catch { /* Keep the available context proof even if diagnostics cannot be collected. */ }
    finally { clearTimeout(timer); }
    return { observedAt: Date.now(), prototype, diagnostics, diagnosticsSource: 'Bounded preload projection; may be cached.', metadataDeadlineMs: deadlineMs };
  }, timeoutMs), new Promise((resolve) => { budgetTimer = setTimeout(() => resolve({
    observedAt: null,
    prototype: { state: 'unknown', rendered: false, unmaskedVendor: 'Unknown', unmaskedRenderer: 'Unknown' },
    diagnostics: { state: 'unavailable', reason: 'Optional graphics inspection exceeded its deadline.' },
    diagnosticsSource: 'Bounded preload projection; may be cached.', metadataDeadlineMs: timeoutMs,
  }), timeoutMs); })]); }
  finally { clearTimeout(budgetTimer); }
}

// The established GPU benchmark allows two physical pixels of rasterizer coverage
// variation. Pixelmatch separately bounds visible differences; opacity rejects a
// missing/transparent Canvas surface even when geometric coverage is misleading.
function missedForeground(a, b, background) {
  const foreground = (image, x, y) => {
    if (x < 0 || y < 0 || x >= image.width || y >= image.height) return false;
    const index = (y * image.width + x) * 4;
    return image.data[index + 3] === 255 && Math.hypot(image.data[index] - background[0], image.data[index + 1] - background[1], image.data[index + 2] - background[2]) > 30;
  };
  let count = 0, missing = 0;
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
    if (!foreground(a, x, y)) continue;
    count++;
    let found = false;
    for (let dy = -2; dy <= 2 && !found; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (foreground(b, x + dx, y + dy)) { found = true; break; }
    }
    if (!found) missing++;
  }
  return { fraction: count ? missing / count : 0, foregroundPixels: count };
}

try {
  launched = await electron.launch({ args: ['.', `--user-data-dir=${profile}`, ...(highPerformance ? ['--force_high_performance_gpu'] : [])], cwd: root, env, timeout: 60000 });
  // This is the first main-process operation after launch, before any test mutation.
  result.scope = await launched.evaluate(({ app }, expected) => {
    const path = process.getBuiltinModule('node:path');
    const actual = path.resolve(app.getPath('userData'));
    if (actual.toLowerCase() !== path.resolve(expected).toLowerCase()) throw new Error('Private userData scope could not be verified');
    return { privateProfileVerified: true, mainPid: process.pid, versions: process.versions, highPerformanceSwitchPresent: app.commandLine.hasSwitch('force_high_performance_gpu') };
  }, profile);
  verifiedProfile = true;
  assert.equal(result.scope.highPerformanceSwitchPresent, highPerformance, 'Private app GPU preference switch must match the requested CLI mode');
  const page = await applicationWindow(launched);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.editor && !!window.gpuPrototype);
  if (cachedScene) {
    // Only this fresh private blank app may reload, before any fixture or GPU context.
    assert.equal(await page.evaluate(() => window.editor.doc.entities.length === 0 && !window.editor.doc.dirty && window.gpuPrototype.status().device === 'not-created'), true, 'Drawing-only context hint requires the untouched private blank app');
    await page.addInitScript(() => {
      const getContext = HTMLCanvasElement.prototype.getContext;
      /** @type {any} */ (HTMLCanvasElement.prototype).getContext = function (type, ...args) {
        if (type === '2d' && this.id === 'drawing') {
          return Reflect.apply(getContext, this, [type, { ...(args[0] ?? {}), willReadFrequently: true }]);
        }
        return Reflect.apply(getContext, this, [type, ...args]);
      };
    });
    await page.reload();
    await page.waitForFunction(() => !!window.editor && !!window.gpuPrototype);
    assert.equal(await page.evaluate(() => window.editor.doc.entities.length === 0 && !window.editor.doc.dirty && window.gpuPrototype.status().device === 'not-created'), true, 'Private initialization reload must precede fixtures and GPU context creation');
    result.scene.initialization = { drawingOnlyWillReadFrequentlyRequested: true, privateBlankReloadBeforeFixture: true, scope: 'Only #drawing 2D context options; actual attributes and native events are recorded. The hint does not prove CPU-only drawing.' };
  }
  await page.addStyleTag({ content: '#drawing { pointer-events:none !important }' });
  await page.mouse.move(0, 0);
  await page.evaluate((useCache) => {
    window.gpuPrototype.setMode('canvas'); window.gpuPrototype.loadFixture('curves'); window.editor.setHover(null);
    if (useCache) {
      const lines = Array.from({ length: 250 }, (_, index) => {
        const x = 0.15 + index % 25 * 0.27, y = 0.15 + Math.floor(index / 25) * 0.5;
        return { id: `CACHE-L-${index}`, type: 'line', layer: '0', linetype: 'Continuous', color: index % 2 ? 2 : 7, a: { x, y }, b: { x: x + 0.16, y: y + 0.08 } };
      });
      window.editor.doc.transact((state) => ({ ...state, entities: [...state.entities, ...lines] }));
      window.editor.render();
    }
  }, cachedScene);
  // Let fixture-triggered ResizeObserver/layout work settle before capturing pixel inputs.
  await page.waitForTimeout(200);
  await page.evaluate((useCache) => {
    const api = window.gpuPrototype, ed = window.editor, v = ed.viewport;
    api.renderNow();
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('drawing'));
    const ctx = canvas.getContext('2d');
    const cache = /** @type {any} */ (v).baseScene;
    let cacheCopies = 0;
    if (useCache) {
      if (ed.doc.entities.length !== 254 || !cache || cache.state !== ed.doc.snapshot || !cache.key || cache.canvas.width !== canvas.width || cache.canvas.height !== canvas.height || cache.canvas.width <= 0 || cache.canvas.height <= 0) throw new Error('The large private scene did not create a current, correctly sized bitmap cache');
      const drawImage = ctx.drawImage;
      /** @type {any} */ (ctx).drawImage = function (source, ...args) {
        if (source === cache.canvas) cacheCopies++;
        return Reflect.apply(drawImage, this, [source, ...args]);
      };
      // Clear only the main surface: the second render must fill it from the cache.
      // Inspect the copied main bitmap, avoiding a cache readback that can change its backend.
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore();
      try { api.renderNow(); } finally { ctx.drawImage = drawImage; }
      if (cacheCopies !== 1 || /** @type {any} */ (v).baseScene !== cache || cache.canvas.getContext('2d').isContextLost()) throw new Error('The warmed Canvas frame did not reuse the live private bitmap cache');
    }
    const reference = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let copiedOpaquePixels = 0, copiedForegroundPixels = 0;
    if (useCache) {
      const color = /^#([0-9a-f]{6})$/i.exec(v.settings.background);
      if (!color) throw new Error('Cached bitmap proof requires the recorded RGB background');
      const rgb = Number.parseInt(color[1], 16), background = [rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255];
      for (let index = 0; index < reference.length; index += 4) {
        if (reference[index + 3] === 255) copiedOpaquePixels++;
        if (Math.hypot(reference[index] - background[0], reference[index + 1] - background[1], reference[index + 2] - background[2]) > 30) copiedForegroundPixels++;
      }
      if (copiedOpaquePixels !== canvas.width * canvas.height || copiedForegroundPixels === 0) throw new Error('The reused private bitmap did not restore an opaque, nonempty Canvas frame');
    }
    const referenceWidth = canvas.width, referenceHeight = canvas.height;
    const documentBefore = JSON.stringify(ed.doc.snapshot);
    const input = () => ({ width: v.width, height: v.height, dpr: v.dpr, scale: v.scale, twist: v.twist, background: v.settings.background, center: { ...v.center }, hover: /** @type {any} */ (v).lastOverlay?.hover, selection: [...ed.selection] });
    const probe = { contextEvents: [], canvasEvents: [], cacheEvents: [], fallback: [], canvasRestoration: [], documentBefore, referenceInput: input(), referenceImage: canvas.toDataURL('image/png'), explicitLossPaint: false, originalCacheCanvas: useCache ? cache.canvas : null, cacheWarmProof: useCache ? { entityCount: ed.doc.entities.length, cacheCopies, currentSnapshot: cache.state === ed.doc.snapshot, width: cache.canvas.width, height: cache.canvas.height, healthy: !cache.canvas.getContext('2d').isContextLost(), copiedOpaquePixels, copiedForegroundPixels, cacheReadbackUsed: false, mainContextAttributes: ctx.getContextAttributes(), cacheContextAttributes: cache.canvas.getContext('2d').getContextAttributes() } : null };
    /** @type {any} */ (window).__gpuProcessProbe = probe;
    if (probe.originalCacheCanvas) for (const type of ['contextlost', 'contextrestored']) probe.originalCacheCanvas.addEventListener(type, () => {
      // The owner's earlier listener may already discard/shrink this saved bitmap.
      probe.cacheEvents.push({ type, at: performance.now(), contextLost: cache.canvas.getContext('2d').isContextLost(), width: cache.canvas.width, height: cache.canvas.height, originalStillRetained: /** @type {any} */ (v).baseScene?.canvas === cache.canvas });
    });
    api.setMode('gpu');
    const status = api.renderNow();
    if (!status.rendered) throw new Error(`Initial WebGL2 rendering is unavailable: ${status.reason}`);
    // The device listener is now installed; observe only after it marks native loss.
    const gpuCanvas = document.querySelector('[data-gpu-prototype="2d"]');
    const frame = (source) => {
      const status = api.status();
      const actual = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const samePixels = actual.length === reference.length && actual.every((value, index) => value === reference[index]);
      let differentChannels = 0, nontransparentPixels = 0;
      for (let index = 0; index < actual.length; index++) {
        if (actual[index] !== reference[index]) differentChannels++;
        if (index % 4 === 3 && actual[index] > 0) nontransparentPixels++;
      }
      const currentCache = /** @type {any} */ (v).baseScene;
      return { source, at: performance.now(), rendered: status.rendered, device: status.device, gpuCanvasHidden: /** @type {HTMLElement} */ (gpuCanvas).style.display === 'none', reason: status.reason, samePixels, differentChannels, nontransparentPixels, canvasContextLost: ctx.isContextLost(), cache: { exists: !!currentCache, retainsOriginal: !!probe.originalCacheCanvas && currentCache?.canvas === probe.originalCacheCanvas, currentSnapshot: currentCache?.state === ed.doc.snapshot, healthy: currentCache ? !currentCache.canvas.getContext('2d').isContextLost() : null }, width: canvas.width, height: canvas.height, referenceWidth, referenceHeight, input: input(), image: source === 'automatic-redraw' && !ctx.isContextLost() ? canvas.toDataURL('image/png') : null, documentUnchanged: JSON.stringify(ed.doc.snapshot) === documentBefore };
    };
    const originalRender = v.render.bind(v);
    v.render = (overlay) => {
      originalRender(overlay);
      if (probe.contextEvents.length && api.status().mode === 'gpu' && !api.status().rendered) {
        try { probe.fallback.push(frame(probe.explicitLossPaint ? 'loss-observer' : 'automatic-redraw')); }
        catch (error) { probe.fallback.push({ source: 'automatic-redraw', at: performance.now(), error: String(error) }); }
      }
    };
    for (const type of ['contextlost', 'contextrestored']) canvas.addEventListener(type, () => {
      probe.canvasEvents.push({ type, at: performance.now() });
      if (type === 'contextrestored') requestAnimationFrame(() => {
        try { probe.canvasRestoration.push(frame('canvas-restore-observer')); }
        catch (error) { probe.canvasRestoration.push({ at: performance.now(), error: String(error) }); }
      });
    });
    gpuCanvas.addEventListener('webglcontextlost', () => {
      probe.contextEvents.push({ type: 'lost', at: performance.now() });
      // GpuDevice's earlier listener marks loss first. Paint synchronously to observe
      // the genuine unavailable interval even if Chromium restores the GPU quickly.
      try {
        probe.explicitLossPaint = true;
        api.renderNow();
        /** @type {any} */ (probe).lossImage = canvas.toDataURL('image/png');
      } catch (error) { probe.fallback.push({ at: performance.now(), error: String(error) }); }
      finally { probe.explicitLossPaint = false; }
    });
    gpuCanvas.addEventListener('webglcontextrestored', () => probe.contextEvents.push({ type: 'restored', at: performance.now() }));
  }, cachedScene);
  const before = await page.evaluate(() => window.gpuPrototype.status());
  assert.equal(before.device, 'ready');
  assert.notEqual(await page.evaluate(() => window.gpuPrototype.completed()), null, 'Initial GPU submission must complete');
  result.before = before;
  result.scene.entityCount = await page.evaluate(() => window.editor.doc.entities.length);
  result.scene.cacheWarmProof = await page.evaluate(() => /** @type {any} */ (window).__gpuProcessProbe.cacheWarmProof);
  if (cachedScene) result.checks.push('254-entity scene warmed and reused its real private Canvas bitmap cache before GPU rendering');
  result.graphics = { before: await captureGraphics(page) };
  await page.screenshot({ path: resolve(run, 'before.png') });
  result.referenceInput = await page.evaluate(() => /** @type {any} */ (window).__gpuProcessProbe.referenceInput);
  const beforeKillInput = await page.evaluate(() => {
    const ed = window.editor, v = ed.viewport;
    return { width: v.width, height: v.height, dpr: v.dpr, scale: v.scale, twist: v.twist, background: v.settings.background, center: { ...v.center }, hover: /** @type {any} */ (v).lastOverlay?.hover, selection: [...ed.selection] };
  });
  assert.deepEqual(beforeKillInput, result.referenceInput, 'Camera/viewport/hover inputs must stay fixed before native failure');
  if (cachedScene) result.scene.cacheBeforeTermination = await page.evaluate(() => {
    const probe = /** @type {any} */ (window).__gpuProcessProbe, cache = /** @type {any} */ (window.editor.viewport).baseScene;
    if (!cache || cache.canvas !== probe.originalCacheCanvas || cache.state !== window.editor.doc.snapshot || cache.canvas.width !== window.editor.viewport.canvas.width || cache.canvas.height !== window.editor.viewport.canvas.height || cache.canvas.getContext('2d').isContextLost()) throw new Error('The proven private bitmap cache changed before native failure');
    return { sameWarmedBitmap: true, currentSnapshot: true, width: cache.canvas.width, height: cache.canvas.height, healthy: true };
  });

  // All identity proof and the sole termination happen inside this launched app's
  // main process. Recheck immediately before kill; never accept a caller-supplied PID.
  result.termination = await launched.evaluate(({ app }, expected) => {
    const path = process.getBuiltinModule('node:path');
    if (path.resolve(app.getPath('userData')).toLowerCase() !== path.resolve(expected).toLowerCase()) throw new Error('Private profile changed; no process will be terminated');
    const candidates = app.getAppMetrics().filter((metric) => metric.type === 'GPU');
    if (candidates.length !== 1) throw new Error(`Cannot prove a unique app-owned GPU process (${candidates.length} candidates)`);
    const target = candidates[0];
    if (!Number.isSafeInteger(target.pid) || target.pid <= 0 || target.pid === process.pid || !Number.isFinite(target.creationTime) || target.creationTime <= 0) throw new Error('App-owned GPU process identity is invalid; no process will be terminated');
    const g = /** @type {any} */ (globalThis);
    g.__gpuProcessProbe = { events: [] };
    app.on('child-process-gone', (_event, details) => {
      if (details.type === 'GPU') g.__gpuProcessProbe.events.push({ type: details.type, reason: details.reason, exitCode: details.exitCode, at: Date.now() });
    });
    const current = app.getAppMetrics().filter((metric) => metric.type === 'GPU');
    if (current.length !== 1 || current[0].pid !== target.pid || current[0].creationTime !== target.creationTime) throw new Error('GPU process changed before termination; no process will be terminated');
    if (!process.kill(target.pid, 'SIGKILL')) throw new Error('Terminating the verified GPU process did not succeed');
    return { pid: target.pid, creationTime: target.creationTime, mainPid: process.pid, signal: 'SIGKILL', at: Date.now(), ownership: 'private app.getAppMetrics()', freshIdentityVerified: true };
  }, profile);
  console.log(`Terminated only private app GPU PID ${result.termination.pid}; main PID ${result.termination.mainPid} remains alive.`);
  await page.waitForFunction(() => /** @type {any} */ (window).__gpuProcessProbe.contextEvents.some((event) => event.type === 'lost'), null, { timeout: 15000 });
  result.observation = await page.evaluate(() => {
    const probe = /** @type {any} */ (window).__gpuProcessProbe;
    return { contextEvents: probe.contextEvents, canvasEvents: probe.canvasEvents, cacheEvents: probe.cacheEvents, fallback: probe.fallback, canvasRestoration: probe.canvasRestoration, referenceImage: probe.referenceImage, lossImage: probe.lossImage, documentUnchanged: JSON.stringify(window.editor.doc.snapshot) === probe.documentBefore };
  });
  const saveProbeImage = (name, image) => {
    if (typeof image === 'string' && image.startsWith('data:image/png;base64,')) writeFileSync(resolve(run, name), Buffer.from(image.slice('data:image/png;base64,'.length), 'base64'));
  };
  saveProbeImage('canvas-reference.png', result.observation.referenceImage);
  saveProbeImage('canvas-during-loss.png', result.observation.lossImage);
  delete result.observation.referenceImage; delete result.observation.lossImage;
  result.nativeEvents = await launched.evaluate(() => /** @type {any} */ (globalThis).__gpuProcessProbe.events);
  assert.ok(result.nativeEvents.some((event) => event.type === 'GPU'), 'Main process must observe its GPU child-process failure');
  assert.equal(result.observation.documentUnchanged, true);
  result.checks.push('Native GPU-process failure observed', 'Document unchanged by native failure');

  let restored = false;
  try {
    await page.waitForFunction(() => window.gpuPrototype.status().device === 'ready' && window.gpuPrototype.renderNow().rendered, null, { timeout: 15000 });
    restored = await page.evaluate(() => window.gpuPrototype.completed()) !== null;
  } catch { /* Usable Canvas remains required; native GPU restoration is reported separately. */ }
  result.restoration = { observed: restored, automaticOnly: true, status: await page.evaluate(() => window.gpuPrototype.status()) };
  const observed = await page.evaluate(() => {
    const probe = /** @type {any} */ (window).__gpuProcessProbe;
    return { contextEvents: probe.contextEvents, canvasEvents: probe.canvasEvents, cacheEvents: probe.cacheEvents, fallback: probe.fallback, canvasRestoration: probe.canvasRestoration };
  });
  Object.assign(result.observation, observed);
  result.observation.fallback.forEach((frame, index) => {
    if (frame.image) { frame.imageFile = `automatic-canvas-fallback-${index}.png`; saveProbeImage(frame.imageFile, frame.image); }
    delete frame.image;
  });
  const canvasLoss = result.observation.canvasEvents.find((event) => event.type === 'contextlost');
  const canvasRestore = result.observation.canvasEvents.find((event) => event.type === 'contextrestored' && event.at >= canvasLoss?.at);
  const webglLoss = result.observation.contextEvents.find((event) => event.type === 'lost');
  const webglRestore = result.observation.contextEvents.find((event) => event.type === 'restored');
  const cacheLoss = result.observation.cacheEvents.find((event) => event.type === 'contextlost');
  const cacheRestore = result.observation.cacheEvents.find((event) => event.type === 'contextrestored' && event.at >= cacheLoss?.at);
  assert.ok(webglLoss, 'Native GPU-process failure must produce a recorded WebGL loss');
  if (canvasLoss) assert.ok(canvasRestore, 'A lost Canvas must restore before its fallback frame can qualify');
  else result.limitations.push('No Canvas context loss was observed on this runner; automatic fallback was tested, but Canvas restoration was not exercised.');
  result.canvasRecoveryPath = canvasLoss ? 'lost-then-restored' : 'no-canvas-loss-observed';
  result.cacheRecoveryPath = cachedScene ? cacheLoss ? 'warmed-cache-loss-observed' : 'no-cache-loss-observed' : 'cached-scene-not-requested';
  if (cachedScene && !cacheLoss) result.limitations.push('The genuine warmed bitmap cache remained healthy on this runner; cache-context loss recovery was not exercised.');
  const fallbackAnchor = Math.max(webglLoss.at, canvasLoss ? canvasRestore.at : webglLoss.at, cacheLoss?.at ?? webglLoss.at);
  const automaticFrames = result.observation.fallback.filter((frame) => frame.source === 'automatic-redraw' && frame.at >= fallbackAnchor && (!webglRestore || frame.at < webglRestore.at) && frame.rendered === false && frame.device === 'lost' && frame.gpuCanvasHidden && !frame.canvasContextLost && (!cacheLoss || !frame.cache.retainsOriginal) && (!frame.cache.exists || frame.cache.healthy && frame.cache.currentSnapshot) && frame.documentUnchanged && frame.imageFile);
  assert.ok(automaticFrames.length, canvasLoss ? 'Viewport must automatically repaint Canvas after its restoration while WebGL is still lost' : 'Viewport must automatically repaint healthy Canvas after WebGL loss');
  const referencePng = PNG.sync.read(readFileSync(resolve(run, 'canvas-reference.png')));
  let referenceOpaquePixels = 0;
  for (let offset = 3; offset < referencePng.data.length; offset += 4) if (referencePng.data[offset] === 255) referenceOpaquePixels++;
  assert.equal(referenceOpaquePixels, referencePng.width * referencePng.height, 'Original Canvas reference must have a fully opaque background');
  const hex = /^#([0-9a-f]{6})$/i.exec(result.referenceInput.background);
  assert.ok(hex, 'Coverage comparison requires the recorded opaque RGB background');
  const rgb = Number.parseInt(hex[1], 16), background = [rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255];
  result.automaticFallbackComparisons = automaticFrames.map((frame, index) => {
    assert.deepEqual(frame.input, result.referenceInput, 'Recovered automatic Canvas frame must preserve camera/viewport/hover inputs');
    const actual = PNG.sync.read(readFileSync(resolve(run, frame.imageFile)));
    assert.equal(actual.width, referencePng.width); assert.equal(actual.height, referencePng.height);
    const diff = new PNG({ width: actual.width, height: actual.height });
    const differentPixels = pixelmatch(referencePng.data, actual.data, diff.data, actual.width, actual.height, { threshold: 0.15 });
    writeFileSync(resolve(run, `automatic-canvas-diff-${index}.png`), PNG.sync.write(diff));
    const forward = missedForeground(referencePng, actual, background), reverse = missedForeground(actual, referencePng, background);
    let opaquePixels = 0;
    for (let offset = 3; offset < actual.data.length; offset += 4) if (actual.data[offset] === 255) opaquePixels++;
    return { source: frame.source, at: frame.at, canvasLossObserved: !!canvasLoss, cacheLossObserved: !!cacheLoss, cache: frame.cache, fallbackAnchorAt: fallbackAnchor, canvasRestoredAt: canvasRestore?.at ?? null, cacheLostAt: cacheLoss?.at ?? null, cacheRestoredAt: cacheRestore?.at ?? null, webglLostAt: webglLoss.at, webglRestoredAt: webglRestore?.at ?? null, device: frame.device, rawDifferentChannels: frame.differentChannels, exactPixels: frame.samePixels, imageDifferenceFraction: differentPixels / (actual.width * actual.height), twoPixelCoverageMissFraction: Math.max(forward.fraction, reverse.fraction), referenceForegroundPixels: forward.foregroundPixels, recoveredForegroundPixels: reverse.foregroundPixels, fullyOpaque: opaquePixels === actual.width * actual.height, image: frame.imageFile, thresholds: { pixelmatch: 0.15, imageDifferenceFraction: 0.005, twoPixelCoverageMissFraction: 0.005 } };
  });
  const usableFallback = result.automaticFallbackComparisons.some((comparison) => comparison.fullyOpaque && comparison.referenceForegroundPixels > 0 && comparison.recoveredForegroundPixels > 0 && comparison.imageDifferenceFraction < 0.005 && comparison.twoPixelCoverageMissFraction < 0.005);
  if (usableFallback) result.checks.push('Automatic whole-view Canvas fallback while WebGL remains lost; opacity and bounded raster/coverage comparison passed');
  if (usableFallback && cacheLoss) result.checks.push('Lost warmed bitmap cache discarded; automatic complete Canvas repaint after cache loss passed while WebGL remained lost');
  result.afterMetrics = await launched.evaluate(({ app }) => app.getAppMetrics().filter((metric) => metric.type === 'GPU').map((metric) => ({ pid: metric.pid, creationTime: metric.creationTime, type: metric.type })));
  // Optional post-failure metadata cannot extend the 20-second recovery observation budget.
  result.graphics.after = await captureGraphics(page, Math.max(0, Math.min(2000, 20000 - (Date.now() - result.termination.at))));
  if (restored) {
    assert.ok(result.afterMetrics.some((metric) => metric.pid !== result.termination.pid || metric.creationTime !== result.termination.creationTime), 'Recovery must use a replacement app-owned GPU process');
    result.checks.push('Automatic WebGL2 restoration rendered and completed a frame');
  } else result.limitations.push('Automatic WebGL2 restoration was not observed within 15 seconds; Canvas usability was tested instead.');
  await page.screenshot({ path: resolve(run, 'after-native-failure.png') });

  // Exercise ordinary editing and real DXF persistence in the same private app.
  // The fixed Save dialog answer grants only a new file under this probe's own run.
  const savedPath = resolve(run, 'gpu-process-saved.dxf');
  await launched.evaluate(({ app, dialog }, { expectedProfile, destination }) => {
    const path = process.getBuiltinModule('node:path');
    if (path.resolve(app.getPath('userData')).toLowerCase() !== path.resolve(expectedProfile).toLowerCase()) throw new Error('Private profile scope changed before file checks');
    if (path.dirname(destination) !== path.dirname(expectedProfile)) throw new Error('Save fixture is outside the private run');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination });
  }, { expectedProfile: profile, destination: savedPath });
  const initialCount = await page.evaluate(() => window.editor.doc.entities.length);
  const expectedCount = initialCount + 1;
  await page.evaluate(() => {
    window.gpuPrototype.setMode('canvas');
    const ed = window.editor;
    ed.runCommand('LINE'); ed.submitInput('0,0'); ed.submitInput('10,10'); ed.submitInput('');
  });
  assert.equal(await page.evaluate(() => window.editor.doc.entities.length), expectedCount);
  assert.equal(await page.evaluate(() => window.editor.saveFile(true)), true, 'Ordinary Save As must succeed after the native GPU failure');
  assert.ok(existsSync(savedPath));
  const text = readFileSync(savedPath, 'utf8');
  assert.match(text, /^\s*0\r?\nSECTION/); assert.match(text, /\r?\nEOF\s*$/);
  assert.equal(await page.evaluate(() => window.editor.doc.dirty), false);
  const reopened = await page.evaluate(async (file) => {
    const ed = window.editor, sessions = ed.sessions;
    const index = sessions.indexOfPath(file);
    if (index < 0) throw new Error('Saved drawing is not bound to a private session');
    sessions.close(index);
    return ed.openFile(file);
  }, savedPath);
  assert.equal(reopened, true);
  assert.equal(await page.evaluate(() => window.editor.doc.entities.length), expectedCount);
  assert.equal(await page.evaluate(() => window.editor.doc.entities.some((entity) => entity.type === 'line' && entity.a.x === 0 && entity.a.y === 0 && entity.b.x === 10 && entity.b.y === 10)), true);
  const finalStatus = await page.evaluate(() => window.gpuPrototype.renderNow());
  assert.equal(finalStatus.rendered, false, 'Requested Canvas mode must remain usable after reopening');
  await page.screenshot({ path: resolve(run, 'saved-reopened.png') });
  result.checks.push('Ordinary LINE added one entity', 'Private DXF Save As and reopen retained entities and line endpoints');
  result.persistence = { expectedCount, reopenedCount: await page.evaluate(() => window.editor.doc.entities.length), completeDxf: true };
  assert.deepEqual(errors, []);
  assert.ok(usableFallback, 'Automatic Canvas fallback must preserve complete drawing coverage, opaque background and bounded raster differences while WebGL remains lost');
  result.outcome = restored ? 'passed' : 'passed-with-restoration-limit';
  console.log(`Native GPU-process probe: Canvas fallback, document integrity, LINE and private DXF save/reopen passed; automatic GPU restoration ${restored ? 'observed' : 'not observed'}.`);
} catch (error) {
  result.outcome = 'failed'; result.error = String(error);
  throw error;
} finally {
  result.pageErrors = errors;
  writeFileSync(resolve(run, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`GPU-process evidence: ${resolve(run, 'result.json')}`);
  // Never terminate an unverified application or any OS-enumerated process.
  if (launched && verifiedProfile) await launched.evaluate(({ app }) => app.exit(0)).catch(() => {});
  if (launched && verifiedProfile) await launched.close().catch(() => {});
}
