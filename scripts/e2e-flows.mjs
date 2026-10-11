// End-to-end flows of the desktop app that need several launches, a killed process or a file
// system that fails: the close / quit matrix, open flows, project recovery after a crash,
// project-wide commands on a real project folder and save errors. Companion of e2e-electron.mjs
// (same approach: Playwright launches Electron on dist/, the native dialogs and, where a real
// failure cannot be produced, single fs calls are replaced inside the main process; everything
// behind them is the shipping code).
//
//   npm run build && npm run e2e:flows      (Linux without a display: xvfb-run -a npm run e2e:flows)
//
// JCAD_FLOWS=close,open (comma-separated scenario names) runs only those scenarios.
import { _electron as electron } from 'playwright';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
if (!existsSync(join(repo, 'dist', 'index.html'))) {
  console.error('dist/index.html not found: run `npm run build` first.');
  process.exit(2);
}
const fixtures = {
  dxf: join(repo, 'tests', 'fixtures', 'all-entities.dxf'),
  truncated: join(repo, 'tests', 'fixtures', 'broken', 'truncated.dxf'),
  unsupported: join(repo, 'tests', 'fixtures', 'unsupported-content.dxf'),
  dwg: join(repo, 'fixtures', 'example_2000.dwg'),
};
const only = (process.env.JCAD_FLOWS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const want = (name) => only.length === 0 || only.includes(name);

const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
delete env.VITE_DEV_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;

const results = [];
const problems = [];
let step = 'start';
const ok = (what) => {
  results.push(`ok   ${what}`);
  console.log(`ok   ${what}`);
};
const bad = (what) => {
  problems.push(`${step}: ${what}`);
  console.error(`FAIL ${step}: ${what}`);
};
const check = (cond, what) => (cond ? ok(what) : bad(what));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flowsRun = [];

const hardTimeout = setTimeout(() => {
  console.error('e2e-flows: timed out after 15 minutes');
  process.exit(1);
}, 15 * 60 * 1000);

/** Temporary folders removed at the end (and immutable flags / mounts undone first). */
const cleanups = [];
const tempDir = (tag) => {
  const d = mkdtempSync(join(tmpdir(), `jcad-flows-${tag}-`));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const isRootLinux = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
/**
 * A folder where nothing can be created or replaced: as root on Linux `chattr +i` (root ignores
 * permission bits; the kernel then answers EPERM), elsewhere mode 0555 (EACCES).
 */
function makeReadOnly(dir) {
  if (isRootLinux) {
    try {
      execFileSync('chattr', ['+i', dir]);
      cleanups.unshift(() => execFileSync('chattr', ['-i', dir]));
      return 'EPERM';
    } catch {
      return null;
    }
  }
  if (process.platform === 'win32') return null;
  chmodSync(dir, 0o555);
  cleanups.unshift(() => chmodSync(dir, 0o755));
  return 'EACCES';
}
/** A tiny file system (Linux, root): writes larger than a few KB fail with ENOSPC. */
function makeFullDisk(dir) {
  if (!isRootLinux) return false;
  try {
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'size=12k', 'tmpfs', dir]);
    cleanups.unshift(() => execFileSync('umount', [dir]));
    return true;
  } catch {
    return false;
  }
}
const sameBytes = (a, b) => Buffer.compare(readFileSync(a), readFileSync(b)) === 0;

// ------------------------------------------------------------------ one application launch
/**
 * Launch the app on `profile` and install the main-process test doubles:
 *   openPaths / savePaths   answers of the Open / Save dialogs (empty = cancelled)
 *   boxAnswers / syncAnswers responses of showMessageBox / showMessageBoxSync (empty = cancel)
 *   faults                  [{ prefix, code, op }] fs/promises calls on paths under `prefix` throw `code`
 *   slowReads               [{ path, ms }] readFile of that path waits first (a slow open)
 */
async function launch(profile, { recover = true } = {}) {
  const args = ['.', `--user-data-dir=${profile}`];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const app = await electron.launch({ args, cwd: repo, env, timeout: 60_000 });
  const mainLog = [];
  app.process().stdout?.on('data', (d) => mainLog.push(String(d)));
  app.process().stderr?.on('data', (d) => mainLog.push(String(d)));
  const win = await app.firstWindow({ timeout: 60_000 });
  const pageErrors = [];
  win.on('pageerror', (e) => pageErrors.push(`PAGE ERROR ${e.message}`));
  win.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`CONSOLE ${m.text()}`);
  });
  await win.waitForFunction(() => !!window.editor, null, { timeout: 30_000 });
  await app.evaluate(({ dialog }) => {
    const g = globalThis;
    g.__e2e = { openPaths: [], savePaths: [], boxAnswers: [], syncAnswers: [], messages: [], faults: [], slowReads: [] };
    dialog.showOpenDialog = async (_w, opts) => {
      const p = g.__e2e.openPaths.shift();
      g.__e2e.messages.push(`open:${opts && opts.title}`);
      if (p && typeof p === 'object') {
        await new Promise((r) => setTimeout(r, p.delay));
        return { canceled: false, filePaths: [p.path] };
      }
      return p ? { canceled: false, filePaths: [p] } : { canceled: true, filePaths: [] };
    };
    dialog.showSaveDialog = async (_w, opts) => {
      const p = g.__e2e.savePaths.shift();
      g.__e2e.messages.push(`save:${opts && opts.title}`);
      return p ? { canceled: false, filePath: p } : { canceled: true };
    };
    dialog.showMessageBox = async (_w, opts) => {
      const o = opts || _w;
      g.__e2e.messages.push(`box:${o.title}|${o.message}`);
      const a = g.__e2e.boxAnswers.shift();
      return { response: typeof a === 'number' ? a : typeof o.cancelId === 'number' ? o.cancelId : 1, checkboxChecked: false };
    };
    dialog.showMessageBoxSync = (_w, opts) => {
      const o = opts || _w;
      g.__e2e.messages.push(`boxsync:${o.message}`);
      const a = g.__e2e.syncAnswers.shift();
      return typeof a === 'number' ? a : 1;
    };
    // fs fault injection (single calls; everything else is the real file system).
    const fsp = process.getBuiltinModule('node:fs/promises');
    for (const op of ['open', 'copyFile', 'rename', 'readFile']) {
      const real = fsp[op].bind(fsp);
      fsp[op] = async (...a) => {
        const p = String(a[0]);
        if (op === 'readFile') {
          const slow = g.__e2e.slowReads.find((s) => s.path === p);
          if (slow) await new Promise((r) => setTimeout(r, slow.ms));
        }
        const f = g.__e2e.faults.find((x) => (!x.op || x.op === op) && p.startsWith(x.prefix));
        if (f) {
          const e = new Error(`${f.code}: injected failure, ${op} '${p}'`);
          e.code = f.code;
          e.path = p;
          throw e;
        }
        return real(...a);
      };
    }
  });
  const ctx = {
    app,
    win,
    profile,
    mainLog,
    pageErrors,
    autosaveDir: join(profile, 'autosave'),
    exited: new Promise((r) => app.process().once('exit', () => r(true))),
    messages: () => app.evaluate(() => globalThis.__e2e.messages.splice(0)),
    pushOpen: (...p) => app.evaluate((_e, list) => globalThis.__e2e.openPaths.push(...list), p),
    pushSave: (...p) => app.evaluate((_e, list) => globalThis.__e2e.savePaths.push(...list), p),
    pushBox: (...r) => app.evaluate((_e, list) => globalThis.__e2e.boxAnswers.push(...list), r),
    pushSync: (...r) => app.evaluate((_e, list) => globalThis.__e2e.syncAnswers.push(...list), r),
    setFaults: (f) => app.evaluate((_e, list) => void (globalThis.__e2e.faults = list), f),
    setSlowReads: (s) => app.evaluate((_e, list) => void (globalThis.__e2e.slowReads = list), s),
    run: (c) => win.evaluate((x) => window.editor.runCommand(x), c),
    h: () => win.evaluate(() => window.editor.history.length),
    logSince: (k) => win.evaluate((n) => window.editor.history.slice(n), k),
    waitLog: (re, from, timeout = 20_000) =>
      win.waitForFunction(([src, flags, k]) => window.editor.history.slice(k).some((l) => new RegExp(src, flags).test(l)), [re.source, re.flags, from], { timeout }).then(
        () => true,
        () => false,
      ),
    windowCount: () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length).catch(() => 0),
    closeWindow: () => app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0]?.close()),
    tabs: () => win.evaluate(() => window.editor.sessions.all.map((s, i) => ({ i, id: s.id, title: window.editor.sessions.titleOf(i), path: s.filePath, dirty: s.dirty, n: s.state.entities.length }))),
    active: () => win.evaluate(() => window.editor.sessions.active),
    projectState: () => win.evaluate(() => ({ name: window.editor.project.name, path: window.editor.project.path ?? null, dirty: window.editor.projectDirty, drawings: window.editor.project.drawings.map((d) => d.file) })),
    autosaveFiles: () => (existsSync(join(profile, 'autosave')) ? readdirSync(join(profile, 'autosave')).filter((f) => f.endsWith('.sv.dxf')).sort() : []),
    autosaveIndex: () => {
      try {
        return JSON.parse(readFileSync(join(profile, 'autosave', 'index.json'), 'utf8')).entries;
      } catch {
        return {};
      }
    },
    /** Add a line to the active drawing (one undo step, marks it modified). */
    edit: (tag = 'e') => win.evaluate((t) => window.editor.doc.addEntities([{ id: `flow-${t}-${Math.random().toString(36).slice(2)}`, type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 3, y: 4 } }]), tag),
    modal: (text) => win.locator('.modal', { hasText: text }),
    async kill() {
      app.process().kill('SIGKILL');
      await ctx.exited;
    },
    async close() {
      try {
        await app.close();
      } catch {
        /* already gone */
      }
    },
  };
  if (recover) {
    // Let start-up recovery dialogs (if any) appear before the scenario looks at the window.
    await win.waitForTimeout(600);
  }
  return ctx;
}

/** Page and main-process error checks after a launch has ended. */
function checkClean(ctx, what) {
  check(ctx.pageErrors.length === 0, `${what}: no page / console errors${ctx.pageErrors.length ? `: ${ctx.pageErrors.slice(0, 4).join(' | ')}` : ''}`);
  const errorLog = join(ctx.profile, 'error.log');
  const log = existsSync(errorLog) ? readFileSync(errorLog, 'utf8') : '';
  // A renderer crash forced by a scenario is logged on purpose.
  const unexpected = log.split('\n').filter((l) => l.trim() && !/render-process-gone: (crashed|killed)/.test(l) && !/^\s+at /.test(l));
  check(unexpected.length === 0, `${what}: no unexpected main-process error log${unexpected.length ? `: ${unexpected.slice(0, 3).join(' | ')}` : ''}`);
  const js = ctx.mainLog.join('').split(/\r?\n/).filter((l) => /Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError/.test(l));
  check(js.length === 0, `${what}: main process printed no JS errors${js.length ? `: ${js.slice(0, 3).join(' | ')}` : ''}`);
}

/** Save As the active drawing to `file` through the SAVEAS command; resolves the log lines. */
async function saveAs(ctx, file) {
  await ctx.pushSave(file);
  const h = await ctx.h();
  await ctx.run('SAVEAS');
  const done = await ctx.waitLog(/^(Saved |Save failed)/, h);
  if (!done) bad(`SAVEAS ${file} logged nothing`);
  return ctx.logSince(h);
}

/** A project file with the given drawing entries, written straight to disk. */
function writeProject(file, name, entries, extra = {}) {
  writeFileSync(file, JSON.stringify({ name, drawings: entries.map((f) => ({ file: f })), ...extra }, null, 1));
}

async function openProject(ctx, file) {
  await ctx.pushOpen(file);
  const h = await ctx.h();
  await ctx.run('OPENPROJECT');
  const done = await ctx.waitLog(/^(Project .*drawing\(s\)|Failed to open project)/, h);
  if (!done) bad(`OPENPROJECT ${file} logged nothing`);
  return ctx.logSince(h);
}

// ================================================================== scenarios
const scenarios = [];
const scenario = (name, fn) => scenarios.push({ name, fn });

// ------------------------------------------------------------------ project recovery after a crash
scenario('project-recovery', async () => {
  step = 'project recovery: crash';
  const profile = tempDir('profile');
  const work = tempDir('work');
  writeFileSync(join(work, 'a.dxf'), readFileSync(fixtures.dxf));
  const projFile = join(work, 'plant.jcadproj.json');
  writeProject(projFile, 'Plant', ['a.dxf']);
  let ctx = await launch(profile);
  try {
    await openProject(ctx, projFile);
    check(!(await ctx.projectState()).dirty && ctx.autosaveFiles().length === 0, 'an opened project is unmodified and has no autosave');
    await ctx.win.evaluate(() => window.editor.updateProject({ ...window.editor.project, description: 'crash-test change' }));
    let projAuto = [];
    for (let i = 0; i < 50 && projAuto.length === 0; i += 1) {
      await sleep(100);
      projAuto = ctx.autosaveFiles().filter((f) => f.endsWith('_jcadproj.sv.dxf'));
    }
    check(projAuto.length === 1, `the project autosave appears a moment after a change (${ctx.autosaveFiles().join(', ')})`);
    // Drawing work too: one modified drawing in the crashed session.
    await ctx.edit('crash');
    const hA = await ctx.h();
    await ctx.run('AUTOSAVE');
    await ctx.waitLog(/drawing\(s\) autosaved/, hA);
    flowsRun.push('crash with a modified project and drawing');
    await ctx.kill();
  } catch (err) {
    bad(`unexpected: ${err && err.stack ? err.stack : err}`);
    await ctx.close();
  }

  step = 'project recovery: relaunch';
  ctx = await launch(profile);
  try {
    const dlg = ctx.modal('Unsaved changes to project Plant');
    const shown = await dlg.waitFor({ timeout: 10_000 }).then(
      () => true,
      () => false,
    );
    check(shown, `Project Recovery is offered at the next start (autosave folder: ${ctx.autosaveFiles().join(', ')}; index ${JSON.stringify(Object.values(ctx.autosaveIndex()).map((e) => e.title))})`);
    if (shown) {
      check((await dlg.innerText()).includes(projFile), 'the dialog names the project file');
      const h = await ctx.h();
      await dlg.locator('button', { hasText: 'Open Recovered Project' }).click();
      await ctx.waitLog(/^Recovered project Plant/, h, 5000);
      const ps = await ctx.projectState();
      check(ps.dirty && ps.path === projFile && ps.drawings.join() === 'a.dxf', `the recovered project is open, modified, at its path (${JSON.stringify(ps)})`);
      check(await ctx.win.evaluate(() => window.editor.project.description === 'crash-test change'), 'the recovered project has the unsaved change');
    }
    // The Drawing Recovery Manager lists the drawing, never the project autosave.
    const rec = ctx.win.locator('.recovery-dialog .modal');
    await rec.waitFor({ timeout: 10_000 }).catch(() => {});
    const rows = await ctx.win.locator('.recovery-dialog .recovery-row').allInnerTexts();
    check(rows.length === 1 && !rows.some((r) => /Project Plant/.test(r)), `the Drawing Recovery Manager lists only the drawing (${rows.map((r) => r.split('\n')[0]).join(' | ')})`);
    if (rows.length) await ctx.win.locator('.recovery-dialog button', { hasText: 'Discard All' }).click();
    await ctx.win.waitForTimeout(300);
    // PROJECTSAVE writes the recovered project to its file and removes the autosave.
    const h = await ctx.h();
    await ctx.run('PROJECTSAVE');
    await ctx.waitLog(/^(Project saved|Project not saved)/, h);
    check(JSON.parse(readFileSync(projFile, 'utf8')).description === 'crash-test change', 'PROJECTSAVE wrote the recovered changes');
    let gone = false;
    for (let i = 0; i < 40 && !gone; i += 1) {
      await sleep(100);
      gone = ctx.autosaveFiles().length === 0;
    }
    check(gone, `the project autosave is removed after the save (${ctx.autosaveFiles().join(', ')})`);
    flowsRun.push('relaunch: Project Recovery, Drawing Recovery, PROJECTSAVE');
  } catch (err) {
    bad(`unexpected: ${err && err.stack ? err.stack : err}`);
  } finally {
    await ctx.close();
  }
  checkClean(ctx, 'project recovery');
});

// ------------------------------------------------------------------ close / quit matrix
const SMALL_DXF = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '40', '21', '20', '0', 'ENDSEC', '0', 'EOF', ''].join('\r\n');
/**
 * How the application is asked to close. Each returns a promise that settles when the trigger
 * itself is done (the restart trigger resolves the main process's answer: may it restart?).
 */
const TRIGGERS = {
  'window close': (ctx) => ctx.closeWindow(),
  'File > Exit (app menu)': async (ctx) => {
    await ctx.win.locator('.app-logo').click();
    await ctx.win.locator('.appmenu-footer button', { hasText: 'Exit JCad Electrical' }).click();
  },
  'File > Quit (native menu)': (ctx) => ctx.app.evaluate(({ Menu }) => void Menu.getApplicationMenu().items[0].submenu.items.find((i) => i.role === 'quit').click()),
  'Ctrl+Q': (ctx) =>
    ctx.app.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Q', modifiers: ['control'] });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Q', modifiers: ['control'] });
    }),
  'app-quit IPC': (ctx) => ctx.win.evaluate(() => window.jcad.quit()),
  'updater restart': (ctx) =>
    ctx.app.evaluate(async ({ BrowserWindow, app }, mainFile) => {
      const updater = process.getBuiltinModule('node:module').createRequire(mainFile)('./updater.cjs');
      const ok = await updater.confirmRestart(BrowserWindow.getAllWindows()[0]);
      // electron-updater's quitAndInstall: app.quit() once the installer is started.
      if (ok && globalThis.__e2e.restartQuits !== false) setImmediate(() => app.quit());
      return ok;
    }, join(repo, 'electron', 'main.cjs')).catch(() => 'gone'),
};

/** Slow autosave writes in the renderer (the store the Autosaver uses), `ms` per drawing. */
const slowAutosave = (ctx, ms) =>
  ctx.win.evaluate((d) => {
    const a = window.jacUi.autosaver;
    const real = a.store;
    a.store = { ...real, write: async (n, t, m) => { await new Promise((r) => setTimeout(r, d)); return real.write(n, t, m); } };
  }, ms);

async function openDrawing(ctx, file) {
  await ctx.pushOpen(file);
  const h = await ctx.h();
  await ctx.run('OPEN');
  if (!(await ctx.waitLog(/^(Opened|Imported DWG|Failed to open|Not opened)/, h, 60_000))) bad(`OPEN ${file} logged nothing`);
  return ctx.logSince(h);
}

async function startSymbolBuilder(ctx) {
  await ctx.run('AESYMBUILDER');
  const start = ctx.win.locator('.modal').last();
  await start.waitFor({ timeout: 10_000 });
  await start.locator('.btn.primary').last().click();
  await ctx.win.waitForFunction(() => !document.getElementById('symbol-builder').classList.contains('hidden'), null, { timeout: 10_000 }).catch(() => bad('Symbol Builder did not open'));
}

const saveAllDlg = (ctx) => ctx.win.locator('.modal', { hasText: 'item(s) have unsaved changes' });
async function tick(ctx, keep) {
  const rows = saveAllDlg(ctx).locator('.save-all-row');
  for (let i = 0; i < (await rows.count()); i += 1) {
    const title = (await rows.nth(i).locator('b').textContent()) ?? '';
    const box = rows.nth(i).locator('input[type=checkbox]');
    if (keep.some((k) => title.includes(k))) await box.check();
    else await box.uncheck();
  }
}

scenario('close', async () => {
  const onlyTriggers = (process.env.JCAD_TRIGGERS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const [name, trigger] of Object.entries(TRIGGERS)) {
    if (onlyTriggers.length && !onlyTriggers.some((x) => name.toLowerCase().includes(x.toLowerCase()))) continue;
    // ---- clean: closes (or may restart) at once, without any question
    step = `close [${name}] clean`;
    {
      const ctx = await launch(tempDir('profile'));
      try {
        const r = await trigger(ctx);
        if (name === 'updater restart') check(r === true || r === 'gone', `nothing unsaved: the restart is allowed at once (${r})`);
        const exited = await Promise.race([ctx.exited, sleep(10_000).then(() => false)]);
        check(exited === true, 'nothing unsaved: the application closed without a question');
        flowsRun.push(`${name}: clean`);
      } catch (err) {
        bad(`unexpected: ${err && err.stack ? err.stack : err}`);
      } finally {
        await ctx.close();
      }
      checkClean(ctx, `${name} clean`);
    }

    // ---- everything unsaved: two drawings, the project, a Symbol Builder tab; slow autosave; one save fails
    step = `close [${name}] unsaved`;
    const profile = tempDir('profile');
    const work = tempDir('work');
    const full = tempDir('full');
    const realEnospc = makeFullDisk(full);
    const a = join(work, 'a.dxf');
    const b = join(full, 'b.dxf');
    const bSaved = join(work, 'b-saved.dxf');
    writeFileSync(a, readFileSync(fixtures.dxf));
    writeFileSync(b, SMALL_DXF);
    const aBytes = readFileSync(a);
    const projFile = join(work, 'close.jcadproj.json');
    writeProject(projFile, 'Close Test', ['a.dxf']);
    const ctx = await launch(profile);
    try {
      if (!realEnospc) await ctx.setFaults([{ prefix: full + '/', code: 'ENOSPC', op: 'open' }]);
      await openDrawing(ctx, a);
      await ctx.edit('a');
      await openDrawing(ctx, b);
      await ctx.edit('b');
      await openProject(ctx, projFile);
      await ctx.win.evaluate(() => window.editor.updateProject({ ...window.editor.project, description: 'close matrix' }));
      await startSymbolBuilder(ctx);
      const tabs = await ctx.tabs();
      check(tabs.filter((t) => t.dirty).length === 3 && (await ctx.projectState()).dirty, `unsaved: ${tabs.map((t) => `${t.title}${t.dirty ? '*' : ''}`).join(', ')} + project`);
      await ctx.messages();

      // 1. The dialog lists everything; the main process waits past its 5 s fallback; a second request shows no second dialog; Cancel.
      let pending = trigger(ctx);
      await saveAllDlg(ctx).waitFor({ timeout: 10_000 });
      const rows = (await saveAllDlg(ctx).locator('.save-all-row').allInnerTexts()).map((t) => t.trim());
      check(rows.length === 4 && /a\.dxf/.test(rows[0]) && /b\.dxf/.test(rows[1]) && /Symbol/.test(rows[2]) && /Close Test.*Project/.test(rows[3]), `one Save All dialog lists drawings, symbol tab and project in order: ${rows.join(' | ')}`);
      const intro = (await saveAllDlg(ctx).locator('p').first().textContent()) ?? '';
      check(name === 'updater restart' ? /restarting to install the update/.test(intro) : /closing JCad Electrical/.test(intro), `the question names what happens: "${intro}"`);
      if (name === 'window close' || name === 'updater restart' || name === 'Ctrl+Q') {
        await ctx.win.waitForTimeout(6000);
        const msgs = await ctx.messages();
        check((await ctx.windowCount()) === 1 && !msgs.some((m) => m.startsWith('boxsync:')), `the window waits past 5 s for the answer, no "not responding" fallback${msgs.length ? ` (${msgs.join(' ; ')})` : ''}`);
      }
      void TRIGGERS['window close'](ctx);
      await ctx.win.waitForTimeout(400);
      check((await ctx.win.locator('.save-all-list').count()) === 1, 'a second close request while the dialog is open shows no second dialog');
      await saveAllDlg(ctx).locator('button', { hasText: 'Cancel' }).click();
      const r1 = await Promise.race([pending, sleep(5000).then(() => 'pending')]);
      if (name === 'updater restart') check(r1 === false, `Cancel: no restart (${r1})`);
      await ctx.win.waitForTimeout(300);
      check((await ctx.windowCount()) === 1 && (await ctx.tabs()).filter((t) => t.dirty).length === 3 && (await ctx.projectState()).dirty, 'Cancel: the window stays open, everything still modified');

      // 2. An autosave is being written (slowly) when the close is answered; b.dxf cannot be saved (disk full).
      await slowAutosave(ctx, 1500);
      void ctx.run('AUTOSAVE');
      await ctx.win.waitForTimeout(200);
      check(await ctx.win.evaluate(() => window.jacUi.autosaver.busy), 'an autosave is in flight');
      pending = trigger(ctx);
      await saveAllDlg(ctx).waitFor({ timeout: 10_000 });
      await tick(ctx, ['a.dxf', 'b.dxf', 'Close Test']);
      check((await saveAllDlg(ctx).locator('.btn.primary').textContent()) === 'Save Selected', 'unticking the symbol: Save Selected');
      await saveAllDlg(ctx).locator('.btn.primary').click();
      const errDlg = ctx.win.locator('.save-error-dialog .modal');
      const errShown = await errDlg.waitFor({ timeout: 15_000 }).then(() => true, () => false);
      check(errShown, 'the failed save of b.dxf shows the Save Failed dialog (Retry / Save As... / Cancel)');
      if (errShown) {
        const text = await errDlg.innerText();
        check(/"b\.dxf" could not be saved: .*(free space|disk is full|no space)/i.test(text), `it names the file and the cause: ${text.split('\n').slice(0, 3).join(' / ')}`);
        await errDlg.locator('button', { hasText: 'Cancel' }).click();
      }
      // The close workflow then says the close was aborted (one more dialog, after the user's own Cancel).
      await ctx.win.waitForTimeout(500);
      const after = await ctx.win.locator('.modal').allInnerTexts();
      const extra = after.filter((t) => /could not be saved/.test(t));
      check(extra.length === 1 && /b\.dxf could not be saved: there is not enough free space/.test(extra[0]) && !/"b\.dxf" could not be saved/.test(extra[0]), `one follow-up notice that the close was aborted, naming the cause once (${extra.map((t) => t.replace(/\s+/g, ' ').slice(0, 140)).join(' || ')})`);
      for (let i = 0; i < 3 && (await ctx.win.locator('.modal button', { hasText: 'OK' }).count()); i += 1) await ctx.win.locator('.modal button', { hasText: 'OK' }).first().click();
      const r2 = await Promise.race([pending, sleep(15_000).then(() => 'pending')]);
      if (name === 'updater restart') check(r2 === false, `a failed save: no restart (${r2})`);
      await ctx.win.waitForTimeout(300);
      const t2 = await ctx.tabs();
      const aTab = t2.find((t) => t.path === a);
      const bTab = t2.find((t) => t.path === b);
      check((await ctx.windowCount()) === 1, 'a failed save keeps the window open');
      check(aTab && !aTab.dirty && bTab && bTab.dirty && (await ctx.projectState()).dirty && t2.some((t) => /Symbol/.test(t.title) && t.dirty), `a.dxf saved, b.dxf / project / symbol still modified (${t2.map((t) => `${t.title}${t.dirty ? '*' : ''}`).join(', ')}, project ${(await ctx.projectState()).dirty ? 'modified' : 'saved'})`);
      check(existsSync(`${a}.bak`) && Buffer.compare(readFileSync(`${a}.bak`), aBytes) === 0, 'a.dxf.bak holds the original bytes');
      check(Buffer.compare(readFileSync(b), Buffer.from(SMALL_DXF)) === 0, 'b.dxf is unchanged on disk');
      await ctx.win.evaluate(() => window.jacUi.autosaver.flush());
      const idx = Object.values(ctx.autosaveIndex());
      check(idx.some((e) => e.originalPath === b), `b.dxf keeps its autosave backup (${idx.map((e) => e.title).join(', ')})`);
      check(!(await ctx.messages()).some((m) => m.startsWith('boxsync:')), 'no "not responding" fallback while the autosave was written');

      if (name === 'updater restart') {
        // 2b. Restart approved (Discard All) but the installer never quits the app: a later close asks again.
        await ctx.app.evaluate(() => void (globalThis.__e2e.restartQuits = false));
        pending = trigger(ctx);
        await saveAllDlg(ctx).waitFor({ timeout: 10_000 });
        await saveAllDlg(ctx).locator('button', { hasText: 'Discard All' }).click();
        check((await pending) === true, 'Discard All: the restart may go ahead');
        await ctx.win.waitForTimeout(5500);
        await ctx.closeWindow();
        const askedAgain = await saveAllDlg(ctx).waitFor({ timeout: 5000 }).then(() => true, () => false);
        check(askedAgain && (await ctx.windowCount()) === 1, 'the restart did not happen: closing the window later asks about the unsaved work again');
        if (askedAgain) await saveAllDlg(ctx).locator('button', { hasText: 'Cancel' }).click();
        await ctx.app.evaluate(() => void (globalThis.__e2e.restartQuits = true));
        flowsRun.push('updater restart approved without a quit, then window close');
      }
      // 3. Again: b.dxf fails, Save As... puts it elsewhere; the symbol is discarded; the project is saved; the window closes.
      pending = trigger(ctx);
      await saveAllDlg(ctx).waitFor({ timeout: 10_000 });
      const rows3 = (await saveAllDlg(ctx).locator('.save-all-row').allInnerTexts()).map((t) => t.trim());
      check(rows3.length === 3 && !rows3.some((r) => /a\.dxf/.test(r)), `the saved drawing is no longer listed: ${rows3.join(' | ')}`);
      await tick(ctx, ['b.dxf', 'Close Test']);
      await ctx.pushSave(bSaved);
      await saveAllDlg(ctx).locator('.btn.primary').click();
      if (await errDlg.waitFor({ timeout: 15_000 }).then(() => true, () => false)) await errDlg.locator('button', { hasText: 'Save As...' }).click();
      else bad('no Save Failed dialog on the second attempt');
      const exited = await Promise.race([ctx.exited, sleep(20_000).then(() => false)]);
      check(exited === true, 'after Save As... and the project save the application closed');
      check(existsSync(bSaved) && /flow-b|LINE/.test(readFileSync(bSaved, 'utf8')), 'b.dxf was written to the Save As path');
      check(JSON.parse(readFileSync(projFile, 'utf8')).description === 'close matrix', 'the project file was saved before the close');
      check(ctx.autosaveFiles().length === 0, `no drawing backups left for saved work (${ctx.autosaveFiles().join(', ')})`);
      flowsRun.push(`${name}: two drawings + project + symbol, slow autosave, a failing save (cancel, error, Save As)`);
    } catch (err) {
      bad(`unexpected: ${err && err.stack ? err.stack : err}`);
    } finally {
      await ctx.close();
    }
    checkClean(ctx, `${name} unsaved`);
  }
});

// ------------------------------------------------------------------ crashed and hung renderer
scenario('renderer', async () => {
  // A crashed renderer has nothing left to save: the window closes; the autosave stays for recovery.
  step = 'renderer: crashed';
  const profile = tempDir('profile');
  let ctx = await launch(profile);
  try {
    await ctx.edit('crash');
    const h = await ctx.h();
    await ctx.run('AUTOSAVE');
    await ctx.waitLog(/drawing\(s\) autosaved/, h);
    await ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    await sleep(500);
    await ctx.closeWindow();
    const exited = await Promise.race([ctx.exited, sleep(10_000).then(() => false)]);
    check(exited === true, 'a crashed renderer: the window closes without waiting for an answer');
    check(ctx.autosaveFiles().length === 1, `its autosave is kept for the Drawing Recovery Manager (${ctx.autosaveFiles().join(', ')})`);
    flowsRun.push('crashed renderer + window close');
  } catch (err) {
    bad(`unexpected: ${err && err.stack ? err.stack : err}`);
  } finally {
    await ctx.close();
  }
  // The next start offers that backup.
  ctx = await launch(profile);
  try {
    const rec = ctx.win.locator('.recovery-dialog .modal');
    check(await rec.waitFor({ timeout: 10_000 }).then(() => true, () => false), 'the next start offers the backup of the crashed session');
  } finally {
    await ctx.close();
  }

  // A hung renderer (no acknowledgement within 5 s): the native question; Cancel keeps the window, and
  // the Save All dialog that the page shows once it responds again is answered for real.
  step = 'renderer: hung';
  ctx = await launch(tempDir('profile'));
  try {
    await ctx.edit('hung');
    void ctx.win.evaluate(() => {
      const t = Date.now();
      while (Date.now() - t < 8000) {
        /* busy */
      }
    }).catch(() => {});
    await sleep(300);
    await ctx.closeWindow();
    await sleep(6000);
    let msgs = await ctx.messages();
    check(msgs.some((m) => m === 'boxsync:JCad Electrical is not responding.'), `after 5 s without an answer the native "not responding" question appears (${msgs.join(' ; ')})`);
    check((await ctx.windowCount()) === 1, 'Cancel keeps the window open');
    // The page responds again and shows the Save All question it was sent.
    const late = await saveAllDlg(ctx).waitFor({ timeout: 10_000 }).then(() => true, () => false);
    if (late) {
      await saveAllDlg(ctx).locator('button', { hasText: 'Discard All' }).click();
      const exited = await Promise.race([ctx.exited, sleep(5000).then(() => false)]);
      check(exited === true, 'answering the late Save All dialog (Discard All) closes the window');
    } else ok('no late Save All dialog after the native Cancel');
    flowsRun.push('hung renderer: native fallback Cancel, late answer');
  } catch (err) {
    bad(`unexpected: ${err && err.stack ? err.stack : err}`);
  } finally {
    await ctx.close();
  }
  // Close Without Saving from the native question closes at once.
  ctx = await launch(tempDir('profile'));
  try {
    await ctx.edit('hung2');
    await ctx.pushSync(0);
    void ctx.win.evaluate(() => {
      const t = Date.now();
      while (Date.now() - t < 9000) {
        /* busy */
      }
    }).catch(() => {});
    await sleep(300);
    await ctx.closeWindow();
    const exited = await Promise.race([ctx.exited, sleep(12_000).then(() => false)]);
    check(exited === true, 'hung renderer: "Close Without Saving" closes the window');
    flowsRun.push('hung renderer: Close Without Saving');
  } catch (err) {
    bad(`unexpected: ${err && err.stack ? err.stack : err}`);
  } finally {
    await ctx.close();
  }
});

// ------------------------------------------------------------------ open flows
scenario('open', async () => {
  step = 'open';
  const work = tempDir('open');
  const files = {};
  for (const n of ['a', 'b', 'c', 'same']) {
    files[n] = join(work, `${n}.dxf`);
    writeFileSync(files[n], readFileSync(fixtures.dxf));
  }
  const damaged = join(work, 'damaged.dxf');
  writeFileSync(damaged, readFileSync(join(repo, 'tests', 'fixtures', 'broken', 'bad-groupcode.dxf')));
  const truncated = join(work, 'truncated.dxf');
  writeFileSync(truncated, readFileSync(fixtures.truncated));
  const ctx = await launch(tempDir('profile'));
  try {
    // ---- a slow open finishes in the tab it was started from while the user works in another tab
    step = 'open: slow open, switch tabs';
    await ctx.edit('x');
    const xId = (await ctx.tabs())[0].id;
    await ctx.setSlowReads([{ path: files.a, ms: 2500 }]);
    await ctx.pushOpen(files.a);
    let h = await ctx.h();
    await ctx.run('OPEN');
    await ctx.win.waitForTimeout(400);
    let t = await ctx.tabs();
    check(t.length === 2 && (await ctx.active()) === 1, `OPEN made a new tab for the file (${t.length} tabs)`);
    await ctx.win.evaluate(() => window.editor.sessions.switchTo(0));
    await ctx.edit('x2');
    await ctx.waitLog(/^Opened /, h, 15_000);
    t = await ctx.tabs();
    const aTab = t.find((x) => x.path === files.a);
    check(t.length === 2 && aTab && aTab.n === 25 && !aTab.dirty && (await ctx.active()) === 0 && t[0].id === xId && t[0].dirty, `the slow open landed in its own tab in the background (${t.map((x) => `${x.title}:${x.n}${x.dirty ? '*' : ''}`).join(', ')}; active ${await ctx.active()})`);
    check((await ctx.logSince(h)).some((l) => /in the tab it was opened from/.test(l)), 'the log says it opened in the tab it was started from');
    flowsRun.push('slow OPEN + switch tabs');

    // ---- OPEN while a slow open is pending, then switch tabs: both files open, once each
    step = 'open: two opens';
    await ctx.setSlowReads([{ path: files.b, ms: 2500 }]);
    await ctx.pushOpen(files.b, files.c);
    h = await ctx.h();
    await ctx.run('OPEN');
    await ctx.win.waitForTimeout(300);
    await ctx.run('OPEN');
    await ctx.win.waitForTimeout(300);
    await ctx.win.evaluate(() => window.editor.sessions.switchTo(0));
    await ctx.win.waitForFunction((k) => window.editor.history.slice(k).filter((l) => /^Opened /.test(l)).length >= 2, h, { timeout: 15_000 }).catch(() => bad('the two opens did not both finish'));
    t = await ctx.tabs();
    const count = (p) => t.filter((x) => x.path === p).length;
    check(count(files.b) === 1 && count(files.c) === 1 && t.length === 4 && t.every((x) => x.path || x.dirty), `b.dxf and c.dxf are each open once, no empty tab left (${t.map((x) => x.title).join(', ')})`);
    check((await ctx.active()) === 0, 'the tab the user switched to stays active');
    flowsRun.push('OPEN while a slow open is pending + switch tabs');

    // ---- the same file opened twice: one tab
    step = 'open: same file twice';
    await ctx.setSlowReads([]);
    await openDrawing(ctx, files.same);
    await ctx.win.evaluate(() => window.editor.sessions.switchTo(0));
    await ctx.pushOpen(files.same);
    h = await ctx.h();
    await ctx.run('OPEN');
    await ctx.win.waitForTimeout(1500);
    t = await ctx.tabs();
    check(t.filter((x) => x.path === files.same).length === 1, `opening a file that is already open does not open a second copy (${t.map((x) => x.title).join(', ')})`);
    check(t[await ctx.active()].path === files.same, 'its tab is shown');
    // Two RECENT requests in a row (double click) for a file that is not open yet.
    await ctx.win.evaluate((p) => {
      const s = window.editor.sessions;
      s.close(s.indexOfPath(p));
    }, files.same);
    await ctx.setSlowReads([{ path: files.same, ms: 800 }]);
    const ri = (await ctx.win.evaluate(() => window.editor.settings.recentFiles)).indexOf(files.same) + 1;
    await ctx.run(`RECENT ${ri}`);
    await ctx.run(`RECENT ${ri}`);
    await ctx.win.waitForTimeout(2500);
    t = await ctx.tabs();
    check(t.filter((x) => x.path === files.same).length === 1, `RECENT twice while the file loads: one tab (${t.map((x) => x.title).join(', ')})`);
    await ctx.setSlowReads([]);
    flowsRun.push('the same file opened twice (OPEN, RECENT x2)');

    // ---- failed opens and the recent list
    step = 'open: failures and RECENT';
    const before = await ctx.win.evaluate(() => window.editor.settings.recentFiles.slice());
    const tabsBefore = (await ctx.tabs()).length;
    await ctx.pushOpen(damaged);
    h = await ctx.h();
    await ctx.run('OPEN');
    await ctx.waitLog(/^(Failed to open|Opened|Not opened)/, h);
    let log = await ctx.logSince(h);
    check(log.some((l) => /^Failed to open drawing: /.test(l)), `a damaged file is reported: ${log.find((l) => /Failed|Opened/.test(l))}`);
    await ctx.win.waitForTimeout(300);
    check((await ctx.tabs()).length === tabsBefore, 'no tab is left behind by the failed open');
    let recent = await ctx.win.evaluate(() => window.editor.settings.recentFiles.slice());
    check(!recent.includes(damaged), `a file that failed to open is not added to Recent Documents (${recent.slice(0, 3).join(', ')})`);
    // Declining the partial recovery of a truncated file.
    await ctx.pushOpen(truncated);
    h = await ctx.h();
    await ctx.run('OPEN');
    const ask = ctx.modal('Open what was readable?');
    if (await ask.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await ask.locator('button', { hasText: 'No' }).click();
    else bad('no partial-recovery question for a truncated file');
    await ctx.waitLog(/^Not opened/, h);
    recent = await ctx.win.evaluate(() => window.editor.settings.recentFiles.slice());
    check(!recent.includes(truncated), 'a truncated file whose recovery was declined is not added to Recent Documents');
    // A remembered file that was deleted: RECENT reports it.
    rmSync(files.c === undefined ? '' : join(work, 'gone.dxf'), { force: true });
    writeFileSync(join(work, 'gone.dxf'), readFileSync(fixtures.dxf));
    await openDrawing(ctx, join(work, 'gone.dxf'));
    await ctx.win.evaluate((p) => {
      const s = window.editor.sessions;
      s.close(s.indexOfPath(p));
    }, join(work, 'gone.dxf'));
    rmSync(join(work, 'gone.dxf'));
    const gi = (await ctx.win.evaluate(() => window.editor.settings.recentFiles)).indexOf(join(work, 'gone.dxf')) + 1;
    h = await ctx.h();
    const nTabs = (await ctx.tabs()).length;
    await ctx.run(`RECENT ${gi}`);
    await ctx.waitLog(/^(Failed to open|Opened)/, h);
    log = await ctx.logSince(h);
    check(log.some((l) => /^Failed to open drawing: "gone\.dxf" could not be read: the file is no longer in /.test(l)), `RECENT of a deleted file says so: ${log.find((l) => /Failed/.test(l))}`);
    await ctx.win.waitForTimeout(300);
    check((await ctx.tabs()).length === nTabs, 'and leaves no empty tab');
    void before;
    flowsRun.push('failed opens (damaged, declined recovery, deleted RECENT entry)');

    // ---- a truncated DXF finishing in a background tab: recovery prompt, report, recovered flag
    step = 'open: truncated in background';
    await ctx.setSlowReads([{ path: truncated, ms: 2000 }]);
    await ctx.pushOpen(truncated);
    h = await ctx.h();
    await ctx.run('OPEN');
    await ctx.win.waitForTimeout(300);
    const newTab = await ctx.active();
    await ctx.win.evaluate(() => window.editor.sessions.switchTo(0));
    const ask2 = ctx.modal('Open what was readable?');
    if (await ask2.waitFor({ timeout: 10_000 }).then(() => true, () => false)) await ask2.locator('button', { hasText: 'Yes' }).click();
    else bad('no partial-recovery question for the background open');
    await ctx.waitLog(/^Opened /, h);
    const rep = ctx.win.locator('.import-report-dialog .modal');
    const repShown = await rep.waitFor({ timeout: 5000 }).then(() => true, () => false);
    check(repShown && /RECOVERED|recovered|ends early/i.test(await rep.innerText()), 'the import report (recovered) is shown although the drawing opened in a background tab');
    if (repShown) await rep.locator('button', { hasText: 'Close' }).click();
    t = await ctx.tabs();
    const tr = t.find((x) => x.path === truncated);
    check(tr && tr.dirty && (await ctx.active()) === 0 && t.indexOf(tr) === newTab, `the recovered drawing is in its own tab, marked modified (${t.map((x) => `${x.title}${x.dirty ? '*' : ''}`).join(', ')})`);
    check((await ctx.logSince(h)).some((l) => /^RECOVERED drawing/.test(l)), 'the log marks it RECOVERED');
    await ctx.setSlowReads([]);
    // SAVE over the recovered file asks first (No = Save As).
    await ctx.win.evaluate((i) => window.editor.sessions.switchTo(i), t.indexOf(tr));
    const tBytes = readFileSync(truncated);
    await ctx.run('SAVE');
    const over = ctx.modal('Save over the original file?');
    if (await over.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
      await over.locator('button', { hasText: 'No' }).click();
      await ctx.win.waitForTimeout(500);
    } else bad('SAVE over a recovered file did not ask');
    check(Buffer.compare(readFileSync(truncated), tBytes) === 0, 'the truncated original was not overwritten');
    flowsRun.push('truncated DXF in a background tab (recovery, report, recovered flag, Save warning)');

    // ---- DWG: import report, then PLOT
    step = 'open: DWG + PLOT';
    if (existsSync(fixtures.dwg)) {
      const log2 = await openDrawing(ctx, fixtures.dwg);
      check(log2.some((l) => /^Imported DWG/.test(l)), `DWG imported: ${log2.find((l) => /Imported|Failed/.test(l))}`);
      const dwgRep = ctx.win.locator('.import-report-dialog .modal', { hasText: 'DWG Import Report' });
      if (await dwgRep.waitFor({ timeout: 5000 }).then(() => true, () => false)) await dwgRep.locator('button', { hasText: 'Close' }).click();
      else bad('no DWG import report');
      const pdf = join(work, 'dwg-plot.pdf');
      await ctx.pushSave(pdf);
      h = await ctx.h();
      await ctx.run('PLOT');
      const dlg = ctx.modal('Paper size');
      await dlg.waitFor({ timeout: 10_000 });
      await dlg.locator('button', { hasText: 'Plot to PDF' }).click();
      await ctx.waitLog(/^Plotted to /, h, 60_000);
      check(existsSync(pdf) && readFileSync(pdf).subarray(0, 5).toString() === '%PDF-' && statSync(pdf).size > 1000, `the DWG plotted to PDF (${existsSync(pdf) ? statSync(pdf).size : 0} bytes)`);
      flowsRun.push('DWG with import report, then PLOT');
    }
  } catch (err) {
    bad(`unexpected: ${err && err.stack ? err.stack : err}`);
  } finally {
    await ctx.close();
  }
  checkClean(ctx, 'open flows');
});

// ================================================================== run
for (const s of scenarios) {
  if (!want(s.name)) continue;
  console.log(`\n=== ${s.name}`);
  step = s.name;
  try {
    await s.fn();
  } catch (err) {
    bad(`unexpected: ${err && err.stack ? err.stack : err}`);
  }
}
clearTimeout(hardTimeout);
for (const c of cleanups) {
  try {
    c();
  } catch {
    /* best effort */
  }
}
console.log(`\ne2e-flows: ${flowsRun.length} flows driven, ${results.length} checks passed, ${problems.length} failed (${process.platform} ${process.arch}, Electron ${pkg.devDependencies.electron})`);
if (problems.length) {
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
