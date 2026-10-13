/** Fixed production diagnostics must never modify a normal profile, linked source or pre-existing destination. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, copyFileSync, existsSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { METADATA_SMOKE_FIXTURES } from '../scripts/packaged-smoke-policy.mjs';
import { readDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import { translateEntity } from '../src/core/entities';
import { cadCloneBatch, cadTranslation } from '../src/tools/cad-edits';

const sourceFile = resolve('electron/main/shipping-dwg-probe.cjs');
const source = readFileSync(sourceFile, 'utf8');
const originalRequire = createRequire(sourceFile);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(dirname(resolve(root))).toBe(resolve(tmpdir()));
    expect(root).toMatch(/jcad-(?:shipping-smoke|dwg-probe)-/);
    rmSync(root, { recursive: true, force: true });
  }
});
function profile(prefix = 'jcad-shipping-smoke-') {
  const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root;
}
function load(root: string, version = '0.4.8') {
  const dialog = { showSaveDialog: vi.fn() };
  const executeJavaScript = vi.fn();
  const module = { exports: {} as { runShippingDwgProbe(ctx: unknown, testBuild: boolean): Promise<unknown>; renderer: string; pins: Array<{ name: string; file: string; sha256: string; entities: number; fields: number; unicode: boolean; literal: string }> } };
  new Function('require', 'module', '__dirname', 'process', source + '\nmodule.exports.renderer=metadataRenderer;module.exports.pins=metadataPins;')((name: string) => name === 'electron' ? { app: { getPath: () => root, getVersion: () => version }, dialog } : originalRequire(name), module, dirname(sourceFile), { platform: 'win32' });
  return { run: () => module.exports.runShippingDwgProbe({ mainWindow: { isDestroyed: () => false, webContents: { executeJavaScript } } }, false), dialog, executeJavaScript, renderer: module.exports.renderer, pins: module.exports.pins };
}
describe('fixed DWG shipping probe confinement', () => {
  it('requires pinned regular metadata files before renderer execution or destination writes', async () => {
    const root = profile(); writeFileSync(join(root, 'shipping-startup.dxf'), 'fixture');
    const f = load(root, '0.4.9'); await expect(f.run()).rejects.toMatchObject({ code: 'ENOENT' });
    expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(existsSync(join(root, 'shipping-export.dwg'))).toBe(false);
    writeFileSync(join(root, METADATA_SMOKE_FIXTURES[0]!.file), 'wrong fixture');
    await expect(f.run()).rejects.toThrow(/source preimage mismatch/);
    expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(existsSync(join(root, 'shipping-export.dwg'))).toBe(false);
  });
  it('refuses a linked metadata input before touching fixed outputs', async context => {
    const root = profile(), outside = profile('jcad-dwg-probe-'); writeFileSync(join(root, 'shipping-startup.dxf'), 'fixture');
    const file = join(root, METADATA_SMOKE_FIXTURES[0]!.file), target = join(outside, 'input.dwg'); writeFileSync(target, 'external');
    try { symlinkSync(target, file); } catch (error: any) { if (error.code === 'EPERM') { context.skip(); return; } throw error; }
    const f = load(root, '0.4.9'); await expect(f.run()).rejects.toThrow(/bounded regular files/);
    expect(readFileSync(target, 'utf8')).toBe('external'); expect(f.executeJavaScript).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'shipping-export.dwg'))).toBe(false);
  });
  it('refuses an excessive metadata file before reading it or touching fixed outputs', async () => {
    const root = profile(); writeFileSync(join(root, 'shipping-startup.dxf'), 'fixture');
    const file = join(root, METADATA_SMOKE_FIXTURES[0]!.file), handle = openSync(file, 'wx');
    try { ftruncateSync(handle, 8 * 1024 * 1024 + 1); } finally { closeSync(handle); }
    const f = load(root, '0.4.9'); await expect(f.run()).rejects.toThrow(/bounded regular files/);
    expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(existsSync(join(root, 'shipping-export.dwg'))).toBe(false);
  });
  it('keeps main and smoke-driver preimages identical and compiles only the fixed metadata source', () => {
    const f = load(profile());
    expect(f.pins.map(({ name, file, sha256, entities, fields }) => ({ name, file, sha256, entities, fields }))).toEqual(METADATA_SMOKE_FIXTURES);
    expect(() => new Function('window', 'return (' + f.renderer + ');')).not.toThrow();
    const expected = JSON.parse(readFileSync('tests/fixtures/interchange/r2018-unicode-metadata.expected.json', 'utf8'));
    expect(f.pins[2]!.literal).toBe(expected.opaqueStrings[0].value);
  });
  it('accepts verified source fixtures without requiring an inspection transport', async () => {
    const root = profile(); writeFileSync(join(root, 'shipping-startup.dxf'), 'fixture');
    for (const pin of METADATA_SMOKE_FIXTURES) copyFileSync(join('tests/fixtures/interchange', pin.name + '.dwg'), join(root, pin.file));
    const f = load(root, '0.4.9'), stopped = new Error('stop before legacy renderer execution');
    f.executeJavaScript.mockRejectedValue(stopped); await expect(f.run()).rejects.toBe(stopped);
    expect(f.executeJavaScript).toHaveBeenCalledOnce();
  });
  it.each(['literal', 'int64', 'view', 'field-reference'] as const)('refuses actual %s metadata corruption in the fixed renderer before COPY or Save', async damage => {
    // This is a pure diagnostic boundary test, not native CAD or installed-app proof.
    const f = load(profile()), pin = f.pins[2]!;
    const imported = structuredClone(readDxf(readFileSync(join('tests/fixtures/interchange', pin.name + '.dxf'), 'utf8')));
    let state = { ...imported, cadGraph: { ...imported.cadGraph!, sourceFormat: 'DWG' as const } };
    if (damage === 'view') state = { ...state, header: { ...state.header!, views: state.header!.views.map(view => view.name.startsWith('FUTURE_3D') ? { ...view, camera: { ...view.camera!, direction: { x: 0, y: 0, z: 1 } } } : view) } };
    else {
      const payload = state.cadGraph!.nodes.find(node => node.type === 'XRECORD' && node.groups.some(([code, value]) => code === 1 && value.includes('JSON')))!;
      if (damage === 'literal' || damage === 'int64') {
        const code = damage === 'literal' ? 1 : 160;
        const groups = payload.groups.map(([c, value]) => [c, c === code ? damage === 'literal' ? value.replace('F0A \\U+0041', 'F0A A') : '9007199254740992' : value] as const);
        state.cadGraph = { ...state.cadGraph!, nodes: state.cadGraph!.nodes.map(node => node === payload ? { ...node, groups } : node) };
      } else {
        const field = state.cadGraph!.nodes.find(node => node.type === 'FIELD' && node.groups.some(([code, value]) => code === 1 && value === 'AcObjProp'))!;
        state.cadGraph = { ...state.cadGraph!, nodes: state.cadGraph!.nodes.map(node => node === field ? { ...node, references: node.references!.map(ref => node.groups[ref.groupIndex]![0] === 331 ? { ...ref, target: undefined } : ref) } : node) };
      }
    }
    const runCommand = vi.fn(), saveFile = vi.fn(), oldReport = vi.fn(), oldConfirm = vi.fn(), oldError = vi.fn();
    const ed = { doc: { snapshot: state, entities: state.entities }, hooks: { importReport: oldReport, saveError: oldError }, ui: { confirm: oldConfirm }, cancel: vi.fn(), sessions: { add: vi.fn() }, openFile: async () => true, runCommand, saveFile };
    const fixed = new Function('window', 'return (' + f.renderer + ');')({ editor: ed });
    await expect(fixed({ ...pin, stage: 'prepare', input: 'fixed-source', output: 'fixed-copy', outputName: 'fixed-copy.dwg' })).rejects.toThrow();
    expect(runCommand).not.toHaveBeenCalled(); expect(saveFile).not.toHaveBeenCalled();
    expect(ed.hooks.importReport).toBe(oldReport); expect(ed.ui.confirm).toBe(oldConfirm); expect(ed.hooks.saveError).toBe(oldError);
  });
  it('passes the same uncorrupted metadata boundary and reaches the actual COPY command', async () => {
    const f = load(profile()), pin = f.pins[2]!, imported = structuredClone(readDxf(readFileSync(join('tests/fixtures/interchange', pin.name + '.dxf'), 'utf8')));
    const state = { ...imported, cadGraph: { ...imported.cadGraph!, sourceFormat: 'DWG' as const } };
    const stop = new Error('valid metadata reached COPY'), runCommand = vi.fn(() => { throw stop; });
    const ed = { doc: { snapshot: state, entities: state.entities }, hooks: { importReport: vi.fn(), saveError: vi.fn() }, ui: { confirm: vi.fn() }, cancel: vi.fn(), sessions: { add: vi.fn() }, openFile: async () => true, runCommand };
    const fixed = new Function('window', 'return (' + f.renderer + ');')({ editor: ed });
    await expect(fixed({ ...pin, stage: 'prepare', input: 'fixed-source', output: 'fixed-copy', outputName: 'fixed-copy.dwg' })).rejects.toBe(stop);
    expect(runCommand).toHaveBeenCalledWith('COPY');
  });
  it.each(['scale', 'visibility'] as const)('refuses an ineffective %s annotation edit before COPY or Save', async damaged => {
    // Pure fixed-renderer boundary: this does not claim native/installed runtime validation.
    const f = load(profile()), pin = f.pins[0]!, imported = structuredClone(readDxf(readFileSync(join('tests/fixtures/interchange', pin.name + '.dxf'), 'utf8')));
    const state = { ...imported, cadGraph: { ...imported.cadGraph!, sourceFormat: 'DWG' as const } };
    const runCommand = vi.fn((command: string) => {
      if (command === 'CANNOSCALE 1:2' && damaged !== 'scale') state.header = { ...state.header!, cannoscale: '1:2' };
      if (command === 'ANNOALLVISIBLE 0' && damaged !== 'visibility') state.header = { ...state.header!, annoAllVisible: false };
    }), saveFile = vi.fn(), oldReport = vi.fn(), oldConfirm = vi.fn(), oldError = vi.fn();
    const ed = { doc: { snapshot: state, entities: state.entities }, hooks: { importReport: oldReport, saveError: oldError }, ui: { confirm: oldConfirm }, cancel: vi.fn(), sessions: { add: vi.fn() }, openFile: async () => true, runCommand, saveFile };
    const fixed = new Function('window', 'return (' + f.renderer + ');')({ editor: ed });
    await expect(fixed({ ...pin, stage: 'prepare', input: 'fixed-source', output: 'fixed-copy', outputName: 'fixed-copy.dwg' })).rejects.toThrow(/annotation commands did not edit/);
    expect(runCommand).not.toHaveBeenCalledWith('COPY'); expect(saveFile).not.toHaveBeenCalled();
    expect(ed.hooks.importReport).toBe(oldReport); expect(ed.ui.confirm).toBe(oldConfirm); expect(ed.hooks.saveError).toBe(oldError);
  });
  it('checks edited annotation settings and normalizes omitted true before reaching COPY', async () => {
    const f = load(profile()), pin = f.pins[0]!, imported = structuredClone(readDxf(readFileSync(join('tests/fixtures/interchange', pin.name + '.dxf'), 'utf8')));
    const doc = new Drawing({ ...imported, header: { ...imported.header!, annoAllVisible: undefined }, cadGraph: { ...imported.cadGraph!, sourceFormat: 'DWG' as const } });
    const stop = new Error('edited annotation settings reached COPY'), runCommand = vi.fn((command: string) => {
      if (command === 'CANNOSCALE 1:2') doc.setHeader({ cannoscale: '1:2' });
      else if (command === 'ANNOALLVISIBLE 0') doc.setHeader({ annoAllVisible: false });
      else if (command === 'COPY') throw stop;
    });
    const ed = { doc, hooks: { importReport: vi.fn(), saveError: vi.fn() }, ui: { confirm: vi.fn() }, cancel: vi.fn(), sessions: { add: vi.fn() }, openFile: async () => true, runCommand };
    const fixed = new Function('window', 'return (' + f.renderer + ');')({ editor: ed });
    await expect(fixed({ ...pin, stage: 'prepare', input: 'fixed-source', output: 'fixed-copy', outputName: 'fixed-copy.dwg' })).rejects.toBe(stop);
    expect(runCommand.mock.calls.map(call => call[0])).toEqual(['CANNOSCALE 1:2', 'ANNOALLVISIBLE 0', 'COPY']);
  });
  it.each(['accepted', 'wrong-message', 'no-consent', 'wrong-report'] as const)('checks %s metadata Save consent through the full fixed renderer', async mode => {
    // Actual core graph edits with simulated file transport; this is not native/app proof.
    const f = load(profile()), pin = f.pins[2]!;
    const imported = structuredClone(readDxf(readFileSync(join('tests/fixtures/interchange', pin.name + '.dxf'), 'utf8')));
    const doc = new Drawing({ ...imported, cadGraph: { ...imported.cadGraph!, sourceFormat: 'DWG' as const } });
    const output = 'fixed-copy.dwg', oldReport = vi.fn(), oldConfirm = vi.fn(async (_title: string, _message: string) => false), oldError = vi.fn();
    const report = { format: 'DWG', sourcePath: output, counts: { LAYOUT: { unsupported: 1, ...(mode === 'wrong-report' ? { dropped: 1 } : {}) } }, items: [], omitted: 0, notes: [] };
    const warning = output + ' contains properties JCad cannot read (see the import report). Saving the current drawing cannot restore them and may remove them from the original file. Use Save As to keep the original. Save over it anyway?\n\nYes saves over it; No opens Save As.';
    const saveFile = vi.fn(async (saveAs: boolean) => {
      if (!saveAs && mode !== 'no-consent') await ed.ui.confirm('Save over the original file?', mode === 'wrong-message' ? warning.replace(output, 'other.dwg') : warning);
      doc.filePath = output; doc.dirty = false; return true;
    });
    const ed = {
      doc, hooks: { importReport: oldReport, saveError: oldError }, ui: { confirm: oldConfirm }, cancel: vi.fn(),
      sessions: { add: vi.fn(), activeId: 'fixed-session' }, history: [] as string[], selection: new Set<string>(),
      openFile: vi.fn(async (path?: string) => {
        if (path) doc.load({ ...structuredClone(doc.snapshot), meta: { ...doc.snapshot.meta, importReport: report } }, path);
        return true;
      }), saveFile, submitInput: vi.fn(),
      runCommand: vi.fn((command: string) => {
        if (command === 'COPY') {
          const entities = doc.entities, delta = { x: 30, y: 0 };
          const copies = entities.map((entity, index) => ({ ...translateEntity(entity, delta), id: 'fixed-copy-' + index }));
          doc.addEntities(copies, false, { cloneBatches: [cadCloneBatch(entities, copies, cadTranslation(delta))] });
        } else if (command === 'ERASE') {
          try { doc.removeEntities(ed.selection); } catch (error) { ed.history.push('Edit canceled: ' + (error as Error).message); }
        }
      }),
    };
    const fixed = new Function('window', 'return (' + f.renderer + ');')({ editor: ed });
    const config = { ...pin, input: 'fixed-source', output, outputName: output };
    const prepared = await fixed({ ...config, stage: 'prepare' });
    expect(prepared.atomicDeleteRefused).toBe(true);
    const saving = fixed({ ...config, stage: 'save', signature: prepared.signature });
    if (mode === 'accepted') {
      await expect(saving).resolves.toMatchObject({ sourceLossConsent: true, saveAsReopened: true, saveReopened: true });
      expect(ed.openFile).toHaveBeenCalledTimes(3);
    } else {
      await expect(saving).rejects.toThrow(mode === 'wrong-message' ? /unexpected metadata source-consent dialog/ : mode === 'no-consent' ? /required consent missing/ : /unexpected metadata Save import report/);
      expect(ed.openFile).toHaveBeenCalledTimes(2);
    }
    expect(ed.hooks.importReport).toBe(oldReport); expect(ed.ui.confirm).toBe(oldConfirm); expect(ed.hooks.saveError).toBe(oldError);
  });
  it('refuses an ordinary profile before executing renderer code or choosing destinations', async () => {
    const root = profile('jcad-dwg-probe-'); const f = load(root);
    await expect(f.run()).rejects.toThrow(/temporary smoke profile/);
    expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(f.dialog.showSaveDialog).not.toHaveBeenCalled();
  });
  it('refuses a fixture symlink outside its smoke profile', async context => {
    const root = profile(), outside = profile('jcad-dwg-probe-'); const file = join(outside, 'original.dxf'); writeFileSync(file, 'original source');
    try { symlinkSync(file, join(root, 'shipping-startup.dxf')); } catch (error: any) { if (error.code === 'EPERM') { context.skip(); return; } throw error; }
    const f = load(root); await expect(f.run()).rejects.toThrow(/regular file inside/);
    expect(readFileSync(file, 'utf8')).toBe('original source'); expect(f.executeJavaScript).not.toHaveBeenCalled();
  });
  it('uses exclusive creation and never overwrites an existing fixed destination', async () => {
    const root = profile(); writeFileSync(join(root, 'shipping-startup.dxf'), 'fixture'); const target = join(root, 'shipping-export.dwg'); writeFileSync(target, 'existing file');
    const f = load(root), originalDialog = f.dialog.showSaveDialog; await expect(f.run()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(target, 'utf8')).toBe('existing file'); expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(f.dialog.showSaveDialog).toBe(originalDialog);
  });
  it('never overwrites a pre-existing normal Save As destination in the temporary profile', async () => {
    const root = profile(); writeFileSync(join(root, 'shipping-startup.dxf'), 'fixture'); const target = join(root, 'shipping-normal-save.dwg'); writeFileSync(target, 'existing normal save');
    const f = load(root), originalDialog = f.dialog.showSaveDialog; await expect(f.run()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(target, 'utf8')).toBe('existing normal save'); expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(f.dialog.showSaveDialog).toBe(originalDialog);
  });
  it('never overwrites a pre-existing rotated-layout DXF proof destination', async () => {
    const root = profile(); writeFileSync(join(root, 'shipping-startup.dxf'), 'fixture'); const target = join(root, 'shipping-rotated-layout.dxf'); writeFileSync(target, 'existing rotated DXF');
    const f = load(root), originalDialog = f.dialog.showSaveDialog; await expect(f.run()).rejects.toMatchObject({ code: 'EEXIST' });
    expect(readFileSync(target, 'utf8')).toBe('existing rotated DXF'); expect(f.executeJavaScript).not.toHaveBeenCalled(); expect(f.dialog.showSaveDialog).toBe(originalDialog);
  });
  it('emits syntactically valid fixed renderer diagnostics and restores native dialogs after a failure', async () => {
    const root = profile(); writeFileSync(join(root, 'shipping-startup.dxf'), 'fixture');
    const f = load(root), originalDialog = f.dialog.showSaveDialog, stopped = new Error('Stop after compiling the fixed diagnostic');
    f.executeJavaScript.mockImplementation(async (code: string) => {
      // These template-generated diagnostics are shipped as strings, outside TypeScript checking.
      expect(() => new Function('window', code)).not.toThrow();
      throw stopped;
    });
    await expect(f.run()).rejects.toBe(stopped);
    expect(f.executeJavaScript).toHaveBeenCalledOnce(); expect(f.dialog.showSaveDialog).toBe(originalDialog);
  });
});
