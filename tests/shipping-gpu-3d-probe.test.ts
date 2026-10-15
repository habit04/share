/** Pure and serialized mock transport checks only; these provide no native/GPU accuracy proof. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { PNG } from 'pngjs';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import { GPU3D_STARTUP_DXF, GPU3D_FIXTURE_SHA256, GPU3D_STATE_LABELS, GPU3D_IMAGE_LABELS,
  preflightShippingGpu3dRecord, validateShippingGpu3dRecord, decodeShippingGpu3dPng } from '../scripts/shipping-gpu-3d-smoke.mjs';

const filename = resolve('electron/main/shipping-gpu-3d-probe.cjs'), source = readFileSync(filename, 'utf8'), realRequire = createRequire(filename);
const roots: string[] = [];
function profile(prefix = 'jcad-shipping-smoke-') { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; }
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir())); expect(root).toMatch(/jcad-(?:shipping-smoke|gpu-control)-/);
    rmSync(root, { recursive: true, force: true });
  }
});
function load(root: string) {
  const module = { exports: {} as any }, executeJavaScript = vi.fn();
  new Function('require', 'module', source)((name: string) => name === 'electron' ? { app: { getPath: () => root } } : realRequire(name), module);
  const ctx = { mainWindow: { isDestroyed: () => false, webContents: { executeJavaScript } } };
  return { ...module.exports, executeJavaScript, run: (testBuild = false) => module.exports.runShippingGpu3dProbe(ctx, testBuild) };
}
function fixture(root: string) { const file = join(root, 'shipping-gpu3d-startup.dxf'); writeFileSync(file, GPU3D_STARTUP_DXF); return file; }
function png() {
  const image = new PNG({ width: 8, height: 8 }); image.data.fill(255);
  return 'data:image/png;base64,' + PNG.sync.write(image).toString('base64');
}
function record() {
  const adapter = { vendor: 'WebKit', renderer: 'WebKit WebGL', version: 'WebGL 2.0', maxTextureSize: 16384, unmaskedVendor: 'Intel', unmaskedRenderer: 'ANGLE Intel UHD' };
  const data: any = { phase: 'gpu2d-3d', testBuild: false, version: '0.5.1', packaged: true, url: 'jcad://app/index.html',
    fixtureSha256: GPU3D_FIXTURE_SHA256, events: ['lost', 'restored'], violations: [], canvasInk: 20,
    glCalls: { draws: 1, clear: 1 }, resumedGlCalls: { draws: 1, clear: 1 }, adapter2d: { ...adapter }, adapter3d: { ...adapter }, adapter2dResumed: { ...adapter },
    states: GPU3D_STATE_LABELS.map((label, i) => ({ label, documentUnchanged: true, kernelStarted: false,
      viewUnchanged: true, view: { center: { x: 0, y: 0 }, scale: 30, twist: 0, width: 8, height: 8, dpr: 1, backingWidth: 8, backingHeight: 8 },
      active3d: i >= 2 && i <= 5, canvases3d: i >= 2 && i <= 5 ? 1 : 0,
      canvasVisibility: i >= 2 && i <= 5 ? 'hidden' : 'visible', candidateCount: i === 0 ? 0 : 1,
      owned2dDevices: i === 0 ? 0 : 1, candidateDisplay: i === 0 ? null : i === 1 || i === 6 ? 'block' : 'none' })),
    images: GPU3D_IMAGE_LABELS.map(label => ({ label, png: png(), rawGpuInk: label === 'default-canvas' || label === 'canvas-restored' ? null : 20 })) };
  for (const key of ['secure', 'defaultCanvas', 'noDefaultGpuAllocation', 'default3dToolsReady', 'foreignImportDisabled',
    'noRendererTestGlobals', 'explicitGpuCommand', 'realContextLoss', 'automaticContextRestored', 'same2dDevice',
    'noHiddenExposure', 'kernelUnstarted', 'documentUnchanged', 'metadataPreserved', 'sourceUnchanged', 'noDrawingOutputs', 'same2dView', 'canvasExactRestored']) data[key] = true;
  return data;
}

describe('fixed GPU/3D main transport confinement (mock Electron)', () => {
  it('rejects ordinary profiles, nested profiles and test builds before renderer execution', async () => {
    const normal = profile('jcad-gpu-control-'), f = load(normal); fixture(normal);
    await expect(f.run()).rejects.toThrow(/temporary smoke profile/); expect(f.executeJavaScript).not.toHaveBeenCalled();
    const own = profile(), nested = join(own, 'jcad-shipping-smoke-nested'); mkdirSync(nested); fixture(nested);
    const g = load(nested); await expect(g.run()).rejects.toThrow(/temporary smoke profile/);
    const h = load(own); fixture(own); await expect(h.run(true)).rejects.toThrow(/ordinary shipping entry/); expect(h.executeJavaScript).not.toHaveBeenCalled();
  });
  it.each([0, 4097])('rejects %i-byte fixture before renderer execution', async size => {
    const root = profile(), f = load(root); writeFileSync(join(root, 'shipping-gpu3d-startup.dxf'), Buffer.alloc(size));
    await expect(f.run()).rejects.toThrow(/bounded regular authored DXF/); expect(f.executeJavaScript).not.toHaveBeenCalled();
  });
  it('rejects a linked fixture without reading or changing its external target', async () => {
    const root = profile(), other = profile('jcad-gpu-control-'), external = fixture(other), before = readFileSync(external);
    symlinkSync(process.platform === 'win32' ? other : external, join(root, 'shipping-gpu3d-startup.dxf'), process.platform === 'win32' ? 'junction' : 'file');
    const f = load(root); await expect(f.run()).rejects.toThrow(/bounded regular authored DXF/);
    expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(readFileSync(external)).toEqual(before);
  });
  it('rejects arbitrary bytes and preexisting drawing outputs', async () => {
    const root = profile(), input = fixture(root), f = load(root); writeFileSync(input, GPU3D_STARTUP_DXF.replace('1070\n7', '1070\n8'));
    await expect(f.run()).rejects.toThrow(/other fixture bytes/); expect(f.executeJavaScript).not.toHaveBeenCalled();
    writeFileSync(input, GPU3D_STARTUP_DXF); writeFileSync(join(root, 'unexpected.dxf.bak'), 'retained');
    await expect(f.run()).rejects.toThrow(/drawing outputs/); expect(readFileSync(join(root, 'unexpected.dxf.bak'), 'utf8')).toBe('retained');
  });
  it.each(['nested.dxf', 'nested.dwg', 'nested.dxf.bak'])('refuses nested %s outputs after renderer execution', async name => {
    const root = profile(), f = load(root); fixture(root);
    f.executeJavaScript.mockImplementation(async () => { mkdirSync(join(root, 'nested')); writeFileSync(join(root, 'nested', name), 'unexpected'); return record(); });
    await expect(f.run()).rejects.toThrow(/drawing outputs/);
  });
  it('refuses private profile descendants that are links or exceed the depth bound', async () => {
    const root = profile(), other = profile('jcad-gpu-control-'), f = load(root); fixture(root);
    symlinkSync(other, join(root, 'linked-child'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(f.run()).rejects.toThrow(/links/); expect(f.executeJavaScript).not.toHaveBeenCalled();
    const deep = profile(), g = load(deep); fixture(deep); let next = deep;
    for (let i = 0; i < 32; i++) { next = join(next, 'd'); mkdirSync(next); }
    await expect(g.run()).rejects.toThrow(/bounded/); expect(g.executeJavaScript).not.toHaveBeenCalled();
  });
  it('serializes only fixed reviewed helpers and rejects a changed source even after renderer success', async () => {
    const root = profile(), input = fixture(root), f = load(root);
    f.executeJavaScript.mockImplementation(async (script: string) => {
      expect(script).toContain('async function shippingGpu3dRenderer(fixture)');
      for (const name of ['shippingGpuAssertLazy3d', 'shippingGpu3dStamp', 'shippingGpu3dSameStamp', 'shippingGpu3dAssertMetadata']) expect(script).toContain('const ' + name + '= (function');
      expect(script).toContain(JSON.stringify(input)); return record();
    });
    expect(await f.run()).toMatchObject({ testBuild: false, sourceUnchanged: true, noDrawingOutputs: true, fixtureSha256: GPU3D_FIXTURE_SHA256 });
    f.executeJavaScript.mockImplementation(async () => { writeFileSync(input, 'changed'); return record(); });
    await expect(f.run()).rejects.toThrow(/fixture bytes|fixture changed/);
  });
  it('rechecks byte and no-output confinement when renderer throws', async () => {
    const root = profile(), input = fixture(root), f = load(root); f.executeJavaScript.mockRejectedValue(new Error('renderer refused'));
    await expect(f.run()).rejects.toThrow('renderer refused'); expect(readFileSync(input, 'utf8')).toBe(GPU3D_STARTUP_DXF);
    f.executeJavaScript.mockImplementation(async () => { writeFileSync(join(root, 'unexpected.dwg'), 'no'); throw new Error('renderer refused'); });
    await expect(f.run()).rejects.toThrow(/drawing outputs/);
  });
});

describe('fixed GPU/3D fixture and identity guards (real native DXF parser, no apps)', () => {
  it('pins bytes and owner-bound retained XDATA through native export/reopen', () => {
    const f = load(profile()), initial = readDxf(GPU3D_STARTUP_DXF);
    expect(createHash('sha256').update(GPU3D_STARTUP_DXF).digest('hex')).toBe(GPU3D_FIXTURE_SHA256);
    expect(initial.entities).toHaveLength(1); expect(initial.entities[0]).toMatchObject({ type: 'line', a: { x: -6, y: 0 }, b: { x: 6, y: 0 } });
    f.shippingGpu3dAssertMetadata(initial); f.shippingGpu3dAssertMetadata(readDxf(writeDxf(initial)));
    const changed = { ...initial, cadGraph: { ...initial.cadGraph!, nodes: initial.cadGraph!.nodes.map(node => node.type === 'LINE' ? { ...node, anchor: undefined } : node) } };
    expect(() => f.shippingGpu3dAssertMetadata(changed)).toThrow(/owner mismatch/);
  });
  it('detects document, snapshot, revision, dirty, binding, settings, selection and each history entry mutation', () => {
    const f = load(profile()), snapshot = readDxf(GPU3D_STARTUP_DXF), undo = [{ id: 'old' }], redo: any[] = [];
    const ed: any = { doc: { snapshot, revision: 4, dirty: false, filePath: 'own.dxf', history: () => ({ undo, redo }) }, settings: { x: 1 }, selection: new Set(['a']) };
    const old = f.shippingGpu3dStamp(ed); expect(f.shippingGpu3dSameStamp(ed, old)).toBe(true);
    for (const [key, value] of [['revision', 5], ['dirty', true], ['filePath', 'other.dxf'], ['snapshot', { ...snapshot }]] as const) {
      const prior = ed.doc[key]; ed.doc[key] = value; expect(f.shippingGpu3dSameStamp(ed, old)).toBe(false); ed.doc[key] = prior;
    }
    undo[0] = { id: 'replacement' }; expect(f.shippingGpu3dSameStamp(ed, old)).toBe(false); undo[0] = old.undo[0];
    undo[0]!.id = 'mutated in place'; expect(f.shippingGpu3dSameStamp(ed, old)).toBe(false); undo[0]!.id = 'old';
    redo.push({ id: 'new' }); expect(f.shippingGpu3dSameStamp(ed, old)).toBe(false); redo.pop();
    ed.selection.add('b'); expect(f.shippingGpu3dSameStamp(ed, old)).toBe(false); ed.selection.delete('b');
    const settings = ed.settings; ed.settings = { ...settings }; expect(f.shippingGpu3dSameStamp(ed, old)).toBe(false); ed.settings = settings;
    ed.settings.x = 2; expect(f.shippingGpu3dSameStamp(ed, old)).toBe(false); ed.settings.x = 1;
    ed.doc.snapshot = { ...ed.doc.snapshot, extraRetainedMetadata: { opaque: 'one' } };
    const metadata = f.shippingGpu3dStamp(ed); ed.doc.snapshot.extraRetainedMetadata.opaque = 'two';
    expect(f.shippingGpu3dSameStamp(ed, metadata)).toBe(false); ed.doc.snapshot = snapshot;
    ed.doc = { ...ed.doc }; expect(f.shippingGpu3dSameStamp(ed, old)).toBe(false);
  });
});

describe('GPU/3D bounded transport preflight independent of producer truth flags', () => {
  it('accepts all fixed ordered states and five PNGs with actual adapter evidence shape', () => {
    expect(validateShippingGpu3dRecord(record(), { requireAdapter: 'intel' })).toHaveLength(5);
  });
  it.each(['defaultCanvas', 'noDefaultGpuAllocation', 'default3dToolsReady', 'kernelUnstarted', 'realContextLoss', 'automaticContextRestored', 'same2dDevice', 'noHiddenExposure', 'documentUnchanged', 'metadataPreserved', 'sourceUnchanged', 'noDrawingOutputs', 'same2dView', 'canvasExactRestored'])('rejects absent %s prerequisite', flag => {
    const r = record(); delete r[flag]; expect(() => preflightShippingGpu3dRecord(r)).toThrow();
  });
  it.each(['adapter2d', 'adapter3d', 'adapter2dResumed'])('refuses software masquerading as physical Intel in %s', adapter => {
    const r = record(); r[adapter].unmaskedRenderer = 'ANGLE Intel UHD SwiftShader';
    expect(() => preflightShippingGpu3dRecord(r, { requireAdapter: 'intel' })).toThrow(/physical execution/);
  });
  it('requires the actual resumed adapter identity to match even without a requested vendor', () => {
    const r = record(); r.adapter2dResumed.unmaskedRenderer = 'ANGLE NVIDIA RTX';
    expect(() => preflightShippingGpu3dRecord(r)).toThrow(/Resumed drawing adapter identity/);
  });
  it('rejects changed camera/backing values even when producer preservation flags remain true', () => {
    const camera = record(); camera.states[4].view.center.x = 1;
    expect(() => preflightShippingGpu3dRecord(camera)).toThrow(/exact 2D camera/);
    const backing = record(); backing.states[6].view.backingWidth = 9;
    expect(() => preflightShippingGpu3dRecord(backing)).toThrow(/exact 2D camera/);
  });
  it('independently compares initial and final Canvas PNG bytes despite true exact-restore flags', () => {
    const r = record(), changed = new PNG({ width: 8, height: 8 }); changed.data.fill(255); changed.data[4] = 0;
    r.images.find((image: { label: string }) => image.label === 'canvas-restored').png = 'data:image/png;base64,' + PNG.sync.write(changed).toString('base64');
    expect(() => validateShippingGpu3dRecord(r)).toThrow(/exact RGBA bytes/);
  });
  it.each(['active3d', 'kernelStarted', 'canvases3d', 'candidateDisplay', 'canvasVisibility', 'owned2dDevices', 'documentUnchanged'])('rejects incorrect %s even with all producer flags true', key => {
    const r = record(), state = r.states[5]; state[key] = typeof state[key] === 'boolean' ? !state[key] : typeof state[key] === 'number' ? 2 : 'block';
    expect(() => preflightShippingGpu3dRecord(r)).toThrow();
  });
  it('refuses missing, duplicated or reordered lifecycle states before decoding images', () => {
    for (const mutate of [(r: any) => r.states.pop(), (r: any) => r.states[4] = r.states[3], (r: any) => r.states.reverse()]) {
      const r = record(); mutate(r); r.images[0].png = 'deliberately invalid'; expect(() => preflightShippingGpu3dRecord(r)).toThrow(/states|state:/);
    }
  });
  it('refuses absent context events, hidden exposure, no draws and missing image evidence', () => {
    for (const mutate of [(r: any) => r.events.pop(), (r: any) => r.violations.push('exposed'), (r: any) => r.glCalls.draws = 0, (r: any) => r.images.pop()]) {
      const r = record(); mutate(r); expect(() => preflightShippingGpu3dRecord(r)).toThrow();
    }
  });
  it('rejects stale cumulative draw counters and blank raw GPU ink masked by an overlay', () => {
    const noDraw = record(); noDraw.resumedGlCalls.draws = 0;
    expect(noDraw.glCalls.draws).toBeGreaterThan(0);
    expect(() => preflightShippingGpu3dRecord(noDraw)).toThrow(/Fresh resumed/);
    const noInk = record(); noInk.images.find((image: { label: string }) => image.label === 'gpu-resumed').rawGpuInk = 0;
    expect(() => preflightShippingGpu3dRecord(noInk)).toThrow(/raw GPU ink/);
  });
  it('rejects oversized or invalid PNG transport before decompression', () => {
    expect(() => decodeShippingGpu3dPng('data:image/png;base64,' + 'A'.repeat(8388633))).toThrow(/Bounded/);
    const bytes = Buffer.alloc(32); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes); bytes.writeUInt32BE(4096, 16); bytes.writeUInt32BE(4096, 20);
    expect(() => decodeShippingGpu3dPng('data:image/png;base64,' + bytes.toString('base64'))).toThrow(/dimension budget/);
  });
});

/** Execute the exact serialized main-authored renderer using explicit in-memory doubles. */
async function mockRenderer(fault = '') {
  const root = profile(), input = fixture(root), f = load(root), doc = new Drawing(readDxf(GPU3D_STARTUP_DXF));
  const states: any[] = [], commands: string[] = [], canvases: any[] = [];
  let mutationCallback: ((records: { oldValue: string }[]) => void) | undefined;
  let hasEntered3d = false;
  const pixel = new Uint8ClampedArray(8 * 8 * 4); pixel.fill(255); pixel.fill(0, 0, 4);
  class MockGl {
    VENDOR = 1; RENDERER = 2; VERSION = 3; MAX_TEXTURE_SIZE = 4; RGBA = 5; UNSIGNED_BYTE = 6; NO_ERROR = 0; lost = false;
    drawArrays() {} drawElements() {} clear() {} isContextLost() { return this.lost; } getError() { return 0; }
    getParameter(key: number) {
      const switched = fault === 'switch-resumed-adapter' && hasEntered3d && !controller.active;
      return key === 1 || key === 7 ? switched ? 'NVIDIA' : 'Intel' : key === 2 || key === 8 ? switched ? 'ANGLE NVIDIA RTX' : 'ANGLE Intel UHD' : key === 3 ? 'WebGL 2.0' : 16384;
    }
    readPixels(_x: number, _y: number, _w: number, _h: number, _format: number, _type: number, bytes: Uint8Array) {
      bytes.set(pixel); if (fault === 'no-resumed-gpu-ink' && hasEntered3d && !controller.active) bytes.fill(0);
    }
    getExtension(name: string) {
      if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_VENDOR_WEBGL: 7, UNMASKED_RENDERER_WEBGL: 8 };
      if (name !== 'WEBGL_lose_context' || fault === 'no-loss-extension') return null;
      return { loseContext: () => { this.lost = true; gpu!.dispatch('webglcontextlost'); }, restoreContext: () => {
        this.lost = false; if (fault === 'expose-restored') gpu!.style.display = 'block';
        if (fault === 'transient-restored') { gpu!.style.display = 'block'; gpu!.style.display = 'none'; mutationCallback?.([{ oldValue: 'display: block;' }]); }
        gpu!.dispatch('webglcontextrestored');
      } };
    }
  }
  class MockCanvas {
    width = 8; height = 8; kind: string; style: any = { display: 'none', visibility: '' }; context = new MockGl(); listeners = new Map<string, Set<() => void>>();
    constructor(kind = 'image') { this.kind = kind; }
    matches(selector: string) { return selector === 'canvas[data-gpu-candidate="2d"]' && this.kind === 'gpu'; }
    getContext(kind: string) { return kind === 'webgl2' ? this.context : { putImageData() {}, drawImage() {}, getImageData: () => {
      const data = new Uint8ClampedArray(pixel);
      // Simulated missing LINE leaves plenty of UCS/control ink for the old >=16 test.
      if (fault === 'canvas-ucs-only' && hasEntered3d && mode === 'canvas') data.fill(0, 4, 32 * 4);
      return { data };
    } }; }
    toDataURL() { return png(); }
    addEventListener(name: string, handler: () => void) { const entries = this.listeners.get(name) || new Set(); entries.add(handler); this.listeners.set(name, entries); }
    removeEventListener(name: string, handler: () => void) { this.listeners.get(name)?.delete(handler); }
    dispatch(name: string) { for (const fn of this.listeners.get(name) || []) fn(); }
  }
  const drawing = new MockCanvas('drawing'); drawing.style.display = 'block';
  let gpu: MockCanvas | null = null, three: MockCanvas | null = null, mode = 'canvas';
  const controller: any = { active: false, viewport: null, kernelStarted: false };
  const ed: any = { doc, settings: { experimental3d: true, importForeign3d: false, crosshairSize: 5 }, selection: new Set(),
    commands: new Set(['BOX', '3DMODE', '3DVIEW', 'UNION', 'GPURENDERER']),
    viewport: { canvas: drawing, center: { x: 0, y: 0 }, scale: 1, twist: 0, width: 8, height: 8, dpr: 1, settings: { gridVisible: true }, renderCurrent: () => {
      if (gpu && mode === 'gpu' && !controller.active) {
        gpu.style.display = 'block'; gpu.context.clear();
        if (fault !== 'no-resumed-draw' || !hasEntered3d) gpu.context.drawArrays();
      }
    } }, render() {},
    async runCommand(command: string) {
      commands.push(command);
      if (command === 'GPURENDERER GPU') {
        if (!gpu || (fault === 'second-device' && controller.active)) { gpu = new MockCanvas('gpu'); canvases.push(gpu); gpu.getContext('webgl2'); }
        mode = 'gpu'; if (!controller.active) gpu.style.display = 'block';
        if (fault === 'mutate-document' && controller.active) doc.addEntities([{ id: 'bad', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 1 }, b: { x: 1, y: 1 } }]);
        if (fault === 'mutate-settings-in-place' && controller.active) ed.settings.crosshairSize = 23;
        if (fault === 'camera-changed' && controller.active) ed.viewport.center.x = 1;
        if (fault === 'backing-changed' && controller.active) drawing.width = 9;
      } else if (command === '3DVIEW SWISO') {
        controller.active = true; hasEntered3d = true; three = new MockCanvas('3d'); drawing.style.visibility = 'hidden'; gpu!.style.display = fault === 'expose-3d' ? 'block' : 'none';
        controller.viewport = { canvas: three, device: { gl: three.context }, render() {} };
        if (fault === 'start-kernel') controller.kernelStarted = true;
      } else if (command === '3DMODE') { controller.active = false; controller.viewport = null; three = null; drawing.style.visibility = ''; }
      else if (command === 'GPURENDERER CANVAS') { mode = 'canvas'; gpu!.style.display = 'none'; }
      ed.viewport.renderCurrent(); states.push({ command, active: controller.active });
    } };
  Object.defineProperty(doc, 'filePath', { configurable: true, get: () => input });
  const win: any = { editor: ed, jcad3d: controller, jcad: { appInfo: async () => ({ version: '0.5.1', packaged: true }) } };
  const dom = { querySelector: (selector: string) => selector === 'canvas[data-gpu-candidate="2d"]' ? gpu : selector === 'canvas.viewport3d' ? three : null,
    querySelectorAll: (selector: string) => selector === 'canvas.viewport3d' ? three ? [three] : [] : selector === 'canvas[data-gpu-candidate="2d"]' ? canvases : [],
    createElement: () => new MockCanvas() };
  f.executeJavaScript.mockImplementation((script: string) => new Function('window', 'document', 'HTMLCanvasElement', 'WebGL2RenderingContext', 'MutationObserver', 'getComputedStyle', 'ImageData', 'requestAnimationFrame', 'localStorage', 'location', 'isSecureContext', 'crypto', 'return ' + script)(
    win, dom, MockCanvas, MockGl, class { constructor(callback: typeof mutationCallback) { mutationCallback = callback; } observe() {} disconnect() {} takeRecords() { return []; } }, (canvas: MockCanvas) => ({ visibility: canvas.style.visibility || 'visible' }), class {},
    (callback: () => void) => callback(), { getItem: () => '1' }, { href: 'jcad://app/index.html' }, true, { subtle: {} }));
  return { result: await f.run(), commands, states };
}

describe('exact serialized GPU/3D renderer helper (mock-only canvas/context lifecycle)', () => {
  it('executes the ordinary commands in order and transports each lifecycle state', async () => {
    const { result, commands } = await mockRenderer();
    expect(commands).toEqual(['GPURENDERER GPU', '3DVIEW SWISO', 'GPURENDERER GPU', '3DMODE', 'GPURENDERER CANVAS']);
    expect(validateShippingGpu3dRecord(result, { requireAdapter: 'intel' })).toHaveLength(5);
  });
  it.each(['second-device', 'mutate-document', 'mutate-settings-in-place', 'expose-3d', 'start-kernel', 'no-loss-extension', 'expose-restored', 'transient-restored', 'no-resumed-draw', 'no-resumed-gpu-ink', 'switch-resumed-adapter', 'canvas-ucs-only', 'camera-changed', 'backing-changed'])('rejects simulated %s through the actual serialized helper', async fault => {
    await expect(mockRenderer(fault)).rejects.toThrow(/another 2D device|changed|hide both|kernel|extension|exposed|restored|replaced|fresh drawing submission|raw GPU backing|exactly match/);
  });
});
