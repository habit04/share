// Verifies the experimental 3D kernel's security controls in the real Electron runtime
// (docs/SECURITY-REVIEW.md E-19 / E-20, docs/3D-PACKAGED-TEST.md):
//   - the Manifold worker runs a Boolean (union of two half-overlapping unit cubes = 1.5) in 3D mode;
//   - E-19: the worker script response carries the restrictive worker CSP header
//     (electron/renderer-origin.cjs WORKER_CSP) and the page and its main script do not; a remote
//     fetch() and import() from inside the worker raise CSP violations; the renderer page itself
//     still refuses WebAssembly compilation (its meta CSP is unchanged);
//   - E-20: a worker allocation driven past 1 GiB of WebAssembly memory is refused with the
//     'memory-limit' KernelError ("The 3D kernel reached its 1 GiB memory limit; ..."), the worker
//     is replaced and a follow-up Boolean succeeds; the renderer stays responsive.
//
//   npm run build && npm run e2e:3d-security                        the development build (electron . on dist/)
//   npm run e2e:3d-security -- --packaged "<path to JCad Electrical.exe>"
//                                                                  an unpacked test build, e.g.
//                                                                  release-test-no-dwg/win-unpacked/JCad Electrical.exe
//                                                                  (npm run dist:test:no-dwg) or release-test/... (npm run dist:test)
//
// The probes use the kernel's test hooks, which exist only when the main process gets
// JCAD_3D_TEST_HOOKS=1 (set here) in a build that allows inspection (development, or the dedicated
// test build); an exact shipping executable refuses inspection, so it cannot be driven by this script.
// A private profile is used and deleted. JCAD_3D_SECURITY_OUT=<file> writes the results as JSON.
import { _electron as electron } from 'playwright';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applicationWindow } from './electron-window.mjs';
import { verifyExecutableFuses } from './electron-fuse-policy.mjs';

const repo = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
/** @type {{ WORKER_CSP: string }} */
const { WORKER_CSP } = require('../electron/renderer-origin.cjs');
const LIMIT_MESSAGE = 'The 3D kernel reached its 1 GiB memory limit; the operation was abandoned and the model is unchanged.';
const LIMIT_PAGES = 16_384;

const packagedArg = process.argv.indexOf('--packaged');
const executable = packagedArg >= 0 ? process.argv[packagedArg + 1] : process.env.JCAD_E2E_EXECUTABLE || '';
if (packagedArg >= 0 && !executable) {
  console.error('usage: node scripts/e2e-3d-security.mjs [--packaged <path to the application executable>]');
  process.exit(2);
}
if (executable && !existsSync(executable)) {
  console.error(`packaged executable not found: ${executable}`);
  process.exit(2);
}
if (!executable && !existsSync(join(repo, 'dist', 'index.html'))) {
  console.error('dist/index.html not found: run `npm run build` first.');
  process.exit(2);
}

/** @type {Array<{ ok: boolean, what: string, detail?: unknown }>} */
const results = [];
const check = (ok, what, detail) => {
  results.push({ ok: !!ok, what, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail === undefined || ok ? '' : `: ${JSON.stringify(detail)}`}`);
};

if (executable) {
  // Only a build with inspection enabled can be driven (the dedicated test build).
  const fuses = await verifyExecutableFuses(executable, 'test').catch((err) => ({ error: String(err.message || err) }));
  check(!('error' in fuses), 'the executable is an inspection-enabled test build (fuses)', fuses);
  if ('error' in fuses) process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'jcad-3d-security-'));
/** @type {Record<string, string>} */
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1', JCAD_3D_TEST_HOOKS: '1' };
delete env.VITE_DEV_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;
const args = executable ? [`--user-data-dir=${profile}`] : ['.', `--user-data-dir=${profile}`];
if (process.platform === 'linux') args.push('--no-sandbox');

const hardTimeout = setTimeout(() => { console.error('e2e-3d-security: timed out after 5 minutes'); process.exit(1); }, 5 * 60 * 1000);
console.log(executable ? `e2e-3d-security: packaged application ${executable}` : 'e2e-3d-security: development build (electron . on dist/)');
const app = await electron.launch(executable ? { executablePath: executable, args, env, timeout: 90_000 } : { args, cwd: repo, env, timeout: 60_000 });
const pageErrors = [];
try {
  let page = await applicationWindow(app);
  page.on('pageerror', (e) => pageErrors.push(`page error: ${e.message}`));
  await page.waitForFunction(() => Boolean(/** @type {any} */ (window).editor), null, { timeout: 60_000 });
  const url = page.url();
  check(url === 'jcad://app/index.html?jcad3dTestHooks=1', 'the main window loads jcad://app/index.html with the 3D test hooks requested', url);

  // Turn the experimental flag on (read at start-up) and reload the page.
  const flagged = await page.evaluate(() => /** @type {any} */ (window).editor.settings.experimental3d === true);
  if (!flagged) {
    await page.evaluate(() => {
      const key = 'jcad.settings.v2';
      const cur = JSON.parse(localStorage.getItem(key) || '{}');
      localStorage.setItem(key, JSON.stringify({ ...cur, experimental3d: true }));
    });
    await page.reload();
    page = await applicationWindow(app);
    await page.waitForFunction(() => Boolean(/** @type {any} */ (window).editor), null, { timeout: 60_000 });
  }
  const handle = await page.waitForFunction(() => Boolean(/** @type {any} */ (window).jcad3d), null, { timeout: 30_000 }).then(() => true, () => false);
  check(handle, 'experimental 3D is on (window.jcad3d exists)');
  if (!handle) throw new Error('experimental 3D did not start');

  // 3D mode.
  await page.evaluate(() => void (/** @type {any} */ (window).editor.runCommand('3DMODE')));
  const active = await page.waitForFunction(() => /** @type {any} */ (window).jcad3d.active === true, null, { timeout: 15_000 }).then(() => true, () => false);
  check(active, '3DMODE enters 3D mode');

  // A Boolean through the worker.
  const union = await page.evaluate(async () => {
    const c = /** @type {any} */ (window).jcad3d;
    const box = (x) => ({
      positions: [x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0, x, 0, 1, x + 1, 0, 1, x + 1, 1, 1, x, 1, 1],
      indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
    });
    const volume = (m) => {
      let v = 0;
      for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, d] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]].map((i) => m.positions.slice(3 * i, 3 * i + 3));
        v += (a[0] * (b[1] * d[2] - b[2] * d[1]) - a[1] * (b[0] * d[2] - b[2] * d[0]) + a[2] * (b[0] * d[1] - b[1] * d[0])) / 6;
      }
      return v;
    };
    const k = c.kernel();
    const status = await k.ready();
    try {
      const m = await k.boolean('union', box(0), box(0.5));
      return { name: k.name, status, volume: volume(m), workers: k.workersCreated };
    } catch (err) {
      return { name: k.name, status, error: `${err.code}: ${err.message}` };
    }
  });
  check(/\(worker\)$/.test(union.name) && union.status.available === true, 'the kernel is the Manifold worker and reports ready', union);
  check(typeof union.volume === 'number' && Math.abs(union.volume - 1.5) < 1e-9, 'a union of two half-overlapping unit cubes through the worker has volume 1.5', union);

  // E-19: CSP inside the worker, on the worker response, and the unchanged page policy.
  const csp = await page.evaluate(async () => {
    const k = /** @type {any} */ (window).jcad3d.kernel();
    try { return await k.probe({ op: 'probe-csp' }); } catch (err) { return { error: `${err.code}: ${err.message}` }; }
  });
  check(typeof csp.url === 'string' && /^jcad:\/\/app\/assets\/worker\/manifold\.worker-[A-Za-z0-9_-]+\.js$/.test(csp.url), 'the worker script is served from jcad://app/assets/worker/', csp);
  const violations = Array.isArray(csp.violations) ? csp.violations : [];
  check(csp.fetchBlocked === true && violations.some((v) => /^connect-src https:\/\/jcad-csp-probe\.invalid\/fetch/.test(v)), 'a fetch() of an external URL from inside the worker is blocked by CSP (connect-src violation)', csp);
  check(csp.importBlocked === true && violations.some((v) => /^script-src(-elem)? https:\/\/jcad-csp-probe\.invalid\/import\.js/.test(v)), 'an import() of an external script from inside the worker is blocked by CSP (script-src violation)', csp);
  const headers = await page.evaluate(async (workerUrl) => {
    const get = async (u) => { const r = await fetch(u); return { url: u, status: r.status, type: r.headers.get('content-type'), csp: r.headers.get('content-security-policy') }; };
    const main = /** @type {HTMLScriptElement | null} */ (document.querySelector('script[type="module"][src]'));
    return { worker: await get(workerUrl), page: await get('jcad://app/index.html'), main: main ? await get(main.src) : null };
  }, csp.url ?? '');
  check(headers.worker.status === 200 && headers.worker.csp === WORKER_CSP, 'the worker script response carries the worker CSP header', headers.worker);
  check(/javascript/.test(headers.worker.type ?? ''), 'the worker script keeps a JavaScript content type', headers.worker);
  // Aliases of the worker file (another letter case, the Windows 8.3 short name): either nothing is
  // served (inside the ASAR archive) or the served worker carries the CSP (plain files on disk).
  const workerFile = String(csp.url ?? '').split('/').pop() ?? '';
  const aliases = [String(csp.url ?? '').replace('/assets/worker/', '/ASSETS/Worker/').replace(workerFile, workerFile.toUpperCase()), String(csp.url ?? '').replace(workerFile, `${workerFile.slice(0, 6).toUpperCase()}~1.JS`)];
  const aliased = await page.evaluate(async (urls) => Promise.all(urls.map(async (u) => {
    try { const r = await fetch(u); return { url: u, status: r.status, csp: r.headers.get('content-security-policy') }; } catch (err) { return { url: u, status: 0, error: String(err) }; }
  })), aliases);
  check(aliased.every((r) => r.status !== 200 || r.csp === WORKER_CSP), 'aliases of the worker file (letter case, 8.3 short name) are refused or carry the worker CSP', aliased);
  check(headers.page.status === 200 && headers.page.csp === null, 'the page response carries no CSP header (its meta policy applies)', headers.page);
  check(headers.main !== null && headers.main.status === 200 && headers.main.csp === null, 'the main renderer script response carries no CSP header', headers.main);
  const mainWasm = await page.evaluate(async () => {
    try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return 'compiled'; } catch (err) { return String(err); }
  });
  check(mainWasm !== 'compiled', 'the renderer page still refuses WebAssembly compilation (renderer CSP unchanged)', mainWasm);

  // E-20: memory cap.
  const under = await page.evaluate(async () => {
    const k = /** @type {any} */ (window).jcad3d.kernel();
    try { return await k.probe({ op: 'probe-memory', pages: 2048 }, { timeoutMs: 120_000 }); } catch (err) { return { error: `${err.code}: ${err.message}` }; }
  });
  check(typeof under.reachedBytes === 'number' && under.reachedBytes >= 128 * 1024 * 1024 && under.reachedBytes <= 2 ** 30, 'the worker may grow its WebAssembly memory to 128 MiB (under the limit)', under);
  const over = await page.evaluate(async (pages) => {
    const k = /** @type {any} */ (window).jcad3d.kernel();
    const before = k.workersCreated;
    const t0 = performance.now();
    try {
      const r = await k.probe({ op: 'probe-memory', pages }, { timeoutMs: 120_000 });
      return { resolved: r, before, after: k.workersCreated };
    } catch (err) {
      return { code: err.code, message: err.message, ms: Math.round(performance.now() - t0), before, after: k.workersCreated };
    }
  }, LIMIT_PAGES + 1);
  check(over.code === 'memory-limit' && over.message === LIMIT_MESSAGE, 'growth past 1 GiB inside the worker is refused with the memory-limit KernelError', over);
  const follow = await page.evaluate(async () => {
    const k = /** @type {any} */ (window).jcad3d.kernel();
    const box = (x) => ({
      positions: [x, 0, 0, x + 1, 0, 0, x + 1, 1, 0, x, 1, 0, x, 0, 1, x + 1, 0, 1, x + 1, 1, 1, x, 1, 1],
      indices: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
    });
    try {
      const m = await k.boolean('subtract', box(0), box(0.5));
      return { triangles: m.indices.length / 3, workers: k.workersCreated, status: await k.ready() };
    } catch (err) {
      return { error: `${err.code}: ${err.message}`, workers: k.workersCreated };
    }
  });
  check(follow.triangles > 0 && follow.status?.available === true && follow.workers === over.before + 1, 'after the refusal the worker is replaced once and a follow-up Boolean succeeds', { over, follow });
  const responsive = await page.evaluate(() => typeof /** @type {any} */ (window).editor.runCommand === 'function' && document.visibilityState !== undefined);
  check(responsive, 'the renderer stays responsive');

  await page.evaluate(() => void (/** @type {any} */ (window).editor.runCommand('3DMODE')));
  check(pageErrors.length === 0, 'no page errors', pageErrors);
} catch (err) {
  check(false, 'the run completed', String(err?.stack || err));
} finally {
  clearTimeout(hardTimeout);
  await Promise.race([app.evaluate(({ app: main }) => main.exit(0)).catch(() => {}), new Promise((r) => setTimeout(r, 5_000))]);
  try { await app.close(); } catch { /* already gone */ }
  if (profile.startsWith(join(tmpdir(), 'jcad-3d-security-'))) rmSync(profile, { recursive: true, force: true });
}

if (process.env.JCAD_3D_SECURITY_OUT) writeFileSync(process.env.JCAD_3D_SECURITY_OUT, JSON.stringify({ executable: executable || null, platform: process.platform, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`e2e-3d-security: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
