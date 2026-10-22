/**
 * Test harness for the P25 isolated plugin realm: a REAL Node worker_threads
 * transport running the exact shipped bootstrap source (realm-bootstrap.ts),
 * plus a loopback transport for host-protocol unit tests. Not a test file.
 */
import { Worker } from 'node:worker_threads';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REALM_BOOTSTRAP_SOURCE } from '../src/app/plugin-isolation/realm-bootstrap';
import type { RealmTransport } from '../src/app/plugin-isolation/host';

/** A real separate realm: a worker thread whose only input is the bootstrap. */
export function nodeWorkerTransport(): RealmTransport & { worker: Worker } {
  const worker = new Worker(REALM_BOOTSTRAP_SOURCE, { eval: true });
  worker.unref();
  return {
    worker,
    moduleUrlFor: (code) => moduleUrlForBody(code),
    post: (msg) => {
      worker.postMessage(msg);
    },
    onMessage: (cb) => {
      worker.on('message', cb);
    },
    terminate: () => {
      void worker.terminate();
    },
  };
}

// ------------------------------------------------------------------ module entries (AMENDMENT-P25-CSP-HOSTING Part B4)
//
// The realm loads its entry as an ES module (Part B): the harness exercises
// that same module path in Node through file:// URLs — one realm path, not
// two. The temp module directory holds a `jcad.js` shim carrying exactly the
// one-line body the packaged path serves from main
// (electron/renderer-origin.cjs PLUGIN_REALM_JCAD_SHIM).

/** The jcad.js shim body, byte-identical to the one main serves (pinned in tests/plugin-realm-serving.test.ts). */
export const JCAD_SHIM_SOURCE = 'export default globalThis[Symbol.for("jcad.isolated.jcad")];';

let moduleDir: string | null = null;
let entrySeq = 0;
function ensureModuleDir(): string {
  if (!moduleDir) {
    moduleDir = mkdtempSync(join(tmpdir(), 'jcad-p25-modules-'));
    writeFileSync(join(moduleDir, 'jcad.js'), `${JCAD_SHIM_SOURCE}\n`);
  }
  return moduleDir;
}

/** Write module-authored entry text beside the jcad.js shim; return its file:// URL. */
export function moduleUrlForModuleText(text: string): string {
  const file = join(ensureModuleDir(), `entry-${++entrySeq}.mjs`);
  writeFileSync(file, text);
  return pathToFileURL(file).href;
}

/**
 * Wrap a body-authored plugin (the v1/v2 convention: `jcad` in scope,
 * top-level await allowed, a top-level `return` is the load report) as a
 * module entry: the wrapper imports the shim's proxy, runs the body in an
 * async scope with that proxy as its `jcad`, and default-exports the
 * report. This is a harness-side authoring adapter only — the realm itself
 * loads nothing but modules.
 */
export function moduleUrlForBody(code: string): string {
  return moduleUrlForModuleText(
    `import jcad from './jcad.js';\nconst __report = await (async (jcad) => {\n${code}\n})(jcad);\nexport default __report;\n`,
  );
}

/** The harness transport in its module form (Part B4): same worker, with the file:// module-URL hook. */
export function nodeWorkerModuleTransport(): RealmTransport & { worker: Worker } {
  return nodeWorkerTransport();
}

/**
 * Loopback transport: captures host->realm messages in `inbox`; the test acts
 * as the realm endpoint (it legitimately holds the handshake nonces, like a
 * real bootstrap would) and injects realm->host messages with `emit`.
 */
export class LoopbackTransport implements RealmTransport {
  readonly inbox: unknown[] = [];
  terminated = false;
  private cb: ((msg: unknown) => void) | null = null;

  post(msg: unknown): void {
    this.inbox.push(msg);
  }

  onMessage(cb: (msg: unknown) => void): void {
    this.cb = cb;
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(msg: unknown): void {
    this.cb?.(msg);
  }

  /** The handshake the host sent (first inbox message), typed loosely for tests. */
  handshake(): { session: string; realmNonce: string; hostNonce: string; moduleUrl: string } {
    return this.inbox[0] as { session: string; realmNonce: string; hostNonce: string; moduleUrl: string };
  }
}
