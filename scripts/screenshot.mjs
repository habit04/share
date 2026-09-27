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

// ---------------------------------------------------------------- electrical feature parity scenes
const closeModal = async () => {
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelectorAll('.modal-backdrop').forEach((m) => m.remove()));
};
const reloadDemo = async () => {
  await page.goto(`http://localhost:${port}/?demo`);
  await page.waitForTimeout(400);
};

// 10: Insert/Edit Component dialog with ACADE data, used tags and pins
await reloadDemo();
await page.evaluate(() => window.editor.runCommand('AECOMPONENT HPB11_NO'));
await page.waitForTimeout(100);
await page.evaluate(() => window.editor.submitInput('7.2,5'));
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/10-component-dialog.png' });
await closeModal();

// 11: Catalog browser
await page.evaluate(() => {
  const ed = window.editor;
  const ins = ed.doc.entities.find((e) => e.type === 'insert' && e.attributes.TAG1 === 'LS103');
  ed.selection = new Set([ins.id]);
  ed.runCommand('AECATALOG');
});
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/11-catalog-browser.png' });
await closeModal();

// 12: Child contact flow (parent list) + toggled NC contact, scoot and wire gap applied to the drawing
await page.evaluate(() => window.editor.runCommand('AECHILD'));
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/12-child-contact.png' });
await closeModal();
await page.evaluate(() => {
  const ed = window.editor;
  ed.runCommand('AEXREF');
  const c = ed.doc.entities.find((e) => e.type === 'insert' && e.block === 'HCR1_NO' && Math.abs(e.position.y - 6) < 0.01);
  ed.selection = new Set([c.id]);
  ed.runCommand('AETOGGLENC');
  ed.runCommand('AEXREF');
  ed.zoomExtents();
});
await page.waitForTimeout(200);
await page.screenshot({ path: 'screenshots/13-xref-tables.png' });

// 14: Electrical audit with jump-to-error
await page.evaluate(() => window.editor.runCommand('AEAUDIT'));
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/14-audit.png' });
await closeModal();

// 15: Reports: PLC I/O + wire labels + put on drawing
await page.evaluate(() => window.editor.runCommand('AEREPORT labels'));
await page.waitForTimeout(400);
await page.screenshot({ path: 'screenshots/15-report-wire-labels.png' });
await closeModal();

// 16: Panel: schematic list dialog, then footprints, balloon and nameplate placed on a panel area
await page.evaluate(() => window.editor.runCommand('AESCHEMATICLIST'));
await page.waitForTimeout(400);
await page.screenshot({ path: 'screenshots/16-schematic-list.png' });
await closeModal();
await page.evaluate(() => {
  const ed = window.editor;
  // Place footprints for a few tags via the command with a preselected component.
  const place = (tag, x, y) => {
    const ins = ed.doc.entities.find((e) => e.type === 'insert' && e.attributes.TAG1 === tag);
    ed.selection = new Set([ins.id]);
    ed.runCommand('AEFOOTPRINT');
    ed.submitInput(`${x},${y}`);
  };
  place('PB100', 13.5, 8);
  place('PB101', 15, 8);
  place('LT101', 16.5, 8);
  place('CR100', 13.6, 5.8);
  place('OL102', 15.8, 5.6);
  place('FU100', 17.8, 5.8);
  // footprints are picked on their outline (like any block), so aim at the rectangle edge
  ed.runCommand('AENAMEPLATE');
  ed.submitInput('14.55,8');
  ed.submitInput('15,9.6');
  ed.runCommand('AEBALLOON');
  ed.submitInput('13.0,5.8');
  ed.submitInput('12.4,7');
  ed.zoomExtents();
});
await page.waitForTimeout(250);
await page.screenshot({ path: 'screenshots/17-panel-footprints.png' });

// 18: Terminal strip editor
await page.evaluate(() => window.editor.runCommand('AETERMEDIT'));
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/18-terminal-strip-editor.png' });
await closeModal();

// 19: Drawing properties (WD_M settings)
await page.evaluate(() => window.editor.runCommand('AEDRAWINGPROPS'));
await page.waitForTimeout(300);
await page.screenshot({ path: 'screenshots/19-drawing-properties.png' });
await closeModal();

// 20: Circuit builder: reversing starter on a new sheet, plus a 3-phase bus with a 3-pole disconnect
await page.evaluate(() => {
  window.editor.doc.dirty = false;
  window.editor.runCommand('NEWSHEET');
});
await page.waitForTimeout(200);
await page.click('.modal .btn.primary >> nth=-1');
await page.waitForTimeout(200);
await page.evaluate(() => window.editor.runCommand('AECIRCUIT'));
await page.waitForTimeout(250);
await page.evaluate(() => {
  const sel = document.querySelector('.modal select');
  sel.value = 'reversing';
  sel.dispatchEvent(new Event('change'));
});
await page.screenshot({ path: 'screenshots/20-circuit-builder.png' });
await page.click('.modal .btn.primary >> nth=-1');
await page.waitForTimeout(150);
await page.evaluate(() => window.editor.submitInput('2,9'));
await page.waitForTimeout(100);
await page.evaluate(() => {
  const ed = window.editor;
  ed.runCommand('AEMULTIBUS');
});
await page.waitForTimeout(200);
await page.evaluate(() => {
  const sel = document.querySelectorAll('.modal select')[0];
  sel.value = 'horizontal';
  sel.dispatchEvent(new Event('change'));
});
await page.click('.modal .btn.primary >> nth=-1');
await page.waitForTimeout(100);
await page.evaluate(() => {
  const ed = window.editor;
  ed.submitInput('2,4');
  ed.submitInput('12,4');
  ed.runCommand('AECOMPONENT3 HDS1');
});
await page.waitForTimeout(150);
await page.evaluate(() => window.editor.submitInput('4,4'));
await page.waitForTimeout(250);
await page.click('.modal .btn.primary >> nth=-1');
await page.waitForTimeout(100);
await page.evaluate(() => {
  const ed = window.editor;
  ed.runCommand('AETITLEBLOCK');
  ed.zoomExtents();
});
await page.waitForTimeout(250);
await page.screenshot({ path: 'screenshots/21-circuit-and-3phase.png' });

await browser.close();
server.close();
console.log('screenshots written to ./screenshots');
