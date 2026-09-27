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
const shot = (name) => page.screenshot({ path: `screenshots/${name}.png` });
const closeDialogs = async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelectorAll('.modal-backdrop, .context-menu, .appmenu, .layer-dropdown').forEach((m) => m.remove()));
};
await page.goto(`http://localhost:${port}/?demo`);
await page.waitForTimeout(400);
await page.mouse.move(760, 430);
await page.waitForTimeout(150);
await shot('01-schematic');

// Selection + grips
await page.evaluate(() => {
  const ed = window.editor;
  const ins = ed.doc.entities.find((e) => e.type === 'insert' && e.attributes.TAG1 === 'PB101');
  const line = ed.doc.entities.find((e) => e.type === 'line' && e.layer === 'WIRES');
  ed.selection = new Set([ins.id, line.id]);
  ed.render();
});
await page.waitForTimeout(150);
await shot('02-selection');

// Line tool with rubber band + snap marker
await page.evaluate(() => {
  const ed = window.editor;
  ed.selection = new Set();
  ed.runCommand('LINE');
  ed.submitInput('2,1');
});
await page.mouse.move(900, 500);
await page.waitForTimeout(150);
await shot('03-line-tool');
await page.keyboard.press('Escape');

// Icon menu dialog
await page.evaluate(() => window.editor.runCommand('AECOMPONENT'));
await page.waitForTimeout(250);
await shot('04-icon-menu');
await closeDialogs();

// Layer dialog
await page.evaluate(() => window.editor.runCommand('LAYER'));
await page.waitForTimeout(200);
await shot('05-layers');
await closeDialogs();

// Properties palette with a component selected
await page.evaluate(() => {
  const ed = window.editor;
  const ins = ed.doc.entities.find((e) => e.type === 'insert' && e.attributes.TAG1 === 'M102');
  ed.selection = new Set([ins.id]);
  ed.notify('selection');
  ed.runCommand('PROPERTIES');
  ed.render();
});
await page.waitForTimeout(200);
await shot('06-properties');
await page.evaluate(() => window.editor.runCommand('PROPERTIES'));

// Cross references + reports
await page.evaluate(() => {
  window.editor.selection = new Set();
  window.editor.runCommand('AEXREF');
  window.editor.runCommand('AEREPORT bom');
});
await page.waitForTimeout(250);
await shot('07-reports');
await closeDialogs();

// New sheet from template (B size) with a PLC module and the Home tab
await page.evaluate(() => {
  window.editor.doc.dirty = false; // skip the unsaved-changes prompt
  window.editor.runCommand('NEWSHEET');
});
await page.waitForTimeout(250);
await shot('08-template-dialog');
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
await shot('09-sheet-plc');

// ---------------------------------------------------------------- UI parity
// 10. Command-line AutoComplete (two file tabs are open now: Drawing1 + the sheet)
await page.evaluate(() => window.editor.switchSession(0));
await page.click('.command-input');
await page.keyboard.type('li');
await page.waitForTimeout(150);
await page.keyboard.press('Tab');
await page.waitForTimeout(100);
await shot('10-autocomplete');
await page.keyboard.press('Escape');
await page.evaluate(() => (document.querySelector('.command-input').value = ''));

// 11. Options dialog (Display tab)
await page.evaluate(() => window.editor.runCommand('OPTIONS'));
await page.waitForTimeout(200);
await shot('11-options');
await page.click('.dlg-tab >> nth=2');
await page.waitForTimeout(100);
await shot('11b-options-selection');
await closeDialogs();

// 12. Drafting Settings (Object Snap tab)
await page.evaluate(() => window.editor.runCommand('DSETTINGS 2'));
await page.waitForTimeout(200);
await shot('12-drafting-settings');
await closeDialogs();

// 13. Home tab with layer dropdown open
await page.evaluate(() => window.jacUi.ribbon.setActive(0));
await page.waitForTimeout(100);
await page.click('.layer-combo');
await page.waitForTimeout(150);
await shot('13-layer-dropdown');
await closeDialogs();
await page.click('.color-combo');
await page.waitForTimeout(150);
await shot('13b-color-dropdown');
await closeDialogs();

// 14. Multiple file tabs (add a third drawing, hover a tab for the preview)
await page.evaluate(() => {
  window.editor.runCommand('NEW');
  window.editor.runCommand('CIRCLE');
  window.editor.submitInput('0,0');
  window.editor.submitInput('2');
});
await page.waitForTimeout(150);
await page.hover('.file-tab >> nth=0');
await page.waitForTimeout(650);
await shot('14-file-tabs');
await page.mouse.move(760, 500);
await page.evaluate(() => window.editor.switchSession(0));

// 15. Tool palettes + quick properties
await page.evaluate(() => {
  window.jacUi.tp.toggle(true);
  const ed = window.editor;
  ed.settings = { ...ed.settings, quickProperties: true };
  const ins = ed.doc.entities.find((e) => e.type === 'insert' && e.attributes.TAG1 === 'PB100');
  ed.selection = new Set([ins.id]);
  ed.notify('selection');
  ed.render();
});
await page.waitForTimeout(250);
await shot('15-tool-palettes-quick-properties');
await page.evaluate(() => {
  window.jacUi.tp.toggle(false);
  const ed = window.editor;
  ed.settings = { ...ed.settings, quickProperties: false };
  ed.selection = new Set();
  ed.notify('selection');
});

// 16. Application menu
await page.click('.app-logo');
await page.waitForTimeout(200);
await shot('16-application-menu');
await closeDialogs();

// 17. Help window
await page.evaluate(() => window.editor.runCommand('HELP lay'));
await page.waitForTimeout(200);
await shot('17-help');
await closeDialogs();

// 18. Context menu with Recent Input flyout (type a few commands first so the flyout has entries)
for (const c of ['zoom e', 'regen', 'la']) {
  await page.click('.command-input');
  await page.keyboard.type(c);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  await closeDialogs();
}
await page.mouse.click(900, 600, { button: 'right' });
await page.waitForTimeout(150);
await page.hover('.context-item.has-sub >> nth=0');
await page.waitForTimeout(150);
await shot('18-context-menu');
await closeDialogs();

// 19. Status bar object snap menu
await page.click('.statusbar .status-btn.arrow >> nth=3');
await page.waitForTimeout(150);
await shot('19-status-osnap-menu');
await closeDialogs();

// 20. Rollover tooltip
await page.evaluate(() => window.editor.zoomExtents());
await page.waitForTimeout(100);
const hoverPos = await page.evaluate(() => {
  const ed = window.editor;
  const ins = ed.doc.entities.find((e) => e.type === 'insert' && e.attributes.TAG1 === 'M102');
  const s = ed.viewport.toScreen(ins.position);
  const r = ed.viewport.canvas.getBoundingClientRect();
  return { x: r.left + s.x, y: r.top + s.y };
});
await page.mouse.move(hoverPos.x, hoverPos.y);
await page.waitForTimeout(700);
await shot('20-rollover-tooltip');

await browser.close();
server.close();
console.log('screenshots written to ./screenshots');
