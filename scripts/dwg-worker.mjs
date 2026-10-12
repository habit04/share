/** One bounded parser thread, always inside the isolated desktop DWG utility process. */
import { parentPort } from 'node:worker_threads';
import { serialize, getHeapStatistics } from 'node:v8';
import { readDwgPayload, resetLibreDwg } from './dwg-reader.mjs';
import protocol from '../electron/dwg-protocol.cjs';

if (!parentPort) throw new Error('scripts/dwg-worker.mjs must run as a worker thread');
const port = parentPort;
const { MAX_DWG_INPUT_BYTES, MAX_DWG_PAYLOAD_BYTES, validRequestId, validByteLength, validateDwgPayload, boundedErrorMessage } = protocol;
/** Sanitized by the host: only development/test builds may inject this cancellation delay. */
const testDelayMs = Math.min(Math.max(Number(process.env.JCAD_DWG_TEST_DELAY_MS) || 0, 0), 60_000);
let used = false;

port.on('message', async (msg) => {
  if (used || !msg || !validRequestId(msg.id) || !(msg.bytes instanceof ArrayBuffer) || !validByteLength(msg.bytes.byteLength, MAX_DWG_INPUT_BYTES)) {
    port.postMessage({ id: msg?.id, ok: false, message: 'Invalid DWG parser request.' });
    port.close();
    return;
  }
  used = true;
  try {
    if (testDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, testDelayMs));
    const { payload, version } = await readDwgPayload(new Uint8Array(msg.bytes), 'dwg');
    validateDwgPayload(payload, version);
    const serialized = serialize({ payload, version });
    if (!validByteLength(serialized.byteLength, MAX_DWG_PAYLOAD_BYTES)) throw new Error('DWG result exceeds the safe transfer limit (64 MB).');
    // V8 serialization can use a pooled Buffer; transfer an exact owned ArrayBuffer.
    const output = Uint8Array.from(serialized);
    port.postMessage({ id: msg.id, ok: true, serialized: output.buffer }, [output.buffer]);
  } catch (error) {
    void resetLibreDwg();
    port.postMessage({ id: msg.id, ok: false, message: boundedErrorMessage(error) });
  } finally {
    port.close();
  }
});
port.postMessage({ ready: true, heapLimitBytes: getHeapStatistics().heap_size_limit });
