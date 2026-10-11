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
