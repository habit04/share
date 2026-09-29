// UI smoke test: serve the built renderer (dist/), load /?demo in headless Chromium and
//   (a) run every registered command through window.editor (tools are cancelled with Escape,
//       dialogs closed), and check that every command the native Electron menu sends exists;
//   (b) click every ribbon button (all tabs), application-menu entry and sub-entry, title-bar and
//       status-bar control, palette button, file / layout tab, navigation-bar button, and every
//       item of the context menus they open (plus the canvas and status-bar right-click menus);
//   (c) fail (exit code 1) on any page error, console error, "Unknown command" (or JS error text)
//       in the command history, or a click that throws.
//
//   npm run build && npm run ui-check     (node scripts/ui-click-check.mjs [--quick] [--verbose])
//   node scripts/ui-click-check.mjs --self-test   plants an unknown command, a throwing button and a
//                                                 console error, and passes only if all three are caught
//
// CHROMIUM_PATH overrides the browser executable; otherwise /opt/pw-browsers/chromium when it
// exists, else Playwright's own download (npx playwright install chromium).
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';

const selfTest = process.argv.includes('--self-test');
const quick = process.argv.includes('--quick') || selfTest;
const verbose = process.argv.includes('--verbose');
const root = join(process.cwd(), 'dist');
if (!existsSync(join(root, 'index.html'))) {
  console.error('dist/index.html not found: run `npm run build` first.');
  process.exit(2);
}

// ------------------------------------------------------------------ static server
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let p = join(root, decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname));
  try {
    if ((await stat(p)).isDirectory()) p = join(p, 'index.html');
    res.setHeader('Content-Type', types[extname(p)] ?? 'application/octet-stream');
    res.end(await readFile(p));
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ------------------------------------------------------------------ failure bookkeeping
const failures = [];
let current = 'startup';
const counts = { commands: 0, menuCommands: 0, clicks: 0, forcedClicks: 0, menuItems: 0, contextMenus: 0 };
const t0 = Date.now();
let phaseStart = Date.now();
function phase(name) {
  console.log(`ui-check: ${name} (${((Date.now() - phaseStart) / 1000).toFixed(1)} s, ${((Date.now() - t0) / 1000).toFixed(0)} s total)`);
  phaseStart = Date.now();
}
function fail(kind, detail) {
  failures.push({ kind, where: current, detail });
  console.error(`${kind} [${current}] ${detail}`);
}

const executablePath = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({ viewport: { width: 1500, height: 940 }, deviceScaleFactor: 1, acceptDownloads: true });
// DONATE / links open popups: close them (they are not part of the app).
const page = await context.newPage();
context.on('page', (p) => {
  if (p !== page) void p.close().catch(() => {});
});
page.on('pageerror', (e) => fail('PAGE ERROR', e.stack || e.message));
page.on('console', (m) => {
  if (m.type() === 'error') fail('CONSOLE', m.text());
});
page.on('dialog', (d) => void d.dismiss().catch(() => {}));
page.on('download', (d) => void d.cancel().catch(() => {}));

await page.goto(`http://127.0.0.1:${port}/?demo`);
await page.waitForFunction(() => !!window.editor, null, { timeout: 15000 });
await page.waitForTimeout(300);

// Record every command-history line so each step can be checked for "Unknown command" etc.
await page.evaluate(() => {
  const ed = window.editor;
  window.__uiLog = [];
  const orig = ed.log.bind(ed);
  ed.log = (t) => {
    window.__uiLog.push(String(t));
    orig(t);
  };
});
const LOG_ERRORS = /Unknown command|TypeError|ReferenceError|RangeError|SyntaxError|is not a function|Cannot read propert|Cannot set propert|is not defined|undefined is not|Maximum call stack/;
async function checkLog() {
  const lines = await page.evaluate(() => window.__uiLog.splice(0));
  for (const l of lines) if (LOG_ERRORS.test(l)) fail('LOG', l);
  if (verbose && lines.length) console.log(`    log: ${lines.slice(0, 3).join(' | ')}`);
}

/** While true, settle() leaves the active tab alone (Symbol Builder sweep). */
let keepSession = false;

/** Close whatever a step opened and bring the editor back to a known idle state. */
async function settle() {
  await page.waitForTimeout(quick ? 20 : 50);
  for (let i = 0; i < 4; i += 1) {
    const open = await page.evaluate(() => document.querySelectorAll('.modal-backdrop, .context-menu, .appmenu').length + (window.editor.tool ? 1 : 0));
    if (!open) break;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(20);
  }
  await page.evaluate((keep) => {
    for (const b of document.querySelectorAll('.modal-backdrop .modal-close')) b.click();
    for (const m of document.querySelectorAll('.modal-backdrop, .context-menu, .appmenu')) m.remove();
    const ed = window.editor;
    if (ed.tool) ed.cancel();
    if (!keep && ed.sessions.active !== 0 && ed.sessions.count > 0) ed.switchSession(0);
    if (ed.selection.size) {
      ed.selection.clear();
      ed.notify('selection');
    }
    const app = document.getElementById('app');
    if (app.classList.contains('clean-screen')) ed.runCommand('CLEANSCREEN');
    if (document.getElementById('command-window').classList.contains('hidden')) ed.runCommand('COMMANDLINE');
    document.getElementById('ribbon').classList.remove('collapsed');
    if (ed.settings.workspace !== 'electrical') ed.runCommand('WORKSPACE electrical');
    // Status bar > Customization hides controls: show them all again.
    if (Object.values(ed.settings.statusBarItems ?? {}).some((v) => v === false)) {
      ed.settings = { ...ed.settings, statusBarItems: {} };
      ed.notify('snap');
    }
  }, keepSession);
  await checkLog();
}

// ------------------------------------------------------------------ (a) every registered command
const SKIP_COMMANDS = new Set(['QUIT', 'EXIT', 'CLOSE', 'CLOSEALL', 'CLOSEALLOTHER']);
const names = await page.evaluate(() => [...new Set([...window.editor.commands.values()].map((d) => d.name.toUpperCase()))].sort());
console.log(`ui-check: ${names.length} registered commands`);

async function runCommands(label, prepare) {
  for (const name of names) {
    if (SKIP_COMMANDS.has(name)) continue;
    current = `${label} ${name}`;
    try {
      if (prepare) await page.evaluate(prepare);
      const thrown = await page.evaluate((n) => {
        try {
          const r = window.editor.runCommand(n);
          void r;
          return null;
        } catch (e) {
          return String((e && e.stack) || e);
        }
      }, name);
      if (thrown) fail('THROW', thrown);
      counts.commands += 1;
    } catch (e) {
      fail('THROW', String(e));
    }
    await settle();
  }
}
await runCommands('command');
phase('commands done');
if (!quick) {
  // Same again with an object selected first: noun-verb paths (ERASE, MOVE, PROPERTIES ...).
  await runCommands('command+selection', () => {
    const ed = window.editor;
    const ins = ed.doc.entities.find((e) => e.type === 'insert') ?? ed.doc.entities[0];
    if (ins) {
      ed.selection = new Set([ins.id]);
      ed.notify('selection');
    }
  });
}
phase('commands with selection done');
// Enter-to-repeat and a few argument forms the menus use.
current = 'command args';
for (const c of ['ZOOM E', 'ZOOM W', 'ZOOM I', 'ZOOM O', 'HELP shortcuts', 'HELP about', 'AEREPORT bom', 'AEREPORT wires', 'AEREPORT terminals', 'AEREPORT strip', 'AEREPORT audit', 'OPTIONS 4', 'DSETTINGS 2', 'WORKSPACE drafting', 'WORKSPACE electrical', 'RECENT']) {
  current = `command args ${c}`;
  await page.evaluate((x) => window.editor.runCommand(x), c);
  counts.commands += 1;
  await settle();
}

// Every command string the native (Electron) menu sends must exist in the registry.
current = 'electron menu';
{
  const mainCjs = readFileSync(join(process.cwd(), 'electron/main.cjs'), 'utf8');
  const sent = [...mainCjs.matchAll(/click: send\('([^']+)'\)/g)].map((m) => m[1]);
  const known = new Set(await page.evaluate(() => [...window.editor.commands.keys()]));
  for (const s of sent) {
    counts.menuCommands += 1;
    const name = s.split(/\s+/)[0].toUpperCase();
    if (!known.has(name)) fail('MENU', `electron/main.cjs sends "${s}" but ${name} is not a registered command`);
  }
}

// Commands skipped above run last (they close tabs / may ask to discard changes).
for (const name of ['CLOSEALLOTHER', 'CLOSE', 'CLOSEALL']) {
  if (!names.includes(name)) continue;
  current = `command ${name}`;
  await page.evaluate((n) => {
    window.editor.sessions.add();
    window.editor.runCommand(n);
  }, name);
  counts.commands += 1;
  await settle();
}

// Fresh page for the click sweep, so the command sweep's side effects do not hide controls.
await page.goto(`http://127.0.0.1:${port}/?demo`);
await page.waitForFunction(() => !!window.editor, null, { timeout: 15000 });
await page.evaluate(() => {
  const ed = window.editor;
  window.__uiLog = [];
  const orig = ed.log.bind(ed);
  ed.log = (t) => {
    window.__uiLog.push(String(t));
    orig(t);
  };
});
await page.waitForTimeout(300);
if (selfTest) {
  current = 'self-test';
  await page.evaluate(() => {
    window.editor.runCommand('NOSUCHCOMMAND_UICHECK');
    const b = document.createElement('button');
    b.className = 'nav-btn';
    b.title = 'ui-check self-test';
    b.addEventListener('click', () => {
      throw new Error('ui-check self-test click handler');
    });
    document.getElementById('navbar').appendChild(b);
    console.error('ui-check self-test console error');
  });
  await settle();
}

// ------------------------------------------------------------------ (b) clicks
const CLICKABLE = 'button, [role=button], .clickable, .status-coords, .tp-tile, .tp-tab, .palette-strip-btns svg';
const SKIP_CLICK = /Exit JCad|^Quit\b|\bClose all\b/i;

/** Label of a control for the log. */
const labelOf = (loc) =>
  loc.evaluate((el) => (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || el.className.baseVal || el.className || el.tagName).toString().trim().replace(/\s+/g, ' ').slice(0, 60)).catch(() => '?');

/** Click through Playwright (real mouse events); fall back to a DOM click when the control is covered. */
async function clickControl(loc, how = 'left') {
  try {
    if (how === 'right') await loc.click({ button: 'right', timeout: 2000 });
    else await loc.click({ timeout: 2000 });
    counts.clicks += 1;
    return true;
  } catch (e) {
    try {
      await loc.evaluate(
        (el, right) => {
          if (right) el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
          else if (typeof el.click === 'function') el.click();
          else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        },
        how === 'right',
        { timeout: 2000 },
      );
      counts.clicks += 1;
      counts.forcedClicks += 1;
      if (verbose) console.log(`    forced click (${String(e.message).split('\n')[0]})`);
      return true;
    } catch (e2) {
      fail('CLICK', `${String(e2.message || e2).split('\n')[0]}`);
      return false;
    }
  }
}

/** Click every item (and sub-item) of the context menu `open()` shows. */
async function exploreMenu(open, label) {
  await settle();
  await open();
  await page.waitForTimeout(30);
  const root = page.locator('.context-menu.context-root');
  if ((await root.count()) === 0) return false;
  counts.contextMenus += 1;
  const n = await root.locator(':scope > .context-item').count();
  for (let i = 0; i < n; i += 1) {
    await settle();
    await open();
    await page.waitForTimeout(20);
    const item = page.locator('.context-menu.context-root > .context-item').nth(i);
    if ((await item.count()) === 0) break;
    const [disabled, hasSub, text] = await item.evaluate((el) => [el.disabled || el.classList.contains('disabled'), el.classList.contains('has-sub'), el.textContent.trim()]);
    if (disabled || SKIP_CLICK.test(text)) continue;
    current = `${label} > ${text}`;
    if (!hasSub) {
      await clickControl(item);
      counts.menuItems += 1;
      continue;
    }
    await item.hover();
    await page.waitForTimeout(30);
    const m = await page.locator('.context-menu.context-sub > .context-item').count();
    for (let j = 0; j < m; j += 1) {
      await settle();
      await open();
      await page.waitForTimeout(20);
      const parent = page.locator('.context-menu.context-root > .context-item').nth(i);
      await parent.hover();
      await page.waitForTimeout(30);
      const sub = page.locator('.context-menu.context-sub > .context-item').nth(j);
      if ((await sub.count()) === 0) break;
      const [sd, sh, st] = await sub.evaluate((el) => [el.disabled || el.classList.contains('disabled'), el.classList.contains('has-sub'), el.textContent.trim()]);
      if (sd || sh || SKIP_CLICK.test(st)) continue;
      current = `${label} > ${text} > ${st}`;
      await clickControl(sub);
      counts.menuItems += 1;
    }
  }
  await settle();
  return true;
}

/**
 * Click every visible control inside `scope` (re-queried before each click, since many controls
 * rebuild their DOM). A control that opens a context menu gets its items clicked too.
 */
async function sweep(scope, label, before) {
  const all = () => page.locator(scope).locator(CLICKABLE).locator('visible=true');
  if (before) await before();
  const total = await all().count();
  for (let i = 0; i < total; i += 1) {
    await settle();
    if (before) await before();
    const loc = all().nth(i);
    if ((await loc.count()) === 0) break;
    const [text, skip, sig] = await loc.evaluate((el) => {
      const t = (el.getAttribute('title') || el.textContent || '').trim();
      const cls = typeof el.className === 'string' ? el.className : el.className.baseVal;
      return [t.replace(/\s+/g, ' ').slice(0, 60), el.classList.contains('file-tab-close') || el.classList.contains('palette-resizer') || el.classList.contains('app-logo'), `${el.tagName}|${t || cls}`];
    });
    if (skip || SKIP_CLICK.test(text)) continue;
    current = `${label} #${i} ${text || (await labelOf(loc))}`;
    if (verbose) console.log(`  ${current}`);
    const ok = await clickControl(loc);
    if (!ok) continue;
    await page.waitForTimeout(30);
    if (await page.locator('.context-menu.context-root').count()) {
      // Re-find the opener by its signature: items of its menu may hide or add controls.
      const again = async () => {
        if (before) await before();
        const k = await all().evaluateAll((els, want) => els.findIndex((el) => `${el.tagName}|${(el.getAttribute('title') || el.textContent || '').trim() || (typeof el.className === 'string' ? el.className : el.className.baseVal)}` === want), sig);
        if (k >= 0) await clickControl(all().nth(k));
      };
      await exploreMenu(again, current);
    }
  }
  await settle();
  return total;
}

// Ribbon: every tab, every button and panel launcher on it.
const tabNames = await page.locator('#ribbon .ribbon-tab:not(.ribbon-min)').allTextContents();
console.log(`ui-check: ribbon tabs: ${tabNames.join(', ')}`);
for (const tab of tabNames) {
  const showTab = async () => {
    const t = page.locator('#ribbon .ribbon-tab:not(.ribbon-min)', { hasText: tab }).first();
    if (!(await t.evaluate((el) => el.classList.contains('active')))) await t.click();
  };
  current = `ribbon tab ${tab}`;
  await showTab();
  await sweep('#ribbon .ribbon-body', `ribbon ${tab}`, showTab);
}
phase('ribbon done');
current = 'ribbon minimize';
await clickControl(page.locator('#ribbon .ribbon-min'));
await clickControl(page.locator('#ribbon .ribbon-min'));

// Application menu: every entry, every sub-entry, Options.
{
  const openMenu = async () => {
    if ((await page.locator('.appmenu').count()) === 0) await page.locator('#titlebar .app-logo').click();
    await page.waitForTimeout(30);
  };
  current = 'app menu';
  await openMenu();
  const entries = await page.locator('.appmenu .appmenu-left .appmenu-item').allTextContents();
  for (let i = 0; i < entries.length; i += 1) {
    await settle();
    await openMenu();
    const item = page.locator('.appmenu .appmenu-left .appmenu-item').nth(i);
    await item.hover();
    await page.waitForTimeout(30);
    const subs = await page.locator('.appmenu .appmenu-right .appmenu-recent').allTextContents();
    for (let j = 0; j < subs.length; j += 1) {
      await settle();
      await openMenu();
      await page.locator('.appmenu .appmenu-left .appmenu-item').nth(i).hover();
      await page.waitForTimeout(20);
      current = `app menu > ${entries[i].trim()} > ${subs[j].trim()}`;
      await clickControl(page.locator('.appmenu .appmenu-right .appmenu-recent').nth(j));
      counts.menuItems += 1;
    }
    await settle();
    await openMenu();
    current = `app menu > ${entries[i].trim()}`;
    await clickControl(page.locator('.appmenu .appmenu-left .appmenu-item').nth(i));
    counts.menuItems += 1;
  }
  await settle();
  await openMenu();
  current = 'app menu > Options';
  await clickControl(page.locator('.appmenu .appmenu-footer .btn', { hasText: 'Options' }));
  counts.menuItems += 1;
  await settle();
}

phase('app menu done');
// Title bar (quick access toolbar, search, InfoCenter), file / layout tabs, navigation bar, command window.
await sweep('#titlebar', 'title bar');
await sweep('#file-tabs', 'file tabs');
await sweep('#layout-tabs', 'layout tabs');
await sweep('#navbar', 'nav bar');
await sweep('#command-window', 'command window');
// Status bar: every toggle / text control (menus explored), then the right-click menus.
await sweep('#statusbar', 'status bar');
{
  const rightTargets = page.locator('#statusbar .status-coords, #statusbar .status-group > .status-btn:first-child');
  const n = await rightTargets.count();
  for (let i = 0; i < n; i += 1) {
    const lbl = await labelOf(rightTargets.nth(i));
    current = `status bar right-click ${lbl}`;
    await exploreMenu(() => clickControl(page.locator('#statusbar .status-coords, #statusbar .status-group > .status-btn:first-child').nth(i), 'right'), current);
  }
}
phase('chrome + status bar done');
// Palettes: make each visible, then click everything in it.
const showPalettes = async () => {
  await page.evaluate(() => {
    const pm = document.querySelector('#project-manager');
    if (pm && pm.classList.contains('hidden')) window.editor.runCommand('TOGGLEPM');
    const pr = document.querySelector('#properties');
    if (pr && pr.classList.contains('hidden')) window.editor.runCommand('PROPERTIES');
    const tp = document.querySelector('.tool-palettes');
    if (tp && tp.classList.contains('hidden')) window.editor.runCommand('TOOLPALETTES');
  });
};
await sweep('#project-manager', 'project manager', showPalettes);
await sweep('#properties', 'properties', showPalettes);
await sweep('.tool-palettes', 'tool palettes', showPalettes);
// Properties with an object selected (the palette shows editable rows then).
await sweep('#properties', 'properties+selection', async () => {
  await showPalettes();
  await page.evaluate(() => {
    const ed = window.editor;
    const ins = ed.doc.entities.find((e) => e.type === 'insert') ?? ed.doc.entities[0];
    if (ins && !ed.selection.has(ins.id)) {
      ed.selection = new Set([ins.id]);
      ed.notify('selection');
    }
  });
});
// Symbol Builder palette: open a builder session (start dialog accepted with its defaults) and
// click everything in the docked palette while that tab stays active.
{
  current = 'symbol builder';
  const openBuilder = async () => {
    const visible = await page.evaluate(() => {
      const el = document.getElementById('symbol-builder');
      return !!el && !el.classList.contains('hidden') && el.querySelector('.sb-actions') !== null;
    });
    if (visible) return true;
    // An earlier click may have switched tabs: go back to the builder tab if one is open.
    const back = await page.evaluate(() => {
      const ed = window.editor;
      const i = ed.sessions.all.findIndex((s) => s.id === window.__sbSession);
      if (i >= 0 && i !== ed.sessions.active) ed.switchSession(i);
      return i >= 0;
    });
    if (back) {
      await page.waitForTimeout(80);
      if (await page.evaluate(() => !document.getElementById('symbol-builder').classList.contains('hidden'))) return true;
    }
    await page.evaluate(() => window.editor.runCommand('AESYMBUILDER'));
    await page.waitForTimeout(200);
    const primary = page.locator('.modal .btn.primary').last();
    if (await primary.count()) await primary.click().catch(() => {});
    await page.waitForTimeout(250);
    return page.evaluate(() => {
      const ed = window.editor;
      window.__sbSession = ed.sessions.all[ed.sessions.active].id;
      return !document.getElementById('symbol-builder').classList.contains('hidden');
    });
  };
  keepSession = true;
  if (await openBuilder()) {
    await sweep('#symbol-builder', 'symbol builder', async () => {
      await openBuilder();
    });
  } else fail('BUILDER', 'AESYMBUILDER did not show the Symbol Builder palette after accepting the start dialog');
  keepSession = false;
  await settle();
}
phase('palettes + symbol builder done');
// Canvas right-click menu: idle, with a selection, and while a tool runs.
{
  const canvas = page.locator('#drawing');
  const box = await canvas.boundingBox();
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const rightClick = async () => {
    await page.mouse.click(at.x, at.y, { button: 'right' });
  };
  await exploreMenu(rightClick, 'canvas menu (idle)');
  await exploreMenu(async () => {
    await page.evaluate(() => {
      const ed = window.editor;
      // Earlier items (Erase, Cut) remove the selection: keep something to select.
      if (ed.doc.entities.length === 0) ed.doc.addEntities([{ id: `uic${Date.now()}`, layer: '0', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 5, y: 5 } }]);
      const ins = ed.doc.entities.find((e) => e.type === 'insert') ?? ed.doc.entities[0];
      ed.selection = new Set([ins.id]);
      ed.notify('selection');
    });
    await rightClick();
  }, 'canvas menu (selection)');
  await exploreMenu(async () => {
    await page.evaluate(() => {
      const ed = window.editor;
      if (!ed.tool) {
        ed.runCommand('LINE');
        ed.submitInput('1,1');
      }
    });
    await rightClick();
  }, 'canvas menu (LINE running)');
}

await page.waitForTimeout(200);
await checkLog();
await browser.close();
server.close();

// ------------------------------------------------------------------ summary
const skippedNames = [...SKIP_COMMANDS].filter((n) => names.includes(n) && !['CLOSEALLOTHER', 'CLOSE', 'CLOSEALL'].includes(n));
console.log(
  `ui-check: ${counts.commands} command runs (${names.length} commands${skippedNames.length ? `, skipped: ${skippedNames.join(', ')}` : ''}; CLOSE / CLOSEALL / CLOSEALLOTHER run last), ` +
    `${counts.menuCommands} Electron menu commands resolved, ${counts.clicks} clicks (${counts.forcedClicks} forced), ${counts.contextMenus} menus opened, ${counts.menuItems} menu items clicked`,
);
if (selfTest) {
  const kinds = new Set(failures.map((f) => f.kind));
  const caught = ['LOG', 'PAGE ERROR', 'CONSOLE'].filter((k) => kinds.has(k));
  const planted = failures.filter((f) => /self-test|NOSUCHCOMMAND_UICHECK/.test(f.detail));
  console.log(`ui-check self-test: caught ${caught.join(', ')} (${planted.length} planted fault reports, ${failures.length - planted.length} other)`);
  process.exit(caught.length === 3 && failures.length === planted.length ? 0 : 1);
}
if (failures.length) {
  const byKind = {};
  for (const f of failures) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
  console.error(`ui-check: FAILED with ${failures.length} problem(s): ${JSON.stringify(byKind)}`);
  for (const f of failures.slice(0, 50)) console.error(`  - ${f.kind} [${f.where}] ${f.detail.split('\n')[0]}`);
  process.exit(1);
}
console.log('ui-check: OK');
