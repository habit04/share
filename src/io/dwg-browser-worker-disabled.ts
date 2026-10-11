/** Vite substitutes this module in desktop builds so no browser WASM worker is emitted. */
export function createBrowserDwgWorker(): Worker {
  throw new Error('DWG files are opened by the desktop application in this build.');
}
