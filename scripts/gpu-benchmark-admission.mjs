/** Observe a settled frame without requesting a render or changing admission policy.
 * This is an untimed correctness observer; its fixed deadline includes an automatic
 * idle admission retry. The calling benchmark retains its original deferred frame.
 * Self-contained so Playwright can serialize the function into the renderer.
 * @param {{document:string,camera:{center:{x:number,y:number},scale:number,twist:number,width:number,height:number,dpr:number}}} expected
 */
export async function observeActualGpuAdmission(expected) {
  const ed = window.editor, api = window.gpuPrototype, v = ed.viewport, sourceDoc = ed.doc;
  const started = performance.now();
  const camera = () => ({ center: { x: v.center.x, y: v.center.y }, scale: v.scale, twist: v.twist, width: v.width, height: v.height, dpr: v.dpr });
  const equalCamera = (a, b) => ['scale', 'twist', 'width', 'height', 'dpr'].every(key => Object.is(a[key], b[key]))
    && Object.is(a.center.x, b.center.x) && Object.is(a.center.y, b.center.y);
  if (!expected || typeof expected.document !== 'string' || !expected.camera
    || ![expected.camera.center?.x, expected.camera.center?.y, expected.camera.scale, expected.camera.twist, expected.camera.width, expected.camera.height, expected.camera.dpr].every(Number.isFinite)
    || expected.camera.scale <= 0 || expected.camera.width <= 0 || expected.camera.height <= 0 || expected.camera.dpr <= 0) throw new Error('Invalid actual-admission observation input');
  const snapshot = ed.doc.snapshot;
  const drawing = /** @type {HTMLCanvasElement|null} */ (document.getElementById('drawing'));
  if (!drawing || typeof drawing.getContext !== 'function') throw new Error('Actual-admission Canvas is unavailable');
  const originalRender = v.render;
  if (typeof originalRender !== 'function') throw new Error('Actual-admission viewport renderer is unavailable');
  const ownDescriptor = Object.getOwnPropertyDescriptor(v, 'render');
  const settings = JSON.stringify(v.settings);
  const selection = JSON.stringify(Array.from(ed.selection ?? []).sort());
  const overlay = () => {
    const current = /** @type {any} */ (v).lastOverlay;
    return JSON.stringify(current ? { selection: Array.from(current.selection ?? []).sort(), hover: current.hover ?? null, preview: current.preview, ghost: current.ghost } : null);
  };
  const originalOverlay = overlay();
  const display = { width: drawing.width, height: drawing.height, layoutPainter: v.layoutPainter, underlay: v.underlay, fitRect: v.fitRect, sceneRenderer: v.experimentalSceneRenderer };
  const dirty = ed.doc.dirty;
  const history = typeof ed.doc.history === 'function' ? JSON.stringify(ed.doc.history()) : null;
  const invariant = () => {
    if (window.editor !== ed || window.gpuPrototype !== api || ed.viewport !== v || ed.doc !== sourceDoc || ed.doc.snapshot !== snapshot || JSON.stringify(ed.doc.snapshot) !== expected.document) throw new Error('Drawing changed during actual-admission observation');
    if (!equalCamera(camera(), expected.camera)) throw new Error('Camera or viewport changed during actual-admission observation');
    if (api.status().mode !== 'gpu' || JSON.stringify(v.settings) !== settings
      || JSON.stringify(Array.from(ed.selection ?? []).sort()) !== selection || overlay() !== originalOverlay
      || drawing.width !== display.width || drawing.height !== display.height
      || v.layoutPainter !== display.layoutPainter || v.underlay !== display.underlay || v.fitRect !== display.fitRect
      || v.experimentalSceneRenderer !== display.sceneRenderer
      || ed.doc.dirty !== dirty || (history !== null && JSON.stringify(ed.doc.history()) !== history)) throw new Error('Geometry display or drawing history changed during actual-admission observation');
  };
  invariant();
  let timer, installed = false, settled = false, actual, fail;
  let observedFrames = 0, initialFrame = null, settledBeforeObservation = false, waitMs = 0;
  const observed = new Promise((resolve, reject) => { actual = resolve; fail = reject; });
  const reject = error => { if (!settled) { settled = true; fail(error); } };
  const capture = (initial = false) => {
    if (settled) return;
    invariant();
    const frame = { ...api.renderStats() };
    if (typeof frame.rendered !== 'boolean' || typeof frame.cacheReason !== 'string' || !frame.cacheReason) throw new Error('Actual-admission frame telemetry is unavailable');
    observedFrames++;
    if (initial) initialFrame = frame;
    if (frame.cacheReason === 'admission-deferred') return;
    settledBeforeObservation = initial;
    waitMs = Math.max(0, performance.now() - started);
    settled = true; actual(frame);
  };
  const hook = /** @this {any} */ function (...args) {
    let result;
    try { result = Reflect.apply(originalRender, this, args); }
    catch (error) { reject(error); throw error; }
    try { capture(); } catch (error) { reject(error); }
    return result;
  };
  try {
    // Install before inspecting current telemetry: a retry which already settled is
    // consumed immediately, while later automatic frames are observed through here.
    Object.defineProperty(v, 'render', { value: hook, writable: true, configurable: true, enumerable: ownDescriptor?.enumerable ?? false });
    installed = true;
    timer = setTimeout(() => reject(new Error('Actual GPU admission did not settle within 10 seconds')), 10000);
    try { capture(true); } catch (error) { reject(error); }
    const frame = await observed;
    const completionStarted = performance.now();
    let reportedCompletionMs = null;
    if (frame.rendered) {
      reportedCompletionMs = await api.completed();
      if (!(typeof reportedCompletionMs === 'number' && Number.isFinite(reportedCompletionMs) && reportedCompletionMs >= 0)) throw new Error('Actual GPU admission completion was not observed');
    } else {
      const ctx = drawing.getContext('2d');
      if (!ctx) throw new Error('Actual-admission Canvas context is unavailable');
      ctx.getImageData(0, 0, 1, 1);
    }
    invariant();
    return { frame, initialFrame, waitMs, observedFrames, settledBeforeObservation, reportedCompletionMs,
      completionWaitMs: Math.max(0, performance.now() - completionStarted), completedFrameWallMs: Math.max(0, performance.now() - started),
      automaticAdmissionObservation: true, renderRequested: false, rendererResourcesReset: false, documentUnchanged: true, cameraUnchanged: true };
  } finally {
    clearTimeout(timer);
    if (installed) {
      if (ownDescriptor) Object.defineProperty(v, 'render', ownDescriptor);
      else delete /** @type {any} */ (v).render;
    }
  }
}