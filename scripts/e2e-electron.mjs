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
// and native menu), OPEN of a DXF and a DWG through `open-drawing`, IMAGE bitmaps through
// `read-image` (relative to the drawing folder), RECENT (open by remembered
// path), PLOT to a tabloid landscape vector PDF through `save-pdf` (parsed: 1224 x 792 pt, content
// stream paths) and as a raster image through `plot-pdf`, a layout tab plotted as a page, the updater's
// check path offline (up to date / newer release / network error), the Symbol Builder, the About
// dialog, SAVEAS to a DXF that reads back, AUTOSAVE writing a recovery copy, a large-DWG progress
// dialog and its Cancel (the read runs in a worker thread), IPC from a foreign page being refused,
// the unsaved-changes prompt on close, and no main-process error log.
import { _electron as electron } from 'playwright';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  const newKeys = ['onOpenProgress', 'cancelOpen'];
  for (const k of ['openDrawing', 'openDxf', 'saveDxf', 'plotPdf', 'printDrawing', 'appInfo', 'checkForUpdates', 'onMenuCommand', 'onQueryDirty', 'autosaveWrite', 'userLibraryRead', 'packsList', 'readImage', ...(current ? newKeys : [])]) check(bridge?.keys.includes(k), `bridge exposes ${k}`);
  if (!current) ok(`release ${info.version} is older than these checks (${pkg.version}): progress / Cancel, image allow list and IPC guard checks skipped`);
  check(bridge?.platform === process.platform, `bridge platform ${bridge?.platform}`);
  check(info.version === expectVersion && info.packaged === packaged && (packaged || info.selfUpdate === false), `appInfo ${JSON.stringify(info)}`);
  check(await win.evaluate(() => typeof window.require === 'undefined' && typeof window.process === 'undefined'), 'renderer has no Node globals (contextIsolation, sandbox)');

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
  const recovered = autosaves?.[0] ? await win.evaluate((n) => window.jcad.autosaveRead(n), autosaves[0].name) : null;
  check(typeof recovered === 'string' && /SECTION/.test(recovered) && /EOF\s*$/.test(recovered), `recovery copy is a complete DXF (${recovered ? recovered.length : 0} characters)`);

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

  // ------------------------------------------------------------------ errors so far
  step = 'renderer errors';
  check(pageErrors.length === 0, `no page / console errors${pageErrors.length ? `: ${pageErrors.slice(0, 5).join(' | ')}` : ''}`);
  const unknown = (await win.evaluate(() => window.editor.history)).filter((l) => /Unknown command|TypeError|ReferenceError/.test(l));
  check(unknown.length === 0, `command history is clean${unknown.length ? `: ${unknown.join(' | ')}` : ''}`);

  // ------------------------------------------------------------------ close with unsaved work
  step = 'close';
  check(await win.evaluate(() => window.editor.sessions.anyDirty()), 'the drawing has unsaved changes (LINE)');
  // The page's 'close' (the window is gone): on macOS the application keeps running without windows.
  const closed = win.waitForEvent('close', { timeout: 20_000 }).then(
    () => true,
    () => false,
  );
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const didClose = await closed;
  const closeMsgs = didClose ? [] : await messages();
  check(didClose, `window closed after the unsaved-changes prompt ("Don't Save")${closeMsgs.length ? ` ${closeMsgs.join(' ; ')}` : ''}`);
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
const errorLog = join(userData, 'error.log');
check(!existsSync(errorLog), `no main-process error log${existsSync(errorLog) ? `: ${readFileSync(errorLog, 'utf8').slice(0, 2000)}` : ''}`);
const mainErrors = mainLog.join('').split(/\r?\n/).filter((l) => /Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(l));
check(mainErrors.length === 0, `main process printed no JS errors${mainErrors.length ? `: ${mainErrors.slice(0, 5).join(' | ')}` : ''}`);

rmSync(profile, { recursive: true, force: true });
if (!process.env.JCAD_E2E_OUT) rmSync(outDir, { recursive: true, force: true });
else console.log(`e2e-electron: output kept in ${outDir}`);

console.log(`\ne2e-electron: ${results.length} checks passed, ${problems.length} failed (${process.platform} ${process.arch}, ${packaged ? `packaged ${executable}` : `Electron ${pkg.devDependencies.electron}`})`);
if (problems.length) {
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
