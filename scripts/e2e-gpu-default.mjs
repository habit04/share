// Run after npm run build; verify the production/default gate on real Electron.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { applicationWindow, closeApplication } from './electron-window.mjs';
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
  assert.equal(await page.evaluate(() => window.editor.commands.has('GPURENDERER')), true);
  assert.equal(await page.locator('canvas[data-gpu-candidate]').count(), 0);
  const unchanged = await page.evaluate(() => {
    const e = window.editor, before = e.doc.snapshot;
    e.runCommand('GPURENDERER');
    e.runCommand('GPURENDERER invalid');
    e.runCommand('GPURENDERER CANVAS');
    return e.doc.snapshot === before;
  });
  assert.equal(unchanged, true);
  assert.equal(await page.locator('canvas[data-gpu-candidate]').count(), 0);
  assert.equal(await page.evaluate(() => window.editor.commands.has('GPU3DDEMO')), false);
  const count = await page.evaluate(() => window.editor.doc.entities.length);
  await page.evaluate(() => { const e = window.editor; e.runCommand('LINE'); e.submitInput('0,0'); e.submitInput('10,10'); e.submitInput(''); });
  assert.equal(await page.evaluate(() => window.editor.doc.entities.length), count + 1);
  console.log('Ordinary build: Canvas default, explicit candidate command, no developer globals/demo or allocated GPU, 2D LINE works.');
} finally {
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  await closeApplication(app); // bounded (PR23 ASAR diagnosis); tree-kills a wedged app by pid
}
