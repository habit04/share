// Verifies the lead's CSP ruling (2026-10-21) for P25 plugin capability
// isolation in the real Electron runtime:
//   NO 'unsafe-eval' anywhere in the packaged renderer, no widening of the
//   page CSP; the isolated realm lives in a dedicated worker served with the
//   path-scoped worker CSP (electron/renderer-origin.cjs WORKER_CSP:
//   script-src 'self' 'wasm-unsafe-eval', connect-src 'self', no DOM, no
//   preload bridge).
// Legs:
//   (1) page: eval / new Function are refused in the renderer page. NOTE on
//       method: Playwright's page.evaluate runs with inspector privilege —
//       string-evaluation calls made from inside it bypass the page CSP
//       (observed directly: they run, while the document-policy-bound
//       WebAssembly.compile from the same context is refused). Page eval is
//       therefore probed from REAL served page code: a probe script written
//       into dist/assets/ before launch (development mode) and loaded with a
//       script tag, so its calls are governed by the page's meta CSP. A
//       sealed packaged archive cannot gain a served file, so in packaged
//       modes that sub-leg is skipped with the reason recorded and the
//       meta policy's bytes are checked instead (they are the same bytes
//       the development build serves);
//   (2) serving: the realm worker asset is served from jcad://app/assets/
//       worker/ WITH the worker CSP header; the page and its main script
//       carry no CSP header (the page's meta policy is unchanged);
//   (3) plugin context: a worker-isolated plugin is loaded the packaged
//       way (AMENDMENT-P25-CSP-HOSTING): a probe package written into the
//       profile's plugins folder is served by the main process under
//       jcad://app/plugin-realm/<session>/ with the worker CSP, and the
//       realm worker is driven with a host handshake carrying the served
//       entry URL as a module — (a) eval and new Function are refused in
//       the plugin context, (b) the plugin still works (loads, registers
//       a command, and the command answers an RPC round trip). Serving
//       discipline is probed alongside: the entry carries WORKER_CSP, a
//       traversal fetch is refused, and an unserved session serves
//       nothing. All legs are expected GREEN since the amendment landed;
//       this script is its acceptance test.
//
//   npm run build && node scripts/e2e-plugin-csp.mjs                the development build (electron . on dist/)
//   node scripts/e2e-plugin-csp.mjs --packaged "<path to the test application executable>"
//   node scripts/e2e-plugin-csp.mjs --asar <path to app.asar>       packaged layout in the dev Electron binary
//
// A private profile is used and deleted. JCAD_PLUGIN_CSP_OUT=<file> writes the results as JSON.
import { _electron as electron } from 'playwright';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { applicationWindow, closeApplication } from './electron-window.mjs';
import { verifyExecutableFuses } from './electron-fuse-policy.mjs';

const repo = resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
/** @type {{ WORKER_CSP: string }} */
const { WORKER_CSP } = require('../electron/renderer-origin.cjs');

const packagedArg = process.argv.indexOf('--packaged');
const executable = packagedArg >= 0 ? process.argv[packagedArg + 1] : process.env.JCAD_E2E_EXECUTABLE || '';
const asarArg = process.argv.indexOf('--asar');
const asar = asarArg >= 0 ? process.argv[asarArg + 1] : '';
if ((packagedArg >= 0 && !executable) || (asarArg >= 0 && !asar) || (executable && asar)) {
  console.error('usage: node scripts/e2e-plugin-csp.mjs [--packaged <path to the application executable> | --asar <path to app.asar>]');
  process.exit(2);
}
if (asar && !existsSync(asar)) {
  console.error(`application archive not found: ${asar}`);
  process.exit(2);
}
if (executable && !existsSync(executable)) {
  console.error(`packaged executable not found: ${executable}`);
  process.exit(2);
}
if (!executable && !asar && !existsSync(join(repo, 'dist', 'index.html'))) {
  console.error('dist/index.html not found: run `npm run build` first.');
  process.exit(2);
}

// Locate the realm worker asset the same way the app serves it:
// assets/worker/realm-worker-<hash>.js inside the build / archive.
function realmWorkerAsset() {
  const pattern = /^realm-worker-[A-Za-z0-9_-]+\.js$/;
  if (!executable && !asar) {
    const dir = join(repo, 'dist', 'assets', 'worker');
    const hit = existsSync(dir) ? readdirSync(dir).find((n) => pattern.test(n)) : undefined;
    return hit ? `assets/worker/${hit}` : null;
  }
  const archive = asar || join(dirname(executable), process.platform === 'darwin' ? '../Resources/app.asar' : 'resources/app.asar');
  try {
    const asarApi = require('@electron/asar');
    const hit = asarApi.listPackage(archive).map((p) => p.replace(/\\/g, '/')).find((p) => pattern.test(p.split('/').pop() ?? '') && p.includes('assets/worker/'));
    return hit ? hit.replace(/^\//, '') : null;
  } catch {
    return null;
  }
}
const assetPath = realmWorkerAsset();

/** @type {Array<{ ok: boolean, what: string, detail?: unknown }>} */
const results = [];
/** @type {Array<{ what: string, reason: string }>} */
const skipped = [];
const check = (ok, what, detail) => {
  results.push({ ok: !!ok, what, ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail === undefined || ok ? '' : `: ${JSON.stringify(detail)}`}`);
};
const skip = (what, reason) => {
  skipped.push({ what, reason });
  console.log(`skip ${what}: ${reason}`);
};

if (executable) {
  const fuses = await verifyExecutableFuses(executable, 'test').catch((err) => ({ error: String(err.message || err) }));
  check(!('error' in fuses), 'the executable is an inspection-enabled test build (fuses)', fuses);
  if ('error' in fuses) process.exit(1);
}
check(assetPath !== null, 'the realm worker asset exists under assets/worker/', assetPath);

// Development mode only: the real-page-code probe, served from dist/assets/
// like any bundled script and loaded by the page with a script tag.
const pageProbeFile = !executable && !asar ? join(repo, 'dist', 'assets', 'csp-page-probe.js') : null;
if (pageProbeFile) {
  writeFileSync(pageProbeFile, `// e2e-plugin-csp page probe: real page code, governed by the page CSP.
(function () {
  var attempt = function (fn) { try { return 'ran:' + String(fn()); } catch (e) { return 'refused:' + e.name; } };
  window.__cspPageProbe = {
    eval: attempt(function () { return eval('40 + 2'); }),
    functionCtor: attempt(function () { return new Function('return 42')(); }),
    functionCall: attempt(function () { return Function('return 42')(); }),
  };
})();
`);
}

const profile = mkdtempSync(join(tmpdir(), 'jcad-plugin-csp-'));
/** @type {Record<string, string>} */
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
delete env.VITE_DEV_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;
const args = executable ? [`--user-data-dir=${profile}`] : [asar ? resolve(asar) : '.', `--user-data-dir=${profile}`];
if (process.platform === 'linux') args.push('--no-sandbox');

const hardTimeout = setTimeout(() => { console.error('e2e-plugin-csp: timed out after 5 minutes'); process.exit(1); }, 5 * 60 * 1000);
console.log(executable ? `e2e-plugin-csp: packaged application ${executable}` : asar ? `e2e-plugin-csp: packaged archive ${asar} in the development Electron binary` : 'e2e-plugin-csp: development build (electron . on dist/)');
const app = await electron.launch(executable ? { executablePath: executable, args, env, timeout: 90_000 } : { args, cwd: repo, env, timeout: 60_000 });
const pageErrors = [];
try {
  const page = await applicationWindow(app);
  page.on('pageerror', (e) => pageErrors.push(`page error: ${e.message}`));
  await page.waitForFunction(() => Boolean(/** @type {any} */ (window).editor), null, { timeout: 60_000 });
  check(page.url().startsWith('jcad://app/index.html'), 'the main window loads from the jcad://app origin', page.url());

  // (1) The page refuses string evaluation (its meta CSP is unchanged).
  // The meta policy's bytes first — checked identically in every mode.
  const metaCsp = await page.evaluate(async () => {
    const r = await fetch('jcad://app/index.html');
    const text = await r.text();
    const m = text.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/);
    return m ? m[1] : null;
  });
  check(metaCsp !== null && !metaCsp.includes('unsafe-eval'), 'the page meta CSP contains no unsafe-eval (and no script-src widening)', metaCsp);
  // WebAssembly compilation is document-policy-bound, so this probe is
  // valid from an evaluated context (the 3D security probe relies on the
  // same fact): the page policy grants no 'wasm-unsafe-eval' either.
  const pageWasm = await page.evaluate(async () => {
    try { await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])); return 'compiled'; } catch (e) { return `refused:${/** @type {Error} */ (e).name}`; }
  });
  check(pageWasm.startsWith('refused:'), 'WebAssembly compilation is refused in the renderer page', pageWasm);
  // eval / new Function from REAL page code (the served probe script).
  if (pageProbeFile) {
    await page.addScriptTag({ url: 'jcad://app/assets/csp-page-probe.js' });
    const pageProbe = await page.evaluate(() => /** @type {any} */ (window).__cspPageProbe ?? null);
    check(pageProbe !== null && pageProbe.eval.startsWith('refused:'), 'eval is refused in the renderer page (real page code)', pageProbe);
    check(pageProbe !== null && pageProbe.functionCtor.startsWith('refused:') && pageProbe.functionCall.startsWith('refused:'), 'new Function is refused in the renderer page (real page code)', pageProbe);
  } else {
    skip('eval / new Function refused in the renderer page (real page code)', 'a sealed packaged archive cannot gain a served probe file; the development run of this script exercises the identical meta policy from real page code, and its bytes are checked above');
  }

  // (2) Serving: the worker asset carries the worker CSP; the page does not.
  const workerUrl = `jcad://app/${assetPath}`;
  const headers = await page.evaluate(async (/** @type {string} */ wurl) => {
    const get = async (/** @type {string} */ u) => { const r = await fetch(u); return { url: u, status: r.status, csp: r.headers.get('content-security-policy') }; };
    const main = /** @type {HTMLScriptElement | null} */ (document.querySelector('script[type="module"][src]'));
    return { worker: await get(wurl), page: await get('jcad://app/index.html'), main: main ? await get(main.src) : null };
  }, workerUrl);
  check(headers.worker.status === 200 && headers.worker.csp === WORKER_CSP, 'the realm worker script response carries the worker CSP header', headers.worker);
  check(headers.page.status === 200 && headers.page.csp === null, 'the page response carries no CSP header (its meta policy applies)', headers.page);
  check(headers.main !== null && headers.main.status === 200 && headers.main.csp === null, 'the main renderer script response carries no CSP header', headers.main);

  // (3) The plugin context, the packaged way: the probe package (written
  // into this profile's plugins folder before this block) is served by the
  // main process, and the realm worker is driven with a host handshake
  // carrying the served entry URL as a module.
  const probeDir = join(profile, 'plugins', 'csp-probe');
  mkdirSync(probeDir, { recursive: true });
  writeFileSync(join(probeDir, 'plugin.json'), JSON.stringify({ name: 'csp-probe', version: '0', apiVersion: 2, isolation: 'worker', capabilities: ['commands.register', 'document.read'], main: 'main.js' }));
  const probeEntryBody = [
    "import jcad from './jcad.js';",
    "let evalOutcome = 'not-tried';",
    "try { eval('1'); evalOutcome = 'ran'; } catch (e) { evalOutcome = 'refused:' + e.name; }",
    "let fnOutcome = 'not-tried';",
    "try { new Function('return 1')(); fnOutcome = 'ran'; } catch (e) { fnOutcome = 'refused:' + e.name; }",
    "await jcad.commands.register({ name: 'CSPPING', run: async (jcad) => {",
    "  const n = (await jcad.document.selection()).length;",
    "  return 'pong:' + n + ':eval=' + evalOutcome + ':fn=' + fnOutcome;",
    '} });',
    'export default { loaded: true, evalOutcome, fnOutcome };',
    '',
  ].join('\n');
  writeFileSync(join(probeDir, 'main.js'), probeEntryBody);
  // Fable F1: the serve bridge takes the approved entry hash (the trust
  // flow's codeHash of the entry text) and main verifies its registration
  // snapshot against it; this probe "approves" the body it just wrote.
  const probeEntryHash = createHash('sha256').update(probeEntryBody, 'utf8').digest('hex');
  await page.waitForTimeout(1_000); // let the startup plugin scan (empty folder) settle first
  const probe = await page.evaluate(async (/** @type {{ wurl: string, entryHash: string }} */ arg) => {
    const wurl = arg.wurl;
    const bridge = /** @type {any} */ (window).jcad;
    const served = await bridge.pluginsServeIsolatedPackage('csp-probe', arg.entryHash);
    const entryResp = await fetch(served.entryUrl);
    const entry = { status: entryResp.status, csp: entryResp.headers.get('content-security-policy'), body: await entryResp.text() };
    const travResp = await fetch(`${served.baseUrl}..%2fmain.js`);
    const traversal = { status: travResp.status, body: await travResp.text() };
    const session = 'csp-e2e-session';
    const realmNonce = 'csp-e2e-realm-nonce';
    const hostNonce = 'csp-e2e-host-nonce';
    const realm = await new Promise((resolveProbe) => {
      const w = new Worker(wurl, { type: 'module' });
      /** @type {any} */
      let loadDone = null;
      /** @type {any} */
      let callRes = null;
      /** @type {string | null} */
      let callbackId = null;
      const finish = () => { try { w.terminate(); } catch { /* already gone */ } resolveProbe({ loadDone, callRes }); };
      const timer = setTimeout(finish, 30_000);
      const maybe = () => { if (loadDone && (loadDone.ok === false || callRes)) { clearTimeout(timer); finish(); } };
      w.onmessage = (ev) => {
        const m = /** @type {any} */ (ev.data);
        if (!m || typeof m !== 'object') return;
        if (m.kind === 'load-done') {
          loadDone = m;
          if (m.ok === true && callbackId) {
            w.postMessage({ kind: 'call', v: 2, session, nonce: hostNonce, id: 'c1', callback: callbackId, args: [] });
          }
          maybe();
        } else if (m.kind === 'rpc') {
          if (m.method === 'commands.register' && Array.isArray(m.args)) callbackId = String(m.args[1]);
          const value = m.method === 'document.selection' ? [] : null;
          w.postMessage({ kind: 'rpc-res', v: 2, session, nonce: hostNonce, id: m.id, ok: true, value });
          if (loadDone && loadDone.ok === true && callbackId && m.method === 'commands.register') {
            w.postMessage({ kind: 'call', v: 2, session, nonce: hostNonce, id: 'c1', callback: callbackId, args: [] });
          }
        } else if (m.kind === 'call-res') {
          callRes = m;
          maybe();
        }
      };
      w.onerror = (e) => { loadDone = { ok: false, error: String(e.message || e) }; clearTimeout(timer); finish(); };
      w.postMessage({ kind: 'handshake', v: 2, session, realmNonce, hostNonce, name: 'csp-probe', version: '0', moduleUrl: served.entryUrl });
    });
    await bridge.pluginsUnserveIsolatedPackage(served.sessionId);
    const afterResp = await fetch(served.entryUrl);
    return { served, entry, traversal, realm, afterUnserve: afterResp.status };
  }, { wurl: workerUrl, entryHash: probeEntryHash });
  check(probe.entry.status === 200 && probe.entry.csp === WORKER_CSP && probe.entry.body.includes('CSPPING'),
    '(2b) the plugin-realm entry is served from the vetted package under the worker CSP', probe.entry);
  check(probe.traversal.status !== 200 && !probe.traversal.body.includes('CSPPING'),
    '(2c) an encoded traversal out of the served package is refused', probe.traversal);
  const realm = /** @type {any} */ (probe.realm);
  if (realm.loadDone && realm.loadDone.ok === true) {
    const report = realm.loadDone.report ?? {};
    check(String(report.evalOutcome ?? '').startsWith('refused:') && String(report.fnOutcome ?? '').startsWith('refused:'),
      '(3a) eval and new Function are refused in the plugin context', report);
    check(realm.callRes !== null && realm.callRes.ok === true && String(realm.callRes.value ?? '').startsWith('pong:0:'),
      '(3b) the plugin still works: it loads as a served module and its command answers an RPC round trip', realm.callRes);
  } else {
    check(false, '(3a) eval and new Function are refused in the plugin context', realm.loadDone);
    check(false, '(3b) the plugin still works: it loads as a served module and its command answers an RPC round trip', realm.loadDone);
  }
  check(probe.afterUnserve === 404, '(2d) an unserved session serves nothing', probe.afterUnserve);

  check(pageErrors.length === 0, 'no page errors', pageErrors);
} catch (err) {
  check(false, 'the run completed', String(/** @type {any} */ (err)?.stack || err));
} finally {
  clearTimeout(hardTimeout);
  await Promise.race([app.evaluate(({ app: main }) => main.exit(0)).catch(() => {}), new Promise((r) => setTimeout(r, 5_000))]);
  await closeApplication(app, 30_000);
  if (profile.startsWith(join(tmpdir(), 'jcad-plugin-csp-'))) rmSync(profile, { recursive: true, force: true });
  if (pageProbeFile) { try { unlinkSync(pageProbeFile); } catch { /* a later build regenerates dist anyway */ } }
}

if (process.env.JCAD_PLUGIN_CSP_OUT) writeFileSync(process.env.JCAD_PLUGIN_CSP_OUT, JSON.stringify({ executable: executable || null, asar: asar || null, platform: process.platform, results, skipped }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`e2e-plugin-csp: ${results.length - failed.length}/${results.length} checks passed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
process.exit(failed.length ? 1 : 0);
