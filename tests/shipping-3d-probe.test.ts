/** Pure main-process confinement and byte-evidence checks; renderer/native transport is doubled. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, rmdirSync, symlinkSync, copyFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';

const sourceFile = resolve('electron/main/shipping-probe.cjs');
const source = readFileSync(sourceFile, 'utf8'), originalRequire = createRequire(sourceFile);
const roots: string[] = [];
function profile(prefix = 'jcad-shipping-smoke-') {
  const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root;
}
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(root).toMatch(/jcad-(?:shipping-smoke|3d-control)-/);
    rmSync(root, { recursive: true, force: true });
  }
});
function load(root: string) {
  const priorDialog = vi.fn(), dialog = { showSaveDialog: priorDialog };
  const executeJavaScript = vi.fn();
  const module = { exports: {} as { shippingProbePhase(args: string[]): string | null; runShipping3dProbe(ctx: unknown, phase: string, testBuild: boolean): Promise<any> } };
  new Function('require', 'module', source)((name: string) => name === 'electron' ? { app: { getPath: () => root }, dialog } : originalRequire(name), module);
  const ctx = { mainWindow: { isDestroyed: () => false, webContents: { executeJavaScript } } };
  return { phases: module.exports.shippingProbePhase, run: (phase = '3d', testBuild = false) => module.exports.runShipping3dProbe(ctx, phase, testBuild), executeJavaScript, dialog, priorDialog };
}
function fixture(root: string) {
  const file = join(root, 'shipping-startup.dxf');
  writeFileSync(file, 'bounded private authored DXF'); return file;
}

/** Executes the actual fixed renderer function with UI/storage transport doubled, never WebGL. */
function settingsRenderer(defaultOn = true, keyed = true) {
  const module = { exports: {} };
  const renderer = new Function('require', 'module', `${source}\nreturn shipping3dRenderer;`)(
    (name: string) => name === 'electron' ? {} : originalRequire(name), module,
  ) as (phase: string, fixture: string, output: string) => Promise<any>;
  const filePath = 'private/shipping-startup.dxf';
  const stored = new Map([['jcad-origin-migrated', '1']]);
  const controller = { active: false, viewport: null, kernelStarted: false };
  const ed = {
    doc: { filePath, entities: [{}], dirty: false },
    settings: { experimental3d: defaultOn, importForeign3d: false },
    commands: new Map(['BOX', '3DMODE', '3DVIEW', 'UNION'].map(name => [name, {}])),
    viewport: { canvas: { style: { visibility: 'visible' } } },
    runCommand: vi.fn(async (command: string) => { opened = command; }),
  };
  const w = { editor: ed, jcad: { appInfo: async () => ({ version: '0.5.1', packaged: true }) }, jcad3d: defaultOn ? controller : undefined };
  let opened = '', canvases: unknown[] = [];
  const checkbox = { checked: defaultOn, click: () => { checkbox.checked = !checkbox.checked; } };
  const foreignCheckbox = { checked: false };
  const label = { textContent: '3D tools', querySelector: () => checkbox };
  const foreignLabel = { textContent: 'Experimental foreign 3D import' };
  const accept = { click: () => {
    ed.settings.experimental3d = checkbox.checked;
    stored.set('jcad.settings.v2', JSON.stringify(ed.settings));
    opened = '';
  } };
  const options = {
    querySelectorAll: (selector: string) => selector === 'label.dlg-check[data-setting="experimental3d"]' ? (keyed ? [label] : []) : (keyed ? [label, foreignLabel] : [label]),
    querySelector: (selector: string) => selector === '.modal-footer button.primary' ? accept : selector === 'label.dlg-check[data-setting="importForeign3d"] input[type="checkbox"]' ? foreignCheckbox : null,
  };
  const closeModal = { click: () => { opened = ''; } };
  const about = { querySelector: () => ({ textContent: 'JCad renderer: Canvas 2D' }), closest: () => ({ querySelector: () => closeModal }) };
  const report = { textContent: 'JCad renderer: Canvas 2D', closest: () => ({ querySelector: () => closeModal }) };
  vi.stubGlobal('window', w);
  vi.stubGlobal('document', {
    querySelector: (selector: string) => selector === 'section[aria-label="GPU diagnostics"]' && opened === 'ABOUT' ? about
      : selector === '.report-preview' && opened === 'REPORTBUG' ? report : selector === '.modal' && opened === 'OPTIONS' ? options : null,
    querySelectorAll: () => canvases,
  });
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null });
  vi.stubGlobal('location', { href: 'jcad://app/index.html' });
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('crypto', { subtle: {} });
  return { run: (phase: string) => renderer(phase, filePath, 'private/shipping-3d-output.dxf'), ed, w, controller, checkbox, foreignCheckbox, stored,
    setCanvases: (value: unknown[]) => { canvases = value; } };
}

describe('fixed default-on/opt-out renderer settings with UI transport doubled', () => {
  it('uses the exact setting key among two 3D labels and persists off without activating resources', async () => {
    const f = settingsRenderer();
    expect(await f.run('3d-default')).toMatchObject({ phase: '3d-default', toolsAvailable: true, controllerInstalled: true, no3dCanvas: true, kernelUnstarted: true, foreignImportDisabled: true, optionInitiallyChecked: true, disabledPersisted: true, controllerStillInactive: true, beforeRenderer: 'Canvas 2D' });
    expect(JSON.parse(f.stored.get('jcad.settings.v2')!)).toEqual({ experimental3d: false, importForeign3d: false });
    expect(f.w.jcad3d).toBe(f.controller);
    expect(f.controller).toEqual({ active: false, viewport: null, kernelStarted: false });
    expect(f.ed.doc.dirty).toBe(false);
  });
  it.each(['active', 'kernel', 'canvas', 'foreign', 'command'])('rejects %s default evidence before storing an opt-out', async damage => {
    const f = settingsRenderer();
    if (damage === 'active') f.controller.active = true;
    if (damage === 'kernel') f.controller.kernelStarted = true;
    if (damage === 'canvas') f.setCanvases([{}]);
    if (damage === 'foreign') f.ed.settings.importForeign3d = true;
    if (damage === 'command') f.ed.commands.delete('BOX');
    await expect(f.run('3d-default')).rejects.toThrow(/Fresh profile|Default 3D tools|Foreign 3D import/);
    expect(f.stored.has('jcad.settings.v2')).toBe(false);
  });
  it('requires the foreign import checkbox itself to be off as well', async () => {
    const f = settingsRenderer(); f.foreignCheckbox.checked = true;
    await expect(f.run('3d-default')).rejects.toThrow(/Foreign 3D import option must be unchecked/);
    expect(f.stored.has('jcad.settings.v2')).toBe(false);
  });
  it('keeps the old opt-in path working for a historical unkeyed English checkbox', async () => {
    const f = settingsRenderer(false, false);
    expect(await f.run('3d-enable')).toMatchObject({ phase: '3d-enable', optionPersisted: true, restartRequired: true, beforeRenderer: 'Canvas 2D' });
    expect(JSON.parse(f.stored.get('jcad.settings.v2')!).experimental3d).toBe(true);
    expect(f.w.jcad3d).toBeUndefined();
  });
  it('requires the explicit opt-out to take effect on a real restart before enabling again', async () => {
    const f = settingsRenderer(); await f.run('3d-default');
    await expect(f.run('3d-enable')).rejects.toThrow(/Restarted profile must begin/);
    expect(f.ed.settings.experimental3d).toBe(false);
  });
});
describe('fixed shipping 3D phases and profile confinement', () => {
  it('admits only the fixed phase names and rejects duplicate or supplied JavaScript phases', () => {
    const f = load(profile());
    expect(f.phases([])).toBeNull();
    for (const phase of ['first', 'second', 'dwg', '3d-default', '3d-enable', '3d']) expect(f.phases([`--probe-startup=${phase}`])).toBe(phase);
    for (const args of [['--probe-startup=eval(1)'], ['--probe-startup=3d;process.exit()'], ['--probe-startup=3d\n'], ['--probe-startup=3d', '--probe-startup=3d-enable']]) expect(() => f.phases(args)).toThrow(/Invalid startup probe phase/);
  });
  it('refuses a normal profile and a test ASAR before executing renderer code or writing destinations', async () => {
    const normal = profile('jcad-3d-control-'), f = load(normal); fixture(normal);
    await expect(f.run()).rejects.toThrow(/temporary smoke profile/);
    expect(f.executeJavaScript).not.toHaveBeenCalled();
    const root = profile(), shipping = load(root); fixture(root);
    await expect(shipping.run('3d', true)).rejects.toThrow(/fixed shipping phase/);
    await expect(shipping.run('3d-not-fixed')).rejects.toThrow(/fixed shipping phase/);
    expect(shipping.executeJavaScript).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'shipping-3d-refusal.dwg'))).toBe(false);
  });
  it.each(['3d-default', '3d-enable'])('keeps the fixed %s settings phase confined and writes no drawing destinations', async phase => {
    const root = profile(), f = load(root), input = fixture(root), before = readFileSync(input);
    f.executeJavaScript.mockResolvedValue({ phase, version: '0.5.1', packaged: true });
    expect(await f.run(phase)).toMatchObject({ phase, testBuild: false });
    expect(f.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(f.executeJavaScript.mock.calls[0]![0]).toContain(JSON.stringify(phase));
    expect(readFileSync(input)).toEqual(before);
    expect(existsSync(join(root, 'shipping-3d-output.dxf'))).toBe(false);
    expect(existsSync(join(root, 'shipping-3d-refusal.dwg'))).toBe(false);
    expect(f.dialog.showSaveDialog).toBe(f.priorDialog);
    await expect(f.run(phase, true)).rejects.toThrow(/fixed shipping phase/);
    const normal = profile('jcad-3d-control-'), outside = load(normal); fixture(normal);
    await expect(outside.run(phase)).rejects.toThrow(/temporary smoke profile/);
    expect(outside.executeJavaScript).not.toHaveBeenCalled();
  });
  it.each([0, 4097])('refuses a %i-byte fixture before renderer execution', async size => {
    const root = profile(), f = load(root); writeFileSync(join(root, 'shipping-startup.dxf'), Buffer.alloc(size));
    await expect(f.run()).rejects.toThrow(/bounded regular authored DXF/);
    expect(f.executeJavaScript).not.toHaveBeenCalled();
  });
  it('refuses linked fixture input without changing the linked source', async () => {
    const root = profile(), outside = profile('jcad-3d-control-'), external = fixture(outside), before = readFileSync(external);
    // Windows junctions are real links and require no OS file-symlink privilege.
    symlinkSync(process.platform === 'win32' ? outside : external, join(root, 'shipping-startup.dxf'), process.platform === 'win32' ? 'junction' : 'file');
    expect(lstatSync(join(root, 'shipping-startup.dxf')).isSymbolicLink()).toBe(true);
    const f = load(root); await expect(f.run()).rejects.toThrow(/refuses a linked fixture/);
    expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(readFileSync(external)).toEqual(before);
  });
  it.each(['shipping-3d-output.dxf', 'shipping-3d-output.dxf.bak', 'shipping-3d-refusal.dwg', 'shipping-3d-refusal.dwg.bak'])('refuses pre-existing %s without overwrite', async name => {
    const root = profile(), f = load(root); fixture(root);
    const file = join(root, name), previous = Buffer.from('previous private destination'); writeFileSync(file, previous);
    await expect(f.run()).rejects.toThrow(/pre-existing destination/);
    expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(readFileSync(file)).toEqual(previous);
  });
  it('refuses even a dangling linked output before renderer execution', async () => {
    const root = profile(), outside = profile('jcad-3d-control-'), absent = join(outside, 'missing.dxf'); fixture(root);
    if (process.platform === 'win32') mkdirSync(absent);
    symlinkSync(absent, join(root, 'shipping-3d-output.dxf'), process.platform === 'win32' ? 'junction' : 'file');
    if (process.platform === 'win32') { expect(dirname(resolve(absent))).toBe(resolve(outside)); rmdirSync(absent); }
    expect(lstatSync(join(root, 'shipping-3d-output.dxf')).isSymbolicLink()).toBe(true);
    const f = load(root); await expect(f.run()).rejects.toThrow(/pre-existing destination/);
    expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(existsSync(absent)).toBe(false);
  });
  it('restores the native picker when the fixed renderer phase fails', async () => {
    const root = profile(), f = load(root), input = fixture(root), before = readFileSync(input);
    f.executeJavaScript.mockRejectedValue(new Error('renderer refused'));
    await expect(f.run()).rejects.toThrow('renderer refused');
    expect(f.dialog.showSaveDialog).toBe(f.priorDialog); expect(readFileSync(input)).toEqual(before);
  });
});

describe('3D first/second-save byte evidence with renderer transport doubled', () => {
  function transport(root: string, damage = '') {
    const f = load(root), input = fixture(root), output = join(root, 'shipping-3d-output.dxf');
    f.executeJavaScript.mockImplementationOnce(async () => {
      const options = { title: 'Save Drawing As', filters: [{ extensions: ['dxf', 'dwg'] }] };
      expect(await f.dialog.showSaveDialog({}, options)).toEqual({ canceled: false, filePath: output });
      expect(await f.dialog.showSaveDialog({}, options)).toEqual({ canceled: false, filePath: join(root, 'shipping-3d-refusal.dwg') });
      writeFileSync(output, 'first saved fixed JCAD_3D payload');
      if (damage === 'refusal') writeFileSync(join(root, 'shipping-3d-refusal.dwg'), 'changed refusal');
      return { phase: '3d', signature: 'controlled fixed model signature' };
    }).mockImplementationOnce(async () => {
      copyFileSync(output, output + '.bak');
      if (damage !== 'unchanged') writeFileSync(output, 'second saved fixed JCAD_3D payload with 2D edit');
      if (damage === 'backup') writeFileSync(output + '.bak', 'wrong backup');
      if (damage === 'source') writeFileSync(input, 'changed source');
      return { dxfSecondSaveReopened: true, secondSaveEntities: 2 };
    });
    return f;
  }
  it('compares the actual backup to the captured first-save bytes and records changed output hashes', async () => {
    const root = profile(), f = transport(root), result = await f.run();
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    expect(result).toMatchObject({ backupExact: true, sourceUnchanged: true, firstSaveSha256: hash('first saved fixed JCAD_3D payload'), backupSha256: hash('first saved fixed JCAD_3D payload'), outputSha256: hash('second saved fixed JCAD_3D payload with 2D edit') });
    expect(result).not.toHaveProperty('signature');
    expect(f.dialog.showSaveDialog).toBe(f.priorDialog);
  });
  it.each(['backup', 'source', 'unchanged', 'refusal'])('refuses %s evidence even when the renderer transport reports success', async damage => {
    const root = profile(), f = transport(root, damage);
    await expect(f.run()).rejects.toThrow(/3D .*evidence failed|3D second-save backup or original source preservation failed/);
    expect(f.dialog.showSaveDialog).toBe(f.priorDialog);
  });
});
