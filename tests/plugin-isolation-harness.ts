/**
 * Test harness for the P25 isolated plugin realm: a REAL Node worker_threads
 * transport running the exact shipped bootstrap source (realm-bootstrap.ts),
 * plus a loopback transport for host-protocol unit tests. Not a test file.
 */
import { Worker } from 'node:worker_threads';
import { REALM_BOOTSTRAP_SOURCE } from '../src/app/plugin-isolation/realm-bootstrap';
import type { RealmTransport } from '../src/app/plugin-isolation/host';

/** A real separate realm: a worker thread whose only input is the bootstrap. */
export function nodeWorkerTransport(): RealmTransport & { worker: Worker } {
  const worker = new Worker(REALM_BOOTSTRAP_SOURCE, { eval: true });
  worker.unref();
  return {
    worker,
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
  handshake(): { session: string; realmNonce: string; hostNonce: string } {
    return this.inbox[0] as { session: string; realmNonce: string; hostNonce: string };
  }
}
