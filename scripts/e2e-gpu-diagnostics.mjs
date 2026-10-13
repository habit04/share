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
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    let timer;
    try {
      snapshot = await Promise.race([
        page.evaluate(() => window.jcad.gpuDiagnostics()),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Windows GPU collection exceeded the 20-second deadline')), remaining);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.ok(Date.now() <= deadline, 'Windows GPU collection must settle within 20 seconds');
    if (snapshot.state !== 'pending') break;
    await page.waitForTimeout(Math.min(300, Math.max(0, deadline - Date.now())));
  }
  assert.ok(snapshot && ['ready', 'unavailable'].includes(snapshot.state), 'Windows GPU collection must settle before the deadline');
  // Hosted Windows or unavailable adapters may provide only a bounded partial result.
  // The diagnostics UI must remain truthful and usable; hardware coverage is separate.
  if (snapshot.state === 'unavailable') assert.ok(snapshot.reasons.length > 0, 'Unavailable diagnostics explain their limit');
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
  console.log(`GPU diagnostics: real Windows collector (${snapshot.state}), About, clipboard and bug-report checks passed (Electron ${snapshot.versions.electron}).`);
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
