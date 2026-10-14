// Fixed diagnostics for the exact shipping executable. No supplied JavaScript, remote
// debugging transport or renderer IPC endpoint; only fixed, enumerated probe phases.
/* global window, document, localStorage, location, isSecureContext, WebGL2RenderingContext, crypto */
const { app, session, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { runShippingDwgProbe } = require('./shipping-dwg-probe.cjs');

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

function shippingProbePhase(args) {
  const flags = args.filter((arg) => typeof arg === 'string' && arg.startsWith('--probe-startup='));
  if (!flags.length) return null;
  if (flags.length !== 1 || !/^--probe-startup=(first|second|dwg|3d-default|3d-enable|3d)$/.test(flags[0])) throw new Error('Invalid startup probe phase');
  return flags[0].slice('--probe-startup='.length);
}

/** @param {import('./context.cjs').MainContext} ctx */
async function runShippingProbe(ctx, phase, testBuild) {
  if (!['first', 'second', 'dwg', '3d-default', '3d-enable', '3d'].includes(phase)) throw new Error('Invalid startup probe phase');
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
      return { version:info.version, packaged:info.packaged, url:location.href, secure:true, bridge:true, preference, migrated:'1', before, entities:ed.doc.entities.length, saved, dirty:ed.doc.dirty };
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
module.exports = { runShippingProbe, shippingProbePhase, runShipping3dProbe };
