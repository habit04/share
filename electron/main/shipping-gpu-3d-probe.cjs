// Fixed ordinary-entry GPU/3D transition diagnostics. No supplied renderer code.
/* global window, document, localStorage, location, isSecureContext, crypto, HTMLCanvasElement, WebGL2RenderingContext, MutationObserver, getComputedStyle, ImageData, requestAnimationFrame */
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { shippingGpuAssertLazy3d } = require('./shipping-gpu-lazy-3d.cjs');

const GPU3D_STARTUP_DXF = '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1015\n0\nENDSEC\n0\nSECTION\n2\nTABLES\n0\nTABLE\n5\nA0\n2\nAPPID\n70\n1\n0\nAPPID\n5\nA1\n2\nSHIPPING_TRANSITION\n70\n0\n0\nENDTAB\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLINE\n5\nA2\n8\n0\n10\n-6\n20\n0\n11\n6\n21\n0\n1001\nSHIPPING_TRANSITION\n1000\nfixed transition metadata 9007199254740993\n1070\n7\n0\nENDSEC\n0\nEOF\n';
const GPU3D_FIXTURE_SHA256 = createHash('sha256').update(GPU3D_STARTUP_DXF).digest('hex');

/** Admit only this main-authored fixture in an immediate, unlinked temporary profile. */
function shippingGpu3dInputs(named) {
  const profile = fs.realpathSync.native(named);
  if (fs.lstatSync(named).isSymbolicLink() || !fs.lstatSync(named).isDirectory()
    || path.dirname(profile) !== fs.realpathSync.native(os.tmpdir())
    || !/^jcad-shipping-smoke-[A-Za-z0-9-]+$/.test(path.basename(profile))) {
    throw new Error('GPU/3D probe requires its temporary smoke profile');
  }
  const fixture = path.join(profile, 'shipping-gpu3d-startup.dxf'), stat = fs.lstatSync(fixture);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > 4096 || fs.realpathSync.native(fixture) !== fixture) {
    throw new Error('GPU/3D probe requires its bounded regular authored DXF');
  }
  const source = fs.readFileSync(fixture);
  if (!source.equals(Buffer.from(GPU3D_STARTUP_DXF))) throw new Error('GPU/3D probe refuses other fixture bytes');
  let entries = 0;
  const visit = (directory, depth) => {
    const before = fs.lstatSync(directory);
    if (depth >= 32 || before.isSymbolicLink() || !before.isDirectory() || fs.realpathSync.native(directory) !== directory) {
      throw new Error('GPU/3D private profile must be bounded and may not traverse links');
    }
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name), item = fs.lstatSync(file);
      if (++entries > 10000 || item.isSymbolicLink() || (!item.isDirectory() && !item.isFile())) {
        throw new Error('GPU/3D private profile must be bounded and contain no links or special files');
      }
      if (item.isDirectory()) visit(file, depth + 1);
      else if (file !== fixture && /\.(?:dxf|dwg|bak)$/i.test(name)) {
        throw new Error('GPU/3D transition probe may not create or reuse drawing outputs');
      }
    }
    const after = fs.lstatSync(directory);
    if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino || fs.realpathSync.native(directory) !== directory) {
      throw new Error('GPU/3D private profile directory changed during validation');
    }
  };
  visit(profile, 0);
  return { profile, fixture, source };
}

/** Preserve identities and every history entry, plus the full retained drawing metadata. */
function shippingGpu3dStamp(ed) {
  const history = ed.doc.history();
  return { doc: ed.doc, snapshot: ed.doc.snapshot, serialized: JSON.stringify(ed.doc.snapshot),
    revision: ed.doc.revision, dirty: ed.doc.dirty, binding: ed.doc.filePath,
    undo: [...history.undo], redo: [...history.redo], historySerialized: JSON.stringify(history), selection: [...ed.selection],
    settings: ed.settings, settingsSerialized: JSON.stringify(ed.settings) };
}
function shippingGpu3dSameStamp(ed, old) {
  const now = shippingGpu3dStamp(ed);
  return ['doc', 'snapshot', 'serialized', 'revision', 'dirty', 'binding', 'settings', 'settingsSerialized', 'historySerialized'].every(key => now[key] === old[key])
    && ['undo', 'redo', 'selection'].every(key => now[key].length === old[key].length && now[key].every((item, i) => item === old[key][i]));
}

/** The complete fixed XDATA span must remain bound to the authored LINE. */
function shippingGpu3dAssertMetadata(state) {
  const spans = [];
  for (const node of state.cadGraph?.nodes || []) for (let at = 0; at < node.groups.length; at++) {
    if (node.groups[at][0] !== 1001 || node.groups[at][1] !== 'SHIPPING_TRANSITION') continue;
    const entity = state.entities[0];
    if (node.anchor?.kind !== 'entity' || node.anchor.part !== undefined || node.anchor.id !== entity.id
      || entity.type !== 'line' || entity.cadIdentity !== node.id || node.type !== 'LINE') throw new Error('GPU/3D XDATA owner mismatch');
    let end = at + 1; while (end < node.groups.length && node.groups[end][0] !== 1001) end++;
    spans.push(node.groups.slice(at, end)); at = end - 1;
  }
  if (JSON.stringify(spans) !== JSON.stringify([[[1001, 'SHIPPING_TRANSITION'], [1000, 'fixed transition metadata 9007199254740993'], [1070, '7']]])) {
    throw new Error('GPU/3D exact retained XDATA mismatch');
  }
}

/** Serialized only with the fixed main-owned helpers below; uses ordinary public commands. */
async function shippingGpu3dRenderer(fixture) {
  const w = /** @type {any} */ (window);
  /** @type {(ok: unknown, message: string) => asserts ok} */
  const need = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = async (predicate, message, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!predicate()) { need(Date.now() < deadline, message); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  const frames = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('GPU/3D two frames exceeded 5s')), 5000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(undefined); }));
  });
  await wait(() => w.editor?.doc.filePath && w.jcad && localStorage.getItem('jcad-origin-migrated') === '1', 'GPU/3D ordinary drawing did not become ready', 30000);
  const ed = w.editor, vp = ed.viewport;
  need(isSecureContext && location.href === 'jcad://app/index.html' && crypto.subtle, 'GPU/3D requires secure ordinary entry');
  need(!w.gpuPrototype && !document.querySelector('[data-gpu-prototype]') && !ed.commands.has('GPU3DDEMO')
    && ed.commands.has('GPURENDERER'), 'GPU/3D cannot use development globals or commands');
  shippingGpuAssertLazy3d(w, document);
  need(!document.querySelector('canvas[data-gpu-candidate="2d"]'), 'Default Canvas must not allocate drawing GPU');
  need(ed.doc.filePath.replace(/\\/g, '/') === fixture.replace(/\\/g, '/') && !ed.doc.dirty
    && ed.doc.entities.length === 1 && ed.doc.entities[0].type === 'line'
    && ed.doc.entities[0].a.x === -6 && ed.doc.entities[0].a.y === 0 && ed.doc.entities[0].b.x === 6 && ed.doc.entities[0].b.y === 0,
  'GPU/3D requires its clean single authored LINE');
  shippingGpu3dAssertMetadata(ed.doc.snapshot);
  need(!ed.doc.snapshot.model3d?.solids?.length && !ed.doc.snapshot.model3d?.dimensions?.length, 'GPU/3D fixture must have no 3D model');
  const info = await w.jcad.appInfo(), old = shippingGpu3dStamp(ed);
  const originalView = { center: vp.center, scale: vp.scale, twist: vp.twist }, grid = vp.settings.gridVisible;
  const states = [], images = [], events = [], violations = [], restores = [];
  const allocations = new Map();
  const calls = { draws: 0, clear: 0 };
  /** @type {any} */ let gpuCanvas;
  /** @type {any} */ let gl;
  /** @type {any} */ let observer;
  /** @type {any} */ let loss;
  let monitor3d = false;
  /** @type {string | null} */ let expectedView = null;
  const view = () => ({ center: { x: vp.center.x, y: vp.center.y }, scale: vp.scale, twist: vp.twist,
    width: vp.width, height: vp.height, dpr: vp.dpr, backingWidth: vp.canvas.width, backingHeight: vp.canvas.height });
  const getContext = HTMLCanvasElement.prototype.getContext;
  const hidden = at => {
    if (w.jcad3d.active && (gpuCanvas.style.display !== 'none' || getComputedStyle(vp.canvas).visibility !== 'hidden')) violations.push(at);
  };
  const unchanged = label => need(shippingGpu3dSameStamp(ed, old), label + ': drawing/history/dirty/binding/metadata changed');
  const observe = label => {
    unchanged(label);
    const currentView = view();
    need(expectedView !== null && JSON.stringify(currentView) === expectedView, label + ': 2D camera or Canvas backing size changed');
    need(w.jcad3d.kernelStarted === false && ed.settings.importForeign3d === false, label + ': empty-model kernel/import policy changed');
    const state = { label, active3d: w.jcad3d.active, kernelStarted: w.jcad3d.kernelStarted,
      canvases3d: document.querySelectorAll('canvas.viewport3d').length,
      candidateCount: document.querySelectorAll('canvas[data-gpu-candidate="2d"]').length,
      candidateDisplay: gpuCanvas?.style.display ?? null, canvasVisibility: getComputedStyle(vp.canvas).visibility,
      owned2dDevices: allocations.size, documentUnchanged: true, viewUnchanged: true, view: currentView };
    states.push(state); return state;
  };
  const paint = () => { ed.render(); vp.renderCurrent(); };
  const run = async command => { await ed.runCommand(command); await frames(); paint(); };
  const capabilities = context => {
    const debug = context.getExtension('WEBGL_debug_renderer_info');
    return { vendor: String(context.getParameter(context.VENDOR)), renderer: String(context.getParameter(context.RENDERER)),
      version: String(context.getParameter(context.VERSION)), maxTextureSize: context.getParameter(context.MAX_TEXTURE_SIZE),
      unmaskedVendor: debug ? String(context.getParameter(debug.UNMASKED_VENDOR_WEBGL)) : '',
      unmaskedRenderer: debug ? String(context.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : '' };
  };
  const capture = (label, context, canvas, overlay) => {
    need(canvas.width > 0 && canvas.height > 0 && canvas.width <= 4096 && canvas.height <= 4096 && canvas.width * canvas.height <= 4000000, 'GPU/3D readback budget');
    let image = canvas, rawGpuInk = null;
    if (context) {
      const width = canvas.width, height = canvas.height, pixels = new Uint8Array(width * height * 4), flipped = new Uint8ClampedArray(pixels.length);
      context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
      need(context.getError() === context.NO_ERROR, 'GPU/3D readback failed');
      // Count actual drawing-buffer ink before adding the Canvas editing overlay. An
      // overlay may contain its own crosshair/axes and cannot prove GPU scene visibility.
      rawGpuInk = 0;
      for (let i = 4; i < pixels.length; i += 4) if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] || pixels[i + 2] !== pixels[2]) rawGpuInk++;
      need(rawGpuInk >= 16, 'GPU/3D raw GPU backing must contain drawing ink before overlay');
      for (let row = 0; row < height; row++) flipped.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), (height - 1 - row) * width * 4);
      image = document.createElement('canvas'); image.width = width; image.height = height;
      const ctx = image.getContext('2d'); need(ctx, 'GPU/3D image composition context');
      ctx.putImageData(new ImageData(flipped, width, height), 0, 0); if (overlay) ctx.drawImage(overlay, 0, 0);
    }
    const png = image.toDataURL('image/png'); need(png.length <= 8388632, 'GPU/3D PNG transfer budget');
    images.push({ label, png, rawGpuInk });
  };
  /** @this {HTMLCanvasElement} */
  const wrappedGetContext = function (...args) {
    const context = Reflect.apply(getContext, this, args);
    if (args[0] === 'webgl2' && this.matches('canvas[data-gpu-candidate="2d"]')) {
      need(context instanceof WebGL2RenderingContext, 'Actual ordinary WebGL2 drawing context required');
      if (allocations.size) need(gpuCanvas === this && gl === context, 'GPU/3D allocated another 2D device');
      else {
        gpuCanvas = this; gl = context; allocations.set(this, context);
        for (const name of ['drawArrays', 'drawElements', 'clear']) {
          const original = gl[name];
          const wrapped = function (...values) { if (name === 'clear') calls.clear++; else calls.draws++; return Reflect.apply(original, gl, values); };
          gl[name] = wrapped; restores.push(() => { if (gl[name] === wrapped) gl[name] = original; });
        }
      }
    }
    return context;
  };
  HTMLCanvasElement.prototype.getContext = wrappedGetContext;
  try {
    vp.settings.gridVisible = false; vp.center = { x: 0, y: 0 }; vp.scale = 30; vp.twist = 0;
    paint(); await frames(); paint();
    expectedView = JSON.stringify(view());
    const start = observe('default-canvas');
    need(start.active3d === false && start.canvases3d === 0 && start.candidateCount === 0 && start.owned2dDevices === 0 && start.canvasVisibility === 'visible', 'GPU/3D fresh Canvas/default allocation');
    capture(start.label, null, vp.canvas, null);
    const initialContext = vp.canvas.getContext('2d'); need(initialContext, 'GPU/3D actual initial Canvas context');
    const initialCanvasRgba = initialContext.getImageData(0, 0, vp.canvas.width, vp.canvas.height).data;
    await run('GPURENDERER GPU');
    await wait(() => gpuCanvas?.style.display === 'block', 'GPU/3D explicit ordinary GPU not admitted'); paint();
    need(gl && !gl.isContextLost() && calls.draws > 0 && calls.clear > 0, 'GPU/3D requires real production draws');
    const adapter2d = capabilities(gl), first = observe('explicit-gpu');
    need(!first.active3d && first.canvases3d === 0 && first.candidateCount === 1 && first.owned2dDevices === 1, 'GPU/3D ordinary GPU admission');
    capture(first.label, gl, gpuCanvas, vp.canvas);
    const onLost = () => { events.push('lost'); hidden('lost event'); }, onRestored = () => { events.push('restored'); hidden('restored event'); };
    gpuCanvas.addEventListener('webglcontextlost', onLost); gpuCanvas.addEventListener('webglcontextrestored', onRestored);
    restores.push(() => { gpuCanvas.removeEventListener('webglcontextlost', onLost); gpuCanvas.removeEventListener('webglcontextrestored', onRestored); });
    observer = new MutationObserver(records => {
      hidden('style mutation');
      if (monitor3d && w.jcad3d.active && records.some(record => /(?:^|;)\s*display\s*:\s*block\b/i.test(record.oldValue || ''))) {
        violations.push('transient visible style during 3D');
      }
    });
    observer.observe(gpuCanvas, { attributes: true, attributeOldValue: true, attributeFilter: ['style'] });
    await run('3DVIEW SWISO');
    await wait(() => w.jcad3d.active && document.querySelector('canvas.viewport3d'), 'GPU/3D view not active');
    const active = observe('active-3d'), viewport3d = w.jcad3d.viewport;
    need(active.canvases3d === 1 && active.candidateDisplay === 'none' && active.canvasVisibility === 'hidden', 'GPU/3D 3D must hide both 2D backings');
    const adapter3d = capabilities(viewport3d.device.gl);
    viewport3d.render({ selection: ed.selection, hover: null }); capture(active.label, viewport3d.device.gl, viewport3d.canvas, null);
    observer.takeRecords(); monitor3d = true;
    await run('GPURENDERER GPU'); hidden('GPU selected during 3D');
    const selected = observe('gpu-during-3d');
    need(selected.active3d && selected.canvases3d === 1 && selected.candidateDisplay === 'none' && selected.owned2dDevices === 1, 'GPU selection during 3D must retain the hidden device');
    loss = gl.getExtension('WEBGL_lose_context'); need(loss, 'GPU/3D requires actual owned context loss extension');
    loss.loseContext(); await wait(() => events.includes('lost') && gl.isContextLost(), 'GPU/3D real context loss not observed'); await frames();
    const lost = observe('lost-during-3d'); need(lost.active3d && lost.candidateDisplay === 'none', 'Lost 2D backing exposed during 3D');
    loss.restoreContext(); await wait(() => events.includes('restored') && !gl.isContextLost(), 'GPU/3D real context restoration not observed', 10000);
    await frames(); paint(); hidden('restored settled frame');
    const restored = observe('restored-during-3d');
    need(restored.active3d && restored.candidateDisplay === 'none' && restored.owned2dDevices === 1
      && violations.length === 0 && JSON.stringify(events) === '["lost","restored"]', 'Restored 2D backing exposed or replaced during 3D');
    const beforeResume = { ...calls };
    monitor3d = false; await run('3DMODE');
    await wait(() => !w.jcad3d.active && !document.querySelector('canvas.viewport3d') && gpuCanvas.style.display === 'block', 'GPU/3D exit did not resume same GPU backing'); paint();
    const resumed = observe('gpu-resumed');
    need(resumed.candidateCount === 1 && resumed.owned2dDevices === 1 && resumed.canvasVisibility === 'visible'
      && document.querySelector('canvas[data-gpu-candidate="2d"]') === gpuCanvas, 'GPU/3D exit replaced drawing device');
    const resumedGlCalls = { draws: calls.draws - beforeResume.draws, clear: calls.clear - beforeResume.clear };
    need(resumedGlCalls.draws > 0 && resumedGlCalls.clear > 0, 'GPU/3D resumed backing requires fresh drawing submission after restoration');
    const adapter2dResumed = capabilities(gl);
    need(JSON.stringify(adapter2dResumed) === JSON.stringify(adapter2d), 'GPU/3D resumed drawing adapter identity changed after restoration');
    capture(resumed.label, gl, gpuCanvas, vp.canvas);
    await run('GPURENDERER CANVAS');
    const final = observe('canvas-restored');
    need(!final.active3d && final.canvases3d === 0 && final.candidateDisplay === 'none' && final.canvasVisibility === 'visible', 'GPU/3D complete Canvas not restored');
    const ctx = vp.canvas.getContext('2d'); need(ctx, 'GPU/3D actual restored Canvas context');
    const pixels = ctx.getImageData(0, 0, vp.canvas.width, vp.canvas.height).data;
    let ink = 0; for (let i = 4; i < pixels.length; i += 4) if (pixels[i] !== pixels[0] || pixels[i + 1] !== pixels[1] || pixels[i + 2] !== pixels[2]) ink++;
    need(ink >= 16, 'GPU/3D restored Canvas must contain drawing ink');
    need(pixels.length === initialCanvasRgba.length && pixels.every((value, i) => value === initialCanvasRgba[i]), 'GPU/3D restored Canvas must exactly match its initial full RGBA drawing');
    capture(final.label, null, vp.canvas, null);
    return { phase: 'gpu2d-3d', version: info.version, packaged: info.packaged, url: location.href,
      secure: true, defaultCanvas: true, noDefaultGpuAllocation: true, default3dToolsReady: true,
      foreignImportDisabled: true, noRendererTestGlobals: true, explicitGpuCommand: true, realContextLoss: true,
      automaticContextRestored: true, same2dDevice: true, noHiddenExposure: true, kernelUnstarted: true,
      documentUnchanged: true, metadataPreserved: true, same2dView: true, canvasExactRestored: true, canvasInk: ink, events, violations,
      adapter2d, adapter3d, adapter2dResumed, states, images, glCalls: { ...calls }, resumedGlCalls };
  } finally {
    observer?.disconnect();
    for (const restore of restores.reverse()) restore();
    if (HTMLCanvasElement.prototype.getContext === wrappedGetContext) HTMLCanvasElement.prototype.getContext = getContext;
    // Restore only this private renderer's temporary view setup, never drawing data.
    vp.settings.gridVisible = grid; Object.assign(vp, originalView);
  }
}

async function runShippingGpu3dProbe(ctx, testBuild) {
  if (testBuild) throw new Error('GPU/3D probe requires ordinary shipping entry');
  const win = ctx.mainWindow; if (!win || win.isDestroyed()) throw new Error('No renderer window');
  const named = app.getPath('userData'), { fixture } = shippingGpu3dInputs(named);
  const helpers = [shippingGpuAssertLazy3d, shippingGpu3dStamp, shippingGpu3dSameStamp, shippingGpu3dAssertMetadata]
    .map(helper => 'const ' + helper.name + '= (' + helper.toString() + ');').join('');
  try {
    const record = await win.webContents.executeJavaScript('(() => {' + helpers + 'return (' + shippingGpu3dRenderer.toString() + ')(' + JSON.stringify(fixture) + ');})()');
    return { ...record, testBuild, fixtureSha256: GPU3D_FIXTURE_SHA256, sourceUnchanged: true, noDrawingOutputs: true };
  } finally {
    shippingGpu3dInputs(named);
  }
}

module.exports = { GPU3D_STARTUP_DXF, GPU3D_FIXTURE_SHA256, shippingGpu3dInputs, shippingGpu3dStamp, shippingGpu3dSameStamp, shippingGpu3dAssertMetadata, shippingGpu3dRenderer, runShippingGpu3dProbe };
