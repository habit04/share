/** Real Windows IPC/export/import checks shared by source Electron and the unpublished test ASAR. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { extname, join } from 'node:path';

/** @param {{ app: import('playwright').ElectronApplication, page: import('playwright').Page, repo: string, outDir: string, check: (ok: boolean, text: string) => void, current: boolean }} opts */
export async function runPortableDwgChecks({ app, page, repo, outDir, check, current }) {
  if (process.platform !== 'win32' || !current) { check(true, 'Portable DWG export skipped explicitly: this edition/version does not provide the Windows feature'); return; }
  const directory = join(outDir, 'portable-dwg'); mkdirSync(directory, { recursive: true });
  const beforeIds = await page.evaluate(() => ({ ids: window.editor.sessions.all.map(s => s.id), active: window.editor.sessions.activeId }));
  const status = await page.evaluate(() => window.jcad.dwgExportStatus());
  assert.equal(status.available, true, `Bundled Windows writer must be available: ${status.reason || ''}`);
  check(true, 'Portable DWG writer is present and passes its actual integrity manifest');
  const closeReports = async () => {
    for (let n = 0; n < 8 && await page.locator('.import-report-dialog').count(); n++) await page.locator('.import-report-dialog .modal-footer button').filter({ hasText: /^Close$/ }).first().click();
    assert.equal(await page.locator('.modal').count(), 0, 'No unexpected modal during portable DWG checks');
  };
  const signature = () => page.evaluate(() => {
    const ed = window.editor;
    // Match the independent native oracle: explicit RGB is authoritative and AutoCAD may
    // recompute its fallback ACI. Missing RGB, full color-book identity or alpha still fails.
    const appearance = e => ({ color: e.trueColor === undefined ? e.color : undefined, trueColor: e.trueColor, colorName: e.colorName, transparency: e.transparency ?? 'ByLayer' });
    const entities = ed.doc.entities.map(e => e.type === 'insert' ? {
      type: e.type, block: e.block, position: e.position, scale: e.scale, scaleY: e.scaleY ?? e.scale, rotation: e.rotation,
      columns: e.columns ?? 1, rows: e.rows ?? 1, columnSpacing: e.columnSpacing ?? 0, rowSpacing: e.rowSpacing ?? 0, attributes: e.attributes, ...appearance(e),
    } : e.type === 'polyline' ? {
      type: e.type, points: e.points, closed: e.closed, bulges: e.bulges ?? e.points.map(() => 0),
      widths: e.points.slice(0, e.closed ? undefined : -1).map((_p, i) => e.widths?.[i] ?? { start: e.width ?? 0, end: e.width ?? 0 }), ...appearance(e),
    } : { type: e.type, ...(e.type === 'line' ? { a: e.a, b: e.b } : {}), ...appearance(e) });
    return JSON.parse(JSON.stringify(entities));
  });
  const approximate = (actual, expected, location) => {
    if (typeof actual === 'number' && typeof expected === 'number') assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)), location);
    else if (Array.isArray(expected)) { assert.ok(Array.isArray(actual), location); assert.equal(actual.length, expected.length, location); expected.forEach((v, i) => approximate(actual[i], v, `${location}[${i}]`)); }
    else if (expected && typeof expected === 'object') { assert.deepEqual(Object.keys(actual || {}).sort(), Object.keys(expected).sort(), location); for (const key of Object.keys(expected)) approximate(actual[key], expected[key], `${location}.${key}`); }
    else assert.deepEqual(actual, expected, location);
  };
  let selectedTarget = '';
  let validDxf = '';
  try {
    // Explicit legacy TABLESTYLE definitions have no proven AC1032 transcoding
    // contract. Keep the actual application/export refusal and byte fences,
    // then prove array saving through the independently authored native DWG.
    const legacySource = join(directory, 'legacy-table-style-source.dxf');
    copyFileSync(join(repo, 'tests/fixtures/interchange/r2018-minsert.dxf'), legacySource);
    const legacyBytes = readFileSync(legacySource), legacyTarget = join(directory, 'legacy-table-style.dwg');
    const legacyDestination = Buffer.from('prior legacy destination'), legacyBackup = Buffer.from('prior legacy backup');
    writeFileSync(legacyTarget, legacyDestination, { flag: 'wx' }); writeFileSync(legacyTarget + '.bak', legacyBackup, { flag: 'wx' });
    await page.evaluate(() => window.editor.sessions.add());
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), legacySource);
    assert.equal(await page.evaluate(() => window.editor.openFile()), true, 'Legacy TABLESTYLE source opens'); await closeReports();
    await page.evaluate(() => {
      const w = /** @type {any} */ (window), ed = w.editor;
      ed.doc.addEntities([{ id: 'legacy-refusal-marker', type: 'line', layer: '0', color: 'ByLayer', a: { x: -5, y: -5 }, b: { x: -4, y: -4 } }]);
      w.__portableBefore = { state: ed.doc.snapshot, path: ed.doc.filePath, history: ed.doc.history(), session: ed.sessions.activeId, dirty: ed.doc.dirty };
    });
    await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), legacyTarget);
    await page.evaluate(() => window.editor.commands.get('EXPORTDWG').run(window.editor));
    const legacyLog = await page.evaluate(() => window.editor.history.slice(-12));
    assert.ok(legacyLog.some(text => /DWG export failed:.*DWG reopening changed metadata .*TableStyle fields/.test(text)), 'Legacy TABLESTYLE must refuse on the full retained payload: ' + legacyLog.join(' | '));
    assert.deepEqual(readFileSync(legacyTarget), legacyDestination); assert.deepEqual(readFileSync(legacyTarget + '.bak'), legacyBackup);
    assert.deepEqual(readFileSync(legacySource), legacyBytes);
    assert.equal(await page.evaluate(() => {
      const ed = window.editor, saved = /** @type {any} */ (window).__portableBefore, history = ed.doc.history();
      return ed.doc.snapshot === saved.state && ed.doc.filePath === saved.path && ed.doc.dirty === saved.dirty && ed.doc.dirty && ed.sessions.activeId === saved.session && ['undo', 'redo'].every(key => history[key].length === saved.history[key].length && history[key].every((state, index) => state === saved.history[key][index]));
    }), true, 'Legacy TABLESTYLE refusal preserves the working revision and history');
    check(true, 'Explicit legacy TABLESTYLE export refuses, preserving source, destination, backup and working drawing');
    for (const [label, source] of [['arrays', 'interchange/r2018-minsert.dwg'], ['widths', 'polyline-widths.dxf'], ['appearance', 'interchange/r2010-appearance.dxf'], ['attributes', 'interchange/r2000-text-justification.dxf']]) {
      const file = join(directory, `${label}-source${extname(source)}`);
      copyFileSync(join(repo, 'tests', 'fixtures', source), file);
      const originalSource = readFileSync(file);
      await page.evaluate(() => window.editor.sessions.add());
      await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), file);
      assert.equal(await page.evaluate(() => window.editor.openFile()), true, label + ': real native source open'); await closeReports();
      await page.evaluate(() => {
        const w = /** @type {any} */ (window), ed = w.editor;
        ed.doc.addEntities([{ id: 'portable-export-dirty-marker', type: 'line', layer: '0', color: 'ByLayer', a: { x: -10, y: -10 }, b: { x: -9, y: -9 } }]);
        w.__portableBefore = { state: ed.doc.snapshot, path: ed.doc.filePath, history: ed.doc.history(), session: ed.sessions.activeId, dirty: ed.doc.dirty };
      });
      const expected = await signature(); const target = join(directory, `${label}.dwg`); const previous = Buffer.from(`previous destination ${label}`); writeFileSync(target, previous);
      await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), target);
      await page.evaluate(() => window.editor.commands.get('EXPORTDWG').run(window.editor));
      const exportLog = await page.evaluate(() => window.editor.history.slice(-12));
      assert.equal(readFileSync(target).subarray(0, 6).toString('ascii'), 'AC1032', label + ': real portable output; ' + exportLog.join(' | '));
      assert.deepEqual(readFileSync(target + '.bak'), previous, label + ': exact prior destination backup');
      assert.deepEqual(readFileSync(file), originalSource, label + ': supplied source remains unchanged');
      const preserved = await page.evaluate(() => {
        const ed = window.editor, saved = /** @type {any} */ (window).__portableBefore, history = ed.doc.history();
        return ed.doc.snapshot === saved.state && ed.doc.filePath === saved.path && ed.doc.dirty === saved.dirty && ed.doc.dirty && ed.sessions.activeId === saved.session && ['undo', 'redo'].every(k => history[k].length === saved.history[k].length && history[k].every((state, i) => state === saved.history[k][i]));
      });
      assert.equal(preserved, true, label + ': export leaves binding, dirty flag, snapshot and undo history intact');
      await page.evaluate(() => window.editor.sessions.add());
      assert.equal(await page.evaluate(p => window.editor.openFile(p), target), true, label + ': new DWG opens through real isolated LibreDWG IPC'); await closeReports();
      approximate(await signature(), expected, label + ': DWG semantic round trip');
      check(true, `Portable DWG ${label}: real helper, atomic backup, preserved working state and isolated-reader semantic reopen`);
      selectedTarget = target; validDxf = readFileSync(file, 'utf8');
    }
    const working = join(directory, 'save-as-working.dwg');
    const previousWorking = Buffer.from('previous normal save destination'); writeFileSync(working, previousWorking);
    const beforeSaveAs = await signature();
    await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), working);
    assert.equal(await page.evaluate(() => window.editor.saveFile(true)), true, 'Normal Save As writes DWG');
    const binding = await page.evaluate(() => ({ path: window.editor.doc.filePath, dirty: window.editor.doc.dirty }));
    assert.deepEqual(binding, { path: working, dirty: false }, 'DWG Save As becomes the clean working file');
    assert.equal(readFileSync(working).subarray(0, 6).toString('ascii'), 'AC1032');
    assert.deepEqual(readFileSync(working + '.bak'), previousWorking, 'DWG Save As keeps exact previous destination');
    const beforeNormalSave = readFileSync(working);
    await page.evaluate(() => window.editor.doc.addEntities([{ id: 'normal-dwg-save-marker', type: 'line', layer: '0', color: 'ByLayer', a: { x: -23, y: -24 }, b: { x: -22, y: -21 } }]));
    const afterEdit = await signature();
    assert.equal(await page.evaluate(() => window.editor.saveFile(false)), true, 'Normal Save writes DWG in place without another picker');
    assert.deepEqual(readFileSync(working + '.bak'), beforeNormalSave, 'Normal DWG Save keeps exact previous file');
    assert.equal(await page.evaluate(() => window.editor.doc.dirty), false);
    assert.equal(await page.evaluate(p => window.editor.openFile(p), working), true); await closeReports();
    approximate(await signature(), afterEdit, 'Normal DWG Save semantic reopen');
    assert.equal((await signature()).length, beforeSaveAs.length + 1);
    await page.evaluate(() => window.editor.doc.addEntities([{ id: 'dwg-overwrite-consent-marker', type: 'line', layer: '0', color: 'ByLayer', a: { x: -33, y: -34 }, b: { x: -32, y: -31 } }]));
    const overwrite = page.evaluate(() => window.editor.saveFile(false));
    const warning = page.locator('.modal', { hasText: 'Save over the original file?' });
    await warning.waitFor({ timeout: 10000 });
    assert.match(await warning.innerText(), /properties JCad cannot read|object\(s\) JCad cannot keep/);
    await warning.locator('button', { hasText: /^Yes$/ }).click();
    assert.equal(await overwrite, true, 'Normal DWG source overwrite requires and accepts loss consent');
    const explicitDxf = join(directory, 'explicit-dxf-copy.dxf');
    const expectedDxf = await signature();
    const dxfSource = await page.evaluate(() => ({ version: window.editor.doc.snapshot.cadGraph?.sourceVersion,
      ids: window.editor.doc.entities.map(entity => entity.id) }));
    assert.equal(dxfSource.version, 'AC1032', 'Reopened native DWG supplies the retained DXF header version');
    const sourceDwg = readFileSync(working), sourceBackup = readFileSync(working + '.bak');
    await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), explicitDxf);
    assert.equal(await page.evaluate(() => window.editor.saveFile(true, 'dxf')), true, 'Explicit DXF export from DWG uses DXF Save As');
    const dxfBytes = readFileSync(explicitDxf), dxfText = dxfBytes.toString('utf8');
    assert.match(dxfText, /^0\r?\nSECTION\r?\n2\r?\nHEADER\r?\n/, 'Explicit DXF begins with a HEADER section');
    assert.match(dxfText, /\r?\n9\r?\n\$ACADVER\r?\n1\r?\nAC1032\r?\n/, 'Explicit DXF preserves the imported AC1032 header');
    assert.match(dxfText, /\r?\n0\r?\nEOF\s*$/, 'Explicit DXF ends with the complete EOF record');
    assert.deepEqual(await page.evaluate(() => ({ path: window.editor.doc.filePath, dirty: window.editor.doc.dirty })),
      { path: explicitDxf, dirty: false }, 'DXF Save As becomes the clean working file');
    assert.equal(await page.evaluate(p => window.editor.openFile(p), explicitDxf), true, 'Explicit DXF reopens from disk through real IPC'); await closeReports();
    assert.deepEqual(await page.evaluate(() => ({ schema: window.editor.doc.snapshot.cadGraph?.schema,
      format: window.editor.doc.snapshot.cadGraph?.sourceFormat, version: window.editor.doc.snapshot.cadGraph?.sourceVersion })),
      { schema: 1, format: 'DXF', version: dxfSource.version }, 'Fresh DXF parser retains the exact source header version');
    assert.ok(await page.evaluate(ids => window.editor.doc.entities.every(entity => !ids.includes(entity.id)), dxfSource.ids), 'DXF reopen parses fresh entities rather than showing the saved tab');
    approximate(await signature(), expectedDxf, 'Explicit DXF semantic round trip');
    assert.deepEqual(readFileSync(explicitDxf), dxfBytes, 'Fresh DXF read leaves the saved file unchanged');
    assert.deepEqual(readFileSync(working), sourceDwg, 'Explicit DXF Save As preserves the prior DWG');
    assert.deepEqual(readFileSync(working + '.bak'), sourceBackup, 'Explicit DXF Save As preserves the prior DWG backup');
    check(true, 'Normal DWG Save As and in-place Save preserve semantics and exact backups, source overwrite requires loss consent, and explicit DXF preserves AC1032 through a fresh semantic reopen');
    const prior = readFileSync(selectedTarget), backup = readFileSync(selectedTarget + '.bak');
    for (const [label, text] of [['malformed', 'not DXF'], ['unsupported 3D', '0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1032\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\n3DSOLID\n5\n101\n100\nAcDbEntity\n8\n0\n100\nAcDbModelerGeometry\n70\n1\n1\nunsupported ACIS\n0\nENDSEC\n0\nEOF\n']]) {
      const refused = await page.evaluate(([p, text]) => window.jcad.exportDwg(p, text).then(() => false, () => true), [selectedTarget, text]);
      assert.equal(refused, true, label + ': actual helper/host must reject'); assert.deepEqual(readFileSync(selectedTarget), prior); assert.deepEqual(readFileSync(selectedTarget + '.bak'), backup);
      check(true, `Portable DWG ${label} refuses export and preserves both destination and backup`);
    }
    // These are generated source/test-ASAR artifacts, never the user's installed release.
    const helper = await app.evaluate(({ app }) => (app.isPackaged ? process.resourcesPath : app.getAppPath() + '/release') + '/dwg-writer/JcadDwgWriter.exe');
    const original = readFileSync(helper); const hidden = helper + '.e2e-missing'; assert.equal(existsSync(hidden), false);
    try {
      writeFileSync(helper, Buffer.concat([original, Buffer.from('tamper')]));
      assert.equal((await page.evaluate(() => window.jcad.dwgExportStatus())).available, false, 'Tampered installed helper cannot pass status');
      assert.equal(await page.evaluate(([p, text]) => window.jcad.exportDwg(p, text).then(() => false, () => true), [selectedTarget, validDxf]), true, 'Tampered helper export is refused');
      assert.deepEqual(readFileSync(selectedTarget), prior); assert.deepEqual(readFileSync(selectedTarget + '.bak'), backup);
    } finally { writeFileSync(helper, original); }
    try {
      renameSync(helper, hidden);
      assert.equal((await page.evaluate(() => window.jcad.dwgExportStatus())).available, false, 'Missing helper cannot pass status');
    } finally { renameSync(hidden, helper); }
    assert.equal((await page.evaluate(() => window.jcad.dwgExportStatus())).available, true, 'Exact restored bytes pass the real integrity check');
    check(true, 'Portable DWG missing/tampered helper is refused without destination changes, and restored helper recovers');
  } finally {
    await page.evaluate(saved => {
      const ed = window.editor;
      for (let i = ed.sessions.count - 1; i >= 0; i--) if (!saved.ids.includes(ed.sessions.all[i].id)) ed.sessions.close(i);
      ed.switchSession(ed.sessions.indexOfId(saved.active)); delete /** @type {any} */ (window).__portableBefore;
    }, beforeIds);
    await app.evaluate(() => globalThis.__e2e.messages.splice(0));
  }
}
