// Only this projection crosses IPC. Chromium's complete GPUInfo is never returned.
const FEATURE_KEYS = ['2d_canvas', 'flash_3d', 'flash_stage3d', 'flash_stage3d_baseline', 'gpu_compositing', 'multiple_raster_threads', 'native_gpu_memory_buffers', 'rasterization', 'video_decode', 'video_encode', 'vpx_decode', 'webgl', 'webgl2', 'opengl', 'vulkan', 'webgpu', 'direct_rendering_display', 'skia_graphite'];

/** @param {unknown} value */
function text(value) {
  if (typeof value !== 'string') return 'Unknown';
  const normalized = value.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '').trim();
  // Reject paths, URLs and credential-like text rather than copying private context.
  if (/[\\/]|\b(?:password|token|secret|credential|api[_ -]?key)\b|[\w.+-]+@[\w.-]+/i.test(normalized)) return 'Unknown';
  return normalized.slice(0, 160) || 'Unknown';
}
/** @param {unknown} value @returns {Record<string, any>} */
function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
/** @param {unknown} value */
function id(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) return `0x${value.toString(16).padStart(4, '0')}`;
  return typeof value === 'string' && /^(?:0x[0-9a-f]{1,8}|[0-9]{1,10})$/i.test(value) ? value : 'Unknown';
}

/** @param {unknown} raw @param {unknown} status @param {unknown} acceleration @param {Record<string, string>} versions */
function projectGPUInfo(raw, status, acceleration, versions) {
  const info = record(raw);
  const features = /** @type {Record<string, string>} */ ({});
  const reported = record(status);
  const reasons = [];
  let software = false;
  for (const key of FEATURE_KEYS) {
    features[key] = text(reported[key]);
    if (/^(?:disabled_software|unavailable_software|software(?:_.*)?)$/.test(features[key])) {
      reasons.push(`${key}: ${features[key]}`);
      software = true;
    } else if (/^(?:disabled_off|unavailable_off)$/.test(features[key])) reasons.push(`${key}: ${features[key]}`);
  }
  const aux = record(info.auxAttributes);
  if (aux.softwareRendering === true || info.softwareRendering === true) { reasons.push('GPU reports software rendering.'); software = true; }
  if (typeof aux.glRenderer === 'string' && /\b(?:swiftshader|llvmpipe|softpipe|software rasterizer|microsoft basic render driver)\b/i.test(aux.glRenderer)) { reasons.push('GPU renderer reports a software implementation.'); software = true; }
  if (acceleration === false) reasons.push('Electron reports hardware acceleration disabled; underlying reason Unknown.');
  const adapters = (Array.isArray(info.gpuDevice) ? info.gpuDevice : []).slice(0, 16).map((value) => {
    const device = record(value);
    return {
      name: text(device.deviceString), vendorId: id(device.vendorId), deviceId: id(device.deviceId),
      active: typeof device.active === 'boolean' ? device.active : null,
      driverVendor: text(device.driverVendor), driverVersion: text(device.driverVersion),
    };
  });
  return { state: 'ready', adapters, hardwareAcceleration: typeof acceleration === 'boolean' ? acceleration : null, features,
    driver: { vendor: text(aux.driverVendor), version: text(aux.driverVersion) },
    fallback: software ? 'Software fallback reported' : 'Unknown', reasons, versions };
}

/**
 * Register before app readiness. Never await this collector during window startup.
 * A later event or request retries failures; obsolete/hung results cannot overwrite recovery.
 * @param {Electron.App} app
 * @param {{ versions: Record<string, string>, timeoutMs?: number }} options
 */
function createGPUCollector(app, { versions, timeoutMs = 5000 }) {
  const safeVersions = Object.fromEntries(['jcad', 'electron', 'chromium', 'windows'].map((key) => [key, text(versions[key])]));
  const empty = (state, reason) => ({ ...projectGPUInfo(null, null, null, safeVersions), state, reasons: [reason] });
  let snapshot = empty('pending', 'GPU information is pending.');
  let observed = false;
  let collecting = false;
  let disposed = false;
  let generation = 0;
  let dirty = false;
  /** @type {Promise<void> | null} */
  let inFlight = null;
  let finishCurrent = () => {};
  let timer = setTimeout(() => { snapshot = empty('unavailable', 'GPU information timed out.'); }, timeoutMs);
  timer.unref?.();
  function collect(allowRefresh = true) {
    if (disposed || !observed || collecting) return inFlight;
    collecting = true;
    dirty = false;
    const attempt = ++generation;
    let resolveDone = () => {};
    inFlight = new Promise((resolve) => { resolveDone = resolve; });
    const completion = inFlight;
    const finish = () => {
      if (attempt !== generation) return;
      generation++;
      clearTimeout(timer);
      collecting = false;
      inFlight = null;
      // At most one follow-up per cycle: getGPUInfo can itself emit updates.
      if (dirty && allowRefresh && !disposed) void collect(false)?.then(resolveDone);
      else resolveDone();
    };
    finishCurrent = finish;
    snapshot = empty('pending', 'GPU information is pending.');
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (attempt !== generation) return;
      snapshot = { ...snapshot, state: 'unavailable', reasons: [...snapshot.reasons.filter((reason) => reason !== 'GPU information is pending.'), 'GPU information timed out.'] };
      finish();
    }, timeoutMs);
    timer.unref?.();
    void Promise.resolve().then(async () => {
      let status;
      let acceleration;
      let failed = false;
      // Independent APIs remain useful even when complete GPUInfo rejects or hangs.
      try { status = app.getGPUFeatureStatus(); } catch { failed = true; }
      try { acceleration = app.isHardwareAccelerationEnabled(); } catch { failed = true; }
      const partial = projectGPUInfo(null, status, acceleration, safeVersions);
      if (attempt === generation && !disposed) snapshot = { ...partial, state: 'pending', reasons: [...partial.reasons, 'GPU information is pending.'] };
      let raw;
      try { raw = await app.getGPUInfo('complete'); } catch { failed = true; }
      const result = projectGPUInfo(raw, status, acceleration, safeVersions);
      if (failed) { result.state = 'unavailable'; result.reasons.push('Some GPU information could not be collected.'); }
      if (attempt === generation && !disposed) snapshot = result;
    }).catch(() => {
      if (attempt === generation && !disposed) snapshot = empty('unavailable', 'GPU information could not be collected.');
    }).finally(() => {
      finish();
    });
    return completion;
  }
  function update() { observed = true; if (collecting) dirty = true; else collect(); }
  app.on('gpu-info-update', update);
  return {
    get() {
      if (snapshot.state === 'unavailable' && observed && !disposed) return collect()?.then(() => structuredClone(snapshot));
      return structuredClone(snapshot);
    },
    dispose() { disposed = true; finishCurrent(); generation++; clearTimeout(timer); app.removeListener('gpu-info-update', update); },
  };
}

module.exports = { createGPUCollector, projectGPUInfo };
