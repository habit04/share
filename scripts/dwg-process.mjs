/**
 * Utility-process controller. No native reader or WASM is imported before the parent's OS
 * memory monitor permits input. Input and serialized output move one acknowledged chunk at
 * a time; one inner worker contains V8/native parsing and one process serves exactly one read.
 * Node's advanced IPC is an alternative transport for the explicit unit-test launcher only.
 */
import { Worker } from 'node:worker_threads';
import protocol from '../electron/dwg-protocol.cjs';

const { PROTOCOL_VERSION, MAX_DWG_INPUT_BYTES, MAX_DWG_PAYLOAD_BYTES, MAX_DWG_CHUNK_BYTES,
  validRequestId, validByteLength, validOffset, validateResourceLimits, validateChunk, boundedErrorMessage } = protocol;
const parentPort = /** @type {any} */ (process).parentPort;
const electronTransport = parentPort && typeof parentPort.postMessage === 'function' && typeof parentPort.on === 'function';
if (!electronTransport && typeof process.send !== 'function') throw new Error('The DWG controller requires its parent process transport.');

let stopped = false;
let phase = 'bootstrap';
let requestId = 0;
let input = null;
let inputOffset = 0;
let output = null;
let outputOffset = 0;
let outputExpectedAck = 0;
let resourceLimits = null;
let worker = null;
let startup = null;
let idle = null;

function send(message) {
  if (stopped) return;
  if (electronTransport) parentPort.postMessage(message);
  else process.send(message, (error) => { if (error) stop(); });
}

/** The parent normally kills us; a lost parent also disposes any parser and exits. */
function stop() {
  if (stopped) return;
  stopped = true;
  clearTimeout(startup);
  clearTimeout(idle);
  if (worker) void worker.terminate();
  input = output = null;
  if (electronTransport) parentPort.close?.();
  else if (process.connected) process.disconnect();
  process.exit(0);
}

function fail(error) {
  if (stopped || phase === 'failed') return;
  phase = 'failed';
  clearTimeout(startup);
  if (worker) void worker.terminate();
  input = output = null;
  try { send({ type: 'error', id: requestId, message: boundedErrorMessage(error) }); } catch { stop(); }
  // Avoid keeping a process alive if its parent no longer drains the final error.
  idle = setTimeout(stop, 5_000);
  idle.unref?.();
}

function startParser() {
  phase = 'starting';
  worker = new Worker(new URL('./dwg-worker.mjs', import.meta.url), { resourceLimits, execArgv: [] });
  startup = setTimeout(() => fail(new Error('The DWG parser did not start in time.')), 15_000);
  let workerReady = false;
  let replied = false;
  worker.on('message', (message) => {
    try {
      if (stopped || phase === 'failed') return;
      if (!workerReady) {
        if (phase !== 'starting' || !message || message.ready !== true) throw new Error('Invalid DWG parser startup response.');
        // Old-space plus three semi-spaces is V8's heap limit. Small rounding room permits
        // engine/page differences; an inherited multi-gigabyte heap fails before parsing.
        const expectedHeap = (resourceLimits.maxOldGenerationSizeMb + 3 * resourceLimits.maxYoungGenerationSizeMb + 8) * 1024 * 1024;
        if (!Number.isSafeInteger(message.heapLimitBytes) || message.heapLimitBytes <= 0 || message.heapLimitBytes > expectedHeap) throw new Error('The DWG parser heap limit could not be enforced.');
        workerReady = true;
        clearTimeout(startup);
        phase = 'parsing';
        const bytes = input;
        input = null;
        worker.postMessage({ id: requestId, bytes: bytes.buffer }, [bytes.buffer]);
        return;
      }
      if (phase !== 'parsing' || replied || !message || message.id !== requestId || typeof message.ok !== 'boolean') throw new Error('Invalid DWG parser response.');
      replied = true;
      if (!message.ok) { fail(new Error(boundedErrorMessage(message.message))); return; }
      if (!(message.serialized instanceof ArrayBuffer) || !validByteLength(message.serialized.byteLength, MAX_DWG_PAYLOAD_BYTES)) throw new Error('Invalid DWG serialized result size.');
      output = new Uint8Array(message.serialized);
      phase = 'output';
      outputOffset = outputExpectedAck = 0;
      send({ type: 'output-start', id: requestId, byteLength: output.byteLength });
    } catch (error) { fail(error); }
  });
  worker.on('error', (error) => {
    fail(/** @type {any} */ (error)?.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new Error('The DWG reader ran out of its memory limit: the file is too large or damaged.') : error);
  });
  worker.on('exit', () => {
    if (!stopped && phase !== 'failed' && !replied) fail(new Error('The DWG parser stopped unexpectedly.'));
  });
}

function receive(message) {
  try {
    if (stopped) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid DWG controller message.');
    if (phase === 'bootstrap' && message.type === 'input-start') {
      if (!validRequestId(message.id) || !validByteLength(message.byteLength, MAX_DWG_INPUT_BYTES)) throw new Error('Invalid DWG reader input size or request id.');
      requestId = message.id;
      resourceLimits = validateResourceLimits(message.resourceLimits);
      input = new Uint8Array(message.byteLength);
      phase = 'input';
      send({ type: 'input-ack', id: requestId, offset: 0 });
      return;
    }
    if (message.id !== requestId) throw new Error('Invalid DWG controller request id.');
    if (phase === 'input' && message.type === 'input-chunk') {
      const end = validateChunk(message.bytes, message.offset, inputOffset, input.byteLength);
      input.set(message.bytes, inputOffset);
      inputOffset = end;
      send({ type: 'input-ack', id: requestId, offset: inputOffset });
      return;
    }
    if (phase === 'input' && message.type === 'input-end') {
      if (inputOffset !== input.byteLength) throw new Error('The DWG reader input ended before all bytes arrived.');
      startParser();
      return;
    }
    if (phase === 'output' && message.type === 'output-ack') {
      if (!validOffset(message.offset, output.byteLength) || message.offset !== outputExpectedAck) throw new Error('Invalid DWG reader output acknowledgement.');
      if (message.offset === output.byteLength) {
        output = null;
        phase = 'done';
        send({ type: 'done', id: requestId });
        idle = setTimeout(stop, 5_000);
        idle.unref?.();
        return;
      }
      const end = Math.min(outputOffset + MAX_DWG_CHUNK_BYTES, output.byteLength);
      // A view would clone its entire backing buffer over Electron's structured-clone IPC.
      const bytes = Uint8Array.from(output.subarray(outputOffset, end));
      // The acknowledgement prevents more than one chunk from entering the IPC queue.
      send({ type: 'output-chunk', id: requestId, offset: outputOffset, bytes });
      outputOffset = outputExpectedAck = end;
      return;
    }
    throw new Error('Unexpected or repeated DWG controller message.');
  } catch (error) { fail(error); }
}

if (electronTransport) {
  parentPort.on('message', (event) => receive(event.data));
  parentPort.on('close', stop);
} else {
  process.on('message', receive);
  process.on('disconnect', stop);
}
send({ type: 'ready', protocol: PROTOCOL_VERSION, pid: process.pid });
