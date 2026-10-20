/**
 * closeApplication (scripts/electron-window.mjs) — the bounded cleanup close the
 * packaged e2e drivers use (PR23 ASAR fix, rounds 1-4). These cases pin the
 * outcome contract the lead's gate previously proved only with a probe script:
 * 'closed'; 'rejected' with the process still alive, so it is killed (and its
 * exit waited for); 'rejected' after the process already exited, so the pid is
 * NOT killed (it may have been reused); 'timeout', so the tree is killed; and a
 * timeout with no process handle, which still reports 'timeout'.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeApplication } from '../scripts/electron-window.mjs';

type FakeChild = EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null };
type App = Parameters<typeof closeApplication>[0];

function fakeChild(pid: number): FakeChild {
  return Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null });
}

/** An app double whose close behaviour and process handle the case controls.
 * process.kill is spied: a recorded kill makes the child exit 5 ms later (and
 * settles the hanging close, as a dying process would), so no test waits on a
 * real timer bound. */
function harness(options: { close: () => Promise<void>; child?: FakeChild; processThrows?: boolean; onKilled?: () => void }) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const kills: [number, unknown][] = [];
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: unknown) => {
    kills.push([pid, signal]);
    if (options.child) setTimeout(() => {
      options.child!.exitCode = 0;
      options.child!.emit('exit', 0, null);
      options.onKilled?.();
    }, 5);
    return true;
  }) as typeof process.kill);
  const app = {
    close: options.close,
    process: () => {
      if (options.processThrows) throw new Error('No process handle');
      return options.child;
    },
  } as unknown as App;
  return { app, kills };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('closeApplication outcome contract', () => {
  it('reports closed when the close settles, and kills nothing', async () => {
    const child = fakeChild(4242);
    const { app, kills } = harness({ close: async () => {}, child });
    const result = await closeApplication(app, 1_000);
    expect(result.outcome).toBe('closed');
    expect(kills).toEqual([]);
  });

  it('reports rejected and kills a process that is still alive', async () => {
    const child = fakeChild(4243);
    const { app, kills } = harness({ close: async () => { throw new Error('Close was refused'); }, child });
    const result = await closeApplication(app, 1_000);
    expect(result.outcome).toBe('rejected');
    expect(kills).toEqual([[-4243, 'SIGKILL']]);
  });

  it('reports rejected without killing a process that already exited', async () => {
    const child = fakeChild(4244);
    child.exitCode = 0; // exited on its own: the pid may already have been reused
    const { app, kills } = harness({ close: async () => { throw new Error('Close was refused'); }, child });
    const result = await closeApplication(app, 1_000);
    expect(result.outcome).toBe('rejected');
    expect(kills).toEqual([]);
  });

  it('reports timeout and kills the tree when the close never settles', async () => {
    const child = fakeChild(4245);
    let settleClose: (() => void) | undefined;
    const hanging = new Promise<void>((resolve) => { settleClose = resolve; });
    const { app, kills } = harness({
      close: () => hanging, child, onKilled: () => settleClose!(),
    });
    // The close settles only as a consequence of the kill (onKilled), as the
    // real teardown would observe once the process is gone.
    const result = await closeApplication(app, 60);
    expect(result.outcome).toBe('timeout');
    expect(kills).toEqual([[-4245, 'SIGKILL']]);
  });

  it('reports timeout (not closed) when there is no process handle', async () => {
    const { app, kills } = harness({ close: () => new Promise<void>(() => {}), processThrows: true });
    const result = await closeApplication(app, 60);
    expect(result.outcome).toBe('timeout');
    expect(kills).toEqual([]);
  });
});
