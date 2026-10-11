// Verify the one-time file-origin preference migration with the real Electron runtime.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
import { applicationWindow } from './electron-window.mjs';

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
  await w.webContents.executeJavaScript("localStorage.setItem('jcad-origin-test','legacy preference Δ 雷');");
  w.destroy(); app.quit();
}).catch(e=>{console.error(e);app.exit(1)});`);

try {
  await new Promise((resolveSeed, reject) => {
    const child = spawn(createRequire(import.meta.url)('electron'), [seedFile, `--user-data-dir=${profile}`, ...linuxTestArgs], { cwd: repo, env, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Legacy preference seeding timed out.')); }, 30_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveSeed(undefined);
      else reject(new Error(`Legacy seed exited ${code}`));
    });
  });

  for (let launch = 0; launch < 2; launch++) {
    const app = await electron.launch({ ...(executable ? { executablePath: executable } : {}), args: [...(executable ? [] : ['.']), `--user-data-dir=${profile}`, ...linuxTestArgs], cwd: repo, env, timeout: 60_000 });
    try {
      const page = await applicationWindow(app);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.waitForFunction(() => Boolean(window.editor), null, { timeout: 30_000 });
      const result = await page.evaluate(() => ({
        url: location.href,
        preference: localStorage.getItem('jcad-origin-test'),
        migrated: localStorage.getItem('jcad-origin-migrated'),
        secure: isSecureContext && Boolean(crypto.subtle),
        bridge: Boolean(window.jcad),
      }));
      assert.equal(result.url, 'jcad://app/index.html');
      assert.equal(result.preference, launch === 0 ? 'legacy preference Δ 雷' : 'new preference');
      assert.equal(result.migrated, '1');
      assert.equal(result.secure, true);
      assert.equal(result.bridge, true);
      assert.deepEqual(errors, []);
      if (launch === 0) await page.evaluate(() => localStorage.setItem('jcad-origin-test', 'new preference'));
      // The second launch must preserve values already saved at the new origin.
      if (launch === 1) assert.equal(await page.evaluate(() => localStorage.getItem('jcad-origin-test')), 'new preference');
      console.log(`Secure renderer origin and preference migration: launch ${launch + 1} passed.`);
    } finally { await app.close(); }
  }
} finally {
  // Only delete the private, freshly created test profile.
  if (process.env.JCAD_ORIGIN_E2E_KEEP === '1') console.log(`Origin validation profile: ${profile}`);
  else if (profile.startsWith(join(tmpdir(), 'jcad-origin-e2e-'))) rmSync(profile, { recursive: true, force: true });
}
