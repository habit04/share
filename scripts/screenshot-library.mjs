// Capture the Insert Component icon menu for every category of both standards (visual review of the symbol library).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

const root = join(process.cwd(), 'dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  try {
    if ((await stat(p)).isDirectory()) p = join(p, 'index.html');
    res.setHeader('Content-Type', types[extname(p)] ?? 'application/octet-stream');
    res.end(await readFile(p));
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
await mkdir('screenshots/library', { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
await page.goto(`http://localhost:${port}/?demo`);
await page.waitForTimeout(400);

for (const std of ['JIC', 'IEC']) {
  await page.evaluate((s) => {
    const ed = window.editor;
    ed.settings = { ...ed.settings, symbolStandard: s };
    ed.runCommand('AECOMPONENT');
  }, std);
  await page.waitForTimeout(300);
  // Make sure the dialog shows the requested standard.
  const title = await page.locator('.modal-title, .modal h3, .modal header').first().textContent().catch(() => '');
  if (!title.includes(std)) {
    await page.getByRole('button', { name: `Switch to ${std}` }).click();
    await page.waitForTimeout(300);
  }
  const n = await page.locator('.iconmenu-cat').count();
  console.log(std, 'categories:', n);
  for (let i = 0; i < n; i += 1) {
    const cat = page.locator('.iconmenu-cat').nth(i);
    const name = (await cat.textContent()).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    await cat.click();
    await page.waitForTimeout(120);
    await page.locator('.modal').first().screenshot({ path: `screenshots/library/${std}-${String(i + 1).padStart(2, '0')}-${name}.png` });
  }
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove()));
  await page.waitForTimeout(150);
}
await browser.close();
server.close();
