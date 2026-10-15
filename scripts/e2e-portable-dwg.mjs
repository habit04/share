/** Real Windows IPC/export/import checks shared by source Electron and the unpublished test ASAR. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

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
  const importSummary = () => page.evaluate(() => {
    const state = window.editor.doc.snapshot;
    const report = /** @type {import('../src/io/import-report').ImportReport | undefined} */ (state.meta?.importReport);
    if (!report) return null;
    const total = action => Object.values(report.counts).reduce((sum, counts) => sum + (counts[action] ?? 0), 0);
    return { format: report.format, sourcePath: report.sourcePath, recovered: !!report.recovered, omitted: report.omitted,
      dropped: total('dropped'), simplified: total('simplified'), unsupported: total('unsupported'), kept: total('kept'),
      layoutsKept: report.counts.LAYOUT?.kept ?? 0, counts: report.counts };
  });
  // This fixed control's foreign polyface is retained raw with foreign 3D import off.
  // All original pairs stay exact. Compare raw source data before No, then check
  // only the proven model-owner rebind and absent structural follower owners on reopen.
  const lossPolyface = (requireOwners = false) => page.evaluate(requireOwners => {
    const ed = window.editor, graph = ed.doc.snapshot.cadGraph;
    if (!graph || (ed.settings.experimental3d && ed.settings.importForeign3d)) throw new Error('The loss control requires the foreign-import-off retained source graph.');
    const model = graph.nodes.find(node => node.type === 'BLOCK_RECORD' && node.groups.some(([code, value]) => code === 2 && value === '*Model_Space'));
    const handles = ['107', '108', '109', '10A', '10B', '10C'];
    const ordered = graph.nodes.filter(node => handles.includes(node.sourceHandle));
    if (ordered.length !== handles.length || ordered.some((node, index) => node.sourceHandle !== handles[index])) throw new Error('The loss control changed its physical polyface parent/follower order.');
    const commonOwners = groups => {
      const owners = []; let depth = 0;
      for (let index = 0; index < groups.length; index++) {
        const [code, value] = groups[index];
        if (code === 102) { depth += value.startsWith('{') ? 1 : value === '}' ? -1 : 0; continue; }
        if (!depth && [100, 8, 1001].includes(code)) break;
        if (!depth && code === 330) owners.push(index);
      }
      return owners;
    };
    const records = handles.map((handle, index) => {
      const matches = graph.nodes.filter(node => node.sourceHandle === handle);
      if (matches.length !== 1) throw new Error('The loss control has a missing/duplicated retained polyface record: ' + handle);
      const node = matches[0], expectedType = index === 0 ? 'POLYLINE' : index === 5 ? 'SEQEND' : 'VERTEX';
      if (node.type !== expectedType) throw new Error('The loss control changed its parent/follower type: ' + handle);
      const owners = commonOwners(node.groups), groups = [...node.groups];
      if (index === 0) {
        const paper = node.groups.find(([code]) => code === 67)?.[1], layout = node.groups.find(([code]) => code === 410)?.[1];
        if (owners.length !== 1 || paper !== undefined && Number(paper) !== 0 || layout !== undefined && layout !== 'Model'
          || requireOwners && !model || model && node.groups[owners[0]]?.[1] !== model.sourceHandle) throw new Error('The raw control polyface has no proven model-space owner.');
        groups[owners[0]] = [330, '*Model_Space'];
      } else if (owners.length === 0 && !requireOwners) {
        if (node.groups[0]?.[0] !== 5 || node.groups[0][1] !== handle) throw new Error('The raw follower has no original leading handle.');
        groups.splice(1, 0, [330, '107']);
      } else if (owners.length !== 1 || owners[0] !== 1 || node.groups[1]?.[0] !== 330 || node.groups[1][1] !== '107') {
        throw new Error('The fresh raw follower has no unique structural parent owner after handle5.');
      }
      return { handle, type: node.type, raw: node.groups, comparable: groups };
    });
    return { raw: records.map(record => ({ handle: record.handle, type: record.type, groups: record.raw })),
      comparable: records.map(record => ({ handle: record.handle, type: record.type, groups: record.comparable })) };
  }, requireOwners);
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
    for (const [label, source] of [['arrays', 'interchange/r2018-minsert.dxf'], ['widths', 'polyline-widths.dxf'], ['appearance', 'interchange/r2010-appearance.dxf'], ['attributes', 'interchange/r2000-text-justification.dxf']]) {
      const file = join(directory, `${label}-source.dxf`);
      copyFileSync(join(repo, 'tests', 'fixtures', source), file);
      const originalSource = readFileSync(file);
      await page.evaluate(() => window.editor.sessions.add());
      await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), file);
      assert.equal(await page.evaluate(() => window.editor.openFile()), true, label + ': real native DXF open'); await closeReports();
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
      assert.deepEqual(readFileSync(file), originalSource, label + ': supplied DXF source remains unchanged');
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
    // The actual retained native page/graph no longer supplies a loss report. Test
    // the source-bound report eligibility instead of waiting for a warning that
    // belongs only to dropped/simplified/unreadable source data.
    const workingImport = await importSummary();
    assert.ok(workingImport, 'Native working DWG has its actual import report');
    assert.equal(workingImport.format, 'DWG');assert.equal(workingImport.sourcePath, working);
    assert.equal(workingImport.recovered, false);assert.equal(workingImport.omitted, 0);
    assert.equal(workingImport.dropped + workingImport.simplified + workingImport.unsupported, 0, 'Retained native metadata is not a source-loss condition');
    assert.ok(workingImport.layoutsKept > 0, 'Physical native page settings are explicitly reported kept');
    const beforeReviewedSave = readFileSync(working);
    await page.evaluate(() => window.editor.doc.addEntities([{ id: 'dwg-overwrite-consent-marker', type: 'line', layer: '0', color: 'ByLayer', a: { x: -33, y: -34 }, b: { x: -32, y: -31 } }]));
    const reviewedSignature = await signature();
    assert.equal(await page.evaluate(() => window.editor.saveFile(false)), true, 'Source-loss-free native DWG saves without a loss-consent prompt');
    assert.deepEqual(readFileSync(working + '.bak'), beforeReviewedSave, 'Reviewed native overwrite keeps the exact prior working file');
    assert.equal(await page.locator('.modal', { hasText: 'Save over the original file?' }).count(), 0);
    assert.equal(await page.evaluate(() => window.editor.doc.dirty), false);
    assert.equal(await page.evaluate(p => window.editor.openFile(p), working), true);await closeReports();
    approximate(await signature(), reviewedSignature, 'Reviewed native source overwrite semantic reopen');
    // The reopened native drawing retains its metadata source version; DXF Save As
    // preserves AC1032 even when the modeled appearance alone needs only AC1015.
    const explicitSourceVersion = await page.evaluate(() => window.editor.doc.snapshot.cadGraph?.sourceVersion);
    assert.equal(explicitSourceVersion, 'AC1032', 'Reopened native DWG retains its AC1032 metadata source version');
    const explicitDxf = join(directory, 'explicit-dxf-copy.dxf');
    const expectedDxf = await signature();
    const dxfSourceIds = await page.evaluate(() => window.editor.doc.entities.map(entity => entity.id));
    const sourceDwg = readFileSync(working), sourceBackup = readFileSync(working + '.bak');
    await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), explicitDxf);
    assert.equal(await page.evaluate(() => window.editor.saveFile(true, 'dxf')), true, 'Explicit DXF export from DWG uses DXF Save As');
    const dxfBytes = readFileSync(explicitDxf), dxfText = dxfBytes.toString('utf8');
    assert.match(dxfText, /^0\r?\nSECTION\r?\n2\r?\nHEADER\r?\n/, 'Explicit DXF begins with a HEADER section');
    assert.match(dxfText, /\r?\n0\r?\nEOF\s*$/, 'Explicit DXF ends with the complete EOF record');
    const explicitHeaders = [...dxfText.matchAll(/^[ \t]*0[ \t]*\r?\nSECTION[ \t]*\r?\n[ \t]*2[ \t]*\r?\nHEADER[ \t]*\r?\n([\s\S]*?)^[ \t]*0[ \t]*\r?\nENDSEC[ \t]*\r?$/gm)];
    assert.equal(explicitHeaders.length, 1, 'Explicit DXF contains exactly one HEADER section');
    const explicitHeaderPairs = explicitHeaders[0][1].split(/\r?\n/);
    assert.equal(explicitHeaderPairs.pop(), '', 'Explicit DXF HEADER ends with a complete group pair');
    assert.equal(explicitHeaderPairs.length % 2, 0, 'Explicit DXF HEADER has complete group pairs');
    const explicitVersions = [];
    for (let i = 0; i < explicitHeaderPairs.length; i += 2) {
      if (explicitHeaderPairs[i].trim() === '9' && explicitHeaderPairs[i + 1].trim() === '$ACADVER') {
        assert.equal(explicitHeaderPairs[i + 2]?.trim(), '1', 'Explicit DXF $ACADVER uses native group 1');
        explicitVersions.push(explicitHeaderPairs[i + 3]?.trim());
      }
    }
    assert.deepEqual(explicitVersions, ['AC1032'], 'Explicit DXF has one exact retained HEADER.$ACADVER');
    assert.deepEqual(await page.evaluate(() => ({ path: window.editor.doc.filePath, dirty: window.editor.doc.dirty })),
      { path: explicitDxf, dirty: false }, 'DXF Save As becomes the clean working file');
    assert.equal(await page.evaluate(p => window.editor.openFile(p), explicitDxf), true, 'Explicit DXF reopens from disk through real IPC');await closeReports();
    assert.deepEqual(await page.evaluate(() => ({ schema: window.editor.doc.snapshot.cadGraph?.schema,
      format: window.editor.doc.snapshot.cadGraph?.sourceFormat, version: window.editor.doc.snapshot.cadGraph?.sourceVersion })),
      { schema: 1, format: 'DXF', version: explicitSourceVersion }, 'Fresh DXF parser retains the exact source header version');
    assert.ok(await page.evaluate(ids => window.editor.doc.entities.every(entity => !ids.includes(entity.id)), dxfSourceIds), 'DXF reopen parses fresh entities rather than showing the saved tab');
    approximate(await signature(), expectedDxf, 'Explicit DXF semantic round trip');
    assert.deepEqual(readFileSync(explicitDxf), dxfBytes, 'Fresh DXF read leaves the saved file unchanged');
    assert.deepEqual(readFileSync(working), sourceDwg, 'Explicit DXF Save As preserves the prior DWG');
    assert.deepEqual(readFileSync(working + '.bak'), sourceBackup, 'Explicit DXF Save As preserves the prior DWG backup');
    check(true, 'Normal DWG Save As and loss-free in-place Save preserve semantics and exact backups, retained page settings are kept, and explicit DXF preserves AC1032 through a fresh semantic reopen');
    // A real unsupported-data import still requires consent. The native dialog is
    // the existing E2E picker double; reader, source proof, save admission and
    // atomic DXF write remain the actual production paths on private fixture bytes.
    const lossSource = join(directory, 'loss-consent-control.dxf');
    copyFileSync(join(repo, 'tests', 'fixtures', 'unsupported-content.dxf'), lossSource);
    const originalLossSource = readFileSync(lossSource);
    await page.evaluate(() => window.editor.sessions.add());
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), lossSource);
    assert.equal(await page.evaluate(() => window.editor.openFile()), true, 'Real unsupported-data control opens');await closeReports();
    const lossImport = await importSummary();
    assert.equal(lossImport?.format, 'DXF');assert.equal(lossImport.sourcePath, lossSource);
    assert.equal(lossImport.dropped + lossImport.simplified, 6, 'Actual fixture reader reports its six remaining source losses');
    assert.equal(lossImport.counts.WIPEOUT.dropped, 1);assert.equal(lossImport.counts.MLINE.dropped, 1);
    assert.equal(lossImport.counts.REGION.dropped, 1);assert.equal(lossImport.counts['3DFACE'].dropped, 2);assert.equal(lossImport.counts.TEXT.simplified, 1);
    assert.equal(lossImport.counts.POLYLINE.kept, 1, 'The foreign polyface is retained instead of counted as dropped');
    assert.equal(lossImport.kept, 5);const originalPolyface = await lossPolyface();
    assert.equal(lossImport.counts['3DSOLID'].kept, 1, 'Safe opaque solid payload remains retained alongside the reported losses');
    await page.evaluate(() => {
      const ed = window.editor;
      ed.doc.addEntities([{ id: 'loss-consent-control-marker', type: 'line', layer: '0', color: 'ByLayer', a: { x: -43, y: -44 }, b: { x: -42, y: -41 } }]);
      /** @type {any} */ (window).__portableLossBefore = { state: ed.doc.snapshot, session: ed.sessions.activeId, history: ed.doc.history() };
    });
    assert.equal(await app.evaluate(() => globalThis.__e2e.savePaths.length), 0, 'No queued destination can accidentally accept the declined source overwrite');
    const refusedOverwrite = page.evaluate(() => window.editor.saveFile(false));
    const warning = page.locator('.modal', { hasText: 'Save over the original file?' });
    await warning.waitFor({ timeout: 10000 });
    assert.match(await warning.innerText(), /6 object\(s\) JCad cannot keep.*Save As to keep the original/s);
    assert.deepEqual(readFileSync(lossSource), originalLossSource);assert.equal(existsSync(lossSource + '.bak'), false);
    await warning.locator('button', { hasText: /^No$/ }).click();
    assert.equal(await refusedOverwrite, false, 'No uses the canceled Save As picker, without granting source-loss consent');
    assert.deepEqual(readFileSync(lossSource), originalLossSource);assert.equal(existsSync(lossSource + '.bak'), false);
    assert.equal(await page.evaluate(() => {
      const ed = window.editor, saved = /** @type {any} */ (window).__portableLossBefore, history = ed.doc.history();
      return ed.doc.snapshot === saved.state && ed.doc.dirty && ed.doc.filePath.endsWith('loss-consent-control.dxf') && ed.sessions.activeId === saved.session
        && ['undo', 'redo'].every(key => history[key].length === saved.history[key].length && history[key].every((state, index) => state === saved.history[key][index]));
    }), true, 'Declined source overwrite leaves the edited document and undo history untouched');
    assert.deepEqual((await lossPolyface()).raw, originalPolyface.raw, 'Declined source overwrite keeps every raw polyface parent/follower pair exact');
    const allowedOverwrite = page.evaluate(() => window.editor.saveFile(false));
    await warning.waitFor({ timeout: 10000 });
    assert.match(await warning.innerText(), /6 object\(s\) JCad cannot keep.*Save As to keep the original/s);
    await warning.locator('button', { hasText: /^Yes$/ }).click();
    assert.equal(await allowedOverwrite, true, 'Yes explicitly acknowledges the actual unsupported-data source loss');
    assert.deepEqual(readFileSync(lossSource + '.bak'), originalLossSource, 'Consented write keeps the exact unsupported original in its backup');
    assert.match(readFileSync(lossSource, 'utf8'), /mnnmi mi ofoo jl ofoo jl/, 'Safe opaque solid payload remains written back');
    assert.equal(await page.evaluate(() => window.editor.doc.dirty), false);
    assert.equal(await page.evaluate(p => window.editor.openFile(p), lossSource), true);await closeReports();
    const controlReopened = await importSummary();assert.ok(controlReopened);
    assert.equal(controlReopened.dropped + controlReopened.simplified, 0, 'Actual consented DXF reopens with its remaining content retained');
    assert.equal(controlReopened.counts['3DSOLID'].kept, 1);
    assert.equal(controlReopened.counts.POLYLINE.kept, 1);
    assert.deepEqual((await lossPolyface(true)).comparable, originalPolyface.comparable, 'Consented save and actual fresh reopen retain all original polyface fields/order with proven model and structural parent owners');
    check(true, 'Actual six-loss source still requires No/Yes consent; No preserves source/history and Yes preserves exact backup, raw polyface records and safe retained content');
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
      ed.switchSession(ed.sessions.indexOfId(saved.active)); delete /** @type {any} */ (window).__portableBefore; delete /** @type {any} */ (window).__portableLossBefore;
    }, beforeIds);
    await app.evaluate(() => globalThis.__e2e.messages.splice(0));
  }
}
