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
