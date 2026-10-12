/**
 * Desktop DWG parsing in a disposable Electron utility process. That process owns a worker
 * with a bounded V8 heap and engine-bounded WASM memory; neither parser runs in the main process.
 * An independent OS watchdog samples the whole utility process, including its worker.
 * The watchdog is a sampled threshold, not an instantaneous OS allocation limit.
 *
 * One parser runs at a time. Queued input, request count and IPC frames/output are bounded.
 * Every read, cancellation, timeout and failure tears down its process before the next starts.
 */
const path = require('node:path');
const { deserialize } = require('node:v8');
const { MAX_DRAWING_BYTES } = require('./resource-limits.cjs');
const { createProcessMemoryGuard } = require('./dwg-process-limits.cjs');
const { MAX_DWG_PAYLOAD_BYTES, MAX_DWG_CHUNK_BYTES, PROTOCOL_VERSION, WORKER_RESOURCE_LIMITS, validateResourceLimits, validateDwgPayload } = require('./dwg-protocol.cjs');

const DEFAULT_PROGRESS_BYTES = 1024 * 1024;
const READ_TIMEOUT_BASE_MS = 60_000;
const READ_TIMEOUT_PER_MB_MS = 1_000;
const READ_TIMEOUT_MAX_MS = 10 * 60_000;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 3_000;
const MAX_OUTSTANDING_READS = 4;
const MAX_QUEUED_BYTES = MAX_DRAWING_BYTES;

class OpenCancelledError extends Error {
  constructor() { super('Open cancelled'); this.name = 'OpenCancelledError'; this.cancelled = true; }
}
function readTimeoutFor(bytes) {
  return Math.min(READ_TIMEOUT_MAX_MS, READ_TIMEOUT_BASE_MS + Math.ceil(bytes / (1024 * 1024)) * READ_TIMEOUT_PER_MB_MS);
}

/** Production has no Node/worker-thread fallback: Electron's utility API must be available. */
function launchUtilityProcess(modulePath, options) {
  const { utilityProcess } = require('electron');
  if (!utilityProcess?.fork) throw new Error('The isolated DWG reader is unavailable.');
  return utilityProcess.fork(modulePath, [], { ...options, serviceName: 'JCad DWG Reader', stdio: 'ignore', allowLoadingUnsignedLibraries: false });
}
function defaultMemoryGuard({ pid, onFailure }) {
  const { app } = require('electron');
  return createProcessMemoryGuard({ pid, getMetrics: () => app.getAppMetrics(), onFailure });
}
function childEnvironment(allowTestHooks) {
  const env = { ...process.env };
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE']) delete env[name];
  if (!allowTestHooks) delete env.JCAD_DWG_TEST_DELAY_MS;
  return env;
}

/**
 * launchProcess and memoryGuardFactory inject real child-process tests; the application always
 * uses Electron utilityProcess and its OS metrics watchdog.
 * @param {{ scriptsDir: string, timeoutMs?: number, maxBytes?: number, resourceLimits?: Record<string, number>,
 *   launchProcess?: Function, memoryGuardFactory?: Function, allowTestHooks?: boolean }} opts
 */
function createDwgHost({ scriptsDir, timeoutMs, maxBytes = MAX_DRAWING_BYTES, resourceLimits = WORKER_RESOURCE_LIMITS, launchProcess = launchUtilityProcess, memoryGuardFactory = defaultMemoryGuard, allowTestHooks = false }) {
  if (!scriptsDir || (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_DRAWING_BYTES) throw new Error('Invalid DWG resource limits.');
  const limits = validateResourceLimits(resourceLimits);
  const entry = path.join(scriptsDir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1'), 'dwg-process.mjs');
  let disposed = false;
  let nextId = 1;
  let reservedBytes = 0;
  let stopping = false;
  /** @type {any | null} */
  let current = null;
  /** @type {Map<number, any>} */
  const requests = new Map();
  /** @type {any[]} */
  const queue = [];

  function settle(item, error, result) {
    if (item.settled) return;
    item.settled = true;
    requests.delete(item.id);
    reservedBytes -= item.byteLength;
    item.bytes = null;
    item.output = null;
    if (error) item.reject(error);
    else item.resolve(result);
  }
  function stopAll(error) {
    for (const item of queue.splice(0)) settle(item, error);
  }
  function finish(state, error, result) {
    if (state.finished) return;
    state.finished = true;
    clearTimeout(state.startTimer);
    clearTimeout(state.readTimer);
    state.guard?.stop();
    settle(state.item, error, result);
    stopping = true;
    if (state.exited) return retired(state);
    state.stopTimer = setTimeout(() => {
      // Refuse to accumulate processes if the OS did not report termination.
      disposed = true;
      stopAll(new Error('The DWG reader could not be stopped. Restart JCad before opening another DWG.'));
    }, STOP_TIMEOUT_MS);
    try { state.child.kill(); } catch { /* exit/stop deadline still owns cleanup */ }
  }
  function retired(state) {
    clearTimeout(state.stopTimer);
    if (current !== state) return;
    current = null;
    stopping = false;
    if (!disposed) queueMicrotask(pump);
  }
  function send(state, msg) {
    if (state.finished) return;
    try {
      if (state.guard && !state.guard.checkNow()) return;
      if (!state.finished) state.child.postMessage(msg);
    } catch (error) { finish(state, error); }
  }
  function beginInput(state) {
    if (state.finished || !state.ready || !state.monitored || state.inputStarted) return;
    state.inputStarted = true;
    clearTimeout(state.startTimer);
    const limit = timeoutMs ?? readTimeoutFor(state.item.byteLength);
    state.readTimer = setTimeout(() => finish(state, new Error('Reading the DWG file took longer than ' + Math.round(limit / 1000) + ' s and was stopped: the file is too large or damaged.')), limit);
    send(state, { type: 'input-start', id: state.item.id, byteLength: state.item.byteLength, resourceLimits: limits });
  }
  function protocolFailure(state) { finish(state, new Error('The DWG reader returned an invalid or oversized response.')); }
  function message(state, msg) {
    if (state.finished) return;
    if (!msg || typeof msg !== 'object') return protocolFailure(state);
    if (msg.type === 'ready') {
      if (state.ready || msg.protocol !== PROTOCOL_VERSION || msg.pid !== state.child.pid) return protocolFailure(state);
      state.ready = true;
      beginInput(state);
      return;
    }
    if (msg.id !== state.item.id || !state.inputStarted) return protocolFailure(state);
    if (msg.type === 'error') {
      if (typeof msg.message !== 'string' || msg.message.length > 1024) return protocolFailure(state);
      finish(state, new Error(msg.message || 'The DWG reader failed.'));
    } else if (msg.type === 'input-ack') {
      if (state.inputEnded || !Number.isSafeInteger(msg.offset) || msg.offset !== state.inputSent) return protocolFailure(state);
      if (msg.offset === state.item.byteLength) {
        state.inputEnded = true;
        send(state, { type: 'input-end', id: state.item.id });
        state.item.bytes = null;
        return;
      }
      const end = Math.min(msg.offset + MAX_DWG_CHUNK_BYTES, state.item.byteLength);
      const bytes = state.item.bytes.slice(msg.offset, end);
      state.inputSent = end;
      send(state, { type: 'input-chunk', id: state.item.id, offset: msg.offset, bytes });
    } else if (msg.type === 'output-start') {
      if (!state.inputEnded || state.item.output || !Number.isSafeInteger(msg.byteLength) || msg.byteLength <= 0 || msg.byteLength > MAX_DWG_PAYLOAD_BYTES) return protocolFailure(state);
      state.item.output = Buffer.allocUnsafe(msg.byteLength);
      state.outputOffset = 0;
      send(state, { type: 'output-ack', id: state.item.id, offset: 0 });
    } else if (msg.type === 'output-chunk') {
      const bytes = msg.bytes;
      if (!state.item.output || msg.offset !== state.outputOffset || !(bytes instanceof Uint8Array) || bytes.byteLength <= 0 || bytes.byteLength > MAX_DWG_CHUNK_BYTES || bytes.byteLength > state.item.output.length - state.outputOffset) return protocolFailure(state);
      state.item.output.set(bytes, state.outputOffset);
      state.outputOffset += bytes.byteLength;
      send(state, { type: 'output-ack', id: state.item.id, offset: state.outputOffset });
    } else if (msg.type === 'done') {
      if (!state.item.output || state.outputOffset !== state.item.output.length) return protocolFailure(state);
      try {
        if (state.guard && !state.guard.checkNow()) return;
        if (state.finished) return;
        const result = deserialize(state.item.output);
        if (!result || typeof result.version !== 'string' || !result.payload || typeof result.payload !== 'object') return protocolFailure(state);
        validateDwgPayload(result.payload, result.version);
        finish(state, null, result);
      } catch (error) { finish(state, error); }
    } else protocolFailure(state);
  }
  function pump() {
    if (disposed || current || stopping || !queue.length) return;
    const item = queue.shift();
    /** @type {any} */
    const state = { item, child: null, guard: null, ready: false, monitored: false, finished: false, exited: false, inputStarted: false, inputEnded: false, inputSent: 0, outputOffset: 0 };
    current = state;
    state.startTimer = setTimeout(() => finish(state, new Error('The isolated DWG reader did not start in time.')), START_TIMEOUT_MS);
    try {
      state.child = launchProcess(entry, { env: childEnvironment(allowTestHooks) });
      state.child.on('message', (msg) => {
        try { message(state, msg); } catch (error) { finish(state, error); }
      });
      state.child.on('error', () => finish(state, new Error('The isolated DWG reader ran out of memory or stopped unexpectedly. Use a smaller file.')));
      state.child.on('exit', () => {
        state.exited = true;
        if (!state.finished) finish(state, new Error('The isolated DWG reader stopped unexpectedly: the file may be too large or damaged.'));
        retired(state);
      });
      state.child.once('spawn', () => {
        if (state.finished) {
          try { state.child.kill(); } catch { /* the stop deadline refuses further reads */ }
          return;
        }
        try {
          const pid = state.child.pid;
          if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) throw new Error('Invalid isolated DWG process.');
          state.guard = memoryGuardFactory({ pid, onFailure: (error) => finish(state, error) });
          state.guard.ready.then(() => { state.monitored = true; beginInput(state); }, (error) => finish(state, error));
        } catch (error) { finish(state, error); }
      });
    } catch (error) {
      state.exited = true;
      finish(state, error);
    }
  }

  return {
    read(bytes, id = nextId++) {
      if (disposed) return Promise.reject(new Error('The DWG reader was closed.'));
      if (!(bytes instanceof Uint8Array)) return Promise.reject(new Error('Invalid DWG payload'));
      if (!Number.isSafeInteger(id) || id <= 0) return Promise.reject(new Error('Invalid DWG request id.'));
      if (bytes.byteLength > maxBytes) return Promise.reject(new Error('The DWG file is larger than the supported ' + Math.round(maxBytes / (1024 * 1024)) + ' MB.'));
      if (requests.has(id)) return Promise.reject(new Error('A DWG read already uses this request id.'));
      if (requests.size >= MAX_OUTSTANDING_READS || bytes.byteLength > MAX_QUEUED_BYTES - reservedBytes) return Promise.reject(new Error('Too many DWG files are being opened. Wait for a current read to finish.'));
      return new Promise((resolve, reject) => {
        const item = { id, byteLength: bytes.byteLength, bytes: new Uint8Array(bytes), resolve, reject, settled: false, output: null };
        requests.set(id, item);
        reservedBytes += item.byteLength;
        queue.push(item);
        pump();
      });
    },
    cancel(id) {
      const item = requests.get(id);
      if (!item) return false;
      if (current?.item === item) finish(current, new OpenCancelledError());
      else {
        const at = queue.indexOf(item);
        if (at >= 0) queue.splice(at, 1);
        settle(item, new OpenCancelledError());
      }
      return true;
    },
    dispose() {
      disposed = true;
      stopAll(new Error('The DWG reader was closed.'));
      if (current) finish(current, new Error('The DWG reader was closed.'));
    },
    get usesWorker() { return true; },
    get usesProcess() { return true; },
    newId: () => nextId++,
  };
}
function progressThreshold() {
  const value = Number(process.env.JCAD_OPEN_PROGRESS_BYTES);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_PROGRESS_BYTES;
}
module.exports = { createDwgHost, OpenCancelledError, progressThreshold, readTimeoutFor, DEFAULT_PROGRESS_BYTES, WORKER_RESOURCE_LIMITS, START_TIMEOUT_MS, MAX_OUTSTANDING_READS, MAX_QUEUED_BYTES };
