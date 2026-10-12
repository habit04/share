/** Rotated layouts through native desktop open/save, mouse input and PDF plot. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { parsePdfBasics, pageContents, parseContentStream } from '../tests/helpers/pdf.ts';

// Modify literal AutoCAD fixture fields, independently of JCad's viewport writer.
function sourceFixture(text) {
  const lines = text.trimEnd().split(/\r?\n/), pairs = [];
  for (let i = 0; i < lines.length; i += 2) pairs.push([Number(lines[i]), lines[i + 1]]);
  let changed = 0;
  for (let start = 0; start < pairs.length; start++) {
    if (pairs[start][0] !== 0) continue;
    let end = start + 1;
    while (end < pairs.length && pairs[end][0] !== 0) end++;
    const record = pairs.slice(start, end), handle = record.find(([code]) => code === 5)?.[1].trim();
    const fields = pairs[start][1] === 'VIEWPORT' && handle === '103' ? { 12: 0, 22: 0, 17: 10, 27: 5, 51: 90 }
      : pairs[start][1] === 'LINE' && handle === '100' ? { 10: 8, 20: 5, 11: 12, 21: 5 } : null;
    if (!fields) continue;
    for (const [code, value] of Object.entries(fields)) {
      const field = record.find(([key]) => key === Number(code)); assert.ok(field, 'Independent fixture has required group ' + code); field[1] = String(value);
    }
    changed++;
  }
  assert.equal(changed, 2, 'One native viewport and one model line are changed');
  return pairs.flat().join('\n') + '\n';
}

/** @param {{ app: import('playwright').ElectronApplication, page: import('playwright').Page, repo: string, outDir: string, check: (ok: boolean, text: string) => void, current: boolean }} opts */
export async function runViewportRotationChecks({ app, page, repo, outDir, check, current }) {
  if (!current) return;
  const directory = join(outDir, 'rotated-viewports'); mkdirSync(directory, { recursive: true });
  const source = join(directory, 'rotated-source.dxf'), dxf = join(directory, 'rotated-saved.dxf'), dwg = join(directory, 'rotated-saved.dwg');
  writeFileSync(source, sourceFixture(readFileSync(join(repo, 'tests/fixtures/acad-layouts.dxf'), 'utf8')));
  const original = readFileSync(source);
  const saved = await page.evaluate(() => {
    const ed = window.editor;
    return { ids: ed.sessions.all.map(s => s.id), active: ed.sessions.activeId, settings: ed.settings, snap: { ...ed.snap }, viewportSettings: { ...ed.viewport.settings }, paletteHidden: document.querySelector('#properties')?.classList.contains('hidden') };
  });
  const reportsClosed = async () => {
    for (let n = 0; n < 8 && await page.locator('.import-report-dialog').count(); n++) await page.locator('.import-report-dialog .modal-footer button').filter({ hasText: /^Close$/ }).first().click();
    assert.equal(await page.locator('.modal').count(), 0);
  };
  const signature = () => page.evaluate(() => {
    const ed = window.editor, state = ed.doc.snapshot, layout = ed.doc.layouts.find(l => l.viewports.length);
    return { models: state.entities.map(e => ({ type: e.type, ...(e.type === 'line' ? { a: e.a, b: e.b } : { center: e.center, radius: e.radius }) })), view: layout.viewports[0].view };
  });
  const near = (value, wanted, label) => assert.ok(Number.isFinite(value) && Math.abs(value - wanted) < 1e-7, `${label}: ${value} vs ${wanted}`);
  const same = (value, wanted) => {
    assert.deepEqual(value.models, wanted.models, 'Model coordinates stay intact after fresh parse');
    near(value.view.center.x, wanted.view.center.x, 'WCS view center X'); near(value.view.center.y, wanted.view.center.y, 'WCS view center Y');
    near(value.view.scale, wanted.view.scale, 'View scale'); near(value.view.twist, wanted.view.twist, 'View twist');
  };
  const canvas = page.locator('#drawing');
  const screenLine = () => page.evaluate(() => {
    const ed = window.editor, line = ed.doc.snapshot.entities.find(e => e.type === 'line'), rect = ed.viewport.canvas.getBoundingClientRect();
    const screen = p => { const q = ed.viewport.toScreen(p); return { x: rect.left + q.x, y: rect.top + q.y }; };
    return { a: screen(line.a), b: screen(line.b), id: line.id };
  });
  try {
    await page.evaluate(() => window.editor.sessions.add());
    await app.evaluate((_e, p) => globalThis.__e2e.openPaths.push(p), source);
    assert.equal(await page.evaluate(() => window.editor.openFile()), true); await reportsClosed();
    const imported = await signature(); near(imported.view.twist, Math.PI / 2, 'Imported degrees become radians');
    assert.deepEqual(imported.view.center, { x: 10, y: 5 }); near(imported.view.scale, 0.5, 'Native viewport scale');
    assert.deepEqual(imported.models[0], { type: 'line', a: { x: 8, y: 5 }, b: { x: 12, y: 5 } });
    await page.locator('#layout-tabs .layout-tab', { hasText: 'Layout1' }).click();
    await page.evaluate(() => {
      const ed = window.editor; ed.cancel(); ed.selection.clear(); ed.snap.osnap = false; ed.snap.gridSnap = false; ed.snap.ortho = false; ed.snap.polar = false; ed.snap.otrack = false;
      ed.viewport.settings.gridVisible = false; ed.render();
    });
    const center = await page.evaluate(() => {
      const ed = window.editor, v = ed.doc.layouts.find(l => l.viewports.length).viewports[0], p = ed.viewport.toScreen(v.center), r = ed.viewport.canvas.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    });
    await page.mouse.dblclick(center.x + 16, center.y + 16);
    assert.ok(await page.evaluate(() => window.editor.doc.space?.viewport), 'Real double click enters the viewport');
    let line = await screenLine(); near(line.a.x, line.b.x, 'Quarter turn renders a vertical model line'); assert.ok(line.b.y < line.a.y, 'Positive world X points up after +90 degrees');
    await page.mouse.move(1, 1);
    const pixels = await page.evaluate(async () => {
      const ed = window.editor, vp = ed.viewport; ed.selection.clear(); ed.render();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const ctx = vp.canvas.getContext('2d'), sample = p => {
        const s = vp.toScreen(p), rgba = ctx.getImageData(Math.round(s.x * vp.dpr) - 2, Math.round(s.y * vp.dpr) - 2, 5, 5).data;
        return Math.min(...Array.from({ length: 25 }, (_, i) => rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2]));
      };
      return { ink: sample({ x: 11.5, y: 5 }), blank: sample({ x: 11.5, y: 5.8 }) };
    });
    assert.ok(pixels.blank - pixels.ink > 80, 'Actual rotated canvas has ink at the expected projected line');
    await canvas.screenshot({ path: join(directory, 'quarter-turn.png') });
    await page.mouse.click(line.b.x, line.b.y);
    assert.deepEqual(await page.evaluate(() => [...window.editor.selection]), [line.id], 'Point pick ignores the coincident viewport-frozen circle');
    await page.evaluate(() => { window.editor.selection.clear(); window.editor.doc.setSpace({ layout: 'Layout1' }); });
    const pdfPath = join(directory, 'quarter-turn.pdf');
    await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), pdfPath);
    await page.evaluate(() => void window.editor.runCommand('PLOT'));
    const plot = page.locator('.modal', { hasText: 'Page setup' }); await plot.waitFor(); await plot.locator('select').first().selectOption('vector');
    await plot.locator('button', { hasText: 'Plot to PDF' }).click();
    await page.waitForFunction(p => window.editor.history.some(h => h.startsWith('Plotted to ' + p)), pdfPath, { timeout: 30000 });
    const pdf = parsePdfBasics(new Uint8Array(readFileSync(pdfPath))), content = parseContentStream(pageContents(pdf, b => new Uint8Array(inflateSync(b)))[0] ?? '');
    assert.deepEqual(pdf.errors, []); assert.deepEqual(content.errors, []);
    assert.ok(content.ops.some((op, i) => op.op === 'l' && content.ops[i - 1]?.op === 'm' && Math.abs(Number(op.args[0]) - Number(content.ops[i - 1].args[0])) < 0.001 && Math.abs(Math.abs(Number(op.args[1]) - Number(content.ops[i - 1].args[1])) - 144) < 0.1), 'Actual plot contains the model line rotated 90 degrees at its 1:2 viewport scale');
    check(true, 'Rotated viewport native DXF: 90-degree canvas pixels, double-click MSPACE, frozen-layer point selection and vector PDF orientation');
    await page.evaluate(() => { const ed = window.editor, v = ed.doc.layouts[0].viewports[0]; ed.doc.setSpace({ layout: 'Layout1', viewport: v.id }); ed.runCommand('VPTWIST 30'); ed.selection.clear(); });
    near((await signature()).view.twist, Math.PI / 6, 'Oblique angle command'); line = await screenLine();
    const dx = line.b.x - line.a.x, dy = line.b.y - line.a.y; near(-dy / dx, Math.tan(Math.PI / 6), 'Oblique screen orientation');
    await page.mouse.move(Math.min(line.a.x, line.b.x) - 10, Math.min(line.a.y, line.b.y) - 10); await page.mouse.down();
    await page.mouse.move(Math.max(line.a.x, line.b.x) + 10, Math.max(line.a.y, line.b.y) + 10, { steps: 8 }); await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => [...window.editor.selection]), [line.id], 'A screen-aligned window selects through the rotated view');
    await page.evaluate(() => { const ed = window.editor; ed.selection.clear(); ed.runCommand('LINE'); ed.submitInput('13,6'); ed.submitInput('15,6'); ed.cancel(); });
    assert.deepEqual(await page.evaluate(() => { const e = window.editor.doc.snapshot.entities.at(-1); return { a: e.a, b: e.b }; }), { a: { x: 13, y: 6 }, b: { x: 15, y: 6 } }, 'Typed drafting points remain WCS');
    await page.evaluate(() => { window.editor.doc.undo(); window.editor.cancel(); });
    const zoom = await page.evaluate(() => {
      const ed = window.editor, vp = ed.viewport, s = vp.toScreen({ x: 11, y: 5 }), before = vp.toWorld(s);
      vp.zoomAt(s, 1.3); ed.notify('view'); return { before, after: vp.toWorld(s) };
    });
    near(zoom.after.x, zoom.before.x, 'Zoom anchor X'); near(zoom.after.y, zoom.before.y, 'Zoom anchor Y');
    const expected = await signature(); assert.deepEqual(expected.models, imported.models);
    await page.evaluate(() => { window.editor.doc.setSpace({ layout: 'Layout1' }); window.editor.render(); });
    await canvas.screenshot({ path: join(directory, 'oblique.png') });
    await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), dxf);
    assert.equal(await page.evaluate(() => window.editor.saveFile(true, 'dxf')), true);
    const dxfIds = await page.evaluate(() => window.editor.doc.snapshot.entities.map(e => e.id));
    assert.equal(await page.evaluate(p => window.editor.openFile(p), dxf), true); await reportsClosed(); same(await signature(), expected);
    assert.ok(await page.evaluate(ids => window.editor.doc.snapshot.entities.every(e => !ids.includes(e.id)), dxfIds), 'DXF reopen parses fresh entities rather than showing an existing tab');
    assert.deepEqual(readFileSync(source), original, 'Source AutoCAD fixture remains intact');
    check(true, 'Rotated viewport 30 degrees: real Window selection, WCS drafting, anchored zoom and native DXF save/fresh reopen preserve model coordinates');
    if (process.platform === 'win32') {
      await app.evaluate((_e, p) => globalThis.__e2e.savePaths.push(p), dwg);
      assert.equal(await page.evaluate(() => window.editor.saveFile(true)), true);
      const previous = readFileSync(dwg); assert.equal(previous.subarray(0, 6).toString(), 'AC1032');
      assert.equal(await page.evaluate(() => window.editor.saveFile(false)), true);
      assert.deepEqual(readFileSync(dwg + '.bak'), previous, 'DWG backup holds exact prior rotated file');
      const dwgIds = await page.evaluate(() => window.editor.doc.snapshot.entities.map(e => e.id));
      assert.equal(await page.evaluate(p => window.editor.openFile(p), dwg), true); await reportsClosed(); same(await signature(), expected);
      assert.ok(await page.evaluate(ids => window.editor.doc.snapshot.entities.every(e => !ids.includes(e.id)), dwgIds), 'DWG reopen parses fresh entities rather than showing an existing tab');
      check(true, 'Rotated viewport Windows DWG normal Save As, Save, exact backup and real isolated-reader fresh reopen retain twist, WCS view center and unchanged model geometry');
    }
  } finally {
    await page.evaluate(saved => {
      const ed = window.editor; ed.cancel();
      for (let i = ed.sessions.count - 1; i >= 0; i--) if (!saved.ids.includes(ed.sessions.all[i].id)) ed.sessions.close(i);
      ed.switchSession(ed.sessions.indexOfId(saved.active)); ed.settings = saved.settings; Object.assign(ed.snap, saved.snap); ed.viewport.settings = saved.viewportSettings;
      document.querySelector('#properties')?.classList.toggle('hidden', !!saved.paletteHidden); ed.render();
    }, saved);
    await app.evaluate(() => globalThis.__e2e.messages.splice(0));
  }
}
