/**
 * P25 plugin capability isolation — browser/Electron realm transport.
 *
 * Creates a dedicated Worker from the bundled realm-worker entry. The worker
 * has no DOM, no `window.jcad` bridge and no localStorage by construction;
 * this transport is the realm's only channel.
 *
 * NOTE (docs/PLUGIN-ISOLATION.md §6): in the packaged Electron renderer this
 * worker is served under the main process's worker CSP (script-src 'self'
 * 'wasm-unsafe-eval'), which — per the lead's CSP ruling (2026-10-21) —
 * refuses the bootstrap's plugin-body string evaluation: a worker plugin
 * fails closed at load there until the CSP hosting amendment
 * (reviews/DRAFT-AMENDMENT-P25-CSP-HOSTING.md) lands. Verified in the real
 * Electron runtime by scripts/e2e-plugin-csp.mjs.
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
