// Windows development validation; isolated profile, built renderer, no installers.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { applicationWindow } from './electron-window.mjs';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'e2e-output/gpu-diagnostics');
const profile = resolve(out, `profile-${Date.now()}`);
mkdirSync(out, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.VITE_DEV_SERVER_URL;
const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env, timeout: 60_000 });
try {
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
  const page = await applicationWindow(app);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForFunction(() => !!window.editor);
  let snapshot;
  for (let attempt = 0; attempt < 15; attempt++) {
    snapshot = await page.evaluate(() => window.jcad.gpuDiagnostics());
    if (snapshot.state !== 'pending') break;
    await page.waitForTimeout(300);
  }
  assert.equal(snapshot.state, 'ready', 'Windows GPU collection completed');
  assert.ok(snapshot.versions.electron);
  assert.ok(snapshot.versions.chromium);
  assert.ok(snapshot.versions.windows);
  assert.ok(!JSON.stringify(snapshot).includes(profile));
  await page.evaluate(() => window.editor.runCommand('ABOUT'));
  await page.getByText('GPU diagnostics', { exact: true }).waitFor();
  const copy = page.getByRole('button', { name: 'Copy Diagnostics', exact: true });
  await copy.waitFor();
  // Exercise the real Windows clipboard, rather than replacing navigator.clipboard.
  await copy.click();
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(copied, /Canvas 2D/);
  assert.match(copied, /Electron/);
  await page.screenshot({ path: resolve(out, 'about-gpu.png') });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.editor.runCommand('REPORTBUG'));
  await page.waitForFunction(() => document.querySelector('.report-preview')?.textContent?.includes('Canvas 2D'));
  const report = await page.locator('.report-preview').textContent();
  assert.match(report, /GPU diagnostics/i);
  assert.ok(!report.includes(profile));
  await page.screenshot({ path: resolve(out, 'report-gpu.png') });
  await page.keyboard.press('Escape');
  // A normal 2D command still creates drawing entities after opening both dialogs.
  const count = await page.evaluate(() => window.editor.doc.entities.length);
  await page.evaluate(() => {
    const editor = window.editor;
    editor.runCommand('LINE');
    editor.submitInput('1,2');
    editor.submitInput('4,6');
    editor.submitInput('');
  });
  assert.equal(await page.evaluate(() => window.editor.doc.entities.length), count + 1);
  assert.deepEqual(errors, []);
  writeFileSync(resolve(out, 'diagnostics.json'), JSON.stringify(snapshot, null, 2));
  console.log(`GPU diagnostics: real Windows collector, About, clipboard and bug-report checks passed (Electron ${snapshot.versions.electron}).`);
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
