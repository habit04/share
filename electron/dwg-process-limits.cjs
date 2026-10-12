/**
 * Parent-side memory watchdog for the isolated desktop DWG reader.
 *
 * Electron reports OS process metrics in KiB. These include resident native/WASM memory, rather
 * than only V8's heap. Sampling cannot reject an allocation before it occurs: this is an abort
 * threshold, not an OS allocation limit. Keep the engine-enforced WASM maximum and V8 heap limits
 * in addition to this watchdog. In particular, a short-lived peak or a host that is itself under
 * memory pressure can exceed this threshold between samples.
 *
 * https://www.electronjs.org/docs/latest/api/structures/memory-info
 * https://www.electronjs.org/docs/latest/api/structures/process-metric
 */
const DEFAULT_PROCESS_MEMORY_BYTES = 3 * 1024 * 1024 * 1024;
const MEMORY_SAMPLE_INTERVAL_MS = 100;
const METRICS_STARTUP_GRACE_MS = 3_000;

class DwgMemoryLimitError extends Error {
  constructor(bytes, limit) {
    super(`The DWG reader exceeded its memory threshold (${Math.round(limit / (1024 * 1024))} MB) and was stopped: the file is too large or damaged.`);
    this.name = 'DwgMemoryLimitError';
    this.code = 'ERR_DWG_MEMORY_LIMIT';
    this.observedBytes = bytes;
    this.limitBytes = limit;
  }
}

class DwgMemoryMonitorError extends Error {
  constructor(message = 'The DWG reader memory monitor is unavailable; opening was stopped.') {
    super(message);
    this.name = 'DwgMemoryMonitorError';
    this.code = 'ERR_DWG_MEMORY_MONITOR';
  }
}

/**
 * Convert one Electron OS process measurement. The values overlap, so take their maximum rather
 * than adding them. Windows privateBytes also covers committed private memory outside the working
 * set. Zero RSS is not a valid measurement for a running Node utility process.
 * @param {{ workingSetSize: number, peakWorkingSetSize: number, privateBytes?: number }} memory
 */
function measuredProcessBytes(memory) {
  if (!memory || !Number.isSafeInteger(memory.workingSetSize) || memory.workingSetSize <= 0 ||
      !Number.isSafeInteger(memory.peakWorkingSetSize) || memory.peakWorkingSetSize < 0 ||
      (memory.privateBytes !== undefined && (!Number.isSafeInteger(memory.privateBytes) || memory.privateBytes < 0))) {
    throw new DwgMemoryMonitorError('The DWG reader memory monitor returned an invalid measurement; opening was stopped.');
  }
  const largestKiB = Math.max(memory.workingSetSize, memory.peakWorkingSetSize, memory.privateBytes ?? 0);
  if (largestKiB > Number.MAX_SAFE_INTEGER / 1024) throw new DwgMemoryMonitorError();
  return largestKiB * 1024;
}

/**
 * Start monitoring after utilityProcess's spawn event, before loading LibreDWG or sending bytes.
 * `ready` is the parser-start gate: it resolves only after the first valid under-threshold OS
 * measurement. Metrics may appear shortly after spawn; no parse may begin during that grace.
 * After readiness, a missing measurement immediately fails closed. Process creation time binds
 * samples to the same OS process if its PID is reused.
 * @param {{
 *   pid: number,
 *   getMetrics: () => Array<{ pid: number, creationTime: number, type: string, memory: { workingSetSize: number, peakWorkingSetSize: number, privateBytes?: number } }>,
 *   onFailure: (error: Error) => void,
 *   maxBytes?: number,
 *   intervalMs?: number,
 *   startupGraceMs?: number,
 * }} options
 */
function createProcessMemoryGuard({ pid, getMetrics, onFailure, maxBytes = DEFAULT_PROCESS_MEMORY_BYTES,
  intervalMs = MEMORY_SAMPLE_INTERVAL_MS, startupGraceMs = METRICS_STARTUP_GRACE_MS }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof getMetrics !== 'function' || typeof onFailure !== 'function' ||
      !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(intervalMs) || intervalMs <= 0 || intervalMs > 1_000 ||
      !Number.isSafeInteger(startupGraceMs) || startupGraceMs < 0 || startupGraceMs > 15_000) {
    throw new Error('Invalid DWG process memory monitor settings');
  }
  let stopped = false;
  let readyOnce = false;
  /** @type {number | null} */
  let creationTime = null;
  /** @type {{ bytes: number, creationTime: number } | null} */
  let lastSample = null;
  const startedAt = Date.now();
  /** @type {(value: { bytes: number, creationTime: number }) => void} */
  let resolveReady;
  /** @type {(error: Error) => void} */
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // A synchronous invalid first sample or dispose-before-start must not create an unhandled
  // rejection while the host is still attaching its process listeners. The caller still receives
  // the rejection by awaiting the original promise.
  void ready.catch(() => {});
  const timer = setInterval(checkNow, intervalMs);
  timer.unref?.();

  function fail(error) {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    if (!readyOnce) rejectReady(error);
    onFailure(error);
  }

  /** Return true only when the process has a valid under-threshold measurement. */
  function checkNow() {
    if (stopped) return false;
    try {
      const metrics = getMetrics();
      if (!Array.isArray(metrics)) throw new DwgMemoryMonitorError();
      const matching = metrics.filter((metric) => metric?.pid === pid);
      if (matching.length === 0) {
        if (readyOnce || Date.now() - startedAt >= startupGraceMs) fail(new DwgMemoryMonitorError());
        return false;
      }
      if (matching.length !== 1) throw new DwgMemoryMonitorError();
      const metric = matching[0];
      if (metric.type !== 'Utility' || !Number.isFinite(metric.creationTime) || metric.creationTime <= 0 ||
          (creationTime !== null && metric.creationTime !== creationTime)) {
        throw new DwgMemoryMonitorError('The DWG reader process identity changed; opening was stopped.');
      }
      const bytes = measuredProcessBytes(metric.memory);
      if (bytes >= maxBytes) throw new DwgMemoryLimitError(bytes, maxBytes);
      creationTime = metric.creationTime;
      lastSample = Object.freeze({ bytes, creationTime });
      if (!readyOnce) {
        readyOnce = true;
        resolveReady(lastSample);
      }
      return true;
    } catch (error) {
      fail(error instanceof DwgMemoryLimitError || error instanceof DwgMemoryMonitorError ? error : new DwgMemoryMonitorError());
      return false;
    }
  }

  checkNow();
  return {
    ready,
    checkNow,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (!readyOnce) rejectReady(new DwgMemoryMonitorError('The DWG reader was stopped before its memory monitor was ready.'));
    },
    get lastSample() { return lastSample; },
  };
}

module.exports = { createProcessMemoryGuard, measuredProcessBytes, DwgMemoryLimitError,
  DwgMemoryMonitorError, DEFAULT_PROCESS_MEMORY_BYTES, MEMORY_SAMPLE_INTERVAL_MS, METRICS_STARTUP_GRACE_MS };
