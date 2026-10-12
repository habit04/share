/** Five independent CAD format fixtures through the real desktop open/save bridge.
 * Reuses the existing Electron harness; no application launch or fuse mutation here. */
import assert from 'node:assert/strict';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { verifyNativeRuntime } from './vendor-native-runtime.mjs';

const CASES = [
  { kind: 'arrays', file: 'interchange/r2018-minsert.dxf' },
  { kind: 'widths', file: 'polyline-widths.dxf' },
  { kind: 'text', file: 'interchange/r2000-text-justification.dxf' },
  { kind: 'appearance', file: 'interchange/r2010-appearance.dxf' },
  { kind: 'backgrounds', file: 'interchange/r2018-mtext-background.dxf' },
];

/**
 * @param {{app: import('playwright').ElectronApplication, page: import('playwright').Page, repo: string, outDir: string, check: (ok: boolean, message: string) => void, packaged?: boolean}} options
 */
export async function runCadFidelity({ app, page, repo, outDir, check, packaged = false }) {
  function records(text) {
    const lines = text.trimEnd().split(/\r?\n/); assert.equal(lines.length % 2, 0, 'Saved DXF has complete code/value pairs');
    const out = []; let object;
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i].trim(), /^\d+$/, 'Saved DXF has integer group codes');
      const code = Number(lines[i]), value = lines[i + 1];
      if (code === 0) { if (object) out.push(object); object = { kind: value.trim(), groups: [] }; }
      else if (object) object.groups.push([code, value]);
    }
    if (object) out.push(object); return out;
  }
  const group = (object, code, fallback) => object.groups.find(([key]) => key === code)?.[1] ?? fallback;
  const number = (object, code, fallback) => Number(group(object, code, fallback));
  function approximately(actual, expected, label) {
    if (typeof actual === 'number' && typeof expected === 'number') { assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-6 * Math.max(1, Math.abs(expected)), `${label}: ${actual} differs from ${expected}`); return; }
    if (Array.isArray(actual) && Array.isArray(expected)) { assert.equal(actual.length, expected.length, `${label}: array length`); actual.forEach((value, i) => approximately(value, expected[i], `${label}[${i}]`)); return; }
    if (actual && expected && typeof actual === 'object' && typeof expected === 'object') { assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: keys`); for (const key of Object.keys(expected)) approximately(actual[key], expected[key], `${label}.${key}`); return; }
    assert.deepEqual(actual, expected, label);
  }
  async function reportsClosed() {
    for (let i = 0; i < 6 && await page.locator('.import-report-dialog').count(); i += 1) await page.locator('.import-report-dialog .modal-footer button').filter({ hasText: /^Close$/ }).first().click();
    assert.equal(await page.locator('.modal').count(), 0, 'Only expected import reports may be dismissed');
  }
  async function openChosen(file) {
    await app.evaluate((_electron, file) => globalThis.__e2e.openPaths.push(file), file);
    assert.equal(await operation('native open', () => page.evaluate(() => window.editor.openFile())), true, 'Native chosen DXF opens');
    await reportsClosed();
  }
  async function inspect() {
    return page.evaluate(() => {
      const w = /** @type {any} */ (window), ed = w.editor, api = w.jcadApi;
      const entities = JSON.parse(JSON.stringify(ed.doc.entities));
      const keys = ['type', 'layer', 'color', 'trueColor', 'colorName', 'a', 'b', 'points', 'closed', 'bulges', 'width', 'widths', 'position', 'text', 'raw', 'height', 'widthFactor', 'rotation', 'align', 'justification', 'alignmentPoint', 'firstAlignmentPoint', 'block', 'scale', 'scaleY', 'mirror', 'attributes', 'hiddenAttributes', 'columns', 'rows', 'columnSpacing', 'rowSpacing', 'attachment', 'lineSpacing', 'background'];
      const pick = (entity) => {
        const result = Object.fromEntries(keys.filter((key) => entity[key] !== undefined).map((key) => [key, entity[key]]));
        result.transparency = entity.transparency ?? 'ByLayer';
        if (entity.attributePlacements) {
          result.attributePlacements = Object.fromEntries(Object.entries(entity.attributePlacements).map(([tag, source]) => {
            const fields = ['position', 'height', 'rotation', 'align', 'widthFactor', 'oblique', 'justification', 'alignmentPoint', 'firstAlignmentPoint', 'trueColor', 'colorName'];
            const placement = Object.fromEntries(fields.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
            placement.color = source.color ?? 'ByLayer'; placement.transparency = source.transparency ?? 'ByLayer';
            placement.rotation = source.rotation ?? 0; placement.widthFactor = source.widthFactor ?? 1; placement.oblique = source.oblique ?? 0;
            placement.style = source.style ?? 'Standard';
            // An omitted per-insert layer uses the application's conventional attribute
            // layer; an explicit layer, including native layer0, remains authoritative.
            placement.layer = source.layer ?? (/^TAG/i.test(tag) ? 'TAGS' : /^DESC/i.test(tag) ? 'DESC' : /^TERM/i.test(tag) ? 'TERMS' : entity.layer);
            return [tag, placement];
          }));
        }
        return result;
      };
      const pending = entities.filter((e) => e.type === 'insert').map((e) => e.block), visited = new Set(), blocks = {};
      while (pending.length) {
        const name = pending.pop(); if (visited.has(name)) continue; visited.add(name);
        if (visited.size > 64) throw new Error('Fixture block walk exceeds the probe budget');
        const definition = ed.doc.snapshot.blocks[name]; if (!definition) continue;
        blocks[name] = { basePoint: definition.basePoint, entities: definition.entities.map(pick), attributes: definition.attributes.map((a) => ({ tag: a.tag, default: a.default, ...pick({ ...a, layer: a.layer ?? '0', color: a.color ?? 'ByLayer', rotation: a.rotation ?? 0, widthFactor: a.widthFactor ?? 1 }), oblique: a.oblique ?? 0, style: a.style ?? 'Standard' })) };
        for (const entity of definition.entities) if (entity.type === 'insert') pending.push(entity.block);
      }
      const items = ed.doc.snapshot.meta?.importReport?.items ?? [];
      return { entities, signature: { entities: entities.map(pick), blocks, layers: ed.doc.layers.filter((layer) => layer.colorName !== undefined || layer.transparency !== undefined).map((layer) => ({ name: layer.name, color: layer.color, trueColor: layer.trueColor, colorName: layer.colorName, transparency: layer.transparency })) }, bounds: entities.map((e) => api.geometry.bounds([e.id])), extents: ed.doc.extents(), dirty: ed.doc.dirty, reportReasons: items.map((item) => item.reason) };
    });
  }
  async function raster(points = [], underlayBoxes = []) {
    return page.evaluate(async ({ points, underlayBoxes }) => {
      const ed = window.editor, vp = ed.viewport;
      ed.selection.clear(); ed.notify('selection'); vp.settings.gridVisible = false; vp.settings.background = '#212830';
      // Paint a probe-only green underlay before the real entity pass. A WINDOW mask must
      // cover it with the drawing background; FRAME/OFF/gutter locations must leave it visible.
      // This public view hook does not mutate the drawing or its saved fixture content.
      vp.underlay = underlayBoxes.length ? (ctx, viewport) => {
        ctx.save(); ctx.fillStyle = '#00ff00';
        for (const box of underlayBoxes) { const a = viewport.toScreen({ x: box.x, y: box.y + box.h }), b = viewport.toScreen({ x: box.x + box.w, y: box.y }); ctx.fillRect(a.x, a.y, b.x - a.x, b.y - a.y); }
        ctx.restore();
      } : null;
      ed.zoomExtents(); ed.render();
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const canvas = vp.canvas, ctx = canvas.getContext('2d');
      if (!canvas.width || !canvas.height || canvas.width * canvas.height > 4_000_000) throw new Error('Canvas exceeds bounded probe image size');
      const bg = [33, 40, 48], image = ctx.getImageData(0, 0, canvas.width, canvas.height); let changed = 0;
      for (let i = 0; i < image.data.length; i += 4) if (bg.some((value, channel) => Math.abs(image.data[i + channel] - value) > 3)) changed += 1;
      const samples = points.map((point) => {
        const screen = vp.toScreen(point), x = Math.round(screen.x * vp.dpr), y = Math.round(screen.y * vp.dpr);
        if (x < 1 || y < 1 || x >= canvas.width - 1 || y >= canvas.height - 1) throw new Error('Probe sample is outside the rendered canvas');
        const patch = ctx.getImageData(x - 1, y - 1, 3, 3).data; let delta = 0;
        for (let i = 0; i < patch.length; i += 4) delta = Math.max(delta, ...bg.map((value, channel) => Math.abs(patch[i + channel] - value)));
        return { delta, center: Array.from(ctx.getImageData(x, y, 1, 1).data) };
      });
      return { changed, width: canvas.width, height: canvas.height, samples };
    }, { points, underlayBoxes });
  }
  function liveExpectations(kind, live) {
    assert.ok(live.entities.length > 0 && live.extents, `${kind}: drawing content/extents`);
    for (const bounds of live.bounds) if (bounds) assert.ok([bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y].every(Number.isFinite), `${kind}: finite public geometry bounds`);
    assert.ok(!live.reportReasons.some((reason) => /per-vertex polyline widths are not kept|MINSERT.*only the first copy|transparency.*not kept|background fill is not kept/.test(reason)), `${kind}: feature must not carry an obsolete data-loss warning`);
    if (kind === 'arrays') {
      const i = live.entities.findIndex((e) => e.type === 'insert' && e.columns === 3 && e.rows === 2); assert.ok(i >= 0, 'Native 3×2 array loaded');
      assert.equal(live.entities[i].columnSpacing, 7); assert.equal(live.entities[i].rowSpacing, 11);
      approximately(live.bounds[i], { min: { x: -1, y: 20 }, max: { x: 10, y: 36 } }, 'Native array footprint');
    } else if (kind === 'widths') {
      const poly = live.entities.find((e) => e.type === 'polyline' && e.points.length === 3);
      assert.deepEqual(poly?.widths, [{ start: 0, end: 4 }, { start: 4, end: 2 }, { start: 7, end: 9 }]); assert.deepEqual(poly.bulges, [0, 1, 0]); assert.equal(poly.width, undefined);
      assert.ok(live.entities.some((e) => e.type === 'polyline' && JSON.stringify(e.widths) === JSON.stringify([{ start: 2, end: 3 }, { start: 0, end: 6 }])));
    } else if (kind === 'text') {
      const find = (text) => live.entities.find((e) => e.type === 'text' && e.text === text);
      assert.deepEqual(find('FIT')?.justification, { horizontal: 5, vertical: 0 }); assert.deepEqual(find('FIT').alignmentPoint, { x: 0, y: 10 });
      assert.deepEqual(find('TOP AT ORIGIN')?.alignmentPoint, { x: 0, y: 0 }); assert.deepEqual(find('TOP AT ORIGIN').firstAlignmentPoint, { x: 999, y: 999 });
      const index = live.entities.indexOf(find('TOP AT ORIGIN')); approximately(live.bounds[index].min.y, -2, 'Top text lower bound'); approximately(live.bounds[index].max.y, 0, 'Top text upper bound');
      const insert = live.entities.find((e) => e.type === 'insert' && e.attributes.TAG1 === 'OVERRIDE'); assert.ok(insert?.attributePlacements?.TAG1); assert.deepEqual(insert.attributePlacements.TAG1.justification, { horizontal: 2, vertical: 3 });
    } else if (kind === 'appearance') {
      assert.ok(live.entities.some((e) => e.colorName === 'Studio Book$Pearl Δ' && e.trueColor === 0xabcdef && e.transparency === 127));
      assert.ok(live.signature.layers.some((layer) => layer.name === 'RICH' && layer.colorName === 'Studio Book$Teal 雷' && layer.transparency === 64));
      assert.ok(live.entities.some((e) => e.transparency === 0)); assert.ok(live.entities.some((e) => e.transparency === 255));
    } else {
      const notes = live.entities.filter((e) => e.type === 'mtext'), find = (text) => notes.find((e) => e.text.startsWith(text));
      assert.equal(notes.length, 7, 'Seven independent native MTEXT cases');
      const backgrounds = notes.filter((e) => e.background).map((e) => e.background);
      assert.ok(backgrounds.some((b) => (b.flags & 1) !== 0), 'Explicit MTEXT fill loaded'); assert.ok(backgrounds.some((b) => (b.flags & 2) !== 0), 'Drawing background fill loaded'); assert.ok(backgrounds.some((b) => (b.flags & 16) !== 0), 'MTEXT frame loaded');
      assert.ok(backgrounds.every((b) => Number.isFinite(b.scale) && b.scale >= 1), 'Finite native padding scale');
      assert.deepEqual(find('ACI MASK').background, { flags: 1, scale: 1.5, color: 1 });
      assert.deepEqual(find('RGB').background, { flags: 1, scale: 2, color: 3, trueColor: 0x123456, colorName: 'Example Book$Slate', transparency: 0 });
      approximately(find('RGB').rotation, Math.PI / 2, 'Rotated native RGB mask');
      assert.equal(find('WINDOW').background.flags, 3); assert.equal(find('FRAME').background.flags, 16); assert.equal(find('OFF').background.flags, 0);
      assert.equal(find('FILL + FRAME').background.flags, 17); assert.equal(find('FILL + FRAME').background.scale, 1.25);
      assert.equal(find('COLUMN').columns.count, 2); assert.equal(find('COLUMN').columns.width, 6); assert.equal(find('COLUMN').columns.gutter, 3);
      const aciBounds = live.bounds[live.entities.indexOf(find('ACI MASK'))]; approximately(aciBounds.min, { x: -1, y: -3 }, 'ACI padded mask lower bounds'); approximately(aciBounds.max.y, 1, 'ACI padded mask upper bound');
    }
  }
  function nativeExpectations(kind, text) {
    const all = records(text); const of = (kind) => all.filter((o) => o.kind === kind);
    if (kind === 'arrays') { const e = of('INSERT').find((o) => number(o, 70, 1) === 3 && number(o, 71, 1) === 2); assert.ok(e); assert.equal(number(e, 44), 7); assert.equal(number(e, 45), 11); }
    if (kind === 'widths') { const e = of('LWPOLYLINE').find((o) => number(o, 90) === 3); assert.ok(e); assert.deepEqual(e.groups.filter(([code]) => code === 40 || code === 41).map(([code, value]) => [code, Number(value)]), [[40, 0], [41, 4], [40, 4], [41, 2], [40, 7], [41, 9]]); assert.equal(group(e, 43), undefined); }
    if (kind === 'text') {
      const fit = of('TEXT').find((o) => group(o, 1) === 'FIT'); assert.ok(fit); assert.equal(number(fit, 72), 5); assert.equal(number(fit, 73, 0), 0); assert.equal(number(fit, 11), 0); assert.equal(number(fit, 21), 10);
      const attr = of('ATTRIB').find((o) => group(o, 1) === 'OVERRIDE'); assert.ok(attr); assert.equal(number(attr, 72), 2); assert.equal(number(attr, 74), 3); assert.equal(number(attr, 11), 120); assert.equal(number(attr, 21), 130);
    }
    if (kind === 'appearance') { assert.match(text, /\$ACADVER\r?\n\s*1\r?\nAC1024/); assert.ok(all.some((o) => group(o, 430) === 'Studio Book$Pearl Δ' && number(o, 420) === 0xabcdef && number(o, 440) === 0x0200007f)); assert.ok(all.some((o) => o.groups.some(([code, value]) => code === 1001 && value === 'AcCmTransparency') && number(o, 1071) === 0x02000040)); }
    if (kind === 'backgrounds') {
      assert.match(text, /\$ACADVER\r?\n\s*1\r?\nAC1032/); const items = of('MTEXT'), find = (text) => items.find((o) => group(o, 1, '').startsWith(text));
      const rgb = find('RGB'); assert.ok(rgb); assert.deepEqual([90, 45, 63, 421, 431, 441].map((code) => group(rgb, code)), ['1', '2', '3', '1193046', 'Example Book$Slate', '0']);
      assert.equal(number(find('ACI MASK'), 90), 1); assert.equal(number(find('ACI MASK'), 63), 1);
      assert.equal(number(find('WINDOW'), 90), 3); assert.equal(number(find('FRAME'), 90), 16); assert.equal(number(find('FILL + FRAME'), 90), 17); assert.equal(number(find('OFF'), 90), 0);
      assert.equal(number(find('FRAME'), 45), 1.5, 'Frame-only export retains required inert native padding');
      assert.equal(number(find('FRAME'), 63), 256, 'Frame-only export retains required inert ByLayer color');
      for (const code of [421, 431, 441]) assert.equal(group(find('FRAME'), code), undefined, 'Frame-only export does not invent unspecified RGB/name/transparency');
      const off = find('OFF');
      for (const code of [45, 63, 421, 431, 441]) assert.equal(group(off, code), undefined, 'Disabled background omits invalid inactive native fields');
      assert.ok(of('APPID').some((o) => group(o, 2) === 'JCAD_MTEXT_BACKGROUND'), 'Inactive background metadata application is registered');
      const chunks = []; let active = false;
      for (const [code, value] of off.groups) {
        if (code === 1001) active = value === 'JCAD_MTEXT_BACKGROUND';
        else if (active) { assert.equal(code, 1000, 'Inactive background metadata uses only bounded string chunks'); chunks.push(value); }
      }
      assert.ok(chunks.length > 0 && chunks.length <= 64 && Buffer.byteLength(chunks.join(''), 'utf8') <= 4096, 'Inactive background settings metadata is present and bounded');
      assert.deepEqual(JSON.parse(chunks.join('')), { version: 1, flags: 0, scale: 1.5, color: 1 }, 'Inactive settings survive in native-safe metadata');
    }
  }
  function backgroundRasterExpectations(rendered) {
    const rgb = (index, expected, label) => rendered.samples[index].center.slice(0, 3).forEach((value, channel) => assert.ok(Math.abs(value - expected[channel]) <= 3, `${label}: actual ${rendered.samples[index].center.slice(0, 3)} versus ${expected}`));
    rgb(0, [255, 0, 0], 'ACI padding masks the real blue line beneath it');
    rgb(1, [18, 52, 86], 'Rotated multiline mask keeps explicit RGB independently of white text');
    rgb(2, [33, 40, 48], 'Window-color mask covers the green underlay with the drawing background');
    rgb(3, [0, 255, 0], 'Frame-only interior is not filled');
    assert.ok(rendered.samples[4].delta > 10, 'Frame border is visible');
    rgb(5, [0, 255, 0], 'Flag-zero MTEXT does not mask its underlay');
    rgb(6, [0, 255, 0], 'Explicit column masks leave the gutter uncovered');
    rgb(7, [0, 255, 255], 'Combined fill/frame retains the explicit cyan padding');
  }
  async function arrayProperties(live) {
    const array = live.entities.find((e) => e.type === 'insert' && e.columns === 3 && e.rows === 2);
    await page.evaluate((id) => { const ed = window.editor; ed.selection = new Set([id]); ed.notify('selection'); if (document.querySelector('#properties')?.classList.contains('hidden')) ed.runCommand('PROPERTIES'); }, array.id);
    const palette = page.locator('#properties'); await palette.waitFor({ state: 'visible' });
    const rows = palette.locator('.prop-row').filter({ has: page.locator('.prop-label', { hasText: /^Rows$/ }) }).locator('input');
    assert.equal(Number(await rows.inputValue()), 2); await rows.fill('3'); await rows.dispatchEvent('change');
    await page.waitForFunction((id) => window.editor.doc.entities.find((e) => e.id === id)?.rows === 3, array.id);
    const changed = await inspect(); const index = changed.entities.findIndex((e) => e.id === array.id); approximately(changed.bounds[index].min.x, -12, 'Array property edited footprint'); assert.equal(changed.dirty, true);
    assert.equal(await page.evaluate(() => /** @type {any} */ (window).jcadApi.document.undo()), true, 'Array property change is undoable');
    approximately((await inspect()).signature, live.signature, 'Undo restores all native array metadata');
    assert.equal(await page.evaluate(() => /** @type {any} */ (window).jcadApi.document.redo()), true, 'Array property change is redoable');
    assert.equal((await inspect()).entities.find((e) => e.id === array.id).rows, 3);
    assert.equal(await page.evaluate(() => /** @type {any} */ (window).jcadApi.document.undo()), true);
    await page.evaluate(() => { const ed = window.editor; ed.selection.clear(); ed.notify('selection'); if (!document.querySelector('#properties')?.classList.contains('hidden')) ed.runCommand('PROPERTIES'); });
  }
  async function colorProperties(live) {
    const named = live.entities.find((e) => e.trueColor === 0xabcdef && e.colorName === 'Studio Book$Pearl Δ');
    assert.ok(named, 'Named RGB source required for the color property regression');
    await page.evaluate((id) => { const ed = window.editor; ed.selection = new Set([id]); ed.notify('selection'); if (document.querySelector('#properties')?.classList.contains('hidden')) ed.runCommand('PROPERTIES'); }, named.id);
    const palette = page.locator('#properties'); await palette.waitFor({ state: 'visible' });
    await palette.locator('.prop-row').filter({ has: page.locator('.prop-label', { hasText: /^Color$/ }) }).locator('select').selectOption('3');
    const changed = await page.evaluate((id) => window.editor.doc.entities.find((e) => e.id === id), named.id);
    assert.equal(changed.color, 3); assert.equal(changed.trueColor, undefined); assert.equal(changed.colorName, undefined); assert.equal(changed.colorLayer, undefined);
    assert.equal(changed.transparency, 127, 'Changing RGB to ACI preserves independent alpha');
    assert.equal(await page.evaluate(() => /** @type {any} */ (window).jcadApi.document.undo()), true, 'Color property change is undoable');
    approximately((await inspect()).signature, live.signature, 'Undo restores independent RGB/name/alpha');
    assert.equal(await page.evaluate(() => /** @type {any} */ (window).jcadApi.document.redo()), true, 'Color property change is redoable');
    const redone = await page.evaluate((id) => window.editor.doc.entities.find((e) => e.id === id), named.id);
    assert.equal(redone.color, 3); assert.equal(redone.trueColor, undefined); assert.equal(redone.colorName, undefined);
    assert.equal(await page.evaluate(() => /** @type {any} */ (window).jcadApi.document.undo()), true);
    await page.evaluate(() => { const ed = window.editor; ed.selection.clear(); ed.notify('selection'); if (!document.querySelector('#properties')?.classList.contains('hidden')) ed.runCommand('PROPERTIES'); });
  }
  

  if (packaged) {
    const appPath = await app.evaluate(({ app }) => app.getAppPath());
    // Read with the builder's installed ASAR reader in the Node harness, keeping
    // Playwright main callbacks independent of CommonJS globals.
    const asar = appPath.endsWith('.asar') ? await import('@electron/asar') : null;
    const metadataBytes = asar ? asar.extractFile(appPath, 'package.json') : readFileSync(join(appPath, 'package.json'));
    assert.ok(metadataBytes.length < 1024 * 1024, 'Packaged metadata exceeds the test budget');
    const metadata = JSON.parse(metadataBytes.toString('utf8'));
    if (metadata.jcadTestBuild !== true) { check(true, 'CAD fidelity: legacy packaged run predates the dedicated test ASAR'); return; }
    const unpackedRoot = asar ? appPath + '.unpacked' : appPath;
    const scripts = join(unpackedRoot, 'scripts');
    for (const name of ['dwg-reader.mjs', 'dwg-worker.mjs', 'dwg-array-conversion.mjs', 'dwg-mtext-background.mjs']) assert.ok(lstatSync(join(scripts, name)).isFile(), 'Packaged DWG helpers must be unpacked regular files');
    const reader = readFileSync(join(scripts, 'dwg-reader.mjs'), 'utf8');
    assert.ok(reader.includes('convertDwgDatabase') && reader.includes('convertDwgMTextDatabase'), 'Packaged reader must compose both adapters');
    assert.ok(reader.includes('../vendor/libredwg-web-bg/factory/libredwg-web.js') && reader.includes('../vendor/libredwg-web-bg/factory/libredwg-web.wasm'), 'Packaged real reader must load the matching repaired native pair');
    const supportBytes = asar ? asar.extractFile(appPath, 'electron/support.json') : readFileSync(join(appPath, 'electron/support.json'));
    assert.ok(supportBytes.length > 0 && supportBytes.length <= 8192, 'Packaged support configuration is bounded');
    assert.deepEqual(supportBytes, readFileSync(join(repo, 'electron/support.json')), 'Packaged native mailto authorization uses the exact shared support JSON');
    const vendor = join(unpackedRoot, 'vendor', 'libredwg-web-bg');
    const fixture = join(repo, 'tests', 'fixtures', 'interchange', 'r2018-mtext-background.dwg');
    const expected = join(repo, 'tests', 'fixtures', 'interchange', 'r2018-mtext-background.expected.json');
    // This verifier only inspects bytes; the real worker/reader remains exercised by the
    // surrounding desktop suite. It checks every recorded asset, including source/license,
    // the matching factory/WASM hashes, checked patches and independent fixture evidence.
    const verified = await verifyNativeRuntime(vendor, fixture, expected);
    /** @type {Array<[string, number]>} */
    const provenanceFiles = [['provenance.json', 512 * 1024], ['SHA256SUMS', 16 * 1024]];
    for (const [name, maximum] of provenanceFiles) {
      const packagedFile = join(vendor, name), sourceFile = join(repo, 'vendor', 'libredwg-web-bg', name);
      const info = lstatSync(packagedFile);
      assert.ok(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= maximum, 'Packaged native provenance is a bounded regular file');
      assert.deepEqual(readFileSync(packagedFile), readFileSync(sourceFile), 'Packaged native artifact is bound to this exact source checkout: ' + name);
    }
    assert.equal(JSON.parse(supportBytes.toString('utf8')).email, 'Justinrod04@gmail.com', 'Packaged support recipient');
    check(true, 'CAD fidelity packaged preflight: exact support JSON and verified native pair/source/license/provenance (' + verified.factorySha256.slice(0, 12) + '/' + verified.wasmSha256.slice(0, 12) + ')');
  }
  for (const item of CASES) { const info = lstatSync(join(repo, 'tests', 'fixtures', item.file)); assert.ok(info.isFile() && info.size > 0 && info.size < 8 * 1024 * 1024, item.kind + ': mandatory independent fixture'); }
  mkdirSync(outDir, { recursive: true });
  const parent = realpathSync.native(outDir), workspace = mkdtempSync(join(parent, 'cad-fidelity-'));
  let timer, timedOut = false, succeeded = false;
  const operation = async (label, work) => { assert.ok(!timedOut, label + ': section deadline expired'); return work(); };
  await page.evaluate(() => {
    const w = /** @type {any} */ (window), ed = w.editor, vp = ed.viewport;
    if (w.__cadFidelitySaved) throw new Error('CAD fidelity helper cannot run reentrantly');
    w.__cadFidelitySaved = { id: ed.sessions.current.id, ids: ed.sessions.all.map((s) => s.id), snapshot: ed.doc.snapshot, path: ed.doc.filePath, dirty: ed.doc.dirty, history: ed.doc.history(), settings: ed.settings, viewportSettings: { ...vp.settings }, view: { center: { ...vp.center }, scale: vp.scale }, underlay: vp.underlay, paletteVisible: !document.querySelector('#properties')?.classList.contains('hidden') };
    ed.sessions.add();
  });
  const exercise = async () => {
    for (const item of CASES) {
      const source = join(workspace, item.kind + '-source.dxf'), saved = join(workspace, item.kind + '-saved.dxf');
      copyFileSync(join(repo, 'tests', 'fixtures', item.file), source); const original = readFileSync(source);
      await openChosen(source); const before = await inspect(); liveExpectations(item.kind, before);
      const points = item.kind === 'widths' ? [{ x: 9, y: 1 }, { x: 1, y: 1 }] : item.kind === 'arrays' ? [{ x: 10, y: 28 }] : item.kind === 'appearance' ? [{ x: 1, y: 8 }, { x: 1, y: 9 }, { x: 1, y: 11 }] : item.kind === 'backgrounds' ? [{ x: -0.5, y: -1 }, { x: 29, y: -1 }, { x: 19.5, y: 20.5 }, { x: 59.5, y: 20.5 }, { x: 61, y: 21 }, { x: 99.5, y: 20.5 }, { x: 127.5, y: 19.5 }, { x: 79.75, y: 20.25 }] : [];
      const boxes = item.kind === 'backgrounds' ? [{ x: 19, y: 20, w: 1, h: 1 }, { x: 59, y: 20, w: 1, h: 1 }, { x: 99, y: 20, w: 1, h: 1 }, { x: 127, y: 19, w: 1, h: 1 }] : [];
      const rendered = await raster(points, boxes); assert.ok(rendered.changed > 10, item.kind + ': rendered content');
      if (item.kind === 'widths') { assert.ok(rendered.samples[0].delta > 10, 'Taper interior renders'); assert.ok(rendered.samples[1].delta <= 3, 'Thin end excludes the maximum width'); }
      if (item.kind === 'arrays') assert.ok(rendered.samples[0].delta > 10, 'Native second column renders');
      if (item.kind === 'appearance') { assert.ok(rendered.samples[0].delta <= 3, 'Alpha zero is invisible'); assert.ok(rendered.samples[1].delta > 10, 'Opaque line renders'); assert.ok(rendered.samples[2].delta > 10 && rendered.samples[2].delta < 180, 'Named RGB line uses its alpha'); }
      if (item.kind === 'backgrounds') backgroundRasterExpectations(rendered);
      if (item.kind === 'arrays') await arrayProperties(before);
      if (item.kind === 'appearance') await colorProperties(before);
      await app.evaluate((_electron, path) => globalThis.__e2e.savePaths.push(path), saved);
      assert.equal(await page.evaluate(() => window.editor.saveFile(true)), true, item.kind + ': native Save As');
      assert.ok(lstatSync(saved).isFile()); assert.deepEqual(readFileSync(source), original, 'Save As protects supplied source bytes');
      const bytes = readFileSync(saved); assert.ok(bytes.length > 0 && bytes.length < 8 * 1024 * 1024); nativeExpectations(item.kind, bytes.toString('utf8'));
      assert.equal(await page.evaluate(() => window.editor.saveFile(false)), true, item.kind + ': named save');
      assert.ok(lstatSync(saved + '.bak').isFile()); assert.deepEqual(readFileSync(saved + '.bak'), bytes, 'Named save preserves exact prior bytes');
      assert.ok(!readdirSync(workspace).some((name) => name.endsWith('.tmp')), 'Atomic saves leave no temp file');
      assert.equal(await page.evaluate(() => window.editor.doc.dirty), false);
      await page.evaluate(() => { const ed = window.editor; ed.newDrawingNow(); if (ed.doc.filePath !== null || ed.doc.entities.length) throw new Error('Fresh state required before reopen'); });
      await openChosen(saved); const after = await inspect(); liveExpectations(item.kind, after);
      approximately(after.signature, before.signature, item.kind + ': native metadata round trip'); approximately(after.bounds, before.bounds, item.kind + ': bounds round trip');
      assert.ok(!after.entities.some((entity) => before.entities.some((original) => original.id === entity.id)), 'Reopen must parse fresh entities');
      if (item.kind === 'backgrounds') backgroundRasterExpectations(await raster(points, boxes));
      check(true, 'CAD fidelity ' + item.kind + ': native metadata, rendering, bounds, save/backup/reopen' + (item.kind === 'arrays' ? ', properties undo/redo' : item.kind === 'appearance' ? ', RGB-to-ACI properties undo/redo' : ''));
    }
    const messages = await app.evaluate(() => globalThis.__e2e.messages.splice(0));
    assert.ok(messages.every((message) => message === 'open:Open Drawing' || message === 'save:Save Drawing As' || message === 'fetch:https://api.github.com/repos/habit04/share/releases/latest'), 'CAD fidelity has no unexpected native dialog/network event');
    assert.equal(messages.filter((message) => message === 'open:Open Drawing').length, 10);
    assert.equal(messages.filter((message) => message === 'save:Save Drawing As').length, 5);
    succeeded = true;
  };
  try {
    await Promise.race([exercise(), new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('CAD fidelity section exceeded two minutes')); }, 120_000); })]);
  } finally {
    clearTimeout(timer);
    // A timed-out IPC may still be running: the outer harness owns process termination.
    // Do not race it by deleting its files or swapping its active document here.
    if (!timedOut) {
      const restored = await page.evaluate((succeeded) => {
        const w = /** @type {any} */ (window), ed = w.editor, saved = w.__cadFidelitySaved;
        if (!saved) throw new Error('CAD fidelity restore state is missing');
        if (succeeded) for (let i = ed.sessions.count - 1; i >= 0; i -= 1) if (!saved.ids.includes(ed.sessions.all[i].id)) { if (ed.sessions.all[i].dirty) throw new Error('A fidelity case must be clean before its tab closes'); ed.sessions.close(i); }
        const index = ed.sessions.indexOfId(saved.id); if (index < 0) throw new Error('Original desktop session disappeared'); ed.switchSession(index);
        ed.settings = saved.settings; ed.persistSettings(); ed.viewport.settings = saved.viewportSettings; ed.viewport.underlay = saved.underlay;
        const palette = document.querySelector('#properties'); if (palette) palette.classList.toggle('hidden', !saved.paletteVisible);
        ed.notify('file'); ed.notify('selection'); ed.render();
        const history = ed.doc.history(), sameHistory = ['undo', 'redo'].every((kind) => history[kind].length === saved.history[kind].length && history[kind].every((state, i) => state === saved.history[kind][i]));
        const sameView = ed.viewport.center.x === saved.view.center.x && ed.viewport.center.y === saved.view.center.y && ed.viewport.scale === saved.view.scale;
        const samePalette = !palette || !palette.classList.contains('hidden') === saved.paletteVisible;
        const result = ed.doc.snapshot === saved.snapshot && ed.doc.filePath === saved.path && ed.doc.dirty === saved.dirty && sameHistory && sameView && samePalette && (!succeeded || ed.sessions.count === saved.ids.length);
        delete w.__cadFidelitySaved; return result;
      }, succeeded);
      assert.equal(restored, true, 'Original session, snapshot, path, dirty flag, history and tab count restored');
      if (succeeded) check(true, 'CAD fidelity restored original clean case sessions, view and palette');
      const checked = realpathSync.native(workspace); assert.equal(dirname(checked), parent); assert.ok(basename(checked).startsWith('cad-fidelity-'));
      // A failed case remains available in the harness artifact folder for diagnosis.
      if (succeeded) rmSync(checked, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}
