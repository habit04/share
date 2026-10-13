// Run after npm run build:gpu. Disable GPU and 3D software rasterization in one private app.
// Chromium switch definitions: content/public/common/content_switches.cc, Chromium 152.0.7977.130.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { applicationWindow } from './electron-window.mjs';

assert.equal(process.platform, 'win32', 'The explicit unavailable-device probe currently supports Windows only');
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'e2e-output/gpu-unavailable');
mkdirSync(out, { recursive: true });
const run = mkdtempSync(resolve(out, 'run-'));
const profile = resolve(run, 'profile'), taskTmp = resolve(run, 'tmp');
mkdirSync(profile); mkdirSync(taskTmp);
const env = /** @type {NodeJS.ProcessEnv} */ ({ ...process.env, TEMP: taskTmp, TMP: taskTmp });
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const args = ['.', `--user-data-dir=${profile}`, '--disable-gpu', '--disable-software-rasterizer'];
const result = /** @type {any} */ ({
  sourceSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  worktreeModified: !!execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(),
  platform: process.platform, arch: process.arch, outcome: 'running', switches: args.slice(2),
  scope: null, webgl: null, diagnostics: null, cases: [], persistence: null, checks: [], cleanup: null,
  limitations: [
    'One Windows runtime with explicit per-process flags; no hardware or driver coverage matrix.',
    'The switches are verified on this private app and real context creation determines availability.',
    'Canvas backend usage and Chromium capability reports do not establish CPU-only execution or physical adapter usage.',
    'No driver, adapter, persistent application setting, existing instance or unrelated process is changed.',
  ],
});
let launched;
let launchedProcess;
const errors = [];
const saveImage = (name, image) => {
  assert.ok(typeof image === 'string' && image.startsWith('data:image/png;base64,'));
  writeFileSync(resolve(run, name), Buffer.from(image.slice('data:image/png;base64,'.length), 'base64'));
};
const removePrivateDirectory = (directory) => {
  const absolute = resolve(directory), inside = relative(run, absolute);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Cleanup target escaped the private run');
  rmSync(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
};
try {
  launched = await electron.launch({ args, cwd: root, env, timeout: 60_000 });
  launchedProcess = launched.process();
  result.scope = await launched.evaluate(({ app }, expected) => {
    const path = process.getBuiltinModule('node:path');
    const same = (actual, wanted) => path.resolve(actual).toLowerCase() === path.resolve(wanted).toLowerCase();
    if (!same(app.getPath('userData'), expected.profile) || !same(app.getPath('temp'), expected.tmp)
      || !same(process.env.TEMP, expected.tmp) || !same(process.env.TMP, expected.tmp)) throw new Error('Private userData/TEMP/TMP scope could not be verified');
    const switches = { disableGpu: app.commandLine.hasSwitch('disable-gpu'), disableSoftwareRasterizer: app.commandLine.hasSwitch('disable-software-rasterizer') };
    if (!switches.disableGpu || !switches.disableSoftwareRasterizer) throw new Error('The private unavailable-device switches were not retained');
    return { privateProfileVerified: true, privateTempVerified: true, mainPid: process.pid, versions: process.versions, switches };
  }, { profile, tmp: taskTmp });
  const page = await applicationWindow(launched);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.editor && !!window.gpuPrototype);
  await page.addStyleTag({ content: '#drawing { pointer-events:none !important } [data-gpu-prototype="indicator"] { visibility:hidden !important }' });
  await page.mouse.move(0, 0);

  result.webgl = await page.evaluate(() => ['webgl', 'webgl2'].map((type) => {
    const canvas = document.createElement('canvas'), creationErrors = [];
    canvas.addEventListener('webglcontextcreationerror', (event) => creationErrors.push(/** @type {WebGLContextEvent} */ (event).statusMessage));
    let context = null, error = null;
    try { context = canvas.getContext(type); } catch (failure) { error = String(failure); }
    return { type, available: context !== null, creationErrors, error };
  }));
  assert.ok(result.webgl.every((probe) => !probe.available && probe.error === null), 'Both real WebGL contexts must be unavailable; switches alone are not proof');
  result.checks.push('Private profile/temp and switches verified', 'Real WebGL and WebGL2 context creation returned null');

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    let timer;
    try {
      result.diagnostics = await Promise.race([
        page.evaluate(() => window.jcad.gpuDiagnostics()),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('GPU diagnostics exceeded the 20-second deadline')), Math.max(1, deadline - Date.now())); }),
      ]);
      assert.ok(Date.now() <= deadline, 'GPU diagnostics must settle within the 20-second deadline');
    } finally { clearTimeout(timer); }
    if (result.diagnostics.state !== 'pending') break;
    await page.waitForTimeout(Math.min(300, Math.max(0, deadline - Date.now())));
  }
  assert.ok(result.diagnostics && ['ready', 'unavailable'].includes(result.diagnostics.state), 'GPU diagnostics must settle within the deadline');
  if (result.diagnostics.state === 'unavailable') assert.ok(result.diagnostics.reasons.length > 0, 'Unavailable diagnostics must explain their limit');
  for (const version of ['jcad', 'electron', 'chromium', 'windows']) assert.ok(result.diagnostics.versions[version], `Diagnostics records ${version}`);
  assert.ok(!JSON.stringify(result.diagnostics).includes(profile), 'Diagnostic summary does not disclose the private profile');
  result.checks.push('Diagnostics settled with reasons, feature status and versions recorded');

  for (const fixture of ['curve-control', 'curves', 'precision', 'precision-trillion', 'lineweights', 'mixed-schematic']) {
    const deviceFailureRequired = fixture === 'curve-control';
    await page.evaluate((name) => {
      const api = window.gpuPrototype, ed = window.editor;
      api.setMode('canvas'); api.loadFixture(name); ed.selection.clear(); ed.setHover(null);
      ed.viewport.settings.background = '#212830';
    }, fixture);
    await page.waitForTimeout(200);
    const observation = await page.evaluate(() => {
      const api = window.gpuPrototype, ed = window.editor, v = ed.viewport;
      const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('drawing'));
      const ctx = canvas.getContext('2d');
      const input = () => ({ width: v.width, height: v.height, dpr: v.dpr, scale: v.scale, twist: v.twist, center: { ...v.center }, settings: { ...v.settings },
        selection: [...ed.selection], overlay: JSON.stringify(/** @type {any} */ (v).lastOverlay) });
      api.renderNow();
      const beforeInput = input(), beforeDocument = JSON.stringify(ed.doc.snapshot);
      const reference = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const referenceImage = canvas.toDataURL('image/png');
      api.setMode('gpu'); api.renderNow();
      const status = api.status();
      const actual = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let differentChannels = 0, nontransparentPixels = 0, referenceForegroundPixels = 0;
      for (let i = 0; i < actual.length; i++) {
        if (actual[i] !== reference[i]) differentChannels++;
        if (i % 4 === 3 && actual[i] > 0) nontransparentPixels++;
        if (i % 4 === 0 && Math.hypot(reference[i] - 33, reference[i + 1] - 40, reference[i + 2] - 48) > 30) referenceForegroundPixels++;
      }
      return { beforeInput, afterInput: input(), status, canvasContextLost: ctx.isContextLost(),
        referenceBytes: reference.length, actualBytes: actual.length, differentChannels, nontransparentPixels, referenceForegroundPixels,
        documentUnchanged: JSON.stringify(ed.doc.snapshot) === beforeDocument,
        entityCount: ed.doc.entities.length, entityKinds: [...new Set(ed.doc.entities.map((entity) => entity.type))], fixtureMetadata: api.fixtureMetadata(),
        gpuCanvasHidden: /** @type {HTMLElement} */ (document.querySelector('[data-gpu-prototype="2d"]')).style.display === 'none',
        referenceImage, fallbackImage: canvas.toDataURL('image/png') };
    });
    saveImage(`${fixture}-canvas-reference.png`, observation.referenceImage);
    saveImage(`${fixture}-gpu-unavailable-fallback.png`, observation.fallbackImage);
    delete observation.referenceImage; delete observation.fallbackImage;
    result.cases.push({ fixture, deviceFailureRequired, expectedAdmissionWithAvailableDevice: deviceFailureRequired, evidenceCategory: deviceFailureRequired ? 'Isolated positive-bulge GPU eligibility control: actual WebGL initialization failure required' : 'Preserved original geometry-fallback input: exact whole Canvas required; geometry refusal is not device-failure proof', ...observation });
    assert.deepEqual(observation.afterInput, observation.beforeInput, `${fixture}: fixed camera, settings and overlay inputs`);
    assert.equal(observation.documentUnchanged, true, `${fixture}: fallback cannot change the document`);
    assert.equal(observation.status.mode, 'gpu'); assert.equal(observation.status.rendered, false);
    if (deviceFailureRequired) {
      assert.equal(observation.fixtureMetadata.name, 'curve-control');
      assert.equal(observation.fixtureMetadata.controlPolyline.points.length, 2);
      assert.equal(observation.entityCount, 4);
      assert.deepEqual(observation.entityKinds, ['line', 'circle', 'arc', 'polyline']);
      assert.equal(observation.status.device, 'failed'); assert.match(observation.status.reason, /failed|unavailable/i);
      result.checks.push('Distinct GPU eligibility control reaches actual WebGL initialization failure; geometry refusal cannot substitute for this device proof');
    } else assert.ok(typeof observation.status.reason === 'string' && observation.status.reason.trim(), `${fixture}: preserved whole-view fallback explains its reason without claiming isolated device failure`);
    assert.equal(observation.gpuCanvasHidden, true); assert.equal(observation.canvasContextLost, false);
    assert.equal(observation.actualBytes, observation.referenceBytes); assert.equal(observation.differentChannels, 0);
    assert.equal(observation.nontransparentPixels, observation.actualBytes / 4, `${fixture}: Canvas paints the complete opaque view`);
    assert.ok(observation.referenceForegroundPixels > 0, `${fixture}: reference includes visible foreground geometry`);
    assert.ok(observation.entityCount > 0);
    if (fixture === 'mixed-schematic') assert.ok(observation.entityKinds.some((kind) => !['line', 'polyline', 'circle', 'arc'].includes(kind)), 'Unsupported fixture contains unsupported geometry');
    result.checks.push(`${fixture}: whole-view Canvas fallback matched every channel with fixed inputs`);
  }

  const savedPath = resolve(run, 'gpu-unavailable-saved.dxf');
  await launched.evaluate(({ app, dialog }, expected) => {
    const path = process.getBuiltinModule('node:path');
    if (path.resolve(app.getPath('userData')).toLowerCase() !== path.resolve(expected.profile).toLowerCase()
      || path.dirname(expected.destination) !== path.dirname(expected.profile)) throw new Error('Private save scope changed');
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: expected.destination });
  }, { profile, destination: savedPath });
  // Keep GPU requested: editing and saving must work while the device remains unavailable.
  const initialCount = await page.evaluate(() => window.editor.doc.entities.length);
  await page.evaluate(() => { const ed = window.editor; ed.runCommand('LINE'); ed.submitInput('0,0'); ed.submitInput('10,10'); ed.submitInput(''); });
  assert.equal(await page.evaluate(() => window.editor.doc.entities.length), initialCount + 1);
  assert.equal(await page.evaluate(() => window.editor.saveFile(true)), true);
  assert.ok(existsSync(savedPath));
  const text = readFileSync(savedPath, 'utf8');
  assert.match(text, /^\s*0\r?\nSECTION/); assert.match(text, /\r?\nEOF\s*$/);
  assert.equal(await page.evaluate(() => window.editor.doc.dirty), false);
  const reopened = await page.evaluate(async (file) => {
    const ed = window.editor, index = ed.sessions.indexOfPath(file);
    if (index < 0) throw new Error('Saved drawing is not bound to its private session');
    ed.sessions.close(index); return ed.openFile(file);
  }, savedPath);
  assert.equal(reopened, true);
  const final = await page.evaluate(() => ({ status: window.gpuPrototype.renderNow(), count: window.editor.doc.entities.length,
    lineRetained: window.editor.doc.entities.some((entity) => entity.type === 'line' && entity.a.x === 0 && entity.a.y === 0 && entity.b.x === 10 && entity.b.y === 10),
    device: window.gpuPrototype.status().device, dirty: window.editor.doc.dirty }));
  assert.equal(final.count, initialCount + 1); assert.equal(final.lineRetained, true); assert.equal(final.dirty, false);
  assert.equal(final.status.rendered, false); assert.equal(final.device, 'failed');
  result.persistence = { expectedCount: initialCount + 1, ...final, completeDxf: true, file: 'gpu-unavailable-saved.dxf' };
  result.checks.push('Ordinary LINE and private DXF Save As/reopen worked with GPU requested and unavailable');
  await page.screenshot({ path: resolve(run, 'saved-reopened.png') });
  assert.deepEqual(errors, []);
  result.outcome = 'passed';
  console.log('Explicit unavailable-device probe passed: null WebGL contexts, exact Canvas fallback, LINE and private DXF save/reopen.');
} catch (error) {
  result.outcome = 'failed'; result.error = String(error); throw error;
} finally {
  result.pageErrors = errors;
  const cleanupErrors = [];
  let processExited = launched === undefined;
  if (launched) {
    // Only the Playwright app created above is addressed; never enumerate or kill other processes.
    await launched.evaluate(({ app }, expected) => {
      const path = process.getBuiltinModule('node:path');
      if (path.resolve(app.getPath('userData')).toLowerCase() === path.resolve(expected).toLowerCase()) app.exit(0);
    }, profile).catch((error) => { result.exitRequestError = String(error); });
    await launched.close().catch((error) => {
      const child = launchedProcess;
      if (!child || child.exitCode === null && child.signalCode === null) cleanupErrors.push(String(error));
    });
    const child = launchedProcess;
    processExited = !!child && (child.exitCode !== null || child.signalCode !== null);
    if (!processExited) cleanupErrors.push('The private Electron process did not exit');
  }
  for (const directory of [profile, taskTmp]) {
    try {
      removePrivateDirectory(directory);
    } catch (error) { cleanupErrors.push(String(error)); }
  }
  result.cleanup = { processExited, privateProfileRemoved: !existsSync(profile), privateTempRemoved: !existsSync(taskTmp), errors: cleanupErrors };
  if (cleanupErrors.length || !result.cleanup.privateProfileRemoved || !result.cleanup.privateTempRemoved) { result.outcome = 'failed'; process.exitCode = 1; }
  writeFileSync(resolve(run, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`Unavailable-device evidence: ${resolve(run, 'result.json')}`);
}
