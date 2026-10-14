// Run after npm run build; verify the production/default gate on real Electron.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { applicationWindow } from './electron-window.mjs';
const root = resolve(import.meta.dirname, '..');
const profile = resolve(root, `e2e-output/gpu-default/profile-${Date.now()}`);
mkdirSync(profile, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL;
const started = performance.now();
const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: root, env, timeout: 60000 });
try {
  const page = await applicationWindow(app);
  await page.waitForFunction(() => !!window.editor);
  writeFileSync(resolve(root, 'e2e-output/gpu-default/default-launch.json'), JSON.stringify({ applicationLaunchMs: performance.now() - started, note: 'One fresh application process; OS caches not purged.' }, null, 2));
  assert.equal(await page.evaluate(() => !!window.gpuPrototype), false);
  assert.equal(await page.locator('[data-gpu-prototype]').count(), 0);
  assert.equal(await page.evaluate(() => window.editor.commands.has('GPURENDERER')), false);
  assert.equal(await page.evaluate(() => window.editor.commands.has('GPU3DDEMO')), false);
  const count = await page.evaluate(() => window.editor.doc.entities.length);
  await page.evaluate(() => { const e = window.editor; e.runCommand('LINE'); e.submitInput('0,0'); e.submitInput('10,10'); e.submitInput(''); });
  assert.equal(await page.evaluate(() => window.editor.doc.entities.length), count + 1);
  console.log('Default build: no experimental GPU UI/device or commands, 2D LINE works.');
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await app.close().catch(() => {});
}
