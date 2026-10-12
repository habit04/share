/** Bounded, shell-free execution of the bundled DWG writer. Process exit is the stop acknowledgment. */
const { spawn } = require('node:child_process');

const MAX_LOG_BYTES = 1024 * 1024;
const STOP_TIMEOUT_MS = 5_000;

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, spawn?: typeof spawn, stopTimeoutMs?: number, checkLimits?: () => Promise<void>, limitIntervalMs?: number }} [opts]
 * @returns {Promise<string>}
 */
function runBoundedWriter(executable, args, opts = {}) {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new Error('DWG export canceled.'));
    let child;
    try {
      child = (opts.spawn || spawn)(executable, args, { cwd: opts.cwd, env: opts.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { reject(error); return; }
    const chunks = [];
    let bytes = 0;
    let failure = null;
    let settled = false;
    let checking = false;
    let stopTimer = null;
    const finish = (error, log) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(monitor);
      if (stopTimer) clearTimeout(stopTimer);
      opts.signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(log);
    };
    const stop = (error) => {
      if (settled || failure) return;
      failure = error;
      stopTimer = setTimeout(() => {
        const failed = Object.assign(new Error('The DWG writer could not be stopped. Restart JCad before another DWG export.'), { code: 'DWG_STOP_UNCONFIRMED' });
        finish(failed);
      }, opts.stopTimeoutMs ?? STOP_TIMEOUT_MS);
      // The verified helper has no shell or descendant processes. On Windows kill terminates
      // this exact child handle; never run taskkill against a potentially reused numeric PID.
      try { child.kill('SIGKILL'); } catch { /* Wait for close even if kill throws. */ }
    };
    const abort = () => stop(new Error('DWG export canceled.'));
    const timer = setTimeout(() => stop(new Error('The DWG writer timed out. The destination was not changed.')), opts.timeoutMs ?? 60_000);
    const monitor = setInterval(async () => {
      if (!opts.checkLimits || checking || settled || failure) return;
      checking = true;
      try { await opts.checkLimits(); } catch (error) { stop(error); } finally { checking = false; }
    }, opts.limitIntervalMs ?? 100);
    const collect = (chunk) => {
      if (settled || failure) return;
      bytes += chunk.length;
      if (bytes > (opts.maxBytes ?? MAX_LOG_BYTES)) stop(new Error('The DWG writer produced too much diagnostic output.'));
      else chunks.push(Buffer.from(chunk));
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.once('error', (error) => {
      // A failed spawn has no process to wait for. Errors after spawn are not proof of exit.
      if (!child.pid) finish(error);
      else stop(error);
    });
    child.once('close', (code, signal) => {
      if (failure) return finish(failure);
      if (code !== 0 || signal) return finish(Object.assign(new Error('The DWG writer could not finish the export. The destination was not changed.'), { code: 'DWG_WRITER_EXIT' }));
      finish(null, Buffer.concat(chunks, bytes).toString('utf8'));
    });
    opts.signal?.addEventListener('abort', abort, { once: true });
    if (opts.signal?.aborted) abort();
  });
}

module.exports = { runBoundedWriter, MAX_LOG_BYTES, STOP_TIMEOUT_MS };
