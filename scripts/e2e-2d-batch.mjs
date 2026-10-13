/**
 * Focused Windows source-Electron gate for the remaining-2D/reliability batch.
 * Run after `npm run build`: node scripts/e2e-2d-batch.mjs
 * Native Open/Save dialog answers are queued. The editor, renderer, codecs, preload,
 * IPC permissions, filesystem, atomic writes and backups are the application code.
 * This deliberately does not claim native DWG helper or installed-release validation.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';
import { applicationWindow } from './electron-window.mjs';

const repo = resolve(import.meta.dirname, '..');
assert.equal(process.platform, 'win32', 'This batch gate targets Windows filename identity.');
assert.ok(existsSync(join(repo, 'dist', 'index.html')), 'Build the source renderer before this gate.');
const local = join(repo, '.codex-local');
mkdirSync(local, { recursive: true });
const workspace = mkdtempSync(join(local, 'e2e-2d-batch-'));
assert.equal(dirname(realpathSync.native(workspace)), realpathSync.native(local));
const profile = join(workspace, 'profile'), temp = join(workspace, 'temp');
mkdirSync(profile); mkdirSync(temp);
// Playwright's own launch files, as well as child-process temporary output, stay private.
process.env.TEMP = temp; process.env.TMP = temp;
/** @type {Record<string, string | undefined>} */
const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
delete env.VITE_DEV_SERVER_URL; delete env.ELECTRON_RUN_AS_NODE;
const passed = [];
const pageErrors = [];
const mainLog = [];
let step = 'launch';
const ok = (label) => { passed.push(label); console.log(`ok   ${label}`); };

/** @param {import('node:child_process').ChildProcess} child @param {number} ms */
function waitForExit(child, ms) {
  return new Promise((done) => {
    if (child.exitCode !== null || child.signalCode !== null) return done(true);
    const onExit = () => { clearTimeout(timer); done(true); };
    const timer = setTimeout(() => { child.removeListener('exit', onExit); done(false); }, ms);
    child.once('exit', onExit);
  });
}

/** Only the app instance created below and its child processes are eligible for shutdown. */
async function shutdown(app, child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  let timer;
  try {
    await Promise.race([
      app.evaluate(({ app: main }) => main.exit(0)).catch(() => {}),
      new Promise((done) => { timer = setTimeout(done, 5_000); }),
    ]);
  } finally { clearTimeout(timer); }
  if (await waitForExit(child, 5_000)) return;
  assert.ok(child.pid, 'Only the launched test process may be terminated.');
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
  assert.equal(await waitForExit(child, 5_000), true, 'The owned Electron instance must exit.');
}

/** Inspect native records independently of the renderer's DXF reader. */
function records(text) {
  const lines = text.trimEnd().split(/\r?\n/);
  assert.equal(lines.length % 2, 0, 'Saved DXF has complete group pairs.');
  const result = []; let record;
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i]), value = lines[i + 1].trim();
    if (code === 0) { if (record) result.push(record); record = { kind: value, groups: [] }; }
    else record?.groups.push([code, value]);
  }
  if (record) result.push(record);
  return result;
}
const valueOf = (record, code) => record?.groups.find(([key]) => key === code)?.[1];

/** Handwritten native default/absent overrides; this input is not produced by JCad. */
const defaultsSource = [
  0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 0, 'ENDSEC',
  0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'STYLE', 70, 1,
  0, 'STYLE', 2, 'NARROW', 70, 0, 40, 0, 41, 0.5, 50, 15, 71, 0, 3, 'arial.ttf', 4, '',
  0, 'ENDTAB', 0, 'ENDSEC',
  0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 2, 'LABEL', 70, 0, 10, 0, 20, 0,
  0, 'ATTDEF', 8, '0', 10, 0, 20, 0, 40, 1, 1, 'Default', 3, 'Tag', 2, 'TAG', 70, 0, 7, 'NARROW', 41, 1, 51, 0,
  0, 'ENDBLK', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES',
  0, 'TEXT', 8, '0', 10, 1, 20, 2, 40, 1, 1, 'Explicit defaults', 7, 'NARROW', 41, 1, 51, 0,
  0, 'TEXT', 8, '0', 10, 1, 20, 4, 40, 1, 1, 'Absent defaults', 7, 'NARROW',
  0, 'INSERT', 8, '0', 2, 'LABEL', 66, 1, 10, 5, 20, 6,
  0, 'ATTRIB', 8, '0', 10, 5, 20, 6, 40, 1, 1, 'Override', 2, 'TAG', 70, 0, 7, 'NARROW', 41, 1, 51, 0,
  0, 'SEQEND', 0, 'ENDSEC', 0, 'EOF', '',
].join('\r\n');

const app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], cwd: repo, env, timeout: 60_000 });
const child = app.process();
child.stdout?.on('data', (bytes) => mainLog.push(String(bytes)));
child.stderr?.on('data', (bytes) => mainLog.push(String(bytes)));
let page, timer, success = false;
try {
  page = await applicationWindow(app);
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.waitForFunction(() => Boolean(window.editor && window.jcad), null, { timeout: 30_000 });
  const paths = await app.evaluate(({ app: main }) => ({ user: main.getPath('userData'), session: main.getPath('sessionData'), app: main.getAppPath(), runtime: process.versions.electron }));
  assert.equal(realpathSync.native(paths.user), realpathSync.native(profile));
  assert.equal(realpathSync.native(paths.session), realpathSync.native(profile));
  assert.equal(realpathSync.native(paths.app), realpathSync.native(repo));
  assert.equal(await page.evaluate(() => location.href), 'jcad://app/index.html');
  ok(`Private source Electron ${paths.runtime}, secure app origin and worktree-local profile`);
  await app.evaluate(({ dialog }) => {
    const g = /** @type {any} */ (globalThis);
    const d = /** @type {any} */ (dialog);
    g.__batchDialogs = { open: [], save: [], events: [] };
    // These two native dialogs are the sole test doubles in this harness.
    d.showOpenDialog = async (_window, options) => {
      const path = g.__batchDialogs.open.shift();
      g.__batchDialogs.events.push({ kind: 'open', title: options?.title, path: path ?? null });
      return path ? { canceled: false, filePaths: [path] } : { canceled: true, filePaths: [] };
    };
    d.showSaveDialog = async (_window, options) => {
      const path = g.__batchDialogs.save.shift();
      g.__batchDialogs.events.push({ kind: 'save', title: options?.title, path: path ?? null });
      return path ? { canceled: false, filePath: path } : { canceled: true, filePath: undefined };
    };
  });

  async function reportsClosed() {
    for (let i = 0; i < 8 && await page.locator('.import-report-dialog').count(); i++) {
      await page.locator('.import-report-dialog .modal-footer button').filter({ hasText: /^Close$/ }).first().click();
    }
    assert.equal(await page.locator('.modal').count(), 0, `${step}: no unexpected renderer dialog`);
  }
  async function chosenOpen(path, fresh = false) {
    if (fresh) await page.evaluate(() => window.editor.sessions.add());
    await app.evaluate((_electron, path) => /** @type {any} */ (globalThis).__batchDialogs.open.push(path), path);
    assert.equal(await page.evaluate(() => window.editor.openFile()), true, `${step}: native Open`);
    await reportsClosed();
    assert.equal(await page.evaluate(() => window.editor.doc.filePath), path);
    assert.equal(await page.evaluate(() => window.editor.doc.dirty), false);
  }
  async function saveAs(path) {
    await app.evaluate((_electron, path) => /** @type {any} */ (globalThis).__batchDialogs.save.push(path), path);
    assert.equal(await page.evaluate(() => window.editor.saveFile(true, 'dxf')), true, `${step}: native Save As DXF`);
    assert.deepEqual(await page.evaluate(() => ({ path: window.editor.doc.filePath, dirty: window.editor.doc.dirty })), { path, dirty: false });
    assert.ok(readFileSync(path).length > 0, `${step}: real disk output`);
  }
  async function reopen(path) {
    // Reload the current clean tab, rather than selecting its already-open cached session.
    const before = await page.evaluate(() => window.editor.doc.entities.map((e) => e.id));
    await chosenOpen(path);
    const after = await page.evaluate(() => window.editor.doc.entities.map((e) => e.id));
    assert.ok(after.every((id) => !before.includes(id)), `${step}: reopen parses fresh entities`);
  }
  async function backup(path) {
    const prior = readFileSync(path);
    assert.equal(await page.evaluate(() => window.editor.saveFile(false)), true, `${step}: named real IPC save`);
    assert.deepEqual(readFileSync(path + '.bak'), prior, `${step}: exact prior bytes backed up`);
    assert.equal(await page.evaluate(() => window.editor.doc.dirty), false);
  }
  const polygonSignature = () => page.evaluate(() => {
    const layout = window.editor.doc.snapshot.layouts?.find((l) => l.name === 'Polygon');
    if (!layout?.viewports[0]?.clipBoundary) throw new Error('Native Polygon viewport boundary missing');
    const v = layout.viewports[0], b = v.clipBoundary;
    return JSON.parse(JSON.stringify({ center: v.center, width: v.width, height: v.height, view: v.view, clipOn: v.clipOn !== false,
      boundary: { type: b.type, layer: b.layer, color: b.color, trueColor: b.trueColor, points: b.points, closed: b.closed } }));
  });
  const textSignature = () => page.evaluate(() => {
    const ed = window.editor, keys = ['type', 'text', 'raw', 'position', 'height', 'rotation', 'align', 'style', 'widthFactor', 'oblique', 'attachment', 'lineSpacing', 'width', 'columns', 'attributes', 'attributePlacements'];
    const pick = (entity) => Object.fromEntries(keys.filter((key) => entity[key] !== undefined).map((key) => [key, entity[key]]));
    return JSON.parse(JSON.stringify({ entities: ed.doc.snapshot.entities.filter((e) => e.type === 'text' || e.type === 'mtext' || e.type === 'insert').map(pick),
      attributes: ed.doc.snapshot.blocks.LABEL?.attributes.map((a) => ({ tag: a.tag, default: a.default, ...pick(a) })) }));
  });

  const exercise = async () => {
    step = 'native polygon edit/undo/save/reopen';
    const source = join(workspace, 'polygon-source.dxf'), saved = join(workspace, 'polygon-saved.dxf');
    copyFileSync(join(repo, 'tests', 'fixtures', 'interchange', 'r2018-viewport-polygon.dxf'), source);
    const original = readFileSync(source);
    await chosenOpen(source);
    const before = await polygonSignature();
    assert.deepEqual(before.boundary.points, [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 4 }, { x: 4, y: 4 }, { x: 4, y: 8 }, { x: 2, y: 8 }]);
    await page.evaluate(() => {
      const ed = window.editor;
      ed.doc.setSpace({ layout: 'Polygon' });
      const layout = ed.doc.snapshot.layouts.find((l) => l.name === 'Polygon');
      const frame = ed.doc.entities.find((e) => e.id === layout.viewports[0].id);
      if (!frame || frame.type !== 'polyline') throw new Error('Native clip paper-space projection missing');
      ed.doc.replaceEntities([{ ...frame, points: frame.points.map((p) => ({ x: p.x + 1, y: p.y + 2 })) }]);
      ed.zoomExtents(); ed.render();
    });
    assert.equal(await page.evaluate(() => window.editor.doc.dirty), true);
    const edited = await polygonSignature();
    assert.deepEqual(edited.boundary.points, before.boundary.points.map((p) => ({ x: p.x + 1, y: p.y + 2 })));
    assert.equal(await page.evaluate(() => window.editor.doc.undo()), true);
    assert.deepEqual(await polygonSignature(), before);
    assert.equal(await page.evaluate(() => window.editor.doc.redo()), true);
    assert.deepEqual(await polygonSignature(), edited);
    await saveAs(saved); await backup(saved);
    const native = records(readFileSync(saved, 'utf8'));
    const viewport = native.find((r) => r.kind === 'VIEWPORT' && valueOf(r, 340));
    assert.ok(viewport, 'Native VIEWPORT hard pointer is emitted.');
    assert.ok((Number(valueOf(viewport, 90)) & 65536) !== 0, 'Native nonrectangular clip flag is emitted.');
    const boundary = native.find((r) => r.kind === 'LWPOLYLINE' && valueOf(r, 5) === valueOf(viewport, 340));
    assert.equal(Number(valueOf(boundary, 90)), 6, 'Pointer resolves to all six native boundary vertices.');
    assert.equal(valueOf(boundary, 330), valueOf(viewport, 330), 'Native boundary and viewport share the paper-space owner.');
    await reopen(saved); assert.deepEqual(await polygonSignature(), edited);
    assert.deepEqual(readFileSync(source), original, 'Private native source is unchanged.');
    // Use the real layout-tab controller so its paper-space painter is installed.
    // Reload starts on Model; changing only the document's space would leave the view stale.
    await page.locator('.layout-tab[data-layout="Polygon"]').click();
    await page.evaluate(async () => {
      const ed = window.editor;
      if (ed.doc.space?.layout !== 'Polygon' || ed.doc.space.viewport || !ed.viewport.layoutPainter) throw new Error('Polygon paper-space painter is not active');
      ed.zoomExtents(); ed.render();
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    });
    await page.screenshot({ path: join(workspace, 'polygon-reopened.png') });
    ok('Native polygon fixture: paper edit, undo/redo, IPC DXF save, exact backup, native pointer/owner and fresh reopen');

    step = 'retained clip DWG save refusal';
    const refusedPath = join(workspace, 'retained-clip-refused.dwg');
    await page.evaluate(() => {
      const ed = window.editor;
      ed.doc.addEntities([{ id: 'clip-dirty-marker', type: 'line', layer: '0', color: 'ByLayer', a: { x: 1, y: 1 }, b: { x: 2, y: 2 } }]);
      /** @type {any} */ (window).__batchBeforeRefusal = { state: ed.doc.snapshot, history: ed.doc.history(), path: ed.doc.filePath,
        dirty: ed.doc.dirty, session: ed.sessions.activeId, revision: ed.sessions.current.revision, generation: ed.sessions.current.contentGeneration };
    });
    await app.evaluate((_electron, path) => /** @type {any} */ (globalThis).__batchDialogs.save.push(path), refusedPath);
    const refusal = page.evaluate(() => window.editor.saveFile(true));
    const failure = page.locator('.save-error-dialog');
    await failure.waitFor({ state: 'visible', timeout: 15_000 });
    assert.match(await failure.innerText(), /retained viewport clipping boundaries/);
    await failure.locator('button', { hasText: /^Cancel$/ }).click();
    assert.equal(await refusal, false);
    assert.equal(await page.evaluate(() => {
      const ed = window.editor, before = /** @type {any} */ (window).__batchBeforeRefusal, history = ed.doc.history(), current = ed.sessions.current;
      const retained = ed.doc.snapshot === before.state && ed.doc.filePath === before.path && ed.doc.dirty === before.dirty && ed.doc.dirty && ed.sessions.activeId === before.session && current.revision === before.revision && current.contentGeneration === before.generation &&
        ['undo', 'redo'].every((kind) => history[kind].length === before.history[kind].length && history[kind].every((state, i) => state === before.history[kind][i]));
      delete /** @type {any} */ (window).__batchBeforeRefusal;
      return retained;
    }), true, 'DWG refusal preserves source identity, history, dirty state and session binding.');
    assert.equal(existsSync(refusedPath), false); assert.equal(existsSync(refusedPath + '.bak'), false);
    ok('Real clip-DWG refusal dialog: Cancel leaves dirty state, history, binding and both destination files intact');

    step = 'native text default presence edit/save/reopen';
    const textSource = join(workspace, 'text-source.dxf'), textSaved = join(workspace, 'text-saved.dxf');
    writeFileSync(textSource, defaultsSource);
    await chosenOpen(textSource, true);
    const defaults = await textSignature();
    assert.equal(defaults.entities.find((e) => e.text === 'Explicit defaults').widthFactor, 1);
    assert.equal(defaults.entities.find((e) => e.text === 'Explicit defaults').oblique, 0);
    assert.equal(Object.hasOwn(defaults.entities.find((e) => e.text === 'Absent defaults'), 'widthFactor'), false);
    await page.evaluate(() => {
      const ed = window.editor, replacements = ed.doc.entities.map((e) => e.type === 'text' ? { ...e, text: e.text + ' edited', position: { x: e.position.x + 2, y: e.position.y + 3 } }
        : e.type === 'insert' ? { ...e, attributes: { ...e.attributes, TAG: 'Attribute edited' } } : e);
      ed.doc.replaceEntities(replacements);
    });
    const editedText = await textSignature();
    assert.equal(await page.evaluate(() => window.editor.doc.undo()), true); assert.deepEqual(await textSignature(), defaults);
    assert.equal(await page.evaluate(() => window.editor.doc.redo()), true); assert.deepEqual(await textSignature(), editedText);
    await saveAs(textSaved); await backup(textSaved);
    const textNative = records(readFileSync(textSaved, 'utf8'));
    for (const kind of ['TEXT', 'ATTDEF', 'ATTRIB']) {
      const record = textNative.find((r) => r.kind === kind && (kind !== 'TEXT' || valueOf(r, 1) === 'Explicit defaults edited'));
      assert.equal(valueOf(record, 41), '1', `${kind}: explicit native width1 survives`);
      assert.equal(valueOf(record, 51), '0', `${kind}: explicit native oblique0 survives`);
    }
    const absent = textNative.find((r) => r.kind === 'TEXT' && valueOf(r, 1) === 'Absent defaults edited');
    assert.equal(valueOf(absent, 41), undefined); assert.equal(valueOf(absent, 51), undefined);
    await reopen(textSaved); assert.deepEqual(await textSignature(), editedText);
    assert.equal(readFileSync(textSource, 'utf8'), defaultsSource);
    ok('TEXT/ATTDEF/ATTRIB: explicit1/0 versus absent overrides, real edits, undo/redo, native records and IPC save/reopen');

    step = 'native MTEXT manual column edit/save/reopen';
    const mtextSource = join(workspace, 'mtext-source.dxf'), mtextSaved = join(workspace, 'mtext-saved.dxf');
    copyFileSync(join(repo, 'tests', 'fixtures', 'interchange', 'r2018-mtext.dxf'), mtextSource);
    const mtextOriginal = readFileSync(mtextSource);
    await chosenOpen(mtextSource, true);
    const mtextBefore = await textSignature();
    const mtextEdit = await page.evaluate(() => {
      const ed = window.editor, m = ed.doc.entities.find((e) => e.type === 'mtext' && e.columns);
      if (!m) throw new Error('Independent native MTEXT column fixture missing');
      ed.doc.replaceEntities([{ ...m, text: 'aa bb cc dd\nee ff gg hh', raw: '\\pxqj;aa bb cc dd\\Pee ff gg hh', height: 1, width: 6,
        columns: { type: 2, count: 3, width: 6, gutter: 2, autoHeight: false, reversed: false, heights: [1, 1, 1] } }]);
      const bounds = /** @type {any} */ (window).jcadApi.geometry.bounds([m.id]);
      if (!bounds || ![bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y].every(Number.isFinite)) throw new Error('Manual MTEXT flow must have finite bounds');
      ed.zoomExtents(); ed.render();
      return { dirty: ed.doc.dirty, bounds };
    });
    assert.equal(mtextEdit.dirty, true);
    const mtextEdited = await textSignature();
    assert.equal(await page.evaluate(() => window.editor.doc.undo()), true); assert.deepEqual(await textSignature(), mtextBefore);
    assert.equal(await page.evaluate(() => window.editor.doc.redo()), true); assert.deepEqual(await textSignature(), mtextEdited);
    await saveAs(mtextSaved); await backup(mtextSaved);
    assert.match(readFileSync(mtextSaved, 'utf8'), /JCAD_MTEXT_COLUMNS/, 'Current explicit column metadata fallback is retained.');
    await reopen(mtextSaved); assert.deepEqual(await textSignature(), mtextEdited);
    assert.deepEqual(readFileSync(mtextSource), mtextOriginal);
    await page.screenshot({ path: join(workspace, 'mtext-reopened.png') });
    ok('Native MTEXT fixture: paragraph/manual-height column edit, finite bounds, undo/redo, IPC save/reopen and unchanged input');

    step = 'independent Windows NFC/NFD paths and backups';
    const unicodePaths = [join(workspace, 'caf\u00e9.dxf'), join(workspace, 'cafe\u0301.dxf')];
    assert.notEqual(unicodePaths[0], unicodePaths[1]);
    assert.equal(unicodePaths[0].normalize('NFC'), unicodePaths[1].normalize('NFC'));
    for (const [index, path] of unicodePaths.entries()) {
      await page.evaluate((index) => {
        const ed = window.editor; ed.sessions.add();
        ed.doc.addEntities([{ id: `unicode-${index}`, type: 'line', layer: '0', color: 'ByLayer', a: { x: 100 + index, y: index }, b: { x: 110 + index, y: index } }]);
      }, index);
      await saveAs(path);
      const prior = readFileSync(path);
      await page.evaluate((index) => {
        const ed = window.editor, line = ed.doc.entities[0];
        ed.doc.replaceEntities([{ ...line, b: { x: 120 + index, y: index } }]);
      }, index);
      await backup(path);
      assert.deepEqual(readFileSync(path + '.bak'), prior, 'Each Unicode spelling has its own previous file.');
      await reopen(path);
      assert.deepEqual(await page.evaluate(() => window.editor.doc.entities[0].b), { x: 120 + index, y: index });
    }
    assert.notDeepEqual(readFileSync(unicodePaths[0]), readFileSync(unicodePaths[1]));
    assert.notDeepEqual(readFileSync(unicodePaths[0] + '.bak'), readFileSync(unicodePaths[1] + '.bak'));
    const unicodeTabs = await page.evaluate((paths) => window.editor.sessions.all.filter((s) => paths.includes(s.filePath)).map((s) => ({ id: s.id, path: s.filePath, dirty: s.dirty })), unicodePaths);
    assert.equal(unicodeTabs.length, 2); assert.notEqual(unicodeTabs[0].id, unicodeTabs[1].id);
    assert.deepEqual(unicodeTabs.map((s) => s.path).sort(), [...unicodePaths].sort());
    assert.ok(unicodeTabs.every((s) => !s.dirty));
    assert.ok(unicodePaths.every((path) => readdirSync(workspace).includes(path.slice(workspace.length + 1))));
    ok('Real Windows composed/decomposed filename saves remain distinct in files, .bak copies and reopened tabs');

    const queued = await app.evaluate(() => {
      const d = /** @type {any} */ (globalThis).__batchDialogs;
      return { open: d.open.length, save: d.save.length, events: d.events };
    });
    assert.equal(queued.open, 0); assert.equal(queued.save, 0);
    assert.ok(queued.events.every((e) => e.path && (e.title === 'Open Drawing' || e.title === 'Save Drawing As')));
    assert.ok(!readdirSync(workspace).some((name) => name.endsWith('.tmp')), 'Atomic drawing saves leave no temporary files.');
    assert.deepEqual(pageErrors, [], 'No uncaught renderer error.');
    assert.equal(existsSync(join(profile, 'error.log')), false, 'No main-process error log.');
    writeFileSync(join(workspace, 'dialog-events.json'), JSON.stringify(queued.events, null, 2));
    ok('Real bridge/dialog queues consumed, atomic temp files absent, and renderer/main errors absent');
  };
  await Promise.race([exercise(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Batch gate timed out during ${step}`)), 180_000); })]);
  success = true;
} catch (error) {
  console.error(`FAIL ${step}: ${error.stack || error}`);
  if (page && !page.isClosed()) await page.screenshot({ path: join(workspace, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await shutdown(app, child);
  writeFileSync(join(workspace, 'electron.log'), mainLog.join(''));
  writeFileSync(join(workspace, 'result.json'), JSON.stringify({ success, step, passed, pageErrors, scope: 'Windows source Electron; real DXF/IPC/atomic writes; native Open/Save dialog queues only; no DWG helper or installer proof' }, null, 2));
  console.log(`e2e-2d-batch: ${passed.length} checks passed; ${success ? 'passed' : 'failed'}; artifacts ${workspace}`);
}
