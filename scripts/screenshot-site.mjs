// Visual checks for the website (site-dist/, built by scripts/build-site.mjs):
//   node scripts/screenshot-site.mjs           landing page at desktop + phone widths -> screenshots/site-*.png,
//                                              then the browser edition opening fixtures/example_2000.dwg
//                                              (fails when no entities appear) -> screenshots/site-app-dwg.png
//   node scripts/screenshot-site.mjs --images  also (re)capture the landing-page pictures into site/img/
//                                              (and site-dist/img/) from the browser edition, 1500x940
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, copyFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const root = join(process.cwd(), 'site-dist');
const withImages = process.argv.includes('--images');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
};
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = join(root, decodeURIComponent(url.pathname));
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
const base = `http://localhost:${port}`;
await mkdir('screenshots', { recursive: true });

// A stand-in for the GitHub API so the page renders deterministically offline (asset names follow
// electron-builder's artifactName in package.json). The offline capture below exercises the fallback.
const fakeRelease = {
  tag_name: 'v0.3.0',
  html_url: 'https://github.com/habit04/share/releases/tag/v0.3.0',
  published_at: '2026-09-20T12:00:00Z',
  assets: [
    ['jcad-electrical-0.3.0-win-x64.exe', 98_000_000],
    ['jcad-electrical-0.3.0-mac-arm64.dmg', 112_000_000],
    ['jcad-electrical-0.3.0-mac-x64.dmg', 118_000_000],
    ['jcad-electrical-0.3.0-linux-x86_64.AppImage', 121_000_000],
    ['jcad-electrical-0.3.0-linux-amd64.deb', 84_000_000],
  ].map(([name, size]) => ({ name, size, browser_download_url: `https://github.com/habit04/share/releases/download/v0.3.0/${name}` })),
};

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures += 1;
};

async function landingPage(viewport, name, { online, userAgent, phone } = { online: true }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, userAgent });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
  await page.route('https://api.github.com/**', (route) => (online ? route.fulfill({ json: fakeRelease }) : route.abort()));
  await page.goto(`${base}/`);
  await page.waitForTimeout(600);
  // Headless Chromium never fetches the lazily loaded gallery pictures for a full-page capture, so load them all.
  await page.evaluate(() => document.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = 'eager'; }));
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 15000 });
  const broken = await page.evaluate(() => [...document.images].filter((i) => i.getAttribute('src') && i.naturalWidth === 0).map((i) => i.getAttribute('src')));
  check(broken.length === 0, `${name}: all pictures load${broken.length ? ` (missing: ${broken.join(', ')})` : ''}`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `screenshots/${name}.png`, fullPage: true });
  if (phone) await page.screenshot({ path: `screenshots/${name}-top.png` });
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  check(width <= viewport.width, `${name}: no horizontal overflow (scrollWidth ${width} <= ${viewport.width})`);
  const primary = await page.locator('#primary-download').getAttribute('href');
  const fallbackShown = await page.locator('#dl-fallback').isVisible();
  if (online && phone) {
    // No desktop installer for a phone: the primary button opens the release page instead.
    check(/releases\/tag\/v0\.3\.0$/.test(primary), `${name}: primary button on a phone opens the release page (${primary})`);
    check(!fallbackShown, `${name}: fallback notice hidden`);
  } else if (online) {
    check(/releases\/download\/v0\.3\.0\/.+\.(exe|dmg|AppImage)$/.test(primary), `${name}: primary button links to an installer (${primary})`);
    check(!fallbackShown, `${name}: fallback notice hidden`);
    const version = await page.locator('#primary-download [data-version]').textContent();
    check(version.trim() === 'v0.3.0', `${name}: version badge ${version.trim()}`);
    const hrefs = await page.locator('.dl-card [data-asset]').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
    check(hrefs.every((h) => /releases\/download\//.test(h)), `${name}: all five platform buttons filled`);
  } else {
    check(/\/releases$/.test(primary), `${name}: offline fallback links to the releases page (${primary})`);
    check(fallbackShown, `${name}: fallback notice visible`);
  }
  await ctx.close();
}

// ---------------------------------------------------------------- browser edition: open a DWG in the page
const app = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
app.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
app.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
const shot = (name) => app.screenshot({ path: name });

async function openFixture(name) {
  const [chooser] = await Promise.all([app.waitForEvent('filechooser'), app.evaluate(() => window.editor.runCommand('OPEN'))]);
  await chooser.setFiles(join(process.cwd(), 'fixtures', name));
  await app.waitForFunction(() => window.editor.doc.entities.length > 0 || /Failed to open/.test(document.querySelector('#command-window')?.textContent ?? ''), null, { timeout: 90000 });
  return app.evaluate(() => window.editor.doc.entities.length);
}

await app.goto(`${base}/app/?web&norecover`);
await app.waitForTimeout(500);
check((await app.locator('.web-banner').count()) === 1, 'browser edition shows the banner');
const t0 = Date.now();
const n = await openFixture('example_2000.dwg');
check(n > 0, `browser edition opened fixtures/example_2000.dwg: ${n} entities in ${Date.now() - t0} ms`);
await app.evaluate(() => window.editor.zoomExtents());
await app.mouse.move(800, 480);
await app.waitForTimeout(200);
await shot('screenshots/site-app-dwg.png');
if (withImages) await shot('site/img/dwg-import.png');

// A second file of another DWG version must work in the same page (the module restarts between reads).
await app.evaluate(() => { window.editor.doc.dirty = false; window.editor.runCommand('NEW'); });
await app.waitForTimeout(150);
const n2 = await openFixture('example_2018.dwg');
check(n2 > 0, `second DWG (example_2018.dwg) in the same page: ${n2} entities`);

// Dismissing the banner is remembered.
await app.locator('.web-banner button').click();
check((await app.locator('.web-banner').count()) === 0, 'banner dismissed');
await app.goto(`${base}/app/?norecover`);
await app.waitForTimeout(300);
check((await app.locator('.web-banner').count()) === 0, 'banner stays hidden after dismissal (localStorage)');

// ---------------------------------------------------------------- landing-page pictures (site/img)
if (withImages) {
  await mkdir('site/img', { recursive: true });
  const closeDialogs = async () => {
    await app.keyboard.press('Escape');
    await app.evaluate(() => document.querySelectorAll('.modal-backdrop, .context-menu, .appmenu, .layer-dropdown').forEach((m) => m.remove()));
  };
  await app.goto(`${base}/app/?demo&norecover`);
  await app.waitForTimeout(500);
  await app.evaluate(() => localStorage.removeItem('jcad.userlib.v1'));
  await app.mouse.move(760, 430);
  await app.waitForTimeout(150);
  await shot('site/img/schematic.png');

  await app.evaluate(() => window.editor.runCommand('AECOMPONENT'));
  await app.waitForTimeout(300);
  await shot('site/img/icon-menu.png');
  await closeDialogs();

  await app.evaluate(() => {
    window.editor.selection = new Set();
    window.editor.runCommand('AEXREF');
    window.editor.runCommand('AEREPORT bom');
  });
  await app.waitForTimeout(300);
  await shot('site/img/reports.png');
  await closeDialogs();

  // Symbol Builder: copy of HPB11_NO from the library, then the editing tab with the palette.
  await app.evaluate(() => window.editor.runCommand('AESYMBUILDER'));
  await app.waitForTimeout(250);
  const dialog = app.locator('.modal').first();
  await dialog.locator('input[name=sb-source][value=library]').check();
  const search = dialog.locator('.sb-option-body.active input.input').first();
  await search.fill('HPB11_NO');
  await app.waitForTimeout(150);
  await dialog.locator('.sb-list-item', { hasText: 'HPB11_NO' }).first().click();
  await app.waitForTimeout(150);
  const nameInput = dialog.locator('fieldset.sb-col input.input').first();
  await nameInput.fill('user pb start');
  await nameInput.dispatchEvent('input');
  const descInput = dialog.locator('fieldset.sb-col input.input').nth(1);
  await descInput.fill('Illuminated start button');
  await descInput.press('Enter');
  await app.waitForTimeout(400);
  await app.evaluate(() => window.editor.zoomExtents());
  await app.waitForTimeout(200);
  await shot('site/img/symbol-builder.png');

  // Sheet template with a PLC module.
  await app.evaluate(() => {
    window.editor.doc.dirty = false;
    window.editor.runCommand('NEWSHEET');
  });
  await app.waitForTimeout(250);
  await app.click('.modal .btn.primary >> nth=-1');
  await app.waitForTimeout(250);
  await app.evaluate(() => window.editor.runCommand('AEPLC'));
  await app.waitForTimeout(200);
  await app.click('.modal .btn.primary >> nth=-1');
  await app.waitForTimeout(100);
  await app.evaluate(() => window.editor.submitInput('3,9'));
  await app.evaluate(() => window.editor.zoomExtents());
  await app.waitForTimeout(200);
  await shot('site/img/plc-sheet.png');

  await mkdir('site-dist/img', { recursive: true });
  for (const f of ['schematic', 'dwg-import', 'icon-menu', 'reports', 'symbol-builder', 'plc-sheet']) {
    await copyFile(`site/img/${f}.png`, `site-dist/img/${f}.png`);
    const { size } = await stat(`site/img/${f}.png`);
    check(size < 400 * 1024, `site/img/${f}.png is ${(size / 1024).toFixed(0)} KB (< 400 KB)`);
  }
}

await app.close();

// ---------------------------------------------------------------- landing page (after the pictures exist in site-dist/img)
await landingPage({ width: 1440, height: 900 }, 'site-desktop', { online: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130' });
await landingPage({ width: 390, height: 844 }, 'site-phone', { online: true, phone: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605' });
await landingPage({ width: 1440, height: 900 }, 'site-desktop-offline', { online: false });

await browser.close();
server.close();
if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('screenshots written to ./screenshots (site-desktop, site-phone, site-desktop-offline, site-app-dwg)');
