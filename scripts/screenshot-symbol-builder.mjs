// Capture the Symbol Builder: start dialog, an editing session started from the library symbol
// HPB11_NO (with the docked palette), and the icon menu showing the saved user symbol.
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
await mkdir('screenshots', { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
await page.goto(`http://localhost:${port}/?demo&norecover`);
await page.waitForTimeout(400);
await page.evaluate(() => window.jacUi.ribbon.setActive(3)); // Schematic tab (Symbol Builder button)

// 1. Start dialog, "Copy of a library symbol" with HPB11_NO found through the search box.
await page.evaluate(() => window.editor.runCommand('AESYMBUILDER'));
await page.waitForTimeout(250);
const dialog = page.locator('.modal').first();
await dialog.locator('input[name=sb-source][value=library]').check();
const search = dialog.locator('.sb-option-body.active input.input').first();
await search.fill('HPB11_NO');
await page.waitForTimeout(150);
await dialog.locator('.sb-list-item', { hasText: 'HPB11_NO' }).first().click();
await page.waitForTimeout(150);
const nameInput = dialog.locator('fieldset.sb-col input.input').first();
await nameInput.fill('USER_PB_START');
await nameInput.dispatchEvent('input');
const descInput = dialog.locator('fieldset.sb-col input.input').nth(1);
await descInput.fill('Illuminated start button');
await dialog.screenshot({ path: 'screenshots/symbol-builder-00-dialog.png' });
console.log('dialog name:', await nameInput.inputValue(), 'family:', await dialog.locator('fieldset.sb-col input.input').nth(3).inputValue());
await dialog.locator('.modal-footer .btn.primary').click();
await page.waitForTimeout(400);

// 2. The editing session: guides, palette, symbol tab. Draw a lamp lead, add an explicit top pin (A1) and run Check.
const title = await page.evaluate(() => window.editor.fileName());
console.log('session title:', title, 'tabs:', await page.locator('.file-tab').count());
await page.evaluate(() => {
  const ed = window.editor;
  ed.runCommand('LINE');
  ed.submitInput('0.125,-0.03');
  ed.submitInput('0.125,-0.3');
  ed.pressEnter();
});
await page.waitForTimeout(100);
const palette = page.locator('#symbol-builder');
await palette.locator('.sb-addrow select').last().selectOption('8');
await palette.locator('.sb-addrow input.sb-pin').fill('A1');
await palette.locator('.sb-addrow .sb-btn', { hasText: 'Add pin' }).click();
await page.waitForTimeout(100);
await page.evaluate(() => window.editor.submitInput('0.125,-0.3'));
await page.waitForTimeout(150);
await page.locator('#symbol-builder .sb-actions .btn', { hasText: 'Check' }).click();
await page.waitForTimeout(150);
await page.mouse.move(700, 480);
await page.waitForTimeout(150);
await page.screenshot({ path: 'screenshots/symbol-builder-01.png' });

// 3. Save to the library, then the icon menu shows the User: category.
await page.locator('#symbol-builder .sb-actions .btn', { hasText: 'Save to Library' }).click();
await page.waitForTimeout(200);
console.log('user library:', await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('jcad.userlib.v1') || '{"symbols":[]}').symbols.map((s) => s.block.name))));
await page.evaluate(() => window.editor.switchSession(0));
await page.waitForTimeout(200);
await page.evaluate(() => window.editor.runCommand('AECOMPONENT'));
await page.waitForTimeout(300);
const cats = page.locator('.iconmenu-cat');
const n = await cats.count();
await cats.nth(n - 1).click();
await page.waitForTimeout(200);
await page.locator('.modal').first().screenshot({ path: 'screenshots/symbol-builder-02-icon-menu.png' });
console.log('last category:', await cats.nth(n - 1).textContent());
await page.keyboard.press('Escape');
await page.waitForTimeout(100);
const log = await page.evaluate(() => window.editor.history.slice(-8));
console.log(log.join('\n'));
await browser.close();
server.close();
