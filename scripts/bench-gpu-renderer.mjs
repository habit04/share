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
const result = { sourceSha, worktreeModified, platform: process.platform, arch: process.arch, applicationLaunchMs: 0, hardware: null, viewport: null, comparisons: {}, contextRecovery: [], validation: [], scope: null, gpuPreference: { requested: highPerformance ? 'high-performance' : 'default', electronSwitch: highPerformance ? '--force_high_performance_gpu' : null, scope: 'Private launched app only; requested preference is not proof of active hardware.' }, limitations: ['Single Windows machine or CI runner; OS caches not purged.', 'Drawing pointer input is disabled during comparisons so hover changes cannot alter the measured scene; hover invalidation is covered by regression tests.', 'GPU fence wall waits include driver/CPU scheduling and exclude final desktop presentation.', 'Canvas readback completion is not a pure GPU timer.', 'GPU memory is uploaded buffer bytes only; JS heap is approximate and shared with the whole application.'] };

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
  for (const fixture of ['curves', 'precision', 'dense-lines', 'mixed-schematic']) {
    await page.evaluate((name) => { window.gpuPrototype.setMode('canvas'); window.gpuPrototype.loadFixture(name); }, fixture);
    await page.waitForTimeout(100);
    const measure = async (mode, motion = 'pan-zoom') => page.evaluate(async ({ mode, samples, motion }) => {
      const ed = window.editor, api = window.gpuPrototype, v = ed.viewport;
      const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('drawing'));
      const ctx = canvas.getContext('2d');
      api.setMode(mode);
      const firstStart = performance.now();
      const first = api.renderNow();
      const firstSubmissionMs = performance.now() - firstStart;
      if (first.rendered) await api.completed(); else ctx.getImageData(0, 0, 1, 1);
      const redrawCpu = [], redrawTotal = [];
      for (let i = 0; i < 15; i++) {
        const start = performance.now();
        const status = api.renderNow();
        redrawCpu.push(performance.now() - start);
        if (status.rendered) await api.completed(); else ctx.getImageData(0, 0, 1, 1);
        redrawTotal.push(performance.now() - start);
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      }
      const frameTimes = [], cpu = [], complete = [], prepare = [], intervals = [], uploadedBytes = [];
      const center = { ...v.center }, scale = v.scale;
      for (let i = 0; i < samples; i++) {
        v.panByPixels(i % 2 ? -2 : 2, i % 2 ? -1 : 1);
        if (motion === 'pan-zoom') v.zoomAt({ x: v.width / 2, y: v.height / 2 }, i % 2 ? 1 / 1.005 : 1.005);
        const start = performance.now();
        const status = api.renderNow();
        cpu.push(performance.now() - start);
        prepare.push(status.rendered ? status.preparationMs : null);
        uploadedBytes.push(status.rendered ? status.bytes : null);
        if (status.rendered) complete.push(await api.completed());
        else { const flush = performance.now(); ctx.getImageData(0, 0, 1, 1); complete.push(performance.now() - flush); }
        frameTimes.push(performance.now() - start);
        const before = performance.now();
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
        intervals.push(performance.now() - before);
      }
      v.center = center; v.scale = scale; api.renderNow();
      const median = (a) => a.filter((x) => x !== null).sort((a, b) => a - b)[Math.floor(a.filter((x) => x !== null).length / 2)] ?? null;
      const heap = /** @type {any} */ (performance).memory?.usedJSHeapSize ?? null;
      return { firstSubmissionMs, first, redrawCpuMedianMs: median(redrawCpu), redrawTotalMedianMs: median(redrawTotal), cpuSubmissionMedianMs: median(cpu), completionWaitMedianMs: median(complete), totalRenderMedianMs: median(frameTimes), preparationMedianMs: median(prepare), rafWaitMedianMs: median(intervals), uploadedBytes, samples, motion, heapBytes: heap, status: api.status() };
    }, { mode, samples: 30, motion });
    const canvasResult = await measure('canvas');
    await page.locator('#drawing').screenshot({ path: resolve(out, `${fixture}-canvas.png`) });
    const gpuResult = await measure('gpu');
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
    const panGpu = await measure('gpu', 'pan');
    result.comparisons[fixture] = { canvas: canvasResult, gpu: gpuResult, prototypeContext: context, panOnly: { canvas: panCanvas, gpu: panGpu }, imageDifferenceFraction: pixels / (a.width * a.height), twoPixelCoverageMissFraction: coverageMiss };
    if (fixture === 'mixed-schematic') {
      assert.equal(gpuResult.status.rendered, false, 'unsupported full schematic must fall back');
      assert.equal(pixels, 0, 'whole-view fallback must match Canvas exactly');
    } else {
      assert.equal(gpuResult.status.rendered, true, `${fixture} uses GPU`);
      assert.ok(panGpu.uploadedBytes.every((bytes) => bytes === 0), `${fixture}: bounded pan reuses uploaded geometry`);
      assert.ok(coverageMiss < 0.005, `${fixture}: supported geometry matches within two pixels`);
      if (fixture !== 'dense-lines') assert.ok(pixels / (a.width * a.height) < 0.001, `${fixture}: bounded raster differences`);
    }
    console.log(`${fixture}: Canvas ${canvasResult.totalRenderMedianMs.toFixed(2)} ms, requested GPU ${gpuResult.totalRenderMedianMs.toFixed(2)} ms; image difference ${(100 * pixels / (a.width * a.height)).toFixed(3)}%; ${gpuResult.status.reason ?? 'GPU'}`);
    console.log(`${fixture} pan only: Canvas ${panCanvas.totalRenderMedianMs.toFixed(2)} ms, requested GPU ${panGpu.totalRenderMedianMs.toFixed(2)} ms; GPU CPU ${panGpu.cpuSubmissionMedianMs.toFixed(2)} ms, uploads ${panGpu.uploadedBytes.filter((bytes) => bytes > 0).length}/${panGpu.samples}`);
    // Compare a translated cached frame too: a centered image alone cannot detect missing
    // strokes that entered through the cache's overscan border or a wrong translation sign.
    await page.evaluate(() => { const v = window.editor.viewport; v.panByPixels(24 / v.dpr, -17 / v.dpr); });
    const pannedImages = [];
    for (const mode of ['canvas', 'gpu']) {
      const status = await page.evaluate((next) => { window.gpuPrototype.setMode(next); return window.gpuPrototype.renderNow(); }, mode);
      if (mode === 'gpu' && fixture !== 'mixed-schematic') {
        assert.equal(status.rendered, true, `${fixture}: panned comparison uses GPU`);
        assert.equal(status.bytes, 0, `${fixture}: panned comparison reuses uploaded geometry`);
      }
      const path = resolve(out, `${fixture}-pan-${mode}.png`);
      await page.locator('#drawing').screenshot({ path });
      pannedImages.push(PNG.sync.read(readFileSync(path)));
    }
    const panMiss = Math.max(missedForeground(pannedImages[0], pannedImages[1]), missedForeground(pannedImages[1], pannedImages[0]));
    result.comparisons[fixture].pannedTwoPixelCoverageMissFraction = panMiss;
    assert.ok(panMiss < 0.005, `${fixture}: cached panned frame matches geometry within two pixels`);
  }
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
