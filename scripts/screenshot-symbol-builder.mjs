// Capture the Symbol Builder: start dialog, an editing session started from the library symbol
// HPB11_NO (with the docked palette), the vertical variant, the icon menu showing the saved user
// symbol, and the same session at 1366x768 (laptop) with the Properties palette docked as well.
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

/**
 * Click a palette action button. After the palette rebuilt its DOM on a tab switch, headless
 * Chromium + Playwright 1.63 report the new button as "not visible" for its actionability check even
 * though it is visible and stable in the page (verified with an in-page checkVisibility() poll), so
 * the click is forced; the callers check its effect (library contents, tab count).
 */
async function clickButton(page, label) {
  const loc = page.locator('#symbol-builder .sb-actions .btn', { hasText: label });
  await loc.waitFor({ state: 'attached' });
  await loc.click({ force: true });
}

async function run(viewport, suffix) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
  await page.goto(`http://localhost:${port}/?demo&norecover`);
  await page.waitForTimeout(400);
  await page.evaluate(() => window.jacUi.ribbon.setActive(2)); // Project tab: the builder must switch to Schematic itself
  await page.evaluate(() => localStorage.removeItem('jcad.userlib.v1'));

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
  await nameInput.fill('user pb start');
  await nameInput.dispatchEvent('input');
  const descInput = dialog.locator('fieldset.sb-col input.input').nth(1);
  await descInput.fill('Illuminated start button');
  if (!suffix) await dialog.screenshot({ path: 'screenshots/symbol-builder-00-dialog.png' });
  console.log(`[${viewport.width}] dialog name:`, await nameInput.inputValue(), 'family:', await dialog.locator('fieldset.sb-col input.input').nth(3).inputValue());
  // Enter in a text field submits the dialog.
  await descInput.press('Enter');
  await page.waitForTimeout(400);
  console.log(`[${viewport.width}] dialog closed by Enter:`, (await page.locator('.modal').count()) === 0);

  // 2. The editing session: guides, palette, symbol tab, ribbon on Schematic. Draw a lamp lead, add an explicit
  //    bottom pin (A1) and run Check; then MIRROR the symbol to show the pins stay right.
  const title = await page.evaluate(() => window.editor.fileName());
  const ribbonTab = await page.locator('.ribbon-tab.active').first().textContent();
  console.log(`[${viewport.width}] session title:`, title, 'tabs:', await page.locator('.file-tab').count(), 'ribbon tab:', ribbonTab);
  await page.evaluate(() => {
    const ed = window.editor;
    ed.runCommand('LINE');
    ed.submitInput('0.125,-0.03');
    ed.submitInput('0.125,-0.3125');
    ed.pressEnter();
  });
  await page.waitForTimeout(100);
  const palette = page.locator('#symbol-builder');
  await palette.locator('.sb-addrow select').last().selectOption('8');
  await palette.locator('.sb-addrow input.sb-pin').fill('A1');
  await palette.locator('.sb-addrow .sb-btn', { hasText: 'Add pin' }).click();
  await page.waitForTimeout(100);
  await page.evaluate(() => window.editor.submitInput('0.125,-0.3125'));
  await page.waitForTimeout(150);
  // MIRROR copies in JCad: mirror everything about the y axis, then erase the originals (the flipped variant).
  await page.evaluate(() => {
    const ed = window.editor;
    const before = ed.doc.entities.map((e) => e.id);
    ed.runCommand('SELECTALL');
    ed.runCommand('MIRROR');
    ed.submitInput('0,0');
    ed.submitInput('0,1');
    ed.doc.removeEntities(before);
  });
  await page.waitForTimeout(200);
  const pinsAfterMirror = await page.evaluate(() => window.editor.doc.entities.filter((e) => e.layer === 'SYMPIN').map((e) => `${e.text}@${e.position.x.toFixed(3)},${e.position.y.toFixed(3)}`).sort());
  console.log(`[${viewport.width}] markers after MIRROR:`, pinsAfterMirror.join(' '));
  await clickButton(page, 'Check');
  await page.waitForTimeout(150);
  await page.mouse.move(700, 480);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `screenshots/symbol-builder-01${suffix}.png` });
  const paletteRect = await palette.boundingBox();
  const pinsHeader = await palette.locator('.sb-section', { hasText: 'Wire connections' }).boundingBox();
  const checkLine = await palette.locator('.sb-check-line').boundingBox();
  console.log(`[${viewport.width}] palette bottom ${Math.round(paletteRect.y + paletteRect.height)}, pins header y ${Math.round(pinsHeader?.y ?? -1)}, check line y ${Math.round(checkLine?.y ?? -1)}, check text: ${await palette.locator('.sb-check-line').textContent()}`);

  if (suffix) {
    // Laptop size with the Properties palette docked as well: legend must stay clear of the ViewCube.
    await page.evaluate(() => window.editor.runCommand('PROPERTIES'));
    await page.waitForTimeout(200);
    await page.screenshot({ path: `screenshots/symbol-builder-04-both-palettes${suffix}.png` });
    await page.evaluate(() => window.editor.runCommand('PROPERTIES'));
    await page.waitForTimeout(100);
  }

  // 3. Vertical variant in a new tab.
  await palette.locator('.sb-btn', { hasText: 'Make vertical' }).click();
  await page.waitForTimeout(500);
  await page.mouse.move(700, 480);
  await page.waitForTimeout(150);
  console.log(`[${viewport.width}] vertical tab:`, await page.evaluate(() => window.editor.fileName()), 'pins:', await page.locator('#symbol-builder .sb-section', { hasText: 'Wire connections' }).locator('.sb-section-badge').textContent());
  await page.screenshot({ path: `screenshots/symbol-builder-03-vertical${suffix}.png` });
  await clickButton(page, 'Save to Library');
  await page.waitForTimeout(300);
  console.log(`[${viewport.width}] vertical saved:`, await page.evaluate(() => JSON.parse(localStorage.getItem('jcad.userlib.v1') || '{"symbols":[]}').symbols.map((s) => s.block.name).join(',')));
  await clickButton(page, 'Close');
  await page.waitForTimeout(300);
  console.log(`[${viewport.width}] after close: tabs`, await page.locator('.file-tab').count(), 'title', await page.evaluate(() => window.editor.fileName()));
  await page.waitForTimeout(300);

  // 4. Back in the horizontal symbol's tab (closing the variant returns to the drawing it was started from):
  //    save it to the library, then the icon menu shows the User: category.
  await page.evaluate(() => { const ed = window.editor; const i = ed.sessions.all.findIndex((s) => s.untitledName === 'Symbol: USER_PB_START'); ed.switchSession(i); });
  await page.waitForTimeout(300);
  await clickButton(page, 'Save to Library');
  await page.waitForTimeout(200);
  console.log(`[${viewport.width}] user library:`, await page.evaluate(() => JSON.stringify(JSON.parse(localStorage.getItem('jcad.userlib.v1') || '{"symbols":[]}').symbols.map((s) => s.block.name))));
  await page.evaluate(() => window.editor.switchSession(0));
  await page.waitForTimeout(200);
  if (!suffix) {
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
  }
  const log = await page.evaluate(() => window.editor.history.slice(-10));
  console.log(log.join('\n'));
  await page.close();
}

await run({ width: 1500, height: 940 }, '');
await run({ width: 1366, height: 768 }, '-1366x768');
await browser.close();
server.close();
