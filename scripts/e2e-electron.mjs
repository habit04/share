// End-to-end test of the desktop app: launches Electron on the built renderer (dist/) with
// Playwright and drives the real main process, preload bridge and IPC.
//
//   npm run build && npm run e2e          (Linux without a display: xvfb-run -a npm run e2e)
//   npm run e2e:packaged -- <executable>  the same checks against an installed / unpacked build
//                                         (or JCAD_E2E_EXECUTABLE=<executable> npm run e2e)
//
// <executable> is the application binary of a packaged build: release/win-unpacked/JCad Electrical.exe
// (or the folder the NSIS installer was run into), "JCad Electrical.app/Contents/MacOS/JCad Electrical"
// inside the mounted disk image, or squashfs-root/jcad-electrical from `<AppImage> --appimage-extract`.
// scripts/packaged-smoke.mjs finds it for each installer kind. A packaged build reports
// app.isPackaged; on Windows it updates itself through electron-updater, so the offline update
// checks (which stub the GitHub API) are skipped there.
//
// The native file dialogs cannot be answered by a test, and main.cjs has no path override, so the
// test replaces dialog.showOpenDialog / showSaveDialog / showMessageBox(Sync) and net.fetch inside
// the main process (electronApp.evaluate); everything behind them (IPC handlers, file reads and
// writes, LibreDWG, printToPDF, the updater's version logic) is the shipping code.
//
// Checks: window + no page errors, window.jcad bridge, LINE with typed coordinates, ZOOM E (command
// and native menu), OPEN of a DXF and a DWG through `open-drawing`, the Import Report dialog (text,
// Copy Report), hard refusal to replace a source with import losses and a separate Save As copy, IMAGE bitmaps through
// `read-image` (relative to the drawing folder), RECENT (open by remembered
// path), PLOT to a tabloid landscape vector PDF through `save-pdf` (parsed: 1224 x 792 pt, content
// stream paths) and as a raster image through `plot-pdf`, a layout tab plotted as a page, the updater's
// check path offline (up to date / newer release / network error), the Symbol Builder, the About
// dialog, a project opened with Windows-style relative entries (open by resolved path, Save As to another folder
// with recalculated paths, Save / Cancel before opening another project), the Save All workflow on close (Cancel,
// a failed save aborting the close, Save Selected writing a drawing and the project before the window closes, the
// main process waiting for the answer), SAVEAS to a DXF that reads back, AUTOSAVE writing a recovery copy, a large-DWG
// progress dialog and its Cancel (the read runs in a worker thread), IPC from a foreign page being refused, the file
// access rules (a project cannot make files outside its folder writable, save-dxf writes .dxf only, no network images
// for a local drawing, links checked after normalisation, file text in the status bar and dialog titles shown as
// text), saves and images through a linked folder (a drawing saved twice by name under a symlinked or junctioned
// folder, an image next to a drawing known under the linked path, a save onto a symbolic link refused with ELOOP and
// the file it points at unchanged), denied web permissions and blocked pop-ups, and no main-process error log.
// File safety: old-style autosave files are migrated to permanent ids and offered by the Drawing
// Recovery Manager (a double click opens a backup once, Discard All spares the opened one); saves
// go through temp file + rename and keep <name>.bak; a failed save shows Retry / Save As... and
// keeps the drawing modified and its backup; backup-file answers { ok, path } / { ok: false, error } and
// refuses paths outside the main process allow-list;
// an unreadable recovery folder shows an error state.
// Across the tracks: a damaged DXF that finishes opening in a background tab (recovered there, its
// report named after it, autosaved under its permanent id), the close waiting for an autosave being
// written and for the backup removal of a drawing it saved, and a crash after the project was autosaved
// (the next start offers Project Recovery, and the Drawing Recovery Manager lists drawings only).
import { _electron as electron } from 'playwright';
import { applicationWindow } from './electron-window.mjs';
import { verifyExecutableFuses } from './electron-fuse-policy.mjs';
import { runCadFidelity } from './e2e-cad-fidelity.mjs';
import { runViewportRotationChecks } from './e2e-viewport-rotation.mjs';
import { runPortableDwgChecks } from './e2e-portable-dwg.mjs';
import { runCadMetadataChecks } from './e2e-cad-metadata.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, lstatSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { parsePdfBasics, pageContents, parseContentStream, dictValue } from '../tests/helpers/pdf.ts';
/**
 * Where each image of a page's content is drawn: the unit square through the transformation
 * current at its `Do` (q / Q / cm tracked), as a box in page points.
 * @param {{ op: string, args: string[] }[]} ops
 */
function imageBoxes(ops) {
  /** @param {number[]} m @param {number[]} n  m then n (PDF: CTM' = m x CTM) */
  const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  /** @type {number[][]} */
  const stack = [];
  const boxes = [];
  for (const o of ops) {
    if (o.op === 'q') stack.push(ctm);
    else if (o.op === 'Q') ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (o.op === 'cm' && o.args.length === 6) ctm = mul(o.args.map(Number), ctm);
    else if (o.op === 'Do') {
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      boxes.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    }
  }
  return boxes;
}


const repo = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
const fixtures = {
  dxf: join(repo, 'tests', 'fixtures', 'all-entities.dxf'),
  dwg: join(repo, 'fixtures', 'example_2000.dwg'),
};
// --packaged <executable> (or JCAD_E2E_EXECUTABLE): drive an installed / unpacked application.
const packagedArg = process.argv.indexOf('--packaged');
const executable = packagedArg >= 0 ? process.argv[packagedArg + 1] : process.env.JCAD_E2E_EXECUTABLE || '';
const packaged = Boolean(executable);
if (packagedArg >= 0 && !executable) {
  console.error('usage: node --experimental-strip-types scripts/e2e-electron.mjs --packaged <path to the application executable>');
  process.exit(2);
}
if (packaged && !existsSync(executable)) {
  console.error(`packaged executable not found: ${executable}`);
  process.exit(2);
}
if (packaged) {
  // Source/legacy builds or the dedicated test ASAR may be driven with inspection.
  // Exact shipping executables have independent fixed probes and cannot use this driver.
  try {
    await verifyExecutableFuses(executable, 'shipping');
    throw new Error('Shipping inspection is disabled. Use scripts/shipping-runtime-smoke.mjs for that executable, or npm run e2e:test-build for the dedicated test build.');
  } catch (error) {
    if (String(error.message).includes('Shipping inspection is disabled.')) throw error;
  }
}
if (!packaged && !existsSync(join(repo, 'dist', 'index.html'))) {
  console.error('dist/index.html not found: run `npm run build` first.');
  process.exit(2);
}

// Private profile: settings, recent files, autosave and the error log go to a temporary folder.
const profile = mkdtempSync(join(tmpdir(), 'jcad-e2e-'));
// JCAD_E2E_OUT keeps the plotted PDF in that folder (CI uploads it); otherwise a temporary folder is used and removed.
const outDir = process.env.JCAD_E2E_OUT ? resolve(process.env.JCAD_E2E_OUT) : mkdtempSync(join(tmpdir(), 'jcad-e2e-out-'));
mkdirSync(outDir, { recursive: true });
// Autosave files in the old naming scheme (drawing title + a session number that restarted every
// launch): the app must migrate them to permanent ids and offer them in the Recovery Manager.
const autosaveDir = join(profile, 'autosave');
const seedDxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '40', '21', '20', '0', 'LINE', '8', '0', '10', '40', '20', '0', '11', '0', '21', '20', '0', 'ENDSEC', '0', 'EOF', ''].join('\r\n');
mkdirSync(autosaveDir, { recursive: true });
writeFileSync(join(autosaveDir, 'Panel_A_1.sv.dxf'), seedDxf);
writeFileSync(join(autosaveDir, 'Panel_A_1.sv.dxf.json'), JSON.stringify({ originalPath: null, title: 'Panel A.dxf', savedAt: Date.now() - 60_000 }));
writeFileSync(join(autosaveDir, 'Drawing1_1.sv.dxf'), seedDxf);
const readIndex = () => JSON.parse(readFileSync(join(autosaveDir, 'index.json'), 'utf8')).entries;
const tmpLeftovers = (d) => readdirSync(d).filter((f) => f.endsWith('.tmp'));
const ID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sv\.dxf$/;

/** @type {Record<string, string>} */
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
delete env.VITE_DEV_SERVER_URL; // must load dist/, not a dev server
delete env.ELECTRON_RUN_AS_NODE;
// Every DWG gets the progress dialog, and each read is held 1.5 s so Cancel can be clicked in time.
env.JCAD_OPEN_PROGRESS_BYTES = '1';
env.JCAD_DWG_TEST_DELAY_MS = '1500';

const results = [];
const problems = [];
let step = 'launch';
const ok = (what) => {
  results.push(`ok   ${what}`);
  console.log(`ok   ${what}`);
};
const bad = (what) => {
  problems.push(`${step}: ${what}`);
  console.error(`FAIL ${step}: ${what}`);
};
const check = (cond, what) => (cond ? ok(what) : bad(what));

/**
 * Test cleanup runs after the window-close assertions. Explicitly exit here so a failed step
 * cannot leave a dirty-document confirmation waiting for input and hide the original failure.
 * Only the Electron process created by this harness is eligible for forced termination.
 * @param {import('playwright').ElectronApplication} application
 * @param {import('node:child_process').ChildProcess | null | undefined} [child]
 */
async function closeTestApplication(application, child) {
  if (!child) {
    try { child = application.process(); } catch { return; }
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  try {
    await Promise.race([
      application.evaluate(({ app: main }) => main.exit(0)).catch(() => {}),
      new Promise((done) => { timer = setTimeout(done, 5_000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (await waitForExit(child, 5_000)) return;
  console.warn('e2e-electron: terminating its own unresponsive test instance during cleanup');
  if (process.platform === 'win32' && child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5_000, windowsHide: true });
  } else child.kill('SIGKILL');
  if (!(await waitForExit(child, 5_000))) throw new Error('The test Electron process did not exit during bounded cleanup.');
}

/**
 * @param {import('node:child_process').ChildProcess | null | undefined} child
 * @param {number} ms
 */
function waitForExit(child, ms) {
  return new Promise((done) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return done(true);
    const onExit = () => { clearTimeout(timer); done(true); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); done(false); }, ms);
    child.once('exit', onExit);
  });
}

/** A solid-colour RGB PNG (w x h), written without any image library. */
function solidPng(w, h, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const hardTimeout = setTimeout(() => {
  console.error('e2e-electron: timed out after 8 minutes');
  process.exit(1);
}, 8 * 60 * 1000);

// --user-data-dir moves app.getPath('userData') (checked below) on every platform.
const args = packaged ? [`--user-data-dir=${profile}`] : ['.', `--user-data-dir=${profile}`];
// GitHub's Ubuntu runners (and root in containers) cannot use Chromium's setuid sandbox.
if (process.platform === 'linux') args.push('--no-sandbox');
console.log(packaged ? `e2e-electron: packaged application ${executable}` : 'e2e-electron: development build (electron . on dist/)');
const app = await electron.launch(packaged ? { executablePath: executable, args, env, timeout: 90_000 } : { args, cwd: repo, env, timeout: 60_000 });
const mainLog = [];
let userData = profile;
const firstProcess = app.process(); // kept: app.process() is unavailable once the application closed
/** The Electron runtime actually started (the summary line names it, not the package.json range). */
const runtime = await app.evaluate(() => process.versions.electron).catch(() => 'unknown');
firstProcess.stdout?.on('data', (d) => mainLog.push(String(d)));
firstProcess.stderr?.on('data', (d) => mainLog.push(String(d)));

try {
  step = 'window';
  const win = await applicationWindow(app);
  const pageErrors = [];
  win.on('pageerror', (e) => pageErrors.push(`PAGE ERROR ${e.message}`));
  win.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`CONSOLE ${m.text()}`);
  });
  await win.waitForFunction(() => !!window.editor, null, { timeout: 30_000 });
  await win.waitForTimeout(500);
  check(/JCad Electrical/.test(await win.title()), `window title "${await win.title()}"`);
  userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  // macOS reports the profile through /private/var while mkdtemp gave /var: compare the real paths.
  const samePath = (x, y) => {
    try {
      return realpathSync.native(x) === realpathSync.native(y);
    } catch {
      return x === y;
    }
  };
  check(samePath(userData, profile), `private profile in use (${userData})`);
  const loadedFile = await win.evaluate(() => location.protocol + location.pathname.replace(/^.*\//, '/'));
  check(loadedFile === 'jcad:/index.html', `renderer loaded from its secure bundled origin (${loadedFile})`);

  // Main-process test doubles (see the header comment).
  await app.evaluate(({ dialog, net, shell }) => {
    const g = globalThis;
    g.__e2e = { openPaths: [], savePaths: [], messages: [], external: [], release: null, fetchError: null };
    const d = /** @type {any} */ (dialog);
    d.showOpenDialog = async (_win, opts) => {
      const p = g.__e2e.openPaths.shift();
      g.__e2e.messages.push(`open:${opts && opts.title}`);
      return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
    };
    d.showSaveDialog = async (_win, opts) => {
      const p = g.__e2e.savePaths.shift();
      g.__e2e.messages.push(`save:${opts && opts.title}`);
      return p ? { canceled: false, filePath: p } : { canceled: true };
    };
    d.showMessageBox = async (_win, opts) => {
      const o = opts || _win;
      g.__e2e.messages.push(`box:${o.title}|${o.message}`);
      return { response: typeof o.cancelId === 'number' ? o.cancelId : 1, checkboxChecked: false };
    };
    d.showMessageBoxSync = (_win, opts) => {
      const o = opts || _win;
      g.__e2e.messages.push(`boxsync:${o.message}`);
      return 1; // "Don't Save"
    };
    net.fetch = async (url) => {
      g.__e2e.messages.push(`fetch:${url}`);
      if (g.__e2e.fetchError) throw new Error(g.__e2e.fetchError);
      return new Response(JSON.stringify(g.__e2e.release), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    shell.openExternal = async (u) => {
      g.__e2e.external.push(String(u));
    };
  });
  const messages = () => app.evaluate(() => globalThis.__e2e.messages.splice(0));
  const releaseLatestUrl = 'https://api.github.com/repos/habit04/share/releases/latest';
  // A packaged startup check may fetch in the background while an unrelated operation runs.
  // Keep every other event unexpected, including all native dialogs and other fetch URLs.
  const noDialogMessages = async () => {
    const raw = await messages();
    return { raw, unexpected: raw.filter((m) => m !== `fetch:${releaseLatestUrl}`) };
  };
  // Editor.history is a 500-entry ring, so its length cannot be a log cursor.
  // Capture real log calls for this private test instance before delegating to
  // the unchanged editor. Exceeding the suite budget fails instead of truncating.
  await win.evaluate(() => {
    const ed = window.editor;
    const messages = [...ed.history];
    const originalLog = ed.log.bind(ed);
    ed.__e2eLogCapture = messages;
    ed.log = (text) => {
      if (messages.length >= 5000) throw new Error('E2E log capture exceeded 5000 messages');
      messages.push(text);
      return originalLog(text);
    };
  });
  const logSince = async (n) => win.evaluate((k) => window.editor.__e2eLogCapture.slice(k), n);
  const historyLen = () => win.evaluate(() => window.editor.__e2eLogCapture.length);
  const waitLog = (re, from, timeout = 30_000) =>
    win.waitForFunction(([src, flags, k]) => window.editor.__e2eLogCapture.slice(k).some((l) => new RegExp(src, flags).test(l)), [re.source, re.flags, from], { timeout });

  // ------------------------------------------------------------------ preload bridge
  step = 'bridge';
  const bridge = await win.evaluate(() => {
    const j = window.jcad;
    return j ? { keys: Object.keys(j).sort(), platform: j.platform } : null;
  });
  check(!!bridge, 'window.jcad bridge exists');
  const info = await win.evaluate(() => window.jcad.appInfo());
  // An installer of an older release (the manual "Packaged smoke test" workflow) lacks features
  // added since; checks of those are skipped for it. JCAD_E2E_EXPECT_VERSION names its version.
  const expectVersion = process.env.JCAD_E2E_EXPECT_VERSION || pkg.version;
  const current = info.version === pkg.version;
  const protectedOpenedSources = bridge?.platform === 'win32' && bridge.keys.includes('releaseOpenedSourceProof');
  const newKeys = ['onOpenProgress', 'cancelOpen', 'onCloseRequest', 'chooseProjectPath', 'chooseDrawingPath', 'saveProject', 'takeOpenFiles', 'onOpenFiles'];
  for (const k of ['openDrawing', 'openDxf', 'saveDxf', 'plotPdf', 'printDrawing', 'appInfo', 'checkForUpdates', 'onMenuCommand', 'backupFile', 'autosaveWrite', 'userLibraryRead', 'packsList', 'readImage', ...(current ? newKeys : [])]) check(bridge?.keys.includes(k), `bridge exposes ${k}`);
  if (!current) ok(`release ${info.version} is older than these checks (${pkg.version}): progress / Cancel, image allow list and IPC guard checks skipped`);
  check(bridge?.platform === process.platform, `bridge platform ${bridge?.platform}`);
  check(info.version === expectVersion && info.packaged === packaged && (packaged || info.selfUpdate === false), `appInfo ${JSON.stringify(info)}`);
  check(await win.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined'), 'renderer has no Node globals (contextIsolation, sandbox)');

  // ------------------------------------------------------------------ Drawing Recovery Manager at start-up
  step = 'recovery';
  let panelBackup = null;
  const recDlg = win.locator('.recovery-dialog .modal');
  await recDlg.waitFor({ timeout: 15_000 }).then(
    () => ok('the Drawing Recovery Manager opened at start-up'),
    () => bad('no Drawing Recovery Manager for the seeded autosave files'),
  );
  {
    const files = readdirSync(autosaveDir);
    const index = readIndex();
    const ids = files.filter((f) => ID_FILE.test(f));
    check(ids.length === 2 && !files.some((f) => /^(Panel_A_1|Drawing1_1)\.sv\.dxf/.test(f)), `old autosave files renamed to permanent ids (${files.join(', ')})`);
    check(ids.every((f) => index[f]) && Object.values(index).map((e) => e.title).sort().join() === 'Drawing1.dxf,Panel A.dxf', `index.json maps ids to titles (${JSON.stringify(index)})`);
    panelBackup = ids.find((f) => index[f].title === 'Panel A.dxf') ?? null;
  }
  check((await win.locator('.recovery-dialog .recovery-row').count()) === 2, 'both backups are listed');
  const hr = await historyLen();
  const tabsRec = await win.evaluate(() => window.editor.sessions.count);
  // A double click on Open must open the backup once.
  await win.locator('.recovery-dialog .recovery-row', { hasText: 'Panel A.dxf' }).locator('button', { hasText: 'Open' }).dblclick();
  await waitLog(/^Recovered Panel A\.dxf/, hr, 15_000).catch(() => bad('the backup was not opened'));
  await win.waitForTimeout(500);
  const recovered = (await logSince(hr)).filter((l) => l.startsWith('Recovered Panel A.dxf'));
  check(recovered.length === 1 && (await win.evaluate(() => window.editor.sessions.count)) === tabsRec + 1, `double click opened the backup once (${recovered.length} time(s), ${await win.evaluate(() => window.editor.sessions.count)} tabs)`);
  check(await win.evaluate((n) => window.jacUi.autosaver.owns(n), panelBackup), 'the opened drawing adopted its backup');
  check((await win.locator('.recovery-dialog .recovery-row').count()) === 1, 'the opened backup is no longer listed');
  await win.locator('.recovery-dialog button', { hasText: 'Discard All' }).click();
  await recDlg.waitFor({ state: 'detached', timeout: 10_000 }).then(
    () => ok('Discard All closed the Recovery Manager'),
    () => bad('the Recovery Manager stayed open after Discard All'),
  );
  {
    const files = readdirSync(autosaveDir).filter((f) => f.endsWith('.sv.dxf'));
    check(files.length === 1 && files[0] === panelBackup && Object.keys(readIndex()).join() === panelBackup, `Discard All removed only the backup still listed (${files.join(', ')})`);
  }
  await win.evaluate(() => window.editor.sessions.switchTo(0));

  // ------------------------------------------------------------------ commands typed at the command line
  step = 'LINE';
  const before = await win.evaluate(() => window.editor.doc.entities.length);
  const input = win.locator('.command-input');
  for (const text of ['LINE', '0,0', '10,5', '@5,0']) {
    await input.fill(text);
    await input.press('Enter');
  }
  await input.press('Enter'); // end LINE
  await win.waitForTimeout(100);
  const lines = await win.evaluate((n) => window.editor.doc.entities.slice(n).map((e) => (e.type === 'line' ? [e.a.x, e.a.y, e.b.x, e.b.y] : e.type)), before);
  check(JSON.stringify(lines) === JSON.stringify([[0, 0, 10, 5], [10, 5, 15, 5]]), `LINE 0,0 10,5 @5,0 drew ${JSON.stringify(lines)}`);
  check(await win.evaluate(() => !window.editor.tool), 'LINE ended with Enter');

  step = 'ZOOM';
  // ZOOM runs as a tool (it logs no "Command:" line): check the view instead.
  const viewOf = () => win.evaluate(() => JSON.stringify({ c: window.editor.viewport.center, s: window.editor.viewport.scale }));
  await win.evaluate(() => void window.editor.runCommand('ZOOM I'));
  const view0 = await viewOf();
  await input.fill('ZOOM E');
  await input.press('Enter');
  await win.waitForTimeout(200);
  const viewE = await viewOf();
  check(viewE !== view0, `ZOOM E from the command line changed the view (${viewE})`);
  const ext = await win.evaluate(() => {
    const ed = window.editor;
    const b = ed.doc.extents();
    const tl = ed.viewport.toScreen({ x: b.min.x, y: b.max.y });
    const br = ed.viewport.toScreen({ x: b.max.x, y: b.min.y });
    return { tl, br, w: ed.viewport.width, h: ed.viewport.height };
  });
  check(ext.tl.x >= -1 && ext.tl.y >= -1 && ext.br.x <= ext.w + 1 && ext.br.y <= ext.h + 1, `drawing extents fit the canvas after ZOOM E (${JSON.stringify(ext)})`);
  // The native menu sends commands over IPC ('menu-command').
  await win.evaluate(() => void window.editor.runCommand('ZOOM I'));
  check((await viewOf()) !== viewE, 'ZOOM I zoomed in');
  await app.evaluate(({ Menu }) => {
    const view = Menu.getApplicationMenu().items.find((i) => i.label === 'View');
    view.submenu.items.find((i) => i.label === 'Zoom Extents').click();
  });
  await win.waitForFunction((v) => JSON.stringify({ c: window.editor.viewport.center, s: window.editor.viewport.scale }) === v, viewE, { timeout: 5000 }).then(
    () => ok('View > Zoom Extents (native menu -> IPC -> renderer) restored the extents view'),
    async () => bad(`native menu Zoom Extents did not reach the renderer (view ${await viewOf()})`),
  );

  let h = 0;
  // ------------------------------------------------------------------ OPEN through open-drawing
  step = 'OPEN dxf';
  await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), fixtures.dxf);
  h = await historyLen();
  const tabs0 = await win.evaluate(() => window.editor.sessions.count);
  await win.evaluate(() => void window.editor.runCommand('OPEN'));
  await waitLog(/^(Opened|Failed to open)/, h).catch(() => bad('no open result logged'));
  let log = await logSince(h);
  check(log.some((l) => l.startsWith(`Opened ${fixtures.dxf}: 25 entities`)), `DXF opened through IPC: ${log.filter((l) => /Opened|Failed/.test(l)).join(' | ')}`);
  const opened = await win.evaluate(() => ({ tabs: window.editor.sessions.count, path: window.editor.doc.filePath, types: [...new Set(window.editor.doc.entities.map((e) => e.type))].sort() }));
  check(opened.tabs === tabs0 + 1 && opened.path === fixtures.dxf, `opened in a new tab (${opened.tabs} tabs, ${opened.path})`);
  check(['dimension', 'ellipse', 'insert', 'mtext', 'polyline', 'ray', 'xline'].every((t) => opened.types.includes(t)), `entity kinds ${opened.types.join(',')}`);
  check((await messages()).includes('open:Open Drawing'), 'the Open dialog was requested by the main process');
  // The committed DXF can now report font/metadata approximations. Finish that import's
  // dialog before exercising another file; each later assertion concerns its own report.
  while ((await win.locator('.import-report-dialog').count()) > 0)
    await win.locator('.import-report-dialog .modal button', { hasText: 'Close' }).last().click();

  step = 'OPEN dwg';
  if (existsSync(fixtures.dwg)) {
    // A second listener on the bridge records the progress events the dialog receives.
    if (current)
      await win.evaluate(() => {
        const w = /** @type {any} */ (window);
        w.__progress = [];
        window.jcad.onOpenProgress((p) => {
          w.__progress.push(`${p.state}:${p.name}:${p.cancellable}`);
          if (p.state === 'start' && w.__cancelNext) window.jcad.cancelOpen(p.id).then((r) => (w.__cancelled = r));
        });
      });
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), fixtures.dwg);
    h = await historyLen();
    await win.evaluate(() => void window.editor.runCommand('OPEN'));
    if (current)
      await win.waitForSelector('.modal-backdrop.open-progress', { timeout: 15_000 }).then(
        async () => ok(`progress dialog shown while the DWG is read (${(await win.locator('.open-progress .modal-body').textContent())?.replace(/\s+/g, ' ').trim()})`),
        () => bad('no progress dialog for the DWG read'),
      );
    await waitLog(/^(Imported DWG|Failed to open)/, h, 90_000).catch(() => bad('no DWG import result logged'));
    log = await logSince(h);
    const line = log.find((l) => /Imported DWG|Failed/.test(l)) ?? '';
    const n = Number(/: (\d+) entities/.exec(line)?.[1] ?? 0);
    check(line.startsWith('Imported DWG') && n > 10, `DWG opened through IPC + LibreDWG in the isolated reader: ${line}`);
  }
  if (existsSync(fixtures.dwg) && current) {
    const progress = await win.evaluate(() => /** @type {any} */ (window).__progress.splice(0));
    check(progress.join() === 'start:example_2000.dwg:true,end:example_2000.dwg:undefined', `open-progress events ${progress.join(' ')}`);
    check((await win.locator('.modal-backdrop.open-progress').count()) === 0, 'progress dialog closed after the import');
    await win.locator('.import-report-dialog .modal button', { hasText: 'Close' }).last().click();

    step = 'OPEN dwg cancel';
    await win.evaluate(() => (/** @type {any} */ (window).__cancelNext = true));
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), fixtures.dwg);
    h = await historyLen();
    const entitiesBefore = await win.evaluate(() => window.editor.doc.entities.length);
    await win.evaluate(() => void window.editor.runCommand('OPEN'));
    await waitLog(/^(Imported DWG|Failed to open)/, h, 90_000).catch(() => bad('no result logged for the cancelled DWG'));
    log = await logSince(h);
    check(log.some((l) => /^Failed to open drawing: .*Open cancelled/.test(l)) && log.some((l) => l === 'Opening example_2000.dwg was cancelled.'), `Cancel stops the read: ${log.filter((l) => /cancel|Failed|Imported/i.test(l)).join(' | ')}`);
    check((await win.evaluate(() => window.editor.doc.entities.length)) === entitiesBefore, 'the cancelled read changed nothing');
    await win.evaluate(() => (/** @type {any} */ (window).__cancelNext = false));
    // The worker was terminated; the next read starts a fresh one.
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), fixtures.dwg);
    h = await historyLen();
    // Windows DWGs now stay bound to their tab. Reload that tab so this check exercises
    // a fresh reader rather than Open's already-open-tab shortcut.
    if (await win.evaluate(() => typeof window.jcad.saveDwg === 'function')) await win.evaluate(() => void window.editor.openFile());
    else await win.evaluate(() => void window.editor.runCommand('OPEN'));
    await waitLog(/^(Imported DWG|Failed to open)/, h, 90_000).catch(() => bad('no result after the cancelled read'));
    log = await logSince(h);
    check(log.some((l) => l.startsWith('Imported DWG')), `a DWG opens again after Cancel: ${log.filter((l) => /Imported|Failed/.test(l)).join(' | ')}`);
    await win.evaluate(() => /** @type {any} */ (window).__progress.splice(0));
  }
  if (!existsSync(fixtures.dwg)) ok('DWG fixture missing: skipped');

  // ------------------------------------------------------------------ Import Report dialog + partial-source protection
  step = 'import report';
  // The DWG above holds content the import cannot keep (wipeouts, a tolerance, a multiline...): the
  // Import Report dialog opened after it. Check its text, Copy Report and Close.
  // modal() puts the dialog's class on the backdrop; the dialog itself is its .modal child.
  const dwgReport = win.locator('.import-report-dialog .modal', { hasText: 'DWG Import Report' });
  if (existsSync(fixtures.dwg)) {
    await dwgReport.waitFor({ timeout: 5000 }).then(
      async () => {
        const text = await dwgReport.innerText();
        check(/object\(s\) dropped or simplified/.test(text) && /WIPEOUT/.test(text), 'DWG Import Report lists counts and objects');
        const copy = dwgReport.locator('.modal-footer button').first(); // Copy Report (its label changes after the click)
        await copy.click();
        await copy.filter({ hasText: 'Copied' }).waitFor({ timeout: 3000 }).then(
          () => ok('Copy Report copied the report text'),
          async () => bad(`Copy Report did not report "Copied" (button: "${await copy.textContent()}", title: "${await copy.getAttribute('title')}")`),
        );
        const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
        check(/WIPEOUT/.test(copied) && /layout "Layout1"/.test(copied), 'copied DWG report includes objects and layouts beyond the dialog item limit');
        await dwgReport.locator('button', { hasText: 'Close' }).click();
        check((await win.locator('.import-report-dialog').count()) === 0, 'Import Report dialog closed');
      },
      () => bad('no Import Report dialog after opening a DWG with unsupported content'),
    );
  }
  // A DXF with content JCad cannot keep: SAVE refuses its source; SAVEAS writes a separate copy.
  const lossDir = mkdtempSync(join(tmpdir(), 'jcad-e2e-loss-'));
  const lossDxf = join(lossDir, 'unsupported-content.dxf');
  writeFileSync(lossDxf, readFileSync(join(repo, 'tests', 'fixtures', 'unsupported-content.dxf')));
  await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), lossDxf);
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('OPEN'));
  await waitLog(/^(Opened|Failed to open)/, h).catch(() => bad('no open result logged'));
  const dxfReport = win.locator('.import-report-dialog .modal', { hasText: 'DXF Import Report' });
  await dxfReport.waitFor({ timeout: 5000 }).then(
    async () => {
      const text = await dxfReport.innerText();
      check(/kept without being shown/.test(text) && /3DSOLID/.test(text) && /Saving over the original file removes the dropped content/.test(text), 'DXF Import Report explains kept records and the Save As advice');
      await dxfReport.locator('button', { hasText: 'Close' }).click();
    },
    () => bad('no Import Report dialog after opening a DXF with unsupported content'),
  );
  await messages();
  if (current) {
    await win.evaluate(() => {
      const ed = window.editor;
      ed.doc.addEntities([{ id: 'import-loss-save-marker', type: 'line', layer: '0', color: 'ByLayer', a: { x: -53, y: -54 }, b: { x: -52, y: -51 } }]);
      /** @type {any} */ (window).__importLossBefore = ed.doc.snapshot;
    });
    h = await historyLen();
    await win.evaluate(() => void window.editor.runCommand('SAVE'));
    await waitLog(/^Not saved: .*partial import.*cannot be saved over its source.*Use Save As/, h).then(
      () => ok('SAVE refuses the partial-import source and explains Save As'),
      () => bad('SAVE did not report the partial-import source refusal'),
    );
    check(await win.evaluate(() => window.editor.doc.snapshot === /** @type {any} */ (window).__importLossBefore && window.editor.doc.dirty), 'Refused partial-source SAVE preserves the edited snapshot and dirty state');
    check(await win.locator('.modal').count() === 0, 'Partial-source refusal does not offer destructive overwrite consent');
    check(!(await messages()).some((m) => m.startsWith('save:')), 'Refused source SAVE does not open a destination picker');
    const lossCopy = join(lossDir, 'unsupported-content-copy.dxf');
    await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), lossCopy);
    h = await historyLen();
    await win.evaluate(() => void window.editor.runCommand('SAVEAS'));
    await waitLog(/^Saved /, h).then(
      () => ok('SAVEAS writes the partial import to a separate file'),
      () => bad('Separate partial-import SAVEAS did not finish'),
    );
    check(await win.evaluate(p => window.editor.doc.filePath === p && !window.editor.doc.dirty, lossCopy), 'Separate SAVEAS becomes the clean working drawing');
    check(readFileSync(lossDxf, 'latin1') === readFileSync(join(repo, 'tests', 'fixtures', 'unsupported-content.dxf'), 'latin1') && !existsSync(lossDxf + '.bak'), 'Refusal and separate SAVEAS preserve the exact original without a source backup');
    check(existsSync(lossCopy) && /\bSECTION\b/.test(readFileSync(lossCopy, 'utf8')), 'The separate DXF copy exists on disk');
    await win.evaluate(() => { delete /** @type {any} */ (window).__importLossBefore; });
  } else {
    // Older packaged releases retain the original consent/No-to-Save-As smoke check.
    h = await historyLen();
    await win.evaluate(() => void window.editor.runCommand('SAVE'));
    const warn = win.locator('.modal', { hasText: 'Save over the original file?' });
    await warn.waitFor({ timeout: 5000 }).then(
      async () => {
        check(/object\(s\) JCad cannot keep .* Save As to keep the original/.test(await warn.innerText()), 'Save warning names the loss and Save As');
        await warn.locator('button', { hasText: 'No' }).click();
        await waitLog(/^Save As keeps the original file unchanged/, h).then(
          () => ok('No switches to Save As'),
          () => bad('No did not switch to Save As'),
        );
        await win.waitForFunction(() => !document.querySelector('.modal'), null, { timeout: 5000 }).catch(() => {});
        await win.waitForTimeout(300);
        const msgs = await messages();
        check(msgs.some((m) => m.startsWith('save:')), `the Save As dialog was requested by the main process (${msgs.join(' | ')})`);
        check(readFileSync(lossDxf, 'latin1') === readFileSync(join(repo, 'tests', 'fixtures', 'unsupported-content.dxf'), 'latin1'), 'the original file was not written');
      },
      () => bad('SAVE over a source file with import losses did not ask'),
    );
  }
  rmSync(lossDir, { recursive: true, force: true });

  // ------------------------------------------------------------------ IMAGE bitmaps through read-image
  step = 'IMAGE';
  const imgDir = mkdtempSync(join(tmpdir(), 'jcad-e2e-img-'));
  const pngPath = join(imgDir, 'logo.png');
  writeFileSync(pngPath, solidPng(4, 4, [255, 0, 0]));
  // Images are read only next to files the user chose: before anything is saved in imgDir the read is refused.
  if (current) {
    const early = await win.evaluate((p) => window.jcad.readImage(p).then(() => 'read', (e) => String(e)), pngPath);
    check(/Invalid path/.test(early), `read-image refuses an image in a folder the user never chose (${early})`);
  }
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), join(imgDir, 'image-test.dxf'));
  const savedImgDrawing = await win.evaluate(() => window.jcad.saveDxf(null, '0\nEOF\n', 'image-test.dxf'));
  check(savedImgDrawing === join(imgDir, 'image-test.dxf'), `a drawing saved in the image folder through the Save dialog (${savedImgDrawing})`);
  await messages();
  const dataUrl = await win.evaluate((p) => window.jcad.readImage(p), pngPath);
  check(typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,'), `read-image returns a PNG data URL (${String(dataUrl).slice(0, 30)})`);
  const canonicalPng = realpathSync.native(pngPath);
  check((await win.evaluate((p) => window.jcad.readImage(p), canonicalPng)) === dataUrl, 'read-image authorizes the canonical spelling of the native chosen drawing folder');
  const refused = await win.evaluate(async (paths) => {
    const out = [];
    for (const p of paths) out.push(await window.jcad.readImage(p).then(() => 'read', (e) => (/Invalid path|Not an image/.test(String(e)) ? 'refused' : String(e))));
    return out;
  }, ['logo.png', join(imgDir, 'notes.txt')]);
  check(refused.join() === 'refused,refused', `read-image refuses relative paths and non-image files (${refused.join()})`);
  check((await win.evaluate((p) => window.jcad.readImage(p), join(imgDir, 'missing.png'))) === null, 'read-image returns null for a missing file');
  // A drawing in that folder with an IMAGE whose path is relative: the bitmap is drawn over the frame.
  await win.evaluate((dwg) => {
    const ed = window.editor;
    const snap = ed.doc.snapshot;
    const image = { id: 'img-e2e', layer: '0', color: 'ByLayer', type: 'image', path: 'logo.png', position: { x: 0, y: 0 }, u: { x: 2.5, y: 0 }, v: { x: 0, y: 2.5 }, size: { x: 4, y: 4 } };
    ed.loadState({ ...snap, entities: [image] }, dwg);
    ed.render();
  }, join(imgDir, 'image-test.dxf'));
  const centrePixel = () =>
    win.evaluate(() => {
      const c = /** @type {HTMLCanvasElement} */ (document.getElementById('drawing'));
      window.editor.render();
      const px = c.getContext('2d').getImageData(Math.round(c.width / 2), Math.round(c.height / 2), 1, 1).data;
      return [px[0], px[1], px[2]];
    });
  let rgb = [0, 0, 0];
  for (let i = 0; i < 40; i += 1) {
    rgb = await centrePixel();
    if (rgb[0] > 200 && rgb[1] < 60 && rgb[2] < 60) break;
    await win.waitForTimeout(100);
  }
  check(rgb[0] > 200 && rgb[1] < 60 && rgb[2] < 60, `IMAGE with a relative path draws its bitmap (centre pixel ${rgb.join(',')})`);
  rmSync(imgDir, { recursive: true, force: true });

  step = 'RECENT';
  await messages();
  // Open by remembered path (no dialog): close the DXF tab, then RECENT n opens it again by name,
  // which main.cjs only allows for paths that came from its own dialogs.
  await win.evaluate((p) => {
    const s = window.editor.sessions;
    const i = s.indexOfPath(p);
    if (i >= 0) s.close(i);
  }, fixtures.dxf);
  h = await historyLen();
  const recent = await win.evaluate(() => window.editor.settings.recentFiles);
  check(recent.includes(fixtures.dxf), `recent files list the DXF (${recent.join(', ')})`);
  const idx = recent.indexOf(fixtures.dxf) + 1;
  if (idx < 1) throw new Error('The RECENT fixture is missing from the actual recent-file list.');
  await win.evaluate((i) => void window.editor.runCommand(`RECENT ${i}`), idx);
  await waitLog(/^(Opened|Failed to open)/, h, 15_000).catch(() => bad('RECENT did not open anything'));
  log = await logSince(h);
  check(log.some((l) => l.startsWith(`Opened ${fixtures.dxf}: 25 entities`)) && !log.some((l) => /Failed to open|Unknown file path/.test(l)), `RECENT ${idx} reopened by path: ${log.filter((l) => /Open|Failed/.test(l)).join(' | ')}`);
  const recentMessages = await noDialogMessages();
  check(recentMessages.unexpected.length === 0, `no dialog was shown for RECENT (${JSON.stringify(recentMessages)})`);
  check(!log.some((l) => /in a new tab|in the tab it was opened from/.test(l)) && (await win.evaluate((p) => window.editor.doc.filePath === p, fixtures.dxf)), 'RECENT opened the file straight into its own, active tab');
  while ((await win.locator('.import-report-dialog').count()) > 0)
    await win.locator('.import-report-dialog .modal button', { hasText: 'Close' }).last().click();

  // Independent five-feature CAD imports share this app and restore its original tab/view.
  step = 'CAD fidelity';
  await runCadFidelity({ app, page: win, repo, outDir, check, packaged });

  step = 'Rotated layout viewports';
  await runViewportRotationChecks({ app, page: win, repo, outDir, check, current });

  step = 'Portable DWG export';
  await runPortableDwgChecks({ app, page: win, repo, outDir, check, current });

  step = 'Native CAD metadata';
  await runCadMetadataChecks({ app, page: win, repo, outDir, check, current });

  // Test-owned real utilityProcess assembly smoke. This exercises the shipped
  // host factory and engine assets, including inside a test ASAR; it does not
  // claim to exercise the lexical main-service instance, font admission or Plot.
  if (process.platform === 'win32' && current) {
    step = 'restricted PDF utilityProcess assembly';
    const marker = 'JCAD-UTILITY-AUTHORED-PLAINTEXT';
    const content = `BT /F1 12 Tf 72 720 Td (${marker}) Tj ET`;
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ];
    let authored = '%PDF-1.4\n';
    const offsets = [];
    for (const [index, body] of objects.entries()) { offsets.push(authored.length); authored += `${index + 1} 0 obj\n${body}\nendobj\n`; }
    const startxref = authored.length;
    authored += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) authored += `${String(offset).padStart(10, '0')} 00000 n \n`;
    authored += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
    const plain = new Uint8Array(Buffer.from(authored, 'ascii'));
    const plainPdf = parsePdfBasics(plain);
    check(plainPdf.errors.length === 0 && plainPdf.pages.length === 1 && dictValue(plainPdf.trailer, 'Encrypt') === null,
      'restricted utility input is an authored valid unencrypted one-page PDF');
    const proof = await app.evaluate(async ({ app: main, utilityProcess }, input) => {
      const load = process.mainModule?.require.bind(process.mainModule);
      if (!load) throw new Error('The CJS main loader is unavailable for utility assembly inspection');
      const path = load('node:path'), { createHash } = load('node:crypto');
      const appPath = main.getAppPath(), modulePath = path.join(appPath, 'electron', 'restricted-pdf', 'host.cjs');
      const childPath = path.join(appPath, 'electron', 'restricted-pdf', 'qpdf-child.cjs');
      const { createRestrictedPdfHost, MAX_INPUT_BYTES, MAX_DECLARED_MEMORY } = load(modulePath);
      const originalFork = utilityProcess.fork;
      /** @type {Array<{ modulePath: string, pid: number | null, spawned: boolean, exited: boolean, exitCode: number | null, errors: string[] }>} */
      const children = [];
      utilityProcess.fork = function (file, args, options) {
        const child = originalFork.call(utilityProcess, file, args, options);
        if (path.resolve(file).toLowerCase() === path.resolve(childPath).toLowerCase()) {
          const entry = { modulePath: file, pid: child.pid ?? null, spawned: false, exited: false, exitCode: null, errors: [] };
          children.push(entry);
          child.once('spawn', () => { entry.spawned = true; entry.pid = child.pid ?? null; });
          child.once('exit', (code) => { entry.exited = true; entry.exitCode = code; });
          child.on('error', (error) => { entry.errors.push(String(error).slice(0, 512)); });
        }
        return child;
      };
      const source = Buffer.from(input, 'ascii');
      const digest = () => createHash('sha256').update(source).digest('hex');
      const inputSha256 = digest();
      let host, output, settledStats;
      try {
        // No spawn injection, alternate assets, deadline or resource override.
        host = createRestrictedPdfHost();
        output = await host.transform(source);
        settledStats = host.stats();
      } finally {
        try { if (host) await host.dispose(); }
        finally { utilityProcess.fork = originalFork; }
      }
      if (!(output instanceof Uint8Array) || output.byteLength > 2 * source.byteLength + 1024 * 1024) throw new Error('Utility output exceeds its production envelope');
      return { scope: 'TEST-OWNED HOST: real utilityProcess and shipped engine assets; not main service or font/Plot admission',
        packaged: main.isPackaged, appPath, modulePath, childPath, children,
        maxInputBytes: MAX_INPUT_BYTES, maxDeclaredMemory: MAX_DECLARED_MEMORY,
        inputBytes: source.byteLength, inputSha256, inputUnchanged: digest() === inputSha256,
        settledStats, disposedStats: host.stats(), outputBase64: Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString('base64') };
    }, authored);
    const output = new Uint8Array(Buffer.from(proof.outputBase64, 'base64'));
    const pdf = parsePdfBasics(output);
    const reference = /^(\d+)\s+(\d+)\s+R$/.exec(dictValue(pdf.trailer, 'Encrypt') ?? '');
    const encryption = reference ? pdf.objects.get(Number(reference[1])) : null;
    const dictionary = encryption?.dict ?? '';
    const cryptFilters = dictValue(dictionary, 'CF') ?? '';
    const standard = dictValue(cryptFilters, 'StdCF') ?? '';
    // The small existing helper searches keys textually. Remove the nested CF
    // dictionary before reading outer /Length, so its /Length32 is not mistaken
    // for the top-level /Length256. This smoke uses qpdf's classic-xref output.
    const topLevelEncryption = cryptFilters ? dictionary.replace(cryptFilters, '<< >>') : dictionary;
    const metadata = dictValue(dictionary, 'EncryptMetadata');
    const empty = (value) => value && value.active === 0 && value.queued === 0 && value.queuedBytes === 0 && value.reservedBytes === 0 && value.quarantined === false;
    check(proof.packaged === packaged && (!packaged || /[\\/]app\.asar$/.test(proof.appPath))
      && proof.modulePath.startsWith(proof.appPath) && proof.childPath.startsWith(proof.appPath),
    `restricted utility uses the actual ${packaged ? 'test ASAR' : 'source'} host and child paths`);
    check(proof.maxInputBytes === 128 * 1024 * 1024 && proof.maxDeclaredMemory === 805306368,
      'restricted utility retains production input and WASM-memory caps');
    check(proof.children.length === 1 && proof.children[0].spawned && proof.children[0].pid > 0
      && proof.children[0].exited && proof.children[0].exitCode === 0 && proof.children[0].errors.length === 0
      && resolve(proof.children[0].modulePath).toLowerCase() === resolve(proof.childPath).toLowerCase(),
    'restricted utility used one actual child with observed successful exit and no process error');
    check(output.byteLength >= 8 && output.byteLength <= 2 * plain.byteLength + 1024 * 1024 && pdf.version === '1.7',
      `restricted utility output is bounded PDF 1.7 (${output.byteLength} bytes)`);
    check(pdf.errors.length === 0 && pdf.startxrefValid && pdf.endsWithEof && pdf.pages.length === 1,
      `restricted utility PDF has sound classic-xref/page structure (${pdf.errors.join('; ') || 'no errors'})`);
    check(!!reference && encryption?.gen === Number(reference[2]) && dictValue(dictionary, 'Filter') === '/Standard',
      'restricted utility trailer resolves to its actual Standard Encrypt dictionary');
    check(dictValue(dictionary, 'R') === '6' && dictValue(dictionary, 'V') === '5' && dictValue(topLevelEncryption, 'Length') === '256',
      'restricted utility Encrypt dictionary declares R6/V5/256-bit encryption');
    check(dictValue(standard, 'CFM') === '/AESV3' && dictValue(standard, 'Length') === '32'
      && dictValue(dictionary, 'StmF') === '/StdCF' && dictValue(dictionary, 'StrF') === '/StdCF',
    'restricted utility stream and string filters select the AESV3 Standard crypt filter');
    check(dictValue(dictionary, 'P') === '-1324' && (metadata === null || metadata === 'true'),
      'restricted utility records the expected P2 flags and metadata encryption (explicit true or PDF default)');
    check(!Buffer.from(output).includes(Buffer.from(marker, 'ascii')) && proof.inputBytes === plain.byteLength && proof.inputUnchanged,
      'restricted utility does not expose the authored plaintext marker and leaves its input unchanged');
    check(empty(proof.settledStats), 'restricted utility result is returned after child exit with all reservations refunded');
    check(empty(proof.disposedStats), 'restricted utility finally-dispose completes with no active, queued or unconfirmed work');
    const { outputBase64: _outputBase64, ...record } = proof;
    writeFileSync(join(outDir, 'restricted-utility-authored.pdf'), output, { flag: 'wx' });
    writeFileSync(join(outDir, 'restricted-utility-proof.json'), JSON.stringify({ ...record, outputBytes: output.byteLength,
      pdf: { version: pdf.version, encryptObject: reference ? Number(reference[1]) : null,
        filter: dictValue(dictionary, 'Filter'), revision: dictValue(dictionary, 'R'), permissions: dictValue(dictionary, 'P'),
        metadataEncryption: metadata ?? 'true (PDF default)' } }, null, 2), { flag: 'wx' });
  } else console.log('restricted utility assembly smoke skipped: requires the current Windows source or test build');

  // ------------------------------------------------------------------ PLOT through plot-pdf
  step = 'PLOT';
  const pdfPath = join(outDir, 'plot-tabloid.pdf');
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), pdfPath);
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('PLOT'));
  const dlg = win.locator('.modal', { hasText: 'Paper size' });
  await dlg.waitFor({ timeout: 10_000 });
  const selects = dlg.locator('select');
  await selects.nth(0).selectOption('tabloid');
  await selects.nth(1).selectOption('landscape');
  await selects.nth(2).selectOption('fit');
  check(/17\.00 x 11\.00 in landscape/.test(await dlg.textContent()), 'Plot dialog previews a 17 x 11 in landscape sheet');
  await dlg.locator('button', { hasText: 'Plot to PDF' }).click();
  await waitLog(/^Plotted to /, h, 60_000).catch(() => bad('no "Plotted to" line'));
  log = await logSince(h);
  check(log.some((l) => l === `Plotted to ${pdfPath} (17.00 x 11.00 in).`), `renderer reports ${log.find((l) => l.startsWith('Plotted')) ?? '(nothing)'}`);
  check((await messages()).includes('save:Plot to PDF'), 'the Save dialog was requested by save-pdf');
  if (existsSync(pdfPath)) {
    const bytes = new Uint8Array(readFileSync(pdfPath));
    const pdf = parsePdfBasics(bytes);
    check(pdf.errors.length === 0, `PDF structure sound (${statSync(pdfPath).size} bytes${pdf.errors.length ? `: ${pdf.errors.slice(0, 5).join('; ')}` : ''})`);
    check(pdf.pages.length === 1, `PDF has ${pdf.pages.length} page(s)`);
    const pg = pdf.pages[0];
    check(pg && Math.abs(pg.width - 1224) < 1 && Math.abs(pg.height - 792) < 1, `page is tabloid landscape 1224 x 792 pt (got ${pg ? `${pg.width} x ${pg.height}, MediaBox ${pg.mediaBox.join(' ')}, Rotate ${pg.rotate}` : 'none'})`);
    const content = parseContentStream(pageContents(pdf, (b) => new Uint8Array(inflateSync(b)))[0] ?? '');
    check(content.errors.length === 0 && content.pathOps > 20 && pdf.images.length === 0, `vector content: ${content.pathOps} path operators, ${content.counts.S ?? 0} strokes, ${pdf.images.length} image(s)${content.errors.length ? `; ${content.errors.slice(0, 3).join('; ')}` : ''}`);
    check(content.strokeColors.every((c) => c === '0 0 0'), `monochrome plot style: stroke colours ${content.strokeColors.join(' | ')}`);
  } else bad(`no PDF written at ${pdfPath}`);

  // The raster output keeps Electron's printToPDF path (plot-pdf).
  step = 'PLOT raster';
  const rasterPath = join(outDir, 'plot-raster.pdf');
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), rasterPath);
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('PLOT'));
  const dlg2 = win.locator('.modal', { hasText: 'Paper size' });
  await dlg2.waitFor({ timeout: 10_000 });
  await dlg2.locator('select').nth(3).selectOption('raster');
  await dlg2.locator('button', { hasText: 'Plot to PDF' }).click();
  await waitLog(/^Plotted to /, h, 60_000).catch(() => bad('no "Plotted to" line for the raster plot'));
  check((await messages()).includes('save:Plot to PDF'), 'the Save dialog was requested by plot-pdf (raster)');
  if (existsSync(rasterPath)) {
    const pdf = parsePdfBasics(new Uint8Array(readFileSync(rasterPath)));
    check(pdf.errors.length === 0 && pdf.images.some((i) => i.width > 1000), `raster PDF has the plot image (${pdf.images.map((i) => `${i.width}x${i.height}`).join(', ')})`);
    // printToPDF's margins (Electron 44 takes top/bottom/left/right; Electron 33 ignored the
    // marginType it was given and the page's @page { margin: 0 } decided): the sheet image fills
    // the whole tabloid page either way, with no margin.
    const pg = pdf.pages[0];
    const boxes = imageBoxes(parseContentStream(pageContents(pdf, (b) => new Uint8Array(inflateSync(b)))[0] ?? '').ops);
    const box = boxes[0];
    check(
      pg && Math.abs(pg.width - 1224) < 1 && Math.abs(pg.height - 792) < 1 && boxes.length === 1 && box && Math.abs(box.x0) < 1 && Math.abs(box.y0) < 1 && Math.abs(box.x1 - pg.width) < 1 && Math.abs(box.y1 - pg.height) < 1,
      `raster PDF: tabloid landscape page, image placed edge to edge (page ${pg ? `${pg.width} x ${pg.height}` : 'none'}, image ${boxes.map((b) => [b.x0, b.y0, b.x1, b.y1].map((v) => v.toFixed(1)).join(' ')).join(' | ')})`,
    );
  } else bad(`no raster PDF written at ${rasterPath}`);

  // A layout tab: Layout1 is initialised with a viewport and plots as its own sheet.
  step = 'PLOT layout';
  const layoutPdf = join(outDir, 'plot-layout.pdf');
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), layoutPdf);
  await win.locator('#layout-tabs .layout-tab', { hasText: 'Layout1' }).click();
  check(await win.evaluate(() => window.editor.doc.space?.layout === 'Layout1' && window.editor.doc.layouts[0].viewports.length === 1), 'Layout1 tab activates paper space with one viewport');
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('PLOT'));
  const dlg3 = win.locator('.modal', { hasText: 'Page setup' });
  await dlg3.waitFor({ timeout: 10_000 });
  await dlg3.locator('button', { hasText: 'Plot to PDF' }).click();
  await waitLog(/^Plotted to /, h, 60_000).catch(() => bad('no "Plotted to" line for the layout'));
  check((await messages()).includes('save:Plot to PDF'), 'the Save dialog was requested for the layout plot');
  if (existsSync(layoutPdf)) {
    const pdf = parsePdfBasics(new Uint8Array(readFileSync(layoutPdf)));
    const content = parseContentStream(pageContents(pdf, (b) => new Uint8Array(inflateSync(b)))[0] ?? '');
    check(pdf.errors.length === 0 && pdf.pages.length === 1 && (content.counts.W ?? 0) >= 1 && content.pathOps > 20, `layout PDF: ${pdf.pages.map((p) => `${p.width} x ${p.height}`).join(', ')}, ${content.counts.W ?? 0} viewport clip(s), ${content.pathOps} path operators`);
  } else bad(`no layout PDF written at ${layoutPdf}`);
  await win.locator('#layout-tabs .layout-tab', { hasText: 'Model' }).click();
  check(await win.evaluate(() => !window.editor.doc.space), 'Model tab is active again');

  // ------------------------------------------------------------------ updater check path, offline
  step = 'updates';
  // electron-updater (packaged Windows / AppImage) asks GitHub itself; only the API path can be stubbed.
  const apiUpdates = !info.selfUpdate;
  if (!apiUpdates) ok('self-updating build: offline update checks skipped (electron-updater talks to GitHub directly)');
  if (apiUpdates) {
  await app.evaluate((_e, v) => {
    globalThis.__e2e.release = { tag_name: `v${v}`, html_url: 'https://github.com/habit04/share/releases/tag/v' + v, body: '', assets: [] };
  }, info.version);
  let r = await win.evaluate(() => window.jcad.checkForUpdates());
  check(r.state === 'up-to-date' && r.version === info.version, `same version -> ${JSON.stringify(r)}`);
  let msgs = await messages();
  check(msgs.some((m) => m.startsWith('fetch:https://api.github.com/repos/')) && msgs.some((m) => m.includes('is up to date')), `asked the releases API and said "up to date" (${msgs.join(' ; ')})`);
  await app.evaluate(() => {
    globalThis.__e2e.release = { tag_name: 'v99.0.0', html_url: 'https://github.com/habit04/share/releases/tag/v99.0.0', body: 'Notes', assets: [] };
  });
  r = await win.evaluate(() => window.jcad.checkForUpdates());
  msgs = await messages();
  check(r.state === 'available' && r.version === '99.0.0' && msgs.some((m) => m.includes('99.0.0 is available')), `newer release -> ${JSON.stringify(r)}`);
  check((await app.evaluate(() => globalThis.__e2e.external.splice(0))).length === 0, '"Later" opens no browser');
  await app.evaluate(() => {
    globalThis.__e2e.fetchError = 'getaddrinfo ENOTFOUND api.github.com';
  });
  r = await win.evaluate(() => window.jcad.checkForUpdates());
  msgs = await messages();
  check(r.state === 'error' && /ENOTFOUND/.test(r.message ?? '') && msgs.some((m) => m.includes('Could not check for updates')), `offline -> ${JSON.stringify(r)}`);
  await app.evaluate(() => {
    globalThis.__e2e.fetchError = null;
  });
  await app.evaluate((_e, v) => {
    globalThis.__e2e.release = { tag_name: `v${v}`, html_url: 'https://github.com/habit04/share/releases/tag/v' + v, body: '', assets: [] };
  }, info.version);
  }
  // The About dialog's button runs CHECKUPDATES in the renderer.
  step = 'About';
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('ABOUT'));
  const about = win.locator('.modal', { hasText: 'Check for Updates' });
  await about.waitFor({ timeout: 10_000 });
  const aboutText = await about.textContent();
  check(aboutText.includes('JCad Electrical') && aboutText.includes(info.version), 'About dialog shows the name and version');
  const support = JSON.parse(readFileSync(join(repo, 'electron', 'support.json'), 'utf8'));
  const supportUrl = `mailto:${support.email}`;
  const aboutContact = about.locator('.about-contact a');
  check(await aboutContact.count() === 1 && await aboutContact.textContent() === support.email && await aboutContact.getAttribute('href') === supportUrl, 'About shows the shared support email and exact mailto target');
  await win.waitForFunction(() => /Version \d/.test(document.querySelector('.modal .help-update-row')?.textContent ?? ''), null, { timeout: 5000 }).then(
    () => ok('About dialog shows appInfo from the main process'),
    () => bad('About dialog never showed appInfo'),
  );
  if (apiUpdates) {
    await about.locator('button', { hasText: 'Check for Updates' }).click();
    await waitLog(/is up to date|Update check failed|Update available/, h, 15_000).catch(() => {});
    log = await logSince(h);
    check(log.some((l) => /JCad Electrical .* is up to date\./.test(l)), `About > Check for Updates -> "${log.filter((l) => /update/i.test(l)).join(' | ')}"`);
  }
  await messages();
  // Help > About from the native menu opens the same dialog. The dialog opened by ABOUT above is
  // closed first (Check for Updates closes it on the API path; on self-updating builds it is still
  // up), so that the menu is seen to open one, not found to have added a second one.
  if (await win.locator('.modal').count()) {
    await win.keyboard.press('Escape');
    await win.locator('.modal').first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  }
  check((await win.locator('.modal').count()) === 0, 'the About dialog closed before the menu test');
  await app.evaluate(({ Menu }) => {
    const help = Menu.getApplicationMenu().items.find((i) => i.label === 'Help');
    help.submenu.items.find((i) => /^About JCad Electrical/.test(i.label)).click();
  });
  await win.locator('.modal', { hasText: 'Check for Updates' }).waitFor({ timeout: 5000 }).then(
    () => ok('Help > About (native menu) opens the About dialog'),
    () => bad('Help > About did not open the dialog'),
  );
  const externalBeforeReport = await app.evaluate(() => globalThis.__e2e.external.length);
  await win.locator('.modal', { hasText: 'Check for Updates' }).locator('button', { hasText: 'Report a Problem' }).click();
  const reportContactDialog = win.locator('.modal', { hasText: 'You can also email bugs or feature requests' });
  await reportContactDialog.waitFor({ timeout: 5000 });
  const reportContact = reportContactDialog.locator('a[href^="mailto:"]');
  check(await reportContact.count() === 1 && await reportContact.textContent() === support.email && await reportContact.getAttribute('href') === supportUrl, 'Report a Problem shows the shared support email and exact mailto target');
  check(await app.evaluate(() => globalThis.__e2e.external.length) === externalBeforeReport, 'Observing About/report contact links does not launch an email client');
  await win.keyboard.press('Escape');
  await win.waitForTimeout(100);

  // ------------------------------------------------------------------ SAVEAS writes a DXF that reads back
  step = 'SAVEAS';
  await win.keyboard.press('Escape');
  const savedPath = join(outDir, 'saved-e2e.dxf');
  rmSync(savedPath, { force: true });
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), savedPath);
  h = await historyLen();
  const savedCount = await win.evaluate(() => window.editor.doc.entities.length);
  await win.evaluate(() => void window.editor.runCommand('SAVEAS'));
  await waitLog(/^Saved /, h, 30_000).catch(() => bad('no "Saved" line'));
  check((await messages()).some((m) => m.startsWith('save:')), 'SAVEAS asked for a file name through the Save dialog');
  if (existsSync(savedPath)) {
    const text = readFileSync(savedPath, 'utf8');
    check(/^\s*0\r?\nSECTION/.test(text) && /\r?\nEOF\s*$/.test(text), `saved DXF is complete (${statSync(savedPath).size} bytes)`);
    check(!(await win.evaluate(() => window.editor.doc.dirty)), 'the drawing is clean after SAVEAS');
    // Read it back through the app (after closing its tab): same number of entities.
    await win.evaluate((p) => {
      const s = window.editor.sessions;
      const i = s.indexOfPath(p);
      if (i >= 0) s.close(i);
    }, savedPath);
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), savedPath);
    h = await historyLen();
    await win.evaluate(() => void window.editor.runCommand('OPEN'));
    await waitLog(/^(Opened|Failed to open)/, h, 30_000).catch(() => bad('the saved DXF did not reopen'));
    log = await logSince(h);
    check(log.some((l) => l.startsWith(`Opened ${savedPath}: ${savedCount} entities`)), `saved DXF reopens with ${savedCount} entities: ${log.filter((l) => /Opened|Failed/.test(l)).join(' | ')}`);
  } else bad(`no DXF written at ${savedPath}`);
  // A name typed without ".dxf" is completed by the main process; when that file already exists, Save As asks
  // before replacing it (the Linux file dialog confirms only the name as typed). The stubbed question answers Cancel.
  if (current && existsSync(savedPath)) {
    const before = readFileSync(savedPath, 'utf8');
    await messages();
    await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), savedPath.replace(/\.dxf$/, ''));
    await win.evaluate(() => void window.editor.runCommand('SAVEAS'));
    const asked = [];
    for (let i = 0; i < 100 && !asked.some((m) => m.startsWith('box:')); i += 1) {
      await win.waitForTimeout(100);
      asked.push(...(await messages()));
    }
    check(asked.some((m) => m.startsWith('save:')) && asked.some((m) => /^box:.*saved-e2e\.dxf already exists/.test(m)), `SAVEAS to "saved-e2e" (no extension) completed the name and asked before replacing saved-e2e.dxf (${asked.join(' ; ')})`);
    await win.waitForTimeout(300);
    check(readFileSync(savedPath, 'utf8') === before && !existsSync(savedPath.replace(/\.dxf$/, '')), 'Cancel in that question left saved-e2e.dxf unchanged and wrote no extension-less file');
  }

  // ------------------------------------------------------------------ AUTOSAVE writes a recovery copy
  step = 'AUTOSAVE';
  await win.evaluate(() => void window.editor.runCommand('LINE'));
  for (const text of ['1,1', '4,4']) {
    await input.fill(text);
    await input.press('Enter');
  }
  await input.press('Enter');
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('AUTOSAVE'));
  await waitLog(/autosaved|Autosave/, h, 20_000).catch(() => bad('AUTOSAVE logged nothing'));
  const autosaves = await win.evaluate(() => window.jcad.autosaveList());
  check(Array.isArray(autosaves) && autosaves.length >= 1, `autosave entries for the Drawing Recovery Manager: ${JSON.stringify((autosaves ?? []).map((a) => a.name))}`);
  const recoveryCopy = autosaves?.[0] ? await win.evaluate((n) => window.jcad.autosaveRead(n), autosaves[0].name) : null;
  check(typeof recoveryCopy === 'string' && /SECTION/.test(recoveryCopy) && /EOF\s*$/.test(recoveryCopy), `recovery copy is a complete DXF (${recoveryCopy ? recoveryCopy.length : 0} characters)`);

  // ------------------------------------------------------------------ IPC from anything but the application page is refused
  step = 'IPC guard';
  const foreign = !current ? 'skipped' : await app.evaluate(async ({ app: a, BrowserWindow }) => {
    const sep = process.platform === 'win32' ? '\\' : '/';
    const preload = [a.getAppPath(), 'electron', 'preload.cjs'].join(sep);
    const w = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
    try {
      await w.loadURL('data:text/html;charset=utf-8,<p>foreign</p>');
      return await w.webContents.executeJavaScript('window.jcad ? window.jcad.appInfo().then(() => "allowed", (e) => String(e)) : "no bridge"');
    } finally {
      w.destroy();
    }
  });
  if (current) {
    check(/Unauthorized IPC caller/.test(foreign), `a page other than the application cannot use the bridge (${foreign})`);
    const rejectionLog = join(userData, 'ipc-rejections.log');
    check(existsSync(rejectionLog) && /ipc app-info: sender is not the application window/.test(readFileSync(rejectionLog, 'utf8')), 'the refusal is logged in ipc-rejections.log');
  }

  // ------------------------------------------------------------------ file access: read / write split, network paths, links, markup
  step = 'file access';
  if (current) {
    const accDir = mkdtempSync(join(tmpdir(), 'jcad-e2e-acc-'));
    const jobDir = join(accDir, 'jobs', 'a');
    mkdirSync(jobDir, { recursive: true });
    const tinyDxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
    const outsideJson = join(accDir, 'package.json'); // "../../package.json" seen from the project folder
    // Readable only (the catalog file); it lists a drawing itself, which must never be registered.
    const outsideJsonText = '{"name":"not-a-project","drawings":[{"file":"elsewhere-c.dxf"}]}';
    const outsideDxf = join(accDir, 'elsewhere.dxf');
    const climbDxf = join(accDir, 'climb.dxf'); // "sheet1.dxf/../../../climb.dxf"
    const catalogListed = join(accDir, 'elsewhere-c.dxf');
    const insideDxf = join(jobDir, 'sheet1.dxf');
    writeFileSync(outsideJson, outsideJsonText);
    for (const f of [outsideDxf, climbDxf, catalogListed, insideDxf]) writeFileSync(f, tinyDxf);
    const accProject = join(jobDir, 'listing.jcadproj.json');
    const projectText = JSON.stringify({
      name: 'Access',
      drawings: [{ file: 'sheet1.dxf' }, { file: '../../package.json' }, { file: 'sheet1.dxf/../../../package.json' }, { file: '../../elsewhere.dxf' }, { file: 'sheet1.dxf/../../../climb.dxf' }, { file: '\\\\e2e-no-such-host\\share\\remote.dxf' }],
      settings: { catalogFile: '../../package.json' },
    });
    writeFileSync(accProject, projectText);
    // Opened through the (stubbed) Open Project dialog, straight on the bridge: the editor's own project is untouched.
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), accProject);
    const opened = await win.evaluate(() => window.jcad.openProject().then((r) => (r ? r.path : null)));
    check(opened === accProject, `a project listing ../../package.json, drawings outside its folder and a network drawing opened through the dialog (${opened})`);
    await messages();
    const tryCall = (fn, args) => win.evaluate(([f, a]) => window.jcad[f](...a).then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e) })), [fn, args]);
    const asProject = await tryCall('saveProject', [outsideJson, '{"name":"overwritten"}']);
    check(!asProject.ok && /Unknown project path/.test(asProject.e) && readFileSync(outsideJson, 'utf8') === outsideJsonText, `a catalog file named by the project (../../package.json) is not writable by save-project (${asProject.e})`);
    const asDxf = await tryCall('saveDxf', [outsideJson, '0\nEOF\n', 'x.dxf']);
    check(!asDxf.ok && /Invalid path/.test(asDxf.e) && readFileSync(outsideJson, 'utf8') === outsideJsonText, `save-dxf refuses a .json file (${asDxf.e})`);
    const overProject = await tryCall('saveDxf', [accProject, '0\nEOF\n', 'x.dxf']);
    check(!overProject.ok && /Invalid path/.test(overProject.e) && readFileSync(accProject, 'utf8') === projectText, `save-dxf refuses the writable project file itself: wrong file type (${overProject.e})`);
    // A project the user chose: the drawings it lists are written by project-wide commands wherever they are.
    const chosenBackup = await tryCall('backupFile', [outsideDxf]);
    check(chosenBackup.ok && chosenBackup.r && chosenBackup.r.ok === true && existsSync(`${outsideDxf}.bak`), `backup-file copies a drawing outside the folder of a project the user chose (${JSON.stringify(chosenBackup.r)})`);
    const chosenSave = await tryCall('saveDxf', [outsideDxf, tinyDxf.replace('ENDSEC', 'ENDSEC\n999\nchosen'), 'elsewhere.dxf', { backup: false }]);
    const chosenMessages = await noDialogMessages();
    check(chosenSave.ok && chosenSave.r === outsideDxf && chosenMessages.unexpected.length === 0 && /chosen/.test(readFileSync(outsideDxf, 'utf8')), `that drawing is saved by name without a dialog (${JSON.stringify({ reply: chosenSave, messages: chosenMessages })})`);
    const climbSave = await tryCall('saveDxf', [climbDxf, tinyDxf.replace('ENDSEC', 'ENDSEC\n999\nclimb'), 'climb.dxf']);
    const climbMessages = await noDialogMessages();
    check(climbSave.ok && climbSave.r === climbDxf && climbMessages.unexpected.length === 0, `"sheet1.dxf/../../../climb.dxf" is resolved first: the drawing it names is writable, package.json spelled that way is not (${JSON.stringify({ reply: climbSave, messages: climbMessages })})`);
    const insideSave = await tryCall('saveDxf', [insideDxf, tinyDxf.replace('ENDSEC', 'ENDSEC\n999\ninside'), 'sheet1.dxf']);
    const insideMessages = await noDialogMessages();
    check(insideSave.ok && insideSave.r === insideDxf && insideMessages.unexpected.length === 0 && /inside/.test(readFileSync(insideDxf, 'utf8')), `a drawing inside the project folder is saved by name without a dialog (${JSON.stringify({ reply: insideSave, messages: insideMessages })})`);
    const remote = await tryCall('openDrawing', ['\\\\e2e-no-such-host\\share\\remote.dxf']);
    check(!remote.ok && /Unknown file path/.test(remote.e), `a network drawing named by a local project is not registered (${remote.e})`);
    // A project opened only by name (a plugin, OPENPROJECT <path>): nothing beyond its folder.
    const byNameDir = join(accDir, 'jobs', 'b');
    mkdirSync(byNameDir, { recursive: true });
    const byNameProject = join(byNameDir, 'by-name.jcadproj.json');
    const outsideB = join(accDir, 'elsewhere-b.dxf');
    writeFileSync(outsideB, tinyDxf);
    writeFileSync(byNameProject, JSON.stringify({ name: 'By name', drawings: [{ file: '../../elsewhere-b.dxf' }] }));
    // The project file itself was picked once (Save Project As dialog), so it may be opened by name.
    await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), byNameProject);
    check((await win.evaluate(() => window.jcad.chooseProjectPath('by-name.jcadproj.json'))) === byNameProject, 'a second project file picked in the Save Project As dialog');
    await messages();
    const byName = await tryCall('openProject', [byNameProject]);
    check(byName.ok && byName.r && byName.r.path === byNameProject, `that project opened by name (${JSON.stringify(byName.ok ? byName.r.path : byName.e)})`);
    const byNameBackup = await tryCall('backupFile', [outsideB]);
    check(byNameBackup.ok && byNameBackup.r && byNameBackup.r.ok === false && !existsSync(`${outsideB}.bak`), `backup-file refuses a drawing outside the folder of a project opened only by name (${JSON.stringify(byNameBackup.r)})`);
    const byNameSave = await tryCall('saveDxf', [outsideB, '0\nEOF\n', 'elsewhere-b.dxf']);
    const asked = await messages();
    check(byNameSave.ok && byNameSave.r === null && asked.includes('save:Save Drawing As') && readFileSync(outsideB, 'utf8') === tinyDxf, `such a drawing is saved only through the Save As dialog (cancelled here: ${JSON.stringify(byNameSave.r)}, ${asked.join(' ; ')})`);
    const readBack = await tryCall('openDrawing', [outsideB]);
    check(readBack.ok && readBack.r && readBack.r.kind === 'dxf', 'that drawing can still be opened (read) by name');
    // This permission probe never installs its bytes in an Editor tab. Release
    // only its unused raw-read token; actual Editor-owned proofs stay live.
    if (protectedOpenedSources && readBack.ok && typeof readBack.r?.openedSourceProof === 'string') {
      await win.evaluate((proof) => window.jcad.releaseOpenedSourceProof(proof), readBack.r.openedSourceProof);
      check(readFileSync(outsideB, 'utf8') === tinyDxf && !existsSync(`${outsideB}.bak`), 'releasing the unused raw-read proof leaves the drawing and its backup untouched');
    }
    // A renderer's claimed Recent Documents click cannot elevate project permissions.
    const fromRecent = await tryCall('openProject', [byNameProject, { userChosen: true }]);
    const recentBackup = await tryCall('backupFile', [outsideB]);
    check(fromRecent.ok && recentBackup.ok && recentBackup.r && recentBackup.r.ok === false && !existsSync(`${outsideB}.bak`), `a renderer's userChosen claim grants no write access outside the project folder (${JSON.stringify(recentBackup.r)})`);
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), byNameProject);
    const nativeChoice = await tryCall('openProject', []);
    const nativeBackup = await tryCall('backupFile', [outsideB]);
    check(nativeChoice.ok && nativeBackup.ok && nativeBackup.r?.ok === true && existsSync(`${outsideB}.bak`), 'a real native project choice authorizes its listed drawings');
    // ...but only for a project file the user chose: the catalog file (readable only) grants nothing, flag or not.
    const catalogAsProject = await tryCall('openProject', [outsideJson, { userChosen: true }]);
    const catalogDrawing = await tryCall('openDrawing', [catalogListed]);
    check(catalogAsProject.ok && !catalogDrawing.ok && /Unknown file path/.test(catalogDrawing.e), `a readable-only JSON file opened "from Recent Documents" registers nothing it lists (${catalogDrawing.e})`);
    // Images on a network share are never read for a drawing elsewhere: no connection, no sign-in prompt.
    const netImages = await win.evaluate(async (paths) => {
      const out = [];
      for (const p of paths) out.push(await window.jcad.readImage(p).then(() => 'read', (e) => (/Invalid path/.test(String(e)) ? 'refused' : String(e))));
      return out;
    }, ['\\\\e2e-no-such-host\\share\\logo.png', '//e2e-no-such-host/share/logo.png']);
    check(netImages.join() === 'refused,refused', `read-image refuses \\\\server\\share and //server/share paths (${netImages.join()})`);
    const imgDxf = join(jobDir, 'net-image.dxf');
    writeFileSync(imgDxf, ['0', 'SECTION', '2', 'OBJECTS', '0', 'IMAGEDEF', '5', '1A', '1', '\\\\e2e-no-such-host\\share\\stamp.png', '0', 'IMAGEDEF', '5', '1B', '1', '//e2e-no-such-host/share/mark.png', '0', 'ENDSEC', '0', 'EOF', ''].join('\n'));
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), imgDxf);
    await win.evaluate(() => window.jcad.openDrawing());
    await messages();
    const named = await win.evaluate(async (paths) => {
      const out = [];
      for (const p of paths) out.push(await window.jcad.readImage(p).then(() => 'read', (e) => (/Invalid path/.test(String(e)) ? 'refused' : String(e))));
      return out;
    }, ['\\\\e2e-no-such-host\\share\\stamp.png', '//e2e-no-such-host/share/mark.png']);
    check(named.join() === 'refused,refused', `network images named by a local drawing's IMAGEDEF are refused (${named.join()})`);
    // Links: parsed and compared after "..", so the repository prefix cannot be escaped.
    const links = await win.evaluate(async (urls) => {
      const out = [];
      for (const u of urls) out.push(await window.jcad.openExternal(u));
      return out;
    }, ['https://github.com/habit04/share/../../login/oauth/authorize?client_id=x', 'https://github.com/habit04/share/%2e%2e/%2e%2e/settings', 'https://github.com@example.com/habit04/share/', 'https://github.com/habit04/share/releases']);
    const opened2 = await app.evaluate(() => globalThis.__e2e.external.splice(0));
    check(links.join() === 'false,false,false,true' && opened2.length === 1 && opened2[0] === 'https://github.com/habit04/share/releases', `open-external refuses "..", encoded ".." and user-info links, opens the repository page (${links.join()} -> ${opened2.join(' ')})`);
    // Text from files is shown as text: a scale name from a DXF header and a dialog title with markup.
    const anno = await win.evaluate(async () => {
      const ed = window.editor;
      const before = ed.doc.header.cannoscale;
      const dirty = ed.doc.dirty;
      ed.doc.setHeader({ cannoscale: '<img src=x onerror="window.__e2eXss=1">1:2' });
      ed.notify('file');
      await new Promise((r) => setTimeout(r, 50));
      const el = document.querySelector('.status-annoscale');
      const out = { imgs: el ? el.querySelectorAll('img').length : -1, text: el ? el.textContent : '' };
      ed.doc.setHeader({ cannoscale: before });
      ed.doc.dirty = dirty;
      ed.notify('file');
      return { ...out, xss: /** @type {any} */ (window).__e2eXss === 1 };
    });
    check(anno.imgs === 0 && anno.text.includes('<img src=x') && !anno.xss, `an annotation scale name with markup shows as text in the status bar (${anno.imgs} img, "${anno.text.trim().slice(0, 50)}")`);
    const titles = await win.evaluate(async () => {
      const evil = '<img src=x onerror="window.__e2eXss=2">Plot <b>Title</b>';
      const read = () => {
        const dlg = [...document.querySelectorAll('.modal')].pop();
        const span = dlg && dlg.querySelector('.modal-title span');
        return { markup: dlg ? dlg.querySelectorAll('.modal-title img, .modal-title b').length : -1, text: span ? span.textContent : '', dlg };
      };
      void (/** @type {any} */ (window).jcadApi.ui.alert('body', evil));
      await new Promise((r) => setTimeout(r, 100));
      const a = read();
      /** @type {HTMLElement | null | undefined} */ (a.dlg?.querySelector('.modal-footer button'))?.click();
      void window.editor.ui.confirm(evil, 'body');
      await new Promise((r) => setTimeout(r, 100));
      const b = read();
      /** @type {HTMLElement | null | undefined} */ (b.dlg?.querySelector('.modal-footer button:last-child'))?.click();
      await new Promise((r) => setTimeout(r, 100));
      return { a: { markup: a.markup, text: a.text }, b: { markup: b.markup, text: b.text }, xss: /** @type {any} */ (window).__e2eXss === 2, left: document.querySelectorAll('.modal').length };
    });
    check(titles.a.markup === 0 && titles.a.text.startsWith('<img') && titles.b.markup === 0 && titles.b.text.startsWith('<img') && !titles.xss, `dialog titles with markup show as text (plugin dialog "${titles.a.text.slice(0, 30)}", confirm "${titles.b.text.slice(0, 30)}"; ${titles.left} dialog(s) left open)`);
    rmSync(accDir, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ symbolic links (security review E-5)
  // A save through a linked folder works (macOS /var, Silverblue /home, junctions); an image next to a
  // drawing known under the linked path is read; a destination that is itself a link is refused and
  // the file it points at stays as it was.
  step = 'links';
  if (current) {
    const linkRoot = mkdtempSync(join(tmpdir(), 'jcad-e2e-links-'));
    const realFolder = join(linkRoot, 'real');
    const linkedFolder = join(linkRoot, 'linked');
    mkdirSync(realFolder);
    symlinkSync(realFolder, linkedFolder, process.platform === 'win32' ? 'junction' : 'dir');
    const tinyDxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'ENDSEC', '0', 'EOF', ''].join('\n');
    const viaLink = join(linkedFolder, 'linked.dxf');
    await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), viaLink);
    const saved = await win.evaluate((t) => window.jcad.saveDxf(null, t, 'linked.dxf').then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e) })), tinyDxf);
    await messages();
    check(saved.ok && saved.r === viaLink && existsSync(join(realFolder, 'linked.dxf')), `a drawing saved through a linked folder lands in the real folder (${JSON.stringify(saved)})`);
    // Reproduce the background-fetch race deterministically through the existing net.fetch
    // double, after the first save's message drain. The old global-empty predicate always fails.
    await app.evaluate(async ({ net }, url) => { await net.fetch(url); }, releaseLatestUrl);
    const updatedDxf = tinyDxf.replace('ENDSEC', 'ENDSEC\n999\nagain');
    const again = await win.evaluate(([p, t]) => window.jcad.saveDxf(p, t, 'linked.dxf').then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e) })), [viaLink, updatedDxf]);
    const linkedMessages = await noDialogMessages();
    /** @param {string} file @param {Buffer} expected */
    const inspectLinkedFile = (file, expected) => {
      /** @type {{ path: string, canonicalPath?: string, regularFile?: boolean, bytes?: number, bytesMatch?: boolean, error?: string }} */
      const details = { path: file };
      try {
        details.canonicalPath = realpathSync.native(file);
        details.regularFile = lstatSync(file).isFile();
        const bytes = readFileSync(file);
        details.bytes = bytes.length;
        details.bytesMatch = bytes.equals(expected);
      } catch (error) {
        details.error = String(error);
      }
      return details;
    };
    const updatedBytes = Buffer.from(updatedDxf, 'utf8');
    const priorBytes = Buffer.from(tinyDxf, 'utf8');
    const realFile = inspectLinkedFile(join(realFolder, 'linked.dxf'), updatedBytes);
    const linkedFile = inspectLinkedFile(viaLink, updatedBytes);
    const returnedFile = inspectLinkedFile(typeof again.r === 'string' ? again.r : '', updatedBytes);
    const realBackup = inspectLinkedFile(join(realFolder, 'linked.dxf.bak'), priorBytes);
    const linkedBackup = inspectLinkedFile(`${viaLink}.bak`, priorBytes);
    const canonicalIdentity = realFile.canonicalPath !== undefined && realFile.canonicalPath === linkedFile.canonicalPath && realFile.canonicalPath === returnedFile.canonicalPath && realBackup.canonicalPath !== undefined && realBackup.canonicalPath === linkedBackup.canonicalPath;
    const filesMatch = [realFile, linkedFile, returnedFile, realBackup, linkedBackup].every((file) => file.regularFile && file.bytesMatch);
    const temporaryFiles = tmpLeftovers(realFolder);
    const backgroundFetchObserved = linkedMessages.raw.includes(`fetch:${releaseLatestUrl}`);
    check(again.ok && again.r === viaLink && backgroundFetchObserved && linkedMessages.unexpected.length === 0 && canonicalIdentity && filesMatch && temporaryFiles.length === 0, `saved again by name through the linked folder, with its .bak (${JSON.stringify({ reply: again, messages: linkedMessages, backgroundFetchObserved, canonicalIdentity, filesMatch, expectedUpdatedBytes: updatedBytes.length, expectedPriorBytes: priorBytes.length, realFile, linkedFile, returnedFile, realBackup, linkedBackup, temporaryFiles })})`);
    writeFileSync(join(realFolder, 'logo.png'), solidPng(4, 4, [0, 255, 0]));
    const linkedImage = await win.evaluate((p) => window.jcad.readImage(p).then((r) => (typeof r === 'string' && r.startsWith('data:image/png;base64,') ? 'read' : String(r)), (e) => String(e)), join(linkedFolder, 'logo.png'));
    check(linkedImage === 'read', `an image next to a drawing known under a linked path is read (${linkedImage})`);
    let fileLinks = true;
    const victim = join(linkRoot, 'victim.txt');
    writeFileSync(victim, 'VICTIM');
    const trap = join(realFolder, 'trap.dxf');
    try {
      symlinkSync(victim, trap, 'file');
    } catch {
      fileLinks = false; // Windows without the privilege to create file links
    }
    if (fileLinks) {
      await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), trap);
      const trapped = await win.evaluate((t) => window.jcad.saveDxf(null, t, 'trap.dxf').then((r) => ({ ok: true, r }), (e) => ({ ok: false, e: String(e) })), tinyDxf);
      await messages();
      check(!trapped.ok && /ELOOP/.test(trapped.e) && readFileSync(victim, 'utf8') === 'VICTIM' && lstatSync(trap).isSymbolicLink(), `a save onto a symbolic link is refused (ELOOP) and the file it points at is unchanged (${JSON.stringify(trapped).slice(0, 160)})`);
    } else ok('file symbolic links cannot be created here: the refused-link save is checked by the unit tests');
    rmSync(linkRoot, { recursive: true, force: true });
  }

  // ------------------------------------------------------------------ web permissions (security review E-12)
  step = 'permissions';
  if (current) {
    const perms = await win.evaluate(async () => {
      const q = async (/** @type {string} */ name) => {
        try {
          return (await navigator.permissions.query(/** @type {PermissionDescriptor} */ ({ name }))).state;
        } catch (e) {
          return `error ${String(e)}`;
        }
      };
      const notification = typeof Notification === 'undefined' ? 'none' : await Notification.requestPermission();
      const media = await navigator.mediaDevices.getUserMedia({ audio: true }).then(
        () => 'granted',
        (e) => /** @type {Error} */ (e).name,
      );
      const popup = window.open('https://example.com/', '_blank');
      return { geolocation: await q('geolocation'), camera: await q('camera'), notification, media, popup: popup === null ? 'blocked' : 'opened' };
    });
    check(perms.geolocation === 'denied' && perms.camera === 'denied' && perms.notification === 'denied' && perms.media !== 'granted' && perms.popup === 'blocked', `web permissions are denied and pop-ups blocked (${JSON.stringify(perms)})`);
    // The one permission the page keeps: writing the clipboard (Copy Full File Path, the report
    // copy buttons use navigator.clipboard.writeText).
    const token = `jcad-e2e-clipboard-${Date.now()}`;
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())?.focus());
    const wrote = await win.evaluate(async (t) => navigator.clipboard.writeText(t).then(() => 'ok', (e) => `${e && e.name}: ${e && e.message}`), token);
    const pasted = await app.evaluate(({ clipboard }) => clipboard.readText());
    check(wrote === 'ok' && pasted === token, `clipboard writes from the page still work (writeText: ${wrote}; clipboard holds ${JSON.stringify(pasted.slice(0, 40))})`);
  }

  // ------------------------------------------------------------------ Symbol Builder
  step = 'Symbol Builder';
  const tabsBefore = await win.evaluate(() => window.editor.sessions.count);
  // Dispatch as a human command entry; the next steps complete the pending dialog.
  await win.evaluate(() => void window.editor.runCommand('AESYMBUILDER'));
  const start = win.locator('.modal').last();
  await start.waitFor({ timeout: 10_000 });
  check(/Symbol Builder/i.test(await start.textContent()), 'AESYMBUILDER shows the start dialog');
  await start.locator('.btn.primary').last().click();
  await win.waitForFunction(() => !document.getElementById('symbol-builder').classList.contains('hidden'), null, { timeout: 10_000 }).then(
    () => ok('Symbol Builder palette is shown'),
    () => bad('Symbol Builder palette did not appear'),
  );
  check((await win.evaluate(() => window.editor.sessions.count)) === tabsBefore + 1, 'Symbol Builder opened its own tab');
  // show() reveals the palette before its requestAnimationFrame render adds the actions.
  const symbolActionsReady = await win.waitForFunction(() => document.querySelectorAll('#symbol-builder .sb-actions button').length > 0, null, { timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  check(symbolActionsReady, 'Symbol Builder actions are present');
  if (process.env.JCAD_E2E_OUT) await win.screenshot({ path: join(outDir, `window-${process.platform}.png`) });

  // ------------------------------------------------------------------ crash-safe saves, save errors, backups
  step = 'save';
  const saveDir = mkdtempSync(join(tmpdir(), 'jcad-e2e-save-'));
  const good = join(saveDir, 'recovered.dxf');
  const missingFolder = join(saveDir, 'no-such-folder', 'recovered.dxf');
  // Work in the recovered drawing (it still writes to its adopted backup).
  await win.evaluate((name) => {
    const ed = window.editor;
    const i = ed.sessions.all.findIndex((x) => window.jacUi.autosaver.nameFor(x.id) === name);
    if (i >= 0) ed.sessions.switchTo(i);
  }, panelBackup);
  check(await win.evaluate((name) => window.jacUi.autosaver.nameFor(window.editor.sessions.current.id) === name, panelBackup), 'the recovered drawing is active');
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('AUTOSAVE'));
  await waitLog(/drawing\(s\) autosaved/, h, 15_000).catch(() => bad('AUTOSAVE did not finish'));
  check(existsSync(join(autosaveDir, panelBackup)) && tmpLeftovers(autosaveDir).length === 0, 'AUTOSAVE refreshed the adopted backup without leaving temporary files');

  // A save into a folder that does not exist fails: error dialog, still modified, backup kept.
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), missingFolder);
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('SAVEAS'));
  const errDlg = win.locator('.save-error-dialog .modal');
  await errDlg.waitFor({ timeout: 10_000 }).then(
    () => ok('a failed save shows the Save Failed dialog'),
    () => bad('no Save Failed dialog'),
  );
  const errText = (await errDlg.textContent()) ?? '';
  check(/"recovered\.dxf" could not be saved: .*is not available/.test(errText) && /still marked as modified/.test(errText), `the dialog explains the failure (${errText.slice(0, 200)})`);
  check(['Retry', 'Save As...', 'Cancel'].every((b) => errText.includes(b)), 'the dialog offers Retry, Save As... and Cancel');
  check(await win.evaluate(() => window.editor.doc.dirty), 'the drawing is still modified after the failed save');
  check(existsSync(join(autosaveDir, panelBackup)), 'the autosave backup is kept after the failed save');
  check((await logSince(h)).some((l) => l.startsWith('Save failed: "recovered.dxf" could not be saved')), 'the command log names the failure');
  // Retry (Save As again, same bad folder) fails again; then Save As... to a good place works.
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), missingFolder);
  await errDlg.locator('button', { hasText: 'Retry' }).click();
  await win.waitForFunction(() => document.querySelectorAll('.save-error-dialog').length === 1, null, { timeout: 10_000 }).catch(() => {});
  await errDlg.waitFor({ timeout: 10_000 });
  check((await win.locator('.save-error-dialog').count()) === 1, 'Retry tried again and reported the failure again');
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), good);
  h = await historyLen();
  await win.locator('.save-error-dialog button', { hasText: 'Save As...' }).click();
  await waitLog(/^Saved /, h, 15_000).catch(() => bad('Save As... after the error did not save'));
  check(existsSync(good) && !existsSync(`${good}.bak`) && tmpLeftovers(saveDir).length === 0, `Save As... wrote the drawing (${readdirSync(saveDir).join(', ')})`);
  check(!(await win.evaluate(() => window.editor.doc.dirty)), 'the drawing is clean after the save');
  let backupGone = false;
  for (let i = 0; i < 100 && !backupGone; i += 1) {
    backupGone = !existsSync(join(autosaveDir, panelBackup)) && !readIndex()[panelBackup];
    if (!backupGone) await win.waitForTimeout(100);
  }
  check(backupGone && !existsSync(join(autosaveDir, panelBackup)) && !readIndex()[panelBackup], 'the saved revision removed its recovery backup');

  // Saving again keeps the previous version as <name>.bak.
  const firstContent = readFileSync(good, 'utf8');
  await win.evaluate(() => window.editor.doc.addEntities([{ id: 'e2e-bak', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 3, y: 4 } }]));
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('SAVE'));
  await waitLog(/^Saved /, h, 15_000).catch(() => bad('SAVE did not finish'));
  check(existsSync(`${good}.bak`) && readFileSync(`${good}.bak`, 'utf8') === firstContent && readFileSync(good, 'utf8') !== firstContent, 'SAVE kept the previous version as recovered.dxf.bak');
  check(tmpLeftovers(saveDir).length === 0, 'no temporary files next to the drawing');
  check((await messages()).filter((m) => m.startsWith('save:')).length === 3, 'SAVE of a known file asked no dialog');

  // backup-file: { ok, path } or { ok: false, error }, never a silent success.
  const sourceBeforeBackup = readFileSync(good);
  let backupSource = good;
  if (protectedOpenedSources) {
    const priorBackup = readFileSync(`${good}.bak`);
    const protectedBackup = await win.evaluate((p) => window.jcad.backupFile(p), good);
    check(protectedBackup?.ok === false && protectedBackup.code === 'ERR_OPENED_SOURCE_PROOF' && readFileSync(good).equals(sourceBeforeBackup) && readFileSync(`${good}.bak`).equals(priorBackup), `raw backup of the live opened drawing requires its source proof and preserves both files (${JSON.stringify(protectedBackup)})`);
    // Keep the successful standalone backup/missing-file gate on a separately
    // chosen closed copy, without releasing the active drawing's proof.
    backupSource = join(saveDir, 'closed-backup.dxf');
    await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), backupSource);
    const copied = await win.evaluate((text) => window.jcad.saveDxf(null, text, 'closed-backup.dxf'), sourceBeforeBackup.toString('utf8'));
    const copyMessages = await messages();
    check(copied === backupSource && copyMessages.includes('save:Save Drawing As') && readFileSync(backupSource).equals(sourceBeforeBackup) && await win.evaluate((p) => window.editor.doc.filePath === p && !window.editor.doc.dirty, good), 'a separate native-chosen closed copy keeps exact bytes and leaves the Editor drawing bound and clean');
  }
  const b1 = await win.evaluate((p) => window.jcad.backupFile(p), backupSource);
  let backupMatches = false;
  /** @type {Record<string, unknown>} */
  const backupDetails = { reply: b1, expectedPath: `${backupSource}.bak` };
  try {
    if (!b1 || b1.ok !== true || typeof b1.path !== 'string') throw new Error('backup-file did not return a successful destination');
    // The writer returns its pinned destination: Windows 8.3 names and macOS /var aliases
    // can differ from the dialog's spelling while naming exactly the same backup file.
    const expectedPath = realpathSync.native(`${backupSource}.bak`);
    const returnedPath = realpathSync.native(b1.path);
    const expectedBytes = readFileSync(`${backupSource}.bak`);
    const returnedBytes = readFileSync(b1.path);
    const sourceAfterBackup = readFileSync(backupSource);
    const sameDestination = expectedPath === returnedPath;
    const regularFiles = lstatSync(`${backupSource}.bak`).isFile() && lstatSync(b1.path).isFile();
    const expectedBytesMatch = expectedBytes.equals(sourceBeforeBackup);
    const returnedBytesMatch = returnedBytes.equals(sourceBeforeBackup);
    const sourceUnchanged = sourceAfterBackup.equals(sourceBeforeBackup);
    Object.assign(backupDetails, { expectedPath, returnedPath, sameDestination, regularFiles, sourceBytes: sourceBeforeBackup.length, expectedBytes: expectedBytes.length, returnedBytes: returnedBytes.length, expectedBytesMatch, returnedBytesMatch, sourceUnchanged });
    backupMatches = sameDestination && regularFiles && expectedBytesMatch && returnedBytesMatch && sourceUnchanged;
  } catch (error) {
    backupDetails.error = String(error);
  }
  check(backupMatches, `backup-file copied the drawing (${JSON.stringify(backupDetails)})`);
  // A path the main process never handed out (no dialog, recent list or project named it) is refused like save-dxf refuses it.
  const b2 = await win.evaluate((p) => window.jcad.backupFile(p), join(saveDir, 'stranger.dxf'));
  check(b2 && b2.ok === false && b2.code === 'EINVAL' && /^The backup copy of "stranger\.dxf" could not be made: only drawings and project files you opened or saved yourself/.test(b2.error), `backup-file refuses a path outside the allow-list (${JSON.stringify(b2)})`);
  // A known path whose file is gone: a clear message, no .bak.
  renameSync(backupSource, `${backupSource}.moved`);
  const b2b = await win.evaluate((p) => window.jcad.backupFile(p), backupSource);
  renameSync(`${backupSource}.moved`, backupSource);
  const missingBackupName = protectedOpenedSources ? 'closed-backup.dxf' : 'recovered.dxf';
  check(b2b && b2b.ok === false && b2b.code === 'ENOENT' && b2b.error.startsWith(`The backup copy of "${missingBackupName}" could not be made:`) && /is not available/.test(b2b.error), `backup-file reports a missing file (${JSON.stringify(b2b)})`);
  const b3 = await win.evaluate(() => window.jcad.backupFile('relative.dxf'));
  check(b3 && b3.ok === false && b3.code === 'EINVAL', `backup-file refuses relative paths (${JSON.stringify(b3)})`);

  // An unreadable recovery folder is an error state, not "nothing to recover".
  step = 'recovery error';
  renameSync(autosaveDir, `${autosaveDir}-moved`);
  writeFileSync(autosaveDir, 'not a folder');
  await win.evaluate(() => void window.editor.runCommand('DRAWINGRECOVERY'));
  const recErr = win.locator('.recovery-error-state .modal');
  await recErr.waitFor({ timeout: 10_000 }).then(
    () => ok('an unreadable recovery folder shows an error'),
    () => bad('no error state for an unreadable recovery folder'),
  );
  check(/The recovery folder could not be read/.test((await recErr.textContent()) ?? ''), 'the error names the recovery folder');
  rmSync(autosaveDir, { force: true });
  renameSync(`${autosaveDir}-moved`, autosaveDir);
  h = await historyLen();
  await recErr.locator('button', { hasText: 'Retry' }).click();
  await waitLog(/no autosaved drawings to recover/, h, 10_000).then(
    () => ok('Retry reads the folder again (only this session\'s own backups there: nothing to offer)'),
    () => bad('Retry did not read the recovery folder again'),
  );

  rmSync(saveDir, { recursive: true, force: true });
  // ------------------------------------------------------------------ project: paths, Save As, dirty flag
  step = 'project';
  const projDir = mkdtempSync(join(tmpdir(), 'jcad-e2e-proj-'));
  mkdirSync(join(projDir, 'proj', 'dwg'), { recursive: true });
  mkdirSync(join(projDir, 'archive'), { recursive: true });
  writeFileSync(join(projDir, 'proj', 'dwg', 'a.dxf'), readFileSync(fixtures.dxf));
  writeFileSync(join(projDir, 'proj', 'b.dxf'), readFileSync(fixtures.dxf));
  const projFile = join(projDir, 'proj', 'line.jcadproj.json');
  // Entries as a project written on Windows ("dwg\a.dxf") and with a "." segment: main.cjs registers them
  // and the renderer resolves them (src/app/paths.ts) to the same paths.
  writeFileSync(projFile, JSON.stringify({ name: 'E2E Line', drawings: [{ file: 'dwg\\a.dxf' }, { file: './b.dxf' }] }));
  await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), projFile);
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('OPENPROJECT'));
  await waitLog(/^(Project E2E Line|Failed to open project)/, h).catch(() => bad('no project open result logged'));
  check(await win.evaluate(() => window.editor.project.name === 'E2E Line' && window.editor.project.drawings.length === 2 && !window.editor.projectDirty), 'OPENPROJECT loaded the project, unmodified');
  for (const i of [0, 1]) {
    h = await historyLen();
    await win.locator(`.project-tree [data-index="${i}"]`).dispatchEvent('dblclick');
    await waitLog(/^(Opened|Failed to open)/, h, 15_000).catch(() => bad(`project drawing ${i} did not open`));
    log = await logSince(h);
    const line = log.find((l) => /^(Opened|Failed)/.test(l)) ?? '';
    const want = i === 0 ? join(projDir, 'proj', 'dwg', 'a.dxf') : join(projDir, 'proj', 'b.dxf');
    check(line.startsWith(`Opened ${want}:`), `project drawing ${i} opened by its resolved path: ${line}`);
    while ((await win.locator('.import-report-dialog').count()) > 0)
      await win.locator('.import-report-dialog .modal button', { hasText: 'Close' }).last().click();
  }
  // A project change marks the project modified; Save As into another folder keeps the entries pointing at the same files.
  await win.evaluate(() => window.editor.updateProject({ ...window.editor.project, descriptions: ['E2E CUSTOMER'] }));
  check(await win.evaluate(() => window.editor.projectDirty), 'a project property change marks the project modified');
  const projectCopy = join(projDir, 'archive', 'line2.jcadproj.json');
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), projectCopy);
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('PROJECTSAVEAS'));
  await waitLog(/^(Project saved|Project not saved)/, h).catch(() => bad('PROJECTSAVEAS logged nothing'));
  check((await messages()).includes('save:Save Project As'), 'PROJECTSAVEAS asked where to save');
  const savedProject = existsSync(projectCopy) ? JSON.parse(readFileSync(projectCopy, 'utf8')) : null;
  check(JSON.stringify(savedProject?.drawings.map((d) => d.file)) === JSON.stringify(['../proj/dwg/a.dxf', '../proj/b.dxf']), `relative paths recalculated for the new folder: ${JSON.stringify(savedProject?.drawings)}`);
  check(await win.evaluate((p) => window.editor.project.path === p && !window.editor.projectDirty, projectCopy), 'the project now lives at the new path, unmodified');
  // The backup channel uses the same path identity: a project drawing named with "." / ".." segments is known.
  const projectDrawing = join(projDir, 'proj', 'b.dxf'), projectAlias = `${projDir}/proj/./dwg/../b.dxf`;
  if (protectedOpenedSources) {
    const sourceBytes = readFileSync(projectDrawing), priorBackup = existsSync(`${projectDrawing}.bak`) ? readFileSync(`${projectDrawing}.bak`) : null;
    const protectedAlias = await win.evaluate((p) => window.jcad.backupFile(p), projectAlias);
    check(protectedAlias?.ok === false && protectedAlias.code === 'ERR_OPENED_SOURCE_PROOF' && readFileSync(projectDrawing).equals(sourceBytes) && (priorBackup === null ? !existsSync(`${projectDrawing}.bak`) : readFileSync(`${projectDrawing}.bak`).equals(priorBackup)), `raw project alias backup retains the open drawing's source protection and exact prior bytes (${JSON.stringify(protectedAlias)})`);
    const closed = await win.evaluate((p) => {
      const sessions = window.editor.sessions, index = sessions.indexOfPath(p);
      if (index < 0 || sessions.isDirty(index)) return false;
      sessions.close(index); return sessions.indexOfPath(p) < 0;
    }, projectDrawing);
    check(closed, 'normal closure of the clean project drawing releases its Editor-owned proof');
  }
  const bProj = await win.evaluate((p) => window.jcad.backupFile(p), projectAlias);
  check(bProj && bProj.ok === true && existsSync(join(projDir, 'proj', 'b.dxf.bak')), `backup-file accepts another spelling of a project drawing (${JSON.stringify(bProj)})`);
  if (bProj?.ok === true) check(readFileSync(`${projectDrawing}.bak`).equals(readFileSync(projectDrawing)) && readFileSync(projectDrawing).equals(readFileSync(fixtures.dxf)), 'project alias backup contains the complete exact source and leaves the drawing unchanged');
  // Opening another project while this one has unsaved changes asks first; Cancel keeps it.
  await win.evaluate(() => window.editor.updateProject({ ...window.editor.project, description: 'pending' }));
  await win.evaluate(() => void window.editor.runCommand('OPENPROJECT'));
  const ask = win.locator('.modal', { hasText: 'Save changes to project E2E Line?' });
  await ask.waitFor({ timeout: 10_000 }).then(
    () => ok('OPENPROJECT with a modified project asks Save / Don\'t Save / Cancel'),
    () => bad('no save-changes question before opening another project'),
  );
  await ask.locator('button', { hasText: 'Cancel' }).click();
  await win.waitForTimeout(200);
  check((await messages()).every((m) => m !== 'open:Open Project'), 'Cancel: no Open dialog was shown');
  check(await win.evaluate(() => window.editor.project.description === 'pending' && window.editor.projectDirty), 'Cancel: the modified project stays open');

  // ------------------------------------------------------------------ a damaged drawing finishing its open in a background tab
  step = 'background open';
  const bgDir = mkdtempSync(join(tmpdir(), 'jcad-e2e-bg-'));
  const cutShort = join(bgDir, 'cut-short.dxf');
  writeFileSync(cutShort, readFileSync(fixtures.dxf, 'latin1').replace(/\r?\n\s*0\r?\nEOF\s*$/, '\r\n'), 'latin1');
  // open-drawing answers slowly (the real handler, delayed): the user goes back to the first tab meanwhile.
  await app.evaluate(({ ipcMain }) => {
    // Electron keeps invoke handlers in a private map; the test reaches for it to wrap the real handler.
    const orig = /** @type {any} */ (ipcMain)._invokeHandlers.get('open-drawing');
    globalThis.__e2e.origOpen = orig;
    ipcMain.removeHandler('open-drawing');
    ipcMain.handle('open-drawing', async (ev, f) => {
      await new Promise((r) => setTimeout(r, 1500));
      return orig(ev, f);
    });
  });
  await win.evaluate(() => window.editor.sessions.switchTo(0));
  const firstTab = await win.evaluate(() => ({ id: window.editor.sessions.current.id, dirty: window.editor.doc.dirty, path: window.editor.doc.filePath }));
  await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), cutShort);
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('OPEN'));
  await win.waitForTimeout(150);
  await win.evaluate(() => window.editor.sessions.switchTo(0));
  const damaged = win.locator('.modal', { hasText: 'Damaged drawing file' });
  await damaged.waitFor({ timeout: 15_000 }).then(
    async () => {
      check(/end-of-file marker is missing/.test((await damaged.textContent()) ?? ''), 'a file that ends early asks whether to open what was readable');
      await damaged.locator('button', { hasText: 'Yes' }).click();
    },
    () => bad('no damaged-file question for a file without its end-of-file marker'),
  );
  await waitLog(/^(Opened|Failed to open|Not opened)/, h, 15_000).catch(() => bad('the background open logged nothing'));
  log = await logSince(h);
  check(log.some((l) => l.startsWith(`Opened ${cutShort}:`) && l.endsWith('(in the tab it was opened from)')), `the drawing landed in the tab that started the open: ${log.filter((l) => /Opened|Failed/.test(l)).join(' | ')}`);
  const recoveredReport = win.locator('.import-report-dialog .modal', { hasText: 'Recovered Drawing' });
  await recoveredReport.waitFor({ timeout: 5000 }).then(
    async () => {
      check(/cut-short\.dxf is damaged/.test((await recoveredReport.textContent()) ?? ''), 'the report names the background drawing, not the active one');
      await recoveredReport.locator('button', { hasText: 'Close' }).click();
    },
    () => bad('no import report for the drawing recovered in the background'),
  );
  const bg = await win.evaluate((p) => {
    const ed = window.editor;
    const s = ed.sessions.all.find((x) => x.filePath === p);
    return s ? { id: s.id, dirty: s.dirty, recovered: !!s.state.meta?.importReport?.recovered, active: ed.sessions.current.id, activeDirty: ed.doc.dirty, activePath: ed.doc.filePath } : null;
  }, cutShort);
  check(!!bg && bg.dirty && bg.recovered, `the background tab is recovered and modified (${JSON.stringify(bg)})`);
  check(!!bg && bg.active === firstTab.id && bg.activeDirty === firstTab.dirty && bg.activePath === firstTab.path, 'the tab the user switched to is unchanged');
  h = await historyLen();
  await win.evaluate(() => void window.editor.runCommand('AUTOSAVE'));
  await waitLog(/drawing\(s\) autosaved/, h, 15_000).catch(() => bad('AUTOSAVE did not finish'));
  const bgBackup = await win.evaluate((id) => window.jacUi.autosaver.nameFor(id) ?? null, bg?.id);
  const bgEntry = bgBackup ? readIndex()[bgBackup] : null;
  check(!!bgBackup && ID_FILE.test(bgBackup) && bgEntry?.title === 'cut-short.dxf' && bgEntry?.originalPath === cutShort, `the background drawing is autosaved under its permanent id (${bgBackup}: ${JSON.stringify(bgEntry)})`);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('open-drawing');
    ipcMain.handle('open-drawing', globalThis.__e2e.origOpen);
  });

  // ------------------------------------------------------------------ errors so far
  step = 'renderer errors';
  check(pageErrors.length === 0, `no page / console errors${pageErrors.length ? `: ${pageErrors.slice(0, 5).join(' | ')}` : ''}`);
  const unknown = (await win.evaluate(() => window.editor.history)).filter((l) => /Unknown command|TypeError|ReferenceError/.test(l));
  check(unknown.length === 0, `command history is clean${unknown.length ? `: ${unknown.join(' | ')}` : ''}`);

  // ------------------------------------------------------------------ close: Save All workflow
  step = 'close';
  await win.evaluate(() => window.editor.updateProject({ ...window.editor.project, description: 'unsaved e2e change' }));
  const unsaved = await win.evaluate(() => ({ drawings: window.editor.sessions.all.filter((s) => s.dirty).length, project: window.editor.projectDirty }));
  check(unsaved.drawings >= 2 && unsaved.project, `unsaved work before closing: ${unsaved.drawings} modified tab(s) (LINE drawing, Symbol Builder ...), project modified ${unsaved.project}`);
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const requestWindowClose = () => app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0].close());
  const saveAll = win.locator('.modal', { hasText: 'Save them before closing' });
  await messages();
  await requestWindowClose();
  await saveAll.waitFor({ timeout: 10_000 });
  const listed = await saveAll.locator('.save-all-row').allTextContents();
  check(listed.some((t) => /Drawing1\.dxf/.test(t)) && listed.some((t) => /Symbol/.test(t)) && listed.some((t) => /E2E Line.*Project/.test(t)), `one Save All dialog lists the drawings, the symbol tab and the project: ${listed.map((t) => t.trim()).join(' | ')}`);
  // The main process waits for the renderer's answer: longer than its "not responding" fallback, no close.
  await win.waitForTimeout(6000);
  const waited = await messages();
  check((await windowCount()) === 1 && !waited.some((m) => m.startsWith('boxsync:')), `the window stays open while the dialog waits (no premature close, no native fallback)${waited.length ? `: ${waited.join(' ; ')}` : ''}`);
  await saveAll.locator('button', { hasText: 'Cancel' }).click();
  await win.waitForTimeout(300);
  check((await windowCount()) === 1, 'Cancel keeps the window open');

  // Only Drawing1 ticked and its Save As dialog cancelled: the close is aborted and the failure named.
  const tickOnly = async (keep) => {
    const rows = saveAll.locator('.save-all-row');
    for (let i = 0; i < (await rows.count()); i += 1) {
      const title = (await rows.nth(i).locator('b').textContent()) ?? '';
      const box = rows.nth(i).locator('input[type=checkbox]');
      if (keep.includes(title)) await box.check();
      else await box.uncheck();
    }
  };
  await requestWindowClose();
  await saveAll.waitFor({ timeout: 10_000 });
  await tickOnly(['Drawing1.dxf']);
  check((await saveAll.locator('.btn.primary').textContent()) === 'Save Selected', 'unticking items turns Save All into Save Selected');
  await saveAll.locator('.btn.primary').click();
  const failed = win.locator('.modal', { hasText: 'could not be saved' });
  await failed.waitFor({ timeout: 10_000 }).then(
    async () => ok(`a failed save aborts the close: "${(await failed.locator('.modal-body p').first().textContent())?.trim()}"`),
    () => bad('no Save Failed dialog after the cancelled Save As'),
  );
  check(/Drawing1\.dxf/.test((await failed.textContent()) ?? ''), 'the error names the drawing');
  await failed.locator('button', { hasText: 'OK' }).click();
  await win.waitForTimeout(300);
  check((await windowCount()) === 1, 'the window is still open after the failed save');
  check((await messages()).includes('save:Save Drawing As'), 'the Save As dialog was requested for the untitled drawing');

  // A write error while closing: first the Save Failed question for that drawing (Retry / Save As... /
  // Cancel), then why the close stopped. A second close request meanwhile stacks nothing; Cancel keeps
  // the window open and the drawing modified, and the next close asks again.
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), join(outDir, 'no-such-folder', 'drawing1.dxf'));
  await requestWindowClose();
  await saveAll.waitFor({ timeout: 10_000 });
  await tickOnly(['Drawing1.dxf']);
  await saveAll.locator('.btn.primary').click();
  const closeErr = win.locator('.save-error-dialog .modal');
  await closeErr.waitFor({ timeout: 10_000 }).then(
    async () => check(/"drawing1\.dxf" could not be saved: .*is not available/.test((await closeErr.textContent()) ?? ''), 'a write error while closing shows the Save Failed question first'),
    () => bad('no Save Failed question for a write error while closing'),
  );
  await requestWindowClose();
  await win.waitForTimeout(600);
  check((await win.locator('.modal', { hasText: 'Save them before closing' }).count()) === 0 && (await windowCount()) === 1, 'another close request while the question is up shows no second Save All dialog');
  await closeErr.locator('button', { hasText: 'Cancel' }).click();
  const stopped = win.locator('.modal', { hasText: 'Nothing was closed' });
  await stopped.waitFor({ timeout: 10_000 }).then(
    async () => {
      const why = (await stopped.locator('.modal-body p').first().textContent()) ?? '';
      check(/^"drawing1\.dxf" could not be saved: .*is not available/.test(why) && !/could not be saved.*could not be saved/.test(why), `then the close stops with the same reason, said once ("${why.slice(0, 80)}")`);
      await stopped.locator('button', { hasText: 'OK' }).click();
    },
    () => bad('no "close stopped" message after Cancel in the Save Failed question'),
  );
  await win.waitForTimeout(300);
  const remainingDialogTitles = await win.locator('.modal .modal-title').allTextContents();
  check((await windowCount()) === 1 && remainingDialogTitles.length === 0, `the window is open with no dialog left after Cancel${remainingDialogTitles.length ? ` (${remainingDialogTitles.join(' | ')})` : ''}`);
  check(await win.evaluate(() => window.editor.sessions.all.some((s, i) => window.editor.sessions.titleOf(i) === 'Drawing1.dxf' && s.dirty)), 'Drawing1 is still modified');

  // Drawing1 and the project saved (in that order, each awaited), everything else discarded: the window closes.
  const savedDrawing = join(outDir, 'closed-drawing1.dxf');
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), savedDrawing);
  // An autosave is being written when the close starts, and saving Drawing1 removes its backup: both are
  // made slow (the real handlers, delayed) and must finish before the window goes away.
  const drawing1Backup = await win.evaluate(() => {
    const s = window.editor.sessions.all.find((x) => window.editor.sessions.titleOf(window.editor.sessions.all.indexOf(x)) === 'Drawing1.dxf');
    return s ? (window.jacUi.autosaver.nameFor(s.id) ?? null) : null;
  });
  check(!!drawing1Backup && !!readIndex()[drawing1Backup], `Drawing1 has an autosave backup before the close (${drawing1Backup})`);
  await app.evaluate(({ ipcMain }) => {
    for (const [ch, ms] of /** @type {Array<[string, number]>} */ ([['autosave-write', 1200], ['autosave-remove', 600]])) {
      const orig = /** @type {any} */ (ipcMain)._invokeHandlers.get(ch);
      ipcMain.removeHandler(ch);
      ipcMain.handle(ch, async (ev, ...a) => {
        await new Promise((r) => setTimeout(r, ms));
        return orig(ev, ...a);
      });
    }
  });
  await win.evaluate((p) => {
    const ed = window.editor;
    const i = ed.sessions.all.findIndex((x) => x.filePath === p);
    ed.sessions.switchTo(i);
    ed.doc.addEntities([{ id: 'e2e-in-flight', type: 'text', layer: '0', color: 'ByLayer', position: { x: 1, y: 1 }, text: 'E2E IN FLIGHT', height: 0.2, rotation: 0, align: 'left' }]);
    ed.runCommand('AUTOSAVE');
  }, cutShort);
  // The page's 'close' (the window is gone): on macOS the application keeps running without windows.
  const closed = win.waitForEvent('close', { timeout: 30_000 }).then(
    () => true,
    () => false,
  );
  await requestWindowClose();
  await saveAll.waitFor({ timeout: 10_000 });
  await tickOnly(['Drawing1.dxf', 'E2E Line']);
  await saveAll.locator('.btn.primary').click();
  const didClose = await closed;
  check(didClose, 'the window closed after Save Selected');
  check(existsSync(savedDrawing) && /\nLINE\r?\n/.test(readFileSync(savedDrawing, 'utf8')), `Drawing1 was written before the close (${savedDrawing})`);
  const finalProject = existsSync(projectCopy) ? JSON.parse(readFileSync(projectCopy, 'utf8')) : null;
  check(finalProject?.description === 'unsaved e2e change', `the project was saved to ${projectCopy} before the close`);
  check(!existsSync(join(autosaveDir, drawing1Backup ?? 'none')) && !readIndex()[drawing1Backup ?? 'none'], 'the backup of the drawing saved while closing was removed before the window went away');
  check(bgBackup && readFileSync(join(autosaveDir, bgBackup), 'latin1').includes('E2E IN FLIGHT') && readIndex()[bgBackup]?.title === 'cut-short.dxf', 'the autosave written during the close finished (the discarded drawing stays recoverable)');
  rmSync(projDir, { recursive: true, force: true });
  rmSync(bgDir, { recursive: true, force: true });
} catch (err) {
  bad(`unexpected: ${err && err.stack ? err.stack : err}`);
} finally {
  try {
    await closeTestApplication(app, firstProcess);
  } catch (err) {
    bad(`cleanup: ${err}`);
  }
  clearTimeout(hardTimeout);
}

// ------------------------------------------------------------------ crash and relaunch: Project Recovery and Drawing Recovery
// A second start makes the project modified (it is autosaved) and is then killed; the third start must
// offer the project in Project Recovery (its autosave keeps its name) and only drawings in the Drawing
// Recovery Manager.
step = 'crash recovery';
const relaunchTimeout = setTimeout(() => {
  console.error('e2e-electron: crash recovery timed out after 3 minutes');
  process.exit(1);
}, 3 * 60 * 1000);
const lostTheLock = (err) => /has been closed|Target closed/i.test(String(err && err.message ? err.message : err));
// A start right after the previous instance went away can lose the single-instance lock to that
// instance while it still shuts down (on Windows the helper processes of a killed instance linger
// for a while): such a start quits at once (main.cjs: requestSingleInstanceLock) and Playwright
// reports "browser has been closed". It is tried again every second for up to 30 s.
const launch = async () => {
  for (let attempt = 1; ; attempt += 1) {
    const a = await electron.launch(packaged ? { executablePath: executable, args, env, timeout: 90_000 } : { args, cwd: repo, env, timeout: 60_000 }).catch((err) => {
      if (attempt < 30 && lostTheLock(err)) return null;
      throw err;
    });
    if (a) {
      a.process().stdout?.on('data', (d) => mainLog.push(String(d)));
      a.process().stderr?.on('data', (d) => mainLog.push(String(d)));
      try {
        const w = await applicationWindow(a);
        await w.waitForFunction(() => !!window.editor, null, { timeout: 30_000 });
        if (attempt > 1) console.warn(`e2e-electron: the instance started at attempt ${attempt} (the previous one held the lock for about ${attempt - 1} s)`);
        return { a, w };
      } catch (err) {
        if (!(attempt < 30 && lostTheLock(err))) throw err;
        await closeTestApplication(a);
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
};
const projectBackups = () => readdirSync(autosaveDir).filter((f) => f.endsWith('_jcadproj.sv.dxf'));
const recoveryRows = async (w) => (await w.locator('.recovery-dialog .recovery-row').allTextContents()).map((t) => t.trim());
let second = null;
let third = null;
try {
  // The first instance quits by itself once its window is gone; give it time to release the lock.
  if (!(await waitForExit(firstProcess, 30_000))) console.warn('e2e-electron: the first instance has not exited 30 s after its window closed');
  second = await launch();
  const rec2 = second.w.locator('.recovery-dialog .modal');
  await rec2.waitFor({ timeout: 15_000 }).then(
    async () => {
      const rows = await recoveryRows(second.w);
      check(rows.some((r) => r.includes('cut-short.dxf')), `the drawing discarded when closing is offered at the next start (${rows.length} row(s))`);
      await rec2.locator('button', { hasText: 'Close' }).click();
    },
    () => bad('no Drawing Recovery Manager for the backups kept when closing'),
  );
  await second.w.evaluate(() => {
    const ed = window.editor;
    ed.replaceProject({ name: 'Crash Test', drawings: [] });
    ed.updateProject({ ...ed.project, description: 'not saved before the crash' });
  });
  let found = [];
  for (let i = 0; i < 100 && found.length === 0; i += 1) {
    found = projectBackups();
    if (!found.length) await second.w.waitForTimeout(100);
  }
  check(found.length === 1, `the modified project was autosaved (${found.join(', ') || readdirSync(autosaveDir).join(', ')})`);
  // The crash: kill the main process. On Windows that leaves the helper processes behind (they
  // keep the profile and the single-instance lock busy), so the whole tree goes, as a crash would.
  const crashed = second.a.process();
  const exited = waitForExit(crashed, 30_000);
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(crashed.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5_000, windowsHide: true });
  else crashed.kill('SIGKILL');
  if (!(await exited)) throw new Error('The test instance did not exit after the simulated crash; retaining it for bounded cleanup.');
  second = null;

  third = await launch();
  const pr = third.w.locator('.modal', { hasText: 'Project Recovery' });
  await pr.waitFor({ timeout: 15_000 }).then(
    async () => {
      check(/Crash Test/.test((await pr.textContent()) ?? ''), 'Project Recovery names the project');
      await pr.locator('button', { hasText: 'Open Recovered Project' }).click();
    },
    () => bad(`no Project Recovery after the crash (autosave folder: ${readdirSync(autosaveDir).join(', ')})`),
  );
  await third.w.waitForFunction(() => window.editor.project.name === 'Crash Test', null, { timeout: 5000 }).catch(() => {});
  check(await third.w.evaluate(() => window.editor.project.name === 'Crash Test' && window.editor.projectDirty && window.editor.project.description === 'not saved before the crash'), 'the recovered project opened as modified, with its unsaved changes');
  const rec3 = third.w.locator('.recovery-dialog .modal');
  await rec3.waitFor({ timeout: 15_000 }).then(
    async () => {
      const rows = await recoveryRows(third.w);
      check(rows.length > 0 && !rows.some((r) => /jcadproj|Crash Test|project/i.test(r)), `the Drawing Recovery Manager lists drawings only (${rows.map((r) => r.slice(0, 40)).join(' | ')})`);
      await rec3.locator('button', { hasText: 'Close' }).click();
    },
    () => bad('no Drawing Recovery Manager after the crash'),
  );
  check(JSON.stringify(projectBackups()) === JSON.stringify(found), `the project autosave kept its name across the starts (${projectBackups().join(', ')})`);
  // The page's 'close' (the window is gone): on macOS the application keeps running without windows.
  const closed3 = third.w.waitForEvent('close', { timeout: 30_000 }).then(
    () => true,
    () => false,
  );
  await third.a.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0].close());
  const sa3 = third.w.locator('.modal', { hasText: 'Save them before closing' });
  await sa3.waitFor({ timeout: 10_000 });
  check((await sa3.locator('.save-all-row').allTextContents()).some((t) => /Crash Test.*Project/.test(t)), 'the recovered project is listed when closing');
  await sa3.locator('button', { hasText: 'Discard All' }).click();
  check(await closed3, 'Discard All closed the window');
  // `third` stays set: on macOS the application keeps running without windows and would keep this
  // script (connected to it) alive after the summary; the finally block below closes it.
} catch (err) {
  bad(`unexpected: ${err && err.stack ? err.stack : err}`);
} finally {
  for (const x of [second, third]) if (x) await closeTestApplication(x.a).catch((err) => bad(`cleanup: ${err}`));
  clearTimeout(relaunchTimeout);
}

step = 'main process';
check(!existsSync(autosaveDir) || tmpLeftovers(autosaveDir).length === 0, `no temporary files left in the autosave folder (${existsSync(autosaveDir) ? readdirSync(autosaveDir).join(', ') : 'none'})`);
const errorLog = join(userData, 'error.log');
check(!existsSync(errorLog), `no main-process error log${existsSync(errorLog) ? `: ${readFileSync(errorLog, 'utf8').slice(0, 2000)}` : ''}`);
const mainErrors = mainLog.join('').split(/\r?\n/).filter((l) => /Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(l));
check(mainErrors.length === 0, `main process printed no JS errors${mainErrors.length ? `: ${mainErrors.slice(0, 5).join(' | ')}` : ''}`);
// The IPC guard refused only what this test provoked (the foreign window, the images outside the
// allowed folders, the writes and links of the "file access" step): every legitimate flow (dialogs,
// plugins, packs, autosave, user library, updater, read-image next to a chosen file) went through.
const provoked = [
  /ipc app-info: sender is not the application window/,
  /read-image: (not next to a drawing the user opened|relative path|not an image file|network path not next to a file the user opened on that server|device path): /,
  /read-image: Image resolves outside the permitted drawing folders: .*jcad-e2e-img-[^\\/]+[\\/]logo\.png$/,
  /backup-file: not a file chosen by the user: .*stranger\.dxf/,
  /backup-file: relative path: relative\.dxf$/,
  /save-project: read-only \(named by a project file, not chosen by the user\): .*package\.json/,
  /save-dxf: wrong file type: .*(package\.json|listing\.jcadproj\.json)/,
  /(backup-file|save-dxf): read-only \(named by a project file, not chosen by the user\): .*elsewhere-b\.dxf/,
  /open-drawing: (relative path|not a file chosen by the user): .*(e2e-no-such-host|elsewhere-c\.dxf)/,
  /open-external: not an allowed link: /,
];
const rejections = existsSync(join(userData, 'ipc-rejections.log')) ? readFileSync(join(userData, 'ipc-rejections.log'), 'utf8').split(/\r?\n/).filter(Boolean) : [];
const unexpected = rejections.filter((l) => !provoked.some((re) => re.test(l)));
check(unexpected.length === 0, `ipc-rejections.log holds only the provoked refusals (${rejections.length} line(s))${unexpected.length ? `: ${unexpected.slice(0, 5).join(' | ')}` : ''}`);

/**
 * Remove a temporary folder. Helper processes of a killed or just-closed instance (crash recovery
 * step) may still write into the profile (Chromium's disk cache) for a while after rmSync emptied
 * it: the whole removal is retried for up to 15 s, then left to the system's temporary-file cleanup
 * with a warning - a leftover temporary folder is not a test failure.
 * @param {string} dir
 */
async function removeTemp(dir) {
  for (let i = 0; ; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      return;
    } catch (err) {
      if (i >= 30) {
        console.warn(`e2e-electron: ${dir} not removed (${err && err.code}): a helper process still writes into it`);
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
await removeTemp(profile);
if (!process.env.JCAD_E2E_OUT) await removeTemp(outDir);
else console.log(`e2e-electron: output kept in ${outDir}`);

// Exit explicitly: a connection to an application that is still running (macOS keeps running without
// windows) would otherwise keep this process alive after a fully passed run, until the job's timeout.
// stdout / stderr are asynchronous pipes on some platforms, so the last lines are flushed first.
const flush = (/** @type {NodeJS.WriteStream} */ stream, /** @type {string} */ text) => new Promise((resolve) => stream.write(text, () => resolve(undefined)));
if (problems.length) await flush(process.stderr, problems.map((p) => `  - ${p}`).join('\n') + '\n');
await flush(process.stdout, `\ne2e-electron: ${results.length} checks passed, ${problems.length} failed (${process.platform} ${process.arch}, ${packaged ? `packaged ${executable}` : `Electron ${runtime}`})\n`);
process.exit(problems.length ? 1 : 0);
