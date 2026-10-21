// Verify the one-time file-origin preference migration with the real Electron runtime.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { applicationWindow, closeApplication } from './electron-window.mjs';
import { originFailureDiagnostics } from './origin-failure-diagnostics.mjs';

const repo = resolve(import.meta.dirname, '..');
const packagedArg = process.argv.indexOf('--packaged');
const executable = packagedArg >= 0 ? process.argv[packagedArg + 1] : undefined;
if (packagedArg >= 0 && (!executable || !existsSync(executable))) throw new Error('Provide the packaged application executable after --packaged.');
const profile = mkdtempSync(join(tmpdir(), 'jcad-origin-e2e-'));
const archive = executable ? join(dirname(executable), process.platform === 'darwin' ? '../Resources/app.asar' : 'resources/app.asar') : undefined;
const index = archive ? join(archive, 'dist', 'index.html') : join(repo, 'dist', 'index.html');
assert.ok(existsSync(archive || index), 'Build the desktop renderer or packaged application before running the origin check.');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const linuxTestArgs = process.platform === 'linux' ? ['--no-sandbox'] : [];
const seedFile = join(profile, 'legacy-seed.cjs');
writeFileSync(seedFile, `const {app,BrowserWindow,protocol}=require('electron');
app.whenReady().then(async()=>{
  protocol.handle('file',()=>new Response('<!doctype html>',{headers:{'content-type':'text/html'}}));
  const w=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
  await w.loadFile(${JSON.stringify(index)});
  await w.webContents.executeJavaScript("localStorage.setItem('jcad-origin-test','legacy preference Δ 雷'); localStorage.setItem('jcad-origin-deleted-test','stale legacy setting');");
  w.webContents.session.flushStorageData();
  w.destroy(); app.quit();
}).catch(e=>{console.error(e);app.exit(1)});`);

// Round 6 (F3): the seed exit and app spawn instants bracket the Local
// Storage leveldb contention window; the failure diagnostics record them.
/** @type {string | undefined} */
let seedExitedAt;
try {
  await new Promise((resolveSeed, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [seedFile, `--user-data-dir=${profile}`, ...linuxTestArgs], { cwd: repo, env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Legacy preference seeding timed out.')); }, 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      seedExitedAt = new Date().toISOString();
      clearTimeout(timer);
      if (code === 0) resolveSeed(undefined);
      else reject(new Error(`Legacy seed exited ${code}`));
    });
  });

  for (let launch = 0; launch < 3; launch++) {
    const appSpawnedAt = new Date().toISOString();
    const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [...(executable ? [] : ['.']), `--user-data-dir=${profile}`, ...linuxTestArgs], cwd: repo, env, timeout: 60_000 });
    const diagnostic = originFailureDiagnostics(app, { profile, output: process.env.JCAD_E2E_OUT, launch, seedExitedAt, appSpawnedAt });
    let failed = false;
    let uncleanClose = null;
    try {
      const page = await applicationWindow(app);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.waitForFunction(() => Boolean(window.editor), null, { timeout: 30_000 });
      // This marker is the real acknowledgement of the atomic checkpoint and migration commit.
      await page.waitForFunction(() => localStorage.getItem('jcad-origin-migrated') === '1', null, { timeout: 30_000 });
      const result = await page.evaluate(() => ({
        url: location.href,
        preference: localStorage.getItem('jcad-origin-test'),
        deleted: localStorage.getItem('jcad-origin-deleted-test'),
        migrated: localStorage.getItem('jcad-origin-migrated'),
        secure: isSecureContext && Boolean(crypto.subtle),
        bridge: Boolean(window.jcad),
      }));
      const storage = await app.evaluate(({ app: main, session }) => ({
        userData: main.getPath('userData'), sessionData: main.getPath('sessionData'),
        storagePath: session.defaultSession.storagePath, persistent: session.defaultSession.isPersistent(),
      }));
      const privatePath = realpathSync.native(profile);
      console.log(`Origin storage launch ${launch + 1}: ${JSON.stringify({
        ...result, persistent: storage.persistent,
        privateUserData: realpathSync.native(storage.userData) === privatePath,
        privateSessionData: realpathSync.native(storage.sessionData) === privatePath,
        privateStorage: storage.storagePath && realpathSync.native(storage.storagePath) === privatePath,
        migrationMarker: existsSync(join(profile, 'renderer-origin-migrated')),
      })}`);
      assert.equal(storage.persistent, true, 'The default session must persist renderer preferences.');
      assert.equal(result.url, 'jcad://app/index.html');
      assert.equal(result.preference, ['legacy preference Δ 雷', 'new preference', 'newest preference'][launch]);
      assert.equal(result.deleted, launch === 0 ? 'stale legacy setting' : null, 'A deleted setting must not return from legacy storage or the checkpoint.');
      assert.equal(result.migrated, '1');
      assert.equal(result.secure, true);
      assert.equal(result.bridge, true);
      assert.deepEqual(errors, []);
      if (launch === 0) await page.evaluate(() => {
        localStorage.setItem('jcad-origin-test', 'new preference');
        localStorage.removeItem('jcad-origin-deleted-test');
      });
      // The second launch must preserve values already saved at the new origin.
      if (launch === 1) await page.evaluate(() => {
        if (localStorage.getItem('jcad-origin-test') !== 'new preference') throw new Error('Changed preference did not survive immediate restart.');
        localStorage.setItem('jcad-origin-test', 'newest preference');
      });
      console.log(`Secure renderer origin and preference migration: launch ${launch + 1} passed.`);
    } catch (error) {
      failed = true;
      await diagnostic.capture(error);
      throw error;
    } finally {
      diagnostic.stop();
      // Bound the cleanup close (PR23 ASAR diagnosis): a wedged main process
      // leaves app.close() pending, which once burned the whole shared CI
      // budget in cleanup after the failure was already named. On expiry the
      // helper tree-kills by pid. Keep the actual assertion/launch failure if
      // owned cleanup also reports an error.
      const close = await closeApplication(app, failed ? 15_000 : 30_000);
      if (close.outcome !== 'closed') {
        if (failed) {
          console.error(close.outcome === 'rejected'
            ? `Origin cleanup after failure: application close was rejected (${String(close.error)}).`
            : 'Origin cleanup after failure: application close exceeded its bound and was tree-killed.');
        }
        // A throw in finally could mask the primary failure; the unclean
        // success-path close is thrown after this block instead, with the
        // outcome distinguished: 'close rejected' vs 'bound exceeded'.
        else uncleanClose = close;
      }
    }
    if (uncleanClose) {
      throw uncleanClose.outcome === 'rejected'
        ? new Error(`The application close was rejected: ${uncleanClose.error instanceof Error ? uncleanClose.error.message : String(uncleanClose.error)}`)
        : new Error('The application did not close within its bound and was tree-killed.');
    }
    if (launch === 1) {
      // Emulate lost Chromium DOM storage after a completed quit. Keep the durable private
      // checkpoint and migration marker; the next immediate launch must recover the latest state.
      assert.ok(existsSync(join(profile, 'renderer-preferences.json')));
      const storageDir = resolve(profile, 'Local Storage');
      assert.equal(dirname(storageDir), resolve(profile));
      rmSync(storageDir, { recursive: true, force: true });
    }
  }
} finally {
  // Only delete the private, freshly created test profile.
  if (process.env.JCAD_ORIGIN_E2E_KEEP === '1') console.log(`Origin validation profile: ${profile}`);
  else if (profile.startsWith(join(tmpdir(), 'jcad-origin-e2e-'))) rmSync(profile, { recursive: true, force: true });
}
