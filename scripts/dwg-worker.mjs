/**
 * Worker thread that reads DWG files for the Electron main process (electron/dwg-host.cjs).
 *
 * LibreDWG (WebAssembly) parses synchronously; in the main process a large file would stall the
 * event loop and with it every IPC reply, menu and window event. Here it runs on its own thread,
 * and the main process can cancel a read by terminating the worker.
 *
 * Protocol: the worker posts { ready: true } once the reader module is loaded; then for each
 * { id, bytes: ArrayBuffer, kind } it posts { id, ok: true, payload, version } or
 * { id, ok: false, message }.
 */
import { parentPort } from 'node:worker_threads';
import { readDwgPayload, resetLibreDwg } from './dwg-reader.mjs';

if (!parentPort) throw new Error('scripts/dwg-worker.mjs must run as a worker thread');
const port = parentPort;
/** Test hook (scripts/e2e-electron.mjs): hold every read this long so Cancel can be exercised. */
const testDelayMs = Math.min(Number(process.env.JCAD_DWG_TEST_DELAY_MS) || 0, 60_000);

port.on('message', async (/** @type {{ id: number, bytes: ArrayBuffer, kind?: 'dwg' | 'dxf' }} */ msg) => {
  try {
    if (testDelayMs > 0) await new Promise((r) => setTimeout(r, testDelayMs));
    const { payload, version } = await readDwgPayload(new Uint8Array(msg.bytes), msg.kind ?? 'dwg');
    port.postMessage({ id: msg.id, ok: true, payload, version });
  } catch (err) {
    // A WebAssembly abort leaves the module unusable: start fresh for the next read.
    void resetLibreDwg();
    port.postMessage({ id: msg.id, ok: false, message: String((err && err.message) || err) });
  }
});
port.postMessage({ ready: true });
