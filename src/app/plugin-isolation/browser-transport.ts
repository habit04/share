/**
 * P25 plugin capability isolation — browser/Electron realm transport.
 *
 * Creates a dedicated Worker from the bundled realm-worker entry. The worker
 * has no DOM, no `window.jcad` bridge and no localStorage by construction;
 * this transport is the realm's only channel.
 *
 * NOTE (docs/PLUGIN-ISOLATION.md §6): in the packaged Electron renderer this
 * worker is served under the main process's worker CSP (script-src 'self'
 * 'wasm-unsafe-eval'). Since AMENDMENT-P25-CSP-HOSTING landed, the realm
 * loads the plugin entry as a module — from the main-served plugin-realm
 * root in the packaged runtime, a blob:/file: module elsewhere — and the
 * bootstrap evaluates no strings, so worker plugins load under that CSP.
 * Verified in the real Electron runtime by scripts/e2e-plugin-csp.mjs.
 */
import type { RealmTransport } from './host';

export function browserWorkerTransport(): RealmTransport {
  const worker = new Worker(new URL('./realm-worker.ts', import.meta.url), { type: 'module' });
  return {
    post: (msg) => worker.postMessage(msg),
    onMessage: (cb) => {
      worker.onmessage = (ev: MessageEvent) => cb(ev.data);
    },
    terminate: () => worker.terminate(),
  };
}
