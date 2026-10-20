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
 * Close a Playwright Electron application within a bound, tree-killing by pid
 * on expiry. A wedged main process (PR23 ASAR diagnosis: the modal migration
 * error dialog) leaves app.close() pending indefinitely; the caller learns the
 * close was unclean from the false return instead of hanging. Never throws.
 * @param {{ close(): Promise<unknown>, process(): { pid?: number } }} app
 * @param {number} [timeout]
 * @returns {Promise<boolean>} true when the application closed within the bound.
 */
export async function closeApplication(app, timeout = 15_000) {
  let pid;
  try { pid = app.process()?.pid; } catch { pid = undefined; }
  const closed = Promise.resolve().then(() => app.close()).then(() => true, () => false);
  const settle = (ms) => new Promise((done) => setTimeout(() => done(false), ms));
  if (await Promise.race([closed, settle(timeout)])) return true;
  if (pid) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
    } else {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  // Give the close a brief chance to settle after the kill; never block on it.
  await Promise.race([closed, settle(5_000)]);
  return false;
}
