// Failure-only observations for the owned origin E2E process/profile. No launch or retry.
import { closeSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// Observe only this freshly created test profile and its owned Electron child.
// No logging environment, application timeout, retry or preference assertion changes.
/** @param {import('playwright').ElectronApplication} app
 * @param {{profile: string, output?: string, launch: number}} options */
export function originFailureDiagnostics(app, { profile, output, launch }) {
  if (!Number.isInteger(launch) || launch < 0 || launch > 2) throw new Error('Invalid origin diagnostic launch index');
  let child;
  try { child = app.process(); } catch { /* Main-process unavailability is itself captured below. */ }
  let stdout = '', stderr = '';
  /** @type {Record<string, unknown>[]} */
  const events = [];
  /** @type {(() => void)[]} */
  const detach = [];
  const add = (kind, detail = {}) => {
    events.push({ at: new Date().toISOString(), kind, ...detail });
    if (events.length > 64) events.shift();
  };
  const tail = (value) => Buffer.isBuffer(value) ? value.subarray(-16_384).toString('utf8') : String(value).slice(-16_384);
  const onStdout = (value) => { stdout = (stdout + tail(value)).slice(-16_384); };
  const onStderr = (value) => { stderr = (stderr + tail(value)).slice(-16_384); };
  child?.stdout?.on('data', onStdout); child?.stderr?.on('data', onStderr);
  const onExit = (code, signal) => add('process-exit', { code, signal });
  child?.on('exit', onExit);
  /** @type {Set<import('playwright').Page>} */
  const tracked = new Set();
  /** Live CDP target snapshots, taken while windows exist (rounds 2-3, see
   * probeTargets): a bounded array (max 16), one entry per probed window, each
   * with its `at` time and the probing page's url — round 2 kept only the
   * latest snapshot, so the main window's probe overwrote the migration
   * window's. @type {{ at: string, pageUrl: string, targets: Record<string, unknown>[] }[]} */
  const targetSnapshots = [];
  /** Live CDP target probe (PR23 ASAR diagnosis item C, redesigned in round 2).
   * Round 1 probed at capture time, which is dead on the real runtime:
   * newCDPSession() with no page argument throws ('page: expected Page or
   * Frame'), and by capture time the migration window is already gone. This
   * probe instead runs when a window appears — while that window, and any
   * hidden migration window alongside it, still exists — opens a session on
   * the live page, and asks for ALL targets, so the snapshot shows every
   * window's type/url/attach state at that moment. The Debugger.paused signal
   * is dropped: enabling the debugger perturbs the very pause state under
   * observation, and attachment is already in the target list. Best-effort,
   * bounded at the same 2000ms discipline as mainState; never throws. */
  async function probeTargets(page) {
    const probe = (async () => {
      const session = await (/** @type {any} */ (app)).context().newCDPSession(page);
      try {
        const { targetInfos } = await session.send('Target.getTargets');
        return (targetInfos ?? []).slice(0, 16).map((info) => ({
          type: String(info?.type ?? ''), url: String(info?.url ?? '').slice(0, 512),
          attached: Boolean(info?.attached), targetId: String(info?.targetId ?? '').slice(0, 64),
        }));
      } finally { await session.detach().catch(() => {}); }
    })();
    let timer;
    try {
      const targets = await Promise.race([probe, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Target probe exceeded its 2000ms bound')), 2_000); })]);
      let pageUrl = '<unavailable>';
      try { pageUrl = page.url().slice(0, 512); } catch { /* keep unavailable */ }
      targetSnapshots.push({ at: new Date().toISOString(), pageUrl, targets });
      if (targetSnapshots.length > 16) targetSnapshots.shift();
    } catch (error) {
      add('target-probe-unavailable', { error: String(error).slice(0, 512) });
    } finally { clearTimeout(timer); }
  }
  /** @param {import('playwright').Page} page */
  const track = (page) => {
    if (tracked.has(page) || tracked.size >= 16) return;
    tracked.add(page);
    const url = () => { try { return page.url().slice(0, 512); } catch { return '<unavailable>'; } };
    add('window', { url: url(), closed: page.isClosed() });
    const onNavigate = (frame) => { if (frame === page.mainFrame()) add('navigate', { url: url() }); };
    const onCrash = () => add('page-crash', { url: url() });
    const onClose = () => add('page-close', { url: url() });
    page.on('framenavigated', onNavigate); page.on('crash', onCrash); page.on('close', onClose);
    detach.push(() => { page.off('framenavigated', onNavigate); page.off('crash', onCrash); page.off('close', onClose); });
    void probeTargets(page);
  };
  const observe = (page) => { try { track(page); } catch (error) { add('window-observer-unavailable', { error: String(error).slice(0, 512) }); } };
  try { app.on('window', observe); for (const page of app.windows().slice(0, 16)) observe(page); }
  catch (error) { add('window-list-unavailable', { error: String(error).slice(0, 512) }); }
  /** A diagnostic RPC is best effort; it never extends the 60s application-window assertion. */
  async function mainState() {
    let timer;
    try {
      return await Promise.race([
        app.evaluate(({ app: main, BrowserWindow }) => ({
          ready: main.isReady(), packaged: main.isPackaged,
          windows: BrowserWindow.getAllWindows().slice(0, 16).map((window) => {
            if (window.isDestroyed()) return { id: window.id, destroyed: true };
            const contents = window.webContents;
            return { id: window.id, destroyed: false, visible: window.isVisible(),
              contentsDestroyed: contents.isDestroyed(),
              ...(contents.isDestroyed() ? {} : { url: contents.getURL().slice(0, 512),
                loading: contents.isLoading(), loadingMainFrame: contents.isLoadingMainFrame(), crashed: contents.isCrashed() }) };
          }),
        })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diagnostic main-process RPC did not settle in 2000ms.')), 2_000); }),
      ]);
    } catch (error) { return { unavailable: String(error).slice(0, 2_048) }; }
    finally { clearTimeout(timer); }
  }
  /** Fixed-size reads only, from named files directly under the owned test profile. */
  function profileState() {
    /** @type {Record<string, unknown>[]} */
    const inventory = [];
    let dir;
    try {
      dir = opendirSync(profile);
      for (let count = 0; count < 64; count++) {
        const entry = dir.readSync(); if (!entry) break;
        inventory.push({ name: entry.name.slice(0, 255), directory: entry.isDirectory(), file: entry.isFile(), symbolicLink: entry.isSymbolicLink() });
      }
    } catch (error) { inventory.push({ unavailable: String(error).slice(0, 1024) }); }
    finally { if (dir) { try { dir.closeSync(); } catch { /* Best-effort diagnostic only. */ } } }
    const selected = {};
    for (const name of ['renderer-origin-migrated', 'renderer-preferences.json', 'error.log']) {
      const file = join(profile, name);
      let descriptor;
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) { selected[name] = { refused: 'Not a regular file' }; continue; }
        const limit = name === 'renderer-preferences.json' ? 65_536 : name === 'error.log' ? 16_384 : 64;
        descriptor = openSync(file, 'r');
        const bytes = Buffer.alloc(Math.min(stat.size, limit));
        const read = readSync(descriptor, bytes, 0, bytes.length, name === 'error.log' ? Math.max(0, stat.size - bytes.length) : 0);
        const text = bytes.subarray(0, read).toString('utf8');
        const metadata = { bytes: stat.size, modifiedUtc: stat.mtime.toISOString(), truncated: stat.size > limit };
        if (name === 'renderer-preferences.json') {
          if (stat.size > limit) selected[name] = { ...metadata, omitted: 'Checkpoint exceeds diagnostic read cap' };
          else {
            const values = JSON.parse(text);
            selected[name] = { ...metadata, testValues: Object.fromEntries(['jcad-origin-test', 'jcad-origin-deleted-test', 'jcad-origin-migrated']
              .map((key) => [key, typeof values?.[key] === 'string' ? values[key].slice(0, 1_024) : null])) };
          }
        } else selected[name] = { ...metadata, text };
      } catch (error) { selected[name] = { unavailable: String(error).slice(0, 1_024) }; }
      finally { if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* Best-effort diagnostic only. */ } } }
    }
    return { inventory, inventoryLimit: 64, selected };
  }
  return {
    async capture(error) {
      try {
        const out = output;
        if (!out) { console.error('Origin failure diagnostics require JCAD_E2E_OUT; original failure retained.'); return; }
        const state = await mainState();
        const cdpTargets = targetSnapshots.length > 0 ? targetSnapshots : { unavailable: 'No live target snapshot was recorded' };
        const diagnostic = { kind: 'Failure-only origin E2E observation; no cause inferred', launch: launch + 1,
          at: new Date().toISOString(), failure: String(error?.stack ?? error).slice(0, 4_096),
          process: child ? { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, killed: child.killed } : { unavailable: true },
          windows: [...tracked].map((page) => {
            try { return { url: page.url().slice(0, 512), closed: page.isClosed() }; }
            catch (error) { return { unavailable: String(error).slice(0, 1024) }; }
          }),
          events, main: state, cdpTargets, profile: profileState(), stdoutTail: stdout, stderrTail: stderr };
        mkdirSync(out, { recursive: true });
        const artifactFile = join(resolve(out), `origin-failure-launch-${launch + 1}.json`);
        if (dirname(artifactFile) !== resolve(out)) throw new Error('Origin diagnostic output escaped its artifact directory');
        const text = JSON.stringify(diagnostic, null, 2);
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Origin diagnostics exceeded the 1MiB output cap');
        writeFileSync(artifactFile, text, { flag: 'wx' });
        console.error(`Origin failure diagnostics: ${artifactFile}`);
      } catch (diagnosticError) { console.error(`Origin failure diagnostics unavailable: ${String(diagnosticError).slice(0, 2_048)}`); }
    },
    stop() {
      try { app.off('window', observe); } catch { /* Observation cleanup must not replace the original failure. */ } child?.off('exit', onExit);
      try { child?.stdout?.off('data', onStdout); child?.stderr?.off('data', onStderr); } catch { /* Preserve original failure. */ }
      for (const remove of detach) { try { remove(); } catch { /* Preserve original failure. */ } }
    },
  };
}
