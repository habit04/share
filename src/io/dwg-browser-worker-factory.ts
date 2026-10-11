export function createBrowserDwgWorker(): Worker {
  return new Worker(new URL('./dwg-browser-worker.ts', import.meta.url), { type: 'module' });
}
