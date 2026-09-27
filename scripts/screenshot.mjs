// Launch the built renderer in headless Chromium and capture screenshots for visual review.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
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

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('PAGE ERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text()); });
await page.goto(`http://localhost:${port}/?demo`);
await page.waitForTimeout(400);
await page.mouse.move(760, 430);
await page.waitForTimeout(150);
await page.screenshot({ path: 'screenshots/01-schematic.png' });

// Selection + grips
await page.evaluate(() => {
  const ed = window.editor;
  const ins = ed.doc.entities.find((e) => e.type === 'insert' && e.attributes.TAG1 === 'PB101');
  const line = ed.doc.entities.find((e) => e.type === 'line' && e.layer === 'WIRES');
  ed.selection = new Set([ins.id, line.id]);
  ed.render();
});
await page.waitForTimeout(150);
await page.screenshot({ path: 'screenshots/02-selection.png' });

// Line tool with rubber band + snap marker
await page.evaluate(() => {
  const ed = window.editor;
  ed.selection = new Set();
  ed.runCommand('LINE');
  ed.submitInput('2,1');
});
await page.mouse.move(900, 500);
await page.waitForTimeout(150);
await page.screenshot({ path: 'screenshots/03-line-tool.png' });
await page.keyboard.press('Escape');

// Icon menu dialog
await page.evaluate(() => window.editor.runCommand('AECOMPONENT'));
await page.waitForTimeout(250);
await page.screenshot({ path: 'screenshots/04-icon-menu.png' });
await page.keyboard.press('Escape');
await page.evaluate(() => document.querySelector('.modal-backdrop')?.remove());

// Layer dialog
await page.evaluate(() => window.editor.runCommand('LAYER'));
await page.waitForTimeout(200);
await page.screenshot({ path: 'screenshots/05-layers.png' });
await page.keyboard.press('Escape');
await page.evaluate(() => document.querySelector('.modal-backdrop')?.remove());

// Properties palette with a component selected
await page.evaluate(() => {
  const ed = window.editor;
  const ins = ed.doc.entities.find((e) => e.type === 'insert' && e.attributes.TAG1 === 'M102');
  ed.selection = new Set([ins.id]);
  ed.emit?.('selection');
  ed.runCommand('PROPERTIES');
  ed.render();
});
await page.waitForTimeout(200);
await page.screenshot({ path: 'screenshots/06-properties.png' });
await page.evaluate(() => window.editor.runCommand('PROPERTIES'));

// Cross references + reports
await page.evaluate(() => {
  window.editor.selection = new Set();
  window.editor.runCommand('AEXREF');
  window.editor.runCommand('AEREPORT bom');
});
await page.waitForTimeout(250);
await page.screenshot({ path: 'screenshots/07-reports.png' });
await page.keyboard.press('Escape');
await page.evaluate(() => document.querySelector('.modal-backdrop')?.remove());

// New sheet from template (B size) with a PLC module and the Home tab
await page.evaluate(() => {
  window.editor.doc.dirty = false; // skip the unsaved-changes prompt
  window.editor.runCommand('NEWSHEET');
});
await page.waitForTimeout(250);
await page.screenshot({ path: 'screenshots/08-template-dialog.png' });
await page.click('.modal .btn.primary >> nth=-1');
await page.waitForTimeout(250);
await page.evaluate(() => {
  const ed = window.editor;
  ed.runCommand('AEPLC');
});
await page.waitForTimeout(200);
await page.click('.modal .btn.primary >> nth=-1');
await page.waitForTimeout(100);
await page.evaluate(() => window.editor.submitInput('3,9'));
await page.evaluate(() => window.editor.zoomExtents());
await page.waitForTimeout(200);
await page.screenshot({ path: 'screenshots/09-sheet-plc.png' });

await browser.close();
server.close();
console.log('screenshots written to ./screenshots');
