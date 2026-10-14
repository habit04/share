// Fixed genuine SHX acceptance diagnostics. Only main-authored code; no supplied renderer code/paths.
/* global window, document, localStorage, location, isSecureContext, crypto, HTMLCanvasElement, WebGL2RenderingContext, ImageData, queueMicrotask */
const { app, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');

const SHX_FIXTURE_SHA256 = '6169a8575aa3ce34fbd778b3b8b6a93fc20217a58c321069e8a58c12e9044737';
const SHX_FIXTURE_BYTES = 88877;
const SHX_FONTS = Object.freeze([
  { name: 'txt.shx', bytes: 8489, sha256: '2280abc0bc7b827c21ae43a651a8dfbc14873550ff61b123a72773a5dbce0d8f', above: 6, below: 2,
    oracle: { right: 60, middle: -15, fitted: 5, box: [0, -3.33333333333333, 16.66666666666667, 10] } },
  { name: 'simplex.shx', bytes: 17816, sha256: '30dc50fa379935e4d7eb6e60041fa070a11fba6deac337a2fa9e34dcb5bfbcc1', above: 21, below: 7,
    oracle: { right: 56.19047619047621, middle: -14.2857142857143, fitted: 5.121951219512195, box: [0, -3.33333333333333, 16.19047619047619, 10] } },
  { name: 'romans.shx', bytes: 16086, sha256: 'b22f4abadf72c9184c6c33dbf159b504cc09185a4c24102223afbe58b400f9bd', above: 21, below: 7,
    oracle: { right: 50.47619047619049, middle: -14.2857142857143, fitted: 5.384615384615385, box: [0.47619047619048, -3.33333333333333, 15.71428571428571, 10] } },
  { name: 'romant.shx', bytes: 39728, sha256: 'f213529c6938339f3671145c8994d077073e6d6a9d620fdad5e52d7fcdfce2f9', above: 21, below: 7,
    oracle: { right: 57.14285714285710, middle: -14.7619047619049, fitted: 5.121951219512195, box: [0.47619047619048, -3.33333333333333, 17.61904761904761, 10] } },
]);

/** Exclude regenerated ids/handles and runtime resources; retain authored semantic TEXT fields. */
function shippingShxSemantic(state) {
  if (!state || !Array.isArray(state.entities) || state.entities.length !== 20 || state.entities.some(e => e.type !== 'text')) {
    throw new Error('SHX acceptance requires exactly its twenty native TEXT rows');
  }
  const rows = state.entities.map(e => ({
    text: e.text, style: e.style ?? null, align: e.align, justification: e.justification ?? null,
    position: e.position, firstAlignmentPoint: e.firstAlignmentPoint ?? null, alignmentPoint: e.alignmentPoint ?? null,
    height: e.height, rotation: e.rotation, widthFactor: e.widthFactor ?? null, oblique: e.oblique ?? null,
    layer: e.layer, color: e.color, trueColor: e.trueColor ?? null, colorName: e.colorName ?? null,
    transparency: e.transparency ?? null, linetype: e.linetype ?? 'ByLayer', lineWeight: e.lineWeight ?? null,
    ltscale: e.ltscale ?? 1, field: e.field ?? null,
  }));
  const styles = Object.keys(state.meta?.textStyles || {}).sort().map(key => {
    const s = state.meta.textStyles[key];
    return { key, name: s.name, font: s.font, bigFont: s.bigFont ?? null, flags: s.flags ?? null,
      height: s.height, widthFactor: s.widthFactor, oblique: s.oblique, generation: s.generation ?? null,
      family: s.family ?? null, bold: s.bold ?? null, italic: s.italic ?? null };
  });
  if (styles.length !== 9) throw new Error('SHX acceptance requires its nine retained STYLE records');
  return { rows, styles };
}

/** Exact native-normalized import controls; no substitute/font load is implied by a filename. */
function shippingShxAssertFixture(semantic) {
  const names = ['TXT', 'SIMPLEX', 'ROMANS', 'ROMANT'];
  const middleX = [105, 285.7142857142857, 465.7142857142857, 645.2380952380951];
  const rightX = [60, 243.8095238095238, 429.5238095238095, 602.8571428571429];
  const fitted = [5, 5.121951219512195, 5.384615384615385, 5.121951219512196];
  const exact = (ok, message) => { if (!ok) throw new Error('SHX fixed native fixture import mismatch: ' + message); };
  const number = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-8;
  const point = (a, x, y) => a && number(a.x, x) && number(a.y, y);
  exact(semantic.rows.length === 20 && semantic.styles.length === 9, 'row/style counts');
  for (let font = 0; font < 4; font++) {
    const rows = semantic.rows.slice(font * 5, font * 5 + 5), base = 20 + font * 180, anchor = base + 100;
    const style = 'JCAD_SHX_' + names[font], normal = semantic.styles.find(s => s.name === style);
    const custom = semantic.styles.find(s => s.name === style + '_CUSTOM');
    exact(normal?.font === names[font].toLowerCase() + '.shx' && custom?.font === normal.font, 'font references');
    exact(normal.height === 0 && normal.widthFactor === 1 && normal.oblique === 0
      && custom.height === 0 && custom.widthFactor === 0.8 && custom.oblique === 10, 'STYLE creation defaults');
    const values = ['%%c10 %%d %%p', 'Ag', ' A ', 'A ', 'AVATAR'];
    rows.forEach((row, i) => {
      exact(row.text === values[i] && row.style === (i === 1 ? style + '_CUSTOM' : style), 'literal text/spaces/style');
      exact(row.height === 10 && row.rotation === 0 && row.oblique === 0, 'entity height/rotation/oblique defaults');
      exact(number(row.widthFactor, i === 3 ? fitted[font] : 1), 'entity width defaults and native FIT value');
    });
    exact(point(rows[0].position, base, 344) && rows[0].align === 'left' && rows[0].justification === null
      && rows[0].firstAlignmentPoint === null && rows[0].alignmentPoint === null, 'control row');
    exact(point(rows[1].position, base, 740) && rows[1].align === 'left' && rows[1].justification === null
      && rows[1].firstAlignmentPoint === null && rows[1].alignmentPoint === null, 'CUSTOM row');
    exact(point(rows[2].position, anchor, 434) && point(rows[2].alignmentPoint, anchor, 434)
      && point(rows[2].firstAlignmentPoint, middleX[font], 429) && rows[2].align === 'center'
      && rows[2].justification?.horizontal === 4 && rows[2].justification?.vertical === 0, 'MIDDLE anchors');
    exact(point(rows[3].position, base, 596) && point(rows[3].alignmentPoint, anchor, 596)
      && rows[3].firstAlignmentPoint === null && rows[3].align === 'left'
      && rows[3].justification?.horizontal === 5 && rows[3].justification?.vertical === 0, 'FIT anchors');
    exact(point(rows[4].position, anchor, 452) && point(rows[4].alignmentPoint, anchor, 452)
      && point(rows[4].firstAlignmentPoint, rightX[font], 452) && rows[4].align === 'right'
      && rows[4].justification?.horizontal === 2 && rows[4].justification?.vertical === 0, 'RIGHT anchors');
  }
}
/** Persistence quantum is independent of the older native 1e-8 placement oracle. */
function shippingShxAssertSemantic(actual, expected, tolerance = 5.01e-11) {
  const compare = (a, b, at) => {
    if (typeof b === 'number') {
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > tolerance) throw new Error('SHX numeric persistence mismatch: ' + at);
      return;
    }
    if (b === null || typeof b !== 'object') {
      if (a !== b) throw new Error('SHX exact semantic mismatch: ' + at);
      return;
    }
    if (!a || typeof a !== 'object' || Array.isArray(a) !== Array.isArray(b)) throw new Error('SHX semantic shape mismatch: ' + at);
    const keys = Object.keys(b);
    if (Object.keys(a).length !== keys.length) throw new Error('SHX semantic key mismatch: ' + at);
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(a, key)) throw new Error('SHX missing semantic field: ' + at + '.' + key);
      compare(a[key], b[key], at + '.' + key);
    }
  };
  compare(actual, expected, 'drawing');
}

/** A load/render must preserve snapshot and every history item, not just stack lengths. */
function shippingShxStamp(ed) {
  const history = ed.doc.history();
  return { state: ed.doc.snapshot, revision: ed.doc.revision, dirty: ed.doc.dirty, binding: ed.doc.filePath,
    undo: history.undo, redo: history.redo, selection: [...ed.selection],
    view: JSON.stringify({ center: ed.viewport.center, scale: ed.viewport.scale, twist: ed.viewport.twist,
      width: ed.viewport.width, height: ed.viewport.height, dpr: ed.viewport.dpr,
      backingWidth: ed.viewport.canvas.width, backingHeight: ed.viewport.canvas.height,
      background: ed.viewport.settings.background, grid: ed.viewport.settings.gridVisible }) };
}
function shippingShxSameStamp(ed, before) {
  const now = shippingShxStamp(ed);
  return now.state === before.state && now.revision === before.revision && now.dirty === before.dirty
    && now.binding === before.binding && now.view === before.view
    && ['undo', 'redo', 'selection'].every(key => now[key].length === before[key].length && now[key].every((item, i) => item === before[key][i]));
}

/** Fixed local source admission; the existing SHX IPC still performs its held-file read. */
function shippingShxInputs(profile) {
  const regular = (file, limit) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0 || stat.size > limit || fs.realpathSync.native(file) !== file) {
      throw new Error('SHX probe requires confined bounded regular inputs');
    }
    return fs.readFileSync(file);
  };
  const fixture = path.join(profile, 'shipping-shx-startup.dxf'), source = regular(fixture, 8 * 1024 * 1024);
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  if (source.length !== SHX_FIXTURE_BYTES || hash(source) !== SHX_FIXTURE_SHA256) throw new Error('SHX probe refuses any other native fixture bytes');
  const directory = path.join(profile, 'shx-resources'), dirStat = fs.lstatSync(directory);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory() || fs.realpathSync.native(directory) !== directory) throw new Error('SHX probe refuses a linked resource directory');
  if (fs.readdirSync(directory).sort().join('|') !== SHX_FONTS.map(font => font.name).sort().join('|')) throw new Error('SHX probe requires only its four named resources');
  let total = 0;
  const fonts = SHX_FONTS.map((font, i) => {
    const file = path.join(directory, font.name), bytes = regular(file, 8 * 1024 * 1024); total += bytes.length;
    if (bytes.length !== font.bytes || hash(bytes) !== font.sha256) throw new Error('SHX probe font provenance does not match its fixed private program');
    return { ...font, path: file, style: 'JCAD_SHX_' + font.name.slice(0, -4).toUpperCase(),
      resourceId: JSON.stringify([file, font.sha256]), fixtureOrdinal: i * 5 };
  });
  if (total > 16 * 1024 * 1024) throw new Error('SHX probe aggregate resource limit');
  return { fixture, source, fonts };
}

/** Independent saved-file guards: explicit entity defaults, no runtime font authority. */
function shippingShxExportCheck(bytes, fonts) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('SHX saved DXF byte budget');
  const text = bytes.toString('utf8'), lines = text.split(/\r?\n/);
  /** @type {Array<{ type: string, groups: Array<[number, string]> }>} */
  const records = [];
  /** @type {{ type: string, groups: Array<[number, string]> } | null} */
  let current = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim()), value = lines[i + 1];
    if (!Number.isSafeInteger(code)) throw new Error('SHX saved DXF group shape');
    if (code === 0) { current = { type: value.trim(), groups: [] }; records.push(current); }
    else if (current) current.groups.push([code, value]);
  }
  const texts = records.filter(record => record.type === 'TEXT');
  if (texts.length !== 20 || texts.some(record => [41, 51].some(code => record.groups.filter(group => group[0] === code).length !== 1))) {
    throw new Error('SHX DXF must retain twenty TEXTs with one explicit width/oblique default each');
  }
  for (const marker of ['shxResourceId', 'resourceId', 'FontFile', ...fonts.flatMap(font => [font.path, font.path.replace(/\\/g, '/'), font.resourceId])]) {
    if (text.includes(marker)) throw new Error('Runtime SHX authority leaked into saved DXF');
  }
  return { textCount: texts.length, explicitDefaults: true, runtimeProgramsAbsent: true };
}

/**
 * Observe one actual scene frame. Earlier eligible frames do not contaminate a
 * later loaded frame, and a later reset cannot erase this frame's own GL work.
 * @param {{ resetCounts(): void, render(): boolean, counts(): { draws: number, uploads: number, clear: number, uploadBytes: number } }} control
 */
function shippingShxObservedFrame(control) {
  control.resetCounts();
  const rendered = control.render(), sceneCalls = { ...control.counts() };
  return {
    rendered,
    canvasCalls() {
      const atCapture = { ...control.counts() };
      for (const key of ['draws', 'uploads', 'clear', 'uploadBytes']) {
        if (!Number.isSafeInteger(sceneCalls[key]) || !Number.isSafeInteger(atCapture[key])
          || sceneCalls[key] !== 0 || atCapture[key] !== 0) {
          throw new Error('SHX loaded Canvas frame submitted GPU work: ' + key);
        }
      }
      return atCapture;
    },
  };
}
/** Fixed renderer script. Arguments and helper code are exclusively main-authored. */
async function shippingShxRenderer(stage, fixture, output, fonts, previous, renderOverlay) {
  const w = /** @type {any} */ (window);
  /** @type {(ok: unknown, message: string) => asserts ok} */
  const need = (ok, message) => { if (!ok) throw new Error(message); };
  const wait = async (predicate, message, ms = 5000) => {
    const until = Date.now() + ms;
    while (!predicate()) { need(Date.now() < until, message); await new Promise(resolve => setTimeout(resolve, 20)); }
  };
  await wait(() => w.editor?.doc.filePath && w.jcad && localStorage.getItem('jcad-origin-migrated') === '1', 'SHX ordinary drawing did not become ready', 30000);
  need(stage === 'first' || stage === 'second', 'Fixed SHX stage required');
  const ed = w.editor, vp = ed.viewport;
  need(isSecureContext && location.href === 'jcad://app/index.html' && crypto.subtle, 'SHX requires secure ordinary entry');
  need(!w.gpuPrototype && !document.querySelector('[data-gpu-prototype]') && !ed.commands.has('GPU3DDEMO')
    && ed.commands.has('GPURENDERER') && ed.commands.has('SHXFONT') && !ed.settings.experimental3d && !w.jcad3d, 'SHX may not use development APIs');
  const info = await w.jcad.appInfo(), semantic = () => shippingShxSemantic(ed.doc.snapshot);
  const originalSettings = { background: vp.settings.background, gridVisible: vp.settings.gridVisible };
  const originalView = { center: vp.center, scale: vp.scale, twist: vp.twist };
  const originalSaveError = ed.hooks.saveError, restores = [], comparisons = [], resources = [], metrics = [], styleMetrics = [];
  const counts = { draws: 0, uploads: 0, clear: 0, uploadBytes: 0 };
  /** @type {WebGL2RenderingContext | undefined} */
  let gl;
  /** @type {HTMLCanvasElement | undefined} */
  let canvas;
  /** Read closure-populated context after the actual render, without stale flow narrowing. @returns {WebGL2RenderingContext | undefined} */
  const currentGl = () => gl;
  const resetCounts = () => { for (const key of Object.keys(counts)) counts[key] = 0; };
  const attach = (candidate, context) => {
    if (gl) { need(gl === context && canvas === candidate, 'SHX requires one existing owned GPU context'); return; }
    need(candidate instanceof HTMLCanvasElement && context instanceof WebGL2RenderingContext && !context.isContextLost(), 'SHX observed canvas/WebGL2 must be real/current');
    const observedGl = context;
    gl = observedGl; canvas = candidate;
    for (const name of ['drawArrays', 'drawElements', 'bufferData', 'bufferSubData', 'clear']) {
      const descriptor = Object.getOwnPropertyDescriptor(observedGl, name), original = observedGl[name];
      const wrapped = function (...args) {
        if (name.startsWith('draw')) counts.draws++;
        else if (name === 'clear') counts.clear++;
        else { counts.uploads++; const data = args[name === 'bufferData' ? 1 : 2]; counts.uploadBytes += typeof data === 'number' ? data : data?.byteLength || 0; }
        return Reflect.apply(original, observedGl, args);
      };
      Object.defineProperty(observedGl, name, { configurable: true, writable: true, value: wrapped });
      restores.push(() => { if (observedGl[name] === wrapped) { if (descriptor) Object.defineProperty(observedGl, name, descriptor); else delete observedGl[name]; } });
    }
  };
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const getDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext');
  need(getDescriptor, 'SHX requires the existing canvas getContext descriptor for exact restoration');
  /** @this {HTMLCanvasElement} */
  const observedGetContext = function (...args) {
    const context = Reflect.apply(originalGetContext, this, args);
    if (args[0] === 'webgl2' && this.matches('canvas[data-gpu-candidate="2d"]')) attach(this, context);
    return context;
  };
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { ...getDescriptor, value: observedGetContext });
  const paint = () => { ed.render(); vp.renderCurrent(); };
  const capture = renderer => {
    const width = vp.canvas.width, height = vp.canvas.height;
    need(width > 0 && height > 0 && width <= 4096 && height <= 4096 && width * height <= 4000000, 'SHX readback pixel limit');
    if (renderer === 'canvas') { need(!canvas || canvas.style.display === 'none', 'SHX complete Canvas must hide GPU backing'); return vp.canvas.toDataURL('image/png'); }
    need(gl && canvas && canvas.style.display === 'block' && canvas.width === width && canvas.height === height && !gl.isContextLost(), 'SHX actual visible GPU backing required');
    const pixels = new Uint8Array(width * height * 4), flipped = new Uint8ClampedArray(pixels.length);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    need(gl.getError() === gl.NO_ERROR, 'SHX actual GPU readback failed');
    for (let row = 0; row < height; row++) flipped.set(pixels.subarray(row * width * 4, (row + 1) * width * 4), (height - 1 - row) * width * 4);
    const image = document.createElement('canvas'); image.width = width; image.height = height;
    const ctx = image.getContext('2d'); need(ctx, 'SHX composition context');
    ctx.putImageData(new ImageData(flipped, width, height), 0, 0); ctx.drawImage(vp.canvas, 0, 0);
    return image.toDataURL('image/png');
  };
  const select = mode => {
    const result = ed.commands.get('GPURENDERER').run(ed, mode);
    need(!result || typeof result.then !== 'function', 'SHX fixed reference selection must stay synchronous');
  };
  const pair = async (label, expected = 'canvas', priorReference) => {
    const before = shippingShxStamp(ed);
    select('CANVAS'); paint();
    const referencePng = priorReference || capture('canvas');
    resetCounts(); select('GPU'); paint();
    const renderer = canvas?.style.display === 'block' ? 'gpu' : 'canvas';
    need(expected === 'either' || renderer === expected, 'SHX expected actual renderer: ' + label);
    const actualPng = capture(renderer), glCalls = { ...counts };
    need(shippingShxSameStamp(ed, before), 'SHX mode/render changed drawing/history/view: ' + label);
    if (label === 'unbound-warm' && renderer === 'gpu') need(glCalls.uploads === 0, 'SHX unbound warm GPU must reuse its actual buffers');
    comparisons.push({ label, renderer, referencePng, actualPng, glCalls, documentUnchanged: true });
    return referencePng;
  };
  const setView = () => {
    vp.center = { x: 340, y: 550 }; vp.scale = Math.min(vp.width / 760, vp.height / 480); vp.twist = 0;
    need(Number.isFinite(vp.scale) && vp.scale > 0, 'SHX fixed view dimensions');
    vp.settings.background = '#212830'; vp.settings.gridVisible = false;
    ed.selection.clear();
    const overlay = renderOverlay(ed); overlay.cursor = null; overlay.hover = null; overlay.snap = null;
  };
  const assertUnbound = () => {
    need(ed.doc.entities.every(e => !ed.doc.lookupBlock.textGeometry.resolve(e).shxResourceId), 'Fresh reopened SHX resources must be unbound');
  };
  const loadedRows = () => {
    const context = ed.doc.lookupBlock.textGeometry;
    for (const entity of ed.doc.entities) {
      const appearance = context.resolve(entity), program = fonts.find(font => font.resourceId === appearance.shxResourceId);
      const run = context.shxRun(entity.text, entity.height, appearance);
      need(appearance.kind === 'stroke' && program && run?.ok && run.segments.length > 0, 'Every loaded native TEXT must use a genuine current program');
    }
    return context;
  };
  // Called only before loading a previously unbound basename, with GPU left requested.
  const loadFont = async (font, round) => {
    const context = ed.doc.lookupBlock.textGeometry, epoch = context.cacheKey, before = shippingShxStamp(ed);
    const input = { style: font.style + '_CUSTOM', widthFactor: 1, oblique: 0 };
    need(!context.resolve(input).shxResourceId, 'SHX load prerequisite already settled; automatic transition is unrun/inconclusive');
    select('CANVAS'); paint(); const beforeResourcePng = capture('canvas');
    select('GPU'); paint();
    need(context.cacheKey === epoch && shippingShxSameStamp(ed, before), 'SHX before-load warm frame changed the unbound prerequisite');
    const originalScene = vp.experimentalSceneRenderer, descriptor = Object.getOwnPropertyDescriptor(vp, 'experimentalSceneRenderer');
    need(typeof originalScene === 'function', 'SHX automatic transition requires the existing production scene hook');
    let image, glCalls, loadedEpoch, error, scheduled = false;
    const observedScene = function (...args) {
      const frame = shippingShxObservedFrame({ resetCounts, counts: () => counts,
        render: () => Reflect.apply(originalScene, vp, args) });
      const rendered = frame.rendered;
      if (!scheduled && context.resolve(input).shxResourceId === font.resourceId) {
        scheduled = true;
        queueMicrotask(() => {
          try {
            need(rendered === false && ed.doc.lookupBlock.textGeometry === context && context.cacheKey !== epoch
              && context.resolve(input).shxResourceId === font.resourceId && shippingShxSameStamp(ed, before),
            'SHX first automatic frame must use the original drawing and actual loaded epoch/program');
            const run = context.shxRun('Ag', 10, context.resolve(input));
            need(run?.ok && run.segments.length > 0, 'SHX first loaded frame requires genuine ink');
            loadedEpoch = context.cacheKey; image = capture('canvas'); glCalls = frame.canvasCalls();
            need(context.cacheKey === loadedEpoch && shippingShxSameStamp(ed, before), 'SHX source/epoch changed during automatic capture');
          } catch (problem) { error = problem; }
        });
      }
      return rendered;
    };
    Object.defineProperty(vp, 'experimentalSceneRenderer', { configurable: true, writable: true, value: observedScene });
    const restore = () => {
      if (vp.experimentalSceneRenderer !== observedScene) return;
      if (descriptor) Object.defineProperty(vp, 'experimentalSceneRenderer', descriptor); else delete vp.experimentalSceneRenderer;
    };
    restores.push(restore);
    resetCounts();
    try {
      // Native chooser + confined held-file reader + digest/parser + ordinary resource callback.
      await ed.runCommand('SHXFONT');
      await wait(() => image || error, 'SHX genuine resource load/first automatic Canvas frame did not arrive');
      if (error) throw error;
      need(scheduled && loadedEpoch && context.cacheKey === loadedEpoch && shippingShxSameStamp(ed, before), 'SHX actual resource transition did not stay stable');
      restore();
      select('CANVAS'); paint();
      need(context.cacheKey === loadedEpoch && context.resolve(input).shxResourceId === font.resourceId && shippingShxSameStamp(ed, before), 'SHX independent reference changed its loaded prerequisite');
      const referencePng = capture('canvas');
      comparisons.push({ label: round + '-load-' + font.name.slice(0, -4), renderer: 'canvas', referencePng, actualPng: image, glCalls,
        documentUnchanged: true, firstAutomaticFrame: true, epochChanged: true, currentResourceBound: true, beforeResourcePng });
      resources.push({ round, name: font.name, sha256: font.sha256, bytes: font.bytes, currentResourceBound: true,
        epochChanged: true, firstAutomaticFrame: true, documentUnchanged: true });
      select('GPU'); // Remains requested throughout the next ordinary asynchronous load.
    } finally { restore(); }
  };
  const loadAll = async round => { for (const font of fonts) await loadFont(font, round); loadedRows(); };
  const recordMetrics = tag => {
    const context = loadedRows(), close = (a, b, label) => need(Number.isFinite(a) && Math.abs(a - b) <= 1e-8, 'SHX recorded native glyph metric mismatch: ' + label);
    for (const font of fonts) {
      // CUSTOM retains its original filename even while the normal TXT STYLE switches.
      const face = context.resolve({ style: font.style + '_CUSTOM', widthFactor: 1, oblique: 0 });
      need(face.shxResourceId === font.resourceId && face.widthFactor === 1 && face.oblique === 0, 'SHX actual entity defaults must override STYLE creation fields');
      const run = text => { const value = context.shxRun(text, 10, face); need(value?.ok && value.segments.length > 0, 'Genuine SHX oracle run'); return value; };
      const right = run('AVATAR'), middle = run(' A '), fitted = run('A '), custom = run('Ag'), o = font.oracle;
      need(middle.terminalSpace && fitted.terminalSpace, 'SHX native terminal spaces are semantic');
      close(right.right, o.right, font.name + ' right'); close(-middle.advance / 2, o.middle, font.name + ' middle offset');
      close(100 / fitted.advance, o.fitted, font.name + ' derived FIT width');
      const box = [custom.left, -custom.descent, custom.right, custom.ascent]; box.forEach((value, i) => close(value, o.box[i], font.name + ' CUSTOM box'));
      metrics.push({ tag, name: font.name, right: right.right, middleOffset: -middle.advance / 2,
        fittedWidth: 100 / fitted.advance, customBox: box, tolerance: 1e-8, oracle: 'recorded-AutoCAD2027-reference-not-a-new-native-run' });
    }
    return context;
  };
  const recordStyleMetrics = (tag, expectedFont) => {
    const context = loadedRows(), rows = ed.doc.entities, wanted = fonts[expectedFont];
    for (const ordinal of [0, 2, 3, 4]) need(context.resolve(rows[ordinal]).shxResourceId === wanted.resourceId, 'SHX current STYLE geometry must update every normal TXT row');
    need(context.resolve(rows[1]).shxResourceId === fonts[0].resourceId, 'SHX CUSTOM style must keep its original txt resource');
    const right = context.shxRun(rows[4].text, rows[4].height, context.resolve(rows[4]));
    const middle = context.shxRun(rows[2].text, rows[2].height, context.resolve(rows[2]));
    const fit = context.shxRun(rows[3].text, rows[3].height, context.resolve(rows[3]));
    need(right?.ok && middle?.ok && fit?.ok && middle.terminalSpace && fit.terminalSpace
      && Math.abs(right.right - wanted.oracle.right) <= 1e-8 && Math.abs(-middle.advance / 2 - wanted.oracle.middle) <= 1e-8
      && Math.abs(100 / fit.advance - wanted.oracle.fitted) <= 1e-8 && rows[3].widthFactor === 5,
    'SHX real STYLE geometry must change recorded right/middle/FIT metrics without changing stored FIT width');
    styleMetrics.push({ tag, actualFont: wanted.name, right: right.right, middleOffset: -middle.advance / 2,
      fittedWidth: 100 / fit.advance, storedFittedWidth: rows[3].widthFactor, customFont: 'txt.shx' });
  };
  const moveText = (ordinal, dx, dy) => {
    const entity = ed.doc.entities[ordinal];
    need(entity?.type === 'text', 'Fixed SHX edit owner');
    const point = p => p ? { x: p.x + dx, y: p.y + dy } : undefined;
    ed.doc.replaceEntities([{ ...entity, position: point(entity.position), firstAlignmentPoint: point(entity.firstAlignmentPoint), alignmentPoint: point(entity.alignmentPoint) }]);
  };
  ed.hooks.saveError = async error => { throw new Error('SHX actual save failed: ' + error.message); };
  try {
    if (stage === 'first') {
      need(ed.doc.filePath.replace(/\\/g, '/') === fixture.replace(/\\/g, '/') && !ed.doc.dirty
        && !ed.doc.history().undo.length && !ed.doc.history().redo.length, 'SHX requires its clean exact private fixture');
      shippingShxAssertFixture(semantic()); assertUnbound();
      need(!document.querySelector('canvas[data-gpu-candidate="2d"]') && vp.settings.gridVisible, 'SHX fresh Canvas/default-grid prerequisite must remain unchanged');
      await ed.runCommand('GPURENDERER GPU'); paint();
      need(!document.querySelector('canvas[data-gpu-candidate="2d"]'), 'SHX default grid must refuse before device allocation');
      await pair('default-grid-before-load');
      setView();
      await pair('unbound-before-load', 'either'); await pair('unbound-warm', 'either');
      await loadAll('initial'); recordMetrics('initial');
      await pair('loaded-warm');
      const baseline = semantic(), txtKey = Object.keys(ed.doc.snapshot.meta.textStyles).find(key => ed.doc.snapshot.meta.textStyles[key].name === 'JCAD_SHX_TXT');
      need(txtKey, 'SHX native TXT STYLE');
      ed.doc.transactDrawing(state => ({ ...state, meta: { ...state.meta, textStyles: { ...state.meta.textStyles,
        [txtKey]: { ...state.meta.textStyles[txtKey], font: 'simplex.shx' } } } }));
      const changed = semantic(), expected = JSON.parse(JSON.stringify(baseline));
      expected.styles.find(style => style.key === txtKey).font = 'simplex.shx';
      shippingShxAssertSemantic(changed, expected, 0);
      need(ed.doc.dirty, 'SHX actual STYLE edit must become dirty');
      const face = ed.doc.lookupBlock.textGeometry.resolve(ed.doc.entities[4]);
      need(face.shxResourceId === fonts[1].resourceId && ed.doc.lookupBlock.textGeometry.resolve(ed.doc.entities[1]).shxResourceId === fonts[0].resourceId, 'SHX STYLE must update only its matching rows');
      recordStyleMetrics('style-edit', 1); await pair('style-edit');
      need(ed.doc.undo(), 'SHX STYLE undo'); shippingShxAssertSemantic(semantic(), baseline, 0); recordMetrics('style-undo'); recordStyleMetrics('style-undo', 0); await pair('style-undo');
      need(ed.doc.redo(), 'SHX STYLE redo'); shippingShxAssertSemantic(semantic(), changed, 0); recordMetrics('style-redo'); recordStyleMetrics('style-redo', 1); await pair('style-redo');
      const beforeMove = semantic();
      moveText(2, 3, 4); const edited = semantic(); need(ed.doc.dirty, 'SHX native anchor edit must become dirty'); await pair('text-edit');
      need(ed.doc.undo(), 'SHX native TEXT undo'); shippingShxAssertSemantic(semantic(), beforeMove, 0); await pair('text-undo');
      need(ed.doc.redo(), 'SHX native TEXT redo'); shippingShxAssertSemantic(semantic(), edited, 0); await pair('text-redo');
      select('CANVAS'); paint(); const independentBeforeSave = capture('canvas'), wanted = semantic();
      need(await ed.saveFile(true, 'dxf') && ed.doc.filePath === output && !ed.doc.dirty, 'SHX actual DXF Save As');
      const savedState = ed.doc.snapshot;
      need(await ed.openFile(output) && ed.doc.snapshot !== savedState && !ed.doc.dirty && !ed.doc.history().undo.length && !ed.doc.history().redo.length, 'SHX first save must freshly reopen cleanly');
      shippingShxAssertSemantic(semantic(), wanted); assertUnbound(); setView();
      await pair('first-reopen-unbound', 'either'); await loadAll('first-reopen'); recordMetrics('first-reopen');
      await pair('first-reopen-loaded', 'canvas', independentBeforeSave);
      const adapterGl = currentGl();
      need(!adapterGl || !adapterGl.isContextLost(), 'SHX adapter evidence requires its current observed context');
      const debug = adapterGl?.getExtension('WEBGL_debug_renderer_info');
      const adapter = adapterGl ? { version: adapterGl.getParameter(adapterGl.VERSION), vendor: adapterGl.getParameter(adapterGl.VENDOR), renderer: adapterGl.getParameter(adapterGl.RENDERER),
        unmaskedVendor: debug ? adapterGl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : 'Unknown', unmaskedRenderer: debug ? adapterGl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'Unknown',
        maxTextureSize: adapterGl.getParameter(adapterGl.MAX_TEXTURE_SIZE) } : null;
      return { phase: 'gpu2d-shx', version: info.version, packaged: info.packaged, url: location.href, secure: true,
        defaultCanvas: true, noDefaultGpuAllocation: true, defaultGridBeforeLoad: true, explicitGpuCommand: true, filenameOnlyPolicyUnchanged: true,
        noRendererTestGlobals: true, fontLoadDocumentUnchanged: true, freshRuntimeUnbound: true, styleEditUndoRedo: true,
        textEditUndoRedo: true, firstSaveReopened: true, nativeGlyphMetrics: true, currentNativeOracle: 'unrun',
        recordedOracle: 'tests/fixtures/interchange/r2018-shx-text.md', adapter, comparisons, resources, metrics, styleMetrics, semantic: semantic() };
    }
    need(ed.doc.filePath === output && !ed.doc.dirty, 'SHX second save requires its clean first reopen');
    shippingShxAssertSemantic(semantic(), previous.semantic, 0); setView();
    const existing = document.querySelector('canvas[data-gpu-candidate="2d"]');
    if (existing) {
      need(existing instanceof HTMLCanvasElement, 'SHX observed backing must be the actual canvas');
      attach(existing, existing.getContext('webgl2'));
    }
    loadedRows(); moveText(19, 0.25, 0.5);
    select('CANVAS'); paint(); const independentBeforeSave = capture('canvas'), wanted = semantic();
    need(await ed.saveFile(false) && !ed.doc.dirty, 'SHX actual ordinary second Save');
    const savedState = ed.doc.snapshot;
    need(await ed.openFile(output) && ed.doc.snapshot !== savedState && !ed.doc.dirty && !ed.doc.history().undo.length && !ed.doc.history().redo.length, 'SHX second save must freshly reopen cleanly');
    shippingShxAssertSemantic(semantic(), wanted); assertUnbound(); setView();
    await pair('second-reopen-unbound', 'either'); await loadAll('second-reopen'); recordMetrics('second-reopen');
    await pair('second-reopen-loaded', 'canvas', independentBeforeSave);
    return { secondSaveReopened: true, finalFreshRuntimeUnbound: true, comparisons, resources, metrics };
  } finally {
    ed.hooks.saveError = originalSaveError;
    for (const restore of restores.reverse()) restore();
    if (HTMLCanvasElement.prototype.getContext === observedGetContext) Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', getDescriptor);
    vp.settings.background = originalSettings.background; vp.settings.gridVisible = originalSettings.gridVisible;
    vp.center = originalView.center; vp.scale = originalView.scale; vp.twist = originalView.twist;
    select('CANVAS'); ed.render();
  }
}

/** Called only by the fixed gpu2d-shx enum; reviewed observer is passed internally by main. */
async function runShippingGpuShxProbe(ctx, testBuild, renderOverlay) {
  if (testBuild) throw new Error('SHX probe requires ordinary shipping entry');
  const win = ctx.mainWindow; if (!win || win.isDestroyed()) throw new Error('No renderer window');
  const named = app.getPath('userData'), profile = fs.realpathSync.native(named);
  if (fs.lstatSync(named).isSymbolicLink() || path.dirname(profile) !== fs.realpathSync.native(os.tmpdir())
    || !/^jcad-shipping-smoke-[A-Za-z0-9-]+$/.test(path.basename(profile))) throw new Error('SHX probe requires its fresh temporary smoke profile');
  const { fixture, source, fonts } = shippingShxInputs(profile), output = path.join(profile, 'shipping-shx-output.dxf');
  for (const file of [output, output + '.bak']) {
    try { fs.lstatSync(file); throw new Error('SHX probe refuses a pre-existing output'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (typeof renderOverlay !== 'function') throw new Error('SHX requires its fixed main-owned render observer');
  const savedOpen = dialog.showOpenDialog, savedSave = dialog.showSaveDialog;
  let fontPicks = 0, savePicks = 0;
  /** @param {Electron.BaseWindow | Electron.OpenDialogOptions} _window @param {Electron.OpenDialogOptions} [options] */
  dialog.showOpenDialog = async (_window, options) => {
    const picked = /** @type {Electron.OpenDialogOptions} */ (options || _window);
    if (picked?.title !== 'Load SHX Font or Shapes' || picked.properties?.length !== 1 || picked.properties[0] !== 'openFile'
      || !picked.filters?.some(filter => filter.extensions.length === 1 && filter.extensions[0] === 'shx') || fontPicks >= 12) {
      throw new Error('Unexpected chooser during fixed SHX phase');
    }
    return { canceled: false, filePaths: [fonts[fontPicks++ % 4].path] };
  };
  /** @param {Electron.BaseWindow | Electron.SaveDialogOptions} _window @param {Electron.SaveDialogOptions} [options] */
  dialog.showSaveDialog = async (_window, options) => {
    const picked = /** @type {Electron.SaveDialogOptions} */ (options || _window);
    if (picked?.title !== 'Save Drawing As' || !picked.filters?.some(filter => filter.extensions.includes('dxf')) || savePicks++) throw new Error('Unexpected save chooser during fixed SHX phase');
    return { canceled: false, filePath: output };
  };
  const helperSource = [
    ['shippingShxSemantic', shippingShxSemantic], ['shippingShxAssertSemantic', shippingShxAssertSemantic],
    ['shippingShxStamp', shippingShxStamp], ['shippingShxSameStamp', shippingShxSameStamp], ['shippingShxAssertFixture', shippingShxAssertFixture],
    ['shippingGpu2dRenderOverlay', renderOverlay], ['shippingShxObservedFrame', shippingShxObservedFrame],
  ].map(([name, helper]) => 'const ' + name + '= (' + helper.toString() + ');').join('');
  const execute = (stage, previous) => win.webContents.executeJavaScript(
    '(() => {' + helperSource + 'return (' + shippingShxRenderer.toString() + ')('
    + [stage, fixture, output, fonts, previous].map(value => JSON.stringify(value)).join(',') + ',shippingGpu2dRenderOverlay);})()');
  /** @returns {{ fonts: number, saves: number }} */
  const selections = () => ({ fonts: fontPicks, saves: savePicks });
  try {
    const first = await execute('first', null), firstSaved = fs.readFileSync(output);
    const firstCounts = selections();
    if (firstCounts.saves !== 1 || firstCounts.fonts !== 8) throw new Error('SHX fixed first-stage native selection count');
    const firstExport = shippingShxExportCheck(firstSaved, fonts);
    const second = await execute('second', { semantic: first.semantic }), final = fs.readFileSync(output), backup = fs.readFileSync(output + '.bak');
    const finalCounts = selections();
    if (finalCounts.fonts !== 12 || finalCounts.saves !== 1 || final.equals(firstSaved) || !backup.equals(firstSaved) || !fs.readFileSync(fixture).equals(source)) {
      throw new Error('SHX exact backup, fixed selection count or original source preservation failed');
    }
    const finalExport = shippingShxExportCheck(final, fonts), hash = bytes => createHash('sha256').update(bytes).digest('hex');
    const { semantic: _semantic, ...record } = first;
    return { ...record, ...second, comparisons: [...first.comparisons, ...second.comparisons],
      resources: [...first.resources, ...second.resources], metrics: [...first.metrics, ...second.metrics],
      testBuild, backupExact: true, sourceUnchanged: true, fixtureSha256: hash(source), firstSaveSha256: hash(firstSaved),
      outputSha256: hash(final), backupSha256: hash(backup), firstExport, finalExport,
      fonts: fonts.map(({ path: _path, resourceId: _id, ...font }) => font), selectedPrivatePrograms: 4, fontSelections: 12 };
  } finally { dialog.showOpenDialog = savedOpen; dialog.showSaveDialog = savedSave; }
}

module.exports = { SHX_FIXTURE_SHA256, SHX_FIXTURE_BYTES, SHX_FONTS, shippingShxSemantic, shippingShxAssertFixture, shippingShxAssertSemantic,
  shippingShxStamp, shippingShxSameStamp, shippingShxInputs, shippingShxExportCheck, shippingShxObservedFrame, runShippingGpuShxProbe };
