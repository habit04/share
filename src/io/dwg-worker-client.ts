import type { DwgImportPayload } from './dwg';
export const MAX_BROWSER_DWG_BYTES = 128 * 1024 * 1024;
export const BROWSER_DWG_TIMEOUT_MS = 60_000;
type DwgResult = { payload: DwgImportPayload; version: string };
export interface DwgWorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer: Transferable[]): void;
  terminate(): void;
}

/** A fresh worker per read releases the WASM instance on success, error, timeout or cancellation. */
export function readDwgWithWorker(
  bytes: ArrayBuffer,
  createWorker: () => DwgWorkerLike,
  options: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number } = {},
): Promise<DwgResult> {
  const { signal, timeoutMs = BROWSER_DWG_TIMEOUT_MS, maxBytes = MAX_BROWSER_DWG_BYTES } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) return Promise.reject(new Error('Invalid DWG resource limits.'));
  if (bytes.byteLength > maxBytes) return Promise.reject(new Error('DWG exceeds the supported size limit.'));
  if (signal?.aborted) return Promise.reject(new DOMException('Open cancelled', 'AbortError'));
  return new Promise((resolve, reject) => {
    let worker: DwgWorkerLike;
    try { worker = createWorker(); } catch (error) { reject(error); return; }
    let settled = false;
    const finish = (error: unknown, result?: DwgResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new DOMException('Open cancelled', 'AbortError'));
    const timer = setTimeout(() => finish(new Error('DWG parsing exceeded its time limit.')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event) => {
      const result = event.data as DwgResult & { ok?: boolean; message?: string };
      if (result.ok) finish(null, { payload: result.payload, version: result.version });
      else finish(new Error(result.message || 'The DWG reader failed.'));
    };
    worker.onerror = (event) => finish(new Error(event.message || 'The DWG reader stopped unexpectedly.'));
    worker.onmessageerror = () => finish(new Error('The DWG reader returned an unreadable result.'));
    try {
      const copy = bytes.slice(0);
      worker.postMessage({ bytes: copy }, [copy]);
    } catch (error) { finish(error); }
  });
}
