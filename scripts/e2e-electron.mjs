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
// Copy Report) and the Save warning over a source file with import losses (No = Save As), IMAGE bitmaps through
// `read-image` (relative to the drawing folder), RECENT (open by remembered
// path), PLOT to a tabloid landscape vector PDF through `save-pdf` (parsed: 1224 x 792 pt, content
// stream paths) and as a raster image through `plot-pdf`, a layout tab plotted as a page, the updater's
// check path offline (up to date / newer release / network error), the Symbol Builder, the About
// dialog, a project opened with Windows-style relative entries (open by resolved path, Save As to another folder
// with recalculated paths, Save / Cancel before opening another project), the Save All workflow on close (Cancel,
// a failed save aborting the close, Save Selected writing a drawing and the project before the window closes, the
// main process waiting for the answer), SAVEAS to a DXF that reads back, AUTOSAVE writing a recovery copy, a large-DWG
// progress dialog and its Cancel (the read runs in a worker thread), IPC from a foreign page being refused, and no
// main-process error log.
// File safety: old-style autosave files are migrated to permanent ids and offered by the Drawing
// Recovery Manager (a double click opens a backup once, Discard All spares the opened one); saves
// go through temp file + rename and keep <name>.bak; a failed save shows Retry / Save As... and
// keeps the drawing modified and its backup; backup-file answers { ok, path } / { ok: false, error } and
// refuses paths outside the main process allow-list;
// an unreadable recovery folder shows an error state.
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { parsePdfBasics, pageContents, parseContentStream } from '../tests/helpers/pdf.ts';

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
app.process().stdout?.on('data', (d) => mainLog.push(String(d)));
app.process().stderr?.on('data', (d) => mainLog.push(String(d)));

try {
  step = 'window';
  const win = await app.firstWindow({ timeout: 60_000 });
  const pageErrors = [];
  win.on('pageerror', (e) => pageErrors.push(`PAGE ERROR ${e.message}`));
  win.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`CONSOLE ${m.text()}`);
  });
  await win.waitForFunction(() => !!window.editor, null, { timeout: 30_000 });
  await win.waitForTimeout(500);
  check(/JCad Electrical/.test(await win.title()), `window title "${await win.title()}"`);
  userData = await app.evaluate(({ app: a }) => a.getPath('userData'));
  check(userData === profile, `private profile in use (${userData})`);
  const loadedFile = await win.evaluate(() => location.protocol + location.pathname.replace(/^.*\//, '/'));
  check(loadedFile === 'file:/index.html', `renderer loaded from dist/index.html (${loadedFile})`);

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
  const logSince = async (n) => win.evaluate((k) => window.editor.history.slice(k), n);
  const historyLen = () => win.evaluate(() => window.editor.history.length);
  const waitLog = (re, from, timeout = 30_000) =>
    win.waitForFunction(([src, flags, k]) => window.editor.history.slice(k).some((l) => new RegExp(src, flags).test(l)), [re.source, re.flags, from], { timeout });

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
  const newKeys = ['onOpenProgress', 'cancelOpen', 'onCloseRequest', 'chooseProjectPath', 'saveProject'];
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
  await win.evaluate(() => window.editor.runCommand('ZOOM I'));
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
  await win.evaluate(() => window.editor.runCommand('ZOOM I'));
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
  await win.evaluate(() => window.editor.runCommand('OPEN'));
  await waitLog(/^(Opened|Failed to open)/, h).catch(() => bad('no open result logged'));
  let log = await logSince(h);
  check(log.some((l) => l.startsWith(`Opened ${fixtures.dxf}: 25 entities`)), `DXF opened through IPC: ${log.filter((l) => /Opened|Failed/.test(l)).join(' | ')}`);
  const opened = await win.evaluate(() => ({ tabs: window.editor.sessions.count, path: window.editor.doc.filePath, types: [...new Set(window.editor.doc.entities.map((e) => e.type))].sort() }));
  check(opened.tabs === tabs0 + 1 && opened.path === fixtures.dxf, `opened in a new tab (${opened.tabs} tabs, ${opened.path})`);
  check(['dimension', 'ellipse', 'insert', 'mtext', 'polyline', 'ray', 'xline'].every((t) => opened.types.includes(t)), `entity kinds ${opened.types.join(',')}`);
  check((await messages()).includes('open:Open Drawing'), 'the Open dialog was requested by the main process');

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
    await win.evaluate(() => window.editor.runCommand('OPEN'));
    if (current)
      await win.waitForSelector('.modal-backdrop.open-progress', { timeout: 15_000 }).then(
        async () => ok(`progress dialog shown while the DWG is read (${(await win.locator('.open-progress .modal-body').textContent())?.replace(/\s+/g, ' ').trim()})`),
        () => bad('no progress dialog for the DWG read'),
      );
    await waitLog(/^(Imported DWG|Failed to open)/, h, 90_000).catch(() => bad('no DWG import result logged'));
    log = await logSince(h);
    const line = log.find((l) => /Imported DWG|Failed/.test(l)) ?? '';
    const n = Number(/: (\d+) entities/.exec(line)?.[1] ?? 0);
    check(line.startsWith('Imported DWG') && n > 10, `DWG opened through IPC + LibreDWG in the main-process worker: ${line}`);
  }
  if (existsSync(fixtures.dwg) && current) {
    const progress = await win.evaluate(() => /** @type {any} */ (window).__progress.splice(0));
    check(progress.join() === 'start:example_2000.dwg:true,end:example_2000.dwg:undefined', `open-progress events ${progress.join(' ')}`);
    check((await win.locator('.modal-backdrop.open-progress').count()) === 0, 'progress dialog closed after the import');

    step = 'OPEN dwg cancel';
    await win.evaluate(() => (/** @type {any} */ (window).__cancelNext = true));
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), fixtures.dwg);
    h = await historyLen();
    const entitiesBefore = await win.evaluate(() => window.editor.doc.entities.length);
    await win.evaluate(() => window.editor.runCommand('OPEN'));
    await waitLog(/^(Imported DWG|Failed to open)/, h, 90_000).catch(() => bad('no result logged for the cancelled DWG'));
    log = await logSince(h);
    check(log.some((l) => /^Failed to open drawing: .*Open cancelled/.test(l)) && log.some((l) => l === 'Opening example_2000.dwg was cancelled.'), `Cancel stops the read: ${log.filter((l) => /cancel|Failed|Imported/i.test(l)).join(' | ')}`);
    check((await win.evaluate(() => window.editor.doc.entities.length)) === entitiesBefore, 'the cancelled read changed nothing');
    await win.evaluate(() => (/** @type {any} */ (window).__cancelNext = false));
    // The worker was terminated; the next read starts a fresh one.
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), fixtures.dwg);
    h = await historyLen();
    await win.evaluate(() => window.editor.runCommand('OPEN'));
    await waitLog(/^(Imported DWG|Failed to open)/, h, 90_000).catch(() => bad('no result after the cancelled read'));
    log = await logSince(h);
    check(log.some((l) => l.startsWith('Imported DWG')), `a DWG opens again after Cancel: ${log.filter((l) => /Imported|Failed/.test(l)).join(' | ')}`);
    // A second successful open may show its own Import Report dialog on top of the first one's
    // (the DXF / DWG import report): close it, so later steps find exactly the first dialog.
    if ((await win.locator('.import-report-dialog').count()) > 1) await win.locator('.import-report-dialog .modal button', { hasText: 'Close' }).last().click();
    await win.evaluate(() => /** @type {any} */ (window).__progress.splice(0));
  }
  if (!existsSync(fixtures.dwg)) ok('DWG fixture missing: skipped');

  // ------------------------------------------------------------------ Import Report dialog + Save warning
  step = 'import report';
  // The DWG above holds content the import cannot keep (wipeouts, a tolerance, a multiline...): the
  // Import Report dialog opened after it. Check its text, Copy Report and Close.
  // modal() puts the dialog's class on the backdrop; the dialog itself is its .modal child.
  const dwgReport = win.locator('.import-report-dialog .modal', { hasText: 'DWG Import Report' });
  if (existsSync(fixtures.dwg)) {
    await dwgReport.waitFor({ timeout: 5000 }).then(
      async () => {
        const text = await dwgReport.innerText();
        check(/object\(s\) dropped or simplified/.test(text) && /WIPEOUT/.test(text) && /layout "Layout1"/.test(text), 'DWG Import Report lists counts, objects and layouts');
        const copy = dwgReport.locator('.modal-footer button').first(); // Copy Report (its label changes after the click)
        await copy.click();
        await copy.filter({ hasText: 'Copied' }).waitFor({ timeout: 3000 }).then(
          () => ok('Copy Report copied the report text'),
          async () => bad(`Copy Report did not report "Copied" (button: "${await copy.textContent()}", title: "${await copy.getAttribute('title')}")`),
        );
        await dwgReport.locator('button', { hasText: 'Close' }).click();
        check((await win.locator('.import-report-dialog').count()) === 0, 'Import Report dialog closed');
      },
      () => bad('no Import Report dialog after opening a DWG with unsupported content'),
    );
  }
  // A DXF with content JCad cannot keep: the report opens, and SAVE over the file asks (No = Save As).
  const lossDir = mkdtempSync(join(tmpdir(), 'jcad-e2e-loss-'));
  const lossDxf = join(lossDir, 'unsupported-content.dxf');
  writeFileSync(lossDxf, readFileSync(join(repo, 'tests', 'fixtures', 'unsupported-content.dxf')));
  await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), lossDxf);
  h = await historyLen();
  await win.evaluate(() => window.editor.runCommand('OPEN'));
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
  h = await historyLen();
  await win.evaluate(() => window.editor.runCommand('SAVE'));
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
  const recent = await win.evaluate(() => window.editor.settings.recentFiles.slice(0, 3));
  check(recent.includes(fixtures.dxf), `recent files list the DXF (${recent.join(', ')})`);
  const idx = recent.indexOf(fixtures.dxf) + 1;
  await win.evaluate((i) => window.editor.runCommand(`RECENT ${i}`), idx);
  await waitLog(/^(Opened|Failed to open)/, h, 15_000).catch(() => bad('RECENT did not open anything'));
  log = await logSince(h);
  check(log.some((l) => l.startsWith(`Opened ${fixtures.dxf}: 25 entities`)) && !log.some((l) => /Failed to open|Unknown file path/.test(l)), `RECENT ${idx} reopened by path: ${log.filter((l) => /Open|Failed/.test(l)).join(' | ')}`);
  check((await messages()).length === 0, 'no dialog was shown for RECENT');
  check(!log.some((l) => /in a new tab|in the tab it was opened from/.test(l)) && (await win.evaluate((p) => window.editor.doc.filePath === p, fixtures.dxf)), 'RECENT opened the file straight into its own, active tab');

  // ------------------------------------------------------------------ PLOT through plot-pdf
  step = 'PLOT';
  const pdfPath = join(outDir, 'plot-tabloid.pdf');
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), pdfPath);
  h = await historyLen();
  await win.evaluate(() => window.editor.runCommand('PLOT'));
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
  await win.evaluate(() => window.editor.runCommand('PLOT'));
  const dlg2 = win.locator('.modal', { hasText: 'Paper size' });
  await dlg2.waitFor({ timeout: 10_000 });
  await dlg2.locator('select').nth(3).selectOption('raster');
  await dlg2.locator('button', { hasText: 'Plot to PDF' }).click();
  await waitLog(/^Plotted to /, h, 60_000).catch(() => bad('no "Plotted to" line for the raster plot'));
  check((await messages()).includes('save:Plot to PDF'), 'the Save dialog was requested by plot-pdf (raster)');
  if (existsSync(rasterPath)) {
    const pdf = parsePdfBasics(new Uint8Array(readFileSync(rasterPath)));
    check(pdf.errors.length === 0 && pdf.images.some((i) => i.width > 1000), `raster PDF has the plot image (${pdf.images.map((i) => `${i.width}x${i.height}`).join(', ')})`);
  } else bad(`no raster PDF written at ${rasterPath}`);

  // A layout tab: Layout1 is initialised with a viewport and plots as its own sheet.
  step = 'PLOT layout';
  const layoutPdf = join(outDir, 'plot-layout.pdf');
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), layoutPdf);
  await win.locator('#layout-tabs .layout-tab', { hasText: 'Layout1' }).click();
  check(await win.evaluate(() => window.editor.doc.space?.layout === 'Layout1' && window.editor.doc.layouts[0].viewports.length === 1), 'Layout1 tab activates paper space with one viewport');
  h = await historyLen();
  await win.evaluate(() => window.editor.runCommand('PLOT'));
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
  await win.evaluate(() => window.editor.runCommand('ABOUT'));
  const about = win.locator('.modal', { hasText: 'Check for Updates' });
  await about.waitFor({ timeout: 10_000 });
  const aboutText = await about.textContent();
  check(aboutText.includes('JCad Electrical') && aboutText.includes(info.version), 'About dialog shows the name and version');
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
  // Help > About from the native menu opens the same dialog.
  await app.evaluate(({ Menu }) => {
    const help = Menu.getApplicationMenu().items.find((i) => i.label === 'Help');
    help.submenu.items.find((i) => /^About JCad Electrical/.test(i.label)).click();
  });
  await win.locator('.modal', { hasText: 'Check for Updates' }).waitFor({ timeout: 5000 }).then(
    () => ok('Help > About (native menu) opens the About dialog'),
    () => bad('Help > About did not open the dialog'),
  );
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
  await win.evaluate(() => window.editor.runCommand('SAVEAS'));
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
    await win.evaluate(() => window.editor.runCommand('OPEN'));
    await waitLog(/^(Opened|Failed to open)/, h, 30_000).catch(() => bad('the saved DXF did not reopen'));
    log = await logSince(h);
    check(log.some((l) => l.startsWith(`Opened ${savedPath}: ${savedCount} entities`)), `saved DXF reopens with ${savedCount} entities: ${log.filter((l) => /Opened|Failed/.test(l)).join(' | ')}`);
  } else bad(`no DXF written at ${savedPath}`);

  // ------------------------------------------------------------------ AUTOSAVE writes a recovery copy
  step = 'AUTOSAVE';
  await win.evaluate(() => window.editor.runCommand('LINE'));
  for (const text of ['1,1', '4,4']) {
    await input.fill(text);
    await input.press('Enter');
  }
  await input.press('Enter');
  h = await historyLen();
  await win.evaluate(() => window.editor.runCommand('AUTOSAVE'));
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

  // ------------------------------------------------------------------ Symbol Builder
  step = 'Symbol Builder';
  const tabsBefore = await win.evaluate(() => window.editor.sessions.count);
  await win.evaluate(() => window.editor.runCommand('AESYMBUILDER'));
  const start = win.locator('.modal').last();
  await start.waitFor({ timeout: 10_000 });
  check(/Symbol Builder/i.test(await start.textContent()), 'AESYMBUILDER shows the start dialog');
  await start.locator('.btn.primary').last().click();
  await win.waitForFunction(() => !document.getElementById('symbol-builder').classList.contains('hidden'), null, { timeout: 10_000 }).then(
    () => ok('Symbol Builder palette is shown'),
    () => bad('Symbol Builder palette did not appear'),
  );
  check((await win.evaluate(() => window.editor.sessions.count)) === tabsBefore + 1, 'Symbol Builder opened its own tab');
  check((await win.locator('#symbol-builder .sb-actions button').count()) > 0, 'Symbol Builder actions are present');
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
  await win.evaluate(() => window.editor.runCommand('AUTOSAVE'));
  await waitLog(/drawing\(s\) autosaved/, h, 15_000).catch(() => bad('AUTOSAVE did not finish'));
  check(existsSync(join(autosaveDir, panelBackup)) && tmpLeftovers(autosaveDir).length === 0, 'AUTOSAVE refreshed the adopted backup without leaving temporary files');

  // A save into a folder that does not exist fails: error dialog, still modified, backup kept.
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), missingFolder);
  h = await historyLen();
  await win.evaluate(() => window.editor.runCommand('SAVEAS'));
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
  await win.evaluate(() => window.editor.runCommand('SAVE'));
  await waitLog(/^Saved /, h, 15_000).catch(() => bad('SAVE did not finish'));
  check(existsSync(`${good}.bak`) && readFileSync(`${good}.bak`, 'utf8') === firstContent && readFileSync(good, 'utf8') !== firstContent, 'SAVE kept the previous version as recovered.dxf.bak');
  check(tmpLeftovers(saveDir).length === 0, 'no temporary files next to the drawing');
  check((await messages()).filter((m) => m.startsWith('save:')).length === 3, 'SAVE of a known file asked no dialog');

  // backup-file: { ok, path } or { ok: false, error }, never a silent success.
  const b1 = await win.evaluate((p) => window.jcad.backupFile(p), good);
  check(b1 && b1.ok === true && b1.path === `${good}.bak` && readFileSync(`${good}.bak`, 'utf8') === readFileSync(good, 'utf8'), `backup-file copied the drawing (${JSON.stringify(b1)})`);
  // A path the main process never handed out (no dialog, recent list or project named it) is refused like save-dxf refuses it.
  const b2 = await win.evaluate((p) => window.jcad.backupFile(p), join(saveDir, 'stranger.dxf'));
  check(b2 && b2.ok === false && b2.code === 'EINVAL' && /^The backup copy of "stranger\.dxf" could not be made: only drawings and project files opened or saved in this session/.test(b2.error), `backup-file refuses a path outside the allow-list (${JSON.stringify(b2)})`);
  // A known path whose file is gone: a clear message, no .bak.
  renameSync(good, `${good}.moved`);
  const b2b = await win.evaluate((p) => window.jcad.backupFile(p), good);
  renameSync(`${good}.moved`, good);
  check(b2b && b2b.ok === false && b2b.code === 'ENOENT' && /^The backup copy of "recovered\.dxf" could not be made: .*is not available/.test(b2b.error), `backup-file reports a missing file (${JSON.stringify(b2b)})`);
  const b3 = await win.evaluate(() => window.jcad.backupFile('relative.dxf'));
  check(b3 && b3.ok === false && b3.code === 'EINVAL', `backup-file refuses relative paths (${JSON.stringify(b3)})`);

  // An unreadable recovery folder is an error state, not "nothing to recover".
  step = 'recovery error';
  renameSync(autosaveDir, `${autosaveDir}-moved`);
  writeFileSync(autosaveDir, 'not a folder');
  await win.evaluate(() => window.editor.runCommand('DRAWINGRECOVERY'));
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
  await win.evaluate(() => window.editor.runCommand('OPENPROJECT'));
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
  }
  // A project change marks the project modified; Save As into another folder keeps the entries pointing at the same files.
  await win.evaluate(() => window.editor.updateProject({ ...window.editor.project, descriptions: ['E2E CUSTOMER'] }));
  check(await win.evaluate(() => window.editor.projectDirty), 'a project property change marks the project modified');
  const projectCopy = join(projDir, 'archive', 'line2.jcadproj.json');
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), projectCopy);
  h = await historyLen();
  await win.evaluate(() => window.editor.runCommand('PROJECTSAVEAS'));
  await waitLog(/^(Project saved|Project not saved)/, h).catch(() => bad('PROJECTSAVEAS logged nothing'));
  check((await messages()).includes('save:Save Project As'), 'PROJECTSAVEAS asked where to save');
  const savedProject = existsSync(projectCopy) ? JSON.parse(readFileSync(projectCopy, 'utf8')) : null;
  check(JSON.stringify(savedProject?.drawings.map((d) => d.file)) === JSON.stringify(['../proj/dwg/a.dxf', '../proj/b.dxf']), `relative paths recalculated for the new folder: ${JSON.stringify(savedProject?.drawings)}`);
  check(await win.evaluate((p) => window.editor.project.path === p && !window.editor.projectDirty, projectCopy), 'the project now lives at the new path, unmodified');
  // Opening another project while this one has unsaved changes asks first; Cancel keeps it.
  await win.evaluate(() => window.editor.updateProject({ ...window.editor.project, description: 'pending' }));
  await win.evaluate(() => window.editor.runCommand('OPENPROJECT'));
  const ask = win.locator('.modal', { hasText: 'Save changes to project E2E Line?' });
  await ask.waitFor({ timeout: 10_000 }).then(
    () => ok('OPENPROJECT with a modified project asks Save / Don\'t Save / Cancel'),
    () => bad('no save-changes question before opening another project'),
  );
  await ask.locator('button', { hasText: 'Cancel' }).click();
  await win.waitForTimeout(200);
  check((await messages()).every((m) => m !== 'open:Open Project'), 'Cancel: no Open dialog was shown');
  check(await win.evaluate(() => window.editor.project.description === 'pending' && window.editor.projectDirty), 'Cancel: the modified project stays open');

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

  // Drawing1 and the project saved (in that order, each awaited), everything else discarded: the window closes.
  const savedDrawing = join(outDir, 'closed-drawing1.dxf');
  await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), savedDrawing);
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
  rmSync(projDir, { recursive: true, force: true });
} catch (err) {
  bad(`unexpected: ${err && err.stack ? err.stack : err}`);
} finally {
  try {
    await app.close();
  } catch {
    /* already closed */
  }
  clearTimeout(hardTimeout);
}

step = 'main process';
check(!existsSync(autosaveDir) || tmpLeftovers(autosaveDir).length === 0, `no temporary files left in the autosave folder (${existsSync(autosaveDir) ? readdirSync(autosaveDir).join(', ') : 'none'})`);
const errorLog = join(userData, 'error.log');
check(!existsSync(errorLog), `no main-process error log${existsSync(errorLog) ? `: ${readFileSync(errorLog, 'utf8').slice(0, 2000)}` : ''}`);
const mainErrors = mainLog.join('').split(/\r?\n/).filter((l) => /Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(l));
check(mainErrors.length === 0, `main process printed no JS errors${mainErrors.length ? `: ${mainErrors.slice(0, 5).join(' | ')}` : ''}`);
// The IPC guard refused only what this test provoked (the foreign window, the images outside the
// allowed folders): every legitimate flow (dialogs, plugins, packs, autosave, user library, updater,
// read-image next to a chosen file) went through.
const rejections = existsSync(join(userData, 'ipc-rejections.log')) ? readFileSync(join(userData, 'ipc-rejections.log'), 'utf8').split(/\r?\n/).filter(Boolean) : [];
const unexpected = rejections.filter((l) => !/ipc app-info: sender is not the application window|read-image: (not next to a drawing the user opened|relative path|not an image file): |backup-file: not a file chosen by the user: .*stranger\.dxf/.test(l));
check(unexpected.length === 0, `ipc-rejections.log holds only the provoked refusals (${rejections.length} line(s))${unexpected.length ? `: ${unexpected.slice(0, 5).join(' | ')}` : ''}`);

rmSync(profile, { recursive: true, force: true });
if (!process.env.JCAD_E2E_OUT) rmSync(outDir, { recursive: true, force: true });
else console.log(`e2e-electron: output kept in ${outDir}`);

console.log(`\ne2e-electron: ${results.length} checks passed, ${problems.length} failed (${process.platform} ${process.arch}, ${packaged ? `packaged ${executable}` : `Electron ${pkg.devDependencies.electron}`})`);
if (problems.length) {
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
