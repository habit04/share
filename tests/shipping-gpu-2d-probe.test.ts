/** Pure confinement/byte gates and raster policy; Electron renderer transport is doubled. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync, symlinkSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { GPU2D_COMPARISON_LABELS, GPU2D_STARTUP_DXF, compareShippingGpu2dPair, classifyShippingGpu2dAdapter, preflightShippingGpu2dRecord, validateShippingGpu2dRecord } from '../scripts/shipping-gpu-2d-smoke.mjs';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';

const sourceFile = resolve('electron/main/shipping-probe.cjs');
const source = readFileSync(sourceFile, 'utf8'), originalRequire = createRequire(sourceFile);
const roots: string[] = [];
function profile(prefix = 'jcad-shipping-smoke-') {
  const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(root).toMatch(/jcad-(?:shipping-smoke|gpu-control)-/);
    rmSync(root, { recursive: true, force: true });
  }
});
function load(root: string) {
  const priorDialog = vi.fn(), dialog = { showSaveDialog: priorDialog };
  const executeJavaScript = vi.fn();
  const module = { exports: {} as { shippingProbePhase(args: string[]): string | null; runShippingGpu2dProbe(ctx: unknown, testBuild: boolean): Promise<any>; shippingGpu2dMetadata(state: any): string; shippingGpu2dPendingFontFrame(control: any): any; shippingGpu2dRenderOverlay(editor: import('../src/app/editor').Editor): import('../src/render/viewport').ViewportOverlay } };
  new Function('require', 'module', source)((name: string) => name === 'electron' ? { app: { getPath: () => root }, dialog } : originalRequire(name), module);
  const ctx = { mainWindow: { isDestroyed: () => false, webContents: { executeJavaScript } } };
  return { phases: module.exports.shippingProbePhase, run: (testBuild = false) => module.exports.runShippingGpu2dProbe(ctx, testBuild), executeJavaScript, dialog, priorDialog, metadata: module.exports.shippingGpu2dMetadata, pendingFontFrame: module.exports.shippingGpu2dPendingFontFrame, renderOverlay: module.exports.shippingGpu2dRenderOverlay };
}
function fixture(root: string) { const path = join(root, 'shipping-startup.dxf'); writeFileSync(path, GPU2D_STARTUP_DXF); return path; }
const firstBytes = 'first fixed native DXF: fixed opaque GPU metadata 9007199254740993';
const secondBytes = 'second fixed native DXF: fixed opaque GPU metadata 9007199254740993 plus LINE edit';
const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
function transport(root: string, damage = '') {
  const f = load(root), input = fixture(root), output = join(root, 'shipping-gpu2d-output.dxf');
  f.executeJavaScript.mockImplementationOnce(async code => {
    expect(code).toContain("async function shippingGpu2dRenderer(stage, fixture, output, previous)");
    expect(code).toContain('const shippingGpuAssertLazy3d=(function shippingGpuAssertLazy3d(w, dom)');
    expect(code).toContain(")('first',");
    expect(await f.dialog.showSaveDialog({}, { title: 'Save Drawing As', filters: [{ extensions: ['dxf'] }] })).toEqual({ canceled: false, filePath: output });
    writeFileSync(output, damage === 'marker' ? 'missing metadata' : firstBytes);
    return { phase: 'gpu2d', semantic: 'fixed authored primitive signature', metadata: 'fixed full application span', comparisons: [{ label: 'first-dxf-reopen' }] };
  }).mockImplementationOnce(async code => {
    expect(code).toContain('const shippingGpuAssertLazy3d=(function shippingGpuAssertLazy3d(w, dom)');
    expect(code).toContain(")('second',");
    expect(code).toContain('fixed authored primitive signature');
    copyFileSync(output, output + '.bak');
    if (damage !== 'unchanged') writeFileSync(output, damage === 'empty' ? '' : secondBytes);
    if (damage === 'backup') writeFileSync(output + '.bak', 'wrong backup');
    if (damage === 'source') writeFileSync(input, 'changed source');
    return { secondSaveReopened: true, comparisons: [{ label: 'second-dxf-reopen' }] };
  });
  return f;
}

describe('fixed ordinary GPU2D main transport confinement', () => {
  it('admits the fixed GPU phases and rejects supplied code, suffixes and duplicates', () => {
    const f = load(profile());
    expect(f.phases(['--probe-startup=gpu2d'])).toBe('gpu2d');
    expect(f.phases(['--probe-startup=gpu2d-shx'])).toBe('gpu2d-shx');
    for (const args of [['--probe-startup=gpu2d-shx;eval(1)'], ['--probe-startup=gpu2d-shx\n'], ['--probe-startup=gpu2d-shx', '--probe-startup=gpu2d']]) expect(() => f.phases(args)).toThrow(/Invalid startup probe phase/);
    for (const args of [['--probe-startup=gpu2d;eval(1)'], ['--probe-startup=gpu2d\n'], ['--probe-startup=gpu2d', '--probe-startup=first']]) expect(() => f.phases(args)).toThrow(/Invalid startup probe phase/);
  });
  it('refuses ordinary profile and test build before renderer execution', async () => {
    const normal = profile('jcad-gpu-control-'), f = load(normal); fixture(normal);
    await expect(f.run()).rejects.toThrow(/temporary smoke profile/);
    expect(f.executeJavaScript).not.toHaveBeenCalled();
    const root = profile(), shipping = load(root); fixture(root);
    await expect(shipping.run(true)).rejects.toThrow(/ordinary shipping entry/);
    expect(shipping.executeJavaScript).not.toHaveBeenCalled();
  });
  it.each([0, 4097])('refuses a %i-byte fixture before execution', async size => {
    const root = profile(), f = load(root); writeFileSync(join(root, 'shipping-startup.dxf'), Buffer.alloc(size));
    await expect(f.run()).rejects.toThrow(/bounded regular authored DXF/); expect(f.executeJavaScript).not.toHaveBeenCalled();
  });
  it('refuses linked fixture without changing the linked source', async () => {
    const root = profile(), outside = profile('jcad-gpu-control-'), external = fixture(outside), before = readFileSync(external);
    symlinkSync(process.platform === 'win32' ? outside : external, join(root, 'shipping-startup.dxf'), process.platform === 'win32' ? 'junction' : 'file');
    const f = load(root); await expect(f.run()).rejects.toThrow(/bounded regular authored DXF/);
    expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(readFileSync(external)).toEqual(before);
  });
  it.each(['shipping-gpu2d-output.dxf', 'shipping-gpu2d-output.dxf.bak'])('refuses preexisting %s before overwrite', async name => {
    const root = profile(), f = load(root); fixture(root); const path = join(root, name); writeFileSync(path, 'previous destination');
    await expect(f.run()).rejects.toThrow(/pre-existing destination/); expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(readFileSync(path, 'utf8')).toBe('previous destination');
  });
  it('refuses dangling output links before renderer execution', async () => {
    const root = profile(), outside = profile('jcad-gpu-control-'), absent = join(outside, 'missing.dxf'); fixture(root);
    if (process.platform === 'win32') mkdirSync(absent);
    symlinkSync(absent, join(root, 'shipping-gpu2d-output.dxf'), process.platform === 'win32' ? 'junction' : 'file');
    if (process.platform === 'win32') rmdirSync(absent);
    const f = load(root); await expect(f.run()).rejects.toThrow(/pre-existing destination/);
    expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(existsSync(absent)).toBe(false);
  });
  it('restores native picker when fixed renderer rejects', async () => {
    const root = profile(), f = load(root), input = fixture(root), before = readFileSync(input); f.executeJavaScript.mockRejectedValue(new Error('fixed renderer refused'));
    await expect(f.run()).rejects.toThrow('fixed renderer refused'); expect(f.dialog.showSaveDialog).toBe(f.priorDialog); expect(readFileSync(input)).toEqual(before);
  });
  it('requires the one fixed DXF picker and restores it on unexpected picker', async () => {
    const root = profile(), f = load(root); fixture(root);
    f.executeJavaScript.mockImplementation(async () => { await f.dialog.showSaveDialog({}, { title: 'Save Drawing As', filters: [{ extensions: ['dwg'] }] }); });
    await expect(f.run()).rejects.toThrow(/Unexpected picker/); expect(f.dialog.showSaveDialog).toBe(f.priorDialog);
  });
  it('compares actual first/final/backup/source bytes independently of renderer claims', async () => {
    const root = profile(), f = transport(root), result = await f.run();
    expect(result).toMatchObject({ sourceUnchanged: true, backupExact: true, fixtureSha256: hash(GPU2D_STARTUP_DXF), firstSaveSha256: hash(firstBytes), outputSha256: hash(secondBytes), backupSha256: hash(firstBytes), secondSaveReopened: true });
    expect(result.comparisons.map((pair: { label: string }) => pair.label)).toEqual(['first-dxf-reopen', 'second-dxf-reopen']);
    expect(result).not.toHaveProperty('semantic'); expect(result).not.toHaveProperty('metadata'); expect(f.dialog.showSaveDialog).toBe(f.priorDialog);
  });
  it.each(['marker', 'backup', 'source', 'unchanged', 'empty'])('rejects %s evidence despite renderer success', async damage => {
    const root = profile(), f = transport(root, damage);
    await expect(f.run()).rejects.toThrow(/first-save evidence failed|exact backup or original source preservation failed/); expect(f.dialog.showSaveDialog).toBe(f.priorDialog);
  });
});

function image(edit?: (image: PNG) => void) {
  const png = new PNG({ width: 64, height: 64 });
  for (let at = 0; at < png.data.length; at += 4) { png.data[at] = 33; png.data[at + 1] = 40; png.data[at + 2] = 48; png.data[at + 3] = 255; }
  for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) png.data.fill(255, (y * 64 + x) * 4, (y * 64 + x) * 4 + 4);
  edit?.(png); return 'data:image/png;base64,' + PNG.sync.write(png).toString('base64');
}
function pair(label = 'baseline', renderer = 'gpu', referencePng = image(), actualPng = referencePng) {
  return { label, renderer, referencePng, actualPng, glCalls: renderer === 'gpu' ? { draws: 1, uploads: label === 'warm' ? 0 : 1, clear: 1, uploadBytes: label === 'warm' ? 0 : 168 } : { draws: 0, uploads: 0, clear: 0, uploadBytes: 0 }, documentUnchanged: true, ...(label === 'native-font-before' ? { metricsPendingAtCapture: true } : {}), ...(label === 'native-font-after' ? { metricsLoadedAtCapture: true, firstAutomaticFrame: true } : {}) };
}
function record() {
  const data: Record<string, any> = { phase: 'gpu2d', testBuild: false, version: '0.5.0', packaged: false, beforeRenderer: 'Canvas 2D', activeRenderer: 'WebGL2 drawing base scene + Canvas 2D editing overlays (experimental)', secure: true, url: 'jcad://app/index.html', fixtureSha256: hash(GPU2D_STARTUP_DXF), firstSaveSha256: hash(firstBytes), backupSha256: hash(firstBytes), outputSha256: hash(secondBytes), adapter: { vendor: 'WebKit', renderer: 'WebKit WebGL', version: 'WebGL 2.0', maxTextureSize: 16384, unmaskedVendor: 'Intel', unmaskedRenderer: 'ANGLE Intel UHD' }, comparisons: GPU2D_COMPARISON_LABELS.map(([label, renderer]) => pair(label, renderer)) };
  for (const key of ['defaultCanvas', 'noDefaultGpuAllocation', 'noRendererTestGlobals', 'explicitCommand', 'webgl2', 'visibleInk', 'sourceUnchanged', 'backupExact', 'firstSaveReopened', 'secondSaveReopened', 'metadataPreserved', 'realContextLoss', 'automaticContextRestored', 'fontEpochChanged', 'fontDocumentUnchanged', 'displayInvalidated', 'editUndoRedo']) data[key] = true;
  return data;
}
describe('unchanged strict whole-viewport shipping GPU raster policy', () => {
  it('accepts all fixed small-scene pairs with actual GL evidence and exact complete Canvas controls', () => {
    expect(validateShippingGpu2dRecord(record(), { requireAdapter: 'intel' })).toHaveLength(20);
    expect(compareShippingGpu2dPair(pair())).toMatchObject({ rasterFraction: 0, canvasMissed: 0, gpuMissed: 0, rawPixels: 0 });
  });
  it('rejects raster differences even when neighboring ink still passes coverage', () => {
    const ref = image(), changed = image(png => { for (let x = 17; x < 22; x++) { const at = (20 * 64 + x) * 4; png.data.set([33, 40, 48, 255], at); } });
    expect(() => compareShippingGpu2dPair(pair('baseline', 'gpu', ref, changed))).toThrow(/strict small-scene raster/);
  });
  it('rejects missing isolated foreground below the raster limit', () => {
    const sparse = (remove = false) => image(png => {
      for (let at = 0; at < png.data.length; at += 4) png.data.set([33, 40, 48, 255], at);
      for (let y = 4; y < 64; y += 8) for (let x = 4; x < 64; x += 8) if (!remove || x !== 4 || y !== 4) png.data.set([255, 255, 255, 255], (y * 64 + x) * 4);
    });
    expect(() => compareShippingGpu2dPair(pair('baseline', 'gpu', sparse(), sparse(true)))).toThrow(/bidirectional coverage/);
  });
  it('requires exact Canvas RGBA even when pixelmatch would ignore one alpha change', () => {
    const ref = image(), changed = image(png => { png.data[(12 * 64 + 12) * 4 + 3] = 254; });
    expect(() => compareShippingGpu2dPair(pair('grid', 'canvas', ref, changed))).toThrow(/exact complete Canvas/);
  });
  it.each(['draws', 'uploads', 'clear', 'uploadBytes'])('rejects Canvas fallback with partial GL %s', key => {
    const p = pair('grid', 'canvas'); p.glCalls[key as keyof typeof p.glCalls] = 1;
    expect(() => compareShippingGpu2dPair(p)).toThrow(/no partial GPU/);
  });
  it('rejects no actual GPU draws, warm reuploads and drawing mutation', () => {
    const p = pair(); p.glCalls.draws = 0; expect(() => compareShippingGpu2dPair(p)).toThrow(/real WebGL submission/);
    const warm = pair('warm'); warm.glCalls.uploads = 1; expect(() => compareShippingGpu2dPair(warm)).toThrow(/warm scene buffer reuse/);
    const changed = pair(); changed.documentUnchanged = false; expect(() => compareShippingGpu2dPair(changed)).toThrow(/did not mutate drawing/);
  });
  it('rejects absent ink and over-budget PNG headers before decoded allocation', () => {
    const blank = image(png => { for (let at = 0; at < png.data.length; at += 4) png.data.set([33, 40, 48, 255], at); });
    expect(() => compareShippingGpu2dPair(pair('baseline', 'gpu', blank))).toThrow(/nonempty actual ink/);
    const oversized = Buffer.from(image().split(',')[1]!, 'base64'); oversized.writeUInt32BE(65535, 16);
    expect(() => compareShippingGpu2dPair(pair('baseline', 'gpu', 'data:image/png;base64,' + oversized.toString('base64')))).toThrow(/PNG dimension budget/);
  });
  it('rejects missing/duplicate fixed controls and unsupported supplied labels', () => {
    const missing = record(); missing.comparisons.pop(); expect(() => validateShippingGpu2dRecord(missing)).toThrow(/All fixed production comparisons/);
    const duplicate = record(); duplicate.comparisons[1] = duplicate.comparisons[0]; expect(() => validateShippingGpu2dRecord(duplicate)).toThrow(/unique comparison/);
    expect(() => compareShippingGpu2dPair(pair('supplied-eval-control'))).toThrow(/fixed comparison labels/);
  });
  it('pins original fixture SHA, native epoch/drawing flags, and actual adapter rather than preference', () => {
    const sourceChanged = record(); sourceChanged.fixtureSha256 = hash('different source'); expect(() => validateShippingGpu2dRecord(sourceChanged)).toThrow(/Exact fixed authored source/);
    const fontChanged = record(); fontChanged.fontDocumentUnchanged = false; expect(() => validateShippingGpu2dRecord(fontChanged)).toThrow(/fontDocumentUnchanged/);
    const software = record(); software.adapter.unmaskedVendor = 'Google'; software.adapter.unmaskedRenderer = 'SwiftShader';
    expect(() => validateShippingGpu2dRecord(software, { requireAdapter: 'nvidia' })).toThrow(/Requested preference/);
    expect(() => validateShippingGpu2dRecord(record(), { requireAdapter: 'nvidia' })).toThrow(/Requested preference/);
  });
});

describe('physical identity and complete fixed transport preflight before image decoding', () => {
  it.each(['Software', 'SwiftShader', 'WARP', 'Microsoft Basic Render Driver', 'llvmpipe', 'softpipe', 'lavapipe'])('refuses mixed Intel + %s as physical Intel', software => {
    const data = record(); data.adapter.unmaskedRenderer = 'Intel UHD ' + software;
    expect(classifyShippingGpu2dAdapter(data.adapter)).toBe('software');
    expect(() => preflightShippingGpu2dRecord(data, { requireAdapter: 'intel' })).toThrow(/known software is refused/);
  });
  it('refuses mixed NVIDIA + WARP consistently with report classification', () => {
    const data = record(); data.adapter.unmaskedVendor = 'NVIDIA'; data.adapter.unmaskedRenderer = 'NVIDIA RTX WARP';
    expect(classifyShippingGpu2dAdapter(data.adapter)).toBe('software');
    expect(() => preflightShippingGpu2dRecord(data, { requireAdapter: 'nvidia' })).toThrow(/known software is refused/);
  });
  it('checks known software in actual masked identity before unmasked vendor claims', () => {
    const data = record(); data.adapter.renderer = 'Microsoft Basic Render Driver';
    expect(classifyShippingGpu2dAdapter(data.adapter)).toBe('software');
    expect(() => preflightShippingGpu2dRecord(data, { requireAdapter: 'intel' })).toThrow(/known software is refused/);
  });
  it('retains physical Intel/NVIDIA and conservative unknown classification', () => {
    expect(classifyShippingGpu2dAdapter(record().adapter)).toBe('intel');
    expect(classifyShippingGpu2dAdapter({ unmaskedVendor: 'NVIDIA', unmaskedRenderer: 'ANGLE NVIDIA RTX' })).toBe('nvidia');
    expect(classifyShippingGpu2dAdapter({ unmaskedVendor: 'Unknown', unmaskedRenderer: 'Unknown', vendor: 'WebKit', renderer: 'WebKit WebGL' })).toBe('unknown-or-other');
  });
  it.each(['missing', 'duplicate', 'unknown', 'late-counter-shape', 'late-renderer', 'late-application-shape'])('rejects %s result before any PNG decoder call', fault => {
    const data = record();
    // A malformed first PNG would fail decoding immediately if structural preflight were late.
    data.comparisons[0].referencePng = 'data:image/png;base64,AAAA';
    if (fault === 'missing') data.comparisons.pop();
    if (fault === 'duplicate') data.comparisons[19] = { ...data.comparisons[19], label: 'baseline' };
    if (fault === 'unknown') data.comparisons[19].label = 'supplied-output-name';
    if (fault === 'late-counter-shape') data.comparisons[19].glCalls = null;
    if (fault === 'late-renderer') data.comparisons[19].renderer = 'canvas';
    if (fault === 'late-application-shape') data.packaged = 'false';
    const read = vi.spyOn(PNG.sync, 'read');
    try {
      expect(() => validateShippingGpu2dRecord(data)).toThrow(/production comparisons|unique comparison|fixed comparison evidence names|counter shape|actual renderer|application result shape/);
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });
  it('validates every label before touching any PNG payload and returns canonical fixed order', () => {
    const invalid = record(); invalid.comparisons[19].label = 'unknown-last';
    Object.defineProperty(invalid.comparisons[0], 'referencePng', { get: () => { throw new Error('PNG payload accessed before complete labels'); } });
    expect(() => preflightShippingGpu2dRecord(invalid)).toThrow(/fixed comparison evidence names/);
    const shuffled = record(); shuffled.comparisons.reverse();
    expect(preflightShippingGpu2dRecord(shuffled).map(value => (value as { label: string }).label)).toEqual(GPU2D_COMPARISON_LABELS.map(([label]) => label));
  });
});
describe('fixed owner-bound metadata and synchronous pending-font proof helpers (no renderer execution)', () => {
  const expected = [{ owner: { kind: 'entity', ordinal: 0, type: 'line' }, groups: [[1001, 'SHIPPING_GPU'], [1000, 'fixed opaque GPU metadata 9007199254740993'], [1070, '7']] }];
  it('binds complete XDATA to the original LINE through actual imports with regenerated ids', () => {
    const proof = load(profile()), initial = readDxf(GPU2D_STARTUP_DXF), doc = new Drawing(initial);
    const line = doc.entities[0]!; if (line.type !== 'line') throw new Error('Fixed owner LINE');
    doc.replaceEntities([{ ...line, a: { x: -6, y: 2 }, b: { x: 5, y: 3 } }]);
    const first = readDxf(writeDxf(doc.snapshot)), second = readDxf(writeDxf(first));
    expect(first.entities[0]!.id).not.toBe(initial.entities[0]!.id);
    for (const state of [initial, doc.snapshot, first, second]) expect(JSON.parse(proof.metadata(state))).toEqual(expected);
  });
  it.each(['circle', 'text'])('refuses the identical complete application span reassigned to %s', type => {
    const proof = load(profile()), initial = readDxf(GPU2D_STARTUP_DXF), line = initial.entities[0]!;
    const foreign = type === 'circle'
      ? { id: 'foreign-circle', type: 'circle', layer: '0', color: 3, center: { x: -3, y: -1 }, radius: 1.5 }
      : { id: 'foreign-text', type: 'text', layer: '0', color: 2, position: { x: -4, y: -4 }, text: 'GPU 2D', height: 0.7, rotation: 0, align: 'left' };
    const damaged = { ...initial, entities: [line, foreign], cadGraph: { ...initial.cadGraph!, nodes: initial.cadGraph!.nodes.map(node => node.groups.some(([code, value]) => code === 1001 && value === 'SHIPPING_GPU') ? { ...node, anchor: { kind: 'entity', id: foreign.id }, type: type.toUpperCase() } : node) } };
    expect(() => proof.metadata(damaged)).toThrow(/original LINE owner at ordinal zero/);
    expect(damaged.cadGraph.nodes.flatMap(node => node.groups.filter(([code]) => code >= 1000))).toEqual(expected[0]!.groups);
  });
  it.each(['raw', 'follower', 'wrong-identity'])('refuses %s metadata ownership even if its string payload survives', fault => {
    const proof = load(profile()), initial = readDxf(GPU2D_STARTUP_DXF);
    const damaged = { ...initial, cadGraph: { ...initial.cadGraph!, nodes: initial.cadGraph!.nodes.map(node => node.groups.some(([code, value]) => code === 1001 && value === 'SHIPPING_GPU') ? { ...node, ...(fault === 'wrong-identity' ? { id: 'different-node' } : { anchor: fault === 'raw' ? { kind: 'raw' } : { kind: 'entity', id: initial.entities[0]!.id, part: 'follower' } }) } : node) } };
    expect(() => proof.metadata(damaged)).toThrow(/original LINE owner at ordinal zero/);
  });
  function pendingControl(fault = '') {
    const state = { loaded: false, mode: 'GPU', captures: 0, paints: 0, checks: [] as string[], counts: { draws: 0, uploads: 0, clear: 0, uploadBytes: 0 } };
    const control = {
      assertPending: (phase: string) => { state.checks.push(phase); if (state.loaded) throw new Error('unrun/inconclusive: metrics settled at ' + phase); },
      select: (mode: string) => { state.mode = mode; if (fault === 'select-gpu' && mode === 'GPU') state.loaded = true; },
      paint: () => { state.paints++; if (fault === 'actual-paint' && state.paints === 2) state.loaded = true; },
      capture: () => { state.captures++; if (fault === 'reference-capture' && state.captures === 1 || fault === 'actual-capture' && state.captures === 2) state.loaded = true; return 'fixed bounded frame ' + state.captures; },
      resetCounts: () => { if (fault === 'counter-reset') state.loaded = true; },
      counts: () => { if (fault === 'count-capture') state.loaded = true; return state.counts; },
    };
    return { state, control };
  }
  it('captures pending reference/actual synchronously, keeps GPU requested and snapshots counters before an asynchronous settlement', async () => {
    const proof = load(profile()), { state, control } = pendingControl();
    const settled = Promise.resolve().then(() => { state.loaded = true; });
    const result = proof.pendingFontFrame(control);
    expect(state.loaded).toBe(false); expect(state.mode).toBe('GPU'); expect(state.captures).toBe(2);
    expect(state.checks).toEqual(['before-reference', 'at-reference', 'after-reference', 'after-counter-reset', 'at-actual', 'after-actual', 'after-count-capture']);
    expect(result).toMatchObject({ label: 'native-font-before', metricsPendingAtCapture: true, documentUnchanged: true });
    state.counts.draws = 2; expect(result.glCalls.draws).toBe(0);
    await settled; expect(state.loaded).toBe(true); expect(state.mode).toBe('GPU');
  });
  it.each(['reference-capture', 'select-gpu', 'actual-paint', 'actual-capture', 'counter-reset', 'count-capture'])('refuses prerequisites that settle during %s instead of certifying a pending frame', fault => {
    const proof = load(profile()), { control } = pendingControl(fault);
    expect(() => proof.pendingFontFrame(control)).toThrow(/unrun\/inconclusive/);
  });
  it('refuses already cached metrics without either capture', () => {
    const proof = load(profile()), { state, control } = pendingControl(); state.loaded = true;
    expect(() => proof.pendingFontFrame(control)).toThrow(/unrun\/inconclusive/); expect(state.captures).toBe(0);
  });
  it('refuses an asynchronous registered selector before it can yield a purported pending reference', () => {
    const proof = load(profile()), { state, control } = pendingControl();
    expect(() => proof.pendingFontFrame({ ...control, select: () => Promise.resolve() })).toThrow(/must remain synchronous/);
    expect(state.captures).toBe(0);
  });
  it('requires captured pending/first automatic settled proof before decoding native font images', () => {
    const pending = record(); pending.comparisons.find((value: { label: string }) => value.label === 'native-font-before').metricsPendingAtCapture = false;
    expect(() => preflightShippingGpu2dRecord(pending)).toThrow(/pending prerequisite was captured/);
    const settled = record(); settled.comparisons.find((value: { label: string }) => value.label === 'native-font-after').firstAutomaticFrame = false;
    expect(() => preflightShippingGpu2dRecord(settled)).toThrow(/First automatic settled Canvas frame/);
  });
});
describe('real fixed native fixture import/edit/export/reopen (no Electron or CAD apps)', () => {
  it('retains the complete XDATA span through same-id imported LINE edit and two actual native DXF exports', () => {
    const imported = readDxf(GPU2D_STARTUP_DXF);
    expect(imported.entities).toHaveLength(1); expect(imported.entities[0]).toMatchObject({ type: 'line', a: { x: 10, y: 10 }, b: { x: 20, y: 20 } });
    expect(imported.entities[0]!.cadIdentity).toMatch(/:A2$/);
    expect(imported.cadGraph!.nodes.find(node => node.sourceHandle === 'A2')?.anchor).toMatchObject({ kind: 'entity', id: imported.entities[0]!.id });
    const span = (state: typeof imported) => state.cadGraph!.nodes.flatMap(node => {
      const at = node.groups.findIndex(([code, value]) => code === 1001 && value === 'SHIPPING_GPU'); return at < 0 ? [] : [node.groups.slice(at)];
    });
    const expected = [[[1001, 'SHIPPING_GPU'], [1000, 'fixed opaque GPU metadata 9007199254740993'], [1070, '7']]];
    expect(span(imported)).toEqual(expected);
    const doc = new Drawing(imported), line = doc.entities[0]!;
    expect(line.type).toBe('line'); if (line.type !== 'line') throw new Error('Fixed fixture LINE');
    doc.transactDrawing(state => ({ ...state, entities: [{ ...line, a: { x: -6, y: 2 }, b: { x: 5, y: 3 } }] }));
    const first = writeDxf(doc.snapshot), reopened = readDxf(first);
    expect(reopened.entities[0]).toMatchObject({ type: 'line', a: { x: -6, y: 2 }, b: { x: 5, y: 3 } }); expect(span(reopened)).toEqual(expected);
    const secondDoc = new Drawing(reopened); secondDoc.addEntities([{ id: 'second-line', type: 'line', layer: '0', color: 'ByLayer', a: { x: -6, y: -5 }, b: { x: 6, y: -5 } }]);
    const second = readDxf(writeDxf(secondDoc.snapshot)); expect(second.entities).toHaveLength(2); expect(span(second)).toEqual(expected);
    expect(second.entities[1]).toMatchObject({ type: 'line', a: { x: -6, y: -5 }, b: { x: 6, y: -5 } });
  });
  it('exports the bounded GPU fixture as editable LINE/CIRCLE/ARC/LWPOLYLINE/TEXT with exact authored geometry and appearance', () => {
    const doc = new Drawing(readDxf(GPU2D_STARTUP_DXF));
    const line = doc.entities[0]!; if (line.type !== 'line') throw new Error('Fixed fixture LINE');
    doc.transactDrawing(state => ({ ...state, entities: [
      { ...line, a: { x: -6, y: 2 }, b: { x: 5, y: 3 } },
      { id: 'circle', type: 'circle', layer: '0', color: 3, center: { x: -3, y: -1 }, radius: 1.5 },
      { id: 'arc', type: 'arc', layer: '0', color: 1, center: { x: 1, y: -1 }, radius: 1.5, startAngle: 0, endAngle: Math.PI * 1.5 },
      { id: 'polyline', type: 'polyline', layer: '0', color: 4, points: [{ x: 3, y: -2 }, { x: 5, y: -1 }, { x: 3, y: 0 }], closed: false },
      { id: 'text', type: 'text', layer: '0', color: 2, position: { x: -4, y: -4 }, text: 'GPU 2D', height: 0.7, rotation: 0, align: 'left' },
    ] }));
    const exported = writeDxf(doc.snapshot), back = readDxf(exported);
    for (const kind of ['LINE', 'CIRCLE', 'ARC', 'LWPOLYLINE', 'TEXT']) expect(exported).toContain('\r\n' + kind + '\r\n');
    expect(back.entities).toHaveLength(5);
    expect(back.entities[0]).toMatchObject({ type: 'line', layer: '0', color: 'ByLayer', a: { x: -6, y: 2 }, b: { x: 5, y: 3 } });
    expect(back.entities[1]).toMatchObject({ type: 'circle', layer: '0', color: 3, center: { x: -3, y: -1 }, radius: 1.5 });
    expect(back.entities[2]).toMatchObject({ type: 'arc', layer: '0', color: 1, center: { x: 1, y: -1 }, radius: 1.5, startAngle: 0, endAngle: Math.PI * 1.5 });
    expect(back.entities[3]).toMatchObject({ type: 'polyline', layer: '0', color: 4, points: [{ x: 3, y: -2 }, { x: 5, y: -1 }, { x: 3, y: 0 }], closed: false });
    expect(back.entities[4]).toMatchObject({ type: 'text', layer: '0', color: 2, position: { x: -4, y: -4 }, text: 'GPU 2D', height: 0.7, rotation: 0, align: 'left', widthFactor: 1, oblique: 0 });
  });});

describe('fixed probe uses the real Editor and Viewport overlay seam (no GPU or Electron)', () => {
  it('observes the real render overlay and retains the live LINE preview through its native pointer and cancel path', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
    const { Editor } = await import('../src/app/editor');
    const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
    try {
      const proof = load(profile()), original = ed.viewport.requestRender, ownedBefore = Object.hasOwn(ed.viewport, 'requestRender');
      expect('state' in ed).toBe(false);
      const snapshot = ed.doc.snapshot, revision = ed.doc.revision, overlay = proof.renderOverlay(ed);
      expect(ed.viewport.requestRender).toBe(original); expect(Object.hasOwn(ed.viewport, 'requestRender')).toBe(ownedBefore);
      expect(overlay.selection).toBe(ed.selection); expect(overlay.preview).toEqual([]); expect(overlay.ghost).toEqual([]);
      ed.setHover('real-hover'); expect(proof.renderOverlay(ed)).toBe(overlay); expect(overlay.hover).toBe('real-hover');
      ed.selection.clear(); overlay.cursor = null; overlay.hover = null; overlay.snap = null;
      await ed.runCommand('LINE'); ed.submitInput('0,-5');
      const point = ed.viewport.toScreen({ x: 3, y: -4 });
      ed.onMouseMove({ clientX: point.x, clientY: point.y, buttons: 0, shiftKey: false, ctrlKey: false, altKey: false } as MouseEvent);
      expect(ed.tool).not.toBeNull(); expect(proof.renderOverlay(ed)).toBe(overlay); expect(overlay.preview.length).toBeGreaterThan(0);
      expect(overlay.preview[0]).toMatchObject({ type: 'line', a: { x: 0, y: -5 }, b: { x: 3, y: -4 } });
      ed.cancel(); expect(proof.renderOverlay(ed)).toBe(overlay); expect(overlay.preview).toEqual([]); expect(overlay.ghost).toEqual([]);
      expect(ed.doc.snapshot).toBe(snapshot); expect(ed.doc.revision).toBe(revision);
    } finally { ed.viewport.dispose(); vi.unstubAllGlobals(); }
  });

  it('forwards and restores the actual viewport method and descriptor when render publication fails', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
    const { Editor } = await import('../src/app/editor');
    const ed = new Editor({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement);
    try {
      const proof = load(profile()), marker = new Error('actual viewport publication failed');
      const failed = vi.fn(() => { throw marker; });
      Object.defineProperty(ed.viewport, 'requestRender', { value: failed, configurable: true, writable: true, enumerable: true });
      const descriptor = Object.getOwnPropertyDescriptor(ed.viewport, 'requestRender');
      expect(() => proof.renderOverlay(ed)).toThrow(marker); expect(failed).toHaveBeenCalledOnce();
      expect(Object.getOwnPropertyDescriptor(ed.viewport, 'requestRender')).toEqual(descriptor);
    } finally { ed.viewport.dispose(); vi.unstubAllGlobals(); }
  });
});
