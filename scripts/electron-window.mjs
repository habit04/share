import { spawnSync } from 'node:child_process';

/** Select the application page, excluding the short-lived preference migration window. */
export async function applicationWindow(app, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const page = app.windows().find((candidate) => !candidate.isClosed() && candidate.url().startsWith('jcad://app/index.html'));
    if (page) return page;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('The secure application window did not appear before the deadline.');
}

/**
 * Close a Playwright Electron application with a hard bound (PR23 ASAR diagnosis;
 * round 2: outcome contract, exit check, POSIX group kill).
 *
 * A wedged main process (for example one stuck behind a modal dialog) can leave
 * app.close() pending forever; in CI that once burned the whole shared step
 * budget in cleanup after the failure was already named. This helper races the
 * close against `timeout` and, on expiry, tree-kills the application process by
 * pid: taskkill /T /F on Windows; on POSIX a SIGKILL to the process GROUP
 * (kill(-pid)) — Playwright spawns the application detached on non-Windows
 * platforms precisely so the tree can be killed this way (playwright-core
 * process launcher: "detached: true makes child process a leader of a new
 * process group, making it possible to kill child process tree with
 * .kill(-pid)"). If the process has already exited on its own (exitCode or
 * signalCode set), the kill is skipped: the pid may already have been reused.
 *
 * Never throws. Resolves to { outcome, ms } — plus `error` for 'rejected' —
 * where outcome is 'closed' (the close settled, or the process is verifiably
 * gone), 'rejected' (app.close() rejected; a still-live process is killed
 * first, since an orphan would hold the profile), or 'timeout' (the bound was
 * exceeded; the tree is killed when a handle exists, and a handle-less
 * timeout still reports 'timeout'). The measured close duration is logged on
 * every call. A normal application close runs the product's close-time
 * preference checkpoint (its capture is bounded at 5 s inside a close flow
 * whose own waits run to 15 s), so success-path callers pass a 30 s bound;
 * failure-path teardown of a wedged process keeps 15 s.
 * @param {{ close(): Promise<unknown>, process(): { pid?: number, exitCode?: number | null, signalCode?: string | null, once?: (event: string, listener: () => void) => void } }} app
 * @param {number} [timeout]
 * @returns {Promise<{ outcome: 'closed' | 'rejected' | 'timeout', ms: number, error?: unknown, detail?: string }>}
 */
export async function closeApplication(app, timeout = 15_000) {
  const started = Date.now();
  const done = (outcome, extra = {}) => {
    const ms = Date.now() - started;
    console.log(`closeApplication: ${outcome} in ${ms} ms (bound ${timeout} ms).`);
    return { outcome, ms, ...extra };
  };
  if (!app) return done('closed');
  let closeError;
  const settled = Promise.resolve()
    .then(() => app.close())
    .then(() => 'closed', (error) => { closeError = error; return 'rejected'; });
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), timeout); });
  const first = await Promise.race([settled, expired]);
  clearTimeout(timer);
  if (first === 'closed') return done('closed');
  let child = null;
  try { child = app.process(); } catch { /* process handle unavailable */ }
  const pid = child && Number.isInteger(child.pid) ? child.pid : null;
  const alreadyExited = !!child && (child.exitCode !== null || child.signalCode !== null);
  const killTree = () => {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
      } else {
        process.kill(-pid, 'SIGKILL');
      }
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  };
  const settleBriefly = () => Promise.race([settled, new Promise((resolve) => { setTimeout(resolve, 5_000); })]);
  // Round 4: after a kill on the 'rejected' path, wait for the child's actual
  // 'exit' event (bounded at 5 s). Racing `settled` there proves nothing — it
  // already resolved when the close rejected, so the wait returned instantly
  // while the killed process was still dying.
  const waitForChildExit = () => new Promise((resolve) => {
    if (!child || typeof child.once !== 'function' || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  if (first === 'rejected') {
    // A rejected close can still leave a live process holding the profile
    // (round 3): kill it if it is still alive — never an already-exited pid,
    // which may have been reused — then report 'rejected' either way.
    if (pid !== null && !alreadyExited) { killTree(); await waitForChildExit(); }
    return done('rejected', { error: closeError });
  }
  // The bound was exceeded. With no process handle there is nothing to kill
  // and nothing proving the application gone: report 'timeout' (round 3).
  if (pid === null) return done('timeout', { detail: 'no process handle' });
  if (!alreadyExited) {
    killTree();
    // Brief settle race so the caller does not race a dying process tree.
    await settleBriefly();
    return done('timeout', { error: closeError });
  }
  // The process already exited on its own: the close's goal is met even
  // though app.close() never settled.
  return done('closed', { detail: 'process already exited' });
}
