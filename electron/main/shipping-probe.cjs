// Fixed diagnostics for the exact shipping executable. No supplied JavaScript, remote
// debugging transport or renderer IPC endpoint; only fixed, enumerated probe phases.
/* global window, document, localStorage, location, isSecureContext, WebGL2RenderingContext, HTMLCanvasElement, ImageData, MouseEvent, crypto */
const { app, session, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { runShippingDwgProbe } = require('./shipping-dwg-probe.cjs');
const { runShippingGpuShxProbe } = require('./shipping-gpu-shx-probe.cjs');
const { runShippingGpu3dProbe } = require('./shipping-gpu-3d-probe.cjs');
const { shippingGpuAssertLazy3d } = require('./shipping-gpu-lazy-3d.cjs');

/** Fixed, bounded preference evidence for private clean-install/upgrade probes only.
 * @param {any} w @param {Pick<Document, 'querySelectorAll'>} dom @param {Pick<Storage, 'getItem'>} storage
 */
function shippingStartupSettingsEvidence(w, dom, storage) {
  const ed = w.editor, settings = ed.settings, c = w.jcad3d;
  const no3dCanvas = dom.querySelectorAll('canvas.viewport3d').length === 0;
  return {
    experimental3d: settings.experimental3d,
    importForeign3d: typeof settings.importForeign3d === 'boolean' ? settings.importForeign3d : null,
    gridVisible: settings.gridVisible, crosshairSize: settings.crosshairSize, modelBackground: settings.modelBackground,
    autosaveMinutes: settings.autosaveMinutes, units: settings.units, unitSuffix: settings.unitSuffix,
    precision: settings.precision, language: settings.language,
    upgradeSentinel: storage.getItem('jcad-upgrade-sentinel')?.slice(0, 128) ?? null,
    controllerInstalled: !!c, controllerInactive: !c || c.active === false,
    no3dCanvas, kernelUnstarted: !c || c.kernelStarted === false,
    canvasDefault: (!c || c.active === false) && no3dCanvas && ed.viewport.canvas.style.visibility !== 'hidden'
      && dom.querySelectorAll('canvas[data-gpu-candidate="2d"]').length === 0,
  };
}

/** Fixed renderer code, serialized by the main process; never supplied by a CLI argument. */
async function shipping3dRenderer(phase, fixture, output) {
  const w = /** @type {any} */ (window);
  const need = (ok, message) => { if (!ok) throw new Error(message); };
  const until = Date.now() + 30000;
  while (!w.editor?.doc.filePath || !w.jcad || localStorage.getItem('jcad-origin-migrated') !== '1') {
    need(Date.now() < until, '3D renderer or private handed-over DXF did not become ready');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const ed = w.editor;
  need(ed.doc.filePath.replace(/\\/g, '/') === fixture.replace(/\\/g, '/') && ed.doc.entities.length === 1 && !ed.doc.dirty, '3D probe requires its clean authored temporary DXF');
  need(isSecureContext && location.href === 'jcad://app/index.html' && crypto.subtle, '3D probe requires the secure shipping origin without test hooks');
  const info = await w.jcad.appInfo();
  const rendererLabel = async expected => {
    await ed.runCommand('ABOUT');
    const deadline = Date.now() + 5000;
    let section;
    while (!(section = document.querySelector('section[aria-label="GPU diagnostics"]'))?.querySelector('pre')?.textContent?.includes('JCad renderer: ' + expected)) {
      need(Date.now() < deadline, 'About does not report the actual ' + expected + ' renderer');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const close = section.closest('.modal')?.querySelector('.modal-close');
    need(close, 'About close control missing');
    /** @type {HTMLElement} */ (close).click();
    await ed.runCommand('REPORTBUG');
    const preview = document.querySelector('.report-preview');
    need(preview?.textContent?.includes('JCad renderer: ' + expected), 'Problem report does not expose the actual ' + expected + ' renderer');
    const reportClose = preview?.closest('.modal')?.querySelector('.modal-close');
    need(reportClose, 'Problem report close control missing');
    /** @type {HTMLElement} */ (reportClose).click();
    return expected;
  };
  const beforeRenderer = await rendererLabel('Canvas 2D');
  const options3d = async () => {
    await ed.runCommand('OPTIONS');
    const modal = document.querySelector('.modal');
    const marked = Array.from(modal?.querySelectorAll('label.dlg-check[data-setting="experimental3d"]') || []);
    // Historical installers had one English 3D checkbox without the stable setting key.
    const labels = marked.length ? marked : Array.from(modal?.querySelectorAll('label.dlg-check') || []).filter(label => /\b3D\b/.test(label.textContent || ''));
    need(labels.length === 1, 'Options must expose exactly one 3D tools setting');
    const checkbox = labels[0].querySelector('input[type="checkbox"]');
    need(checkbox, '3D tools checkbox missing');
    const ok = modal?.querySelector('.modal-footer button.primary');
    need(ok, 'Options acceptance control missing');
    return { modal, checkbox, ok };
  };
  if (phase === '3d-default') {
    const c = w.jcad3d;
    need(ed.settings.experimental3d === true && c && ['BOX', '3DMODE', '3DVIEW', 'UNION'].every(name => ed.commands.has(name)), 'Fresh profile must make 3D tools available');
    need(!c.active && !c.viewport && !c.kernelStarted && document.querySelectorAll('canvas.viewport3d').length === 0 && ed.viewport.canvas.style.visibility !== 'hidden', 'Default 3D tools must keep Canvas active without a 3D context or kernel');
    need(ed.settings.importForeign3d === false, 'Foreign 3D import must remain off by default');
    const { modal, checkbox, ok } = await options3d();
    need(/** @type {HTMLInputElement} */ (checkbox).checked, 'Fresh 3D tools option must be checked');
    const foreign = modal?.querySelector('label.dlg-check[data-setting="importForeign3d"] input[type="checkbox"]');
    need(foreign && !/** @type {HTMLInputElement} */ (foreign).checked, 'Foreign 3D import option must be unchecked');
    /** @type {HTMLElement} */ (checkbox).click();
    /** @type {HTMLElement} */ (ok).click();
    need(ed.settings.experimental3d === false && JSON.parse(localStorage.getItem('jcad.settings.v2') || '{}').experimental3d === false && ed.settings.importForeign3d === false, 'Options did not persist explicitly disabled 3D tools');
    need(w.jcad3d === c && !c.active && !c.viewport && !c.kernelStarted && document.querySelectorAll('canvas.viewport3d').length === 0 && ed.viewport.canvas.style.visibility !== 'hidden', 'Disabling 3D tools must leave the current inactive controller and Canvas unchanged until restart');
    return { phase, version: info.version, packaged: info.packaged, toolsAvailable: true, controllerInstalled: true, controllerInactive: true, canvasDefault: true, no3dCanvas: true, kernelUnstarted: true, foreignImportDisabled: true, optionInitiallyChecked: true, disabledPersisted: true, controllerStillInactive: true, restartRequired: true, beforeRenderer };
  }
  if (phase === '3d-enable') {
    need(ed.settings.experimental3d === false && !w.jcad3d, 'Restarted profile must begin with experimental 3D off');
    const { checkbox, ok } = await options3d();
    need(!/** @type {HTMLInputElement} */ (checkbox).checked, 'Experimental 3D option must be off before enabling');
    /** @type {HTMLElement} */ (checkbox).click();
    /** @type {HTMLElement} */ (ok).click();
    need(ed.settings.experimental3d === true && JSON.parse(localStorage.getItem('jcad.settings.v2') || '{}').experimental3d === true && !w.jcad3d, 'Options did not persist 3D for the next real launch');
    return { phase, version: info.version, packaged: info.packaged, optionPersisted: true, restartRequired: true, beforeRenderer };
  }
  need(phase === '3d' && ed.settings.experimental3d === true && w.jcad3d && !w.jcad3d.active, 'Restart did not install the opted-in 3D controller');
  const c = w.jcad3d;
  await ed.runCommand('3DMODE');
  need(c.active && c.viewport && document.querySelectorAll('canvas.viewport3d').length === 1, '3DMODE did not create the actual viewport');
  const vp = c.viewport, gl = vp.device.gl;
  need(gl instanceof WebGL2RenderingContext && !gl.isContextLost(), 'Shipping 3D requires a real WebGL2 context');
  const capabilities = vp.device.capabilities();
  need(/WebGL 2/.test(capabilities.version) && capabilities.maxTextureSize > 0, 'WebGL2 capability evidence is missing');
  const activeRenderer = await rendererLabel('WebGL2 experimental 3D modelling viewport');
  const kernel = c.kernel(), status = await kernel.ready();
  need(status.available === true && /^Manifold .* \(worker\)$/.test(kernel.name) && kernel.workersCreated === 1, 'The bundled Manifold worker did not become ready');
  for (const inputs of [['0,0,0', '1,1,0', '1'], ['0.5,0,0', '1.5,1,0', '1']]) {
    await ed.runCommand('BOX');
    for (const input of inputs) ed.submitInput(input);
    await c.idle();
    need(!ed.tool, 'BOX did not finish through the ordinary command path');
  }
  const ids = c.solidIds();
  need(ids.length === 2, 'Two bounded authored boxes are required');
  await ed.runCommand('UNION');
  for (const id of ids) ed.submitInput(id);
  ed.pressEnter();
  await c.idle();
  const solids = ed.doc.snapshot.model3d?.solids;
  need(!ed.tool && solids?.length === 1 && solids[0].feature.kind === 'boolean' && solids[0].feature.op === 'union' && kernel.workersCreated === 1, 'The real worker UNION did not commit one solid');
  const mesh = solids[0].mesh;
  let volume = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const [a, b, d] = mesh.indices.slice(t, t + 3).map(i => mesh.positions.slice(3 * i, 3 * i + 3));
    volume += (a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
  }
  need(Number.isFinite(volume) && Math.abs(volume - 1.5) < 1e-9, 'Manifold UNION volume must be 1.5');
  await ed.runCommand('3DVIEW swiso');
  await ed.runCommand('3DZOOMEXTENTS');
  vp.render({ selection: ed.selection, hover: c.hover });
  const point = c.project({ x: 0.75, y: 0.5, z: 0.5 });
  need(point && vp.pick(point.x, point.y) === solids[0].id && vp.lastPickPath === 'gpu', 'Rendered solid must be picked through the WebGL id buffer');
  // Read in the same task as the real frame; preserveDrawingBuffer deliberately remains false.
  vp.render({ selection: ed.selection, hover: c.hover });
  const pixel = new Uint8Array(4), clear = gl.getParameter(gl.COLOR_CLEAR_VALUE);
  gl.readPixels(Math.floor(point.x * vp.dpr), vp.canvas.height - 1 - Math.floor(point.y * vp.dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
  need(gl.getError() === gl.NO_ERROR && [0, 1, 2].some(i => Math.abs(pixel[i] - Math.round(clear[i] * 255)) > 8), 'The actual 3D frame must contain visible solid ink');
  const signature = JSON.stringify(solids.map(s => ({ id: s.id, layer: s.layer, color: s.color, feature: s.feature, mesh: s.mesh })));
  const previousError = ed.hooks.saveError;
  ed.hooks.saveError = async info => { throw new Error('Shipping 3D save failed: ' + info.message); };
  try {
    need(await ed.saveFile(true, 'dxf') && ed.doc.filePath === output && !ed.doc.dirty, '3D DXF Save As did not bind cleanly');
    const saved = ed.doc.snapshot;
    need(await ed.openFile(output) && ed.doc.snapshot !== saved && !ed.doc.dirty, '3D DXF did not freshly reopen');
    need(JSON.stringify(ed.doc.snapshot.model3d?.solids.map(s => ({ id: s.id, layer: s.layer, color: s.color, feature: s.feature, mesh: s.mesh }))) === signature, 'DXF reopen changed exact 3D mesh, identity or construction history');
    const state = ed.doc.snapshot, revision = ed.doc.revision, binding = ed.doc.filePath, history = ed.doc.history();
    need(!await ed.saveFile(true) && /^DWG files cannot hold 3D objects/.test(ed.lastFileError || ''), '3D DWG Save As must refuse');
    need(ed.doc.snapshot === state && ed.doc.revision === revision && ed.doc.filePath === binding && !ed.doc.dirty && ['undo', 'redo'].every(key => ed.doc.history()[key].length === history[key].length), 'DWG refusal changed the working 3D drawing');
  } finally { ed.hooks.saveError = previousError; }
  if (c.active) await ed.runCommand('3DMODE');
  need(!c.active && !c.viewport && !c.kernelStarted && document.querySelectorAll('canvas.viewport3d').length === 0 && ed.viewport.canvas.style.visibility !== 'hidden', 'Leaving 3D did not dispose its worker/context and restore Canvas');
  const afterRenderer = await rendererLabel('Canvas 2D');
  return { phase, version: info.version, packaged: info.packaged, optionRestarted: true, webgl2: true, visibleInk: true, gpuPicked: true, kernelWorker: true, kernelName: kernel.name, workers: kernel.workersCreated, unionVolume: volume, dxfSaveAsReopened: true, dwgRefused: true, canvasRestored: true, workerDisposed: true, beforeRenderer, activeRenderer, afterRenderer, signature, capabilities };
}

/** Fixed second save, called only after main has captured the first saved bytes. */
async function shipping3dSecondSave(output, signature) {
  const ed = /** @type {any} */ (window).editor;
  if (ed.doc.filePath !== output || ed.doc.dirty) throw new Error('3D second save requires its clean first save');
  const previousError = ed.hooks.saveError;
  ed.hooks.saveError = async info => { throw new Error('Shipping 3D second save failed: ' + info.message); };
  try {
    ed.doc.addEntities([{ id: 'shipping-3d-second-save-line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 3, y: 2 }, b: { x: 4, y: 2 } }]);
    if (!await ed.saveFile(false) || ed.doc.dirty) throw new Error('3D normal DXF Save failed');
    const saved = ed.doc.snapshot;
    if (!await ed.openFile(output) || ed.doc.snapshot === saved || ed.doc.dirty) throw new Error('3D second DXF Save did not freshly reopen');
    if (JSON.stringify(ed.doc.snapshot.model3d?.solids.map(s => ({ id: s.id, layer: s.layer, color: s.color, feature: s.feature, mesh: s.mesh }))) !== signature || ed.doc.entities.length !== 2 || !ed.doc.entities.some(e => e.type === 'line' && e.a.x === 3 && e.a.y === 2 && e.b.x === 4 && e.b.y === 2)) throw new Error('3D second DXF Save changed solids or lost the 2D edit');
    return { dxfSecondSaveReopened: true, secondSaveEntities: 2 };
  } finally { ed.hooks.saveError = previousError; }
}

/** @param {import('./context.cjs').MainContext} ctx */
async function runShipping3dProbe(ctx, phase, testBuild) {
  if (!['3d-default', '3d-enable', '3d'].includes(phase) || testBuild) throw new Error('3D probe requires a fixed shipping phase');
  const win = ctx.mainWindow;
  if (!win || win.isDestroyed()) throw new Error('No renderer window');
  const namedProfile = app.getPath('userData'), profile = fs.realpathSync.native(namedProfile);
  if (fs.lstatSync(namedProfile).isSymbolicLink() || path.dirname(profile) !== fs.realpathSync.native(os.tmpdir()) || !/^jcad-shipping-smoke-[A-Za-z0-9-]+$/.test(path.basename(profile))) throw new Error('3D probe requires its temporary smoke profile');
  const fixture = path.join(profile, 'shipping-startup.dxf'), stat = fs.lstatSync(fixture);
  if (stat.isSymbolicLink()) throw new Error('3D probe refuses a linked fixture');
  if (!stat.isFile() || stat.size <= 0 || stat.size > 4096 || fs.realpathSync.native(fixture) !== fixture) throw new Error('3D probe requires its bounded regular authored DXF');
  const sourceBytes = fs.readFileSync(fixture), output = path.join(profile, 'shipping-3d-output.dxf'), refusal = path.join(profile, 'shipping-3d-refusal.dwg');
  if (phase === '3d-default' || phase === '3d-enable') return { ...await win.webContents.executeJavaScript(`(${shipping3dRenderer.toString()})(${JSON.stringify(phase)},${JSON.stringify(fixture)},${JSON.stringify(output)})`), testBuild };
  for (const file of [output, output + '.bak', refusal, refusal + '.bak']) {
    try { fs.lstatSync(file); throw new Error('3D probe may not use a pre-existing destination'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const refusalBytes = Buffer.from('fixed shipping 3D refusal destination'), refusalBackup = Buffer.from('fixed shipping 3D refusal backup');
  fs.writeFileSync(refusal, refusalBytes, { flag: 'wx' }); fs.writeFileSync(refusal + '.bak', refusalBackup, { flag: 'wx' });
  const previousDialog = dialog.showSaveDialog;
  let picks = 0;
  /** @param {Electron.BaseWindow | Electron.SaveDialogOptions} _window @param {Electron.SaveDialogOptions} [options] */
  dialog.showSaveDialog = async (_window, options) => {
    const picked = /** @type {Electron.SaveDialogOptions} */ (options || _window);
    if (picked?.title !== 'Save Drawing As' || !picked.filters?.some(filter => filter.extensions.includes(picks === 0 ? 'dxf' : 'dwg')) || picks >= 2) throw new Error('Unexpected picker during fixed shipping 3D probe');
    return { canceled: false, filePath: picks++ === 0 ? output : refusal };
  };
  try {
    const result = await win.webContents.executeJavaScript(`(${shipping3dRenderer.toString()})('3d',${JSON.stringify(fixture)},${JSON.stringify(output)})`);
    const firstSaved = fs.readFileSync(output);
    if (picks !== 2 || !firstSaved.includes(Buffer.from('JCAD_3D')) || !fs.readFileSync(refusal).equals(refusalBytes) || !fs.readFileSync(refusal + '.bak').equals(refusalBackup)) throw new Error('3D Save As or guarded DWG destination evidence failed');
    const second = await win.webContents.executeJavaScript(`(${shipping3dSecondSave.toString()})(${JSON.stringify(output)},${JSON.stringify(result.signature)})`);
    const finalSaved = fs.readFileSync(output);
    if (!fs.readFileSync(output + '.bak').equals(firstSaved) || finalSaved.equals(firstSaved) || !fs.readFileSync(fixture).equals(sourceBytes)) throw new Error('3D second-save backup or original source preservation failed');
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const { signature: _signature, ...record } = result;
    return { ...record, ...second, testBuild, backupExact: true, sourceUnchanged: true, sourceSha256: hash(sourceBytes), firstSaveSha256: hash(firstSaved), outputSha256: hash(finalSaved), backupSha256: hash(firstSaved) };
  } finally { dialog.showSaveDialog = previousDialog; }
}

/** Pure owner-bound signature; native ids/handles may change on each fresh import. */
function shippingGpu2dMetadata(state) {
  const spans = [];
  for (const node of state.cadGraph?.nodes || []) {
    for (let at = 0; at < node.groups.length; at++) {
      if (node.groups[at][0] !== 1001 || node.groups[at][1] !== 'SHIPPING_GPU') continue;
      const anchor = node.anchor;
      const ordinal = anchor?.kind === 'entity' ? state.entities.findIndex(entity => entity.id === anchor.id) : -1;
      const owner = ordinal >= 0 ? state.entities[ordinal] : null;
      if (anchor?.kind !== 'entity' || anchor.part !== undefined || ordinal !== 0
        || owner?.type !== 'line' || node.type !== 'LINE' || owner.cadIdentity !== node.id) {
        throw new Error('GPU2D SHIPPING_GPU metadata must belong to its original LINE owner at ordinal zero');
      }
      let end = at + 1;
      while (end < node.groups.length && node.groups[end][0] !== 1001) end++;
      spans.push({ owner: { kind: 'entity', ordinal: 0, type: 'line' }, groups: node.groups.slice(at, end) });
      at = end - 1;
    }
  }
  return JSON.stringify(spans);
}

/** Pure fixed synchronous pending-font proof; a thenable selector is not admitted. */
function shippingGpu2dPendingFontFrame(control) {
  const select = mode => {
    const result = control.select(mode);
    if (result && typeof result.then === 'function') throw new Error('GPU2D pending font selector must remain synchronous');
  };
  control.assertPending('before-reference');
  select('CANVAS'); control.paint();
  control.assertPending('at-reference');
  const referencePng = control.capture('canvas');
  control.assertPending('after-reference');
  control.resetCounts(); control.assertPending('after-counter-reset');
  select('GPU'); control.paint();
  control.assertPending('at-actual');
  const actualPng = control.capture('canvas');
  control.assertPending('after-actual');
  const glCalls = { ...control.counts() };
  control.assertPending('after-count-capture');
  return { label: 'native-font-before', renderer: 'canvas', referencePng, actualPng, glCalls,
    documentUnchanged: true, metricsPendingAtCapture: true };
}

/** Observe the actual Editor.render -> Viewport.requestRender overlay without a private-field assumption. */
function shippingGpu2dRenderOverlay(editor) {
  const viewport = editor.viewport, request = viewport.requestRender;
  const descriptor = Object.getOwnPropertyDescriptor(viewport, 'requestRender');
  /** @type {any} */
  let overlay;
  /** @this {any} */
  const observe = function (...args) { overlay = args[0]; return Reflect.apply(request, this, args); };
  Object.defineProperty(viewport, 'requestRender', { configurable: true, writable: true, value: observe });
  try { editor.render(); }
  finally {
    if (descriptor) Object.defineProperty(viewport, 'requestRender', descriptor);
    else delete viewport.requestRender;
  }
  if (!overlay || !Array.isArray(overlay.preview) || !Array.isArray(overlay.ghost) || overlay.selection !== editor.selection) {
    throw new Error('GPU2D requires the actual rendered Editor overlay');
  }
  return overlay;
}

/** Fixed ordinary-entry acceptance; no supplied code or renderer test API. */
async function shippingGpu2dRenderer(stage, fixture, output, previous) {
  const w = /** @type {any} */ (window);
  /** @type {(ok: unknown, message: string) => asserts ok} */
  const need = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = async (predicate, message, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) { need(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  need(stage === 'first' || stage === 'second', 'Fixed GPU2D renderer stage');
  await wait(() => w.editor?.doc.filePath && w.jcad && localStorage.getItem('jcad-origin-migrated') === '1', 'GPU2D private drawing did not become ready', 30000);
  const ed = w.editor, vp = ed.viewport;
  need(isSecureContext && location.href === 'jcad://app/index.html' && crypto.subtle, 'GPU2D requires secure ordinary entry');
  need(!w.gpuPrototype && !document.querySelector('[data-gpu-prototype]') && !ed.commands.has('GPU3DDEMO'), 'GPU2D cannot use development globals or demo commands');
  need(ed.commands.has('GPURENDERER'), 'Ordinary GPU command is required');
  shippingGpuAssertLazy3d(w, document);
  const info = await w.jcad.appInfo();
  // Bind the complete application span to the original semantic LINE owner.
  const metadata = () => shippingGpu2dMetadata(ed.doc.snapshot);
  const expectedXdata = JSON.stringify([{ owner: { kind: 'entity', ordinal: 0, type: 'line' },
    groups: [[1001, 'SHIPPING_GPU'], [1000, 'fixed opaque GPU metadata 9007199254740993'], [1070, '7']] }]);
  // These five fixed native primitives have explicit authored geometry/appearance.
  // Normalize only documented omission defaults; imported ids/handles may be regenerated.
  const semantic = () => JSON.stringify(ed.doc.snapshot.entities.map(entity => {
    const common = { type: entity.type, layer: entity.layer, color: entity.color,
      trueColor: entity.trueColor ?? null, colorName: entity.colorName ?? null,
      transparency: entity.transparency ?? null, linetype: entity.linetype ?? 'ByLayer',
      lineWeight: entity.lineWeight ?? null, ltscale: entity.ltscale ?? 1 };
    switch (entity.type) {
      case 'line': return { ...common, a: entity.a, b: entity.b };
      case 'circle': return { ...common, center: entity.center, radius: entity.radius, filled: !!entity.filled };
      case 'arc': return { ...common, center: entity.center, radius: entity.radius, startAngle: entity.startAngle, endAngle: entity.endAngle };
      case 'polyline': return { ...common, points: entity.points, closed: !!entity.closed, filled: !!entity.filled,
        bulges: entity.points.map((_, i) => entity.bulges?.[i] ?? 0), width: entity.width ?? 0,
        widths: entity.widths ?? null, widthFrame: entity.widthFrame ?? null };
      case 'text': return { ...common, position: entity.position, text: entity.text, height: entity.height,
        rotation: entity.rotation, align: entity.align, style: entity.style ?? 'Standard',
        widthFactor: entity.widthFactor ?? 1, oblique: entity.oblique ?? 0,
        justification: entity.justification ?? null, alignmentPoint: entity.alignmentPoint ?? null,
        firstAlignmentPoint: entity.firstAlignmentPoint ?? null, field: entity.field ?? null };
      default: throw new Error('Unexpected fixed GPU2D saved primitive: ' + entity.type);
    }
  }));
  const stamp = () => ({ state: ed.doc.snapshot, revision: ed.doc.revision, dirty: ed.doc.dirty, binding: ed.doc.filePath, undo: ed.doc.history().undo.length, redo: ed.doc.history().redo.length });
  const sameStamp = old => ed.doc.snapshot === old.state && ed.doc.revision === old.revision && ed.doc.dirty === old.dirty && ed.doc.filePath === old.binding && ed.doc.history().undo.length === old.undo && ed.doc.history().redo.length === old.redo;
  const rendererLabel = async expected => {
    await ed.runCommand('ABOUT');
    await wait(() => document.querySelector('section[aria-label="GPU diagnostics"] pre')?.textContent?.includes('JCad renderer: ' + expected), 'GPU2D About renderer mismatch');
    const close = document.querySelector('section[aria-label="GPU diagnostics"]')?.closest('.modal')?.querySelector('.modal-close');
    need(close, 'GPU2D About close control'); /** @type {HTMLElement} */ (close).click();
    await ed.runCommand('REPORTBUG');
    const preview = document.querySelector('.report-preview');
    need(preview?.textContent?.includes('JCad renderer: ' + expected), 'GPU2D problem-report renderer mismatch');
    const reportClose = preview?.closest('.modal')?.querySelector('.modal-close'); need(reportClose, 'GPU2D report close control');
    /** @type {HTMLElement} */ (reportClose).click();
    return expected;
  };
  if (stage === 'first') {
    need(ed.doc.filePath.replace(/\\/g, '/') === fixture.replace(/\\/g, '/') && ed.doc.entities.length === 1 && !ed.doc.dirty, 'GPU2D needs its clean handed-over authored DXF');
    need(metadata() === expectedXdata, 'GPU2D complete native XDATA was not retained');
    need(!document.querySelector('canvas[data-gpu-candidate="2d"]'), 'Fresh default must allocate no drawing GPU backing');
    await rendererLabel('Canvas 2D');
    need(!document.querySelector('canvas[data-gpu-candidate="2d"]'), 'Diagnostics must not activate drawing GPU');
    const first = ed.doc.snapshot.entities[0];
    ed.doc.transactDrawing(state => ({ ...state, entities: [
      { ...first, a: { x: -6, y: 2 }, b: { x: 6, y: 2 } },
      { id: 'shipping-gpu-circle', type: 'circle', layer: '0', color: 3, center: { x: -3, y: -1 }, radius: 1.5 },
      { id: 'shipping-gpu-arc', type: 'arc', layer: '0', color: 1, center: { x: 1, y: -1 }, radius: 1.5, startAngle: 0, endAngle: Math.PI * 1.5 },
      { id: 'shipping-gpu-polyline', type: 'polyline', layer: '0', color: 4, points: [{ x: 3, y: -2 }, { x: 5, y: -1 }, { x: 3, y: 0 }], closed: false },
      { id: 'shipping-gpu-text', type: 'text', layer: '0', color: 2, position: { x: -4, y: -4 }, text: 'GPU 2D', height: 0.7, rotation: 0, align: 'left' },
    ] }));
  } else {
    need(ed.doc.filePath === output && !ed.doc.dirty && semantic() === previous.semantic && metadata() === previous.metadata, 'GPU2D second save requires intact first reopen');
  }
  const overlay = shippingGpu2dRenderOverlay(ed);
  const originalSettings = { background: vp.settings.background, gridVisible: vp.settings.gridVisible };
  vp.settings.background = '#212830'; vp.settings.gridVisible = false;
  vp.center = { x: 0, y: -1 }; vp.scale = 20; vp.twist = 0;
  ed.selection.clear(); overlay.cursor = null; overlay.hover = null; overlay.snap = null;
  const comparisons = [], restores = [], counts = { draws: 0, uploads: 0, clear: 0, uploadBytes: 0 };
  // Populated by the real context hook during the ordinary command's render.
  /** @type {any} */ let gl;
  /** @type {any} */ let canvas;
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const attach = (candidate, context) => {
    if (gl) { need(gl === context && canvas === candidate, 'One owned GPU2D context'); return; }
    gl = context; canvas = candidate;
    need(gl instanceof WebGL2RenderingContext && !gl.isContextLost(), 'Actual production WebGL2 is required');
    for (const name of ['drawArrays', 'drawElements', 'bufferData', 'bufferSubData', 'clear']) {
      const original = gl[name];
      const wrapped = function (...args) {
        if (name.startsWith('draw')) counts.draws++;
        else if (name === 'clear') counts.clear++;
        else { counts.uploads++; const data = args[name === 'bufferData' ? 1 : 2]; counts.uploadBytes += typeof data === 'number' ? data : data?.byteLength || 0; }
        return Reflect.apply(original, gl, args);
      };
      gl[name] = wrapped; restores.push(() => { if (gl[name] === wrapped) gl[name] = original; });
    }
  };
  /** @this {HTMLCanvasElement} */
  const wrappedGetContext = function (...args) {
    const context = Reflect.apply(originalGetContext, this, args);
    if (args[0] === 'webgl2' && this.matches('canvas[data-gpu-candidate="2d"]')) attach(this, context);
    return context;
  };
  HTMLCanvasElement.prototype.getContext = wrappedGetContext;
  const resetCounts = () => { for (const key of Object.keys(counts)) counts[key] = 0; };
  const capture = renderer => {
    const width = vp.canvas.width, height = vp.canvas.height;
    need(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 4000000, 'GPU2D readback pixel budget');
    if (renderer === 'canvas') { need(!canvas || canvas.style.display === 'none', 'Complete Canvas must hide GPU backing'); return vp.canvas.toDataURL('image/png'); }
    need(gl && canvas?.style.display === 'block' && canvas.width === width && canvas.height === height && !gl.isContextLost(), 'Actual visible complete GPU backing');
    const pixels = new Uint8Array(width * height * 4), flipped = new Uint8ClampedArray(pixels.length);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    need(gl.getError() === gl.NO_ERROR, 'Actual GPU2D readback failed');
    for (let row = 0; row < height; row++) flipped.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), (height - 1 - row) * width * 4);
    const image = document.createElement('canvas'); image.width = width; image.height = height;
    const ctx = image.getContext('2d'); need(ctx, 'GPU2D composition context');
    ctx.putImageData(new ImageData(flipped, width, height), 0, 0); ctx.drawImage(vp.canvas, 0, 0);
    return image.toDataURL('image/png');
  };
  const paint = () => { ed.render(); vp.renderCurrent(); };
  const pair = async (label, renderer, priorReference) => {
    const before = stamp(), liveTool = ed.tool;
    const preview = overlay.preview, ghost = overlay.ghost;
    // The normal prompter cancels a live drawing tool before dispatching commands.
    // Only this fixed preview control invokes the existing registered callback directly.
    // Initial explicit GPU acceptance still uses the ordinary public command path.
    const select = async mode => {
      if (label === 'preview') {
        need(liveTool && (preview.length || ghost.length), 'GPU2D reference requires its live actual preview');
        await ed.commands.get('GPURENDERER').run(ed, mode);
        need(ed.tool === liveTool && overlay.preview === preview && overlay.ghost === ghost, 'GPU2D reference mode must preserve actual preview/ghost');
      } else await ed.runCommand('GPURENDERER ' + mode);
    };
    await select('CANVAS'); paint();
    const referencePng = priorReference || capture('canvas');
    resetCounts(); await select('GPU'); paint();
    // The existing immediate viewport seam completes the real requested frame in this task.
    const actualPng = capture(renderer), glCalls = { ...counts };
    need(sameStamp(before), 'GPU2D mode/render changed drawing history or binding: ' + label);
    comparisons.push({ label, renderer, referencePng, actualPng, glCalls, documentUnchanged: true });
    return referencePng;
  };
  const savedError = ed.hooks.saveError;
  ed.hooks.saveError = async error => { throw new Error('GPU2D real save failed: ' + error.message); };
  try {
    if (stage === 'second') {
      if (!gl) { const candidate = /** @type {HTMLCanvasElement | null} */ (document.querySelector('canvas[data-gpu-candidate="2d"]')); if (candidate) attach(candidate, candidate.getContext('webgl2')); }
      await ed.runCommand('LINE'); ed.submitInput('-6,-5'); ed.submitInput('6,-5'); ed.pressEnter();
      need(!ed.tool && ed.doc.entities.length === 6, 'GPU2D ordinary second-save LINE');
      await ed.runCommand('GPURENDERER CANVAS'); paint();
      const reference = capture('canvas'), expected = semantic(), expectedMetadata = metadata();
      need(await ed.saveFile(false) && !ed.doc.dirty, 'GPU2D ordinary second Save');
      const saved = ed.doc.snapshot; need(await ed.openFile(output) && ed.doc.snapshot !== saved && !ed.doc.dirty, 'GPU2D fresh second DXF reopen');
      vp.center = { x: 0, y: -1 }; vp.scale = 20; vp.twist = 0;
      need(semantic() === expected && metadata() === expectedMetadata, 'GPU2D second reopen changed authored entities or XDATA');
      await pair('second-dxf-reopen', 'gpu', reference);
      return { comparisons, secondSaveReopened: true, metadataPreserved: true };
    }
    const expectedMetadata = metadata();
    await pair('baseline', 'gpu');
    need(gl && canvas, 'GPU2D baseline must create its owned actual context');
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const adapter = { version: gl.getParameter(gl.VERSION), vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER), unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : 'Unknown', unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'Unknown', maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
    const activeRenderer = await rendererLabel('WebGL2 drawing base scene + Canvas 2D editing overlays (experimental)');
    await pair('warm', 'gpu');
    need(comparisons[comparisons.length - 1].glCalls.uploads === 0, 'GPU2D warm scene must reuse actual GPU buffers');
    vp.center = { x: 0.2, y: -1.1 }; await pair('pan', 'gpu');
    vp.scale = 21; await pair('zoom', 'gpu'); vp.center = { x: 0, y: -1 }; vp.scale = 20;
    const lineId = ed.doc.snapshot.entities[0].id;
    ed.doc.transactDrawing(state => ({ ...state, entities: state.entities.map(entity => entity.id === lineId ? { ...entity, b: { x: 5, y: 3 } } : entity) }));
    await pair('line-edit', 'gpu'); need(ed.doc.undo(), 'GPU2D LINE undo'); await pair('line-undo', 'gpu');
    need(ed.doc.redo(), 'GPU2D LINE redo'); await pair('line-redo', 'gpu');
    vp.settings.background = '#252a32'; await pair('display-change', 'gpu'); vp.settings.background = '#212830';
    vp.settings.gridVisible = true; await pair('grid', 'canvas'); vp.settings.gridVisible = false;
    ed.doc.addEntities([{ id: 'shipping-gpu-unsupported', type: 'ellipse', layer: '0', color: 6, center: { x: 0, y: -1 }, majorAxis: { x: 2, y: 0 }, ratio: 0.5, startParam: 0, endParam: Math.PI * 2 }]);
    await pair('unsupported-entity', 'canvas'); need(ed.doc.undo(), 'GPU2D unsupported control undo');
    await ed.runCommand('LINE'); ed.submitInput('0,-5');
    const p = vp.toScreen({ x: 3, y: -4 }), rect = vp.canvas.getBoundingClientRect();
    vp.canvas.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: rect.left + p.x, clientY: rect.top + p.y }));
    need(ed.tool && overlay.preview.length > 0, 'GPU2D actual tool preview'); await pair('preview', 'canvas'); ed.cancel();
    const layout = ed.doc.layouts[0];
    const viewport = { id: 'shipping-gpu-viewport', center: { x: 100, y: 75 }, width: 100, height: 70, view: { center: { x: 0, y: -1 }, scale: 4 }, layer: '0', on: true,
      clipBoundary: { id: 'shipping-gpu-clip', type: 'polyline', layer: '0', color: 7, points: [{ x: 50, y: 40 }, { x: 150, y: 40 }, { x: 135, y: 110 }, { x: 70, y: 100 }], closed: true } };
    ed.doc.transactDrawing(state => ({ ...state, layouts: [{ ...layout, pristine: false, viewports: [viewport] }], space: { layout: layout.name } }));
    need(vp.layoutPainter, 'GPU2D real paper layout controller'); await pair('layout', 'canvas');
    ed.doc.setSpace({ layout: layout.name, viewport: viewport.id });
    need(vp.layoutPainter && vp.fitRect, 'GPU2D actual clipped floating viewport'); await pair('viewport-clip', 'canvas');
    ed.doc.setSpace(undefined); need(ed.doc.undo(), 'GPU2D layout control undo');
    vp.center = { x: 0, y: -1 }; vp.scale = 20; vp.twist = 0;
    overlay.cursor = null; overlay.hover = null; overlay.snap = null;
    // Tahoma is a real Windows face unused by this fixed fixture's earlier controls.
    // Already cached/unavailable resources fail this gate rather than becoming a claimed run.
    ed.doc.transactDrawing(state => ({ ...state, meta: { ...state.meta, textStyles: { ...state.meta?.textStyles, SHIPPING_NATIVE: { name: 'SHIPPING_NATIVE', font: 'tahoma.ttf', family: 'Tahoma', height: 0, widthFactor: 1, oblique: 0 } } }, entities: state.entities.map(entity => entity.type === 'text' ? { ...entity, style: 'SHIPPING_NATIVE' } : entity) }));
    const nativeGeometry = ed.doc.lookupBlock.textGeometry;
    const nativeAppearance = nativeGeometry.resolve({ style: 'SHIPPING_NATIVE' });
    const nativeStamp = stamp(), pendingEpoch = nativeGeometry.cacheKey;
    const assertPending = phase => {
      need(sameStamp(nativeStamp) && ed.doc.lookupBlock.textGeometry === nativeGeometry
        && nativeGeometry.cacheKey === pendingEpoch && nativeAppearance.kind === 'canvas'
        && nativeGeometry.advances('GPU 2D', 0.7, nativeAppearance) === null,
      'GPU2D native font transition unrun/inconclusive: real uncached metrics must remain pending at ' + phase);
    };
    comparisons.push(shippingGpu2dPendingFontFrame({ assertPending,
      select: mode => ed.commands.get('GPURENDERER').run(ed, mode), paint, capture,
      resetCounts, counts: () => counts }));
    // There has been no await since requesting the native resource. GPU remains selected
    // across settlement, and this hook observes the ordinary resulting frame before manual paint.
    let settledImage, settledCounts, settledEpoch, fontError, fontCaptureScheduled = false;
    const nativeScene = vp.experimentalSceneRenderer;
    need(nativeScene, 'GPU2D existing production scene hook is required for font settlement');
    const settledScene = function (...args) {
      const rendered = Reflect.apply(nativeScene, vp, args);
      if (nativeGeometry.cacheKey !== pendingEpoch && !fontCaptureScheduled) {
        fontCaptureScheduled = true;
        queueMicrotask(() => {
          try {
            need(rendered === false && sameStamp(nativeStamp) && ed.doc.lookupBlock.textGeometry === nativeGeometry
              && nativeGeometry.cacheKey !== pendingEpoch && nativeGeometry.advances('GPU 2D', 0.7, nativeAppearance)?.length === 6,
            'GPU2D first automatic settled native-font frame must use genuine loaded metrics and complete Canvas without document changes');
            need(Object.values(counts).every(value => value === 0), 'GPU2D native font settlement submitted partial GPU work');
            settledEpoch = nativeGeometry.cacheKey;
            settledImage = capture('canvas'); settledCounts = { ...counts };
            need(nativeGeometry.cacheKey === settledEpoch && sameStamp(nativeStamp), 'GPU2D native font epoch/document changed during automatic capture');
          } catch (error) { fontError = error; }
        });
      }
      return rendered;
    };
    vp.experimentalSceneRenderer = settledScene;
    const restoreNativeScene = () => { if (vp.experimentalSceneRenderer === settledScene) vp.experimentalSceneRenderer = nativeScene; };
    restores.push(restoreNativeScene);
    assertPending('before-transition-counter-reset'); resetCounts(); assertPending('after-transition-counter-reset');
    await wait(() => settledImage || fontError, 'GPU2D genuine native font settlement/first automatic Canvas frame did not arrive');
    if (fontError) throw fontError;
    restoreNativeScene();
    need(nativeGeometry.cacheKey === settledEpoch && sameStamp(nativeStamp), 'GPU2D settled native-font prerequisite changed before reference');
    const selected = ed.commands.get('GPURENDERER').run(ed, 'CANVAS');
    need(!selected || typeof selected.then !== 'function', 'GPU2D settled reference selector must remain synchronous');
    paint();
    need(nativeGeometry.cacheKey === settledEpoch && sameStamp(nativeStamp), 'GPU2D settled epoch/document changed at independent reference');
    const settledReference = capture('canvas');
    need(nativeGeometry.cacheKey === settledEpoch && sameStamp(nativeStamp), 'GPU2D settled epoch/document changed during independent reference');
    comparisons.push({ label: 'native-font-after', renderer: 'canvas', referencePng: settledReference, actualPng: settledImage,
      glCalls: settledCounts, documentUnchanged: true, metricsLoadedAtCapture: true, firstAutomaticFrame: true });
    need(ed.doc.undo(), 'GPU2D native style control undo'); await pair('font-restored', 'gpu');
    const ownedCanvas = canvas;
    const extension = gl.getExtension('WEBGL_lose_context'); need(extension, 'GPU2D actual context loss extension');
    const contextStamp = stamp();
    let restoredImage, restoredCounts, restoreError, restorationSeen = false, captureScheduled = false;
    const originalScene = vp.experimentalSceneRenderer;
    need(originalScene, 'GPU2D existing production scene hook is required');
    const onRestore = () => { restorationSeen = true; };
    const restoredScene = function (...args) {
      const rendered = Reflect.apply(originalScene, vp, args);
      if (restorationSeen && rendered && !captureScheduled) {
        captureScheduled = true;
        // The real automatic RAF finishes Canvas overlays before this microtask.
        // No extra frame is requested; readback still precedes compositor discard.
        queueMicrotask(() => {
          try { restoredImage = capture('gpu'); restoredCounts = { ...counts }; }
          catch (error) { restoreError = error; }
        });
      }
      return rendered;
    };
    vp.experimentalSceneRenderer = restoredScene;
    restores.push(() => { if (vp.experimentalSceneRenderer === restoredScene) vp.experimentalSceneRenderer = originalScene; });
    ownedCanvas.addEventListener('webglcontextrestored', onRestore, { once: true });
    restores.push(() => ownedCanvas.removeEventListener('webglcontextrestored', onRestore));
    extension.loseContext(); await wait(() => gl.isContextLost() && canvas.style.display === 'none', 'GPU2D loss did not expose complete Canvas');
    const contextReference = await pair('context-lost', 'canvas'); resetCounts(); extension.restoreContext();
    await wait(() => restoredImage || restoreError, 'GPU2D first automatic restored frame was not captured');
    if (restoreError) throw restoreError;
    need(sameStamp(contextStamp), 'GPU2D actual context loss/restoration changed drawing/history/binding');
    comparisons.push({ label: 'context-restored', renderer: 'gpu', referencePng: contextReference, actualPng: restoredImage, glCalls: restoredCounts, documentUnchanged: true });
    const expected = semantic(), metadataBeforeSave = metadata();
    await ed.runCommand('GPURENDERER CANVAS'); paint(); const beforeSave = capture('canvas');
    need(await ed.saveFile(true, 'dxf') && ed.doc.filePath === output && !ed.doc.dirty, 'GPU2D real DXF Save As');
    const saved = ed.doc.snapshot; need(await ed.openFile(output) && ed.doc.snapshot !== saved && !ed.doc.dirty, 'GPU2D first fresh DXF reopen');
    vp.center = { x: 0, y: -1 }; vp.scale = 20; vp.twist = 0;
    need(semantic() === expected && metadata() === metadataBeforeSave && metadata() === expectedMetadata, 'GPU2D first reopen changed geometry or opaque metadata');
    await pair('first-dxf-reopen', 'gpu', beforeSave);
    return { phase: 'gpu2d', version: info.version, packaged: info.packaged, url: location.href, secure: true, defaultCanvas: true, noDefaultGpuAllocation: true, noRendererTestGlobals: true, explicitCommand: true, webgl2: true, visibleInk: true, beforeRenderer: 'Canvas 2D', activeRenderer, adapter, comparisons, semantic: expected, metadata: expectedMetadata,
      firstSaveReopened: true, metadataPreserved: true, realContextLoss: true, automaticContextRestored: true, fontEpochChanged: true, fontDocumentUnchanged: true, displayInvalidated: true, editUndoRedo: true };
  } finally {
    ed.hooks.saveError = savedError;
    if (HTMLCanvasElement.prototype.getContext === wrappedGetContext) HTMLCanvasElement.prototype.getContext = originalGetContext;
    for (const restore of restores.reverse()) restore();
    vp.settings.background = originalSettings.background; vp.settings.gridVisible = originalSettings.gridVisible;
  }
}

/** Same bounded private-profile and exact-byte guarantees as existing shipping probes. */
async function runShippingGpu2dProbe(ctx, testBuild) {
  if (testBuild) throw new Error('GPU2D probe requires ordinary shipping entry');
  const win = ctx.mainWindow; if (!win || win.isDestroyed()) throw new Error('No renderer window');
  const named = app.getPath('userData'), profile = fs.realpathSync.native(named);
  if (fs.lstatSync(named).isSymbolicLink() || path.dirname(profile) !== fs.realpathSync.native(os.tmpdir()) || !/^jcad-shipping-smoke-[A-Za-z0-9-]+$/.test(path.basename(profile))) throw new Error('GPU2D probe requires its temporary smoke profile');
  const fixture = path.join(profile, 'shipping-startup.dxf'), stat = fs.lstatSync(fixture);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > 4096 || fs.realpathSync.native(fixture) !== fixture) throw new Error('GPU2D probe requires its bounded regular authored DXF');
  const source = fs.readFileSync(fixture), output = path.join(profile, 'shipping-gpu2d-output.dxf');
  for (const file of [output, output + '.bak']) {
    try { fs.lstatSync(file); throw new Error('GPU2D probe may not use a pre-existing destination'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const savedDialog = dialog.showSaveDialog; let picks = 0;
  /** @param {Electron.BaseWindow | Electron.SaveDialogOptions} _window @param {Electron.SaveDialogOptions} [options] */
  dialog.showSaveDialog = async (_window, options) => {
    const picked = /** @type {Electron.SaveDialogOptions} */ (options || _window);
    if (picked?.title !== 'Save Drawing As' || !picked.filters?.some(filter => filter.extensions.includes('dxf')) || picks++) throw new Error('Unexpected picker during fixed GPU2D probe');
    return { canceled: false, filePath: output };
  };
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  // Only these main-authored fixed helpers are serialized; callers cannot supply code.
  const helpers = `const shippingGpuAssertLazy3d=(${shippingGpuAssertLazy3d.toString()});const shippingGpu2dMetadata=(${shippingGpu2dMetadata.toString()});const shippingGpu2dPendingFontFrame=(${shippingGpu2dPendingFontFrame.toString()});const shippingGpu2dRenderOverlay=(${shippingGpu2dRenderOverlay.toString()});`;
  try {
    const first = await win.webContents.executeJavaScript(`(() => {${helpers} return (${shippingGpu2dRenderer.toString()})('first',${JSON.stringify(fixture)},${JSON.stringify(output)},null);})()`);
    const firstSaved = fs.readFileSync(output);
    if (picks !== 1 || firstSaved.length <= 0 || firstSaved.length > 4 * 1024 * 1024 || !firstSaved.includes(Buffer.from('fixed opaque GPU metadata 9007199254740993'))) throw new Error('GPU2D first-save evidence failed');
    const second = await win.webContents.executeJavaScript(`(() => {${helpers} return (${shippingGpu2dRenderer.toString()})('second',${JSON.stringify(fixture)},${JSON.stringify(output)},${JSON.stringify({ semantic: first.semantic, metadata: first.metadata })});})()`);
    const final = fs.readFileSync(output), backup = fs.readFileSync(output + '.bak');
    if (final.length <= 0 || final.length > 4 * 1024 * 1024 || final.equals(firstSaved) || !backup.equals(firstSaved) || !fs.readFileSync(fixture).equals(source)) throw new Error('GPU2D exact backup or original source preservation failed');
    const { semantic: _semantic, metadata: _metadata, ...record } = first;
    return { ...record, ...second, comparisons: [...first.comparisons, ...second.comparisons], testBuild, sourceUnchanged: true, backupExact: true, fixtureSha256: hash(source), firstSaveSha256: hash(firstSaved), outputSha256: hash(final), backupSha256: hash(backup) };
  } finally { dialog.showSaveDialog = savedDialog; }
}
function shippingProbePhase(args) {
  const flags = args.filter((arg) => typeof arg === 'string' && arg.startsWith('--probe-startup='));
  if (!flags.length) return null;
  if (flags.length !== 1 || !/^--probe-startup=(first|second|dwg|3d-default|3d-enable|3d|gpu2d|gpu2d-shx|gpu2d-3d)$/.test(flags[0])) throw new Error('Invalid startup probe phase');
  return flags[0].slice('--probe-startup='.length);
}

/** @param {import('./context.cjs').MainContext} ctx */
async function runShippingProbe(ctx, phase, testBuild) {
  if (!['first', 'second', 'dwg', '3d-default', '3d-enable', '3d', 'gpu2d', 'gpu2d-shx', 'gpu2d-3d'].includes(phase)) throw new Error('Invalid startup probe phase');
  // The application's existing 60-second startup deadline remains authoritative for 3D too.
  const timer = setTimeout(() => { process.stdout.write('SHIPPING_PROBE_FAIL timed out\n'); app.exit(1); }, phase === '3d' ? 60_000 : 45_000);
  try {
    if (phase === '3d-default' || phase === '3d-enable' || phase === '3d') {
      const record = await runShipping3dProbe(ctx, phase, testBuild);
      process.stdout.write(`SHIPPING_PROBE_OK ${JSON.stringify(record)}\n`);
      clearTimeout(timer);
      app.quit();
      return;
    }
    if (phase === 'gpu2d-3d') {
      const record = await runShippingGpu3dProbe(ctx, testBuild);
      process.stdout.write(`SHIPPING_PROBE_OK ${JSON.stringify(record)}\n`);
      clearTimeout(timer);
      app.quit();
      return;
    }
    if (phase === 'gpu2d-shx') {
      const record = await runShippingGpuShxProbe(ctx, testBuild, shippingGpu2dRenderOverlay);
      process.stdout.write('SHIPPING_PROBE_OK ' + JSON.stringify(record) + '\n');
      clearTimeout(timer); app.quit(); return;
    }
    if (phase === 'gpu2d') {
      const record = await runShippingGpu2dProbe(ctx, testBuild);
      process.stdout.write(`SHIPPING_PROBE_OK ${JSON.stringify(record)}\n`);
      clearTimeout(timer); app.quit(); return;
    }
    if (phase === 'dwg') {
      const record = await runShippingDwgProbe(ctx, testBuild);
      process.stdout.write(`SHIPPING_PROBE_OK ${JSON.stringify(record)}\n`);
      clearTimeout(timer);
      app.quit();
      return;
    }
    const win = ctx.mainWindow;
    if (!win || win.isDestroyed()) throw new Error('No renderer window');
    // These probes may modify only their fresh temporary-profile fixture, never a user's
    // ordinary drawing/profile. Paths still need the normal OS hand-over/IPC grant.
    const profile = fs.realpathSync.native(app.getPath('userData'));
    if (path.dirname(profile) !== fs.realpathSync.native(os.tmpdir()) || !/^jcad-shipping-smoke-[A-Za-z0-9-]+$/.test(path.basename(profile))) throw new Error('Startup probe requires its temporary smoke profile');
    const fixture = fs.realpathSync.native(path.join(profile, 'shipping-startup.dxf'));
    const result = await win.webContents.executeJavaScript(`(async () => {
      const phase = ${JSON.stringify(phase)};
      const fixture = ${JSON.stringify(fixture)};
      const until = Date.now() + 30000;
      while (!window.editor || !window.jcad || !window.editor.doc.filePath || window.editor.doc.entities.length === 0 || localStorage.getItem('jcad-origin-migrated') !== '1') {
        if (Date.now() >= until) throw new Error('Renderer or handed-over DXF did not become ready');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const ed = window.editor;
      if (!/\\.dxf$/i.test(ed.doc.filePath)) throw new Error('Startup probe requires a handed-over DXF');
      if (ed.doc.filePath.replace(/\\\\/g, '/') !== fixture.replace(/\\\\/g, '/')) throw new Error('Startup probe may save only its own temporary DXF');
      const info = await window.jcad.appInfo();
      const preference = localStorage.getItem('jcad-origin-test');
      const expected = phase === 'first' ? 'legacy preference Δ 雷' : 'new preference';
      if (preference !== expected) throw new Error('Preference migration or restart persistence failed');
      const before = ed.doc.entities.length;
      let saved = false;
      if (phase === 'first') {
        ed.doc.addEntities([{ id:'shipping-smoke-line', type:'line', layer:'0', color:'ByLayer', a:{x:0,y:0}, b:{x:3,y:4} }]);
        saved = await ed.saveFile(false);
        if (!saved || ed.doc.dirty) throw new Error('Real drawing save did not finish cleanly');
        localStorage.setItem('jcad-origin-test', 'new preference');
      } else {
        if (!ed.doc.entities.some(entity => entity.id === 'shipping-smoke-line' || (entity.type === 'line' && entity.a.x === 0 && entity.a.y === 0 && entity.b.x === 3 && entity.b.y === 4))) throw new Error('Saved drawing did not reopen');
      }
      if (!isSecureContext || !crypto.subtle || location.href !== 'jcad://app/index.html' || localStorage.getItem('jcad-origin-migrated') !== '1') throw new Error('Secure origin, crypto or migration marker failed');
      const settingsEvidence = (${shippingStartupSettingsEvidence.toString()})(window, document, localStorage);
      return { version:info.version, packaged:info.packaged, url:location.href, secure:true, bridge:true, preference, migrated:'1', before, entities:ed.doc.entities.length, saved, dirty:ed.doc.dirty, settingsEvidence };
    })()`);
    const storagePath = session.defaultSession.storagePath;
    const record = { ...result, phase, testBuild, persistent:session.defaultSession.isPersistent(), privateSessionData:fs.realpathSync.native(app.getPath('sessionData')) === profile, privateStorage:typeof storagePath === 'string' && fs.realpathSync.native(storagePath) === profile, migrationMarker:fs.existsSync(path.join(profile, 'renderer-origin-migrated')) };
    if (!record.persistent || !record.privateSessionData || !record.privateStorage || !record.migrationMarker) throw new Error('Private persistent storage or completed migration marker missing');
    process.stdout.write(`SHIPPING_PROBE_OK ${JSON.stringify(record)}\n`);
    clearTimeout(timer);
    // Normal quit exercises the renderer close workflow and storage flush. The harness
    // also requires a clean process exit before it launches the same profile again.
    app.quit();
  } catch (error) {
    clearTimeout(timer);
    process.stdout.write(`SHIPPING_PROBE_FAIL ${error && error.message}\n`);
    app.exit(1);
  }
}
module.exports = { runShippingProbe, shippingProbePhase, runShipping3dProbe, runShippingGpu2dProbe, shippingGpu2dMetadata, shippingGpu2dPendingFontFrame, shippingGpu2dRenderOverlay, shippingStartupSettingsEvidence };
