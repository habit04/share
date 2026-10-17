// Electron/native xref refresh gate (P20.2, NATIVE-REFRESH-PLAN.md as
// approved with amendments 1-2). Drives the REAL app: the preload bridge
// (window.jcad beginXrefContext/identifyXref/readXref/cancelXref/
// closeXrefContext) -> main IPC -> broker -> the app's own path registry ->
// real files on disk. No registry/grant API is ever called by this harness;
// the host drawing is opened through the app's own OPEN flow (native dialog
// stubbed, the repo-established e2e pattern) so permission state is genuine.
//
//   npm run build
//   node scripts/xref-native-fixtures.mjs <fixture-dir>
//   node --experimental-strip-types scripts/e2e-xref-refresh.mjs \
//     --fixtures <fixture-dir> --out <output-dir> [--sections 3.1,3.2] \
//     [--head <candidate-head>] [--tree <candidate-tree>]
//
// Exit 0 only if every selected check passes. Results land in
// <output-dir>/results.json and <output-dir>/harness.log.
//
// Platform note: the broker validates Windows absolute paths by design
// (absoluteWindowsPath in electron/xref-read.cjs), and the preload exposes
// the xref bridge only on win32. On any other platform this harness can
// validate its own mechanics (launch, fixture verification, host open,
// headers) but beginContext refuses POSIX anchors with ERR_XREF_ARGUMENT
// before any I/O - the gate itself is Windows-only, as designed.
//
// Known architecture note (section 3.5): broker contexts are owned by the
// WebContents (electron/main/ipc-xrefs.cjs ownerOf hooks did-navigate and
// destroyed), not by an editor tab. Section 3.5a applies the approved
// plan's tab-close criterion as written and reports the observed outcome
// truthfully; 3.5a2 additionally proves retirement on page navigation,
// which is the trigger the shipped wiring implements.
import { _electron as electron } from 'playwright';
import { applicationWindow } from './electron-window.mjs';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const argOf = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
};
const fixtureDir = argOf('--fixtures');
const outDir = argOf('--out') || mkdtempSync(join(tmpdir(), 'jcad-xref-out-'));
const sectionsArg = argOf('--sections');
const sections = sectionsArg ? sectionsArg.split(',').map((s) => s.trim()) : ['3.1', '3.2', '3.3', '3.4', '3.5'];
if (!fixtureDir || !existsSync(join(fixtureDir, 'fixtures.json'))) {
  console.error('usage: e2e-xref-refresh.mjs --fixtures <dir from xref-native-fixtures.mjs> --out <dir> [--sections ...] [--head ...] [--tree ...]');
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });

const logLines = [];
const log = (line) => { logLines.push(line); console.log(line); };
const checks = [];
let currentSection = 'setup';
function check(pass, name, detail = '') {
  checks.push({ section: currentSection, name, pass: Boolean(pass), detail });
  log(`${pass ? 'ok  ' : 'FAIL'} [${currentSection}] ${name}${detail ? ` - ${detail}` : ''}`);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fx = (name) => join(fixtureDir, name);

// ---------------------------------------------------------------- fixtures
const manifestText = readFileSync(join(fixtureDir, 'SHA256SUMS.txt'), 'utf8');
const manifestSha = sha256(Buffer.from(manifestText));
const fixtureMeta = JSON.parse(readFileSync(join(fixtureDir, 'fixtures.json'), 'utf8'));
for (const [name, meta] of Object.entries(fixtureMeta)) {
  const buf = readFileSync(fx(name));
  if (buf.length !== meta.bytes || sha256(buf) !== meta.sha256) {
    console.error(`fixture ${name} does not match fixtures.json - regenerate the fixtures`);
    process.exit(2);
  }
}
const hostPath = fx('host.dxf');
const hostHashBefore = sha256(readFileSync(hostPath));

// ---------------------------------------------------------------- launching
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
delete env.VITE_DEV_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;

async function launchApp() {
  const profile = mkdtempSync(join(tmpdir(), 'jcad-xref-profile-'));
  const args = ['.', `--user-data-dir=${profile}`];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const app = await electron.launch({ args, cwd: repo, env, timeout: 60_000 });
  const win = await applicationWindow(app);
  const pageErrors = [];
  win.on('pageerror', (e) => pageErrors.push(String(e.message)));
  await win.waitForFunction(() => !!window.editor, null, { timeout: 30_000 });
  await app.evaluate(({ dialog }) => {
    const g = globalThis;
    g.__xrefOpenPaths = [];
    dialog.showOpenDialog = async () => {
      const p = g.__xrefOpenPaths.shift();
      return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
    };
  });
  return { app, win, pageErrors };
}

async function openHost(app, win) {
  await app.evaluate((_e, p) => globalThis.__xrefOpenPaths.push(p), hostPath);
  await win.evaluate(() => void window.editor.runCommand('OPEN'));
  await win.waitForFunction((p) => window.editor.doc.filePath === p, hostPath, { timeout: 30_000 });
  // Dismiss an import-report dialog if the host produced one.
  for (let i = 0; i < 5 && (await win.locator('.import-report-dialog').count()) > 0; i += 1) {
    await win.locator('.import-report-dialog .modal button', { hasText: 'Close' }).last().click();
    await win.waitForTimeout(200);
  }
}

/** Page-side bridge helpers: every call resolves to { ok, ... } or { ok:false, code }. */
async function installBridge(win) {
  await win.evaluate(() => {
    const code = (e) => {
      const m = /ERR_XREF_[A-Z_]+/.exec(String(e));
      return m ? m[0] : String(e);
    };
    window.__xref = {
      async begin(docId) {
        try {
          const r = await window.jcad.beginXrefContext({ docId, contentGeneration: 1, hostAnchor: window.__xrefHost });
          return { ok: true, token: r.token };
        } catch (e) { return { ok: false, code: code(e) }; }
      },
      async identify(token, path) {
        try {
          const r = await window.jcad.identifyXref(token, path);
          return { ok: true, ticket: r.ticket, identity: r.identity };
        } catch (e) { return { ok: false, code: code(e) }; }
      },
      async read(token, ticket, maxBytes) {
        try {
          const r = await window.jcad.readXref(token, ticket, maxBytes);
          return { ok: true, byteLength: r.byteLength, rawBytes: r.rawBytes, version: r.version };
        } catch (e) { return { ok: false, code: code(e) }; }
      },
      async close(token) {
        try { return { ok: true, value: await window.jcad.closeXrefContext(token) }; }
        catch (e) { return { ok: false, code: code(e) }; }
      },
    };
    window.__xrefHost = window.__xrefHostPath;
  });
}

function waitForExit(child, ms) {
  return new Promise((done) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return done(child ? child.exitCode : null);
    const onExit = () => { clearTimeout(timer); done(child.exitCode); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); done(null); }, ms);
    child.once('exit', onExit);
  });
}

const MIB = 1024 * 1024;
let app; let win; let pageErrors = [];
const results = { header: {}, checks };

try {
  if (!existsSync(join(repo, 'dist', 'index.html'))) throw new Error('dist/index.html not found: run `npm run build` first');
  ({ app, win, pageErrors } = await launchApp());
  const versions = await app.evaluate(() => process.versions);
  const appInfo = await win.evaluate(() => window.jcad.appInfo());
  results.header = {
    electron: versions.electron, chromium: versions.chrome, node: versions.node,
    app: appInfo, platform: process.platform,
    candidateHead: argOf('--head') || '(not supplied)', candidateTree: argOf('--tree') || '(not supplied)',
    fixtureManifestSha256: manifestSha, fixtureDir,
  };
  log(`header: electron ${versions.electron} / chromium ${versions.chrome} / node ${versions.node}`);
  log(`header: app ${JSON.stringify(appInfo)} on ${process.platform}`);
  log(`header: candidate head ${results.header.candidateHead} tree ${results.header.candidateTree}`);
  log(`header: fixture manifest sha256 ${manifestSha}`);
  if (process.platform !== 'win32') log('header: WARNING - not win32: the broker refuses non-Windows paths by design; sections will fail at beginContext (ERR_XREF_ARGUMENT). This run validates harness mechanics only.');
  await openHost(app, win);
  await win.evaluate((p) => { window.__xrefHostPath = p; }, hostPath);
  await installBridge(win);
  const bridgeOk = await win.evaluate(() => ['beginXrefContext', 'identifyXref', 'readXref', 'cancelXref', 'closeXrefContext'].every((k) => typeof window.jcad[k] === 'function'));
  check(bridgeOk, 'window.jcad exposes the five xref bridge methods (Windows-only in the preload by design)');
  if (!bridgeOk) throw new Error('xref bridge unavailable on this platform/build - this gate requires the Windows app');
  await win.screenshot({ path: join(outDir, 'host-open.png') });
  check(true, 'host drawing opened through the app OPEN flow', hostPath);
  check(pageErrors.length === 0, 'no page errors during launch/open', pageErrors.join(' | '));

  const begin = (docId) => win.evaluate((d) => window.__xref.begin(d), docId);
  const identify = (token, p) => win.evaluate(([t, q]) => window.__xref.identify(t, q), [token, p]);
  const read = (token, ticket, max) => win.evaluate(([t, k, m]) => window.__xref.read(t, k, m), [token, ticket, max]);
  const closeCtx = (token) => win.evaluate((t) => window.__xref.close(t), token);

  // -------------------------------------------------------------- 3.1
  if (sections.includes('3.1')) {
    currentSection = '3.1';
    const ctx = await begin('native-3.1');
    check(ctx.ok, 'begin context', JSON.stringify(ctx));
    const idn = await identify(ctx.token, fx('mutable.dxf'));
    check(idn.ok, 'identify mutable.dxf', JSON.stringify(idn));
    const first = await read(ctx.token, idn.ticket, MIB);
    check(first.ok, 'first read of mutable.dxf succeeds', JSON.stringify(first));
    const original = readFileSync(fx('mutable.dxf'));
    // +1 byte growth on disk (the R3 regression shape).
    writeFileSync(fx('mutable.dxf'), Buffer.concat([original, Buffer.from(' ')]));
    const grown = await read(ctx.token, idn.ticket, MIB);
    check(!grown.ok && grown.code === 'ERR_XREF_CHANGED', 'grown file (+1 B) refuses CHANGED, never LIMIT', JSON.stringify(grown));
    // Same-size content change on disk.
    const edited = Buffer.from(original);
    const digitAt = edited.indexOf(0x31); // first '1' (a coordinate digit)
    edited[digitAt] = 0x32; // '1' -> '2', same length
    writeFileSync(fx('mutable.dxf'), edited);
    const changed = await read(ctx.token, idn.ticket, MIB);
    check(!changed.ok && changed.code === 'ERR_XREF_CHANGED', 'same-size edit refuses CHANGED', JSON.stringify(changed));
    // Fresh identify + read succeeds with the new content.
    const idn2 = await identify(ctx.token, fx('mutable.dxf'));
    const reread = idn2.ok ? await read(ctx.token, idn2.ticket, MIB) : { ok: false };
    check(reread.ok && (reread.byteLength !== first.byteLength || reread.version !== first.version), 'fresh identify+read returns the new version', JSON.stringify(reread));
    writeFileSync(fx('mutable.dxf'), original); // restore for any later run
    await closeCtx(ctx.token);
  }

  // -------------------------------------------------------------- 3.2
  if (sections.includes('3.2')) {
    currentSection = '3.2';
    const ctx = await begin('native-3.2');
    const big = await identify(ctx.token, fx('oversized.dxf'));
    check(big.ok, 'identify oversized.dxf', JSON.stringify(big));
    const refused = await read(ctx.token, big.ticket, 16 * MIB);
    check(!refused.ok && refused.code === 'ERR_XREF_LIMIT', 'oversized (16 MiB + 1) refuses LIMIT live', JSON.stringify(refused));
    const leaf = await identify(ctx.token, fx('leaf.dxf'));
    const leafSize = fixtureMeta['leaf.dxf'].bytes;
    const under = await read(ctx.token, leaf.ticket, leafSize - 1);
    check(!under.ok && under.code === 'ERR_XREF_LIMIT', 'allowance one below identified size refuses LIMIT', JSON.stringify(under));
    const fine = await read(ctx.token, leaf.ticket, MIB);
    check(fine.ok && fine.byteLength === leafSize, 'a normal read still succeeds after the refusals (no residue)', JSON.stringify(fine));
    await closeCtx(ctx.token);
  }

  // -------------------------------------------------------------- 3.3 + 3.4
  if (sections.includes('3.3') || sections.includes('3.4')) {
    const ctxA = await begin('native-3.3-a');
    const slow = await identify(ctxA.token, fx('slow.dxf'));
    const leafA = await identify(ctxA.token, fx('leaf.dxf'));
    if (sections.includes('3.3')) {
      currentSection = '3.3';
      check(slow.ok && leafA.ok, 'context A identifies slow.dxf and leaf.dxf');
      // One page-side burst: held read in A, competing read in A, read in B.
      const burst = await win.evaluate(async ([tokA, slowTicket, leafTicketA, leafPath]) => {
        const x = window.__xref;
        const held = x.read(tokA, slowTicket, 16 * 1024 * 1024);
        const competing = x.read(tokA, leafTicketA, 1024 * 1024);
        const beginB = await x.begin('native-3.3-b');
        const idB = beginB.ok ? await x.identify(beginB.token, leafPath) : { ok: false };
        const readB = idB.ok ? await x.read(beginB.token, idB.ticket, 1024 * 1024) : { ok: false };
        const heldResult = await held;
        const competingResult = await competing;
        if (beginB.ok) await x.close(beginB.token);
        return { held: heldResult, competing: competingResult, readB };
      }, [ctxA.token, slow.ticket, leafA.ticket, fx('leaf.dxf')]);
      check(burst.competing && !burst.competing.ok && burst.competing.code === 'ERR_XREF_RESOURCE_BUSY', 'second read in the same context refuses BUSY (zero queue)', JSON.stringify(burst.competing));
      check(burst.readB && burst.readB.ok, 'a read in a second context proceeds meanwhile', JSON.stringify(burst.readB));
      check(burst.held && burst.held.ok && burst.held.rawBytes === fixtureMeta['slow.dxf'].bytes, 'the held read completes with the full file', JSON.stringify(burst.held));
      // Load-shaped sequence: identify + read every graph node, then reload.
      const loadOnce = async (docId) => {
        const c = await begin(docId);
        if (!c.ok) return { ok: false, stage: 'begin' };
        const versions = {};
        for (const name of ['leaf.dxf', 'child.dxf', 'grand.dxf', 'inner.dxf']) {
          const idn = await identify(c.token, fx(name));
          if (!idn.ok) return { ok: false, stage: `identify ${name}` };
          const r = await read(c.token, idn.ticket, MIB);
          if (!r.ok) return { ok: false, stage: `read ${name}`, code: r.code };
          versions[name] = r.version;
        }
        await closeCtx(c.token);
        return { ok: true, versions };
      };
      const load1 = await loadOnce('native-load-1');
      const load2 = await loadOnce('native-load-2');
      check(load1.ok && load2.ok, 'graph load sequence completes twice through the real bridge', JSON.stringify({ load1: load1.ok, load2: load2.ok }));
      check(load1.ok && load2.ok && JSON.stringify(load1.versions) === JSON.stringify(load2.versions), 'reload of the unchanged graph returns identical versions (no-op)');
      check(sha256(readFileSync(hostPath)) === hostHashBefore, 'host file on disk unchanged by the reads (no dirty write)');
    }
    if (sections.includes('3.4')) {
      currentSection = '3.4';
      const r1 = await read(ctxA.token, leafA.ticket, MIB);
      const r2 = await read(ctxA.token, leafA.ticket, MIB);
      check(r1.ok && r2.ok && r1.version === r2.version && r1.byteLength === r2.byteLength, 'unchanged xref reads back identically twice', JSON.stringify({ r1, r2 }));
    }
    await closeCtx(ctxA.token);
  }

  // -------------------------------------------------------------- 3.5
  if (sections.includes('3.5')) {
    currentSection = '3.5';
    const ctx = await begin('native-3.5');
    const leaf = await identify(ctx.token, fx('leaf.dxf'));
    check(leaf.ok, 'context for the lifecycle checks');
    // 3.5a: close the host tab, then try the old ticket (criterion as approved).
    await win.evaluate((p) => {
      const s = window.editor.sessions;
      const i = s.indexOfPath(p);
      if (i >= 0) s.close(i);
    }, hostPath);
    await win.waitForTimeout(300);
    const afterTab = await read(ctx.token, leaf.ticket, MIB);
    check(ctx.ok && leaf.ok && !afterTab.ok, 'read on a context whose host tab closed refuses', JSON.stringify(afterTab));
    // 3.5a2: navigation retires the owner (the shipped trigger).
    await win.reload();
    await win.waitForFunction(() => !!window.editor, null, { timeout: 30_000 });
    await win.evaluate((p) => { window.__xrefHostPath = p; }, hostPath);
    await installBridge(win);
    const afterNav = await win.evaluate(([t, k, m]) => window.__xref.read(t, k, m), [ctx.token, leaf.ticket, MIB]);
    check(ctx.ok && leaf.ok && !afterNav.ok && afterNav.code === 'ERR_XREF_CONTEXT', 'read after page navigation refuses CONTEXT (owner retired)', JSON.stringify(afterNav));
  }
} catch (error) {
  check(false, `harness error in section ${currentSection}`, String(error && error.message || error));
} finally {
  try { if (app) await app.close(); } catch { /* the quit scenarios run separately */ }
}

// ------------------------------------------------------------ quit scenarios
// Amendment 1: disposal proven from idle, post-refusal and in-flight states.
// Each scenario is a fresh launch; app.quit() must exit the process with 0.
if (sections.includes('3.5')) {
  currentSection = '3.5-quit';
  for (const scenario of ['idle', 'after-limit', 'inflight']) {
    let qapp; let qwin;
    try {
      ({ app: qapp, win: qwin } = await launchApp());
      await openHost(qapp, qwin);
      await qwin.evaluate((p) => { window.__xrefHostPath = p; }, hostPath);
      await installBridge(qwin);
      const ctx = await qwin.evaluate(async () => {
        const b = await window.__xref.begin('native-quit');
        if (b.ok) window.__xrefToken = b.token;
        return b;
      });
      if (!ctx.ok) throw new Error(`begin failed: ${JSON.stringify(ctx)}`);
      if (scenario === 'after-limit') {
        const res = await qwin.evaluate(async (p) => {
          const idn = await window.__xref.identify(window.__xrefToken, p);
          if (!idn.ok) return idn;
          return window.__xref.read(window.__xrefToken, idn.ticket, 16 * 1024 * 1024);
        }, fx('oversized.dxf'));
        if (!(!res.ok && res.code === 'ERR_XREF_LIMIT')) throw new Error(`expected a LIMIT refusal before quitting, got ${JSON.stringify(res)}`);
      }
      if (scenario === 'inflight') {
        await qwin.evaluate(async (p) => {
          const idn = await window.__xref.identify(window.__xrefToken, p);
          window.__quitInflight = idn.ok ? window.jcad.readXref(window.__xrefToken, idn.ticket, 16 * 1024 * 1024).then(() => 'done', () => 'refused') : Promise.resolve('no-identify');
        }, fx('slow.dxf'));
        await qwin.waitForTimeout(150);
      }
      const child = qapp.process();
      await qapp.evaluate(({ app: a }) => a.quit());
      const code = await waitForExit(child, 30_000);
      check(code === 0, `app quits cleanly from the ${scenario} state`, `exit code ${code}`);
    } catch (error) {
      check(false, `quit scenario ${scenario}`, String(error && error.message || error));
      try { if (qapp) await qapp.close(); } catch { /* already gone */ }
    }
  }
}

const failed = checks.filter((c) => !c.pass);
log(`\nxref-refresh: ${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` - FAILURES: ${failed.map((f) => `[${f.section}] ${f.name}`).join('; ')}` : ''}`);
writeFileSync(join(outDir, 'harness.log'), logLines.join('\n') + '\n');
writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
process.exit(failed.length ? 1 : 0);
